import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { createSyntheticNativeSessionListeningFixture } from "@ableton-agent/protocol/testing";
import {
  InMemoryConnectionRegistry,
  SignalIngressServer,
  SignalRouter,
  listenerRegistrationDualSchema,
  type VersionedListenerControl,
} from "@ableton-agent/signal-routing";
import type { TelemetryEventEnvelope } from "@ableton-agent/observability";
import { prepareListenerCapture } from "./listening-capture.js";

interface TestSignalClient {
  readonly producer: { readonly producerId: string };
  readonly listenerJob: { readonly config: { readonly source: typeof source } };
  configureProducer(value: Record<string, unknown>): void;
  start(): void;
  stop(): void;
  sendListenerReply(control: unknown, reply: Record<string, unknown>): boolean;
  sendListenerResult(
    control: unknown,
    result: Record<string, unknown>,
  ): boolean;
}
const { AgentSignalClient } = createRequire(import.meta.url)(
  "../../../max-patches/shared/agent_signal_client.js",
) as {
  AgentSignalClient: new (options: Record<string, unknown>) => TestSignalClient;
};
const trace = {
  traceId: "11111111-1111-4111-8111-111111111111",
  correlationId: "22222222-2222-4222-8222-222222222222",
  causationId: "33333333-3333-4333-8333-333333333333",
};
const source = {
  mode: "session" as const,
  synchronization: "transport-coupled-first-iteration" as const,
  target: {
    view: "session" as const,
    sceneIndex: 0,
    expectedClipReference: trace.traceId,
    expectedClipName: "clip",
    track: {
      kind: "regular" as const,
      index: 0,
      expectedReference: trace.correlationId,
      expectedName: "track",
    },
  },
};
const dispose: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of dispose.splice(0).reverse()) await close();
});

async function setup() {
  const registry = new InMemoryConnectionRegistry({ staleAfterMs: 15000 });
  const events: TelemetryEventEnvelope[] = [];
  const server = new SignalIngressServer({
    secret: "dual-mode-runtime-secret-at-least-32-chars",
    registry,
    router: new SignalRouter({ registry }),
    port: 0,
    telemetry: {
      enqueue: (event) => {
        events.push(event);
        return true;
      },
    },
  });
  const endpoint = await server.start();
  dispose.push(() => server.stop());
  const controls: VersionedListenerControl[] = [];
  let arm: unknown;
  const client = new AgentSignalClient({
    signalKind: "audio",
    schemaVersion: "audio-observation/v2",
    descriptorPath: "isolated-dual-descriptor.json",
    readText: async () =>
      JSON.stringify({
        ...endpoint,
        protocol: "newline-delimited-json",
        protocolVersion: 1,
        maxFrameBytes: 128 * 1024,
        listenerVersions: [1, 2, 3, 4],
        listenerCapabilities: [
          "audio-listener/v1",
          "audio-listener/v2",
          "audio-listener/session-v1",
          "audio-listener/dual-mode-v1",
        ],
      }),
    secret: "dual-mode-runtime-secret-at-least-32-chars",
    listener: listenerRegistrationDualSchema.parse({
      version: 4,
      connectionEpoch: "epoch",
      capabilities: ["audio-listener/dual-mode-v1"],
      sampleRate: 48000,
      vectorSize: 64,
      algorithmVersion: "2.0.0",
      deviceCanonicalPath: "live_set tracks 0 devices 0",
      trackCanonicalPath: "live_set tracks 0",
      nativeStatus: {
        version: 4,
        scope: "mode-negotiated-transport/v1",
        supportedModes: ["arrangement", "session"],
        readiness: "BLOCKED",
        reason: "fresh_per_pass_native_validation_required",
        alignment: "approximate",
        verifiedAbsoluteErrorBoundSamples: null,
        acceptedSampleRates: [44100, 48000],
        acceptedVectorSizes: [64],
        timingModes: ["descriptive", "strict"],
        maxClockDisagreementSamples: 480,
        maxAudioDurationMs: 30000,
        maxWindows: 300,
        abiVersion: 2,
      },
    }),
    onListenerControl(control: VersionedListenerControl) {
      controls.push(control);
      client.sendListenerReply(control, {
        status:
          control.action === "prepare"
            ? "ready"
            : control.action === "arm"
              ? "armed"
              : "cancelled",
        ...(control.action === "arm" ? { nativeArm: arm } : {}),
      });
    },
  });
  dispose.push(() => client.stop());
  client.configureProducer({
    canonicalPath: "live_set tracks 0 devices 0",
    track: { id: "track", name: "track" },
    device: { id: "device", name: "listener" },
  });
  client.start();
  await expect.poll(() => server.inspectListeners().length).toBe(1);
  const data = createSyntheticNativeSessionListeningFixture({
    source,
    listenerId: client.producer.producerId,
    passId: "dual-pass",
  });
  return {
    server,
    client,
    controls,
    data,
    events,
    setArm: (value: unknown) => {
      arm = value;
    },
  };
}

