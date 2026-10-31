import { describe, expect, it } from "vitest";
import {
  metricListeningResultSummariesSchema,
  metricListeningResultSummarySchema,
  summarizeMetricListeningResult,
} from "./metric-listening-job-schemas.js";
import {
  createSyntheticMetricListeningObservation,
  createSyntheticPartialMetricListeningObservation,
} from "./metric-testing.js";

describe("bounded metric lifecycle summaries", () => {
  it("reports honest complete and partial coverage without measurement bodies", () => {
    const complete = summarizeMetricListeningResult(
      createSyntheticMetricListeningObservation(),
    );
    expect(complete).toMatchObject({
      listenerId: "listener",
      outcome: "complete",
      metrics: [
        { metric: "level", status: "complete", missingRecords: 0 },
        { metric: "spectral-centroid", status: "complete", missingRecords: 0 },
        { metric: "attacks", status: "complete", missingRecords: 0 },
      ],
    });
    const partial = summarizeMetricListeningResult(
      createSyntheticPartialMetricListeningObservation(),
    );
    expect(partial).toMatchObject({
      outcome: "partial",
      metrics: [
        { metric: "level", status: "complete" },
        {
          metric: "spectral-centroid",
          status: "partial",
          expectedRecords: 11,
          retainedRecords: 10,
          missingRecords: 1,
          gapReasons: ["drain-timeout"],
        },
        { metric: "attacks", status: "complete" },
      ],
    });
    expect(JSON.stringify(partial)).not.toContain("centroidHz");
    expect(JSON.stringify(partial)).not.toContain("Synthetic missing frame");
    expect(metricListeningResultSummariesSchema.parse([partial])).toEqual([
      partial,
    ]);
  });

  it("keeps legitimate zero-frame spectral acquisition complete, not failed", () => {
    const summary = summarizeMetricListeningResult(
      createSyntheticMetricListeningObservation({ endBeat: 0.01 }),
    );
    expect(summary.metrics[1]).toMatchObject({
      metric: "spectral-centroid",
      status: "complete",
      retainedRecords: 0,
      missingRecords: 0,
    });
    expect(summary.outcome).toBe("complete");
  });

  it("rejects forged completeness, duplicate metrics, lost counts and unbounded details", () => {
    const summary = summarizeMetricListeningResult(
      createSyntheticPartialMetricListeningObservation(),
    );
    for (const invalid of [
      { ...summary, outcome: "complete" },
      {
        ...summary,
        metrics: [summary.metrics[0], summary.metrics[0], summary.metrics[2]],
      },
      { ...summary, listenerId: "x".repeat(129) },
      {
        ...summary,
        metrics: summary.metrics.map((metric) => ({
          ...metric,
          retainedRecords: 2_001,
        })),
      },
      {
        ...summary,
        metrics: summary.metrics.map((metric) => ({
          ...metric,
          detail: "Not part of this bounded public summary",
        })),
      },
      {
        ...summary,
        metrics: summary.metrics.map((metric) => ({
          ...metric,
          missingRecords: 0,
        })),
      },
    ])
      expect(
        metricListeningResultSummarySchema.safeParse(invalid).success,
      ).toBe(false);
    expect(
      metricListeningResultSummariesSchema.safeParse(Array(9).fill(summary))
        .success,
    ).toBe(false);
    expect(
      metricListeningResultSummariesSchema.safeParse([summary, summary])
        .success,
    ).toBe(false);
  });
});
