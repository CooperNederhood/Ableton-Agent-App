import { randomUUID } from "node:crypto";
import {
  admitMetricListeningBudget,
  MAX_METRIC_RESULT_FRAME_BYTES,
  assertNativeMetricArmProof,
  assertNativeMetricObservationSource,
  assertNativeMetricReadyProof,
  nativeMetricLaunchCoordinates,
  nativeMetricListeningConfigSchema,
  readListeningFailureEvidence,
  snapshotNativeMetricListeningExpectation,
  type ListeningFailureEvidence,
  type ListeningFailureFact,
  type MetricAudioObservation,
  type MetricListeningBudgetAdmission,
  type NativeMetricArmProof,
  type NativeMetricLaunchProof,
  type NativeMetricListeningConfig,
  type NativeMetricListeningExpectation,
} from "@ableton-agent/protocol";
import {
  sanitizePersistedText,
  sanitizeTelemetryAttributes,
  telemetryIdSchema,
  type NonBlockingObservabilityRecorder,
} from "@ableton-agent/observability";
import {
  listenerMetricProducerSchema,
  listenerRegistrationMetricSchema,
  listenerReplyMetricSchema,
  listenerResultMetricSchema,
  recordSignalTelemetry,
  stableTelemetryId,
  listenerControlInputSchema,
  type ListenerDescriptor,
  type ListenerReplyMetric,
  type ListenerResultEvent,
  type ListenerResultMetric,
  type ListenerService,
  type ListenerControlInput,
} from "@ableton-agent/signal-routing";
import { captureFailureEvidence, failureFact } from "./listening-failure.js";

export interface PrepareMetricListenerCaptureInput {
  readonly bindings: readonly {
    readonly descriptor: ListenerDescriptor;
    readonly config: NativeMetricListeningConfig;
  }[];
  readonly passId: string;
  readonly trace: {
    readonly traceId: string;
    readonly correlationId: string;
    readonly causationId: string;
  };
  readonly signal: AbortSignal;
  readonly telemetry?: Pick<NonBlockingObservabilityRecorder, "enqueue">;
  readonly onProgress?: (progress: MetricListeningCaptureProgress) => void;
  readonly controlTimeoutMs?: number;
  readonly cleanupTimeoutMs?: number;
  readonly resultTimeoutMs?: number;
}

export interface MetricListeningCaptureProgress {
  readonly stage: "preparing" | "arming" | "capturing" | "completed";
  readonly listenerCount: number;
  readonly readyCount: number;
  readonly armedCount: number;
  readonly completedCount: number;
}

export interface PreparedMetricListeningCapture {
  readonly jobId: string;
  readonly passId: string;
  readonly observationContract: "independent-metric-timelines/v1";
  readonly result: Promise<readonly MetricAudioObservation[]>;
  readonly nativeLaunch: Promise<void>;
  disarm(): Promise<void>;
}

class ListeningCaptureError extends Error {
  constructor(
    readonly code: string,
    detail: string = code,
    readonly failureEvidence?: ListeningFailureEvidence,
  ) {
    super(sanitizePersistedText(detail).slice(0, 512));
    this.name = "ListeningCaptureError";
  }
}

function captureControlError(
  value: unknown,
  code: string,
): ListeningCaptureError {
  const evidence = readListeningFailureEvidence(value);
  return value instanceof ListeningCaptureError
    ? value
    : new ListeningCaptureError(
        code,
        value instanceof Error ? value.message : code,
        evidence.status === "present" ? evidence.evidence : undefined,
      );
}

function boundedListenerControl<T>(
  operation: Promise<T>,
  timeoutMs: number,
  timeoutCode: string,
): { promise: Promise<T>; release(): void } {
  let release = (): void => {};
  const promise = new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new ListeningCaptureError(timeoutCode)),
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
        reject(captureControlError(reason, "control-failed"));
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

export class MetricListeningBudgetError extends ListeningCaptureError {
  constructor(
    readonly admission: Extract<
      MetricListeningBudgetAdmission,
      { admitted: false }
    >,
    evidence: ListeningFailureEvidence,
  ) {
    super(admission.reason, admission.reason, evidence);
  }
}

export class MetricListeningCleanupError extends AggregateError {
  readonly code = "metric-capture-cleanup-uncertain";
  readonly failureEvidence: ListeningFailureEvidence | undefined;
  constructor(primary: ListeningCaptureError, failures: readonly unknown[]) {
    super(
      [primary, ...failures],
      "Metric capture cleanup could not be confirmed",
      { cause: primary },
    );
    this.failureEvidence = primary.failureEvidence;
  }
}

