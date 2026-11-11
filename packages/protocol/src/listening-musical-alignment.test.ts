import { describe, expect, it } from "vitest";
import {
  sessionMusicalAlignment,
  listeningMusicalAlignmentSchema,
} from "./listening-musical-alignment.js";

const settings = {
  tempoBpm: 128,
  clipSignatureNumerator: 3,
  clipSignatureDenominator: 4,
  startMarker: 0,
  loopStart: 0,
};

describe("captured musical alignment", () => {
  it("uses explicit clip meter and zero-marker origin rather than a guessed 4/4", () => {
    expect(sessionMusicalAlignment(settings)).toMatchObject({
      coordinate: "clip-local-beats",
      barOriginBeat: 0,
      meter: { numerator: 3, denominator: 4 },
      tempoBpm: 128,
      tempoEvidence: "message-rate-monitored-constant",
    });
  });
  it.each([
    { tempoBpm: null },
    { clipSignatureNumerator: null },
    { clipSignatureDenominator: null },
    { startMarker: 0.25 },
    { loopStart: 4 },
  ])(
    "does not invent missing alignment or reposition the clip: %j",
    (change) => {
      expect(
        sessionMusicalAlignment({ ...settings, ...change }),
      ).toBeUndefined();
    },
  );
  it("rejects unqualified tempo evidence and malformed meter", () => {
    const alignment = sessionMusicalAlignment(settings)!;
    expect(
      listeningMusicalAlignmentSchema.safeParse({
        ...alignment,
        tempoEvidence: "assumed",
      }).success,
    ).toBe(false);
    expect(
      listeningMusicalAlignmentSchema.safeParse({
        ...alignment,
        meter: { numerator: 4, denominator: 3 },
      }).success,
    ).toBe(false);
  });
});
