import {
  createContinuousMetricListeningGeometry,
  METRIC_CONTINUOUS_LISTENING_CAPABILITY,
  nativeContinuousMetricListeningConfigSchema as nativeMetricListeningConfigSchema,
  NATIVE_CONTINUOUS_METRIC_LISTENING_SCOPE,
  MAX_METRIC_RECORD_CHUNK_BYTES,
  MAX_METRIC_RECORD_PENDING_CHUNKS,
  NATIVE_METRIC_ALGORITHM_VERSION,
  LISTENER_CAPABILITY_ANALYZER_TIMELINES,
  type ListeningTimingPolicy,
  type MetricAudioObservation,
  type NativeContinuousMetricListeningConfig as NativeMetricListeningConfig,
} from "@ableton-agent/protocol";
import {
  listenerRegistrationMetricSchema,
  type ListenerDescriptor,
} from "@ableton-agent/signal-routing";
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
  readonly stoppedBeat?: number;
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
  listenerRegistrationMetricSchema.parse(registration);
  if (
    !registration.capabilities.some(
      (capability) =>
        String(capability) === METRIC_CONTINUOUS_LISTENING_CAPABILITY,
    )
  )
    deny("continuous_metric_stream_unavailable", undefined, [
      failureFact(
        "listener.requiredCapability",
        METRIC_CONTINUOUS_LISTENING_CAPABILITY,
      ),
      failureFact("listener.requestedMode", input.source.view),
    ]);
  if (
    registration.nativeStatus.scope !==
      NATIVE_CONTINUOUS_METRIC_LISTENING_SCOPE ||
    !registration.nativeStatus.supportedModes.includes(input.source.view) ||
    (registration.nativeStatus.readiness !== "READY" &&
      registration.nativeStatus.reason !==
        "fresh_per_pass_native_validation_required")
  )
    deny("metric_listener_mode_unavailable", undefined, [
      failureFact(
        "listener.scope",
        registration.nativeStatus.scope,
        NATIVE_CONTINUOUS_METRIC_LISTENING_SCOPE,
      ),
      failureFact("listener.requestedMode", input.source.view),
      failureFact(
        "listener.readiness",
        registration.nativeStatus.readiness,
        "READY|fresh-per-pass",
      ),
    ]);
  const geometryInput = {
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
  } as const;
  const geometry = createContinuousMetricListeningGeometry({
    ...geometryInput,
    captureMode: "finite-metric-stream",
  });
  const requestedMetrics = [
    ...(input.requestedMetrics ?? [
      "level",
      "spectral-centroid",
      "attacks",
      "mel-bands",
      "pitch",
      "spectral-shape",
    ]),
  ];
  if (
    requestedMetrics.some(
      (metric) => metric === "pitch" || metric === "spectral-shape",
    ) &&
    !registration.capabilities.some(
      (capability) => capability === LISTENER_CAPABILITY_ANALYZER_TIMELINES,
    )
  )
    deny("analyzer_timelines_unavailable", undefined, [
      failureFact(
        "listener.requiredCapability",
        LISTENER_CAPABILITY_ANALYZER_TIMELINES,
      ),
    ]);
  const shared = {
    scope: NATIVE_CONTINUOUS_METRIC_LISTENING_SCOPE,
    capability: METRIC_CONTINUOUS_LISTENING_CAPABILITY,
    captureMode: "finite-metric-stream",
    maxPendingChunks: MAX_METRIC_RECORD_PENDING_CHUNKS,
    maxChunkBytes: MAX_METRIC_RECORD_CHUNK_BYTES,
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
          stoppedBeat: input.stoppedBeat ?? input.source.transport.startBeat,
          sourceEvidence: "expected-context-only",
          source: {
            mode: "session",
            synchronization: "transport-coupled-first-iteration",
            target: input.source.target,
          },
        }
      : {
          ...shared,
          mode: "arrangement",
          sourceEvidence: "transport-only",
        },
  );
  return freeze({ descriptor, config });
}
