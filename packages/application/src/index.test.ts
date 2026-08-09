import { describe, expect, it, vi } from "vitest";
import type { SessionConfig, SessionEvent } from "@github/copilot-sdk";

import {
  InMemoryEventPublisher,
  noopLogger,
  type AppEvent,
} from "@ableton-agent/shared";

import {
  CopilotAgentService,
  HeadlessApplication,
  type AbletonService,
  type AgentService,
} from "./index.js";

function services(status: Awaited<ReturnType<AbletonService["getStatus"]>>) {
  const agent: AgentService = {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    send: vi.fn(async (prompt) => `reply:${prompt}`),
  };
  const ableton: AbletonService = {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    getStatus: vi.fn(async () => status),
    getCapabilities: vi.fn(async () => ({
      selectedProtocolVersion: 2 as const,
      liveVersion: "12.1",
      remoteScriptVersion: "0.2.0",
      projectId: "project",
      capabilities: {},
      limits: { maxFrameBytes: 1024, maxBatchItems: 128 },
    })),
    ping: vi.fn(async () => ({ pong: true as const })),
    inspectSession: vi.fn(async () => ({
      tempo: 120,
      timeSignature: { numerator: 4, denominator: 4 },
      isPlaying: false,
      trackCount: 0,
      tracks: [],
    })),
    setTempo: vi.fn(async (tempo: number) => ({
      beforeTempo: 120,
      afterTempo: tempo,
      verified: true,
    })),
    setPlaying: vi.fn(async (isPlaying: boolean) => ({
      beforeIsPlaying: !isPlaying,
      afterIsPlaying: isPlaying,
      verified: true,
    })),
    createTrack: vi.fn(
      async (params: Parameters<AbletonService["createTrack"]>[0]) => ({
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
      async (params: Parameters<AbletonService["deleteTrack"]>[0]) => ({
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
  };
  const events = new InMemoryEventPublisher();
  return { agent, ableton, events, logger: noopLogger };
}

describe("HeadlessApplication", () => {
  it("starts services and publishes lifecycle in order", async () => {
    const deps = services({ state: "disconnected" });
    const events: AppEvent[] = [];
    deps.events.subscribe((event) => events.push(event));
    const application = new HeadlessApplication(deps);

    await application.start();

    expect(application.state).toBe("degraded");
    expect(events.map((event) => event.type)).toEqual([
      "lifecycle.changed",
      "ableton.connection_changed",
      "lifecycle.changed",
    ]);
  });

  it("enters degraded state when Ableton reports an error", async () => {
    const application = new HeadlessApplication(
      services({ state: "error", code: "offline", message: "not connected" }),
    );
    await application.start();
    expect(application.state).toBe("degraded");
  });

  it("stops the agent before the Ableton service", async () => {
    const order: string[] = [];
    const deps = services({ state: "disconnected" });
    deps.agent.stop = vi.fn(async () => {
      order.push("agent");
    });
    deps.ableton.stop = vi.fn(async () => {
      order.push("ableton");
    });
    const application = new HeadlessApplication(deps);

    await application.start();
    await application.stop();

    expect(order).toEqual(["agent", "ableton"]);
    expect(application.state).toBe("stopped");
  });
});

describe("CopilotAgentService", () => {
  it("creates a restricted session and forwards a prompt", async () => {
    let config: SessionConfig | undefined;
    const disconnect = vi.fn(() => Promise.resolve());
    const stop = vi.fn(() => Promise.resolve([]));
    const sendAndWait = vi.fn(() =>
      Promise.resolve({ data: { content: "Ableton is connected." } }),
    );
    const requestToolApproval = vi.fn(() => Promise.resolve(true));
    const service = new CopilotAgentService({
      events: new InMemoryEventPublisher(),
      getAbletonStatus: () =>
        Promise.resolve({
          state: "connected",
          liveVersion: "12.1",
          remoteScriptVersion: "0.1.0",
          projectId: "project",
        }),
      inspectSession: () =>
        Promise.resolve({
          tempo: 120,
          timeSignature: { numerator: 4, denominator: 4 },
          isPlaying: false,
          trackCount: 0,
          tracks: [],
        }),
      setTempo: (tempo) =>
        Promise.resolve({
          beforeTempo: 120,
          afterTempo: tempo,
          verified: true,
        }),
      setPlaying: (isPlaying) =>
        Promise.resolve({
          beforeIsPlaying: !isPlaying,
          afterIsPlaying: isPlaying,
          verified: true,
        }),
      createTrack: (params) =>
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
      deleteTrack: (params) =>
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
      requestToolApproval,
      clientFactory: () => ({
        createSession: (received) => {
          config = received;
          return Promise.resolve({
            sendAndWait,
            disconnect,
            on: () => () => undefined,
          });
        },
        stop,
      }),
    });

    await service.start();
    const response = await service.send("Check the connection");
    await service.stop();

    expect(response).toBe("Ableton is connected.");
    expect(config?.availableTools).toEqual([
      "custom:ableton_connection_status",
      "custom:ableton_session_inspect",
      "custom:ableton_transport_set_tempo",
      "custom:ableton_transport_set_playing",
      "custom:ableton_tracks_create",
      "custom:ableton_tracks_delete",
    ]);
    expect(config?.tools).toHaveLength(6);
    await expect(
      config?.onPermissionRequest?.(
        {
          kind: "custom-tool",
          toolName: "ableton_transport_set_tempo",
          toolDescription: "Set tempo",
          args: { tempo: 132 },
        },
        { sessionId: "session" },
      ),
    ).resolves.toEqual({ kind: "approve-once" });
    expect(requestToolApproval).toHaveBeenCalledOnce();
    expect(sendAndWait).toHaveBeenCalledWith("Check the connection");
    expect(disconnect).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("normalizes assistant and tool execution events", async () => {
    const events = new InMemoryEventPublisher();
    const received: AppEvent[] = [];
    events.subscribe((event) => received.push(event));
    let listener: ((event: SessionEvent) => void) | undefined;
    const service = new CopilotAgentService({
      events,
      getAbletonStatus: () => Promise.resolve({ state: "disconnected" }),
      inspectSession: () =>
        Promise.resolve({
          tempo: 120,
          timeSignature: { numerator: 4, denominator: 4 },
          isPlaying: false,
          trackCount: 0,
          tracks: [],
        }),
      setTempo: (tempo) =>
        Promise.resolve({
          beforeTempo: 120,
          afterTempo: tempo,
          verified: true,
        }),
      setPlaying: (isPlaying) =>
        Promise.resolve({
          beforeIsPlaying: !isPlaying,
          afterIsPlaying: isPlaying,
          verified: true,
        }),
      createTrack: (params) =>
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
      deleteTrack: (params) =>
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
      clientFactory: () => ({
        createSession: () =>
          Promise.resolve({
            sendAndWait: () =>
              Promise.resolve({ data: { content: "complete" } }),
            disconnect: () => Promise.resolve(),
            on: (receivedListener) => {
              listener = receivedListener;
              return () => undefined;
            },
          }),
        stop: () => Promise.resolve([]),
      }),
    });
    await service.start();

    listener?.({
      type: "assistant.message_delta",
      id: "event-1",
      parentId: null,
      timestamp: "2026-08-08T00:00:00.000Z",
      ephemeral: true,
      data: { messageId: "message-1", deltaContent: "hello" },
    });
    listener?.({
      type: "tool.execution_start",
      id: "event-2",
      parentId: "event-1",
      timestamp: "2026-08-08T00:00:01.000Z",
      data: {
        toolCallId: "tool-1",
        toolName: "ableton_session_inspect",
      },
    });
    listener?.({
      type: "tool.execution_complete",
      id: "event-3",
      parentId: "event-2",
      timestamp: "2026-08-08T00:00:02.000Z",
      data: {
        toolCallId: "tool-1",
        success: true,
      },
    });
    listener?.({
      type: "tool.execution_start",
      id: "event-4",
      parentId: "event-3",
      timestamp: "2026-08-08T00:00:03.000Z",
      data: {
        toolCallId: "tool-2",
        toolName: "ableton_connection_status",
      },
    });
    listener?.({
      type: "tool.execution_complete",
      id: "event-5",
      parentId: "event-4",
      timestamp: "2026-08-08T00:00:04.000Z",
      data: {
        toolCallId: "tool-2",
        success: false,
        error: { code: "offline", message: "Ableton is offline" },
      },
    });

    expect(received).toEqual([
      { type: "agent.message_delta", content: "hello" },
      {
        type: "operation.started",
        operationId: "tool-1",
        label: "Inspect Ableton session",
      },
      {
        type: "operation.completed",
        operationId: "tool-1",
        summary: "Inspect Ableton session completed",
      },
      {
        type: "operation.started",
        operationId: "tool-2",
        label: "Check Ableton connection",
      },
      {
        type: "operation.failed",
        operationId: "tool-2",
        code: "offline",
        message: "Ableton is offline",
      },
    ]);
    await service.stop();
  });
});
