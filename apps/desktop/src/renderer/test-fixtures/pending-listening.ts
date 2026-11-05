import { summarizeMetricListeningResult } from "@ableton-agent/protocol";
import { createSyntheticPartialMetricListeningObservation } from "@ableton-agent/protocol/testing";
import type {
  DesktopActiveAgent,
  DesktopAppEvent,
  OperationView,
} from "../../contracts.js";
import type {
  DesktopListeningJob,
  DesktopListeningPage,
} from "../../listening-contracts.js";
import { listeningFailureFixture } from "./listening-failure.js";

export type ListeningStartAction =
  "play-session-and-listen" | "play-arrangement-and-listen";
export type ListeningTerminalStage =
  "completed" | "partial" | "failed" | "cancelled";

// UI-only lifecycle fixtures, not SDK execution or measured audio evidence.
export function pendingListeningFixture(
  owner: { sessionId: string; liveSetId: string; agent: DesktopActiveAgent },
  action: ListeningStartAction,
  stage: "queued" | "capturing" | "persisting" | ListeningTerminalStage,
  revision: number,
) {
  const terminal = !["queued", "capturing", "persisting"].includes(stage);
  const outcome =
    stage === "failed" || stage === "cancelled" ? stage : "completed";
  const status = terminal ? outcome : "running";
  const passId = `synthetic-pending-${action}`;
  const job: DesktopListeningJob = {
    passId,
    sessionId: owner.sessionId,
    liveSetId: owner.liveSetId,
    agentId: owner.agent.id,
    trace: {
      traceId: owner.agent.id,
      correlationId: "synthetic-pending-call",
      causationId: "synthetic-tool-call",
    },
    stage,
    createdAt: "2026-10-12T00:00:00.000Z",
    updatedAt: new Date(Date.UTC(2026, 9, 12, 0, 0, revision)).toISOString(),
    durationMs: 1250,
    contextIds:
      stage === "completed" || stage === "partial"
        ? ["synthetic-terminal-context-not-measured"]
        : [],
    cleanupPolicy: "leave-running",
    evidence: "lifecycle-only",
    ...(stage === "partial"
      ? {
          metricResults: [
            summarizeMetricListeningResult(
              createSyntheticPartialMetricListeningObservation(),
            ),
          ],
        }
      : {}),
    ...(stage === "failed"
      ? {
          error: "stale_native_preflight",
          failureEvidence: listeningFailureFixture(owner.agent.id, passId),
        }
      : {}),
  };
  const page: DesktopListeningPage = {
    sessionId: owner.sessionId,
    revision,
    jobs: [job],
  };
  const operation: OperationView = {
    id: `synthetic-call-${action}`,
    label: "Listen to synthetic source",
    toolName: "ableton_listening",
    action,
    status,
    detail: `Listening pass: ${stage}`,
    warnings: [],
    changed: [],
    unchanged: [],
    retryable: false,
    undoable: false,
    timestamp: revision,
    ...(terminal ? { durationMs: 1250 } : {}),
    ...(stage === "failed"
      ? {
          failure: {
            source: "tool" as const,
            code: "stale_native_preflight",
            message: "Synthetic native preflight failed",
            details: [],
            recovery:
              "Inspect the failure before explicitly requesting a new pass.",
          },
        }
      : {}),
  };
  const events: DesktopAppEvent[] = [
    { type: "listening.changed", page },
    {
      type: "operation.changed",
      agentInstanceId: owner.agent.id,
      operation,
    },
  ];
  if (stage === "queued" || terminal) {
    events.push(
      {
        type: "agent.instance_changed",
        instance: { ...owner.agent, lifecycle: terminal ? "ready" : "busy" },
        change: "lifecycle",
      },
      {
        type: "agent.working_update",
        agentInstanceId: owner.agent.id,
        messageId: "synthetic-listening-answer",
        update: terminal
          ? {
              kind: "finished",
              activityId: owner.agent.id,
              occurredAt: job.updatedAt,
              outcome,
            }
          : {
              kind: "started",
              activityId: owner.agent.id,
              occurredAt: job.createdAt,
            },
      },
    );
  }
  return { page, job, operation, events };
}
