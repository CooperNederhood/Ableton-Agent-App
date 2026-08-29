import type {
  LiveEventContextProvider,
  LiveEventDeliveryService,
  PendingLiveEventContext,
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
import { noopLogger, type Logger } from "@ableton-agent/shared";

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
  readonly #states = new Map<string, MutableState>();
  readonly #listenersByEvent = new Map<string, AgentLiveEventListener[]>();
  readonly #activeAgentInstanceIds = new Set<string>();
  readonly #nextPrompt = new Map<string, PendingLiveEventContext[]>();
  readonly #automatic = new Map<string, AutomaticAgentQueue>();
  readonly #settleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #subscribers = new Set<(event: LiveEventRuntimeEvent) => void>();
  readonly #subscriptionFingerprints = new Map<string, string>();
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
  }

  public get provider(): LiveEventContextProvider {
    return this;
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
      }
    }
    for (const definition of definitions) {
      const existing = this.#states.get(definition.id);
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
    if (!this.#activeAgentInstanceIds.has(agentInstanceId)) return [];
    return [...(this.#nextPrompt.get(agentInstanceId) ?? [])];
  }

  public async markLiveEventContextsDelivered(
    agentInstanceId: string,
    deliveryIds: readonly string[],
  ): Promise<void> {
    if (!this.#activeAgentInstanceIds.has(agentInstanceId)) return;
    const delivered = new Set(deliveryIds);
    this.#nextPrompt.set(
      agentInstanceId,
      (this.#nextPrompt.get(agentInstanceId) ?? []).filter(
        ({ deliveryId: id }) => !delivered.has(id),
      ),
    );
  }

  #scheduleSync(): void {
    if (!this.#started) return;
    this.#syncTail = this.#syncTail
      .then(() => this.#syncSubscriptions())
      .catch((error: unknown) =>
        this.#diagnostic("error", "Live event subscription sync failed", error),
      );
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
      try {
        const params = await this.#resolveParams(state.definition);
        const fingerprint = JSON.stringify(params);
        if (
          this.#subscriptionFingerprints.get(state.definition.id) ===
          fingerprint
        )
          continue;
        if (this.#subscriptionFingerprints.has(state.definition.id)) {
          await this.#bridge.unsubscribeLiveEvent(state.definition.id);
        }
        const result = await this.#bridge.subscribeLiveEvent(params);
        this.#subscriptionFingerprints.set(state.definition.id, fingerprint);
        state.resolution = result.resolution;
        state.latestState = result.initialState;
        this.#emitState(state);
      } catch (error) {
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
        this.#diagnostic(
          "warning",
          `Live event '${state.definition.name}' is unresolved`,
          error,
        );
      }
    }
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
    const state = this.#states.get(event.payload.eventId);
    if (state === undefined) return;
    if (event.event === "live_event.invalidated") {
      state.resolution = {
        status: "invalidated",
        reason: event.payload.reason,
        ...(event.payload.detail === undefined
          ? {}
          : { detail: event.payload.detail }),
      };
      this.#emitState(state);
      return;
    }
    if (this.#reconciling) return;
    const occurrence = liveEventOccurrenceSchema.parse(event.payload);
    state.latestState = occurrenceState(occurrence);
    state.history.push(occurrence);
    if (state.history.length > this.#historyLimit) {
      state.history.splice(0, state.history.length - this.#historyLimit);
    }
    this.#emitState(state);
    for (const binding of this.#listenersByEvent.get(occurrence.eventId) ??
      []) {
      if (!this.#activeAgentInstanceIds.has(binding.agentInstanceId)) continue;
      const pending = {
        deliveryId: deliveryId(binding.listener, occurrence),
        agentInstanceId: binding.agentInstanceId,
        listener: binding.listener,
        occurrence,
      };
      if (binding.listener.responseMode === "next-prompt") {
        this.#enqueueNextPrompt(pending, state.definition.classification);
      } else {
        this.#enqueueAutomatic(pending, state.definition.classification);
      }
    }
  }

  #enqueueNextPrompt(
    pending: PendingLiveEventContext,
    classification: LiveEventDefinition["classification"],
  ): void {
    const entries = this.#nextPrompt.get(pending.agentInstanceId) ?? [];
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
    const discrete = next
      .filter(
        ({ occurrence }) =>
          this.#states.get(occurrence.eventId)?.definition.classification ===
          "discrete",
      )
      .slice(-this.#nextPromptDiscreteLimit);
    this.#nextPrompt.set(pending.agentInstanceId, [...discrete, ...continuous]);
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
      if (queue.discrete.length > this.#automaticDiscreteLimit) {
        queue.discrete.splice(
          0,
          queue.discrete.length - this.#automaticDiscreteLimit,
        );
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
    queue.continuous.set(pending.listener.id, pending);
    const timerKey = `${pending.agentInstanceId}:${pending.listener.id}`;
    const previous = this.#settleTimers.get(timerKey);
    if (previous !== undefined) clearTimeout(previous);
    this.#settleTimers.set(
      timerKey,
      setTimeout(() => {
        this.#settleTimers.delete(timerKey);
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
          try {
            await service.enqueueLiveEventTurn(next);
          } catch (error) {
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
      this.#applyStatuses(signal.subscriptions);
      return;
    }
    this.#reconciling = true;
    for (const queue of this.#automatic.values()) {
      queue.discrete.length = 0;
      queue.continuous.clear();
    }
    void this.#bridge
      .reconcileLiveEventSubscriptions()
      .then((statuses) => this.#applyStatuses(statuses))
      .catch((error: unknown) =>
        this.#diagnostic(
          "error",
          "Live event gap reconciliation failed",
          error,
        ),
      )
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
      this.#nextPrompt.set(agentId, entries.filter(isCurrent));
    }
    for (const queue of this.#automatic.values()) {
      queue.discrete.splice(
        0,
        queue.discrete.length,
        ...queue.discrete.filter(isCurrent),
      );
      for (const [listenerId, pending] of queue.continuous) {
        if (!isCurrent(pending)) {
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
