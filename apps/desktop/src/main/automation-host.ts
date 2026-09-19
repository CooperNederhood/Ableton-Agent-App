import { randomUUID } from "node:crypto";

import {
  AutomationControlServer,
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
): Promise<{ accepted: true; messageId: string }> {
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
    version: 1,
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
    trace: {
      traceId: event.trace.traceId,
      spanId: randomUUID(),
      parentSpanId: event.trace.spanId,
    },
    attributes: {
      request_id: event.requestId,
      message_characters: event.messageCharacters,
      ...(event.messageId === undefined ? {} : { message_id: event.messageId }),
      ...(event.errorCode === undefined ? {} : { error_code: event.errorCode }),
    },
  });
}
