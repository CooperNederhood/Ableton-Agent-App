import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { connect, type Socket } from "node:net";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  LocalObservabilityJournal,
  createNonBlockingObservabilityRecorder,
} from "@ableton-agent/observability";
import {
  ProducerDiagnosticReceipts,
  producerDiagnosticsSchema,
  type WriteDiagnosticEvent,
} from "./producer-diagnostics.js";
import { SignalIngressServer } from "./ingress-server.js";
import { InMemoryConnectionRegistry } from "./registry.js";
import { SignalRouter } from "./router.js";
import { NATIVE_LISTENER_SCOPE } from "@ableton-agent/protocol";

const require = createRequire(import.meta.url);
interface DiagnosticClient {
  socket: Socket | null;
  writeDiagnosticsSupported: boolean | null;
  writeDiagnosticEvents: readonly WriteDiagnosticEvent[];
  writeDiagnosticBatches: ReadonlyMap<string, unknown>;
  pending: ReadonlyMap<string, string>;
  writeDrain: unknown;
  clearWriteDrain(stage: string, reason: string): void;
  stop(): void;
}
// These are the ordinary production CommonJS modules, not diagnostic adapters.
const { AgentSignalClient } =
  require("../../../max-patches/shared/agent_signal_client.js") as {
    AgentSignalClient: new (
      options: Record<string, unknown>,
    ) => DiagnosticClient;
  };
const { createRuntime } =
  require("../../../max-patches/audio-listener/audio_listener_runtime.js") as {
    createRuntime(
      this: void,
      options: Record<string, unknown>,
    ): {
      client: DiagnosticClient | null;
      stop(): void;
    };
  };
const { VERSION } =
  require("../../../max-patches/audio-listener/audio_listener_engine.js") as {
    VERSION: string;
  };
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});
const secret = "diagnostic-test-secret-at-least-thirty-two-characters";
const uuid = (): string => randomUUID();
function origin() {
  return {
    producerId: "producer",
    instanceId: "instance",
    connectionId: uuid(),
    connectionEpoch: uuid(),
    requestId: uuid(),
    traceId: uuid(),
    correlationId: uuid(),
    causationId: uuid(),
    jobId: uuid(),
    passId: uuid(),
  };
}
function event(
  o = origin(),
  overrides: Partial<WriteDiagnosticEvent> = {},
): WriteDiagnosticEvent {
  return {
    requestId: o.requestId,
    traceId: o.traceId,
    correlationId: o.correlationId,
    causationId: o.causationId,
    jobId: o.jobId,
    passId: o.passId,
    connectionEpoch: o.connectionEpoch,
    originConnectionId: o.connectionId,
    eventId: uuid(),
    stage: "queued",
    sourceTime: Date.now(),
    order: 0,
    elapsedMs: 0,
    queueCount: 0,
    queueBytes: 0,
    reason: "write_backpressure",
    writeReturn: false,
    writableLength: 123,
    writableHighWaterMark: 1,
    ...overrides,
  };
}
async function journalFixture() {
  const parent = resolve(".test-artifacts");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "producer-diagnostic-journal-"));
  cleanup.push(() => rm(root, { recursive: true, force: false }));
  const journal = await LocalObservabilityJournal.open({
    path: join(root, "journal.sqlite"),
  });
  cleanup.push(() => journal.shutdown());
  const failures: unknown[] = [];
  const recorder = createNonBlockingObservabilityRecorder(journal, {
    onFailure: (e) => failures.push(e),
  });
  return { journal, recorder, failures };
}

