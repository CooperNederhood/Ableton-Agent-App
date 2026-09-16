import { describe, expect, it, vi } from "vitest";

import type { DesktopService } from "./desktop-service.js";
import type { DiagnosticsActions } from "./ipc.js";
import { createIpcHandlers, registerIpc } from "./ipc.js";

describe("desktop IPC", () => {
  it("routes managed-agent operations to the requested instance", async () => {
    const sendToActiveAgent = vi
      .fn()
      .mockResolvedValue({ accepted: true, messageId: "message-1" });
    const invokeActiveAgentSkill = vi
      .fn()
      .mockResolvedValue({ accepted: true, messageId: "message-2" });
    const setActiveAgentMode = vi.fn().mockResolvedValue({ id: "updated" });
    const resolveActiveAgentPlan = vi.fn().mockResolvedValue(true);
    const cancelActiveAgent = vi.fn().mockResolvedValue({ cancelled: true });
    const handlers = createIpcHandlers(
      {
        sendToActiveAgent,
        invokeActiveAgentSkill,
        setActiveAgentMode,
        resolveActiveAgentPlan,
        cancelActiveAgent,
      } as unknown as DesktopService,
      {} as DiagnosticsActions,
    );
    const instanceId = "00000000-0000-4000-8000-000000000001";

    const context = [{ id: "track:1", kind: "track" as const, label: "Drums" }];
    await handlers["agents:send"]({
      instanceId,
      message: "hello",
      context,
    });
    await handlers["agents:invoke-skill"]({
      instanceId,
      skillName: "analyze",
      request: "the drums",
      context,
      agentMode: "plan",
    });
    await handlers["agents:set-mode"]({ instanceId, mode: "plan" });
    await expect(
      handlers["agents:resolve-plan"]({
        instanceId,
        requestId: "plan-request",
        approved: false,
        feedback: "Use fewer tracks",
      }),
    ).resolves.toEqual({ resolved: true });

    await handlers["agents:cancel"]({ instanceId });

    expect(sendToActiveAgent).toHaveBeenCalledWith(
      instanceId,
      "hello",
      context,
      "interactive",
    );
    expect(invokeActiveAgentSkill).toHaveBeenCalledWith(
      instanceId,
      "analyze",
      "the drums",
      context,
      "plan",
    );
    expect(setActiveAgentMode).toHaveBeenCalledWith(instanceId, "plan");
    expect(resolveActiveAgentPlan).toHaveBeenCalledWith(instanceId, {
      requestId: "plan-request",
      approved: false,
      feedback: "Use fewer tracks",
    });
    expect(cancelActiveAgent).toHaveBeenCalledWith(instanceId);
  });

  it("routes atomic auto-approval updates to an instance or all", async () => {
    const setAutoApproval = vi.fn().mockResolvedValue({});
    const handlers = createIpcHandlers(
      { setAutoApproval } as unknown as DesktopService,
      {} as DiagnosticsActions,
    );
    const instanceId = "00000000-0000-4000-8000-000000000001";

    await handlers["agents:set-auto-approval"]({
      target: instanceId,
      enabled: true,
    });

    await handlers["agents:set-auto-approval"]({
      target: "all",
      enabled: false,
    });

    expect(setAutoApproval.mock.calls).toEqual([
      [instanceId, true],
      ["all", false],
    ]);
  });

  it("routes model discovery and per-agent conversation replacement", async () => {
    const listAgentModels = vi.fn().mockResolvedValue([]);
    const setActiveAgentConversationSettings = vi.fn().mockResolvedValue({});
    const handlers = createIpcHandlers(
      {
        listAgentModels,
        setActiveAgentConversationSettings,
      } as unknown as DesktopService,
      {} as DiagnosticsActions,
    );
    const instanceId = "00000000-0000-4000-8000-000000000001";
    const settings = { model: "model-a", reasoningEffort: "high" } as const;

    await handlers["agents:models"]({});
    await handlers["agents:set-conversation-settings"]({
      instanceId,
      settings,
    });
    await handlers["agents:set-conversation-settings"]({
      instanceId,
      settings: {},
    });

    expect(listAgentModels).toHaveBeenCalledOnce();
    expect(setActiveAgentConversationSettings.mock.calls).toEqual([
      [instanceId, settings],
      [instanceId, {}],
    ]);
  });

  it("routes output edits to the explicit agent instance", async () => {
    const assignment = {
      assignmentId: "agent-instance.assignment",
      producerId: "producer-1",
      enabled: true,
      deliveryMode: "next-prompt" as const,
      usageInstruction: "Observe.",
      processingPolicyIds: ["latest-window"],
    };
    const assignOutput = vi.fn().mockResolvedValue(assignment);
    const setOutputProcessingPolicies = vi.fn().mockResolvedValue(assignment);
    const handlers = createIpcHandlers(
      {
        assignOutput,
        setOutputProcessingPolicies,
      } as unknown as DesktopService,
      {} as DiagnosticsActions,
    );
    const agentInstanceId = "00000000-0000-4000-8000-000000000001";

    await handlers["outputs:assign"]({
      agentInstanceId,
      producerId: "producer-1",
    });

    await handlers["outputs:set-processing-policies"]({
      agentInstanceId,
      producerId: "producer-1",
      processingPolicyIds: ["latest-window", "deduplicate"],
    });

    expect(assignOutput).toHaveBeenCalledWith(agentInstanceId, "producer-1");
    expect(setOutputProcessingPolicies).toHaveBeenCalledWith(
      agentInstanceId,
      "producer-1",
      ["latest-window", "deduplicate"],
    );
  });

  it("routes Live event listeners to the explicit active agent", async () => {
    const listener = {
      agentInstanceId: "00000000-0000-4000-8000-000000000001",
      agentLabel: "First",
      listener: {
        id: "event-listener.00000000-0000-4000-8000-000000000002",
        eventId: "live-event.00000000-0000-4000-8000-000000000003",
        enabled: true,
        responseMode: "automatic" as const,
      },
    };
    const assignLiveEventListener = vi.fn().mockResolvedValue(listener);
    const updateLiveEventListener = vi.fn().mockResolvedValue(listener);
    const handlers = createIpcHandlers(
      {
        assignLiveEventListener,
        updateLiveEventListener,
      } as unknown as DesktopService,
      {} as DiagnosticsActions,
    );

    await handlers["events:assign-listener"]({
      agentInstanceId: listener.agentInstanceId,
      eventId: listener.listener.eventId,
      enabled: true,
      responseMode: "automatic",
    });
    await handlers["events:update-listener"]({
      agentInstanceId: listener.agentInstanceId,
      eventId: listener.listener.eventId,
      messagePrefix: "React",
    });

    expect(assignLiveEventListener).toHaveBeenCalledWith(
      listener.agentInstanceId,
      listener.listener.eventId,
      { enabled: true, responseMode: "automatic" },
    );
    expect(updateLiveEventListener).toHaveBeenCalledWith(
      listener.agentInstanceId,
      listener.listener.eventId,
      { messagePrefix: "React" },
    );
  });

  it("rejects malformed Live event payloads before invoking the service", async () => {
    const registered = new Map<
      string,
      (event: never, payload: unknown) => Promise<unknown>
    >();
    const ipcMain = {
      handle: (
        channel: string,
        handler: (event: never, payload: unknown) => Promise<unknown>,
      ) => registered.set(channel, handler),
      removeHandler: vi.fn(),
    };
    const assignLiveEventListener = vi.fn();
    registerIpc(
      ipcMain,
      { assignLiveEventListener } as unknown as DesktopService,
      {} as DiagnosticsActions,
      () => true,
    );

    await expect(
      registered.get("events:assign-listener")?.({} as never, {
        agentInstanceId: "selected-agent",
        eventId: "not-an-event",
        enabled: "yes",
        responseMode: "immediate",
        extra: true,
      }),
    ).rejects.toThrow();
    expect(assignLiveEventListener).not.toHaveBeenCalled();
  });

  it("guards diagnostics filesystem actions with the trusted sender check", async () => {
    const registered = new Map<
      string,
      (event: never, payload: unknown) => Promise<unknown>
    >();
    const ipcMain = {
      handle: vi.fn(
        (
          channel: string,
          handler: (event: never, payload: unknown) => Promise<unknown>,
        ) => {
          registered.set(channel, handler);
        },
      ),
      removeHandler: vi.fn(),
    };
    const revealLog = vi.fn().mockResolvedValue(undefined);
    const diagnostics = {
      getReport: vi.fn(),
      revealLog,
      exportSupportBundle: vi.fn(),
      copySummary: vi.fn(),
    } as unknown as DiagnosticsActions;
    let trusted = false;

    registerIpc(ipcMain, {} as DesktopService, diagnostics, () => trusted);
    const handler = registered.get("diagnostics:reveal-log");
    expect(handler).toBeDefined();

    await expect(handler?.({} as never, {})).rejects.toThrow(
      "Untrusted IPC sender",
    );
    expect(revealLog).not.toHaveBeenCalled();

    trusted = true;
    await expect(handler?.({} as never, {})).resolves.toEqual({
      revealed: true,
    });
    expect(revealLog).toHaveBeenCalledTimes(1);
  });

  it("routes bounded history queries and destructive controls", async () => {
    const searchEventHistory = vi
      .fn()
      .mockResolvedValue({ version: 1, items: [] });
    const getEventTrace = vi.fn().mockResolvedValue({
      version: 1,
      items: [],
      nextCursor: "trace-next",
    });
    const deleteEventTrace = vi.fn().mockResolvedValue(3);
    const clearEventHistory = vi.fn().mockResolvedValue({
      deletedEvents: 4,
      deletedConfigurationSnapshots: 2,
    });
    const handlers = createIpcHandlers(
      {
        searchEventHistory,
        getEventTrace,
        deleteEventTrace,
        clearEventHistory,
      } as unknown as DesktopService,
      {} as DiagnosticsActions,
    );
    const traceId = "00000000-0000-4000-8000-000000000010";

    await handlers["event-history:search"]({
      sources: ["runtime"],
      limit: 25,
      order: "desc",
    });
    await expect(
      handlers["event-history:delete-trace"]({ traceId }),
    ).resolves.toEqual({ deletedEvents: 3 });
    await handlers["event-history:trace"]({
      traceId,
      cursor: "cursor",
      limit: 25,
      order: "asc",
    });
    await handlers["event-history:clear"]({});

    expect(searchEventHistory).toHaveBeenCalledWith({
      sources: ["runtime"],
      limit: 25,
      order: "desc",
    });
    expect(deleteEventTrace).toHaveBeenCalledWith(traceId);
    expect(getEventTrace).toHaveBeenCalledWith(traceId, {
      cursor: "cursor",
      limit: 25,
      order: "asc",
    });
    expect(clearEventHistory).toHaveBeenCalledOnce();
  });
});
