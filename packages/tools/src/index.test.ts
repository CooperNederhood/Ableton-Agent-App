import { describe, expect, it, vi } from "vitest";

import {
  abletonToolMetadata,
  createAbletonPermissionHandler,
  createAbletonTools,
  type ToolApprovalRequest,
} from "./index.js";

function services() {
  return {
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
    setTempo: vi.fn((tempo: number) =>
      Promise.resolve({
        beforeTempo: 120,
        afterTempo: tempo,
        verified: true,
      }),
    ),
  };
}

describe("Ableton tools", () => {
  it("defines complete metadata for every registered tool", () => {
    const toolSet = createAbletonTools(services());

    expect(toolSet.tools.map((tool) => tool.name)).toEqual(
      abletonToolMetadata.map((metadata) => metadata.name),
    );
    expect(toolSet.availableTools).toEqual([
      "custom:ableton_connection_status",
      "custom:ableton_session_inspect",
      "custom:ableton_transport_set_tempo",
    ]);
    expect(abletonToolMetadata.map((metadata) => metadata.risk)).toEqual([
      "read",
      "read",
      "reversible",
    ]);
  });

  it("invokes application service ports instead of transport code", async () => {
    const ports = services();
    const toolSet = createAbletonTools(ports);
    const invocation = {
      sessionId: "session",
      toolCallId: "call",
      toolName: "test",
      arguments: {},
    };

    await toolSet.tools[0].handler?.({}, invocation);
    await toolSet.tools[1].handler?.({}, invocation);
    await toolSet.tools[2].handler?.({ tempo: 132 }, invocation);

    expect(ports.getConnectionStatus).toHaveBeenCalledOnce();
    expect(ports.inspectSession).toHaveBeenCalledOnce();
    expect(ports.setTempo).toHaveBeenCalledWith(132);
  });

  it("auto-approves reads and denies mutations without approval", async () => {
    const handler = createAbletonPermissionHandler();

    await expect(
      handler(
        {
          kind: "custom-tool",
          toolName: "ableton_session_inspect",
          toolDescription: "Inspect",
        },
        { sessionId: "session" },
      ),
    ).resolves.toEqual({ kind: "approve-once" });
    await expect(
      handler(
        {
          kind: "custom-tool",
          toolName: "ableton_transport_set_tempo",
          toolDescription: "Set tempo",
          args: { tempo: 132 },
        },
        { sessionId: "session" },
      ),
    ).resolves.toEqual({
      kind: "reject",
      feedback: "Mutating Ableton tools require explicit user approval",
    });
    await expect(
      handler(
        {
          kind: "custom-tool",
          toolName: "ableton_session_inspect",
          toolDescription: "Inspect",
        },
        { sessionId: "session", managedSettingsEnabled: true },
      ),
    ).resolves.toEqual({ kind: "no-result" });
  });

  it("delegates reversible mutations to an approval requester", async () => {
    const requestApproval = vi.fn((request: ToolApprovalRequest) => {
      void request;
      return Promise.resolve(true);
    });
    const handler = createAbletonPermissionHandler(requestApproval);

    await expect(
      handler(
        {
          kind: "custom-tool",
          toolName: "ableton_transport_set_tempo",
          toolDescription: "Set tempo",
          args: { tempo: 132 },
        },
        { sessionId: "session" },
      ),
    ).resolves.toEqual({ kind: "approve-once" });
    expect(requestApproval.mock.calls[0]?.[0]).toMatchObject({
      metadata: {
        name: "ableton_transport_set_tempo",
        risk: "reversible",
      },
      arguments: { tempo: 132 },
    });
  });
});
