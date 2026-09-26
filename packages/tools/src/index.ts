/* eslint-disable @typescript-eslint/no-unused-vars -- Action discriminants are intentionally removed before service dispatch. */
import type {
  AudioClipsOperationParams,
  AudioClipsOperationResult,
  BrowserAdapterOperationParams,
  BrowserAdapterOperationResult,
  CreateTrackParams,
  CreateMidiClipParams,
  CreateMidiClipResult,
  ClipAutomationOperationParams,
  ClipAutomationOperationResult,
  CreateArrangementMidiClipParams,
  CreateArrangementMidiClipResult,
  CreateCuePointParams,
  CuePointMutationResult,
  DeleteArrangementClipParams,
  DeleteArrangementClipResult,
  DeleteCuePointParams,
  DuplicateClipToArrangementParams,
  DuplicateClipToArrangementResult,
  FillArrangementRegionParams,
  FillArrangementRegionResult,
  DuplicateSessionClipParams,
  DuplicateSessionClipResult,
  FindDevicePositionParams,
  FindDevicePositionResult,
  DeleteTrackParams,
  DeleteSessionClipParams,
  DeleteSessionClipResult,
  RenameTrackParams,
  InspectArrangementParams,
  InspectArrangementResult,
  InspectArrangementTransportParams,
  InspectArrangementTransportResult,
  InspectDeviceParametersParams,
  InspectDeviceParametersResult,
  InspectDevicesParams,
  InspectDevicesResult,
  InspectBrowserRootsResult,
  InspectBrowserChildrenParams,
  InspectBrowserChildrenResult,
  InspectChainMixerParams,
  InspectChainMixerResult,
  SearchBrowserParams,
  SearchBrowserResult,
  LoadBrowserItemParams,
  LoadBrowserItemResult,
  GrooveOperationParams,
  GrooveOperationResult,
  LiveHistoryOperationParams,
  LiveHistoryOperationResult,
  MidiNotesOperationParams,
  MidiNotesOperationResult,
  MixerRoutingOperationParams,
  MixerRoutingOperationResult,
  MoveDeviceParams,
  MoveDeviceResult,
  InspectDrumPadChainDevicesParams,
  InspectDrumPadChainDevicesResult,
  InspectDrumPadChainsParams,
  InspectDrumPadChainsResult,
  InspectDrumRackPadsParams,
  InspectDrumRackPadsResult,
  InspectRackChainDevicesParams,
  InspectRackChainDevicesResult,
  InspectRackChainsParams,
  InspectRackChainsResult,
  LaunchSessionClipParams,
  LaunchSessionClipResult,
  RenameTrackResult,
  ReplaceMidiNotesParams,
  ReplaceMidiNotesResult,
  ReplaceArrangementMidiNotesParams,
  ReplaceArrangementMidiNotesResult,
  SetArrangementClipPropertiesParams,
  SetArrangementClipPropertiesResult,
  SetArrangementLoopParams,
  SetArrangementLoopResult,
  SetChainMixerParams,
  SetChainMixerResult,
  SetChainPropertiesParams,
  SetChainPropertiesResult,
  SetSessionClipPropertiesParams,
  SetSessionClipPropertiesResult,
  ScenesOperationParams,
  ScenesOperationResult,
  SessionSnapshot,
  SetPlayingResult,
  SetTempoResult,
  RecordingOperationParams,
  RecordingOperationResult,
  SelectionViewOperationParams,
  SelectionViewOperationResult,
  SpecializedDeviceOperationParams,
  SpecializedDeviceOperationResult,
  SetTrackMixerParams,
  SetTrackMixerResult,
  SetDeviceEnabledParams,
  SetDeviceEnabledResult,
  SetDeviceParameterParams,
  SetDeviceParameterResult,
  TrackMutationResult,
  TracksOperationParams,
  TracksOperationResult,
  TransportOperationParams,
  TransportOperationResult,
  WarpMarkerOperationParams,
  WarpMarkerOperationResult,
  WorkflowJobOperationParams,
  WorkflowJobOperationResult,
} from "@ableton-agent/protocol";
import {
  audioClipsOperationParamsSchema,
  audioClipsOperationResultSchema,
  browserAdapterOperationParamsSchema,
  browserAdapterOperationResultSchema,
  clipAutomationOperationParamsSchema,
  clipAutomationOperationResultSchema,
  grooveOperationParamsSchema,
  grooveOperationResultSchema,
  liveHistoryOperationParamsSchema,
  liveHistoryOperationResultSchema,
  midiNotesOperationParamsSchema,
  midiNotesOperationResultSchema,
  mixerRoutingOperationResultSchema,
  scenesOperationParamsSchema,
  scenesOperationResultSchema,
  tracksOperationResultSchema,
  transportOperationResultSchema,
  recordingOperationParamsSchema,
  recordingOperationResultSchema,
  selectionViewOperationParamsSchema,
  selectionViewOperationResultSchema,
  specializedDeviceOperationParamsSchema,
  specializedDeviceOperationResultSchema,
  warpMarkerOperationParamsSchema,
  warpMarkerOperationResultSchema,
  workflowJobOperationParamsSchema,
  workflowJobOperationResultSchema,
} from "@ableton-agent/protocol";
import type { ConnectionStatus } from "@ableton-agent/shared";
import { withCorrelation } from "@ableton-agent/correlation";
import {
  defineTool,
  type PermissionHandler,
  type Tool,
  type ToolResultObject,
} from "@github/copilot-sdk";
import { z, type ZodType } from "zod";
import type { MutationTarget } from "./mutation-policy.js";
import {
  abletonOperationDescriptors,
  getAbletonOperationDescriptorForAction,
  resolveAbletonOperation,
  type AbletonOperationEditScope,
  type AbletonOperationLifecycleIdentity,
} from "./operation-descriptor.js";
import {
  SET_SQL_DEFAULT_MAX_ROWS,
  SET_SQL_MAX_CELL_CHARACTERS,
  SET_SQL_MAX_PARAMETER_NAME_LENGTH,
  SET_SQL_MAX_PARAMETERS,
  SET_SQL_MAX_ROWS,
  SET_SQL_SEARCH_TOOL_NAME,
  bindSetSqlParameters,
  boundSetSqlSearchResult,
  validateSetSqlSearch,
  type SetHistoryQueryService,
  type SetSqlParameters,
} from "./set-sql-search.js";
import {
  abletonToolArgumentError,
  agentFacingParameters,
} from "./argument-validation.js";
import {
  abletonArrangementParamsSchema,
  abletonBrowserParamsSchema,
  abletonDevicesParamsSchema,
  abletonMixerRoutingParamsSchema,
  abletonSessionClipsParamsSchema,
  abletonSessionParamsSchema,
  abletonTracksParamsSchema,
  abletonTransportParamsSchema,
  type AbletonArrangementParams,
  type AbletonBrowserParams,
  type AbletonDevicesParams,
  type AbletonMixerRoutingParams,
  type AbletonSessionClipsParams,
  type AbletonSessionParams,
  type AbletonTracksParams,
  type AbletonTransportParams,
} from "./grouped-tool-schemas.js";

