import { describe, expect, it, vi } from "vitest";
import type { SessionConfig, SessionEvent } from "@github/copilot-sdk";
import type { SkillInvocation } from "@ableton-agent/agent-config";
import { serializeAbletonToolFailure } from "@ableton-agent/tools";

import {
  InMemoryEventPublisher,
  noopLogger,
  type AppEvent,
} from "@ableton-agent/shared";

import {
  CopilotAgentService,
  DEFAULT_AGENT_TURN_TIMEOUT_MS,
  HeadlessApplication,
  type AbletonService,
  type AgentRuntimeEvent,
  type AgentSessionConfiguration,
  type AgentService,
} from "./index.js";

function sessionClipServices() {
  return {
    launchSessionClip: async (
      params: Parameters<AbletonService["launchSessionClip"]>[0],
    ) => ({
      clip: {
        reference: params.expectedClipReference,
        trackReference: params.expectedReference,
        trackIndex: params.index,
        sceneIndex: params.sceneIndex,
        name: "Beat",
        kind: "midi" as const,
        length: 4,
        noteCount: 1,
      },
      before: {
        trackPlayingSceneIndex: null,
        trackPlayingClipReference: null,
        targetIsPlaying: false,
        targetIsTriggered: false,
      },
      after: {
        trackPlayingSceneIndex: params.sceneIndex,
        trackPlayingClipReference: params.expectedClipReference,
        targetIsPlaying: true,
        targetIsTriggered: false,
      },
      verified: true as const,
    }),
    duplicateSessionClip: async (
      params: Parameters<AbletonService["duplicateSessionClip"]>[0],
    ) => ({
      sourceClip: {
        reference: params.expectedClipReference,
        trackReference: params.expectedReference,
        trackIndex: params.index,
        sceneIndex: params.sceneIndex,
        name: "Beat",
        kind: "midi" as const,
        length: 4,
        noteCount: 1,
      },
      clip: {
        reference: "00000000-0000-4000-8000-000000000011",
        trackReference: params.expectedDestinationTrackReference,
        trackIndex: params.destinationTrackIndex,
        sceneIndex: params.destinationSceneIndex,
        name: "Beat",
        kind: "midi" as const,
        length: 4,
        noteCount: 1,
      },
      verified: true as const,
    }),
    deleteSessionClip: async (
      params: Parameters<AbletonService["deleteSessionClip"]>[0],
    ) => ({
      clip: {
        reference: params.expectedClipReference,
        trackReference: params.expectedReference,
        trackIndex: params.index,
        sceneIndex: params.sceneIndex,
        name: "Beat",
        kind: "midi" as const,
        length: 4,
        noteCount: 1,
      },
      beforeClipCount: 2,
      afterClipCount: 1,
      verified: true as const,
    }),
    setSessionClipProperties: async (
      params: Parameters<AbletonService["setSessionClipProperties"]>[0],
    ) => ({
      clip: {
        reference: params.expectedClipReference,
        trackReference: params.expectedReference,
        trackIndex: params.index,
        sceneIndex: params.sceneIndex,
        name: params.name ?? "Beat",
        kind: "midi" as const,
        length: 4,
        noteCount: 1,
      },
      before: { name: "Beat", muted: false, looping: true },
      after: {
        name: params.name ?? "Beat",
        muted: params.muted ?? false,
        looping: params.looping ?? true,
      },
      verified: true as const,
    }),
  };
}

function arrangementTransportServices() {
  return {
    inspectArrangementTransport: async (
      params: Parameters<AbletonService["inspectArrangementTransport"]>[0],
    ) => ({
      loop: { enabled: false, start: 0, length: 16 },
      cuePoints: [],
      totalCuePoints: 0,
      offset: params.offset,
      limit: params.limit,
    }),
    setArrangementLoop: async (
      params: Parameters<AbletonService["setArrangementLoop"]>[0],
    ) => ({
      before: { enabled: false, start: 0, length: 16 },
      after: {
        enabled: params.enabled ?? false,
        start: params.start ?? 0,
        length: params.length ?? 16,
      },
      verified: true as const,
    }),
    createCuePoint: async (
      params: Parameters<AbletonService["createCuePoint"]>[0],
    ) => ({
      cuePoint: {
        reference: "00000000-0000-4000-8000-000000000030",
        name: params.name ?? "3",
        time: params.time,
      },
      beforeCuePointCount: 2,
      afterCuePointCount: 3,
      verified: true as const,
    }),
    deleteCuePoint: async (
      params: Parameters<AbletonService["deleteCuePoint"]>[0],
    ) => ({
      cuePoint: {
        reference: params.expectedReference,
        name: params.expectedName,
        time: params.expectedTime,
      },
      beforeCuePointCount: 3,
      afterCuePointCount: 2,
      verified: true as const,
    }),
  };
}

