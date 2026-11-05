import { randomUUID } from "node:crypto";
import { connect, Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setImmediate as nextTurn } from "node:timers/promises";
import { MAX_METRIC_RESULT_FRAME_BYTES } from "@ableton-agent/protocol";
import type { TelemetryEventEnvelope } from "@ableton-agent/observability";
import {
  SignalIngressServer,
  type SignalIngressServerOptions,
} from "./ingress-server.js";
import { InMemoryConnectionRegistry } from "./registry.js";
import { SignalRouter } from "./router.js";
import type { ListenerResultEvent } from "./listener-contracts.js";
import { createIngressJournalFixture } from "./test-fixtures.js";
import {
  listenerControlMetricSchema,
  listenerMetricWireIdentitySchema,
  listenerRegistrationMetricSchema,
  listenerReplyMetricSchema,
  listenerResultMetricSchema,
  nativeMetricLifecycleSchema,
  nativeMetricListeningConfigSchema,
  type ListenerControlMetric,
  type NativeMetricLifecycle,
} from "./listener-metric-contracts.js";
import {
  createSyntheticMetricWireFixture,
  bindMetricFixtureToControl,
} from "./listener-metric-test-support.js";

const SECRET = "synthetic-metric-ingress-secret-not-a-user-credential";
const servers: SignalIngressServer[] = [];
const sockets: Socket[] = [];
const resources: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  for (const dispose of resources.splice(0).reverse()) await dispose();
});

async function peer(
  endpoint: { host: string; port: number },
  responseTimeoutMs = 2000,
) {
  const socket = connect(endpoint);
  sockets.push(socket);
  const queue: unknown[] = [];
  const waiting: Array<{
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    for (let end; (end = buffer.indexOf("\n")) >= 0;) {
      const value: unknown = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      const waiter = waiting.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.resolve(value);
      } else queue.push(value);
    }
  });
  socket.on("close", () => {
    for (const waiter of waiting.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("Metric peer closed"));
    }
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  return {
    close() {
      socket.destroy();
    },
    send(value: unknown) {
      if (socket.destroyed) throw new Error("Metric peer closed");
      socket.write(`${JSON.stringify(value)}\n`);
    },
    sendBatch(values: readonly unknown[]) {
      if (socket.destroyed) throw new Error("Metric peer closed");
      socket.write(
        `${values.map((value) => JSON.stringify(value)).join("\n")}\n`,
      );
    },
    async sendFragmented(value: unknown, frameBytes?: number) {
      const json = JSON.stringify(value);
      const size = Buffer.byteLength(json);
      if (frameBytes !== undefined && frameBytes < size)
        throw new Error("Fragmented test frame cannot truncate JSON");
      const encoded = Buffer.from(
        `${json}${" ".repeat((frameBytes ?? size) - size)}\n`,
      );
      for (let offset = 0; offset < encoded.length; offset += 16 * 1024) {
        if (socket.destroyed) throw new Error("Metric peer closed");
        socket.write(encoded.subarray(offset, offset + 16 * 1024));
        await nextTurn();
      }
    },
    sendRaw(value: string) {
      socket.write(value);
    },
    next(): Promise<unknown> {
      if (queue.length) return Promise.resolve(queue.shift());
      if (socket.destroyed)
        return Promise.reject(new Error("Metric peer closed"));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiting.findIndex((item) => item.timer === timer);
          if (index >= 0) waiting.splice(index, 1);
          reject(new Error("Metric peer response timeout"));
        }, responseTimeoutMs);
        waiting.push({ resolve, reject, timer });
      });
    },
  };
}

async function start(
  options: Partial<SignalIngressServerOptions> = {},
  qualified = true,
  responseTimeoutMs = 2000,
) {
  const registry = new InMemoryConnectionRegistry({ staleAfterMs: 100_000 });
  const events: TelemetryEventEnvelope[] = [];
  const server = new SignalIngressServer({
    secret: SECRET,
    registry,
    router: new SignalRouter({ registry }),
    port: 0,
    ...(qualified ? { independentMetricListeners: true } : {}),
    telemetry: {
      enqueue: (event) => {
        events.push(event);
      },
    },
    ...options,
  });
  servers.push(server);
  return {
    server,
    events,
    client: await peer(await server.start(), responseTimeoutMs),
  };
}

function hello(fixture: ReturnType<typeof createSyntheticMetricWireFixture>) {
  return {
    type: "producer.hello",
    protocolVersion: 1,
    requestId: "hello",
    secret: SECRET,
    producer: {
      producerId: fixture.wire.listenerId,
      instanceId: randomUUID(),
      displayName: "Synthetic metric listener",
      signalKind: "audio",
      schemaVersion: "metric-audio-observation/v1",
      track: { id: "17", name: "Synthetic track" },
      device: { id: "29", name: "Synthetic listener" },
    },
    listener: listenerRegistrationMetricSchema.parse({
      ...fixture.registration,
      nativeStatus: {
        ...fixture.registration.nativeStatus,
        readiness: "BLOCKED",
        executedGen: null,
        reason: "fresh_per_pass_native_validation_required",
      },
    }),
  };
}

function wire(control: ListenerControlMetric) {
  return listenerMetricWireIdentitySchema.parse(
    Object.fromEntries(
      Object.keys(listenerMetricWireIdentitySchema.shape).map((key) => [
        key,
        Reflect.get(control, key),
      ]),
    ),
  );
}

