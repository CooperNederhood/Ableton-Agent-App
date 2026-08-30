import { randomUUID } from "node:crypto";

import type { AbletonService } from "@ableton-agent/ableton-contracts";
import {
  CopilotAgentService,
  HeadlessApplication,
  type AgentRuntimeEvent,
  type AgentRuntimeObserver,
  type AgentSessionConfiguration,
  type AgentService,
  type CopilotAgentServiceOptions,
} from "@ableton-agent/application";
import { AbletonBridgeService } from "@ableton-agent/bridge";
import {
  registerCorrelationContext,
  unregisterCorrelationContext,
} from "@ableton-agent/correlation";
import {
  telemetryIdSchema,
  telemetryEntityIdSchema,
  sanitizeTelemetryAttributes,
  type ConfigurationSnapshot,
  type NonBlockingObservabilityRecorder,
  type SanitizedAttributes,
} from "@ableton-agent/observability";
import {
  recordSignalTelemetry,
  stableTelemetryId,
} from "@ableton-agent/signal-routing";
import {
  InMemoryEventPublisher,
  noopLogger,
  type EventPublisher,
  type Logger,
} from "@ableton-agent/shared";
import type { ToolApprovalRequester } from "@ableton-agent/tools";

import {
  CONFIGURATION_MISSING_MESSAGE,
  UnconfiguredAbletonService,
} from "./unconfigured-ableton-service.js";
import {
  DefaultSignalRuntime,
  type SignalRuntime,
  type SignalRuntimeOptions,
} from "./signal-runtime.js";
import {
  DefaultLiveEventRuntime,
  type LiveEventBridge,
  type LiveEventRuntime,
  type LiveEventRuntimeOptions,
} from "./live-event-runtime.js";

export const DEFAULT_ABLETON_PORT = 8765;
export const TOKEN_ENVIRONMENT_VARIABLE = "ABLETON_AGENT_TOKEN";
export const PORT_ENVIRONMENT_VARIABLE = "ABLETON_AGENT_PORT";
export const MODEL_ENVIRONMENT_VARIABLE = "ABLETON_AGENT_MODEL";

function runtimeEventAttributes(event: AgentRuntimeEvent): SanitizedAttributes {
  return sanitizeTelemetryAttributes({
    runtimeEventType: event.type,
    ...(event.agentInstanceId === undefined
      ? {}
      : { agentInstanceId: event.agentInstanceId }),
    ...(event.trace === undefined
      ? {}
      : {
          turnId: event.trace.turnId,
          occurrenceCount: event.trace.occurrenceIds.length,
          deliveryCount: event.trace.deliveryIds.length,
        }),
    ...(event.sessionId === undefined ? {} : { sdkSessionId: event.sessionId }),
    data: event.data,
  });
}

function runtimeEventOutcome(
  type: string,
): "success" | "failure" | "cancelled" | undefined {
  if (type.endsWith(".failed") || type.endsWith(".timeout")) return "failure";
  if (type.endsWith(".cancelled") || type.endsWith(".aborted"))
    return "cancelled";
  if (type.endsWith(".completed") || type.endsWith(".final")) return "success";
  return undefined;
}

function normalizedEntityId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return telemetryEntityIdSchema.safeParse(value).success
    ? value
    : stableTelemetryId(`telemetry-entity:${value}`);
}

