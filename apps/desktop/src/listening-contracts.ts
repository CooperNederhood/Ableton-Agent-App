import { z } from "zod";
import { sessionListeningJobDetailSchema } from "@ableton-agent/protocol";

export const desktopListeningTraceSchema = z.strictObject({
  traceId: z.string().uuid(),
  correlationId: z.string().min(1).max(128),
  causationId: z.string().min(1).max(128),
});
export const desktopListeningStageSchema = z.enum([
  "queued",
  "validating",
  "reserving-context",
  "arming",
  "starting-playback",
  "capturing",
  "persisting",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
export const desktopListeningJobSchema = z.strictObject({
  passId: z.string().min(1).max(128),
  sessionId: z.string().min(1).max(256),
  liveSetId: z.string().min(1).max(256),
  agentId: z.string().uuid(),
  trace: desktopListeningTraceSchema,
  stage: desktopListeningStageSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  durationMs: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
  contextIds: z.array(z.string().min(1).max(128)).max(100),
  error: z.string().min(1).max(2048).optional(),
  cleanupPolicy: z.literal("leave-running"),
  evidence: z.literal("lifecycle-only"),
  session: sessionListeningJobDetailSchema.optional(),
});
export const desktopListeningListRequestSchema = z.strictObject({
  sessionId: z.string().min(1).max(256),
  agentId: z.string().uuid(),
  limit: z.number().int().min(1).max(100).default(100),
  trace: desktopListeningTraceSchema.optional(),
});
export const desktopListeningPageSchema = z.strictObject({
  sessionId: z.string().min(1).max(256),
  revision: z.number().int().nonnegative(),
  jobs: z.array(desktopListeningJobSchema).max(100),
});
export type DesktopListeningJob = z.infer<typeof desktopListeningJobSchema>;
export type DesktopListeningPage = z.infer<typeof desktopListeningPageSchema>;
export type DesktopListeningListRequest = z.input<
  typeof desktopListeningListRequestSchema
>;
export interface DesktopListeningCancellationOptions {
  sessionId: string;
  trace?: z.infer<typeof desktopListeningTraceSchema>;
}
export interface DesktopListeningApi {
  list(
    this: void,
    request: DesktopListeningListRequest,
  ): Promise<DesktopListeningPage>;
}
export function listeningTerminal(
  stage: DesktopListeningJob["stage"],
): boolean {
  return ["completed", "failed", "cancelled", "interrupted"].includes(stage);
}
