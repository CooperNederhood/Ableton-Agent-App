import type { AppEvent } from "@ableton-agent/shared";

import { appEventSchema, type DesktopAppEvent } from "../contracts.js";

type DesktopSharedEvent = Exclude<
  AppEvent,
  { type: "ableton.project_mutated" }
>;

function desktopToolName(toolName: string | undefined): string | undefined {
  const bounded = toolName?.slice(0, 128);
  return bounded === "" ? undefined : bounded;
}

export function normalizeSharedEvent(
  event: DesktopSharedEvent,
  messageId: () => string,
): DesktopAppEvent {
  const toolName =
    "toolName" in event ? desktopToolName(event.toolName) : undefined;
  const normalized =
    event.type === "agent.message_delta"
      ? { ...event, messageId: messageId() }
      : event.type === "agent.message_complete"
        ? { ...event, messageId: messageId() }
        : event.type === "agent.working_update"
          ? { ...event, messageId: messageId() }
          : event.type === "agent.plan_approval_requested"
            ? {
                ...event,
                request: {
                  ...event.request,
                  actions: [...event.request.actions],
                },
              }
            : event.type === "agent.sdk_session_rotated"
              ? {
                  type: "diagnostic",
                  level: "warning",
                  message: `Agent ${event.agentInstanceId} rotated its Copilot session.`,
                }
              : event.type === "ableton.event_received"
                ? {
                    type: "diagnostic",
                    level: "info",
                    message: `Ableton event ${event.event} (#${event.sequence})`,
                  }
                : event.type === "ableton.event_gap"
                  ? {
                      type: "diagnostic",
                      level: "warning",
                      message: `Ableton event gap: expected #${event.expectedSequence}, received #${event.receivedSequence}`,
                    }
                  : event.type === "operation.started"
                    ? {
                        type: "operation.changed",
                        operation: {
                          id: event.operationId,
                          label: event.label,
                          ...(toolName === undefined ? {} : { toolName }),
                          status: "running",
                          warnings: [],
                          changed: [],
                          unchanged: [],
                          retryable: false,
                          undoable: false,
                          timestamp: Date.now(),
                        },
                        ...(event.agentInstanceId === undefined
                          ? {}
                          : { agentInstanceId: event.agentInstanceId }),
                        ...(event.sdkSessionId === undefined
                          ? {}
                          : { sdkSessionId: event.sdkSessionId }),
                      }
                    : event.type === "operation.completed"
                      ? {
                          type: "operation.changed",
                          operation: {
                            id: event.operationId,
                            label: event.summary,
                            ...(toolName === undefined ? {} : { toolName }),
                            status: "completed",
                            warnings: [],
                            changed: [event.summary],
                            unchanged: [],
                            retryable: false,
                            undoable: false,
                            timestamp: Date.now(),
                          },
                          ...(event.agentInstanceId === undefined
                            ? {}
                            : { agentInstanceId: event.agentInstanceId }),
                          ...(event.sdkSessionId === undefined
                            ? {}
                            : { sdkSessionId: event.sdkSessionId }),
                        }
                      : event.type === "operation.failed"
                        ? {
                            type: "operation.changed",
                            operation: {
                              id: event.operationId,
                              label: event.message,
                              ...(toolName === undefined ? {} : { toolName }),
                              status: "failed",
                              detail: event.code,
                              warnings: [event.message],
                              changed: [],
                              unchanged: [],
                              retryable: event.retryable ?? false,
                              undoable: false,
                              timestamp: Date.now(),
                            },
                            ...(event.agentInstanceId === undefined
                              ? {}
                              : { agentInstanceId: event.agentInstanceId }),
                            ...(event.sdkSessionId === undefined
                              ? {}
                              : { sdkSessionId: event.sdkSessionId }),
                          }
                        : event;
  return appEventSchema.parse(normalized);
}
