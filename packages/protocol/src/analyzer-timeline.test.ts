import { describe, expect, it } from "vitest";
import {
  PITCH_PROFILE,
  SPECTRAL_SHAPE_PROFILE,
  PITCH_OUTPUT_MINIMUM_HZ,
  PITCH_OUTPUT_MAXIMUM_HZ,
  MAX_ANALYZER_SOURCE_SAMPLE,
} from "./analyzer-profile.js";
import {
  pitchChannelSchema,
  classifyPitchEstimate,
  spectralShapeChannelSchema,
  pitchTimelineSchema,
  spectralShapeTimelineSchema,
  deriveAnalyzerTrailingSupport,
} from "./analyzer-timeline.js";
import { encodedJsonBytes } from "./schema-byte-budget.js";

describe("per-channel estimate validity, not acquisition status", () => {
  it("gates estimates without asserting input class or accuracy", () => {
    expect(classifyPitchEstimate(440, 0.98).state).toBe("accepted-estimate");
    expect(
      classifyPitchEstimate(1000.3179520718859, 0.9968658052693421).state,
    ).toBe("accepted-estimate"); // actual 2000Hz counterexample; gate CANNOT detect it
    for (const hz of [PITCH_OUTPUT_MINIMUM_HZ, PITCH_OUTPUT_MAXIMUM_HZ])
      expect(classifyPitchEstimate(hz, 0.9).state).toBe("accepted-estimate");
    for (const hz of [
      PITCH_OUTPUT_MINIMUM_HZ - 0.000001,
      PITCH_OUTPUT_MAXIMUM_HZ + 0.000001,
    ])
      expect(classifyPitchEstimate(hz, 0.9)).toEqual({
        state: "outside-qualified-range",
        hz,
        confidence: 0.9,
      });
    expect(classifyPitchEstimate(440, 0.899999)).toEqual({
      state: "low-confidence",
      hz: 440,
      confidence: 0.899999,
    });
  });
  it("preserves zero scores, zero-Hz undefined sentinel and finite rejected values", () => {
    expect(classifyPitchEstimate(440, 0)).toEqual({
      state: "low-confidence",
      hz: 440,
      confidence: 0,
    });
    expect(classifyPitchEstimate(0, 0)).toEqual({
      state: "undefined",
      hz: 0,
      confidence: 0,
    });
    expect(classifyPitchEstimate(-9, 1.1)).toEqual({
      state: "invalid",
      hz: -9,
      confidence: 1.1,
    });
    expect(classifyPitchEstimate(NaN, 0.2)).toEqual({
      state: "invalid",
      hz: null,
      confidence: 0.2,
    });
    expect(classifyPitchEstimate(440, Infinity)).toEqual({
      state: "invalid",
      hz: 440,
      confidence: null,
    });
  });
  it("does not mistake silence or malformed/nonfinite values for measurements", () => {
    expect(
      pitchChannelSchema.safeParse({
        state: "silence",
        hz: null,
        confidence: null,
      }).success,
    ).toBe(true);
    for (const channel of [
      { state: "valid", hz: 440, confidence: 0.99 },
      { state: "accepted-estimate", hz: 0, confidence: 0.99 },
      { state: "accepted-estimate", hz: 50, confidence: 0.99 },
      { state: "accepted-estimate", hz: 440, confidence: 0.1 },
      { state: "silence", hz: 0, confidence: 0 },
      { state: "undefined", hz: 440, confidence: 0 },
      { state: "invalid", hz: NaN, confidence: null },
      { state: "low-confidence", hz: 440, confidence: -1 },
    ])
      expect(pitchChannelSchema.safeParse(channel).success).toBe(false);
    for (const state of ["silence", "undefined", "invalid"]) {
      expect(
        spectralShapeChannelSchema.safeParse({
          state,
          flatnessDb: null,
          spreadHz: null,
          rolloffHz: null,
        }).success,
      ).toBe(true);
      expect(
        spectralShapeChannelSchema.safeParse({
          state,
          flatnessDb: 0,
          spreadHz: 0,
          rolloffHz: 0,
        }).success,
      ).toBe(false);
    }
    expect(
      spectralShapeChannelSchema.safeParse({
        state: "valid",
        flatnessDb: -400,
        spreadHz: 1,
        rolloffHz: 1,
      }).success,
    ).toBe(false);
  });
});

