import { homedir } from "node:os";
import { join } from "node:path";

import type { AbletonService } from "@ableton-agent/ableton-contracts";
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
  abletonToolMetadata,
  createAbletonPermissionHandler,
  createAbletonTools,
  type ToolApprovalRequester,
} from "@ableton-agent/tools";
import {
  CopilotClient,
  type ResumeSessionConfig,
  type SessionConfig,
  type SessionEvent,
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

export class CopilotAgentService implements AgentService {
  readonly #clientFactory: () => CopilotClientAdapter;
  #client: CopilotClientAdapter | undefined;
  #session: CopilotSessionAdapter | undefined;
  #unsubscribe: (() => void) | undefined;
  #inFlightTurns = 0;
  #turnQueue: Promise<void> = Promise.resolve();
  #turnKind: "user" | "automatic-analysis" | "automatic-action" | undefined;
  #automaticDrainScheduled = false;
  readonly #pendingAutomatic = new Map<
    string,
    {
      request: SignalTurnRequest;
      deliveryIds: string[];
      waiters: Array<{
        resolve: (response: string) => void;
        reject: (reason: unknown) => void;
      }>;
    }
  >();
  readonly #operations = new Map<
    string,
    {
      label: string;
      toolName: string;
      arguments: Readonly<Record<string, unknown>>;
    }
  >();
  readonly #logger: Logger;

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
    return this.#session?.sessionId;
  }

  #sessionConfig(): SessionConfig {
    const toolSet = createAbletonTools({
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

    const agentPolicy = createAgentPolicy({
      getAbletonStatus: this.options.getAbletonStatus,
      inspectSession: this.options.inspectSession,
      ...(this.options.signalContext === undefined
        ? {}
        : { signalContext: this.options.signalContext }),
      promptContextEnabled: () => this.#turnKind === "user",
      mutationBlocked: () => this.#turnKind === "automatic-analysis",
    });
    const permissionHandler = createAbletonPermissionHandler(
      this.options.requestToolApproval,
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
      tools: toolSet.tools,
      availableTools: toolSet.availableTools,
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

  #observe(session: CopilotSessionAdapter): void {
    this.#unsubscribe = session.on((event) => {
      if (event.type === "assistant.message_delta") {
        this.options.events.publish({
          type: "agent.message_delta",
          content: event.data.deltaContent,
        });
      } else if (event.type === "tool.execution_start") {
        const metadata = abletonToolMetadata.find(
          (candidate) => candidate.name === event.data.toolName,
        );
        const label = metadata?.title ?? event.data.toolName;
        this.#operations.set(event.data.toolCallId, {
          label,
          toolName: event.data.toolName,
          arguments: event.data.arguments ?? {},
        });
        this.#logger.debug("Agent tool started", {
          sessionId: session.sessionId,
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
        });
      } else if (event.type === "tool.execution_complete") {
        const operation = this.#operations.get(event.data.toolCallId);
        const label = operation?.label ?? "Tool operation";
        this.#operations.delete(event.data.toolCallId);
        if (event.data.success) {
          this.#logger.debug("Agent tool completed", {
            sessionId: session.sessionId,
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
          });
        } else {
          this.#logger.warn("Agent tool failed", {
            sessionId: session.sessionId,
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
          });
        }
      }
    });
  }

  async #abortTimedOutTurn(
    session: CopilotSessionAdapter,
    timeoutMs: number,
  ): Promise<never> {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    for (const [operationId, operation] of this.#operations) {
      this.options.events.publish({
        type: "operation.failed",
        operationId,
        code: "operation_timeout",
        message: `${operation.label} cancelled because the Copilot turn timed out`,
        toolName: operation.toolName,
      });
    }
    this.#operations.clear();

    let abortError: unknown;
    try {
      await session.abort();
    } catch (error) {
      abortError = error;
    }
    if (abortError === undefined && this.#session === session) {
      this.#observe(session);
    } else if (abortError !== undefined && this.#session === session) {
      this.#session = undefined;
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
    if (this.#session) {
      return;
    }

    const client = this.#clientFactory();
    try {
      let session: CopilotSessionAdapter;
      if (preferredSessionId === undefined) {
        session = await client.createSession(this.#sessionConfig());
      } else {
        try {
          session = await client.resumeSession(
            preferredSessionId,
            this.#sessionConfig(),
          );
        } catch {
          session = await client.createSession(this.#sessionConfig());
        }
      }
      this.#client = client;
      this.#session = session;
      this.#observe(session);
      this.#logger.info("Agent session started", {
        sessionId: session.sessionId,
        preferredSessionId,
      });
    } catch (error) {
      await client.stop();
      throw error;
    }
  }

  public async createSession(): Promise<string> {
    const client = this.#client;
    if (!client) {
      throw new Error("Copilot agent service is not started");
    }
    const session = await client.createSession(this.#sessionConfig());
    await this.#replaceSession(session);
    this.#logger.info("Agent session created", {
      sessionId: session.sessionId,
    });
    return session.sessionId;
  }

  public async resumeSession(sessionId: string): Promise<void> {
    const client = this.#client;
    if (!client) {
      throw new Error("Copilot agent service is not started");
    }
    if (this.#session?.sessionId === sessionId) {
      return;
    }
    const session = await client.resumeSession(
      sessionId,
      this.#sessionConfig(),
    );
    await this.#replaceSession(session);
    this.#logger.info("Agent session resumed", { sessionId });
  }

  public async cancel(): Promise<boolean> {
    const session = this.#session;
    if (!session || this.#inFlightTurns === 0) {
      return false;
    }
    await session.abort();
    return true;
  }

  async #replaceSession(session: CopilotSessionAdapter): Promise<void> {
    const previous = this.#session;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#operations.clear();
    this.#session = session;
    this.#observe(session);
    if (previous) {
      await previous.disconnect();
    }
  }

  public async stop(): Promise<void> {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    const session = this.#session;
    const client = this.#client;
    this.#session = undefined;
    this.#client = undefined;
    this.#operations.clear();
    if (session) {
      await session.disconnect();
    }
    if (client) {
      await client.stop();
    }
  }

  async #sendNow(
    prompt: string,
    kind: "user" | "automatic-analysis" | "automatic-action",
  ): Promise<string> {
    const session = this.#session;
    if (!session) {
      throw new Error("Copilot agent service is not started");
    }
    const timeoutMs =
      this.options.turnTimeoutMs ?? DEFAULT_AGENT_TURN_TIMEOUT_MS;
    const startedAt = Date.now();
    this.#logger.debug("Agent turn started", {
      sessionId: session.sessionId,
      kind,
      prompt,
      timeoutMs,
    });
    this.#inFlightTurns += 1;
    this.#turnKind = kind;
    let response: CopilotResponse | undefined;
    try {
      response = await session.sendAndWait(prompt, timeoutMs);
    } catch (error) {
      this.#logger.error("Agent turn failed", {
        sessionId: session.sessionId,
        kind,
        prompt,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      if (isSessionIdleTimeout(error)) {
        return await this.#abortTimedOutTurn(session, timeoutMs);
      }
      throw error;
    } finally {
      this.#inFlightTurns -= 1;
      this.#turnKind = undefined;
    }
    if (!response) {
      throw new Error(
        "Copilot session completed without an assistant response",
      );
    }
    this.options.events.publish({
      type: "agent.message_complete",
      content: response.data.content,
    });
    this.#logger.debug("Agent turn completed", {
      sessionId: session.sessionId,
      kind,
      prompt,
      response: response.data.content,
      durationMs: Date.now() - startedAt,
    });
    return response.data.content;
  }

  #serialize<T>(run: () => Promise<T>): Promise<T> {
    const result = this.#turnQueue.then(run, run);
    this.#turnQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  public send(prompt: string): Promise<string> {
    return this.#serialize(() => this.#sendNow(prompt, "user"));
  }

  public enqueueSignalTurn(request: SignalTurnRequest): Promise<string> {
    const sessionId = this.#session?.sessionId;
    if (sessionId === undefined) {
      return Promise.reject(new Error("Copilot agent service is not started"));
    }
    const key = `${sessionId}:${request.context.assignmentId}`;
    return new Promise<string>((resolve, reject) => {
      const pending = this.#pendingAutomatic.get(key);
      if (pending === undefined) {
        this.#pendingAutomatic.set(key, {
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
      if (!this.#automaticDrainScheduled) {
        this.#automaticDrainScheduled = true;
        void this.#serialize(async () => {
          try {
            while (this.#pendingAutomatic.size > 0) {
              const next = this.#pendingAutomatic.entries().next().value as
                | [
                    string,
                    {
                      request: SignalTurnRequest;
                      deliveryIds: string[];
                      waiters: Array<{
                        resolve: (response: string) => void;
                        reject: (reason: unknown) => void;
                      }>;
                    },
                  ]
                | undefined;
              if (next === undefined) break;
              const [pendingKey, item] = next;
              this.#pendingAutomatic.delete(pendingKey);
              try {
                if (this.#session?.sessionId !== sessionId) {
                  throw new Error(
                    "Signal turn session changed before delivery",
                  );
                }
                const response = await this.#sendNow(
                  formatAutomaticSignalPrompt(
                    item.request,
                    this.options.signalContext,
                  ),
                  item.request.context.deliveryMode,
                );
                await this.options.signalContext?.provider?.markDelivered(
                  sessionId,
                  item.deliveryIds,
                );
                for (const waiter of item.waiters) waiter.resolve(response);
              } catch (error) {
                for (const waiter of item.waiters) waiter.reject(error);
              }
            }
          } finally {
            this.#automaticDrainScheduled = false;
          }
        });
      }
    });
  }
}

export class HeadlessApplication {
  #state: LifecycleState = "stopped";

  public constructor(private readonly services: ApplicationServices) {}

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
