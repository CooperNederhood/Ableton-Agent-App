import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  readLiveProjectsRegistry,
  readLiveSetStorageMetadata,
  readProjectStorageMetadata,
  relocateLiveSetStorage,
  resolveNestedSessionStorage,
  type LiveAgentStorageLayout,
  type LiveSetStorageLocation,
  type SessionStorageOwnershipContext,
  writeLiveProjectsRegistry,
  writeLiveSetStorageMetadata,
  writeProjectStorageMetadata,
} from "@ableton-agent/storage";

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
  DesktopLiveSetSnapshot,
  LiveSetTransitionDecision,
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
import { preferencesSchema, sessionSchema } from "../contracts.js";

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
  getSnapshot(): Promise<DesktopLiveSetSnapshot>;
  getDiagnostics(): Promise<DiagnosticCheck[]>;
  resolveApproval(id: string, decision: ApprovalDecision): Promise<boolean>;
  getPreferences(): Promise<DesktopPreferences>;
  setPreferences(value: DesktopPreferences): Promise<DesktopPreferences>;
  setContext(context: ContextChip[]): Promise<void>;
  resolveLiveSetTransition(
    token: string,
    decision: LiveSetTransitionDecision,
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
    const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(this.path), { recursive: true });
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
    private readonly storage?: LiveAgentStorageLayout,
  ) {}

  public async load(): Promise<DesktopSession[]> {
    try {
      const stored: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (!Array.isArray(stored)) {
        throw new Error("Stored sessions must be an array");
      }

      return sessionSchema.array().parse(stored);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new Error("Sessions could not be loaded", { cause: error });
    }
  }

  public async resolveOwnership(
    sessionId: string,
  ): Promise<SessionStorageOwnershipContext | undefined> {
    const session = (await this.load()).find(
      (candidate) => candidate.id === sessionId,
    );
    return session === undefined
      ? undefined
      : {
          liveSetId: session.liveSetId,
          ...(session.liveProjectId === undefined
            ? {}
            : { liveProjectId: session.liveProjectId }),
          sessionId: session.id,
        };
  }

  public async save(sessions: readonly DesktopSession[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const previousSessions =
      this.storage === undefined ? [] : await this.load();
    const hierarchySnapshot =
      this.storage === undefined
        ? []
        : await this.#snapshotHierarchyFiles(previousSessions, sessions);
    const relocations =
      this.storage === undefined
        ? []
        : await this.#relocateLiveSetStorage(previousSessions, sessions);
    const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(
        temporaryPath,
        JSON.stringify(sessionSchema.array().parse(sessions), undefined, 2),
        { encoding: "utf8", mode: 0o600 },
      );
      await this.#writeSessionManifests(sessions);
      await this.#writeLiveHierarchy(sessions);
      await rename(temporaryPath, this.path);
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      try {
        await rm(temporaryPath, { force: true });
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
      if (this.storage !== undefined) {
        for (const relocation of relocations.reverse()) {
          try {
            await relocateLiveSetStorage(
              this.storage,
              relocation.destination,
              relocation.source,
            );
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
          }
        }
        for (const session of previousSessions) {
          try {
            await this.#writeSessionManifest(session);
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
          }
        }
        try {
          await this.#restoreHierarchyFiles(hierarchySnapshot);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          "Session persistence failed and storage relocation rollback was incomplete",
        );
      }
      throw error;
    }
  }

  async #snapshotHierarchyFiles(
    previousSessions: readonly DesktopSession[],
    sessions: readonly DesktopSession[],
  ): Promise<Array<{ path: string; content?: string }>> {
    if (this.storage === undefined) return [];
    const paths = new Set<string>([this.storage.liveProjectsRegistryPath]);
    for (const session of [...previousSessions, ...sessions]) {
      const storagePaths = resolveNestedSessionStorage(this.storage, {
        liveSetId: session.liveSetId,
        ...(session.liveProjectId === undefined
          ? {}
          : { liveProjectId: session.liveProjectId }),
        sessionId: session.id,
      });
      paths.add(storagePaths.liveSet.metadataPath);
      if (storagePaths.project !== undefined) {
        paths.add(storagePaths.project.metadataPath);
      }
    }
    return Promise.all(
      [...paths].map(async (path) => {
        try {
          return { path, content: await readFile(path, "utf8") };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return { path };
          }
          throw error;
        }
      }),
    );
  }

  async #restoreHierarchyFiles(
    snapshot: readonly { path: string; content?: string }[],
  ): Promise<void> {
    const errors: unknown[] = [];
    for (const entry of snapshot) {
      try {
        if (entry.content === undefined) {
          await rm(entry.path, { force: true });
          continue;
        }
        await mkdir(dirname(entry.path), { recursive: true, mode: 0o700 });
        const temporaryPath = `${entry.path}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporaryPath, entry.content, {
            encoding: "utf8",
            mode: 0o600,
          });
          await rename(temporaryPath, entry.path);
        } catch (error) {
          await rm(temporaryPath, { force: true });
          throw error;
        }
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "Hierarchy restoration was incomplete");
    }
  }

  async #relocateLiveSetStorage(
    previousSessions: readonly DesktopSession[],
    sessions: readonly DesktopSession[],
  ): Promise<
    Array<{
      source: LiveSetStorageLocation;
      destination: LiveSetStorageLocation;
    }>
  > {
    if (this.storage === undefined) return [];
    const previousById = new Map(
      previousSessions.map((session) => [session.id, session]),
    );
    const requested = new Map<
      string,
      {
        source: LiveSetStorageLocation;
        destination: LiveSetStorageLocation;
      }
    >();
    for (const session of sessions) {
      const previous = previousById.get(session.id);
      if (previous === undefined) continue;
      const source: LiveSetStorageLocation =
        previous.liveProjectId === undefined
          ? { ownership: "unassigned", liveSetId: previous.liveSetId }
          : {
              ownership: "project",
              projectId: previous.liveProjectId,
              liveSetId: previous.liveSetId,
            };
      const destination: LiveSetStorageLocation =
        session.liveProjectId === undefined
          ? { ownership: "unassigned", liveSetId: session.liveSetId }
          : {
              ownership: "project",
              projectId: session.liveProjectId,
              liveSetId: session.liveSetId,
            };
      const sourceKey = JSON.stringify(source);
      const destinationKey = JSON.stringify(destination);
      if (sourceKey === destinationKey) continue;
      const existing = requested.get(sourceKey);
      if (
        existing !== undefined &&
        JSON.stringify(existing.destination) !== destinationKey
      ) {
        throw new Error(
          `Live Set storage cannot relocate to multiple destinations: ${source.liveSetId}`,
        );
      }
      requested.set(sourceKey, { source, destination });
    }
    const completed: Array<{
      source: LiveSetStorageLocation;
      destination: LiveSetStorageLocation;
    }> = [];
    try {
      for (const relocation of requested.values()) {
        if (
          await relocateLiveSetStorage(
            this.storage,
            relocation.source,
            relocation.destination,
          )
        ) {
          completed.push(relocation);
        }
      }
      return completed;
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      for (const relocation of completed.reverse()) {
        try {
          await relocateLiveSetStorage(
            this.storage,
            relocation.destination,
            relocation.source,
          );
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          "Live Set storage relocation failed and rollback was incomplete",
        );
      }
      throw error;
    }
  }

  async #writeSessionManifests(
    sessions: readonly DesktopSession[],
  ): Promise<void> {
    if (this.storage === undefined) return;
    for (const session of sessions) {
      await this.#writeSessionManifest(session);
    }
  }

  async #writeSessionManifest(session: DesktopSession): Promise<void> {
    if (this.storage === undefined) return;
    const paths = resolveNestedSessionStorage(this.storage, {
      liveSetId: session.liveSetId,
      ...(session.liveProjectId === undefined
        ? {}
        : { liveProjectId: session.liveProjectId }),
      sessionId: session.id,
    });
    await mkdir(paths.artifactsDirectory, {
      recursive: true,
      mode: 0o700,
    });
    await Promise.all([
      mkdir(paths.agentsDirectory, { recursive: true, mode: 0o700 }),
      mkdir(paths.skillsDirectory, { recursive: true, mode: 0o700 }),
      mkdir(paths.artifactStateDirectory, { recursive: true, mode: 0o700 }),
      mkdir(paths.memoryDirectory, { recursive: true, mode: 0o700 }),
      mkdir(paths.liveSet.memoryDirectory, { recursive: true, mode: 0o700 }),
      ...(paths.project === undefined
        ? []
        : [
            mkdir(paths.project.memoryDirectory, {
              recursive: true,
              mode: 0o700,
            }),
          ]),
    ]);
    const manifestPath = paths.manifestPath;
    const temporaryPath = `${manifestPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(
        temporaryPath,
        JSON.stringify(
          {
            version: 1,
            appSessionId: session.id,
            title: session.title,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            liveSetId: session.liveSetId,
            liveSetName: session.liveSetName,
            ...(session.liveProjectId === undefined
              ? {}
              : { liveProjectId: session.liveProjectId }),
            ...(session.liveProjectName === undefined
              ? {}
              : { liveProjectName: session.liveProjectName }),
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

  async #writeLiveHierarchy(
    sessions: readonly DesktopSession[],
  ): Promise<void> {
    if (this.storage === undefined) return;
    const projects = new Map<
      string,
      { displayName: string; liveSetIds: Set<string>; updatedAt: string }
    >();
    for (const session of sessions) {
      const paths = resolveNestedSessionStorage(this.storage, {
        liveSetId: session.liveSetId,
        ...(session.liveProjectId === undefined
          ? {}
          : { liveProjectId: session.liveProjectId }),
        sessionId: session.id,
      });
      let liveSetCreatedAt = session.updatedAt;
      try {
        liveSetCreatedAt = (
          await readLiveSetStorageMetadata(paths.liveSet.metadataPath)
        ).createdAt;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await writeLiveSetStorageMetadata(paths.liveSet.metadataPath, {
        version: 1,
        liveSetId: session.liveSetId,
        displayName: session.liveSetName,
        ...(session.liveProjectId === undefined
          ? {}
          : { projectId: session.liveProjectId }),
        createdAt: liveSetCreatedAt,
        updatedAt: session.updatedAt,
      });
      if (
        session.liveProjectId === undefined ||
        session.liveProjectName === undefined ||
        paths.project === undefined
      ) {
        continue;
      }
      let projectCreatedAt = session.updatedAt;
      try {
        projectCreatedAt = (
          await readProjectStorageMetadata(paths.project.metadataPath)
        ).createdAt;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await writeProjectStorageMetadata(paths.project.metadataPath, {
        version: 1,
        projectId: session.liveProjectId,
        displayName: session.liveProjectName,
        createdAt: projectCreatedAt,
        updatedAt: session.updatedAt,
      });
      const project = projects.get(session.liveProjectId);
      if (project === undefined) {
        projects.set(session.liveProjectId, {
          displayName: session.liveProjectName,
          liveSetIds: new Set([session.liveSetId]),
          updatedAt: session.updatedAt,
        });
      } else {
        project.displayName = session.liveProjectName;
        project.liveSetIds.add(session.liveSetId);
        if (session.updatedAt > project.updatedAt) {
          project.updatedAt = session.updatedAt;
        }
      }
    }
    if (projects.size === 0) return;
    const registry = await readLiveProjectsRegistry(
      this.storage.liveProjectsRegistryPath,
    );
    const merged = new Map(
      registry.projects.map((project) => [
        project.projectId,
        {
          projectId: project.projectId,
          displayName: project.displayName,
          liveSetIds: [...project.liveSetIds],
          updatedAt: project.updatedAt,
        },
      ]),
    );
    for (const [projectId, project] of projects) {
      const existing = merged.get(projectId);
      merged.set(projectId, {
        projectId,
        displayName: project.displayName,
        liveSetIds: [
          ...new Set([...(existing?.liveSetIds ?? []), ...project.liveSetIds]),
        ],
        updatedAt: project.updatedAt,
      });
    }
    await writeLiveProjectsRegistry(
      this.storage.liveProjectsRegistryPath,
      [...merged.values()],
      registry.revision,
    );
  }
}
