import type * as Protocol from "@ableton-agent/protocol";
import type { ConnectionStatus } from "@ableton-agent/shared";

export interface AbletonService {
  start(): Promise<void>;
  stop(): Promise<void>;
  getStatus(): Promise<ConnectionStatus>;
  getCapabilities(): Promise<Protocol.CapabilityDocument>;
  ping(): Promise<Protocol.PingResult>;
  inspectSession(): Promise<Protocol.SessionSnapshot>;
  setTempo(tempo: number): Promise<Protocol.SetTempoResult>;
  setPlaying(isPlaying: boolean): Promise<Protocol.SetPlayingResult>;
  inspectArrangementTransport(
    params: Protocol.InspectArrangementTransportParams,
  ): Promise<Protocol.InspectArrangementTransportResult>;
  setArrangementLoop(
    params: Protocol.SetArrangementLoopParams,
  ): Promise<Protocol.SetArrangementLoopResult>;
  createCuePoint(
    params: Protocol.CreateCuePointParams,
  ): Promise<Protocol.CuePointMutationResult>;
  deleteCuePoint(
    params: Protocol.DeleteCuePointParams,
  ): Promise<Protocol.CuePointMutationResult>;
  createTrack(
    params: Protocol.CreateTrackParams,
  ): Promise<Protocol.TrackMutationResult>;
  deleteTrack(
    params: Protocol.DeleteTrackParams,
  ): Promise<Protocol.TrackMutationResult>;
  renameTrack(
    params: Protocol.RenameTrackParams,
  ): Promise<Protocol.RenameTrackResult>;
  setTrackMixer(
    params: Protocol.SetTrackMixerParams,
  ): Promise<Protocol.SetTrackMixerResult>;
  inspectDevices(
    params: Protocol.InspectDevicesParams,
  ): Promise<Protocol.InspectDevicesResult>;
  inspectBrowserRoots(): Promise<Protocol.InspectBrowserRootsResult>;
  inspectBrowserChildren(
    params: Protocol.InspectBrowserChildrenParams,
  ): Promise<Protocol.InspectBrowserChildrenResult>;
  searchBrowser(
    params: Protocol.SearchBrowserParams,
  ): Promise<Protocol.SearchBrowserResult>;
  loadBrowserItem(
    params: Protocol.LoadBrowserItemParams,
  ): Promise<Protocol.LoadBrowserItemResult>;
  inspectDeviceParameters(
    params: Protocol.InspectDeviceParametersParams,
  ): Promise<Protocol.InspectDeviceParametersResult>;
  inspectRackChains(
    params: Protocol.InspectRackChainsParams,
  ): Promise<Protocol.InspectRackChainsResult>;
  inspectRackChainDevices(
    params: Protocol.InspectRackChainDevicesParams,
  ): Promise<Protocol.InspectRackChainDevicesResult>;
  inspectDrumRackPads(
    params: Protocol.InspectDrumRackPadsParams,
  ): Promise<Protocol.InspectDrumRackPadsResult>;
  inspectDrumPadChains(
    params: Protocol.InspectDrumPadChainsParams,
  ): Promise<Protocol.InspectDrumPadChainsResult>;
  inspectDrumPadChainDevices(
    params: Protocol.InspectDrumPadChainDevicesParams,
  ): Promise<Protocol.InspectDrumPadChainDevicesResult>;
  setDeviceEnabled(
    params: Protocol.SetDeviceEnabledParams,
  ): Promise<Protocol.SetDeviceEnabledResult>;
  setDeviceParameter(
    params: Protocol.SetDeviceParameterParams,
  ): Promise<Protocol.SetDeviceParameterResult>;
  createMidiClip(
    params: Protocol.CreateMidiClipParams,
  ): Promise<Protocol.CreateMidiClipResult>;
  replaceMidiNotes(
    params: Protocol.ReplaceMidiNotesParams,
  ): Promise<Protocol.ReplaceMidiNotesResult>;
  launchSessionClip(
    params: Protocol.LaunchSessionClipParams,
  ): Promise<Protocol.LaunchSessionClipResult>;
  duplicateSessionClip(
    params: Protocol.DuplicateSessionClipParams,
  ): Promise<Protocol.DuplicateSessionClipResult>;
  deleteSessionClip(
    params: Protocol.DeleteSessionClipParams,
  ): Promise<Protocol.DeleteSessionClipResult>;
  setSessionClipProperties(
    params: Protocol.SetSessionClipPropertiesParams,
  ): Promise<Protocol.SetSessionClipPropertiesResult>;
  createArrangementMidiClip(
    params: Protocol.CreateArrangementMidiClipParams,
  ): Promise<Protocol.CreateArrangementMidiClipResult>;
  inspectArrangement(
    params: Protocol.InspectArrangementParams,
  ): Promise<Protocol.InspectArrangementResult>;
  deleteArrangementClip(
    params: Protocol.DeleteArrangementClipParams,
  ): Promise<Protocol.DeleteArrangementClipResult>;
  replaceArrangementMidiNotes(
    params: Protocol.ReplaceArrangementMidiNotesParams,
  ): Promise<Protocol.ReplaceArrangementMidiNotesResult>;
  duplicateClipToArrangement(
    params: Protocol.DuplicateClipToArrangementParams,
  ): Promise<Protocol.DuplicateClipToArrangementResult>;
  setArrangementClipProperties(
    params: Protocol.SetArrangementClipPropertiesParams,
  ): Promise<Protocol.SetArrangementClipPropertiesResult>;
}
