import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import type { AudioObservation } from "@ableton-agent/protocol";
import { NATIVE_LISTENER_SCOPE } from "@ableton-agent/protocol";
import { createSyntheticNativeListeningFixture } from "@ableton-agent/protocol/testing";
import type { TelemetryEventEnvelope } from "@ableton-agent/observability";
import type {
  ListenerControlInput,
  ListenerControlOptions,
  ListenerDescriptor,
  ListenerReply,
  ListenerResult,
  ListenerResultEvent,
  ListenerService,
} from "@ableton-agent/signal-routing";
import {
  SignalIngressServer,
  InMemoryConnectionRegistry,
  SignalRouter,
  type ListenerControl,
} from "@ableton-agent/signal-routing";
import {
  prepareListenerCapture,
  type PrepareListenerCaptureInput,
} from "./listening-capture.js";

const trace = {
  traceId: "11111111-1111-4111-8111-111111111111",
  correlationId: "22222222-2222-4222-8222-222222222222",
  causationId: "33333333-3333-4333-8333-333333333333",
};
const config = {
  durationMs: 1000,
  maxWindows: 8,
  source: { mode: "session" as const, startBeat: 4, endBeat: 8 },
};
const descriptor = (id: string): ListenerDescriptor => ({
  connectionId: `connection-${id}`,
  binding: { trackId: `track-${id}`, deviceId: `device-${id}` },
  producer: {
    producerId: `producer-${id}`,
    instanceId: `instance-${id}`,
    displayName: id,
    signalKind: "audio",
    schemaVersion: "audio-observation/v1",
    track: { id: `track-${id}` },
    device: { id: `device-${id}` },
  },
  registration: {
    version: 1,
    connectionEpoch: `epoch-${id}`,
    capabilities: ["audio-listener/v1"],
    sampleRate: 48000,
    algorithmVersion: "1.0.0",
  },
  phase: "idle",
});
const observation = (
  listenerId: string,
  passId = "pass",
): AudioObservation => ({
  schema: "audio-observation/v1",
  listenerId,
  passId,
  sampleRate: 48000,
  startSample: 0,
  endSample: 48000,
  startBeat: 4,
  endBeat: 8,
  complete: true,
  limitations: [],
  algorithm: {
    name: "native",
    version: "1.0.0",
    windowSamples: 100,
    hopSamples: 100,
    settings: { attackThresholdDb: 6, minAttackSpacingSamples: 100 },
    units: { amplitude: "linear", rms: "dBFS", centroid: "Hz" },
    timingUncertaintySamples: 0,
  },
  summaries: { peak: [0, 0], rmsDbfs: [null, null], centroidHz: null },
  samples: [],
  attacks: [],
  reduction: { originalSamples: 0, originalAttacks: 0, truncated: false },
});

type MutableDescriptor = {
  -readonly [Key in keyof ListenerDescriptor]: ListenerDescriptor[Key];
};
class FakeService implements ListenerService {
  readonly listeners: MutableDescriptor[];
  readonly subscribers = new Set<(event: ListenerResultEvent) => void>();
  readonly calls: Array<{
    connectionId: string;
    input: ListenerControlInput;
    options?: ListenerControlOptions;
  }> = [];
  readonly log: string[] = [];
  readonly sequences = new Map<string, number>();
  hook?: (
    connectionId: string,
    input: ListenerControlInput,
    reply: ListenerReply,
  ) => ListenerReply | Promise<ListenerReply>;
  unsubscribeFailure = false;
  constructor(ids = ["a", "b"]) {
    this.listeners = ids.map(descriptor);
  }
  inspectListeners(): readonly ListenerDescriptor[] {
    return structuredClone(this.listeners);
  }
  onListenerResult(callback: (event: ListenerResultEvent) => void): () => void {
    this.log.push("subscribe");
    this.subscribers.add(callback);
    return () => {
      this.log.push("unsubscribe");
      this.subscribers.delete(callback);
      if (this.unsubscribeFailure)
        throw new Error("unsubscribe failed Bearer private-token");
    };
  }
  next(connectionId: string): number {
    const sequence = (this.sequences.get(connectionId) ?? -1) + 1;
    this.sequences.set(connectionId, sequence);
    return sequence;
  }
  async requestListenerControl(
    connectionId: string,
    input: ListenerControlInput,
    options?: ListenerControlOptions,
  ): Promise<ListenerReply> {
    this.calls.push({
      connectionId,
      input: structuredClone(input),
      ...(options === undefined ? {} : { options }),
    });
    this.log.push(`${input.action}:${connectionId}`);
    const current = this.listeners.find(
      (item) => item.connectionId === connectionId,
    )!;
    current.phase =
      input.action === "prepare"
        ? "ready"
        : input.action === "arm"
          ? "armed"
          : "idle";
    if (input.action === "cancel") {
      delete current.jobId;
      delete current.passId;
    } else {
      current.jobId = input.jobId;
      current.passId = input.passId;
    }
    const reply: ListenerReply = {
      type: "listener.reply",
      protocolVersion: 1,
      listenerVersion: 1,
      requestId: `reply-${this.calls.length}`,
      connectionEpoch: current.registration.connectionEpoch,
      jobId: input.jobId,
      passId: input.passId,
      ...trace,
      sequence: this.next(connectionId),
      status:
        input.action === "prepare"
          ? "ready"
          : input.action === "arm"
            ? "armed"
            : "cancelled",
    };
    const actual = (await this.hook?.(connectionId, input, reply)) ?? reply;
    if (actual.status === "failed") {
      current.phase = "idle";
      delete current.jobId;
      delete current.passId;
    }
    return actual;
  }
  emit(
    connectionId: string,
    patch: Partial<ListenerResult> = {},
    eventPatch: Partial<ListenerResultEvent> = {},
  ): void {
    const current = this.listeners.find(
      (item) => item.connectionId === connectionId,
    )!;
    const control = this.calls
      .slice()
      .reverse()
      .find(
        (call) =>
          call.connectionId === connectionId && call.input.action !== "cancel",
      )!.input;
    const result: ListenerResult = {
      type: "listener.result",
      protocolVersion: 1,
      listenerVersion: 1,
      requestId: `result-${this.next(connectionId)}`,
      sequence: this.sequences.get(connectionId)!,
      jobId: control.jobId,
      passId: control.passId,
      ...trace,
      connectionEpoch: current.registration.connectionEpoch,
      status: "completed",
      observation: observation(current.producer.producerId),
      ...patch,
    };
    const event: ListenerResultEvent = {
      connectionId,
      binding: current.binding,
      producer: current.producer,
      result,
      ...eventPatch,
    };
    for (const subscriber of this.subscribers) subscriber(event);
    if (["completed", "partial", "failed"].includes(result.status)) {
      current.phase = "idle";
      delete current.jobId;
      delete current.passId;
    }
  }
}

