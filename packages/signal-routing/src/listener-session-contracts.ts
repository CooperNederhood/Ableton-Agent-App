import { z } from "zod";
import {
  listenerNativeSessionStatusSchema,
  nativeSessionListeningConfigSchema,
  nativeSessionArmProofSchema,
  nativeSessionLaunchProofSchema,
  nativeSessionCaptureProofSchema,
  nativeListenerLifecycleV2Schema,
  NATIVE_SESSION_LISTENER_SCOPE,
} from "@ableton-agent/protocol";
import {
  listenerRegistrationV2Schema,
  listenerControlV2Schema,
  listenerReplyV2Schema,
  listenerResultV2Schema,
} from "./listener-v2-contracts.js";
import { listenerPathsHaveSameOwner } from "./listener-contracts.js";
import { DEFAULT_MAX_INGRESS_FRAME_BYTES } from "./contracts.js";

export const LISTENER_VERSION_SESSION = 3 as const;
export const LISTENER_CAPABILITY_SESSION = "audio-listener/session-v1" as const;
export const listenerRegistrationSessionSchema = z
  .strictObject({
    ...listenerRegistrationV2Schema.shape,
    version: z.literal(3),
    capabilities: z.tuple([z.literal(LISTENER_CAPABILITY_SESSION)]),
    nativeStatus: listenerNativeSessionStatusSchema,
  })
  .refine(
    listenerPathsHaveSameOwner,
    "Reported listener paths must have the same owning track",
  )
  .refine(
    (v) =>
      v.nativeStatus.readiness !== "READY" ||
      (v.nativeStatus.acceptedSampleRates.some(
        (rate) => rate === v.sampleRate,
      ) &&
        v.nativeStatus.acceptedVectorSizes.includes(v.vectorSize)),
    "Unsupported ready DSP geometry",
  );
export const listenerControlSessionSchema = z
  .strictObject({
    ...listenerControlV2Schema.shape,
    listenerVersion: z.literal(3),
    config: nativeSessionListeningConfigSchema.optional(),
  })
  .refine(
    (v) => (v.action === "prepare") === (v.config !== undefined),
    "Only prepare controls carry immutable Session configuration",
  );
export const listenerReplySessionSchema = z
  .strictObject({
    ...listenerReplyV2Schema.shape,
    listenerVersion: z.literal(3),
    nativeArm: nativeSessionArmProofSchema.optional(),
  })
  .refine(
    (v) => (v.status === "armed") === (v.nativeArm !== undefined),
    "An armed Session reply requires fresh negotiated proof",
  )
  .refine(
    (v) => v.status !== "failed" || v.reason !== undefined,
    "Failure requires a reason",
  )
  .refine(
    (v) => !v.nativeFailureDiagnostic || v.status === "failed",
    "Diagnostics are not capture authority",
  );
export const listenerResultSessionSchema = z
  .strictObject({
    ...listenerResultV2Schema.shape,
    listenerVersion: z.literal(3),
    nativeLaunch: nativeSessionLaunchProofSchema.optional(),
    nativeCapture: nativeSessionCaptureProofSchema.optional(),
    nativeLifecycle: z
      .strictObject({
        ...nativeListenerLifecycleV2Schema.shape,
        scope: z.literal(NATIVE_SESSION_LISTENER_SCOPE),
      })
      .refine(
        (v) =>
          !["failed", "cancelled"].includes(v.stage) || v.reason !== undefined,
        "Failure/cancellation requires a reason",
      )
      .optional(),
  })
  .superRefine((v, ctx) => {
    if (
      (v.status === "completed" && (!v.observation || !v.nativeCapture)) ||
      (v.status !== "completed" && v.nativeCapture !== undefined) ||
      (v.status !== "progress" && (v.nativeLaunch || v.nativeLifecycle)) ||
      (v.nativeFailureDiagnostic !== undefined && v.status !== "failed") ||
      (["failed", "partial"].includes(v.status) && v.reason === undefined) ||
      (v.observation && v.observation.complete !== (v.status === "completed"))
    )
      ctx.addIssue({
        code: "custom",
        message: "Invalid Session transport result stage/evidence",
      });
    if (
      new TextEncoder().encode(JSON.stringify(v)).byteLength >
      DEFAULT_MAX_INGRESS_FRAME_BYTES
    )
      ctx.addIssue({
        code: "custom",
        message: "Session transport result exceeds ingress frame quota",
      });
  });
export type ListenerRegistrationSession = z.infer<
  typeof listenerRegistrationSessionSchema
>;
export type ListenerControlSession = z.infer<
  typeof listenerControlSessionSchema
>;
export type ListenerReplySession = z.infer<typeof listenerReplySessionSchema>;
export type ListenerResultSession = z.infer<typeof listenerResultSessionSchema>;
