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
    setPlaying: vi.fn((isPlaying: boolean) =>
      Promise.resolve({
        beforeIsPlaying: !isPlaying,
        afterIsPlaying: isPlaying,
        verified: true,
      }),
    ),
    createTrack: vi.fn((params: { kind: "midi" | "audio"; name?: string }) =>
      Promise.resolve({
        beforeTrackCount: 2,
        afterTrackCount: 3,
        track: {
          index: 2,
          reference: "00000000-0000-4000-8000-000000000003",
          name: params.name ?? "MIDI",
          kind: params.kind,
        },
        verified: true,
      }),
    ),
    deleteTrack: vi.fn(
      (params: {
        index: number;
        expectedReference: string;
        expectedName: string;
        expectedKind: "midi" | "audio";
      }) =>
        Promise.resolve({
          beforeTrackCount: 2,
          afterTrackCount: 1,
          track: {
            index: params.index,
            reference: params.expectedReference,
            name: "Track",
            kind: "midi" as const,
          },
          verified: true,
        }),
    ),
    renameTrack: vi.fn(
      (params: {
        index: number;
        expectedReference: string;
        expectedName: string;
        name: string;
      }) =>
        Promise.resolve({
          reference: params.expectedReference,
          index: params.index,
          beforeName: params.expectedName,
          afterName: params.name,
          verified: true as const,
        }),
    ),
    setTrackMixer: vi.fn(
      (params: {
        index: number;
        expectedReference: string;
        expectedName: string;
        isMuted?: boolean;
        volume?: number;
      }) =>
        Promise.resolve({
          reference: params.expectedReference,
          index: params.index,
          before: {
            isMuted: false,
            isSoloed: false,
            isArmed: false,
            volume: 0.8,
            pan: 0,
          },
          after: {
            isMuted: params.isMuted ?? false,
            isSoloed: false,
            isArmed: false,
            volume: params.volume ?? 0.8,
            pan: 0,
          },
          verified: true as const,
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
      "custom:ableton_transport_set_playing",
      "custom:ableton_tracks_create",
      "custom:ableton_tracks_delete",
      "custom:ableton_tracks_rename",
      "custom:ableton_tracks_set_mixer",
    ]);
    expect(abletonToolMetadata.map((metadata) => metadata.risk)).toEqual([
      "read",
      "read",
      "reversible",
      "reversible",
      "reversible",
      "destructive",
      "reversible",
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
    await toolSet.tools[3].handler?.({ isPlaying: true }, invocation);
    await toolSet.tools[4].handler?.(
      { kind: "audio", name: "Vocals" },
      invocation,
    );
    await toolSet.tools[5].handler?.(
      {
        index: 1,
        expectedReference: "00000000-0000-4000-8000-000000000002",
        expectedName: "Bass",
        expectedKind: "midi",
      },
      invocation,
    );
    await toolSet.tools[6].handler?.(
      {
        index: 1,
        expectedReference: "00000000-0000-4000-8000-000000000002",
        expectedName: "Bass",
        name: "Sub Bass",
      },
      invocation,
    );
    await toolSet.tools[7].handler?.(
      {
        index: 1,
        expectedReference: "00000000-0000-4000-8000-000000000002",
        expectedName: "Sub Bass",
        isMuted: true,
        volume: 0.6,
      },
      invocation,
    );

    expect(ports.getConnectionStatus).toHaveBeenCalledOnce();
    expect(ports.inspectSession).toHaveBeenCalledOnce();
    expect(ports.setTempo).toHaveBeenCalledWith(132);
    expect(ports.setPlaying).toHaveBeenCalledWith(true);
    expect(ports.createTrack).toHaveBeenCalledWith({
      kind: "audio",
      name: "Vocals",
    });
    expect(ports.deleteTrack).toHaveBeenCalledWith({
      index: 1,
      expectedReference: "00000000-0000-4000-8000-000000000002",
      expectedName: "Bass",
      expectedKind: "midi",
    });
    expect(ports.renameTrack).toHaveBeenCalledWith({
      index: 1,
      expectedReference: "00000000-0000-4000-8000-000000000002",
      expectedName: "Bass",
      name: "Sub Bass",
    });
    expect(ports.setTrackMixer).toHaveBeenCalledWith({
      index: 1,
      expectedReference: "00000000-0000-4000-8000-000000000002",
      expectedName: "Sub Bass",
      isMuted: true,
      volume: 0.6,
    });
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
