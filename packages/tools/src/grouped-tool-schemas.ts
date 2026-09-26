import {
  createArrangementMidiClipParamsSchema,
  createCuePointParamsSchema,
  createMidiClipParamsSchema,
  createTrackParamsSchema,
  deleteArrangementClipParamsSchema,
  deleteCuePointParamsSchema,
  deleteSessionClipParamsSchema,
  duplicateClipToArrangementParamsSchema,
  duplicateSessionClipParamsSchema,
  fillArrangementRegionParamsSchema,
  findDevicePositionParamsSchema,
  inspectArrangementParamsSchema,
  inspectArrangementTransportParamsSchema,
  inspectBrowserChildrenParamsSchema,
  inspectBrowserRootsParamsSchema,
  inspectChainMixerParamsSchema,
  inspectDeviceParametersParamsSchema,
  inspectDevicesParamsSchema,
  inspectDrumPadChainDevicesParamsSchema,
  inspectDrumPadChainsParamsSchema,
  inspectDrumRackPadsParamsSchema,
  inspectRackChainDevicesParamsSchema,
  inspectRackChainsParamsSchema,
  loadBrowserItemParamsSchema,
  mixerRoutingOperationParamsSchema,
  moveDeviceParamsSchema,
  renameTrackParamsSchema,
  replaceArrangementMidiNotesParamsSchema,
  replaceMidiNotesParamsSchema,
  searchBrowserParamsSchema,
  setArrangementClipPropertiesParamsSchema,
  setArrangementLoopParamsSchema,
  setChainMixerParamsSchema,
  setChainPropertiesParamsSchema,
  setDeviceEnabledParamsSchema,
  setDeviceParameterParamsSchema,
  setPlayingParamsSchema,
  setSessionClipPropertiesParamsSchema,
  setTempoParamsSchema,
  setTrackMixerParamsSchema,
  tracksOperationParamsSchema,
  transportOperationParamsSchema,
  launchSessionClipParamsSchema,
} from "@ableton-agent/protocol";
import { z } from "zod";

export const sessionConnectionStatusParamsSchema = z
  .object({ action: z.literal("connection-status") })
  .strict();
export const sessionInspectParamsSchema = z
  .object({ action: z.literal("inspect") })
  .strict();
export const abletonSessionParamsSchema = z.discriminatedUnion("action", [
  sessionConnectionStatusParamsSchema,
  sessionInspectParamsSchema,
]);

export const tracksCreateParamsSchema = createTrackParamsSchema.safeExtend({
  action: z.literal("create"),
});
export const tracksRenameParamsSchema = renameTrackParamsSchema.safeExtend({
  action: z.literal("rename"),
});
export const abletonTracksParamsSchema = z.discriminatedUnion("action", [
  ...tracksOperationParamsSchema.options,
  tracksCreateParamsSchema,
  tracksRenameParamsSchema,
]);

export const mixerRoutingSetTrackMixerParamsSchema =
  setTrackMixerParamsSchema.safeExtend({
    action: z.literal("set-track-mixer"),
  });
export const abletonMixerRoutingParamsSchema = z.discriminatedUnion("action", [
  ...mixerRoutingOperationParamsSchema.options,
  mixerRoutingSetTrackMixerParamsSchema,
]);

export const transportSetTempoParamsSchema = setTempoParamsSchema.safeExtend({
  action: z.literal("set-tempo"),
});
export const transportSetPlayingParamsSchema =
  setPlayingParamsSchema.safeExtend({
    action: z.literal("set-playing"),
  });
export const transportInspectArrangementParamsSchema =
  inspectArrangementTransportParamsSchema.safeExtend({
    action: z.literal("inspect-arrangement"),
  });
export const transportSetArrangementLoopParamsSchema =
  setArrangementLoopParamsSchema.safeExtend({
    action: z.literal("set-arrangement-loop"),
  });
export const transportCreateCuePointParamsSchema =
  createCuePointParamsSchema.safeExtend({
    action: z.literal("create-cue-point"),
  });
export const transportDeleteCuePointParamsSchema =
  deleteCuePointParamsSchema.safeExtend({
    action: z.literal("delete-cue-point"),
  });
