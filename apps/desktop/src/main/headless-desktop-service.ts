import { randomUUID } from "node:crypto";

import {
  DEFAULT_SIGNAL_USAGE_INSTRUCTION,
  type HeadlessApplication,
} from "@ableton-agent/application";
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

import {
  preferencesSchema,
  type ApprovalDecision,
  type ContextChip,
  type DesktopAppEvent,
  type DesktopConnectionStatus,
  type DiagnosticCheck,
  type DesktopLifecycleState,
  type DesktopOutputAssignment,
  type DesktopOutputConnection,
  type DesktopOutputsState,
  type DesktopPreferences,
  type DesktopProjectSnapshot,
  type DesktopSession,
  type PlanSection,
  type ProductMode,
  type LatestAcceptedOutput,
  type OutputDeliveryMode,
} from "../contracts.js";
import type { ApprovalCoordinator } from "./approvals.js";
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

/** Devices and parameters read per track when building a project snapshot. */
const deviceReadLimit = 32;
const parameterReadLimit = 64;
const diagnosticMessageLimit = 512;
/** The sessions view shows the most recent entries; older ones are dropped. */
const storedSessionLimit = 100;

export interface HeadlessDesktopServiceOptions {
  application: HeadlessApplication;
  approvals: ApprovalCoordinator;
  preferencesStore: JsonPreferencesStore;
  sessionStore: JsonSessionStore;
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
  logger?: Logger;
}

