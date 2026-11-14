import { describe, expect, it } from "vitest";
import { listeningCaptureProgressSchema } from "./listening-capture-progress.js";

describe("durable listening progress", () => {
  const progress = {
    sampleRate: 48_000,
    requestedSamples: 28_800_000,
    persistedSamples: 8_640_000,
    persistedChunks: 90,
  };

  it("supports ten-minute requests without claiming terminal verification", () => {
    expect(listeningCaptureProgressSchema.parse(progress)).toEqual(progress);
    expect(
      listeningCaptureProgressSchema.safeParse({
        ...progress,
        complete: true,
      }).success,
    ).toBe(false);
  });

  it.each([
    { requestedSamples: 28_800_001 },
    { persistedSamples: 28_800_001 },
    { persistedSamples: -1 },
    { persistedChunks: 1.5 },
    { sampleRate: 96_000 },
    { audio: [1, 2] },
  ])("rejects malformed or out-of-range progress %j", (patch) => {
    expect(
      listeningCaptureProgressSchema.safeParse({ ...progress, ...patch })
        .success,
    ).toBe(false);
  });
});
