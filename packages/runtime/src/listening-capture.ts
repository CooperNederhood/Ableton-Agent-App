import { randomUUID } from "node:crypto";
import {
  audioObservationSchema,
  assertNativeCaptureObservation,
  nativeLaunchCoordinates,
  NATIVE_LISTENER_SCOPE,
  type AudioObservation,
  type NativeArmProof,
  type NativeLaunchProof,
} from "@ableton-agent/protocol";
import {
  sanitizePersistedText,
  sanitizeTelemetryAttributes,
  telemetryIdSchema,
  type NonBlockingObservabilityRecorder,
} from "@ableton-agent/observability";
import {
  DEFAULT_MAX_INGRESS_FRAME_BYTES,
  listenerConfigSchema,
  listenerControlInputSchema,
  listenerRegistrationSchema,
  listenerReplySchema,
  listenerResultSchema,
  outputProducerSchema,
  recordSignalTelemetry,
  stableTelemetryId,
  type ListenerControlInput,
  type ListenerDescriptor,
  type ListenerReply,
  type ListenerResult,
  type ListenerResultEvent,
  type ListenerService,
} from "@ableton-agent/signal-routing";

export interface ListeningCaptureProgress {
  readonly stage:
    "preparing" | "arming" | "capturing" | "completed" | "cancelling";
  readonly listenerCount: number;
  readonly readyCount: number;
  readonly armedCount: number;
  readonly completedCount: number;
}

export interface PrepareListenerCaptureInput {
  readonly listeners: readonly ListenerDescriptor[];
  readonly config: NonNullable<ListenerControlInput["config"]>;
  readonly passId: string;
  readonly trace: {
    readonly traceId: string;
    readonly correlationId: string;
    readonly causationId: string;
  };
  readonly signal: AbortSignal;
  readonly telemetry?: Pick<NonBlockingObservabilityRecorder, "enqueue">;
  readonly onProgress?: (progress: ListeningCaptureProgress) => void;
  readonly controlTimeoutMs?: number;
  readonly cleanupTimeoutMs?: number;
  readonly resultTimeoutMs?: number;
}

export interface PreparedListeningCapture {
  readonly jobId: string;
  readonly passId: string;
  readonly result: Promise<readonly AudioObservation[]>;
  /** Present for scoped native listeners; resolves only after every scoped launch proof validates. */
  readonly nativeLaunch?: Promise<void>;
  /** Idempotent confirmed cancellation; rejects if any exact instance cannot be disarmed. */
  disarm(): Promise<void>;
}

export class ListeningCaptureError extends Error {
  constructor(
    readonly code: string,
    detail: string = code,
  ) {
    super(sanitizePersistedText(detail).slice(0, 512));
    this.name = "ListeningCaptureError";
  }
}

interface SelectedListener {
  readonly descriptor: ListenerDescriptor;
  stage: "idle" | "preparing" | "ready" | "arming" | "armed";
  attempted: boolean;
  terminal: boolean;
  sequence: number;
  resultCount: number;
  bufferedBytes: number;
  readonly buffered: ListenerResult[];
  progressSeen: boolean;
  observation?: AudioObservation;
  nativeArm?: NativeArmProof;
  nativeLaunch?: NativeLaunchProof;
}

function error(value: unknown, code: string): ListeningCaptureError {
  return value instanceof ListeningCaptureError
    ? value
    : new ListeningCaptureError(
        code,
        value instanceof Error ? value.message : code,
      );
}

function bounded<T>(
  operation: Promise<T>,
  timeoutMs: number,
): { promise: Promise<T>; release(): void } {
  let release = (): void => {};
  const promise = new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new ListeningCaptureError("control-timeout")),
      timeoutMs,
    );
    release = () => {
      clearTimeout(timer);
    };
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (reason: unknown) => {
        clearTimeout(timer);
        reject(error(reason, "control-failed"));
      },
    );
  });
  return {
    promise,
    release: () => {
      release();
    },
  };
}