interface ActiveTurn {
  messageId: string;
  cancelRequested: boolean;
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
  #sessionSaveTail: Promise<void> = Promise.resolve();
  #sessionActionTail: Promise<void> = Promise.resolve();
  #pendingSessionActions = 0;
  #lifecycle: DesktopLifecycleState = "stopped";
  #pinnedContext: ContextChip[] = [];
  #turn: ActiveTurn | undefined;
  #acceptingActions = false;
  #latestOutputs = new Map<string, LatestAcceptedOutput>();
  #snapshotRefresh: Promise<DesktopProjectSnapshot> | undefined;

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
    this.#unsubscribeApprovals = this.#approvals.setPublisher((approval) => {
      if (this.#listeners.size === 0) return false;
      this.emit({ type: "approval.requested", approval });
      return true;
    });
    this.#unsubscribeSignals = this.#signals.subscribe((event) =>
      this.#onSignalEvent(event),
    );
    this.#preferences = await this.#loadPreferences();
    this.#sessions = await this.#loadSessions();
    this.emit({ type: "preferences.changed", preferences: this.#preferences });
    this.emit({ type: "sessions.changed", sessions: this.#sessions });

    try {
      await this.#signals.start();
    } catch (error) {
      this.#report("Signal ingress startup failed", error);
    }
    try {
      const preferredAgentSessionId = this.#sessions[0]?.id;
      await this.#application.start({
        startAgent: true,
        ...(preferredAgentSessionId === undefined
          ? {}
          : { preferredAgentSessionId }),
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
    await this.#restoreOrRegisterSession();
    this.#bindActiveOutputAssignments();
    this.#acceptingActions = true;
    this.#emitOutputs();
    if ((await this.#application.getStatus()).state === "connected") {
      try {
        await this.getSnapshot();
      } catch (error) {
        this.#report("Project snapshot could not be read", error);
      }
    }
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
    this.#approvals.denyAll();
    await this.#preferenceSaveTail;
    await this.#sessionActionTail;
    await this.#sessionSaveTail;
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
    this.#turn = turn;
    const selection = this.#withPinnedContext(context);
    this.#logger.debug("Desktop agent turn accepted", {
      messageId,
      message,
      context: selection,
      mode,
    });
    await this.#updateActiveSession({ mode });
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
      return this.#withSuspendedSignals(async () => {
        const sessionId = await this.#application.createAgentSession();
        await this.#rememberSession(sessionId, "New production session");
        return sessionId;
      });
    });
  }

  public async getSessions(): Promise<DesktopSession[]> {
    return [...this.#sessions];
  }

  public async resumeSession(sessionId: string): Promise<void> {
    this.#assertAccepting();
    await this.#queueSessionAction(async () => {
      if (!this.#sessions.some((session) => session.id === sessionId)) {
        throw new Error("Session not found");
      }
      if (this.#turn) {
        throw new Error(
          "Cannot resume a session while an agent turn is running",
        );
      }
      await this.#withSuspendedSignals(async () => {
        await this.#application.resumeAgentSession(sessionId);
        await this.#touchSession(sessionId);
      });
      const session = this.#sessions.find((item) => item.id === sessionId);
      if (session !== undefined) {
        this.#pinnedContext = [];
        this.emit({ type: "session.context_restored", session });
      }
      this.emit({
        type: "diagnostic",
        level: "info",
        message: `Resumed agent session ${sessionId}.`,
      });
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

  public getStatus(): Promise<DesktopConnectionStatus> {
    return this.#application.getStatus();
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
    const coreSnapshot = toDesktopSnapshot(snapshot, status);
    this.#logger.debug("Project core snapshot read", {
      refreshId,
      snapshot,
      durationMs: Date.now() - startedAt,
    });
    await this.#syncProjectAssociation(coreSnapshot.id, coreSnapshot.name);
    this.emit({
      type: "project.snapshot_changed",
      snapshot: coreSnapshot,
    });

    const trackDevices = await this.#readTrackDevices(snapshot);
    const enrichedSnapshot = toDesktopSnapshot(snapshot, status, trackDevices);
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
    const previous = this.#preferences;
    const update = this.#preferenceSaveTail.then(async () => {
      await this.options.preferencesStore.save(preferences);
      this.#preferences = preferences;
      this.emit({
        type: "preferences.changed",
        preferences: this.#preferences,
      });
    });
    this.#preferenceSaveTail = update.catch(() => undefined);
    await update;
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
    return this.#preferences;
  }

  public async setContext(context: ContextChip[]): Promise<void> {
    this.#pinnedContext = [...context];
    this.emit({
      type: "diagnostic",
      level: "info",
      message: `Context updated with ${this.#pinnedContext.length} selection(s); it is included with every message until you change it.`,
    });
  }

  public async updatePlan(sections: PlanSection[]): Promise<void> {
    await this.#updateActiveSession({ productionPlan: sections });
    this.emit({
      type: "diagnostic",
      level: "info",
      message: `Production plan saved with ${sections.length} section(s). It is restored with this session but is not automatically applied to Live.`,
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
      this.#lifecycle = event.state;
    }
    this.emit(
      normalizeSharedEvent(event, () => this.#turn?.messageId ?? randomUUID()),
    );
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

  /**
   * Continues the most recent stored conversation on a cold start, and only
   * records a brand new one when no stored session can be reopened.
   */
  async #restoreOrRegisterSession(): Promise<void> {
    const sessionId = this.#application.agentSessionId;
    if (sessionId === undefined) return;
    const [latest] = this.#sessions;
    if (latest !== undefined) {
      try {
        await this.#application.resumeAgentSession(latest.id);
        await this.#touchSession(latest.id);
        const restored = this.#sessions.find(
          (session) => session.id === latest.id,
        );
        if (restored !== undefined) {
          this.emit({ type: "session.context_restored", session: restored });
        }
        return;
      } catch (error) {
        this.emit({
          type: "diagnostic",
          level: "warning",
          message: `Previous session ${latest.id} could not be resumed (${
            error instanceof Error ? error.message : String(error)
          }); a new session was started.`,
        });
      }
    }
    const current = this.#application.agentSessionId ?? sessionId;
    if (this.#sessions.some((session) => session.id === current)) {
      await this.#touchSession(current);
      return;
    }
    await this.#rememberSession(current, "Production session");
  }

  async #rememberSession(sessionId: string, title: string): Promise<void> {
    const session: DesktopSession = {
      id: sessionId,
      title,
      updatedAt: new Date().toISOString(),
      projectName: projectLabel(await this.#application.getStatus()),
      mode: "explore",
      productionPlan: [],
      outputAssignments: [],
    };
    this.#sessions = [
      session,
      ...this.#sessions.filter((existing) => existing.id !== sessionId),
    ].slice(0, storedSessionLimit);
    await this.#persistSessions();
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

  async #updateActiveSession(
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
    const sessionId = this.#application.agentSessionId;
    if (sessionId === undefined) return;
    const current = this.#sessions.find((session) => session.id === sessionId);
    if (current === undefined) return;
    this.#sessions = [
      { ...current, ...update, updatedAt: new Date().toISOString() },
      ...this.#sessions.filter((session) => session.id !== sessionId),
    ];
    await this.#persistSessions();
  }

  async #syncProjectAssociation(
    projectId: string,
    projectName: string,
  ): Promise<void> {
    const sessionId = this.#application.agentSessionId;
    const current = this.#sessions.find((session) => session.id === sessionId);
    if (current === undefined) return;
    if (current.projectId !== undefined && current.projectId !== projectId) {
      this.#pinnedContext = [];
      await this.#updateActiveSession({
        projectId,
        projectName,
        productionPlan: [],
      });
      const updated = this.#sessions.find(
        (session) => session.id === sessionId,
      );
      if (updated !== undefined) {
        this.emit({ type: "session.context_restored", session: updated });
      }
      this.emit({
        type: "diagnostic",
        level: "warning",
        message:
          "Ableton project changed; pinned selections and the production plan were cleared to prevent stale context.",
      });
      return;
    }
    if (
      current.projectId !== projectId ||
      current.projectName !== projectName
    ) {
      await this.#updateActiveSession({ projectId, projectName });
    }
  }

  async #persistSessions(): Promise<void> {
    const snapshot = [...this.#sessions];
    const save = this.#sessionSaveTail.then(async () => {
      try {
        await this.options.sessionStore.save(snapshot);
      } catch (error) {
        this.#report("Sessions could not be saved", error);
      }
      this.emit({ type: "sessions.changed", sessions: snapshot });
    });
    this.#sessionSaveTail = save.catch(() => undefined);
    await save;
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
    producerId: string,
  ): Promise<DesktopOutputAssignment> {
    this.#assertAccepting();
    if (
      !this.#signals
        .listConnections()
        .some((connection) => connection.producer.producerId === producerId)
    ) {
      throw new Error("Output producer not found");
    }
    const existing = this.#activeSession()?.outputAssignments.find(
      (assignment) => assignment.producerId === producerId,
    );
    if (existing !== undefined) return existing;
    const assignment: DesktopOutputAssignment = {
      assignmentId: randomUUID(),
      producerId,
      enabled: true,
      deliveryMode: "next-prompt",
      usageInstruction: DEFAULT_SIGNAL_USAGE_INSTRUCTION,
      processingPolicyIds: ["latest-window"],
    };
    await this.#updateOutputAssignment(assignment);
    return assignment;
  }

  public async unassignOutput(producerId: string): Promise<boolean> {
    this.#assertAccepting();
    const session = this.#activeSession();
    const assignment = session?.outputAssignments.find(
      (item) => item.producerId === producerId,
    );
    if (session === undefined || assignment === undefined) return false;
    this.#signals.removeAssignment(assignment.assignmentId);
    await this.#replaceOutputAssignments(
      session.outputAssignments.filter(
        (item) => item.assignmentId !== assignment.assignmentId,
      ),
    );
    return true;
  }

  public setOutputEnabled(
    producerId: string,
    enabled: boolean,
  ): Promise<DesktopOutputAssignment> {
    return this.#editOutput(producerId, { enabled });
  }

  public setOutputDeliveryMode(
    producerId: string,
    deliveryMode: OutputDeliveryMode,
  ): Promise<DesktopOutputAssignment> {
    return this.#editOutput(producerId, { deliveryMode });
  }

  public setOutputUsageInstruction(
    producerId: string,
    usageInstruction: string,
  ): Promise<DesktopOutputAssignment> {
    return this.#editOutput(producerId, { usageInstruction });
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
      assignments: [...(this.#activeSession()?.outputAssignments ?? [])],
      latest: [...this.#latestOutputs.values()],
      ...(this.#application.agentSessionId === undefined
        ? {}
        : { activeSessionId: this.#application.agentSessionId }),
    };
  }

  #emitOutputs(): void {
    this.emit({ type: "outputs.changed", outputs: this.#outputsState() });
  }

  #activeSession(): DesktopSession | undefined {
    const sessionId = this.#application.agentSessionId;
    return this.#sessions.find((session) => session.id === sessionId);
  }

  #clearRuntimeAssignments(): void {
    this.#signals.setActiveSession(undefined);
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
    for (const assignment of session.outputAssignments) {
      this.#signals.upsertAssignment({
        ...assignment,
        consumer: { kind: "agent-session", id: session.id },
      });
    }
    this.#signals.setActiveSession(session.id);
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
    outputAssignments: DesktopOutputAssignment[],
  ): Promise<void> {
    await this.#updateActiveSession({ outputAssignments });
    this.#bindActiveOutputAssignments();
  }

  async #updateOutputAssignment(
    assignment: DesktopOutputAssignment,
  ): Promise<void> {
    const session = this.#activeSession();
    if (session === undefined) throw new Error("No active conversation");
    await this.#replaceOutputAssignments([
      assignment,
      ...session.outputAssignments.filter(
        (item) => item.producerId !== assignment.producerId,
      ),
    ]);
  }

  async #editOutput(
    producerId: string,
    update: Partial<
      Pick<
        DesktopOutputAssignment,
        "enabled" | "deliveryMode" | "usageInstruction"
      >
    >,
  ): Promise<DesktopOutputAssignment> {
    this.#assertAccepting();
    const assignment = this.#activeSession()?.outputAssignments.find(
      (item) => item.producerId === producerId,
    );
    if (assignment === undefined) throw new Error("Output is not assigned");
    const updated = { ...assignment, ...update };
    await this.#updateOutputAssignment(updated);
    return updated;
  }

  #assertAccepting(): void {
    if (!this.#acceptingActions) {
      throw new Error("Desktop service is not accepting actions");
    }
  }
}
