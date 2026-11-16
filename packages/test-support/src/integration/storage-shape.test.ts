import { describe, expect, it } from "vitest";
import { VERIFIED_TOOL_RESULT_GUIDANCE } from "@ableton-agent/application";
import {
  LISTENING_FEATURE_DEFINITIONS,
  extractListeningFeature,
  segmentListeningObservation,
  type ContextFeature,
} from "@ableton-agent/protocol";
import {
  createSyntheticMetricRecordStreamFixture,
  withSyntheticAnalyzerTimelines,
} from "@ableton-agent/protocol/testing";
import {
  projectListeningFeatureRecord,
  projectListeningFeatureInventory,
  expandListeningFeatureInventory,
  contextFeatureViewSchema,
  contextOperationResultSchema,
} from "@ableton-agent/tools";
import type {
  AgentHistoryPage,
  TelemetryEventPage,
} from "@ableton-agent/observability";
import { OBSERVABILITY_CONTRACT_VERSION } from "@ableton-agent/observability";
import { agentListeningFixture } from "./agent-listening-test-support.js";
import { arrangementTestEvidence } from "./arrangement-test-support.js";
import { melSmokeFixture } from "./mel-smoke-test-support.js";
import { projectFeatureSearchHistory } from "./feature-search.js";
import { createDefaultAssertions } from "./assertions.js";
import {
  projectObservationStorageShape,
  projectIncrementalDurability,
  projectStorageShapeHistory,
  verifyStorageShape,
} from "./storage-shape.js";
import type { AssertionInput, TurnEvidence } from "./contracts.js";

