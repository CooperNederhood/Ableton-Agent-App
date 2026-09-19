import { describe, expect, it } from "vitest";

import {
  appEventSchema,
  desktopActiveAgentSchema,
  desktopAgentModelSchema,
  ipcSchemas,
  MAX_AGENT_TRIGGER_HISTORY,
  preferencesSchema,
  sessionSchema,
} from "./contracts";

describe("desktop IPC contracts", () => {
  it("rejects empty prompts", () => {
    expect(() =>
      ipcSchemas["agent:send"].request.parse({
        message: "",
        context: [],
      }),
    ).toThrow();
  });

  it("validates event boundaries", () => {
    expect(
      appEventSchema.safeParse({
        type: "agent.user_message_submitted",
        messageId: "00000000-0000-4000-8000-000000000001",
        content: "Visible automation message",
        agentInstanceId: "00000000-0000-4000-8000-000000000002",
        agentMode: "interactive",
        origin: "automation",
        timestamp: 1,
        traceId: "00000000-0000-4000-8000-000000000003",
        correlationId: "00000000-0000-4000-8000-000000000004",
        causationId: "00000000-0000-4000-8000-000000000005",
      }).success,
    ).toBe(true);
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
        type: "operation.changed",
        operation: {
          id: "operation-1",
          label: "Inspect session",
          toolName: "ableton_session_inspect",
          status: "running",
          timestamp: 1,
        },
      }).success,
    ).toBe(true);
    expect(
      appEventSchema.safeParse({
        type: "operation.changed",
        operation: {
          id: "legacy-operation",
          label: "Legacy operation",
          status: "completed",
          timestamp: 1,
        },
      }).success,
    ).toBe(true);
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
    expect(
      appEventSchema.safeParse({
        type: "agent.live_event_trigger_changed",
        trigger: {
          deliveryId: "delivery-1",
          occurrenceId: "00000000-0000-4000-8000-000000000101",
          eventId: "live-event.00000000-0000-4000-8000-000000000001",
          listenerId: "event-listener.00000000-0000-4000-8000-000000000001",
          agentInstanceId: "00000000-0000-4000-8000-000000000001",
          sdkSessionId: "sdk-1",
          kind: "track.triggered_clip_changed",
          sourceTrack: "Lead drum",
          state: {
            kind: "track.triggered_clip_changed",
            state: { state: "session-clip", slotIndex: 1 },
          },
          observedAt: "2026-08-30T20:00:00.000Z",
          occurrence: "{}",
          summary: "Queued pattern2 in scene 2",
          status: "queued",
          updatedAt: "2026-08-30T20:00:00.010Z",
        },
      }).success,
    ).toBe(true);
  });

  it("accepts missing trigger history and rejects malformed persisted bounds", () => {
    const agent = {
      id: "00000000-0000-4000-8000-000000000001",
      definitionName: "default",
      definitionFingerprint: "a".repeat(64),
      label: "Default",
      autoApprove: false,
      lifecycle: "ready",
      config: {
        description: "General agent",
        systemPrompt: "Help.",
        tools: ["*"],
        resolvedTools: [],
        editScope: ["session"],
        skills: [],
        inputChannels: [],
      },
      boundTracks: [],
      outputSubscriptions: [],
      eventListeners: [],
      modified: false,
    };
    expect(
      desktopActiveAgentSchema.parse({ ...agent, model: "model-a" })
        .triggerHistory,
    ).toBeUndefined();
    expect(
      desktopActiveAgentSchema.parse({ ...agent, model: "model-a" }).model,
    ).toBe("model-a");
    expect(
      desktopActiveAgentSchema.safeParse({
        ...agent,
        triggerHistory: Array.from(
          { length: MAX_AGENT_TRIGGER_HISTORY + 1 },
          (_, index) => ({
            deliveryId: `delivery-${index}`,
            occurrenceId: "00000000-0000-4000-8000-000000000101",
            eventId: "live-event.00000000-0000-4000-8000-000000000001",
            listenerId: "event-listener.00000000-0000-4000-8000-000000000001",
            agentInstanceId: agent.id,
            sdkSessionId: "sdk-1",
            kind: "track.triggered_clip_changed",
            sourceTrack: "Lead drum",
            state: {
              kind: "track.triggered_clip_changed",
              state: { state: "session-clip", slotIndex: 1 },
            },
            observedAt: "2026-08-30T20:00:00.000Z",
            occurrence: "{}",
            summary: "Queued pattern2 in scene 2",
            status: "completed",
            updatedAt: "2026-08-30T20:00:01.000Z",
          }),
        ),
      }).success,
    ).toBe(false);
  });

  it("migrates obsolete version-one preferences through defaults", () => {
    const preferences = preferencesSchema.parse({
      model: "obsolete",
      reasoning: "high",
    });

    expect(preferences.abletonPort).toBe(8765);
    expect(preferences.approvalPolicy).toBe("risky");
    expect(preferences.eventHistoryEnabled).toBe(true);
    expect(preferences.eventHistoryRetentionDays).toBe(30);
    expect(preferences.eventHistoryMaxBytes).toBe(250 * 1024 * 1024);
    expect(preferences.alwaysOnTop).toBe(false);
    expect(preferences).not.toHaveProperty("model");
    expect(preferences).not.toHaveProperty("reasoning");
  });

  it("strictly validates bounded model descriptors and conversation settings", () => {
    const model = desktopAgentModelSchema.parse({
      id: "model-a",
      displayName: "Model A",
      policyState: "enabled",
      capabilities: {
        vision: true,
        reasoningEffort: true,
        maxContextWindowTokens: 64_000,
      },
      supportedReasoningEfforts: ["none", "minimal", "low", "high"],
      defaultReasoningEffort: "high",
    });
    expect(ipcSchemas["agents:models"].response.parse([model])).toEqual([
      model,
    ]);
    expect(
      ipcSchemas["agents:set-conversation-settings"].request.parse({
        instanceId: "00000000-0000-4000-8000-000000000001",
        settings: {
          model: "model-a",
          reasoningEffort: "xhigh",
        },
      }),
    ).toEqual({
      instanceId: "00000000-0000-4000-8000-000000000001",
      settings: {
        model: "model-a",
        reasoningEffort: "xhigh",
      },
    });
    expect(() =>
      ipcSchemas["agents:set-conversation-settings"].request.parse({
        instanceId: "00000000-0000-4000-8000-000000000001",
        settings: { model: "model-a", reasoningEffort: "minimal" },
      }),
    ).toThrow();
    expect(() =>
      ipcSchemas["agents:set-conversation-settings"].request.parse({
        instanceId: "00000000-0000-4000-8000-000000000001",
        settings: { model: "model-a" },
        unknown: true,
      }),
    ).toThrow();
    expect(() =>
      desktopAgentModelSchema.parse({ ...model, unknown: true }),
    ).toThrow();
  });

  it("strictly validates event history queries and destructive requests", () => {
    const traceId = "00000000-0000-4000-8000-000000000010";
    expect(
      ipcSchemas["event-history:search"].request.parse({
        sources: ["runtime"],
        limit: 50,
      }),
    ).toMatchObject({ sources: ["runtime"], limit: 50, order: "desc" });
    expect(() =>
      ipcSchemas["event-history:search"].request.parse({
        limit: 501,
        secret: "no",
      }),
    ).toThrow();
    expect(
      ipcSchemas["event-history:search"].response.safeParse({
        version: 1,
        items: [
          {
            rootTraceId: traceId,
            eventCount: 2,
            firstSequence: 1,
            lastSequence: 2,
            firstOccurredAt: "2026-01-01T00:00:00.000Z",
            lastOccurredAt: "2026-01-01T00:00:01.000Z",
            firstEventName: "agent.turn",
            lastEventName: "agent.completed",
            hasErrors: false,
          },
        ],
        page: {
          limit: 50,
          returnedItems: 1,
          totalItems: 1,
          hasMore: false,
          order: "desc",
        },
      }).success,
    ).toBe(true);
    expect(
      ipcSchemas["event-history:trace"].response.safeParse({
        version: 1,
        items: [],
        page: {
          limit: 50,
          returnedItems: 0,
          totalItems: 0,
          hasMore: false,
          order: "asc",
        },
      }).success,
    ).toBe(false);
    expect(() =>
      ipcSchemas["event-history:delete-trace"].request.parse({
        traceId: "not-a-uuid",
      }),
    ).toThrow();
  });

  it("accepts approve-all as an approval policy", () => {
    expect(
      preferencesSchema.parse({ approvalPolicy: "approve-all" }).approvalPolicy,
    ).toBe("approve-all");
  });

  it("requires the selected active agent to belong to the session", () => {
    expect(
      sessionSchema.safeParse({
        version: 3,
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
      version: 3,
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

  it("persists session live events and per-agent listeners", () => {
    const agentId = "00000000-0000-4000-8000-000000000001";
    const eventId = "live-event.00000000-0000-4000-8000-000000000002";
    const listenerId = "event-listener.00000000-0000-4000-8000-000000000003";
    const session = sessionSchema.parse({
      version: 3,
      id: "production-session",
      title: "Production session",
      updatedAt: "2026-01-01T00:00:00.000Z",
      projectName: "Set",
      liveEvents: [
        {
          id: eventId,
          name: "Drums playing clip",
          projectId: "project-1",
          enabled: true,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          kind: "track.playing_clip_changed",
          classification: "discrete",
          target: { track: { name: "Drums", occurrence: 0 } },
        },
      ],
      activeAgents: [
        {
          id: agentId,
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
          eventListeners: [
            {
              id: listenerId,
              eventId,
              enabled: true,
              responseMode: "next-prompt",
              messagePrefix: "React to this:",
            },
          ],
          modified: false,
        },
      ],
      selectedAgentInstanceId: agentId,
    });

    expect(session.liveEvents[0]?.id).toBe(eventId);
    expect(session.activeAgents[0]?.eventListeners[0]).toMatchObject({
      id: listenerId,
      eventId,
      responseMode: "next-prompt",
    });
    expect(
      sessionSchema.safeParse({
        ...session,
        liveEvents: [],
      }).success,
    ).toBe(false);
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
        context: [],
      }),
    ).toThrow();
    expect(
      ipcSchemas["agents:send"].request.parse({
        instanceId: "00000000-0000-4000-8000-000000000001",
        message: "Inspect it",
        context: [{ id: "track:1", kind: "track", label: "Bass" }],
        agentMode: "plan",
      }),
    ).toEqual({
      instanceId: "00000000-0000-4000-8000-000000000001",
      message: "Inspect it",
      context: [{ id: "track:1", kind: "track", label: "Bass" }],
      agentMode: "plan",
    });
    expect(
      ipcSchemas["agents:resolve-plan"].request.parse({
        instanceId: "00000000-0000-4000-8000-000000000001",
        requestId: "request-1",
        approved: true,
        selectedAction: "interactive",
      }),
    ).toEqual({
      instanceId: "00000000-0000-4000-8000-000000000001",
      requestId: "request-1",
      approved: true,
      selectedAction: "interactive",
    });
    expect(() =>
      ipcSchemas["agents:invoke-skill"].request.parse({
        instanceId: "00000000-0000-4000-8000-000000000001",
        skillName: "analyze",
        request: "",
        context: Array.from({ length: 21 }, (_, index) => ({
          id: `track:${index}`,
          kind: "track",
          label: `Track ${index}`,
        })),
      }),
    ).toThrow();
    expect(() =>
      ipcSchemas["agents:send"].request.parse({
        instanceId: "00000000-0000-4000-8000-000000000001",
        message: "Inspect it",
        context: [{ id: "x".repeat(513), kind: "track", label: "Bass" }],
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
