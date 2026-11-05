import {
  defineTool,
  type Tool,
  type ToolInvocation,
} from "@github/copilot-sdk";
import {
  audioObservationKindSchema,
  storedAudioObservationSchema,
  clipLocationSchema,
  sessionListeningJobDetailSchema,
  listeningFailureEvidenceSchema,
  metricListeningResultSummariesSchema,
  validateMetricListeningJobOutcome,
  metricListeningReportSchema,
  MAX_METRIC_REPORT_PAGE_ROWS,
} from "@ableton-agent/protocol";
import { z } from "zod";

const id = z.string().min(1).max(256);
export const MAX_METRIC_CONTEXT_RESPONSE_BYTES = 64 * 1024;
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

const SESSION_LAUNCH_CASE_GUIDANCE =
  "Requires stopped transport at a nonnegative position, global None or One Bar, and clip Global or One Bar quantization. This includes remembered active clips while transport is stopped; moving transport is unsupported. Never seek or change launch settings to make a request pass.";

const FAILURE_EVIDENCE_GUIDANCE =
  "inspect-listeners ready:false with native_per_pass_validation_required means fresh validation is required for each capture, not a permanent commissioning failure and not evidence of an identity mismatch or broken listener. An already completed pass can have validated native proof while discovery still reports ready:false. An empty discovery list is not proof that devices were removed or disabled. An error code alone is not a precise cause: report failureEvidence's observed phase/check, actual versus expected values, coverage and diagnostic reference. Partial or unavailable evidence is an observability gap, not proof of a native predicate. Never invent an identity mismatch, automatically retry, edit settings or fall back to another mode to diagnose a rejection.";

const ALIGNMENT_EVIDENCE_GUIDANCE =
  "Timing policy is frozen per pass. maxClockDisagreementSamples is an enforced admission limit only in strict mode. Descriptive mode can accept disagreement above that advisory target; disclose the observed clock and beat/phase disagreement separately, along with unknown absolute accuracy. Completion is not proof that observed disagreement is within the configured target. Maximum observed beat disagreement includes transport/phase observations around startup and is not a uniform audio delay or a proven shift of every report row. Do not discard timing witnesses or reinterpret a warning as measured latency.";

const RHYTHM_EVIDENCE_GUIDANCE =
  "For descriptive quarter-note beat placement, integer zero-based beat positions are on-beats; n+0.5 positions are offbeats. Human beat labels 1,2,3,4 correspond to zero-based positions 0,1,2,3, not rounded fractional positions. Do not round fractional detector-window endpoints onto integer beats; corroborate placement with native support and level-row intervals. If those intervals cannot establish phase, describe the uncertainty instead of claiming on-beat or offbeat placement. Convert samples using the report's actual sampleRate and tempoBpm: samples per beat = sampleRate * 60 / tempoBpm. Do not assume 120 BPM or treat quantized detector-end spacing as precise inter-onset timing.";

const FLATNESS_SMOKE_GUIDANCE =
  "The candidate also emits spectral-flatness, spectral-spread and spectral-rolloff smoke diagnostics during ordinary listening, sharing the same stereo SpectralShape analyzers. A request including flatness, spread or rolloff uses the same scoped listening action, not an extra capture or invented requestedMetrics argument. These diagnostics are available through typed Desktop History, not the metric context/report. Flatness uses stereo dB values; spread and rolloff use independent-channel nonnegative Hz values with magnitude mode and linear frequency configured. Rolloff is explicitly configured at 95 percent; this setting is not numerical qualification of its cumulative weighting or threshold. All have unqualified frame support and silence validity; do not invent flatness report values, spread report values or rolloff report values, claim complete descriptor coverage, or treat the smoke as numerical qualification. Delivery counts are not FFT frame counts. Spectral breadth is not physical filter bandwidth or source count, and flatness does not identify a noise source. Rolloff describes upper spectral extent, not an actual synth/filter cutoff or an automatic EQ prescription.";

