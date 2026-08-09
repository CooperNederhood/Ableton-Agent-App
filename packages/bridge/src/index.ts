import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";

import type { AbletonService } from "@ableton-agent/ableton-contracts";
import {
  FrameDecoder,
  PROTOCOL_VERSION,
  capabilityDocumentSchema,
  createCuePointParamsSchema,
  cuePointMutationResultSchema,
  createArrangementMidiClipParamsSchema,
  createArrangementMidiClipResultSchema,
  deleteArrangementClipParamsSchema,
  deleteArrangementClipResultSchema,
  deleteCuePointParamsSchema,
  duplicateClipToArrangementParamsSchema,
  duplicateClipToArrangementResultSchema,
  duplicateSessionClipParamsSchema,
  duplicateSessionClipResultSchema,
  createMidiClipParamsSchema,
  createMidiClipResultSchema,
  createTrackParamsSchema,
  deleteTrackParamsSchema,
  deleteSessionClipParamsSchema,
  deleteSessionClipResultSchema,
  inspectDeviceParametersParamsSchema,
  inspectDeviceParametersResultSchema,
  inspectDevicesParamsSchema,
  inspectDevicesResultSchema,
  inspectBrowserRootsParamsSchema,
  inspectBrowserRootsResultSchema,
  inspectBrowserChildrenParamsSchema,
  inspectBrowserChildrenResultSchema,
  searchBrowserParamsSchema,
  searchBrowserResultSchema,
  loadBrowserItemParamsSchema,
  loadBrowserItemResultSchema,
  inspectDrumPadChainDevicesParamsSchema,
  inspectDrumPadChainDevicesResultSchema,
  inspectDrumPadChainsParamsSchema,
  inspectDrumPadChainsResultSchema,
  inspectDrumRackPadsParamsSchema,
  inspectDrumRackPadsResultSchema,
  inspectRackChainDevicesParamsSchema,
  inspectRackChainDevicesResultSchema,
  inspectRackChainsParamsSchema,
  inspectRackChainsResultSchema,
  encodeFrame,
  pingResultSchema,
  sessionSnapshotSchema,
  setPlayingParamsSchema,
  setPlayingResultSchema,
  renameTrackParamsSchema,
  renameTrackResultSchema,
  inspectArrangementParamsSchema,
  inspectArrangementResultSchema,
  inspectArrangementTransportParamsSchema,
  inspectArrangementTransportResultSchema,
  launchSessionClipParamsSchema,
  launchSessionClipResultSchema,
  replaceMidiNotesParamsSchema,
  replaceMidiNotesResultSchema,
  replaceArrangementMidiNotesParamsSchema,
  replaceArrangementMidiNotesResultSchema,
  setArrangementClipPropertiesParamsSchema,
  setArrangementClipPropertiesResultSchema,
  setArrangementLoopParamsSchema,
  setArrangementLoopResultSchema,
  setSessionClipPropertiesParamsSchema,
  setSessionClipPropertiesResultSchema,
  setTrackMixerParamsSchema,
  setTrackMixerResultSchema,
  setDeviceEnabledParamsSchema,
  setDeviceEnabledResultSchema,
  setDeviceParameterParamsSchema,
  setDeviceParameterResultSchema,
  setTempoParamsSchema,
  setTempoResultSchema,
  trackMutationResultSchema,
  type CapabilityDocument,
  type CreateCuePointParams,
  type CuePointMutationResult,
  type CreateArrangementMidiClipParams,
  type CreateArrangementMidiClipResult,
  type DeleteArrangementClipParams,
  type DeleteArrangementClipResult,
  type DeleteCuePointParams,
  type DuplicateClipToArrangementParams,
  type DuplicateClipToArrangementResult,
  type DuplicateSessionClipParams,
  type DuplicateSessionClipResult,
  type CreateMidiClipParams,
  type CreateMidiClipResult,
  type CreateTrackParams,
  type DeleteTrackParams,
  type DeleteSessionClipParams,
  type DeleteSessionClipResult,
  type InspectDeviceParametersParams,
  type InspectDeviceParametersResult,
  type InspectDevicesParams,
  type InspectDevicesResult,
  type InspectBrowserRootsResult,
  type InspectBrowserChildrenParams,
  type InspectBrowserChildrenResult,
  type SearchBrowserParams,
  type SearchBrowserResult,
  type LoadBrowserItemParams,
  type LoadBrowserItemResult,
  type InspectDrumPadChainDevicesParams,
  type InspectDrumPadChainDevicesResult,
  type InspectDrumPadChainsParams,
  type InspectDrumPadChainsResult,
  type InspectDrumRackPadsParams,
  type InspectDrumRackPadsResult,
  type InspectRackChainDevicesParams,
  type InspectRackChainDevicesResult,
  type InspectRackChainsParams,
  type InspectRackChainsResult,
  type MessageEnvelope,
  type PingResult,
  type RequestEnvelope,
  type ResponseEnvelope,
  type SessionSnapshot,
  type SetPlayingResult,
  type RenameTrackParams,
  type RenameTrackResult,
  type InspectArrangementParams,
  type InspectArrangementResult,
  type InspectArrangementTransportParams,
  type InspectArrangementTransportResult,
  type LaunchSessionClipParams,
  type LaunchSessionClipResult,
  type ReplaceMidiNotesParams,
  type ReplaceMidiNotesResult,
  type ReplaceArrangementMidiNotesParams,
  type ReplaceArrangementMidiNotesResult,
  type SetArrangementClipPropertiesParams,
  type SetArrangementClipPropertiesResult,
  type SetArrangementLoopParams,
  type SetArrangementLoopResult,
  type SetSessionClipPropertiesParams,
  type SetSessionClipPropertiesResult,
  type SetTrackMixerParams,
  type SetTrackMixerResult,
  type SetDeviceEnabledParams,
  type SetDeviceEnabledResult,
  type SetDeviceParameterParams,
  type SetDeviceParameterResult,
  type SetTempoResult,
  type TrackMutationResult,
} from "@ableton-agent/protocol";
import type { ConnectionStatus, EventPublisher } from "@ableton-agent/shared";

