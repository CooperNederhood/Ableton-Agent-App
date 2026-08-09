import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";

import {
  appEventSchema,
  ipcSchemas,
  type DesktopAppEvent,
  type IpcChannel,
  type RequestOf,
  type ResponseOf,
} from "../contracts.js";
import type { DesktopService } from "./desktop-service.js";

export const eventChannel = "app:event";

export type IpcHandlers = {
  [C in IpcChannel]: (request: RequestOf<C>) => Promise<ResponseOf<C>>;
};

export function createIpcHandlers(service: DesktopService): IpcHandlers {
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
    "diagnostics:get": () => service.getDiagnostics(),
    "approvals:resolve": async ({ id, decision }) => {
      await service.resolveApproval(id, decision);
      return { resolved: true };
    },
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
  };
}

export function registerIpc(
  ipcMain: Pick<IpcMain, "handle" | "removeHandler">,
  service: DesktopService,
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean,
): () => void {
  const handlers = createIpcHandlers(service);
  const channels = Object.keys(ipcSchemas) as IpcChannel[];
  for (const channel of channels) {
    ipcMain.handle(channel, async (event, payload: unknown) => {
      if (!isTrustedSender(event)) {
        throw new Error("Untrusted IPC sender");
      }
      const request = ipcSchemas[channel].request.parse(payload);
      const response: unknown = await handlers[channel](request as never);
      return ipcSchemas[channel].response.parse(response);
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
