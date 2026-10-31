import { randomUUID } from "node:crypto";

import {
  sanitizeTelemetryAttributes,
  sanitizePersistedText,
  type NonBlockingObservabilityRecorder,
} from "@ableton-agent/observability";
import {
  legacyStoredAudioObservationSchema,
  metricAudioObservationSchema,
  storedObservationIdentity,
  storedObservationCoordinates,
  summarizeMetricListeningResult,
  sessionListeningLaunchDetailSchema,
  listeningFailureEvidenceSchema,
  readListeningFailureEvidence,
  type ListeningFailureEvidence,
  type ListeningFailureFact,
  type SessionListeningLaunchDetail,
  type SessionListeningJobDetail,
  type InspectSessionListeningSourceParams,
  type StoredAudioObservation,
  type MetricListeningResultSummary,
} from "@ableton-agent/protocol";

export const listeningLimits = {
  maxListeners: 8,
  maxDurationMs: 300_000,
  readinessTimeoutMs: 10_000,
  cleanupTimeoutMs: 10_000,
  maxJobs: 100,
} as const;

export interface ListeningOwner {
  readonly sessionId: string;
  readonly liveSetId: string;
  readonly agentId: string;
}

export interface ListeningTrace {
  readonly traceId: string;
  readonly correlationId: string;
  readonly causationId: string;
}

export type ListeningRequest =
  | {
      readonly mode: "session";
      readonly listenerIds: readonly string[];
      readonly clipReference: string;
      readonly trackReference: string;
      readonly target?: InspectSessionListeningSourceParams["target"];
      readonly durationBeats?: number;
      readonly maximumDurationMs: number;
    }
  | {
      readonly mode: "arrangement";
      readonly listenerIds: readonly string[];
      readonly startBeat: number;
      readonly endBeat: number;
      readonly maximumDurationMs: number;
    };

export interface ListeningPlaybackSnapshot {
  readonly liveSetId: string;
  readonly isPlaying: boolean;
  readonly isRecording: boolean;
  readonly recordingStateKnown: boolean;
  readonly identityVerified: boolean;
}

export type OwnedListeningPlayback =
  | {
      /** False means a user or another session has taken over playback. */
      readonly cleanupPolicy?: "stop-owned";
      isOwned(): boolean;
      stop(): Promise<void>;
    }
  | {
      readonly cleanupPolicy: "leave-running";
      /** Release local monitors only; never stop, seek or otherwise mutate transport. */
      release(): Promise<void>;
    };

export interface PreparedListeningCapture {
  /** Set only after explicit native capability/control/proof negotiation. */
  readonly observationContract?: "independent-metric-timelines/v1";
  readonly observations: Promise<readonly StoredAudioObservation[]>;
  disarm(): Promise<void>;
}

export interface ListeningPassContext {
  readonly passId: string;
  readonly owner: ListeningOwner;
  readonly trace: ListeningTrace;
}

export interface ListeningCoordinatorServices {
  inspect(
    this: void,
    request: ListeningRequest,
    signal: AbortSignal,
    context: ListeningPassContext,
  ): Promise<ListeningPlaybackSnapshot>;
  /** Reserve quota before arming; compensate setup that completes after abort. */
  reservePublication(
    this: void,
    input: {
      readonly request: ListeningRequest;
      readonly passId: string;
      readonly owner: ListeningOwner;
      readonly trace: ListeningTrace;
      readonly signal: AbortSignal;
    },
  ): Promise<ListeningPublicationReservation>;
  /** Must disarm any partially prepared listeners if the signal is aborted. */
  prepare(
    this: void,
    input: {
      readonly request: ListeningRequest;
      readonly passId: string;
      readonly owner: ListeningOwner;
      readonly trace: ListeningTrace;
      readonly signal: AbortSignal;
    },
  ): Promise<PreparedListeningCapture>;
  /** Must guard stopped/recording-off state again and clean up aborted starts. */
  startPlayback(
    this: void,
    input: {
      readonly request: ListeningRequest;
      readonly passId: string;
      readonly owner: ListeningOwner;
      readonly trace: ListeningTrace;
      readonly signal: AbortSignal;
      readonly onSessionLaunch?: (detail: SessionListeningLaunchDetail) => void;
    },
  ): Promise<OwnedListeningPlayback>;
  /** Must atomically commit all observations, honoring abort before commit. */
  persist(
    this: void,
    input: {
      readonly passId: string;
      readonly owner: ListeningOwner;
      readonly trace: ListeningTrace;
      readonly request: ListeningRequest;
      readonly observations: readonly StoredAudioObservation[];
      readonly signal: AbortSignal;
    },
  ): Promise<readonly string[]>;
  validateObservations(
    this: void,
    observations: readonly StoredAudioObservation[],
    request: ListeningRequest,
    passId: string,
  ): void;
}

export interface ListeningPublicationReservation {
  release(this: void): Promise<void>;
}

export type ListeningStage =
  | "queued"
  | "validating"
  | "reserving-context"
  | "arming"
  | "starting-playback"
  | "capturing"
  | "persisting"
  | "completed"
  | "partial"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface ListeningJob {
  readonly passId: string;
  readonly owner: ListeningOwner;
  readonly trace: ListeningTrace;
  readonly stage: ListeningStage;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly durationMs: number;
  readonly contextIds: readonly string[];
  readonly metricResults?: readonly MetricListeningResultSummary[];
  readonly error?: string;
  readonly failureEvidence?: ListeningFailureEvidence;
  readonly cleanupPolicy?: "stop-owned" | "leave-running";
  readonly session?: SessionListeningJobDetail;
}

interface RunningJob {
  readonly controller: AbortController;
  readonly startedAt: number;
  readonly elapsed?: () => number;
  readinessBoundary?:
    | "initial-inspection"
    | "context-reservation"
    | "listener-preparation"
    | "post-arm-inspection";
  snapshot: ListeningJob;
  completion: Promise<ListeningJob>;
}

export class ListeningFailure extends Error {
  readonly retryable = false;
  declare readonly check?: ListeningCheck;
  declare readonly failureEvidence?: ListeningFailureEvidence;

