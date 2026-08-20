import { homedir } from "node:os";
import { join } from "node:path";

import type { AbletonService } from "@ableton-agent/ableton-contracts";
import {
  formatSkillInvocation,
  parseSkillInvocation,
  skillNameSchema,
  type BoundTrackScope,
  type EditScopeEntry,
  type SkillInvocation,
} from "@ableton-agent/agent-config";
import type {
  CapabilityDocument,
  CreateCuePointParams,
  CuePointMutationResult,
  CreateArrangementMidiClipParams,
  CreateArrangementMidiClipResult,
  DeleteArrangementClipParams,
  DeleteArrangementClipResult,
  DeleteCuePointParams,
  DuplicateClipToArrangementParams,
  DuplicateClipToArrangementResult,
  DuplicateSessionClipParams,
  DuplicateSessionClipResult,
  CreateMidiClipParams,
  CreateMidiClipResult,
  CreateTrackParams,
  DeleteTrackParams,
  DeleteSessionClipParams,
  DeleteSessionClipResult,
  RenameTrackParams,
  RenameTrackResult,
  ReplaceMidiNotesParams,
  ReplaceMidiNotesResult,
  LaunchSessionClipParams,
  LaunchSessionClipResult,
  ReplaceArrangementMidiNotesParams,
  ReplaceArrangementMidiNotesResult,
  SetArrangementClipPropertiesParams,
  SetArrangementClipPropertiesResult,
  SetArrangementLoopParams,
  SetArrangementLoopResult,
  SetSessionClipPropertiesParams,
  SetSessionClipPropertiesResult,
  PingResult,
  InspectArrangementParams,
  InspectArrangementResult,
  InspectArrangementMidiNotesParams,
  InspectArrangementMidiNotesResult,
  InspectArrangementTransportParams,
  InspectArrangementTransportResult,
  InspectDeviceParametersParams,
  InspectDeviceParametersResult,
  InspectDevicesParams,
  InspectDevicesResult,
  InspectBrowserRootsResult,
  InspectBrowserChildrenParams,
  InspectBrowserChildrenResult,
  SearchBrowserParams,
  SearchBrowserResult,
  LoadBrowserItemParams,
  LoadBrowserItemResult,
  InspectDrumPadChainDevicesParams,
  InspectDrumPadChainDevicesResult,
  InspectDrumPadChainsParams,
  InspectDrumPadChainsResult,
  InspectDrumRackPadsParams,
  InspectDrumRackPadsResult,
  InspectMidiNotesParams,
  InspectMidiNotesResult,
  InspectRackChainDevicesParams,
  InspectRackChainDevicesResult,
  InspectRackChainsParams,
  InspectRackChainsResult,
  SessionSnapshot,
  SetPlayingResult,
  SetTempoResult,
  SetTrackMixerParams,
  SetTrackMixerResult,
  SetDeviceEnabledParams,
  SetDeviceEnabledResult,
  SetDeviceParameterParams,
  SetDeviceParameterResult,
  TrackMutationResult,
} from "@ableton-agent/protocol";
import type {
  AppEvent,
  ConnectionStatus,
  EventPublisher,
  LifecycleState,
  Logger,
} from "@ableton-agent/shared";
import { noopLogger } from "@ableton-agent/shared";
import {
  AbletonMutationAuthorizationError,
  abletonToolMetadata,
  createAbletonMutationAuthorizer,
  createAbletonMutationLockManager,
  createAbletonPermissionHandler,
  createAbletonTools,
  runAuthorizedAbletonMutation,
  type AbletonMutationAuthorizationContext,
  type ToolApprovalRequester,
} from "@ableton-agent/tools";
import {
  CopilotClient,
  type ResumeSessionConfig,
  type SessionConfig,
  type SessionEvent,
  type Tool,
  type ToolInvocation,
} from "@github/copilot-sdk";

import { createAgentPolicy } from "./agent-policy.js";
import {
  formatAutomaticSignalPrompt,
  type SignalContextOptions,
  type SignalDeliveryService,
  type SignalTurnRequest,
} from "./signal-delivery.js";

export {
  compactProjectContext,
  createAgentHooks,
  createAgentPolicy,
  retryGuidance,
  structuredErrorCode,
} from "./agent-policy.js";
export {
  constructNextPromptSignalContext,
  DEFAULT_SIGNAL_USAGE_INSTRUCTION,
  formatAutomaticSignalPrompt,
  type PendingSignalContext,
  type SignalContextOptions,
  type SignalContextProvider,
  type SignalDeliveryMode,
  type SignalDeliveryService,
  type SignalTurnRequest,
} from "./signal-delivery.js";

export interface AgentSessionConfiguration {
  readonly instanceId: string;
  readonly definitionName: string;
  readonly label: string;
  readonly description: string;
  readonly systemPrompt: string;
  readonly resolvedTools: readonly string[];
  readonly editScope: readonly EditScopeEntry[];
  readonly boundTracks: readonly BoundTrackScope[];
  readonly skills: readonly string[];
  readonly skillDirectories: readonly string[];
  readonly availableSkills?: readonly string[];
}

export interface AgentHistoryMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly timestamp: string;
  readonly eventId: string;
  readonly messageId?: string;
  readonly agentInstanceId?: string;
  readonly sdkSessionId?: string;
}

export interface AgentService extends Partial<SignalDeliveryService> {
  /** Identifier of the current agent conversation, when one is open. */
  readonly sessionId: string | undefined;
  start(preferredSessionId?: string): Promise<void>;
  stop(): Promise<void>;
  send(prompt: string): Promise<string>;
  /**
   * Aborts an in-flight turn. Resolves `false` when nothing was running, so
   * callers never report a cancellation that did not happen. Work already
   * applied to Live is not undone.
   */
  cancel(): Promise<boolean>;
  /** Replaces the current conversation with a new one and returns its ID. */
  createSession(): Promise<string>;
  /** Reopens a previously created conversation by ID. */
  resumeSession(sessionId: string): Promise<void>;
  /** Creates or replaces a managed agent session for one application instance. */
  createManagedAgent?(
    configuration: AgentSessionConfiguration,
  ): Promise<string>;
  /** Reconnects one managed agent instance to an existing SDK session. */
  resumeManagedAgent?(
    configuration: AgentSessionConfiguration,
    sdkSessionId: string,
  ): Promise<void>;
  /** Reconfigures one managed agent instance without changing its SDK session. */
  reconfigureManagedAgent?(
    configuration: AgentSessionConfiguration,
  ): Promise<void>;
  /** Disconnects one managed agent instance from its SDK session. */
  deactivateManagedAgent?(instanceId: string): Promise<void>;
  /** Sends a user prompt to one managed agent instance. */
  sendToManagedAgent?(instanceId: string, prompt: string): Promise<string>;
  /** Explicitly invokes one configured skill for a managed agent instance. */
  invokeManagedAgentSkill?(
    instanceId: string,
    invocation: string | SkillInvocation,
  ): Promise<string>;
  /** Cancels an in-flight turn for one managed agent instance. */
  cancelManagedAgent?(instanceId: string): Promise<boolean>;
  /** Current SDK session id for a managed agent instance, when connected. */
  getManagedAgentSessionId?(instanceId: string): string | undefined;
  /** Normalized persisted user/assistant history for one managed instance. */
  getManagedAgentHistory?(
    instanceId: string,
  ): Promise<readonly AgentHistoryMessage[]>;
}

export type { AbletonService } from "@ableton-agent/ableton-contracts";

export interface ApplicationServices {
  agent: AgentService;
  ableton: AbletonService;
  events: EventPublisher;
  logger: Logger;
}

export interface ApplicationStartOptions {
  startAgent?: boolean;
  preferredAgentSessionId?: string;
}

interface CopilotResponse {
  data: { content: string };
}

interface CopilotSessionAdapter {
  readonly sessionId: string;
  sendAndWait(
    prompt: string,
    timeoutMs?: number,
  ): Promise<CopilotResponse | undefined>;
  abort(): Promise<void>;
  disconnect(): Promise<void>;
  on(listener: (event: SessionEvent) => void): () => void;
  getEvents?(): Promise<readonly SessionEvent[]>;
}

interface CopilotClientAdapter {
  createSession(config: SessionConfig): Promise<CopilotSessionAdapter>;
  resumeSession(
    sessionId: string,
    config: ResumeSessionConfig,
  ): Promise<CopilotSessionAdapter>;
  stop(): Promise<unknown>;
}