function createRuntimeObserver(
  recorder: NonBlockingObservabilityRecorder | undefined,
  currentProjectId?: () => string | undefined,
): AgentRuntimeObserver | undefined {
  if (recorder === undefined) return undefined;
  const toolNames = new Map<string, string>();
  const turnOrigins = new Map<string, string>();
  return {
    enqueue: (event) => {
      const upstreamTraceId = event.trace?.traceId;
      const traceId =
        upstreamTraceId !== undefined &&
        telemetryIdSchema.safeParse(upstreamTraceId).success
          ? upstreamTraceId
          : stableTelemetryId(
              `agent-runtime:${upstreamTraceId ?? event.trace?.turnId ?? event.type}`,
            );
      const turnId = event.trace?.turnId;
      const turnSpanId = stableTelemetryId(
        `${traceId}:agent-turn:${turnId ?? event.type}`,
      );
      const deliveryId = event.trace?.deliveryIds[0];
      const deliverySpanId =
        deliveryId === undefined ? undefined : stableTelemetryId(deliveryId);
      const toolCallId =
        typeof event.data.toolCallId === "string"
          ? event.data.toolCallId
          : undefined;
      const observedToolName =
        typeof event.data.toolName === "string"
          ? event.data.toolName
          : undefined;
      if (toolCallId !== undefined && observedToolName !== undefined) {
        toolNames.set(toolCallId, observedToolName);
      }
      const toolName =
        observedToolName ??
        (toolCallId === undefined ? undefined : toolNames.get(toolCallId));
      const isToolEvent = event.type.startsWith("agent.tool.");
      const isTurnEvent = event.type.startsWith("agent.turn.");
      const isAssistantEvent = event.type.startsWith("agent.assistant.");
      const spanId = isToolEvent
        ? stableTelemetryId(`${traceId}:agent-tool:${toolCallId ?? event.type}`)
        : isTurnEvent
          ? turnSpanId
          : isAssistantEvent
            ? stableTelemetryId(
                `${traceId}:agent-assistant:${turnId ?? "none"}`,
              )
            : stableTelemetryId(
                `${traceId}:agent-event:${turnId ?? "none"}:${event.type}`,
              );
      const parentSpanId = isToolEvent
        ? turnSpanId
        : isTurnEvent
          ? (deliverySpanId ?? traceId)
          : isAssistantEvent
            ? turnSpanId
            : traceId;
      const outcome = runtimeEventOutcome(event.type);
      const duration =
        typeof event.data.durationMs === "number" &&
        Number.isFinite(event.data.durationMs)
          ? Math.max(0, event.data.durationMs)
          : undefined;
      const sessionId = normalizedEntityId(event.sessionId);
      const occurrenceId = event.trace?.occurrenceIds[0];
      const origin =
        typeof event.data.origin === "string" ? event.data.origin : undefined;
      if (turnId !== undefined && origin !== undefined) {
        turnOrigins.set(turnId, origin);
      }
      const tracedOrigin =
        origin ?? (turnId === undefined ? undefined : turnOrigins.get(turnId));
      const correlationId = isToolEvent ? toolCallId : (occurrenceId ?? turnId);
      const causationId = isToolEvent
        ? turnId
        : isTurnEvent
          ? deliveryId
          : undefined;
      const activeAgentId = normalizedEntityId(event.agentInstanceId);
      const liveEventId =
        typeof event.data.eventId === "string" ? event.data.eventId : undefined;
      const outputId =
        tracedOrigin?.startsWith("output.") === true ? occurrenceId : undefined;
      let providedProjectId: string | undefined;
      try {
        providedProjectId = currentProjectId?.();
      } catch {
        // Project ownership enrichment must never disrupt agent event capture.
      }
      const projectId = normalizedEntityId(
        typeof event.data.projectId === "string"
          ? event.data.projectId
          : providedProjectId,
      );
      if (event.type === "agent.tool.started" && toolCallId !== undefined) {
        registerCorrelationContext({
          correlationId: toolCallId,
          traceId,
          parentSpanId: spanId,
          ...(turnId === undefined ? {} : { causationId: turnId }),
          ...(projectId === undefined ? {} : { projectId }),
          ...(sessionId === undefined ? {} : { sessionId }),
          ...(activeAgentId === undefined ? {} : { activeAgentId }),
          ...(liveEventId === undefined ? {} : { liveEventId }),
          ...(outputId === undefined ? {} : { outputId }),
          ...(toolName === undefined ? {} : { toolName }),
        });
      }
      recordSignalTelemetry(recorder, {
        name: event.type,
        source: "agent-runtime",
        level:
          outcome === "failure"
            ? "error"
            : event.type.endsWith(".delta") ||
                event.type.endsWith(".progress") ||
                event.type.endsWith(".partial")
              ? "debug"
              : "info",
        ...(outcome === undefined ? {} : { outcome }),
        ...(duration === undefined ? {} : { durationMs: duration }),
        ...(correlationId === undefined ? {} : { correlationId }),
        ...(causationId === undefined ? {} : { causationId }),
        ...(projectId === undefined ? {} : { projectId }),
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(activeAgentId === undefined ? {} : { activeAgentId }),
        ...(liveEventId === undefined ? {} : { liveEventId }),
        ...(outputId === undefined ? {} : { outputId }),
        ...(toolName === undefined ? {} : { toolName }),
        occurredAt: event.occurredAt,
        trace: {
          traceId,
          spanId,
          ...(parentSpanId === spanId ? {} : { parentSpanId }),
        },
        attributes: runtimeEventAttributes(event),
      });
      if (
        (event.type === "agent.tool.completed" ||
          event.type === "agent.tool.failed") &&
        toolCallId !== undefined
      ) {
        unregisterCorrelationContext(toolCallId);
        toolNames.delete(toolCallId);
      }
      if (
        (event.type === "agent.turn.completed" ||
          event.type === "agent.turn.failed" ||
          event.type === "agent.turn.cancelled" ||
          event.type === "agent.turn.aborted") &&
        turnId !== undefined
      ) {
        turnOrigins.delete(turnId);
      }
      if (
        event.type === "agent.session.configuration" &&
        recorder.enqueueConfigurationSnapshot !== undefined
      ) {
        const snapshot: ConfigurationSnapshot = {
          version: 1,
          id: randomUUID(),
          capturedAt: event.occurredAt,
          component: "agent-runtime",
          configurationVersion: "runtime-observer-v1",
          ...(projectId === undefined ? {} : { projectId }),
          ...(sessionId === undefined ? {} : { sessionId }),
          ...(activeAgentId === undefined ? {} : { activeAgentId }),
          values: runtimeEventAttributes(event),
        };
        try {
          recorder.enqueueConfigurationSnapshot(snapshot);
        } catch {
          // Configuration capture must not disrupt agent session startup.
        }
      }
    },
  };
}

