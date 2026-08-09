import { describe, expect, it, vi } from "vitest";

import {
  HeadlessApplication,
  type AbletonService,
  type AgentService,
} from "@ableton-agent/application";
import {
  InMemoryEventPublisher,
  noopLogger,
  type ConnectionStatus,
} from "@ableton-agent/shared";

import {
  CliUsageError,
  parseArgs,
  renderEvent,
  runCommand,
  runInteractive,
  type CliIo,
  type InteractiveInput,
} from "./cli.js";

function application(
  status: ConnectionStatus,
  reply = "ok",
  stream = false,
  operationFailure = false,
) {
  const events = new InMemoryEventPublisher();
  const agentStart = vi.fn(async () => undefined);
  const agent: AgentService = {
    start: agentStart,
    stop: vi.fn(async () => undefined),
    send: vi.fn(async () => {
      if (stream) {
        events.publish({ type: "agent.message_delta", content: "assistant " });
        events.publish({ type: "agent.message_delta", content: "reply" });
        events.publish({ type: "agent.message_complete", content: reply });
      }
      if (operationFailure) {
        events.publish({
          type: "operation.failed",
          operationId: "tool-1",
          code: "permission_denied",
          message: "User denied the mutation",
        });
      }
      return reply;
    }),
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
      capabilities: { "system.ping": true, "session.inspect": true },
      limits: { maxFrameBytes: 1024, maxBatchItems: 128 },
    })),
    ping: vi.fn(async () => ({ pong: true as const })),
    inspectSession: vi.fn(async () => ({
      tempo: 128,
      timeSignature: { numerator: 4, denominator: 4 },
      isPlaying: false,
      trackCount: 1,
      tracks: [
        {
          index: 0,
          reference: "00000000-0000-4000-8000-000000000001",
          name: "Drums",
          kind: "midi" as const,
          color: 10,
          isMuted: false,
          isSoloed: false,
          isArmed: false,
          volume: 0.8,
          pan: 0,
        },
      ],
    })),
    setTempo: vi.fn(async (tempo: number) => ({
      beforeTempo: 128,
      afterTempo: tempo,
      verified: true,
    })),
    setPlaying: vi.fn(async (isPlaying: boolean) => ({
      beforeIsPlaying: !isPlaying,
      afterIsPlaying: isPlaying,
      verified: true,
    })),
    inspectArrangementTransport: vi.fn(
      async (
        params: Parameters<AbletonService["inspectArrangementTransport"]>[0],
      ) => ({
        loop: { enabled: true, start: 8, length: 16 },
        cuePoints: [
          {
            reference: "00000000-0000-4000-8000-000000000030",
            name: "Chorus",
            time: 32,
          },
        ],
        totalCuePoints: 1,
        offset: params.offset,
        limit: params.limit,
      }),
    ),
    setArrangementLoop: vi.fn(async () => {
      throw new Error("not used");
    }),
    createCuePoint: vi.fn(async () => {
      throw new Error("not used");
    }),
    deleteCuePoint: vi.fn(async () => {
      throw new Error("not used");
    }),
    createTrack: vi.fn(
      async (params: Parameters<AbletonService["createTrack"]>[0]) => ({
        beforeTrackCount: 1,
        afterTrackCount: 2,
        track: {
          index: 1,
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
    inspectDevices: vi.fn(
      async (params: Parameters<AbletonService["inspectDevices"]>[0]) => ({
        devices: [
          {
            reference: "00000000-0000-4000-8000-000000000040",
            trackReference: params.expectedReference,
            trackIndex: params.index,
            index: 0,
            name: "Drum Rack",
            className: "InstrumentGroupDevice",
            classDisplayName: "Instrument Rack",
            enabled: true,
            parameterCount: 2,
            canHaveChains: true,
            canHaveDrumPads: true,
          },
        ].slice(params.offset, params.offset + params.limit),
        total: 1,
        offset: params.offset,
        limit: params.limit,
      }),
    ),
    inspectDeviceParameters: vi.fn(
      async (
        params: Parameters<AbletonService["inspectDeviceParameters"]>[0],
      ) => ({
        device: {
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
          canHaveDrumPads: true,
        },
        parameters: [
          {
            reference: "00000000-0000-4000-8000-000000000041",
            deviceReference: params.expectedDeviceReference,
            index: 1,
            name: "Dry/Wet",
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
    inspectRackChains: vi.fn(
      async (params: Parameters<AbletonService["inspectRackChains"]>[0]) => ({
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
          canHaveDrumPads: true,
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
        ].slice(params.offset, params.offset + params.limit),
        total: 1,
        offset: params.offset,
        limit: params.limit,
      }),
    ),
    inspectRackChainDevices: vi.fn(
      async (
        params: Parameters<AbletonService["inspectRackChainDevices"]>[0],
      ) => ({
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
          canHaveDrumPads: true,
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
        ].slice(params.offset, params.offset + params.limit),
        total: 1,
        offset: params.offset,
        limit: params.limit,
      }),
    ),
    inspectDrumRackPads: vi.fn(
      async (params: Parameters<AbletonService["inspectDrumRackPads"]>[0]) => ({
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
        ].slice(params.offset, params.offset + params.limit),
        total: 1,
        offset: params.offset,
        limit: params.limit,
      }),
    ),
    inspectDrumPadChains: vi.fn(
      async (
        params: Parameters<AbletonService["inspectDrumPadChains"]>[0],
      ) => ({
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
        ].slice(params.offset, params.offset + params.limit),
        total: 1,
        offset: params.offset,
        limit: params.limit,
      }),
    ),
    inspectDrumPadChainDevices: vi.fn(
      async (
        params: Parameters<AbletonService["inspectDrumPadChainDevices"]>[0],
      ) => ({
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
        ].slice(params.offset, params.offset + params.limit),
        total: 1,
        offset: params.offset,
        limit: params.limit,
      }),
    ),
    setDeviceEnabled: vi.fn(async () => {
      throw new Error("not used");
    }),
    setDeviceParameter: vi.fn(async () => {
      throw new Error("not used");
    }),
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
    launchSessionClip: vi.fn(async () => {
      throw new Error("not used");
    }),
    duplicateSessionClip: vi.fn(async () => {
      throw new Error("not used");
    }),
    deleteSessionClip: vi.fn(async () => {
      throw new Error("not used");
    }),
    setSessionClipProperties: vi.fn(async () => {
      throw new Error("not used");
    }),
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
  return {
    application: new HeadlessApplication({
      agent,
      ableton,
      events,
      logger: noopLogger,
    }),
    agentStart,
    events,
  };
}

function output() {
  const lines: string[] = [];
  const errors: string[] = [];
  const raw: string[] = [];
  const io: CliIo = {
    write: (text) => lines.push(text),
    writeRaw: (text) => raw.push(text),
    writeError: (text) => errors.push(text),
  };
  return { lines, errors, raw, io };
}

function interactiveInput(lines: readonly string[]): InteractiveInput {
  const queued = [...lines];
  return {
    readLine: () => Promise.resolve(queued.shift()),
  };
}

describe("CLI", () => {
  it("parses a one-shot prompt", () => {
    expect(parseArgs(["run", "inspect", "the", "set", "--json"])).toEqual({
      name: "run",
      prompt: "inspect the set",
      json: true,
    });
  });

  it("parses interactive chat", () => {
    expect(parseArgs(["chat"])).toEqual({ name: "chat", json: false });
  });

  it("parses one-based device inspection commands", () => {
    expect(parseArgs(["devices", "2", "--json"])).toEqual({
      name: "devices",
      trackNumber: 2,
      json: true,
    });
    expect(parseArgs(["parameters", "1", "3"])).toEqual({
      name: "parameters",
      trackNumber: 1,
      deviceNumber: 3,
      json: false,
    });
    expect(() => parseArgs(["devices", "0"])).toThrow(CliUsageError);
    expect(
      parseArgs([
        "pad-chain-devices",
        "1",
        "2",
        "3",
        "4",
        "--offset",
        "5",
        "--limit",
        "10",
        "--json",
      ]),
    ).toEqual({
      name: "pad-chain-devices",
      trackNumber: 1,
      deviceNumber: 2,
      padNumber: 3,
      chainNumber: 4,
      offset: 5,
      limit: 10,
      json: true,
    });
    expect(() => parseArgs(["rack-chains", "1", "1", "--limit", "65"])).toThrow(
      CliUsageError,
    );
  });

  it("renders bounded Arrangement transport inspection", async () => {
    const out = output();
    const exitCode = await runCommand(
      { name: "transport", json: false },
      application({
        state: "connected",
        liveVersion: "12.1",
        remoteScriptVersion: "0.2.0",
        projectId: "project",
      }).application,
      out.io,
    );

    expect(exitCode).toBe(0);
    expect(out.lines[0]).toContain("Arrangement loop: enabled");
    expect(out.lines[0]).toContain("32: Chorus");
  });

  it("renders bounded regular-track devices and parameters", async () => {
    const deviceOutput = output();
    const fixture = application({
      state: "connected",
      liveVersion: "12.1",
      remoteScriptVersion: "0.2.0",
      projectId: "project",
    });
    await expect(
      runCommand(
        { name: "devices", trackNumber: 1, json: false },
        fixture.application,
        deviceOutput.io,
      ),
    ).resolves.toBe(0);
    expect(deviceOutput.lines[0]).toContain("1. Drum Rack");

    const parameterOutput = output();
    await expect(
      runCommand(
        {
          name: "parameters",
          trackNumber: 1,
          deviceNumber: 1,
          json: false,
        },
        fixture.application,
        parameterOutput.io,
      ),
    ).resolves.toBe(0);
    expect(parameterOutput.lines[0]).toContain("Dry/Wet: 0.500");
  });

  it("renders bounded rack and Drum Rack inspection", async () => {
    const fixture = application({
      state: "connected",
      liveVersion: "12.1",
      remoteScriptVersion: "0.2.0",
      projectId: "project",
    });
    const commands = [
      {
        command: {
          name: "rack-chains" as const,
          trackNumber: 1,
          deviceNumber: 1,
          offset: 0,
          limit: 16,
          json: false,
        },
        expected: "Main",
      },
      {
        command: {
          name: "chain-devices" as const,
          trackNumber: 1,
          deviceNumber: 1,
          chainNumber: 1,
          offset: 0,
          limit: 32,
          json: false,
        },
        expected: "Operator",
      },
      {
        command: {
          name: "drum-pads" as const,
          trackNumber: 1,
          deviceNumber: 1,
          offset: 0,
          limit: 32,
          json: false,
        },
        expected: "Kick",
      },
      {
        command: {
          name: "pad-chains" as const,
          trackNumber: 1,
          deviceNumber: 1,
          padNumber: 1,
          offset: 0,
          limit: 8,
          json: false,
        },
        expected: "Kick",
      },
      {
        command: {
          name: "pad-chain-devices" as const,
          trackNumber: 1,
          deviceNumber: 1,
          padNumber: 1,
          chainNumber: 1,
          offset: 0,
          limit: 32,
          json: false,
        },
        expected: "Simpler",
      },
    ];
    for (const { command, expected } of commands) {
      const out = output();
      await expect(
        runCommand(command, fixture.application, out.io),
      ).resolves.toBe(0);
      expect(out.lines[0]).toContain(expected);
    }
  });

  it("rejects missing prompts", () => {
    expect(() => parseArgs(["run"])).toThrow(CliUsageError);
  });

  it("returns connection failure for disconnected status", async () => {
    const out = output();
    const exitCode = await runCommand(
      { name: "status", json: true },
      application({ state: "disconnected" }).application,
      out.io,
    );
    expect(exitCode).toBe(3);
    expect(JSON.parse(out.lines[0] ?? "{}")).toMatchObject({
      healthy: false,
      ableton: { state: "disconnected" },
    });
  });

  it("runs a prompt through the headless application", async () => {
    const out = output();
    const exitCode = await runCommand(
      { name: "run", prompt: "hello", json: false },
      application(
        {
          state: "connected",
          liveVersion: "12.1",
          remoteScriptVersion: "0.1.0",
          projectId: "project",
        },
        "response",
      ).application,
      out.io,
    );
    expect(exitCode).toBe(0);
    expect(out.lines).toEqual(["response"]);
  });

  it("returns a failure exit code when a tool operation is denied", async () => {
    const out = output();
    const exitCode = await runCommand(
      { name: "run", prompt: "change tempo", json: true },
      application(
        {
          state: "connected",
          liveVersion: "12.1",
          remoteScriptVersion: "0.2.0",
          projectId: "project",
        },
        "I did not change it.",
        false,
        true,
      ).application,
      out.io,
    );

    expect(exitCode).toBe(4);
    expect(JSON.parse(out.lines[0] ?? "{}")).toMatchObject({
      ok: false,
      operationFailures: [{ code: "permission_denied" }],
    });
  });

  it("does not start Copilot for status checks", async () => {
    const out = output();
    const fixture = application({ state: "disconnected" });

    await runCommand(
      { name: "status", json: false },
      fixture.application,
      out.io,
    );

    expect(fixture.agentStart).not.toHaveBeenCalled();
  });

  it("runs bridge diagnostics without starting Copilot", async () => {
    const out = output();
    const fixture = application({
      state: "connected",
      liveVersion: "12.1",
      remoteScriptVersion: "0.2.0",
      projectId: "project",
    });

    const exitCode = await runCommand(
      { name: "doctor", json: true },
      fixture.application,
      out.io,
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(out.lines[0] ?? "{}")).toMatchObject({
      healthy: true,
      ping: { pong: true },
    });
    expect(fixture.agentStart).not.toHaveBeenCalled();
  });

  it("renders a session snapshot", async () => {
    const out = output();
    const fixture = application({
      state: "connected",
      liveVersion: "12.1",
      remoteScriptVersion: "0.2.0",
      projectId: "project",
    });

    const exitCode = await runCommand(
      { name: "snapshot", json: false },
      fixture.application,
      out.io,
    );

    expect(exitCode).toBe(0);
    expect(out.lines[0]).toContain("Tempo: 128");
    expect(out.lines[0]).toContain("1. Drums");
  });

  it("renders operation events consistently", () => {
    expect(
      renderEvent({
        type: "operation.completed",
        operationId: "1",
        summary: "Inspected 4 tracks",
      }),
    ).toBe("✓ Inspected 4 tracks");
  });

  it("runs a persistent chat with slash commands and prompts", async () => {
    const out = output();
    const fixture = application(
      {
        state: "connected",
        liveVersion: "12.1",
        remoteScriptVersion: "0.2.0",
        projectId: "project",
      },
      "assistant reply",
    );

    const exitCode = await runInteractive(
      fixture.application,
      out.io,
      interactiveInput(["/status", "/snapshot", "hello", "/exit"]),
    );

    expect(exitCode).toBe(0);
    expect(out.lines).toContain("Ableton: connected");
    expect(out.lines).toContain("Snapshot: 1 tracks at 128 BPM");
    expect(out.lines).toContain("assistant reply");
    expect(out.raw.filter((text) => text === "> ")).toHaveLength(4);
    expect(fixture.agentStart).toHaveBeenCalledOnce();
  });

  it("reports unknown slash commands without ending the chat", async () => {
    const out = output();
    const fixture = application({ state: "disconnected" });

    await runInteractive(
      fixture.application,
      out.io,
      interactiveInput(["/unknown", "/exit"]),
    );

    expect(out.errors).toEqual(["Unknown command: /unknown"]);
  });

  it("streams assistant deltas without duplicating the final message", async () => {
    const out = output();
    const fixture = application(
      {
        state: "connected",
        liveVersion: "12.1",
        remoteScriptVersion: "0.2.0",
        projectId: "project",
      },
      "assistant reply",
      true,
    );

    await runInteractive(
      fixture.application,
      out.io,
      interactiveInput(["hello", "/exit"]),
    );

    expect(out.raw).toContain("assistant ");
    expect(out.raw).toContain("reply");
    expect(out.lines).not.toContain("assistant reply");
  });
});
