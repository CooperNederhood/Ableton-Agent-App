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
  listeningFeatureTypeSchema,
  listeningFeatureDefinition,
  isListeningFeatureValueValid,
  listeningFeatureDistanceSchema,
  listeningFeatureDistanceUnitsSchema,
  contextSegmentSchema,
  listeningFeatureDefinitionSchema,
  listeningFeatureComparisonSchema,
} from "@ableton-agent/protocol";
import { z } from "zod";
import {
  contextFeatureMetadataSchema,
  contextFeatureDerivationViewSchema,
  listeningFeaturePageSchema,
  listeningFeaturePageMasksMatch,
  MAX_FEATURE_PAGE_CELLS,
} from "./listening-feature-views.js";
export {
  projectListeningFeatureRecord,
  projectListeningFeaturePage,
  projectListeningFeatureDerivation,
} from "./listening-feature-views.js";

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
  "For flatness, spread and rolloff, read the authoritative spectral-shape timeline and bounded report when present in stored context. A request uses the same scoped listening action, not an extra capture or invented requestedMetrics argument. Read actual frame supports, independent channel states, gaps and unmeasured trailing support. Complete acquisition does not imply defined descriptors: silence, undefined and invalid channels retain unavailable values, not measured zeros. The pinned SpectralShape profile uses magnitude weighting, linear frequency, 20-log flatness in dB, and nonnegative Hz values for spread and rolloff. Rolloff is explicitly configured at 95 percent; the profile documents its qualified cumulative interpolation and excluded Nyquist bin. Spectral breadth is not physical filter bandwidth or source count; rolloff is not an actual synth/filter cutoff or an automatic EQ prescription. Historical smoke diagnostics remain in typed Desktop History and cannot substitute for an absent authoritative timeline. Delivery counts are not FFT frame counts. If the timeline is absent or unavailable, explain that limitation; do not invent flatness report values, spread report values or rolloff report values.";
const MEL_BAND_GUIDANCE =
  "When mel-bands is requested, including by the default metric set, read its available timeline from the typed stored context or ableton_context report, not SpectralShape smoke diagnostics. The optional mel-bands section retains all 24 bands for independent left/right channels, full frame supports, exact gaps, the pinned profile and low/mid and high/mid ratios. Units are uncalibrated linear FFT magnitudes with normalize 0 and scale 0, not power or calibrated energy. Ratios derive from the same retained vectors; report aggregation averages linear vectors before deriving ratios, never averages ratios. Preserve zero-denominator and below-floor unavailable reasons; a valid zero numerator with a healthy denominator is a zero ratio. No-frame and missing support are not measured silence. Read status, retained/expected counts, gaps and unmeasured trailing support before making coverage claims. Never invent absent mel data, trim bands, substitute SpectralShape diagnostics, infer warmth or muddiness, or prescribe EQ from these ratios alone.";
const PITCH_SMOKE_GUIDANCE =
  'For pitch requests, use ableton_context action "report" with the returned contextId, offset 0 and limit 8; read authoritative pitch frames and their paired Hz/confidence when present, not historical monophonic-pitch smoke diagnostics. The independent stereo YinFFT profile retains its nominal 50-2000 Hz search and 2048-sample window/hop/FFT. Requests use the existing scoped listening action without extra arguments or recapture. Accepted-estimate means only that the frozen output/confidence gate passed, not verified pitch or input class. Controlled sine qualification covers the declared profile test cases; a known 2000 Hz sine produces a high-confidence estimate near 1000 Hz that passes the gate despite the octave error. Confidence is an algorithm-specific score, not a calibrated probability; low confidence is not proof of noise. Preserve rejected raw estimates and channel states; 0 Hz is the undefined sentinel, not a measured zero-frequency note, and zero confidence is a legitimate score. Acquisition gaps, undefined estimates and measured silence are distinct. Read native support and explicit unmeasured tails. The short window limits low notes; octave errors and unreliable polyphonic mixtures remain possible. Historical polled diagnostics cannot be promoted into frames. If authoritative pitch is absent or unavailable, report that rather than inventing fields or retrying. Do not search tool-output files or use shell/filesystem commands to find pitch. No transcription, instrument recognition or automatic pitch correction is provided.';

