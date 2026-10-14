import { connect, type Socket } from "node:net";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import type { AudioObservation } from "@ableton-agent/protocol";
import { NATIVE_LISTENER_SCOPE } from "@ableton-agent/protocol";
import { createSyntheticNativeListeningFixture } from "@ableton-agent/protocol/testing";
import type { TelemetryEventEnvelope } from "@ableton-agent/observability";
import { SignalIngressServer } from "./ingress-server.js";
import { InMemoryConnectionRegistry } from "./registry.js";
import { SignalRouter } from "./router.js";
import type {
  ListenerControl,
  ListenerControlInput,
  ListenerReply,
  ListenerResult,
  ListenerResultEvent,
} from "./listener-contracts.js";
import { midiSample } from "./test-fixtures.js";

const require = createRequire(import.meta.url);
interface CommonProducerClient {
  readonly producer: { producerId: string };
  configureProducer(identity: {
    canonicalPath: string;
    track: { id: string; name: string };
    device: { id: string; name: string };
  }): void;
  start(): void;
  stop(): void;
  isConnected(): boolean;
  sendSample(sample: unknown, capturedAt: number): boolean;
  sendListenerReply(
    control: ListenerControl,
    reply: Pick<ListenerReply, "status">,
  ): boolean;
  sendListenerResult(
    control: ListenerControl,
    result: Pick<ListenerResult, "status" | "observation">,
  ): boolean;
}
const { AgentSignalClient } =
  require("../../../max-patches/shared/agent_signal_client.js") as {
    AgentSignalClient: new (
      options: Record<string, unknown>,
    ) => CommonProducerClient;
  };
const secret = "shared-listener-test-secret-at-least-32-chars";
const servers: SignalIngressServer[] = [];
const sockets: Socket[] = [];
const clients: Array<{ stop(): void }> = [];
afterEach(async () => {
  for (const client of clients.splice(0)) client.stop();
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

const input: ListenerControlInput = {
  action: "prepare",
  jobId: "job",
  passId: "pass",
  traceId: "trace",
  correlationId: "correlation",
  causationId: "cause",
  config: {
    durationMs: 1000,
    maxWindows: 8,
    source: { mode: "session", startBeat: 0, endBeat: 2 },
  },
};
function observation(listenerId = "audio"): AudioObservation {
  return {
    schema: "audio-observation/v1",
    listenerId,
    passId: "pass",
    sampleRate: 48000,
    startSample: 0,
    endSample: 48000,
    startBeat: 0,
    endBeat: 2,
    complete: true,
    limitations: [],
    algorithm: {
      name: "native",
      version: "native/v1",
      windowSamples: 1024,
      hopSamples: 512,
      settings: { attackThresholdDb: 6, minAttackSpacingSamples: 100 },
      units: { amplitude: "linear", rms: "dBFS", centroid: "Hz" },
      timingUncertaintySamples: 512,
    },
    summaries: { peak: [0.5, 0.5], rmsDbfs: [-12, -12], centroidHz: 1000 },
    samples: [],
    attacks: [],
    reduction: { originalSamples: 0, originalAttacks: 0, truncated: false },
  };
}

async function start(
  overrides: Partial<ConstructorParameters<typeof SignalIngressServer>[0]> = {},
) {
  const registry = new InMemoryConnectionRegistry({ staleAfterMs: 15000 });
  const server = new SignalIngressServer({
    secret,
    registry,
    router: new SignalRouter({ registry }),
    port: 0,
    ...overrides,
  });
  servers.push(server);
  return { server, registry, endpoint: await server.start() };
}

async function raw(endpoint: { host: string; port: number }) {
  const socket = connect(endpoint.port, endpoint.host);
  sockets.push(socket);
  const queue: Record<string, unknown>[] = [];
  const waiters: Array<(value: Record<string, unknown>) => void> = [];
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const value = JSON.parse(buffer.slice(0, newline)) as Record<
        string,
        unknown
      >;
      buffer = buffer.slice(newline + 1);
      const waiter = waiters.shift();
      if (waiter) waiter(value);
      else queue.push(value);
      newline = buffer.indexOf("\n");
    }
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  return {
    socket,
    send(value: object) {
      socket.write(`${JSON.stringify(value)}\n`);
    },
    next(): Promise<Record<string, unknown>> {
      const item = queue.shift();
      if (item) return Promise.resolve(item);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Response timeout")),
          1500,
        );
        waiters.push((value) => {
          clearTimeout(timer);
          resolve(value);
        });
      });
    },
  };
}

