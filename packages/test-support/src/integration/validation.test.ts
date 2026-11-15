import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { safeRelativePath, validateFixture } from "./validation.js";

describe("fixture resource paths", () => {
  it.each([
    "Samples/Processed/Crop/2-Audio 1 [2026-11-14 231228].aif",
    "Samples/Processed/Consolidate/audio-1 [2026-11-14 231616].aif",
  ])("admits ordinary Ableton timestamped media: %s", (path) => {
    expect(() => safeRelativePath(path)).not.toThrow();
  });

  describe("registered mixed listening fixture", () => {
    const fixture: unknown = JSON.parse(
      readFileSync(
        new URL(
          "../../../../integration/fixtures/long-horizon-comprehension/fixture.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );

    it("admits independently declared Session and Arrangement sources", () => {
      expect(() => validateFixture(fixture)).not.toThrow();
    });

    it("rejects ambiguous cross-view source identities", () => {
      validateFixture(fixture);
      const invalid = {
        ...fixture,
        arrangementSources: fixture.arrangementSources!.map((source, index) =>
          index === 0 ? { ...source, id: fixture.sources![0]!.id } : source,
        ),
      };
      expect(() => validateFixture(invalid)).toThrow();
    });

    it("still validates every MIDI source in a mixed fixture", () => {
      validateFixture(fixture);
      const invalid = {
        ...fixture,
        sources: fixture.sources!.map((source, index) =>
          index === 3 && "midi" in source
            ? {
                ...source,
                midi: { ...source.midi, notesSha256: "unreviewed" },
              }
            : source,
        ),
      };
      expect(() => validateFixture(invalid)).toThrow();
    });
  });

  it.each([
    "/Samples/audio.aif",
    "../Samples/audio.aif",
    "Samples/../audio.aif",
    "Samples/./audio.aif",
    "Samples\\audio.aif",
    "Samples//audio.aif",
    "Samples/audio\n.aif",
    "Samples/audio\u0000.aif",
  ])("rejects unsafe resource paths: %s", (path) => {
    expect(() => safeRelativePath(path)).toThrow();
  });
});
