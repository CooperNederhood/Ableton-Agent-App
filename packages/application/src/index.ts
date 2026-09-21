import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import type { AbletonService } from "@ableton-agent/ableton-contracts";
import {
  formatSkillInvocation,
  parseSkillInvocation,
  readSkillDocument,
  agentReasoningEffortSchema,
  skillNameSchema,
  type AgentReasoningEffort,
  type BoundTrackScope,
  type EditScopeEntry,
  type AgentEventListener,
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
  FillArrangementRegionParams,
  FillArrangementRegionResult,
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
  LiveIdentity,
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
  AgentMode,
  AgentReasoningSummary,
  AgentWorkingUpdate,
  AgentElicitationRequest,
  AgentElicitationResolution,
  AgentElicitationValue,
  AgentPlanExitAction,
  ConnectionStatus,
  EventPublisher,
  LifecycleState,
  LiveEventTriggerView,
  LiveEventTypedState,
  Logger,
  PlanArtifactSnapshot,
} from "@ableton-agent/shared";
import { noopLogger } from "@ableton-agent/shared";
import {
  AbletonMutationAuthorizationError,
  abletonToolMetadata,
  createAbletonMutationAuthorizer,
  createAbletonMutationLockManager,
  createAbletonPermissionHandler,
  createAbletonTools,
  parseAbletonToolFailure,
  runAuthorizedAbletonMutation,
  SET_SQL_SEARCH_TOOL_NAME,
  type AbletonMutationAuthorizationContext,
  type SetHistoryQueryService,
  type ToolApprovalRequester,
} from "@ableton-agent/tools";
import { resolveLiveAgentStorage } from "@ableton-agent/storage";
import {
  BuiltInTools,
  CopilotClient,
  ToolSet,
  defineTool,
  type ElicitationContext,
  type ElicitationFieldValue,
  type ElicitationResult,
  type ModelInfo,
  type ResumeSessionConfig,
  type SessionConfig,
  type SessionEvent,
  type Tool,
  type ToolInvocation,
} from "@github/copilot-sdk";
import { z } from "zod";

import { createAgentPolicy } from "./agent-policy.js";
import {
  formatAutomaticSignalPrompt,
  type SignalContextOptions,
  type SignalDeliveryService,
  type SignalTurnRequest,
} from "./signal-delivery.js";
import {
  formatAutomaticLiveEventPrompt,
  type LiveEventContextOptions,
  type LiveEventDeliveryService,
  type LiveEventTurnRequest,
  type PreparedContextProvider,
} from "./live-event-delivery.js";
import {
  FilePlanArtifactStore,
  PlanArtifactConflictError,
  type PlanArtifactPathResolver,
  type PlanArtifactWrite,
} from "./plan-artifact.js";

type SdkUserInputHandler = NonNullable<SessionConfig["onUserInputRequest"]>;
type SdkUserInputRequest = Parameters<SdkUserInputHandler>[0];
type SdkUserInputResponse = Awaited<ReturnType<SdkUserInputHandler>>;

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
export {
  constructNextPromptLiveEventContext,
  formatAutomaticLiveEventPrompt,
  type LiveEventContextOptions,
  type LiveEventContextProvider,
  type LiveEventDeliveryService,
  type LiveEventTurnRequest,
  type PendingLiveEventContext,
  type PreparedContextProvider,
} from "./live-event-delivery.js";
export {
  FilePlanArtifactStore,
  MAX_PLAN_ARTIFACT_BYTES,
  MAX_PLAN_ARTIFACT_CHARACTERS,
  PlanArtifactConflictError,
  type PlanArtifactPathResolver,
  type PlanArtifactPaths,
  type PlanArtifactWrite,
} from "./plan-artifact.js";

export interface AgentSessionConfiguration {
  readonly instanceId: string;
  readonly productionSessionId: string;
  readonly definitionName: string;
  readonly label: string;
  readonly model?: string;
  readonly reasoningEffort?: AgentReasoningEffort;
  readonly description: string;
  readonly systemPrompt: string;
  readonly resolvedTools: readonly string[];
  readonly editScope: readonly EditScopeEntry[];
  readonly boundTracks: readonly BoundTrackScope[];
  readonly skills: readonly string[];
  readonly availableSkills?: readonly AgentSkillDescriptor[];
}

export interface AgentModelDescriptor {
  readonly id: string;
  readonly displayName: string;
  readonly policyState: "enabled" | "disabled" | "unconfigured";
  readonly capabilities: {
    readonly vision: boolean;
    readonly reasoningEffort: boolean;
    readonly maxPromptTokens?: number | undefined;
    readonly maxContextWindowTokens?: number | undefined;
  };
  readonly supportedReasoningEfforts: readonly string[];
  readonly defaultReasoningEffort?: string | undefined;
}

export interface AgentSkillDescriptor {
  readonly name: string;
  readonly description: string;
  readonly sourcePath: string;
  readonly fingerprint: string;
}

export interface AgentHistoryMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly timestamp: string;
  readonly eventId: string;
  readonly messageId?: string;
  readonly agentInstanceId?: string;
  readonly sdkSessionId?: string;
  readonly agentMode?: AgentMode;
}

export interface AgentService
  extends Partial<SignalDeliveryService>, Partial<LiveEventDeliveryService> {
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
  /** Lists models reported by the connected Copilot runtime. */
  listModels?(): Promise<readonly AgentModelDescriptor[]>;
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
  sendToManagedAgent?(
    instanceId: string,
    prompt: string,
    agentMode?: AgentMode,
  ): Promise<string>;
  /** Explicitly invokes one configured skill for a managed agent instance. */
  invokeManagedAgentSkill?(
    instanceId: string,
    invocation: string | SkillInvocation,
    agentMode?: AgentMode,
  ): Promise<string>;
  /** Cancels an in-flight turn for one managed agent instance. */
  cancelManagedAgent?(instanceId: string): Promise<boolean>;
  /** Current SDK session id for a managed agent instance, when connected. */
  getManagedAgentSessionId?(instanceId: string): string | undefined;
  /** Normalized persisted user/assistant history for one managed instance. */
  getManagedAgentHistory?(
    instanceId: string,
  ): Promise<readonly AgentHistoryMessage[]>;
  /** Resolves a pending completed-plan request for one managed instance. */
  resolveManagedAgentPlan?(
    instanceId: string,
    request: {
      requestId: string;
      approved: boolean;
      planRevision?: string;
      selectedAction?: AgentPlanExitAction;
      feedback?: string;
    },
  ): Promise<boolean>;
  readManagedAgentPlan?(instanceId: string): Promise<PlanArtifactSnapshot>;
  writeManagedAgentPlan?(
    instanceId: string,
    input: PlanArtifactWrite,
  ): Promise<PlanArtifactSnapshot>;
  resolveManagedAgentElicitation?(
    instanceId: string,
    request: {
      requestId: string;
      action: "accept" | "decline" | "cancel";
      content?: Readonly<Record<string, AgentElicitationValue>>;
    },
  ): Promise<boolean>;
}

const missingCopilotSessionPattern =
  /^Request session\.(?:send|getMessages) failed with message: Session not found for sessionId: [^\s]+$/u;

export class MissingCopilotSessionError extends Error {
  public readonly cleanupError: unknown;

  public constructor(
    public readonly sdkSessionId: string,
    options: { cause?: unknown; cleanupError?: unknown } = {},
  ) {
    super(`Copilot SDK session '${sdkSessionId}' no longer exists`, {
      cause: options.cause,
    });
    this.name = "MissingCopilotSessionError";
    this.cleanupError = options.cleanupError;
  }
}

export function isMissingCopilotSessionError(
  error: unknown,
): error is MissingCopilotSessionError {
  return (
    error instanceof MissingCopilotSessionError ||
    (error instanceof Error && missingCopilotSessionPattern.test(error.message))
  );
}

const MAX_PLAN_SUMMARY_LENGTH = 8_192;
const MAX_PLAN_CONTENT_LENGTH = 100_000;
const MAX_PLAN_FEEDBACK_LENGTH = 8_192;
const MAX_WORKING_CONTENT_LENGTH = 16_000;

function boundedPlanText(value: string, maximum: number): string {
  return value.slice(0, maximum);
}

function recordValue(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function elicitationRequest(
  requestId: string,
  context: ElicitationContext,
  options: { allowChoiceFreeform?: boolean } = {},
): AgentElicitationRequest {
  const properties = Object.fromEntries(
    Object.entries(context.requestedSchema?.properties ?? {})
      .slice(0, 32)
      .map(([name, field]) => [
        name,
        options.allowChoiceFreeform &&
        field.type === "string" &&
        ("enum" in field || "oneOf" in field)
          ? {
              ...field,
              allowFreeform: true,
              minLength: 1,
              maxLength: MAX_PLAN_FEEDBACK_LENGTH,
            }
          : field,
      ]),
  ) as AgentElicitationRequest["properties"];
  return {
    requestId,
    message: boundedPlanText(context.message, MAX_PLAN_SUMMARY_LENGTH),
    properties,
    required: (context.requestedSchema?.required ?? [])
      .filter((name) => Object.hasOwn(properties, name))
      .slice(0, 32),
  };
}

function validateElicitationContent(
  request: AgentElicitationRequest,
  content: Readonly<Record<string, AgentElicitationValue>>,
): Record<string, ElicitationFieldValue> {
  for (const required of request.required) {
    if (content[required] === undefined) {
      throw new Error(`Elicitation field '${required}' is required`);
    }
  }
  const validated: Record<string, ElicitationFieldValue> = {};
  for (const [name, value] of Object.entries(content)) {
    const field = request.properties[name];
    if (field === undefined) {
      throw new Error(`Unknown elicitation field '${name}'`);
    }
    if (field.type === "string") {
      if (typeof value !== "string") {
        throw new Error(`Elicitation field '${name}' must be text`);
      }
      if (field.minLength !== undefined && value.length < field.minLength) {
        throw new Error(
          `Elicitation field '${name}' must contain at least ${field.minLength} characters`,
        );
      }
      if (field.maxLength !== undefined && value.length > field.maxLength) {
        throw new Error(
          `Elicitation field '${name}' must contain at most ${field.maxLength} characters`,
        );
      }
      const allowed = field.enum ?? field.oneOf?.map((choice) => choice.const);
      if (
        allowed !== undefined &&
        !allowed.includes(value) &&
        field.allowFreeform !== true
      ) {
        throw new Error(`Elicitation field '${name}' has an invalid choice`);
      }
    } else if (field.type === "array") {
      if (
        !Array.isArray(value) ||
        value.some((entry) => typeof entry !== "string")
      ) {
        throw new Error(`Elicitation field '${name}' must be a text list`);
      }
      if (field.minItems !== undefined && value.length < field.minItems) {
        throw new Error(
          `Elicitation field '${name}' requires at least ${field.minItems} choices`,
        );
      }
      if (field.maxItems !== undefined && value.length > field.maxItems) {
        throw new Error(
          `Elicitation field '${name}' allows at most ${field.maxItems} choices`,
        );
      }
      const allowed =
        "enum" in field.items
          ? field.items.enum
          : field.items.anyOf.map((choice) => choice.const);
      if (value.some((entry) => !allowed.includes(entry))) {
        throw new Error(`Elicitation field '${name}' has an invalid choice`);
      }
    } else if (field.type === "boolean") {
      if (typeof value !== "boolean") {
        throw new Error(`Elicitation field '${name}' must be true or false`);
      }
    } else {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`Elicitation field '${name}' must be a number`);
      }
      if (field.type === "integer" && !Number.isInteger(value)) {
        throw new Error(`Elicitation field '${name}' must be an integer`);
      }
      if (field.minimum !== undefined && value < field.minimum) {
        throw new Error(
          `Elicitation field '${name}' must be at least ${field.minimum}`,
        );
      }
      if (field.maximum !== undefined && value > field.maximum) {
        throw new Error(
          `Elicitation field '${name}' must be at most ${field.maximum}`,
        );
      }
    }
    validated[name] = value;
  }
  return validated;
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
  send(options: { prompt: string; agentMode?: AgentMode }): Promise<string>;
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
  listModels?(): Promise<ModelInfo[]>;
  stop(): Promise<unknown>;
}

export interface CopilotAgentServiceOptions {
  events: EventPublisher;
  logger?: Logger;
  setHistoryQuery?: SetHistoryQueryService;
  getAbletonStatus: () => Promise<ConnectionStatus>;
  inspectSession: () => Promise<SessionSnapshot>;
  preparedContextProvider?: PreparedContextProvider;
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
  fillArrangementRegion: (
    params: FillArrangementRegionParams,
  ) => Promise<FillArrangementRegionResult>;
  setArrangementClipProperties: (
    params: SetArrangementClipPropertiesParams,
  ) => Promise<SetArrangementClipPropertiesResult>;
  requestToolApproval?: ToolApprovalRequester;
  askForReadApproval?: boolean | (() => boolean);
  clientFactory?: () => CopilotClientAdapter;
  baseDirectory?: string;
  resolvePlanArtifactPaths?: PlanArtifactPathResolver;
  model?: string;
  reasoningEffort?: AgentReasoningEffort;
  reasoningSummary?: AgentReasoningSummary | (() => AgentReasoningSummary);
  turnTimeoutMs?: number | (() => number);
  signalContext?: SignalContextOptions;
  liveEventContext?: LiveEventContextOptions;
  resolveSkill?: (
    productionSessionId: string,
    skillName: string,
  ) => Promise<AgentSkillDescriptor | undefined>;
  /**
   * Non-blocking ingress for exact, application-level runtime records. The
   * receiver owns buffering and persistence; agent execution never awaits it.
   */
  runtimeObserver?: AgentRuntimeObserver;
}

