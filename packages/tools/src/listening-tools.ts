import {
  defineTool,
  type Tool,
  type ToolInvocation,
} from "@github/copilot-sdk";
import {
  audioObservationKindSchema,
  storedAudioObservationSchema,
  clipLocationSchema,
  trackLocationSchema,
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
  listeningFeatureComparisonCoverageSchema,
  metricRecordChunkSchema,
  metricRecordStreamDescriptorSchema,
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
  analysisOperationParamsSchema,
  analysisOperationResultSchema,
  analysisPageSchema,
  captureAnalysisFailureSchema,
  LISTENING_FEATURE_CATALOG,
  metricStreamOverviewSchema,
  metricStreamRecordPageSchema,
} from "./listening-feature-views.js";
export * from "./listening-feature-views.js";
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

export const SESSION_TRANSPORT_GUIDANCE =
  'Session clips and song transport are independent. ableton_tracks action "stop-clips" affects only the named track and does not stop song transport. Stop transport separately with ableton_transport action "set-playing", isPlaying=false, through ordinary approval. A Session listening call fires its clip and starts playback itself; do not start transport separately for it.';

export const SESSION_SEQUENCE_GUIDANCE =
  'Every successful Session listen leaves playback running at completion, but later user actions may change it. Before the next Session listen requested by the user, inspect current transport; FIRST stop transport only if it is moving, using ableton_transport action "set-playing", isPlaying=false, through ordinary approval. If already stopped, do not stop it again. Verify stopped/nonqueued state; do not infer current playback from an earlier capture. ableton_tracks stop-clips does not stop song transport. Do not start transport separately; listening starts it. Remembered Session clips are supported while transport is stopped; do not deselect clips, stop unrelated tracks, seek, edit MIDI or change quantization. Otherwise leave playback running. Never probe a known-invalid capture. This prepares a requested sequence, not permission to repair or retry a failed pass.';

const PLANNED_ARRANGEMENT_HANDOFF_GUIDANCE =
  'For a planned Session-to-Arrangement handoff explicitly requested by the user, restore Arrangement before submitting the Arrangement listen: stop moving transport, then call ableton_transport action "back-to-arrangement" through ordinary approval. A completed Session listen leaves a Session source selected; a transport stop does not restore Arrangement, and Live 11 may report the other track source as unknown until the global override is cleared. Do not start a capture to probe this known prerequisite. Inspect and verify the restored source before capture. When the user requests the whole Arrangement without numeric bounds, establish its full range from the actual Arrangement clips on the requested track, for example with ableton_arrangement action "inspect" and its inventory continuations. Transport loop length is not the Arrangement duration; neither cue points nor Session clip lengths establish the Arrangement ending. Never guess a default range or silently omit later material. Switching views or stopping transport alone does not clear a Session override. This planned preparation does not authorize repair or retry after a rejected capture.';

const SESSION_LAUNCH_CASE_GUIDANCE = `Requires stopped transport at a nonnegative position, global None or One Bar, and clip Global or One Bar quantization. This includes remembered active clips while transport is stopped; moving transport is unsupported. Never seek or change launch settings to make a request pass. ${SESSION_SEQUENCE_GUIDANCE} ${PLANNED_ARRANGEMENT_HANDOFF_GUIDANCE}`;

const FAILURE_EVIDENCE_GUIDANCE =
  "inspect-listeners ready:false with native_per_pass_validation_required means fresh validation is required for each capture, not a permanent commissioning failure and not evidence of an identity mismatch or broken listener. An already completed pass can have validated native proof while discovery still reports ready:false. An empty discovery list is not proof that devices were removed or disabled. An error code alone is not a precise cause: report failureEvidence's observed phase/check, actual versus expected values, coverage and diagnostic reference. Partial or unavailable evidence is an observability gap, not proof of a native predicate. Never invent an identity mismatch, automatically retry, edit settings or fall back to another mode to diagnose a rejection.";

export const METRIC_REPORT_PAGE_GUIDANCE =
  "This is one original-measurement report page. Inspect report.nextOffset: if non-null, call ableton_context report again for the same contextId with offset equal to that exact nextOffset, not offset + limit. Byte limits can return fewer rows than the requested limit. Follow every continuation until nextOffset is null. A request to reread or verify stored analyzer evidence requires fresh complete pages for each requested context, including after restart; earlier-turn pages cannot establish that the evidence remains available and unchanged. Complete these reads even if feature values were read first. Global acquisition metadata and feature values do not replace unread frame validity.";

