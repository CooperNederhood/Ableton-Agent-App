import { describe, expect, it } from "vitest";

import {
  inspectBrowserChildrenParamsSchema,
  loadBrowserItemParamsSchema,
  searchBrowserParamsSchema,
  selectProtocolVersion,
  createCuePointParamsSchema,
  deleteCuePointParamsSchema,
  deviceSummarySchema,
  duplicateClipToArrangementParamsSchema,
  duplicateSessionClipParamsSchema,
  inspectDeviceParametersParamsSchema,
  inspectDevicesParamsSchema,
  inspectDrumPadChainDevicesParamsSchema,
  inspectDrumPadChainsParamsSchema,
  inspectDrumRackPadsParamsSchema,
  inspectRackChainDevicesParamsSchema,
  inspectRackChainsParamsSchema,
  launchSessionClipParamsSchema,
  setDeviceEnabledParamsSchema,
  setDeviceParameterParamsSchema,
  setArrangementLoopParamsSchema,
  setArrangementClipPropertiesParamsSchema,
  setSessionClipPropertiesParamsSchema,
} from "./schemas.js";

const identity = {
  index: 0,
  expectedReference: "00000000-0000-4000-8000-000000000001",
  expectedName: "Drums",
};

describe("protocol negotiation", () => {
  it("selects the highest mutually supported version", () => {
    expect(selectProtocolVersion([1, 2, 3], [1, 2])).toBe(2);
    expect(selectProtocolVersion([1], [2])).toBeUndefined();
  });
});