export type AgentPromptOrigin =
  | "user"
  | "skill"
  | "live-event.automatic"
  | "live-event.next-prompt"
  | "output.automatic"
  | "output.next-prompt";

export interface AgentRuntimeTraceContext {
  readonly traceId: string;
  readonly turnId: string;
  readonly occurrenceIds: readonly string[];
  readonly deliveryIds: readonly string[];
}

export interface AgentRuntimeEvent {
  readonly type: string;
  readonly occurredAt: string;
  readonly sessionId?: string;
  readonly agentInstanceId?: string;
  readonly trace?: AgentRuntimeTraceContext;
  /** Exact application/SDK data for the event; redaction is a sink concern. */
  readonly data: Readonly<Record<string, unknown>>;
}

export interface AgentRuntimeObserver {
  enqueue(event: AgentRuntimeEvent): void;
}

export const DEFAULT_AGENT_TURN_TIMEOUT_MS = 600_000;
export const BASE_SYSTEM_MESSAGE_VERSION = 7;
export const PLAN_REMINDER_VERSION = 2;
const baseSystemMessageCandidates = [
  new URL("../prompts/base-system-message.md", import.meta.url),
  new URL("./prompts/base-system-message.md", import.meta.url),
];
const planReminderCandidates = [
  new URL("../prompts/plan-reminder.md", import.meta.url),
  new URL("./prompts/plan-reminder.md", import.meta.url),
];

