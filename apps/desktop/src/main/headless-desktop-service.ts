import { randomUUID } from "node:crypto";

import {
  DEFAULT_SIGNAL_USAGE_INSTRUCTION,
  type AgentSessionConfiguration,
  type HeadlessApplication,
} from "@ableton-agent/application";
import {
  skillNameSchema,
  type BoundTrackScope,
  type OutputSubscription,
} from "@ableton-agent/agent-config";
import type {
  InspectDeviceParametersResult,
  InspectDevicesResult,
  SessionSnapshot,
} from "@ableton-agent/protocol";
import {
  DefaultSignalRuntime,
  type SignalRuntime,
  type SignalRuntimeEvent,
} from "@ableton-agent/runtime";
import {
  checkProductCompatibility,
  noopLogger,
  PRODUCT_VERSIONS,
  type AppEvent,
  type ConnectionStatus,
  type Logger,
} from "@ableton-agent/shared";
import { createAgentInstanceAssignmentId } from "@ableton-agent/signal-routing";

import {
  desktopActiveAgentSchema,
  desktopAgentCatalogSchema,
  preferencesSchema,
  type ApprovalDecision,
  type AutoApprovalTarget,
  type ContextChip,
  type DesktopAppEvent,
  type DesktopConnectionStatus,
  type DiagnosticCheck,
  type DesktopLifecycleState,
  type DesktopOutputAssignment,
  type DesktopOutputConnection,
  type DesktopOutputsState,
  type DesktopAgentCatalog,
  type DesktopAutoApprovalUpdate,
  type DesktopAgentDefinition,
  type DesktopAgentConfigOverrides,
  type DesktopAgentHistoryMessage,
  type DesktopActiveAgent,
  type DesktopPreferences,
  type DesktopProjectSnapshot,
  type DesktopProjectIdentity,
  type DesktopSession,
  type PlanSection,
  type ProductMode,
  type LatestAcceptedOutput,
  type OutputDeliveryMode,
  type PendingProjectTransition,
  type ProjectTransitionDecision,
} from "../contracts.js";
import type { ApprovalCoordinator } from "./approvals.js";
import type { AgentCatalogService } from "./agent-catalog.js";
import { legacySdkSessionId } from "./desktop-service.js";
import type {
  DesktopService,
  JsonPreferencesStore,
  JsonSessionStore,
} from "./desktop-service.js";
import { composeAgentPrompt } from "./prompt.js";
import { normalizeSharedEvent } from "./shared-event-adapter.js";
import {
  projectLabel,
  toDesktopCapabilities,
  toDesktopSnapshot,
  type TrackDevices,
} from "./snapshot-adapter.js";
import type {
  ProjectSessionAssociation,
  ProjectSessionStore,
} from "./project-session-store.js";

/** Devices and parameters read per track when building a project snapshot. */
const deviceReadLimit = 32;
const parameterReadLimit = 64;
const diagnosticMessageLimit = 512;
const forkedHistoryMessageLimit = 100;
const forkedHistoryCharacterLimit = 40_000;
/** The sessions view shows the most recent entries; older ones are dropped. */
const storedSessionLimit = 100;

export interface HeadlessDesktopServiceOptions {
  application: HeadlessApplication;
  approvals: ApprovalCoordinator;
  preferencesStore: JsonPreferencesStore;
  sessionStore: JsonSessionStore;
  projectSessionStore?: ProjectSessionStore;
  agentCatalog?: Pick<AgentCatalogService, "current" | "refresh"> &
    Partial<Pick<AgentCatalogService, "runtimeSkills">>;
  signals?: SignalRuntime;
  /**
   * Composition-time findings (e.g. a missing bridge token) surfaced through
   * diagnostics, because they happen before any renderer can receive events.
   */
  startupNotices?: readonly {
    label: string;
    status: "pass" | "warn" | "fail";
    detail: string;
  }[];
  /** Reports failures that have no user-visible surface of their own. */
  onError?: (message: string, context: Record<string, unknown>) => void;
  onLoggingLevelChange?: (level: DesktopPreferences["loggingLevel"]) => void;
  onApprovalPolicyChange?: (
    policy: DesktopPreferences["approvalPolicy"],
  ) => void;
  onAutoApprovedAgentIdsChange?: (
    agentInstanceIds: ReadonlySet<string>,
  ) => void;
  logger?: Logger;
  projectIdentityPollIntervalMs?: number;
}

interface ActiveTurn {
  messageId: string;
  cancelRequested: boolean;
}

interface ActiveAgentTarget {
  productionSessionId: string;
  agentInstanceId: string;
}

interface ResolvedActiveAgentTarget {
  session: DesktopSession;
  instance: DesktopActiveAgent;
}

/**
 * Desktop adapter over the shared {@link HeadlessApplication}.
 *
 * Every conversational capability is delegated to the shared composition; the
 * adapter only translates shared events, status, and snapshots into the desktop
 * contracts and owns desktop-only state (sessions list, preferences, selected
 * context, plan). Operations the shared runtime cannot perform are reported as
 * unsupported instead of being simulated.
 */
export class HeadlessDesktopService implements DesktopService {
  readonly #listeners = new Set<(event: DesktopAppEvent) => void>();
  readonly #application: HeadlessApplication;
  readonly #approvals: ApprovalCoordinator;
  readonly #signals: SignalRuntime;
  readonly #logger: Logger;
  #unsubscribeShared: (() => void) | undefined;
  #unsubscribeApprovals: (() => void) | undefined;
  #unsubscribeSignals: (() => void) | undefined;
  #sessions: DesktopSession[] = [];
  #preferences: DesktopPreferences = preferencesSchema.parse({});
  #preferenceSaveTail: Promise<void> = Promise.resolve();
  #sessionActionTail: Promise<void> = Promise.resolve();
  readonly #agentActionTails = new Map<string, Promise<void>>();
  #pendingSessionActions = 0;
  #lifecycle: DesktopLifecycleState = "stopped";
  #pinnedContext: ContextChip[] = [];
  #turn: ActiveTurn | undefined;
  readonly #managedTurns = new Map<string, ActiveTurn>();
  readonly #streamMessageIds = new Map<string, string>();
  readonly #managedTurnCleanup = new Set<string>();
  #acceptingActions = false;
  #pendingActionableLifecycle:
    Extract<DesktopLifecycleState, "ready" | "degraded"> | undefined;
  #latestOutputs = new Map<string, LatestAcceptedOutput>();
  #snapshotRefresh: Promise<DesktopProjectSnapshot> | undefined;
  #activeProductionSessionId: string | undefined;
  readonly #sdkSessionIds = new Map<string, string>();
  readonly #ephemeralSessionIds = new Set<string>();
  #projectAssociations: ProjectSessionAssociation[] = [];
  #projectIdentity: DesktopProjectIdentity | undefined;
  #pendingProjectTransition: PendingProjectTransition | undefined;
  #projectIdentityTimer: NodeJS.Timeout | undefined;
  #projectIdentityRefresh: Promise<void> | undefined;
  #transitionCommitting = false;

  public constructor(private readonly options: HeadlessDesktopServiceOptions) {
    this.#application = options.application;
    this.#approvals = options.approvals;
    this.#signals = options.signals ?? new DefaultSignalRuntime({});
    this.#logger = options.logger ?? noopLogger;
  }

