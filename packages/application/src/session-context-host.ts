import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  sanitizeTelemetryAttributes,
  sanitizePersistedText,
  type NonBlockingObservabilityRecorder,
} from "@ableton-agent/observability";
import { z } from "zod";
import type {
  ContextEntry,
  ContextEntrySummary,
  ContextFeature,
  ContextOperationOptions,
  EntityContextRepository,
} from "@ableton-agent/project-state";
import {
  contextOperationParamsSchema,
  contextOperationResultSchema,
  projectListeningFeatureRecord,
  projectListeningFeatureInventory,
  projectListeningFeaturePage,
  projectListeningFeatureDerivation,
  type ContextOperationResult,
  MAX_METRIC_CONTEXT_RESPONSE_BYTES,
  captureAnalysisTargetSchema,
  projectListeningTimeline,
  projectListeningOverview,
  analysisOperationResultSchema,
  analysisReadParamsSchema,
  type CaptureAnalysisTarget,
  type PassageAnalysisTarget,
  type AnalysisSource,
  type AnalysisPage,
  type AnalysisOperationParams,
  type AnalysisOperationResult,
  type ListeningAnalysisFeature,
} from "@ableton-agent/tools";
import type {
  CopilotAgentServiceOptions,
  ListeningExecutionContext,
} from "./index.js";
import {
  ListeningFailure,
  awaitListeningBoundary,
} from "./listening-coordinator.js";
import {
  listeningDisagreementMilliseconds,
  storedObservationCoordinates,
  storedObservationIdentity,
  type MetricAudioObservation,
  projectMetricListeningReport,
  LISTENING_FEATURE_DEFINITIONS,
  compareListeningFeatures,
  listeningFeatureDefinition,
  MAX_METRIC_RECORD_CHUNK_BYTES,
  aggregateMelBandFrames,
  type MetricRecordStreamGap,
  type ListeningFeatureType,
} from "@ableton-agent/protocol";

type CompleteAnalysisOperationParams =
  | Exclude<AnalysisOperationParams, { action: "read" }>
  | z.infer<typeof analysisReadParamsSchema>;

const continuationSchema = z.strictObject({
  binding: z.string().length(64),
  afterSequence: z.number().int().min(-1),
  entryOffset: z.number().int().min(0).max(255),
  chunkDigest: z.string().length(64).nullable(),
});
const inventoryCursorSchema = z.strictObject({
  binding: z.string().length(64),
  cursor: z.string().max(2048),
});
function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function encodeCursor(value: unknown): string {
  const encoded = Buffer.from(JSON.stringify(value)).toString("base64url");
  if (encoded.length > 32768)
    throw new ListeningFailure(
      "invalid_cursor",
      "Context continuation exceeds its bounded encoding",
    );
  return encoded;
}
function decodeCursor<T>(
  value: string,
  schema: z.ZodType<T>,
  binding: string,
): T {
  try {
    const parsed = schema.parse(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
    );
    if ((parsed as { binding: string }).binding !== binding)
      throw new Error("Scope mismatch");
    return parsed;
  } catch {
    throw new ListeningFailure(
      "invalid_cursor",
      "Context continuation does not match its owner, context or filters",
    );
  }
}
function metricSummary(value: MetricAudioObservation): string[] {
  const result = [
    `Metric observation outcome ${value.outcome}; trustworthy retained data only`,
  ];
  for (const name of ["level", "spectral-centroid", "attacks"] as const) {
    const metric = value.metrics[name];
    result.push(
      `${name} ${metric.status}: ${metric.records.length}/${metric.expectedRecords} validated records; ${metric.gaps.reduce((sum, gap) => sum + gap.count, 0)} missing records${metric.gaps.length ? ` (${[...new Set(metric.gaps.map((gap) => gap.reason))].join(", ")})` : ""}`,
    );
  }
  const levels = value.metrics.level.records;
  if (levels.length) {
    const ranges = ([0, 1] as const).map((channel) => {
      const rms = levels.map((record) => record.rms[channel]);
      const format = (linear: number) =>
        linear === 0
          ? "silence (measured zero)"
          : `${(20 * Math.log10(linear)).toFixed(2)} dBFS`;
      return `${format(Math.min(...rms))} to ${format(Math.max(...rms))}`;
    });
    result.push(
      `Retained level records: RMS ranges ${ranges.join(", ")}; not LUFS (not a whole-pass aggregate)`,
    );
  }
  const frames = value.metrics["spectral-centroid"].records;
  if (frames.length) {
    const centroids = frames.flatMap((record) =>
      record.centroidHz === null ? [] : [record.centroidHz],
    );
    result.push(
      `Retained FFT frames: ${centroids.length ? `centroid range ${Math.min(...centroids).toFixed(1)}-${Math.max(...centroids).toFixed(1)} Hz` : "no defined centroid"}; ${frames.filter((record) => record.spectralEnergy === 0).length} measured zero-energy frames`,
    );
  }
  if (value.metrics.attacks.records.length) {
    result.push(
      `${value.metrics.attacks.records.reduce((sum, window) => sum + window.events.length, 0)} estimated attacks across retained independent windows`,
    );
  }
  result.push(
    "Missing data and no-frame intervals are not silence; FFT actual support and attack windows differ from report rows",
  );
  return result;
}

export interface SessionContextHostOptions {
  /** The host resolves the invoking session, never the globally selected one. */
  readonly resolveRepository: (
    context: ListeningExecutionContext,
  ) => Promise<EntityContextRepository>;
  readonly signal?: AbortSignal;
  readonly telemetry?: Pick<NonBlockingObservabilityRecorder, "enqueue">;
}

type ContextSummary = Extract<
  ContextOperationResult,
  { action: "list" }
>["entries"][number];

function operationOptions(
  context: ListeningExecutionContext,
  signal: AbortSignal | undefined,
): ContextOperationOptions {
  const operationSignal =
    context.signal === undefined
      ? signal
      : signal === undefined
        ? context.signal
        : AbortSignal.any([context.signal, signal]);
  return {
    trace: context.trace,
    ...(context.actorKind === "application"
      ? {}
      : { activeAgentId: context.agentId }),
    ...(operationSignal === undefined ? {} : { signal: operationSignal }),
  };
}

async function summarize(
  repository: EntityContextRepository,
  entry: ContextEntry | ContextEntrySummary,
  includeHistorical: boolean,
  options: ContextOperationOptions,
  subjectId?: string,
): Promise<ContextSummary> {
  const links = await repository.listLinks(
    {
      entryId: entry.id,
      includeHistorical,
      limit: 100,
      ...(subjectId === undefined ? {} : { subjectId }),
    },
    options,
  );
  const link =
    subjectId === undefined
      ? links.items.find(({ relationship }) => relationship === "primary")
      : links.items.find((candidate) => candidate.subjectId === subjectId);
  if (link === undefined) {
    throw new ListeningFailure(
      "context_binding_unavailable",
      "Context observation has no available subject association for this query",
    );
  }
  const subject = await repository.getSubject(link.subjectId, options);
  if (subject === undefined) {
    throw new ListeningFailure(
      "context_binding_unavailable",
      "Context subject is missing",
    );
  }
  const payload =
    entry.payload.schema === "metric-audio-observation/v1"
      ? "rows" in entry.payload
        ? entry.payload
        : (await repository.getEntry(entry.id, options))?.payload
      : entry.payload;
  if (payload === undefined) {
    throw new ListeningFailure(
      "not_found",
      "Context observation no longer exists",
    );
  }
  if (payload.schema === "metric-record-stream-context/v1") {
    const { descriptor } = payload;
    const derivation = await repository.getFeatureDerivation(entry.id, options);
    const source = descriptor.source;
    const geometry = descriptor.geometry;
    return {
      contextId: entry.id,
      passId: entry.passId,
      listenerId: entry.producer.listenerId,
      subjectId: subject.id,
      kind: entry.kind,
      createdAt: entry.createdAt,
      freshness:
        includeHistorical && link.freshness.status === "fresh"
          ? "historical"
          : link.freshness.status,
      summary: [
        `${subject.kind}: ${subject.binding.semanticLocator.name}`,
        `Derived features ${derivation?.status ?? "not-derived"}${derivation?.reason ? `: ${derivation.reason}` : ""}; discovery and comparisons use typed feature actions, not new capture`,
        `Observed ${"coordinate" in link.coverage ? link.coverage.coordinate : "beats"} ${link.coverage.startBeat}-${link.coverage.endBeat}`,
        `${source.view} source; measured global beats ${source.transport.startBeat}-${source.transport.endBeat}; native samples ${geometry.startSample}-${geometry.endSample} at ${geometry.sampleRate} Hz`,
        ...(source.view === "session"
          ? [
              `Session first iteration (0), clip-local beats ${source.coordinate.startBeat}-${source.coordinate.endBeat}`,
            ]
          : []),
        ...descriptor.algorithms.map(
          (item) =>
            `${item.metric}: ${item.availability}${item.unavailableReason ? ` (${item.unavailableReason})` : ""}`,
        ),
        "Immutable incrementally persisted measurements; original supports remain available through bounded record reads",
        "Source references are connection-scoped; exclusive audio attribution is not certified",
      ]
        .join(". ")
        .slice(0, 2048),
    };
  }
  const coords =
    payload.schema === "metric-audio-observation/v1"
      ? storedObservationCoordinates(payload)
      : payload;
  const identity =
    payload.schema === "metric-audio-observation/v1"
      ? storedObservationIdentity(payload)
      : payload;
  const measurements =
    payload.schema === "metric-audio-observation/v1"
      ? metricSummary(payload)
      : [
          `Peak ${payload.summaries.peak.map((value) => value.toFixed(4)).join(", ")} linear`,
          `RMS ${payload.summaries.rmsDbfs.map((value) => (value === null ? "silence/below floor" : `${value.toFixed(2)} dBFS`)).join(", ")}; not LUFS`,
          `Centroid ${payload.summaries.centroidHz === null ? "not observed" : `${payload.summaries.centroidHz.toFixed(1)} Hz`}`,
        ];
  const freshness =
    includeHistorical && link.freshness.status === "fresh"
      ? "historical"
      : link.freshness.status;
  const quality =
    payload.schema !== "audio-observation/v1" ? payload.alignment : undefined;
  const observed = (samples: number) =>
    `${samples} samples (${listeningDisagreementMilliseconds(
      samples,
      coords.sampleRate,
    ).toFixed(3)} ms)`;
  const derivation = await repository.getFeatureDerivation(entry.id, options);
  return {
    contextId: entry.id,
    passId: identity.passId,
    listenerId: identity.listenerId,
    subjectId: subject.id,
    kind: entry.kind,
    createdAt: entry.createdAt,
    freshness,
    summary: [
      `${subject.kind}: ${subject.binding.semanticLocator.name}`,
      `Derived features ${derivation?.status ?? "not-derived"}${derivation?.reason ? `: ${derivation.reason}` : ""}; discovery and comparisons use typed feature actions, not new capture`,
      ...(payload.schema === "metric-audio-observation/v1" ? measurements : []),
      `Observed ${"coordinate" in link.coverage ? link.coverage.coordinate : "beats"} ${link.coverage.startBeat}-${link.coverage.endBeat}`,
      ...(payload.schema === "metric-audio-observation/v1"
        ? [
            `Measured beats ${coords.startBeat}-${coords.endBeat}; samples ${coords.startSample}-${coords.endSample} at ${coords.sampleRate} Hz`,
            ...(payload.source.view === "session"
              ? [
                  `Session first iteration (0), clip-local beats 0-${coords.endBeat}; global transport beats ${payload.source.transport.startBeat}-${payload.source.transport.endBeat}; ${payload.source.kind}; connection-scoped references, not physical source proof`,
                ]
              : [
                  "Arrangement source; connection-scoped references, not physical source proof",
                ]),
          ]
        : []),
      ...(entry.payload.schema === "session-audio-observation/v1"
        ? [
            `Session first iteration (0), clip-local beats 0-${entry.payload.endBeat}; global transport beats ${entry.payload.source.transport.startBeat}-${entry.payload.source.transport.endBeat}`,
            `Message-rate origin and monitored continuity are approximate evidence, not physical source proof; clip references are connection-scoped, not durable Live identities`,
            ...(entry.payload.source.continuity.followActions === "unknown"
              ? [
                  "Follow actions unknown, not disabled; continuity is message-rate monitored and detection-limited",
                ]
              : []),
          ]
        : []),
      ...(quality
        ? [
            `Approximate descriptive-only timing; absolute error unknown`,
            `Policy ${quality.policy.mode}; configured disagreement limit ${observed(quality.policy.maxClockDisagreementSamples)}`,
            `Observed clock disagreement ${observed(quality.observedClockDisagreementSamples)}; beat disagreement ${observed(quality.observedBeatDisagreementSamples)}`,
          ]
        : []),
      `Attribution ${link.attribution}; ${link.relationship} association`,
      ...(payload.schema === "metric-audio-observation/v1" ? [] : measurements),
      `Freshness ${freshness}; historical bindings are not current bridge references`,
    ]
      .join(". ")
      .slice(0, 2048),
  };
}