const METRIC_STREAM_RECORD_GUIDANCE =
  'Every new Session or Arrangement capture returns metric-record-stream-context/v1. Use its known contextId directly: "stream-overview" gives independently verified terminal counts, gaps, native status and digests without loading the timeline. "stream-records" reads bounded values by metric and half-open native sample range. Selection precedes pagination and preserves original values, indices and full crossing supports. A page may be empty yet have nextCursor after a coarse chunk match; copy the returned continuation only for the same context and filters. For a global musical beat b, native sample = overview.geometry.startSample + (b - overview.geometry.startBeat) * overview.geometry.sampleRate * 60 / overview.geometry.tempoBpm; round sample bounds to integers. Session clip-local beats are separate from that global native anchor. Prefer narrow musical ranges and limits up to 64; do not exhaust a long timeline merely to establish coverage. Pages project digest-checked immutable chunks; their original digest does not describe the sliced records. Counts alone do not establish timbre, pitch, rhythm or silence. Preserve unavailable values, gaps and unmeasured tails.';

export const METRIC_STREAM_READ_GUIDANCE = `All completed captures support the same derive-features, list-features, get-feature, compare-features and search-features actions. For stored schema, shape and count checks, use "stream-overview" and complete "list-features" inventories, following their continuations. For "list-features", omit limit to use its default and maximum 100; copy nextCursor until absent. Its inventory.features items reference the page's deduplicated provenance, segments, sources and metadata by zero-based index. Original feature IDs, ownership and stored shapes remain explicit; generated summary prose is omitted. Do not reuse the different stream-records or get-feature page limits. Never use bash for scratch calculations, output formatting, progress markers or no-op checks. Derivation reads bounded persisted musical ranges across physical chunks, preserving native supports; it never recaptures audio or constructs a whole observation. Musical measures are not storage chunks. Applicable grids use sixteenth-note cells; not every feature is a grid. Compare the complete requested extent, not only its first few measures. "stream-summary" remains a bounded raw mel-measurement presentation, not a separate feature system. Oversized reads fail explicitly and must be narrowed. ${METRIC_STREAM_RECORD_GUIDANCE}`;

export const FEATURE_VALUE_DETAIL_GUIDANCE =
  "list-features, compare-features and search-features return metadata and distances, not feature value arrays. valueCount is a count, not values; distance is not either input vector. If the user requested values or persisted rereads, use get-feature for each requested featureId in this operation before reporting values; read page.values and needed continuations, not memory or original report rows. Preserve null/unavailable reasons. Comparison/search alone does not require these extra reads. A requested complete inventory is incomplete while nextCursor exists: follow it until absent. Never infer unread IDs or measures from derivation totals or the feature catalog.";

export const LISTENING_AGENT_GUIDANCE = `Listen returns capture status and automatically derived musical values. Captures share song transport: never batch or parallelize listening calls. Run one capture at a time; inspect current state and stop transport only if it is moving, through ordinary approval. Do not start playback separately: both listening actions start it themselves. Listening captures available metric families automatically; no metric-family selector is needed. Normally omit listenerIds; these identify installed devices, not metric or feature names. play-session-and-listen requires target.view="session", not target.kind; target.track.kind="regular" identifies the track. Read stored values with ableton_context read using a source/range or a returned readTarget; no playback, derivation or inventory call is needed. Use stored compare/search for multi-measure matching instead of manually paging every timeline. Default pages contain compact musical values, units, normalization, channel validity and coverage. Segment-level availability rows preserve unavailable ranges and reasons with null values; they are not grid cells or measured zeros. Follow nextCursor for remaining values. Only when needed, use the same target with detail="evidence" for full canonical metadata and support intervals, or detail="original-measurements" for native analyzer frames; these are separate optional detail streams, not prerequisites for musical interpretation. Missing evidence never authorizes replay; neither does a forgotten capture target. Prepare stopped transport and the requested source through ordinary approvals. Session clips and Arrangement are distinct; a planned Session-to-Arrangement handoff requires stopped transport and Back to Arrangement. Never repair/retry a rejected pass automatically. Capture leaves playback running. Source attribution is not exclusive and timing is descriptive, not sample-accurate. ${LISTENING_FEATURE_CATALOG}`;

