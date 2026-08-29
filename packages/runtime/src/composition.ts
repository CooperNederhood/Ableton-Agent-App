import type { AbletonService } from "@ableton-agent/ableton-contracts";
import {
  CopilotAgentService,
  HeadlessApplication,
  type AgentSessionConfiguration,
  type AgentService,
  type CopilotAgentServiceOptions,
} from "@ableton-agent/application";
import { AbletonBridgeService } from "@ableton-agent/bridge";
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
    typeof candidate.subscribeLiveEvent === "function" &&
    typeof candidate.unsubscribeLiveEvent === "function" &&
    typeof candidate.subscribeLiveEvents === "function" &&
    typeof candidate.subscribeLiveEventReconciliation === "function" &&
    typeof candidate.reconcileLiveEventSubscriptions === "function"
  );
}

class UnavailableLiveEventBridge implements LiveEventBridge {
  public constructor(private readonly ableton: AbletonService) {}
  public inspectSession() {
    return this.ableton.inspectSession();
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
    : createAbletonService(options.ableton, events, logger);
  const agentSettings = options.agent ?? {};
  const signalSecret = options.signal?.secret ?? options.ableton.token;
  const signals = new DefaultSignalRuntime({
    ...(options.signal ?? {}),
    ...(signalSecret === undefined ? {} : { secret: signalSecret }),
    logger,
  });
  const liveEvents = new DefaultLiveEventRuntime({
    ...(options.liveEvents ?? {}),
    bridge: isLiveEventBridge(ableton)
      ? ableton
      : new UnavailableLiveEventBridge(ableton),
    logger,
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