async function peer(endpoint: { host: string; port: number }) {
  const socket = connect(endpoint);
  cleanup.push(() => {
    socket.destroy();
  });
  const messages: Array<Record<string, unknown>> = [];
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk.toString();
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const decoded: unknown = JSON.parse(buffer.slice(0, newline));
      if (
        typeof decoded !== "object" ||
        decoded === null ||
        Array.isArray(decoded)
      )
        throw new Error("Expected a protocol object");
      messages.push(decoded as Record<string, unknown>);
      buffer = buffer.slice(newline + 1);
    }
  });
  await new Promise<void>((done, reject) => {
    socket.once("connect", done);
    socket.once("error", reject);
  });
  return {
    socket,
    send(value: object) {
      socket.write(JSON.stringify(value) + "\n");
    },
    async next(type: string) {
      await vi.waitFor(() =>
        expect(messages.some((m) => m.type === type)).toBe(true),
      );
      return messages.splice(
        messages.findIndex((m) => m.type === type),
        1,
      )[0]!;
    },
  };
}

async function register(
  p: Awaited<ReturnType<typeof peer>>,
  o: ReturnType<typeof origin>,
) {
  p.send({
    type: "producer.hello",
    protocolVersion: 1,
    requestId: uuid(),
    secret,
    producer: {
      producerId: o.producerId,
      instanceId: o.instanceId,
      displayName: "test",
      signalKind: "audio",
      schemaVersion: "audio-observation/v1",
      track: { id: "1" },
      device: { id: "2" },
    },
    listener: {
      version: 1,
      connectionEpoch: o.connectionEpoch,
      capabilities: ["audio-listener/v1"],
      sampleRate: 48000,
      algorithmVersion: "test/v1",
      deviceCanonicalPath: "live_set tracks 0 devices 0",
      trackCanonicalPath: "live_set tracks 0",
      nativeStatus: {
        version: 1,
        scope: NATIVE_LISTENER_SCOPE,
        timing: "UNVERIFIED",
        readiness: "BLOCKED",
        reason: "fresh_per_pass_native_validation_required",
      },
    },
  });
  const ack = await p.next("producer.ack");
  expect(ack.producerDiagnostics).toEqual(["write-backpressure/v1"]);
  expect(typeof ack.connectionId).toBe("string");
  return String(ack.connectionId);
}

