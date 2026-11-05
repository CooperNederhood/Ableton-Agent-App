import { z } from "zod";
import {
  aggregateMelBandFrames,
  deriveMelBandFrame,
  MAX_MEL_BAND_FRAMES,
  MEL_BAND_PROFILE,
  melBandProfileSchema,
  melBandSampleRateSchema,
  melBandStereoFrameSchema,
  melBandFrameAnalysisSchema,
  melBandAggregationSchema,
  type MelBandAggregation,
  type MelBandFrameAnalysis,
} from "./mel-band-profile.js";
import {
  MAX_METRIC_LISTENING_SECONDS,
  MAX_METRIC_REPORT_ROWS,
  metricReportingRowSchema,
} from "./metric-listening-geometry.js";

const sample = z
  .number()
  .int()
  .min(0)
  .max(2 ** 44 - 1);
const windowSamples = MEL_BAND_PROFILE.windowSamples;
export const melBandSupportSchema = z
  .strictObject({
    startSample: sample,
    endSample: sample,
  })
  .refine(
    (value) => value.endSample > value.startSample,
    "Support must have positive duration",
  )
  .readonly();
export type MelBandSupport = z.infer<typeof melBandSupportSchema>;
export const melBandTimelineFrameSchema = z
  .strictObject({
    index: z
      .number()
      .int()
      .min(0)
      .max(MAX_MEL_BAND_FRAMES - 1),
    support: melBandSupportSchema,
    magnitudes: melBandStereoFrameSchema,
  })
  .readonly();
export type MelBandTimelineFrame = z.infer<typeof melBandTimelineFrameSchema>;
export const melBandGapReasonSchema = z.enum([
  "unavailable",
  "malformed-record",
  "sequence-gap",
  "overflow",
  "drain-timeout",
  "dependency-unavailable",
]);
export const melBandTimelineGapSchema = z
  .strictObject({
    firstIndex: z
      .number()
      .int()
      .min(0)
      .max(MAX_MEL_BAND_FRAMES - 1),
    count: z.number().int().min(1).max(MAX_MEL_BAND_FRAMES),
    support: melBandSupportSchema,
    reason: melBandGapReasonSchema,
  })
  .readonly();
export type MelBandTimelineGap = z.infer<typeof melBandTimelineGapSchema>;

/**
 * Structural coverage only. A producer must independently establish physical
 * source identity, origin, phase, and acquisition support before using this
 * contract. Unknown-origin/phase acquisition cannot be expressed as a timeline.
 */
export const melBandTimelineSchema = z
  .strictObject({
    schema: z.literal("mel-band-timeline/v1"),
    status: z.enum(["complete", "partial", "failed"]),
    sampleRate: melBandSampleRateSchema,
    profile: melBandProfileSchema,
    sourceSupport: melBandSupportSchema,
    expectedRecords: z.number().int().min(0).max(MAX_MEL_BAND_FRAMES),
    frames: z
      .array(melBandTimelineFrameSchema)
      .max(MAX_MEL_BAND_FRAMES)
      .readonly(),
    gaps: z.array(melBandTimelineGapSchema).max(MAX_MEL_BAND_FRAMES).readonly(),
  })
  .superRefine((value, ctx) => {
    const reject = (message: string) =>
      ctx.addIssue({ code: "custom", message });
    const duration =
      value.sourceSupport.endSample - value.sourceSupport.startSample;
    const expectedRecords = Math.floor(duration / windowSamples);
    if (
      duration > MAX_METRIC_LISTENING_SECONDS * value.sampleRate ||
      value.expectedRecords !== expectedRecords
    ) {
      reject(
        "Expected records must match full windows in a capture of at most thirty seconds",
      );
      return;
    }
    const coverage = Array.from({ length: expectedRecords }, () => 0);
    const admit = (index: number, count: number, support: MelBandSupport) => {
      if (
        index + count > expectedRecords ||
        support.startSample !==
          value.sourceSupport.startSample + index * windowSamples ||
        support.endSample !==
          value.sourceSupport.startSample + (index + count) * windowSamples
      ) {
        reject("Indexed support must match full, unpadded source windows");
        return;
      }
      for (let slot = index; slot < index + count; slot++) coverage[slot]!++;
    };
    let previousFrame = -1;
    for (const frame of value.frames) {
      if (frame.index <= previousFrame)
        reject("Frames must be strictly index ordered");
      previousFrame = frame.index;
      admit(frame.index, 1, frame.support);
    }
    let previousGapEnd = 0;
    for (const gap of value.gaps) {
      if (gap.firstIndex < previousGapEnd)
        reject("Gaps must be ordered and non-overlapping");
      previousGapEnd = gap.firstIndex + gap.count;
      admit(gap.firstIndex, gap.count, gap.support);
    }
    if (coverage.some((count) => count !== 1))
      reject("Every expected slot must have exactly one frame or gap");
    // A short, fully accounted capture is complete but contains no measurements.
    const expectedStatus =
      value.gaps.length === 0
        ? "complete"
        : value.frames.length === 0
          ? "failed"
          : "partial";
    if (value.status !== expectedStatus)
      reject("Timeline status must match retained frames and gaps");
  })
  .readonly();
