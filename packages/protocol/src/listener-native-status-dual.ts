import { z } from "zod";
import { listenerNativeStatusV2Schema } from "./listener-native-status-v2.js";

export const LISTENER_DUAL_SCOPE = "mode-negotiated-transport/v1" as const;
export const LISTENER_CAPABILITY_DUAL = "audio-listener/dual-mode-v1" as const;
export const LISTENER_CAPABILITY_RETENTION =
  "audio-listener/retention-v1" as const;
export const listenerDualCapabilitiesSchema = z.union([
  z.tuple([z.literal(LISTENER_CAPABILITY_DUAL)]),
  z.tuple([
    z.literal(LISTENER_CAPABILITY_DUAL),
    z.literal(LISTENER_CAPABILITY_RETENTION),
  ]),
]);
export const listenerNativeDualStatusSchema = z
  .strictObject({
    ...listenerNativeStatusV2Schema.shape,
    version: z.literal(4),
    scope: z.literal(LISTENER_DUAL_SCOPE),
    supportedModes: z.tuple([z.literal("arrangement"), z.literal("session")]),
  })
  .refine(
    (v) => v.readiness !== "BLOCKED" || v.reason !== undefined,
    "Blocked native readiness requires a reason",
  );
export type ListenerNativeDualStatus = z.infer<
  typeof listenerNativeDualStatusSchema
>;