it("real typed journal preserves all source stages, redacts credentials and deduplicates after reconnect without adopting a new active owner", async () => {
  const { journal, recorder, failures } = await journalFixture();
  const registry = new InMemoryConnectionRegistry({ staleAfterMs: 15000 });
  const router = new SignalRouter({ registry }),
    route = vi.spyOn(router, "route"),
    delivery = vi.fn();
  const server = new SignalIngressServer({
    secret,
    registry,
    router,
    telemetry: recorder,
    port: 0,
  });
  const endpoint = await server.start();
  cleanup.push(() => server.stop());
  server.onListenerResult(delivery);
  const o = origin(),
    first = await peer(endpoint);
  o.connectionId = await register(first, o);
  const owner = {
    action: "prepare" as const,
    traceId: o.traceId,
    correlationId: o.correlationId,
    causationId: `token=${secret}`,
    jobId: o.jobId,
    passId: o.passId,
    config: {
      durationMs: 1000,
      maxWindows: 10,
      source: { mode: "arrangement" as const, startBeat: 0, endBeat: 2 },
    },
  };
  const pending = server.requestListenerControl(o.connectionId, owner);
  const control = await first.next("listener.control");
  const wire = Object.fromEntries(
    Object.entries(control).filter(
      ([key]) => key !== "action" && key !== "config",
    ),
  );
  first.send({
    ...wire,
    type: "listener.reply",
    sequence: 0,
    status: "failed",
    reason: "controlled_test_failure",
  });
  expect((await pending).status).toBe("failed");
  await first.next("producer.ack");
  expect(server.inspectListeners()[0]!.phase).toBe("idle");
  o.requestId = String(control.requestId);
  o.causationId = owner.causationId;
  const stages = [
    "queued",
    "started",
    "progress",
    "completed",
    "failed",
    "cancelled",
  ] as const;
  const events = stages.map((stage, order) =>
    event(o, {
      stage,
      order,
      elapsedMs: order,
      reason:
        stage === "completed"
          ? "drain"
          : stage === "failed"
            ? "outbound_write_failed"
            : stage === "cancelled"
              ? "stopped"
              : "write_backpressure",
    }),
  );
  first.socket.destroy();
  await vi.waitFor(() => expect(server.inspectListeners()).toHaveLength(0));
  const second = await peer(endpoint),
    newOrigin = { ...o, connectionEpoch: uuid() };
  const deliveryConnectionId = await register(second, newOrigin);
  const nextOwner = {
    ...owner,
    jobId: uuid(),
    passId: uuid(),
    traceId: uuid(),
    causationId: uuid(),
  };
  const preparing = server.requestListenerControl(
    deliveryConnectionId,
    nextOwner,
  );
  const fresh = await second.next("listener.control");
  const freshWire = Object.fromEntries(
    Object.entries(fresh).filter(
      ([key]) => key !== "action" && key !== "config",
    ),
  );
  second.send({
    ...freshWire,
    type: "listener.reply",
    sequence: 0,
    status: "ready",
  });
  await preparing;
  await second.next("producer.ack");
  const batch = { schema: "write-backpressure/v1", events };
  for (let index = 0; index < 2; index++) {
    second.send({
      type: "producer.heartbeat",
      protocolVersion: 1,
      requestId: uuid(),
      diagnostics: batch,
    });
    expect((await second.next("producer.ack")).action).toBe("heartbeat");
  }
  await new Promise((r) => setTimeout(r, 0));
  const page = await journal.readEvents({ traceId: o.traceId, limit: 100 });
  const saved = page.items.filter((e) =>
    e.name.startsWith("output.producer.write-backpressure."),
  );
  expect(saved).toHaveLength(6);
  expect(saved.map((e) => e.attributes.stage).sort()).toEqual(
    [...stages].sort(),
  );
  for (const entry of saved) {
    expect(entry.trace?.traceId).toBe(o.traceId);
    expect(entry.attributes.jobId).toBe(o.jobId);
    expect(entry.attributes.passId).toBe(o.passId);
    expect(entry.attributes.originConnectionId).toBe(o.connectionId);
    expect(entry.attributes.deliveryConnectionId).toBe(deliveryConnectionId);
    expect(JSON.stringify(entry)).not.toContain(secret);
    expect(entry.durationMs).toBe(entry.attributes.order);
    expect(entry.occurredAt).toBe(
      new Date(Number(entry.attributes.sourceTime)).toISOString(),
    );
  }
  expect(server.inspectListeners()[0]!.jobId).toBe(nextOwner.jobId);
  expect(delivery).not.toHaveBeenCalled();
  expect(route).not.toHaveBeenCalled();
  expect(failures).toEqual([]);
  const gaps = (await journal.readEvents({ limit: 100 })).items.filter(
    (e) => e.name === "output.producer.diagnostics.coverage-gap",
  );
  expect(
    gaps.some(
      (e) =>
        e.outcome === "unknown" &&
        e.attributes.sourceLifecycleCoverage === "unknown",
    ),
  ).toBe(true);
});

