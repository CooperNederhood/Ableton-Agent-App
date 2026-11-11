import { describe, expect, it, vi } from "vitest";
import { createAgentHooks } from "@ableton-agent/application";
import {
  createSyntheticMetricListeningObservation,
  createSyntheticPartialMetricListeningObservation,
} from "@ableton-agent/protocol/testing";
import {
  projectMetricListeningReport,
  summarizeMetricListeningResult,
  extractPeakFeature,
  type MetricAudioObservation,
} from "@ableton-agent/protocol";
import {
  createListeningTools,
  contextOperationParamsSchema,
  contextOperationResultSchema,
  MAX_METRIC_CONTEXT_RESPONSE_BYTES,
  projectListeningFeatureRecord,
  FEATURE_VALUE_DETAIL_GUIDANCE,
  METRIC_REPORT_PAGE_GUIDANCE,
} from "@ableton-agent/tools";
const { denseSyntheticMetricObservation } = await vi.importActual<{
  denseSyntheticMetricObservation(this: void): MetricAudioObservation;
}>("../../tools/src/listening-report-test-support.js");
import {
  listeningHistoryResult,
  MAX_LISTENING_HISTORY_RESULT_BYTES,
} from "./listening-history.js";

function context(action: "get" | "report", limit = 32) {
  const observation = createSyntheticMetricListeningObservation({
    endBeat: 16,
  });
  const entry = {
    contextId: "context",
    passId: observation.ownership.passId,
    listenerId: observation.ownership.listenerId,
    subjectId: "subject",
    kind: observation.schema,
    createdAt: "2026-11-05T00:00:00.000Z",
    freshness: "fresh",
    summary: "Measured",
  };
  return action === "get"
    ? { action, entry, observation }
    : {
        action,
        entry,
        report: projectMetricListeningReport(observation, {
          offset: 0,
          limit,
        }),
      };
}

