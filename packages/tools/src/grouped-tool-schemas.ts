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

export const sessionClipsCreateMidiParamsSchema = createMidiClipParamsSchema
  .safeExtend({
    action: z.literal("create-midi"),
  })
  .describe(
    "Create a MIDI clip in an empty Session View slot. Supply the inspected track's index, expectedReference, expectedName, plus sceneIndex and length.",
  );
export const sessionClipsReplaceNotesParamsSchema =
  replaceMidiNotesParamsSchema.safeExtend({
    action: z.literal("replace-notes"),
    allowPerNoteExpressionLoss:
      replaceMidiNotesParamsSchema.shape.allowPerNoteExpressionLoss.describe(
        "Supply explicitly: false when per-note expression must be preserved; true only when its loss is acceptable.",
      ),
  });
export const sessionClipsLaunchParamsSchema =
  launchSessionClipParamsSchema.safeExtend({
    action: z.literal("launch"),
  });
export const sessionClipsDuplicateParamsSchema =
  duplicateSessionClipParamsSchema
    .safeExtend({
      action: z.literal("duplicate"),
    })
    .describe(
      "Duplicate an exact Session clip into an empty slot; identify the destination with destinationTrackIndex, expectedDestinationTrackReference, expectedDestinationTrackName, and destinationSceneIndex.",
    );
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
  inspectDeviceParametersParamsSchema
    .safeExtend({
      action: z
        .literal("inspect-parameters")
        .describe(
          "Inspect one exact device's parameter page after ableton_devices action 'inspect'",
        ),
      index: inspectDeviceParametersParamsSchema.shape.index.describe(
        "Top-level regular-track index copied from the inspected track",
      ),
      expectedReference:
        inspectDeviceParametersParamsSchema.shape.expectedReference.describe(
          "Top-level track reference copied from the inspected track",
        ),
      expectedName:
        inspectDeviceParametersParamsSchema.shape.expectedName.describe(
          "Top-level track name copied from the inspected track",
        ),
      deviceIndex:
        inspectDeviceParametersParamsSchema.shape.deviceIndex.describe(
          "Top-level device index copied from the ableton_devices inspect result",
        ),
      expectedDeviceReference:
        inspectDeviceParametersParamsSchema.shape.expectedDeviceReference.describe(
          "Top-level device reference copied from the ableton_devices inspect result",
        ),
      expectedDeviceName:
        inspectDeviceParametersParamsSchema.shape.expectedDeviceName.describe(
          "Top-level device name copied from the ableton_devices inspect result",
        ),
    })
    .describe(
      "Supply the inspected track and device identity fields at the top level.",
    );
export const devicesInspectRackChainsParamsSchema =
  inspectRackChainsParamsSchema.safeExtend({
    action: z.literal("inspect-rack-chains"),
  });
export const devicesInspectRackChainDevicesParamsSchema =
  inspectRackChainDevicesParamsSchema.safeExtend({
    action: z.literal("inspect-rack-chain-devices"),
  });
export const devicesInspectDrumRackPadsParamsSchema =
  inspectDrumRackPadsParamsSchema
    .safeExtend({
      action: z.literal("inspect-drum-rack-pads"),
      includeEmpty: z.boolean().default(false),
    })
    .describe(
      "List Drum Rack pad names and MIDI notes for an inspected rack device; occupied pads are returned by default.",
    );
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
export const devicesSetParameterParamsSchema = setDeviceParameterParamsSchema
  .safeExtend({
    action: z
      .literal("set-parameter")
      .describe(
        "Set one exact parameter after ableton_devices action 'inspect-parameters'",
      ),
    parameterIndex:
      setDeviceParameterParamsSchema.shape.parameterIndex.describe(
        "Parameter index copied from the inspect-parameters result",
      ),
    expectedParameterReference:
      setDeviceParameterParamsSchema.shape.expectedParameterReference.describe(
        "Parameter reference copied from the inspect-parameters result",
      ),
    expectedParameterName:
      setDeviceParameterParamsSchema.shape.expectedParameterName.describe(
        "Parameter name copied exactly from the inspect-parameters result, including literal punctuation",
      ),
    normalizedValue:
      setDeviceParameterParamsSchema.shape.normalizedValue.describe(
        "Requested normalized parameter value from 0 through 1",
      ),
  })
  .describe(
    "Requires top-level track and device identity plus the exact inspected parameter identity and normalizedValue.",
  );
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
const browserLoadItemShape = loadBrowserItemParamsSchema.shape;
export const browserLoadItemParamsSchema = loadBrowserItemParamsSchema
  .safeExtend({
    index: browserLoadItemShape.index.describe(
      "Copy the zero-based regular track index from a recent ableton_session inspect or ableton_tracks get/list result.",
    ),
    expectedReference: browserLoadItemShape.expectedReference.describe(
      "Copy the destination track reference verbatim from the same recent track inspection.",
    ),
    expectedName: browserLoadItemShape.expectedName.describe(
      "Copy the destination track name verbatim from the same recent track inspection.",
    ),
    expectedItemReference: browserLoadItemShape.expectedItemReference.describe(
      "Copy item.reference verbatim from a recent ableton_browser roots, children, or search result.",
    ),
    expectedItemRoot: browserLoadItemShape.expectedItemRoot.describe(
      "Copy item.root verbatim from the selected Browser result.",
    ),
    expectedItemPath: browserLoadItemShape.expectedItemPath.describe(
      "Copy item.path verbatim from the selected Browser result, preserving every segment index and name.",
    ),
    expectedItemName: browserLoadItemShape.expectedItemName.describe(
      "Copy item.name verbatim from the selected Browser result.",
    ),
    expectedItemUri: browserLoadItemShape.expectedItemUri.describe(
      "Copy item.uri verbatim from the selected Browser result; use an empty string only when that result returned an empty URI.",
    ),
    action: z
      .literal("load-item")
      .describe("Load one exact item selected from a prior Browser result."),
  })
  .describe(
    "Load one exact supported Browser item onto one exact regular track. Inspect the track and search or traverse the Browser first, then copy all track and item identity fields verbatim; never invent or omit identity values.",
  );
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