const captureDeadlineSchema = z
  .number()
  .int()
  .min(1)
  .max(900_000)
  .default(900_000)
  .describe(
    "Optional wall-clock safety deadline, not musical duration. Normally omit to use the application default; do not invent a shorter deadline for a request expressed in beats.",
  );

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
      listenerIds: listenerIds
        .refine((values) => values.length === 1, {
          message: "Session listening requires one same-track listener",
        })
        .optional(),
      listenerDeviceReference: id.optional(),
      durationBeats: z
        .number()
        .finite()
        .positive()
        .optional()
        .describe(
          "Omit to capture exactly one active loop, or the active nonlooping start/end region. An explicit duration may be shorter, never longer. Ranges exceeding 600 seconds or bounded native acquisition limits are rejected, not truncated.",
        ),
      maximumDurationMs: captureDeadlineSchema,
    })
    .strict()
    .describe(
      `Explicitly launch one exact Session MIDI or warped-audio clip through one same-track listener with the negotiated finite-stream capability. Omitted duration captures one active loop or the nonlooping active start/end region; explicit shorter ranges and equality at the active end are supported. The 600-second acquisition ceiling is mandatory; oversized ranges fail without truncation. ${SESSION_LAUNCH_CASE_GUIDANCE} Requires recording off, zero offsets and Trigger/legato off. Normal wrap or natural end after coverage requires both monitored source-boundary and completed native DSP evidence, never queued acceptance. Cancellation never retracts an accepted launch or stops transport.`,
    ),
  z
    .object({
      action: z.literal("play-arrangement-and-listen"),
      listenerIds: listenerIds.optional(),
      sources: z
        .array(
          z.strictObject({
            track: trackLocationSchema,
            listenerDeviceReference: id.optional(),
          }),
        )
        .min(1)
        .max(8)
        .optional(),
      startBeat: z
        .number()
        .finite()
        .nonnegative()
        .describe(
          "Absolute zero-based Arrangement starting beat, not bars. Omit both bounds to use all clips on the explicitly selected tracks.",
        )
        .optional(),
      endBeat: z
        .number()
        .finite()
        .positive()
        .describe(
          "The absolute ending beat, not a duration; must be greater than startBeat.",
        )
        .optional(),
      maximumDurationMs: captureDeadlineSchema,
    })
    .strict()
    .refine(
      (range) =>
        (range.listenerIds !== undefined || range.sources !== undefined) &&
        ((range.startBeat === undefined &&
          range.endBeat === undefined &&
          range.sources !== undefined) ||
          (range.startBeat !== undefined &&
            range.endBeat !== undefined &&
            range.endBeat > range.startBeat)),
      {
        message: "Arrangement end must follow its start",
      },
    )
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
        analyses: z.array(analysisPageSchema).max(8).optional(),
        analysisFailures: z
          .array(captureAnalysisFailureSchema)
          .max(8)
          .optional(),
        analysisStatus: z
          .enum([
            "ready",
            "partial",
            "unavailable",
            "failed",
            "cancelled",
            "timed-out",
          ])
          .optional(),
        analysisError: z.string().max(512).optional(),
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

const pruneContextParamsSchema = z.strictObject({
  action: z.literal("prune"),
  contextIds: z
    .array(id)
    .min(1)
    .max(100)
    .refine((ids) => new Set(ids).size === ids.length),
  confirm: z.literal("prune-session-context"),
});
export const contextOperationParamsSchema = z.discriminatedUnion("action", [
  ...analysisOperationParamsSchema.options,
  z.strictObject({
    action: z.literal("read-captures"),
    contextIds: z.array(id).min(1).max(8),
  }),
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
    .describe(
      `Compare stored feature pairs with their canonical numeric distance and explicit coverage. ${FEATURE_VALUE_DETAIL_GUIDANCE}`,
    ),
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
  pruneContextParamsSchema,
]);

