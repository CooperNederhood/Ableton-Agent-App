import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveLiveAgentStorage } from "@ableton-agent/storage";
import type { DriverContext } from "../../packages/test-support/src/integration/contracts.js";
import {
  liveSetSnapshotSchema,
  desktopSessionListeningPreflightSchema,
  type DesktopSessionListeningPreflight,
} from "../../apps/desktop/src/contracts.js";
import { SUPPORTED_AUDIO_BASELINE } from "../../packages/test-support/src/integration/contracts.js";
import { midiContentIdentity } from "../../packages/test-support/src/integration/sources.js";
import { observedSessionSource } from "../../tests/electron/acceptance-evidence.js";
import type {
  InspectSessionListeningSourceParams,
  InspectSessionListeningSourceResult,
  MetricAudioObservation,
} from "@ableton-agent/protocol";

const mocks = vi.hoisted(() => ({
  launch: vi.fn(),
  stop: vi.fn(),
  liveLaunch: vi.fn(),
  liveStop: vi.fn(),
  liveClose: vi.fn(),
  preexisting: vi.fn(),
  liveRecord: vi.fn(),
  liveReady: vi.fn(),
  send: vi.fn(),
  provision: vi.fn(),
  project: vi.fn(),
  loading: vi.fn(),
  flatnessLoading: vi.fn(),
  bridgeOptions: vi.fn(),
  bridgeStart: vi.fn(),
  bridgeClose: vi.fn(),
  bridgeSnapshot: vi.fn(),
  subscriber: vi.fn<(handler: (event: unknown) => void) => () => void>(),
}));
vi.mock("@playwright/test", () => ({ _electron: { launch: mocks.launch } }));
vi.mock("@ableton-agent/debug-control", () => ({
  sendAutomationMessage: mocks.send,
}));
vi.mock("../../tests/electron/acceptance-dependencies.js", () => ({
  provisionPackagedDependencies: mocks.provision,
}));
vi.mock("../../tests/electron/acceptance-project.js", async (original) => ({
  ...(await original<object>()),
  inspectAcceptanceProject: mocks.project,
}));
vi.mock("../../tests/electron/acceptance-loading.js", () => ({
  verifyActiveFrozenCandidate: mocks.loading,
}));
vi.mock("../../tests/electron/acceptance-flatness-loading.js", () => ({
  verifyLoadedFlatnessBinary: mocks.flatnessLoading,
}));
vi.mock("../../tests/electron/packaged-paths.js", () => ({
  packagedExecutable: async () => "/candidate/Contents/MacOS/Agent",
  packagedCandidateHash: async () => "0".repeat(64),
  finderLikeEnvironment: (overrides: Record<string, string>) => overrides,
}));
vi.mock("../../tests/electron/acceptance-bridge-timing.js", () => ({
  AcceptanceBridgeTimingProxy: class {
    constructor(options: unknown) {
      mocks.bridgeOptions(options);
    }
    start = mocks.bridgeStart;
    close = mocks.bridgeClose;
    snapshot = mocks.bridgeSnapshot;
  },
}));
vi.mock("../../tests/electron/packaged-cleanup.js", () => ({
  closeOwnedPackagedApplication: mocks.stop,
}));
vi.mock("../../scripts/lib/live-ux-host.mjs", () => ({
  waitForRunnerOwnedLiveReady: mocks.liveReady,
}));
vi.mock("../../scripts/lib/live-process-controller.mjs", () => ({
  LiveProcessController: class {
    assertNoPreExistingLive = mocks.preexisting;
    launch = mocks.liveLaunch;
    publicRecord = mocks.liveRecord;
    discardAfterFailure = mocks.liveStop;
    close = mocks.liveClose;
  },
}));
import { PackagedAcceptanceDriver } from "../../tests/electron/acceptance-driver.js";

let directory: string;
let context: DriverContext;
let driver: PackagedAcceptanceDriver;
const identity = {
  appSessionId: randomUUID(),
  agentId: randomUUID(),
  conversationId: randomUUID(),
};
const assistantMessageId = randomUUID();
const userMessageId = randomUUID();
const listenerBinding = {
  slot: "AudioTrack:175/DeviceChain/DeviceChain/Devices/MxDeviceAudioEffect:0",
  sourcePath: "Presets/Listener.amxd",
  dependency: "machine-listening" as const,
  trackIndex: 0,
  deviceIndex: 0,
};
const api = {
  lifecycle: { get: vi.fn() },
  ableton: {
    getStatus: vi.fn(),
    requestSnapshot: vi.fn(),
    inspectSessionListeningPreflight:
      vi.fn<
        (
          request: InspectSessionListeningSourceParams,
        ) => Promise<DesktopSessionListeningPreflight>
      >(),
  },
  agents: {
    getAuthStatus: vi.fn(),
    listActive: vi.fn<
      () => Promise<
        Array<{
          id: string;
          sdkSessionId: string;
          lifecycle: string;
          definitionName: string;
          definitionFingerprint: string;
          modified: boolean;
          autoApprove: boolean;
          mode: string;
        }>
      >
    >(),
  },
  agent: { getSessions: vi.fn() },
  outputs: { list: vi.fn() },
  listening: { list: vi.fn() },
  approvals: { resolve: vi.fn() },
  eventHistory: { trace: vi.fn() },
  events: { subscribe: mocks.subscriber },
};
const page = {
  evaluate: async <T, A>(fn: (arg: A) => T, argument: A) => fn(argument),
  exposeFunction: async (name: string, callback: unknown) => {
    Reflect.set(window, name, callback);
  },
  isClosed: () => false,
};
const application = {
  evaluate: vi.fn(),
  firstWindow: async () => page,
  process: () => ({ pid: 98765 }),
};

beforeEach(async () => {
  vi.resetAllMocks();
  mocks.bridgeStart.mockResolvedValue(54321);
  mocks.bridgeSnapshot.mockReturnValue({ records: [] });
  vi.stubGlobal("window", { desktop: api });
  directory = await realpath(
    await mkdtemp(join(tmpdir(), "acceptance-adapter-")),
  );
  const projectPath = join(directory, "project.als");
  await writeFile(projectPath, "controlled test project; never opened in Live");
  context = {
    runId: randomUUID(),
    traceId: randomUUID(),
    correlationId: randomUUID(),
    causationId: randomUUID(),
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 10_000,
    scenario: {
      schemaVersion: 1,
      id: "adapter-test",
      fixtureId: "adapter-fixture",
      requiredCapabilities: ["automation"],
      permissions: [],
      steps: [],
      assertions: [],
      budget: { runMs: 10000, cleanupMs: 1000, persistenceMs: 1000 },
    },
    fixture: {
      schemaVersion: 1,
      id: "adapter-fixture",
      qualification: "reviewed-live",
      provenance: {
        ownership: "authored",
        description: "Controlled adapter test, not host qualification",
      },
      resources: [],
      dependencies: [],
      baseline: {},
    },
    stagedFixture: {
      projectPath,
      workingDirectory: directory,
      resources: [],
      verifySourceUnchanged: async () => undefined,
    },
  };
  mocks.launch.mockImplementation(async () => {
    await writeFile(
      join(directory, "profile/automation-endpoint.json"),
      JSON.stringify({
        version: 1,
        host: "127.0.0.1",
        port: 43210,
        processId: 98765,
        secretPath: join(directory, "profile/secret"),
        startedAt: new Date().toISOString(),
      }),
    );
    return application;
  });
  mocks.provision.mockResolvedValue({
    hashes: {},
    inventory: {
      schemaVersion: 1,
      candidateRoot: "/candidate/Contents/Resources/ableton-integrations",
      resources: [],
      generatedConfigurations: [],
    },
  });
  mocks.stop.mockResolvedValue({ stopped: true, successful: true, events: [] });
  mocks.liveRecord.mockReturnValue({ pid: 98766, owned: true });
  mocks.subscriber.mockReturnValue(() => undefined);
  application.evaluate.mockResolvedValue({
    packaged: true,
    path: "/candidate/Contents/Resources/app.asar",
    resources: "/candidate/Contents/Resources",
    args: [],
    version: "test",
  });
  api.lifecycle.get.mockResolvedValue("ready");
  api.ableton.getStatus.mockResolvedValue({
    state: "connected",
    liveVersion: "11.3.43",
  });
  api.ableton.requestSnapshot.mockResolvedValue(
    liveSetSnapshotSchema.parse({
      liveSetId: "test-set",
      liveSetName: "Project",
      tempo: 120,
      timeSignature: "4/4",
      tracks: [],
      sessionClips: [],
    }),
  );
  api.agents.getAuthStatus.mockResolvedValue({ state: "authenticated" });
  api.agents.listActive.mockResolvedValue([
    {
      id: identity.agentId,
      sdkSessionId: identity.conversationId,
      lifecycle: "ready",
      definitionName: "default",
      definitionFingerprint: "fingerprint",
      modified: false,
      autoApprove: false,
      mode: "interactive",
    },
  ]);
  api.agent.getSessions.mockResolvedValue([
    { id: identity.appSessionId, selectedAgentInstanceId: identity.agentId },
  ]);
  api.outputs.list.mockResolvedValue({
    activeSessionId: identity.appSessionId,
    connections: [],
  });
  api.listening.list.mockResolvedValue({ jobs: [] });
  api.approvals.resolve.mockResolvedValue(true);
  api.eventHistory.trace.mockResolvedValue({ items: [] });
  mocks.send.mockResolvedValue({
    accepted: true,
    messageId: userMessageId,
    turn: {
      assistantMessageId,
      target: {
        appSessionId: identity.appSessionId,
        agentInstanceId: identity.agentId,
        sdkSessionId: identity.conversationId,
      },
    },
  });
  driver = new PackagedAcceptanceDriver({ runDirectory: directory });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(directory, { recursive: true, force: true });
});

