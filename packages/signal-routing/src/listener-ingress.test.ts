import { connect, Socket } from "node:net";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AudioObservation } from "@ableton-agent/protocol";
import {
  NATIVE_LISTENER_SCOPE,
  NATIVE_LISTENER_SCOPE_V2,
} from "@ableton-agent/protocol";
import {
  createSyntheticNativeListeningFixture,
  createSyntheticNativeListeningFixtureV2,
} from "@ableton-agent/protocol/testing";
import type { TelemetryEventEnvelope } from "@ableton-agent/observability";
import { SignalIngressServer } from "./ingress-server.js";
import { InMemoryConnectionRegistry } from "./registry.js";
import { SignalRouter } from "./router.js";
import type {
  ListenerControl,
  ListenerControlInput,
  ListenerResultEvent,
} from "./listener-contracts.js";
import {
  listenerControlV2Schema,
  type NativeFailureDiagnosticV2,
  type VersionedListenerControl,
  type VersionedListenerReply,
  type VersionedListenerResult,
} from "./listener-v2-contracts.js";
import { midiSample } from "./test-fixtures.js";

const require = createRequire(import.meta.url);
interface CommonProducerClient {
  readonly producer: { producerId: string };
  readonly pending: ReadonlyMap<string, string>;
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
    control: VersionedListenerControl,
    reply: Pick<VersionedListenerReply, "status" | "nativeArm" | "reason">,
  ): boolean;
  sendListenerResult(
    control: VersionedListenerControl,
    result: Pick<
      VersionedListenerResult,
      "status" | "observation" | "nativeLaunch" | "nativeCapture" | "reason"
    >,
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
function listenerHello(
  metadata: object = readyModelMetadata,
  version: 1 | 2 = 1,
) {
  return {
    type: "producer.hello",
    protocolVersion: 1,
    requestId: "hello",
    secret,
    producer: {
      producerId: "audio",
      instanceId: "audio-instance",
      displayName: "Listener",
      signalKind: "audio",
      schemaVersion: `audio-observation/v${version}`,
      track: { id: "17", name: "Audio" },
      device: { id: "29", name: "Listener" },
    },
    listener: {
      version,
      connectionEpoch: "epoch",
      capabilities: [`audio-listener/v${version}`],
      sampleRate: 48000,
      algorithmVersion: version === 2 ? "2.0.0" : "native/v1",
      ...metadata,
    },
  };
}
async function listener(
  endpoint: { host: string; port: number },
  metadata: object = readyModelMetadata,
  version: 1 | 2 = 1,
) {
  const client = await raw(endpoint);
  client.send(listenerHello(metadata, version));
  const ack = await client.next();
  expect(ack.type).toBe("producer.ack");
  return { ...client, connectionId: ack.connectionId as string };
}

function reply(
  control: VersionedListenerControl,
  sequence: number,
  status: string,
) {
  return {
    type: "listener.reply",
    protocolVersion: 1,
    listenerVersion: control.listenerVersion,
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
  control: VersionedListenerControl,
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

const nativeV2Metadata = {
  ...readyModelMetadata,
  vectorSize: 64,
  nativeStatus: {
    version: 2,
    scope: NATIVE_LISTENER_SCOPE_V2,
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
  },
};
function v2Context() {
  const { armed } = createSyntheticNativeListeningFixtureV2().proof;
  return {
    ...input,
    traceId: "11111111-1111-4111-8111-111111111111",
    causationId: "v2-capture-parent",
    config: { geometry: armed.geometry, timingPolicy: armed.policy },
  };
}
async function prepareV2(
  server: SignalIngressServer,
  client: Awaited<ReturnType<typeof listener>>,
  sequence = 0,
  context = v2Context(),
) {
  const pending = server.requestListenerControl(client.connectionId, context);
  void pending.catch(() => {});
  const control = listenerControlV2Schema.parse(await client.next());
  client.send(reply(control, sequence, "ready"));
  expect((await pending).status).toBe("ready");
  expect((await client.next()).type).toBe("producer.ack");
  return control;
}
async function beginArmV2(
  server: SignalIngressServer,
  client: Awaited<ReturnType<typeof listener>>,
) {
  const { config, ...context } = v2Context();
  expect(config.geometry.totalSamples).toBe(96_000);
  const pending = server.requestListenerControl(client.connectionId, {
    ...context,
    action: "arm",
  });
  void pending.catch(() => {});
  return {
    pending,
    control: listenerControlV2Schema.parse(await client.next()),
  };
}
async function armedV2(
  server: SignalIngressServer,
  client: Awaited<ReturnType<typeof listener>>,
) {
  await prepareV2(server, client);
  const fixture = createSyntheticNativeListeningFixtureV2({
    listenerId: "audio",
  });
  const { control, pending } = await beginArmV2(server, client);
  client.send({
    ...reply(control, 1, "armed"),
    nativeArm: fixture.proof.armed,
  });
  await pending;
  expect((await client.next()).type).toBe("producer.ack");
  return { control, fixture };
}

function spectrumFailureDiagnostic(): NativeFailureDiagnosticV2 {
  return {
    scope: "native-spectrum-rejection/v1",
    generation: "55555555-5555-4555-8555-555555555555",
    check: "end",
    packet: [0, 0, 0, 0, 0, 37],
    fftDiagnostics: [0, 1, 0, 2048, 253],
    metadata: {
      dsp: [1, 48000, 64],
      fftInfo: [2048, 2048, 2048, 1],
      clockAbi: 2,
      envelopeAbi: 2,
      spectrumAbi: 2,
    },
  };
}

describe("explicit native v2 authenticated ingress", () => {
  it("attributes a controlled terminal-ACK exception after valid completion without inventing a native capture failure", async () => {
    const events: TelemetryEventEnvelope[] = [];
    const { server, endpoint } = await start({
      telemetry: {
        enqueue: (event) => {
          events.push(event);
          return true;
        },
      },
    });
    const received: ListenerResultEvent[] = [];
    server.onListenerResult((event) => received.push(event));
    const client = await listener(endpoint, nativeV2Metadata, 2);
    const { control, fixture } = await armedV2(server, client);
    client.send(
      result(control, 2, {
        status: "progress",
        observation: undefined,
        nativeLaunch: fixture.proof.launched,
      }),
    );
    await client.next();
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
      client.send(
        result(control, 3, {
          requestId,
          status: "completed",
          observation: fixture.observation,
          nativeCapture: fixture.proof,
        }),
      );
      expect(await client.next()).toMatchObject({
        type: "producer.error",
        code: "internal-error",
        fatal: true,
      });
      await expect.poll(() => server.inspectListeners().length).toBe(0);
    } finally {
      spy.mockRestore();
    }
    expect(injected).toBe(1);
    expect(
      received.filter((event) => event.result.status === "completed"),
    ).toHaveLength(1);
    expect(
      received.some((event) =>
        ["failed", "partial"].includes(event.result.status),
      ),
    ).toBe(false);
    const failure = events.find(
      (event) => event.name === "output.ingress.failed",
    )!;
    expect(failure.attributes).toMatchObject({
      code: "internal-error",
      fatal: true,
      connectionId: client.connectionId,
      connectionEpoch: control.connectionEpoch,
      processingRequestId: requestId,
      processingMessageType: "listener.result",
      processingPhase: "ack-write",
      listenerPhase: "idle",
      listenerOwnerPresent: false,
    });
    expect(failure.attributes.message).toContain("controlled ACK exception");
    expect(typeof failure.attributes.writableLength).toBe("number");
    expect(typeof failure.attributes.writableHighWaterMark).toBe("number");
    expect(failure.attributes.message).toContain("[REDACTED]");
    expect(String(failure.attributes.message).length).toBeLessThanOrEqual(512);
    expect(JSON.stringify(events)).not.toContain(token);
    expect(failure.trace?.traceId).toBe(control.traceId);
    expect(failure.correlationId).toBe(control.correlationId);
    expect(failure.causationId).toBe(control.causationId);
    expect(failure.durationMs).toBeGreaterThanOrEqual(0);
    const completed = events.find(
      (event) =>
        event.name === "output.listener.completed" &&
        event.attributes.status === "completed",
    )!;
    expect(events.indexOf(completed)).toBeLessThan(events.indexOf(failure));
    expect(
      events.some(
        (event) =>
          event.name === "output.ingress.acknowledged" &&
          event.attributes.requestId === requestId,
      ),
    ).toBe(false);
  });

  it("distinguishes an owned active-pass sequence failure even when explicit failure cleanup already released its owner", async () => {
    const events: TelemetryEventEnvelope[] = [];
    const { server, endpoint } = await start({
      telemetry: {
        enqueue: (event) => {
          events.push(event);
          return true;
        },
      },
    });
    const client = await listener(endpoint, nativeV2Metadata, 2);
    const { control } = await armedV2(server, client);
    client.send(
      result(control, 99, { status: "progress", observation: undefined }),
    );
    expect(await client.next()).toMatchObject({
      code: "sequence-replay",
      fatal: true,
    });
    await expect.poll(() => server.inspectListeners().length).toBe(0);
    const failure = events.find(
      (event) => event.name === "output.ingress.failed",
    )!;
    expect(failure.attributes).toMatchObject({
      code: "sequence-replay",
      processingMessageType: "listener.result",
      processingPhase: "dispatch",
      listenerPhase: "idle",
      listenerOwnerPresent: false,
      connectionEpoch: control.connectionEpoch,
      listenerPhaseAtDispatch: "armed",
      listenerOwnerPresentAtDispatch: true,
    });
    expect(typeof failure.attributes.requestElapsedMs).toBe("number");
    expect(failure.trace?.traceId).toBe(control.traceId);
    expect(
      events.some(
        (event) =>
          event.name === "output.listener.completed" &&
          event.attributes.status === "completed",
      ),
    ).toBe(false);
  });

  it("clears processed-request attribution after ACK rather than attributing a later idle timeout to that request", async () => {
    const events: TelemetryEventEnvelope[] = [];
    let now = 1000;
    const { server, endpoint } = await start({
      now: () => now,
      idleTimeoutMs: 1000,
      idleCheckIntervalMs: 5,
      telemetry: {
        enqueue: (event) => {
          events.push(event);
          return true;
        },
      },
    });
    const client = await listener(endpoint, nativeV2Metadata, 2);
    const { control } = await armedV2(server, client);
    now += 1001;
    expect(await client.next()).toMatchObject({
      code: "idle-timeout",
      fatal: true,
    });
    await expect.poll(() => server.inspectListeners().length).toBe(0);
    const failure = events.find(
      (event) => event.name === "output.ingress.failed",
    )!;
    expect(failure.attributes).toMatchObject({
      code: "idle-timeout",
      processingPhase: "idle",
      listenerPhase: "armed",
      listenerOwnerPresent: true,
      connectionEpoch: control.connectionEpoch,
    });
    expect(failure.attributes.processingRequestId).toBeUndefined();
    expect(failure.attributes.processingMessageType).toBeUndefined();
    expect(failure.trace?.traceId).toBe(control.traceId);
  });

  it.each(["reply", "result"] as const)(
    "retains bounded %s failure snapshots in attributed typed telemetry, never capture authority",
    async (kind) => {
      const events: TelemetryEventEnvelope[] = [];
      const { server, endpoint } = await start({
        telemetry: {
          enqueue(event) {
            events.push(event);
            return true;
          },
        },
      });
      const received: ListenerResultEvent[] = [];
      server.onListenerResult((event) => received.push(event));
      const client = await listener(endpoint, nativeV2Metadata, 2);
      const diagnostic = spectrumFailureDiagnostic();
      if (kind === "reply") {
        diagnostic.fftDiagnostics = null;
        diagnostic.metadata.clockAbi = null;
      }
      const failure = {
        status: "failed",
        reason: "invalid_native_spectrum_packet",
        nativeFailureDiagnostic: diagnostic,
      };
      if (kind === "reply") {
        await prepareV2(server, client);
        const { control, pending } = await beginArmV2(server, client);
        client.send({ ...reply(control, 1, "failed"), ...failure });
        await expect(pending).resolves.toMatchObject(failure);
        expect(received).toEqual([]);
      } else {
        const { control } = await armedV2(server, client);
        client.send(
          result(control, 2, {
            ...failure,
            observation: undefined,
          }),
        );
      }
      expect((await client.next()).type).toBe("producer.ack");
      await expect.poll(() => server.inspectListeners()[0]?.phase).toBe("idle");
      const failureEvent = events.find(
        (event) => event.name === "output.listener.failed",
      );
      expect(failureEvent).toMatchObject({
        trace: { traceId: v2Context().traceId },
        correlationId: v2Context().correlationId,
        causationId: v2Context().causationId,
        attributes: {
          passId: v2Context().passId,
          nativeFailureDiagnostic: diagnostic,
        },
      });
      expect(failureEvent?.durationMs).toBeGreaterThanOrEqual(0);
      expect(
        received.some((event) => event.result.status === "completed"),
      ).toBe(false);
    },
  );

  it("denies malformed raw failure diagnostics without retaining embedded credentials or diagnostic authority", async () => {
    const events: TelemetryEventEnvelope[] = [];
    const { server, endpoint } = await start({
      telemetry: {
        enqueue(event) {
          events.push(event);
          return true;
        },
      },
    });
    const client = await listener(endpoint, nativeV2Metadata, 2);
    await prepareV2(server, client);
    const { control, pending } = await beginArmV2(server, client);
    const diagnostic = spectrumFailureDiagnostic();
    const credential = "Bearer private-diagnostic-credential";
    client.send({
      ...reply(control, 1, "failed"),
      reason: "invalid_native_spectrum_packet",
      nativeFailureDiagnostic: {
        ...diagnostic,
        metadata: { ...diagnostic.metadata, audio: credential },
      },
    });
    expect(await client.next()).toMatchObject({
      type: "producer.error",
      code: "invalid-message",
      fatal: true,
    });
    await expect(pending).rejects.toThrow();
    await expect.poll(() => server.inspectListeners().length).toBe(0);
    expect(JSON.stringify(events)).not.toContain(credential);
    expect(
      events.some(
        (event) => event.attributes.nativeFailureDiagnostic !== undefined,
      ),
    ).toBe(false);
  });

  it.each(["complete", "cancel", "disconnect", "backpressure"] as const)(
    "runs the real shared v2 client through authenticated %s with synthetic native proof",
    async (outcome) => {
      const events: TelemetryEventEnvelope[] = [];
      const statuses: string[][] = [];
      const { server, endpoint } = await start({
        telemetry: {
          enqueue(event) {
            events.push(event);
            return true;
          },
        },
      });
      const endBeat = outcome === "backpressure" ? 60 : 4;
      let producerSocket: Socket | undefined;
      const results: ListenerResultEvent[] = [];
      server.onListenerResult((event) => results.push(event));
      const descriptor = {
        ...endpoint,
        protocol: "newline-delimited-json",
        protocolVersion: 1,
        maxFrameBytes: 128 * 1024,
        listenerVersions: [1, 2],
        listenerCapabilities: ["audio-listener/v1", "audio-listener/v2"],
      };
      const audio = new AgentSignalClient({
        secret,
        descriptorPath: "isolated-v2-fixture-descriptor.json",
        signalKind: "audio",
        schemaVersion: "audio-observation/v2",
        producerIdPrefix: "ableton-audio-listener",
        instanceId: "audio-v2",
        readText: async () => JSON.stringify(descriptor),
        createConnection(options: { host: string; port: number }) {
          const streamOptions = { ...options, highWaterMark: 16384 };
          producerSocket = connect(streamOptions);
          return producerSocket;
        },
        onStatus: (...values: string[]) => statuses.push(values),
        listener: {
          ...nativeV2Metadata,
          version: 2,
          capabilities: ["audio-listener/v2"],
          sampleRate: 48000,
          algorithmVersion: "2.0.0",
          deviceCanonicalPath: "live_set tracks 1 devices 0",
          trackCanonicalPath: "live_set tracks 1",
          nativeStatus: {
            ...nativeV2Metadata.nativeStatus,
            readiness: "BLOCKED",
            reason: "fresh_per_pass_native_validation_required",
          },
        },
        onListenerControl(control: VersionedListenerControl) {
          const fixture = createSyntheticNativeListeningFixtureV2({
            listenerId: audio.producer.producerId,
            endBeat,
          });
          audio.sendListenerReply(
            control,
            control.action === "arm"
              ? { status: "armed", nativeArm: fixture.proof.armed }
              : {
                  status: control.action === "prepare" ? "ready" : "cancelled",
                },
          );
          if (
            control.action === "arm" &&
            (outcome === "complete" || outcome === "backpressure")
          ) {
            audio.sendListenerResult(control, {
              status: "progress",
              nativeLaunch: fixture.proof.launched,
            });
            const socket = producerSocket!;
            if (outcome === "backpressure") socket.cork();
            expect(
              audio.sendListenerResult(control, {
                status: "completed",
                observation: { ...fixture.observation, passId: control.passId },
                nativeCapture: fixture.proof,
              }),
            ).toBe(true);
            if (outcome === "backpressure") {
              expect(socket.writableNeedDrain).toBe(true);
              expect(socket.writableLength).toBeGreaterThanOrEqual(16384);
              socket.uncork();
            }
          }
        },
      });
      clients.push(audio);
      audio.configureProducer({
        canonicalPath: "live_set tracks 1 devices 0",
        track: { id: "3", name: "Audio" },
        device: { id: "4", name: "Listener v2" },
      });
      audio.start();
      await expect.poll(() => audio.isConnected()).toBe(true);
      const connectionId = server.inspectListeners()[0]!.connectionId;
      const before = server.inspectListeners()[0]!;
      const proof = createSyntheticNativeListeningFixtureV2({ endBeat }).proof;
      const context = {
        ...v2Context(),
        config: {
          geometry: proof.armed.geometry,
          timingPolicy: proof.armed.policy,
        },
      };
      await expect(
        server.requestListenerControl(connectionId, context),
      ).resolves.toMatchObject({ listenerVersion: 2, status: "ready" });
      const { config, ...arm } = context;
      expect(config.geometry.sampleRate).toBe(48000);
      await expect(
        server.requestListenerControl(connectionId, { ...arm, action: "arm" }),
      ).resolves.toMatchObject({ listenerVersion: 2, status: "armed" });
      if (outcome === "complete" || outcome === "backpressure") {
        await expect
          .poll(() => results.at(-1)?.result.status)
          .toBe("completed");
        expect(results.map(({ result }) => result.sequence)).toEqual([2, 3]);
        expect(results.at(-1)?.result.observation?.complete).toBe(true);
        expect(results.at(-1)?.result).toMatchObject({
          listenerVersion: 2,
          traceId: context.traceId,
          correlationId: context.correlationId,
          causationId: context.causationId,
          passId: context.passId,
        });
        if (outcome === "backpressure") {
          await expect.poll(() => audio.pending.size).toBe(0);
          expect(
            results.filter(({ result }) => result.status === "completed"),
          ).toHaveLength(1);
          expect(server.inspectListeners()[0]).toMatchObject({
            connectionId: before.connectionId,
            registration: {
              connectionEpoch: before.registration.connectionEpoch,
            },
          });
          expect(
            statuses.some(
              (status) =>
                status[1] === "write_backpressure" && status[2] === "completed",
            ),
          ).toBe(true);
          expect(
            events.some((event) => event.name === "output.ingress.failed"),
          ).toBe(false);
          expect(
            events.some(
              (event) =>
                event.name === "output.ingress.acknowledged" &&
                event.attributes.requestId === results.at(-1)?.result.requestId,
            ),
          ).toBe(true);
        }
      } else if (outcome === "cancel") {
        await expect(
          server.requestListenerControl(connectionId, {
            ...arm,
            action: "cancel",
          }),
        ).resolves.toMatchObject({ listenerVersion: 2, status: "cancelled" });
        expect(results).toEqual([]);
      } else {
        audio.stop();
        await expect.poll(() => results.length).toBe(1);
        expect(results[0]!.result).toMatchObject({
          listenerVersion: 2,
          status: "partial",
          reason: "disconnected",
        });
        expect(results[0]!.result.observation).toBeUndefined();
      }
      expect(server.inspectListeners()[0]?.phase ?? "idle").toBe("idle");
    },
  );

  it.each(["wrong-secret", "missing-capability", "mixed-version"] as const)(
    "denies %s before registration",
    async (failure) => {
      const { server, endpoint } = await start();
      const client = await raw(endpoint);
      const hello = listenerHello(nativeV2Metadata, 2);
      if (failure === "wrong-secret") hello.secret = "x".repeat(32);
      if (failure === "mixed-version")
        hello.producer.schemaVersion = "audio-observation/v1";
      client.send(
        failure === "missing-capability"
          ? { ...hello, listener: undefined }
          : hello,
      );
      expect(await client.next()).toMatchObject({
        type: "producer.error",
        fatal: true,
        code:
          failure === "wrong-secret"
            ? "authentication-failed"
            : "invalid-message",
      });
      expect(server.inspectListeners()).toEqual([]);
    },
  );

  it("freezes caller configuration and independently verifies capture with causal lifecycle", async () => {
    const events: TelemetryEventEnvelope[] = [];
    const { server, endpoint } = await start({
      telemetry: {
        enqueue(event) {
          events.push(event);
          return true;
        },
      },
    });
    const received: ListenerResultEvent[] = [];
    server.onListenerResult((event) => received.push(event));
    const client = await listener(endpoint, nativeV2Metadata, 2);
    const context = v2Context();
    await prepareV2(server, client, 0, context);
    context.config.timingPolicy = {
      mode: "descriptive",
      maxClockDisagreementSamples: 480,
    };
    const fixture = createSyntheticNativeListeningFixtureV2({
      listenerId: "audio",
    });
    const { control, pending } = await beginArmV2(server, client);
    client.send({
      ...reply(control, 1, "armed"),
      nativeArm: fixture.proof.armed,
    });
    await pending;
    await client.next();
    let previous = control.causationId;
    for (const [index, stage] of [
      "queued",
      "started",
      "progress",
      "completed",
    ].entries()) {
      const eventId = `44444444-4444-4444-8444-44444444444${index}`;
      client.send(
        result(control, index + 2, {
          status: "progress",
          observation: undefined,
          nativeLifecycle: {
            scope: NATIVE_LISTENER_SCOPE_V2,
            eventId,
            causationId: previous,
            phase: "alignment",
            stage,
            nativeEpoch: 1,
            elapsedMs: index * 12,
            frames: index === 3 ? 20 : 0,
          },
        }),
      );
      expect((await client.next()).type).toBe("producer.ack");
      previous = eventId;
    }
    client.send(
      result(control, 6, {
        status: "progress",
        observation: undefined,
        nativeLaunch: fixture.proof.launched,
      }),
    );
    expect((await client.next()).type).toBe("producer.ack");
    client.send(
      result(control, 7, {
        observation: fixture.observation,
        nativeCapture: fixture.proof,
      }),
    );
    expect((await client.next()).type).toBe("producer.ack");
    expect(received.at(-1)?.result).toMatchObject({
      listenerVersion: 2,
      status: "completed",
      observation: {
        schema: "audio-observation/v2",
        alignment: {
          policy: { maxClockDisagreementSamples: 64 },
          verifiedAbsoluteErrorBoundSamples: null,
        },
      },
    });
    const native = events.filter((event) =>
      event.name.startsWith("output.listener.native.alignment."),
    );
    expect(native.map((event) => event.name.split(".").at(-1))).toEqual([
      "queued",
      "started",
      "progress",
      "completed",
    ]);
    expect(native.map((event) => event.durationMs)).toEqual([0, 12, 24, 36]);
    expect(native[1]?.causationId).toBe(native[0]?.id);
    expect(
      native.every(
        (event) =>
          event.trace?.traceId === context.traceId &&
          event.correlationId === context.correlationId,
      ),
    ).toBe(true);
    expect(server.inspectListeners()[0]?.phase).toBe("idle");

    await prepareV2(server, client, 8);
    const replay = await beginArmV2(server, client);
    client.send({
      ...reply(replay.control, 9, "armed"),
      nativeArm: fixture.proof.armed,
    });
    expect(await client.next()).toMatchObject({
      code: "route-rejected",
      message: "native_v2_arm_counter_replay",
    });
    await expect(replay.pending).rejects.toThrow();
  });

  it.each(["version", "geometry"] as const)(
    "denies mismatched prepare %s without taking ownership",
    async (failure) => {
      const { server, endpoint } = await start();
      const client = await listener(endpoint, nativeV2Metadata, 2);
      const context = v2Context();
      context.config.geometry.vectorSize = 128;
      await expect(
        server.requestListenerControl(
          client.connectionId,
          failure === "version" ? input : context,
        ),
      ).rejects.toThrow(
        failure === "version"
          ? "listener_configuration_version_mismatch"
          : "listener_dsp_geometry_mismatch",
      );
      expect(server.inspectListeners()[0]?.phase).toBe("idle");
      expect(server.inspectListeners()[0]?.jobId).toBeUndefined();
    },
  );

  it("denies a producer-selected larger policy at arm", async () => {
    const { server, endpoint } = await start();
    const client = await listener(endpoint, nativeV2Metadata, 2);
    await prepareV2(server, client);
    const arm = await beginArmV2(server, client);
    const fixture = createSyntheticNativeListeningFixtureV2();
    fixture.proof.armed.policy = {
      mode: "descriptive",
      maxClockDisagreementSamples: 480,
    };
    client.send({
      ...reply(arm.control, 1, "armed"),
      nativeArm: fixture.proof.armed,
    });
    expect(await client.next()).toMatchObject({
      code: "route-rejected",
      message: "native_v2_policy_or_geometry_mismatch",
    });
    await expect(arm.pending).rejects.toThrow();
  });

  it.each(["descriptor", "missing-launch", "mixed-version"] as const)(
    "rejects %s results before subscriber completion",
    async (failure) => {
      const { server, endpoint } = await start();
      const received: ListenerResultEvent[] = [];
      server.onListenerResult((event) => received.push(event));
      const client = await listener(endpoint, nativeV2Metadata, 2);
      const { control, fixture } = await armedV2(server, client);
      let sequence = 2;
      if (failure !== "missing-launch") {
        client.send(
          result(control, sequence++, {
            status: "progress",
            observation: undefined,
            nativeLaunch: fixture.proof.launched,
          }),
        );
        await client.next();
      }
      if (failure === "descriptor")
        fixture.observation.summaries.peak = [0.5, 0.5];
      client.send(
        failure === "mixed-version"
          ? result(control, sequence, { listenerVersion: 1 })
          : result(control, sequence, {
              observation: fixture.observation,
              nativeCapture: fixture.proof,
            }),
      );
      expect(await client.next()).toMatchObject({
        type: "producer.error",
        code: "route-rejected",
        fatal: true,
      });
      expect(
        received.some((event) => event.result.status === "completed"),
      ).toBe(false);
      expect(received.at(-1)?.result).toMatchObject({
        listenerVersion: 2,
        status: "partial",
      });
    },
  );

  it("keeps cancellation versioned, confirmed, attributed and redacted", async () => {
    const events: TelemetryEventEnvelope[] = [];
    const { server, endpoint } = await start({
      telemetry: {
        enqueue(event) {
          events.push(event);
          return true;
        },
      },
    });
    const client = await listener(endpoint, nativeV2Metadata, 2);
    const { control } = await armedV2(server, client);
    client.send(
      result(control, 2, {
        status: "progress",
        observation: undefined,
        nativeLifecycle: {
          scope: NATIVE_LISTENER_SCOPE_V2,
          eventId: "44444444-4444-4444-8444-444444444444",
          causationId: control.causationId,
          stage: "cancelled",
          phase: "capture",
          nativeEpoch: 1,
          elapsedMs: 25,
          frames: 0,
          reason: "user_cancelled",
        },
      }),
    );
    await client.next();
    const { config, ...context } = v2Context();
    expect(config.geometry.sampleRate).toBe(48_000);
    const pending = server.requestListenerControl(client.connectionId, {
      ...context,
      action: "cancel",
    });
    const cancel = listenerControlV2Schema.parse(await client.next());
    expect(cancel.config).toBeUndefined();
    client.send({
      ...reply(cancel, 3, "cancelled"),
      reason: "token=super-secret-value",
    });
    expect((await pending).reason).not.toContain("super-secret-value");
    await client.next();
    expect(server.inspectListeners()[0]?.phase).toBe("idle");
    expect(server.inspectListeners()[0]?.jobId).toBeUndefined();
    expect(
      events.some(
        (event) =>
          event.name === "output.listener.native.cancelled" &&
          event.outcome === "cancelled" &&
          event.durationMs === 25,
      ),
    ).toBe(true);
    expect(JSON.stringify(events)).not.toContain("super-secret-value");
  });

  it("publishes versioned failure and disconnects when prepare is aborted", async () => {
    const { server, endpoint } = await start();
    const received: ListenerResultEvent[] = [];
    server.onListenerResult((event) => received.push(event));
    const client = await listener(endpoint, nativeV2Metadata, 2);
    const controller = new AbortController();
    const pending = server.requestListenerControl(
      client.connectionId,
      v2Context(),
      { signal: controller.signal },
    );
    void pending.catch(() => {});
    await client.next();
    controller.abort();
    await expect(pending).rejects.toThrow("cancelled");
    expect(received.at(-1)?.result).toMatchObject({
      listenerVersion: 2,
      status: "partial",
      reason: "control_cancelled",
    });
  });

  it.each(["sequence", "epoch", "trace", "correlation"] as const)(
    "rejects v2 %s tampering and releases the owned capture",
    async (failure) => {
      const { server, endpoint } = await start();
      const received: ListenerResultEvent[] = [];
      server.onListenerResult((event) => received.push(event));
      const client = await listener(endpoint, nativeV2Metadata, 2);
      const { control } = await armedV2(server, client);
      client.send(
        result(control, failure === "sequence" ? 3 : 2, {
          status: "progress",
          observation: undefined,
          ...(failure === "epoch" ? { connectionEpoch: "stale-epoch" } : {}),
          ...(failure === "trace" ? { traceId: "stale-trace" } : {}),
          ...(failure === "correlation"
            ? { correlationId: "wrong-owner" }
            : {}),
        }),
      );
      expect(await client.next()).toMatchObject({
        code: failure === "sequence" ? "sequence-replay" : "route-rejected",
        fatal: true,
      });
      expect(received.at(-1)?.result).toMatchObject({
        listenerVersion: 2,
        status: "partial",
      });
      await vi.waitFor(() => expect(server.inspectListeners()).toEqual([]));
    },
  );

  it("retains explicit native failure without publishing complete audio", async () => {
    const events: TelemetryEventEnvelope[] = [];
    const { server, endpoint } = await start({
      telemetry: {
        enqueue(event) {
          events.push(event);
          return true;
        },
      },
    });
    const received: ListenerResultEvent[] = [];
    server.onListenerResult((event) => received.push(event));
    const client = await listener(endpoint, nativeV2Metadata, 2);
    const { control } = await armedV2(server, client);
    client.send(
      result(control, 2, {
        status: "progress",
        observation: undefined,
        nativeLifecycle: {
          scope: NATIVE_LISTENER_SCOPE_V2,
          eventId: "44444444-4444-4444-8444-444444444444",
          causationId: control.causationId,
          stage: "failed",
          phase: "capture",
          nativeEpoch: 1,
          elapsedMs: 125,
          frames: 1,
          reason: "tempo_changed",
        },
      }),
    );
    await client.next();
    client.send(
      result(control, 3, {
        status: "failed",
        observation: undefined,
        reason: "tempo_changed token=super-secret-value",
      }),
    );
    expect((await client.next()).type).toBe("producer.ack");
    expect(received.at(-1)?.result).toMatchObject({
      listenerVersion: 2,
      status: "failed",
    });
    expect(
      events.some(
        (event) =>
          event.name === "output.listener.native.failed" &&
          event.outcome === "failure" &&
          event.durationMs === 125,
      ),
    ).toBe(true);
    expect(JSON.stringify({ events, received })).not.toContain(
      "super-secret-value",
    );
    expect(server.inspectListeners()[0]?.phase).toBe("idle");
  });

  it("derives the capture watchdog from native sample duration and cleans up expiry", async () => {
    let now = 0;
    const { server, endpoint } = await start({
      now: () => now,
      idleCheckIntervalMs: 5,
      idleTimeoutMs: 100_000,
    });
    const received: ListenerResultEvent[] = [];
    server.onListenerResult((event) => received.push(event));
    const client = await listener(endpoint, nativeV2Metadata, 2);
    await armedV2(server, client);
    now = 16_000;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(server.inspectListeners()[0]?.phase).toBe("armed");
    now = 17_001;
    await vi.waitFor(() =>
      expect(received.at(-1)?.result).toMatchObject({
        listenerVersion: 2,
        status: "partial",
        reason: "capture_watchdog_timeout",
      }),
    );
    await vi.waitFor(() => expect(server.inspectListeners()).toEqual([]));
  });
});

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