function deviceServices() {
  const device = {
    reference: "00000000-0000-4000-8000-000000000040",
    trackReference: "00000000-0000-4000-8000-000000000001",
    trackIndex: 0,
    index: 0,
    name: "Operator",
    className: "Operator",
    classDisplayName: "Operator",
    enabled: true,
    parameterCount: 2,
    canHaveChains: false,
    canHaveDrumPads: false,
  };
  const parameter = {
    reference: "00000000-0000-4000-8000-000000000041",
    deviceReference: device.reference,
    index: 1,
    name: "Filter Freq",
    value: 0.5,
    normalizedValue: 0.5,
    min: 0,
    max: 1,
    isQuantized: false,
    isEnabled: true,
    valueItemCount: 0,
  };
  const browserItem = {
    reference: "00000000-0000-4000-8000-000000000050",
    root: "instruments" as const,
    path: [
      { index: 0, name: "Synths" },
      { index: 0, name: "Operator" },
    ],
    name: "Operator",
    uri: "ableton://instruments/operator",
    isFolder: false,
    isLoadable: true,
    isDevice: true,
    source: "instrument",
    isBuiltInDevice: true,
  };
  return {
    inspectDevices: async (
      params: Parameters<AbletonService["inspectDevices"]>[0],
    ) => ({
      devices: [device],
      total: 1,
      offset: params.offset,
      limit: params.limit,
    }),
    inspectDeviceParameters: async (
      params: Parameters<AbletonService["inspectDeviceParameters"]>[0],
    ) => ({
      device,
      parameters: [parameter],
      total: 1,
      offset: params.offset,
      limit: params.limit,
    }),
    inspectBrowserRoots: async () => ({
      roots: [
        {
          ...browserItem,
          path: [],
          name: "Instruments",
          uri: "ableton://instruments",
          isFolder: true,
          isLoadable: false,
          isDevice: false,
          source: "",
          isBuiltInDevice: false,
        },
      ],
      cacheLimit: 512,
    }),
    inspectBrowserChildren: async (
      params: Parameters<AbletonService["inspectBrowserChildren"]>[0],
    ) => ({
      parent: {
        ...browserItem,
        reference: params.expectedItemReference,
        root: params.expectedItemRoot,
        path: params.expectedItemPath,
        name: params.expectedItemName,
        uri: params.expectedItemUri,
        isFolder: true,
        isLoadable: false,
        isDevice: false,
        source: "",
        isBuiltInDevice: false,
      },
      items: [browserItem],
      total: 1,
      hasMore: false,
      offset: params.offset,
      limit: params.limit,
    }),
    searchBrowser: async (
      params: Parameters<AbletonService["searchBrowser"]>[0],
    ) => ({
      query: params.query,
      items: [browserItem],
      visitedNodes: 3,
      truncated: false,
      stopReason: "complete" as const,
      limits: {
        maxNodes: params.maxNodes,
        maxResults: params.maxResults,
        maxDepth: params.maxDepth,
        maxDurationMs: params.maxDurationMs,
      },
    }),
    loadBrowserItem: async (
      params: Parameters<AbletonService["loadBrowserItem"]>[0],
    ) => ({
      track: {
        index: params.index,
        reference: params.expectedReference,
        name: params.expectedName,
        kind: "midi" as const,
      },
      item: browserItem,
      before: {
        deviceCount: 1,
        deviceReferences: [device.reference],
        deviceNames: [device.name],
        devicesTruncated: false,
        sessionClipCount: 0,
        occupiedSessionSlots: [],
        clipsTruncated: false,
      },
      after: {
        deviceCount: 2,
        deviceReferences: [device.reference, browserItem.reference],
        deviceNames: [device.name, browserItem.name],
        devicesTruncated: false,
        sessionClipCount: 0,
        occupiedSessionSlots: [],
        clipsTruncated: false,
      },
      addedDevices: [{ ...device, name: browserItem.name }],
      addedDevicesTruncated: false,
      reconfiguredDevices: [],
      reconfiguredDevicesTruncated: false,
      mutationMode: "added" as const,
      verified: true as const,
    }),
    inspectRackChains: async (
      params: Parameters<AbletonService["inspectRackChains"]>[0],
    ) => ({
      rack: { ...device, canHaveChains: true },
      chains: [],
      total: 0,
      offset: params.offset,
      limit: params.limit,
    }),
    inspectRackChainDevices: async (
      params: Parameters<AbletonService["inspectRackChainDevices"]>[0],
    ) => ({
      rack: { ...device, canHaveChains: true },
      chain: {
        reference: params.expectedChainReference,
        rackDeviceReference: params.expectedDeviceReference,
        index: params.chainIndex,
        name: params.expectedChainName,
        color: null,
        deviceCount: 0,
      },
      devices: [],
      total: 0,
      offset: params.offset,
      limit: params.limit,
    }),
    inspectDrumRackPads: async (
      params: Parameters<AbletonService["inspectDrumRackPads"]>[0],
    ) => ({
      rack: {
        ...device,
        canHaveChains: true,
        canHaveDrumPads: true,
      },
      pads: [],
      total: 0,
      offset: params.offset,
      limit: params.limit,
    }),
    inspectDrumPadChains: async (
      params: Parameters<AbletonService["inspectDrumPadChains"]>[0],
    ) => ({
      rack: {
        ...device,
        canHaveChains: true,
        canHaveDrumPads: true,
      },
      pad: {
        reference: params.expectedPadReference,
        rackDeviceReference: params.expectedDeviceReference,
        index: params.padIndex,
        note: params.expectedPadNote,
        name: params.expectedPadName,
        mute: false,
        solo: false,
        chainCount: 0,
      },
      chains: [],
      total: 0,
      offset: params.offset,
      limit: params.limit,
    }),
    inspectDrumPadChainDevices: async (
      params: Parameters<AbletonService["inspectDrumPadChainDevices"]>[0],
    ) => ({
      rack: {
        ...device,
        canHaveChains: true,
        canHaveDrumPads: true,
      },
      pad: {
        reference: params.expectedPadReference,
        rackDeviceReference: params.expectedDeviceReference,
        index: params.padIndex,
        note: params.expectedPadNote,
        name: params.expectedPadName,
        mute: false,
        solo: false,
        chainCount: 1,
      },
      chain: {
        reference: params.expectedChainReference,
        rackDeviceReference: params.expectedDeviceReference,
        drumPadReference: params.expectedPadReference,
        drumPadIndex: params.padIndex,
        index: params.chainIndex,
        name: params.expectedChainName,
        color: null,
        deviceCount: 0,
      },
      devices: [],
      total: 0,
      offset: params.offset,
      limit: params.limit,
    }),
    setDeviceEnabled: async (
      params: Parameters<AbletonService["setDeviceEnabled"]>[0],
    ) => ({
      device: { ...device, enabled: params.enabled },
      beforeEnabled: !params.enabled,
      afterEnabled: params.enabled,
      verified: true as const,
    }),
    setDeviceParameter: async (
      params: Parameters<AbletonService["setDeviceParameter"]>[0],
    ) => ({
      device,
      before: parameter,
      after: {
        ...parameter,
        value: params.normalizedValue,
        normalizedValue: params.normalizedValue,
      },
      requestedNormalizedValue: params.normalizedValue,
      verified: true as const,
    }),
  };
}

