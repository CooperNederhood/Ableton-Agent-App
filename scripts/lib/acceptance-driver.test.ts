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
import type { DriverContext } from "../../packages/test-support/src/integration/contracts.js";
import {
  liveSetSnapshotSchema,
  desktopSessionListeningPreflightSchema,
  type DesktopSessionListeningPreflight,
} from "../../apps/desktop/src/contracts.js";
import { SUPPORTED_AUDIO_BASELINE } from "../../packages/test-support/src/integration/contracts.js";
import type {
  InspectSessionListeningSourceParams,
  InspectSessionListeningSourceResult,
} from "@ableton-agent/protocol";

const mocks = vi.hoisted(() => ({
  launch: vi.fn(),
  stop: vi.fn(),
  liveLaunch: vi.fn(),
  liveStop: vi.fn(),
  preexisting: vi.fn(),
  liveRecord: vi.fn(),
  liveReady: vi.fn(),
  send: vi.fn(),
  provision: vi.fn(),
  project: vi.fn(),
  loading: vi.fn(),
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
vi.mock("../../tests/electron/packaged-paths.js", () => ({
  packagedExecutable: async () => "/candidate/Contents/MacOS/Agent",
  packagedCandidateHash: async () => "0".repeat(64),
  finderLikeEnvironment: () => ({}),
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
  const audio: DesktopSessionListeningPreflight["audio"] = {
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
          settings: {
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
          },
        },
        audio,
        recording: { action: "inspect", state: recording },
      }),
  );
  return {
    audio,
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
      return {
        ...observed,
        audio: { ...observed.audio, name: request.target.expectedClipName },
      };
    },
  );
  return { a, b, connections };
}

describe("packaged acceptance adapter lifecycle (controlled processes)", () => {
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
  it("binds raw Max identities to reviewed slots without equating them to application UUIDs", async () => {
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
    await driver.launch(context);
    await driver.ready(context);
    const baseline = await driver.readBaseline(context);
    expect(baseline.sources?.a?.source.trackId).toBe(track.id);
    expect(baseline.sources?.a?.source.trackId).not.toBe("2141");
    expect(baseline.sources?.a?.listenerId).toBe("listener-1");
    expect(baseline.facts.activeCandidateVerified).toBe(true);
    await driver.cleanup(context);
  });
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
      { fixturePath: join(directory, "prepared.als") },
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