export * from "./set-sql-search.js";
export * from "./argument-validation.js";
export * from "./grouped-tool-schemas.js";

export type ToolRisk = "read" | "reversible" | "destructive" | "broad";
export type ToolDuration = "instant" | "short" | "long";

export interface AbletonToolMetadata {
  name: string;
  title: string;
  risk: ToolRisk;
  duration: ToolDuration;
  mutationTarget: MutationTarget;
  requiredCapability?: string;
  operationId?: string;
  action?: string;
  editScope?: AbletonOperationEditScope;
  lifecycleIdentity?: AbletonOperationLifecycleIdentity;
}

export interface AbletonToolServices {
  setHistoryQuery?: SetHistoryQueryService;
  getConnectionStatus(): Promise<ConnectionStatus>;
  inspectSession(): Promise<SessionSnapshot>;
  executeScenesOperation?(
    params: ScenesOperationParams,
  ): Promise<ScenesOperationResult>;
  executeTracksOperation?(
    params: TracksOperationParams,
  ): Promise<TracksOperationResult>;
  executeMixerRoutingOperation?(
    params: MixerRoutingOperationParams,
  ): Promise<MixerRoutingOperationResult>;
  executeTransportOperation?(
    params: TransportOperationParams,
  ): Promise<TransportOperationResult>;
  executeMidiNotesOperation?(
    params: MidiNotesOperationParams,
  ): Promise<MidiNotesOperationResult>;
  executeAudioClipsOperation?(
    params: AudioClipsOperationParams,
  ): Promise<AudioClipsOperationResult>;
  executeRecordingOperation?(
    params: RecordingOperationParams,
  ): Promise<RecordingOperationResult>;
  executeGrooveOperation?(
    params: GrooveOperationParams,
  ): Promise<GrooveOperationResult>;
  executeSelectionViewOperation?(
    params: SelectionViewOperationParams,
  ): Promise<SelectionViewOperationResult>;
  executeLiveHistoryOperation?(
    params: LiveHistoryOperationParams,
  ): Promise<LiveHistoryOperationResult>;
  executeBrowserAdapterOperation?(
    params: BrowserAdapterOperationParams,
  ): Promise<BrowserAdapterOperationResult>;
  executeClipAutomationOperation?(
    params: ClipAutomationOperationParams,
  ): Promise<ClipAutomationOperationResult>;
  executeWarpMarkerOperation?(
    params: WarpMarkerOperationParams,
  ): Promise<WarpMarkerOperationResult>;
  executeSpecializedDeviceOperation?(
    params: SpecializedDeviceOperationParams,
  ): Promise<SpecializedDeviceOperationResult>;
  executeWorkflowJobOperation?(
    params: WorkflowJobOperationParams,
  ): Promise<WorkflowJobOperationResult>;
  setTempo(tempo: number): Promise<SetTempoResult>;
  setPlaying(isPlaying: boolean): Promise<SetPlayingResult>;
  inspectArrangementTransport(
    params: InspectArrangementTransportParams,
  ): Promise<InspectArrangementTransportResult>;
  setArrangementLoop(
    params: SetArrangementLoopParams,
  ): Promise<SetArrangementLoopResult>;
  createCuePoint(params: CreateCuePointParams): Promise<CuePointMutationResult>;
  deleteCuePoint(params: DeleteCuePointParams): Promise<CuePointMutationResult>;
  createTrack(params: CreateTrackParams): Promise<TrackMutationResult>;
  deleteTrack(params: DeleteTrackParams): Promise<TrackMutationResult>;
  renameTrack(params: RenameTrackParams): Promise<RenameTrackResult>;
  setTrackMixer(params: SetTrackMixerParams): Promise<SetTrackMixerResult>;
  inspectDevices(params: InspectDevicesParams): Promise<InspectDevicesResult>;
  inspectBrowserRoots(): Promise<InspectBrowserRootsResult>;
  inspectBrowserChildren(
    params: InspectBrowserChildrenParams,
  ): Promise<InspectBrowserChildrenResult>;
  searchBrowser(params: SearchBrowserParams): Promise<SearchBrowserResult>;
  loadBrowserItem(
    params: LoadBrowserItemParams,
  ): Promise<LoadBrowserItemResult>;
  inspectDeviceParameters(
    params: InspectDeviceParametersParams,
  ): Promise<InspectDeviceParametersResult>;
  inspectRackChains(
    params: InspectRackChainsParams,
  ): Promise<InspectRackChainsResult>;
  inspectRackChainDevices(
    params: InspectRackChainDevicesParams,
  ): Promise<InspectRackChainDevicesResult>;
  inspectDrumRackPads(
    params: InspectDrumRackPadsParams,
  ): Promise<InspectDrumRackPadsResult>;
  inspectDrumPadChains(
    params: InspectDrumPadChainsParams,
  ): Promise<InspectDrumPadChainsResult>;
  inspectDrumPadChainDevices(
    params: InspectDrumPadChainDevicesParams,
  ): Promise<InspectDrumPadChainDevicesResult>;
  inspectChainMixer(
    params: InspectChainMixerParams,
  ): Promise<InspectChainMixerResult>;
  findDevicePosition(
    params: FindDevicePositionParams,
  ): Promise<FindDevicePositionResult>;
  moveDevice(params: MoveDeviceParams): Promise<MoveDeviceResult>;
  setChainProperties(
    params: SetChainPropertiesParams,
  ): Promise<SetChainPropertiesResult>;
  setChainMixer(params: SetChainMixerParams): Promise<SetChainMixerResult>;
  setDeviceEnabled(
    params: SetDeviceEnabledParams,
  ): Promise<SetDeviceEnabledResult>;
  setDeviceParameter(
    params: SetDeviceParameterParams,
  ): Promise<SetDeviceParameterResult>;
  createMidiClip(params: CreateMidiClipParams): Promise<CreateMidiClipResult>;
  replaceMidiNotes(
    params: ReplaceMidiNotesParams,
  ): Promise<ReplaceMidiNotesResult>;
  launchSessionClip(
    params: LaunchSessionClipParams,
  ): Promise<LaunchSessionClipResult>;
  duplicateSessionClip(
    params: DuplicateSessionClipParams,
  ): Promise<DuplicateSessionClipResult>;
  deleteSessionClip(
    params: DeleteSessionClipParams,
  ): Promise<DeleteSessionClipResult>;
  setSessionClipProperties(
    params: SetSessionClipPropertiesParams,
  ): Promise<SetSessionClipPropertiesResult>;
  createArrangementMidiClip(
    params: CreateArrangementMidiClipParams,
  ): Promise<CreateArrangementMidiClipResult>;
  inspectArrangement(
    params: InspectArrangementParams,
  ): Promise<InspectArrangementResult>;
  deleteArrangementClip(
    params: DeleteArrangementClipParams,
  ): Promise<DeleteArrangementClipResult>;
  replaceArrangementMidiNotes(
    params: ReplaceArrangementMidiNotesParams,
  ): Promise<ReplaceArrangementMidiNotesResult>;
  duplicateClipToArrangement(
    params: DuplicateClipToArrangementParams,
  ): Promise<DuplicateClipToArrangementResult>;
  fillArrangementRegion(
    params: FillArrangementRegionParams,
  ): Promise<FillArrangementRegionResult>;
  setArrangementClipProperties(
    params: SetArrangementClipPropertiesParams,
  ): Promise<SetArrangementClipPropertiesResult>;
}