it("malformed, forged, expired and source-loss diagnostics are explicit nonfatal journal gaps and never listener events", async () => {
  const { journal, recorder } = await journalFixture();
  const registry = new InMemoryConnectionRegistry({ staleAfterMs: 15000 }),
    diagnostics: unknown[] = [];
  const server = new SignalIngressServer({
    secret,
    registry,
    router: new SignalRouter({ registry }),
    telemetry: recorder,
    port: 0,
    onDiagnostic: (d) => {
      diagnostics.push(d);
      if (d.message.startsWith("Producer observability gap:"))
        throw new Error("controlled diagnostic callback failure");
    },
  });
  const endpoint = await server.start();
  cleanup.push(() => server.stop());
  const o = origin(),
    p = await peer(endpoint);
  await register(p, o);
  for (const batch of [
    { schema: "bad", rawAudio: secret },
    { schema: "write-backpressure/v1", events: [event(o)] },
    {
      schema: "write-backpressure/v1",
      events: [],
      gaps: { overflow: 3, expired: 2, unsupported: 1 },
    },
  ]) {
    p.send({
      type: "producer.heartbeat",
      protocolVersion: 1,
      requestId: uuid(),
      diagnostics: batch,
    });
    expect((await p.next("producer.ack")).action).toBe("heartbeat");
  }
  await new Promise((r) => setTimeout(r, 0));
  const entries = (await journal.readEvents({ limit: 100 })).items;
  expect(
    entries.filter(
      (e) => e.name === "output.producer.diagnostics.coverage-gap",
    ),
  ).toHaveLength(3);
  expect(
    entries.some(
      (e) =>
        e.name === "output.producer.diagnostics.source-gap" &&
        e.attributes.overflow === 3,
    ),
  ).toBe(true);
  expect(
    entries.some((e) =>
      e.name.startsWith("output.producer.write-backpressure."),
    ),
  ).toBe(false);
  expect(JSON.stringify(entries)).not.toContain(secret);
  expect(diagnostics).toHaveLength(3);
  expect(server.inspectListeners()[0]!.phase).toBe("idle");
  expect(p.socket.destroyed).toBe(false);
});

it.each(["throw", "reject"])(
  "production recorder %s failure is explicit, heartbeat ACK is not journal durability, and listener remains usable",
  async (mode) => {
    const { journal } = await journalFixture(),
      failures: unknown[] = [];
    const recorder = createNonBlockingObservabilityRecorder(
      {
        enqueue(entry) {
          if (entry.name.startsWith("output.producer.write-backpressure.")) {
            const error = new Error("controlled recorder failure");
            if (mode === "throw") throw error;
            return Promise.reject(error);
          }
          return journal.enqueue(entry);
        },
        enqueueConfigurationSnapshot(snapshot) {
          return journal.enqueueConfigurationSnapshot(snapshot);
        },
      },
      { onFailure: (failure) => failures.push(failure) },
    );
    const registry = new InMemoryConnectionRegistry({ staleAfterMs: 15000 });
    const server = new SignalIngressServer({
      secret,
      registry,
      router: new SignalRouter({ registry }),
      telemetry: recorder,
      port: 0,
    });
    const endpoint = await server.start();
    cleanup.push(() => server.stop());
    const o = origin(),
      p = await peer(endpoint);
    o.connectionId = await register(p, o);
    p.send({
      type: "producer.heartbeat",
      protocolVersion: 1,
      requestId: o.requestId,
    });
    await p.next("producer.ack");
    const transport = Object.fromEntries(
      Object.entries(event(o)).filter(
        ([key]) =>
          ![
            "traceId",
            "correlationId",
            "causationId",
            "jobId",
            "passId",
          ].includes(key),
      ),
    );
    p.send({
      type: "producer.heartbeat",
      protocolVersion: 1,
      requestId: uuid(),
      diagnostics: { schema: "write-backpressure/v1", events: [transport] },
    });
    expect((await p.next("producer.ack")).action).toBe("heartbeat");
    await vi.waitFor(() => expect(failures).toHaveLength(1));
    const entries = (await journal.readEvents({ limit: 100 })).items;
    expect(
      entries.some((entry) =>
        entry.name.startsWith("output.producer.write-backpressure."),
      ),
    ).toBe(false);
    expect(
      entries.some((entry) => entry.name === "output.ingress.acknowledged"),
    ).toBe(true);
    expect(server.inspectListeners()[0]!.phase).toBe("idle");
    expect(p.socket.destroyed).toBe(false);
  },
);

