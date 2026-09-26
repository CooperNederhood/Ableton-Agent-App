import { describe, expect, it } from "vitest";

import {
  DEFAULT_MAX_DATABASE_BYTES,
  DEFAULT_QUERY_LIMIT,
  DEFAULT_RETENTION_DAYS,
  MAX_SANITIZED_DEPTH,
  MAX_SANITIZED_STRING_CHARACTERS,
  agentHistoryQuerySchema,
  agentMessageHistoryRecordSchema,
  configurationSnapshotSchema,
  retentionPolicySchema,
  setSnapshotHistoryRecordSchema,
  telemetryEventEnvelopeSchema,
  telemetryQuerySchema,
} from "./contracts.js";

const validEvent = {
  version: 2,
  id: "00000000-0000-4000-8000-000000000001",
  occurredAt: "2026-08-29T18:00:00-04:00",
  name: "tool.completed",
  category: "tool",
  source: "agent.runtime",
  stage: "completed",
  level: "info",
  outcome: "success",
  durationMs: 42,
  correlationId: "correlation-1",
  sessionId: "session-1",
  activeAgentId: "agent-1",
  toolName: "set_tempo",
  attributes: {
    feature: "set_tempo",
    platform: "darwin",
    requestId: "request-1",
    retries: 0,
  },
} as const;

describe("observability contracts", () => {
  it("validates and normalizes a versioned sanitized event envelope", () => {
    expect(telemetryEventEnvelopeSchema.parse(validEvent)).toEqual({
      ...validEvent,
      occurredAt: "2026-08-29T22:00:00.000Z",
    });
  });

  it("rejects unknown envelope fields and non-JSON attributes", () => {
    expect(
      telemetryEventEnvelopeSchema.safeParse({
        ...validEvent,
        prompt: "make a track",
      }).success,
    ).toBe(false);
    expect(
      telemetryEventEnvelopeSchema.safeParse({
        ...validEvent,
        attributes: { value: Number.NaN },
      }).success,
    ).toBe(false);
    expect(
      telemetryEventEnvelopeSchema.safeParse({
        ...validEvent,
        attributes: { value: 1n },
      }).success,
    ).toBe(false);
  });

  it("bounds nested sanitized metadata", () => {
    expect(
      telemetryEventEnvelopeSchema.safeParse({
        ...validEvent,
        attributes: {
          value: Array.from({ length: MAX_SANITIZED_DEPTH + 2 }).reduceRight(
            (child) => ({ child }),
            { complete: true } as Record<string, unknown>,
          ),
        },
      }).success,
    ).toBe(false);
    expect(
      telemetryEventEnvelopeSchema.safeParse({
        ...validEvent,
        attributes: {
          value: "x".repeat(MAX_SANITIZED_STRING_CHARACTERS + 1),
        },
      }).success,
    ).toBe(false);
  });

  it("validates configuration snapshots under the same privacy constraints", () => {
    expect(
      configurationSnapshotSchema.parse({
        version: 2,
        liveSetId: "live-set-1",
        liveProjectId: "live-project-1",
        id: "00000000-0000-4000-8000-000000000002",
        capturedAt: "2026-08-29T22:00:00.000Z",
        component: "agent.runtime",
        configurationVersion: "2",
        values: { telemetry_enabled: false, batch_size: 64 },
      }),
    ).toMatchObject({
      component: "agent.runtime",
      liveSetId: "live-set-1",
      liveProjectId: "live-project-1",
      values: { telemetry_enabled: false },
    });
  });

  it("provides bounded query and retention defaults", () => {
    expect(telemetryQuerySchema.parse({})).toMatchObject({
      limit: DEFAULT_QUERY_LIMIT,
      order: "desc",
    });
    expect(retentionPolicySchema.parse({})).toEqual({
      maxAgeDays: DEFAULT_RETENTION_DAYS,
      maxBytes: DEFAULT_MAX_DATABASE_BYTES,
    });
    expect(
      telemetryQuerySchema.safeParse({
        from: "2026-08-30T00:00:00.000Z",
        to: "2026-08-29T00:00:00.000Z",
      }).success,
    ).toBe(false);
  });

  it("rejects the former project attribution field", () => {
    expect(
      telemetryEventEnvelopeSchema.safeParse({
        ...validEvent,
        projectId: "live-set-1",
      }).success,
    ).toBe(false);
  });

  it("validates bounded typed agent and Set history contracts", () => {
    expect(
      agentMessageHistoryRecordSchema.parse({
        version: 1,
        kind: "message",
        id: "message-1",
        appSessionId: "app-session-1",
        agentSessionId: "agent-session-1",
        activeAgentId: "agent-1",
        occurredAt: "2026-08-29T18:00:00-04:00",
        role: "assistant",
        content: "Created the requested clip.",
        messageIndex: 0,
      }),
    ).toMatchObject({
      occurredAt: "2026-08-29T22:00:00.000Z",
      metadata: {},
    });
    expect(
      setSnapshotHistoryRecordSchema.safeParse({
        version: 1,
        kind: "set_snapshot",
        id: "snapshot-1",
        liveSetId: "live-set-1",
        occurredAt: "2026-08-29T22:00:00.000Z",
        snapshotKind: "core",
        snapshot: {},
      }).success,
    ).toBe(true);
    expect(
      agentHistoryQuerySchema.parse({ kinds: ["tool_call"], limit: 10 }),
    ).toMatchObject({ limit: 10, order: "desc" });
  });
});
