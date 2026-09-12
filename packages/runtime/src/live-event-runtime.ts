import type {
  LiveEventContextProvider,
  LiveEventDeliveryService,
  PendingLiveEventContext,
  PreparedContextProvider,
} from "@ableton-agent/application";
import {
  MAX_LIVE_EVENT_HISTORY_LENGTH,
  liveEventOccurrenceSchema,
  type AgentEventListener,
  type LiveEventDefinition,
  type LiveEventInitialState,
  type LiveEventOccurrence,
  type LiveEventResolution,
} from "@ableton-agent/agent-config";
import type {
  AbletonLiveEvent,
  LiveEventReconciliationSignal,
  LiveEventSubscriptionStatus,
} from "@ableton-agent/bridge";
import type {
  InspectDeviceParametersParams,
  InspectDeviceParametersResult,
  InspectDevicesParams,
  InspectDevicesResult,
  InspectEventSelectionResult,
  SessionSnapshot,
  SubscribeEventParams,
  SubscribeEventResult,
} from "@ableton-agent/protocol";
import type {
  NonBlockingObservabilityRecorder,
  SanitizedAttributes,
} from "@ableton-agent/observability";
import {
  recordSignalTelemetry,
  stableTelemetryId,
} from "@ableton-agent/signal-routing";
import { noopLogger, type Logger } from "@ableton-agent/shared";
import type { PreparedContextCacheStatus } from "./prepared-context.js";

export interface LiveEventBridge {
  inspectSession(): Promise<SessionSnapshot>;
  inspectEventSelection(): Promise<InspectEventSelectionResult>;
  inspectDevices(params: InspectDevicesParams): Promise<InspectDevicesResult>;
  inspectDeviceParameters(
    params: InspectDeviceParametersParams,
  ): Promise<InspectDeviceParametersResult>;
  subscribeLiveEvent(
    params: SubscribeEventParams,
  ): Promise<SubscribeEventResult>;
  unsubscribeLiveEvent(eventId: string): Promise<unknown>;
  reconcileLiveEventSubscriptions(): Promise<
    readonly LiveEventSubscriptionStatus[]
  >;
  subscribeLiveEvents(listener: (event: AbletonLiveEvent) => void): () => void;
  subscribeLiveEventReconciliation(
    listener: (signal: LiveEventReconciliationSignal) => void,
  ): () => void;
}

export interface AgentLiveEventListener {
  readonly agentInstanceId: string;
  readonly listener: AgentEventListener;
}

export interface LiveEventRuntimeState {
  readonly definition: LiveEventDefinition;
  readonly resolution: LiveEventResolution;
  readonly latestState?: LiveEventInitialState;
  readonly history: readonly LiveEventOccurrence[];
}

export type LiveEventRuntimeEvent =
  | { readonly type: "state.changed"; readonly state: LiveEventRuntimeState }
  | {
      readonly type: "diagnostic";
      readonly level: "warning" | "error";
      readonly message: string;
    };

export interface LiveEventRuntimeOptions {
  readonly bridge: LiveEventBridge;
  readonly logger?: Logger;
  readonly historyLimit?: number;
  readonly nextPromptDiscreteLimit?: number;
  readonly automaticDiscreteLimit?: number;
  readonly continuousSettleMs?: number;
  readonly telemetry?: Pick<NonBlockingObservabilityRecorder, "enqueue">;
  readonly now?: () => Date;
  readonly preparedContextProvider?: PreparedContextProvider;
  readonly subscriptionRetryDelaysMs?: readonly number[];
}

export interface LiveEventRuntime extends LiveEventContextProvider {
  readonly provider: LiveEventContextProvider;
  start(): Promise<void>;
  stop(): Promise<void>;
  setDeliveryService(service: LiveEventDeliveryService): void;
  setActiveAgentInstances(agentInstanceIds: readonly string[]): void;
  setConfiguration(
    definitions: readonly LiveEventDefinition[],
    listeners: readonly AgentLiveEventListener[],
  ): void;
  inspectSelection(): Promise<InspectEventSelectionResult>;
  listStates(): readonly LiveEventRuntimeState[];
  getState(eventId: string): LiveEventRuntimeState | undefined;
  getPreparedContextStatus?(
    agentInstanceId?: string,
    listener?: AgentEventListener,
  ): PreparedContextCacheStatus;
  subscribe(listener: (event: LiveEventRuntimeEvent) => void): () => void;
}

interface MutableState {
  definition: LiveEventDefinition;
  resolution: LiveEventResolution;
  latestState?: LiveEventInitialState;
  history: LiveEventOccurrence[];
}

interface AutomaticAgentQueue {
  readonly discrete: PendingLiveEventContext[];
  readonly continuous: Map<string, PendingLiveEventContext>;
  draining: boolean;
}

function unresolved(detail?: string): LiveEventResolution {
  return {
    status: "unresolved",
    reason: "not-connected",
    ...(detail === undefined ? {} : { detail: detail.slice(0, 512) }),
  };
}

function isRetryableBridgeError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "retryable" in error &&
    error.retryable === true
  );
}

function occurrenceState(
  occurrence: LiveEventOccurrence,
): LiveEventInitialState {
  return {
    kind: occurrence.kind,
    state: occurrence.current,
  } as LiveEventInitialState;
}

function statusState(
  status: LiveEventSubscriptionStatus,
): LiveEventInitialState | undefined {
  if (status.status !== "resolved") return undefined;
  return (status.initialState ?? {
    kind: status.subscription.kind,
    state: status.subscription.state,
  }) as LiveEventInitialState;
}

function statusResolution(
  status: LiveEventSubscriptionStatus,
): LiveEventResolution {
  if (status.status === "resolved") return status.subscription.resolution;
  if (status.status === "invalidated") {
    return {
      status: "invalidated",
      reason: status.invalidation.reason,
      ...(status.invalidation.detail === undefined
        ? {}
        : { detail: status.invalidation.detail }),
    };
  }
  return unresolved(status.error.message);
}