async function session(
  mode: "arrangement" | "session" = "arrangement",
  partial = false,
  options: Partial<SignalIngressServerOptions> = {},
  withSourceContext = false,
  geometry: false | { tempoBpm: number; endBeat: number } = false,
) {
  const f = createSyntheticMetricWireFixture(mode, partial, geometry);
  if (withSourceContext) {
    const config = nativeMetricListeningConfigSchema.parse({
      ...f.config,
      sourceContext: f.observation.source,
    });
    f.config = config;
    f.ready.config = structuredClone(config);
    f.proof.armed.config = structuredClone(config);
  }
  // Large-frame peers need headroom when the owning suite runs CPU-heavy workers.
  const { server, client, events } = await start(
    options,
    true,
    geometry ? 10_000 : 2000,
  );
  const received: ListenerResultEvent[] = [];
  server.onListenerResult((event) => {
    received.push(event);
  });
  client.send(hello(f));
  const acknowledgement = await client.next();
  expect(acknowledgement).toMatchObject({
    type: "producer.ack",
    action: "hello",
  });
  const descriptor = server.inspectListeners()[0];
  if (!descriptor) throw new Error("Synthetic metric registration missing");
  const connectionId = descriptor.connectionId;
  expect(acknowledgement).toMatchObject({
    connectionId: descriptor.connectionId,
  });
  expect(acknowledgement).toHaveProperty("listenerCapabilities", [
    "audio-listener/independent-metric-timelines-v1",
    "audio-listener/mel-band-timelines-v1",
  ]);
  const input = {
    jobId: f.wire.jobId,
    passId: f.wire.passId,
    traceId: f.wire.traceId,
    correlationId: f.wire.correlationId,
    causationId: f.wire.causationId,
  };
  const callerConfig = structuredClone(f.config);
  const preparing = server.requestListenerControl(descriptor.connectionId, {
    ...input,
    action: "prepare",
    config: callerConfig,
  });
  void preparing.catch(() => {});
  const prepare = listenerControlMetricSchema.parse(await client.next());
  const bound = bindMetricFixtureToControl(f, prepare);
  let sequence = 0;
  async function reply(control: ListenerControlMetric, payload: object) {
    const message = {
      ...wire(control),
      type: "listener.reply",
      ...payload,
      sequence: sequence++,
    };
    client.send(listenerReplyMetricSchema.parse(message));
    expect(await client.next()).toMatchObject({
      type: "producer.ack",
      action: "listener",
    });
    return message;
  }
  async function result(payload: object, frameBytes?: number) {
    const message = {
      ...wire(prepare),
      type: "listener.result",
      requestId: randomUUID(),
      sequence: sequence++,
      ...payload,
    };
    if (frameBytes === undefined) client.send(message);
    else await client.sendFragmented(message, frameBytes);
    return { message, acknowledgement: await client.next() };
  }
  async function ready() {
    await reply(prepare, { status: "ready", nativeReady: bound.ready });
    await expect(preparing).resolves.toMatchObject({ status: "ready" });
  }
  async function arm() {
    const arming = server.requestListenerControl(connectionId, {
      ...input,
      action: "arm",
    });
    const control = listenerControlMetricSchema.parse(await client.next());
    expect(control).toMatchObject({
      generation: prepare.generation,
      sequence: 1,
      listenerId: prepare.listenerId,
      connectionId: prepare.connectionId,
    });
    await reply(control, { status: "armed", nativeArm: bound.proof.armed });
    await expect(arming).resolves.toMatchObject({ status: "armed" });
    await result({ status: "progress", nativeLaunch: bound.proof.launched });
  }
  return {
    server,
    client,
    events,
    received,
    descriptor,
    prepare,
    callerConfig,
    preparing,
    bound,
    input,
    ready,
    arm,
    reply,
    result,
  };
}

function lifecycle(
  s: Awaited<ReturnType<typeof session>>,
  patch: Partial<NativeMetricLifecycle> = {},
) {
  return nativeMetricLifecycleSchema.parse({
    scope: "independent-metric-timelines/v1",
    metric: "spectral-centroid",
    eventId: randomUUID(),
    causationId: randomUUID(),
    generation: s.prepare.generation,
    nativeEpoch: s.bound.proof.armed.ownership.nativeEpoch,
    stage: "progress",
    phase: "capture",
    elapsedMs: 100,
    frames: 1,
    ...patch,
  });
}

