import { z } from "zod";
import { metricListeningGeometrySchema } from "./metric-listening-geometry.js";
import {
  NATIVE_METRIC_LISTENING_SCOPE,
  nativeMetricArmProofSchema,
} from "./native-metric-listening-schemas.js";

/** Producer-reported readiness, not independent DSP or freshness authority. */
export const listenerNativeMetricStatusSchema = z
  .strictObject({
    version: z.literal(5),
    scope: z.literal(NATIVE_METRIC_LISTENING_SCOPE),
    readiness: z.enum(["READY", "BLOCKED"]),
    alignment: z.literal("approximate"),
    verifiedAbsoluteErrorBoundSamples: z.null(),
    acceptedSampleRates: z.tuple([z.literal(44_100), z.literal(48_000)]),
    acceptedVectorSizes: z
      .array(metricListeningGeometrySchema.shape.vectorSize)
      .min(1)
      .max(11)
      .refine((values) => new Set(values).size === values.length),
    supportedModes: z.tuple([z.literal("arrangement"), z.literal("session")]),
    timingModes: z.tuple([z.literal("descriptive"), z.literal("strict")]),
    maxClockDisagreementSamples: z.literal(480),
    maxAudioDurationMs: z.literal(30_000),
    maxReportRows: z.literal(2_000),
    // Authentic process/owner binding and freshness remain integration-owned.
    executedGen: nativeMetricArmProofSchema.nullable().optional(),
    reason: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,127}$/u)
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (
      (value.readiness === "READY" && value.executedGen == null) ||
      (value.readiness === "BLOCKED" && value.reason === undefined)
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "Native readiness requires actual executed Gen evidence or a blocked reason",
      });
    }
  });

export type ListenerNativeMetricStatus = z.infer<
  typeof listenerNativeMetricStatusSchema
>;