export interface AbletonBridgeOptions {
  authenticationToken: string;
  events: EventPublisher;
  host?: string;
  port?: number;
  appVersion?: string;
  requestTimeoutMs?: number;
}

interface PendingRequest {
  resolve(response: ResponseEnvelope): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
}

export class AbletonBridgeError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
    public readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "AbletonBridgeError";
  }
}

export class AbletonBridgeService implements AbletonService {
  readonly #host: string;
  readonly #port: number;
  readonly #appVersion: string;
  readonly #requestTimeoutMs: number;
  readonly #decoder = new FrameDecoder();
  readonly #pending = new Map<string, PendingRequest>();
  #mutationTail: Promise<void> = Promise.resolve();
  #socket: Socket | undefined;
  #status: ConnectionStatus = { state: "disconnected" };
  #capabilities: CapabilityDocument | undefined;
  #connectionGeneration = 0;
  #handshakeComplete = false;

  public constructor(private readonly options: AbletonBridgeOptions) {
    if (options.authenticationToken.length < 32) {
      throw new Error(
        "Ableton bridge authentication token must be at least 32 characters",
      );
    }
    this.#host = options.host ?? "127.0.0.1";
    this.#port = options.port ?? 8765;
    this.#appVersion = options.appVersion ?? "0.1.0";
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
  }

