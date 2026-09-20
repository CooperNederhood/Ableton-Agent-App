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

export interface ProfileManagerActions {
  saveAgentDefinition(
    request: RequestOf<"agents:save-definition">,
  ): Promise<ResponseOf<"agents:save-definition">>;
  readSkill(
    request: RequestOf<"skills:read">,
  ): Promise<ResponseOf<"skills:read">>;
  createSkill(
    request: RequestOf<"skills:create">,
  ): Promise<ResponseOf<"skills:create">>;
  saveSkill(
    request: RequestOf<"skills:save">,
  ): Promise<ResponseOf<"skills:save">>;
  get(selectedProfile?: string): Promise<ResponseOf<"profiles:get">>;
  status(): Promise<ResponseOf<"profiles:status">>;
  create(
    request: RequestOf<"profiles:create">,
  ): Promise<ResponseOf<"profiles:create">>;
  rename(
    request: RequestOf<"profiles:rename">,
  ): Promise<ResponseOf<"profiles:rename">>;
  delete(
    request: RequestOf<"profiles:delete">,
  ): Promise<ResponseOf<"profiles:delete">>;
  switch(request: RequestOf<"profiles:switch">): Promise<void>;
  copyArtifact(
    request: RequestOf<"profiles:copy-artifact">,
  ): Promise<ResponseOf<"profiles:copy-artifact">>;
  moveArtifact(
    request: RequestOf<"profiles:move-artifact">,
  ): Promise<ResponseOf<"profiles:move-artifact">>;
  renameArtifact(
    request: RequestOf<"profiles:rename-artifact">,
  ): Promise<ResponseOf<"profiles:rename-artifact">>;
  deleteArtifact(
    request: RequestOf<"profiles:delete-artifact">,
  ): Promise<ResponseOf<"profiles:delete-artifact">>;
  setArtifactDisabled(
    request: RequestOf<"profiles:set-artifact-disabled">,
  ): Promise<ResponseOf<"profiles:set-artifact-disabled">>;
}

const unavailableProfiles: ProfileManagerActions = new Proxy(
  {},
  {
    get: () => () => Promise.reject(new Error("Profile Manager unavailable")),
  },
) as ProfileManagerActions;

