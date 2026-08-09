import type { AppEvent } from "@ableton-agent/shared";

import { appEventSchema, type DesktopAppEvent } from "../contracts.js";

export function normalizeSharedEvent(
  event: AppEvent,
  messageId: () => string,
): DesktopAppEvent {
  const normalized: DesktopAppEvent =
    event.type === "agent.message_delta"
      ? { ...event, messageId: messageId() }
      : event.type === "agent.message_complete"
        ? { ...event, messageId: messageId() }
        : event.type === "operation.started"
          ? {
              type: "operation.changed",
              operation: {
                id: event.operationId,
                label: event.label,
                status: "running",
                warnings: [],
                changed: [],
                unchanged: [],
                retryable: false,
                undoable: false,
                timestamp: Date.now(),
              },
            }
          : event.type === "operation.completed"
            ? {
                type: "operation.changed",
                operation: {
                  id: event.operationId,
                  label: event.summary,
                  status: "completed",
                  warnings: [],
                  changed: [event.summary],
                  unchanged: [],
                  retryable: false,
                  undoable: false,
                  timestamp: Date.now(),
                },
              }
            : event.type === "operation.failed"
              ? {
                  type: "operation.changed",
                  operation: {
                    id: event.operationId,
                    label: event.message,
                    status: "failed",
                    detail: event.code,
                    warnings: [event.message],
                    changed: [],
                    unchanged: [],
                    retryable: true,
                    undoable: false,
                    timestamp: Date.now(),
                  },
                }
              : event;
  return appEventSchema.parse(normalized);
}
