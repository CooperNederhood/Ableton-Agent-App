import { z } from "zod";
import { MAX_METRIC_OBSERVATION_BYTES } from "./audio-observation-limits.js";
import { MAX_METRIC_LISTENING_SECONDS } from "./metric-listening-geometry.js";
import {
  MEL_BAND_PROFILE,
  melBandProfileSchema,
  melBandSampleRateSchema,
} from "./mel-band-profile.js";
import {
  melBandSupportSchema,
  melBandTimelineSchema,
} from "./mel-band-timeline.js";
import {
  boundJsonSchemaBytes,
  encodedJsonBytes,
  jsonArrayByteBound,
  jsonSchemaItem,
  jsonSchemaProperty,
  toBoundJsonSchema,
} from "./schema-byte-budget.js";

export const MAX_MEL_BAND_TIMELINE_BYTES = MAX_METRIC_OBSERVATION_BYTES;
export const melBandBudgetInputSchema = z
  .strictObject({
    sampleRate: melBandSampleRateSchema,
    sourceSupport: melBandSupportSchema,
    profile: melBandProfileSchema,
    byteLimit: z.number().int().min(1).max(MAX_MEL_BAND_TIMELINE_BYTES),
  })
  .refine(
    (value) =>
      value.sourceSupport.endSample - value.sourceSupport.startSample <=
      value.sampleRate * MAX_METRIC_LISTENING_SECONDS,
    "Mel-band budget duration must not exceed thirty seconds",
  )
  .readonly();
export type MelBandBudgetInput = z.input<typeof melBandBudgetInputSchema>;
export type MelBandBudgetOutcome = "complete" | "partial";
export type MelBandBudgetViolation = Readonly<{
  outcome: MelBandBudgetOutcome;
  upperBoundBytes: number;
  byteLimit: number;
  excessBytes: number;
}>;
type BudgetResult = Readonly<{
  schema: "mel-band-budget/v1";
  snapshot: z.output<typeof melBandBudgetInputSchema>;
  operands: Readonly<{
    expectedRecords: number;
    positiveNumberCharacters: 24;
    sampleCharacters: 14;
    profileBytes: number;
    frameBytes: number;
    gapBytes: number;
    completeSlotsBytes: number;
    partialSlotsBytes: number;
  }>;
  upperBounds: Readonly<Record<MelBandBudgetOutcome, number>>;
  limits: Readonly<{ timelineBytes: number }>;
}>;
export type MelBandBudgetAdmission =
  | (BudgetResult & Readonly<{ admitted: true }>)
  | (BudgetResult &
      Readonly<{
        admitted: false;
        reason: "mel_band_timeline_budget_exceeded";
        violations: readonly MelBandBudgetViolation[];
      }>);

const timelineJsonSchema = toBoundJsonSchema(melBandTimelineSchema);
const frameSchema = jsonSchemaItem(
  jsonSchemaProperty(timelineJsonSchema, "frames"),
);
const gapSchema = jsonSchemaItem(
  jsonSchemaProperty(timelineJsonSchema, "gaps"),
);

/**
 * Compact JSON/UTF-8 raw-timeline bounds, not transport-envelope admission or
 * physical source qualification. Callers must reserve any surrounding wire
 * envelope separately and bind publication to the immutable snapshot.
 * The partial bound also covers all-gap failed timelines.
 */
export function admitMelBandBudget(input: unknown): MelBandBudgetAdmission {
  const snapshot = melBandBudgetInputSchema.parse(input);
  const expectedRecords = Math.floor(
    (snapshot.sourceSupport.endSample - snapshot.sourceSupport.startSample) /
      MEL_BAND_PROFILE.windowSamples,
  );
  const frameBytes = boundJsonSchemaBytes(frameSchema);
  const gapBytes = boundJsonSchemaBytes(gapSchema);
  const profileBytes = encodedJsonBytes(snapshot.profile);
  const completeSlotsBytes =
    jsonArrayByteBound(expectedRecords, frameBytes) + 2;
  // Each slot is a record OR a gap. Maximize only feasible allocations, with
  // at least one gap for nonempty partial/failed outcomes. Grouped gaps can
  // never exceed this per-slot gap bound.
  let partialSlotsBytes = 4;
  for (let records = 0; records < expectedRecords; records++) {
    partialSlotsBytes = Math.max(
      partialSlotsBytes,
      jsonArrayByteBound(records, frameBytes) +
        jsonArrayByteBound(expectedRecords - records, gapBytes),
    );
  }
  const upperBound = (outcome: MelBandBudgetOutcome) =>
    boundJsonSchemaBytes(timelineJsonSchema, "", (path) => {
      if (path === "profile") return profileBytes;
      if (path === "status") return encodedJsonBytes(outcome);
      if (path === "sampleRate") return encodedJsonBytes(snapshot.sampleRate);
      if (path === "expectedRecords") return encodedJsonBytes(expectedRecords);
      // The object encoder adds both array fields. Distribute their combined
      // encoded size over these overrides without double-counting slot claims.
      if (path === "frames")
        return (
          (outcome === "complete" ? completeSlotsBytes : partialSlotsBytes) - 2
        );
      if (path === "gaps") return 2;
      return undefined;
    });
  const upperBounds = Object.freeze({
    complete: upperBound("complete"),
    partial: upperBound("partial"),
  });
  const common = {
    schema: "mel-band-budget/v1" as const,
    snapshot,
    operands: Object.freeze({
      expectedRecords,
      positiveNumberCharacters: 24 as const,
      sampleCharacters: 14 as const,
      profileBytes,
      frameBytes,
      gapBytes,
      completeSlotsBytes,
      partialSlotsBytes,
    }),
    upperBounds,
    limits: Object.freeze({ timelineBytes: snapshot.byteLimit }),
  };
  const violations = (["complete", "partial"] as const)
    .filter((outcome) => upperBounds[outcome] > snapshot.byteLimit)
    .map((outcome) =>
      Object.freeze({
        outcome,
        upperBoundBytes: upperBounds[outcome],
        byteLimit: snapshot.byteLimit,
        excessBytes: upperBounds[outcome] - snapshot.byteLimit,
      }),
    );
  return violations.length === 0
    ? Object.freeze({ ...common, admitted: true })
    : Object.freeze({
        ...common,
        admitted: false,
        reason: "mel_band_timeline_budget_exceeded",
        violations: Object.freeze(violations),
      });
}