/** Raised when supplied configuration cannot produce a usable runtime. */
export class RuntimeConfigurationError extends Error {
  public readonly code = "configuration_invalid";
}

export interface AbletonBridgeSettings {
  /** Shared secret expected by the Remote Script; absent disables the bridge. */
  token?: string | undefined;
  port: number;
  /** Client-specific explanation shown while no token is configured. */
  unconfiguredMessage?: string | undefined;
}

export interface AgentSettings {
  model?: string | undefined;
  reasoningEffort?: "low" | "medium" | "high" | undefined;
  baseDirectory?: string | undefined;
  turnTimeoutMs?: number | undefined;
  /** Replaces the Copilot client; used by tests and fakes. */
  clientFactory?: CopilotAgentServiceOptions["clientFactory"];
}

export interface AgentRuntimeOptions {
  ableton: AbletonBridgeSettings;
  agent?: AgentSettings;
  events?: EventPublisher;
  logger?: Logger;
  requestToolApproval?: ToolApprovalRequester;
  askForReadApproval?: boolean | (() => boolean);
  /** Replaces the bridge, used by tests and fakes. */
  abletonService?: AbletonService;
  signal?: SignalRuntimeOptions;
  liveEvents?: Omit<LiveEventRuntimeOptions, "bridge" | "logger">;
  /** Non-blocking observability sink shared by bridge and event runtimes. */
  telemetry?: NonBlockingObservabilityRecorder;
  /** Synchronous cached project identity; must not inspect Live on invocation. */
  currentProjectId?: () => string | undefined;
}

export interface AgentRuntime {
  application: HeadlessApplication;
  ableton: AbletonService;
  agent: AgentService;
  events: EventPublisher;
  logger: Logger;
  /** False when no token was configured and the bridge is a typed stand-in. */
  abletonConfigured: boolean;
  signals: SignalRuntime;
  liveEvents: LiveEventRuntime;
}

class RuntimeAwareHeadlessApplication extends HeadlessApplication {
  readonly #managedAgentInstanceIds = new Set<string>();

  public constructor(
    services: ConstructorParameters<typeof HeadlessApplication>[0],
    private readonly signals: SignalRuntime,
    private readonly liveEvents: LiveEventRuntime,
  ) {
    super(services);
  }

