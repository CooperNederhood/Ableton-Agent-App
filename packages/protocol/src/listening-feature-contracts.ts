import { z } from "zod";
import {
  MAX_MEL_BAND_MAGNITUDE,
  MEL_BAND_DENOMINATOR_FLOOR,
} from "./mel-band-profile.js";
import { MAX_METRIC_ATTACK_STRENGTH_DB } from "./metric-observation-schemas.js";
import {
  MIN_SPECTRAL_FLATNESS_DB,
  MAX_SPECTRAL_FLATNESS_DB,
  PITCH_OUTPUT_MINIMUM_HZ,
  PITCH_OUTPUT_MAXIMUM_HZ,
  MAX_ANALYZER_FRAMES,
} from "./analyzer-profile.js";

export const listeningFeatureTypeSchema = z.enum([
  "peak-summary/v1",
  "level-grid/v1",
  "spectral-energy-summary/v1",
  "centroid-grid/v1",
  "attack-activity-grid/v1",
  "attack-strength-grid/v1",
  "mel-shape/v1",
  "mel-grid/v1",
  "mel-region-summary/v1",
  "mel-ratio-summary/v1",
  "pitch-grid/v1",
  "pitch-confidence-summary/v1",
  "flatness-summary/v1",
  "spread-summary/v1",
  "rolloff-summary/v1",
]);
export type ListeningFeatureType = z.infer<typeof listeningFeatureTypeSchema>;
const MAX_LISTENING_FEATURE_VALUE =
  (24 * MAX_MEL_BAND_MAGNITUDE) / MEL_BAND_DENOMINATOR_FLOOR;

/** Scalar domain only: null masks, support and whole-vector normalization are validated separately. */
export function isListeningFeatureValueValid(
  type: ListeningFeatureType,
  value: number | null,
  sampleRate: number,
): boolean {
  if (sampleRate !== 44100 && sampleRate !== 48000) return false;
  if (value === null) return true;
  if (!Number.isFinite(value) || value > MAX_LISTENING_FEATURE_VALUE)
    return false;
  if (type === "flatness-summary/v1")
    return (
      value >= MIN_SPECTRAL_FLATNESS_DB && value <= MAX_SPECTRAL_FLATNESS_DB
    );
  if (value < 0) return false;
  switch (type) {
    case "peak-summary/v1":
    case "level-grid/v1":
      return value <= 64;
    case "spectral-energy-summary/v1":
      return value <= Number.MAX_SAFE_INTEGER;
    case "centroid-grid/v1":
      return value <= 24000;
    case "attack-activity-grid/v1":
      return Number.isInteger(value) && value <= 300;
    case "attack-strength-grid/v1":
      return value <= MAX_METRIC_ATTACK_STRENGTH_DB;
    case "mel-shape/v1":
    case "mel-grid/v1":
      return value <= Math.sqrt(1 + 1e-8);
    case "mel-region-summary/v1":
      return value <= 24 * MAX_MEL_BAND_MAGNITUDE;
    case "mel-ratio-summary/v1":
      return true;
    case "pitch-grid/v1":
      return (
        value >= 69 + 12 * Math.log2(PITCH_OUTPUT_MINIMUM_HZ / 440) - 1e-10 &&
        value <= 69 + 12 * Math.log2(PITCH_OUTPUT_MAXIMUM_HZ / 440) + 1e-10
      );
    case "pitch-confidence-summary/v1":
      return value <= 1;
    case "spread-summary/v1":
    case "rolloff-summary/v1":
      return value <= sampleRate / 2;
  }
}
export const LISTENING_FEATURE_LIMITS = Object.freeze({
  cells: 2000,
  segments: 512,
  featureBytes: 4 * 1024 * 1024,
  batchBytes: 8 * 1024 * 1024,
  candidateBytes: 16 * 1024 * 1024,
  candidates: 1000,
  searchMs: 1000,
});
export const MAX_CONTEXT_FEATURES_PER_DERIVATION =
  LISTENING_FEATURE_LIMITS.segments * listeningFeatureTypeSchema.options.length;