describe("opt-in authenticated independent metric ingress", () => {
  it.each([false, true])(
    "receives a fragmented 2 MiB complete/partial frame with thirty-second records (partial=%s)",
    async (partial) => {
      const s = await session("session", partial, {}, true, {
        tempoBpm: 128,
        endBeat: 64,
      });
      await s.ready();
      await s.arm();
      const payload = {
        status: partial ? "partial" : "completed",
        observation: s.bound.observation,
        nativeSourceCoverage: s.bound.proof,
      };
      const { acknowledgement } = await s.result(
        payload,
        MAX_METRIC_RESULT_FRAME_BYTES,
      );
      expect(acknowledgement).toMatchObject({
        type: "producer.ack",
        action: "listener",
      });
      const terminal = s.received.at(-1);
      expect(terminal?.result).toMatchObject(payload);
      expect(terminal?.result.observation?.rows).toHaveLength(256);
      expect(terminal?.result.traceId).toBe(s.prepare.traceId);
      expect(s.server.inspectListeners()[0]?.phase).toBe("idle");
      expect(s.events.filter((event) => event.outcome === "failure")).toEqual(
        [],
      );
    },
  );

  it("rejects one byte above the metric frame ceiling and incomplete oversized frames", async () => {
    for (const terminated of [false, true]) {
      const { client } = await start();
      client.sendRaw(
        `${" ".repeat(MAX_METRIC_RESULT_FRAME_BYTES + 1)}${terminated ? "\n" : ""}`,
      );
      expect(await client.next()).toMatchObject({
        type: "producer.error",
        code: "frame-too-large",
      });
    }
  });

  it.each([undefined, false, true])(
    "denies old listening registrations and replies/results with gate %s",
    async (gate) => {
      for (const version of [1, 2, 3, 4]) {
        const { server, client } = await start(
          gate === undefined ? {} : { independentMetricListeners: gate },
          gate !== undefined,
        );
        const f = createSyntheticMetricWireFixture();
        const value = hello(f);
        client.send({
          ...value,
          producer: {
            ...value.producer,
            schemaVersion: `audio-observation/v${version === 1 ? 1 : 2}`,
          },
          listener: {
            version,
            connectionEpoch: "old-epoch",
            sampleRate: 48000,
            algorithmVersion: version === 1 ? "native/v1" : "2.0.0",
            deviceCanonicalPath: "live_set tracks 0 devices 0",
            trackCanonicalPath: "live_set tracks 0",
            ...(version === 1
              ? {}
              : {
                  vectorSize: 64,
                  nativeStatus: {
                    version,
                    scope:
                      version === 2
                        ? "arrangement-descriptive/v2"
                        : version === 3
                          ? "session-transport-coupled/v1"
                          : "mode-negotiated-transport/v1",
                    timing: "UNVERIFIED",
                    readiness: "READY",
                    alignment: "approximate",
                    verifiedAbsoluteErrorBoundSamples: null,
                    acceptedSampleRates: [44_100, 48_000],
                    acceptedVectorSizes: [64],
                    timingModes: ["descriptive", "strict"],
                    maxClockDisagreementSamples: 480,
                    maxAudioDurationMs: 30_000,
                    maxWindows: 300,
                    abiVersion: 2,
                    ...(version === 3
                      ? {
                          sourceEvidence: "expected-context-only",
                          synchronization: "transport-coupled-first-iteration",
                        }
                      : {}),
                    ...(version === 4
                      ? { supportedModes: ["arrangement", "session"] }
                      : {}),
                  },
                }),
            capabilities: [
              [
                "audio-listener/v1",
                "audio-listener/v2",
                "audio-listener/session-v1",
                "audio-listener/dual-mode-v1",
              ][version - 1],
            ],
          },
        });
        expect(await client.next()).toMatchObject({
          type: "producer.error",
          code: "invalid-message",
          fatal: true,
        });
        expect(server.inspectListeners()).toEqual([]);
        for (const type of ["listener.reply", "listener.result"]) {
          const next = await peer(await server.start());
          next.send({
            ...f.wire,
            listenerVersion: version,
            type,
            status: "failed",
            reason: "obsolete",
          });
          expect(await next.next()).toMatchObject({
            code: "invalid-message",
            fatal: true,
          });
        }
      }
    },
  );

  it("preserves ownership, pre-ready arm and immutable prepared configuration guards", async () => {
    const s = await session();
    await expect(
      s.server.requestListenerControl(s.descriptor.connectionId, {
        ...s.input,
        action: "arm",
      }),
    ).rejects.toThrow("not ready");
    await expect(
      s.server.requestListenerControl(s.descriptor.connectionId, {
        ...s.input,
        action: "prepare",
        config: s.bound.config,
      }),
    ).rejects.toThrow("already owned");
    await s.ready();
    for (const field of [
      "jobId",
      "passId",
      "traceId",
      "correlationId",
      "causationId",
    ] as const) {
      await expect(
        s.server.requestListenerControl(s.descriptor.connectionId, {
          ...s.input,
          [field]: randomUUID(),
          action: "arm",
        }),
      ).rejects.toThrow("ownership mismatch");
    }
    expect(s.server.inspectListeners()[0]?.phase).toBe("ready");
    const snapshot = structuredClone(s.prepare.config);
    s.callerConfig.geometry.totalSamples += 64;
    expect(s.prepare.config).toEqual(snapshot);
    await s.arm();
  });

  it.each(["timeout", "abort"] as const)(
    "releases pending prepare after %s with attributed failure",
    async (mode) => {
      const { server, client, events } = await start();
      const f = createSyntheticMetricWireFixture();
      client.send(hello(f));
      const ack = (await client.next()) as { connectionId: string };
      const controller = new AbortController();
      const pending = server.requestListenerControl(
        ack.connectionId,
        {
          jobId: f.wire.jobId,
          passId: f.wire.passId,
          traceId: f.wire.traceId,
          correlationId: f.wire.correlationId,
          causationId: f.wire.causationId,
          action: "prepare",
          config: f.config,
        },
        {
          timeoutMs: mode === "timeout" ? 25 : 1000,
          signal: controller.signal,
        },
      );
      const rejected = expect(pending).rejects.toThrow(
        mode === "timeout" ? "timed out" : "cancelled",
      );
      await client.next();
      if (mode === "abort") controller.abort();
      await rejected;
      await expect.poll(() => server.inspectListeners()).toEqual([]);
      expect(
        events.some(
          (event) =>
            event.name === "output.listener.failed" &&
            event.trace?.traceId === f.wire.traceId,
        ),
      ).toBe(true);
      expect(
        events.some(
          (event) =>
            event.name ===
              `output.listener.${mode === "abort" ? "cancelled" : "failed"}` &&
            typeof event.durationMs === "number",
        ),
      ).toBe(true);
    },
  );

  it("rejects pre-aborted controls without taking ownership", async () => {
    const s = await session();
    await s.ready();
    const controller = new AbortController();
    controller.abort();
    await expect(
      s.server.requestListenerControl(
        s.descriptor.connectionId,
        { ...s.input, action: "arm" },
        { signal: controller.signal },
      ),
    ).rejects.toThrow("cancelled");
    expect(s.server.inspectListeners()[0]?.phase).toBe("ready");
  });

  it("fails an armed pass on shutdown and respects subscriber cleanup", async () => {
    const s = await session();
    const detached = vi.fn();
    const unsubscribe = s.server.onListenerResult(detached);
    unsubscribe();
    await s.ready();
    await s.arm();
    await s.server.stop();
    expect(s.received.at(-1)?.result).toMatchObject({
      status: "failed",
      reason: "server_shutdown",
    });
    expect(detached).not.toHaveBeenCalled();
    expect(s.server.inspectListeners()).toEqual([]);
    await expect(
      s.server.requestListenerControl(s.descriptor.connectionId, {
        ...s.input,
        action: "cancel",
      }),
    ).rejects.toThrow("unavailable");
  });

  it("rejects obsolete diagnostic bodies without persisting credentials or treating them as proof", async () => {
    const s = await session();
    await s.ready();
    const token = `ghp_${"c".repeat(40)}`;
    const { acknowledgement } = await s.result({
      status: "failed",
      reason: "synthetic-old-diagnostic",
      nativeFailureDiagnostic: {
        scope: "native-spectrum-rejection/v1",
        secret: token,
        rawAudio: [1, 2, 3],
      },
    });
    expect(acknowledgement).toMatchObject({
      code: "invalid-message",
      fatal: true,
    });
    expect(s.received.at(-1)?.result.status).toBe("failed");
    expect(JSON.stringify(s.events)).not.toContain(token);
    expect(JSON.stringify(s.events)).not.toContain("rawAudio");
  });

  it("attributes active sequence failure even after failure cleanup released its owner", async () => {
    const s = await session();
    await s.ready();
    await s.arm();
    const { acknowledgement } = await s.result({
      status: "progress",
      sequence: 99,
      nativeLifecycle: lifecycle(s),
    });
    expect(acknowledgement).toMatchObject({
      code: "sequence-replay",
      fatal: true,
    });
    await expect.poll(() => s.server.inspectListeners()).toEqual([]);
    const failure = s.events.find(
      (event) => event.name === "output.ingress.failed",
    );
    expect(failure?.attributes).toMatchObject({
      processingMessageType: "listener.result",
      processingPhase: "dispatch",
      listenerPhase: "idle",
      listenerOwnerPresent: false,
      listenerPhaseAtDispatch: "armed",
      listenerOwnerPresentAtDispatch: true,
    });
    expect(failure?.trace?.traceId).toBe(s.prepare.traceId);
    expect(s.received.at(-1)?.result.status).toBe("failed");
  });

  it("clears request attribution after ACK before a later idle timeout", async () => {
    let now = 1000;
    const s = await session("arrangement", false, {
      now: () => now,
      idleTimeoutMs: 1000,
      idleCheckIntervalMs: 5,
    });
    await s.ready();
    await s.arm();
    now += 1001;
    expect(await s.client.next()).toMatchObject({
      code: "idle-timeout",
      fatal: true,
    });
    const failure = s.events.find(
      (event) => event.name === "output.ingress.failed",
    );
    expect(failure?.attributes).toMatchObject({
      processingPhase: "idle",
      listenerPhase: "armed",
      listenerOwnerPresent: true,
    });
    expect(failure?.attributes.processingRequestId).toBeUndefined();
    expect(failure?.trace?.traceId).toBe(s.prepare.traceId);
  });

  it("attributes terminal ACK exceptions without inventing capture failure", async () => {
    const s = await session();
    await s.ready();
    await s.arm();
    const requestId = "controlled-terminal-ack";
    const token = `ghp_${"b".repeat(40)}`;
    const originalWrite: unknown = Reflect.get(Socket.prototype, "write");
    if (typeof originalWrite !== "function")
      throw new Error("Missing original socket writer");
    const spy = vi.spyOn(Socket.prototype, "write");
    let injected = 0;
    spy.mockImplementation(function (this: Socket, chunk, ...args) {
      if (
        typeof chunk === "string" &&
        chunk.includes('"type":"producer.ack"') &&
        chunk.includes(`"requestId":"${requestId}"`)
      ) {
        injected++;
        throw new Error(
          `controlled ACK exception ${token} ${"x".repeat(1000)}`,
        );
      }
      const result: unknown = Reflect.apply(originalWrite, this, [
        chunk,
        ...args,
      ]);
      if (typeof result !== "boolean")
        throw new Error("Unexpected socket write result");
      return result;
    });
    try {
      const { acknowledgement } = await s.result({
        requestId,
        status: "completed",
        observation: s.bound.observation,
        nativeSourceCoverage: s.bound.proof,
      });
      expect(acknowledgement).toMatchObject({
        code: "internal-error",
        fatal: true,
      });
      await expect.poll(() => s.server.inspectListeners()).toEqual([]);
    } finally {
      spy.mockRestore();
    }
    expect(injected).toBe(1);
    expect(s.received.map((event) => event.result.status)).toEqual([
      "progress",
      "completed",
    ]);
    const failure = s.events.find(
      (event) => event.name === "output.ingress.failed",
    )!;
    expect(failure.attributes).toMatchObject({
      processingRequestId: requestId,
      processingPhase: "ack-write",
      listenerPhase: "idle",
      listenerOwnerPresent: false,
    });
    expect(failure.trace?.traceId).toBe(s.prepare.traceId);
    expect(failure.attributes.message).toContain("[REDACTED]");
    expect(String(failure.attributes.message).length).toBeLessThanOrEqual(512);
    expect(JSON.stringify(s.events)).not.toContain(token);
    const completed = s.events.find(
      (event) =>
        event.name === "output.listener.completed" &&
        event.attributes.status === "completed",
    )!;
    expect(s.events.indexOf(completed)).toBeLessThan(s.events.indexOf(failure));
  });

  it("does not advertise or admit wire5 until explicitly enabled", async () => {
    const { server, client } = await start({
      independentMetricListeners: false,
    });
    client.send(hello(createSyntheticMetricWireFixture()));
    expect(await client.next()).toMatchObject({
      type: "producer.error",
      code: "unsupported-version",
      fatal: true,
    });
    expect(server.inspectListeners()).toEqual([]);
  });

  it.each([
    ["secret", "authentication-failed"],
    ["producer-contract", "invalid-message"],
    ["capability", "invalid-message"],
  ] as const)(
    "denies invalid %s before registering an opt-in listener",
    async (field, code) => {
      const { server, client } = await start();
      const value = hello(createSyntheticMetricWireFixture());
      client.send({
        ...value,
        ...(field === "secret" ? { secret: `${SECRET}-wrong` } : {}),
        ...(field === "producer-contract"
          ? {
              producer: {
                ...value.producer,
                schemaVersion: "audio-observation/v2",
              },
            }
          : {}),
        ...(field === "capability"
          ? {
              listener: {
                ...value.listener,
                capabilities: ["audio-listener/v1"],
              },
            }
          : {}),
      });
      expect(await client.next()).toMatchObject({
        type: "producer.error",
        code,
        fatal: true,
      });
      expect(server.inspectListeners()).toEqual([]);
    },
  );

  it.each(["arrangement", "session"] as const)(
    "publishes exact %s complete/partial outcomes after non-arming ready, arm and source proof",
    async (mode) => {
      for (const partial of [false, true]) {
        const s = await session(mode, partial);
        const results: string[] = [];
        s.server.onListenerResult((event) => {
          results.push(event.result.status);
        });
        await s.ready();
        expect(s.server.inspectListeners()[0]?.phase).toBe("ready");
        await s.arm();
        const { message, acknowledgement } = await s.result({
          status: partial ? "partial" : "completed",
          observation: s.bound.observation,
          nativeSourceCoverage: s.bound.proof,
        });
        expect(listenerResultMetricSchema.safeParse(message).success).toBe(
          true,
        );
        expect(acknowledgement).toMatchObject({ type: "producer.ack" });
        expect(results).toEqual([
          "progress",
          partial ? "partial" : "completed",
        ]);
        expect(s.server.inspectListeners()[0]?.phase).toBe("idle");
        expect(s.events.at(-1)?.name).not.toBe("output.listener.failed");
      }
    },
  );

  it("rejects a self-consistent ready proof for different admitted detector settings", async () => {
    const s = await session();
    const rejected = expect(s.preparing).rejects.toThrow();
    const ready = structuredClone(s.bound.ready);
    if (!ready.config.attacks) throw new Error("Synthetic attacks missing");
    ready.config.attacks.thresholdDb++;
    const message = {
      ...wire(s.prepare),
      type: "listener.reply",
      sequence: 0,
      status: "ready",
      nativeReady: ready,
    };
    expect(listenerReplyMetricSchema.safeParse(message).success).toBe(true);
    s.client.send(message);
    expect(await s.client.next()).toMatchObject({
      type: "producer.error",
      fatal: true,
    });
    await rejected;
    expect(
      s.events.some((event) => event.name === "output.listener.failed"),
    ).toBe(true);
    expect(s.received.at(-1)?.failureEvidence?.facts).toContainEqual({
      field: "metric.config.attackThresholdDb",
      actual: { state: "observed", value: ready.config.attacks.thresholdDb },
      expected: {
        state: "observed",
        value: s.bound.config.attacks?.thresholdDb,
      },
      comparison: "equal",
    });
  });

  it.each([
    "listenerId",
    "connectionId",
    "connectionEpoch",
    "generation",
    "passId",
    "jobId",
    "traceId",
    "correlationId",
    "causationId",
  ] as const)(
    "rejects a self-consistent ready message with foreign %s",
    async (field) => {
      const s = await session();
      const rejected = expect(s.preparing).rejects.toThrow();
      const foreignControl = listenerControlMetricSchema.parse({
        ...s.prepare,
        [field]: randomUUID(),
      });
      const foreign = bindMetricFixtureToControl(s.bound, foreignControl);
      const message = {
        ...wire(foreignControl),
        type: "listener.reply",
        sequence: 0,
        status: "ready",
        nativeReady: foreign.ready,
      };
      expect(listenerReplyMetricSchema.safeParse(message).success).toBe(true);
      s.client.send(message);
      expect(await s.client.next()).toMatchObject({
        type: "producer.error",
        fatal: true,
      });
      await rejected;
    },
  );

  it("rejects self-consistent arm evidence for a different future epoch", async () => {
    const s = await session();
    await s.ready();
    const arming = s.server.requestListenerControl(s.descriptor.connectionId, {
      ...s.input,
      action: "arm",
    });
    const rejected = expect(arming).rejects.toThrow();
    const control = listenerControlMetricSchema.parse(await s.client.next());
    const proof = structuredClone(s.bound.proof.armed);
    const epoch = ++proof.ownership.nativeEpoch;
    for (const fields of [
      proof.receipt.fields,
      proof.receipt.confirmedFields,
    ]) {
      fields[0] = epoch;
      fields[10] = epoch;
      fields[11] = epoch;
    }
    proof.receipt.timing[0] = epoch;
    proof.receipt.confirmedTiming[0] = epoch;
    const message = {
      ...wire(control),
      type: "listener.reply",
      sequence: 1,
      status: "armed",
      nativeArm: proof,
    };
    expect(listenerReplyMetricSchema.safeParse(message).success).toBe(true);
    s.client.send(message);
    expect(await s.client.next()).toMatchObject({
      type: "producer.error",
      fatal: true,
    });
    await rejected;
  });

  it("rejects a self-consistent terminal replacement of the frozen detector settings", async () => {
    const s = await session();
    await s.ready();
    await s.arm();
    const proof = structuredClone(s.bound.proof);
    const observation = structuredClone(s.bound.observation);
    if (!proof.armed.config.attacks || !observation.metrics.attacks.algorithm)
      throw new Error("Synthetic attacks missing");
    proof.armed.config.attacks.thresholdDb++;
    observation.metrics.attacks.algorithm.thresholdDb++;
    const { message, acknowledgement } = await s.result({
      status: "completed",
      observation,
      nativeSourceCoverage: proof,
    });
    expect(listenerResultMetricSchema.safeParse(message).success).toBe(true);
    expect(acknowledgement).toMatchObject({
      type: "producer.error",
      fatal: true,
    });
  });

  it("binds the admitted Arrangement source reference through ready, arm and publication", async () => {
    const s = await session("arrangement", false, {}, true);
    await s.ready();
    await s.arm();
    const proof = structuredClone(s.bound.proof);
    const observation = structuredClone(s.bound.observation);
    const context = proof.armed.config.sourceContext;
    if (
      context?.view !== "arrangement" ||
      observation.source.view !== "arrangement"
    )
      throw new Error("Synthetic Arrangement context missing");
    const other = randomUUID();
    context.target.expectedReference = other;
    observation.source.target.expectedReference = other;
    const { message, acknowledgement } = await s.result({
      status: "completed",
      observation,
      nativeSourceCoverage: proof,
    });
    expect(listenerResultMetricSchema.safeParse(message).success).toBe(true);
    expect(acknowledgement).toMatchObject({
      type: "producer.error",
      fatal: true,
    });
  });

  it.each(["arrangement", "session"] as const)(
    "publishes the frozen %s source context without inventing target metadata",
    async (mode) => {
      const s = await session(mode, true, {}, true);
      await s.ready();
      await s.arm();
      expect(
        (
          await s.result({
            status: "partial",
            observation: s.bound.observation,
            nativeSourceCoverage: s.bound.proof,
          })
        ).acknowledgement,
      ).toMatchObject({ type: "producer.ack" });
      expect(s.received.at(-1)?.result).toMatchObject({
        observation: { source: s.bound.config.sourceContext },
      });
    },
  );

  it("rejects a shape-valid publication before accepting its bound launch", async () => {
    const s = await session();
    await s.ready();
    const { acknowledgement } = await s.result({
      status: "completed",
      observation: s.bound.observation,
      nativeSourceCoverage: s.bound.proof,
    });
    expect(acknowledgement).toMatchObject({
      type: "producer.error",
      fatal: true,
    });
  });

  it.each([
    "spectral-centroid",
    "spectral-flatness",
    "spectral-spread",
    "spectral-rolloff",
  ])(
    "records %s failure separately while healthy capture continues, preserving causal identity and redaction",
    async (metric) => {
      const s = await session("arrangement", true);
      await s.ready();
      await s.arm();
      const eventId = randomUUID();
      const secret = `ghp_${"a".repeat(36)}`;
      const nativeLifecycle = {
        scope: "independent-metric-timelines/v1",
        metric,
        eventId,
        causationId: randomUUID(),
        generation: s.prepare.generation,
        nativeEpoch: s.bound.proof.armed.ownership.nativeEpoch,
        stage: "failed",
        phase: "capture",
        reason: secret,
        elapsedMs: 100,
        durationMs: 37,
        frames: 1,
      };
      expect(
        (await s.result({ status: "progress", nativeLifecycle }))
          .acknowledgement,
      ).toMatchObject({ type: "producer.ack" });
      expect(
        (await s.result({ status: "progress", nativeLifecycle }))
          .acknowledgement,
      ).toMatchObject({ type: "producer.ack" });
      const native = s.events.filter((event) => event.id === eventId);
      expect(native).toHaveLength(1);
      expect(native[0]).toMatchObject({
        name: `output.listener.native.metric.${metric}.failed`,
        outcome: "failure",
        durationMs: 37,
        trace: { traceId: s.prepare.traceId, spanId: eventId },
        correlationId: s.prepare.correlationId,
        causationId: nativeLifecycle.causationId,
      });
      expect(JSON.stringify(native)).not.toContain(secret);
      expect(
        s.events.filter(
          (event) => event.name === "output.listener.native.failed",
        ),
      ).toEqual([]);
      expect(s.server.inspectListeners()[0]?.phase).toBe("armed");
      expect(
        (
          await s.result({
            status: "partial",
            observation: s.bound.observation,
            nativeSourceCoverage: s.bound.proof,
          })
        ).acknowledgement,
      ).toMatchObject({ type: "producer.ack" });
    },
  );

  it.each([
    ["queued", "unknown"],
    ["started", "unknown"],
    ["progress", "unknown"],
    ["completed", "success"],
    ["failed", "failure"],
    ["cancelled", "cancelled"],
  ] as const)(
    "preserves scoped %s event identity and outcome without inventing a duration",
    async (stage, outcome) => {
      const s = await session();
      await s.ready();
      await s.arm();
      const nativeLifecycle = lifecycle(s, {
        stage,
        ...(["failed", "cancelled"].includes(stage)
          ? { reason: "synthetic_metric_stop" }
          : {}),
      });
      expect(
        (await s.result({ status: "progress", nativeLifecycle }))
          .acknowledgement,
      ).toMatchObject({ type: "producer.ack" });
      const native = s.events.find(
        (event) => event.id === nativeLifecycle.eventId,
      );
      expect(native).toMatchObject({
        name: `output.listener.native.metric.spectral-centroid.${stage}`,
        outcome,
        causationId: nativeLifecycle.causationId,
      });
      expect(native).not.toHaveProperty("durationMs");
      expect(s.received.at(-1)?.result.status).toBe("progress");
      expect(s.server.inspectListeners()[0]?.phase).toBe("armed");
    },
  );

  it("fails a pending prepare immediately on native shared failure without a partial context", async () => {
    const s = await session();
    const rejected = expect(s.preparing).rejects.toThrow(
      "synthetic_shared_failure",
    );
    const results: unknown[] = [];
    s.server.onListenerResult((event) => {
      results.push(event.result);
    });
    expect(
      (
        await s.result({
          status: "failed",
          reason: "synthetic_shared_failure",
        })
      ).acknowledgement,
    ).toMatchObject({ type: "producer.ack" });
    await rejected;
    expect(results).toEqual([expect.objectContaining({ status: "failed" })]);
    expect(results[0]).not.toHaveProperty("observation");
    expect(s.server.inspectListeners()[0]?.phase).toBe("idle");
  });

  it("retains a pending cancel until its reply after receiving the cancelled result", async () => {
    const s = await session();
    await s.ready();
    await s.arm();
    const cancelled = s.server.requestListenerControl(
      s.descriptor.connectionId,
      {
        ...s.input,
        action: "cancel",
      },
    );
    const control = listenerControlMetricSchema.parse(await s.client.next());
    expect(control).toMatchObject({
      action: "cancel",
      generation: s.prepare.generation,
      sequence: 2,
    });
    expect(
      (await s.result({ status: "cancelled", reason: "synthetic_cancelled" }))
        .acknowledgement,
    ).toMatchObject({ type: "producer.ack" });
    expect(s.server.inspectListeners()[0]?.phase).toBe("cancelling");
    await s.reply(control, {
      status: "cancelled",
      reason: "synthetic_cancelled",
    });
    await expect(cancelled).resolves.toMatchObject({ status: "cancelled" });
    expect(s.server.inspectListeners()[0]?.phase).toBe("idle");
    expect(
      (
        await s.result({
          status: "completed",
          observation: s.bound.observation,
          nativeSourceCoverage: s.bound.proof,
        })
      ).acknowledgement,
    ).toMatchObject({ type: "producer.error", fatal: true });
  });

  it("rejects mutation of a previously accepted native lifecycle event", async () => {
    const s = await session();
    await s.ready();
    await s.arm();
    const original = lifecycle(s);
    expect(
      (await s.result({ status: "progress", nativeLifecycle: original }))
        .acknowledgement,
    ).toMatchObject({ type: "producer.ack" });
    expect(
      (
        await s.result({
          status: "progress",
          nativeLifecycle: { ...original, frames: 2 },
        })
      ).acknowledgement,
    ).toMatchObject({ type: "producer.error", fatal: true });
    expect(
      s.events.filter((event) => event.id === original.eventId),
    ).toHaveLength(1);
  });

  it("binds pre-ready lifecycle epoch to the subsequent ready reservation", async () => {
    const s = await session();
    expect(
      (
        await s.result({
          status: "progress",
          nativeLifecycle: lifecycle(s, { nativeEpoch: 2, phase: "preflight" }),
        })
      ).acknowledgement,
    ).toMatchObject({ type: "producer.ack" });
    const rejected = expect(s.preparing).rejects.toThrow();
    s.client.send({
      ...wire(s.prepare),
      type: "listener.reply",
      sequence: 1,
      status: "ready",
      nativeReady: s.bound.ready,
    });
    expect(await s.client.next()).toMatchObject({
      type: "producer.error",
      fatal: true,
    });
    await rejected;
  });

  it("does not extend the prepare deadline when arm and progress arrive later", async () => {
    let clock = 0;
    const s = await session("arrangement", false, {
      now: () => clock,
      idleCheckIntervalMs: 5,
      idleTimeoutMs: 60_000,
    });
    const results: unknown[] = [];
    s.server.onListenerResult((event) => {
      results.push(event.result);
    });
    await s.ready();
    clock = 10_000;
    await s.arm();
    clock = 20_000;
    expect(
      (
        await s.result({
          status: "progress",
          nativeLifecycle: lifecycle(s),
        })
      ).acknowledgement,
    ).toMatchObject({ type: "producer.ack" });
    const geometry = s.bound.config.geometry;
    clock =
      20_001 + Math.ceil((geometry.totalSamples * 1000) / geometry.sampleRate);
    await expect
      .poll(() => results.at(-1), { timeout: 1000 })
      .toMatchObject({ status: "failed", reason: "capture_watchdog_timeout" });
    expect(results.at(-1)).not.toHaveProperty("observation");
  });

  it("bounds native metric facts and preserves unavailable values instead of inventing zero", async () => {
    const s = await session();
    await s.ready();
    await s.arm();
    const nativeLifecycle = lifecycle(s, {
      facts: [
        {
          field: "spectrum.acknowledged",
          actual: { state: "unavailable", reason: "not-reported" },
          unit: "count",
        },
      ],
    });
    expect(nativeLifecycle.facts).toHaveLength(1);
    expect(
      nativeMetricLifecycleSchema.safeParse({
        ...nativeLifecycle,
        facts: Array.from({ length: 25 }, () => nativeLifecycle.facts?.[0]),
      }).success,
    ).toBe(false);
    expect(
      nativeMetricLifecycleSchema.safeParse({
        ...nativeLifecycle,
        facts: [
          {
            field: "source.counter",
            actual: { state: "observed", value: NaN },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      (await s.result({ status: "progress", nativeLifecycle })).acknowledgement,
    ).toMatchObject({ type: "producer.ack" });
    expect(
      s.events.find((event) => event.id === nativeLifecycle.eventId)
        ?.attributes,
    ).toMatchObject({ lifecycle: { facts: nativeLifecycle.facts } });
  });

  it.each([
    "spectral-centroid",
    "spectral-flatness",
    "spectral-spread",
    "spectral-rolloff",
  ] as const)(
    "persists %s stage causation, duration, redaction and deduplication through typed journal reads",
    async (metric) => {
      const { journal, recorder, failures } =
        await createIngressJournalFixture(resources);
      const s = await session("arrangement", true, { telemetry: recorder });
      await s.ready();
      await s.arm();
      const secret = `ghp_${"a".repeat(36)}`;
      const queued = lifecycle(s, {
        metric,
        stage: "queued",
        phase: "capture",
      });
      const started = lifecycle(s, {
        metric,
        stage: "started",
        causationId: queued.eventId,
      });
      const failed = lifecycle(s, {
        metric,
        stage: "failed",
        causationId: started.eventId,
        reason: secret,
        durationMs: 17,
        facts: [
          {
            field: `${metric}.deliveries`,
            actual: { state: "observed", value: 1 },
            expected: {
              state: "observed",
              value:
                s.bound.observation.metrics["spectral-centroid"]
                  .expectedRecords,
            },
            comparison: "equal",
            unit: "count",
          },
        ],
      });
      for (const nativeLifecycle of [queued, started, failed, failed])
        expect(
          (await s.result({ status: "progress", nativeLifecycle }))
            .acknowledgement,
        ).toMatchObject({ type: "producer.ack" });
      expect(
        (
          await s.result({
            status: "partial",
            observation: s.bound.observation,
            nativeSourceCoverage: s.bound.proof,
          })
        ).acknowledgement,
      ).toMatchObject({ type: "producer.ack" });
      const read = async () =>
        (
          await journal.readEvents({
            traceId: s.prepare.traceId,
            limit: 100,
          })
        ).items.filter((event) =>
          event.name.startsWith("output.listener.native.metric."),
        );
      await expect.poll(async () => (await read()).length).toBe(3);
      const saved = await read();
      for (const original of [queued, started, failed]) {
        const event = saved.find(
          (candidate) => candidate.id === original.eventId,
        );
        expect(event).toMatchObject({
          causationId: original.causationId,
          correlationId: s.prepare.correlationId,
          trace: { traceId: s.prepare.traceId, spanId: original.eventId },
        });
        expect(event?.attributes.generation).toBe(s.prepare.generation);
        expect(event?.attributes.passId).toBe(s.prepare.passId);
        expect(event?.attributes.instanceId).toBe(
          s.descriptor.producer.instanceId,
        );
        expect(event?.attributes.producerId).toBe(
          s.descriptor.producer.producerId,
        );
      }
      expect(
        saved.find((event) => event.id === failed.eventId)?.durationMs,
      ).toBe(17);
      expect(
        saved.find((event) => event.id === failed.eventId)?.attributes,
      ).toMatchObject({
        lifecycle: { facts: failed.facts },
      });
      expect(
        saved.find((event) => event.id === started.eventId),
      ).not.toHaveProperty("durationMs");
      expect(JSON.stringify(saved)).not.toContain(secret);
      expect(failures).toEqual([]);
    },
  );

  it("treats authenticated transport backpressure as a shared failure rather than a partial result", async () => {
    const s = await session("arrangement", false, {
      maxOutstandingMessages: 1,
    });
    await s.ready();
    await s.arm();
    s.client.sendBatch(
      Array.from({ length: 16 }, (_, index) =>
        listenerResultMetricSchema.parse({
          ...wire(s.prepare),
          type: "listener.result",
          status: "progress",
          sequence: index + 3,
          requestId: randomUUID(),
          nativeLifecycle: lifecycle(s),
        }),
      ),
    );
    await expect.poll(() => s.received.at(-1)?.result.status).toBe("failed");
    expect(s.received.at(-1)?.result).toMatchObject({ reason: "backpressure" });
    expect(s.received.at(-1)?.result).not.toHaveProperty("observation");
  });

  it("reports disconnection after launch as failed without salvaging an observation", async () => {
    const s = await session();
    await s.ready();
    await s.arm();
    s.client.close();
    await expect.poll(() => s.received.at(-1)?.result.status).toBe("failed");
    expect(s.received.at(-1)?.result).toMatchObject({ reason: "disconnected" });
    expect(s.received.at(-1)?.result).not.toHaveProperty("observation");
    await expect.poll(() => s.server.inspectListeners()).toEqual([]);
  });

  it("fails and releases pending cancel when native cleanup is uncertain", async () => {
    const s = await session();
    await s.ready();
    await s.arm();
    const cancelling = s.server.requestListenerControl(
      s.descriptor.connectionId,
      {
        ...s.input,
        action: "cancel",
      },
    );
    const rejected = expect(cancelling).rejects.toThrow("cleanup_uncertain");
    expect(
      listenerControlMetricSchema.parse(await s.client.next()).action,
    ).toBe("cancel");
    expect(
      (await s.result({ status: "failed", reason: "cleanup_uncertain" }))
        .acknowledgement,
    ).toMatchObject({ type: "producer.ack" });
    await rejected;
    expect(s.server.inspectListeners()[0]?.phase).toBe("idle");
    expect(s.received.at(-1)?.result).not.toHaveProperty("observation");
  });

  it("retains epoch and counter replay fences after terminal release", async () => {
    const s = await session();
    await s.ready();
    await s.arm();
    await s.result({
      status: "completed",
      observation: s.bound.observation,
      nativeSourceCoverage: s.bound.proof,
    });
    const preparing = s.server.requestListenerControl(
      s.descriptor.connectionId,
      {
        ...s.input,
        passId: randomUUID(),
        action: "prepare",
        config: s.bound.config,
      },
    );
    const rejected = expect(preparing).rejects.toThrow();
    const control = listenerControlMetricSchema.parse(await s.client.next());
    expect(control.generation).not.toBe(s.prepare.generation);
    const stale = bindMetricFixtureToControl(s.bound, control);
    s.client.send(
      listenerReplyMetricSchema.parse({
        ...wire(control),
        type: "listener.reply",
        sequence: 4,
        status: "ready",
        nativeReady: stale.ready,
      }),
    );
    expect(await s.client.next()).toMatchObject({
      type: "producer.error",
      fatal: true,
    });
    await rejected;
    expect(s.received.at(-1)?.failureEvidence?.facts).toContainEqual({
      field: "metric.nativeEpoch",
      actual: { state: "observed", value: 1 },
      expected: { state: "observed", value: 2 },
      comparison: "at-least",
    });
  });
});
