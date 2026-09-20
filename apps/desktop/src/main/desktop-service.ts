import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { resolveProductionSessionStorage } from "@ableton-agent/storage";

import type {
  ApprovalDecision,
  AutoApprovalTarget,
  ContextChip,
  DesktopAppEvent,
  DesktopActiveAgent,
  DesktopAgentConfigOverrides,
  DesktopAgentConversationSettings,
  DesktopAgentHistoryMessage,
  DesktopAgentCatalog,
  DesktopAgentModel,
  DesktopAgentMode,
  DesktopPlanArtifactSnapshot,
  DesktopAutoApprovalUpdate,
  DesktopConnectionStatus,
  DiagnosticCheck,
  DesktopLifecycleState,
  DesktopAgentEventListener,
  DesktopEventsState,
  EventTracePage,
  ConfigurationSnapshotPage,
  ConfigurationSnapshotQuery,
  JournalHealth,
  RetentionPolicy,
  RetentionResult,
  RootTracePage,
  RootTraceQuery,
  DesktopPreferences,
  DesktopProjectSnapshot,
  ProjectTransitionDecision,
  DesktopOutputAssignment,
  DesktopOutputsState,
  OutputDeliveryMode,
  LiveEventDefinitionDraft,
  LiveEventSelection,
  DesktopSession,
  PlanSection,
} from "../contracts.js";
import type { AutomationTrace } from "@ableton-agent/debug-control";
import type {
  AgentEventListener,
  LiveEventDefinition,
} from "@ableton-agent/agent-config";
import {
  preferencesSchema,
  sessionSchema,
  versionTwoSessionSchema,
} from "../contracts.js";