  public async start(): Promise<void> {
    if (this.#socket) {
      return;
    }
    this.#setStatus({ state: "connecting" });

    try {
      await this.#connect();
      const result = await this.#request("system.hello", {
        authenticationToken: this.options.authenticationToken,
        supportedProtocolVersions: [PROTOCOL_VERSION],
        appVersion: this.#appVersion,
        eventSubscriptions: [],
      });
      const capabilities = capabilityDocumentSchema.parse(result);
      this.#capabilities = capabilities;
      this.#handshakeComplete = true;
      this.#setStatus({
        state: "connected",
        liveVersion: capabilities.liveVersion,
        remoteScriptVersion: capabilities.remoteScriptVersion,
        projectId: capabilities.projectId,
      });
    } catch (error) {
      this.#destroySocket();
      this.#setStatus({
        state: "error",
        code:
          error instanceof AbletonBridgeError
            ? error.code
            : "connection_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  public async stop(): Promise<void> {
    this.#destroySocket();
    this.#setStatus({ state: "disconnected" });
  }

  public async getStatus(): Promise<ConnectionStatus> {
    return this.#status;
  }

  public async getCapabilities(): Promise<CapabilityDocument> {
    if (!this.#capabilities) {
      throw new AbletonBridgeError(
        "not_connected",
        "Ableton capabilities are unavailable before handshake",
        true,
      );
    }
    return this.#capabilities;
  }

  public async ping(): Promise<PingResult> {
    return pingResultSchema.parse(await this.#request("system.ping", {}));
  }

  public async inspectSession(): Promise<SessionSnapshot> {
    return sessionSnapshotSchema.parse(
      await this.#request("session.inspect", {}),
    );
  }

  public async setTempo(tempo: number): Promise<SetTempoResult> {
    this.#requireCapability("transport.set_tempo");
    const params = setTempoParamsSchema.parse({ tempo });
    return setTempoResultSchema.parse(
      await this.#mutationRequest("transport.set_tempo", params),
    );
  }

  public async setPlaying(isPlaying: boolean): Promise<SetPlayingResult> {
    this.#requireCapability("transport.set_playing");
    const params = setPlayingParamsSchema.parse({ isPlaying });
    return setPlayingResultSchema.parse(
      await this.#mutationRequest("transport.set_playing", params),
    );
  }

  public async inspectArrangementTransport(
    params: InspectArrangementTransportParams,
  ): Promise<InspectArrangementTransportResult> {
    this.#requireCapability("transport.inspect_arrangement");
    const validated = inspectArrangementTransportParamsSchema.parse(params);
    return inspectArrangementTransportResultSchema.parse(
      await this.#request("transport.inspect_arrangement", validated),
    );
  }

  public async setArrangementLoop(
    params: SetArrangementLoopParams,
  ): Promise<SetArrangementLoopResult> {
    this.#requireCapability("transport.set_arrangement_loop");
    const validated = setArrangementLoopParamsSchema.parse(params);
    return setArrangementLoopResultSchema.parse(
      await this.#mutationRequest("transport.set_arrangement_loop", validated),
    );
  }

  public async createCuePoint(
    params: CreateCuePointParams,
  ): Promise<CuePointMutationResult> {
    this.#requireCapability("transport.create_cue_point");
    const validated = createCuePointParamsSchema.parse(params);
    return cuePointMutationResultSchema.parse(
      await this.#mutationRequest("transport.create_cue_point", validated),
    );
  }

  public async deleteCuePoint(
    params: DeleteCuePointParams,
  ): Promise<CuePointMutationResult> {
    this.#requireCapability("transport.delete_cue_point");
    const validated = deleteCuePointParamsSchema.parse(params);
    return cuePointMutationResultSchema.parse(
      await this.#mutationRequest("transport.delete_cue_point", validated),
    );
  }

  public async createTrack(
    params: CreateTrackParams,
  ): Promise<TrackMutationResult> {
    this.#requireCapability("tracks.create");
    const validated = createTrackParamsSchema.parse(params);
    return trackMutationResultSchema.parse(
      await this.#mutationRequest("tracks.create", validated),
    );
  }

  public async deleteTrack(
    params: DeleteTrackParams,
  ): Promise<TrackMutationResult> {
    this.#requireCapability("tracks.delete");
    const validated = deleteTrackParamsSchema.parse(params);
    return trackMutationResultSchema.parse(
      await this.#mutationRequest("tracks.delete", validated),
    );
  }

  public async renameTrack(
    params: RenameTrackParams,
  ): Promise<RenameTrackResult> {
    this.#requireCapability("tracks.rename");
    const validated = renameTrackParamsSchema.parse(params);
    return renameTrackResultSchema.parse(
      await this.#mutationRequest("tracks.rename", validated),
    );
  }

  public async setTrackMixer(
    params: SetTrackMixerParams,
  ): Promise<SetTrackMixerResult> {
    this.#requireCapability("tracks.set_mixer");
    const validated = setTrackMixerParamsSchema.parse(params);
    return setTrackMixerResultSchema.parse(
      await this.#mutationRequest("tracks.set_mixer", validated),
    );
  }

  public async inspectDevices(
    params: InspectDevicesParams,
  ): Promise<InspectDevicesResult> {
    this.#requireCapability("devices.inspect");
    const validated = inspectDevicesParamsSchema.parse(params);
    return inspectDevicesResultSchema.parse(
      await this.#request("devices.inspect", validated),
    );
  }

  public async inspectBrowserRoots(): Promise<InspectBrowserRootsResult> {
    this.#requireCapability("browser.inspect_roots");
    return inspectBrowserRootsResultSchema.parse(
      await this.#request(
        "browser.inspect_roots",
        inspectBrowserRootsParamsSchema.parse({}),
      ),
    );
  }

  public async inspectBrowserChildren(
    params: InspectBrowserChildrenParams,
  ): Promise<InspectBrowserChildrenResult> {
    this.#requireCapability("browser.inspect_children");
    const validated = inspectBrowserChildrenParamsSchema.parse(params);
    return inspectBrowserChildrenResultSchema.parse(
      await this.#request("browser.inspect_children", validated),
    );
  }

  public async searchBrowser(
    params: SearchBrowserParams,
  ): Promise<SearchBrowserResult> {
    this.#requireCapability("browser.search");
    const validated = searchBrowserParamsSchema.parse(params);
    return searchBrowserResultSchema.parse(
      await this.#request("browser.search", validated),
    );
  }

  public async loadBrowserItem(
    params: LoadBrowserItemParams,
  ): Promise<LoadBrowserItemResult> {
    this.#requireCapability("browser.load_item");
    const validated = loadBrowserItemParamsSchema.parse(params);
    return loadBrowserItemResultSchema.parse(
      await this.#mutationRequest("browser.load_item", validated),
    );
  }

  public async inspectDeviceParameters(
    params: InspectDeviceParametersParams,
  ): Promise<InspectDeviceParametersResult> {
    this.#requireCapability("devices.inspect_parameters");
    const validated = inspectDeviceParametersParamsSchema.parse(params);
    return inspectDeviceParametersResultSchema.parse(
      await this.#request("devices.inspect_parameters", validated),
    );
  }

  public async inspectRackChains(
    params: InspectRackChainsParams,
  ): Promise<InspectRackChainsResult> {
    this.#requireCapability("devices.inspect_rack_chains");
    const validated = inspectRackChainsParamsSchema.parse(params);
    return inspectRackChainsResultSchema.parse(
      await this.#request("devices.inspect_rack_chains", validated),
    );
  }

  public async inspectRackChainDevices(
    params: InspectRackChainDevicesParams,
  ): Promise<InspectRackChainDevicesResult> {
    this.#requireCapability("devices.inspect_rack_chain_devices");
    const validated = inspectRackChainDevicesParamsSchema.parse(params);
    return inspectRackChainDevicesResultSchema.parse(
      await this.#request("devices.inspect_rack_chain_devices", validated),
    );
  }

  public async inspectDrumRackPads(
    params: InspectDrumRackPadsParams,
  ): Promise<InspectDrumRackPadsResult> {
    this.#requireCapability("devices.inspect_drum_rack_pads");
    const validated = inspectDrumRackPadsParamsSchema.parse(params);
    return inspectDrumRackPadsResultSchema.parse(
      await this.#request("devices.inspect_drum_rack_pads", validated),
    );
  }

  public async inspectDrumPadChains(
    params: InspectDrumPadChainsParams,
  ): Promise<InspectDrumPadChainsResult> {
    this.#requireCapability("devices.inspect_drum_pad_chains");
    const validated = inspectDrumPadChainsParamsSchema.parse(params);
    return inspectDrumPadChainsResultSchema.parse(
      await this.#request("devices.inspect_drum_pad_chains", validated),
    );
  }

  public async inspectDrumPadChainDevices(
    params: InspectDrumPadChainDevicesParams,
  ): Promise<InspectDrumPadChainDevicesResult> {
    this.#requireCapability("devices.inspect_drum_pad_chain_devices");
    const validated = inspectDrumPadChainDevicesParamsSchema.parse(params);
    return inspectDrumPadChainDevicesResultSchema.parse(
      await this.#request("devices.inspect_drum_pad_chain_devices", validated),
    );
  }

  public async setDeviceEnabled(
    params: SetDeviceEnabledParams,
  ): Promise<SetDeviceEnabledResult> {
    this.#requireCapability("devices.set_enabled");
    const validated = setDeviceEnabledParamsSchema.parse(params);
    return setDeviceEnabledResultSchema.parse(
      await this.#mutationRequest("devices.set_enabled", validated),
    );
  }

  public async setDeviceParameter(
    params: SetDeviceParameterParams,
  ): Promise<SetDeviceParameterResult> {
    this.#requireCapability("devices.set_parameter");
    const validated = setDeviceParameterParamsSchema.parse(params);
    return setDeviceParameterResultSchema.parse(
      await this.#mutationRequest("devices.set_parameter", validated),
    );
  }

  public async createMidiClip(
    params: CreateMidiClipParams,
  ): Promise<CreateMidiClipResult> {
    this.#requireCapability("clips.create_midi");
    const validated = createMidiClipParamsSchema.parse(params);
    return createMidiClipResultSchema.parse(
      await this.#mutationRequest("clips.create_midi", validated),
    );
  }

  public async replaceMidiNotes(
    params: ReplaceMidiNotesParams,
  ): Promise<ReplaceMidiNotesResult> {
    this.#requireCapability("clips.replace_notes");
    const validated = replaceMidiNotesParamsSchema.parse(params);
    return replaceMidiNotesResultSchema.parse(
      await this.#mutationRequest("clips.replace_notes", validated),
    );
  }

  public async launchSessionClip(
    params: LaunchSessionClipParams,
  ): Promise<LaunchSessionClipResult> {
    this.#requireCapability("clips.launch");
    const validated = launchSessionClipParamsSchema.parse(params);
    return launchSessionClipResultSchema.parse(
      await this.#mutationRequest("clips.launch", validated),
    );
  }

  public async duplicateSessionClip(
    params: DuplicateSessionClipParams,
  ): Promise<DuplicateSessionClipResult> {
    this.#requireCapability("clips.duplicate");
    const validated = duplicateSessionClipParamsSchema.parse(params);
    return duplicateSessionClipResultSchema.parse(
      await this.#mutationRequest("clips.duplicate", validated),
    );
  }

  public async deleteSessionClip(
    params: DeleteSessionClipParams,
  ): Promise<DeleteSessionClipResult> {
    this.#requireCapability("clips.delete");
    const validated = deleteSessionClipParamsSchema.parse(params);
    return deleteSessionClipResultSchema.parse(
      await this.#mutationRequest("clips.delete", validated),
    );
  }

  public async setSessionClipProperties(
    params: SetSessionClipPropertiesParams,
  ): Promise<SetSessionClipPropertiesResult> {
    this.#requireCapability("clips.set_properties");
    const validated = setSessionClipPropertiesParamsSchema.parse(params);
    return setSessionClipPropertiesResultSchema.parse(
      await this.#mutationRequest("clips.set_properties", validated),
    );
  }

  public async createArrangementMidiClip(
    params: CreateArrangementMidiClipParams,
  ): Promise<CreateArrangementMidiClipResult> {
    this.#requireCapability("arrangement.create_midi_clip");
    const validated = createArrangementMidiClipParamsSchema.parse(params);
    return createArrangementMidiClipResultSchema.parse(
      await this.#mutationRequest("arrangement.create_midi_clip", validated),
    );
  }

  public async inspectArrangement(
    params: InspectArrangementParams,
  ): Promise<InspectArrangementResult> {
    this.#requireCapability("arrangement.inspect");
    const validated = inspectArrangementParamsSchema.parse(params);
    return inspectArrangementResultSchema.parse(
      await this.#request("arrangement.inspect", validated),
    );
  }

  public async deleteArrangementClip(
    params: DeleteArrangementClipParams,
  ): Promise<DeleteArrangementClipResult> {
    this.#requireCapability("arrangement.delete_clip");
    const validated = deleteArrangementClipParamsSchema.parse(params);
    return deleteArrangementClipResultSchema.parse(
      await this.#mutationRequest("arrangement.delete_clip", validated),
    );
  }

  public async replaceArrangementMidiNotes(
    params: ReplaceArrangementMidiNotesParams,
  ): Promise<ReplaceArrangementMidiNotesResult> {
    this.#requireCapability("arrangement.replace_notes");
    const validated = replaceArrangementMidiNotesParamsSchema.parse(params);
    return replaceArrangementMidiNotesResultSchema.parse(
      await this.#mutationRequest("arrangement.replace_notes", validated),
    );
  }

  public async duplicateClipToArrangement(
    params: DuplicateClipToArrangementParams,
  ): Promise<DuplicateClipToArrangementResult> {
    this.#requireCapability("arrangement.duplicate_clip");
    const validated = duplicateClipToArrangementParamsSchema.parse(params);
    return duplicateClipToArrangementResultSchema.parse(
      await this.#mutationRequest("arrangement.duplicate_clip", validated),
    );
  }

  public async setArrangementClipProperties(
    params: SetArrangementClipPropertiesParams,
  ): Promise<SetArrangementClipPropertiesResult> {
    this.#requireCapability("arrangement.set_clip_properties");
    const validated = setArrangementClipPropertiesParamsSchema.parse(params);
    return setArrangementClipPropertiesResultSchema.parse(
      await this.#mutationRequest("arrangement.set_clip_properties", validated),
    );
  }

  #requireCapability(capability: string): void {
    if (!this.#capabilities?.capabilities[capability]) {
      throw new AbletonBridgeError(
        "unsupported_capability",
        `Ableton capability is unavailable: ${capability}`,
        false,
        { capability },
      );
    }
  }

  async #mutationRequest(
    command: string,
    params: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    const generation = this.#connectionGeneration;
    const previous = this.#mutationTail;
    let release: () => void = () => undefined;
    this.#mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      if (
        generation !== this.#connectionGeneration ||
        !this.#handshakeComplete
      ) {
        throw new AbletonBridgeError(
          "connection_closed",
          "Queued Ableton mutation belongs to a closed connection",
          true,
        );
      }
      return await this.#request(command, params, false);
    } catch (error) {
      if (
        error instanceof AbletonBridgeError &&
        error.code === "operation_timeout"
      ) {
        this.#destroySocket();
        this.#setStatus({
          state: "error",
          code: error.code,
          message: error.message,
        });
      }
      throw error;
    } finally {
      release();
    }
  }

  async #request(
    command: string,
    params: Readonly<Record<string, unknown>>,
    timeoutRetryable = true,
  ): Promise<unknown> {
    const socket = this.#socket;
    if (!socket || socket.destroyed) {
      throw new Error("Ableton bridge is not connected");
    }
    if (command !== "system.hello" && !this.#handshakeComplete) {
      throw new AbletonBridgeError(
        "connection_closed",
        "Ableton handshake is not complete",
        true,
      );
    }
    const requestId = randomUUID();
    const request: RequestEnvelope = {
      protocolVersion: PROTOCOL_VERSION,
      kind: "request",
      requestId,
      command,
      params: { ...params },
    };

    const response = new Promise<ResponseEnvelope>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(
          new AbletonBridgeError(
            "operation_timeout",
            `Ableton request timed out: ${command}`,
            timeoutRetryable,
            { command },
          ),
        );
      }, this.#requestTimeoutMs);
      this.#pending.set(requestId, { resolve, reject, timeout });
    });
    socket.write(encodeFrame(request));
    const envelope = await response;
    if (!envelope.ok) {
      throw new AbletonBridgeError(
        envelope.error.code,
        envelope.error.message,
        envelope.error.retryable,
        envelope.error.details,
      );
    }
    return envelope.result;
  }

  async #connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection({ host: this.#host, port: this.#port });
      this.#socket = socket;
      const onInitialError = (error: Error) => {
        socket.off("connect", onConnect);
        reject(error);
      };
      const onConnect = () => {
        socket.off("error", onInitialError);
        this.#bindSocket(socket);
        resolve();
      };
      socket.once("error", onInitialError);
      socket.once("connect", onConnect);
    });
  }

  #bindSocket(socket: Socket): void {
    socket.on("data", (chunk) => {
      try {
        for (const message of this.#decoder.push(chunk)) {
          this.#handleMessage(message);
        }
      } catch (error) {
        this.#failConnection(error);
      }
    });
    socket.on("error", (error) => this.#failConnection(error));
    socket.on("close", () => {
      if (this.#socket === socket) {
        this.#socket = undefined;
        this.#invalidateConnection(
          new AbletonBridgeError(
            "connection_closed",
            "Ableton bridge connection closed",
            true,
          ),
        );
        if (this.#status.state === "connected") {
          this.#setStatus({
            state: "error",
            code: "connection_closed",
            message: "Ableton bridge connection closed",
          });
        }
      }
    });
  }

  #handleMessage(message: MessageEnvelope): void {
    if (message.kind !== "response") {
      return;
    }
    const pending = this.#pending.get(message.requestId);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeout);
    this.#pending.delete(message.requestId);
    pending.resolve(message);
  }

  #failConnection(error: unknown): void {
    const failure = error instanceof Error ? error : new Error(String(error));
    this.#rejectPending(failure);
    this.#destroySocket();
    this.#setStatus({
      state: "error",
      code: "connection_error",
      message: failure.message,
    });
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #destroySocket(): void {
    const socket = this.#socket;
    this.#socket = undefined;
    socket?.destroy();
    this.#invalidateConnection(
      new AbletonBridgeError(
        "connection_closed",
        "Ableton bridge stopped",
        true,
      ),
    );
  }

  #invalidateConnection(error: Error): void {
    this.#connectionGeneration += 1;
    this.#handshakeComplete = false;
    this.#capabilities = undefined;
    this.#decoder.reset();
    this.#rejectPending(error);
  }

  #setStatus(status: ConnectionStatus): void {
    this.#status = status;
    this.options.events.publish({
      type: "ableton.connection_changed",
      status,
    });
  }
}