export interface CopilotAgentServiceOptions {
  events: EventPublisher;
  logger?: Logger;
  getAbletonStatus: () => Promise<ConnectionStatus>;
  inspectSession: () => Promise<SessionSnapshot>;
  setTempo: (tempo: number) => Promise<SetTempoResult>;
  setPlaying: (isPlaying: boolean) => Promise<SetPlayingResult>;
  inspectArrangementTransport: (
    params: InspectArrangementTransportParams,
  ) => Promise<InspectArrangementTransportResult>;
  setArrangementLoop: (
    params: SetArrangementLoopParams,
  ) => Promise<SetArrangementLoopResult>;
  createCuePoint: (
    params: CreateCuePointParams,
  ) => Promise<CuePointMutationResult>;
  deleteCuePoint: (
    params: DeleteCuePointParams,
  ) => Promise<CuePointMutationResult>;
  createTrack: (params: CreateTrackParams) => Promise<TrackMutationResult>;
  deleteTrack: (params: DeleteTrackParams) => Promise<TrackMutationResult>;
  renameTrack: (params: RenameTrackParams) => Promise<RenameTrackResult>;
  setTrackMixer: (params: SetTrackMixerParams) => Promise<SetTrackMixerResult>;
  inspectDevices: (
    params: InspectDevicesParams,
  ) => Promise<InspectDevicesResult>;
  inspectBrowserRoots: () => Promise<InspectBrowserRootsResult>;
  inspectBrowserChildren: (
    params: InspectBrowserChildrenParams,
  ) => Promise<InspectBrowserChildrenResult>;
  searchBrowser: (params: SearchBrowserParams) => Promise<SearchBrowserResult>;
  loadBrowserItem: (
    params: LoadBrowserItemParams,
  ) => Promise<LoadBrowserItemResult>;
  inspectDeviceParameters: (
    params: InspectDeviceParametersParams,
  ) => Promise<InspectDeviceParametersResult>;
  inspectRackChains: (
    params: InspectRackChainsParams,
  ) => Promise<InspectRackChainsResult>;
  inspectRackChainDevices: (
    params: InspectRackChainDevicesParams,
  ) => Promise<InspectRackChainDevicesResult>;
  inspectDrumRackPads: (
    params: InspectDrumRackPadsParams,
  ) => Promise<InspectDrumRackPadsResult>;
  inspectDrumPadChains: (
    params: InspectDrumPadChainsParams,
  ) => Promise<InspectDrumPadChainsResult>;
  inspectDrumPadChainDevices: (
    params: InspectDrumPadChainDevicesParams,
  ) => Promise<InspectDrumPadChainDevicesResult>;
  setDeviceEnabled: (
    params: SetDeviceEnabledParams,
  ) => Promise<SetDeviceEnabledResult>;
  setDeviceParameter: (
    params: SetDeviceParameterParams,
  ) => Promise<SetDeviceParameterResult>;
  createMidiClip: (
    params: CreateMidiClipParams,
  ) => Promise<CreateMidiClipResult>;
  replaceMidiNotes: (
    params: ReplaceMidiNotesParams,
  ) => Promise<ReplaceMidiNotesResult>;
  launchSessionClip: (
    params: LaunchSessionClipParams,
  ) => Promise<LaunchSessionClipResult>;
  duplicateSessionClip: (
    params: DuplicateSessionClipParams,
  ) => Promise<DuplicateSessionClipResult>;
  deleteSessionClip: (
    params: DeleteSessionClipParams,
  ) => Promise<DeleteSessionClipResult>;
  setSessionClipProperties: (
    params: SetSessionClipPropertiesParams,
  ) => Promise<SetSessionClipPropertiesResult>;
  createArrangementMidiClip: (
    params: CreateArrangementMidiClipParams,
  ) => Promise<CreateArrangementMidiClipResult>;
  inspectArrangement: (
    params: InspectArrangementParams,
  ) => Promise<InspectArrangementResult>;
  deleteArrangementClip: (
    params: DeleteArrangementClipParams,
  ) => Promise<DeleteArrangementClipResult>;
  replaceArrangementMidiNotes: (
    params: ReplaceArrangementMidiNotesParams,
  ) => Promise<ReplaceArrangementMidiNotesResult>;
  duplicateClipToArrangement: (
    params: DuplicateClipToArrangementParams,
  ) => Promise<DuplicateClipToArrangementResult>;
  setArrangementClipProperties: (
    params: SetArrangementClipPropertiesParams,
  ) => Promise<SetArrangementClipPropertiesResult>;
  requestToolApproval?: ToolApprovalRequester;
  askForReadApproval?: boolean | (() => boolean);
  clientFactory?: () => CopilotClientAdapter;
  baseDirectory?: string;
  model?: string;
  reasoningEffort?: "low" | "medium" | "high";
  turnTimeoutMs?: number;
  signalContext?: SignalContextOptions;
}

export const DEFAULT_AGENT_TURN_TIMEOUT_MS = 180_000;
export const BASE_SYSTEM_MESSAGE_VERSION = 3;
export const BASE_SYSTEM_MESSAGE =
  "You are an Ableton Live production assistant. Use only the provided Ableton tools. Inspect current project state before making claims. Clearly distinguish observed state from suggestions. For every requested instrument, kit, preset, or sound, search the Ableton Browser before creating its destination track. Search each distinct requested sound separately, choose roots deliberately, and resolve an exact supported loadable item. Prefer exact, loadable device or preset results over folders or loose substring matches. If search is truncated or the matches are weak, narrow the roots or try a literal musical synonym before choosing. Only after resolving the content should you create the destination track and load that exact item. Perform dependent mutations sequentially. Never retry a mutation that may already have applied; re-inspect state first and continue from the verified result.";

export class AgentTurnTimeoutError extends Error {
  public constructor(
    public readonly timeoutMs: number,
    public readonly abortError?: unknown,
  ) {
    super(
      abortError === undefined
        ? `Copilot turn timed out after ${timeoutMs}ms and was cancelled`
        : `Copilot turn timed out after ${timeoutMs}ms, and cancellation also failed`,
      abortError === undefined ? undefined : { cause: abortError },
    );
    this.name = "AgentTurnTimeoutError";
  }
}

function isSessionIdleTimeout(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" ||
      /timeout after \d+ms waiting for session\.idle/i.test(error.message))
  );
}

const DEFAULT_AGENT_INSTANCE_KEY = "__default__";
const DEFAULT_AGENT_DEFINITION_NAME = "default-agent";
const DEFAULT_AGENT_LABEL = "Ableton Agent";
const DEFAULT_AGENT_DESCRIPTION =
  "Primary Ableton Live production assistant for the current session.";
const DEFAULT_AGENT_PROMPT =
  "Follow the session system message exactly and use the available Ableton tools to help the user.";

type CopilotTurnKind = "user" | "automatic-analysis" | "automatic-action";

interface PendingAutomaticTurn {
  request: SignalTurnRequest;
  deliveryIds: string[];
  waiters: Array<{
    resolve: (response: string) => void;
    reject: (reason: unknown) => void;
  }>;
}

interface ObservedOperation {
  label: string;
  toolName: string;
  arguments: Readonly<Record<string, unknown>>;
}

interface ManagedSessionState {
  readonly key: string;
  configuration: AgentSessionConfiguration;
  readonly exposeInstanceId: boolean;
  signalTargetId: string;
  session: CopilotSessionAdapter | undefined;
  unsubscribe: (() => void) | undefined;
  inFlightTurns: number;
  queuedTurns: number;
  turnQueue: Promise<void>;
  turnKind: CopilotTurnKind | undefined;
  automaticDrainScheduled: boolean;
  readonly pendingAutomatic: Map<string, PendingAutomaticTurn>;
  readonly operations: Map<string, ObservedOperation>;
}

function dedupeStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function stripCustomSourcePrefix(toolName: string): string {
  return toolName.startsWith("custom:") ? toolName.slice(7) : toolName;
}

function bareToolNames(toolNames: readonly string[]): string[] {
  return dedupeStrings(toolNames.map(stripCustomSourcePrefix));
}

function qualifyAvailableTools(toolNames: readonly string[]): string[] {
  return bareToolNames(toolNames).map((toolName) => `custom:${toolName}`);
}

