import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { withSyntheticAnalyzerTimelines } from "@ableton-agent/protocol/testing";
import { arrangementTestEvidence } from "./arrangement-test-support.js";
import { melSmokeFixture } from "./mel-smoke-test-support.js";
import { projectArrangementObservationCapture } from "./arrangement.js";

function fixture() {
  const baseline = arrangementTestEvidence().baseline;
  const observation = withSyntheticAnalyzerTimelines(
    melSmokeFixture().observation,
  );
  Reflect.set(baseline.source, "trackId", randomUUID());
  Reflect.set(baseline.source, "endBeat", 80);
  observation.source = {
    view: "arrangement",
    target: {
      kind: "regular",
      index: baseline.source.trackIndex,
      expectedReference: baseline.source.trackId,
    },
    transport: { startBeat: 0, endBeat: 4 },
  };
  observation.ownership.listenerId = baseline.listenerId;
  const owner = {
    baseline,
    expectedRange: { startBeat: 0, endBeat: 4 },
    ...observation.ownership,
    contextId: "persisted-context",
    operationId: "normal-message",
    nativeCleanupConfirmed: true,
    sourceCleanupConfirmed: true,
    playbackPlaying: true,
  };
  return { observation, owner };
}

describe("normal Arrangement whole-observation evidence", () => {
  it("attributes a complete approved subrange without rewriting the admitted full source or inventing a stream", () => {
    const { observation, owner } = fixture();
    const capture = projectArrangementObservationCapture(observation, owner);
    expect(capture.contextId).toBe("persisted-context");
    expect(capture.stream).toBeUndefined();
    expect(capture.source.endBeat).toBe(80);
    expect(capture.metrics).toHaveLength(6);
    for (const metric of capture.metrics) {
      expect(metric.receivedRecords).toBe(metric.expectedRecords);
      expect(metric.nonSilent).toBeUndefined();
    }
    expect(capture.cleanup).toMatchObject({
      captureReleased: true,
      sourceRestored: true,
    });
  });

  it.each([
    "source",
    "track-index",
    "listener",
    "pass",
    "trace",
    "correlation",
    "causation",
    "range",
    "outside-admission",
    "missing-metric",
    "partial",
    "native-cleanup",
    "source-cleanup",
  ] as const)(
    "rejects mismatched or incomplete original evidence (%s)",
    (fault) => {
      const { observation, owner } = fixture();
      if (observation.source.view !== "arrangement") throw new Error("fixture");
      if (fault === "source")
        observation.source.target.expectedReference = randomUUID();
      if (fault === "track-index") observation.source.target.index = 9;
      if (fault === "listener")
        observation.ownership.listenerId = "foreign-listener";
      if (fault === "pass") owner.passId = "foreign-pass";
      if (fault === "trace") owner.traceId = randomUUID();
      if (fault === "correlation") owner.correlationId = randomUUID();
      if (fault === "causation") owner.causationId = randomUUID();
      if (fault === "range") owner.expectedRange.endBeat = 8;
      if (fault === "outside-admission")
        Reflect.set(owner.baseline.source, "endBeat", 2);
      if (fault === "missing-metric") observation.requestedMetrics.pop();
      if (fault === "partial") observation.outcome = "partial";
      if (fault === "native-cleanup") owner.nativeCleanupConfirmed = false;
      if (fault === "source-cleanup") owner.sourceCleanupConfirmed = false;
      expect(() =>
        projectArrangementObservationCapture(observation, owner),
      ).toThrow();
    },
  );
});