function services(status: Awaited<ReturnType<AbletonService["getStatus"]>>) {
  const agent: AgentService = {
    sessionId: "agent-session",
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    send: vi.fn(async (prompt) => `reply:${prompt}`),
    cancel: vi.fn(async () => true),
    createSession: vi.fn(async () => "created-session"),
    resumeSession: vi.fn(async () => undefined),
  };
  const ableton: AbletonService = {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    getStatus: vi.fn(async () => status),
    getCapabilities: vi.fn(async () => ({
      selectedProtocolVersion: 4 as const,
      liveVersion: "12.1",
      remoteScriptVersion: "0.2.0",
      liveSetId: "set",
      liveSetName: "Test Set",
      saved: true,
      diagnostics: [],
      capabilities: {},
      limits: { maxFrameBytes: 1024, maxBatchItems: 128 },
    })),
    getLiveIdentity: vi.fn(async () => ({
      liveSetId: "set",
      liveSetName: "Test Set",
      saved: true,
      diagnostics: [],
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
    ...arrangementTransportServices(),
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
    renameTrack: vi.fn(
      async (params: Parameters<AbletonService["renameTrack"]>[0]) => ({
        reference: params.expectedReference,
        index: params.index,
        beforeName: params.expectedName,
        afterName: params.name,
        verified: true as const,
      }),
    ),
    setTrackMixer: vi.fn(
      async (params: Parameters<AbletonService["setTrackMixer"]>[0]) => ({
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
          isSoloed: params.isSoloed ?? false,
          isArmed: params.isArmed ?? false,
          volume: params.volume ?? 0.8,
          pan: params.pan ?? 0,
        },
        verified: true as const,
      }),
    ),
    ...deviceServices(),
    createMidiClip: vi.fn(
      async (params: Parameters<AbletonService["createMidiClip"]>[0]) => ({
        clip: {
          reference: "00000000-0000-4000-8000-000000000010",
          trackReference: params.expectedReference,
          trackIndex: params.index,
          sceneIndex: params.sceneIndex,
          name: params.name ?? "",
          length: params.length,
          noteCount: 0,
        },
        verified: true as const,
      }),
    ),
    inspectMidiNotes: vi.fn(
      async (params: Parameters<AbletonService["inspectMidiNotes"]>[0]) => ({
        clip: {
          reference: params.expectedClipReference,
          trackReference: params.expectedReference,
          trackIndex: params.index,
          sceneIndex: params.sceneIndex,
          name: "Beat",
          length: 4,
          noteCount: 0,
        },
        notes: [],
        totalNotes: 0,
        offset: params.offset,
        limit: params.limit,
        truncated: false,
      }),
    ),
    replaceMidiNotes: vi.fn(
      async (params: Parameters<AbletonService["replaceMidiNotes"]>[0]) => ({
        clip: {
          reference: params.expectedClipReference,
          trackReference: params.expectedReference,
          trackIndex: params.index,
          sceneIndex: params.sceneIndex,
          name: "Beat",
          length: 4,
          noteCount: params.notes.length,
        },
        beforeNoteCount: 0,
        afterNoteCount: params.notes.length,
        verified: true as const,
      }),
    ),
    ...sessionClipServices(),
    createArrangementMidiClip: vi.fn(
      async (
        params: Parameters<AbletonService["createArrangementMidiClip"]>[0],
      ) => ({
        clip: {
          reference: "00000000-0000-4000-8000-000000000020",
          trackReference: params.expectedReference,
          trackIndex: params.index,
          name: params.name ?? "",
          kind: "midi" as const,
          startTime: params.startTime,
          endTime: params.startTime + params.length,
          length: params.length,
          noteCount: 0,
        },
        verified: true as const,
      }),
    ),
    inspectArrangement: vi.fn(
      async (params: Parameters<AbletonService["inspectArrangement"]>[0]) => ({
        clips: [],
        total: 0,
        offset: params.offset,
        limit: params.limit,
      }),
    ),
    inspectArrangementMidiNotes: vi.fn(
      async (
        params: Parameters<AbletonService["inspectArrangementMidiNotes"]>[0],
      ) => ({
        clip: {
          reference: params.expectedClipReference,
          trackReference: params.expectedReference,
          trackIndex: params.index,
          name: "Arrangement Beat",
          kind: "midi" as const,
          startTime: params.expectedStartTime,
          endTime: params.expectedStartTime + 4,
          length: 4,
          noteCount: 0,
        },
        notes: [],
        totalNotes: 0,
        offset: params.offset,
        limit: params.limit,
        truncated: false,
      }),
    ),
    deleteArrangementClip: vi.fn(
      async (
        params: Parameters<AbletonService["deleteArrangementClip"]>[0],
      ) => ({
        clip: {
          reference: params.expectedClipReference,
          trackReference: params.expectedReference,
          trackIndex: params.index,
          name: "Verse",
          kind: "midi" as const,
          startTime: params.expectedStartTime,
          endTime: params.expectedStartTime + 4,
          length: 4,
          noteCount: 0,
        },
        beforeClipCount: 1,
        afterClipCount: 0,
        verified: true as const,
      }),
    ),
    replaceArrangementMidiNotes: vi.fn(
      async (
        params: Parameters<AbletonService["replaceArrangementMidiNotes"]>[0],
      ) => ({
        clip: {
          reference: params.expectedClipReference,
          trackReference: params.expectedReference,
          trackIndex: params.index,
          name: "Verse",
          kind: "midi" as const,
          startTime: params.expectedStartTime,
          endTime: params.expectedStartTime + 4,
          length: 4,
          noteCount: params.notes.length,
        },
        beforeNoteCount: 0,
        afterNoteCount: params.notes.length,
        verified: true as const,
      }),
    ),
    duplicateClipToArrangement: vi.fn(
      async (
        params: Parameters<AbletonService["duplicateClipToArrangement"]>[0],
      ) => ({
        sourceClip: {
          reference: params.expectedClipReference,
          trackReference: params.expectedReference,
          trackIndex: params.index,
          sceneIndex: params.sceneIndex,
          name: "Beat",
          kind: "midi" as const,
          length: 4,
          noteCount: 1,
        },
        clip: {
          reference: "00000000-0000-4000-8000-000000000021",
          trackReference: params.expectedReference,
          trackIndex: params.index,
          name: "Beat",
          kind: "midi" as const,
          startTime: params.destinationTime,
          endTime: params.destinationTime + 4,
          length: 4,
          noteCount: 1,
        },
        beforeClipCount: 1,
        afterClipCount: 2,
        verified: true as const,
      }),
    ),
    fillArrangementRegion: vi.fn(
      async (
        params: Parameters<AbletonService["fillArrangementRegion"]>[0],
      ) => ({
        sourceClip: {
          reference: params.expectedClipReference,
          trackReference: params.expectedReference,
          trackIndex: params.index,
          sceneIndex: params.sceneIndex,
          name: "Beat",
          kind: "midi" as const,
          length: 4,
          noteCount: 1,
        },
        clips: [
          {
            reference: "00000000-0000-4000-8000-000000000022",
            trackReference: params.expectedReference,
            trackIndex: params.index,
            name: "Beat",
            kind: "midi" as const,
            startTime: params.regionStart,
            endTime: params.regionStart + 4,
            length: 4,
            noteCount: 1,
          },
        ],
        regionStart: params.regionStart,
        regionEnd: params.regionEnd,
        sourceLength: 4,
        fullTileCount: 1,
        coveredEnd: params.regionStart + 4,
        unusedRemainder: params.regionEnd - params.regionStart - 4,
        beforeClipCount: 1,
        afterClipCount: 2,
        verified: true as const,
      }),
    ),
    setArrangementClipProperties: vi.fn(
      async (
        params: Parameters<AbletonService["setArrangementClipProperties"]>[0],
      ) => ({
        clip: {
          reference: params.expectedClipReference,
          trackReference: params.expectedReference,
          trackIndex: params.index,
          name: params.name ?? "Verse",
          kind: "midi" as const,
          startTime: params.expectedStartTime,
          endTime: params.expectedStartTime + 4,
          length: 4,
          noteCount: 1,
        },
        before: { name: "Verse", muted: false, looping: true },
        after: {
          name: params.name ?? "Verse",
          muted: params.muted ?? false,
          looping: params.looping ?? true,
        },
        verified: true as const,
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
    vi.useFakeTimers();
    expect(DEFAULT_AGENT_TURN_TIMEOUT_MS).toBe(600_000);
    let turnTimeoutMs = 180_000;
    let reasoningSummary: "concise" | "detailed" = "concise";
    let config: SessionConfig | undefined;
    let resumedConfig: SessionConfig | undefined;
    const disconnect = vi.fn(() => Promise.resolve());
    const stop = vi.fn(() => Promise.resolve([]));
    const abort = vi.fn(() => Promise.resolve());
    const requestToolApproval = vi.fn(() => Promise.resolve(true));
    const runtimeEvents: AgentRuntimeEvent[] = [];
    const appEvents: AppEvent[] = [];
    const events = new InMemoryEventPublisher();
    events.subscribe((event) => appEvents.push(event));
    const listeners = new Set<(event: SessionEvent) => void>();
    const emit = (event: SessionEvent): void => {
      for (const listener of listeners) listener(event);
    };
    const send = vi.fn(
      async (message: {
        prompt: string;
        agentMode?: "interactive" | "plan";
      }) => {
        if (message.prompt === "Check the connection") {
          emit({
            type: "assistant.turn_start",
            id: "turn-start-1",
            parentId: null,
            timestamp: new Date().toISOString(),
            data: { turnId: "turn-1", model: "claude-sonnet-4.6" },
          });
          emit({
            type: "assistant.intent",
            id: "intent-1",
            parentId: "turn-start-1",
            timestamp: new Date().toISOString(),
            ephemeral: true,
            data: { intent: "Inspecting the current connection" },
          });
          emit({
            type: "assistant.reasoning_delta",
            id: "reasoning-delta-1",
            parentId: "intent-1",
            timestamp: new Date().toISOString(),
            ephemeral: true,
            data: {
              reasoningId: "reasoning-1",
              deltaContent: "Checking the bridge ",
            },
          });
          emit({
            type: "assistant.streaming_delta",
            id: "streaming-1",
            parentId: "reasoning-delta-1",
            timestamp: new Date().toISOString(),
            ephemeral: true,
            data: { totalResponseSizeBytes: 24 },
          });
          emit({
            type: "assistant.message_delta",
            id: "message-delta-1",
            parentId: "streaming-1",
            timestamp: new Date().toISOString(),
            ephemeral: true,
            data: {
              messageId: "message-1",
              deltaContent: "Ableton is connected.",
            },
          });
          emit({
            type: "assistant.reasoning",
            id: "reasoning-1",
            parentId: "message-delta-1",
            timestamp: new Date().toISOString(),
            data: {
              reasoningId: "reasoning-1",
              content: "Checked the bridge connection.",
            },
          });
          emit({
            type: "assistant.message",
            id: "assistant-1",
            parentId: null,
            timestamp: new Date().toISOString(),
            data: {
              messageId: "message-1",
              content: "Ableton is connected.",
            },
          });
          emit({
            type: "assistant.turn_end",
            id: "turn-end-1",
            parentId: "assistant-1",
            timestamp: new Date().toISOString(),
            data: { turnId: "turn-1", model: "claude-sonnet-4.6" },
          });
          emit({
            type: "session.idle",
            id: "idle-1",
            parentId: null,
            timestamp: new Date().toISOString(),
            ephemeral: true,
            data: { mode: "interactive" },
          });
        } else {
          emit({
            type: "tool.execution_start",
            id: "mutation-start",
            parentId: null,
            timestamp: new Date().toISOString(),
            data: {
              toolCallId: "mutation-call",
              toolName: "ableton_arrangement_fill_region",
              arguments: { regionStart: 0, regionEnd: 32 },
            },
          });
          emit({
            type: "tool.execution_start",
            id: "read-start",
            parentId: null,
            timestamp: new Date().toISOString(),
            data: {
              toolCallId: "read-call",
              toolName: "ableton_arrangement_inspect",
              arguments: {},
            },
          });
        }
        return `message-${send.mock.calls.length}`;
      },
    );
    const service = new CopilotAgentService({
      events,
      runtimeObserver: {
        enqueue: (event) => runtimeEvents.push(event),
      },
      model: "claude-sonnet-4.6",
      reasoningEffort: "high",
      reasoningSummary: () => reasoningSummary,
      turnTimeoutMs: () => turnTimeoutMs,
      getAbletonStatus: () =>
        Promise.resolve({
          state: "connected",
          liveVersion: "12.1",
          remoteScriptVersion: "0.1.0",
          liveSetId: "set",
          liveSetName: "Test Set",
          saved: true,
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
      ...arrangementTransportServices(),
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
      renameTrack: (params) =>
        Promise.resolve({
          reference: params.expectedReference,
          index: params.index,
          beforeName: params.expectedName,
          afterName: params.name,
          verified: true,
        }),
      setTrackMixer: (params) =>
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
            isSoloed: params.isSoloed ?? false,
            isArmed: params.isArmed ?? false,
            volume: params.volume ?? 0.8,
            pan: params.pan ?? 0,
          },
          verified: true,
        }),
      ...deviceServices(),
      createMidiClip: (params) =>
        Promise.resolve({
          clip: {
            reference: "00000000-0000-4000-8000-000000000010",
            trackReference: params.expectedReference,
            trackIndex: params.index,
            sceneIndex: params.sceneIndex,
            name: params.name ?? "",
            length: params.length,
            noteCount: 0,
          },
          verified: true,
        }),
      replaceMidiNotes: (params) =>
        Promise.resolve({
          clip: {
            reference: params.expectedClipReference,
            trackReference: params.expectedReference,
            trackIndex: params.index,
            sceneIndex: params.sceneIndex,
            name: "Beat",
            length: 4,
            noteCount: params.notes.length,
          },
          beforeNoteCount: 0,
          afterNoteCount: params.notes.length,
          verified: true,
        }),
      ...sessionClipServices(),
      createArrangementMidiClip: (params) =>
        Promise.resolve({
          clip: {
            reference: "00000000-0000-4000-8000-000000000020",
            trackReference: params.expectedReference,
            trackIndex: params.index,
            name: params.name ?? "",
            kind: "midi" as const,
            startTime: params.startTime,
            endTime: params.startTime + params.length,
            length: params.length,
            noteCount: 0,
          },
          verified: true,
        }),
      inspectArrangement: (params) =>
        Promise.resolve({
          clips: [],
          total: 0,
          offset: params.offset,
          limit: params.limit,
        }),
      deleteArrangementClip: (params) =>
        Promise.resolve({
          clip: {
            reference: params.expectedClipReference,
            trackReference: params.expectedReference,
            trackIndex: params.index,
            name: "Verse",
            kind: "midi" as const,
            startTime: params.expectedStartTime,
            endTime: params.expectedStartTime + 4,
            length: 4,
            noteCount: 0,
          },
          beforeClipCount: 1,
          afterClipCount: 0,
          verified: true,
        }),
      replaceArrangementMidiNotes: (params) =>
        Promise.resolve({
          clip: {
            reference: params.expectedClipReference,
            trackReference: params.expectedReference,
            trackIndex: params.index,
            name: "Verse",
            kind: "midi" as const,
            startTime: params.expectedStartTime,
            endTime: params.expectedStartTime + 4,
            length: 4,
            noteCount: params.notes.length,
          },
          beforeNoteCount: 0,
          afterNoteCount: params.notes.length,
          verified: true as const,
        }),
      duplicateClipToArrangement: (params) =>
        Promise.resolve({
          sourceClip: {
            reference: params.expectedClipReference,
            trackReference: params.expectedReference,
            trackIndex: params.index,
            sceneIndex: params.sceneIndex,
            name: "Beat",
            kind: "midi" as const,
            length: 4,
            noteCount: 1,
          },
          clip: {
            reference: "00000000-0000-4000-8000-000000000021",
            trackReference: params.expectedReference,
            trackIndex: params.index,
            name: "Beat",
            kind: "midi" as const,
            startTime: params.destinationTime,
            endTime: params.destinationTime + 4,
            length: 4,
            noteCount: 1,
          },
          beforeClipCount: 1,
          afterClipCount: 2,
          verified: true as const,
        }),
      fillArrangementRegion: (params) =>
        Promise.resolve({
          sourceClip: {
            reference: params.expectedClipReference,
            trackReference: params.expectedReference,
            trackIndex: params.index,
            sceneIndex: params.sceneIndex,
            name: "Beat",
            kind: "midi" as const,
            length: 4,
            noteCount: 1,
          },
          clips: [
            {
              reference: "00000000-0000-4000-8000-000000000022",
              trackReference: params.expectedReference,
              trackIndex: params.index,
              name: "Beat",
              kind: "midi" as const,
              startTime: params.regionStart,
              endTime: params.regionStart + 4,
              length: 4,
              noteCount: 1,
            },
          ],
          regionStart: params.regionStart,
          regionEnd: params.regionEnd,
          sourceLength: 4,
          fullTileCount: 1,
          coveredEnd: params.regionStart + 4,
          unusedRemainder: params.regionEnd - params.regionStart - 4,
          beforeClipCount: 1,
          afterClipCount: 2,
          verified: true as const,
        }),
      setArrangementClipProperties: (params) =>
        Promise.resolve({
          clip: {
            reference: params.expectedClipReference,
            trackReference: params.expectedReference,
            trackIndex: params.index,
            name: params.name ?? "Verse",
            kind: "midi" as const,
            startTime: params.expectedStartTime,
            endTime: params.expectedStartTime + 4,
            length: 4,
            noteCount: 1,
          },
          before: { name: "Verse", muted: false, looping: true },
          after: {
            name: params.name ?? "Verse",
            muted: params.muted ?? false,
            looping: params.looping ?? true,
          },
          verified: true as const,
        }),
      requestToolApproval,
      clientFactory: () => ({
        createSession: (received) => {
          config = received;
          return Promise.resolve({
            sessionId: "session-1",
            send,
            abort,
            disconnect,
            on: (receivedListener) => {
              listeners.add(receivedListener);
              return () => listeners.delete(receivedListener);
            },
          });
        },
        resumeSession: (_sessionId, received) => {
          resumedConfig = received;
          return Promise.resolve({
            sessionId: "session-1",
            send,
            abort,
            disconnect,
            on: (receivedListener) => {
              listeners.add(receivedListener);
              return () => listeners.delete(receivedListener);
            },
          });
        },
        stop,
      }),
    });

    await service.start();
    const response = await service.send("Check the connection");
    reasoningSummary = "detailed";
    turnTimeoutMs = 250;
    const timedOut = service.send("Take too long");
    await vi.advanceTimersByTimeAsync(250);
    await expect(timedOut).rejects.toMatchObject({
      name: "AgentTurnTimeoutError",
      timeoutMs: 250,
    });
    await service.stop();
    vi.useRealTimers();

    expect(response).toBe("Ableton is connected.");
    expect(config?.streaming).toBe(true);
    expect(config?.reasoningSummary).toBe("concise");
    expect(resumedConfig?.streaming).toBe(true);
    expect(resumedConfig?.reasoningSummary).toBe("detailed");
    expect(
      appEvents
        .filter((event) => event.type === "agent.working_update")
        .map((event) => event.update.kind),
    ).toEqual([
      "started",
      "intent",
      "reasoning_delta",
      "streaming",
      "reasoning_complete",
      "finished",
      "started",
      "finished",
    ]);
    expect(config?.availableTools).toEqual([
      "custom:ableton_connection_status",
      "custom:ableton_session_inspect",
      "custom:ableton_transport_set_tempo",
      "custom:ableton_transport_set_playing",
      "custom:ableton_transport_inspect_arrangement",
      "custom:ableton_transport_set_arrangement_loop",
      "custom:ableton_transport_create_cue_point",
      "custom:ableton_transport_delete_cue_point",
      "custom:ableton_tracks_create",
      "custom:ableton_tracks_delete",
      "custom:ableton_tracks_rename",
      "custom:ableton_tracks_set_mixer",
      "custom:ableton_clips_create_midi",
      "custom:ableton_clips_replace_notes",
      "custom:ableton_clips_launch",
      "custom:ableton_clips_duplicate",
      "custom:ableton_clips_delete",
      "custom:ableton_clips_set_properties",
      "custom:ableton_arrangement_create_midi_clip",
      "custom:ableton_arrangement_inspect",
      "custom:ableton_arrangement_delete_clip",
      "custom:ableton_arrangement_replace_notes",
      "custom:ableton_arrangement_duplicate_clip",
      "custom:ableton_arrangement_set_clip_properties",
      "custom:ableton_devices_inspect",
      "custom:ableton_device_parameters_inspect",
      "custom:ableton_rack_chains_inspect",
      "custom:ableton_rack_chain_devices_inspect",
      "custom:ableton_drum_rack_pads_inspect",
      "custom:ableton_drum_pad_chains_inspect",
      "custom:ableton_drum_pad_chain_devices_inspect",
      "custom:ableton_device_set_enabled",
      "custom:ableton_device_set_parameter",
      "custom:ableton_browser_roots_inspect",
      "custom:ableton_browser_children_inspect",
      "custom:ableton_browser_search",
      "custom:ableton_browser_search_external_plugins",
      "custom:ableton_browser_load_item",
      "custom:ableton_arrangement_fill_region",
      "custom:set_sql_search",
      "custom:read_plan",
      "custom:write_plan",
      "builtin:ask_user",
      "builtin:exit_plan_mode",
    ]);
    expect(config?.tools).toHaveLength(42);
    expect(config?.customAgents).toEqual([
      {
        name: "default-agent",
        displayName: "Ableton Agent",
        description:
          "Primary Ableton Live production assistant for the current session.",
        prompt:
          "Act as the general-purpose Ableton production agent for the current Live Set. Inspect when needed, then directly perform the user's requested supported edits with the available tools. Mutations are restricted by tool approval, edit scope, connection, and automatic-analysis policies. Follow the session system message and clearly report observed state, applied changes, and real limitations.\n\nFor questions about prior Live Sets, saves, devices, clips, or agent trajectories, use set_sql_search against the local read-only Set History views. Treat it as historical evidence and inspect the current Live Set before acting.",
        infer: false,
      },
    ]);
    expect(config?.agent).toBe("default-agent");
    expect(config).not.toHaveProperty("skillDirectories");
    expect(config?.systemMessage?.mode).toBeUndefined();
    expect(config?.systemMessage?.content).toContain(
      "Ableton Live production assistant",
    );
    expect(config?.systemMessage?.content).not.toContain(
      "Active plan-mode reminder",
    );
    expect(config?.onExitPlanModeRequest).toBeTypeOf("function");
    expect(config?.askUserVariant).toBe("elicitation");
    expect(config?.toolSearch).toEqual({ enabled: false });
    expect(config?.onUserInputRequest).toBeTypeOf("function");
    expect(config?.onElicitationRequest).toBeTypeOf("function");
    expect(
      config?.tools?.find(({ name }) => name === "read_plan"),
    ).toMatchObject({ skipPermission: true, defer: "never" });
    expect(
      config?.tools?.find(({ name }) => name === "write_plan"),
    ).toMatchObject({ skipPermission: true, defer: "never" });
    await expect(
      config?.onPermissionRequest?.(
        {
          kind: "custom-tool",
          toolName: "write_plan",
          toolDescription: "Write plan",
          args: { content: "# Plan" },
        },
        { sessionId: "session" },
      ),
    ).resolves.toEqual({ kind: "approve-once" });
    expect(requestToolApproval).not.toHaveBeenCalled();
    expect(
      config?.hooks?.onPreToolUse?.(
        {
          sessionId: "session",
          timestamp: new Date(),
          workingDirectory: "/tmp",
          toolName: "write_plan",
          toolArgs: { content: "# Plan" },
        },
        { sessionId: "session" },
      ),
    ).toBeUndefined();
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
    requestToolApproval.mockResolvedValueOnce(false);
    const deniedArgs = { tempo: 140 };
    await expect(
      config?.onPermissionRequest?.(
        {
          kind: "custom-tool",
          toolName: "ableton_transport_set_tempo",
          toolDescription: "Set tempo",
          args: deniedArgs,
        },
        { sessionId: "session" },
      ),
    ).resolves.toMatchObject({ kind: "reject" });
    expect(
      config?.hooks?.onPreToolUse?.(
        {
          sessionId: "session",
          timestamp: new Date(),
          workingDirectory: "/tmp",
          toolName: "ableton_transport_set_tempo",
          toolArgs: deniedArgs,
        },
        { sessionId: "session" },
      ),
    ).toMatchObject({ permissionDecision: "deny" });
    expect(send).toHaveBeenCalledWith({ prompt: "Check the connection" });
    expect(send).toHaveBeenCalledWith({ prompt: "Take too long" });
    expect(abort).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledTimes(2);
    expect(stop).toHaveBeenCalledOnce();
    const snapshot = runtimeEvents.find(
      (event) => event.type === "agent.session.configuration",
    );
    expect(snapshot?.data).toMatchObject({
      customAgentPrompt:
        "Act as the general-purpose Ableton production agent for the current Live Set. Inspect when needed, then directly perform the user's requested supported edits with the available tools. Mutations are restricted by tool approval, edit scope, connection, and automatic-analysis policies. Follow the session system message and clearly report observed state, applied changes, and real limitations.",
      model: "claude-sonnet-4.6",
      reasoningEffort: "high",
      skills: [],
    });
    expect(JSON.stringify(snapshot?.data.sdkSystemMessage)).toContain(
      "Ableton Live production assistant",
    );
    expect(JSON.stringify(snapshot?.data.tools)).toContain(
      '"name":"ableton_transport_set_tempo"',
    );
    expect(JSON.stringify(snapshot?.data.tools)).toContain(
      '"parameterSchema":{"$schema":"https://json-schema.org/draft/2020-12/schema',
    );
    expect(JSON.stringify(snapshot?.data.tools)).toContain('"available":true');
    expect(
      runtimeEvents.filter((event) => event.type === "agent.turn.queued"),
    ).toHaveLength(2);
    expect(
      runtimeEvents.find((event) => event.type === "agent.turn.started")?.data,
    ).toMatchObject({
      origin: "user",
      prompt: "Check the connection",
      timeoutMs: 180_000,
    });
    expect(
      runtimeEvents.find((event) => event.type === "agent.turn.completed")
        ?.data,
    ).toMatchObject({ response: "Ableton is connected." });
    expect(runtimeEvents.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "agent.assistant.final",
        "agent.permission.requested",
        "agent.permission.completed",
        "agent.turn.timeout",
        "agent.abort.requested",
        "agent.abort.completed",
      ]),
    );
    expect(
      runtimeEvents
        .filter((event) => event.type.startsWith("agent.turn."))
        .every((event) => event.trace?.turnId !== undefined),
    ).toBe(true);
    expect(
      appEvents.filter((event) => event.type === "operation.failed"),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operationId: "mutation-call",
          code: "applied_indeterminate",
        }),
        expect.objectContaining({
          operationId: "read-call",
          code: "operation_timeout",
        }),
      ]),
    );
  });

  it("normalizes assistant and tool execution events", async () => {
    const events = new InMemoryEventPublisher();
    const received: AppEvent[] = [];
    const runtimeEvents: AgentRuntimeEvent[] = [];
    events.subscribe((event) => received.push(event));
    let listener: ((event: SessionEvent) => void) | undefined;
    const service = new CopilotAgentService({
      events,
      runtimeObserver: {
        enqueue: (event) => runtimeEvents.push(event),
      },
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
      ...arrangementTransportServices(),
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
      renameTrack: (params) =>
        Promise.resolve({
          reference: params.expectedReference,
          index: params.index,
          beforeName: params.expectedName,
          afterName: params.name,
          verified: true,
        }),
      setTrackMixer: (params) =>
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
            isSoloed: params.isSoloed ?? false,
            isArmed: params.isArmed ?? false,
            volume: params.volume ?? 0.8,
            pan: params.pan ?? 0,
          },
          verified: true,
        }),
      ...deviceServices(),
      createMidiClip: (params) =>
        Promise.resolve({
          clip: {
            reference: "00000000-0000-4000-8000-000000000010",
            trackReference: params.expectedReference,
            trackIndex: params.index,
            sceneIndex: params.sceneIndex,
            name: params.name ?? "",
            length: params.length,
            noteCount: 0,
          },
          verified: true,
        }),
      replaceMidiNotes: (params) =>
        Promise.resolve({
          clip: {
            reference: params.expectedClipReference,
            trackReference: params.expectedReference,
            trackIndex: params.index,
            sceneIndex: params.sceneIndex,
            name: "Beat",
            length: 4,
            noteCount: params.notes.length,
          },
          beforeNoteCount: 0,
          afterNoteCount: params.notes.length,
          verified: true,
        }),
      ...sessionClipServices(),
      createArrangementMidiClip: (params) =>
        Promise.resolve({
          clip: {
            reference: "00000000-0000-4000-8000-000000000020",
            trackReference: params.expectedReference,
            trackIndex: params.index,
            name: params.name ?? "",
            kind: "midi" as const,
            startTime: params.startTime,
            endTime: params.startTime + params.length,
            length: params.length,
            noteCount: 0,
          },
          verified: true,
        }),
      inspectArrangement: (params) =>
        Promise.resolve({
          clips: [],
          total: 0,
          offset: params.offset,
          limit: params.limit,
        }),
      deleteArrangementClip: (params) =>
        Promise.resolve({
          clip: {
            reference: params.expectedClipReference,
            trackReference: params.expectedReference,
            trackIndex: params.index,
            name: "Verse",
            kind: "midi" as const,
            startTime: params.expectedStartTime,
            endTime: params.expectedStartTime + 4,
            length: 4,
            noteCount: 0,
          },
          beforeClipCount: 1,
          afterClipCount: 0,
          verified: true,
        }),
      replaceArrangementMidiNotes: (params) =>
        Promise.resolve({
          clip: {
            reference: params.expectedClipReference,
            trackReference: params.expectedReference,
            trackIndex: params.index,
            name: "Verse",
            kind: "midi" as const,
            startTime: params.expectedStartTime,
            endTime: params.expectedStartTime + 4,
            length: 4,
            noteCount: params.notes.length,
          },
          beforeNoteCount: 0,
          afterNoteCount: params.notes.length,
          verified: true as const,
        }),
      duplicateClipToArrangement: (params) =>
        Promise.resolve({
          sourceClip: {
            reference: params.expectedClipReference,
            trackReference: params.expectedReference,
            trackIndex: params.index,
            sceneIndex: params.sceneIndex,
            name: "Beat",
            kind: "midi" as const,
            length: 4,
            noteCount: 1,
          },
          clip: {
            reference: "00000000-0000-4000-8000-000000000021",
            trackReference: params.expectedReference,
            trackIndex: params.index,
            name: "Beat",
            kind: "midi" as const,
            startTime: params.destinationTime,
            endTime: params.destinationTime + 4,
            length: 4,
            noteCount: 1,
          },
          beforeClipCount: 1,
          afterClipCount: 2,
          verified: true as const,
        }),
      fillArrangementRegion: (params) =>
        Promise.resolve({
          sourceClip: {
            reference: params.expectedClipReference,
            trackReference: params.expectedReference,
            trackIndex: params.index,
            sceneIndex: params.sceneIndex,
            name: "Beat",
            kind: "midi" as const,
            length: 4,
            noteCount: 1,
          },
          clips: [
            {
              reference: "00000000-0000-4000-8000-000000000022",
              trackReference: params.expectedReference,
              trackIndex: params.index,
              name: "Beat",
              kind: "midi" as const,
              startTime: params.regionStart,
              endTime: params.regionStart + 4,
              length: 4,
              noteCount: 1,
            },
          ],
          regionStart: params.regionStart,
          regionEnd: params.regionEnd,
          sourceLength: 4,
          fullTileCount: 1,
          coveredEnd: params.regionStart + 4,
          unusedRemainder: params.regionEnd - params.regionStart - 4,
          beforeClipCount: 1,
          afterClipCount: 2,
          verified: true as const,
        }),
      setArrangementClipProperties: (params) =>
        Promise.resolve({
          clip: {
            reference: params.expectedClipReference,
            trackReference: params.expectedReference,
            trackIndex: params.index,
            name: params.name ?? "Verse",
            kind: "midi" as const,
            startTime: params.expectedStartTime,
            endTime: params.expectedStartTime + 4,
            length: 4,
            noteCount: 1,
          },
          before: { name: "Verse", muted: false, looping: true },
          after: {
            name: params.name ?? "Verse",
            muted: params.muted ?? false,
            looping: params.looping ?? true,
          },
          verified: true as const,
        }),
      clientFactory: () => ({
        createSession: () =>
          Promise.resolve({
            sessionId: "session-1",
            send: () => Promise.resolve("message-1"),
            abort: () => Promise.resolve(),
            disconnect: () => Promise.resolve(),
            on: (receivedListener) => {
              listener = receivedListener;
              return () => undefined;
            },
          }),
        resumeSession: () => Promise.reject(new Error("not used")),
        stop: () => Promise.resolve([]),
      }),
    });
    await service.start();

    listener?.({
      type: "assistant.message_start",
      id: "assistant-start",
      parentId: null,
      timestamp: "2026-08-08T00:00:00.000Z",
      ephemeral: true,
      data: { messageId: "message-1" },
    });
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
      type: "tool.execution_progress",
      id: "tool-progress",
      parentId: "event-2",
      timestamp: "2026-08-08T00:00:01.250Z",
      ephemeral: true,
      data: { toolCallId: "tool-1", progressMessage: "Reading tracks" },
    });
    listener?.({
      type: "tool.execution_partial_result",
      id: "tool-partial",
      parentId: "tool-progress",
      timestamp: "2026-08-08T00:00:01.500Z",
      ephemeral: true,
      data: { toolCallId: "tool-1", partialOutput: "Track 1" },
    });
    listener?.({
      type: "assistant.message",
      id: "assistant-final",
      parentId: "event-5",
      timestamp: "2026-08-08T00:00:05.000Z",
      data: { messageId: "message-1", content: "done" },
    });
    listener?.({
      type: "model.call_failure",
      id: "model-failure",
      parentId: "assistant-final",
      timestamp: "2026-08-08T00:00:06.000Z",
      ephemeral: true,
      data: {
        source: "top_level",
        model: "test-model",
        errorMessage: "provider unavailable",
      },
    });
    listener?.({
      type: "abort",
      id: "abort",
      parentId: "model-failure",
      timestamp: "2026-08-08T00:00:07.000Z",
      data: { reason: "user_initiated" },
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
        error: {
          code: "failure",
          message: serializeAbletonToolFailure(
            Object.assign(new Error("Ableton is offline"), {
              code: "offline",
              retryable: true,
              details: { state: "disconnected" },
            }),
          ),
        },
      },
    });

    expect(received).toEqual([
      {
        type: "agent.message_delta",
        content: "hello",
        sdkSessionId: "session-1",
      },
      {
        type: "operation.started",
        operationId: "tool-1",
        label: "Inspect Ableton session",
        toolName: "ableton_session_inspect",
        arguments: {},
        sdkSessionId: "session-1",
      },
      {
        type: "operation.completed",
        operationId: "tool-1",
        summary: "Inspect Ableton session completed",
        toolName: "ableton_session_inspect",
        sdkSessionId: "session-1",
      },
      {
        type: "operation.started",
        operationId: "tool-2",
        label: "Check Ableton connection",
        toolName: "ableton_connection_status",
        arguments: {},
        sdkSessionId: "session-1",
      },
      {
        type: "operation.failed",
        operationId: "tool-2",
        code: "offline",
        message: "Ableton is offline",
        retryable: true,
        details: { state: "disconnected" },
        toolName: "ableton_connection_status",
        sdkSessionId: "session-1",
      },
    ]);
    expect(runtimeEvents.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "agent.assistant.started",
        "agent.assistant.delta",
        "agent.assistant.final",
        "agent.tool.started",
        "agent.tool.progress",
        "agent.tool.partial",
        "agent.tool.completed",
        "agent.tool.failed",
        "agent.model.failed",
        "agent.turn.aborted",
      ]),
    );
    expect(
      runtimeEvents.find((event) => event.type === "agent.tool.completed")
        ?.data,
    ).toMatchObject({
      toolCallId: "tool-1",
      arguments: {},
      durationMs: 1_000,
    });
    expect(
      runtimeEvents.find((event) => event.type === "agent.tool.failed")?.data,
    ).toMatchObject({
      toolCallId: "tool-2",
      structuredFailure: {
        code: "offline",
        message: "Ableton is offline",
        retryable: true,
        details: { state: "disconnected" },
      },
      durationMs: 1_000,
    });
    await service.stop();
  });
});