async function audioBaseline(
  target = "media/resource-001.wav",
  content = "synthetic adapter bytes, not a listening fixture",
) {
  const trackId = randomUUID(),
    clipId = randomUUID();
  const mediaPath = join(directory, target);
  await mkdir(dirname(mediaPath), { recursive: true });
  const bytes = Buffer.from(content);
  await writeFile(mediaPath, bytes);
  const mediaSha256 = createHash("sha256").update(bytes).digest("hex");
  const resource = {
    path: target,
    target,
    bytes: bytes.length,
    sha256: mediaSha256,
  };
  context = {
    ...context,
    scenario: {
      ...context.scenario,
      requiredCapabilities: ["automation", "session-audio"],
    },
    fixture: {
      ...context.fixture,
      resources: [resource],
      sources: [
        {
          id: "a",
          trackName: "Source 1",
          clipName: "Clip 1",
          sceneIndex: 0,
          mediaTarget: target,
        },
      ],
      baseline: {
        ...SUPPORTED_AUDIO_BASELINE,
      },
    },
    stagedFixture: { ...context.stagedFixture!, resources: [resource] },
  };
  api.ableton.requestSnapshot.mockResolvedValue(
    liveSetSnapshotSchema.parse({
      liveSetId: "test-set",
      liveSetName: "Project",
      tempo: 120,
      timeSignature: "4/4",
      tracks: [
        {
          id: trackId,
          name: "Source 1",
          kind: "audio",
          index: 0,
          color: "#fff",
          volume: 0.8,
          pan: 0,
          muted: false,
          clips: [],
          devices: [],
        },
      ],
      sessionClips: [
        {
          id: clipId,
          trackId,
          trackIndex: 0,
          sceneIndex: 0,
          name: "Clip 1",
          kind: "audio",
          lengthBeats: 4,
          noteCount: null,
          status: "stopped",
        },
      ],
    }),
  );
  api.outputs.list.mockResolvedValue({
    activeSessionId: identity.appSessionId,
    connections: [
      {
        producerId: "listener",
        signalKind: "audio",
        state: "connected",
        track: { id: trackId },
      },
    ],
  });
  const sourceState: InspectSessionListeningSourceResult["after"] = {
    transportPlaying: false,
    globalBeat: 0,
    startTimeBeats: 0,
    playingPosition: 0,
    targetPlaying: false,
    targetTriggered: false,
    targetRecording: false,
    playingSlotIndex: -1,
    firedSlotIndex: -1,
    selectedClipReference: clipId,
  };
  const recording = {
    arrangementRecord: false,
    sessionRecord: false,
    overdub: false,
    sessionAutomationRecord: false,
    punchIn: false,
    punchOut: false,
  };
  const audio: Extract<
    DesktopSessionListeningPreflight,
    { audio: unknown }
  >["audio"] = {
    reference: clipId,
    name: "Clip 1",
    length: 4,
    gain: 1,
    pitchCoarse: 0,
    pitchFine: 0,
    warping: true,
    warpMode: 0,
    availableWarpModes: [0],
    startMarker: 0,
    endMarker: 4,
    loopStart: 0,
    loopEnd: 4,
    looping: true,
    ramMode: false,
    filePath: mediaPath,
    sampleLength: 96000,
    sampleRate: 48000,
  };
  const settings: InspectSessionListeningSourceResult["settings"] = {
    tempoBpm: 120,
    signatureNumerator: 4,
    signatureDenominator: 4,
    globalQuantization: 0,
    launchQuantization: 0,
    launchMode: 0,
    legato: false,
    followActionEnabled: false,
    startMarker: 0,
    endMarker: 4,
    loopStart: 0,
    loopEnd: 4,
    looping: true,
  };
  api.ableton.inspectSessionListeningPreflight.mockImplementation(
    async (request) =>
      desktopSessionListeningPreflightSchema.parse({
        source: {
          ...request,
          projectRevision: 1,
          evidence: "message-rate-only",
          nativeAlignment: "unverified",
          sourceKind: "warped-audio",
          positionUnit: "beats",
          before: sourceState,
          after: sourceState,
          settings,
        },
        audio,
        recording: { action: "inspect", state: recording },
      }),
  );
  return {
    audio,
    settings,
    recording,
    sourceState,
    mediaSha256,
    mediaPath,
    clipId,
    trackId,
  };
}

async function twoSources() {
  const a = await audioBaseline();
  const aContext = context;
  const aSnapshot = liveSetSnapshotSchema.parse(
    await api.ableton.requestSnapshot(),
  );
  const aRead =
    api.ableton.inspectSessionListeningPreflight.getMockImplementation()!;
  const b = await audioBaseline(
    "media/resource-002.wav",
    "different reviewed source",
  );
  b.audio.name = "Clip 2";
  const bSnapshot = liveSetSnapshotSchema.parse(
    await api.ableton.requestSnapshot(),
  );
  const bRead =
    api.ableton.inspectSessionListeningPreflight.getMockImplementation()!;
  const sources = [
    { ...aContext.fixture.sources![0]!, id: "a" },
    {
      ...context.fixture.sources![0]!,
      id: "b",
      trackName: "Source 2",
      clipName: "Clip 2",
    },
  ];
  context = {
    ...context,
    fixture: {
      ...context.fixture,
      resources: [...aContext.fixture.resources, ...context.fixture.resources],
      sources,
    },
    stagedFixture: {
      ...context.stagedFixture!,
      resources: [
        ...aContext.stagedFixture!.resources,
        ...context.stagedFixture!.resources,
      ],
    },
  };
  api.ableton.requestSnapshot.mockResolvedValue(
    liveSetSnapshotSchema.parse({
      ...aSnapshot,
      tracks: [
        ...aSnapshot.tracks,
        { ...bSnapshot.tracks[0], index: 1, name: "Source 2" },
      ],
      sessionClips: [
        ...aSnapshot.sessionClips!,
        { ...bSnapshot.sessionClips![0], trackIndex: 1, name: "Clip 2" },
      ],
    }),
  );
  const connections = [a, b].map((source, index) => ({
    producerId: `listener-${index}`,
    connectionId: `connection-${index}`,
    instanceId: `instance-${index}`,
    signalKind: "audio",
    state: "connected",
    track: { id: source.trackId },
  }));
  api.outputs.list.mockResolvedValue({
    activeSessionId: identity.appSessionId,
    connections,
  });
  api.ableton.inspectSessionListeningPreflight.mockImplementation(
    async (request) => {
      const observed = await (request.target.track.index === 0 ? aRead : bRead)(
        request,
      );
      if (!("audio" in observed)) throw new Error("Expected audio test source");
      return {
        ...observed,
        audio: { ...observed.audio, name: request.target.expectedClipName },
      };
    },
  );
  return { a, b, connections };
}

async function midiBaseline() {
  const audio = await audioBaseline();
  const snapshot = liveSetSnapshotSchema.parse(
    await api.ableton.requestSnapshot(),
  );
  snapshot.tracks[0]!.kind = "midi";
  snapshot.sessionClips![0]!.kind = "midi";
  snapshot.sessionClips![0]!.noteCount = 4;
  snapshot.sessionClips![0]!.status = "playing";
  const devices = ["Operator", "Listener"].map((name, index) => ({
    reference: randomUUID(),
    trackReference: audio.trackId,
    trackIndex: 0,
    index,
    name,
    className: index === 0 ? "Operator" : "MxDeviceAudioEffect",
    classDisplayName: name,
    enabled: true,
    parameterCount: 1,
    canHaveChains: false as const,
    canHaveDrumPads: false as const,
  }));
  snapshot.devices = devices.map(
    ({ reference, trackReference, ...device }) => ({
      ...device,
      id: reference,
      trackId: trackReference,
    }),
  );
  const listener = { ...listenerBinding, deviceIndex: 1 };
  const placement = {
    trackIndex: 0,
    deviceIndex: 1,
    deviceReference: devices[1]!.reference,
  };
  const target: InspectSessionListeningSourceParams = {
    schemaVersion: 1,
    queryId: randomUUID(),
    target: {
      view: "session",
      track: {
        kind: "regular",
        index: 0,
        expectedReference: audio.trackId,
        expectedName: "Source 1",
      },
      sceneIndex: 0,
      expectedClipReference: audio.clipId,
      expectedClipName: "Clip 1",
    },
  };
  const base = await api.ableton.inspectSessionListeningPreflight(target);
  const inventory = { devices, total: 2, offset: 0, limit: 8 };
  const state = {
    ...audio.sourceState,
    globalBeat: 5.5,
    targetPlaying: true,
    playingSlotIndex: 0,
  };
  const parsed = desktopSessionListeningPreflightSchema.parse({
    source: {
      ...base.source,
      sourceKind: "midi",
      before: state,
      after: state,
      settings: { ...audio.settings, globalQuantization: 4 },
    },
    recording: base.recording,
    midi: {
      clip: {
        reference: audio.clipId,
        name: "Clip 1",
        trackReference: audio.trackId,
        trackIndex: 0,
        sceneIndex: 0,
        length: 4,
        noteCount: 4,
      },
      notes: [0, 1, 2, 3].map((startTime) => ({
        pitch: 60,
        startTime,
        duration: 0.25,
        velocity: 100,
        mute: false,
      })),
      offset: 0,
      limit: 2048,
      totalNotes: 4,
      truncated: false,
    },
    instrumentChain: {
      before: inventory,
      after: structuredClone(inventory),
      devices: devices.map((device) => ({
        device,
        total: 1,
        offset: 0,
        limit: 256,
        parameters: [
          {
            reference: randomUUID(),
            deviceReference: device.reference,
            index: 0,
            name: device.index === 1 ? "Attack rise dB" : "Level",
            value: 0.5,
            normalizedValue: 0.5,
            min: 0,
            max: 1,
            isQuantized: false,
            isEnabled: true,
            valueItemCount: 0,
          },
        ],
      })),
    },
  });
  if (!("midi" in parsed)) throw new Error("Expected MIDI fixture");
  const expected = midiContentIdentity(parsed, placement);
  context = {
    ...context,
    scenario: {
      ...context.scenario,
      requiredCapabilities: ["automation", "session-midi"],
    },
    fixture: {
      ...context.fixture,
      listenerBindings: [listener],
      sources: [
        {
          id: "midi",
          trackName: "Source 1",
          clipName: "Clip 1",
          sceneIndex: 0,
          trackIndex: 0,
          listenerBindingSlot: listener.slot,
          midi: {
            notesSha256: expected.midiNotesSha256,
            instrumentChainSha256: expected.instrumentChainSha256,
          },
        },
      ],
      baseline: {
        ...SUPPORTED_AUDIO_BASELINE,
        clipWarped: false,
        globalQuantization: "bar",
        currentSongTime: 5.5,
        rememberedSessionClips: 1,
        playingSessionClips: 1,
      },
    },
  };
  api.ableton.requestSnapshot.mockResolvedValue(snapshot);
  const connection = {
    producerId: "listener",
    connectionId: "connection",
    instanceId: "instance",
    signalKind: "audio",
    state: "connected",
    track: { id: String(audio.trackId), index: 0, name: "Source 1" },
    device: { id: String(devices[1]!.reference), name: "Listener" },
  };
  api.outputs.list.mockResolvedValue({
    activeSessionId: identity.appSessionId,
    connections: [connection],
  });
  api.ableton.inspectSessionListeningPreflight.mockImplementation(
    async (request) => ({
      ...parsed,
      source: { ...parsed.source, ...request },
    }),
  );
  return { preflight: parsed, snapshot, connection, expected };
}