function fixture(measures = 1) {
  const base = agentListeningFixture();
  const arrangement = arrangementTestEvidence();
  Reflect.set(
    arrangement.baseline.source,
    "trackId",
    base.turn.captures[0]!.source.trackId,
  );
  const observation = withSyntheticAnalyzerTimelines(
    melSmokeFixture().observation,
  );
  const featureGroups = (["session", "arrangement"] as const).map(
    (view, side) => {
      const coordinate =
        view === "session"
          ? ("clip-local-beats" as const)
          : ("transport-beats" as const);
      const alignment = {
        version: 1 as const,
        coordinate,
        meter: { numerator: 4, denominator: 4 },
        barOriginBeat: 0,
        tempoBpm: observation.geometry.tempoBpm,
        tempoEvidence: "message-rate-monitored-constant" as const,
        provenance:
          view === "session"
            ? ("session-clip-markers/v1" as const)
            : ("capture-snapshot/v1" as const),
      };
      const range = segmentListeningObservation(observation, {
        ...alignment,
        coordinate: "clip-local-beats",
      })[0]!;
      return Array.from({ length: measures }, (_, order) =>
        LISTENING_FEATURE_DEFINITIONS.map((definition) => {
          const segment = {
            ...range,
            id: `segment:${side}-${order}`,
            entryId: `context-${side}`,
            sessionId: base.owner.appSessionId,
            liveSetId: "set",
            order,
            coordinate,
            kind: "bar" as const,
            alignment,
            alignmentReason: null,
            startBeat: order * 4,
            endBeat: (order + 1) * 4,
            startSample: order * 90000,
            endSample: (order + 1) * 90000,
          };
          Reflect.deleteProperty(segment, "grid");
          const record: ContextFeature = {
            id: `feature:${side}-${order}-${definition.type.replace("/", "-")}`,
            entryId: segment.entryId,
            segmentId: segment.id,
            sessionId: segment.sessionId,
            liveSetId: segment.liveSetId,
            sourceFingerprint: "a".repeat(64),
            createdAt: "2026-11-15T00:00:00.000Z",
            trace: {
              traceId: base.owner.sdkTurnId,
              correlationId: "correlation",
              causationId: "cause",
            },
            feature: extractListeningFeature(
              definition.type,
              observation,
              range,
            ),
          };
          return contextFeatureViewSchema.parse({
            record: projectListeningFeatureRecord(record),
            segment,
            source: {
              ...base.context.entry,
              contextId: segment.entryId,
              passId: `pass-${side}`,
              freshness: "fresh",
              summary: "Controlled stored capture",
            },
          });
        }),
      ).flat();
    },
  );
  const shapes = [0, 1].map((side) => ({
    ...(measures === 20
      ? {
          incrementalDurability: {
            captureStartedAt: "2026-11-15T00:00:00.000Z",
            firstDurableAt: "2026-11-15T00:00:01.000Z",
            durationMs: 37_500,
            durableChunks: 1,
            durableBytes: 3_460,
          },
        }
      : {}),
    ...projectObservationStorageShape(`context-${side}`, observation, false),
    schema: "metric-record-stream-context/v1",
    metricSchemas: observation.requestedMetrics
      .map((metric) => `metric-record-stream/v1:${metric}`)
      .sort(),
    passId: `pass-${side}`,
    startBeat: 0,
    endBeat: measures * 4,
    metrics: projectObservationStorageShape(
      `context-${side}`,
      observation,
      false,
    ).metrics.map((metric) => ({
      ...metric,
      ...(metric.metric === "level"
        ? { expectedRecords: measures * 16, retainedRecords: measures * 16 }
        : {}),
    })),
  }));
  const restoredFeatures = structuredClone(featureGroups);
  const restoredShapes = shapes.map((shape) => ({
    ...structuredClone(shape),
    afterOwnedRestart: true,
  }));
  const session: TurnEvidence = {
    ...base.turn,
    captures: [
      {
        ...base.turn.captures[0]!,
        source: { ...base.turn.captures[0]!.source },
        passId: "pass-0",
      },
    ],
    contexts: [
      { ...base.turn.contexts[0]!, contextId: "context-0", passId: "pass-0" },
    ],
    storageShapes: [shapes[0]!],
  };
  const arrangementCapture = {
    ...arrangement.capture,
    passId: "pass-1",
    operationId: "arrangement-operation",
    stream: {
      contextId: "context-1",
      passId: "pass-1",
      listenerId: arrangement.capture.listenerId,
      descriptorDigest: "a".repeat(64),
      manifestSha256: "b".repeat(64),
      recordsSha256: "c".repeat(64),
      chunkCount: 1,
      afterOwnedRestart: false,
    },
  };
  const other: TurnEvidence = {
    ...base.turn,
    userMessageId: "user-2",
    operationId: "arrangement-operation",
    captures: [],
    contexts: [],
    arrangementCaptures: [arrangementCapture],
    storageShapes: [shapes[1]!],
  };
  const restart: TurnEvidence = {
    ...base.turn,
    userMessageId: "restart-user",
    operationId: "restart-operation",
    captures: [],
    contexts: [],
  };
  const callTemplate = base.records.find((r) => r.kind === "tool_call")!;
  const resultTemplate = base.records.find((r) => r.kind === "tool_result")!;
  if (
    callTemplate.kind !== "tool_call" ||
    resultTemplate.kind !== "tool_result"
  )
    throw new Error("fixture");
  function history(
    turn: TurnEvidence,
    groups: typeof featureGroups,
    restored: boolean,
    side?: number,
  ) {
    const records: AgentHistoryPage["items"] = [];
    function pair(
      toolName: string,
      args: Record<string, unknown>,
      data: object,
    ) {
      const toolCallId = `tool-${records.length}`;
      records.push(
        {
          ...callTemplate,
          id: `call-${toolCallId}`,
          toolCallId,
          toolName,
          arguments: args,
          correlationId: toolCallId,
        },
        {
          ...resultTemplate,
          id: `result-${toolCallId}`,
          toolCallId,
          result: { result: { content: data } },
          metadata: { toolName },
          correlationId: toolCallId,
        },
      );
    }
    if (side !== undefined)
      pair(
        "ableton_listening",
        {
          action:
            side === 0
              ? "play-session-and-listen"
              : "play-arrangement-and-listen",
        },
        {
          action:
            side === 0
              ? "play-session-and-listen"
              : "play-arrangement-and-listen",
          job: {
            passId: `pass-${side}`,
            stage: "completed",
            contextIds: [`context-${side}`],
          },
        },
      );
    for (const features of groups)
      for (let offset = 0; offset < features.length; offset += 100) {
        const contextId = features[0]!.record.entryId;
        const cursor = offset === 0 ? undefined : `page-${offset}`;
        pair(
          "ableton_context",
          { action: "list-features", contextId, ...(cursor ? { cursor } : {}) },
          {
            action: "list-features",
            inventory: projectListeningFeatureInventory(
              features.slice(offset, offset + 100),
            ),
            derivation: {
              entryId: contextId,
              status: "ready",
              definitionSet: "qualified-listening/v1",
              reason: null,
              featureCount: features.length,
            },
            ...(offset + 100 < features.length
              ? { nextCursor: `page-${offset + 100}` }
              : {}),
          },
        );
      }
    records.push(
      ...base.records.filter((r) => r.kind === "message" || r.kind === "turn"),
    );
    Reflect.set(turn, "agentListening", {
      ...base.owner,
      records,
      afterOwnedRestart: restored,
    });
  }
  history(session, [featureGroups[0]!], false, 0);
  history(other, [featureGroups[1]!], false, 1);
  history(restart, restoredFeatures, true);
  const input: AssertionInput = {
    ...base.input,
    baseline: {
      ...base.input.baseline,
      arrangementSources: { arrangement: arrangement.baseline },
    },
    turns: [session, other, restart],
    evidence: {
      schemaVersion: 1,
      facts: {},
      contexts: [],
      unchanged: [],
      capturePassIds: ["pass-0", "pass-1"],
      storageShapes: restoredShapes,
      setupActions: [
        {
          ...base.owner,
          action: "restart-owned-desktop",
          stepId: "restart",
          completed: true,
          traceId: base.owner.sdkTurnId,
          correlationId: base.owner.sdkTurnId,
          causationId: "restart",
        },
      ],
    },
  };
  return {
    input,
    shapes,
    restoredShapes,
    featureGroups,
    restoredFeatures,
    session,
    other,
    restart,
  };
}

