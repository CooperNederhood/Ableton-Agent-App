import { describe, expect, it } from "vitest";
import { createKnownListeningFixture } from "./listening-fixture.js";

describe("independent listening source fixtures", () => {
  it("encodes a two-second stereo PCM source with independently known gates", () => {
    const fixture = createKnownListeningFixture("quarter-sine");
    const view = new DataView(fixture.wav.buffer);
    expect(new TextDecoder().decode(fixture.wav.subarray(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(fixture.wav.subarray(8, 12))).toBe("WAVE");
    expect(view.getUint32(4, true)).toBe(fixture.wav.byteLength - 8);
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(2);
    expect(view.getUint32(24, true)).toBe(48_000);
    expect(view.getUint32(28, true)).toBe(192_000);
    expect(view.getUint16(32, true)).toBe(4);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(384_000);
    expect(fixture.onsetBeats).toEqual([0, 1, 2, 3]);
    expect(fixture.reference.peak).toEqual([0.5, 0.5]);
    for (const dbfs of fixture.reference.rmsDbfs) {
      expect(dbfs).toBeCloseTo(-12.158, 2);
    }
    for (let beat = 0; beat < 4; beat += 1) {
      const start = beat * 24_000;
      expect(view.getInt16(44 + (start + 900) * 4, true)).toBe(16_384);
      for (let sample = start + 12_000; sample < start + 24_000; sample += 1) {
        expect(view.getInt16(44 + sample * 4, true)).toBe(0);
        expect(view.getInt16(46 + sample * 4, true)).toBe(0);
      }
    }
  });

  it("retains known per-channel energy when stereo cancels in a downmix", () => {
    const fixture = createKnownListeningFixture("anti-phase-quarter-sine");
    const normal = createKnownListeningFixture("quarter-sine");
    const view = new DataView(fixture.wav.buffer);
    expect(fixture.reference).toEqual(normal.reference);
    for (let sample = 0; sample < 96_000; sample += 1) {
      expect(
        view.getInt16(44 + sample * 4, true) +
          view.getInt16(46 + sample * 4, true),
      ).toBe(0);
    }
  });

  it("produces finite, exact silence with no invented frequency or attacks", () => {
    const fixture = createKnownListeningFixture("silence");
    expect(fixture.reference).toEqual({ peak: [0, 0], rmsDbfs: [null, null] });
    expect(fixture.onsetBeats).toEqual([]);
    expect(fixture.frequencyHz).toBeNull();
    expect(fixture.wav.subarray(44).every((byte) => byte === 0)).toBe(true);
  });
});