function deliveryId(
  listener: AgentEventListener,
  occurrence: LiveEventOccurrence,
): string {
  return `live-event-delivery.${listener.id}.${occurrence.occurrenceId}`;
}

function listenerSignature(
  agentInstanceId: string,
  listener: AgentEventListener,
): string {
  return JSON.stringify([
    agentInstanceId,
    listener.eventId,
    listener.enabled,
    listener.responseMode,
    listener.messagePrefix ?? null,
    listener.preparedContext ?? null,
  ]);
}

export class DefaultLiveEventRuntime
  implements LiveEventRuntime, LiveEventContextProvider
{
  readonly #bridge: LiveEventBridge;
  readonly #logger: Logger;
  readonly #historyLimit: number;
  readonly #nextPromptDiscreteLimit: number;
  readonly #automaticDiscreteLimit: number;
  readonly #continuousSettleMs: number;
  readonly #subscriptionRetryDelaysMs: readonly number[];
  readonly #telemetry:
    Pick<NonBlockingObservabilityRecorder, "enqueue"> | undefined;
  readonly #now: () => Date;
  readonly #preparedContextProvider: PreparedContextProvider | undefined;
  readonly #states = new Map<string, MutableState>();
  readonly #listenersByEvent = new Map<string, AgentLiveEventListener[]>();
  readonly #activeAgentInstanceIds = new Set<string>();
  readonly #nextPrompt = new Map<string, PendingLiveEventContext[]>();
  readonly #automatic = new Map<string, AutomaticAgentQueue>();
  readonly #settleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #subscribers = new Set<(event: LiveEventRuntimeEvent) => void>();
  readonly #subscriptionFingerprints = new Map<string, string>();
  readonly #subscriptionRetryAttempts = new Map<string, number>();
  readonly #subscriptionRetryTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  #deliveryService: LiveEventDeliveryService | undefined;
  #unsubscribeEvents: (() => void) | undefined;
  #unsubscribeReconciliation: (() => void) | undefined;
  #syncTail: Promise<void> = Promise.resolve();
  #started = false;
  #reconciling = false;

  public constructor(options: LiveEventRuntimeOptions) {
    this.#bridge = options.bridge;
    this.#logger = options.logger ?? noopLogger;
    this.#historyLimit = Math.min(
      MAX_LIVE_EVENT_HISTORY_LENGTH,
      Math.max(1, options.historyLimit ?? MAX_LIVE_EVENT_HISTORY_LENGTH),
    );
    this.#nextPromptDiscreteLimit = Math.max(
      1,
      options.nextPromptDiscreteLimit ?? 32,
    );
    this.#automaticDiscreteLimit = Math.max(
      1,
      options.automaticDiscreteLimit ?? 128,
    );
    this.#continuousSettleMs = Math.max(0, options.continuousSettleMs ?? 120);
    this.#subscriptionRetryDelaysMs = (
      options.subscriptionRetryDelaysMs ?? [250, 500, 1_000]
    ).map((delay) => Math.max(0, delay));
    this.#telemetry = options.telemetry;
    this.#now = options.now ?? (() => new Date());
    this.#preparedContextProvider = options.preparedContextProvider;
  }

  public get provider(): LiveEventContextProvider {
    return this;
  }

  public getPreparedContextStatus(
    _agentInstanceId?: string,
    listener?: AgentEventListener,
  ): PreparedContextCacheStatus {
    const provider = this.#preparedContextProvider as
      | (PreparedContextProvider & {
          getStatus(listener?: AgentEventListener): PreparedContextCacheStatus;
        })
      | undefined;
    return provider?.getStatus(listener) ?? { state: "unavailable" };
  }

  public async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    this.#unsubscribeEvents = this.#bridge.subscribeLiveEvents((event) =>
      this.#onBridgeEvent(event),
    );
    this.#unsubscribeReconciliation =
      this.#bridge.subscribeLiveEventReconciliation((signal) =>
        this.#onReconciliation(signal),
      );
    this.#scheduleSync();
    await this.#syncTail;
  }

  public async stop(): Promise<void> {
    this.#started = false;
    this.#unsubscribeEvents?.();
    this.#unsubscribeEvents = undefined;
    this.#unsubscribeReconciliation?.();
    this.#unsubscribeReconciliation = undefined;
    for (const timer of this.#settleTimers.values()) clearTimeout(timer);
    this.#settleTimers.clear();
    for (const timer of this.#subscriptionRetryTimers.values()) {
      clearTimeout(timer);
    }
    this.#subscriptionRetryTimers.clear();
    this.#subscriptionRetryAttempts.clear();
    await this.#syncTail;
    const eventIds = [...this.#subscriptionFingerprints.keys()];
    this.#subscriptionFingerprints.clear();
    await Promise.allSettled(
      eventIds.map((eventId) => this.#bridge.unsubscribeLiveEvent(eventId)),
    );
  }

  public setDeliveryService(service: LiveEventDeliveryService): void {
    this.#deliveryService = service;
    for (const agentInstanceId of this.#automatic.keys()) {
      this.#drainAutomatic(agentInstanceId);
    }
  }

  public setActiveAgentInstances(agentInstanceIds: readonly string[]): void {
    this.#activeAgentInstanceIds.clear();
    for (const agentInstanceId of agentInstanceIds) {
      this.#activeAgentInstanceIds.add(agentInstanceId);
      this.#drainAutomatic(agentInstanceId);
    }
  }

  public setConfiguration(
    definitions: readonly LiveEventDefinition[],
    listeners: readonly AgentLiveEventListener[],
  ): void {
    const nextIds = new Set(definitions.map(({ id }) => id));
    for (const eventId of this.#states.keys()) {
      if (!nextIds.has(eventId)) {
        this.#states.delete(eventId);
        this.#clearSubscriptionRetry(eventId);
      }
    }
    for (const definition of definitions) {
      const existing = this.#states.get(definition.id);
      if (
        existing !== undefined &&
        existing.definition.updatedAt !== definition.updatedAt
      ) {
        this.#clearSubscriptionRetry(definition.id);
      }
      if (!definition.enabled) this.#clearSubscriptionRetry(definition.id);
      this.#states.set(definition.id, {
        definition,
        resolution:
          existing?.resolution ?? definition.resolution ?? unresolved(),
        ...(existing?.latestState === undefined
          ? definition.initialState === undefined
            ? {}
            : { latestState: definition.initialState }
          : { latestState: existing.latestState }),
        history: existing?.history ?? [],
      });
    }
    this.#listenersByEvent.clear();
    for (const binding of listeners) {
      if (!binding.listener.enabled || !nextIds.has(binding.listener.eventId)) {
        continue;
      }
      const current =
        this.#listenersByEvent.get(binding.listener.eventId) ?? [];
      current.push(binding);
      this.#listenersByEvent.set(binding.listener.eventId, current);
    }
    this.#pruneDeliveries(definitions, listeners);
    this.#scheduleSync();
  }

  public inspectSelection(): Promise<InspectEventSelectionResult> {
    return this.#bridge.inspectEventSelection();
  }

  public listStates(): readonly LiveEventRuntimeState[] {
    return [...this.#states.values()].map((state) => ({
      ...state,
      history: [...state.history],
    }));
  }

  public getState(eventId: string): LiveEventRuntimeState | undefined {
    const state = this.#states.get(eventId);
    return state === undefined
      ? undefined
      : { ...state, history: [...state.history] };
  }

  public subscribe(
    listener: (event: LiveEventRuntimeEvent) => void,
  ): () => void {
    this.#subscribers.add(listener);
    return () => this.#subscribers.delete(listener);
  }

  public async getPendingLiveEventContexts(
    agentInstanceId: string,
  ): Promise<readonly PendingLiveEventContext[]> {
    if (!this.#activeAgentInstanceIds.has(agentInstanceId)) {
      this.#recordSkip("inactive-agent", { agentInstanceId });
      return [];
    }
    const pending = [...(this.#nextPrompt.get(agentInstanceId) ?? [])];
    for (const context of pending) {
      this.#recordDelivery("live-event.dispatch.requested", context);
    }
    return pending;
  }

  public async markLiveEventContextsDelivered(
    agentInstanceId: string,
    deliveryIds: readonly string[],
  ): Promise<void> {
    if (!this.#activeAgentInstanceIds.has(agentInstanceId)) {
      this.#recordSkip("ack-inactive-agent", { agentInstanceId });
      return;
    }
    const delivered = new Set(deliveryIds);
    const current = this.#nextPrompt.get(agentInstanceId) ?? [];
    for (const context of current) {
      if (delivered.has(context.deliveryId)) {
        this.#recordDelivery("live-event.delivery.acknowledged", context, {
          outcome: "success",
        });
      }
    }
    this.#nextPrompt.set(
      agentInstanceId,
      current.filter(({ deliveryId: id }) => !delivered.has(id)),
    );
  }

  #scheduleSync(): void {
    if (!this.#started) return;
    recordSignalTelemetry(this.#telemetry, {
      name: "live-event.subscription-sync.queued",
      source: "live-event-runtime",
      attributes: { definitionCount: this.#states.size },
    });
    this.#syncTail = this.#syncTail
      .then(() => this.#syncSubscriptions())
      .catch((error: unknown) => {
        recordSignalTelemetry(this.#telemetry, {
          name: "live-event.subscription-sync.failed",
          source: "live-event-runtime",
          level: "error",
          outcome: "failure",
          attributes: {
            errorType: error instanceof Error ? error.name : typeof error,
          },
        });
        this.#diagnostic("error", "Live event subscription sync failed", error);
      });
  }

  async #syncSubscriptions(): Promise<void> {
    const desired = [...this.#states.values()].filter(
      ({ definition }) => definition.enabled,
    );
    const desiredIds = new Set(desired.map(({ definition }) => definition.id));
    for (const eventId of [...this.#subscriptionFingerprints.keys()]) {
      if (desiredIds.has(eventId)) continue;
      await this.#bridge
        .unsubscribeLiveEvent(eventId)
        .catch((error: unknown) =>
          this.#diagnostic(
            "warning",
            `Failed to unsubscribe ${eventId}`,
            error,
          ),
        );
      this.#subscriptionFingerprints.delete(eventId);
    }
    for (const state of desired) {
      if (this.#subscriptionRetryTimers.has(state.definition.id)) continue;
      const startedAt = this.#now().getTime();
      const traceId = stableTelemetryId(
        `live-event-subscription:${state.definition.id}`,
      );
      try {
        const params = await this.#resolveParams(state.definition);
        const fingerprint = JSON.stringify(params);
        if (
          this.#subscriptionFingerprints.get(state.definition.id) ===
          fingerprint
        ) {
          recordSignalTelemetry(this.#telemetry, {
            name: "live-event.subscription-replay.skipped",
            source: "live-event-runtime",
            correlationId: state.definition.id,
            projectId: state.definition.projectId,
            liveEventId: state.definition.id,
            trace: { traceId, spanId: traceId },
            attributes: {
              eventId: state.definition.id,
              reason: "unchanged-fingerprint",
            },
          });
          continue;
        }
        if (this.#subscriptionFingerprints.has(state.definition.id)) {
          await this.#bridge.unsubscribeLiveEvent(state.definition.id);
        }
        const result = await this.#bridge.subscribeLiveEvent(params);
        if (!this.#started || this.#states.get(state.definition.id) !== state) {
          await this.#bridge
            .unsubscribeLiveEvent(state.definition.id)
            .catch(() => undefined);
          continue;
        }
        this.#subscriptionFingerprints.set(state.definition.id, fingerprint);
        const recovered =
          (this.#subscriptionRetryAttempts.get(state.definition.id) ?? 0) > 0;
        this.#clearSubscriptionRetry(state.definition.id);
        state.resolution = result.resolution;
        state.latestState = result.initialState;
        this.#emitState(state);
        recordSignalTelemetry(this.#telemetry, {
          name: "live-event.subscription.resolved",
          source: "live-event-runtime",
          correlationId: state.definition.id,
          projectId: state.definition.projectId,
          liveEventId: state.definition.id,
          outcome: "success",
          durationMs: this.#now().getTime() - startedAt,
          trace: { traceId, spanId: traceId },
          attributes: {
            eventId: state.definition.id,
            eventKind: state.definition.kind,
            recovered,
          },
        });
      } catch (error) {
        if (!this.#started || this.#states.get(state.definition.id) !== state) {
          continue;
        }
        if (this.#subscriptionFingerprints.has(state.definition.id)) {
          const deactivated = await this.#bridge
            .unsubscribeLiveEvent(state.definition.id)
            .then(() => true)
            .catch((unsubscribeError: unknown) => {
              this.#diagnostic(
                "warning",
                `Failed to deactivate unresolved Live event '${state.definition.name}'`,
                unsubscribeError,
              );
              return false;
            });
          if (deactivated) {
            this.#subscriptionFingerprints.delete(state.definition.id);
          }
        }
        state.resolution = unresolved(
          error instanceof Error ? error.message : String(error),
        );
        this.#emitState(state);
        recordSignalTelemetry(this.#telemetry, {
          name: "live-event.subscription.unresolved",
          source: "live-event-runtime",
          correlationId: state.definition.id,
          projectId: state.definition.projectId,
          liveEventId: state.definition.id,
          level: "warn",
          outcome: "failure",
          durationMs: this.#now().getTime() - startedAt,
          trace: { traceId, spanId: traceId },
          attributes: {
            eventId: state.definition.id,
            eventKind: state.definition.kind,
            errorType: error instanceof Error ? error.name : typeof error,
          },
        });
        this.#diagnostic(
          "warning",
          `Live event '${state.definition.name}' is unresolved`,
          error,
        );
        if (isRetryableBridgeError(error)) {
          this.#scheduleSubscriptionRetry(state);
        } else {
          this.#clearSubscriptionRetry(state.definition.id);
        }
      }
    }
  }

  #scheduleSubscriptionRetry(state: MutableState): void {
    const eventId = state.definition.id;
    if (this.#subscriptionRetryTimers.has(eventId)) return;
    const attempt = this.#subscriptionRetryAttempts.get(eventId) ?? 0;
    const delay = this.#subscriptionRetryDelaysMs[attempt];
    if (delay === undefined) {
      recordSignalTelemetry(this.#telemetry, {
        name: "live-event.subscription.retry-exhausted",
        source: "live-event-runtime",
        correlationId: eventId,
        projectId: state.definition.projectId,
        liveEventId: eventId,
        level: "warn",
        outcome: "failure",
        attributes: { eventId, attempts: attempt },
      });
      return;
    }
    this.#subscriptionRetryAttempts.set(eventId, attempt + 1);
    const revision = state.definition.updatedAt;
    const timer = setTimeout(() => {
      this.#subscriptionRetryTimers.delete(eventId);
      const current = this.#states.get(eventId);
      if (
        !this.#started ||
        current === undefined ||
        !current.definition.enabled ||
        current.definition.updatedAt !== revision
      ) {
        return;
      }
      this.#scheduleSync();
    }, delay);
    this.#subscriptionRetryTimers.set(eventId, timer);
    recordSignalTelemetry(this.#telemetry, {
      name: "live-event.subscription.retry-scheduled",
      source: "live-event-runtime",
      correlationId: eventId,
      projectId: state.definition.projectId,
      liveEventId: eventId,
      level: "warn",
      attributes: { eventId, attempt: attempt + 1, delayMs: delay },
    });
  }

  #clearSubscriptionRetry(eventId: string): void {
    const timer = this.#subscriptionRetryTimers.get(eventId);
    if (timer !== undefined) clearTimeout(timer);
    this.#subscriptionRetryTimers.delete(eventId);
    this.#subscriptionRetryAttempts.delete(eventId);
  }

  async #resolveParams(
    definition: LiveEventDefinition,
  ): Promise<SubscribeEventParams> {
    const snapshot = await this.#bridge.inspectSession();
    const matchingTracks = snapshot.tracks.filter(
      ({ name }) => name === definition.target.track.name,
    );
    const track = matchingTracks[definition.target.track.occurrence];
    if (track === undefined) {
      throw new Error(`Track '${definition.target.track.name}' was not found`);
    }
    const base = {
      eventId: definition.id,
      projectId: definition.projectId,
      index: track.index,
      expectedReference: track.reference,
      expectedName: track.name,
    };
    if (definition.kind !== "parameter.value_changed") {
      return { ...base, kind: definition.kind };
    }
    const devices = await this.#bridge.inspectDevices({
      index: track.index,
      expectedReference: track.reference,
      expectedName: track.name,
      offset: 0,
      limit: 128,
    });
    const device = devices.devices.filter(
      ({ name }) => name === definition.target.device.name,
    )[definition.target.device.occurrence];
    if (device === undefined) {
      throw new Error(
        `Device '${definition.target.device.name}' was not found`,
      );
    }
    const parameters = await this.#bridge.inspectDeviceParameters({
      ...base,
      deviceIndex: device.index,
      expectedDeviceReference: device.reference,
      expectedDeviceName: device.name,
      offset: 0,
      limit: 256,
    });
    const parameter = parameters.parameters.filter(
      ({ name }) => name === definition.target.parameter.name,
    )[definition.target.parameter.occurrence];
    if (parameter === undefined) {
      throw new Error(
        `Parameter '${definition.target.parameter.name}' was not found`,
      );
    }
    return {
      ...base,
      kind: definition.kind,
      deviceIndex: device.index,
      expectedDeviceReference: device.reference,
      expectedDeviceName: device.name,
      parameterIndex: parameter.index,
      expectedParameterReference: parameter.reference,
      expectedParameterName: parameter.name,
      observationPolicy: definition.observationPolicy,
    };
  }

  #onBridgeEvent(event: AbletonLiveEvent): void {
    const traceId =
      event.event === "live_event.occurred"
        ? event.payload.occurrenceId
        : stableTelemetryId(
            `live-event-invalidation:${event.payload.eventId}:${event.sequence}`,
          );
    const state = this.#states.get(event.payload.eventId);
    if (state === undefined) {
      recordSignalTelemetry(this.#telemetry, {
        name: "live-event.runtime.skipped",
        source: "live-event-runtime",
        liveEventId: event.payload.eventId,
        level: "warn",
        outcome: "cancelled",
        trace: { traceId, spanId: traceId },
        attributes: {
          eventId: event.payload.eventId,
          reason: "unknown-event",
          sequence: event.sequence,
        },
      });
      return;
    }
    if (event.event === "live_event.invalidated") {
      this.#subscriptionFingerprints.delete(event.payload.eventId);
      state.resolution = {
        status: "invalidated",
        reason: event.payload.reason,
        ...(event.payload.detail === undefined
          ? {}
          : { detail: event.payload.detail }),
      };
      this.#emitState(state);
      recordSignalTelemetry(this.#telemetry, {
        name: "live-event.runtime.invalidated",
        source: "live-event-runtime",
        liveEventId: event.payload.eventId,
        level: "warn",
        outcome: "cancelled",
        durationMs: this.#durationSince(event.receivedAt),
        trace: { traceId, spanId: traceId },
        occurredAt: event.receivedAt,
        attributes: {
          eventId: event.payload.eventId,
          reason: event.payload.reason,
          sequence: event.sequence,
        },
      });
      return;
    }
    if (this.#reconciling) {
      recordSignalTelemetry(this.#telemetry, {
        name: "live-event.runtime.skipped",
        source: "live-event-runtime",
        correlationId: event.payload.occurrenceId,
        liveEventId: event.payload.eventId,
        level: "warn",
        outcome: "cancelled",
        durationMs: this.#durationSince(event.receivedAt),
        trace: { traceId, spanId: traceId },
        attributes: {
          eventId: event.payload.eventId,
          reason: "gap-reconciliation",
          sequence: event.sequence,
        },
      });
      return;
    }
    const occurrence = liveEventOccurrenceSchema.parse(event.payload);
    state.latestState = occurrenceState(occurrence);
    state.history.push(occurrence);
    if (state.history.length > this.#historyLimit) {
      state.history.splice(0, state.history.length - this.#historyLimit);
    }
    this.#emitState(state);
    recordSignalTelemetry(this.#telemetry, {
      name: "live-event.history.recorded",
      source: "live-event-runtime",
      correlationId: occurrence.occurrenceId,
      projectId: state.definition.projectId,
      liveEventId: occurrence.eventId,
      outcome: "success",
      durationMs: this.#durationSince(event.receivedAt),
      trace: { traceId, spanId: traceId },
      occurredAt: event.receivedAt,
      attributes: {
        occurrenceId: occurrence.occurrenceId,
        eventId: occurrence.eventId,
        sequence: occurrence.sequence,
        historySize: state.history.length,
      },
    });
    if (
      occurrence.kind === "track.triggered_clip_changed" &&
      occurrence.current.state === "none"
    ) {
      this.#recordSkip(
        "non-actionable-trigger-reset",
        {
          occurrenceId: occurrence.occurrenceId,
          eventId: occurrence.eventId,
          sequence: occurrence.sequence,
        },
        traceId,
      );
      return;
    }
    const bindings = this.#listenersByEvent.get(occurrence.eventId) ?? [];
    let activeListeners = 0;
    for (const binding of bindings) {
      if (!this.#activeAgentInstanceIds.has(binding.agentInstanceId)) {
        this.#recordSkip(
          "inactive-listener-agent",
          {
            agentInstanceId: binding.agentInstanceId,
            eventId: occurrence.eventId,
            listenerId: binding.listener.id,
          },
          traceId,
        );
        continue;
      }
      activeListeners += 1;
      const pending = {
        deliveryId: deliveryId(binding.listener, occurrence),
        agentInstanceId: binding.agentInstanceId,
        listener: binding.listener,
        occurrence,
        ...(this.#preparedContextProvider === undefined
          ? {}
          : {
              preparedContext: this.#preparedContextProvider.getPreparedContext(
                binding.agentInstanceId,
                binding.listener,
              ),
            }),
      };
      if (binding.listener.responseMode === "next-prompt") {
        this.#enqueueNextPrompt(pending, state.definition.classification);
      } else {
        this.#enqueueAutomatic(pending, state.definition.classification);
      }
    }
    recordSignalTelemetry(this.#telemetry, {
      name: "live-event.listener-fanout.completed",
      source: "live-event-runtime",
      correlationId: occurrence.occurrenceId,
      projectId: state.definition.projectId,
      liveEventId: occurrence.eventId,
      outcome: "success",
      durationMs: this.#durationSince(event.receivedAt),
      trace: {
        traceId,
        spanId: stableTelemetryId(`${traceId}:runtime-listener-fanout`),
        parentSpanId: traceId,
      },
      attributes: {
        occurrenceId: occurrence.occurrenceId,
        eventId: occurrence.eventId,
        listenerCount: bindings.length,
        activeListenerCount: activeListeners,
        subscriberCount: this.#subscribers.size,
      },
    });
  }

  #enqueueNextPrompt(
    pending: PendingLiveEventContext,
    classification: LiveEventDefinition["classification"],
  ): void {
    const entries = this.#nextPrompt.get(pending.agentInstanceId) ?? [];
    if (classification === "continuous") {
      const displaced = entries.find(
        ({ listener }) => listener.id === pending.listener.id,
      );
      if (displaced !== undefined) {
        this.#recordDelivery("live-event.queue.coalesced", displaced, {
          outcome: "cancelled",
          attributes: { replacementDeliveryId: pending.deliveryId },
        });
      }
    }
    const next =
      classification === "continuous"
        ? [
            ...entries.filter(
              ({ listener }) => listener.id !== pending.listener.id,
            ),
            pending,
          ]
        : [...entries, pending];
    const continuous = next.filter(
      ({ occurrence }) =>
        this.#states.get(occurrence.eventId)?.definition.classification ===
        "continuous",
    );
    const allDiscrete = next.filter(
      ({ occurrence }) =>
        this.#states.get(occurrence.eventId)?.definition.classification ===
        "discrete",
    );
    const dropped = allDiscrete.slice(
      0,
      Math.max(0, allDiscrete.length - this.#nextPromptDiscreteLimit),
    );
    for (const context of dropped) {
      this.#recordDelivery("live-event.queue.dropped", context, {
        level: "warn",
        outcome: "cancelled",
        attributes: { reason: "next-prompt-queue-bound" },
      });
    }
    const discrete = allDiscrete
      .filter(
        ({ occurrence }) =>
          this.#states.get(occurrence.eventId)?.definition.classification ===
          "discrete",
      )
      .slice(-this.#nextPromptDiscreteLimit);
    this.#nextPrompt.set(pending.agentInstanceId, [...discrete, ...continuous]);
    this.#recordDelivery("live-event.queue.enqueued", pending, {
      attributes: {
        queue: "next-prompt",
        classification,
        queueSize: discrete.length + continuous.length,
      },
    });
  }

  #enqueueAutomatic(
    pending: PendingLiveEventContext,
    classification: LiveEventDefinition["classification"],
  ): void {
    const queue: AutomaticAgentQueue = this.#automatic.get(
      pending.agentInstanceId,
    ) ?? {
      discrete: [],
      continuous: new Map<string, PendingLiveEventContext>(),
      draining: false,
    };
    this.#automatic.set(pending.agentInstanceId, queue);
    if (classification === "discrete") {
      queue.discrete.push(pending);
      this.#recordDelivery("live-event.queue.enqueued", pending, {
        attributes: {
          queue: "automatic",
          classification,
          queueSize: queue.discrete.length,
        },
      });
      if (queue.discrete.length > this.#automaticDiscreteLimit) {
        const dropped = queue.discrete.splice(
          0,
          queue.discrete.length - this.#automaticDiscreteLimit,
        );
        for (const context of dropped) {
          this.#recordDelivery("live-event.queue.dropped", context, {
            level: "warn",
            outcome: "cancelled",
            attributes: { reason: "automatic-queue-bound" },
          });
        }
        this.#diagnostic(
          "warning",
          `Automatic Live event queue overflowed for agent '${pending.agentInstanceId}'`,
          new Error(
            `Dropped oldest discrete occurrences after reaching the ${this.#automaticDiscreteLimit}-event limit`,
          ),
        );
      }
      this.#drainAutomatic(pending.agentInstanceId);
      return;
    }
    const displaced = queue.continuous.get(pending.listener.id);
    if (displaced !== undefined) {
      this.#recordDelivery("live-event.queue.coalesced", displaced, {
        outcome: "cancelled",
        attributes: { replacementDeliveryId: pending.deliveryId },
      });
    }
    queue.continuous.set(pending.listener.id, pending);
    const timerKey = `${pending.agentInstanceId}:${pending.listener.id}`;
    const previous = this.#settleTimers.get(timerKey);
    if (previous !== undefined) clearTimeout(previous);
    this.#recordDelivery("live-event.settle.scheduled", pending, {
      attributes: { settleMs: this.#continuousSettleMs },
    });
    this.#settleTimers.set(
      timerKey,
      setTimeout(() => {
        this.#settleTimers.delete(timerKey);
        const settled = queue.continuous.get(pending.listener.id);
        if (settled !== undefined) {
          this.#recordDelivery("live-event.settle.completed", settled, {
            durationMs: this.#continuousSettleMs,
          });
        }
        this.#drainAutomatic(pending.agentInstanceId);
      }, this.#continuousSettleMs),
    );
  }

  #drainAutomatic(agentInstanceId: string): void {
    const queue = this.#automatic.get(agentInstanceId);
    const service = this.#deliveryService;
    if (
      queue === undefined ||
      queue.draining ||
      service === undefined ||
      !this.#activeAgentInstanceIds.has(agentInstanceId)
    ) {
      const pending =
        queue?.discrete[0] ?? queue?.continuous.values().next().value;
      if (pending !== undefined) {
        this.#recordDelivery("live-event.dispatch.skipped", pending, {
          outcome: "cancelled",
          attributes: {
            reason:
              service === undefined
                ? "delivery-service-unavailable"
                : !this.#activeAgentInstanceIds.has(agentInstanceId)
                  ? "inactive-agent"
                  : "already-draining",
          },
        });
      }
      return;
    }
    queue.draining = true;
    void (async () => {
      try {
        while (this.#activeAgentInstanceIds.has(agentInstanceId)) {
          const next =
            queue.discrete.shift() ??
            (() => {
              const entry = queue.continuous.entries().next().value;
              if (entry === undefined) return undefined;
              queue.continuous.delete(entry[0]);
              return entry[1];
            })();
          if (next === undefined) break;
          const startedAt = this.#now().getTime();
          this.#recordDelivery("live-event.dispatch.requested", next);
          try {
            await service.enqueueLiveEventTurn(next);
            const durationMs = this.#now().getTime() - startedAt;
            this.#recordDelivery("live-event.delivery.completed", next, {
              outcome: "success",
              durationMs,
            });
            this.#recordDelivery("live-event.delivery.acknowledged", next, {
              outcome: "success",
              durationMs,
            });
          } catch (error) {
            this.#recordDelivery("live-event.delivery.failed", next, {
              level: "error",
              outcome: "failure",
              durationMs: this.#now().getTime() - startedAt,
              attributes: {
                errorType: error instanceof Error ? error.name : typeof error,
              },
            });
            this.#diagnostic(
              "error",
              `Automatic Live event delivery failed for agent '${agentInstanceId}'`,
              error,
            );
          }
        }
      } finally {
        queue.draining = false;
        if (queue.discrete.length > 0 || queue.continuous.size > 0) {
          this.#drainAutomatic(agentInstanceId);
        }
      }
    })();
  }

  #onReconciliation(signal: LiveEventReconciliationSignal): void {
    if (signal.reason === "reconnect") {
      recordSignalTelemetry(this.#telemetry, {
        name: "live-event.reconciliation.replay",
        source: "live-event-runtime",
        attributes: { subscriptionCount: signal.subscriptions.length },
      });
      this.#applyStatuses(signal.subscriptions);
      const statuses = new Map(
        signal.subscriptions.map((status) => [status.eventId, status]),
      );
      let shouldSync = false;
      for (const state of this.#states.values()) {
        if (!state.definition.enabled) continue;
        const status = statuses.get(state.definition.id);
        const retryableReplayFailure =
          status?.status === "unresolved" && status.error.retryable;
        if (status?.status === "unresolved") {
          this.#subscriptionFingerprints.delete(state.definition.id);
        }
        if (
          retryableReplayFailure ||
          (status === undefined &&
            !this.#subscriptionFingerprints.has(state.definition.id))
        ) {
          if (retryableReplayFailure) {
            this.#subscriptionFingerprints.delete(state.definition.id);
          }
          this.#clearSubscriptionRetry(state.definition.id);
          shouldSync = true;
        }
      }
      if (shouldSync) this.#scheduleSync();
      return;
    }
    const startedAt = this.#now().getTime();
    const traceId = stableTelemetryId(
      `live-event-reconciliation:${signal.expectedSequence}:${signal.receivedSequence}`,
    );
    recordSignalTelemetry(this.#telemetry, {
      name: "live-event.reconciliation.requested",
      source: "live-event-runtime",
      level: "warn",
      trace: { traceId, spanId: traceId },
      attributes: {
        reason: signal.reason,
        expectedSequence: signal.expectedSequence,
        receivedSequence: signal.receivedSequence,
      },
    });
    this.#reconciling = true;
    for (const queue of this.#automatic.values()) {
      for (const pending of [...queue.discrete, ...queue.continuous.values()]) {
        this.#recordDelivery("live-event.queue.dropped", pending, {
          level: "warn",
          outcome: "cancelled",
          attributes: { reason: "sequence-gap" },
        });
      }
      queue.discrete.length = 0;
      queue.continuous.clear();
    }
    void this.#bridge
      .reconcileLiveEventSubscriptions()
      .then((statuses) => {
        this.#applyStatuses(statuses);
        recordSignalTelemetry(this.#telemetry, {
          name: "live-event.reconciliation.completed",
          source: "live-event-runtime",
          outcome: "success",
          durationMs: this.#now().getTime() - startedAt,
          trace: { traceId, spanId: traceId },
          attributes: { subscriptionCount: statuses.length },
        });
      })
      .catch((error: unknown) => {
        recordSignalTelemetry(this.#telemetry, {
          name: "live-event.reconciliation.failed",
          source: "live-event-runtime",
          level: "error",
          outcome: "failure",
          durationMs: this.#now().getTime() - startedAt,
          trace: { traceId, spanId: traceId },
          attributes: {
            errorType: error instanceof Error ? error.name : typeof error,
          },
        });
        this.#diagnostic(
          "error",
          "Live event gap reconciliation failed",
          error,
        );
      })
      .finally(() => {
        this.#reconciling = false;
      });
  }

  #applyStatuses(statuses: readonly LiveEventSubscriptionStatus[]): void {
    for (const status of statuses) {
      const state = this.#states.get(status.eventId);
      if (state === undefined) continue;
      state.resolution = statusResolution(status);
      const latestState = statusState(status);
      if (latestState !== undefined) state.latestState = latestState;
      this.#emitState(state);
      const traceId = stableTelemetryId(
        `live-event-subscription:${status.eventId}`,
      );
      recordSignalTelemetry(this.#telemetry, {
        name: `live-event.reconciliation.${status.status}`,
        source: "live-event-runtime",
        correlationId: status.eventId,
        projectId: state.definition.projectId,
        liveEventId: status.eventId,
        level: status.status === "resolved" ? "info" : "warn",
        outcome: status.status === "resolved" ? "success" : "failure",
        trace: { traceId, spanId: traceId },
        attributes: { eventId: status.eventId, status: status.status },
      });
    }
  }

  #pruneDeliveries(
    definitions: readonly LiveEventDefinition[],
    listeners: readonly AgentLiveEventListener[],
  ): void {
    const enabledEvents = new Set(
      definitions.filter(({ enabled }) => enabled).map(({ id }) => id),
    );
    const enabledListeners = new Map<string, string>(
      listeners
        .filter(
          ({ listener }) =>
            listener.enabled && enabledEvents.has(listener.eventId),
        )
        .map(({ agentInstanceId, listener }) => [
          listener.id,
          listenerSignature(agentInstanceId, listener),
        ]),
    );
    const isCurrent = ({
      agentInstanceId,
      listener,
    }: PendingLiveEventContext): boolean =>
      enabledListeners.get(listener.id) ===
      listenerSignature(agentInstanceId, listener);
    for (const [agentId, entries] of this.#nextPrompt) {
      const retained = entries.filter(isCurrent);
      for (const pending of entries) {
        if (!retained.includes(pending)) {
          this.#recordDelivery("live-event.delivery.skipped", pending, {
            outcome: "cancelled",
            attributes: { reason: "configuration-changed" },
          });
        }
      }
      this.#nextPrompt.set(agentId, retained);
    }
    for (const queue of this.#automatic.values()) {
      const removedDiscrete = queue.discrete.filter(
        (pending) => !isCurrent(pending),
      );
      for (const pending of removedDiscrete) {
        this.#recordDelivery("live-event.delivery.skipped", pending, {
          outcome: "cancelled",
          attributes: { reason: "configuration-changed" },
        });
      }
      queue.discrete.splice(
        0,
        queue.discrete.length,
        ...queue.discrete.filter(isCurrent),
      );
      for (const [listenerId, pending] of queue.continuous) {
        if (!isCurrent(pending)) {
          this.#recordDelivery("live-event.delivery.skipped", pending, {
            outcome: "cancelled",
            attributes: { reason: "configuration-changed" },
          });
          queue.continuous.delete(listenerId);
        }
      }
    }
    for (const [timerKey, timer] of this.#settleTimers) {
      const separator = timerKey.lastIndexOf(":");
      const agentInstanceId = timerKey.slice(0, separator);
      const listenerId = timerKey.slice(separator + 1);
      const binding = listeners.find(
        ({ agentInstanceId: agentId, listener }) =>
          agentId === agentInstanceId && listener.id === listenerId,
      );
      if (
        binding === undefined ||
        binding.listener.responseMode !== "automatic" ||
        enabledListeners.get(listenerId) !==
          listenerSignature(binding.agentInstanceId, binding.listener)
      ) {
        clearTimeout(timer);
        this.#settleTimers.delete(timerKey);
      }
    }
  }

  #emitState(state: MutableState): void {
    const event: LiveEventRuntimeEvent = {
      type: "state.changed",
      state: { ...state, history: [...state.history] },
    };
    for (const subscriber of this.#subscribers) subscriber(event);
  }

  #durationSince(timestamp: string): number {
    return Math.max(0, this.#now().getTime() - Date.parse(timestamp));
  }

  #recordDelivery(
    name: string,
    context: PendingLiveEventContext,
    options: {
      readonly level?: "debug" | "info" | "warn" | "error";
      readonly outcome?: "success" | "failure" | "cancelled" | "unknown";
      readonly durationMs?: number;
      readonly attributes?: SanitizedAttributes;
    } = {},
  ): void {
    const traceId = context.occurrence.occurrenceId;
    const projectId = this.#states.get(context.occurrence.eventId)?.definition
      .projectId;
    recordSignalTelemetry(this.#telemetry, {
      name,
      source: "live-event-runtime",
      correlationId: context.occurrence.occurrenceId,
      causationId: context.occurrence.occurrenceId,
      ...(projectId === undefined ? {} : { projectId }),
      activeAgentId: context.agentInstanceId,
      liveEventId: context.occurrence.eventId,
      ...(options.level === undefined ? {} : { level: options.level }),
      ...(options.outcome === undefined ? {} : { outcome: options.outcome }),
      ...(options.durationMs === undefined
        ? {}
        : { durationMs: options.durationMs }),
      trace: {
        traceId,
        spanId: stableTelemetryId(context.deliveryId),
        parentSpanId: traceId,
      },
      attributes: {
        occurrenceId: context.occurrence.occurrenceId,
        eventId: context.occurrence.eventId,
        deliveryId: context.deliveryId,
        listenerId: context.listener.id,
        agentInstanceId: context.agentInstanceId,
        responseMode: context.listener.responseMode,
        sequence: context.occurrence.sequence,
        ...(options.attributes ?? {}),
      },
    });
  }

  #recordSkip(
    reason: string,
    attributes: SanitizedAttributes,
    traceId = stableTelemetryId(
      `live-event-skip:${reason}:${JSON.stringify(attributes)}`,
    ),
  ): void {
    const activeAgentId =
      typeof attributes.agentInstanceId === "string"
        ? attributes.agentInstanceId
        : undefined;
    const liveEventId =
      typeof attributes.eventId === "string" ? attributes.eventId : undefined;
    const projectId =
      liveEventId === undefined
        ? undefined
        : this.#states.get(liveEventId)?.definition.projectId;
    recordSignalTelemetry(this.#telemetry, {
      name: "live-event.runtime.skipped",
      source: "live-event-runtime",
      ...(activeAgentId === undefined ? {} : { activeAgentId }),
      correlationId: traceId,
      ...(projectId === undefined ? {} : { projectId }),
      ...(liveEventId === undefined ? {} : { liveEventId }),
      level: "debug",
      outcome: "cancelled",
      trace: { traceId, spanId: traceId },
      attributes: { reason, ...attributes },
    });
  }

  #diagnostic(
    level: "warning" | "error",
    message: string,
    error: unknown,
  ): void {
    const detail = error instanceof Error ? error.message : String(error);
    this.#logger[level === "error" ? "error" : "warn"](message, {
      error: detail,
    });
    for (const subscriber of this.#subscribers) {
      subscriber({
        type: "diagnostic",
        level,
        message: `${message}: ${detail}`,
      });
    }
  }
}
