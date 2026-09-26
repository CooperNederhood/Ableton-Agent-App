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
import type { AgentReasoningEffort } from "@ableton-agent/agent-config";
import { AbletonBridgeService } from "@ableton-agent/bridge";
import {
  registerCorrelationContext,
  unregisterCorrelationContext,
} from "@ableton-agent/correlation";
import {
  type AgentHistoryRecord,
  type AgentHistoryStore,
  telemetryIdSchema,
  telemetryEntityIdSchema,
  sanitizeTelemetryAttributes,
  type ConfigurationSnapshot,
  type NonBlockingObservabilityRecorder,
  type SanitizedAttributes,
} from "@ableton-agent/observability";
import type { LiveIdentity } from "@ableton-agent/protocol";
import {
  recordSignalTelemetry,
  stableTelemetryId,
} from "@ableton-agent/signal-routing";
import {
  InMemoryEventPublisher,
  noopLogger,
  type AgentReasoningSummary,
  type EventPublisher,
  type Logger,
} from "@ableton-agent/shared";
import type {
  SetHistoryQueryService,
  ToolApprovalRequester,
} from "@ableton-agent/tools";

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
import {
  DefaultLiveSetSaveRuntime,
  type LiveSetSaveBridge,
  type LiveSetSaveRuntime,
  type LiveSetSaveRuntimeOptions,
} from "./live-set-save-runtime.js";
import { PreparedProjectContextStore } from "./prepared-context.js";

export const DEFAULT_ABLETON_PORT = 8765;
export const TOKEN_ENVIRONMENT_VARIABLE = "ABLETON_AGENT_TOKEN";
export const PORT_ENVIRONMENT_VARIABLE = "ABLETON_AGENT_PORT";
export const MODEL_ENVIRONMENT_VARIABLE = "ABLETON_AGENT_MODEL";