function loadPromptAsset(label: string, candidates: readonly URL[]): string {
  const failures: string[] = [];
  for (const candidate of candidates) {
    try {
      const content = readFileSync(candidate, "utf8").trim();
      if (content.length === 0) {
        failures.push(`${candidate.pathname}: prompt is empty`);
        continue;
      }
      return content;
    } catch (error) {
      failures.push(
        `${candidate.pathname}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  throw new Error(`${label} could not be loaded:\n${failures.join("\n")}`);
}

export function loadBaseSystemMessage(
  candidates: readonly URL[] = baseSystemMessageCandidates,
): string {
  return loadPromptAsset("Base system message", candidates);
}

export function loadPlanReminder(
  candidates: readonly URL[] = planReminderCandidates,
): string {
  return loadPromptAsset("Plan reminder", candidates);
}

export const BASE_SYSTEM_MESSAGE = loadBaseSystemMessage();
export const PLAN_REMINDER = loadPlanReminder();

export function composeAgentTurnPrompt(
  prompt: string,
  agentMode: AgentMode | undefined,
): string {
  return agentMode === "plan" ? `${prompt}\n\n${PLAN_REMINDER}` : prompt;
}

export const SKILL_TOOL_NAME = "skill";
const EXIT_PLAN_MODE_TOOL_NAME = "exit_plan_mode";
const ASK_USER_TOOL_NAME = "ask_user";
export const READ_PLAN_TOOL_NAME = "read_plan";
export const WRITE_PLAN_TOOL_NAME = "write_plan";
export const APPROVED_BUILTIN_TOOL_NAMES = BuiltInTools.Isolated.filter(
  (name) => name !== SKILL_TOOL_NAME,
);
export const APPLICATION_TOOL_NAMES = [
  SKILL_TOOL_NAME,
  READ_PLAN_TOOL_NAME,
  WRITE_PLAN_TOOL_NAME,
] as const;
const CORE_AGENT_TOOL_NAMES = [
  ASK_USER_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  READ_PLAN_TOOL_NAME,
  WRITE_PLAN_TOOL_NAME,
] as const;
const directSkillHistoryPrefix = "<!-- ableton-agent:direct-skill ";

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

type HumanGateReason = "elicitation" | "plan_approval" | "tool_approval";

interface TurnTimeoutPause {
  readonly token: symbol;
  readonly reason: HumanGateReason;
  readonly requestId: string;
  readonly startedAt: number;
}

interface TurnTimeoutPauseResult {
  readonly pause: TurnTimeoutPause;
  readonly remainingMs: number;
  readonly pendingHumanGateCount: number;
  readonly timerPaused: boolean;
}

interface TurnTimeoutResumeResult {
  readonly pause: TurnTimeoutPause;
  readonly remainingMs: number;
  readonly pendingHumanGateCount: number;
  readonly humanWaitDurationMs: number;
  readonly timerResumed: boolean;
}

interface TurnTimeoutCancelResult {
  readonly pauses: readonly TurnTimeoutPause[];
  readonly remainingMs: number;
}

class PausableTurnTimeout {
  readonly expired: Promise<void>;

  #remainingMs: number;
  #runningSince: number | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #resolveExpired!: () => void;
  #expired = false;
  #disposed = false;
  readonly #pauses = new Map<symbol, TurnTimeoutPause>();

  constructor(readonly timeoutMs: number) {
    this.#remainingMs = timeoutMs;
    this.expired = new Promise<void>((resolve) => {
      this.#resolveExpired = resolve;
    });
  }

  start(): void {
    this.#schedule();
  }

  pause(
    reason: HumanGateReason,
    requestId: string,
  ): TurnTimeoutPauseResult | undefined {
    if (this.#disposed || this.#expired) return undefined;
    const now = Date.now();
    const timerPaused = this.#pauses.size === 0;
    if (timerPaused) this.#stopAndDebit(now);
    const pause: TurnTimeoutPause = {
      token: Symbol(requestId),
      reason,
      requestId,
      startedAt: now,
    };
    this.#pauses.set(pause.token, pause);
    return {
      pause,
      remainingMs: this.#remainingMs,
      pendingHumanGateCount: this.#pauses.size,
      timerPaused,
    };
  }

  resume(token: symbol): TurnTimeoutResumeResult | undefined {
    if (this.#disposed || this.#expired) return undefined;
    const pause = this.#pauses.get(token);
    if (pause === undefined) return undefined;
    this.#pauses.delete(token);
    const timerResumed = this.#pauses.size === 0;
    if (timerResumed) this.#schedule();
    return {
      pause,
      remainingMs: this.#remainingMs,
      pendingHumanGateCount: this.#pauses.size,
      humanWaitDurationMs: Date.now() - pause.startedAt,
      timerResumed,
    };
  }

  dispose(): void {
    this.cancel();
  }

  cancel(): TurnTimeoutCancelResult | undefined {
    if (this.#disposed) return;
    const now = Date.now();
    this.#stopAndDebit(now);
    this.#disposed = true;
    const pauses = [...this.#pauses.values()];
    this.#pauses.clear();
    return { pauses, remainingMs: this.#remainingMs };
  }

  #schedule(): void {
    if (
      this.#disposed ||
      this.#expired ||
      this.#timer !== undefined ||
      this.#pauses.size > 0
    ) {
      return;
    }
    this.#runningSince = Date.now();
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#runningSince = undefined;
      this.#remainingMs = 0;
      this.#expired = true;
      this.#resolveExpired();
    }, this.#remainingMs);
  }

  #stopAndDebit(now: number): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#runningSince !== undefined) {
      this.#remainingMs = Math.max(
        0,
        this.#remainingMs - (now - this.#runningSince),
      );
      this.#runningSince = undefined;
    }
  }
}

function waitForSessionCompletion(session: CopilotSessionAdapter): {
  readonly promise: Promise<CopilotResponse | undefined>;
  dispose(): void;
} {
  let lastAssistantMessage: CopilotResponse | undefined;
  let unsubscribe: () => void = () => {};
  const promise = new Promise<CopilotResponse | undefined>(
    (resolve, reject) => {
      unsubscribe = session.on((event) => {
        if (event.type === "assistant.message") {
          lastAssistantMessage = { data: { content: event.data.content } };
        } else if (
          event.type === "session.idle" &&
          event.data.mode !== "autopilot"
        ) {
          resolve(lastAssistantMessage);
        } else if (event.type === "session.error") {
          const error = new Error(event.data.message);
          if (event.data.stack !== undefined) error.stack = event.data.stack;
          reject(error);
        }
      });
    },
  );
  return {
    promise,
    dispose: unsubscribe,
  };
}

const DEFAULT_AGENT_INSTANCE_KEY = "__default__";
const DEFAULT_AGENT_DEFINITION_NAME = "default-agent";
const DEFAULT_AGENT_LABEL = "Ableton Agent";
const DEFAULT_AGENT_DESCRIPTION =
  "Primary Ableton Live production assistant for the current session.";
const DEFAULT_AGENT_PROMPT =
  "Act as the general-purpose Ableton production agent for the current Live Set. Inspect when needed, then directly perform the user's requested supported edits with the available tools. Mutations are restricted by tool approval, edit scope, connection, and automatic-analysis policies. Follow the session system message and clearly report observed state, applied changes, and real limitations.";

type CopilotTurnKind = "user" | "automatic-analysis" | "automatic-action";

interface PendingAutomaticTurn {
  request: SignalTurnRequest;
  deliveryIds: string[];
  turn: InstrumentedTurn;
  waiters: Array<{
    resolve: (response: string) => void;
    reject: (reason: unknown) => void;
  }>;
}

interface ObservedOperation {
  label: string;
  toolName: string;
  mutates: boolean;
  arguments: Readonly<Record<string, unknown>>;
  startedAt: number;
}

interface MutableRuntimeTrace {
  traceId: string;
  turnId: string;
  occurrenceIds: string[];
  deliveryIds: string[];
}

interface InstrumentedTurn {
  id: string;
  queuedAt: number;
  origin: AgentPromptOrigin;
  prompt: string;
  trace: MutableRuntimeTrace;
  finalObserved: boolean;
  startedAt: number | undefined;
  terminalRecorded: boolean;
  toolStarted: boolean;
  retryAttempted: boolean;
  workingTerminalPublished: boolean;
  timeout: PausableTurnTimeout | undefined;
  readonly agentMode?: AgentMode;
}

interface ManagedSessionState {
  readonly key: string;
  configuration: AgentSessionConfiguration;
  readonly exposeInstanceId: boolean;
  signalTargetId: string;
  session: CopilotSessionAdapter | undefined;
  appliedReasoningSummary: AgentReasoningSummary | undefined;
  unsubscribe: (() => void) | undefined;
  inFlightTurns: number;
  queuedTurns: number;
  turnQueue: Promise<void>;
  turnKind: CopilotTurnKind | undefined;
  activeAgentMode: AgentMode | undefined;
  preparedContextListener: AgentEventListener | undefined;
  activeTurn: InstrumentedTurn | undefined;
  automaticDrainScheduled: boolean;
  readonly pendingAutomatic: Map<string, PendingAutomaticTurn>;
  readonly operations: Map<string, ObservedOperation>;
  readonly directPlanRequests: Map<
    string,
    {
      readonly sessionId: string;
      readonly productionSessionId: string;
      artifact: Extract<PlanArtifactSnapshot, { exists: true }>;
      readonly summary: string;
      readonly actions: readonly AgentPlanExitAction[];
      readonly recommendedAction: AgentPlanExitAction;
      resolve: (response: {
        approved: boolean;
        selectedAction?: AgentPlanExitAction;
        feedback?: string;
      }) => void;
    }
  >;
  readonly elicitationRequests: Map<
    string,
    {
      readonly sessionId: string;
      readonly startedAt: number;
      readonly request: AgentElicitationRequest;
      resolve: (result: ElicitationResult) => void;
    }
  >;
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

function enabledSkillDescriptors(
  configuration: AgentSessionConfiguration,
): AgentSkillDescriptor[] {
  const availableByName = new Map(
    (configuration.availableSkills ?? []).map((skill) => [skill.name, skill]),
  );
  return configuration.skills.map((name) => {
    const skill = availableByName.get(name);
    if (skill === undefined) {
      throw new Error(`Configured skill '${name}' is unavailable`);
    }
    return skill;
  });
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

export function formatSkillSystemInstructions(
  skills: readonly AgentSkillDescriptor[],
): string | undefined {
  if (skills.length === 0) return undefined;
  const frontmatters = skills.map((skill) =>
    [
      "---",
      `name: ${skill.name}`,
      `description: ${yamlString(skill.description)}`,
      "---",
    ].join("\n"),
  );
  return [
    "<skill_instructions>",
    'Below are skill names and descriptions. If, based on the description, a skill is relevant to your work, you SHOULD call the skill via the skill(skill_name="{skill-name}") tool.',
    "",
    ...frontmatters.flatMap((frontmatter, index) =>
      index === frontmatters.length - 1 ? [frontmatter] : [frontmatter, ""],
    ),
    "</skill_instructions>",
  ].join("\n");
}

function formatDirectSkillPrompt(
  skillName: string,
  body: string,
  request: string,
): string {
  return [
    `${directSkillHistoryPrefix}${skillName} ${Buffer.from(request, "utf8").toString("base64url")} -->`,
    `The user explicitly invoked the '${skillName}' skill for this turn.`,
    "",
    `<skill_body name="${skillName}">`,
    body,
    "</skill_body>",
    "",
    request.length === 0
      ? "Follow these skill instructions for this turn."
      : [
          "Apply these skill instructions to the following request:",
          request,
        ].join("\n\n"),
  ].join("\n");
}

function displayUserPrompt(content: string): string {
  if (content.startsWith("<live-event-trigger ")) return "";
  const firstLineEnd = content.indexOf("\n");
  const firstLine =
    firstLineEnd === -1 ? content : content.slice(0, firstLineEnd);
  if (
    !firstLine.startsWith(directSkillHistoryPrefix) ||
    !firstLine.endsWith(" -->")
  ) {
    return content;
  }

  const encoded = firstLine.slice(
    directSkillHistoryPrefix.length,
    -" -->".length,
  );
  const separator = encoded.indexOf(" ");
  if (separator < 1) return content;
  const parsedSkillName = skillNameSchema.safeParse(
    encoded.slice(0, separator),
  );
  const encodedRequest = encoded.slice(separator + 1);
  if (!parsedSkillName.success || !/^[A-Za-z0-9_-]*$/u.test(encodedRequest)) {
    return content;
  }
  return formatSkillInvocation({
    skillName: parsedSkillName.data,
    request: Buffer.from(encodedRequest, "base64url").toString("utf8"),
  });
}

function liveEventTypedState(
  occurrence: LiveEventTurnRequest["occurrence"],
): LiveEventTypedState {
  switch (occurrence.kind) {
    case "parameter.value_changed":
      return { kind: occurrence.kind, state: occurrence.current };
    case "track.playing_clip_changed":
      return { kind: occurrence.kind, state: occurrence.current };
    case "track.triggered_clip_changed":
      return { kind: occurrence.kind, state: occurrence.current };
    case "track.recording_state_changed":
      return { kind: occurrence.kind, state: occurrence.current };
  }
}

const approvedBuiltinToolNames = new Set(APPROVED_BUILTIN_TOOL_NAMES);

function qualifyAvailableTools(toolNames: readonly string[]): string[] {
  const tools = new ToolSet();
  for (const toolName of dedupeStrings([
    ...bareToolNames(toolNames),
    ...CORE_AGENT_TOOL_NAMES,
  ])) {
    if (approvedBuiltinToolNames.has(toolName)) tools.addBuiltIn(toolName);
    else tools.addCustom(toolName);
  }
  return tools.toArray();
}

function toolParameterSchema(tool: Tool): Readonly<Record<string, unknown>> {
  const parameters = tool.parameters;
  if (parameters === undefined) return {};
  const candidate = parameters as {
    toJSONSchema?: () => Record<string, unknown>;
  };
  if (typeof candidate.toJSONSchema === "function") {
    return candidate.toJSONSchema();
  }
  return parameters as Record<string, unknown>;
}

function toAgentModelDescriptor(model: ModelInfo): AgentModelDescriptor {
  const maxPromptTokens = model.capabilities?.limits?.max_prompt_tokens;
  const maxContextWindowTokens =
    model.capabilities?.limits?.max_context_window_tokens;
  return {
    id: model.id,
    displayName: model.name,
    policyState: model.policy?.state ?? "unconfigured",
    capabilities: {
      vision: model.capabilities?.supports?.vision === true,
      reasoningEffort: model.capabilities?.supports?.reasoningEffort === true,
      ...(typeof maxPromptTokens !== "number" || maxPromptTokens <= 0
        ? {}
        : { maxPromptTokens }),
      ...(typeof maxContextWindowTokens !== "number" ||
      maxContextWindowTokens <= 0
        ? {}
        : { maxContextWindowTokens }),
    },
    supportedReasoningEfforts: (model.supportedReasoningEfforts ?? []).filter(
      (effort) => typeof effort === "string" && effort.length > 0,
    ),
    ...(typeof model.defaultReasoningEffort !== "string" ||
    model.defaultReasoningEffort.length === 0
      ? {}
      : { defaultReasoningEffort: model.defaultReasoningEffort }),
  };
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
      : [
          ...new Map(
            configuration.availableSkills.map((skill) => {
              const normalized = {
                name: skillNameSchema.parse(skill.name),
                description: skill.description.trim(),
                sourcePath: skill.sourcePath,
                fingerprint: skill.fingerprint,
              };
              if (normalized.description.length === 0) {
                throw new Error(
                  `Skill '${normalized.name}' requires a description`,
                );
              }

              if (normalized.sourcePath.length === 0) {
                throw new Error(
                  `Skill '${normalized.name}' requires a source path`,
                );
              }
              if (!/^[a-f0-9]{64}$/u.test(normalized.fingerprint)) {
                throw new Error(
                  `Skill '${normalized.name}' requires a valid fingerprint`,
                );
              }
              return [normalized.name, normalized] as const;
            }),
          ).values(),
        ];
  if (
    availableSkills !== undefined &&
    skills.some(
      (skill) =>
        !availableSkills.some(
          (availableSkill) => availableSkill.name === skill,
        ),
    )
  ) {
    throw new Error(
      `Configured skills must exist in the loaded skill catalog: ${skills
        .filter(
          (skill) =>
            !availableSkills.some(
              (availableSkill) => availableSkill.name === skill,
            ),
        )
        .join(", ")}`,
    );
  }
  if (skills.length > 0 && availableSkills === undefined) {
    throw new Error("Configured skills require the loaded skill catalog");
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
    productionSessionId: configuration.productionSessionId,
    definitionName: configuration.definitionName,
    label: configuration.label,
    ...(configuration.model === undefined
      ? {}
      : { model: configuration.model }),
    ...(configuration.reasoningEffort === undefined
      ? {}
      : {
          reasoningEffort: agentReasoningEffortSchema.parse(
            configuration.reasoningEffort,
          ),
        }),
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
    if (event.data.content.startsWith("<live-event-trigger ")) {
      return undefined;
    }
    const content = displayUserPrompt(event.data.content);
    if (content === "") return undefined;
    return {
      role: "user",
      content,
      timestamp: event.timestamp,
      eventId: event.id,
      ...(event.data.agentMode === "interactive" ||
      event.data.agentMode === "plan"
        ? { agentMode: event.data.agentMode }
        : {}),
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
  readonly #planArtifacts: FilePlanArtifactStore;

  public constructor(private readonly options: CopilotAgentServiceOptions) {
    this.#logger = options.logger ?? noopLogger;
    const storage = resolveLiveAgentStorage({ homeDirectory: homedir() });
    this.#planArtifacts = new FilePlanArtifactStore(
      options.resolvePlanArtifactPaths ??
        (() => {
          throw new Error(
            "Plan artifact storage requires a session ownership path resolver",
          );
        }),
    );
    this.#clientFactory =
      options.clientFactory ??
      (() =>
        new CopilotClient({
          mode: "empty",
          baseDirectory: options.baseDirectory ?? storage.copilotDirectory,
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
      ...(this.options.setHistoryQuery === undefined
        ? {}
        : { setHistoryQuery: this.options.setHistoryQuery }),
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
      fillArrangementRegion: this.options.fillArrangementRegion,
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
      if (binding.projectId !== status.liveSetId) {
        throw new AbletonMutationAuthorizationError(
          "binding_cross_project",
          `Track binding '${binding.expectedName}' belongs to Live Set ${binding.projectId}, not ${status.liveSetId}`,
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
        handler: async (args: unknown, invocation: ToolInvocation) => {
          if (state.activeAgentMode === "plan") {
            this.#recordRuntime(state, "agent.plan.mutation_blocked", {
              toolName: tool.name,
              arguments: args,
            });
            throw new AbletonMutationAuthorizationError(
              "plan_mode_read_only",
              "Plan mode is read-only. Finish the plan and request approval before changing Ableton.",
            );
          }
          return runAuthorizedAbletonMutation({
            authorizer: this.#mutationAuthorizer,
            lockManager: this.#mutationLockManager,
            getContext: () => this.#mutationContext(state),
            invocation: { toolName: tool.name, args },
            handler: () => Promise.resolve(handler(args, invocation)),
          });
        },
      };
    });
  }

  #defaultSessionConfiguration(): AgentSessionConfiguration {
    return {
      instanceId: DEFAULT_AGENT_INSTANCE_KEY,
      productionSessionId: DEFAULT_AGENT_INSTANCE_KEY,
      definitionName: DEFAULT_AGENT_DEFINITION_NAME,
      label: DEFAULT_AGENT_LABEL,
      description: DEFAULT_AGENT_DESCRIPTION,
      systemPrompt: DEFAULT_AGENT_PROMPT,
      resolvedTools: abletonToolMetadata.map(({ name }) => name),
      editScope: ["session"],
      boundTracks: [],
      skills: [],
      availableSkills: [],
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
      appliedReasoningSummary: undefined,
      unsubscribe: undefined,
      inFlightTurns: 0,
      queuedTurns: 0,
      turnQueue: Promise.resolve(),
      turnKind: undefined,
      activeAgentMode: undefined,
      preparedContextListener: undefined,
      activeTurn: undefined,
      automaticDrainScheduled: false,
      pendingAutomatic: new Map(),
      operations: new Map(),
      directPlanRequests: new Map(),
      elicitationRequests: new Map(),
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

  #publishWorkingUpdate(
    state: ManagedSessionState,
    update: AgentWorkingUpdate,
  ): void {
    this.options.events.publish({
      type: "agent.working_update",
      update,
      ...this.#eventAttribution(state),
    });
  }

  #finishWorkingTurn(
    state: ManagedSessionState,
    turn: InstrumentedTurn,
    outcome: Extract<AgentWorkingUpdate, { kind: "finished" }>["outcome"],
    occurredAt: string,
    detail?: string,
  ): void {
    if (turn.workingTerminalPublished) return;
    turn.workingTerminalPublished = true;
    const boundedDetail =
      detail === undefined
        ? undefined
        : boundedPlanText(detail, MAX_WORKING_CONTENT_LENGTH);
    this.#publishWorkingUpdate(state, {
      kind: "finished",
      activityId: turn.id,
      outcome,
      ...(boundedDetail === undefined ? {} : { detail: boundedDetail }),
      occurredAt,
    });
    this.#recordRuntime(
      state,
      `agent.working.${outcome}`,
      {
        activityId: turn.id,
        ...(boundedDetail === undefined ? {} : { detail: boundedDetail }),
        durationMs:
          turn.startedAt === undefined
            ? undefined
            : Date.now() - turn.startedAt,
      },
      {
        trace: turn.trace,
        ...(state.session?.sessionId === undefined
          ? {}
          : { sessionId: state.session.sessionId }),
      },
    );
  }

  #runtimeTrace(
    trace: MutableRuntimeTrace | undefined,
  ): AgentRuntimeTraceContext | undefined {
    if (trace === undefined) return undefined;
    return {
      traceId: trace.traceId,
      turnId: trace.turnId,
      occurrenceIds: [...trace.occurrenceIds],
      deliveryIds: [...trace.deliveryIds],
    };
  }

  #recordRuntime(
    state: ManagedSessionState,
    type: string,
    data: Readonly<Record<string, unknown>>,
    options: {
      occurredAt?: string;
      trace?: MutableRuntimeTrace | undefined;
      sessionId?: string;
    } = {},
  ): void {
    const observer = this.options.runtimeObserver;
    if (observer === undefined) return;
    try {
      const sessionId = options.sessionId ?? state.session?.sessionId;
      const trace = this.#runtimeTrace(
        options.trace ?? state.activeTurn?.trace,
      );
      observer.enqueue({
        type,
        occurredAt: options.occurredAt ?? new Date().toISOString(),
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(state.exposeInstanceId
          ? { agentInstanceId: state.configuration.instanceId }
          : {}),
        ...(trace === undefined ? {} : { trace }),
        data,
      });
    } catch (error) {
      this.#logger.warn("Runtime observer rejected an event", {
        type,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  #newTurn(
    origin: AgentPromptOrigin,
    prompt: string,
    identifiers: {
      traceId?: string;
      occurrenceIds?: readonly string[];
      deliveryIds?: readonly string[];
      agentMode?: AgentMode;
    } = {},
  ): InstrumentedTurn {
    const id = randomUUID();
    return {
      id,
      queuedAt: Date.now(),
      origin,
      prompt,
      finalObserved: false,
      startedAt: undefined,
      terminalRecorded: false,
      toolStarted: false,
      retryAttempted: false,
      workingTerminalPublished: false,
      timeout: undefined,
      ...(identifiers.agentMode === undefined
        ? {}
        : { agentMode: identifiers.agentMode }),
      trace: {
        traceId: identifiers.traceId ?? id,
        turnId: id,
        occurrenceIds: [...(identifiers.occurrenceIds ?? [])],
        deliveryIds: [...(identifiers.deliveryIds ?? [])],
      },
    };
  }

  #recordPromptContext(
    state: ManagedSessionState,
    origin: "live-event.next-prompt" | "output.next-prompt",
    prompt: string,
    occurrenceIds: readonly string[],
    deliveryIds: readonly string[],
  ): void {
    const turn = state.activeTurn;
    if (turn !== undefined) {
      turn.trace.occurrenceIds.push(
        ...occurrenceIds.filter(
          (identifier) => !turn.trace.occurrenceIds.includes(identifier),
        ),
      );
      turn.trace.deliveryIds.push(
        ...deliveryIds.filter(
          (identifier) => !turn.trace.deliveryIds.includes(identifier),
        ),
      );
    }
    this.#recordRuntime(
      state,
      "agent.prompt.context",
      { origin, prompt, occurrenceIds, deliveryIds },
      { trace: turn?.trace },
    );
  }

  #scopedSignalContext(
    state: ManagedSessionState,
  ): SignalContextOptions | undefined {
    const signalContext = this.options.signalContext;
    if (signalContext?.provider === undefined) return signalContext;
    return {
      ...signalContext,
      provider: {
        getPendingContexts: async () => {
          const contexts = await signalContext.provider!.getPendingContexts(
            state.signalTargetId,
          );
          for (const context of contexts) {
            this.#recordPromptContext(
              state,
              "output.next-prompt",
              context.context.content,
              [context.context.assignmentId],
              [context.deliveryId],
            );
          }
          return contexts;
        },
        markDelivered: async (...[, deliveryIds]) =>
          signalContext.provider!.markDelivered(
            state.signalTargetId,
            deliveryIds,
          ),
      },
    };
  }

  #scopedLiveEventContext(
    state: ManagedSessionState,
  ): LiveEventContextOptions | undefined {
    const liveEventContext = this.options.liveEventContext;
    if (liveEventContext?.provider === undefined) return liveEventContext;
    return {
      ...liveEventContext,
      provider: {
        getPendingLiveEventContexts: async () => {
          const contexts =
            await liveEventContext.provider!.getPendingLiveEventContexts(
              state.signalTargetId,
            );
          for (const context of contexts) {
            this.#recordPromptContext(
              state,
              "live-event.next-prompt",
              context.occurrence.summary,
              [context.occurrence.occurrenceId],
              [context.deliveryId],
            );
          }
          return contexts;
        },
        markLiveEventContextsDelivered: async (...[, deliveryIds]) =>
          liveEventContext.provider!.markLiveEventContextsDelivered(
            state.signalTargetId,
            deliveryIds,
          ),
      },
    };
  }

  async #readSkillBody(
    state: ManagedSessionState,
    skillName: string,
    requireEnabled: boolean,
  ): Promise<string> {
    if (requireEnabled && !state.configuration.skills.includes(skillName)) {
      throw new Error(
        `Skill '${skillName}' is not enabled for managed agent '${state.configuration.instanceId}'.`,
      );
    }
    const startedAt = Date.now();
    this.#recordRuntime(state, "agent.skill.read.queued", { skillName });
    this.#recordRuntime(state, "agent.skill.read.started", { skillName });
    try {
      const descriptor =
        this.options.resolveSkill === undefined
          ? state.configuration.availableSkills?.find(
              (skill) => skill.name === skillName,
            )
          : await this.options.resolveSkill(
              state.configuration.productionSessionId,
              skillName,
            );
      if (descriptor === undefined)
        throw new Error(`Unknown skill '/${skillName}'.`);
      const document = await readSkillDocument(
        descriptor.sourcePath,
        skillName,
      );
      if (document.fingerprint !== descriptor.fingerprint) {
        throw new Error(
          `Skill '${skillName}' changed while it was being loaded. Try again.`,
        );
      }
      this.#recordRuntime(state, "agent.skill.read.completed", {
        skillName,
        fingerprint: document.fingerprint,
        characters: document.body.length,
        durationMs: Date.now() - startedAt,
      });
      return document.body;
    } catch (error) {
      this.#recordRuntime(state, "agent.skill.read.failed", {
        skillName,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async #prepareSkillInvocation(
    state: ManagedSessionState,
    input: string | SkillInvocation,
  ): Promise<string> {
    const invocation =
      typeof input === "string" ? parseSkillInvocation(input) : input;
    if (invocation === undefined) {
      throw new Error(
        "Skill invocation must use /skill-name followed by an optional request.",
      );
    }
    const skillName = skillNameSchema.parse(invocation.skillName);
    const body = await this.#readSkillBody(state, skillName, false);
    return formatDirectSkillPrompt(skillName, body, invocation.request);
  }

  #skillTool(state: ManagedSessionState): Tool | undefined {
    if (state.configuration.skills.length === 0) return undefined;
    return defineTool(SKILL_TOOL_NAME, {
      description:
        "Loads the instructions for one skill enabled for the active agent. Call this when an enabled skill description is relevant to the current work.",
      parameters: z
        .object({
          skill_name: skillNameSchema.describe(
            "Name of a skill listed in the system skill instructions",
          ),
        })
        .strict(),
      handler: async ({ skill_name }) =>
        this.#readSkillBody(state, skill_name, true),
    }) as Tool;
  }

  #publishPlanArtifact(
    state: ManagedSessionState,
    artifact: PlanArtifactSnapshot,
  ): void {
    this.options.events.publish({
      type: "agent.plan_artifact_changed",
      artifact,
      ...this.#eventAttribution(state),
    });
  }

  #publishPlanApproval(
    state: ManagedSessionState,
    requestId: string,
    summary: string,
    actions: readonly AgentPlanExitAction[],
    recommendedAction: AgentPlanExitAction,
    artifact: Extract<PlanArtifactSnapshot, { exists: true }>,
  ): void {
    this.options.events.publish({
      type: "agent.plan_approval_requested",
      request: {
        requestId,
        summary,
        planContent: artifact.content,
        planRevision: artifact.revision,
        planUpdatedAt: artifact.updatedAt,
        recommendedAction,
        actions,
      },
      ...this.#eventAttribution(state),
    });
  }

  async #readPlanArtifact(
    state: ManagedSessionState,
  ): Promise<PlanArtifactSnapshot> {
    const startedAt = Date.now();
    this.#recordRuntime(state, "agent.plan.artifact.read.queued", {
      productionSessionId: state.configuration.productionSessionId,
    });
    this.#recordRuntime(state, "agent.plan.artifact.read.started", {
      productionSessionId: state.configuration.productionSessionId,
    });
    try {
      const artifact = await this.#planArtifacts.read(
        state.configuration.productionSessionId,
      );
      this.#recordRuntime(state, "agent.plan.artifact.read.completed", {
        productionSessionId: state.configuration.productionSessionId,
        exists: artifact.exists,
        ...(artifact.exists
          ? { revision: artifact.revision, bytes: artifact.bytes }
          : {}),
        durationMs: Date.now() - startedAt,
      });
      this.#publishPlanArtifact(state, artifact);
      return artifact;
    } catch (error) {
      this.#recordRuntime(state, "agent.plan.artifact.read.failed", {
        productionSessionId: state.configuration.productionSessionId,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async #writePlanArtifact(
    state: ManagedSessionState,
    input: PlanArtifactWrite,
  ): Promise<PlanArtifactSnapshot> {
    const startedAt = Date.now();
    this.#recordRuntime(state, "agent.plan.artifact.write.queued", {
      productionSessionId: state.configuration.productionSessionId,
      expectedRevision: input.expectedRevision,
    });
    this.#recordRuntime(state, "agent.plan.artifact.write.started", {
      productionSessionId: state.configuration.productionSessionId,
      expectedRevision: input.expectedRevision,
    });
    try {
      const artifact = await this.#planArtifacts.write(
        state.configuration.productionSessionId,
        input,
      );
      this.#recordRuntime(state, "agent.plan.artifact.write.completed", {
        productionSessionId: state.configuration.productionSessionId,
        ...(artifact.exists
          ? { revision: artifact.revision, bytes: artifact.bytes }
          : {}),
        durationMs: Date.now() - startedAt,
      });
      this.#publishPlanArtifact(state, artifact);
      if (artifact.exists) {
        for (const candidate of this.#states.values()) {
          if (
            candidate.configuration.productionSessionId !==
            state.configuration.productionSessionId
          ) {
            continue;
          }
          for (const [requestId, pending] of candidate.directPlanRequests) {
            pending.artifact = artifact;
            this.#publishPlanApproval(
              candidate,
              requestId,
              pending.summary,
              pending.actions,
              pending.recommendedAction,
              artifact,
            );
          }
        }
      }
      return artifact;
    } catch (error) {
      this.#recordRuntime(state, "agent.plan.artifact.write.failed", {
        productionSessionId: state.configuration.productionSessionId,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
        conflict: error instanceof PlanArtifactConflictError,
      });
      throw error;
    }
  }

  #planTools(state: ManagedSessionState): Tool[] {
    return [
      defineTool(READ_PLAN_TOOL_NAME, {
        description:
          "Read the shared plan.md for the current Ableton production session, including its revision for safe updates.",
        parameters: z.object({}).strict(),
        skipPermission: true,
        defer: "never",
        handler: async () => this.#readPlanArtifact(state),
      }) as Tool,
      defineTool(WRITE_PLAN_TOOL_NAME, {
        description:
          "Create or replace the shared plan.md for the current Ableton production session. Read the existing plan first and pass expected_revision when updating it.",
        parameters: z
          .object({
            content: z.string().min(1).max(MAX_PLAN_CONTENT_LENGTH),
            expected_revision: z
              .string()
              .regex(/^[a-f0-9]{64}$/u)
              .optional(),
          })
          .strict(),
        skipPermission: true,
        defer: "never",
        handler: async ({ content, expected_revision }) =>
          this.#writePlanArtifact(state, {
            content,
            ...(expected_revision === undefined
              ? {}
              : { expectedRevision: expected_revision }),
          }),
      }) as Tool,
    ];
  }

  #requestElicitation(
    state: ManagedSessionState,
    context: ElicitationContext,
    options: { allowChoiceFreeform?: boolean } = {},
  ): Promise<ElicitationResult> {
    if (context.mode === "url") {
      return Promise.resolve({ action: "cancel" });
    }
    const requestId = randomUUID();
    const request = elicitationRequest(requestId, context, options);
    const sessionId = state.session?.sessionId ?? context.sessionId;
    const startedAt = Date.now();
    this.#recordRuntime(
      state,
      "agent.elicitation.requested",
      { requestId, request },
      { sessionId },
    );
    this.options.events.publish({
      type: "agent.elicitation_requested",
      request,
      ...this.#eventAttribution(state),
    });
    const resumeTimeout = this.#pauseActiveTurnTimeout(
      state,
      "elicitation",
      requestId,
    );
    return new Promise<ElicitationResult>((resolve) => {
      state.elicitationRequests.set(requestId, {
        sessionId,
        startedAt,
        request,
        resolve: (result) => {
          resumeTimeout();
          resolve(result);
        },
      });
    });
  }

  #pauseActiveTurnTimeout(
    state: ManagedSessionState,
    reason: HumanGateReason,
    requestId: string,
  ): () => void {
    const turn = state.activeTurn;
    const timeout = turn?.timeout;
    if (turn === undefined || timeout === undefined) return () => undefined;
    const paused = timeout.pause(reason, requestId);
    if (paused === undefined) return () => undefined;
    this.#recordRuntime(
      state,
      "agent.turn.timeout.paused",
      {
        reason,
        requestId,
        timeoutMs: timeout.timeoutMs,
        remainingMs: paused.remainingMs,
        pendingHumanGateCount: paused.pendingHumanGateCount,
        timerPaused: paused.timerPaused,
      },
      {
        trace: turn.trace,
        ...(state.session?.sessionId === undefined
          ? {}
          : { sessionId: state.session.sessionId }),
      },
    );
    let resumed = false;
    return () => {
      if (resumed) return;
      resumed = true;
      const result = timeout.resume(paused.pause.token);
      if (result === undefined) return;
      this.#recordRuntime(
        state,
        "agent.turn.timeout.resumed",
        {
          reason,
          requestId,
          timeoutMs: timeout.timeoutMs,
          remainingMs: result.remainingMs,
          pendingHumanGateCount: result.pendingHumanGateCount,
          humanWaitDurationMs: result.humanWaitDurationMs,
          timerResumed: result.timerResumed,
        },
        {
          trace: turn.trace,
          ...(state.session?.sessionId === undefined
            ? {}
            : { sessionId: state.session.sessionId }),
        },
      );
    };
  }

  #cancelActiveTurnTimeout(
    state: ManagedSessionState,
    cancellationReason: string,
  ): void {
    const turn = state.activeTurn;
    const timeout = turn?.timeout;
    if (turn === undefined || timeout === undefined) return;
    const cancelled = timeout.cancel();
    turn.timeout = undefined;
    if (cancelled === undefined) return;
    for (const [index, pause] of cancelled.pauses.entries()) {
      this.#recordRuntime(
        state,
        "agent.turn.timeout.cancelled",
        {
          reason: pause.reason,
          requestId: pause.requestId,
          cancellationReason,
          timeoutMs: timeout.timeoutMs,
          remainingMs: cancelled.remainingMs,
          pendingHumanGateCount: cancelled.pauses.length - index - 1,
          humanWaitDurationMs: Date.now() - pause.startedAt,
        },
        {
          trace: turn.trace,
          ...(state.session?.sessionId === undefined
            ? {}
            : { sessionId: state.session.sessionId }),
        },
      );
    }
  }

  async #requestLegacyUserInput(
    state: ManagedSessionState,
    request: SdkUserInputRequest,
    sessionId: string,
  ): Promise<SdkUserInputResponse> {
    const choices = [
      ...new Set(
        (request.choices ?? [])
          .map((choice) =>
            boundedPlanText(choice.trim(), MAX_PLAN_SUMMARY_LENGTH),
          )
          .filter((choice) => choice.length > 0),
      ),
    ].slice(0, 32);
    const result = await this.#requestElicitation(
      state,
      {
        sessionId,
        mode: "form",
        elicitationSource: "copilot-sdk:ask_user",
        message: boundedPlanText(request.question, MAX_PLAN_SUMMARY_LENGTH),
        requestedSchema: {
          type: "object",
          properties: {
            answer: {
              type: "string",
              title: "Answer",
              ...(choices.length === 0
                ? { minLength: 1, maxLength: MAX_PLAN_FEEDBACK_LENGTH }
                : { enum: choices }),
            },
          },
          required: ["answer"],
        },
      },
      {
        allowChoiceFreeform: choices.length > 0,
      },
    );
    if (result.action !== "accept") {
      throw new Error(
        result.action === "decline"
          ? "User declined the ask_user request"
          : "User cancelled the ask_user request",
      );
    }
    const answer = result.content?.answer;
    if (typeof answer !== "string") {
      throw new Error("ask_user completed without a text answer");
    }
    return {
      answer,
      wasFreeform: choices.length === 0 || !choices.includes(answer),
    };
  }

  #sessionConfig(state: ManagedSessionState): SessionConfig {
    const skillTool = this.#skillTool(state);
    const tools = [
      ...this.#scopedAbletonTools(state),
      ...this.#planTools(state),
      ...(skillTool === undefined ? [] : [skillTool]),
    ];
    const configuredToolNames = dedupeStrings([
      ...bareToolNames(state.configuration.resolvedTools).filter(
        (name) => name !== SKILL_TOOL_NAME,
      ),
      SET_SQL_SEARCH_TOOL_NAME,
      READ_PLAN_TOOL_NAME,
      WRITE_PLAN_TOOL_NAME,
      ...(skillTool === undefined ? [] : [SKILL_TOOL_NAME]),
    ]);
    const skillInstructions = formatSkillSystemInstructions(
      enabledSkillDescriptors(state.configuration),
    );
    const scopedSignalContext = this.#scopedSignalContext(state);
    const scopedLiveEventContext = this.#scopedLiveEventContext(state);
    const agentPolicy = createAgentPolicy({
      getAbletonStatus: this.options.getAbletonStatus,
      inspectSession: this.options.inspectSession,
      ...(this.options.preparedContextProvider === undefined
        ? {}
        : {
            preparedContext: {
              getPreparedContext: (listener?: AgentEventListener) =>
                this.options.preparedContextProvider!.getPreparedContext(
                  state.signalTargetId,
                  listener,
                ),
              activeListener: () => state.preparedContextListener,
            },
          }),
      ...(scopedSignalContext === undefined
        ? {}
        : { signalContext: scopedSignalContext }),
      ...(scopedLiveEventContext === undefined
        ? {}
        : { liveEventContext: scopedLiveEventContext }),
      promptContextEnabled: () => state.turnKind === "user",
      mutationBlocked: () =>
        state.turnKind === "automatic-analysis" ||
        state.activeAgentMode === "plan",
      mutationBlockReason: () =>
        state.activeAgentMode === "plan"
          ? "Plan mode is read-only. Inspect as needed, finish the plan, and request approval before using mutation tools."
          : state.turnKind === "automatic-analysis"
            ? "Automatic analysis turns may inspect Ableton but cannot use mutation tools."
            : undefined,
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
    const model = state.exposeInstanceId
      ? state.configuration.model
      : this.options.model;
    const reasoningEffort = state.exposeInstanceId
      ? state.configuration.reasoningEffort
      : this.options.reasoningEffort;
    const configuredReasoningSummary = this.options.reasoningSummary;
    const reasoningSummary =
      typeof configuredReasoningSummary === "function"
        ? configuredReasoningSummary()
        : (configuredReasoningSummary ?? "concise");
    const historyGuidance = configuredToolNames.includes("set_sql_search")
      ? "\n\nFor questions about prior Live Sets, saves, devices, clips, or agent trajectories, use set_sql_search against the local read-only Set History views. Treat it as historical evidence and inspect the current Live Set before acting."
      : "";
    const config: SessionConfig = {
      clientName: "ableton-agent-app",
      ...(model === undefined ? {} : { model }),
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      reasoningSummary,
      streaming: true,
      tools,
      availableTools: qualifyAvailableTools(configuredToolNames),
      toolSearch: { enabled: false },
      customAgents: [
        {
          name: state.configuration.definitionName,
          displayName: state.configuration.label,
          description: state.configuration.description,
          prompt: `${state.configuration.systemPrompt}${historyGuidance}`,
          infer: false,
        },
      ],
      agent: state.configuration.definitionName,
      onPermissionRequest: async (request, invocation) => {
        const permissionId =
          ("toolCallId" in request ? request.toolCallId : undefined) ??
          randomUUID();
        this.#recordRuntime(state, "agent.permission.requested", {
          permissionId,
          request,
          invocation,
        });
        let result;
        if (
          request.kind === "custom-tool" &&
          [SKILL_TOOL_NAME, READ_PLAN_TOOL_NAME, WRITE_PLAN_TOOL_NAME].includes(
            request.toolName,
          )
        ) {
          result = { kind: "approve-once" } as const;
        } else {
          const resumeTimeout = this.#pauseActiveTurnTimeout(
            state,
            "tool_approval",
            permissionId,
          );
          try {
            result = await permissionHandler(request, invocation);
          } catch (error) {
            this.#recordRuntime(state, "agent.permission.failed", {
              permissionId,
              request,
              error: error instanceof Error ? error.message : String(error),
            });
            throw error;
          } finally {
            resumeTimeout();
          }
        }
        if (result.kind === "reject" && request.kind === "custom-tool") {
          agentPolicy.blockAttempt(
            request.toolName,
            request.args ?? {},
            "Do not retry or rephrase this denied operation. Wait for a new user request.",
          );
        }
        this.#recordRuntime(state, "agent.permission.completed", {
          permissionId,
          request,
          result,
        });
        return result;
      },
      askUserVariant: "elicitation",
      onUserInputRequest: (request, invocation) =>
        this.#requestLegacyUserInput(state, request, invocation.sessionId),
      onElicitationRequest: (context) =>
        this.#requestElicitation(state, context),
      hooks: agentPolicy.hooks,
      onExitPlanModeRequest: async (request) => {
        const artifact = await this.#readPlanArtifact(state);
        if (!artifact.exists || artifact.content.trim().length === 0) {
          this.#recordRuntime(state, "agent.plan.approval.failed", {
            reason: "plan_artifact_missing",
            productionSessionId: state.configuration.productionSessionId,
          });
          return {
            approved: false,
            feedback:
              "The shared plan.md is missing or empty. Write the complete plan with write_plan, then call exit_plan_mode again.",
          };
        }
        const requestId = randomUUID();
        const actions = request.actions.filter(
          (action): action is AgentPlanExitAction =>
            action === "interactive" || action === "exit_only",
        );
        if (actions.length === 0) actions.push("exit_only");
        const recommendedAction = actions.includes(
          request.recommendedAction as AgentPlanExitAction,
        )
          ? (request.recommendedAction as AgentPlanExitAction)
          : actions.includes("interactive")
            ? "interactive"
            : "exit_only";
        const sessionId = state.session?.sessionId ?? "";
        const summary = boundedPlanText(
          request.summary,
          MAX_PLAN_SUMMARY_LENGTH,
        );
        const resumeTimeout = this.#pauseActiveTurnTimeout(
          state,
          "plan_approval",
          requestId,
        );
        const response = new Promise<{
          approved: boolean;
          selectedAction?: AgentPlanExitAction;
          feedback?: string;
        }>((resolve) => {
          state.directPlanRequests.set(requestId, {
            sessionId,
            productionSessionId: state.configuration.productionSessionId,
            artifact,
            summary,
            actions,
            recommendedAction,
            resolve: (result) => {
              resumeTimeout();
              resolve(result);
            },
          });
        });
        this.#recordRuntime(
          state,
          "agent.plan.approval.requested",
          {
            requestId,
            summary,
            planRevision: artifact.revision,
            planBytes: artifact.bytes,
            recommendedAction,
            actions,
          },
          { sessionId },
        );
        this.#publishPlanApproval(
          state,
          requestId,
          summary,
          actions,
          recommendedAction,
          artifact,
        );
        return await response;
      },
      systemMessage: {
        content:
          skillInstructions === undefined
            ? BASE_SYSTEM_MESSAGE
            : `${BASE_SYSTEM_MESSAGE}\n\n${skillInstructions}`,
      },
    };
    return config;
  }

  #recordSessionConfiguration(
    state: ManagedSessionState,
    config: SessionConfig,
    sessionId: string,
  ): void {
    const configuredToolNames = new Set([
      ...bareToolNames(state.configuration.resolvedTools).filter(
        (name) => name !== SKILL_TOOL_NAME,
      ),
      SET_SQL_SEARCH_TOOL_NAME,
      READ_PLAN_TOOL_NAME,
      WRITE_PLAN_TOOL_NAME,
      ...(state.configuration.skills.length === 0 ? [] : [SKILL_TOOL_NAME]),
    ]);
    const tools = config.tools as readonly Tool[];
    this.#recordRuntime(
      state,
      "agent.session.configuration",
      {
        sdkSystemMessage: config.systemMessage,
        customAgentPrompt: state.configuration.systemPrompt,
        customAgent: config.customAgents?.[0],
        skills: enabledSkillDescriptors(state.configuration).map((skill) => ({
          name: skill.name,
          description: skill.description,
          sourcePath: skill.sourcePath,
          fingerprint: skill.fingerprint,
        })),
        model: config.model,
        reasoningEffort: config.reasoningEffort,
        reasoningSummary: config.reasoningSummary,
        streaming: config.streaming,
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameterSchema: toolParameterSchema(tool),
          available: configuredToolNames.has(tool.name),
        })),
        availableTools: config.availableTools,
      },
      { sessionId },
    );
  }

  #observe(state: ManagedSessionState, session: CopilotSessionAdapter): void {
    state.unsubscribe?.();
    state.unsubscribe = session.on((event) => {
      if (this.#states.get(state.key) !== state) return;
      const structuredToolFailure =
        event.type === "tool.execution_complete" && !event.data.success
          ? parseAbletonToolFailure(event.data.error?.message)
          : undefined;
      const sdkData = {
        ...event.data,
        ...(structuredToolFailure === undefined
          ? {}
          : { structuredFailure: structuredToolFailure }),
        sdkEventId: event.id,
        parentSdkEventId: event.parentId,
      };
      if (
        event.type === "assistant.message_start" ||
        event.type === "assistant.turn_start"
      ) {
        this.#recordRuntime(state, "agent.assistant.started", sdkData, {
          occurredAt: event.timestamp,
          sessionId: session.sessionId,
        });
      } else if (event.type === "assistant.message_delta") {
        this.#recordRuntime(state, "agent.assistant.delta", sdkData, {
          occurredAt: event.timestamp,
          sessionId: session.sessionId,
        });
      } else if (event.type === "assistant.intent") {
        this.#recordRuntime(state, "agent.assistant.intent", sdkData, {
          occurredAt: event.timestamp,
          sessionId: session.sessionId,
        });
      } else if (event.type === "assistant.reasoning_delta") {
        this.#recordRuntime(state, "agent.assistant.reasoning.delta", sdkData, {
          occurredAt: event.timestamp,
          sessionId: session.sessionId,
        });
      } else if (event.type === "assistant.reasoning") {
        this.#recordRuntime(state, "agent.assistant.reasoning.final", sdkData, {
          occurredAt: event.timestamp,
          sessionId: session.sessionId,
        });
      } else if (event.type === "assistant.streaming_delta") {
        this.#recordRuntime(state, "agent.assistant.stream.progress", sdkData, {
          occurredAt: event.timestamp,
          sessionId: session.sessionId,
        });
      } else if (event.type === "assistant.server_tool_progress") {
        this.#recordRuntime(state, "agent.server_tool.progress", sdkData, {
          occurredAt: event.timestamp,
          sessionId: session.sessionId,
        });
      } else if (
        event.type === "assistant.fusion_phase_started" ||
        event.type === "assistant.fusion_phase_activity" ||
        event.type === "assistant.fusion_phase_completed" ||
        event.type === "assistant.fusion_phase_failed"
      ) {
        this.#recordRuntime(
          state,
          `agent.${event.type.replaceAll("_", ".")}`,
          sdkData,
          {
            occurredAt: event.timestamp,
            sessionId: session.sessionId,
          },
        );
      } else if (event.type === "assistant.turn_end") {
        this.#recordRuntime(state, "agent.assistant.completed", sdkData, {
          occurredAt: event.timestamp,
          sessionId: session.sessionId,
        });
      } else if (event.type === "assistant.message") {
        if (state.activeTurn !== undefined) {
          state.activeTurn.finalObserved = true;
        }
        this.#recordRuntime(state, "agent.assistant.final", sdkData, {
          occurredAt: event.timestamp,
          sessionId: session.sessionId,
        });
      } else if (event.type === "tool.execution_start") {
        if (state.activeTurn !== undefined) state.activeTurn.toolStarted = true;
        this.#recordRuntime(state, "agent.tool.started", sdkData, {
          occurredAt: event.timestamp,
          sessionId: session.sessionId,
        });
      } else if (event.type === "tool.execution_progress") {
        this.#recordRuntime(state, "agent.tool.progress", sdkData, {
          occurredAt: event.timestamp,
          sessionId: session.sessionId,
        });
      } else if (event.type === "tool.execution_partial_result") {
        this.#recordRuntime(state, "agent.tool.partial", sdkData, {
          occurredAt: event.timestamp,
          sessionId: session.sessionId,
        });
      } else if (event.type === "tool.execution_complete") {
        const operation = state.operations.get(event.data.toolCallId);
        this.#recordRuntime(
          state,
          event.data.success ? "agent.tool.completed" : "agent.tool.failed",
          {
            ...sdkData,
            arguments: operation?.arguments,
            durationMs:
              operation === undefined
                ? undefined
                : Date.parse(event.timestamp) - operation.startedAt,
          },
          { occurredAt: event.timestamp, sessionId: session.sessionId },
        );
      } else if (event.type === "permission.requested") {
        this.#recordRuntime(state, "agent.permission.requested", sdkData, {
          occurredAt: event.timestamp,
          sessionId: session.sessionId,
        });
      } else if (event.type === "permission.completed") {
        this.#recordRuntime(state, "agent.permission.completed", sdkData, {
          occurredAt: event.timestamp,
          sessionId: session.sessionId,
        });
      } else if (event.type === "model.call_failure") {
        this.#recordRuntime(state, "agent.model.failed", sdkData, {
          occurredAt: event.timestamp,
          sessionId: session.sessionId,
        });
      } else if (event.type === "abort") {
        this.#recordRuntime(state, "agent.turn.aborted", sdkData, {
          occurredAt: event.timestamp,
          sessionId: session.sessionId,
        });
      } else if (
        event.type === "session.mode_changed" ||
        event.type === "session.plan_changed" ||
        event.type === "exit_plan_mode.requested" ||
        event.type === "exit_plan_mode.completed"
      ) {
        this.#recordRuntime(
          state,
          `agent.${event.type.replaceAll("_", ".")}`,
          sdkData,
          {
            occurredAt: event.timestamp,
            sessionId: session.sessionId,
          },
        );
      }
      const activeTurn =
        event.agentId === undefined ? state.activeTurn : undefined;
      if (event.type === "assistant.message_delta") {
        this.options.events.publish({
          type: "agent.message_delta",
          content: event.data.deltaContent,
          ...this.#eventAttribution(state),
        });
      } else if (
        event.type === "assistant.intent" &&
        activeTurn !== undefined
      ) {
        this.#publishWorkingUpdate(state, {
          kind: "intent",
          activityId: activeTurn.id,
          content: boundedPlanText(
            event.data.intent,
            MAX_WORKING_CONTENT_LENGTH,
          ),
          occurredAt: event.timestamp,
        });
      } else if (
        event.type === "assistant.reasoning_delta" &&
        activeTurn !== undefined
      ) {
        this.#publishWorkingUpdate(state, {
          kind: "reasoning_delta",
          activityId: activeTurn.id,
          reasoningId: event.data.reasoningId,
          content: boundedPlanText(
            event.data.deltaContent,
            MAX_WORKING_CONTENT_LENGTH,
          ),
          occurredAt: event.timestamp,
        });
      } else if (
        event.type === "assistant.reasoning" &&
        activeTurn !== undefined
      ) {
        this.#publishWorkingUpdate(state, {
          kind: "reasoning_complete",
          activityId: activeTurn.id,
          reasoningId: event.data.reasoningId,
          content: boundedPlanText(
            event.data.content,
            MAX_WORKING_CONTENT_LENGTH,
          ),
          occurredAt: event.timestamp,
        });
      } else if (
        event.type === "assistant.streaming_delta" &&
        activeTurn !== undefined
      ) {
        this.#publishWorkingUpdate(state, {
          kind: "streaming",
          activityId: activeTurn.id,
          totalResponseSizeBytes: event.data.totalResponseSizeBytes,
          occurredAt: event.timestamp,
        });
      } else if (
        event.type === "assistant.server_tool_progress" &&
        activeTurn !== undefined
      ) {
        this.#publishWorkingUpdate(state, {
          kind: "intent",
          activityId: activeTurn.id,
          content: boundedPlanText(
            `${event.data.kind.replaceAll("_", " ")}: ${event.data.status.replaceAll("_", " ")}`,
            MAX_WORKING_CONTENT_LENGTH,
          ),
          occurredAt: event.timestamp,
        });
      } else if (
        event.type === "assistant.fusion_phase_activity" &&
        activeTurn !== undefined
      ) {
        this.#publishWorkingUpdate(state, {
          kind: "intent",
          activityId: activeTurn.id,
          content: boundedPlanText(
            `${event.data.role}: ${event.data.activity.replaceAll("_", " ")}`,
            MAX_WORKING_CONTENT_LENGTH,
          ),
          occurredAt: event.timestamp,
        });
      } else if (
        event.type === "assistant.turn_end" &&
        activeTurn !== undefined
      ) {
        this.#finishWorkingTurn(
          state,
          activeTurn,
          "completed",
          event.timestamp,
        );
      } else if (
        event.type === "model.call_failure" &&
        activeTurn !== undefined
      ) {
        this.#finishWorkingTurn(
          state,
          activeTurn,
          "failed",
          event.timestamp,
          event.data.errorMessage,
        );
      } else if (event.type === "abort" && activeTurn !== undefined) {
        this.#finishWorkingTurn(
          state,
          activeTurn,
          "cancelled",
          event.timestamp,
          event.data.reason,
        );
      } else if (event.type === "tool.execution_start") {
        const metadata = abletonToolMetadata.find(
          (candidate) => candidate.name === event.data.toolName,
        );
        const label = metadata?.title ?? event.data.toolName;
        state.operations.set(event.data.toolCallId, {
          label,
          toolName: event.data.toolName,
          mutates: metadata !== undefined && metadata.mutationTarget !== "read",
          arguments: recordValue(event.data.arguments),
          startedAt: Date.parse(event.timestamp),
        });
        this.#logger.debug("Agent tool started", {
          sessionId: session.sessionId,
          ...(state.exposeInstanceId
            ? { instanceId: state.configuration.instanceId }
            : {}),
          operationId: event.data.toolCallId,
          toolName: event.data.toolName,
          arguments: recordValue(event.data.arguments),
        });
        this.options.events.publish({
          type: "operation.started",
          operationId: event.data.toolCallId,
          label,
          toolName: event.data.toolName,
          arguments: recordValue(event.data.arguments),
          ...this.#eventAttribution(state),
        });
      } else if (event.type === "tool.execution_complete") {
        const operation = state.operations.get(event.data.toolCallId);
        const label = operation?.label ?? "Tool operation";
        const exposeResult = operation?.toolName !== SKILL_TOOL_NAME;
        state.operations.delete(event.data.toolCallId);
        if (event.data.success) {
          this.#logger.debug("Agent tool completed", {
            sessionId: session.sessionId,
            ...(state.exposeInstanceId
              ? { instanceId: state.configuration.instanceId }
              : {}),
            operationId: event.data.toolCallId,
            toolName: operation?.toolName,
            ...(exposeResult ? { result: event.data.result?.content } : {}),
          });
          this.options.events.publish({
            type: "operation.completed",
            operationId: event.data.toolCallId,
            summary: `${label} completed`,
            ...(operation === undefined
              ? {}
              : { toolName: operation.toolName }),
            ...(!exposeResult || event.data.result?.content === undefined
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
            error: structuredToolFailure ?? event.data.error,
          });
          this.options.events.publish({
            type: "operation.failed",
            operationId: event.data.toolCallId,
            code:
              structuredToolFailure?.code ??
              event.data.error?.code ??
              "tool_failed",
            message:
              structuredToolFailure?.message ??
              event.data.error?.message ??
              `${label} failed`,
            retryable: structuredToolFailure?.retryable ?? false,
            ...(structuredToolFailure === undefined
              ? {}
              : { details: structuredToolFailure.details }),
            ...(operation === undefined
              ? {}
              : { toolName: operation.toolName }),
            ...this.#eventAttribution(state),
          });
        }
      } else if (
        event.type === "session.mode_changed" &&
        (event.data.newMode === "interactive" ||
          event.data.newMode === "plan") &&
        (event.data.previousMode === "interactive" ||
          event.data.previousMode === "plan")
      ) {
        state.activeAgentMode = event.data.newMode;
        this.options.events.publish({
          type: "agent.mode_changed",
          previousMode: event.data.previousMode,
          mode: event.data.newMode,
          ...this.#eventAttribution(state),
        });
      } else if (event.type === "session.plan_changed") {
        this.options.events.publish({
          type: "agent.plan_changed",
          operation: event.data.operation,
          ...this.#eventAttribution(state),
        });
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

  #cancelPendingPlans(state: ManagedSessionState, reason: string): void {
    for (const [requestId, pending] of state.directPlanRequests) {
      pending.resolve({ approved: false });
      this.#recordRuntime(
        state,
        "agent.plan.resolution.cancelled",
        { requestId, reason },
        { sessionId: pending.sessionId },
      );
      this.options.events.publish({
        type: "agent.plan_approval_completed",
        requestId,
        approved: false,
        ...this.#eventAttribution(state),
      });
    }
    state.directPlanRequests.clear();
  }

  #cancelPendingElicitations(state: ManagedSessionState, reason: string): void {
    for (const [requestId, pending] of state.elicitationRequests) {
      pending.resolve({ action: "cancel" });
      this.#recordRuntime(
        state,
        "agent.elicitation.cancelled",
        {
          requestId,
          reason,
          durationMs: Date.now() - pending.startedAt,
        },
        { sessionId: pending.sessionId },
      );
      this.options.events.publish({
        type: "agent.elicitation_completed",
        requestId,
        action: "cancel",
        ...this.#eventAttribution(state),
      });
    }
    state.elicitationRequests.clear();
  }

  async #disconnectState(
    state: ManagedSessionState,
    options: { removeFromRegistry?: boolean; reason?: unknown } = {},
  ): Promise<void> {
    this.#cancelActiveTurnTimeout(state, "session_disconnected");
    state.unsubscribe?.();
    state.unsubscribe = undefined;
    state.turnKind = undefined;
    state.activeAgentMode = undefined;
    state.preparedContextListener = undefined;
    state.activeTurn = undefined;
    state.inFlightTurns = 0;
    state.queuedTurns = 0;
    state.operations.clear();
    this.#cancelPendingPlans(state, "session_disconnected");
    this.#cancelPendingElicitations(state, "session_disconnected");
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
    const config = this.#sessionConfig(state);
    const session = await this.#requireClient().createSession(config);
    state.session = session;
    state.appliedReasoningSummary = config.reasoningSummary;
    this.#recordSessionConfiguration(state, config, session.sessionId);
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
    const config = this.#sessionConfig(state);
    const session = await this.#requireClient().resumeSession(
      sdkSessionId,
      config,
    );
    try {
      await session.getEvents?.();
    } catch (error) {
      let cleanupError: unknown;
      try {
        await session.disconnect();
      } catch (disconnectError) {
        cleanupError = disconnectError;
      }
      if (isMissingCopilotSessionError(error)) {
        throw new MissingCopilotSessionError(sdkSessionId, {
          cause: error,
          cleanupError,
        });
      }
      if (cleanupError !== undefined) {
        throw new AggregateError(
          [error, cleanupError],
          "Copilot resumed-session validation failed and cleanup was incomplete",
        );
      }
      throw error;
    }
    state.session = session;
    state.appliedReasoningSummary = config.reasoningSummary;
    this.#recordSessionConfiguration(state, config, session.sessionId);
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

  async #refreshDynamicSessionConfiguration(
    state: ManagedSessionState,
    turn: InstrumentedTurn,
  ): Promise<void> {
    const config = this.#sessionConfig(state);
    if (state.appliedReasoningSummary === config.reasoningSummary) return;
    const current = state.session;
    if (current === undefined) {
      throw new Error(
        state.exposeInstanceId
          ? `Managed agent '${state.configuration.instanceId}' is not active`
          : "Copilot agent service is not started",
      );
    }
    const startedAt = Date.now();
    this.#recordRuntime(
      state,
      "agent.session.reconfiguration.started",
      {
        reason: "reasoning_summary_changed",
        previousReasoningSummary: state.appliedReasoningSummary,
        reasoningSummary: config.reasoningSummary,
      },
      { trace: turn.trace, sessionId: current.sessionId },
    );
    let replacement: CopilotSessionAdapter | undefined;
    try {
      replacement = await this.#requireClient().resumeSession(
        current.sessionId,
        config,
      );
      await replacement.getEvents?.();
      state.unsubscribe?.();
      state.unsubscribe = undefined;
      await current.disconnect();
      state.session = replacement;
      state.appliedReasoningSummary = config.reasoningSummary;
      this.#recordSessionConfiguration(state, config, replacement.sessionId);
      this.#observe(state, replacement);
      this.#recordRuntime(
        state,
        "agent.session.reconfiguration.completed",
        {
          reason: "reasoning_summary_changed",
          reasoningSummary: config.reasoningSummary,
          durationMs: Date.now() - startedAt,
        },
        { trace: turn.trace, sessionId: replacement.sessionId },
      );
    } catch (error) {
      let reconfigurationError = error;
      if (replacement !== undefined && state.session !== replacement) {
        try {
          await replacement.disconnect();
        } catch (cleanupError) {
          reconfigurationError = new AggregateError(
            [reconfigurationError, cleanupError],
            "Copilot session reconfiguration and cleanup failed",
          );
        }
      }
      if (state.session === current && state.unsubscribe === undefined) {
        this.#observe(state, current);
      }
      this.#recordRuntime(
        state,
        "agent.session.reconfiguration.failed",
        {
          reason: "reasoning_summary_changed",
          reasoningSummary: config.reasoningSummary,
          error:
            reconfigurationError instanceof Error
              ? reconfigurationError.message
              : String(reconfigurationError),
          durationMs: Date.now() - startedAt,
        },
        { trace: turn.trace, sessionId: current.sessionId },
      );
      throw reconfigurationError;
    }
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
    previous.activeAgentMode = undefined;
    previous.inFlightTurns = 0;
    previous.queuedTurns = 0;
    previous.operations.clear();
    this.#cancelActiveTurnTimeout(previous, "session_replaced");
    this.#cancelPendingPlans(previous, "session_replaced");
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
    const turn = state.activeTurn;
    if (turn !== undefined) {
      turn.terminalRecorded = true;
      this.#finishWorkingTurn(
        state,
        turn,
        "failed",
        new Date().toISOString(),
        `Active work exceeded ${timeoutMs} ms`,
      );
    }
    this.#recordRuntime(
      state,
      "agent.turn.timeout",
      { timeoutMs },
      { trace: turn?.trace, sessionId: session.sessionId },
    );
    state.unsubscribe?.();
    state.unsubscribe = undefined;
    for (const [operationId, operation] of state.operations) {
      const code = operation.mutates
        ? "applied_indeterminate"
        : "operation_timeout";
      const message = operation.mutates
        ? `${operation.label} may have changed Ableton before the Copilot turn timed out; inspect the affected state before retrying`
        : `${operation.label} cancelled because the Copilot turn timed out`;
      this.#recordRuntime(
        state,
        "agent.tool.failed",
        {
          toolCallId: operationId,
          toolName: operation.toolName,
          arguments: operation.arguments,
          code,
          message,
          outcome: operation.mutates ? "applied_indeterminate" : "timed_out",
          requiresReinspection: operation.mutates,
          durationMs: Date.now() - operation.startedAt,
        },
        { trace: turn?.trace, sessionId: session.sessionId },
      );
      this.options.events.publish({
        type: "operation.failed",
        operationId,
        code,
        message,
        toolName: operation.toolName,
        ...this.#eventAttribution(state),
      });
    }
    state.operations.clear();

    let abortError: unknown;
    this.#recordRuntime(
      state,
      "agent.abort.requested",
      { reason: "timeout" },
      { trace: turn?.trace, sessionId: session.sessionId },
    );
    try {
      this.#cancelPendingPlans(state, "turn_timed_out");
      this.#cancelPendingElicitations(state, "turn_timed_out");
      await session.abort();
      this.#recordRuntime(
        state,
        "agent.abort.completed",
        { reason: "timeout" },
        { trace: turn?.trace, sessionId: session.sessionId },
      );
    } catch (error) {
      abortError = error;
      this.#recordRuntime(
        state,
        "agent.abort.failed",
        {
          reason: "timeout",
          error: error instanceof Error ? error.message : String(error),
        },
        { trace: turn?.trace, sessionId: session.sessionId },
      );
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

  public async listModels(): Promise<readonly AgentModelDescriptor[]> {
    const client = this.#requireClient();
    const listModels = client.listModels?.bind(client);
    if (listModels === undefined) {
      throw new Error(
        "Configured Copilot client does not support model discovery",
      );
    }
    return (await listModels())
      .filter(({ id }) => id !== "auto")
      .map(toAgentModelDescriptor);
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
    this.#recordRuntime(state, "agent.abort.requested", {
      reason: "user",
    });
    try {
      this.#cancelActiveTurnTimeout(state, "user_cancelled");
      this.#cancelPendingPlans(state, "user_cancelled");
      this.#cancelPendingElicitations(state, "user_cancelled");
      await session.abort();
      if (state.activeTurn !== undefined) {
        this.#finishWorkingTurn(
          state,
          state.activeTurn,
          "cancelled",
          new Date().toISOString(),
          "Cancelled by user",
        );
      }
      this.#recordRuntime(state, "agent.abort.completed", { reason: "user" });
      this.#recordRuntime(state, "agent.turn.cancelled", {
        reason: "user",
        durationMs:
          state.activeTurn?.startedAt === undefined
            ? undefined
            : Date.now() - state.activeTurn.startedAt,
      });
    } catch (error) {
      this.#recordRuntime(state, "agent.abort.failed", {
        reason: "user",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    return true;
  }

  public async cancelManagedAgent(instanceId: string): Promise<boolean> {
    const state = this.#states.get(instanceId);
    const session = state?.session;
    if (!state || !session || state.inFlightTurns === 0) {
      return false;
    }
    this.#recordRuntime(state, "agent.abort.requested", {
      reason: "user",
    });
    try {
      this.#cancelActiveTurnTimeout(state, "user_cancelled");
      this.#cancelPendingPlans(state, "user_cancelled");
      this.#cancelPendingElicitations(state, "user_cancelled");
      await session.abort();
      if (state.activeTurn !== undefined) {
        this.#finishWorkingTurn(
          state,
          state.activeTurn,
          "cancelled",
          new Date().toISOString(),
          "Cancelled by user",
        );
      }
      this.#recordRuntime(state, "agent.abort.completed", { reason: "user" });
      this.#recordRuntime(state, "agent.turn.cancelled", {
        reason: "user",
        durationMs:
          state.activeTurn?.startedAt === undefined
            ? undefined
            : Date.now() - state.activeTurn.startedAt,
      });
    } catch (error) {
      this.#recordRuntime(state, "agent.abort.failed", {
        reason: "user",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
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
    turn: InstrumentedTurn,
    agentMode?: AgentMode,
  ): Promise<string> {
    await this.#refreshDynamicSessionConfiguration(state, turn);
    const session = state.session;
    if (!session) {
      throw new Error(
        state.exposeInstanceId
          ? `Managed agent '${state.configuration.instanceId}' is not active`
          : "Copilot agent service is not started",
      );
    }
    const configuredTurnTimeout = this.options.turnTimeoutMs;
    const timeoutMs =
      typeof configuredTurnTimeout === "function"
        ? configuredTurnTimeout()
        : (configuredTurnTimeout ?? DEFAULT_AGENT_TURN_TIMEOUT_MS);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error("Copilot turn timeout must be a positive finite number");
    }
    const requestedAgentMode = agentMode ?? "interactive";
    const finalPrompt = composeAgentTurnPrompt(prompt, agentMode);
    const planReminderApplied = agentMode === "plan";
    const startedAt = Date.now();
    turn.startedAt = startedAt;
    state.activeTurn = turn;
    state.activeAgentMode = requestedAgentMode;
    this.#publishWorkingUpdate(state, {
      kind: "started",
      activityId: turn.id,
      occurredAt: new Date(startedAt).toISOString(),
    });
    this.#recordRuntime(
      state,
      "agent.working.started",
      { activityId: turn.id },
      { trace: turn.trace, sessionId: session.sessionId },
    );
    this.#recordRuntime(
      state,
      "agent.turn.started",
      {
        origin: turn.origin,
        prompt: finalPrompt,
        kind,
        agentMode: state.activeAgentMode,
        planReminderApplied,
        ...(planReminderApplied
          ? { planReminderVersion: PLAN_REMINDER_VERSION }
          : {}),
        timeoutMs,
        queuedAt: new Date(turn.queuedAt).toISOString(),
        queueDurationMs: startedAt - turn.queuedAt,
      },
      { trace: turn.trace, sessionId: session.sessionId },
    );
    this.#logger.debug("Agent turn started", {
      sessionId: session.sessionId,
      ...(state.exposeInstanceId
        ? { instanceId: state.configuration.instanceId }
        : {}),
      kind,
      agentMode: state.activeAgentMode,
      prompt: finalPrompt,
      planReminderApplied,
      ...(planReminderApplied
        ? { planReminderVersion: PLAN_REMINDER_VERSION }
        : {}),
      timeoutMs,
    });
    state.inFlightTurns += 1;
    state.turnKind = kind;
    const completion = waitForSessionCompletion(session);
    const timeout = new PausableTurnTimeout(timeoutMs);
    turn.timeout = timeout;
    timeout.start();
    let response: CopilotResponse | undefined;
    try {
      const send = session.send({
        prompt: finalPrompt,
        ...(agentMode === undefined ? {} : { agentMode }),
      });
      const initialOutcome = await Promise.race([
        send.then(
          () => ({ kind: "sent" as const }),
          (error: unknown) => ({ kind: "error" as const, error }),
        ),
        completion.promise.then(
          (completedResponse) => ({
            kind: "completed" as const,
            response: completedResponse,
          }),
          (error: unknown) => ({ kind: "error" as const, error }),
        ),
        timeout.expired.then(() => ({ kind: "timeout" as const })),
      ]);
      if (initialOutcome.kind === "error") throw initialOutcome.error;
      if (initialOutcome.kind === "timeout") {
        return await this.#abortTimedOutTurn(state, session, timeoutMs);
      }
      if (initialOutcome.kind === "completed") {
        response = initialOutcome.response;
      } else {
        const completedOutcome = await Promise.race([
          completion.promise.then(
            (completedResponse) => ({
              kind: "completed" as const,
              response: completedResponse,
            }),
            (error: unknown) => ({ kind: "error" as const, error }),
          ),
          timeout.expired.then(() => ({ kind: "timeout" as const })),
        ]);
        if (completedOutcome.kind === "error") throw completedOutcome.error;
        if (completedOutcome.kind === "timeout") {
          return await this.#abortTimedOutTurn(state, session, timeoutMs);
        }
        response = completedOutcome.response;
      }
    } catch (error) {
      if (error instanceof AgentTurnTimeoutError) throw error;
      this.#logger.error("Agent turn failed", {
        sessionId: session.sessionId,
        ...(state.exposeInstanceId
          ? { instanceId: state.configuration.instanceId }
          : {}),
        kind,
        prompt: finalPrompt,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      this.#recordRuntime(
        state,
        "agent.turn.failed",
        {
          origin: turn.origin,
          prompt: finalPrompt,
          kind,
          agentMode: requestedAgentMode,
          planReminderApplied,
          ...(planReminderApplied
            ? { planReminderVersion: PLAN_REMINDER_VERSION }
            : {}),
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        },
        { trace: turn.trace, sessionId: session.sessionId },
      );
      this.#finishWorkingTurn(
        state,
        turn,
        "failed",
        new Date().toISOString(),
        error instanceof Error ? error.message : String(error),
      );
      turn.terminalRecorded = true;
      throw error;
    } finally {
      completion.dispose();
      timeout.dispose();
      turn.timeout = undefined;
      state.inFlightTurns -= 1;
      state.turnKind = undefined;
      state.activeAgentMode = undefined;
      state.activeTurn = undefined;
    }
    if (!response) {
      this.#recordRuntime(
        state,
        "agent.turn.failed",
        {
          origin: turn.origin,
          prompt: finalPrompt,
          kind,
          agentMode: requestedAgentMode,
          planReminderApplied,
          ...(planReminderApplied
            ? { planReminderVersion: PLAN_REMINDER_VERSION }
            : {}),
          durationMs: Date.now() - startedAt,
          error: "Copilot session completed without an assistant response",
        },
        { trace: turn.trace, sessionId: session.sessionId },
      );
      this.#finishWorkingTurn(
        state,
        turn,
        "failed",
        new Date().toISOString(),
        "Copilot session completed without an assistant response",
      );
      turn.terminalRecorded = true;
      throw new Error(
        "Copilot session completed without an assistant response",
      );
    }
    this.options.events.publish({
      type: "agent.message_complete",
      content: response.data.content,
      ...this.#eventAttribution(state),
    });
    this.#finishWorkingTurn(state, turn, "completed", new Date().toISOString());
    if (!turn.finalObserved) {
      this.#recordRuntime(
        state,
        "agent.assistant.final",
        { content: response.data.content, source: "session-event-wait" },
        { trace: turn.trace, sessionId: session.sessionId },
      );
      turn.terminalRecorded = true;
    }
    this.#recordRuntime(
      state,
      "agent.turn.completed",
      {
        origin: turn.origin,
        prompt: finalPrompt,
        kind,
        agentMode: requestedAgentMode,
        planReminderApplied,
        ...(planReminderApplied
          ? { planReminderVersion: PLAN_REMINDER_VERSION }
          : {}),
        response: response.data.content,
        durationMs: Date.now() - startedAt,
      },
      { trace: turn.trace, sessionId: session.sessionId },
    );
    turn.terminalRecorded = true;
    this.#logger.debug("Agent turn completed", {
      sessionId: session.sessionId,
      ...(state.exposeInstanceId
        ? { instanceId: state.configuration.instanceId }
        : {}),
      kind,
      prompt: finalPrompt,
      response: response.data.content,
      durationMs: Date.now() - startedAt,
    });
    return response.data.content;
  }

  async #rotateMissingManagedSession(
    state: ManagedSessionState,
    missingSession: CopilotSessionAdapter,
  ): Promise<void> {
    const oldSdkSessionId = missingSession.sessionId;
    const config = this.#sessionConfig(state);
    const replacement = await this.#requireClient().createSession(config);
    try {
      state.unsubscribe?.();
      state.unsubscribe = undefined;
      await missingSession.disconnect();
      state.session = replacement;
      state.appliedReasoningSummary = config.reasoningSummary;
      this.#recordSessionConfiguration(state, config, replacement.sessionId);
      this.#observe(state, replacement);
    } catch (error) {
      state.unsubscribe?.();
      state.unsubscribe = undefined;
      state.session = undefined;
      try {
        await replacement.disconnect();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Missing Copilot session replacement failed and cleanup was incomplete",
        );
      }
      throw error;
    }
    this.options.events.publish({
      type: "agent.sdk_session_rotated",
      agentInstanceId: state.configuration.instanceId,
      oldSdkSessionId,
      newSdkSessionId: replacement.sessionId,
      reason: "missing-session",
    });
  }

  #liveEventTrigger(
    state: ManagedSessionState,
    request: LiveEventTurnRequest,
    status: LiveEventTriggerView["status"],
    error?: unknown,
  ): LiveEventTriggerView {
    return {
      deliveryId: request.deliveryId,
      occurrenceId: request.occurrence.occurrenceId,
      eventId: request.occurrence.eventId,
      listenerId: request.listener.id,
      agentInstanceId: request.agentInstanceId,
      sdkSessionId: state.session?.sessionId ?? "",
      kind: request.occurrence.kind,
      sourceTrack: request.occurrence.target.track.name,
      state: liveEventTypedState(request.occurrence),
      observedAt: request.occurrence.observedAt,
      ...(request.listener.messagePrefix === undefined
        ? {}
        : { messagePrefix: request.listener.messagePrefix }),
      occurrence: JSON.stringify(request.occurrence, undefined, 2),
      summary: request.occurrence.summary,
      status,
      updatedAt: new Date().toISOString(),
      ...(error === undefined
        ? {}
        : {
            error:
              error instanceof Error
                ? error.message
                : typeof error === "string"
                  ? error
                  : "Unknown automatic Listening Event failure",
          }),
    };
  }

  #serialize<T>(
    state: ManagedSessionState,
    run: () => Promise<T>,
    turn?: InstrumentedTurn,
  ): Promise<T> {
    state.queuedTurns += 1;
    if (turn !== undefined) {
      this.#recordRuntime(
        state,
        "agent.turn.queued",
        {
          origin: turn.origin,
          prompt: turn.prompt,
          ...(turn.agentMode === undefined
            ? {}
            : { agentMode: turn.agentMode }),
          queueDepth: state.queuedTurns,
        },
        { trace: turn.trace },
      );
    }
    const wrapped = async (): Promise<T> => {
      try {
        return await run();
      } catch (error) {
        if (turn !== undefined && !turn.terminalRecorded) {
          turn.terminalRecorded = true;
          this.#recordRuntime(
            state,
            "agent.turn.failed",
            {
              origin: turn.origin,
              prompt: turn.prompt,
              queueDurationMs: Date.now() - turn.queuedAt,
              ...(turn.startedAt === undefined
                ? {}
                : { durationMs: Date.now() - turn.startedAt }),
              error: error instanceof Error ? error.message : String(error),
            },
            { trace: turn.trace },
          );
        }
        throw error;
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
    const turn = this.#newTurn("user", prompt);
    return this.#serialize(
      state,
      () => this.#sendNow(state, prompt, "user", turn),
      turn,
    );
  }

  public sendToManagedAgent(
    instanceId: string,
    prompt: string,
    agentMode?: AgentMode,
  ): Promise<string> {
    const state = this.#requireManagedState(instanceId);
    let invocation: SkillInvocation | undefined;
    try {
      invocation = parseSkillInvocation(prompt);
    } catch (error) {
      return Promise.reject(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
    const turn = this.#newTurn(
      invocation === undefined ? "user" : "skill",
      prompt,
      agentMode === undefined ? {} : { agentMode },
    );
    return this.#serialize(
      state,
      async () => {
        const turnPrompt =
          invocation === undefined
            ? prompt
            : await this.#prepareSkillInvocation(state, invocation);
        return this.#sendNow(state, turnPrompt, "user", turn, agentMode);
      },
      turn,
    );
  }

  public async resolveManagedAgentPlan(
    instanceId: string,
    request: {
      requestId: string;
      approved: boolean;
      planRevision?: string;
      selectedAction?: AgentPlanExitAction;
      feedback?: string;
    },
  ): Promise<boolean> {
    const state = this.#requireManagedState(instanceId);
    const session = state.session;
    if (session === undefined) {
      throw new Error(`Managed agent '${instanceId}' is not active`);
    }
    const direct = state.directPlanRequests.get(request.requestId);
    if (direct !== undefined) {
      const startedAt = Date.now();
      this.#recordRuntime(
        state,
        "agent.plan.resolution.queued",
        { requestId: request.requestId },
        { sessionId: direct.sessionId },
      );
      this.#recordRuntime(
        state,
        "agent.plan.resolution.started",
        { requestId: request.requestId },
        { sessionId: direct.sessionId },
      );
      const artifact = await this.#planArtifacts.read(
        direct.productionSessionId,
      );
      const submittedRevision =
        request.planRevision ?? direct.artifact.revision;
      if (!artifact.exists || artifact.revision !== submittedRevision) {
        this.#recordRuntime(
          state,
          "agent.plan.resolution.stale",
          {
            requestId: request.requestId,
            submittedRevision,
            currentRevision: artifact.exists ? artifact.revision : undefined,
            durationMs: Date.now() - startedAt,
          },
          { sessionId: direct.sessionId },
        );
        this.#publishPlanArtifact(state, artifact);
        if (artifact.exists) {
          direct.artifact = artifact;
          this.#publishPlanApproval(
            state,
            request.requestId,
            "The plan changed while it was being reviewed. Review the latest plan.md before continuing.",
            ["interactive", "exit_only"],
            "interactive",
            artifact,
          );
        }
        throw new Error(
          "The plan changed while it was being reviewed. Review the latest revision before approving it.",
        );
      }
      state.directPlanRequests.delete(request.requestId);
      const feedback =
        request.feedback === undefined
          ? undefined
          : boundedPlanText(request.feedback, MAX_PLAN_FEEDBACK_LENGTH);
      if (
        request.approved &&
        (request.selectedAction === "interactive" ||
          request.selectedAction === "exit_only")
      ) {
        state.activeAgentMode = "interactive";
      }
      direct.resolve({
        approved: request.approved,
        ...(request.selectedAction === undefined
          ? {}
          : { selectedAction: request.selectedAction }),
        ...(feedback === undefined ? {} : { feedback }),
      });
      this.#recordRuntime(
        state,
        "agent.plan.resolution.completed",
        {
          requestId: request.requestId,
          approved: request.approved,
          selectedAction: request.selectedAction,
          planRevision: artifact.revision,
          durationMs: Date.now() - startedAt,
        },
        { sessionId: direct.sessionId },
      );
      this.options.events.publish({
        type: "agent.plan_approval_completed",
        requestId: request.requestId,
        approved: request.approved,
        ...(request.selectedAction === undefined
          ? {}
          : { selectedAction: request.selectedAction }),
        ...(feedback === undefined ? {} : { feedback }),
        ...this.#eventAttribution(state),
      });
      return true;
    }
    return false;
  }

  public async readManagedAgentPlan(
    instanceId: string,
  ): Promise<PlanArtifactSnapshot> {
    return await this.#readPlanArtifact(this.#requireManagedState(instanceId));
  }

  public async writeManagedAgentPlan(
    instanceId: string,
    input: PlanArtifactWrite,
  ): Promise<PlanArtifactSnapshot> {
    return await this.#writePlanArtifact(
      this.#requireManagedState(instanceId),
      input,
    );
  }

  public async resolveManagedAgentElicitation(
    instanceId: string,
    request: AgentElicitationResolution,
  ): Promise<boolean> {
    const state = this.#requireManagedState(instanceId);
    const pending = state.elicitationRequests.get(request.requestId);
    if (pending === undefined) return false;
    const content =
      request.action === "accept"
        ? validateElicitationContent(pending.request, request.content ?? {})
        : undefined;
    state.elicitationRequests.delete(request.requestId);
    pending.resolve({
      action: request.action,
      ...(content === undefined ? {} : { content }),
    });
    this.#recordRuntime(
      state,
      "agent.elicitation.completed",
      {
        requestId: request.requestId,
        action: request.action,
        durationMs: Date.now() - pending.startedAt,
      },
      { sessionId: pending.sessionId },
    );
    this.options.events.publish({
      type: "agent.elicitation_completed",
      requestId: request.requestId,
      action: request.action,
      ...this.#eventAttribution(state),
    });
    return true;
  }

  public invokeManagedAgentSkill(
    instanceId: string,
    invocation: string | SkillInvocation,
    agentMode?: AgentMode,
  ): Promise<string> {
    const state = this.#requireManagedState(instanceId);
    const displayPrompt =
      typeof invocation === "string"
        ? invocation
        : formatSkillInvocation(invocation);
    const turn = this.#newTurn(
      "skill",
      displayPrompt,
      agentMode === undefined ? {} : { agentMode },
    );
    return this.#serialize(
      state,
      async () =>
        this.#sendNow(
          state,
          await this.#prepareSkillInvocation(state, invocation),
          "user",
          turn,
          agentMode,
        ),
      turn,
    );
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
        const prompt = formatAutomaticSignalPrompt(
          request,
          this.options.signalContext,
        );
        const upstreamTraceId =
          "traceId" in request.context &&
          typeof request.context.traceId === "string"
            ? request.context.traceId
            : request.context.assignmentId;
        const turn = this.#newTurn("output.automatic", prompt, {
          traceId: upstreamTraceId,
          occurrenceIds: [request.context.assignmentId],
          deliveryIds: [request.deliveryId],
        });
        state.pendingAutomatic.set(key, {
          request,
          deliveryIds: [request.deliveryId],
          turn,
          waiters: [{ resolve, reject }],
        });
        this.#recordRuntime(
          state,
          "agent.turn.queued",
          {
            origin: turn.origin,
            prompt,
            queueDepth: state.queuedTurns + 1,
          },
          { trace: turn.trace },
        );
      } else {
        if (request.context.sequence >= pending.request.context.sequence) {
          pending.request = request;
          pending.turn.prompt = formatAutomaticSignalPrompt(
            request,
            this.options.signalContext,
          );
        }
        pending.deliveryIds.push(request.deliveryId);
        pending.turn.trace.deliveryIds.push(request.deliveryId);
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
                  (item.turn.prompt = formatAutomaticSignalPrompt(
                    item.request,
                    this.options.signalContext,
                  )),
                  item.request.context.deliveryMode,
                  item.turn,
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

  public enqueueLiveEventTurn(request: LiveEventTurnRequest): Promise<string> {
    const state = this.#findStateBySignalTargetId(request.agentInstanceId);
    if (state?.session === undefined) {
      return Promise.reject(
        new Error(
          `No active Copilot session for Live event listener '${request.agentInstanceId}'`,
        ),
      );
    }
    const prompt = formatAutomaticLiveEventPrompt(
      request,
      this.options.liveEventContext,
    );
    const turn = this.#newTurn("live-event.automatic", prompt, {
      traceId: request.occurrence.occurrenceId,
      occurrenceIds: [request.occurrence.occurrenceId],
      deliveryIds: [request.deliveryId],
    });
    this.options.events.publish({
      type: "agent.live_event_trigger_changed",
      trigger: this.#liveEventTrigger(state, request, "queued"),
    });
    return this.#serialize(
      state,
      async () => {
        state.preparedContextListener = request.listener;
        try {
          let response: string;
          try {
            response = await this.#sendNow(
              state,
              prompt,
              "automatic-action",
              turn,
            );
          } catch (error) {
            const missingSession = state.session;
            if (
              !isMissingCopilotSessionError(error) ||
              missingSession === undefined ||
              turn.toolStarted ||
              turn.retryAttempted
            ) {
              throw error;
            }
            turn.retryAttempted = true;
            await this.#rotateMissingManagedSession(state, missingSession);
            const retryTurn = this.#newTurn("live-event.automatic", prompt, {
              traceId: request.occurrence.occurrenceId,
              occurrenceIds: [request.occurrence.occurrenceId],
              deliveryIds: [request.deliveryId],
            });
            retryTurn.retryAttempted = true;
            response = await this.#sendNow(
              state,
              prompt,
              "automatic-action",
              retryTurn,
            );
          }
          this.options.events.publish({
            type: "agent.live_event_trigger_changed",
            trigger: this.#liveEventTrigger(state, request, "completed"),
          });
          return response;
        } catch (error) {
          this.options.events.publish({
            type: "agent.live_event_trigger_changed",
            trigger: this.#liveEventTrigger(state, request, "failed", error),
          });
          throw error;
        } finally {
          state.preparedContextListener = undefined;
        }
      },
      turn,
    );
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
      | "getManagedAgentHistory"
      | "resolveManagedAgentPlan"
      | "readManagedAgentPlan"
      | "writeManagedAgentPlan"
      | "resolveManagedAgentElicitation"
      | "listModels",
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

  public enqueueLiveEventTurn(request: LiveEventTurnRequest): Promise<string> {
    if (this.#state !== "ready" && this.#state !== "degraded") {
      return Promise.reject(
        new Error(`Application is not running (${this.#state})`),
      );
    }
    if (this.services.agent.enqueueLiveEventTurn === undefined) {
      return Promise.reject(
        new Error("Configured agent does not support Live event delivery"),
      );
    }
    return this.services.agent.enqueueLiveEventTurn(request);
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

  public listModels(): Promise<readonly AgentModelDescriptor[]> {
    return this.#requireManagedAgentMethod("listModels")();
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
    agentMode?: AgentMode,
  ): Promise<string> {
    if (this.#state !== "ready" && this.#state !== "degraded") {
      return Promise.reject(
        new Error(`Application is not running (${this.#state})`),
      );
    }
    return this.#requireManagedAgentMethod("sendToManagedAgent")(
      instanceId,
      prompt,
      agentMode,
    );
  }

  public resolveManagedAgentPlan(
    instanceId: string,
    request: {
      requestId: string;
      approved: boolean;
      planRevision?: string;
      selectedAction?: AgentPlanExitAction;
      feedback?: string;
    },
  ): Promise<boolean> {
    if (this.#state !== "ready" && this.#state !== "degraded") {
      return Promise.reject(
        new Error(`Application is not running (${this.#state})`),
      );
    }
    return this.#requireManagedAgentMethod("resolveManagedAgentPlan")(
      instanceId,
      request,
    );
  }

  public readManagedAgentPlan(
    instanceId: string,
  ): Promise<PlanArtifactSnapshot> {
    return this.#requireManagedAgentMethod("readManagedAgentPlan")(instanceId);
  }

  public writeManagedAgentPlan(
    instanceId: string,
    input: PlanArtifactWrite,
  ): Promise<PlanArtifactSnapshot> {
    return this.#requireManagedAgentMethod("writeManagedAgentPlan")(
      instanceId,
      input,
    );
  }

  public resolveManagedAgentElicitation(
    instanceId: string,
    request: AgentElicitationResolution,
  ): Promise<boolean> {
    return this.#requireManagedAgentMethod("resolveManagedAgentElicitation")(
      instanceId,
      request,
    );
  }

  public invokeManagedAgentSkill(
    instanceId: string,
    invocation: string | SkillInvocation,
    agentMode?: AgentMode,
  ): Promise<string> {
    if (this.#state !== "ready" && this.#state !== "degraded") {
      return Promise.reject(
        new Error(`Application is not running (${this.#state})`),
      );
    }
    return this.#requireManagedAgentMethod("invokeManagedAgentSkill")(
      instanceId,
      invocation,
      agentMode,
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

  public getLiveIdentity(): Promise<LiveIdentity> {
    return this.services.ableton.getLiveIdentity();
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

  public fillArrangementRegion(
    params: FillArrangementRegionParams,
  ): Promise<FillArrangementRegionResult> {
    return this.services.ableton.fillArrangementRegion(params);
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
