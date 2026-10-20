import {
  defineTool,
  type Tool,
  type ToolInvocation,
} from "@github/copilot-sdk";
import {
  audioObservationKindSchema,
  storedAudioObservationSchema,
  clipLocationSchema,
} from "@ableton-agent/protocol";
import { z } from "zod";

const id = z.string().min(1).max(256);
const listenerIds = z
  .array(id)
  .min(1)
  .max(8)
  .refine((values) => new Set(values).size === values.length, {
    message: "Listener IDs must be distinct",
  });
const passTarget = { passId: id };
const cursor = z.string().min(1).max(2048);
const page = {
  cursor: cursor.optional(),
  limit: z.number().int().min(1).max(100).default(20),
};

export const LISTENING_AGENT_GUIDANCE =
  "Use only actions present in your scoped schema. For Arrangement capture, play-arrangement-and-listen requires listenerIds, startBeat and endBeat: use the absolute endBeat, not durationBeats; durationBeats is Session-only. Queued or arming is not completion or failure. Use get-pass with the returned passId to inspect that same pass until terminal, respecting any explicit per-request polling limit. Never start another playback call to wait for the first. Never use bash or sleep to wait. Only after stage=completed, read its returned contextId with ableton_context: a known contextId goes to get, not list. Report failed, cancelled or interrupted passes honestly; do not describe queued acceptance as measured audio. An explicit user instruction to stop on any failure also covers argument-validation and permission failures: report and stop instead of correcting arguments, repairing or retrying. retryable describes technical recoverability, not permission to retry.";

export const listeningOperationParamsSchema = z.discriminatedUnion("action", [
  z
    .object({ action: z.literal("inspect-listeners") })
    .strict()
    .describe(
      "Discover listeners. Supply only action; no listenerIds or passId.",
    ),
  z
    .object({
      action: z.literal("play-session-and-listen"),
      target: clipLocationSchema.options[0],
      listenerIds,
      durationBeats: z.number().finite().positive().max(256).default(16),
      maximumDurationMs: z.number().int().min(1).max(300_000).default(300_000),
    })
    .strict(),
  z
    .object({
      action: z.literal("play-arrangement-and-listen"),
      listenerIds,
      startBeat: z
        .number()
        .finite()
        .nonnegative()
        .describe("Absolute zero-based Arrangement starting beat, not bars."),
      endBeat: z
        .number()
        .finite()
        .positive()
        .describe(
          "The absolute ending beat, not a duration; must be greater than startBeat.",
        ),
      maximumDurationMs: z.number().int().min(1).max(300_000).default(300_000),
    })
    .strict()
    .refine((range) => range.endBeat > range.startBeat, {
      message: "Arrangement end must follow its start",
    })
    .describe(
      "Capture the exact Arrangement interval [startBeat, endBeat). durationBeats is not accepted. Returns a queued job, not a completed observation.",
    ),
  z
    .object({ action: z.literal("get-pass"), ...passTarget })
    .strict()
    .describe(
      "Inspect one existing pass using its returned passId; queued/arming/capturing is nonterminal. This does not create another capture.",
    ),
  z.object({ action: z.literal("list-passes"), ...page }).strict(),
  z.object({ action: z.literal("cancel"), ...passTarget }).strict(),
]);

export const listeningJobSchema = z
  .object({
    passId: id,
    stage: z.enum([
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
    ]),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    durationMs: z.number().finite().nonnegative(),
    contextIds: z.array(id).max(8),
    cleanupPolicy: z.enum(["stop-owned", "leave-running"]).optional(),
    error: z.string().max(2048).optional(),
  })
  .strict();

export const listenerViewSchema = z
  .object({
    listenerId: id,
    instanceId: id,
    trackReference: id,
    deviceReference: id,
    displayName: z.string().max(128),
    ready: z.boolean(),
    limitations: z.array(z.string().max(512)).max(16),
  })
  .strict();

export const listeningOperationResultSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("inspect-listeners"),
      listeners: z.array(listenerViewSchema).max(256),
      truncated: z.boolean(),
    })
    .strict(),
  ...(
    [
      "play-session-and-listen",
      "play-arrangement-and-listen",
      "get-pass",
      "cancel",
    ] as const
  ).map((action) =>
    z.object({ action: z.literal(action), job: listeningJobSchema }).strict(),
  ),
  z
    .object({
      action: z.literal("list-passes"),
      jobs: z.array(listeningJobSchema).max(100),
      nextCursor: cursor.optional(),
    })
    .strict(),
]);

export const contextOperationParamsSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("list"),
      subjectId: id.optional(),
      listenerId: id.optional(),
      passId: id.optional(),
      includeHistorical: z.boolean().default(false),
      ...page,
    })
    .strict()
    .describe(
      "Discover context summaries by optional subjectId, listenerId or passId. Does not accept contextId; use get when the contextId is known.",
    ),
  z
    .object({
      action: z.literal("get"),
      contextId: id,
      includeHistorical: z.boolean().default(false),
    })
    .strict()
    .describe(
      "Read one known contextId, including an ID returned by a completed listening job. No preceding list is needed. Set includeHistorical=true to retrieve historical evidence.",
    ),
  z
    .object({
      action: z.literal("prune"),
      contextIds: z
        .array(id)
        .min(1)
        .max(100)
        .refine((ids) => new Set(ids).size === ids.length),
      confirm: z.literal("prune-session-context"),
    })
    .strict(),
]);

