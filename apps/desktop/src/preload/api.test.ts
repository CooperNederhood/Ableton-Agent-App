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
    const transport = transportFor({ "outputs:assign": assignment });
    const api = createDesktopApi(transport);
    await expect(api.outputs.assign("producer-1")).resolves.toEqual(assignment);
    await expect(api.outputs.assign("")).rejects.toThrow();
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
