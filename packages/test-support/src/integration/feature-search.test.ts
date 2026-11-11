import { describe, expect, it } from "vitest";
import { VERIFIED_TOOL_RESULT_GUIDANCE } from "@ableton-agent/application";
import { readFile } from "node:fs/promises";
import {
  LISTENING_FEATURE_DEFINITIONS,
  metricAudioObservationSchema,
  createMetricObservationReportRows,
  pitchTimelineSchema,
  spectralShapeTimelineSchema,
  projectMetricListeningReport,
} from "@ableton-agent/protocol";
import { withSyntheticAnalyzerTimelines } from "@ableton-agent/protocol/testing";
import type { AgentHistoryPage } from "@ableton-agent/observability";
import { melSmokeFixture } from "./mel-smoke-test-support.js";
import {
  projectFeatureSource,
  validateFeatureSources,
  verifyFeatureSearch,
  projectFeatureSearchHistory,
} from "./feature-search.js";
import { createDefaultAssertions } from "./assertions.js";
import { validateFixture, validateScenario } from "./validation.js";
import type { AssertionInput, TurnEvidence } from "./contracts.js";

function fixture(
  reportPages = false,
  unavailableConfidence = false,
  reportRowLimit = 1,
  equalPeaks = false,
) {
  const base = melSmokeFixture();
  const baseTurn = { ...base.turn };
  delete baseTurn.melSmoke;
  const firstObservation = withSyntheticAnalyzerTimelines(
    metricAudioObservationSchema.parse(base.observation),
  );
  firstObservation.metrics.pitch = pitchTimelineSchema.parse({
    ...firstObservation.metrics.pitch,
    frames: firstObservation.metrics.pitch!.frames.map((frame) => ({
      ...frame,
      channels: [0.2, 0.3].map((confidence) =>
        unavailableConfidence
          ? { state: "silence", hz: null, confidence: null }
          : { state: "low-confidence", hz: 100, confidence },
      ),
    })),
  });
  firstObservation.metrics["spectral-shape"] =
    spectralShapeTimelineSchema.parse({
      ...firstObservation.metrics["spectral-shape"],
      frames: firstObservation.metrics["spectral-shape"]!.frames.map(
        (frame) => ({
          ...frame,
          channels: [
            { state: "valid", flatnessDb: -20, spreadHz: 500, rolloffHz: 1000 },
            { state: "valid", flatnessDb: -30, spreadHz: 600, rolloffHz: 1200 },
          ],
        }),
      ),
    });
  firstObservation.rows = createMetricObservationReportRows(firstObservation);
  const secondObservation = structuredClone(firstObservation);
  secondObservation.ownership.passId = "pass-2";
  secondObservation.ownership.traceId = "00000000-0000-4000-8000-000000000002";
  secondObservation.ownership.correlationId =
    secondObservation.ownership.traceId;
  if (!equalPeaks)
    for (const record of secondObservation.metrics.level.records)
      record.peak = [0.7, 0.3];
  secondObservation.rows = createMetricObservationReportRows(secondObservation);
  const observations = [firstObservation, secondObservation];
  const source1 = projectFeatureSource("context-1", firstObservation, false);
  const source2 = projectFeatureSource("context-2", secondObservation, false);
  const sources = [source1, source2];
  const views = sources.map((source, index) => ({
    record: {
      id: `feature-${index + 1}`,
      entryId: source.contextId,
      segmentId: `segment-${index + 1}`,
      sessionId: base.owner.appSessionId,
      liveSetId: "set",
      sourceFingerprint: source.contentSha256,
      feature: {
        ...canonicalMetadata("peak-summary/v1"),
        type: "peak-summary/v1",
        status: "ready",
        distanceDefinition: "euclidean-linear-amplitude/v1",
        distanceUnits: "linear-amplitude",
        coveredSamples: 90000,
        expectedSamples: 90000,
      },
    },
    segment: {
      id: `segment-${index + 1}`,
      entryId: source.contextId,
      sessionId: base.owner.appSessionId,
      liveSetId: "set",
      order: 0,
      kind: "unaligned",
      coordinate: "clip-local-beats",
      startBeat: 0,
      endBeat: 4,
      startSample: 0,
      endSample: 90000,
      sampleRate: 48000,
      alignmentReason: "musical-bar-alignment-not-established",
    },
    source: { contextId: source.contextId, passId: source.passId },
  }));
  const values = sources.map((source) => [
    Math.max(...source.records.map((r) => r.peak[0])),
    Math.max(...source.records.map((r) => r.peak[1])),
  ]);
  const analyzerValues = [
    ["pitch-confidence-summary/v1", [0.2, 0.3]],
    ["flatness-summary/v1", [-20, -30]],
    ["spread-summary/v1", [500, 600]],
    ["rolloff-summary/v1", [1000, 1200]],
  ] as const;
  const analyzerViews = views.map((view) =>
    analyzerValues.map(([type, values]) => {
      const definition = LISTENING_FEATURE_DEFINITIONS.find(
        (item) => item.type === type,
      )!;
      const unavailable =
        unavailableConfidence && type === "pitch-confidence-summary/v1";
      return {
        feature: {
          ...view,
          record: {
            ...view.record,
            id: `${view.record.id}-${type.split("/")[0]}`,
            feature: {
              type,
              status: unavailable ? "unavailable" : "ready",
              reason: unavailable ? "silence" : null,
              channelReasons: unavailable
                ? ["silence", "silence"]
                : [null, null],
              profile: definition.profile,
              units: definition.units,
              distanceDefinition: definition.distanceDefinition,
              distanceUnits: definition.distanceUnits,
              expectedSamples: 90000,
              coveredSamples: 43 * 2048,
            },
          },
        },
        page: {
          offset: 0,
          nextOffset: null,
          values: unavailable ? null : [...values],
        },
      };
    }),
  );
  const distance = Math.hypot(
    values[0]![0]! - values[1]![0]!,
    values[0]![1]! - values[1]![1]!,
  );
  const evidence = views.map((view) => ({
    contextId: view.record.entryId,
    segmentId: view.segment.id,
    startBeat: 0,
    endBeat: 4,
    coveredSamples: 90000,
    expectedSamples: 90000,
  }));
  const comparison = {
    action: "compare-features",
    comparisons: [
      {
        leftFeatureId: "feature-1",
        rightFeatureId: "feature-2",
        leftEvidence: evidence[0],
        rightEvidence: evidence[1],
        result: {
          status: "comparable",
          distanceDefinition: "euclidean-linear-amplitude/v1",
          units: "linear-amplitude",
          distance,
        },
      },
    ],
  };
  const search = {
    action: "search-features",
    query: views[0],
    matches: [{ feature: views[1], distance }],
    distanceDefinition: "euclidean-linear-amplitude/v1",
    distanceUnits: "linear-amplitude",
    scannedCount: 1,
    comparableCount: 1,
    eligibleCount: 1,
    excludedCount: 1,
    exhaustive: true,
    limitsHit: [],
    exclusionReasons: { "source-excluded": 1 },
  };
  const turns = [0, 1, 2].map((index): TurnEvidence => {
    const records: AgentHistoryPage["items"] = [];
    const sdkTurnId = `00000000-0000-4000-8000-00000000000${index + 1}`;
    const recordBase = {
      version: 1 as const,
      appSessionId: base.owner.appSessionId,
      agentSessionId: base.owner.conversationId,
      activeAgentId: base.owner.agentId,
      turnId: sdkTurnId,
      traceId: sdkTurnId,
      causationId: sdkTurnId,
      occurredAt: "2026-11-05T00:00:02.000Z",
      recordedAt: "2026-11-05T00:00:02.000Z",
    };
    const pair = (
      toolName: string,
      args: Record<string, unknown>,
      data: Record<string, unknown>,
    ) => {
      if (reportPages && args.action === "get") {
        const observation = metricAudioObservationSchema.parse(
          data.observation,
        );
        let offset: number | null = 0;
        while (offset !== null) {
          const report = projectMetricListeningReport(observation, {
            offset,
            limit: reportRowLimit,
          });
          pair(
            toolName,
            { ...args, action: "report", offset, limit: reportRowLimit },
            { action: "report", entry: data.entry, report },
          );
          offset = report.nextOffset;
        }
        return;
      }
      const toolCallId = `tool-${records.length}`;
      records.push(
        {
          ...recordBase,
          correlationId: toolCallId,
          kind: "tool_call",
          id: `${sdkTurnId}-${toolCallId}-call`,
          toolCallId,
          toolName,
          arguments: args,
          status: "completed",
          metadata: {},
        },
        {
          ...recordBase,
          correlationId: toolCallId,
          kind: "tool_result",
          id: `${sdkTurnId}-${toolCallId}-result`,
          toolCallId,
          outcome: "success",
          durationMs: 1,
          result: { result: { content: data } },
          metadata: { toolName },
        },
      );
    };
    if (index < 2) {
      pair(
        "ableton_listening",
        {
          action: "play-session-and-listen",
          target:
            firstObservation.source.view === "session"
              ? firstObservation.source.target
              : null,
          listenerIds: ["listener"],
        },
        {
          action: "play-session-and-listen",
          job: {
            stage: "completed",
            passId: sources[index]!.passId,
            contextIds: [sources[index]!.contextId],
          },
        },
      );
      pair(
        "ableton_context",
        { action: "get", contextId: sources[index]!.contextId },
        {
          action: "get",
          entry: {
            contextId: sources[index]!.contextId,
            passId: sources[index]!.passId,
          },
          observation: observations[index],
        },
      );
      pair(
        "ableton_context",
        { action: "list-features", contextId: sources[index]!.contextId },
        { action: "list-features", features: [views[index]] },
      );
    }
    if (index === 2)
      for (const [sourceIndex, source] of sources.entries())
        pair(
          "ableton_context",
          { action: "get", contextId: source.contextId },
          {
            action: "get",
            entry: { contextId: source.contextId, passId: source.passId },
            observation: observations[sourceIndex],
          },
        );
    if (index === 1)
      pair(
        "ableton_context",
        {
          action: "derive-features",
          contextIds: [sources[1]!.contextId],
          includeHistorical: false,
        },
        {
          action: "derive-features",
          derivations: [
            {
              entryId: sources[1]!.contextId,
              definitionSet: "qualified-listening/v1",
              status: "ready",
              reason: null,
              featureCount: 15,
            },
          ],
        },
      );
    for (const [viewIndex, view] of views
      .slice(0, index === 0 ? 1 : 2)
      .entries())
      pair(
        "ableton_context",
        { action: "get-feature", featureId: view.record.id },
        {
          action: "get-feature",
          feature: view,
          page: { offset: 0, nextOffset: null, values: values[viewIndex] },
        },
      );
    for (const sourceFeatures of analyzerViews.slice(0, index === 0 ? 1 : 2))
      for (const feature of sourceFeatures)
        pair(
          "ableton_context",
          { action: "get-feature", featureId: feature.feature.record.id },
          { action: "get-feature", ...structuredClone(feature) },
        );
    if (index > 0)
      pair(
        "ableton_context",
        {
          action: "compare-features",
          pairs: [{ leftFeatureId: "feature-1", rightFeatureId: "feature-2" }],
        },
        structuredClone(comparison),
      );
    if (index === 1) {
      pair(
        "ableton_context",
        {
          action: "search-features",
          featureId: "feature-1",
          excludeContextIds: ["context-1"],
        },
        search,
      );
      pair(
        "ableton_context",
        { action: "feature-definitions" },
        {
          action: "feature-definitions",
          definitions: LISTENING_FEATURE_DEFINITIONS,
        },
      );
      pair(
        "ableton_context",
        { action: "list-features" },
        {
          action: "list-features",
          features: [
            ...views.map((view) => ({
              ...view,
              record: {
                ...view.record,
                id: `${view.record.id}-pitch`,
                feature: {
                  ...canonicalMetadata("pitch-grid/v1"),
                  type: "pitch-grid/v1",
                  status: "unavailable",
                  reason: "missing-alignment",
                },
              },
            })),
            {
              ...views[1],
              record: {
                ...views[1]!.record,
                id: `${views[1]!.record.id}-level`,
                feature: {
                  ...canonicalMetadata("level-grid/v1"),
                  type: "level-grid/v1",
                  status: "unavailable",
                  reason: "missing-alignment",
                },
              },
            },
          ],
        },
      );
    }
    records.push(
      {
        ...recordBase,
        id: `${sdkTurnId}-answer`,
        correlationId: sdkTurnId,
        kind: "message",
        role: "assistant",
        content: "Measured.",
        messageIndex: 1,
        occurredAt: "2026-11-05T00:00:03.000Z",
        metadata: {},
      },
      {
        ...recordBase,
        id: `${sdkTurnId}-terminal`,
        correlationId: sdkTurnId,
        kind: "turn",
        status: "completed",
        occurredAt: "2026-11-05T00:00:00.000Z",
        completedAt: "2026-11-05T00:00:04.000Z",
        metadata: {},
      },
    );
    return {
      ...baseTurn,
      userMessageId: `user-${index}`,
      assistantMessageId: `assistant-${index}`,
      operationId: `operation-${index}`,
      captures:
        index === 2
          ? []
          : [
              {
                ...base.turn.captures[0]!,
                metricFamilies: [...firstObservation.requestedMetrics],
                passId: sources[index]!.passId,
                native: {
                  generation: base.owner.sdkTurnId,
                  connectionId: base.owner.sdkTurnId,
                  connectionEpoch: base.owner.sdkTurnId,
                  nativeEpoch: 1,
                },
              },
            ],
      contexts: sources.slice(0, index === 0 ? 1 : 2).map((source) => ({
        ...base.turn.contexts[0]!,
        contextId: source.contextId,
        passId: source.passId,
        contentSha256: source.contentSha256,
        afterOwnedRestart: index === 2,
      })),
      featureSources: sources
        .slice(0, index === 0 ? 1 : 2)
        .map((source) => ({ ...source, afterOwnedRestart: index === 2 })),
      facts: { sdkTurnId },
      agentListening: {
        ...base.owner,
        sdkTurnId,
        afterOwnedRestart: index === 2,
        records,
      },
    };
  });
  const input: AssertionInput = {
    ...base.input,
    turns,
    turn: turns[2]!,
    evidence: {
      schemaVersion: 1,
      facts: {},
      contexts: turns[2]!.contexts,
      unchanged: [],
      capturePassIds: sources.map((source) => source.passId),
      featureSources: turns[2]!.featureSources!,
      setupActions: (["stop-transport", "restart-owned-desktop"] as const).map(
        (action, index) => ({
          ...base.owner,
          action,
          stepId: `step-${index}`,
          completed: true,
          traceId: "trace",
          correlationId: "correlation",
          causationId: "cause",
          ...(action === "stop-transport"
            ? {
                transport: {
                  command: "transport.set_playing" as const,
                  dispatchedCount: 1 as const,
                  beforePlaying: true,
                  afterPlaying: false as const,
                  verified: true as const,
                },
              }
            : {}),
        }),
      ),
    },
  };
  return { input, turns, search, comparison };
}
function result(turn: TurnEvidence, action: string) {
  const found = turn.agentListening!.records.find(
    (record) =>
      record.kind === "tool_result" &&
      (record.result?.result as { content?: { action?: string } })?.content
        ?.action === action,
  );
  if (!found || found.kind !== "tool_result")
    throw new Error("Missing synthetic result");
  return (found.result!.result as { content: Record<string, unknown> }).content;
}
function analyzerResult(turn: TurnEvidence, type: string) {
  for (const record of turn.agentListening!.records) {
    if (record.kind !== "tool_result") continue;
    const data = (
      record.result?.result as { content?: Record<string, unknown> }
    )?.content;
    if (
      data?.action === "get-feature" &&
      (data.feature as { record: { feature: { type: string } } }).record.feature
        .type === type
    )
      return data as {
        feature: {
          record: {
            id: string;
            feature: {
              type: string;
              status: string;
              channelReasons: (string | null)[];
            };
          };
        };
        page: { values: (number | null)[] };
      };
  }
  throw new Error("Missing synthetic analyzer feature");
}
function peakFixture(equalPeaks = false) {
  const full = fixture(false, false, 1, equalPeaks);
  const turns = full.turns.slice(0, 2);
  for (const [index, turn] of turns.entries()) {
    const omitted = new Set<string>();
    for (const record of turn.agentListening!.records) {
      if (record.kind !== "tool_result") continue;
      const data = (
        record.result?.result as {
          content: {
            action: string;
            feature?: { record: { feature: { type: string } } };
            features?: { record: { feature: { type: string } } }[];
          };
        }
      ).content;
      if (
        data.action === "feature-definitions" ||
        (data.action === "get-feature" &&
          data.feature?.record.feature.type !== "peak-summary/v1") ||
        (data.action === "list-features" &&
          !data.features?.some(
            (feature) => feature.record.feature.type === "peak-summary/v1",
          ))
      )
        omitted.add(record.toolCallId);
    }
    Object.assign(turn.agentListening!, {
      records: turn.agentListening!.records.filter(
        (record) =>
          !("toolCallId" in record) ||
          record.toolCallId === undefined ||
          !omitted.has(record.toolCallId),
      ),
    });
    Object.assign(turn, {
      featureSources: turn.featureSources!.map((source) => {
        const copy = { ...source };
        delete copy.analyzers;
        return copy;
      }),
      captures: turn.captures.map((capture) => ({
        ...capture,
        operationId: turn.operationId,
        native: {
          ...capture.native!,
          generation: turn.facts.sdkTurnId,
          nativeEpoch: index + 1,
        },
      })),
    });
  }
  const input: AssertionInput = {
    ...full.input,
    turns,
    turn: turns[1]!,
    evidence: {
      ...full.input.evidence!,
      contexts: turns[1]!.contexts,
      featureSources: turns[1]!.featureSources!,
      setupActions: full.input.evidence!.setupActions!.slice(0, 1),
      unchanged: [
        "session-structure",
        "source-settings",
        "fixture-media",
        "unrelated-playback",
      ].map((scope) => ({
        scope,
        beforeSha256: "a".repeat(64),
        afterSha256: "a".repeat(64),
      })),
    },
  };
  return { input, turns };
}
function omitTool(turn: TurnEvidence, action: string, featureId?: string) {
  const records = turn.agentListening!.records;
  const omitted = new Set(
    records
      .filter(
        (record) =>
          record.kind === "tool_call" &&
          record.arguments.action === action &&
          (featureId === undefined || record.arguments.featureId === featureId),
      )
      .map((record) =>
        "toolCallId" in record ? record.toolCallId : undefined,
      ),
  );
  Object.assign(turn.agentListening!, {
    records: records.filter(
      (record) => !("toolCallId" in record) || !omitted.has(record.toolCallId),
    ),
  });
}
function priorPeakFixture() {
  const value = peakFixture();
  omitTool(value.turns[1]!, "get-feature", "feature-1");
  return value;
}
function canonicalMetadata(type: string) {
  const definition = LISTENING_FEATURE_DEFINITIONS.find(
    (item) => item.type === type,
  )!;
  const unavailable = definition.grid;
  const channelAware = [
    "pitch-profile/v1",
    "spectral-shape-profile/v1",
  ].includes(definition.profile);
  return {
    type,
    profile: definition.profile,
    units: definition.units,
    distanceDefinition: definition.distanceDefinition,
    distanceUnits: definition.distanceUnits,
    normalization: definition.normalization,
    status: unavailable ? "unavailable" : "ready",
    reason: unavailable ? "missing-alignment" : null,
    coveredSamples: 90000,
    expectedSamples: 90000,
    durationSeconds: 1.875,
    sampleRate: 48000,
    supportPolicy: definition.grid
      ? "matching-cell-mask"
      : type === "peak-summary/v1"
        ? "complete-required"
        : "retained-overlap",
    valueCount: unavailable ? 0 : definition.dimensions,
    supportIntervalCount: 1,
    grid: null,
    ...(channelAware
      ? { channelSupportIntervalCounts: [1, 1], channelReasons: [null, null] }
      : {}),
  };
}
function completeInventory(turn: TurnEvidence) {
  const inventory = result(turn, "list-features");
  const original = (
    inventory.features as { record: { id: string; feature: unknown } }[]
  )[0]!;
  inventory.features = LISTENING_FEATURE_DEFINITIONS.map((definition) => {
    const feature = structuredClone(original);
    if (definition.type !== "peak-summary/v1")
      feature.record.id += `-${definition.type.split("/")[0]}`;
    feature.record.feature = canonicalMetadata(definition.type);
    return feature;
  });
}
function equalityFixture(coverage: "full" | "peak-only") {
  const value =
    coverage === "full" ? fixture(false, false, 1, true) : peakFixture(true);
  for (const id of firstFeatureIds)
    omitTool(value.turns[1]!, "get-feature", id);
  omitTool(value.turns[1]!, "get-feature", "feature-2");
  if (coverage === "full") {
    completeInventory(value.turns[1]!);
    omitTool(value.turns[1]!, "feature-definitions");
  }
  return value;
}
describe.each(["full", "peak-only"] as const)(
  "evidence-established peaks (%s)",
  (coverage) => {
    it("accepts exact equality and canonical discovery without inventing calls or altering History", () => {
      const { input, turns } = equalityFixture(coverage);
      const history = JSON.stringify(turns);
      expect(() => verifyFeatureSearch(input, "final", coverage)).not.toThrow();
      expect(JSON.stringify(turns)).toBe(history);
    });
    it("independently rejects a false zero comparison between genuinely unequal measured vectors", () => {
      const { input, turns } = coverage === "full" ? fixture() : peakFixture();
      omitTool(turns[1]!, "get-feature", "feature-2");
      (
        result(turns[1]!, "compare-features").comparisons as {
          result: { distance: number };
        }[]
      )[0]!.result.distance = 0;
      (
        result(turns[1]!, "search-features").matches as { distance: number }[]
      )[0]!.distance = 0;
      expect(() => verifyFeatureSearch(input, "final", coverage)).toThrow(
        "exact peak equality",
      );
    });
    it.each([
      "nonzero",
      "tiny-nonzero",
      "missing-comparison",
      "missing-search",
      "source",
      "identity",
      "range",
      "units",
      "normalization",
      "corrupt-source",
      "bad-direct-read",
      "foreign-owner",
      "inventory-request",
    ] as const)(
      "rejects insufficient or contradictory equality evidence (%s)",
      (mode) => {
        const { input, turns } = equalityFixture(coverage);
        const second = turns[1]!;
        const comparison = (
          result(second, "compare-features").comparisons as {
            rightFeatureId: string;
            result: { distance: number };
          }[]
        )[0]!;
        const search = result(second, "search-features");
        const match = (
          search.matches as {
            feature: {
              source: { passId: string };
              record: { id: string; feature: Record<string, unknown> };
              segment: { startSample: number };
            };
          }[]
        )[0]!;
        match.feature = structuredClone(match.feature);
        if (mode === "nonzero") comparison.result.distance = 1;
        if (mode === "tiny-nonzero") comparison.result.distance = 1e-14;
        if (mode === "missing-comparison") omitTool(second, "compare-features");
        if (mode === "missing-search") omitTool(second, "search-features");
        if (mode === "source") match.feature.source.passId = "foreign";
        if (mode === "identity") comparison.rightFeatureId = "foreign";
        if (mode === "range") match.feature.segment.startSample++;
        if (mode === "units") match.feature.record.feature.units = "Hz";
        if (mode === "normalization")
          match.feature.record.feature.normalization = "joint-l2";
        if (mode === "foreign-owner")
          second.agentListening!.records[0]!.appSessionId = "foreign";
        if (mode === "inventory-request")
          for (const record of second.agentListening!.records)
            if (
              record.kind === "tool_call" &&
              record.arguments.action === "list-features"
            )
              record.arguments.contextId = "foreign";
        if (mode === "corrupt-source")
          Object.assign(second.featureSources![1]!.records[0]!, {
            peak: [20, 20],
          });
        if (mode === "bad-direct-read") {
          const fresh =
            coverage === "full"
              ? fixture(false, false, 1, true)
              : peakFixture(true);
          const records = fresh.turns[1]!.agentListening!.records;
          const call = records.find(
            (record) =>
              record.kind === "tool_call" &&
              record.arguments.featureId === "feature-2",
          )!;
          const direct = records.filter(
            (record) =>
              "toolCallId" in record &&
              record.toolCallId === (call as { toolCallId: string }).toolCallId,
          );
          const response = direct.find(
            (record) => record.kind === "tool_result",
          )!;
          (
            response.result!.result as {
              content: { page: { values: number[] } };
            }
          ).content.page.values = [42, 42];
          second.agentListening!.records.push(...direct);
        }
        expect(() => verifyFeatureSearch(input, "final", coverage)).toThrow();
      },
    );
  },
);
describe("inventory discovery and equality persistence", () => {
  it("establishes target metadata from genuine search when only the first peak appears in the inventory", () => {
    const { input, turns } = equalityFixture("peak-only");
    const second = turns[1]!;
    result(second, "list-features").features = [
      result(second, "search-features").query,
    ];
    for (const record of second.agentListening!.records)
      if (
        record.kind === "tool_call" &&
        record.arguments.action === "list-features"
      )
        record.arguments.contextId = "context-1";
    expect(() =>
      verifyFeatureSearch(input, "final", "peak-only"),
    ).not.toThrow();
  });
  it("accepts complete canonical inventory without a catalog even for unequal directly-read peaks", () => {
    const { input, turns } = fixture();
    completeInventory(turns[1]!);
    omitTool(turns[1]!, "feature-definitions");
    expect(() => verifyFeatureSearch(input, "final")).not.toThrow();
  });
  it.each([
    "missing-type",
    "duplicate-type",
    "profile",
    "units",
    "distance",
    "normalization",
    "status",
    "reason",
    "count",
    "sample-rate",
    "source",
    "hash",
    "range",
    "session",
    "bad-catalog",
  ] as const)("rejects incomplete or invalid discovery (%s)", (mode) => {
    const { input, turns } = equalityFixture("full");
    const inventory = result(turns[1]!, "list-features");
    const features = inventory.features as {
      record: {
        sessionId: string;
        sourceFingerprint: string;
        feature: Record<string, unknown>;
      };
      source: { passId: string };
      segment: { endSample: number };
    }[];
    const feature = features.find(
      (feature) => feature.record.feature.type === "mel-shape/v1",
    )!;
    if (mode === "missing-type") features.splice(features.indexOf(feature), 1);
    if (mode === "duplicate-type")
      features[features.indexOf(feature)] = features[0]!;
    if (mode === "profile")
      feature.record.feature.profile = "sample-grid-peak-rms/v1";
    if (mode === "units") feature.record.feature.units = "Hz";
    if (mode === "distance")
      feature.record.feature.distanceDefinition = "rms-hz/v1";
    if (mode === "normalization") feature.record.feature.normalization = "none";
    if (mode === "status") feature.record.feature.status = "failed";
    if (mode === "reason") feature.record.feature.reason = "missing-alignment";
    if (mode === "count") feature.record.feature.valueCount = 0;
    if (mode === "sample-rate") feature.record.feature.sampleRate = 44100;
    if (mode === "source") feature.source.passId = "foreign";
    if (mode === "hash") feature.record.sourceFingerprint = "b".repeat(64);
    if (mode === "range") feature.segment.endSample++;
    if (mode === "session") feature.record.sessionId = "foreign";
    if (mode === "bad-catalog") {
      const donor = fixture().turns[1]!;
      const call = donor.agentListening!.records.find(
        (record) =>
          record.kind === "tool_call" &&
          record.arguments.action === "feature-definitions",
      )!;
      result(donor, "feature-definitions").definitions = [];
      turns[1]!.agentListening!.records.push(
        ...donor.agentListening!.records.filter(
          (record) =>
            "toolCallId" in record &&
            record.toolCallId === (call as { toolCallId: string }).toolCallId,
        ),
      );
    }
    expect(() => verifyFeatureSearch(input, "final")).toThrow();
  });
  it.each([
    "missing",
    "identity",
    "metadata",
    "values",
    "source",
    "cached",
  ] as const)(
    "requires fresh unchanged equality-established target after restart (%s)",
    (mode) => {
      const { input, turns } = equalityFixture("full");
      const restored = turns[2]!;
      if (mode === "missing") omitTool(restored, "get-feature", "feature-2");
      else if (mode === "cached")
        Object.assign(restored.agentListening!, { afterOwnedRestart: false });
      else {
        const read = restored.agentListening!.records.find(
          (record) =>
            record.kind === "tool_result" &&
            (
              record.result?.result as {
                content?: { feature?: { record: { id: string } } };
              }
            )?.content?.feature?.record.id === "feature-2",
        )!;
        if (read.kind !== "tool_result")
          throw new Error("Missing restored read");
        const data = (
          read.result!.result as {
            content: {
              feature: {
                record: { id: string; feature: Record<string, unknown> };
                source: { passId: string };
              };
              page: { values: number[] };
            };
          }
        ).content;
        data.feature = structuredClone(data.feature);
        if (mode === "identity") {
          data.feature.record.id = "new-feature";
          for (const record of restored.agentListening!.records)
            if (
              record.kind === "tool_call" &&
              record.arguments.featureId === "feature-2"
            )
              record.arguments.featureId = "new-feature";
          (
            result(restored, "compare-features").comparisons as {
              rightFeatureId: string;
            }[]
          )[0]!.rightFeatureId = "new-feature";
          for (const record of restored.agentListening!.records)
            if (
              record.kind === "tool_call" &&
              record.arguments.action === "compare-features"
            )
              record.arguments.pairs = [
                { leftFeatureId: "feature-1", rightFeatureId: "new-feature" },
              ];
        }
        if (mode === "metadata")
          data.feature.record.feature.supportIntervalCount = 2;
        if (mode === "values") data.page.values = [10, 10];
        if (mode === "source") data.feature.source.passId = "different-pass";
      }
      expect(() => verifyFeatureSearch(input, "restored")).toThrow();
    },
  );
});
describe("same-session peak fundamentals coverage", () => {
  it("accepts a prior immutable typed first-feature read, with genuine second-turn read/comparison/search", () => {
    const { input } = priorPeakFixture();
    expect(() =>
      verifyFeatureSearch(input, "second", "peak-only"),
    ).not.toThrow();
    expect(() =>
      verifyFeatureSearch(input, "final", "peak-only"),
    ).not.toThrow();
  });
  it("does not carry prior reads into the restored turn", () => {
    const { input, turns } = fixture();
    omitTool(turns[2]!, "get-feature", "feature-1");
    expect(() => verifyFeatureSearch(input, "final")).toThrow(
      "missing typed peak",
    );
  });
  it("cannot replace the first turn's genuine read with a later read", () => {
    const { input, turns } = peakFixture();
    omitTool(turns[0]!, "get-feature");
    expect(() => verifyFeatureSearch(input, "second", "peak-only")).toThrow(
      "missing typed peak",
    );
  });
  it.each([
    "app-session",
    "agent",
    "conversation",
    "raw-owner",
    "wrong-feature",
    "first-read",
    "first-call",
    "first-result",
    "second-read",
    "comparison",
    "search",
    "swapped-history",
    "swapped-source",
    "swapped-comparison",
    "query-provenance",
    "query-metadata",
    "match-provenance",
    "first-values",
  ] as const)("rejects invalid prior-read evidence (%s)", (mode) => {
    const { input, turns } = priorPeakFixture();
    const first = turns[0]!;
    const second = turns[1]!;
    if (mode === "app-session")
      Object.assign(first, { appSessionId: "foreign" });
    if (mode === "agent") Object.assign(first, { agentId: "foreign" });
    if (mode === "conversation")
      Object.assign(first, { conversationId: "foreign" });
    if (mode === "raw-owner")
      Object.assign(first.agentListening!.records[0]!, {
        appSessionId: "00000000-0000-4000-8000-000000000099",
      });
    if (mode === "wrong-feature")
      for (const record of first.agentListening!.records)
        if (
          record.kind === "tool_call" &&
          record.arguments.action === "get-feature"
        )
          record.arguments.featureId = "different-feature";
    if (mode === "first-read") omitTool(first, "get-feature");
    if (mode === "first-call")
      Object.assign(first.agentListening!, {
        records: first.agentListening!.records.filter(
          (record) =>
            record.kind !== "tool_call" ||
            record.arguments.action !== "get-feature",
        ),
      });
    if (mode === "first-result")
      Object.assign(first.agentListening!, {
        records: first.agentListening!.records.filter(
          (record) =>
            record.kind !== "tool_result" ||
            (record.result?.result as { content?: { action?: string } })
              ?.content?.action !== "get-feature",
        ),
      });
    if (mode === "second-read") omitTool(second, "get-feature");
    if (mode === "comparison") omitTool(second, "compare-features");
    if (mode === "search") omitTool(second, "search-features");
    if (mode === "swapped-history") {
      const history = first.agentListening;
      Object.assign(first, { agentListening: second.agentListening });
      Object.assign(second, { agentListening: history });
    }
    if (mode === "swapped-source")
      Object.assign(second, {
        featureSources: [...second.featureSources!].reverse(),
      });
    if (mode === "swapped-comparison") {
      const comparison = (
        result(second, "compare-features").comparisons as {
          leftEvidence: unknown;
          rightEvidence: unknown;
        }[]
      )[0]!;
      [comparison.leftEvidence, comparison.rightEvidence] = [
        comparison.rightEvidence,
        comparison.leftEvidence,
      ];
    }
    if (mode === "query-provenance" || mode === "query-metadata") {
      const search = result(second, "search-features");
      const query = structuredClone(search.query) as {
        record: { sourceFingerprint: string; feature: { profile: string } };
      };
      search.query = query;
      if (mode === "query-provenance")
        query.record.sourceFingerprint = "c".repeat(64);
      else query.record.feature.profile = "different-profile";
    }
    if (mode === "match-provenance") {
      const search = result(second, "search-features");
      const matches = structuredClone(search.matches) as {
        feature: { source: { passId: string } };
      }[];
      search.matches = matches;
      matches[0]!.feature.source.passId = "different-pass";
    }
    if (mode === "first-values")
      (result(first, "get-feature").page as { values: number[] }).values = [
        10, 20,
      ];
    expect(() => verifyFeatureSearch(input, "second", "peak-only")).toThrow();
    expect(() => verifyFeatureSearch(input, "final", "peak-only")).toThrow();
  });
  it("rejects changed first-feature content on a second-turn reread", () => {
    const { input, turns } = peakFixture();
    const read = result(turns[1]!, "get-feature");
    const feature = structuredClone(read.feature) as {
      record: { feature: { profile: string } };
    };
    read.feature = feature;
    feature.record.feature.profile = "different-profile";
    expect(() => verifyFeatureSearch(input, "second", "peak-only")).toThrow();
  });
  it("verifies exactly two ordinary captures without catalog/analyzer reads or restart", () => {
    const { input, turns } = peakFixture();
    expect(() =>
      verifyFeatureSearch(input, "final", "peak-only"),
    ).not.toThrow();
    expect(
      turns.every((turn) => turn.captures[0]!.metricFamilies.length === 6),
    ).toBe(true);
    expect(() => verifyFeatureSearch(input, "final")).toThrow();
    expect(() => validateFeatureSources(turns[0]!.featureSources)).toThrow(
      "analyzer",
    );
  });
  it("keeps full projection strict by default without changing the observation or capture request", () => {
    const observation = melSmokeFixture().observation;
    const original = JSON.stringify(observation);
    expect(
      projectFeatureSource("context", observation, false, "peak-only")
        .analyzers,
    ).toBeUndefined();
    expect(() => projectFeatureSource("context", observation, false)).toThrow(
      "metric family",
    );
    expect(JSON.stringify(observation)).toBe(original);
  });
  it("admits the registered peak scope while preserving the original full/restart contract", async () => {
    const root = new URL("../../../../integration/", import.meta.url);
    const read = async (path: string): Promise<unknown> =>
      JSON.parse(await readFile(new URL(path, root), "utf8")) as unknown;
    const fixtureManifest = await read(
      "fixtures/session-clip-identify/fixture.json",
    );
    const scenario = await read(
      "acceptance-scenarios/session-listening-peak-smoke.json",
    );
    const original = await read(
      "acceptance-scenarios/session-listening-feature-search.json",
    );
    const registry = createDefaultAssertions();
    validateFixture(fixtureManifest);
    validateScenario(scenario, fixtureManifest, registry.names);
    validateScenario(original, fixtureManifest, registry.names);
    expect(scenario.requiredCapabilities).not.toContain("persistence");
    expect(scenario.steps).toHaveLength(2);
    expect(scenario.steps.flatMap((step) => step.setupActions ?? [])).toEqual([
      "stop-transport",
    ]);
    expect(original.requiredCapabilities).toContain("persistence");
    expect(original.steps).toHaveLength(3);
    expect(original.steps[2]!.setupActions).toEqual(["restart-owned-desktop"]);
    expect(original.steps.map((step) => step.timeoutMs)).toEqual([
      150_000, 180_000, 300_000,
    ]);
    expect(original.budget.runMs).toBe(
      original.steps.reduce((total, step) => total + step.timeoutMs, 0) +
        30_000,
    );
    expect(
      [
        ...original.assertions,
        ...original.steps.flatMap((step) => step.assertions),
      ]
        .filter((assertion) => assertion.name === "feature-search")
        .every((assertion) => assertion.parameters.coverage === undefined),
    ).toBe(true);
    const { input, turns } = peakFixture();
    for (const [index, step] of scenario.steps.entries())
      for (const assertion of step.assertions)
        expect(
          registry.evaluate(assertion, {
            ...input,
            turns: turns.slice(0, index + 1),
            turn: turns[index]!,
          }).passed,
        ).toBe(true);
    for (const assertion of scenario.assertions)
      expect(registry.evaluate(assertion, input).passed).toBe(true);
    expect(() =>
      registry.validate({
        name: "feature-search",
        parameters: { phase: "restored", coverage: "peak-only" },
      }),
    ).toThrow();
    expect(() =>
      registry.validate({
        name: "feature-search",
        parameters: { phase: "final", coverage: "peaks" },
      }),
    ).toThrow();
  });
  it.each([
    "distance",
    "exclusion",
    "self-match",
    "owner",
    "restart",
    "capture-cleanup",
    "extra-capture",
    "source-hash",
  ] as const)("rejects broken same-session peak evidence (%s)", (mode) => {
    const { input, turns } = peakFixture();
    if (mode === "distance")
      (
        result(turns[1]!, "compare-features").comparisons as {
          result: { distance: number };
        }[]
      )[0]!.result.distance = 100;
    if (mode === "exclusion")
      for (const record of turns[1]!.agentListening!.records)
        if (
          record.kind === "tool_call" &&
          record.arguments.action === "search-features"
        )
          record.arguments.excludeContextIds = [];
    if (mode === "self-match") {
      const search = result(turns[1]!, "search-features");
      (search.matches as { feature: unknown }[])[0]!.feature = search.query;
    }
    if (mode === "owner") Object.assign(turns[1]!, { agentId: "foreign" });
    if (mode === "restart")
      Object.assign(turns[1]!.agentListening!, { afterOwnedRestart: true });
    if (mode === "capture-cleanup")
      Object.assign(turns[1]!.captures[0]!, { cleanupComplete: false });
    if (mode === "extra-capture")
      Object.assign(turns[1]!, {
        captures: [...turns[1]!.captures, turns[0]!.captures[0]!],
      });
    if (mode === "source-hash")
      Object.assign(turns[1]!.featureSources![0]!, {
        contentSha256: "c".repeat(64),
      });
    expect(() => verifyFeatureSearch(input, "final", "peak-only")).toThrow();
  });
  it("retains final native freshness and protected fixture assertions", () => {
    const { input, turns } = peakFixture();
    const registry = createDefaultAssertions();
    Object.assign(turns[1]!.captures[0]!.native!, { nativeEpoch: 1 });
    expect(
      registry.evaluate({ name: "native-freshness", parameters: {} }, input)
        .passed,
    ).toBe(false);
    Object.assign(input.evidence!.unchanged[0]!, {
      afterSha256: "b".repeat(64),
    });
    expect(
      registry.evaluate(
        { name: "unchanged", parameters: { scopes: "session-structure" } },
        input,
      ).passed,
    ).toBe(false);
  });
});
const firstFeatureIds = [
  "feature-1",
  "feature-1-pitch-confidence-summary",
  "feature-1-flatness-summary",
  "feature-1-spread-summary",
  "feature-1-rolloff-summary",
];
function priorFullFixture() {
  const value = fixture(true, false, 32);
  for (const id of firstFeatureIds)
    omitTool(value.turns[1]!, "get-feature", id);
  return value;
}
describe("same-conversation immutable full-feature reads", () => {
  it.each([false, true])(
    "verifies restored acquisition with a fresh report page and independent complete source evidence (changed=%s)",
    (changed) => {
      const { input, turns } = priorFullFixture();
      const restored = turns[2]!;
      const skipped = new Set(
        restored
          .agentListening!.records.filter(
            (record) =>
              record.kind === "tool_call" &&
              record.arguments.action === "report" &&
              Number(record.arguments.offset) > 0,
          )
          .map((record) => ("toolCallId" in record ? record.toolCallId : "")),
      );
      Object.assign(restored.agentListening!, {
        records: restored.agentListening!.records.filter(
          (record) =>
            !("toolCallId" in record && skipped.has(record.toolCallId)),
        ),
      });
      if (changed) {
        Object.assign(restored, {
          featureSources: structuredClone(restored.featureSources),
        });
        Object.assign(
          restored.featureSources![0]!.analyzers!.pitch.frames.at(-1)!
            .channels[0],
          {
            state: "accepted-estimate",
            hz: 123,
            confidence: 0.99,
          },
        );
      }
      const verify = () => verifyFeatureSearch(input, "final");
      if (changed) expect(verify).toThrow();
      else expect(verify).not.toThrow();
    },
  );
  it.each([false, true])(
    "reuses all five first-source reads only before restart (projected=%s)",
    (projected) => {
      const { input, turns } = priorFullFixture();
      if (projected)
        for (const turn of turns)
          Object.assign(turn, {
            agentListening: projectFeatureSearchHistory(turn.agentListening!),
          });
      expect(() =>
        verifyFeatureSearch(
          { ...input, turns: turns.slice(0, 2), turn: turns[1]! },
          "second",
        ),
      ).not.toThrow();
      expect(() => verifyFeatureSearch(input, "final")).not.toThrow();
    },
  );
  it.each(firstFeatureIds)(
    "rejects an absent original typed read (%s)",
    (id) => {
      const { input, turns } = priorFullFixture();
      omitTool(turns[0]!, "get-feature", id);
      expect(() => verifyFeatureSearch(input, "final")).toThrow();
    },
  );
  it.each(firstFeatureIds)(
    "requires the new capture's genuine same-turn read (%s)",
    (id) => {
      const { input, turns } = priorFullFixture();
      omitTool(turns[1]!, "get-feature", id.replace("feature-1", "feature-2"));
      expect(() => verifyFeatureSearch(input, "final")).toThrow();
    },
  );
  it.each([
    "appSessionId",
    "agentId",
    "conversationId",
    "source",
    "attribution",
    "restart",
    "comparison",
    "search",
  ] as const)("rejects broken pre-restart reuse (%s)", (mode) => {
    const { input, turns } = priorFullFixture();
    if (["appSessionId", "agentId", "conversationId"].includes(mode))
      Object.assign(turns[0]!, { [mode]: "foreign" });
    if (mode === "source")
      Object.assign(turns[1]!.featureSources![0]!, {
        contentSha256: "c".repeat(64),
      });
    if (mode === "attribution")
      turns[0]!.agentListening!.records[0]!.appSessionId = "foreign";
    if (mode === "restart")
      Object.assign(turns[1]!.agentListening!, { afterOwnedRestart: true });
    if (mode === "comparison") omitTool(turns[1]!, "compare-features");
    if (mode === "search") omitTool(turns[1]!, "search-features");
    expect(() => verifyFeatureSearch(input, "final")).toThrow();
  });
  it.each(["identity", "metadata", "values", "support"] as const)(
    "rejects changed immutable analyzer rereads (%s)",
    (mode) => {
      const { input, turns } = fixture(true, false, 32);
      const reread = analyzerResult(turns[1]!, "flatness-summary/v1");
      // The fixture shares source views; make this a distinct second-turn read.
      const changed = structuredClone(reread);
      Object.assign(reread, changed);
      if (mode === "identity") {
        const previousId = reread.feature.record.id;
        reread.feature.record.id = "different-feature";
        for (const record of turns[1]!.agentListening!.records)
          if (
            record.kind === "tool_call" &&
            record.arguments.featureId === previousId
          )
            record.arguments.featureId = "different-feature";
      }
      if (mode === "metadata")
        Object.assign(reread.feature.record.feature, {
          supportPolicy: "changed",
        });
      if (mode === "values") reread.page.values[0]! += 1e-12;
      if (mode === "support")
        Object.assign(reread.page, { supportIntervals: [[1, 90000]] });
      expect(() =>
        verifyFeatureSearch(
          { ...input, turns: turns.slice(0, 2), turn: turns[1]! },
          "second",
        ),
      ).toThrow();
      expect(() => verifyFeatureSearch(input, "final")).toThrow();
    },
  );
  it.each(
    firstFeatureIds.flatMap((id) => [id, id.replace("feature-1", "feature-2")]),
  )("requires a fresh post-restart typed read (%s)", (id) => {
    const { input, turns } = priorFullFixture();
    omitTool(turns[2]!, "get-feature", id);
    expect(() => verifyFeatureSearch(input, "restored")).toThrow();
  });
  it("binds restored first-source identities even when turn two reused their reads", () => {
    const { input, turns } = priorFullFixture();
    const read = analyzerResult(turns[2]!, "flatness-summary/v1");
    const previousId = read.feature.record.id;
    read.feature.record.id = "different-restored-feature";
    for (const record of turns[2]!.agentListening!.records)
      if (
        record.kind === "tool_call" &&
        record.arguments.featureId === previousId
      )
        record.arguments.featureId = "different-restored-feature";
    expect(() => verifyFeatureSearch(input, "restored")).toThrow();
  });
  it("still requires fresh post-restart source reads", () => {
    const { input, turns } = priorFullFixture();
    omitTool(turns[2]!, "report");
    expect(() => verifyFeatureSearch(input, "restored")).toThrow(
      "stored measurements",
    );
  });
});
const transportReadSuffix = `\n\nTool "ableton_transport" succeeded. Additional guidance from postToolUse hooks:\n${VERIFIED_TOOL_RESULT_GUIDANCE}`;

