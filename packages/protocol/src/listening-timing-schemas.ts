import { z } from "zod";

export const DEFAULT_LISTENING_CLOCK_DISAGREEMENT_SAMPLES = 64;
export const MAX_LISTENING_CLOCK_DISAGREEMENT_SAMPLES = 480;

const disagreement = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
const configuredLimit = disagreement.max(
  MAX_LISTENING_CLOCK_DISAGREEMENT_SAMPLES,
);
const sampleRate = z.number().int().min(8_000).max(384_000);

export const listeningTimingPolicySchema = z.discriminatedUnion("mode", [
  z.strictObject({
    mode: z.literal("descriptive"),
    maxClockDisagreementSamples: configuredLimit,
  }),
  z.strictObject({
    mode: z.literal("strict"),
    maxClockDisagreementSamples: z.literal(0),
  }),
]);
export type ListeningTimingPolicy = z.infer<typeof listeningTimingPolicySchema>;

export const DEFAULT_LISTENING_TIMING_POLICY: Readonly<ListeningTimingPolicy> =
  Object.freeze({
    mode: "descriptive",
    maxClockDisagreementSamples: DEFAULT_LISTENING_CLOCK_DISAGREEMENT_SAMPLES,
  });

export const listeningAlignmentMeasurementsSchema = z.strictObject({
  sampleRate,
  vectorSize: z.number().int().min(1).max(65_536),
  observedClockDisagreementSamples: disagreement,
  observedBeatDisagreementSamples: disagreement,
});
export type ListeningAlignmentMeasurements = z.infer<
  typeof listeningAlignmentMeasurementsSchema
>;

export const listeningAlignmentQualitySchema = z
  .strictObject({
    schema: z.literal("listening-alignment/v2"),
    policy: listeningTimingPolicySchema,
    ...listeningAlignmentMeasurementsSchema.shape,
    alignment: z.literal("approximate"),
    intendedUse: z.literal("descriptive-only"),
    estimatedAbsoluteErrorSamples: z.null(),
    verifiedAbsoluteErrorBoundSamples: z.null(),
  })
  .superRefine((value, ctx) => {
    if (
      Math.max(
        value.observedClockDisagreementSamples,
        value.observedBeatDisagreementSamples,
      ) > value.policy.maxClockDisagreementSamples
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Observed alignment disagreement exceeds the timing policy",
      });
    }
  });
export type ListeningAlignmentQuality = z.infer<
  typeof listeningAlignmentQualitySchema
>;

/** Pure policy evaluation, not a source-start, coverage or readiness certificate. */
export function evaluateListeningAlignment(
  policy: ListeningTimingPolicy,
  measurements: ListeningAlignmentMeasurements,
): Readonly<ListeningAlignmentQuality> {
  const snapshot = Object.freeze(listeningTimingPolicySchema.parse(policy));
  const measured = listeningAlignmentMeasurementsSchema.parse(measurements);
  if (
    Math.max(
      measured.observedClockDisagreementSamples,
      measured.observedBeatDisagreementSamples,
    ) > snapshot.maxClockDisagreementSamples
  ) {
    throw new Error("listening_alignment_budget_exceeded");
  }
  const quality = listeningAlignmentQualitySchema.parse({
    schema: "listening-alignment/v2",
    policy: snapshot,
    ...measured,
    alignment: "approximate",
    intendedUse: "descriptive-only",
    estimatedAbsoluteErrorSamples: null,
    verifiedAbsoluteErrorBoundSamples: null,
  });
  Object.freeze(quality.policy);
  return Object.freeze(quality);
}

export function listeningDisagreementMilliseconds(
  samples: number,
  actualSampleRate: number,
): number {
  return (
    (disagreement.parse(samples) / sampleRate.parse(actualSampleRate)) * 1_000
  );
}
