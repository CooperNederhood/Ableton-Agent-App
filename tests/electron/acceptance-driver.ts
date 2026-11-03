import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { sendAutomationMessage } from "@ableton-agent/debug-control";
import { automationDiscoveryDescriptorSchema } from "@ableton-agent/debug-control/contracts";
import { resolveLiveAgentStorage } from "@ableton-agent/storage";
import {
  metricAudioObservationSchema,
  type InspectSessionListeningSourceParams,
} from "@ableton-agent/protocol";
import type {
  AcceptanceDriver,
  BaselineEvidence,
  CaptureEvidence,
  ContextEvidence,
  DriverContext,
  DependencyInventory,
  Facts,
  RunEvidence,
  ScenarioStep,
  SessionIdentity,
  SourceIdentity,
  Submission,
  TurnEvidence,
  TurnSubscription,
} from "@ableton-agent/test-support/integration";
import {
  validateSupportedAudioBaseline,
  validateAudioBaselineEvidence,
  verifyStagedMedia,
  isFixtureMediaTarget,
} from "@ableton-agent/test-support/integration";
import type { DesktopListeningJob } from "../../apps/desktop/src/listening-contracts.js";
import type { DesktopContextDetail } from "../../apps/desktop/src/context-contracts.js";
import type {
  DesktopAppEvent,
  DesktopLiveSetSnapshot,
  TelemetryEventPage,
  DesktopSessionListeningPreflight,
} from "../../apps/desktop/src/contracts.js";
import { writeScenarioReceipt } from "../../scripts/lib/scenario-receipts.mjs";
import { LiveProcessController } from "../../scripts/lib/live-process-controller.mjs";
import { waitForRunnerOwnedLiveReady } from "../../scripts/lib/live-ux-host.mjs";
import { closeOwnedPackagedApplication } from "./packaged-cleanup.js";
import {
  packagedExecutable,
  packagedCandidateHash,
  finderLikeEnvironment,
} from "./packaged-paths.js";
import { provisionPackagedDependencies } from "./acceptance-dependencies.js";
import { verifyActiveFrozenCandidate } from "./acceptance-loading.js";
import {
  inspectAcceptanceProject,
  verifyBuiltinResources,
  readSavedFollowAction,
} from "./acceptance-project.js";
import { AcceptanceEvents } from "./acceptance-events.js";
import {
  resolveSessionSource,
  sessionStructureFingerprint,
  unrelatedPlaybackFingerprint,
} from "./acceptance-source.js";
import { captureCleanupConfirmed } from "./acceptance-evidence.js";
import { ScopedApprovalPolicy } from "./acceptance-approvals.js";

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function sourceFingerprint(
  preflight: DesktopSessionListeningPreflight,
): string {
  return hash({
    settings: preflight.source.settings,
    audio: preflight.audio,
    recording: preflight.recording.state,
    targetRecording: preflight.source.after.targetRecording,
  });
}
function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`Missing acceptance ${label}`);
  return value;
}
function stringFact(facts: Facts, key: string): string {
  const value = facts[key];
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`Missing fixture baseline ${key}`);
  return value;
}
async function pause(context: DriverContext): Promise<void> {
  context.signal.throwIfAborted();
  if (Date.now() >= context.deadlineAt)
    throw new Error("Acceptance stage deadline exceeded");
  await delay(100, undefined, { signal: context.signal });
}
async function observe<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  let cancel: () => void = () => undefined;
  const cancelled = new Promise<never>((_, reject) => {
    cancel = () =>
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error("Acceptance cancelled"),
      );
    signal.addEventListener("abort", cancel, { once: true });
  });
  try {
    return await Promise.race([operation(), cancelled]);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

export interface PackagedAcceptanceOptions {
  readonly runDirectory: string;
  readonly executablePath?: string;
  readonly liveApplicationPath?: string;
}

/** Real Desktop ingress only; no runtime construction or model substitution. */
export class PackagedAcceptanceDriver implements AcceptanceDriver {
  readonly schemaVersion = 1 as const;
  readonly capabilities = [
    "automation",
    "session-audio",
    "persistence",
  ] as const;
  readonly #live = new LiveProcessController();
  readonly #events = new AcceptanceEvents();
  readonly #submissions = new Map<
    string,
    {
      assistantMessageId: string;
      eventOffset: number;
      priorPasses: ReadonlySet<string>;
      message: string;
    }
  >();
  readonly #contexts = new Map<string, ContextEvidence>();
  readonly #contextTraces = new Map<
    string,
    { traceId: string; correlationId: string }
  >();
  readonly #sdkTurns = new Map<string, string>();
  readonly #preflightTraces = new Set<string>();
  readonly #handledApprovals = new Set<string>();
  #application: ElectronApplication | undefined;
  #page: Page | undefined;
  #unsubscribe: (() => Promise<void>) | undefined;
  #launching: Promise<void> | undefined;
  #desktopLaunching: Promise<void> | undefined;
  #provisioning: Promise<DependencyInventory> | undefined;
  #ownedRunId: string | undefined;
  #approvalPolicy: ScopedApprovalPolicy | undefined;
  #identity: SessionIdentity | undefined;
  #source: SourceIdentity | undefined;
  #target: InspectSessionListeningSourceParams | undefined;
  #snapshot: DesktopLiveSetSnapshot | undefined;
  #sourceSettingsHash: string | undefined;
  #listenerId: string | undefined;
  #dependencies: Readonly<Record<string, string>> = {};
  #preparedProject: string | undefined;
  #candidateInventory: DependencyInventory | undefined;
  #executable: string | undefined;
  #profile: string | undefined;
  #preservationPaths = new Set<string>();
  #traceEvents: TelemetryEventPage["items"] = [];
  #provenance: Facts = {};

  constructor(private readonly options: PackagedAcceptanceOptions) {}

  preservationPaths(): ReadonlySet<string> {
    return this.#preservationPaths;
  }

  #getPage(): Page {
    return required(this.#page, "Desktop page");
  }
  #descriptor(): string {
    return join(required(this.#profile, "profile"), "automation-endpoint.json");
  }

  async #launchDesktop(context: DriverContext): Promise<void> {
    this.#desktopLaunching = this.#startDesktop(context);
    await this.#desktopLaunching;
  }

  async #startDesktop(context: DriverContext): Promise<void> {
    context.signal.throwIfAborted();
    const environment = finderLikeEnvironment({
      LIVE_AGENT_PROFILE: "automation",
    });
    for (const key of [
      "COPILOT_CLI_PATH",
      "NODE_OPTIONS",
      "ELECTRON_RUN_AS_NODE",
    ])
      delete environment[key];
    const application = await electron.launch({
      executablePath: required(this.#executable, "packaged executable"),
      args: [
        "--automation",
        "--automation-profile",
        required(this.#profile, "profile"),
        "--automation-descriptor",
        this.#descriptor(),
        "--automation-agent",
        "default",
      ],
      cwd: context.stagedFixture!.workingDirectory,
      env: environment,
      timeout: Math.max(1, Math.min(30_000, context.deadlineAt - Date.now())),
    });
    this.#application = application;
    if (context.signal.aborted) {
      const cleanup = await closeOwnedPackagedApplication(application);
      if (!cleanup.successful)
        throw new Error("Cancelled launch cleanup failed");
      context.signal.throwIfAborted();
    }
    const candidate = await application.evaluate(({ app }) => ({
      packaged: app.isPackaged,
      path: app.getAppPath(),
      version: app.getVersion(),
      args: process.argv,
      resources: process.resourcesPath,
    }));
    if (
      !candidate.packaged ||
      !candidate.path.endsWith("app.asar") ||
      candidate.args.includes("--automation-yolo") ||
      candidate.resources !==
        resolve(dirname(this.#executable!), "../Resources")
    )
      throw new Error(
        "Acceptance requires the actual packaged production candidate",
      );
    this.#provenance = {
      ...this.#provenance,
      appVersion: candidate.version,
      executable: this.#executable!,
    };
    const page = await application.firstWindow({
      timeout: Math.max(1, Math.min(30_000, context.deadlineAt - Date.now())),
    });
    this.#page = page;
    this.#unsubscribe = await this.#events.attach(page);
    context.signal.throwIfAborted();
  }

  async launch(context: DriverContext): Promise<void> {
    this.#launching = this.#launch(context);
    await this.#launching;
  }

  async provision(context: DriverContext): Promise<DependencyInventory> {
    if (this.#ownedRunId && this.#ownedRunId !== context.runId)
      throw new Error(
        "Packaged driver cannot be reused across independent cases",
      );
    this.#ownedRunId = context.runId;
    this.#provisioning ??= this.#provision(context);
    return this.#provisioning;
  }

  async #provision(context: DriverContext): Promise<DependencyInventory> {
    const staged = required(context.stagedFixture, "staged fixture");
    if (context.fixture.qualification !== "reviewed-live")
      throw new Error("Synthetic fixtures cannot qualify real Live");
    if (
      context.fixture.dependencies.includes("machine-listening") &&
      !context.fixture.listenerBindings?.length
    )
      throw new Error(
        "Machine-listening requires reviewed saved listener bindings",
      );
    this.#approvalPolicy = new ScopedApprovalPolicy(
      context.scenario.permissions,
    );
    if (context.scenario.requiredCapabilities.includes("session-audio"))
      validateSupportedAudioBaseline(context.fixture.baseline);
    await this.#live.assertNoPreExistingLive();
    this.#executable = await packagedExecutable(
      this.options.executablePath
        ? { explicit: this.options.executablePath }
        : {},
    );
    this.#provenance = {
      candidateSha256: await packagedCandidateHash(
        this.#executable,
        context.signal,
      ),
    };
    if (context.fixture.builtinResources?.length)
      this.#provenance = {
        ...this.#provenance,
        builtinResourcesSha256: await verifyBuiltinResources(
          context.fixture.builtinResources,
          this.options.liveApplicationPath ??
            "/Applications/Ableton Live 11 Suite.app",
          context.signal,
        ),
      };
    this.#profile = join(this.options.runDirectory, "profile");
    await mkdir(this.#profile, { mode: 0o700 });
    const storage = resolveLiveAgentStorage({
      environment: {
        LIVE_AGENT_HOME: join(this.#profile, "live-agent"),
        LIVE_AGENT_PROFILE: "automation",
      },
    });
    this.#preservationPaths = new Set(
      staged.resources.map(({ target }) => target),
    );
    const provisioned = await provisionPackagedDependencies({
      resourcesPath: resolve(dirname(this.#executable), "../Resources"),
      workingDirectory: staged.workingDirectory,
      dependencies: context.fixture.dependencies,
      storage,
      signal: context.signal,
      ...(context.fixture.listenerBindings
        ? { listenerBindings: context.fixture.listenerBindings }
        : {}),
    });
    this.#dependencies = provisioned.hashes;
    this.#candidateInventory = provisioned.inventory;
    this.#preparedProject = provisioned.inventory.preparedProject
      ? join(
          staged.workingDirectory,
          provisioned.inventory.preparedProject.target,
        )
      : staged.projectPath;
    for (const resource of [
      ...provisioned.inventory.resources,
      ...(provisioned.inventory.generatedConfigurations ?? []),
      ...(provisioned.inventory.frozenDevices ?? []),
      ...(provisioned.inventory.preparedProject
        ? [provisioned.inventory.preparedProject]
        : []),
    ])
      this.#preservationPaths.add(resource.target);
    inspectAcceptanceProject(
      await readFile(this.#preparedProject),
      this.#preservationPaths,
      context.scenario.requiredCapabilities.includes("session-audio"),
      context.fixture.builtinResources,
    );
    context.signal.throwIfAborted();
    return provisioned.inventory;
  }

  async #launch(context: DriverContext): Promise<void> {
    await this.provision(context);
    await this.#live.assertNoPreExistingLive();
    context.signal.throwIfAborted();
    await this.#live.launch(
      this.options.liveApplicationPath ??
        "/Applications/Ableton Live 11 Suite.app",
      30_000,
      { fixturePath: required(this.#preparedProject, "prepared project") },
    );
    context.signal.throwIfAborted();
    await waitForRunnerOwnedLiveReady(this.#live, {
      timeoutMs: Math.max(1, Math.min(60_000, context.deadlineAt - Date.now())),
      discardRecovery: false,
    });
    context.signal.throwIfAborted();
    await this.#launchDesktop(context);
  }

  async ready(context: DriverContext): Promise<SessionIdentity> {
    return this.#ready(context, true);
  }

  async #ready(
    context: DriverContext,
    requireLiveListeners: boolean,
  ): Promise<SessionIdentity> {
    for (;;) {
      context.signal.throwIfAborted();
      const state = await this.#getPage().evaluate(async () => {
        const lifecycle = await window.desktop.lifecycle.get();
        if (!["ready", "degraded"].includes(lifecycle)) return null;
        const sessions = await window.desktop.agent.getSessions();
        if (sessions.length === 0) return null;
        const outputs = await window.desktop.outputs.list();
        if (!sessions.some(({ id }) => id === outputs.activeSessionId))
          return null;
        return {
          lifecycle,
          sessions,
          outputs,
          connection: await window.desktop.ableton.getStatus(),
          auth: await window.desktop.agents.getAuthStatus(),
          agents: await window.desktop.agents.listActive(),
        };
      });
      if (state === null) {
        await pause(context);
        continue;
      }
      if (state.connection.state === "error")
        throw new Error(
          `Live connection prerequisite: ${state.connection.code}`,
        );
      const session = state.sessions.find(
        ({ id }) => id === state.outputs.activeSessionId,
      );
      const agent = state.agents.find(
        ({ id }) => id === session?.selectedAgentInstanceId,
      );
      if (
        ["ready", "degraded"].includes(state.lifecycle) &&
        state.connection.state === "connected" &&
        state.auth.state === "authenticated" &&
        agent?.lifecycle === "ready" &&
        agent.sdkSessionId !== undefined &&
        session
      ) {
        if (requireLiveListeners && context.fixture.listenerBindings?.length) {
          const listeners = state.outputs.connections.filter(
            (entry) =>
              entry.state === "connected" && entry.signalKind === "audio",
          );
          if (listeners.length < context.fixture.listenerBindings.length) {
            await pause(context);
            continue;
          }
          const expected = context.fixture.listenerBindings
            .map((binding) => binding.trackIndex)
            .sort((a, b) => a - b);
          const observed = listeners
            .map((listener) => listener.track?.index)
            .sort((a, b) => (a ?? -1) - (b ?? -1));
          if (
            JSON.stringify(expected) !== JSON.stringify(observed) ||
            listeners.some((listener) => !listener.device?.id) ||
            new Set(listeners.map((listener) => listener.device?.id)).size !==
              listeners.length
          )
            throw new Error(
              "Discovered listener inventory differs from declared placements",
            );
        }
        if (
          agent.definitionName !== "default" ||
          agent.modified ||
          agent.autoApprove ||
          agent.mode === "plan"
        )
          throw new Error(
            "Acceptance requires unmodified Default agent and normal approvals",
          );
        if (!state.connection.liveVersion.startsWith("11."))
          throw new Error("Acceptance supports Ableton Live 11 only");
        this.#provenance = {
          ...this.#provenance,
          liveVersion: state.connection.liveVersion,
          definitionFingerprint: agent.definitionFingerprint,
        };
        const descriptorPath = this.#descriptor();
        const info = await lstat(descriptorPath).catch((error: unknown) => {
          if (
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          )
            return undefined;
          throw error;
        });
        if (!info) {
          await pause(context);
          continue;
        }
        if (!info.isFile() || info.isSymbolicLink() || info.size > 32_768)
          throw new Error("Invalid owned automation descriptor");
        const descriptor = automationDiscoveryDescriptorSchema.parse(
          JSON.parse(await readFile(descriptorPath, "utf8")),
        );
        if (descriptor.processId !== this.#application!.process().pid)
          throw new Error(
            "Automation endpoint is not owned by the launched application",
          );
        const identity = {
          appSessionId: session.id,
          agentId: agent.id,
          conversationId: agent.sdkSessionId,
        };
        this.#identity = identity;
        return identity;
      }
      if (state.auth.state !== "authenticated" && state.lifecycle === "ready")
        throw new Error(
          `Packaged authentication prerequisite: ${state.auth.state}`,
        );
      if (agent?.lifecycle === "failed" || agent?.lifecycle === "blocked")
        throw new Error(`Default agent prerequisite: ${agent.lifecycle}`);
      await pause(context);
    }
  }

  async #jobs(context: DriverContext): Promise<readonly DesktopListeningJob[]> {
    const identity = required(this.#identity, "session identity");
    const jobs = await this.#getPage().evaluate(
      async (request) => (await window.desktop.listening.list(request)).jobs,
      {
        sessionId: identity.appSessionId,
        agentId: identity.agentId,
        trace: {
          traceId: context.traceId,
          correlationId: context.correlationId,
          causationId: context.causationId,
        },
      },
    );
    if (jobs.length >= 100)
      throw new Error("Listening inventory may be truncated");
    return jobs;
  }

  async #readTrace(
    context: DriverContext,
    traceId = context.traceId,
  ): Promise<TelemetryEventPage["items"]> {
    const items: TelemetryEventPage["items"] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let bytes = 0;
    do {
      context.signal.throwIfAborted();
      const page = await this.#getPage().evaluate(
        ({ traceId, options }) =>
          window.desktop.eventHistory.trace(traceId, options),
        {
          traceId,
          options: {
            limit: 500,
            order: "asc" as const,
            ...(cursor ? { cursor } : {}),
          },
        },
      );
      context.signal.throwIfAborted();
      bytes += Buffer.byteLength(JSON.stringify(page.items), "utf8");
      if (items.length + page.items.length > 10_000 || bytes > 32 * 1024 * 1024)
        throw new Error("Required product trace exceeded its evidence bound");
      items.push(...page.items);
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor))
        throw new Error("History pagination did not advance");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    const merged = new Map(this.#traceEvents.map((event) => [event.id, event]));
    for (const event of items) merged.set(event.id, event);
    if (
      merged.size > 10_000 ||
      Buffer.byteLength(JSON.stringify([...merged.values()]), "utf8") >
        32 * 1024 * 1024
    )
      throw new Error("Combined product trace exceeded its evidence bound");
    this.#traceEvents = [...merged.values()].sort(
      (a, b) => a.sequence - b.sequence,
    );
    return items;
  }

  async readBaseline(context: DriverContext): Promise<BaselineEvidence> {
    const facts = context.fixture.baseline;
    const snapshot = await this.#getPage().evaluate(() =>
      window.desktop.ableton.requestSnapshot(),
    );
    this.#snapshot = snapshot;
    if (context.fixture.listenerBindings?.length) {
      for (const binding of context.fixture.listenerBindings) {
        const device = snapshot.devices?.find(
          (entry) =>
            entry.trackIndex === binding.trackIndex &&
            entry.index === binding.deviceIndex,
        );
        if (!device?.enabled || device.className !== "MxDeviceAudioEffect")
          throw new Error(
            "Loaded listener placement differs from reviewed slot",
          );
      }
      this.#provenance = {
        ...this.#provenance,
        ...(await verifyActiveFrozenCandidate({
          live: required(this.#live.publicRecord(), "owned Live"),
          workingDirectory: required(context.stagedFixture, "staged fixture")
            .workingDirectory,
          inventory: required(this.#candidateInventory, "candidate inventory"),
          instances: context.fixture.listenerBindings.length,
          signal: context.signal,
        })),
      };
    }
    if ((await this.#jobs(context)).length !== 0)
      throw new Error(
        "Fresh acceptance profile contains an unexpected listening pass",
      );
    if (!context.scenario.requiredCapabilities.includes("session-audio")) {
      return {
        schemaVersion: 1,
        facts: {
          ...this.#provenance,
          tempo: snapshot.tempo,
          trackCount: snapshot.tracks.length,
        },
        dependencyHashes: this.#dependencies,
      };
    }
    if (
      typeof facts.sceneIndex !== "number" ||
      !Number.isInteger(facts.sceneIndex)
    )
      throw new Error("Fixture baseline requires a sceneIndex");
    const target = resolveSessionSource(snapshot, {
      trackName: stringFact(facts, "trackName"),
      clipName: stringFact(facts, "clipName"),
      sceneIndex: facts.sceneIndex,
    });
    this.#preflightTraces.add(target.queryId);
    const preflight = await this.#getPage().evaluate(
      (request) =>
        window.desktop.ableton.inspectSessionListeningPreflight(request),
      target,
    );
    const { source, audio, recording } = preflight;
    if (
      !audio.filePath ||
      audio.sampleRate === null ||
      audio.sampleRate <= 0 ||
      audio.sampleLength === null ||
      audio.sampleLength <= 0
    )
      throw new Error("Loaded audio path and sample metadata are required");
    if (
      typeof source.after.targetRecording !== "boolean" ||
      typeof recording.state.arrangementRecord !== "boolean" ||
      typeof recording.state.sessionRecord !== "boolean"
    )
      throw new Error("Recording baseline evidence is unavailable");
    const outputs = await this.#getPage().evaluate(() =>
      window.desktop.outputs.list(),
    );
    const listeners = outputs.connections.filter(
      (connection) =>
        connection.state === "connected" &&
        connection.signalKind === "audio" &&
        (context.fixture.listenerBindings?.length
          ? context.fixture.listenerBindings.some((binding) => {
              const track = snapshot.tracks.find(
                (entry) => entry.id === target.target.track.expectedReference,
              );
              const device = snapshot.devices?.find(
                (entry) =>
                  entry.trackIndex === binding.trackIndex &&
                  entry.index === binding.deviceIndex,
              );
              return (
                track?.index === binding.trackIndex &&
                connection.track?.index === binding.trackIndex &&
                connection.track?.name === track.name &&
                connection.device?.name === device?.name
              );
            })
          : connection.track?.id === target.target.track.expectedReference),
    );
    if (listeners.length !== 1)
      throw new Error(
        "Fixture requires one independently bound audio listener",
      );
    const media = context.fixture.resources.filter((resource) =>
      isFixtureMediaTarget(resource.target),
    );
    if (media.length !== 1)
      throw new Error(
        "Session audio driver requires one declared source media asset",
      );
    this.#target = target;
    this.#snapshot = snapshot;
    const mediaSha256 = await verifyStagedMedia(
      required(context.stagedFixture, "staged fixture"),
      audio.filePath,
      media[0]!.sha256,
      context.signal,
    );
    this.#sourceSettingsHash = sourceFingerprint(preflight);
    this.#listenerId = listeners[0]!.producerId;
    this.#source = {
      trackId: target.target.track.expectedReference,
      clipId: target.target.expectedClipReference,
      slotIndex: target.target.sceneIndex,
      mediaSha256,
    };
    let followActionsEnabled = source.settings.followActionEnabled;
    let followActionEvidence = "live-api";
    if (followActionsEnabled === null) {
      const saved = await readFile(
        required(this.#preparedProject, "prepared project"),
      );
      followActionsEnabled = readSavedFollowAction(
        saved,
        target.target.track.index,
        target.target.sceneIndex,
      );
      followActionEvidence = `saved-set:${createHash("sha256").update(saved).digest("hex")}`;
    }
    const observed: Facts = {
      ...this.#provenance,
      trackName: target.target.track.expectedName,
      clipName: target.target.expectedClipName,
      sceneIndex: target.target.sceneIndex,
      tempo: source.settings.tempoBpm,
      globalQuantization:
        source.settings.globalQuantization === 0 ? "none" : "unsupported",
      clipLaunchQuantization:
        source.settings.launchQuantization === 0 ? "global" : "unsupported",
      transportPlaying: source.after.transportPlaying,
      currentSongTime: source.after.globalBeat,
      playingSessionClips: snapshot.sessionClips!.filter(
        (clip) => clip.status === "playing",
      ).length,
      queuedSessionClips: snapshot.sessionClips!.filter(
        (clip) => clip.status === "queued",
      ).length,
      recording:
        source.after.targetRecording ||
        recording.state.arrangementRecord ||
        recording.state.sessionRecord,
      arrangementRecord: recording.state.arrangementRecord,
      sessionRecord: recording.state.sessionRecord,
      mediaSampleRate: audio.sampleRate,
      mediaFrames: audio.sampleLength,
      sourceQueryId: target.queryId,
      signatureNumerator: source.settings.signatureNumerator,
      signatureDenominator: source.settings.signatureDenominator,
      clipWarped: source.sourceKind === "warped-audio",
      clipStart: source.settings.startMarker,
      loopStart: source.settings.loopStart,
      loopEnd: source.settings.loopEnd,
      activeLengthBeats: snapshot.sessionClips!.find(
        (clip) => clip.id === target.target.expectedClipReference,
      )!.lengthBeats,
      launchMode: source.settings.launchMode === 0 ? "trigger" : "unsupported",
      legato: source.settings.legato,
      followActionsEnabled,
      followActionEvidence,
      listenerBoundToSource: true,
    };
    const evidence = {
      schemaVersion: 1,
      loadedMediaPath: audio.filePath,
      facts: observed,
      source: this.#source,
      listenerId: this.#listenerId,
      dependencyHashes: this.#dependencies,
    };
    validateAudioBaselineEvidence(evidence);
    return evidence;
  }

  async subscribe(): Promise<TurnSubscription> {
    this.#events.read();
    return {
      waitForTurn: (submission, context) =>
        this.#waitForTurn(submission, context),
      close: async () => {
        await this.#unsubscribe?.();
        this.#unsubscribe = undefined;
      },
    };
  }

  async submit(
    step: ScenarioStep,
    context: DriverContext,
  ): Promise<Submission> {
    context.signal.throwIfAborted();
    const identity = required(this.#identity, "session identity");
    const priorPasses = new Set(
      (await this.#jobs(context)).map(({ passId }) => passId),
    );
    const eventOffset = this.#events.read().length;
    context.signal.throwIfAborted();
    const accepted = await sendAutomationMessage({
      descriptorPath: this.#descriptor(),
      message: step.message,
      timeoutMs: Math.max(1, Math.min(5_000, context.deadlineAt - Date.now())),
      expectedTarget: {
        appSessionId: identity.appSessionId,
        agentInstanceId: identity.agentId,
        sdkSessionId: identity.conversationId,
      },
      trace: {
        traceId: context.traceId,
        spanId: randomUUID(),
        correlationId: context.correlationId,
      },
    });
    if (!accepted.turn)
      throw new Error(
        "Automation acknowledgement lacks attributable turn linkage",
      );
    this.#submissions.set(accepted.messageId, {
      assistantMessageId: accepted.turn.assistantMessageId,
      eventOffset,
      priorPasses,
      message: step.message,
    });
    return {
      ...identity,
      userMessageId: accepted.messageId,
      operationId: accepted.messageId,
    };
  }

  async #readContext(
    contextId: string,
    context: DriverContext,
  ): Promise<DesktopContextDetail> {
    const identity = required(this.#identity, "session identity");
    const detail = await this.#getPage().evaluate(
      (request) => window.desktop.entityContext.get(request),
      {
        sessionId: identity.appSessionId,
        contextId,
        includeHistorical: true,
        trace: {
          traceId: context.traceId,
          correlationId: context.correlationId,
          causationId: context.causationId,
        },
      },
    );
    if (detail.entry.contextId !== contextId)
      throw new Error("Context query returned a different context");
    return detail;
  }

  #context(
    detail: DesktopContextDetail,
    afterOwnedRestart: boolean,
    trace: { traceId: string; correlationId: string },
  ): ContextEvidence {
    const observation = metricAudioObservationSchema.parse(detail.observation);
    if (
      observation.source.view !== "session" ||
      observation.source.kind !== "warped-audio"
    )
      throw new Error("Expected persisted Session source evidence");
    if (
      observation.ownership.passId !== detail.entry.passId ||
      observation.ownership.listenerId !== detail.entry.listenerId ||
      observation.ownership.traceId !== trace.traceId ||
      observation.ownership.correlationId !== trace.correlationId
    )
      throw new Error("Context entry and observation ownership differ");
    return {
      contextId: detail.entry.contextId,
      passId: detail.entry.passId,
      source: {
        ...required(this.#source, "source"),
        trackId: observation.source.target.track.expectedReference,
        clipId: observation.source.clipReference,
        slotIndex: observation.source.target.sceneIndex,
      },
      contentSha256: hash(observation),
      readable: true,
      afterOwnedRestart,
    };
  }

  async #waitForTurn(
    submission: Submission,
    context: DriverContext,
  ): Promise<TurnEvidence> {
    const link = required(
      this.#submissions.get(submission.userMessageId),
      "submitted turn",
    );
    turnLoop: for (;;) {
      context.signal.throwIfAborted();
      const events = this.#events.read().slice(link.eventOffset);
      await this.#handleApprovals(events, submission);
      const submitted = events.filter(
        (event) =>
          event.type === "agent.user_message_submitted" &&
          event.messageId === submission.userMessageId,
      );
      if (submitted.length > 1)
        throw new Error("Duplicate accepted user message");
      const accepted = submitted[0];
      if (
        accepted?.type === "agent.user_message_submitted" &&
        (accepted.agentInstanceId !== submission.agentId ||
          accepted.traceId !== context.traceId ||
          accepted.correlationId !== context.correlationId ||
          accepted.content !== link.message ||
          accepted.turn?.assistantMessageId !== link.assistantMessageId ||
          accepted.turn.target.appSessionId !== submission.appSessionId ||
          accepted.turn.target.agentInstanceId !== submission.agentId ||
          accepted.turn.target.sdkSessionId !== submission.conversationId)
      )
        throw new Error(
          "Accepted user event does not match the submitted turn",
        );
      if (
        events.some(
          (event) =>
            (event.type === "agent.plan_approval_requested" ||
              event.type === "agent.elicitation_requested") &&
            event.agentInstanceId === submission.agentId,
        )
      )
        throw new Error(
          "Unexpected interactive request requires a reviewed scenario handler",
        );
      const activities = new Set(
        events.flatMap((event) =>
          event.type === "agent.working_update" &&
          event.update.kind === "started" &&
          event.messageId === link.assistantMessageId &&
          event.agentInstanceId === submission.agentId &&
          event.sdkSessionId === submission.conversationId
            ? [event.update.activityId]
            : [],
        ),
      );
      if (activities.size > 1)
        throw new Error(
          "More than one SDK turn started for one submitted message",
        );
      const sdkTurnId = activities.values().next().value;
      if (sdkTurnId) this.#sdkTurns.set(submission.userMessageId, sdkTurnId);
      const completed = events
        .filter(
          (event) =>
            event.type === "agent.message_complete" &&
            event.messageId === link.assistantMessageId &&
            event.agentInstanceId === submission.agentId &&
            event.sdkSessionId === submission.conversationId,
        )
        .at(-1);
      const operation = events
        .filter(
          (event) =>
            event.type === "operation.changed" &&
            event.operation.id === submission.operationId &&
            event.agentInstanceId === submission.agentId &&
            event.sdkSessionId === submission.conversationId,
        )
        .at(-1);
      if (
        operation?.type === "operation.changed" &&
        ["failed", "cancelled", "partial"].includes(
          operation.operation.status,
        ) &&
        completed === undefined
      )
        throw new Error(
          `Turn ended ${operation.operation.status} without a terminal assistant response`,
        );
      if (
        submitted.length === 1 &&
        completed?.type === "agent.message_complete" &&
        operation?.type === "operation.changed" &&
        ["completed", "partial", "failed", "cancelled"].includes(
          operation.operation.status,
        )
      ) {
        if (!sdkTurnId)
          throw new Error(
            "Terminal response has no attributable SDK turn activity",
          );
        const sdkTrace = { traceId: sdkTurnId, correlationId: sdkTurnId };
        const jobs = (await this.#jobs(context)).filter(
          (job) => !link.priorPasses.has(job.passId),
        );
        if (
          jobs.some(
            (job) =>
              ![
                "completed",
                "partial",
                "failed",
                "cancelled",
                "interrupted",
              ].includes(job.stage),
          )
        ) {
          await pause(context);
          continue;
        }
        const captures: CaptureEvidence[] = [];
        const contexts: ContextEvidence[] = [];
        const trace = jobs.length
          ? await this.#readTrace(context, sdkTurnId)
          : [];
        for (const job of jobs) {
          if (
            job.trace.traceId !== sdkTrace.traceId ||
            job.trace.correlationId !== sdkTrace.correlationId ||
            job.agentId !== submission.agentId ||
            job.sessionId !== submission.appSessionId
          )
            throw new Error("Listening pass belongs to a different turn owner");
          if (job.stage !== "completed" || job.contextIds.length !== 1)
            throw new Error(
              `Listening pass did not publish one complete context: ${job.stage}`,
            );
          const detail = await this.#readContext(job.contextIds[0]!, context);
          const observed = metricAudioObservationSchema.parse(
            detail.observation,
          );
          const persisted = this.#context(detail, false, sdkTrace);
          if (
            observed.ownership.passId !== job.passId ||
            detail.entry.listenerId !== observed.ownership.listenerId ||
            observed.ownership.causationId !== job.trace.causationId
          )
            throw new Error("Listening context attribution mismatch");
          const cleanupComplete = captureCleanupConfirmed(trace, {
            ...sdkTrace,
            passId: job.passId,
            listenerId: observed.ownership.listenerId,
            sessionId: submission.appSessionId,
            agentId: submission.agentId,
          });
          if (!cleanupComplete) {
            await pause(context);
            continue turnLoop;
          }
          this.#contexts.set(persisted.contextId, persisted);
          this.#contextTraces.set(persisted.contextId, sdkTrace);
          captures.push({
            passId: job.passId,
            operationId: submission.operationId,
            source: persisted.source,
            listenerId: observed.ownership.listenerId,
            complete: observed.outcome === "complete",
            nonSilent: observed.metrics.level.records.some((record) =>
              record.rms.some((value) => value > 0.0001),
            ),
            truncated: observed.reduction.mode !== "none",
            missingRecords: Object.values(observed.metrics).reduce(
              (sum, metric) =>
                sum + metric.gaps.reduce((count, gap) => count + gap.count, 0),
              0,
            ),
            metricFamilies: observed.requestedMetrics.filter(
              (metric) => observed.metrics[metric].status === "complete",
            ),
            sampleRate: observed.geometry.sampleRate,
            startSample: observed.geometry.startSample,
            endSample: observed.sourceCoverage.endSample,
            cleanupComplete,
            failure: job.error ?? null,
          });
        }
        for (const contextId of this.#contexts.keys())
          contexts.push(
            this.#context(
              await this.#readContext(contextId, context),
              false,
              required(this.#contextTraces.get(contextId), "context SDK trace"),
            ),
          );
        return {
          schemaVersion: 1,
          ...submission,
          assistantMessageId: link.assistantMessageId,
          terminal: true,
          status:
            operation.operation.status === "completed"
              ? "completed"
              : operation.operation.status === "cancelled"
                ? "cancelled"
                : "failed",
          assistantText: completed.content,
          captures,
          contexts,
          facts: { sdkTurnId },
        };
      }
      await pause(context);
    }
  }

  async #handleApprovals(
    events: readonly DesktopAppEvent[],
    submission: Submission,
  ): Promise<void> {
    for (const event of events) {
      if (
        event.type !== "approval.requested" ||
        this.#handledApprovals.has(event.approval.id)
      )
        continue;
      const owner = {
        operationId: submission.operationId,
        appSessionId: submission.appSessionId,
        agentId: submission.agentId,
        conversationId: submission.conversationId,
      };
      if (
        event.operationId !== owner.operationId ||
        event.appSessionId !== owner.appSessionId ||
        event.agentInstanceId !== owner.agentId ||
        event.sdkSessionId !== owner.conversationId
      )
        throw new Error(
          "Approval has no matching pending turn ownership; it was not resolved",
        );
      this.#handledApprovals.add(event.approval.id);
      const tool = event.approval.tool;
      let permitted = false;
      let invalidArguments: Error | undefined;
      if (tool?.argumentsComplete && tool.action) {
        try {
          permitted = required(
            this.#approvalPolicy,
            "reviewed approval policy",
          ).decide(
            {
              ...owner,
              tool: tool.name,
              action: tool.action,
              arguments: tool.arguments,
              risk: event.approval.risk,
              destructive: event.approval.destructive,
            },
            owner,
            this.#source,
          );
        } catch (error) {
          invalidArguments =
            error instanceof Error
              ? error
              : new Error("Invalid approval arguments");
        }
      }
      const resolved = await this.#getPage().evaluate(
        ({ id, decision }) => window.desktop.approvals.resolve(id, decision),
        {
          id: event.approval.id,
          decision: permitted ? ("approve" as const) : ("deny" as const),
        },
      );
      if (!resolved) throw new Error("Reviewed approval is no longer pending");
      if (invalidArguments) throw invalidArguments;
      if (!permitted)
        throw new Error("Unexpected approval: no reviewed scoped rule matched");
    }
  }

  async collect(context: DriverContext): Promise<RunEvidence> {
    const capturePassIds = new Set(
      (await this.#jobs(context)).map(({ passId }) => passId),
    );
    const snapshot = await this.#getPage().evaluate(() =>
      window.desktop.ableton.requestSnapshot(),
    );
    const unchanged = [
      {
        scope: "session-structure",
        beforeSha256: sessionStructureFingerprint(
          required(this.#snapshot, "baseline"),
        ),
        afterSha256: sessionStructureFingerprint(snapshot),
      },
      {
        scope: "unrelated-playback",
        beforeSha256: unrelatedPlaybackFingerprint(
          required(this.#snapshot, "baseline"),
          this.#source?.clipId,
        ),
        afterSha256: unrelatedPlaybackFingerprint(
          snapshot,
          this.#source?.clipId,
        ),
      },
    ];
    if (this.#target) {
      const request = { ...this.#target, queryId: randomUUID() };
      this.#preflightTraces.add(request.queryId);
      const preflight = await this.#getPage().evaluate(
        (request) =>
          window.desktop.ableton.inspectSessionListeningPreflight(request),
        request,
      );
      if (!preflight.audio.filePath)
        throw new Error("Loaded media path disappeared");
      await verifyStagedMedia(
        required(context.stagedFixture, "staged fixture"),
        preflight.audio.filePath,
        required(this.#source, "source").mediaSha256,
        context.signal,
      );
      unchanged.push({
        scope: "source-settings",
        beforeSha256: required(this.#sourceSettingsHash, "source settings"),
        afterSha256: sourceFingerprint(preflight),
      });
    }
    const mediaBefore: { target: string; sha256: string }[] = [];
    const mediaAfter: { target: string; sha256: string }[] = [];
    for (const resource of context.stagedFixture!.resources) {
      const bytes = await readFile(
        join(context.stagedFixture!.workingDirectory, resource.target),
      );
      const afterSha256 = createHash("sha256").update(bytes).digest("hex");
      if (isFixtureMediaTarget(resource.target)) {
        mediaBefore.push({ target: resource.target, sha256: resource.sha256 });
        mediaAfter.push({ target: resource.target, sha256: afterSha256 });
      } else
        unchanged.push({
          scope: "project-file",
          beforeSha256: resource.sha256,
          afterSha256,
        });
    }
    unchanged.push({
      scope: "fixture-media",
      beforeSha256: hash(mediaBefore),
      afterSha256: hash(mediaAfter),
    });
    const previous = required(this.#identity, "session identity");
    const afterRestart =
      context.scenario.requiredCapabilities.includes("persistence");
    if (afterRestart) {
      await this.#closeDesktop();
      await this.#launchDesktop(context);
      // Native disconnect deliberately requires device reload. Persistence is a
      // read-only restore check, not another capture or a reconnect qualification.
      const restored = await this.#ready(context, false);
      if (JSON.stringify(restored) !== JSON.stringify(previous))
        throw new Error(
          "Restart did not restore the same agent conversation and App session",
        );
    }
    const contexts: ContextEvidence[] = [];
    for (const contextId of this.#contexts.keys())
      contexts.push(
        this.#context(
          await this.#readContext(contextId, context),
          afterRestart,
          required(this.#contextTraces.get(contextId), "context SDK trace"),
        ),
      );
    for (const job of await this.#jobs(context)) capturePassIds.add(job.passId);
    await this.#readTrace(context);
    for (const traceId of new Set(this.#sdkTurns.values()))
      await this.#readTrace(context, traceId);
    for (const traceId of this.#preflightTraces)
      await this.#readTrace(context, traceId);
    return {
      schemaVersion: 1,
      capturePassIds: [...capturePassIds],
      facts: { ...this.#provenance, persistedContexts: contexts.length },
      contexts,
      unchanged,
    };
  }

  async #closeDesktop(): Promise<void> {
    const failures: Error[] = [];
    try {
      await this.#unsubscribe?.();
    } catch (error) {
      failures.push(error instanceof Error ? error : new Error(String(error)));
    }
    this.#unsubscribe = undefined;
    if (this.#application) {
      const result = await closeOwnedPackagedApplication(this.#application);
      if (!result.successful)
        failures.push(new Error("Owned Desktop shutdown failed"));
      if (result.stopped) {
        this.#application = undefined;
        this.#page = undefined;
      }
    }
    if (failures.length)
      throw new AggregateError(failures, "Desktop cleanup failed");
  }

  async cleanup(context: DriverContext): Promise<void> {
    const failures: unknown[] = [];
    if (this.#identity && this.#page && !this.#page.isClosed()) {
      const signal = AbortSignal.any([
        context.signal,
        AbortSignal.timeout(5_000),
      ]);
      try {
        await observe(async () => {
          await this.#readTrace({ ...context, signal });
          for (const traceId of new Set(this.#sdkTurns.values()))
            await this.#readTrace({ ...context, signal }, traceId);
          for (const traceId of this.#preflightTraces)
            await this.#readTrace({ ...context, signal }, traceId);
        }, signal);
      } catch (error) {
        failures.push(error);
      }
    }
    // Closing a known process releases blocked page calls before awaiting a late launch.
    try {
      await this.#closeDesktop();
    } catch (error) {
      failures.push(error);
    }
    if (this.#launching) await this.#launching.catch(() => undefined);
    if (this.#desktopLaunching)
      await this.#desktopLaunching.catch(() => undefined);
    if (this.#provisioning) await this.#provisioning.catch(() => undefined);
    try {
      await writeScenarioReceipt(
        join(this.options.runDirectory, "product-evidence.json"),
        {
          schema: "acceptance-product-evidence/v1",
          traceId: context.traceId,
          provenance: this.#provenance,
          dependencyHashes: this.#dependencies,
          liveProcess: this.#live.publicRecord(),
          desktop: this.#events.diagnostics(),
          history: this.#traceEvents,
        },
      );
    } catch (error) {
      failures.push(error);
    }
    if (this.#application) {
      try {
        await this.#closeDesktop();
      } catch (error) {
        failures.push(error);
      }
    }
    let liveStopped = true;
    if (this.#live.publicRecord()) {
      try {
        await this.#live.discardAfterFailure();
      } catch (error) {
        liveStopped = false;
        failures.push(error);
      }
    }
    if (!this.#application && liveStopped && this.#profile) {
      try {
        await rm(this.#profile, { recursive: true, force: true });
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(failures, "Acceptance cleanup failed");
  }
}
