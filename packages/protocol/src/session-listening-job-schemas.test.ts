import { describe, expect, it } from "vitest";
import { sessionListeningJobDetailSchema } from "./session-listening-job-schemas.js";

const detail = {
  clipName: "MIDI source",
  trackName: "Instrument",
  sceneIndex: 0,
  durationBeats: 4,
  launch: { state: "verified", mutationState: "observed-playing" },
};
describe("bounded Session lifecycle detail", () => {
  it("preserves source and launch separately from measured observations", () => {
    expect(sessionListeningJobDetailSchema.parse(detail)).toEqual(detail);
    expect(
      sessionListeningJobDetailSchema.parse({ ...detail, launch: undefined })
        .launch,
    ).toBeUndefined();
  });
  it.each([
    { durationBeats: 4.01 },
    { sceneIndex: -1 },
    { clipName: "x".repeat(129) },
    { launch: { state: "verified", mutationState: "indeterminate" } },
    { launch: { state: "queued", mutationState: "rolled-back" } },
    { audio: [1] },
  ])("refuses unbounded or falsely verified detail: %j", (change) => {
    expect(
      sessionListeningJobDetailSchema.safeParse({ ...detail, ...change })
        .success,
    ).toBe(false);
  });
});
