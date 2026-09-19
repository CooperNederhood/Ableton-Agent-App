import { z } from "zod";

export const AUTOMATION_PROTOCOL_VERSION = 1 as const;
export const AUTOMATION_HOST = "127.0.0.1" as const;
export const MAX_AUTOMATION_MESSAGE_CHARACTERS = 16_000;
export const MAX_AUTOMATION_FRAME_BYTES = 32 * 1024;
export const DEFAULT_AUTOMATION_REQUEST_TIMEOUT_MS = 5_000;

export const automationTraceSchema = z
  .object({
    traceId: z.string().uuid(),
    spanId: z.string().uuid(),
    correlationId: z.string().uuid(),
    causationId: z.string().uuid().optional(),
  })
  .strict();
export type AutomationTrace = z.infer<typeof automationTraceSchema>;

export const automationDiscoveryDescriptorSchema = z
  .object({
    version: z.literal(AUTOMATION_PROTOCOL_VERSION),
    host: z.literal(AUTOMATION_HOST),
    port: z.number().int().min(1).max(65_535),
    secretPath: z.string().min(1),
    processId: z.number().int().positive(),
    startedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type AutomationDiscoveryDescriptor = z.infer<
  typeof automationDiscoveryDescriptorSchema
>;

export const sendUserMessageRequestSchema = z
  .object({
    version: z.literal(AUTOMATION_PROTOCOL_VERSION),
    id: z.string().uuid(),
    secret: z.string().min(64).max(256),
    method: z.literal("send_user_message"),
    trace: automationTraceSchema,
    params: z
      .object({
        message: z
          .string()
          .trim()
          .min(1)
          .max(MAX_AUTOMATION_MESSAGE_CHARACTERS),
      })
      .strict(),
  })
  .strict();
export type SendUserMessageRequest = z.infer<
  typeof sendUserMessageRequestSchema
>;

export const automationErrorCodeSchema = z.enum([
  "invalid_request",
  "unauthorized",
  "busy",
  "unavailable",
  "timeout",
  "internal_error",
]);
export type AutomationErrorCode = z.infer<typeof automationErrorCodeSchema>;

export const automationResponseSchema = z.discriminatedUnion("ok", [
  z
    .object({
      version: z.literal(AUTOMATION_PROTOCOL_VERSION),
      id: z.string().uuid(),
      ok: z.literal(true),
      result: z
        .object({
          accepted: z.literal(true),
          messageId: z.string().uuid(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      version: z.literal(AUTOMATION_PROTOCOL_VERSION),
      id: z.string().uuid(),
      ok: z.literal(false),
      error: z
        .object({
          code: automationErrorCodeSchema,
          message: z.string().min(1).max(512),
        })
        .strict(),
    })
    .strict(),
]);
export type AutomationResponse = z.infer<typeof automationResponseSchema>;

export interface AutomationLifecycleEvent {
  readonly stage: "queued" | "started" | "completed" | "failed" | "cancelled";
  readonly requestId: string;
  readonly trace: AutomationTrace;
  readonly messageCharacters: number;
  readonly messageId?: string;
  readonly errorCode?: AutomationErrorCode;
  readonly durationMs?: number;
}
