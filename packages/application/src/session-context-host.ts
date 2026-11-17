import { createHash } from "node:crypto";
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
  MAX_METRIC_RECORD_CHUNK_BYTES,
  aggregateMelBandFrames,
  type MetricRecordStreamGap,
} from "@ableton-agent/protocol";

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
  if (encoded.length > 4096)
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
    if (entry === undefined || entry.liveSetId !== repository.liveSetId) {
      throw new ListeningFailure(
        "not_found",
        "Feature source is unavailable for this App session, Set or freshness scope",
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
  return {
    executeContextOperation: async (
      input,
      context,
    ): Promise<ContextOperationResult> => {
      const query = contextOperationParamsSchema.parse(input);
      const repository = await repositoryFor(context);
      const operation = operationOptions(context, options.signal);
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
}
