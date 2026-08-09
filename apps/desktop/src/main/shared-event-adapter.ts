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
