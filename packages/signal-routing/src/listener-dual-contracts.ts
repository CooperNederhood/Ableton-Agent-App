import { z } from "zod";
import { listenerNativeDualStatusSchema } from "@ableton-agent/protocol";
import {
  listenerRegistrationV2Schema,
  listenerControlV2Schema,
  listenerReplyV2Schema,
  listenerResultV2Schema,
} from "./listener-v2-contracts.js";
import {
  listenerControlSessionSchema,
  listenerReplySessionSchema,
  listenerResultSessionSchema,
} from "./listener-session-contracts.js";
import { listenerPathsHaveSameOwner } from "./listener-contracts.js";
import { DEFAULT_MAX_INGRESS_FRAME_BYTES } from "./contracts.js";

export const LISTENER_CAPABILITY_DUAL = "audio-listener/dual-mode-v1" as const;
export const listenerRegistrationDualSchema = z
  .strictObject({
    ...listenerRegistrationV2Schema.shape,
    version: z.literal(4),
    capabilities: z.tuple([z.literal(LISTENER_CAPABILITY_DUAL)]),
    nativeStatus: listenerNativeDualStatusSchema,
  })
  .refine(listenerPathsHaveSameOwner, "Listener paths require the same owner")
  .refine(
    (v) =>
      v.nativeStatus.readiness !== "READY" ||
      (v.nativeStatus.acceptedSampleRates.some(
        (rate) => rate === v.sampleRate,
      ) &&
        v.nativeStatus.acceptedVectorSizes.includes(v.vectorSize)),
    "Unsupported ready DSP geometry",
  );

// Revalidate the exact mode-specific contract, without converting its proof.
// The only wire change is an explicit mode and version; ABI2 is unchanged.
function validateLegacy(
  schema: z.ZodType,
  version: 2 | 3,
  value: Record<string, unknown>,
  ctx: z.RefinementCtx,
) {
  const { mode: _mode, ...body } = value;
  void _mode;
  const parsed = schema.safeParse({ ...body, listenerVersion: version });
  if (
    new TextEncoder().encode(JSON.stringify(value)).byteLength >
    DEFAULT_MAX_INGRESS_FRAME_BYTES
  )
    ctx.addIssue({
      code: "custom",
      message: "Dual-mode message exceeds ingress frame quota",
    });
  if (!parsed.success)
    for (const issue of parsed.error.issues)
      ctx.addIssue({
        code: "custom",
        message: issue.message,
        path: issue.path,
      });
}

export const listenerControlDualSchema = z.discriminatedUnion("mode", [
  z
    .strictObject({
      ...listenerControlV2Schema.shape,
      listenerVersion: z.literal(4),
      mode: z.literal("arrangement"),
    })
    .superRefine((v, ctx) =>
      validateLegacy(listenerControlV2Schema, 2, v, ctx),
    ),
  z
    .strictObject({
      ...listenerControlSessionSchema.shape,
      listenerVersion: z.literal(4),
      mode: z.literal("session"),
    })
    .superRefine((v, ctx) =>
      validateLegacy(listenerControlSessionSchema, 3, v, ctx),
    ),
]);
export const listenerReplyDualSchema = z.discriminatedUnion("mode", [
  z
    .strictObject({
      ...listenerReplyV2Schema.shape,
      listenerVersion: z.literal(4),
      mode: z.literal("arrangement"),
    })
    .superRefine((v, ctx) => validateLegacy(listenerReplyV2Schema, 2, v, ctx)),
  z
    .strictObject({
      ...listenerReplySessionSchema.shape,
      listenerVersion: z.literal(4),
      mode: z.literal("session"),
    })
    .superRefine((v, ctx) =>
      validateLegacy(listenerReplySessionSchema, 3, v, ctx),
    ),
]);
export const listenerResultDualSchema = z.discriminatedUnion("mode", [
  z
    .strictObject({
      ...listenerResultV2Schema.shape,
      listenerVersion: z.literal(4),
      mode: z.literal("arrangement"),
    })
    .superRefine((v, ctx) => validateLegacy(listenerResultV2Schema, 2, v, ctx)),
  z
    .strictObject({
      ...listenerResultSessionSchema.shape,
      listenerVersion: z.literal(4),
      mode: z.literal("session"),
    })
    .superRefine((v, ctx) =>
      validateLegacy(listenerResultSessionSchema, 3, v, ctx),
    ),
]);
export type ListenerControlDual = z.infer<typeof listenerControlDualSchema>;
export type ListenerReplyDual = z.infer<typeof listenerReplyDualSchema>;
export type ListenerResultDual = z.infer<typeof listenerResultDualSchema>;
