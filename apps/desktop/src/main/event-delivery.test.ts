import { describe, expect, it, vi } from "vitest";

import { desktopReducer, initialState } from "../renderer/state.js";
import { forwardEvent } from "./ipc.js";

describe("main/preload/renderer event delivery", () => {
  it("forwards a validated event that the renderer reducer consumes", () => {
    const send = vi.fn();
    const target = { send, isDestroyed: () => false };
    const event = {
      type: "diagnostic" as const,
      level: "warning" as const,
      message: "Bridge reconnecting",
    };
    forwardEvent(target, event);
    expect(send).toHaveBeenCalledWith("app:event", event);
    expect(
      desktopReducer(initialState, { type: "event", event }).diagnostics[0]
        ?.message,
    ).toBe("Bridge reconnecting");
  });

  it("does not send into destroyed renderer contents", () => {
    const send = vi.fn();
    forwardEvent(
      { send, isDestroyed: () => true },
      { type: "diagnostic", level: "info", message: "ignored" },
    );
    expect(send).not.toHaveBeenCalled();
  });
});
