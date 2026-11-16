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
  listeningCaptureProgressSchema,
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
  metricRecordChunkSchema,
  metricRecordStreamDescriptorSchema,
  metricRecordStreamManifestSchema,
  metricContinuousListeningGeometrySchema,
  melBandAggregationSchema,
  melBandProfileSchema,
  metricRecordStreamGapSchema,
  metricRecordStreamContextReferenceSchema,
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
const streamCursor = z.string().min(1).max(4096);
const sampleRange = z
  .strictObject({
    startSample: z.number().int().nonnegative(),
    endSample: z.number().int().positive(),
  })
  .refine((value) => value.endSample > value.startSample);
const page = {
  cursor: cursor.optional(),
  limit: z.number().int().min(1).max(100).default(20),
};

const SESSION_SEQUENCE_GUIDANCE =
  'Every successful Session listen leaves playback running. Before the next Session listen, inspect current transport/source state and use ableton_transport action "set-playing" with isPlaying=false, through ordinary approval, if transport is moving. If a different clip remains remembered on the requested track, use ableton_tracks action "stop-clips" with that exact track and quantized=false, through ordinary approval, then verify stopped/nonqueued state. Do not stop unrelated tracks, seek, edit MIDI or change quantization. Prepare the next requested source before submitting its listen; do not intentionally submit a known-invalid capture to discover these prerequisites. This is preparation for a user-requested sequence, not permission to repair or retry a failed pass.';

const PLANNED_ARRANGEMENT_HANDOFF_GUIDANCE =
  'For a planned Session-to-Arrangement handoff explicitly requested by the user, restore Arrangement before submitting the Arrangement listen: stop moving transport, then call ableton_transport action "back-to-arrangement" through ordinary approval. A completed Session listen leaves a Session source selected; a transport stop does not restore Arrangement, and Live 11 may report the other track source as unknown until the global override is cleared. Do not start a capture to probe this known prerequisite. Inspect and verify the restored source before capture. When the user requests the whole Arrangement without numeric bounds, establish its full range from the actual Arrangement clips on the requested track, for example with ableton_arrangement action "inspect" and its inventory continuations. Transport loop length is not the Arrangement duration; neither cue points nor Session clip lengths establish the Arrangement ending. Never guess a default range or silently omit later material. Switching views or stopping transport alone does not clear a Session override. This planned preparation does not authorize repair or retry after a rejected capture.';

const SESSION_LAUNCH_CASE_GUIDANCE = `Requires stopped transport at a nonnegative position, global None or One Bar, and clip Global or One Bar quantization. This includes remembered active clips while transport is stopped; moving transport is unsupported. Never seek or change launch settings to make a request pass. ${SESSION_SEQUENCE_GUIDANCE} ${PLANNED_ARRANGEMENT_HANDOFF_GUIDANCE}`;

const FAILURE_EVIDENCE_GUIDANCE =
  "inspect-listeners ready:false with native_per_pass_validation_required means fresh validation is required for each capture, not a permanent commissioning failure and not evidence of an identity mismatch or broken listener. An already completed pass can have validated native proof while discovery still reports ready:false. An empty discovery list is not proof that devices were removed or disabled. An error code alone is not a precise cause: report failureEvidence's observed phase/check, actual versus expected values, coverage and diagnostic reference. Partial or unavailable evidence is an observability gap, not proof of a native predicate. Never invent an identity mismatch, automatically retry, edit settings or fall back to another mode to diagnose a rejection.";

const ALIGNMENT_EVIDENCE_GUIDANCE =
  "Timing policy is frozen per pass. maxClockDisagreementSamples is an enforced admission limit only in strict mode. Descriptive mode can accept disagreement above that advisory target; disclose the observed clock and beat/phase disagreement separately, along with unknown absolute accuracy. Completion is not proof that observed disagreement is within the configured target. Maximum observed beat disagreement includes transport/phase observations around startup and is not a uniform audio delay or a proven shift of every report row. Do not discard timing witnesses or reinterpret a warning as measured latency.";