export type ExternalPluginSearchParams = Omit<SearchBrowserParams, "roots">;

export const abletonToolMetadata = [
  ...new Map(
    abletonOperationDescriptors.map((descriptor) => [
      descriptor.toolName,
      {
        name: descriptor.toolName,
        title: descriptor.title,
        risk: descriptor.risk,
        duration: descriptor.duration,
        mutationTarget: descriptor.mutationTarget,
        requiredCapability: descriptor.requiredCapability,
        operationId: descriptor.operationId,
        action: descriptor.action,
        editScope: descriptor.editScope,
      },
    ]),
  ).values(),
  {
    name: SET_SQL_SEARCH_TOOL_NAME,
    title: "Search Set and Agent History with SQL",
    risk: "read",
    duration: "short",
    mutationTarget: "read",
  },
] as const satisfies readonly AbletonToolMetadata[];

export function resolveAbletonToolMetadata(
  toolName: string,
  args: unknown,
): AbletonToolMetadata | undefined {
  let operation;
  try {
    operation = resolveAbletonOperation(toolName, args);
  } catch {
    operation = undefined;
  }
  if (operation !== undefined) return operation.metadata;
  const action =
    args !== null &&
    typeof args === "object" &&
    !Array.isArray(args) &&
    typeof Reflect.get(args, "action") === "string"
      ? String(Reflect.get(args, "action"))
      : undefined;
  const descriptor =
    action === undefined
      ? undefined
      : getAbletonOperationDescriptorForAction(toolName, action);
  if (descriptor !== undefined) {
    return {
      name: descriptor.toolName,
      title: descriptor.title,
      risk: descriptor.risk,
      duration: descriptor.duration,
      mutationTarget: descriptor.mutationTarget,
      requiredCapability: descriptor.requiredCapability,
      operationId: descriptor.operationId,
      action: descriptor.action,
      editScope: descriptor.editScope,
    };
  }
  return abletonToolMetadata.find((candidate) => candidate.name === toolName);
}

export interface ToolApprovalRequest {
  metadata: AbletonToolMetadata;
  arguments: Readonly<Record<string, unknown>>;
  agentInstanceId?: string;
  sdkSessionId?: string;
}

export type ToolApprovalRequester = (
  request: ToolApprovalRequest,
) => Promise<boolean>;

export type AskForReadApproval = boolean | (() => boolean);

function requiresExplicitTarget(risk: ToolRisk): boolean {
  return risk === "destructive" || risk === "broad";
}

export function createAbletonPermissionHandler(
  requestApproval?: ToolApprovalRequester,
  askForReads: AskForReadApproval = false,
): PermissionHandler {
  return async (request, invocation) => {
    if (invocation.managedSettingsEnabled || request.kind !== "custom-tool") {
      return { kind: "no-result" };
    }
    const metadata = resolveAbletonToolMetadata(
      request.toolName,
      request.args ?? {},
    );
    if (!metadata) {
      return { kind: "reject", feedback: "Unknown Ableton tool" };
    }
    const actionDescriptor =
      typeof metadata.action === "string"
        ? getAbletonOperationDescriptorForAction(
            request.toolName,
            metadata.action,
          )
        : undefined;
    if (actionDescriptor !== undefined) {
      const parsed = actionDescriptor.inputSchema.safeParse(request.args ?? {});
      if (!parsed.success) {
        const missingTarget = parsed.error.issues.some(
          (issue) => issue.path[0] === "target",
        );
        return {
          kind: "reject",
          feedback:
            missingTarget && requiresExplicitTarget(metadata.risk)
              ? "Destructive and broad operations require explicit target arguments"
              : "Invalid Ableton tool arguments",
        };
      }
    }
    if (
      requiresExplicitTarget(metadata.risk) &&
      Object.keys(request.args ?? {}).length === 0
    ) {
      return {
        kind: "reject",
        feedback:
          "Destructive and broad operations require explicit target arguments",
      };
    }
    if (metadata.risk === "read") {
      const shouldAskForReads =
        typeof askForReads === "function" ? askForReads() : askForReads;
      if (!shouldAskForReads) {
        return { kind: "approve-once" };
      }
    }
    if (!requestApproval) {
      return {
        kind: "reject",
        feedback: "Mutating Ableton tools require explicit user approval",
      };
    }
    return (await requestApproval({
      metadata,
      arguments:
        request.args !== null &&
        typeof request.args === "object" &&
        !Array.isArray(request.args)
          ? request.args
          : {},
    }))
      ? { kind: "approve-once" }
      : { kind: "reject", feedback: "User denied the Ableton mutation" };
  };
}

export interface AbletonToolSet {
  tools: [
    Tool<AbletonSessionParams>,
    Tool<AbletonTracksParams>,
    Tool<AbletonMixerRoutingParams>,
    Tool<AbletonTransportParams>,
    Tool<AbletonSessionClipsParams>,
    Tool<AbletonArrangementParams>,
    Tool<AbletonDevicesParams>,
    Tool<AbletonBrowserParams>,
    Tool<ScenesOperationParams>,
    Tool<MidiNotesOperationParams>,
    Tool<AudioClipsOperationParams>,
    Tool<RecordingOperationParams>,
    Tool<GrooveOperationParams>,
    Tool<SelectionViewOperationParams>,
    Tool<LiveHistoryOperationParams>,
    Tool<BrowserAdapterOperationParams>,
    Tool<ClipAutomationOperationParams>,
    Tool<WarpMarkerOperationParams>,
    Tool<SpecializedDeviceOperationParams>,
    Tool<WorkflowJobOperationParams>,
    Tool<{
      sql: string;
      parameters?: SetSqlParameters | undefined;
      limit: number;
    }>,
  ];
  availableTools: string[];
}