function sameInstance(
  current: ListenerDescriptor,
  selected: ListenerDescriptor,
): boolean {
  return (
    current.connectionId === selected.connectionId &&
    current.producer.producerId === selected.producer.producerId &&
    current.producer.instanceId === selected.producer.instanceId &&
    current.producer.signalKind === "audio" &&
    current.producer.schemaVersion === "audio-observation/v1" &&
    current.registration.connectionEpoch ===
      selected.registration.connectionEpoch &&
    current.registration.algorithmVersion ===
      selected.registration.algorithmVersion &&
    current.registration.sampleRate === selected.registration.sampleRate &&
    current.registration.nativeStatus?.scope ===
      selected.registration.nativeStatus?.scope &&
    current.binding.trackId === selected.binding.trackId &&
    current.binding.deviceId === selected.binding.deviceId
  );
}

function assertNativeReadiness(
  registration: ListenerDescriptor["registration"],
): void {
  const status: unknown = Reflect.get(registration, "nativeStatus");
  if (typeof status !== "object" || status === null) return;
  // Scope permits fresh per-pass validation, not a timing/readiness assertion.
  if (Reflect.get(status, "scope") === NATIVE_LISTENER_SCOPE) return;
  if (
    Reflect.get(status, "timing") === "UNVERIFIED" ||
    Reflect.get(status, "readiness") === "BLOCKED"
  )
    throw new ListeningCaptureError("real_live_timing_validation_required");
}

class Capture implements PreparedListeningCapture {
  readonly jobId = randomUUID();
  readonly passId: string;
  readonly result: Promise<readonly AudioObservation[]>;
  readonly nativeLaunch?: Promise<void>;
  readonly #selected: SelectedListener[];
  readonly #startedAt = Date.now();
  readonly #config: NonNullable<ListenerControlInput["config"]>;
  readonly #trace: PrepareListenerCaptureInput["trace"];
  readonly #controlTimeout: number;
  readonly #cleanupTimeout: number;
  readonly #resultTimeout: number;
  readonly #failureGate: Promise<never>;
  #rejectGate!: (reason: Error) => void;
  #resolveResult!: (observations: readonly AudioObservation[]) => void;
  #rejectResult!: (reason: Error) => void;
  #resolveNativeLaunch: (() => void) | undefined;
  #rejectNativeLaunch: ((reason: Error) => void) | undefined;
  #nativeLaunched = false;
  #unsubscribe: (() => void) | undefined;
  #poll: ReturnType<typeof setInterval> | undefined;
  #deadline: ReturnType<typeof setTimeout> | undefined;
  #failure: Error | undefined;
  #releaseFailure: ListeningCaptureError | undefined;
  #failureTask: Promise<void> | undefined;
  #cleanupTask: Promise<void> | undefined;
  #finished = false;
  #allArmed = false;

