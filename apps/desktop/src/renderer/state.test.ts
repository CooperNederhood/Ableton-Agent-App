import { describe, expect, it } from "vitest";

import {
  activeSession,
  contextForSelection,
  desktopReducer,
  initialState,
  selectedAgentInstance,
  selectedAgentSkills,
  selectedAgentWorkspace,
  type DesktopState,
} from "./state";

const firstAgentId = "00000000-0000-4000-8000-000000000001";
const secondAgentId = "00000000-0000-4000-8000-000000000002";

function stateWithAgents(): DesktopState {
  const agent = (id: string, label: string) => ({
    id,
    definitionName: "default",
    definitionFingerprint: "a".repeat(64),
    label,
    autoApprove: false,
    lifecycle: "ready" as const,
    config: {
      description: "General agent",
      systemPrompt: "Help.",
      tools: ["*"],
      resolvedTools: [],
      editScope: ["session" as const],
      skills: [],
      inputChannels: [],
    },
    boundTracks: [],
    outputSubscriptions: [],
    eventListeners: [],
    modified: false,
  });
  return {
    ...initialState,
    activeSessionId: "session",
    sessions: [
      {
        version: 3 as const,
        id: "session",
        title: "Session",
        updatedAt: new Date(0).toISOString(),
        projectName: "Project",
        activeAgents: [
          agent(firstAgentId, "Default"),
          agent(secondAgentId, "Default 2"),
        ],
        selectedAgentInstanceId: firstAgentId,
        productionPlan: [],
        outputAssignments: [],
        liveEvents: [],
      },
    ],
  };
}