function normalizeSessionConfiguration(
  configuration: AgentSessionConfiguration,
): AgentSessionConfiguration {
  const skills = dedupeStrings(
    configuration.skills.map((skill) => skillNameSchema.parse(skill)),
  );
  const availableSkills =
    configuration.availableSkills === undefined
      ? undefined
      : dedupeStrings(
          configuration.availableSkills.map((skill) =>
            skillNameSchema.parse(skill),
          ),
        );
  if (
    availableSkills !== undefined &&
    skills.some((skill) => !availableSkills.includes(skill))
  ) {
    throw new Error(
      `Configured skills must exist in the loaded skill catalog: ${skills
        .filter((skill) => !availableSkills.includes(skill))
        .join(", ")}`,
    );
  }
  if (skills.length > 0 && configuration.skillDirectories.length === 0) {
    throw new Error("Configured skills require at least one skill directory");
  }
  const hasSessionScope = configuration.editScope.some(
    (entry) => entry === "session",
  );
  if (hasSessionScope) {
    if (
      configuration.editScope.length !== 1 ||
      configuration.boundTracks.length !== 0
    ) {
      throw new AbletonMutationAuthorizationError(
        "binding_stale",
        "Session edit scope cannot include track bindings",
      );
    }
  } else {
    if (configuration.boundTracks.length !== configuration.editScope.length) {
      throw new AbletonMutationAuthorizationError(
        "binding_missing",
        "Every track edit scope selector requires one resolved track binding",
      );
    }
    for (const selector of configuration.editScope) {
      if (selector === "session") continue;
      const matches = configuration.boundTracks.filter(
        (binding) =>
          binding.selector.track.name === selector.track.name &&
          binding.selector.track.occurrence === selector.track.occurrence,
      );
      if (matches.length === 0) {
        throw new AbletonMutationAuthorizationError(
          "binding_missing",
          `Track selector '${selector.track.name}' occurrence ${selector.track.occurrence} has no resolved binding`,
        );
      }
      if (matches.length > 1) {
        throw new AbletonMutationAuthorizationError(
          "binding_ambiguous",
          `Track selector '${selector.track.name}' occurrence ${selector.track.occurrence} has multiple resolved bindings`,
        );
      }
    }
  }
  return {
    instanceId: configuration.instanceId,
    definitionName: configuration.definitionName,
    label: configuration.label,
    description: configuration.description,
    systemPrompt: configuration.systemPrompt,
    resolvedTools: bareToolNames(configuration.resolvedTools),
    editScope: configuration.editScope.map((entry) =>
      entry === "session"
        ? entry
        : {
            track: {
              name: entry.track.name,
              occurrence: entry.track.occurrence,
            },
          },
    ),
    boundTracks: configuration.boundTracks.map((binding) => ({
      selector: {
        track: {
          name: binding.selector.track.name,
          occurrence: binding.selector.track.occurrence,
        },
      },
      projectId: binding.projectId,
      trackReference: binding.trackReference,
      trackIndex: binding.trackIndex,
      expectedName: binding.expectedName,
    })),
    skills,
    skillDirectories: dedupeStrings(configuration.skillDirectories),
    ...(availableSkills === undefined ? {} : { availableSkills }),
  };
}

function normalizeHistoryEvent(
  event: SessionEvent,
  attribution: {
    agentInstanceId?: string;
    sdkSessionId?: string;
  },
): AgentHistoryMessage | undefined {
  if (event.type === "user.message") {
    return {
      role: "user",
      content: event.data.content,
      timestamp: event.timestamp,
      eventId: event.id,
      ...attribution,
    };
  }
  if (event.type === "assistant.message") {
    return {
      role: "assistant",
      content: event.data.content,
      timestamp: event.timestamp,
      eventId: event.id,
      messageId: event.data.messageId,
      ...attribution,
    };
  }
  return undefined;
}

export class CopilotAgentService implements AgentService {
  readonly #clientFactory: () => CopilotClientAdapter;
  readonly #logger: Logger;
  #client: CopilotClientAdapter | undefined;
  #toolSet: ReturnType<typeof createAbletonTools> | undefined;
  readonly #mutationAuthorizer =
    createAbletonMutationAuthorizer(abletonToolMetadata);
  readonly #mutationLockManager = createAbletonMutationLockManager();
  readonly #states = new Map<string, ManagedSessionState>();
  readonly #lifecycleTails = new Map<string, Promise<void>>();

  public constructor(private readonly options: CopilotAgentServiceOptions) {
    this.#logger = options.logger ?? noopLogger;
    this.#clientFactory =
      options.clientFactory ??
      (() =>
        new CopilotClient({
          mode: "empty",
          baseDirectory:
            options.baseDirectory ??
            join(homedir(), ".ableton-agent", "copilot"),
        }));
  }

  public get sessionId(): string | undefined {
    return this.#sdkSessionId(DEFAULT_AGENT_INSTANCE_KEY);
  }

  public getManagedAgentSessionId(instanceId: string): string | undefined {
    return this.#sdkSessionId(instanceId);
  }