  constructor(
    readonly code: string,
    message: string,
    evidenceOrCheck?: ListeningFailureEvidence | ListeningCheck,
  ) {
    super(message);
    this.name = "ListeningFailure";
    if (evidenceOrCheck !== undefined) {
      if ("schema" in evidenceOrCheck) this.failureEvidence = evidenceOrCheck;
      else this.check = evidenceOrCheck;
    }
  }
}

interface ListeningCheck {
  readonly checkId: string;
  readonly facts: readonly ListeningFailureFact[];
  readonly phase?: ListeningFailureEvidence["phase"];
}

export { fact as listeningFailureFact };

function evidenceValue(value: unknown): ListeningFailureFact["actual"] {
  const sanitized =
    typeof value === "string" ? sanitizePersistedText(value) : value;
  if (
    typeof sanitized === "boolean" ||
    (typeof sanitized === "string" && sanitized.length <= 256) ||
    (typeof sanitized === "number" &&
      Number.isFinite(sanitized) &&
      Math.abs(sanitized) <= Number.MAX_SAFE_INTEGER)
  )
    return { state: "observed", value: sanitized };
  return {
    state: "unavailable",
    reason:
      typeof sanitized === "number" && !Number.isFinite(sanitized)
        ? "nonfinite"
        : sanitized === undefined
          ? "not-reported"
          : "invalid",
  };
}

function fact(
  field: string,
  actual: unknown,
  expected?: string | number | boolean,
  comparison: ListeningFailureFact["comparison"] = "equal",
): ListeningFailureFact {
  return {
    field,
    actual: evidenceValue(actual),
    ...(expected === undefined
      ? {}
      : {
          expected: evidenceValue(expected),
          comparison,
        }),
  };
}

function primaryFailure(error: unknown): unknown {
  // Cleanup errors following the initiating rejection must never replace it.
  for (let depth = 0; depth < 8; depth++) {
    if (error === null || typeof error !== "object") return error;
    const errors: unknown = Object.getOwnPropertyDescriptor(
      error,
      "errors",
    )?.value;
    if (
      error instanceof AggregateError &&
      Array.isArray(errors) &&
      errors.length
    ) {
      error = errors[0];
      continue;
    }
    const cause: unknown = Object.getOwnPropertyDescriptor(
      error,
      "cause",
    )?.value;
    if (cause === undefined) return error;
    error = cause;
  }
  return error;
}

function errorCode(error: unknown): string {
  const value =
    error !== null && typeof error === "object" && "code" in error
      ? error.code
      : undefined;
  const sanitized =
    typeof value === "string" ? sanitizePersistedText(value) : undefined;
  return sanitized !== undefined &&
    /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/u.test(sanitized)
    ? sanitized
    : "listening_failed";
}

function sanitizeEvidence(
  evidence: ListeningFailureEvidence,
): ListeningFailureEvidence | undefined {
  // Walk only the already validated, bounded DTO, not arbitrary error properties.
  const sanitize = (value: unknown): unknown => {
    if (typeof value === "string") return sanitizePersistedText(value);
    if (Array.isArray(value)) return value.map(sanitize);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value)
          .filter(([, item]) => item !== undefined)
          .map(([key, item]) => [key, sanitize(item)]),
      );
    }
    return value;
  };
  const parsed = listeningFailureEvidenceSchema.safeParse(sanitize(evidence));
  if (!parsed.success) return undefined;
  const missingOperands = parsed.data.facts.some(
    ({ actual, expected }) =>
      actual.state === "unavailable" || expected?.state === "unavailable",
  );
  return {
    ...parsed.data,
    // Source authority is immutable; coordinator defaults apply only to new
    // application boundary evidence, never to an accepted source DTO.
    component: evidence.component,
    phase: evidence.phase,
    ...(parsed.data.coverage === "complete" && missingOperands
      ? {
          coverage: "partial" as const,
          coverageReasons: ["missing-operands" as const],
        }
      : {}),
  };
}

function evidenceFor(
  error: unknown,
  job: ListeningJob,
  boundary: ListeningCheck,
): ListeningFailureEvidence {
  const primary = primaryFailure(error);
  const source = readListeningFailureEvidence(error);
  if (
    source.status === "present" &&
    source.evidence.reference.passId === job.passId &&
    source.evidence.reference.traceId === job.trace.traceId
  ) {
    const sanitized = sanitizeEvidence(source.evidence);
    if (sanitized !== undefined) return sanitized;
  }
  const check =
    primary instanceof ListeningFailure && primary.check !== undefined
      ? primary.check
      : boundary;
  const sourceFacts =
    source.status === "absent"
      ? [
          {
            field: "sourceFailureOperands",
            actual: {
              state: "unavailable" as const,
              reason: "not-reported" as const,
            },
          },
        ]
      : [
          fact("sourceEvidenceSchemaValid", source.status === "present", true),
          ...(source.status === "present"
            ? [
                fact(
                  "sourceEvidencePassMatches",
                  source.evidence.reference.passId === job.passId,
                  true,
                ),
                fact(
                  "sourceEvidenceTraceMatches",
                  source.evidence.reference.traceId === job.trace.traceId,
                  true,
                ),
              ]
            : [fact("sourceEvidenceRejection", source.reason)]),
        ];
  const owned =
    primary instanceof ListeningFailure && primary.check !== undefined;
  const sourceRejected = source.status !== "absent";
  const allFacts = [
    ...check.facts,
    ...(owned && !sourceRejected ? [] : sourceFacts),
  ];
  const facts = allFacts.slice(0, 24);
  const missingOperands = facts.some(
    ({ actual, expected }) =>
      actual.state === "unavailable" || expected?.state === "unavailable",
  );
  const truncated = allFacts.length > 24;
  const evidence: ListeningFailureEvidence = {
    schema: "listening-failure/v1",
    code: errorCode(primary),
    phase: check.phase ?? boundary.phase ?? "validation",
    component: check.phase === "cleanup" ? "cleanup" : "listening-coordinator",
    checkId: check.checkId,
    summary:
      sanitizePersistedText(failureMessage(primary)).slice(0, 1024) ||
      "Listening operation failed",
    coverage: owned
      ? missingOperands || truncated || sourceRejected
        ? "partial"
        : "complete"
      : "unavailable",
    coverageReasons: owned
      ? [
          ...(missingOperands ? ["missing-operands" as const] : []),
          ...(truncated ? ["diagnostic-truncated" as const] : []),
          ...(sourceRejected ? ["invalid-evidence" as const] : []),
        ]
      : [
          source.status === "absent"
            ? "source-evidence-not-reported"
            : "invalid-evidence",
        ],
    facts,
    reference: {
      passId: job.passId,
      traceId: job.trace.traceId,
      correlationId: job.trace.correlationId,
      causationId: job.trace.causationId,
    },
  };
  // Application IDs use the same contract as native IDs. Never invent a pass or
  // repair a foreign reference to make source evidence appear authoritative.
  return (
    sanitizeEvidence(evidence) ??
    listeningFailureEvidenceSchema.parse({
      ...evidence,
      code: "listening_failed",
      checkId: "application.evidence.unavailable",
      coverage: "unavailable",
      coverageReasons: ["invalid-evidence"],
      facts: [],
      reference: { passId: job.passId, traceId: job.trace.traceId },
    })
  );
}

