import { randomUUID } from "node:crypto";

import {
  AutomationControlServer,
  type AutomationAcceptance,
  type AutomationLifecycleEvent,
  type SendUserMessageRequest,
} from "@ableton-agent/debug-control";
import {
  registerCorrelationContext,
  unregisterCorrelationContext,
  withCorrelation,
} from "@ableton-agent/correlation";
import type { NonBlockingObservabilityRecorder } from "@ableton-agent/observability";

import type { HeadlessDesktopService } from "./headless-desktop-service.js";
import type { DesktopLaunchOptions } from "./launch-options.js";

type AutomationOptions = NonNullable<DesktopLaunchOptions["automation"]>;

export async function applyAutomationStartup(
  service: HeadlessDesktopService,
  options: AutomationOptions,
): Promise<void> {
  if (options.agentDefinition === undefined) return;
  const existing = (await service.listActiveAgents()).find(
    ({ definitionName }) => definitionName === options.agentDefinition,
  );
  const selected =
    existing ?? (await service.createActiveAgent(options.agentDefinition));
  if (existing !== undefined) await service.selectActiveAgent(existing.id);
  if (options.yolo) await service.setAutoApproval(selected.id, true);
}

export function createDesktopAutomationServer(options: {
  service: HeadlessDesktopService;
  launch: AutomationOptions;
  telemetry: NonBlockingObservabilityRecorder;
}): AutomationControlServer {
  return new AutomationControlServer({
    descriptorPath: options.launch.descriptorPath,
    sendUserMessage: (request) => sendUserMessage(options.service, request),
    onLifecycle: (event) => recordAutomationLifecycle(options.telemetry, event),
  });
}

async function sendUserMessage(
  service: HeadlessDesktopService,
  request: SendUserMessageRequest,
): Promise<AutomationAcceptance> {
  registerCorrelationContext({
    correlationId: request.trace.correlationId,
    traceId: request.trace.traceId,
    parentSpanId: request.trace.spanId,
    causationId: request.id,
  });
  try {
    return await withCorrelation(request.trace.correlationId, () =>
      service.send(request.params.message, [], {
        origin: "automation",
        trace: request.trace,
        requestId: request.id,
        ...(request.params.expectedTarget === undefined
          ? {}
          : { expectedTarget: request.params.expectedTarget }),
      }),
    );
  } finally {
    unregisterCorrelationContext(request.trace.correlationId);
  }
}

function recordAutomationLifecycle(
  telemetry: NonBlockingObservabilityRecorder,
  event: AutomationLifecycleEvent,
): void {
  telemetry.enqueue({
    version: 2,
    id: randomUUID(),
    occurredAt: new Date().toISOString(),
    name: "desktop.automation_message",
    category: "automation",
    source: "desktop",
    stage: event.stage,
    level: event.stage === "failed" ? "error" : "info",
    ...(event.stage === "completed"
      ? { outcome: "success" as const }
      : event.stage === "failed"
        ? { outcome: "failure" as const }
        : event.stage === "cancelled"
          ? { outcome: "cancelled" as const }
          : {}),
    ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
    correlationId: event.trace.correlationId,
    causationId: event.requestId,
    ...(event.turn === undefined
      ? {}
      : {
          sessionId: event.turn.target.appSessionId,
          activeAgentId: event.turn.target.agentInstanceId,
        }),
    trace: {
      traceId: event.trace.traceId,
      spanId: randomUUID(),
      parentSpanId: event.trace.spanId,
    },
    attributes: {
      request_id: event.requestId,
      message_characters: event.messageCharacters,
      ...(event.messageId === undefined ? {} : { message_id: event.messageId }),
      ...(event.turn === undefined
        ? {}
        : {
            assistant_message_id: event.turn.assistantMessageId,
            app_session_id: event.turn.target.appSessionId,
            agent_instance_id: event.turn.target.agentInstanceId,
            sdk_session_id: event.turn.target.sdkSessionId,
          }),
      ...(event.errorCode === undefined ? {} : { error_code: event.errorCode }),
    },
  });
}