  constructor(
    readonly service: ListenerService,
    readonly input: PrepareListenerCaptureInput,
  ) {
    this.passId = input.passId;
    this.#trace = { ...input.trace };
    this.#config = listenerConfigSchema.parse(input.config);
    this.#controlTimeout = this.#timeout(input.controlTimeoutMs ?? 5000, 10000);
    this.#cleanupTimeout = this.#timeout(input.cleanupTimeoutMs ?? 2000, 5000);
    this.#resultTimeout = this.#timeout(
      input.resultTimeoutMs ?? this.#config.durationMs + 5000,
      125000,
    );
    if (!telemetryIdSchema.safeParse(input.trace.traceId).success)
      throw new ListeningCaptureError("invalid-trace");
    listenerControlInputSchema.parse({
      ...input.trace,
      jobId: this.jobId,
      passId: this.passId,
      action: "prepare",
      config: this.#config,
    });
    if (input.listeners.length < 1 || input.listeners.length > 8)
      throw new ListeningCaptureError("listener-quota");
    const connections = new Set<string>(),
      producers = new Set<string>(),
      instances = new Set<string>();
    this.#selected = input.listeners.map((original) => {
      const descriptor = structuredClone(original);
      outputProducerSchema.parse(descriptor.producer);
      assertNativeReadiness(descriptor.registration);
      listenerRegistrationSchema.parse(descriptor.registration);
      if (
        descriptor.registration.nativeStatus?.scope === NATIVE_LISTENER_SCOPE
      ) {
        const source = this.#config.source;
        if (
          source.mode !== "arrangement" ||
          source.startBeat !== 0 ||
          source.endBeat > 20 ||
          !Number.isInteger(source.endBeat * 5) ||
          this.#config.durationMs < Math.round(source.endBeat * 5) * 100 ||
          this.#config.durationMs > 10000 ||
          this.#config.maxWindows < source.endBeat * 5 ||
          descriptor.registration.sampleRate !== 48000
        )
          throw new ListeningCaptureError("unsupported-native-capture-scope");
      }
      if (
        !descriptor.connectionId ||
        descriptor.connectionId.length > 128 ||
        descriptor.phase !== "idle" ||
        descriptor.jobId !== undefined ||
        descriptor.passId !== undefined ||
        descriptor.producer.signalKind !== "audio" ||
        descriptor.producer.schemaVersion !== "audio-observation/v1" ||
        descriptor.binding.trackId !== descriptor.producer.track?.id ||
        descriptor.binding.deviceId !== descriptor.producer.device?.id ||
        connections.has(descriptor.connectionId) ||
        producers.has(descriptor.producer.producerId) ||
        instances.has(descriptor.producer.instanceId)
      )
        throw new ListeningCaptureError("unsupported-or-duplicate-listener");
      connections.add(descriptor.connectionId);
      producers.add(descriptor.producer.producerId);
      instances.add(descriptor.producer.instanceId);
      return {
        descriptor,
        stage: "idle",
        attempted: false,
        terminal: false,
        sequence: -1,
        resultCount: 0,
        bufferedBytes: 0,
        buffered: [],
        progressSeen: false,
      };
    });
    this.#verifyInstances(true);
    this.result = new Promise((resolve, reject) => {
      this.#resolveResult = resolve;
      this.#rejectResult = reject;
    });
    if (
      this.#selected.some(
        (item) =>
          item.descriptor.registration.nativeStatus?.scope ===
          NATIVE_LISTENER_SCOPE,
      )
    ) {
      this.nativeLaunch = new Promise<void>((resolve, reject) => {
        this.#resolveNativeLaunch = resolve;
        this.#rejectNativeLaunch = reject;
      });
      void this.nativeLaunch.catch(() => {});
    }
    this.#failureGate = new Promise<never>((_resolve, reject) => {
      this.#rejectGate = reject;
    });
    // Results may fail synchronously before the prepared handle reaches its caller.
    void this.result.catch(() => {});
    void this.#failureGate.catch(() => {});
  }

  #timeout(value: number, max: number): number {
    if (!Number.isInteger(value) || value < 1 || value > max)
      throw new ListeningCaptureError("invalid-timeout");
    return value;
  }

  #event(stage: string, action?: string, detail?: string): void {
    recordSignalTelemetry(this.input.telemetry, {
      name: `listening.capture.${stage}`,
      source: "listening-capture",
      correlationId: this.#trace.correlationId,
      causationId: this.#trace.causationId,
      trace: {
        traceId: this.#trace.traceId,
        spanId: stableTelemetryId(
          `${this.jobId}:${stage}:${action ?? "capture"}`,
        ),
      },
      durationMs: Date.now() - this.#startedAt,
      outcome:
        stage === "failed"
          ? "failure"
          : stage === "cancelled"
            ? "cancelled"
            : "success",
      attributes: sanitizeTelemetryAttributes({
        jobId: this.jobId,
        passId: this.passId,
        listenerCount: this.#selected.length,
        action,
        detail,
      }),
    });
  }

  #progress(stage: ListeningCaptureProgress["stage"]): void {
    this.#event("progress", stage);
    try {
      this.input.onProgress?.({
        stage,
        listenerCount: this.#selected.length,
        readyCount: this.#selected.filter(
          (item) => item.stage !== "idle" && item.stage !== "preparing",
        ).length,
        armedCount: this.#selected.filter((item) => item.stage === "armed")
          .length,
        completedCount: this.#selected.filter(
          (item) => item.observation !== undefined,
        ).length,
      });
    } catch (cause) {
      throw error(cause, "progress-handler-failed");
    }
  }

  #verifyInstances(initial = false): void {
    const current = this.service.inspectListeners();
    for (const item of this.#selected) {
      if (item.terminal) continue;
      const matches = current.filter(
        (candidate) => candidate.connectionId === item.descriptor.connectionId,
      );
      if (matches.length !== 1 || !sameInstance(matches[0]!, item.descriptor))
        throw new ListeningCaptureError(
          "listener-disconnected-or-epoch-changed",
        );
      const active = matches[0]!;
      assertNativeReadiness(active.registration);
      if (
        (initial &&
          (active.phase !== "idle" ||
            active.jobId !== undefined ||
            active.passId !== undefined)) ||
        (active.jobId !== undefined && active.jobId !== this.jobId) ||
        (active.passId !== undefined && active.passId !== this.passId) ||
        (item.stage === "armed" && active.phase === "idle")
      )
        throw new ListeningCaptureError("listener-ownership-changed");
    }
  }

  #controlInput(action: ListenerControlInput["action"]): ListenerControlInput {
    return {
      ...this.#trace,
      jobId: this.jobId,
      passId: this.passId,
      action,
      ...(action === "prepare" ? { config: this.#config } : {}),
    };
  }

  #reply(
    item: SelectedListener,
    raw: unknown,
    status: ListenerReply["status"],
  ): ListenerReply {
    const parsed = listenerReplySchema.safeParse(raw);
    if (!parsed.success)
      throw new ListeningCaptureError("malformed-control-reply");
    const reply = parsed.data;
    if (
      reply.connectionEpoch !== item.descriptor.registration.connectionEpoch ||
      reply.jobId !== this.jobId ||
      reply.passId !== this.passId ||
      reply.traceId !== this.#trace.traceId ||
      reply.correlationId !== this.#trace.correlationId ||
      reply.causationId !== this.#trace.causationId
    )
      throw new ListeningCaptureError("stale-control-reply");
    if (reply.status === "failed") {
      if (item.stage === "preparing") item.terminal = true;
      throw new ListeningCaptureError(
        "listener-control-denied",
        reply.reason ?? "Listener denied control",
      );
    }
    if (
      reply.status !== status ||
      reply.sequence <= item.sequence ||
      (status === "armed" && reply.sequence !== item.sequence + 1)
    )
      throw new ListeningCaptureError("unexpected-control-reply");
    item.sequence = reply.sequence;
    if (status === "armed") {
      const native =
        item.descriptor.registration.nativeStatus?.scope ===
        NATIVE_LISTENER_SCOPE;
      if (native !== (reply.nativeArm !== undefined))
        throw new ListeningCaptureError("native-arm-proof-required");
      if (reply.nativeArm !== undefined) {
        item.nativeArm = reply.nativeArm;
      }
    }
    return reply;
  }

  async #control(
    item: SelectedListener,
    action: "prepare" | "arm",
  ): Promise<void> {
    const alreadyFailed = this.#failure;
    if (alreadyFailed) throw alreadyFailed;
    if (this.input.signal.aborted) throw new ListeningCaptureError("cancelled");
    this.#verifyInstances();
    item.attempted = true;
    item.stage = action === "prepare" ? "preparing" : "arming";
    this.#event("queued", action);
    this.#event("started", action);
    try {
      await this.#executeControl(item, action);
    } catch (cause) {
      const failure = error(cause, "control-failed");
      this.#event(
        failure.code === "cancelled" ? "cancelled" : "failed",
        action,
        failure.message,
      );
      throw failure;
    }
  }

  async #executeControl(
    item: SelectedListener,
    action: "prepare" | "arm",
  ): Promise<void> {
    const pending = bounded(
      this.service.requestListenerControl(
        item.descriptor.connectionId,
        this.#controlInput(action),
        { timeoutMs: this.#controlTimeout },
      ),
      this.#controlTimeout,
    );
    let raw: ListenerReply;
    try {
      raw = await Promise.race([pending.promise, this.#failureGate]);
    } finally {
      pending.release();
    }
    const failure = this.#failure;
    if (failure) throw failure;
    this.#reply(item, raw, action === "prepare" ? "ready" : "armed");
    item.stage = action === "prepare" ? "ready" : "armed";
    this.#event("completed", action);
    this.#progress(action === "prepare" ? "preparing" : "arming");
    if (action === "arm") {
      for (const result of item.buffered.splice(0)) this.#consume(item, result);
      item.bufferedBytes = 0;
    }
  }

  #receive = (event: ListenerResultEvent): void => {
    if (this.#failure || this.#finished) return;
    try {
      this.#verifyInstances();
      const item = this.#selected.find(
        (candidate) => candidate.descriptor.connectionId === event.connectionId,
      );
      if (!item) {
        if (
          this.#selected.some(
            (candidate) =>
              candidate.descriptor.producer.producerId ===
                event.producer.producerId ||
              candidate.descriptor.producer.instanceId ===
                event.producer.instanceId,
          )
        )
          throw new ListeningCaptureError("result-connection-changed");
        return;
      }
      if (
        event.producer.producerId !== item.descriptor.producer.producerId ||
        event.producer.instanceId !== item.descriptor.producer.instanceId ||
        event.producer.signalKind !== "audio" ||
        event.producer.schemaVersion !== "audio-observation/v1" ||
        event.binding.trackId !== item.descriptor.binding.trackId ||
        event.binding.deviceId !== item.descriptor.binding.deviceId
      )
        throw new ListeningCaptureError("result-producer-mismatch");
      const bytes = Buffer.byteLength(JSON.stringify(event.result), "utf8");
      if (bytes > DEFAULT_MAX_INGRESS_FRAME_BYTES || ++item.resultCount > 1024)
        throw new ListeningCaptureError("result-overflow");
      const parsed = listenerResultSchema.safeParse(event.result);
      if (!parsed.success) throw new ListeningCaptureError("malformed-result");
      const result = parsed.data;
      if (
        result.connectionEpoch !==
          item.descriptor.registration.connectionEpoch ||
        result.jobId !== this.jobId ||
        result.passId !== this.passId ||
        result.traceId !== this.#trace.traceId ||
        result.correlationId !== this.#trace.correlationId ||
        result.causationId !== this.#trace.causationId
      )
        throw new ListeningCaptureError("stale-result");
      if (item.stage !== "armed" && item.stage !== "arming")
        throw new ListeningCaptureError("result-before-arm");
      if (item.stage === "arming") {
        item.bufferedBytes += bytes;
        if (item.buffered.length >= 32 || item.bufferedBytes > 256 * 1024)
          throw new ListeningCaptureError("result-buffer-overflow");
        item.buffered.push(result);
      } else this.#consume(item, result);
    } catch (cause) {
      void this.#fail(error(cause, "result-failed"));
    }
  };

  #consume(item: SelectedListener, result: ListenerResult): void {
    if (item.terminal || result.sequence !== item.sequence + 1)
      throw new ListeningCaptureError("result-sequence-gap-or-replay");
    item.sequence = result.sequence;
    if (result.status === "partial" || result.status === "failed") {
      item.terminal = true;
      throw new ListeningCaptureError(
        "listener-result-failed",
        result.reason ?? result.status,
      );
    }
    const native =
      item.descriptor.registration.nativeStatus?.scope ===
      NATIVE_LISTENER_SCOPE;
    if (
      !native &&
      (result.nativeLaunch !== undefined ||
        result.nativeCapture !== undefined ||
        result.nativeLifecycle !== undefined)
    )
      throw new ListeningCaptureError("unexpected-native-evidence");
    if (result.nativeLaunch !== undefined) {
      if (item.nativeArm === undefined || item.nativeLaunch !== undefined)
        throw new ListeningCaptureError("unexpected-native-launch");
      nativeLaunchCoordinates(item.nativeArm, result.nativeLaunch);
      item.nativeLaunch = result.nativeLaunch;
    }
    if (native && result.observation !== undefined) {
      if (item.nativeLaunch === undefined)
        throw new ListeningCaptureError("native-launch-proof-required");
      if (result.status === "completed") {
        const proof = result.nativeCapture;
        if (
          proof === undefined ||
          JSON.stringify(proof.armed) !== JSON.stringify(item.nativeArm) ||
          JSON.stringify(proof.launched) !== JSON.stringify(item.nativeLaunch)
        )
          throw new ListeningCaptureError("native-capture-proof-mismatch");
        assertNativeCaptureObservation(proof, result.observation);
      }
    }
    if (result.observation !== undefined)
      this.#observation(
        item,
        result.observation,
        result.status === "completed",
      );
    if (result.status === "progress") {
      if (!item.progressSeen && (!native || item.nativeLaunch !== undefined)) {
        item.progressSeen = true;
        this.#progress("capturing");
      }
      if (result.nativeLaunch !== undefined)
        this.#event("progress", "native-onset");
      this.#confirmNativeLaunch();
      return;
    }
    item.observation = result.observation!;
    item.terminal = true;
    this.#progress("capturing");
    this.#complete();
  }

  #confirmNativeLaunch(): void {
    if (
      !this.nativeLaunch ||
      this.#nativeLaunched ||
      !this.#allArmed ||
      this.#failure ||
      this.#selected.some(
        (item) =>
          item.descriptor.registration.nativeStatus?.scope ===
            NATIVE_LISTENER_SCOPE && item.nativeLaunch === undefined,
      )
    )
      return;
    this.#nativeLaunched = true;
    this.#event("completed", "native-onset");
    this.#resolveNativeLaunch?.();
  }

  #observation(
    item: SelectedListener,
    raw: AudioObservation,
    complete: boolean,
  ): void {
    const observation = audioObservationSchema.parse(raw);
    const rate = item.descriptor.registration.sampleRate;
    if (
      observation.listenerId !== item.descriptor.producer.producerId ||
      observation.passId !== this.passId ||
      observation.sampleRate !== rate ||
      observation.algorithm.version !==
        item.descriptor.registration.algorithmVersion ||
      observation.complete !== complete ||
      observation.samples.length > this.#config.maxWindows ||
      observation.startBeat < this.#config.source.startBeat ||
      observation.endBeat > this.#config.source.endBeat ||
      observation.algorithm.timingUncertaintySamples >
        observation.algorithm.windowSamples +
          observation.algorithm.hopSamples ||
      observation.endSample - observation.startSample >
        Math.ceil((this.#config.durationMs * rate) / 1000) +
          observation.algorithm.timingUncertaintySamples ||
      (complete &&
        (observation.endSample <= observation.startSample ||
          observation.startBeat !== this.#config.source.startBeat ||
          observation.endBeat !== this.#config.source.endBeat))
    )
      throw new ListeningCaptureError("observation-attribution-or-quota");
  }

  #complete(): void {
    if (
      !this.#allArmed ||
      this.#failure ||
      this.#finished ||
      this.#selected.some((item) => item.observation === undefined)
    )
      return;
    this.#release();
    this.#finished = true;
    this.#event("completed");
    this.#resolveResult(
      this.#selected.map((item) => structuredClone(item.observation!)),
    );
  }

  #abort = (): void => {
    void this.#fail(new ListeningCaptureError("cancelled"));
  };

  #release(): void {
    if (this.#poll !== undefined) clearInterval(this.#poll);
    if (this.#deadline !== undefined) clearTimeout(this.#deadline);
    this.input.signal.removeEventListener("abort", this.#abort);
    const unsubscribe = this.#unsubscribe;
    this.#unsubscribe = undefined;
    for (const item of this.#selected) {
      item.buffered.length = 0;
      item.bufferedBytes = 0;
    }
    if (this.#releaseFailure) throw this.#releaseFailure;
    try {
      unsubscribe?.();
    } catch (cause) {
      this.#releaseFailure = error(cause, "cleanup-unsubscribe-failed");
      throw this.#releaseFailure;
    }
  }

  #cleanup(): Promise<void> {
    this.#cleanupTask ??= (async () => {
      const targets = this.#selected.filter(
        (item) => item.attempted && !item.terminal,
      );
      this.#event("queued", "cancel");
      this.#event("started", "cancel");
      const outcomes = await Promise.allSettled(
        targets.map(async (item) => {
          const current = this.service
            .inspectListeners()
            .filter(
              (candidate) =>
                candidate.connectionId === item.descriptor.connectionId,
            );
          if (
            current.length !== 1 ||
            !sameInstance(current[0]!, item.descriptor) ||
            (current[0]!.jobId !== undefined &&
              current[0]!.jobId !== this.jobId) ||
            (current[0]!.passId !== undefined &&
              current[0]!.passId !== this.passId)
          )
            throw new ListeningCaptureError("cannot-cancel-stale-instance");
          const pending = bounded(
            this.service.requestListenerControl(
              item.descriptor.connectionId,
              this.#controlInput("cancel"),
              { timeoutMs: this.#cleanupTimeout },
            ),
            this.#cleanupTimeout,
          );
          let reply: ListenerReply;
          try {
            reply = await pending.promise;
          } finally {
            pending.release();
          }
          this.#reply(item, reply, "cancelled");
          item.terminal = true;
        }),
      );
      const failures = outcomes.flatMap((outcome) =>
        outcome.status === "rejected"
          ? [error(outcome.reason, "cleanup-failed")]
          : [],
      );
      try {
        this.#release();
      } catch (cause) {
        failures.push(error(cause, "cleanup-release-failed"));
      }
      this.#event(failures.length ? "failed" : "completed", "cancel");
      if (failures.length)
        throw new AggregateError(
          failures,
          "Listener cancellation could not be confirmed",
        );
    })();
    return this.#cleanupTask;
  }

  #fail(cause: Error): Promise<void> {
    if (this.#finished && !this.#failure) return Promise.resolve();
    this.#failureTask ??= (async () => {
      this.#failure = cause;
      try {
        await this.#cleanup();
      } catch (cleanupCause) {
        this.#failure = new AggregateError(
          [
            cause,
            ...(cleanupCause instanceof AggregateError
              ? cleanupCause.errors.map((entry: unknown) =>
                  error(entry, "cleanup-failed"),
                )
              : [error(cleanupCause, "cleanup-failed")]),
          ],
          "Capture failed and cancellation could not be confirmed",
        );
      }
      this.#finished = true;
      if (this.nativeLaunch && !this.#nativeLaunched) {
        this.#event(
          cause instanceof ListeningCaptureError && cause.code === "cancelled"
            ? "cancelled"
            : "failed",
          "native-onset",
          cause.message,
        );
        this.#rejectNativeLaunch?.(this.#failure);
      }
      this.#event(
        cause instanceof ListeningCaptureError && cause.code === "cancelled"
          ? "cancelled"
          : "failed",
        undefined,
        cause.message,
      );
      this.#rejectGate(this.#failure);
      this.#rejectResult(this.#failure);
    })();
    return this.#failureTask;
  }

  async prepare(): Promise<void> {
    this.#event("queued");
    this.#event("started");
    if (this.nativeLaunch) {
      this.#event("queued", "native-onset");
      this.#event("started", "native-onset");
    }
    try {
      if (this.input.signal.aborted)
        throw new ListeningCaptureError("cancelled");
      this.#unsubscribe = this.service.onListenerResult(this.#receive);
      this.#event("queued", "results");
      this.#event("started", "results");
      this.input.signal.addEventListener("abort", this.#abort, { once: true });
      if (this.input.signal.aborted)
        throw new ListeningCaptureError("cancelled");
      this.#poll = setInterval(() => {
        if (this.#failure || this.#finished) return;
        try {
          this.#verifyInstances();
        } catch (cause) {
          void this.#fail(error(cause, "listener-inspection-failed"));
        }
      }, 100);
      for (const item of this.#selected) await this.#control(item, "prepare");
      for (const item of this.#selected) await this.#control(item, "arm");
      if (this.#failure) throw this.#failure;
      this.#verifyInstances();
      this.#allArmed = true;
      this.#confirmNativeLaunch();
      this.#deadline = setTimeout(() => {
        void this.#fail(new ListeningCaptureError("capture-timeout"));
      }, this.#resultTimeout);
      this.#complete();
    } catch (cause) {
      await this.#fail(error(cause, "capture-preparation-failed"));
      throw this.#failure ?? error(cause, "capture-preparation-failed");
    }
  }

  async disarm(): Promise<void> {
    if (!this.#finished)
      await this.#fail(new ListeningCaptureError("cancelled"));
    await this.#cleanup();
  }
}

export async function prepareListenerCapture(
  service: ListenerService,
  input: PrepareListenerCaptureInput,
): Promise<PreparedListeningCapture> {
  let capture: Capture;
  try {
    capture = new Capture(service, input);
  } catch (cause) {
    const failure = error(cause, "invalid-capture-input");
    const trace = telemetryIdSchema.safeParse(input.trace?.traceId).success
      ? {
          traceId: input.trace.traceId,
          spanId: stableTelemetryId(`${input.trace.traceId}:capture-guard`),
        }
      : undefined;
    for (const stage of ["queued", "failed"])
      recordSignalTelemetry(input.telemetry, {
        name: `listening.capture.${stage}`,
        source: "listening-capture",
        outcome: "failure",
        ...(input.trace?.correlationId === undefined
          ? {}
          : { correlationId: input.trace.correlationId }),
        ...(input.trace?.causationId === undefined
          ? {}
          : { causationId: input.trace.causationId }),
        ...(trace === undefined ? {} : { trace }),
        attributes: sanitizeTelemetryAttributes({
          code: failure.code,
          detail: failure.message,
          passId: input.passId,
          listenerCount: Array.isArray(input.listeners)
            ? input.listeners.length
            : 0,
        }),
      });
    throw failure;
  }
  await capture.prepare();
  return capture;
}