  async #syncSignals(): Promise<void> {
    const activeAgentInstanceIds = [
      ...(this.agentSessionId === undefined ? [] : [this.agentSessionId]),
      ...this.#managedAgentInstanceIds,
    ];
    this.signals.setActiveAgentInstances(activeAgentInstanceIds);
    this.liveEvents.setActiveAgentInstances(activeAgentInstanceIds);
  }

  public override async start(
    options?: Parameters<HeadlessApplication["start"]>[0],
  ): Promise<void> {
    await super.start(options);
    await this.liveEvents.start();
    await this.#syncSignals();
  }

  public override async stop(): Promise<void> {
    try {
      await this.liveEvents.stop();
      await super.stop();
    } finally {
      this.#managedAgentInstanceIds.clear();
      await this.#syncSignals();
    }
  }

  public override async createAgentSession(): Promise<string> {
    const sessionId = await super.createAgentSession();
    await this.#syncSignals();
    return sessionId;
  }

  public override async resumeAgentSession(sessionId: string): Promise<void> {
    await super.resumeAgentSession(sessionId);
    await this.#syncSignals();
  }

  public override async createManagedAgent(
    configuration: AgentSessionConfiguration,
  ): Promise<string> {
    const sdkSessionId = await super.createManagedAgent(configuration);
    this.#managedAgentInstanceIds.add(configuration.instanceId);
    await this.#syncSignals();
    return sdkSessionId;
  }

  public override async resumeManagedAgent(
    configuration: AgentSessionConfiguration,
    sdkSessionId: string,
  ): Promise<void> {
    await super.resumeManagedAgent(configuration, sdkSessionId);
    this.#managedAgentInstanceIds.add(configuration.instanceId);
    await this.#syncSignals();
  }

  public override async reconfigureManagedAgent(
    configuration: AgentSessionConfiguration,
  ): Promise<void> {
    await super.reconfigureManagedAgent(configuration);
    await this.#syncSignals();
  }

  public override async deactivateManagedAgent(
    instanceId: string,
  ): Promise<void> {
    await super.deactivateManagedAgent(instanceId);
    this.#managedAgentInstanceIds.delete(instanceId);
    await this.#syncSignals();
  }
}

function isLiveEventBridge(
  value: AbletonService,
): value is AbletonService & LiveEventBridge {
  const candidate = value as Partial<LiveEventBridge>;
  return (
    typeof candidate.inspectEventSelection === "function" &&
    typeof candidate.subscribeLiveEvent === "function" &&
    typeof candidate.unsubscribeLiveEvent === "function" &&
    typeof candidate.subscribeLiveEvents === "function" &&
    typeof candidate.subscribeLiveEventReconciliation === "function" &&
    typeof candidate.reconcileLiveEventSubscriptions === "function"
  );
}

function isCurrentProjectProvider(
  value: AbletonService,
): value is AbletonService & { getCurrentProjectId(): string | undefined } {
  return (
    typeof (value as Partial<{ getCurrentProjectId(): string | undefined }>)
      .getCurrentProjectId === "function"
  );
}

class UnavailableLiveEventBridge implements LiveEventBridge {
  public constructor(private readonly ableton: AbletonService) {}
  public inspectSession() {
    return this.ableton.inspectSession();
  }
  public async inspectEventSelection(): Promise<never> {
    throw new Error("Configured Ableton service does not support Live events");
  }
  public inspectDevices(
    params: Parameters<AbletonService["inspectDevices"]>[0],
  ) {
    return this.ableton.inspectDevices(params);
  }
  public inspectDeviceParameters(
    params: Parameters<AbletonService["inspectDeviceParameters"]>[0],
  ) {
    return this.ableton.inspectDeviceParameters(params);
  }
  public async subscribeLiveEvent(): Promise<never> {
    throw new Error("Configured Ableton service does not support Live events");
  }
  public async unsubscribeLiveEvent(): Promise<never> {
    throw new Error("Configured Ableton service does not support Live events");
  }
  public async reconcileLiveEventSubscriptions() {
    return [];
  }
  public subscribeLiveEvents(): () => void {
    return () => undefined;
  }
  public subscribeLiveEventReconciliation(): () => void {
    return () => undefined;
  }
}