describe("Arrangement operation schemas", () => {
  it("validates finite bounded loop and cue-point transport parameters", () => {
    expect(
      setArrangementLoopParamsSchema.parse({
        enabled: true,
        start: 8,
        length: 16,
      }),
    ).toEqual({ enabled: true, start: 8, length: 16 });
    expect(setArrangementLoopParamsSchema.safeParse({}).success).toBe(false);
    expect(
      setArrangementLoopParamsSchema.safeParse({
        start: Number.NaN,
      }).success,
    ).toBe(false);
    expect(
      setArrangementLoopParamsSchema.safeParse({
        start: 1576800,
        length: 1,
      }).success,
    ).toBe(false);
    expect(
      createCuePointParamsSchema.parse({ time: 32, name: "Chorus" }),
    ).toEqual({ time: 32, name: "Chorus" });
    expect(
      deleteCuePointParamsSchema.parse({
        expectedReference: "00000000-0000-4000-8000-000000000030",
        expectedName: "",
        expectedTime: 32,
      }),
    ).toMatchObject({ expectedName: "", expectedTime: 32 });
  });

  describe("Device operation schemas", () => {
    const deviceTarget = {
      ...identity,
      deviceIndex: 0,
      expectedDeviceReference: "00000000-0000-4000-8000-000000000040",
      expectedDeviceName: "Drum Rack",
    };

    it("bounds device and parameter inspection pages", () => {
      expect(inspectDevicesParamsSchema.parse(identity)).toEqual({
        ...identity,
        offset: 0,
        limit: 32,
      });
      expect(
        inspectDevicesParamsSchema.safeParse({ ...identity, limit: 129 })
          .success,
      ).toBe(false);
      expect(inspectDeviceParametersParamsSchema.parse(deviceTarget)).toEqual({
        ...deviceTarget,
        offset: 0,
        limit: 64,
      });
      expect(
        inspectDeviceParametersParamsSchema.safeParse({
          ...deviceTarget,
          limit: 257,
        }).success,
      ).toBe(false);
      expect(
        deviceSummarySchema.parse({
          reference: deviceTarget.expectedDeviceReference,
          trackReference: identity.expectedReference,
          trackIndex: 0,
          index: 0,
          name: "Legacy Device",
          className: "LegacyDevice",
          classDisplayName: "Legacy Device",
          enabled: null,
          parameterCount: 0,
        }),
      ).toMatchObject({
        canHaveChains: false,
        canHaveDrumPads: false,
      });
    });

    it("requires exact device and parameter identities for mutations", () => {
      expect(
        setDeviceEnabledParamsSchema.parse({
          ...deviceTarget,
          enabled: false,
        }),
      ).toMatchObject({ enabled: false });
      expect(
        setDeviceParameterParamsSchema.parse({
          ...deviceTarget,
          parameterIndex: 2,
          expectedParameterReference: "00000000-0000-4000-8000-000000000041",
          expectedParameterName: "Dry/Wet",
          normalizedValue: 0.75,
        }),
      ).toMatchObject({ parameterIndex: 2, normalizedValue: 0.75 });
      expect(
        setDeviceParameterParamsSchema.safeParse({
          ...deviceTarget,
          parameterIndex: 2,
          expectedParameterReference: "00000000-0000-4000-8000-000000000041",
          expectedParameterName: "Dry/Wet",
          normalizedValue: 1.1,
        }).success,
      ).toBe(false);
    });

    it("bounds rack, chain, Drum Rack pad, and pad-chain pages", () => {
      expect(inspectRackChainsParamsSchema.parse(deviceTarget)).toMatchObject({
        offset: 0,
        limit: 16,
      });
      expect(
        inspectRackChainsParamsSchema.safeParse({
          ...deviceTarget,
          limit: 65,
        }).success,
      ).toBe(false);
      const chainTarget = {
        ...deviceTarget,
        chainIndex: 0,
        expectedChainReference: "00000000-0000-4000-8000-000000000042",
        expectedChainName: "Main",
      };
      expect(
        inspectRackChainDevicesParamsSchema.parse(chainTarget),
      ).toMatchObject({ offset: 0, limit: 32 });
      expect(
        inspectRackChainDevicesParamsSchema.safeParse({
          ...chainTarget,
          limit: 129,
        }).success,
      ).toBe(false);
      expect(inspectDrumRackPadsParamsSchema.parse(deviceTarget)).toMatchObject(
        {
          offset: 0,
          limit: 32,
        },
      );
      const padTarget = {
        ...deviceTarget,
        padIndex: 0,
        expectedPadReference: "00000000-0000-4000-8000-000000000044",
        expectedPadNote: 36,
        expectedPadName: "Kick",
      };
      expect(inspectDrumPadChainsParamsSchema.parse(padTarget)).toMatchObject({
        offset: 0,
        limit: 8,
      });
      expect(
        inspectDrumPadChainDevicesParamsSchema.parse({
          ...padTarget,
          chainIndex: 0,
          expectedChainReference: "00000000-0000-4000-8000-000000000045",
          expectedChainName: "Kick",
        }),
      ).toMatchObject({ offset: 0, limit: 32 });
      expect(
        inspectDrumRackPadsParamsSchema.safeParse({
          ...deviceTarget,
          limit: 129,
        }).success,
      ).toBe(false);
    });
  });

  describe("Browser operation schemas", () => {
    const item = {
      expectedItemReference: "00000000-0000-4000-8000-000000000050",
      expectedItemRoot: "instruments" as const,
      expectedItemPath: [
        { index: 0, name: "Synths" },
        { index: 1, name: "Operator" },
      ],
      expectedItemName: "Operator",
      expectedItemUri: "ableton://instruments/operator",
    };

    it("strictly bounds browser pages and deterministic searches", () => {
      expect(inspectBrowserChildrenParamsSchema.parse(item)).toMatchObject({
        offset: 0,
        limit: 32,
      });
      expect(
        inspectBrowserChildrenParamsSchema.safeParse({
          ...item,
          limit: 65,
        }).success,
      ).toBe(false);
      expect(searchBrowserParamsSchema.parse({ query: "operator" })).toEqual({
        query: "operator",
        roots: ["instruments", "audio_effects", "midi_effects"],
        maxNodes: 128,
        maxResults: 20,
        maxDepth: 4,
        maxDurationMs: 100,
      });
      expect(
        searchBrowserParamsSchema.safeParse({
          query: "operator",
          maxNodes: 257,
        }).success,
      ).toBe(false);
      expect(
        searchBrowserParamsSchema.safeParse({
          query: "operator",
          roots: ["instruments", "instruments"],
        }).success,
      ).toBe(false);
    });

    it("requires exact track and browser item identities for loading", () => {
      expect(
        loadBrowserItemParamsSchema.parse({ ...identity, ...item }),
      ).toMatchObject({
        expectedReference: identity.expectedReference,
        expectedItemReference: item.expectedItemReference,
      });
      expect(
        loadBrowserItemParamsSchema.safeParse({
          ...identity,
          ...item,
          filesystemPath: "/Library/Audio/Plug-Ins/example.vst3",
        }).success,
      ).toBe(false);
    });
  });

  it("accepts identity-bound Session clip duplication parameters", () => {
    expect(
      duplicateClipToArrangementParamsSchema.parse({
        ...identity,
        sceneIndex: 1,
        expectedClipReference: "00000000-0000-4000-8000-000000000010",
        destinationTime: 16,
      }),
    ).toMatchObject({ sceneIndex: 1, destinationTime: 16 });
  });

  describe("Session clip operation schemas", () => {
    const clipTarget = {
      ...identity,
      sceneIndex: 0,
      expectedClipReference: "00000000-0000-4000-8000-000000000010",
    };

    it("requires exact track and clip references for launch", () => {
      expect(launchSessionClipParamsSchema.parse(clipTarget)).toEqual(
        clipTarget,
      );
      expect(
        launchSessionClipParamsSchema.safeParse({
          ...clipTarget,
          expectedClipReference: undefined,
        }).success,
      ).toBe(false);
    });

    it("requires an exact destination track for duplication", () => {
      expect(
        duplicateSessionClipParamsSchema.parse({
          ...clipTarget,
          destinationTrackIndex: 1,
          expectedDestinationTrackReference:
            "00000000-0000-4000-8000-000000000002",
          expectedDestinationTrackName: "Audio",
          destinationSceneIndex: 1,
        }),
      ).toMatchObject({
        destinationTrackIndex: 1,
        expectedDestinationTrackName: "Audio",
        destinationSceneIndex: 1,
      });
    });

    it("requires at least one conservative Session clip property", () => {
      expect(
        setSessionClipPropertiesParamsSchema.safeParse(clipTarget).success,
      ).toBe(false);
      expect(
        setSessionClipPropertiesParamsSchema.parse({
          ...clipTarget,
          name: "Verse",
          muted: true,
          looping: false,
        }),
      ).toMatchObject({ name: "Verse", muted: true, looping: false });
    });
  });

  it("requires at least one conservative Arrangement clip property", () => {
    const target = {
      ...identity,
      expectedClipReference: "00000000-0000-4000-8000-000000000020",
      expectedStartTime: 8,
    };

    expect(
      setArrangementClipPropertiesParamsSchema.safeParse(target).success,
    ).toBe(false);
    expect(
      setArrangementClipPropertiesParamsSchema.parse({
        ...target,
        name: "Chorus",
        muted: true,
        looping: false,
      }),
    ).toMatchObject({ name: "Chorus", muted: true, looping: false });
  });
});