export const LISTENING_FEATURE_DEFINITION_SET = "qualified-listening/v1";
export const listeningFeatureDistanceSchema = z.enum([
  "euclidean-linear-amplitude/v1",
  "rms-linear-amplitude/v1",
  "absolute-native-fft-energy/v1",
  "rms-hz/v1",
  "rms-count/v1",
  "rms-db-rise/v1",
  "euclidean-normalized-magnitude/v1",
  "rms-normalized-magnitude/v1",
  "euclidean-native-magnitude/v1",
  "euclidean-ratio/v1",
  "rms-cents/v1",
  "euclidean-algorithm-score/v1",
  "euclidean-db/v1",
  "euclidean-hz/v1",
]);
export const listeningFeatureUnitsSchema = z.enum([
  "linear-amplitude",
  "native-fft-energy",
  "Hz",
  "count",
  "dB-rise",
  "normalized-magnitude",
  "native-magnitude",
  "ratio",
  "midi-semitones",
  "algorithm-score",
  "dB",
]);
export const listeningFeatureDistanceUnitsSchema = z.enum([
  ...listeningFeatureUnitsSchema.options,
  "cents",
]);
const profileSchema = z.enum([
  "sample-grid-peak-rms/v1",
  "fft-energy-centroid/v1",
  "level-window-rise/v1",
  "mel-band-profile/v1",
  "pitch-profile/v1",
  "spectral-shape-profile/v1",
]);
export const listeningFeatureDefinitionSchema = z
  .strictObject({
    type: listeningFeatureTypeSchema,
    measurement: z.string().min(1).max(100),
    distanceDefinition: listeningFeatureDistanceSchema,
    units: listeningFeatureUnitsSchema,
    distanceUnits: listeningFeatureDistanceUnitsSchema,
    dimensions: z.number().int().min(1).max(48),
    profile: profileSchema,
    grid: z.boolean(),
    normalization: z.enum(["none", "joint-l2"]),
    description: z.string().max(512),
    limitations: z.array(z.string().max(256)).max(8).readonly(),
  })
  .readonly();
type Definition = z.infer<typeof listeningFeatureDefinitionSchema>;
const definition = (
  type: ListeningFeatureType,
  measurement: string,
  distanceDefinition: Definition["distanceDefinition"],
  units: Definition["units"],
  dimensions: number,
  profile: Definition["profile"],
  description: string,
  grid = false,
  normalization: Definition["normalization"] = "none",
  distanceUnits: Definition["distanceUnits"] = units,
): Definition =>
  listeningFeatureDefinitionSchema.parse({
    type,
    measurement,
    distanceDefinition,
    units,
    distanceUnits,
    dimensions,
    profile,
    description,
    grid,
    normalization,
    limitations: [
      "Descriptive measurement distance, not perceptual similarity or identity",
      ...(grid
        ? [
            "Quarter-beat cells require trusted musical alignment metadata",
            "Timing remains descriptive message-rate evidence, not proof against tempo automation or sample-accurate beat alignment",
          ]
        : ["Duration and retained support remain explicit"]),
      ...(profile === "fft-energy-centroid/v1" ||
      profile === "mel-band-profile/v1" ||
      profile === "pitch-profile/v1" ||
      profile === "spectral-shape-profile/v1"
        ? [
            "FFT descriptors are projected by overlapping support, not newly acquired at cell boundaries",
          ]
        : []),
      ...(profile === "level-window-rise/v1"
        ? ["Events retain detector-window endpoints, not physical onset timing"]
        : []),
      ...(profile === "pitch-profile/v1"
        ? [
            "Accepted estimates are numeric gates, not input-class or accuracy proofs; 2000Hz can produce a high-confidence 1000Hz octave error",
            "Confidence is an algorithm score, not a probability; finite low-confidence and outside-range scores remain estimator observations",
          ]
        : []),
    ],
  });
