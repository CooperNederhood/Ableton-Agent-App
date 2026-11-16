import { randomUUID } from "node:crypto";
import { lstat, readFile, rm } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { performance } from "node:perf_hooks";
import type { ListeningExecutionContext } from "@ableton-agent/application";
import {
  openSessionContextStore,
  CONTEXT_LIMITS,
  contextTraceSchema,
  type ContextOperationOptions,
  type EntityContextRepository,
  type IncrementalMetricContextRepository,
  type MetricCaptureOwner,
  type SessionContextPublicationRequest,
  type SessionContextStore,
  type SessionContextStoreOptions,
} from "@ableton-agent/project-state";
import {
  createNonBlockingObservabilityRecorder,
  sanitizeTelemetryAttributes,
  type TelemetryEventRecorder,
} from "@ableton-agent/observability";
import {
  resolveNestedSessionStorage,
  ensureLiveAgentStorage,
  type LiveAgentStorageLayout,
} from "@ableton-agent/storage";
import {
  desktopSessionContextStoreReferenceSchema,
  desktopSessionOwnershipManifestSchema,
  sessionSchema,
  type DesktopSession,
} from "../contracts.js";

export interface DesktopSessionContextTransition {
  apply(): Promise<void>;
  complete(): void;
  rollback(): Promise<void>;
}

export type DesktopSessionContextTransitionHandler = (
  previous: readonly DesktopSession[],
  next: readonly DesktopSession[],
  options?: ContextOperationOptions,
) => Promise<DesktopSessionContextTransition>;

export interface DesktopSessionContextManagerOptions {
  readonly storage: LiveAgentStorageLayout;
  readonly resolveSession: (
    sessionId: string,
  ) => Promise<DesktopSession | undefined>;
  readonly publishSessionContext: (
    request: SessionContextPublicationRequest,
  ) => Promise<DesktopSession>;
  readonly recorder?: TelemetryEventRecorder;
  readonly revalidate?: SessionContextStoreOptions["revalidate"];
  readonly maxCachedSessions?: number;
  readonly maxPendingOperations?: number;
}