function addTransportRead(
  turn: TurnEvidence,
  framing: "object" | "json" | "hook",
) {
  const records = turn.agentListening!.records;
  const originalCall = records.find((record) => record.kind === "tool_call")!;
  const originalResult = records.find(
    (record) => record.kind === "tool_result",
  )!;
  const call = {
    ...structuredClone(originalCall),
    id: `${originalCall.id}-transport`,
    toolCallId: "transport-read",
    correlationId: "transport-read",
    toolName: "ableton_transport",
    arguments: { action: "get" },
  };
  const payload = {
    action: "get",
    transport: {
      currentSongTime: 0,
      isPlaying: false,
      tempo: 128,
      timeSignature: { numerator: 4, denominator: 4 },
      metronome: false,
      launchQuantization: 0,
      recordQuantization: 0,
      linkEnabled: false,
      backToArrangement: false,
    },
    cuePoints: [],
    totalCuePoints: 0,
    offset: 0,
    limit: 32,
  };
  const response = {
    ...structuredClone(originalResult),
    id: `${originalResult.id}-transport`,
    toolCallId: "transport-read",
    correlationId: "transport-read",
    metadata: { toolName: "ableton_transport" },
    result: {
      result: {
        content:
          framing === "object"
            ? payload
            : JSON.stringify(payload) +
              (framing === "hook" ? transportReadSuffix : ""),
      },
    },
  };
  records.unshift(call, response);
  return { call, response, payload };
}

