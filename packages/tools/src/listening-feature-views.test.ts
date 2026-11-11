import { describe, expect, it, vi } from "vitest";
import {
  contextFeatureSchema,
  extractPeakFeature,
  listeningFeatureSchema,
  MAX_CONTEXT_FEATURES_PER_DERIVATION,
  LISTENING_FEATURE_DEFINITION_SET,
} from "@ableton-agent/protocol";
import { createSyntheticMetricListeningObservation } from "@ableton-agent/protocol/testing";
import {
  listeningFeaturePageSchema,
  listeningFeaturePageMasksMatch,
  projectListeningFeaturePage,
  projectListeningFeatureRecord,
  projectListeningFeatureDerivation,
} from "./listening-feature-views.js";
import {
  contextOperationParamsSchema,
  contextOperationResultSchema,
  createListeningTools,
} from "./listening-tools.js";

const peak = () =>
  extractPeakFeature(createSyntheticMetricListeningObservation());

const recordFixture = () =>
  contextFeatureSchema.parse({
    id: "feature",
    segmentId: "segment",
    entryId: "entry",
    sessionId: "session",
    liveSetId: "set",
    sourceFingerprint: "a".repeat(64),
    createdAt: "2026-10-12T00:00:00.000Z",
    trace: {
      traceId: "00000000-0000-4000-8000-000000000001",
      correlationId: "query",
      causationId: "call",
    },
    feature: peak(),
  });