describe("HeadlessApplication agent and connection ports", () => {
  it("delegates cancellation, session control, and reconnects", async () => {
    const deps = services({ state: "disconnected" });
    const resumeSession = vi.fn(async () => undefined);
    deps.agent.resumeSession = resumeSession;
    const application = new HeadlessApplication(deps);
    const statuses: AppEvent[] = [];
    deps.events.subscribe((event) => {
      if (event.type === "ableton.connection_changed") statuses.push(event);
    });

    await application.start();
    expect(application.agentSessionId).toBe("agent-session");
    await expect(application.cancel()).resolves.toBe(true);
    await expect(application.createAgentSession()).resolves.toBe(
      "created-session",
    );
    await application.resumeAgentSession("created-session");
    expect(resumeSession).toHaveBeenCalledWith("created-session");
    await expect(application.getLiveIdentity()).resolves.toEqual({
      liveSetId: "set",
      liveSetName: "Test Set",
      saved: true,
      diagnostics: [],
    });

    await expect(application.connectAbleton()).resolves.toEqual({
      state: "disconnected",
    });
    expect(statuses).toHaveLength(2);
    await application.stop();
    await expect(application.connectAbleton()).rejects.toThrow(
      "not running (stopped)",
    );
  });

  it("delegates managed agent methods explicitly", async () => {
    const deps = services({ state: "disconnected" });
    const configuration: AgentSessionConfiguration = {
      instanceId: "agent-a",
      productionSessionId: "production-test",
      definitionName: "compose",
      label: "Compose",
      description: "Compose MIDI phrases.",
      systemPrompt: "Compose MIDI phrases safely.",
      resolvedTools: ["ableton_session_inspect"],
      editScope: ["session"],
      boundTracks: [],
      skills: ["midi"],
      availableSkills: [
        {
          name: "midi",
          description: "Compose MIDI.",
          sourcePath: "/repo/skills/midi/SKILL.md",
          fingerprint: "a".repeat(64),
        },
      ],
    };
    const history = [
      {
        role: "user" as const,
        content: "Write a melody",
        timestamp: "2026-08-08T00:00:00.000Z",
        eventId: "user-1",
        agentInstanceId: "agent-a",
        sdkSessionId: "sdk-agent-a",
      },
    ];
    deps.agent.getManagedAgentSessionId = vi.fn(() => "sdk-agent-a");
    const createManagedAgent = vi.fn(async () => "sdk-agent-a");
    const resumeManagedAgent = vi.fn(async () => undefined);
    const reconfigureManagedAgent = vi.fn(async () => undefined);
    const deactivateManagedAgent = vi.fn(async () => undefined);
    const sendToManagedAgent = vi.fn(async (_instanceId, prompt) => {
      return `managed:${prompt}`;
    });
    const invokeManagedAgentSkill = vi.fn(
      async (_instanceId: string, invocation: string | SkillInvocation) =>
        `skill:${
          typeof invocation === "string"
            ? invocation
            : `/${invocation.skillName} ${invocation.request}`
        }`,
    );
    const cancelManagedAgent = vi.fn(async () => true);
    const getManagedAgentHistory = vi.fn(async () => history);
    deps.agent.createManagedAgent = createManagedAgent;
    deps.agent.resumeManagedAgent = resumeManagedAgent;
    deps.agent.reconfigureManagedAgent = reconfigureManagedAgent;
    deps.agent.deactivateManagedAgent = deactivateManagedAgent;
    deps.agent.sendToManagedAgent = sendToManagedAgent;
    deps.agent.invokeManagedAgentSkill = invokeManagedAgentSkill;
    deps.agent.cancelManagedAgent = cancelManagedAgent;
    deps.agent.getManagedAgentHistory = getManagedAgentHistory;

    const application = new HeadlessApplication(deps);
    await application.start();

    expect(application.getManagedAgentSessionId("agent-a")).toBe("sdk-agent-a");
    await expect(application.createManagedAgent(configuration)).resolves.toBe(
      "sdk-agent-a",
    );
    await application.resumeManagedAgent(configuration, "sdk-agent-a");
    await application.reconfigureManagedAgent(configuration);
    await application.deactivateManagedAgent("agent-a");
    await expect(
      application.sendToManagedAgent("agent-a", "Follow up"),
    ).resolves.toBe("managed:Follow up");
    await expect(
      application.invokeManagedAgentSkill(
        "agent-a",
        "/midi keep the original rhythm",
      ),
    ).resolves.toBe("skill:/midi keep the original rhythm");
    await expect(application.cancelManagedAgent("agent-a")).resolves.toBe(true);
    await expect(application.getManagedAgentHistory("agent-a")).resolves.toBe(
      history,
    );

    expect(createManagedAgent).toHaveBeenCalledWith(configuration);
    expect(resumeManagedAgent).toHaveBeenCalledWith(
      configuration,
      "sdk-agent-a",
    );
    expect(reconfigureManagedAgent).toHaveBeenCalledWith(configuration);
    expect(deactivateManagedAgent).toHaveBeenCalledWith("agent-a");
    expect(sendToManagedAgent).toHaveBeenCalledWith(
      "agent-a",
      "Follow up",
      undefined,
    );
    expect(invokeManagedAgentSkill).toHaveBeenCalledWith(
      "agent-a",
      "/midi keep the original rhythm",
      undefined,
    );
    expect(cancelManagedAgent).toHaveBeenCalledWith("agent-a");
    expect(getManagedAgentHistory).toHaveBeenCalledWith("agent-a");

    await application.stop();
  });
});
