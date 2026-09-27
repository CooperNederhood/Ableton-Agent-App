import type { AppEvent } from "@ableton-agent/shared";

import { appEventSchema, type DesktopAppEvent } from "../contracts.js";
import {
  operationFailure,
  operationLabel,
  operationOutcome,
  operationRequest,
} from "./operation-presentation.js";

type DesktopSharedEvent = Exclude<
  AppEvent,
  { type: "ableton.project_mutated" }
>;

function desktopToolName(toolName: string | undefined): string | undefined {
  const bounded = toolName?.slice(0, 128);
  return bounded === "" ? undefined : bounded;
}

function desktopOperationMetadata(event: DesktopSharedEvent): {
  readonly operationDescriptorId?: string;
  readonly action?: string;
} {
  const record = event as unknown as Readonly<Record<string, unknown>>;
  const operationDescriptorId =
    typeof record.operationDescriptorId === "string"
      ? record.operationDescriptorId.slice(0, 128)
      : undefined;
  const directAction =
    typeof record.action === "string" ? record.action : undefined;
  const argumentAction =
    event.type === "operation.started" &&
    event.arguments !== undefined &&
    typeof event.arguments.action === "string"
      ? event.arguments.action
      : undefined;
  const action = (directAction ?? argumentAction)?.slice(0, 128);
  return {
    ...(operationDescriptorId === undefined || operationDescriptorId === ""
      ? {}
      : { operationDescriptorId }),
    ...(action === undefined || action === "" ? {} : { action }),
  };
}

function workflowJobMessage(eventName: string, payload: unknown): string {
  const fields =
    payload !== null && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const jobId = typeof fields.jobId === "string" ? fields.jobId : "unknown";
  const status =
    typeof fields.status === "string"
      ? fields.status
      : eventName.slice("workflow_job.".length);
  return `Ableton workflow job ${jobId.slice(0, 64)}: ${status.slice(0, 32)}`;
}

export function normalizeSharedEvent(
  event: DesktopSharedEvent,
  messageId: () => string,
): DesktopAppEvent {
  const toolName =
    "toolName" in event ? desktopToolName(event.toolName) : undefined;
  const operationMetadata = desktopOperationMetadata(event);
  const request =
    event.type === "operation.started" ||
    event.type === "operation.completed" ||
    event.type === "operation.failed"
      ? operationRequest(event)
      : undefined;
  const outcome =
    event.type === "operation.completed" ? operationOutcome(event) : undefined;
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
                    message: event.event.startsWith("workflow_job.")
                      ? workflowJobMessage(event.event, event.payload)
                      : `Ableton event ${event.event} (#${event.sequence})`,
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
                          label: operationLabel(event),
                          ...(toolName === undefined ? {} : { toolName }),
                          ...operationMetadata,
                          status: "running",
                          ...(request === undefined ? {} : { request }),
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
                            label: operationLabel(event),
                            ...(toolName === undefined ? {} : { toolName }),
                            ...operationMetadata,
                            status: "completed",
                            ...(request === undefined ? {} : { request }),
                            ...(outcome === undefined ? {} : { outcome }),
                            ...(event.durationMs === undefined
                              ? {}
                              : { durationMs: event.durationMs }),
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
                      : event.type === "operation.failed"
                        ? {
                            type: "operation.changed",
                            operation: {
                              id: event.operationId,
                              label: operationLabel(event),
                              ...(toolName === undefined ? {} : { toolName }),
                              ...operationMetadata,
                              status: "failed",
                              ...(request === undefined ? {} : { request }),
                              failure: operationFailure(event),
                              ...(event.durationMs === undefined
                                ? {}
                                : { durationMs: event.durationMs }),
                              warnings: [],
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