function runtimeEventAttributes(
  event: AgentRuntimeEvent,
  includeData = true,
): SanitizedAttributes {
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
    ...(includeData ? { data: event.data } : {}),
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
  agentHistory: Pick<AgentHistoryStore, "appendAgentHistory"> | undefined,
  currentAppSessionId: (() => string | undefined) | undefined,
  currentLiveSetId?: () => string | undefined,
  currentLiveProjectId?: () => string | undefined,
  logger: Logger = noopLogger,
): AgentRuntimeObserver | undefined {
  if (recorder === undefined && agentHistory === undefined) return undefined;
  const toolNames = new Map<string, string>();
  const turnOrigins = new Map<string, string>();
  const persistAgentHistory = (record: AgentHistoryRecord): void => {
    if (agentHistory === undefined) return;
    try {
      const write = agentHistory.appendAgentHistory(record);
      void write.catch((error) => {
        logger.warn("Agent history projection failed", {
          kind: record.kind,
          id: record.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    } catch (error) {
      logger.warn("Agent history projection failed", {
        kind: record.kind,
        id: record.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
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
      const activeAgentId = normalizedEntityId(
        event.agentInstanceId ?? "default-agent",
      );
      const liveEventId =
        typeof event.data.eventId === "string" ? event.data.eventId : undefined;
      const outputId =
        tracedOrigin?.startsWith("output.") === true ? occurrenceId : undefined;
      let providedLiveSetId: string | undefined;
      let providedLiveProjectId: string | undefined;
      try {
        providedLiveSetId = currentLiveSetId?.();
        providedLiveProjectId = currentLiveProjectId?.();
      } catch {
        // Live ownership enrichment must never disrupt agent event capture.
      }
      const liveSetId = normalizedEntityId(
        typeof event.data.projectId === "string"
          ? event.data.projectId
          : providedLiveSetId,
      );
      const liveProjectId = normalizedEntityId(providedLiveProjectId);
      const appSessionId = normalizedEntityId(currentAppSessionId?.());
      const projectable =
        appSessionId !== undefined &&
        sessionId !== undefined &&
        activeAgentId !== undefined;
      const historyBase = projectable
        ? {
            version: 1 as const,
            appSessionId,
            traceId,
            ...(liveSetId === undefined ? {} : { liveSetId }),
            ...(liveProjectId === undefined ? {} : { liveProjectId }),
            ...(normalizedEntityId(correlationId) === undefined
              ? {}
              : { correlationId: normalizedEntityId(correlationId) }),
            ...(normalizedEntityId(causationId) === undefined
              ? {}
              : { causationId: normalizedEntityId(causationId) }),
          }
        : undefined;
      if (
        historyBase !== undefined &&
        sessionId !== undefined &&
        activeAgentId !== undefined &&
        event.type === "agent.session.configuration"
      ) {
        persistAgentHistory({
          ...historyBase,
          kind: "agent_session",
          id: stableTelemetryId(`agent-session:${sessionId}:${activeAgentId}`),
          agentSessionId: sessionId,
          sdkSessionId: sessionId,
          activeAgentId,
          occurredAt: event.occurredAt,
          status: "active",
          metadata: sanitizeTelemetryAttributes(event.data),
        });
      }
      const isTerminalTurn =
        event.type === "agent.turn.completed" ||
        event.type === "agent.turn.failed" ||
        event.type === "agent.turn.cancelled" ||
        event.type === "agent.turn.aborted";
      if (
        historyBase !== undefined &&
        sessionId !== undefined &&
        activeAgentId !== undefined &&
        isTerminalTurn &&
        turnId !== undefined
      ) {
        const prompt =
          typeof event.data.prompt === "string" ? event.data.prompt : undefined;
        const status =
          event.type === "agent.turn.completed"
            ? "completed"
            : event.type === "agent.turn.failed"
              ? "failed"
              : "cancelled";
        persistAgentHistory({
          ...historyBase,
          kind: "turn",
          id: stableTelemetryId(`agent-turn:${sessionId}:${turnId}`),
          agentSessionId: sessionId,
          turnId,
          activeAgentId,
          occurredAt:
            typeof event.data.queuedAt === "string"
              ? event.data.queuedAt
              : event.occurredAt,
          completedAt: event.occurredAt,
          status,
          ...(prompt === undefined ? {} : { prompt }),
          ...(duration === undefined ? {} : { durationMs: duration }),
          metadata: sanitizeTelemetryAttributes({
            origin: tracedOrigin,
            kind: event.data.kind,
            agentMode: event.data.agentMode,
            error: event.data.error,
          }),
        });
        if (prompt !== undefined) {
          persistAgentHistory({
            ...historyBase,
            kind: "message",
            id: stableTelemetryId(`agent-message:user:${sessionId}:${turnId}`),
            agentSessionId: sessionId,
            turnId,
            activeAgentId,
            occurredAt:
              typeof event.data.queuedAt === "string"
                ? event.data.queuedAt
                : event.occurredAt,
            role: "user",
            content: prompt,
            messageIndex: 0,
            metadata: sanitizeTelemetryAttributes({
              origin: tracedOrigin,
              agentMode: event.data.agentMode,
            }),
          });
        }
      }
      if (
        historyBase !== undefined &&
        sessionId !== undefined &&
        activeAgentId !== undefined &&
        event.type === "agent.assistant.final" &&
        turnId !== undefined &&
        typeof event.data.content === "string"
      ) {
        const sdkEventId =
          typeof event.data.sdkEventId === "string"
            ? event.data.sdkEventId
            : undefined;
        persistAgentHistory({
          ...historyBase,
          kind: "message",
          id:
            sdkEventId === undefined
              ? stableTelemetryId(
                  `agent-message:assistant:${sessionId}:${turnId}`,
                )
              : normalizedEntityId(sdkEventId)!,
          agentSessionId: sessionId,
          turnId,
          activeAgentId,
          occurredAt: event.occurredAt,
          role: "assistant",
          content: event.data.content,
          messageIndex: 1,
          metadata: sanitizeTelemetryAttributes({
            messageId: event.data.messageId,
            source: event.data.source,
          }),
        });
      }
      if (
        historyBase !== undefined &&
        sessionId !== undefined &&
        activeAgentId !== undefined &&
        (event.type === "agent.tool.completed" ||
          event.type === "agent.tool.failed") &&
        turnId !== undefined &&
        toolCallId !== undefined &&
        toolName !== undefined
      ) {
        const success = event.type === "agent.tool.completed";
        persistAgentHistory({
          ...historyBase,
          kind: "tool_call",
          id: stableTelemetryId(`agent-tool-call:${sessionId}:${toolCallId}`),
          agentSessionId: sessionId,
          turnId,
          toolCallId,
          activeAgentId,
          occurredAt: event.occurredAt,
          toolName,
          status: success ? "completed" : "failed",
          arguments: sanitizeTelemetryAttributes(
            typeof event.data.arguments === "object" &&
              event.data.arguments !== null &&
              !Array.isArray(event.data.arguments)
              ? (event.data.arguments as Readonly<Record<string, unknown>>)
              : {},
          ),
          metadata: sanitizeTelemetryAttributes({
            sdkEventId: event.data.sdkEventId,
            parentSdkEventId: event.data.parentSdkEventId,
          }),
        });
        persistAgentHistory({
          ...historyBase,
          kind: "tool_result",
          id: stableTelemetryId(`agent-tool-result:${sessionId}:${toolCallId}`),
          agentSessionId: sessionId,
          turnId,
          toolCallId,
          activeAgentId,
          occurredAt: event.occurredAt,
          outcome: success ? "success" : "failure",
          ...(duration === undefined ? {} : { durationMs: duration }),
          ...(success
            ? {
                result: sanitizeTelemetryAttributes({
                  result: event.data.result,
                }),
              }
            : {
                error:
                  typeof event.data.error === "string"
                    ? event.data.error
                    : JSON.stringify(event.data.error ?? "Tool failed"),
              }),
          metadata: sanitizeTelemetryAttributes({
            toolName,
            structuredFailure: event.data.structuredFailure,
          }),
        });
      }
      if (
        historyBase !== undefined &&
        sessionId !== undefined &&
        activeAgentId !== undefined &&
        event.type === "agent.permission.completed"
      ) {
        const permissionId =
          typeof event.data.permissionId === "string"
            ? event.data.permissionId
            : stableTelemetryId(
                `agent-approval:${sessionId}:${turnId ?? event.occurredAt}`,
              );
        const decision =
          typeof event.data.result === "object" &&
          event.data.result !== null &&
          "kind" in event.data.result &&
          typeof event.data.result.kind === "string"
            ? event.data.result.kind
            : "approved";
        persistAgentHistory({
          ...historyBase,
          kind: "approval",
          id: normalizedEntityId(permissionId)!,
          agentSessionId: sessionId,
          ...(turnId === undefined ? {} : { turnId }),
          ...(toolCallId === undefined ? {} : { toolCallId }),
          activeAgentId,
          occurredAt: event.occurredAt,
          resolvedAt: event.occurredAt,
          status: decision === "reject" ? "denied" : "approved",
          summary: `Tool permission ${decision}`,
          details: sanitizeTelemetryAttributes(event.data),
        });
      }
      if (event.type === "agent.tool.started" && toolCallId !== undefined) {
        registerCorrelationContext({
          correlationId: toolCallId,
          traceId,
          parentSpanId: spanId,
          ...(turnId === undefined ? {} : { causationId: turnId }),
          ...(liveSetId === undefined ? {} : { liveSetId }),
          ...(liveProjectId === undefined ? {} : { liveProjectId }),
          ...(sessionId === undefined ? {} : { sessionId }),
          ...(activeAgentId === undefined ? {} : { activeAgentId }),
          ...(liveEventId === undefined ? {} : { liveEventId }),
          ...(outputId === undefined ? {} : { outputId }),
          ...(toolName === undefined ? {} : { toolName }),
        });
      }
      if (recorder !== undefined)
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
          ...(liveSetId === undefined ? {} : { liveSetId }),
          ...(liveProjectId === undefined ? {} : { liveProjectId }),
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
          attributes: runtimeEventAttributes(
            event,
            !(
              event.type.startsWith("agent.turn.") ||
              event.type === "agent.assistant.final" ||
              event.type.startsWith("agent.tool.") ||
              event.type.startsWith("agent.permission.")
            ),
          ),
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
        recorder !== undefined &&
        recorder.enqueueConfigurationSnapshot !== undefined
      ) {
        const snapshot: ConfigurationSnapshot = {
          version: 2,
          id: randomUUID(),
          capturedAt: event.occurredAt,
          component: "agent-runtime",
          configurationVersion: "runtime-observer-v1",
          ...(liveSetId === undefined ? {} : { liveSetId }),
          ...(liveProjectId === undefined ? {} : { liveProjectId }),
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
  reasoningEffort?: AgentReasoningEffort | undefined;
  reasoningSummary?:
    AgentReasoningSummary | (() => AgentReasoningSummary) | undefined;
  baseDirectory?: string | undefined;
  resolvePlanArtifactPaths?: CopilotAgentServiceOptions["resolvePlanArtifactPaths"];
  turnTimeoutMs?: number | (() => number) | undefined;
  /** Replaces the Copilot client; used by tests and fakes. */
  clientFactory?: CopilotAgentServiceOptions["clientFactory"];
  resolveSkill?: CopilotAgentServiceOptions["resolveSkill"];
}

export interface AgentRuntimeOptions {
  ableton: AbletonBridgeSettings;
  agent?: AgentSettings;
  events?: EventPublisher;
  logger?: Logger;
  requestToolApproval?: ToolApprovalRequester;
  askForReadApproval?: boolean | (() => boolean);
  /** Read-only, application-owned query boundary for local Set History. */
  setHistoryQuery?: SetHistoryQueryService;
  /** Searchable application-owned projection of SDK agent history. */
  agentHistory?: Pick<AgentHistoryStore, "appendAgentHistory">;
  /** Synchronous active App-session attribution for agent history records. */
  currentAppSessionId?: () => string | undefined;
  /** Replaces the bridge, used by tests and fakes. */
  abletonService?: AbletonService;
  signal?: SignalRuntimeOptions;
  liveEvents?: Omit<LiveEventRuntimeOptions, "bridge" | "logger">;
  liveSetSaves?: Omit<LiveSetSaveRuntimeOptions, "bridge" | "logger">;
  /** Non-blocking observability sink shared by bridge and event runtimes. */
  telemetry?: NonBlockingObservabilityRecorder;
  /** Synchronous cached Live Set identity; must not inspect Live on invocation. */
  currentLiveSetId?: () => string | undefined;
  /** Optional synchronous Live Project grouping for the current Live Set. */
  currentLiveProjectId?: () => string | undefined;
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
  liveSetSaves: LiveSetSaveRuntime;
  preparedContext: PreparedProjectContextStore;
}

class RuntimeAwareHeadlessApplication extends HeadlessApplication {
  readonly #managedAgentInstanceIds = new Set<string>();

  public constructor(
    services: ConstructorParameters<typeof HeadlessApplication>[0],
    private readonly signals: SignalRuntime,
    private readonly liveEvents: LiveEventRuntime,
    private readonly liveSetSaves: LiveSetSaveRuntime,
    private readonly preparedContext: PreparedProjectContextStore,
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
    this.preparedContext.start();
    try {
      await super.start(options);
      await this.preparedContext.warm();
      await this.liveEvents.start();
      this.liveSetSaves.start();
      await this.#syncSignals();
    } catch (error) {
      this.preparedContext.stop();
      throw error;
    }
  }

  public override async stop(): Promise<void> {
    try {
      await this.liveSetSaves.stop();
      await this.liveEvents.stop();
      await super.stop();
    } finally {
      this.preparedContext.stop();
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

function isCurrentLiveSetProvider(
  value: AbletonService,
): value is AbletonService & { getCurrentLiveSetId(): string | undefined } {
  return (
    typeof (value as Partial<{ getCurrentLiveSetId(): string | undefined }>)
      .getCurrentLiveSetId === "function"
  );
}

function isCurrentLiveIdentityProvider(
  value: AbletonService,
): value is AbletonService & {
  getCurrentLiveIdentity(): LiveIdentity | undefined;
} {
  return (
    typeof (
      value as Partial<{
        getCurrentLiveIdentity(): LiveIdentity | undefined;
      }>
    ).getCurrentLiveIdentity === "function"
  );
}

function isLiveSetSaveBridge(
  value: AbletonService,
): value is AbletonService & LiveSetSaveBridge {
  return (
    typeof (
      value as Partial<{
        subscribeLiveSetSaves(
          listener: Parameters<LiveSetSaveBridge["subscribeLiveSetSaves"]>[0],
        ): () => void;
      }>
    ).subscribeLiveSetSaves === "function"
  );
}

class UnavailableLiveSetSaveBridge implements LiveSetSaveBridge {
  public subscribeLiveSetSaves(): () => void {
    return () => undefined;
  }
}

function isProjectRevisionProvider(
  value: AbletonService,
): value is AbletonService & {
  getProjectRevision(): number | undefined;
} {
  return (
    typeof (value as Partial<{ getProjectRevision(): number | undefined }>)
      .getProjectRevision === "function"
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
          "live_set.changed",
          "live_set.save_observed",
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
  const currentIdentityContext = () => {
    const bridgeIdentity = isCurrentLiveIdentityProvider(ableton)
      ? ableton.getCurrentLiveIdentity()
      : undefined;
    const liveSetId =
      bridgeIdentity?.liveSetId ??
      options.currentLiveSetId?.() ??
      (isCurrentLiveSetProvider(ableton)
        ? ableton.getCurrentLiveSetId()
        : undefined);
    if (liveSetId === undefined) return undefined;
    const liveProjectId =
      bridgeIdentity?.liveProjectId ?? options.currentLiveProjectId?.();
    return {
      liveSetId,
      ...(liveProjectId === undefined ? {} : { liveProjectId }),
    };
  };
  const runtimeObserver = createRuntimeObserver(
    options.telemetry,
    options.agentHistory,
    options.currentAppSessionId,
    options.currentLiveSetId ??
      (isCurrentLiveSetProvider(ableton)
        ? () => ableton.getCurrentLiveSetId()
        : undefined),
    options.currentLiveProjectId,
    logger,
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
  const preparedContext = new PreparedProjectContextStore({
    events,
    getAbletonStatus: () => ableton.getStatus(),
    inspectSession: () => ableton.inspectSession(),
    ...(isProjectRevisionProvider(ableton)
      ? { getProjectRevision: () => ableton.getProjectRevision() }
      : {}),
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
    preparedContextProvider: preparedContext,
    ...(options.telemetry === undefined
      ? {}
      : { telemetry: options.telemetry }),
  });
  const liveSetSaves = new DefaultLiveSetSaveRuntime({
    ...(options.liveSetSaves ?? {}),
    bridge: isLiveSetSaveBridge(ableton)
      ? ableton
      : new UnavailableLiveSetSaveBridge(),
    logger,
    ...(options.telemetry === undefined
      ? {}
      : { telemetry: options.telemetry }),
  });
  const agent = new CopilotAgentService({
    events,
    ...(options.setHistoryQuery === undefined
      ? {}
      : { setHistoryQuery: options.setHistoryQuery }),
    ...(agentSettings.model === undefined
      ? {}
      : { model: agentSettings.model }),
    ...(agentSettings.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: agentSettings.reasoningEffort }),
    ...(agentSettings.reasoningSummary === undefined
      ? {}
      : { reasoningSummary: agentSettings.reasoningSummary }),
    ...(agentSettings.baseDirectory === undefined
      ? {}
      : { baseDirectory: agentSettings.baseDirectory }),
    ...(agentSettings.resolvePlanArtifactPaths === undefined
      ? {}
      : { resolvePlanArtifactPaths: agentSettings.resolvePlanArtifactPaths }),
    ...(agentSettings.clientFactory === undefined
      ? {}
      : { clientFactory: agentSettings.clientFactory }),
    ...(agentSettings.turnTimeoutMs === undefined
      ? {}
      : { turnTimeoutMs: agentSettings.turnTimeoutMs }),
    ...(agentSettings.resolveSkill === undefined
      ? {}
      : { resolveSkill: agentSettings.resolveSkill }),
    ...(options.requestToolApproval === undefined
      ? {}
      : { requestToolApproval: options.requestToolApproval }),
    askForReadApproval: options.askForReadApproval ?? false,
    getAbletonStatus: () => ableton.getStatus(),
    inspectSession: () => ableton.inspectSession(),
    preparedContextProvider: preparedContext,
    currentIdentityContext,
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
    fillArrangementRegion: (params) => ableton.fillArrangementRegion(params),
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
    liveSetSaves,
    preparedContext,
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
    liveSetSaves,
    preparedContext,
  };
}
