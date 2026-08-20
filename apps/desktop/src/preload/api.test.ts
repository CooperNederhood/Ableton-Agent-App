import { describe, expect, it, vi } from "vitest";

import { createDesktopApi, type PreloadTransport } from "./api.js";

describe("preload API", () => {
  it("exposes named domains without a generic invoke or Node primitive", () => {
    const api = createDesktopApi(transportFor({}));
    expect(Object.keys(api)).toEqual([
      "lifecycle",
      "agent",
      "agents",
      "ableton",
      "approvals",
      "diagnostics",
      "preferences",
      "project",
      "plan",
      "operations",
      "outputs",
      "events",
    ]);
    expect("invoke" in api).toBe(false);
    expect("require" in api).toBe(false);
  });

  it("validates responses and filters malformed events", async () => {
    const listeners: Array<(event: never, value: unknown) => void> = [];
    const transport = transportFor(
      {
        "ableton:status": {
          state: "connected",
          liveVersion: "12",
          remoteScriptVersion: "1",
          projectId: "p",
        },
      },
      listeners,
    );
    const api = createDesktopApi(transport);
    await expect(api.ableton.getStatus()).resolves.toMatchObject({
      state: "connected",
    });
    const handler = vi.fn();
    api.events.subscribe(handler);
    listeners[0]?.({} as never, { type: "node.execute", command: "bad" });
    listeners[0]?.({} as never, {
      type: "diagnostic",
      level: "info",
      message: "ok",
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed main-process responses", async () => {
    const api = createDesktopApi(
      transportFor({ "ableton:status": { state: "connected" } }),
    );
    await expect(api.ableton.getStatus()).rejects.toThrow();
  });

  it("validates output routing requests and responses", async () => {
    const assignment = {
      assignmentId: "assignment-1",
      producerId: "producer-1",
      enabled: true,
      deliveryMode: "next-prompt",
      usageInstruction: "Use safely.",
      processingPolicyIds: ["latest-window"],
    };
    const transport = transportFor({
      "outputs:assign": assignment,
      "outputs:set-processing-policies": assignment,
    });
    const api = createDesktopApi(transport);
    const agentInstanceId = "00000000-0000-4000-8000-000000000001";
    await expect(
      api.outputs.assign(agentInstanceId, "producer-1"),
    ).resolves.toEqual(assignment);
    await expect(api.outputs.assign(agentInstanceId, "")).rejects.toThrow();
    expect(vi.mocked(transport).invoke.mock.calls).toContainEqual([
      "outputs:assign",
      { agentInstanceId, producerId: "producer-1" },
    ]);
    await api.outputs.setProcessingPolicies(agentInstanceId, "producer-1", [
      "latest-window",
      "deduplicate",
    ]);
    expect(vi.mocked(transport).invoke.mock.calls.at(-1)).toEqual([
      "outputs:set-processing-policies",
      {
        agentInstanceId,
        producerId: "producer-1",
        processingPolicyIds: ["latest-window", "deduplicate"],
      },
    ]);
  });

  it("exposes fixed diagnostics actions without renderer-provided paths", async () => {
    const transport = transportFor({
      "diagnostics:reveal-log": { revealed: true },
      "diagnostics:export-support-bundle": { status: "cancelled" },
      "diagnostics:copy-summary": { copied: true },
    });
    const api = createDesktopApi(transport);

    await api.diagnostics.revealLog();
    await expect(api.diagnostics.exportSupportBundle()).resolves.toEqual({
      status: "cancelled",
    });
    await api.diagnostics.copySummary();

    expect(vi.mocked(transport).invoke.mock.calls).toEqual([
      ["diagnostics:reveal-log", {}],
      ["diagnostics:export-support-bundle", {}],
      ["diagnostics:copy-summary", {}],
    ]);
  });

  it("exposes typed targeted managed-agent calls", async () => {
    const instanceId = "00000000-0000-4000-8000-000000000001";
    const transport = transportFor({
      "agents:send": { accepted: true, messageId: "message-1" },
      "agents:invoke-skill": { accepted: true, messageId: "message-2" },
      "agents:cancel": { cancelled: true },
    });
    const api = createDesktopApi(transport);

    await api.agents.send(instanceId, "hello");
    await api.agents.invokeSkill(instanceId, "analyze", "the drums");
    await expect(api.agents.cancel(instanceId)).resolves.toEqual({
      cancelled: true,
    });
    await expect(api.agents.send("invalid", "hello")).rejects.toThrow();

    expect(vi.mocked(transport).invoke.mock.calls).toEqual([
      ["agents:send", { instanceId, message: "hello" }],
      [
        "agents:invoke-skill",
        { instanceId, skillName: "analyze", request: "the drums" },
      ],
      ["agents:cancel", { instanceId }],
    ]);
  });

  it("exposes atomic current-session auto approval", async () => {
    const response = {
      instances: [],
      session: {
        version: 2,
        id: "production-session",
        title: "Production session",
        updatedAt: new Date(0).toISOString(),
        projectName: "Set",
        activeAgents: [],
        mode: "explore",
        productionPlan: [],
        outputAssignments: [],
      },
    };
    const transport = transportFor({
      "agents:set-auto-approval": response,
    });
    const api = createDesktopApi(transport);

    await expect(api.agents.setAutoApproval("all", true)).resolves.toEqual(
      response,
    );
    expect(vi.mocked(transport).invoke).toHaveBeenCalledWith(
      "agents:set-auto-approval",
      { target: "all", enabled: true },
    );
    await expect(
      api.agents.setAutoApproval("not-an-instance", true),
    ).rejects.toThrow();
  });
});

function transportFor(
  responses: Record<string, unknown>,
  listeners: Array<(event: never, value: unknown) => void> = [],
): PreloadTransport {
  return {
    invoke: vi.fn(async (channel: string) => responses[channel]),
    on: vi.fn((_channel, listener) =>
      listeners.push(listener as (event: never, value: unknown) => void),
    ),
    removeListener: vi.fn(),
  };
}
