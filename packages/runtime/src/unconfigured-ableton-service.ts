import type { AbletonService } from "@ableton-agent/ableton-contracts";
import type {
  CapabilityDocument,
  CreateArrangementMidiClipResult,
  CreateMidiClipResult,
  InspectMidiNotesResult,
  CuePointMutationResult,
  DeleteArrangementClipResult,
  DeleteSessionClipResult,
  DuplicateClipToArrangementResult,
  DuplicateSessionClipResult,
  InspectArrangementResult,
  InspectArrangementMidiNotesResult,
  InspectArrangementTransportResult,
  InspectBrowserChildrenResult,
  InspectBrowserRootsResult,
  InspectDeviceParametersResult,
  InspectDevicesResult,
  InspectDrumPadChainDevicesResult,
  InspectDrumPadChainsResult,
  InspectDrumRackPadsResult,
  InspectRackChainDevicesResult,
  InspectRackChainsResult,
  LaunchSessionClipResult,
  LoadBrowserItemResult,
  PingResult,
  RenameTrackResult,
  ReplaceArrangementMidiNotesResult,
  ReplaceMidiNotesResult,
  SearchBrowserResult,
  SessionSnapshot,
  SetArrangementClipPropertiesResult,
  SetArrangementLoopResult,
  SetDeviceEnabledResult,
  SetDeviceParameterResult,
  SetPlayingResult,
  SetSessionClipPropertiesResult,
  SetTempoResult,
  SetTrackMixerResult,
  TrackMutationResult,
} from "@ableton-agent/protocol";
import type { ConnectionStatus } from "@ableton-agent/shared";

/** Error code reported by every operation of {@link UnconfiguredAbletonService}. */
export const CONFIGURATION_MISSING_CODE = "configuration_missing";

export const CONFIGURATION_MISSING_MESSAGE =
  "Set ABLETON_AGENT_TOKEN to connect to the Remote Script";

/**
 * Stands in for the bridge when no authentication token is configured. Every
 * operation fails with a stable `configuration_missing` code instead of
 * pretending an Ableton connection exists.
 */
export class UnconfiguredAbletonService implements AbletonService {
  public constructor(
    private readonly message: string = CONFIGURATION_MISSING_MESSAGE,
  ) {}

  #unavailable(): never {
    throw Object.assign(new Error("Ableton bridge is not configured"), {
      code: CONFIGURATION_MISSING_CODE,
    });
  }

  public async start(): Promise<void> {}
  public async stop(): Promise<void> {}
  public async getStatus(): Promise<ConnectionStatus> {
    return {
      state: "error",
      code: CONFIGURATION_MISSING_CODE,
      message: this.message,
    };
  }
  public async getCapabilities(): Promise<CapabilityDocument> {
    this.#unavailable();
  }
  public async ping(): Promise<PingResult> {
    this.#unavailable();
  }
  public async inspectSession(): Promise<SessionSnapshot> {
    this.#unavailable();
  }
  public async setTempo(): Promise<SetTempoResult> {
    this.#unavailable();
  }
  public async setPlaying(): Promise<SetPlayingResult> {
    this.#unavailable();
  }
  public async inspectArrangementTransport(): Promise<InspectArrangementTransportResult> {
    this.#unavailable();
  }
  public async setArrangementLoop(): Promise<SetArrangementLoopResult> {
    this.#unavailable();
  }
  public async createCuePoint(): Promise<CuePointMutationResult> {
    this.#unavailable();
  }
  public async deleteCuePoint(): Promise<CuePointMutationResult> {
    this.#unavailable();
  }
  public async createTrack(): Promise<TrackMutationResult> {
    this.#unavailable();
  }
  public async deleteTrack(): Promise<TrackMutationResult> {
    this.#unavailable();
  }
  public async renameTrack(): Promise<RenameTrackResult> {
    this.#unavailable();
  }
  public async setTrackMixer(): Promise<SetTrackMixerResult> {
    this.#unavailable();
  }
  public async inspectDevices(): Promise<InspectDevicesResult> {
    this.#unavailable();
  }
  public async inspectBrowserRoots(): Promise<InspectBrowserRootsResult> {
    this.#unavailable();
  }
  public async inspectBrowserChildren(): Promise<InspectBrowserChildrenResult> {
    this.#unavailable();
  }
  public async searchBrowser(): Promise<SearchBrowserResult> {
    this.#unavailable();
  }
  public async loadBrowserItem(): Promise<LoadBrowserItemResult> {
    this.#unavailable();
  }
  public async inspectDeviceParameters(): Promise<InspectDeviceParametersResult> {
    this.#unavailable();
  }
  public async inspectRackChains(): Promise<InspectRackChainsResult> {
    this.#unavailable();
  }
  public async inspectRackChainDevices(): Promise<InspectRackChainDevicesResult> {
    this.#unavailable();
  }
  public async inspectDrumRackPads(): Promise<InspectDrumRackPadsResult> {
    this.#unavailable();
  }
  public async inspectDrumPadChains(): Promise<InspectDrumPadChainsResult> {
    this.#unavailable();
  }
  public async inspectDrumPadChainDevices(): Promise<InspectDrumPadChainDevicesResult> {
    this.#unavailable();
  }
  public async setDeviceEnabled(): Promise<SetDeviceEnabledResult> {
    this.#unavailable();
  }
  public async setDeviceParameter(): Promise<SetDeviceParameterResult> {
    this.#unavailable();
  }
  public async createMidiClip(): Promise<CreateMidiClipResult> {
    this.#unavailable();
  }
  public async inspectMidiNotes(): Promise<InspectMidiNotesResult> {
    this.#unavailable();
  }
  public async replaceMidiNotes(): Promise<ReplaceMidiNotesResult> {
    this.#unavailable();
  }
  public async launchSessionClip(): Promise<LaunchSessionClipResult> {
    this.#unavailable();
  }
  public async duplicateSessionClip(): Promise<DuplicateSessionClipResult> {
    this.#unavailable();
  }
  public async deleteSessionClip(): Promise<DeleteSessionClipResult> {
    this.#unavailable();
  }
  public async setSessionClipProperties(): Promise<SetSessionClipPropertiesResult> {
    this.#unavailable();
  }
  public async createArrangementMidiClip(): Promise<CreateArrangementMidiClipResult> {
    this.#unavailable();
  }
  public async inspectArrangement(): Promise<InspectArrangementResult> {
    this.#unavailable();
  }
  public async inspectArrangementMidiNotes(): Promise<InspectArrangementMidiNotesResult> {
    this.#unavailable();
  }
  public async deleteArrangementClip(): Promise<DeleteArrangementClipResult> {
    this.#unavailable();
  }
  public async replaceArrangementMidiNotes(): Promise<ReplaceArrangementMidiNotesResult> {
    this.#unavailable();
  }
  public async duplicateClipToArrangement(): Promise<DuplicateClipToArrangementResult> {
    this.#unavailable();
  }
  public async setArrangementClipProperties(): Promise<SetArrangementClipPropertiesResult> {
    this.#unavailable();
  }
}
