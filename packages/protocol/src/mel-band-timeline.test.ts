import { describe, expect, it } from "vitest";
import {
  aggregateMelBandFrames,
  MEL_BAND_PROFILE,
  melBandStereoFrameSchema,
} from "./mel-band-profile.js";
import {
  deriveMelBandTimelineMetadata,
  melBandTimelineSchema,
  projectMelBandTimeline,
} from "./mel-band-timeline.js";

const origin = 10_000;
const support = (firstIndex: number, count = 1) => ({
  startSample: origin + firstIndex * 2_048,
  endSample: origin + (firstIndex + count) * 2_048,
});
const magnitudes = (low = 1, mid = 1) =>
  melBandStereoFrameSchema.parse([
    Array.from({ length: 24 }, (_, i) => (i < 2 ? low : mid)),
    Array.from({ length: 24 }, () => 0),
  ]);
const frame = (index: number) => ({
  index,
  support: support(index),
  magnitudes: magnitudes(),
});
const gap = (firstIndex: number, count = 1, reason = "sequence-gap") => ({
  firstIndex,
  count,
  support: support(firstIndex, count),
  reason,
});
const fixture = () => ({
  schema: "mel-band-timeline/v1",
  status: "complete",
  sampleRate: 48_000,
  profile: MEL_BAND_PROFILE,
  sourceSupport: support(0, 3),
  expectedRecords: 3,
  frames: [frame(0), frame(1), frame(2)],
  gaps: [] as ReturnType<typeof gap>[],
});
const row = (
  startSample = origin,
  endSample = origin + 6_144,
  startBeat = 0,
  endBeat = 1,
) => ({ startSample, endSample, startBeat, endBeat });

