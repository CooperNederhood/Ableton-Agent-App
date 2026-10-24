import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createInMemorySessionContextStore,
  type AppendContextPass,
  type EntityContextRepository,
} from "@ableton-agent/project-state";
import {
  audioObservationSchema,
  type StoredAudioObservation,
} from "@ableton-agent/protocol";
import { createSyntheticNativeListeningFixtureV2 } from "@ableton-agent/protocol/testing";
import { contextOperationResultSchema } from "@ableton-agent/tools";
import { createSessionContextHost } from "./session-context-host.js";
import { buildListeningPublication } from "./listening-publication.js";

const trace = {
  traceId: "00000000-0000-4000-8000-000000000001",
  correlationId: "query",
  causationId: "call",
};
const context = { sessionId: "session-a", agentId: "reader", trace };
const timestamp = "2026-10-12T00:00:00.000Z";
const stores: EntityContextRepository[] = [];

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
});

async function fixture(name = "Known sine", supplied?: StoredAudioObservation) {
  const store = await createInMemorySessionContextStore({
    sessionId: context.sessionId,
    liveSetId: "set-a",
  });
  stores.push(store);
  const binding = {
    version: 1 as const,
    semanticLocator: {
      name,
      trackId: "track",
      arrangementRange: { startBeat: 0, endBeat: 4 },
    },
    sourceIdentity: "fixture:known-sine",
    playbackSettingsHash: "gain-zero",
    upstreamProcessingHash: "none",
    routingHash: "stereo",
    dependencyScope: "unknown" as const,
    previousRuntimeBindings: ["old-bridge-reference"],
  };
  const payload =
    supplied ??
    audioObservationSchema.parse({
      schema: "audio-observation/v1",
      listenerId: "listener",
      passId: "pass",
      sampleRate: 48_000,
      startSample: 0,
      endSample: 96_000,
      startBeat: 0,
      endBeat: 4,
      complete: true,
      limitations: [
        "Stored synthetic query fixture; not real-device validation",
      ],
      algorithm: {
        name: "fixture",
        version: "fixture-v1",
        windowSamples: 4800,
        hopSamples: 4800,
        settings: { attackThresholdDb: 6, minAttackSpacingSamples: 480 },
        units: { amplitude: "linear", rms: "dBFS", centroid: "Hz" },
        timingUncertaintySamples: 0,
      },
      summaries: {
        peak: [0.5, 0.5],
        rmsDbfs: [-12.158, -12.158],
        centroidHz: 440,
      },
      samples: [],
      attacks: [],
      reduction: { originalSamples: 0, originalAttacks: 0, truncated: false },
    });
  const legacy: AppendContextPass = {
    pass: {
      id: "pass",
      sessionId: context.sessionId,
      liveSetId: "set-a",
      initiatorAgentId: "writer",
      listenerIds: ["listener"],
      requestedMode: "arrangement",
      actualMode: "arrangement",
      requestedRange: { startBeat: 0, endBeat: 4 },
      actualRange: { startBeat: 0, endBeat: 4 },
      status: "completed",
      complete: true,
      createdAt: timestamp,
      startedAt: timestamp,
      endedAt: "2026-10-12T00:00:02.000Z",
      interruptionReason: null,
      trace,
    },
    subjects: [
      {
        id: "subject",
        sessionId: context.sessionId,
        liveSetId: "set-a",
        kind: "clip",
        trackId: "track",
        location: "arrangement",
        binding,
      },
    ],
    entries: [
      {
        id: "entry",
        sessionId: context.sessionId,
        liveSetId: "set-a",
        passId: "pass",
        kind: payload.schema,
        producer: {
          listenerId: "listener",
          deviceId: "device",
          agentId: "writer",
          connectionEpoch: "epoch",
          version: "fixture-v1",
        },
        createdAt: timestamp,
        capturedAt: timestamp,
        trace,
        payload,
      },
    ],
    links: [
      {
        id: "link",
        sessionId: context.sessionId,
        liveSetId: "set-a",
        entryId: "entry",
        subjectId: "subject",
        relationship: "primary",
        coverage: { startBeat: 0, endBeat: 4 },
        attribution: "unknown",
        observedContributorIds: [],
        sourceFingerprint: binding,
        freshness: {
          status: "unknown",
          assessedAt: timestamp,
          reason: "Current source is unverified",
        },
      },
    ],
  };
  if (payload.schema === "session-audio-observation/v1") {
    const track = {
      ...legacy.subjects[0]!,
      id: "track",
      kind: "track" as const,
      location: "track" as const,
      binding: {
        ...binding,
        previousRuntimeBindings: [
          payload.source.target.track.expectedReference,
        ],
      },
    };
    let sequence = 0;
    await store.appendPass(
      buildListeningPublication(
        {
          passId: "pass",
          owner: {
            sessionId: context.sessionId,
            liveSetId: "set-a",
            agentId: "writer",
          },
          trace,
          requestedMode: "session",
          actualMode: "session",
          requestedRange: { startBeat: 0, endBeat: 4 },
          createdAt: timestamp,
          startedAt: timestamp,
          endedAt: timestamp,
          observations: [payload],
          bindings: [
            {
              listenerId: "listener",
              deviceReference: "device",
              connectionEpoch: "epoch",
              version: "fixture-v1",
              primary: {
                ...track,
                id: "subject",
                kind: "clip",
                location: "session",
                binding: {
                  ...binding,
                  semanticLocator: {
                    name,
                    trackId: "track",
                    sceneIndex: payload.source.target.sceneIndex,
                  },
                  previousRuntimeBindings: [
                    payload.source.target.expectedClipReference,
                  ],
                },
              },
              contributors: [track],
              attribution: "unknown",
            },
          ],
        },
        () => (sequence++ === 0 ? "entry" : `link-${sequence}`),
      ),
    );
  } else {
    await store.appendPass(legacy);
  }
  const host = createSessionContextHost({
    resolveRepository: async () => store,
  });
  return { store, host, payload };
}

