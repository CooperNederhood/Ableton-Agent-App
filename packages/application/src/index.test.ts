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
      "custom:ableton_browser_load_item",
    ]);
    expect(config?.tools).toHaveLength(37);
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
