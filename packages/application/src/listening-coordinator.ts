import { randomUUID } from "node:crypto";

import {
  sanitizeTelemetryAttributes,
  type NonBlockingObservabilityRecorder,
} from "@ableton-agent/observability";
import {
  storedAudioObservationSchema,
  type StoredAudioObservation,
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
      readonly durationBeats: number;
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
  readonly error?: string;
  readonly cleanupPolicy?: "stop-owned" | "leave-running";
}

interface RunningJob {
  readonly controller: AbortController;
  readonly startedAt: number;
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

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ListeningFailure";
  }
}

function terminal(stage: ListeningStage): boolean {
  return ["completed", "failed", "cancelled", "interrupted"].includes(stage);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new ListeningFailure("cancelled", "Listening was cancelled");
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

function failureMessage(value: unknown): string {
  return value instanceof Error
    ? value.message
    : typeof value === "string"
      ? value
      : "Listening operation failed with a non-Error rejection";
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
      new ListeningFailure("cleanup_timeout", "Listening cleanup timed out"),
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
    );
  }
  if (
    request.mode === "session" &&
    (!Number.isFinite(request.durationBeats) ||
      request.durationBeats <= 0 ||
      request.durationBeats > 256 ||
      !request.clipReference ||
      !request.trackReference)
  ) {
    throw new ListeningFailure(
      "invalid_params",
      "Session listening requires an exact clip and a bounded beat duration",
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
      );
    }
    if (this.#closed) {
      throw new ListeningFailure("unavailable", "Listening is shut down");
    }
    if (this.#active !== undefined) {
      throw new ListeningFailure(
        "conflict",
        "Another listening pass is active",
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
        );
      }
      this.#jobs.delete(oldest[0]);
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
    };
    const job: RunningJob = {
      controller: new AbortController(),
      startedAt: now,
      snapshot,
      completion: Promise.resolve(snapshot),
    };
    this.#jobs.set(passId, job);
    this.#active = passId;
    const cancel = () =>
      job.controller.abort(
        signal?.reason instanceof ListeningFailure
          ? signal.reason
          : new ListeningFailure("cancelled", "Listening caller was cancelled"),
      );
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    job.completion = Promise.resolve()
      .then(() => this.#run(job, structuredClone(request)))
      .finally(() => signal?.removeEventListener("abort", cancel));
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
          new ListeningFailure("cancelled", "Listening host is shutting down"),
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
    let finalStage: ListeningStage = "completed";
    let contextIds: readonly string[] = [];
    const readinessTimer = () => {
      const deadline = setTimeout(() => {
        job.controller.abort(
          new ListeningFailure(
            "timeout",
            `Listener readiness timed out during ${job.readinessBoundary}`,
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
      clearTimeout(timer);
      timer = setTimeout(() => {
        job.controller.abort(
          new ListeningFailure(
            "timeout",
            "Listening capture exceeded its budget",
          ),
        );
      }, request.maximumDurationMs);
      timer.unref?.();
      playback = await bounded(
        this.options.services.startPlayback({
          request,
          passId: job.snapshot.passId,
          owner: job.snapshot.owner,
          trace: job.snapshot.trace,
          signal,
        }),
        signal,
      );
      job.snapshot = {
        ...job.snapshot,
        cleanupPolicy: playback.cleanupPolicy ?? "stop-owned",
      };
      checkAbort(signal);
      this.#transition(job, "capturing");
      const observations = storedAudioObservationSchema
        .array()
        .max(8)
        .parse(await bounded(capture.observations, signal));
      if (
        observations.length !== request.listenerIds.length ||
        new Set(observations.map((item) => item.listenerId)).size !==
          observations.length ||
        observations.some(
          (item) =>
            item.passId !== job.snapshot.passId ||
            !request.listenerIds.includes(item.listenerId) ||
            !item.complete ||
            item.endSample <= item.startSample ||
            item.endBeat <= item.startBeat,
        )
      ) {
        throw new ListeningFailure(
          "incomplete_capture",
          "Every selected listener must return one complete observation for this pass",
        );
      }
      if (playback.cleanupPolicy !== "leave-running" && !playback.isOwned()) {
        finalStage = "interrupted";
        throw new ListeningFailure(
          "interrupted",
          "Playback was taken over; capture cannot be published as current",
        );
      }
      this.options.services.validateObservations(
        observations,
        request,
        job.snapshot.passId,
      );
      await boundedCleanup(
        playback.cleanupPolicy === "leave-running"
          ? playback.release()
          : playback.stop(),
      );
      playback = undefined;
      await boundedCleanup(capture.disarm());
      capture = undefined;
      checkAbort(signal);
      this.#transition(job, "persisting");
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
        );
      }
      contextIds = publishedIds;
    } catch (error) {
      failure = error;
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
        try {
          await boundedCleanup(capture.disarm());
        } catch (error) {
          cleanupFailures.push(
            `Listener disarm failed: ${failureMessage(error)}`,
          );
        }
      }
      if (playback !== undefined) {
        try {
          if (playback.cleanupPolicy === "leave-running") {
            await boundedCleanup(playback.release());
          } else if (playback.isOwned()) {
            await boundedCleanup(playback.stop());
          }
        } catch (error) {
          cleanupFailures.push(
            `${playback.cleanupPolicy === "leave-running" ? "Playback monitor" : "Owned playback"} cleanup failed: ${failureMessage(error)}`,
          );
        }
      }
      if (reservation !== undefined) {
        try {
          await boundedCleanup(reservation.release());
        } catch (error) {
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
      );
    }
    return structuredClone(job.snapshot);
  }

  #transition(
    job: RunningJob,
    stage: ListeningStage,
    contextIds: readonly string[] = [],
    error?: string,
  ): void {
    const now = this.#now();
    const attributes = sanitizeTelemetryAttributes({
      passId: job.snapshot.passId,
      stage,
      contextIds,
      ...(job.readinessBoundary === undefined
        ? {}
        : { readinessBoundary: job.readinessBoundary }),
      ...(job.snapshot.cleanupPolicy === undefined
        ? {}
        : { cleanupPolicy: job.snapshot.cleanupPolicy }),
      ...(error === undefined ? {} : { error }),
    });
    const sanitizedError =
      typeof attributes.error === "string"
        ? attributes.error.slice(0, 2048)
        : undefined;
    job.snapshot = {
      ...job.snapshot,
      stage,
      updatedAt: new Date(now).toISOString(),
      durationMs: Math.max(0, now - job.startedAt),
      contextIds: [...contextIds],
      ...(sanitizedError === undefined ? {} : { error: sanitizedError }),
    };
    this.options.telemetry?.enqueue({
      version: 2,
      id: randomUUID(),
      occurredAt: job.snapshot.updatedAt,
      name: `listening.${stage === "validating" ? "started" : terminal(stage) || stage === "queued" ? stage : "progress"}`,
      source: "listening-coordinator",
      level: stage === "failed" ? "error" : "info",
      durationMs: job.snapshot.durationMs,
      sessionId: job.snapshot.owner.sessionId,
      liveSetId: job.snapshot.owner.liveSetId,
      activeAgentId: job.snapshot.owner.agentId,
      correlationId: job.snapshot.trace.correlationId,
      causationId: job.snapshot.trace.causationId,
      trace: { traceId: job.snapshot.trace.traceId, spanId: randomUUID() },
      attributes,
    });
    this.options.onChange?.(structuredClone(job.snapshot));
  }
}