/** Only musical reads and explicit destructive management are agent operations.
 * The broader union remains typed application diagnostics, not registered aliases. */
export const agentContextOperationParamsSchema = z.discriminatedUnion(
  "action",
  [...analysisOperationParamsSchema.options, pruneContextParamsSchema],
);
export type AgentContextOperationParams = z.infer<
  typeof agentContextOperationParamsSchema
>;

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
  ...analysisOperationResultSchema.options,
  z.strictObject({
    action: z.literal("read-captures"),
    analyses: z.array(analysisPageSchema).max(8),
    failures: z.array(captureAnalysisFailureSchema).max(8),
  }),
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
          coverage: listeningFeatureComparisonCoverageSchema.optional(),
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

const CAPTURE_READ_GUIDANCE =
  'Exact capture targets read recorded evidence even when freshness is unknown; this does not prove the live source unchanged. Ordinary source lookups require positive freshness. Stale, unresolved or historical evidence requires explicit includeHistorical. For structure/count checks, read detail="feature-shapes": complete per-segment feature types, dimensions, stored value/cell counts and availability without numeric arrays. These are whole stored segment shapes, not recomputed cropped shapes or numerical-value evidence. Read continuations need only {action:"read",cursor:nextCursor}; the signed cursor retains target, detail and historical scope. Any resupplied fields must match; no discovery or Bash is needed. For complete values or shape reports, consume every continuation until nextCursor is null, for each capture and again after restart. Overview counts and sampled measures do not replace unread values or feature shapes. If you cannot finish, explicitly report incomplete coverage; never claim all pages were consumed.';

export function createListeningTools(
  services: ListeningToolServices,
): [Tool<ListeningOperationParams>, Tool<AgentContextOperationParams>] {
  return [
    defineTool("ableton_listening", {
      description: `${LISTENING_AGENT_GUIDANCE} ${CAPTURE_READ_GUIDANCE}`,
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
            nextCaptureGuidance:
              SESSION_SEQUENCE_GUIDANCE +
              " " +
              PLANNED_ARRANGEMENT_HANDOFF_GUIDANCE,
            ...result,
          };
        return result;
      },
    }),
    defineTool("ableton_context", {
      description: `Read stored musical analysis by inspected source and optional beat range, or copy a returned readTarget unchanged for one-call drill-down. Ordinary source reads choose the newest positively fresh covering capture; never recapture. Default read pages prioritize actual musical values and coverage without repeated storage identities, definitions or full support arrays. For optional canonical metadata and complete native support, request detail="evidence" with the same target; original-measurements instead reads original analyzer frames. Select range/featureTypes on the target to narrow either detail stream. Compare returns separate canonical feature distances across the complete requested extent, not identity probabilities. Search defaults to mel-grid/v1 spectral content, topK=10 (maximum 20), excludes its query capture unless withinCapture=true, and scans the complete bounded scope before ranking. Results contain actual canonical values, temporal coverage and pinned continuations within 64 KiB. Compare/search continuations reuse the original arguments with nextCursor; no discovery or Bash is needed. Null/unavailable is not zero. Prune requires approval and only deletes explicitly named App-session evidence. ${CAPTURE_READ_GUIDANCE} ${LISTENING_FEATURE_CATALOG}`,
      parameters: agentContextOperationParamsSchema,
      handler: async (params, invocation) =>
        executeContextDiagnosticOperation(
          services,
          agentContextOperationParamsSchema.parse(params),
          invocation,
        ),
    }),
  ];
}

/** Typed application diagnostic boundary; not an agent tool or operation alias. */
export async function executeContextDiagnosticOperation(
  services: Pick<ListeningToolServices, "executeContextOperation">,
  params: ContextOperationParams,
  invocation: ToolInvocation,
): Promise<ContextOperationResult> {
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
    ((request.metric !== undefined && result.page.metric !== request.metric) ||
      result.page.records.length + result.page.gaps.length > request.limit)
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
      Math.min(result.page.limit, result.page.totalCells - result.page.offset),
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
          (listeningFeatureDefinition(result.feature.record.feature.type).grid
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
        result.distanceUnits !== result.query.record.feature.distanceUnits ||
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
    throw new Error("Feature context response exceeds 64 KiB UTF-8 budget");
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
}
