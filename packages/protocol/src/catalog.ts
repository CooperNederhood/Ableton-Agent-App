import { z, type ZodType } from "zod";

import {
  capabilityDocumentSchema,
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
  helloParamsSchema,
  inspectArrangementParamsSchema,
  inspectArrangementResultSchema,
  inspectArrangementTransportParamsSchema,
  inspectArrangementTransportResultSchema,
  inspectBrowserChildrenParamsSchema,
  inspectBrowserChildrenResultSchema,
  inspectBrowserRootsParamsSchema,
  inspectBrowserRootsResultSchema,
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
  inspectRackChainDevicesParamsSchema,
  inspectRackChainDevicesResultSchema,
  inspectRackChainsParamsSchema,
  inspectRackChainsResultSchema,
  launchSessionClipParamsSchema,
  launchSessionClipResultSchema,
  loadBrowserItemParamsSchema,
  loadBrowserItemResultSchema,
  pingResultSchema,
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
  trackMutationResultSchema,
} from "./schemas.js";

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
  "session.inspect": command(emptyParamsSchema, sessionSnapshotSchema),
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