describe("typed listening SDK result History projection", () => {
  it("retains typed feature derivation outcomes while redacting embedded credentials", () => {
    const body = {
      action: "derive-features",
      derivations: [
        {
          entryId: "entry",
          status: "unavailable",
          definitionSet: "stored-listening/v1",
          reason: "Source rejected token=feature-secret-credential",
          featureCount: 0,
        },
      ],
    };
    const result = listeningHistoryResult("ableton_context", {
      content: JSON.stringify(body),
    });
    expect(result).toMatchObject({
      result: {
        content: {
          action: "derive-features",
          derivations: [
            { entryId: "entry", status: "unavailable", featureCount: 0 },
          ],
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("feature-secret-credential");
    expect(JSON.stringify(result)).toContain("REDACTED");
  });
  const guidance =
    "Use the verified tool result as observed state. Re-inspect before any dependent mutation when the project may have changed.";
  const suffix = (toolName: string) =>
    `\n\nTool "${toolName}" succeeded. Additional guidance from postToolUse hooks:\n${guidance}`;
  it.each([1, 32])(
    "preserves report pages (limit %i) with the actual continuation hook and rejects forged suffixes",
    async (limit) => {
      const body = context("report", limit);
      body.entry.summary = "Measured token=report-secret-credential";
      const hooks = createAgentHooks({
        getAbletonStatus: async () => ({ state: "disconnected" }),
      });
      const hook = await hooks.onPostToolUse?.(
        {
          sessionId: "sdk",
          timestamp: new Date(),
          workingDirectory: "/tmp",
          toolName: "ableton_context",
          toolArgs: { action: "report" },
          toolResult: {
            resultType: "success",
            textResultForLlm: JSON.stringify(body),
          },
        },
        { sessionId: "sdk" },
      );
      expect(hook?.additionalContext).toBe(
        `${guidance}\n${METRIC_REPORT_PAGE_GUIDANCE}`,
      );
      const tail = `\n\nTool "ableton_context" succeeded. Additional guidance from postToolUse hooks:\n${hook?.additionalContext}`;
      expect(
        listeningHistoryResult("ableton_context", {
          content: JSON.stringify(body) + tail,
        }),
      ).toEqual(
        listeningHistoryResult("ableton_context", {
          content: JSON.stringify(body),
        }),
      );
      expect(
        JSON.stringify(
          listeningHistoryResult("ableton_context", {
            content: JSON.stringify(body) + tail,
          }),
        ),
      ).not.toContain("report-secret-credential");
      for (const [value, ending] of [
        [context("get"), tail],
        [body, tail + tail],
        [body, tail.replace("not offset + limit", "offset + limit")],
        [
          body,
          tail.replace('Tool "ableton_context"', 'Tool "ableton_listening"'),
        ],
      ] as const) {
        expect(
          listeningHistoryResult("ableton_context", {
            content: JSON.stringify(value) + ending,
          }),
        ).toMatchObject({
          result: { content: { error: "history_projection_unavailable" } },
        });
      }
    },
  );
  it.each(["list-features", "compare-features", "search-features"] as const)(
    "retains typed %s metadata with the actual conditional value-read hook suffix",
    async (action) => {
      const observation = createSyntheticMetricListeningObservation();
      const feature = extractPeakFeature(observation);
      const view = {
        record: projectListeningFeatureRecord({
          id: "feature",
          entryId: "context",
          segmentId: "segment",
          sessionId: "session",
          liveSetId: "set",
          sourceFingerprint: "a".repeat(64),
          createdAt: "2026-11-06T00:00:00.000Z",
          trace: {
            traceId: "00000000-0000-4000-8000-000000000001",
            correlationId: "query",
            causationId: "call",
          },
          feature,
        }),
        segment: {
          id: "segment",
          entryId: "context",
          sessionId: "session",
          liveSetId: "set",
          order: 0,
          kind: "unaligned",
          coordinate: "transport-beats",
          startBeat: 0,
          endBeat: 4,
          startSample: 0,
          endSample: observation.geometry.totalSamples,
          sampleRate: feature.sampleRate,
          alignmentReason: "musical-bar-alignment-not-established",
        },
        source: context("report").entry,
      };
      const body = contextOperationResultSchema.parse(
        action === "list-features"
          ? { action, features: [view] }
          : action === "compare-features"
            ? { action, comparisons: [] }
            : {
                action,
                query: view,
                matches: [{ feature: view, distance: 0 }],
                distanceDefinition: feature.distanceDefinition,
                distanceUnits: feature.distanceUnits,
                scannedCount: 1,
                comparableCount: 1,
                eligibleCount: 1,
                excludedCount: 0,
                exhaustive: true,
                limitsHit: [],
                exclusionReasons: {},
              },
      );
      const serialized = JSON.stringify(body);
      const hooks = createAgentHooks({
        getAbletonStatus: async () => {
          throw new Error("Post-tool guidance must not inspect Live");
        },
      });
      const result = await hooks.onPostToolUse?.(
        {
          sessionId: "sdk",
          timestamp: new Date(),
          workingDirectory: "/tmp",
          toolName: "ableton_context",
          toolArgs: { action },
          toolResult: { resultType: "success", textResultForLlm: serialized },
        },
        { sessionId: "sdk" },
      );
      expect(result?.additionalContext).toBe(
        `${guidance}\n${FEATURE_VALUE_DETAIL_GUIDANCE}`,
      );
      const frame =
        serialized +
        `\n\nTool "ableton_context" succeeded. Additional guidance from postToolUse hooks:\n${result?.additionalContext}`;
      expect(
        listeningHistoryResult("ableton_context", { content: frame }),
      ).toEqual({
        result: { content: body },
      });
      expect(JSON.stringify(body)).toBe(serialized);
      expect(view.record.feature).not.toHaveProperty("values");
      for (const altered of [
        frame + "\nUnexpected guidance",
        frame + suffix("ableton_context"),
        frame.replace('Tool "ableton_context"', 'Tool "ableton_listening"'),
        serialized.slice(0, -1) + frame.slice(serialized.length),
      ]) {
        expect(
          listeningHistoryResult("ableton_context", { content: altered }),
        ).toMatchObject({
          result: {
            content: {
              error: "history_projection_unavailable",
              reason: "malformed_json",
            },
          },
        });
      }
    },
  );
  it("rejects feature-summary guidance attached to a non-summary result", () => {
    expect(
      listeningHistoryResult("ableton_context", {
        content:
          JSON.stringify(context("report")) +
          suffix("ableton_context") +
          `\n${FEATURE_VALUE_DETAIL_GUIDANCE}`,
      }),
    ).toMatchObject({
      result: {
        content: {
          error: "history_projection_unavailable",
          reason: "invalid_typed_result",
        },
      },
    });
  });
  it("retains dense all-six-family report pages from the actual agent handler as typed History with native units and supports", async () => {
    const observation = denseSyntheticMetricObservation();
    const entry = {
      contextId: "dense-context",
      passId: observation.ownership.passId,
      listenerId: observation.ownership.listenerId,
      subjectId: "subject",
      kind: observation.schema,
      createdAt: "2026-11-06T00:00:00.000Z",
      freshness: "fresh" as const,
      summary: "Synthetic original measurement",
    };
    const [, tool] = createListeningTools({
      executeListeningOperation: async () => ({
        action: "inspect-listeners",
        listeners: [],
        truncated: false,
      }),
      executeContextOperation: async (request) => {
        if (request.action !== "report")
          throw new Error("Expected original report read");
        return {
          action: "report",
          entry,
          report: projectMetricListeningReport(observation, request),
        };
      },
    });
    const raw = { action: "get", entry, observation };
    expect(Buffer.byteLength(JSON.stringify(raw))).toBeGreaterThan(
      MAX_METRIC_CONTEXT_RESPONSE_BYTES,
    );
    let offset: number | null = 0;
    const rows: number[] = [];
    while (offset !== null) {
      const request = contextOperationParamsSchema.parse({
        action: "report",
        contextId: entry.contextId,
        offset,
      });
      const body = contextOperationResultSchema.parse(
        await tool.handler?.(request, {
          sessionId: "sdk",
          toolCallId: `dense-report-${offset}`,
          toolName: "ableton_context",
          arguments: request,
        }),
      );
      if (body.action !== "report")
        throw new Error("Expected original report result");
      const sdkContent = JSON.stringify(body) + suffix("ableton_context");
      expect(Buffer.byteLength(sdkContent)).toBeLessThan(
        MAX_METRIC_CONTEXT_RESPONSE_BYTES,
      );
      expect(
        listeningHistoryResult("ableton_context", { content: sdkContent }),
      ).toEqual({ result: { content: body } });
      expect(body.report.metricMetadata.pitch?.profile.units).toBe("Hz");
      expect(body.report.metricMetadata.pitch?.profile.confidenceUnits).toBe(
        "algorithm-score-not-probability",
      );
      expect(
        body.report.metricMetadata["spectral-shape"]?.profile.flatness,
      ).toContain("20log10");
      expect(
        body.report.metricMetadata["spectral-shape"]?.trailingSupport,
      ).toEqual(observation.metrics["spectral-shape"]?.trailingSupport);
      for (const row of body.report.rows) {
        rows.push(row.index);
        for (const frame of row["spectral-shape"]!.frames)
          expect(frame).toEqual(
            observation.metrics["spectral-shape"]!.frames[frame.index],
          );
        for (const frame of row.pitch!.frames)
          expect(frame).toEqual(observation.metrics.pitch!.frames[frame.index]);
      }
      offset = body.report.nextOffset;
    }
    expect(rows).toEqual(observation.rows.map((row) => row.index));
  });
  it("never treats an SDK spill-file notice or its JSON preview as a successful original-measurement read", () => {
    expect(
      listeningHistoryResult("ableton_context", {
        content:
          'Output too large to read at once. Saved to: <unread-spill-file> Preview: {"action":"get"}',
      }),
    ).toEqual({
      result: {
        content: {
          error: "history_projection_unavailable",
          reason: "malformed_json",
        },
      },
    });
  });
  it.each(["ableton_listening", "ableton_context"])(
    "decodes the observed SDK post-tool hook frame for %s",
    (toolName) => {
      const body =
        toolName === "ableton_context"
          ? context("report")
          : { action: "inspect-listeners", listeners: [], truncated: false };
      expect(
        listeningHistoryResult(toolName, {
          content: JSON.stringify(body) + suffix(toolName),
        }),
      ).toEqual({ result: { content: body } });
    },
  );
  it.each([
    (json: string) => json + suffix("ableton_listening"),
    (json: string) =>
      json + suffix("ableton_context") + "\nUnexpected guidance",
    (json: string) =>
      json + suffix("ableton_context") + suffix("ableton_context"),
    (json: string) => json.slice(0, -1) + suffix("ableton_context"),
  ])(
    "rejects foreign, altered, duplicate or truncated hook-framed JSON",
    (frame) => {
      expect(
        listeningHistoryResult("ableton_context", {
          content: frame(JSON.stringify(context("get"))),
        }),
      ).toEqual({
        result: {
          content: {
            error: "history_projection_unavailable",
            reason: "malformed_json",
          },
        },
      });
    },
  );
  it("does not interpret hook-like text within a valid JSON field", () => {
    const body = context("get");
    body.entry.summary = suffix("ableton_context");
    expect(
      listeningHistoryResult("ableton_context", {
        content: JSON.stringify(body) + suffix("ableton_context"),
      }),
    ).toEqual({ result: { content: body } });
  });
  it("parses bounded JSON even beyond the generic journal string limit without retaining that string", () => {
    const body = context("get");
    const content = `${" ".repeat(256 * 1024)}${JSON.stringify(body)}`;
    expect(listeningHistoryResult("ableton_context", { content })).toEqual({
      result: { content: body },
    });
  });
  it.each(["get", "report"] as const)(
    "decodes %s before generic string bounds rather than retaining JSON text",
    (action) => {
      const body = context(action);
      const text = JSON.stringify(body);
      expect(text.length).toBeGreaterThan(16_384);
      expect(
        listeningHistoryResult("ableton_context", { content: text }),
      ).toEqual({
        result: { content: body },
      });
    },
  );
  it.each([
    "completed",
    "partial",
    "failed",
    "cancelled",
    "interrupted",
  ] as const)(
    "preserves terminal %s public job without changing SDK outcomes",
    (stage) => {
      const body = {
        action: "play-session-and-listen",
        job: {
          passId: "pass",
          stage,
          createdAt: "2026-11-05T00:00:00.000Z",
          updatedAt: "2026-11-05T00:00:01.000Z",
          durationMs: 1000,
          contextIds: ["completed", "partial"].includes(stage)
            ? ["context"]
            : [],
          ...(stage === "partial"
            ? {
                metricResults: [
                  summarizeMetricListeningResult(
                    createSyntheticPartialMetricListeningObservation(),
                  ),
                ],
              }
            : {}),
        },
      };
      for (const tail of ["", suffix("ableton_listening")]) {
        expect(
          listeningHistoryResult("ableton_listening", {
            content: JSON.stringify(body) + tail,
          }),
        ).toEqual({ result: { content: body } });
      }
    },
  );
  it.each([
    [undefined, "missing_sdk_content"],
    [{ content: "not JSON" }, "malformed_json"],
    [{ content: '{"action":"get","entry":{}}' }, "invalid_typed_result"],
    [
      { content: "x".repeat(MAX_LISTENING_HISTORY_RESULT_BYTES + 1) },
      "result_byte_limit",
    ],
    [
      {
        content: JSON.stringify({ action: "get", audioBody: "private-audio" }),
      },
      "invalid_typed_result",
    ],
  ])(
    "retains explicit unavailable evidence for malformed/oversize input",
    (input, reason) => {
      const projected = listeningHistoryResult("ableton_context", input);
      expect(projected).toEqual({
        result: {
          content: { error: "history_projection_unavailable", reason },
        },
      });
      expect(JSON.stringify(projected)).not.toContain("private-audio");
    },
  );
  it("redacts every retained string after typed parsing without keeping a duplicate raw JSON body", () => {
    const body = context("get");
    body.entry.summary = ["Bearer", "synthetic-private"].join(" ");
    const result = listeningHistoryResult("ableton_context", {
      content: JSON.stringify(body),
    });
    expect(JSON.stringify(result)).toContain("[REDACTED]");
    expect(JSON.stringify(result)).not.toContain("synthetic-private");
  });
  it("does not reinterpret unrelated tool results", () => {
    expect(
      listeningHistoryResult("ableton_session", { content: "ordinary text" }),
    ).toEqual({ result: { content: "ordinary text" } });
  });
});
