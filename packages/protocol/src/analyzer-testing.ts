import {
  PITCH_PROFILE,
  SPECTRAL_SHAPE_PROFILE,
  analyzerNativeReadinessSchema,
} from "./analyzer-profile.js";
import {
  classifyPitchEstimate,
  deriveAnalyzerTrailingSupport,
  pitchTimelineSchema,
  spectralShapeTimelineSchema,
  type AnalyzerTimelineGap,
} from "./analyzer-timeline.js";
import {
  createMetricObservationReportRows,
  metricAudioObservationSchema,
  type MetricAudioObservation,
} from "./metric-observation-schemas.js";

/** Synthetic perform receipt only, not a native DSP readiness certificate. */
export function createSyntheticAnalyzerReadiness(
  sampleRate: 44100 | 48000 = 48000,
) {
  return analyzerNativeReadinessSchema.parse({
    schema: "analyzer-native-readiness/v1",
    producerAbi: 3,
    sourceAbi: 3,
    probeToken: 1,
    dspGeneration: 1,
    sampleRate,
    sourceClock: 0,
  });
}

/** Synthetic structure/consumer evidence only; never native qualification. */
export function withSyntheticAnalyzerTimelines(
  input: MetricAudioObservation,
  failure?: AnalyzerTimelineGap["reason"],
): MetricAudioObservation {
  const observation = structuredClone(input);
  const sourceSupport = observation.sourceCoverage;
  const expectedRecords = Math.floor(observation.geometry.totalSamples / 2048);
  const supports = Array.from({ length: expectedRecords }, (_, index) => ({
    index,
    support: {
      startSample: sourceSupport.startSample + index * 2048,
      endSample: sourceSupport.startSample + (index + 1) * 2048,
    },
  }));
  const common = {
    sampleRate: observation.geometry.sampleRate,
    sourceSupport,
    expectedRecords,
    trailingSupport: deriveAnalyzerTrailingSupport(sourceSupport),
    status: failure && expectedRecords > 0 ? "failed" : "complete",
    gaps: failure
      ? supports.map((frame) => ({
          firstIndex: frame.index,
          count: 1,
          support: frame.support,
          reason: failure,
        }))
      : [],
  };
  observation.metrics.pitch = pitchTimelineSchema.parse({
    ...common,
    schema: "pitch-timeline/v1",
    profile: PITCH_PROFILE,
    frames: failure
      ? []
      : supports.map((frame) => ({
          ...frame,
          channels: [
            classifyPitchEstimate(440, 0.95),
            classifyPitchEstimate(0, 0),
          ],
        })),
  });
  observation.metrics["spectral-shape"] = spectralShapeTimelineSchema.parse({
    ...common,
    status: "complete",
    gaps: [],
    schema: "spectral-shape-timeline/v1",
    profile: SPECTRAL_SHAPE_PROFILE,
    frames: supports.map((frame) => ({
      ...frame,
      channels: [
        { state: "valid", flatnessDb: -20, spreadHz: 500, rolloffHz: 1000 },
        { state: "silence", flatnessDb: null, spreadHz: null, rolloffHz: null },
      ],
    })),
  });
  observation.requestedMetrics = [
    ...new Set([
      ...observation.requestedMetrics,
      "pitch",
      "spectral-shape",
    ] as const),
  ];
  observation.outcome = observation.requestedMetrics.every(
    (metric) => observation.metrics[metric]?.status === "complete",
  )
    ? "complete"
    : "partial";
  observation.rows = createMetricObservationReportRows(observation);
  return metricAudioObservationSchema.parse(observation);
}