export interface DesktopService {
  start(): Promise<void>;
  stop(): Promise<void>;
  send(
    message: string,
    context: ContextChip[],
    options?: {
      origin: "automation";
      trace: AutomationTrace;
      requestId: string;
    },
  ): Promise<{ accepted: true; messageId: string }>;
  cancel(): Promise<{ cancelled: boolean }>;
  createSession(): Promise<string>;
  getSessions(): Promise<DesktopSession[]>;
  persistActiveSession(): Promise<DesktopSession>;
  resumeSession(sessionId: string): Promise<void>;
  closeSession(): Promise<void>;
  getAgentCatalog(): Promise<DesktopAgentCatalog>;
  refreshAgentCatalog(): Promise<DesktopAgentCatalog>;
  listActiveAgents(): Promise<DesktopActiveAgent[]>;
  listAgentModels(): Promise<DesktopAgentModel[]>;
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
  setActiveAgentConversationSettings(
    instanceId: string,
    settings: DesktopAgentConversationSettings,
  ): Promise<DesktopActiveAgent>;
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
    context?: ContextChip[],
    agentMode?: DesktopAgentMode,
  ): Promise<{ accepted: true; messageId: string }>;
  setActiveAgentMode(
    instanceId: string,
    mode: DesktopAgentMode,
  ): Promise<DesktopActiveAgent>;
  resolveActiveAgentPlan(
    instanceId: string,
    request: {
      requestId: string;
      approved: boolean;
      planRevision?: string;
      selectedAction?: "exit_only" | "interactive";
      feedback?: string;
    },
  ): Promise<boolean>;
  readActiveAgentPlan(instanceId: string): Promise<DesktopPlanArtifactSnapshot>;
  writeActiveAgentPlan(
    instanceId: string,
    input: { content: string; expectedRevision?: string },
  ): Promise<DesktopPlanArtifactSnapshot>;
  resolveActiveAgentElicitation(
    instanceId: string,
    request: {
      requestId: string;
      action: "accept" | "decline" | "cancel";
      content?: Readonly<Record<string, string | number | boolean | string[]>>;
    },
  ): Promise<boolean>;
  invokeActiveAgentSkill(
    instanceId: string,
    skillName: string,
    argumentsText: string,
    context?: ContextChip[],
    agentMode?: DesktopAgentMode,
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
  resolveProjectTransition(
    token: string,
    decision: ProjectTransitionDecision,
  ): Promise<DesktopSession>;
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
  listLiveEvents(): Promise<DesktopEventsState>;
  inspectLiveEventSelection(): Promise<LiveEventSelection>;
  createLiveEvent(
    definition: LiveEventDefinitionDraft,
  ): Promise<LiveEventDefinition>;
  updateLiveEvent(
    eventId: string,
    definition: LiveEventDefinitionDraft,
  ): Promise<LiveEventDefinition>;
  setLiveEventEnabled(
    eventId: string,
    enabled: boolean,
  ): Promise<LiveEventDefinition>;
  deleteLiveEvent(eventId: string): Promise<boolean>;
  assignLiveEventListener(
    agentInstanceId: string,
    eventId: string,
    settings: Pick<
      AgentEventListener,
      "enabled" | "responseMode" | "messagePrefix" | "preparedContext"
    >,
  ): Promise<DesktopAgentEventListener>;
  unassignLiveEventListener(
    agentInstanceId: string,
    eventId: string,
  ): Promise<boolean>;
  updateLiveEventListener(
    agentInstanceId: string,
    eventId: string,
    settings: Partial<
      Pick<AgentEventListener, "enabled" | "responseMode"> & {
        messagePrefix: string | null;
        preparedContext: AgentEventListener["preparedContext"];
      }
    >,
  ): Promise<DesktopAgentEventListener>;
  searchEventHistory(query?: RootTraceQuery): Promise<RootTracePage>;
  getEventTrace(
    traceId: string,
    options?: { cursor?: string; limit?: number; order?: "asc" | "desc" },
  ): Promise<EventTracePage>;
  getAgentConfigurationSnapshots(
    query?: ConfigurationSnapshotQuery,
  ): Promise<ConfigurationSnapshotPage>;
  getEventJournalHealth(): Promise<JournalHealth>;
  getEventRetention(): Promise<RetentionPolicy>;
  setEventRetention(policy: RetentionPolicy): Promise<RetentionPolicy>;
  pruneEventHistory(): Promise<RetentionResult>;
  deleteEventTrace(traceId: string): Promise<number>;
  clearEventHistory(): Promise<{
    deletedEvents: number;
    deletedConfigurationSnapshots: number;
  }>;
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
  public constructor(
    private readonly path: string,
    private readonly sessionStateDirectory?: string,
  ) {}

  public async load(): Promise<DesktopSession[]> {
    try {
      const stored: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (!Array.isArray(stored)) {
        throw new Error("Stored sessions must be an array");
      }
      const values: unknown[] = stored;
      return values.map((value) => {
        if (typeof value === "object" && value !== null && "version" in value) {
          if (value.version === 2) {
            const versionTwo = versionTwoSessionSchema.parse(value);
            return sessionSchema.parse({
              ...versionTwo,
              version: 3,
              liveEvents: [],
              activeAgents: versionTwo.activeAgents.map((agent) => ({
                ...agent,
                mode: agent.mode ?? "interactive",
                eventListeners: [],
                triggerHistory: [],
              })),
            });
          }
          const session = sessionSchema.parse(value);
          return {
            ...session,
            activeAgents: session.activeAgents.map((agent) => ({
              ...agent,
              mode: agent.mode ?? "interactive",
              triggerHistory: agent.triggerHistory ?? [],
            })),
          };
        }
        return sessionSchema.parse(value);
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
        JSON.stringify(sessionSchema.array().parse(sessions), undefined, 2),
        { encoding: "utf8", mode: 0o600 },
      );
      await rename(temporaryPath, this.path);
      await this.#writeSessionManifests(sessions);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }

  async #writeSessionManifests(
    sessions: readonly DesktopSession[],
  ): Promise<void> {
    if (this.sessionStateDirectory === undefined) return;
    await mkdir(this.sessionStateDirectory, { recursive: true, mode: 0o700 });
    for (const session of sessions) {
      const paths = resolveProductionSessionStorage(
        this.sessionStateDirectory,
        session.id,
      );
      await mkdir(paths.artifactsDirectory, {
        recursive: true,
        mode: 0o700,
      });
      const manifestPath = paths.manifestPath;
      const temporaryPath = `${manifestPath}.${randomUUID()}.tmp`;
      try {
        await writeFile(
          temporaryPath,
          JSON.stringify(
            {
              version: 1,
              productionSessionId: session.id,
              title: session.title,
              updatedAt: session.updatedAt,
              projectName: session.projectName,
              ...(session.projectId === undefined
                ? {}
                : { projectId: session.projectId }),
              activeAgentIds: session.activeAgents.map(({ id }) => id),
              sdkSessionIds: session.activeAgents.flatMap(({ sdkSessionId }) =>
                sdkSessionId === undefined ? [] : [sdkSessionId],
              ),
            },
            undefined,
            2,
          ),
          { encoding: "utf8", mode: 0o600 },
        );
        await rename(temporaryPath, manifestPath);
      } catch (error) {
        await rm(temporaryPath, { force: true });
        throw error;
      }
    }
  }
}
