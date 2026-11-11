import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
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
import { AbletonBridgeService } from "@ableton-agent/bridge";
import { withCorrelation } from "@ableton-agent/correlation";
import { InMemoryEventPublisher } from "@ableton-agent/shared";
import { resolveBridgeCredential } from "../../apps/desktop/src/main/bridge-credentials.js";
import { preferencesSchema } from "../../apps/desktop/src/contracts.js";
import {
  metricAudioObservationSchema,
  sessionListeningPreflightResultSchema,
  type InspectSessionListeningSourceParams,
  type MetricAudioObservation,
} from "@ableton-agent/protocol";
import type {
  AcceptanceDriver,
  SessionSourceEvidence,
  ListenerPlacement,
  SourceIdentity,
  BaselineEvidence,
  CaptureEvidence,
  FlatnessSmokeEvidence,
  SpreadSmokeEvidence,
  RolloffSmokeEvidence,
  PitchSmokeEvidence,
  MelSmokeEvidence,
  ContextEvidence,
  DriverContext,
  DependencyInventory,
  Facts,
  FixtureManifest,
  RunEvidence,
  ScenarioStep,
  SessionIdentity,
  Submission,
  TurnEvidence,
  TurnSubscription,
  AgentListeningEvidence,
  SetupAction,
  SetupEvidence,
} from "@ableton-agent/test-support/integration";
import {
  validateSupportedSessionBaseline,
  declaredSourceBaseline,
  sessionClipQuantizationName,
  validateBaseline,
  validateFixtureSourceEvidence,
  validateMidiSourcePreconditions,
  midiContentIdentity,
  verifyStagedMedia,
  isFixtureMediaTarget,
  projectFlatnessSmoke,
  projectSpreadSmoke,
  projectRolloffSmoke,
  projectPitchSmoke,
  validatePitchBinaryProof,
  projectMelSmoke,
  validateMelBinaryProof,
  collectAgentListeningEvidence,
  verifyRestoredAgentListeningEvidence,
  projectFeatureSource,
  projectFeatureSearchHistory,
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
import type { LiveHostLease } from "../../scripts/lib/live-host-lease.mjs";
import { waitForRunnerOwnedLiveReady } from "../../scripts/lib/live-ux-host.mjs";
import {
  closeOwnedPackagedApplication,
  type PackagedCleanupReceipt,
} from "./packaged-cleanup.js";
import { AcceptanceCleanup } from "./acceptance-cleanup.js";
import {
  packagedExecutable,
  packagedCandidateHash,
  finderLikeEnvironment,
} from "./packaged-paths.js";
import { provisionPackagedDependencies } from "./acceptance-dependencies.js";
import { verifyActiveFrozenCandidate } from "./acceptance-loading.js";
import {
  verifyLoadedFlatnessBinary,
  verifyLoadedMelBinary,
  verifyLoadedPitchBinary,
} from "./acceptance-flatness-loading.js";
import {
  inspectAcceptanceProject,
  verifyInstalledLiveResources,
  readSavedFollowAction,
} from "./acceptance-project.js";
import { AcceptanceEvents } from "./acceptance-events.js";
import {
  resolveSessionSource,
  sessionStructureFingerprint,
  unrelatedPlaybackFingerprint,
  sourceStoppedAtZero,
  sourceStoppedAtPosition,
} from "./acceptance-source.js";
import {
  captureCleanupConfirmed,
  observedSessionSource,
  restoreFlatnessSmoke,
  restoreSpreadSmoke,
  restoreRolloffSmoke,
  restorePitchSmoke,
  restoreMelSmoke,
} from "./acceptance-evidence.js";
import { ScopedApprovalPolicy } from "./acceptance-approvals.js";
import { AcceptanceBridgeTimingProxy } from "./acceptance-bridge-timing.js";

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function sourceFingerprint(
  preflight: DesktopSessionListeningPreflight,
  listener?: ListenerPlacement,
): string {
  return hash({
    sourceKind: preflight.source.sourceKind,
    positionUnit: preflight.source.positionUnit,
    settings: preflight.source.settings,
    content:
      "audio" in preflight
        ? preflight.audio
        : midiContentIdentity(
            preflight,
            required(listener, "MIDI listener placement"),
          ),
    recording: preflight.recording.state,
    targetRecording: preflight.source.after.targetRecording,
  });
}
function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`Missing acceptance ${label}`);
  return value;
}
function measuredCentroid(observation: MetricAudioObservation): {
  spectralCentroidHz?: number;
} {
  let energy = 0;
  let weighted = 0;
  for (const record of observation.metrics["spectral-centroid"].records) {
    if (record.centroidHz === null) continue;
    energy += record.spectralEnergy;
    weighted += record.centroidHz * record.spectralEnergy;
  }
  return energy > 0 ? { spectralCentroidHz: weighted / energy } : {};
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
  readonly bridgeReadMinimumMs?: number;
  readonly hostLease?: LiveHostLease;
}

export type MidiSourceReview = Omit<
  Extract<NonNullable<FixtureManifest["sources"]>[number], { midi: unknown }>,
  "midi"
>;

/** Real Desktop ingress only; no runtime construction or model substitution. */
export class PackagedAcceptanceDriver implements AcceptanceDriver {
  readonly schemaVersion = 1 as const;
  readonly capabilities = [
    "automation",
    "session-audio",
    "session-midi",
    "persistence",
  ] as const;
  readonly #live: LiveProcessController;
  readonly #events = new AcceptanceEvents();
  readonly #submissions = new Map<
    string,
    {
      assistantMessageId: string;
      eventOffset: number;
      priorPasses: ReadonlySet<string>;
      message: string;
      step: ScenarioStep;
    }
  >();
  readonly #contexts = new Map<string, ContextEvidence>();
  readonly #observedCapturePassIds = new Set<string>();
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
  #sources: Record<string, SessionSourceEvidence> = {};
  #targets = new Map<string, InspectSessionListeningSourceParams>();
  #snapshot: DesktopLiveSetSnapshot | undefined;
  #sourceSettingsHashes = new Map<string, string>();
  #listenerIdentities = new Map<string, string>();
  #dependencies: Readonly<Record<string, string>> = {};
  #preparedProject: string | undefined;
  #candidateInventory: DependencyInventory | undefined;
  #executable: string | undefined;
  #profile: string | undefined;
  #preservationPaths = new Set<string>();
  #traceEvents: TelemetryEventPage["items"] = [];
  #flatnessSmoke = new Map<string, FlatnessSmokeEvidence>();
  #spreadSmoke = new Map<string, SpreadSmokeEvidence>();
  #rolloffSmoke = new Map<string, RolloffSmokeEvidence>();
  #pitchSmoke = new Map<string, PitchSmokeEvidence>();
  #melSmoke = new Map<string, MelSmokeEvidence>();
  #historyCollected = false;
  #agentListening: AgentListeningEvidence[] = [];
  #restoredAgentListening: AgentListeningEvidence[] = [];
  readonly #setupExecuted = new Set<SetupAction>();
  #afterOwnedRestart = false;
  #desktopCleanupReceipts: PackagedCleanupReceipt[] = [];
  #omittedDesktopCleanupReceipts = 0;
  #provenance: Facts = {};
  #bridgeTiming: AcceptanceBridgeTimingProxy | undefined;
  #bridgePort: number | undefined;

