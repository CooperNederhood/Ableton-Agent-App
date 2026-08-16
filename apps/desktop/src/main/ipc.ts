import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";
import type { Logger } from "@ableton-agent/shared";

import {
  appEventSchema,
  ipcSchemas,
  type DesktopAppEvent,
  type DesktopDiagnosticsReport,
  type DiagnosticCheck,
  type IpcChannel,
  type RequestOf,
  type ResponseOf,
} from "../contracts.js";
import type { DesktopService } from "./desktop-service.js";

export const eventChannel = "app:event";
let nextInvocationId = 0;

export type IpcHandlers = {
  [C in IpcChannel]: (request: RequestOf<C>) => Promise<ResponseOf<C>>;
};

export interface DiagnosticsActions {
  getReport(checks: DiagnosticCheck[]): Promise<DesktopDiagnosticsReport>;
  revealLog(): Promise<void>;
  exportSupportBundle(
    checks: DiagnosticCheck[],
  ): Promise<{ status: "cancelled" } | { status: "saved"; filePath: string }>;
  copySummary(checks: DiagnosticCheck[]): Promise<void>;
}

export function createIpcHandlers(
  service: DesktopService,
  diagnostics: DiagnosticsActions,
): IpcHandlers {
  return {
    "app:lifecycle": async () => ({
      state: await service.getLifecycleState(),
    }),
    "agent:send": (request) =>
      service.send(request.message, request.context, request.mode),
    "agent:cancel": () => service.cancel(),
    "agent:create-session": async () => ({
      sessionId: await service.createSession(),
    }),
    "agent:sessions": () => service.getSessions(),
    "agent:resume-session": async ({ sessionId }) => {
      await service.resumeSession(sessionId);
      return { resumed: true };
    },
    "ableton:connect": () => service.connect(),
    "ableton:status": () => service.getStatus(),
    "ableton:capabilities": () => service.getCapabilities(),
    "ableton:snapshot": () => service.getSnapshot(),
    "diagnostics:get": async () =>
      diagnostics.getReport(await service.getDiagnostics()),
    "diagnostics:reveal-log": async () => {
      await diagnostics.revealLog();
      return { revealed: true };
    },
    "diagnostics:export-support-bundle": async () =>
      diagnostics.exportSupportBundle(await service.getDiagnostics()),
    "diagnostics:copy-summary": async () => {
      await diagnostics.copySummary(await service.getDiagnostics());
      return { copied: true };
    },
    "approvals:resolve": async ({ id, decision }) => ({
      resolved: await service.resolveApproval(id, decision),
    }),
    "preferences:get": () => service.getPreferences(),
    "preferences:set": (request) => service.setPreferences(request),
    "project:set-context": async ({ context }) => {
      await service.setContext(context);
      return { updated: true };
    },
    "plan:update": async ({ sections }) => {
      await service.updatePlan(sections);
      return { updated: true };
    },
    "operation:retry": async ({ id }) => ({
      accepted: await service.retryOperation(id),
    }),
    "operation:undo": async ({ id }) => ({
      accepted: await service.undoOperation(id),
    }),
    "outputs:list": () => service.listOutputs(),
    "outputs:assign": ({ producerId }) => service.assignOutput(producerId),
    "outputs:unassign": async ({ producerId }) => ({
      removed: await service.unassignOutput(producerId),
    }),
    "outputs:set-enabled": ({ producerId, enabled }) =>
      service.setOutputEnabled(producerId, enabled),
    "outputs:set-delivery-mode": ({ producerId, deliveryMode }) =>
      service.setOutputDeliveryMode(producerId, deliveryMode),
    "outputs:set-usage-instruction": ({ producerId, usageInstruction }) =>
      service.setOutputUsageInstruction(producerId, usageInstruction),
  };
}

export function registerIpc(
  ipcMain: Pick<IpcMain, "handle" | "removeHandler">,
  service: DesktopService,
  diagnostics: DiagnosticsActions,
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean,
  logger?: Logger,
): () => void {
  const handlers = createIpcHandlers(service, diagnostics);
  const channels = Object.keys(ipcSchemas) as IpcChannel[];
  for (const channel of channels) {
    ipcMain.handle(channel, async (event, payload: unknown) => {
      if (!isTrustedSender(event)) {
        throw new Error("Untrusted IPC sender");
      }
      const invocationId = `${Date.now()}-${++nextInvocationId}`;
      const startedAt = Date.now();
      logger?.debug("Desktop IPC started", {
        invocationId,
        channel,
        payload,
      });
      try {
        const request = ipcSchemas[channel].request.parse(payload);
        const response: unknown = await handlers[channel](request as never);
        const parsed = ipcSchemas[channel].response.parse(response);
        logger?.debug("Desktop IPC completed", {
          invocationId,
          channel,
          response: parsed,
          durationMs: Date.now() - startedAt,
        });
        return parsed;
      } catch (error) {
        logger?.error("Desktop IPC failed", {
          invocationId,
          channel,
          payload,
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    });
  }
  return () => channels.forEach((channel) => ipcMain.removeHandler(channel));
}

export function forwardEvent(
  target: Pick<WebContents, "send" | "isDestroyed">,
  event: DesktopAppEvent,
): void {
  if (!target.isDestroyed())
    target.send(eventChannel, appEventSchema.parse(event));
}
