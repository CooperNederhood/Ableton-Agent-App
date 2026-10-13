import { describe, expect, it } from "vitest";
import {
  desktopListeningJobSchema,
  desktopListeningListRequestSchema,
  desktopListeningPageSchema,
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