/**
 * Parses an Ableton bridge port from configuration text.
 *
 * @throws RuntimeConfigurationError when the value is not a valid TCP port.
 */
export function parseAbletonPort(value: string | undefined): number {
  if (value === undefined || value === "") {
    return DEFAULT_ABLETON_PORT;
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new RuntimeConfigurationError(
      `${PORT_ENVIRONMENT_VARIABLE} must be an integer from 1 to 65535`,
    );
  }
  return port;
}

/** Reads bridge settings from a process environment. */
export function resolveAbletonSettingsFromEnvironment(
  environment: Readonly<Partial<Record<string, string>>>,
): AbletonBridgeSettings {
  const token = environment[TOKEN_ENVIRONMENT_VARIABLE];
  return {
    ...(token === undefined || token === "" ? {} : { token }),
    port: parseAbletonPort(environment[PORT_ENVIRONMENT_VARIABLE]),
  };
}

/** Reads agent settings from a process environment. */
export function resolveAgentSettingsFromEnvironment(
  environment: Readonly<Partial<Record<string, string>>>,
): AgentSettings {
  const model = environment[MODEL_ENVIRONMENT_VARIABLE];
  return model === undefined || model === "" ? {} : { model };
}

/**
 * Builds the Ableton service for a composition: the real framed TCP bridge
 * when a token is configured, otherwise a stand-in that reports the missing
 * configuration instead of failing opaquely.
 */