const RHYTHM_EVIDENCE_GUIDANCE =
  "For descriptive quarter-note beat placement, integer zero-based beat positions are on-beats; n+0.5 positions are offbeats. Human beat labels 1,2,3,4 correspond to zero-based positions 0,1,2,3, not rounded fractional positions. Do not round fractional detector-window endpoints onto integer beats; corroborate placement with native support and level-row intervals. If those intervals cannot establish phase, describe the uncertainty instead of claiming on-beat or offbeat placement. Convert samples using the report's actual sampleRate and tempoBpm: samples per beat = sampleRate * 60 / tempoBpm. Do not assume 120 BPM or treat quantized detector-end spacing as precise inter-onset timing.";

const FLATNESS_SMOKE_GUIDANCE =
  'For flatness, spread and rolloff, read canonical stored spectral-shape features or bounded original "stream-records" for metric "spectral-shape". A request uses the same scoped listening action, not an extra capture or invented requestedMetrics argument. Read actual frame supports, independent channel states, gaps and unmeasured trailing support. Complete acquisition does not imply defined descriptors: silence, undefined and invalid channels retain unavailable values, not measured zeros. The pinned SpectralShape profile uses magnitude weighting, linear frequency, 20-log flatness in dB, and nonnegative Hz values for spread and rolloff. Rolloff is explicitly configured at 95 percent; the profile documents its qualified cumulative interpolation and excluded Nyquist bin. Spectral breadth is not physical filter bandwidth or source count; rolloff is not an actual synth/filter cutoff or an automatic EQ prescription. Historical smoke diagnostics remain in typed Desktop History and cannot substitute for an absent authoritative timeline. Delivery counts are not FFT frame counts. If the timeline is absent or unavailable, explain that limitation; do not invent flatness report values, spread report values or rolloff report values.';
const MEL_BAND_GUIDANCE =
  'When mel-bands is requested, including by the default metric set, read canonical stored mel features or bounded original "stream-records" for metric "mel-bands", not SpectralShape smoke diagnostics. The mel timeline retains all 24 bands for independent left/right channels, full frame supports, exact gaps and the pinned profile. Units are uncalibrated linear FFT magnitudes with normalize 0 and scale 0, not power or calibrated energy. Ratios derive from the same retained vectors; aggregation averages linear vectors before deriving ratios, never averages ratios. Preserve zero-denominator and below-floor unavailable reasons; a valid zero numerator with a healthy denominator is a zero ratio. No-frame and missing support are not measured silence. Read status, retained/expected counts, gaps and unmeasured trailing support before making coverage claims. Never invent absent mel data, trim bands, substitute SpectralShape diagnostics, infer warmth or muddiness, or prescribe EQ from these ratios alone.';
const PITCH_SMOKE_GUIDANCE =
  'For pitch requests, read canonical stored pitch features, or use ableton_context action "stream-records" with the returned contextId, metric "pitch" and a narrow native sample range for original paired Hz/confidence. Historical bounded observations retain action "report"; do not call it on a new stream context or substitute historical smoke diagnostics. The independent stereo YinFFT profile retains its nominal 50-2000 Hz search and 2048-sample window/hop/FFT. Requests use the existing scoped listening action without extra arguments or recapture. Accepted-estimate means only that the frozen output/confidence gate passed, not verified pitch or input class. Controlled sine qualification covers the declared profile test cases; a known 2000 Hz sine produces a high-confidence estimate near 1000 Hz that passes the gate despite the octave error. Confidence is an algorithm-specific score, not a calibrated probability; low confidence is not proof of noise. Preserve rejected raw estimates and channel states; 0 Hz is the undefined sentinel, not a measured zero-frequency note, and zero confidence is a legitimate score. Acquisition gaps, undefined estimates and measured silence are distinct. Read native support and explicit unmeasured tails. The short window limits low notes; octave errors and unreliable polyphonic mixtures remain possible. Historical polled diagnostics cannot be promoted into frames. If authoritative pitch is absent or unavailable, report that rather than inventing fields or retrying. Do not search tool-output files or use shell/filesystem commands to find pitch. No transcription, instrument recognition or automatic pitch correction is provided.';

const FINITE_METRIC_CAPTURE_GUIDANCE =
  "Session and Arrangement use the same incrementally persisted six-metric capture pipeline for every finite duration, up to 600 seconds. Session selects one exact clip and same-track listener; Arrangement supports up to eight listeners. Discover the negotiated audio-listener/finite-metric-stream-v1 capability. The App owns Arrangement positioning and playback start; do not seek or start transport separately. Native source, ownership, coverage and cleanup proofs remain required. Do not split a long request into repeated short captures, trim metrics or silently shorten its range.";

