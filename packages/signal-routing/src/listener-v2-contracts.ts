import { z } from "zod";
import {
  audioObservationV2Schema,
  nativeArmProofV2Schema,
  nativeCaptureProofV2Schema,
  nativeLaunchProofV2Schema,
  nativeListenerLifecycleV2Schema,
  nativeListeningGeometrySchema,
  listenerNativeStatusV2Schema,
  listeningTimingPolicySchema,
} from "@ableton-agent/protocol";
import {
  listenerControlSchema,
  listenerControlInputSchema,
  listenerConfigSchema,
  listenerPathsHaveSameOwner,
  listenerRegistrationSchema,
  type ListenerReply,
  type ListenerResult,
} from "./listener-contracts.js";
import { DEFAULT_MAX_INGRESS_FRAME_BYTES } from "./contracts.js";

export const LISTENER_VERSION_V2 = 2 as const;
export const LISTENER_CAPABILITY_V2 = "audio-listener/v2" as const;

export { listenerNativeStatusV2Schema };

const diagnosticNumber = z.number().finite();
export const nativeFailureDiagnosticV2Schema = z.strictObject({
  scope: z.literal("native-spectrum-rejection/v1"),
  generation: z
    .string()
    .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
  check: z.enum([
    "end",
    "start",
    "frame",
    "centroid",
    "energy",
    "silence_centroid",
    "invalid_frames",
    "bracket",
  ]),
  packet: z.tuple([
    diagnosticNumber,
    diagnosticNumber,
    diagnosticNumber,
    diagnosticNumber,
    diagnosticNumber,
    diagnosticNumber,
  ]),
  fftDiagnostics: z
    .tuple([
      diagnosticNumber,
      diagnosticNumber,
      diagnosticNumber,
      diagnosticNumber,
      diagnosticNumber,
    ])
    .nullable(),
  metadata: z.strictObject({
    dsp: z
      .tuple([diagnosticNumber, diagnosticNumber, diagnosticNumber])
      .nullable(),
    fftInfo: z
      .tuple([
        diagnosticNumber,
        diagnosticNumber,
        diagnosticNumber,
        diagnosticNumber,
      ])
      .nullable(),
    clockAbi: diagnosticNumber.nullable(),
    envelopeAbi: diagnosticNumber.nullable(),
    spectrumAbi: diagnosticNumber.nullable(),
  }),
});
export type NativeFailureDiagnosticV2 = z.infer<
  typeof nativeFailureDiagnosticV2Schema
>;

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
export const versionedListenerControlInputSchema = z
  .strictObject({
    ...listenerControlInputSchema.shape,
    config: z.union([listenerConfigSchema, listenerConfigV2Schema]).optional(),
  })
  .refine(
    (value) => value.action !== "prepare" || value.config !== undefined,
    "Prepare requires capture bounds",
  );

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
    nativeFailureDiagnostic: nativeFailureDiagnosticV2Schema.optional(),
  })
  .refine(
    (value) => (value.status === "armed") === (value.nativeArm !== undefined),
    {
      message: "An armed v2 reply requires its fresh native arm proof",
    },
  )
  .refine((value) => value.status !== "failed" || value.reason !== undefined, {
    message: "Failed v2 replies require a reason",
  })
  .refine(
    (value) =>
      value.nativeFailureDiagnostic === undefined || value.status === "failed",
    {
      message: "Native failure diagnostics are not capture authority",
    },
  );

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
    nativeFailureDiagnostic: nativeFailureDiagnosticV2Schema.optional(),
  })
  .superRefine((value, ctx) => {
    if (
      (value.status === "completed" &&
        (!value.observation || !value.nativeCapture)) ||
      (value.status !== "completed" && value.nativeCapture !== undefined) ||
      (value.status !== "progress" &&
        (value.nativeLaunch || value.nativeLifecycle)) ||
      (value.nativeFailureDiagnostic !== undefined &&
        value.status !== "failed") ||
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
export type ListenerRegistrationV2 = z.infer<
  typeof listenerRegistrationV2Schema
>;
export type VersionedListenerControlInput = z.infer<
  typeof versionedListenerControlInputSchema
>;
export type ListenerControlV2 = z.infer<typeof listenerControlV2Schema>;
export type ListenerReplyV2 = z.infer<typeof listenerReplyV2Schema>;
export type ListenerResultV2 = z.infer<typeof listenerResultV2Schema>;
export type VersionedListenerControl =
  z.infer<typeof listenerControlSchema> | ListenerControlV2;
export type VersionedListenerReply = ListenerReply | ListenerReplyV2;
export type VersionedListenerResult = ListenerResult | ListenerResultV2;
