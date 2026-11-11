import { z } from "zod";
import {
  analyzerSampleRateSchema,
  ANALYZER_WINDOW_SAMPLES,
  MAX_ANALYZER_FRAMES,
  MAX_ANALYZER_SECONDS,
  MAX_ANALYZER_SOURCE_SAMPLE,
  MIN_SPECTRAL_FLATNESS_DB,
  MAX_SPECTRAL_FLATNESS_DB,
  PITCH_CONFIDENCE_THRESHOLD,
  PITCH_OUTPUT_MINIMUM_HZ,
  PITCH_OUTPUT_MAXIMUM_HZ,
  pitchProfileSchema,
  spectralShapeProfileSchema,
} from "./analyzer-profile.js";

const sample = z.number().int().min(0).max(MAX_ANALYZER_SOURCE_SAMPLE);
const index = z
  .number()
  .int()
  .min(0)
  .max(MAX_ANALYZER_FRAMES - 1);
// Invalid algorithm outputs retain finite raw values, including out-of-range
// scores. Nonfinite raw values are null, never JSON NaN/Infinity or fake zero.
const finiteRaw = z
  .number()
  .finite()
  .min(-Number.MAX_VALUE)
  .max(Number.MAX_VALUE)
  .nullable();
export const analyzerSupportSchema = z
  .strictObject({
    startSample: sample,
    endSample: sample,
  })
  .refine(
    (value) => value.endSample > value.startSample,
    "Positive half-open source support required",
  )
  .readonly();
export type AnalyzerSupport = z.infer<typeof analyzerSupportSchema>;
export const pitchEstimateStateSchema = z.enum([
  "accepted-estimate",
  "silence",
  "undefined",
  "low-confidence",
  "outside-qualified-range",
  "invalid",
]);
export type PitchEstimateState = z.infer<typeof pitchEstimateStateSchema>;

function estimateState(
  hz: number | null,
  confidence: number | null,
): PitchEstimateState {
  if (
    hz === null ||
    confidence === null ||
    hz < 0 ||
    hz > 24000 ||
    confidence < 0 ||
    confidence > 1
  )
    return "invalid";
  if (hz === 0) return "undefined";
  if (confidence < PITCH_CONFIDENCE_THRESHOLD) return "low-confidence";
  if (hz < PITCH_OUTPUT_MINIMUM_HZ || hz > PITCH_OUTPUT_MAXIMUM_HZ)
    return "outside-qualified-range";
  return "accepted-estimate";
}
export const pitchChannelSchema = z
  .strictObject({
    state: pitchEstimateStateSchema,
    hz: finiteRaw,
    confidence: finiteRaw,
  })
  .superRefine((value, ctx) => {
    const valid =
      value.state === "silence"
        ? value.hz === null && value.confidence === null
        : value.state === estimateState(value.hz, value.confidence);
    if (!valid)
      ctx.addIssue({
        code: "custom",
        message:
          "Pitch state must agree with raw values and the frozen estimate gate",
      });
  })
  .readonly();
export type PitchChannel = z.infer<typeof pitchChannelSchema>;

/** A numeric gate only. It cannot recognize polyphony or the high-confidence
 * 2000Hz→1000Hz counterexample. Does not fabricate source support or silence. */
export function classifyPitchEstimate(
  hz: number,
  confidence: number,
): PitchChannel {
  const rawHz = Number.isFinite(hz) ? hz : null;
  const rawConfidence = Number.isFinite(confidence) ? confidence : null;
  return pitchChannelSchema.parse({
    state: estimateState(rawHz, rawConfidence),
    hz: rawHz,
    confidence: rawConfidence,
  });
}
export const spectralShapeChannelSchema = z
  .union([
    z.strictObject({
      state: z.literal("valid"),
      flatnessDb: z
        .number()
        .finite()
        .min(MIN_SPECTRAL_FLATNESS_DB)
        .max(MAX_SPECTRAL_FLATNESS_DB),
      spreadHz: z.number().finite().min(0).max(24000),
      rolloffHz: z.number().finite().min(0).max(24000),
    }),
    z.strictObject({
      state: z.enum(["silence", "undefined", "invalid"]),
      flatnessDb: z.null(),
      spreadHz: z.null(),
      rolloffHz: z.null(),
    }),
  ])
  .readonly();
export type SpectralShapeChannel = z.infer<typeof spectralShapeChannelSchema>;
export const pitchTimelineFrameSchema = z
  .strictObject({
    index,
    support: analyzerSupportSchema,
    channels: z.tuple([pitchChannelSchema, pitchChannelSchema]).readonly(),
  })
  .readonly();
export type PitchTimelineFrame = z.infer<typeof pitchTimelineFrameSchema>;
export const spectralShapeTimelineFrameSchema = z
  .strictObject({
    index,
    support: analyzerSupportSchema,
    channels: z
      .tuple([spectralShapeChannelSchema, spectralShapeChannelSchema])
      .readonly(),
  })
  .readonly();
export type SpectralShapeTimelineFrame = z.infer<
  typeof spectralShapeTimelineFrameSchema
>;
export const analyzerGapReasonSchema = z.enum([
  "unavailable",
  "malformed-record",
  "sequence-gap",
  "overflow",
  "drain-timeout",
  "dependency-unavailable",
]);
export const analyzerTimelineGapSchema = z
  .strictObject({
    firstIndex: index,
    count: z.number().int().min(1).max(MAX_ANALYZER_FRAMES),
    support: analyzerSupportSchema,
    reason: analyzerGapReasonSchema,
  })
  .readonly();