const LISTENING_WORKFLOW_GUIDANCE = `Use only actions in the scoped schema. play-arrangement-and-listen requires listenerIds, startBeat and the absolute endBeat, not durationBeats. ${FINITE_METRIC_CAPTURE_GUIDANCE} play-session-and-listen explicitly fires one exact MIDI or warped-audio clip. Omit durationBeats to capture exactly one active loop or nonlooping start/end region, not the underlying audio file. Specify durationBeats only for an explicitly requested shorter range; equality with the active end is supported. The first-iteration and ten-minute ceilings are enforced without truncation. ${SESSION_LAUNCH_CASE_GUIDANCE} Do not substitute Arrangement or edit source/launch settings to make Session pass. Source continuity is message-rate monitored, not sample-accurate; unknown follow actions are not disabled, and listener audio is not exclusively attributable to the clip. For arrangement_session_override, explain that Back to Arrangement restores the playback source, not the view; after a rejected pass do not repair or retry automatically. Start calls wait for terminal capture, durable publication and cleanup, then return owned contextIds; no get-pass polling, second capture, bash or sleep is needed to wait. Queued or arming is not completion. Read the returned stored contexts before drawing musical conclusions. Shared source, clock, ownership or cleanup failures prevent publication. Report unavailable metrics, gaps and unmeasured tails rather than inferring silence or recapturing. Valid measured zeros and empty attack lists are evidence, not missing data. Playback remains running after completion, cancellation or failure; cancellation does not retract an accepted or queued Session launch. The timeout includes setup and launch. Report verified transport changes honestly. An explicit user instruction to stop on any failure includes argument-validation and permission failures; retryable is technical recoverability, not permission to retry.`;

const PERSISTED_FEATURE_READ_GUIDANCE =
  "When the user explicitly asks to read or reread persisted features, call get-feature for each requested feature from every requested context in the current operation, including contexts read in earlier turns. Conversation memory or a previous turn's read does not satisfy an explicit persisted reread. Use known featureIds, or discover them with list-features scoped to each contextId; follow value/support page continuations needed for the requested evidence. When the user requests both comparison and search, call compare-features with pairs of leftFeatureId and rightFeatureId, and call search-features separately with featureId and the requested excludeContextIds. A search hit or its distance is not a substitute for the requested pair comparison, even when the hit is the comparison target. Use actual persisted IDs and typed results; report unavailable or failed reads/comparisons honestly rather than filling gaps from memory. These reads do not authorize capture, rederivation or retries.";

export const METRIC_REPORT_PAGE_GUIDANCE =
  "This is one original-measurement report page. Inspect report.nextOffset: if non-null, call ableton_context report again for the same contextId with offset equal to that exact nextOffset, not offset + limit. Byte limits can return fewer rows than the requested limit. Follow every continuation until nextOffset is null. A request to reread or verify stored analyzer evidence requires fresh complete pages for each requested context, including after restart; earlier-turn pages cannot establish that the evidence remains available and unchanged. Complete these reads even if feature values were read first. Global acquisition metadata and feature values do not replace unread frame validity.";

const METRIC_STREAM_RECORD_GUIDANCE =
  'Every new Session or Arrangement capture returns metric-record-stream-context/v1. Use its known contextId directly: "stream-overview" gives independently verified terminal counts, gaps, native status and digests without loading the timeline. "stream-records" reads bounded values by metric and half-open native sample range. Selection precedes pagination and preserves original values, indices and full crossing supports. A page may be empty yet have nextCursor after a coarse chunk match; copy the returned continuation only for the same context and filters. For a global musical beat b, native sample = overview.geometry.startSample + (b - overview.geometry.startBeat) * overview.geometry.sampleRate * 60 / overview.geometry.tempoBpm; round sample bounds to integers. Session clip-local beats are separate from that global native anchor. Prefer narrow musical ranges and limits up to 64; do not exhaust a long timeline merely to establish coverage. Pages project digest-checked immutable chunks; their original digest does not describe the sliced records. Counts alone do not establish timbre, pitch, rhythm or silence. Preserve unavailable values, gaps and unmeasured tails.';

