import { describe, expect, it } from "vitest";
import {
  createSyntheticMetricListeningObservation,
  createSyntheticPartialMetricListeningObservation,
} from "@ableton-agent/protocol/testing";
import {
  projectMetricListeningReport,
  summarizeMetricListeningResult,
} from "@ableton-agent/protocol";
import {
  listeningHistoryResult,
  MAX_LISTENING_HISTORY_RESULT_BYTES,
} from "./listening-history.js";

function context(action: "get" | "report") {
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
          limit: 32,
        }),
      };
}

describe("typed listening SDK result History projection", () => {
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
      expect(
        listeningHistoryResult("ableton_listening", {
          content: JSON.stringify(body),
        }),
      ).toEqual({ result: { content: body } });
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
