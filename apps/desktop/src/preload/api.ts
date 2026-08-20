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
    agents: {
      getCatalog: () => invoke("agents:catalog", {}),
      refreshCatalog: () => invoke("agents:refresh", {}),
      listActive: () => invoke("agents:active", {}),
      create: (definitionName) => invoke("agents:create", { definitionName }),
      rename: (instanceId, label) =>
        invoke("agents:rename", { instanceId, label }),
      configure: (instanceId, overrides) =>
        invoke("agents:configure", { instanceId, overrides }),
      reset: (instanceId) => invoke("agents:reset", { instanceId }),
      select: (instanceId) => invoke("agents:select", { instanceId }),
      setAutoApproval: (target, enabled) =>
        invoke("agents:set-auto-approval", { target, enabled }),
      deactivate: async (instanceId) => {
        await invoke("agents:deactivate", { instanceId });
      },
      hydrateHistory: (instanceId) => invoke("agents:history", { instanceId }),
      send: (instanceId, message) =>
        invoke("agents:send", { instanceId, message }),
      invokeSkill: (instanceId, skillName, argumentsText = "") =>
        invoke("agents:invoke-skill", {
          instanceId,
          skillName,
          request: argumentsText,
        }),
      cancel: (instanceId) => invoke("agents:cancel", { instanceId }),
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
      assign: (agentInstanceId, producerId) =>
        invoke("outputs:assign", { agentInstanceId, producerId }),
      unassign: async (agentInstanceId, producerId) =>
        (await invoke("outputs:unassign", { agentInstanceId, producerId }))
          .removed,
      setEnabled: (agentInstanceId, producerId, enabled) =>
        invoke("outputs:set-enabled", {
          agentInstanceId,
          producerId,
          enabled,
        }),
      setDeliveryMode: (agentInstanceId, producerId, deliveryMode) =>
        invoke("outputs:set-delivery-mode", {
          agentInstanceId,
          producerId,
          deliveryMode,
        }),
      setUsageInstruction: (agentInstanceId, producerId, usageInstruction) =>
        invoke("outputs:set-usage-instruction", {
          agentInstanceId,
          producerId,
          usageInstruction,
        }),
      setProcessingPolicies: (
        agentInstanceId,
        producerId,
        processingPolicyIds,
      ) =>
        invoke("outputs:set-processing-policies", {
          agentInstanceId,
          producerId,
          processingPolicyIds,
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
