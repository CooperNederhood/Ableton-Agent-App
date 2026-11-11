import { describe, expect, it } from "vitest";
import { createSyntheticMetricListeningObservation } from "./testing.js";
import {
  PITCH_PROFILE,
  SPECTRAL_SHAPE_PROFILE,
  MIN_SPECTRAL_FLATNESS_DB,
} from "./analyzer-profile.js";
import {
  classifyPitchEstimate,
  pitchTimelineSchema,
  spectralShapeTimelineSchema,
  deriveAnalyzerTrailingSupport,
  type PitchChannel,
  type SpectralShapeChannel,
} from "./analyzer-timeline.js";
import {
  compareListeningFeatures,
  extractListeningFeature,
  listeningFeatureSchema,
  type ListeningFeatureRange,
  type ListeningFeatureType,
} from "./listening-features.js";

type Pair<T> = readonly [T, T];
const accepted = classifyPitchEstimate(440, 0.99);
const healthyShape: SpectralShapeChannel = {
  state: "valid",
  flatnessDb: -20,
  spreadHz: 500,
  rolloffHz: 1000,
};
function fixture(
  options: {
    pitch?: (index: number) => Pair<PitchChannel>;
    shape?: (index: number) => Pair<SpectralShapeChannel>;
    gap?: number;
    tempoBpm?: number;
    endBeat?: number;
  } = {},
) {
  const observation = createSyntheticMetricListeningObservation({
    tempoBpm: options.tempoBpm ?? 351.5625,
    endBeat: options.endBeat ?? 1,
    startSample: 0,
  });
  const expectedRecords = Math.floor(observation.geometry.endSample / 2048);
  const frames = Array.from({ length: expectedRecords }, (_, index) => ({
    index,
    support: { startSample: index * 2048, endSample: (index + 1) * 2048 },
  })).filter((frame) => frame.index !== options.gap);
  const common = {
    status: options.gap === undefined ? "complete" : "partial",
    sampleRate: 48000,
    sourceSupport: observation.sourceCoverage,
    expectedRecords,
    trailingSupport: deriveAnalyzerTrailingSupport(observation.sourceCoverage),
    gaps:
      options.gap === undefined
        ? []
        : [
            {
              firstIndex: options.gap,
              count: 1,
              reason: "sequence-gap",
              support: {
                startSample: options.gap * 2048,
                endSample: (options.gap + 1) * 2048,
              },
            },
          ],
  };
  observation.metrics.pitch = pitchTimelineSchema.parse({
    ...common,
    schema: "pitch-timeline/v1",
    profile: PITCH_PROFILE,
    frames: frames.map((frame) => ({
      ...frame,
      channels: options.pitch?.(frame.index) ?? [accepted, accepted],
    })),
  });
  observation.metrics["spectral-shape"] = spectralShapeTimelineSchema.parse({
    ...common,
    schema: "spectral-shape-timeline/v1",
    profile: SPECTRAL_SHAPE_PROFILE,
    frames: frames.map((frame) => ({
      ...frame,
      channels: options.shape?.(frame.index) ?? [healthyShape, healthyShape],
    })),
  });
  const range: ListeningFeatureRange = {
    ...observation.geometry,
    grid: {
      meter: { numerator: 4, denominator: 4 },
      phaseBeats: 0,
      cells: observation.geometry.rows,
    },
  };
  return { observation, range };
}
const analyzerTypes: ListeningFeatureType[] = [
  "pitch-grid/v1",
  "pitch-confidence-summary/v1",
  "flatness-summary/v1",
  "spread-summary/v1",
  "rolloff-summary/v1",
];
describe("qualified analyzer feature arithmetic", () => {
  it("retains immutable source values and independent physical units for all five mappings", () => {
    const { observation, range } = fixture();
    const before = JSON.stringify(observation);
    for (const type of analyzerTypes) {
      const feature = extractListeningFeature(type, observation, range);
      expect(feature).toMatchObject({
        status: "ready",
        channelSupport: [[[0, 8192]], [[0, 8192]]],
        channelReasons: [null, null],
      });
      expect(compareListeningFeatures(feature, feature)).toMatchObject({
        status: "comparable",
        distance: 0,
        units: feature.distanceUnits,
      });
    }
    expect(
      extractListeningFeature("pitch-grid/v1", observation, range),
    ).toMatchObject({
      units: "midi-semitones",
      distanceUnits: "cents",
      values: Array(8).fill(69),
    });
    expect(
      extractListeningFeature("flatness-summary/v1", observation).values,
    ).toEqual([-20, -20]);
    expect(JSON.stringify(observation)).toBe(before);
  });

  it("uses log-space support weighting and RMS cents without octave equivalence", () => {
    const left = fixture({
      tempoBpm: 175.78125,
      endBeat: 0.5,
      pitch: (index) => [
        classifyPitchEstimate(index % 2 ? 880 : 440, 0.99),
        accepted,
      ],
    });
    const half: ListeningFeatureRange = {
      ...left.range,
      endBeat: 0.25,
      endSample: 4096,
      grid: {
        ...left.range.grid!,
        cells: [
          { startBeat: 0, endBeat: 0.25, startSample: 0, endSample: 4096 },
        ],
      },
    };
    expect(
      extractListeningFeature("pitch-grid/v1", left.observation, half).values,
    ).toEqual([75, 69]);
    const base = fixture();
    const octave = fixture({
      pitch: () => [
        classifyPitchEstimate(880, 0.99),
        classifyPitchEstimate(880, 0.99),
      ],
    });
    expect(
      compareListeningFeatures(
        extractListeningFeature("pitch-grid/v1", base.observation, base.range),
        extractListeningFeature(
          "pitch-grid/v1",
          octave.observation,
          octave.range,
        ),
      ),
    ).toMatchObject({
      distance: 1200,
      units: "cents",
      distanceDefinition: "rms-cents/v1",
    });
  });

  it.each([
    [classifyPitchEstimate(440, 0.4), "low-confidence", 0.4],
    [classifyPitchEstimate(100, 0.98), "outside-qualified-range", 0.98],
    [classifyPitchEstimate(0, 0), "undefined-descriptor", 0],
  ] as const)(
    "retains finite rejected estimator scores without inventing pitch (%j)",
    (channel, reason, score) => {
      const { observation, range } = fixture({
        pitch: () => [accepted, channel],
      });
      const grid = extractListeningFeature("pitch-grid/v1", observation, range);
      expect(grid).toMatchObject({
        status: "ready",
        channelReasons: [null, reason],
        channelSupport: [[[0, 8192]], []],
      });
      expect(grid.values).toEqual([69, null, 69, null, 69, null, 69, null]);
      expect(
        grid.grid!.cells.every((cell) => cell.channelCoveredSamples?.[1] === 0),
      ).toBe(true);
      expect(
        extractListeningFeature("pitch-confidence-summary/v1", observation)
          .values,
      ).toEqual([0.99, score]);
    },
  );

  it.each(["silence", "undefined", "invalid"] as const)(
    "preserves the healthy spectral channel beside %s",
    (state) => {
      const absent: SpectralShapeChannel = {
        state,
        flatnessDb: null,
        spreadHz: null,
        rolloffHz: null,
      };
      const { observation } = fixture({ shape: () => [healthyShape, absent] });
      for (const type of [
        "flatness-summary/v1",
        "spread-summary/v1",
        "rolloff-summary/v1",
      ] as const) {
        const feature = extractListeningFeature(type, observation);
        expect(feature.status).toBe("ready");
        expect(feature.values![1]).toBeNull();
        expect(feature.channelSupport).toEqual([[[0, 8192]], []]);
        expect(feature.channelReasons![1]).toBe(
          state === "undefined"
            ? "undefined-descriptor"
            : state === "invalid"
              ? "invalid-output"
              : state,
        );
      }
    },
  );

  it("makes wholly invalid/silent descriptors unavailable while preserving finite raw rejected source values", () => {
    const invalid = classifyPitchEstimate(-1, 1.1);
    const silence: SpectralShapeChannel = {
      state: "silence",
      flatnessDb: null,
      spreadHz: null,
      rolloffHz: null,
    };
    const { observation, range } = fixture({
      pitch: () => [invalid, invalid],
      shape: () => [silence, silence],
    });
    const before = JSON.stringify(observation);
    for (const type of analyzerTypes)
      expect(extractListeningFeature(type, observation, range)).toMatchObject({
        status: "unavailable",
        values: null,
        reason: type.startsWith("pitch") ? "invalid-output" : "silence",
      });
    expect(JSON.stringify(observation)).toBe(before);
    expect(observation.metrics.pitch!.frames[0]!.channels[0]).toEqual({
      state: "invalid",
      hz: -1,
      confidence: 1.1,
    });
  });

  it("keeps acquisition gaps and descriptor masks distinct and never intersects non-identical masks", () => {
    const base = fixture();
    const gap = fixture({ gap: 1 });
    const gapped = extractListeningFeature(
      "pitch-grid/v1",
      gap.observation,
      gap.range,
    );
    expect(gapped.values).toEqual([69, 69, null, null, 69, 69, 69, 69]);
    expect(gapped.support).toEqual([
      [0, 2048],
      [4096, 8192],
    ]);
    expect(compareListeningFeatures(gapped, gapped)).toMatchObject({
      distance: 0,
    });
    expect(
      compareListeningFeatures(
        extractListeningFeature("pitch-grid/v1", base.observation, base.range),
        gapped,
      ),
    ).toMatchObject({ reason: "incompatible-support" });
    const rejected = fixture({
      pitch: (index) => [
        index === 1 ? classifyPitchEstimate(440, 0.2) : accepted,
        accepted,
      ],
    });
    const mask = extractListeningFeature(
      "pitch-grid/v1",
      rejected.observation,
      rejected.range,
    );
    expect(mask.support).toEqual([[0, 8192]]);
    expect(mask.channelSupport).toEqual([
      [
        [0, 2048],
        [4096, 8192],
      ],
      [[0, 8192]],
    ]);
    expect(compareListeningFeatures(mask, gapped)).toMatchObject({
      reason: "incompatible-support",
    });
    const a = fixture({
      shape: (index) => [
        index === 0
          ? {
              state: "undefined",
              flatnessDb: null,
              spreadHz: null,
              rolloffHz: null,
            }
          : healthyShape,
        healthyShape,
      ],
    });
    const b = fixture({
      shape: (index) => [
        index === 1
          ? {
              state: "undefined",
              flatnessDb: null,
              spreadHz: null,
              rolloffHz: null,
            }
          : healthyShape,
        healthyShape,
      ],
    });
    const summaryA = extractListeningFeature(
      "flatness-summary/v1",
      a.observation,
    );
    const summaryB = extractListeningFeature(
      "flatness-summary/v1",
      b.observation,
    );
    expect(summaryA.values).toEqual(summaryB.values);
    expect(compareListeningFeatures(summaryA, summaryB)).toMatchObject({
      reason: "incompatible-support",
    });
  });

  it("owns canonical Euclidean summary distances, signed flatness floor and strict numeric domains", () => {
    const { observation } = fixture();
    for (const [type, values, distance] of [
      ["pitch-confidence-summary/v1", [0.39, 0.19], 1],
      ["flatness-summary/v1", [-23, -24], 5],
      ["spread-summary/v1", [503, 504], 5],
      ["rolloff-summary/v1", [1003, 1004], 5],
    ] as const) {
      const feature = extractListeningFeature(type, observation);
      const result = compareListeningFeatures(
        feature,
        listeningFeatureSchema.parse({ ...feature, values }),
      );
      expect(result.status).toBe("comparable");
      if (result.status === "comparable")
        expect(result.distance).toBeCloseTo(distance);
    }
    const floor = fixture({
      shape: () => [
        { ...healthyShape, flatnessDb: MIN_SPECTRAL_FLATNESS_DB },
        healthyShape,
      ],
    });
    expect(
      extractListeningFeature("flatness-summary/v1", floor.observation)
        .values![0],
    ).toBe(MIN_SPECTRAL_FLATNESS_DB);
    const feature = extractListeningFeature("flatness-summary/v1", observation);
    for (const change of [
      { values: [1, 1] },
      { distanceUnits: "Hz" },
      { distanceDefinition: "euclidean-db/v2" },
      { channelSupport: [[[0, 8193]], [[0, 8192]]] },
      { channelReasons: [null, "silence"] },
    ])
      expect(
        listeningFeatureSchema.safeParse({ ...feature, ...change }).success,
      ).toBe(false);
  });

  it("rejects profile/rate/source-version mismatches and never upgrades the known octave counterexample into truth", () => {
    const { observation, range } = fixture();
    const feature = extractListeningFeature(
      "pitch-grid/v1",
      observation,
      range,
    );
    expect(
      compareListeningFeatures(feature, {
        ...feature,
        profileKey: "other-profile",
      }),
    ).toMatchObject({ reason: "incompatible-profile" });
    expect(
      compareListeningFeatures(feature, {
        ...feature,
        sampleRate: 44100,
        durationSeconds: 8192 / 44100,
      }),
    ).toMatchObject({ reason: "incompatible-profile" });
    expect(
      pitchTimelineSchema.safeParse({
        ...observation.metrics.pitch,
        profile: { ...PITCH_PROFILE, schema: "pitch-profile/v2" },
      }).success,
    ).toBe(false);
    const counterexample = fixture({
      pitch: () => [classifyPitchEstimate(1000, 0.99), accepted],
    });
    const measured = extractListeningFeature(
      "pitch-grid/v1",
      counterexample.observation,
      counterexample.range,
    );
    expect(measured.values![0]).toBeCloseTo(69 + 12 * Math.log2(1000 / 440));
    expect(measured.limitations.some((text) => text.includes("2000Hz"))).toBe(
      true,
    );
    delete observation.metrics.pitch;
    expect(
      extractListeningFeature("pitch-grid/v1", observation, range),
    ).toMatchObject({ status: "unavailable", reason: "not-requested" });
  });

  it("requires complete usable pitch-cell support and preserves unaligned summary availability", () => {
    const { observation, range } = fixture({
      tempoBpm: 175.78125,
      endBeat: 0.5,
      pitch: (index) => [
        index === 1 ? classifyPitchEstimate(440, 0.5) : accepted,
        accepted,
      ],
    });
    const coarse = {
      ...range,
      endSample: 4096,
      endBeat: 0.25,
      grid: {
        ...range.grid!,
        cells: [
          { startSample: 0, endSample: 4096, startBeat: 0, endBeat: 0.25 },
        ],
      },
    };
    expect(
      extractListeningFeature("pitch-grid/v1", observation, coarse),
    ).toMatchObject({
      values: [null, 69],
      grid: {
        cells: [
          {
            channelCoveredSamples: [2048, 4096],
            channelReasons: ["low-confidence", null],
          },
        ],
      },
    });
    expect(extractListeningFeature("pitch-grid/v1", observation)).toMatchObject(
      { status: "unavailable", reason: "missing-alignment" },
    );
    for (const type of analyzerTypes.filter((type) => type !== "pitch-grid/v1"))
      expect(extractListeningFeature(type, observation).status).toBe("ready");
  });

  it("retains explicit unpadded tails and rejects mismatched timeline source geometry", () => {
    const { observation, range } = fixture({ endBeat: 1.01 });
    const feature = extractListeningFeature(
      "pitch-grid/v1",
      observation,
      range,
    );
    expect(observation.metrics.pitch!.status).toBe("complete");
    expect(feature.coveredSamples).toBe(8192);
    expect(feature.expectedSamples).toBeGreaterThan(8192);
    expect(feature.values!.slice(-2)).toEqual([null, null]);
    expect(feature.grid!.cells.at(-1)!.channelReasons).toEqual([
      "insufficient-support",
      "insufficient-support",
    ]);
    observation.metrics.pitch = pitchTimelineSchema.parse({
      ...observation.metrics.pitch,
      sampleRate: 44100,
    });
    expect(
      extractListeningFeature("pitch-grid/v1", observation, range),
    ).toMatchObject({
      status: "unavailable",
      reason: "incompatible-source-support",
      support: [],
      channelSupport: [[], []],
    });
  });

  it("weights retained signed spectral values by overlap rather than counting frames", () => {
    const { observation, range } = fixture({
      shape: (index) => [
        {
          ...healthyShape,
          flatnessDb: -20 * (index + 1),
          spreadHz: 500 * (index + 1),
          rolloffHz: 1000 * (index + 1),
        },
        healthyShape,
      ],
    });
    const cut = { ...range, startSample: 1024, startBeat: 0.125 };
    const weight = (1024 + 2 * 2048 + 3 * 2048 + 4 * 2048) / 7168;
    for (const [type, factor] of [
      ["flatness-summary/v1", -20],
      ["spread-summary/v1", 500],
      ["rolloff-summary/v1", 1000],
    ] as const) {
      const feature = extractListeningFeature(type, observation, cut);
      expect(feature.values![0]).toBeCloseTo(factor * weight);
      expect(feature.channelSupport).toEqual([[[0, 7168]], [[0, 7168]]]);
    }
  });
});