const LISTENING_WORKFLOW_GUIDANCE = `Use only actions present in your scoped schema. For Arrangement capture, play-arrangement-and-listen requires listenerIds, startBeat and endBeat: use the absolute endBeat, not durationBeats; durationBeats is Session-only. Arrangement capture is not read-only: on a successful pass the App positions stopped transport and starts playback, leaving it running. Report verified transport changes, not unchanged transport/seek state. For Session capture, play-session-and-listen explicitly fires one exact MIDI or warped-audio clip through one same-track native listener supporting explicit Session mode (wire5). The canonical wire5 Development listener collects independent level, spectral-centroid and attack timelines during one playback in explicit Arrangement or Session mode, then assembles a tempo-aligned report. A locally unavailable analyzer does not block healthy metrics; shared source, clock and ownership failures or unconfirmed cleanup still prevent publication. Omit durationBeats to capture exactly one active loop (not the underlying audio file), or the active start/end region for a nonlooping clip. Specify durationBeats only for an explicitly requested shorter range; equality with the active end is supported. Requests exceeding thirty seconds are rejected, never truncated. Independently negotiated metric results use their declared musical reporting and native acquisition budgets, not a universal 300-row assumption. ${SESSION_LAUNCH_CASE_GUIDANCE} Do not substitute Arrangement capture or edit launch/source settings to make it pass. Session cancellation does not retract an accepted or queued launch; playback stays running and other selected Session material can resume. The Session timeout includes setup and launch. Source continuity is message-rate monitored, not sample-accurate; unknown follow-action settings are not disabled, and listener audio is not exclusively attributable to the clip. For arrangement_session_override, explain that Live's Back to Arrangement restores the playback source, not the view. Switching views, stopping playback or deselecting a clip does not clear this override. Ask the user to restore Arrangement manually, then make a new explicit request; never repair source selection or retry automatically. Both listening start calls wait for terminal capture, publication and cleanup before returning the owned job. No get-pass polling is needed to wait for a start call. Use get-pass only for explicit inspection of an existing pass with its exact returned passId. Queued or arming is not completion or failure. Never start another playback call to wait for the first. Never use bash or sleep to wait. After stage=completed or stage=partial, read the returned contextIds with ableton_context before answering: a known contextId goes to get or report, not list. A partial pass is a published result with usable metrics and explicit missing coverage, not full success or a failed tool. Read metricResults and the stored context; disclose missing metrics and intervals. Valid measured silence and empty attack lists are evidence, not missing data. Do not invent frequency or rhythm conclusions from absent measurements, infer exact whole-row FFT support, or retry automatically to fill gaps. Report failed, cancelled or interrupted passes honestly; do not describe queued acceptance as measured audio. An explicit user instruction to stop on any failure also covers argument-validation and permission failures: report and stop instead of correcting arguments, repairing or retrying. retryable describes technical recoverability, not permission to retry.`;

export const LISTENING_AGENT_GUIDANCE = `${LISTENING_WORKFLOW_GUIDANCE} Wire5 report geometry supports nonzero/fractional Arrangement starts; physical qualification of a particular range remains separate. For a known metric-audio-observation/v1 context, use ableton_context report for stacked musical-row values, availability, gaps and actual native support without joining raw indices. Start offset=0 and limit=8 (maximum 32); follow report.nextOffset until null. Consult metricMetadata.algorithm.units: metric peak/RMS values are linear amplitudes, not dBFS; attack strength is dB-rise and its timestamp is the detector-window end, not a precise onset. Partial attack coverage cannot establish absence of attacks over the whole clip. Reports do not authorize new capture or convert legacy data. ${FLATNESS_SMOKE_GUIDANCE} ${RHYTHM_EVIDENCE_GUIDANCE} ${ALIGNMENT_EVIDENCE_GUIDANCE} ${FAILURE_EVIDENCE_GUIDANCE}`;

