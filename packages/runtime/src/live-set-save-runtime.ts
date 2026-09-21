import type { AbletonLiveSetSaveEvent } from "@ableton-agent/bridge";
import type {
  NonBlockingObservabilityRecorder,
  SanitizedAttributes,
} from "@ableton-agent/observability";
import { type LiveSetSaveObservedPayload } from "@ableton-agent/protocol";
import {
  recordSignalTelemetry,
  stableTelemetryId,
} from "@ableton-agent/signal-routing";
import { noopLogger, type Logger } from "@ableton-agent/shared";

export interface LiveSetSaveBridge {
  subscribeLiveSetSaves(
    listener: (event: AbletonLiveSetSaveEvent) => void,
  ): () => void;
}

export interface LiveSetSaveActionContext {
  readonly observation: LiveSetSaveObservedPayload;
  readonly receivedAt: string;
  readonly projectRevision?: number;
  readonly signal: AbortSignal;
  reportProgress(attributes?: SanitizedAttributes): void;
}

export interface LiveSetSaveAction {
  readonly id: string;
  readonly lifecycleName?: string;
  execute(context: LiveSetSaveActionContext): Promise<void>;
}

export type LiveSetSaveRuntimeEvent = {
  readonly type:
    | "live_set.save_observation.queued"
    | "live_set.save_observation.started"
    | "live_set.save_observation.progress"
    | "live_set.save_observation.completed"
    | "live_set.save_observation.failed"
    | "live_set.save_observation.cancelled"
    | "live_set.save_action.queued"
    | "live_set.save_action.started"
    | "live_set.save_action.progress"
    | "live_set.save_action.completed"
    | "live_set.save_action.failed"
    | "live_set.save_action.cancelled";
  readonly liveSetId: string;
  readonly actionId?: string;
  readonly lifecycleName?: string;
  readonly occurredAt: string;
  readonly durationMs?: number;
  readonly attributes?: SanitizedAttributes;
};

export interface LiveSetSaveRuntimeOptions {
  readonly bridge: LiveSetSaveBridge;
  readonly actions?: readonly LiveSetSaveAction[];
  readonly telemetry?: Pick<NonBlockingObservabilityRecorder, "enqueue">;
  readonly logger?: Logger;
  readonly now?: () => Date;
}

interface LiveSetQueue {
  tail: Promise<void>;
  controller: AbortController;
}

export interface LiveSetSaveRuntime {
  start(): void;
  stop(): Promise<void>;
  subscribe(listener: (event: LiveSetSaveRuntimeEvent) => void): () => void;
}

export class DefaultLiveSetSaveRuntime implements LiveSetSaveRuntime {
  readonly #bridge: LiveSetSaveBridge;
  readonly #actions: readonly LiveSetSaveAction[];
  readonly #telemetry:
    Pick<NonBlockingObservabilityRecorder, "enqueue"> | undefined;
  readonly #logger: Logger;
  readonly #now: () => Date;
  readonly #queues = new Map<string, LiveSetQueue>();
  readonly #pending = new Set<Promise<void>>();
  readonly #lastObservation = new Map<string, string>();
  readonly #listeners = new Set<(event: LiveSetSaveRuntimeEvent) => void>();
  #unsubscribe: (() => void) | undefined;
  #started = false;

  public constructor(options: LiveSetSaveRuntimeOptions) {
    this.#bridge = options.bridge;
    this.#actions = [...(options.actions ?? [])];
    this.#telemetry = options.telemetry;
    this.#logger = options.logger ?? noopLogger;
    this.#now = options.now ?? (() => new Date());
  }

