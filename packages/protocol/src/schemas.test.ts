import { describe, expect, it } from "vitest";

import {
  duplicateClipToArrangementParamsSchema,
  duplicateSessionClipParamsSchema,
  launchSessionClipParamsSchema,
  setArrangementClipPropertiesParamsSchema,
  setSessionClipPropertiesParamsSchema,
} from "./schemas.js";

const identity = {
  index: 0,
  expectedReference: "00000000-0000-4000-8000-000000000001",
  expectedName: "Drums",
};

describe("Arrangement operation schemas", () => {
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
