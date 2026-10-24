import { afterEach, describe, expect, it, vi } from "vitest";
import { createSyntheticNativeSessionListeningFixture } from "@ableton-agent/protocol/testing";
import type { TelemetryEventEnvelope } from "@ableton-agent/observability";
import {
  listenerRegistrationSessionSchema,
  type ListenerDescriptor,
  type ListenerResultEvent,
  type ListenerResultSession,
  type ListenerService,
  type VersionedListenerControlInput,
  type VersionedListenerReply,
} from "@ableton-agent/signal-routing";
import { prepareListenerCapture } from "./listening-capture.js";

const trace = {
  traceId: "11111111-1111-4111-8111-111111111111",
  correlationId: "22222222-2222-4222-8222-222222222222",
  causationId: "33333333-3333-4333-8333-333333333333",
};

function fixture() {
  const data = createSyntheticNativeSessionListeningFixture({
    listenerId: "producer-a",
    source: {
      mode: "session",
      synchronization: "transport-coupled-first-iteration",
      target: {
        view: "session",
        track: {
          kind: "regular",
          index: 0,
          expectedReference: trace.traceId,
          expectedName: "Track",
        },
        sceneIndex: 0,
        expectedClipReference: trace.correlationId,
        expectedClipName: "Clip",
      },
    },
  });
  const listener: {
    -readonly [K in keyof ListenerDescriptor]: ListenerDescriptor[K];
  } = {
    connectionId: "connection-a",
    producer: {
      producerId: "producer-a",
      instanceId: "instance-a",
      displayName: "Session listener",
      signalKind: "audio",
      schemaVersion: "audio-observation/v2",
      track: { id: "track-a" },
      device: { id: "device-a" },
    },
    binding: { trackId: "track-a", deviceId: "device-a" },
    registration: listenerRegistrationSessionSchema.parse({
      version: 3,
      connectionEpoch: "epoch-a",
      capabilities: ["audio-listener/session-v1"],
      algorithmVersion: "2.0.0",
      sampleRate: 48000,
      vectorSize: 64,
      deviceCanonicalPath: "live_set tracks 0 devices 0",
      trackCanonicalPath: "live_set tracks 0",
      nativeStatus: {
        version: 3,
        scope: "session-transport-coupled/v1",
        sourceEvidence: "expected-context-only",
        synchronization: "transport-coupled-first-iteration",
        maxDurationBeats: 4,
        readiness: "READY",
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
    phase: "idle",
  };
  const calls: VersionedListenerControlInput[] = [];
  const subscribers = new Set<(event: ListenerResultEvent) => void>();
  const events: TelemetryEventEnvelope[] = [];
  const abort = new AbortController();
  let sequence = -1;
  const service: ListenerService = {
    inspectListeners: () => structuredClone([listener]),
    onListenerResult(callback) {
      subscribers.add(callback);
      return () => {
        subscribers.delete(callback);
      };
    },
    async requestListenerControl(_id, control) {
      calls.push(structuredClone(control));
      listener.phase =
        control.action === "prepare"
          ? "ready"
          : control.action === "arm"
            ? "armed"
            : "idle";
      if (control.action === "cancel") {
        delete listener.jobId;
        delete listener.passId;
      } else {
        listener.jobId = control.jobId;
        listener.passId = control.passId;
      }
      return {
        ...trace,
        type: "listener.reply",
        protocolVersion: 1,
        listenerVersion: 3,
        requestId: `reply-${calls.length}`,
        connectionEpoch: listener.registration.connectionEpoch,
        sequence: ++sequence,
        jobId: control.jobId,
        passId: control.passId,
        status:
          control.action === "prepare"
            ? "ready"
            : control.action === "arm"
              ? "armed"
              : "cancelled",
        ...(control.action === "arm" ? { nativeArm: data.arm } : {}),
      };
    },
  };
  const config = structuredClone({
    source: data.expected.source,
    geometry: data.expected.geometry,
    timingPolicy: data.expected.policy,
  });
  const input = {
    listeners: service.inspectListeners(),
    config,
    passId: data.observation.passId,
    trace,
    signal: abort.signal,
    controlTimeoutMs: 100,
    cleanupTimeoutMs: 100,
    resultTimeoutMs: 1000,
    telemetry: {
      enqueue(event: TelemetryEventEnvelope) {
        events.push(event);
        return true;
      },
    },
  };
  function emit(patch: Partial<ListenerResultSession>) {
    const control = calls.find((call) => call.action === "arm")!;
    const result: ListenerResultSession = {
      ...trace,
      type: "listener.result",
      protocolVersion: 1,
      listenerVersion: 3,
      requestId: "result",
      connectionEpoch: listener.registration.connectionEpoch,
      sequence: ++sequence,
      jobId: control.jobId,
      passId: control.passId,
      status: "progress",
      ...patch,
    };
    for (const subscriber of subscribers)
      subscriber({
        connectionId: listener.connectionId,
        producer: listener.producer,
        binding: listener.binding,
        result,
      });
  }
  return {
    data,
    listener,
    service,
    calls,
    subscribers,
    events,
    abort,
    config,
    input,
    emit,
    launch: () => emit({ nativeLaunch: data.launch }),
    complete: () =>
      emit({
        status: "completed",
        nativeCapture: data.proof,
        observation: data.observation,
      }),
  };
}

afterEach(() => vi.useRealTimers());

describe("wire3 Session transport capture", () => {
  it("validates wrapped transport chains and returns raw v2 only, with traced lifecycle", async () => {
    const f = fixture();
    const capture = await prepareListenerCapture(f.service, f.input);
    expect(capture.nativeLaunch).toBeDefined();
    let launched = false;
    void capture.nativeLaunch!.then(() => {
      launched = true;
    });
    await Promise.resolve();
    expect(launched).toBe(false);
    f.config.source.target.sceneIndex = 7;
    f.config.geometry = { ...f.config.geometry, endBeat: 100 };
    f.launch();
    await capture.nativeLaunch;
    f.complete();
    expect(await capture.result).toEqual([f.data.observation]);
    expect(f.subscribers.size).toBe(0);
    await capture.disarm();
    expect(f.calls.map((c) => c.action)).toEqual(["prepare", "arm"]);
    expect(f.calls[0]?.config).toMatchObject({
      source: { target: { sceneIndex: 0 } },
    });
    const alignment = f.events.filter(
      (event) => event.attributes.action === "alignment",
    );
    expect(alignment.map((e) => e.name)).toEqual([
      "listening.capture.queued",
      "listening.capture.started",
      "listening.capture.completed",
    ]);
    expect(
      alignment.every((e) => e.attributes.listenerId === "producer-a"),
    ).toBe(true);
    expect(
      f.events.every(
        (e) =>
          e.trace?.traceId === trace.traceId &&
          e.correlationId === trace.correlationId &&
          e.causationId === trace.causationId &&
          (e.durationMs ?? -1) >= 0,
      ),
    ).toBe(true);
  });

  it.each(["source", "policy", "geometry", "malformed"] as const)(
    "rejects %s arm evidence and confirms exact-instance cleanup",
    async (failure) => {
      const f = fixture();
      if (failure === "source") f.data.arm.source.target.sceneIndex++;
      if (failure === "policy")
        f.data.arm.transport.policy.maxClockDisagreementSamples++;
      if (failure === "geometry")
        f.data.arm.transport = createSyntheticNativeSessionListeningFixture({
          listenerId: "producer-a",
          source: f.data.expected.source,
          endBeat: 2,
        }).arm.transport;
      if (failure === "malformed")
        Reflect.deleteProperty(f.data.arm, "transport");
      await expect(prepareListenerCapture(f.service, f.input)).rejects.toThrow(
        failure === "source"
          ? "native_session_source_context_mismatch"
          : failure === "malformed"
            ? "malformed-control-reply"
            : "native_v2_policy_or_geometry_mismatch",
      );
      expect(f.calls.map((c) => c.action)).toEqual([
        "prepare",
        "arm",
        "cancel",
      ]);
      expect(f.subscribers.size).toBe(0);
    },
  );

  it.each(["source", "epoch", "missing", "duplicate"] as const)(
    "rejects %s launch proof without granting nativeLaunch",
    async (failure) => {
      const f = fixture();
      const capture = await prepareListenerCapture(f.service, f.input);
      const message =
        failure === "source"
          ? "native_session_source_context_mismatch"
          : failure === "epoch"
            ? "native_v2_launch_binding_mismatch"
            : failure === "missing"
              ? "native-launch-proof-required"
              : "unexpected-native-launch";
      const rejected = expect(capture.result).rejects.toThrow(message);
      const onset =
        failure === "duplicate"
          ? undefined
          : expect(capture.nativeLaunch).rejects.toThrow(message);
      if (failure === "source") f.data.launch.source.target.sceneIndex++;
      if (failure === "epoch") f.data.launch.transport.nativeEpoch++;
      if (failure === "missing") f.complete();
      else {
        f.launch();
        if (failure === "duplicate") f.launch();
      }
      await rejected;
      await onset;
      await capture.disarm();
      expect(f.calls.at(-1)?.action).toBe("cancel");
      expect(f.subscribers.size).toBe(0);
    },
  );

  it.each([
    "source",
    "arm-chain",
    "launch-chain",
    "window",
    "summary",
    "stored",
  ] as const)(
    "rejects %s capture evidence rather than publishing data",
    async (failure) => {
      const f = fixture();
      const capture = await prepareListenerCapture(f.service, f.input);
      f.launch();
      await capture.nativeLaunch;
      const rejected = expect(capture.result).rejects.toThrow();
      if (failure === "source") f.data.proof.source.target.sceneIndex++;
      if (failure === "arm-chain") f.data.proof.transport.armed.armCounter++;
      if (failure === "launch-chain")
        f.data.proof.transport.launched.nativeEpoch++;
      if (failure === "window") f.data.proof.transport.envelopeWindows.pop();
      if (failure === "summary") f.data.observation.summaries.peak = [0.9, 0.9];
      if (failure === "stored")
        Reflect.set(
          f.data.observation,
          "schema",
          "session-audio-observation/v1",
        );
      f.complete();
      await rejected;
      await capture.disarm();
      expect(f.calls.at(-1)?.action).toBe("cancel");
      expect(f.subscribers.size).toBe(0);
      if (["source", "window", "summary"].includes(failure)) {
        expect(
          f.events.filter((e) => e.attributes.action === "alignment").at(-1)
            ?.name,
        ).toBe("listening.capture.failed");
      }
    },
  );

  it.each([
    "stale-pass",
    "stale-epoch",
    "wrong-trace",
    "sequence",
    "malformed",
  ] as const)(
    "rejects %s result envelopes and retains cleanup responsibility",
    async (failure) => {
      const f = fixture();
      const capture = await prepareListenerCapture(f.service, f.input);
      const rejected = expect(capture.result).rejects.toThrow(
        failure === "sequence"
          ? "result-sequence-gap-or-replay"
          : failure === "malformed"
            ? "malformed-result"
            : "stale-result",
      );
      const onset = expect(capture.nativeLaunch).rejects.toThrow();
      f.emit({
        nativeLaunch: f.data.launch,
        ...(failure === "stale-pass" ? { passId: "old" } : {}),
        ...(failure === "stale-epoch" ? { connectionEpoch: "old" } : {}),
        ...(failure === "wrong-trace" ? { traceId: trace.correlationId } : {}),
        ...(failure === "sequence" ? { sequence: 1 } : {}),
        ...(failure === "malformed" ? { listenerVersion: 2 as 3 } : {}),
      });
      await rejected;
      await onset;
      await capture.disarm();
      expect(f.subscribers.size).toBe(0);
    },
  );

  it.each(["stale-pass", "stale-epoch", "sequence"] as const)(
    "does not trust %s terminal arm denial as released ownership",
    async (failure) => {
      const f = fixture();
      const original = f.service.requestListenerControl.bind(f.service);
      vi.spyOn(f.service, "requestListenerControl").mockImplementation(
        async (...args) => {
          const reply = await original(...args);
          if (args[1].action !== "arm") return reply;
          return {
            ...reply,
            status: "failed",
            nativeArm: undefined,
            reason: "native_stop_ack_timeout",
            ...(failure === "stale-pass" ? { passId: "old" } : {}),
            ...(failure === "stale-epoch" ? { connectionEpoch: "old" } : {}),
            ...(failure === "sequence" ? { sequence: 0 } : {}),
          };
        },
      );
      await expect(prepareListenerCapture(f.service, f.input)).rejects.toThrow(
        failure === "sequence"
          ? "unexpected-control-reply"
          : "stale-control-reply",
      );
      expect(f.calls.map((c) => c.action)).toEqual([
        "prepare",
        "arm",
        "cancel",
      ]);
      expect(f.subscribers.size).toBe(0);
    },
  );

  it("preserves native stop failure on a valid terminal arm denial without recancelling released ownership", async () => {
    const f = fixture();
    const original = f.service.requestListenerControl.bind(f.service);
    vi.spyOn(f.service, "requestListenerControl").mockImplementation(
      async (...args) => {
        const reply = await original(...args);
        if (args[1].action !== "arm") return reply;
        f.listener.phase = "idle";
        delete f.listener.jobId;
        delete f.listener.passId;
        return {
          ...reply,
          status: "failed",
          nativeArm: undefined,
          reason: "native_stop_ack_timeout_unconfirmed",
        };
      },
    );
    await expect(prepareListenerCapture(f.service, f.input)).rejects.toThrow(
      "native_stop_ack_timeout_unconfirmed",
    );
    expect(f.calls.map((c) => c.action)).toEqual(["prepare", "arm"]);
    expect(f.subscribers.size).toBe(0);
  });

  it.each([
    "arrangement-config",
    "legacy-config",
    "v2-listener",
    "v3-producer",
    "sample-rate",
    "vector",
    "blocked",
  ] as const)("guards incompatible %s before controls", async (failure) => {
    const f = fixture();
    if (failure === "arrangement-config")
      Reflect.deleteProperty(f.input.config, "source");
    if (failure === "legacy-config")
      Reflect.set(f.input, "config", {
        durationMs: 1000,
        maxWindows: 100,
        source: { mode: "session", startBeat: 0, endBeat: 4 },
      });
    if (failure === "v2-listener")
      Reflect.set(f.input.listeners[0]!.registration, "version", 2);
    if (failure === "v3-producer")
      f.input.listeners[0]!.producer.schemaVersion = "audio-observation/v3";
    if (failure === "sample-rate")
      f.input.config.geometry = { ...f.config.geometry, sampleRate: 44100 };
    if (failure === "vector")
      f.input.config.geometry = { ...f.config.geometry, vectorSize: 128 };
    if (failure === "blocked")
      f.input.listeners[0]!.registration.nativeStatus!.readiness = "BLOCKED";
    await expect(prepareListenerCapture(f.service, f.input)).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
    expect(f.subscribers.size).toBe(0);
  });

  it.each(["instance", "vector", "epoch"] as const)(
    "fails safely on %s replacement without cancelling a different instance",
    async (failure) => {
      const f = fixture();
      vi.useFakeTimers();
      const capture = await prepareListenerCapture(f.service, f.input);
      const rejected = expect(capture.result).rejects.toThrow(
        "cancellation could not be confirmed",
      );
      const onset = expect(capture.nativeLaunch).rejects.toThrow();
      if (failure === "instance")
        f.listener.producer.instanceId = "replacement";
      if (failure === "vector")
        Reflect.set(f.listener.registration, "vectorSize", 128);
      if (failure === "epoch")
        f.listener.registration.connectionEpoch = "replacement";
      await vi.advanceTimersByTimeAsync(100);
      await rejected;
      await onset;
      await expect(capture.disarm()).rejects.toThrow(
        "cancellation could not be confirmed",
      );
      expect(f.calls.map((c) => c.action)).toEqual(["prepare", "arm"]);
      expect(f.subscribers.size).toBe(0);
    },
  );

  it.each(["cancel", "timeout"] as const)(
    "confirms %s and idempotent disarm",
    async (failure) => {
      const f = fixture();
      vi.useFakeTimers();
      const capture = await prepareListenerCapture(f.service, f.input);
      const rejected = expect(capture.result).rejects.toThrow(
        failure === "cancel" ? "cancelled" : "capture-timeout",
      );
      const onset = expect(capture.nativeLaunch).rejects.toThrow();
      if (failure === "cancel") f.abort.abort();
      else await vi.advanceTimersByTimeAsync(1000);
      await rejected;
      await onset;
      await capture.disarm();
      await capture.disarm();
      expect(f.calls.map((c) => c.action)).toEqual([
        "prepare",
        "arm",
        "cancel",
      ]);
      expect(f.calls.at(-1)?.config).toBeUndefined();
      expect(f.subscribers.size).toBe(0);
      expect(f.events.at(-1)?.name).toBe(
        `listening.capture.${failure === "cancel" ? "cancelled" : "failed"}`,
      );
    },
  );

  it("rejects already cancelled capture without taking ownership", async () => {
    const f = fixture();
    f.abort.abort();
    await expect(prepareListenerCapture(f.service, f.input)).rejects.toThrow(
      "cancelled",
    );
    expect(f.calls).toHaveLength(0);
    expect(f.subscribers.size).toBe(0);
  });

  it("buffers early Session launch and completion until the exact arm proof validates", async () => {
    const f = fixture();
    const original = f.service.requestListenerControl.bind(f.service);
    vi.spyOn(f.service, "requestListenerControl").mockImplementation(
      async (...args) => {
        const reply = await original(...args);
        if (args[1].action === "arm") {
          f.launch();
          f.complete();
        }
        return reply;
      },
    );
    const capture = await prepareListenerCapture(f.service, f.input);
    await capture.nativeLaunch;
    expect(await capture.result).toEqual([f.data.observation]);
    expect(f.subscribers.size).toBe(0);
    await capture.disarm();
    expect(f.calls.map((c) => c.action)).toEqual(["prepare", "arm"]);
  });

  it.each(["cancel", "timeout"] as const)(
    "cleans pending arm after %s without waiting for an unresponsive producer",
    async (failure) => {
      const f = fixture();
      vi.useFakeTimers();
      const original = f.service.requestListenerControl.bind(f.service);
      let armStarted = false;
      vi.spyOn(f.service, "requestListenerControl").mockImplementation(
        async (...args) => {
          if (args[1].action === "arm") {
            armStarted = true;
            return new Promise<VersionedListenerReply>(() => {});
          }
          return original(...args);
        },
      );
      const pending = prepareListenerCapture(f.service, f.input);
      const rejected = expect(pending).rejects.toThrow(
        failure === "cancel" ? "cancelled" : "control-timeout",
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(armStarted).toBe(true);
      if (failure === "cancel") f.abort.abort();
      else await vi.advanceTimersByTimeAsync(100);
      await rejected;
      expect(f.calls.map((c) => c.action)).toEqual(["prepare", "cancel"]);
      expect(f.subscribers.size).toBe(0);
    },
  );

  it.each(["denied", "timeout"] as const)(
    "does not claim confirmed cleanup when cancel is %s",
    async (failure) => {
      const f = fixture();
      vi.useFakeTimers();
      const original = f.service.requestListenerControl.bind(f.service);
      vi.spyOn(f.service, "requestListenerControl").mockImplementation(
        async (...args) => {
          if (args[1].action === "cancel" && failure === "timeout")
            return new Promise<VersionedListenerReply>(() => {});
          const reply = await original(...args);
          return args[1].action === "cancel"
            ? {
                ...reply,
                status: "failed",
                reason: "native_stop_ack_timeout",
              }
            : reply;
        },
      );
      const capture = await prepareListenerCapture(f.service, f.input);
      const rejected = expect(capture.result).rejects.toThrow(
        "cancellation could not be confirmed",
      );
      const onset = expect(capture.nativeLaunch).rejects.toThrow();
      f.abort.abort();
      await vi.advanceTimersByTimeAsync(100);
      await rejected;
      await onset;
      await expect(capture.disarm()).rejects.toThrow(
        "cancellation could not be confirmed",
      );
      expect(f.subscribers.size).toBe(0);
      expect(
        f.events.filter((e) => e.attributes.action === "cancel").at(-1)?.name,
      ).toBe("listening.capture.failed");
    },
  );
});
