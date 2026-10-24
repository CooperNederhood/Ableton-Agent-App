import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { stageNativeListeningFixture } from "./native-listening-fixture.mjs";
import { createNativeRunnerLifecycle } from "./native-listening-lifecycle.mjs";
import { waitForNativeBridge } from "./native-bridge-readiness.mjs";
import {
  reviewNativeSessionScenario,
  selectSessionFixtureSource,
} from "./native-session-listening-scenario.mjs";
import {
  nativeSourcePrompt,
  nativeSourceSetupActions,
  nativeSourceTransitions,
  prepareNativeSourceTransition,
  verifyNativeSourceRefusal,
} from "./native-listening-runner-source.mjs";
import {
  insertBeforeNativeListener,
  NATIVE_LISTENER_EDIT,
} from "./native-listener-rebinding.mjs";
import {
  createNativeScenarioApproval,
  inspectNativeListeningPostconditions,
  inspectNativeStoppedPreflight,
  snapshotNativeSessionSource,
  verifyNativeListeningEvidence,
} from "./native-listening-verification.mjs";

export async function loadNativeRunnerServices() {
  const [
    runtime,
    application,
    observability,
    storage,
    shared,
    protocol,
    desktop,
    context,
    contracts,
    credentials,
  ] = await Promise.all([
    import("../../packages/runtime/dist/index.js"),
    import("../../packages/application/dist/index.js"),
    import("../../packages/observability/dist/index.js"),
    import("../../packages/storage/dist/index.js"),
    import("../../packages/shared/dist/index.js"),
    import("../../packages/protocol/dist/index.js"),
    import("../../apps/desktop/dist/main/desktop-service.js"),
    import("../../apps/desktop/dist/main/desktop-session-context.js"),
    import("../../apps/desktop/dist/contracts.js"),
    import("../../apps/desktop/dist/main/signal-credentials.js"),
  ]);
  return {
    ...runtime,
    ...application,
    ...observability,
    ...storage,
    ...shared,
    ...desktop,
    ...context,
    ...contracts,
    ...credentials,
    protocol,
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function selectNativeSessionTarget(snapshot, input, protocol) {
  const index = Number(input.canonicalPath.split(" ")[2]);
  const track = snapshot.tracks.find((item) => item.index === index);
  const clips = snapshot.clips?.filter(
    (clip) => clip.trackIndex === index && clip.sceneIndex === input.sceneIndex,
  );
  assert(
    track?.name === input.trackName &&
      clips?.length === 1 &&
      clips[0].trackReference === track.reference,
    "Immutable Session fixture selector did not resolve one exact track and clip",
  );
  return protocol.inspectSessionListeningSourceParamsSchema.shape.target.parse({
    view: "session",
    track: {
      kind: "regular",
      index,
      expectedReference: track.reference,
      expectedName: track.name,
    },
    sceneIndex: input.sceneIndex,
    expectedClipReference: clips[0].reference,
    expectedClipName: clips[0].name,
  });
}

/** Read every bounded fixture clip/device, including the unselected Session source. */
export async function readNativeSessionFixtureContent({
  ableton,
  snapshot,
  protocol,
}) {
  assert(
    snapshot.trackCount === snapshot.tracks.length &&
      snapshot.tracks.length <= 256 &&
      Array.isArray(snapshot.clips) &&
      snapshot.clips.length > 0 &&
      snapshot.clips.length <= 32 &&
      snapshot.tracks.every(
        (track) =>
          track.devicesTruncated === false && Array.isArray(track.devices),
      ) &&
      snapshot.tracks.reduce(
        (count, track) => count + track.devices.length,
        0,
      ) <= 64,
    "Complete bounded Session fixture clips and devices are required",
  );
  const content = { clips: [], devices: [] };
  for (const track of snapshot.tracks) {
    for (const device of track.devices) {
      const params = protocol.inspectDeviceParametersParamsSchema.parse({
        index: track.index,
        expectedReference: track.reference,
        expectedName: track.name,
        deviceIndex: device.index,
        expectedDeviceReference: device.reference,
        expectedDeviceName: device.name,
        offset: 0,
        limit: 256,
      });
      const value = protocol.inspectDeviceParametersResultSchema.parse(
        await ableton.inspectDeviceParameters(params),
      );
      assert(
        value.device.reference === device.reference &&
          value.device.trackReference === track.reference &&
          value.offset === 0 &&
          value.total === value.parameters.length &&
          value.device.parameterCount === value.total &&
          value.device.canHaveChains === false &&
          value.device.canHaveDrumPads === false,
        "Incomplete, nested or mismatched immutable fixture device content",
      );
      content.devices.push(value);
    }
  }
  for (const clip of snapshot.clips) {
    const track = snapshot.tracks.find(
      (item) => item.index === clip.trackIndex,
    );
    assert(
      track?.reference === clip.trackReference,
      "Session clip changed track association",
    );
    const target =
      protocol.inspectSessionListeningSourceParamsSchema.shape.target.parse({
        view: "session",
        track: {
          kind: "regular",
          index: track.index,
          expectedReference: track.reference,
          expectedName: track.name,
        },
        sceneIndex: clip.sceneIndex,
        expectedClipReference: clip.reference,
        expectedClipName: clip.name,
      });
    const queryId = randomUUID();
    const source = protocol.inspectSessionListeningSourceResultSchema.parse(
      await ableton.inspectSessionListeningSource({
        schemaVersion: 1,
        queryId,
        target,
      }),
    );
    assert(
      source.queryId === queryId && isDeepStrictEqual(source.target, target),
      "Stale or mismatched fixture source content read",
    );
    assert(
      source.sourceKind === (clip.kind === "midi" ? "midi" : "warped-audio") &&
        source.positionUnit === "beats",
      "Fixture must contain inspected MIDI/warped-audio beat sources",
    );
    let body;
    if (clip.kind === "midi") {
      body = protocol.inspectMidiNotesResultSchema.parse(
        await ableton.inspectMidiNotes({
          index: track.index,
          expectedReference: track.reference,
          expectedName: track.name,
          sceneIndex: clip.sceneIndex,
          expectedClipReference: clip.reference,
          offset: 0,
          limit: 2048,
        }),
      );
      assert(
        body.clip.reference === clip.reference &&
          body.offset === 0 &&
          !body.truncated &&
          body.totalNotes === body.notes.length &&
          clip.noteCount === body.totalNotes,
        "Incomplete or mismatched immutable fixture MIDI content",
      );
    } else {
      assert(clip.kind === "audio", "Unknown immutable fixture clip kind");
      const audio = protocol.audioClipsOperationResultSchema.parse(
        await ableton.executeAudioClipsOperation({ action: "inspect", target }),
      );
      const markers = protocol.audioClipsOperationResultSchema.parse(
        await ableton.executeAudioClipsOperation({
          action: "warp-markers",
          target,
          offset: 0,
          limit: 256,
        }),
      );
      assert(
        audio.action === "inspect" &&
          audio.clip.reference === clip.reference &&
          audio.clip.warping === true &&
          audio.clip.gain !== null &&
          audio.clip.pitchCoarse !== null &&
          audio.clip.pitchFine !== null &&
          audio.clip.filePath !== null &&
          audio.clip.sampleLength !== null &&
          audio.clip.sampleRate !== null &&
          markers.action === "warp-markers" &&
          markers.offset === 0 &&
          markers.total === markers.markers.length,
        "Incomplete or mismatched immutable fixture audio/warp content",
      );
      body = { audio, markers };
    }
    content.clips.push({
      target,
      sourceKind: source.sourceKind,
      positionUnit: source.positionUnit,
      settings: source.settings,
      body,
    });
  }
  return content;
}

const sourceScenarios = Object.fromEntries(
  Object.keys(nativeSourceTransitions).map((id) => [
    id,
    Object.freeze({
      startBeat: 4,
      endBeat: 12,
      maximumDurationMs: 8000,
      timeoutMs: 60000,
      artifactPrefix: `AA_SMOKE_${id.replaceAll("-", "_").toUpperCase()}_`,
    }),
  ]),
);
const v2Scenarios = Object.freeze({
  ...sourceScenarios,
  "native-descriptive-insert-before": Object.freeze({
    startBeat: 0,
    endBeat: 4,
    maximumDurationMs: 8000,
    timeoutMs: 120000,
    artifactPrefix: "AA_SMOKE_NV2_REBIND_",
  }),
  "native-descriptive-fractional": Object.freeze({
    startBeat: 0.25,
    endBeat: 3.75,
    maximumDurationMs: 8000,
    timeoutMs: 60000,
    artifactPrefix: "AA_SMOKE_NV2_FRAC_",
  }),
  "native-descriptive-startup-0-4": Object.freeze({
    startBeat: 0,
    endBeat: 4,
    maximumDurationMs: 8000,
    timeoutMs: 60000,
    artifactPrefix: "AA_SMOKE_NV2_START_0_4_",
  }),
  "native-descriptive-startup-4-12": Object.freeze({
    startBeat: 4,
    endBeat: 12,
    maximumDurationMs: 8000,
    timeoutMs: 60000,
    artifactPrefix: "AA_SMOKE_NV2_START_4_12_",
  }),
  "native-descriptive-30-seconds": Object.freeze({
    startBeat: 0.25,
    endBeat: 60.25,
    maximumDurationMs: 45000,
    timeoutMs: 90000,
    artifactPrefix: "AA_SMOKE_NV2_30S_",
  }),
});

export function nativeDescriptivePrompt(capture) {
  return `Make these calls sequentially, never in parallel: inspect-listeners, exactly one play-arrangement-and-listen for Arrangement beats ${capture.startBeat} through ${capture.endBeat} with maximumDurationMs ${capture.maximumDurationMs} and only the bound listener ID, then get-pass once using the returned passId. This is explicit native v2 with the App-owned descriptive timing policy capped at 64 samples, not strict v1 or physical timing qualification. Constant 120 BPM is assumed; tempo automation is unsupported. The candidate remains ready=false with native_per_pass_validation_required: never promote it or use another listener. Existing production guarded positioning owns the nonzero start before arming; do not seek, stop, repair positioning, or retry. If any tool call fails, including argument validation or permission denial, report and end without correcting, retrying, or using a shell wait. If the pass failed or was cancelled, report the reason and end. If still nonterminal, report pending and end without polling; the harness waits for the real terminal job. Only if completed may you get typed context using its contextId and includeHistorical=true. Do not list passes or context. Queued acceptance is not completion. Leave transport running; do not record, launch Session clips, change the Set, install devices, or claim exclusive clip audio. Unknown attribution and freshness are valid historical track/range results.`;
}

export function reviewNativeScenario(manifest) {
  const session = reviewNativeSessionScenario(manifest);
  if (session) return session;
  const v2 = v2Scenarios[manifest.id];
  const sourceTransition = nativeSourceTransitions[manifest.id];
  const rebinding = manifest.id === "native-descriptive-insert-before";
  const version = v2 ? 2 : 1;
  const range = v2 ?? { startBeat: 0, endBeat: 4, maximumDurationMs: 8000 };
  const policy = Object.freeze(
    version === 2
      ? { mode: "descriptive", maxClockDisagreementSamples: 64 }
      : { mode: "strict", maxClockDisagreementSamples: 0 },
  );
  assert(
    manifest.execution === "native-listening-runtime" &&
      manifest.maxToolCalls === (rebinding ? 16 : 8) &&
      manifest.maxMutations === (rebinding ? 2 : 1) &&
      manifest.timeoutMs === (v2?.timeoutMs ?? 60000) &&
      isDeepStrictEqual(manifest.setupContract?.timingPolicy, policy) &&
      (v2
        ? manifest.group ===
            (sourceTransition
              ? "native-listening-source-investigation"
              : rebinding
                ? "native-listening-rebinding"
                : "native-listening-descriptive") &&
          manifest.nativeVersion === 2 &&
          manifest.setupContract.nativeVersion === 2 &&
          manifest.setupContract.inputOption === "--native-v2-fixture-input" &&
          manifest.artifactPrefix === v2.artifactPrefix &&
          manifest.prompt ===
            nativeDescriptivePrompt(v2) +
              (sourceTransition ? nativeSourcePrompt(sourceTransition) : "") &&
          (sourceTransition
            ? manifest.sourceTransition === sourceTransition &&
              isDeepStrictEqual(
                manifest.sourceSetupActions,
                nativeSourceSetupActions[sourceTransition],
              ) &&
              manifest.setupContract.sourceInvestigation ===
                "reviewed-exact-track-transitions-no-automatic-repair" &&
              manifest.assertions.includes(
                "independent-source-transition-reads",
              ) &&
              (sourceTransition !== "explicit-return" ||
                manifest.assertions.includes(
                  "guarded-global-return-before-new-pass-not-retry",
                ))
            : manifest.sourceTransition === undefined &&
              manifest.sourceSetupActions === undefined &&
              manifest.setupContract.sourceInvestigation === undefined) &&
          isDeepStrictEqual(manifest.capture, {
            startBeat: v2.startBeat,
            endBeat: v2.endBeat,
            maximumDurationMs: v2.maximumDurationMs,
          }) &&
          manifest.setupContract.tempoPolicy === "constant-tempo-assumed" &&
          manifest.setupContract.tempoAutomationSupported === false &&
          Array.isArray(manifest.assertions) &&
          manifest.assertions.includes("no-failed-actor-tools") &&
          isDeepStrictEqual(manifest.allowedTools, [
            "ableton_listening",
            "ableton_context",
          ]) &&
          isDeepStrictEqual(manifest.allowedActions, {
            ableton_listening: [
              "inspect-listeners",
              "play-arrangement-and-listen",
              "get-pass",
            ],
            ableton_context: ["get"],
          }) &&
          isDeepStrictEqual(manifest.allowedRisks, ["read", "reversible"]) &&
          isDeepStrictEqual(manifest.ordering, [
            {
              before: "ableton_listening",
              beforeAction: "inspect-listeners",
              after: "ableton_listening",
              afterAction: "play-arrangement-and-listen",
            },
          ])
        : manifest.id === "native-playback-and-listen" &&
          manifest.group === "native-listening" &&
          manifest.nativeVersion === undefined),
    "Unreviewed native scenario contract",
  );
  assert(
    rebinding
      ? isDeepStrictEqual(
          manifest.setupContract.placementEdit,
          NATIVE_LISTENER_EDIT,
        )
      : manifest.setupContract.placementEdit === undefined,
    "Unreviewed native placement edit",
  );
  return Object.freeze({
    nativeVersion: version,
    timingPolicy: policy,
    capture: Object.freeze({
      startBeat: range.startBeat,
      endBeat: range.endBeat,
      maximumDurationMs: range.maximumDurationMs,
    }),
    ...(rebinding ? { rebinding: true } : {}),
  });
}

async function readNativeFixtureInput(path, nativeVersion) {
  assert(
    path !== undefined,
    `Explicit native-v${nativeVersion} fixture input required; no fallback`,
  );
  const info = await lstat(path);
  assert(
    info.isFile() && !info.isSymbolicLink() && info.size <= 64 * 1024,
    "Native fixture input must be a bounded regular JSON file",
  );
  const input = JSON.parse(await readFile(path, "utf8"));
  assert(
    (input.nativeVersion === undefined ? 1 : input.nativeVersion) ===
      nativeVersion,
    "Native fixture input version does not match the reviewed scenario",
  );
  return input;
}

export async function admitNativeScenarios({
  manifests,
  skipInstall,
  computerUse,
  approveAll,
  inputV1,
  inputV2,
  inputV3,
}) {
  if (manifests.length === 0) return;
  assert(
    skipInstall && !computerUse && !approveAll,
    "Native listening requires --skip-install and exact-PID shell startup; unsafe flags denied",
  );
  const versions = new Set(
    manifests.map((manifest) => reviewNativeScenario(manifest).nativeVersion),
  );
  for (const version of versions)
    await readNativeFixtureInput(
      version === 3 ? inputV3 : version === 2 ? inputV2 : inputV1,
      version,
    );
}

/** One fresh owned process and namespace per scenario, never concurrent Live. */
export async function runNativeScenarioGroup({
  manifests,
  controller,
  applicationPath,
  createRunner,
  onResult = async () => {},
}) {
  assert(
    manifests.length > 0 &&
      new Set(manifests.map((item) => item.id)).size === manifests.length,
    "Native group requires unique reviewed scenarios",
  );
  manifests.forEach(reviewNativeScenario);
  assert(
    new Set(manifests.map((item) => item.group)).size === 1 &&
      (manifests[0].group !== "native-listening" || manifests.length === 1),
    "Native groups cannot mix versions or duplicate the strict-v1 scenario",
  );
  const results = [];
  for (const manifest of manifests) {
    assert(
      controller.publicRecord() === undefined,
      "Previous native process is still owned",
    );
    await controller.assertNoPreExistingLive();
    const scenarioRunId = randomUUID();
    const runner = await createRunner(manifest, scenarioRunId);
    let result;
    let failure;
    const retainFailure = (error) => {
      failure =
        failure === undefined
          ? error
          : new AggregateError([failure, error], failure.message, {
              cause: failure,
            });
    };
    try {
      await runner.stage("process-launch", () =>
        controller.launch(applicationPath, 90000, {
          fixturePath: runner.fixture.setPath,
        }),
      );
      result = await runner.run(() => controller.validateOwnership());
      await onResult(
        manifest,
        result,
        scenarioRunId,
        controller.publicRecord(),
      );
    } catch (error) {
      retainFailure(error);
    } finally {
      try {
        if (controller.publicRecord() !== undefined)
          await runner.stage("process-shutdown", async () => {
            if (
              failure === undefined &&
              result?.ok &&
              result.evidence?.expectedRefusal === undefined
            )
              await controller.gracefulStop();
            else await controller.discardAfterFailure(20000);
            assert(
              controller.publicRecord() === undefined,
              "Native process shutdown did not release ownership",
            );
          });
      } catch (error) {
        retainFailure(error);
      }
      try {
        await runner.close({
          processStopped: controller.publicRecord() === undefined,
        });
      } catch (error) {
        retainFailure(error);
      }
    }
    if (failure !== undefined) throw failure;
    result.processCleanup = {
      processStopped: true,
      fixtureCleaned: true,
      transportCleanup:
        result.evidence?.expectedRefusal === undefined
          ? "leave-running"
          : "unchanged-stopped",
    };
    results.push({ manifest, result, scenarioRunId });
    if (!result.ok) break;
  }
  return results;
}

/** Integration-only composition. The runtime, host, context manager and registry
 * are the production factories; no Desktop window or alternate capture adapter. */
export async function createNativeListeningRunner({
  manifest,
  inputPath,
  directory,
  environment,
  runId,
  services = undefined,
  waitForBridge = waitForNativeBridge,
}) {
  const d = services ?? (await loadNativeRunnerServices());
  const compatibility =
    d.checkProductCompatibility === undefined
      ? await import("../../packages/shared/dist/index.js")
      : d;
  const reviewed = reviewNativeScenario(manifest);
  const input = selectSessionFixtureSource(
    await readNativeFixtureInput(inputPath, reviewed.nativeVersion),
    reviewed,
  );
  assert(
    input.formatVersion === 1 &&
      (reviewed.session
        ? /^live_set tracks (?:0|[1-9][0-9]{0,2}) devices (?:0|[1-9][0-9]?)$/
        : /^live_set tracks (?:0|[1-9][0-9]?) devices (?:0|[1-9][0-9]?)$/
      ).test(input.canonicalPath) &&
      typeof input.trackName === "string" &&
      input.trackName.length <= 128 &&
      typeof input.deviceName === "string" &&
      input.deviceName.length <= 128,
    "Explicit pinned native fixture identity is required",
  );
  const root = resolve(directory);
  const suffix = relative(resolve(".test-artifacts"), root);
  assert(
    suffix !== "" &&
      suffix !== ".." &&
      !suffix.startsWith(`..${sep}`) &&
      (await realpath(dirname(root))) === dirname(root),
    "Native runner directory must be a fresh nonsymlink artifact namespace",
  );
  await mkdir(root, { recursive: false, mode: 0o700 });
  const storage = d.resolveLiveAgentStorage({
    environment: {
      LIVE_AGENT_HOME: join(root, "live-agent"),
      LIVE_AGENT_PROFILE: "automation",
    },
  });
  const journal = await d.LocalObservabilityJournal.open({
    path: storage.eventJournalPath,
  });
  const closeJournal = async () => {
    try {
      await journal.flush();
    } finally {
      await journal.close();
    }
  };
  let telemetryFailed = false;
  const telemetry = d.createNonBlockingObservabilityRecorder(
    {
      enqueue: (event) => journal.enqueue(event),
      enqueueConfigurationSnapshot: (event) =>
        journal.enqueueConfigurationSnapshot(event),
    },
    {
      onFailure: () => {
        telemetryFailed = true;
      },
    },
  );
  const trace = {
    traceId: randomUUID(),
    correlationId: runId,
    causationId: randomUUID(),
  };
  const lifecycle = createNativeRunnerLifecycle({
    telemetry,
    sanitize: d.sanitizeTelemetryAttributes,
    trace,
  });
  let fixture;
  try {
    fixture = await stageNativeListeningFixture({
      nativeVersion: reviewed.nativeVersion,
      input: { ...input, artifactPrefix: `${manifest.artifactPrefix}${runId}` },
      destination: join(root, "fixture"),
      storage,
      stage: lifecycle.stage,
    });
  } catch (error) {
    await closeJournal();
    throw error;
  }
  let runtime;
  let manager;
  let host;
  let unsubscribeResult;
  let unsubscribeApplication;
  let actorContext;
  let repository;
  let removeSignalSecret;
  let geometry;
  let expected;
  let sourceEvidence;
  let readSourceBeforePass;
  let readSourceAfterPass;
  let observedLiveVersion;
  let sessionSource;
  let sessionContent;
  let sessionRegistrations;
  const sourceReceipts = [];
  const jobs = new Map();
  const received = [];
  const binding = {
    listenerId: undefined,
    passIds: new Set(),
    contextIds: new Set(),
    completedContextIds: new Set(),
  };
  const approvals = createNativeScenarioApproval(manifest, binding);
  const owner = {
    sessionId: randomUUID(),
    agentId: randomUUID(),
    liveSetId: undefined,
  };
  const contextStore = new d.JsonSessionStore(storage.sessionsPath, storage);
  let ownerSession;
  const makeManager = () =>
    d.createDesktopSessionContextManager({
      storage,
      recorder: telemetry,
      resolveSession: async (id) =>
        (await contextStore.load()).find((session) => session.id === id),
      publishSessionContext: async (request) => {
        assert(
          request.sessionId === owner.sessionId &&
            request.liveSetId === owner.liveSetId &&
            request.activeAgentId === owner.agentId,
          "Foreign context publication denied",
        );
        const sessions = await contextStore.load();
        const session = sessions.find((item) => item.id === request.sessionId);
        assert(session !== undefined, "Context owner is missing");
        const published = { ...session, contextStore: request.contextStore };
        await contextStore.save(
          sessions.map((item) => (item.id === session.id ? published : item)),
          {
            trace: request.trace,
            activeAgentId: request.activeAgentId,
            signal: request.signal,
          },
        );
        return published;
      },
    });
  const reader = () => ({
    sessionId: owner.sessionId,
    agentId: owner.agentId,
    actorKind: "application",
    trace,
  });
  const normalizeSnapshot = (input) => {
    const snapshot = { ...input };
    delete snapshot.isPlaying;
    if (reviewed.session)
      snapshot.clips = input.clips?.map((clip) => {
        if (clip.reference !== binding.sessionTarget?.expectedClipReference)
          return clip;
        const result = { ...clip };
        delete result.isPlaying;
        delete result.isTriggered;
        return result;
      });
    return snapshot;
  };
  const registrations = () =>
    globalThis.structuredClone(
      runtime.signals.listeners.inspectListeners().map((listener) => ({
        connectionId: listener.connectionId,
        producer: listener.producer,
        binding: listener.binding,
        registration: listener.registration,
        phase: listener.phase,
      })),
    );
  const normalizeInspection = (inspection) =>
    inspection.listeners.map((item) => ({
      binding: item.binding,
      canonicalPath: item.canonicalPath,
      enabled: item.enabled,
      clips: item.clips.map((clip) => ({
        target: clip.target,
        interval: clip.interval,
        settings: clip.settings,
      })),
      upstreamDevices: item.upstreamDevices,
    }));
  return {
    fixture,
    storage,
    stage: lifecycle.stage,
    async run(validateOwnership) {
      let result;
      let postconditions;
      let preflight;
      try {
        manager = makeManager();
        const contextHost = d.createSessionContextHost({
          resolveRepository: (context) => manager.resolveRepository(context),
        });
        runtime = d.createAgentRuntime({
          ableton: d.resolveAbletonSettingsFromEnvironment(environment),
          agent: {
            ...d.resolveAgentSettingsFromEnvironment(environment),
            baseDirectory: storage.copilotDirectory,
            largeOutputDirectory: storage.copilotToolOutputDirectory,
            turnTimeoutMs: manifest.timeoutMs,
          },
          signal: {
            secret: environment.ABLETON_AGENT_TOKEN,
            port: 0,
            descriptorPath: storage.signalIngressDescriptorPath,
            secretPath: storage.signalIngressSecretPath,
          },
          telemetry,
          agentHistory: journal,
          setHistory: journal,
          currentAppSessionId: () => owner.sessionId,
          currentLiveSetId: () => owner.liveSetId,
          requestToolApproval: (request) =>
            approvals.request({
              toolName: request.metadata.name,
              risk: request.metadata.risk,
              arguments: request.arguments,
            }),
          askForReadApproval: true,
          listening: (dependencies) => {
            if (reviewed.session) {
              const ableton = dependencies.ableton;
              assert(
                typeof ableton?.sessionListeningPass === "function",
                "Production Session source-driver boundary is required",
              );
              const original = ableton.sessionListeningPass.bind(ableton);
              ableton.sessionListeningPass = (params, options) =>
                lifecycle.stage(
                  `session-source-${params.action}`,
                  async () => {
                    const parsed =
                      d.protocol.sessionListeningPassParamsSchema.parse(params);
                    assert(
                      binding.passIds.has(parsed.passId) &&
                        (sourceReceipts.length < 511 ||
                          parsed.action === "release"),
                      "Foreign or unbounded Session source-driver request",
                    );
                    if (sourceReceipts.length > 0)
                      assert(
                        parsed.ownerId === sourceReceipts[0].params.ownerId,
                        "Foreign Session source-driver owner",
                      );
                    if (parsed.action === "prepare")
                      assert(
                        sessionSource !== undefined &&
                          expected !== undefined &&
                          sourceReceipts.length === 0 &&
                          parsed.expectedLiveSetId === owner.liveSetId &&
                          parsed.expectedProjectRevision ===
                            sessionSource.source.projectRevision &&
                          parsed.durationBeats === 4 &&
                          parsed.timingAnchor.globalBeat ===
                            geometry.startBeat &&
                          isDeepStrictEqual(
                            parsed.target,
                            sessionSource.target,
                          ) &&
                          isDeepStrictEqual(
                            parsed.listener,
                            sessionSource.listener,
                          ),
                        "Session preparation must match frozen source and listener before capture",
                      );
                    if (parsed.action === "launch")
                      assert(
                        sourceReceipts.length >= 1 &&
                          sourceReceipts.every((receipt) =>
                            ["prepare", "inspect"].includes(
                              receipt.params.action,
                            ),
                          ) &&
                          sourceReceipts[0].params.action === "prepare" &&
                          sourceReceipts[0].result.status === "prepared" &&
                          parsed.ownerId === sourceReceipts[0].params.ownerId,
                        "Session runner permits only one exact prepared source launch",
                      );
                    const result = await original(params, options);
                    sourceReceipts.push({
                      params: globalThis.structuredClone(parsed),
                      result:
                        d.protocol.sessionListeningPassResultSchema.parse(
                          result,
                        ),
                      beforePublication: ![
                        "persisting",
                        "completed",
                        "failed",
                        "cancelled",
                      ].includes(jobs.get(parsed.passId)?.stage),
                    });
                    return result;
                  },
                  { action: params.action, passId: params.passId },
                );
            }
            host = d.createListeningRuntimeHost(dependencies, {
              resolveTimingPolicy: () => reviewed.timingPolicy,
              contextPorts: contextHost,
              resolveOwner: async (context) => {
                assert(
                  context.sessionId === owner.sessionId &&
                    context.agentId === owner.agentId,
                  "Foreign listening actor denied",
                );
                return owner;
              },
              resolveRepository: (_owner, context) =>
                manager.resolveRepository(context),
              onChange: (job) => {
                if (reviewed.nativeVersion >= 2 && expected === undefined) {
                  assert(
                    geometry !== undefined &&
                      binding.listenerId !== undefined &&
                      job.stage === "queued" &&
                      job.owner.sessionId === owner.sessionId &&
                      job.owner.agentId === owner.agentId &&
                      job.owner.liveSetId === owner.liveSetId,
                    "App native expectation must be bound to an owned queued pass before capture",
                  );
                  const snapshot = reviewed.session
                    ? d.protocol.snapshotNativeSessionListeningExpectation
                    : d.protocol.snapshotNativeListeningExpectationV2;
                  expected = snapshot({
                    listenerId: binding.listenerId,
                    passId: job.passId,
                    policy: reviewed.timingPolicy,
                    geometry,
                    ...(reviewed.session
                      ? {
                          source: {
                            mode: "session",
                            synchronization:
                              "transport-coupled-first-iteration",
                            target: sessionSource.target,
                          },
                        }
                      : {}),
                  });
                }
                assert(
                  jobs.has(job.passId) ||
                    jobs.size < (reviewed.rebinding ? 2 : 1),
                  "Native scenario pass quota exceeded",
                );
                jobs.set(job.passId, globalThis.structuredClone(job));
                binding.passIds.add(job.passId);
                for (const id of job.contextIds) binding.contextIds.add(id);
                if (job.stage === "completed")
                  for (const id of job.contextIds)
                    binding.completedContextIds.add(id);
              },
            });
            return {
              ...host,
              executeListeningOperation: async (params, context) => {
                actorContext = context;
                if (
                  params.action === "play-arrangement-and-listen" &&
                  readSourceBeforePass
                )
                  await readSourceBeforePass();
                return host.executeListeningOperation(params, context);
              },
            };
          },
        });
        removeSignalSecret = await lifecycle.stage("signal-credentials", () =>
          d.publishSignalSecrets(environment.ABLETON_AGENT_TOKEN, {
            canonical: {
              directory: storage.credentialsDirectory,
              secretPath: storage.signalIngressSecretPath,
            },
            telemetry,
          }),
        );
        await lifecycle.stage("signal-start", () => runtime.signals.start());
        const { port } = d.resolveAbletonSettingsFromEnvironment(environment);
        await lifecycle.stage(
          "bridge-readiness",
          () => waitForBridge({ port, validateOwnership }),
          { host: "127.0.0.1", port, timeoutMs: 60000 },
        );
        await lifecycle.stage("application-start", () =>
          runtime.application.start({ startAgent: true }),
        );
        const deadline = Date.now() + manifest.timeoutMs;
        const boundedStage = (name, operation) =>
          lifecycle.stage(name, () =>
            d.awaitListeningBoundary(
              operation(),
              globalThis.AbortSignal.timeout(
                Math.max(1, deadline - Date.now()),
              ),
            ),
          );
        await lifecycle.stage("native-preflight", async () => {
          let lastObserved;
          while (Date.now() < deadline) {
            await validateOwnership();
            const status = await runtime.application.getStatus();
            const listeners =
              runtime.signals.listeners?.inspectListeners() ?? [];
            lastObserved = {
              state: status.state,
              ...(status.state === "error"
                ? {
                    connectionError: {
                      code:
                        typeof status.code === "string"
                          ? d.sanitizePersistedText(status.code).slice(0, 128)
                          : null,
                      message:
                        typeof status.message === "string"
                          ? d
                              .sanitizePersistedText(status.message)
                              .slice(0, 1024)
                          : null,
                    },
                  }
                : {}),
              liveSetName: status.liveSetName,
              saved: status.saved,
              listenerPaths: listeners
                .slice(0, 4)
                .map((item) => item.registration.deviceCanonicalPath),
            };
            const matches = listeners.filter(
              (item) =>
                item.registration.deviceCanonicalPath === input.canonicalPath,
            );
            if (status.state === "connected" && matches.length === 1) {
              owner.liveSetId = status.liveSetId;
              observedLiveVersion = status.liveVersion;
              assert(
                typeof owner.liveSetId === "string" &&
                  status.saved === true &&
                  status.liveSetName === `${manifest.artifactPrefix}${runId}`,
                "Runner-owned copied Set identity mismatch",
              );
              binding.listenerId = matches[0].producer.producerId;
              break;
            }
            await new Promise((resolve_) => setTimeout(resolve_, 100));
          }
          assert(
            binding.listenerId !== undefined,
            `Timed out waiting for exact copied native candidate: ${JSON.stringify(lastObserved)}`,
          );
        });
        const listener = runtime.signals.listeners
          .inspectListeners()
          .find((item) => item.producer.producerId === binding.listenerId);
        assert(
          listener.registration.nativeStatus?.scope ===
            (reviewed.session
              ? d.protocol.NATIVE_SESSION_LISTENER_SCOPE
              : reviewed.nativeVersion === 2
                ? d.protocol.NATIVE_LISTENER_SCOPE_V2
                : d.protocol.NATIVE_LISTENER_SCOPE) &&
            (reviewed.nativeVersion >= 2
              ? listener.registration.version === reviewed.nativeVersion &&
                listener.producer.schemaVersion === "audio-observation/v2" &&
                [44100, 48000].includes(listener.registration.sampleRate)
              : listener.registration.sampleRate === 48000) &&
            listener.phase === "idle",
          "Native candidate scope/sample rate/idle state mismatch",
        );
        if (reviewed.session)
          assert(
            listener.registration.nativeStatus.version === 3 &&
              listener.registration.trackCanonicalPath ===
                input.canonicalPath.split(" devices ")[0] &&
              listener.registration.nativeStatus.sourceEvidence ===
                "expected-context-only" &&
              listener.registration.nativeStatus.synchronization ===
                "transport-coupled-first-iteration" &&
              listener.registration.nativeStatus.maxDurationBeats === 4 &&
              runtime.signals.listeners
                .inspectListeners()
                .filter(
                  (item) =>
                    item.registration.trackCanonicalPath ===
                    listener.registration.trackCanonicalPath,
                ).length === 1,
            "One exact same-track wire3 expected-context-only candidate is required",
          );
        const inspectionParams = {
          schemaVersion: 1,
          bindingQueryId: randomUUID(),
          listeners: [{ canonicalPath: input.canonicalPath }],
          range: {
            startBeat: reviewed.capture.startBeat,
            endBeat: reviewed.capture.endBeat,
          },
          maxClips: 32,
          maxParameters: 16,
        };
        let inspected =
          await runtime.ableton.inspectListeningContext(inspectionParams);
        let target = inspected.listeners[0];
        preflight = inspectNativeStoppedPreflight(
          {
            inspected,
            input,
            nativeVersion: reviewed.nativeVersion,
            session: reviewed.session,
            limits: inspectionParams,
          },
          d.sanitizePersistedText,
        );
        await lifecycle.stage(
          "stopped-preflight",
          async () =>
            assert(
              preflight.passed,
              `Unsafe or mismatched stopped native preflight: ${preflight.failedChecks.join(", ")}`,
            ),
          { preflight },
        );
        const sourceTransition = nativeSourceTransitions[manifest.id];
        const expectedRefusal = sourceTransition === "session-override";
        if (sourceTransition) {
          sourceEvidence = {
            schema: "native-source-investigation/v1",
            transition: sourceTransition,
            runId,
            originalCause: "not-reconstructable",
            bugSpecificReproduction: "unproven-not-claimed",
            reads: [],
            mutations: [],
          };
          const prepared = await prepareNativeSourceTransition({
            transition: sourceTransition,
            ableton: runtime.ableton,
            inspect: async (bindingQueryId) => {
              const validateIdentity = async () => {
                await validateOwnership();
                const currentListener = runtime.signals.listeners
                  .inspectListeners()
                  .find(
                    (item) => item.producer.producerId === binding.listenerId,
                  );
                assert(
                  currentListener?.connectionId === listener.connectionId &&
                    isDeepStrictEqual(
                      currentListener?.registration,
                      listener.registration,
                    ) &&
                    isDeepStrictEqual(
                      currentListener?.binding,
                      listener.binding,
                    ) &&
                    (await runtime.application.getStatus()).liveSetId ===
                      owner.liveSetId,
                  "Source investigation listener epoch, binding or Set owner changed",
                );
              };
              await validateIdentity();
              const value = await runtime.ableton.inspectListeningContext({
                ...inspectionParams,
                bindingQueryId,
              });
              assert(
                value.bindingQueryId === bindingQueryId,
                "Stale source investigation binding query",
              );
              await validateIdentity();
              return value;
            },
            target,
            runId,
            validateOwnership,
            stage: lifecycle.stage,
            evidence: sourceEvidence,
          });
          inspected = prepared.inspected;
          target = inspected.listeners[0];
          sourceEvidence = prepared.evidence;
          readSourceBeforePass = prepared.beforePass;
          readSourceAfterPass = prepared.afterPass;
          assert(
            expectedRefusal ||
              (inspected.transport.playing === false &&
                inspected.transport.safeToStart === true),
            "Source transition must establish a stopped safe new-pass baseline",
          );
        }
        if (reviewed.nativeVersion === 2) {
          geometry = d.protocol.createNativeListeningGeometry({
            sampleRate: listener.registration.sampleRate,
            vectorSize: listener.registration.vectorSize,
            tempoBpm: inspected.transport.tempo,
            startBeat: reviewed.capture.startBeat,
            endBeat: reviewed.capture.endBeat,
          });
        }
        const baselineSnapshot = await runtime.application.inspectSession();
        if (reviewed.session) {
          const sessionTarget = selectNativeSessionTarget(
            baselineSnapshot,
            input,
            d.protocol,
          );
          assert(
            isDeepStrictEqual(sessionTarget.track, target.binding.track),
            "Session clip and listener must independently resolve to the exact same track",
          );
          const queryId = randomUUID();
          const source = await boundedStage("session-source-baseline", () =>
            runtime.ableton.inspectSessionListeningSource({
              schemaVersion: 1,
              queryId,
              target: sessionTarget,
            }),
          );
          assert(source.queryId === queryId, "Stale Session source baseline");
          geometry = d.protocol.createNativeListeningGeometry({
            sampleRate: listener.registration.sampleRate,
            vectorSize: listener.registration.vectorSize,
            tempoBpm: inspected.transport.tempo,
            startBeat: source.after.globalBeat,
            endBeat: source.after.globalBeat + reviewed.capture.durationBeats,
          });
          const frozen = snapshotNativeSessionSource(
            {
              source,
              target: sessionTarget,
              sourceKind: reviewed.sourceKind,
              geometry,
            },
            d.protocol,
          );
          sessionSource = {
            ...frozen,
            listener: globalThis.structuredClone(target.binding),
          };
          binding.sessionTarget = frozen.target;
          sessionContent = await boundedStage(
            "session-fixture-content-baseline",
            () =>
              readNativeSessionFixtureContent({
                ableton: runtime.ableton,
                snapshot: baselineSnapshot,
                protocol: d.protocol,
              }),
          );
          for (const sourceKind of ["midi", "warped-audio"]) {
            const selector = selectSessionFixtureSource(input, {
              ...reviewed,
              sourceKind,
            });
            const selected = selectNativeSessionTarget(
              baselineSnapshot,
              selector,
              d.protocol,
            );
            assert(
              sessionContent.clips.some(
                (clip) =>
                  clip.target.expectedClipReference ===
                    selected.expectedClipReference &&
                  clip.sourceKind === sourceKind,
              ),
              "Both immutable fixture Session source selectors must match inspected content",
            );
          }
          sessionRegistrations = registrations();
        }
        const actorConfiguration = {
          instanceId: owner.agentId,
          productionSessionId: owner.sessionId,
          definitionName: "native-listening-integration",
          label: "Native listening integration",
          description: `Reviewed native ${reviewed.session ? "Session" : "Arrangement"} playback-and-listen integration scenario.`,
          systemPrompt: "Execute only the reviewed listening scenario.",
          resolvedTools: manifest.allowedTools,
          resolvedOperations: [
            "listening.inspect_listeners",
            reviewed.session
              ? "listening.play_session_and_listen"
              : "listening.play_arrangement_and_listen",
            "listening.get_pass",
            "context.get",
          ],
          editScope: ["session"],
          boundTracks: [],
          skills: [],
        };
        ownerSession = d.sessionSchema.parse({
          version: 4,
          id: owner.sessionId,
          title: `${manifest.artifactPrefix}${runId}`,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          liveSetId: owner.liveSetId,
          liveSetName: `${manifest.artifactPrefix}${runId}`,
          selectedAgentInstanceId: owner.agentId,
          activeAgents: [
            {
              id: owner.agentId,
              label: actorConfiguration.label,
              definitionName: actorConfiguration.definitionName,
              definitionFingerprint: input.deviceSha256,
              autoApprove: false,
              modified: false,
              lifecycle: "ready",
              boundTracks: [],
              eventListeners: [],
              outputSubscriptions: [],
              config: {
                description: actorConfiguration.description,
                systemPrompt: actorConfiguration.systemPrompt,
                tools: manifest.allowedTools,
                resolvedTools: manifest.allowedTools,
                resolvedOperations: actorConfiguration.resolvedOperations,
                editScope: ["session"],
                skills: [],
                inputChannels: [],
              },
            },
          ],
        });
        await lifecycle.stage("session-ownership", () =>
          contextStore.save([ownerSession], { trace }),
        );
        repository = await manager.resolveRepository(reader());
        assert(
          (await repository.listEntries({ includeHistorical: true, limit: 20 }))
            .items.length === 0,
          "Native scenario did not begin with empty owned context",
        );
        const view = await host.executeListeningOperation(
          { action: "inspect-listeners" },
          reader(),
        );
        const candidateView = view.listeners.find(
          (item) => item.listenerId === binding.listenerId,
        );
        assert(
          candidateView?.ready === false &&
            candidateView.limitations.includes(
              "native_per_pass_validation_required",
            ) &&
            candidateView.trackReference ===
              target.binding.track.expectedReference &&
            candidateView.deviceReference ===
              target.binding.expectedDeviceReference,
          "Candidate readiness or independently resolved identity mismatch",
        );
        unsubscribeResult = runtime.signals.listeners.onListenerResult(
          (event) => {
            if (
              event.producer.producerId === binding.listenerId &&
              event.result.status === "completed"
            ) {
              if (received.length < (reviewed.rebinding ? 4 : 2))
                received.push(globalThis.structuredClone(event));
            }
          },
        );
        let humanGate;
        let humanGateError;
        const humanGatePromise = new Promise((_resolve, reject) => {
          humanGate = reject;
        });
        void humanGatePromise.catch(() => {});
        let actorToolCalls = 0;
        unsubscribeApplication = runtime.application.subscribe((event) => {
          if (event.type === "operation.started") actorToolCalls++;
          if (
            reviewed.nativeVersion >= 2 &&
            event.type === "operation.failed" &&
            humanGateError === undefined
          ) {
            humanGateError = new Error(
              "Native scenario actor tool failed; no retry is permitted",
            );
            humanGate(humanGateError);
          }
          if (
            [
              "agent.elicitation_requested",
              "agent.plan_approval_requested",
            ].includes(event.type)
          ) {
            humanGateError = new Error(
              "Native scenario cannot answer a human gate",
            );
            humanGate(humanGateError);
          }
        });
        const sdkSessionId = await boundedStage("actor-session-start", () =>
          runtime.application.createManagedAgent(actorConfiguration),
        );
        assert(
          typeof sdkSessionId === "string" &&
            sdkSessionId.length > 0 &&
            sdkSessionId.length <= 200,
          "Managed actor did not return a bounded SDK session identity",
        );
        await lifecycle.stage("actor-session-publication", () =>
          contextStore.save(
            [
              {
                ...ownerSession,
                activeAgents: ownerSession.activeAgents.map((agent) => ({
                  ...agent,
                  sdkSessionId,
                })),
              },
            ],
            { trace, activeAgentId: owner.agentId },
          ),
        );
        const captureAndVerify = async ({
          listener,
          target,
          inspected,
          baselineSnapshot,
          inspectionParams,
        }) => {
          const baseline = normalizeSnapshot(baselineSnapshot);
          const previousPasses = new Set(jobs.keys());
          await boundedStage("actor-turn", () =>
            Promise.race([
              runtime.application.sendToManagedAgent(
                owner.agentId,
                `${manifest.prompt}\nExact runner-owned listener ID: ${binding.listenerId}. Use it only in the playback call's listenerIds. The inspect-listeners arguments are exactly {"action":"inspect-listeners"}. The get-pass arguments are only action and the passId returned by playback; never supply listenerIds to it. A returned contextId is a different identity. Historical context queries must set includeHistorical=true.${reviewed.session ? `\nExact immutable Session target: ${JSON.stringify(binding.sessionTarget)}` : ""}`,
                "interactive",
              ),
              humanGatePromise,
            ]),
          );
          if (humanGateError !== undefined) throw humanGateError;
          assert(
            actorContext?.sessionId === owner.sessionId &&
              actorContext.agentId === owner.agentId &&
              actorContext.actorKind !== "application" &&
              jobs.size === previousPasses.size + 1 &&
              approvals.mutationCount === previousPasses.size + 1,
            "A real owned actor call and exactly one pass are required",
          );
          const passId = [...jobs.keys()].find((id) => !previousPasses.has(id));
          // The model may return during arming. Keep the real services alive through
          // the production coordinator's bounded terminal boundary.
          const terminal = await boundedStage("terminal-job", () =>
            host.waitForListeningPass(passId, actorContext),
          );
          assert(
            terminal.passId === passId &&
              terminal.stage === (expectedRefusal ? "failed" : "completed"),
            `Listening terminal job did not complete (${terminal.stage})${terminal.error === undefined ? "" : `: ${terminal.error}`}`,
          );
          assert(
            approvals.decisions.every((item) => item.approved) &&
              actorToolCalls <= manifest.maxToolCalls,
            "The actor exceeded the reviewed tool policy or budget",
          );
          const jobResult = await host.executeListeningOperation(
            { action: "get-pass", passId },
            actorContext,
          );
          const job = jobResult.job;
          const pass = await repository.getPass(passId);
          const rows = (
            await repository.listEntries({ includeHistorical: true, limit: 20 })
          ).items;
          const allEntries = await Promise.all(
            rows.map((item) => repository.getEntry(item.id)),
          );
          const allLinks = (
            await repository.listLinks({ includeHistorical: true, limit: 20 })
          ).items;
          if (expectedRefusal) {
            await validateOwnership();
            const finalInspection = await readSourceAfterPass();
            const finalSnapshot = await runtime.application.inspectSession();
            const finalListener = runtime.signals.listeners
              .inspectListeners()
              .find((item) => item.producer.producerId === binding.listenerId);
            const evidence = await lifecycle.stage(
              "source-refusal-verification",
              async () =>
                verifyNativeSourceRefusal({
                  job,
                  pass,
                  entries: allEntries,
                  links: allLinks,
                  received,
                  before: inspected,
                  after: finalInspection,
                  listener,
                  finalListener,
                  baselineSnapshot,
                  finalSnapshot,
                }),
            );
            return { evidence, job };
          }
          const entries = allEntries.filter(
            (entry) => entry?.passId === passId,
          );
          const entryIds = new Set(entries.map((entry) => entry.id));
          const links = allLinks.filter((link) => entryIds.has(link.entryId));
          const subjects = await Promise.all(
            [...new Set(links.map((item) => item.subjectId))].map((id) =>
              repository.getSubject(id),
            ),
          );
          const typed = await contextHost.executeContextOperation(
            {
              action: "get",
              contextId: job.contextIds[0],
              includeHistorical: true,
            },
            reader(),
          );
          await lifecycle.stage("context-close", () => manager.close());
          manager = makeManager();
          repository = await manager.resolveRepository(reader());
          const resumedHost = d.createSessionContextHost({
            resolveRepository: (context) => manager.resolveRepository(context),
          });
          const resumed = await lifecycle.stage("typed-context-reopen", () =>
            resumedHost.executeContextOperation(
              {
                action: "get",
                contextId: job.contextIds[0],
                includeHistorical: true,
              },
              reader(),
            ),
          );
          await validateOwnership();
          const finalInspection = readSourceAfterPass
            ? await readSourceAfterPass()
            : await runtime.ableton.inspectListeningContext({
                ...inspectionParams,
                bindingQueryId: randomUUID(),
              });
          const finalSnapshot = await runtime.application.inspectSession();
          let sessionAfter;
          if (reviewed.session) {
            await fixture.verifyImmutableInputs();
            const queryId = randomUUID();
            sessionAfter = await boundedStage("session-source-after", () =>
              runtime.ableton.inspectSessionListeningSource({
                schemaVersion: 1,
                queryId,
                target: sessionSource.target,
              }),
            );
            assert(
              sessionAfter.queryId === queryId,
              "Stale Session source after-state",
            );
            const contentAfter = await boundedStage(
              "session-fixture-content-after",
              () =>
                readNativeSessionFixtureContent({
                  ableton: runtime.ableton,
                  snapshot: finalSnapshot,
                  protocol: d.protocol,
                }),
            );
            assert(
              isDeepStrictEqual(sessionContent, contentAfter) &&
                isDeepStrictEqual(sessionRegistrations, registrations()),
              "Session capture changed fixture content, device parameters or unselected listener scope",
            );
          }
          const finalListener = runtime.signals.listeners
            .inspectListeners()
            .find((item) => item.producer.producerId === binding.listenerId);
          postconditions = inspectNativeListeningPostconditions(
            {
              baselineSnapshot,
              finalSnapshot,
              inspected,
              finalInspection,
              listener,
              finalListener,
              beforeBinding: normalizeInspection(inspected),
              afterBinding: normalizeInspection(finalInspection),
            },
            d.sanitizePersistedText,
          );
          await lifecycle.stage(
            "leave-running-postconditions",
            async () =>
              assert(
                postconditions.passed,
                `Leave-running capture cleanup, immutable binding or recording state mismatch: ${postconditions.failedChecks.join(", ")}`,
              ),
            { postconditions },
          );
          const evidence = await lifecycle.stage(
            "independent-verification",
            async () =>
              verifyNativeListeningEvidence(
                {
                  job,
                  pass,
                  entries,
                  links,
                  subjects,
                  received: received.filter(
                    (event) => event.result.passId === passId,
                  ),
                  listener,
                  owner,
                  baseline,
                  final: normalizeSnapshot(finalSnapshot),
                  typed,
                  resumed,
                  target,
                  ...(reviewed.nativeVersion >= 2 ? { expected } : {}),
                  ...(reviewed.session
                    ? {
                        session: {
                          ...sessionSource,
                          receipts: sourceReceipts,
                          after: sessionAfter,
                        },
                      }
                    : {}),
                },
                d.protocol,
              ),
          );
          return {
            evidence,
            job,
            snapshot: finalSnapshot,
            inspection: finalInspection,
          };
        };
        const first = await captureAndVerify({
          listener,
          target,
          inspected,
          baselineSnapshot,
          inspectionParams,
        });
        let recovery;
        if (reviewed.rebinding) {
          const priorEntry = await repository.getEntry(
            first.evidence.contextId,
          );
          const edited = await insertBeforeNativeListener({
            ableton: runtime.ableton,
            service: runtime.signals.listeners,
            original: target,
            listener,
            baseline: first.snapshot,
            range: {
              startBeat: reviewed.capture.startBeat,
              endBeat: reviewed.capture.endBeat,
            },
            stage: (name, operation) =>
              boundedStage(name, async () => {
                await validateOwnership();
                return operation();
              }),
          });
          binding.listenerId = edited.listener.producer.producerId;
          binding.captureLimit = 2;
          geometry = d.protocol.createNativeListeningGeometry({
            sampleRate: edited.listener.registration.sampleRate,
            vectorSize: edited.listener.registration.vectorSize,
            tempoBpm: edited.inspection.transport.tempo,
            startBeat: reviewed.capture.startBeat,
            endBeat: reviewed.capture.endBeat,
          });
          expected = undefined;
          const second = await captureAndVerify({
            listener: edited.listener,
            target: edited.target,
            inspected: edited.inspection,
            baselineSnapshot: edited.snapshot,
            inspectionParams: {
              ...inspectionParams,
              maxParameters: 32,
              bindingQueryId: randomUUID(),
              listeners: [{ canonicalPath: edited.canonicalPath }],
            },
          });
          await lifecycle.stage("rebind-prior-context-preserved", async () => {
            assert(
              isDeepStrictEqual(
                await repository.getEntry(first.evidence.contextId),
                priorEntry,
              ) &&
                first.evidence.contextId !== second.evidence.contextId &&
                first.job.passId !== second.job.passId &&
                jobs.size === 2,
              "Re-listening rewrote prior context or reused a pass identity",
            );
          });
          recovery = {
            first: first.evidence,
            second: second.evidence,
            listenerDeviceReference: target.binding.expectedDeviceReference,
            initialDeviceIndex: 0,
            finalDeviceIndex: 1,
            priorContextPreserved: true,
          };
        }
        assert(
          !telemetryFailed,
          "Native scenario observability persistence failed",
        );
        result = {
          ok: true,
          evidence: first.evidence,
          ...(recovery ? { recovery } : {}),
          fixture: {
            sourceSetSha256: fixture.sourceSetSha256,
            deviceSha256: fixture.deviceSha256,
            discoverySha256: fixture.discoverySha256,
            resourceCount: fixture.resourceCount,
            audioResourceCount: fixture.audioResourceCount,
            audioResources: fixture.audioResources.map(({ sha256, bytes }) => ({
              sha256,
              bytes,
            })),
            nativeVersion: fixture.nativeVersion,
          },
          actorToolCalls,
        };
      } catch (error) {
        result = {
          ok: false,
          error: d
            .sanitizePersistedText(String(error?.message ?? error))
            .slice(0, 2048),
        };
      } finally {
        unsubscribeResult?.();
        unsubscribeApplication?.();
        for (const [name, shutdown] of [
          [
            "application-shutdown",
            async () => {
              try {
                await runtime?.application.stop();
              } finally {
                await manager?.close();
              }
            },
          ],
          ["signal-shutdown", async () => runtime?.signals.stop()],
          ["credential-cleanup", async () => removeSignalSecret?.()],
        ]) {
          try {
            await lifecycle.stage(name, shutdown);
          } catch (error) {
            const message = d
              .sanitizePersistedText(String(error?.message ?? error))
              .slice(0, 2048);
            result = {
              ...result,
              ok: false,
              cleanupError: [result?.cleanupError, message]
                .filter(Boolean)
                .join("; ")
                .slice(0, 2048),
            };
          }
        }
      }
      const hostEligible = compatibility.checkProductCompatibility({
        liveVersion: observedLiveVersion ?? "",
        protocolVersion: compatibility.PRODUCT_VERSIONS.protocol,
        remoteScriptVersion: compatibility.PRODUCT_VERSIONS.remoteScript,
      }).compatible;
      const hostEvidence = d.sanitizeTelemetryAttributes({
        supportedLive: compatibility.PRODUCT_VERSIONS.supportedLive,
        observedLiveVersion,
        hostEligible,
        hostEvidenceLabel: hostEligible
          ? "supported-live-unqualified"
          : "unsupported-live-unqualified",
        qualificationStatus: "unqualified",
      });
      return {
        ...result,
        ...hostEvidence,
        ...(preflight === undefined ? {} : { preflight }),
        ...(sourceEvidence === undefined
          ? {}
          : {
              sourceInvestigation: d.sanitizeTelemetryAttributes({
                ...sourceEvidence,
                ...hostEvidence,
              }),
            }),
        ...(postconditions === undefined
          ? {}
          : { postconditions: d.sanitizeTelemetryAttributes(postconditions) }),
        approvals: approvals.decisions.map((item) =>
          d.sanitizeTelemetryAttributes(item),
        ),
        jobs: [...jobs.values()].map((job) => ({
          passId: job.passId,
          stage: job.stage,
          cleanupPolicy: job.cleanupPolicy,
          contextIds: job.contextIds,
          ...(job.error === undefined
            ? {}
            : {
                error: d.sanitizePersistedText(job.error).slice(0, 2048),
              }),
        })),
        lifecycle: lifecycle.events,
      };
    },
    async close({ processStopped }) {
      try {
        if (processStopped) await fixture.cleanup();
        else
          throw new Error(
            "Runner process still owns the fixture: retained staging, no deletion",
          );
      } finally {
        await closeJournal();
      }
    },
  };
}