  public async start(): Promise<void> {
    const startedAt = Date.now();
    this.#logger.info("Desktop service starting");
    this.#unsubscribeShared = this.#application.subscribe((event) =>
      this.#onSharedEvent(event),
    );
    this.#unsubscribeApprovals = this.#approvals.setPublisher(
      (approval, attribution) => {
        if (this.#listeners.size === 0) return false;
        this.emit({
          type: "approval.requested",
          approval,
          ...attribution,
        });
        return true;
      },
    );
    this.#unsubscribeSignals = this.#signals.subscribe((event) =>
      this.#onSignalEvent(event),
    );
    const catalog =
      (await this.options.agentCatalog?.refresh()) ??
      desktopAgentCatalogSchema.parse({});
    this.#preferences = await this.#loadPreferences();
    this.#sessions = await this.#loadSessions();
    this.#sdkSessionIds.clear();
    for (const session of this.#sessions) {
      const sdkSessionId = legacySdkSessionId(session);
      if (sdkSessionId !== undefined) {
        this.#sdkSessionIds.set(session.id, sdkSessionId);
      }
    }
    const migratedSessions = this.#migrateAgentModes(catalog);
    this.#projectAssociations = await this.#loadProjectAssociations();
    this.#activeProductionSessionId = undefined;
    this.#publishAutoApprovedAgentIds();
    this.emit({ type: "preferences.changed", preferences: this.#preferences });
    this.emit({ type: "sessions.changed", sessions: this.#sessions });
    this.emit({ type: "agents.catalog_changed", catalog });
    if (migratedSessions) await this.#persistSessions();

    try {
      await this.#signals.start();
    } catch (error) {
      this.#report("Signal ingress startup failed", error);
    }
    try {
      await this.#application.start({
        startAgent: true,
      });
    } catch (error) {
      this.#report("Agent startup failed", error);
      // Startup aborted before the shared runtime published a connection
      // status, so report the status the bridge actually observed.
      this.emit({
        type: "ableton.connection_changed",
        status: await this.#application.getStatus(),
      });
    }
    await this.#restoreOrRegisterSession(await this.#readProjectIdentity());
    this.#bindActiveOutputAssignments();
    this.#acceptingActions = true;
    this.#publishPendingActionableLifecycle();
    this.#emitOutputs();
    if ((await this.#application.getStatus()).state === "connected") {
      try {
        await this.getSnapshot();
      } catch (error) {
        this.#report("Project snapshot could not be read", error);
      }
    }
    this.#scheduleProjectIdentityRefresh();
    this.#logger.info("Desktop service started", {
      durationMs: Date.now() - startedAt,
      sessionId: this.#application.agentSessionId,
      sessionCount: this.#sessions.length,
    });
  }

  public async stop(): Promise<void> {
    const startedAt = Date.now();
    this.#logger.info("Desktop service stopping");
    this.#acceptingActions = false;
    if (this.#projectIdentityTimer !== undefined) {
      clearTimeout(this.#projectIdentityTimer);
      this.#projectIdentityTimer = undefined;
    }
    await this.#projectIdentityRefresh;
    this.#pendingActionableLifecycle = undefined;
    this.#approvals.denyAll();
    await this.#preferenceSaveTail;
    await this.#drainSnapshotRefresh();
    await this.#sessionActionTail;
    await this.#drainAgentActions();
    await this.#sessionActionTail;
    try {
      await this.options.preferencesStore.save(this.#preferences);
    } catch (error) {
      this.#report("Preferences could not be saved", error);
    }
    try {
      await this.#signals.stop();
    } catch (error) {
      this.#report("Signal ingress shutdown reported failures", error);
    }
    try {
      await this.#application.stop();
    } catch (error) {
      this.#report("Shutdown reported failures", error);
    }
    this.#unsubscribeApprovals?.();
    this.#unsubscribeApprovals = undefined;
    this.#unsubscribeShared?.();
    this.#unsubscribeShared = undefined;
    this.#unsubscribeSignals?.();
    this.#unsubscribeSignals = undefined;
    this.#turn = undefined;
    this.#activeProductionSessionId = undefined;
    this.#publishAutoApprovedAgentIds();
    this.#logger.info("Desktop service stopped", {
      durationMs: Date.now() - startedAt,
    });
  }

  public async send(
    message: string,
    context: ContextChip[],
    mode: ProductMode,
  ): Promise<{ accepted: true; messageId: string }> {
    this.#assertAccepting();
    if (this.#turn) {
      throw new Error("An agent operation is already in progress");
    }
    if (this.#pendingSessionActions > 0) {
      throw new Error("A session transition is already in progress");
    }
    const messageId = randomUUID();
    const turn: ActiveTurn = { messageId, cancelRequested: false };
    const expectedSessionId = this.#activeProductionSessionId;
    if (expectedSessionId === undefined) {
      throw new Error("No active production session");
    }
    const { managedTarget, selection } = await this.#queueSessionAction(
      async () => {
        const selection = this.#withPinnedContext(context);
        const session = this.#requireExpectedActiveSession(expectedSessionId);
        await this.#updateActiveSessionInTransaction({ mode });
        if (this.options.agentCatalog === undefined) {
          return { managedTarget: undefined, selection };
        }
        const instance = this.#selectedAgent(session);
        if (instance === undefined) {
          if (this.#selectedSdkSessionId(session) === undefined) {
            throw new Error("No selected active agent");
          }
          return { managedTarget: undefined, selection };
        }
        return {
          managedTarget: {
            productionSessionId: expectedSessionId,
            agentInstanceId: instance.id,
          },
          selection,
        };
      },
    );
    this.#logger.debug("Desktop agent turn accepted", {
      messageId,
      message,
      context: selection,
      mode,
    });
    if (this.options.agentCatalog !== undefined) {
      if (managedTarget !== undefined) {
        return this.#beginManagedTurn(managedTarget, () =>
          this.#application.sendToManagedAgent(
            managedTarget.agentInstanceId,
            message,
          ),
        );
      }
    }
    this.#turn = turn;
    this.emit({
      type: "operation.changed",
      operation: {
        id: messageId,
        label: `Agent turn (${mode})`,
        status: "running",
        detail:
          selection.length > 0
            ? `Context: ${selection.map((item) => item.label).join(", ")}`
            : "No selected context",
        warnings: [],
        changed: [],
        unchanged: [],
        retryable: false,
        undoable: false,
        timestamp: Date.now(),
      },
    });
    void this.#runTurn(
      turn,
      composeAgentPrompt(message, selection, mode),
      mode,
    );
    return { accepted: true, messageId };
  }

  /** Pinned context first, then the caller's selection, deduplicated by id. */
  #withPinnedContext(context: readonly ContextChip[]): ContextChip[] {
    return [
      ...this.#pinnedContext.filter(
        (pinned) => !context.some((chip) => chip.id === pinned.id),
      ),
      ...context,
    ];
  }

  async #runTurn(
    turn: ActiveTurn,
    prompt: string,
    mode: ProductMode,
  ): Promise<void> {
    const startedAt = Date.now();
    try {
      await this.#application.send(prompt);
      this.#logger.debug("Desktop agent turn completed", {
        messageId: turn.messageId,
        prompt,
        mode,
        durationMs: Date.now() - startedAt,
      });
      this.#completeTurn(turn, {
        status: "completed",
        label: `Agent turn (${mode})`,
        detail: "The agent finished this turn.",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#logger.error("Desktop agent turn failed", {
        messageId: turn.messageId,
        prompt,
        mode,
        durationMs: Date.now() - startedAt,
        error: message,
      });
      this.#completeTurn(turn, {
        status: turn.cancelRequested ? "cancelled" : "failed",
        label: `Agent turn (${mode})`,
        detail: turn.cancelRequested ? "Cancelled by you." : message,
        ...(turn.cancelRequested ? {} : { warnings: [message] }),
      });
      if (!turn.cancelRequested) {
        this.emit({ type: "diagnostic", level: "error", message });
      }
    } finally {
      if (this.#turn === turn) this.#turn = undefined;
    }
  }

  #completeTurn(
    turn: ActiveTurn,
    view: {
      status: "completed" | "failed" | "cancelled";
      label: string;
      detail: string;
      warnings?: string[];
    },
  ): void {
    this.emit({
      type: "operation.changed",
      operation: {
        id: turn.messageId,
        label: view.label,
        status: view.status,
        detail: view.detail,
        warnings: view.warnings ?? [],
        changed: [],
        unchanged: [],
        // The shared runtime cannot replay or revert a turn, so neither
        // recovery affordance is offered for one.
        retryable: false,
        undoable: false,
        timestamp: Date.now(),
      },
    });
  }

  public async cancel(): Promise<{ cancelled: boolean }> {
    if (this.options.agentCatalog !== undefined) {
      const selected = this.#selectedAgent(this.#requireActiveSession());
      if (selected !== undefined) return this.cancelActiveAgent(selected.id);
      if (
        this.#selectedSdkSessionId(this.#requireActiveSession()) === undefined
      ) {
        return { cancelled: false };
      }
    }
    const turn = this.#turn;
    if (!turn) return { cancelled: false };
    const cancelled = await this.#application.cancel();
    if (cancelled) {
      turn.cancelRequested = true;
      this.emit({
        type: "diagnostic",
        level: "warning",
        message:
          "Cancellation requested. Changes already applied in Live are not undone.",
      });
    }
    return { cancelled };
  }

  public async createSession(): Promise<string> {
    this.#assertAccepting();
    return this.#queueSessionAction(async () => {
      if (this.#turn) {
        throw new Error(
          "Cannot create a session while an agent turn is running",
        );
      }
      if (this.#managedTurns.size > 0 || this.#managedTurnCleanup.size > 0) {
        throw new Error(
          "Cannot create a session while a managed agent turn is running",
        );
      }
      return this.#withSuspendedSignals(async () => {
        if (this.options.agentCatalog !== undefined) {
          return this.#createManagedProductionSession("New production session");
        }
        const sdkSessionId = await this.#application.createAgentSession();
        return this.#rememberSession(sdkSessionId, "New production session");
      });
    });
  }

  public async getSessions(): Promise<DesktopSession[]> {
    return [...this.#sessions];
  }

  public async getAgentCatalog(): Promise<DesktopAgentCatalog> {
    return (
      this.options.agentCatalog?.current ?? desktopAgentCatalogSchema.parse({})
    );
  }

  public async refreshAgentCatalog(): Promise<DesktopAgentCatalog> {
    this.#assertAccepting();
    if (this.options.agentCatalog === undefined) {
      throw new Error("Agent definitions are not configured");
    }
    const catalog = await this.options.agentCatalog.refresh();
    this.emit({ type: "agents.catalog_changed", catalog });
    return catalog;
  }

  public async listActiveAgents(): Promise<DesktopActiveAgent[]> {
    return [...this.#requireActiveSession().activeAgents];
  }

  public async createActiveAgent(
    definitionName: string,
  ): Promise<DesktopActiveAgent> {
    this.#assertAccepting();
    const productionSessionId = this.#activeProductionSessionId;
    if (productionSessionId === undefined) {
      throw new Error("No active production session");
    }
    const candidate = this.#activeAgentFromDefinition(
      this.#requireDefinition(definitionName),
    );
    return this.#queueAgentAction(candidate.id, async () => {
      await this.#queueSessionAction(async () => {
        this.#requireExpectedActiveSession(productionSessionId);
      });
      const instance = await this.#resolveAgentBindings(candidate);
      const sdkSessionId = await this.#application.createManagedAgent(
        this.#managedConfiguration(instance),
      );
      const connected = { ...instance, sdkSessionId };
      let commitStarted = false;
      try {
        return await this.#queueSessionAction(async () => {
          const session =
            this.#requireExpectedActiveSession(productionSessionId);
          commitStarted = true;
          await this.#replaceActiveProductionSession({
            ...session,
            activeAgents: [...session.activeAgents, connected],
            selectedAgentInstanceId: connected.id,
          });
          this.#bindActiveOutputAssignments();
          this.#publishAutoApprovedAgentIds();
          this.emit({
            type: "agent.instance_changed",
            instance: connected,
            change: "created",
          });
          return connected;
        });
      } catch (error) {
        if (
          !commitStarted &&
          this.#application.getManagedAgentSessionId(connected.id) !== undefined
        ) {
          try {
            await this.#application.deactivateManagedAgent(connected.id);
          } catch (rollbackError) {
            throw new AggregateError(
              [error, rollbackError],
              `Agent instance '${connected.id}' creation failed and rollback was incomplete`,
            );
          }
        }
        throw error;
      }
    });
  }

  public async renameActiveAgent(
    instanceId: string,
    label: string,
  ): Promise<DesktopActiveAgent> {
    const target = this.#captureActiveAgentTarget(instanceId);
    return this.#queueActiveAgentAction(
      target,
      async ({ session, instance }) => {
        const renamed = { ...instance, label };
        await this.#replaceAgent(session, renamed);
        this.emit({
          type: "agent.instance_changed",
          instance: renamed,
          change: "renamed",
        });
        return renamed;
      },
    );
  }

  public async configureActiveAgent(
    instanceId: string,
    overrides: DesktopAgentConfigOverrides,
  ): Promise<DesktopActiveAgent> {
    const target = this.#captureActiveAgentTarget(instanceId);
    return this.#queueActiveAgentTransaction(
      target,
      async ({ instance }) => {
        const configured = await this.#resolveAgentBindings(
          desktopActiveAgentSchema.parse({
            ...instance,
            config: { ...instance.config, ...overrides },
            modified: true,
          }),
        );
        await this.#application.reconfigureManagedAgent(
          this.#managedConfiguration(configured),
        );
        return configured;
      },
      async ({ session }, configured) => {
        await this.#replaceAgent(session, configured);
        this.emit({
          type: "agent.instance_changed",
          instance: configured,
          change: "configured",
        });
        return configured;
      },
      async ({ instance }) => this.#rollbackAgentConfiguration(instance),
    );
  }

  public async resetActiveAgent(
    instanceId: string,
  ): Promise<DesktopActiveAgent> {
    const target = this.#captureActiveAgentTarget(instanceId);
    return this.#queueActiveAgentTransaction(
      target,
      async ({ instance: current }) => {
        const definition = this.#requireDefinition(current.definitionName);
        const reset = await this.#resolveAgentBindings({
          ...this.#activeAgentFromDefinition(
            definition,
            current.sdkSessionId,
            current.id,
          ),
          label: current.label,
          autoApprove: current.autoApprove,
          forkedHistory: current.forkedHistory ?? [],
        });
        await this.#application.reconfigureManagedAgent(
          this.#managedConfiguration(reset),
        );
        return reset;
      },
      async ({ session }, reset) => {
        await this.#replaceAgent(session, reset);
        this.#bindActiveOutputAssignments();
        this.emit({
          type: "agent.instance_changed",
          instance: reset,
          change: "reset",
        });
        return reset;
      },
      async ({ instance }) => this.#rollbackAgentConfiguration(instance),
    );
  }

  public async selectActiveAgent(
    instanceId: string,
  ): Promise<DesktopActiveAgent> {
    const target = this.#captureActiveAgentTarget(instanceId);
    return this.#queueActiveAgentAction(
      target,
      async ({ session, instance }) => {
        await this.#replaceActiveProductionSession({
          ...session,
          selectedAgentInstanceId: instanceId,
          outputAssignments: instance.outputSubscriptions,
        });
        this.#bindActiveOutputAssignments();
        this.emit({
          type: "agent.instance_changed",
          instance,
          change: "selected",
        });
        return instance;
      },
    );
  }

  public async setAutoApproval(
    target: AutoApprovalTarget,
    enabled: boolean,
  ): Promise<DesktopAutoApprovalUpdate> {
    this.#assertAccepting();
    const { productionSessionId, instanceIds } = await this.#queueSessionAction(
      async () => {
        const productionSessionId = this.#activeProductionSessionId;
        if (productionSessionId === undefined) {
          throw new Error("No active production session");
        }
        const session = this.#requireExpectedActiveSession(productionSessionId);
        const instanceIds =
          target === "all"
            ? session.activeAgents.map(({ id }) => id).sort()
            : session.activeAgents.some(({ id }) => id === target)
              ? [target]
              : (() => {
                  throw new Error(`Agent instance '${target}' not found`);
                })();
        return { productionSessionId, instanceIds };
      },
    );

    return this.#queueAgentActions(instanceIds, () =>
      this.#queueSessionAction(async () => {
        const current = this.#requireExpectedActiveSession(productionSessionId);
        for (const instanceId of instanceIds) {
          if (!current.activeAgents.some(({ id }) => id === instanceId)) {
            throw new Error(
              `Agent instance '${instanceId}' changed in production session '${productionSessionId}' while the operation was queued`,
            );
          }
        }
        if (
          target === "all" &&
          (current.activeAgents.length !== instanceIds.length ||
            current.activeAgents.some(({ id }) => !instanceIds.includes(id)))
        ) {
          throw new Error(
            `Active agents changed in production session '${productionSessionId}' while the operation was queued`,
          );
        }
        const targetIds = new Set(instanceIds);
        const instances = current.activeAgents
          .filter(({ id }) => targetIds.has(id))
          .map((instance) => ({ ...instance, autoApprove: enabled }));
        const updatedById = new Map(
          instances.map((instance) => [instance.id, instance]),
        );
        const updatedSession = {
          ...current,
          activeAgents: current.activeAgents.map(
            (instance) => updatedById.get(instance.id) ?? instance,
          ),
        };
        await this.#replaceActiveProductionSessionStrict(updatedSession);
        for (const instance of instances) {
          this.emit({
            type: "agent.instance_changed",
            instance,
            change: "configured",
          });
        }
        this.#publishAutoApprovedAgentIds();
        return {
          instances,
          session: this.#requireExpectedActiveSession(productionSessionId),
        };
      }),
    );
  }

  public async deactivateActiveAgent(instanceId: string): Promise<void> {
    const target = this.#captureActiveAgentTarget(instanceId);
    await this.#queueActiveAgentTransaction(
      target,
      async () => {
        if (this.#managedTurns.has(instanceId)) {
          throw new Error(
            `Agent instance '${instanceId}' has a turn in progress`,
          );
        }
        await this.#application.deactivateManagedAgent(instanceId);
      },
      async ({ session, instance }) => {
        const activeAgents = session.activeAgents.filter(
          ({ id }) => id !== instanceId,
        );
        const selectedAgentInstanceId =
          session.selectedAgentInstanceId === instanceId
            ? activeAgents[0]?.id
            : session.selectedAgentInstanceId;
        await this.#replaceActiveProductionSession({
          ...session,
          activeAgents,
          ...(selectedAgentInstanceId === undefined
            ? { selectedAgentInstanceId: undefined }
            : { selectedAgentInstanceId }),
        });
        this.#bindActiveOutputAssignments();
        this.#publishAutoApprovedAgentIds();
        this.emit({
          type: "agent.instance_changed",
          instance,
          change: "deactivated",
        });
      },
      async (original) => this.#rollbackDeactivatedAgent(original),
    );
  }

  public async hydrateActiveAgentHistory(
    instanceId: string,
  ): Promise<DesktopAgentHistoryMessage[]> {
    const target = this.#captureActiveAgentTarget(instanceId);
    return this.#queueActiveAgentTransaction(
      target,
      async ({ instance }) => {
        const current = (
          await this.#application.getManagedAgentHistory(instanceId)
        ).map((message) => {
          const sdkSessionId = message.sdkSessionId ?? instance.sdkSessionId;
          return {
            ...message,
            agentInstanceId: instanceId,
            ...(sdkSessionId === undefined ? {} : { sdkSessionId }),
          };
        });
        return [
          ...(instance.forkedHistory ?? []).map((message) => ({
            ...message,
            eventId: `fork:${instance.id}:${message.eventId}`,
            agentInstanceId: instance.id,
            ...(instance.sdkSessionId === undefined
              ? {}
              : { sdkSessionId: instance.sdkSessionId }),
          })),
          ...current,
        ];
      },
      async ({ instance }, history) => {
        this.emit({
          type: "agent.history_hydrated",
          agentInstanceId: instanceId,
          ...(instance.sdkSessionId === undefined
            ? {}
            : { sdkSessionId: instance.sdkSessionId }),
          history,
        });
        return history;
      },
    );
  }

  public sendToActiveAgent(
    instanceId: string,
    message: string,
  ): Promise<{ accepted: true; messageId: string }> {
    return this.#beginManagedTurn(
      this.#captureActiveAgentTarget(instanceId),
      () => this.#application.sendToManagedAgent(instanceId, message),
    );
  }

  public invokeActiveAgentSkill(
    instanceId: string,
    skillName: string,
    argumentsText: string,
  ): Promise<{ accepted: true; messageId: string }> {
    skillNameSchema.parse(skillName);
    return this.#beginManagedTurn(
      this.#captureActiveAgentTarget(instanceId),
      () =>
        this.#application.invokeManagedAgentSkill(instanceId, {
          skillName,
          request: argumentsText,
        }),
      () => {
        if (!(
          this.options.agentCatalog?.current.skills.some(
            (skill) => skill.name === skillName,
          ) ?? false
        )) {
          throw new Error(`Unknown skill '${skillName}'`);
        }
      },
    );
  }

  public async cancelActiveAgent(
    instanceId: string,
  ): Promise<{ cancelled: boolean }> {
    this.#requireActiveAgent(instanceId);
    const turn = this.#managedTurns.get(instanceId);
    if (turn === undefined) return { cancelled: false };
    const cancelled = await this.#application.cancelManagedAgent(instanceId);
    if (cancelled) {
      turn.cancelRequested = true;
      this.emit({
        type: "diagnostic",
        level: "warning",
        message:
          "Cancellation requested. Changes already applied in Live are not undone.",
      });
    }
    return { cancelled };
  }

  public async resumeSession(sessionId: string): Promise<void> {
    this.#assertAccepting();
    await this.#queueSessionAction(async () => {
      await this.#resumeSessionInTransaction(sessionId);
    });
  }

  async #resumeSessionInTransaction(sessionId: string): Promise<void> {
    const requested = this.#sessions.find(
      (session) => session.id === sessionId,
    );
    if (requested === undefined) {
      throw new Error("Session not found");
    }
    if (
      this.#projectIdentity?.saved === true &&
      requested.projectId !== undefined &&
      requested.projectId !== this.#projectIdentity.projectId
    ) {
      throw new Error(
        "Session belongs to a different Live Set; switch Live Sets before resuming it",
      );
    }
    if (this.#turn) {
      throw new Error("Cannot resume a session while an agent turn is running");
    }
    if (this.#managedTurns.size > 0 || this.#managedTurnCleanup.size > 0) {
      throw new Error(
        "Cannot resume a session while a managed agent turn is running",
      );
    }
    await this.#withSuspendedSignals(async () => {
      const session = this.#sessions.find((item) => item.id === sessionId)!;
      if (this.options.agentCatalog !== undefined) {
        const previous = this.#activeSession();
        if (previous?.id !== session.id) {
          const resumed = await this.#switchManagedProductionSession(
            previous,
            session,
          );
          session.activeAgents = resumed;
        } else {
          session.activeAgents = await this.#resumeManagedAgents(session);
        }
      } else {
        const sdkSessionId = this.#selectedSdkSessionId(session);
        if (sdkSessionId === undefined) {
          throw new Error("Selected agent has no SDK session to resume");
        }
        await this.#application.resumeAgentSession(sdkSessionId);
      }
      this.#activeProductionSessionId = sessionId;
      await this.#touchSession(sessionId);
      await this.#associateActiveSession(this.#projectIdentity);
      this.#publishAutoApprovedAgentIds();
    });
    const session = this.#sessions.find((item) => item.id === sessionId);
    if (session !== undefined) {
      this.#pinnedContext = [];
      this.emit({ type: "session.context_restored", session });
    }
    this.emit({
      type: "diagnostic",
      level: "info",
      message: `Resumed production session ${sessionId}.`,
    });
  }

  public async connect(): Promise<DesktopConnectionStatus> {
    this.#assertAccepting();
    const status = await this.#application.connectAbleton();
    if (status.state === "connected") {
      try {
        await this.getSnapshot();
      } catch (error) {
        this.#report("Project snapshot could not be read", error);
      }
    }
    return status;
  }

  public async resolveProjectTransition(
    token: string,
    decision: ProjectTransitionDecision,
  ): Promise<DesktopSession> {
    this.#assertAccepting(true);
    return this.#queueSessionAction(async () => {
      const transition = this.#pendingProjectTransition;
      if (transition === undefined || transition.token !== token) {
        throw new Error("Project transition is no longer pending");
      }
      if (!transition.decisions.includes(decision)) {
        throw new Error("Project transition decision is not valid");
      }
      this.#transitionCommitting = true;
      const previousIdentity = this.#projectIdentity;
      this.#projectIdentity = transition.project;
      try {
        let session: DesktopSession;
        if (decision === "resume-associated") {
          if (transition.associatedSession === undefined) {
            throw new Error("Associated project session is unavailable");
          }
          await this.#resumeSessionInTransaction(
            transition.associatedSession.id,
          );
          session = this.#requireActiveSession();
        } else if (decision === "fork-current") {
          session = await this.#forkCurrentSession(transition.project);
        } else {
          await this.#createManagedProductionSession(
            "Production session",
            transition.project,
          );
          session = this.#requireActiveSession();
        }
        this.#pendingProjectTransition = undefined;
        await this.#associateActiveSession(transition.project);
        this.#bindActiveOutputAssignments();
        this.emit({ type: "project.transition_cleared", token });
        this.emit({ type: "session.context_restored", session });
        return session;
      } catch (error) {
        this.#projectIdentity = previousIdentity;
        throw error;
      } finally {
        this.#transitionCommitting = false;
      }
    });
  }

  async #forkCurrentSession(
    identity: DesktopProjectIdentity,
  ): Promise<DesktopSession> {
    const source = this.#requireActiveSession();
    const created: DesktopActiveAgent[] = [];
    try {
      for (const instance of source.activeAgents) {
        const id = randomUUID();
        const forkedHistory = (
          await this.#application.getManagedAgentHistory(instance.id)
        )
          .slice(-forkedHistoryMessageLimit)
          .map(({ role, content, timestamp, eventId, messageId }) => ({
            role,
            content,
            timestamp,
            eventId,
            ...(messageId === undefined ? {} : { messageId }),
          }));
        const candidate = desktopActiveAgentSchema.parse({
          ...structuredClone(instance),
          id,
          sdkSessionId: undefined,
          lifecycle: "starting",
          boundTracks: [],
          forkedHistory,
          outputSubscriptions: instance.outputSubscriptions.map(
            (subscription) => ({
              ...subscription,
              assignmentId: createAgentInstanceAssignmentId(
                id,
                subscription.producerId,
              ),
              agentInstanceId: id,
            }),
          ),
        });
        const resolved = await this.#resolveAgentBindings(candidate);
        const sdkSessionId = await this.#application.createManagedAgent(
          this.#managedConfiguration(resolved),
        );
        created.push({ ...resolved, sdkSessionId, lifecycle: "ready" });
      }
      const selectedIndex = source.activeAgents.findIndex(
        ({ id }) => id === source.selectedAgentInstanceId,
      );
      const target: DesktopSession = {
        ...structuredClone(source),
        id: randomUUID(),
        title: `${source.title} (fork)`,
        updatedAt: new Date().toISOString(),
        projectId: identity.projectId,
        projectName: identity.projectName,
        activeAgents: created,
        selectedAgentInstanceId:
          created[Math.max(0, selectedIndex)]?.id ?? created[0]?.id,
        outputAssignments:
          created[Math.max(0, selectedIndex)]?.outputSubscriptions ?? [],
      };
      target.activeAgents = await this.#switchManagedProductionSession(
        source,
        target,
        true,
      );
      this.#sessions = [target, ...this.#sessions].slice(0, storedSessionLimit);
      this.#activeProductionSessionId = target.id;
      await this.#persistSessions();
      this.#publishAutoApprovedAgentIds();
      return target;
    } catch (error) {
      await this.#deactivateAgents(created);
      throw error;
    }
  }

  public getStatus(): Promise<DesktopConnectionStatus> {
    return this.#application.getStatus();
  }

  async #readProjectIdentity(): Promise<DesktopProjectIdentity | undefined> {
    const status = await this.#application.getStatus();
    if (status.state !== "connected") return undefined;
    return this.#application.getProjectIdentity();
  }

  #scheduleProjectIdentityRefresh(): void {
    if (!this.#acceptingActions || this.#projectIdentityTimer !== undefined) {
      return;
    }
    const interval = this.options.projectIdentityPollIntervalMs ?? 1_500;
    this.#projectIdentityTimer = setTimeout(() => {
      this.#projectIdentityTimer = undefined;
      const refresh = this.#refreshProjectIdentity();
      this.#projectIdentityRefresh = refresh;
      void refresh.finally(() => {
        if (this.#projectIdentityRefresh === refresh) {
          this.#projectIdentityRefresh = undefined;
        }
        this.#scheduleProjectIdentityRefresh();
      });
    }, interval);
    this.#projectIdentityTimer.unref?.();
  }

  async #refreshProjectIdentity(): Promise<void> {
    let identity: DesktopProjectIdentity | undefined;
    try {
      identity = await this.#readProjectIdentity();
    } catch (error) {
      this.#logger.warn("Live Set identity refresh failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (identity === undefined) return;
    await this.#observeProjectIdentity(identity);
  }

  async #observeProjectIdentity(
    identity: DesktopProjectIdentity,
  ): Promise<void> {
    if (
      this.#pendingProjectTransition?.project.projectId ===
        identity.projectId &&
      this.#pendingProjectTransition.project.saved === identity.saved
    ) {
      return;
    }
    const previous = this.#projectIdentity;
    if (
      previous?.projectId === identity.projectId &&
      previous.saved === identity.saved &&
      previous.projectName === identity.projectName
    ) {
      return;
    }
    if (
      previous?.projectId === identity.projectId &&
      previous.saved === identity.saved
    ) {
      await this.#queueSessionAction(async () => {
        const current = this.#activeSession();
        this.#projectIdentity = identity;
        if (current === undefined) return;
        const updated = {
          ...current,
          projectName: identity.projectName,
          updatedAt: new Date().toISOString(),
        };
        this.#sessions = [
          updated,
          ...this.#sessions.filter(({ id }) => id !== current.id),
        ];
        await this.#persistSessions();
        await this.#associateActiveSession(identity);
        this.emit({ type: "session.context_restored", session: updated });
      });
      return;
    }
    if (previous === undefined) {
      this.#projectIdentity = identity;
      return;
    }
    await this.#queueSessionAction(async () => {
      if (this.#transitionCommitting) return;
      if (!previous.saved && !identity.saved) {
        this.#projectIdentity = identity;
        const current = this.#activeSession();
        if (current !== undefined) {
          const updated = { ...current, projectName: identity.projectName };
          this.#sessions = [
            updated,
            ...this.#sessions.filter(({ id }) => id !== current.id),
          ];
          this.emit({ type: "session.context_restored", session: updated });
        }
        return;
      }
      if (!identity.saved) {
        this.#projectIdentity = identity;
        await this.#createManagedProductionSession(
          "Unsaved production session",
          identity,
        );
        return;
      }
      const associated = this.#associatedSession(identity.projectId);
      if (
        associated === undefined &&
        (await this.#activeSessionIsCleanEphemeral())
      ) {
        const current = this.#requireActiveSession();
        const updated = {
          ...current,
          projectId: identity.projectId,
          projectName: identity.projectName,
          updatedAt: new Date().toISOString(),
        };
        this.#ephemeralSessionIds.delete(current.id);
        this.#sessions = [
          updated,
          ...this.#sessions.filter(({ id }) => id !== current.id),
        ];
        this.#projectIdentity = identity;
        await this.#persistSessions();
        await this.#associateActiveSession(identity);
        this.emit({ type: "session.context_restored", session: updated });
        return;
      }
      const transition: PendingProjectTransition = {
        token: randomUUID(),
        kind: associated === undefined ? "unassociated" : "associated",
        project: identity,
        ...(this.#activeProductionSessionId === undefined
          ? {}
          : { currentSessionId: this.#activeProductionSessionId }),
        ...(associated === undefined
          ? {}
          : {
              associatedSession: {
                id: associated.id,
                title: associated.title,
                updatedAt: associated.updatedAt,
              },
            }),
        decisions:
          associated === undefined
            ? ["fork-current", "start-fresh"]
            : ["resume-associated", "start-fresh"],
      };
      this.#pendingProjectTransition = transition;
      this.#approvals.denyAll();
      this.#signals.setActiveAgentInstances([]);
      this.emit({ type: "project.transition_requested", transition });
    });
  }

  async #activeSessionIsCleanEphemeral(): Promise<boolean> {
    const session = this.#activeSession();
    if (
      session === undefined ||
      !this.#ephemeralSessionIds.has(session.id) ||
      session.productionPlan.length > 0 ||
      session.activeAgents.some(
        ({ autoApprove, modified, outputSubscriptions }) =>
          autoApprove || modified || outputSubscriptions.length > 0,
      )
    ) {
      return false;
    }
    for (const instance of session.activeAgents) {
      if (
        (await this.#application.getManagedAgentHistory(instance.id)).length
      ) {
        return false;
      }
    }
    return true;
  }

  public async getCapabilities(): Promise<string[]> {
    const capabilities = await this.#application.getCapabilities();
    return toDesktopCapabilities(capabilities.capabilities);
  }

  /**
   * Publishes the deterministic core snapshot before optional device reads,
   * while resolving callers with the final enriched snapshot on full success.
   */
  public getSnapshot(): Promise<DesktopProjectSnapshot> {
    if (!this.#acceptingActions) {
      return Promise.reject(
        new Error("Desktop service is not accepting actions"),
      );
    }
    if (this.#snapshotRefresh !== undefined) return this.#snapshotRefresh;

    const refresh = this.#refreshSnapshot();
    this.#snapshotRefresh = refresh;
    void refresh.then(
      () => {
        if (this.#snapshotRefresh === refresh) {
          this.#snapshotRefresh = undefined;
        }
      },
      () => {
        if (this.#snapshotRefresh === refresh) {
          this.#snapshotRefresh = undefined;
        }
      },
    );
    return refresh;
  }

  async #drainSnapshotRefresh(): Promise<void> {
    const refresh = this.#snapshotRefresh;
    if (refresh === undefined) return;
    try {
      await refresh;
    } catch (error) {
      this.#report("Project snapshot could not be read", error);
    }
  }

  async #refreshSnapshot(): Promise<DesktopProjectSnapshot> {
    const refreshId = randomUUID();
    const startedAt = Date.now();
    this.#logger.debug("Project refresh started", { refreshId });
    const status = await this.#application.getStatus();
    if (status.state !== "connected") {
      this.#logger.warn("Project refresh rejected", {
        refreshId,
        status,
        durationMs: Date.now() - startedAt,
      });
      throw Object.assign(
        new Error("Ableton is not connected, so no project can be read"),
        { code: "not_connected" },
      );
    }
    const snapshot = await this.#application.inspectSession();
    const identity = await this.#readProjectIdentity();
    if (identity !== undefined) await this.#observeProjectIdentity(identity);
    const baseSnapshot = toDesktopSnapshot(snapshot, status);
    const coreSnapshot =
      identity === undefined
        ? baseSnapshot
        : {
            ...baseSnapshot,
            id: identity.projectId,
            name: identity.projectName,
          };
    this.#logger.debug("Project core snapshot read", {
      refreshId,
      snapshot,
      durationMs: Date.now() - startedAt,
    });
    this.emit({
      type: "project.snapshot_changed",
      snapshot: coreSnapshot,
    });

    const trackDevices = await this.#readTrackDevices(snapshot);
    const baseEnrichedSnapshot = toDesktopSnapshot(
      snapshot,
      status,
      trackDevices,
    );
    const enrichedSnapshot =
      identity === undefined
        ? baseEnrichedSnapshot
        : {
            ...baseEnrichedSnapshot,
            id: identity.projectId,
            name: identity.projectName,
          };
    this.#logger.debug("Project refresh completed", {
      refreshId,
      snapshot: enrichedSnapshot,
      durationMs: Date.now() - startedAt,
    });
    this.emit({
      type: "project.snapshot_changed",
      snapshot: enrichedSnapshot,
    });
    return enrichedSnapshot;
  }

  async #readTrackDevices(snapshot: SessionSnapshot): Promise<TrackDevices[]> {
    const result: TrackDevices[] = [];
    for (const track of snapshot.tracks) {
      const target = {
        index: track.index,
        expectedReference: track.reference,
        expectedName: track.name,
      };
      let page: InspectDevicesResult;
      try {
        page = await this.#application.inspectDevices({
          ...target,
          offset: 0,
          limit: deviceReadLimit,
        });
      } catch (error) {
        this.#warnOptionalEnrichment(
          `Could not inspect devices on track ${track.name}`,
          error,
        );
        result.push({ trackReference: track.reference, devices: [] });
        continue;
      }
      if (page.total > page.devices.length) {
        this.emit({
          type: "diagnostic",
          level: "warning",
          message: `Showing ${page.devices.length} of ${page.total} devices on ${track.name}.`,
        });
      }
      const devices: TrackDevices["devices"] = [];
      for (const device of page.devices) {
        if (device.parameterCount === 0) {
          devices.push({ device, parameters: [] });
          continue;
        }
        let parameters: InspectDeviceParametersResult;
        try {
          parameters = await this.#application.inspectDeviceParameters({
            ...target,
            deviceIndex: device.index,
            expectedDeviceReference: device.reference,
            expectedDeviceName: device.name,
            offset: 0,
            limit: parameterReadLimit,
          });
        } catch (error) {
          this.#warnOptionalEnrichment(
            `Could not inspect parameters for device ${device.name} on track ${track.name}`,
            error,
          );
          devices.push({ device, parameters: [] });
          continue;
        }
        if (parameters.total > parameters.parameters.length) {
          this.emit({
            type: "diagnostic",
            level: "warning",
            message: `Showing ${parameters.parameters.length} of ${parameters.total} parameters on ${device.name}.`,
          });
        }
        devices.push({ device, parameters: parameters.parameters });
      }
      result.push({ trackReference: track.reference, devices });
    }
    return result;
  }

  #warnOptionalEnrichment(message: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    this.emit({
      type: "diagnostic",
      level: "warning",
      message: `${message}: ${detail}`.slice(0, diagnosticMessageLimit),
    });
  }

  public async getDiagnostics(): Promise<DiagnosticCheck[]> {
    const status = await this.#application.getStatus();
    const signalStatus = this.#signals.getStatus();
    const sessionId = this.#application.agentSessionId;
    const compatibility =
      status.state === "connected"
        ? checkProductCompatibility({
            liveVersion: status.liveVersion,
            protocolVersion: PRODUCT_VERSIONS.protocol,
            remoteScriptVersion: status.remoteScriptVersion,
          })
        : undefined;
    const compatibilityDetail =
      status.state !== "connected"
        ? "Connect to Ableton Live to verify the Live and Remote Script versions"
        : compatibility?.compatible === true
          ? `Live ${status.liveVersion} and Remote Script ${status.remoteScriptVersion} are supported`
          : compatibility?.message;
    return [
      {
        label: "Desktop security",
        status: "pass",
        detail: "Sandboxed renderer, context isolation, and typed IPC only",
      },
      {
        label: "Shared composition",
        status: "pass",
        detail: `Electron main runs the shared headless application (${this.#lifecycle})`,
      },
      {
        label: "Ableton bridge",
        status: this.#connectionCheckStatus(status),
        detail: this.#connectionDetail(status),
      },
      {
        label: "Product compatibility",
        status:
          compatibility === undefined
            ? "warn"
            : compatibility.compatible
              ? "pass"
              : "fail",
        detail:
          compatibilityDetail ??
          "Compatibility could not be determined from the connection",
      },
      {
        label: "Agent session",
        status: sessionId === undefined ? "warn" : "pass",
        detail:
          sessionId === undefined
            ? "No Copilot session is open; sending a message will fail until the agent starts"
            : `Copilot session ${sessionId}`,
      },
      {
        label: "Operation recovery",
        status: "warn",
        detail:
          "Retry and undo are not implemented by the shared runtime; both are reported as unsupported",
      },
      {
        label: "Signal ingress",
        status:
          signalStatus.state === "listening"
            ? "pass"
            : signalStatus.state === "error"
              ? "fail"
              : "warn",
        detail:
          signalStatus.state === "listening"
            ? `Listening on ${signalStatus.host}:${signalStatus.port}`
            : signalStatus.state === "disabled" ||
                signalStatus.state === "error"
              ? signalStatus.detail
              : "Signal ingress is stopped",
      },
      ...(this.options.startupNotices ?? []),
    ];
  }

  #connectionCheckStatus(status: ConnectionStatus): "pass" | "warn" | "fail" {
    if (status.state === "connected") return "pass";
    return status.state === "error" ? "fail" : "warn";
  }

  #connectionDetail(status: ConnectionStatus): string {
    if (status.state === "connected") {
      return `Live ${status.liveVersion} · Remote Script ${status.remoteScriptVersion}`;
    }
    return status.state === "error"
      ? `${status.code}: ${status.message}`
      : status.state;
  }

  public async resolveApproval(
    id: string,
    decision: ApprovalDecision,
  ): Promise<boolean> {
    const resolved = this.#approvals.resolve(id, decision);
    this.emit({
      type: "diagnostic",
      level: resolved ? "info" : "warning",
      message: resolved
        ? `Approval ${id} ${decision === "approve" ? "approved" : "denied"}.`
        : `Approval ${id} is no longer pending.`,
    });
    return resolved;
  }

  public async getPreferences(): Promise<DesktopPreferences> {
    return this.#preferences;
  }

  public async setPreferences(
    value: DesktopPreferences,
  ): Promise<DesktopPreferences> {
    this.#assertAccepting();
    const preferences = preferencesSchema.parse(value);
    const update = this.#preferenceSaveTail.then(async () => {
      const previous = this.#preferences;
      await this.options.preferencesStore.save(preferences);
      this.#preferences = preferences;
      this.emit({
        type: "preferences.changed",
        preferences: this.#preferences,
      });
      if (previous.loggingLevel !== preferences.loggingLevel) {
        this.options.onLoggingLevelChange?.(preferences.loggingLevel);
      }
      if (previous.approvalPolicy !== preferences.approvalPolicy) {
        this.options.onApprovalPolicyChange?.(preferences.approvalPolicy);
      }
      const restartRequired = (
        ["abletonPort", "signalPort", "model", "reasoning"] as const
      ).filter((key) => previous[key] !== preferences[key]);
      if (restartRequired.length > 0) {
        this.emit({
          type: "diagnostic",
          level: "warning",
          message: `Saved. ${restartRequired.join(", ")} applies the next time the app starts, because the bridge and agent are composed at startup.`,
        });
      }
    });
    this.#preferenceSaveTail = update.catch(() => undefined);
    await update;
    return preferences;
  }

  public async setContext(context: ContextChip[]): Promise<void> {
    this.#assertAccepting();
    await this.#queueSessionAction(async () => {
      this.#pinnedContext = [...context];
      this.emit({
        type: "diagnostic",
        level: "info",
        message: `Context updated with ${this.#pinnedContext.length} selection(s); it is included with every message until you change it.`,
      });
    });
  }

  public async updatePlan(sections: PlanSection[]): Promise<void> {
    this.#assertAccepting();
    await this.#queueSessionAction(async () => {
      await this.#updateActiveSessionInTransaction({
        productionPlan: sections,
      });
      this.emit({
        type: "diagnostic",
        level: "info",
        message: `Production plan saved with ${sections.length} section(s). It is restored with this session but is not automatically applied to Live.`,
      });
    });
  }

  public async retryOperation(id: string): Promise<boolean> {
    this.emit({
      type: "diagnostic",
      level: "warning",
      message: `Retry is not supported: the shared runtime cannot replay operation ${id}. Send the request again instead.`,
    });
    return false;
  }

  public async undoOperation(id: string): Promise<boolean> {
    this.emit({
      type: "diagnostic",
      level: "warning",
      message: `Undo is not supported: operation ${id} cannot be reverted by the application. Use Live's undo history.`,
    });
    return false;
  }

  public subscribe(listener: (event: DesktopAppEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0) this.#approvals.denyAll();
    };
  }

  public async getLifecycleState(): Promise<DesktopLifecycleState> {
    return this.#lifecycle;
  }

  #onSharedEvent(event: AppEvent): void {
    this.#logger.debug("Application event received", { event });
    if (event.type === "lifecycle.changed") {
      if (
        !this.#acceptingActions &&
        (event.state === "ready" || event.state === "degraded")
      ) {
        this.#pendingActionableLifecycle = event.state;
        return;
      }
      this.#pendingActionableLifecycle = undefined;
      this.#lifecycle = event.state;
    }
    const messageId =
      event.type === "agent.message_delta" ||
      event.type === "agent.message_complete"
        ? this.#resolveStreamMessageId(event)
        : undefined;
    this.emit(normalizeSharedEvent(event, () => messageId ?? randomUUID()));
  }

  #resolveStreamMessageId(
    event: Extract<
      AppEvent,
      { type: "agent.message_delta" | "agent.message_complete" }
    >,
  ): string {
    const streamKey =
      event.agentInstanceId === undefined
        ? event.sdkSessionId === undefined
          ? "legacy"
          : `session:${event.sdkSessionId}`
        : `agent:${event.agentInstanceId}`;
    const activeMessageId =
      event.agentInstanceId === undefined
        ? this.#turn?.messageId
        : this.#managedTurns.get(event.agentInstanceId)?.messageId;
    const messageId =
      activeMessageId ?? this.#streamMessageIds.get(streamKey) ?? randomUUID();

    if (event.type === "agent.message_complete") {
      this.#streamMessageIds.delete(streamKey);
    } else {
      this.#streamMessageIds.set(streamKey, messageId);
    }
    return messageId;
  }

  #publishPendingActionableLifecycle(): void {
    const state = this.#pendingActionableLifecycle;
    if (state === undefined) return;
    this.#pendingActionableLifecycle = undefined;
    this.#lifecycle = state;
    this.emit({ type: "lifecycle.changed", state });
  }

  async #loadPreferences(): Promise<DesktopPreferences> {
    try {
      return await this.options.preferencesStore.load();
    } catch (error) {
      this.#report("Preferences could not be loaded, using defaults", error);
      return preferencesSchema.parse({});
    }
  }

  async #loadSessions(): Promise<DesktopSession[]> {
    try {
      return await this.options.sessionStore.load();
    } catch (error) {
      this.#report("Sessions could not be loaded", error);
      return [];
    }
  }

  async #loadProjectAssociations(): Promise<ProjectSessionAssociation[]> {
    if (this.options.projectSessionStore === undefined) {
      return this.#sessions
        .filter(
          (
            session,
          ): session is DesktopSession & {
            projectId: string;
          } => session.projectId !== undefined,
        )
        .filter(
          (session, index, sessions) =>
            sessions.findIndex(
              ({ projectId }) => projectId === session.projectId,
            ) === index,
        )
        .map((session) => ({
          projectId: session.projectId,
          projectName: session.projectName,
          sessionId: session.id,
          updatedAt: session.updatedAt,
        }));
    }
    try {
      return await this.options.projectSessionStore.load(this.#sessions);
    } catch (error) {
      this.#report("Project session associations could not be loaded", error);
      return [];
    }
  }

  async #restoreOrRegisterSession(
    identity: DesktopProjectIdentity | undefined,
  ): Promise<void> {
    this.#projectIdentity = identity;
    const associatedSession =
      identity?.saved === true
        ? this.#associatedSession(identity.projectId)
        : undefined;
    const startupSession =
      associatedSession ??
      (this.options.projectSessionStore === undefined
        ? this.#sessions[0]
        : undefined);
    if (this.options.agentCatalog !== undefined) {
      if (startupSession !== undefined) {
        const pendingLegacySdkSessionId =
          this.#selectedSdkSessionId(startupSession);
        if (
          startupSession.activeAgents.length === 0 &&
          pendingLegacySdkSessionId !== undefined
        ) {
          await this.#application.resumeAgentSession(pendingLegacySdkSessionId);
          this.#activeProductionSessionId = startupSession.id;
          this.#publishAutoApprovedAgentIds();
          this.emit({
            type: "session.context_restored",
            session: startupSession,
          });
          return;
        }
        try {
          startupSession.activeAgents =
            await this.#resumeManagedAgents(startupSession);
          this.#activeProductionSessionId = startupSession.id;
          await this.#touchSession(startupSession.id);
          this.#publishAutoApprovedAgentIds();
          const restored = this.#sessions.find(
            ({ id }) => id === startupSession.id,
          );
          if (restored !== undefined) {
            this.emit({ type: "session.context_restored", session: restored });
          }
          return;
        } catch (error) {
          this.emit({
            type: "diagnostic",
            level: "warning",
            message: `Project session ${startupSession.id} could not be resumed (${
              error instanceof Error ? error.message : String(error)
            }); a new session was started.`,
          });
        }
      }
      await this.#createManagedProductionSession(
        "Production session",
        identity,
      );
      return;
    }
    const initialSdkSessionId = this.#application.agentSessionId;
    if (initialSdkSessionId === undefined) return;
    if (startupSession !== undefined) {
      const sdkSessionId = this.#selectedSdkSessionId(startupSession);
      try {
        if (sdkSessionId === undefined) {
          throw new Error("selected agent has no SDK session");
        }
        await this.#application.resumeAgentSession(sdkSessionId);
        this.#activeProductionSessionId = startupSession.id;
        await this.#touchSession(startupSession.id);
        this.#publishAutoApprovedAgentIds();
        const restored = this.#sessions.find(
          (session) => session.id === startupSession.id,
        );
        if (restored !== undefined) {
          this.emit({ type: "session.context_restored", session: restored });
        }
        return;
      } catch (error) {
        this.emit({
          type: "diagnostic",
          level: "warning",
          message: `Project session ${startupSession.id} could not be resumed (${
            error instanceof Error ? error.message : String(error)
          }); a new session was started.`,
        });
      }
    }
    const currentSdkSessionId =
      this.#application.agentSessionId ?? initialSdkSessionId;
    await this.#rememberSession(
      currentSdkSessionId,
      "Production session",
      identity,
    );
  }

  async #rememberSession(
    sdkSessionId: string,
    title: string,
    identity = this.#projectIdentity,
  ): Promise<string> {
    const defaultDefinition =
      this.options.agentCatalog?.current.definitions.find(
        (definition) => definition.name === "default",
      );
    const activeAgent =
      defaultDefinition === undefined
        ? undefined
        : this.#activeAgentFromDefinition(defaultDefinition, sdkSessionId);
    const productionSessionId = randomUUID();
    this.#sdkSessionIds.set(productionSessionId, sdkSessionId);
    const session: DesktopSession = {
      version: 2,
      id: productionSessionId,
      title,
      updatedAt: new Date().toISOString(),
      projectName:
        identity?.projectName ??
        projectLabel(await this.#application.getStatus()),
      ...(identity?.saved === true ? { projectId: identity.projectId } : {}),
      mode: "explore",
      productionPlan: [],
      outputAssignments: [],
      ...(activeAgent === undefined
        ? { activeAgents: [] }
        : {
            activeAgents: [activeAgent],
            selectedAgentInstanceId: activeAgent.id,
          }),
    };
    this.#sessions = [session, ...this.#sessions].slice(0, storedSessionLimit);
    this.#activeProductionSessionId = productionSessionId;
    if (identity?.saved !== true) {
      this.#ephemeralSessionIds.add(productionSessionId);
    }
    await this.#persistSessions();
    await this.#associateActiveSession(identity);
    this.#publishAutoApprovedAgentIds();
    return productionSessionId;
  }

  async #createManagedProductionSession(
    title: string,
    identity = this.#projectIdentity,
  ): Promise<string> {
    const definition = this.#requireDefinition("default");
    const productionSessionId = randomUUID();
    const activeAgent = this.#activeAgentFromDefinition(definition);
    const sdkSessionId = await this.#application.createManagedAgent(
      this.#managedConfiguration(activeAgent),
    );
    const connected = { ...activeAgent, sdkSessionId };
    const session: DesktopSession = {
      version: 2,
      id: productionSessionId,
      title,
      updatedAt: new Date().toISOString(),
      projectName:
        identity?.projectName ??
        projectLabel(await this.#application.getStatus()),
      ...(identity?.saved === true ? { projectId: identity.projectId } : {}),
      activeAgents: [connected],
      selectedAgentInstanceId: connected.id,
      mode: "explore",
      productionPlan: [],
      outputAssignments: [],
    };
    session.activeAgents = await this.#switchManagedProductionSession(
      this.#activeSession(),
      session,
      true,
    );
    this.#sessions = [session, ...this.#sessions].slice(0, storedSessionLimit);
    this.#activeProductionSessionId = productionSessionId;
    if (identity?.saved !== true) {
      this.#ephemeralSessionIds.add(productionSessionId);
    }
    await this.#persistSessions();
    await this.#associateActiveSession(identity);
    this.#publishAutoApprovedAgentIds();
    this.emit({
      type: "agent.instance_changed",
      instance: connected,
      change: "created",
    });
    return productionSessionId;
  }

  async #resumeManagedAgents(
    session: DesktopSession,
  ): Promise<DesktopActiveAgent[]> {
    if (session.activeAgents.length === 0) {
      throw new Error("Production session has no active agent instances");
    }
    const resumed: DesktopActiveAgent[] = [];
    try {
      for (const instance of session.activeAgents) {
        if (instance.sdkSessionId === undefined) {
          throw new Error(`Agent instance '${instance.id}' has no SDK session`);
        }
        const resolved = await this.#resolveAgentBindings(instance);
        await this.#application.resumeManagedAgent(
          this.#managedConfiguration(resolved),
          instance.sdkSessionId,
        );
        resumed.push(resolved);
      }
      return resumed;
    } catch (error) {
      const rollbackErrors = await this.#deactivateAgents(resumed);
      throw this.#sessionSwitchError(
        session.id,
        "resume target agents",
        error,
        rollbackErrors,
      );
    }
  }

  async #switchManagedProductionSession(
    previous: DesktopSession | undefined,
    target: DesktopSession,
    targetAlreadyActive = false,
  ): Promise<DesktopActiveAgent[]> {
    const resumed = targetAlreadyActive
      ? target.activeAgents
      : await this.#resumeManagedAgents(target);

    const deactivatedPrevious: DesktopActiveAgent[] = [];
    try {
      for (const instance of previous?.activeAgents ?? []) {
        await this.#application.deactivateManagedAgent(instance.id);
        deactivatedPrevious.push(instance);
      }
    } catch (error) {
      const rollbackErrors = await this.#deactivateAgents(resumed);
      for (const instance of deactivatedPrevious) {
        try {
          if (instance.sdkSessionId === undefined) {
            throw new Error(
              `Agent instance '${instance.id}' has no SDK session`,
            );
          }
          await this.#application.resumeManagedAgent(
            this.#managedConfiguration(instance),
            instance.sdkSessionId,
          );
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      throw this.#sessionSwitchError(
        target.id,
        "deactivate previous agents",
        error,
        rollbackErrors,
      );
    }
    return resumed;
  }

  async #deactivateAgents(
    agents: readonly DesktopActiveAgent[],
  ): Promise<unknown[]> {
    const errors: unknown[] = [];
    for (const { id } of agents) {
      try {
        await this.#application.deactivateManagedAgent(id);
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  }

  #sessionSwitchError(
    sessionId: string,
    phase: string,
    cause: unknown,
    rollbackErrors: readonly unknown[],
  ): Error {
    const detail = cause instanceof Error ? cause.message : String(cause);
    if (rollbackErrors.length === 0) {
      return new Error(
        `Could not switch to production session '${sessionId}' during ${phase}: ${detail}`,
        { cause },
      );
    }
    return new AggregateError(
      [cause, ...rollbackErrors],
      `Could not switch to production session '${sessionId}' during ${phase}; rollback also failed`,
    );
  }

  #managedConfiguration(
    instance: DesktopActiveAgent,
  ): AgentSessionConfiguration {
    const inheritedContext = this.#forkedHistoryContext(instance);
    return {
      instanceId: instance.id,
      definitionName: instance.definitionName,
      label: instance.label,
      description: instance.config.description,
      systemPrompt:
        inheritedContext === ""
          ? instance.config.systemPrompt
          : `${instance.config.systemPrompt}\n\n${inheritedContext}`,
      resolvedTools: instance.config.resolvedTools,
      editScope: instance.config.editScope,
      boundTracks: instance.boundTracks,
      skills: instance.config.skills,
      availableSkills: this.options.agentCatalog?.runtimeSkills ?? [],
    };
  }

  #forkedHistoryContext(instance: DesktopActiveAgent): string {
    const history = instance.forkedHistory ?? [];
    if (history.length === 0) return "";
    const lines = [
      "The following conversation was carried forward from a prior Live Set session. Treat it as conversation context, but inspect the current Live Set before relying on project-specific facts.",
    ];
    let characters = lines[0]!.length;
    for (const message of history) {
      const line = `${message.role === "user" ? "User" : "Assistant"}: ${message.content}`;
      if (characters + line.length > forkedHistoryCharacterLimit) break;
      lines.push(line);
      characters += line.length;
    }
    return lines.join("\n");
  }

  #activeAgentFromDefinition(
    definition: DesktopAgentDefinition,
    sdkSessionId?: string,
    instanceId: string = randomUUID(),
  ): DesktopActiveAgent {
    return {
      id: instanceId,
      definitionName: definition.name,
      definitionFingerprint: definition.fingerprint,
      label:
        definition.name === "default"
          ? "Default"
          : `${definition.name[0]?.toUpperCase()}${definition.name.slice(1)}`,
      autoApprove: false,
      forkedHistory: [],
      config: {
        description: definition.description,
        systemPrompt: definition.systemPrompt,
        tools: definition.tools,
        resolvedTools: definition.resolvedTools,
        editScope: definition.editScope,
        skills: definition.skills,
        inputChannels: definition.inputChannels,
      },
      ...(sdkSessionId === undefined ? {} : { sdkSessionId }),
      lifecycle: "ready",
      boundTracks: [],
      modified: false,
      outputSubscriptions: [...new Set(definition.inputChannels)].map(
        (producerId) => ({
          assignmentId: createAgentInstanceAssignmentId(instanceId, producerId),
          producerId,
          enabled: true,
          deliveryMode: "next-prompt",
          usageInstruction: DEFAULT_SIGNAL_USAGE_INSTRUCTION,
          processingPolicyIds: ["latest-window"],
        }),
      ),
    };
  }

  #migrateAgentModes(catalog: DesktopAgentCatalog): boolean {
    let changed = false;
    this.#sessions = this.#sessions.map((session) => {
      if (session.activeAgents.length > 0) return session;
      const definitionName =
        session.mode === "explore" ? "default" : session.mode;
      const definition = catalog.definitions.find(
        (candidate) => candidate.name === definitionName,
      );
      if (definition === undefined) {
        if (legacySdkSessionId(session) !== undefined) {
          this.emit({
            type: "diagnostic",
            level: "warning",
            message: `Legacy session '${session.id}' was not migrated because canonical agent definition '${definitionName}' is unavailable; its SDK resume linkage and production data were preserved.`,
          });
        }
        return session;
      }
      const sdkSessionId = legacySdkSessionId(session);
      if (sdkSessionId === undefined) return session;
      const activeAgent = {
        ...this.#activeAgentFromDefinition(definition, sdkSessionId),
        outputSubscriptions: session.outputAssignments,
      };
      changed = true;
      let productionSessionId = randomUUID();
      while (productionSessionId === sdkSessionId) {
        productionSessionId = randomUUID();
      }
      this.#sdkSessionIds.set(productionSessionId, sdkSessionId);
      return {
        ...session,
        id: productionSessionId,
        activeAgents: [activeAgent],
        selectedAgentInstanceId: activeAgent.id,
      };
    });
    return changed;
  }

  async #touchSession(sessionId: string): Promise<void> {
    const touched = this.#sessions.find((session) => session.id === sessionId);
    if (!touched) return;
    this.#sessions = [
      { ...touched, updatedAt: new Date().toISOString() },
      ...this.#sessions.filter((session) => session.id !== sessionId),
    ];
    await this.#persistSessions();
  }

  async #updateActiveSessionInTransaction(
    update: Partial<
      Pick<
        DesktopSession,
        | "mode"
        | "productionPlan"
        | "projectId"
        | "projectName"
        | "outputAssignments"
      >
    >,
  ): Promise<void> {
    const sessionId = this.#activeProductionSessionId;
    if (sessionId === undefined) return;
    const current = this.#sessions.find((session) => session.id === sessionId);
    if (current === undefined) return;
    const next =
      update.outputAssignments === undefined
        ? { ...current, ...update }
        : {
            ...current,
            ...update,
            activeAgents: current.activeAgents.map((agent) =>
              agent.id === current.selectedAgentInstanceId
                ? {
                    ...agent,
                    outputSubscriptions: update.outputAssignments ?? [],
                  }
                : agent,
            ),
          };
    this.#sessions = [
      { ...next, updatedAt: new Date().toISOString() },
      ...this.#sessions.filter((session) => session.id !== sessionId),
    ];
    await this.#persistSessions();
  }

  async #persistSessions(): Promise<void> {
    const snapshot = this.#sessions.filter(
      ({ id }) => !this.#ephemeralSessionIds.has(id),
    );
    try {
      await this.options.sessionStore.save(snapshot);
    } catch (error) {
      this.#report("Sessions could not be saved", error);
    }
    this.emit({
      type: "sessions.changed",
      sessions: [...this.#sessions],
      ...(this.#activeProductionSessionId === undefined
        ? {}
        : { activeSessionId: this.#activeProductionSessionId }),
    });
  }

  #associatedSession(projectId: string): DesktopSession | undefined {
    const association = this.#projectAssociations.find(
      (candidate) => candidate.projectId === projectId,
    );
    return association === undefined
      ? undefined
      : this.#sessions.find(({ id }) => id === association.sessionId);
  }

  async #associateActiveSession(
    identity: DesktopProjectIdentity | undefined,
  ): Promise<void> {
    if (
      identity?.saved !== true ||
      this.#activeProductionSessionId === undefined
    ) {
      return;
    }
    const association: ProjectSessionAssociation = {
      projectId: identity.projectId,
      projectName: identity.projectName,
      sessionId: this.#activeProductionSessionId,
      updatedAt: new Date().toISOString(),
    };
    this.#projectAssociations = [
      association,
      ...this.#projectAssociations.filter(
        ({ projectId }) => projectId !== identity.projectId,
      ),
    ];
    if (this.options.projectSessionStore !== undefined) {
      await this.options.projectSessionStore.save(this.#projectAssociations);
    }
  }

  async #queueSessionAction<T>(action: () => Promise<T>): Promise<T> {
    this.#pendingSessionActions += 1;
    const result = this.#sessionActionTail.then(action);
    this.#sessionActionTail = result.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await result;
    } finally {
      this.#pendingSessionActions -= 1;
    }
  }

  #queueAgentAction<T>(
    instanceId: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const previous =
      this.#agentActionTails.get(instanceId) ?? Promise.resolve();
    const result = previous.then(action, action);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.#agentActionTails.set(instanceId, tail);
    void tail.finally(() => {
      if (this.#agentActionTails.get(instanceId) === tail) {
        this.#agentActionTails.delete(instanceId);
      }
    });
    return result;
  }

  #queueAgentActions<T>(
    instanceIds: readonly string[],
    action: () => Promise<T>,
  ): Promise<T> {
    const [instanceId, ...remaining] = instanceIds;
    if (instanceId === undefined) return action();
    return this.#queueAgentAction(instanceId, () =>
      this.#queueAgentActions(remaining, action),
    );
  }

  #captureActiveAgentTarget(agentInstanceId: string): ActiveAgentTarget {
    this.#assertAccepting();
    const productionSessionId = this.#activeProductionSessionId;
    if (productionSessionId === undefined) {
      throw new Error("No active production session");
    }
    return { productionSessionId, agentInstanceId };
  }

  #queueActiveAgentAction<T>(
    target: ActiveAgentTarget,
    action: (resolved: ResolvedActiveAgentTarget) => Promise<T>,
  ): Promise<T> {
    return this.#queueActiveAgentTransaction(
      target,
      async () => undefined,
      (resolved) => action(resolved),
    );
  }

  #queueActiveAgentTransaction<TPrepared, TResult>(
    target: ActiveAgentTarget,
    prepare: (resolved: ResolvedActiveAgentTarget) => Promise<TPrepared>,
    commit: (
      resolved: ResolvedActiveAgentTarget,
      prepared: TPrepared,
    ) => Promise<TResult>,
    rollback?: (
      original: ResolvedActiveAgentTarget,
      prepared: TPrepared,
    ) => Promise<void>,
  ): Promise<TResult> {
    return this.#queueAgentAction(target.agentInstanceId, async () => {
      const original = await this.#queueSessionAction(async () =>
        this.#resolveActiveAgentTarget(target),
      );
      const prepared = await prepare(original);
      let commitStarted = false;
      try {
        return await this.#queueSessionAction(async () => {
          const resolved = this.#resolveActiveAgentTarget(
            target,
            original.instance,
          );
          commitStarted = true;
          return commit(resolved, prepared);
        });
      } catch (error) {
        if (!commitStarted && rollback !== undefined) {
          try {
            await rollback(original, prepared);
          } catch (rollbackError) {
            throw new AggregateError(
              [error, rollbackError],
              `Agent instance '${target.agentInstanceId}' transaction failed and rollback was incomplete`,
            );
          }
        }
        throw error;
      }
    });
  }

  #resolveActiveAgentTarget(
    target: ActiveAgentTarget,
    expectedInstance?: DesktopActiveAgent,
  ): ResolvedActiveAgentTarget {
    const session = this.#requireExpectedActiveSession(
      target.productionSessionId,
    );
    const instance = session.activeAgents.find(
      ({ id }) => id === target.agentInstanceId,
    );
    if (instance === undefined) {
      throw new Error(
        `Agent instance '${target.agentInstanceId}' not found in production session '${target.productionSessionId}'`,
      );
    }
    if (expectedInstance !== undefined && instance !== expectedInstance) {
      throw new Error(
        `Agent instance '${target.agentInstanceId}' changed in production session '${target.productionSessionId}' while the operation was preparing`,
      );
    }
    return { session, instance };
  }

  async #rollbackAgentConfiguration(
    instance: DesktopActiveAgent,
  ): Promise<void> {
    if (this.#application.getManagedAgentSessionId(instance.id) === undefined) {
      return;
    }
    await this.#application.reconfigureManagedAgent(
      this.#managedConfiguration(instance),
    );
  }

  async #rollbackDeactivatedAgent(
    original: ResolvedActiveAgentTarget,
  ): Promise<void> {
    await this.#queueSessionAction(async () => {
      const currentSession = this.#activeSession();
      const currentInstance = currentSession?.activeAgents.find(
        ({ id }) => id === original.instance.id,
      );
      const shouldRestore =
        this.#acceptingActions &&
        currentSession?.id === original.session.id &&
        currentInstance?.sdkSessionId === original.instance.sdkSessionId;

      if (!shouldRestore || currentInstance === undefined) {
        await this.#reconcileDeactivatedAgentOwnership(original.instance);
        return;
      }
      if (
        this.#application.getManagedAgentSessionId(currentInstance.id) !==
        undefined
      ) {
        this.#bindActiveOutputAssignments();
        return;
      }
      if (currentInstance.sdkSessionId === undefined) {
        throw new Error(
          `Agent instance '${currentInstance.id}' has no SDK session`,
        );
      }
      try {
        await this.#application.resumeManagedAgent(
          this.#managedConfiguration(currentInstance),
          currentInstance.sdkSessionId,
        );
        this.#bindActiveOutputAssignments();
      } catch (restoreError) {
        try {
          await this.#reconcileDeactivatedAgentOwnership(
            original.instance,
            true,
          );
        } catch (cleanupError) {
          throw new AggregateError(
            [restoreError, cleanupError],
            `Agent instance '${currentInstance.id}' restore and cleanup both failed`,
          );
        }
        throw restoreError;
      }
    });
  }

  async #reconcileDeactivatedAgentOwnership(
    original: DesktopActiveAgent,
    forceCleanup = false,
  ): Promise<void> {
    const runtimeSdkSessionId = this.#application.getManagedAgentSessionId(
      original.id,
    );
    const activeInstance = this.#activeSession()?.activeAgents.find(
      ({ id }) => id === original.id,
    );
    const runtimeBelongsToActiveInstance =
      !forceCleanup &&
      this.#acceptingActions &&
      runtimeSdkSessionId !== undefined &&
      activeInstance?.sdkSessionId === runtimeSdkSessionId;
    let cleanupError: unknown;
    if (runtimeSdkSessionId !== undefined && !runtimeBelongsToActiveInstance) {
      try {
        await this.#application.deactivateManagedAgent(original.id);
      } catch (error) {
        cleanupError = error;
      }
    }
    if (this.#acceptingActions) {
      this.#bindActiveOutputAssignments();
      if (forceCleanup) {
        this.#signals.removeActiveAgentInstance(original.id);
        for (const { assignmentId } of original.outputSubscriptions) {
          this.#signals.removeAssignment(assignmentId);
        }
      }
    } else {
      this.#clearRuntimeAssignments();
    }
    if (cleanupError !== undefined) {
      throw cleanupError instanceof Error
        ? cleanupError
        : new Error("Agent cleanup failed", { cause: cleanupError });
    }
  }

  async #drainAgentActions(): Promise<void> {
    while (this.#agentActionTails.size > 0) {
      const snapshot = [...this.#agentActionTails.entries()];
      await Promise.all(snapshot.map(([, tail]) => tail));
      for (const [instanceId, tail] of snapshot) {
        if (this.#agentActionTails.get(instanceId) === tail) {
          this.#agentActionTails.delete(instanceId);
        }
      }
    }
  }

  #report(message: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    this.options.onError?.(message, { error: detail });
    this.emit({
      type: "diagnostic",
      level: "error",
      message: `${message}: ${detail}`,
    });
  }

  private emit(event: DesktopAppEvent): void {
    for (const listener of this.#listeners) listener(event);
  }

  public async listOutputs(): Promise<DesktopOutputsState> {
    return this.#outputsState();
  }

  public async assignOutput(
    agentInstanceId: string,
    producerId: string,
  ): Promise<DesktopOutputAssignment> {
    const target = this.#captureActiveAgentTarget(agentInstanceId);
    return this.#queueActiveAgentAction(
      target,
      async ({ session, instance }) => {
        const existing = instance.outputSubscriptions.find(
          (assignment) => assignment.producerId === producerId,
        );
        if (existing !== undefined) {
          return { ...existing, agentInstanceId };
        }
        const assignment: OutputSubscription = {
          assignmentId: createAgentInstanceAssignmentId(
            agentInstanceId,
            producerId,
          ),
          producerId,
          enabled: true,
          deliveryMode: "next-prompt",
          usageInstruction: DEFAULT_SIGNAL_USAGE_INSTRUCTION,
          processingPolicyIds: ["latest-window"],
        };
        await this.#updateOutputAssignment(session, instance, assignment);
        return { ...assignment, agentInstanceId };
      },
    );
  }

  public async unassignOutput(
    agentInstanceId: string,
    producerId: string,
  ): Promise<boolean> {
    const target = this.#captureActiveAgentTarget(agentInstanceId);
    return this.#queueActiveAgentAction(
      target,
      async ({ session, instance }) => {
        const assignment = instance.outputSubscriptions.find(
          (item) => item.producerId === producerId,
        );
        if (assignment === undefined) return false;
        this.#signals.removeAssignment(assignment.assignmentId);
        await this.#replaceOutputAssignments(
          session,
          instance,
          instance.outputSubscriptions.filter(
            (item) => item.assignmentId !== assignment.assignmentId,
          ),
        );
        return true;
      },
    );
  }

  public setOutputEnabled(
    agentInstanceId: string,
    producerId: string,
    enabled: boolean,
  ): Promise<DesktopOutputAssignment> {
    return this.#editOutput(agentInstanceId, producerId, { enabled });
  }

  public setOutputDeliveryMode(
    agentInstanceId: string,
    producerId: string,
    deliveryMode: OutputDeliveryMode,
  ): Promise<DesktopOutputAssignment> {
    return this.#editOutput(agentInstanceId, producerId, { deliveryMode });
  }

  public setOutputUsageInstruction(
    agentInstanceId: string,
    producerId: string,
    usageInstruction: string,
  ): Promise<DesktopOutputAssignment> {
    return this.#editOutput(agentInstanceId, producerId, { usageInstruction });
  }

  public setOutputProcessingPolicies(
    agentInstanceId: string,
    producerId: string,
    processingPolicyIds: string[],
  ): Promise<DesktopOutputAssignment> {
    return this.#editOutput(agentInstanceId, producerId, {
      processingPolicyIds,
    });
  }

  #onSignalEvent(event: SignalRuntimeEvent): void {
    this.#logger.debug("Signal runtime event received", { event });
    if (event.type === "diagnostic") {
      this.emit({
        type: "diagnostic",
        level: event.level,
        message: event.message,
      });
      return;
    }
    if (event.type === "latest-window.changed") {
      if (event.context === undefined) {
        this.#latestOutputs.delete(event.assignmentId);
      } else {
        this.#latestOutputs.set(event.assignmentId, {
          assignmentId: event.assignmentId,
          producerId: event.context.producerId,
          sequence: event.context.sequence,
          capturedAt: event.context.capturedAt,
          summary: event.context.content.slice(0, 2048),
        });
        while (this.#latestOutputs.size > 100) {
          const oldest = this.#latestOutputs.keys().next().value;
          if (oldest === undefined) break;
          this.#latestOutputs.delete(oldest);
        }
      }
    }
    this.#emitOutputs();
  }

  #outputsState(): DesktopOutputsState {
    const currentByProducer = new Map<string, DesktopOutputConnection>();
    for (const connection of this.#signals.listConnections()) {
      if (connection.status === "disconnected") continue;
      const producerId = connection.producer.producerId;
      const previous = currentByProducer.get(producerId);
      if (
        previous !== undefined &&
        previous.state === "connected" &&
        connection.status !== "connected"
      ) {
        continue;
      }
      currentByProducer.set(producerId, {
        connectionId: connection.connectionId,
        producerId,
        instanceId: connection.producer.instanceId,
        displayName: connection.producer.displayName,
        signalKind: connection.producer.signalKind,
        state: connection.status,
        receiving: [...this.#latestOutputs.values()].some(
          (latest) => latest.producerId === producerId,
        ),
        lastHeartbeatAt: connection.lastHeartbeatAt,
        ...(connection.producer.track === undefined
          ? {}
          : { track: connection.producer.track }),
        ...(connection.producer.device === undefined
          ? {}
          : { device: connection.producer.device }),
      });
    }
    return {
      status: this.#signals.getStatus(),
      connections: [...currentByProducer.values()],
      assignments:
        this.#activeSession()?.activeAgents.flatMap((agent) =>
          agent.outputSubscriptions.map((assignment) => ({
            ...assignment,
            agentInstanceId: agent.id,
          })),
        ) ?? [],
      latest: [...this.#latestOutputs.values()],
      ...(this.#activeProductionSessionId === undefined
        ? {}
        : { activeSessionId: this.#activeProductionSessionId }),
    };
  }

  async #resolveAgentBindings(
    instance: DesktopActiveAgent,
  ): Promise<DesktopActiveAgent> {
    if (instance.config.editScope.includes("session")) {
      return { ...instance, boundTracks: [] };
    }

    const status = await this.#application.getStatus();
    if (status.state !== "connected") {
      throw Object.assign(
        new Error(
          `Cannot resolve edit scope for agent '${instance.label}' while Ableton is disconnected`,
        ),
        { code: "binding_missing" },
      );
    }
    const snapshot = await this.#application.inspectSession();
    const boundTracks: BoundTrackScope[] = instance.config.editScope.map(
      (selector) => {
        if (selector === "session") {
          throw Object.assign(
            new Error("Session scope cannot be mixed with track selectors"),
            { code: "binding_ambiguous" },
          );
        }
        const matchingTracks = snapshot.tracks.filter(
          (track) => track.name === selector.track.name,
        );
        const track = matchingTracks[selector.track.occurrence];
        if (track === undefined) {
          throw Object.assign(
            new Error(
              `Track selector '${selector.track.name}' occurrence ${selector.track.occurrence} does not match the current Live set`,
            ),
            { code: "binding_missing" },
          );
        }
        return {
          selector,
          projectId: status.projectId,
          trackReference: track.reference,
          trackIndex: track.index,
          expectedName: track.name,
        };
      },
    );
    return { ...instance, boundTracks };
  }

  #emitOutputs(): void {
    this.emit({ type: "outputs.changed", outputs: this.#outputsState() });
  }

  #activeSession(): DesktopSession | undefined {
    const sessionId = this.#activeProductionSessionId;
    return this.#sessions.find((session) => session.id === sessionId);
  }

  #requireActiveSession(): DesktopSession {
    const session = this.#activeSession();
    if (session === undefined) {
      throw new Error("No active production session");
    }
    return session;
  }

  #requireExpectedActiveSession(productionSessionId: string): DesktopSession {
    if (this.#activeProductionSessionId !== productionSessionId) {
      throw new Error(
        `Active production session changed from '${productionSessionId}' to '${this.#activeProductionSessionId ?? "none"}' while the operation was queued`,
      );
    }
    const session = this.#sessions.find(({ id }) => id === productionSessionId);
    if (session === undefined) {
      throw new Error(`Production session '${productionSessionId}' not found`);
    }
    return session;
  }

  #requireActiveAgent(instanceId: string): DesktopActiveAgent {
    const instance = this.#requireActiveSession().activeAgents.find(
      ({ id }) => id === instanceId,
    );
    if (instance === undefined) {
      throw new Error(`Agent instance '${instanceId}' not found`);
    }
    return instance;
  }

  #requireDefinition(definitionName: string): DesktopAgentDefinition {
    if (this.options.agentCatalog === undefined) {
      throw new Error("Agent definitions are not configured");
    }
    const definition = this.options.agentCatalog.current.definitions.find(
      ({ name }) => name === definitionName,
    );
    if (definition === undefined) {
      throw new Error(`Agent definition '${definitionName}' not found`);
    }
    return definition;
  }

  #publishAutoApprovedAgentIds(): void {
    const ids = new Set(
      (this.#activeSession()?.activeAgents ?? [])
        .filter(({ autoApprove }) => autoApprove)
        .map(({ id }) => id),
    );
    this.options.onAutoApprovedAgentIdsChange?.(ids);
  }

  async #replaceActiveProductionSession(
    session: DesktopSession,
  ): Promise<void> {
    this.#sessions = [
      { ...session, updatedAt: new Date().toISOString() },
      ...this.#sessions.filter(({ id }) => id !== session.id),
    ];
    await this.#persistSessions();
  }

  async #replaceActiveProductionSessionStrict(
    session: DesktopSession,
  ): Promise<void> {
    const sessions = [
      { ...session, updatedAt: new Date().toISOString() },
      ...this.#sessions.filter(({ id }) => id !== session.id),
    ];
    await this.options.sessionStore.save(
      sessions.filter(({ id }) => !this.#ephemeralSessionIds.has(id)),
    );
    this.#sessions = sessions;
    this.emit({
      type: "sessions.changed",
      sessions,
      ...(this.#activeProductionSessionId === undefined
        ? {}
        : { activeSessionId: this.#activeProductionSessionId }),
    });
  }

  async #replaceAgent(
    session: DesktopSession,
    instance: DesktopActiveAgent,
  ): Promise<void> {
    await this.#replaceActiveProductionSession({
      ...session,
      activeAgents: session.activeAgents.map((candidate) =>
        candidate.id === instance.id ? instance : candidate,
      ),
    });
  }

  async #setAgentLifecycle(
    target: ActiveAgentTarget,
    lifecycle: DesktopActiveAgent["lifecycle"],
  ): Promise<DesktopActiveAgent> {
    return this.#queueActiveAgentAction(
      target,
      async ({ session, instance }) => {
        const updated = { ...instance, lifecycle };
        await this.#replaceAgent(session, updated);
        this.emit({
          type: "agent.instance_changed",
          instance: updated,
          change: "lifecycle",
        });
        return updated;
      },
    );
  }

  async #beginManagedTurn(
    target: ActiveAgentTarget,
    run: () => Promise<string>,
    validate?: (instance: DesktopActiveAgent) => void,
  ): Promise<{ accepted: true; messageId: string }> {
    const messageId = randomUUID();
    const turn: ActiveTurn = { messageId, cancelRequested: false };
    const instance = await this.#queueActiveAgentAction(
      target,
      async ({ session, instance }) => {
        validate?.(instance);
        if (this.#managedTurns.has(target.agentInstanceId)) {
          throw new Error(
            `Agent instance '${target.agentInstanceId}' already in progress`,
          );
        }
        this.#managedTurns.set(target.agentInstanceId, turn);
        const busy = { ...instance, lifecycle: "busy" as const };
        await this.#replaceAgent(session, busy);
        this.emit({
          type: "agent.instance_changed",
          instance: busy,
          change: "lifecycle",
        });
        return busy;
      },
    );
    const attribution =
      instance.sdkSessionId === undefined
        ? { agentInstanceId: target.agentInstanceId }
        : {
            agentInstanceId: target.agentInstanceId,
            sdkSessionId: instance.sdkSessionId,
          };
    this.emit({
      type: "operation.changed",
      operation: {
        id: messageId,
        label: `Agent turn (${instance.label})`,
        status: "running",
        warnings: [],
        changed: [],
        unchanged: [],
        retryable: false,
        undoable: false,
        timestamp: Date.now(),
      },
      ...attribution,
    });
    void (async () => {
      try {
        await run();
        this.emit({
          type: "operation.changed",
          operation: {
            id: messageId,
            label: `Agent turn (${instance.label})`,
            status: "completed",
            detail: "The agent finished this turn.",
            warnings: [],
            changed: [],
            unchanged: [],
            retryable: false,
            undoable: false,
            timestamp: Date.now(),
          },
          ...attribution,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.emit({
          type: "operation.changed",
          operation: {
            id: messageId,
            label: `Agent turn (${instance.label})`,
            status: turn.cancelRequested ? "cancelled" : "failed",
            detail: turn.cancelRequested ? "Cancelled by you." : message,
            warnings: turn.cancelRequested ? [] : [message],
            changed: [],
            unchanged: [],
            retryable: false,
            undoable: false,
            timestamp: Date.now(),
          },
          ...attribution,
        });
        if (!turn.cancelRequested) {
          this.emit({ type: "diagnostic", level: "error", message });
        }
      } finally {
        this.#managedTurnCleanup.add(target.agentInstanceId);
        this.#managedTurns.delete(target.agentInstanceId);
        try {
          await this.#setAgentLifecycle(target, "ready");
        } catch {
          // The instance may have been removed or its session switched.
        } finally {
          this.#managedTurnCleanup.delete(target.agentInstanceId);
        }
      }
    })();
    return { accepted: true, messageId };
  }

  #selectedAgent(
    session: DesktopSession | undefined,
  ): DesktopActiveAgent | undefined {
    return session?.activeAgents.find(
      ({ id }) => id === session.selectedAgentInstanceId,
    );
  }

  #selectedSdkSessionId(
    session: DesktopSession | undefined,
  ): string | undefined {
    return (
      this.#selectedAgent(session)?.sdkSessionId ??
      (session === undefined
        ? undefined
        : this.#sdkSessionIds.get(session.id)) ??
      (session === undefined ? undefined : legacySdkSessionId(session))
    );
  }

  #clearRuntimeAssignments(): void {
    this.#signals.setActiveAgentInstances([]);
    for (const assignment of this.#signals.listAssignments()) {
      this.#signals.removeAssignment(assignment.assignmentId);
    }
  }

  #bindActiveOutputAssignments(): void {
    this.#clearRuntimeAssignments();
    const session = this.#activeSession();
    if (session === undefined) {
      this.#emitOutputs();
      return;
    }
    const activeAgentIds = session.activeAgents.map(({ id }) => id);
    this.#signals.setActiveAgentInstances(activeAgentIds);
    const activeAssignmentIds = new Set(
      session.activeAgents.flatMap((agent) =>
        agent.outputSubscriptions.map(({ assignmentId }) => assignmentId),
      ),
    );
    for (const assignmentId of this.#latestOutputs.keys()) {
      if (!activeAssignmentIds.has(assignmentId)) {
        this.#latestOutputs.delete(assignmentId);
      }
    }
    for (const agent of session.activeAgents) {
      for (const assignment of agent.outputSubscriptions) {
        this.#signals.upsertAssignment({
          ...assignment,
          consumer: { kind: "agent-instance", id: agent.id },
        });
      }
    }
    this.#emitOutputs();
  }

  async #withSuspendedSignals<T>(action: () => Promise<T>): Promise<T> {
    this.#clearRuntimeAssignments();
    try {
      const result = await action();
      this.#bindActiveOutputAssignments();
      return result;
    } catch (error) {
      this.#bindActiveOutputAssignments();
      throw error;
    }
  }

  async #replaceOutputAssignments(
    session: DesktopSession,
    instance: DesktopActiveAgent,
    outputAssignments: OutputSubscription[],
  ): Promise<void> {
    await this.#replaceActiveProductionSession({
      ...session,
      activeAgents: session.activeAgents.map((agent) =>
        agent.id === instance.id
          ? { ...agent, outputSubscriptions: outputAssignments }
          : agent,
      ),
      ...(session.selectedAgentInstanceId === instance.id
        ? { outputAssignments }
        : {}),
    });
    this.#bindActiveOutputAssignments();
  }

  async #updateOutputAssignment(
    session: DesktopSession,
    instance: DesktopActiveAgent,
    assignment: OutputSubscription,
  ): Promise<void> {
    await this.#replaceOutputAssignments(session, instance, [
      assignment,
      ...instance.outputSubscriptions.filter(
        (item) => item.producerId !== assignment.producerId,
      ),
    ]);
  }

  async #editOutput(
    agentInstanceId: string,
    producerId: string,
    update: Partial<
      Pick<
        OutputSubscription,
        "enabled" | "deliveryMode" | "usageInstruction" | "processingPolicyIds"
      >
    >,
  ): Promise<DesktopOutputAssignment> {
    const target = this.#captureActiveAgentTarget(agentInstanceId);
    return this.#queueActiveAgentAction(
      target,
      async ({ session, instance }) => {
        const assignment = instance.outputSubscriptions.find(
          (item) => item.producerId === producerId,
        );
        if (assignment === undefined) throw new Error("Output is not assigned");
        const updated = { ...assignment, ...update };
        await this.#updateOutputAssignment(session, instance, updated);
        return { ...updated, agentInstanceId };
      },
    );
  }

  #assertAccepting(allowPendingTransition = false): void {
    if (!this.#acceptingActions) {
      throw new Error("Desktop service is not accepting actions");
    }
    if (
      !allowPendingTransition &&
      (this.#pendingProjectTransition !== undefined ||
        this.#transitionCommitting)
    ) {
      throw new Error("A Live Set transition decision is required");
    }
  }
}
