import { z } from "zod";
import { audioObservationSchema } from "@ableton-agent/protocol";
import type { ContextOperationResult } from "@ableton-agent/tools";

const id = z.string().min(1).max(200);
export const desktopContextTraceSchema = z.strictObject({
  traceId: z.string().uuid(),
  correlationId: z.string().uuid(),
  causationId: z.string().uuid(),
});
export const desktopContextListRequestSchema = z.strictObject({
  sessionId: id,
  subjectId: id.optional(),
  listenerId: id.optional(),
  passId: id.optional(),
  includeHistorical: z.boolean().default(false),
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.number().int().min(1).max(100).default(20),
  trace: desktopContextTraceSchema.optional(),
});
export const desktopContextGetRequestSchema = z.strictObject({
  sessionId: id,
  contextId: id,
  includeHistorical: z.boolean().default(false),
  trace: desktopContextTraceSchema.optional(),
});

type ContextSummary = Extract<
  ContextOperationResult,
  { action: "list" }
>["entries"][number];
export const desktopContextSummarySchema: z.ZodType<ContextSummary> =
  z.strictObject({
    contextId: id,
    passId: id,
    listenerId: id,
    subjectId: id,
    kind: z.literal("audio-observation/v1"),
    createdAt: z.string().datetime(),
    freshness: z.enum([
      "fresh",
      "stale",
      "unknown",
      "unresolved",
      "historical",
    ]),
    summary: z.string().max(2048),
  });
export const desktopContextPageSchema: z.ZodType<
  Extract<ContextOperationResult, { action: "list" }>
> = z.strictObject({
  action: z.literal("list"),
  entries: z.array(desktopContextSummarySchema).max(100),
  nextCursor: z.string().min(1).max(2048).optional(),
});
export const desktopContextDetailSchema: z.ZodType<
  Extract<ContextOperationResult, { action: "get" }>
> = z.strictObject({
  action: z.literal("get"),
  entry: desktopContextSummarySchema,
  observation: audioObservationSchema,
});

export type DesktopContextListRequest = z.input<
  typeof desktopContextListRequestSchema
>;
export type DesktopContextGetRequest = z.input<
  typeof desktopContextGetRequestSchema
>;
export type DesktopContextPage = z.infer<typeof desktopContextPageSchema>;
export type DesktopContextDetail = z.infer<typeof desktopContextDetailSchema>;
export interface DesktopEntityContextApi {
  list(request: DesktopContextListRequest): Promise<DesktopContextPage>;
  get(request: DesktopContextGetRequest): Promise<DesktopContextDetail>;
}