const LISTENING_WORKFLOW_GUIDANCE = `Use only actions present in your scoped schema. For Arrangement capture, play-arrangement-and-listen requires listenerIds, startBeat and endBeat: use the absolute endBeat, not durationBeats; durationBeats is Session-only. Arrangement capture is not read-only: on a successful pass the App positions stopped transport and starts playback, leaving it running. Report verified transport changes, not unchanged transport/seek state. For Session capture, play-session-and-listen explicitly fires one exact MIDI or warped-audio clip through one same-track native listener supporting explicit Session mode (wire5). The canonical wire5 Development listener collects independent level, spectral-centroid and attack timelines during one playback in explicit Arrangement or Session mode, then assembles a tempo-aligned report. A locally unavailable analyzer does not block healthy metrics; shared source, clock and ownership failures or unconfirmed cleanup still prevent publication. Omit durationBeats to capture exactly one active loop (not the underlying audio file), or the active start/end region for a nonlooping clip. Specify durationBeats only for an explicitly requested shorter range; equality with the active end is supported. Requests exceeding thirty seconds are rejected, never truncated. Independently negotiated metric results use their declared musical reporting and native acquisition budgets, not a universal 300-row assumption. ${SESSION_LAUNCH_CASE_GUIDANCE} Do not substitute Arrangement capture or edit launch/source settings to make it pass. Session cancellation does not retract an accepted or queued launch; playback stays running and other selected Session material can resume. The Session timeout includes setup and launch. Source continuity is message-rate monitored, not sample-accurate; unknown follow-action settings are not disabled, and listener audio is not exclusively attributable to the clip. For arrangement_session_override, explain that Live's Back to Arrangement restores the playback source, not the view. Switching views, stopping playback or deselecting a clip does not clear this override. Ask the user to restore Arrangement manually, then make a new explicit request; never repair source selection or retry automatically. Both listening start calls wait for terminal capture, publication and cleanup before returning the owned job. No get-pass polling is needed to wait for a start call. Use get-pass only for explicit inspection of an existing pass with its exact returned passId. Queued or arming is not completion or failure. Never start another playback call to wait for the first. Never use bash or sleep to wait. After stage=completed or stage=partial, read the returned contextIds with ableton_context before answering: for metric-audio-observation/v1 use action "report", offset=0, limit=8, then follow report.nextOffset until null. Use get only for other or small contexts; get-feature is derived evidence and does not replace the original-measurement report. A known contextId does not need list first. A partial pass is a published result with usable metrics and explicit missing coverage, not full success or a failed tool. Read metricResults and the stored context; disclose missing metrics and intervals. Valid measured silence and empty attack lists are evidence, not missing data. Do not invent frequency or rhythm conclusions from absent measurements, infer exact whole-row FFT support, or retry automatically to fill gaps. Report failed, cancelled or interrupted passes honestly; do not describe queued acceptance as measured audio. An explicit user instruction to stop on any failure also covers argument-validation and permission failures: report and stop instead of correcting arguments, repairing or retrying. retryable describes technical recoverability, not permission to retry.`;

const PERSISTED_FEATURE_READ_GUIDANCE =
  "When the user explicitly asks to read or reread persisted features, call get-feature for each requested feature from every requested context in the current operation, including contexts read in earlier turns. Conversation memory or a previous turn's read does not satisfy an explicit persisted reread. Use known featureIds, or discover them with list-features scoped to each contextId; follow value/support page continuations needed for the requested evidence. When the user requests both comparison and search, call compare-features with pairs of leftFeatureId and rightFeatureId, and call search-features separately with featureId and the requested excludeContextIds. A search hit or its distance is not a substitute for the requested pair comparison, even when the hit is the comparison target. Use actual persisted IDs and typed results; report unavailable or failed reads/comparisons honestly rather than filling gaps from memory. These reads do not authorize capture, rederivation or retries.";

