import { describe, expect, it, vi } from "vitest";

import {
  abletonToolMetadata,
  createAbletonPermissionHandler,
  createAbletonTools,
  type AbletonToolServices,
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
    ]);
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

    expect(ports.getConnectionStatus).toHaveBeenCalledOnce();
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