it("bounds schema by both serialized bytes and count, without arbitrary bodies", () => {
  const e = event();
  expect(
    producerDiagnosticsSchema.safeParse({
      schema: "write-backpressure/v1",
      events: [e],
    }).success,
  ).toBe(true);
  expect(
    producerDiagnosticsSchema.safeParse({
      schema: "write-backpressure/v1",
      events: Array.from({ length: 9 }, () => event()),
    }).success,
  ).toBe(false);
  const long = {
    ...e,
    ...Object.fromEntries(
      [
        "requestId",
        "originConnectionId",
        "connectionEpoch",
        "traceId",
        "correlationId",
        "causationId",
        "jobId",
        "passId",
      ].map((k) => [k, "x".repeat(128)]),
    ),
  };
  expect(
    producerDiagnosticsSchema.safeParse({
      schema: "write-backpressure/v1",
      events: Array(8).fill(long),
    }).success,
  ).toBe(false);
  for (const extra of [
    { audio: "body" },
    { elapsedMs: NaN },
    { sourceTime: -1 },
    { queueBytes: Number.MAX_SAFE_INTEGER + 1 },
    { reason: "secret=credential" },
  ])
    expect(
      producerDiagnosticsSchema.safeParse({
        schema: "write-backpressure/v1",
        events: [{ ...e, ...extra }],
      }).success,
    ).toBe(false);
});

it("binds delayed released-owner events to original receipts, never a new owner, and deduplicates across delivery connections", () => {
  let now = Date.now();
  const receipts = new ProducerDiagnosticReceipts(() => now),
    o = origin(),
    e = event(o);
  receipts.remember(o);
  expect(
    receipts.accept(o.producerId, o.instanceId, { ...e, jobId: uuid() }).kind,
  ).toBe("rejected");
  expect(receipts.accept(o.producerId, "another-instance", e).kind).toBe(
    "rejected",
  );
  expect(receipts.accept(o.producerId, o.instanceId, e)).toEqual({
    kind: "accepted",
    origin: o,
  });
  expect(receipts.accept(o.producerId, o.instanceId, e).kind).toBe("duplicate");
  expect(
    receipts.accept(o.producerId, o.instanceId, { ...e, eventId: uuid() }).kind,
  ).toBe("rejected");
  receipts.remember({ ...o, requestId: uuid(), jobId: uuid() });
  for (const [index, stage] of [
    "started",
    "progress",
    "completed",
    "failed",
    "cancelled",
  ].entries())
    expect(
      receipts.accept(o.producerId, o.instanceId, {
        ...e,
        eventId: uuid(),
        order: index + 1,
        stage: stage as WriteDiagnosticEvent["stage"],
      }).kind,
    ).toBe("accepted");
  now += 60000;
  expect(
    receipts.accept(o.producerId, o.instanceId, {
      ...e,
      eventId: uuid(),
      order: 100,
    }).kind,
  ).toBe("rejected");
  receipts.clear();
});