export const listeningOperationParamsSchema = z.discriminatedUnion("action", [
  z
    .object({ action: z.literal("inspect-listeners") })
    .strict()
    .describe(
      `Discover listeners. Supply only action; no listenerIds or passId. ${FAILURE_EVIDENCE_GUIDANCE}`,
    ),
  z
    .object({
      action: z.literal("play-session-and-listen"),
      target: clipLocationSchema.options[0],
      listenerIds: listenerIds.refine((values) => values.length === 1, {
        message: "Session listening requires one same-track listener",
      }),
      durationBeats: z
        .number()
        .finite()
        .positive()
        .optional()
        .describe(
          "Omit to capture exactly one active loop, or the active nonlooping start/end region. An explicit duration may be shorter, never longer. Ranges exceeding thirty seconds or the declared musical reporting, native acquisition and encoded-byte budgets are rejected, not truncated.",
        ),
      maximumDurationMs: z.number().int().min(1).max(300_000).default(300_000),
    })
    .strict()
    .describe(
      `Explicitly launch one exact Session MIDI or warped-audio clip through one same-track native listener supporting explicit Session mode (wire5). Omitted duration captures one active loop or the nonlooping active start/end region; explicit shorter ranges and equality at the active end are supported. The declared thirty-second ceiling and musical, acquisition and encoded-byte budgets are mandatory; oversized ranges fail without truncation. ${SESSION_LAUNCH_CASE_GUIDANCE} Requires recording off, zero offsets and Trigger/legato off. Normal wrap or natural end after coverage requires both monitored source-boundary and completed native DSP evidence, never queued acceptance. Cancellation never retracts an accepted launch or stops transport.`,
    ),
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
      "partial",
      "failed",
      "cancelled",
      "interrupted",
    ]),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    durationMs: z.number().finite().nonnegative(),
    contextIds: z.array(id).max(8),
    metricResults: metricListeningResultSummariesSchema.optional(),
    cleanupPolicy: z.enum(["stop-owned", "leave-running"]).optional(),
    session: sessionListeningJobDetailSchema.optional(),
    error: z.string().max(2048).optional(),
    failureEvidence: listeningFailureEvidenceSchema.optional(),
  })
  .strict()
  .superRefine(validateMetricListeningJobOutcome)
  .refine(
    (job) =>
      job.failureEvidence === undefined ||
      job.failureEvidence.reference.passId === job.passId,
    "Failure evidence must belong to this listening pass",
  );

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
      action: z.literal("report"),
      contextId: id,
      includeHistorical: z.boolean().default(false),
      offset: z.number().int().min(0).max(2000).default(0),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_METRIC_REPORT_PAGE_ROWS)
        .default(8),
    })
    .strict()
    .describe(
      "Read a bounded stacked musical timeline for a known metric-audio-observation/v1 contextId, without joining record indices. Start at offset=0; follow report.nextOffset until null. limit defaults to 8, maximum 32. No capture, retry, or legacy conversion.",
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

export const metricListeningContextReportSchema = metricListeningReportSchema;

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
      action: z.literal("report"),
      entry: contextSummarySchema.refine(
        (entry) => entry.kind === "metric-audio-observation/v1",
        "Reports require metric observations",
      ),
      report: metricListeningContextReportSchema,
    })
    .strict()
    .superRefine((value, ctx) => {
      if (
        new TextEncoder().encode(JSON.stringify(value)).byteLength >
        MAX_METRIC_CONTEXT_RESPONSE_BYTES
      ) {
        ctx.addIssue({
          code: "custom",
          message: "Metric context response exceeds 64 KiB UTF-8 budget",
        });
      }
    }),
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
export type ListeningJobView = z.infer<typeof listeningJobSchema>;
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
      description: `${LISTENING_AGENT_GUIDANCE} Discover exact audio listeners and explicitly play an Arrangement range or guarded Session clip while capturing bounded measurements. Requires stopped transport and verified recording off; never solos/mutes tracks or changes effects. A listener with limitation native_per_pass_validation_required may attempt fresh native validation even while ready=false. Wire5 uses a globally anchored quarter-beat report grid with clipped range endpoints, actual FFT support and an independent 100 ms attack-detector cadence, through 30 seconds using supported 44.1/48 kHz DSP metadata. Tempo stability is assumed, not independently verified; tempo automation is unsupported. Do not change tempo during a pass; a completed result is not proof that no change occurred. Existing detected tempo, timing and integrity failures still reject a pass. For Arrangement only, the App positions and independently reads back the stopped insert marker/position before native arm. Timing policy is frozen from trusted Settings once per pass, not selected by this tool; strict mode bounds observed disagreement, not absolute accuracy. Approximate results are descriptive-only, with unknown absolute timing error and no exclusive clip attribution. There is no automatic legacy fallback; current capture requires the negotiated wire5 metric pipeline. Historical contexts keep their declared schemas and do not authorize legacy capture. Scope metadata is not readiness or timing proof: genuine per-pass arm proof is required before playback, measured launch and complete coverage before publication. Unsupported or unbound listeners remain denied. Playback continues after completion, cancellation, failure, or timeout: cancel stops capture, not transport. Session requires a matching native listener supporting explicit Session mode (wire5), zero clip offsets, Trigger/legato off, clip Global or One Bar quantization and the stated stopped-transport launch conditions. It never seeks or changes launch settings. Known-enabled follow actions and unwarped audio are denied; unknown follow-action settings remain explicit and message-rate monitored. Actual clip identity and start_time must match the independently frozen native transport anchor; otherwise no context is published. Passes are owned by the active App session/agent; cancel only owned passes. Master/return measurements are mixes, not isolated clip facts. Read status and cleanupPolicy before treating a pass as completed; results persist only after verified context publication.`,
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
        "Query typed listening context owned by the active App session. When a contextId is already known, use get with that exact contextId; no preceding list is needed. For metric-audio-observation/v1 musical analysis use report with that contextId: it returns measured values, per-metric availability, gaps and actual native supports stacked by musical row, rather than raw index joins. Start offset=0, limit=8 (maximum 32); follow report.nextOffset, stopping at null. A report is a bounded projection, not new evidence or whole-row FFT support; missing/no-frame is not silence. Legacy observations retain get unchanged and cannot be converted into metric reports. Use list only to discover unknown IDs by optional subjectId, listenerId or passId; list does not accept contextId. Current-only reads revalidate identity/freshness; explicitly include historical entries to inspect stale or unresolved evidence. RMS dBFS is not LUFS; attacks and attribution can be uncertain. Pruning deletes only explicitly named App-session context, requires approval and confirm='prune-session-context', and never deletes Live clips or source audio. No arbitrary SQL, filesystem paths, raw audio, or generic context writes.",
      parameters: contextOperationParamsSchema,
      handler: async (params, invocation) => {
        const request = contextOperationParamsSchema.parse(params);
        const result = contextOperationResultSchema.parse(
          await services.executeContextOperation(request, invocation),
        );
        if (result.action !== request.action)
          throw new Error("Context result action mismatch");
        if (
          result.action === "report" &&
          request.action === "report" &&
          (result.entry.contextId !== request.contextId ||
            result.report.offset !== request.offset ||
            result.report.rows.length > request.limit ||
            result.report.pageBudget.requestedRowLimit !== request.limit)
        ) {
          throw new Error("Context report page mismatch");
        }
        return result;
      },
    }),
  ];
}
