import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  listenerControlMetricSchema,
  listenerMetricWireIdentitySchema,
  listenerReplyMetricSchema,
  listenerResultMetricSchema,
  listenerRegistrationMetricSchema,
  type ListenerControlInput,
  type ListenerControlMetric,
  type ListenerDescriptor,
  type ListenerReplyMetric,
  type ListenerResultEvent,
  type ListenerResultMetric,
  type ListenerService,
} from "@ableton-agent/signal-routing";
import type { SyntheticMetricWireFixture } from "@ableton-agent/signal-routing/testing";
import {
  METRIC_RECORD_STREAM_CAPABILITY,
  METRIC_CONTINUOUS_LISTENING_CAPABILITY,
  NATIVE_CONTINUOUS_METRIC_LISTENING_SCOPE,
  nativeMetricOwnershipSchema,
  nativeContinuousMetricListeningConfigSchema,
  compactMetricRecordStreamDescriptor,
  metricObservationMetricSchema,
  type ListeningFailureEvidence,
} from "@ableton-agent/protocol";
import {
  createSyntheticAnalyzerReadiness,
  createSyntheticMetricRecordStreamFixture,
  type SyntheticMetricRecordStreamFixture,
} from "@ableton-agent/protocol/testing";

export function withSyntheticMetricStreamRegistration(
  registration: ListenerDescriptor["registration"],
) {
  const base = listenerRegistrationMetricSchema.parse(registration);
  return listenerRegistrationMetricSchema.parse({
    ...base,
    capabilities: [
      ...new Set([
        ...base.capabilities,
        "audio-listener/analyzer-timelines-v1",
        METRIC_CONTINUOUS_LISTENING_CAPABILITY,
      ]),
    ],
    analyzerReadiness: createSyntheticAnalyzerReadiness(),
    nativeStatus: {
      ...base.nativeStatus,
      version: 6,
      scope: NATIVE_CONTINUOUS_METRIC_LISTENING_SCOPE,
      readiness: "BLOCKED",
      executedGen: null,
      reason: "fresh_per_pass_native_validation_required",
      maxAudioDurationMs: 600_000,
      maxSessionAudioDurationMs: 600_000,
      maxReportRows: 39_961,
      maxSessionReportRows: 39_961,
      streamCapability: METRIC_RECORD_STREAM_CAPABILITY,
    },
  });
}

type MutableDescriptor = {
  -readonly [K in keyof ListenerDescriptor]: ListenerDescriptor[K];
};
interface SyntheticMetricPeerOptions {
  readonly recordControl?: (action: string) => void;
  readonly cancelledResultBeforeReply?: boolean;
  readonly provideMelBands?: boolean;
}

/** Bounded test peer with synthetic proofs, not native execution evidence. */
export class SyntheticMetricListenerPeer implements ListenerService {
  readonly descriptor: MutableDescriptor;
  readonly subscribers = new Set<
    (event: ListenerResultEvent) => void | Promise<void>
  >();
  readonly calls: ListenerControlInput[] = [];
  readonly controls: ListenerControlMetric[] = [];
  sequence = -1;
  prepareHook?: () => void | Promise<void>;
  armHook?: (reply: ListenerReplyMetric) => void | Promise<void>;
  cancelHook?: () => void | Promise<void>;
  unsubscribeHook?: () => void;
  #current: ListenerControlMetric | undefined;
  stream: SyntheticMetricRecordStreamFixture | undefined;

  constructor(
    descriptor: ListenerDescriptor,
    public data: SyntheticMetricWireFixture,
    readonly options: SyntheticMetricPeerOptions = {},
  ) {
    this.descriptor = descriptor;
  }

  /** Live's own stopped/start song beats from the wire fixture, independent of clip-local geometry. */
  private sessionClockBeats() {
    const { armed, launched } = this.data.proof;
    const g = this.data.config.geometry;
    return {
      stoppedBeat: armed.before.frames[0]![1],
      launchBeat:
        launched.clock[1] -
        ((launched.clock[4] - launched.timing[6]) * g.tempoBpm) /
          (g.sampleRate * 60),
    };
  }

