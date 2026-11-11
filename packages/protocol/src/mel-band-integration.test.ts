import { describe, expect, it } from "vitest";
import { storedAudioObservationSchema } from "./audio-observation-schemas.js";
import { admitMetricListeningBudget } from "./metric-listening-budget.js";
import { admitMelBandBudget } from "./mel-band-budget.js";
import { createMetricListeningGeometry } from "./metric-listening-geometry.js";
import {
  metricListeningResultSummarySchema,
  summarizeMetricListeningResult,
} from "./metric-listening-job-schemas.js";
import {
  metricListeningReportSchema,
  projectMetricListeningReport,
} from "./metric-listening-report.js";
import {
  createMetricObservationReportRows,
  metricAudioObservationSchema,
  metricObservationMetricSchema,
  type MetricAudioObservation,
} from "./metric-observation-schemas.js";
import { createSyntheticMetricListeningObservation } from "./metric-testing.js";
import { MEL_BAND_PROFILE } from "./mel-band-profile.js";
import {
  melBandTimelineSchema,
  projectMelBandTimeline,
} from "./mel-band-timeline.js";
import { nativeMetricListeningConfigSchema } from "./native-metric-listening-schemas.js";

const bytes = (value: unknown) =>
  Buffer.byteLength(JSON.stringify(value), "utf8");
function fixture(
  options: Parameters<typeof createSyntheticMetricListeningObservation>[0] = {},
  missing: "none" | "one" | "all" = "none",
) {
  const observation = createSyntheticMetricListeningObservation(options);
  const expectedRecords = Math.floor(observation.geometry.totalSamples / 2_048);
  const support = (index: number) => ({
    startSample: observation.geometry.startSample + index * 2_048,
    endSample: observation.geometry.startSample + (index + 1) * 2_048,
  });
  const retained = (index: number) =>
    missing === "none" || (missing === "one" && index !== 0);
  const timeline = melBandTimelineSchema.parse({
    schema: "mel-band-timeline/v1",
    status:
      expectedRecords === 0 || missing === "none"
        ? "complete"
        : missing === "all" || expectedRecords === 1
          ? "failed"
          : "partial",
    sampleRate: observation.geometry.sampleRate,
    profile: MEL_BAND_PROFILE,
    sourceSupport: observation.sourceCoverage,
    expectedRecords,
    frames: Array.from({ length: expectedRecords }, (_, index) => ({
      index,
      support: support(index),
      magnitudes: [
        Array.from({ length: 24 }, (_, band) =>
          band < 2 ? 0.0000010000000000000002 : index + 1,
        ),
        Array.from({ length: 24 }, () => 0),
      ],
    })).filter((frame) => retained(frame.index)),
    gaps: Array.from({ length: expectedRecords }, (_, index) => ({
      firstIndex: index,
      count: 1,
      support: support(index),
      reason: "dependency-unavailable",
    })).filter((gap) => !retained(gap.firstIndex)),
  });
  observation.requestedMetrics.push("mel-bands");
  observation.metrics["mel-bands"] = timeline;
  observation.outcome = timeline.status === "complete" ? "complete" : "partial";
  observation.rows = createMetricObservationReportRows(observation);
  return metricAudioObservationSchema.parse(observation);
}

function budgetInput(observation: MetricAudioObservation) {
  const g = observation.geometry;
  return {
    config: nativeMetricListeningConfigSchema.parse({
      scope: "independent-metric-timelines/v1",
      algorithmVersion: "3.0.0",
      geometry: createMetricListeningGeometry({
        sampleRate: g.sampleRate,
        vectorSize: g.vectorSize,
        tempoBpm: g.tempoBpm,
        startBeat: g.startBeat,
        endBeat: g.endBeat,
        startSample: 0,
      }),
      timingPolicy: observation.alignment.policy,
      grid: {
        beats: 0.25,
        anchor: "global-beat-grid",
        rounding: "nearest-sample",
        coordinates: "capture-local",
      },
      requestedMetrics: observation.requestedMetrics,
      attacks:
        observation.metrics.attacks.algorithm === null
          ? null
          : {
              thresholdDb: observation.metrics.attacks.algorithm.thresholdDb,
              minSpacingSamples:
                observation.metrics.attacks.algorithm.minSpacingSamples,
            },
      mode: "arrangement",
      sourceEvidence: "transport-only",
    }),
    ownership: observation.ownership,
    source: observation.source,
    jobId: "job",
  };
}

