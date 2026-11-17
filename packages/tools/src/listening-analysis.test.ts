import { describe, expect, it, vi } from "vitest";
import {
  LISTENING_FEATURE_DEFINITIONS,
  extractListeningFeature,
  listeningFeatureDefinition,
  segmentListeningObservation,
} from "@ableton-agent/protocol";
import { createSyntheticMetricListeningObservation } from "@ableton-agent/protocol/testing";
import { createListeningTools } from "./listening-tools.js";
import {
  analysisOperationParamsSchema,
  LISTENING_FEATURE_CATALOG,
  projectListeningTimeline,
  projectListeningOverview,
  type ListeningAnalysisFeature,
} from "./listening-feature-views.js";

describe("musical listening contract", () => {
  it("replaces storage actions with read, compare and search", () => {
    expect(
      analysisOperationParamsSchema.options.map((s) => s.shape.action.value),
    ).toEqual(["read", "compare", "search"]);
    for (const action of ["derive-features", "list-features", "get-feature"])
      expect(analysisOperationParamsSchema.safeParse({ action }).success).toBe(
        false,
      );
    for (const definition of LISTENING_FEATURE_DEFINITIONS) {
      expect(LISTENING_FEATURE_CATALOG).toContain(definition.type);
      expect(LISTENING_FEATURE_CATALOG).toContain(definition.units);
    }
  });

  it("separates topK from scan and page budgets", () => {
    const target = {
      kind: "capture",
      sessionId: "session",
      liveSetId: "set",
      contextId: "capture",
      coordinate: "transport-beats",
      range: { startBeat: 0, endBeat: 4 },
    };
    const request = { action: "search", query: target, scope: [target] };
    expect(analysisOperationParamsSchema.parse(request)).toMatchObject({
      topK: 10,
    });
    for (const topK of [0, -1, 21, 1.5])
      expect(
        analysisOperationParamsSchema.safeParse({ ...request, topK }).success,
      ).toBe(false);
    expect(
      analysisOperationParamsSchema.safeParse({ ...request, topK: 20 }).success,
    ).toBe(true);
    expect(
      analysisOperationParamsSchema.parse({
        action: "read",
        target,
        detail: "original-measurements",
      }),
    ).toMatchObject({ action: "read", detail: "original-measurements" });
    expect(
      analysisOperationParamsSchema.safeParse({
        action: "read",
        target: { kind: "comparison", left: target, right: target },
        detail: "original-measurements",
      }).success,
    ).toBe(false);
    expect(
      analysisOperationParamsSchema.parse({
        action: "read",
        target: { kind: "comparison", left: target, right: target },
        detail: "evidence",
      }),
    ).toMatchObject({ action: "read", detail: "evidence" });
  });

  it("retains empty timelines rather than manufacturing a musical grid", () => {
    expect(projectListeningTimeline([], 0)).toEqual([]);
  });

  it("denies removed operations at the actual registered handler before dispatch", async () => {
    const executeContextOperation = vi.fn();
    const [, tool] = createListeningTools({
      executeContextOperation,
      executeListeningOperation: vi.fn(),
    });
    for (const action of [
      "derive-features",
      "list-features",
      "get-feature",
      "stream-overview",
      "report",
    ]) {
      await expect(
        tool.handler!({ action } as never, {
          sessionId: "sdk",
          toolName: "ableton_context",
          toolCallId: "call",
          arguments: { action },
        }),
      ).rejects.toThrow();
    }
    expect(executeContextOperation).not.toHaveBeenCalled();
  });

  it("aligns named canonical features, keeps summaries separate, and splits oversized rows without normalization", () => {
    const observation = createSyntheticMetricListeningObservation();
    const [segment] = segmentListeningObservation(observation, {
      version: 1,
      coordinate: "transport-beats",
      meter: { numerator: 4, denominator: 4 },
      barOriginBeat: 0,
      tempoBpm: observation.geometry.tempoBpm,
      tempoEvidence: "message-rate-monitored-constant",
      provenance: "capture-snapshot/v1",
    });
    const types = [
      "level-grid/v1",
      "centroid-grid/v1",
      "peak-summary/v1",
    ] as const;
    const views: ListeningAnalysisFeature[] = types.map((type) => ({
      segment: {
        ...segment!,
        id: "segment",
        entryId: "entry",
        sessionId: "session",
        liveSetId: "set",
        order: 0,
        startBeat: 8,
        endBeat: 8 + segment!.endBeat - segment!.startBeat,
      },
      record: {
        id: type.replace("/", "-"),
        entryId: "entry",
        segmentId: "segment",
        sessionId: "session",
        liveSetId: "set",
        sourceFingerprint: "a".repeat(64),
        createdAt: "2026-10-12T00:00:00.000Z",
        trace: {
          traceId: "00000000-0000-4000-8000-000000000001",
          correlationId: "call",
          causationId: "call",
        },
        feature: extractListeningFeature(type, observation, segment),
      },
    }));
    const rows = projectListeningTimeline(views, segment!.startSample);
    const first = rows.find((row) => row.kind === "interval")!;
    expect(first).toMatchObject({
      startBeat: 8,
      endBeat: 8.25,
      elapsedStartSeconds: 0,
    });
    expect(first.features.map(({ type }) => type)).toEqual([
      "level-grid/v1",
      "centroid-grid/v1",
    ]);
    expect(first.features[0]).not.toHaveProperty("featureId");
    expect(first.features[0]).not.toHaveProperty("readTarget");
    expect(first.supportCoordinate).toBe("segment-relative-samples");
    const support = views[0]!.record.feature.support.filter(
      ([start, end]) => end > 0 && start < 6000,
    );
    expect(first.features[0]!.supportExtent).toEqual([
      Math.min(...support.map(([start]) => start)),
      Math.max(...support.map(([, end]) => end)),
    ]);
    expect(rows.filter((row) => row.kind === "segment-summary")).toHaveLength(
      1,
    );
    expect(
      rows
        .filter((row) => row.kind === "interval")
        .every((row) =>
          row.features.every(({ type }) => type !== "peak-summary/v1"),
        ),
    ).toBe(true);
    const partialTarget = {
      kind: "capture" as const,
      sessionId: "session",
      liveSetId: "set",
      contextId: "entry",
      coordinate: "transport-beats" as const,
      range: { startBeat: 8.25, endBeat: 8.75 },
    };
    expect(
      projectListeningTimeline(views, segment!.startSample, partialTarget).some(
        (row) => row.kind === "segment-summary",
      ),
    ).toBe(false);
    expect(
      projectListeningTimeline(views, segment!.startSample, partialTarget).find(
        ({ kind }) => kind === "availability",
      )?.features,
    ).toMatchObject([
      {
        type: "peak-summary/v1",
        status: "unavailable",
        reason: "partial-segment-summary-not-aggregated",
        values: null,
      },
    ]);
    expect(
      projectListeningOverview(views, partialTarget).find(
        (item) => item.type === "peak-summary/v1",
      ),
    ).toMatchObject({
      validValues: 0,
      reason: "partial-segment-summary-not-aggregated",
    });
    expect(
      projectListeningOverview(views, {
        ...partialTarget,
        featureTypes: ["peak-summary/v1"],
      }).map(({ type }) => type),
    ).toEqual(["peak-summary/v1"]);
    const unaligned = segmentListeningObservation(observation)[0]!;
    const unavailable = structuredClone(views[0]!);
    unavailable.record.id = "unavailable-feature";
    unavailable.record.segmentId = "unavailable-segment";
    unavailable.record.feature = extractListeningFeature(
      "level-grid/v1",
      observation,
      unaligned,
    );
    unavailable.segment = {
      ...unavailable.segment,
      ...unaligned,
      id: "unavailable-segment",
      order: 1,
      startBeat: 9,
      endBeat: 10,
      startSample: views[0]!.segment.endSample,
      endSample:
        views[0]!.segment.endSample +
        (unaligned.endSample - unaligned.startSample),
      alignment: unaligned.alignment,
    };
    const mixedTarget = {
      ...partialTarget,
      range: { startBeat: 8, endBeat: 10 },
    };
    const mixed = projectListeningTimeline(
      [views[0]!, unavailable],
      segment!.startSample,
      mixedTarget,
    );
    expect(
      projectListeningOverview([views[0]!, unavailable], mixedTarget).find(
        ({ type }) => type === "level-grid/v1",
      ),
    ).toMatchObject({
      availableSegments: 1,
      totalSegments: 2,
      reason: null,
    });
    expect(mixed.find((row) => row.startBeat === 9)).toMatchObject({
      kind: "availability",
      startBeat: 9,
      endBeat: 10,
      features: [
        {
          type: "level-grid/v1",
          status: "unavailable",
          reason: "missing-alignment",
          values: null,
        },
      ],
    });
    expect(
      mixed.some((row) => row.kind === "interval" && row.startBeat >= 9),
    ).toBe(false);

    expect(
      rows.some(
        (row) => row.kind === "support" || row.kind === "feature-metadata",
      ),
    ).toBe(false);
    const evidence = projectListeningTimeline(
      views,
      segment!.startSample,
      undefined,
      "evidence",
    );
    expect(evidence.every((row) => row.features.length === 0)).toBe(true);
    const metadata = evidence.filter((row) => row.featureRecord !== undefined);
    expect(metadata.map((row) => row.featureRecord!.id)).toEqual(
      types.map((type) => type.replace("/", "-")),
    );
    for (const row of metadata) {
      expect(row.definition).toEqual(
        listeningFeatureDefinition(row.featureType!),
      );
      expect(row.segment).toMatchObject({
        id: "segment",
        entryId: "entry",
        sessionId: "session",
        liveSetId: "set",
        order: 0,
      });
      expect(row.featureRecord!.segmentId).toBe(row.segment.id);
      expect(row.featureRecord!.feature.valueCount).toBe(
        views.find(({ record }) => record.id === row.featureRecord!.id)!.record
          .feature.values?.length ?? 0,
      );
    }

    const wide = structuredClone(views[0]!);
    const melDefinition = listeningFeatureDefinition("mel-grid/v1");
    wide.record.feature.type = "mel-grid/v1";
    wide.record.feature.profile = melDefinition.profile;
    wide.record.feature.distanceDefinition = melDefinition.distanceDefinition;
    wide.record.feature.distanceUnits = melDefinition.distanceUnits;
    wide.record.feature.normalization = "joint-l2";
    wide.record.feature.units = "normalized-magnitude";
    wide.record.feature.values = Array.from(
      { length: wide.record.feature.grid!.cells.length * 48 },
      (_, index) => (index + 1) / Math.PI,
    );
    wide.record.feature.profileKey = "界".repeat(1024);
    wide.record.feature.limitations = Array.from({ length: 8 }, () =>
      "界".repeat(256),
    );
    const fragments = projectListeningTimeline([wide], segment!.startSample);
    const cells = fragments.filter((row) => row.kind === "interval");
    expect(cells.some((row) => row.fragmentCount! > 1)).toBe(true);
    expect(
      cells.flatMap((row) =>
        row.features.flatMap(({ values }) => values ?? []),
      ),
    ).toEqual(wide.record.feature.values);
    expect(
      cells.every((row) =>
        row.features.every(({ normalization }) => normalization === "joint-l2"),
      ),
    ).toBe(true);
    expect(
      projectListeningTimeline(
        [wide],
        segment!.startSample,
        undefined,
        "evidence",
      )
        .filter((row) => row.kind === "feature-metadata")
        .flatMap((row) => row.limitations ?? []),
    ).toEqual(wide.record.feature.limitations);
  });
});