export const toolCatalogPolicy = {
  mode: "eager",
  maximumEagerTools: 64,
} as const;

export const abletonCompatibilityAliases = {} as const satisfies Readonly<
  Record<string, string>
>;
export const deprecatedAbletonToolNames = [] as const;

export class AbletonToolPreconditionError extends Error {
  public readonly code: string;
  public readonly retryable = true;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "AbletonToolPreconditionError";
    this.code = code;
  }
}

function verifyOperationResultAction<T extends { action: string }>(
  expectedAction: string,
  result: T,
): T {
  if (result.action !== expectedAction) {
    throw new Error(
      `Ableton operation returned '${result.action}' for '${expectedAction}'`,
    );
  }
  return result;
}

export interface AbletonToolFailurePayload {
  readonly version: 1;
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly details: Readonly<Record<string, unknown>>;
}

const abletonToolFailurePrefix = "ABLETON_TOOL_FAILURE:";
const failureSanitizerOptions = {
  maxDepth: 6,
  maxStringCharacters: 2_048,
  maxArrayItems: 32,
  maxObjectFields: 32,
  maxBytes: 16_384,
} as const;
const maximumFailureStringLength = failureSanitizerOptions.maxStringCharacters;
const maximumFailureArrayLength = failureSanitizerOptions.maxArrayItems;
const maximumFailureObjectEntries = failureSanitizerOptions.maxObjectFields;
const maximumFailureDepth = failureSanitizerOptions.maxDepth;
const bearerToken = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu;
const credentialAssignment =
  /\b(token|secret|password|api[_ -]?key|authorization)\s*[:=]\s*[^\s,;]+/giu;
const truncatedFailureValue = "[TRUNCATED]";

function isCredentialKey(key: string): boolean {
  const normalized = key.replaceAll(/[^a-z0-9]/giu, "").toLowerCase();
  return [
    "token",
    "secret",
    "credential",
    "authorization",
    "password",
    "passphrase",
    "apikey",
    "privatekey",
  ].some((suffix) => normalized.endsWith(suffix));
}

function sanitizeFailureValue(
  value: unknown,
  key: string,
  depth: number,
  ancestors: WeakSet<object>,
): unknown {
  if (isCredentialKey(key)) return "[REDACTED]";
  if (typeof value === "string") {
    const redacted = value.replace(bearerToken, "Bearer [REDACTED]");
    const scrubbed = redacted.replace(credentialAssignment, "$1=[REDACTED]");
    return scrubbed.length <= maximumFailureStringLength
      ? scrubbed
      : `${scrubbed.slice(0, maximumFailureStringLength)}${truncatedFailureValue}`;
  }
  if (
    Buffer.isBuffer(value) ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value)
  ) {
    return "[OMITTED BINARY DATA]";
  }
  if (
    depth >= maximumFailureDepth &&
    value !== null &&
    typeof value === "object"
  ) {
    return truncatedFailureValue;
  }
  if (Array.isArray(value)) {
    const items = value
      .slice(0, maximumFailureArrayLength)
      .map((item) => sanitizeFailureValue(item, "", depth + 1, ancestors));
    if (value.length > maximumFailureArrayLength)
      items.push(truncatedFailureValue);
    return items;
  }
  if (value !== null && typeof value === "object") {
    if (ancestors.has(value)) return "[CIRCULAR]";
    ancestors.add(value);
    const entries = Object.entries(value);
    const sanitized = Object.fromEntries(
      entries
        .slice(0, maximumFailureObjectEntries)
        .map(([childKey, child]) => [
          childKey,
          sanitizeFailureValue(child, childKey, depth + 1, ancestors),
        ]),
    );
    if (entries.length > maximumFailureObjectEntries) {
      sanitized.__truncated__ = `${entries.length - maximumFailureObjectEntries} entries`;
    }
    ancestors.delete(value);
    return sanitized;
  }
  return value;
}

function errorProperty(error: unknown, key: string): unknown {
  return error !== null && typeof error === "object"
    ? Reflect.get(error, key)
    : undefined;
}

export function abletonToolFailurePayload(
  error: unknown,
): AbletonToolFailurePayload {
  const rawCode = errorProperty(error, "code");
  const rawRetryable = errorProperty(error, "retryable");
  const rawDetails = errorProperty(error, "details");
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "Ableton tool execution failed";
  const details = sanitizeFailureValue(rawDetails, "details", 0, new WeakSet());
  const payload: AbletonToolFailurePayload = {
    version: 1,
    code:
      typeof rawCode === "string" && rawCode.length > 0
        ? rawCode.slice(0, 128)
        : "tool_execution_failed",
    message: String(sanitizeFailureValue(message, "message", 0, new WeakSet())),
    retryable: typeof rawRetryable === "boolean" ? rawRetryable : false,
    details:
      details !== null && typeof details === "object" && !Array.isArray(details)
        ? (details as Readonly<Record<string, unknown>>)
        : {},
  };
  if (JSON.stringify(payload).length <= failureSanitizerOptions.maxBytes) {
    return payload;
  }
  return {
    ...payload,
    details: { truncated: "Failure details exceeded the bounded payload size" },
  };
}

export function serializeAbletonToolFailure(error: unknown): string {
  return `${abletonToolFailurePrefix}${JSON.stringify(
    abletonToolFailurePayload(error),
  )}`;
}

export function parseAbletonToolFailure(
  value: string | undefined,
): AbletonToolFailurePayload | undefined {
  if (value === undefined || !value.startsWith(abletonToolFailurePrefix)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(
      value.slice(abletonToolFailurePrefix.length),
    ) as Partial<AbletonToolFailurePayload>;
    if (
      parsed.version !== 1 ||
      typeof parsed.code !== "string" ||
      typeof parsed.message !== "string" ||
      typeof parsed.retryable !== "boolean" ||
      parsed.details === null ||
      typeof parsed.details !== "object" ||
      Array.isArray(parsed.details)
    ) {
      return undefined;
    }
    return parsed as AbletonToolFailurePayload;
  } catch {
    return undefined;
  }
}

