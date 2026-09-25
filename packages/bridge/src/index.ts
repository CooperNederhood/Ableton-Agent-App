import { createHash, randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";

import type { AbletonService } from "@ableton-agent/ableton-contracts";
import {
  FrameDecoder,
  PROTOCOL_VERSION,
  capabilityDocumentSchema,
  commandCatalog,
  createCuePointParamsSchema,
  cuePointMutationResultSchema,
  createArrangementMidiClipParamsSchema,
  createArrangementMidiClipResultSchema,
  deleteArrangementClipParamsSchema,
  deleteArrangementClipResultSchema,
  deleteCuePointParamsSchema,
  duplicateClipToArrangementParamsSchema,
  duplicateClipToArrangementResultSchema,
  fillArrangementRegionParamsSchema,
  fillArrangementRegionResultSchema,
  duplicateSessionClipParamsSchema,
  duplicateSessionClipResultSchema,
  createMidiClipParamsSchema,
  createMidiClipResultSchema,
  createTrackParamsSchema,
  deleteTrackParamsSchema,
  deleteSessionClipParamsSchema,
  deleteSessionClipResultSchema,
  inspectDeviceParametersParamsSchema,
  inspectDeviceParametersResultSchema,
  inspectDevicesParamsSchema,
  inspectDevicesResultSchema,
  inspectBrowserRootsParamsSchema,
  inspectBrowserRootsResultSchema,
  inspectBrowserChildrenParamsSchema,
  inspectBrowserChildrenResultSchema,
  searchBrowserParamsSchema,
  searchBrowserResultSchema,
  loadBrowserItemParamsSchema,
  loadBrowserItemResultSchema,
  inspectDrumPadChainDevicesParamsSchema,
  inspectDrumPadChainDevicesResultSchema,
  inspectDrumPadChainsParamsSchema,
  inspectDrumPadChainsResultSchema,
  inspectDrumRackPadsParamsSchema,
  inspectDrumRackPadsResultSchema,
  inspectEventSelectionParamsSchema,
  inspectEventSelectionResultSchema,
  inspectMidiNotesParamsSchema,
  inspectMidiNotesResultSchema,
  inspectRackChainDevicesParamsSchema,
  inspectRackChainDevicesResultSchema,
  inspectRackChainsParamsSchema,
  inspectRackChainsResultSchema,
  encodeFrame,
  pingResultSchema,
  liveIdentitySchema,
  sessionSnapshotSchema,
  setPlayingParamsSchema,
  setPlayingResultSchema,
  renameTrackParamsSchema,
  renameTrackResultSchema,
  inspectArrangementParamsSchema,
  inspectArrangementResultSchema,
  inspectArrangementMidiNotesParamsSchema,
  inspectArrangementMidiNotesResultSchema,
  inspectArrangementTransportParamsSchema,
  inspectArrangementTransportResultSchema,
  launchSessionClipParamsSchema,
  launchSessionClipResultSchema,
  listEventSubscriptionsParamsSchema,
  listEventSubscriptionsResultSchema,
  liveEventEnvelopeSchema,
  liveSetSaveObservedEnvelopeSchema,
  replaceMidiNotesParamsSchema,
  replaceMidiNotesResultSchema,
  replaceArrangementMidiNotesParamsSchema,
  replaceArrangementMidiNotesResultSchema,
  setArrangementClipPropertiesParamsSchema,
  setArrangementClipPropertiesResultSchema,
  setArrangementLoopParamsSchema,
  setArrangementLoopResultSchema,
  setSessionClipPropertiesParamsSchema,
  setSessionClipPropertiesResultSchema,
  setTrackMixerParamsSchema,
  setTrackMixerResultSchema,
  subscribeEventParamsSchema,
  subscribeEventResultSchema,
  setDeviceEnabledParamsSchema,
  setDeviceEnabledResultSchema,
  setDeviceParameterParamsSchema,
  setDeviceParameterResultSchema,
  setTempoParamsSchema,
  setTempoResultSchema,
  trackMutationResultSchema,
  unsubscribeEventParamsSchema,
  unsubscribeEventResultSchema,
  clearEventSubscriptionsParamsSchema,
  clearEventSubscriptionsResultSchema,
  type CapabilityDocument,
  type CreateCuePointParams,
  type CuePointMutationResult,
  type CreateArrangementMidiClipParams,
  type CreateArrangementMidiClipResult,
  type DeleteArrangementClipParams,
  type DeleteArrangementClipResult,
  type DeleteCuePointParams,
  type DuplicateClipToArrangementParams,
  type DuplicateClipToArrangementResult,
  type FillArrangementRegionParams,
  type FillArrangementRegionResult,
  type DuplicateSessionClipParams,
  type DuplicateSessionClipResult,
  type CreateMidiClipParams,
  type CreateMidiClipResult,
  type CreateTrackParams,
  type DeleteTrackParams,
  type DeleteSessionClipParams,
  type DeleteSessionClipResult,
  type InspectDeviceParametersParams,
  type InspectDeviceParametersResult,
  type InspectDevicesParams,
  type InspectDevicesResult,
  type InspectBrowserRootsResult,
  type InspectBrowserChildrenParams,
  type InspectBrowserChildrenResult,
  type SearchBrowserParams,
  type SearchBrowserResult,
  type LoadBrowserItemParams,
  type LoadBrowserItemResult,
  type ListEventSubscriptionsResult,
  type LiveEventInitialStatePayload,
  type LiveEventInvalidationPayload,
  type LiveEventOccurrencePayload,
  type InspectDrumPadChainDevicesParams,
  type InspectDrumPadChainDevicesResult,
  type InspectDrumPadChainsParams,
  type InspectDrumPadChainsResult,
  type InspectDrumRackPadsParams,
  type InspectDrumRackPadsResult,
  type InspectEventSelectionResult,
  type InspectMidiNotesParams,
  type InspectMidiNotesResult,
  type InspectRackChainDevicesParams,
  type InspectRackChainDevicesResult,
  type InspectRackChainsParams,
  type InspectRackChainsResult,
  type EventEnvelope,
  type MessageEnvelope,
  type PingResult,
  type LiveIdentity,
  type LiveSetSaveObservedPayload,
  type RequestEnvelope,
  type ResponseEnvelope,
  type SessionSnapshot,
  type SetPlayingResult,
  type RenameTrackParams,
  type RenameTrackResult,
  type InspectArrangementParams,
  type InspectArrangementResult,
  type InspectArrangementMidiNotesParams,
  type InspectArrangementMidiNotesResult,
  type InspectArrangementTransportParams,
  type InspectArrangementTransportResult,
  type LaunchSessionClipParams,
  type LaunchSessionClipResult,
  type ReplaceMidiNotesParams,
  type ReplaceMidiNotesResult,
  type ReplaceArrangementMidiNotesParams,
  type ReplaceArrangementMidiNotesResult,
  type SetArrangementClipPropertiesParams,
  type SetArrangementClipPropertiesResult,
  type SetArrangementLoopParams,
  type SetArrangementLoopResult,
  type SetSessionClipPropertiesParams,
  type SetSessionClipPropertiesResult,
  type SetTrackMixerParams,
  type SetTrackMixerResult,
  type SubscribeEventParams,
  type SubscribeEventResult,
  type SetDeviceEnabledParams,
  type SetDeviceEnabledResult,
  type SetDeviceParameterParams,
  type SetDeviceParameterResult,
  type SetTempoResult,
  type TrackMutationResult,
  type UnsubscribeEventResult,
  type ClearEventSubscriptionsResult,
  type EventSubscriptionDescriptor,
  type TimeoutClass,
} from "@ableton-agent/protocol";
import {
  currentCorrelationContext,
  currentCorrelationId,
} from "@ableton-agent/correlation";
import type {
  NonBlockingObservabilityRecorder,
  SanitizedAttributes,
  TelemetryEventEnvelope,
  TraceContext,
} from "@ableton-agent/observability";
import type { ConnectionStatus, EventPublisher } from "@ableton-agent/shared";

function stableTelemetryId(value: string): string {
  const hex = createHash("sha256").update(value).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
}

interface BridgeTelemetryInput {
  readonly name: string;
  readonly source: string;
  readonly level?: TelemetryEventEnvelope["level"];
  readonly outcome?: TelemetryEventEnvelope["outcome"];
  readonly durationMs?: number;
  readonly correlationId?: string;
  readonly causationId?: string;
  readonly liveSetId?: string;
  readonly liveProjectId?: string;
  readonly sessionId?: string;
  readonly activeAgentId?: string;
  readonly liveEventId?: string;
  readonly outputId?: string;
  readonly toolName?: string;
  readonly trace?: TraceContext;
  readonly attributes?: SanitizedAttributes;
  readonly occurredAt?: string;
}

export interface AbletonBridgeOptions {
  authenticationToken: string;
  events: EventPublisher;
  host?: string;
  port?: number;
  appVersion?: string;
  requestTimeoutMs?: number;
  longRequestTimeoutMs?: number;
  requestQueueLimit?: number;
  eventSubscriptions?: readonly string[];
  reconnect?: Partial<ReconnectPolicy>;
  random?: () => number;
  now?: () => Date;
  telemetry?: Pick<NonBlockingObservabilityRecorder, "enqueue">;
  onRequest?: (request: {
    requestId: string;
    correlationId?: string;
    command: string;
    params: Readonly<Record<string, unknown>>;
    requestedAt: string;
  }) => void;
  onResponse?: (response: {
    requestId: string;
    correlationId?: string;
    command: string;
    durationMs: number;
    receivedAt: string;
    ok: boolean;
    result?: unknown;
    error?: {
      code: string;
      message: string;
      retryable: boolean;
      details?: unknown;
    };
  }) => void;
}

export interface ReconnectPolicy {
  readonly maxAttempts: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly jitterRatio: number;
}

export interface AbletonBridgeEvent {
  readonly event: string;
  readonly sequence: number;
  readonly payload: unknown;
  readonly receivedAt: string;
  readonly projectRevision?: number;
}

export type AbletonLiveEvent =
  | {
      readonly event: "live_event.occurred";
      readonly sequence: number;
      readonly payload: LiveEventOccurrencePayload;
      readonly receivedAt: string;
      readonly projectRevision?: number;
    }
  | {
      readonly event: "live_event.invalidated";
      readonly sequence: number;
      readonly payload: LiveEventInvalidationPayload;
      readonly receivedAt: string;
      readonly projectRevision?: number;
    };

export interface AbletonLiveSetSaveEvent {
  readonly event: "live_set.save_observed";
  readonly sequence: number;
  readonly payload: LiveSetSaveObservedPayload;
  readonly receivedAt: string;
  readonly projectRevision?: number;
}

export type LiveEventSubscriptionStatus =
  | {
      readonly eventId: string;
      readonly status: "resolved";
      readonly subscription: EventSubscriptionDescriptor;
      readonly initialState?: LiveEventInitialStatePayload;
    }
  | {
      readonly eventId: string;
      readonly status: "unresolved";
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly retryable: boolean;
      };
    }
  | {
      readonly eventId: string;
      readonly status: "invalidated";
      readonly invalidation: LiveEventInvalidationPayload;
    };

