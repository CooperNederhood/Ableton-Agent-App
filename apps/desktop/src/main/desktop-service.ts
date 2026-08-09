import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  ApprovalDecision,
  ContextChip,
  DesktopAppEvent,
  DesktopConnectionStatus,
  DesktopLifecycleState,
  DesktopPreferences,
  DesktopProjectSnapshot,
  DesktopSession,
  PlanSection,
  ProductMode,
} from "../contracts.js";
import { preferencesSchema, sessionSchema } from "../contracts.js";

export interface DesktopService {
  start(): Promise<void>;
  stop(): Promise<void>;
  send(
    message: string,
    context: ContextChip[],
    mode: ProductMode,
  ): Promise<{ accepted: true; messageId: string }>;
  cancel(): Promise<{ cancelled: boolean }>;
  createSession(): Promise<string>;
  getSessions(): Promise<DesktopSession[]>;
  resumeSession(sessionId: string): Promise<void>;
  connect(): Promise<DesktopConnectionStatus>;
  getStatus(): Promise<DesktopConnectionStatus>;
  getCapabilities(): Promise<string[]>;
  getSnapshot(): Promise<DesktopProjectSnapshot>;
  getDiagnostics(): Promise<
    Array<{ label: string; status: "pass" | "warn" | "fail"; detail: string }>
  >;
  resolveApproval(id: string, decision: ApprovalDecision): Promise<void>;
  getPreferences(): Promise<DesktopPreferences>;
  setPreferences(value: DesktopPreferences): Promise<DesktopPreferences>;
  setContext(context: ContextChip[]): Promise<void>;
  updatePlan(sections: PlanSection[]): Promise<void>;
  retryOperation(id: string): Promise<boolean>;
  undoOperation(id: string): Promise<boolean>;
  subscribe(listener: (event: DesktopAppEvent) => void): () => void;
  getLifecycleState(): Promise<DesktopLifecycleState>;
}

export class JsonPreferencesStore {
  public constructor(private readonly path: string) {}

  public async load(): Promise<DesktopPreferences> {
    try {
      const stored: unknown = JSON.parse(await readFile(this.path, "utf8"));
      return preferencesSchema.parse(stored);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return preferencesSchema.parse({});
      }
      throw new Error("Preferences could not be loaded", { cause: error });
    }
  }

  public async save(value: DesktopPreferences): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(
        temporaryPath,
        JSON.stringify(preferencesSchema.parse(value), undefined, 2),
        {
          encoding: "utf8",
          mode: 0o600,
        },
      );
      await rename(temporaryPath, this.path);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }
}

export class JsonSessionStore {
  public constructor(private readonly path: string) {}

  public async load(): Promise<DesktopSession[]> {
    try {
      const stored: unknown = JSON.parse(await readFile(this.path, "utf8"));
      return sessionSchema.array().parse(stored);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new Error("Sessions could not be loaded", { cause: error });
    }
  }

  public async save(sessions: readonly DesktopSession[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(
        temporaryPath,
        JSON.stringify(sessionSchema.array().parse(sessions), undefined, 2),
        { encoding: "utf8", mode: 0o600 },
      );
      await rename(temporaryPath, this.path);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }
}

const demoSnapshot: DesktopProjectSnapshot = {
  id: "demo-project",
  name: "Neon Sketch 04",
  tempo: 124,
  timeSignature: "4/4",
  tracks: [
    {
      id: "track-drums",
      name: "Drums",
      kind: "midi",
      color: "#f39c61",
      volume: 0.82,
      pan: 0,
      muted: false,
      clips: [
        {
          id: "clip-beat",
          name: "Dust Beat",
          startBar: 1,
          lengthBars: 8,
          status: "playing",
        },
        {
          id: "clip-fill",
          name: "Fill",
          startBar: 15,
          lengthBars: 2,
          status: "stopped",
        },
      ],
      devices: [
        {
          id: "device-rack",
          name: "Drum Rack",
          type: "Instrument",
          enabled: true,
          parameters: [
            { id: "drive", name: "Drive", value: 0.38, displayValue: "38%" },
            { id: "tone", name: "Tone", value: 0.62, displayValue: "62%" },
          ],
        },
      ],
    },
    {
      id: "track-bass",
      name: "Bass",
      kind: "midi",
      color: "#79c2ff",
      volume: 0.74,
      pan: -0.08,
      muted: false,
      clips: [
        {
          id: "clip-bass",
          name: "Sub Motif",
          startBar: 9,
          lengthBars: 8,
          status: "stopped",
        },
      ],
      devices: [
        {
          id: "device-wavetable",
          name: "Wavetable",
          type: "Instrument",
          enabled: true,
          parameters: [
            {
              id: "cutoff",
              name: "Filter cutoff",
              value: 0.56,
              displayValue: "2.4 kHz",
            },
            {
              id: "resonance",
              name: "Resonance",
              value: 0.22,
              displayValue: "22%",
            },
          ],
        },
      ],
    },
    {
      id: "track-pad",
      name: "Atmosphere",
      kind: "audio",
      color: "#b892ff",
      volume: 0.61,
      pan: 0.12,
      muted: false,
      clips: [
        {
          id: "clip-pad",
          name: "Glass Air",
          startBar: 1,
          lengthBars: 16,
          status: "stopped",
        },
      ],
      devices: [],
    },
  ],
};

export class DemoDesktopService implements DesktopService {
  readonly #listeners = new Set<(event: DesktopAppEvent) => void>();
  #sessions: DesktopSession[] = [];
  readonly #timers = new Set<ReturnType<typeof setTimeout>>();
  #status: DesktopConnectionStatus = { state: "disconnected" };
  #preferences: DesktopPreferences = preferencesSchema.parse({});
  #activeOperation: string | undefined;
  #acceptingActions = false;
  #lifecycle: DesktopLifecycleState = "stopped";
  #context: ContextChip[] = [];
  #plan: PlanSection[] = [];
  #preferenceSaveTail: Promise<void> = Promise.resolve();