export const LISTENING_FEATURE_DEFINITIONS: readonly Definition[] =
  Object.freeze([
    definition(
      "peak-summary/v1",
      "stereo-sample-peak",
      "euclidean-linear-amplitude/v1",
      "linear-amplitude",
      2,
      "sample-grid-peak-rms/v1",
      "Maximum wholly retained sample peak per independent channel; not true peak or loudness",
    ),
    definition(
      "level-grid/v1",
      "stereo-rms",
      "rms-linear-amplitude/v1",
      "linear-amplitude",
      2,
      "sample-grid-peak-rms/v1",
      "Independent-channel RMS reconstructed from complete unsplit record energy and sample counts",
      true,
    ),
    definition(
      "spectral-energy-summary/v1",
      "aggregate-spectral-energy",
      "absolute-native-fft-energy/v1",
      "native-fft-energy",
      1,
      "fft-energy-centroid/v1",
      "Support-weighted native FFT energy; not calibrated acoustic energy",
    ),
    definition(
      "centroid-grid/v1",
      "aggregate-spectral-centroid",
      "rms-hz/v1",
      "Hz",
      1,
      "fft-energy-centroid/v1",
      "Support-weighted aggregate spectral centroid, unavailable for undefined silent descriptors",
      true,
    ),
    definition(
      "attack-activity-grid/v1",
      "detector-endpoint-count",
      "rms-count/v1",
      "count",
      1,
      "level-window-rise/v1",
      "Counts of measured detector endpoints, with zero only for fully covered event-free cells",
      true,
    ),
    definition(
      "attack-strength-grid/v1",
      "detector-db-rise",
      "rms-db-rise/v1",
      "dB-rise",
      1,
      "level-window-rise/v1",
      "Maximum detector dB rise per cell, with zero only for fully covered event-free cells",
      true,
    ),
    definition(
      "mel-shape/v1",
      "stereo-24-band-magnitudes",
      "euclidean-normalized-magnitude/v1",
      "normalized-magnitude",
      48,
      "mel-band-profile/v1",
      "Support-weighted channel means concatenated with one joint L2 normalization",
      false,
      "joint-l2",
    ),
    definition(
      "mel-grid/v1",
      "stereo-24-band-magnitudes",
      "rms-normalized-magnitude/v1",
      "normalized-magnitude",
      48,
      "mel-band-profile/v1",
      "Support-weighted stereo cell vectors with one joint L2 normalization across the sequence",
      true,
      "joint-l2",
    ),
    definition(
      "mel-region-summary/v1",
      "stereo-low-mid-high-magnitudes",
      "euclidean-native-magnitude/v1",
      "native-magnitude",
      6,
      "mel-band-profile/v1",
      "Low/mid/high sums of support-weighted mean band vectors for each channel",
    ),
    definition(
      "mel-ratio-summary/v1",
      "stereo-low-mid-high-ratios",
      "euclidean-ratio/v1",
      "ratio",
      4,
      "mel-band-profile/v1",
      "Low/mid and high/mid ratios computed after support-weighted aggregation, never averaged frame ratios",
    ),
    definition(
      "pitch-grid/v1",
      "stereo-accepted-pitch-estimates",
      "rms-cents/v1",
      "midi-semitones",
      2,
      "pitch-profile/v1",
      "Independent-channel overlap-weighted continuous MIDI-semitone log pitch; distance is RMS cents without octave removal",
      true,
      "none",
      "cents",
    ),
    definition(
      "pitch-confidence-summary/v1",
      "stereo-estimator-confidence",
      "euclidean-algorithm-score/v1",
      "algorithm-score",
      2,
      "pitch-profile/v1",
      "Support-weighted finite estimator scores, including low-confidence and outside-qualified-range observations; not probability",
    ),
    definition(
      "flatness-summary/v1",
      "stereo-spectral-flatness",
      "euclidean-db/v1",
      "dB",
      2,
      "spectral-shape-profile/v1",
      "Independent-channel support-weighted valid signed dB flatness; silence and undefined output are not zero",
    ),
    definition(
      "spread-summary/v1",
      "stereo-spectral-spread",
      "euclidean-hz/v1",
      "Hz",
      2,
      "spectral-shape-profile/v1",
      "Independent-channel support-weighted valid magnitude-weighted spectral spread in Hz",
    ),
    definition(
      "rolloff-summary/v1",
      "stereo-spectral-rolloff-95",
      "euclidean-hz/v1",
      "Hz",
      2,
      "spectral-shape-profile/v1",
      "Independent-channel support-weighted valid 95-percent magnitude rolloff in Hz",
    ),
  ]);
