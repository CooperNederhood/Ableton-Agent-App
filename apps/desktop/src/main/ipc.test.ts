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
    const cancelActiveAgent = vi.fn().mockResolvedValue({ cancelled: true });
    const handlers = createIpcHandlers(
      {
        sendToActiveAgent,
        invokeActiveAgentSkill,
        cancelActiveAgent,
      } as unknown as DesktopService,
      {} as DiagnosticsActions,
    );
    const instanceId = "00000000-0000-4000-8000-000000000001";

    await handlers["agents:send"]({ instanceId, message: "hello" });
    await handlers["agents:invoke-skill"]({
      instanceId,
      skillName: "analyze",
      request: "the drums",
    });

    await handlers["agents:cancel"]({ instanceId });

    expect(sendToActiveAgent).toHaveBeenCalledWith(instanceId, "hello");
    expect(invokeActiveAgentSkill).toHaveBeenCalledWith(
      instanceId,
      "analyze",
      "the drums",
    );
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
});