/** Main-process-only resolver. No globally selected session or renderer filesystem access. */
export function createDesktopSessionContextManager(
  options: DesktopSessionContextManagerOptions,
) {
  const maxCached = options.maxCachedSessions ?? 32;
  const maxPending = options.maxPendingOperations ?? 32;
  if (
    ![maxCached, maxPending].every(
      (value) => Number.isInteger(value) && value >= 1 && value <= 32,
    )
  ) {
    throw new TypeError("Desktop context bounds must be between 1 and 32");
  }
  const recorder =
    options.recorder === undefined
      ? undefined
      : createNonBlockingObservabilityRecorder({
          enqueue: (event) => options.recorder!.enqueue(event),
          enqueueConfigurationSnapshot: () => undefined,
        });
  const cached = new Map<
    string,
    {
      session: DesktopSession;
      repository: SessionContextStore;
      handle: EntityContextRepository;
      created: boolean;
    }
  >();
  const transitioning = new Set<string>();
  const publishing = new Set<string>();
  const writing = new Map<string, number>();
  const reserved = new Map<string, Set<string>>();
  const actorHandles = new WeakMap<
    EntityContextRepository,
    WeakMap<ListeningExecutionContext, EntityContextRepository>
  >();
  let tail = Promise.resolve();
  let pending = 0;
  let closed = false;
  let closing: Promise<void> | undefined;
  let initialized = false;
  const ownership = (session: DesktopSession) => ({
    sessionId: session.id,
    liveSetId: session.liveSetId,
    ...(session.liveProjectId === undefined
      ? {}
      : { liveProjectId: session.liveProjectId }),
  });
  const pathsFor = (session: DesktopSession) =>
    resolveNestedSessionStorage(options.storage, ownership(session));
  const sameOwner = (left: DesktopSession, right: DesktopSession) =>
    left.id === right.id &&
    left.liveSetId === right.liveSetId &&
    left.liveProjectId === right.liveProjectId;
  const actorAllowed = (
    session: DesktopSession,
    context: ListeningExecutionContext,
  ) => {
    if (
      session.id !== context.sessionId ||
      (context.actorKind !== "application" &&
        !session.activeAgents.some((agent) => agent.id === context.agentId))
    ) {
      throw new Error(
        "Context owner or initiating agent does not belong to this App session",
      );
    }
  };
  const incrementalForActor = (
    metrics: IncrementalMetricContextRepository,
    context: ListeningExecutionContext,
    deny?: () => Promise<never>,
  ): IncrementalMetricContextRepository => {
    const operationFor = (
      operation: ContextOperationOptions = {},
      cleanup = false,
    ): ContextOperationOptions => {
      const {
        activeAgentId: _actor,
        signal: operationSignal,
        ...rest
      } = operation;
      void _actor;
      const signals = [
        cleanup ? undefined : context.signal,
        operationSignal,
      ].filter((signal): signal is AbortSignal => signal !== undefined);
      return {
        ...rest,
        trace: operation.trace ?? context.trace,
        ...(context.actorKind === "application"
          ? {}
          : { activeAgentId: context.agentId }),
        ...(signals.length === 0 ? {} : { signal: AbortSignal.any(signals) }),
      };
    };
    return {
      beginMetricCapture: (input, operation) =>
        deny?.() ?? metrics.beginMetricCapture(input, operationFor(operation)),
      appendMetricChunk: (owner, chunk, operation) =>
        deny?.() ??
        metrics.appendMetricChunk(owner, chunk, operationFor(operation)),
      sealMetricCapture: (owner, manifest, operation) =>
        deny?.() ??
        metrics.sealMetricCapture(owner, manifest, operationFor(operation)),
      finalizeMetricCapture: (owner, manifest, pass, operation) =>
        deny?.() ??
        metrics.finalizeMetricCapture(
          owner,
          manifest,
          pass,
          operationFor(operation),
        ),
      finalizeMetricCaptures: (captures, pass, operation) =>
        deny?.() ??
        metrics.finalizeMetricCaptures(captures, pass, operationFor(operation)),
      terminateMetricCapture: (owner, status, reason, operation) =>
        deny?.() ??
        metrics.terminateMetricCapture(
          owner,
          status,
          reason,
          operationFor(operation, true),
        ),
      getMetricCapture: (id, operation) =>
        metrics.getMetricCapture(id, operationFor(operation)),
      listMetricCaptures: (query, operation) =>
        metrics.listMetricCaptures(query, operationFor(operation)),
      listMetricChunks: (query, operation) =>
        metrics.listMetricChunks(query, operationFor(operation)),
    };
  };
  const handleForActor = (
    handle: EntityContextRepository,
    context: ListeningExecutionContext,
  ): EntityContextRepository => {
    if (context.actorKind !== "application") {
      const handles =
        actorHandles.get(handle) ??
        new WeakMap<ListeningExecutionContext, EntityContextRepository>();
      const existing = handles.get(context);
      if (existing !== undefined) return existing;
      const actorHandle: EntityContextRepository = {
        ...handle,
        ...(handle.incrementalMetrics === undefined
          ? {}
          : {
              incrementalMetrics: incrementalForActor(
                handle.incrementalMetrics,
                context,
              ),
            }),
        get liveSetId() {
          return handle.liveSetId;
        },
        deriveFeatures: (entryId, operation) => {
          const signals = [context.signal, operation?.signal].filter(
            (signal): signal is AbortSignal => signal !== undefined,
          );
          return handle.deriveFeatures(entryId, {
            ...operation,
            trace: operation?.trace ?? context.trace,
            activeAgentId: context.agentId,
            ...(signals.length === 0
              ? {}
              : { signal: AbortSignal.any(signals) }),
          });
        },
      };
      handles.set(context, actorHandle);
      actorHandles.set(handle, handles);
      return actorHandle;
    }
    const deny = () =>
      run(
        "reader-mutation",
        async () => {
          throw new Error(
            "Application context readers cannot mutate session context",
          );
        },
        { trace: context.trace, sessionId: handle.sessionId },
      );
    return {
      ...handle,
      ...(handle.incrementalMetrics === undefined
        ? {}
        : {
            incrementalMetrics: incrementalForActor(
              handle.incrementalMetrics,
              context,
              deny,
            ),
          }),
      get liveSetId() {
        return handle.liveSetId;
      },
      appendPass: deny,
      deriveFeatures: deny,
      assessLink: deny,
      prune: deny,
      reservePass: deny,
      releaseReservation: deny,
      transitionLiveSetOwnership: deny,
      close: deny,
    };
  };
  const run = <T>(
    action: string,
    operation: () => Promise<T>,
    context: ContextOperationOptions & {
      sessionId?: string;
      liveSetId?: string;
    } = {},
  ): Promise<T> => {
    const trace = contextTraceSchema.parse(
      context.trace ?? {
        traceId: randomUUID(),
        correlationId: randomUUID(),
        causationId: randomUUID(),
      },
    );
    const queuedAt = performance.now();
    let cause = trace.causationId;
    const emit = (stage: string, attributes: Record<string, unknown> = {}) => {
      const id = randomUUID();
      recorder?.enqueue({
        version: 2,
        id,
        occurredAt: new Date().toISOString(),
        name: `desktop.context.${action}.${stage}`,
        source: "desktop",
        category: "context",
        stage,
        level: stage === "failed" ? "error" : "info",
        outcome:
          stage === "completed"
            ? "success"
            : stage === "failed"
              ? "failure"
              : stage === "cancelled"
                ? "cancelled"
                : "unknown",
        durationMs: performance.now() - queuedAt,
        trace: { traceId: trace.traceId, spanId: id },
        correlationId: trace.correlationId,
        causationId: cause,
        ...(context.sessionId === undefined
          ? {}
          : { sessionId: context.sessionId }),
        ...(context.liveSetId === undefined
          ? {}
          : { liveSetId: context.liveSetId }),
        ...(context.activeAgentId === undefined
          ? {}
          : { activeAgentId: context.activeAgentId }),
        attributes: sanitizeTelemetryAttributes(attributes),
      });
      cause = id;
    };
    emit("queued");
    if (closed || closing !== undefined || pending >= maxPending) {
      const error = new Error(
        closed || closing !== undefined
          ? "Desktop context manager is closed"
          : "Desktop context queue is full",
      );
      emit("failed", { error });
      return Promise.reject(error);
    }
    pending++;
    const result = tail.then(async () => {
      emit("started", { queueWaitMs: performance.now() - queuedAt });
      try {
        context.signal?.throwIfAborted();
        emit("progress");
        const value = await operation();
        emit("completed");
        return value;
      } catch (error) {
        emit(context.signal?.aborted === true ? "cancelled" : "failed", {
          error,
        });
        throw error;
      } finally {
        pending--;
      }
    });
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const declaredStore = async (session: DesktopSession) => {
    await validateOwnedDirectory(session, false);
    const paths = pathsFor(session);
    const info = await lstat(paths.entityContextPath);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size === 0 ||
      info.size > CONTEXT_LIMITS.storeBytes
    )
      throw new Error(
        "Declared context store is not a regular bounded owned file",
      );
    const manifestInfo = await lstat(paths.manifestPath);
    if (
      !manifestInfo.isFile() ||
      manifestInfo.isSymbolicLink() ||
      manifestInfo.size > 64 * 1024
    )
      throw new Error("Context manifest is not a regular bounded owned file");
    const manifest = desktopSessionOwnershipManifestSchema.parse(
      JSON.parse(await readFile(paths.manifestPath, "utf8")) as unknown,
    );
    if (
      manifest.appSessionId !== session.id ||
      manifest.liveSetId !== session.liveSetId ||
      manifest.liveProjectId !== session.liveProjectId
    )
      throw new Error(
        "Context ownership manifest does not match its App session",
      );
    desktopSessionContextStoreReferenceSchema.parse(manifest.contextStore);
  };
  const requireSession = async (id: string) => {
    const session = await options.resolveSession(id);
    if (session === undefined)
      throw new Error(
        "Unknown App session; context cannot be recovered as empty state",
      );
    return sessionSchema.parse(session);
  };
  const validateOwnedDirectory = async (
    session: DesktopSession,
    allowMissing: boolean,
  ) => {
    const segments = relative(
      options.storage.root,
      dirname(pathsFor(session).entityContextPath),
    ).split(sep);
    let path = options.storage.root;
    for (const segment of ["", ...segments]) {
      if (segment !== "") path = join(path, segment);
      try {
        const info = await lstat(path);
        if (info.isSymbolicLink() || !info.isDirectory())
          throw new Error(
            "Context directory must not traverse symbolic links or non-directories",
          );
      } catch (error) {
        if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT")
          continue;
        throw error;
      }
    }
  };
  const hasActiveMetricCapture = async (
    repository: SessionContextStore,
    operation: ContextOperationOptions = {},
  ) => {
    for (const status of ["staging", "sealed"] as const)
      if (
        (await repository.listMetricCaptures({ status, limit: 1 }, operation))
          .items.length > 0
      )
        return true;
    return false;
  };
  const prepareSessionTransition: DesktopSessionContextTransitionHandler = (
    previous,
    next,
    operationOptions = {},
  ) => {
    const transitionOptions = {
      ...operationOptions,
      trace: contextTraceSchema.parse(
        operationOptions.trace ?? {
          traceId: randomUUID(),
          correlationId: randomUUID(),
          causationId: randomUUID(),
        },
      ),
    };
    return run(
      "transition-prepare",
      async () => {
        const changes = previous.flatMap((before) => {
          const after = next.find((session) => session.id === before.id);
          return after !== undefined && !sameOwner(before, after)
            ? [{ before, after }]
            : [];
        });
        if (changes.some(({ before }) => transitioning.has(before.id)))
          throw new Error(
            "Context ownership transition is already in progress",
          );
        if (
          changes.some(
            ({ before }) =>
              publishing.has(before.id) ||
              (writing.get(before.id) ?? 0) > 0 ||
              (reserved.get(before.id)?.size ?? 0) > 0,
          )
        )
          throw new Error(
            "Context publication or listening reservation is in progress; ownership transition must retry",
          );
        for (const { before } of changes) {
          const entry = cached.get(before.id);
          if (
            entry !== undefined &&
            (await hasActiveMetricCapture(entry.repository, transitionOptions))
          )
            throw new Error(
              "Incremental context capture is in progress; ownership transition must retry",
            );
        }
        const applied: typeof changes = [];
        for (const { before } of changes) transitioning.add(before.id);
        try {
          for (const { before } of changes) {
            const entry = cached.get(before.id);
            if (entry !== undefined) {
              await entry.repository.close();
              if (entry.created && entry.session.contextStore === undefined)
                await rm(pathsFor(entry.session).entityContextPath, {
                  force: true,
                });
              cached.delete(before.id);
            }
            if (before.contextStore !== undefined) await declaredStore(before);
          }
        } catch (error) {
          for (const { before } of changes) transitioning.delete(before.id);
          throw error;
        }
        const release = () => {
          for (const { before } of changes) transitioning.delete(before.id);
        };
        return {
          apply: () =>
            run(
              "transition-apply",
              async () => {
                for (const change of changes) {
                  operationOptions.signal?.throwIfAborted();
                  if (change.before.contextStore === undefined) continue;
                  await declaredStore(change.after);
                  const repository = await openSessionContextStore({
                    path: pathsFor(change.after).entityContextPath,
                    sessionId: change.before.id,
                    liveSetId: change.before.liveSetId,
                    trace: transitionOptions.trace,
                    ...(options.recorder === undefined
                      ? {}
                      : { recorder: options.recorder }),
                  });
                  try {
                    await repository.transitionLiveSetOwnership(
                      change.after.liveSetId,
                      transitionOptions,
                    );
                    applied.push(change);
                  } finally {
                    await repository.close();
                  }
                }
              },
              transitionOptions,
            ),
          complete: release,
          rollback: async () => {
            try {
              await run(
                "transition-rollback",
                async () => {
                  for (const change of [...applied].reverse()) {
                    await declaredStore(change.before);
                    const repository = await openSessionContextStore({
                      path: pathsFor(change.before).entityContextPath,
                      sessionId: change.before.id,
                      liveSetId: change.after.liveSetId,
                      trace: transitionOptions.trace,
                      ...(options.recorder === undefined
                        ? {}
                        : { recorder: options.recorder }),
                    });
                    try {
                      await repository.transitionLiveSetOwnership(
                        change.before.liveSetId,
                        { trace: transitionOptions.trace },
                      );
                    } finally {
                      await repository.close();
                    }
                  }
                },
                { trace: transitionOptions.trace },
              );
            } finally {
              release();
            }
          },
        };
      },
      transitionOptions,
    );
  };
  return {
    resolveRepository: (
      context: ListeningExecutionContext,
      operationOptions: ContextOperationOptions = {},
    ): Promise<EntityContextRepository> => {
      const signals = [context.signal, operationOptions.signal].filter(
        (signal): signal is AbortSignal => signal !== undefined,
      );
      operationOptions = {
        ...operationOptions,
        ...(signals.length === 0 ? {} : { signal: AbortSignal.any(signals) }),
      };
      return run(
        "resolve",
        async () => {
          const session = await requireSession(context.sessionId);
          actorAllowed(session, context);
          if (transitioning.has(session.id))
            throw new Error(
              "Context ownership is transitioning; retry after reconciliation",
            );
          if (!initialized) {
            await ensureLiveAgentStorage(options.storage);
            initialized = true;
          }
          const existing = cached.get(session.id);
          if (existing !== undefined) {
            if (!sameOwner(existing.session, session)) {
              if (
                existing.session.contextStore !== undefined ||
                session.contextStore !== undefined ||
                (writing.get(session.id) ?? 0) > 0 ||
                (reserved.get(session.id)?.size ?? 0) > 0
              ) {
                throw new Error(
                  "Context ownership changed without closing its previous repository",
                );
              }
              await existing.repository.close();
              if (existing.created)
                await rm(pathsFor(existing.session).entityContextPath, {
                  force: true,
                });
              cached.delete(session.id);
            } else {
              if (session.contextStore !== undefined)
                await declaredStore(session);
              return handleForActor(existing.handle, context);
            }
          }
          if (session.contextStore !== undefined) await declaredStore(session);
          if (cached.size >= maxCached) {
            const oldest = await (async () => {
              for (const entry of cached.entries())
                if (
                  (writing.get(entry[0]) ?? 0) === 0 &&
                  (reserved.get(entry[0])?.size ?? 0) === 0 &&
                  !(await hasActiveMetricCapture(
                    entry[1].repository,
                    operationOptions,
                  ))
                )
                  return entry;
              return undefined;
            })();
            if (oldest === undefined)
              throw new Error(
                "Context cache is full with active listening work",
              );
            if (oldest !== undefined) {
              await oldest[1].repository.close();
              if (
                oldest[1].created &&
                oldest[1].session.contextStore === undefined
              )
                await rm(pathsFor(oldest[1].session).entityContextPath, {
                  force: true,
                });
              cached.delete(oldest[0]);
            }
          }
          const paths = pathsFor(session);
          await validateOwnedDirectory(session, true);
          let created = false;
          try {
            await lstat(paths.entityContextPath);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            created = true;
          }
          if (!created && session.contextStore === undefined)
            throw new Error(
              "Undeclared context store requires explicit recovery",
            );
          const repository = await openSessionContextStore({
            path: paths.entityContextPath,
            sessionId: session.id,
            liveSetId: session.liveSetId,
            trace: context.trace,
            ...(operationOptions.signal === undefined
              ? {}
              : { signal: operationOptions.signal }),
            ...(options.recorder === undefined
              ? {}
              : { recorder: options.recorder }),
            ...(options.revalidate === undefined
              ? {}
              : { revalidate: options.revalidate }),
            publishSessionContext: async (request) => {
              let current = await requireSession(request.sessionId);
              const declaresReference = (value: DesktopSession) =>
                value.contextStore?.schemaVersion ===
                  request.contextStore.schemaVersion &&
                request.contextStore.kinds.every((kind) =>
                  value.contextStore?.kinds.some((known) => known === kind),
                );
              if (!sameOwner(session, current))
                throw new Error(
                  "Session context publication no longer matches its invoking owner",
                );
              if (!declaresReference(current)) {
                publishing.add(session.id);
                try {
                  current = sessionSchema.parse(
                    await options.publishSessionContext(request),
                  );
                  if (
                    !sameOwner(session, current) ||
                    !declaresReference(current)
                  )
                    throw new Error(
                      "Session publisher returned an invalid ownership declaration",
                    );
                  const entry = cached.get(session.id);
                  if (entry !== undefined) entry.session = current;
                } finally {
                  publishing.delete(session.id);
                }
              }
              await declaredStore(current);
            },
          });
          try {
            operationOptions.signal?.throwIfAborted();
            const current = await requireSession(session.id);
            if (!sameOwner(session, current))
              throw new Error(
                "Context ownership changed while resolving the repository",
              );
            if (current.contextStore !== undefined)
              await declaredStore(current);
            const metricOperation = async <T>(
              mutation: boolean,
              operation: ContextOperationOptions | undefined,
              execute: () => Promise<T>,
              captures: readonly MetricCaptureOwner[] = [],
              initiatingAgents: readonly string[] = [],
            ): Promise<T> => {
              if (mutation)
                writing.set(session.id, (writing.get(session.id) ?? 0) + 1);
              try {
                await run(
                  mutation
                    ? "validate-stream-writer"
                    : "validate-stream-reader",
                  async () => {
                    const owner = await requireSession(session.id);
                    if (
                      transitioning.has(session.id) ||
                      !sameOwner(session, owner) ||
                      (operation?.activeAgentId !== undefined &&
                        !owner.activeAgents.some(
                          ({ id }) => id === operation.activeAgentId,
                        )) ||
                      (mutation &&
                        (operation?.activeAgentId === undefined ||
                          initiatingAgents.some(
                            (id) => id !== operation.activeAgentId,
                          )))
                    )
                      throw new Error(
                        "Context stream caller no longer belongs to the invoking session ownership",
                      );
                    for (const capture of mutation ? captures : []) {
                      const record = await repository.getMetricCapture(
                        capture.captureId,
                        operation,
                      );
                      if (
                        record === undefined ||
                        record.metadata.pass.initiatorAgentId !==
                          operation?.activeAgentId
                      )
                        throw new Error(
                          "Context stream writer does not own this capture",
                        );
                    }
                  },
                  {
                    ...operation,
                    sessionId: session.id,
                    liveSetId: session.liveSetId,
                  },
                );
                return await execute();
              } finally {
                if (mutation) {
                  const remaining = (writing.get(session.id) ?? 1) - 1;
                  if (remaining > 0) writing.set(session.id, remaining);
                  else writing.delete(session.id);
                }
              }
            };
            const incrementalMetrics: IncrementalMetricContextRepository = {
              beginMetricCapture: (input, operation) =>
                metricOperation(
                  true,
                  operation,
                  () => repository.beginMetricCapture(input, operation),
                  undefined,
                  [
                    input.metadata.pass.initiatorAgentId,
                    input.metadata.producer.agentId,
                  ],
                ),
              appendMetricChunk: (owner, chunk, operation) =>
                metricOperation(
                  true,
                  operation,
                  () => repository.appendMetricChunk(owner, chunk, operation),
                  [owner],
                ),
              sealMetricCapture: (owner, manifest, operation) =>
                metricOperation(
                  true,
                  operation,
                  () =>
                    repository.sealMetricCapture(owner, manifest, operation),
                  [owner],
                ),
              finalizeMetricCapture: (owner, manifest, pass, operation) =>
                metricOperation(
                  true,
                  operation,
                  () =>
                    repository.finalizeMetricCapture(
                      owner,
                      manifest,
                      pass,
                      operation,
                    ),
                  [owner],
                  [pass.initiatorAgentId],
                ),
              finalizeMetricCaptures: (captures, pass, operation) =>
                metricOperation(
                  true,
                  operation,
                  () =>
                    repository.finalizeMetricCaptures(
                      captures,
                      pass,
                      operation,
                    ),
                  captures.map(({ owner }) => owner),
                  [pass.initiatorAgentId],
                ),
              terminateMetricCapture: (owner, status, reason, operation) =>
                metricOperation(
                  true,
                  operation,
                  () =>
                    repository.terminateMetricCapture(
                      owner,
                      status,
                      reason,
                      operation,
                    ),
                  [owner],
                ),
              getMetricCapture: (id, operation) =>
                metricOperation(false, operation, () =>
                  repository.getMetricCapture(id, operation),
                ),
              listMetricCaptures: (query, operation) =>
                metricOperation(false, operation, () =>
                  repository.listMetricCaptures(query, operation),
                ),
              listMetricChunks: (query, operation) =>
                metricOperation(false, operation, () =>
                  repository.listMetricChunks(query, operation),
                ),
            };
            const handle: EntityContextRepository = {
              sessionId: repository.sessionId,
              incrementalMetrics,
              publicationIdentity: Object.freeze({}),
              get liveSetId() {
                return repository.liveSetId;
              },
              appendPass: async (input, operation) => {
                writing.set(session.id, (writing.get(session.id) ?? 0) + 1);
                try {
                  operation?.signal?.throwIfAborted();
                  const owner = await requireSession(session.id);
                  if (
                    !sameOwner(session, owner) ||
                    !owner.activeAgents.some(
                      ({ id }) => id === input.pass.initiatorAgentId,
                    )
                  ) {
                    throw new Error(
                      "Context writer no longer belongs to the invoking session ownership",
                    );
                  }
                  await repository.appendPass(input, operation);
                  reserved.get(session.id)?.delete(input.pass.id);
                  if (reserved.get(session.id)?.size === 0)
                    reserved.delete(session.id);
                } finally {
                  const remaining = (writing.get(session.id) ?? 1) - 1;
                  if (remaining > 0) writing.set(session.id, remaining);
                  else writing.delete(session.id);
                }
              },
              getPass: (...args) => repository.getPass(...args),
              listPasses: (...args) => repository.listPasses(...args),
              getEntry: (...args) => repository.getEntry(...args),
              listEntries: (...args) => repository.listEntries(...args),
              deriveFeatures: async (entryId, operation) => {
                writing.set(session.id, (writing.get(session.id) ?? 0) + 1);
                try {
                  await run(
                    "validate-feature-writer",
                    async () => {
                      const owner = await requireSession(session.id);
                      if (
                        transitioning.has(session.id) ||
                        !sameOwner(session, owner) ||
                        !owner.activeAgents.some(
                          ({ id }) => id === operation?.activeAgentId,
                        )
                      )
                        throw new Error(
                          "Context writer no longer belongs to the invoking session ownership",
                        );
                    },
                    {
                      ...operation,
                      sessionId: session.id,
                      liveSetId: session.liveSetId,
                    },
                  );
                  return await repository.deriveFeatures(entryId, operation);
                } finally {
                  const remaining = (writing.get(session.id) ?? 1) - 1;
                  if (remaining > 0) writing.set(session.id, remaining);
                  else writing.delete(session.id);
                }
              },
              getFeatureDerivation: (...args) =>
                repository.getFeatureDerivation(...args),
              getFeature: (...args) => repository.getFeature(...args),
              getSegment: (...args) => repository.getSegment(...args),
              listFeatures: (...args) => repository.listFeatures(...args),
              searchFeatures: (...args) => repository.searchFeatures(...args),
              getSubject: (...args) => repository.getSubject(...args),
              getLink: (...args) => repository.getLink(...args),
              listLinks: (...args) => repository.listLinks(...args),
              assessLink: (...args) => repository.assessLink(...args),
              prune: (...args) => repository.prune(...args),
              transitionLiveSetOwnership: () =>
                Promise.reject(
                  new Error(
                    "Use the validated Desktop session transition hook",
                  ),
                ),
              reservePass: async (id, bytes, operation) => {
                writing.set(session.id, (writing.get(session.id) ?? 0) + 1);
                try {
                  await repository.reservePass(id, bytes, operation);
                  const ids = reserved.get(session.id) ?? new Set<string>();
                  ids.add(id);
                  reserved.set(session.id, ids);
                } finally {
                  const remaining = (writing.get(session.id) ?? 1) - 1;
                  if (remaining > 0) writing.set(session.id, remaining);
                  else writing.delete(session.id);
                }
              },
              releaseReservation: async (id, operation) => {
                await repository.releaseReservation(id, operation);
                reserved.get(session.id)?.delete(id);
                if (reserved.get(session.id)?.size === 0)
                  reserved.delete(session.id);
              },
              close: async () => {
                await repository.close();
                if (cached.get(session.id)?.repository !== repository) return;
                cached.delete(session.id);
                reserved.delete(session.id);
                const entry = await options.resolveSession(session.id);
                if (created && entry?.contextStore === undefined)
                  await rm(paths.entityContextPath, { force: true });
              },
            };
            cached.set(session.id, {
              session: current,
              repository,
              handle,
              created,
            });
            return handleForActor(handle, context);
          } catch (error) {
            await repository.close();
            const current = await options.resolveSession(session.id);
            if (created && current?.contextStore === undefined)
              await rm(paths.entityContextPath, { force: true });
            throw error;
          }
        },
        {
          ...operationOptions,
          trace: context.trace,
          sessionId: context.sessionId,
          ...(context.actorKind === "application"
            ? {}
            : { activeAgentId: context.agentId }),
        },
      );
    },
    prepareSessionTransition,
    close: (): Promise<void> => {
      if (closing !== undefined) return closing;
      if (transitioning.size > 0)
        return run("close", async () => {
          throw new Error(
            "Cannot close context manager during an unfinished ownership transition",
          );
        });
      closing = run("close", async () => {
        const results = await Promise.allSettled(
          [...cached.values()].map(async ({ session, repository, created }) => {
            await repository.close();
            if (created && session.contextStore === undefined)
              await rm(pathsFor(session).entityContextPath, { force: true });
          }),
        );
        cached.clear();
        writing.clear();
        reserved.clear();
        closed = true;
        const failures = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason as unknown] : [],
        );
        if (failures.length > 0)
          throw new AggregateError(
            failures,
            "Context repositories could not all be closed",
          );
      });
      return closing;
    },
  };
}

export type DesktopSessionContextManager = ReturnType<
  typeof createDesktopSessionContextManager
>;
