import { describe, expect, it } from "vitest";

import {
  contextForSelection,
  desktopReducer,
  initialState,
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
    modified: false,
  });
  return {
    ...initialState,
    sessions: [
      {
        version: 2 as const,
        id: "session",
        title: "Session",
        updatedAt: new Date(0).toISOString(),
        projectName: "Project",
        activeAgents: [
          agent(firstAgentId, "Default"),
          agent(secondAgentId, "Default 2"),
        ],
        selectedAgentInstanceId: firstAgentId,
        mode: "explore" as const,
        productionPlan: [],
        outputAssignments: [],
      },
    ],
  };
}

describe("desktop reducer", () => {
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
    const state = desktopReducer(stateWithAgents(), {
      type: "event",
      event: {
        type: "agent.history_hydrated",
        agentInstanceId: secondAgentId,
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
});
