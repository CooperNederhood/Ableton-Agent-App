import {
  MEL_BAND_PROFILE,
  melBandTimelineSchema,
  pitchTimelineSchema,
  spectralShapeTimelineSchema,
  createMetricObservationReportRows,
  metricAudioObservationSchema,
} from "@ableton-agent/protocol";
import {
  createSyntheticMetricListeningObservation,
  withSyntheticAnalyzerTimelines,
} from "@ableton-agent/protocol/testing";

/** Dense JSON consumer fixture, not native measurement/qualification evidence. */
export function denseSyntheticMetricObservation() {
  const observation = withSyntheticAnalyzerTimelines(
    createSyntheticMetricListeningObservation({ tempoBpm: 120, endBeat: 3.75 }),
  );
  const pitch = observation.metrics.pitch!;
  observation.metrics.pitch = pitchTimelineSchema.parse({
    ...pitch,
    frames: pitch.frames.map((frame) => ({
      ...frame,
      channels: Array.from({ length: 2 }, () => ({
        state: "accepted-estimate",
        hz: 440.1234567890123,
        confidence: 0.9567890123456789,
      })),
    })),
  });
  const shape = observation.metrics["spectral-shape"]!;
  observation.metrics["spectral-shape"] = spectralShapeTimelineSchema.parse({
    ...shape,
    frames: shape.frames.map((frame) => ({
      ...frame,
      channels: Array.from({ length: 2 }, () => ({
        state: "valid",
        flatnessDb: -20.123456789012344,
        spreadHz: 512.3456789012345,
        rolloffHz: 1234.5678901234567,
      })),
    })),
  });
  observation.metrics["mel-bands"] = melBandTimelineSchema.parse({
    schema: "mel-band-timeline/v1",
    status: "complete",
    profile: MEL_BAND_PROFILE,
    sampleRate: observation.geometry.sampleRate,
    sourceSupport: observation.sourceCoverage,
    expectedRecords: pitch.expectedRecords,
    frames: pitch.frames.map((frame) => ({
      index: frame.index,
      support: frame.support,
      magnitudes: Array.from({ length: 2 }, () =>
        Array<number>(24).fill(0.12345678901234568),
      ),
    })),
    gaps: [],
  });
  observation.requestedMetrics = [
    "level",
    "spectral-centroid",
    "attacks",
    "mel-bands",
    "pitch",
    "spectral-shape",
  ];
  observation.rows = createMetricObservationReportRows(observation);
  return metricAudioObservationSchema.parse(observation);
}