const readyModelMetadata = {
  deviceCanonicalPath: "live_set tracks 0 devices 0",
  trackCanonicalPath: "live_set tracks 0",
  // Transport model only: this report is not a native timing certificate.
  nativeStatus: { version: 1, timing: "VERIFIED", readiness: "READY" },
};
async function listener(
  endpoint: { host: string; port: number },
  metadata: object = readyModelMetadata,
) {
  const client = await raw(endpoint);
  client.send({
    type: "producer.hello",
    protocolVersion: 1,
    requestId: "hello",
    secret,
    producer: {
      producerId: "audio",
      instanceId: "audio-instance",
      displayName: "Listener",
      signalKind: "audio",
      schemaVersion: "audio-observation/v1",
      track: { id: "17", name: "Audio" },
      device: { id: "29", name: "Listener" },
    },
    listener: {
      version: 1,
      connectionEpoch: "epoch",
      capabilities: ["audio-listener/v1"],
      sampleRate: 48000,
      algorithmVersion: "native/v1",
      ...metadata,
    },
  });
  const ack = await client.next();
  expect(ack.type).toBe("producer.ack");
  return { ...client, connectionId: ack.connectionId as string };
}

function reply(control: ListenerControl, sequence: number, status: string) {
  return {
    type: "listener.reply",
    protocolVersion: 1,
    listenerVersion: 1,
    requestId: control.requestId,
    connectionEpoch: control.connectionEpoch,
    jobId: control.jobId,
    passId: control.passId,
    traceId: control.traceId,
    correlationId: control.correlationId,
    causationId: control.causationId,
    sequence,
    status,
  };
}
function result(
  control: ListenerControl,
  sequence: number,
  overrides: object = {},
) {
  return {
    ...reply(control, sequence, "completed"),
    type: "listener.result",
    requestId: `result-${sequence}`,
    sequence,
    status: "completed",
    observation: observation(),
    ...overrides,
  };
}
async function prepareAndArm(
  server: SignalIngressServer,
  client: Awaited<ReturnType<typeof listener>>,
) {
  const pending = server.requestListenerControl(client.connectionId, input);
  const prepare = (await client.next()) as unknown as ListenerControl;
  client.send(reply(prepare, 0, "ready"));
  expect((await pending).status).toBe("ready");
  await client.next();
  const armed = server.requestListenerControl(client.connectionId, {
    ...input,
    action: "arm",
  });
  const arm = (await client.next()) as unknown as ListenerControl;
  client.send(reply(arm, 1, "armed"));
  expect((await armed).status).toBe("armed");
  await client.next();
  return arm;
}