function terminal(stage: ListeningStage): boolean {
  return [
    "completed",
    "partial",
    "failed",
    "cancelled",
    "interrupted",
  ].includes(stage);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new ListeningFailure("cancelled", "Listening was cancelled", {
        checkId: "application.cancellation.signal",
        facts: [fact("aborted", signal.aborted, false)],
      });
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

function failureMessage(value: unknown): string {
  return sanitizePersistedText(
    value instanceof Error
      ? value.message
      : typeof value === "string"
        ? value
        : "Listening operation failed with a non-Error rejection",
  );
}

async function bounded<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal === undefined) return operation;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    operation.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

export { bounded as awaitListeningBoundary };

async function boundedCleanup<T>(operation: Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(
      new ListeningFailure("cleanup_timeout", "Listening cleanup timed out", {
        checkId: "application.deadline.cleanup",
        phase: "cleanup",
        facts: [
          fact("cleanupTimeoutMs", listeningLimits.cleanupTimeoutMs),
          fact("deadlineExpired", true, false),
        ],
      }),
    );
  }, listeningLimits.cleanupTimeoutMs);
  timer.unref?.();
  try {
    return await bounded(operation, controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

function sameOwner(left: ListeningOwner, right: ListeningOwner): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.liveSetId === right.liveSetId &&
    left.agentId === right.agentId
  );
}

function validateRequest(request: ListeningRequest): void {
  if (
    request.listenerIds.length === 0 ||
    request.listenerIds.length > listeningLimits.maxListeners ||
    new Set(request.listenerIds).size !== request.listenerIds.length ||
    request.listenerIds.some((id) => id.length === 0 || id.length > 256)
  ) {
    throw new ListeningFailure(
      "invalid_params",
      "Select one to eight distinct listener IDs",
      {
        checkId: "application.input.listeners",
        facts: [
          fact("listenerCount", request.listenerIds.length, 8, "at-most"),
          fact(
            "minimumListenerCount",
            request.listenerIds.length,
            1,
            "at-least",
          ),
          fact(
            "distinctListenerCount",
            new Set(request.listenerIds).size,
            request.listenerIds.length,
          ),
          fact(
            "invalidListenerIdCount",
            request.listenerIds.filter(
              (id) => id.length === 0 || id.length > 256,
            ).length,
            0,
          ),
        ],
      },
    );
  }

  if (
    !Number.isInteger(request.maximumDurationMs) ||
    request.maximumDurationMs <= 0 ||
    request.maximumDurationMs > listeningLimits.maxDurationMs
  ) {
    throw new ListeningFailure(
      "invalid_params",
      "Capture duration must be bounded to at most 300 seconds",
      {
        checkId: "application.input.duration",
        facts: [
          fact(
            "maximumDurationMs",
            request.maximumDurationMs,
            listeningLimits.maxDurationMs,
            "at-most",
          ),
          fact("minimumDurationMs", request.maximumDurationMs, 1, "at-least"),
          fact(
            "integerDuration",
            Number.isInteger(request.maximumDurationMs),
            true,
          ),
        ],
      },
    );
  }
  if (
    request.mode === "session" &&
    ((request.durationBeats !== undefined &&
      (!Number.isFinite(request.durationBeats) ||
        request.durationBeats <= 0)) ||
      request.listenerIds.length !== 1 ||
      !request.clipReference ||
      !request.trackReference)
  ) {
    throw new ListeningFailure(
      "invalid_params",
      "Session listening requires one exact clip, one same-track listener and a positive first-iteration duration or the full active region",
      {
        checkId: "application.input.session",
        facts: [
          fact("listenerCount", request.listenerIds.length, 1),
          ...(request.durationBeats === undefined
            ? []
            : [fact("durationBeats", request.durationBeats)]),
          fact("durationOmitted", request.durationBeats === undefined),
          fact(
            "validDuration",
            request.durationBeats === undefined ||
              (Number.isFinite(request.durationBeats) &&
                request.durationBeats > 0),
            true,
          ),
          fact("clipReferencePresent", Boolean(request.clipReference), true),
          fact("trackReferencePresent", Boolean(request.trackReference), true),
        ],
      },
    );
  }
  if (
    request.mode === "arrangement" &&
    (!Number.isFinite(request.startBeat) ||
      request.startBeat < 0 ||
      !Number.isFinite(request.endBeat) ||
      request.endBeat <= request.startBeat)
  ) {
    throw new ListeningFailure(
      "invalid_params",
      "Arrangement listening requires an ordered nonnegative beat range",
      {
        checkId: "application.input.arrangement",
        facts: [
          fact("startBeat", request.startBeat, 0, "at-least"),
          fact("endBeat", request.endBeat),
          fact("orderedRange", request.endBeat > request.startBeat, true),
        ],
      },
    );
  }
}

