import { describe, expect, it } from "vitest";
import {
  LISTENING_FEATURE_DEFINITIONS,
  extractListeningFeature,
  segmentListeningObservation,
  type ContextFeature,
  type ContextSegment,
  type ListeningFeatureType,
} from "@ableton-agent/protocol";
import { withSyntheticAnalyzerTimelines } from "@ableton-agent/protocol/testing";
import { melSmokeFixture } from "./mel-smoke-test-support.js";
import {
  verifyStoredFeatureEquivalence,
  measureStoredFeatureDifferences,
  type StoredFeatureSequence,
  type FeatureEquivalenceTolerances,
} from "./feature-equivalence.js";

function sequence(side: "session" | "arrangement", measures = 1) {
  const observation = withSyntheticAnalyzerTimelines(
    melSmokeFixture().observation,
  );
  const coordinate: ContextSegment["coordinate"] =
    side === "session" ? "clip-local-beats" : "transport-beats";
  const alignment = {
    version: 1 as const,
    coordinate,
    meter: { numerator: 4, denominator: 4 },
    barOriginBeat: 0,
    tempoBpm: observation.geometry.tempoBpm,
    tempoEvidence: "message-rate-monitored-constant" as const,
    provenance:
      side === "session"
        ? ("session-clip-markers/v1" as const)
        : ("capture-snapshot/v1" as const),
  };
  const range = segmentListeningObservation(observation, {
    ...alignment,
    coordinate:
      observation.source.view === "session"
        ? "clip-local-beats"
        : "transport-beats",
  })[0]!;
  const contextId = `context-${side}`;
  const segments: ContextSegment[] = [];
  const features: ContextFeature[] = [];
  for (let order = 0; order < measures; order++) {
    const segmentId = `segment-${side}-${order}`;
    segments.push({
      id: segmentId,
      entryId: contextId,
      sessionId: "session",
      liveSetId: "set",
      order,
      kind: "bar",
      coordinate,
      startBeat: order * 4,
      endBeat: (order + 1) * 4,
      startSample: (side === "session" ? 0 : 480000) + order * 90000,
      endSample: (side === "session" ? 0 : 480000) + (order + 1) * 90000,
      sampleRate: 48000,
      alignment,
      alignmentReason: null,
    });
    for (const definition of LISTENING_FEATURE_DEFINITIONS)
      features.push({
        id: `feature-${side}-${order}-${definition.type.replace("/", ":")}`,
        entryId: contextId,
        segmentId,
        sessionId: "session",
        liveSetId: "set",
        sourceFingerprint: "a".repeat(64),
        createdAt: "2026-11-15T00:00:00.000Z",
        trace: {
          traceId: "00000000-0000-4000-8000-000000000001",
          correlationId: "correlation",
          causationId: "cause",
        },
        feature: extractListeningFeature(definition.type, observation, range),
      });
  }
  return {
    contextId,
    passId: `pass-${side}`,
    sessionId: "session",
    liveSetId: "set",
    startBeat: 0,
    endBeat: measures * 4,
    startSample: side === "session" ? 0 : 480000,
    endSample: (side === "session" ? 0 : 480000) + measures * 90000,
    sampleRate: 48000,
    segments,
    features,
  } satisfies StoredFeatureSequence;
}

function tolerances(absolute = 0): FeatureEquivalenceTolerances {
  return Object.fromEntries(
    LISTENING_FEATURE_DEFINITIONS.map(({ type }) => [
      type,
      { absolute, relative: 0 },
    ]),
  ) as FeatureEquivalenceTolerances;
}

function fixture(measures = 1) {
  return {
    left: sequence("session", measures),
    right: sequence("arrangement", measures),
    expectedMeasures: measures,
    tolerances: tolerances(),
  };
}

function feature(
  source: StoredFeatureSequence,
  type: ListeningFeatureType,
  measure = 0,
) {
  return source.features.find(
    (record) =>
      record.feature.type === type &&
      record.segmentId === source.segments[measure]!.id,
  )!.feature;
}