export function createAbletonService(
  settings: AbletonBridgeSettings,
  events: EventPublisher,
  logger: Logger = noopLogger,
  telemetry?: Pick<NonBlockingObservabilityRecorder, "enqueue">,
): { ableton: AbletonService; configured: boolean } {
  if (settings.token === undefined) {
    return {
      ableton: new UnconfiguredAbletonService(
        settings.unconfiguredMessage ?? CONFIGURATION_MISSING_MESSAGE,
      ),
      configured: false,
    };
  }
  try {
    return {
      ableton: new AbletonBridgeService({
        authenticationToken: settings.token,
        events,
        port: settings.port,
        eventSubscriptions: [
          "project.changed",
          "live_event.occurred",
          "live_event.invalidated",
        ],
        onRequest: ({ requestId, correlationId, command, params }) =>
          logger.debug("Ableton bridge request", {
            requestId,
            correlationId,
            command,
            params,
          }),
        onResponse: (response) =>
          response.ok
            ? logger.debug("Ableton bridge response", response)
            : logger.warn("Ableton bridge request failed", response),
        ...(telemetry === undefined ? {} : { telemetry }),
      }),
      configured: true,
    };
  } catch (error) {
    throw new RuntimeConfigurationError(
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * Composes the headless application used by every client: Ableton bridge,
 * Copilot agent, event publisher, and lifecycle. Clients supply transport and
 * presentation concerns only.
 */
export function createAgentRuntime(options: AgentRuntimeOptions): AgentRuntime {
  const events = options.events ?? new InMemoryEventPublisher();
  const logger = options.logger ?? noopLogger;
  const { ableton, configured } = options.abletonService
    ? { ableton: options.abletonService, configured: true }
    : createAbletonService(options.ableton, events, logger, options.telemetry);
  const agentSettings = options.agent ?? {};
  const runtimeObserver = createRuntimeObserver(
    options.telemetry,
    options.currentProjectId ??
      (isCurrentProjectProvider(ableton)
        ? () => ableton.getCurrentProjectId()
        : undefined),
  );
  const signalSecret = options.signal?.secret ?? options.ableton.token;
  const signals = new DefaultSignalRuntime({
    ...(options.signal ?? {}),
    ...(signalSecret === undefined ? {} : { secret: signalSecret }),
    logger,
    ...(options.telemetry === undefined
      ? {}
      : { telemetry: options.telemetry }),
  });
  const liveEvents = new DefaultLiveEventRuntime({
    ...(options.liveEvents ?? {}),
    bridge: isLiveEventBridge(ableton)
      ? ableton
      : new UnavailableLiveEventBridge(ableton),
    logger,
    ...(options.telemetry === undefined
      ? {}
      : { telemetry: options.telemetry }),
  });
  const agent = new CopilotAgentService({
    events,
    ...(agentSettings.model === undefined
      ? {}
      : { model: agentSettings.model }),
    ...(agentSettings.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: agentSettings.reasoningEffort }),
    ...(agentSettings.baseDirectory === undefined
      ? {}
      : { baseDirectory: agentSettings.baseDirectory }),
    ...(agentSettings.clientFactory === undefined
      ? {}
      : { clientFactory: agentSettings.clientFactory }),
    ...(agentSettings.turnTimeoutMs === undefined
      ? {}
      : { turnTimeoutMs: agentSettings.turnTimeoutMs }),
    ...(options.requestToolApproval === undefined
      ? {}
      : { requestToolApproval: options.requestToolApproval }),
    askForReadApproval: options.askForReadApproval ?? false,
    getAbletonStatus: () => ableton.getStatus(),
    inspectSession: () => ableton.inspectSession(),
    setTempo: (tempo) => ableton.setTempo(tempo),
    setPlaying: (isPlaying) => ableton.setPlaying(isPlaying),
    inspectArrangementTransport: (params) =>
      ableton.inspectArrangementTransport(params),
    setArrangementLoop: (params) => ableton.setArrangementLoop(params),
    createCuePoint: (params) => ableton.createCuePoint(params),
    deleteCuePoint: (params) => ableton.deleteCuePoint(params),
    createTrack: (params) => ableton.createTrack(params),
    deleteTrack: (params) => ableton.deleteTrack(params),
    renameTrack: (params) => ableton.renameTrack(params),
    setTrackMixer: (params) => ableton.setTrackMixer(params),
    inspectDevices: (params) => ableton.inspectDevices(params),
    inspectBrowserRoots: () => ableton.inspectBrowserRoots(),
    inspectBrowserChildren: (params) => ableton.inspectBrowserChildren(params),
    searchBrowser: (params) => ableton.searchBrowser(params),
    loadBrowserItem: (params) => ableton.loadBrowserItem(params),
    inspectDeviceParameters: (params) =>
      ableton.inspectDeviceParameters(params),
    inspectRackChains: (params) => ableton.inspectRackChains(params),
    inspectRackChainDevices: (params) =>
      ableton.inspectRackChainDevices(params),
    inspectDrumRackPads: (params) => ableton.inspectDrumRackPads(params),
    inspectDrumPadChains: (params) => ableton.inspectDrumPadChains(params),
    inspectDrumPadChainDevices: (params) =>
      ableton.inspectDrumPadChainDevices(params),
    setDeviceEnabled: (params) => ableton.setDeviceEnabled(params),
    setDeviceParameter: (params) => ableton.setDeviceParameter(params),
    createMidiClip: (params) => ableton.createMidiClip(params),
    replaceMidiNotes: (params) => ableton.replaceMidiNotes(params),
    launchSessionClip: (params) => ableton.launchSessionClip(params),
    duplicateSessionClip: (params) => ableton.duplicateSessionClip(params),
    deleteSessionClip: (params) => ableton.deleteSessionClip(params),
    setSessionClipProperties: (params) =>
      ableton.setSessionClipProperties(params),
    createArrangementMidiClip: (params) =>
      ableton.createArrangementMidiClip(params),
    inspectArrangement: (params) => ableton.inspectArrangement(params),
    deleteArrangementClip: (params) => ableton.deleteArrangementClip(params),
    replaceArrangementMidiNotes: (params) =>
      ableton.replaceArrangementMidiNotes(params),
    duplicateClipToArrangement: (params) =>
      ableton.duplicateClipToArrangement(params),
    setArrangementClipProperties: (params) =>
      ableton.setArrangementClipProperties(params),
    signalContext: { provider: signals.provider },
    liveEventContext: { provider: liveEvents.provider },
    ...(runtimeObserver === undefined ? {} : { runtimeObserver }),
    logger,
  });
  const application = new RuntimeAwareHeadlessApplication(
    {
      agent,
      ableton,
      events,
      logger,
    },
    signals,
    liveEvents,
  );
  signals.setDeliveryService(application);
  liveEvents.setDeliveryService(application);
  return {
    application,
    ableton,
    agent,
    events,
    logger,
    abletonConfigured: configured,
    signals,
    liveEvents,
  };
}