export function listeningFeatureDefinition(
  type: ListeningFeatureType,
): Definition {
  return LISTENING_FEATURE_DEFINITIONS.find((item) => item.type === type)!;
}

export const listeningFeatureUnavailableReasonSchema = z.enum([
  "no-level-records",
  "unsupported-level-profile",
  "unsupported-profile",
  "not-requested",
  "no-records",
  "missing-alignment",
  "insufficient-support",
  "straddling-level-record",
  "undefined-descriptor",
  "zero-norm",
  "zero-denominator",
  "below-floor",
  "silence",
  "low-confidence",
  "outside-qualified-range",
  "invalid-output",
  "incompatible-source-support",
]);
export type ListeningFeatureUnavailableReason = z.infer<
  typeof listeningFeatureUnavailableReasonSchema
>;
const sample = z
  .number()
  .int()
  .nonnegative()
  .max(2 ** 44 - 1);
const channelReasons = z.tuple([
  listeningFeatureUnavailableReasonSchema.nullable(),
  listeningFeatureUnavailableReasonSchema.nullable(),
]);
const supportIntervals = z.array(z.tuple([sample, sample]));
export const listeningFeatureGridSchema = z
  .strictObject({
    stepBeats: z.literal(0.25),
    meter: z.strictObject({
      numerator: z.number().int().min(1).max(128),
      denominator: z
        .number()
        .int()
        .min(1)
        .max(128)
        .refine((value) => (value & (value - 1)) === 0),
    }),
    phaseBeats: z.number().finite().nonnegative(),
    cells: z
      .array(
        z
          .strictObject({
            startBeat: z.number().finite().nonnegative(),
            endBeat: z.number().finite().positive(),
            coveredSamples: sample,
            expectedSamples: sample.positive(),
            reason: listeningFeatureUnavailableReasonSchema.nullable(),
            channelReasons: channelReasons.optional(),
            channelCoveredSamples: z.tuple([sample, sample]).optional(),
          })
          .refine(
            (value) =>
              value.endBeat > value.startBeat &&
              value.endBeat - value.startBeat <= 0.25 + 1e-9 &&
              value.coveredSamples <= value.expectedSamples,
          ),
      )
      .min(1)
      .max(2000),
  })
  .superRefine((value, context) => {
    if (
      value.phaseBeats >=
        (value.meter.numerator * 4) / value.meter.denominator ||
      value.cells.some(
        (cell, index) =>
          Math.abs(
            cell.startBeat -
              (index === 0 ? 0 : value.cells[index - 1]!.endBeat),
          ) > 1e-9,
      )
    )
      context.addIssue({
        code: "custom",
        message:
          "Grid phase and contiguous relative extents must match the meter",
      });
  });