describe("registered mel-band metric contract integration", () => {
  it("registers optional metrics without adding them to historical baseline observations or configs", () => {
    expect(metricObservationMetricSchema.options).toEqual([
      "level",
      "spectral-centroid",
      "attacks",
      "mel-bands",
      "pitch",
      "spectral-shape",
    ]);
    const baseline = createSyntheticMetricListeningObservation();
    expect(metricAudioObservationSchema.parse(baseline)).toEqual(baseline);
    expect(baseline.metrics).not.toHaveProperty("mel-bands");
    const config = budgetInput(baseline).config;
    expect(config.requestedMetrics).toHaveLength(3);
    expect(config).not.toHaveProperty("mel-bands");
    expect(summarizeMetricListeningResult(baseline).metrics).toHaveLength(3);
    const report = projectMetricListeningReport(baseline);
    expect(report.metricMetadata).not.toHaveProperty("mel-bands");
    expect(report.metricStatus).not.toHaveProperty("mel-bands");
    expect(report.rows.every((row) => !Object.hasOwn(row, "mel-bands"))).toBe(
      true,
    );
    const four = fixture();
    expect(budgetInput(four).config.requestedMetrics).toHaveLength(4);
    expect(() =>
      nativeMetricListeningConfigSchema.parse({
        ...budgetInput(four).config,
        requestedMetrics: [...four.requestedMetrics, "mel-bands"],
      }),
    ).toThrow();
  });

  it.each(["none", "one", "all"] as const)(
    "roundtrips complete or partial four-metric contracts with %s missing mel slots",
    (missing) => {
      const observation = fixture({}, missing);
      expect(
        storedAudioObservationSchema.parse(
          JSON.parse(JSON.stringify(observation)),
        ),
      ).toEqual(observation);
      const summary = summarizeMetricListeningResult(observation);
      const mel = observation.metrics["mel-bands"]!;
      expect(summary.metrics).toHaveLength(4);
      expect(summary.metrics[3]).toEqual({
        metric: "mel-bands",
        status: mel.status,
        expectedRecords: mel.expectedRecords,
        retainedRecords: mel.frames.length,
        missingRecords: mel.gaps.length,
        gapReasons: missing === "none" ? [] : ["dependency-unavailable"],
      });
      const report = projectMetricListeningReport(observation, { limit: 32 });
      expect(report.metricMetadata["mel-bands"]?.profile).toEqual(
        MEL_BAND_PROFILE,
      );
      expect(report.metricStatus["mel-bands"]).toBe(mel.status);
      const projected = projectMelBandTimeline(mel, observation.geometry.rows);
      expect(report.rows.map((row) => row["mel-bands"]?.frames)).toEqual(
        projected.rows.map((row) => row.frames),
      );
      expect(report.rows.map((row) => row["mel-bands"]?.aggregation)).toEqual(
        projected.rows.map((row) => row.aggregation),
      );
      expect(
        report.rows
          .flatMap((row) => row["mel-bands"]?.frames ?? [])
          .map((frame) => frame.analysis.magnitudes),
      ).toEqual(mel.frames.map((frame) => frame.magnitudes));
      expect(
        JSON.stringify(report).match(/"mel-band-profile\/v1"/g),
      ).toHaveLength(1);
      expect(bytes(report)).toBeLessThanOrEqual(48 * 1_024);
    },
  );

  it("rejects unrequested mel data and absent requested timelines, not default-filling them", () => {
    const observation = fixture();
    expect(
      metricAudioObservationSchema.safeParse({
        ...observation,
        requestedMetrics: ["level", "spectral-centroid", "attacks"],
      }).success,
    ).toBe(false);
    const baseline = createSyntheticMetricListeningObservation();
    expect(
      metricAudioObservationSchema.safeParse({
        ...baseline,
        outcome: "partial",
        requestedMetrics: [...baseline.requestedMetrics, "mel-bands"],
      }).success,
    ).toBe(false);
    expect(
      metricAudioObservationSchema.safeParse({
        ...observation,
        rows: observation.rows.map((row) => ({
          ...row,
          "mel-bands": undefined,
        })),
      }).success,
    ).toBe(false);
  });

  it("binds mel support and sample rate exactly even if the native three remain valid", () => {
    const observation = fixture();
    const mel = observation.metrics["mel-bands"]!;
    for (const changed of [
      { ...mel, sampleRate: 44_100 },
      { ...mel, profile: { ...MEL_BAND_PROFILE, scale: 1 } },
      {
        ...mel,
        profile: { ...MEL_BAND_PROFILE, schema: "mel-band-profile/v2" },
      },
      {
        ...mel,
        sourceSupport: {
          startSample: mel.sourceSupport.startSample + 1,
          endSample: mel.sourceSupport.endSample + 1,
        },
        frames: mel.frames.map((frame) => ({
          ...frame,
          support: {
            startSample: frame.support.startSample + 1,
            endSample: frame.support.endSample + 1,
          },
        })),
      },
      {
        ...mel,
        frames: mel.frames.map((frame, index) =>
          index ? frame : { ...frame, magnitudes: [[NaN], []] },
        ),
      },
      {
        ...mel,
        frames: mel.frames.map((frame, index) =>
          index
            ? frame
            : { ...frame, magnitudes: [Array(24).fill(-1), Array(24).fill(1)] },
        ),
      },
    ]) {
      expect(
        metricAudioObservationSchema.safeParse({
          ...observation,
          metrics: { ...observation.metrics, "mel-bands": changed },
        }).success,
      ).toBe(false);
    }
    const badNative = structuredClone(observation);
    badNative.metrics.level.records[0]!.rms[0] = 65;
    expect(metricAudioObservationSchema.safeParse(badNative).success).toBe(
      false,
    );
  });

  it("represents a short capture as explicit no-frame and disallows padded references", () => {
    const observation = fixture({ endBeat: 0.01 });
    expect(observation.metrics["mel-bands"]!.expectedRecords).toBe(0);
    expect(observation.rows[0]!["mel-bands"]).toEqual({
      availability: "no-frame",
      recordIndices: [],
    });
    const report = projectMetricListeningReport(observation);
    expect(report.rows[0]!["mel-bands"]!.aggregation).toEqual({
      status: "no-frames",
      frameCount: 0,
    });
    expect(report.metricMetadata["mel-bands"]!.trailingSupport).toEqual(
      observation.sourceCoverage,
    );
    expect(
      metricAudioObservationSchema.safeParse({
        ...observation,
        rows: observation.rows.map((row) => ({
          ...row,
          "mel-bands": { availability: "available", recordIndices: [0] },
        })),
      }).success,
    ).toBe(false);
  });

  it("rejects forged report metadata, coverage, vectors and derived arithmetic", () => {
    const report = projectMetricListeningReport(fixture());
    const altered = structuredClone(report);
    altered.rows[0]!["mel-bands"]!.frames[0]!.analysis = {
      ...altered.rows[0]!["mel-bands"]!.frames[0]!.analysis,
      ratios: [
        {
          lowMid: { value: 123, reason: null },
          highMid: { value: 123, reason: null },
        },
        altered.rows[0]!["mel-bands"]!.frames[0]!.analysis.ratios[1],
      ],
    };
    expect(metricListeningReportSchema.safeParse(altered).success).toBe(false);
    expect(
      metricListeningReportSchema.safeParse({
        ...report,
        observationOutcome: "partial",
        metricStatus: { ...report.metricStatus, "mel-bands": "failed" },
        metricMetadata: {
          ...report.metricMetadata,
          "mel-bands": {
            ...report.metricMetadata["mel-bands"],
            retainedRecords: 0,
            missingRecords: report.metricMetadata["mel-bands"]!.expectedRecords,
          },
        },
      }).success,
    ).toBe(false);
    expect(
      metricListeningReportSchema.safeParse({
        ...report,
        metricMetadata: { ...report.metricMetadata, "mel-bands": undefined },
      }).success,
    ).toBe(false);
    expect(
      metricListeningReportSchema.safeParse({
        ...report,
        metricStatus: { ...report.metricStatus, "mel-bands": "partial" },
      }).success,
    ).toBe(false);
    expect(
      metricListeningReportSchema.safeParse({
        ...report,
        rows: report.rows.map((row) => ({ ...row, "mel-bands": undefined })),
      }).success,
    ).toBe(false);
    expect(
      metricListeningReportSchema.safeParse({
        ...report,
        rows: report.rows.map((row, i) =>
          i
            ? row
            : {
                ...row,
                "mel-bands": {
                  ...row["mel-bands"],
                  aggregation: { status: "no-frames", frameCount: 0 },
                },
              },
        ),
      }).success,
    ).toBe(false);
    const summary = summarizeMetricListeningResult(fixture());
    expect(
      metricListeningResultSummarySchema.safeParse({
        ...summary,
        metrics: summary.metrics.filter((metric) => metric.metric !== "level"),
      }).success,
    ).toBe(false);
    expect(
      metricListeningResultSummarySchema.safeParse({
        ...summary,
        metrics: summary.metrics.map((metric) =>
          metric.metric === "mel-bands"
            ? {
                ...metric,
                status: "not-requested",
                expectedRecords: 0,
                retainedRecords: 0,
              }
            : metric,
        ),
      }).success,
    ).toBe(false);
  });

  it("paginates complete mel vectors without reducing authoritative observations", () => {
    const observation = fixture({ endBeat: 32 }, "one");
    const retained = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const report = projectMetricListeningReport(observation, {
        offset,
        limit: 32,
      });
      expect(report.rows.length).toBeGreaterThan(0);
      expect(bytes(report)).toBeLessThanOrEqual(48 * 1_024);
      retained.push(...report.rows.flatMap((row) => row["mel-bands"]!.frames));
      offset = report.nextOffset;
    }
    expect(retained.map((frame) => frame.analysis.magnitudes)).toEqual(
      observation.metrics["mel-bands"]!.frames.map((frame) => frame.magnitudes),
    );
    expect(observation.reduction.mode).toBe("none");
  });

  it("fails an oversized integrated row rather than trimming mel vectors or bands", () => {
    const observation = fixture({ tempoBpm: 20, endBeat: 0.25 });
    const mel = observation.metrics["mel-bands"]!;
    observation.metrics["mel-bands"] = melBandTimelineSchema.parse({
      ...mel,
      frames: mel.frames.map((frame) => ({
        ...frame,
        magnitudes: Array.from({ length: 2 }, () =>
          Array<number>(24).fill(0.0000010000000000000002),
        ),
      })),
    });
    observation.limitations = Array<string>(16).fill("界".repeat(240));
    observation.metrics.level.limitations = Array<string>(8).fill(
      "界".repeat(240),
    );
    metricAudioObservationSchema.parse(observation);
    expect(() =>
      projectMetricListeningReport(observation, { limit: 1 }),
    ).toThrow("metric_report_row_exceeds_byte_limit");
  });

  it("adds the mel bound exactly once plus row references and repeated config proof bytes", () => {
    const observation = fixture({ endBeat: 4 });
    const four = admitMetricListeningBudget(budgetInput(observation));
    const baseline = createSyntheticMetricListeningObservation({ endBeat: 4 });
    const three = admitMetricListeningBudget(budgetInput(baseline));
    for (const outcome of ["complete", "partial"] as const) {
      expect(
        four.operands.metricsBytes[outcome] -
          three.operands.metricsBytes[outcome],
      ).toBe(four.operands.melTimelineBytes![outcome] + bytes("mel-bands") + 2);
    }
    expect(four.operands.reportRowsBytes).toBeGreaterThan(
      three.operands.reportRowsBytes,
    );
    expect(four.operands.nativeSourceCoverageBytes).toBeGreaterThan(
      three.operands.nativeSourceCoverageBytes,
    );
    expect(four.operands.wireHeaderBytes).toBe(three.operands.wireHeaderBytes);
  });

  it.each([44_100, 48_000] as const)(
    "bounds admitted four-metric short and eight-bar results at %i Hz with unknown origins",
    (sampleRate) => {
      for (const missing of ["none", "one", "all"] as const) {
        for (const endBeat of [4, 32]) {
          const observation = fixture(
            { sampleRate, endBeat, startSample: 2 ** 44 - 4_000_000 },
            missing,
          );
          const input = budgetInput(observation);
          const decision = admitMetricListeningBudget(input);
          expect(decision.admitted).toBe(true);
          expect(bytes(observation)).toBeLessThanOrEqual(
            decision.upperBounds[observation.outcome].observationBytes,
          );
          const melBudget = admitMelBandBudget({
            sampleRate,
            sourceSupport: {
              startSample: 0,
              endSample: observation.geometry.totalSamples,
            },
            profile: MEL_BAND_PROFILE,
            byteLimit: 2 * 1_024 * 1_024,
          });
          expect(decision.operands.melTimelineBytes).toEqual(
            melBudget.upperBounds,
          );
          expect(decision.operands.expectedRecords["mel-bands"]).toBe(
            observation.metrics["mel-bands"]!.expectedRecords,
          );
          expect(decision.upperBounds.complete.frameBytes).toBeGreaterThan(
            decision.upperBounds.complete.observationBytes +
              melBudget.upperBounds.complete / 100,
          );
        }
      }
    },
  );

  it("denies a worst-case thirty-second fast-tempo four-metric publication without truncation", () => {
    const observation = fixture({ tempoBpm: 999, endBeat: 499.5 });
    const decision = admitMetricListeningBudget(budgetInput(observation));
    expect(decision.admitted).toBe(false);
    if (decision.admitted) throw new Error("Expected admission denial");
    expect(decision.reason).toBe("metric_result_budget_exceeded");
    expect(
      decision.violations.some((violation) => violation.boundary === "frame"),
    ).toBe(true);
    expect(decision.snapshot.config.requestedMetrics).toHaveLength(4);
    expect(decision.operands.expectedRecords["mel-bands"]).toBe(703);
    expect(decision.operands.reportRows).toBe(1_998);
  });
});