const contextSummarySchema = z
  .object({
    contextId: id,
    passId: id,
    listenerId: id,
    subjectId: id,
    kind: audioObservationKindSchema,
    createdAt: z.string().datetime(),
    freshness: z.enum([
      "fresh",
      "stale",
      "unknown",
      "unresolved",
      "historical",
    ]),
    summary: z.string().max(2048),
  })
  .strict();

export const contextOperationResultSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("list"),
      entries: z.array(contextSummarySchema).max(100),
      nextCursor: cursor.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("get"),
      entry: contextSummarySchema,
      observation: storedAudioObservationSchema,
    })
    .strict()
    .refine(
      (value) => value.entry.kind === value.observation.schema,
      "Context detail kind must match its observation schema",
    ),
  z
    .object({
      action: z.literal("prune"),
      prunedContextIds: z.array(id).max(100),
    })
    .strict(),
]);

export type ListeningOperationParams = z.infer<
  typeof listeningOperationParamsSchema
>;
export type ListeningOperationResult = z.infer<
  typeof listeningOperationResultSchema
>;
export type ContextOperationParams = z.infer<
  typeof contextOperationParamsSchema
>;
export type ContextOperationResult = z.infer<
  typeof contextOperationResultSchema
>;

export interface ListeningToolServices {
  executeListeningOperation(
    params: ListeningOperationParams,
    invocation: ToolInvocation,
  ): Promise<ListeningOperationResult>;
  executeContextOperation(
    params: ContextOperationParams,
    invocation: ToolInvocation,
  ): Promise<ContextOperationResult>;
}

export function createListeningTools(
  services: ListeningToolServices,
): [Tool<ListeningOperationParams>, Tool<ContextOperationParams>] {
  return [
    defineTool("ableton_listening", {
      description: `${LISTENING_AGENT_GUIDANCE} Discover exact audio listeners and explicitly play an Arrangement range while capturing bounded measurements. Requires stopped transport and verified recording off; never solos/mutes tracks or changes effects. A listener with limitation native_per_pass_validation_required may attempt fresh native validation even while ready=false. Descriptive v2 supports nonzero/fractional Arrangement starts, constant tempo, 44.1/48 kHz and one approximately 100 ms reporting hop through 30 seconds, using supported actual DSP metadata. Tempo stability is assumed, not independently verified; tempo automation is unsupported. Do not change tempo during a pass; a completed result is not proof that no change occurred. Existing detected tempo, timing and integrity failures still reject a pass. The App positions and independently reads back the stopped insert marker/position before native arm. Timing policy is frozen from trusted Settings once per pass, not selected by this tool; the configured budget bounds observed disagreement, not absolute accuracy. Approximate results are descriptive-only, with unknown absolute timing error and no exclusive clip attribution. There is no automatic legacy fallback: the old beat-zero/120 BPM/48 kHz prototype requires explicitly configured strict mode and its matching existing marker/0.2-beat grid through beat 20. Scope metadata is not readiness or timing proof: genuine per-pass arm proof is required before playback, measured launch and complete coverage before publication. Other uncommissioned listeners remain denied. Playback continues after completion, cancellation, failure, or timeout: cancel stops capture, not transport. Session listening is unsupported until quantized source onset is verified. Passes are owned by the active App session/agent; cancel only owned passes. Master/return measurements are mixes, not isolated clip facts. Read status and cleanupPolicy before treating a pass as completed; results persist only after verified context publication.`,
      parameters: listeningOperationParamsSchema,
      handler: async (params, invocation) => {
        const result = listeningOperationResultSchema.parse(
          await services.executeListeningOperation(params, invocation),
        );
        if (result.action !== params.action)
          throw new Error("Listening result action mismatch");
        return result;
      },
    }),
    defineTool("ableton_context", {
      description:
        "Query typed listening context owned by the active App session. When a contextId is already known, use get with that exact contextId; no preceding list is needed. Use list only to discover unknown IDs by optional subjectId, listenerId or passId; list does not accept contextId. Current-only reads revalidate identity/freshness; explicitly include historical entries to inspect stale or unresolved evidence. RMS dBFS is not LUFS; attacks and attribution can be uncertain. Pruning deletes only explicitly named App-session context, requires approval and confirm='prune-session-context', and never deletes Live clips or source audio. No arbitrary SQL, filesystem paths, raw audio, or generic context writes.",
      parameters: contextOperationParamsSchema,
      handler: async (params, invocation) => {
        const result = contextOperationResultSchema.parse(
          await services.executeContextOperation(params, invocation),
        );
        if (result.action !== params.action)
          throw new Error("Context result action mismatch");
        return result;
      },
    }),
  ];
}
