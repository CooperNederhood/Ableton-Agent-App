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
  resolveApproval(id: string, decision: ApprovalDecision): Promise<boolean>;
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