function validatePlaybackSnapshot(
  snapshot: ListeningPlaybackSnapshot,
  owner: ListeningOwner,
): void {
  if (snapshot.liveSetId !== owner.liveSetId || !snapshot.identityVerified) {
    throw new ListeningFailure(
      "stale_reference",
      "Listening targets no longer match the active Live Set",
      {
        checkId: "application.binding.live-set",
        facts: [
          fact("liveSetId", snapshot.liveSetId, owner.liveSetId),
          fact("identityVerified", snapshot.identityVerified, true),
        ],
      },
    );
  }
  if (
    !snapshot.recordingStateKnown ||
    snapshot.isRecording ||
    snapshot.isPlaying
  ) {
    throw new ListeningFailure(
      "conflict",
      "Listening requires verified recording-off and stopped transport",
      {
        checkId: "application.playback.stopped-recording-off",
        facts: [
          fact("recordingStateKnown", snapshot.recordingStateKnown, true),
          fact("isRecording", snapshot.isRecording, false),
          fact("isPlaying", snapshot.isPlaying, false),
        ],
      },
    );
  }
}

export interface ListeningCoordinatorOptions {
  readonly services: ListeningCoordinatorServices;
  readonly telemetry?: Pick<NonBlockingObservabilityRecorder, "enqueue">;
  readonly now?: () => number;
  readonly createId?: () => string;
  readonly onChange?: (job: ListeningJob) => void;
}

export function recordListeningAttemptFailure(
  options: Pick<ListeningCoordinatorOptions, "telemetry" | "now">,
  error: unknown,
  owner: Pick<ListeningOwner, "sessionId" | "agentId">,
  trace: ListeningTrace,
  startedAt: number,
  fallback?: ListeningCheck,
): void {
  const now = (options.now ?? Date.now)();
  const primary = primaryFailure(error);
  const check =
    (primary instanceof ListeningFailure ? primary.check : undefined) ??
    fallback;
  options.telemetry?.enqueue({
    version: 2,
    id: randomUUID(),
    occurredAt: new Date(now).toISOString(),
    name:
      errorCode(primary) === "cancelled" ||
      (primary instanceof Error && primary.name === "AbortError")
        ? "listening.attempt.cancelled"
        : "listening.attempt.failed",
    source: "listening-coordinator",
    level: "error",
    durationMs: Math.max(0, now - startedAt),
    sessionId: sanitizePersistedText(owner.sessionId),
    activeAgentId: sanitizePersistedText(owner.agentId),
    correlationId: sanitizePersistedText(trace.correlationId),
    causationId: sanitizePersistedText(trace.causationId),
    trace: { traceId: trace.traceId, spanId: randomUUID() },
    attributes: sanitizeTelemetryAttributes({
      code: errorCode(primary),
      checkId: check?.checkId ?? "application.host.operation",
      facts: check?.facts ?? [],
      error: failureMessage(primary),
      coverage: check === undefined ? "unavailable" : "partial",
      coverageReasons: ["source-evidence-not-reported"],
      passIdState: "not-accepted",
      sourceFact:
        "No accepted pass exists for this rejected invocation; native predicates were not observed",
    }),
  });
}

/** The host supplies verified playback/capture adapters; no raw sockets or LOM. */
export class ListeningCoordinator {
  readonly #jobs = new Map<string, RunningJob>();
  readonly #now: () => number;
  readonly #createId: () => string;
  #active: string | undefined;
  #closed = false;

  constructor(readonly options: ListeningCoordinatorOptions) {
    this.#now = options.now ?? Date.now;
    this.#createId = options.createId ?? randomUUID;
  }