export type LiveEventReconciliationSignal =
  | {
      readonly reason: "sequence-gap";
      readonly expectedSequence: number;
      readonly receivedSequence: number;
    }
  | {
      readonly reason: "reconnect";
      readonly subscriptions: readonly LiveEventSubscriptionStatus[];
    };

export interface AbletonBridge {
  start(): Promise<void>;
  stop(): Promise<void>;
  getStatus(): Promise<ConnectionStatus>;
  getCapabilities(): Promise<CapabilityDocument>;
  getLiveIdentity(): Promise<LiveIdentity>;
  getProjectRevision(): number | undefined;
  inspectEventSelection(): Promise<InspectEventSelectionResult>;
  subscribeLiveEvent(
    params: SubscribeEventParams,
  ): Promise<SubscribeEventResult>;
  unsubscribeLiveEvent(eventId: string): Promise<UnsubscribeEventResult>;
  listLiveEventSubscriptions(): Promise<ListEventSubscriptionsResult>;
  clearLiveEventSubscriptions(): Promise<ClearEventSubscriptionsResult>;
  subscribe(listener: (event: AbletonBridgeEvent) => void): () => void;
  subscribeLiveEvents(listener: (event: AbletonLiveEvent) => void): () => void;
  subscribeLiveSetSaves(
    listener: (event: AbletonLiveSetSaveEvent) => void,
  ): () => void;
  subscribeLiveEventReconciliation(
    listener: (signal: LiveEventReconciliationSignal) => void,
  ): () => void;
  getLiveEventSubscriptionStatuses(): readonly LiveEventSubscriptionStatus[];
  reconcileLiveEventSubscriptions(): Promise<
    readonly LiveEventSubscriptionStatus[]
  >;
}

interface PendingRequest {
  resolve(response: ResponseEnvelope): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
}

const DEFAULT_REQUEST_QUEUE_LIMIT = 128;

export class AbletonBridgeError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
    public readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "AbletonBridgeError";
  }
}

export class AbletonBridgeService implements AbletonService {
  readonly #host: string;
  readonly #port: number;
  readonly #appVersion: string;
  readonly #requestTimeoutMs: number;
  readonly #longRequestTimeoutMs: number;
  readonly #requestQueueLimit: number;
  readonly #eventSubscriptions: readonly string[];
  readonly #reconnect: ReconnectPolicy;
  readonly #random: () => number;
  readonly #decoder = new FrameDecoder();
  readonly #pending = new Map<string, PendingRequest>();
  readonly #eventListeners = new Set<(event: AbletonBridgeEvent) => void>();
  readonly #liveEventListeners = new Set<(event: AbletonLiveEvent) => void>();
  readonly #liveSetSaveListeners = new Set<
    (event: AbletonLiveSetSaveEvent) => void
  >();
  readonly #reconciliationListeners = new Set<
    (signal: LiveEventReconciliationSignal) => void
  >();
  readonly #desiredLiveEventSubscriptions = new Map<
    string,
    SubscribeEventParams
  >();
  readonly #liveEventSubscriptionStatuses = new Map<
    string,
    LiveEventSubscriptionStatus
  >();
  #requestTail: Promise<void> = Promise.resolve();
  #requestQueueDepth = 0;
  #socket: Socket | undefined;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #connectPromise: Promise<void> | undefined;
  #status: ConnectionStatus = { state: "disconnected" };
  #capabilities: CapabilityDocument | undefined;
  #connectionGeneration = 0;
  #handshakeComplete = false;
  #desiredRunning = false;
  #reconnectAttempt = 0;
  #lastEventSequence: number | undefined;
  #projectRevision: number | undefined;
  #successfulConnections = 0;

