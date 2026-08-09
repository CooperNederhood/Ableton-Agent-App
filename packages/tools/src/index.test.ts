import { describe, expect, it, vi } from "vitest";
import type { ConnectionStatus } from "@ableton-agent/shared";

import {
  AbletonToolPreconditionError,
  abletonToolMetadata,
  createAbletonPermissionHandler,
  createAbletonTools,
  toolCatalogPolicy,
  type AbletonToolServices,
  type ToolApprovalRequest,
} from "./index.js";

function services() {
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
    getConnectionStatus: vi.fn<() => Promise<ConnectionStatus>>(() =>
      Promise.resolve({
        state: "connected" as const,
        liveVersion: "12.1",
        remoteScriptVersion: "0.4.0",
        projectId: "project-test",
      }),
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
    inspectArrangementTransport: vi.fn(
      (params: { offset: number; limit: number }) =>
        Promise.resolve({
          loop: { enabled: false, start: 0, length: 16 },
          cuePoints: [],
          totalCuePoints: 0,
          offset: params.offset,
          limit: params.limit,
        }),
    ),
    setArrangementLoop: vi.fn(
      (params: { enabled?: boolean; start?: number; length?: number }) =>
        Promise.resolve({
          before: { enabled: false, start: 0, length: 16 },
          after: {
            enabled: params.enabled ?? false,
            start: params.start ?? 0,
            length: params.length ?? 16,
          },
          verified: true as const,
        }),
    ),
    createCuePoint: vi.fn((params: { time: number; name?: string }) =>
      Promise.resolve({
        cuePoint: {
          reference: "00000000-0000-4000-8000-000000000030",
          name: params.name ?? "3",
          time: params.time,
        },
        beforeCuePointCount: 2,
        afterCuePointCount: 3,
        verified: true as const,
      }),
    ),
    deleteCuePoint: vi.fn(
      (params: {
        expectedReference: string;
        expectedName: string;
        expectedTime: number;
      }) =>
        Promise.resolve({
          cuePoint: {
            reference: params.expectedReference,
            name: params.expectedName,
            time: params.expectedTime,
          },
          beforeCuePointCount: 3,
          afterCuePointCount: 2,
          verified: true as const,
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
    createMidiClip: vi.fn(
      (params: Parameters<AbletonToolServices["createMidiClip"]>[0]) =>
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
          verified: true as const,
        }),
    ),
    replaceMidiNotes: vi.fn(
      (params: Parameters<AbletonToolServices["replaceMidiNotes"]>[0]) =>
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
          verified: true as const,
        }),
    ),
    launchSessionClip: vi.fn(
      (params: Parameters<AbletonToolServices["launchSessionClip"]>[0]) =>
        Promise.resolve({
          clip: {
            reference: params.expectedClipReference,
            trackReference: params.expectedReference,
            trackIndex: params.index,
            sceneIndex: params.sceneIndex,
            name: "Beat",
            kind: "midi" as const,
            length: 4,
            noteCount: 1,
            isPlaying: true,
            isTriggered: false,
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
    ),
    duplicateSessionClip: vi.fn(
      (params: Parameters<AbletonToolServices["duplicateSessionClip"]>[0]) =>
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
    ),
    deleteSessionClip: vi.fn(
      (params: Parameters<AbletonToolServices["deleteSessionClip"]>[0]) =>
        Promise.resolve({
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
    ),
    setSessionClipProperties: vi.fn(
      (
        params: Parameters<AbletonToolServices["setSessionClipProperties"]>[0],
      ) =>
        Promise.resolve({
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
    ),
    createArrangementMidiClip: vi.fn(
      (
        params: Parameters<AbletonToolServices["createArrangementMidiClip"]>[0],
      ) =>
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
          verified: true as const,
        }),
    ),
    inspectArrangement: vi.fn(
      (params: Parameters<AbletonToolServices["inspectArrangement"]>[0]) =>
        Promise.resolve({
          clips: [],
          total: 0,
          offset: params.offset,
          limit: params.limit,
        }),
    ),
    deleteArrangementClip: vi.fn(
      (params: Parameters<AbletonToolServices["deleteArrangementClip"]>[0]) =>
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
          verified: true as const,
        }),
    ),
    replaceArrangementMidiNotes: vi.fn(
      (
        params: Parameters<
          AbletonToolServices["replaceArrangementMidiNotes"]
        >[0],
      ) =>
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
    ),
    duplicateClipToArrangement: vi.fn(
      (
        params: Parameters<
          AbletonToolServices["duplicateClipToArrangement"]
        >[0],
      ) =>
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
    ),
    setArrangementClipProperties: vi.fn(
      (
        params: Parameters<
          AbletonToolServices["setArrangementClipProperties"]
        >[0],
      ) =>
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
    ),
    inspectDevices: vi.fn(
      (params: Parameters<AbletonToolServices["inspectDevices"]>[0]) =>
        Promise.resolve({
          devices: [
            {
              reference: "00000000-0000-4000-8000-000000000040",
              trackReference: params.expectedReference,
              trackIndex: params.index,
              index: 0,
              name: "Operator",
              className: "Operator",
              classDisplayName: "Operator",
              enabled: true,
              parameterCount: 2,
              canHaveChains: false,
              canHaveDrumPads: false,
            },
          ],
          total: 1,
          offset: params.offset,
          limit: params.limit,
        }),
    ),
    inspectDeviceParameters: vi.fn(
      (params: Parameters<AbletonToolServices["inspectDeviceParameters"]>[0]) =>
        Promise.resolve({
          device: {
            reference: params.expectedDeviceReference,
            trackReference: params.expectedReference,
            trackIndex: params.index,
            index: params.deviceIndex,
            name: params.expectedDeviceName,
            className: "Operator",
            classDisplayName: "Operator",
            enabled: true,
            parameterCount: 2,
            canHaveChains: false,
            canHaveDrumPads: false,
          },
          parameters: [
            {
              reference: "00000000-0000-4000-8000-000000000041",
              deviceReference: params.expectedDeviceReference,
              index: 1,
              name: "Filter Freq",
              value: 0.5,
              normalizedValue: 0.5,
              min: 0,
              max: 1,
              isQuantized: false,
              isEnabled: true,
              valueItemCount: 0,
            },
          ],
          total: 2,
          offset: params.offset,
          limit: params.limit,
        }),
    ),
    inspectBrowserRoots: vi.fn(() =>
      Promise.resolve({
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
    ),
    inspectBrowserChildren: vi.fn(
      (params: Parameters<AbletonToolServices["inspectBrowserChildren"]>[0]) =>
        Promise.resolve({
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
    ),
    searchBrowser: vi.fn(
      (params: Parameters<AbletonToolServices["searchBrowser"]>[0]) =>
        Promise.resolve({
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
    ),
    loadBrowserItem: vi.fn(
      (params: Parameters<AbletonToolServices["loadBrowserItem"]>[0]) =>
        Promise.resolve({
          track: {
            index: params.index,
            reference: params.expectedReference,
            name: params.expectedName,
            kind: "midi" as const,
          },
          item: browserItem,
          before: {
            deviceCount: 1,
            deviceReferences: ["00000000-0000-4000-8000-000000000040"],
            deviceNames: ["Operator"],
            devicesTruncated: false,
            sessionClipCount: 0,
            occupiedSessionSlots: [],
            clipsTruncated: false,
          },
          after: {
            deviceCount: 2,
            deviceReferences: [
              "00000000-0000-4000-8000-000000000040",
              "00000000-0000-4000-8000-000000000051",
            ],
            deviceNames: ["Operator", browserItem.name],
            devicesTruncated: false,
            sessionClipCount: 0,
            occupiedSessionSlots: [],
            clipsTruncated: false,
          },
          addedDevices: [
            {
              reference: "00000000-0000-4000-8000-000000000051",
              trackReference: params.expectedReference,
              trackIndex: params.index,
              index: 1,
              name: browserItem.name,
              className: "Operator",
              classDisplayName: "Operator",
              enabled: true,
              parameterCount: 2,
              canHaveChains: false,
              canHaveDrumPads: false,
            },
          ],
          addedDevicesTruncated: false,
          verified: true as const,
        }),
    ),
    inspectRackChains: vi.fn(
      (params: Parameters<AbletonToolServices["inspectRackChains"]>[0]) =>
        Promise.resolve({
          rack: {
            reference: params.expectedDeviceReference,
            trackReference: params.expectedReference,
            trackIndex: params.index,
            index: params.deviceIndex,
            name: params.expectedDeviceName,
            className: "InstrumentGroupDevice",
            classDisplayName: "Instrument Rack",
            enabled: true,
            parameterCount: 2,
            canHaveChains: true,
            canHaveDrumPads: false,
          },
          chains: [
            {
              reference: "00000000-0000-4000-8000-000000000042",
              rackDeviceReference: params.expectedDeviceReference,
              index: 0,
              name: "Main",
              color: null,
              deviceCount: 1,
            },
          ],
          total: 1,
          offset: params.offset,
          limit: params.limit,
        }),
    ),
    inspectRackChainDevices: vi.fn(
      (params: Parameters<AbletonToolServices["inspectRackChainDevices"]>[0]) =>
        Promise.resolve({
          rack: {
            reference: params.expectedDeviceReference,
            trackReference: params.expectedReference,
            trackIndex: params.index,
            index: params.deviceIndex,
            name: params.expectedDeviceName,
            className: "InstrumentGroupDevice",
            classDisplayName: "Instrument Rack",
            enabled: true,
            parameterCount: 2,
            canHaveChains: true,
            canHaveDrumPads: false,
          },
          chain: {
            reference: params.expectedChainReference,
            rackDeviceReference: params.expectedDeviceReference,
            index: params.chainIndex,
            name: params.expectedChainName,
            color: null,
            deviceCount: 1,
          },
          devices: [
            {
              reference: "00000000-0000-4000-8000-000000000043",
              chainReference: params.expectedChainReference,
              index: 0,
              name: "Operator",
              className: "Operator",
              classDisplayName: "Operator",
              enabled: true,
              parameterCount: 2,
              canHaveChains: false,
              canHaveDrumPads: false,
            },
          ],
          total: 1,
          offset: params.offset,
          limit: params.limit,
        }),
    ),
    inspectDrumRackPads: vi.fn(
      (params: Parameters<AbletonToolServices["inspectDrumRackPads"]>[0]) =>
        Promise.resolve({
          rack: {
            reference: params.expectedDeviceReference,
            trackReference: params.expectedReference,
            trackIndex: params.index,
            index: params.deviceIndex,
            name: params.expectedDeviceName,
            className: "DrumGroupDevice",
            classDisplayName: "Drum Rack",
            enabled: true,
            parameterCount: 2,
            canHaveChains: true,
            canHaveDrumPads: true,
          },
          pads: [
            {
              reference: "00000000-0000-4000-8000-000000000044",
              rackDeviceReference: params.expectedDeviceReference,
              index: 0,
              note: 36,
              name: "Kick",
              mute: false,
              solo: false,
              chainCount: 1,
            },
          ],
          total: 1,
          offset: params.offset,
          limit: params.limit,
        }),
    ),
    inspectDrumPadChains: vi.fn(
      (params: Parameters<AbletonToolServices["inspectDrumPadChains"]>[0]) =>
        Promise.resolve({
          rack: {
            reference: params.expectedDeviceReference,
            trackReference: params.expectedReference,
            trackIndex: params.index,
            index: params.deviceIndex,
            name: params.expectedDeviceName,
            className: "DrumGroupDevice",
            classDisplayName: "Drum Rack",
            enabled: true,
            parameterCount: 2,
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
          chains: [
            {
              reference: "00000000-0000-4000-8000-000000000045",
              rackDeviceReference: params.expectedDeviceReference,
              drumPadReference: params.expectedPadReference,
              drumPadIndex: params.padIndex,
              index: 0,
              name: "Kick",
              color: null,
              deviceCount: 1,
            },
          ],
          total: 1,
          offset: params.offset,
          limit: params.limit,
        }),
    ),
    inspectDrumPadChainDevices: vi.fn(
      (
        params: Parameters<
          AbletonToolServices["inspectDrumPadChainDevices"]
        >[0],
      ) =>
        Promise.resolve({
          rack: {
            reference: params.expectedDeviceReference,
            trackReference: params.expectedReference,
            trackIndex: params.index,
            index: params.deviceIndex,
            name: params.expectedDeviceName,
            className: "DrumGroupDevice",
            classDisplayName: "Drum Rack",
            enabled: true,
            parameterCount: 2,
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
            deviceCount: 1,
          },
          devices: [
            {
              reference: "00000000-0000-4000-8000-000000000046",
              chainReference: params.expectedChainReference,
              index: 0,
              name: "Simpler",
              className: "OriginalSimpler",
              classDisplayName: "Simpler",
              enabled: true,
              parameterCount: 2,
              canHaveChains: false,
              canHaveDrumPads: false,
            },
          ],
          total: 1,
          offset: params.offset,
          limit: params.limit,
        }),
    ),
    setDeviceEnabled: vi.fn(
      (params: Parameters<AbletonToolServices["setDeviceEnabled"]>[0]) =>
        Promise.resolve({
          device: {
            reference: params.expectedDeviceReference,
            trackReference: params.expectedReference,
            trackIndex: params.index,
            index: params.deviceIndex,
            name: params.expectedDeviceName,
            className: "Operator",
            classDisplayName: "Operator",
            enabled: params.enabled,
            parameterCount: 2,
            canHaveChains: false,
            canHaveDrumPads: false,
          },
          beforeEnabled: !params.enabled,
          afterEnabled: params.enabled,
          verified: true as const,
        }),
    ),
    setDeviceParameter: vi.fn(
      (params: Parameters<AbletonToolServices["setDeviceParameter"]>[0]) => {
        const parameter = {
          reference: params.expectedParameterReference,
          deviceReference: params.expectedDeviceReference,
          index: params.parameterIndex,
          name: params.expectedParameterName,
          value: 0.5,
          normalizedValue: 0.5,
          min: 0,
          max: 1,
          isQuantized: false,
          isEnabled: true,
          valueItemCount: 0,
        };
        return Promise.resolve({
          device: {
            reference: params.expectedDeviceReference,
            trackReference: params.expectedReference,
            trackIndex: params.index,
            index: params.deviceIndex,
            name: params.expectedDeviceName,
            className: "Operator",
            classDisplayName: "Operator",
            enabled: true,
            parameterCount: 2,
            canHaveChains: false,
            canHaveDrumPads: false,
          },
          before: parameter,
          after: {
            ...parameter,
            value: params.normalizedValue,
            normalizedValue: params.normalizedValue,
          },
          requestedNormalizedValue: params.normalizedValue,
          verified: true as const,
        });
      },
    ),
  };
}

describe("Ableton tools", () => {
  it("blocks all project tools before transport calls while disconnected", async () => {
    const ports = services();
    ports.getConnectionStatus.mockResolvedValue({ state: "disconnected" });
    const toolSet = createAbletonTools(ports);
    const invocation = {
      sessionId: "session",
      toolCallId: "call",
      toolName: "ableton_session_inspect",
      arguments: {},
    };

    await expect(
      toolSet.tools[1].handler?.({}, invocation),
    ).rejects.toMatchObject({
      code: "not_connected",
      retryable: true,
      name: AbletonToolPreconditionError.name,
    });
    expect(ports.inspectSession).not.toHaveBeenCalled();
  });

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
    ]);
    expect(toolSet.tools.length).toBeLessThanOrEqual(
      toolCatalogPolicy.maximumEagerTools,
    );
    expect(abletonToolMetadata.map((metadata) => metadata.risk)).toEqual([
      "read",
      "read",
      "reversible",
      "reversible",
      "read",
      "reversible",
      "reversible",
      "destructive",
      "reversible",
      "destructive",
      "reversible",
      "reversible",
      "reversible",
      "destructive",
      "reversible",
      "reversible",
      "destructive",
      "reversible",
      "reversible",
      "read",
      "destructive",
      "destructive",
      "reversible",
      "reversible",
      "read",
      "read",
      "read",
      "read",
      "read",
      "read",
      "read",
      "reversible",
      "reversible",
      "read",
      "read",
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
    await toolSet.tools[3].handler?.({ isPlaying: true }, invocation);
    await toolSet.tools[4].handler?.({ offset: 0, limit: 10 }, invocation);
    await toolSet.tools[5].handler?.(
      { enabled: true, start: 8, length: 16 },
      invocation,
    );
    await toolSet.tools[6].handler?.({ time: 32, name: "Chorus" }, invocation);
    await toolSet.tools[7].handler?.(
      {
        expectedReference: "00000000-0000-4000-8000-000000000030",
        expectedName: "Chorus",
        expectedTime: 32,
      },
      invocation,
    );
    await toolSet.tools[8].handler?.(
      { kind: "audio", name: "Vocals" },
      invocation,
    );
    await toolSet.tools[9].handler?.(
      {
        index: 1,
        expectedReference: "00000000-0000-4000-8000-000000000002",
        expectedName: "Bass",
        expectedKind: "midi",
      },
      invocation,
    );
    await toolSet.tools[10].handler?.(
      {
        index: 1,
        expectedReference: "00000000-0000-4000-8000-000000000002",
        expectedName: "Bass",
        name: "Sub Bass",
      },
      invocation,
    );
    await toolSet.tools[11].handler?.(
      {
        index: 1,
        expectedReference: "00000000-0000-4000-8000-000000000002",
        expectedName: "Sub Bass",
        isMuted: true,
        volume: 0.6,
      },
      invocation,
    );
    await toolSet.tools[12].handler?.(
      {
        index: 0,
        expectedReference: "00000000-0000-4000-8000-000000000001",
        expectedName: "Drums",
        sceneIndex: 0,
        length: 4,
        name: "Beat",
      },
      invocation,
    );
    await toolSet.tools[13].handler?.(
      {
        index: 0,
        expectedReference: "00000000-0000-4000-8000-000000000001",
        expectedName: "Drums",
        sceneIndex: 0,
        expectedClipReference: "00000000-0000-4000-8000-000000000010",
        allowPerNoteExpressionLoss: true,
        notes: [
          {
            pitch: 36,
            startTime: 0,
            duration: 0.25,
            velocity: 110,
            mute: false,
          },
        ],
      },
      invocation,
    );
    await toolSet.tools[14].handler?.(
      {
        index: 0,
        expectedReference: "00000000-0000-4000-8000-000000000001",
        expectedName: "Drums",
        sceneIndex: 0,
        expectedClipReference: "00000000-0000-4000-8000-000000000010",
      },
      invocation,
    );
    await toolSet.tools[15].handler?.(
      {
        index: 0,
        expectedReference: "00000000-0000-4000-8000-000000000001",
        expectedName: "Drums",
        sceneIndex: 0,
        expectedClipReference: "00000000-0000-4000-8000-000000000010",
        destinationTrackIndex: 1,
        expectedDestinationTrackReference:
          "00000000-0000-4000-8000-000000000002",
        expectedDestinationTrackName: "Bass",
        destinationSceneIndex: 1,
      },
      invocation,
    );
    await toolSet.tools[16].handler?.(
      {
        index: 0,
        expectedReference: "00000000-0000-4000-8000-000000000001",
        expectedName: "Drums",
        sceneIndex: 0,
        expectedClipReference: "00000000-0000-4000-8000-000000000010",
      },
      invocation,
    );
    await toolSet.tools[17].handler?.(
      {
        index: 0,
        expectedReference: "00000000-0000-4000-8000-000000000001",
        expectedName: "Drums",
        sceneIndex: 0,
        expectedClipReference: "00000000-0000-4000-8000-000000000010",
        name: "Beat Updated",
        muted: true,
      },
      invocation,
    );
    await toolSet.tools[18].handler?.(
      {
        index: 0,
        expectedReference: "00000000-0000-4000-8000-000000000001",
        expectedName: "Drums",
        startTime: 8,
        length: 4,
        name: "Verse",
      },
      invocation,
    );
    await toolSet.tools[19].handler?.({ offset: 0, limit: 10 }, invocation);
    await toolSet.tools[20].handler?.(
      {
        index: 0,
        expectedReference: "00000000-0000-4000-8000-000000000001",
        expectedName: "Drums",
        expectedClipReference: "00000000-0000-4000-8000-000000000020",
        expectedStartTime: 8,
      },
      invocation,
    );
    await toolSet.tools[21].handler?.(
      {
        index: 0,
        expectedReference: "00000000-0000-4000-8000-000000000001",
        expectedName: "Drums",
        expectedClipReference: "00000000-0000-4000-8000-000000000020",
        expectedStartTime: 8,
        allowPerNoteExpressionLoss: false,
        notes: [
          {
            pitch: 60,
            startTime: 0,
            duration: 1,
            velocity: 100,
            mute: false,
          },
        ],
      },
      invocation,
    );
    await toolSet.tools[22].handler?.(
      {
        index: 0,
        expectedReference: "00000000-0000-4000-8000-000000000001",
        expectedName: "Drums",
        sceneIndex: 0,
        expectedClipReference: "00000000-0000-4000-8000-000000000010",
        destinationTime: 16,
      },
      invocation,
    );
    await toolSet.tools[23].handler?.(
      {
        index: 0,
        expectedReference: "00000000-0000-4000-8000-000000000001",
        expectedName: "Drums",
        expectedClipReference: "00000000-0000-4000-8000-000000000021",
        expectedStartTime: 16,
        name: "Chorus",
        muted: true,
        looping: false,
      },
      invocation,
    );
    const deviceTarget = {
      index: 0,
      expectedReference: "00000000-0000-4000-8000-000000000001",
      expectedName: "Drums",
      deviceIndex: 0,
      expectedDeviceReference: "00000000-0000-4000-8000-000000000040",
      expectedDeviceName: "Operator",
    };
    await toolSet.tools[24].handler?.(
      {
        index: 0,
        expectedReference: "00000000-0000-4000-8000-000000000001",
        expectedName: "Drums",
        offset: 0,
        limit: 10,
      },
      invocation,
    );
    await toolSet.tools[25].handler?.(
      { ...deviceTarget, offset: 0, limit: 10 },
      invocation,
    );
    await toolSet.tools[26].handler?.(
      { ...deviceTarget, offset: 0, limit: 10 },
      invocation,
    );
    const chainTarget = {
      ...deviceTarget,
      chainIndex: 0,
      expectedChainReference: "00000000-0000-4000-8000-000000000042",
      expectedChainName: "Main",
    };
    await toolSet.tools[27].handler?.(
      { ...chainTarget, offset: 0, limit: 10 },
      invocation,
    );
    await toolSet.tools[28].handler?.(
      { ...deviceTarget, offset: 0, limit: 10 },
      invocation,
    );
    const padTarget = {
      ...deviceTarget,
      padIndex: 0,
      expectedPadReference: "00000000-0000-4000-8000-000000000044",
      expectedPadNote: 36,
      expectedPadName: "Kick",
    };
    await toolSet.tools[29].handler?.(
      { ...padTarget, offset: 0, limit: 8 },
      invocation,
    );
    await toolSet.tools[30].handler?.(
      {
        ...padTarget,
        chainIndex: 0,
        expectedChainReference: "00000000-0000-4000-8000-000000000045",
        expectedChainName: "Kick",
        offset: 0,
        limit: 10,
      },
      invocation,
    );
    await toolSet.tools[31].handler?.(
      { ...deviceTarget, enabled: false },
      invocation,
    );
    await toolSet.tools[32].handler?.(
      {
        ...deviceTarget,
        parameterIndex: 1,
        expectedParameterReference: "00000000-0000-4000-8000-000000000041",
        expectedParameterName: "Filter Freq",
        normalizedValue: 0.75,
      },
      invocation,
    );
    const browserTarget = {
      expectedItemReference: "00000000-0000-4000-8000-000000000050",
      expectedItemRoot: "instruments" as const,
      expectedItemPath: [
        { index: 0, name: "Synths" },
        { index: 0, name: "Operator" },
      ],
      expectedItemName: "Operator",
      expectedItemUri: "ableton://instruments/operator",
    };
    await toolSet.tools[33].handler?.({}, invocation);
    await toolSet.tools[34].handler?.(
      { ...browserTarget, offset: 0, limit: 10 },
      invocation,
    );
    await toolSet.tools[35].handler?.(
      {
        query: "operator",
        roots: ["instruments"],
        maxNodes: 32,
        maxResults: 5,
        maxDepth: 3,
        maxDurationMs: 100,
      },
      invocation,
    );
    await toolSet.tools[36].handler?.(
      {
        query: "serum",
        maxNodes: 64,
        maxResults: 10,
        maxDepth: 4,
        maxDurationMs: 100,
      },
      invocation,
    );
    await toolSet.tools[37].handler?.(
      {
        index: 0,
        expectedReference: "00000000-0000-4000-8000-000000000001",
        expectedName: "Drums",
        ...browserTarget,
      },
      invocation,
    );

    expect(ports.getConnectionStatus).toHaveBeenCalledTimes(
      toolSet.tools.length,
    );
    expect(ports.inspectSession).toHaveBeenCalledOnce();
    expect(ports.setTempo).toHaveBeenCalledWith(132);
    expect(ports.setPlaying).toHaveBeenCalledWith(true);
    expect(ports.inspectArrangementTransport).toHaveBeenCalledWith({
      offset: 0,
      limit: 10,
    });
    expect(ports.setArrangementLoop).toHaveBeenCalledWith({
      enabled: true,
      start: 8,
      length: 16,
    });
    expect(ports.createCuePoint).toHaveBeenCalledWith({
      time: 32,
      name: "Chorus",
    });
    expect(ports.deleteCuePoint).toHaveBeenCalledWith({
      expectedReference: "00000000-0000-4000-8000-000000000030",
      expectedName: "Chorus",
      expectedTime: 32,
    });
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
    expect(ports.createMidiClip).toHaveBeenCalledWith({
      index: 0,
      expectedReference: "00000000-0000-4000-8000-000000000001",
      expectedName: "Drums",
      sceneIndex: 0,
      length: 4,
      name: "Beat",
    });
    expect(ports.replaceMidiNotes).toHaveBeenCalledWith({
      index: 0,
      expectedReference: "00000000-0000-4000-8000-000000000001",
      expectedName: "Drums",
      sceneIndex: 0,
      expectedClipReference: "00000000-0000-4000-8000-000000000010",
      allowPerNoteExpressionLoss: true,
      notes: [
        {
          pitch: 36,
          startTime: 0,
          duration: 0.25,
          velocity: 110,
          mute: false,
        },
      ],
    });
    expect(ports.launchSessionClip).toHaveBeenCalledWith({
      index: 0,
      expectedReference: "00000000-0000-4000-8000-000000000001",
      expectedName: "Drums",
      sceneIndex: 0,
      expectedClipReference: "00000000-0000-4000-8000-000000000010",
    });
    expect(ports.duplicateSessionClip).toHaveBeenCalledWith({
      index: 0,
      expectedReference: "00000000-0000-4000-8000-000000000001",
      expectedName: "Drums",
      sceneIndex: 0,
      expectedClipReference: "00000000-0000-4000-8000-000000000010",
      destinationTrackIndex: 1,
      expectedDestinationTrackReference: "00000000-0000-4000-8000-000000000002",
      expectedDestinationTrackName: "Bass",
      destinationSceneIndex: 1,
    });
    expect(ports.deleteSessionClip).toHaveBeenCalledWith({
      index: 0,
      expectedReference: "00000000-0000-4000-8000-000000000001",
      expectedName: "Drums",
      sceneIndex: 0,
      expectedClipReference: "00000000-0000-4000-8000-000000000010",
    });
    expect(ports.setSessionClipProperties).toHaveBeenCalledWith({
      index: 0,
      expectedReference: "00000000-0000-4000-8000-000000000001",
      expectedName: "Drums",
      sceneIndex: 0,
      expectedClipReference: "00000000-0000-4000-8000-000000000010",
      name: "Beat Updated",
      muted: true,
    });
    expect(ports.createArrangementMidiClip).toHaveBeenCalledWith({
      index: 0,
      expectedReference: "00000000-0000-4000-8000-000000000001",
      expectedName: "Drums",
      startTime: 8,
      length: 4,
      name: "Verse",
    });
    expect(ports.inspectArrangement).toHaveBeenCalledWith({
      offset: 0,
      limit: 10,
    });
    expect(ports.deleteArrangementClip).toHaveBeenCalledWith({
      index: 0,
      expectedReference: "00000000-0000-4000-8000-000000000001",
      expectedName: "Drums",
      expectedClipReference: "00000000-0000-4000-8000-000000000020",
      expectedStartTime: 8,
    });
    expect(ports.replaceArrangementMidiNotes).toHaveBeenCalledWith({
      index: 0,
      expectedReference: "00000000-0000-4000-8000-000000000001",
      expectedName: "Drums",
      expectedClipReference: "00000000-0000-4000-8000-000000000020",
      expectedStartTime: 8,
      allowPerNoteExpressionLoss: false,
      notes: [
        {
          pitch: 60,
          startTime: 0,
          duration: 1,
          velocity: 100,
          mute: false,
        },
      ],
    });
    expect(ports.duplicateClipToArrangement).toHaveBeenCalledWith({
      index: 0,
      expectedReference: "00000000-0000-4000-8000-000000000001",
      expectedName: "Drums",
      sceneIndex: 0,
      expectedClipReference: "00000000-0000-4000-8000-000000000010",
      destinationTime: 16,
    });
    expect(ports.setArrangementClipProperties).toHaveBeenCalledWith({
      index: 0,
      expectedReference: "00000000-0000-4000-8000-000000000001",
      expectedName: "Drums",
      expectedClipReference: "00000000-0000-4000-8000-000000000021",
      expectedStartTime: 16,
      name: "Chorus",
      muted: true,
      looping: false,
    });
    expect(ports.inspectDevices).toHaveBeenCalledWith({
      index: 0,
      expectedReference: "00000000-0000-4000-8000-000000000001",
      expectedName: "Drums",
      offset: 0,
      limit: 10,
    });
    expect(ports.inspectRackChains).toHaveBeenCalledWith({
      ...deviceTarget,
      offset: 0,
      limit: 10,
    });
    expect(ports.inspectRackChainDevices).toHaveBeenCalledWith({
      ...chainTarget,
      offset: 0,
      limit: 10,
    });
    expect(ports.inspectDrumRackPads).toHaveBeenCalledWith({
      ...deviceTarget,
      offset: 0,
      limit: 10,
    });
    expect(ports.inspectDrumPadChains).toHaveBeenCalledWith({
      ...padTarget,
      offset: 0,
      limit: 8,
    });
    expect(ports.inspectDrumPadChainDevices).toHaveBeenCalledWith({
      ...padTarget,
      chainIndex: 0,
      expectedChainReference: "00000000-0000-4000-8000-000000000045",
      expectedChainName: "Kick",
      offset: 0,
      limit: 10,
    });
    expect(ports.inspectDeviceParameters).toHaveBeenCalledWith({
      ...deviceTarget,
      offset: 0,
      limit: 10,
    });
    expect(ports.setDeviceEnabled).toHaveBeenCalledWith({
      ...deviceTarget,
      enabled: false,
    });
    expect(ports.setDeviceParameter).toHaveBeenCalledWith({
      ...deviceTarget,
      parameterIndex: 1,
      expectedParameterReference: "00000000-0000-4000-8000-000000000041",
      expectedParameterName: "Filter Freq",
      normalizedValue: 0.75,
    });
    expect(ports.inspectBrowserRoots).toHaveBeenCalledOnce();
    expect(ports.inspectBrowserChildren).toHaveBeenCalledWith({
      ...browserTarget,
      offset: 0,
      limit: 10,
    });
    expect(ports.searchBrowser).toHaveBeenCalledWith({
      query: "operator",
      roots: ["instruments"],
      maxNodes: 32,
      maxResults: 5,
      maxDepth: 3,
      maxDurationMs: 100,
    });
    expect(ports.searchBrowser).toHaveBeenCalledWith({
      query: "serum",
      roots: ["plugins"],
      maxNodes: 64,
      maxResults: 10,
      maxDepth: 4,
      maxDurationMs: 100,
    });
    expect(ports.loadBrowserItem).toHaveBeenCalledWith({
      index: 0,
      expectedReference: "00000000-0000-4000-8000-000000000001",
      expectedName: "Drums",
      ...browserTarget,
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
          toolName: "ableton_transport_inspect_arrangement",
          toolDescription: "Inspect Arrangement transport",
          args: { offset: 0, limit: 100 },
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

  it("rejects targetless destructive approvals before prompting", async () => {
    const requestApproval = vi.fn(() => Promise.resolve(true));
    const permission = createAbletonPermissionHandler(requestApproval);
    const result = await permission(
      {
        kind: "custom-tool",
        toolName: "ableton_tracks_delete",
        toolDescription: "Delete a track",
        args: {},
      },
      { sessionId: "session", managedSettingsEnabled: false },
    );

    expect(result).toEqual({
      kind: "reject",
      feedback:
        "Destructive and broad operations require explicit target arguments",
    });
    expect(requestApproval).not.toHaveBeenCalled();
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

  it("can require approval for read-only tools", async () => {
    const requests: ToolApprovalRequest[] = [];
    const requestApproval = (
      request: ToolApprovalRequest,
    ): Promise<boolean> => {
      requests.push(request);
      return Promise.resolve(true);
    };
    const handler = createAbletonPermissionHandler(requestApproval, true);

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
    expect(requests[0]?.metadata.risk).toBe("read");
  });
});
