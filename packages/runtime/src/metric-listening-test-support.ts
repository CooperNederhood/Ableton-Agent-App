import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  listenerControlMetricSchema,
  listenerMetricWireIdentitySchema,
  listenerReplyMetricSchema,
  listenerResultMetricSchema,
  type ListenerControlInput,
  type ListenerControlMetric,
  type ListenerDescriptor,
  type ListenerReplyMetric,
  type ListenerResultEvent,
  type ListenerResultMetric,
  type ListenerService,
} from "@ableton-agent/signal-routing";
import {
  bindMetricFixtureToControl,
  type SyntheticMetricWireFixture,
} from "@ableton-agent/signal-routing/testing";
import {
  createMetricObservationReportRows,
  MEL_BAND_PROFILE,
  melBandTimelineSchema,
  type ListeningFailureEvidence,
} from "@ableton-agent/protocol";

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
  readonly subscribers = new Set<(event: ListenerResultEvent) => void>();
  readonly calls: ListenerControlInput[] = [];
  readonly controls: ListenerControlMetric[] = [];
  sequence = -1;
  prepareHook?: () => void | Promise<void>;
  armHook?: (reply: ListenerReplyMetric) => void | Promise<void>;
  cancelHook?: () => void | Promise<void>;
  unsubscribeHook?: () => void;
  #current: ListenerControlMetric | undefined;

  constructor(
    descriptor: ListenerDescriptor,
    public data: SyntheticMetricWireFixture,
    readonly options: SyntheticMetricPeerOptions = {},
  ) {
    this.descriptor = descriptor;
  }

  inspectListeners(): readonly ListenerDescriptor[] {
    return structuredClone([this.descriptor]);
  }
  onListenerResult(callback: (event: ListenerResultEvent) => void) {
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
      if (this.subscribers.size === 0)
        throw new Error("Synthetic peer requires subscription before prepare");
      if (
        !control.config?.sourceContext ||
        !isDeepStrictEqual(
          control.config.geometry,
          this.data.config.geometry,
        ) ||
        !isDeepStrictEqual(
          control.config.timingPolicy,
          this.data.config.timingPolicy,
        )
      )
        throw new Error(
          "Synthetic peer requires its declared geometry, policy and actual inspected source",
        );
      this.data = bindMetricFixtureToControl(this.data, control);
      this.data.ready.config = structuredClone(control.config);
      this.data.proof.armed.config = structuredClone(control.config);
      this.data.observation.source = structuredClone(
        control.config.sourceContext,
      );
      this.data.observation.requestedMetrics = [
        ...control.config.requestedMetrics,
      ];
      if (
        control.config.requestedMetrics.includes("mel-bands") &&
        this.options.provideMelBands !== false
      ) {
        const observation = this.data.observation;
        const support = observation.sourceCoverage;
        const expectedRecords = Math.floor(
          (support.endSample - support.startSample) / 2048,
        );
        observation.metrics["mel-bands"] ??= melBandTimelineSchema.parse({
          schema: "mel-band-timeline/v1",
          status: "complete",
          sampleRate: observation.geometry.sampleRate,
          profile: MEL_BAND_PROFILE,
          sourceSupport: support,
          expectedRecords,
          frames: Array.from({ length: expectedRecords }, (_, index) => ({
            index,
            support: {
              startSample: support.startSample + index * 2048,
              endSample: support.startSample + (index + 1) * 2048,
            },
            magnitudes: [Array(24).fill(0.5), Array(24).fill(0.25)],
          })),
          gaps: [],
        });
        observation.rows = createMetricObservationReportRows(observation);
      }
      this.#current = control;
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
      sequence: ++this.sequence,
      status:
        control.action === "prepare"
          ? "ready"
          : control.action === "arm"
            ? "armed"
            : "cancelled",
      ...(control.action === "prepare" ? { nativeReady: this.data.ready } : {}),
      ...(control.action === "arm" ? { nativeArm: this.data.proof.armed } : {}),
      ...(control.action === "cancel" ? { reason: "cancelled" } : {}),
    });
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
      sequence: ++this.sequence,
      status: "progress",
      ...patch,
    });
    return result;
  }
  emit(result: ListenerResultMetric, evidence?: ListeningFailureEvidence) {
    const event: ListenerResultEvent = {
      connectionId: this.descriptor.connectionId,
      producer: structuredClone(this.descriptor.producer),
      binding: structuredClone(this.descriptor.binding),
      result,
      ...(evidence ? { failureEvidence: evidence } : {}),
    };
    try {
      for (const callback of this.subscribers) callback(event);
    } finally {
      if (result.status !== "progress") this.releaseOwner();
    }
  }
  lifecycle(patch: object = {}) {
    if (!this.#current) throw new Error("Synthetic lifecycle before prepare");
    return {
      eventId: randomUUID(),
      causationId: this.#current.causationId,
      scope: "independent-metric-timelines/v1" as const,
      generation: this.#current.generation,
      nativeEpoch: this.data.ready.ownership.nativeEpoch,
      stage: "progress" as const,
      phase: "preflight" as const,
      elapsedMs: 10,
      frames: 0,
      ...patch,
    };
  }
  launch() {
    this.emit(
      this.event({
        nativeLaunch: this.data.proof.launched,
      }),
    );
  }
  complete() {
    this.emit(
      this.event({
        status:
          this.data.observation.outcome === "partial" ? "partial" : "completed",
        observation: this.data.observation,
        nativeSourceCoverage: this.data.proof,
      }),
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
    subscribers: peer.subscribers,
    emit: (patch: Partial<ListenerResultMetric>) =>
      peer.emit(peer.event(patch)),
    launch: () => peer.launch(),
    complete: () => peer.complete(),
  };
}