describe("bounded independent feature search oracle", () => {
  it.each(["object", "json", "hook"] as const)(
    "allows only validated transport inspection (%s) across all phases",
    (framing) => {
      for (const coverage of ["full", "peak-only"] as const) {
        const { input, turns } =
          coverage === "full" ? fixture() : peakFixture();
        for (const turn of turns) addTransportRead(turn, framing);
        expect(() =>
          verifyFeatureSearch(input, "final", coverage),
        ).not.toThrow();
      }
    },
  );
  it.each([
    "seek",
    "stop",
    "reset",
    "extra-argument",
    "wrong-result-action",
    "invalid-state",
    "extra-result-field",
    "changed-suffix",
    "duplicate-suffix",
    "foreign-suffix",
    "foreign-tool",
    "failed",
    "missing-result",
    "foreign-trace",
  ])("rejects unsafe or unverified transport inspection (%s)", (mode) => {
    const { input, turns } = fixture();
    const { call, response, payload } = addTransportRead(turns[0]!, "object");
    if (["seek", "stop", "reset"].includes(mode)) {
      call.arguments.action = mode;
      payload.action = mode;
    }
    if (mode === "extra-argument") Object.assign(call.arguments, { time: 4 });
    if (mode === "wrong-result-action") payload.action = "seek";
    if (mode === "invalid-state") payload.transport.tempo = 0;
    if (mode === "extra-result-field")
      Object.assign(payload, { verified: true });
    if (mode === "changed-suffix")
      response.result.result.content =
        JSON.stringify(payload) + transportReadSuffix + "untrusted";
    if (mode === "duplicate-suffix")
      response.result.result.content =
        JSON.stringify(payload) + transportReadSuffix + transportReadSuffix;
    if (mode === "foreign-suffix")
      response.result.result.content =
        JSON.stringify(payload) +
        transportReadSuffix.replace("ableton_transport", "ableton_context");
    if (mode === "foreign-tool") {
      call.toolName = "ableton_devices";
      response.metadata.toolName = "ableton_devices";
    }
    if (mode === "failed") response.outcome = "failure";
    if (mode === "missing-result")
      turns[0]!.agentListening!.records.splice(1, 1);
    if (mode === "foreign-trace") response.traceId = "foreign";
    expect(() => verifyFeatureSearch(input, "final")).toThrow();
  });
  it("fits all three strict turns with four-page reports, complete catalog and both sources' feature reads in the existing receipt budget", () => {
    const { input, turns } = fixture(true, false, 32);
    const inventory = result(turns[1]!, "list-features");
    const templates = [
      result(turns[0]!, "get-feature").feature,
      (
        result(turns[1]!, "search-features").matches as { feature: unknown }[]
      )[0]!.feature,
    ] as { record: { id: string; feature: object } }[];
    inventory.features = templates.flatMap((template) =>
      LISTENING_FEATURE_DEFINITIONS.map((definition) => ({
        ...template,
        record: {
          ...template.record,
          id: `${template.record.id}-${definition.type}`,
          feature: {
            ...template.record.feature,
            ...definition,
            status: definition.type.endsWith("-grid/v1")
              ? "unavailable"
              : "ready",
            reason: definition.type.endsWith("-grid/v1")
              ? "missing-alignment"
              : null,
          },
        },
      })),
    );
    // Keep the exact peak inventory entry consumed by the frozen oracle.
    (inventory.features as unknown[]).push(templates[1]);
    const decorate = (value: unknown): void => {
      if (value === null || typeof value !== "object") return;
      const item = value as Record<string, unknown>;
      if (item.record && item.source) {
        Object.assign(item.record, {
          freshness: {
            status: "unknown",
            reason: "Historical capture evidence; ".repeat(5),
          },
        });
        Object.assign(item.source, {
          freshness: "unknown",
          summary: "Human-readable feature presentation. ".repeat(12),
        });
      }
      if (item.action === "report" && item.entry)
        Object.assign(item.entry, {
          summary: "Human-readable capture presentation. ".repeat(12),
        });
      for (const child of Object.values(item)) decorate(child);
    };
    for (const turn of turns) decorate(turn.agentListening);
    const raw = structuredClone(turns);
    const reports = (turn: TurnEvidence) =>
      turn.agentListening!.records.filter(
        (record) =>
          record.kind === "tool_call" && record.arguments.action === "report",
      );
    expect(reports(turns[0]!)).toHaveLength(4);
    expect(reports(turns[1]!)).toHaveLength(4);
    expect(reports(turns[2]!)).toHaveLength(8);
    expect(Buffer.byteLength(JSON.stringify(turns))).toBeGreaterThan(524_288);
    for (const turn of turns)
      Object.assign(turn, {
        agentListening: projectFeatureSearchHistory(turn.agentListening!),
      });
    expect(Buffer.byteLength(JSON.stringify(turns))).toBeLessThanOrEqual(
      524_288,
    );
    expect(() => verifyFeatureSearch(input, "final")).not.toThrow();
    expect(turns.map((turn) => turn.agentListening!.records.length)).toEqual(
      raw.map((turn) => turn.agentListening!.records.length),
    );
    for (const [index, turn] of turns.entries()) {
      expect(JSON.stringify(turn.agentListening)).not.toContain(
        "Human-readable",
      );
      expect(
        turn.agentListening!.records.filter(
          (record) => record.kind !== "tool_result",
        ),
      ).toEqual(
        raw[index]!.agentListening!.records.filter(
          (record) => record.kind !== "tool_result",
        ),
      );
      expect(
        projectFeatureSearchHistory({
          ...raw[index]!.agentListening!,
          afterOwnedRestart: true,
        }),
      ).toEqual({ ...turn.agentListening, afterOwnedRestart: true });
    }
  });
  it.each([
    "overflow",
    "duplicate",
    "foreign",
    "malformed-report",
    "truncated",
  ] as const)(
    "rejects unsafe History before report projection (%s)",
    (mode) => {
      const { turns } = fixture(true, false, 32);
      const history = turns[0]!.agentListening!;
      if (mode === "overflow")
        Object.assign(history, {
          records: Array.from({ length: 257 }, () => history.records[0]!),
        });
      if (mode === "duplicate")
        Object.assign(history, {
          records: [...history.records, history.records[0]!],
        });
      if (mode === "foreign") history.records[0]!.appSessionId = "foreign";
      if (mode === "malformed-report")
        (
          result(turns[0]!, "report").report as { sampleRate: number }
        ).sampleRate = 0;
      if (mode === "truncated")
        history.records.find(
          (record) => record.kind === "tool_call",
        )!.metadata.note = "[truncated]";
      expect(() => projectFeatureSearchHistory(history)).toThrow();
    },
  );
  it.each([
    "nonterminal",
    "frame",
    "duplicate-frame",
    "missing-frame",
    "profile",
    "missing-read",
    "missing-feature-read",
  ] as const)(
    "preserves strict report/feature guards after projection (%s)",
    (mode) => {
      const { input, turns } = fixture(true, false, 32);
      for (const turn of turns)
        Object.assign(turn, {
          agentListening: projectFeatureSearchHistory(turn.agentListening!),
        });
      const first = turns[0]!;
      const report = result(first, "report").featureReport as {
        analyzers: {
          pitch: {
            profileSha256: string;
            frames: { index: number; sha256: string }[];
          };
        };
      };
      if (mode === "nonterminal")
        first.agentListening!.records.find(
          (record) => record.kind === "turn",
        )!.status = "failed";
      if (mode === "frame")
        report.analyzers.pitch.frames[0]!.sha256 = "a".repeat(64);
      if (mode === "duplicate-frame")
        report.analyzers.pitch.frames.push(report.analyzers.pitch.frames[0]!);
      if (mode === "profile")
        report.analyzers.pitch.profileSha256 = "b".repeat(64);
      if (mode === "missing-frame") report.analyzers.pitch.frames.shift();
      if (mode === "missing-read") omitTool(first, "report");
      if (mode === "missing-feature-read")
        omitTool(turns[1]!, "get-feature", "feature-2-flatness-summary");
      expect(() => verifyFeatureSearch(input, "final")).toThrow();
    },
  );
  it("verifies nonzero measured Euclidean distance and original IDs after one owned restart", () => {
    const { input, turns } = fixture();
    expect(() =>
      verifyFeatureSearch(
        { ...input, turns: turns.slice(0, 1), turn: turns[0]! },
        "first",
      ),
    ).not.toThrow();
    expect(() => verifyFeatureSearch(input, "final")).not.toThrow();
  });
  it("accepts paginated analyzer reports and low-confidence kick pitch without claiming accuracy", () => {
    const { input } = fixture(true);
    expect(() => verifyFeatureSearch(input, "final")).not.toThrow();
    expect(
      input.turns[0]!.featureSources![0]!.analyzers!.pitch.frames.every(
        (frame) =>
          frame.channels.every((channel) => channel.state === "low-confidence"),
      ),
    ).toBe(true);
  });
  it("preserves honestly unavailable confidence instead of inventing a score from acquired silence", () => {
    const { input } = fixture(false, true);
    expect(() => verifyFeatureSearch(input, "final")).not.toThrow();
  });
  it("rejects omitted analyzer report continuation", () => {
    const { input, turns } = fixture(true);
    const call = turns[1]!.agentListening!.records.find(
      (record) =>
        record.kind === "tool_call" &&
        record.arguments.action === "report" &&
        record.arguments.offset === 15,
    )!;
    if (call.kind !== "tool_call")
      throw new Error("Missing synthetic final report page");
    Object.assign(turns[1]!.agentListening!, {
      records: turns[1]!.agentListening!.records.filter(
        (record) =>
          !("toolCallId" in record) || record.toolCallId !== call.toolCallId,
      ),
    });
    expect(() => verifyFeatureSearch(input, "final")).toThrow(
      "all analyzer report pages",
    );
  });
  it.each([
    [
      "missing authoritative analyzer",
      (turns: TurnEvidence[]) => {
        Object.assign(turns[0]!.featureSources![0]!, {
          analyzers: {
            spectralShape:
              turns[0]!.featureSources![0]!.analyzers!.spectralShape,
          },
        });
      },
    ],
    [
      "diagnostic promotion",
      (turns: TurnEvidence[]) => {
        Object.assign(turns[0]!.featureSources![0]!.analyzers!, {
          pitch: { latestHz: 440, latestConfidence: 0.99 },
        });
      },
    ],
    [
      "failed analyzer acquisition",
      (turns: TurnEvidence[]) => {
        const pitch = turns[0]!.featureSources![0]!.analyzers!.pitch;
        Object.assign(turns[0]!.featureSources![0]!.analyzers!, {
          pitch: {
            ...pitch,
            status: "failed",
            frames: [],
            gaps: pitch.frames.map((frame) => ({
              firstIndex: frame.index,
              count: 1,
              support: frame.support,
              reason: "dependency-unavailable",
            })),
          },
        });
      },
    ],
    [
      "false accepted pitch validity",
      (turns: TurnEvidence[]) => {
        const pitch = structuredClone(
          turns[0]!.featureSources![0]!.analyzers!.pitch,
        );
        Object.assign(pitch.frames[0]!.channels[0], {
          state: "accepted-estimate",
        });
        Object.assign(turns[0]!.featureSources![0]!.analyzers!, { pitch });
      },
    ],
    [
      "false shape validity",
      (turns: TurnEvidence[]) => {
        const spectralShape = structuredClone(
          turns[0]!.featureSources![0]!.analyzers!.spectralShape,
        );
        Object.assign(spectralShape.frames[0]!.channels[0], {
          state: "silence",
        });
        Object.assign(turns[0]!.featureSources![0]!.analyzers!, {
          spectralShape,
        });
      },
    ],
    [
      "missing captured family",
      (turns: TurnEvidence[]) => {
        Object.assign(turns[0]!.captures[0]!, {
          metricFamilies: [
            "level",
            "spectral-centroid",
            "attacks",
            "mel-bands",
          ],
        });
      },
    ],
    [
      "incomplete fifteen-definition catalog",
      (turns: TurnEvidence[]) => {
        const catalog = result(turns[1]!, "feature-definitions");
        catalog.definitions = (
          catalog.definitions as { type: string }[]
        ).filter((definition) => definition.type !== "spread-summary/v1");
      },
    ],
    [
      "false ready pitch grid on low-confidence source",
      (turns: TurnEvidence[]) => {
        for (const record of turns[1]!.agentListening!.records) {
          if (record.kind !== "tool_result") continue;
          const data = (
            record.result?.result as {
              content?: {
                action: string;
                features?: {
                  record: { feature: { type: string; status: string } };
                }[];
              };
            }
          )?.content;
          if (data?.action === "list-features")
            for (const feature of data.features ?? [])
              if (feature.record.feature.type === "pitch-grid/v1")
                feature.record.feature.status = "ready";
        }
      },
    ],
    [
      "missing confidence feature",
      (turns: TurnEvidence[]) => {
        analyzerResult(
          turns[1]!,
          "pitch-confidence-summary/v1",
        ).feature.record.feature.type = "level-grid/v1";
      },
    ],
    [
      "failed shape feature",
      (turns: TurnEvidence[]) => {
        analyzerResult(
          turns[1]!,
          "flatness-summary/v1",
        ).feature.record.feature.status = "unavailable";
      },
    ],
    [
      "false confidence arithmetic",
      (turns: TurnEvidence[]) => {
        analyzerResult(turns[1]!, "pitch-confidence-summary/v1").page.values = [
          1, 1,
        ];
      },
    ],
    [
      "false shape channel validity",
      (turns: TurnEvidence[]) => {
        analyzerResult(
          turns[1]!,
          "spread-summary/v1",
        ).feature.record.feature.channelReasons[0] = "invalid-output";
      },
    ],
    [
      "changed analyzer ID after restart",
      (turns: TurnEvidence[]) => {
        analyzerResult(turns[2]!, "rolloff-summary/v1").feature.record.id =
          "replacement-feature";
      },
    ],
    [
      "changed analyzer evidence after restart",
      (turns: TurnEvidence[]) => {
        const sources = structuredClone(turns[2]!.featureSources!);
        Object.assign(
          sources[0]!.analyzers!.spectralShape.frames[0]!.channels[0],
          { flatnessDb: -25 },
        );
        Object.assign(turns[2]!, { featureSources: sources });
      },
    ],
    [
      "bad measured peak page",
      (turns: TurnEvidence[]) => {
        (result(turns[1]!, "get-feature").page as { values: number[] }).values =
          [9, 9];
      },
    ],
    [
      "unavailable peak",
      (turns: TurnEvidence[]) => {
        (
          result(turns[1]!, "get-feature").feature as {
            record: { feature: { status: string } };
          }
        ).record.feature.status = "unavailable";
      },
    ],
    [
      "changed restored feature ID",
      (turns: TurnEvidence[]) => {
        (
          result(turns[2]!, "get-feature").feature as { record: { id: string } }
        ).record.id = "new-feature";
      },
    ],
    [
      "foreign additional search feature",
      (turns: TurnEvidence[]) => {
        const search = result(turns[1]!, "search-features") as {
          matches: {
            feature: { record: { id: string; sessionId: string } };
            distance: number;
          }[];
        };
        const foreign = structuredClone(search.matches[0]!);
        foreign.feature.record.id = "foreign-feature";
        foreign.feature.record.sessionId = "foreign-session";
        search.matches.push(foreign);
      },
    ],
    [
      "missing feature catalog",
      (turns: TurnEvidence[]) => {
        result(turns[1]!, "feature-definitions").definitions = [];
      },
    ],
    [
      "cancelled turn",
      (turns: TurnEvidence[]) => {
        Object.assign(turns[1]!, { status: "cancelled" });
      },
    ],
    [
      "missing native ownership",
      (turns: TurnEvidence[]) => {
        Object.assign(turns[0]!, {
          captures: turns[0]!.captures.map((capture) => {
            const copy = { ...capture };
            delete copy.native;
            return copy;
          }),
        });
      },
    ],
    [
      "failed capture cleanup",
      (turns: TurnEvidence[]) => {
        Object.assign(turns[1]!, {
          captures: turns[1]!.captures.map((capture) => ({
            ...capture,
            cleanupComplete: false,
          })),
        });
      },
    ],
    [
      "missing result",
      (turns: TurnEvidence[]) => {
        turns[1]!.agentListening!.records.pop();
      },
    ],
    [
      "foreign history",
      (turns: TurnEvidence[]) => {
        turns[1]!.agentListening!.records[0]!.appSessionId = "foreign";
      },
    ],
    [
      "failed tool",
      (turns: TurnEvidence[]) => {
        const r = turns[1]!.agentListening!.records.find(
          (r) => r.kind === "tool_result",
        )!;
        if (r.kind === "tool_result") r.outcome = "failure";
      },
    ],
    [
      "bad comparison",
      (turns: TurnEvidence[]) => {
        (
          result(turns[1]!, "compare-features").comparisons as {
            result: { distance: number };
          }[]
        )[0]!.result.distance = 100;
      },
    ],
    [
      "obsolete derivation definition set",
      (turns: TurnEvidence[]) => {
        (
          result(turns[1]!, "derive-features").derivations as {
            definitionSet: string;
          }[]
        )[0]!.definitionSet = "stored-listening/v1";
      },
    ],
    [
      "unbounded derivation feature count",
      (turns: TurnEvidence[]) => {
        (
          result(turns[1]!, "derive-features").derivations as {
            featureCount: number;
          }[]
        )[0]!.featureCount = 7681;
      },
    ],
    [
      "wrong comparison distance units",
      (turns: TurnEvidence[]) => {
        (
          result(turns[1]!, "compare-features").comparisons as {
            result: { units: string };
          }[]
        )[0]!.result.units = "cents";
      },
    ],
    [
      "wrong search distance units",
      (turns: TurnEvidence[]) => {
        result(turns[1]!, "search-features").distanceUnits = "cents";
      },
    ],
    [
      "bad search arithmetic",
      (turns: TurnEvidence[]) => {
        (
          result(turns[1]!, "search-features").matches as { distance: number }[]
        )[0]!.distance = 100;
      },
    ],
    [
      "self match",
      (turns: TurnEvidence[]) => {
        const data = result(turns[1]!, "search-features");
        (data.matches as { feature: unknown }[])[0]!.feature = data.query;
      },
    ],
    [
      "omitted exclusion",
      (turns: TurnEvidence[]) => {
        const call = turns[1]!.agentListening!.records.find(
          (r) =>
            r.kind === "tool_call" && r.arguments.action === "search-features",
        )!;
        if (call.kind === "tool_call") call.arguments.excludeContextIds = [];
      },
    ],
    [
      "extra capture",
      (turns: TurnEvidence[]) => {
        Object.assign(turns[2]!, { captures: turns[0]!.captures });
      },
    ],
    [
      "reset tool",
      (turns: TurnEvidence[]) => {
        const call = turns[1]!.agentListening!.records[0]!;
        if (call.kind === "tool_call") call.toolName = "ableton_transport";
      },
    ],
    [
      "changed source",
      (turns: TurnEvidence[]) => {
        Object.assign(turns[2]!, {
          featureSources: turns[2]!.featureSources!.map((source) => ({
            ...source,
            contentSha256: "c".repeat(64),
          })),
        });
      },
    ],
    [
      "missing restart",
      (turns: TurnEvidence[]) => {
        Object.assign(turns[2]!, {
          agentListening: {
            ...turns[2]!.agentListening!,
            afterOwnedRestart: false,
          },
        });
      },
    ],
  ] as const)("fails closed for %s", (_name, mutate) => {
    const { input, turns } = fixture();
    mutate(turns);
    expect(() => verifyFeatureSearch(input, "final")).toThrow();
  });
  it("requires the exact declared stop and restart receipts", () => {
    const { input } = fixture();
    expect(() =>
      verifyFeatureSearch(
        { ...input, evidence: { ...input.evidence!, setupActions: [] } },
        "final",
      ),
    ).toThrow("stop/restart");
  });
});
