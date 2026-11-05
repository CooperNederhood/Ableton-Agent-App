import { z } from "zod";

export const MAX_MEL_BAND_FRAMES = 706;
export const MEL_BAND_DENOMINATOR_FLOOR = 1e-12;

/**
 * Conservative admission bound: |input| <= 64, 2048-point unnormalized FFT,
 * at most 1025 real-spectrum bins per triangle, each coefficient <= 1.
 * The periodic Hann window is non-amplifying; actual FFT output scaling still
 * requires independent acquisition qualification.
 * This is a linear-magnitude bound, not a power or calibrated-energy bound.
 */
export const MAX_MEL_BAND_MAGNITUDE = 64 * 2_048 * 1_025;
const maximumRegionalSum = 24 * MAX_MEL_BAND_MAGNITUDE;
const maximumRatio = maximumRegionalSum / MEL_BAND_DENOMINATOR_FLOOR;
const melConstant = 1127.01048;
const toMel = (hz: number) => melConstant * Math.log(1 + hz / 700);
const lowerMel = toMel(20);
const upperMel = toMel(20_000);
const points = Array.from({ length: 26 }, (_, index) => {
  // Keep the specified endpoints exact despite inverse-transform roundoff.
  if (index === 0) return 20;
  if (index === 25) return 20_000;
  return (
    700 *
    (Math.exp((lowerMel + ((upperMel - lowerMel) * index) / 25) / melConstant) -
      1)
  );
});
const regionForCenter = (hz: number): "low" | "mid" | "high" =>
  hz < 250 ? "low" : hz < 2_000 ? "mid" : "high";
const bands = Object.freeze(
  Array.from({ length: 24 }, (_, index) =>
    Object.freeze({
      index,
      lowerHz: points[index]!,
      centerHz: points[index + 1]!,
      upperHz: points[index + 2]!,
      region: regionForCenter(points[index + 1]!),
    }),
  ),
);

/**
 * Descriptive arithmetic profile only; not evidence of acquisition support.
 * The window type names the pinned core's STFT default (WindowType 0).
 * Magnitudes are unnormalized linear units; regions use band centers.
 */
export const MEL_BAND_PROFILE = Object.freeze({
  schema: "mel-band-profile/v1",
  bandCount: 24,
  minimumHz: 20,
  maximumHz: 20_000,
  channelMode: "independent-stereo",
  quantity: "linear-fft-magnitude",
  normalize: 0,
  scale: 0,
  windowType: "hann-periodic",
  windowSamples: 2_048,
  hopSamples: 2_048,
  fftSamples: 2_048,
  denominatorFloor: MEL_BAND_DENOMINATOR_FLOOR,
  bands,
} as const);

const bandMetadataSchema = z
  .strictObject({
    index: z.number().int().min(0).max(23),
    lowerHz: z.number().finite().min(20).max(20_000),
    centerHz: z.number().finite().min(20).max(20_000),
    upperHz: z.number().finite().min(20).max(20_000),
    region: z.enum(["low", "mid", "high"]),
  })
  .readonly();

export const melBandProfileSchema = z
  .strictObject({
    schema: z.literal(MEL_BAND_PROFILE.schema),
    bandCount: z.literal(24),
    minimumHz: z.literal(20),
    maximumHz: z.literal(20_000),
    channelMode: z.literal("independent-stereo"),
    quantity: z.literal("linear-fft-magnitude"),
    normalize: z.literal(0),
    scale: z.literal(0),
    windowType: z.literal("hann-periodic"),
    windowSamples: z.literal(2_048),
    hopSamples: z.literal(2_048),
    fftSamples: z.literal(2_048),
    denominatorFloor: z.literal(MEL_BAND_DENOMINATOR_FLOOR),
    bands: z
      .array(bandMetadataSchema)
      .length(24)
      .refine(
        (value) =>
          value.every((band, index) => {
            const expected = bands[index]!;
            return (
              band.index === expected.index &&
              band.lowerHz === expected.lowerHz &&
              band.centerHz === expected.centerHz &&
              band.upperHz === expected.upperHz &&
              band.region === expected.region
            );
          }),
        "Band metadata must match the canonical mel-spaced profile",
      )
      .readonly(),
  })
  .readonly();
export type MelBandProfile = z.infer<typeof melBandProfileSchema>;

/** External context only: this does not authorize either host sample rate. */
export const melBandSampleRateSchema = z.union([
  z.literal(44_100),
  z.literal(48_000),
]);
const magnitude = z.number().finite().min(0).max(MAX_MEL_BAND_MAGNITUDE);
export const melBandMagnitudeVectorSchema = z
  .tuple([
    magnitude,
    magnitude,
    magnitude,
    magnitude,
    magnitude,
    magnitude,
    magnitude,
    magnitude,
    magnitude,
    magnitude,
    magnitude,
    magnitude,
    magnitude,
    magnitude,
    magnitude,
    magnitude,
    magnitude,
    magnitude,
    magnitude,
    magnitude,
    magnitude,
    magnitude,
    magnitude,
    magnitude,
  ])
  .readonly();
export type MelBandMagnitudeVector = z.infer<
  typeof melBandMagnitudeVectorSchema
>;
export const melBandStereoFrameSchema = z
  .tuple([melBandMagnitudeVectorSchema, melBandMagnitudeVectorSchema])
  .readonly();