export type MelBandTimeline = z.infer<typeof melBandTimelineSchema>;

function metadata(timeline: MelBandTimeline) {
  const trailingStart =
    timeline.sourceSupport.startSample +
    timeline.expectedRecords * windowSamples;
  return Object.freeze({
    expectedRecords: timeline.expectedRecords,
    trailingSupport:
      trailingStart < timeline.sourceSupport.endSample
        ? Object.freeze({
            startSample: trailingStart,
            endSample: timeline.sourceSupport.endSample,
          })
        : null,
  });
}

/** Unmeasured tail metadata, not a padded frame or an inferred silent region. */
export function deriveMelBandTimelineMetadata(input: MelBandTimeline) {
  return metadata(melBandTimelineSchema.parse(input));
}

export const melBandReportRowsSchema = z
  .array(metricReportingRowSchema.readonly())
  .min(1)
  .max(MAX_METRIC_REPORT_ROWS)
  .superRefine((rows, ctx) => {
    for (let index = 1; index < rows.length; index++) {
      const previous = rows[index - 1]!;
      const current = rows[index]!;
      if (
        current.startSample !== previous.endSample ||
        current.startBeat !== previous.endBeat
      ) {
        ctx.addIssue({
          code: "custom",
          message:
            "Reporting rows must be a contiguous musical and sample partition",
        });
      }
    }
  })
  .readonly();

export type MelBandReportedFrame = Readonly<{
  index: number;
  support: MelBandSupport;
  analysis: MelBandFrameAnalysis;
}>;
export type MelBandReportRow = Readonly<
  z.infer<typeof metricReportingRowSchema> & {
    index: number;
    expectedRecords: number;
    recordCount: number;
    gapCount: number;
    frames: readonly MelBandReportedFrame[];
    gaps: readonly MelBandTimelineGap[];
    aggregation: MelBandAggregation;
  }
>;
export type MelBandTimelineReport = Readonly<{
  schema: "mel-band-timeline-report/v1";
  status: MelBandTimeline["status"];
  sampleRate: MelBandTimeline["sampleRate"];
  profile: MelBandTimeline["profile"];
  sourceSupport: MelBandSupport;
  expectedRecords: number;
  trailingSupport: MelBandSupport | null;
  rows: readonly MelBandReportRow[];
}>;

/** Revalidated wire payload for an endpoint-assigned musical reporting row. */
export const melBandReportPayloadSchema = z
  .strictObject({
    availability: z.enum(["available", "partial", "missing", "no-frame"]),
    expectedRecords: z.number().int().min(0).max(MAX_MEL_BAND_FRAMES),
    recordCount: z.number().int().min(0).max(MAX_MEL_BAND_FRAMES),
    gapCount: z.number().int().min(0).max(MAX_MEL_BAND_FRAMES),
    frames: z
      .array(
        z.strictObject({
          index: z
            .number()
            .int()
            .min(0)
            .max(MAX_MEL_BAND_FRAMES - 1),
          support: melBandSupportSchema,
          analysis: melBandFrameAnalysisSchema,
        }),
      )
      .max(MAX_MEL_BAND_FRAMES),
    gaps: z.array(melBandTimelineGapSchema).max(MAX_MEL_BAND_FRAMES),
    aggregation: melBandAggregationSchema,
  })
  .superRefine((value, ctx) => {
    const reject = () =>
      ctx.addIssue({
        code: "custom",
        message:
          "Mel-band report coverage and arithmetic must match retained frames and gaps",
      });
    const occupied = new Set<number>();
    let previous = -1;
    for (const frame of value.frames) {
      if (frame.index <= previous) reject();
      previous = frame.index;
      occupied.add(frame.index);
    }
    previous = -1;
    for (const gap of value.gaps) {
      if (gap.firstIndex <= previous) reject();
      previous = gap.firstIndex + gap.count - 1;
      for (
        let index = gap.firstIndex;
        index < gap.firstIndex + gap.count;
        index++
      ) {
        if (occupied.has(index)) reject();
        occupied.add(index);
      }
    }
    const expectedAvailability =
      value.expectedRecords === 0
        ? "no-frame"
        : value.recordCount === value.expectedRecords
          ? "available"
          : value.recordCount === 0
            ? "missing"
            : "partial";
    if (
      value.recordCount !== value.frames.length ||
      value.gapCount !== value.gaps.reduce((sum, gap) => sum + gap.count, 0) ||
      value.expectedRecords !== value.recordCount + value.gapCount ||
      occupied.size !== value.expectedRecords ||
      value.availability !== expectedAvailability
    )
      reject();
    try {
      if (
        JSON.stringify(value.aggregation) !==
        JSON.stringify(
          aggregateMelBandFrames(
            value.frames.map((frame) => frame.analysis.magnitudes),
          ),
        )
      )
        reject();
    } catch (error) {
      if (!(error instanceof z.ZodError)) throw error;
      reject();
    }
  });