  #sdkSessionId(key: string): string | undefined {
    return this.#states.get(key)?.session?.sessionId;
  }

  #serializeLifecycle<T>(
    instanceId: string,
    run: () => Promise<T>,
  ): Promise<T> {
    const previous = this.#lifecycleTails.get(instanceId) ?? Promise.resolve();
    const result = previous.then(run, run);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.#lifecycleTails.set(instanceId, tail);
    void tail.finally(() => {
      if (this.#lifecycleTails.get(instanceId) === tail) {
        this.#lifecycleTails.delete(instanceId);
      }
    });
    return result;
  }

  #abletonToolSet(): ReturnType<typeof createAbletonTools> {
    this.#toolSet ??= createAbletonTools({
      getConnectionStatus: this.options.getAbletonStatus,
      inspectSession: this.options.inspectSession,
      setTempo: this.options.setTempo,
      setPlaying: this.options.setPlaying,
      inspectArrangementTransport: this.options.inspectArrangementTransport,
      setArrangementLoop: this.options.setArrangementLoop,
      createCuePoint: this.options.createCuePoint,
      deleteCuePoint: this.options.deleteCuePoint,
      createTrack: this.options.createTrack,
      deleteTrack: this.options.deleteTrack,
      renameTrack: this.options.renameTrack,
      setTrackMixer: this.options.setTrackMixer,
      inspectDevices: this.options.inspectDevices,
      inspectBrowserRoots: this.options.inspectBrowserRoots,
      inspectBrowserChildren: this.options.inspectBrowserChildren,
      searchBrowser: this.options.searchBrowser,
      loadBrowserItem: this.options.loadBrowserItem,
      inspectDeviceParameters: this.options.inspectDeviceParameters,
      inspectRackChains: this.options.inspectRackChains,
      inspectRackChainDevices: this.options.inspectRackChainDevices,
      inspectDrumRackPads: this.options.inspectDrumRackPads,
      inspectDrumPadChains: this.options.inspectDrumPadChains,
      inspectDrumPadChainDevices: this.options.inspectDrumPadChainDevices,
      setDeviceEnabled: this.options.setDeviceEnabled,
      setDeviceParameter: this.options.setDeviceParameter,
      createMidiClip: this.options.createMidiClip,
      replaceMidiNotes: this.options.replaceMidiNotes,
      launchSessionClip: this.options.launchSessionClip,
      duplicateSessionClip: this.options.duplicateSessionClip,
      deleteSessionClip: this.options.deleteSessionClip,
      setSessionClipProperties: this.options.setSessionClipProperties,
      createArrangementMidiClip: this.options.createArrangementMidiClip,
      inspectArrangement: this.options.inspectArrangement,
      deleteArrangementClip: this.options.deleteArrangementClip,
      replaceArrangementMidiNotes: this.options.replaceArrangementMidiNotes,
      duplicateClipToArrangement: this.options.duplicateClipToArrangement,
      setArrangementClipProperties: this.options.setArrangementClipProperties,
    });
    return this.#toolSet;
  }

  async #mutationContext(
    state: ManagedSessionState,
  ): Promise<AbletonMutationAuthorizationContext> {
    const configuration = state.configuration;
    if (configuration.editScope.includes("session")) {
      return {
        activeAgentConfig: configuration,
        editScopeBindings: [],
      };
    }

    const status = await this.options.getAbletonStatus();
    if (status.state !== "connected") {
      throw new AbletonMutationAuthorizationError(
        "binding_stale",
        "Track edit scope cannot be validated while Ableton is disconnected",
      );
    }
    const snapshot = await this.options.inspectSession();
    for (const binding of configuration.boundTracks) {
      if (binding.projectId !== status.projectId) {
        throw new AbletonMutationAuthorizationError(
          "binding_cross_project",
          `Track binding '${binding.expectedName}' belongs to project ${binding.projectId}, not ${status.projectId}`,
        );
      }
      const indexedTrack = snapshot.tracks[binding.trackIndex];
      if (
        indexedTrack === undefined ||
        indexedTrack.reference !== binding.trackReference ||
        indexedTrack.name !== binding.expectedName
      ) {
        throw new AbletonMutationAuthorizationError(
          "binding_stale",
          `Track binding '${binding.expectedName}' no longer matches index ${binding.trackIndex} and reference ${binding.trackReference}`,
        );
      }
      const matchingTracks = snapshot.tracks.filter(
        (track) => track.name === binding.selector.track.name,
      );
      const selectedTrack = matchingTracks[binding.selector.track.occurrence];
      if (selectedTrack === undefined) {
        throw new AbletonMutationAuthorizationError(
          "binding_missing",
          `Track selector '${binding.selector.track.name}' occurrence ${binding.selector.track.occurrence} no longer resolves`,
        );
      }
      if (selectedTrack.reference !== binding.trackReference) {
        throw new AbletonMutationAuthorizationError(
          "binding_stale",
          `Track selector '${binding.selector.track.name}' occurrence ${binding.selector.track.occurrence} resolves to a different track`,
        );
      }
    }
    return {
      activeAgentConfig: configuration,
      editScopeBindings: configuration.boundTracks,
    };
  }

  #scopedAbletonTools(state: ManagedSessionState): Tool[] {
    const tools = this.#abletonToolSet().tools as unknown as Tool[];
    return tools.map((tool): Tool => {
      const mutationTarget = this.#mutationAuthorizer.resolveMutationTarget(
        tool.name,
      );
      if (mutationTarget === undefined) {
        throw new AbletonMutationAuthorizationError(
          "unknown_tool",
          `Ableton tool ${tool.name} has no mutation classification`,
        );
      }
      if (mutationTarget === "read" || tool.handler === undefined) return tool;
      const handler = tool.handler;
      return {
        ...tool,
        handler: async (args: unknown, invocation: ToolInvocation) =>
          runAuthorizedAbletonMutation({
            authorizer: this.#mutationAuthorizer,
            lockManager: this.#mutationLockManager,
            getContext: () => this.#mutationContext(state),
            invocation: { toolName: tool.name, args },
            handler: () => Promise.resolve(handler(args, invocation)),
          }),
      };
    });
  }

  #defaultSessionConfiguration(): AgentSessionConfiguration {
    return {
      instanceId: DEFAULT_AGENT_INSTANCE_KEY,
      definitionName: DEFAULT_AGENT_DEFINITION_NAME,
      label: DEFAULT_AGENT_LABEL,
      description: DEFAULT_AGENT_DESCRIPTION,
      systemPrompt: DEFAULT_AGENT_PROMPT,
      resolvedTools: abletonToolMetadata.map(({ name }) => name),
      editScope: ["session"],
      boundTracks: [],
      skills: [],
      skillDirectories: [],
    };
  }

  #assertExternalInstanceId(instanceId: string): void {
    if (instanceId === DEFAULT_AGENT_INSTANCE_KEY) {
      throw new Error("Managed agent instance id is reserved");
    }
  }

  #createState(
    key: string,
    configuration: AgentSessionConfiguration,
    exposeInstanceId: boolean,
  ): ManagedSessionState {
    return {
      key,
      configuration,
      exposeInstanceId,
      signalTargetId: exposeInstanceId ? configuration.instanceId : key,
      session: undefined,
      unsubscribe: undefined,
      inFlightTurns: 0,
      queuedTurns: 0,
      turnQueue: Promise.resolve(),
      turnKind: undefined,
      automaticDrainScheduled: false,
      pendingAutomatic: new Map(),
      operations: new Map(),
    };
  }

  #requireClient(): CopilotClientAdapter {
    if (this.#client === undefined) {
      throw new Error("Copilot agent service is not started");
    }
    return this.#client;
  }

  #requireDefaultState(): ManagedSessionState {
    const state = this.#states.get(DEFAULT_AGENT_INSTANCE_KEY);
    if (state?.session === undefined) {
      throw new Error("Copilot agent service is not started");
    }
    return state;
  }

  #requireManagedState(instanceId: string): ManagedSessionState {
    const state = this.#states.get(instanceId);
    if (state?.session === undefined) {
      throw new Error(`Managed agent '${instanceId}' is not active`);
    }
    return state;
  }

  #findStateBySignalTargetId(
    signalTargetId: string,
  ): ManagedSessionState | undefined {
    return [...this.#states.values()].find(
      (state) => state.signalTargetId === signalTargetId,
    );
  }

  #eventAttribution(state: ManagedSessionState): {
    agentInstanceId?: string;
    sdkSessionId?: string;
  } {
    return {
      ...(state.exposeInstanceId
        ? { agentInstanceId: state.configuration.instanceId }
        : {}),
      ...(state.session?.sessionId === undefined
        ? {}
        : { sdkSessionId: state.session.sessionId }),
    };
  }

  #scopedSignalContext(
    state: ManagedSessionState,
  ): SignalContextOptions | undefined {
    const signalContext = this.options.signalContext;
    if (signalContext?.provider === undefined) return signalContext;
    return {
      ...signalContext,
      provider: {
        getPendingContexts: async () =>
          signalContext.provider!.getPendingContexts(state.signalTargetId),
        markDelivered: async (...[, deliveryIds]) =>
          signalContext.provider!.markDelivered(
            state.signalTargetId,
            deliveryIds,
          ),
      },
    };
  }

  #knownSkillNames(): Set<string> {
    const names = new Set<string>();
    for (const state of this.#states.values()) {
      for (const skill of state.configuration.skills) names.add(skill);
      for (const skill of state.configuration.availableSkills ?? []) {
        names.add(skill);
      }
    }
    return names;
  }

  #prepareSkillInvocation(
    state: ManagedSessionState,
    input: string | SkillInvocation,
  ): string {
    const invocation =
      typeof input === "string" ? parseSkillInvocation(input) : input;
    if (invocation === undefined) {
      throw new Error(
        "Skill invocation must use /skill-name followed by an optional request.",
      );
    }
    const skillName = skillNameSchema.parse(invocation.skillName);
    if (!state.configuration.skills.includes(skillName)) {
      if (this.#knownSkillNames().has(skillName)) {
        throw new Error(
          `Skill '/${skillName}' is not assigned to managed agent '${state.configuration.instanceId}'.`,
        );
      }
      throw new Error(`Unknown skill '/${skillName}'.`);
    }
    return formatSkillInvocation({
      skillName,
      request: invocation.request,
    });
  }

  #sessionConfig(state: ManagedSessionState): SessionConfig {
    const tools = this.#scopedAbletonTools(state);
    const scopedSignalContext = this.#scopedSignalContext(state);
    const agentPolicy = createAgentPolicy({
      getAbletonStatus: this.options.getAbletonStatus,
      inspectSession: this.options.inspectSession,
      ...(scopedSignalContext === undefined
        ? {}
        : { signalContext: scopedSignalContext }),
      promptContextEnabled: () => state.turnKind === "user",
      mutationBlocked: () => state.turnKind === "automatic-analysis",
    });
    const requestToolApproval =
      this.options.requestToolApproval === undefined
        ? undefined
        : (request: Parameters<ToolApprovalRequester>[0]) =>
            this.options.requestToolApproval!({
              ...request,
              ...(state.exposeInstanceId
                ? { agentInstanceId: state.configuration.instanceId }
                : {}),
              ...(state.session?.sessionId === undefined
                ? {}
                : { sdkSessionId: state.session.sessionId }),
            });
    const permissionHandler = createAbletonPermissionHandler(
      requestToolApproval,
      this.options.askForReadApproval,
    );
    return {
      clientName: "ableton-agent-app",
      ...(this.options.model === undefined
        ? {}
        : { model: this.options.model }),
      ...(this.options.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: this.options.reasoningEffort }),
      tools,
      availableTools: qualifyAvailableTools(state.configuration.resolvedTools),
      customAgents: [
        {
          name: state.configuration.definitionName,
          displayName: state.configuration.label,
          description: state.configuration.description,
          prompt: state.configuration.systemPrompt,
          tools: bareToolNames(state.configuration.resolvedTools),
          infer: false,
          skills: [...state.configuration.skills],
        },
      ],
      agent: state.configuration.definitionName,
      skillDirectories: [...state.configuration.skillDirectories],
      onPermissionRequest: async (request, invocation) => {
        const result = await permissionHandler(request, invocation);
        if (result.kind === "reject" && request.kind === "custom-tool") {
          agentPolicy.blockAttempt(
            request.toolName,
            request.args ?? {},
            "Do not retry or rephrase this denied operation. Wait for a new user request.",
          );
        }
        return result;
      },
      hooks: agentPolicy.hooks,
      systemMessage: {
        mode: "replace",
        content: BASE_SYSTEM_MESSAGE,
      },
    };
  }

  #observe(state: ManagedSessionState, session: CopilotSessionAdapter): void {
    state.unsubscribe?.();
    state.unsubscribe = session.on((event) => {
      if (this.#states.get(state.key) !== state) return;
      if (event.type === "assistant.message_delta") {
        this.options.events.publish({
          type: "agent.message_delta",
          content: event.data.deltaContent,
          ...this.#eventAttribution(state),
        });
      } else if (event.type === "tool.execution_start") {
        const metadata = abletonToolMetadata.find(
          (candidate) => candidate.name === event.data.toolName,
        );
        const label = metadata?.title ?? event.data.toolName;
        state.operations.set(event.data.toolCallId, {
          label,
          toolName: event.data.toolName,
          arguments: event.data.arguments ?? {},
        });
        this.#logger.debug("Agent tool started", {
          sessionId: session.sessionId,
          ...(state.exposeInstanceId
            ? { instanceId: state.configuration.instanceId }
            : {}),
          operationId: event.data.toolCallId,
          toolName: event.data.toolName,
          arguments: event.data.arguments ?? {},
        });
        this.options.events.publish({
          type: "operation.started",
          operationId: event.data.toolCallId,
          label,
          toolName: event.data.toolName,
          arguments: event.data.arguments ?? {},
          ...this.#eventAttribution(state),
        });
      } else if (event.type === "tool.execution_complete") {
        const operation = state.operations.get(event.data.toolCallId);
        const label = operation?.label ?? "Tool operation";
        state.operations.delete(event.data.toolCallId);
        if (event.data.success) {
          this.#logger.debug("Agent tool completed", {
            sessionId: session.sessionId,
            ...(state.exposeInstanceId
              ? { instanceId: state.configuration.instanceId }
              : {}),
            operationId: event.data.toolCallId,
            toolName: operation?.toolName,
            result: event.data.result?.content,
          });
          this.options.events.publish({
            type: "operation.completed",
            operationId: event.data.toolCallId,
            summary: `${label} completed`,
            ...(operation === undefined
              ? {}
              : { toolName: operation.toolName }),
            ...(event.data.result?.content === undefined
              ? {}
              : { result: event.data.result.content }),
            ...this.#eventAttribution(state),
          });
        } else {
          this.#logger.warn("Agent tool failed", {
            sessionId: session.sessionId,
            ...(state.exposeInstanceId
              ? { instanceId: state.configuration.instanceId }
              : {}),
            operationId: event.data.toolCallId,
            toolName: operation?.toolName,
            error: event.data.error,
          });
          this.options.events.publish({
            type: "operation.failed",
            operationId: event.data.toolCallId,
            code: event.data.error?.code ?? "tool_failed",
            message: event.data.error?.message ?? `${label} failed`,
            ...(operation === undefined
              ? {}
              : { toolName: operation.toolName }),
            ...this.#eventAttribution(state),
          });
        }
      }
    });
  }

  #rejectPendingAutomatic(state: ManagedSessionState, error: unknown): void {
    for (const item of state.pendingAutomatic.values()) {
      for (const waiter of item.waiters) waiter.reject(error);
    }
    state.pendingAutomatic.clear();
    state.automaticDrainScheduled = false;
  }

  async #disconnectState(
    state: ManagedSessionState,
    options: { removeFromRegistry?: boolean; reason?: unknown } = {},
  ): Promise<void> {
    state.unsubscribe?.();
    state.unsubscribe = undefined;
    state.turnKind = undefined;
    state.inFlightTurns = 0;
    state.queuedTurns = 0;
    state.operations.clear();
    this.#rejectPendingAutomatic(
      state,
      options.reason ?? new Error("Copilot session disconnected"),
    );
    const session = state.session;
    state.session = undefined;
    if (
      options.removeFromRegistry !== false &&
      this.#states.get(state.key) === state
    ) {
      this.#states.delete(state.key);
    }
    if (session !== undefined) {
      await session.disconnect();
    }
  }

  async #connectCreatedState(
    state: ManagedSessionState,
  ): Promise<CopilotSessionAdapter> {
    const session = await this.#requireClient().createSession(
      this.#sessionConfig(state),
    );
    state.session = session;
    if (!state.exposeInstanceId) state.signalTargetId = session.sessionId;
    try {
      this.#observe(state, session);
    } catch (error) {
      state.session = undefined;
      try {
        await session.disconnect();
      } catch (disconnectError) {
        throw new AggregateError(
          [error, disconnectError],
          "Copilot session event hookup failed and the replacement session could not be cleaned up",
        );
      }
      throw error;
    }
    return session;
  }

  async #connectResumedState(
    state: ManagedSessionState,
    sdkSessionId: string,
  ): Promise<CopilotSessionAdapter> {
    const session = await this.#requireClient().resumeSession(
      sdkSessionId,
      this.#sessionConfig(state),
    );
    state.session = session;
    if (!state.exposeInstanceId) state.signalTargetId = session.sessionId;
    try {
      this.#observe(state, session);
    } catch (error) {
      state.session = undefined;
      try {
        await session.disconnect();
      } catch (disconnectError) {
        throw new AggregateError(
          [error, disconnectError],
          "Copilot session event hookup failed and the replacement session could not be cleaned up",
        );
      }
      throw error;
    }
    return session;
  }

  async #commitReplacement(
    previous: ManagedSessionState | undefined,
    replacement: ManagedSessionState,
    reason: Error,
  ): Promise<void> {
    if (previous === undefined) {
      this.#states.set(replacement.key, replacement);
      return;
    }

    const previousSession = previous.session;
    previous.unsubscribe?.();
    previous.unsubscribe = undefined;
    try {
      await previousSession?.disconnect();
    } catch (error) {
      const rollbackFailures: unknown[] = [error];
      try {
        if (previousSession !== undefined) {
          this.#observe(previous, previousSession);
        }
      } catch (hookupError) {
        rollbackFailures.push(hookupError);
      }
      try {
        await this.#disconnectState(replacement, {
          removeFromRegistry: false,
          reason: new Error("Managed agent replacement was rolled back"),
        });
      } catch (cleanupError) {
        rollbackFailures.push(cleanupError);
      }
      if (rollbackFailures.length > 1) {
        throw new AggregateError(
          rollbackFailures,
          "Managed agent replacement failed and rollback was incomplete",
        );
      }
      throw error;
    }

    previous.session = undefined;
    previous.turnKind = undefined;
    previous.inFlightTurns = 0;
    previous.queuedTurns = 0;
    previous.operations.clear();
    this.#rejectPendingAutomatic(previous, reason);
    this.#states.set(replacement.key, replacement);
  }

  #assertIdle(state: ManagedSessionState, action: string): void {
    if (state.queuedTurns > 0 || state.pendingAutomatic.size > 0) {
      const identity = state.exposeInstanceId
        ? `managed agent '${state.configuration.instanceId}'`
        : "default Copilot session";
      throw new Error(`Cannot ${action} while the ${identity} is busy`);
    }
  }

  async #abortTimedOutTurn(
    state: ManagedSessionState,
    session: CopilotSessionAdapter,
    timeoutMs: number,
  ): Promise<never> {
    state.unsubscribe?.();
    state.unsubscribe = undefined;
    for (const [operationId, operation] of state.operations) {
      this.options.events.publish({
        type: "operation.failed",
        operationId,
        code: "operation_timeout",
        message: `${operation.label} cancelled because the Copilot turn timed out`,
        toolName: operation.toolName,
        ...this.#eventAttribution(state),
      });
    }
    state.operations.clear();

    let abortError: unknown;
    try {
      await session.abort();
    } catch (error) {
      abortError = error;
    }
    if (abortError === undefined && state.session === session) {
      this.#observe(state, session);
    } else if (abortError !== undefined && state.session === session) {
      this.#rejectPendingAutomatic(
        state,
        new Error("Copilot session became unavailable after timing out"),
      );
      state.session = undefined;
      if (this.#states.get(state.key) === state) {
        this.#states.delete(state.key);
      }
      try {
        await session.disconnect();
      } catch (disconnectError) {
        abortError = new AggregateError(
          [abortError, disconnectError],
          "Timed-out Copilot session could not be aborted or disconnected",
        );
      }
    }
    throw new AgentTurnTimeoutError(timeoutMs, abortError);
  }

  public async start(preferredSessionId?: string): Promise<void> {
    if (this.#client !== undefined) {
      return;
    }

    const client = this.#clientFactory();
    this.#client = client;
    try {
      const state = this.#createState(
        DEFAULT_AGENT_INSTANCE_KEY,
        this.#defaultSessionConfiguration(),
        false,
      );
      let session: CopilotSessionAdapter;
      if (preferredSessionId === undefined) {
        session = await this.#connectCreatedState(state);
      } else {
        try {
          session = await this.#connectResumedState(state, preferredSessionId);
        } catch {
          session = await this.#connectCreatedState(state);
        }
      }
      this.#states.set(DEFAULT_AGENT_INSTANCE_KEY, state);
      this.#logger.info("Agent session started", {
        sessionId: session.sessionId,
        preferredSessionId,
      });
    } catch (error) {
      this.#client = undefined;
      this.#states.clear();
      await client.stop();
      throw error;
    }
  }

  public async createSession(): Promise<string> {
    const previous = this.#states.get(DEFAULT_AGENT_INSTANCE_KEY);
    if (previous !== undefined) {
      this.#assertIdle(previous, "create a new default Copilot session");
    }
    const state = this.#createState(
      DEFAULT_AGENT_INSTANCE_KEY,
      this.#defaultSessionConfiguration(),
      false,
    );
    const session = await this.#connectCreatedState(state);
    this.#states.set(DEFAULT_AGENT_INSTANCE_KEY, state);
    if (previous !== undefined) {
      await this.#disconnectState(previous, {
        removeFromRegistry: false,
        reason: new Error("Default Copilot session was replaced"),
      });
    }
    this.#logger.info("Agent session created", {
      sessionId: session.sessionId,
    });
    return session.sessionId;
  }

  public async resumeSession(sessionId: string): Promise<void> {
    const previous = this.#states.get(DEFAULT_AGENT_INSTANCE_KEY);
    if (previous?.session?.sessionId === sessionId) {
      return;
    }
    if (previous !== undefined) {
      this.#assertIdle(previous, "resume the default Copilot session");
    }
    const state = this.#createState(
      DEFAULT_AGENT_INSTANCE_KEY,
      this.#defaultSessionConfiguration(),
      false,
    );
    await this.#connectResumedState(state, sessionId);
    this.#states.set(DEFAULT_AGENT_INSTANCE_KEY, state);
    if (previous !== undefined) {
      await this.#disconnectState(previous, {
        removeFromRegistry: false,
        reason: new Error("Default Copilot session was replaced"),
      });
    }
    this.#logger.info("Agent session resumed", { sessionId });
  }

  public async createManagedAgent(
    configuration: AgentSessionConfiguration,
  ): Promise<string> {
    this.#assertExternalInstanceId(configuration.instanceId);
    return this.#serializeLifecycle(configuration.instanceId, async () => {
      const normalized = normalizeSessionConfiguration(configuration);
      const previous = this.#states.get(normalized.instanceId);
      if (previous !== undefined) {
        this.#assertIdle(previous, "create a managed Copilot session");
      }
      const state = this.#createState(normalized.instanceId, normalized, true);
      const session = await this.#connectCreatedState(state);
      await this.#commitReplacement(
        previous,
        state,
        new Error(`Managed agent '${normalized.instanceId}' was replaced`),
      );
      this.#logger.info("Managed agent session created", {
        instanceId: normalized.instanceId,
        sessionId: session.sessionId,
        definitionName: normalized.definitionName,
      });
      return session.sessionId;
    });
  }

  public async resumeManagedAgent(
    configuration: AgentSessionConfiguration,
    sdkSessionId: string,
  ): Promise<void> {
    this.#assertExternalInstanceId(configuration.instanceId);
    await this.#serializeLifecycle(configuration.instanceId, async () => {
      const normalized = normalizeSessionConfiguration(configuration);
      const previous = this.#states.get(normalized.instanceId);
      if (previous?.session?.sessionId === sdkSessionId) {
        return;
      }
      if (previous !== undefined) {
        this.#assertIdle(previous, "resume a managed Copilot session");
      }
      const state = this.#createState(normalized.instanceId, normalized, true);
      await this.#connectResumedState(state, sdkSessionId);
      await this.#commitReplacement(
        previous,
        state,
        new Error(`Managed agent '${normalized.instanceId}' was replaced`),
      );
      this.#logger.info("Managed agent session resumed", {
        instanceId: normalized.instanceId,
        sessionId: sdkSessionId,
        definitionName: normalized.definitionName,
      });
    });
  }

  public async reconfigureManagedAgent(
    configuration: AgentSessionConfiguration,
  ): Promise<void> {
    this.#assertExternalInstanceId(configuration.instanceId);
    await this.#serializeLifecycle(configuration.instanceId, async () => {
      const normalized = normalizeSessionConfiguration(configuration);
      const previous = this.#requireManagedState(normalized.instanceId);
      this.#assertIdle(previous, "reconfigure a managed Copilot session");
      const sdkSessionId = previous.session?.sessionId;
      if (sdkSessionId === undefined) {
        throw new Error(
          `Managed agent '${normalized.instanceId}' is not active`,
        );
      }
      const state = this.#createState(normalized.instanceId, normalized, true);
      await this.#connectResumedState(state, sdkSessionId);
      await this.#commitReplacement(
        previous,
        state,
        new Error(`Managed agent '${normalized.instanceId}' was reconfigured`),
      );
      this.#logger.info("Managed agent session reconfigured", {
        instanceId: normalized.instanceId,
        sessionId: sdkSessionId,
        definitionName: normalized.definitionName,
      });
    });
  }

  public async deactivateManagedAgent(instanceId: string): Promise<void> {
    this.#assertExternalInstanceId(instanceId);
    await this.#serializeLifecycle(instanceId, async () => {
      const state = this.#states.get(instanceId);
      if (state === undefined) {
        return;
      }
      this.#assertIdle(state, "deactivate a managed Copilot session");
      await this.#disconnectState(state);
      this.#logger.info("Managed agent session deactivated", {
        instanceId,
      });
    });
  }

  public async cancel(): Promise<boolean> {
    const state = this.#states.get(DEFAULT_AGENT_INSTANCE_KEY);
    const session = state?.session;
    if (!session || !state || state.inFlightTurns === 0) {
      return false;
    }
    await session.abort();
    return true;
  }

  public async cancelManagedAgent(instanceId: string): Promise<boolean> {
    const state = this.#states.get(instanceId);
    const session = state?.session;
    if (!state || !session || state.inFlightTurns === 0) {
      return false;
    }
    await session.abort();
    return true;
  }

  public async stop(): Promise<void> {
    const client = this.#client;
    this.#client = undefined;
    await Promise.all([...this.#lifecycleTails.values()]);
    const states = [...this.#states.values()];
    this.#states.clear();
    const failures: unknown[] = [];
    for (const state of states) {
      try {
        await this.#disconnectState(state, {
          removeFromRegistry: false,
          reason: new Error("Copilot agent service stopped"),
        });
      } catch (error) {
        failures.push(error);
      }
    }
    if (client !== undefined) {
      try {
        await client.stop();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "Copilot agent service shutdown failed",
      );
    }
  }

  async #sendNow(
    state: ManagedSessionState,
    prompt: string,
    kind: CopilotTurnKind,
  ): Promise<string> {
    const session = state.session;
    if (!session) {
      throw new Error(
        state.exposeInstanceId
          ? `Managed agent '${state.configuration.instanceId}' is not active`
          : "Copilot agent service is not started",
      );
    }
    const timeoutMs =
      this.options.turnTimeoutMs ?? DEFAULT_AGENT_TURN_TIMEOUT_MS;
    const startedAt = Date.now();
    this.#logger.debug("Agent turn started", {
      sessionId: session.sessionId,
      ...(state.exposeInstanceId
        ? { instanceId: state.configuration.instanceId }
        : {}),
      kind,
      prompt,
      timeoutMs,
    });
    state.inFlightTurns += 1;
    state.turnKind = kind;
    let response: CopilotResponse | undefined;
    try {
      response = await session.sendAndWait(prompt, timeoutMs);
    } catch (error) {
      this.#logger.error("Agent turn failed", {
        sessionId: session.sessionId,
        ...(state.exposeInstanceId
          ? { instanceId: state.configuration.instanceId }
          : {}),
        kind,
        prompt,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      if (isSessionIdleTimeout(error)) {
        return await this.#abortTimedOutTurn(state, session, timeoutMs);
      }
      throw error;
    } finally {
      state.inFlightTurns -= 1;
      state.turnKind = undefined;
    }
    if (!response) {
      throw new Error(
        "Copilot session completed without an assistant response",
      );
    }
    this.options.events.publish({
      type: "agent.message_complete",
      content: response.data.content,
      ...this.#eventAttribution(state),
    });
    this.#logger.debug("Agent turn completed", {
      sessionId: session.sessionId,
      ...(state.exposeInstanceId
        ? { instanceId: state.configuration.instanceId }
        : {}),
      kind,
      prompt,
      response: response.data.content,
      durationMs: Date.now() - startedAt,
    });
    return response.data.content;
  }

  #serialize<T>(state: ManagedSessionState, run: () => Promise<T>): Promise<T> {
    state.queuedTurns += 1;
    const wrapped = async (): Promise<T> => {
      try {
        return await run();
      } finally {
        state.queuedTurns -= 1;
      }
    };
    const result = state.turnQueue.then(wrapped, wrapped);
    state.turnQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  public send(prompt: string): Promise<string> {
    const state = this.#requireDefaultState();
    return this.#serialize(state, () => this.#sendNow(state, prompt, "user"));
  }

  public sendToManagedAgent(
    instanceId: string,
    prompt: string,
  ): Promise<string> {
    const state = this.#requireManagedState(instanceId);
    let turnPrompt: string;
    try {
      const invocation = parseSkillInvocation(prompt);
      turnPrompt =
        invocation === undefined
          ? prompt
          : this.#prepareSkillInvocation(state, invocation);
    } catch (error) {
      return Promise.reject(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
    return this.#serialize(state, () =>
      this.#sendNow(state, turnPrompt, "user"),
    );
  }

  public invokeManagedAgentSkill(
    instanceId: string,
    invocation: string | SkillInvocation,
  ): Promise<string> {
    const state = this.#requireManagedState(instanceId);
    let prompt: string;
    try {
      prompt = this.#prepareSkillInvocation(state, invocation);
    } catch (error) {
      return Promise.reject(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
    return this.#serialize(state, () => this.#sendNow(state, prompt, "user"));
  }

  public async getManagedAgentHistory(
    instanceId: string,
  ): Promise<readonly AgentHistoryMessage[]> {
    const state = this.#requireManagedState(instanceId);
    const events = await state.session?.getEvents?.();
    if (events === undefined) {
      return [];
    }
    const attribution = this.#eventAttribution(state);
    return events
      .map((event) => normalizeHistoryEvent(event, attribution))
      .filter((event): event is AgentHistoryMessage => event !== undefined);
  }

  public enqueueSignalTurn(request: SignalTurnRequest): Promise<string> {
    const state = this.#findStateBySignalTargetId(request.context.consumer.id);
    if (state?.session === undefined) {
      return Promise.reject(
        new Error(
          `No active Copilot session for signal consumer '${request.context.consumer.id}'`,
        ),
      );
    }
    const key = request.context.assignmentId;
    return new Promise<string>((resolve, reject) => {
      const pending = state.pendingAutomatic.get(key);
      if (pending === undefined) {
        state.pendingAutomatic.set(key, {
          request,
          deliveryIds: [request.deliveryId],
          waiters: [{ resolve, reject }],
        });
      } else {
        if (request.context.sequence >= pending.request.context.sequence) {
          pending.request = request;
        }
        pending.deliveryIds.push(request.deliveryId);
        pending.waiters.push({ resolve, reject });
      }
      if (!state.automaticDrainScheduled) {
        state.automaticDrainScheduled = true;
        void this.#serialize(state, async () => {
          try {
            while (state.pendingAutomatic.size > 0) {
              const next = state.pendingAutomatic.entries().next().value;
              if (next === undefined) break;
              const [pendingKey, item] = next;
              state.pendingAutomatic.delete(pendingKey);
              try {
                if (state.session?.sessionId === undefined) {
                  throw new Error(
                    `Managed signal target '${state.signalTargetId}' is not active`,
                  );
                }
                const response = await this.#sendNow(
                  state,
                  formatAutomaticSignalPrompt(
                    item.request,
                    this.options.signalContext,
                  ),
                  item.request.context.deliveryMode,
                );
                await this.options.signalContext?.provider?.markDelivered(
                  state.signalTargetId,
                  item.deliveryIds,
                );
                for (const waiter of item.waiters) waiter.resolve(response);
              } catch (error) {
                for (const waiter of item.waiters) waiter.reject(error);
              }
            }
          } finally {
            state.automaticDrainScheduled = false;
          }
        });
      }
    });
  }
}