function input(
  service: FakeService,
  abort = new AbortController(),
  patch: Partial<PrepareListenerCaptureInput> = {},
): PrepareListenerCaptureInput {
  return {
    listeners: service.inspectListeners(),
    config,
    passId: "pass",
    trace,
    signal: abort.signal,
    controlTimeoutMs: 100,
    cleanupTimeoutMs: 100,
    resultTimeoutMs: 1000,
    ...patch,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("per-pass native proof admission", () => {
  function nativeService(ids = ["a"]) {
    const service = new FakeService(ids);
    for (const listener of service.listeners)
      listener.registration.nativeStatus = {
        version: 1,
        timing: "UNVERIFIED",
        readiness: "BLOCKED",
        scope: NATIVE_LISTENER_SCOPE,
        reason: "native_per_pass_validation_required",
      };
    const fixture = createSyntheticNativeListeningFixture({
      listenerId: "producer-a",
    });
    service.hook = (_id, control, reply) =>
      control.action === "arm"
        ? { ...reply, nativeArm: fixture.proof.armed }
        : reply;
    const captureInput = input(service, new AbortController(), {
      config: {
        durationMs: 2000,
        maxWindows: 20,
        source: { mode: "arrangement", startBeat: 0, endBeat: 4 },
      },
    });
    return { service, fixture, captureInput };
  }

  it.each([101, 512])(
    "rejects native budget %s before sending any control",
    async (maxWindows) => {
      const { service, captureInput } = nativeService();
      service.hook = (_id, control, reply) => {
        if (control.action === "prepare")
          throw new Error("Invalid native budget reached the device");
        return reply;
      };
      await expect(
        prepareListenerCapture(service, {
          ...captureInput,
          config: { ...captureInput.config, maxWindows },
        }),
      ).rejects.toThrow("unsupported-native-capture-scope");
      expect(service.calls).toHaveLength(0);
      expect(service.subscribers.size).toBe(0);
    },
  );

  it("accepts the native 100-window ceiling without relaxing launch or completion proof", async () => {
    const { service, fixture, captureInput } = nativeService();
    const capture = await prepareListenerCapture(service, {
      ...captureInput,
      config: { ...captureInput.config, maxWindows: 100 },
    });
    service.emit("connection-a", {
      status: "progress",
      observation: undefined,
      nativeLaunch: fixture.proof.launched,
    });
    service.emit("connection-a", {
      observation: fixture.observation,
      nativeCapture: fixture.proof,
    });
    await expect(capture.result).resolves.toEqual([fixture.observation]);
    expect(service.subscribers.size).toBe(0);
  });

  it("requires actual launch and matching complete evidence; native arm telemetry is not onset", async () => {
    const { service, fixture, captureInput } = nativeService();
    const progress: string[] = [];
    const capture = await prepareListenerCapture(service, {
      ...captureInput,
      onProgress: (event) => progress.push(event.stage),
    });
    const launched = vi.fn();
    void capture.nativeLaunch?.then(launched);
    service.emit("connection-a", {
      status: "progress",
      observation: undefined,
      nativeLifecycle: {
        eventId: trace.traceId,
        causationId: trace.causationId,
        nativeEpoch: 1,
        stage: "started",
        elapsedMs: 0,
        frames: 0,
      },
    });
    expect(progress).not.toContain("capturing");
    await Promise.resolve();
    expect(launched).not.toHaveBeenCalled();
    service.emit("connection-a", {
      status: "progress",
      observation: undefined,
    });
    expect(progress).not.toContain("capturing");
    service.emit("connection-a", {
      status: "progress",
      observation: undefined,
      nativeLaunch: fixture.proof.launched,
    });
    await expect(capture.nativeLaunch).resolves.toBeUndefined();
    expect(launched).toHaveBeenCalledOnce();
    service.emit("connection-a", {
      observation: fixture.observation,
      nativeCapture: fixture.proof,
    });
    await expect(capture.result).resolves.toEqual([fixture.observation]);
    expect(service.subscribers.size).toBe(0);
    expect(service.listeners[0]!.registration.nativeStatus).toMatchObject({
      timing: "UNVERIFIED",
      readiness: "BLOCKED",
      scope: NATIVE_LISTENER_SCOPE,
    });
  });

  it("consumes native results queued after the armed wire reply but before its promise resolves", async () => {
    const { service, fixture, captureInput } = nativeService();
    service.hook = (id, control, reply) => {
      if (control.action !== "arm") return reply;
      service.emit(id, {
        status: "progress",
        observation: undefined,
        nativeLaunch: fixture.proof.launched,
      });
      service.emit(id, {
        observation: fixture.observation,
        nativeCapture: fixture.proof,
      });
      return { ...reply, nativeArm: fixture.proof.armed };
    };
    const capture = await prepareListenerCapture(service, captureInput);
    await expect(capture.nativeLaunch).resolves.toBeUndefined();
    await expect(capture.result).resolves.toEqual([fixture.observation]);
    expect(service.subscribers.size).toBe(0);
  });

  it.each(["cancel", "timeout", "disconnect", "invalid-launch"] as const)(
    "rejects the pending native onset receipt on %s and releases the owned capture",
    async (failure) => {
      vi.useFakeTimers();
      const { service, fixture, captureInput } = nativeService();
      const abort = new AbortController();
      const events: TelemetryEventEnvelope[] = [];
      const capture = await prepareListenerCapture(service, {
        ...captureInput,
        signal: abort.signal,
        telemetry: {
          enqueue: (event) => {
            events.push(event);
            return true;
          },
        },
      });
      const onset = expect(capture.nativeLaunch).rejects.toThrow(
        failure === "cancel"
          ? "cancelled"
          : failure === "timeout"
            ? "capture-timeout"
            : failure === "disconnect"
              ? /cancellation could not be confirmed/
              : /native/,
      );
      const result = expect(capture.result).rejects.toThrow();
      if (failure === "cancel") abort.abort();
      else if (failure === "timeout") await vi.advanceTimersByTimeAsync(1000);
      else if (failure === "disconnect") {
        service.listeners[0]!.registration.connectionEpoch = "new-epoch";
        await vi.advanceTimersByTimeAsync(100);
      } else {
        service.emit("connection-a", {
          status: "progress",
          observation: undefined,
          nativeLaunch: { ...fixture.proof.launched, nativeEpoch: 2 },
        });
      }
      await onset;
      await result;
      if (failure === "disconnect")
        await expect(capture.nativeLaunch).rejects.toMatchObject({
          errors: [
            expect.objectContaining({
              code: "listener-disconnected-or-epoch-changed",
            }),
            expect.objectContaining({ code: "cannot-cancel-stale-instance" }),
          ],
        });
      expect(service.subscribers.size).toBe(0);
      const lifecycle = events.filter(
        (event) => event.attributes?.action === "native-onset",
      );

      expect(lifecycle.map((event) => event.name)).toEqual([
        "listening.capture.queued",
        "listening.capture.started",
        failure === "cancel"
          ? "listening.capture.cancelled"
          : "listening.capture.failed",
      ]);
      expect(
        lifecycle.every(
          (event) =>
            event.trace?.traceId === trace.traceId &&
            event.correlationId === trace.correlationId &&
            event.causationId === trace.causationId &&
            Number.isFinite(event.durationMs),
        ),
      ).toBe(true);
    },
  );

  it("waits for every scoped listener, not the first proof or an unrelated legacy progress event", async () => {
    const { service, fixture, captureInput } = nativeService(["a", "b", "c"]);
    delete service.listeners[2]!.registration.nativeStatus;
    const hook = service.hook!;
    service.hook = (id, control, reply) =>
      id === "connection-c" ? reply : hook(id, control, reply);
    const capture = await prepareListenerCapture(service, {
      ...captureInput,
      listeners: service.inspectListeners(),
    });
    const launched = vi.fn();
    void capture.nativeLaunch?.then(launched);
    service.emit("connection-c", {
      status: "progress",
      observation: undefined,
    });
    service.emit("connection-a", {
      status: "progress",
      observation: undefined,
      nativeLaunch: fixture.proof.launched,
    });
    await Promise.resolve();
    expect(launched).not.toHaveBeenCalled();
    service.emit("connection-b", {
      status: "progress",
      observation: undefined,
      nativeLaunch: fixture.proof.launched,
    });
    await expect(capture.nativeLaunch).resolves.toBeUndefined();
    expect(launched).toHaveBeenCalledOnce();
    await capture.disarm();
    expect(service.subscribers.size).toBe(0);
    expect(
      service.calls.filter((call) => call.input.action === "cancel"),
    ).toHaveLength(3);
  });

  it("cancels a scoped launched pass once and releases all subscriptions", async () => {
    const { service, fixture, captureInput } = nativeService();
    const abort = new AbortController();
    const capture = await prepareListenerCapture(service, {
      ...captureInput,
      signal: abort.signal,
    });
    service.emit("connection-a", {
      status: "progress",
      observation: undefined,
      nativeLaunch: fixture.proof.launched,
    });
    abort.abort();
    await expect(capture.result).rejects.toThrow("cancelled");
    await capture.disarm();
    await capture.disarm();
    expect(
      service.calls.filter((call) => call.input.action === "cancel"),
    ).toHaveLength(1);
    expect(service.subscribers.size).toBe(0);
  });

  it.each([
    "missing-launch",
    "missing-proof",
    "changed-arm",
    "fft-future",
    "post-offset",
    "duplicate-launch",
  ])("fails closed and cleans up %s", async (kind) => {
    const { service, fixture, captureInput } = nativeService();
    const capture = await prepareListenerCapture(service, captureInput);
    if (kind !== "missing-launch")
      service.emit("connection-a", {
        status: "progress",
        observation: undefined,
        nativeLaunch: fixture.proof.launched,
      });
    if (kind === "changed-arm") fixture.proof.armed.nativeEpoch++;
    if (kind === "fft-future") fixture.proof.spectralWindows[0]![1] += 4800;
    if (kind === "post-offset")
      for (const row of fixture.proof.after.frames) {
        row[2]++;
        row[9]++;
      }
    if (kind === "duplicate-launch")
      service.emit("connection-a", {
        status: "progress",
        observation: undefined,
        nativeLaunch: fixture.proof.launched,
      });
    else
      service.emit("connection-a", {
        observation: fixture.observation,
        ...(kind === "missing-proof" ? {} : { nativeCapture: fixture.proof }),
      });
    await expect(capture.result).rejects.toThrow(/native[-_]/);
    expect(service.subscribers.size).toBe(0);
  });

  it("rejects a ready claim without native arm evidence and compensates the exact instance", async () => {
    const { service, captureInput } = nativeService();
    delete service.hook;
    await expect(prepareListenerCapture(service, captureInput)).rejects.toThrow(
      "native-arm-proof-required",
    );
    expect(service.calls.map((call) => call.input.action)).toEqual([
      "prepare",
      "arm",
      "cancel",
    ]);
    expect(service.subscribers.size).toBe(0);
  });

  it("guards unsupported scope before any controls and fences scope changes after preparation", async () => {
    const { service, captureInput } = nativeService();
    const events: TelemetryEventEnvelope[] = [];
    await expect(
      prepareListenerCapture(service, {
        ...captureInput,
        config,
        telemetry: {
          enqueue(event) {
            events.push(event);
            return true;
          },
        },
      }),
    ).rejects.toThrow("unsupported-native-capture-scope");
    expect(service.calls).toEqual([]);
    expect(events.map((event) => event.name)).toEqual([
      "listening.capture.queued",
      "listening.capture.failed",
    ]);
    expect(events[1]).toMatchObject({
      trace: { traceId: trace.traceId },
      correlationId: trace.correlationId,
      causationId: trace.causationId,
      attributes: { passId: "pass", code: "unsupported-native-capture-scope" },
    });
    const capture = await prepareListenerCapture(service, captureInput);
    delete service.listeners[0]!.registration.nativeStatus!.scope;
    service.emit("connection-a", {
      status: "progress",
      observation: undefined,
    });
    await expect(capture.result).rejects.toThrow();
    expect(service.subscribers.size).toBe(0);
  });
});

describe("concrete shared-ingress capture adapter", () => {
  it("subscribes before controls, buffers immediate completion, arms all, and retains selected result order", async () => {
    const service = new FakeService();
    service.hook = (id, control, reply) => {
      if (control.action === "arm") service.emit(id);
      return reply;
    };
    const capture = await prepareListenerCapture(service, input(service));
    expect(service.log[0]).toBe("subscribe");
    expect(service.calls.map((call) => call.input.action)).toEqual([
      "prepare",
      "prepare",
      "arm",
      "arm",
    ]);
    const observations = await capture.result;
    expect(observations.map((item) => item.listenerId)).toEqual([
      "producer-a",
      "producer-b",
    ]);
    expect(capture.passId).toBe("pass");
    for (const call of service.calls) {
      expect(call.input).toMatchObject({
        ...trace,
        jobId: capture.jobId,
        passId: "pass",
      });
      expect(call.options?.signal).toBeUndefined();
      expect(call.input.config).toEqual(
        call.input.action === "prepare" ? config : undefined,
      );
    }
    await capture.disarm();
    await capture.disarm();
    expect(
      service.calls.filter((call) => call.input.action === "cancel"),
    ).toHaveLength(0);
    expect(service.subscribers.size).toBe(0);
  });

  it("waits for every complete observation and reports bounded lifecycle/trace without per-sample spam", async () => {
    const service = new FakeService();
    const events: TelemetryEventEnvelope[] = [];
    const progress: string[] = [];
    const capture = await prepareListenerCapture(
      service,
      input(service, undefined, {
        telemetry: {
          enqueue(event) {
            events.push(event);
            return true;
          },
        },
        onProgress: (value) => progress.push(value.stage),
      }),
    );
    for (let index = 0; index < 100; index++)
      service.emit("connection-a", {
        status: "progress",
        observation: undefined,
      });
    service.emit("connection-b");
    expect(service.subscribers.size).toBe(1);
    service.emit("connection-a");
    expect(await capture.result).toHaveLength(2);
    expect(progress.filter((stage) => stage === "capturing")).toHaveLength(3);
    expect(
      events.some((event) => event.name === "listening.capture.queued"),
    ).toBe(true);
    expect(
      events.some((event) => event.name === "listening.capture.started"),
    ).toBe(true);
    expect(events.at(-1)?.name).toBe("listening.capture.completed");
    expect(
      events.every(
        (event) =>
          event.trace?.traceId === trace.traceId &&
          event.correlationId === trace.correlationId &&
          event.causationId === trace.causationId &&
          (event.durationMs ?? -1) >= 0,
      ),
    ).toBe(true);
    expect(service.subscribers.size).toBe(0);
  });

  it.each(["prepare", "arm"] as const)(
    "compensates all prepared/armed instances when %s fails closed",
    async (action) => {
      const service = new FakeService();
      service.hook = (id, control, reply) =>
        id === "connection-b" && control.action === action
          ? {
              ...reply,
              status: "failed",
              reason: "real_live_timing_validation_required",
            }
          : reply;
      await expect(
        prepareListenerCapture(service, input(service)),
      ).rejects.toThrow("real_live_timing_validation_required");
      expect(
        service.calls
          .filter((call) => call.input.action === "cancel")
          .map((call) => call.connectionId),
      ).toEqual(
        action === "prepare"
          ? ["connection-a"]
          : ["connection-a", "connection-b"],
      );
      expect(service.subscribers.size).toBe(0);
    },
  );

  it.each([
    { timing: "UNVERIFIED", readiness: "BLOCKED" },
    { timing: "UNVERIFIED", readiness: "READY" },
    { timing: "VERIFIED", readiness: "BLOCKED" },
  ])("rejects native status before any controls: %j", async (status) => {
    const service = new FakeService();
    Object.assign(service.listeners[0]!.registration, {
      deviceCanonicalPath: "live_set tracks 0 devices 0",
      trackCanonicalPath: "live_set tracks 0",
      nativeStatus: {
        version: 1,
        ...status,
        reason: "real_live_timing_validation_required",
      },
    });
    await expect(
      prepareListenerCapture(service, input(service)),
    ).rejects.toThrow("real_live_timing_validation_required");
    expect(service.calls).toHaveLength(0);
    expect(service.subscribers.size).toBe(0);
  });

  it("native status becoming blocked during preparation prevents arming and compensates", async () => {
    const service = new FakeService();
    service.hook = (id, control, reply) => {
      if (id === "connection-b" && control.action === "prepare")
        Object.assign(service.listeners[0]!.registration, {
          nativeStatus: {
            version: 1,
            timing: "UNVERIFIED",
            readiness: "BLOCKED",
            reason: "real_live_timing_validation_required",
          },
        });
      return reply;
    };
    await expect(
      prepareListenerCapture(service, input(service)),
    ).rejects.toThrow("real_live_timing_validation_required");
    expect(service.calls.some((call) => call.input.action === "arm")).toBe(
      false,
    );
    expect(
      service.calls
        .filter((call) => call.input.action === "cancel")
        .map((call) => call.connectionId),
    ).toEqual(["connection-a", "connection-b"]);
    expect(service.subscribers.size).toBe(0);
  });

  it.each(["prepare", "arm"] as const)(
    "cancellation during %s compensates in-flight ownership without passing aborted signal to cancel",
    async (action) => {
      const service = new FakeService();
      const abort = new AbortController();
      service.hook = (_id, control, reply) => {
        if (control.action === action) abort.abort();
        return reply;
      };
      await expect(
        prepareListenerCapture(service, input(service, abort)),
      ).rejects.toThrow("cancelled");
      const cancels = service.calls.filter(
        (call) => call.input.action === "cancel",
      );
      expect(cancels.length).toBeGreaterThan(0);
      expect(
        cancels.every(
          (call) =>
            call.options?.signal === undefined &&
            call.input.traceId === trace.traceId &&
            call.input.passId === "pass",
        ),
      ).toBe(true);
      expect(service.subscribers.size).toBe(0);
    },
  );

  it("cancellation during capture disarms actual instances idempotently and removes all timers", async () => {
    vi.useFakeTimers();
    const service = new FakeService();
    const abort = new AbortController();
    const capture = await prepareListenerCapture(
      service,
      input(service, abort),
    );
    const rejected = expect(capture.result).rejects.toThrow("cancelled");
    abort.abort();
    await capture.disarm();
    await capture.disarm();
    await rejected;
    expect(
      service.calls
        .filter((call) => call.input.action === "cancel")
        .map((call) => call.connectionId),
    ).toEqual(["connection-a", "connection-b"]);
    expect(service.subscribers.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { durationMs: 120001 },
    { maxWindows: 513 },
    { maxWindows: 0 },
    { fftSettings: { window: 2048 } },
    { source: { mode: "session", startBeat: 8, endBeat: 4 } },
  ])(
    "rejects unsupported settings/quotas before any subscription/control: %j",
    async (patch) => {
      const service = new FakeService();
      await expect(
        prepareListenerCapture(
          service,
          input(service, undefined, {
            config: {
              ...config,
              ...patch,
            } as PrepareListenerCaptureInput["config"],
          }),
        ),
      ).rejects.toThrow();
      expect(service.calls).toEqual([]);
      expect(service.log).toEqual([]);
    },
  );

  it("guards idle readiness, initial epoch/instance snapshot, duplicate listeners and empty selection", async () => {
    for (const mutate of [
      (service: FakeService) => {
        service.listeners[0]!.phase = "armed";
      },
      (service: FakeService) => {
        service.listeners[0]!.registration.connectionEpoch = "new";
      },
      (service: FakeService) => {
        service.listeners[0]!.producer.instanceId = "new";
      },
    ]) {
      const service = new FakeService();
      const selected = input(service);
      mutate(service);
      await expect(prepareListenerCapture(service, selected)).rejects.toThrow();
      expect(service.calls).toHaveLength(0);
    }
    const service = new FakeService();
    await expect(
      prepareListenerCapture(
        service,
        input(service, undefined, { listeners: [] }),
      ),
    ).rejects.toThrow("quota");
    await expect(
      prepareListenerCapture(
        service,
        input(service, undefined, {
          listeners: [service.listeners[0]!, service.listeners[0]!],
        }),
      ),
    ).rejects.toThrow("duplicate");
  });

  it.each([
    { passId: "stale-pass" },
    { jobId: "stale-job" },
    { connectionEpoch: "stale-epoch" },
    { traceId: "stale-trace" },
    { correlationId: "stale-correlation" },
    { causationId: "stale-cause" },
    { sequence: 20 },
  ])(
    "rejects stale result ownership/epochs/sequence and compensates: %j",
    async (patch) => {
      const service = new FakeService();
      const capture = await prepareListenerCapture(service, input(service));
      const rejected = expect(capture.result).rejects.toThrow();
      service.emit("connection-a", patch);
      await rejected;
      expect(
        service.calls.filter((call) => call.input.action === "cancel"),
      ).toHaveLength(2);
      expect(service.subscribers.size).toBe(0);
    },
  );

  it.each([
    { listenerId: "foreign-producer" },
    { passId: "foreign-pass" },
    { sampleRate: 44100 },
    { algorithm: { ...observation("producer-a").algorithm, version: "other" } },
    { complete: false },
    { endBeat: 7 },
    { endSample: 0 },
    { endSample: 48001 },
  ])(
    "rejects canonical-but-wrong observation attribution/coverage/quota: %j",
    async (patch) => {
      const service = new FakeService();
      const capture = await prepareListenerCapture(service, input(service));
      const rejected = expect(capture.result).rejects.toThrow();
      service.emit("connection-a", {
        observation: { ...observation("producer-a"), ...patch },
      });
      await rejected;
      expect(service.subscribers.size).toBe(0);
    },
  );

  it.each(["partial", "failed"] as const)(
    "explicit %s fails the pass and compensates remaining listeners",
    async (status) => {
      const service = new FakeService();
      const capture = await prepareListenerCapture(service, input(service));
      const rejected = expect(capture.result).rejects.toThrow("disconnected");
      service.emit("connection-a", {
        status,
        observation: undefined,
        reason: "disconnected",
      });
      await rejected;
      expect(
        service.calls
          .filter((call) => call.input.action === "cancel")
          .map((call) => call.connectionId),
      ).toEqual(["connection-b"]);
    },
  );

  it("rejects envelope producer/connection mismatches and ignores unrelated MIDI/audio producers", async () => {
    const service = new FakeService();
    const capture = await prepareListenerCapture(service, input(service));
    for (const callback of service.subscribers)
      callback({
        connectionId: "unrelated",
        producer: descriptor("outside").producer,
        binding: descriptor("outside").binding,
        result: {} as ListenerResult,
      });
    expect(service.subscribers.size).toBe(1);
    const rejected = expect(capture.result).rejects.toThrow(
      "result-connection-changed",
    );
    service.emit("connection-a", {}, { connectionId: "reconnected" });
    await rejected;
  });

  it("polling rejects disconnect/epoch replacement and never cancels a replacement instance", async () => {
    vi.useFakeTimers();
    for (const change of ["disconnect", "epoch", "instance"]) {
      const service = new FakeService();
      const capture = await prepareListenerCapture(service, input(service));
      const rejected = expect(capture.result).rejects.toThrow(
        "cancellation could not be confirmed",
      );
      if (change === "disconnect") service.listeners.shift();
      if (change === "epoch")
        service.listeners[0]!.registration.connectionEpoch = "replacement";
      if (change === "instance")
        service.listeners[0]!.producer.instanceId = "replacement";
      await vi.advanceTimersByTimeAsync(100);
      await rejected;
      expect(
        service.calls
          .filter((call) => call.input.action === "cancel")
          .map((call) => call.connectionId),
      ).toEqual(["connection-b"]);
      await expect(capture.disarm()).rejects.toThrow("could not be confirmed");
      expect(service.subscribers.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it("capture timeout cancels all and cleans waiters/timers", async () => {
    vi.useFakeTimers();
    const service = new FakeService();
    const capture = await prepareListenerCapture(service, input(service));
    const rejected = expect(capture.result).rejects.toThrow("capture-timeout");
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    expect(
      service.calls.filter((call) => call.input.action === "cancel"),
    ).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
    expect(service.subscribers.size).toBe(0);
  });

  it("control timeout compensates attempted instance; late readiness never resolves success", async () => {
    vi.useFakeTimers();
    const service = new FakeService(["a"]);
    let late!: (reply: ListenerReply) => void;
    let saved!: ListenerReply;
    service.hook = (_id, control, reply) =>
      control.action === "prepare"
        ? new Promise<ListenerReply>((resolve) => {
            late = resolve;
            saved = reply;
          })
        : reply;
    const pending = prepareListenerCapture(service, input(service));
    const rejected = expect(pending).rejects.toThrow("control-timeout");
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    late(saved);
    await Promise.resolve();
    expect(service.calls.map((call) => call.input.action)).toEqual([
      "prepare",
      "cancel",
    ]);
    expect(service.subscribers.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("failed/hung cleanup remains observable and idempotent, with secrets redacted", async () => {
    const service = new FakeService();
    const events: TelemetryEventEnvelope[] = [];
    const capture = await prepareListenerCapture(
      service,
      input(service, undefined, {
        telemetry: {
          enqueue(event) {
            events.push(event);
            return true;
          },
        },
      }),
    );
    service.hook = (_id, control, reply) =>
      control.action === "cancel"
        ? Promise.reject(new Error("cancel failed Bearer super-private-token"))
        : reply;
    const rejected = expect(capture.result).rejects.toThrow(
      "cancellation could not be confirmed",
    );
    await expect(capture.disarm()).rejects.toThrow("could not be confirmed");
    await rejected;
    await expect(capture.disarm()).rejects.toThrow("could not be confirmed");
    expect(
      service.calls.filter((call) => call.input.action === "cancel"),
    ).toHaveLength(2);
    expect(JSON.stringify(events)).not.toContain("super-private-token");
    expect(service.subscribers.size).toBe(0);
  });

  it("a hung cancellation has a finite deadline", async () => {
    vi.useFakeTimers();
    const service = new FakeService(["a"]);
    const capture = await prepareListenerCapture(service, input(service));
    service.hook = (_id, control, reply) =>
      control.action === "cancel"
        ? new Promise<ListenerReply>(() => {})
        : reply;
    const rejected = expect(capture.result).rejects.toThrow();
    const cleanup = expect(capture.disarm()).rejects.toThrow(
      "could not be confirmed",
    );
    await vi.advanceTimersByTimeAsync(100);
    await cleanup;
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
    expect(service.subscribers.size).toBe(0);
  });

  it("bounded early-result buffering and progress quotas reject overflow explicitly", async () => {
    const service = new FakeService(["a"]);
    service.hook = (id, control, reply) => {
      if (control.action === "arm")
        for (let index = 0; index < 33; index++)
          service.emit(id, { status: "progress", observation: undefined });
      return reply;
    };
    await expect(
      prepareListenerCapture(service, input(service)),
    ).rejects.toThrow("buffer-overflow");
    expect(service.subscribers.size).toBe(0);
    const running = new FakeService(["a"]);
    const capture = await prepareListenerCapture(running, input(running));
    const rejected = expect(capture.result).rejects.toThrow("result-overflow");
    for (let index = 0; index < 1025; index++)
      running.emit("connection-a", {
        status: "progress",
        observation: undefined,
      });
    await rejected;
    expect(running.subscribers.size).toBe(0);
  });

  it("unsubscribe failures cannot become success or swallowed cleanup", async () => {
    const service = new FakeService(["a"]);
    const capture = await prepareListenerCapture(service, input(service));
    service.unsubscribeFailure = true;
    const rejected = expect(capture.result).rejects.toThrow();
    service.emit("connection-a");
    await rejected;
    await expect(capture.disarm()).rejects.toThrow("could not be confirmed");
    expect(service.subscribers.size).toBe(0);
  });

  it("caller descriptor/config/trace mutations cannot change captured ownership", async () => {
    const service = new FakeService(["a"]);
    const mutableTrace = { ...trace };
    const supplied = input(service, undefined, {
      trace: mutableTrace,
      config: structuredClone(config),
    });
    const capture = await prepareListenerCapture(service, supplied);
    mutableTrace.traceId = "changed";
    supplied.config.source.endBeat = 100;
    supplied.listeners[0]!.registration.connectionEpoch = "changed";
    service.emit("connection-a");
    expect(await capture.result).toHaveLength(1);
  });

  it.each([{ connectionEpoch: "old" }, { passId: "old" }, { status: "armed" }])(
    "readiness replies cannot claim success with stale ownership or wrong action: %j",
    async (patch) => {
      const service = new FakeService(["a"]);
      service.hook = (_id, control, reply) =>
        control.action === "prepare"
          ? ({ ...reply, ...patch } as ListenerReply)
          : reply;
      await expect(
        prepareListenerCapture(service, input(service)),
      ).rejects.toThrow();
      expect(service.calls.map((call) => call.input.action)).toEqual([
        "prepare",
        "cancel",
      ]);
      expect(service.subscribers.size).toBe(0);
    },
  );

  it("rejects producer instance mutation in results, byte overflow, and excessive observation windows", async () => {
    for (const variant of ["instance", "bytes", "windows"]) {
      const service = new FakeService(["a"]);
      const capture = await prepareListenerCapture(service, input(service));
      const rejected = expect(capture.result).rejects.toThrow();
      if (variant === "instance")
        service.emit(
          "connection-a",
          {},
          {
            producer: {
              ...service.listeners[0]!.producer,
              instanceId: "foreign",
            },
          },
        );
      if (variant === "bytes")
        service.emit("connection-a", { reason: "x".repeat(128 * 1024 + 1) });
      if (variant === "windows")
        service.emit("connection-a", {
          observation: {
            ...observation("producer-a"),
            samples: Array.from({ length: 9 }, (_, index) => ({
              sample: index * 100,
              beat: 4,
              peak: [0, 0] as [number, number],
              rmsDbfs: [null, null] as [null, null],
              centroidHz: null,
            })),
            reduction: {
              originalSamples: 9,
              originalAttacks: 0,
              truncated: false,
            },
          },
        });
      await rejected;
      expect(service.subscribers.size).toBe(0);
    }
  });

  it("already-aborted input, invalid trace and excessive selections do not dispatch controls", async () => {
    const service = new FakeService();
    const abort = new AbortController();
    abort.abort();
    await expect(
      prepareListenerCapture(service, input(service, abort)),
    ).rejects.toThrow("cancelled");
    await expect(
      prepareListenerCapture(
        service,
        input(service, undefined, {
          trace: { ...trace, traceId: "not-a-uuid" },
        }),
      ),
    ).rejects.toThrow("invalid-trace");
    const many = new FakeService(
      Array.from({ length: 9 }, (_, index) => String(index)),
    );
    await expect(prepareListenerCapture(many, input(many))).rejects.toThrow(
      "quota",
    );
    expect(service.calls).toHaveLength(0);
    expect(service.subscribers.size).toBe(0);
    expect(many.calls).toHaveLength(0);
  });

  it("last-arm epoch change and progress callback failure cannot return a prepared handle", async () => {
    const service = new FakeService(["a"]);
    service.hook = (_id, control, reply) => {
      if (control.action === "arm")
        service.listeners[0]!.registration.connectionEpoch = "replacement";
      return reply;
    };
    await expect(
      prepareListenerCapture(service, input(service)),
    ).rejects.toThrow();
    expect(
      service.calls.filter((call) => call.input.action === "cancel"),
    ).toHaveLength(0);
    expect(service.subscribers.size).toBe(0);
    const observer = new FakeService(["a"]);
    await expect(
      prepareListenerCapture(
        observer,
        input(observer, undefined, {
          onProgress() {
            throw new Error("progress callback password=private-value");
          },
        }),
      ),
    ).rejects.toThrow("progress callback");
    expect(observer.calls.map((call) => call.input.action)).toEqual([
      "prepare",
      "cancel",
    ]);
    expect(observer.subscribers.size).toBe(0);
  });

  it("uses the existing authenticated loopback ingress end-to-end (scripted simulator, not DSP certification)", async () => {
    interface Client {
      producer: { producerId: string };
      configureProducer(value: unknown): void;
      start(): void;
      stop(): void;
      sendListenerReply(
        control: ListenerControl,
        reply: { status: string },
      ): boolean;
      sendListenerResult(
        control: ListenerControl,
        result: { status: string; observation: AudioObservation },
      ): boolean;
    }
    const require = createRequire(import.meta.url);
    const { AgentSignalClient } =
      require("../../../max-patches/shared/agent_signal_client.js") as {
        AgentSignalClient: new (options: Record<string, unknown>) => Client;
      };
    const registry = new InMemoryConnectionRegistry({ staleAfterMs: 15000 });
    const secret = "capture-adapter-real-socket-secret-at-least32";
    const server = new SignalIngressServer({
      secret,
      registry,
      router: new SignalRouter({ registry }),
      port: 0,
    });
    const endpoint = await server.start();
    const client = new AgentSignalClient({
      secret,
      descriptorPath: "scripted-simulator.json",
      signalKind: "audio",
      schemaVersion: "audio-observation/v1",
      listener: {
        version: 1,
        capabilities: ["audio-listener/v1"],
        sampleRate: 48000,
        algorithmVersion: "1.0.0",
        deviceCanonicalPath: "live_set tracks 0 devices 0",
        trackCanonicalPath: "live_set tracks 0",
        // Scripted transport model, not native timing certification.
        nativeStatus: { version: 1, timing: "VERIFIED", readiness: "READY" },
      },
      readText: async () =>
        JSON.stringify({
          ...endpoint,
          protocol: "newline-delimited-json",
          protocolVersion: 1,
          maxFrameBytes: 128 * 1024,
          listenerVersions: [1],
          listenerCapabilities: ["audio-listener/v1"],
        }),
      onListenerControl(control: ListenerControl) {
        client.sendListenerReply(control, {
          status:
            control.action === "prepare"
              ? "ready"
              : control.action === "arm"
                ? "armed"
                : "cancelled",
        });
        if (control.action === "arm")
          client.sendListenerResult(control, {
            status: "completed",
            observation: observation(
              client.producer.producerId,
              control.passId,
            ),
          });
      },
    });
    client.configureProducer({
      canonicalPath: "live_set tracks 0 devices 0",
      track: { id: "1", name: "Simulator" },
      device: { id: "2", name: "Simulator" },
    });
    try {
      client.start();
      await expect.poll(() => server.inspectListeners().length).toBe(1);
      const capture = await prepareListenerCapture(server, {
        listeners: server.inspectListeners(),
        config,
        passId: "pass",
        trace,
        signal: new AbortController().signal,
      });
      expect((await capture.result)[0]!.listenerId).toBe(
        client.producer.producerId,
      );
      await capture.disarm();
    } finally {
      client.stop();
      await server.stop();
    }
  });
});