describe("structural mel-band timeline (not physical source certification)", () => {
  it("accepts exact full frames and derives explicit trailing support", () => {
    const timeline = melBandTimelineSchema.parse({
      ...fixture(),
      sourceSupport: { startSample: origin, endSample: origin + 6_244 },
    });
    expect(deriveMelBandTimelineMetadata(timeline)).toEqual({
      expectedRecords: 3,
      trailingSupport: {
        startSample: origin + 6_144,
        endSample: origin + 6_244,
      },
    });
    expect(
      deriveMelBandTimelineMetadata(melBandTimelineSchema.parse(fixture())),
    ).toEqual({
      expectedRecords: 3,
      trailingSupport: null,
    });
  });

  it.each([44_100, 48_000])(
    "supports exactly thirty seconds at %i Hz",
    (sampleRate) => {
      const expectedRecords = Math.floor((sampleRate * 30) / 2_048);
      const timeline = melBandTimelineSchema.parse({
        ...fixture(),
        sampleRate,
        expectedRecords,
        sourceSupport: {
          startSample: origin,
          endSample: origin + sampleRate * 30,
        },
        frames: Array.from({ length: expectedRecords }, (_, index) =>
          frame(index),
        ),
      });
      expect(timeline.expectedRecords).toBe(sampleRate === 48_000 ? 703 : 645);
      expect(() =>
        melBandTimelineSchema.parse({
          ...timeline,
          sourceSupport: {
            ...timeline.sourceSupport,
            endSample: timeline.sourceSupport.endSample + 1,
          },
        }),
      ).toThrow();
    },
  );

  it("rejects false completeness even when every slot is accounted for", () => {
    const partial = {
      ...fixture(),
      status: "partial",
      frames: [frame(0), frame(2)],
      gaps: [gap(1)],
    };
    expect(melBandTimelineSchema.safeParse(partial).success).toBe(true);
    expect(
      melBandTimelineSchema.safeParse({ ...partial, status: "complete" })
        .success,
    ).toBe(false);
  });

  it("rejects shifted indexed frame and gap support without clipping", () => {
    const shifted = { startSample: origin + 1, endSample: origin + 2_049 };
    expect(
      melBandTimelineSchema.safeParse({
        ...fixture(),
        frames: [{ ...frame(0), support: shifted }, frame(1), frame(2)],
      }).success,
    ).toBe(false);
    expect(
      melBandTimelineSchema.safeParse({
        ...fixture(),
        status: "partial",
        frames: [frame(1), frame(2)],
        gaps: [{ ...gap(0), support: shifted }],
      }).success,
    ).toBe(false);
  });

  it("accepts bounded large absolute coordinates and rejects padded tail frames", () => {
    const endSample = 2 ** 44 - 1;
    const startSample = endSample - 2_049;
    const timeline = melBandTimelineSchema.parse({
      ...fixture(),
      expectedRecords: 1,
      sourceSupport: { startSample, endSample },
      frames: [
        {
          ...frame(0),
          support: { startSample, endSample: startSample + 2_048 },
        },
      ],
    });
    expect(deriveMelBandTimelineMetadata(timeline).trailingSupport).toEqual({
      startSample: endSample - 1,
      endSample,
    });
    expect(
      projectMelBandTimeline(timeline, [row(startSample, endSample)]).rows[0]!
        .recordCount,
    ).toBe(1);
    expect(
      melBandTimelineSchema.safeParse({
        ...fixture(),
        sourceSupport: { startSample: origin, endSample: origin + 6_244 },
        frames: [
          ...fixture().frames,
          {
            ...frame(3),
            support: { startSample: origin + 6_144, endSample: origin + 6_244 },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it.each([
    { status: "complete", frames: [frame(0), frame(2)], gaps: [gap(1)] },
    { status: "partial" },
    { status: "partial", frames: [], gaps: [gap(0, 3)] },
    { status: "failed" },
    { status: "failed", frames: [frame(0)], gaps: [gap(1, 2)] },
    { frames: [frame(0), frame(2)] },
    { frames: [frame(1), frame(0), frame(2)] },
    { frames: [frame(0), frame(0), frame(2)] },
    { expectedRecords: 4 },
    { status: "partial", frames: [frame(0)], gaps: [gap(1, 2), gap(2)] },
    { status: "partial", frames: [frame(1)], gaps: [gap(2), gap(0)] },
    { status: "partial", gaps: [gap(1)] },
    { frames: [frame(0), frame(1), { ...frame(2), support: support(1) }] },
    {
      frames: [
        {
          ...frame(0),
          support: { startSample: origin - 1, endSample: origin + 2_047 },
        },
        frame(1),
        frame(2),
      ],
    },
    {
      status: "partial",
      frames: [frame(0)],
      gaps: [{ ...gap(1, 2), support: support(0, 2) }],
    },
    { frames: [frame(0), frame(1), frame(3)] },
    { frames: Array(3) },
    { gaps: Array(1) },
    { sampleRate: 96_000 },
    { schema: "mel-band-timeline/v2" },
    { profile: { ...MEL_BAND_PROFILE, schema: "mel-band-profile/v2" } },
    { profile: { ...MEL_BAND_PROFILE, scale: 1 } },
    { sourceSupport: { startSample: -1, endSample: 6_144 } },
    { sourceSupport: { startSample: origin, endSample: origin } },
    { sourceSupport: { startSample: origin, endSample: Infinity } },
    { sourceSupport: { startSample: origin + 0.1, endSample: origin + 6_144 } },
    { sourceSupport: { startSample: 2 ** 44 - 1, endSample: 2 ** 44 } },
    { rawAudio: [] },
    { frames: [{ ...frame(0), ratios: [] }, frame(1), frame(2)] },
    { frames: [{ ...frame(0), magnitudes: [[NaN], []] }, frame(1), frame(2)] },
    { status: "failed", frames: [], gaps: [gap(0, 3, "unknown")] },
    { status: "failed", frames: [], gaps: [{ ...gap(0, 3), count: 0 }] },
    { status: "failed", frames: [], gaps: [{ ...gap(0, 3), extra: true }] },
    { frames: Array.from({ length: 707 }, (_, i) => frame(i)) },
    { gaps: Array.from({ length: 707 }, (_, i) => gap(i)) },
  ])("rejects malformed, unsupported or inconsistent timeline %#", (change) => {
    expect(
      melBandTimelineSchema.safeParse({ ...fixture(), ...change }).success,
    ).toBe(false);
  });

  it.each([
    "unavailable",
    "malformed-record",
    "sequence-gap",
    "overflow",
    "drain-timeout",
    "dependency-unavailable",
  ])("retains explicit all-gap failure reason %s", (reason) => {
    const timeline = melBandTimelineSchema.parse({
      ...fixture(),
      status: "failed",
      frames: [],
      gaps: [gap(0, 3, reason)],
    });
    const report = projectMelBandTimeline(timeline, [row()]);
    expect(report.status).toBe("failed");
    expect(report.rows[0]!.gaps).toEqual([gap(0, 3, reason)]);
    expect(report.rows[0]!.aggregation).toEqual({
      status: "no-frames",
      frameCount: 0,
    });
    expect(report.rows[0]!.recordCount).toBe(0);
    expect(report.rows[0]!.gapCount).toBe(3);
  });

  it("represents a complete sub-window capture as no frames, never silence", () => {
    const timeline = melBandTimelineSchema.parse({
      ...fixture(),
      expectedRecords: 0,
      frames: [],
      sourceSupport: { startSample: origin, endSample: origin + 100 },
    });
    const report = projectMelBandTimeline(timeline, [
      row(origin, origin + 100),
    ]);
    expect(report.status).toBe("complete");
    expect(report.expectedRecords).toBe(0);
    expect(report.trailingSupport).toEqual(timeline.sourceSupport);
    expect(report.rows[0]!.aggregation).toEqual({
      status: "no-frames",
      frameCount: 0,
    });
    expect(report.rows[0]!.frames).toEqual([]);
    expect(() =>
      melBandTimelineSchema.parse({ ...timeline, status: "failed" }),
    ).toThrow();
  });

  it("assigns endpoints half-open, except the included final capture end", () => {
    const timeline = melBandTimelineSchema.parse(fixture());
    const report = projectMelBandTimeline(timeline, [
      row(origin, origin + 2_048, 0, 1),
      row(origin + 2_048, origin + 4_096, 1, 2),
      row(origin + 4_096, origin + 6_144, 2, 3),
    ]);
    expect(
      report.rows.map((value) => value.frames.map((item) => item.index)),
    ).toEqual([[], [0], [1, 2]]);
    expect(report.rows.map((value) => value.expectedRecords)).toEqual([
      0, 1, 2,
    ]);
    expect(report.rows[1]!.frames[0]!.support).toEqual(support(0));
    expect(report.rows[0]!.aggregation.status).toBe("no-frames");
    expect(report.rows[2]!.frames[1]!.analysis.magnitudes).toEqual(
      timeline.frames[2]!.magnitudes,
    );
  });

  it("preserves indexed gap support while splitting a gap across endpoint rows", () => {
    const timeline = melBandTimelineSchema.parse({
      ...fixture(),
      status: "partial",
      frames: [frame(2)],
      gaps: [gap(0, 2, "overflow")],
    });
    const report = projectMelBandTimeline(timeline, [
      row(origin, origin + 3_000, 0, 1),
      row(origin + 3_000, origin + 6_144, 1, 2),
    ]);
    expect(report.rows.map((value) => value.gaps)).toEqual([
      [gap(0, 1, "overflow")],
      [gap(1, 1, "overflow")],
    ]);
    expect(
      report.rows.map((value) => [
        value.expectedRecords,
        value.recordCount,
        value.gapCount,
      ]),
    ).toEqual([
      [1, 0, 1],
      [2, 1, 1],
    ]);
  });

  it("uses only retained vectors for row arithmetic and preserves frame analysis", () => {
    const timeline = melBandTimelineSchema.parse({
      ...fixture(),
      status: "partial",
      frames: [
        { ...frame(0), magnitudes: magnitudes(1, 1) },
        { ...frame(2), magnitudes: magnitudes(3, 9) },
      ],
      gaps: [gap(1)],
    });
    const report = projectMelBandTimeline(timeline, [row()]);
    expect(report.rows[0]!.aggregation).toEqual(
      aggregateMelBandFrames(timeline.frames.map((value) => value.magnitudes)),
    );
    const aggregation = report.rows[0]!.aggregation;
    if (aggregation.status !== "completed") throw new Error("Missing analysis");
    expect(aggregation.analysis.ratios[0].lowMid.value).toBe(4 / 35);
    expect(aggregation.analysis.ratios[1].lowMid).toEqual({
      value: null,
      reason: "zero-denominator",
    });
    expect(report.rows[0]!.frames[0]!.analysis.ratios[0].lowMid.value).toBe(
      2 / 7,
    );
  });

  it.each(
    [
      [],
      [row(origin + 1)],
      [row(origin, origin + 6_145)],
      [row(origin, origin + 2_000), row(origin + 2_001, origin + 6_144, 1, 2)],
      [row(origin, origin + 2_001), row(origin + 2_000, origin + 6_144, 1, 2)],
      [row(origin, origin + 2_000), row(origin + 2_000, origin + 6_144, 2, 3)],
      [row(origin, origin)],
      [row(origin, origin + 6_144, NaN, 1)],
      [{ ...row(), extra: true }],
      Array(1),
      Array(2_001).fill(row()),
    ].map((rows) => ({ rows })),
  )("rejects non-partitioning or malformed reporting rows %#", ({ rows }) => {
    expect(() =>
      projectMelBandTimeline(melBandTimelineSchema.parse(fixture()), rows),
    ).toThrow();
  });

  it("revalidates timeline inputs and freezes results without mutating callers", () => {
    const input = fixture();
    const before = structuredClone(input);
    const report = projectMelBandTimeline(melBandTimelineSchema.parse(input), [
      row(),
    ]);
    expect(input).toEqual(before);
    const frozen = (value: unknown) => {
      if (value !== null && typeof value === "object") {
        expect(Object.isFrozen(value)).toBe(true);
        Object.values(value).forEach(frozen);
      }
    };
    frozen(report);
    expect(() =>
      projectMelBandTimeline(
        { ...melBandTimelineSchema.parse(input), expectedRecords: 4 },
        [row()],
      ),
    ).toThrow();
  });
});