it("ordinary runtime actual socket write(false) callbacks reach authenticated heartbeat and real typed journal without fabricating a capture owner", async () => {
  const { journal, recorder, failures } = await journalFixture();
  const registry = new InMemoryConnectionRegistry({ staleAfterMs: 15000 });
  const router = new SignalRouter({ registry });
  const route = vi.spyOn(router, "route");
  const diagnostics: unknown[] = [];
  const server = new SignalIngressServer({
    secret,
    registry,
    router,
    telemetry: recorder,
    port: 0,
    onDiagnostic: (d) => diagnostics.push(d),
  });
  const endpoint = await server.start();
  cleanup.push(() => server.stop());
  const handlers: Record<string, (...args: unknown[]) => void> = {},
    polls: Array<() => void> = [],
    beats: Array<() => void> = [];
  class Client extends AgentSignalClient {
    constructor(options: Record<string, unknown>) {
      super({
        ...options,
        secret,
        env: {},
        descriptorPath: "/test/descriptor",
        readText: async () =>
          JSON.stringify({
            ...endpoint,
            protocol: "newline-delimited-json",
            protocolVersion: 1,
            maxFrameBytes: 131072,
            listenerVersions: [1, 2],
            listenerCapabilities: ["audio-listener/v1", "audio-listener/v2"],
          }),
        createConnection: (address: { host: string; port: number }) => {
          const options = { ...address, highWaterMark: 1 };
          return connect(options);
        },
        setInterval: (fn: () => void) => {
          beats.push(fn);
          return { unref() {} };
        },
        clearInterval: () => {},
      });
    }
  }
  const runtime = createRuntime({
    Client,
    maxApi: {
      addHandler: (name: string, fn: (...args: unknown[]) => void) => {
        handlers[name] = fn;
      },
      outlet() {},
    },
    env: {
      ABLETON_AGENT_SIGNAL_INGRESS_DESCRIPTOR: "/test/descriptor",
      ABLETON_AGENT_SIGNAL_INGRESS_SECRET_PATH: "/test/credential",
    },
    interval: (fn: () => void) => {
      polls.push(fn);
      return fn;
    },
    clear() {},
    certificate: {
      validated: true,
      algorithmVersion: VERSION,
      hostVersion: "test-double",
      maxVersion: "test-double",
      launchAligned: true,
      requiredHostFlags: 19,
      uncertaintySamples: 64,
      descriptorOffsetSamples: 0,
      sampleRate: 48000,
      vectorSize: 64,
    },
  });
  cleanup.push(() => runtime.stop());
  handlers.identity!(
    JSON.stringify({
      canonicalPath: "live_set tracks 0 devices 0",
      track: { id: "1", name: "test" },
      device: { id: "2", name: "Audio-Listener" },
    }),
  );
  handlers.dsp!(1, 48000, 64);
  handlers.host!(0, 4, 10000, 19);
  polls[0]!();
  const client = runtime.client;
  if (!client) throw new Error("Ordinary runtime did not configure a client");
  await vi.waitFor(() => expect(server.inspectListeners()).toHaveLength(1));
  await vi.waitFor(() => expect(client.writeDiagnosticsSupported).toBe(true));
  const connection = server.inspectListeners()[0]!.connectionId;
  const socket = client.socket;
  if (!socket) throw new Error("Ordinary client did not open its socket");
  const sourceEvents: WriteDiagnosticEvent[] = [];
  for (const stage of ["completed", "failed", "cancelled"]) {
    socket.cork();
    beats.at(-1)!();
    if (stage === "completed") beats.at(-1)!();
    else
      client.clearWriteDrain(
        stage,
        stage === "failed" ? "outbound_write_failed" : "stopped",
      );
    socket.uncork();
    await vi.waitFor(() => {
      expect(client.writeDrain).toBe(null);
      expect(client.pending.size).toBe(0);
    });
    sourceEvents.push(...client.writeDiagnosticEvents);
    while (client.writeDiagnosticEvents.length) {
      beats.at(-1)!();
      await vi.waitFor(() =>
        expect(client.writeDiagnosticBatches.size).toBe(0),
      );
    }
  }
  await new Promise((r) => setTimeout(r, 0));
  const page = await journal.readEvents({ limit: 100 });
  const events = page.items.filter((e) =>
    e.name.startsWith("output.producer.write-backpressure."),
  );
  expect(events.length).toBe(sourceEvents.length);
  expect(
    events.map((e) => e.attributes.order).sort((a, b) => Number(a) - Number(b)),
  ).toEqual(sourceEvents.map((e) => e.order));
  expect(new Set(events.map((e) => e.name.split(".").at(-1)))).toEqual(
    new Set([
      "queued",
      "started",
      "progress",
      "completed",
      "failed",
      "cancelled",
    ]),
  );
  for (const e of events) {
    expect(e.attributes.jobId).toBeUndefined();
    expect(e.attributes.passId).toBeUndefined();
    expect(e.attributes.writeReturn).toBe(false);
    expect(e.attributes.writableHighWaterMark).toBe(1);
    expect(e.attributes.originConnectionId).toBe(connection);
    expect(e.attributes.deliveryConnectionId).toBe(connection);
    expect(e.attributes.originVerified).toBe(true);
    expect(e.durationMs).toBeGreaterThanOrEqual(0);
  }
  expect(route).not.toHaveBeenCalled();
  expect(diagnostics).toEqual([]);
  expect(failures).toEqual([]);
  expect(client.pending.size).toBe(0);
});