export type MelBandStereoFrame = z.infer<typeof melBandStereoFrameSchema>;
export const melBandFramesSchema = z
  .array(melBandStereoFrameSchema)
  .max(MAX_MEL_BAND_FRAMES)
  .readonly();

export const melBandRatioSchema = z.union([
  z
    .strictObject({
      value: z.number().finite().min(0).max(maximumRatio),
      reason: z.null(),
    })
    .readonly(),
  z
    .strictObject({
      value: z.null(),
      reason: z.enum(["zero-denominator", "below-floor"]),
    })
    .readonly(),
]);
export type MelBandRatio = z.infer<typeof melBandRatioSchema>;
export type MelBandRegionalSums = Readonly<{
  low: number;
  mid: number;
  high: number;
}>;
export type MelBandChannelRatios = Readonly<{
  lowMid: MelBandRatio;
  highMid: MelBandRatio;
}>;
export type MelBandFrameAnalysis = Readonly<{
  magnitudes: MelBandStereoFrame;
  regions: readonly [MelBandRegionalSums, MelBandRegionalSums];
  ratios: readonly [MelBandChannelRatios, MelBandChannelRatios];
}>;
export type MelBandAggregation =
  | Readonly<{ status: "no-frames"; frameCount: 0 }>
  | Readonly<{
      status: "completed";
      frameCount: number;
      analysis: MelBandFrameAnalysis;
    }>;

function regionalSums(values: MelBandMagnitudeVector): MelBandRegionalSums {
  const sums = { low: 0, mid: 0, high: 0 };
  values.forEach((value, index) => {
    sums[bands[index]!.region] += value;
  });
  return Object.freeze(sums);
}

function ratio(numerator: number, denominator: number): MelBandRatio {
  if (denominator === 0) {
    return Object.freeze({ value: null, reason: "zero-denominator" });
  }
  if (denominator <= MEL_BAND_DENOMINATOR_FLOOR) {
    return Object.freeze({ value: null, reason: "below-floor" });
  }
  return Object.freeze({ value: numerator / denominator, reason: null });
}

function channelRatios(sums: MelBandRegionalSums): MelBandChannelRatios {
  return Object.freeze({
    lowMid: ratio(sums.low, sums.mid),
    highMid: ratio(sums.high, sums.mid),
  });
}

function analyze(magnitudes: MelBandStereoFrame): MelBandFrameAnalysis {
  const regions = Object.freeze([
    regionalSums(magnitudes[0]),
    regionalSums(magnitudes[1]),
  ] as const);
  return Object.freeze({
    magnitudes,
    regions,
    ratios: Object.freeze([
      channelRatios(regions[0]),
      channelRatios(regions[1]),
    ] as const),
  });
}

/** Reject incomplete/invalid input; never synthesize missing observations. */
export function deriveMelBandFrame(input: unknown): MelBandFrameAnalysis {
  return analyze(melBandStereoFrameSchema.parse(input));
}

/** Equal-weight linear means, then regional sums and ratios of those means. */
export function aggregateMelBandFrames(input: unknown): MelBandAggregation {
  const frames = melBandFramesSchema.parse(input);
  if (frames.length === 0)
    return Object.freeze({ status: "no-frames", frameCount: 0 });
  const means = [0, 1].map((channel) =>
    Array.from({ length: 24 }, (_, band) => {
      // Compensated summation avoids frame-count-dependent drift near the floor.
      let sum = 0;
      let correction = 0;
      for (const frame of frames) {
        const adjusted = frame[channel]![band]! - correction;
        const next = sum + adjusted;
        correction = next - sum - adjusted;
        sum = next;
      }
      return sum / frames.length;
    }),
  );
  return Object.freeze({
    status: "completed",
    frameCount: frames.length,
    analysis: deriveMelBandFrame(means),
  });
}

const regionalSumsSchema = z
  .strictObject({
    low: z.number().finite().min(0).max(maximumRegionalSum),
    mid: z.number().finite().min(0).max(maximumRegionalSum),
    high: z.number().finite().min(0).max(maximumRegionalSum),
  })
  .readonly();
const channelRatiosSchema = z
  .strictObject({
    lowMid: melBandRatioSchema,
    highMid: melBandRatioSchema,
  })
  .readonly();
export const melBandFrameAnalysisSchema = z
  .strictObject({
    magnitudes: melBandStereoFrameSchema,
    regions: z.tuple([regionalSumsSchema, regionalSumsSchema]).readonly(),
    ratios: z.tuple([channelRatiosSchema, channelRatiosSchema]).readonly(),
  })
  .superRefine((value, ctx) => {
    const expected = analyze(value.magnitudes);
    if (
      JSON.stringify(value.regions) !== JSON.stringify(expected.regions) ||
      JSON.stringify(value.ratios) !== JSON.stringify(expected.ratios)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Mel-band analysis must derive from its retained vector",
      });
    }
  })
  .readonly();
export const melBandAggregationSchema = z.union([
  z
    .strictObject({ status: z.literal("no-frames"), frameCount: z.literal(0) })
    .readonly(),
  z
    .strictObject({
      status: z.literal("completed"),
      frameCount: z.number().int().min(1).max(MAX_MEL_BAND_FRAMES),
      analysis: melBandFrameAnalysisSchema,
    })
    .readonly(),
]);