describe("desktop reducer", () => {
  it("stores and clears a plan approval for its owning agent", () => {
    const state = stateWithAgents();
    const requested = desktopReducer(state, {
      type: "event",
      event: {
        type: "agent.plan_approval_requested",
        agentInstanceId: firstAgentId,
        sdkSessionId: "sdk-1",
        request: {
          requestId: "plan-1",
          summary: "Arrangement plan",
          planContent: "# Plan\n\nBuild an intro.",
          planRevision: "a".repeat(64),
          planUpdatedAt: "2026-01-01T00:00:00.000Z",
          recommendedAction: "interactive",
          actions: ["interactive", "exit_only"],
        },
      },
    });

    expect(selectedAgentWorkspace(requested).planApproval).toMatchObject({
      requestId: "plan-1",
      summary: "Arrangement plan",
    });
    const completed = desktopReducer(requested, {
      type: "event",
      event: {
        type: "agent.plan_approval_completed",
        agentInstanceId: firstAgentId,
        sdkSessionId: "sdk-1",
        requestId: "plan-1",
        approved: true,
        selectedAction: "interactive",
      },
    });
    expect(selectedAgentWorkspace(completed).planApproval).toBeUndefined();
  });

  it("stores plan artifacts and structured elicitation per agent", () => {
    const withPlan = desktopReducer(stateWithAgents(), {
      type: "event",
      event: {
        type: "agent.plan_artifact_changed",
        agentInstanceId: firstAgentId,
        sdkSessionId: "sdk-1",
        artifact: {
          exists: true,
          productionSessionId: "session",
          content: "# Plan\n",
          revision: "a".repeat(64),
          updatedAt: "2026-01-01T00:00:00.000Z",
          bytes: 7,
        },
      },
    });
    const requested = desktopReducer(withPlan, {
      type: "event",
      event: {
        type: "agent.elicitation_requested",
        agentInstanceId: firstAgentId,
        sdkSessionId: "sdk-1",
        request: {
          requestId: "question-1",
          message: "Choose a length.",
          properties: {
            bars: { type: "integer", minimum: 8, maximum: 128 },
          },
          required: ["bars"],
        },
      },
    });

    expect(selectedAgentWorkspace(requested)).toMatchObject({
      planArtifact: { exists: true, content: "# Plan\n" },
      elicitation: { requestId: "question-1" },
    });
    const completed = desktopReducer(requested, {
      type: "event",
      event: {
        type: "agent.elicitation_completed",
        agentInstanceId: firstAgentId,
        sdkSessionId: "sdk-1",
        requestId: "question-1",
        action: "accept",
      },
    });
    expect(selectedAgentWorkspace(completed).elicitation).toBeUndefined();
    expect(selectedAgentWorkspace(completed).planArtifact).toMatchObject({
      exists: true,
      content: "# Plan\n",
    });
  });

  it("keeps plan approvals isolated from stale completions and other agents", () => {
    const state = stateWithAgents();
    const requested = desktopReducer(state, {
      type: "event",
      event: {
        type: "agent.plan_approval_requested",
        agentInstanceId: firstAgentId,
        sdkSessionId: "sdk-1",
        request: {
          requestId: "plan-1",
          summary: "First plan",
          planContent: "First content",
          planRevision: "a".repeat(64),
          planUpdatedAt: "2026-01-01T00:00:00.000Z",
          recommendedAction: "interactive",
          actions: ["interactive", "exit_only"],
        },
      },
    });
    const secondRequested = desktopReducer(requested, {
      type: "event",
      event: {
        type: "agent.plan_approval_requested",
        agentInstanceId: secondAgentId,
        sdkSessionId: "sdk-2",
        request: {
          requestId: "plan-2",
          summary: "Second plan",
          planContent: "Second content",
          planRevision: "b".repeat(64),
          planUpdatedAt: "2026-01-01T00:01:00.000Z",
          recommendedAction: "exit_only",
          actions: ["exit_only"],
        },
      },
    });
    const staleCompletion = desktopReducer(secondRequested, {
      type: "event",
      event: {
        type: "agent.plan_approval_completed",
        agentInstanceId: firstAgentId,
        sdkSessionId: "sdk-1",
        requestId: "stale-plan",
        approved: false,
      },
    });

    expect(
      staleCompletion.agentWorkspaces[firstAgentId]?.planApproval?.requestId,
    ).toBe("plan-1");
    expect(
      staleCompletion.agentWorkspaces[secondAgentId]?.planApproval?.requestId,
    ).toBe("plan-2");
    const firstCompleted = desktopReducer(staleCompletion, {
      type: "event",
      event: {
        type: "agent.plan_approval_completed",
        agentInstanceId: firstAgentId,
        sdkSessionId: "sdk-1",
        requestId: "plan-1",
        approved: true,
        selectedAction: "interactive",
      },
    });
    expect(
      firstCompleted.agentWorkspaces[firstAgentId]?.planApproval,
    ).toBeUndefined();
    expect(
      firstCompleted.agentWorkspaces[secondAgentId]?.planApproval?.requestId,
    ).toBe("plan-2");
  });

  it("does not infer an active session from stored session order", () => {
    const state = stateWithAgents();
    state.activeSessionId = undefined;

    expect(activeSession(state)).toBeUndefined();
    expect(selectedAgentInstance(state)).toBeUndefined();
    expect(
      desktopReducer(state, {
        type: "event",
        event: {
          type: "agent.instance_changed",
          instance: state.sessions[0]!.activeAgents[0]!,
          change: "configured",
        },
      }),
    ).toBe(state);
  });

  it("keeps startup session lists inactive until context is restored", () => {
    const stored = stateWithAgents().sessions;
    const listed = desktopReducer(initialState, {
      type: "event",
      event: { type: "sessions.changed", sessions: stored },
    });

    expect(listed.activeSessionId).toBeUndefined();
    expect(activeSession(listed)).toBeUndefined();
    expect(
      desktopReducer(stateWithAgents(), {
        type: "event",
        event: { type: "sessions.changed", sessions: stored },
      }).activeSessionId,
    ).toBeUndefined();

    const restored = desktopReducer(listed, {
      type: "event",
      event: { type: "session.context_restored", session: stored[0]! },
    });
    expect(restored.activeSessionId).toBe("session");
    expect(activeSession(restored)?.id).toBe("session");
  });

  it("clears a stale scoped catalog when the active session changes", () => {
    const initial = stateWithAgents();
    initial.activeSessionId = "session-old";
    initial.agentCatalog = {
      ...initial.agentCatalog,
      sessionId: "session-old",
      skills: [
        {
          name: "interview-me",
          description: "Interview the user.",
          origin: "session",
          sourceFile: "interview-me/SKILL.md",
          fingerprint: "f".repeat(64),
        },
      ],
    };
    const nextSession = {
      ...initial.sessions[0]!,
      id: "session-new",
    };

    const changed = desktopReducer(initial, {
      type: "event",
      event: {
        type: "sessions.changed",
        sessions: [nextSession, ...initial.sessions],
        activeSessionId: nextSession.id,
      },
    });

    expect(changed.agentCatalog).toEqual({
      sessionId: "session-new",
      definitions: [],
      skills: [],
      diagnostics: [],
    });
  });

  it("applies a returned session with updated YOLO state immediately", () => {
    const state = stateWithAgents();
    const session = {
      ...state.sessions[0]!,
      activeAgents: state.sessions[0]!.activeAgents.map((agent, index) => ({
        ...agent,
        autoApprove: index === 0,
      })),
    };

    const updated = desktopReducer(state, {
      type: "event",
      event: { type: "session.context_restored", session },
    });

    expect(updated.sessions[0]?.activeAgents[0]?.autoApprove).toBe(true);
    expect(updated.sessions[0]?.activeAgents[1]?.autoApprove).toBe(false);
  });

  it("derives valid skills from the selected agent and updates on switching", () => {
    const base = stateWithAgents();
    base.sessions[0]!.activeAgents[0]!.config.skills = [
      "mix-review",
      "stale-skill",
    ];
    base.sessions[0]!.activeAgents[1]!.config.skills = ["sound-design"];
    const state = {
      ...base,
      agentCatalog: {
        definitions: [],
        diagnostics: [],
        skills: [
          {
            name: "mix-review",
            description: "Review a mix.",
            sourceFile: "mix-review/SKILL.md",
            fingerprint: "a".repeat(64),
          },
          {
            name: "sound-design",
            description: "Design a sound.",
            sourceFile: "sound-design/SKILL.md",
            fingerprint: "b".repeat(64),
          },
        ],
      },
    };

    expect(selectedAgentSkills(state).map(({ name }) => name)).toEqual([
      "mix-review",
    ]);
    state.sessions[0]!.selectedAgentInstanceId = secondAgentId;
    expect(selectedAgentSkills(state).map(({ name }) => name)).toEqual([
      "sound-design",
    ]);
  });

  it("stores the trusted diagnostics report for the diagnostics view", () => {
    const report = {
      checks: [{ label: "Bridge", status: "warn" as const, detail: "Offline" }],
      storage: {
        version: 1,
        root: "/home/test/.live-agent",
        profile: "default",
        profileRoot: "/home/test/.live-agent/profiles/default",
        migrationStatus: "completed" as const,
      },
      logging: {
        level: "info" as const,
        fileName: "desktop.log",
        filePath: "/logs/desktop.log",
      },
    };

    expect(
      desktopReducer(initialState, { type: "diagnostics-loaded", report })
        .diagnosticsReport,
    ).toEqual(report);
  });

  it("paginates history and replaces selected trace detail", () => {
    const traceId = "00000000-0000-4000-8000-000000000010";
    const event = {
      version: 1 as const,
      id: "00000000-0000-4000-8000-000000000001",
      sequence: 1,
      occurredAt: "2026-01-01T00:00:00.000Z",
      recordedAt: "2026-01-01T00:00:00.001Z",
      name: "agent.turn",
      source: "runtime",
      level: "info" as const,
      attributes: {},
    };
    const root = {
      rootTraceId: traceId,
      eventCount: 2,
      firstSequence: 1,
      lastSequence: 2,
      firstOccurredAt: event.occurredAt,
      lastOccurredAt: "2026-01-01T00:00:01.000Z",
      firstEventName: event.name,
      lastEventName: "agent.completed",
      hasErrors: false,
    };
    const loaded = desktopReducer(initialState, {
      type: "event-history-loaded",
      append: false,
      page: {
        version: 1,
        items: [root],
        nextCursor: "next",
        page: {
          limit: 1,
          returnedItems: 1,
          totalItems: 2,
          hasMore: true,
          order: "desc",
        },
      },
    });
    const appended = desktopReducer(loaded, {
      type: "event-history-loaded",
      append: true,
      page: {
        version: 1,
        items: [
          {
            ...root,
            rootTraceId: secondAgentId,
            firstSequence: 3,
            lastSequence: 4,
          },
        ],
        page: {
          limit: 1,
          returnedItems: 1,
          totalItems: 2,
          hasMore: false,
          order: "desc",
        },
      },
    });
    const selected = desktopReducer(appended, {
      type: "event-history-select-trace",
      traceId,
    });
    const firstDetail = desktopReducer(selected, {
      type: "event-history-trace-loaded",
      traceId,
      append: false,
      page: {
        version: 1,
        items: [event],
        nextCursor: "trace-next",
        page: {
          limit: 1,
          returnedItems: 1,
          totalItems: 2,
          hasMore: true,
          order: "asc",
        },
        trace: {
          rootTraceId: traceId,
          totalEvents: 2,
          firstSequence: 1,
          lastSequence: 2,
        },
      },
    });
    const detailed = desktopReducer(firstDetail, {
      type: "event-history-trace-loaded",
      traceId,
      append: true,
      page: {
        version: 1,
        items: [{ ...event, id: secondAgentId, sequence: 2 }],
        page: {
          limit: 1,
          returnedItems: 1,
          totalItems: 2,
          hasMore: false,
          order: "asc",
        },
        trace: {
          rootTraceId: traceId,
          totalEvents: 2,
          firstSequence: 1,
          lastSequence: 2,
        },
      },
    });

    expect(appended.eventHistory.items).toHaveLength(2);
    expect(appended.eventHistory.nextCursor).toBeUndefined();
    expect(firstDetail.eventHistory.traceNextCursor).toBe("trace-next");
    expect(detailed.eventHistory.trace).toHaveLength(2);
    expect(detailed.eventHistory.traceTotalEvents).toBe(2);
    expect(detailed.eventHistory.traceNextCursor).toBeUndefined();
  });

  it("throttles state growth with bounded histories", () => {
    let state = initialState;
    for (let index = 0; index < 5_000; index += 1) {
      state = desktopReducer(state, {
        type: "user-message",
        id: String(index),
        content: "message",
      });
    }
    expect(state.messages).toHaveLength(500);
    expect(state.messages[0]?.id).toBe("4500");
    for (let index = 0; index < 1_000; index += 1) {
      state = desktopReducer(state, {
        type: "event",
        event: {
          type: "diagnostic",
          level: "info",
          message: String(index),
        },
      });
    }
    expect(state.diagnostics).toHaveLength(100);
    expect(state.diagnostics[0]?.message).toBe("900");
  });

  it("renders an automation submission once in the attributed agent timeline", () => {
    const event = {
      type: "agent.user_message_submitted" as const,
      messageId: "00000000-0000-4000-8000-000000000011",
      content: "Build a visible drum pattern",
      agentInstanceId: firstAgentId,
      agentMode: "interactive" as const,
      origin: "automation" as const,
      timestamp: 123,
      traceId: "00000000-0000-4000-8000-000000000012",
      correlationId: "00000000-0000-4000-8000-000000000013",
      causationId: "00000000-0000-4000-8000-000000000014",
    };
    const once = desktopReducer(stateWithAgents(), { type: "event", event });
    const twice = desktopReducer(once, { type: "event", event });

    expect(
      twice.agentWorkspaces[firstAgentId]?.messages.filter(
        ({ id }) => id === event.messageId,
      ),
    ).toEqual([
      expect.objectContaining({
        role: "user",
        content: "Build a visible drum pattern",
      }),
    ]);
  });

  it("accumulates stream deltas and completes the message", () => {
    let state = desktopReducer(initialState, {
      type: "event",
      event: { type: "agent.message_delta", messageId: "a", content: "Hel" },
    });
    state = desktopReducer(state, {
      type: "event",
      event: { type: "agent.message_delta", messageId: "a", content: "lo" },
    });
    state = desktopReducer(state, {
      type: "event",
      event: {
        type: "agent.message_complete",
        messageId: "a",
        content: "Hello",
      },
    });
    expect(state.messages[0]).toMatchObject({
      content: "Hello",
      streaming: false,
    });
  });

  it("builds a bounded Working summary on the assistant turn", () => {
    const messageId = "assistant-message";
    const activityId = "00000000-0000-4000-8000-000000000021";
    let state = desktopReducer(initialState, {
      type: "event",
      event: {
        type: "agent.working_update",
        messageId,
        update: {
          kind: "started",
          activityId,
          occurredAt: "2026-08-08T00:00:00.000Z",
        },
      },
    });
    state = desktopReducer(state, {
      type: "event",
      event: {
        type: "agent.working_update",
        messageId,
        update: {
          kind: "intent",
          activityId,
          content: "Inspecting the arrangement",
          occurredAt: "2026-08-08T00:00:01.000Z",
        },
      },
    });
    state = desktopReducer(state, {
      type: "event",
      event: {
        type: "agent.working_update",
        messageId,
        update: {
          kind: "reasoning_delta",
          activityId,
          reasoningId: "reasoning-1",
          content: "Checking ",
          occurredAt: "2026-08-08T00:00:02.000Z",
        },
      },
    });
    state = desktopReducer(state, {
      type: "event",
      event: {
        type: "agent.working_update",
        messageId,
        update: {
          kind: "reasoning_complete",
          activityId,
          reasoningId: "reasoning-1",
          content: "Checked the available clips.",
          occurredAt: "2026-08-08T00:00:03.000Z",
        },
      },
    });
    state = desktopReducer(state, {
      type: "event",
      event: {
        type: "agent.working_update",
        messageId,
        update: {
          kind: "finished",
          activityId,
          outcome: "completed",
          occurredAt: "2026-08-08T00:00:04.000Z",
        },
      },
    });

    expect(state.messages).toEqual([
      expect.objectContaining({
        id: messageId,
        role: "assistant",
        content: "",
        working: expect.objectContaining({
          status: "completed",
          intent: "Inspecting the arrangement",
          summary: "Checked the available clips.",
          reasoningId: "reasoning-1",
        }),
      }),
    ]);
  });

  it("keeps two agent conversations and streaming attribution independent", () => {
    let state = desktopReducer(stateWithAgents(), {
      type: "user-message",
      id: "first-user",
      content: "First request",
      agentInstanceId: firstAgentId,
    });
    state = desktopReducer(state, {
      type: "user-message",
      id: "second-user",
      content: "Second request",
      agentInstanceId: secondAgentId,
    });
    state = desktopReducer(state, {
      type: "event",
      event: {
        type: "agent.message_delta",
        messageId: "reply",
        content: "One",
        agentInstanceId: firstAgentId,
      },
    });
    state = desktopReducer(state, {
      type: "event",
      event: {
        type: "agent.message_delta",
        messageId: "reply",
        content: "Two",
        agentInstanceId: secondAgentId,
      },
    });

    expect(
      state.agentWorkspaces[firstAgentId]?.messages.map(
        ({ content }) => content,
      ),
    ).toEqual(["First request", "One"]);
    expect(
      state.agentWorkspaces[secondAgentId]?.messages.map(
        ({ content }) => content,
      ),
    ).toEqual(["Second request", "Two"]);
  });

  it("clears only the changed agent workspace after a model replacement", () => {
    let state = desktopReducer(stateWithAgents(), {
      type: "user-message",
      id: "first-user",
      content: "First request",
      agentInstanceId: firstAgentId,
    });
    state = desktopReducer(state, {
      type: "user-message",
      id: "second-user",
      content: "Second request",
      agentInstanceId: secondAgentId,
    });
    state = desktopReducer(state, {
      type: "event",
      event: {
        type: "approval.requested",
        agentInstanceId: firstAgentId,
        approval: {
          id: "approval",
          title: "Approval",
          risk: "medium",
          summary: "Change",
          changes: [],
          destructive: false,
        },
      },
    });

    state = desktopReducer(state, {
      type: "event",
      event: {
        type: "agent.instance_changed",
        instance: {
          ...state.sessions[0]!.activeAgents[0]!,
          model: "model-a",
          reasoningEffort: "high",
          sdkSessionId: "fresh-session",
        },
        change: "conversation-settings-changed",
      },
    });

    expect(state.agentWorkspaces[firstAgentId]).toEqual({
      messages: [],
      operations: [],
      triggers: [],
    });
    expect(state.agentWorkspaces[secondAgentId]?.messages).toEqual([
      expect.objectContaining({ content: "Second request" }),
    ]);
    expect(state.sessions[0]?.activeAgents[0]).toMatchObject({
      model: "model-a",
      reasoningEffort: "high",
      sdkSessionId: "fresh-session",
    });
  });

  it("isolates operations and approvals while switching selected agents", () => {
    let state = desktopReducer(stateWithAgents(), {
      type: "event",
      event: {
        type: "operation.changed",
        agentInstanceId: firstAgentId,
        operation: {
          id: "operation",
          label: "First operation",
          status: "running",
          warnings: [],
          changed: [],
          unchanged: [],
          retryable: false,
          undoable: false,
          timestamp: 1,
        },
      },
    });
    state = desktopReducer(state, {
      type: "event",
      event: {
        type: "approval.requested",
        agentInstanceId: secondAgentId,
        approval: {
          id: "approval",
          title: "Second approval",
          risk: "medium",
          summary: "Change",
          changes: ["Track"],
          destructive: false,
        },
      },
    });
    expect(selectedAgentWorkspace(state).operations).toHaveLength(1);
    expect(selectedAgentWorkspace(state).approval).toBeUndefined();

    state = desktopReducer(state, {
      type: "event",
      event: {
        type: "agent.instance_changed",
        instance: state.sessions[0]!.activeAgents[1]!,
        change: "selected",
      },
    });
    expect(selectedAgentWorkspace(state).operations).toEqual([]);
    expect(selectedAgentWorkspace(state).approval?.title).toBe(
      "Second approval",
    );
  });

  it("keeps two concurrent approvals in their originating workspaces", () => {
    const approval = (id: string, title: string) => ({
      id,
      title,
      risk: "medium" as const,
      summary: "Change",
      changes: ["Track"],
      destructive: false,
    });
    let state = desktopReducer(stateWithAgents(), {
      type: "event",
      event: {
        type: "approval.requested",
        agentInstanceId: firstAgentId,
        sdkSessionId: "sdk-first",
        approval: approval("first-approval", "First approval"),
      },
    });
    state = desktopReducer(state, {
      type: "event",
      event: {
        type: "approval.requested",
        agentInstanceId: secondAgentId,
        sdkSessionId: "sdk-second",
        approval: approval("second-approval", "Second approval"),
      },
    });

    expect(state.agentWorkspaces[firstAgentId]?.approval?.id).toBe(
      "first-approval",
    );
    expect(state.agentWorkspaces[secondAgentId]?.approval?.id).toBe(
      "second-approval",
    );
    state = desktopReducer(state, {
      type: "dismiss-approval",
      agentInstanceId: firstAgentId,
    });
    expect(state.agentWorkspaces[firstAgentId]?.approval).toBeUndefined();
    expect(state.agentWorkspaces[secondAgentId]?.approval?.id).toBe(
      "second-approval",
    );
  });

  it("hydrates only the requested agent history", () => {
    const initial = stateWithAgents();
    initial.sessions[0]!.activeAgents[1] = {
      ...initial.sessions[0]!.activeAgents[1]!,
      sdkSessionId: "current-sdk-session",
    };
    const state = desktopReducer(initial, {
      type: "event",
      event: {
        type: "agent.history_hydrated",
        agentInstanceId: secondAgentId,
        sdkSessionId: "current-sdk-session",
        history: [
          {
            role: "assistant",
            content: "Restored second history",
            timestamp: new Date(10).toISOString(),
            eventId: "history-1",
            agentInstanceId: secondAgentId,
          },
        ],
      },
    });

    expect(state.agentWorkspaces[firstAgentId]).toBeUndefined();
    expect(state.agentWorkspaces[secondAgentId]?.messages[0]?.content).toBe(
      "Restored second history",
    );

    expect(
      desktopReducer(state, {
        type: "event",
        event: {
          type: "agent.history_hydrated",
          agentInstanceId: secondAgentId,
          sdkSessionId: "previous-sdk-session",
          history: [
            {
              role: "assistant",
              content: "Stale history",
              timestamp: new Date(11).toISOString(),
              eventId: "history-2",
              agentInstanceId: secondAgentId,
            },
          ],
        },
      }),
    ).toBe(state);
  });

  it("turns selected project objects into explicit context", () => {
    const snapshot = {
      id: "p",
      name: "Project",
      tempo: 120,
      timeSignature: "4/4",
      tracks: [
        {
          id: "t",
          name: "Bass",
          kind: "midi" as const,
          color: "#fff",
          volume: 1,
          pan: 0,
          muted: false,
          clips: [
            {
              id: "c",
              name: "Loop",
              sceneIndex: 0,
              lengthBeats: 16,
              status: "stopped" as const,
            },
          ],
          devices: [],
        },
      ],
    };
    const state = {
      ...initialState,
      snapshot,
      selectedTrackId: "t",
      selectedClipId: "c",
      projectSelectionContextEnabled: true,
    };
    expect(contextForSelection(state).map((chip) => chip.label)).toEqual([
      "Bass",
      "Loop",
    ]);
  });

  it("removes generated context without clearing project selection", () => {
    const snapshot = {
      id: "p",
      name: "Project",
      tempo: 120,
      timeSignature: "4/4",
      tracks: [
        {
          id: "t",
          name: "Bass",
          kind: "midi" as const,
          color: "#fff",
          volume: 1,
          pan: 0,
          muted: false,
          clips: [],
          devices: [],
        },
      ],
    };
    const selected = {
      ...initialState,
      snapshot,
      selectedTrackId: "t",
      projectSelectionContextEnabled: true,
    };
    const chip = contextForSelection(selected)[0]!;
    const removed = desktopReducer(selected, { type: "remove-context", chip });

    expect(removed.selectedTrackId).toBe("t");
    expect(contextForSelection(removed)).toEqual([]);

    const reselected = desktopReducer(removed, {
      type: "select-track",
      id: "t",
    });
    expect(contextForSelection(reselected)).toEqual([chip]);
  });

  it("removes explicitly added context", () => {
    const chip = {
      id: "section:chorus",
      kind: "section" as const,
      label: "Chorus",
    };
    const added = desktopReducer(initialState, {
      type: "toggle-context",
      chip,
    });
    const removed = desktopReducer(added, { type: "remove-context", chip });

    expect(contextForSelection(removed)).toEqual([]);
  });

  it("keeps project selection out of context by default", () => {
    const explicit = {
      id: "section:chorus",
      kind: "section" as const,
      label: "Chorus",
    };
    const state = {
      ...initialState,
      context: [explicit],
      snapshot: {
        id: "p",
        name: "Project",
        tempo: 120,
        timeSignature: "4/4",
        tracks: [
          {
            id: "t",
            name: "Bass",
            kind: "midi" as const,
            color: "#fff",
            volume: 1,
            pan: 0,
            muted: false,
            clips: [],
            devices: [],
          },
        ],
      },
      selectedTrackId: "t",
    };

    expect(contextForSelection(state)).toEqual([explicit]);
    const enabled = desktopReducer(state, {
      type: "project-selection-context",
      enabled: true,
    });
    expect(contextForSelection(enabled).map((chip) => chip.label)).toEqual([
      "Chorus",
      "Bass",
    ]);
  });

  it("deduplicates explicit and generated selections by stable id", () => {
    const explicit = {
      id: "track:t",
      kind: "track" as const,
      label: "Pinned Bass",
    };
    const state = {
      ...initialState,
      context: [explicit],
      snapshot: {
        id: "p",
        name: "Project",
        tempo: 120,
        timeSignature: "4/4",
        tracks: [
          {
            id: "t",
            name: "Bass",
            kind: "midi" as const,
            color: "#fff",
            volume: 1,
            pan: 0,
            muted: false,
            clips: [],
            devices: [],
          },
        ],
      },
      selectedTrackId: "t",
      projectSelectionContextEnabled: true,
    };

    expect(contextForSelection(state)).toEqual([explicit]);
  });

  it("reduces bounded renderer-safe output snapshots", () => {
    const outputs = {
      status: { state: "listening" as const, host: "127.0.0.1", port: 45832 },
      activeSessionId: "session-1",
      connections: [],
      assignments: [],
      latest: [],
    };
    const state = desktopReducer(initialState, {
      type: "event",
      event: { type: "outputs.changed", outputs },
    });
    expect(state.outputs).toEqual(outputs);
  });

  it("reduces renderer-safe Live event snapshots", () => {
    const events = { activeSessionId: "session-1", events: [] };
    const activeState = { ...initialState, activeSessionId: "session-1" };
    const state = desktopReducer(activeState, {
      type: "event",
      event: { type: "events.changed", events },
    });
    expect(state.events).toEqual(events);
    expect(state.eventsLoad).toEqual({ status: "loaded" });

    expect(
      desktopReducer(activeState, {
        type: "event",
        event: {
          type: "events.changed",
          events: { activeSessionId: "session-2", events: [] },
        },
      }),
    ).toBe(activeState);
  });

  it("tracks Live event loading errors and disclosure state", () => {
    let state = desktopReducer(initialState, { type: "events-load-started" });
    expect(state.eventsLoad).toEqual({ status: "loading" });

    state = desktopReducer(state, {
      type: "events-load-failed",
      message: "Remote Script unavailable",
    });
    expect(state.eventsLoad).toEqual({
      status: "failed",
      message: "Remote Script unavailable",
    });

    state = desktopReducer(state, {
      type: "toggle-event-activity",
      eventId: "live-event.00000000-0000-4000-8000-000000000001",
    });
    expect(state.expandedEventActivityIds).toHaveLength(1);
    state = desktopReducer(state, {
      type: "toggle-event-activity",
      eventId: "live-event.00000000-0000-4000-8000-000000000001",
    });
    expect(state.expandedEventActivityIds).toEqual([]);
  });

  it("preserves collapsed output cards across view changes", () => {
    let state = desktopReducer(initialState, {
      type: "toggle-output-disclosure",
      producerId: "producer-1",
    });
    expect(state.collapsedOutputProducerIds).toEqual(["producer-1"]);

    state = desktopReducer(state, { type: "view", view: "workspace" });
    state = desktopReducer(state, { type: "view", view: "outputs" });
    expect(state.collapsedOutputProducerIds).toEqual(["producer-1"]);

    state = desktopReducer(state, {
      type: "toggle-output-disclosure",
      producerId: "producer-1",
    });
    expect(state.collapsedOutputProducerIds).toEqual([]);
  });

  it("tracks project refresh progress and resets success", () => {
    let state = desktopReducer(initialState, {
      type: "project-refresh-started",
    });
    expect(state.projectRefresh).toEqual({ status: "refreshing" });

    state = desktopReducer(state, { type: "project-refresh-succeeded" });
    expect(state.projectRefresh).toEqual({ status: "succeeded" });

    state = desktopReducer(state, { type: "project-refresh-reset" });
    expect(state.projectRefresh).toEqual({ status: "idle" });
  });

  it("bounds refresh failures and preserves the last valid snapshot", () => {
    const snapshot = {
      id: "project",
      name: "Existing project",
      tempo: 120,
      timeSignature: "4/4",
      tracks: [],
    };
    const state = desktopReducer(
      { ...initialState, snapshot },
      {
        type: "project-refresh-failed",
        message: `  ${"failure ".repeat(50)}  `,
      },
    );

    expect(state.snapshot).toBe(snapshot);
    expect(state.projectRefresh.status).toBe("failed");
    if (state.projectRefresh.status === "failed") {
      expect(state.projectRefresh.message.length).toBeLessThanOrEqual(200);
      expect(state.projectRefresh.message.endsWith("…")).toBe(true);
    }
  });

  it("deduplicates trigger updates immutably within the receiving workspace", () => {
    const restored = desktopReducer(stateWithAgents(), {
      type: "event",
      event: {
        type: "session.context_restored",
        session: stateWithAgents().sessions[0]!,
      },
    });
    const trigger = {
      deliveryId: "delivery-1",
      occurrenceId: "00000000-0000-4000-8000-000000000101",
      eventId: "live-event.00000000-0000-4000-8000-000000000001",
      listenerId: "event-listener.00000000-0000-4000-8000-000000000001",
      agentInstanceId: firstAgentId,
      sdkSessionId: "sdk-1",
      kind: "track.triggered_clip_changed",
      sourceTrack: "Lead drum",
      state: {
        kind: "track.triggered_clip_changed" as const,
        state: { state: "session-clip" as const, slotIndex: 1 },
      },
      observedAt: "2026-08-30T20:00:00.000Z",
      occurrence: "{}",
      summary: "Queued pattern2 in scene 2",
      status: "queued" as const,
      updatedAt: "2026-08-30T20:00:00.010Z",
    };
    const queued = desktopReducer(restored, {
      type: "event",
      event: { type: "agent.live_event_trigger_changed", trigger },
    });
    const completed = desktopReducer(queued, {
      type: "event",
      event: {
        type: "agent.live_event_trigger_changed",
        trigger: { ...trigger, status: "completed" },
      },
    });
    const stale = desktopReducer(completed, {
      type: "event",
      event: { type: "agent.live_event_trigger_changed", trigger },
    });

    expect(restored.agentWorkspaces[firstAgentId]?.triggers).toEqual([]);
    expect(completed.agentWorkspaces[firstAgentId]?.triggers).toEqual([
      { ...trigger, status: "completed" },
    ]);
    expect(stale).toBe(completed);
    expect(stale.agentWorkspaces[secondAgentId]?.triggers).toEqual([]);
  });
});