export function failureToolResult(error: unknown): ToolResultObject {
  const payload = abletonToolFailurePayload(error);
  const serialized = `${abletonToolFailurePrefix}${JSON.stringify(payload)}`;
  const details = Object.keys(payload.details).length
    ? ` Details: ${JSON.stringify(payload.details)}`
    : "";
  return {
    resultType: "failure",
    textResultForLlm: `Ableton tool failed (${payload.code}): ${payload.message}.${details}`,
    error: serialized,
    sessionLog: serialized,
  };
}

function withStructuredFailures<T>(tool: Tool<T>): Tool<T> {
  const handler = tool.handler;
  const parameters = agentFacingParameters(tool.name, tool.parameters);
  const configuredTool =
    parameters === undefined ? tool : { ...tool, parameters };
  if (handler === undefined) return configuredTool;
  return {
    ...configuredTool,
    handler: async (params, invocation) => {
      const suppliedArguments =
        Reflect.get(invocation, "__abletonArgumentsValidated") === true
          ? invocation.arguments
          : params;
      const argumentError = abletonToolArgumentError(
        tool.name,
        parameters,
        suppliedArguments,
      );
      if (argumentError !== undefined) {
        return failureToolResult(argumentError);
      }
      try {
        return await handler(params, invocation);
      } catch (error) {
        return failureToolResult(error);
      }
    },
  };
}

async function requireAbletonConnection(
  services: AbletonToolServices,
): Promise<void> {
  const status = await services.getConnectionStatus();
  if (status.state !== "connected") {
    throw new AbletonToolPreconditionError(
      status.state === "error" ? status.code : "not_connected",
      status.state === "error"
        ? status.message
        : "Ableton Live must be connected before using this tool",
    );
  }
}

function requireConnectedTool<T extends Record<string, unknown>>(
  tool: Tool<T>,
  services: AbletonToolServices,
): Tool<T> {
  const handler = tool.handler;
  if (handler === undefined) return tool;
  return withStructuredFailures({
    ...tool,
    handler: async (params, invocation) => {
      return withCorrelation(invocation.toolCallId, async () => {
        await requireAbletonConnection(services);
        return handler(params, invocation);
      });
    },
  });
}