export class HeadlessApplication {
  #state: LifecycleState = "stopped";

  public constructor(private readonly services: ApplicationServices) {}

  #requireManagedAgentMethod<
    K extends
      | "createManagedAgent"
      | "resumeManagedAgent"
      | "reconfigureManagedAgent"
      | "deactivateManagedAgent"
      | "sendToManagedAgent"
      | "invokeManagedAgentSkill"
      | "cancelManagedAgent"
      | "getManagedAgentSessionId"
      | "getManagedAgentHistory",
  >(name: K): NonNullable<AgentService[K]> {
    const method = this.services.agent[name];
    if (method === undefined) {
      throw new Error("Configured agent does not support managed agents");
    }
    return method.bind(this.services.agent) as NonNullable<AgentService[K]>;
  }

  public get state(): LifecycleState {
    return this.#state;
  }

  public async start(options: ApplicationStartOptions = {}): Promise<void> {
    if (this.#state !== "stopped") {
      throw new Error(`Cannot start application from ${this.#state}`);
    }
    this.#setState("starting");
    try {
      await this.services.ableton.start();
      if (options.startAgent ?? true) {
        await this.services.agent.start(options.preferredAgentSessionId);
      }
      const status = await this.services.ableton.getStatus();
      this.services.events.publish({
        type: "ableton.connection_changed",
        status,
      });
      this.#setState(status.state === "connected" ? "ready" : "degraded");
    } catch (error) {
      this.#setState("degraded");
      this.services.logger.error("Application startup failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  public async stop(): Promise<void> {
    if (this.#state === "stopped") {
      return;
    }
    this.#setState("stopping");
    const failures: unknown[] = [];
    for (const stop of [
      () => this.services.agent.stop(),
      () => this.services.ableton.stop(),
    ]) {
      try {
        await stop();
      } catch (error) {
        failures.push(error);
      }
    }
    this.#setState("stopped");
    if (failures.length > 0) {
      throw new AggregateError(failures, "Application shutdown failed");
    }
  }

  public async send(prompt: string): Promise<string> {
    if (this.#state !== "ready" && this.#state !== "degraded") {
      throw new Error(`Application is not running (${this.#state})`);
    }
    return this.services.agent.send(prompt);
  }

  public enqueueSignalTurn(request: SignalTurnRequest): Promise<string> {
    if (this.#state !== "ready" && this.#state !== "degraded") {
      return Promise.reject(
        new Error(`Application is not running (${this.#state})`),
      );
    }
    if (this.services.agent.enqueueSignalTurn === undefined) {
      return Promise.reject(
        new Error("Configured agent does not support signal delivery"),
      );
    }
    return this.services.agent.enqueueSignalTurn(request);
  }

  /**
   * Aborts an in-flight agent turn. Returns `false` when there was nothing to
   * cancel; mutations already applied to Live are not reverted.
   */
  public cancel(): Promise<boolean> {
    return this.services.agent.cancel();
  }

  /** Identifier of the current agent conversation, when one is open. */
  public get agentSessionId(): string | undefined {
    return this.services.agent.sessionId;
  }

  public createAgentSession(): Promise<string> {
    return this.services.agent.createSession();
  }

  public resumeAgentSession(sessionId: string): Promise<void> {
    return this.services.agent.resumeSession(sessionId);
  }

  public getManagedAgentSessionId(instanceId: string): string | undefined {
    return this.#requireManagedAgentMethod("getManagedAgentSessionId")(
      instanceId,
    );
  }

  public createManagedAgent(
    configuration: AgentSessionConfiguration,
  ): Promise<string> {
    return this.#requireManagedAgentMethod("createManagedAgent")(configuration);
  }

  public resumeManagedAgent(
    configuration: AgentSessionConfiguration,
    sdkSessionId: string,
  ): Promise<void> {
    return this.#requireManagedAgentMethod("resumeManagedAgent")(
      configuration,
      sdkSessionId,
    );
  }