export const METRIC_STREAM_READ_GUIDANCE = `All completed captures support the same derive-features, list-features, get-feature, compare-features and search-features actions. For stored schema, shape and count checks, use "stream-overview" and complete "list-features" inventories, following their continuations. For "list-features", omit limit to use its default and maximum 100; copy nextCursor until absent. Its inventory.features items reference the page's deduplicated provenance, segments, sources and metadata by zero-based index. Original feature IDs, ownership and stored shapes remain explicit; generated summary prose is omitted. Do not reuse the different stream-records or get-feature page limits. Never use bash for scratch calculations, output formatting, progress markers or no-op checks. Derivation reads bounded persisted musical ranges across physical chunks, preserving native supports; it never recaptures audio or constructs a whole observation. Musical measures are not storage chunks. Applicable grids use sixteenth-note cells; not every feature is a grid. Compare the complete requested extent, not only its first few measures. "stream-summary" remains a bounded raw mel-measurement presentation, not a separate feature system. Oversized reads fail explicitly and must be narrowed. ${METRIC_STREAM_RECORD_GUIDANCE}`;

export const FEATURE_VALUE_DETAIL_GUIDANCE =
  "list-features, compare-features and search-features return metadata and distances, not feature value arrays. valueCount is a count, not values; distance is not either input vector. If the user requested values or persisted rereads, use get-feature for each requested featureId in this operation before reporting values; read page.values and needed continuations, not memory or original report rows. Preserve null/unavailable reasons. Comparison/search alone does not require these extra reads. A requested complete inventory is incomplete while nextCursor exists: follow it until absent. Never infer unread IDs or measures from derivation totals or the feature catalog.";

