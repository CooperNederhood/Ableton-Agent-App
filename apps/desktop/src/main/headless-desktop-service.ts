import { randomUUID } from "node:crypto";

import type { HeadlessApplication } from "@ableton-agent/application";
import type { SessionSnapshot } from "@ableton-agent/protocol";
import type { AppEvent, ConnectionStatus } from "@ableton-agent/shared";

import {
  preferencesSchema,
  type ApprovalDecision,
  type ContextChip,
  type DesktopAppEvent,
  type DesktopConnectionStatus,
  type DesktopLifecycleState,
  type DesktopPreferences,
  type DesktopProjectSnapshot,
  type DesktopSession,
  type PlanSection,
  type ProductMode,
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
/** The sessions view shows the most recent entries; older ones are dropped. */
const storedSessionLimit = 100;

export interface HeadlessDesktopServiceOptions {
  application: HeadlessApplication;
  approvals: ApprovalCoordinator;
  preferencesStore: JsonPreferencesStore;
  sessionStore: JsonSessionStore;
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
  #unsubscribeShared: (() => void) | undefined;
  #unsubscribeApprovals: (() => void) | undefined;
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

  public constructor(private readonly options: HeadlessDesktopServiceOptions) {
    this.#application = options.application;
    this.#approvals = options.approvals;
  }

  public async start(): Promise<void> {
    this.#unsubscribeShared = this.#application.subscribe((event) =>
      this.#onSharedEvent(event),
    );
    this.#unsubscribeApprovals = this.#approvals.setPublisher((approval) => {
      if (this.#listeners.size === 0) return false;
      this.emit({ type: "approval.requested", approval });
      return true;
    });
    this.#preferences = await this.#loadPreferences();
    this.#sessions = await this.#loadSessions();
    this.#acceptingActions = true;
    this.emit({ type: "preferences.changed", preferences: this.#preferences });
    this.emit({ type: "sessions.changed", sessions: this.#sessions });

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
    if ((await this.#application.getStatus()).state === "connected") {
      try {
        await this.getSnapshot();
      } catch (error) {
        this.#report("Project snapshot could not be read", error);
      }
    }
  }

  public async stop(): Promise<void> {
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
      await this.#application.stop();
    } catch (error) {
      this.#report("Shutdown reported failures", error);
    }
    this.#unsubscribeApprovals?.();
    this.#unsubscribeApprovals = undefined;
    this.#unsubscribeShared?.();
    this.#unsubscribeShared = undefined;
    this.#turn = undefined;
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
    try {
      await this.#application.send(prompt);
      this.#completeTurn(turn, {
        status: "completed",
        label: `Agent turn (${mode})`,
        detail: "The agent finished this turn.",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
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
      const sessionId = await this.#application.createAgentSession();
      await this.#rememberSession(sessionId, "New production session");
      return sessionId;
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
      await this.#application.resumeAgentSession(sessionId);
      await this.#touchSession(sessionId);
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

  public async getSnapshot(): Promise<DesktopProjectSnapshot> {
    const status = await this.#application.getStatus();
    if (status.state !== "connected") {
      throw Object.assign(
        new Error("Ableton is not connected, so no project can be read"),
        { code: "not_connected" },
      );
    }
    const snapshot = await this.#application.inspectSession();
    const trackDevices = await this.#readTrackDevices(snapshot);
    const desktopSnapshot = toDesktopSnapshot(snapshot, status, trackDevices);
    this.emit({
      type: "project.snapshot_changed",
      snapshot: desktopSnapshot,
    });
    return desktopSnapshot;
  }

  async #readTrackDevices(snapshot: SessionSnapshot): Promise<TrackDevices[]> {
    const result: TrackDevices[] = [];
    for (const track of snapshot.tracks) {
      const target = {
        index: track.index,
        expectedReference: track.reference,
        expectedName: track.name,
      };
      const page = await this.#application.inspectDevices({
        ...target,
        offset: 0,
        limit: deviceReadLimit,
      });
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
        const parameters = await this.#application.inspectDeviceParameters({
          ...target,
          deviceIndex: device.index,
          expectedDeviceReference: device.reference,
          expectedDeviceName: device.name,
          offset: 0,
          limit: parameterReadLimit,
        });
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

  public async getDiagnostics(): Promise<
    Array<{ label: string; status: "pass" | "warn" | "fail"; detail: string }>
  > {
    const status = await this.#application.getStatus();
    const sessionId = this.#application.agentSessionId;
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
    const restartRequired = (
      ["abletonPort", "model", "reasoning", "approvalPolicy"] as const
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
    this.emit({
      type: "diagnostic",
      level: "info",
      message: `Production plan validated with ${sections.length} section(s). Plans are renderer state: they are not persisted by the application and are not applied to Live.`,
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

  #assertAccepting(): void {
    if (!this.#acceptingActions) {
      throw new Error("Desktop service is not accepting actions");
    }
  }
}
