import { z } from "zod";
import {
  pitchProfileSchema,
  spectralShapeProfileSchema,
} from "./analyzer-profile.js";
import {
  analyzerSupportSchema,
  analyzerTimelineGapSchema,
  pitchTimelineFrameSchema,
  spectralShapeTimelineFrameSchema,
  type AnalyzerSupport,
  type PitchTimeline,
  type SpectralShapeTimeline,
} from "./analyzer-timeline.js";

const counts = {
  expectedRecords: z.number().int().min(0).max(703),
  retainedRecords: z.number().int().min(0).max(703),
  missingRecords: z.number().int().min(0).max(703),
  trailingSupport: analyzerSupportSchema.nullable(),
};
export const pitchReportMetadataSchema = z.strictObject({
  ...counts,
  profile: pitchProfileSchema,
});
export const spectralShapeReportMetadataSchema = z.strictObject({
  ...counts,
  profile: spectralShapeProfileSchema,
});
const row = {
  availability: z.enum(["available", "partial", "missing", "no-frame"]),
  aggregation: z.literal("native-support-overlap-no-aggregation"),
  expectedRecords: z.number().int().min(0).max(703),
  gaps: z.array(analyzerTimelineGapSchema).max(703),
};
export const pitchReportRowSchema = z.strictObject({
  ...row,
  frames: z.array(pitchTimelineFrameSchema).max(703),
});
export const spectralShapeReportRowSchema = z.strictObject({
  ...row,
  frames: z.array(spectralShapeTimelineFrameSchema).max(703),
});
export function analyzerSupportsOverlap(
  a: AnalyzerSupport,
  b: AnalyzerSupport,
): boolean {
  return a.startSample < b.endSample && a.endSample > b.startSample;
}
export function analyzerReportMetadata<
  T extends PitchTimeline | SpectralShapeTimeline,
>(timeline: T) {
  return {
    profile: timeline.profile,
    expectedRecords: timeline.expectedRecords,
    retainedRecords: timeline.frames.length,
    missingRecords: timeline.gaps.reduce((sum, gap) => sum + gap.count, 0),
    trailingSupport: timeline.trailingSupport,
  };
}
export function projectAnalyzerRow<
  T extends PitchTimeline | SpectralShapeTimeline,
>(timeline: T, support: AnalyzerSupport) {
  const frames = timeline.frames.filter((frame) =>
    analyzerSupportsOverlap(frame.support, support),
  );
  const gaps = timeline.gaps.filter((gap) =>
    analyzerSupportsOverlap(gap.support, support),
  );
  const expectedRecords = Array.from(
    { length: timeline.expectedRecords },
    (_, index) => ({
      startSample: timeline.sourceSupport.startSample + index * 2048,
      endSample: timeline.sourceSupport.startSample + (index + 1) * 2048,
    }),
  ).filter((slot) => analyzerSupportsOverlap(slot, support)).length;
  return {
    availability:
      expectedRecords === 0
        ? ("no-frame" as const)
        : frames.length === expectedRecords
          ? ("available" as const)
          : frames.length === 0
            ? ("missing" as const)
            : ("partial" as const),
    aggregation: "native-support-overlap-no-aggregation" as const,
    expectedRecords,
    frames,
    gaps,
  };
}
