import { describe, expect, it } from "vitest";
import { listeningFailureFixture } from "./renderer/test-fixtures/listening-failure.js";
import { summarizeMetricListeningResult } from "@ableton-agent/protocol";
import { createSyntheticPartialMetricListeningObservation } from "@ableton-agent/protocol/testing";
import {
  desktopListeningJobSchema,
  desktopListeningListRequestSchema,
  desktopListeningPageSchema,
  listeningTerminal,
} from "./listening-contracts.js";
const id = "00000000-0000-4000-8000-000000000001";
const job = {
  passId: "synthetic-contract-pass",
  sessionId: "session",
  liveSetId: "set",
  agentId: id,
  trace: { traceId: id, correlationId: "synthetic", causationId: "fixture" },
  stage: "queued",
  createdAt: "2026-10-12T00:00:00.000Z",
  updatedAt: "2026-10-12T00:00:00.000Z",
  durationMs: 0,
  contextIds: [],
  cleanupPolicy: "leave-running",
  evidence: "lifecycle-only",
};
describe("Desktop listening wire contracts", () => {
  it("accepts only published partial results with honest bounded metric coverage", () => {
    const metricResults = [
      summarizeMetricListeningResult(
        createSyntheticPartialMetricListeningObservation(),
      ),
    ];
    const partial = {
      ...job,
      stage: "partial",
      contextIds: ["context"],
      metricResults,
    };
    expect(desktopListeningJobSchema.parse(partial)).toEqual(partial);
    expect(listeningTerminal("partial")).toBe(true);
    for (const invalid of [
      { ...partial, metricResults: undefined },
      { ...partial, contextIds: [] },
      { ...partial, error: "Cleanup uncertain" },
      { ...partial, stage: "completed" },
      {
        ...partial,
        metricResults: metricResults.map((result) => ({
          ...result,
          outcome: "complete",
        })),
      },
    ])
      expect(desktopListeningJobSchema.safeParse(invalid).success).toBe(false);
  });
  it("carries only bounded shared evidence correlated to the owning pass and trace", () => {
    const failureEvidence = listeningFailureFixture(id, job.passId);
    const failed = { ...job, stage: "failed", failureEvidence };
    expect(desktopListeningJobSchema.parse(failed)).toEqual(failed);
    for (const invalid of [
      { ...failureEvidence, rawNativeJson: "{}" },
      { ...failureEvidence, facts: Array(25).fill(failureEvidence.facts[0]) },
      { ...failureEvidence, summary: "x".repeat(1025) },
      {
        ...failureEvidence,
        reference: { ...failureEvidence.reference, passId: "foreign" },
      },
      {
        ...failureEvidence,
        reference: {
          ...failureEvidence.reference,
          traceId: "00000000-0000-4000-8000-000000000002",
        },
      },
    ])
      expect(
        desktopListeningJobSchema.safeParse({
          ...failed,
          failureEvidence: invalid,
        }).success,
      ).toBe(false);
  });
  it("bounds jobs and typed read scopes without raw bodies, arbitrary actors or SQL/paths", () => {
    expect(desktopListeningJobSchema.parse(job)).toEqual(job);
    for (const extra of [
      { audio: new Uint8Array(3) },
      { samples: [1, 2] },
      { raw: "body" },
    ])
      expect(() =>
        desktopListeningJobSchema.parse({ ...job, ...extra }),
      ).toThrow();
    expect(() =>
      desktopListeningJobSchema.parse({ ...job, error: "x".repeat(2049) }),
    ).toThrow();
    expect(() =>
      desktopListeningJobSchema.parse({ ...job, cleanupPolicy: "stop-owned" }),
    ).toThrow();
    expect(() =>
      desktopListeningPageSchema.parse({
        sessionId: "session",
        revision: 0,
        jobs: Array.from({ length: 101 }, () => job),
      }),
    ).toThrow();
    for (const extra of [
      { sql: "select *" },
      { path: "/private" },
      { actorKind: "application" },
      { limit: 101 },
    ])
      expect(() =>
        desktopListeningListRequestSchema.parse({
          sessionId: "session",
          agentId: id,
          ...extra,
        }),
      ).toThrow();
    expect(
      desktopListeningListRequestSchema.parse({
        sessionId: "session",
        agentId: id,
      }).limit,
    ).toBe(100);
  });
});
