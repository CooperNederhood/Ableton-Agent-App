import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

import {
  APPLICATION_TOOL_NAMES,
  APPROVED_BUILTIN_TOOL_NAMES,
} from "@ableton-agent/application";
import {
  createNonBlockingObservabilityRecorder,
  LocalObservabilityJournal,
  sanitizeTelemetryAttributes,
  type AgentHistoryRecord,
  type ConfigurationSnapshot,
  type ConfigurationSnapshotPage,
  type ConfigurationSnapshotQuery,
  type DeleteResult,
  type JournalHealth,
  type PublicHistoryQueryResult,
  type PublicHistorySqlValue,
  type RetentionPolicy,
  type RetentionResult,
  type RootTracePage,
  type RootTraceQuery,
  type SetHistoryRecord,
  type TelemetryEventEnvelope,
  type TelemetryEventPage,
  type TraceReadOptions,
} from "@ableton-agent/observability";
import {
  resolveNestedSessionStorage,
  type LiveAgentStorageLayout,
  type StorageMigrationEvent,
} from "@ableton-agent/storage";
import {
  createAgentRuntime,
  RuntimeConfigurationError,
  type AgentRuntime,
  type LiveSetSaveAction,
} from "@ableton-agent/runtime";
import type { Logger } from "@ableton-agent/shared";
import {
  abletonToolMetadata,
  type SetHistoryQueryService,
  type ToolApprovalRequest,
} from "@ableton-agent/tools";

import {
  preferencesSchema,
  type DesktopLiveSetSnapshot,
  type DesktopPreferences,
} from "../contracts.js";
import { AgentCatalogService } from "./agent-catalog.js";
import { ApprovalCoordinator, ApprovalPolicyController } from "./approvals.js";
import {
  resolveBridgeCredential,
  type BridgeCredentialVault,
} from "./bridge-credentials.js";
import { JsonPreferencesStore, JsonSessionStore } from "./desktop-service.js";
import {
  HeadlessDesktopService,
  type DesktopEventJournal,
  type LiveSetSnapshotHistoryRecord,
  type LiveSetSnapshotHistoryRepository,
} from "./headless-desktop-service.js";
import { JsonLiveSetSessionStore } from "./live-set-session-store.js";

export interface DesktopCompositionOptions {
  preferencesPath: string;
  sessionsPath: string;
  liveSetSessionsPath?: string;
  eventJournalPath?: string;
  agentsDirectory: string;
  skillsDirectory: string;
  storage?: LiveAgentStorageLayout;
  signalDescriptorPath?: string;
  /** Copilot session storage owned by the desktop app. */
  agentBaseDirectory: string;
  /** Token from OS-backed secure storage, when one has been provisioned. */
  storedToken?: string | undefined;
  credentialVault?: BridgeCredentialVault;
  homeDirectory?: string;
  platform?: NodeJS.Platform;
  environment?: Readonly<Partial<Record<string, string>>>;
  logger?: Logger;
  onError?: (message: string, context: Record<string, unknown>) => void;
  onLoggingLevelChange?: (level: DesktopPreferences["loggingLevel"]) => void;
  storageMigrationEvents?: readonly StorageMigrationEvent[];
  storageMigrationFailure?: string;
  /** Injected read-only Set History SQL boundary owned by the unified store. */
  setHistoryQuery?: SetHistoryQueryService;
  /** Injected snapshot writer until the unified history repository lands. */
  snapshotHistory?: LiveSetSnapshotHistoryRepository;
}

export interface DesktopComposition {
  service: HeadlessDesktopService;
  runtime: AgentRuntime;
  telemetry: ReturnType<typeof createNonBlockingObservabilityRecorder>;
  preferences: DesktopPreferences;
  /** Main-process-only credential used by the bridge and Signal ingress. */
  bridgeToken?: string;
}

const missingTokenDetail =
  "No usable Remote Script token is configured or available from the installed script.";

