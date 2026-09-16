import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

import { afterEach, describe, expect, it } from "vitest";

import { InMemoryEventPublisher, type AppEvent } from "@ableton-agent/shared";
import {
  registerCorrelationContext,
  unregisterCorrelationContext,
  withCorrelation,
} from "@ableton-agent/correlation";
import {
  telemetryEventEnvelopeSchema,
  type TelemetryEventEnvelope,
} from "@ableton-agent/observability";

import { AbletonBridgeService, type AbletonLiveEvent } from "./index.js";

const token = "test-token-that-is-at-least-thirty-two-characters";
let simulator: ChildProcessWithoutNullStreams | undefined;

async function startSimulator(
  expectedToken = token,
  options: { delayCommand?: string; delayMs?: number } = {},
): Promise<number> {
  const args = [
    "remote-script/simulator.py",
    "--token",
    expectedToken,
    ...(options.delayCommand === undefined
      ? []
      : ["--delay-command", options.delayCommand]),
    ...(options.delayMs === undefined
      ? []
      : ["--delay-ms", String(options.delayMs)]),
  ];
  simulator = spawn("python3", args, {
    cwd: new URL("../../..", import.meta.url),
    stdio: ["pipe", "pipe", "pipe"],
  });
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

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

afterEach(() => {
  simulator?.kill();
  simulator = undefined;
});

describe("AbletonBridgeService", () => {
  it("negotiates capabilities and sends ping across the Python protocol", async () => {
    const port = await startSimulator();
    const requests: {
      requestId: string;
      correlationId?: string;
      command: string;
      params: Readonly<Record<string, unknown>>;
    }[] = [];
    const responses: Array<{
      requestId: string;
      correlationId?: string;
      command: string;
      durationMs: number;
      ok: boolean;
      result?: unknown;
    }> = [];
    const telemetry: TelemetryEventEnvelope[] = [];
    const events = new InMemoryEventPublisher();
    const appEvents: AppEvent[] = [];
    events.subscribe((event) => appEvents.push(event));
    const service = new AbletonBridgeService({
      authenticationToken: token,
      events,
      port,
      onRequest: (request) => requests.push(request),
      onResponse: (response) => responses.push(response),
      telemetry: {
        enqueue: (event) => {
          telemetry.push(telemetryEventEnvelopeSchema.parse(event));
        },
      },
    });

    expect(service.getCurrentProjectId()).toBeUndefined();
    await service.start();
    expect(service.getCurrentProjectId()).toBe("simulated-project");

    expect(await service.getStatus()).toEqual({
      state: "connected",
      liveVersion: "12.1-simulator",
      remoteScriptVersion: "0.5.0",
      projectId: "simulated-project",
    });
    await expect(service.getCapabilities()).resolves.toMatchObject({
      selectedProtocolVersion: 3,
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
        "arrangement.fill_region": true,
        "arrangement.set_clip_properties": true,
      },
    });
    const upstreamTraceId = "00000000-0000-4000-8000-000000000001";
    const toolSpanId = "00000000-0000-4000-8000-000000000002";
    registerCorrelationContext({
      correlationId: "tool-call-123",
      traceId: upstreamTraceId,
      parentSpanId: toolSpanId,
      causationId: "turn-123",
      sessionId: "session-123",
      activeAgentId: "agent-123",
      liveEventId: "event-123",
      toolName: "ableton_connection_status",
    });
    await expect(
      withCorrelation("tool-call-123", () => service.ping()),
    ).resolves.toEqual({ pong: true });
    unregisterCorrelationContext("tool-call-123");
    const pingRequest = requests.find(
      (request) => request.correlationId === "tool-call-123",
    );
    expect(pingRequest).toMatchObject({
      correlationId: "tool-call-123",
      command: "system.ping",
      params: {},
    });
    expect(typeof pingRequest?.requestId).toBe("string");
    expect(
      responses.find((response) => response.correlationId === "tool-call-123"),
    ).toMatchObject({
      requestId: pingRequest?.requestId,
      command: "system.ping",
      ok: true,
      result: { pong: true },
    });
    const tracedRequest = telemetry.find(
      ({ name, correlationId }) =>
        name === "bridge.request.dispatched" &&
        correlationId === "tool-call-123",
    );
    const tracedResponse = telemetry.find(
      ({ name, correlationId }) =>
        name === "bridge.request.completed" &&
        correlationId === "tool-call-123",
    );
    expect(tracedRequest?.attributes).toMatchObject({
      requestId: pingRequest?.requestId,
      command: "system.ping",
      correlationId: "tool-call-123",
    });
    expect(tracedResponse).toMatchObject({
      outcome: "success",
      correlationId: "tool-call-123",
      causationId: "turn-123",
      sessionId: "session-123",
      activeAgentId: "agent-123",
      liveEventId: "event-123",
      toolName: "ableton_connection_status",
      trace: {
        traceId: upstreamTraceId,
        spanId: tracedRequest?.trace?.spanId,
        parentSpanId: toolSpanId,
      },
    });
    expect(tracedResponse?.trace?.spanId).toBe(tracedRequest?.trace?.spanId);
    expect(tracedResponse?.durationMs).toBeGreaterThanOrEqual(0);
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
    expect(appEvents).toContainEqual(
      expect.objectContaining({
        type: "ableton.project_mutated",
        command: "transport.set_tempo",
      }),
    );
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
    const drumsRoot = browserRoots.roots.find((root) => root.root === "drums");
    expect(drumsRoot).toMatchObject({
      isFolder: false,
      isNavigable: true,
    });
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
    await expect(
      service.searchBrowser({
        query: "808",
        roots: ["drums"],
        maxNodes: 8,
        maxResults: 2,
        maxDepth: 3,
        maxDurationMs: 100,
      }),
    ).resolves.toMatchObject({
      visitedNodes: 2,
      items: [
        {
          name: "808 Core Kit.adg",
          isLoadableDevice: true,
          isBuiltInDevice: true,
        },
      ],
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
      service.fillArrangementRegion({
        index: 0,
        expectedReference: drums?.reference ?? "",
        expectedName: "Main Drums",
        sceneIndex: 0,
        expectedClipReference: createdClip.clip.reference,
        regionStart: 24,
        regionEnd: 34,
      }),
    ).resolves.toMatchObject({
      fullTileCount: 2,
      coveredEnd: 32,
      unusedRemainder: 2,
      clips: [
        { startTime: 24, endTime: 28 },
        { startTime: 28, endTime: 32 },
      ],
      verified: true,
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
      service.inspectArrangementMidiNotes({
        index: 0,
        expectedReference: drums?.reference ?? "",
        expectedName: "Main Drums",
        expectedClipReference: arrangement.clips[0]?.reference ?? "",
        expectedStartTime: 8,
        offset: 0,
        limit: 16,
      }),
    ).resolves.toMatchObject({
      clip: { name: "Verse", noteCount: 1 },
      notes: [
        {
          pitch: 60,
          startTime: 0,
          duration: 1,
          velocity: 100,
          mute: false,
        },
      ],
      totalNotes: 1,
      offset: 0,
      limit: 16,
      truncated: false,
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
      beforeClipCount: 4,
      afterClipCount: 3,
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

  it("manages simulator subscriptions and decodes typed Live events", async () => {
    const port = await startSimulator();
    const telemetry: TelemetryEventEnvelope[] = [];
    const service = new AbletonBridgeService({
      authenticationToken: token,
      events: new InMemoryEventPublisher(),
      port,
      eventSubscriptions: ["live_event.occurred", "live_event.invalidated"],
      telemetry: {
        enqueue: (event) => {
          telemetry.push(telemetryEventEnvelopeSchema.parse(event));
        },
      },
    });
    const liveEvents: AbletonLiveEvent[] = [];
    service.subscribeLiveEvents((event) => liveEvents.push(event));

    await service.start();
    const selection = await service.inspectEventSelection();
    expect(selection.parameter).not.toBeNull();
    const eventId = "live-event.00000000-0000-4000-8000-000000000123";
    const result = await service.subscribeLiveEvent({
      ...selection.parameter!,
      eventId,
      kind: "parameter.value_changed",
      projectId: "simulated-project",
      observationPolicy: {
        minimumNormalizedDelta: 0.01,
        throttleMs: 100,
      },
    });
    expect(result).toMatchObject({
      eventId,
      kind: "parameter.value_changed",
      resolution: { status: "resolved" },
      initialState: { kind: "parameter.value_changed" },
    });
    expect(service.getLiveEventSubscriptionStatuses()).toMatchObject([
      { eventId, status: "resolved" },
    ]);

    await service.setDeviceParameter({
      ...selection.parameter!,
      normalizedValue: 0.9,
    });
    await waitFor(() => liveEvents.length === 1);
    expect(liveEvents).toHaveLength(1);
    expect(liveEvents[0]).toMatchObject({
      event: "live_event.occurred",
      payload: {
        eventId,
        kind: "parameter.value_changed",
        sequence: 0,
      },
    });
    expect(typeof liveEvents[0]?.receivedAt).toBe("string");
    const occurrenceTrace = telemetry.find(
      ({ name, attributes }) =>
        name === "live-event.received" && attributes.eventId === eventId,
    );
    const emittedOccurrence = liveEvents[0];
    if (emittedOccurrence?.event !== "live_event.occurred") {
      throw new Error("Expected a Live event occurrence");
    }
    expect(occurrenceTrace?.trace).toMatchObject({
      traceId: emittedOccurrence.payload.occurrenceId,
      spanId: emittedOccurrence.payload.occurrenceId,
    });
    expect(occurrenceTrace).toMatchObject({
      correlationId: emittedOccurrence.payload.occurrenceId,
      projectId: "simulated-project",
      liveEventId: eventId,
    });
    await expect(service.listLiveEventSubscriptions()).resolves.toMatchObject({
      subscriptions: [{ eventId }],
    });
    await expect(service.unsubscribeLiveEvent(eventId)).resolves.toEqual({
      eventId,
      unsubscribed: true,
    });
    expect(service.getLiveEventSubscriptionStatuses()).toEqual([]);
    await service.subscribeLiveEvent({
      ...selection.parameter!,
      eventId,
      kind: "parameter.value_changed",
      projectId: "simulated-project",
    });
    await expect(service.clearLiveEventSubscriptions()).resolves.toEqual({
      clearedEventIds: [eventId],
    });
    await waitFor(() => liveEvents.at(-1)?.event === "live_event.invalidated");
    expect(liveEvents.at(-1)).toMatchObject({
      event: "live_event.invalidated",
      payload: { eventId, reason: "subscription-cleared" },
    });
    expect(service.getLiveEventSubscriptionStatuses()).toMatchObject([
      { eventId, status: "invalidated" },
    ]);
    await service.stop();
  });

  it("serializes concurrent requests and starts timeouts at dispatch", async () => {
    const port = await startSimulator(token, {
      delayCommand: "devices.inspect_parameters",
      delayMs: 300,
    });
    const telemetry: TelemetryEventEnvelope[] = [];
    const service = new AbletonBridgeService({
      authenticationToken: token,
      events: new InMemoryEventPublisher(),
      port,
      requestTimeoutMs: 200,
      longRequestTimeoutMs: 1_000,
      telemetry: {
        enqueue: (event) => {
          telemetry.push(telemetryEventEnvelopeSchema.parse(event));
        },
      },
    });

    await service.start();
    const track = (await service.inspectSession()).tracks[0]!;
    const device = (
      await service.inspectDevices({
        index: track.index,
        expectedReference: track.reference,
        expectedName: track.name,
        offset: 0,
        limit: 1,
      })
    ).devices[0]!;
    const lifecycleStart = telemetry.length;
    await expect(
      Promise.all([
        service.inspectDeviceParameters({
          index: track.index,
          expectedReference: track.reference,
          expectedName: track.name,
          deviceIndex: device.index,
          expectedDeviceReference: device.reference,
          expectedDeviceName: device.name,
          offset: 0,
          limit: 1,
        }),
        service.ping(),
      ]),
    ).resolves.toEqual([expect.objectContaining({ total: 3 }), { pong: true }]);

    const lifecycle = telemetry
      .slice(lifecycleStart)
      .filter(
        ({ name, attributes }) =>
          ["devices.inspect_parameters", "system.ping"].includes(
            String(attributes.command),
          ) &&
          [
            "bridge.request.queued",
            "bridge.request.dispatched",
            "bridge.request.completed",
          ].includes(name),
      );
    expect(lifecycle.map(({ name }) => name)).toEqual([
      "bridge.request.queued",
      "bridge.request.queued",
      "bridge.request.dispatched",
      "bridge.request.completed",
      "bridge.request.dispatched",
      "bridge.request.completed",
    ]);
    const parameterDispatch = lifecycle.find(
      ({ name, attributes }) =>
        name === "bridge.request.dispatched" &&
        attributes.command === "devices.inspect_parameters",
    );
    expect(parameterDispatch?.attributes).toMatchObject({
      timeoutClass: "long",
      timeoutMs: 1_000,
    });
    const pingCompleted = lifecycle.find(
      ({ name, attributes }) =>
        name === "bridge.request.completed" &&
        attributes.command === "system.ping",
    );
    expect(pingCompleted?.attributes).toMatchObject({
      timeoutClass: "normal",
      timeoutMs: 200,
    });
    expect(pingCompleted?.attributes.queueWaitMs).toBeGreaterThanOrEqual(250);
    expect(pingCompleted?.attributes.totalDurationMs).toBeGreaterThan(200);
    await service.stop();
  });

  it("cancels in-flight and queued requests when stopped", async () => {
    const port = await startSimulator(token, {
      delayCommand: "system.ping",
      delayMs: 100,
    });
    const telemetry: TelemetryEventEnvelope[] = [];
    const service = new AbletonBridgeService({
      authenticationToken: token,
      events: new InMemoryEventPublisher(),
      port,
      requestTimeoutMs: 200,
      telemetry: {
        enqueue: (event) => {
          telemetry.push(telemetryEventEnvelopeSchema.parse(event));
        },
      },
    });

    await service.start();
    const resultsPromise = Promise.allSettled([service.ping(), service.ping()]);
    await waitFor(
      () =>
        telemetry.filter(
          ({ name, attributes }) =>
            name === "bridge.request.queued" &&
            attributes.command === "system.ping",
        ).length === 2,
    );
    await service.stop();

    const results = await resultsPromise;
    expect(results.every(({ status }) => status === "rejected")).toBe(true);
    expect(
      telemetry.filter(
        ({ name, attributes }) =>
          name === "bridge.request.cancelled" &&
          attributes.command === "system.ping",
      ),
    ).toHaveLength(2);
  });

  it("rejects and records request queue saturation", async () => {
    const port = await startSimulator(token, {
      delayCommand: "system.ping",
      delayMs: 40,
    });
    const telemetry: TelemetryEventEnvelope[] = [];
    const service = new AbletonBridgeService({
      authenticationToken: token,
      events: new InMemoryEventPublisher(),
      port,
      requestTimeoutMs: 80,
      requestQueueLimit: 1,
      telemetry: {
        enqueue: (event) => {
          telemetry.push(telemetryEventEnvelopeSchema.parse(event));
        },
      },
    });

    await service.start();
    const first = service.ping();
    await expect(service.ping()).rejects.toMatchObject({
      code: "queue_full",
      retryable: true,
    });
    await expect(first).resolves.toEqual({ pong: true });
    expect(
      telemetry.find(
        ({ name, attributes }) =>
          name === "bridge.request.failed" &&
          attributes.errorCode === "queue_full",
      )?.attributes,
    ).toMatchObject({
      command: "system.ping",
      queueDepth: 1,
      queueLimit: 1,
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
