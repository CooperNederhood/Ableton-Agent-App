import type {
  ContextEntry,
  ContextEntrySummary,
  ContextOperationOptions,
  EntityContextRepository,
} from "@ableton-agent/project-state";
import {
  contextOperationParamsSchema,
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
import { listeningDisagreementMilliseconds } from "@ableton-agent/protocol";

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
  const measured = entry.payload.summaries;
  const rms = measured.rmsDbfs
    .map((value) =>
      value === null ? "silence/below floor" : `${value.toFixed(2)} dBFS`,
    )
    .join(", ");
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
      entry.payload.sampleRate,
    ).toFixed(3)} ms)`;
  return {
    contextId: entry.id,
    passId: entry.passId,
    listenerId: entry.producer.listenerId,
    subjectId: subject.id,
    kind: entry.kind,
    createdAt: entry.createdAt,
    freshness,
    summary: [
      `${subject.kind}: ${subject.binding.semanticLocator.name}`,
      `Observed ${"coordinate" in link.coverage ? link.coverage.coordinate : "beats"} ${link.coverage.startBeat}-${link.coverage.endBeat}`,
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
      `Peak ${measured.peak.map((value) => value.toFixed(4)).join(", ")} linear`,
      `RMS ${rms}; not LUFS`,
      `Centroid ${measured.centroidHz === null ? "not observed" : `${measured.centroidHz.toFixed(1)} Hz`}`,
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
  return {
    executeContextOperation: async (
      input,
      context,
    ): Promise<ContextOperationResult> => {
      const query = contextOperationParamsSchema.parse(input);
      const repository = await repositoryFor(context);
      const operation = operationOptions(context, options.signal);
      if (query.action === "list") return list(repository, query, context);
      if (query.action === "get") {
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
