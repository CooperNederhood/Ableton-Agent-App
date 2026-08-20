import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  ApprovalDecision,
  AutoApprovalTarget,
  ContextChip,
  DesktopAppEvent,
  DesktopActiveAgent,
  DesktopAgentConfigOverrides,
  DesktopAgentHistoryMessage,
  DesktopAgentCatalog,
  DesktopAutoApprovalUpdate,
  DesktopConnectionStatus,
  DiagnosticCheck,
  DesktopLifecycleState,
  DesktopPreferences,
  DesktopProjectSnapshot,
  DesktopOutputAssignment,
  DesktopOutputsState,
  OutputDeliveryMode,
  DesktopSession,
  PlanSection,
  ProductMode,
} from "../contracts.js";
import {
  legacySessionSchema,
  preferencesSchema,
  sessionSchema,
} from "../contracts.js";

const legacySdkSessionIds = new WeakMap<DesktopSession, string>();

export function legacySdkSessionId(
  session: DesktopSession,
): string | undefined {
  return legacySdkSessionIds.get(session);
}

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
  getAgentCatalog(): Promise<DesktopAgentCatalog>;
  refreshAgentCatalog(): Promise<DesktopAgentCatalog>;
  listActiveAgents(): Promise<DesktopActiveAgent[]>;
  createActiveAgent(definitionName: string): Promise<DesktopActiveAgent>;
  renameActiveAgent(
    instanceId: string,
    label: string,
  ): Promise<DesktopActiveAgent>;
  configureActiveAgent(
    instanceId: string,
    overrides: DesktopAgentConfigOverrides,
  ): Promise<DesktopActiveAgent>;
  resetActiveAgent(instanceId: string): Promise<DesktopActiveAgent>;
  selectActiveAgent(instanceId: string): Promise<DesktopActiveAgent>;
  setAutoApproval(
    target: AutoApprovalTarget,
    enabled: boolean,
  ): Promise<DesktopAutoApprovalUpdate>;
  deactivateActiveAgent(instanceId: string): Promise<void>;
  hydrateActiveAgentHistory(
    instanceId: string,
  ): Promise<DesktopAgentHistoryMessage[]>;
  sendToActiveAgent(
    instanceId: string,
    message: string,
  ): Promise<{ accepted: true; messageId: string }>;
  invokeActiveAgentSkill(
    instanceId: string,
    skillName: string,
    argumentsText: string,
  ): Promise<{ accepted: true; messageId: string }>;
  cancelActiveAgent(instanceId: string): Promise<{ cancelled: boolean }>;
  connect(): Promise<DesktopConnectionStatus>;
  getStatus(): Promise<DesktopConnectionStatus>;
  getCapabilities(): Promise<string[]>;
  getSnapshot(): Promise<DesktopProjectSnapshot>;
  getDiagnostics(): Promise<DiagnosticCheck[]>;
  resolveApproval(id: string, decision: ApprovalDecision): Promise<boolean>;
  getPreferences(): Promise<DesktopPreferences>;
  setPreferences(value: DesktopPreferences): Promise<DesktopPreferences>;
  setContext(context: ContextChip[]): Promise<void>;
  updatePlan(sections: PlanSection[]): Promise<void>;
  retryOperation(id: string): Promise<boolean>;
  undoOperation(id: string): Promise<boolean>;
  listOutputs(): Promise<DesktopOutputsState>;
  assignOutput(
    agentInstanceId: string,
    producerId: string,
  ): Promise<DesktopOutputAssignment>;
  unassignOutput(agentInstanceId: string, producerId: string): Promise<boolean>;
  setOutputEnabled(
    agentInstanceId: string,
    producerId: string,
    enabled: boolean,
  ): Promise<DesktopOutputAssignment>;
  setOutputDeliveryMode(
    agentInstanceId: string,
    producerId: string,
    deliveryMode: OutputDeliveryMode,
  ): Promise<DesktopOutputAssignment>;
  setOutputUsageInstruction(
    agentInstanceId: string,
    producerId: string,
    usageInstruction: string,
  ): Promise<DesktopOutputAssignment>;
  setOutputProcessingPolicies(
    agentInstanceId: string,
    producerId: string,
    processingPolicyIds: string[],
  ): Promise<DesktopOutputAssignment>;
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
  readonly #legacySessionIds = new Set<string>();

  public constructor(private readonly path: string) {}

  public async load(): Promise<DesktopSession[]> {
    try {
      const stored: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (!Array.isArray(stored)) {
        throw new Error("Stored sessions must be an array");
      }
      return stored.map((value) => {
        if (typeof value === "object" && value !== null && "version" in value) {
          return sessionSchema.parse(value);
        }
        const legacy = legacySessionSchema.parse(value);
        this.#legacySessionIds.add(legacy.id);
        const migrated = sessionSchema.parse({
          ...legacy,
          version: 2,
          activeAgents: [],
        });
        legacySdkSessionIds.set(migrated, legacy.id);
        return migrated;
      });
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
        JSON.stringify(
          sessionSchema
            .array()
            .parse(sessions)
            .map((session) =>
              this.#legacySessionIds.has(session.id) &&
              session.activeAgents.length === 0
                ? legacySessionSchema.parse(session)
                : session,
            ),
          undefined,
          2,
        ),
        { encoding: "utf8", mode: 0o600 },
      );
      await rename(temporaryPath, this.path);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }
}