export const abletonTransportParamsSchema = z.discriminatedUnion("action", [
  ...transportOperationParamsSchema.options,
  transportSetTempoParamsSchema,
  transportSetPlayingParamsSchema,
  transportInspectArrangementParamsSchema,
  transportSetArrangementLoopParamsSchema,
  transportCreateCuePointParamsSchema,
  transportDeleteCuePointParamsSchema,
]);

export const sessionClipsCreateMidiParamsSchema =
  createMidiClipParamsSchema.safeExtend({
    action: z.literal("create-midi"),
  });
export const sessionClipsReplaceNotesParamsSchema =
  replaceMidiNotesParamsSchema.safeExtend({
    action: z.literal("replace-notes"),
  });
export const sessionClipsLaunchParamsSchema =
  launchSessionClipParamsSchema.safeExtend({
    action: z.literal("launch"),
  });
export const sessionClipsDuplicateParamsSchema =
  duplicateSessionClipParamsSchema.safeExtend({
    action: z.literal("duplicate"),
  });
export const sessionClipsDeleteParamsSchema =
  deleteSessionClipParamsSchema.safeExtend({
    action: z.literal("delete"),
  });
export const sessionClipsSetPropertiesParamsSchema =
  setSessionClipPropertiesParamsSchema.safeExtend({
    action: z.literal("set-properties"),
  });
export const abletonSessionClipsParamsSchema = z.discriminatedUnion("action", [
  sessionClipsCreateMidiParamsSchema,
  sessionClipsReplaceNotesParamsSchema,
  sessionClipsLaunchParamsSchema,
  sessionClipsDuplicateParamsSchema,
  sessionClipsDeleteParamsSchema,
  sessionClipsSetPropertiesParamsSchema,
]);

export const arrangementCreateMidiClipParamsSchema =
  createArrangementMidiClipParamsSchema.safeExtend({
    action: z.literal("create-midi-clip"),
  });
export const arrangementInspectParamsSchema =
  inspectArrangementParamsSchema.safeExtend({
    action: z.literal("inspect"),
  });
export const arrangementDeleteClipParamsSchema =
  deleteArrangementClipParamsSchema.safeExtend({
    action: z.literal("delete-clip"),
  });
export const arrangementReplaceNotesParamsSchema =
  replaceArrangementMidiNotesParamsSchema.safeExtend({
    action: z.literal("replace-notes"),
  });
export const arrangementDuplicateClipParamsSchema =
  duplicateClipToArrangementParamsSchema.safeExtend({
    action: z.literal("duplicate-clip"),
  });
export const arrangementFillRegionParamsSchema =
  fillArrangementRegionParamsSchema.safeExtend({
    action: z.literal("fill-region"),
  });
export const arrangementSetClipPropertiesParamsSchema =
  setArrangementClipPropertiesParamsSchema.safeExtend({
    action: z.literal("set-clip-properties"),
  });
export const abletonArrangementParamsSchema = z.discriminatedUnion("action", [
  arrangementCreateMidiClipParamsSchema,
  arrangementInspectParamsSchema,
  arrangementDeleteClipParamsSchema,
  arrangementReplaceNotesParamsSchema,
  arrangementDuplicateClipParamsSchema,
  arrangementFillRegionParamsSchema,
  arrangementSetClipPropertiesParamsSchema,
]);

export const devicesInspectParamsSchema = inspectDevicesParamsSchema.safeExtend(
  {
    action: z.literal("inspect"),
  },
);
export const devicesInspectParametersParamsSchema =
  inspectDeviceParametersParamsSchema.safeExtend({
    action: z.literal("inspect-parameters"),
  });
export const devicesInspectRackChainsParamsSchema =
  inspectRackChainsParamsSchema.safeExtend({
    action: z.literal("inspect-rack-chains"),
  });
export const devicesInspectRackChainDevicesParamsSchema =
  inspectRackChainDevicesParamsSchema.safeExtend({
    action: z.literal("inspect-rack-chain-devices"),
  });
export const devicesInspectDrumRackPadsParamsSchema =
  inspectDrumRackPadsParamsSchema.safeExtend({
    action: z.literal("inspect-drum-rack-pads"),
    includeEmpty: z.boolean().default(false),
  });
