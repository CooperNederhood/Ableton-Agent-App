import { z, type ZodType } from "zod";

import {
  capabilityDocumentSchema,
  clearEventSubscriptionsParamsSchema,
  clearEventSubscriptionsResultSchema,
  createArrangementMidiClipParamsSchema,
  createArrangementMidiClipResultSchema,
  createCuePointParamsSchema,
  createMidiClipParamsSchema,
  createMidiClipResultSchema,
  createTrackParamsSchema,
  cuePointMutationResultSchema,
  deleteArrangementClipParamsSchema,
  deleteArrangementClipResultSchema,
  deleteCuePointParamsSchema,
  deleteSessionClipParamsSchema,
  deleteSessionClipResultSchema,
  deleteTrackParamsSchema,
  duplicateClipToArrangementParamsSchema,
  duplicateClipToArrangementResultSchema,
  duplicateSessionClipParamsSchema,
  duplicateSessionClipResultSchema,
  findDevicePositionParamsSchema,
  findDevicePositionResultSchema,
  helloParamsSchema,
  inspectArrangementParamsSchema,
  inspectArrangementResultSchema,
  inspectArrangementMidiNotesParamsSchema,
  inspectArrangementMidiNotesResultSchema,
  inspectArrangementTransportParamsSchema,
  inspectArrangementTransportResultSchema,
  inspectBrowserChildrenParamsSchema,
  inspectBrowserChildrenResultSchema,
  inspectBrowserRootsParamsSchema,
  inspectBrowserRootsResultSchema,
  inspectChainMixerParamsSchema,
  inspectChainMixerResultSchema,
  inspectDeviceParametersParamsSchema,
  inspectDeviceParametersResultSchema,
  inspectDevicesParamsSchema,
  inspectDevicesResultSchema,
  inspectDrumPadChainDevicesParamsSchema,
  inspectDrumPadChainDevicesResultSchema,
  inspectDrumPadChainsParamsSchema,
  inspectDrumPadChainsResultSchema,
  inspectDrumRackPadsParamsSchema,
  inspectDrumRackPadsResultSchema,
  inspectEventSelectionParamsSchema,
  inspectEventSelectionResultSchema,
  inspectCuratedLiveStateParamsSchema,
  inspectCuratedLiveStateResultSchema,
  inspectMidiNotesParamsSchema,
  inspectMidiNotesResultSchema,
  inspectRackChainDevicesParamsSchema,
  inspectRackChainDevicesResultSchema,
  inspectRackChainsParamsSchema,
  inspectRackChainsResultSchema,
  launchSessionClipParamsSchema,
  launchSessionClipResultSchema,
  listEventSubscriptionsParamsSchema,
  listEventSubscriptionsResultSchema,
  loadBrowserItemParamsSchema,
  loadBrowserItemResultSchema,
  moveDeviceParamsSchema,
  moveDeviceResultSchema,
  pingResultSchema,
  projectIdentitySchema,
  renameTrackParamsSchema,
  renameTrackResultSchema,
  replaceArrangementMidiNotesParamsSchema,
  replaceArrangementMidiNotesResultSchema,
  replaceMidiNotesParamsSchema,
  replaceMidiNotesResultSchema,
  searchBrowserParamsSchema,
  searchBrowserResultSchema,
  sessionSnapshotSchema,
  setArrangementClipPropertiesParamsSchema,
  setArrangementClipPropertiesResultSchema,
  setArrangementLoopParamsSchema,
  setArrangementLoopResultSchema,
  setChainMixerParamsSchema,
  setChainMixerResultSchema,
  setChainPropertiesParamsSchema,
  setChainPropertiesResultSchema,
  setDeviceEnabledParamsSchema,
  setDeviceEnabledResultSchema,
  setDeviceParameterParamsSchema,
  setDeviceParameterResultSchema,
  setPlayingParamsSchema,
  setPlayingResultSchema,
  setSessionClipPropertiesParamsSchema,
  setSessionClipPropertiesResultSchema,
  setTempoParamsSchema,
  setTempoResultSchema,
  setTrackMixerParamsSchema,
  setTrackMixerResultSchema,
  subscribeEventParamsSchema,
  subscribeEventResultSchema,
  trackMutationResultSchema,
  unsubscribeEventParamsSchema,
  unsubscribeEventResultSchema,
} from "./schemas.js";
import {
  audioClipsInspectParamsSchema,
  audioClipsMutationParamsSchema,
  audioClipsOperationResultSchema,
  midiNotesInspectParamsSchema,
  midiNotesMutationParamsSchema,
  midiNotesOperationResultSchema,
  mixerRoutingInspectParamsSchema,
  mixerRoutingMutationParamsSchema,
  mixerRoutingOperationResultSchema,
  scenesInspectParamsSchema,
  scenesMutationParamsSchema,
  scenesOperationResultSchema,
  tracksInspectParamsSchema,
  tracksMutationParamsSchema,
  tracksOperationResultSchema,
  transportInspectParamsSchema,
  transportMutationParamsSchema,
  transportOperationResultSchema,
} from "./core-domain-schemas.js";
import {
  browserAdapterOperationParamsSchema,
  browserAdapterOperationResultSchema,
  clipAutomationOperationParamsSchema,
  clipAutomationOperationResultSchema,
  grooveOperationParamsSchema,
  grooveOperationResultSchema,
  liveHistoryOperationParamsSchema,
  liveHistoryOperationResultSchema,
  recordingCommandParamsSchema,
  recordingOperationParamsSchema,
  recordingOperationResultSchema,
  selectionViewOperationParamsSchema,
  selectionViewOperationResultSchema,
  specializedDeviceCommandParamsSchema,
  specializedDeviceOperationParamsSchema,
  specializedDeviceOperationResultSchema,
  warpMarkerOperationParamsSchema,
  warpMarkerOperationResultSchema,
  workflowJobCommandParamsSchema,
  workflowJobOperationParamsSchema,
  workflowJobOperationResultSchema,
} from "./workflow-adapter-schemas.js";

