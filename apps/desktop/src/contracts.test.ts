import { describe, expect, it } from "vitest";

import {
  appEventSchema,
  ipcSchemas,
  preferencesSchema,
  sessionSchema,
} from "./contracts";

describe("desktop IPC contracts", () => {
  it("rejects empty prompts and unknown request properties", () => {
    expect(() =>
      ipcSchemas["agent:send"].request.parse({
        message: "",
        context: [],
        mode: "explore",
      }),
    ).toThrow();
    expect(() =>
      ipcSchemas["agent:send"].request.parse({
        message: "hello",
        context: [],
        mode: "unsafe",
      }),
    ).toThrow();
  });

  it("validates event boundaries", () => {
    expect(
      appEventSchema.safeParse({
        type: "agent.message_delta",
        messageId: "1",
        content: "a",
      }).success,
    ).toBe(true);
    expect(
      appEventSchema.safeParse({ type: "agent.message_delta", content: "a" })
        .success,
    ).toBe(false);
    expect(
      appEventSchema.safeParse({ type: "node.execute", command: "rm" }).success,
    ).toBe(false);
    expect(
      appEventSchema.safeParse({
        type: "approval.requested",
        agentInstanceId: "00000000-0000-4000-8000-000000000001",
        sdkSessionId: "sdk-session",
        approval: {
          id: "approval",
          title: "Create track",
          risk: "medium",
          summary: "Create a track.",
          changes: [],
          destructive: false,
        },
      }).success,
    ).toBe(true);
  });

  it("migrates missing version-one preferences through defaults", () => {
    const preferences = preferencesSchema.parse({});

    expect(preferences.abletonPort).toBe(8765);
    expect(preferences.approvalPolicy).toBe("risky");
  });

  it("accepts approve-all as an approval policy", () => {
    expect(
      preferencesSchema.parse({ approvalPolicy: "approve-all" }).approvalPolicy,
    ).toBe("approve-all");
  });

  it("requires the selected active agent to belong to the session", () => {
    expect(
      sessionSchema.safeParse({
        version: 2,
        id: "production-session",
        title: "Production session",
        updatedAt: new Date().toISOString(),
        projectName: "Set",
        activeAgents: [],
        selectedAgentInstanceId: "00000000-0000-4000-8000-000000000001",
      }).success,
    ).toBe(false);
  });

  it("defaults old production-session auto approval off", () => {
    const session = sessionSchema.parse({
      version: 2,
      id: "production-session",
      title: "Production session",
      updatedAt: new Date().toISOString(),
      projectName: "Set",
      activeAgents: [
        {
          id: "00000000-0000-4000-8000-000000000001",
          definitionName: "default",
          definitionFingerprint: "a".repeat(64),
          label: "Default",
          lifecycle: "ready",
          config: {
            description: "General agent.",
            systemPrompt: "Help.",
            tools: ["*"],
            resolvedTools: [],
            editScope: ["session"],
            skills: [],
            inputChannels: [],
          },
          boundTracks: [],
          outputSubscriptions: [],
          modified: false,
        },
      ],
      selectedAgentInstanceId: "00000000-0000-4000-8000-000000000001",
    });

    expect(session.activeAgents[0]?.autoApprove).toBe(false);
  });

  it("validates managed-agent IPC input", () => {
    expect(() =>
      ipcSchemas["agents:create"].request.parse({ definitionName: "" }),
    ).toThrow();
    expect(() =>
      ipcSchemas["agents:rename"].request.parse({
        instanceId: "not-a-uuid",
        label: "Agent",
      }),
    ).toThrow();
    expect(() =>
      ipcSchemas["agents:send"].request.parse({
        instanceId: "00000000-0000-4000-8000-000000000001",
        message: " ",
      }),
    ).toThrow();
    expect(() =>
      ipcSchemas["agents:configure"].request.parse({
        instanceId: "00000000-0000-4000-8000-000000000001",
        overrides: { unknown: true },
      }),
    ).toThrow();
    expect(
      ipcSchemas["agents:set-auto-approval"].request.parse({
        target: "all",
        enabled: true,
      }),
    ).toEqual({ target: "all", enabled: true });
    expect(() =>
      ipcSchemas["agents:set-auto-approval"].request.parse({
        target: "selected",
        enabled: true,
      }),
    ).toThrow();
  });

  it("requires explicit agent identity for output subscription edits", () => {
    const agentInstanceId = "00000000-0000-4000-8000-000000000001";
    expect(() =>
      ipcSchemas["outputs:assign"].request.parse({ producerId: "producer-1" }),
    ).toThrow();
    expect(
      ipcSchemas["outputs:set-delivery-mode"].request.parse({
        agentInstanceId,
        producerId: "producer-1",
        deliveryMode: "automatic-analysis",
      }),
    ).toEqual({
      agentInstanceId,
      producerId: "producer-1",
      deliveryMode: "automatic-analysis",
    });
  });
});
