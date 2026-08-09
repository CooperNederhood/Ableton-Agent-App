import { describe, expect, it } from "vitest";

import {
  duplicateClipToArrangementParamsSchema,
  setArrangementClipPropertiesParamsSchema,
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