export const METRIC_REPORT_PAGE_GUIDANCE =
  "This is one original-measurement report page. Inspect report.nextOffset: if non-null, call ableton_context report again for the same contextId with offset equal to that exact nextOffset, not offset + limit. Byte limits can return fewer rows than the requested limit. Follow every continuation until nextOffset is null. A request to reread or verify stored analyzer evidence requires fresh complete pages for each requested context, including after restart; earlier-turn pages cannot establish that the evidence remains available and unchanged. Complete these reads even if feature values were read first. Global acquisition metadata and feature values do not replace unread frame validity.";

export const FEATURE_VALUE_DETAIL_GUIDANCE =
  "list-features, compare-features and search-features return metadata and distances, not feature value arrays. valueCount is a count, not values; distance is not either input vector. If the user requested values or persisted rereads, use get-feature for each requested featureId in this operation before reporting values; read page.values and needed continuations, not memory or original report rows. Preserve null/unavailable reasons. Comparison/search alone does not require these extra reads.";

export const LISTENING_AGENT_GUIDANCE = `${LISTENING_WORKFLOW_GUIDANCE} ${PERSISTED_FEATURE_READ_GUIDANCE} Wire5 report geometry supports nonzero/fractional Arrangement starts; physical qualification of a particular range remains separate. For a known metric-audio-observation/v1 context, use ableton_context report for stacked musical-row values, availability, gaps and actual native support without joining raw indices. Start offset=0 and limit=8 (maximum 32); follow report.nextOffset until null. Consult metricMetadata.algorithm.units for native level/centroid/attacks and metricMetadata["mel-bands"].profile for mel: metric peak/RMS values are linear amplitudes, not dBFS; attack strength is dB-rise and its timestamp is the detector-window end, not a precise onset. Partial attack coverage cannot establish absence of attacks over the whole clip. Reports do not authorize new capture or convert legacy data. ${MEL_BAND_GUIDANCE} ${FLATNESS_SMOKE_GUIDANCE} ${PITCH_SMOKE_GUIDANCE} ${RHYTHM_EVIDENCE_GUIDANCE} ${ALIGNMENT_EVIDENCE_GUIDANCE} ${FAILURE_EVIDENCE_GUIDANCE}`;

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
  z.strictObject({ action: z.literal("feature-definitions") }),
  z
    .strictObject({
      action: z.literal("derive-features"),
      contextIds: z
        .array(id)
        .min(1)
        .max(8)
        .refine((ids) => new Set(ids).size === ids.length),
      includeHistorical: z.boolean().default(false),
    })
    .describe(
      "Persist derived features for explicit stored observations. App-session data mutation only; never captures audio or changes Live. Unsupported sources return unavailable.",
    ),
  z
    .strictObject({
      action: z.literal("list-features"),
      contextId: id.optional(),
      featureType: listeningFeatureTypeSchema.optional(),
      includeHistorical: z.boolean().default(false),
      cursor: cursor
        .optional()
        .describe(
          "Omit cursor on the first request. For the next page, copy the returned nextCursor unchanged; keep contextId, featureType and includeHistorical filters unchanged. Stop when nextCursor is absent. This is an opaque string, not an offset or page number.",
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(20)
        .default(10)
        .describe(
          "Feature records per page: default 10, maximum 20. This does not enable offset pagination.",
        ),
    })
    .describe(
      `Discover feature IDs with cursor pagination, not offset. First request: omit cursor; continue with the returned nextCursor until absent. offset and supportOffset are not accepted by list-features; those belong to report/get-feature pagination. ${FEATURE_VALUE_DETAIL_GUIDANCE}`,
    ),
  z
    .strictObject({
      action: z.literal("get-feature"),
      featureId: id,
      includeHistorical: z.boolean().default(false),
      offset: z.number().int().min(0).max(2000).default(0),
      supportOffset: z.number().int().min(0).max(2000).default(0),
      limit: z.number().int().min(1).max(MAX_FEATURE_PAGE_CELLS).default(8),
    })
    .describe(
      "Inventory/search return compact feature metadata. Read values here in at most 32 cells per page; follow page.nextOffset. Support intervals have independent page.nextSupportOffset; follow both until null. Values preserve whole-segment normalization; never renormalize pages or treat unavailable null values as zeros.",
    ),
  z
    .strictObject({
      action: z.literal("compare-features"),
      pairs: z
        .array(z.strictObject({ leftFeatureId: id, rightFeatureId: id }))
        .min(1)
        .max(16),
      includeHistorical: z.boolean().default(false),
    })
    .describe(FEATURE_VALUE_DETAIL_GUIDANCE),
  z
    .strictObject({
      action: z.literal("search-features"),
      featureId: id,
      excludeContextIds: z.array(id).max(100).default([]),
      includeHistorical: z.boolean().default(false),
      limit: z.number().int().min(1).max(20).default(10),
      candidateLimit: z.number().int().min(1).max(1_000).default(1_000),
    })
    .describe(
      `Exact distances over a bounded same-session, same-Set candidate scan. Exclude the query's entire source with excludeContextIds for independent matches. Non-exhaustive results are nearest only within the scanned subset. Never triggers derivation or capture. ${FEATURE_VALUE_DETAIL_GUIDANCE}`,
    ),
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
      "Discover context summaries by optional subjectId, listenerId or passId. Does not accept contextId; use report for known metric observations, or get for other/small contexts.",
    ),
  z
    .object({
      action: z.literal("get"),
      contextId: id,
      includeHistorical: z.boolean().default(false),
    })
    .strict()
    .describe(
      "Read one known contextId for other or small contexts. Prefer report for metric-audio-observation/v1 original measurements: full metric get responses exceeding 64 KiB are rejected with report paging instructions. No preceding list is needed. Set includeHistorical=true to retrieve historical evidence.",
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
      "Preferred original-measurement read for a known metric-audio-observation/v1 contextId, without joining record indices. Start at offset=0, limit=8; follow report.nextOffset until null. limit defaults to 8, maximum 32. get-feature is derived evidence, not a substitute. No capture, retry, or legacy conversion.",
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

export const contextFeatureViewSchema = z
  .strictObject({
    record: contextFeatureMetadataSchema,
    segment: contextSegmentSchema,
    source: contextSummarySchema,
  })
  .refine(
    ({ record, segment, source }) =>
      record.segmentId === segment.id &&
      record.entryId === segment.entryId &&
      record.entryId === source.contextId &&
      record.sessionId === segment.sessionId &&
      record.liveSetId === segment.liveSetId,
    "Feature, segment and source provenance must agree",
  );
const comparisonEvidenceSchema = z.strictObject({
  contextId: id,
  segmentId: id,
  coordinate: z.enum(["clip-local-beats", "transport-beats"]),
  startBeat: z.number().finite().nonnegative(),
  endBeat: z.number().finite().nonnegative(),
  durationSeconds: z.number().finite().positive(),
  coveredSamples: z.number().int().nonnegative(),
  expectedSamples: z.number().int().positive(),
  freshness: contextSummarySchema.shape.freshness,
});

export const contextOperationResultSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("feature-definitions"),
    definitions: z.array(listeningFeatureDefinitionSchema).max(32),
  }),
  z.strictObject({
    action: z.literal("derive-features"),
    derivations: z.array(contextFeatureDerivationViewSchema).max(8),
  }),
  z.strictObject({
    action: z.literal("list-features"),
    features: z.array(contextFeatureViewSchema).max(20),
    derivation: contextFeatureDerivationViewSchema.optional(),
    nextCursor: cursor.optional(),
  }),
  z.strictObject({
    action: z.literal("get-feature"),
    feature: contextFeatureViewSchema,
    page: listeningFeaturePageSchema,
  }),
  z.strictObject({
    action: z.literal("compare-features"),
    comparisons: z
      .array(
        z.strictObject({
          leftFeatureId: id,
          rightFeatureId: id,
          leftEvidence: comparisonEvidenceSchema,
          rightEvidence: comparisonEvidenceSchema,
          result: listeningFeatureComparisonSchema,
        }),
      )
      .max(16),
  }),
  z.strictObject({
    action: z.literal("search-features"),
    query: contextFeatureViewSchema,
    matches: z
      .array(
        z.strictObject({
          feature: contextFeatureViewSchema,
          distance: z.number().finite().nonnegative(),
        }),
      )
      .max(20),
    distanceDefinition: listeningFeatureDistanceSchema,
    distanceUnits: listeningFeatureDistanceUnitsSchema,
    scannedCount: z.number().int().min(0).max(1_000),
    comparableCount: z.number().int().min(0).max(1_000),
    eligibleCount: z.number().int().nonnegative(),
    excludedCount: z.number().int().nonnegative(),
    exhaustive: z.boolean(),
    limitsHit: z.array(z.enum(["candidates", "bytes", "time"])).max(3),
    exclusionReasons: z
      .record(z.string().min(1).max(256), z.number().int().min(0).max(1_000))
      .refine((value) => Object.keys(value).length <= 32),
  }),
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
        'After a listening capture, read the original stored metric-audio-observation/v1 measurement with action "report" before querying derived features. Start offset=0, limit=8; follow report.nextOffset until null. Do not request the full raw metric get as the first read: it can exceed the agent response budget. get-feature reads derived values and does not replace that original-measurement read. ' +
        "Feature argument names: list-features uses singular contextId, not contextIds, and optional featureType; list-features and list use cursor, never offset: omit cursor initially, then copy nextCursor until absent. Only report and get-feature accept offset; only get-feature accepts supportOffset. feature-definitions accepts only action, with no pagination. derive-features uses the contextIds array. get-feature uses featureId. compare-features uses pairs of leftFeatureId and rightFeatureId. search-features uses featureId and excludeContextIds (an array of source context IDs). Use the exact action schema; these argument names are not interchangeable. " +
        `${PERSISTED_FEATURE_READ_GUIDANCE} ` +
        "Query typed listening context owned by the active App session. feature-definitions describes available feature types and their canonical distances; use derive-features for explicit stored contextIds, then list-features/get-feature, compare-features or search-features. Derivation changes only App-session derived data, never Live or original measurements. Search never captures or backfills. Distances are not probabilities or universal musical similarity; choose a feature relevant to the request and report source range, duration, coverage and freshness. A non-exhaustive scan is nearest only within the scanned subset. Exclude the query source explicitly when seeking independent matches. For other or small contexts, use get with the exact contextId; no preceding list is needed. Full metric get responses over 64 KiB fail explicitly: switch to report, never read tool-output spill files. For metric-audio-observation/v1 musical analysis use report with that contextId: it returns measured values, per-metric availability, gaps and actual native supports stacked by musical row, rather than raw index joins. Start offset=0, limit=8 (maximum 32); follow report.nextOffset, stopping at null. A report is a bounded projection, not new evidence or whole-row FFT support; missing/no-frame is not silence. Legacy observations retain get unchanged and cannot be converted into metric reports. Use list only to discover unknown IDs by optional subjectId, listenerId or passId; list does not accept contextId. Current-only reads revalidate identity/freshness; explicitly include historical entries to inspect stale or unresolved evidence. RMS dBFS is not LUFS; attacks and attribution can be uncertain. Pruning deletes only explicitly named App-session context, requires approval and confirm='prune-session-context', and never deletes Live clips or source audio. No arbitrary SQL, filesystem paths, raw audio, or generic context writes.",
      parameters: contextOperationParamsSchema,
      handler: async (params, invocation) => {
        const request = contextOperationParamsSchema.parse(params);
        const result = contextOperationResultSchema.parse(
          await services.executeContextOperation(request, invocation),
        );
        if (result.action !== request.action)
          throw new Error("Context result action mismatch");
        if (
          result.action === "get" &&
          result.observation.schema === "metric-audio-observation/v1" &&
          new TextEncoder().encode(JSON.stringify(result)).byteLength >
            MAX_METRIC_CONTEXT_RESPONSE_BYTES
        )
          throw new Error(
            'Metric context get response exceeds 64 KiB UTF-8 budget. Use action "report" with the same contextId, offset=0 and limit=8; follow report.nextOffset until null. Do not read tool-output spill files.',
          );
        if (result.action === "get-feature") {
          const definition = listeningFeatureDefinition(
            result.feature.record.feature.type,
          );
          const cellCount = Math.max(
            0,
            Math.min(
              result.page.limit,
              result.page.totalCells - result.page.offset,
            ),
          );
          if (
            result.page.dimensions !== definition.dimensions ||
            result.page.cells.length !== (definition.grid ? cellCount : 0) ||
            result.page.values?.some(
              (value) =>
                !isListeningFeatureValueValid(
                  definition.type,
                  value,
                  result.feature.record.feature.sampleRate,
                ),
            ) ||
            !listeningFeaturePageMasksMatch(
              result.feature.record.feature,
              result.page,
            ) ||
            (result.page.values === null) !==
              (result.feature.record.feature.status === "unavailable")
          )
            throw new Error("Feature context result does not match request");
        }
        if (
          (request.action === "get-feature" &&
            result.action === "get-feature" &&
            (result.feature.record.id !== request.featureId ||
              result.page.offset !== request.offset ||
              result.page.supportOffset !== request.supportOffset ||
              result.page.limit !== request.limit ||
              result.page.totalSupportIntervals !==
                result.feature.record.feature.supportIntervalCount ||
              JSON.stringify(result.page.totalChannelSupportIntervals) !==
                JSON.stringify(
                  result.feature.record.feature.channelSupportIntervalCounts,
                ) ||
              result.page.totalCells !==
                (listeningFeatureDefinition(result.feature.record.feature.type)
                  .grid
                  ? (result.feature.record.feature.grid?.cellCount ?? 0)
                  : 1))) ||
          (request.action === "derive-features" &&
            result.action === "derive-features" &&
            (result.derivations.length !== request.contextIds.length ||
              result.derivations.some(
                (item, index) => item.entryId !== request.contextIds[index],
              ))) ||
          (request.action === "compare-features" &&
            result.action === "compare-features" &&
            (result.comparisons.length !== request.pairs.length ||
              result.comparisons.some(
                (item, index) =>
                  item.leftFeatureId !== request.pairs[index]?.leftFeatureId ||
                  item.rightFeatureId !== request.pairs[index]?.rightFeatureId,
              ))) ||
          (request.action === "list-features" &&
            result.action === "list-features" &&
            (result.features.length > request.limit ||
              (request.featureType !== undefined &&
                result.features.some(
                  (item) => item.record.feature.type !== request.featureType,
                )) ||
              (request.contextId !== undefined &&
                result.features.some(
                  (item) => item.record.entryId !== request.contextId,
                )))) ||
          (request.action === "search-features" &&
            result.action === "search-features" &&
            (result.query.record.id !== request.featureId ||
              result.distanceDefinition !==
                result.query.record.feature.distanceDefinition ||
              result.distanceUnits !==
                result.query.record.feature.distanceUnits ||
              result.matches.length > request.limit ||
              result.scannedCount > request.candidateLimit ||
              result.matches.some((item) =>
                request.excludeContextIds.includes(item.feature.record.entryId),
              )))
        )
          throw new Error("Feature context result does not match request");
        if (
          request.action.includes("feature") &&
          new TextEncoder().encode(JSON.stringify(result)).byteLength >
            MAX_METRIC_CONTEXT_RESPONSE_BYTES
        )
          throw new Error(
            "Feature context response exceeds 64 KiB UTF-8 budget",
          );
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
