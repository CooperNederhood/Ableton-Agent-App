import { describe, expect, it } from "vitest";

import { contextForSelection, desktopReducer, initialState } from "./state";

describe("desktop reducer", () => {
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
