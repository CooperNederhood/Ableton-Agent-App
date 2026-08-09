import { describe, expect, it } from "vitest";

import { contextForSelection, desktopReducer, initialState } from "./state";

describe("desktop reducer", () => {
  it("throttles state growth with bounded histories", () => {
    let state = initialState;
    for (let index = 0; index < 550; index += 1) {
      state = desktopReducer(state, {
        type: "user-message",
        id: String(index),
        content: "message",
      });
    }
    expect(state.messages).toHaveLength(500);
    expect(state.messages[0]?.id).toBe("50");
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
              startBar: 1,
              lengthBars: 4,
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
    };
    expect(contextForSelection(state).map((chip) => chip.label)).toEqual([
      "Bass",
      "Loop",
    ]);
  });
});
