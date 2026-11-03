import { describe, expect, it } from "vitest";
import {
  audioObservationSchema,
  audioObservationV2Schema,
  legacyStoredAudioObservationSchema,
  storedAudioObservationSchema,
  storedObservationCoordinates,
} from "./audio-observation-schemas.js";
import { MAX_METRIC_OBSERVATION_BYTES } from "./audio-observation-limits.js";
import { createSyntheticMetricListeningObservation } from "./testing.js";
import {
  createMetricObservationReportRows,
  deriveMetricAttackEvents,
  MAX_METRIC_ATTACK_STRENGTH_DB,
  MAX_METRIC_OBSERVATION_AMPLITUDE,
  metricAudioObservationSchema,
  type MetricAudioObservation,
} from "./metric-observation-schemas.js";

type Metric = MetricAudioObservation["requestedMetrics"][number];
const metricNames: Metric[] = ["level", "spectral-centroid", "attacks"];
const uuid = "00000000-0000-4000-8000-000000000001";

it("unknown spectral phase is explicit failed availability, never invented silence or cadence", () => {
  const value = fixture();
  const spectrum = value.metrics["spectral-centroid"];
  if (!spectrum.algorithm)
    throw new Error("fixture spectrum algorithm missing");
  spectrum.algorithm.firstFrameEndSample = null;
  spectrum.status = "failed";
  value.outcome = "partial";
  spectrum.records = [];
  spectrum.gaps = [];
  spectrum.expectedRecords = 0;
  spectrum.limitations = [
    "FFT phase unavailable; timed supports cannot be established.",
  ];
  value.rows = createMetricObservationReportRows(value);
  const parsed = metricAudioObservationSchema.safeParse(value);
  expect(parsed.error?.issues).toEqual(undefined);
  expect(
    value.rows.every(
      (row) => row["spectral-centroid"].availability === "unknown-phase",
    ),
  ).toBe(true);
  spectrum.status = "complete";
  expect(metricAudioObservationSchema.safeParse(value).success).toBe(false);
});

function fixture(
  ...args: Parameters<typeof createSyntheticMetricListeningObservation>
): MetricAudioObservation {
  const value = createSyntheticMetricListeningObservation(...args);
  // Most structural cases do not need detections. Deliberately keep this
  // independent input silent rather than deriving it from musical-level rows.
  for (const record of value.metrics.attacks.records) {
    record.inputLevel = { peak: [0, 0], rms: [0, 0] };
    record.events = [];
  }
  return reproject(value);
}

function attackFromSilence(
  value: MetricAudioObservation,
  index = 0,
  rms = 1,
): MetricAudioObservation["metrics"]["attacks"]["records"][number] {
  const record = value.metrics.attacks.records[index]!;
  record.inputLevel = { peak: [rms, rms], rms: [rms, rms] };
  record.events = [
    {
      sample: record.support.endSample,
      strength: 20 * Math.log10(rms) - -120,
    },
  ];
  return record;
}

function retainAttackPrefix(
  value: MetricAudioObservation,
  length: number,
): void {
  const acquisition = value.metrics.attacks;
  const missing = acquisition.records.splice(length);
  acquisition.status = length === 0 ? "failed" : "partial";
  acquisition.gaps = [
    {
      firstIndex: length,
      count: missing.length,
      startSample: missing[0]!.support.startSample,
      endSample: missing.at(-1)!.support.endSample,
      reason: "sequence-gap",
      detail: "Independent detector input delivery ended before this suffix",
    },
  ];
  value.outcome = "partial";
}

function reproject(value: MetricAudioObservation): MetricAudioObservation {
  value.rows = createMetricObservationReportRows(value);
  return value;
}

function failMetric(value: MetricAudioObservation, metric: Metric): void {
  const acquisition = value.metrics[metric];
  const first = acquisition.records[0]!;
  const last = acquisition.records.at(-1)!;
  acquisition.gaps = [
    {
      firstIndex: 0,
      count: acquisition.expectedRecords,
      startSample: first.support.startSample,
      endSample: last.support.endSample,
      reason: metric === "attacks" ? "dependency-unavailable" : "drain-timeout",
      detail: "No validated measurement records",
    },
  ];
  acquisition.records = [];
  acquisition.status = "failed";
  value.outcome = "partial";
}

function unrequest(value: MetricAudioObservation, metric: Metric): void {
  const acquisition = value.metrics[metric];
  value.requestedMetrics = value.requestedMetrics.filter(
    (item) => item !== metric,
  );
  acquisition.algorithm = null;
  acquisition.status = "not-requested";
  acquisition.expectedRecords = 0;
  acquisition.records = [];
  acquisition.gaps = [];
}

function expectInvalid(value: unknown): void {
  expect(metricAudioObservationSchema.safeParse(value).success).toBe(false);
}