export const timeoutClassSchema = z.enum(["normal", "long"]);
export type TimeoutClass = z.infer<typeof timeoutClassSchema>;

export interface CommandDefinition {
  readonly params: ZodType;
  readonly result: ZodType;
  readonly mutates: boolean;
  readonly timeoutClass: TimeoutClass;
}

const emptyParamsSchema = z.object({}).strict();

function command(
  params: ZodType,
  result: ZodType,
  options: { mutates?: boolean; timeoutClass?: TimeoutClass } = {},
): CommandDefinition {
  return {
    params,
    result,
    mutates: options.mutates ?? false,
    timeoutClass: options.timeoutClass ?? "normal",
  };
}

export const commandCatalog = {
  "system.hello": command(helloParamsSchema, capabilityDocumentSchema),
  "system.ping": command(emptyParamsSchema, pingResultSchema),
  "project.get_identity": command(emptyParamsSchema, projectIdentitySchema),
  "session.inspect": command(emptyParamsSchema, sessionSnapshotSchema),
  "scenes.inspect": command(
    scenesInspectParamsSchema,
    scenesOperationResultSchema,
  ),
  "scenes.mutate": command(
    scenesMutationParamsSchema,
    scenesOperationResultSchema,
    { mutates: true },
  ),
  "tracks.inspect": command(
    tracksInspectParamsSchema,
    tracksOperationResultSchema,
  ),
  "tracks.mutate": command(
    tracksMutationParamsSchema,
    tracksOperationResultSchema,
    { mutates: true },
  ),
  "mixer_routing.inspect": command(
    mixerRoutingInspectParamsSchema,
    mixerRoutingOperationResultSchema,
  ),
  "mixer_routing.mutate": command(
    mixerRoutingMutationParamsSchema,
    mixerRoutingOperationResultSchema,
    { mutates: true },
  ),
  "transport.inspect": command(
    transportInspectParamsSchema,
    transportOperationResultSchema,
  ),
  "transport.mutate": command(
    transportMutationParamsSchema,
    transportOperationResultSchema,
    { mutates: true },
  ),
  "midi_notes.inspect": command(
    midiNotesInspectParamsSchema,
    midiNotesOperationResultSchema,
  ),
  "midi_notes.mutate": command(
    midiNotesMutationParamsSchema,
    midiNotesOperationResultSchema,
    { mutates: true },
  ),
  "audio_clips.inspect": command(
    audioClipsInspectParamsSchema,
    audioClipsOperationResultSchema,
  ),
  "audio_clips.mutate": command(
    audioClipsMutationParamsSchema,
    audioClipsOperationResultSchema,
    { mutates: true },
  ),
  "recording.inspect": command(
    recordingOperationParamsSchema.options[0],
    recordingOperationResultSchema.options[0],
  ),
  "recording.set_arrangement_record": command(
    recordingOperationParamsSchema.options[1],
    recordingOperationResultSchema.options[1],
    { mutates: true },
  ),
  "recording.set_session_record": command(
    recordingOperationParamsSchema.options[2],
    recordingOperationResultSchema.options[2],
    { mutates: true },
  ),
  "recording.set_overdub": command(
    recordingOperationParamsSchema.options[3],
    recordingOperationResultSchema.options[3],
    { mutates: true },
  ),
  "recording.set_session_automation_record": command(
    recordingOperationParamsSchema.options[4],
    recordingOperationResultSchema.options[4],
    { mutates: true },
  ),
  "recording.set_punch": command(
    recordingOperationParamsSchema.options[5],
    recordingOperationResultSchema.options[5],
    { mutates: true },
  ),
  "recording.capture_midi": command(
    recordingOperationParamsSchema.options[6],
    recordingOperationResultSchema.options[6],
    { mutates: true },
  ),
  "recording.record_session_slot": command(
    recordingCommandParamsSchema.options[7],
    recordingOperationResultSchema.options[7],
    { mutates: true, timeoutClass: "long" },
  ),
  "grooves.list": command(
    grooveOperationParamsSchema.options[0],
    grooveOperationResultSchema.options[0],
  ),
  "grooves.get": command(
    grooveOperationParamsSchema.options[1],
    grooveOperationResultSchema.options[1],
  ),
  "grooves.inspect_clip": command(
    grooveOperationParamsSchema.options[2],
    grooveOperationResultSchema.options[2],
  ),
  "grooves.set_clip_groove": command(
    grooveOperationParamsSchema.options[3],
    grooveOperationResultSchema.options[3],
    { mutates: true },
  ),
  "grooves.clear_clip_groove": command(
    grooveOperationParamsSchema.options[4],
    grooveOperationResultSchema.options[4],
    { mutates: true },
  ),
  "grooves.set_properties": command(
    grooveOperationParamsSchema.options[5],
    grooveOperationResultSchema.options[5],
    { mutates: true },
  ),
  "grooves.set_global_amount": command(
    grooveOperationParamsSchema.options[6],
    grooveOperationResultSchema.options[6],
    { mutates: true },
  ),
  "selection_view.inspect_selection": command(
    selectionViewOperationParamsSchema.options[0],
    selectionViewOperationResultSchema.options[0],
  ),
  "selection_view.inspect_view": command(
    selectionViewOperationParamsSchema.options[1],
    selectionViewOperationResultSchema.options[1],
  ),
  "selection_view.select_track": command(
    selectionViewOperationParamsSchema.options[2],
    selectionViewOperationResultSchema.options[2],
    { mutates: true },
  ),
  "selection_view.select_scene": command(
    selectionViewOperationParamsSchema.options[3],
    selectionViewOperationResultSchema.options[3],
    { mutates: true },
  ),
  "selection_view.select_slot": command(
    selectionViewOperationParamsSchema.options[4],
    selectionViewOperationResultSchema.options[4],
    { mutates: true },
  ),
  "selection_view.select_clip": command(
    selectionViewOperationParamsSchema.options[5],
    selectionViewOperationResultSchema.options[5],
    { mutates: true },
  ),
  "selection_view.select_device": command(
    selectionViewOperationParamsSchema.options[6],
    selectionViewOperationResultSchema.options[6],
    { mutates: true },
  ),
  "selection_view.select_chain": command(
    selectionViewOperationParamsSchema.options[7],
    selectionViewOperationResultSchema.options[7],
    { mutates: true },
  ),
  "selection_view.set_view": command(
    selectionViewOperationParamsSchema.options[8],
    selectionViewOperationResultSchema.options[8],
    { mutates: true },
  ),
  "selection_view.set_follow": command(
    selectionViewOperationParamsSchema.options[9],
    selectionViewOperationResultSchema.options[9],
    { mutates: true },
  ),
  "selection_view.set_draw_mode": command(
    selectionViewOperationParamsSchema.options[10],
    selectionViewOperationResultSchema.options[10],
    { mutates: true },
  ),
  "selection_view.set_track_fold": command(
    selectionViewOperationParamsSchema.options[11],
    selectionViewOperationResultSchema.options[11],
    { mutates: true },
  ),
  "selection_view.set_device_collapsed": command(
    selectionViewOperationParamsSchema.options[12],
    selectionViewOperationResultSchema.options[12],
    { mutates: true },
  ),
  "live_history.inspect": command(
    liveHistoryOperationParamsSchema.options[0],
    liveHistoryOperationResultSchema.options[0],
  ),
  "live_history.undo": command(
    liveHistoryOperationParamsSchema.options[1],
    liveHistoryOperationResultSchema.options[1],
    { mutates: true },
  ),
  "live_history.redo": command(
    liveHistoryOperationParamsSchema.options[2],
    liveHistoryOperationResultSchema.options[2],
    { mutates: true },
  ),
  "browser_adapters.preview": command(
    browserAdapterOperationParamsSchema.options[0],
    browserAdapterOperationResultSchema.options[0],
    { mutates: true },
  ),
  "browser_adapters.stop_preview": command(
    browserAdapterOperationParamsSchema.options[1],
    browserAdapterOperationResultSchema.options[1],
    { mutates: true },
  ),
  "browser_adapters.hot_swap": command(
    browserAdapterOperationParamsSchema.options[2],
    browserAdapterOperationResultSchema.options[2],
    { mutates: true, timeoutClass: "long" },
  ),
  "browser_adapters.insert_adjacent": command(
    browserAdapterOperationParamsSchema.options[3],
    browserAdapterOperationResultSchema.options[3],
    { mutates: true, timeoutClass: "long" },
  ),
  "browser_adapters.load_empty_drum_pad": command(
    browserAdapterOperationParamsSchema.options[4],
    browserAdapterOperationResultSchema.options[4],
    { mutates: true, timeoutClass: "long" },
  ),
  "clip_automation.list_envelopes": command(
    clipAutomationOperationParamsSchema.options[0],
    clipAutomationOperationResultSchema.options[0],
  ),
  "clip_automation.sample": command(
    clipAutomationOperationParamsSchema.options[1],
    clipAutomationOperationResultSchema.options[1],
  ),
  "clip_automation.insert_step": command(
    clipAutomationOperationParamsSchema.options[2],
    clipAutomationOperationResultSchema.options[2],
    { mutates: true },
  ),
  "clip_automation.clear_envelope": command(
    clipAutomationOperationParamsSchema.options[3],
    clipAutomationOperationResultSchema.options[3],
    { mutates: true },
  ),
  "clip_automation.clear_all": command(
    clipAutomationOperationParamsSchema.options[4],
    clipAutomationOperationResultSchema.options[4],
    { mutates: true },
  ),
  "warp_markers.inspect": command(
    warpMarkerOperationParamsSchema.options[0],
    warpMarkerOperationResultSchema.options[0],
  ),
  "warp_markers.add": command(
    warpMarkerOperationParamsSchema.options[1],
    warpMarkerOperationResultSchema.options[1],
    { mutates: true },
  ),
  "warp_markers.move": command(
    warpMarkerOperationParamsSchema.options[2],
    warpMarkerOperationResultSchema.options[2],
    { mutates: true },
  ),
  "warp_markers.remove": command(
    warpMarkerOperationParamsSchema.options[3],
    warpMarkerOperationResultSchema.options[3],
    { mutates: true },
  ),
  "special_devices.inspect_simpler": command(
    specializedDeviceOperationParamsSchema.options[0],
    specializedDeviceOperationResultSchema.options[0],
  ),
  "special_devices.set_simpler_markers": command(
    specializedDeviceOperationParamsSchema.options[1],
    specializedDeviceOperationResultSchema.options[1],
    { mutates: true },
  ),
  "special_devices.set_simpler_slices": command(
    specializedDeviceOperationParamsSchema.options[2],
    specializedDeviceOperationResultSchema.options[2],
    { mutates: true },
  ),
  "special_devices.inspect_looper": command(
    specializedDeviceOperationParamsSchema.options[3],
    specializedDeviceOperationResultSchema.options[3],
  ),
  "special_devices.control_looper": command(
    specializedDeviceOperationParamsSchema.options[4],
    specializedDeviceOperationResultSchema.options[4],
    { mutates: true },
  ),
  "special_devices.export_looper": command(
    specializedDeviceCommandParamsSchema.options[5],
    specializedDeviceOperationResultSchema.options[5],
    { mutates: true, timeoutClass: "long" },
  ),
  "special_devices.inspect_wavetable": command(
    specializedDeviceOperationParamsSchema.options[6],
    specializedDeviceOperationResultSchema.options[6],
  ),
  "special_devices.set_wavetable_modulation": command(
    specializedDeviceOperationParamsSchema.options[7],
    specializedDeviceOperationResultSchema.options[7],
    { mutates: true },
  ),
  "workflow_jobs.get": command(
    workflowJobOperationParamsSchema.options[0],
    workflowJobOperationResultSchema.options[0],
  ),
  "workflow_jobs.list": command(
    workflowJobOperationParamsSchema.options[1],
    workflowJobOperationResultSchema.options[1],
  ),
  "workflow_jobs.cancel": command(
    workflowJobCommandParamsSchema.options[2],
    workflowJobOperationResultSchema.options[2],
    { mutates: true },
  ),
  "events.inspect_selection": command(
    inspectEventSelectionParamsSchema,
    inspectEventSelectionResultSchema,
  ),
  "events.inspect_curated_state": command(
    inspectCuratedLiveStateParamsSchema,
    inspectCuratedLiveStateResultSchema,
  ),
  "events.subscribe": command(
    subscribeEventParamsSchema,
    subscribeEventResultSchema,
  ),
  "events.unsubscribe": command(
    unsubscribeEventParamsSchema,
    unsubscribeEventResultSchema,
  ),
  "events.list_subscriptions": command(
    listEventSubscriptionsParamsSchema,
    listEventSubscriptionsResultSchema,
  ),
  "events.clear_subscriptions": command(
    clearEventSubscriptionsParamsSchema,
    clearEventSubscriptionsResultSchema,
  ),
  "transport.set_tempo": command(setTempoParamsSchema, setTempoResultSchema, {
    mutates: true,
  }),
  "transport.set_playing": command(
    setPlayingParamsSchema,
    setPlayingResultSchema,
    { mutates: true },
  ),
  "transport.inspect_arrangement": command(
    inspectArrangementTransportParamsSchema,
    inspectArrangementTransportResultSchema,
  ),
  "transport.set_arrangement_loop": command(
    setArrangementLoopParamsSchema,
    setArrangementLoopResultSchema,
    { mutates: true },
  ),
  "transport.create_cue_point": command(
    createCuePointParamsSchema,
    cuePointMutationResultSchema,
    { mutates: true },
  ),
  "transport.delete_cue_point": command(
    deleteCuePointParamsSchema,
    cuePointMutationResultSchema,
    { mutates: true },
  ),
  "tracks.create": command(createTrackParamsSchema, trackMutationResultSchema, {
    mutates: true,
  }),
  "tracks.delete": command(deleteTrackParamsSchema, trackMutationResultSchema, {
    mutates: true,
  }),
  "tracks.rename": command(renameTrackParamsSchema, renameTrackResultSchema, {
    mutates: true,
  }),
  "tracks.set_mixer": command(
    setTrackMixerParamsSchema,
    setTrackMixerResultSchema,
    { mutates: true },
  ),
  "devices.inspect": command(
    inspectDevicesParamsSchema,
    inspectDevicesResultSchema,
  ),
  "devices.inspect_parameters": command(
    inspectDeviceParametersParamsSchema,
    inspectDeviceParametersResultSchema,
    { timeoutClass: "long" },
  ),
  "devices.inspect_rack_chains": command(
    inspectRackChainsParamsSchema,
    inspectRackChainsResultSchema,
  ),
  "devices.inspect_rack_chain_devices": command(
    inspectRackChainDevicesParamsSchema,
    inspectRackChainDevicesResultSchema,
  ),
  "devices.inspect_drum_rack_pads": command(
    inspectDrumRackPadsParamsSchema,
    inspectDrumRackPadsResultSchema,
  ),
  "devices.inspect_drum_pad_chains": command(
    inspectDrumPadChainsParamsSchema,
    inspectDrumPadChainsResultSchema,
  ),
  "devices.inspect_drum_pad_chain_devices": command(
    inspectDrumPadChainDevicesParamsSchema,
    inspectDrumPadChainDevicesResultSchema,
  ),
  "devices.find_position": command(
    findDevicePositionParamsSchema,
    findDevicePositionResultSchema,
  ),
  "devices.move": command(moveDeviceParamsSchema, moveDeviceResultSchema, {
    mutates: true,
  }),
  "devices.set_chain_properties": command(
    setChainPropertiesParamsSchema,
    setChainPropertiesResultSchema,
    { mutates: true },
  ),
  "devices.set_chain_mixer": command(
    setChainMixerParamsSchema,
    setChainMixerResultSchema,
    { mutates: true },
  ),
  "devices.inspect_chain_mixer": command(
    inspectChainMixerParamsSchema,
    inspectChainMixerResultSchema,
  ),
  "devices.set_enabled": command(
    setDeviceEnabledParamsSchema,
    setDeviceEnabledResultSchema,
    { mutates: true },
  ),
  "devices.set_parameter": command(
    setDeviceParameterParamsSchema,
    setDeviceParameterResultSchema,
    { mutates: true },
  ),
  "browser.inspect_roots": command(
    inspectBrowserRootsParamsSchema,
    inspectBrowserRootsResultSchema,
  ),
  "browser.inspect_children": command(
    inspectBrowserChildrenParamsSchema,
    inspectBrowserChildrenResultSchema,
  ),
  "browser.search": command(
    searchBrowserParamsSchema,
    searchBrowserResultSchema,
    {
      timeoutClass: "long",
    },
  ),
  "browser.load_item": command(
    loadBrowserItemParamsSchema,
    loadBrowserItemResultSchema,
    { mutates: true, timeoutClass: "long" },
  ),
  "clips.create_midi": command(
    createMidiClipParamsSchema,
    createMidiClipResultSchema,
    { mutates: true },
  ),
  "clips.inspect_notes": command(
    inspectMidiNotesParamsSchema,
    inspectMidiNotesResultSchema,
  ),
  "clips.replace_notes": command(
    replaceMidiNotesParamsSchema,
    replaceMidiNotesResultSchema,
    { mutates: true },
  ),
  "clips.launch": command(
    launchSessionClipParamsSchema,
    launchSessionClipResultSchema,
    { mutates: true },
  ),
  "clips.duplicate": command(
    duplicateSessionClipParamsSchema,
    duplicateSessionClipResultSchema,
    { mutates: true },
  ),
  "clips.delete": command(
    deleteSessionClipParamsSchema,
    deleteSessionClipResultSchema,
    { mutates: true },
  ),
  "clips.set_properties": command(
    setSessionClipPropertiesParamsSchema,
    setSessionClipPropertiesResultSchema,
    { mutates: true },
  ),
  "arrangement.create_midi_clip": command(
    createArrangementMidiClipParamsSchema,
    createArrangementMidiClipResultSchema,
    { mutates: true },
  ),
  "arrangement.inspect": command(
    inspectArrangementParamsSchema,
    inspectArrangementResultSchema,
  ),
  "arrangement.inspect_notes": command(
    inspectArrangementMidiNotesParamsSchema,
    inspectArrangementMidiNotesResultSchema,
  ),
  "arrangement.delete_clip": command(
    deleteArrangementClipParamsSchema,
    deleteArrangementClipResultSchema,
    { mutates: true },
  ),
  "arrangement.replace_notes": command(
    replaceArrangementMidiNotesParamsSchema,
    replaceArrangementMidiNotesResultSchema,
    { mutates: true },
  ),
  "arrangement.duplicate_clip": command(
    duplicateClipToArrangementParamsSchema,
    duplicateClipToArrangementResultSchema,
    { mutates: true },
  ),
  "arrangement.set_clip_properties": command(
    setArrangementClipPropertiesParamsSchema,
    setArrangementClipPropertiesResultSchema,
    { mutates: true },
  ),
} as const satisfies Record<string, CommandDefinition>;

export type CommandName = keyof typeof commandCatalog;
export const commandNames = Object.freeze(
  Object.keys(commandCatalog) as CommandName[],
);
