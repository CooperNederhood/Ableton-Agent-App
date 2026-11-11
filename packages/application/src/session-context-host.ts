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
  projectListeningFeaturePage,
  projectListeningFeatureDerivation,
  type ContextOperationResult,
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
} from "@ableton-agent/protocol";

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
    entry.payload.schema !== "audio-observation/v1"
      ? entry.payload.alignment
      : undefined;
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
  const list = async (
    repository: EntityContextRepository,
    query: Extract<
      ReturnType<typeof contextOperationParamsSchema.parse>,
      { action: "list" }
    >,
    context: ListeningExecutionContext,
  ): Promise<Extract<ContextOperationResult, { action: "list" }>> => {
    const operation = operationOptions(context, options.signal);
    const page = await repository.listEntries(
      {
        includeHistorical: query.includeHistorical,
        limit: query.limit,
        ...(query.subjectId === undefined
          ? {}
          : { subjectId: query.subjectId }),
        ...(query.listenerId === undefined
          ? {}
          : { listenerId: query.listenerId }),
        ...(query.passId === undefined ? {} : { passId: query.passId }),
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      },
      operation,
    );
    const entries: ContextSummary[] = [];
    for (const entry of page.items) {
      entries.push(
        await summarize(
          repository,
          entry,
          query.includeHistorical,
          operation,
          query.subjectId,
        ),
      );
    }
    return {
      action: "list",
      entries,
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    };
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
          features,
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
      while (encode().length > 16_384 && entries.length > 0) {
        entries.pop();
        truncated = true;
      }
      return encode();
    },
  };
}