export const devicesInspectDrumPadChainsParamsSchema =
  inspectDrumPadChainsParamsSchema.safeExtend({
    action: z.literal("inspect-drum-pad-chains"),
  });
export const devicesInspectDrumPadChainDevicesParamsSchema =
  inspectDrumPadChainDevicesParamsSchema.safeExtend({
    action: z.literal("inspect-drum-pad-chain-devices"),
  });
export const devicesInspectChainMixerParamsSchema =
  inspectChainMixerParamsSchema.safeExtend({
    action: z.literal("inspect-chain-mixer"),
  });
export const devicesFindPositionParamsSchema =
  findDevicePositionParamsSchema.safeExtend({
    action: z.literal("find-position"),
  });
export const devicesMoveParamsSchema = moveDeviceParamsSchema.safeExtend({
  action: z.literal("move"),
});
export const devicesSetChainPropertiesParamsSchema =
  setChainPropertiesParamsSchema.safeExtend({
    action: z.literal("set-chain-properties"),
  });
export const devicesSetChainMixerParamsSchema =
  setChainMixerParamsSchema.safeExtend({
    action: z.literal("set-chain-mixer"),
  });
export const devicesSetEnabledParamsSchema =
  setDeviceEnabledParamsSchema.safeExtend({
    action: z.literal("set-enabled"),
  });
export const devicesSetParameterParamsSchema =
  setDeviceParameterParamsSchema.safeExtend({
    action: z.literal("set-parameter"),
  });
export const abletonDevicesParamsSchema = z.discriminatedUnion("action", [
  devicesInspectParamsSchema,
  devicesInspectParametersParamsSchema,
  devicesInspectRackChainsParamsSchema,
  devicesInspectRackChainDevicesParamsSchema,
  devicesInspectDrumRackPadsParamsSchema,
  devicesInspectDrumPadChainsParamsSchema,
  devicesInspectDrumPadChainDevicesParamsSchema,
  devicesInspectChainMixerParamsSchema,
  devicesFindPositionParamsSchema,
  devicesMoveParamsSchema,
  devicesSetChainPropertiesParamsSchema,
  devicesSetChainMixerParamsSchema,
  devicesSetEnabledParamsSchema,
  devicesSetParameterParamsSchema,
]);

export const browserRootsParamsSchema =
  inspectBrowserRootsParamsSchema.safeExtend({
    action: z.literal("roots"),
  });
export const browserChildrenParamsSchema =
  inspectBrowserChildrenParamsSchema.safeExtend({
    action: z.literal("children"),
  });
export const browserSearchParamsSchema = searchBrowserParamsSchema.safeExtend({
  action: z.literal("search"),
});
export const browserSearchExternalPluginsParamsSchema =
  searchBrowserParamsSchema.omit({ roots: true }).safeExtend({
    action: z.literal("search-external-plugins"),
  });
export const browserLoadItemParamsSchema =
  loadBrowserItemParamsSchema.safeExtend({
    action: z.literal("load-item"),
  });
export const abletonBrowserParamsSchema = z.discriminatedUnion("action", [
  browserRootsParamsSchema,
  browserChildrenParamsSchema,
  browserSearchParamsSchema,
  browserSearchExternalPluginsParamsSchema,
  browserLoadItemParamsSchema,
]);

export type AbletonSessionParams = z.infer<typeof abletonSessionParamsSchema>;
export type AbletonTracksParams = z.infer<typeof abletonTracksParamsSchema>;
export type AbletonMixerRoutingParams = z.infer<
  typeof abletonMixerRoutingParamsSchema
>;
export type AbletonTransportParams = z.infer<
  typeof abletonTransportParamsSchema
>;
export type AbletonSessionClipsParams = z.infer<
  typeof abletonSessionClipsParamsSchema
>;
export type AbletonArrangementParams = z.infer<
  typeof abletonArrangementParamsSchema
>;
export type AbletonDevicesParams = z.infer<typeof abletonDevicesParamsSchema>;
export type AbletonBrowserParams = z.infer<typeof abletonBrowserParamsSchema>;