type Stage = "idle" | "preparing" | "ready" | "arming" | "armed";
type Message = ListenerReplyMetric | ListenerResultMetric;
interface PendingControl {
  readonly abort: AbortController;
  acknowledged: boolean;
}
interface Selected {
  readonly descriptor: ListenerDescriptor;
  readonly config: NativeMetricListeningConfig;
  expected: Readonly<NativeMetricListeningExpectation>;
  stage: Stage;
  attempted: boolean;
  terminal: boolean;
  sequence: number | undefined;
  resultCount: number;
  bufferedBytes: number;
  readonly buffered: ListenerResultMetric[];
  pending?: PendingControl;
  cleanupFailure?: ListeningCaptureError;
  arm?: Readonly<NativeMetricArmProof>;
  launch?: NativeMetricLaunchProof;
  observation?: Readonly<MetricAudioObservation>;
  lastProgress: number;
  progressEvents: number;
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

// Only immutable identity/DSP/path fields: READY/executedGen and ownership
// legitimately change during a pass. Never target a replacement connection.
function instanceKey(item: ListenerDescriptor): string {
  const r = item.registration;
  return JSON.stringify([
    item.connectionId,
    listenerMetricProducerSchema.parse(item.producer),
    item.binding.trackId,
    item.binding.deviceId,
    r.version,
    r.connectionEpoch,
    r.algorithmVersion,
    r.sampleRate,
    r.vectorSize,
    r.deviceCanonicalPath,
    r.trackCanonicalPath,
    r.nativeStatus?.scope,
  ]);
}

function timeout(value: number, max: number): number {
  if (!Number.isInteger(value) || value < 1 || value > max)
    throw new ListeningCaptureError("invalid-timeout");
  return value;
}

class MetricCapture implements PreparedMetricListeningCapture {
  readonly passId: string;
  readonly observationContract = "independent-metric-timelines/v1";
  readonly result: Promise<readonly MetricAudioObservation[]>;
  readonly nativeLaunch: Promise<void>;
  readonly #selected: Selected[];
  readonly #trace: PrepareMetricListenerCaptureInput["trace"];
  readonly #startedAt = performance.now();
  readonly #controlTimeout: number;
  readonly #cleanupTimeout: number;
  readonly #resultTimeout: number;
  readonly #stages = new Map<string, number>();
  readonly #gate: Promise<never>;
  #rejectGate!: (error: Error) => void;
  #resolveResult!: (results: readonly MetricAudioObservation[]) => void;
  #rejectResult!: (error: Error) => void;
  #resolveLaunch!: () => void;
  #rejectLaunch!: (error: Error) => void;
  #unsubscribe: (() => void) | undefined;
  #deadline: ReturnType<typeof setTimeout> | undefined;
  #poll: ReturnType<typeof setInterval> | undefined;
  #failure: Error | undefined;
  #failureTask: Promise<void> | undefined;
  #cleanupTask: Promise<void> | undefined;
  #released = false;
  #releaseFailure: ListeningCaptureError | undefined;
  #releasing = false;
  #sealed = false;
  #allArmed = false;
  #launched = false;
  #completionQueued = false;

