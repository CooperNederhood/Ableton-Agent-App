import { describe, expect, it, vi } from "vitest";

import {
  abletonToolMetadata,
  createAbletonTools,
  handleAbletonToolPermission,
} from "./index.js";

describe("Ableton tools", () => {
  it("defines complete metadata for every registered tool", () => {
    const services = {
      getConnectionStatus: vi.fn(() =>
        Promise.resolve({ state: "disconnected" as const }),
      ),
      inspectSession: vi.fn(() =>
        Promise.resolve({
          tempo: 120,
          timeSignature: { numerator: 4, denominator: 4 },
          isPlaying: false,
          trackCount: 0,
          tracks: [],
        }),
      ),
    };

    const toolSet = createAbletonTools(services);

    expect(toolSet.tools.map((tool) => tool.name)).toEqual(
      abletonToolMetadata.map((metadata) => metadata.name),
    );
    expect(toolSet.availableTools).toEqual([
      "custom:ableton_connection_status",
      "custom:ableton_session_inspect",
    ]);
    expect(
      abletonToolMetadata.every((metadata) => metadata.risk === "read"),
    ).toBe(true);
  });

  it("invokes application service ports instead of transport code", async () => {
    const getConnectionStatus = vi.fn(() =>
      Promise.resolve({ state: "disconnected" as const }),
    );
    const inspectSession = vi.fn(() =>
      Promise.resolve({
        tempo: 120,
        timeSignature: { numerator: 4, denominator: 4 },
        isPlaying: false,
        trackCount: 0,
        tracks: [],
      }),
    );
    const toolSet = createAbletonTools({
      getConnectionStatus,
      inspectSession,
    });
    const invocation = {
      sessionId: "session",
      toolCallId: "call",
      toolName: "test",
      arguments: {},
    };

    await toolSet.tools[0]?.handler?.({}, invocation);
    await toolSet.tools[1]?.handler?.({}, invocation);

    expect(getConnectionStatus).toHaveBeenCalledOnce();
    expect(inspectSession).toHaveBeenCalledOnce();
  });

  it("auto-approves only registered read-only custom tools", () => {
    expect(
      handleAbletonToolPermission(
        {
          kind: "custom-tool",
          toolName: "ableton_session_inspect",
          toolDescription: "Inspect",
        },
        { sessionId: "session" },
      ),
    ).toEqual({ kind: "approve-once" });
    expect(
      handleAbletonToolPermission(
        {
          kind: "custom-tool",
          toolName: "unknown_tool",
          toolDescription: "Unknown",
        },
        { sessionId: "session" },
      ),
    ).toEqual({ kind: "no-result" });
    expect(
      handleAbletonToolPermission(
        {
          kind: "custom-tool",
          toolName: "ableton_session_inspect",
          toolDescription: "Inspect",
        },
        { sessionId: "session", managedSettingsEnabled: true },
      ),
    ).toEqual({ kind: "no-result" });
  });
});