describe("packaged acceptance adapter lifecycle (controlled processes)", () => {
  it("reviews owned MIDI evidence without invented expected hashes or a user-message submission", async () => {
    const { preflight, expected } = await midiBaseline();
    const source = context.fixture.sources![0]!;
    if (!("midi" in source)) throw new Error("Expected MIDI definition");
    const review = {
      id: source.id,
      trackName: source.trackName,
      clipName: source.clipName,
      sceneIndex: source.sceneIndex,
      trackIndex: source.trackIndex,
      listenerBindingSlot: source.listenerBindingSlot,
    };
    const assets = { ...context.fixture };
    delete assets.sources;
    context = {
      ...context,
      scenario: { ...context.scenario, requiredCapabilities: ["automation"] },
      fixture: { ...assets, baseline: {} },
    };
    await driver.launch(context);
    await driver.ready(context);
    const observed = await driver.reviewMidiSources(context, [review]);
    expect(observed.sources?.midi?.source).toMatchObject(expected);
    expect(observed.sources?.midi?.facts.currentSongTime).toBe(5.5);
    expect(mocks.send).not.toHaveBeenCalled();
    await expect(driver.reviewMidiSources(context, [])).rejects.toThrow(
      "distinct sources",
    );
    preflight.source.after.transportPlaying = true;
    await expect(driver.reviewMidiSources(context, [review])).rejects.toThrow(
      "stoppedPosition",
    );
    await driver.cleanup(context);
    expect(mocks.stop).toHaveBeenCalled();
    expect(mocks.liveStop).toHaveBeenCalled();
  });
  it("admits a source with omitted common kind and quantization facts and an explicit stopped playing count", async () => {
    const { preflight } = await midiBaseline();
    preflight.source.settings.launchQuantization = 5;
    context = {
      ...context,
      fixture: {
        ...context.fixture,
        baseline: Object.fromEntries(
          Object.entries(context.fixture.baseline).filter(
            ([key]) =>
              ![
                "clipWarped",
                "clipLaunchQuantization",
                "rememberedSessionClips",
              ].includes(key),
          ),
        ),
      },
    };
    await driver.launch(context);
    await driver.ready(context);
    const baseline = await driver.readBaseline(context);
    expect(baseline.sources?.midi?.facts).toMatchObject({
      clipLaunchQuantization: "bar",
      clipWarped: false,
      playingSessionClips: 1,
      rememberedSessionClips: 1,
      transportPlaying: false,
      queuedSessionClips: 0,
    });
    preflight.source.settings.launchQuantization = 0;
    await expect(
      driver.submit(
        {
          id: "listen",
          sourceId: "midi",
          message: "Listen",
          timeoutMs: 1000,
          assertions: [{ name: "capture", parameters: {} }],
        },
        context,
      ),
    ).rejects.toThrow("Protected source settings changed");
    await driver.cleanup(context);
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("preserves two observed playing Session flags as remembered selection while transport is stopped", async () => {
    const { a, b } = await twoSources();
    const beat = 2.059377861721612;
    for (const observed of [a, b]) {
      Object.assign(observed.sourceState, {
        globalBeat: beat,
        targetPlaying: true,
        playingSlotIndex: 0,
      });
      observed.settings.globalQuantization = 4;
    }
    const snapshot = liveSetSnapshotSchema.parse(
      await api.ableton.requestSnapshot(),
    );
    snapshot.sessionClips!.forEach((clip) => {
      clip.status = "playing";
    });
    api.ableton.requestSnapshot.mockResolvedValue(snapshot);
    context = {
      ...context,
      fixture: {
        ...context.fixture,
        baseline: {
          ...context.fixture.baseline,
          currentSongTime: beat,
          globalQuantization: "bar",
          playingSessionClips: 2,
          rememberedSessionClips: 2,
        },
      },
    };
    await driver.launch(context);
    await driver.ready(context);
    const baseline = await driver.readBaseline(context);
    for (const source of Object.values(baseline.sources!))
      expect(source.facts).toMatchObject({
        transportPlaying: false,
        playingSessionClips: 2,
        rememberedSessionClips: 2,
        queuedSessionClips: 0,
      });
    await driver.cleanup(context);
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.liveStop).toHaveBeenCalledOnce();
  });
  it("binds MIDI native Max IDs through the unique reviewed listener slot, not the UUID namespace", async () => {
    const { connection, expected } = await midiBaseline();
    connection.track.id = "2141";
    connection.device.id = "2140";
    await driver.launch(context);
    await driver.ready(context);
    const baseline = await driver.readBaseline(context);
    expect(baseline.sources?.midi?.source).toMatchObject(expected);
    expect(baseline.sources?.midi?.listenerId).toBe("listener");
    await driver.cleanup(context);
  });

  it.each([
    ["global", 0],
    ["none", 1],
    ["bar", 5],
  ] as const)(
    "admits independently declared source quantization %s from the protocol enum",
    async (expected, canonical) => {
      const { preflight } = await midiBaseline();
      const beat = 2.0593777777777778;
      preflight.source.before.globalBeat = beat;
      preflight.source.after.globalBeat = beat;
      preflight.source.settings.launchQuantization = canonical;
      context = {
        ...context,
        fixture: {
          ...context.fixture,
          baseline: { ...context.fixture.baseline, currentSongTime: beat },
          sources: context.fixture.sources!.map((source) => ({
            ...source,
            clipLaunchQuantization: expected,
          })),
        },
      };
      await driver.launch(context);
      await driver.ready(context);
      const baseline = await driver.readBaseline(context);
      expect(baseline.sources?.midi?.facts).toMatchObject({
        currentSongTime: beat,
        clipLaunchQuantization: expected,
      });
      await driver.cleanup(context);
      expect(mocks.send).not.toHaveBeenCalled();
    },
  );
  it.each([0, null, 4])(
    "rejects observed canonical %s for a source declared One Bar without repair",
    async (observed) => {
      const { preflight } = await midiBaseline();
      preflight.source.settings.launchQuantization = observed;
      context = {
        ...context,
        fixture: {
          ...context.fixture,
          sources: context.fixture.sources!.map((source) => ({
            ...source,
            clipLaunchQuantization: "bar",
          })),
        },
      };
      await driver.launch(context);
      await driver.ready(context);
      await expect(driver.readBaseline(context)).rejects.toThrow();
      await driver.cleanup(context);
      expect(mocks.send).not.toHaveBeenCalled();
      expect(mocks.liveStop).toHaveBeenCalledOnce();
    },
  );
  it("admits declared MIDI content with a stopped remembered slot and retains typed final evidence", async () => {
    const { expected, preflight } = await midiBaseline();
    await driver.launch(context);
    await driver.ready(context);
    const baseline = await driver.readBaseline(context);
    expect(baseline.sources?.midi).toMatchObject({
      source: expected,
      facts: {
        transportPlaying: false,
        currentSongTime: 5.5,
        rememberedSessionClips: 1,
        playingSessionClips: 1,
      },
      midi: { midi: { totalNotes: 4 } },
    });
    expect(baseline.sources?.midi).not.toHaveProperty("loadedMediaPath");
    expect(baseline.sources?.midi?.source).not.toHaveProperty("mediaSha256");
    const observed: Extract<
      MetricAudioObservation["source"],
      { view: "session" }
    > = {
      view: "session",
      kind: "midi",
      target: preflight.source.target,
      clipReference: preflight.source.target.expectedClipReference,
      coordinate: { unit: "beats", iteration: 0, startBeat: 0, endBeat: 4 },
      transport: { startBeat: 5.5, endBeat: 12 },
      clipStartTimeBeats: 8,
      synchronization: "transport-coupled-first-iteration",
    };
    expect(
      observedSessionSource(observed, "listener", baseline.sources!),
    ).toEqual(baseline.sources!.midi);
    for (const patch of [
      { kind: "warped-audio" as const },
      { clipReference: randomUUID() },
      { target: { ...observed.target, sceneIndex: 1 } },
      { target: { ...observed.target, expectedClipName: "Other" } },
      {
        target: {
          ...observed.target,
          track: { ...observed.target.track, index: 1 },
        },
      },
    ])
      expect(() =>
        observedSessionSource(
          { ...observed, ...patch },
          "listener",
          baseline.sources!,
        ),
      ).toThrow();
    expect(() =>
      observedSessionSource(observed, "other-listener", baseline.sources!),
    ).toThrow();
    expect(() =>
      observedSessionSource(observed, "listener", {
        ...baseline.sources,
        duplicate: baseline.sources!.midi!,
      }),
    ).toThrow();
    await driver.submit(
      {
        id: "listen",
        sourceId: "midi",
        message: "Listen",
        timeoutMs: 1000,
        assertions: [{ name: "capture", parameters: {} }],
      },
      context,
    );
    expect(mocks.send).toHaveBeenCalledOnce();
    preflight.instrumentChain.devices[1]!.parameters[0]!.value = 0.75;
    const evidence = await driver.collect(context);
    const preserved = evidence.unchanged.find(
      (entry) => entry.scope === "source-settings",
    )!;
    expect(preserved.afterSha256).toBe(preserved.beforeSha256);
    await driver.cleanup(context);
    expect(mocks.stop).toHaveBeenCalledOnce();
    expect(mocks.liveStop).toHaveBeenCalledOnce();
  });

  it.each([
    "notes",
    "instrument",
    "listener",
    "native-id",
    "native-ambiguous",
    "partial",
    "recording",
    "running",
    "queued",
    "slot",
    "kind",
    "selector",
  ] as const)(
    "blocks MIDI %s preconditions without submission and cleans owned hosts",
    async (change) => {
      const { preflight, connection, snapshot } = await midiBaseline();
      if (change === "notes") preflight.midi.notes[0]!.pitch++;
      if (change === "instrument")
        preflight.instrumentChain.devices[0]!.parameters[0]!.value = 0.7;
      if (change === "listener") connection.device.id = randomUUID();
      if (change === "native-id") connection.device.id = "unknown";
      if (change === "native-ambiguous") {
        connection.device.id = "2140";
        const listener = snapshot.devices![1]!;
        snapshot.devices!.push({ ...listener, id: randomUUID(), index: 2 });
      }
      if (change === "partial") preflight.midi.truncated = true;
      if (change === "recording")
        preflight.recording.state.sessionRecord = true;
      if (change === "running") preflight.source.after.transportPlaying = true;
      if (change === "queued") preflight.source.after.targetTriggered = true;
      if (change === "slot") preflight.source.after.playingSlotIndex = 1;
      if (change === "kind") snapshot.sessionClips![0]!.kind = "audio";
      if (change === "selector") preflight.midi.clip.name = "Other clip";
      await driver.launch(context);
      await driver.ready(context);
      await expect(driver.readBaseline(context)).rejects.toThrow();
      await driver.cleanup(context);
      expect(mocks.send).not.toHaveBeenCalled();
      expect(mocks.stop).toHaveBeenCalledOnce();
      expect(mocks.liveStop).toHaveBeenCalledOnce();
    },
  );
  it.each(["notes", "instrument", "topology"] as const)(
    "detects protected MIDI %s mutations before subsequent submission and final collection",
    async (change) => {
      const { preflight, snapshot } = await midiBaseline();
      await driver.launch(context);
      await driver.ready(context);
      await driver.readBaseline(context);
      if (change === "notes") preflight.midi.notes[0]!.velocity--;
      if (change === "instrument")
        preflight.instrumentChain.devices[0]!.parameters[0]!.value = 0.6;
      if (change === "topology") snapshot.devices![0]!.id = randomUUID();
      await expect(
        driver.submit(
          {
            id: "midi",
            message: "Listen",
            sourceId: "midi",
            timeoutMs: 1000,
            assertions: [{ name: "capture", parameters: {} }],
          },
          context,
        ),
      ).rejects.toThrow();
      if (change !== "topology")
        await expect(driver.collect(context)).rejects.toThrow();
      else {
        const evidence = await driver.collect(context);
        expect(
          evidence.unchanged.some(
            (entry) => entry.beforeSha256 !== entry.afterSha256,
          ),
        ).toBe(true);
      }
      await driver.cleanup(context);
      expect(mocks.send).not.toHaveBeenCalled();
    },
  );
  it.each(["single-trace-count", "combined-count", "bytes"] as const)(
    "still fails closed on History %s overflow and closes its owned hosts",
    async (overflow) => {
      await twoSources();
      await driver.launch(context);
      await driver.ready(context);
      await driver.readBaseline(context);
      api.eventHistory.trace.mockImplementation(async (traceId) => ({
        items: Array.from(
          {
            length:
              overflow === "single-trace-count"
                ? 10001
                : overflow === "combined-count"
                  ? 2501
                  : 1,
          },
          (_, index) => ({
            id: `${traceId}-${index}`,
            sequence: index,
            name: "controlled.event",
            attributes:
              overflow === "bytes"
                ? { text: "x".repeat(32 * 1024 * 1024) }
                : {},
          }),
        ),
      }));
      await expect(driver.collect(context)).rejects.toThrow("evidence bound");
      api.eventHistory.trace.mockResolvedValue({ items: [] });
      await driver.cleanup(context);
      expect(mocks.stop).toHaveBeenCalledOnce();
      expect(mocks.liveStop).toHaveBeenCalledOnce();
    },
  );

  it("retains complete multi-turn History beyond a single-trace inventory without rereading it in cleanup", async () => {
    await twoSources();
    context = {
      ...context,
      scenario: {
        ...context.scenario,
        steps: ["one", "two"].map((id) => ({
          id,
          message: "Inspect",
          timeoutMs: 1000,
          assertions: [],
        })),
      },
    };
    await driver.launch(context);
    await driver.ready(context);
    await driver.readBaseline(context);
    api.eventHistory.trace.mockImplementation(async (traceId) => ({
      items: Array.from({ length: 2501 }, (_, index) => ({
        id: `${traceId}-${index}`,
        sequence: index,
        name: "controlled.event",
        attributes: { token: "ghp_should_be_redacted123456789012345678901234" },
      })),
    }));
    await driver.collect(context);
    const reads = api.eventHistory.trace.mock.calls.length;
    await driver.cleanup(context);
    expect(api.eventHistory.trace).toHaveBeenCalledTimes(reads);
    const text = await readFile(
      join(directory, "product-evidence.json"),
      "utf8",
    );
    const evidence = JSON.parse(text) as { history: { id: string }[] };
    expect(evidence.history).toHaveLength(12505);
    expect(
      new Set(evidence.history.map((event: { id: string }) => event.id)).size,
    ).toBe(12505);
    expect(text).not.toContain("ghp_should_be_redacted");
    expect(mocks.stop).toHaveBeenCalledOnce();
    expect(mocks.liveStop).toHaveBeenCalledOnce();
  });

  it("admits independently hashed sources and selects B without borrowing A's identity", async () => {
    const { a, b } = await twoSources();
    await driver.launch(context);
    await driver.ready(context);
    const baseline = await driver.readBaseline(context);
    expect(baseline.sources).toMatchObject({
      a: {
        source: {
          trackId: a.trackId,
          clipId: a.clipId,
          mediaSha256: a.mediaSha256,
        },
        listenerId: "listener-0",
      },
      b: {
        source: {
          trackId: b.trackId,
          clipId: b.clipId,
          mediaSha256: b.mediaSha256,
        },
        listenerId: "listener-1",
      },
    });
    expect(a.mediaSha256).not.toBe(b.mediaSha256);
    a.sourceState.playingSlotIndex = -2;
    b.sourceState.playingSlotIndex = -2;
    await driver.submit(
      {
        id: "listen-b",
        sourceId: "b",
        message: "Listen to Source 2.",
        timeoutMs: 1000,
        assertions: [{ name: "capture", parameters: {} }],
      },
      context,
    );
    expect(mocks.send).toHaveBeenCalledTimes(1);
    await driver.cleanup(context);
  });
  it.each([
    "playing",
    "queued",
    "nonzero",
    "listener-replaced",
    "media-changed",
    "cancelled",
  ])(
    "never repairs or submits a capture when the between-pass state is %s",
    async (kind) => {
      const { b, connections } = await twoSources();
      await driver.launch(context);
      await driver.ready(context);
      await driver.readBaseline(context);
      if (kind === "playing") b.sourceState.transportPlaying = true;
      if (kind === "queued") b.sourceState.targetTriggered = true;
      if (kind === "nonzero") b.sourceState.globalBeat = 4;
      if (kind === "media-changed") await writeFile(b.mediaPath, "changed");
      if (kind === "listener-replaced") {
        api.outputs.list.mockResolvedValue({
          activeSessionId: identity.appSessionId,
          connections: connections.map((connection, index) => ({
            ...connection,
            instanceId: index === 1 ? "replacement" : connection.instanceId,
          })),
        });
      }
      await expect(
        driver.submit(
          {
            id: "listen-b",
            sourceId: "b",
            message: "Listen to Source 2.",
            timeoutMs: 1000,
            assertions: [{ name: "capture", parameters: {} }],
          },
          kind === "cancelled"
            ? { ...context, signal: AbortSignal.abort() }
            : context,
        ),
      ).rejects.toThrow();
      expect(mocks.send).not.toHaveBeenCalled();
      await driver.cleanup(context);
      expect(mocks.stop).toHaveBeenCalled();
      expect(mocks.liveStop).toHaveBeenCalled();
    },
  );
  it.each(["false", "true", "missing"])(
    "uses exact saved follow-action evidence when Live 11 reports unknown: %s",
    async (value) => {
      await audioBaseline();
      const original =
        api.ableton.inspectSessionListeningPreflight.getMockImplementation()!;
      api.ableton.inspectSessionListeningPreflight.mockImplementation(
        async (request) => {
          const observed = await original(request);
          return {
            ...observed,
            source: {
              ...observed.source,
              settings: {
                ...observed.source.settings,
                followActionEnabled: null,
              },
            },
          };
        },
      );
      const flag =
        value === "missing" ? "" : `<FollowActionEnabled Value="${value}"/>`;
      await writeFile(
        context.stagedFixture!.projectPath,
        gzipSync(
          `<Ableton Version="11"><LiveSet><Tracks><AudioTrack><DeviceChain><MainSequencer><ClipSlotList><ClipSlot><ClipSlot><Value><AudioClip><FollowAction>${flag}</FollowAction></AudioClip></Value></ClipSlot></ClipSlot></ClipSlotList></MainSequencer></DeviceChain></AudioTrack></Tracks></LiveSet></Ableton>`,
        ),
      );
      await driver.launch(context);
      await driver.ready(context);
      if (value === "false") {
        const baseline = await driver.readBaseline(context);
        expect(baseline.facts.followActionsEnabled).toBe(false);
        expect(baseline.facts.followActionEvidence).toMatch(
          /^saved-set:[a-f0-9]{64}$/u,
        );
      } else await expect(driver.readBaseline(context)).rejects.toThrow();
      expect(mocks.send).not.toHaveBeenCalled();
      await driver.cleanup(context);
    },
  );
  it("waits for its automation endpoint after agent readiness without accepting another process", async () => {
    await driver.launch(context);
    const path = join(directory, "profile/automation-endpoint.json");
    const descriptor = await readFile(path);
    await rm(path);
    let checks = 0;
    api.lifecycle.get.mockImplementation(async () => {
      if (++checks === 2) await writeFile(path, descriptor);
      return "ready";
    });
    expect(await driver.ready(context)).toEqual(identity);
    expect(checks).toBe(2);
    await driver.cleanup(context);
  });
  it("waits for Remote Script readiness before starting Desktop's initial connection", async () => {
    await driver.launch(context);
    expect(mocks.liveReady.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.launch.mock.invocationCallOrder[0]!,
    );
    await driver.cleanup(context);
  });
  it("paces only an explicitly selected owned bridge and retains diagnostic provenance", async () => {
    driver = new PackagedAcceptanceDriver({
      runDirectory: directory,
      bridgeReadMinimumMs: 550,
    });
    await driver.launch(context);
    expect(mocks.bridgeOptions).toHaveBeenCalledWith({ minimumReadMs: 550 });
    expect(mocks.liveReady.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.bridgeStart.mock.invocationCallOrder[0]!,
    );
    expect(mocks.bridgeStart.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.launch.mock.invocationCallOrder[0]!,
    );
    const storage = resolveLiveAgentStorage({
      environment: {
        LIVE_AGENT_HOME: join(directory, "profile/live-agent"),
        LIVE_AGENT_PROFILE: "automation",
      },
    });
    const preferences: unknown = JSON.parse(
      await readFile(storage.preferencesPath, "utf8"),
    );
    expect(preferences).toMatchObject({ abletonPort: 54321 });
    await driver.cleanup(context);
    expect(mocks.bridgeClose).toHaveBeenCalledOnce();
    const receipt: unknown = JSON.parse(
      await readFile(join(directory, "product-evidence.json"), "utf8"),
    );
    expect(receipt).toMatchObject({
      runId: context.runId,
      scenarioId: context.scenario.id,
      traceId: context.traceId,
      provenance: {
        bridgeReadMinimumMs: 550,
        bridgeTimingMode: "read-response-minimum",
      },
      bridgeTiming: { records: [] },
    });
  });
  it("rejects an unused timing proxy before submitting the user message", async () => {
    driver = new PackagedAcceptanceDriver({
      runDirectory: directory,
      bridgeReadMinimumMs: 550,
    });
    await driver.launch(context);
    await expect(
      driver.submit(
        {
          id: "turn",
          message: "listen to clip-1",
          timeoutMs: 1000,
          assertions: [],
        },
        context,
      ),
    ).rejects.toThrow("no completed paced read");
    expect(mocks.send).not.toHaveBeenCalled();
    await driver.cleanup(context);
  });
  it("fails closed on timing-proxy errors while still closing both owned applications", async () => {
    driver = new PackagedAcceptanceDriver({
      runDirectory: directory,
      bridgeReadMinimumMs: 550,
    });
    await driver.launch(context);
    mocks.bridgeSnapshot.mockReturnValue({
      failure: "bounded queue exceeded",
      records: [],
    });
    await expect(driver.readBaseline(context)).rejects.toThrow(
      "Bridge timing diagnostic failed",
    );
    await expect(driver.cleanup(context)).rejects.toThrow(
      "Acceptance cleanup failed",
    );
    expect(mocks.bridgeClose).toHaveBeenCalled();
    expect(mocks.stop).toHaveBeenCalled();
    expect(mocks.liveStop).toHaveBeenCalled();
  });
  it("does not launch Desktop when the owned Remote Script never becomes ready", async () => {
    mocks.liveReady.mockRejectedValue(new Error("bridge readiness timeout"));
    await expect(driver.launch(context)).rejects.toThrow("bridge readiness");
    expect(mocks.launch).not.toHaveBeenCalled();
    await driver.cleanup(context);
    expect(mocks.liveStop).toHaveBeenCalled();
  });
  it("does not launch Desktop after cancellation during bridge startup", async () => {
    const controller = new AbortController();
    mocks.liveReady.mockImplementation(async () => controller.abort());
    await expect(
      driver.launch({ ...context, signal: controller.signal }),
    ).rejects.toThrow();
    expect(mocks.launch).not.toHaveBeenCalled();
    await driver.cleanup(context);
    expect(mocks.liveStop).toHaveBeenCalled();
  });
  it("reports a bridge prerequisite failure rather than waiting for a listener", async () => {
    api.ableton.getStatus.mockResolvedValue({
      state: "error",
      code: "connection_failed",
    });
    await driver.launch(context);
    await expect(driver.ready(context)).rejects.toThrow(
      "Live connection prerequisite: connection_failed",
    );
    expect(mocks.send).not.toHaveBeenCalled();
    await driver.cleanup(context);
  });
  it.each(["missing-device", "wrong-track", "extra-listener"])(
    "denies %s before submission and cleans up its hosts",
    async (kind) => {
      context = {
        ...context,
        fixture: {
          ...context.fixture,
          dependencies: ["machine-listening"],
          listenerBindings: [listenerBinding],
        },
      };
      const listener = {
        state: "connected",
        signalKind: "audio",
        producerId: "listener-1",
        track: { index: kind === "wrong-track" ? 1 : 0 },
        ...(kind === "missing-device" ? {} : { device: { id: "2140" } }),
      };
      api.outputs.list.mockResolvedValue({
        activeSessionId: identity.appSessionId,
        connections:
          kind === "extra-listener"
            ? [listener, { ...listener, producerId: "listener-2" }]
            : [listener],
      });
      await driver.launch(context);
      await expect(driver.ready(context)).rejects.toThrow("listener inventory");
      expect(mocks.send).not.toHaveBeenCalled();
      await driver.cleanup(context);
      expect(mocks.liveStop).toHaveBeenCalled();
      expect(mocks.stop).toHaveBeenCalled();
    },
  );
  it("cancels missing-listener discovery without submitting and cleans up", async () => {
    context = {
      ...context,
      fixture: {
        ...context.fixture,
        dependencies: ["machine-listening"],
        listenerBindings: [listenerBinding],
      },
    };
    await driver.launch(context);
    await expect(
      driver.ready({ ...context, signal: AbortSignal.timeout(10) }),
    ).rejects.toThrow();
    expect(mocks.send).not.toHaveBeenCalled();
    await driver.cleanup(context);
    expect(mocks.liveStop).toHaveBeenCalled();
    expect(mocks.stop).toHaveBeenCalled();
  });
  it.each(["baseline", "flatness", "flatness-denied", "flatness-cancelled"])(
    "binds raw Max identities and limits loaded-binary proof to flatness: %s",
    async (mode) => {
      await audioBaseline();
      const snapshot = liveSetSnapshotSchema.parse(
        await api.ableton.requestSnapshot(),
      );
      const track = snapshot.tracks[0]!;
      api.ableton.requestSnapshot.mockResolvedValue(
        liveSetSnapshotSchema.parse({
          ...snapshot,
          devices: [
            {
              id: randomUUID(),
              trackId: track.id,
              trackIndex: 0,
              index: 0,
              name: "Listener",
              className: "MxDeviceAudioEffect",
              classDisplayName: "Max Audio Effect",
              enabled: true,
              parameterCount: 1,
              canHaveChains: false,
              canHaveDrumPads: false,
            },
          ],
        }),
      );
      context = {
        ...context,
        scenario: {
          ...context.scenario,
          id:
            mode === "baseline"
              ? context.scenario.id
              : "session-flucoma-flatness-smoke",
        },
        fixture: {
          ...context.fixture,
          dependencies: ["machine-listening"],
          listenerBindings: [
            {
              slot: "AudioTrack:175/DeviceChain/DeviceChain/Devices/MxDeviceAudioEffect:0",
              sourcePath: "Presets/Listener.amxd",
              dependency: "machine-listening",
              trackIndex: 0,
              deviceIndex: 0,
            },
          ],
        },
      };
      api.outputs.list.mockResolvedValue({
        activeSessionId: identity.appSessionId,
        connections: [
          {
            state: "connected",
            signalKind: "audio",
            producerId: "listener-1",
            track: { id: "2141", index: 0, name: track.name },
            device: { id: "2140", name: "Listener" },
          },
        ],
      });
      mocks.loading.mockResolvedValue({
        activeCandidateVerified: true,
        activeNodePids: "1234",
        activeFrozenSha256: "c".repeat(64),
      });
      mocks.flatnessLoading.mockResolvedValue({
        flatnessLoadedBinaryVerified: true,
        flatnessLoadedBinarySchema: "owned-mapped-flucoma/v1",
        flatnessLoadedBinaryPath:
          "/owned/frozen/dependencies/flucoma/fluid.spectralshape~.mxo/Contents/MacOS/fluid.spectralshape~",
        flatnessLoadedBinarySha256: "d".repeat(64),
        flatnessLoadedBinaryPids: "98766",
        flatnessLoadedBinaryInode: "123",
        flatnessLoadedBinaryDevice: "456",
      });
      if (mode === "flatness-denied")
        mocks.flatnessLoading.mockRejectedValue(
          new Error("Mapped flatness binary is not the pinned staged identity"),
        );
      if (mode === "flatness-cancelled")
        mocks.flatnessLoading.mockRejectedValue(
          new DOMException("Aborted", "AbortError"),
        );
      await driver.launch(context);
      await driver.ready(context);
      if (mode === "flatness-denied" || mode === "flatness-cancelled") {
        await expect(driver.readBaseline(context)).rejects.toThrow();
        expect(mocks.send).not.toHaveBeenCalled();
        await driver.cleanup(context);
        const evidence: unknown = JSON.parse(
          await readFile(join(directory, "product-evidence.json"), "utf8"),
        );
        expect(evidence).toMatchObject({
          provenance: {
            flatnessLoadedBinaryVerified: false,
            flatnessLoadedBinaryState:
              mode === "flatness-denied" ? "failed" : "cancelled",
            flatnessLoadedBinaryError:
              "owned-loader-proof-unavailable-or-mismatched",
            flatnessLoadedBinaryDurationMs: expect.any(Number) as unknown,
          },
        });
        expect(mocks.liveStop).toHaveBeenCalled();
        return;
      }
      const baseline = await driver.readBaseline(context);
      expect(baseline.sources?.a?.source.trackId).toBe(track.id);
      expect(baseline.sources?.a?.source.trackId).not.toBe("2141");
      expect(baseline.sources?.a?.listenerId).toBe("listener-1");
      expect(baseline.facts.activeCandidateVerified).toBe(true);
      if (mode === "flatness") {
        expect(mocks.flatnessLoading).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            live: { pid: 98766, owned: true },
            activeNodePids: "1234",
            workingDirectory: context.stagedFixture!.workingDirectory,
          }),
        );
        expect(baseline.facts).toMatchObject({
          flatnessLoadedBinaryVerified: true,
          flatnessLoadedBinaryState: "completed",
        });
      } else expect(mocks.flatnessLoading).not.toHaveBeenCalled();
      await driver.cleanup(context);
    },
  );
  it("requires reviewed listener bindings before provisioning or launching", async () => {
    context = {
      ...context,
      fixture: { ...context.fixture, dependencies: ["machine-listening"] },
    };
    await expect(driver.provision(context)).rejects.toThrow(
      "reviewed saved listener",
    );
    expect(mocks.provision).not.toHaveBeenCalled();
    expect(mocks.liveLaunch).not.toHaveBeenCalled();
  });
  it("launches only the derived Set and fails baseline before submission when active candidate proof fails", async () => {
    context = {
      ...context,
      fixture: {
        ...context.fixture,
        dependencies: ["machine-listening"],
        listenerBindings: [
          {
            slot: "AudioTrack:175/DeviceChain/DeviceChain/Devices/MxDeviceAudioEffect:0",
            sourcePath: "Presets/Listener.amxd",
            dependency: "machine-listening",
            trackIndex: 0,
            deviceIndex: 0,
          },
        ],
      },
    };
    mocks.provision.mockResolvedValue({
      hashes: { "machine-listening": "a".repeat(64) },
      inventory: {
        schemaVersion: 1,
        candidateRoot: "/candidate",
        resources: [],
        preparedProject: {
          target: "prepared.als",
          bytes: 1,
          sha256: "b".repeat(64),
        },
      },
    });
    await writeFile(
      join(directory, "prepared.als"),
      "controlled derived fixture",
    );
    api.ableton.requestSnapshot.mockResolvedValue(
      liveSetSnapshotSchema.parse({
        liveSetId: "test",
        liveSetName: "prepared",
        tempo: 120,
        timeSignature: "4/4",
        tracks: [],
        devices: [
          {
            id: randomUUID(),
            trackId: randomUUID(),
            trackIndex: 0,
            index: 0,
            name: "Listener",
            className: "MxDeviceAudioEffect",
            classDisplayName: "Max Audio Effect",
            enabled: true,
            parameterCount: 1,
            canHaveChains: false,
            canHaveDrumPads: false,
          },
        ],
      }),
    );
    mocks.loading.mockRejectedValue(new Error("active runtime mismatch"));
    await driver.launch(context);
    expect(mocks.liveLaunch).toHaveBeenCalledWith(
      "/Applications/Ableton Live 11 Suite.app",
      30000,
      { fixturePath: join(directory, "prepared.als"), signal: context.signal },
    );
    await expect(driver.readBaseline(context)).rejects.toThrow(
      "active runtime mismatch",
    );
    expect(mocks.loading).toHaveBeenCalledTimes(1);
    expect(mocks.send).not.toHaveBeenCalled();
    await driver.cleanup(context);
    expect(mocks.liveStop).toHaveBeenCalled();
  });
  it.each(["reviewed", "wrong-arguments", "foreign-turn", "incomplete"])(
    "enforces scoped approvals through the real adapter: %s",
    async (mode) => {
      context = {
        ...context,
        scenario: {
          ...context.scenario,
          permissions: [
            {
              tool: "listen",
              action: "session",
              risk: "medium",
              maxUses: 1,
              arguments: { action: "session", beats: 4 },
            },
          ],
        },
      };
      await driver.launch(context);
      await driver.ready(context);
      const subscription = await driver.subscribe();
      const submission = await driver.submit(
        { id: "turn", message: "Listen", timeoutMs: 1000, assertions: [] },
        context,
      );
      const approvalId = randomUUID();
      const event = {
        type: "approval.requested",
        operationId:
          mode === "foreign-turn" ? randomUUID() : submission.operationId,
        appSessionId: identity.appSessionId,
        agentInstanceId: identity.agentId,
        sdkSessionId: identity.conversationId,
        approval: {
          id: approvalId,
          title: "Listen",
          risk: "medium",
          summary: "Not an oracle",
          changes: [],
          destructive: false,
          tool: {
            name: "listen",
            action: "session",
            arguments: {
              action: "session",
              beats: mode === "wrong-arguments" ? 8 : 4,
            },
            argumentsComplete: mode !== "incomplete",
          },
        },
      };
      const emit = mocks.subscriber.mock.calls[0]![0];
      emit(event);
      const repeatedId = randomUUID();
      if (mode === "reviewed")
        emit({ ...event, approval: { ...event.approval, id: repeatedId } });
      await expect(
        subscription.waitForTurn(submission, context),
      ).rejects.toThrow(
        mode === "foreign-turn"
          ? "pending turn ownership"
          : "no reviewed scoped rule",
      );
      if (mode === "foreign-turn")
        expect(api.approvals.resolve).not.toHaveBeenCalled();
      else if (mode === "reviewed") {
        expect(api.approvals.resolve).toHaveBeenNthCalledWith(
          1,
          approvalId,
          "approve",
        );
        expect(api.approvals.resolve).toHaveBeenNthCalledWith(
          2,
          repeatedId,
          "deny",
        );
      } else
        expect(api.approvals.resolve).toHaveBeenCalledWith(approvalId, "deny");
      await driver.cleanup(context);
    },
  );
  it.each([
    "media/resource-001.wav",
    "Samples/Imported/resource-001.wav",
    "Samples/Recorded/resource-001.wav",
  ])(
    "binds independently inspected media at %s to the owned staged file",
    async (target) => {
      const source = await audioBaseline(target);
      await driver.launch(context);
      await driver.ready(context);
      expect(await driver.readBaseline(context)).toMatchObject({
        sources: {
          a: {
            loadedMediaPath: source.mediaPath,
            source: {
              trackId: source.trackId,
              clipId: source.clipId,
              mediaSha256: source.mediaSha256,
            },
          },
        },
        facts: { recording: false, mediaSampleRate: 48000 },
      });
      const mediaFingerprint = createHash("sha256")
        .update(JSON.stringify([{ target, sha256: source.mediaSha256 }]))
        .digest("hex");
      expect((await driver.collect(context)).unchanged).toContainEqual({
        scope: "fixture-media",
        beforeSha256: mediaFingerprint,
        afterSha256: mediaFingerprint,
      });
      await driver.cleanup(context);
    },
  );

  it.each(["arrangementRecord", "sessionRecord"] as const)(
    "blocks global %s even when the target is not recording",
    async (flag) => {
      const source = await audioBaseline();
      source.recording[flag] = true;
      await driver.launch(context);
      await driver.ready(context);
      await expect(driver.readBaseline(context)).rejects.toThrow(
        "Blocked source precondition: a.recording",
      );
      await driver.cleanup(context);
    },
  );

  it.each([
    ["none", 0, 0],
    ["bar", 4, 0],
    ["none", 0, 5.5],
    ["bar", 4, 5.5],
  ] as const)(
    "independently admits stopped %s (%s) at beat %s without repairing state",
    async (globalQuantization, wireQuantization, currentSongTime) => {
      const source = await audioBaseline();
      source.settings.globalQuantization = wireQuantization;
      source.sourceState.globalBeat = currentSongTime;
      context = {
        ...context,
        fixture: {
          ...context.fixture,
          baseline: {
            ...context.fixture.baseline,
            globalQuantization,
            currentSongTime,
          },
        },
      };
      await driver.launch(context);
      await driver.ready(context);
      const baseline = await driver.readBaseline(context);
      expect(baseline.facts).toMatchObject({
        globalQuantization,
        currentSongTime,
        transportPlaying: false,
      });
      expect(baseline.sources?.a?.facts).toMatchObject({
        globalQuantization,
        currentSongTime,
      });
      expect(source.settings.globalQuantization).toBe(wireQuantization);
      expect(source.sourceState.globalBeat).toBe(currentSongTime);
      expect(mocks.send).not.toHaveBeenCalled();
      await driver.cleanup(context);
      expect(mocks.stop).toHaveBeenCalledOnce();
      expect(mocks.liveStop).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { globalBeat: 5.5 },
    { globalBeat: null },
    { transportPlaying: true },
    { targetPlaying: true },
    { targetTriggered: true },
    { targetRecording: true },
    { playingSlotIndex: 0 },
    { firedSlotIndex: 0 },
    { firedSlotIndex: null },
  ])(
    "blocks inconsistent or unsafe initial source brackets: %j",
    async (patch) => {
      await audioBaseline();
      const read =
        api.ableton.inspectSessionListeningPreflight.getMockImplementation()!;
      api.ableton.inspectSessionListeningPreflight.mockImplementation(
        async (request) => {
          const value = await read(request);
          return {
            ...value,
            source: {
              ...value.source,
              before: { ...value.source.before, ...patch },
            },
          };
        },
      );
      await driver.launch(context);
      await driver.ready(context);
      await expect(driver.readBaseline(context)).rejects.toThrow(
        "Blocked source precondition",
      );
      expect(mocks.send).not.toHaveBeenCalled();
      await driver.cleanup(context);
      expect(mocks.stop).toHaveBeenCalledOnce();
      expect(mocks.liveStop).toHaveBeenCalledOnce();
    },
  );

  it.each([
    "unknown-recording",
    "missing-path",
    "missing-sample-rate",
    "foreign-path",
    "changed-bytes",
  ])(
    "never substitutes expected metadata for missing or foreign evidence: %s",
    async (fault) => {
      const source = await audioBaseline();
      if (fault === "unknown-recording")
        source.sourceState.targetRecording = null;
      if (fault === "missing-path") source.audio.filePath = null;
      if (fault === "missing-sample-rate") source.audio.sampleRate = null;
      if (fault === "foreign-path")
        source.audio.filePath = join(directory, "catalog-original.wav");
      if (fault === "changed-bytes")
        await writeFile(source.mediaPath, "wrong sample");
      await driver.launch(context);
      await driver.ready(context);
      await expect(driver.readBaseline(context)).rejects.toThrow();
      expect(mocks.send).not.toHaveBeenCalled();
      await driver.cleanup(context);
    },
  );
  it.each(["valid", "changed", "missing"] as const)(
    "checks declared Core Library bytes before provisioning or launch: %s",
    async (state) => {
      const live = join(directory, "Live.app");
      const path = "Samples/kick.wav";
      const data = Buffer.from("licensed test sample");
      const declared = [
        {
          path,
          bytes: data.length,
          sha256: createHash("sha256").update(data).digest("hex"),
        },
      ];
      const samples = join(live, "Contents/App-Resources/Core Library/Samples");
      await mkdir(samples, { recursive: true });
      if (state !== "missing")
        await writeFile(
          join(samples, "kick.wav"),
          state === "valid" ? data : Buffer.alloc(data.length),
        );
      context = {
        ...context,
        fixture: { ...context.fixture, coreLibraryResources: declared },
      };
      driver = new PackagedAcceptanceDriver({
        runDirectory: directory,
        liveApplicationPath: live,
      });
      if (state === "valid") {
        await driver.provision(context);
        expect(mocks.project.mock.calls[0]?.[4]).toEqual(declared);
        expect(mocks.provision).toHaveBeenCalledOnce();
      } else {
        await expect(driver.provision(context)).rejects.toThrow(
          state === "changed" ? "hash mismatch" : "ENOENT",
        );
        expect(mocks.provision).not.toHaveBeenCalled();
      }
      expect(mocks.launch).not.toHaveBeenCalled();
      expect(mocks.liveLaunch).not.toHaveBeenCalled();
      await driver.cleanup(context);
    },
  );
  it("provisions explicitly before launch and never provisions a case twice", async () => {
    const inventory = await driver.provision(context);
    expect(inventory).toMatchObject({ schemaVersion: 1, resources: [] });
    expect(mocks.launch).not.toHaveBeenCalled();
    expect(mocks.liveLaunch).not.toHaveBeenCalled();
    await driver.launch(context);
    expect(mocks.provision).toHaveBeenCalledOnce();
    await expect(
      driver.provision({ ...context, runId: randomUUID() }),
    ).rejects.toThrow("independent cases");
    await driver.cleanup(context);
  });

  it("rejects unsupported audio baselines before touching either host", async () => {
    await expect(
      driver.provision({
        ...context,
        scenario: {
          ...context.scenario,
          requiredCapabilities: ["automation", "session-audio"],
        },
      }),
    ).rejects.toThrow("Unsupported audio baseline");
    expect(mocks.preexisting).not.toHaveBeenCalled();
    expect(mocks.launch).not.toHaveBeenCalled();
    expect(mocks.liveLaunch).not.toHaveBeenCalled();
  });

  it("waits for the active App session before querying agents", async () => {
    await driver.launch(context);
    api.agent.getSessions.mockResolvedValueOnce([]);
    expect(await driver.ready(context)).toEqual(identity);
    expect(api.agent.getSessions).toHaveBeenCalledTimes(2);
    expect(api.agents.listActive).toHaveBeenCalledTimes(1);
    await driver.cleanup(context);
  });

  it("uses the packaged candidate, normal approvals and exact owned process cleanup", async () => {
    await driver.launch(context);
    expect(await driver.ready(context)).toEqual(identity);
    expect(mocks.launch.mock.calls[0]?.[0]).toMatchObject({
      args: [
        "--automation",
        "--automation-profile",
        join(directory, "profile"),
        "--automation-descriptor",
        join(directory, "profile/automation-endpoint.json"),
        "--automation-agent",
        "default",
      ],
    });
    const submission = await driver.submit(
      { id: "turn", message: "Say hello", timeoutMs: 1000, assertions: [] },
      context,
    );
    expect(submission).toEqual({
      ...identity,
      userMessageId,
      operationId: userMessageId,
    });
    expect(mocks.send).toHaveBeenCalledOnce();
    expect(mocks.send.mock.calls[0]![0]).toMatchObject({
      message: "Say hello",
      expectedTarget: {
        appSessionId: identity.appSessionId,
        agentInstanceId: identity.agentId,
        sdkSessionId: identity.conversationId,
      },
      trace: { traceId: context.traceId, correlationId: context.correlationId },
    });
    await driver.cleanup(context);
    expect(mocks.stop).toHaveBeenCalledWith(application);
    expect(mocks.liveStop).toHaveBeenCalledOnce();
    await expect(
      readFile(join(directory, "profile/automation-endpoint.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const evidence: unknown = JSON.parse(
      await readFile(join(directory, "product-evidence.json"), "utf8"),
    );
    expect(evidence).toMatchObject({ provenance: { liveVersion: "11.3.43" } });
  });

  it("refuses a pre-existing user Live process without launching anything", async () => {
    mocks.preexisting.mockRejectedValue(new Error("User Live is running"));
    await expect(driver.launch(context)).rejects.toThrow("User Live");
    expect(mocks.liveLaunch).not.toHaveBeenCalled();
    expect(mocks.launch).not.toHaveBeenCalled();
  });

  it("rejects synthetic fixtures before touching a host", async () => {
    await expect(
      driver.launch({
        ...context,
        fixture: { ...context.fixture, qualification: "synthetic-only" },
      }),
    ).rejects.toThrow("Synthetic");
    expect(mocks.preexisting).not.toHaveBeenCalled();
    expect(mocks.launch).not.toHaveBeenCalled();
  });

  it("cleans up partially launched applications after candidate admission fails", async () => {
    application.evaluate.mockResolvedValue({
      packaged: false,
      path: "/source",
      resources: "/candidate/Contents/Resources",
      args: [],
    });
    await expect(driver.launch(context)).rejects.toThrow("packaged production");
    await driver.cleanup(context);
    expect(mocks.stop).toHaveBeenCalledWith(application);
    expect(mocks.liveStop).toHaveBeenCalledOnce();
  });

  it("denies missing authentication and modified agents without sending a message", async () => {
    await driver.launch(context);
    api.agents.getAuthStatus.mockResolvedValue({ state: "unauthenticated" });
    await expect(driver.ready(context)).rejects.toThrow(
      "authentication prerequisite",
    );
    api.agents.getAuthStatus.mockResolvedValue({ state: "authenticated" });
    const agent = (await api.agents.listActive())[0]!;
    api.agents.listActive.mockResolvedValue([{ ...agent, autoApprove: true }]);
    await expect(driver.ready(context)).rejects.toThrow("normal approvals");
    expect(mocks.send).not.toHaveBeenCalled();
    await driver.cleanup(context);
  });

  it("does not erase a profile while its owned app failed to stop", async () => {
    await driver.launch(context);
    mocks.stop.mockResolvedValue({
      stopped: false,
      successful: false,
      events: [],
    });

    await expect(driver.cleanup(context)).rejects.toThrow(
      "Acceptance cleanup failed",
    );
    expect(
      await readFile(
        join(directory, "profile/automation-endpoint.json"),
        "utf8",
      ),
    ).toContain("98765");
    expect(mocks.liveStop).toHaveBeenCalledOnce();
  });

  it("persists the specific teardown failure and separately confirms resource reclamation", async () => {
    await driver.launch(context);
    mocks.stop.mockResolvedValue({
      stopped: true,
      successful: false,
      events: [
        {
          stage: "close",
          status: "timed-out",
          at: 10,
          durationMs: 3000,
          reason: "deadline",
        },
      ],
    });
    await expect(driver.cleanup(context)).rejects.toThrow(
      "desktop-stop: Desktop cleanup failed: Owned Desktop shutdown failed: close timed-out (deadline)",
    );
    const evidence: unknown = JSON.parse(
      await readFile(join(directory, "cleanup-evidence.json"), "utf8"),
    );
    expect(evidence).toMatchObject({
      schema: "acceptance-cleanup/v1",
      runId: context.runId,
      scenarioId: context.scenario.id,
      resources: {
        desktopStopped: true,
        liveStopped: true,
        hostReservationClosed: true,
        profileRemoved: true,
      },
      failures: [
        {
          stage: "desktop-stop",
          message:
            "Desktop cleanup failed: Owned Desktop shutdown failed: close timed-out (deadline)",
        },
      ],
    });
  });

  it("never submits an already-cancelled turn", async () => {
    await driver.launch(context);
    await driver.ready(context);
    const abort = new AbortController();
    abort.abort();
    await expect(
      driver.submit(
        { id: "turn", message: "No", timeoutMs: 1000, assertions: [] },
        { ...context, signal: abort.signal },
      ),
    ).rejects.toThrow();
    expect(mocks.send).not.toHaveBeenCalled();
    await driver.cleanup(context);
  });

  it("retains producer discovery while Live shutdown is unconfirmed", async () => {
    await driver.launch(context);
    mocks.liveStop.mockRejectedValue(new Error("Owned Live did not stop"));
    await expect(driver.cleanup(context)).rejects.toThrow(
      "Acceptance cleanup failed",
    );
    expect(
      await readFile(
        join(directory, "profile/automation-endpoint.json"),
        "utf8",
      ),
    ).toContain("98765");
  });

  it("closes a preflight-only host reservation after failed provisioning", async () => {
    mocks.provision.mockRejectedValue(
      new Error("candidate dependency missing"),
    );
    await expect(driver.provision(context)).rejects.toThrow();
    mocks.liveRecord.mockReturnValue(undefined);
    await driver.cleanup(context);
    expect(mocks.liveClose).toHaveBeenCalledOnce();
  });

  it("treats uncertain preflight reservation closure as unsafe cleanup", async () => {
    await driver.launch(context);
    mocks.liveClose.mockRejectedValue(new Error("uncertain host acquisition"));
    await expect(driver.cleanup(context)).rejects.toThrow(
      "Acceptance cleanup failed",
    );
    await expect(
      readFile(join(directory, "profile/automation-endpoint.json"), "utf8"),
    ).resolves.toContain("98765");
  });

  it("does not retry a possibly accepted request after a missing acknowledgement", async () => {
    await driver.launch(context);
    await driver.ready(context);
    mocks.send.mockRejectedValue(new Error("Acknowledgement lost"));
    await expect(
      driver.submit(
        { id: "turn", message: "Once", timeoutMs: 1000, assertions: [] },
        context,
      ),
    ).rejects.toThrow("Acknowledgement lost");
    expect(mocks.send).toHaveBeenCalledOnce();
    await driver.cleanup(context);
  });

  it.each(["present", "missing", "duplicate"])(
    "joins exact ingress, assistant and SDK activity (%s), not global idle",
    async (activity) => {
      await driver.launch(context);
      await driver.ready(context);
      const subscription = await driver.subscribe();
      const step = {
        id: "turn",
        message: "Say hello",
        timeoutMs: 1000,
        assertions: [],
      };
      const submission = await driver.submit(step, context);
      const emit = mocks.subscriber.mock.calls[0]![0];
      const sdkTurnId = randomUUID();
      const emitActivity = (activityId: string) =>
        emit({
          type: "agent.working_update",
          messageId: assistantMessageId,
          agentInstanceId: identity.agentId,
          sdkSessionId: identity.conversationId,
          update: {
            kind: "started",
            activityId,
            occurredAt: new Date().toISOString(),
          },
        });
      emit({
        type: "agent.user_message_submitted",
        messageId: userMessageId,
        content: step.message,
        agentInstanceId: identity.agentId,
        agentMode: "interactive",
        origin: "automation",
        timestamp: Date.now(),
        traceId: context.traceId,
        correlationId: context.correlationId,
        causationId: context.causationId,
        turn: {
          assistantMessageId,
          target: {
            appSessionId: identity.appSessionId,
            agentInstanceId: identity.agentId,
            sdkSessionId: identity.conversationId,
          },
        },
      });
      emit({
        type: "agent.message_complete",
        messageId: randomUUID(),
        content: "Unrelated",
        agentInstanceId: identity.agentId,
        sdkSessionId: identity.conversationId,
      });
      emit({
        type: "agent.message_complete",
        messageId: assistantMessageId,
        content: "Hello",
        agentInstanceId: identity.agentId,
        sdkSessionId: identity.conversationId,
      });
      emit({
        type: "operation.changed",
        agentInstanceId: identity.agentId,
        sdkSessionId: identity.conversationId,
        operation: {
          id: userMessageId,
          label: "Turn",
          status: "completed",
          timestamp: Date.now(),
        },
      });
      if (activity !== "missing") emitActivity(sdkTurnId);
      if (activity === "duplicate") emitActivity(randomUUID());
      if (activity === "present") {
        const result = await subscription.waitForTurn(submission, context);
        expect(result).toMatchObject({
          assistantMessageId,
          userMessageId,
          assistantText: "Hello",
          status: "completed",
          captures: [],
          contexts: [],
          facts: { sdkTurnId },
        });
        expect(sdkTurnId).not.toBe(context.traceId);
      } else
        await expect(
          subscription.waitForTurn(submission, context),
        ).rejects.toThrow(
          activity === "missing" ? "no attributable SDK" : "More than one SDK",
        );
      await subscription.close(context);
      await driver.cleanup(context);
    },
  );

  it("rejects a received user event whose attribution changed", async () => {
    await driver.launch(context);
    await driver.ready(context);
    const subscription = await driver.subscribe();
    const submission = await driver.submit(
      { id: "turn", message: "Once", timeoutMs: 1000, assertions: [] },
      context,
    );
    mocks.subscriber.mock.calls[0]![0]({
      type: "agent.user_message_submitted",
      messageId: userMessageId,
      content: "Once",
      agentInstanceId: randomUUID(),
      agentMode: "interactive",
      origin: "automation",
      timestamp: Date.now(),
      traceId: context.traceId,
      correlationId: context.correlationId,
      causationId: context.causationId,
    });
    await expect(subscription.waitForTurn(submission, context)).rejects.toThrow(
      "does not match",
    );
    await driver.cleanup(context);
  });

  it("reads persisted state after restart without requiring a new live listener connection", async () => {
    await driver.launch(context);
    await driver.ready(context);
    await driver.readBaseline(context);
    const restoredContext = {
      ...context,
      signal: AbortSignal.timeout(500),
      scenario: { ...context.scenario, requiredCapabilities: ["persistence"] },
      fixture: { ...context.fixture, listenerBindings: [listenerBinding] },
    };
    const evidence = await driver.collect(restoredContext);
    expect(evidence.facts.persistedContexts).toBe(0);
    expect(mocks.launch).toHaveBeenCalledTimes(2);
    expect(mocks.send).not.toHaveBeenCalled();
    await driver.cleanup(context);
  });

  it("supports a non-listening scenario without inventing media or a listener", async () => {
    await driver.launch(context);
    await driver.ready(context);
    const baseline = await driver.readBaseline(context);
    expect(baseline).toMatchObject({ facts: { tempo: 120, trackCount: 0 } });
    expect(baseline).not.toHaveProperty("source");
    expect(baseline).not.toHaveProperty("listenerId");
    const evidence = await driver.collect(context);
    expect(evidence).toMatchObject({ capturePassIds: [], contexts: [] });
    expect(mocks.launch).toHaveBeenCalledOnce();
    await driver.cleanup(context);
  });
});