  public constructor(
    private readonly preferencesStore: JsonPreferencesStore,
    private readonly sessionStore: JsonSessionStore,
  ) {}

  public async start(): Promise<void> {
    this.setLifecycle("starting");
    this.#preferences = await this.preferencesStore.load();
    this.#sessions = await this.sessionStore.load();
    this.#acceptingActions = true;
    this.emit({ type: "preferences.changed", preferences: this.#preferences });
    this.emit({ type: "sessions.changed", sessions: this.#sessions });
    this.emit({ type: "project.snapshot_changed", snapshot: demoSnapshot });
    this.emit({ type: "ableton.connection_changed", status: this.#status });
    this.setLifecycle("degraded");
  }

  public async stop(): Promise<void> {
    this.#acceptingActions = false;
    this.setLifecycle("stopping");
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    await this.#preferenceSaveTail;
    await this.preferencesStore.save(this.#preferences);
    this.#status = { state: "disconnected" };
    this.emit({ type: "ableton.connection_changed", status: this.#status });
    this.setLifecycle("stopped");
  }

  public async send(
    message: string,
    context: ContextChip[],
    mode: ProductMode,
  ): Promise<{ accepted: true; messageId: string }> {
    this.assertAccepting();
    if (this.#activeOperation !== undefined) {
      throw new Error("An agent operation is already in progress");
    }
    const messageId = randomUUID();
    const operationId = randomUUID();
    this.#activeOperation = operationId;
    this.emit({
      type: "operation.changed",
      operation: {
        id: operationId,
        label: `Preparing ${mode} workflow`,
        status: "running",
        detail:
          context.length > 0
            ? `Using ${context.map((item) => item.label).join(", ")}`
            : "Inspecting the current Live set",
        warnings: [],
        changed: [],
        unchanged: [],
        retryable: false,
        undoable: false,
        timestamp: Date.now(),
      },
    });
    const response = `I mapped “${message}” into a safe ${mode} workflow. This demo composition shows the desktop contract while shared session, approval, and cancellation APIs are completed.`;
    [...response].forEach((character, index) => {
      this.schedule(
        () =>
          this.emit({
            type: "agent.message_delta",
            messageId,
            content: character,
          }),
        12 * index,
      );
    });
    this.schedule(
      () => {
        this.emit({
          type: "agent.message_complete",
          messageId,
          content: response,
        });
        this.emit({
          type: "operation.changed",
          operation: {
            id: operationId,
            label: `Prepared ${mode} workflow`,
            status: "completed",
            detail: "No Live mutations were executed.",
            warnings: ["Running with the typed demo adapter."],
            changed: ["Created a preview plan"],
            unchanged: ["Ableton Live set"],
            retryable: true,
            undoable: false,
            timestamp: Date.now(),
          },
        });
        if (this.#activeOperation === operationId) {
          this.#activeOperation = undefined;
        }
      },
      12 * response.length + 20,
    );
    return { accepted: true, messageId };
  }

  public async cancel(): Promise<{ cancelled: boolean }> {
    if (!this.#activeOperation) return { cancelled: false };
    const id = this.#activeOperation;
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    this.#activeOperation = undefined;
    this.emit({
      type: "operation.changed",
      operation: {
        id,
        label: "Agent workflow",
        status: "cancelled",
        detail: "Cancelled by user.",
        warnings: [],
        changed: [],
        unchanged: ["Pending actions"],
        retryable: true,
        undoable: false,
        timestamp: Date.now(),
      },
    });
    return { cancelled: true };
  }

  public async createSession(): Promise<string> {
    const session = {
      id: randomUUID(),
      title: "New production session",
      updatedAt: new Date().toISOString(),
      projectName: demoSnapshot.name,
    };
    this.#sessions.unshift(session);
    await this.sessionStore.save(this.#sessions);
    this.emit({ type: "sessions.changed", sessions: this.#sessions });
    return session.id;
  }

  public async getSessions(): Promise<DesktopSession[]> {
    return [...this.#sessions];
  }

  public async resumeSession(sessionId: string): Promise<void> {
    if (!this.#sessions.some((session) => session.id === sessionId))
      throw new Error("Session not found");
    this.emit({
      type: "diagnostic",
      level: "info",
      message: "Session resumed.",
    });
  }

  public async connect(): Promise<DesktopConnectionStatus> {
    this.#status = { state: "connecting" };
    this.emit({ type: "ableton.connection_changed", status: this.#status });
    this.#status = {
      state: "connected",
      liveVersion: "12.1 (demo)",
      remoteScriptVersion: "desktop-demo",
      projectId: demoSnapshot.id,
    };
    this.emit({ type: "ableton.connection_changed", status: this.#status });
    this.setLifecycle("ready");
    return this.#status;
  }

  public async getStatus(): Promise<DesktopConnectionStatus> {
    return this.#status;
  }
  public async getCapabilities(): Promise<string[]> {
    return [
      "chat",
      "streaming",
      "project snapshot",
      "browser",
      "device inspection",
      "plans",
      "approval previews",
    ];
  }
  public async getSnapshot(): Promise<DesktopProjectSnapshot> {
    return demoSnapshot;
  }
  public async getDiagnostics(): Promise<
    Array<{ label: string; status: "pass" | "warn" | "fail"; detail: string }>
  > {
    return [
      {
        label: "Desktop security",
        status: "pass",
        detail: "Sandboxed renderer and typed IPC enabled",
      },
      {
        label: "Ableton bridge",
        status: this.#status.state === "connected" ? "pass" : "warn",
        detail: this.#status.state,
      },
      {
        label: "Shared bootstrap",
        status: "warn",
        detail:
          "Using desktop demo adapter until shared session/approval ports are public",
      },
    ];
  }
  public async resolveApproval(
    id: string,
    decision: ApprovalDecision,
  ): Promise<void> {
    this.emit({
      type: "diagnostic",
      level: "info",
      message: `Approval ${id} ${decision}d.`,
    });
  }
  public async getPreferences(): Promise<DesktopPreferences> {
    return this.#preferences;
  }
  public async setPreferences(
    value: DesktopPreferences,
  ): Promise<DesktopPreferences> {
    this.assertAccepting();
    const preferences = preferencesSchema.parse(value);
    const update = this.#preferenceSaveTail.then(async () => {
      await this.preferencesStore.save(preferences);
      this.#preferences = preferences;
      this.emit({
        type: "preferences.changed",
        preferences: this.#preferences,
      });
    });
    this.#preferenceSaveTail = update.catch(() => undefined);
    await update;
    return this.#preferences;
  }
  public async setContext(context: ContextChip[]): Promise<void> {
    this.#context = [...context];
    this.emit({
      type: "diagnostic",
      level: "info",
      message: `Context updated with ${this.#context.length} selection(s).`,
    });
  }
  public async updatePlan(sections: PlanSection[]): Promise<void> {
    this.#plan = [...sections];
    this.emit({
      type: "diagnostic",
      level: "info",
      message: `Production plan saved with ${this.#plan.length} section(s).`,
    });
  }
  public async retryOperation(id: string): Promise<boolean> {
    this.emit({
      type: "diagnostic",
      level: "info",
      message: `Retry is unavailable in the demo adapter for ${id}.`,
    });
    return false;
  }
  public async undoOperation(id: string): Promise<boolean> {
    this.emit({
      type: "diagnostic",
      level: "info",
      message: `Undo is unavailable in the demo adapter for ${id}.`,
    });
    return false;
  }
  public subscribe(listener: (event: DesktopAppEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  public async getLifecycleState(): Promise<DesktopLifecycleState> {
    return this.#lifecycle;
  }

  private emit(event: DesktopAppEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
  private setLifecycle(state: DesktopLifecycleState): void {
    this.#lifecycle = state;
    this.emit({ type: "lifecycle.changed", state });
  }
  private schedule(action: () => void, delay: number): void {
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      action();
    }, delay);
    this.#timers.add(timer);
  }
  private assertAccepting(): void {
    if (!this.#acceptingActions)
      throw new Error("Desktop service is shutting down");
  }
}
