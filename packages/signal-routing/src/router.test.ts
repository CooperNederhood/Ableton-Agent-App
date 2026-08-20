import { describe, expect, it } from "vitest";

import type {
  OutputAssignment,
  OutputProducer,
  SignalEnvelope,
} from "./contracts.js";
import { InMemoryConnectionRegistry } from "./registry.js";
import { SignalRouter } from "./router.js";
import {
  SignalRoutingSummaryPublisher,
  type SignalRoutingSummary,
} from "./summaries.js";
import { midiSample } from "./test-fixtures.js";

function producer(
  producerId: string,
  instanceId = `${producerId}-instance`,
  signalKind: "midi" | "audio" = "midi",
): OutputProducer {
  return {
    producerId,
    instanceId,
    displayName: `Producer ${producerId}`,
    signalKind,
    schemaVersion:
      signalKind === "midi" ? "midi-sample/v1" : "audio-reference/v1",
  };
}

function assignment(
  assignmentId: string,
  producerId: string,
  overrides: Partial<OutputAssignment> = {},
): OutputAssignment {
  return {
    assignmentId,
    producerId,
    consumer: { kind: "agent-instance", id: `${assignmentId}-consumer` },
    deliveryMode: "next-prompt",
    enabled: true,
    usageInstruction: "Use the signal.",
    processingPolicyIds: [],
    ...overrides,
  };
}

function envelope(
  connectionId: string,
  sequence: number,
  sampleIndex = sequence,
): SignalEnvelope {
  return {
    protocolVersion: 1,
    connectionId,
    sequence,
    capturedAt: 1_000 + sequence,
    payload: { ...midiSample, sample_index: sampleIndex },
  };
}

describe("InMemoryConnectionRegistry", () => {
  it("tracks K producers and replaces reconnects by stable producer ID", () => {
    let now = 100;
    const registry = new InMemoryConnectionRegistry({
      staleAfterMs: 50,
      now: () => now,
    });
    for (let index = 0; index < 5; index += 1) {
      registry.register(`connection-${index}`, producer(`producer-${index}`));
    }
    expect(registry.list()).toHaveLength(5);

    now = 200;
    expect(registry.markStale()).toHaveLength(5);
    expect(registry.get("connection-0")?.status).toBe("stale");
    expect(registry.heartbeat("connection-0")?.status).toBe("connected");

    registry.register(
      "replacement",
      producer("producer-0", "new-runtime-instance"),
    );
    expect(registry.get("connection-0")?.status).toBe("disconnected");
    expect(registry.getCurrentForProducer("producer-0")?.connectionId).toBe(
      "replacement",
    );
    expect(registry.disconnect("replacement")?.disconnectedAt).toBe(200);
    expect(registry.listCurrent()).toHaveLength(4);
    expect(
      registry
        .listCurrent()
        .some(({ producer: { producerId } }) => producerId === "producer-0"),
    ).toBe(false);
  });

  it("lists only the latest live connection for each producer", () => {
    const registry = new InMemoryConnectionRegistry({ staleAfterMs: 50 });
    registry.register("first", producer("producer", "first-instance"));
    registry.register("replacement", producer("producer", "second-instance"));

    expect(registry.list()).toHaveLength(2);
    expect(registry.listCurrent()).toEqual([
      expect.objectContaining({ connectionId: "replacement" }),
    ]);

    registry.disconnect("replacement");
    expect(registry.listCurrent()).toEqual([]);
  });

  it("publishes only bounded connection summaries", () => {
    const publisher = new SignalRoutingSummaryPublisher();
    const summaries: SignalRoutingSummary[] = [];
    publisher.subscribe((summary) => summaries.push(summary));
    const registry = new InMemoryConnectionRegistry({
      staleAfterMs: 50,
      publisher,
    });
    registry.register("connection", producer("producer"));
    expect(summaries).toEqual([
      {
        kind: "connections",
        total: 1,
        connected: 1,
        stale: 0,
        disconnected: 0,
      },
    ]);
    expect(JSON.stringify(summaries)).not.toContain("payload");
  });
});