async function loadPreferences(
  store: JsonPreferencesStore,
  notices: Notice[],
): Promise<DesktopPreferences> {
  try {
    return await store.load();
  } catch (error) {
    notices.push({
      label: "Preferences",
      status: "warn",
      detail: `Stored preferences could not be read (${error instanceof Error ? error.message : String(error)}); defaults are in use.`,
    });
    return preferencesSchema.parse({});
  }
}

interface Notice {
  label: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function snapshotContent(snapshot: DesktopLiveSetSnapshot): object {
  const { capturedAt, source, transport, ...musical } = snapshot;
  void capturedAt;
  void source;
  return {
    ...musical,
    ...(transport === undefined
      ? {}
      : {
          transport: {
            ...(transport.arrangementLoop === undefined
              ? {}
              : { arrangementLoop: transport.arrangementLoop }),
          },
        }),
  };
}

function createSnapshotHistoryRepository(
  journal: DesktopJournalHost,
): LiveSetSnapshotHistoryRepository {
  return {
    save: async (record: LiveSetSnapshotHistoryRecord) => {
      const normalized = snapshotContent(record.snapshot);
      const contentHash = createHash("sha256")
        .update(stableJson(normalized))
        .digest("hex");
      const snapshotId = `snapshot:${contentHash}`;
      const observationId = randomUUID();
      const common = {
        version: 1 as const,
        appSessionId: record.productionSessionId,
        liveSetId: record.snapshot.liveSetId,
        liveProjectId: record.snapshot.liveProjectId,
      };
      await journal.appendSetHistory({
        ...common,
        kind: "set_save",
        id: observationId,
        occurredAt: record.observedAt ?? record.capturedAt,
        trigger: record.trigger === "manual" ? "user" : "live",
        outcome: "success",
        details: sanitizeTelemetryAttributes({
          snapshotId,
          source: record.trigger,
          fileModifiedTimeNs: record.fileModifiedTimeNs,
          fileSizeBytes: record.fileSizeBytes,
          activeAgentInstanceIds: record.activeAgentInstanceIds,
          sdkSessionIds: record.sdkSessionIds,
        }),
      });
      await journal.appendSetHistory({
        ...common,
        kind: "set_snapshot",
        id: snapshotId,
        occurredAt: record.capturedAt,
        snapshotKind: record.trigger === "manual" ? "checkpoint" : "detailed",
        revision: contentHash,
        snapshot: sanitizeTelemetryAttributes({
          ...record.snapshot,
          normalizedHash: contentHash,
        }),
      });
      await Promise.all(
        record.activeAgentInstanceIds.map((activeAgentId, index) =>
          journal.appendSetHistory({
            ...common,
            kind: "set_trajectory",
            id: randomUUID(),
            occurredAt: record.capturedAt,
            trajectoryType:
              record.trigger === "manual"
                ? "manual_checkpoint"
                : "active_at_save",
            activeAgentId,
            ...(record.sdkSessionIds[index] === undefined
              ? {}
              : { agentSessionId: record.sdkSessionIds[index] }),
            summary: "Agent active when the Live Set checkpoint was captured",
            data: sanitizeTelemetryAttributes({
              observationId,
              snapshotId,
              relation:
                record.trigger === "manual"
                  ? "manual_checkpoint"
                  : "active_at_save",
              confidence: 1,
            }),
          }),
        ),
      );
    },
  };
}

type JournalWrite =
  | { kind: "event"; value: TelemetryEventEnvelope }
  | { kind: "configuration"; value: ConfigurationSnapshot }
  | { kind: "agent_history"; value: AgentHistoryRecord }
  | { kind: "set_history"; value: SetHistoryRecord };

export interface DesktopJournalHostOptions {
  path: string;
  retention: RetentionPolicy;
  enabled: boolean;
  open?: (
    options: Parameters<typeof LocalObservabilityJournal.open>[0],
  ) => Promise<LocalObservabilityJournal>;
}

/**
 * Keeps instrumentation pointed at an open journal while retention settings
 * replace the file-backed instance. Writes arriving during the handoff are
 * buffered and drained only after the new journal (or rollback) is ready.
 */
export class DesktopJournalHost implements DesktopEventJournal {
  readonly #path: string;
  readonly #open: NonNullable<DesktopJournalHostOptions["open"]>;
  #journal: LocalObservabilityJournal | undefined;
  #retention: RetentionPolicy;
  #enabled: boolean;
  #switching = false;
  #buffer: JournalWrite[] = [];
  #failure: string | undefined;
  #transition: Promise<void> | undefined;
  #shutdown = false;

