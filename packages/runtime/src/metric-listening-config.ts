import { isDeepStrictEqual } from "node:util";
import {
  createMetricListeningGeometry,
  metricAudioObservationSchema,
  nativeMetricListeningConfigSchema,
  NATIVE_METRIC_ALGORITHM_VERSION,
  NATIVE_METRIC_LISTENING_SCOPE,
  type ListeningTimingPolicy,
  type MetricAudioObservation,
  type NativeMetricListeningConfig,
  type StoredAudioObservation,
} from "@ableton-agent/protocol";
import type { ListeningPassContext } from "@ableton-agent/application";
import type { ListenerDescriptor } from "@ableton-agent/signal-routing";
import { denyListening as deny, failureFact } from "./listening-failure.js";

export interface MetricCaptureBinding {
  readonly descriptor: ListenerDescriptor;
  readonly config: NativeMetricListeningConfig;
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Expected Bridge metadata is not a physical source certificate. */
export function createMetricCaptureBinding(input: {
  readonly descriptor: ListenerDescriptor;
  readonly source: MetricAudioObservation["source"];
  readonly tempoBpm: number;
  readonly timingPolicy: ListeningTimingPolicy;
  readonly requestedMetrics?: Readonly<
    NativeMetricListeningConfig["requestedMetrics"]
  >;
}): MetricCaptureBinding {
  const descriptor = structuredClone(input.descriptor);
  const registration = descriptor.registration;
  if (registration.version !== 5)
    deny("listener_version_unsupported", undefined, [
      failureFact("listener.version", registration.version, 5),
    ]);
  if (
    registration.nativeStatus.scope !== NATIVE_METRIC_LISTENING_SCOPE ||
    !registration.nativeStatus.supportedModes.includes(input.source.view) ||
    (registration.nativeStatus.readiness !== "READY" &&
      registration.nativeStatus.reason !==
        "fresh_per_pass_native_validation_required")
  )
    deny("metric_listener_mode_unavailable", undefined, [
      failureFact(
        "listener.scope",
        registration.nativeStatus.scope,
        NATIVE_METRIC_LISTENING_SCOPE,
      ),
      failureFact("listener.requestedMode", input.source.view),
      failureFact(
        "listener.readiness",
        registration.nativeStatus.readiness,
        "READY|fresh-per-pass",
      ),
    ]);
  const geometry = createMetricListeningGeometry({
    sampleRate:
      registration.sampleRate === 44_100 || registration.sampleRate === 48_000
        ? registration.sampleRate
        : deny("unsupported_native_sample_rate", undefined, [
            failureFact(
              "listener.sampleRate",
              registration.sampleRate,
              "44100|48000",
            ),
          ]),
    vectorSize: registration.vectorSize,
    tempoBpm: input.tempoBpm,
    startBeat: input.source.transport.startBeat,
    endBeat: input.source.transport.endBeat,
    startSample: 0,
  });
  const requestedMetrics = [
    ...(input.requestedMetrics ?? ["level", "spectral-centroid", "attacks"]),
  ];
  const shared = {
    scope: NATIVE_METRIC_LISTENING_SCOPE,
    algorithmVersion: NATIVE_METRIC_ALGORITHM_VERSION,
    geometry,
    timingPolicy: input.timingPolicy,
    sourceContext: input.source,
    grid: {
      beats: 0.25,
      anchor: "global-beat-grid",
      rounding: "nearest-sample",
      coordinates: "capture-local",
    },
    requestedMetrics,
    ...(requestedMetrics.includes("attacks")
      ? {
          attacks: {
            thresholdDb: 6,
            minSpacingSamples: Math.round(geometry.sampleRate / 10),
          },
        }
      : {}),
  };
  const config = nativeMetricListeningConfigSchema.parse(
    input.source.view === "session"
      ? {
          ...shared,
          mode: "session",
          sourceEvidence: "expected-context-only",
          source: {
            mode: "session",
            synchronization: "transport-coupled-first-iteration",
            target: input.source.target,
          },
        }
      : { ...shared, mode: "arrangement", sourceEvidence: "transport-only" },
  );
  return freeze({ descriptor, config });
}

/** Defense at publication, after the control driver has authenticated native proofs. */
export function validateMetricCaptureObservations(
  observations: readonly StoredAudioObservation[],
  bindings: readonly MetricCaptureBinding[],
  pass: Pick<ListeningPassContext, "passId" | "trace">,
): readonly MetricAudioObservation[] {
  if (observations.length !== bindings.length)
    deny("invalid_metric_capture_observation", undefined, [
      failureFact("observation.count", observations.length, bindings.length),
    ]);
  const seen = new Set<string>();
  return freeze(
    observations.map((raw) => {
      const observation = metricAudioObservationSchema.parse(raw);
      const owner = observation.ownership;
      const binding = bindings.find(
        (item) => item.descriptor.producer.producerId === owner.listenerId,
      );
      if (!binding || seen.has(owner.listenerId))
        deny("invalid_metric_capture_observation", undefined, [
          failureFact("observation.listenerKnown", Boolean(binding), true),
          failureFact(
            "observation.duplicateListener",
            seen.has(owner.listenerId),
            false,
          ),
        ]);
      seen.add(owner.listenerId);
      const { config, descriptor } = binding;
      const local = config.geometry;
      const expectedGeometry = createMetricListeningGeometry({
        sampleRate: local.sampleRate,
        vectorSize: local.vectorSize,
        tempoBpm: local.tempoBpm,
        startBeat: local.startBeat,
        endBeat: local.endBeat,
        startSample: observation.geometry.startSample,
      });
      const attack = observation.metrics.attacks.algorithm;
      if (
        owner.passId !== pass.passId ||
        owner.connectionId !== descriptor.connectionId ||
        owner.connectionEpoch !== descriptor.registration.connectionEpoch ||
        owner.traceId !== pass.trace.traceId ||
        owner.correlationId !== pass.trace.correlationId ||
        owner.causationId !== pass.trace.causationId ||
        !isDeepStrictEqual(observation.source, config.sourceContext) ||
        !isDeepStrictEqual(observation.geometry, expectedGeometry) ||
        !isDeepStrictEqual(observation.alignment.policy, config.timingPolicy) ||
        observation.alignment.vectorSize !== local.vectorSize ||
        !isDeepStrictEqual(
          observation.requestedMetrics,
          config.requestedMetrics,
        ) ||
        (config.requestedMetrics.includes("attacks") &&
          (!attack ||
            attack.thresholdDb !== config.attacks?.thresholdDb ||
            attack.minSpacingSamples !== config.attacks?.minSpacingSamples))
      )
        deny("invalid_metric_capture_observation", undefined, [
          failureFact("observation.passId", owner.passId, pass.passId),
          failureFact(
            "observation.connectionId",
            owner.connectionId,
            descriptor.connectionId,
          ),
          failureFact(
            "observation.connectionEpoch",
            owner.connectionEpoch,
            descriptor.registration.connectionEpoch,
          ),
          failureFact(
            "observation.sourceMatches",
            isDeepStrictEqual(observation.source, config.sourceContext),
            true,
          ),
          failureFact(
            "observation.geometryMatches",
            isDeepStrictEqual(observation.geometry, expectedGeometry),
            true,
          ),
          failureFact("observation.traceId", owner.traceId, pass.trace.traceId),
          failureFact(
            "observation.correlationId",
            owner.correlationId,
            pass.trace.correlationId,
          ),
          failureFact(
            "observation.causationId",
            owner.causationId,
            pass.trace.causationId,
          ),
        ]);
      return observation;
    }),
  );
}