const origin = 10000;
const support = (first: number, count = 1) => ({
  startSample: origin + first * 2048,
  endSample: origin + (first + count) * 2048,
});
const gap = (firstIndex: number, count = 1, reason = "sequence-gap") => ({
  firstIndex,
  count,
  reason,
  support: support(firstIndex, count),
});
function fixture(
  kind: "pitch" | "spectral-shape",
  count = 3,
  sampleRate = 48000,
  tail = 17,
) {
  const sourceSupport = {
    startSample: origin,
    endSample: origin + count * 2048 + tail,
  };
  const channels =
    kind === "pitch"
      ? [classifyPitchEstimate(440, 0.98), classifyPitchEstimate(0, 0)]
      : [
          { state: "valid", flatnessDb: -15, spreadHz: 150, rolloffHz: 2000 },
          {
            state: "silence",
            flatnessDb: null,
            spreadHz: null,
            rolloffHz: null,
          },
        ];
  return {
    schema: `${kind}-timeline/v1`,
    status: "complete",
    sampleRate,
    sourceSupport,
    profile: kind === "pitch" ? PITCH_PROFILE : SPECTRAL_SHAPE_PROFILE,
    expectedRecords: count,
    trailingSupport: deriveAnalyzerTrailingSupport(sourceSupport),
    frames: Array.from({ length: count }, (_, index) => ({
      index,
      support: support(index),
      channels,
    })),
    gaps: [] as ReturnType<typeof gap>[],
  };
}
describe.each([
  ["pitch", pitchTimelineSchema],
  ["spectral-shape", spectralShapeTimelineSchema],
] as const)("%s structural full-window timeline", (kind, schema) => {
  it("keeps channels independent, and complete acquisition may have unavailable values", () => {
    const parsed = schema.parse(fixture(kind));
    expect(parsed.status).toBe("complete");
    expect(parsed.frames[0]?.channels[0]?.state).not.toBe(
      parsed.frames[0]?.channels[1]?.state,
    );
    expect(parsed.trailingSupport).toEqual({
      startSample: origin + 6144,
      endSample: origin + 6161,
    });
    expect(schema.parse(fixture(kind, 3, 48000, 0)).trailingSupport).toBeNull();
  });
  it("represents a sub-window capture as entirely unmeasured, not silence", () => {
    const parsed = schema.parse(fixture(kind, 0, 48000, 1000));
    expect(parsed.frames).toEqual([]);
    expect(parsed.expectedRecords).toBe(0);
    expect(parsed.trailingSupport).toEqual(parsed.sourceSupport);
  });
  it.each([44100, 48000])(
    "bounds thirty seconds at %i without padding",
    (rate) => {
      const duration = rate * 30;
      const count = Math.floor(duration / 2048);
      const value = fixture(kind, count, rate, duration % 2048);
      expect(schema.safeParse(value).success).toBe(true);
      expect(count).toBe(rate === 48000 ? 703 : 645);
      expect(encodedJsonBytes(value)).toBeLessThan(512 * 1024);
      expect(
        schema.safeParse({
          ...value,
          sourceSupport: {
            ...value.sourceSupport,
            endSample: value.sourceSupport.endSample + 1,
          },
        }).success,
      ).toBe(false);
    },
  );
  it("accounts for sequence and FIFO overflow gaps without fabricated values", () => {
    const value = fixture(kind);
    const partial = {
      ...value,
      status: "partial",
      frames: [value.frames[0], value.frames[2]],
      gaps: [gap(1, 1, "overflow")],
    };
    expect(schema.safeParse(partial).success).toBe(true);
    expect(schema.safeParse({ ...partial, status: "complete" }).success).toBe(
      false,
    );
    expect(
      schema.safeParse({
        ...value,
        status: "failed",
        frames: [],
        gaps: [gap(0, 3)],
      }).success,
    ).toBe(true);
    expect(schema.safeParse({ ...partial, gaps: [] }).success).toBe(false);
  });
  it("rejects malformed, unordered, overlapping, padded or out-of-range support", () => {
    const value = fixture(kind);
    const first = value.frames[0]!;
    const bad = [
      { ...value, frames: [value.frames[1], value.frames[0], value.frames[2]] },
      { ...value, frames: [first, first, value.frames[2]] },
      { ...value, frames: [first, value.frames[1]] },
      {
        ...value,
        frames: [{ ...first, support: support(1) }, ...value.frames.slice(1)],
      },
      {
        ...value,
        frames: [
          {
            ...first,
            support: {
              ...first.support,
              endSample: first.support.endSample - 1,
            },
          },
          ...value.frames.slice(1),
        ],
      },
      { ...value, status: "partial", gaps: [gap(0)] },
      {
        ...value,
        status: "failed",
        frames: [],
        gaps: [gap(1), gap(0), gap(2)],
      },
      { ...value, status: "failed", frames: [], gaps: [gap(0, 2), gap(1, 2)] },
      { ...value, status: "failed", frames: [], gaps: [gap(0, 4)] },
      { ...value, expectedRecords: 4 },
      { ...value, trailingSupport: null },
      { ...value, trailingSupport: support(3) },
      { ...value, sampleRate: 96000 },
      { ...value, sourceSupport: { startSample: origin, endSample: origin } },
      {
        ...value,
        sourceSupport: {
          startSample: 1,
          endSample: MAX_ANALYZER_SOURCE_SAMPLE + 1,
        },
      },
      {
        ...value,
        sourceSupport: { startSample: origin + 0.5, endSample: origin + 6161 },
      },
      {
        ...value,
        frames: [{ ...first, index: 703 }, ...value.frames.slice(1)],
      },
      {
        ...value,
        frames: [
          { ...first, callbackTimestamp: 123 },
          ...value.frames.slice(1),
        ],
      },
    ];
    for (const input of bad)
      expect(schema.safeParse(input).success).toBe(false);
  });
});
it("checks actual Nyquist rather than just the global finite spectral bound", () => {
  const value = fixture("spectral-shape", 1, 44100);
  const frame = value.frames[0]!;
  const valid = {
    state: "valid",
    flatnessDb: -1,
    spreadHz: 23000,
    rolloffHz: 23000,
  };
  expect(
    spectralShapeTimelineSchema.safeParse({
      ...value,
      frames: [{ ...frame, channels: [valid, valid] }],
    }).success,
  ).toBe(false);
});
