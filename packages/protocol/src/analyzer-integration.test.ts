import { describe, expect, it } from "vitest";
import { withSyntheticAnalyzerTimelines } from "./analyzer-testing.js";
import { createSyntheticMetricListeningObservation } from "./metric-testing.js";
import { metricAudioObservationSchema } from "./metric-observation-schemas.js";
import { storedAudioObservationSchema } from "./audio-observation-schemas.js";
import {
  metricListeningReportSchema,
  projectMetricListeningReport,
  MAX_METRIC_REPORT_PAGE_BYTES,
} from "./metric-listening-report.js";
import { summarizeMetricListeningResult } from "./metric-listening-job-schemas.js";
import { boundAnalyzerTimelineBytes } from "./analyzer-budget.js";
import {
  admitMetricListeningBudget,
  metricListeningBudgetInputSchema,
} from "./metric-listening-budget.js";
import { createMetricListeningGeometry } from "./metric-listening-geometry.js";

describe("synthetic authoritative analyzer consumer integration", () => {
  it("preserves historical payloads without synthesizing descriptors", () => {
    const old = createSyntheticMetricListeningObservation();
    expect(storedAudioObservationSchema.parse(old)).toEqual(old);
    expect(projectMetricListeningReport(old).metricMetadata).not.toHaveProperty(
      "pitch",
    );
  });
  it("retains paired raw zero sentinels, states, profiles, tails and real overlapping supports", () => {
    const observation = withSyntheticAnalyzerTimelines(
      createSyntheticMetricListeningObservation(),
    );
    const report = projectMetricListeningReport(observation);
    const frame = observation.metrics.pitch!.frames[2]!;
    expect(
      report.rows.filter((row) =>
        row.pitch?.frames.some((item) => item.index === frame.index),
      ),
    ).toHaveLength(2);
    expect(report.rows[0]!.pitch?.frames[0]?.channels[1]).toEqual({
      state: "undefined",
      hz: 0,
      confidence: 0,
    });
    expect(report.rows[0]!["spectral-shape"]?.frames[0]?.channels[1]).toEqual({
      state: "silence",
      flatnessDb: null,
      spreadHz: null,
      rolloffHz: null,
    });
    expect(report.metricMetadata.pitch?.profile.confidenceUnits).toBe(
      "algorithm-score-not-probability",
    );
    expect(report.metricMetadata.pitch?.trailingSupport).toEqual(
      observation.metrics.pitch?.trailingSupport,
    );
    expect(storedAudioObservationSchema.parse(observation)).toEqual(
      observation,
    );
    expect(summarizeMetricListeningResult(observation).metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ metric: "pitch", status: "complete" }),
      ]),
    );
  });
  it.each([
    "sequence-gap",
    "overflow",
    "malformed-record",
    "drain-timeout",
    "dependency-unavailable",
  ] as const)("isolates %s to the affected analyzer", (reason) => {
    const observation = withSyntheticAnalyzerTimelines(
      createSyntheticMetricListeningObservation(),
      reason,
    );
    expect(observation.outcome).toBe("partial");
    expect(observation.metrics.level.status).toBe("complete");
    expect(observation.metrics["spectral-shape"]?.status).toBe("complete");
    expect(
      projectMetricListeningReport(observation).rows[0]?.pitch?.gaps[0]?.reason,
    ).toBe(reason);
  });
  it("rejects unrequested, dropped, foreign-support and malformed channel records", () => {
    const original = withSyntheticAnalyzerTimelines(
      createSyntheticMetricListeningObservation(),
    );
    const cases = [
      {
        ...original,
        requestedMetrics: original.requestedMetrics.filter(
          (metric) => metric !== "pitch",
        ),
      },
      { ...original, metrics: { ...original.metrics, pitch: undefined } },
      {
        ...original,
        metrics: {
          ...original.metrics,
          pitch: {
            ...original.metrics.pitch!,
            frames: original.metrics.pitch!.frames.slice(1),
          },
        },
      },
      {
        ...original,
        metrics: {
          ...original.metrics,
          pitch: {
            ...original.metrics.pitch!,
            sourceSupport: { startSample: 1, endSample: 2 },
          },
        },
      },
      {
        ...original,
        metrics: {
          ...original.metrics,
          pitch: {
            ...original.metrics.pitch!,
            frames: original.metrics.pitch!.frames.map((frame) => ({
              ...frame,
              channels: [
                { state: "accepted-estimate", hz: 440, confidence: 0 },
                frame.channels[1],
              ],
            })),
          },
        },
      },
    ];
    for (const value of cases)
      expect(metricAudioObservationSchema.safeParse(value).success).toBe(false);
    const report = projectMetricListeningReport(original);
    report.rows[0]!.pitch!.frames.shift();
    expect(metricListeningReportSchema.safeParse(report).success).toBe(false);
  });
  it("sums exact worst-case analyzer bounds and paginates without raising quotas", () => {
    expect(boundAnalyzerTimelineBytes("pitch", 703)).toBe(217321);
    expect(boundAnalyzerTimelineBytes("spectral-shape", 703)).toBe(251285);
    const observation = withSyntheticAnalyzerTimelines(
      createSyntheticMetricListeningObservation({ tempoBpm: 128, endBeat: 64 }),
    );
    const { sampleRate, vectorSize, tempoBpm, startBeat, endBeat } =
      observation.geometry;
    const geometry = createMetricListeningGeometry({
      sampleRate,
      vectorSize,
      tempoBpm,
      startBeat,
      endBeat,
      startSample: 0,
    });
    const budget = admitMetricListeningBudget({
      config: {
        scope: "independent-metric-timelines/v1",
        algorithmVersion: "3.0.0",
        mode: "arrangement",
        sourceEvidence: "transport-only",
        geometry,
        timingPolicy: observation.alignment.policy,
        grid: {
          beats: 0.25,
          anchor: "global-beat-grid",
          rounding: "nearest-sample",
          coordinates: "capture-local",
        },
        requestedMetrics: observation.requestedMetrics,
        attacks: { thresholdDb: 6, minSpacingSamples: 4800 },
      },
      ownership: observation.ownership,
      source: observation.source,
      jobId: "synthetic-analyzers",
    });
    expect(budget.admitted).toBe(true);
    expect(budget.operands.analyzerTimelineBytes).toEqual({
      pitch: 217321,
      "spectral-shape": 251285,
    });
    expect(budget.limits.observationBytes).toBe(2 * 1024 * 1024);
    expect(Buffer.byteLength(JSON.stringify(observation))).toBeLessThan(
      budget.upperBounds.complete.observationBytes,
    );
    const allMetrics = admitMetricListeningBudget({
      ...metricListeningBudgetInputSchema.parse(budget.snapshot),
      config: {
        ...metricListeningBudgetInputSchema.parse(budget.snapshot).config,
        requestedMetrics: [
          ...budget.snapshot.config.requestedMetrics,
          "mel-bands",
        ],
      },
    });
    expect(allMetrics.operands.metricsBytes.complete).toBeGreaterThan(
      budget.operands.metricsBytes.complete +
        allMetrics.operands.melTimelineBytes!.complete,
    );
    expect(allMetrics.limits).toEqual(budget.limits);
    expect(allMetrics.operands.analyzerTimelineBytes).toEqual(
      budget.operands.analyzerTimelineBytes,
    );
    expect(allMetrics.admitted).toBe(false);
    if (!allMetrics.admitted) {
      expect(allMetrics.reason).toBe("metric_result_budget_exceeded");
      expect(
        allMetrics.violations.some(
          (violation) => violation.outcome === "partial",
        ),
      ).toBe(true);
    }
    let offset: number | null = 0;
    let rows = 0;
    while (offset !== null) {
      const report = projectMetricListeningReport(observation, {
        offset,
        limit: 32,
      });
      expect(Buffer.byteLength(JSON.stringify(report))).toBeLessThanOrEqual(
        MAX_METRIC_REPORT_PAGE_BYTES,
      );
      rows += report.rows.length;
      offset = report.nextOffset;
    }
    expect(rows).toBe(observation.rows.length);
  });
  it("rejects contradictory repeated overlap frames and spectral values above actual Nyquist", () => {
    const observation = withSyntheticAnalyzerTimelines(
      createSyntheticMetricListeningObservation({ sampleRate: 44100 }),
    );
    const report = projectMetricListeningReport(observation);
    const repeated = report.rows[1]!.pitch!.frames[0]!;
    report.rows[1]!.pitch!.frames[0] = {
      ...repeated,
      channels: [
        { state: "accepted-estimate", hz: 880, confidence: 0.99 },
        repeated.channels[1],
      ],
    };
    expect(metricListeningReportSchema.safeParse(report).success).toBe(false);
    const nyquist = projectMetricListeningReport(observation);
    const shape = nyquist.rows[0]!["spectral-shape"]!.frames[0]!;
    nyquist.rows[0]!["spectral-shape"]!.frames[0] = {
      ...shape,
      channels: [
        { state: "valid", flatnessDb: -20, spreadHz: 23000, rolloffHz: 1000 },
        shape.channels[1],
      ],
    };
    expect(metricListeningReportSchema.safeParse(nyquist).success).toBe(false);
  });
});
