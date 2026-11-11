import { describe, expect, it } from "vitest";
import { createSyntheticMetricListeningObservation } from "./testing.js";
import { MEL_BAND_PROFILE } from "./mel-band-profile.js";
import { melBandTimelineSchema } from "./mel-band-timeline.js";
import { PITCH_PROFILE, SPECTRAL_SHAPE_PROFILE } from "./analyzer-profile.js";
import {
  classifyPitchEstimate,
  pitchTimelineSchema,
  spectralShapeTimelineSchema,
} from "./analyzer-timeline.js";
import {
  LISTENING_FEATURE_DEFINITIONS,
  LISTENING_FEATURE_LIMITS,
  compareListeningFeatures,
  extractListeningFeature,
  extractListeningFeatures,
  listeningFeatureSchema,
  type ListeningFeatureRange,
} from "./listening-features.js";

function healthy() {
  const observation = createSyntheticMetricListeningObservation({
    tempoBpm: 351.5625,
    endBeat: 1,
    startSample: 0,
  });
  observation.metrics["mel-bands"] = melBandTimelineSchema.parse({
    schema: "mel-band-timeline/v1",
    status: "complete",
    sampleRate: 48000,
    profile: MEL_BAND_PROFILE,
    sourceSupport: observation.sourceCoverage,
    expectedRecords: 4,
    gaps: [],
    frames: Array.from({ length: 4 }, (_, index) => ({
      index,
      support: { startSample: index * 2048, endSample: (index + 1) * 2048 },
      magnitudes: [
        Array.from({ length: 24 }, () => index + 1),
        Array.from({ length: 24 }, () => 2 * (index + 1)),
      ],
    })),
  });
  const analyzer = {
    status: "complete",
    sampleRate: 48000,
    sourceSupport: observation.sourceCoverage,
    expectedRecords: 4,
    trailingSupport: null,
    gaps: [],
  };
  observation.metrics.pitch = pitchTimelineSchema.parse({
    ...analyzer,
    schema: "pitch-timeline/v1",
    profile: PITCH_PROFILE,
    frames: Array.from({ length: 4 }, (_, index) => ({
      index,
      support: { startSample: index * 2048, endSample: (index + 1) * 2048 },
      channels: [
        classifyPitchEstimate(440, 0.99),
        classifyPitchEstimate(880, 0.95),
      ],
    })),
  });
  observation.metrics["spectral-shape"] = spectralShapeTimelineSchema.parse({
    ...analyzer,
    schema: "spectral-shape-timeline/v1",
    profile: SPECTRAL_SHAPE_PROFILE,
    frames: Array.from({ length: 4 }, (_, index) => ({
      index,
      support: { startSample: index * 2048, endSample: (index + 1) * 2048 },
      channels: [0, 1].map(() => ({
        state: "valid",
        flatnessDb: -20,
        spreadHz: 500,
        rolloffHz: 1000,
      })),
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

describe("stored listening feature arithmetic", () => {
  it("extracts all fifteen healthy features with one canonical distance each and no source mutation", () => {
    const { observation, range } = healthy();
    const before = JSON.stringify(observation);
    const features = extractListeningFeatures(observation, range);
    expect(features).toHaveLength(15);
    expect(new Set(features.map((f) => f.type)).size).toBe(15);
    for (const feature of features) {
      expect(feature.status, feature.type).toBe("ready");
      const definition = LISTENING_FEATURE_DEFINITIONS.find(
        (d) => d.type === feature.type,
      )!;
      expect(feature.values).toHaveLength(
        definition.dimensions * (definition.grid ? 4 : 1),
      );
      expect(compareListeningFeatures(feature, feature)).toMatchObject({
        status: "comparable",
        distance: 0,
        distanceDefinition: definition.distanceDefinition,
      });
    }
    expect(JSON.stringify(observation)).toBe(before);
  });

  it("owns golden absolute, RMS and Euclidean arithmetic without blending units", () => {
    const { observation, range } = healthy();
    for (const definition of LISTENING_FEATURE_DEFINITIONS.filter(
      (definition) =>
        definition.profile !== "pitch-profile/v1" &&
        definition.profile !== "spectral-shape-profile/v1",
    )) {
      const source = extractListeningFeature(
        definition.type,
        observation,
        range,
      );
      const normalized = definition.normalization === "joint-l2";
      const left = listeningFeatureSchema.parse({
        ...source,
        values: source.values!.map((_, index) =>
          normalized && index === 0 ? 1 : 0,
        ),
      });
      const right = listeningFeatureSchema.parse({
        ...source,
        values: source.values!.map((_, index) =>
          normalized ? (index === 1 ? 1 : 0) : 2,
        ),
      });
      const sum = normalized ? 2 : source.values!.length * 4;
      const distance = Math.sqrt(
        definition.distanceDefinition.startsWith("rms-")
          ? sum / source.values!.length
          : sum,
      );
      expect(compareListeningFeatures(left, right)).toMatchObject({
        status: "comparable",
        distance,
      });
    }
    const features = extractListeningFeatures(observation, range);
    expect(compareListeningFeatures(features[0]!, features[1]!)).toMatchObject({
      reason: "incompatible-type",
    });
    const changed = listeningFeatureSchema.parse({
      ...features[1],
      profileKey: "different-settings",
    });
    expect(compareListeningFeatures(features[1]!, changed)).toMatchObject({
      reason: "incompatible-profile",
    });
    const meter = listeningFeatureSchema.parse({
      ...features[1],
      grid: { ...features[1]!.grid, meter: { numerator: 3, denominator: 4 } },
    });
    expect(compareListeningFeatures(features[1]!, meter)).toMatchObject({
      reason: "incompatible-grid",
    });
  });

  it("keeps all summary families available without alignment but never fabricates a grid", () => {
    const { observation } = healthy();
    for (const feature of extractListeningFeatures(observation)) {
      const definition = LISTENING_FEATURE_DEFINITIONS.find(
        (d) => d.type === feature.type,
      )!;
      expect(feature.status).toBe(definition.grid ? "unavailable" : "ready");
      if (definition.grid) expect(feature.reason).toBe("missing-alignment");
      expect(feature.grid).toBeNull();
    }
  });

  it("weights RMS by complete sample energy and rejects splitting coarse records", () => {
    const { observation, range } = healthy();
    observation.metrics.level.records = [
      {
        index: 0,
        support: { startSample: 0, endSample: 512 },
        peak: [4, 4],
        rms: [2, 4],
      },
      {
        index: 1,
        support: { startSample: 512, endSample: 2048 },
        peak: [4, 4],
        rms: [4, 2],
      },
    ];
    const first = {
      ...range,
      endBeat: 0.25,
      endSample: 2048,
      grid: { ...range.grid!, cells: [range.grid!.cells[0]!] },
    };
    const feature = extractListeningFeature(
      "level-grid/v1",
      observation,
      first,
    );
    expect(feature.values).toEqual([Math.sqrt(13), Math.sqrt(7)]);
    const cut = {
      ...first,
      endBeat: 0.125,
      endSample: 1024,
      grid: {
        ...first.grid,
        cells: [
          { startBeat: 0, endBeat: 0.125, startSample: 0, endSample: 1024 },
        ],
      },
    };
    expect(
      extractListeningFeature("level-grid/v1", observation, cut),
    ).toMatchObject({
      status: "unavailable",
      reason: "straddling-level-record",
      values: null,
    });
    expect(
      extractListeningFeature("peak-summary/v1", observation, cut),
    ).toMatchObject({ reason: "straddling-level-record" });
  });

  it("projects spectral windows by overlap and distinguishes silent centroid from measured zero energy", () => {
    const { observation, range } = healthy();
    observation.metrics["spectral-centroid"].records[0]!.spectralEnergy = 10;
    const cut = { ...range, startSample: 1024, startBeat: 0.125 };
    const energy = extractListeningFeature(
      "spectral-energy-summary/v1",
      observation,
      cut,
    );
    expect(energy.values![0]).toBeCloseTo((10 * 1024 + 2 * 6144) / 7168);
    const first = observation.metrics["spectral-centroid"].records[0]!;
    first.spectralEnergy = 0;
    first.centroidHz = null;
    expect(
      extractListeningFeature("centroid-grid/v1", observation, range),
    ).toMatchObject({
      status: "ready",
      values: [null, 500, 500, 500],
      grid: {
        cells: [
          { reason: "undefined-descriptor" },
          { reason: null },
          { reason: null },
          { reason: null },
        ],
      },
    });
    for (const record of observation.metrics["spectral-centroid"].records)
      record.spectralEnergy = 0;
    expect(
      extractListeningFeature("spectral-energy-summary/v1", observation, range),
    ).toMatchObject({ status: "ready", values: [0] });
  });

  it("assigns detector endpoints once, including final endpoints, and requires complete coverage for event-free zeros", () => {
    const { observation, range } = healthy();
    observation.metrics.attacks.records[0]!.events = [
      { sample: 4800, strength: 8 },
    ];
    observation.metrics.attacks.records[1]!.events = [
      { sample: 8192, strength: 12 },
    ];
    expect(
      extractListeningFeature("attack-activity-grid/v1", observation, range)
        .values,
    ).toEqual([0, 0, 1, 1]);
    expect(
      extractListeningFeature("attack-strength-grid/v1", observation, range)
        .values,
    ).toEqual([0, 0, 8, 12]);
    observation.metrics.attacks.records.shift();
    expect(
      extractListeningFeature("attack-activity-grid/v1", observation, range),
    ).toMatchObject({
      status: "ready",
      values: [null, null, null, 1],
    });
  });

  it("compares identical partial masks over defined cells only and rejects wholly undefined vectors", () => {
    const { observation, range } = healthy();
    observation.metrics["spectral-centroid"].records[0]!.centroidHz = null;
    observation.metrics["spectral-centroid"].records[0]!.spectralEnergy = 0;
    const first = extractListeningFeature(
      "centroid-grid/v1",
      observation,
      range,
    );
    const shifted = listeningFeatureSchema.parse({
      ...first,
      values: [null, 503, 503, 503],
    });
    expect(compareListeningFeatures(first, shifted)).toMatchObject({
      status: "comparable",
      distance: 3,
    });
    const differentMask = listeningFeatureSchema.parse({
      ...first,
      values: [500, null, 500, 500],
      grid: {
        ...first.grid,
        cells: first.grid!.cells.map((cell, index) => ({
          ...cell,
          reason: index === 1 ? "undefined-descriptor" : null,
        })),
      },
    });
    expect(compareListeningFeatures(first, differentMask)).toMatchObject({
      status: "not-comparable",
      reason: "incompatible-support",
    });
    for (const record of observation.metrics["spectral-centroid"].records) {
      record.centroidHz = null;
      record.spectralEnergy = 0;
    }
    const undefinedFeature = extractListeningFeature(
      "centroid-grid/v1",
      observation,
      range,
    );
    expect(undefinedFeature).toMatchObject({
      status: "unavailable",
      reason: "undefined-descriptor",
      values: null,
    });
    expect(compareListeningFeatures(first, undefinedFeature)).toMatchObject({
      status: "not-comparable",
      reason: "unavailable",
    });
  });

  it("weights mel by overlapping support, normalizes jointly, and derives regions and ratios after aggregation", () => {
    const { observation, range } = healthy();
    const cut = { ...range, startBeat: 0.125, startSample: 1024 };
    const region = extractListeningFeature(
      "mel-region-summary/v1",
      observation,
      cut,
    );
    const mean = (1 * 1024 + 2 * 2048 + 3 * 2048 + 4 * 2048) / 7168;
    const counts = ["low", "mid", "high"].map(
      (name) => MEL_BAND_PROFILE.bands.filter((b) => b.region === name).length,
    );
    [
      ...counts.map((n) => n * mean),
      ...counts.map((n) => n * mean * 2),
    ].forEach((value, index) =>
      expect(region.values![index]).toBeCloseTo(value, 12),
    );
    const shape = extractListeningFeature("mel-shape/v1", observation, range);
    expect(
      shape.values!.reduce<number>((sum, v) => sum + (v ?? 0) ** 2, 0),
    ).toBeCloseTo(1);
    expect(shape.values![24]! / shape.values![0]!).toBeCloseTo(2);
    const grid = extractListeningFeature("mel-grid/v1", observation, range);
    expect(
      grid.values!.reduce<number>((sum, v) => sum + (v ?? 0) ** 2, 0),
    ).toBeCloseTo(1);
    const ratios = extractListeningFeature(
      "mel-ratio-summary/v1",
      observation,
      range,
    );
    expect(ratios.values).toEqual([
      counts[0]! / counts[1]!,
      counts[2]! / counts[1]!,
      counts[0]! / counts[1]!,
      counts[2]! / counts[1]!,
    ]);
  });

  it("separates mel zero norm, zero denominator, below-floor and absent acquisition", () => {
    const { observation, range } = healthy();
    const mel = observation.metrics["mel-bands"]!;
    const zero = (value: number) =>
      melBandTimelineSchema.parse({
        ...mel,
        frames: mel.frames.map((frame) => ({
          ...frame,
          magnitudes: [
            Array.from({ length: 24 }, () => value),
            Array.from({ length: 24 }, () => value),
          ],
        })),
      });

    observation.metrics["mel-bands"] = zero(0);
    expect(
      extractListeningFeature("mel-shape/v1", observation, range).reason,
    ).toBe("zero-norm");
    expect(
      extractListeningFeature("mel-ratio-summary/v1", observation, range)
        .reason,
    ).toBe("zero-denominator");
    expect(
      extractListeningFeature("mel-region-summary/v1", observation, range)
        .values,
    ).toEqual([0, 0, 0, 0, 0, 0]);
    observation.metrics["mel-bands"] = zero(1e-15);
    expect(
      extractListeningFeature("mel-ratio-summary/v1", observation, range)
        .reason,
    ).toBe("below-floor");
    delete observation.metrics["mel-bands"];
    expect(
      extractListeningFeature("mel-shape/v1", observation, range).reason,
    ).toBe("not-requested");
  });

  it("takes ratios of weighted band means rather than averaging frame ratios", () => {
    const { observation, range } = healthy();
    const mel = observation.metrics["mel-bands"]!;
    observation.metrics["mel-bands"] = melBandTimelineSchema.parse({
      ...mel,
      frames: mel.frames.map((frame, index) => {
        const bands = MEL_BAND_PROFILE.bands.map((band) =>
          band.region === "mid"
            ? index % 2 === 0
              ? 1
              : 9
            : band.region === "low"
              ? index % 2 === 0
                ? 10
                : 0
              : 5,
        );
        return { ...frame, magnitudes: [bands, bands] };
      }),
    });
    const low = MEL_BAND_PROFILE.bands.filter((b) => b.region === "low").length;
    const mid = MEL_BAND_PROFILE.bands.filter((b) => b.region === "mid").length;
    const ratios = extractListeningFeature(
      "mel-ratio-summary/v1",
      observation,
      range,
    );
    expect(ratios.values![0]).toBeCloseTo(low / mid);
    expect(ratios.values![0]).not.toBeCloseTo((5 * low) / mid);
  });

  it("owns boundary events in the following cell and never localizes the whole detector window there", () => {
    const observation = createSyntheticMetricListeningObservation({
      tempoBpm: 300,
      endBeat: 1,
      startSample: 0,
    });
    const range = {
      ...observation.geometry,
      grid: {
        meter: { numerator: 4, denominator: 4 },
        phaseBeats: 0,
        cells: observation.geometry.rows,
      },
    };
    observation.metrics.attacks.records[0]!.events = [
      { sample: 4800, strength: 10 },
    ];
    observation.metrics.attacks.records[1]!.events = [];
    expect(
      extractListeningFeature("attack-activity-grid/v1", observation, range)
        .values,
    ).toEqual([0, 0, 1, 0]);
    expect(
      extractListeningFeature("attack-strength-grid/v1", observation, range)
        .values,
    ).toEqual([0, 0, 10, 0]);
  });
  it("retains summary acquisition gaps and rejects different support masks rather than intersecting them", () => {
    const { observation, range } = healthy();
    const full = extractListeningFeature("mel-shape/v1", observation, range);
    const timeline = observation.metrics["mel-bands"]!;
    observation.metrics["mel-bands"] = melBandTimelineSchema.parse({
      ...timeline,
      status: "partial",
      frames: timeline.frames.slice(1),
      gaps: [
        {
          firstIndex: 0,
          count: 1,
          support: { startSample: 0, endSample: 2048 },
          reason: "unavailable",
        },
      ],
    });
    const partial = extractListeningFeature("mel-shape/v1", observation, range);
    expect(partial).toMatchObject({
      status: "ready",
      coveredSamples: 6144,
      support: [[2048, 8192]],
    });
    expect(compareListeningFeatures(full, partial)).toMatchObject({
      reason: "incompatible-support",
    });
    const masked = extractListeningFeature("mel-grid/v1", observation, range);
    expect(masked).toMatchObject({
      status: "ready",
      supportPolicy: "matching-cell-mask",
    });
    expect(masked.values!.slice(0, 48)).toEqual(
      Array.from({ length: 48 }, () => null),
    );
    expect(compareListeningFeatures(masked, masked)).toMatchObject({
      status: "comparable",
      distance: 0,
    });
    expect(
      compareListeningFeatures(
        extractListeningFeature("mel-grid/v1", healthy().observation, range),
        masked,
      ),
    ).toMatchObject({
      status: "not-comparable",
      reason: "incompatible-support",
    });
  });

  it("proves the largest encoded fixed-registry vectors fit per-feature and batch ceilings", () => {
    const cells = Array.from({ length: 2000 }, (_, index) => ({
      startBeat: index / 4,
      endBeat: (index + 1) / 4,
      expectedSamples: 720,
      coveredSamples: 720,
      reason: null,
    }));
    const features = LISTENING_FEATURE_DEFINITIONS.map((definition) => {
      const length = definition.dimensions * (definition.grid ? 2000 : 1);
      const channelAware =
        definition.profile === "pitch-profile/v1" ||
        definition.profile === "spectral-shape-profile/v1";
      return listeningFeatureSchema.parse({
        type: definition.type,
        distanceDefinition: definition.distanceDefinition,
        units: definition.units,
        distanceUnits: definition.distanceUnits,
        profile: definition.profile,
        profileKey: "bounded-contract-example",
        status: "ready",
        reason: null,
        values: Array.from({ length }, () =>
          definition.normalization === "joint-l2"
            ? 1 / Math.sqrt(length)
            : definition.type === "pitch-grid/v1"
              ? 69
              : definition.type === "flatness-summary/v1"
                ? -20
                : 1,
        ),
        expectedSamples: 1440000,
        coveredSamples: 1440000,
        durationSeconds: 30,
        sampleRate: 48000,
        normalization: definition.normalization,
        supportPolicy: definition.grid
          ? "matching-cell-mask"
          : definition.type === "peak-summary/v1"
            ? "complete-required"
            : "retained-overlap",
        support: [[0, 1440000]],
        ...(channelAware
          ? {
              channelSupport: [[[0, 1440000]], [[0, 1440000]]],
              channelReasons: [null, null],
            }
          : {}),
        grid: definition.grid
          ? {
              stepBeats: 0.25,
              meter: { numerator: 128, denominator: 1 },
              phaseBeats: 0,
              cells: channelAware
                ? cells.map((cell) => ({
                    ...cell,
                    channelCoveredSamples: [720, 720],
                    channelReasons: [null, null],
                  }))
                : cells,
            }
          : null,
        limitations: definition.limitations,
      });
    });
    for (const feature of features) {
      expect(Buffer.byteLength(JSON.stringify(feature))).toBeLessThan(
        LISTENING_FEATURE_LIMITS.featureBytes,
      );
    }
    expect(Buffer.byteLength(JSON.stringify(features))).toBeLessThan(
      LISTENING_FEATURE_LIMITS.batchBytes,
    );
  });
});
