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
  invoke: (channel: string, payload: unknown) => Promise<unknown>;
  on: (
    channel: string,
    listener: (event: IpcRendererEvent, value: unknown) => void,
  ) => void;
  removeListener: (
    channel: string,
    listener: (event: IpcRendererEvent, value: unknown) => void,
  ) => void;
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
      send: (message, context) => invoke("agent:send", { message, context }),
      cancel: () => invoke("agent:cancel", {}),
      createSession: async () =>
        (await invoke("agent:create-session", {})).sessionId,
      getSessions: () => invoke("agent:sessions", {}),
      resumeSession: async (sessionId) => {
        await invoke("agent:resume-session", { sessionId });
      },
      closeSession: async () => {
        await invoke("agent:close-session", {});
      },
    },
    agents: {
      getCatalog: () => invoke("agents:catalog", {}),
      refreshCatalog: () => invoke("agents:refresh", {}),
      saveDefinition: (definition, expectedRevision, expectedFingerprint) =>
        invoke("agents:save-definition", {
          definition,
          expectedRevision,
          expectedFingerprint,
        }),
      listActive: () => invoke("agents:active", {}),
      listModels: () => invoke("agents:models", {}),
      create: (definitionName) => invoke("agents:create", { definitionName }),
      rename: (instanceId, label) =>
        invoke("agents:rename", { instanceId, label }),
      configure: (instanceId, overrides) =>
        invoke("agents:configure", { instanceId, overrides }),
      reset: (instanceId) => invoke("agents:reset", { instanceId }),
      select: (instanceId) => invoke("agents:select", { instanceId }),
      setConversationSettings: (instanceId, settings) =>
        invoke("agents:set-conversation-settings", {
          instanceId,
          settings,
        }),
      setAutoApproval: (target, enabled) =>
        invoke("agents:set-auto-approval", { target, enabled }),
      deactivate: async (instanceId) => {
        await invoke("agents:deactivate", { instanceId });
      },
      hydrateHistory: (instanceId) => invoke("agents:history", { instanceId }),
      send: (instanceId, message, context, agentMode = "interactive") =>
        invoke("agents:send", { instanceId, message, context, agentMode }),
      setMode: (instanceId, mode) =>
        invoke("agents:set-mode", { instanceId, mode }),
      resolvePlan: async (instanceId, request) =>
        (
          await invoke("agents:resolve-plan", {
            instanceId,
            ...request,
          })
        ).resolved,
      readPlan: (instanceId) => invoke("agents:read-plan", { instanceId }),
      writePlan: (instanceId, input) =>
        invoke("agents:write-plan", { instanceId, ...input }),
      resolveElicitation: async (instanceId, request) =>
        (
          await invoke("agents:resolve-elicitation", {
            instanceId,
            ...request,
            ...(request.content === undefined
              ? {}
              : {
                  content: Object.fromEntries(
                    Object.entries(request.content).map(([key, value]) => [
                      key,
                      Array.isArray(value) ? [...value] : value,
                    ]),
                  ),
                }),
          })
        ).resolved,
      invokeSkill: (
        instanceId,
        skillName,
        argumentsText,
        context,
        agentMode = "interactive",
      ) =>
        invoke("agents:invoke-skill", {
          instanceId,
          skillName,
          request: argumentsText,
          context,
          agentMode,
        }),
      cancel: (instanceId) => invoke("agents:cancel", { instanceId }),
    },
    skills: {
      read: (name) => invoke("skills:read", { name }),
      create: (name, description, body, expectedRevision) =>
        invoke("skills:create", {
          name,
          description,
          body,
          expectedRevision,
        }),
      save: (name, body, expectedRevision, expectedFingerprint) =>
        invoke("skills:save", {
          name,
          body,
          expectedRevision,
          expectedFingerprint,
        }),
    },
    profiles: {
      get: (selectedProfile) =>
        invoke("profiles:get", {
          ...(selectedProfile === undefined ? {} : { selectedProfile }),
        }),
      status: () => invoke("profiles:status", {}),
      create: (name, expectedRevision) =>
        invoke("profiles:create", { name, expectedRevision }),
      rename: (name, newName, expectedRevision) =>
        invoke("profiles:rename", { name, newName, expectedRevision }),
      delete: (name, expectedRevision) =>
        invoke("profiles:delete", { name, expectedRevision }),
      switch: async (name, expectedRevision, closeActiveSession = false) => {
        await invoke("profiles:switch", {
          name,
          expectedRevision,
          closeActiveSession,
        });
      },
      copyArtifact: (request) => invoke("profiles:copy-artifact", request),
      moveArtifact: (request) => invoke("profiles:move-artifact", request),
      renameArtifact: (request) => invoke("profiles:rename-artifact", request),
      deleteArtifact: (request) => invoke("profiles:delete-artifact", request),
      setArtifactDisabled: (request) =>
        invoke("profiles:set-artifact-disabled", request),
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
      resolveTransition: async (token, decision) =>
        (await invoke("project:resolve-transition", { token, decision }))
          .session,
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
      list: () => invoke("events:list", {}),
      inspectSelection: () => invoke("events:inspect-selection", {}),
      create: (definition) => invoke("events:create", { definition }),
      update: (eventId, definition) =>
        invoke("events:update", { eventId, definition }),
      enable: (eventId) => invoke("events:enable", { eventId }),
      disable: (eventId) => invoke("events:disable", { eventId }),
      delete: async (eventId) =>
        (await invoke("events:delete", { eventId })).removed,
      assignListener: (agentInstanceId, eventId, settings) =>
        invoke("events:assign-listener", {
          agentInstanceId,
          eventId,
          ...settings,
        }),
      unassignListener: async (agentInstanceId, eventId) =>
        (
          await invoke("events:unassign-listener", {
            agentInstanceId,
            eventId,
          })
        ).removed,
      updateListener: (agentInstanceId, eventId, settings) =>
        invoke("events:update-listener", {
          agentInstanceId,
          eventId,
          ...settings,
        }),
      subscribe: (handler) => {
        const listener = (_event: IpcRendererEvent, value: unknown): void => {
          const parsed = appEventSchema.safeParse(value);
          if (parsed.success) handler(parsed.data);
        };
        transport.on(eventChannel, listener);
        return () => transport.removeListener(eventChannel, listener);
      },
    },
    eventHistory: {
      search: (query = {}) =>
        invoke(
          "event-history:search",
          ipcSchemas["event-history:search"].request.parse(query),
        ),
      trace: (traceId, options = {}) =>
        invoke(
          "event-history:trace",
          ipcSchemas["event-history:trace"].request.parse({
            traceId,
            ...options,
          }),
        ),
      configurations: (query = {}) =>
        invoke(
          "event-history:configurations",
          ipcSchemas["event-history:configurations"].request.parse(query),
        ),
      health: () => invoke("event-history:health", {}),
      getRetention: () => invoke("event-history:get-retention", {}),
      setRetention: (policy) => invoke("event-history:set-retention", policy),
      prune: () => invoke("event-history:prune", {}),
      deleteTrace: async (traceId) =>
        (await invoke("event-history:delete-trace", { traceId })).deletedEvents,
      clear: () => invoke("event-history:clear", {}),
    },
  };
}