  public start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#unsubscribe = this.#bridge.subscribeLiveSetSaves((event) =>
      this.#enqueue(event),
    );
  }

  public async stop(): Promise<void> {
    if (!this.#started) return;
    this.#started = false;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    for (const { controller } of this.#queues.values()) controller.abort();
    await Promise.allSettled([...this.#pending]);
    this.#queues.clear();
    this.#lastObservation.clear();
  }

  public subscribe(
    listener: (event: LiveSetSaveRuntimeEvent) => void,
  ): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #enqueue(event: AbletonLiveSetSaveEvent): void {
    if (!this.#started) return;
    const observationKey = `${event.payload.fileModifiedTimeNs}:${event.payload.fileSizeBytes}`;
    if (this.#lastObservation.get(event.payload.liveSetId) === observationKey) {
      return;
    }
    this.#lastObservation.set(event.payload.liveSetId, observationKey);
    for (const [liveSetId, queue] of this.#queues) {
      if (liveSetId !== event.payload.liveSetId) {
        queue.controller.abort();
        this.#queues.delete(liveSetId);
      }
    }
    const queue = this.#queues.get(event.payload.liveSetId) ?? {
      tail: Promise.resolve(),
      controller: new AbortController(),
    };
    this.#queues.set(event.payload.liveSetId, queue);
    this.#emit("live_set.save_observation.queued", event);
    const tail = queue.tail
      .catch(() => undefined)
      .then(() => this.#dispatch(event, queue.controller.signal));
    queue.tail = tail;
    this.#pending.add(tail);
    void tail.finally(() => this.#pending.delete(tail));
  }

  async #dispatch(
    event: AbletonLiveSetSaveEvent,
    signal: AbortSignal,
  ): Promise<void> {
    const startedAt = this.#now().getTime();
    this.#emit("live_set.save_observation.started", event);
    try {
      for (const action of this.#actions) {
        if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
        this.#emit("live_set.save_action.queued", event, action);
        const actionStartedAt = this.#now().getTime();
        this.#emit("live_set.save_action.started", event, action);
        try {
          await action.execute({
            observation: event.payload,
            receivedAt: event.receivedAt,
            ...(event.projectRevision === undefined
              ? {}
              : { projectRevision: event.projectRevision }),
            signal,
            reportProgress: (attributes) =>
              this.#emit(
                "live_set.save_action.progress",
                event,
                action,
                undefined,
                attributes,
              ),
          });
          if (signal.aborted) {
            throw new DOMException("Cancelled", "AbortError");
          }
          this.#emit(
            "live_set.save_action.completed",
            event,
            action,
            this.#now().getTime() - actionStartedAt,
          );
        } catch (error) {
          const cancelled = signal.aborted || isAbortError(error);
          this.#emit(
            cancelled
              ? "live_set.save_action.cancelled"
              : "live_set.save_action.failed",
            event,
            action,
            this.#now().getTime() - actionStartedAt,
            cancelled ? undefined : { error: errorMessage(error) },
          );
          throw error;
        }
      }
      this.#emit(
        "live_set.save_observation.progress",
        event,
        undefined,
        undefined,
        {
          completedActions: this.#actions.length,
        },
      );
      this.#emit(
        "live_set.save_observation.completed",
        event,
        undefined,
        this.#now().getTime() - startedAt,
      );
    } catch (error) {
      const cancelled = signal.aborted || isAbortError(error);
      this.#emit(
        cancelled
          ? "live_set.save_observation.cancelled"
          : "live_set.save_observation.failed",
        event,
        undefined,
        this.#now().getTime() - startedAt,
        cancelled ? undefined : { error: errorMessage(error) },
      );
      if (!cancelled) {
        this.#logger.warn("Live Set save action dispatch failed", {
          liveSetId: event.payload.liveSetId,
          error: errorMessage(error),
        });
      }
    }
  }

  #emit(
    type: LiveSetSaveRuntimeEvent["type"],
    event: AbletonLiveSetSaveEvent,
    action?: LiveSetSaveAction,
    durationMs?: number,
    attributes?: SanitizedAttributes,
  ): void {
    const occurredAt = this.#now().toISOString();
    const runtimeEvent: LiveSetSaveRuntimeEvent = {
      type,
      liveSetId: event.payload.liveSetId,
      ...(action === undefined ? {} : { actionId: action.id }),
      ...(action?.lifecycleName === undefined
        ? {}
        : { lifecycleName: action.lifecycleName }),
      occurredAt,
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(attributes === undefined ? {} : { attributes }),
    };
    for (const listener of this.#listeners) listener(runtimeEvent);
    const traceId = stableTelemetryId(
      `live-set-save:${event.payload.liveSetId}:${event.payload.fileModifiedTimeNs}:${event.payload.fileSizeBytes}`,
    );
    const spanId =
      action === undefined
        ? traceId
        : stableTelemetryId(`${traceId}:action:${action.id}`);
    const outcome = type.endsWith(".failed")
      ? "failure"
      : type.endsWith(".cancelled")
        ? "cancelled"
        : type.endsWith(".completed")
          ? "success"
          : undefined;
    recordSignalTelemetry(this.#telemetry, {
      name: action?.lifecycleName
        ? type.replace("live_set.save_action", action.lifecycleName)
        : type,
      source: "live-set-save-runtime",
      liveSetId: event.payload.liveSetId,
      correlationId: traceId,
      ...(action === undefined ? {} : { causationId: traceId }),
      trace: {
        traceId,
        spanId,
        ...(action === undefined ? {} : { parentSpanId: traceId }),
      },
      occurredAt,
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(outcome === undefined ? {} : { outcome }),
      level: type.endsWith(".failed")
        ? "error"
        : type.endsWith(".progress")
          ? "debug"
          : "info",
      attributes: {
        observedAt: event.payload.observedAt,
        receivedAt: event.receivedAt,
        fileModifiedTimeNs: event.payload.fileModifiedTimeNs,
        fileSizeBytes: event.payload.fileSizeBytes,
        sequence: event.sequence,
        ...(event.projectRevision === undefined
          ? {}
          : { projectRevision: event.projectRevision }),
        ...(action === undefined ? {} : { actionId: action.id }),
        ...(attributes ?? {}),
      },
    });
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 512);
}