describe("typed App-session context host", () => {
  it("exposes Session local and transport coordinates plus historical timing limitations in existing typed APIs", async () => {
    const observation: StoredAudioObservation = {
      ...createSyntheticNativeListeningFixtureV2({ listenerId: "listener" })
        .observation,
      schema: "session-audio-observation/v1",
      source: {
        view: "session",
        target: {
          view: "session",
          track: {
            kind: "regular",
            index: 0,
            expectedReference: "00000000-0000-4000-8000-000000000001",
            expectedName: "Track",
          },
          sceneIndex: 0,
          expectedClipReference: "00000000-0000-4000-8000-000000000002",
          expectedClipName: "Clip",
        },
        kind: "midi",
        coordinate: { unit: "beats", iteration: 0, startBeat: 0, endBeat: 4 },
        transport: { startBeat: 40, endBeat: 44 },
        origin: {
          evidence: "message-rate-start-time-with-native-transport",
          clipStartTimeBeats: 40,
          observedAtGlobalBeat: 40,
        },
        continuity: {
          evidence: "message-rate-monitored",
          followActions: "unknown",
        },
      },
    };
    const { host } = await fixture("Session clip", observation);
    const detail = contextOperationResultSchema.parse(
      await host.executeContextOperation(
        {
          action: "get",
          contextId: "entry",
          includeHistorical: true,
        },
        context,
      ),
    );
    expect(detail).toMatchObject({
      action: "get",
      observation,
      entry: { kind: "session-audio-observation/v1", freshness: "unknown" },
    });
    if (detail.action !== "get") throw new Error("Expected detail");
    expect(detail.entry.summary).toContain("clip-local-beats 0-4");
    expect(detail.entry.summary).toContain("global transport beats 40-44");
    expect(detail.entry.summary).toContain("not physical source proof");
    expect(detail.entry.summary).toContain("absolute error unknown");
    expect(detail.entry.summary).toContain(
      "Follow actions unknown, not disabled",
    );
    expect(detail.entry.summary).toContain("detection-limited");
    expect(
      await host.getSessionContextInventory(context.sessionId, context),
    ).toContain("connection-scoped");
  });

  it("returns v2 inventory and detail with approximate quality and actual-rate milliseconds", async () => {
    const { observation } = createSyntheticNativeListeningFixtureV2({
      listenerId: "listener",
    });
    observation.sampleRate = observation.alignment.sampleRate = 44_100;
    observation.alignment.observedClockDisagreementSamples = 64;
    const { host } = await fixture("Descriptive query fixture", observation);
    const listed = contextOperationResultSchema.parse(
      await host.executeContextOperation(
        {
          action: "list",
          limit: 20,
          includeHistorical: false,
        },
        context,
      ),
    );
    expect(listed).toMatchObject({
      action: "list",
      entries: [{ kind: "audio-observation/v2" }],
    });
    if (listed.action !== "list") throw new Error("Unexpected context result");
    expect(listed.entries[0]?.summary).toContain(
      "Approximate descriptive-only timing; absolute error unknown",
    );
    expect(listed.entries[0]?.summary).toContain("64 samples (1.451 ms)");
    const detail = contextOperationResultSchema.parse(
      await host.executeContextOperation(
        {
          action: "get",
          contextId: "entry",
          includeHistorical: false,
        },
        context,
      ),
    );
    expect(detail).toMatchObject({
      action: "get",
      observation: {
        schema: "audio-observation/v2",
        alignment: { verifiedAbsoluteErrorBoundSamples: null },
      },
    });
    expect(
      await host.getSessionContextInventory(context.sessionId, context),
    ).toContain("Approximate descriptive-only timing");
  });

  it("propagates caller cancellation and prevents cancelled pruning", async () => {
    const { host, store } = await fixture();
    const controller = new AbortController();
    const list = vi.spyOn(store, "listEntries");
    await host.executeContextOperation(
      { action: "list", includeHistorical: false, limit: 20 },
      { ...context, signal: controller.signal },
    );
    expect(list.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
    controller.abort(new Error("caller cancelled"));
    await expect(
      host.executeContextOperation(
        {
          action: "prune",
          contextIds: ["entry"],
          confirm: "prune-session-context",
        },
        { ...context, signal: controller.signal },
      ),
    ).rejects.toThrow("caller cancelled");
    expect(await store.getEntry("entry")).toBeDefined();
  });

  it("aborts stalled repository resolution without cancelling the host lifetime", async () => {
    const caller = new AbortController();
    const lifetime = new AbortController();
    const host = createSessionContextHost({
      signal: lifetime.signal,
      resolveRepository: () => new Promise(() => {}),
    });
    const query = host.executeContextOperation(
      { action: "list", includeHistorical: false, limit: 20 },
      { ...context, signal: caller.signal },
    );
    caller.abort(new Error("cancelled during resolution"));
    await expect(query).rejects.toThrow("cancelled during resolution");
    expect(lifetime.signal.aborted).toBe(false);
  });

  it("attributes trusted application reads without a fabricated active-agent ID", async () => {
    const { store } = await fixture();
    const query = vi.spyOn(store, "listEntries");
    const host = createSessionContextHost({
      resolveRepository: async () => store,
    });
    await host.executeContextOperation(
      { action: "list", includeHistorical: true, limit: 20 },
      { ...context, actorKind: "application", agentId: "desktop-context" },
    );
    expect(query.mock.calls[0]?.[1]).toHaveProperty("trace", trace);
    expect(query.mock.calls[0]?.[1]).not.toHaveProperty("activeAgentId");
  });
  it("queries real repository history without claiming unknown data is fresh", async () => {
    const { host, payload } = await fixture();
    const current = await host.executeContextOperation(
      { action: "list", includeHistorical: false, limit: 20 },
      context,
    );
    expect(current).toMatchObject({
      action: "list",
      entries: [{ freshness: "unknown" }],
    });
    const historical = contextOperationResultSchema.parse(
      await host.executeContextOperation(
        {
          action: "list",
          includeHistorical: true,
          limit: 20,
        },
        context,
      ),
    );
    expect(historical.action).toBe("list");
    if (historical.action !== "list") throw new Error("Expected list");
    expect(historical.entries).toHaveLength(1);
    expect(historical.entries[0]).toMatchObject({
      contextId: "entry",
      subjectId: "subject",
      freshness: "unknown",
    });
    expect(historical.entries[0]?.summary).toContain("Known sine");
    expect(historical.entries[0]?.summary).toContain("Attribution unknown");
    const detail = await host.executeContextOperation(
      {
        action: "get",
        contextId: "entry",
        includeHistorical: true,
      },
      context,
    );
    expect(contextOperationResultSchema.parse(detail)).toMatchObject({
      action: "get",
      observation: payload,
    });
    expect(
      await host.executeContextOperation(
        {
          action: "get",
          contextId: "entry",
          includeHistorical: false,
        },
        context,
      ),
    ).toMatchObject({ action: "get", entry: { freshness: "unknown" } });
  });

  it("rejects cross-session resolver leakage and mismatched inventory ownership", async () => {
    const { host } = await fixture();
    await expect(
      host.executeContextOperation(
        {
          action: "list",
          includeHistorical: true,
          limit: 20,
        },
        { ...context, sessionId: "another-session" },
      ),
    ).rejects.toThrow("another App session");
    await expect(
      host.getSessionContextInventory("another-session", context),
    ).rejects.toThrow("invoking owner");
  });

  it("retains bounded inventory with historical names and without measurement arrays", async () => {
    const { host } = await fixture();
    const inventory = await host.getSessionContextInventory(
      context.sessionId,
      context,
    );
    expect(inventory.length).toBeLessThanOrEqual(16_384);
    expect(inventory).toContain("Known sine");
    expect(inventory).toContain('"freshness":"unknown"');
    expect(inventory).not.toContain('"samples"');
    expect(inventory).not.toContain('"attacks"');
  });

  it("prunes only exact owned IDs and refuses a partially invalid selection before deletion", async () => {
    const { store, host } = await fixture();
    await expect(
      host.executeContextOperation(
        {
          action: "prune",
          contextIds: ["entry", "missing"],
          confirm: "prune-session-context",
        },
        context,
      ),
    ).rejects.toThrow("existing context IDs");
    expect(await store.getEntry("entry")).toBeDefined();
    expect(
      await host.executeContextOperation(
        {
          action: "prune",
          contextIds: ["entry"],
          confirm: "prune-session-context",
        },
        context,
      ),
    ).toEqual({ action: "prune", prunedContextIds: ["entry"] });
    expect(await store.getEntry("entry")).toBeUndefined();
  });

  it("forwards each caller's trace and agent to repository reads", async () => {
    const { store, host } = await fixture();
    const list = vi.spyOn(store, "listEntries");
    await host.executeContextOperation(
      { action: "list", includeHistorical: true, limit: 20 },
      context,
    );
    expect(list.mock.lastCall?.[1]).toEqual({ trace, activeAgentId: "reader" });
    const other = {
      ...context,
      agentId: "other",
      trace: { ...trace, correlationId: "next-query" },
    };
    await host.getSessionContextInventory(context.sessionId, other);
    expect(list.mock.lastCall?.[1]).toEqual({
      trace: other.trace,
      activeAgentId: "other",
    });
  });

  it("reports missing/corrupt repositories rather than fabricating an empty inventory", async () => {
    const host = createSessionContextHost({
      resolveRepository: async () => {
        throw new Error("Context store recovery required");
      },
    });
    await expect(
      host.getSessionContextInventory(context.sessionId, context),
    ).rejects.toThrow("recovery required");
  });

  it("cancels before opening a repository and does not expose data", async () => {
    const controller = new AbortController();
    controller.abort(new Error("Context host closing"));
    const resolveRepository = vi.fn();
    const host = createSessionContextHost({
      resolveRepository,
      signal: controller.signal,
    });
    await expect(
      host.executeContextOperation(
        {
          action: "list",
          includeHistorical: true,
          limit: 20,
        },
        context,
      ),
    ).rejects.toThrow("host closing");
    expect(resolveRepository).not.toHaveBeenCalled();
  });

  it("keeps inventories valid JSON while dropping excess summaries explicitly", async () => {
    const { store, host } = await fixture("A".repeat(500));
    const page = await store.listEntries({ includeHistorical: true });
    const entry = page.items[0];
    if (entry === undefined) throw new Error("Expected fixture entry");
    vi.spyOn(store, "listEntries").mockResolvedValue({
      items: Array.from({ length: 20 }, () => entry),
    });
    const inventory = await host.getSessionContextInventory(
      context.sessionId,
      context,
    );
    expect(inventory.length).toBeLessThanOrEqual(16_384);
    const result: unknown = JSON.parse(inventory);
    expect(result).toMatchObject({ truncated: true });
  });
});
