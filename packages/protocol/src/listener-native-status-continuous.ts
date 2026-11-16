import { z } from "zod";
import { listenerNativeMetricStatusSchema } from "./listener-native-status-metric.js";
import {
  NATIVE_CONTINUOUS_METRIC_LISTENING_SCOPE,
  nativeContinuousMetricArmProofSchema,
  nativeContinuousMetricArmProofWireSchema,
  compactNativeContinuousMetricArmProof,
} from "./native-continuous-metric-listening-schemas.js";
import {
  MAX_CONTINUOUS_METRIC_LISTENING_SECONDS,
  MAX_CONTINUOUS_METRIC_REPORT_ROWS,
} from "./metric-continuous-geometry.js";
import { metricRecordStreamCapabilitySchema } from "./metric-record-stream.js";
import { metricObservationMetricSchema } from "./metric-observation-schemas.js";

/** Producer-reported execution evidence; authentication/freshness and real
 * streaming qualification remain application/native integration obligations. */
export const listenerNativeContinuousMetricStatusSchema = z
  .strictObject({
    ...listenerNativeMetricStatusSchema.shape,
    version: z.literal(6),
    scope: z.literal(NATIVE_CONTINUOUS_METRIC_LISTENING_SCOPE),
    maxAudioDurationMs: z.literal(600_000),
    maxSessionAudioDurationMs: z.literal(600_000),
    maxReportRows: z.literal(MAX_CONTINUOUS_METRIC_REPORT_ROWS),
    maxSessionReportRows: z.literal(MAX_CONTINUOUS_METRIC_REPORT_ROWS),
    streamCapability: metricRecordStreamCapabilitySchema,
    executedGen: nativeContinuousMetricArmProofSchema.nullable().optional(),
  })
  .superRefine((value, ctx) => {
    const proof = value.executedGen;
    if (
      (value.readiness === "BLOCKED" && value.reason === undefined) ||
      (value.readiness === "READY" &&
        (proof == null ||
          proof.config.geometry.totalSamples !==
            MAX_CONTINUOUS_METRIC_LISTENING_SECONDS *
              proof.config.geometry.sampleRate ||
          proof.config.requestedMetrics.length !==
            metricObservationMetricSchema.options.length ||
          !metricObservationMetricSchema.options.every((metric) =>
            proof.config.requestedMetrics.includes(metric),
          )))
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Continuous readiness requires actual executed 600-second all-six configuration or an explicit blocked reason",
      });
  });
export type ListenerNativeContinuousMetricStatus = z.infer<
  typeof listenerNativeContinuousMetricStatusSchema
>;
export const listenerNativeContinuousMetricStatusWireSchema = z
  .strictObject({
    ...listenerNativeContinuousMetricStatusSchema.shape,
    executedGen: nativeContinuousMetricArmProofWireSchema.nullable().optional(),
  })
  .pipe(listenerNativeContinuousMetricStatusSchema);
export type ListenerNativeContinuousMetricStatusWire = z.input<
  typeof listenerNativeContinuousMetricStatusWireSchema
>;
export function compactListenerNativeContinuousMetricStatus(
  input: ListenerNativeContinuousMetricStatus,
): ListenerNativeContinuousMetricStatusWire {
  const status = listenerNativeContinuousMetricStatusSchema.parse(input);
  return {
    ...status,
    executedGen:
      status.executedGen == null
        ? status.executedGen
        : compactNativeContinuousMetricArmProof(status.executedGen),
  };
}
export const listenerNativeMetricRegistrationStatusWireSchema = z.union([
  listenerNativeMetricStatusSchema,
  listenerNativeContinuousMetricStatusWireSchema,
]);
export const listenerNativeMetricRegistrationStatusSchema = z.union([
  listenerNativeMetricStatusSchema,
  listenerNativeContinuousMetricStatusSchema,
]);
export type ListenerNativeMetricRegistrationStatus = z.infer<
  typeof listenerNativeMetricRegistrationStatusSchema
>;