  constructor(
    readonly service: ListenerService,
    readonly input: PrepareMetricListenerCaptureInput,
    readonly jobId: string,
  ) {
    this.passId = input.passId;
    this.#trace = freeze({ ...input.trace });
    this.input = Object.freeze({ ...input, trace: this.#trace });
    this.#controlTimeout = timeout(input.controlTimeoutMs ?? 5000, 10000);
    this.#cleanupTimeout = timeout(input.cleanupTimeoutMs ?? 2000, 5000);
    if (input.bindings.length < 1 || input.bindings.length > 8)
      throw new ListeningCaptureError("listener-quota");
    const identities = new Set<string>(),
      targets = new Set<string>();
    let common: string | undefined;
    this.#selected = input.bindings.map((binding) => {
      const descriptor = structuredClone(binding.descriptor);
      if (descriptor.registration.version !== 5)
        throw new ListeningCaptureError("listener-version-mismatch");
      const registration = listenerRegistrationMetricSchema.parse(
        descriptor.registration,
      );
      listenerMetricProducerSchema.parse(descriptor.producer);
      const config = nativeMetricListeningConfigSchema.parse(binding.config);
      if (config.sourceContext === undefined)
        throw new ListeningCaptureError("metric-source-context-required");
      if (
        registration.nativeStatus.readiness !== "READY" &&
        registration.nativeStatus.reason !==
          "fresh_per_pass_native_validation_required"
      )
        throw new ListeningCaptureError("listener-not-ready");
      const g = config.geometry;
      if (
        registration.sampleRate !== g.sampleRate ||
        registration.vectorSize !== g.vectorSize ||
        !registration.nativeStatus.acceptedSampleRates.includes(g.sampleRate) ||
        !registration.nativeStatus.acceptedVectorSizes.includes(g.vectorSize)
      )
        throw new ListeningCaptureError("unsupported-native-capture-geometry");
      listenerControlInputSchema.parse({
        ...this.#trace,
        jobId: this.jobId,
        passId: this.passId,
        action: "prepare",
        config,
      });
      const source = config.sourceContext;
      const target =
        source.view === "arrangement" ? source.target : source.target.track;
      if ((target.kind === "master") !== (target.index === null))
        throw new ListeningCaptureError("invalid-source-target");
      const path =
        target.kind === "master"
          ? "live_set master_track"
          : `live_set ${target.kind === "return" ? "return_tracks" : "tracks"} ${target.index}`;
      if (
        registration.trackCanonicalPath !== path ||
        descriptor.binding.trackId !== descriptor.producer.track?.id ||
        descriptor.binding.deviceId !== descriptor.producer.device?.id ||
        descriptor.phase !== "idle" ||
        descriptor.jobId !== undefined ||
        descriptor.passId !== undefined
      )
        throw new ListeningCaptureError("invalid-or-owned-listener");
      for (const id of [
        `connection:${descriptor.connectionId}`,
        `producer:${descriptor.producer.producerId}`,
        `instance:${descriptor.producer.instanceId}`,
        `device:${descriptor.binding.deviceId}`,
        `epoch:${registration.connectionEpoch}`,
      ]) {
        if (identities.has(id))
          throw new ListeningCaptureError("duplicate-listener");
        identities.add(id);
      }
      const shared = JSON.stringify([
        config.mode,
        g.startBeat,
        g.endBeat,
        g.tempoBpm,
        source.view === "session" ? source : null,
      ]);
      if (common !== undefined && common !== shared)
        throw new ListeningCaptureError("metric-pass-intent-mismatch");
      common = shared;
      if (config.mode === "arrangement") {
        const key = `${target.kind}:${target.index}`;
        if (targets.has(key) || targets.has(target.expectedReference))
          throw new ListeningCaptureError("duplicate-source-target");
        targets.add(key);
        targets.add(target.expectedReference);
      }
      return {
        descriptor: freeze(descriptor),
        config: freeze(config),
        expected: snapshotNativeMetricListeningExpectation({
          ...this.#trace,
          listenerId: descriptor.producer.producerId,
          passId: this.passId,
          connectionId: descriptor.connectionId,
          connectionEpoch: registration.connectionEpoch,
          config,
        }),
        stage: "idle",
        attempted: false,
        terminal: false,
        sequence: undefined,
        resultCount: 0,
        bufferedBytes: 0,
        buffered: [],
        lastProgress: -Infinity,
        progressEvents: 0,
      };
    });
    const duration = Math.max(
      ...this.#selected.map(({ config: { geometry: g } }) =>
        Math.ceil((g.totalSamples * 1000) / g.sampleRate),
      ),
    );
    this.#resultTimeout = timeout(
      input.resultTimeoutMs ??
        Math.min(
          125000,
          duration + 2 * this.#selected.length * this.#controlTimeout + 5000,
        ),
      125000,
    );
    this.#verify(true);
    this.result = new Promise((resolve, reject) => {
      this.#resolveResult = resolve;
      this.#rejectResult = reject;
    });
    this.nativeLaunch = new Promise((resolve, reject) => {
      this.#resolveLaunch = resolve;
      this.#rejectLaunch = reject;
    });
    this.#gate = new Promise<never>((_, reject) => {
      this.#rejectGate = reject;
    });
    void this.result.catch(() => {});
    void this.nativeLaunch.catch(() => {});
    void this.#gate.catch(() => {});
  }

  #evidence(
    code: string,
    item?: Selected,
    facts: readonly ListeningFailureFact[] = [],
    phase: ListeningFailureEvidence["phase"] = this.#phase(item),
  ) {
    return captureFailureEvidence({
      code,
      message: code,
      phase,
      checkId: `metric-capture.${code}`,
      trace: this.#trace,
      jobId: this.jobId,
      passId: this.passId,
      ...(item ? { listener: item.descriptor } : {}),
      facts,
    });
  }
  #phase(item?: Selected): ListeningFailureEvidence["phase"] {
    if (this.#allArmed) return this.#launched ? "capture" : "launch";
    if (
      item?.stage === "arming" ||
      this.#selected.some((s) => s.stage === "arming")
    )
      return "arming";
    return this.#selected.some((s) => s.attempted)
      ? "preparation"
      : "validation";
  }
  #deny(
    code: string,
    item?: Selected,
    facts: readonly ListeningFailureFact[] = [],
  ): never {
    throw new ListeningCaptureError(
      code,
      code,
      this.#evidence(code, item, facts),
    );
  }
  #error(cause: unknown, code: string, item?: Selected): ListeningCaptureError {
    if (
      cause instanceof ListeningCaptureError &&
      cause.failureEvidence !== undefined
    )
      return cause;
    return new ListeningCaptureError(
      cause instanceof ListeningCaptureError ? cause.code : code,
      cause instanceof Error ? cause.message : code,
      this.#evidence(code, item, [
        failureFact(
          "validation.reason",
          cause instanceof Error ? cause.message : code,
        ),
        ...(item
          ? [
              failureFact("expected.generation", item.expected.generation),
              failureFact("expected.nativeEpoch", item.expected.nativeEpoch),
            ]
          : []),
      ]),
    );
  }
  #event(
    stage: string,
    action: string,
    item?: Selected,
    attrs: Readonly<Record<string, unknown>> = {},
  ): void {
    if (stage === "progress" && action === "results" && item) {
      if (item.progressEvents >= 128) return;
      item.progressEvents++;
    }
    const key = `${action}:${item?.descriptor.connectionId ?? "pass"}`;
    if (stage === "started") this.#stages.set(key, performance.now());
    const ended = ["completed", "failed", "cancelled"].includes(stage);
    const start = this.#stages.get(key);
    recordSignalTelemetry(this.input.telemetry, {
      name: `listening.metric-capture.${stage}`,
      source: "metric-listening-capture",
      correlationId: this.#trace.correlationId,
      causationId: this.#trace.causationId,
      trace: {
        traceId: this.#trace.traceId,
        spanId: stableTelemetryId(`${this.jobId}:${key}`),
      },
      ...(ended
        ? {
            outcome:
              stage === "failed"
                ? ("failure" as const)
                : stage === "cancelled"
                  ? ("cancelled" as const)
                  : ("success" as const),
          }
        : {}),
      ...(ended && start !== undefined
        ? { durationMs: Math.max(0, performance.now() - start) }
        : {}),
      attributes: sanitizeTelemetryAttributes({
        action,
        jobId: this.jobId,
        passId: this.passId,
        listenerCount: this.#selected.length,
        observationContract: this.observationContract,
        ...(!item
          ? {
              listeners: this.#selected.map((selected) => ({
                listenerId: selected.descriptor.producer.producerId,
                connectionId: selected.descriptor.connectionId,
                connectionEpoch:
                  selected.descriptor.registration.connectionEpoch,
                generation: selected.expected.generation,
                nativeEpoch: selected.expected.nativeEpoch,
              })),
            }
          : {}),
        ...(item
          ? {
              listenerId: item.descriptor.producer.producerId,
              instanceId: item.descriptor.producer.instanceId,
              connectionId: item.descriptor.connectionId,
              connectionEpoch: item.descriptor.registration.connectionEpoch,
              generation: item.expected.generation,
              nativeEpoch: item.expected.nativeEpoch,
              mode: item.config.mode,
            }
          : {}),
        ...attrs,
      }),
    });
  }
  #start(action: string, item?: Selected): void {
    this.#event("queued", action, item);
    this.#event("started", action, item);
  }
  #progress(
    stage: MetricListeningCaptureProgress["stage"],
    item?: Selected,
    force = false,
  ): void {
    if (
      item &&
      (item.progressEvents >= 128 ||
        (!force && performance.now() - item.lastProgress < 100))
    )
      return;
    if (item) item.lastProgress = performance.now();
    this.#event("progress", "results", item, { stage });
    const progress = freeze({
      stage,
      listenerCount: this.#selected.length,
      readyCount: this.#selected.filter((s) =>
        ["ready", "arming", "armed"].includes(s.stage),
      ).length,
      armedCount: this.#selected.filter((s) => s.stage === "armed").length,
      completedCount: this.#selected.filter((s) => s.observation !== undefined)
        .length,
    });
    try {
      this.input.onProgress?.(progress);
    } catch (cause) {
      throw this.#error(cause, "progress-handler-failed", item);
    }
  }
  #current(item: Selected): ListenerDescriptor {
    const matches = this.service
      .inspectListeners()
      .filter((d) => d.connectionId === item.descriptor.connectionId);
    if (
      matches.length !== 1 ||
      instanceKey(matches[0]!) !== instanceKey(item.descriptor)
    )
      this.#deny("listener-disconnected-or-epoch-changed", item, [
        failureFact("connection.matches", matches.length, 1),
        failureFact(
          "instance.matches",
          matches[0] !== undefined &&
            instanceKey(matches[0]) === instanceKey(item.descriptor),
          true,
        ),
      ]);
    return matches[0]!;
  }
  #verify(initial = false): void {
    for (const item of this.#selected) {
      const active = this.#current(item);
      if (
        (initial &&
          (active.phase !== "idle" ||
            active.jobId !== undefined ||
            active.passId !== undefined)) ||
        (active.jobId !== undefined && active.jobId !== this.jobId) ||
        (active.passId !== undefined && active.passId !== this.passId) ||
        (!item.terminal &&
          item.stage === "armed" &&
          active.phase === "idle" &&
          !item.buffered.some((m) => m.status !== "progress"))
      )
        this.#deny("listener-ownership-changed", item);
    }
  }
  #identity(item: Selected, message: Message): void {
    const e = item.expected;
    for (const field of [
      "listenerId",
      "connectionId",
      "connectionEpoch",
      "passId",
      "traceId",
      "correlationId",
      "causationId",
    ] as const)
      if (message[field] !== e[field])
        this.#deny("foreign-metric-message", item, [
          failureFact(`message.${field}`, message[field], e[field]),
        ]);
    if (
      message.jobId !== this.jobId ||
      message.mode !== item.config.mode ||
      (e.generation !== undefined && message.generation !== e.generation)
    )
      this.#deny("foreign-metric-message", item, [
        failureFact("message.jobId", message.jobId, this.jobId),
        failureFact("message.generation", message.generation, e.generation),
      ]);
    if (
      message.type === "listener.result" &&
      message.nativeLifecycle !== undefined &&
      e.nativeEpoch !== undefined &&
      message.nativeLifecycle.nativeEpoch !== e.nativeEpoch
    )
      this.#deny("foreign-native-epoch", item);
  }
  #checkDeadline(): void {
    if (performance.now() - this.#startedAt >= this.#resultTimeout)
      this.#deny("capture-timeout");
  }
  #checkFailure(): void {
    const failure = this.#failure;
    if (failure) throw failure;
  }
  #checkCleanupFailure(item: Selected): void {
    if (item.cleanupFailure) throw item.cleanupFailure;
  }
  #sequence(item: Selected, message: Message): void {
    if (item.sequence !== undefined && message.sequence !== item.sequence + 1)
      this.#deny("result-sequence-gap-or-replay", item, [
        failureFact("message.sequence", message.sequence, item.sequence + 1),
      ]);
    item.sequence = message.sequence;
  }
  #ownedIngressFailure(
    event: ListenerResultEvent,
    item: Selected,
  ): ListeningCaptureError | undefined {
    if (event.failureEvidence === undefined) return undefined;
    const read = readListeningFailureEvidence(event);
    if (read.status !== "present")
      this.#deny("invalid-ingress-failure-evidence", item);
    const evidence = read.evidence,
      ref = evidence.reference,
      owner = evidence.listener;
    if (
      ref.traceId !== this.#trace.traceId ||
      ref.passId !== this.passId ||
      ref.jobId !== this.jobId ||
      ref.correlationId !== this.#trace.correlationId ||
      ref.causationId !== this.#trace.causationId ||
      owner?.listenerId !== item.descriptor.producer.producerId ||
      owner.connectionId !== item.descriptor.connectionId ||
      owner.connectionEpoch !== item.descriptor.registration.connectionEpoch ||
      owner.instanceId !== item.descriptor.producer.instanceId
    )
      this.#deny("foreign-ingress-failure-evidence", item);
    // Rebuild through the canonical sanitizer before retaining ingress facts.
    const sanitized = captureFailureEvidence({
      code: evidence.code,
      message: evidence.summary,
      phase: evidence.phase,
      component: evidence.component,
      checkId: evidence.checkId,
      trace: this.#trace,
      passId: this.passId,
      jobId: this.jobId,
      listener: item.descriptor,
      ...(ref.requestId === undefined ? {} : { requestId: ref.requestId }),
      facts: evidence.facts,
      coverage: evidence.coverage,
      coverageReasons: evidence.coverageReasons,
    });
    return new ListeningCaptureError(
      "listener-result-failed",
      "listener-result-failed",
      sanitized,
    );
  }
  #receive = (event: ListenerResultEvent): void => {
    if (this.#sealed) return;
    const draining = this.#failure !== undefined;
    const item =
      this.#selected.find(
        (s) => s.descriptor.connectionId === event.connectionId,
      ) ??
      this.#selected.find(
        (s) =>
          s.descriptor.producer.producerId === event.producer.producerId ||
          s.descriptor.producer.instanceId === event.producer.instanceId,
      );
    try {
      if (!item) return;
      if (item.descriptor.connectionId !== event.connectionId)
        this.#deny("result-connection-changed", item);
      if (!draining) this.#checkDeadline();
      if (
        JSON.stringify(listenerMetricProducerSchema.parse(event.producer)) !==
          JSON.stringify(
            listenerMetricProducerSchema.parse(item.descriptor.producer),
          ) ||
        event.binding.trackId !== item.descriptor.binding.trackId ||
        event.binding.deviceId !== item.descriptor.binding.deviceId
      )
        this.#deny("result-producer-mismatch", item);
      const ingress = this.#ownedIngressFailure(event, item);
      if (ingress) {
        item.terminal =
          event.result.status === "failed" ||
          event.result.status === "cancelled";
        throw ingress;
      }
      if (item.terminal && !draining) this.#deny("result-after-terminal", item);
      const active = this.#current(item);
      if (
        (active.jobId !== undefined && active.jobId !== this.jobId) ||
        (active.passId !== undefined && active.passId !== this.passId)
      )
        this.#deny("listener-ownership-changed", item);
      const bytes = Buffer.byteLength(JSON.stringify(event.result), "utf8");
      if (bytes > MAX_METRIC_RESULT_FRAME_BYTES || ++item.resultCount > 1024)
        this.#deny("result-overflow", item);
      const message = listenerResultMetricSchema.parse(event.result);
      this.#identity(item, message);
      if (draining) {
        // The SDK can send owned results before its cancel reply. Track only
        // bounded producer sequencing; never admit observations after failure.
        this.#sequence(item, message);
        if (message.status === "failed")
          this.#deny("cleanup-native-failed", item, [
            failureFact("native.reason", message.reason),
            ...(message.nativeLifecycle?.facts ?? []),
          ]);
        if (message.status === "cancelled") item.terminal = true;
        return;
      }
      if (message.status === "failed" || message.status === "cancelled") {
        if (!item.pending) this.#sequence(item, message);
        item.terminal = true;
        this.#deny(
          message.status === "cancelled"
            ? "listener-cancelled"
            : "listener-result-failed",
          item,
          [
            failureFact("native.reason", message.reason),
            ...(message.nativeLifecycle?.facts ?? []),
          ],
        );
      }
      if (item.stage === "idle") this.#deny("result-before-prepare", item);
      if (item.pending) {
        if (
          item.buffered.length >= 32 ||
          item.bufferedBytes + bytes > 2 * MAX_METRIC_RESULT_FRAME_BYTES
        )
          this.#deny("result-startup-buffer-overflow", item);
        if (
          item.buffered.at(-1) &&
          message.sequence <= item.buffered.at(-1)!.sequence
        )
          this.#deny("result-sequence-gap-or-replay", item);
        item.buffered.push(freeze(message));
        item.bufferedBytes += bytes;
      } else {
        this.#sequence(item, message);
        this.#consume(item, message);
      }
    } catch (cause) {
      const error = this.#error(cause, "invalid-metric-result", item);
      if (draining && item) {
        if (!item.cleanupFailure) {
          item.cleanupFailure = error;
          this.#start("cancel-ingress", item);
          this.#event("failed", "cancel-ingress", item, {
            failureEvidence: error.failureEvidence,
          });
        }
      } else {
        void this.#fail(error);
      }
    }
  };

  #consume(item: Selected, message: ListenerResultMetric): void {
    this.#identity(item, message);
    if (message.nativeLaunch !== undefined) {
      if (item.stage !== "armed" || !item.arm || item.launch)
        this.#deny("unexpected-native-launch", item);
      nativeMetricLaunchCoordinates(
        item.arm,
        message.nativeLaunch,
        item.expected,
      );
      item.launch = freeze(message.nativeLaunch);
      this.#event("progress", "launch", item, {
        requestId: message.requestId,
        producerSequence: message.sequence,
      });
    }
    if (message.nativeLifecycle !== undefined) {
      const n = message.nativeLifecycle;
      if (
        performance.now() - item.lastProgress >= 100 ||
        n.stage === "failed" ||
        n.stage === "cancelled"
      ) {
        this.#event("progress", "results", item, {
          nativeEventId: n.eventId,
          nativeCausationId: n.causationId,
          requestId: message.requestId,
          producerSequence: message.sequence,
          metric: n.metric,
          nativeStage: n.stage,
          nativePhase: n.phase,
          nativeDurationMs: n.durationMs,
          nativeElapsedMs: n.elapsedMs,
          generation: n.generation,
          nativeEpoch: n.nativeEpoch,
          reason: n.reason,
          frames: n.frames,
        });
      }
    }
    if (message.status === "completed" || message.status === "partial") {
      if (
        !item.arm ||
        !item.launch ||
        !message.nativeSourceCoverage ||
        !message.observation
      )
        this.#deny("metric-terminal-proof-required", item);
      if (
        JSON.stringify(message.nativeSourceCoverage.armed) !==
          JSON.stringify(item.arm) ||
        JSON.stringify(message.nativeSourceCoverage.launched) !==
          JSON.stringify(item.launch)
      )
        this.#deny("metric-terminal-proof-replaced", item);
      this.#start("alignment", item);
      try {
        const observation = assertNativeMetricObservationSource(
          message.nativeSourceCoverage,
          message.observation,
          item.expected,
        );
        if (
          !Object.values(observation.metrics).some(
            (metric) => metric.records.length > 0,
          )
        )
          this.#deny("metric-no-useful-data", item);
        item.observation = freeze(structuredClone(observation));
        this.#event("completed", "alignment", item, {
          partial: message.status === "partial",
        });
      } catch (cause) {
        this.#event("failed", "alignment", item);
        throw cause;
      }
      item.terminal = true;
    }
    this.#progress(item.stage === "ready" ? "preparing" : "capturing", item);
    this.#confirmLaunch();
    this.#complete();
  }
  #confirmLaunch(): void {
    if (
      !this.#allArmed ||
      this.#failure ||
      this.#launched ||
      this.#selected.some((s) => !s.launch)
    )
      return;
    this.#launched = true;
    this.#event("completed", "launch");
    this.#resolveLaunch();
  }
  #input(
    action: "prepare" | "arm" | "cancel",
    item: Selected,
  ): ListenerControlInput {
    return {
      ...this.#trace,
      jobId: this.jobId,
      passId: this.passId,
      action,
      ...(action === "prepare" ? { config: structuredClone(item.config) } : {}),
    };
  }
  async #bounded<T>(
    operation: Promise<T>,
    ms: number,
    code: string,
    failGate = true,
  ): Promise<T> {
    const bounded = boundedListenerControl(operation, ms, code);
    try {
      return await Promise.race(
        failGate ? [bounded.promise, this.#gate] : [bounded.promise],
      );
    } finally {
      bounded.release();
    }
  }
  async #control(item: Selected, action: "prepare" | "arm"): Promise<void> {
    if (this.#failure instanceof Error) throw this.#failure;
    this.#checkDeadline();
    if (this.input.signal.aborted) this.#deny("cancelled", item);
    this.#verify();
    item.attempted = true;
    item.stage = action === "prepare" ? "preparing" : "arming";
    const pending: PendingControl = {
      abort: new AbortController(),
      acknowledged: false,
    };
    item.pending = pending;
    this.#start(action, item);
    try {
      const operation = this.service.requestListenerControl(
        item.descriptor.connectionId,
        this.#input(action, item),
        { timeoutMs: this.#controlTimeout, signal: pending.abort.signal },
      );
      // This callback never alters sealed results. A lost reply remains explicitly
      // execution-unknown even if a later cancel succeeds.
      void operation.then(
        () => {
          if (this.#failure || this.#sealed) {
            const lateAction = `late-control-${action}`;
            this.#start(lateAction, item);
            this.#event("failed", lateAction, item, {
              lateControlCompletion: true,
              execution: "unknown",
            });
          }
        },
        () => {},
      );
      const raw = await this.#bounded(
        operation,
        this.#controlTimeout,
        "control-timeout",
      );
      this.#checkFailure();
      this.#checkDeadline();
      const reply = listenerReplyMetricSchema.parse(raw);
      this.#identity(item, reply);
      if (reply.status === "failed")
        this.#deny("listener-control-denied", item, [
          failureFact("control.status", reply.status),
          failureFact("control.reason", reply.reason),
        ]);
      if (reply.status !== (action === "prepare" ? "ready" : "armed"))
        this.#deny("unexpected-control-reply", item, [
          failureFact("control.status", reply.status),
        ]);
      let admission: MetricListeningBudgetAdmission | undefined;
      if (action === "prepare") {
        const ready = assertNativeMetricReadyProof(
          reply.nativeReady,
          item.expected,
        );
        pending.acknowledged = true;
        item.expected = snapshotNativeMetricListeningExpectation({
          ...item.expected,
          generation: ready.ownership.generation,
          nativeEpoch: ready.ownership.nativeEpoch,
        });
        if (
          this.#selected.some(
            (other) =>
              other !== item &&
              other.expected.generation === item.expected.generation,
          )
        )
          this.#deny("colliding-native-generation", item);
        admission = admitMetricListeningBudget({
          config: item.config,
          ownership: ready.ownership,
          source: item.config.sourceContext!,
          jobId: this.jobId,
        });
      } else {
        if (!reply.nativeArm) this.#deny("native-arm-proof-required", item);
        item.arm = assertNativeMetricArmProof(reply.nativeArm, item.expected);
      }
      const buffered = item.buffered.splice(0);
      item.bufferedBytes = 0;
      const ordered: Message[] = [...buffered, reply].sort(
        (a, b) => a.sequence - b.sequence,
      );
      // Exactly one outstanding control reply may interleave with bounded results.
      // Never use a terminal payload to select the generation, epoch or config.
      for (const message of ordered) {
        this.#checkFailure();
        this.#identity(item, message);
        this.#sequence(item, message);
        if (message.type === "listener.reply") {
          pending.acknowledged = true;
          item.stage = action === "prepare" ? "ready" : "armed";
        } else {
          if (action === "prepare" && message.nativeLaunch)
            this.#deny("launch-before-arm", item);
          this.#consume(item, message);
        }
      }
      this.#checkFailure();
      if (admission && !admission.admitted)
        throw new MetricListeningBudgetError(
          admission,
          this.#evidence(
            admission.reason,
            item,
            admission.violations
              .slice(0, 4)
              .map((v) =>
                failureFact(
                  `budget.${v.outcome}.${v.boundary}.upperBoundBytes`,
                  v.upperBoundBytes,
                  v.byteLimit,
                  { comparison: "at-most" },
                ),
              ),
          ),
        );
      delete item.pending;
      this.#event("completed", action, item);
      this.#progress(action === "prepare" ? "preparing" : "arming", item, true);
    } catch (cause) {
      pending.abort.abort();
      this.#event(
        cause instanceof ListeningCaptureError && cause.code === "cancelled"
          ? "cancelled"
          : "failed",
        action,
        item,
        { execution: pending.acknowledged ? "confirmed" : "unknown" },
      );
      throw this.#error(cause, "metric-control-failed", item);
    }
  }
  #complete(): void {
    if (
      !this.#allArmed ||
      this.#failure ||
      this.#sealed ||
      this.#completionQueued ||
      this.#selected.some((s) => !s.observation)
    )
      return;
    this.#completionQueued = true;
    this.#start("finalization");
    // Actual ingress releases ownership after invoking result subscribers.
    // One owned microtask lets that stack finish; it is not a result/reorder queue.
    queueMicrotask(() => {
      this.#completionQueued = false;
      if (!this.#failure && !this.#sealed) this.#finish();
    });
  }
  #finish(): void {
    if (
      !this.#allArmed ||
      this.#failure ||
      this.#sealed ||
      this.#selected.some((s) => !s.observation)
    )
      return;
    try {
      this.#checkDeadline();
      this.#progress("completed", undefined, true);
      if (this.#failure) return;
      this.#verify();
      for (const item of this.#selected) {
        const active = this.#current(item);
        if (
          active.phase !== "idle" ||
          active.jobId !== undefined ||
          active.passId !== undefined
        )
          this.#deny("terminal-owner-not-released", item);
      }
      this.#release();
      if (this.#failure) return;
      if (this.input.signal.aborted) this.#deny("cancelled");
      this.#sealed = true;
      const output = freeze(
        this.#selected.map((s) => structuredClone(s.observation!)),
      );
      this.#event("completed", "finalization", undefined, {
        partial: output.some((o) => o.outcome === "partial"),
      });
      this.#event("completed", "results", undefined, {
        partial: output.some((o) => o.outcome === "partial"),
      });
      this.#event("completed", "capture", undefined, {
        partial: output.some((o) => o.outcome === "partial"),
      });
      this.#resolveResult(output);
    } catch (cause) {
      void this.#fail(this.#error(cause, "cleanup-release-failed"));
    }
  }
  #release(): void {
    if (this.#released) return;
    if (this.#releaseFailure) throw this.#releaseFailure;
    if (this.#releasing) this.#deny("reentrant-release");
    this.#releasing = true;
    this.#start("release");
    if (this.#poll !== undefined) clearInterval(this.#poll);
    if (this.#deadline !== undefined) clearTimeout(this.#deadline);
    this.input.signal.removeEventListener("abort", this.#abort);
    const unsubscribe = this.#unsubscribe;
    this.#unsubscribe = undefined;
    try {
      unsubscribe?.();
      this.#released = true;
      this.#event("completed", "release");
    } catch (cause) {
      this.#event("failed", "release");
      this.#releaseFailure = this.#error(cause, "cleanup-unsubscribe-failed");
      throw this.#releaseFailure;
    } finally {
      this.#releasing = false;
      for (const item of this.#selected) {
        item.buffered.length = 0;
        item.bufferedBytes = 0;
      }
    }
  }
  #cleanup(): Promise<void> {
    if (this.#sealed && !this.#failure) {
      this.#cleanupTask ??= Promise.resolve();
      return this.#cleanupTask;
    }
    this.#cleanupTask ??= (async () => {
      this.#start("cleanup");
      const outcomes = await Promise.allSettled(
        this.#selected.map(async (item) => {
          if (!item.attempted) return;
          this.#checkCleanupFailure(item);
          const active = this.#current(item);
          const unacknowledged =
            item.pending !== undefined && !item.pending.acknowledged;
          if (
            item.terminal &&
            active.phase === "idle" &&
            active.jobId === undefined &&
            active.passId === undefined &&
            !unacknowledged
          )
            return;
          if (
            (active.jobId !== undefined && active.jobId !== this.jobId) ||
            (active.passId !== undefined && active.passId !== this.passId)
          )
            this.#deny("cannot-cancel-stale-instance", item);
          item.pending?.abort.abort();
          this.#start("cancel", item);
          try {
            const raw = await this.#bounded(
              this.service.requestListenerControl(
                item.descriptor.connectionId,
                this.#input("cancel", item),
                { timeoutMs: this.#cleanupTimeout },
              ),
              this.#cleanupTimeout,
              "cleanup-timeout",
              false,
            );
            const reply = listenerReplyMetricSchema.parse(raw);
            this.#checkCleanupFailure(item);
            this.#identity(item, reply);
            if (reply.status !== "cancelled")
              this.#deny("cancellation-unconfirmed", item);
            if (
              item.sequence !== undefined &&
              reply.sequence !== item.sequence + 1 &&
              !unacknowledged
            )
              this.#deny("cancel-sequence-gap", item);
            const released = this.#current(item);
            if (
              released.phase !== "idle" ||
              released.jobId !== undefined ||
              released.passId !== undefined
            )
              this.#deny("cancellation-owner-not-released", item);
            if (unacknowledged) this.#deny("control-execution-unknown", item);
            item.sequence = reply.sequence;
            item.terminal = true;
            this.#event("completed", "cancel", item, {
              producerSequence: reply.sequence,
              receivedResults: item.resultCount,
            });
          } catch (cause) {
            this.#event("failed", "cancel", item);
            throw cause;
          }
        }),
      );
      const failures = outcomes.flatMap((o) =>
        o.status === "rejected"
          ? [this.#error(o.reason, "cleanup-failed")]
          : [],
      );
      for (const item of this.#selected)
        if (item.cleanupFailure && !failures.includes(item.cleanupFailure))
          failures.push(item.cleanupFailure);
      try {
        this.#release();
      } catch (cause) {
        failures.push(this.#error(cause, "cleanup-release-failed"));
      }
      this.#event(failures.length ? "failed" : "completed", "cleanup");
      if (failures.length)
        throw new AggregateError(
          failures,
          "Metric listener cleanup unconfirmed",
        );
    })();
    return this.#cleanupTask;
  }
  #fail(primary: ListeningCaptureError): Promise<void> {
    if (this.#sealed && !this.#failure) return Promise.resolve();
    if (this.#failureTask) return this.#failureTask;
    this.#failure = primary;
    // Open this gate synchronously: global failure during prepare cannot wait
    // for the pending control reply or its unrelated timeout.
    this.#rejectGate(primary);
    for (const item of this.#selected) item.pending?.abort.abort();
    this.#failureTask = (async () => {
      // Allow subscription/control stack frames to finish installing their
      // bounded resources before cleanup; the failure gate is already open.
      await Promise.resolve();
      try {
        await this.#cleanup();
      } catch (cause) {
        this.#failure = new MetricListeningCleanupError(
          primary,
          cause instanceof AggregateError ? cause.errors : [cause],
        );
      }
      this.#sealed = true;
      const stage =
        primary.code === "cancelled" || primary.code === "listener-cancelled"
          ? "cancelled"
          : "failed";
      if (this.#stages.has("finalization:pass"))
        this.#event(stage, "finalization");
      if (!this.#launched) {
        this.#event(stage, "launch");
        this.#rejectLaunch(this.#failure!);
      }
      this.#event(stage, "results");
      this.#event(stage, "capture", undefined, {
        failureEvidence: primary.failureEvidence,
      });
      this.#rejectResult(this.#failure!);
    })();
    return this.#failureTask;
  }
  #abort = (): void => {
    void this.#fail(
      this.#error(new ListeningCaptureError("cancelled"), "cancelled"),
    );
  };

  async prepare(): Promise<void> {
    this.#start("capture");
    this.#start("results");
    this.#start("launch");
    try {
      if (this.input.signal.aborted) this.#deny("cancelled");
      // This is the absolute pass deadline, established before prepare controls.
      const remaining =
        this.#resultTimeout - (performance.now() - this.#startedAt);
      if (remaining <= 0) this.#deny("capture-timeout");
      this.#deadline = setTimeout(() => {
        void this.#fail(
          this.#error(
            new ListeningCaptureError("capture-timeout"),
            "capture-timeout",
          ),
        );
      }, remaining);
      this.#unsubscribe = this.service.onListenerResult(this.#receive);
      this.input.signal.addEventListener("abort", this.#abort, { once: true });
      if (this.input.signal.aborted) this.#deny("cancelled");
      this.#poll = setInterval(() => {
        if (this.#sealed || this.#failure) return;
        try {
          this.#verify();
        } catch (cause) {
          void this.#fail(this.#error(cause, "listener-inspection-failed"));
        }
      }, 50);
      for (const item of this.#selected) await this.#control(item, "prepare");
      for (const item of this.#selected) await this.#control(item, "arm");
      if (this.#failure) throw this.#failure;
      this.#verify();
      this.#allArmed = true;
      this.#confirmLaunch();
      this.#complete();
    } catch (cause) {
      await this.#fail(this.#error(cause, "capture-preparation-failed"));
      if (this.#failure instanceof Error) throw this.#failure;
      throw this.#error(cause, "capture-preparation-failed");
    }
  }
  async disarm(): Promise<void> {
    if (!this.#sealed)
      await this.#fail(
        this.#error(new ListeningCaptureError("cancelled"), "cancelled"),
      );
    await this.#cleanup();
  }
}

/**
 * Explicit version5 only. The caller must authorize stop/seek before calling,
 * start transport only after this handle returns, then gate publication on its
 * own cancellation/commit boundary. No transport mutation or persistence here.
 */
export async function prepareMetricListenerCapture(
  service: ListenerService,
  input: PrepareMetricListenerCaptureInput,
): Promise<PreparedMetricListeningCapture> {
  const jobId = randomUUID();
  let capture: MetricCapture;
  try {
    capture = new MetricCapture(service, input, jobId);
  } catch (cause) {
    const error =
      cause instanceof ListeningCaptureError
        ? cause
        : new ListeningCaptureError(
            "invalid-metric-capture-input",
            cause instanceof Error
              ? cause.message
              : "invalid-metric-capture-input",
          );
    for (const stage of ["queued", "started", "failed"])
      recordSignalTelemetry(input.telemetry, {
        name: `listening.metric-capture.${stage}`,
        source: "metric-listening-capture",
        correlationId: input.trace.correlationId,
        causationId: input.trace.causationId,
        ...(telemetryIdSchema.safeParse(input.trace.traceId).success
          ? {
              trace: {
                traceId: input.trace.traceId,
                spanId: stableTelemetryId(`${jobId}:validation`),
              },
            }
          : {}),
        ...(stage === "failed" ? { outcome: "failure" as const } : {}),
        attributes: sanitizeTelemetryAttributes({
          action: "validation",
          passId: input.passId,
          jobId,
          code: error.code,
          detail: error.message,
        }),
      });
    throw error;
  }
  await capture.prepare();
  return Object.freeze({
    jobId: capture.jobId,
    passId: capture.passId,
    observationContract: capture.observationContract,
    result: capture.result,
    nativeLaunch: capture.nativeLaunch,
    disarm: () => capture.disarm(),
  });
}
