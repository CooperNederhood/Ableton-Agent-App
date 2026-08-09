import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

import { afterEach, describe, expect, it } from "vitest";

import { InMemoryEventPublisher } from "@ableton-agent/shared";

import { AbletonBridgeService } from "./index.js";

const token = "test-token-that-is-at-least-thirty-two-characters";
let simulator: ChildProcessWithoutNullStreams | undefined;

async function startSimulator(expectedToken = token): Promise<number> {
  simulator = spawn(
    "python3",
    ["remote-script/simulator.py", "--token", expectedToken],
    {
      cwd: new URL("../../..", import.meta.url),
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const lines = createInterface({ input: simulator.stdout });
  const line = await new Promise<string>((resolve, reject) => {
    lines.once("line", resolve);
    simulator?.once("error", reject);
    simulator?.once("exit", (code) => {
      reject(new Error(`Simulator exited before startup with code ${code}`));
    });
  });
  lines.close();
  return (JSON.parse(line) as { port: number }).port;
}

afterEach(() => {
  simulator?.kill();
  simulator = undefined;
});

describe("AbletonBridgeService", () => {
  it("negotiates capabilities and sends ping across the Python protocol", async () => {
    const port = await startSimulator();
    const service = new AbletonBridgeService({
      authenticationToken: token,
      events: new InMemoryEventPublisher(),
      port,
    });

    await service.start();

    expect(await service.getStatus()).toEqual({
      state: "connected",
      liveVersion: "12.1-simulator",
      remoteScriptVersion: "0.4.0",
      projectId: "simulated-project",
    });
    await expect(service.getCapabilities()).resolves.toMatchObject({
      selectedProtocolVersion: 2,
      capabilities: {
        "system.ping": true,
        "transport.set_tempo": true,
        "transport.set_playing": true,
        "transport.inspect_arrangement": true,
        "transport.set_arrangement_loop": true,
        "transport.create_cue_point": true,
        "transport.delete_cue_point": true,
        "tracks.create": true,
        "tracks.delete": true,
        "tracks.rename": true,
        "tracks.set_mixer": true,
        "devices.inspect": true,
        "devices.inspect_parameters": true,
        "devices.inspect_rack_chains": true,
        "devices.inspect_rack_chain_devices": true,
        "devices.inspect_drum_rack_pads": true,
        "devices.inspect_drum_pad_chains": true,
        "devices.inspect_drum_pad_chain_devices": true,
        "devices.set_enabled": true,
        "devices.set_parameter": true,
        "browser.inspect_roots": true,
        "browser.inspect_children": true,
        "browser.search": true,
        "browser.load_item": true,
        "clips.create_midi": true,
        "clips.replace_notes": true,
        "clips.launch": true,
        "clips.duplicate": true,
        "clips.delete": true,
        "clips.set_properties": true,
        "arrangement.create_midi_clip": true,
        "arrangement.duplicate_clip": true,
        "arrangement.set_clip_properties": true,
      },
    });
    await expect(service.ping()).resolves.toEqual({ pong: true });
    await expect(service.inspectSession()).resolves.toMatchObject({
      tempo: 120,
      trackCount: 2,
      tracks: [{ name: "Drums" }, { name: "Bass" }],
    });
    await expect(service.setTempo(132)).resolves.toEqual({
      beforeTempo: 120,
      afterTempo: 132,
      verified: true,
    });
    await expect(service.setPlaying(true)).resolves.toEqual({
      beforeIsPlaying: false,
      afterIsPlaying: true,
      verified: true,
    });
    const initialTransport = await service.inspectArrangementTransport({
      offset: 1,
      limit: 1,
    });
    expect(initialTransport).toMatchObject({
      loop: { enabled: false, start: 0, length: 16 },
      totalCuePoints: 2,
      cuePoints: [{ name: "Verse", time: 16 }],
    });
    await expect(
      service.setArrangementLoop({
        enabled: true,
        start: 8,
        length: 16,
      }),
    ).resolves.toEqual({
      before: { enabled: false, start: 0, length: 16 },
      after: { enabled: true, start: 8, length: 16 },
      verified: true,
    });
    await expect(service.setPlaying(false)).resolves.toEqual({
      beforeIsPlaying: true,
      afterIsPlaying: false,
      verified: true,
    });
    const createdCuePoint = await service.createCuePoint({
      time: 32,
      name: "Chorus",
    });
    expect(createdCuePoint).toMatchObject({
      cuePoint: { name: "Chorus", time: 32 },
      beforeCuePointCount: 2,
      afterCuePointCount: 3,
      verified: true,
    });
    const transportAfterCreate = await service.inspectArrangementTransport({
      offset: 2,
      limit: 1,
    });
    expect(transportAfterCreate).toMatchObject({
      loop: { enabled: true, start: 8, length: 16 },
      cuePoints: [
        {
          reference: createdCuePoint.cuePoint.reference,
          name: "Chorus",
          time: 32,
        },
      ],
      totalCuePoints: 3,
    });
    await expect(
      service.deleteCuePoint({
        expectedReference: createdCuePoint.cuePoint.reference,
        expectedName: "Wrong",
        expectedTime: 32,
      }),
    ).rejects.toMatchObject({ code: "stale_reference" });
    await expect(
      service.deleteCuePoint({
        expectedReference: createdCuePoint.cuePoint.reference,
        expectedName: "Chorus",
        expectedTime: 32,
      }),
    ).resolves.toMatchObject({
      beforeCuePointCount: 3,
      afterCuePointCount: 2,
      verified: true,
    });
    await expect(
      service.createTrack({ kind: "audio", name: "Vocals" }),
    ).resolves.toMatchObject({
      beforeTrackCount: 2,
      afterTrackCount: 3,
      track: { index: 2, name: "Vocals", kind: "audio" },
      verified: true,
    });
    const snapshot = await service.inspectSession();
    const bass = snapshot.tracks.find((track) => track.name === "Bass");
    expect(bass).toBeDefined();
    await expect(
      service.deleteTrack({
        index: 1,
        expectedReference: bass?.reference ?? "",
        expectedName: "Bass",
        expectedKind: "midi",
      }),
    ).resolves.toEqual({
      beforeTrackCount: 3,
      afterTrackCount: 2,
      track: {
        index: 1,
        reference: bass?.reference,
        name: "Bass",
        kind: "midi",
      },
      verified: true,
    });
    const afterDelete = await service.inspectSession();
    const drums = afterDelete.tracks.find((track) => track.name === "Drums");
    expect(drums).toBeDefined();
    await expect(
      service.renameTrack({
        index: 0,
        expectedReference: drums?.reference ?? "",
        expectedName: "Drums",
        name: "Main Drums",
      }),
    ).resolves.toEqual({
      reference: drums?.reference,
      index: 0,
      beforeName: "Drums",
      afterName: "Main Drums",
      verified: true,
    });
    await expect(
      service.setTrackMixer({
        index: 0,
        expectedReference: drums?.reference ?? "",
        expectedName: "Main Drums",
        isMuted: true,
        volume: 0.65,
        pan: 0.2,
      }),
    ).resolves.toMatchObject({
      reference: drums?.reference,
      index: 0,
      before: { isMuted: false, volume: 0.85, pan: 0 },
      after: { isMuted: true, volume: 0.65, pan: 0.2 },
      verified: true,
    });
    const devices = await service.inspectDevices({
      index: 0,
      expectedReference: drums?.reference ?? "",
      expectedName: "Main Drums",
      offset: 0,
      limit: 1,
    });
    expect(devices).toMatchObject({
      total: 1,
      devices: [
        {
          name: "Drum Rack",
          enabled: true,
          parameterCount: 3,
        },
      ],
    });
    const device = devices.devices[0];
    expect(device).toBeDefined();
    const parameters = await service.inspectDeviceParameters({
      index: 0,
      expectedReference: drums?.reference ?? "",
      expectedName: "Main Drums",
      deviceIndex: device?.index ?? 0,
      expectedDeviceReference: device?.reference ?? "",
      expectedDeviceName: device?.name ?? "",
      offset: 1,
      limit: 2,
    });
    expect(parameters).toMatchObject({
      total: 3,
      parameters: [
        { name: "Dry/Wet", normalizedValue: 0.5 },
        { name: "Mode", isQuantized: true },
      ],
    });
    const rackTarget = {
      index: 0,
      expectedReference: drums?.reference ?? "",
      expectedName: "Main Drums",
      deviceIndex: device?.index ?? 0,
      expectedDeviceReference: device?.reference ?? "",
      expectedDeviceName: device?.name ?? "",
    };
    const chains = await service.inspectRackChains({
      ...rackTarget,
      offset: 0,
      limit: 1,
    });
    expect(chains).toMatchObject({
      total: 2,
      chains: [{ name: "Kick", deviceCount: 1 }],
    });
    const chain = chains.chains[0];
    await expect(
      service.inspectRackChainDevices({
        ...rackTarget,
        chainIndex: chain?.index ?? 0,
        expectedChainReference: chain?.reference ?? "",
        expectedChainName: chain?.name ?? "",
        offset: 0,
        limit: 1,
      }),
    ).resolves.toMatchObject({
      total: 1,
      devices: [{ name: "Simpler" }],
    });
    const pads = await service.inspectDrumRackPads({
      ...rackTarget,
      offset: 36,
      limit: 1,
    });
    expect(pads).toMatchObject({
      total: 128,
      pads: [{ note: 36, name: "Kick", chainCount: 1 }],
    });
    const pad = pads.pads[0];
    const padChains = await service.inspectDrumPadChains({
      ...rackTarget,
      padIndex: pad?.index ?? 0,
      expectedPadReference: pad?.reference ?? "",
      expectedPadNote: pad?.note ?? 0,
      expectedPadName: pad?.name ?? "",
      offset: 0,
      limit: 1,
    });
    const padChain = padChains.chains[0];
    await expect(
      service.inspectDrumPadChainDevices({
        ...rackTarget,
        padIndex: pad?.index ?? 0,
        expectedPadReference: pad?.reference ?? "",
        expectedPadNote: pad?.note ?? 0,
        expectedPadName: pad?.name ?? "",
        chainIndex: padChain?.index ?? 0,
        expectedChainReference: padChain?.reference ?? "",
        expectedChainName: padChain?.name ?? "",
        offset: 0,
        limit: 1,
      }),
    ).resolves.toMatchObject({
      total: 1,
      devices: [{ name: "Simpler" }],
    });
    const mode = parameters.parameters[1];
    await expect(
      service.setDeviceParameter({
        index: 0,
        expectedReference: drums?.reference ?? "",
        expectedName: "Main Drums",
        deviceIndex: device?.index ?? 0,
        expectedDeviceReference: device?.reference ?? "",
        expectedDeviceName: device?.name ?? "",
        parameterIndex: mode?.index ?? 0,
        expectedParameterReference: "00000000-0000-4000-8000-000000000099",
        expectedParameterName: mode?.name ?? "",
        normalizedValue: 0.6,
      }),
    ).rejects.toMatchObject({ code: "stale_reference" });
    await expect(
      service.setDeviceParameter({
        index: 0,
        expectedReference: drums?.reference ?? "",
        expectedName: "Main Drums",
        deviceIndex: device?.index ?? 0,
        expectedDeviceReference: device?.reference ?? "",
        expectedDeviceName: device?.name ?? "",
        parameterIndex: mode?.index ?? 0,
        expectedParameterReference: mode?.reference ?? "",
        expectedParameterName: mode?.name ?? "",
        normalizedValue: 0.6,
      }),
    ).resolves.toMatchObject({
      requestedNormalizedValue: 0.6,
      after: { value: 1, normalizedValue: 0.5 },
      verified: true,
    });
    await expect(
      service.setDeviceEnabled({
        index: 0,
        expectedReference: drums?.reference ?? "",
        expectedName: "Main Drums",
        deviceIndex: device?.index ?? 0,
        expectedDeviceReference: device?.reference ?? "",
        expectedDeviceName: device?.name ?? "",
        enabled: false,
      }),
    ).resolves.toMatchObject({
      beforeEnabled: true,
      afterEnabled: false,
      verified: true,
    });
    const createdClip = await service.createMidiClip({
      index: 0,
      expectedReference: drums?.reference ?? "",
      expectedName: "Main Drums",
      sceneIndex: 0,
      length: 4,
      name: "Beat",
    });
    expect(createdClip).toMatchObject({
      clip: {
        trackReference: drums?.reference,
        trackIndex: 0,
        sceneIndex: 0,
        name: "Beat",
        length: 4,
        noteCount: 0,
      },
      verified: true,
    });
    await expect(service.inspectSession()).resolves.toMatchObject({
      clips: [
        {
          reference: createdClip.clip.reference,
          trackReference: drums?.reference,
          trackIndex: 0,
          sceneIndex: 0,
          kind: "midi",
        },
      ],
    });
    const browserRoots = await service.inspectBrowserRoots();
    const instruments = browserRoots.roots.find(
      (root) => root.root === "instruments",
    );
    expect(instruments).toBeDefined();
    await expect(
      service.inspectBrowserChildren({
        expectedItemReference: instruments?.reference ?? "",
        expectedItemRoot: "instruments",
        expectedItemPath: [],
        expectedItemName: instruments?.name ?? "",
        expectedItemUri: instruments?.uri ?? "",
        offset: 0,
        limit: 1,
      }),
    ).resolves.toMatchObject({
      total: 1,
      items: [{ name: "Synths", isFolder: true }],
    });
    const browserSearch = await service.searchBrowser({
      query: "operator",
      roots: ["instruments"],
      maxNodes: 8,
      maxResults: 1,
      maxDepth: 3,
      maxDurationMs: 100,
    });
    expect(browserSearch).toMatchObject({
      visitedNodes: 3,
      stopReason: "result_limit",
      items: [{ name: "Operator", isBuiltInDevice: true }],
    });
    const browserItem = browserSearch.items[0];
    await expect(
      service.loadBrowserItem({
        index: 0,
        expectedReference: drums?.reference ?? "",
        expectedName: "Main Drums",
        expectedItemReference: browserItem?.reference ?? "",
        expectedItemRoot: browserItem?.root ?? "instruments",
        expectedItemPath: browserItem?.path ?? [],
        expectedItemName: browserItem?.name ?? "",
        expectedItemUri: browserItem?.uri ?? "",
      }),
    ).resolves.toMatchObject({
      item: { name: "Operator" },
      before: { deviceCount: 1, sessionClipCount: 1 },
      after: { deviceCount: 2, sessionClipCount: 1 },
      addedDevices: [{ name: "Operator" }],
      verified: true,
    });
    await expect(
      service.replaceMidiNotes({
        index: 0,
        expectedReference: drums?.reference ?? "",
        expectedName: "Main Drums",
        sceneIndex: 0,
        expectedClipReference: createdClip.clip.reference,
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
      }),
    ).resolves.toMatchObject({
      clip: { reference: createdClip.clip.reference, noteCount: 1 },
      beforeNoteCount: 0,
      afterNoteCount: 1,
      verified: true,
    });
    await expect(
      service.replaceMidiNotes({
        index: 0,
        expectedReference: drums?.reference ?? "",
        expectedName: "Main Drums",
        sceneIndex: 0,
        expectedClipReference: createdClip.clip.reference,
        allowPerNoteExpressionLoss: false,
        notes: [],
      }),
    ).rejects.toMatchObject({ code: "conflict", retryable: false });
    await expect(
      service.launchSessionClip({
        index: 0,
        expectedReference: drums?.reference ?? "",
        expectedName: "Main Drums",
        sceneIndex: 0,
        expectedClipReference: createdClip.clip.reference,
      }),
    ).resolves.toMatchObject({
      clip: {
        reference: createdClip.clip.reference,
        isPlaying: false,
        isTriggered: true,
      },
      before: { targetIsPlaying: false, targetIsTriggered: false },
      after: {
        trackPlayingSceneIndex: null,
        targetIsPlaying: false,
        targetIsTriggered: true,
      },
      verified: true,
    });
    const sessionDuplicate = await service.duplicateSessionClip({
      index: 0,
      expectedReference: drums?.reference ?? "",
      expectedName: "Main Drums",
      sceneIndex: 0,
      expectedClipReference: createdClip.clip.reference,
      destinationTrackIndex: 0,
      expectedDestinationTrackReference: drums?.reference ?? "",
      expectedDestinationTrackName: "Main Drums",
      destinationSceneIndex: 1,
    });
    expect(sessionDuplicate).toMatchObject({
      sourceClip: { reference: createdClip.clip.reference, noteCount: 1 },
      clip: {
        trackReference: drums?.reference,
        sceneIndex: 1,
        name: "Beat",
        noteCount: 1,
      },
      verified: true,
    });
    await expect(
      service.setSessionClipProperties({
        index: 0,
        expectedReference: drums?.reference ?? "",
        expectedName: "Main Drums",
        sceneIndex: 1,
        expectedClipReference: sessionDuplicate.clip.reference,
        name: "Beat Copy",
        muted: true,
        looping: false,
      }),
    ).resolves.toMatchObject({
      before: { name: "Beat", muted: false, looping: true },
      after: { name: "Beat Copy", muted: true, looping: false },
      clip: { name: "Beat Copy", muted: true, looping: false },
      verified: true,
    });
    await expect(
      service.duplicateSessionClip({
        index: 0,
        expectedReference: drums?.reference ?? "",
        expectedName: "Main Drums",
        sceneIndex: 0,
        expectedClipReference: createdClip.clip.reference,
        destinationTrackIndex: 0,
        expectedDestinationTrackReference: drums?.reference ?? "",
        expectedDestinationTrackName: "Main Drums",
        destinationSceneIndex: 1,
      }),
    ).rejects.toMatchObject({ code: "conflict", retryable: false });
    await expect(
      service.deleteSessionClip({
        index: 0,
        expectedReference: drums?.reference ?? "",
        expectedName: "Main Drums",
        sceneIndex: 1,
        expectedClipReference: sessionDuplicate.clip.reference,
      }),
    ).resolves.toMatchObject({
      clip: { reference: sessionDuplicate.clip.reference },
      beforeClipCount: 2,
      afterClipCount: 1,
      verified: true,
    });
    await expect(
      service.createArrangementMidiClip({
        index: 0,
        expectedReference: drums?.reference ?? "",
        expectedName: "Main Drums",
        startTime: 8,
        length: 4,
        name: "Verse",
      }),
    ).resolves.toMatchObject({
      clip: {
        trackReference: drums?.reference,
        trackIndex: 0,
        name: "Verse",
        startTime: 8,
        endTime: 12,
        length: 4,
        noteCount: 0,
      },
      verified: true,
    });
    const duplicated = await service.duplicateClipToArrangement({
      index: 0,
      expectedReference: drums?.reference ?? "",
      expectedName: "Main Drums",
      sceneIndex: 0,
      expectedClipReference: createdClip.clip.reference,
      destinationTime: 16,
    });
    expect(duplicated).toMatchObject({
      sourceClip: {
        reference: createdClip.clip.reference,
        kind: "midi",
        noteCount: 1,
      },
      clip: { name: "Beat", startTime: 16, endTime: 20, noteCount: 1 },
      beforeClipCount: 1,
      afterClipCount: 2,
      verified: true,
    });
    await expect(
      service.setArrangementClipProperties({
        index: 0,
        expectedReference: drums?.reference ?? "",
        expectedName: "Main Drums",
        expectedClipReference: duplicated.clip.reference,
        expectedStartTime: 16,
        name: "Chorus",
        muted: true,
        looping: false,
      }),
    ).resolves.toMatchObject({
      before: { name: "Beat", muted: false, looping: true },
      after: { name: "Chorus", muted: true, looping: false },
      clip: {
        reference: duplicated.clip.reference,
        name: "Chorus",
        muted: true,
        looping: false,
      },
      verified: true,
    });
    const updatedArrangement = await service.inspectArrangement({
      offset: 0,
      limit: 10,
    });
    expect(
      updatedArrangement.clips.find(
        (clip) => clip.reference === duplicated.clip.reference,
      ),
    ).toMatchObject({
      name: "Chorus",
      muted: true,
      looping: false,
    });
    await expect(
      service.setArrangementClipProperties({
        index: 0,
        expectedReference: drums?.reference ?? "",
        expectedName: "Main Drums",
        expectedClipReference: duplicated.clip.reference,
        expectedStartTime: 16,
      }),
    ).rejects.toThrow("At least one clip property is required");
    await expect(
      service.duplicateClipToArrangement({
        index: 0,
        expectedReference: drums?.reference ?? "",
        expectedName: "Main Drums",
        sceneIndex: 0,
        expectedClipReference: createdClip.clip.reference,
        destinationTime: 9,
      }),
    ).rejects.toMatchObject({ code: "conflict", retryable: false });
    const arrangement = await service.inspectArrangement({
      offset: 0,
      limit: 10,
    });
    expect(arrangement).toMatchObject({
      total: 2,
      clips: [
        { name: "Verse", kind: "midi", startTime: 8 },
        { name: "Chorus", kind: "midi", startTime: 16 },
      ],
    });
    await expect(
      service.replaceArrangementMidiNotes({
        index: 0,
        expectedReference: drums?.reference ?? "",
        expectedName: "Main Drums",
        expectedClipReference: arrangement.clips[0]?.reference ?? "",
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
      }),
    ).resolves.toMatchObject({
      beforeNoteCount: 0,
      afterNoteCount: 1,
      clip: { noteCount: 1 },
      verified: true,
    });
    await expect(
      service.deleteArrangementClip({
        index: 0,
        expectedReference: drums?.reference ?? "",
        expectedName: "Main Drums",
        expectedClipReference: arrangement.clips[0]?.reference ?? "",
        expectedStartTime: 8,
      }),
    ).resolves.toMatchObject({
      beforeClipCount: 2,
      afterClipCount: 1,
      verified: true,
    });
    const vocals = afterDelete.tracks.find((track) => track.name === "Vocals");
    expect(vocals).toBeDefined();
    await expect(
      service.createArrangementMidiClip({
        index: 1,
        expectedReference: vocals?.reference ?? "",
        expectedName: "Vocals",
        startTime: 8,
        length: 4,
      }),
    ).rejects.toMatchObject({
      code: "unsupported_capability",
      retryable: false,
    });
    await service.stop();
  });

  it("reports a connection error without crashing startup", async () => {
    const service = new AbletonBridgeService({
      authenticationToken: token,
      events: new InMemoryEventPublisher(),
      port: 1,
      requestTimeoutMs: 100,
    });

    await service.start();

    expect(await service.getStatus()).toMatchObject({
      state: "error",
      code: "connection_failed",
    });
  });

  it("preserves authentication failures as stable connection errors", async () => {
    const port = await startSimulator(
      "different-token-that-is-at-least-thirty-two-characters",
    );
    const service = new AbletonBridgeService({
      authenticationToken: token,
      events: new InMemoryEventPublisher(),
      port,
    });

    await service.start();

    expect(await service.getStatus()).toMatchObject({
      state: "error",
      code: "authentication_failed",
    });
  });
});