export function createSessionContextHost(
  options: SessionContextHostOptions,
): Required<
  Pick<
    CopilotAgentServiceOptions,
    "executeContextOperation" | "getSessionContextInventory"
  >
> {
  // Continuations are instance-bound; durable read targets can start a fresh read.
  const cursorKey = randomBytes(32);
  const signCursor = (payload: unknown) =>
    createHmac("sha256", cursorKey)
      .update(JSON.stringify(payload))
      .digest("hex");
  const encodeAnalysisCursor = (payload: object) =>
    encodeCursor({ ...payload, signature: signCursor(payload) });
  const decodeAnalysisCursor = <T>(
    value: string,
    schema: z.ZodType<T>,
    binding?: string,
  ): T => {
    try {
      const { signature, ...payload } = z
        .object({ signature: z.string().regex(/^[a-f0-9]{64}$/) })
        .catchall(z.unknown())
        .parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
      if (
        !timingSafeEqual(
          Buffer.from(signature, "hex"),
          Buffer.from(signCursor(payload), "hex"),
        )
      )
        throw new Error("Invalid signature");
      return binding === undefined
        ? schema.parse(payload)
        : decodeCursor(encodeCursor(payload), schema, binding);
    } catch {
      throw new ListeningFailure(
        "invalid_cursor",
        "Analysis continuation is invalid, changed, or expired; restart from its read target",
      );
    }
  };
  const analysisStage = async <T>(
    stage: string,
    repository: EntityContextRepository,
    operation: ContextOperationOptions,
    task: () => Promise<T>,
    attributes: Record<string, unknown> = {},
  ): Promise<T> => {
    const started = performance.now();
    const emit = (
      phase:
        | "queued"
        | "started"
        | "progress"
        | "completed"
        | "failed"
        | "cancelled",
    ) => {
      options.telemetry?.enqueue({
        version: 2,
        id: randomUUID(),
        occurredAt: new Date().toISOString(),
        name: `listening.analysis.${stage}.${phase}`,
        source: "session-context-host",
        category: "listening",
        stage,
        level: phase === "failed" ? "error" : "info",
        outcome:
          phase === "completed"
            ? "success"
            : phase === "failed"
              ? "failure"
              : phase === "cancelled"
                ? "cancelled"
                : "unknown",
        durationMs: Math.max(0, performance.now() - started),
        sessionId: sanitizePersistedText(repository.sessionId),
        liveSetId: sanitizePersistedText(repository.liveSetId),
        ...(operation.activeAgentId
          ? { activeAgentId: sanitizePersistedText(operation.activeAgentId) }
          : {}),
        ...(operation.trace
          ? {
              correlationId: sanitizePersistedText(
                operation.trace.correlationId,
              ),
              causationId: sanitizePersistedText(operation.trace.causationId),
              trace: { traceId: operation.trace.traceId, spanId: randomUUID() },
            }
          : {}),
        attributes: sanitizeTelemetryAttributes({ stage, ...attributes }),
      });
    };
    emit("queued");
    try {
      operation.signal?.throwIfAborted();
      emit("started");
      const result = await task();
      operation.signal?.throwIfAborted();
      emit("progress");
      emit("completed");
      return result;
    } catch (error) {
      emit(operation.signal?.aborted ? "cancelled" : "failed");
      throw error;
    }
  };
  const repositoryFor = async (context: ListeningExecutionContext) => {
    const { signal } = operationOptions(context, options.signal);
    signal?.throwIfAborted();
    const repository = await awaitListeningBoundary(
      options.resolveRepository(context),
      signal,
    );
    signal?.throwIfAborted();
    if (repository.sessionId !== context.sessionId) {
      throw new ListeningFailure(
        "permission_denied",
        "Context repository belongs to another App session",
      );
    }
    return repository;
  };
  const requireStream = async (
    repository: EntityContextRepository,
    id: string,
    includeHistorical: boolean,
    operation: ContextOperationOptions,
  ) => {
    const record = await repository.incrementalMetrics?.getMetricCapture(
      id,
      operation,
    );
    operation.signal?.throwIfAborted();
    if (record === undefined)
      throw new ListeningFailure("not_found", "Stream context is unavailable");
    if (record.metadata.pass.sessionId !== repository.sessionId)
      throw new ListeningFailure(
        "permission_denied",
        "Stream belongs to another App session",
      );
    const available = await repository.listEntries(
      { entryId: id, includeHistorical, limit: 1 },
      operation,
    );
    if (
      record.status !== "completed" ||
      available.items[0] === undefined ||
      available.items[0].liveSetId !== record.metadata.pass.liveSetId
    )
      throw new ListeningFailure(
        "not_found",
        "Completed measurement context is unavailable",
      );
    return {
      record,
      entry: await summarize(
        repository,
        available.items[0],
        includeHistorical,
        operation,
      ),
    };
  };
  const list = async (
    repository: EntityContextRepository,
    query: Extract<
      ReturnType<typeof contextOperationParamsSchema.parse>,
      { action: "list" }
    >,
    context: ListeningExecutionContext,
  ): Promise<Extract<ContextOperationResult, { action: "list" }>> => {
    const operation = operationOptions(context, options.signal);
    const filters = {
      includeHistorical: query.includeHistorical,
      ...(query.subjectId === undefined ? {} : { subjectId: query.subjectId }),
      ...(query.listenerId === undefined
        ? {}
        : { listenerId: query.listenerId }),
      ...(query.passId === undefined ? {} : { passId: query.passId }),
    };
    const binding = fingerprint({
      sessionId: repository.sessionId,
      liveSetId: repository.liveSetId,
      action: "list",
      ...filters,
    });
    const continuation =
      query.cursor === undefined
        ? undefined
        : decodeCursor(query.cursor, inventoryCursorSchema, binding);
    const page = await repository.listEntries(
      {
        ...filters,
        limit: Math.min(query.limit, 4),
        ...(continuation ? { cursor: continuation.cursor } : {}),
      },
      operation,
    );
    const entries: ContextSummary[] = [];
    for (const item of page.items) {
      operation.signal?.throwIfAborted();
      entries.push(
        await summarize(
          repository,
          item,
          query.includeHistorical,
          operation,
          query.subjectId,
        ),
      );
    }
    operation.signal?.throwIfAborted();
    return contextOperationResultSchema.parse({
      action: "list",
      entries,
      ...(page.nextCursor === undefined
        ? {}
        : { nextCursor: encodeCursor({ binding, cursor: page.nextCursor }) }),
    }) as Extract<ContextOperationResult, { action: "list" }>;
  };
  const requireFeatureSource = async (
    repository: EntityContextRepository,
    entryId: string,
    includeHistorical: boolean,
    operation: ContextOperationOptions,
  ) => {
    const available = await repository.listEntries(
      { entryId, includeHistorical, limit: 1 },
      operation,
    );
    const entry = available.items[0];
    if (entry === undefined) {
      throw new ListeningFailure(
        "not_found",
        "Feature source is unavailable for this App session, Set or freshness scope",
      );
    }
    if (
      entry.id !== entryId ||
      entry.sessionId !== repository.sessionId ||
      entry.liveSetId !== repository.liveSetId
    ) {
      throw new ListeningFailure(
        "permission_denied",
        "Feature source ownership does not match the selected observation",
      );
    }
    return entry;
  };
  const featureView = async (
    repository: EntityContextRepository,
    featureId: string,
    includeHistorical: boolean,
    operation: ContextOperationOptions,
    snapshot?: ContextFeature,
  ) => {
    const record =
      snapshot ?? (await repository.getFeature(featureId, operation));
    if (
      record === undefined ||
      record.id !== featureId ||
      record.sessionId !== repository.sessionId ||
      record.liveSetId !== repository.liveSetId
    ) {
      throw new ListeningFailure(
        "not_found",
        "Listening feature is unavailable",
      );
    }
    const entry = await repository.getEntry(record.entryId, operation);
    if (
      entry === undefined ||
      entry.sessionId !== record.sessionId ||
      entry.liveSetId !== record.liveSetId ||
      (!includeHistorical &&
        ["stale", "historical"].includes(record.freshness?.status ?? "unknown"))
    ) {
      throw new ListeningFailure(
        "not_found",
        "Feature source is unavailable for this scope",
      );
    }
    const segment = await repository.getSegment(record.segmentId, operation);
    if (
      segment === undefined ||
      segment.entryId !== entry.id ||
      segment.sessionId !== record.sessionId ||
      segment.liveSetId !== record.liveSetId
    ) {
      throw new ListeningFailure(
        "context_binding_unavailable",
        "Feature segment source is unavailable",
      );
    }
    const subject =
      record.primarySubjectId === undefined
        ? undefined
        : await repository.getSubject(record.primarySubjectId, operation);
    if (
      subject === undefined ||
      subject.sessionId !== record.sessionId ||
      subject.liveSetId !== record.liveSetId
    ) {
      throw new ListeningFailure(
        "context_binding_unavailable",
        "Feature source association is unavailable",
      );
    }
    const assessedFreshness = record.freshness?.status ?? "unknown";
    const freshness =
      includeHistorical && assessedFreshness === "fresh"
        ? "historical"
        : assessedFreshness;
    const source: ContextSummary = {
      contextId: entry.id,
      passId: entry.passId,
      listenerId: entry.producer.listenerId,
      subjectId: subject.id,
      kind: entry.kind,
      createdAt: entry.createdAt,
      freshness,
      summary: [
        `${subject.kind}: ${subject.binding.semanticLocator.name}`,
        `${record.feature.type}, ${record.feature.status}, ${record.feature.units}`,
        `${segment.kind}; ${segment.coordinate} ${segment.startBeat}-${segment.endBeat}`,
        `${record.feature.coveredSamples}/${record.feature.expectedSamples} supported samples; ${record.feature.durationSeconds} seconds`,
        "Source identity association is not exclusive audio attribution",
        `Freshness ${freshness}; retained from the feature query, not revalidated during presentation`,
      ]
        .join(". ")
        .slice(0, 1024),
    };
    return {
      record,
      segment,
      source,
    };
  };
  const presentFeature = (view: Awaited<ReturnType<typeof featureView>>) => ({
    ...view,
    record: projectListeningFeatureRecord(view.record),
  });

  const assertCaptureOwnership = async (
    repository: EntityContextRepository,
    entryId: string,
    operation: ContextOperationOptions,
  ) => {
    operation.signal?.throwIfAborted();
    const entry = await repository.getEntry(entryId, operation);
    operation.signal?.throwIfAborted();
    // Missing data is source availability, not proof of a foreign owner.
    if (
      entry &&
      (entry.id !== entryId ||
        entry.sessionId !== repository.sessionId ||
        entry.liveSetId !== repository.liveSetId)
    )
      throw new ListeningFailure(
        "permission_denied",
        "Feature source ownership does not match the selected observation",
      );
  };

  const captureSource = async (
    repository: EntityContextRepository,
    entryId: string,
    includeHistorical: boolean,
    operation: ContextOperationOptions,
    requested?: CaptureAnalysisTarget,
    expectedName?: string,
    requireFresh = false,
  ): Promise<AnalysisSource> => {
    if (
      requested &&
      (requested.sessionId !== repository.sessionId ||
        requested.liveSetId !== repository.liveSetId)
    )
      throw new ListeningFailure(
        "permission_denied",
        "Analysis target belongs to another session or Live Set",
      );
    const entry = await requireFeatureSource(
      repository,
      entryId,
      includeHistorical,
      operation,
    );
    const links = await repository.listLinks(
      { entryId, includeHistorical, limit: 100 },
      operation,
    );
    const link = links.items.find(
      (candidate) => candidate.relationship === "primary",
    );
    if (
      link &&
      (link.entryId !== entryId ||
        link.sessionId !== repository.sessionId ||
        link.liveSetId !== repository.liveSetId)
    )
      throw new ListeningFailure(
        "permission_denied",
        "Analysis source link belongs to another observation or owner",
      );
    if (!link)
      throw new ListeningFailure(
        "context_binding_unavailable",
        "Recorded source binding is unavailable",
      );
    const subject = await repository.getSubject(link.subjectId, operation);
    if (!subject)
      throw new ListeningFailure(
        "context_binding_unavailable",
        "Recorded source binding is unavailable",
      );
    if (
      subject.id !== link.subjectId ||
      subject.sessionId !== repository.sessionId ||
      subject.liveSetId !== repository.liveSetId
    )
      throw new ListeningFailure(
        "permission_denied",
        "Recorded source binding belongs to another observation or owner",
      );
    if (
      !includeHistorical &&
      link.freshness.status !== "fresh" &&
      (requireFresh || link.freshness.status !== "unknown")
    )
      throw new ListeningFailure(
        "analysis_not_fresh",
        "The recorded source is not positively fresh; inspect the source or explicitly request historical evidence",
      );
    if (
      expectedName !== undefined &&
      subject.binding.semanticLocator.name !== expectedName
    )
      throw new ListeningFailure(
        "analysis_source_mismatch",
        "The recorded source name does not match the inspected source",
      );
    const payload = entry.payload;
    const source =
      payload.schema === "metric-record-stream-context/v1"
        ? payload.descriptor.source
        : payload.schema === "metric-audio-observation/v1" ||
            payload.schema === "session-audio-observation/v1"
          ? payload.source
          : undefined;
    const coordinate =
      source?.view === "session"
        ? ("clip-local-beats" as const)
        : ("transport-beats" as const);
    const observedRange = {
      startBeat: link.coverage.startBeat,
      endBeat: link.coverage.endBeat,
    };
    const range = requested?.range ?? observedRange;
    if (
      requested &&
      (requested.coordinate !== coordinate ||
        range.startBeat < observedRange.startBeat ||
        range.endBeat > observedRange.endBeat)
    )
      throw new ListeningFailure(
        "analysis_range_not_covered",
        "The recorded source does not cover this coordinate and complete requested range",
      );
    const readTarget: CaptureAnalysisTarget = {
      kind: "capture",
      sessionId: repository.sessionId,
      liveSetId: repository.liveSetId,
      contextId: entryId,
      coordinate,
      range,
      ...(requested?.featureTypes
        ? { featureTypes: requested.featureTypes }
        : {}),
    };
    const geometry =
      payload.schema === "metric-record-stream-context/v1"
        ? payload.descriptor.geometry
        : payload.schema === "metric-audio-observation/v1"
          ? payload.geometry
          : undefined;
    return {
      schema: entry.kind,
      name: subject.binding.semanticLocator.name.slice(0, 128),
      nameTruncated: subject.binding.semanticLocator.name.length > 128,
      location:
        source?.view === "session"
          ? `Session track ${source.target.track.index + 1}, scene ${source.target.sceneIndex + 1}`
          : source?.view === "arrangement"
            ? `Arrangement ${source.target.kind}${source.target.index === null ? "" : ` track ${source.target.index + 1}`}`
            : `${subject.kind}:${subject.location ?? "track"}`,
      capturedAt: new Date(entry.capturedAt).toISOString(),
      coordinate,
      observedRange,
      requestedRange: range,
      readTarget,
      freshness: link.freshness.status,
      ...(geometry
        ? {
            geometry: {
              sampleRate: geometry.sampleRate,
              tempoBpm: geometry.tempoBpm,
              captureStartSample: geometry.startSample,
              transportStartBeat: geometry.startBeat,
            },
          }
        : {}),
    };
  };
  const resolveAnalysis = async (
    repository: EntityContextRepository,
    target: PassageAnalysisTarget,
    includeHistorical: boolean,
    operation: ContextOperationOptions,
  ): Promise<AnalysisSource> => {
    if (target.kind === "capture")
      return captureSource(
        repository,
        target.contextId,
        includeHistorical,
        operation,
        target,
      );
    const candidates: ContextEntrySummary[] = [];
    let cursor: string | undefined;
    let scanned = 0;
    do {
      const page = await repository.listEntries(
        { includeHistorical: false, limit: 100, ...(cursor ? { cursor } : {}) },
        operation,
      );
      scanned += page.items.length;
      for (const entry of page.items) {
        const payload = entry.payload;
        const source =
          payload.schema === "metric-record-stream-context/v1"
            ? payload.descriptor.source
            : payload.schema === "metric-audio-observation/v1" ||
                payload.schema === "session-audio-observation/v1"
              ? payload.source
              : undefined;
        if (!source || source.view !== target.source.view) continue;
        const track =
          source.view === "session" ? source.target.track : source.target;
        if (
          track.expectedReference !== target.source.track.expectedReference ||
          track.kind !== target.source.track.kind ||
          ("index" in track &&
            "index" in target.source.track &&
            track.index !== target.source.track.index)
        )
          continue;
        if (source.view === "session") {
          if (
            target.source.view !== "session" ||
            source.target.expectedClipReference !==
              target.source.expectedClipReference ||
            source.target.expectedClipName !== target.source.expectedClipName ||
            source.target.sceneIndex !== target.source.sceneIndex ||
            source.target.track.expectedName !==
              target.source.track.expectedName
          )
            continue;
        }
        const extent =
          source.view === "session" ? source.coordinate : source.transport;
        if (
          target.range &&
          (target.range.startBeat < extent.startBeat ||
            target.range.endBeat > extent.endBeat)
        )
          continue;
        candidates.push(entry);
      }
      cursor = page.nextCursor;
      if (cursor && scanned >= 1000)
        throw new ListeningFailure(
          "analysis_scan_limit",
          "Newest capture selection exceeded 1000 entries; use an exact returned readTarget",
        );
    } while (cursor);
    candidates.sort(
      (a, b) =>
        Date.parse(b.capturedAt) - Date.parse(a.capturedAt) ||
        b.id.localeCompare(a.id),
    );
    for (const entry of candidates) {
      try {
        const source = await captureSource(
          repository,
          entry.id,
          false,
          operation,
          undefined,
          target.source.view === "session"
            ? target.source.expectedClipName
            : target.source.track.expectedName,
          true,
        );
        const readTarget = {
          ...source.readTarget,
          range: target.range ?? source.observedRange,
          ...(target.featureTypes ? { featureTypes: target.featureTypes } : {}),
        };
        return { ...source, readTarget, requestedRange: readTarget.range };
      } catch (error) {
        if (
          !(error instanceof ListeningFailure) ||
          (error.code !== "analysis_not_fresh" &&
            error.code !== "analysis_source_mismatch")
        )
          throw error;
      }
    }
    throw new ListeningFailure(
      "analysis_not_found",
      "No positively fresh covering capture matches this exact source. No playback was started",
    );
  };
  const assertAnalysisBinding = async (
    repository: EntityContextRepository,
    analysisSource: AnalysisSource,
    original: PassageAnalysisTarget,
    includeHistorical: boolean,
    operation: ContextOperationOptions,
  ) => {
    if (original.kind === "capture") {
      if (fingerprint(original) !== fingerprint(analysisSource.readTarget))
        throw new ListeningFailure(
          "invalid_cursor",
          "Analysis continuation changed the requested observation",
        );
      return;
    }
    const entry = await repository.getEntry(
      analysisSource.readTarget.contextId,
      operation,
    );
    const payload = entry?.payload;
    const source =
      payload?.schema === "metric-record-stream-context/v1"
        ? payload.descriptor.source
        : payload?.schema === "metric-audio-observation/v1" ||
            payload?.schema === "session-audio-observation/v1"
          ? payload.source
          : undefined;
    const track =
      source?.view === "session" ? source.target.track : source?.target;
    if (
      !source ||
      source.view !== original.source.view ||
      track?.expectedReference !== original.source.track.expectedReference ||
      track.kind !== original.source.track.kind ||
      ("index" in track &&
        "index" in original.source.track &&
        track.index !== original.source.track.index) ||
      (source.view === "session" &&
        (original.source.view !== "session" ||
          source.target.expectedClipReference !==
            original.source.expectedClipReference ||
          source.target.expectedClipName !== original.source.expectedClipName ||
          source.target.sceneIndex !== original.source.sceneIndex)) ||
      fingerprint(analysisSource.requestedRange) !==
        fingerprint(original.range ?? analysisSource.observedRange) ||
      fingerprint(analysisSource.readTarget.featureTypes ?? []) !==
        fingerprint(original.featureTypes ?? [])
    )
      throw new ListeningFailure(
        "invalid_cursor",
        "Analysis continuation changed the selected source or requested extent",
      );
    await captureSource(
      repository,
      analysisSource.readTarget.contextId,
      includeHistorical,
      operation,
      analysisSource.readTarget,
      original.source.view === "session"
        ? original.source.expectedClipName
        : original.source.track.expectedName,
      true,
    );
  };
  const loadAnalysis = async (
    repository: EntityContextRepository,
    source: AnalysisSource,
    includeHistorical: boolean,
    operation: ContextOperationOptions,
    detail?: "evidence",
  ) => {
    const derivation = await analysisStage(
      "wait",
      repository,
      operation,
      () =>
        repository.waitForFeatureDerivation(
          source.readTarget.contextId,
          operation,
        ),
      { contextId: source.readTarget.contextId },
    );
    const views: ListeningAnalysisFeature[] = [];
    let cursor: string | undefined;
    const segments = new Map<
      string,
      NonNullable<Awaited<ReturnType<EntityContextRepository["getSegment"]>>>
    >();
    do {
      const page = await repository.listFeatures(
        {
          entryId: source.readTarget.contextId,
          includeHistorical,
          limit: 100,
          ...(cursor ? { cursor } : {}),
        },
        operation,
      );
      for (const record of page.items) {
        if (
          record.sessionId !== repository.sessionId ||
          record.liveSetId !== repository.liveSetId ||
          record.entryId !== source.readTarget.contextId
        )
          throw new ListeningFailure(
            "permission_denied",
            "Feature ownership does not match the selected observation",
          );
        if (
          !includeHistorical &&
          record.freshness?.status !== "fresh" &&
          !(
            source.freshness === "unknown" &&
            record.freshness?.status === "unknown"
          )
        )
          throw new ListeningFailure(
            "analysis_not_fresh",
            "Feature freshness changed while reading the selected observation",
          );
        if (
          source.readTarget.featureTypes &&
          !source.readTarget.featureTypes.includes(record.feature.type)
        )
          continue;
        let segment = segments.get(record.segmentId);
        segment ??= await repository.getSegment(record.segmentId, operation);
        if (!segment)
          throw new ListeningFailure(
            "context_binding_unavailable",
            "Canonical segment is unavailable",
          );
        if (
          segment.id !== record.segmentId ||
          segment.entryId !== record.entryId ||
          segment.sessionId !== repository.sessionId ||
          segment.liveSetId !== repository.liveSetId
        )
          throw new ListeningFailure(
            "permission_denied",
            "Canonical segment ownership does not match the selected observation",
          );
        segments.set(segment.id, segment);
        if (
          segment.endBeat > source.requestedRange.startBeat &&
          segment.startBeat < source.requestedRange.endBeat
        )
          views.push({ record, segment });
      }
      cursor = page.nextCursor;
      if (cursor && views.length > 7680)
        throw new ListeningFailure(
          "analysis_scan_limit",
          "Feature inventory exceeded the supported derivation bound",
        );
    } while (cursor);
    views.sort(
      (a, b) =>
        a.segment.order - b.segment.order ||
        a.record.feature.type.localeCompare(b.record.feature.type),
    );
    const entry = await repository.getEntry(
      source.readTarget.contextId,
      operation,
    );
    const startSample =
      entry?.payload.schema === "metric-record-stream-context/v1"
        ? entry.payload.descriptor.geometry.startSample
        : entry?.payload.schema === "metric-audio-observation/v1"
          ? entry.payload.geometry.startSample
          : entry && "startSample" in entry.payload
            ? entry.payload.startSample
            : Math.min(...views.map(({ segment }) => segment.startSample));
    const timeline = await analysisStage(
      "projection",
      repository,
      operation,
      async () =>
        projectListeningTimeline(
          views,
          Number.isFinite(startSample) ? startSample : 0,
          source.readTarget,
          detail,
        ),
      {
        contextId: source.readTarget.contextId,
        featureCount: views.length,
        detail: detail ?? "values",
      },
    );
    return { source, derivation, views, timeline };
  };
  type LoadedAnalysis = Awaited<ReturnType<typeof loadAnalysis>>;
  const readContinuationRequestSchema = analysisReadParamsSchema.omit({
    cursor: true,
  });
  const analysisCursorSchema = z.strictObject({
    binding: z.string().length(64),
    request: readContinuationRequestSchema.optional(),
    targets: z.array(captureAnalysisTargetSchema).min(1).max(22),
    offsets: z.array(z.number().int().nonnegative()).max(24),
    ranking: z.array(z.number().nonnegative()).max(20).optional(),
    scopeIndices: z.array(z.number().int().min(0).max(99)).max(20).optional(),
    scopeRanges: z
      .array(captureAnalysisTargetSchema.shape.range)
      .max(20)
      .optional(),
    scanned: z.number().int().nonnegative().optional(),
    skipped: z.number().int().nonnegative().optional(),
    exhaustive: z.boolean().optional(),
    overviewConsumed: z.boolean().optional(),
  });
  const analysisPage = (
    loaded: LoadedAnalysis,
    offset: number,
    budget: number,
    includeOverview: boolean,
  ): AnalysisPage => {
    const result: AnalysisPage = {
      source: loaded.source,
      readTarget: loaded.source.readTarget,
      status: loaded.derivation?.status ?? "unavailable",
      reason:
        loaded.derivation?.reason ??
        (loaded.derivation ? null : "Automatic analysis is unavailable"),
      overview: includeOverview
        ? projectListeningOverview(loaded.views, loaded.source.readTarget)
        : [],
      overviewIncluded: includeOverview,
      timeline: [],
      overviewExtent: loaded.source.requestedRange,
      detail: {
        offset,
        returnedItems: 0,
        totalItems: loaded.timeline.length,
        truncated: false,
        nextCursor: null,
      },
    };
    if (offset > loaded.timeline.length)
      throw new ListeningFailure(
        "invalid_cursor",
        "Analysis continuation is outside the immutable timeline",
      );
    for (const item of loaded.timeline.slice(offset)) {
      result.timeline.push(item);
      if (Buffer.byteLength(JSON.stringify(result)) > budget) {
        result.timeline.pop();
        break;
      }
    }
    result.detail.returnedItems = result.timeline.length;
    result.detail.truncated =
      offset + result.timeline.length < loaded.timeline.length;
    return result;
  };
  const compareAnalysis = (
    left: LoadedAnalysis,
    right: LoadedAnalysis,
    featureTypes?: readonly ListeningFeatureType[],
    detail?: "evidence",
  ): Extract<AnalysisOperationResult, { action: "compare" }> => {
    const selected =
      featureTypes ?? LISTENING_FEATURE_DEFINITIONS.map(({ type }) => type);
    const comparisons: Extract<
      AnalysisOperationResult,
      { action: "compare" }
    >["comparisons"] = [];
    const extentA = left.source.requestedRange;
    const extentB = right.source.requestedRange;
    const sameLength =
      Math.abs(
        extentA.endBeat -
          extentA.startBeat -
          (extentB.endBeat - extentB.startBeat),
      ) < 1e-9;
    const keys = new Set<string>();
    const reference = (
      record: ContextFeature,
      segment: ListeningAnalysisFeature["segment"],
      source: AnalysisSource,
    ) => ({
      featureId: record.id,
      segmentId: record.segmentId,
      sourceFingerprint: record.sourceFingerprint,
      readTarget: {
        ...source.readTarget,
        featureTypes: [record.feature.type],
        range: {
          startBeat: Math.max(
            source.requestedRange.startBeat,
            segment.startBeat,
          ),
          endBeat: Math.min(source.requestedRange.endBeat, segment.endBeat),
        },
      },
    });
    for (const { record, segment } of left.views) {
      if (!selected.includes(record.feature.type)) continue;
      const start = segment.startBeat - extentA.startBeat;
      const end = segment.endBeat - extentA.startBeat;
      const other = right.views.find(
        (candidate) =>
          candidate.record.feature.type === record.feature.type &&
          Math.abs(candidate.segment.startBeat - extentB.startBeat - start) <
            1e-9 &&
          Math.abs(candidate.segment.endBeat - extentB.startBeat - end) < 1e-9,
      );
      const complete = start >= 0 && end <= extentA.endBeat - extentA.startBeat;
      if (other) keys.add(other.record.id);
      comparisons.push({
        type: record.feature.type,
        ...(detail === "evidence"
          ? {
              definition: listeningFeatureDefinition(record.feature.type),
              leftFeature: reference(record, segment, left.source),
            }
          : {}),
        ...(other && detail === "evidence"
          ? {
              rightFeature: reference(
                other.record,
                other.segment,
                right.source,
              ),
            }
          : {}),
        left: { startBeat: segment.startBeat, endBeat: segment.endBeat },
        right: other
          ? {
              startBeat: other.segment.startBeat,
              endBeat: other.segment.endBeat,
            }
          : null,
        comparison:
          sameLength && complete && other
            ? compareListeningFeatures(record.feature, other.record.feature)
            : null,
        reason: !sameLength
          ? "unequal-requested-extents"
          : !complete
            ? "partial-canonical-segment"
            : !other
              ? "unpaired-segment"
              : null,
        ...(other
          ? {
              evidence: {
                units: record.feature.units,
                normalization: record.feature.normalization,
                leftRange: {
                  startBeat: segment.startBeat,
                  endBeat:
                    segment.startBeat +
                    (record.feature.grid?.cells[0]?.endBeat ??
                      segment.endBeat - segment.startBeat),
                },
                rightRange: {
                  startBeat: other.segment.startBeat,
                  endBeat:
                    other.segment.startBeat +
                    (other.record.feature.grid?.cells[0]?.endBeat ??
                      other.segment.endBeat - other.segment.startBeat),
                },
                leftValues:
                  record.feature.values?.slice(
                    0,
                    listeningFeatureDefinition(record.feature.type).dimensions,
                  ) ?? null,
                rightValues:
                  other.record.feature.values?.slice(
                    0,
                    listeningFeatureDefinition(other.record.feature.type)
                      .dimensions,
                  ) ?? null,
                scope: record.feature.grid
                  ? ("first-canonical-cell" as const)
                  : ("segment-summary" as const),
              },
            }
          : {}),
      });
    }
    for (const { record, segment } of right.views) {
      if (!selected.includes(record.feature.type) || keys.has(record.id))
        continue;
      comparisons.push({
        type: record.feature.type,
        ...(detail === "evidence"
          ? {
              definition: listeningFeatureDefinition(record.feature.type),
              rightFeature: reference(record, segment, right.source),
            }
          : {}),
        left: extentA,
        right: { startBeat: segment.startBeat, endBeat: segment.endBeat },
        comparison: null,
        reason: "unpaired-right-segment",
      });
    }
    for (const type of selected) {
      if (
        !left.views.some(({ record }) => record.feature.type === type) &&
        !right.views.some(({ record }) => record.feature.type === type)
      )
        continue;
      const covers = (analysis: LoadedAnalysis) => {
        let end = analysis.source.requestedRange.startBeat;
        for (const { segment } of analysis.views.filter(
          ({ record }) => record.feature.type === type,
        )) {
          if (segment.startBeat > end + 1e-9) return false;
          end = Math.max(end, segment.endBeat);
        }
        return end >= analysis.source.requestedRange.endBeat - 1e-9;
      };
      if (!covers(left) || !covers(right))
        comparisons.push({
          type,
          ...(detail === "evidence"
            ? { definition: listeningFeatureDefinition(type) }
            : {}),
          left: extentA,
          right: extentB,
          comparison: null,
          reason: "unmeasured-requested-extent",
        });
    }
    return {
      action: "compare",
      readTarget: {
        kind: "comparison",
        left: left.source.readTarget,
        right: right.source.readTarget,
      },
      left: left.source,
      right: right.source,
      comparisons,
      completeExtent:
        sameLength &&
        comparisons.length > 0 &&
        comparisons.every((item) => item.reason === null),
      nextCursor: null,
      truncated: false,
    };
  };
  const executeAnalysis = async (
    repository: EntityContextRepository,
    query: CompleteAnalysisOperationParams,
    operation: ContextOperationOptions,
    responseBudget = MAX_METRIC_CONTEXT_RESPONSE_BYTES,
    embedded = false,
  ): Promise<AnalysisOperationResult> => {
    const { cursor, ...request } = query;
    const binding = fingerprint({
      sessionId: repository.sessionId,
      liveSetId: repository.liveSetId,
      request,
    });
    const continuation = cursor
      ? decodeAnalysisCursor(cursor, analysisCursorSchema, binding)
      : undefined;
    const load = async (target: PassageAnalysisTarget) =>
      loadAnalysis(
        repository,
        await analysisStage("selection", repository, operation, () =>
          resolveAnalysis(
            repository,
            target,
            query.includeHistorical,
            operation,
          ),
        ),
        query.includeHistorical,
        operation,
        query.action === "read" && query.detail === "evidence"
          ? "evidence"
          : undefined,
      );
    if (query.action === "read" || query.action === "compare") {
      const originalTargets =
        query.action === "compare"
          ? [query.left, query.right].map((target) => ({
              ...target,
              ...(query.featureTypes
                ? { featureTypes: query.featureTypes }
                : {}),
            }))
          : query.target.kind === "comparison"
            ? [query.target.left, query.target.right]
            : [query.target];
      const targets = continuation?.targets ?? originalTargets;
      if (
        targets.length !== originalTargets.length ||
        targets.some((target, index) => {
          const original = originalTargets[index]!;
          return (
            original.kind === "capture" &&
            fingerprint(target) !== fingerprint(original)
          );
        })
      )
        throw new ListeningFailure(
          "invalid_cursor",
          "Analysis continuation changed the requested observation or feature selection",
        );
      const loaded: LoadedAnalysis[] = [];
      for (const [index, target] of targets.entries()) {
        const analysis = await load(target);
        const original = originalTargets[index]!;
        if (continuation)
          await assertAnalysisBinding(
            repository,
            analysis.source,
            original,
            query.includeHistorical,
            operation,
          );
        loaded.push(analysis);
      }
      const comparison =
        loaded.length === 2
          ? compareAnalysis(
              loaded[0]!,
              loaded[1]!,
              query.action === "compare" ? query.featureTypes : undefined,
              query.action === "read" && query.detail === "evidence"
                ? "evidence"
                : undefined,
            )
          : undefined;
      if (query.action === "compare") {
        const result = comparison!;
        const all = result.comparisons;
        const offset = continuation?.offsets[0] ?? 0;
        result.comparisons = [];
        for (const item of all.slice(offset)) {
          result.comparisons.push(item);
          if (
            Buffer.byteLength(JSON.stringify(result)) >
            MAX_METRIC_CONTEXT_RESPONSE_BYTES - 8192
          ) {
            result.comparisons.pop();
            break;
          }
        }
        result.truncated = offset + result.comparisons.length < all.length;
        if (result.truncated)
          result.nextCursor = encodeAnalysisCursor({
            binding,
            targets: loaded.map(({ source }) => source.readTarget),
            offsets: [offset + result.comparisons.length],
          });
        return result;
      }
      const fullPages = loaded.map((item, index) =>
        analysisPage(
          item,
          continuation?.offsets[index] ?? 0,
          responseBudget - 512,
          continuation?.overviewConsumed !== true,
        ),
      );
      const fullComparison = comparison
        ? {
            ...comparison,
            comparisons: comparison.comparisons.slice(
              continuation?.offsets[2] ?? 0,
            ),
          }
        : undefined;
      const fullResult = {
        action: "read" as const,
        analyses: fullPages,
        ...(fullComparison ? { comparison: fullComparison } : {}),
        nextCursor: null,
      };
      if (
        fullPages.every((page) => !page.detail.truncated) &&
        Buffer.byteLength(JSON.stringify(fullResult)) <= responseBudget
      )
        return fullResult;
      const reservedCursor = encodeAnalysisCursor({
        binding,
        request,
        targets: loaded.map(({ source }) => source.readTarget),
        overviewConsumed: true,
        offsets: [
          ...loaded.map(({ timeline }) => timeline.length),
          ...(comparison ? [comparison.comparisons.length] : []),
        ],
      });
      const continuationReserve =
        512 +
        (loaded.length + (comparison ? 1 : 0) + (embedded ? 0 : 1)) *
          Buffer.byteLength(reservedCursor) +
        (comparison
          ? Buffer.byteLength(
              JSON.stringify({ ...comparison, comparisons: [] }),
            )
          : 0);
      const analyses = loaded.map((item, index) =>
        analysisPage(
          item,
          continuation?.offsets[index] ?? 0,
          Math.floor((responseBudget - continuationReserve) / loaded.length),
          continuation?.overviewConsumed !== true,
        ),
      );
      for (const page of analyses) page.detail.nextCursor = reservedCursor;
      if (comparison) comparison.nextCursor = reservedCursor;
      const result: Extract<AnalysisOperationResult, { action: "read" }> = {
        action: "read",
        analyses,
        ...(comparison ? { comparison } : {}),
        nextCursor: reservedCursor,
      };
      // Comparison evidence is paged with the values, using the same immutable binding.
      if (comparison) {
        const offset = continuation?.offsets[2] ?? 0;
        const all = comparison.comparisons;
        comparison.comparisons = all.slice(offset);
        while (
          comparison.comparisons.length > 0 &&
          Buffer.byteLength(JSON.stringify(result)) > responseBudget
        )
          comparison.comparisons.pop();
        comparison.truncated =
          offset + comparison.comparisons.length < all.length;
      }
      const truncated =
        analyses.some((item) => item.detail.truncated) || comparison?.truncated;
      const nextCursor = truncated
        ? encodeAnalysisCursor({
            binding,
            request,
            targets: loaded.map(({ source }) => source.readTarget),
            overviewConsumed: true,
            offsets: [
              ...analyses.map(
                (item) => item.detail.offset + item.detail.returnedItems,
              ),
              ...(comparison
                ? [
                    (continuation?.offsets[2] ?? 0) +
                      comparison.comparisons.length,
                  ]
                : []),
            ],
          })
        : null;
      for (const page of analyses) page.detail.nextCursor = nextCursor;
      if (comparison) comparison.nextCursor = nextCursor;
      result.nextCursor = nextCursor;
      return result;
    }
    if (
      query.query.featureTypes &&
      !query.query.featureTypes.includes(query.featureType)
    )
      throw new ListeningFailure(
        "analysis_feature_mismatch",
        "The query target does not select the ranking feature; choose its featureType explicitly",
      );
    if (
      continuation &&
      (continuation.targets.length > query.topK + 1 ||
        continuation.ranking?.length !== continuation.targets.length - 1 ||
        continuation.scopeIndices?.length !== continuation.targets.length - 1 ||
        continuation.scopeRanges?.length !== continuation.targets.length - 1 ||
        continuation.scanned === undefined ||
        continuation.skipped === undefined ||
        continuation.exhaustive === undefined ||
        (query.query.kind === "capture" &&
          fingerprint(query.query) !== fingerprint(continuation.targets[0])))
    )
      throw new ListeningFailure(
        "invalid_cursor",
        "Search continuation does not preserve the selected query and ranking",
      );
    const queryAnalysis = await load(continuation?.targets[0] ?? query.query);
    if (continuation)
      await assertAnalysisBinding(
        repository,
        queryAnalysis.source,
        query.query,
        query.includeHistorical,
        operation,
      );
    const selected: {
      target: CaptureAnalysisTarget;
      sourceTarget: CaptureAnalysisTarget;
      scopeIndex: number;
      distance: number;
    }[] = [];
    let scannedCount = continuation?.scanned ?? 0;
    let skippedCount = continuation?.skipped ?? 0;
    let exhaustive = continuation?.exhaustive ?? true;
    if (continuation) {
      for (const [index, target] of continuation.targets.slice(1).entries()) {
        const scopeIndex = continuation.scopeIndices![index]!;
        const scope = query.scope[scopeIndex];
        const range = continuation.scopeRanges![index]!;
        if (
          !scope ||
          target.range.startBeat < range.startBeat ||
          target.range.endBeat > range.endBeat ||
          (!query.withinCapture &&
            target.contextId === queryAnalysis.source.readTarget.contextId)
        )
          throw new ListeningFailure(
            "invalid_cursor",
            "Search continuation changed its source scope or self exclusion",
          );
        selected.push({
          target,
          sourceTarget: {
            ...target,
            range,
            ...(scope.featureTypes ? { featureTypes: scope.featureTypes } : {}),
          },
          scopeIndex,
          distance: continuation.ranking![index]!,
        });
      }
    } else {
      const duration =
        queryAnalysis.source.requestedRange.endBeat -
        queryAnalysis.source.requestedRange.startBeat;
      const seen = new Set<string>();
      outer: for (const [scopeIndex, scope] of query.scope.entries()) {
        const candidate = await load(scope);
        if (
          !query.withinCapture &&
          candidate.source.readTarget.contextId ===
            queryAnalysis.source.readTarget.contextId
        ) {
          skippedCount++;
          continue;
        }
        const starts = [
          ...new Set(candidate.views.map(({ segment }) => segment.startBeat)),
        ].sort((a, b) => a - b);
        for (const startBeat of starts) {
          if (
            startBeat < candidate.source.requestedRange.startBeat ||
            startBeat + duration > candidate.source.requestedRange.endBeat
          )
            continue;
          const target = {
            ...candidate.source.readTarget,
            range: { startBeat, endBeat: startBeat + duration },
          };
          const key = fingerprint(target);
          if (seen.has(key)) continue;
          seen.add(key);
          if (scannedCount >= 1000) {
            exhaustive = false;
            break outer;
          }
          scannedCount++;
          const passage = {
            ...candidate,
            source: {
              ...candidate.source,
              readTarget: target,
              requestedRange: target.range,
            },
            views: candidate.views.filter(
              ({ segment }) =>
                segment.startBeat >= startBeat &&
                segment.endBeat <= startBeat + duration,
            ),
          };
          const comparison = compareAnalysis(queryAnalysis, passage, [
            query.featureType,
          ]);
          const comparable = comparison.comparisons.filter(
            (item) => item.comparison?.status === "comparable",
          );
          if (
            !comparison.completeExtent ||
            comparable.length === 0 ||
            comparable.length !== comparison.comparisons.length
          ) {
            skippedCount++;
            continue;
          }
          // RMS across canonical segment distances, weighted by compared values.
          let sum = 0,
            weight = 0;
          for (const item of comparable) {
            if (item.comparison?.status !== "comparable") continue;
            const count = item.comparison.coverage?.comparedValues ?? 1;
            sum += item.comparison.distance ** 2 * count;
            weight += count;
          }
          selected.push({
            target,
            sourceTarget: candidate.source.readTarget,
            scopeIndex,
            distance: Math.sqrt(sum / weight),
          });
        }
      }
      selected.sort(
        (a, b) =>
          a.distance - b.distance ||
          a.target.contextId.localeCompare(b.target.contextId) ||
          a.target.range.startBeat - b.target.range.startBeat,
      );
      selected.splice(query.topK);
    }
    const result: Extract<AnalysisOperationResult, { action: "search" }> = {
      action: "search",
      query: queryAnalysis.source,
      featureType: query.featureType,
      distanceUnits: listeningFeatureDefinition(query.featureType)
        .distanceUnits,
      aggregation: "compared-value-weighted-rms-of-segment-distances",
      requestedTopK: query.topK,
      selectedCount: selected.length,
      returnedCount: 0,
      scannedCount,
      skippedCount,
      exhaustive,
      matches: [],
      nextCursor: null,
      truncated: false,
    };
    let index = continuation?.offsets[0] ?? 0;
    let comparisonOffset = continuation?.offsets[1] ?? 0;
    const searchCursor = (index: number, offset: number) =>
      index >= selected.length
        ? null
        : encodeAnalysisCursor({
            binding,
            targets: [
              queryAnalysis.source.readTarget,
              ...selected.map(({ target }) => target),
            ],
            offsets: [index, offset],
            ranking: selected.map(({ distance }) => distance),
            scopeIndices: selected.map(({ scopeIndex }) => scopeIndex),
            scopeRanges: selected.map(({ sourceTarget }) => sourceTarget.range),
            scanned: scannedCount,
            skipped: skippedCount,
            exhaustive,
          });
    for (; index < selected.length; index++) {
      const hit = selected[index]!;
      const passage = await load(hit.target);
      if (continuation)
        await assertAnalysisBinding(
          repository,
          {
            ...passage.source,
            readTarget: hit.sourceTarget,
            requestedRange: hit.sourceTarget.range,
          },
          query.scope[hit.scopeIndex]!,
          query.includeHistorical,
          operation,
        );
      const source = await captureSource(
        repository,
        hit.target.contextId,
        query.includeHistorical,
        operation,
      );
      const evidence = compareAnalysis(queryAnalysis, passage);
      const match = {
        rank: index + 1,
        source,
        match: passage.source,
        distance: hit.distance,
        comparisons: evidence.comparisons.slice(comparisonOffset),
        evidence: {
          offset: comparisonOffset,
          total: evidence.comparisons.length,
          complete: true,
        },
      };
      result.matches.push(match);
      while (true) {
        const nextOffset = comparisonOffset + match.comparisons.length;
        match.evidence.complete = nextOffset >= evidence.comparisons.length;
        result.nextCursor = match.evidence.complete
          ? searchCursor(index + 1, 0)
          : searchCursor(index, nextOffset);
        if (
          Buffer.byteLength(JSON.stringify(result)) <=
            MAX_METRIC_CONTEXT_RESPONSE_BYTES - 1024 ||
          match.comparisons.length === 0
        )
          break;
        match.comparisons.pop();
      }
      if (match.comparisons.length === 0 && evidence.comparisons.length > 0) {
        result.matches.pop();
        break;
      }
      const nextOffset = comparisonOffset + match.comparisons.length;
      if (nextOffset < evidence.comparisons.length) {
        comparisonOffset = nextOffset;
        break;
      }
      comparisonOffset = 0;
    }
    result.truncated = index < selected.length;
    result.returnedCount = result.matches.length;
    result.nextCursor = searchCursor(index, comparisonOffset);
    return result;
  };
  const originalCursorSchema = z.strictObject({
    binding: z.string().length(64),
    request: readContinuationRequestSchema,
    target: captureAnalysisTargetSchema,
    kind: z.enum(["stream-records", "report"]),
    descriptorDigest: z.string().length(64).optional(),
    cursor: z.string().max(4096).optional(),
    offset: z.number().int().nonnegative().optional(),
  });
  const readOriginalMeasurements = async (
    repository: EntityContextRepository,
    query: z.infer<typeof analysisReadParamsSchema>,
    context: ListeningExecutionContext,
    operation: ContextOperationOptions,
  ): Promise<Extract<AnalysisOperationResult, { action: "read" }>> => {
    if (query.target.kind === "comparison")
      throw new ListeningFailure(
        "analysis_target_mismatch",
        "Original measurements require one source or capture readTarget",
      );
    const target = query.target;
    const { cursor, ...request } = query;
    const binding = fingerprint({
      sessionId: repository.sessionId,
      liveSetId: repository.liveSetId,
      request,
    });
    const continuation = cursor
      ? decodeAnalysisCursor(cursor, originalCursorSchema, binding)
      : undefined;
    const source = await analysisStage("selection", repository, operation, () =>
      resolveAnalysis(
        repository,
        continuation?.target ?? target,
        query.includeHistorical,
        operation,
      ),
    );
    if (continuation)
      await assertAnalysisBinding(
        repository,
        source,
        query.target,
        query.includeHistorical,
        operation,
      );
    const base = { action: "read" as const, analyses: [] };
    const next = (
      state: Omit<
        z.infer<typeof originalCursorSchema>,
        "binding" | "target" | "request"
      >,
    ) =>
      encodeAnalysisCursor({
        binding,
        request,
        target: source.readTarget,
        ...state,
      });
    if (source.schema === "metric-record-stream-context/v1") {
      const { record } = await requireStream(
        repository,
        source.readTarget.contextId,
        query.includeHistorical,
        operation,
      );
      const descriptorDigest = record.state.descriptorDigest;
      if (
        continuation &&
        (continuation.kind !== "stream-records" ||
          continuation.descriptorDigest !== descriptorDigest)
      )
        throw new ListeningFailure(
          "invalid_cursor",
          "Original measurement capture identity changed",
        );
      if (!continuation) {
        const result = await host.executeContextOperation(
          {
            action: "stream-overview",
            contextId: source.readTarget.contextId,
            includeHistorical: query.includeHistorical,
          },
          context,
        );
        if (result.action !== "stream-overview")
          throw new ListeningFailure(
            "invalid_result",
            "Expected original stream overview",
          );
        return {
          ...base,
          originalMeasurements: {
            kind: "stream-overview",
            source,
            overview: result.overview,
          },
          nextCursor:
            result.overview.chunkCount === 0
              ? null
              : next({ kind: "stream-records", descriptorDigest }),
        };
      }
      const geometry = record.descriptor.geometry;
      const samplesPerBeat = (geometry.sampleRate * 60) / geometry.tempoBpm;
      const range = {
        startSample:
          geometry.startSample +
          Math.round(
            (source.requestedRange.startBeat - source.observedRange.startBeat) *
              samplesPerBeat,
          ),
        endSample:
          geometry.startSample +
          Math.round(
            (source.requestedRange.endBeat - source.observedRange.startBeat) *
              samplesPerBeat,
          ),
      };
      let limit = 64;
      for (;;) {
        const result = await host.executeContextOperation(
          {
            action: "stream-records",
            contextId: source.readTarget.contextId,
            includeHistorical: query.includeHistorical,
            range,
            limit,
            ...(continuation.cursor ? { cursor: continuation.cursor } : {}),
          },
          context,
        );
        if (result.action !== "stream-records")
          throw new ListeningFailure(
            "invalid_result",
            "Expected original stream records",
          );
        const read = {
          ...base,
          originalMeasurements: {
            kind: "stream-records" as const,
            source,
            page: result.page,
          },
          nextCursor: result.nextCursor
            ? next({
                kind: "stream-records",
                descriptorDigest,
                cursor: result.nextCursor,
              })
            : null,
        };
        const bytes = Buffer.byteLength(JSON.stringify(read));
        if (bytes <= MAX_METRIC_CONTEXT_RESPONSE_BYTES) return read;
        if (limit === 1)
          throw new ListeningFailure(
            "invalid_capture",
            "A native record exceeds the canonical record bound",
          );
        limit = Math.max(
          1,
          Math.min(
            limit - 1,
            Math.floor((limit * MAX_METRIC_CONTEXT_RESPONSE_BYTES) / bytes) - 1,
          ),
        );
      }
    }
    if (source.schema !== "metric-audio-observation/v1")
      throw new ListeningFailure(
        "unsupported_context_kind",
        "Original metric evidence is unavailable for this source schema",
      );
    if (continuation && continuation.kind !== "report")
      throw new ListeningFailure(
        "invalid_cursor",
        "Original measurement source schema changed",
      );
    const first = Math.floor(
      (source.requestedRange.startBeat - source.observedRange.startBeat) / 0.25,
    );
    const end = Math.ceil(
      (source.requestedRange.endBeat - source.observedRange.startBeat) / 0.25,
    );
    const offset = continuation?.offset ?? first;
    if (offset < first || offset >= end)
      throw new ListeningFailure(
        "invalid_cursor",
        "Original report continuation changed the requested range",
      );
    const result = await host.executeContextOperation(
      {
        action: "report",
        contextId: source.readTarget.contextId,
        includeHistorical: query.includeHistorical,
        offset,
        limit: Math.min(8, end - offset),
      },
      context,
    );
    if (result.action !== "report")
      throw new ListeningFailure(
        "invalid_result",
        "Expected original measurement report",
      );
    return {
      ...base,
      originalMeasurements: { kind: "report", source, report: result.report },
      nextCursor:
        result.report.nextOffset !== null && result.report.nextOffset < end
          ? next({ kind: "report", offset: result.report.nextOffset })
          : null,
    };
  };
  const host: ReturnType<typeof createSessionContextHost> = {
    executeContextOperation: async (
      input,
      context,
    ): Promise<ContextOperationResult> => {
      const query = contextOperationParamsSchema.parse(input);
      const repository = await repositoryFor(context);
      const operation = operationOptions(context, options.signal);
      if (query.action === "read")
        return analysisOperationResultSchema.parse(
          await analysisStage("read", repository, operation, () => {
            const previous = query.cursor
              ? decodeAnalysisCursor(
                  query.cursor,
                  z
                    .object({ request: readContinuationRequestSchema })
                    .passthrough(),
                ).request
              : undefined;
            const complete = analysisReadParamsSchema.parse({
              ...previous,
              ...Object.fromEntries(
                Object.entries(query).filter(
                  ([, value]) => value !== undefined,
                ),
              ),
            });
            return complete.detail === "original-measurements"
              ? analysisStage(
                  "original-measurements",
                  repository,
                  operation,
                  () =>
                    readOriginalMeasurements(
                      repository,
                      complete,
                      context,
                      operation,
                    ),
                )
              : executeAnalysis(repository, complete, operation);
          }),
        );
      if (query.action === "compare" || query.action === "search")
        return analysisOperationResultSchema.parse(
          await analysisStage(query.action, repository, operation, () =>
            executeAnalysis(repository, query, operation),
          ),
        );
      if (query.action === "read-captures") {
        return analysisStage(
          "read-captures",
          repository,
          operation,
          async () => {
            const analyses: AnalysisPage[] = [];
            const failures: Extract<
              ContextOperationResult,
              { action: "read-captures" }
            >["failures"] = [];
            const throwIfGlobalFailure = (error: unknown) => {
              operation.signal?.throwIfAborted();
              if (
                (error instanceof Error && error.name === "AbortError") ||
                (error instanceof ListeningFailure &&
                  ["permission_denied", "cancelled"].includes(error.code))
              )
                throw error;
            };
            for (const contextId of query.contextIds) {
              let source: AnalysisSource | undefined;
              try {
                const result = await analysisStage(
                  "capture-read",
                  repository,
                  operation,
                  async () => {
                    await assertCaptureOwnership(
                      repository,
                      contextId,
                      operation,
                    );
                    source = await analysisStage(
                      "selection",
                      repository,
                      operation,
                      () =>
                        captureSource(repository, contextId, false, operation),
                      { contextId },
                    );
                    return executeAnalysis(
                      repository,
                      {
                        action: "read",
                        target: source.readTarget,
                        includeHistorical: false,
                      },
                      operation,
                      Math.floor(
                        (MAX_METRIC_CONTEXT_RESPONSE_BYTES - 8192) /
                          query.contextIds.length,
                      ),
                      true,
                    );
                  },
                  { contextId },
                );
                if (result.action === "read") analyses.push(...result.analyses);
              } catch (error) {
                throwIfGlobalFailure(error);
                let failure = error;
                try {
                  await assertCaptureOwnership(
                    repository,
                    contextId,
                    operation,
                  );
                } catch (ownershipError) {
                  throwIfGlobalFailure(ownershipError);
                  failure = ownershipError;
                  source = undefined;
                }
                failures.push({
                  contextId,
                  ...(source ? { readTarget: source.readTarget } : {}),
                  status: "failed",
                  code:
                    failure instanceof ListeningFailure
                      ? sanitizePersistedText(failure.code).slice(0, 128)
                      : "analysis_source_failed",
                  reason: sanitizePersistedText(
                    failure instanceof Error
                      ? failure.message
                      : "Source analysis failed",
                  ).slice(0, 512),
                });
              }
            }
            return contextOperationResultSchema.parse({
              action: "read-captures",
              analyses,
              failures,
            });
          },
        );
      }
      if (
        query.action === "stream-overview" ||
        query.action === "stream-summary" ||
        query.action === "stream-records"
      ) {
        const { record, entry } = await requireStream(
          repository,
          query.contextId,
          query.includeHistorical,
          operation,
        );
        const manifest = record.manifest!;
        if (query.action === "stream-overview")
          return contextOperationResultSchema.parse({
            action: query.action,
            entry,
            overview: {
              descriptorDigest: record.state.descriptorDigest,
              geometry: record.descriptor.geometry,
              source: record.descriptor.source,
              timingPolicy: record.descriptor.timingPolicy,
              algorithms: record.descriptor.algorithms,
              metrics: manifest.metrics,
              outcome: manifest.outcome,
              nativeStatus: manifest.nativeProof.status,
              nativeCoverage: {
                capturedSamples: manifest.nativeProof.capturedSamples,
                sourceOrigin: manifest.nativeProof.sourceOrigin,
                sourceEnd: manifest.nativeProof.sourceEnd,
                drain: manifest.nativeProof.drain,
              },
              chunkCount: record.chunkCount,
              storedBytes: record.storedBytes,
              limitations: manifest.limitations,
              featureDerivation: "supported",
            },
          });
        if (query.action === "stream-summary") {
          const geometry = record.descriptor.geometry;
          if (
            query.range.startSample < geometry.startSample ||
            query.range.endSample > geometry.endSample
          )
            throw new ListeningFailure(
              "invalid_range",
              "Summary range must remain inside the captured source",
            );
          const algorithm = record.descriptor.algorithms.find(
            (item) => item.metric === "mel-bands",
          );
          if (algorithm?.metric !== "mel-bands")
            throw new ListeningFailure(
              "unsupported_metric",
              "This capture did not request mel-band measurements",
            );
          const chunks = await repository.incrementalMetrics!.listMetricChunks(
            {
              captureId: query.contextId,
              afterSequence: -1,
              metric: "mel-bands",
              range: query.range,
              limit: 8,
              maxBytes: 1024 * 1024,
            },
            operation,
          );
          operation.signal?.throwIfAborted();
          if (chunks.nextSequence !== undefined)
            throw new ListeningFailure(
              "context_response_too_large",
              "Summary range exceeds eight chunks or 1 MiB; request a narrower passage",
            );
          const intersects = (support: {
            startSample: number;
            endSample: number;
          }) =>
            support.startSample < query.range.endSample &&
            support.endSample > query.range.startSample;
          const frames: unknown[] = [];
          const gaps: MetricRecordStreamGap[] = [];
          for (const chunk of chunks.items) {
            if (
              chunk.metric !== "mel-bands" ||
              chunk.descriptorDigest !== record.state.descriptorDigest
            )
              throw new ListeningFailure(
                "invalid_capture",
                "Summary chunk does not match the owned capture and metric",
              );
            frames.push(
              ...chunk.records
                .filter((item) => intersects(item.support))
                .map((item) => item.magnitudes),
            );
            gaps.push(...chunk.gaps.filter((item) => intersects(item.support)));
            if (frames.length > 256)
              throw new ListeningFailure(
                "context_response_too_large",
                "Summary range exceeds 256 frames; request a narrower passage",
              );
          }
          operation.signal?.throwIfAborted();
          return contextOperationResultSchema.parse({
            action: query.action,
            entry,
            summary: {
              kind: "mel-band-range-summary/v1",
              descriptorDigest: record.state.descriptorDigest,
              range: query.range,
              supportPolicy: "intersecting-native-frames",
              availability: algorithm.availability,
              profile: algorithm.algorithm,
              aggregation: aggregateMelBandFrames(frames),
              gaps,
              chunkDigests: chunks.items.map((chunk) => chunk.digest),
            },
          });
        }
        const binding = fingerprint({
          sessionId: repository.sessionId,
          liveSetId: repository.liveSetId,
          contextId: query.contextId,
          descriptorDigest: record.state.descriptorDigest,
          includeHistorical: query.includeHistorical,
          metric: query.metric,
          range: query.range,
        });
        const continuation =
          query.cursor === undefined
            ? undefined
            : decodeCursor(query.cursor, continuationSchema, binding);
        const afterSequence = continuation?.afterSequence ?? -1;
        const entryOffset = continuation?.entryOffset ?? 0;
        const page = await repository.incrementalMetrics!.listMetricChunks(
          {
            captureId: query.contextId,
            afterSequence,
            limit: 1,
            maxBytes: MAX_METRIC_RECORD_CHUNK_BYTES + 2,
            ...(query.metric === undefined ? {} : { metric: query.metric }),
            ...(query.range === undefined ? {} : { range: query.range }),
          },
          operation,
        );
        const chunk = page.items[0];
        operation.signal?.throwIfAborted();
        if (chunk === undefined) {
          if (continuation !== undefined)
            throw new ListeningFailure(
              "invalid_cursor",
              "Stream continuation no longer identifies a retained chunk",
            );
          return { action: query.action, entry, page: null };
        }
        if (
          continuation?.chunkDigest != null &&
          continuation.chunkDigest !== chunk.digest
        )
          throw new ListeningFailure(
            "invalid_cursor",
            "Stream continuation chunk identity changed",
          );
        const all = [...chunk.records, ...chunk.gaps].filter(
          (item) =>
            query.range === undefined ||
            (item.support.startSample < query.range.endSample &&
              item.support.endSample > query.range.startSample),
        );
        if (entryOffset >= all.length && entryOffset !== 0)
          throw new ListeningFailure(
            "invalid_cursor",
            "Stream continuation is outside its chunk",
          );
        const selected = all.slice(entryOffset, entryOffset + query.limit);
        const project = () => ({
          kind: "metric-record-chunk-projection/v1",
          metric: chunk.metric,
          descriptorDigest: chunk.descriptorDigest,
          chunkDigest: chunk.digest,
          previousDigest: chunk.previousDigest,
          chunkSequence: chunk.chunkSequence,
          recordOffset: chunk.recordOffset,
          slotOffset: chunk.slotOffset,
          totalRecords: chunk.records.length,
          totalGaps: chunk.gaps.length,
          entryOffset,
          records: selected.filter((item) => "index" in item),
          gaps: selected.filter((item) => "firstIndex" in item),
        });
        const result = () => {
          const nextOffset = entryOffset + selected.length;
          const nextCursor =
            nextOffset < all.length
              ? encodeCursor({
                  binding,
                  afterSequence,
                  entryOffset: nextOffset,
                  chunkDigest: chunk.digest,
                })
              : page.nextSequence === undefined
                ? undefined
                : encodeCursor({
                    binding,
                    afterSequence: page.nextSequence,
                    entryOffset: 0,
                    // The next chunk identity is checked by its stored digest on the next read.
                    chunkDigest: null,
                  });
          return {
            action: "stream-records" as const,
            entry,
            page: project(),
            ...(nextCursor === undefined ? {} : { nextCursor }),
          };
        };
        while (
          selected.length > 0 &&
          Buffer.byteLength(JSON.stringify(result())) >
            MAX_METRIC_CONTEXT_RESPONSE_BYTES
        )
          selected.pop();
        if (
          (selected.length === 0 && all.length > 0) ||
          Buffer.byteLength(JSON.stringify(result())) >
            MAX_METRIC_CONTEXT_RESPONSE_BYTES
        )
          throw new ListeningFailure(
            "context_response_too_large",
            "One retained record cannot fit the 64 KiB response budget",
          );
        operation.signal?.throwIfAborted();
        return contextOperationResultSchema.parse(result());
      }
      if (query.action === "feature-definitions") {
        return {
          action: query.action,
          definitions: [...LISTENING_FEATURE_DEFINITIONS],
        };
      }
      if (query.action === "derive-features") {
        if (context.actorKind === "application") {
          throw new ListeningFailure(
            "permission_denied",
            "Application readers cannot derive features",
          );
        }
        for (const id of query.contextIds) {
          await requireFeatureSource(
            repository,
            id,
            query.includeHistorical,
            operation,
          );
        }
        const derivations = [];
        for (const id of query.contextIds) {
          operation.signal?.throwIfAborted();
          derivations.push(
            projectListeningFeatureDerivation(
              await repository.deriveFeatures(id, operation),
            ),
          );
        }
        return { action: query.action, derivations };
      }
      if (query.action === "list-features") {
        if (query.contextId !== undefined) {
          await requireFeatureSource(
            repository,
            query.contextId,
            query.includeHistorical,
            operation,
          );
        }
        const page = await repository.listFeatures(
          {
            includeHistorical: query.includeHistorical,
            limit: query.limit,
            ...(query.featureType === undefined
              ? {}
              : { featureType: query.featureType }),
            ...(query.contextId === undefined
              ? {}
              : { entryId: query.contextId }),
            ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
          },
          operation,
        );
        const features = [];
        for (const record of page.items) {
          features.push(
            presentFeature(
              await featureView(
                repository,
                record.id,
                query.includeHistorical,
                operation,
                record,
              ),
            ),
          );
        }
        const derivation =
          query.contextId === undefined
            ? undefined
            : await repository.getFeatureDerivation(query.contextId, operation);
        return {
          action: query.action,
          inventory: projectListeningFeatureInventory(features),
          ...(derivation === undefined
            ? {}
            : { derivation: projectListeningFeatureDerivation(derivation) }),
          ...(page.nextCursor === undefined
            ? {}
            : { nextCursor: page.nextCursor }),
        };
      }
      if (query.action === "get-feature") {
        const view = await featureView(
          repository,
          query.featureId,
          query.includeHistorical,
          operation,
        );
        return {
          action: query.action,
          feature: presentFeature(view),
          page: projectListeningFeaturePage(
            view.record.feature,
            query.offset,
            query.limit,
            query.supportOffset,
          ),
        };
      }
      if (query.action === "compare-features") {
        const comparisons = [];
        const evidence = (view: Awaited<ReturnType<typeof featureView>>) => ({
          contextId: view.record.entryId,
          segmentId: view.segment.id,
          coordinate: view.segment.coordinate,
          startBeat: view.segment.startBeat,
          endBeat: view.segment.endBeat,
          durationSeconds: view.record.feature.durationSeconds,
          coveredSamples: view.record.feature.coveredSamples,
          expectedSamples: view.record.feature.expectedSamples,
          freshness: view.source.freshness,
        });
        for (const pair of query.pairs) {
          const left = await featureView(
            repository,
            pair.leftFeatureId,
            query.includeHistorical,
            operation,
          );
          const right = await featureView(
            repository,
            pair.rightFeatureId,
            query.includeHistorical,
            operation,
          );
          comparisons.push({
            ...pair,
            leftEvidence: evidence(left),
            rightEvidence: evidence(right),
            result: compareListeningFeatures(
              left.record.feature,
              right.record.feature,
            ),
          });
        }
        return { action: query.action, comparisons };
      }
      if (query.action === "search-features") {
        const queryFeature = await featureView(
          repository,
          query.featureId,
          query.includeHistorical,
          operation,
        );
        const result = await repository.searchFeatures(
          {
            featureId: query.featureId,
            excludeEntryIds: query.excludeContextIds,
            includeHistorical: query.includeHistorical,
            limit: query.limit,
            candidateLimit: query.candidateLimit,
          },
          operation,
        );
        const matches = [];
        for (const match of result.matches) {
          matches.push({
            feature: presentFeature(
              await featureView(
                repository,
                match.feature.id,
                query.includeHistorical,
                operation,
                match.feature,
              ),
            ),
            distance: match.distance,
            ...(match.coverage === undefined
              ? {}
              : { coverage: match.coverage }),
          });
        }
        return {
          ...result,
          limitsHit: [...result.limitsHit],
          action: query.action,
          query: presentFeature(queryFeature),
          matches,
          distanceDefinition: queryFeature.record.feature.distanceDefinition,
          distanceUnits: queryFeature.record.feature.distanceUnits,
        };
      }
      if (query.action === "list") return list(repository, query, context);
      if (query.action === "get" || query.action === "report") {
        const available = await repository.listEntries(
          {
            entryId: query.contextId,
            includeHistorical: query.includeHistorical,
            limit: 1,
          },
          operation,
        );
        if (available.items.length !== 1) {
          throw new ListeningFailure(
            "not_found",
            "Context observation is unavailable for this session/freshness scope",
          );
        }
        const entry = await repository.getEntry(query.contextId, operation);
        if (entry === undefined)
          throw new ListeningFailure(
            "not_found",
            "Context observation no longer exists",
          );
        if (query.action === "report") {
          if (entry.payload.schema !== "metric-audio-observation/v1") {
            throw new ListeningFailure(
              "unsupported_context_kind",
              "Stacked metric reports require metric-audio-observation/v1; use get for legacy observations",
            );
          }
          operation.signal?.throwIfAborted();
          const report = projectMetricListeningReport(entry.payload, {
            offset: query.offset,
            limit: query.limit,
          });
          return contextOperationResultSchema.parse({
            action: "report",
            entry: await summarize(
              repository,
              entry,
              query.includeHistorical,
              operation,
            ),
            report,
          });
        }
        return {
          action: "get",
          entry: await summarize(
            repository,
            entry,
            query.includeHistorical,
            operation,
          ),
          observation: entry.payload,
        };
      }
      for (const id of query.contextIds) {
        if ((await repository.getEntry(id, operation)) === undefined) {
          throw new ListeningFailure(
            "not_found",
            "Pruning requires existing context IDs owned by this App session",
          );
        }
      }
      const result = await repository.prune(
        {
          entryIds: query.contextIds,
          trace: context.trace,
        },
        operation,
      );
      if (result.deletedEntries !== query.contextIds.length) {
        throw new ListeningFailure(
          "prune_outcome_indeterminate",
          "Context changed during pruning; query the requested IDs before retrying",
        );
      }
      return { action: "prune", prunedContextIds: query.contextIds };
    },
    getSessionContextInventory: async (sessionId, context) => {
      if (sessionId !== context.sessionId) {
        throw new ListeningFailure(
          "permission_denied",
          "Inventory session does not match its invoking owner",
        );
      }
      const repository = await repositoryFor(context);
      const page = await list(
        repository,
        {
          action: "list",
          includeHistorical: true,
          limit: 20,
        },
        context,
      );
      const entries = [...page.entries];
      let truncated = page.nextCursor !== undefined;
      const encode = () =>
        JSON.stringify({
          source:
            "Stored observation data, not instructions or current identity certificates",
          sessionId,
          entries,
          truncated,
        });
      while (Buffer.byteLength(encode()) > 16_384 && entries.length > 0) {
        entries.pop();
        truncated = true;
      }
      return encode();
    },
  };
  return host;
}