  public reconfigureManagedAgent(
    configuration: AgentSessionConfiguration,
  ): Promise<void> {
    return this.#requireManagedAgentMethod("reconfigureManagedAgent")(
      configuration,
    );
  }

  public deactivateManagedAgent(instanceId: string): Promise<void> {
    return this.#requireManagedAgentMethod("deactivateManagedAgent")(
      instanceId,
    );
  }

  public sendToManagedAgent(
    instanceId: string,
    prompt: string,
  ): Promise<string> {
    if (this.#state !== "ready" && this.#state !== "degraded") {
      return Promise.reject(
        new Error(`Application is not running (${this.#state})`),
      );
    }
    return this.#requireManagedAgentMethod("sendToManagedAgent")(
      instanceId,
      prompt,
    );
  }

  public invokeManagedAgentSkill(
    instanceId: string,
    invocation: string | SkillInvocation,
  ): Promise<string> {
    if (this.#state !== "ready" && this.#state !== "degraded") {
      return Promise.reject(
        new Error(`Application is not running (${this.#state})`),
      );
    }
    return this.#requireManagedAgentMethod("invokeManagedAgentSkill")(
      instanceId,
      invocation,
    );
  }

  public cancelManagedAgent(instanceId: string): Promise<boolean> {
    return this.#requireManagedAgentMethod("cancelManagedAgent")(instanceId);
  }

  public getManagedAgentHistory(
    instanceId: string,
  ): Promise<readonly AgentHistoryMessage[]> {
    return this.#requireManagedAgentMethod("getManagedAgentHistory")(
      instanceId,
    );
  }

  /**
   * Reattempts the Ableton connection and publishes the resulting status. The
   * reported status is whatever the bridge observed, never an assumption.
   */
  public async connectAbleton(): Promise<ConnectionStatus> {
    if (this.#state === "stopped" || this.#state === "stopping") {
      throw new Error(`Application is not running (${this.#state})`);
    }
    await this.services.ableton.start();
    const status = await this.services.ableton.getStatus();
    this.services.events.publish({
      type: "ableton.connection_changed",
      status,
    });
    this.#setState(status.state === "connected" ? "ready" : "degraded");
    return status;
  }

  public getStatus(): Promise<ConnectionStatus> {
    return this.services.ableton.getStatus();
  }

  public getCapabilities(): Promise<CapabilityDocument> {
    return this.services.ableton.getCapabilities();
  }

  public ping(): Promise<PingResult> {
    return this.services.ableton.ping();
  }

  public inspectSession(): Promise<SessionSnapshot> {
    return this.services.ableton.inspectSession();
  }

  public setTempo(tempo: number): Promise<SetTempoResult> {
    return this.services.ableton.setTempo(tempo);
  }

  public setPlaying(isPlaying: boolean): Promise<SetPlayingResult> {
    return this.services.ableton.setPlaying(isPlaying);
  }

  public inspectArrangementTransport(
    params: InspectArrangementTransportParams,
  ): Promise<InspectArrangementTransportResult> {
    return this.services.ableton.inspectArrangementTransport(params);
  }

  public setArrangementLoop(
    params: SetArrangementLoopParams,
  ): Promise<SetArrangementLoopResult> {
    return this.services.ableton.setArrangementLoop(params);
  }

  public createCuePoint(
    params: CreateCuePointParams,
  ): Promise<CuePointMutationResult> {
    return this.services.ableton.createCuePoint(params);
  }

  public deleteCuePoint(
    params: DeleteCuePointParams,
  ): Promise<CuePointMutationResult> {
    return this.services.ableton.deleteCuePoint(params);
  }

  public createTrack(params: CreateTrackParams): Promise<TrackMutationResult> {
    return this.services.ableton.createTrack(params);
  }

  public deleteTrack(params: DeleteTrackParams): Promise<TrackMutationResult> {
    return this.services.ableton.deleteTrack(params);
  }

  public renameTrack(params: RenameTrackParams): Promise<RenameTrackResult> {
    return this.services.ableton.renameTrack(params);
  }

  public setTrackMixer(
    params: SetTrackMixerParams,
  ): Promise<SetTrackMixerResult> {
    return this.services.ableton.setTrackMixer(params);
  }

  public inspectDevices(
    params: InspectDevicesParams,
  ): Promise<InspectDevicesResult> {
    return this.services.ableton.inspectDevices(params);
  }

  public inspectBrowserRoots(): Promise<InspectBrowserRootsResult> {
    return this.services.ableton.inspectBrowserRoots();
  }

  public inspectBrowserChildren(
    params: InspectBrowserChildrenParams,
  ): Promise<InspectBrowserChildrenResult> {
    return this.services.ableton.inspectBrowserChildren(params);
  }

  public searchBrowser(
    params: SearchBrowserParams,
  ): Promise<SearchBrowserResult> {
    return this.services.ableton.searchBrowser(params);
  }

  public loadBrowserItem(
    params: LoadBrowserItemParams,
  ): Promise<LoadBrowserItemResult> {
    return this.services.ableton.loadBrowserItem(params);
  }

  public inspectDeviceParameters(
    params: InspectDeviceParametersParams,
  ): Promise<InspectDeviceParametersResult> {
    return this.services.ableton.inspectDeviceParameters(params);
  }

  public inspectRackChains(
    params: InspectRackChainsParams,
  ): Promise<InspectRackChainsResult> {
    return this.services.ableton.inspectRackChains(params);
  }

  public inspectRackChainDevices(
    params: InspectRackChainDevicesParams,
  ): Promise<InspectRackChainDevicesResult> {
    return this.services.ableton.inspectRackChainDevices(params);
  }

  public inspectDrumRackPads(
    params: InspectDrumRackPadsParams,
  ): Promise<InspectDrumRackPadsResult> {
    return this.services.ableton.inspectDrumRackPads(params);
  }

  public inspectDrumPadChains(
    params: InspectDrumPadChainsParams,
  ): Promise<InspectDrumPadChainsResult> {
    return this.services.ableton.inspectDrumPadChains(params);
  }

  public inspectDrumPadChainDevices(
    params: InspectDrumPadChainDevicesParams,
  ): Promise<InspectDrumPadChainDevicesResult> {
    return this.services.ableton.inspectDrumPadChainDevices(params);
  }

  public setDeviceEnabled(
    params: SetDeviceEnabledParams,
  ): Promise<SetDeviceEnabledResult> {
    return this.services.ableton.setDeviceEnabled(params);
  }

  public setDeviceParameter(
    params: SetDeviceParameterParams,
  ): Promise<SetDeviceParameterResult> {
    return this.services.ableton.setDeviceParameter(params);
  }

  public createMidiClip(
    params: CreateMidiClipParams,
  ): Promise<CreateMidiClipResult> {
    return this.services.ableton.createMidiClip(params);
  }

  public inspectMidiNotes(
    params: InspectMidiNotesParams,
  ): Promise<InspectMidiNotesResult> {
    return this.services.ableton.inspectMidiNotes(params);
  }

  public replaceMidiNotes(
    params: ReplaceMidiNotesParams,
  ): Promise<ReplaceMidiNotesResult> {
    return this.services.ableton.replaceMidiNotes(params);
  }

  public launchSessionClip(
    params: LaunchSessionClipParams,
  ): Promise<LaunchSessionClipResult> {
    return this.services.ableton.launchSessionClip(params);
  }

  public duplicateSessionClip(
    params: DuplicateSessionClipParams,
  ): Promise<DuplicateSessionClipResult> {
    return this.services.ableton.duplicateSessionClip(params);
  }

  public deleteSessionClip(
    params: DeleteSessionClipParams,
  ): Promise<DeleteSessionClipResult> {
    return this.services.ableton.deleteSessionClip(params);
  }

  public setSessionClipProperties(
    params: SetSessionClipPropertiesParams,
  ): Promise<SetSessionClipPropertiesResult> {
    return this.services.ableton.setSessionClipProperties(params);
  }

  public createArrangementMidiClip(
    params: CreateArrangementMidiClipParams,
  ): Promise<CreateArrangementMidiClipResult> {
    return this.services.ableton.createArrangementMidiClip(params);
  }

  public inspectArrangement(
    params: InspectArrangementParams,
  ): Promise<InspectArrangementResult> {
    return this.services.ableton.inspectArrangement(params);
  }

  public inspectArrangementMidiNotes(
    params: InspectArrangementMidiNotesParams,
  ): Promise<InspectArrangementMidiNotesResult> {
    return this.services.ableton.inspectArrangementMidiNotes(params);
  }

  public deleteArrangementClip(
    params: DeleteArrangementClipParams,
  ): Promise<DeleteArrangementClipResult> {
    return this.services.ableton.deleteArrangementClip(params);
  }

  public replaceArrangementMidiNotes(
    params: ReplaceArrangementMidiNotesParams,
  ): Promise<ReplaceArrangementMidiNotesResult> {
    return this.services.ableton.replaceArrangementMidiNotes(params);
  }

  public duplicateClipToArrangement(
    params: DuplicateClipToArrangementParams,
  ): Promise<DuplicateClipToArrangementResult> {
    return this.services.ableton.duplicateClipToArrangement(params);
  }

  public setArrangementClipProperties(
    params: SetArrangementClipPropertiesParams,
  ): Promise<SetArrangementClipPropertiesResult> {
    return this.services.ableton.setArrangementClipProperties(params);
  }

  public subscribe(listener: (event: AppEvent) => void): () => void {
    return this.services.events.subscribe(listener);
  }

  #setState(state: LifecycleState): void {
    this.#state = state;
    this.services.events.publish({ type: "lifecycle.changed", state });
  }
}
