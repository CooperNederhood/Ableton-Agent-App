import { z } from "zod";
import {
  LISTENER_CAPABILITY_ANALYZER_TIMELINES,
  analyzerNativeReadinessSchema,
} from "./analyzer-profile.js";
import { listenerNativeMetricStatusSchema } from "./listener-native-status-metric.js";
import {
  NATIVE_METRIC_ALGORITHM_VERSION,
  NATIVE_METRIC_LISTENING_CAPABILITY,
  NATIVE_MEL_BAND_LISTENING_CAPABILITY,
} from "./native-metric-listening-schemas.js";

export const listenerMetricCapabilitiesSchema = z.union([
  z.tuple([
    z.literal(NATIVE_METRIC_LISTENING_CAPABILITY),
    z.literal(NATIVE_MEL_BAND_LISTENING_CAPABILITY),
  ]),
  z.tuple([
    z.literal(NATIVE_METRIC_LISTENING_CAPABILITY),
    z.literal(NATIVE_MEL_BAND_LISTENING_CAPABILITY),
    z.literal(LISTENER_CAPABILITY_ANALYZER_TIMELINES),
  ]),
]);

const metadata = z.strictObject({
  capabilities: listenerMetricCapabilitiesSchema,
  algorithmVersion: z.literal(NATIVE_METRIC_ALGORITHM_VERSION),
  sampleRate: z.number().int().min(8_000).max(384_000),
  vectorSize: z.number().int().min(1).max(65_536),
  nativeStatus: listenerNativeMetricStatusSchema,
  analyzerReadiness: analyzerNativeReadinessSchema.optional(),
});

/** Shared by authenticated ingress and application binding projections.
 * The native owner establishes perform/token freshness; parsing never creates it. */
export function refineListenerMetricRegistrationMetadata(
  value: z.infer<typeof metadata>,
  ctx: z.RefinementCtx,
): void {
  const analyzerCapability = value.capabilities.some(
    (capability) => capability === LISTENER_CAPABILITY_ANALYZER_TIMELINES,
  );
  if (
    analyzerCapability !== (value.analyzerReadiness !== undefined) ||
    (value.analyzerReadiness !== undefined &&
      value.analyzerReadiness.sampleRate !== value.sampleRate)
  )
    ctx.addIssue({
      code: "custom",
      path: ["analyzerReadiness"],
      message:
        "Analyzer capability requires exactly one actual ABI3 readiness receipt at the registered sample rate",
    });
  if (
    value.nativeStatus.executedGen?.config.requestedMetrics.some(
      (metric) => metric === "pitch" || metric === "spectral-shape",
    ) &&
    !analyzerCapability
  )
    ctx.addIssue({
      code: "custom",
      message:
        "Analyzer readiness requires the authoritative producer capability",
    });
}

export const listenerMetricRegistrationMetadataSchema = metadata.superRefine(
  refineListenerMetricRegistrationMetadata,
);
