import { describe, expect, it } from "vitest";

import {
  createCuePointParamsSchema,
  deleteCuePointParamsSchema,
  duplicateClipToArrangementParamsSchema,
  duplicateSessionClipParamsSchema,
  inspectDeviceParametersParamsSchema,
  inspectDevicesParamsSchema,
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