export function createIpcHandlers(
  service: DesktopService,
  diagnostics: DiagnosticsActions,
  profiles: ProfileManagerActions = unavailableProfiles,
): IpcHandlers {
  return {
    "app:lifecycle": async () => ({
      state: await service.getLifecycleState(),
    }),
    "agent:send": (request) => service.send(request.message, request.context),
    "agent:cancel": () => service.cancel(),
    "agent:create-session": async () => ({
      sessionId: await service.createSession(),
    }),
    "agent:sessions": () => service.getSessions(),
    "agent:resume-session": async ({ sessionId }) => {
      await service.resumeSession(sessionId);
      return { resumed: true };
    },
    "agent:close-session": async () => {
      await service.closeSession();
      return { closed: true };
    },
    "agents:catalog": () => service.getAgentCatalog(),
    "agents:refresh": () => service.refreshAgentCatalog(),
    "agents:save-definition": (request) =>
      profiles.saveAgentDefinition(request),
    "skills:read": (request) => profiles.readSkill(request),
    "skills:create": (request) => profiles.createSkill(request),
    "skills:save": (request) => profiles.saveSkill(request),
    "agents:active": () => service.listActiveAgents(),
    "agents:models": () => service.listAgentModels(),
    "agents:create": ({ definitionName }) =>
      service.createActiveAgent(definitionName),
    "agents:rename": ({ instanceId, label }) =>
      service.renameActiveAgent(instanceId, label),
    "agents:configure": ({ instanceId, overrides }) =>
      service.configureActiveAgent(instanceId, overrides),
    "agents:reset": ({ instanceId }) => service.resetActiveAgent(instanceId),
    "agents:select": ({ instanceId }) => service.selectActiveAgent(instanceId),
    "agents:set-conversation-settings": ({ instanceId, settings }) =>
      service.setActiveAgentConversationSettings(instanceId, settings),
    "agents:set-auto-approval": ({ target, enabled }) =>
      service.setAutoApproval(target, enabled),
    "agents:deactivate": async ({ instanceId }) => {
      await service.deactivateActiveAgent(instanceId);
      return { deactivated: true };
    },
    "agents:history": ({ instanceId }) =>
      service.hydrateActiveAgentHistory(instanceId),
    "agents:send": ({ instanceId, message, context, agentMode }) =>
      service.sendToActiveAgent(
        instanceId,
        message,
        context,
        agentMode ?? "interactive",
      ),
    "agents:set-mode": ({ instanceId, mode }) =>
      service.setActiveAgentMode(instanceId, mode),
    "agents:resolve-plan": async ({
      instanceId,
      requestId,
      approved,
      planRevision,
      selectedAction,
      feedback,
    }) => ({
      resolved: await service.resolveActiveAgentPlan(instanceId, {
        requestId,
        approved,
        ...(planRevision === undefined ? {} : { planRevision }),
        ...(selectedAction === undefined ? {} : { selectedAction }),
        ...(feedback === undefined ? {} : { feedback }),
      }),
    }),
    "agents:read-plan": ({ instanceId }) =>
      service.readActiveAgentPlan(instanceId),
    "agents:write-plan": ({ instanceId, content, expectedRevision }) =>
      service.writeActiveAgentPlan(instanceId, {
        content,
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
      }),
    "agents:resolve-elicitation": async ({
      instanceId,
      requestId,
      action,
      content,
    }) => ({
      resolved: await service.resolveActiveAgentElicitation(instanceId, {
        requestId,
        action,
        ...(content === undefined ? {} : { content }),
      }),
    }),
    "agents:invoke-skill": ({
      instanceId,
      skillName,
      request,
      context,
      agentMode,
    }) =>
      service.invokeActiveAgentSkill(
        instanceId,
        skillName,
        request,
        context,
        agentMode ?? "interactive",
      ),
    "agents:cancel": ({ instanceId }) => service.cancelActiveAgent(instanceId),
    "profiles:get": ({ selectedProfile }) => profiles.get(selectedProfile),
    "profiles:status": () => profiles.status(),
    "profiles:create": (request) => profiles.create(request),
    "profiles:rename": (request) => profiles.rename(request),
    "profiles:delete": (request) => profiles.delete(request),
    "profiles:switch": async (request) => {
      await profiles.switch(request);
      return { switching: true };
    },
    "profiles:copy-artifact": (request) => profiles.copyArtifact(request),
    "profiles:move-artifact": (request) => profiles.moveArtifact(request),
    "profiles:rename-artifact": (request) => profiles.renameArtifact(request),
    "profiles:delete-artifact": (request) => profiles.deleteArtifact(request),
    "profiles:set-artifact-disabled": (request) =>
      profiles.setArtifactDisabled(request),
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
    "project:resolve-transition": async ({ token, decision }) => ({
      session: await service.resolveProjectTransition(token, decision),
    }),
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
    "outputs:assign": ({ agentInstanceId, producerId }) =>
      service.assignOutput(agentInstanceId, producerId),
    "outputs:unassign": async ({ agentInstanceId, producerId }) => ({
      removed: await service.unassignOutput(agentInstanceId, producerId),
    }),
    "outputs:set-enabled": ({ agentInstanceId, producerId, enabled }) =>
      service.setOutputEnabled(agentInstanceId, producerId, enabled),
    "outputs:set-delivery-mode": ({
      agentInstanceId,
      producerId,
      deliveryMode,
    }) =>
      service.setOutputDeliveryMode(agentInstanceId, producerId, deliveryMode),
    "outputs:set-usage-instruction": ({
      agentInstanceId,
      producerId,
      usageInstruction,
    }) =>
      service.setOutputUsageInstruction(
        agentInstanceId,
        producerId,
        usageInstruction,
      ),
    "outputs:set-processing-policies": ({
      agentInstanceId,
      producerId,
      processingPolicyIds,
    }) =>
      service.setOutputProcessingPolicies(
        agentInstanceId,
        producerId,
        processingPolicyIds,
      ),
    "events:list": () => service.listLiveEvents(),
    "events:inspect-selection": () => service.inspectLiveEventSelection(),
    "events:create": ({ definition }) => service.createLiveEvent(definition),
    "events:update": ({ eventId, definition }) =>
      service.updateLiveEvent(eventId, definition),
    "events:enable": ({ eventId }) =>
      service.setLiveEventEnabled(eventId, true),
    "events:disable": ({ eventId }) =>
      service.setLiveEventEnabled(eventId, false),
    "events:delete": async ({ eventId }) => ({
      removed: await service.deleteLiveEvent(eventId),
    }),
    "events:assign-listener": ({
      agentInstanceId,
      eventId,
      enabled,
      responseMode,
      messagePrefix,
      preparedContext,
    }) =>
      service.assignLiveEventListener(agentInstanceId, eventId, {
        enabled,
        responseMode,
        ...(messagePrefix === undefined ? {} : { messagePrefix }),
        ...(preparedContext === undefined ? {} : { preparedContext }),
      }),
    "events:unassign-listener": async ({ agentInstanceId, eventId }) => ({
      removed: await service.unassignLiveEventListener(
        agentInstanceId,
        eventId,
      ),
    }),
    "events:update-listener": ({
      agentInstanceId,
      eventId,
      enabled,
      responseMode,
      messagePrefix,
      preparedContext,
    }) =>
      service.updateLiveEventListener(agentInstanceId, eventId, {
        ...(enabled === undefined ? {} : { enabled }),
        ...(responseMode === undefined ? {} : { responseMode }),
        ...(messagePrefix === undefined ? {} : { messagePrefix }),
        ...(preparedContext === undefined ? {} : { preparedContext }),
      }),
    "event-history:search": (request) => service.searchEventHistory(request),
    "event-history:trace": ({ traceId, cursor, limit, order }) =>
      service.getEventTrace(traceId, {
        limit,
        order,
        ...(cursor === undefined ? {} : { cursor }),
      }),
    "event-history:configurations": (request) =>
      service.getAgentConfigurationSnapshots(request),
    "event-history:health": () => service.getEventJournalHealth(),
    "event-history:get-retention": () => service.getEventRetention(),
    "event-history:set-retention": (request) =>
      service.setEventRetention(request),
    "event-history:prune": () => service.pruneEventHistory(),
    "event-history:delete-trace": async ({ traceId }) => ({
      deletedEvents: await service.deleteEventTrace(traceId),
    }),
    "event-history:clear": () => service.clearEventHistory(),
  };
}

export function registerIpc(
  ipcMain: Pick<IpcMain, "handle" | "removeHandler">,
  service: DesktopService,
  diagnostics: DiagnosticsActions,
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean,
  logger?: Logger,
  profiles: ProfileManagerActions = unavailableProfiles,
): () => void {
  const handlers = createIpcHandlers(service, diagnostics, profiles);
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
