import { describe, expect, it, vi } from "vitest";

import { createDesktopApi, type PreloadTransport } from "./api.js";

describe("preload API", () => {
  it("exposes named domains without a generic invoke or Node primitive", () => {
    const api = createDesktopApi(transportFor({}));
    expect(Object.keys(api)).toEqual([
      "lifecycle",
      "agent",
      "ableton",
      "approvals",
      "diagnostics",
      "preferences",
      "project",
      "plan",
      "operations",
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
