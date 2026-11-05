import { createHash } from "node:crypto";
import {
  metricAudioObservationSchema,
  projectMetricListeningReport,
} from "@ableton-agent/protocol";
import { createSyntheticMetricListeningObservation } from "@ableton-agent/protocol/testing";
import type { AgentHistoryPage } from "@ableton-agent/observability";
import type { AssertionInput, TurnEvidence } from "./contracts.js";

export function agentListeningFixture(action: "get" | "report" = "get") {
  const sdkTurnId = "00000000-0000-4000-8000-000000000001";
  const passId = "1b295ab8-5018-4ce6-8966-8e6b4caf0454";
  const trackId = "00000000-0000-4000-8000-000000000002";
  const clipId = "00000000-0000-4000-8000-000000000003";
  const contextId = "context-1";
  const source = { trackId, clipId, slotIndex: 0, mediaSha256: "a".repeat(64) };
  const target = {
    view: "session" as const,
    track: {
      kind: "regular" as const,
      index: 0,
      expectedReference: trackId,
      expectedName: "audio-track",
    },
    sceneIndex: 0,
    expectedClipReference: clipId,
    expectedClipName: "clip-1",
  };
  const raw = createSyntheticMetricListeningObservation({
    endBeat: 4,
    tempoBpm: 128,
    startSample: 0,
  });
  raw.ownership.passId = passId;
  raw.ownership.correlationId = sdkTurnId;
  raw.source = {
    view: "session",
    target,
    clipReference: clipId,
    kind: "warped-audio",
    coordinate: { unit: "beats", iteration: 0, startBeat: 0, endBeat: 4 },
    transport: { startBeat: 0, endBeat: 4 },
    clipStartTimeBeats: 0,
    synchronization: "transport-coupled-first-iteration",
  };
  const observation = metricAudioObservationSchema.parse(raw);
  const owner = {
    appSessionId: "app",
    conversationId: "sdk",
    agentId: "default",
    sdkTurnId,
  };
  const base = {
    version: 1 as const,
    appSessionId: owner.appSessionId,
    agentSessionId: owner.conversationId,
    activeAgentId: owner.agentId,
    turnId: sdkTurnId,
    traceId: sdkTurnId,
    correlationId: sdkTurnId,
    causationId: "cause",
    recordedAt: "2026-11-05T00:00:10.000Z",
  };
  const start = {
    action: "play-session-and-listen",
    job: {
      passId,
      stage: "completed",
      contextIds: [contextId],
      createdAt: "2026-11-05T00:00:01.000Z",
      updatedAt: "2026-11-05T00:00:02.000Z",
      durationMs: 1000,
    },
  };
  const entry = {
    contextId,
    passId,
    listenerId: "listener",
    subjectId: trackId,
    kind: "metric-audio-observation/v1",
    createdAt: "2026-11-05T00:00:01.000Z",
    freshness: "fresh",
    summary: "Measured",
  };
  const context =
    action === "get"
      ? { action, entry, observation }
      : {
          action,
          entry,
          report: projectMetricListeningReport(observation, {
            offset: 0,
            limit: 8,
          }),
        };
  const records: AgentHistoryPage["items"] = [
    {
      ...base,
      kind: "tool_call",
      id: "call-start",
      toolCallId: "start",
      toolName: "ableton_listening",
      status: "completed",
      occurredAt: "2026-11-05T00:00:02.000Z",
      arguments: { action: start.action, target, listenerIds: ["listener"] },
      metadata: {},
    },
    {
      ...base,
      kind: "tool_result",
      id: "result-start",
      toolCallId: "start",
      occurredAt: "2026-11-05T00:00:02.000Z",
      outcome: "success",
      durationMs: 1000,
      result: { result: { content: start } },
      metadata: { toolName: "ableton_listening" },
    },
    {
      ...base,
      kind: "tool_call",
      id: "call-context",
      toolCallId: "context",
      toolName: "ableton_context",
      status: "completed",
      occurredAt: "2026-11-05T00:00:04.000Z",
      arguments: { action, contextId },
      metadata: {},
    },
    {
      ...base,
      kind: "tool_result",
      id: "result-context",
      toolCallId: "context",
      occurredAt: "2026-11-05T00:00:04.000Z",
      outcome: "success",
      durationMs: 500,
      result: { result: { content: context } },
      metadata: { toolName: "ableton_context" },
    },
    {
      ...base,
      kind: "message",
      id: "answer",
      occurredAt: "2026-11-05T00:00:05.000Z",
      role: "assistant",
      content: "Measured.",
      messageIndex: 1,
      metadata: { messageId: "assistant" },
    },
    {
      ...base,
      kind: "turn",
      id: "terminal",
      occurredAt: "2026-11-05T00:00:00.000Z",
      completedAt: "2026-11-05T00:00:06.000Z",
      status: "completed",
      metadata: {},
    },
  ];
  for (const record of records)
    if (record.kind === "tool_call" || record.kind === "tool_result") {
      record.correlationId = record.toolCallId;
      record.causationId = sdkTurnId;
    }
  const turn: TurnEvidence = {
    schemaVersion: 1,
    ...owner,
    userMessageId: "user",
    assistantMessageId: "assistant",
    operationId: "operation",
    terminal: true,
    status: "completed",
    assistantText: "Measured.",
    captures: [
      {
        passId,
        operationId: "operation",
        source,
        listenerId: "listener",
        complete: true,
        nonSilent: true,
        truncated: false,
        missingRecords: 0,
        metricFamilies: ["level", "spectral-centroid", "attacks"],
        sampleRate: 48000,
        startSample: 0,
        endSample: 90000,
        cleanupComplete: true,
        failure: null,
      },
    ],
    contexts: [
      {
        contextId,
        passId,
        source,
        contentSha256: createHash("sha256")
          .update(JSON.stringify(observation))
          .digest("hex"),
        readable: true,
        afterOwnedRestart: false,
      },
    ],
    facts: { sdkTurnId },
    agentListening: { ...owner, afterOwnedRestart: false, records },
  };
  const input: AssertionInput = {
    fixture: {
      schemaVersion: 1,
      id: "synthetic",
      qualification: "synthetic-only",
      provenance: {
        ownership: "authored",
        description: "Synthetic agent consumption, not real DSP",
      },
      resources: [],
      dependencies: [],
      baseline: {},
    },
    baseline: {
      schemaVersion: 1,
      facts: {},
      dependencyHashes: {},
      sources: {
        a: {
          source,
          listenerId: "listener",
          loadedMediaPath: "/owned/source.wav",
          facts: {},
        },
      },
    },
    turns: [turn],
    turn,
  };
  return { input, turn, owner, records, start, context, passId, contextId };
}

export function agentHistoryPage(
  items: AgentHistoryPage["items"],
  nextCursor?: string,
  totalItems = items.length,
): AgentHistoryPage {
  return {
    version: 1,
    items,
    ...(nextCursor ? { nextCursor } : {}),
    page: {
      limit: 100,
      returnedItems: items.length,
      totalItems,
      hasMore: nextCursor !== undefined,
      order: "asc",
    },
  };
}