/**
 * Assign whole frame/gap slots by their support endpoint into half-open musical
 * rows. Only the final capture endpoint belongs to the final row. Support may
 * therefore start in an earlier row; it is never clipped or interpolated.
 */
export function projectMelBandTimeline(
  input: MelBandTimeline,
  rowBoundaries: unknown,
): MelBandTimelineReport {
  const timeline = melBandTimelineSchema.parse(input);
  const boundaries = melBandReportRowsSchema.parse(rowBoundaries);
  if (
    boundaries[0]!.startSample !== timeline.sourceSupport.startSample ||
    boundaries.at(-1)!.endSample !== timeline.sourceSupport.endSample
  ) {
    throw new RangeError("mel_band_report_partition_must_match_source_support");
  }
  const rows = boundaries.map((boundary, index) => ({
    ...boundary,
    index,
    frames: [] as MelBandReportedFrame[],
    gaps: [] as MelBandTimelineGap[],
  }));
  const frames = new Map(timeline.frames.map((frame) => [frame.index, frame]));
  const gaps = new Map<number, MelBandTimelineGap>();
  for (const gap of timeline.gaps) {
    for (
      let index = gap.firstIndex;
      index < gap.firstIndex + gap.count;
      index++
    ) {
      gaps.set(index, gap);
    }
  }
  let rowIndex = 0;
  for (let index = 0; index < timeline.expectedRecords; index++) {
    const support = Object.freeze({
      startSample: timeline.sourceSupport.startSample + index * windowSamples,
      endSample:
        timeline.sourceSupport.startSample + (index + 1) * windowSamples,
    });
    while (
      rowIndex < rows.length - 1 &&
      support.endSample >= rows[rowIndex]!.endSample
    )
      rowIndex++;
    const row = rows[rowIndex]!;
    const frame = frames.get(index);
    if (frame !== undefined) {
      row.frames.push(
        Object.freeze({
          index,
          support: frame.support,
          analysis: deriveMelBandFrame(frame.magnitudes),
        }),
      );
    } else {
      const reason = gaps.get(index)!.reason;
      const previous = row.gaps.at(-1);
      if (
        previous !== undefined &&
        previous.reason === reason &&
        previous.firstIndex + previous.count === index
      ) {
        row.gaps[row.gaps.length - 1] = Object.freeze({
          ...previous,
          count: previous.count + 1,
          support: Object.freeze({
            startSample: previous.support.startSample,
            endSample: support.endSample,
          }),
        });
      } else {
        row.gaps.push(
          Object.freeze({ firstIndex: index, count: 1, support, reason }),
        );
      }
    }
  }
  return Object.freeze({
    schema: "mel-band-timeline-report/v1",
    status: timeline.status,
    sampleRate: timeline.sampleRate,
    profile: timeline.profile,
    sourceSupport: timeline.sourceSupport,
    ...metadata(timeline),
    rows: Object.freeze(
      rows.map((row) => {
        const gapCount = row.gaps.reduce((sum, gap) => sum + gap.count, 0);
        return Object.freeze({
          ...row,
          expectedRecords: row.frames.length + gapCount,
          recordCount: row.frames.length,
          gapCount,
          frames: Object.freeze(row.frames),
          gaps: Object.freeze(row.gaps),
          aggregation: aggregateMelBandFrames(
            row.frames.map((frame) => frame.analysis.magnitudes),
          ),
        });
      }),
    ),
  });
}