export function createAbletonTools(
  services: AbletonToolServices,
): AbletonToolSet {
  if (abletonToolMetadata.length > toolCatalogPolicy.maximumEagerTools) {
    throw new Error(
      "Ableton tool catalog exceeds the eager-registration limit; split it into deferred groups",
    );
  }
  const setSqlSearchTool = defineTool(SET_SQL_SEARCH_TOOL_NAME, {
    description: `Runs one bounded read-only SELECT or non-recursive CTE against these allowlisted public views.

Set schema: set_history_saves(save_id, saved_at, app_session_id, live_set_id, live_project_id, outcome, trigger); set_history_snapshots(snapshot_id, captured_at, app_session_id, live_set_id, live_project_id, tempo, track_count, scene_count, session_clip_count, arrangement_clip_count, device_count, cue_point_count); set_history_tracks(snapshot_id, captured_at, live_set_id, track_id, track_index, name, kind, volume, pan, muted, soloed, armed, group_track_id); set_history_devices(snapshot_id, captured_at, live_set_id, device_id, track_id, track_index, device_index, name, class_name, enabled, parameter_count); set_history_session_clips(snapshot_id, captured_at, live_set_id, clip_id, track_id, track_index, scene_id, scene_index, name, kind, length_beats, note_count); set_history_arrangement_clips(snapshot_id, captured_at, live_set_id, clip_id, track_id, track_index, name, kind, start_time, end_time, length_beats, note_count); set_history_scenes(snapshot_id, captured_at, live_set_id, scene_id, scene_index, name); set_history_cue_points(snapshot_id, captured_at, live_set_id, cue_point_id, name, time); set_history_trajectories(trajectory_id, occurred_at, app_session_id, agent_session_id, turn_id, tool_call_id, active_agent_id, live_set_id, live_project_id, trajectory_type, summary, tool_name, operation_id, action, mutation_target, target_identity_json, outcome, snapshot_id); set_history_agent_links(trajectory_id, occurred_at, app_session_id, live_set_id, agent_session_id, turn_id, tool_call_id, active_agent_id).

Agent schema: agent_history_sessions(record_id, occurred_at, app_session_id, agent_session_id, sdk_session_id, active_agent_id, live_set_id, live_project_id, status); agent_history_turns(record_id, occurred_at, app_session_id, agent_session_id, turn_id, active_agent_id, live_set_id, status, completed_at, prompt, duration_ms); agent_history_messages(record_id, occurred_at, app_session_id, agent_session_id, turn_id, active_agent_id, live_set_id, role, content, message_index); agent_history_tool_calls(record_id, occurred_at, agent_session_id, turn_id, tool_call_id, live_set_id, status, tool_name, arguments_json, operation_id, action, mutation_target, target_identity_json); agent_history_tool_results(record_id, occurred_at, agent_session_id, turn_id, tool_call_id, live_set_id, outcome, duration_ms, result_json, error, tool_name, operation_id, action, mutation_target, target_identity_json); agent_history_approvals(record_id, occurred_at, agent_session_id, turn_id, tool_call_id, live_set_id, status, resolved_at, summary).

Join musical entities to snapshots with snapshot_id. Join trajectories to agent history with agent_session_id, turn_id, or tool_call_id; app_session_id and live_set_id provide broader ownership. First discover recent snapshot/trajectory IDs, then request bounded detail. Example: SELECT snapshot_id, captured_at, track_count FROM set_history_snapshots WHERE live_set_id = :liveSetId ORDER BY captured_at DESC LIMIT 10. Example detail: SELECT role, occurred_at, content FROM agent_history_messages WHERE turn_id = :turnId ORDER BY occurred_at, message_index LIMIT 20.

Select only needed columns; filter narrowly by Live Set, time range, and IDs using named scalar parameters; use a modest LIMIT; query summaries and IDs before details; avoid SELECT *, broad joins, broad scans, and recursive CTEs. If truncated, narrow the query instead of increasing scope. The set-history-sql-search skill provides deeper comparison and interpretation patterns but is not required for basic queries.`,
    parameters: z
      .object({
        sql: z
          .string()
          .trim()
          .min(1)
          .max(20_000)
          .describe("One SELECT or WITH query over public Set History views"),
        parameters: z
          .record(
            z
              .string()
              .max(SET_SQL_MAX_PARAMETER_NAME_LENGTH)
              .regex(/^[a-z_][a-z0-9_]*$/iu),
            z.union([
              z.string().max(SET_SQL_MAX_CELL_CHARACTERS),
              z.number().finite(),
              z.boolean(),
              z.null(),
            ]),
          )
          .refine(
            (value) => Object.keys(value).length <= SET_SQL_MAX_PARAMETERS,
            `At most ${SET_SQL_MAX_PARAMETERS} named parameters are allowed`,
          )
          .optional()
          .describe(
            "Named scalar bindings referenced as :name, @name, or $name in SQL",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(SET_SQL_MAX_ROWS)
          .default(SET_SQL_DEFAULT_MAX_ROWS)
          .describe("Maximum result rows returned"),
      })
      .strict(),
    handler: async ({ sql, parameters, limit }, invocation) => {
      if (services.setHistoryQuery === undefined) {
        throw new AbletonToolPreconditionError(
          "set_history_unavailable",
          "Set History search is not configured",
        );
      }
      const signal = (invocation as { signal?: AbortSignal }).signal;
      if (signal?.aborted === true) {
        throw new AbletonToolPreconditionError(
          "cancelled",
          "Set History search was cancelled",
        );
      }
      const boundQuery = bindSetSqlParameters(
        validateSetSqlSearch(sql),
        parameters,
      );
      const result = await services.setHistoryQuery.query({
        sql: boundQuery.sql,
        parameters: boundQuery.parameters,
        maxRows: limit,
        ...(signal === undefined ? {} : { signal }),
      });
      return boundSetSqlSearchResult(result, limit);
    },
  });
  const sessionTool = defineTool("ableton_session", {
    description:
      "Checks the Ableton Live Remote Script bridge connection or inspects the current set, including transport, tempo, time signature, and track summaries.",
    parameters: abletonSessionParamsSchema,
    handler: async (params) => {
      switch (params.action) {
        case "connection-status":
          return services.getConnectionStatus();
        case "inspect":
          await requireAbletonConnection(services);
          return services.inspectSession();
      }
    },
  });
  const scenesTool = defineTool("ableton_scenes", {
    description:
      "Lists, inspects, creates, duplicates, renames, recolors, configures, fires, or deletes Live 11 scenes using strict action variants and exact runtime identities. Scene stop is intentionally unavailable because Live 11 does not expose a scene-scoped stop operation.",
    parameters: scenesOperationParamsSchema,
    handler: async (params) =>
      verifyOperationResultAction(
        params.action,
        scenesOperationResultSchema.parse(
          await services.executeScenesOperation!(params),
        ),
      ),
  });
  const tracksTool = defineTool("ableton_tracks", {
    description:
      "Lists, inspects, creates, renames, and performs supported Live 11 track actions with exact identity checks. It does not provide arbitrary track reordering.",
    parameters: abletonTracksParamsSchema,
    handler: async (params) => {
      switch (params.action) {
        case "create": {
          const { action: _action, ...input } = params;
          return services.createTrack(input);
        }
        case "rename": {
          const { action: _action, ...input } = params;
          return services.renameTrack(input);
        }
        default:
          return verifyOperationResultAction(
            params.action,
            tracksOperationResultSchema.parse(
              await services.executeTracksOperation!(params),
            ),
          );
      }
    },
  });
  const mixerRoutingTool = defineTool("ableton_mixer_routing", {
    description:
      "Inspects or changes Live 11 track, return, and master mixer state; reads bounded meters; and discovers or assigns routing through exact recent snapshot tokens with feedback and external-MIDI warnings.",
    parameters: abletonMixerRoutingParamsSchema,
    handler: async (params) => {
      if (params.action === "set-track-mixer") {
        const { action: _action, ...input } = params;
        return services.setTrackMixer(input);
      }
      return verifyOperationResultAction(
        params.action,
        mixerRoutingOperationResultSchema.parse(
          await services.executeMixerRoutingOperation!(params),
        ),
      );
    },
  });
  const transportTool = defineTool("ableton_transport", {
    description:
      "Inspects and controls Live 11 song position, time signature, metronome, launch and record quantization, Link when exposed, cue names/jumps, and Back to Arrangement. Recording controls are intentionally excluded.",
    parameters: abletonTransportParamsSchema,
    handler: async (params) => {
      switch (params.action) {
        case "set-tempo":
          return services.setTempo(params.tempo);
        case "set-playing":
          return services.setPlaying(params.isPlaying);
        case "inspect-arrangement": {
          const { action: _action, ...input } = params;
          return services.inspectArrangementTransport(input);
        }
        case "set-arrangement-loop": {
          const { action: _action, ...input } = params;
          return services.setArrangementLoop(input);
        }
        case "create-cue-point": {
          const { action: _action, ...input } = params;
          return services.createCuePoint(input);
        }
        case "delete-cue-point": {
          const { action: _action, ...input } = params;
          return services.deleteCuePoint(input);
        }
        default:
          return verifyOperationResultAction(
            params.action,
            transportOperationResultSchema.parse(
              await services.executeTransportOperation!(params),
            ),
          );
      }
    },
  });
  const midiNotesTool = defineTool("ableton_midi_notes", {
    description:
      "Queries and edits identity-bound Live 11 MIDI notes through modern note IDs, including destructive removal and probability, velocity deviation, and release velocity. It does not edit per-note expression.",
    parameters: midiNotesOperationParamsSchema,
    handler: async (params) =>
      verifyOperationResultAction(
        params.action,
        midiNotesOperationResultSchema.parse(
          await services.executeMidiNotesOperation!(params),
        ),
      ),
  });
  const audioClipsTool = defineTool("ableton_audio_clips", {
    description:
      "Inspects and updates identity-bound Live 11 audio clip gain, pitch, warp, markers, and RAM state, and reads bounded warp markers. Warp-marker edits are exposed separately through ableton_warp_markers; unrestricted file import is unavailable.",
    parameters: audioClipsOperationParamsSchema,
    handler: async (params) =>
      verifyOperationResultAction(
        params.action,
        audioClipsOperationResultSchema.parse(
          await services.executeAudioClipsOperation!(params),
        ),
      ),
  });
  const recordingTool = defineTool("ableton_recording", {
    description:
      "Inspects and controls explicit Live 11 recording state, Capture MIDI to selected armed tracks, and exact empty-slot timed Session recording jobs. Launch and recording intent are distinct.",
    parameters: recordingOperationParamsSchema,
    handler: async (params) =>
      verifyOperationResultAction(
        params.action,
        recordingOperationResultSchema.parse(
          await services.executeRecordingOperation!(params),
        ),
      ),
  });
  const groovesTool = defineTool("ableton_grooves", {
    description:
      "Inspects Live 11 Groove Pool entries with revision-bound runtime handles, assigns or clears clip grooves, edits supported groove properties, and sets global groove amount. Groove creation, import, and removal are unavailable.",
    parameters: grooveOperationParamsSchema,
    handler: async (params) =>
      verifyOperationResultAction(
        params.action,
        grooveOperationResultSchema.parse(
          await services.executeGrooveOperation!(params),
        ),
      ),
  });
  const selectionViewTool = defineTool("ableton_selection_view", {
    description:
      "Reads and semantically updates exact Live selection and major view state without arbitrary property access.",
    parameters: selectionViewOperationParamsSchema,
    handler: async (params) =>
      verifyOperationResultAction(
        params.action,
        selectionViewOperationResultSchema.parse(
          await services.executeSelectionViewOperation!(params),
        ),
      ),
  });
  const liveHistoryTool = defineTool("ableton_live_history", {
    description:
      "Inspects or invokes Live's global undo/redo history. Undo and redo require the exact global-history confirmation because they can affect changes made outside Ableton Agent.",
    parameters: liveHistoryOperationParamsSchema,
    handler: async (params) =>
      verifyOperationResultAction(
        params.action,
        liveHistoryOperationResultSchema.parse(
          await services.executeLiveHistoryOperation!(params),
        ),
      ),
  });
  const browserAdaptersTool = defineTool("ableton_browser_adapters", {
    description:
      "Uses capability-detected Live 11 Browser preview and tested private Hot-Swap/insertion adapters while restoring selection and Browser state. No deterministic direct native insertion or empty-chain creation is claimed.",
    parameters: browserAdapterOperationParamsSchema,
    handler: async (params) =>
      verifyOperationResultAction(
        params.action,
        browserAdapterOperationResultSchema.parse(
          await services.executeBrowserAdapterOperation!(params),
        ),
      ),
  });
  const clipAutomationTool = defineTool("ableton_clip_automation", {
    description:
      "Discovers, samples, inserts bounded steps into, or explicitly clears Session clip automation envelopes. Arrangement automation is unavailable.",
    parameters: clipAutomationOperationParamsSchema,
    handler: async (params) =>
      verifyOperationResultAction(
        params.action,
        clipAutomationOperationResultSchema.parse(
          await services.executeClipAutomationOperation!(params),
        ),
      ),
  });
  const warpMarkersTool = defineTool("ableton_warp_markers", {
    description:
      "Inspects or mutates identity-bound audio clip warp markers using an exact marker snapshot revision, ordered coordinates, bounded BPM, verified readback, and safe compensation when possible.",
    parameters: warpMarkerOperationParamsSchema,
    handler: async (params) =>
      verifyOperationResultAction(
        params.action,
        warpMarkerOperationResultSchema.parse(
          await services.executeWarpMarkerOperation!(params),
        ),
      ),
  });
  const specializedDevicesTool = defineTool("ableton_special_devices", {
    description:
      "Provides only capability-detected Live 11 Simpler marker/slice, Looper control/export, and Wavetable modulation operations for exact devices.",
    parameters: specializedDeviceOperationParamsSchema,
    handler: async (params) =>
      verifyOperationResultAction(
        params.action,
        specializedDeviceOperationResultSchema.parse(
          await services.executeSpecializedDeviceOperation!(params),
        ),
      ),
  });
  const workflowJobsTool = defineTool("ableton_workflow_jobs", {
    description:
      "Lists, inspects, or cancels bounded asynchronous Live workflow jobs with lifecycle, progress, result, failure, and indeterminate reconnect state.",
    parameters: workflowJobOperationParamsSchema,
    handler: async (params) =>
      verifyOperationResultAction(
        params.action,
        workflowJobOperationResultSchema.parse(
          await services.executeWorkflowJobOperation!(params),
        ),
      ),
  });
  const sessionClipsTool = defineTool("ableton_session_clips", {
    description:
      "Creates, edits, launches, duplicates, deletes, or updates exact identity-bound Session View clips through strict action variants.",
    parameters: abletonSessionClipsParamsSchema,
    handler: async (params) => {
      switch (params.action) {
        case "create-midi": {
          const { action: _action, ...input } = params;
          return services.createMidiClip(input);
        }
        case "replace-notes": {
          const { action: _action, ...input } = params;
          return services.replaceMidiNotes(input);
        }
        case "launch": {
          const { action: _action, ...input } = params;
          return services.launchSessionClip(input);
        }
        case "duplicate": {
          const { action: _action, ...input } = params;
          return services.duplicateSessionClip(input);
        }
        case "delete": {
          const { action: _action, ...input } = params;
          return services.deleteSessionClip(input);
        }
        case "set-properties": {
          const { action: _action, ...input } = params;
          return services.setSessionClipProperties(input);
        }
      }
    },
  });
  const arrangementTool = defineTool("ableton_arrangement", {
    description:
      "Inspects and mutates exact identity-bound Arrangement clips, including one efficient long-running region-fill action that never decomposes into repeated agent calls.",
    parameters: abletonArrangementParamsSchema,
    handler: async (params) => {
      switch (params.action) {
        case "create-midi-clip": {
          const { action: _action, ...input } = params;
          return services.createArrangementMidiClip(input);
        }
        case "inspect": {
          const { action: _action, ...input } = params;
          return services.inspectArrangement(input);
        }
        case "delete-clip": {
          const { action: _action, ...input } = params;
          return services.deleteArrangementClip(input);
        }
        case "replace-notes": {
          const { action: _action, ...input } = params;
          return services.replaceArrangementMidiNotes(input);
        }
        case "duplicate-clip": {
          const { action: _action, ...input } = params;
          return services.duplicateClipToArrangement(input);
        }
        case "fill-region": {
          const { action: _action, ...input } = params;
          return services.fillArrangementRegion(input);
        }
        case "set-clip-properties": {
          const { action: _action, ...input } = params;
          return services.setArrangementClipProperties(input);
        }
      }
    },
  });
  const devicesTool = defineTool("ableton_devices", {
    description:
      "Inspects and mutates exact identity-bound Live 11 devices, parameters, rack chains, Drum Rack pads, chain mixers, and device positions through strict action variants.",
    parameters: abletonDevicesParamsSchema,
    handler: async (params) => {
      switch (params.action) {
        case "inspect": {
          const { action: _action, ...input } = params;
          return services.inspectDevices(input);
        }
        case "inspect-parameters": {
          const { action: _action, ...input } = params;
          return services.inspectDeviceParameters(input);
        }
        case "inspect-rack-chains": {
          const { action: _action, ...input } = params;
          return services.inspectRackChains(input);
        }
        case "inspect-rack-chain-devices": {
          const { action: _action, ...input } = params;
          return services.inspectRackChainDevices(input);
        }
        case "inspect-drum-rack-pads": {
          const { action: _action, includeEmpty, ...input } = params;
          const result = await services.inspectDrumRackPads(
            includeEmpty ? input : { ...input, offset: 0, limit: 128 },
          );
          if (includeEmpty) {
            return {
              ...result,
              totalPadCount: result.total,
              occupiedPadCount: result.pads.filter(
                ({ chainCount }) => chainCount > 0,
              ).length,
              emptyPadCount: result.pads.filter(
                ({ chainCount }) => chainCount === 0,
              ).length,
              returnedPadCount: result.pads.length,
              scanComplete:
                result.offset === 0 && result.pads.length >= result.total,
              includesEmptyPads: true,
            };
          }
          const occupiedPads = result.pads.filter(
            ({ chainCount }) => chainCount > 0,
          );
          return {
            ...result,
            pads: occupiedPads,
            totalPadCount: result.total,
            occupiedPadCount: occupiedPads.length,
            emptyPadCount: Math.max(0, result.total - occupiedPads.length),
            returnedPadCount: occupiedPads.length,
            scanComplete:
              result.offset === 0 && result.pads.length >= result.total,
            includesEmptyPads: false,
          };
        }
        case "inspect-drum-pad-chains": {
          const { action: _action, ...input } = params;
          return services.inspectDrumPadChains(input);
        }
        case "inspect-drum-pad-chain-devices": {
          const { action: _action, ...input } = params;
          return services.inspectDrumPadChainDevices(input);
        }
        case "inspect-chain-mixer": {
          const { action: _action, ...input } = params;
          return services.inspectChainMixer(input);
        }
        case "find-position": {
          const { action: _action, ...input } = params;
          return services.findDevicePosition(input);
        }
        case "move": {
          const { action: _action, ...input } = params;
          return services.moveDevice(input);
        }
        case "set-chain-properties": {
          const { action: _action, ...input } = params;
          return services.setChainProperties(input);
        }
        case "set-chain-mixer": {
          const { action: _action, ...input } = params;
          return services.setChainMixer(input);
        }
        case "set-enabled": {
          const { action: _action, ...input } = params;
          return services.setDeviceEnabled(input);
        }
        case "set-parameter": {
          const { action: _action, ...input } = params;
          return services.setDeviceParameter(input);
        }
      }
    },
  });
  const browserTool = defineTool("ableton_browser", {
    description:
      "Inspects, traverses, searches, and loads exact identity-bound Ableton Browser items through strict action variants.",
    parameters: abletonBrowserParamsSchema,
    handler: async (params) => {
      switch (params.action) {
        case "roots":
          return services.inspectBrowserRoots();
        case "children": {
          const { action: _action, ...input } = params;
          return services.inspectBrowserChildren(input);
        }
        case "search": {
          const { action: _action, ...input } = params;
          return services.searchBrowser(input);
        }
        case "search-external-plugins": {
          const { action: _action, ...input } = params;
          return services.searchBrowser({ ...input, roots: ["plugins"] });
        }
        case "load-item": {
          const { action: _action, ...input } = params;
          return services.loadBrowserItem(input);
        }
      }
    },
  });
  return {
    tools: [
      withStructuredFailures(sessionTool),
      requireConnectedTool(tracksTool, services),
      requireConnectedTool(mixerRoutingTool, services),
      requireConnectedTool(transportTool, services),
      requireConnectedTool(sessionClipsTool, services),
      requireConnectedTool(arrangementTool, services),
      requireConnectedTool(devicesTool, services),
      requireConnectedTool(browserTool, services),
      requireConnectedTool(scenesTool, services),
      requireConnectedTool(midiNotesTool, services),
      requireConnectedTool(audioClipsTool, services),
      requireConnectedTool(recordingTool, services),
      requireConnectedTool(groovesTool, services),
      requireConnectedTool(selectionViewTool, services),
      requireConnectedTool(liveHistoryTool, services),
      requireConnectedTool(browserAdaptersTool, services),
      requireConnectedTool(clipAutomationTool, services),
      requireConnectedTool(warpMarkersTool, services),
      requireConnectedTool(specializedDevicesTool, services),
      requireConnectedTool(workflowJobsTool, services),
      withStructuredFailures(setSqlSearchTool),
    ],
    availableTools: [
      ...new Set(
        abletonToolMetadata.map((metadata) => `custom:${metadata.name}`),
      ),
    ],
  };
}

export interface ScopeAbletonToolsOptions {
  readonly allowedToolNames: readonly string[];
  readonly allowedOperationIds?: readonly string[];
  readonly capabilities?: Readonly<Record<string, boolean>>;
}

export function scopeAbletonTools(
  toolSet: AbletonToolSet,
  options: ScopeAbletonToolsOptions,
): Tool[] {
  const allowedTools = new Set(options.allowedToolNames);
  const allowedOperations =
    options.allowedOperationIds === undefined
      ? undefined
      : new Set(options.allowedOperationIds);
  return (toolSet.tools as unknown as Tool[]).flatMap((tool) => {
    if (!allowedTools.has(tool.name)) return [];
    const descriptors = abletonOperationDescriptors.filter(
      (descriptor) => descriptor.toolName === tool.name,
    );
    if (descriptors.length === 0) return [tool];
    const selected = descriptors.filter(
      (descriptor) =>
        (allowedOperations === undefined ||
          allowedOperations.has(descriptor.operationId)) &&
        (options.capabilities === undefined ||
          options.capabilities[descriptor.requiredCapability] === true),
    );
    if (selected.length === 0) return [];
    if (selected.length === descriptors.length) return [tool];
    const parameters =
      selected.length === 1
        ? selected[0]!.inputSchema
        : z.union(
            selected.map((descriptor) => descriptor.inputSchema) as [
              ZodType,
              ZodType,
              ...ZodType[],
            ],
          );
    const scopedParameters = agentFacingParameters(tool.name, parameters);
    if (scopedParameters === undefined) return [tool];
    if (tool.handler === undefined) {
      return [{ ...tool, parameters: scopedParameters }];
    }
    const handler = tool.handler;
    return [
      {
        ...tool,
        parameters: scopedParameters,
        handler: async (params, invocation) => {
          const argumentError = abletonToolArgumentError(
            tool.name,
            scopedParameters,
            params,
          );
          return argumentError === undefined
            ? handler(params, invocation)
            : failureToolResult(argumentError);
        },
      },
    ];
  });
}

export * from "./mutation-policy.js";
export * from "./operation-descriptor.js";