describe("independent metric audio observation v1", () => {
  it("publishes independently valid detector inputs when musical-level delivery is missing", () => {
    const value = fixture();
    failMetric(value, "level");
    const result = metricAudioObservationSchema.parse(reproject(value));
    expect(result.outcome).toBe("partial");
    expect(result.metrics.attacks.status).toBe("complete");
    expect(result.metrics.level.status).toBe("failed");
  });

  describe("canonical detector-prefix replay helper", () => {
    it("derives flat detections from input only without mutating or trusting event claims", () => {
      const value = fixture();
      const first = attackFromSilence(value, 0, 0.25);
      const later = attackFromSilence(value, 2, 0.5);
      first.events = [{ sample: 0, strength: NaN }];
      later.events = [];
      const before = structuredClone(value);
      expect(
        deriveMetricAttackEvents(
          value.metrics.attacks.records,
          value.metrics.attacks.algorithm!,
        ),
      ).toEqual([
        {
          sample: first.support.endSample,
          strength: 120 + 20 * Math.log10(0.25),
        },
        {
          sample: later.support.endSample,
          strength: 120 + 20 * Math.log10(0.5),
        },
      ]);
      expect(value).toEqual(before);
    });

    it("derives clipped capture-end and above-unity rises without inventing onset coordinates", () => {
      const value = fixture({ endBeat: 0.93 });
      const final = attackFromSilence(
        value,
        value.metrics.attacks.records.length - 1,
        64,
      );
      expect(
        deriveMetricAttackEvents(
          value.metrics.attacks.records,
          value.metrics.attacks.algorithm!,
        ),
      ).toEqual([
        {
          sample: final.support.endSample,
          strength: MAX_METRIC_ATTACK_STRENGTH_DB,
        },
      ]);
      expect(final.support.endSample).toBe(value.geometry.endSample);
    });

    it("returns an empty arithmetic result for empty inputs, not a publishable observation", () => {
      const value = fixture();
      expect(
        deriveMetricAttackEvents([], value.metrics.attacks.algorithm!),
      ).toEqual([]);
    });

    it.each(["index", "hole", "nonfinal-tail"] as const)(
      "rejects an invalid %s input prefix instead of resetting state",
      (kind) => {
        const value = fixture();
        const records = value.metrics.attacks.records;
        if (kind === "index") records.shift();
        if (kind === "hole") records[1]!.support.startSample++;
        if (kind === "nonfinal-tail") records[0]!.support.endSample--;
        expect(() =>
          deriveMetricAttackEvents(records, value.metrics.attacks.algorithm!),
        ).toThrow("invalid_metric_attack_input_prefix");
      },
    );

    it("rejects malformed levels, algorithm admission and over-budget prefixes", () => {
      const value = fixture();
      value.metrics.attacks.records[0]!.inputLevel.rms[0] = Infinity;
      expect(() =>
        deriveMetricAttackEvents(
          value.metrics.attacks.records,
          value.metrics.attacks.algorithm!,
        ),
      ).toThrow();
      expect(() =>
        deriveMetricAttackEvents([], {
          ...value.metrics.attacks.algorithm!,
          windowSamples: 1,
        }),
      ).toThrow();
      expect(() =>
        deriveMetricAttackEvents(
          Array.from({ length: 301 }, () => value.metrics.attacks.records[0]!),
          value.metrics.attacks.algorithm!,
        ),
      ).toThrow("metric_attack_prefix_limit");
    });
  });

  it("publishes attacks-only evidence without requesting the musical-level or FFT delivery streams", () => {
    const value = fixture();
    unrequest(value, "level");
    unrequest(value, "spectral-centroid");
    attackFromSilence(value);
    const result = metricAudioObservationSchema.parse(reproject(value));
    expect(result.requestedMetrics).toEqual(["attacks"]);
    expect(result.outcome).toBe("complete");
    expect(result.metrics.attacks.algorithm!.dependency).toBe("level");
    expect(result.metrics.attacks.algorithm!.inputSource).toBe(
      "independent-100ms-level-windows",
    );
    expect(result.metrics.attacks.records[0]!.events).toEqual([
      {
        sample: result.metrics.attacks.records[0]!.support.endSample,
        strength: 120,
      },
    ]);
  });

  it("treats a trustworthy silent detector-only prefix as useful partial data", () => {
    const value = fixture();
    unrequest(value, "level");
    unrequest(value, "spectral-centroid");
    retainAttackPrefix(value, 2);
    const result = metricAudioObservationSchema.parse(reproject(value));
    expect(result.outcome).toBe("partial");
    expect(result.metrics.attacks.status).toBe("partial");
    expect(
      result.metrics.attacks.records.every(
        (record) => record.events.length === 0,
      ),
    ).toBe(true);
    expect(result.metrics.attacks.gaps[0]!.firstIndex).toBe(2);
  });

  it("rejects detector-only publication when none of its requested inputs are useful", () => {
    const value = fixture();
    unrequest(value, "level");
    unrequest(value, "spectral-centroid");
    retainAttackPrefix(value, 0);
    expectInvalid(reproject(value));
  });

  it.each([
    undefined,
    null,
    { peak: [0, 0] },
    { peak: [0, 0], rms: [1, 0] },
    { peak: [65, 0], rms: [1, 0] },
    { peak: [1, 1], rms: [NaN, 0] },
    { peak: [1, 1], rms: [-1, 0] },
    { peak: [1, 1], rms: [0, Infinity] },
    { peak: [0, 0], rms: [0, 0], rawAudio: "forbidden" },
  ])(
    "rejects missing or invalid independently retained input levels %#",
    (inputLevel) => {
      const value = fixture();
      expectInvalid({
        ...value,
        metrics: {
          ...value.metrics,
          attacks: {
            ...value.metrics.attacks,
            records: value.metrics.attacks.records.map((record, index) =>
              index === 0 ? { ...record, inputLevel } : record,
            ),
          },
        },
      });
    },
  );

  it.each([undefined, "musical-reporting-rows"])(
    "requires the explicit independent detector input source %#",
    (inputSource) => {
      const value = fixture();
      expectInvalid({
        ...value,
        metrics: {
          ...value.metrics,
          attacks: {
            ...value.metrics.attacks,
            algorithm: { ...value.metrics.attacks.algorithm, inputSource },
          },
        },
      });
    },
  );

  it.each([0, 1])(
    "rejects detector records after an input gap at index %s even with empty event lists",
    (missingIndex) => {
      const value = fixture();
      const missing = value.metrics.attacks.records.splice(missingIndex, 1)[0]!;
      value.metrics.attacks.status = "partial";
      value.metrics.attacks.gaps = [
        {
          firstIndex: missingIndex,
          count: 1,
          ...missing.support,
          reason: "sequence-gap",
          detail:
            "The missing detector input leaves its subsequent state unknown",
        },
      ];
      value.outcome = "partial";
      expectInvalid(reproject(value));
    },
  );

  it("rejects duplicate or foreign detector input support instead of repairing prefix ownership", () => {
    const value = fixture();
    value.metrics.attacks.records[1]!.support = {
      ...value.metrics.attacks.records[0]!.support,
    };
    expectInvalid(reproject(value));
    const foreign = fixture();
    foreign.metrics.attacks.records[0]!.support.endSample++;
    expectInvalid(reproject(foreign));
    const duplicate = fixture();
    duplicate.metrics.attacks.records[1]!.index = 0;
    expectInvalid(reproject(duplicate));
  });

  it("does not claim complete attacks when a valid retained prefix has an explicit missing suffix", () => {
    const value = fixture();
    retainAttackPrefix(value, 2);
    value.metrics.attacks.status = "complete";
    expectInvalid(reproject(value));
  });

  it("rejects an invented or omitted detection and strength inconsistent with retained RMS", () => {
    const value = fixture();
    const record = attackFromSilence(value);
    const event = record.events[0]!;
    record.events = [];
    expectInvalid(reproject(value));
    record.events = [{ ...event, strength: event.strength - 1e-9 }];
    expectInvalid(reproject(value));
    record.events = [event];
    expect(
      metricAudioObservationSchema.parse(reproject(value)).metrics.attacks
        .status,
    ).toBe("complete");
    const silent = fixture();
    silent.metrics.attacks.records[0]!.events = [
      {
        sample: silent.metrics.attacks.records[0]!.support.endSample,
        strength: 0,
      },
    ];
    expectInvalid(reproject(silent));
  });

  it("uses the louder RMS channel, not channel averaging, for the unchanged detector", () => {
    const value = fixture();
    const record = attackFromSilence(value);
    record.inputLevel = { peak: [0.01, 1], rms: [0.01, 1] };
    expect(
      metricAudioObservationSchema.parse(reproject(value)).metrics.attacks
        .records[0]!.events[0]!.strength,
    ).toBe(120);
  });

  it("preserves the rise latch and resets it on a nonpositive rise", () => {
    const value = fixture();
    attackFromSilence(value, 0, 0.25);
    const levels = [0.25, 0.5, 0.5, 1, 1];
    value.metrics.attacks.records.forEach((record, index) => {
      const rms = levels[index]!;
      record.inputLevel = { peak: [rms, rms], rms: [rms, rms] };
    });
    const next = value.metrics.attacks.records[3]!;
    next.events = [
      {
        sample: next.support.endSample,
        strength: 20 * Math.log10(1) - 20 * Math.log10(0.5),
      },
    ];
    const result = metricAudioObservationSchema.parse(reproject(value));
    expect(
      result.metrics.attacks.records.map((record) => record.events.length),
    ).toEqual([1, 0, 0, 1, 0]);
    value.metrics.attacks.records[1]!.events = [
      {
        sample: value.metrics.attacks.records[1]!.support.endSample,
        strength: 20 * Math.log10(0.5) - 20 * Math.log10(0.25),
      },
    ];
    expectInvalid(reproject(value));
  });

  it("preserves refractory suppression without inventing a later reset after a missing input", () => {
    const value = fixture();
    value.metrics.attacks.algorithm!.minSpacingSamples =
      3 * value.metrics.attacks.algorithm!.windowSamples;
    attackFromSilence(value, 0);
    value.metrics.attacks.records[2]!.inputLevel = {
      peak: [1, 1],
      rms: [1, 1],
    };
    attackFromSilence(value, 4);
    const result = metricAudioObservationSchema.parse(reproject(value));
    expect(
      result.metrics.attacks.records.map((record) => record.events.length),
    ).toEqual([1, 0, 0, 0, 1]);
  });

  it("keeps the -120 dBFS floor distinct from silence or a positive rise at threshold zero", () => {
    const value = fixture();
    value.metrics.attacks.algorithm!.thresholdDb = 0;
    for (const record of value.metrics.attacks.records) {
      record.inputLevel = { peak: [1e-6, 1e-6], rms: [1e-6, 1e-6] };
    }
    expect(
      metricAudioObservationSchema
        .parse(value)
        .metrics.attacks.records.every((record) => record.events.length === 0),
    ).toBe(true);
    attackFromSilence(value, value.metrics.attacks.records.length - 1, 2e-6);
    expect(
      metricAudioObservationSchema
        .parse(reproject(value))
        .metrics.attacks.records.at(-1)!.events[0]!.strength,
    ).toBe(20 * Math.log10(2e-6) + 120);
  });

  it("publishes complete acquisition with reference-only rows and empty valid attacks", () => {
    const value = metricAudioObservationSchema.parse(fixture());
    expect(value.outcome).toBe("complete");
    expect(
      value.metrics.attacks.records.every(
        (record) => record.events.length === 0,
      ),
    ).toBe(true);
    expect(value.rows[0]!.level.availability).toBe("available");
    expect(value.rows[0]).not.toHaveProperty("centroidHz");
    expect(value.alignment.verifiedAbsoluteErrorBoundSamples).toBeNull();
  });

  it.each(["level", "spectral-centroid"] as const)(
    "publishes independently trustworthy %s-only partial data",
    (healthy) => {
      const value = fixture();
      for (const metric of metricNames) {
        if (metric !== healthy) failMetric(value, metric);
      }
      const result = metricAudioObservationSchema.parse(reproject(value));
      expect(result.outcome).toBe("partial");
      expect(result.metrics[healthy].status).toBe("complete");
      expect(
        result.rows.some((row) => row[healthy].availability === "available"),
      ).toBe(true);
      expect(
        result.metrics[healthy === "level" ? "spectral-centroid" : "level"]
          .gaps[0]!.detail,
      ).toBeTruthy();
    },
  );

  it("a solely requested healthy level metric is complete, not partial", () => {
    const value = fixture();
    unrequest(value, "spectral-centroid");
    unrequest(value, "attacks");
    const result = metricAudioObservationSchema.parse(reproject(value));
    expect(result.outcome).toBe("complete");
    expect(result.rows[0]!["spectral-centroid"]).toEqual({
      availability: "not-requested",
      recordIndices: [],
    });
  });

  it("does not allow unrequested metrics to smuggle records or algorithm declarations", () => {
    const value = fixture();
    const retained = value.metrics["spectral-centroid"].records;
    unrequest(value, "spectral-centroid");
    value.metrics["spectral-centroid"].records = retained;
    expectInvalid(reproject(value));
    value.metrics["spectral-centroid"].records = [];
    value.metrics["spectral-centroid"].algorithm = {
      name: "fft-energy-centroid",
      version: 1,
      fftSamples: 2_048,
      hopSamples: 2_048,
      firstFrameEndSample: value.geometry.startSample + 2_048,
      units: "Hz",
    };
    expectInvalid(value);
  });

  it("distinguishes real silence, including null zero-energy centroid, from gaps", () => {
    const value = fixture();
    for (const record of value.metrics.level.records) {
      record.peak = [0, 0];
      record.rms = [0, 0];
    }
    for (const record of value.metrics["spectral-centroid"].records) {
      record.centroidHz = null;
      record.spectralEnergy = 0;
    }
    expect(metricAudioObservationSchema.parse(value).outcome).toBe("complete");
    value.metrics["spectral-centroid"].records[0]!.spectralEnergy = 1;
    expectInvalid(value);
  });

  it("requires explicit gaps for a valid partial timeline, not silent record loss", () => {
    const value = fixture();
    unrequest(value, "attacks");
    const removed = value.metrics.level.records.pop()!;
    value.metrics.level.status = "partial";
    value.outcome = "partial";
    expectInvalid(reproject(value));
    value.metrics.level.gaps.push({
      firstIndex: removed.index,
      count: 1,
      ...removed.support,
      reason: "malformed-record",
      detail: "Last record could not be validated",
    });
    const result = metricAudioObservationSchema.parse(reproject(value));
    expect(result.rows.at(-1)!.level.availability).toBe("missing");
    // Missing cannot also be represented as a valid zero-valued measurement.
    value.metrics.level.records.push({ ...removed, peak: [0, 0], rms: [0, 0] });
    expectInvalid(reproject(value));
  });

  it("retains a trustworthy spectral prefix and represents partially available rows", () => {
    const value = fixture();
    const acquisition = value.metrics["spectral-centroid"];
    const removed = acquisition.records.splice(1);
    acquisition.status = "partial";
    acquisition.gaps = [
      {
        firstIndex: 1,
        count: removed.length,
        startSample: removed[0]!.support.startSample,
        endSample: removed.at(-1)!.support.endSample,
        reason: "sequence-gap",
        detail: "Spectrum sequence was interrupted",
      },
    ];
    value.outcome = "partial";
    const result = metricAudioObservationSchema.parse(reproject(value));
    expect(result.rows[0]!["spectral-centroid"].availability).toBe("partial");
    expect(result.rows.at(-1)!["spectral-centroid"].availability).toBe(
      "missing",
    );
  });

  it("does not mistake no frame in a short row for failed acquisition", () => {
    const value = fixture({ endBeat: 0.01 });
    expect(value.metrics["spectral-centroid"].records).toHaveLength(0);
    const result = metricAudioObservationSchema.parse(value);
    expect(result.rows[0]!["spectral-centroid"].availability).toBe("no-frame");
    unrequest(value, "level");
    unrequest(value, "attacks");
    expectInvalid(reproject(value));
  });

  it("retains FFT support crossing a report/capture boundary without claiming a bin average", () => {
    const value = fixture();
    const spectral = value.metrics["spectral-centroid"];
    if (!spectral.algorithm || spectral.algorithm.firstFrameEndSample === null)
      throw new Error("Expected known FFT fixture phase");
    spectral.algorithm.firstFrameEndSample -= 1_000;
    for (const record of spectral.records) {
      record.support.startSample -= 1_000;
      record.support.endSample -= 1_000;
    }
    // This phase adds one final expected frame.
    const end = spectral.records.at(-1)!.support.endSample + 2_048;
    if (end <= value.geometry.endSample) {
      spectral.records.push({
        index: spectral.records.length,
        support: { startSample: end - 2_048, endSample: end },
        centroidHz: 500,
        spectralEnergy: 2,
      });
      spectral.expectedRecords++;
    }
    const result = metricAudioObservationSchema.parse(reproject(value));
    expect(
      result.metrics["spectral-centroid"].records[0]!.support.startSample,
    ).toBeLessThan(value.geometry.startSample);
    const assigned = result.rows.flatMap(
      (row) => row["spectral-centroid"].recordIndices,
    );
    expect(new Set(assigned).size).toBe(spectral.records.length);
    expect(assigned).toHaveLength(spectral.records.length);
    const crossing = spectral.records.find((record) =>
      value.geometry.rows.some(
        (row) =>
          record.support.startSample < row.startSample &&
          record.support.endSample > row.startSample,
      ),
    );
    expect(crossing).toBeDefined();
  });

  it("assigns boundary endpoints once, including a frame ending exactly at capture end", () => {
    const value = fixture({ tempoBpm: 187.5, endBeat: 0.5 });
    const result = metricAudioObservationSchema.parse(value);
    // 3840 samples per row, phase shifted so one frame ends on the row boundary.
    const spectral = value.metrics["spectral-centroid"];
    spectral.algorithm!.firstFrameEndSample =
      value.geometry.startSample + 1_792;
    spectral.records = [1_792, 3_840, 5_888].map((offset, index) => ({
      index,
      support: {
        startSample: value.geometry.startSample + offset - 2_048,
        endSample: value.geometry.startSample + offset,
      },
      spectralEnergy: 1,
      centroidHz: 100,
    }));
    spectral.expectedRecords = 3;
    const boundary = metricAudioObservationSchema.parse(reproject(value));
    expect(boundary.rows[0]!["spectral-centroid"].recordIndices).toEqual([0]);
    expect(boundary.rows[1]!["spectral-centroid"].recordIndices).toEqual([
      1, 2,
    ]);
    expect(result.outcome).toBe("complete");
    const endpoint = fixture({ tempoBpm: 175.78125, endBeat: 0.25 });
    const endResult = metricAudioObservationSchema.parse(endpoint);
    expect(
      endResult.metrics["spectral-centroid"].records.at(-1)!.support.endSample,
    ).toBe(endpoint.geometry.endSample);
    expect(endResult.rows.at(-1)!["spectral-centroid"].recordIndices).toContain(
      1,
    );
  });

  it("reuses fractional musical grids at actual sample rates without rounded-hop drift", () => {
    for (const sampleRate of [44_100, 48_000] as const) {
      const value = fixture({
        sampleRate,
        tempoBpm: 137,
        startBeat: 0.13,
        endBeat: 3.91,
      });
      const result = metricAudioObservationSchema.parse(value);
      expect(result.geometry.rows[0]!.startBeat).toBe(0.13);
      expect(result.geometry.rows[0]!.endBeat).toBe(0.25);
      expect(result.geometry.rows.at(-1)!.endBeat).toBe(3.91);
      for (const row of result.geometry.rows) {
        expect(row.endSample).toBe(
          value.geometry.startSample +
            Math.round(((row.endBeat - 0.13) * sampleRate * 60) / 137),
        );
      }
      const record = value.metrics.level.records[1]!;
      record.support.startSample++;
      expectInvalid(reproject(value));
    }
  });

  it.each([0, 2.059377861721612])(
    "validates and stores Session clip-local coordinates at global anchor %s",
    (anchor) => {
      const value = fixture({ startBeat: anchor, endBeat: anchor + 1 });
      value.source = {
        view: "session",
        target: {
          view: "session",
          track: {
            kind: "regular",
            index: 0,
            expectedReference: uuid,
            expectedName: "Track",
          },
          sceneIndex: 0,
          expectedClipReference: uuid,
          expectedClipName: "Clip",
        },
        clipReference: uuid,
        kind: "warped-audio",
        coordinate: { unit: "beats", iteration: 0, startBeat: 0, endBeat: 1 },
        transport: { startBeat: anchor, endBeat: anchor + 1 },
        clipStartTimeBeats: anchor,
        synchronization: "transport-coupled-first-iteration",
      };
      expect(metricAudioObservationSchema.parse(value).source.view).toBe(
        "session",
      );
      expect(storedObservationCoordinates(value)).toMatchObject({
        startBeat: 0,
        endBeat: 1,
        startSample: value.geometry.startSample,
        endSample: value.geometry.endSample,
      });
      value.source.clipStartTimeBeats = anchor + 0.1;
      expectInvalid(value);
      value.source.clipStartTimeBeats = anchor;
      value.source.coordinate.endBeat = 2;
      expectInvalid(value);
      value.source.coordinate.endBeat = 1;
      value.source.clipReference = "00000000-0000-4000-8000-000000000002";
      expectInvalid(value);
    },
  );

  it.each([
    (v: MetricAudioObservation) => {
      v.metrics.level.status = "partial";
    },
    (v: MetricAudioObservation) => {
      v.metrics.level.status = "failed";
    },
    (v: MetricAudioObservation) => {
      failMetric(v, "spectral-centroid");
      v.metrics["spectral-centroid"].status = "complete";
    },
    (v: MetricAudioObservation) => {
      failMetric(v, "spectral-centroid");
      v.metrics["spectral-centroid"].status = "partial";
    },
    (v: MetricAudioObservation) => {
      failMetric(v, "spectral-centroid");
      v.outcome = "complete";
    },
    (v: MetricAudioObservation) => {
      v.outcome = "partial";
    },
    (v: MetricAudioObservation) => {
      v.metrics.level.status = "not-requested";
    },
    (v: MetricAudioObservation) => {
      v.requestedMetrics.push("level");
    },
    (v: MetricAudioObservation) => {
      v.metrics.level.expectedRecords++;
    },
  ])(
    "rejects contradictory request, completeness and acquisition statuses %#",
    (change) => {
      const value = fixture();
      change(value);
      expectInvalid(reproject(value));
    },
  );

  it("rejects zero-useful-data publication, even with well-formed explicit gaps", () => {
    const value = fixture();
    metricNames.forEach((metric) => failMetric(value, metric));
    expectInvalid(reproject(value));
  });

  it.each(["failed", "cancelled"] as const)(
    "never publishes global %s as good evidence",
    (status) => {
      expectInvalid({ ...fixture(), outcome: status });
      expectInvalid({ ...fixture(), sharedIntegrity: status });
    },
  );

  it.each([
    (v: MetricAudioObservation) => {
      v.sourceCoverage.endSample--;
    },
    (v: MetricAudioObservation) => {
      v.alignment.sampleRate = 44_100;
    },
    (v: MetricAudioObservation) => {
      v.alignment.vectorSize = 128;
    },
    (v: MetricAudioObservation) => {
      v.ownership.nativeEpoch = 0;
    },
    (v: MetricAudioObservation) => {
      v.ownership.connectionId = "another-owner";
    },
    (v: MetricAudioObservation) => {
      v.metrics.level.records[0]!.index = 1;
    },
    (v: MetricAudioObservation) => {
      v.metrics.level.records.reverse();
    },
    (v: MetricAudioObservation) => {
      v.metrics.level.records[0]!.support.startSample--;
    },
    (v: MetricAudioObservation) => {
      v.metrics["spectral-centroid"].records.at(-1)!.support.endSample++;
    },
    (v: MetricAudioObservation) => {
      const algorithm = v.metrics["spectral-centroid"].algorithm;
      if (!algorithm || algorithm.firstFrameEndSample === null)
        throw new Error("Expected known FFT fixture phase");
      algorithm.firstFrameEndSample += 2_048;
    },
    (v: MetricAudioObservation) => {
      v.metrics.attacks.algorithm!.windowSamples++;
    },
  ])(
    "rejects ownership, cadence and source coordinate contradictions %#",
    (change) => {
      const value = fixture();
      change(value);
      expectInvalid(reproject(value));
    },
  );

  it("does not claim to verify a different structurally valid owner against an external pass", () => {
    const value = fixture();
    value.ownership.passId = "another-well-formed-pass";
    expect(metricAudioObservationSchema.parse(value).ownership.passId).toBe(
      "another-well-formed-pass",
    );
    // Runtime must compare this envelope to its frozen external expectation.
  });

  it("retains the controller's UUID generation, connection epoch and application trace", () => {
    const value = fixture();
    value.ownership.connectionEpoch = "00000000-0000-4000-8000-000000000002";
    value.ownership.generation = "00000000-0000-4000-8000-000000000003";
    value.ownership.traceId = "00000000-0000-4000-8000-000000000004";
    const result = metricAudioObservationSchema.parse(value);
    expect(result.ownership.generation).toBe(value.ownership.generation);
    expect(result.ownership.connectionEpoch).toBe(
      value.ownership.connectionEpoch,
    );
    expect(result.ownership.traceId).toBe(value.ownership.traceId);
    expect(result.ownership.connectionEpoch).not.toBe(
      result.ownership.connectionId,
    );
  });

  it.each([
    { generation: 1 },
    { generation: "generation" },
    { connectionEpoch: undefined },
    { connectionEpoch: "connection-epoch" },
    { traceId: "trace" },
  ])(
    "rejects ownership fields incompatible with real controller/app UUIDs %#",
    (change) => {
      const value = fixture();
      expectInvalid({ ...value, ownership: { ...value.ownership, ...change } });
    },
  );

  it("bounds validation work even when malformed shared geometry declares a huge endpoint", () => {
    const value = fixture();
    value.geometry = { ...value.geometry, endSample: 2 ** 44 - 1 };
    expectInvalid(value);
  });

  it.each([
    (v: MetricAudioObservation) => {
      v.metrics.level.records[0]!.rms[0] = 0.6;
    },
    (v: MetricAudioObservation) => {
      v.metrics.level.records[0]!.rms[0] = -1;
    },
    (v: MetricAudioObservation) => {
      v.metrics.level.records[0]!.peak[0] = Infinity;
    },
    (v: MetricAudioObservation) => {
      v.metrics["spectral-centroid"].records[0]!.centroidHz = NaN;
    },
    (v: MetricAudioObservation) => {
      v.metrics["spectral-centroid"].records[0]!.centroidHz = null;
    },
    (v: MetricAudioObservation) => {
      v.metrics["spectral-centroid"].records[0]!.spectralEnergy = 0;
    },
  ])(
    "rejects nonfinite, inconsistent amplitude or silence values %#",
    (change) => {
      const value = fixture();
      change(value);
      expectInvalid(value);
    },
  );

  it("rejects a centroid beyond actual 44100 Hz Nyquist", () => {
    const value = fixture({ sampleRate: 44_100 });
    value.metrics["spectral-centroid"].records[0]!.centroidHz = 22_051;
    expectInvalid(value);
  });

  it("accepts supported ordered attacks and rejects late callbacks/outside support", () => {
    const value = fixture();
    const window = attackFromSilence(value);
    expect(
      metricAudioObservationSchema.parse(reproject(value)).metrics.attacks
        .records[0]!.events,
    ).toHaveLength(1);
    window.events[0]!.sample = window.support.endSample + 1;
    expectInvalid(value);
    window.events[0]!.sample = window.support.startSample - 1;
    expectInvalid(value);
    window.events = [
      { sample: window.support.endSample, strength: 0.25 },
      { sample: window.support.endSample, strength: 0.25 },
    ];
    expectInvalid(value);
  });

  it("retains a detector timestamp at capture end, including a clipped final 100ms window", () => {
    const value = fixture({ endBeat: 0.93 });
    const window = attackFromSilence(
      value,
      value.metrics.attacks.records.length - 1,
    );
    expect(window.support.endSample - window.support.startSample).toBeLessThan(
      value.metrics.attacks.algorithm!.windowSamples,
    );
    const result = metricAudioObservationSchema.parse(reproject(value));
    expect(result.metrics.attacks.records.at(-1)!.events[0]!.sample).toBe(
      value.geometry.endSample,
    );
  });

  it.each(["start", "inside"] as const)(
    "does not relabel an arbitrary %s sample as the existing window-end detector timestamp",
    (position) => {
      const value = fixture();
      const window = value.metrics.attacks.records[0]!;
      window.events.push({
        sample: window.support.startSample + (position === "inside" ? 1 : 0),
        strength: 12,
      });
      expectInvalid(value);
    },
  );

  it("retains exact detector endpoints that also land on a musical row boundary", () => {
    const value = fixture({ tempoBpm: 150 });
    const window = attackFromSilence(value);
    expect(window.support.endSample).toBe(value.geometry.rows[0]!.endSample);
    const result = metricAudioObservationSchema.parse(reproject(value));
    expect(result.metrics.attacks.records[0]!.events[0]!.sample).toBe(
      value.geometry.rows[1]!.startSample,
    );
    // Report references identify source support, not inferred transient onset.
    expect(result.rows[0]!.attacks.recordIndices).toContain(0);
    expect(result.rows[0]!.attacks.eventRecordIndices).toEqual([]);
    expect(result.rows[1]!.attacks.recordIndices).not.toContain(0);
    expect(result.rows[1]!.attacks.eventRecordIndices).toEqual([0]);
  });

  it("retrieves boundary and capture-end detections exactly once without extending detector coverage", () => {
    const value = fixture({ tempoBpm: 150 });
    attackFromSilence(value);
    attackFromSilence(value, value.metrics.attacks.records.length - 1);
    const result = metricAudioObservationSchema.parse(reproject(value));
    const detections = result.rows.flatMap((row) =>
      row.attacks.eventRecordIndices.flatMap(
        (index) =>
          result.metrics.attacks.records.find(
            (record) => record.index === index,
          )!.events,
      ),
    );
    expect(detections.map((event) => event.sample)).toEqual(
      value.metrics.attacks.records.flatMap((record) =>
        record.events.map((event) => event.sample),
      ),
    );
    expect(new Set(detections.map((event) => event.sample)).size).toBe(
      detections.length,
    );
    expect(result.rows.map((row) => row.attacks.recordIndices)).toEqual([
      [0],
      [1],
      [2],
      [3],
    ]);
    expect(result.rows.map((row) => row.attacks.eventRecordIndices)).toEqual([
      [],
      [0],
      [],
      [3],
    ]);
    expect(detections.at(-1)!.sample).toBe(value.geometry.endSample);
  });

  it("retains a preceding endpoint event even when the destination row has no detector coverage", () => {
    const value = fixture({ tempoBpm: 150 });
    attackFromSilence(value);
    const missingLevel = value.metrics.level.records.splice(1, 1)[0]!;
    value.metrics.level.status = "partial";
    value.metrics.level.gaps = [
      {
        firstIndex: 1,
        count: 1,
        ...missingLevel.support,
        reason: "sequence-gap",
        detail: "No validated level support for the second detector",
      },
    ];
    const missingDetectors = value.metrics.attacks.records.splice(1);
    value.metrics.attacks.status = "partial";
    value.metrics.attacks.gaps = [
      {
        firstIndex: 1,
        count: missingDetectors.length,
        startSample: missingDetectors[0]!.support.startSample,
        endSample: missingDetectors.at(-1)!.support.endSample,
        reason: "dependency-unavailable",
        detail: "Second detector support cannot be established",
      },
    ];
    value.outcome = "partial";
    const result = metricAudioObservationSchema.parse(reproject(value));
    expect(result.rows[1]!.attacks).toEqual({
      availability: "missing",
      recordIndices: [],
      eventRecordIndices: [0],
    });
  });

  it("rejects omitted, duplicate or wrong-row detector event references", () => {
    const value = fixture({ tempoBpm: 150 });
    attackFromSilence(value);
    reproject(value);
    value.rows[1]!.attacks.eventRecordIndices = [];
    expectInvalid(value);
    reproject(value);
    value.rows[1]!.attacks.eventRecordIndices.push(0);
    expectInvalid(value);
    reproject(value);
    value.rows[0]!.attacks.eventRecordIndices.push(0);
    expectInvalid(value);
  });

  it.each([65, 90, 120])(
    "retains native %s dB attack rises without an amplitude cap",
    (strength) => {
      const value = fixture();
      const window = attackFromSilence(value, 0, 10 ** ((strength - 120) / 20));
      const result = metricAudioObservationSchema.parse(reproject(value));
      expect(
        result.metrics.attacks.records[0]!.events[0]!.strength,
      ).toBeCloseTo(strength);
      expect(result.metrics.attacks.records[0]!.events[0]!.strength).toBe(
        window.events[0]!.strength,
      );
      expect(result.metrics.attacks.algorithm!.units).toBe("dB-rise");
      expect(result.metrics.attacks.algorithm!.windowSamples).toBe(
        value.geometry.sampleRate / 10,
      );
      expect(result.metrics.attacks.algorithm!.minSpacingSamples).toBe(
        value.geometry.sampleRate / 10,
      );
    },
  );

  it.each([-1, MAX_METRIC_ATTACK_STRENGTH_DB + 1e-9, Infinity, NaN])(
    "rejects an invalid %s dB attack rise",
    (strength) => {
      const value = fixture();
      const window = value.metrics.attacks.records[0]!;
      window.events.push({ sample: window.support.endSample, strength });
      expectInvalid(value);
    },
  );

  it.each([2, MAX_METRIC_OBSERVATION_AMPLITUDE])(
    "retains an initial above-unity RMS %s rise from the detector's -120 dBFS history",
    (rms) => {
      const value = fixture();
      attackFromSilence(value, 0, rms);
      const strength = 20 * Math.log10(rms) - -120;
      expect(strength).toBeGreaterThan(120);
      const result = metricAudioObservationSchema.parse(reproject(value));
      expect(result.metrics.attacks.records[0]!.events[0]!.strength).toBe(
        strength,
      );
      if (rms === MAX_METRIC_OBSERVATION_AMPLITUDE) {
        expect(strength).toBe(MAX_METRIC_ATTACK_STRENGTH_DB);
      }
    },
  );

  it("keeps the attack threshold bound independent of the larger measured rise bound", () => {
    const value = fixture();
    value.metrics.attacks.algorithm!.thresholdDb = 120;
    expect(
      metricAudioObservationSchema.parse(value).metrics.attacks.algorithm!
        .thresholdDb,
    ).toBe(120);
    value.metrics.attacks.algorithm!.thresholdDb = 120.01;
    expectInvalid(value);
  });

  it("rejects attack units that relabel the existing dB-rise detector as linear", () => {
    const value = fixture();
    expectInvalid({
      ...value,
      metrics: {
        ...value.metrics,
        attacks: {
          ...value.metrics.attacks,
          algorithm: {
            ...value.metrics.attacks.algorithm,
            units: "linear-amplitude-rise",
          },
        },
      },
    });
  });

  it("does not invalidate independently verified empty detector results when musical delivery fails", () => {
    const value = fixture();
    failMetric(value, "level");
    const result = metricAudioObservationSchema.parse(reproject(value));
    expect(result.outcome).toBe("partial");
    expect(result.metrics.attacks.status).toBe("complete");
    expect(
      result.metrics.attacks.records.every(
        (record) => record.events.length === 0,
      ),
    ).toBe(true);
  });

  it("rejects gaps with false bounds, overlaps, omitted records or excessive explanations", () => {
    const value = fixture();
    failMetric(value, "spectral-centroid");
    reproject(value);
    const gap = value.metrics["spectral-centroid"].gaps[0]!;
    gap.endSample--;
    expectInvalid(value);
    gap.endSample++;
    gap.detail = "x".repeat(161);
    expectInvalid(value);
    gap.detail = "Bounded explanation";
    value.metrics["spectral-centroid"].gaps.push({ ...gap });
    expectInvalid(value);
  });

  it("allows explicit reduced display detail without reducing acquisition or timelines", () => {
    const value = fixture();
    value.rows = value.rows.filter((row) => row.index % 2 === 0);
    expectInvalid(value);
    value.reduction.mode = "selected-report-rows";
    value.reduction.retainedReportRows = value.rows.length;
    expect(metricAudioObservationSchema.parse(value).outcome).toBe("complete");
    value.rows[0]!.level.recordIndices = [];
    expectInvalid(value);
  });

  it("rejects fabricated availability, computed values, raw audio and per-record owner overrides", () => {
    const value = fixture();
    expectInvalid({ ...value, rawAudio: new Uint8Array([0]) });
    expectInvalid({ ...value, pcm: "base64" });
    expectInvalid({
      ...value,
      metrics: {
        ...value.metrics,
        level: {
          ...value.metrics.level,
          records: value.metrics.level.records.map((record) => ({
            ...record,
            passId: "foreign",
          })),
        },
      },
    });
    expectInvalid({
      ...value,
      rows: value.rows.map((row) => ({ ...row, centroidHz: 123 })),
    });
    failMetric(value, "spectral-centroid");
    reproject(value);
    value.rows[0]!["spectral-centroid"].availability = "available";
    expectInvalid(value);
  });

  it("enforces the full UTF-8 byte quota without silently reducing detail", () => {
    const value = fixture({ tempoBpm: 999, endBeat: 499.5 });
    expect(metricAudioObservationSchema.safeParse(value).success).toBe(true);
    value.limitations = Array<string>(16).fill("界".repeat(240));
    for (const metric of metricNames) {
      value.metrics[metric].limitations = Array<string>(8).fill(
        "界".repeat(240),
      );
      const acquisition = value.metrics[metric];
      const retained = metric === "level" ? 1 : 0;
      acquisition.gaps = acquisition.records.slice(retained).map((record) => ({
        firstIndex: record.index,
        count: 1,
        ...record.support,
        reason: "unavailable",
        detail: "界".repeat(160),
      }));
      acquisition.records.splice(retained);
      acquisition.status = retained ? "partial" : "failed";
    }
    value.outcome = "partial";
    reproject(value);
    expect(JSON.stringify(value).length).toBeLessThan(
      MAX_METRIC_OBSERVATION_BYTES,
    );
    expect(
      new TextEncoder().encode(JSON.stringify(value)).byteLength,
    ).toBeGreaterThan(MAX_METRIC_OBSERVATION_BYTES);
    const result = metricAudioObservationSchema.safeParse(value);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((issue) =>
          issue.message.includes("payload quota"),
        ),
      ).toBe(true);
    }
    // Explicit display reduction can fit; source acquisition stays unchanged.
    value.rows = [];
    value.reduction.mode = "selected-report-rows";
    value.reduction.retainedReportRows = 0;
    expect(metricAudioObservationSchema.parse(value).outcome).toBe("partial");
  });

  it("does not auto-accept or reinterpret this version through legacy readers", () => {
    const value = fixture();
    expect(audioObservationSchema.safeParse(value).success).toBe(false);
    expect(audioObservationV2Schema.safeParse(value).success).toBe(false);
    expect(legacyStoredAudioObservationSchema.safeParse(value).success).toBe(
      false,
    );
    expect(storedAudioObservationSchema.parse(value)).toEqual(value);
    expectInvalid({ ...value, schema: "audio-observation/v2" });
    expectInvalid({ ...value, schema: "metric-audio-observation/v2" });
  });
});