  private constructor(
    options: DesktopJournalHostOptions,
    journal: LocalObservabilityJournal | undefined,
    failure?: string,
  ) {
    this.#path = options.path;
    this.#retention = options.retention;
    this.#enabled = options.enabled && journal !== undefined;
    this.#open =
      options.open ??
      ((openOptions) => LocalObservabilityJournal.open(openOptions));
    this.#journal = journal;
    this.#failure = failure;
  }

  public static async create(
    options: DesktopJournalHostOptions,
  ): Promise<DesktopJournalHost> {
    const open =
      options.open ??
      ((openOptions) => LocalObservabilityJournal.open(openOptions));
    try {
      return new DesktopJournalHost(
        options,
        await open({ path: options.path, retention: options.retention }),
      );
    } catch (error) {
      return new DesktopJournalHost(
        options,
        undefined,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  public get journal(): LocalObservabilityJournal | undefined {
    return this.#journal;
  }

  public get failure(): string | undefined {
    return this.#failure;
  }

  public setEnabled(enabled: boolean): void {
    this.#enabled = enabled && this.#journal !== undefined;
  }

  public enqueue(event: TelemetryEventEnvelope): Promise<void> {
    return this.#write({ kind: "event", value: event });
  }

  public enqueueConfigurationSnapshot(
    snapshot: ConfigurationSnapshot,
  ): Promise<void> {
    return this.#write({ kind: "configuration", value: snapshot });
  }

  public appendAgentHistory(record: AgentHistoryRecord): Promise<void> {
    return this.#write({ kind: "agent_history", value: record });
  }

  public appendSetHistory(record: SetHistoryRecord): Promise<void> {
    return this.#write({ kind: "set_history", value: record });
  }

  public async queryPublicHistory(
    sql: string,
    parameters: readonly PublicHistorySqlValue[],
    maxRows: number,
  ): Promise<PublicHistoryQueryResult> {
    return (await this.#activeJournal()).queryPublicHistory(
      sql,
      parameters,
      maxRows,
    );
  }

  public async reconfigure(retention: RetentionPolicy): Promise<void> {
    if (this.#shutdown)
      throw new Error("Detailed event history is unavailable");
    await this.#transition;
    if (this.#shutdown)
      throw new Error("Detailed event history is unavailable");
    const operation = this.#replace(retention);
    const transition = operation.then(
      () => undefined,
      () => undefined,
    );
    this.#transition = transition;
    void transition.finally(() => {
      if (this.#transition === transition) this.#transition = undefined;
    });
    return operation;
  }

  async #replace(retention: RetentionPolicy): Promise<void> {
    const previous = this.#journal;
    if (previous === undefined) {
      throw new Error(this.#failure ?? "Detailed event history is unavailable");
    }
    const previousRetention = this.#retention;
    const wasEnabled = this.#enabled;
    this.#switching = true;
    try {
      await previous.shutdown();
    } catch (error) {
      await this.#recoverPrevious(
        previous,
        previousRetention,
        wasEnabled,
        error,
        true,
      );
    }
    this.#journal = undefined;
    try {
      this.#journal = await this.#open({ path: this.#path, retention });
      this.#retention = retention;
      this.#failure = undefined;
    } catch (error) {
      await this.#recoverPrevious(
        previous,
        previousRetention,
        wasEnabled,
        error,
        false,
      );
    }
    this.#switching = false;
    this.#enabled = wasEnabled;
    try {
      await this.#drain();
    } catch (error) {
      this.#buffer = [];
      this.#failure = `Buffered event journal writes could not be drained: ${this.#errorMessage(error)}`;
      throw error;
    }
  }

  async #recoverPrevious(
    previous: LocalObservabilityJournal,
    retention: RetentionPolicy,
    wasEnabled: boolean,
    cause: unknown,
    canReusePrevious: boolean,
  ): Promise<never> {
    const recoveryErrors: unknown[] = [];
    let recovered: LocalObservabilityJournal | undefined;
    let safeToReopen = !canReusePrevious;
    if (canReusePrevious) {
      if (!previous.isOpen) {
        safeToReopen = true;
      } else {
        try {
          const health = await previous.getHealth();
          if (health.status === "closed") {
            safeToReopen = true;
          } else {
            recovered = previous;
          }
        } catch (error) {
          recoveryErrors.push(error);
          try {
            await previous.shutdown();
            safeToReopen = true;
          } catch (shutdownError) {
            recoveryErrors.push(shutdownError);
            safeToReopen = !previous.isOpen;
          }
        }
      }
    }
    if (recovered === undefined && safeToReopen) {
      try {
        recovered = await this.#open({ path: this.#path, retention });
      } catch (error) {
        recoveryErrors.push(error);
      }
    }
    if (recovered === undefined) {
      this.#journal = undefined;
      this.#enabled = false;
      this.#switching = false;
      this.#buffer = [];
      this.#failure = `Event journal transition failed without recovery: ${this.#errorMessage(cause)}`;
      throw new AggregateError(
        [cause, ...recoveryErrors],
        "Event journal transition and recovery failed",
      );
    }
    this.#journal = recovered;
    this.#retention = retention;
    this.#enabled = wasEnabled;
    this.#switching = false;
    this.#failure = `Event journal retained its previous policy after a failed transition: ${this.#errorMessage(cause)}`;
    try {
      await this.#drain();
    } catch (error) {
      this.#buffer = [];
      this.#failure = `Event journal recovered, but buffered writes could not be drained: ${this.#errorMessage(error)}`;
      throw new AggregateError(
        [cause, error],
        "Event journal recovered with buffered write failures",
      );
    }
    throw cause;
  }

  #errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  public async readRootTraces(
    query: RootTraceQuery = {},
  ): Promise<RootTracePage> {
    return (await this.#activeJournal()).readRootTraces(query);
  }

  public async readTrace(
    rootTraceId: string,
    options: TraceReadOptions = {},
  ): Promise<TelemetryEventPage> {
    return (await this.#activeJournal()).readTrace(rootTraceId, options);
  }

  public async readConfigurationSnapshots(
    query: ConfigurationSnapshotQuery = {},
  ): Promise<ConfigurationSnapshotPage> {
    return (await this.#activeJournal()).readConfigurationSnapshots(query);
  }

  public async getHealth(): Promise<JournalHealth> {
    return (await this.#activeJournal()).getHealth();
  }

  public async runRetention(): Promise<RetentionResult> {
    return (await this.#activeJournal()).runRetention();
  }

  public async deleteTrace(rootTraceId: string): Promise<number> {
    return (await this.#activeJournal()).deleteTrace(rootTraceId);
  }

  public async clear(): Promise<DeleteResult> {
    return (await this.#activeJournal()).clear();
  }

  public async shutdown(): Promise<void> {
    if (this.#shutdown) return;
    this.#shutdown = true;
    await this.#transition;
    this.#enabled = false;
    this.#switching = false;
    this.#buffer = [];
    const journal = this.#journal;
    this.#journal = undefined;
    await journal?.shutdown();
  }

  async #activeJournal(): Promise<LocalObservabilityJournal> {
    await this.#transition;
    const journal = this.#journal;
    if (journal === undefined || this.#shutdown) {
      throw new Error(this.#failure ?? "Detailed event history is unavailable");
    }
    return journal;
  }

  #write(write: JournalWrite): Promise<void> {
    if (this.#shutdown) return Promise.resolve();
    if (
      !this.#enabled &&
      (write.kind === "event" || write.kind === "configuration")
    ) {
      return Promise.resolve();
    }
    if (this.#switching || this.#journal === undefined) {
      this.#buffer.push(write);
      return Promise.resolve();
    }
    if (write.kind === "event") return this.#journal.enqueue(write.value);
    if (write.kind === "configuration") {
      return this.#journal.enqueueConfigurationSnapshot(write.value);
    }
    if (write.kind === "agent_history") {
      return this.#journal.appendAgentHistory(write.value);
    }
    return this.#journal.appendSetHistory(write.value);
  }

  async #drain(): Promise<void> {
    while (this.#buffer.length > 0) {
      const write = this.#buffer.shift();
      if (write === undefined || this.#journal === undefined) return;
      if (write.kind === "event") await this.#journal.enqueue(write.value);
      else if (write.kind === "configuration") {
        await this.#journal.enqueueConfigurationSnapshot(write.value);
      } else if (write.kind === "agent_history") {
        await this.#journal.appendAgentHistory(write.value);
      } else {
        await this.#journal.appendSetHistory(write.value);
      }
    }
  }
}

/**
 * Composes the Electron main process on the same headless application the CLI
 * uses. Bridge ports come from persisted preferences; the bridge token comes
 * from OS-backed storage, the environment, or an installed Remote Script.
 */
export async function createDesktopComposition(
  options: DesktopCompositionOptions,
): Promise<DesktopComposition> {
  const environment = options.environment ?? {};
  const preferencesStore = new JsonPreferencesStore(options.preferencesPath);
  const sessionStore = new JsonSessionStore(
    options.sessionsPath,
    options.storage,
  );
  const liveSetSessionStore = new JsonLiveSetSessionStore(
    options.liveSetSessionsPath ??
      join(dirname(options.sessionsPath), "live-set-sessions.json"),
  );
  const agentCatalog = new AgentCatalogService({
    agentsDirectory: options.agentsDirectory,
    skillsDirectory: options.skillsDirectory,
    availableTools: [
      ...abletonToolMetadata.map((tool) => tool.name),
      ...APPLICATION_TOOL_NAMES,
      ...APPROVED_BUILTIN_TOOL_NAMES,
    ],
    ...(options.storage === undefined ? {} : { storage: options.storage }),
    resolveSessionOwnership: (sessionId) =>
      sessionStore.resolveOwnership(sessionId),
  });
  const notices: Notice[] =
    options.storageMigrationFailure === undefined
      ? []
      : [
          {
            label: "Local storage migration",
            status: "fail",
            detail: options.storageMigrationFailure,
          },
        ];
  const preferences = await loadPreferences(preferencesStore, notices);
  const eventJournalPath =
    options.eventJournalPath ??
    join(dirname(options.preferencesPath), "agent-set-event-history.sqlite");
  const journalHost = await DesktopJournalHost.create({
    path: eventJournalPath,
    retention: {
      maxAgeDays: preferences.eventHistoryRetentionDays,
      maxBytes: preferences.eventHistoryMaxBytes,
    },
    enabled: preferences.eventHistoryEnabled,
  });
  if (journalHost.failure !== undefined) {
    notices.push({
      label: "Event journal",
      status: "fail",
      detail: `Detailed history is disabled because the existing journal could not be opened: ${journalHost.failure}`,
    });
  }
  const telemetry = createNonBlockingObservabilityRecorder(
    {
      enqueue: (event) => journalHost.enqueue(event),
      enqueueConfigurationSnapshot: (snapshot) =>
        journalHost.enqueueConfigurationSnapshot(snapshot),
    },
    {
      onFailure: ({ operation, error }) =>
        options.onError?.("Detailed event history write failed", {
          operation,
          error: error instanceof Error ? error.message : String(error),
        }),
    },
  );
  for (const event of options.storageMigrationEvents ?? []) {
    telemetry.enqueue({
      version: 2,
      id: event.id,
      occurredAt: event.occurredAt,
      name: event.name,
      category: "storage",
      source: "desktop-storage",
      level: event.outcome === "failure" ? "error" : "info",
      ...(event.outcome === undefined ? {} : { outcome: event.outcome }),
      ...(event.durationMs === undefined
        ? {}
        : { durationMs: event.durationMs }),
      correlationId: event.correlationId,
      ...(event.causationId === undefined
        ? {}
        : { causationId: event.causationId }),
      trace: {
        traceId: event.traceId,
        spanId: event.spanId,
        ...(event.parentSpanId === undefined
          ? {}
          : { parentSpanId: event.parentSpanId }),
      },
      attributes: event.attributes,
    });
  }
  const reconfigureEventJournal = async (
    retention: RetentionPolicy,
  ): Promise<void> => journalHost.reconfigure(retention);
  const credential = await resolveBridgeCredential({
    ...(options.storedToken === undefined
      ? {}
      : { storedToken: options.storedToken }),
    ...(options.credentialVault === undefined
      ? {}
      : { vault: options.credentialVault }),
    environment,
    remoteScriptLocation: preferences.remoteScriptLocation,
    ...(options.homeDirectory === undefined
      ? {}
      : { homeDirectory: options.homeDirectory }),
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    telemetry,
  });
  for (const notice of credential.notices) {
    notices.push({
      label: "Bridge credentials",
      status: notice.status,
      detail: notice.detail,
    });
  }
  const token = credential.token;
  const approvals = new ApprovalCoordinator();
  const approvalPolicy = new ApprovalPolicyController(
    preferences.approvalPolicy,
    approvals,
  );
  let agentTurnTimeoutMs = preferences.agentTurnTimeoutMinutes * 60_000;
  let agentReasoningVisibility = preferences.agentReasoningVisibility;
  // Preferences already constrain the port to a valid TCP range.
  const port = preferences.abletonPort;
  const storage = options.storage;
  const inMemorySessionSource: {
    read?: () => ReturnType<HeadlessDesktopService["getSessions"]>;
  } = {};
  const serviceRef: { current?: HeadlessDesktopService } = {};
  const snapshotHistory =
    options.snapshotHistory ??
    (journalHost.journal === undefined
      ? undefined
      : createSnapshotHistoryRepository(journalHost));
  const setHistoryQuery: SetHistoryQueryService | undefined =
    options.setHistoryQuery ??
    (journalHost.journal === undefined
      ? undefined
      : {
          query: async ({ sql, parameters, maxRows, signal }) => {
            signal?.throwIfAborted();
            const result = await journalHost.queryPublicHistory(
              sql,
              parameters,
              maxRows,
            );
            signal?.throwIfAborted();
            return result;
          },
        });
  const snapshotCaptureAction: LiveSetSaveAction = {
    id: "capture-lom-snapshot",
    lifecycleName: "live_set.snapshot_capture",
    execute: async (context) => {
      if (serviceRef.current === undefined) {
        throw new Error("Desktop snapshot capture is not ready");
      }
      await serviceRef.current.captureObservedSave(context);
    },
  };

  const runtimeOptions = {
    ableton: {
      port,
      unconfiguredMessage: missingTokenDetail,
      ...(token === undefined || token === "" ? {} : { token }),
    },
    agent: {
      baseDirectory: options.agentBaseDirectory,
      turnTimeoutMs: () => agentTurnTimeoutMs,
      reasoningSummary: () => agentReasoningVisibility,
      resolveSkill: (sessionId: string, skillName: string) =>
        agentCatalog.resolveRuntimeSkill(sessionId, skillName),
      ...(storage === undefined
        ? {}
        : {
            resolvePlanArtifactPaths: async (sessionId: string) => {
              const persistedOwnership =
                await sessionStore.resolveOwnership(sessionId);
              const activeSession = (
                await inMemorySessionSource.read?.()
              )?.find((session) => session.id === sessionId);
              const ownership =
                persistedOwnership ??
                (activeSession === undefined
                  ? undefined
                  : {
                      liveSetId: activeSession.liveSetId,
                      ...(activeSession.liveProjectId === undefined
                        ? {}
                        : { liveProjectId: activeSession.liveProjectId }),
                      sessionId: activeSession.id,
                    });
              if (ownership === undefined) {
                throw new Error(
                  `Plan artifact session '${sessionId}' does not exist`,
                );
              }
              return resolveNestedSessionStorage(storage, ownership);
            },
          }),
    },
    requestToolApproval: (request: ToolApprovalRequest) =>
      approvalPolicy.request(request),
    askForReadApproval: approvalPolicy.askForReads,
    ...(journalHost.journal === undefined
      ? {}
      : {
          agentHistory: journalHost,
          currentAppSessionId: () => serviceRef.current?.activeSessionId,
          currentLiveProjectId: () => serviceRef.current?.activeLiveProjectId,
        }),
    ...(setHistoryQuery === undefined ? {} : { setHistoryQuery }),
    liveSetSaves: {
      actions: snapshotHistory === undefined ? [] : [snapshotCaptureAction],
    },
    signal: {
      port: preferences.signalPort,
      ...(options.signalDescriptorPath === undefined
        ? {}
        : { descriptorPath: options.signalDescriptorPath }),
    },
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    telemetry,
  };
  let runtime: AgentRuntime;
  try {
    runtime = createAgentRuntime(runtimeOptions);
  } catch (error) {
    if (!(error instanceof RuntimeConfigurationError)) throw error;
    notices.push({
      label: "Bridge credentials",
      status: "fail",
      detail: `${error.message} Running without a bridge connection.`,
    });
    runtime = createAgentRuntime({
      ...runtimeOptions,
      ableton: {
        port,
        unconfiguredMessage: `${error.message} ${missingTokenDetail}`,
      },
    });
  }
  if (
    !runtime.abletonConfigured &&
    !notices.some((notice) => notice.label === "Bridge credentials")
  ) {
    notices.push({
      label: "Bridge credentials",
      status: "warn",
      detail: missingTokenDetail,
    });
  }

  const desktopService = new HeadlessDesktopService({
    application: runtime.application,
    approvals,
    preferencesStore,
    sessionStore,
    liveSetSessionStore,
    agentCatalog,
    signals: runtime.signals,
    liveEvents: runtime.liveEvents,
    ...(snapshotHistory === undefined ? {} : { snapshotHistory }),
    ...(journalHost.journal === undefined ? {} : { eventJournal: journalHost }),
    eventHistoryUnavailable: journalHost.journal === undefined,
    reconfigureEventJournal,
    onEventHistoryEnabledChange: (enabled) => journalHost.setEnabled(enabled),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    startupNotices: notices,
    ...(options.onError === undefined ? {} : { onError: options.onError }),
    ...(options.onLoggingLevelChange === undefined
      ? {}
      : { onLoggingLevelChange: options.onLoggingLevelChange }),
    onApprovalPolicyChange: (policy) => approvalPolicy.setPolicy(policy),
    onAgentTurnTimeoutChange: (minutes) => {
      agentTurnTimeoutMs = minutes * 60_000;
    },
    onAgentReasoningVisibilityChange: (visibility) => {
      agentReasoningVisibility = visibility;
    },
    onAutoApprovedAgentIdsChange: (ids) =>
      approvalPolicy.setAutoApprovedAgentInstanceIds(ids),
  });
  serviceRef.current = desktopService;
  inMemorySessionSource.read = () => desktopService.getSessions();
  return {
    service: desktopService,
    runtime,
    telemetry,
    ...(token === undefined ? {} : { bridgeToken: token }),
    preferences:
      journalHost.journal === undefined
        ? { ...preferences, eventHistoryEnabled: false }
        : preferences,
  };
}