describe("SignalRouter", () => {
  it("fans out one producer to multiple enabled assignments and consumers", () => {
    const registry = new InMemoryConnectionRegistry({ staleAfterMs: 1000 });
    registry.register("connection", producer("producer"));
    const router = new SignalRouter({ registry });
    router.upsertAssignment(assignment("one", "producer"));
    router.upsertAssignment(
      assignment("two", "producer", {
        consumer: { kind: "future-consumer", id: "two", shard: 3 },
      }),
    );
    router.upsertAssignment(
      assignment("disabled", "producer", { enabled: false }),
    );

    const result = router.route(envelope("connection", 0));
    expect(result.accepted).toBe(true);
    expect(result.deliveries.map(({ assignmentId }) => assignmentId)).toEqual([
      "one",
      "two",
    ]);
    expect(router.inbox("one")).toHaveLength(1);
    expect(router.inbox("two")[0]?.consumer).toEqual({
      kind: "future-consumer",
      id: "two",
      shard: 3,
    });
    expect(router.inbox("disabled")).toHaveLength(0);
  });

  it("preserves assignments while their producer is missing or disconnected", () => {
    const registry = new InMemoryConnectionRegistry({ staleAfterMs: 1000 });
    const router = new SignalRouter({ registry });
    router.upsertAssignment(assignment("desired", "producer"));

    expect(router.listAssignments()).toHaveLength(1);
    registry.register("connection", producer("producer"));
    registry.disconnect("connection");
    expect(router.route(envelope("connection", 0)).accepted).toBe(false);
    expect(router.listAssignments()).toEqual([
      expect.objectContaining({ assignmentId: "desired", enabled: true }),
    ]);
  });

  it("isolates multiple producers and preserves frame ordering", () => {
    const registry = new InMemoryConnectionRegistry({ staleAfterMs: 1000 });
    registry.register("a", producer("producer-a"));
    registry.register("b", producer("producer-b"));
    const router = new SignalRouter({ registry });
    router.upsertAssignment(assignment("a-inbox", "producer-a"));
    router.upsertAssignment(assignment("b-inbox", "producer-b"));

    router.route(envelope("a", 0));
    router.route(envelope("b", 0));
    router.route(envelope("a", 1));
    expect(router.inbox("a-inbox").map(({ sequence }) => sequence)).toEqual([
      0, 1,
    ]);
    expect(router.inbox("b-inbox").map(({ sequence }) => sequence)).toEqual([
      0,
    ]);
  });

  it("rejects stale connections, sequence replay, and exact duplicates", () => {
    let now = 0;
    const registry = new InMemoryConnectionRegistry({
      staleAfterMs: 10,
      now: () => now,
    });
    registry.register("connection", producer("producer"));
    const router = new SignalRouter({ registry });
    router.upsertAssignment(assignment("inbox", "producer"));
    expect(router.route(envelope("connection", 2)).accepted).toBe(true);

    expect(
      router.route(envelope("connection", 1)).decisions.at(-1),
    ).toMatchObject({
      accepted: false,
      code: "sequence-replay",
    });
    expect(
      router.route(envelope("connection", 3, 2)).decisions.at(-1),
    ).toMatchObject({
      accepted: false,
      code: "exact-duplicate",
    });

    now = 20;
    registry.markStale();
    expect(router.route(envelope("connection", 4)).decisions[0]).toMatchObject({
      accepted: false,
      code: "connection-unavailable",
    });
  });

  it("enforces queue bounds and supports latest-window coalescing", () => {
    const registry = new InMemoryConnectionRegistry({ staleAfterMs: 1000 });
    registry.register("connection", producer("producer"));
    const router = new SignalRouter({ registry, maxInboxSize: 2 });
    router.upsertAssignment(assignment("bounded", "producer"));
    router.upsertAssignment(
      assignment("latest", "producer", {
        processingPolicyIds: ["latest-window"],
      }),
    );

    router.route(envelope("connection", 0));
    router.route(envelope("connection", 1));
    const result = router.route(envelope("connection", 2));
    expect(result.deliveries[0]?.decision).toMatchObject({
      accepted: false,
      code: "queue-bound",
    });
    expect(router.inbox("bounded").map(({ sequence }) => sequence)).toEqual([
      0, 1,
    ]);
    expect(router.inbox("latest").map(({ sequence }) => sequence)).toEqual([2]);
  });

  it("formats deterministic beat-relative MIDI without harmonic guesses", () => {
    const registry = new InMemoryConnectionRegistry({ staleAfterMs: 1000 });
    registry.register("connection", producer("keys"));
    const router = new SignalRouter({ registry });
    router.upsertAssignment(assignment("inbox", "keys"));
    router.route({
      ...envelope("connection", 0),
      payload: {
        ...midiSample,
        notes: [
          { ...midiSample.notes[0], name: "E4", pitch: 64, onset_beats: 1 },
          { ...midiSample.notes[0], name: "C4", pitch: 60, onset_beats: 0 },
        ],
      },
    });
    const content = router.inbox("inbox")[0]?.content ?? "";
    expect(content).toContain(
      "Producer keys [producer=keys, instance=keys-instance]",
    );
    expect(content.indexOf("beat +0: C4")).toBeLessThan(
      content.indexOf("beat +1: E4"),
    );
    expect(content).not.toMatch(/\b(?:key|chord|harmony)\s*:/i);
  });

  it("clearly rejects audio translation while raw PCM fails validation", () => {
    const registry = new InMemoryConnectionRegistry({ staleAfterMs: 1000 });
    registry.register("audio", producer("audio-producer", "audio-1", "audio"));
    const router = new SignalRouter({ registry });
    router.upsertAssignment(assignment("audio-inbox", "audio-producer"));

    const result = router.route({
      protocolVersion: 1,
      connectionId: "audio",
      sequence: 0,
      capturedAt: 1000,
      payload: {
        schema: "audio-reference/v1",
        durationMs: 500,
        features: [{ name: "rms", value: 0.2 }],
      },
    });
    expect(result.deliveries[0]?.decision).toMatchObject({
      accepted: false,
      code: "unsupported-payload",
    });
    expect(result.deliveries[0]?.decision.reason).toContain(
      "raw PCM is never accepted",
    );

    expect(
      router.route({
        protocolVersion: 1,
        connectionId: "audio",
        sequence: 1,
        capturedAt: 1001,
        payload: {
          schema: "audio-reference/v1",
          durationMs: 500,
          pcm: [0, 0.5],
        },
      }).decisions[0],
    ).toMatchObject({ accepted: false, code: "invalid-schema" });
  });
});