export type AnalyzerTimelineGap = z.infer<typeof analyzerTimelineGapSchema>;
const timelineShape = {
  status: z.enum(["complete", "partial", "failed"]),
  sampleRate: analyzerSampleRateSchema,
  sourceSupport: analyzerSupportSchema,
  expectedRecords: z.number().int().min(0).max(MAX_ANALYZER_FRAMES),
  // Required explicit tail: it is not a gap/full frame and is never padded.
  trailingSupport: analyzerSupportSchema.nullable(),
  gaps: z.array(analyzerTimelineGapSchema).max(MAX_ANALYZER_FRAMES).readonly(),
};
type StructuralTimeline = {
  status: string;
  sampleRate: number;
  sourceSupport: AnalyzerSupport;
  expectedRecords: number;
  trailingSupport: AnalyzerSupport | null;
  frames: readonly { index: number; support: AnalyzerSupport }[];
  gaps: readonly AnalyzerTimelineGap[];
};
export function deriveAnalyzerTrailingSupport(
  sourceSupport: AnalyzerSupport,
): AnalyzerSupport | null {
  const source = analyzerSupportSchema.parse(sourceSupport);
  const count = Math.floor(
    (source.endSample - source.startSample) / ANALYZER_WINDOW_SAMPLES,
  );
  const startSample = source.startSample + count * ANALYZER_WINDOW_SAMPLES;
  return startSample === source.endSample
    ? null
    : Object.freeze({ startSample, endSample: source.endSample });
}
function validateTimeline(value: StructuralTimeline, ctx: z.RefinementCtx) {
  const reject = (message: string) => ctx.addIssue({ code: "custom", message });
  const duration =
    value.sourceSupport.endSample - value.sourceSupport.startSample;
  const expected = Math.floor(duration / ANALYZER_WINDOW_SAMPLES);
  if (
    duration <= 0 ||
    duration > MAX_ANALYZER_SECONDS * value.sampleRate ||
    value.expectedRecords !== expected
  ) {
    reject(
      "Expected records must match full windows in at most thirty seconds",
    );
    return;
  }
  const tail = deriveAnalyzerTrailingSupport(value.sourceSupport);
  if (
    tail === null
      ? value.trailingSupport !== null
      : value.trailingSupport?.startSample !== tail.startSample ||
        value.trailingSupport?.endSample !== tail.endSample
  )
    reject(
      "Trailing support must exactly describe unmeasured unpadded samples",
    );
  const slots = new Uint8Array(expected);
  function admit(first: number, count: number, support: AnalyzerSupport) {
    if (
      first + count > expected ||
      support.startSample !== value.sourceSupport.startSample + first * 2048 ||
      support.endSample !==
        value.sourceSupport.startSample + (first + count) * 2048
    ) {
      reject(
        "Frame/gap support must be exact source-origin-aligned full windows",
      );
      return;
    }
    for (let i = first; i < first + count; ++i) {
      if (slots[i] !== 0) reject("Overlapping frame/gap support");
      slots[i] = 1;
    }
  }
  let previousFrame = -1;
  for (const frame of value.frames) {
    if (frame.index <= previousFrame) reject("Frames must be strictly ordered");
    previousFrame = frame.index;
    admit(frame.index, 1, frame.support);
  }
  let previousGapEnd = 0;
  for (const gap of value.gaps) {
    if (gap.firstIndex < previousGapEnd)
      reject("Gaps must be ordered and disjoint");
    previousGapEnd = gap.firstIndex + gap.count;
    admit(gap.firstIndex, gap.count, gap.support);
  }
  if (slots.some((slot) => slot !== 1))
    reject("Every full slot needs a frame or gap");
  const status =
    value.gaps.length === 0
      ? "complete"
      : value.frames.length === 0
        ? "failed"
        : "partial";
  if (value.status !== status)
    reject("Status describes acquisition coverage, not channel validity");
}
/** Structure only. Physical origin, epoch, FIFO/drain and ownership checks are
 * producer obligations; parsing never upgrades polled diagnostics. */
export const pitchTimelineSchema = z
  .strictObject({
    ...timelineShape,
    schema: z.literal("pitch-timeline/v1"),
    profile: pitchProfileSchema,
    frames: z
      .array(pitchTimelineFrameSchema)
      .max(MAX_ANALYZER_FRAMES)
      .readonly(),
  })
  .superRefine(validateTimeline)
  .readonly();
export type PitchTimeline = z.infer<typeof pitchTimelineSchema>;
export const spectralShapeTimelineSchema = z
  .strictObject({
    ...timelineShape,
    schema: z.literal("spectral-shape-timeline/v1"),
    profile: spectralShapeProfileSchema,
    frames: z
      .array(spectralShapeTimelineFrameSchema)
      .max(MAX_ANALYZER_FRAMES)
      .readonly(),
  })
  .superRefine((value, ctx) => {
    validateTimeline(value, ctx);
    for (const frame of value.frames)
      for (const channel of frame.channels)
        if (
          channel.state === "valid" &&
          (channel.spreadHz > value.sampleRate / 2 ||
            channel.rolloffHz > value.sampleRate / 2)
        )
          ctx.addIssue({
            code: "custom",
            message: "Descriptors cannot exceed actual Nyquist",
          });
  })
  .readonly();
export type SpectralShapeTimeline = z.infer<typeof spectralShapeTimelineSchema>;
