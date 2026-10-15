import { z } from "zod";
import {
  audioObservationV2Schema,
  nativeArmProofV2Schema,
  nativeCaptureProofV2Schema,
  nativeLaunchProofV2Schema,
  nativeListenerLifecycleV2Schema,
  nativeListeningGeometrySchema,
  NATIVE_LISTENER_SCOPE_V2,
  listeningTimingPolicySchema,
} from "@ableton-agent/protocol";
import {
  listenerControlSchema,
  listenerPathsHaveSameOwner,
  listenerRegistrationSchema,
} from "./listener-contracts.js";
import { DEFAULT_MAX_INGRESS_FRAME_BYTES } from "./contracts.js";

export const LISTENER_VERSION_V2 = 2 as const;
export const LISTENER_CAPABILITY_V2 = "audio-listener/v2" as const;

/** Producer-reported implementation capabilities, never physical accuracy authority. */
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
    {
      message: "Blocked native v2 readiness requires an explanatory reason",
    },
  );

export const listenerRegistrationV2Schema = z
  .strictObject({
    ...listenerRegistrationSchema.shape,
    version: z.literal(LISTENER_VERSION_V2),
    capabilities: z.tuple([z.literal(LISTENER_CAPABILITY_V2)]),
    algorithmVersion: z.literal("2.0.0"),
    vectorSize: z.number().int().min(1).max(65_536),
    nativeStatus: listenerNativeStatusV2Schema,
  })
  .refine(listenerPathsHaveSameOwner, {
    message: "Reported listener paths must have the same owning track",
  })
  .refine(
    (value) =>
      value.nativeStatus.readiness !== "READY" ||
      value.nativeStatus.acceptedSampleRates.some(
        (rate) => rate === value.sampleRate,
      ),
    {
      message: "Native v2 cannot report ready at an unsupported sample rate",
    },
  )
  .refine(
    (value) =>
      value.nativeStatus.readiness !== "READY" ||
      value.nativeStatus.acceptedVectorSizes.includes(value.vectorSize),
    {
      message:
        "Native v2 cannot report ready at an unsupported DSP vector size",
    },
  );

export const listenerConfigV2Schema = z.strictObject({
  geometry: nativeListeningGeometrySchema,
  timingPolicy: listeningTimingPolicySchema,
});

const wire = listenerControlSchema
  .omit({
    type: true,
    action: true,
    config: true,
  })
  .extend({ listenerVersion: z.literal(LISTENER_VERSION_V2) });

export const listenerControlV2Schema = wire
  .extend({
    type: z.literal("listener.control"),
    action: z.enum(["prepare", "arm", "cancel"]),
    config: listenerConfigV2Schema.optional(),
  })
  .refine(
    (value) => (value.action === "prepare") === (value.config !== undefined),
    {
      message: "Only prepare controls carry the immutable v2 configuration",
    },
  );

export const listenerReplyV2Schema = wire
  .extend({
    type: z.literal("listener.reply"),
    sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    status: z.enum(["ready", "armed", "cancelled", "failed"]),
    reason: z.string().min(1).max(512).optional(),
    nativeArm: nativeArmProofV2Schema.optional(),
  })
  .refine(
    (value) => (value.status === "armed") === (value.nativeArm !== undefined),
    {
      message: "An armed v2 reply requires its fresh native arm proof",
    },
  )
  .refine((value) => value.status !== "failed" || value.reason !== undefined, {
    message: "Failed v2 replies require a reason",
  });

export const listenerResultV2Schema = wire
  .extend({
    type: z.literal("listener.result"),
    sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    status: z.enum(["progress", "completed", "partial", "failed"]),
    observation: audioObservationV2Schema.optional(),
    reason: z.string().min(1).max(512).optional(),
    nativeLaunch: nativeLaunchProofV2Schema.optional(),
    nativeCapture: nativeCaptureProofV2Schema.optional(),
    nativeLifecycle: nativeListenerLifecycleV2Schema.optional(),
  })
  .superRefine((value, ctx) => {
    if (
      (value.status === "completed" &&
        (!value.observation || !value.nativeCapture)) ||
      (value.status !== "completed" && value.nativeCapture !== undefined) ||
      (value.status !== "progress" &&
        (value.nativeLaunch || value.nativeLifecycle)) ||
      ((value.status === "failed" || value.status === "partial") &&
        value.reason === undefined) ||
      (value.observation &&
        value.observation.complete !== (value.status === "completed"))
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Invalid native v2 result stage/evidence",
      });
    }
    if (
      new TextEncoder().encode(JSON.stringify(value)).byteLength >
      DEFAULT_MAX_INGRESS_FRAME_BYTES
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Native v2 result exceeds the ingress frame quota",
      });
    }
  });

export type ListenerConfigV2 = z.infer<typeof listenerConfigV2Schema>;
export type ListenerControlV2 = z.infer<typeof listenerControlV2Schema>;
export type ListenerReplyV2 = z.infer<typeof listenerReplyV2Schema>;
export type ListenerResultV2 = z.infer<typeof listenerResultV2Schema>;