describe("one advertised wire4 producer through authenticated SDK, ingress and capture", () => {
  it.each(["arrangement", "session"] as const)(
    "completes %s without converting the other mode's proof",
    async (mode) => {
      const f = await setup();
      f.setArm(mode === "session" ? f.data.arm : f.data.arm.transport);
      const capture = await prepareListenerCapture(f.server, {
        listeners: f.server.inspectListeners(),
        config: {
          geometry: f.data.expected.geometry,
          timingPolicy: f.data.expected.policy,
          ...(mode === "session" ? { source } : {}),
        },
        passId: "dual-pass",
        trace,
        signal: new AbortController().signal,
        telemetry: {
          enqueue: (event) => {
            f.events.push(event);
            return true;
          },
        },
      });
      expect(
        f.controls.map((v) => (v.listenerVersion === 4 ? v.mode : undefined)),
      ).toEqual([mode, mode]);
      const control = f.controls[1]!;
      expect(
        f.client.sendListenerResult(control, {
          status: "progress",
          nativeLaunch:
            mode === "session" ? f.data.launch : f.data.launch.transport,
        }),
      ).toBe(true);
      await capture.nativeLaunch;
      expect(
        f.client.sendListenerResult(control, {
          status: "completed",
          observation: f.data.observation,
          nativeCapture:
            mode === "session" ? f.data.proof : f.data.proof.transport,
        }),
      ).toBe(true);
      await expect(capture.result).resolves.toEqual([f.data.observation]);
      await capture.disarm();
      expect(f.server.inspectListeners()[0]?.phase).toBe("idle");
      expect(
        f.events.some((event) => event.name === "listening.capture.completed"),
      ).toBe(true);
      for (const event of f.events.filter((event) =>
        event.name.startsWith("listening.capture."),
      )) {
        expect(event.trace?.traceId).toBe(trace.traceId);
        expect(event.correlationId).toBe(trace.correlationId);
        expect(event.durationMs).toBeGreaterThanOrEqual(0);
      }
    },
  );

  it("freezes Session mode/source, denies mixed control/proof, and permits a later Arrangement pass on the same connection", async () => {
    const f = await setup();
    const connectionId = f.server.inspectListeners()[0]!.connectionId;
    const base = { ...trace, jobId: "dual-job", passId: "dual-pass" };
    await f.server.requestListenerControl(connectionId, {
      ...base,
      action: "prepare",
      config: {
        geometry: f.data.expected.geometry,
        timingPolicy: f.data.expected.policy,
        source,
      },
    });
    const control = f.controls[0]!;
    expect(
      Object.isFrozen(f.client.listenerJob.config.source.target.track),
    ).toBe(true);
    expect(
      f.client.sendListenerReply(
        { ...control, mode: "arrangement" },
        { status: "ready" },
      ),
    ).toBe(false);
    expect(
      f.client.sendListenerReply(control, {
        status: "armed",
        nativeArm: f.data.arm.transport,
      }),
    ).toBe(false);
    await f.server.requestListenerControl(connectionId, {
      ...base,
      action: "cancel",
    });
    await f.server.requestListenerControl(connectionId, {
      ...base,
      passId: "later-pass",
      action: "prepare",
      config: {
        geometry: f.data.expected.geometry,
        timingPolicy: f.data.expected.policy,
      },
    });
    expect(f.controls.at(-1)).toMatchObject({
      listenerVersion: 4,
      mode: "arrangement",
    });
    expect(f.server.inspectListeners()[0]?.connectionId).toBe(connectionId);
    await f.server.requestListenerControl(connectionId, {
      ...base,
      passId: "later-pass",
      action: "cancel",
    });
    expect(f.server.inspectListeners()[0]?.phase).toBe("idle");
  });
});