  start(
    request: ListeningRequest,
    owner: ListeningOwner,
    trace: ListeningTrace,
    signal?: AbortSignal,
  ): ListeningJob {
    const attemptStartedAt = this.#now();
    try {
      if (signal?.aborted) throw abortReason(signal);
      validateRequest(request);
      if (
        [owner.sessionId, owner.liveSetId, owner.agentId].some(
          (id) => id.length === 0 || id.length > 256,
        )
      ) {
        throw new ListeningFailure(
          "invalid_params",
          "Listening owner is invalid",
          {
            checkId: "application.input.owner",
            facts: [
              fact("sessionIdLength", owner.sessionId.length, 256, "at-most"),
              fact("liveSetIdLength", owner.liveSetId.length, 256, "at-most"),
              fact("agentIdLength", owner.agentId.length, 256, "at-most"),
              fact(
                "emptyOwnerIdCount",
                [owner.sessionId, owner.liveSetId, owner.agentId].filter(
                  (id) => id.length === 0,
                ).length,
                0,
              ),
            ],
          },
        );
      }
      if (this.#closed) {
        throw new ListeningFailure("unavailable", "Listening is shut down", {
          checkId: "application.admission.open",
          facts: [fact("closed", this.#closed, false)],
        });
      }
      if (this.#active !== undefined) {
        throw new ListeningFailure(
          "conflict",
          "Another listening pass is active",
          {
            checkId: "application.admission.concurrency",
            facts: [
              fact("activePassId", this.#active),
              fact("activePassCount", 1, 0),
            ],
          },
        );
      }
      while (this.#jobs.size >= listeningLimits.maxJobs) {
        const oldest = [...this.#jobs].find(([, job]) =>
          terminal(job.snapshot.stage),
        );
        if (oldest === undefined) {
          throw new ListeningFailure(
            "quota_exceeded",
            "Listening job quota full",
            {
              checkId: "application.admission.quota",
              facts: [
                fact(
                  "jobCount",
                  this.#jobs.size,
                  listeningLimits.maxJobs - 1,
                  "at-most",
                ),
                fact("evictableJobCount", 0, 1, "at-least"),
              ],
            },
          );
        }
        this.#jobs.delete(oldest[0]);
      }
    } catch (error) {
      recordListeningAttemptFailure(
        this.options,
        error,
        owner,
        trace,
        attemptStartedAt,
      );
      throw error;
    }
    const passId = this.#createId();
    const now = this.#now();
    const snapshot: ListeningJob = {
      passId,
      owner: { ...owner },
      trace: { ...trace },
      stage: "queued",
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      durationMs: 0,
      contextIds: [],
      ...(request.mode === "session"
        ? {
            cleanupPolicy: "leave-running" as const,
            ...(request.target
              ? {
                  session: {
                    clipName: sanitizePersistedText(
                      request.target.expectedClipName,
                    ).slice(0, 128),
                    trackName: sanitizePersistedText(
                      request.target.track.expectedName,
                    ).slice(0, 128),
                    sceneIndex: request.target.sceneIndex,
                    ...(request.durationBeats === undefined
                      ? {}
                      : { durationBeats: request.durationBeats }),
                  },
                }
              : {}),
          }
        : {}),
    };
    const acceptedMonotonic = performance.now();
    const job: RunningJob = {
      controller: new AbortController(),
      startedAt: now,
      ...(request.mode === "session"
        ? {
            elapsed: () => Math.max(0, performance.now() - acceptedMonotonic),
          }
        : {}),
      snapshot,
      completion: Promise.resolve(snapshot),
    };
    this.#jobs.set(passId, job);
    this.#active = passId;
    const cancel = () =>
      job.controller.abort(
        signal?.reason instanceof ListeningFailure
          ? signal.reason
          : new ListeningFailure(
              "cancelled",
              "Listening caller was cancelled",
              {
                checkId: "application.cancellation.caller",
                facts: [fact("callerAborted", signal?.aborted, false)],
              },
            ),
      );
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    const overallTimer =
      request.mode === "session"
        ? setTimeout(
            () => {
              job.controller.abort(
                new ListeningFailure(
                  "timeout",
                  "Session listening exceeded its total budget, including setup and launch",
                  {
                    checkId: "application.deadline.session",
                    phase: "capture",
                    facts: [
                      fact("maximumDurationMs", request.maximumDurationMs),
                      fact(
                        "elapsedMs",
                        Math.max(0, performance.now() - acceptedMonotonic),
                      ),
                      fact("deadlineExpired", true, false),
                    ],
                  },
                ),
              );
            },
            Math.max(
              0,
              request.maximumDurationMs -
                (performance.now() - acceptedMonotonic),
            ),
          )
        : undefined;
    overallTimer?.unref?.();
    job.completion = Promise.resolve()
      .then(() => this.#run(job, structuredClone(request)))
      .finally(() => {
        clearTimeout(overallTimer);
        signal?.removeEventListener("abort", cancel);
      });
    this.#transition(job, "queued");
    return structuredClone(job.snapshot);
  }

  get(passId: string, owner: ListeningOwner): ListeningJob {
    return structuredClone(this.#ownedJob(passId, owner).snapshot);
  }

  list(owner: ListeningOwner): readonly ListeningJob[] {
    return [...this.#jobs.values()]
      .filter((job) => sameOwner(job.snapshot.owner, owner))
      .map((job) => structuredClone(job.snapshot));
  }

  wait(passId: string, owner: ListeningOwner): Promise<ListeningJob> {
    return this.#ownedJob(passId, owner).completion;
  }

  async cancel(passId: string, owner: ListeningOwner): Promise<ListeningJob> {
    const job = this.#ownedJob(passId, owner);
    if (!terminal(job.snapshot.stage)) {
      job.controller.abort(
        new ListeningFailure(
          "cancelled",
          "Listening was cancelled by its owner",
          {
            checkId: "application.cancellation.owner",
            facts: [fact("ownerCancellationRequested", true, false)],
          },
        ),
      );
    }
    return structuredClone(await job.completion);
  }

  async shutdown(): Promise<void> {
    this.#closed = true;
    for (const job of this.#jobs.values()) {
      if (!terminal(job.snapshot.stage)) {
        job.controller.abort(
          new ListeningFailure("cancelled", "Listening host is shutting down", {
            checkId: "application.cancellation.shutdown",
            facts: [fact("hostClosed", this.#closed, false)],
          }),
        );
      }
    }
    await Promise.all([...this.#jobs.values()].map((job) => job.completion));
  }

  #ownedJob(passId: string, owner: ListeningOwner): RunningJob {
    const job = this.#jobs.get(passId);
    if (job === undefined || !sameOwner(job.snapshot.owner, owner)) {
      throw new ListeningFailure(
        "permission_denied",
        "No listening pass belongs to this session and agent",
        {
          checkId: "application.query.pass-owner",
          facts: [
            fact("passExists", job !== undefined, true),
            fact(
              "sessionMatches",
              job?.snapshot.owner.sessionId === owner.sessionId,
              true,
            ),
            fact(
              "agentMatches",
              job?.snapshot.owner.agentId === owner.agentId,
              true,
            ),
            fact(
              "liveSetMatches",
              job?.snapshot.owner.liveSetId === owner.liveSetId,
              true,
            ),
          ],
        },
      );
    }
    return job;
  }

  async #run(
    job: RunningJob,
    request: ListeningRequest,
  ): Promise<ListeningJob> {
    const signal = job.controller.signal;
    let capture: PreparedListeningCapture | undefined;
    let playback: OwnedListeningPlayback | undefined;
    let reservation: ListeningPublicationReservation | undefined;
    let failure: unknown;
    let firstEvidence: ListeningFailureEvidence | undefined;
    let boundary: ListeningCheck = {
      checkId: "application.binding.inspect",
      phase: "validation",
      facts: [],
    };
    let finalStage: ListeningStage = "completed";
    let contextIds: readonly string[] = [];
    let metricResults: readonly MetricListeningResultSummary[] | undefined;
    const readinessTimer = () => {
      const deadline = setTimeout(() => {
        job.controller.abort(
          new ListeningFailure(
            "timeout",
            `Listener readiness timed out during ${job.readinessBoundary}`,
            {
              checkId: `application.deadline.${job.readinessBoundary}`,
              phase: boundary.phase ?? "validation",
              facts: [
                fact("readinessTimeoutMs", listeningLimits.readinessTimeoutMs),
                fact("readinessBoundary", job.readinessBoundary),
                fact("deadlineExpired", true, false),
              ],
            },
          ),
        );
      }, listeningLimits.readinessTimeoutMs);
      deadline.unref?.();
      return deadline;
    };
    job.readinessBoundary = "initial-inspection";
    let timer = readinessTimer();
    try {
      checkAbort(signal);
      this.#transition(job, "validating");
      const snapshot = await bounded(
        this.options.services.inspect(request, signal, job.snapshot),
        signal,
      );
      checkAbort(signal);
      validatePlaybackSnapshot(snapshot, job.snapshot.owner);
      boundary = {
        checkId: "application.publication.reserve",
        phase: "publication",
        facts: [],
      };
      job.readinessBoundary = "context-reservation";
      this.#transition(job, "reserving-context");
      reservation = await bounded(
        this.options.services.reservePublication({
          request,
          passId: job.snapshot.passId,
          owner: job.snapshot.owner,
          trace: job.snapshot.trace,
          signal,
        }),
        signal,
      );
      checkAbort(signal);
      clearTimeout(timer);
      timer = readinessTimer();
      job.readinessBoundary = "listener-preparation";
      boundary = {
        checkId: "application.capture.prepare",
        phase: "preparation",
        facts: [],
      };
      this.#transition(job, "arming");
      capture = await bounded(
        this.options.services.prepare({
          request,
          passId: job.snapshot.passId,
          owner: job.snapshot.owner,
          trace: job.snapshot.trace,
          signal,
        }),
        signal,
      );
      // Observe a rejected result immediately, including before playback starts.
      void capture.observations.catch(() => undefined);
      checkAbort(signal);
      job.readinessBoundary = "post-arm-inspection";
      boundary = {
        checkId: "application.binding.post-arm-inspect",
        phase: "post-binding",
        facts: [],
      };
      this.#transition(job, "arming");
      validatePlaybackSnapshot(
        await bounded(
          this.options.services.inspect(request, signal, job.snapshot),
          signal,
        ),
        job.snapshot.owner,
      );
      checkAbort(signal);
      delete job.readinessBoundary;
      this.#transition(job, "starting-playback");
      boundary = {
        checkId: "application.playback.start",
        phase: "launch",
        facts: [],
      };
      clearTimeout(timer);
      if (request.mode === "arrangement") {
        timer = setTimeout(() => {
          job.controller.abort(
            new ListeningFailure(
              "timeout",
              "Listening capture exceeded its budget",
              {
                checkId: "application.deadline.capture",
                phase: "capture",
                facts: [
                  fact("maximumDurationMs", request.maximumDurationMs),
                  fact("deadlineExpired", true, false),
                ],
              },
            ),
          );
        }, request.maximumDurationMs);
        timer.unref?.();
      }
      playback = await bounded(
        this.options.services.startPlayback({
          request,
          passId: job.snapshot.passId,
          owner: job.snapshot.owner,
          trace: job.snapshot.trace,
          signal,
          ...(request.mode === "session" && job.snapshot.session
            ? {
                onSessionLaunch: (raw: SessionListeningLaunchDetail) => {
                  if (terminal(job.snapshot.stage) || signal.aborted) return;
                  const detail = sessionListeningLaunchDetailSchema.parse(raw);
                  job.snapshot = {
                    ...job.snapshot,
                    session: { ...job.snapshot.session!, launch: detail },
                  };
                  this.#transition(job, job.snapshot.stage);
                },
              }
            : {}),
        }),
        signal,
      );
      job.snapshot = {
        ...job.snapshot,
        cleanupPolicy: playback.cleanupPolicy ?? "stop-owned",
      };
      checkAbort(signal);
      this.#transition(job, "capturing");
      boundary = {
        checkId: "application.observation.schema",
        phase: "capture",
        facts: [],
      };
      const rawObservations = await bounded(capture.observations, signal);
      const metricContract =
        capture.observationContract === "independent-metric-timelines/v1";
      const parsedObservations = metricContract
        ? metricAudioObservationSchema.array().max(8).safeParse(rawObservations)
        : legacyStoredAudioObservationSchema
            .array()
            .max(8)
            .safeParse(rawObservations);
      if (!parsedObservations.success) {
        throw new ListeningFailure(
          "listening_failed",
          parsedObservations.error.message,
          {
            checkId: "application.observation.schema",
            phase: "capture",
            facts: [
              fact(
                "schemaIssueCount",
                parsedObservations.error.issues.length,
                0,
              ),
              fact(
                "observationCount",
                Array.isArray(rawObservations)
                  ? rawObservations.length
                  : undefined,
                request.listenerIds.length,
              ),
            ],
          },
        );
      }
      const observations = parsedObservations.data;
      const identities = observations.map(storedObservationIdentity);
      const coordinates = observations.map(storedObservationCoordinates);
      const publishable = observations.map((item) =>
        item.schema === "metric-audio-observation/v1"
          ? item.ownership.traceId === job.snapshot.trace.traceId &&
            item.ownership.correlationId === job.snapshot.trace.correlationId &&
            item.ownership.causationId === job.snapshot.trace.causationId &&
            item.source.view === request.mode
          : item.complete,
      );
      if (
        observations.length !== request.listenerIds.length ||
        new Set(identities.map((item) => item.listenerId)).size !==
          observations.length ||
        identities.some(
          (item) =>
            item.passId !== job.snapshot.passId ||
            !request.listenerIds.includes(item.listenerId),
        ) ||
        publishable.some((valid) => !valid) ||
        coordinates.some(
          (item) =>
            item.endSample <= item.startSample ||
            item.endBeat <= item.startBeat,
        )
      ) {
        throw new ListeningFailure(
          "incomplete_capture",
          metricContract
            ? "Every selected listener must return one publishable owned metric observation for this pass"
            : "Every selected listener must return one complete observation for this pass",
          {
            checkId: "application.observation.coverage",
            phase: "capture",
            facts: [
              fact(
                "observationCount",
                observations.length,
                request.listenerIds.length,
              ),
              fact(
                "distinctListenerCount",
                new Set(identities.map((item) => item.listenerId)).size,
                observations.length,
              ),
              ...identities.flatMap((item, index) => [
                fact(
                  `observation.${index}.passMatches`,
                  item.passId === job.snapshot.passId,
                  true,
                ),
                fact(
                  `observation.${index}.listenerSelected`,
                  request.listenerIds.includes(item.listenerId),
                  true,
                ),
                fact(
                  `observation.${index}.${metricContract ? "publishable" : "complete"}`,
                  publishable[index],
                  true,
                ),
                fact(
                  `observation.${index}.startSample`,
                  coordinates[index]?.startSample,
                ),
                fact(
                  `observation.${index}.endSample`,
                  coordinates[index]?.endSample,
                ),
                fact(
                  `observation.${index}.startBeat`,
                  coordinates[index]?.startBeat,
                ),
                fact(
                  `observation.${index}.endBeat`,
                  coordinates[index]?.endBeat,
                ),
              ]),
            ],
          },
        );
      }
      const candidateMetricResults = metricContract
        ? observations.map((observation) => {
            if (observation.schema !== "metric-audio-observation/v1")
              throw new ListeningFailure(
                "incomplete_capture",
                "Independent metric capture returned a legacy observation",
              );
            const summary = summarizeMetricListeningResult(observation);
            return {
              ...summary,
              listenerId: sanitizePersistedText(summary.listenerId).slice(
                0,
                128,
              ),
            };
          })
        : undefined;
      if (playback.cleanupPolicy !== "leave-running" && !playback.isOwned()) {
        finalStage = "interrupted";
        throw new ListeningFailure(
          "interrupted",
          "Playback was taken over; capture cannot be published as current",
          {
            checkId: "application.playback.ownership",
            phase: "post-binding",
            facts: [fact("playbackOwned", false, true)],
          },
        );
      }
      boundary = {
        checkId: "application.observation.validate",
        phase: "post-binding",
        facts: [fact("observationCount", observations.length)],
      };
      this.options.services.validateObservations(
        observations,
        request,
        job.snapshot.passId,
      );
      boundary = {
        checkId: "application.cleanup.playback",
        phase: "cleanup",
        facts: [fact("cleanupPolicy", playback.cleanupPolicy ?? "stop-owned")],
      };
      const acquiredPlayback = playback;
      await this.#cleanup(job, boundary, () =>
        acquiredPlayback.cleanupPolicy === "leave-running"
          ? acquiredPlayback.release()
          : acquiredPlayback.stop(),
      );
      playback = undefined;
      boundary = {
        checkId: "application.cleanup.disarm",
        phase: "cleanup",
        facts: [],
      };
      const acquiredCapture = capture;
      await this.#cleanup(job, boundary, () => acquiredCapture.disarm());
      capture = undefined;
      checkAbort(signal);
      this.#transition(job, "persisting");
      boundary = {
        checkId: "application.publication.persist",
        phase: "publication",
        facts: [fact("observationCount", observations.length)],
      };
      let publishedIds: readonly string[];
      try {
        publishedIds = await bounded(
          this.options.services.persist({
            passId: job.snapshot.passId,
            owner: job.snapshot.owner,
            trace: job.snapshot.trace,
            request,
            observations,
            signal,
          }),
          signal,
        );
      } catch (error) {
        if (signal.aborted) {
          throw new ListeningFailure(
            "publication_indeterminate",
            `Context publication may have committed for pass ${job.snapshot.passId}; query its context before retrying`,
            {
              checkId: "application.publication.commit-state",
              phase: "publication",
              facts: [
                fact("aborted", signal.aborted, false),
                {
                  field: "committed",
                  actual: { state: "unavailable", reason: "unknown" },
                  expected: { state: "observed", value: true },
                },
              ],
            },
          );
        }
        throw error;
      }
      if (
        publishedIds.length !== request.listenerIds.length ||
        new Set(publishedIds).size !== publishedIds.length ||
        publishedIds.some((id) => id.length === 0 || id.length > 256)
      ) {
        throw new ListeningFailure(
          "persistence_failed",
          "Context publication did not return every listener observation",
          {
            checkId: "application.publication.receipts",
            phase: "publication",
            facts: [
              fact(
                "receiptCount",
                publishedIds.length,
                request.listenerIds.length,
              ),
              fact(
                "distinctReceiptCount",
                new Set(publishedIds).size,
                publishedIds.length,
              ),
              fact(
                "invalidReceiptCount",
                publishedIds.filter((id) => id.length === 0 || id.length > 256)
                  .length,
                0,
              ),
            ],
          },
        );
      }
      contextIds = publishedIds;
      metricResults = candidateMetricResults;
      if (metricResults !== undefined) {
        finalStage = metricResults.some(
          (result) => result.outcome === "partial",
        )
          ? "partial"
          : "completed";
      }
    } catch (error) {
      failure = error;
      firstEvidence = evidenceFor(error, job.snapshot, {
        ...boundary,
        facts: [
          ...boundary.facts,
          fact("stage", job.snapshot.stage),
          fact(
            "elapsedMs",
            job.elapsed?.() ?? Math.max(0, this.#now() - job.startedAt),
          ),
          fact("maximumDurationMs", request.maximumDurationMs),
        ],
      });
      if (finalStage !== "interrupted") {
        finalStage =
          !(
            error instanceof ListeningFailure &&
            error.code === "publication_indeterminate"
          ) &&
          signal.aborted &&
          signal.reason instanceof ListeningFailure &&
          signal.reason.code === "cancelled"
            ? "cancelled"
            : "failed";
      }
    } finally {
      clearTimeout(timer);
      const cleanupFailures: string[] = [];
      if (capture !== undefined) {
        const acquiredCapture = capture;
        try {
          await this.#cleanup(
            job,
            {
              checkId: "application.cleanup.disarm",
              phase: "cleanup",
              facts: [],
            },
            () => acquiredCapture.disarm(),
          );
        } catch (error) {
          firstEvidence ??= evidenceFor(error, job.snapshot, {
            checkId: "application.cleanup.disarm",
            phase: "cleanup",
            facts: [],
          });
          cleanupFailures.push(
            `Listener disarm failed: ${failureMessage(error)}`,
          );
        }
      }
      if (playback !== undefined) {
        const acquiredPlayback = playback;
        try {
          await this.#cleanup(
            job,
            {
              checkId: "application.cleanup.playback",
              phase: "cleanup",
              facts: [
                fact("cleanupPolicy", playback.cleanupPolicy ?? "stop-owned"),
              ],
            },
            async () => {
              if (acquiredPlayback.cleanupPolicy === "leave-running")
                await acquiredPlayback.release();
              else if (acquiredPlayback.isOwned())
                await acquiredPlayback.stop();
            },
          );
        } catch (error) {
          firstEvidence ??= evidenceFor(error, job.snapshot, {
            checkId: "application.cleanup.playback",
            phase: "cleanup",
            facts: [],
          });
          cleanupFailures.push(
            `${playback.cleanupPolicy === "leave-running" ? "Playback monitor" : "Owned playback"} cleanup failed: ${failureMessage(error)}`,
          );
        }
      }
      if (reservation !== undefined) {
        const acquiredReservation = reservation;
        try {
          await this.#cleanup(
            job,
            {
              checkId: "application.cleanup.quota-release",
              phase: "cleanup",
              facts: [],
            },
            () => acquiredReservation.release(),
          );
        } catch (error) {
          firstEvidence ??= evidenceFor(error, job.snapshot, {
            checkId: "application.cleanup.quota-release",
            phase: "cleanup",
            facts: [],
          });
          cleanupFailures.push(
            `Context quota release failed: ${failureMessage(error)}`,
          );
        }
      }
      if (cleanupFailures.length > 0) {
        finalStage = "failed";
        failure = new ListeningFailure(
          "cleanup_failed",
          [
            failure === undefined ? "" : failureMessage(failure),
            ...cleanupFailures,
          ]
            .filter(Boolean)
            .join("; "),
        );
      }
      this.#active = undefined;
      this.#transition(
        job,
        finalStage,
        contextIds,
        failure === undefined ? undefined : failureMessage(failure),
        firstEvidence,
        metricResults,
      );
    }
    return structuredClone(job.snapshot);
  }

  #transition(
    job: RunningJob,
    stage: ListeningStage,
    contextIds: readonly string[] = [],
    error?: string,
    failureEvidence?: ListeningFailureEvidence,
    metricResults?: readonly MetricListeningResultSummary[],
  ): void {
    const now = this.#now();
    const attributes = sanitizeTelemetryAttributes({
      passId: job.snapshot.passId,
      stage,
      contextIds,
      ...(metricResults === undefined ? {} : { metricResults }),
      ...(job.readinessBoundary === undefined
        ? {}
        : { readinessBoundary: job.readinessBoundary }),
      ...(job.snapshot.cleanupPolicy === undefined
        ? {}
        : { cleanupPolicy: job.snapshot.cleanupPolicy }),
      ...(job.snapshot.session === undefined
        ? {}
        : { session: job.snapshot.session }),
      ...(error === undefined ? {} : { error }),
      ...(failureEvidence === undefined ? {} : { failureEvidence }),
    });
    const sanitizedError =
      typeof attributes.error === "string"
        ? attributes.error.slice(0, 2048)
        : undefined;
    job.snapshot = {
      ...job.snapshot,
      stage,
      updatedAt: new Date(now).toISOString(),
      durationMs: job.elapsed?.() ?? Math.max(0, now - job.startedAt),
      contextIds: contextIds.map(sanitizePersistedText),
      ...(metricResults === undefined
        ? {}
        : { metricResults: structuredClone(metricResults) }),
      ...(sanitizedError === undefined ? {} : { error: sanitizedError }),
      ...(failureEvidence === undefined
        ? {}
        : { failureEvidence: structuredClone(failureEvidence) }),
    };
    this.options.telemetry?.enqueue({
      version: 2,
      id: randomUUID(),
      occurredAt: job.snapshot.updatedAt,
      name: `listening.${stage === "validating" ? "started" : terminal(stage) || stage === "queued" ? stage : "progress"}`,
      source: "listening-coordinator",
      category: "listening",
      stage,
      outcome:
        stage === "completed" || stage === "partial"
          ? "success"
          : stage === "failed" || stage === "interrupted"
            ? "failure"
            : stage === "cancelled"
              ? "cancelled"
              : "unknown",
      level: stage === "failed" ? "error" : "info",
      durationMs: job.snapshot.durationMs,
      sessionId: sanitizePersistedText(job.snapshot.owner.sessionId),
      liveSetId: sanitizePersistedText(job.snapshot.owner.liveSetId),
      activeAgentId: sanitizePersistedText(job.snapshot.owner.agentId),
      correlationId: sanitizePersistedText(job.snapshot.trace.correlationId),
      causationId: sanitizePersistedText(job.snapshot.trace.causationId),
      trace: { traceId: job.snapshot.trace.traceId, spanId: randomUUID() },
      attributes,
    });
    this.options.onChange?.(structuredClone(job.snapshot));
  }

  async #cleanup(
    job: RunningJob,
    check: ListeningCheck,
    operation: () => Promise<void>,
  ): Promise<void> {
    const started = performance.now();
    const record = (
      outcome: "started" | "completed" | "failed",
      error?: unknown,
    ) => {
      this.options.telemetry?.enqueue({
        version: 2,
        id: randomUUID(),
        occurredAt: new Date(this.#now()).toISOString(),
        name: `listening.cleanup.${outcome}`,
        source: "listening-coordinator",
        level: outcome === "failed" ? "error" : "info",
        durationMs: Math.max(0, performance.now() - started),
        sessionId: sanitizePersistedText(job.snapshot.owner.sessionId),
        liveSetId: sanitizePersistedText(job.snapshot.owner.liveSetId),
        activeAgentId: sanitizePersistedText(job.snapshot.owner.agentId),
        correlationId: sanitizePersistedText(job.snapshot.trace.correlationId),
        causationId: sanitizePersistedText(job.snapshot.trace.causationId),
        trace: { traceId: job.snapshot.trace.traceId, spanId: randomUUID() },
        attributes: sanitizeTelemetryAttributes({
          passId: job.snapshot.passId,
          checkId: check.checkId,
          ...(outcome === "failed"
            ? {
                failureEvidence: evidenceFor(error, job.snapshot, {
                  ...check,
                  facts: [
                    ...check.facts,
                    fact("cleanupTimeoutMs", listeningLimits.cleanupTimeoutMs),
                  ],
                }),
              }
            : {}),
        }),
      });
    };
    record("started");
    try {
      await boundedCleanup(operation());
      record("completed");
    } catch (error) {
      record("failed", error);
      throw error;
    }
  }
}
