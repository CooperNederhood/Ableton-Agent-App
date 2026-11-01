import { describe, expect, it } from "vitest";
import {
  createMetricObservationReportRows,
  metricAudioObservationSchema,
} from "./metric-observation-schemas.js";
import { createSyntheticMetricListeningObservation } from "./metric-testing.js";
import {
  MAX_METRIC_REPORT_PAGE_BYTES,
  metricListeningReportSchema,
  projectMetricListeningReport,
} from "./metric-listening-report.js";

function boundaryAttackObservation() {
  const observation = createSyntheticMetricListeningObservation({
    endBeat: 2,
  });
  for (const record of observation.metrics.attacks.records) {
    record.inputLevel = { peak: [0, 0], rms: [0, 0] };
    record.events = [];
  }
  for (const [index, amplitude] of [
    [4, 0.25],
    [9, 0.5],
  ] as const) {
    const record = observation.metrics.attacks.records[index]!;
    record.inputLevel = {
      peak: [amplitude, amplitude],
      rms: [amplitude, amplitude],
    };
    record.events = [
      {
        sample: record.support.endSample,
        strength: 120 + 20 * Math.log10(amplitude),
      },
    ];
  }
  observation.rows = createMetricObservationReportRows(observation);
  return observation;
}

describe("bounded stacked musical metric report", () => {
  it("preserves source, units, timing limits and acquisition coverage on every page", () => {
    const observation = createSyntheticMetricListeningObservation();
    observation.metrics["spectral-centroid"].limitations = [
      "Native FFT support can cross reporting boundaries",
    ];
    const report = projectMetricListeningReport(observation, {
      offset: 1,
      limit: 1,
    });
    expect(report).toMatchObject({
      source: observation.source,
      sourceCoverage: observation.sourceCoverage,
      alignment: observation.alignment,
      limitations: observation.limitations,
      requestedMetrics: observation.requestedMetrics,
      metricMetadata: {
        level: {
          algorithm: observation.metrics.level.algorithm,
          expectedRecords: 4,
          retainedRecords: 4,
          missingRecords: 0,
          limitations: [],
        },
        "spectral-centroid": {
          algorithm: observation.metrics["spectral-centroid"].algorithm,
          expectedRecords: 11,
          retainedRecords: 11,
          missingRecords: 0,
          limitations: ["Native FFT support can cross reporting boundaries"],
        },
        attacks: {
          algorithm: observation.metrics.attacks.algorithm,
          expectedRecords: 5,
          retainedRecords: 5,
          missingRecords: 0,
          limitations: [],
        },
      },
    });
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]!.index).toBe(1);
  });

  it("joins authoritative expected-slot references without changing native support", () => {
    const observation = createSyntheticMetricListeningObservation();
    const report = projectMetricListeningReport(observation, { limit: 1 });
    expect(report).toMatchObject({
      schema: "metric-listening-report/v1",
      observationOutcome: "complete",
      totalRows: 4,
      offset: 0,
      nextOffset: 1,
    });
    expect(report.rows[0]).toMatchObject({
      index: 0,
      startBeat: 0,
      endBeat: 0.25,
      startSample: 10_000,
      endSample: 16_000,
      level: {
        availability: "available",
        records: [{ index: 0, peak: [0.5, 0.5], rms: [0.25, 0.25] }],
        gaps: [],
      },
      "spectral-centroid": {
        availability: "available",
        frameCount: 2,
        centroidHz: 500,
        spectralEnergy: 4,
        aggregation: "spectral-energy-weighted-endpoint-frames",
        supports: [
          { startSample: 10_000, endSample: 12_048 },
          { startSample: 12_048, endSample: 14_096 },
        ],
      },
      attacks: {
        availability: "available",
        events: observation.metrics.attacks.records[0]!.events,
      },
    });
  });

  it("uses spectral-energy weights rather than frame or time averages", () => {
    const observation = createSyntheticMetricListeningObservation();
    const [first, second] = observation.metrics["spectral-centroid"].records;
    first!.centroidHz = 100;
    first!.spectralEnergy = 1;
    second!.centroidHz = 900;
    second!.spectralEnergy = 3;
    expect(
      projectMetricListeningReport(observation).rows[0]!["spectral-centroid"],
    ).toMatchObject({ centroidHz: 700, spectralEnergy: 4 });
  });

  it("distinguishes measured silence and empty attack lists from missing data", () => {
    const observation = createSyntheticMetricListeningObservation();
    for (const record of observation.metrics.level.records) {
      record.peak = [0, 0];
      record.rms = [0, 0];
    }
    for (const record of observation.metrics.attacks.records) {
      record.inputLevel = { peak: [0, 0], rms: [0, 0] };
      record.events = [];
    }
    for (const frame of observation.metrics["spectral-centroid"].records) {
      frame.spectralEnergy = 0;
      frame.centroidHz = null;
    }
    observation.rows = createMetricObservationReportRows(observation);
    const row = projectMetricListeningReport(observation).rows[0]!;
    expect(row.level).toMatchObject({
      availability: "available",
      records: [{ peak: [0, 0], rms: [0, 0] }],
    });
    expect(row["spectral-centroid"]).toMatchObject({
      availability: "available",
      frameCount: 2,
      centroidHz: null,
      spectralEnergy: 0,
    });
    expect(row.attacks).toMatchObject({
      availability: "available",
      events: [],
    });
  });

  it("preserves explicit missing slots instead of shifting subsequent records", () => {
    const observation = createSyntheticMetricListeningObservation();
    const removed = observation.metrics.level.records.shift()!;
    observation.outcome = "partial";
    observation.metrics.level.status = "partial";
    observation.metrics.level.gaps = [
      {
        firstIndex: 0,
        count: 1,
        ...removed.support,
        reason: "drain-timeout",
        detail: "No retained record before the admitted deadline",
      },
    ];
    observation.rows = createMetricObservationReportRows(observation);
    const report = projectMetricListeningReport(observation);
    expect(report.observationOutcome).toBe("partial");
    expect(report.rows[0]!.level).toMatchObject({
      availability: "missing",
      records: [],
      gaps: [
        {
          firstIndex: 0,
          count: 1,
          support: removed.support,
          reason: "drain-timeout",
        },
      ],
    });
    expect(report.rows[1]!.level.records[0]!.index).toBe(1);
    expect(report.rows[1]!.level.gaps).toEqual([]);
    expect(report.rows[0]!["spectral-centroid"].frameCount).toBe(2);
    expect(report.rows[0]!.attacks.availability).toBe("available");
    expect(report.rows[0]!.attacks.events).toEqual(
      observation.metrics.attacks.records[0]!.events,
    );
  });

  it("does not turn a legitimate no-frame interval into spectral silence", () => {
    const observation = createSyntheticMetricListeningObservation({
      endBeat: 0.01,
    });
    const spectrum =
      projectMetricListeningReport(observation).rows[0]!["spectral-centroid"];
    expect(spectrum.frameCount).toBe(0);
    expect(spectrum.centroidHz).toBeNull();
    expect(spectrum.spectralEnergy).toBeNull();
    expect(spectrum.supports).toEqual([]);
    expect(spectrum.gaps).toEqual([]);
    expect(spectrum.availability).not.toBe("missing");
  });

  it("keeps an unrequested analyzer distinct from a missing requested analyzer", () => {
    const observation = createSyntheticMetricListeningObservation();
    observation.requestedMetrics = ["level", "attacks"];
    observation.metrics["spectral-centroid"] = {
      status: "not-requested",
      algorithm: null,
      expectedRecords: 0,
      records: [],
      gaps: [],
      limitations: [],
    };
    observation.rows = createMetricObservationReportRows(observation);
    const report = projectMetricListeningReport(observation);
    expect(report.metricStatus["spectral-centroid"]).toBe("not-requested");
    expect(report.rows[0]!["spectral-centroid"]).toMatchObject({
      availability: "not-requested",
      frameCount: 0,
      spectralEnergy: null,
      centroidHz: null,
      gaps: [],
    });
  });

  it("assigns spectral gaps by endpoint rather than overlapping native support", () => {
    const observation = createSyntheticMetricListeningObservation();
    const spectrum = observation.metrics["spectral-centroid"];
    if (!spectrum.algorithm || spectrum.algorithm.firstFrameEndSample === null)
      throw new Error("Expected known FFT fixture phase");
    spectrum.algorithm.firstFrameEndSample -= 144;
    for (const record of spectrum.records) {
      record.support.startSample -= 144;
      record.support.endSample -= 144;
    }
    const [missing] = spectrum.records.splice(2, 1);
    expect(missing!.support.endSample).toBe(16_000);
    spectrum.status = "partial";
    spectrum.gaps = [
      {
        firstIndex: 2,
        count: 1,
        ...missing!.support,
        reason: "sequence-gap",
        detail: "No retained frame at this expected endpoint",
      },
    ];
    observation.outcome = "partial";
    observation.rows = createMetricObservationReportRows(observation);
    const report = projectMetricListeningReport(observation);
    expect(report.rows[0]!["spectral-centroid"].gaps).toEqual([]);
    expect(report.rows[1]!["spectral-centroid"].gaps).toMatchObject([
      { firstIndex: 2, count: 1, support: missing!.support },
    ]);
    expect(report.rows[0]!["spectral-centroid"].frameCount).toBe(2);
    expect(report.rows[1]!["spectral-centroid"].availability).toBe("partial");
  });

  it("retains a capture-end FFT exactly once without splitting crossing support", () => {
    const observation = createSyntheticMetricListeningObservation();
    const spectrum = observation.metrics["spectral-centroid"];
    const first = observation.geometry.startSample + 1_472;
    spectrum.algorithm!.firstFrameEndSample = first;
    spectrum.records = [];
    for (let end = first; end <= observation.geometry.endSample; end += 2_048) {
      spectrum.records.push({
        index: spectrum.records.length,
        support: { startSample: end - 2_048, endSample: end },
        centroidHz: 500,
        spectralEnergy: 2,
      });
    }
    spectrum.expectedRecords = spectrum.records.length;
    observation.rows = createMetricObservationReportRows(observation);
    const report = projectMetricListeningReport(observation);
    expect(
      report.rows[0]!["spectral-centroid"].supports[0]!.startSample,
    ).toBeLessThan(observation.geometry.startSample);
    expect(
      report.rows.at(-1)!["spectral-centroid"].supports.at(-1)!.endSample,
    ).toBe(observation.geometry.endSample);
    expect(
      report.rows.reduce(
        (sum, row) => sum + row["spectral-centroid"].frameCount,
        0,
      ),
    ).toBe(spectrum.records.length);
  });

  it("assigns each detector-end event once, including a musical boundary and capture end", () => {
    const observation = boundaryAttackObservation();
    const boundaryEvents = observation.metrics.attacks.records[4]!.events;
    const finalEvents = observation.metrics.attacks.records.at(-1)!.events;
    const report = projectMetricListeningReport(observation);
    expect(report.rows[0]!.attacks.events).toEqual([]);
    expect(report.rows[3]!.attacks.events).toEqual([]);
    expect(report.rows[4]!.attacks.events).toEqual(boundaryEvents);
    expect(report.rows.at(-1)!.attacks.events).toEqual(finalEvents);
    expect(report.rows.flatMap((row) => row.attacks.events)).toHaveLength(2);
    expect(
      projectMetricListeningReport(observation, { offset: 3, limit: 1 })
        .rows[0]!.attacks.events,
    ).toEqual([]);
    expect(
      projectMetricListeningReport(observation, { offset: 4, limit: 1 })
        .rows[0]!.attacks.events,
    ).toEqual(boundaryEvents);
    expect(
      projectMetricListeningReport(observation, { offset: 7, limit: 1 })
        .rows[0]!.attacks.events,
    ).toEqual(finalEvents);
  });

  it("retains a boundary event without inventing destination-row detector coverage", () => {
    const observation = boundaryAttackObservation();
    const attacks = observation.metrics.attacks;
    const missing = attacks.records.splice(5);
    attacks.status = "partial";
    attacks.gaps = [
      {
        firstIndex: 5,
        count: 5,
        startSample: missing[0]!.support.startSample,
        endSample: missing.at(-1)!.support.endSample,
        reason: "drain-timeout",
        detail: "Synthetic detector delivery gap",
      },
    ];
    observation.outcome = "partial";
    observation.rows = createMetricObservationReportRows(observation);
    const row = projectMetricListeningReport(observation, {
      offset: 4,
      limit: 1,
    }).rows[0]!;
    expect(row.attacks).toMatchObject({
      availability: "missing",
      supports: [],
      events: attacks.records[4]!.events,
      gaps: [{ firstIndex: 5, count: 5, reason: "drain-timeout" }],
    });
  });

  it("bounds and pages deterministically without dropping reporting rows", () => {
    const observation = createSyntheticMetricListeningObservation({
      endBeat: 16,
    });
    expect(observation.geometry.rows).toHaveLength(64);
    const indices: number[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const report = projectMetricListeningReport(observation, {
        offset,
        limit: 32,
      });
      expect(report.rows.length).toBeLessThanOrEqual(32);
      indices.push(...report.rows.map((row) => row.index));
      offset = report.nextOffset;
    }
    expect(indices).toEqual(Array.from({ length: 64 }, (_, index) => index));
    expect(
      projectMetricListeningReport(observation, { offset: 64 }).rows,
    ).toEqual([]);
  });

  it("pages selected reporting rows by retained position without renumbering native rows", () => {
    const observation = createSyntheticMetricListeningObservation();
    observation.rows = [observation.rows[0]!, observation.rows[2]!];
    observation.reduction = {
      mode: "selected-report-rows",
      originalReportRows: 4,
      retainedReportRows: 2,
      authoritativeTimelines: "retained",
    };
    expect(metricAudioObservationSchema.safeParse(observation).success).toBe(
      true,
    );
    const completePage = projectMetricListeningReport(observation);
    expect(completePage.rows.map((row) => row.index)).toEqual([0, 2]);
    expect(completePage.reduction).toEqual(observation.reduction);
    const first = projectMetricListeningReport(observation, { limit: 1 });
    expect(first).toMatchObject({ totalRows: 2, offset: 0, nextOffset: 1 });
    const second = projectMetricListeningReport(observation, {
      offset: first.nextOffset!,
      limit: 1,
    });
    expect(second).toMatchObject({
      totalRows: 2,
      offset: 1,
      nextOffset: null,
      reduction: observation.reduction,
    });
    expect(second.rows.map((row) => row.index)).toEqual([2]);
    expect(
      projectMetricListeningReport(observation, { offset: 2 }).rows,
    ).toEqual([]);
    expect(
      metricListeningReportSchema.safeParse({
        ...completePage,
        rows: [...completePage.rows].reverse(),
      }).success,
    ).toBe(false);
    expect(
      metricListeningReportSchema.safeParse({
        ...completePage,
        reduction: { ...observation.reduction, retainedReportRows: 3 },
      }).success,
    ).toBe(false);
  });

  it("preserves capture-end events when only the last original reporting row is retained", () => {
    const observation = boundaryAttackObservation();
    observation.rows = observation.rows.slice(-1);
    observation.reduction = {
      mode: "selected-report-rows",
      originalReportRows: observation.geometry.rows.length,
      retainedReportRows: 1,
      authoritativeTimelines: "retained",
    };
    expect(metricAudioObservationSchema.safeParse(observation).success).toBe(
      true,
    );
    const report = projectMetricListeningReport(observation);
    expect(report.rows[0]!.index).toBe(7);
    expect(report.rows[0]!.attacks.events).toEqual(
      observation.metrics.attacks.records.at(-1)!.events,
    );
    expect(report.rows[0]!.attacks.events[0]!.sample).toBe(
      observation.geometry.endSample,
    );
  });

  it("reports explicit display-only reduction to zero rows without losing metric metadata", () => {
    const observation = createSyntheticMetricListeningObservation();
    observation.rows = [];
    observation.reduction = {
      mode: "selected-report-rows",
      originalReportRows: 4,
      retainedReportRows: 0,
      authoritativeTimelines: "retained",
    };
    expect(metricAudioObservationSchema.safeParse(observation).success).toBe(
      true,
    );
    expect(projectMetricListeningReport(observation)).toMatchObject({
      observationOutcome: "complete",
      totalRows: 0,
      offset: 0,
      nextOffset: null,
      rows: [],
      reduction: observation.reduction,
      metricMetadata: { level: { retainedRecords: 4 } },
    });
  });

  it("reduces dense pages to the UTF-8 byte budget without losing row continuation", () => {
    const observation = createSyntheticMetricListeningObservation({
      tempoBpm: 20,
      endBeat: 10,
      startSample: 2 ** 43,
    });
    observation.limitations = Array.from({ length: 16 }, () =>
      "界".repeat(200),
    );
    metricAudioObservationSchema.parse(observation);
    const first = projectMetricListeningReport(observation, { limit: 32 });
    expect(
      new TextEncoder().encode(JSON.stringify(first)).byteLength,
    ).toBeLessThanOrEqual(MAX_METRIC_REPORT_PAGE_BYTES);
    expect(first.pageBudget).toEqual({
      byteLimit: MAX_METRIC_REPORT_PAGE_BYTES,
      requestedRowLimit: 32,
      byteLimited: true,
    });
    expect(first.rows.length).toBeLessThan(32);
    expect(first.rows.length).toBeGreaterThan(0);
    const indices: number[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page = projectMetricListeningReport(observation, {
        offset,
        limit: 32,
      });
      expect(
        new TextEncoder().encode(JSON.stringify(page)).byteLength,
      ).toBeLessThanOrEqual(MAX_METRIC_REPORT_PAGE_BYTES);
      expect(metricListeningReportSchema.parse(page)).toEqual(page);
      indices.push(...page.rows.map((row) => row.index));
      offset = page.nextOffset;
    }
    expect(indices).toEqual(Array.from({ length: 40 }, (_, index) => index));
    expect(projectMetricListeningReport(observation, { limit: 32 })).toEqual(
      first,
    );
  });

  it("keeps measured attack strengths above 120 dB without clipping them", () => {
    const observation = createSyntheticMetricListeningObservation();
    for (const record of observation.metrics.attacks.records)
      record.inputLevel = { peak: [2, 2], rms: [2, 2] };
    observation.metrics.attacks.records[0]!.events[0]!.strength =
      120 + 20 * Math.log10(2);
    observation.rows = createMetricObservationReportRows(observation);
    const report = projectMetricListeningReport(observation);
    expect(report.rows[0]!.attacks.events[0]!.strength).toBeGreaterThan(120);
    expect(metricListeningReportSchema.parse(report)).toEqual(report);
  });

  it("rejects unsupported metadata instead of silently deleting limitations", () => {
    const observation = createSyntheticMetricListeningObservation();
    observation.limitations = ["界".repeat(241)];
    expect(() => projectMetricListeningReport(observation)).toThrow();
    const report = projectMetricListeningReport(
      createSyntheticMetricListeningObservation(),
    );
    report.limitations = observation.limitations;
    expect(metricListeningReportSchema.safeParse(report).success).toBe(false);
  });

  it("retains the maximum valid multibyte limitations without producing an empty continuation", () => {
    const observation = createSyntheticMetricListeningObservation();
    observation.limitations = Array.from({ length: 16 }, () =>
      "界".repeat(240),
    );
    for (const metric of Object.values(observation.metrics))
      metric.limitations = Array.from({ length: 8 }, () => "界".repeat(240));
    metricAudioObservationSchema.parse(observation);
    const report = projectMetricListeningReport(observation, { limit: 1 });
    expect(report.rows).toHaveLength(1);
    expect(report.nextOffset).toBe(1);
    expect(report.limitations).toEqual(observation.limitations);
    expect(report.metricMetadata.attacks.limitations).toEqual(
      observation.metrics.attacks.limitations,
    );
    expect(
      new TextEncoder().encode(JSON.stringify(report)).byteLength,
    ).toBeLessThanOrEqual(MAX_METRIC_REPORT_PAGE_BYTES);
    expect(
      projectMetricListeningReport(observation, {
        offset: observation.rows.length,
        limit: 1,
      }).rows,
    ).toEqual([]);
  });

  it("rejects forged page indices, counts, silence and event ownership", () => {
    const report = projectMetricListeningReport(
      createSyntheticMetricListeningObservation(),
    );
    const wrongIndex = structuredClone(report);
    wrongIndex.rows[0]!.index++;
    const wrongCounts = structuredClone(report);
    wrongCounts.metricMetadata.level.missingRecords++;
    const falseSilence = structuredClone(report);
    falseSilence.rows[0]!["spectral-centroid"].frameCount = 0;
    const misplacedEvent = structuredClone(report);
    misplacedEvent.rows[0]!.attacks.events[0]!.sample =
      misplacedEvent.rows[0]!.endSample;
    for (const forged of [
      wrongIndex,
      wrongCounts,
      falseSilence,
      misplacedEvent,
      { ...report, nextOffset: 1 },
    ])
      expect(metricListeningReportSchema.safeParse(forged).success).toBe(false);
  });

  it.each([
    { offset: -1 },
    { offset: 0.5 },
    { offset: 5 },
    { limit: 0 },
    { limit: 33 },
    { limit: 1.5 },
    { offset: Number.NaN },
    { limit: Number.POSITIVE_INFINITY },
  ])("rejects invalid page admission %j", (page) => {
    expect(() =>
      projectMetricListeningReport(
        createSyntheticMetricListeningObservation(),
        page,
      ),
    ).toThrow(RangeError);
  });

  it("does not expose mutable references to the saved observation", () => {
    const observation = createSyntheticMetricListeningObservation();
    const original = JSON.stringify(observation);
    const report = projectMetricListeningReport(observation);
    report.rows[0]!.level.records[0]!.peak[0] = 0;
    report.rows[0]!["spectral-centroid"].supports[0]!.startSample = 0;
    report.rows[0]!.attacks.supports.length = 0;
    expect(JSON.stringify(observation)).toBe(original);
  });

  it("rejects forged row references rather than silently skipping missing records", () => {
    const observation = createSyntheticMetricListeningObservation();
    observation.rows[0]!.level.recordIndices = [3];
    expect(metricAudioObservationSchema.safeParse(observation).success).toBe(
      false,
    );
    expect(() => projectMetricListeningReport(observation)).toThrow();
  });
});