  public constructor(private readonly options: AbletonBridgeOptions) {
    if (options.authenticationToken.length < 32) {
      throw new Error(
        "Ableton bridge authentication token must be at least 32 characters",
      );
    }
    this.#host = options.host ?? "127.0.0.1";
    this.#port = options.port ?? 8765;
    this.#appVersion = options.appVersion ?? "0.1.0";
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
    this.#longRequestTimeoutMs = options.longRequestTimeoutMs ?? 15_000;
    this.#requestQueueLimit = Math.max(
      1,
      options.requestQueueLimit ?? DEFAULT_REQUEST_QUEUE_LIMIT,
    );
    this.#eventSubscriptions = [...(options.eventSubscriptions ?? [])];
    this.#reconnect = {
      maxAttempts: options.reconnect?.maxAttempts ?? 5,
      initialDelayMs: options.reconnect?.initialDelayMs ?? 250,
      maxDelayMs: options.reconnect?.maxDelayMs ?? 4_000,
      jitterRatio: options.reconnect?.jitterRatio ?? 0.2,
    };
    this.#random = options.random ?? Math.random;
  }

  public async start(): Promise<void> {
    this.#desiredRunning = true;
    if (this.#handshakeComplete) {
      return;
    }
    await this.#ensureConnected();
  }

  public async stop(): Promise<void> {
    this.#desiredRunning = false;
    if (this.#reconnectTimer !== undefined) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = undefined;
    }
    this.#destroySocket();
    this.#setStatus({ state: "disconnected" });
  }

  public getProjectRevision(): number | undefined {
    return this.#projectRevision;
  }

  public subscribe(listener: (event: AbletonBridgeEvent) => void): () => void {
    this.#eventListeners.add(listener);
    return () => {
      this.#eventListeners.delete(listener);
    };
  }

  public subscribeLiveEvents(
    listener: (event: AbletonLiveEvent) => void,
  ): () => void {
    this.#liveEventListeners.add(listener);
    return () => {
      this.#liveEventListeners.delete(listener);
    };
  }

  public subscribeLiveSetSaves(
    listener: (event: AbletonLiveSetSaveEvent) => void,
  ): () => void {
    this.#liveSetSaveListeners.add(listener);
    return () => {
      this.#liveSetSaveListeners.delete(listener);
    };
  }

  public subscribeLiveEventReconciliation(
    listener: (signal: LiveEventReconciliationSignal) => void,
  ): () => void {
    this.#reconciliationListeners.add(listener);
    return () => {
      this.#reconciliationListeners.delete(listener);
    };
  }

  public getLiveEventSubscriptionStatuses(): readonly LiveEventSubscriptionStatus[] {
    return [...this.#liveEventSubscriptionStatuses.values()];
  }

  async #ensureConnected(): Promise<void> {
    this.#connectPromise ??= this.#startConnection().finally(() => {
      this.#connectPromise = undefined;
      this.#scheduleReconnect();
    });
    return this.#connectPromise;
  }

  async #startConnection(): Promise<void> {
    if (!this.#desiredRunning || this.#handshakeComplete) return;
    this.#setStatus({ state: "connecting" });

    try {
      await this.#connect();
      const result = await this.#request("system.hello", {
        authenticationToken: this.options.authenticationToken,
        supportedProtocolVersions: [PROTOCOL_VERSION],
        appVersion: this.#appVersion,
        eventSubscriptions: [...this.#eventSubscriptions],
      });
      const capabilities = capabilityDocumentSchema.parse(result);
      if (!this.#desiredRunning) {
        this.#destroySocket();
        return;
      }
      this.#capabilities = capabilities;
      this.#handshakeComplete = true;
      this.#lastEventSequence = undefined;
      const reconnecting = this.#successfulConnections > 0;
      const replayedSubscriptions = await this.#replayLiveEventSubscriptions();
      if (reconnecting) {
        this.#publishReconciliation({
          reason: "reconnect",
          subscriptions: replayedSubscriptions,
        });
      }
      this.#successfulConnections += 1;
      this.#reconnectAttempt = 0;
      this.#setStatus({
        state: "connected",
        liveVersion: capabilities.liveVersion,
        remoteScriptVersion: capabilities.remoteScriptVersion,
        liveSetId: capabilities.liveSetId,
        liveSetName: capabilities.liveSetName,
        saved: capabilities.saved,
        ...(capabilities.liveProjectId === undefined
          ? {}
          : { liveProjectId: capabilities.liveProjectId }),
        ...(capabilities.liveProjectName === undefined
          ? {}
          : { liveProjectName: capabilities.liveProjectName }),
      });
    } catch (error) {
      this.#destroySocket();
      if (!this.#desiredRunning) {
        this.#setStatus({ state: "disconnected" });
        return;
      }
      this.#setStatus({
        state: "error",
        code:
          error instanceof AbletonBridgeError
            ? error.code
            : "connection_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  public async getStatus(): Promise<ConnectionStatus> {
    return this.#status;
  }

  /** Returns only the identity already learned during the current handshake. */
  public getCurrentLiveSetId(): string | undefined {
    return this.#capabilities?.liveSetId;
  }

  public async getCapabilities(): Promise<CapabilityDocument> {
    if (!this.#capabilities) {
      throw new AbletonBridgeError(
        "not_connected",
        "Ableton capabilities are unavailable before handshake",
        true,
      );
    }
    return this.#capabilities;
  }

  public async ping(): Promise<PingResult> {
    return pingResultSchema.parse(await this.#request("system.ping", {}));
  }

  public async getLiveIdentity(): Promise<LiveIdentity> {
    return liveIdentitySchema.parse(
      await this.#request("live_set.get_identity", {}),
    );
  }

  public async inspectEventSelection(): Promise<InspectEventSelectionResult> {
    this.#requireCapability("events.inspect_selection");
    return inspectEventSelectionResultSchema.parse(
      await this.#request(
        "events.inspect_selection",
        inspectEventSelectionParamsSchema.parse({}),
      ),
    );
  }

  public async subscribeLiveEvent(
    params: SubscribeEventParams,
  ): Promise<SubscribeEventResult> {
    this.#requireCapability("events.subscribe");
    const validated = subscribeEventParamsSchema.parse(params);
    this.#desiredLiveEventSubscriptions.set(validated.eventId, validated);
    return this.#requestLiveEventSubscription(validated);
  }

  public async unsubscribeLiveEvent(
    eventId: string,
  ): Promise<UnsubscribeEventResult> {
    this.#requireCapability("events.unsubscribe");
    const params = unsubscribeEventParamsSchema.parse({ eventId });
    this.#desiredLiveEventSubscriptions.delete(eventId);
    this.#liveEventSubscriptionStatuses.delete(eventId);
    return unsubscribeEventResultSchema.parse(
      await this.#request("events.unsubscribe", params),
    );
  }

  public async listLiveEventSubscriptions(): Promise<ListEventSubscriptionsResult> {
    this.#requireCapability("events.list_subscriptions");
    return listEventSubscriptionsResultSchema.parse(
      await this.#request(
        "events.list_subscriptions",
        listEventSubscriptionsParamsSchema.parse({}),
      ),
    );
  }

  public async clearLiveEventSubscriptions(): Promise<ClearEventSubscriptionsResult> {
    this.#requireCapability("events.clear_subscriptions");
    this.#desiredLiveEventSubscriptions.clear();
    this.#liveEventSubscriptionStatuses.clear();
    return clearEventSubscriptionsResultSchema.parse(
      await this.#request(
        "events.clear_subscriptions",
        clearEventSubscriptionsParamsSchema.parse({}),
      ),
    );
  }

  public async reconcileLiveEventSubscriptions(): Promise<
    readonly LiveEventSubscriptionStatus[]
  > {
    const startedAt = this.#now().getTime();
    this.#record({
      name: "live-event.reconciliation.requested",
      source: "live-event-bridge",
      attributes: {
        subscriptionCount: this.#desiredLiveEventSubscriptions.size,
      },
    });
    this.#requireCapability("events.list_subscriptions");
    const current = await this.listLiveEventSubscriptions();
    const remote = new Map(
      current.subscriptions.map((subscription) => [
        subscription.eventId,
        subscription,
      ]),
    );
    for (const [eventId, params] of [
      ...this.#desiredLiveEventSubscriptions.entries(),
    ].sort(([left], [right]) => left.localeCompare(right))) {
      const subscription = remote.get(eventId);
      if (subscription !== undefined) {
        this.#liveEventSubscriptionStatuses.set(eventId, {
          eventId,
          status: "resolved",
          subscription,
        });
        continue;
      }
      await this.#requestLiveEventSubscription(params).catch(() => undefined);
    }
    const statuses = this.getLiveEventSubscriptionStatuses();
    this.#record({
      name: "live-event.reconciliation.completed",
      source: "live-event-bridge",
      outcome: "success",
      durationMs: this.#now().getTime() - startedAt,
      attributes: {
        subscriptionCount: statuses.length,
        unresolvedCount: statuses.filter(
          ({ status }) => status === "unresolved",
        ).length,
      },
    });
    return statuses;
  }

  public async inspectSession(): Promise<SessionSnapshot> {
    return sessionSnapshotSchema.parse(
      await this.#request("session.inspect", {}),
    );
  }

  public async setTempo(tempo: number): Promise<SetTempoResult> {
    this.#requireCapability("transport.set_tempo");
    const params = setTempoParamsSchema.parse({ tempo });
    return setTempoResultSchema.parse(
      await this.#mutationRequest("transport.set_tempo", params),
    );
  }

  public async setPlaying(isPlaying: boolean): Promise<SetPlayingResult> {
    this.#requireCapability("transport.set_playing");
    const params = setPlayingParamsSchema.parse({ isPlaying });
    return setPlayingResultSchema.parse(
      await this.#mutationRequest("transport.set_playing", params),
    );
  }

  public async inspectArrangementTransport(
    params: InspectArrangementTransportParams,
  ): Promise<InspectArrangementTransportResult> {
    this.#requireCapability("transport.inspect_arrangement");
    const validated = inspectArrangementTransportParamsSchema.parse(params);
    return inspectArrangementTransportResultSchema.parse(
      await this.#request("transport.inspect_arrangement", validated),
    );
  }

  public async setArrangementLoop(
    params: SetArrangementLoopParams,
  ): Promise<SetArrangementLoopResult> {
    this.#requireCapability("transport.set_arrangement_loop");
    const validated = setArrangementLoopParamsSchema.parse(params);
    return setArrangementLoopResultSchema.parse(
      await this.#mutationRequest("transport.set_arrangement_loop", validated),
    );
  }

  public async createCuePoint(
    params: CreateCuePointParams,
  ): Promise<CuePointMutationResult> {
    this.#requireCapability("transport.create_cue_point");
    const validated = createCuePointParamsSchema.parse(params);
    return cuePointMutationResultSchema.parse(
      await this.#mutationRequest("transport.create_cue_point", validated),
    );
  }

  public async deleteCuePoint(
    params: DeleteCuePointParams,
  ): Promise<CuePointMutationResult> {
    this.#requireCapability("transport.delete_cue_point");
    const validated = deleteCuePointParamsSchema.parse(params);
    return cuePointMutationResultSchema.parse(
      await this.#mutationRequest("transport.delete_cue_point", validated),
    );
  }

  public async createTrack(
    params: CreateTrackParams,
  ): Promise<TrackMutationResult> {
    this.#requireCapability("tracks.create");
    const validated = createTrackParamsSchema.parse(params);
    return trackMutationResultSchema.parse(
      await this.#mutationRequest("tracks.create", validated),
    );
  }

  public async deleteTrack(
    params: DeleteTrackParams,
  ): Promise<TrackMutationResult> {
    this.#requireCapability("tracks.delete");
    const validated = deleteTrackParamsSchema.parse(params);
    return trackMutationResultSchema.parse(
      await this.#mutationRequest("tracks.delete", validated),
    );
  }

  public async renameTrack(
    params: RenameTrackParams,
  ): Promise<RenameTrackResult> {
    this.#requireCapability("tracks.rename");
    const validated = renameTrackParamsSchema.parse(params);
    return renameTrackResultSchema.parse(
      await this.#mutationRequest("tracks.rename", validated),
    );
  }

  public async setTrackMixer(
    params: SetTrackMixerParams,
  ): Promise<SetTrackMixerResult> {
    this.#requireCapability("tracks.set_mixer");
    const validated = setTrackMixerParamsSchema.parse(params);
    return setTrackMixerResultSchema.parse(
      await this.#mutationRequest("tracks.set_mixer", validated),
    );
  }

  public async inspectDevices(
    params: InspectDevicesParams,
  ): Promise<InspectDevicesResult> {
    this.#requireCapability("devices.inspect");
    const validated = inspectDevicesParamsSchema.parse(params);
    return inspectDevicesResultSchema.parse(
      await this.#request("devices.inspect", validated),
    );
  }

  public async inspectBrowserRoots(): Promise<InspectBrowserRootsResult> {
    this.#requireCapability("browser.inspect_roots");
    return inspectBrowserRootsResultSchema.parse(
      await this.#request(
        "browser.inspect_roots",
        inspectBrowserRootsParamsSchema.parse({}),
      ),
    );
  }

  public async inspectBrowserChildren(
    params: InspectBrowserChildrenParams,
  ): Promise<InspectBrowserChildrenResult> {
    this.#requireCapability("browser.inspect_children");
    const validated = inspectBrowserChildrenParamsSchema.parse(params);
    return inspectBrowserChildrenResultSchema.parse(
      await this.#request("browser.inspect_children", validated),
    );
  }

  public async searchBrowser(
    params: SearchBrowserParams,
  ): Promise<SearchBrowserResult> {
    this.#requireCapability("browser.search");
    const validated = searchBrowserParamsSchema.parse(params);
    return searchBrowserResultSchema.parse(
      await this.#request("browser.search", validated),
    );
  }

  public async loadBrowserItem(
    params: LoadBrowserItemParams,
  ): Promise<LoadBrowserItemResult> {
    this.#requireCapability("browser.load_item");
    const validated = loadBrowserItemParamsSchema.parse(params);
    return loadBrowserItemResultSchema.parse(
      await this.#mutationRequest("browser.load_item", validated),
    );
  }

  public async inspectDeviceParameters(
    params: InspectDeviceParametersParams,
  ): Promise<InspectDeviceParametersResult> {
    this.#requireCapability("devices.inspect_parameters");
    const validated = inspectDeviceParametersParamsSchema.parse(params);
    return inspectDeviceParametersResultSchema.parse(
      await this.#request("devices.inspect_parameters", validated),
    );
  }

  public async inspectRackChains(
    params: InspectRackChainsParams,
  ): Promise<InspectRackChainsResult> {
    this.#requireCapability("devices.inspect_rack_chains");
    const validated = inspectRackChainsParamsSchema.parse(params);
    return inspectRackChainsResultSchema.parse(
      await this.#request("devices.inspect_rack_chains", validated),
    );
  }

  public async inspectRackChainDevices(
    params: InspectRackChainDevicesParams,
  ): Promise<InspectRackChainDevicesResult> {
    this.#requireCapability("devices.inspect_rack_chain_devices");
    const validated = inspectRackChainDevicesParamsSchema.parse(params);
    return inspectRackChainDevicesResultSchema.parse(
      await this.#request("devices.inspect_rack_chain_devices", validated),
    );
  }

  public async inspectDrumRackPads(
    params: InspectDrumRackPadsParams,
  ): Promise<InspectDrumRackPadsResult> {
    this.#requireCapability("devices.inspect_drum_rack_pads");
    const validated = inspectDrumRackPadsParamsSchema.parse(params);
    return inspectDrumRackPadsResultSchema.parse(
      await this.#request("devices.inspect_drum_rack_pads", validated),
    );
  }

  public async inspectDrumPadChains(
    params: InspectDrumPadChainsParams,
  ): Promise<InspectDrumPadChainsResult> {
    this.#requireCapability("devices.inspect_drum_pad_chains");
    const validated = inspectDrumPadChainsParamsSchema.parse(params);
    return inspectDrumPadChainsResultSchema.parse(
      await this.#request("devices.inspect_drum_pad_chains", validated),
    );
  }

  public async inspectDrumPadChainDevices(
    params: InspectDrumPadChainDevicesParams,
  ): Promise<InspectDrumPadChainDevicesResult> {
    this.#requireCapability("devices.inspect_drum_pad_chain_devices");
    const validated = inspectDrumPadChainDevicesParamsSchema.parse(params);
    return inspectDrumPadChainDevicesResultSchema.parse(
      await this.#request("devices.inspect_drum_pad_chain_devices", validated),
    );
  }

  public async setDeviceEnabled(
    params: SetDeviceEnabledParams,
  ): Promise<SetDeviceEnabledResult> {
    this.#requireCapability("devices.set_enabled");
    const validated = setDeviceEnabledParamsSchema.parse(params);
    return setDeviceEnabledResultSchema.parse(
      await this.#mutationRequest("devices.set_enabled", validated),
    );
  }

  public async setDeviceParameter(
    params: SetDeviceParameterParams,
  ): Promise<SetDeviceParameterResult> {
    this.#requireCapability("devices.set_parameter");
    const validated = setDeviceParameterParamsSchema.parse(params);
    return setDeviceParameterResultSchema.parse(
      await this.#mutationRequest("devices.set_parameter", validated),
    );
  }

  public async createMidiClip(
    params: CreateMidiClipParams,
  ): Promise<CreateMidiClipResult> {
    this.#requireCapability("clips.create_midi");
    const validated = createMidiClipParamsSchema.parse(params);
    return createMidiClipResultSchema.parse(
      await this.#mutationRequest("clips.create_midi", validated),
    );
  }

  public async inspectMidiNotes(
    params: InspectMidiNotesParams,
  ): Promise<InspectMidiNotesResult> {
    this.#requireCapability("clips.inspect_notes");
    const validated = inspectMidiNotesParamsSchema.parse(params);
    return inspectMidiNotesResultSchema.parse(
      await this.#request("clips.inspect_notes", validated),
    );
  }

  public async replaceMidiNotes(
    params: ReplaceMidiNotesParams,
  ): Promise<ReplaceMidiNotesResult> {
    this.#requireCapability("clips.replace_notes");
    const validated = replaceMidiNotesParamsSchema.parse(params);
    return replaceMidiNotesResultSchema.parse(
      await this.#mutationRequest("clips.replace_notes", validated),
    );
  }

  public async launchSessionClip(
    params: LaunchSessionClipParams,
  ): Promise<LaunchSessionClipResult> {
    this.#requireCapability("clips.launch");
    const validated = launchSessionClipParamsSchema.parse(params);
    return launchSessionClipResultSchema.parse(
      await this.#mutationRequest("clips.launch", validated),
    );
  }

  public async duplicateSessionClip(
    params: DuplicateSessionClipParams,
  ): Promise<DuplicateSessionClipResult> {
    this.#requireCapability("clips.duplicate");
    const validated = duplicateSessionClipParamsSchema.parse(params);
    return duplicateSessionClipResultSchema.parse(
      await this.#mutationRequest("clips.duplicate", validated),
    );
  }

  public async deleteSessionClip(
    params: DeleteSessionClipParams,
  ): Promise<DeleteSessionClipResult> {
    this.#requireCapability("clips.delete");
    const validated = deleteSessionClipParamsSchema.parse(params);
    return deleteSessionClipResultSchema.parse(
      await this.#mutationRequest("clips.delete", validated),
    );
  }

  public async setSessionClipProperties(
    params: SetSessionClipPropertiesParams,
  ): Promise<SetSessionClipPropertiesResult> {
    this.#requireCapability("clips.set_properties");
    const validated = setSessionClipPropertiesParamsSchema.parse(params);
    return setSessionClipPropertiesResultSchema.parse(
      await this.#mutationRequest("clips.set_properties", validated),
    );
  }

  public async createArrangementMidiClip(
    params: CreateArrangementMidiClipParams,
  ): Promise<CreateArrangementMidiClipResult> {
    this.#requireCapability("arrangement.create_midi_clip");
    const validated = createArrangementMidiClipParamsSchema.parse(params);
    return createArrangementMidiClipResultSchema.parse(
      await this.#mutationRequest("arrangement.create_midi_clip", validated),
    );
  }

  public async inspectArrangement(
    params: InspectArrangementParams,
  ): Promise<InspectArrangementResult> {
    this.#requireCapability("arrangement.inspect");
    const validated = inspectArrangementParamsSchema.parse(params);
    return inspectArrangementResultSchema.parse(
      await this.#request("arrangement.inspect", validated),
    );
  }

  public async inspectArrangementMidiNotes(
    params: InspectArrangementMidiNotesParams,
  ): Promise<InspectArrangementMidiNotesResult> {
    this.#requireCapability("arrangement.inspect_notes");
    const validated = inspectArrangementMidiNotesParamsSchema.parse(params);
    return inspectArrangementMidiNotesResultSchema.parse(
      await this.#request("arrangement.inspect_notes", validated),
    );
  }

  public async deleteArrangementClip(
    params: DeleteArrangementClipParams,
  ): Promise<DeleteArrangementClipResult> {
    this.#requireCapability("arrangement.delete_clip");
    const validated = deleteArrangementClipParamsSchema.parse(params);
    return deleteArrangementClipResultSchema.parse(
      await this.#mutationRequest("arrangement.delete_clip", validated),
    );
  }

  public async replaceArrangementMidiNotes(
    params: ReplaceArrangementMidiNotesParams,
  ): Promise<ReplaceArrangementMidiNotesResult> {
    this.#requireCapability("arrangement.replace_notes");
    const validated = replaceArrangementMidiNotesParamsSchema.parse(params);
    return replaceArrangementMidiNotesResultSchema.parse(
      await this.#mutationRequest("arrangement.replace_notes", validated),
    );
  }

  public async duplicateClipToArrangement(
    params: DuplicateClipToArrangementParams,
  ): Promise<DuplicateClipToArrangementResult> {
    this.#requireCapability("arrangement.duplicate_clip");
    const validated = duplicateClipToArrangementParamsSchema.parse(params);
    return duplicateClipToArrangementResultSchema.parse(
      await this.#mutationRequest("arrangement.duplicate_clip", validated),
    );
  }

  public async fillArrangementRegion(
    params: FillArrangementRegionParams,
  ): Promise<FillArrangementRegionResult> {
    this.#requireCapability("arrangement.fill_region");
    const validated = fillArrangementRegionParamsSchema.parse(params);
    return fillArrangementRegionResultSchema.parse(
      await this.#mutationRequest("arrangement.fill_region", validated),
    );
  }

  public async setArrangementClipProperties(
    params: SetArrangementClipPropertiesParams,
  ): Promise<SetArrangementClipPropertiesResult> {
    this.#requireCapability("arrangement.set_clip_properties");
    const validated = setArrangementClipPropertiesParamsSchema.parse(params);
    return setArrangementClipPropertiesResultSchema.parse(
      await this.#mutationRequest("arrangement.set_clip_properties", validated),
    );
  }

  async #requestLiveEventSubscription(
    params: SubscribeEventParams,
  ): Promise<SubscribeEventResult> {
    const startedAt = this.#now().getTime();
    const traceId = stableTelemetryId(
      `live-event-subscription:${params.eventId}`,
    );
    this.#record({
      name: "live-event.subscription.requested",
      source: "live-event-bridge",
      correlationId: params.eventId,
      liveSetId: params.liveSetId,
      liveEventId: params.eventId,
      trace: { traceId, spanId: traceId },
      attributes: { eventId: params.eventId, eventKind: params.kind },
    });
    try {
      const result = subscribeEventResultSchema.parse(
        await this.#request("events.subscribe", params),
      );
      const { initialState, ...subscription } = result;
      this.#liveEventSubscriptionStatuses.set(params.eventId, {
        eventId: params.eventId,
        status: "resolved",
        subscription,
        initialState,
      });
      this.#record({
        name: "live-event.subscription.resolved",
        source: "live-event-bridge",
        correlationId: params.eventId,
        liveSetId: params.liveSetId,
        liveEventId: params.eventId,
        outcome: "success",
        durationMs: this.#now().getTime() - startedAt,
        trace: {
          traceId,
          spanId: stableTelemetryId(`${traceId}:resolved`),
          parentSpanId: traceId,
        },
        attributes: { eventId: params.eventId, eventKind: params.kind },
      });
      return result;
    } catch (error) {
      const bridgeError =
        error instanceof AbletonBridgeError
          ? error
          : new AbletonBridgeError(
              "invalid_response",
              error instanceof Error ? error.message : String(error),
              false,
            );
      this.#liveEventSubscriptionStatuses.set(params.eventId, {
        eventId: params.eventId,
        status: "unresolved",
        error: {
          code: bridgeError.code,
          message: bridgeError.message,
          retryable: bridgeError.retryable,
        },
      });
      this.#record({
        name: "live-event.subscription.unresolved",
        source: "live-event-bridge",
        correlationId: params.eventId,
        liveSetId: params.liveSetId,
        liveEventId: params.eventId,
        level: "warn",
        outcome: "failure",
        durationMs: this.#now().getTime() - startedAt,
        trace: {
          traceId,
          spanId: stableTelemetryId(`${traceId}:unresolved`),
          parentSpanId: traceId,
        },
        attributes: {
          eventId: params.eventId,
          eventKind: params.kind,
          errorCode: bridgeError.code,
          retryable: bridgeError.retryable,
        },
      });
      throw error;
    }
  }

  async #replayLiveEventSubscriptions(): Promise<
    readonly LiveEventSubscriptionStatus[]
  > {
    if (this.#desiredLiveEventSubscriptions.size === 0) {
      return this.getLiveEventSubscriptionStatuses();
    }
    const startedAt = this.#now().getTime();
    this.#record({
      name: "live-event.subscription-replay.requested",
      source: "live-event-bridge",
      attributes: {
        subscriptionCount: this.#desiredLiveEventSubscriptions.size,
      },
    });
    try {
      const statuses = await this.reconcileLiveEventSubscriptions();
      this.#record({
        name: "live-event.subscription-replay.completed",
        source: "live-event-bridge",
        outcome: "success",
        durationMs: this.#now().getTime() - startedAt,
        attributes: {
          subscriptionCount: statuses.length,
          unresolvedCount: statuses.filter(
            ({ status }) => status === "unresolved",
          ).length,
        },
      });
      return statuses;
    } catch (error) {
      const bridgeError =
        error instanceof AbletonBridgeError
          ? error
          : new AbletonBridgeError(
              "reconciliation_failed",
              error instanceof Error ? error.message : String(error),
              true,
            );
      for (const eventId of this.#desiredLiveEventSubscriptions.keys()) {
        this.#liveEventSubscriptionStatuses.set(eventId, {
          eventId,
          status: "unresolved",
          error: {
            code: bridgeError.code,
            message: bridgeError.message,
            retryable: bridgeError.retryable,
          },
        });
      }
      const statuses = this.getLiveEventSubscriptionStatuses();
      this.#record({
        name: "live-event.subscription-replay.failed",
        source: "live-event-bridge",
        level: "warn",
        outcome: "failure",
        durationMs: this.#now().getTime() - startedAt,
        attributes: {
          subscriptionCount: statuses.length,
          errorCode: bridgeError.code,
          retryable: bridgeError.retryable,
        },
      });
      return statuses;
    }
  }

  #requireCapability(capability: string): void {
    if (!this.#capabilities?.capabilities[capability]) {
      throw new AbletonBridgeError(
        "unsupported_capability",
        `Ableton capability is unavailable: ${capability}`,
        false,
        { capability },
      );
    }
  }

  async #mutationRequest(
    command: string,
    params: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    return this.#request(command, params, false);
  }

  async #request(
    command: string,
    params: Readonly<Record<string, unknown>>,
    timeoutRetryable = true,
  ): Promise<unknown> {
    if (!this.#socket || this.#socket.destroyed) {
      throw new Error("Ableton bridge is not connected");
    }
    if (command !== "system.hello" && !this.#handshakeComplete) {
      throw new AbletonBridgeError(
        "connection_closed",
        "Ableton handshake is not complete",
        true,
      );
    }
    const requestId = randomUUID();
    const generation = this.#connectionGeneration;
    const correlationContext = currentCorrelationContext();
    const correlationId =
      correlationContext?.correlationId ?? currentCorrelationId();
    const liveSetId =
      correlationContext?.liveSetId ?? this.#capabilities?.liveSetId;
    const queuedAt = this.#now();
    const traceId = correlationContext?.traceId ?? requestId;
    const requestSpanId = stableTelemetryId(
      `${traceId}:bridge-request:${requestId}`,
    );
    const trace: TraceContext = {
      traceId,
      spanId: requestSpanId,
      ...(correlationContext?.parentSpanId === undefined
        ? traceId === requestSpanId
          ? {}
          : { parentSpanId: traceId }
        : { parentSpanId: correlationContext.parentSpanId }),
    };
    const linkage = {
      ...(correlationId === undefined ? {} : { correlationId }),
      ...(correlationContext?.causationId === undefined
        ? {}
        : { causationId: correlationContext.causationId }),
      ...(liveSetId === undefined ? {} : { liveSetId }),
      ...(correlationContext?.liveProjectId === undefined
        ? {}
        : { liveProjectId: correlationContext.liveProjectId }),
      ...(correlationContext?.sessionId === undefined
        ? {}
        : { sessionId: correlationContext.sessionId }),
      ...(correlationContext?.activeAgentId === undefined
        ? {}
        : { activeAgentId: correlationContext.activeAgentId }),
      ...(correlationContext?.liveEventId === undefined
        ? {}
        : { liveEventId: correlationContext.liveEventId }),
      ...(correlationContext?.outputId === undefined
        ? {}
        : { outputId: correlationContext.outputId }),
      ...(correlationContext?.toolName === undefined
        ? {}
        : { toolName: correlationContext.toolName }),
    };
    const timeoutClass = this.#timeoutClass(command);
    const timeoutMs =
      timeoutClass === "long"
        ? this.#longRequestTimeoutMs
        : this.#requestTimeoutMs;
    if (this.#requestQueueDepth >= this.#requestQueueLimit) {
      this.#record({
        name: "bridge.request.failed",
        source: "ableton-bridge",
        ...linkage,
        level: "warn",
        outcome: "failure",
        durationMs: 0,
        trace,
        occurredAt: queuedAt.toISOString(),
        attributes: {
          requestId,
          command,
          errorCode: "queue_full",
          queueDepth: this.#requestQueueDepth,
          queueLimit: this.#requestQueueLimit,
          timeoutClass,
          timeoutMs,
        },
      });
      throw new AbletonBridgeError(
        "queue_full",
        "Ableton bridge request queue is full",
        true,
        { command, queueLimit: this.#requestQueueLimit },
      );
    }
    const previous = this.#requestTail;
    let release: () => void = () => undefined;
    this.#requestTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#requestQueueDepth += 1;
    this.#record({
      name: "bridge.request.queued",
      source: "ableton-bridge",
      ...linkage,
      trace,
      occurredAt: queuedAt.toISOString(),
      attributes: {
        requestId,
        command,
        queueDepth: this.#requestQueueDepth,
        timeoutClass,
        timeoutMs,
        ...(correlationId === undefined ? {} : { correlationId }),
      },
    });

    try {
      await previous;
      const dispatchedAt = this.#now();
      const queueWaitMs = Math.max(
        0,
        dispatchedAt.getTime() - queuedAt.getTime(),
      );
      const socket = this.#socket;
      if (
        generation !== this.#connectionGeneration ||
        !socket ||
        socket.destroyed ||
        (command !== "system.hello" && !this.#handshakeComplete)
      ) {
        const cancelledAt = this.#now();
        this.#record({
          name: "bridge.request.cancelled",
          source: "ableton-bridge",
          ...linkage,
          level: "warn",
          outcome: "cancelled",
          durationMs: cancelledAt.getTime() - queuedAt.getTime(),
          trace,
          occurredAt: cancelledAt.toISOString(),
          attributes: {
            requestId,
            command,
            reason: "connection-changed-before-dispatch",
            queueWaitMs,
            timeoutClass,
            timeoutMs,
          },
        });
        throw new AbletonBridgeError(
          "connection_closed",
          "Queued Ableton request belongs to a closed connection",
          true,
          { command },
        );
      }
      const request: RequestEnvelope = {
        protocolVersion: PROTOCOL_VERSION,
        kind: "request",
        requestId,
        command,
        params: { ...params },
        ...(command === "system.hello" || this.#projectRevision === undefined
          ? {}
          : { projectRevision: this.#projectRevision }),
      };
      this.options.onRequest?.({
        requestId,
        command,
        params,
        requestedAt: dispatchedAt.toISOString(),
        ...(correlationId === undefined ? {} : { correlationId }),
      });
      this.#record({
        name: "bridge.request.dispatched",
        source: "ableton-bridge",
        ...linkage,
        trace,
        occurredAt: dispatchedAt.toISOString(),
        attributes: {
          requestId,
          command,
          queueWaitMs,
          timeoutClass,
          timeoutMs,
          ...(correlationId === undefined ? {} : { correlationId }),
        },
      });
      const response = new Promise<ResponseEnvelope>((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.#pending.delete(requestId);
          reject(
            new AbletonBridgeError(
              "operation_timeout",
              `Ableton request timed out: ${command}`,
              timeoutRetryable,
              { command, timeoutClass, timeoutMs },
            ),
          );
        }, timeoutMs);
        this.#pending.set(requestId, { resolve, reject, timeout });
      });
      socket.write(encodeFrame(request));
      let envelope: ResponseEnvelope;
      try {
        envelope = await response;
      } catch (error) {
        const receivedAt = this.#now();
        const executionDurationMs = Math.max(
          0,
          receivedAt.getTime() - dispatchedAt.getTime(),
        );
        const totalDurationMs = Math.max(
          0,
          receivedAt.getTime() - queuedAt.getTime(),
        );
        const errorCode =
          error instanceof AbletonBridgeError ? error.code : "request_failed";
        const cancelled =
          errorCode === "connection_closed" && !this.#desiredRunning;
        if (errorCode === "operation_timeout" && !timeoutRetryable) {
          this.#destroySocket();
          this.#setStatus({
            state: "error",
            code: errorCode,
            message: error instanceof Error ? error.message : String(error),
          });
        }
        this.options.onResponse?.({
          requestId,
          command,
          durationMs: totalDurationMs,
          receivedAt: receivedAt.toISOString(),
          ok: false,
          ...(correlationId === undefined ? {} : { correlationId }),
          error: {
            code: errorCode,
            message: error instanceof Error ? error.message : String(error),
            retryable:
              error instanceof AbletonBridgeError ? error.retryable : false,
          },
        });
        this.#record({
          name: cancelled
            ? "bridge.request.cancelled"
            : errorCode === "operation_timeout"
              ? "bridge.request.timed_out"
              : "bridge.request.failed",
          source: "ableton-bridge",
          ...linkage,
          level: "warn",
          outcome: cancelled ? "cancelled" : "failure",
          durationMs: totalDurationMs,
          trace,
          occurredAt: receivedAt.toISOString(),
          attributes: {
            requestId,
            command,
            errorCode,
            queueWaitMs,
            executionDurationMs,
            totalDurationMs,
            timeoutClass,
            timeoutMs,
            ...(correlationId === undefined ? {} : { correlationId }),
          },
        });
        throw error;
      }
      const receivedAt = this.#now();
      const executionDurationMs = Math.max(
        0,
        receivedAt.getTime() - dispatchedAt.getTime(),
      );
      const totalDurationMs = Math.max(
        0,
        receivedAt.getTime() - queuedAt.getTime(),
      );
      if (!envelope.ok) {
        this.options.onResponse?.({
          requestId,
          command,
          durationMs: totalDurationMs,
          receivedAt: receivedAt.toISOString(),
          ok: false,
          ...(correlationId === undefined ? {} : { correlationId }),
          error: envelope.error,
        });
        this.#record({
          name: "bridge.request.failed",
          source: "ableton-bridge",
          ...linkage,
          level: "warn",
          outcome: "failure",
          durationMs: totalDurationMs,
          trace,
          occurredAt: receivedAt.toISOString(),
          attributes: {
            requestId,
            command,
            errorCode: envelope.error.code,
            queueWaitMs,
            executionDurationMs,
            totalDurationMs,
            timeoutClass,
            timeoutMs,
            ...(correlationId === undefined ? {} : { correlationId }),
          },
        });
        throw new AbletonBridgeError(
          envelope.error.code,
          envelope.error.message,
          envelope.error.retryable,
          envelope.error.details,
        );
      }
      if (envelope.projectRevision !== undefined) {
        this.#projectRevision = envelope.projectRevision;
      }
      if (this.#commandMutates(command)) {
        this.options.events.publish({
          type: "ableton.project_mutated",
          command,
          requestId,
          ...(correlationId === undefined ? {} : { correlationId }),
          ...(envelope.projectRevision === undefined
            ? {}
            : { projectRevision: envelope.projectRevision }),
        });
      }
      this.options.onResponse?.({
        requestId,
        command,
        durationMs: totalDurationMs,
        receivedAt: receivedAt.toISOString(),
        ok: true,
        result: envelope.result,
        ...(correlationId === undefined ? {} : { correlationId }),
      });
      this.#record({
        name: "bridge.request.completed",
        source: "ableton-bridge",
        ...linkage,
        outcome: "success",
        durationMs: totalDurationMs,
        trace,
        occurredAt: receivedAt.toISOString(),
        attributes: {
          requestId,
          command,
          queueWaitMs,
          executionDurationMs,
          totalDurationMs,
          timeoutClass,
          timeoutMs,
          ...(correlationId === undefined ? {} : { correlationId }),
        },
      });
      return envelope.result;
    } finally {
      this.#requestQueueDepth -= 1;
      release();
    }
  }

  #timeoutClass(command: string): TimeoutClass {
    if (!Object.prototype.hasOwnProperty.call(commandCatalog, command)) {
      return "normal";
    }
    return commandCatalog[command as keyof typeof commandCatalog].timeoutClass;
  }

  #commandMutates(command: string): boolean {
    if (!Object.prototype.hasOwnProperty.call(commandCatalog, command)) {
      return false;
    }
    return commandCatalog[command as keyof typeof commandCatalog].mutates;
  }

  async #connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection({ host: this.#host, port: this.#port });
      this.#socket = socket;
      const onInitialError = (error: Error) => {
        socket.off("connect", onConnect);
        reject(error);
      };
      const onConnect = () => {
        socket.off("error", onInitialError);
        this.#bindSocket(socket);
        resolve();
      };
      socket.once("error", onInitialError);
      socket.once("connect", onConnect);
    });
  }

  #bindSocket(socket: Socket): void {
    socket.on("data", (chunk) => {
      if (this.#socket !== socket) return;
      try {
        for (const message of this.#decoder.push(chunk)) {
          this.#handleMessage(message);
        }
      } catch (error) {
        this.#failConnection(error);
      }
    });
    socket.on("error", (error) => this.#failConnection(error));
    socket.on("close", () => {
      if (this.#socket === socket) {
        this.#socket = undefined;
        this.#invalidateConnection(
          new AbletonBridgeError(
            "connection_closed",
            "Ableton bridge connection closed",
            true,
          ),
        );
        if (this.#status.state === "connected") {
          this.#setStatus({
            state: "error",
            code: "connection_closed",
            message: "Ableton bridge connection closed",
          });
        }
        this.#scheduleReconnect();
      }
    });
  }

  #handleMessage(message: MessageEnvelope): void {
    if (message.kind === "event") {
      this.#handleEvent(message);
      return;
    }
    if (message.kind !== "response") {
      return;
    }
    const pending = this.#pending.get(message.requestId);
    if (!pending) {
      const traceId = message.requestId;
      this.#record({
        name: "bridge.response.skipped",
        source: "ableton-bridge",
        level: "warn",
        outcome: "unknown",
        trace: { traceId, spanId: traceId },
        attributes: {
          requestId: message.requestId,
          reason: "no-pending-request",
        },
      });
      return;
    }
    clearTimeout(pending.timeout);
    this.#pending.delete(message.requestId);
    pending.resolve(message);
  }

  #handleEvent(message: EventEnvelope): void {
    const receivedAt = this.#now();
    const expected =
      this.#lastEventSequence === undefined
        ? message.sequence
        : this.#lastEventSequence + 1;
    if (message.sequence !== expected) {
      this.options.events.publish({
        type: "ableton.event_gap",
        expectedSequence: expected,
        receivedSequence: message.sequence,
      });
      this.#publishReconciliation({
        reason: "sequence-gap",
        expectedSequence: expected,
        receivedSequence: message.sequence,
      });
      const gapTraceId = stableTelemetryId(
        `bridge-event-gap:${expected}:${message.sequence}`,
      );
      this.#record({
        name: "bridge.event.gap",
        source: "ableton-bridge",
        level: "warn",
        outcome: "failure",
        trace: { traceId: gapTraceId, spanId: gapTraceId },
        occurredAt: receivedAt.toISOString(),
        attributes: {
          expectedSequence: expected,
          receivedSequence: message.sequence,
        },
      });
    }
    this.#lastEventSequence = message.sequence;
    if (message.projectRevision !== undefined) {
      this.#projectRevision = message.projectRevision;
    }
    let liveEvent: AbletonLiveEvent | undefined;
    let liveSetSaveEvent: AbletonLiveSetSaveEvent | undefined;
    if (
      message.event === "live_event.occurred" ||
      message.event === "live_event.invalidated"
    ) {
      const envelope = liveEventEnvelopeSchema.parse(message);
      liveEvent = {
        event: envelope.event,
        sequence: envelope.sequence,
        payload: envelope.payload,
        receivedAt: receivedAt.toISOString(),
        ...(envelope.projectRevision === undefined
          ? {}
          : { projectRevision: envelope.projectRevision }),
      } as AbletonLiveEvent;
      if (envelope.event === "live_event.invalidated") {
        this.#liveEventSubscriptionStatuses.set(envelope.payload.eventId, {
          eventId: envelope.payload.eventId,
          status: "invalidated",
          invalidation: envelope.payload,
        });
      }
    }
    if (message.event === "live_set.save_observed") {
      const envelope = liveSetSaveObservedEnvelopeSchema.parse(message);
      liveSetSaveEvent = {
        event: envelope.event,
        sequence: envelope.sequence,
        payload: envelope.payload,
        receivedAt: receivedAt.toISOString(),
        ...(envelope.projectRevision === undefined
          ? {}
          : { projectRevision: envelope.projectRevision }),
      };
    }
    const event: AbletonBridgeEvent = {
      event: message.event,
      sequence: message.sequence,
      payload:
        liveEvent?.payload ?? liveSetSaveEvent?.payload ?? message.payload,
      receivedAt: receivedAt.toISOString(),
      ...(message.projectRevision === undefined
        ? {}
        : { projectRevision: message.projectRevision }),
    };
    this.options.events.publish({
      type: "ableton.event_received",
      ...event,
    });
    const traceId =
      liveEvent?.event === "live_event.occurred"
        ? liveEvent.payload.occurrenceId
        : stableTelemetryId(
            `bridge-event:${message.event}:${message.sequence}`,
          );
    this.#record({
      name: "bridge.event.received",
      source: "ableton-bridge",
      ...(this.#capabilities?.liveSetId === undefined
        ? {}
        : { liveSetId: this.#capabilities.liveSetId }),
      ...(liveEvent?.event === "live_event.occurred"
        ? { correlationId: liveEvent.payload.occurrenceId }
        : {}),
      ...(liveEvent === undefined
        ? {}
        : { liveEventId: liveEvent.payload.eventId }),
      outcome: "success",
      trace: { traceId, spanId: traceId },
      occurredAt: receivedAt.toISOString(),
      attributes: {
        eventName: message.event,
        sequence: message.sequence,
        ...(message.projectRevision === undefined
          ? {}
          : { projectRevision: message.projectRevision }),
      },
    });
    for (const listener of this.#eventListeners) listener(event);
    if (liveSetSaveEvent !== undefined) {
      for (const listener of this.#liveSetSaveListeners) {
        listener(liveSetSaveEvent);
      }
    }
    if (liveEvent !== undefined) {
      this.#record({
        name:
          liveEvent.event === "live_event.invalidated"
            ? "live-event.invalidated"
            : "live-event.received",
        source: "live-event-bridge",
        ...(this.#capabilities?.liveSetId === undefined
          ? {}
          : { liveSetId: this.#capabilities.liveSetId }),
        ...(liveEvent.event === "live_event.occurred"
          ? { correlationId: liveEvent.payload.occurrenceId }
          : {}),
        liveEventId: liveEvent.payload.eventId,
        level: liveEvent.event === "live_event.invalidated" ? "warn" : "info",
        outcome:
          liveEvent.event === "live_event.invalidated"
            ? "cancelled"
            : "success",
        trace: { traceId, spanId: traceId },
        occurredAt: receivedAt.toISOString(),
        attributes: {
          eventId: liveEvent.payload.eventId,
          eventName: liveEvent.event,
          sequence: liveEvent.sequence,
        },
      });
      for (const listener of this.#liveEventListeners) listener(liveEvent);
      this.#record({
        name: "live-event.listener-fanout.completed",
        source: "live-event-bridge",
        ...(this.#capabilities?.liveSetId === undefined
          ? {}
          : { liveSetId: this.#capabilities.liveSetId }),
        ...(liveEvent.event === "live_event.occurred"
          ? { correlationId: liveEvent.payload.occurrenceId }
          : {}),
        liveEventId: liveEvent.payload.eventId,
        outcome: "success",
        trace: {
          traceId,
          spanId: stableTelemetryId(`${traceId}:bridge-listener-fanout`),
          parentSpanId: traceId,
        },
        attributes: {
          eventId: liveEvent.payload.eventId,
          listenerCount: this.#liveEventListeners.size,
        },
      });
    }
  }

  #publishReconciliation(signal: LiveEventReconciliationSignal): void {
    const traceId = stableTelemetryId(
      signal.reason === "sequence-gap"
        ? `live-event-reconciliation:${signal.expectedSequence}:${signal.receivedSequence}`
        : `live-event-reconciliation:reconnect:${this.#connectionGeneration}`,
    );
    this.#record({
      name: "live-event.reconciliation.published",
      source: "live-event-bridge",
      level: signal.reason === "sequence-gap" ? "warn" : "info",
      trace: { traceId, spanId: traceId },
      attributes: {
        reason: signal.reason,
        listenerCount: this.#reconciliationListeners.size,
        ...(signal.reason === "sequence-gap"
          ? {
              expectedSequence: signal.expectedSequence,
              receivedSequence: signal.receivedSequence,
            }
          : { subscriptionCount: signal.subscriptions.length }),
      },
    });
    for (const listener of this.#reconciliationListeners) listener(signal);
  }

  #failConnection(error: unknown): void {
    const failure = error instanceof Error ? error : new Error(String(error));
    this.#rejectPending(failure);
    this.#destroySocket();
    this.#setStatus({
      state: "error",
      code: "connection_error",
      message: failure.message,
    });
    this.#scheduleReconnect();
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #destroySocket(): void {
    const socket = this.#socket;
    this.#socket = undefined;
    socket?.destroy();
    this.#invalidateConnection(
      new AbletonBridgeError(
        "connection_closed",
        "Ableton bridge stopped",
        true,
      ),
    );
  }

  #invalidateConnection(error: Error): void {
    this.#connectionGeneration += 1;
    this.#handshakeComplete = false;
    this.#capabilities = undefined;
    this.#lastEventSequence = undefined;
    this.#projectRevision = undefined;
    this.#decoder.reset();
    this.#rejectPending(error);
  }

  #setStatus(status: ConnectionStatus): void {
    this.#status = status;
    this.options.events.publish({
      type: "ableton.connection_changed",
      status,
    });
  }

  #now(): Date {
    return this.options.now?.() ?? new Date();
  }

  #record(input: BridgeTelemetryInput): void {
    const recorder = this.options.telemetry;
    if (recorder === undefined) return;
    const event: TelemetryEventEnvelope = {
      version: 2,
      id: randomUUID(),
      occurredAt: input.occurredAt ?? this.#now().toISOString(),
      name: input.name,
      source: input.source,
      level: input.level ?? "info",
      ...(input.outcome === undefined ? {} : { outcome: input.outcome }),
      ...(input.durationMs === undefined
        ? {}
        : { durationMs: Math.max(0, input.durationMs) }),
      ...(input.correlationId === undefined
        ? {}
        : { correlationId: input.correlationId }),
      ...(input.causationId === undefined
        ? {}
        : { causationId: input.causationId }),
      ...(input.liveSetId === undefined ? {} : { liveSetId: input.liveSetId }),
      ...(input.liveProjectId === undefined
        ? {}
        : { liveProjectId: input.liveProjectId }),
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(input.activeAgentId === undefined
        ? {}
        : { activeAgentId: input.activeAgentId }),
      ...(input.liveEventId === undefined
        ? {}
        : { liveEventId: input.liveEventId }),
      ...(input.outputId === undefined ? {} : { outputId: input.outputId }),
      ...(input.toolName === undefined ? {} : { toolName: input.toolName }),
      ...(input.trace === undefined ? {} : { trace: input.trace }),
      attributes: input.attributes ?? {},
    };
    try {
      recorder.enqueue(event);
    } catch {
      // Observability cannot delay or fail bridge socket processing.
    }
  }

  #scheduleReconnect(): void {
    if (
      !this.#desiredRunning ||
      this.#handshakeComplete ||
      this.#connectPromise !== undefined ||
      this.#reconnectTimer !== undefined ||
      this.#reconnectAttempt >= this.#reconnect.maxAttempts
    ) {
      return;
    }
    const attempt = this.#reconnectAttempt++;
    const base = Math.min(
      this.#reconnect.maxDelayMs,
      this.#reconnect.initialDelayMs * 2 ** attempt,
    );
    const spread = base * this.#reconnect.jitterRatio;
    const delay = Math.max(
      0,
      Math.round(base - spread + this.#random() * spread * 2),
    );
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      void this.#ensureConnected();
    }, delay);
  }
}