describe("message-driven storage shape acceptance", () => {
  it("preserves 100 original inventory identities and shapes below 64 KiB without repeated metadata", () => {
    const f = fixture(20);
    const original = f.featureGroups[0]!.slice(0, 100).map((view, index) => ({
      ...view,
      record: {
        ...view.record,
        createdAt: new Date(
          Date.parse(view.record.createdAt) + index,
        ).toISOString(),
      },
    }));
    const page = projectListeningFeatureInventory(original);
    const expanded = expandListeningFeatureInventory(page);
    expect(expanded).toEqual(
      original.map(({ source, ...feature }) => {
        const { summary, ...identity } = source;
        void summary;
        return { ...feature, source: identity };
      }),
    );
    const bytes = Buffer.byteLength(JSON.stringify(page));
    expect(bytes).toBeLessThan(64 * 1024);
    expect(bytes).toBeLessThan(Buffer.byteLength(JSON.stringify(original)) / 4);
    expect(page.provenance).toHaveLength(1);
    expect(page.segments).toHaveLength(7);
    expect(page.metadata).toHaveLength(15);
    expect(projectListeningFeatureInventory([]).features).toEqual([]);
    expect(() =>
      projectListeningFeatureInventory([...original, original[0]!]),
    ).toThrow();
    const oversized = structuredClone(page);
    oversized.metadata = Array.from({ length: 100 }, () => page.metadata[0]!);
    oversized.provenance = Array.from(
      { length: 100 },
      () => page.provenance[0]!,
    );
    oversized.sources = Array.from({ length: 100 }, () => page.sources[0]!);
    expect(() =>
      contextOperationResultSchema.parse({
        action: "list-features",
        inventory: oversized,
      }),
    ).toThrow("64 KiB");
    for (const corrupt of [
      (value: typeof page) => {
        value.features[0]!.metadata = 99;
      },
      (value: typeof page) => {
        value.features[1]!.id = value.features[0]!.id;
      },
      (value: typeof page) => {
        value.provenance[0]!.entryId = "foreign";
      },
    ]) {
      const invalid = structuredClone(page);
      corrupt(invalid);
      expect(() => expandListeningFeatureInventory(invalid)).toThrow();
    }
  });

  for (const toolName of ["ableton_arrangement", "ableton_session"] as const)
    it.each([
      "object",
      "json",
      "hook",
      "mutation",
      "wrong-result-action",
      "malformed",
      "foreign-suffix",
      "duplicated-suffix",
      "failed",
    ] as const)(
      `validates the agent's typed read-only ${toolName} inspection (%s)`,
      (framing) => {
        const f = fixture(20);
        const records = f.other.agentListening!.records;
        const call = records.find((record) => record.kind === "tool_call")!;
        const result = records.find((record) => record.kind === "tool_result")!;
        const action = framing === "mutation" ? "delete-clip" : "inspect";
        const data = {
          ...(framing === "mutation" || framing === "wrong-result-action"
            ? { action: "delete-clip" }
            : {}),
          ...(toolName === "ableton_session"
            ? {
                tempo: framing === "malformed" ? 0 : 128,
                timeSignature: { numerator: 4, denominator: 4 },
                isPlaying: false,
                trackCount: 0,
                tracks: [],
              }
            : {
                clips: [],
                total: framing === "malformed" ? -1 : 0,
                offset: 0,
                limit: 100,
              }),
        };
        const suffix = `\n\nTool "${toolName}" succeeded. Additional guidance from postToolUse hooks:\n${VERIFIED_TOOL_RESULT_GUIDANCE}`;
        records.push(
          {
            ...structuredClone(call),
            id: "arrangement-inspect-call",
            toolCallId: "arrangement-inspect",
            correlationId: "arrangement-inspect",
            toolName,
            arguments: {
              action,
              ...(toolName === "ableton_arrangement"
                ? { offset: 0, limit: 100 }
                : {}),
            },
          },
          {
            ...structuredClone(result),
            id: "arrangement-inspect-result",
            toolCallId: "arrangement-inspect",
            correlationId: "arrangement-inspect",
            metadata: { toolName },
            outcome: framing === "failed" ? "failure" : "success",
            result: {
              result: {
                content:
                  framing === "object"
                    ? data
                    : JSON.stringify(data) +
                      (framing === "hook"
                        ? suffix
                        : framing === "foreign-suffix"
                          ? suffix.replace(toolName, "ableton_context")
                          : framing === "duplicated-suffix"
                            ? suffix + suffix
                            : ""),
              },
            },
          },
        );
        if (["object", "json", "hook"].includes(framing))
          expect(() => verifyStorageShape(f.input, 20)).not.toThrow();
        else expect(() => verifyStorageShape(f.input, 20)).toThrow();
      },
    );

  it("rejects long captures without persistence during native capture", () => {
    const f = fixture(20);
    for (const shape of [...f.shapes, ...f.restoredShapes])
      delete shape.incrementalDurability;
    expect(() => verifyStorageShape(f.input, 20)).toThrow(
      "Long capture lacks a durable append",
    );
  });
  it("rejects a post-capture bulk write and a changed durability witness after restart", () => {
    const f = fixture(20);
    Reflect.set(
      f.shapes[0]!.incrementalDurability!,
      "firstDurableAt",
      "2026-11-15T00:00:38.000Z",
    );
    expect(() => verifyStorageShape(f.input, 20)).toThrow(
      "Invalid durable append",
    );
    Reflect.set(
      f.shapes[0]!.incrementalDurability!,
      "firstDurableAt",
      "2026-11-15T00:00:01.000Z",
    );
    Reflect.set(
      f.restoredShapes[0]!.incrementalDurability!,
      "durableChunks",
      2,
    );
    expect(() => verifyStorageShape(f.input, 20)).toThrow(
      "Persisted schema/counts changed after restart",
    );
  });
  it("joins whole-observation Arrangement contexts and verifies their original content after restart without fabricating a stream", () => {
    const f = fixture();
    const capture = f.other.arrangementCaptures![0]!;
    Reflect.deleteProperty(capture, "stream");
    Reflect.set(capture, "contextId", "context-1");
    expect(() => verifyStorageShape(f.input, 1)).not.toThrow();
    f.restoredShapes[1]!.contentSha256 = "f".repeat(64);
    expect(() => verifyStorageShape(f.input, 1)).toThrow();
  });

  describe("original-stream incremental durability attribution", () => {
    it.each([
      "valid",
      "missing",
      "late",
      "early",
      "session",
      "agent",
      "trace",
      "correlation",
      "capture",
      "zero-chunks",
      "zero-bytes",
      "queued",
      "no-start",
    ])("accepts only a committed in-capture append: %s", async (condition) => {
      const { descriptor } = await createSyntheticMetricRecordStreamFixture({
        seconds: 1,
      });
      const event: TelemetryEventPage["items"][number] = {
        version: OBSERVABILITY_CONTRACT_VERSION,
        id: "append",
        sequence: 1,
        recordedAt: "2026-11-15T00:00:00.500Z",
        occurredAt: "2026-11-15T00:00:00.500Z",
        name: "context.metric-chunk.progress",
        source: "project-state",
        level: "info",
        trace: { traceId: descriptor.ownership.traceId, spanId: "append" },
        correlationId: descriptor.ownership.correlationId,
        sessionId: "session",
        activeAgentId: "agent",
        attributes: {
          captureId: "capture",
          durableChunks: 1,
          durableBytes: 3_460,
        },
      };
      switch (condition) {
        case "late":
          event.occurredAt = "2026-11-15T00:00:01.000Z";
          break;
        case "early":
          event.occurredAt = "2026-11-14T23:59:59.999Z";
          break;
        case "session":
          event.sessionId = "foreign";
          break;
        case "agent":
          event.activeAgentId = "foreign";
          break;
        case "trace":
          event.trace!.traceId = "foreign";
          break;
        case "correlation":
          event.correlationId = "foreign";
          break;
        case "capture":
          event.attributes.captureId = "foreign";
          break;
        case "zero-chunks":
          event.attributes.durableChunks = 0;
          break;
        case "zero-bytes":
          event.attributes.durableBytes = 0;
          break;
        case "queued":
          event.name = "context.metric-chunk.queued";
          break;
      }
      const result = projectIncrementalDurability(descriptor, {
        captureId: "capture",
        startedAt: condition === "no-start" ? null : "2026-11-15T00:00:00.000Z",
        sessionId: "session",
        agentId: "agent",
        events: condition === "missing" ? [] : [event],
      });
      if (condition === "valid")
        expect(result).toEqual({
          captureStartedAt: "2026-11-15T00:00:00.000Z",
          firstDurableAt: event.occurredAt,
          durationMs: 1_000,
          durableChunks: 1,
          durableBytes: 3_460,
        });
      else expect(result).toBeUndefined();
    });
  });
  it("reports different production representations as a failed structural assertion, not a normalized equivalent", () => {
    const f = fixture();
    f.shapes[1]!.schema = "metric-audio-observation/v1";
    f.restoredShapes[1]!.schema = "metric-audio-observation/v1";
    const result = createDefaultAssertions().evaluate(
      { name: "storage-shape", parameters: { expectedMeasures: 1 } },
      f.input,
    );
    expect(result).toMatchObject({
      passed: false,
      code: "storage-shape-invalid",
    });
    expect(result.detail).toContain(
      "Production persisted measurement schemas differ",
    );
  });
  it("counts Arrangement and Session passes and rejects an Arrangement capture in a no-capture turn", () => {
    const f = fixture();
    const registry = createDefaultAssertions();
    expect(
      registry.evaluate(
        { name: "capture-count", parameters: { expected: 2 } },
        f.input,
      ).passed,
    ).toBe(true);
    expect(
      registry.evaluate(
        { name: "no-capture", parameters: {} },
        { ...f.input, turn: f.other },
      ).passed,
    ).toBe(false);
    expect(
      registry.evaluate(
        { name: "no-capture", parameters: {} },
        { ...f.input, turn: f.restart },
      ).passed,
    ).toBe(true);
  });
  it.each([1, 20])(
    "verifies %i complete measures without numerical value reads",
    (measures) => {
      const f = fixture(measures);
      const input = {
        ...f.input,
        turns: f.input.turns.map((turn) => ({
          ...turn,
          agentListening: projectStorageShapeHistory(
            projectFeatureSearchHistory(turn.agentListening!),
          ),
        })),
      };
      expect(
        Buffer.byteLength(JSON.stringify(input.turns)),
      ).toBeLessThanOrEqual(524_288);
      expect(Buffer.byteLength(JSON.stringify(input))).toBeLessThan(1_500_000);
      expect(() => verifyStorageShape(input, measures)).not.toThrow();
      expect(
        createDefaultAssertions().evaluate(
          { name: "storage-shape", parameters: { expectedMeasures: measures } },
          input,
        ).passed,
      ).toBe(true);
    },
  );
  it.each([
    "index",
    "width",
    "columns",
    "alignment",
    "metadata",
    "duplicate",
    "owner",
    "pass",
  ])("rejects changed compact inventory tables (%s)", (fault) => {
    const f = fixture(20);
    const input = {
      ...f.input,
      turns: f.input.turns.map((turn) => ({
        ...turn,
        agentListening: projectStorageShapeHistory(turn.agentListening!),
      })),
    };
    const result = input.turns[0]!.agentListening.records.find(
      (record) =>
        record.kind === "tool_result" &&
        (record.result?.result as { content?: { action?: string } })?.content
          ?.action === "list-features",
    )!;
    if (result.kind !== "tool_result")
      throw new Error("Missing inventory result");
    const content = (
      result.result?.result as {
        content: { inventory: Record<string, unknown[]> };
      }
    ).content;
    const table = content.inventory;
    const rows = table.features as unknown[][];
    const first = (name: string) => table[name]![0] as Record<string, unknown>;
    if (fault === "index") rows[0]![4] = 100;
    if (fault === "width") rows[0]!.pop();
    if (fault === "columns") table.featureFields!.reverse();
    if (fault === "alignment") first("segments").alignment = 100;
    if (fault === "metadata")
      (first("metadata").shape as Record<string, unknown>).units = "wrong";
    if (fault === "duplicate") rows[1]![0] = rows[0]![0];
    if (fault === "owner") first("provenance").entryId = "foreign";
    if (fault === "pass") first("sources").passId = "foreign";
    expect(() => verifyStorageShape(input, 20)).toThrow();
  });
  it("allows different native acquisition counts and support values while validating each inventory", () => {
    const f = fixture();
    const metric = f.shapes[1]!.metrics.find(
      ({ metric }) => metric === "spectral-centroid",
    )!;
    metric.expectedRecords++;
    metric.retainedRecords++;
    f.restoredShapes[1]!.metrics = structuredClone(f.shapes[1]!.metrics);
    f.featureGroups[1]![0]!.record.feature.coveredSamples--;
    f.restoredFeatures[1]![0]!.record.feature.coveredSamples--;
    expect(f.featureGroups[0]![0]!.record.feature).not.toHaveProperty("values");
    expect(() => verifyStorageShape(f.input, 1)).not.toThrow();
  });
  it.each([
    "schema",
    "count",
    "missing",
    "context-owner",
    "source",
    "capture-tool",
    "queued",
    "truncated-inventory",
    "definition",
    "grid",
    "restart-id",
    "restart-count",
    "restart-missing",
    "hidden-capture",
    "cancelled",
  ] as const)("fails independently for %s", (fault) => {
    const f = fixture();
    if (fault === "schema") {
      f.shapes[1]!.schema = "metric-audio-observation/v1";
      f.restoredShapes[1]!.schema = f.shapes[1]!.schema;
    }
    if (fault === "count") f.shapes[0]!.metrics[0]!.expectedRecords = 0;
    if (fault === "missing") f.shapes[0]!.metrics[0]!.missingRecords = 1;
    if (fault === "context-owner") f.shapes[0]!.contextId = "foreign";
    if (fault === "source")
      Reflect.set(f.session.captures[0]!.source, "trackId", "foreign");
    if (fault === "capture-tool")
      f.session.agentListening!.records.splice(0, 2);
    if (fault === "queued") {
      const result = f.session.agentListening!.records.find(
        (r) => r.kind === "tool_result",
      )!;
      result.result = {
        result: {
          content: {
            action: "play-session-and-listen",
            job: {
              passId: "pass-0",
              stage: "queued",
              contextIds: ["context-0"],
            },
          },
        },
      };
    }
    if (fault === "truncated-inventory") {
      const result = f.restart.agentListening!.records.find(
        (r) => r.kind === "tool_result",
      )!;
      result.result = { result: { content: "[truncated]" } };
    }
    const inventory = (turn: TurnEvidence) => {
      for (const record of turn.agentListening!.records) {
        if (record.kind !== "tool_result") continue;
        const content = (record.result?.result as { content?: unknown })
          ?.content as {
          action: string;
          inventory: ReturnType<typeof projectListeningFeatureInventory>;
        };
        if (content.action === "list-features") return content.inventory;
      }
      throw new Error("Missing controlled feature inventory");
    };
    if (fault === "definition")
      inventory(f.session).metadata[0]!.type = "level-grid/v1";
    if (fault === "grid")
      inventory(f.session).metadata.find(
        (feature) => feature.grid,
      )!.grid!.cellCount = 15;
    if (fault === "restart-id")
      inventory(f.restart).features[0]!.id = "changed";
    if (fault === "restart-count")
      f.restoredShapes[0]!.metrics[0]!.retainedRecords--;
    if (fault === "restart-missing")
      Reflect.set(f.input.evidence!, "storageShapes", []);
    if (fault === "hidden-capture")
      Reflect.set(f.input.evidence!, "capturePassIds", [
        "pass-0",
        "pass-1",
        "hidden",
      ]);
    if (fault === "cancelled") Reflect.set(f.session, "status", "cancelled");
    expect(() => verifyStorageShape(f.input, 1)).toThrow();
    expect(
      createDefaultAssertions().evaluate(
        { name: "storage-shape", parameters: { expectedMeasures: 1 } },
        f.input,
      ),
    ).toMatchObject({ passed: false, code: "storage-shape-invalid" });
  });
  it("rejects numerical-equivalence parameters", () => {
    expect(() =>
      createDefaultAssertions().validate({
        name: "storage-shape",
        parameters: { expectedMeasures: 1, calibrationId: "not-used" },
      }),
    ).toThrow();
  });
});