describe("shared authenticated listener ingress", () => {
  it("retains bounded native evidence and namespaced causal lifecycle through the existing authenticated channel", async () => {
    const events: TelemetryEventEnvelope[] = [];
    const { server, endpoint } = await start({
      telemetry: {
        enqueue(event) {
          events.push(event);
          return true;
        },
      },
    });
    const client = await listener(endpoint, {
      ...readyModelMetadata,
      nativeStatus: {
        ...readyModelMetadata.nativeStatus,
        timing: "UNVERIFIED",
        readiness: "BLOCKED",
        reason: "native_per_pass_validation_required",
        scope: NATIVE_LISTENER_SCOPE,
      },
    });
    const fixture = createSyntheticNativeListeningFixture({
      listenerId: "audio",
      algorithmVersion: "native/v1",
    });
    const context = {
      ...input,
      traceId: "11111111-1111-4111-8111-111111111111",
      causationId: "password=synthetic-value",
      config: {
        durationMs: 2000,
        maxWindows: 20,
        source: { mode: "arrangement" as const, startBeat: 0, endBeat: 4 },
      },
    };
    const preparing = server.requestListenerControl(
      client.connectionId,
      context,
    );
    void preparing.catch(() => {});
    const prepare = (await client.next()) as unknown as ListenerControl;
    client.send(reply(prepare, 0, "ready"));
    await preparing;
    await client.next();
    const arming = server.requestListenerControl(client.connectionId, {
      ...context,
      action: "arm",
    });
    const arm = (await client.next()) as unknown as ListenerControl;
    client.send({ ...reply(arm, 1, "armed"), nativeArm: fixture.proof.armed });
    await arming;
    await client.next();
    const firstId = "44444444-4444-4444-8444-444444444444";
    const secondId = "55555555-5555-4555-8555-555555555555";
    client.send(
      result(arm, 2, {
        status: "progress",
        observation: undefined,
        nativeLifecycle: {
          eventId: firstId,
          causationId: context.causationId,
          stage: "queued",
          phase: "preflight",
          generation: "66666666-6666-4666-8666-666666666666",
          nativeEpoch: 1,
          elapsedMs: 0,
          frames: 0,
        },
      }),
    );
    expect((await client.next()).type).toBe("producer.ack");
    client.send(
      result(arm, 3, {
        status: "progress",
        observation: undefined,
        nativeLifecycle: {
          eventId: secondId,
          causationId: firstId,
          stage: "started",
          phase: "capture",
          generation: "66666666-6666-4666-8666-666666666666",
          nativeEpoch: 1,
          elapsedMs: 12,
          frames: 0,
        },
      }),
    );
    expect((await client.next()).type).toBe("producer.ack");
    client.send(
      result(arm, 4, {
        status: "progress",
        observation: undefined,
        nativeLaunch: fixture.proof.launched,
      }),
    );
    expect((await client.next()).type).toBe("producer.ack");
    client.send(
      result(arm, 5, {
        observation: fixture.observation,
        nativeCapture: fixture.proof,
      }),
    );
    expect((await client.next()).type).toBe("producer.ack");
    const native = events.filter((event) =>
      event.name.startsWith("output.listener.native."),
    );
    expect(
      server.inspectListeners()[0]!.registration.nativeStatus,
    ).toMatchObject({
      timing: "UNVERIFIED",
      readiness: "BLOCKED",
      scope: NATIVE_LISTENER_SCOPE,
    });
    expect(native.map((event) => event.name)).toEqual([
      "output.listener.native.preflight.queued",
      "output.listener.native.started",
    ]);
    expect(native[0]!.id).not.toBe(firstId);
    expect(native[1]!.causationId).toBe(native[0]!.id);
    expect(native[1]).toMatchObject({
      trace: { traceId: context.traceId },
      durationMs: 12,
      attributes: {
        passId: "pass",
        producerId: "audio",
        instanceId: "audio-instance",
        nativeEpoch: 1,
        phase: "capture",
        generation: "66666666-6666-4666-8666-666666666666",
      },
    });
    expect(
      events.find((event) => event.attributes.nativeArm !== undefined)
        ?.attributes.nativeArm,
    ).toEqual(fixture.proof.armed);
    expect(
      events.find((event) => event.attributes.nativeCapture !== undefined)
        ?.attributes.nativeCapture,
    ).toEqual(fixture.proof);
    expect(JSON.stringify(events)).not.toContain("synthetic-value");
    expect(server.inspectListeners()[0]!.phase).toBe("idle");
  });
  it("accepts legacy registration as connected but denies prepare with no metadata", async () => {
    const events: TelemetryEventEnvelope[] = [];
    const { server, endpoint } = await start({
      telemetry: {
        enqueue(event) {
          events.push(event);
          return true;
        },
      },
    });
    const client = await listener(endpoint, {});
    expect(server.inspectListeners()[0]!.phase).toBe("idle");
    await expect(
      server.requestListenerControl(client.connectionId, input, {
        timeoutMs: 50,
      }),
    ).rejects.toThrow("listener_metadata_missing");
    expect(server.inspectListeners()[0]!.passId).toBeUndefined();
    const denial = events.find(
      (event) => event.name === "output.listener.denied",
    );
    expect(denial).toMatchObject({
      name: "output.listener.denied",
      correlationId: input.correlationId,
      causationId: input.causationId,
      trace: { traceId: input.traceId },
      attributes: {
        connectionId: client.connectionId,
        passId: input.passId,
        reason: "listener_metadata_missing",
      },
    });
  });
  it("accepts actual native hello paths/status without treating connected BLOCKED as ready", async () => {
    const { server, endpoint } = await start();
    const nativeStatus = {
      version: 1,
      timing: "UNVERIFIED",
      readiness: "BLOCKED",
      reason: "real_live_timing_validation_required",
    };
    const client = await listener(endpoint, {
      deviceCanonicalPath: "live_set tracks 0 devices 0",
      trackCanonicalPath: "live_set tracks 0",
      nativeStatus,
    });
    expect(server.inspectListeners()[0]!.registration.nativeStatus).toEqual(
      nativeStatus,
    );
    await expect(
      server.requestListenerControl(client.connectionId, input),
    ).rejects.toThrow("real_live_timing_validation_required");
    expect(server.inspectListeners()[0]!.phase).toBe("idle");
    expect(server.inspectListeners()[0]!.jobId).toBeUndefined();
  });
  it("runs extracted MIDI and audio clients together without schema or ownership cross-delivery", async () => {
    const { server, registry, endpoint } = await start();
    const results: ListenerResultEvent[] = [];
    server.onListenerResult((event) => results.push(event));
    const descriptor = {
      ...endpoint,
      protocol: "newline-delimited-json",
      protocolVersion: 1,
      maxFrameBytes: 128 * 1024,
      listenerVersions: [1],
      listenerCapabilities: ["audio-listener/v1"],
    };
    const midi = new AgentSignalClient({
      secret,
      instanceId: "midi",
      readText: async () => JSON.stringify(descriptor),
    });
    midi.configureProducer({
      canonicalPath: "live_set tracks 0 devices 0",
      track: { id: "1", name: "MIDI" },
      device: { id: "2", name: "Midi-Capture" },
    });
    const audio = new AgentSignalClient({
      secret,
      descriptorPath: "isolated-fixture-descriptor.json",
      signalKind: "audio",
      schemaVersion: "audio-observation/v1",
      producerIdPrefix: "ableton-audio-listener",
      instanceId: "audio",
      readText: async () => JSON.stringify(descriptor),
      listener: {
        version: 1,
        capabilities: ["audio-listener/v1"],
        sampleRate: 48000,
        algorithmVersion: "native/v1",
        ...readyModelMetadata,
        deviceCanonicalPath: "live_set tracks 1 devices 0",
        trackCanonicalPath: "live_set tracks 1",
      },
      onListenerControl(control: ListenerControl) {
        audio.sendListenerReply(control, {
          status:
            control.action === "prepare"
              ? "ready"
              : control.action === "arm"
                ? "armed"
                : "cancelled",
        });
        if (control.action === "arm")
          audio.sendListenerResult(control, {
            status: "completed",
            observation: observation(audio.producer.producerId),
          });
      },
    });
    audio.configureProducer({
      canonicalPath: "live_set tracks 1 devices 0",
      track: { id: "3", name: "Audio" },
      device: { id: "4", name: "Listener" },
    });
    clients.push(midi, audio);
    midi.start();
    audio.start();
    await expect
      .poll(() => midi.isConnected() && audio.isConnected())
      .toBe(true);
    expect(server.inspectListeners()).toHaveLength(1);
    expect(server.inspectListeners()[0]!.binding).toEqual({
      trackId: "3",
      deviceId: "4",
    });
    const connectionId = server.inspectListeners()[0]!.connectionId;
    midi.sendSample(midiSample, 1000);
    await server.requestListenerControl(connectionId, input);
    await server.requestListenerControl(connectionId, {
      ...input,
      action: "arm",
    });
    await expect.poll(() => results.length).toBe(1);
    expect(results[0]!.result.observation?.complete).toBe(true);
    expect(results[0]!.producer.signalKind).toBe("audio");
    expect(results[0]!.binding).toEqual({ trackId: "3", deviceId: "4" });
    expect(results[0]!.result.traceId).toBe("trace");
    expect(registry.list()).toHaveLength(2);
    expect(server.inspectListeners()[0]!.phase).toBe("idle");
  });

  it("guards control ownership, readiness, failed prepare, and cancellation", async () => {
    const { server, endpoint } = await start();
    const client = await listener(endpoint);
    await expect(
      server.requestListenerControl(client.connectionId, {
        ...input,
        action: "arm",
      }),
    ).rejects.toThrow("ownership");
    const prepared = server.requestListenerControl(client.connectionId, input);
    const control = (await client.next()) as unknown as ListenerControl;
    await expect(
      server.requestListenerControl(client.connectionId, input),
    ).rejects.toThrow("owned");
    client.send(reply(control, 0, "failed"));
    expect((await prepared).status).toBe("failed");
    await client.next();
    expect(server.inspectListeners()[0]!.phase).toBe("idle");
    const retry = server.requestListenerControl(client.connectionId, input);
    const retried = (await client.next()) as unknown as ListenerControl;
    client.send(reply(retried, 1, "ready"));
    await retry;
    await client.next();
    await expect(
      server.requestListenerControl(client.connectionId, {
        ...input,
        action: "cancel",
        jobId: "other",
      }),
    ).rejects.toThrow("ownership");
    const cancelled = server.requestListenerControl(client.connectionId, {
      ...input,
      action: "cancel",
    });
    const cancel = (await client.next()) as unknown as ListenerControl;
    client.send(reply(cancel, 2, "cancelled"));
    expect((await cancelled).status).toBe("cancelled");
    expect(server.inspectListeners()[0]!.phase).toBe("idle");
  });

  it.each([
    ["stale epoch", { connectionEpoch: "stale" }],
    ["forged correlation", { correlationId: "another-correlation" }],
    ["forged causation", { causationId: "another-cause" }],
    ["sequence gap", { sequence: 9 }],
    [
      "forged observation owner",
      { observation: observation("another-listener") },
    ],
    ["forged pass", { passId: "another-pass" }],
    [
      "incomplete success",
      { observation: { ...observation(), complete: false } },
    ],
    [
      "short complete coverage",
      { observation: { ...observation(), endBeat: 1 } },
    ],
  ])(
    "rejects %s with explicit partial failure, not complete publication",
    async (_label, overrides) => {
      const { server, endpoint } = await start();
      const results: ListenerResultEvent[] = [];
      server.onListenerResult((event) => results.push(event));
      const client = await listener(endpoint);
      const arm = await prepareAndArm(server, client);
      client.send(result(arm, 2, overrides));
      expect((await client.next()).type).toBe("producer.error");
      await expect.poll(() => results.length).toBe(1);
      expect(results[0]!.result.status).toBe("partial");
      expect(results[0]!.result.observation).toBeUndefined();
      expect(results[0]!.result.traceId).toBe("trace");
    },
  );

  it("times out and aborts controls, emitting correlated bounded failure lifecycle", async () => {
    const events: Array<{
      name: string;
      durationMs?: number | undefined;
      correlationId?: string | undefined;
    }> = [];
    const { server, endpoint } = await start({
      telemetry: {
        enqueue(event) {
          events.push(event);
          return true;
        },
      },
    });
    const results: ListenerResultEvent[] = [];
    server.onListenerResult((event) => results.push(event));
    const client = await listener(endpoint);
    await expect(
      server.requestListenerControl(client.connectionId, input, {
        timeoutMs: 15,
      }),
    ).rejects.toThrow("timed out");
    await expect.poll(() => results.length).toBe(1);
    expect(events.map((event) => event.name)).toEqual(
      expect.arrayContaining([
        "output.listener.queued",
        "output.listener.started",
        "output.listener.failed",
      ]),
    );
    expect(
      events.find((event) => event.name === "output.listener.failed")
        ?.durationMs,
    ).toBeGreaterThanOrEqual(0);
    await expect.poll(() => server.inspectListeners().length).toBe(0);
    const next = await listener(endpoint);
    const abort = new AbortController();
    const pending = server.requestListenerControl(next.connectionId, input, {
      signal: abort.signal,
    });
    await next.next();
    abort.abort();
    await expect(pending).rejects.toThrow("cancelled");
    expect(events.map((event) => event.name)).toContain(
      "output.listener.cancelled",
    );
  });

  it("does not discover unauthenticated or non-negotiated listeners", async () => {
    const { server, endpoint } = await start();
    const client = await raw(endpoint);
    client.send({
      type: "producer.hello",
      protocolVersion: 1,
      requestId: "hello",
      secret: `${secret}-wrong`,
      producer: {
        producerId: "audio",
        instanceId: "audio",
        displayName: "Listener",
        signalKind: "audio",
        schemaVersion: "audio-observation/v1",
      },
    });
    expect((await client.next()).code).toBe("authentication-failed");
    expect(server.inspectListeners()).toEqual([]);
    const noCapability = await raw(endpoint);
    noCapability.send({
      type: "producer.hello",
      protocolVersion: 1,
      requestId: "hello",
      secret,
      producer: {
        producerId: "audio",
        instanceId: "audio",
        displayName: "Listener",
        signalKind: "audio",
        schemaVersion: "audio-observation/v1",
      },
    });
    expect((await noCapability.next()).code).toBe("invalid-message");
    expect(server.inspectListeners()).toEqual([]);
    const noBinding = await raw(endpoint);
    noBinding.send({
      type: "producer.hello",
      protocolVersion: 1,
      requestId: "hello",
      secret,
      producer: {
        producerId: "audio",
        instanceId: "audio",
        displayName: "Listener",
        signalKind: "audio",
        schemaVersion: "audio-observation/v1",
      },
      listener: {
        version: 1,
        connectionEpoch: "epoch",
        capabilities: ["audio-listener/v1"],
        sampleRate: 48000,
        algorithmVersion: "native/v1",
      },
    });
    expect((await noBinding.next()).code).toBe("invalid-message");
    expect(server.inspectListeners()).toEqual([]);
  });

  it("fails armed captures on disconnect and shutdown; unsubscribe prevents callbacks", async () => {
    const { server, endpoint } = await start();
    const results: ListenerResultEvent[] = [];
    const unsubscribe = server.onListenerResult((event) => results.push(event));
    const client = await listener(endpoint);
    await prepareAndArm(server, client);
    client.socket.destroy();
    await expect.poll(() => results.length).toBe(1);
    expect(results[0]!.result.reason).toBe("disconnected");
    unsubscribe();
    const next = await listener(endpoint);
    const pending = server.requestListenerControl(next.connectionId, input);
    await next.next();
    const rejected = expect(pending).rejects.toThrow("stopped");
    await server.stop();
    await rejected;
    expect(results).toHaveLength(1);
  });

  it.each(["backpressure", "frame-too-large"])(
    "reports %s as partial audio failure",
    async (failure) => {
      const { server, endpoint } = await start({
        maxOutstandingMessages: 1,
        maxFrameBytes: 2048,
      });
      const results: ListenerResultEvent[] = [];
      server.onListenerResult((event) => results.push(event));
      const client = await listener(endpoint);
      const arm = await prepareAndArm(server, client);
      if (failure === "frame-too-large") {
        client.send({ ...result(arm, 2), reason: "x".repeat(3000) });
      } else {
        const progress = result(arm, 2, {
          status: "progress",
          observation: undefined,
        });
        client.socket.write(
          `${JSON.stringify(progress)}\n${JSON.stringify({ ...progress, requestId: "another", sequence: 3 })}\n`,
        );
      }
      expect((await client.next()).code).toBe(failure);
      expect(results).toHaveLength(1);
      expect(results[0]!.result).toMatchObject({
        status: "partial",
        reason: failure,
      });
    },
  );

  it("watchdogs a hung armed producer even if the socket remains alive", async () => {
    let now = 1000;
    const { server, endpoint } = await start({
      now: () => now,
      idleTimeoutMs: 100000,
      idleCheckIntervalMs: 5,
    });
    const results: ListenerResultEvent[] = [];
    server.onListenerResult((event) => results.push(event));
    const client = await listener(endpoint);
    await prepareAndArm(server, client);
    now += 6001;
    await expect.poll(() => results.length).toBe(1);
    expect(results[0]!.result).toMatchObject({
      status: "partial",
      reason: "capture_watchdog_timeout",
    });
    await expect.poll(() => server.inspectListeners().length).toBe(0);
  });

  it("redacts credential-bearing failure reasons before typed callbacks and journal events", async () => {
    const telemetry: string[] = [];
    const { server, endpoint } = await start({
      telemetry: {
        enqueue(event) {
          telemetry.push(JSON.stringify(event));
          return true;
        },
      },
    });
    const results: ListenerResultEvent[] = [];
    server.onListenerResult((event) => results.push(event));
    const client = await listener(endpoint);
    const arm = await prepareAndArm(server, client);
    client.send(
      result(arm, 2, {
        status: "failed",
        observation: undefined,
        reason: "Bearer private-listener-token",
      }),
    );
    await client.next();
    expect(results[0]!.result.reason).toContain("[REDACTED]");
    expect(JSON.stringify(results)).not.toContain("private-listener-token");
    expect(telemetry.join("\n")).not.toContain("private-listener-token");
    expect(telemetry.join("\n")).toContain("output.listener.failed");
  });
});