export const listeningFeatureSchema = z
  .strictObject({
    type: listeningFeatureTypeSchema,
    distanceDefinition: listeningFeatureDistanceSchema,
    units: listeningFeatureUnitsSchema,
    distanceUnits: listeningFeatureDistanceUnitsSchema,
    profile: profileSchema,
    profileKey: z.string().min(1).max(1024),
    status: z.enum(["ready", "unavailable"]),
    reason: listeningFeatureUnavailableReasonSchema.nullable(),
    values: z
      .array(
        z
          .number()
          .finite()
          .min(MIN_SPECTRAL_FLATNESS_DB)
          .max(MAX_LISTENING_FEATURE_VALUE)
          .nullable(),
      )
      .max(2000 * 48)
      .nullable(),
    coveredSamples: sample,
    expectedSamples: sample.positive(),
    durationSeconds: z.number().finite().positive().max(30),
    sampleRate: z.union([z.literal(44100), z.literal(48000)]),
    normalization: z.enum(["none", "joint-l2"]),
    supportPolicy: z.enum([
      "complete-required",
      "matching-cell-mask",
      "retained-overlap",
    ]),
    // Relative sample intervals retain acquisition gaps without inventing measured zeros.
    support: z.array(z.tuple([sample, sample])).max(2000),
    channelSupport: z
      .tuple([
        supportIntervals.max(MAX_ANALYZER_FRAMES),
        supportIntervals.max(MAX_ANALYZER_FRAMES),
      ])
      .optional(),
    channelReasons: channelReasons.optional(),
    grid: listeningFeatureGridSchema.nullable(),
    limitations: z.array(z.string().max(256)).max(8),
  })
  .superRefine((value, ctx) => {
    const expected = listeningFeatureDefinition(value.type);
    const channelAware =
      expected.profile === "pitch-profile/v1" ||
      expected.profile === "spectral-shape-profile/v1";
    const dimensions =
      expected.dimensions *
      (expected.grid ? (value.grid?.cells.length ?? 0) : 1);
    if (
      value.distanceDefinition !== expected.distanceDefinition ||
      value.units !== expected.units ||
      value.distanceUnits !== expected.distanceUnits ||
      value.profile !== expected.profile ||
      value.normalization !== expected.normalization ||
      value.supportPolicy !==
        (expected.grid
          ? "matching-cell-mask"
          : value.type === "peak-summary/v1"
            ? "complete-required"
            : "retained-overlap") ||
      value.coveredSamples > value.expectedSamples ||
      Math.abs(
        value.durationSeconds - value.expectedSamples / value.sampleRate,
      ) > 1e-12 ||
      (value.status === "ready") !==
        (value.values !== null && value.reason === null) ||
      (value.status === "unavailable" &&
        (value.values !== null || value.reason === null)) ||
      (value.values !== null &&
        (dimensions === 0 || value.values.length !== dimensions)) ||
      (!expected.grid && value.grid !== null) ||
      channelAware !==
        (value.channelSupport !== undefined &&
          value.channelReasons !== undefined) ||
      (!channelAware &&
        (value.channelSupport !== undefined ||
          value.channelReasons !== undefined)) ||
      value.values?.some(
        (v) => !isListeningFeatureValueValid(value.type, v, value.sampleRate),
      ) ||
      (value.values !== null && !value.values.some((v) => v !== null)) ||
      (!expected.grid &&
        !channelAware &&
        value.values?.some((v) => v === null)) ||
      (value.status === "ready" &&
        value.grid?.cells.some(
          (cell, index) =>
            (cell.reason === null &&
              cell.coveredSamples !== cell.expectedSamples) ||
            (!channelAware &&
              value
                .values!.slice(
                  index * expected.dimensions,
                  (index + 1) * expected.dimensions,
                )
                .some((v) => (v === null) !== (cell.reason !== null))),
        )) ||
      value.support.reduce((count, [start, end]) => count + end - start, 0) !==
        value.coveredSamples ||
      (value.normalization === "joint-l2" &&
        value.values !== null &&
        Math.abs(
          value.values.reduce<number>((sum, v) => sum + (v ?? 0) ** 2, 0) - 1,
        ) > 1e-8) ||
      (value.grid !== null &&
        (value.grid.cells.reduce(
          (sum, cell) => sum + cell.expectedSamples,
          0,
        ) !== value.expectedSamples ||
          value.grid.cells.reduce(
            (sum, cell) => sum + cell.coveredSamples,
            0,
          ) !== value.coveredSamples))
    )
      ctx.addIssue({
        code: "custom",
        message: "Invalid feature definition, availability, shape or support",
      });
    let end = 0;
    for (const interval of value.support) {
      if (
        interval[0] < end ||
        interval[1] <= interval[0] ||
        interval[1] > value.expectedSamples
      )
        ctx.addIssue({
          code: "custom",
          message: "Support intervals must be ordered within source range",
        });
      end = interval[1];
    }
    if (
      channelAware &&
      value.channelSupport !== undefined &&
      value.channelReasons !== undefined
    ) {
      for (const channel of [0, 1] as const) {
        let previous = 0;
        const intervals = value.channelSupport[channel];
        for (const [start, finish] of intervals) {
          if (
            start < previous ||
            finish <= start ||
            !value.support.some(([a, b]) => a <= start && finish <= b)
          )
            ctx.addIssue({
              code: "custom",
              message:
                "Channel support must be ordered within acquired support",
            });
          previous = finish;
        }
        const defined =
          value.values?.some(
            (v, index) => index % 2 === channel && v !== null,
          ) ?? false;
        if (
          defined !== (value.channelReasons[channel] === null) ||
          (defined && intervals.length === 0) ||
          (!expected.grid && !defined && intervals.length > 0)
        )
          ctx.addIssue({
            code: "custom",
            message:
              "Channel availability must match defined values and retained support",
          });
      }
    }
    if (value.grid !== null) {
      let cellStart = 0;
      for (const [index, cell] of value.grid.cells.entries()) {
        if (
          channelAware !==
          (cell.channelReasons !== undefined &&
            cell.channelCoveredSamples !== undefined)
        )
          ctx.addIssue({
            code: "custom",
            message: "Grid channel support metadata must match feature profile",
          });
        if (
          !channelAware &&
          (cell.channelReasons !== undefined ||
            cell.channelCoveredSamples !== undefined)
        )
          ctx.addIssue({
            code: "custom",
            message: "Channel metadata requires a qualified analyzer profile",
          });
        if (
          !channelAware ||
          cell.channelReasons === undefined ||
          cell.channelCoveredSamples === undefined
        )
          continue;
        if ((cell.reason === null) !== cell.channelReasons.includes(null))
          ctx.addIssue({
            code: "custom",
            message:
              "Cell availability must preserve independent channel availability",
          });
        for (const channel of [0, 1] as const) {
          const valid = cell.channelReasons[channel] === null;
          const retained = value.channelSupport?.[channel].reduce(
            (sum, [start, end]) =>
              sum +
              Math.max(
                0,
                Math.min(end, cellStart + cell.expectedSamples) -
                  Math.max(start, cellStart),
              ),
            0,
          );
          if (
            cell.channelCoveredSamples[channel] > cell.coveredSamples ||
            retained !== cell.channelCoveredSamples[channel] ||
            valid !==
              (cell.channelCoveredSamples[channel] === cell.expectedSamples) ||
            valid !==
              (value.values !== null &&
                value.values[index * 2 + channel] !== null)
          )
            ctx.addIssue({
              code: "custom",
              message:
                "Grid values must retain independent channel validity and support",
            });
        }
        cellStart += cell.expectedSamples;
      }
    }
  });
export type ListeningFeature = z.infer<typeof listeningFeatureSchema>;
export const listeningFeatureComparisonSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("comparable"),
    distanceDefinition: listeningFeatureDistanceSchema,
    units: listeningFeatureDistanceUnitsSchema,
    distance: z.number().finite().nonnegative(),
  }),
  z.strictObject({
    status: z.literal("not-comparable"),
    reason: z.enum([
      "unavailable",
      "insufficient-support",
      "incompatible-type",
      "incompatible-profile",
      "incompatible-grid",
      "incompatible-support",
    ]),
  }),
]);
