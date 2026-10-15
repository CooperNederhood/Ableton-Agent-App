import { z } from "zod";
import { nativeListeningGeometrySchema } from "./native-listening-geometry.js";
import { NATIVE_LISTENER_SCOPE_V2 } from "./native-listening-v2-schemas.js";

/** Producer capabilities, not independent physical-accuracy authority. */
export const listenerNativeStatusV2Schema = z
  .strictObject({
    version: z.literal(2),
    scope: z.literal(NATIVE_LISTENER_SCOPE_V2),
    readiness: z.enum(["READY", "BLOCKED"]),
    alignment: z.literal("approximate"),
    verifiedAbsoluteErrorBoundSamples: z.null(),
    acceptedSampleRates: z.tuple([z.literal(44_100), z.literal(48_000)]),
    acceptedVectorSizes: z
      .array(nativeListeningGeometrySchema.shape.vectorSize)
      .min(1)
      .max(11)
      .refine((values) => new Set(values).size === values.length),
    timingModes: z.tuple([z.literal("descriptive"), z.literal("strict")]),
    maxClockDisagreementSamples: z.literal(480),
    maxAudioDurationMs: z.literal(30_000),
    maxWindows: z.literal(300),
    abiVersion: z.literal(2),
    reason: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,127}$/)
      .optional(),
  })
  .refine(
    (value) => value.readiness !== "BLOCKED" || value.reason !== undefined,
    { message: "Blocked native v2 readiness requires an explanatory reason" },
  );
export type ListenerNativeStatusV2 = z.infer<
  typeof listenerNativeStatusV2Schema
>;