  constructor(private readonly options: PackagedAcceptanceOptions) {
    this.#live = new LiveProcessController(
      options.hostLease ? { hostLease: options.hostLease } : {},
    );
    if (options.bridgeReadMinimumMs !== undefined)
      this.#bridgeTiming = new AcceptanceBridgeTimingProxy({
        minimumReadMs: options.bridgeReadMinimumMs,
      });
  }

  #assertBridgeTimingHealthy(requireRead = false): void {
    const snapshot = this.#bridgeTiming?.snapshot();
    if (snapshot?.failure)
      throw new Error(`Bridge timing diagnostic failed: ${snapshot.failure}`);
    if (
      snapshot &&
      requireRead &&
      this.options.bridgeReadMinimumMs !== undefined &&
      !snapshot.records.some(
        (record) =>
          record.stage === "request" &&
          record.state === "completed" &&
          record.command !== "[other]" &&
          record.deliveredRoundTripMs !== undefined &&
          record.deliveredRoundTripMs >= snapshot.minimumReadMs,
      )
    )
      throw new Error(
        "Bridge timing diagnostic failed: no completed paced read",
      );
  }

  preservationPaths(): ReadonlySet<string> {
    return this.#preservationPaths;
  }

  #getPage(): Page {
    return required(this.#page, "Desktop page");
  }
  #descriptor(): string {
    return join(required(this.#profile, "profile"), "automation-endpoint.json");
  }

  #storage() {
    return resolveLiveAgentStorage({
      environment: {
        LIVE_AGENT_HOME: join(required(this.#profile, "profile"), "live-agent"),
        LIVE_AGENT_PROFILE: "automation",
      },
    });
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
    if (
      context.scenario.requiredCapabilities.some(
        (kind) => kind === "session-audio" || kind === "session-midi",
      )
    ) {
      if (!context.fixture.sources?.length)
        validateSupportedSessionBaseline(
          context.fixture.baseline,
          context.scenario.requiredCapabilities.includes("session-midi")
            ? "midi"
            : "audio",
        );
      for (const definition of context.fixture.sources ?? [])
        validateSupportedSessionBaseline(
          declaredSourceBaseline(context.fixture, definition),
          "mediaTarget" in definition ? "audio" : "midi",
        );
    }
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
        builtinResourcesSha256: await verifyInstalledLiveResources(
          context.fixture.builtinResources,
          this.options.liveApplicationPath ??
            "/Applications/Ableton Live 11 Suite.app",
          context.signal,
        ),
      };
    if (context.fixture.coreLibraryResources?.length)
      this.#provenance = {
        ...this.#provenance,
        coreLibraryResourcesSha256: await verifyInstalledLiveResources(
          context.fixture.coreLibraryResources,
          this.options.liveApplicationPath ??
            "/Applications/Ableton Live 11 Suite.app",
          context.signal,
          "Core Library",
        ),
      };
    this.#profile = join(this.options.runDirectory, "profile");
    await mkdir(this.#profile, { mode: 0o700 });
    const storage = this.#storage();
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
      context.fixture.coreLibraryResources,
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
      {
        fixturePath: required(this.#preparedProject, "prepared project"),
        signal: context.signal,
      },
    );
    context.signal.throwIfAborted();
    await waitForRunnerOwnedLiveReady(this.#live, {
      timeoutMs: Math.max(1, context.deadlineAt - Date.now()),
      discardRecovery: false,
      requireAudio: (context.fixture.listenerBindings?.length ?? 0) > 0,
      signal: context.signal,
    });
    context.signal.throwIfAborted();
    if (
      context.scenario.steps.some((step) =>
        step.setupActions?.includes("stop-transport"),
      )
    )
      this.#bridgeTiming ??= new AcceptanceBridgeTimingProxy({
        minimumReadMs: 0,
      });
    if (this.#bridgeTiming) {
      this.#bridgePort = await this.#bridgeTiming.start();
      const storage = this.#storage();
      await mkdir(dirname(storage.preferencesPath), { recursive: true });
      await writeFile(
        storage.preferencesPath,
        JSON.stringify(
          preferencesSchema.parse({ abletonPort: this.#bridgePort }),
        ),
        { flag: "wx", mode: 0o600 },
      );
      this.#provenance = {
        ...this.#provenance,
        bridgeTimingMode:
          this.options.bridgeReadMinimumMs === undefined
            ? "exclusive-stop-handoff"
            : "read-response-minimum",
        bridgeReadMinimumMs: this.options.bridgeReadMinimumMs ?? 0,
      };
    }
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
    for (const job of jobs) this.#observedCapturePassIds.add(job.passId);
    if (this.#observedCapturePassIds.size >= 100)
      throw new Error("Run listening inventory exceeds evidence bound");
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
      merged.size >
        10_000 * Math.max(1, Math.min(32, context.scenario.steps.length)) ||
      Buffer.byteLength(JSON.stringify([...merged.values()]), "utf8") >
        32 * 1024 * 1024
    )
      throw new Error("Combined product trace exceeded its evidence bound");
    this.#traceEvents = [...merged.values()].sort(
      (a, b) => a.sequence - b.sequence,
    );
    return items;
  }

  async #readAgentListening(
    context: DriverContext,
    owner: SessionIdentity & { sdkTurnId: string },
    afterOwnedRestart: boolean,
  ): Promise<AgentListeningEvidence> {
    return collectAgentListeningEvidence(
      owner,
      afterOwnedRestart,
      async (query) => {
        context.signal.throwIfAborted();
        if (Date.now() >= context.deadlineAt)
          throw new Error("Agent History evidence deadline exceeded");
        const page = await observe(
          () =>
            this.#getPage().evaluate(
              (query) => window.desktop.eventHistory.agent(query),
              query,
            ),
          context.signal,
        );
        context.signal.throwIfAborted();
        return page;
      },
    );
  }

  #receiptHistory(
    context: DriverContext,
    history: AgentListeningEvidence,
  ): AgentListeningEvidence {
    return context.scenario.assertions.some(
      (assertion) =>
        assertion.name === "feature-search" &&
        assertion.parameters.coverage !== "peak-only",
    )
      ? projectFeatureSearchHistory(history)
      : history;
  }

  async readBaseline(context: DriverContext): Promise<BaselineEvidence> {
    return this.#readBaseline(context);
  }

  async #verifyFlatnessBinary(
    context: DriverContext,
    phase: "baseline" | "capture-completed",
  ): Promise<void> {
    if (
      ![
        "session-flucoma-flatness-smoke",
        "session-flucoma-spread-smoke",
        "session-flucoma-rolloff-smoke",
        "session-flucoma-melbands-smoke",
        "session-flucoma-pitch-smoke",
      ].includes(context.scenario.id)
    )
      return;
    const started = performance.now();
    this.#provenance = {
      ...this.#provenance,
      flatnessLoadedBinaryState: "started",
      flatnessLoadedBinaryVerified: false,
      flatnessLoadedBinaryPhase: phase,
    };
    try {
      const activeNodePids = this.#provenance.activeNodePids;
      if (typeof activeNodePids !== "string")
        throw new Error("Missing independently verified owned Node identities");
      const proof = await verifyLoadedFlatnessBinary({
        live: required(this.#live.publicRecord(), "owned Live"),
        activeNodePids,
        workingDirectory: required(context.stagedFixture, "staged fixture")
          .workingDirectory,
        inventory: required(this.#candidateInventory, "candidate inventory"),
        signal: context.signal,
      });
      this.#provenance = {
        ...this.#provenance,
        ...proof,
        flatnessLoadedBinaryState: "completed",
      };
    } catch (error) {
      this.#provenance = {
        ...this.#provenance,
        flatnessLoadedBinaryState:
          context.signal.aborted ||
          (error instanceof Error && error.name === "AbortError")
            ? "cancelled"
            : "failed",
        flatnessLoadedBinaryError:
          "owned-loader-proof-unavailable-or-mismatched",
      };
      throw error;
    } finally {
      this.#provenance = {
        ...this.#provenance,
        flatnessLoadedBinaryDurationMs: performance.now() - started,
      };
    }
  }

  async #verifyDiagnosticBinary(
    context: DriverContext,
    phase: "baseline" | "capture-completed",
    kind: "mel" | "pitch",
    owner?: MetricAudioObservation["ownership"],
  ): Promise<void> {
    if (
      context.scenario.id !== "session-flucoma-pitch-smoke" &&
      !(
        kind === "mel" &&
        [
          "session-flucoma-melbands-smoke",
          "session-listening-feature-search",
          "session-listening-peak-smoke",
        ].includes(context.scenario.id)
      )
    )
      return;
    const started = performance.now();
    this.#provenance = {
      ...this.#provenance,
      [`${kind}LoadedBinaryVerified`]: false,
      [`${kind}LoadedBinaryState`]: "started",
      [`${kind}LoadedBinaryPhase`]: phase,
    };
    try {
      const activeNodePids = this.#provenance.activeNodePids;
      if (
        typeof activeNodePids !== "string" ||
        (phase === "capture-completed" && !owner)
      )
        throw new Error(
          `Missing independently owned ${kind} acquisition identities`,
        );
      const verify =
        kind === "mel" ? verifyLoadedMelBinary : verifyLoadedPitchBinary;
      const proof = await verify({
        live: required(this.#live.publicRecord(), "owned Live"),
        activeNodePids,
        workingDirectory: required(context.stagedFixture, "staged fixture")
          .workingDirectory,
        inventory: required(this.#candidateInventory, "candidate inventory"),
        signal: context.signal,
      });
      const facts: Facts = {
        ...proof,
        [`${kind}LoadedBinaryState`]: "completed",
        [`${kind}LoadedBinaryPhase`]: phase,
        [`${kind}LoadedBinaryDurationMs`]: performance.now() - started,
        ...(owner
          ? Object.fromEntries(
              Object.entries(owner).map(([key, value]) => [
                `${kind}LoadedBinary${key[0]!.toUpperCase()}${key.slice(1)}`,
                value,
              ]),
            )
          : {}),
      };
      if (kind === "mel") validateMelBinaryProof(facts, phase);
      else validatePitchBinaryProof(facts, phase);
      this.#provenance = { ...this.#provenance, ...facts };
    } catch (error) {
      this.#provenance = {
        ...this.#provenance,
        [`${kind}LoadedBinaryVerified`]: false,
        [`${kind}LoadedBinaryState`]:
          context.signal.aborted ||
          (error instanceof Error && error.name === "AbortError")
            ? "cancelled"
            : "failed",
        [`${kind}LoadedBinaryError`]:
          "owned-loader-proof-unavailable-or-mismatched",
      };
      throw error;
    } finally {
      this.#provenance = {
        ...this.#provenance,
        [`${kind}LoadedBinaryDurationMs`]: performance.now() - started,
      };
    }
  }

  async reviewMidiSources(
    context: DriverContext,
    sources: readonly MidiSourceReview[],
  ): Promise<BaselineEvidence> {
    if (
      !sources.length ||
      sources.length > 8 ||
      new Set(sources.map((source) => source.id)).size !== sources.length
    )
      throw new Error(
        "Authoring review requires one to eight distinct sources",
      );
    return this.#readBaseline(context, sources);
  }

  async #readBaseline(
    context: DriverContext,
    review?: readonly MidiSourceReview[],
  ): Promise<BaselineEvidence> {
    this.#assertBridgeTimingHealthy();
    const snapshot = await this.#getPage().evaluate(() =>
      window.desktop.ableton.requestSnapshot(),
    );
    this.#snapshot = structuredClone(snapshot);
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
    await this.#verifyFlatnessBinary(context, "baseline");
    await this.#verifyDiagnosticBinary(context, "baseline", "mel");
    await this.#verifyDiagnosticBinary(context, "baseline", "pitch");
    if ((await this.#jobs(context)).length !== 0)
      throw new Error(
        "Fresh acceptance profile contains an unexpected listening pass",
      );
    if (
      !review &&
      !context.scenario.requiredCapabilities.some(
        (kind) => kind === "session-audio" || kind === "session-midi",
      )
    ) {
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
    const definitions = review ?? context.fixture.sources;
    if (!definitions?.length)
      throw new Error("Session fixture requires declared sources");
    sessionStructureFingerprint(snapshot);
    for (const definition of definitions)
      this.#sources[definition.id] = await this.#admitSource(
        context,
        snapshot,
        definition,
        review !== undefined,
      );
    const evidence = {
      schemaVersion: 1 as const,
      facts: required(Object.values(this.#sources)[0], "source baseline").facts,
      sources: this.#sources,
      dependencyHashes: this.#dependencies,
    };
    validateBaseline(evidence);
    return evidence;
  }

  async #admitSource(
    context: DriverContext,
    snapshot: DesktopLiveSetSnapshot,
    definition:
      NonNullable<FixtureManifest["sources"]>[number] | MidiSourceReview,
    review = false,
  ): Promise<SessionSourceEvidence> {
    const target = resolveSessionSource(
      snapshot,
      "mediaTarget" in definition
        ? { ...definition, kind: "audio" }
        : { ...definition, kind: "midi" },
    );
    this.#preflightTraces.add(target.queryId);
    const preflight = sessionListeningPreflightResultSchema.parse(
      await this.#getPage().evaluate(
        (request) =>
          window.desktop.ableton.inspectSessionListeningPreflight(request),
        target,
      ),
    );
    if (
      preflight.source.queryId !== target.queryId ||
      "mediaTarget" in definition !== "audio" in preflight ||
      hash(preflight.source.target) !== hash(target.target)
    )
      throw new Error("Fixture source kind or target differs from preflight");
    const { source, recording } = preflight;
    const expectedBeat = review
      ? source.after.globalBeat
      : context.fixture.baseline.currentSongTime;
    const expectedRemembered = review
      ? snapshot.sessionClips!.filter((clip) => clip.status === "playing")
          .length
      : (context.fixture.baseline.rememberedSessionClips ??
        context.fixture.baseline.playingSessionClips);
    if (
      typeof expectedBeat !== "number" ||
      !sourceStoppedAtPosition(
        source,
        expectedBeat,
        typeof expectedRemembered === "number" && expectedRemembered > 0
          ? target.target.sceneIndex
          : undefined,
      )
    )
      throw new Error(
        `Blocked source precondition: ${definition.id}.stoppedPosition ${JSON.stringify(
          {
            expectedBeat,
            beforeBeat: source.before.globalBeat,
            afterBeat: source.after.globalBeat,
            beforePlaying: source.before.transportPlaying,
            afterPlaying: source.after.transportPlaying,
            beforeSlot: source.before.playingSlotIndex,
            afterSlot: source.after.playingSlotIndex,
            expectedSlot: target.target.sceneIndex,
            remembered: expectedRemembered,
            triggered: source.after.targetTriggered,
            recording: source.after.targetRecording,
          },
        )}`,
      );
    if (
      "audio" in preflight &&
      (!preflight.audio.filePath ||
        preflight.audio.sampleRate === null ||
        preflight.audio.sampleRate <= 0 ||
        preflight.audio.sampleLength === null ||
        preflight.audio.sampleLength <= 0)
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
    let identity: SourceIdentity;
    let listenerPlacement: ListenerPlacement | undefined;
    if ("mediaTarget" in definition && "audio" in preflight) {
      const audio = preflight.audio;
      const media = context.fixture.resources.find(
        (resource) =>
          resource.target === definition.mediaTarget &&
          isFixtureMediaTarget(resource.target),
      );
      if (!media) throw new Error("Session source requires declared media");
      if (
        resolve(required(audio.filePath ?? undefined, "audio path")) !==
        resolve(
          required(context.stagedFixture, "staged fixture").workingDirectory,
          definition.mediaTarget,
        )
      )
        throw new Error(
          "Loaded source path differs from its declared media target",
        );
      const mediaSha256 = await verifyStagedMedia(
        required(context.stagedFixture, "staged fixture"),
        required(audio.filePath ?? undefined, "audio path"),
        media.sha256,
        context.signal,
      );
      identity = {
        trackId: target.target.track.expectedReference,
        clipId: target.target.expectedClipReference,
        slotIndex: target.target.sceneIndex,
        mediaSha256,
      };
    } else if (!("mediaTarget" in definition) && "midi" in preflight) {
      const binding = context.fixture.listenerBindings?.find(
        (entry) => entry.slot === definition.listenerBindingSlot,
      );
      const device = snapshot.devices?.find(
        (entry) =>
          entry.trackIndex === binding?.trackIndex &&
          entry.index === binding?.deviceIndex,
      );
      const producerDevice = listeners[0]!.device;
      const nativeSlotMatches = snapshot.devices?.filter(
        (entry) =>
          entry.trackIndex === binding?.trackIndex &&
          entry.className === "MxDeviceAudioEffect" &&
          entry.name === producerDevice?.name,
      );
      // Max IDs and Remote Script UUIDs are distinct namespaces. A native ID
      // uses the same reviewed-slot binding as audio, with unique placement.
      const nativeSlotBound =
        /^[1-9][0-9]{0,15}$/u.test(producerDevice?.id ?? "") &&
        nativeSlotMatches?.length === 1 &&
        nativeSlotMatches[0]!.id === device?.id;
      if (
        !binding ||
        !device ||
        (producerDevice?.id !== device.id && !nativeSlotBound)
      )
        throw new Error(
          "MIDI listener requires exact independently observed device identity",
        );
      listenerPlacement = {
        trackIndex: binding.trackIndex,
        deviceIndex: binding.deviceIndex,
        deviceReference: device.id,
      };
      identity = {
        trackId: target.target.track.expectedReference,
        clipId: target.target.expectedClipReference,
        slotIndex: target.target.sceneIndex,
        ...midiContentIdentity(preflight, listenerPlacement),
      };
    } else throw new Error("Fixture source kind mismatch");
    this.#targets.set(definition.id, target);
    this.#sourceSettingsHashes.set(
      definition.id,
      sourceFingerprint(preflight, listenerPlacement),
    );
    const listener = listeners[0]!;
    this.#listenerIdentities.set(
      definition.id,
      hash({
        connectionId: listener.connectionId,
        instanceId: listener.instanceId,
        producerId: listener.producerId,
        track: listener.track,
        device: listener.device,
      }),
    );
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
      trackIndex: target.target.track.index,
      clipName: target.target.expectedClipName,
      sceneIndex: target.target.sceneIndex,
      tempo: source.settings.tempoBpm,
      globalQuantization:
        source.settings.globalQuantization === 0
          ? "none"
          : source.settings.globalQuantization === 4
            ? "bar"
            : "unsupported",
      clipLaunchQuantization: sessionClipQuantizationName(
        source.settings.launchQuantization,
      ),
      transportPlaying: source.after.transportPlaying,
      currentSongTime: source.after.globalBeat,
      playingSessionClips: snapshot.sessionClips!.filter(
        (clip) => clip.status === "playing",
      ).length,
      rememberedSessionClips: source.after.transportPlaying
        ? 0
        : snapshot.sessionClips!.filter((clip) => clip.status === "playing")
            .length,
      queuedSessionClips: snapshot.sessionClips!.filter(
        (clip) => clip.status === "queued",
      ).length,
      recording:
        source.after.targetRecording ||
        recording.state.arrangementRecord ||
        recording.state.sessionRecord,
      arrangementRecord: recording.state.arrangementRecord,
      sessionRecord: recording.state.sessionRecord,
      ...("audio" in preflight
        ? {
            mediaSampleRate: preflight.audio.sampleRate,
            mediaFrames: preflight.audio.sampleLength,
          }
        : {}),
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
    if (!review) {
      if (!("midi" in definition) && !("mediaTarget" in definition))
        throw new Error(
          "Execution requires independently declared source hashes",
        );
      for (const [key, expected] of Object.entries(
        declaredSourceBaseline(context.fixture, definition),
      ))
        if (!Object.hasOwn(observed, key) || observed[key] !== expected)
          throw new Error(
            `Blocked source precondition: ${definition.id}.${key}`,
          );
      if (observed.rememberedSessionClips !== expectedRemembered)
        throw new Error(
          "Blocked source precondition: undeclared remembered Session clips",
        );
      validateSupportedSessionBaseline(
        observed,
        "audio" in preflight ? "audio" : "midi",
      );
    }
    const evidence: SessionSourceEvidence =
      "audio" in preflight && "mediaSha256" in identity
        ? {
            loadedMediaPath: required(
              preflight.audio.filePath ?? undefined,
              "audio path",
            ),
            facts: observed,
            source: identity,
            listenerId: listener.producerId,
          }
        : "midi" in preflight && "midiNotesSha256" in identity
          ? {
              midi: preflight,
              listenerPlacement: required(
                listenerPlacement,
                "MIDI listener placement",
              ),
              facts: observed,
              source: identity,
              listenerId: listener.producerId,
            }
          : (() => {
              throw new Error("Source evidence kind mismatch");
            })();
    if (!review) {
      if (!("midi" in definition) && !("mediaTarget" in definition))
        throw new Error(
          "Execution requires independently declared source hashes",
        );
      validateFixtureSourceEvidence(context.fixture, definition, evidence);
      validateMidiSourcePreconditions(context.fixture, evidence);
    }
    return evidence;
  }

  async #verifySourceContent(
    context: DriverContext,
    id: string,
    input: DesktopSessionListeningPreflight,
    queryId: string,
  ): Promise<string> {
    const preflight = sessionListeningPreflightResultSchema.parse(input);
    const evidence = required(this.#sources[id], "source");
    const target = required(this.#targets.get(id), "source target");
    if (
      preflight.source.queryId !== queryId ||
      hash(preflight.source.target) !== hash(target.target)
    )
      throw new Error("Protected source target changed");
    if ("loadedMediaPath" in evidence) {
      if (
        !("audio" in preflight) ||
        preflight.audio.filePath !== evidence.loadedMediaPath
      )
        throw new Error("Loaded source media path or kind changed");
      await verifyStagedMedia(
        required(context.stagedFixture, "staged fixture"),
        evidence.loadedMediaPath,
        evidence.source.mediaSha256,
        context.signal,
      );
    } else {
      if (!("midi" in preflight))
        throw new Error("MIDI fixture source kind changed");
      validateFixtureSourceEvidence(
        context.fixture,
        required(
          context.fixture.sources?.find((entry) => entry.id === id),
          "source declaration",
        ),
        { ...evidence, midi: preflight },
      );
    }
    return sourceFingerprint(
      preflight,
      "midi" in evidence ? evidence.listenerPlacement : undefined,
    );
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

  async setup(
    action: SetupAction,
    step: ScenarioStep,
    context: DriverContext,
  ): Promise<SetupEvidence> {
    context.signal.throwIfAborted();
    if (
      !(action === "restart-owned-desktop"
        ? context.scenario.requiredCapabilities.includes("persistence")
        : context.scenario.requiredCapabilities.includes("session-audio") ||
          context.scenario.requiredCapabilities.includes("session-midi")) ||
      !step.setupActions?.includes(action) ||
      !context.scenario.steps.some(
        (declared) =>
          declared.id === step.id && declared.setupActions?.includes(action),
      ) ||
      this.#setupExecuted.has(action) ||
      !this.#live.publicRecord() ||
      !this.#application
    )
      throw new Error(
        "Setup action lacks declared single-use owned-process admission",
      );
    const identity = required(this.#identity, "session identity");
    this.#setupExecuted.add(action);
    let transport: SetupEvidence["transport"];
    if (action === "restart-owned-desktop") {
      if (!context.scenario.requiredCapabilities.includes("persistence"))
        throw new Error("Owned restart requires persistence admission");
      await this.#restartDesktop(context);
    } else {
      await this.#verifyWorld(context);
      const credential = await resolveBridgeCredential({
        environment: process.env,
        homeDirectory: homedir(),
      });
      const bridge = new AbletonBridgeService({
        authenticationToken: required(
          credential.token,
          "installed bridge credential",
        ),
        events: new InMemoryEventPublisher(),
        reconnect: { maxAttempts: 0 },
        requestTimeoutMs: Math.max(
          1,
          Math.min(5000, context.deadlineAt - Date.now()),
        ),
      });
      const stopped = await required(
        this.#bridgeTiming,
        "owned STOP bridge handoff",
      ).withExclusiveUpstream(
        context.signal,
        () =>
          withCorrelation(
            {
              traceId: context.traceId,
              correlationId: context.correlationId,
              causationId: context.causationId,
              sessionId: identity.appSessionId,
              operationId: `setup.${step.id}.stop-transport`,
            },
            async () => {
              try {
                await observe(() => bridge.start(), context.signal);
                const status = await bridge.getStatus();
                if (status.state !== "connected")
                  throw new Error(
                    `Runner bridge handshake failed: ${status.state}${status.state === "error" ? `/${status.code}` : ""}`,
                  );
                return await observe(
                  () => bridge.setPlaying(false),
                  context.signal,
                );
              } finally {
                await bridge.stop();
              }
            },
          ),
        {
          traceId: context.traceId,
          correlationId: context.correlationId,
          causationId: context.causationId,
        },
      );
      if (!stopped.verified || stopped.afterIsPlaying)
        throw new Error("Declared transport stop was not verified");
      transport = {
        command: "transport.set_playing",
        dispatchedCount: 1,
        beforePlaying: stopped.beforeIsPlaying,
        afterPlaying: false,
        verified: true,
      };
      const reconnected = await observe(
        () => this.#getPage().evaluate(() => window.desktop.ableton.connect()),
        context.signal,
      );
      if (reconnected.state !== "connected")
        throw new Error(
          "Owned Desktop bridge did not reconnect after runner STOP",
        );
      if ((await this.#verifyWorld(context)).transportStopped !== true)
        throw new Error("Source inspection did not confirm stopped transport");
    }
    return {
      ...identity,
      action,
      stepId: step.id,
      completed: true,
      traceId: context.traceId,
      correlationId: context.correlationId,
      causationId: context.causationId,
      ...(transport ? { transport } : {}),
    };
  }

  async #restartDesktop(context: DriverContext): Promise<void> {
    const previous = required(this.#identity, "session identity");
    await this.#jobs(context);
    await this.#closeDesktop();
    context.signal.throwIfAborted();
    await this.#launchDesktop(context);
    const restored = await this.#ready(context, false);
    if (JSON.stringify(restored) !== JSON.stringify(previous))
      throw new Error(
        "Restart did not restore the same agent conversation and App session",
      );
    this.#afterOwnedRestart = true;
  }

  async #verifyWorld(context: DriverContext): Promise<Facts> {
    if (!Object.keys(this.#sources).length) return {};
    context.signal.throwIfAborted();
    const facts: Record<string, string | boolean> = {};
    const snapshot = await this.#getPage().evaluate(() =>
      window.desktop.ableton.requestSnapshot(),
    );
    if (
      sessionStructureFingerprint(snapshot) !==
      sessionStructureFingerprint(required(this.#snapshot, "baseline"))
    )
      throw new Error(
        "Protected Session structure changed during the conversation",
      );
    const allowed = Object.values(this.#sources).map(
      (source) => source.source.clipId,
    );
    if (
      unrelatedPlaybackFingerprint(snapshot, allowed) !==
      unrelatedPlaybackFingerprint(
        required(this.#snapshot, "baseline"),
        allowed,
      )
    )
      throw new Error("Unrelated playback changed during the conversation");
    const outputs = await this.#getPage().evaluate(() =>
      window.desktop.outputs.list(),
    );
    if (outputs.activeSessionId !== this.#identity?.appSessionId)
      throw new Error("Active application session changed");
    let stoppedZero = snapshot.sessionClips!.every(
      (clip) => clip.status !== "playing" && clip.status !== "queued",
    );
    let transportStopped = true;
    const remembered =
      context.fixture.baseline.rememberedSessionClips ??
      context.fixture.baseline.playingSessionClips;
    let stoppedDeclared =
      snapshot.sessionClips!.filter((clip) => clip.status === "playing")
        .length === remembered &&
      snapshot.sessionClips!.every((clip) => clip.status !== "queued");
    for (const [id, source] of Object.entries(this.#sources)) {
      const connections = outputs.connections.filter(
        (connection) =>
          connection.producerId === source.listenerId &&
          connection.state === "connected",
      );
      const listener = connections[0];
      if (
        !this.#afterOwnedRestart &&
        (connections.length !== 1 ||
          !listener ||
          hash({
            connectionId: listener.connectionId,
            instanceId: listener.instanceId,
            producerId: listener.producerId,
            track: listener.track,
            device: listener.device,
          }) !== this.#listenerIdentities.get(id))
      )
        throw new Error("Listener instance or connection changed");
      const request = {
        ...required(this.#targets.get(id), "source target"),
        queryId: randomUUID(),
      };
      this.#preflightTraces.add(request.queryId);
      facts[`source.${id}.queryId`] = request.queryId;
      const preflight = await this.#getPage().evaluate(
        (request) =>
          window.desktop.ableton.inspectSessionListeningPreflight(request),
        request,
      );
      transportStopped &&=
        preflight.source.after.transportPlaying === false &&
        preflight.recording.state.arrangementRecord === false &&
        preflight.recording.state.sessionRecord === false;
      if (
        (await this.#verifySourceContent(
          context,
          id,
          preflight,
          request.queryId,
        )) !== this.#sourceSettingsHashes.get(id)
      )
        throw new Error("Protected source settings changed");
      stoppedZero &&=
        sourceStoppedAtZero(preflight.source) &&
        preflight.recording.state.arrangementRecord === false &&
        preflight.recording.state.sessionRecord === false;
      stoppedDeclared &&=
        typeof context.fixture.baseline.currentSongTime === "number" &&
        sourceStoppedAtPosition(
          preflight.source,
          context.fixture.baseline.currentSongTime,
          typeof remembered === "number" && remembered > 0
            ? request.target.sceneIndex
            : undefined,
        ) &&
        preflight.recording.state.arrangementRecord === false &&
        preflight.recording.state.sessionRecord === false;
    }
    context.signal.throwIfAborted();
    return { ...facts, stoppedZero, stoppedDeclared, transportStopped };
  }

  async submit(
    step: ScenarioStep,
    context: DriverContext,
  ): Promise<Submission> {
    this.#assertBridgeTimingHealthy(true);
    context.signal.throwIfAborted();
    if (step.assertions.some((assertion) => assertion.name === "capture")) {
      if (this.#afterOwnedRestart)
        throw new Error(
          "Capture after the owned persistence restart is forbidden",
        );
      if (!step.sourceId || !this.#sources[step.sourceId])
        throw new Error("Capture turn requires an admitted source");
      const state = await this.#verifyWorld(context);
      const originalBaseline =
        context.fixture.baseline.currentSongTime === 0 &&
        (context.fixture.baseline.rememberedSessionClips ??
          context.fixture.baseline.playingSessionClips) === 0;
      if (
        (step.setupActions?.includes("stop-transport")
          ? this.#setupExecuted.has("stop-transport") && state.transportStopped
          : originalBaseline
            ? state.stoppedZero
            : state.stoppedDeclared) !== true
      )
        throw new Error(
          originalBaseline
            ? "Capture requires the explicit stopped-zero transition"
            : "Capture requires the declared stopped transport and remembered clip state",
        );
    }
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
      step,
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

  async #featureSources(context: DriverContext) {
    const coverage =
      context.scenario.assertions.find(({ name }) => name === "feature-search")
        ?.parameters.coverage === "peak-only"
        ? "peak-only"
        : "full";
    const sources = [];
    for (const contextId of this.#contexts.keys()) {
      const detail = await this.#readContext(contextId, context);
      this.#context(
        detail,
        this.#afterOwnedRestart,
        required(this.#contextTraces.get(contextId), "context SDK trace"),
      );
      sources.push(
        projectFeatureSource(
          contextId,
          detail.observation,
          this.#afterOwnedRestart,
          coverage,
        ),
      );
    }
    return sources;
  }

  #context(
    detail: DesktopContextDetail,
    afterOwnedRestart: boolean,
    trace: { traceId: string; correlationId: string },
  ): ContextEvidence {
    const observation = metricAudioObservationSchema.parse(detail.observation);
    if (
      observation.source.view !== "session" ||
      (observation.source.kind !== "warped-audio" &&
        observation.source.kind !== "midi")
    )
      throw new Error("Expected persisted Session source evidence");
    if (
      observation.ownership.passId !== detail.entry.passId ||
      observation.ownership.listenerId !== detail.entry.listenerId ||
      observation.ownership.traceId !== trace.traceId ||
      observation.ownership.correlationId !== trace.correlationId
    )
      throw new Error("Context entry and observation ownership differ");
    const source = observedSessionSource(
      observation.source,
      observation.ownership.listenerId,
      this.#sources,
    );
    return {
      contextId: detail.entry.contextId,
      passId: detail.entry.passId,
      source: {
        ...source.source,
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
      await this.#handleApprovals(events, submission, context);
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
        const flatnessSmoke: FlatnessSmokeEvidence[] = [];
        const spreadSmoke: SpreadSmokeEvidence[] = [];
        const rolloffSmoke: RolloffSmokeEvidence[] = [];
        const pitchSmoke: PitchSmokeEvidence[] = [];
        const melSmoke: MelSmokeEvidence[] = [];
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
            native: observed.ownership,
          });
          if (!cleanupComplete) {
            await pause(context);
            continue turnLoop;
          }
          await this.#verifyFlatnessBinary(context, "capture-completed");
          await this.#verifyDiagnosticBinary(
            context,
            "capture-completed",
            "mel",
            observed.ownership,
          );
          await this.#verifyDiagnosticBinary(
            context,
            "capture-completed",
            "pitch",
            observed.ownership,
          );
          for (const [name, project, entries, retained] of [
            [
              "flatness-smoke",
              projectFlatnessSmoke,
              flatnessSmoke,
              this.#flatnessSmoke,
            ],
            [
              "spread-smoke",
              projectSpreadSmoke,
              spreadSmoke,
              this.#spreadSmoke,
            ],
            [
              "rolloff-smoke",
              projectRolloffSmoke,
              rolloffSmoke,
              this.#rolloffSmoke,
            ],
            ["pitch-smoke", projectPitchSmoke, pitchSmoke, this.#pitchSmoke],
          ] as const) {
            if (
              !context.scenario.steps.some((step) =>
                step.assertions.some((assertion) => assertion.name === name),
              )
            )
              continue;
            const smoke = project(trace, {
              ...sdkTrace,
              passId: job.passId,
              listenerId: observed.ownership.listenerId,
              native: {
                generation: observed.ownership.generation,
                nativeEpoch: observed.ownership.nativeEpoch,
                connectionId: observed.ownership.connectionId,
                connectionEpoch: observed.ownership.connectionEpoch,
              },
            });
            entries.push(smoke);
            retained.set(job.passId, smoke);
          }
          this.#contexts.set(persisted.contextId, persisted);
          this.#contextTraces.set(persisted.contextId, sdkTrace);
          if (
            context.scenario.steps.some((step) =>
              step.assertions.some(
                (assertion) => assertion.name === "melbands-smoke",
              ),
            )
          ) {
            const smoke = projectMelSmoke(
              observed,
              persisted.contextId,
              cleanupComplete,
              trace,
            );
            melSmoke.push(smoke);
            this.#melSmoke.set(persisted.contextId, smoke);
          }
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
                sum +
                (metric?.gaps.reduce((count, gap) => count + gap.count, 0) ??
                  0),
              0,
            ),
            metricFamilies: observed.requestedMetrics.filter(
              (metric) => observed.metrics[metric]?.status === "complete",
            ),
            sampleRate: observed.geometry.sampleRate,
            startSample: observed.geometry.startSample,
            endSample: observed.sourceCoverage.endSample,
            cleanupComplete,
            failure: job.error ?? null,
            native: {
              generation: observed.ownership.generation,
              nativeEpoch: observed.ownership.nativeEpoch,
              connectionId: observed.ownership.connectionId,
              connectionEpoch: observed.ownership.connectionEpoch,
            },
            ...measuredCentroid(observed),
          });
        }
        for (const contextId of this.#contexts.keys())
          contexts.push(
            this.#context(
              await this.#readContext(contextId, context),
              this.#afterOwnedRestart,
              required(this.#contextTraces.get(contextId), "context SDK trace"),
            ),
          );
        const agentListening = link.step.assertions.some(
          ({ name }) =>
            name === "agent-listening-result" || name === "feature-search",
        )
          ? await this.#readAgentListening(
              context,
              { ...submission, sdkTurnId },
              this.#afterOwnedRestart,
            )
          : undefined;
        if (agentListening) this.#agentListening.push(agentListening);
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
          ...(flatnessSmoke.length ? { flatnessSmoke } : {}),
          ...(spreadSmoke.length ? { spreadSmoke } : {}),
          ...(rolloffSmoke.length ? { rolloffSmoke } : {}),
          ...(pitchSmoke.length ? { pitchSmoke } : {}),
          ...(melSmoke.length ? { melSmoke } : {}),
          contexts,
          ...(link.step.assertions.some(({ name }) => name === "feature-search")
            ? { featureSources: await this.#featureSources(context) }
            : {}),
          ...(agentListening
            ? { agentListening: this.#receiptHistory(context, agentListening) }
            : {}),
          facts: {
            sdkTurnId,
            ...Object.fromEntries(
              Object.entries(this.#provenance).filter(
                ([key]) =>
                  key.startsWith("melLoadedBinary") ||
                  key.startsWith("pitchLoadedBinary"),
              ),
            ),
            ...(await this.#verifyWorld(context)),
          },
        };
      }
      await pause(context);
    }
  }

  async #handleApprovals(
    events: readonly DesktopAppEvent[],
    submission: Submission,
    context: DriverContext,
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
          const step = this.#submissions.get(submission.userMessageId)?.step;
          let source = this.#sources[step?.sourceId ?? ""];
          let approvalArguments = tool.arguments;
          if (
            tool.name === "ableton_context" &&
            tool.action === "derive-features" &&
            source
          ) {
            const sdkTurnId = this.#sdkTurns.get(submission.userMessageId);
            const jobs = (await this.#jobs(context)).filter(
              (job) =>
                job.stage === "completed" &&
                job.trace.traceId === sdkTurnId &&
                job.agentId === submission.agentId &&
                job.sessionId === submission.appSessionId &&
                job.contextIds.length === 1,
            );
            if (jobs.length !== 1)
              throw new Error(
                "Derivation approval requires exactly one completed invoking capture",
              );
            const contextId = jobs[0]!.contextIds[0]!;
            const detail = await this.#readContext(contextId, context);
            const observed = metricAudioObservationSchema.parse(
              detail.observation,
            );
            const matched = observedSessionSource(
              observed.source,
              observed.ownership.listenerId,
              this.#sources,
            );
            if (
              matched.source.clipId !== source.source.clipId ||
              observed.ownership.traceId !== sdkTurnId
            )
              throw new Error(
                "Derivation approval source does not match the invoking turn",
              );
            source = { ...source, contextId };
            // Apply only the public derive default; explicit values remain guarded.
            if (!Object.hasOwn(tool.arguments, "includeHistorical"))
              approvalArguments = {
                ...tool.arguments,
                includeHistorical: false,
              };
          }
          permitted = required(
            this.#approvalPolicy,
            "reviewed approval policy",
          ).decide(
            {
              ...owner,
              tool: tool.name,
              action: tool.action,
              arguments: approvalArguments,
              risk: event.approval.risk,
              destructive: event.approval.destructive,
            },
            owner,
            source,
            step?.id,
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
    this.#assertBridgeTimingHealthy();
    await this.#jobs(context);
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
          Object.values(this.#sources).map((source) => source.source.clipId),
        ),
        afterSha256: unrelatedPlaybackFingerprint(
          snapshot,
          Object.values(this.#sources).map((source) => source.source.clipId),
        ),
      },
    ];
    const beforeSources: string[] = [];
    const afterSources: string[] = [];
    for (const [id, target] of this.#targets) {
      const request = { ...target, queryId: randomUUID() };
      this.#preflightTraces.add(request.queryId);
      const preflight = await this.#getPage().evaluate(
        (request) =>
          window.desktop.ableton.inspectSessionListeningPreflight(request),
        request,
      );
      beforeSources.push(
        required(this.#sourceSettingsHashes.get(id), "source settings"),
      );
      afterSources.push(
        await this.#verifySourceContent(
          context,
          id,
          preflight,
          request.queryId,
        ),
      );
    }
    if (beforeSources.length)
      unchanged.push({
        scope: "source-settings",
        beforeSha256: hash(beforeSources),
        afterSha256: hash(afterSources),
      });
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
    if (afterRestart && !this.#afterOwnedRestart)
      await this.#restartDesktop(context);
    const contexts: ContextEvidence[] = [];
    const melSmoke = await restoreMelSmoke(
      [...this.#melSmoke.values()],
      afterRestart,
      previous,
      async (contextId) =>
        (await this.#readContext(contextId, context)).observation,
      (traceId) => this.#readTrace(context, traceId),
    );
    for (const contextId of this.#contexts.keys())
      contexts.push(
        this.#context(
          await this.#readContext(contextId, context),
          afterRestart,
          required(this.#contextTraces.get(contextId), "context SDK trace"),
        ),
      );
    await this.#jobs(context);
    await this.#readTrace(context);
    const flatnessSmoke = await restoreFlatnessSmoke(
      [...this.#flatnessSmoke.values()],
      afterRestart,
      (traceId) => this.#readTrace(context, traceId),
    );
    const spreadSmoke = await restoreSpreadSmoke(
      [...this.#spreadSmoke.values()],
      afterRestart,
      (traceId) => this.#readTrace(context, traceId),
    );
    const rolloffSmoke = await restoreRolloffSmoke(
      [...this.#rolloffSmoke.values()],
      afterRestart,
      (traceId) => this.#readTrace(context, traceId),
    );
    const pitchSmoke = await restorePitchSmoke(
      [...this.#pitchSmoke.values()],
      afterRestart,
      (traceId) => this.#readTrace(context, traceId),
    );
    if (afterRestart) {
      for (const original of this.#agentListening) {
        const restored = await this.#readAgentListening(
          context,
          original,
          true,
        );
        this.#restoredAgentListening.push(restored);
      }
      if (this.#agentListening.length)
        verifyRestoredAgentListeningEvidence(
          this.#agentListening.map((agentListening) => ({ agentListening })),
          this.#restoredAgentListening,
        );
    }
    for (const traceId of new Set(this.#sdkTurns.values()))
      if (
        ![
          ...flatnessSmoke,
          ...spreadSmoke,
          ...rolloffSmoke,
          ...pitchSmoke,
        ].some((entry) => entry.traceId === traceId)
      )
        await this.#readTrace(context, traceId);
    for (const traceId of this.#preflightTraces)
      await this.#readTrace(context, traceId);
    this.#historyCollected = true;
    this.#assertBridgeTimingHealthy();
    return {
      schemaVersion: 1,
      capturePassIds: [...this.#observedCapturePassIds],
      facts: { ...this.#provenance, persistedContexts: contexts.length },
      contexts,
      ...(context.scenario.assertions.some(
        ({ name }) => name === "feature-search",
      )
        ? { featureSources: await this.#featureSources(context) }
        : {}),
      ...(this.#restoredAgentListening.length
        ? {
            agentListening: this.#restoredAgentListening.map((history) =>
              this.#receiptHistory(context, history),
            ),
          }
        : {}),
      ...(flatnessSmoke.length ? { flatnessSmoke } : {}),
      ...(spreadSmoke.length ? { spreadSmoke } : {}),
      ...(rolloffSmoke.length ? { rolloffSmoke } : {}),
      ...(pitchSmoke.length ? { pitchSmoke } : {}),
      ...(melSmoke.length ? { melSmoke } : {}),
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
      this.#desktopCleanupReceipts.push(result);
      if (this.#desktopCleanupReceipts.length > 16) {
        this.#desktopCleanupReceipts.shift();
        this.#omittedDesktopCleanupReceipts++;
      }
      if (!result.successful)
        failures.push(
          new Error(
            `Owned Desktop shutdown failed: ${
              result.events
                .filter((event) =>
                  ["failed", "timed-out", "cancelled"].includes(event.status),
                )
                .map(
                  (event) =>
                    `${event.stage} ${event.status} (${event.reason ?? "unspecified"})`,
                )
                .join("; ") || "unconfirmed process exit"
            }`,
          ),
        );
      if (result.stopped) {
        this.#application = undefined;
        this.#page = undefined;
      }
    }
    if (failures.length)
      throw new AggregateError(failures, "Desktop cleanup failed");
  }

  async cleanup(context: DriverContext): Promise<void> {
    const cleanup = new AcceptanceCleanup(context);
    if (
      !this.#historyCollected &&
      this.#identity &&
      this.#page &&
      !this.#page.isClosed()
    ) {
      const signal = AbortSignal.any([
        context.signal,
        AbortSignal.timeout(5_000),
      ]);
      await cleanup.attempt("history", async () => {
        await observe(async () => {
          await this.#readTrace({ ...context, signal });
          for (const traceId of new Set(this.#sdkTurns.values()))
            await this.#readTrace({ ...context, signal }, traceId);
          for (const traceId of this.#preflightTraces)
            await this.#readTrace({ ...context, signal }, traceId);
        }, signal);
      });
    }
    const bridgeAtCleanup = this.#bridgeTiming;
    const closeBridgeProxy = async () => {
      await this.#bridgeTiming!.close();
      this.#assertBridgeTimingHealthy();
    };
    // Claim socket shutdown before the owned process disconnects with pending reads.
    if (bridgeAtCleanup)
      await cleanup.attempt("bridge-proxy", closeBridgeProxy);
    // Closing a known process releases blocked page calls before awaiting a late launch.
    await cleanup.attempt("desktop-stop", () => this.#closeDesktop());
    await cleanup.attempt("settle-acquisitions", async () => {
      if (this.#launching) await this.#launching.catch(() => undefined);
      if (this.#desktopLaunching)
        await this.#desktopLaunching.catch(() => undefined);
      if (this.#provisioning) await this.#provisioning.catch(() => undefined);
    });
    if (this.#bridgeTiming && this.#bridgeTiming !== bridgeAtCleanup)
      await cleanup.attempt("bridge-proxy-after-settle", closeBridgeProxy);
    await cleanup.attempt("product-evidence", async () => {
      await writeScenarioReceipt(
        join(this.options.runDirectory, "product-evidence.json"),
        {
          schema: "acceptance-product-evidence/v1",
          runId: context.runId,
          scenarioId: context.scenario.id,
          traceId: context.traceId,
          provenance: this.#provenance,
          dependencyHashes: this.#dependencies,
          liveProcess: this.#live.publicRecord(),
          desktop: this.#events.diagnostics(),
          history: this.#traceEvents,
          ...(this.#agentListening.length
            ? {
                agentListening: this.#agentListening,
                restoredAgentListening: this.#restoredAgentListening,
              }
            : {}),
          ...(this.#bridgeTiming
            ? { bridgeTiming: this.#bridgeTiming.snapshot() }
            : {}),
        },
      );
    });
    if (this.#application) {
      await cleanup.attempt("desktop-stop-after-settle", () =>
        this.#closeDesktop(),
      );
    }
    let liveStopped = true;
    if (this.#live.publicRecord()) {
      liveStopped = await cleanup.attempt("live-stop", () =>
        this.#live.discardAfterFailure(),
      );
    }
    const hostReservationClosed = await cleanup.attempt(
      "host-reservation",
      () => this.#live.close(),
    );
    if (!hostReservationClosed) liveStopped = false;
    let profileRemoved = this.#profile === undefined;
    if (!this.#application && liveStopped && this.#profile) {
      const profile = this.#profile;
      profileRemoved = await cleanup.attempt("profile", () =>
        rm(profile, { recursive: true, force: true }),
      );
    }
    await cleanup.attempt("cleanup-evidence", async () => {
      await writeScenarioReceipt(
        join(this.options.runDirectory, "cleanup-evidence.json"),
        {
          schema: "acceptance-cleanup/v1",
          runId: context.runId,
          scenarioId: context.scenario.id,
          traceId: context.traceId,
          resources: {
            desktopStopped: this.#application === undefined,
            liveStopped,
            hostReservationClosed,
            profileRemoved,
          },
          desktop: this.#desktopCleanupReceipts,
          omittedDesktopReceipts: this.#omittedDesktopCleanupReceipts,
          events: cleanup.events,
          failures: cleanup.failures,
        },
      );
    });
    cleanup.throwIfFailed();
  }
}