describe("bounded listening feature views", () => {
  it("summarizes maximum-size derivation identities without overflowing tool responses", () => {
    const result = projectListeningFeatureDerivation({
      entryId: "source",
      status: "ready",
      definitionSet: LISTENING_FEATURE_DEFINITION_SET,
      reason: null,
      featureIds: Array.from(
        { length: MAX_CONTEXT_FEATURES_PER_DERIVATION },
        (_, index) => `feature-${index}-${"a".repeat(160)}`,
      ),
    });
    expect(result).toEqual({
      entryId: "source",
      status: "ready",
      definitionSet: LISTENING_FEATURE_DEFINITION_SET,
      reason: null,
      featureCount: 7680,
    });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(1024);
  });
  it("removes values and support arrays from inventories without changing the source", () => {
    const record = recordFixture();
    const before = structuredClone(record);
    const projected = projectListeningFeatureRecord(record);
    expect(projected.feature).toMatchObject({
      valueCount: 2,
      supportIntervalCount: 1,
    });
    for (const key of ["values", "support", "profileKey", "limitations"]) {
      expect(projected.feature).not.toHaveProperty(key);
    }
    expect(record).toEqual(before);
  });

  it("pages a summary without manufacturing extra cells or renormalizing", () => {
    const feature = peak();
    expect(projectListeningFeaturePage(feature, 0, 8, 0)).toMatchObject({
      values: feature.values,
      totalCells: 1,
      dimensions: 2,
      cells: [],
      nextOffset: null,
      supportIntervals: feature.support,
      nextSupportOffset: null,
    });
    expect(projectListeningFeaturePage(feature, 1, 8, 1)).toMatchObject({
      values: [],
      cells: [],
      nextOffset: null,
      supportIntervals: [],
      nextSupportOffset: null,
    });
    expect(() => projectListeningFeaturePage(feature, 0, 33, 0)).toThrow();
  });

  it("bounds a maximum-sized mel grid and preserves whole-segment normalization", () => {
    const feature = listeningFeatureSchema.parse({
      ...peak(),
      type: "mel-grid/v1",
      distanceDefinition: "rms-normalized-magnitude/v1",
      units: "normalized-magnitude",
      distanceUnits: "normalized-magnitude",
      profile: "mel-band-profile/v1",
      profileKey: "synthetic-projection-only",
      normalization: "joint-l2",
      supportPolicy: "matching-cell-mask",
      values: Array.from({ length: 2000 * 48 }, () => 1 / Math.sqrt(2000 * 48)),
      coveredSamples: 4000,
      expectedSamples: 4000,
      durationSeconds: 4000 / 48000,
      support: [[0, 4000]],
      grid: {
        stepBeats: 0.25,
        meter: { numerator: 4, denominator: 4 },
        phaseBeats: 0,
        cells: Array.from({ length: 2000 }, (_, index) => ({
          startBeat: index / 4,
          endBeat: (index + 1) / 4,
          expectedSamples: 2,
          coveredSamples: 2,
          reason: null,
        })),
      },
    });
    const page = projectListeningFeaturePage(feature, 32, 32, 0);
    expect(page.cells).toHaveLength(32);
    expect(page.values).toEqual(feature.values!.slice(32 * 48, 64 * 48));
    expect(page.nextOffset).toBe(64);
    expect(page.totalCells).toBe(2000);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(48 * 1024);
    expect(projectListeningFeaturePage(feature, 1984, 32, 1)).toMatchObject({
      nextOffset: null,
      supportIntervals: [],
    });
  });

  it("pages gaps independently of value cells and exposes unavailable data as null", () => {
    const feature = listeningFeatureSchema.parse({
      ...peak(),
      status: "unavailable",
      reason: "insufficient-support",
      values: null,
      expectedSamples: 4000,
      durationSeconds: 4000 / 48000,
      coveredSamples: 2000,
      support: Array.from({ length: 2000 }, (_, index) => [
        index * 2,
        index * 2 + 1,
      ]),
    });
    const page = projectListeningFeaturePage(feature, 0, 32, 32);
    expect(page).toMatchObject({
      values: null,
      nextOffset: null,
      totalSupportIntervals: 2000,
      nextSupportOffset: 64,
    });
    expect(page.supportIntervals).toEqual(feature.support.slice(32, 64));
    expect(
      listeningFeaturePageSchema.safeParse({ ...page, nextSupportOffset: 32 })
        .success,
    ).toBe(false);
    expect(
      listeningFeaturePageSchema.safeParse({ ...page, nextOffset: 0 }).success,
    ).toBe(false);
  });

  it("preserves explicit missing-cell masks rather than filling them with zero", () => {
    const feature = listeningFeatureSchema.parse({
      ...peak(),
      type: "centroid-grid/v1",
      distanceDefinition: "rms-hz/v1",
      units: "Hz",
      distanceUnits: "Hz",
      profile: "fft-energy-centroid/v1",
      profileKey: "synthetic-mask-projection",
      supportPolicy: "matching-cell-mask",
      expectedSamples: 2,
      durationSeconds: 2 / 48000,
      coveredSamples: 1,
      support: [[0, 1]],
      values: [1000, null],
      grid: {
        stepBeats: 0.25,
        meter: { numerator: 4, denominator: 4 },
        phaseBeats: 0,
        cells: [
          {
            startBeat: 0,
            endBeat: 0.25,
            expectedSamples: 1,
            coveredSamples: 1,
            reason: null,
          },
          {
            startBeat: 0.25,
            endBeat: 0.5,
            expectedSamples: 1,
            coveredSamples: 0,
            reason: "insufficient-support",
          },
        ],
      },
    });
    expect(projectListeningFeaturePage(feature, 1, 1, 0)).toMatchObject({
      values: [null],
      cells: [{ reason: "insufficient-support" }],
      nextOffset: null,
    });
    const metadata = projectListeningFeatureRecord({
      ...recordFixture(),
      feature,
    }).feature;
    const page = projectListeningFeaturePage(feature, 1, 1, 0);
    expect(listeningFeaturePageMasksMatch(metadata, page)).toBe(true);
    expect(
      listeningFeaturePageMasksMatch(metadata, { ...page, values: [0] }),
    ).toBe(false);
  });

  it("pages independent channel support without leaking arrays or dropping signed descriptors", () => {
    const feature = listeningFeatureSchema.parse({
      ...peak(),
      type: "flatness-summary/v1",
      distanceDefinition: "euclidean-db/v1",
      units: "dB",
      distanceUnits: "dB",
      profile: "spectral-shape-profile/v1",
      profileKey: "synthetic-page-only",
      supportPolicy: "retained-overlap",
      values: [-120, -100],
      coveredSamples: 4000,
      expectedSamples: 4000,
      durationSeconds: 4000 / 48000,
      support: [[0, 4000]],
      channelSupport: [
        Array.from({ length: 703 }, (_, index) => [index * 4, index * 4 + 2]),
        Array.from({ length: 33 }, (_, index) => [
          index * 4 + 2,
          index * 4 + 4,
        ]),
      ],
      channelReasons: [null, null],
    });
    const before = structuredClone(feature);
    const metadata = projectListeningFeatureRecord({
      ...recordFixture(),
      feature,
    });
    expect(metadata.feature).not.toHaveProperty("channelSupport");
    expect(metadata.feature.channelSupportIntervalCounts).toEqual([703, 33]);
    expect(metadata.feature.channelReasons).toEqual([null, null]);
    expect(metadata.feature.distanceUnits).toBe("dB");
    expect(Buffer.byteLength(JSON.stringify(metadata))).toBeLessThan(4096);
    const page = projectListeningFeaturePage(feature, 0, 32, 32);
    expect(page.values).toEqual([-120, -100]);
    expect(page.channelSupportIntervals).toEqual([
      feature.channelSupport![0].slice(32, 64),
      feature.channelSupport![1].slice(32, 64),
    ]);
    expect(page.nextChannelSupportOffsets).toEqual([64, null]);
    expect(listeningFeaturePageMasksMatch(metadata.feature, page)).toBe(true);
    expect(
      listeningFeaturePageMasksMatch(metadata.feature, {
        ...page,
        values: [-120, null],
      }),
    ).toBe(false);
    expect(page.nextSupportOffset).toBeNull();
    expect(projectListeningFeaturePage(feature, 1, 32, 703)).toMatchObject({
      values: [],
      channelSupportIntervals: [[], []],
      nextChannelSupportOffsets: [null, null],
    });
    for (const change of [
      { nextChannelSupportOffsets: [32, null] },
      { totalChannelSupportIntervals: undefined },
      { channelSupportIntervals: [[], []] },
    ])
      expect(
        listeningFeaturePageSchema.safeParse({ ...page, ...change }).success,
      ).toBe(false);
    expect(feature).toEqual(before);
  });

  it("rejects a page whose vector width disagrees with its canonical feature type", async () => {
    const record = recordFixture();
    const response = contextOperationResultSchema.parse({
      action: "get-feature",
      feature: {
        record: projectListeningFeatureRecord(record),
        segment: {
          id: "segment",
          entryId: "entry",
          sessionId: "session",
          liveSetId: "set",
          order: 0,
          kind: "unaligned",
          coordinate: "transport-beats",
          startBeat: 0,
          endBeat: 1,
          startSample: 10000,
          endSample: 34000,
          sampleRate: 48000,
          alignmentReason: "musical-bar-alignment-not-established",
        },
        source: {
          contextId: "entry",
          passId: "pass",
          listenerId: "listener",
          subjectId: "subject",
          kind: "metric-audio-observation/v1",
          createdAt: record.createdAt,
          freshness: "unknown",
          summary: "Typed projection",
        },
      },
      page: projectListeningFeaturePage(record.feature, 0, 8, 0),
    });
    if (response.action !== "get-feature")
      throw new Error("Expected feature page");
    const executeContextOperation = vi.fn(async () => response);
    const [, tool] = createListeningTools({
      executeListeningOperation: async () => ({
        action: "inspect-listeners",
        listeners: [],
        truncated: false,
      }),
      executeContextOperation,
    });
    const params = contextOperationParamsSchema.parse({
      action: "get-feature",
      featureId: "feature",
    });
    const invocation = {
      sessionId: "sdk",
      toolCallId: "page",
      toolName: "ableton_context",
      arguments: params,
    };
    expect(await tool.handler?.(params, invocation)).toEqual(response);
    for (const change of [
      { dimensions: 1, values: [0] },
      { values: null },
      { values: [-1, 0] },
      { values: [65, 0] },
      { values: [null, 0] },
      {
        cells: [
          {
            startBeat: 0,
            endBeat: 0.25,
            expectedSamples: 1,
            coveredSamples: 1,
            reason: null,
          },
        ],
      },
    ]) {
      executeContextOperation.mockResolvedValueOnce({
        ...response,
        page: { ...response.page, ...change },
      });
      await expect(tool.handler?.(params, invocation)).rejects.toThrow(
        "Feature context result does not match request",
      );
    }
  });
});