describe("stored cross-source feature equivalence", () => {
  it("compares all fifteen definitions without matching source IDs or clocks", () => {
    const input = fixture();
    const result = verifyStoredFeatureEquivalence(input);
    expect(result.measures).toBe(1);
    expect(result.features).toBe(15);
    expect(result.values).toBeGreaterThan(0);
    expect(result.maximumAbsoluteDifferences["peak-summary/v1"]).toBe(0);
  });

  it("checks every measure, including the last measure of a long capture", () => {
    const input = fixture(20);
    expect(verifyStoredFeatureEquivalence(input).features).toBe(300);
    feature(input.right, "peak-summary/v1", 19).values![0]! += 0.125;
    expect(() => verifyStoredFeatureEquivalence(input)).toThrow(
      /measure 20.*peak-summary/u,
    );
  });

  it("accepts a frozen tolerance boundary and rejects a value beyond it", () => {
    const input = fixture();
    input.tolerances = tolerances(0.125);
    feature(input.right, "peak-summary/v1").values![0]! += 0.125;
    expect(verifyStoredFeatureEquivalence(input).measures).toBe(1);
    feature(input.right, "peak-summary/v1").values![0]! += 0.001;
    expect(() => verifyStoredFeatureEquivalence(input)).toThrow(/tolerance/u);
  });

  it("rejects a missing measure instead of comparing a matching prefix", () => {
    const input = fixture(2);
    input.right.segments.pop();
    expect(() => verifyStoredFeatureEquivalence(input)).toThrow(/measure/u);
  });

  it("rejects duplicated and omitted feature definitions", () => {
    const input = fixture();
    input.right.features[1] = {
      ...input.right.features[0]!,
      id: "duplicated-definition",
    };
    expect(() => verifyStoredFeatureEquivalence(input)).toThrow(/duplicate/u);
  });

  it("rejects features belonging to another context", () => {
    const input = fixture();
    input.right.features[0]!.entryId = "other-context";
    expect(() => verifyStoredFeatureEquivalence(input)).toThrow(/ownership/u);
  });

  it("rejects an incorrect measure range even when values match", () => {
    const input = fixture();
    input.right.segments[0]!.endBeat = 3;
    expect(() => verifyStoredFeatureEquivalence(input)).toThrow(/range/u);
  });

  it("rejects shifted segment sample support even when duration and values match", () => {
    const input = fixture();
    input.right.segments[0]!.startSample++;
    input.right.segments[0]!.endSample++;
    expect(() => verifyStoredFeatureEquivalence(input)).toThrow(/sample/u);
  });

  it("does not allow permissive numeric tolerances to excuse a profile change", () => {
    const input = fixture();
    input.tolerances = tolerances(1e9);
    feature(input.right, "peak-summary/v1").profileKey = "other-profile";
    expect(() => verifyStoredFeatureEquivalence(input)).toThrow(/profile/u);
  });

  it("rejects shifted grid values instead of averaging an entire measure", () => {
    const input = fixture();
    const grid = feature(input.right, "mel-grid/v1");
    const defined = grid.values!.findIndex((value) => value !== null);
    const nextCell = defined + 48;
    expect(grid.values![nextCell]).not.toBeNull();
    expect(grid.values![nextCell]).not.toBe(grid.values![defined]);
    [grid.values![defined], grid.values![nextCell]] = [
      grid.values![nextCell]!,
      grid.values![defined]!,
    ];
    expect(() => verifyStoredFeatureEquivalence(input)).toThrow(/mel-grid/u);
  });

  it("requires a complete finite nonnegative tolerance catalog", () => {
    const input = fixture();
    input.tolerances["peak-summary/v1"] = {
      absolute: Number.POSITIVE_INFINITY,
      relative: 0,
    };
    expect(() => verifyStoredFeatureEquivalence(input)).toThrow();
    input.tolerances["peak-summary/v1"] = { absolute: -1, relative: 0 };
    expect(() => verifyStoredFeatureEquivalence(input)).toThrow();
  });

  it("uses the frozen absolute-plus-relative policy without changing it", () => {
    const input = fixture();
    input.tolerances["peak-summary/v1"] = { absolute: 0, relative: 0.25 };
    const peak = feature(input.right, "peak-summary/v1");
    const original = peak.values![0]!;
    peak.values![0] = original * 1.25;
    expect(verifyStoredFeatureEquivalence(input).measures).toBe(1);
    peak.values![0] = original * 2;
    expect(() => verifyStoredFeatureEquivalence(input)).toThrow(/tolerance/u);
    expect(input.tolerances["peak-summary/v1"]).toEqual({
      absolute: 0,
      relative: 0.25,
    });
  });

  it("does not turn numeric overflow into unlimited tolerance", () => {
    const input = fixture();
    input.tolerances["peak-summary/v1"] = {
      absolute: Number.MAX_VALUE,
      relative: Number.MAX_VALUE,
    };
    expect(() => verifyStoredFeatureEquivalence(input)).toThrow(/tolerance/u);
  });

  it("rejects a missing tolerance rather than defaulting to a permissive one", () => {
    const input = fixture();
    Reflect.deleteProperty(input.tolerances, "peak-summary/v1");
    expect(() => verifyStoredFeatureEquivalence(input)).toThrow(/tolerance/u);
  });

  it("does not call two silent peak outputs meaningful equivalence", () => {
    const input = fixture();
    feature(input.left, "peak-summary/v1").values = [0, 0];
    feature(input.right, "peak-summary/v1").values = [0, 0];
    expect(() => verifyStoredFeatureEquivalence(input)).toThrow(/meaningful/u);
  });

  it("rejects reordered measures and mixed source fingerprints", () => {
    const reordered = fixture(2);
    reordered.right.segments.reverse();
    expect(() => verifyStoredFeatureEquivalence(reordered)).toThrow(/range/u);
    const mixed = fixture();
    mixed.right.features[1]!.sourceFingerprint = "b".repeat(64);
    expect(() => verifyStoredFeatureEquivalence(mixed)).toThrow(/fingerprint/u);
  });

  it("measures repeatability differences without calling them equivalence", () => {
    const input = fixture();
    feature(input.right, "peak-summary/v1").values![0]! += 0.125;
    const report = measureStoredFeatureDifferences(input);
    expect(report.kind).toBe("measurement-only");
    expect(report.maximumAbsoluteDifferences["peak-summary/v1"]).toBe(0.125);
    expect(() => verifyStoredFeatureEquivalence(input)).toThrow(/tolerance/u);
  });

  it("does not excuse structural variation during repeatability measurement", () => {
    const input = fixture();
    feature(input.right, "peak-summary/v1").profileKey = "other-profile";
    expect(() => measureStoredFeatureDifferences(input)).toThrow(/profile/u);
  });
});