export const LISTENING_AGENT_GUIDANCE = `Before each capture finish the preceding pass and prepare the requested playback source through ordinary approvals. A planned Session-to-Arrangement handoff requires STOP and Back to Arrangement; stopping or switching views alone does not restore the source. Determine a whole Arrangement's extent from its clips, not transport loops or guessed bounds. Never submit a known-invalid capture to probe prerequisites, or repair/retry a rejected pass automatically. ${LISTENING_WORKFLOW_GUIDANCE} ${PERSISTED_FEATURE_READ_GUIDANCE} Native level values are linear amplitudes, not dBFS. Attack strength is dB-rise; its timestamp is a detector-window end, not precise onset. Partial coverage cannot establish absence of attacks. Authoritative pitch, mel and spectral-shape values live in bounded measurement reads and canonical stored features, not historical smoke diagnostics. ${MEL_BAND_GUIDANCE} ${FLATNESS_SMOKE_GUIDANCE} ${PITCH_SMOKE_GUIDANCE} ${RHYTHM_EVIDENCE_GUIDANCE} ${ALIGNMENT_EVIDENCE_GUIDANCE} ${FAILURE_EVIDENCE_GUIDANCE} Historical metric-audio-observation/v1 contexts retain their original bounded report/get actions; they do not authorize a legacy capture fallback. ${METRIC_STREAM_READ_GUIDANCE}`;

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
          "Omit to capture exactly one active loop, or the active nonlooping start/end region. An explicit duration may be shorter, never longer. Ranges exceeding 600 seconds or bounded native acquisition limits are rejected, not truncated.",
        ),
      maximumDurationMs: z.number().int().min(1).max(900_000).default(900_000),
    })
    .strict()
    .describe(
      `Explicitly launch one exact Session MIDI or warped-audio clip through one same-track listener with the negotiated finite-stream capability. Omitted duration captures one active loop or the nonlooping active start/end region; explicit shorter ranges and equality at the active end are supported. The 600-second acquisition ceiling is mandatory; oversized ranges fail without truncation. ${SESSION_LAUNCH_CASE_GUIDANCE} Requires recording off, zero offsets and Trigger/legato off. Normal wrap or natural end after coverage requires both monitored source-boundary and completed native DSP evidence, never queued acceptance. Cancellation never retracts an accepted launch or stops transport.`,
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
      maximumDurationMs: z.number().int().min(1).max(900_000).default(900_000),
    })
    .strict()
    .refine((range) => range.endBeat > range.startBeat, {
      message: "Arrangement end must follow its start",
    })
    .describe(
      `Capture the exact Arrangement interval [startBeat, endBeat). durationBeats is not accepted. Waits for terminal capture, publication and cleanup before returning the owned job. ${PLANNED_ARRANGEMENT_HANDOFF_GUIDANCE}`,
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
    captureProgress: listeningCaptureProgressSchema.optional(),
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
    capabilities: z.array(z.string().min(1).max(128)).max(4),
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
    z
      .object({
        action: z.literal(action),
        job: listeningJobSchema,
        nextCaptureGuidance: z.string().max(4096).optional(),
      })
      .strict(),
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
    .strictObject({
      action: z.literal("stream-overview"),
      contextId: id,
      includeHistorical: z.boolean().default(false),
    })
    .describe(METRIC_STREAM_READ_GUIDANCE),
  z
    .strictObject({
      action: z.literal("stream-summary"),
      contextId: id,
      includeHistorical: z.boolean().default(false),
      range: sampleRange,
    })
    .describe(
      "Read one complete bounded mel-band passage summary across immutable chunks. Use musical sample bounds from stream-overview geometry. At most 256 matching frames, eight chunks and 1 MiB internally; no raw arrays or recapture. Gaps and provenance remain explicit.",
    ),
  z
    .strictObject({
      action: z.literal("stream-records"),
      contextId: id,
      includeHistorical: z.boolean().default(false),
      metric:
        metricRecordStreamDescriptorSchema.shape.requestedMetrics.element.optional(),
      range: sampleRange.optional(),
      cursor: streamCursor.optional(),
      limit: z.number().int().min(1).max(64).default(8),
    })
    .describe(METRIC_STREAM_READ_GUIDANCE),
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
      "Persist canonical features for an explicit completed stored context, for either playback view and any supported capture duration. Reads bounded immutable measurement ranges across chunks; never captures audio or changes Live.",
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
        .max(100)
        .default(100)
        .describe(
          "Feature inventory items per page: default and maximum 100, within a 64 KiB response. Reduce limit if that byte bound is exceeded. This does not enable offset pagination.",
        ),
    })
    .describe(
      `Discover feature IDs with cursor pagination, not offset. The inventory stores repeated provenance, segments, sources and metadata once per page; each inventory.features item references those tables by zero-based index. Every item has its original feature ID. Generated per-feature summary prose is omitted; get-feature retains its detailed presentation and values. First request: omit cursor; continue with the returned nextCursor until absent. offset and supportOffset are not accepted by list-features; those belong to report/get-feature pagination. ${FEATURE_VALUE_DETAIL_GUIDANCE}`,
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
      cursor: streamCursor.optional(),
    })
    .strict()
    .describe(
      "Discover canonical context summaries by optional subjectId, listenerId or passId. At most four summaries per bounded page; copy nextCursor as needed. Does not accept contextId; use stream-overview for known captures, get for immutable references, and the common feature actions for stored musical representations.",
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
    kind: z.union([
      audioObservationKindSchema,
      z.literal("metric-record-stream-context/v1"),
    ]),
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

const { rows: _streamRows, ...streamGeometryShape } =
  metricContinuousListeningGeometrySchema.shape;
void _streamRows;
export const metricStreamOverviewSchema = z
  .strictObject({
    descriptorDigest: metricRecordChunkSchema.options[0].shape.descriptorDigest,
    geometry: z.strictObject(streamGeometryShape),
    source: metricRecordStreamDescriptorSchema.shape.source,
    timingPolicy: metricRecordStreamDescriptorSchema.shape.timingPolicy,
    algorithms: metricRecordStreamDescriptorSchema.shape.algorithms,
    metrics: metricRecordStreamManifestSchema.shape.metrics,
    outcome: z.enum(["complete", "partial"]),
    nativeStatus: z.literal("completed"),
    nativeCoverage: z.strictObject({
      capturedSamples:
        metricRecordStreamManifestSchema.shape.nativeProof.shape
          .capturedSamples,
      sourceOrigin:
        metricRecordStreamManifestSchema.shape.nativeProof.shape.sourceOrigin,
      sourceEnd:
        metricRecordStreamManifestSchema.shape.nativeProof.shape.sourceEnd,
      drain: z.literal("completed"),
    }),
    chunkCount: z.number().int().nonnegative(),
    storedBytes: z.number().int().nonnegative(),
    limitations: metricRecordStreamManifestSchema.shape.limitations,
    featureDerivation: z.literal("supported"),
  })
  .superRefine((value, ctx) => {
    if (
      value.nativeCoverage.capturedSamples !== value.geometry.totalSamples ||
      value.nativeCoverage.sourceOrigin !== value.geometry.startSample ||
      value.nativeCoverage.sourceEnd !== value.geometry.endSample
    )
      ctx.addIssue({
        code: "custom",
        message: "Completed stream native coverage must match its geometry",
      });
  });
const streamRecordProjections = metricRecordChunkSchema.options.map((chunk) =>
  z.strictObject({
    kind: z.literal("metric-record-chunk-projection/v1"),
    metric: chunk.shape.metric,
    descriptorDigest: chunk.shape.descriptorDigest,
    chunkDigest: chunk.shape.digest,
    previousDigest: chunk.shape.previousDigest,
    chunkSequence: chunk.shape.chunkSequence,
    recordOffset: chunk.shape.recordOffset,
    slotOffset: chunk.shape.slotOffset,
    totalRecords: z.number().int().min(0).max(256),
    totalGaps: z.number().int().min(0).max(256),
    entryOffset: z.number().int().min(0).max(255),
    records: chunk.shape.records.max(64),
    gaps: chunk.shape.gaps.max(64),
  }),
);
export const metricStreamRecordPageSchema = z
  .discriminatedUnion("metric", [
    streamRecordProjections[0]!,
    ...streamRecordProjections.slice(1),
  ])
  .superRefine((value, ctx) => {
    const count = value.records.length + value.gaps.length;
    if (
      count > 64 ||
      (count === 0 && value.entryOffset !== 0) ||
      value.records.length > value.totalRecords ||
      value.gaps.length > value.totalGaps ||
      value.totalRecords + value.totalGaps < 1 ||
      value.totalRecords + value.totalGaps > 256 ||
      value.entryOffset + count > value.totalRecords + value.totalGaps
    )
      ctx.addIssue({
        code: "custom",
        message: "Invalid bounded stream record projection",
      });
  });
const streamEntrySchema = contextSummarySchema.refine(
  (entry) => entry.kind === "metric-record-stream-context/v1",
  "Stream reads require a stream context",
);
const checkContextResponseBudget = (value: unknown, ctx: z.RefinementCtx) => {
  if (
    new TextEncoder().encode(JSON.stringify(value)).byteLength >
    MAX_METRIC_CONTEXT_RESPONSE_BYTES
  )
    ctx.addIssue({
      code: "custom",
      message: "Context response exceeds 64 KiB UTF-8 budget",
    });
};
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
const inventoryIndex = z.number().int().min(0).max(99);
const inventorySourceSchema = contextSummarySchema.omit({ summary: true });
export const listeningFeatureInventorySchema = z
  .strictObject({
    features: z
      .array(
        z.strictObject({
          id,
          createdAt: contextFeatureMetadataSchema.shape.createdAt,
          provenance: inventoryIndex,
          segment: inventoryIndex,
          source: inventoryIndex,
          metadata: inventoryIndex,
        }),
      )
      .max(100),
    provenance: z
      .array(
        contextFeatureMetadataSchema.omit({
          id: true,
          segmentId: true,
          feature: true,
          createdAt: true,
        }),
      )
      .max(100),
    segments: z.array(contextSegmentSchema).max(100),
    sources: z.array(inventorySourceSchema).max(100),
    metadata: z.array(contextFeatureMetadataSchema.shape.feature).max(100),
  })
  .superRefine((page, ctx) => {
    const ids = new Set<string>();
    for (const feature of page.features) {
      const record = page.provenance[feature.provenance];
      const segment = page.segments[feature.segment];
      const source = page.sources[feature.source];
      if (
        ids.has(feature.id) ||
        !record ||
        !segment ||
        !source ||
        !page.metadata[feature.metadata] ||
        record.entryId !== segment.entryId ||
        record.entryId !== source.contextId ||
        record.sessionId !== segment.sessionId ||
        record.liveSetId !== segment.liveSetId
      )
        ctx.addIssue({
          code: "custom",
          message: "Invalid feature inventory reference or provenance",
        });
      ids.add(feature.id);
    }
  });

export function projectListeningFeatureInventory(
  input: readonly z.infer<typeof contextFeatureViewSchema>[],
) {
  function table<T>() {
    const values: T[] = [];
    const indexes = new Map<string, number>();
    return {
      values,
      index(value: T) {
        const key = JSON.stringify(value);
        const known = indexes.get(key);
        if (known !== undefined) return known;
        const index = values.length;
        values.push(value);
        indexes.set(key, index);
        return index;
      },
    };
  }
  const provenance =
    table<
      z.infer<typeof listeningFeatureInventorySchema>["provenance"][number]
    >();
  const segments = table<z.infer<typeof contextSegmentSchema>>();
  const sources = table<z.infer<typeof inventorySourceSchema>>();
  const metadata =
    table<z.infer<typeof contextFeatureMetadataSchema.shape.feature>>();
  const features = z
    .array(contextFeatureViewSchema)
    .max(100)
    .parse(input)
    .map((view) => {
      const { id, createdAt, segmentId, feature, ...record } = view.record;
      void segmentId;
      return {
        id,
        createdAt,
        provenance: provenance.index(record),
        segment: segments.index(view.segment),
        source: sources.index(inventorySourceSchema.strip().parse(view.source)),
        metadata: metadata.index(feature),
      };
    });
  return listeningFeatureInventorySchema.parse({
    features,
    provenance: provenance.values,
    segments: segments.values,
    sources: sources.values,
    metadata: metadata.values,
  });
}

export function expandListeningFeatureInventory(
  raw: z.input<typeof listeningFeatureInventorySchema>,
) {
  const page = listeningFeatureInventorySchema.parse(raw);
  return page.features.map((feature) => ({
    record: {
      ...page.provenance[feature.provenance]!,
      id: feature.id,
      createdAt: feature.createdAt,
      segmentId: page.segments[feature.segment]!.id,
      feature: page.metadata[feature.metadata]!,
    },
    segment: page.segments[feature.segment]!,
    source: page.sources[feature.source]!,
  }));
}
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
  z
    .strictObject({
      action: z.literal("stream-summary"),
      entry: streamEntrySchema,
      summary: z
        .strictObject({
          kind: z.literal("mel-band-range-summary/v1"),
          descriptorDigest:
            metricRecordChunkSchema.options[0].shape.descriptorDigest,
          range: sampleRange,
          supportPolicy: z.literal("intersecting-native-frames"),
          availability: z.enum(["available", "unavailable"]),
          profile: melBandProfileSchema.nullable(),
          aggregation: melBandAggregationSchema,
          gaps: z.array(metricRecordStreamGapSchema).max(256),
          chunkDigests: z
            .array(metricRecordChunkSchema.options[0].shape.digest)
            .max(8),
        })
        .refine((value) => value.aggregation.frameCount <= 256, {
          message: "Stream summary exceeds its bounded frame budget",
        }),
    })
    .superRefine(checkContextResponseBudget),
  z
    .strictObject({
      action: z.literal("stream-overview"),
      entry: streamEntrySchema,
      overview: metricStreamOverviewSchema,
    })
    .superRefine(checkContextResponseBudget),
  z
    .strictObject({
      action: z.literal("stream-records"),
      entry: streamEntrySchema,
      page: metricStreamRecordPageSchema.nullable(),
      nextCursor: streamCursor.optional(),
    })
    .superRefine((value, ctx) => {
      checkContextResponseBudget(value, ctx);
      if (value.page === null && value.nextCursor !== undefined)
        ctx.addIssue({
          code: "custom",
          message: "Empty stream pages cannot claim a continuation",
        });
    }),
  z.strictObject({
    action: z.literal("feature-definitions"),
    definitions: z.array(listeningFeatureDefinitionSchema).max(32),
  }),
  z.strictObject({
    action: z.literal("derive-features"),
    derivations: z.array(contextFeatureDerivationViewSchema).max(8),
  }),
  z
    .strictObject({
      action: z.literal("list-features"),
      inventory: listeningFeatureInventorySchema,
      derivation: contextFeatureDerivationViewSchema.optional(),
      nextCursor: cursor.optional(),
    })
    .superRefine(checkContextResponseBudget),
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
      nextCursor: streamCursor.optional(),
    })
    .strict()
    .superRefine(checkContextResponseBudget),
  z
    .object({
      action: z.literal("get"),
      entry: contextSummarySchema,
      observation: z.union([
        storedAudioObservationSchema,
        metricRecordStreamContextReferenceSchema,
      ]),
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
      description: `${LISTENING_AGENT_GUIDANCE} Discover exact audio listeners and explicitly play an Arrangement range or guarded Session clip. Both views use one finite metric-stream pipeline with bounded chunks at supported 44.1/48 kHz DSP rates, a globally anchored quarter-beat level grid, actual FFT supports and an independent 100 ms attack-detector cadence. Requires stopped transport and verified recording off; never solos/mutes tracks or changes effects. A listener with limitation native_per_pass_validation_required may attempt fresh native validation even while ready=false. Source, tempo and meter monitoring are message-rate evidence, not sample-accurate proof; unsupported changes deny publication and unknown meter cannot become invented musical alignment. For Arrangement, the App positions and independently reads back the stopped insert marker before native arm. Timing policy is frozen from trusted Settings, not selected by this tool; strict mode bounds observed disagreement, not absolute accuracy. Approximate results remain descriptive, with unknown absolute timing error and no exclusive clip attribution. Fresh generation-bound arm, launch, source coverage and cleanup proof are required; unsupported or unbound listeners remain denied. There is no whole-observation capture fallback. Playback continues after completion, cancellation, failure or timeout: cancel stops capture, not transport. Session uses one same-track listener, zero offsets, Trigger/legato off and the stated stopped-transport quantization conditions, without seeking or changing settings. Known-enabled follow actions and unwarped audio are denied; unknown settings remain explicit and monitored. Clip identity and start_time must match the frozen native anchor. Cancel only active-session/agent owned passes. Master/return measurements are mixes, not isolated clip facts. Read status, per-metric coverage and cleanupPolicy; contexts publish only after verified durable publication.`,
      parameters: listeningOperationParamsSchema,
      handler: async (params, invocation) => {
        const result = listeningOperationResultSchema.parse(
          await services.executeListeningOperation(params, invocation),
        );
        if (result.action !== params.action)
          throw new Error("Listening result action mismatch");
        if (
          result.action === "play-session-and-listen" &&
          result.job.stage === "completed" &&
          result.job.cleanupPolicy === "leave-running"
        )
          return {
            ...result,
            nextCaptureGuidance:
              SESSION_SEQUENCE_GUIDANCE +
              " " +
              PLANNED_ARRANGEMENT_HANDOFF_GUIDANCE,
          };
        return result;
      },
    }),
    defineTool("ableton_context", {
      description:
        METRIC_STREAM_READ_GUIDANCE +
        " " +
        'After a listening capture, use "stream-overview" with its returned contextId to read original persisted coverage, then use bounded "stream-records" for any requested original measurement values. All new Session and Arrangement captures use metric-record-stream-context/v1; do not call historical action "report" on them. Canonical feature metadata and values use the same shared actions for both playback views. ' +
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
          ((request.action === "stream-overview" &&
            result.action === "stream-overview") ||
            (request.action === "stream-summary" &&
              result.action === "stream-summary") ||
            (request.action === "stream-records" &&
              result.action === "stream-records")) &&
          result.entry.contextId !== request.contextId
        )
          throw new Error("Stream context result does not match request");
        if (
          request.action === "stream-summary" &&
          result.action === "stream-summary" &&
          (request.range.startSample !== result.summary.range.startSample ||
            request.range.endSample !== result.summary.range.endSample)
        )
          throw new Error("Stream summary does not match request");
        if (
          request.action === "stream-records" &&
          result.action === "stream-records" &&
          result.page !== null &&
          ((request.metric !== undefined &&
            result.page.metric !== request.metric) ||
            result.page.records.length + result.page.gaps.length >
              request.limit)
        )
          throw new Error("Stream record page does not match request");
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
            (result.inventory.features.length > request.limit ||
              (request.featureType !== undefined &&
                result.inventory.features.some(
                  (item) =>
                    result.inventory.metadata[item.metadata]!.type !==
                    request.featureType,
                )) ||
              (request.contextId !== undefined &&
                result.inventory.features.some(
                  (item) =>
                    result.inventory.provenance[item.provenance]!.entryId !==
                    request.contextId,
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