  inspectListeners(): readonly ListenerDescriptor[] {
    return structuredClone([this.descriptor]);
  }
  onListenerResult(
    callback: (event: ListenerResultEvent) => void | Promise<void>,
  ) {
    if (this.subscribers.size >= 16)
      throw new Error("Synthetic peer subscriber quota exceeded");
    this.subscribers.add(callback);
    return () => {
      this.unsubscribeHook?.();
      this.subscribers.delete(callback);
    };
  }
  async requestListenerControl(
    connectionId: string,
    input: ListenerControlInput,
  ) {
    if (connectionId !== this.descriptor.connectionId)
      throw new Error("Synthetic control targets a different connection");
    if (this.calls.length >= 64)
      throw new Error("Synthetic peer control quota exceeded");
    this.calls.push(structuredClone(input));
    const control = listenerControlMetricSchema.parse({
      ...input,
      type: "listener.control",
      protocolVersion: 1,
      listenerVersion: 5,
      mode: this.data.config.mode,
      listenerId: this.descriptor.producer.producerId,
      connectionId,
      connectionEpoch: this.descriptor.registration.connectionEpoch,
      generation:
        input.action === "prepare" ? randomUUID() : this.#current?.generation,
      requestId: randomUUID(),
      sequence: this.controls.length,
    });
    this.controls.push(control);
    this.options.recordControl?.(input.action);
    if (control.action === "prepare") {
      const rawConfig = control.config;
      if (this.subscribers.size === 0)
        throw new Error("Synthetic peer requires subscription before prepare");
      if (
        !rawConfig?.sourceContext ||
        rawConfig.scope !== NATIVE_CONTINUOUS_METRIC_LISTENING_SCOPE ||
        !["sampleRate", "vectorSize", "tempoBpm", "startBeat", "endBeat"].every(
          (key) =>
            Reflect.get(rawConfig.geometry, key) ===
            Reflect.get(this.data.config.geometry, key),
        ) ||
        !isDeepStrictEqual(
          rawConfig.timingPolicy,
          this.data.config.timingPolicy,
        )
      )
        throw new Error(
          "Synthetic peer requires its declared geometry, policy and actual inspected source",
        );
      this.#current = control;
      const config =
        nativeContinuousMetricListeningConfigSchema.parse(rawConfig);
      this.stream = await createSyntheticMetricRecordStreamFixture({
        source: rawConfig.sourceContext,
        ownership: nativeMetricOwnershipSchema.parse({
          listenerId: control.listenerId,
          passId: control.passId,
          connectionId: control.connectionId,
          connectionEpoch: control.connectionEpoch,
          generation: control.generation,
          traceId: control.traceId,
          correlationId: control.correlationId,
          causationId: control.causationId,
          nativeEpoch:
            this.data.ready.ownership.nativeEpoch +
            this.controls.filter((item) => item.action === "prepare").length -
            1,
        }),
        seconds: config.geometry.totalSamples / config.geometry.sampleRate,
        sampleRate: config.geometry.sampleRate,
        vectorSize: config.geometry.vectorSize,
        tempoBpm: config.geometry.tempoBpm,
        startBeat: config.geometry.startBeat,
        timingPolicy: config.timingPolicy,
        requestedMetrics: config.requestedMetrics,
        gaps: Object.entries(this.data.observation.metrics).flatMap(
          ([metric, timeline]) =>
            timeline?.gaps.map((gap) => ({
              metric: metricObservationMetricSchema.parse(metric),
              firstIndex: gap.firstIndex,
              count: gap.count,
              reason: gap.reason,
            })) ?? [],
        ),
        ...(this.options.provideMelBands === false
          ? { unavailableMetrics: ["mel-bands"] }
          : {}),
        ...(config.mode === "session" ? this.sessionClockBeats() : {}),
      });
      this.descriptor.phase = "preparing";
      this.descriptor.jobId = input.jobId;
      this.descriptor.passId = input.passId;
      await this.prepareHook?.();
      this.descriptor.phase = "ready";
    } else if (control.action === "arm") {
      this.descriptor.phase = "armed";
    } else {
      await this.cancelHook?.();
      if (this.options.cancelledResultBeforeReply)
        this.emit(this.event({ status: "cancelled", reason: "requested" }));
      this.releaseOwner();
    }
    const reply = listenerReplyMetricSchema.parse({
      ...this.wire(),
      requestId: control.requestId,
      type: "listener.reply",
      sequence: this.sequence + 1,
      status:
        control.action === "prepare"
          ? "ready"
          : control.action === "arm"
            ? "armed"
            : "cancelled",
      ...(control.action === "prepare"
        ? { nativeReady: this.stream?.ready }
        : {}),
      ...(control.action === "arm" ? { nativeArm: this.stream?.armed } : {}),
      ...(control.action === "cancel" ? { reason: "cancelled" } : {}),
    });
    this.sequence = reply.sequence;
    if (control.action === "arm") await this.armHook?.(reply);
    return reply;
  }
  wire() {
    const control = this.#current;
    if (!control) throw new Error("Synthetic result before prepare");
    return listenerMetricWireIdentitySchema.parse(
      Object.fromEntries(
        Object.keys(listenerMetricWireIdentitySchema.shape).map((key) => [
          key,
          key === "sequence"
            ? Math.max(0, this.sequence)
            : Reflect.get(control, key),
        ]),
      ),
    );
  }
  releaseOwner() {
    this.descriptor.phase = "idle";
    delete this.descriptor.jobId;
    delete this.descriptor.passId;
  }
  event(patch: Partial<ListenerResultMetric>) {
    const result = listenerResultMetricSchema.parse({
      ...this.wire(),
      type: "listener.result",
      requestId: randomUUID(),
      sequence: this.sequence + 1,
      status: "progress",
      ...patch,
    });
    this.sequence = result.sequence;
    return result;
  }
  emit(
    result: ListenerResultMetric,
    evidence?: ListeningFailureEvidence,
  ): void {
    const delivery = this.emitDurable(result, evidence);
    if (delivery !== undefined) void delivery.catch(() => {});
  }
  emitDurable(
    result: ListenerResultMetric,
    evidence?: ListeningFailureEvidence,
  ): void | Promise<void> {
    const event: ListenerResultEvent = {
      connectionId: this.descriptor.connectionId,
      producer: structuredClone(this.descriptor.producer),
      binding: structuredClone(this.descriptor.binding),
      result,
      ...(evidence ? { failureEvidence: evidence } : {}),
    };
    const release = () => {
      if (result.status !== "progress") this.releaseOwner();
    };
    try {
      const deliveries: Promise<void>[] = [];
      for (const callback of this.subscribers) {
        const delivery = callback(event);
        if (delivery !== undefined) deliveries.push(delivery);
      }
      if (deliveries.length)
        return Promise.all(deliveries)
          .then(() => {})
          .finally(release);
      release();
    } catch (error) {
      release();
      throw error;
    }
  }
  lifecycle(patch: object = {}) {
    if (!this.#current) throw new Error("Synthetic lifecycle before prepare");
    return {
      eventId: randomUUID(),
      causationId: this.#current.causationId,
      scope: NATIVE_CONTINUOUS_METRIC_LISTENING_SCOPE,
      generation: this.#current.generation,
      nativeEpoch:
        this.stream?.descriptor.ownership.nativeEpoch ??
        this.data.ready.ownership.nativeEpoch,
      stage: "progress" as const,
      phase: "preflight" as const,
      elapsedMs: 10,
      frames: 0,
      ...patch,
    };
  }
  launch() {
    if (!this.stream) throw new Error("Synthetic launch before prepare");
    this.emit(
      this.event({
        nativeLaunch: this.stream.manifest.nativeProof.launch,
      }),
    );
  }
  complete() {
    const stream = this.stream;
    if (!stream) throw new Error("Synthetic completion before prepare");
    const deliver = async () => {
      await this.emitDurable(
        this.event({
          metricStream: compactMetricRecordStreamDescriptor(stream.descriptor),
        }),
      );
      for await (const chunk of stream.chunks())
        await this.emitDurable(this.event({ metricChunk: chunk }));
      await this.emitDurable(
        this.event({
          status:
            stream.manifest.outcome === "complete"
              ? "completed"
              : stream.manifest.outcome,
          metricManifest: stream.manifest,
        }),
      );
    };
    void deliver().catch((error: unknown) =>
      this.emit(
        this.event({
          status: "failed",
          reason:
            error instanceof Error
              ? error.message.slice(0, 500)
              : "Synthetic stream delivery failed",
        }),
      ),
    );
  }
}

/** Plain service methods remain enumerable for existing host test wrappers. */
export function createSyntheticMetricListenerPeer(
  descriptor: ListenerDescriptor,
  data: SyntheticMetricWireFixture,
  recordControl: (action: string) => void,
  options: Pick<SyntheticMetricPeerOptions, "provideMelBands"> = {},
) {
  const peer = new SyntheticMetricListenerPeer(descriptor, data, {
    ...options,
    recordControl,
    cancelledResultBeforeReply: true,
  });
  const service: ListenerService = {
    inspectListeners: () => peer.inspectListeners(),
    onListenerResult: (callback) => peer.onListenerResult(callback),
    requestListenerControl: (id, input) =>
      peer.requestListenerControl(id, input),
  };
  return {
    service,
    get stream() {
      return peer.stream;
    },
    subscribers: peer.subscribers,
    emit: (patch: Partial<ListenerResultMetric>) =>
      peer.emit(peer.event(patch)),
    launch: () => peer.launch(),
    complete: () => peer.complete(),
  };
}
