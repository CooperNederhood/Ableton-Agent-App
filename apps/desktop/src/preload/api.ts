import type { IpcRendererEvent } from "electron";

import {
  appEventSchema,
  ipcSchemas,
  type DesktopApi,
  type IpcChannel,
  type RequestOf,
  type ResponseOf,
} from "../contracts.js";
import { eventChannel } from "../main/ipc.js";

export interface PreloadTransport {
  invoke(channel: string, payload: unknown): Promise<unknown>;
  on(
    channel: string,
    listener: (event: IpcRendererEvent, value: unknown) => void,
  ): void;
  removeListener(
    channel: string,
    listener: (event: IpcRendererEvent, value: unknown) => void,
  ): void;
}

export function createDesktopApi(transport: PreloadTransport): DesktopApi {
  const invoke = async <C extends IpcChannel>(
    channel: C,
    request: RequestOf<C>,
  ): Promise<ResponseOf<C>> => {
    const payload = ipcSchemas[channel].request.parse(request);
    const response = await transport.invoke(channel, payload);
    return ipcSchemas[channel].response.parse(response) as ResponseOf<C>;
  };
  return {
    lifecycle: {
      get: async () => (await invoke("app:lifecycle", {})).state,
    },
    agent: {
      send: (message, context, mode) =>
        invoke("agent:send", { message, context, mode }),
      cancel: () => invoke("agent:cancel", {}),
      createSession: async () =>
        (await invoke("agent:create-session", {})).sessionId,
      getSessions: () => invoke("agent:sessions", {}),
      resumeSession: async (sessionId) => {
        await invoke("agent:resume-session", { sessionId });
      },
    },
    ableton: {
      connect: () => invoke("ableton:connect", {}),
      getStatus: () => invoke("ableton:status", {}),
      getCapabilities: () => invoke("ableton:capabilities", {}),
      requestSnapshot: () => invoke("ableton:snapshot", {}),
    },
    approvals: {
      resolve: async (id, decision) =>
        (await invoke("approvals:resolve", { id, decision })).resolved,
    },
    diagnostics: {
      get: () => invoke("diagnostics:get", {}),
      revealLog: async () => {
        await invoke("diagnostics:reveal-log", {});
      },
      exportSupportBundle: () =>
        invoke("diagnostics:export-support-bundle", {}),
      copySummary: async () => {
        await invoke("diagnostics:copy-summary", {});
      },
    },
    preferences: {
      get: () => invoke("preferences:get", {}),
      set: (value) => invoke("preferences:set", value),
    },
    project: {
      setContext: async (context) => {
        await invoke("project:set-context", { context });
      },
    },
    plan: {
      update: async (sections) => {
        await invoke("plan:update", { sections });
      },
    },
    operations: {
      retry: async (id) => (await invoke("operation:retry", { id })).accepted,
      undo: async (id) => (await invoke("operation:undo", { id })).accepted,
    },
    outputs: {
      list: () => invoke("outputs:list", {}),
      assign: (producerId) => invoke("outputs:assign", { producerId }),
      unassign: async (producerId) =>
        (await invoke("outputs:unassign", { producerId })).removed,
      setEnabled: (producerId, enabled) =>
        invoke("outputs:set-enabled", { producerId, enabled }),
      setDeliveryMode: (producerId, deliveryMode) =>
        invoke("outputs:set-delivery-mode", { producerId, deliveryMode }),
      setUsageInstruction: (producerId, usageInstruction) =>
        invoke("outputs:set-usage-instruction", {
          producerId,
          usageInstruction,
        }),
    },
    events: {
      subscribe: (handler) => {
        const listener = (_event: IpcRendererEvent, value: unknown): void => {
          const parsed = appEventSchema.safeParse(value);
          if (parsed.success) handler(parsed.data);
        };
        transport.on(eventChannel, listener);
        return () => transport.removeListener(eventChannel, listener);
      },
    },
  };
}
