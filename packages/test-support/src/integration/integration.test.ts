import { createHash, randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  lstat,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SUPPORTED_AUDIO_BASELINE,
  createDefaultAssertions,
  parseParenthesizedChoice,
  runAcceptance,
  stageFixture,
  validateFixture,
  validateScenario,
  validateSupportedAudioBaseline,
  validateAudioBaselineEvidence,
  validatePermission,
  validateTurn,
  resolvePermissionArguments,
  dependencyInventoryHashes,
  validateDependencyInventory,
  verifyStagedMedia,
} from "./index.js";
import type {
  AcceptanceDriver,
  AudioBaselineEvidence,
  BaselineEvidence,
  CaptureEvidence,
  ContextEvidence,
  DriverContext,
  DependencyInventory,
  FixtureManifest,
  LifecycleEvent,
  RunEvidence,
  RunResult,
  ScenarioManifest,
  ScenarioStep,
  SessionIdentity,
  Submission,
  TurnEvidence,
  TurnSubscription,
} from "./index.js";

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const baseCandidateInventory: DependencyInventory = {
  schemaVersion: 1,
  candidateRoot: "/controlled-candidate",
  resources: [
    {
      id: "production-listener",
      path: "listener.amxd",
      target: "dependencies/listener.amxd",
      sha256: digest("candidate-resource"),
      bytes: Buffer.byteLength("candidate-resource"),
    },
  ],
};
const source = {
  trackId: "track-1",
  clipId: "clip-1",
  slotIndex: 0,
  mediaSha256: digest("synthetic-not-audio"),
};
const identity: SessionIdentity = {
  appSessionId: "app-1",
  conversationId: "conversation-1",
  agentId: "default-1",
};
const capture: CaptureEvidence = {
  passId: "pass-1",
  operationId: "operation-first",
  source,
  listenerId: "listener-1",
  complete: true,
  nonSilent: true,
  truncated: false,
  missingRecords: 0,
  metricFamilies: ["peak", "rms"],
  sampleRate: 48_000,
  startSample: 120,
  endSample: 96_120,
  cleanupComplete: true,
  failure: null,
};
const contextEvidence: ContextEvidence = {
  contextId: "context-1",
  passId: "pass-1",
  source,
  contentSha256: digest("retained-summary"),
  readable: true,
  afterOwnedRestart: false,
};
const fixture: FixtureManifest = {
  schemaVersion: 1,
  id: "controlled",
  qualification: "synthetic-only",
  provenance: {
    ownership: "authored",
    description:
      "Controlled parser input, NOT a playable Live Set or audio fixture.",
  },
  resources: [
    {
      path: "input.als",
      target: "project.als",
      sha256: digest("synthetic-not-live"),
      bytes: 18,
    },
    {
      path: "input.wav",
      target: "media/resource-001.wav",
      sha256: digest("synthetic-not-audio"),
      bytes: 19,
    },
  ],
  dependencies: ["production-listener"],
  sources: [
    {
      id: "a",
      trackName: "Source 1",
      clipName: "Clip 1",
      sceneIndex: 0,
      mediaTarget: "media/resource-001.wav",
    },
  ],
  baseline: SUPPORTED_AUDIO_BASELINE,
};
const scenario: ScenarioManifest = {
  schemaVersion: 1,
  id: "controlled-case",
  fixtureId: fixture.id,
  requiredCapabilities: ["controlled"],
  permissions: [
    {
      tool: "listen",
      action: "listen",
      risk: "low",
      maxUses: 1,
      arguments: { trackId: "track-1" },
    },
  ],
  budget: { runMs: 2000, cleanupMs: 100, persistenceMs: 100 },
  steps: [
    {
      id: "first",
      message: "Listen to Source 1.",
      timeoutMs: 1000,
      assertions: [
        {
          name: "capture",
          parameters: {
            sourceId: "a",
            metricFamilies: "peak,rms",
            sampleRate: 48_000,
            expectedFrames: 96_000,
          },
        },
        { name: "context", parameters: { afterRestart: false } },
      ],
    },
    {
      id: "second",
      message: "Choose (A), (B), (C), or (D).",
      timeoutMs: 1000,
      assertions: [
        { name: "choice", parameters: { expected: "B" } },
        { name: "no-capture", parameters: {} },
      ],
    },
  ],
  assertions: [
    { name: "capture-count", parameters: { expected: 1 } },
    { name: "context", parameters: { afterRestart: true } },
    {
      name: "unchanged",
      parameters: { scopes: "media,unrelated,launch-settings" },
    },
  ],
};

/** Two deliberately non-Live transports: buffered terminal result and asynchronous delivery. */
class ControlledDriver implements AcceptanceDriver {
  readonly schemaVersion = 1;
  readonly capabilities = ["controlled"];
  readonly calls: string[] = [];
  readonly contexts: DriverContext[] = [];
  readonly submissions: Submission[] = [];
  baseline: AudioBaselineEvidence = {
    schemaVersion: 1,
    facts: { ...SUPPORTED_AUDIO_BASELINE },
    sources: {
      a: {
        loadedMediaPath: "unbound",
        facts: { ...SUPPORTED_AUDIO_BASELINE },
        source,
        listenerId: "listener-1",
      },
    },
    dependencyHashes: dependencyInventoryHashes(baseCandidateInventory),
  };
  answer = "(B)";
  captured = capture;
  savedContext = contextEvidence;
  persistedContext = { ...contextEvidence, afterOwnedRestart: true };
  collected: RunEvidence = {
    schemaVersion: 1,
    capturePassIds: ["pass-1"],
    facts: {},
    contexts: [this.persistedContext],
    unchanged: ["media", "unrelated", "launch-settings"].map((scope) => ({
      scope,
      beforeSha256: digest(scope),
      afterSha256: digest(scope),
    })),
  };
  wrongIdentity = false;
  turnIdentity = false;
  hang = false;
  cleanupError = false;
  closeError = false;
  failLaunch = false;
  malformedTurn = false;
  extraCapture = false;
  extraTurnFields: Record<string, unknown> = {};
  terminalStatus: TurnEvidence["status"] = "completed";
  constructor(
    private readonly delivery: "buffered" | "asynchronous" = "buffered",
  ) {}
  private note(call: string, ctx: DriverContext) {
    this.calls.push(call);
    this.contexts.push(ctx);
  }
  async launch(ctx: DriverContext) {
    this.note("launch", ctx);
    this.baseline = {
      ...this.baseline,
      sources: {
        a: {
          ...this.baseline.sources.a!,
          facts: {
            ...this.baseline.sources.a!.facts,
            trackName: "Source 1",
            clipName: "Clip 1",
          },
          loadedMediaPath: join(
            ctx.stagedFixture!.workingDirectory,
            "media/resource-001.wav",
          ),
        },
      },
    };
    if (this.failLaunch) throw new Error("launch failure");
  }
  async ready(ctx: DriverContext) {
    this.note("ready", ctx);
    return identity;
  }
  async subscribe(ctx: DriverContext): Promise<TurnSubscription> {
    this.note("subscribe", ctx);
    return {
      waitForTurn: async (submission, turnContext) => {
        this.note("wait", turnContext);
        if (this.hang)
          return new Promise<TurnEvidence>((_, reject) => {
            turnContext.signal.addEventListener(
              "abort",
              () => {
                const reason: unknown = turnContext.signal.reason;
                reject(reason instanceof Error ? reason : new Error("Aborted"));
              },
              { once: true },
            );
          });
        if (this.delivery === "asynchronous")
          await new Promise<void>((done) => setTimeout(done, 1));
        const first = submission.operationId === "operation-first";
        return {
          schemaVersion: 1,
          ...submission,
          ...(this.turnIdentity
            ? { conversationId: "wrong-conversation" }
            : {}),
          assistantMessageId: `assistant-${submission.operationId}`,
          terminal: true,
          status: this.terminalStatus,
          assistantText: first ? "Observed the source." : this.answer,
          captures: first || this.extraCapture ? [this.captured] : [],
          contexts: first ? [this.savedContext] : [],
          facts: {},
          ...(this.malformedTurn ? { terminal: false as unknown as true } : {}),
          ...this.extraTurnFields,
        };
      },
      close: async (closeContext) => {
        this.note("close", closeContext);
        if (this.closeError) throw new Error("close failure");
      },
    };
  }
  async readBaseline(ctx: DriverContext) {
    this.note("baseline", ctx);
    validateAudioBaselineEvidence(this.baseline);
    await verifyStagedMedia(
      ctx.stagedFixture!,
      this.baseline.sources.a!.loadedMediaPath,
      this.baseline.sources.a!.source.mediaSha256,
      ctx.signal,
    );
    return this.baseline;
  }
  async submit(step: ScenarioStep, ctx: DriverContext) {
    this.note(`submit:${step.id}`, ctx);
    const submission = {
      ...identity,
      ...(this.wrongIdentity ? { agentId: "other-agent" } : {}),
      userMessageId: `user-${step.id}`,
      operationId: `operation-${step.id}`,
    };
    this.submissions.push(submission);
    return submission;
  }
  async collect(ctx: DriverContext) {
    this.note("collect", ctx);
    return this.collected;
  }
  async cleanup(ctx: DriverContext) {
    this.note("cleanup", ctx);
    expect(ctx.signal.aborted).toBe(false);
    if (this.cleanupError) throw new Error("cleanup failure");
  }
}

class AsynchronousControlledDriver extends ControlledDriver {
  constructor() {
    super("asynchronous");
  }
}

class FactOnlyDriver implements AcceptanceDriver {
  readonly schemaVersion = 1;
  readonly capabilities = ["inspect-facts"];
  readonly facts = { trackCount: 2, globalQuantization: "bar" };
  async launch() {}
  async ready() {
    return identity;
  }
  async subscribe(): Promise<TurnSubscription> {
    return {
      waitForTurn: async (submission) => ({
        ...submission,
        schemaVersion: 1,
        assistantMessageId: "fact-response",
        terminal: true,
        status: "completed",
        assistantText: "Two tracks.",
        facts: this.facts,
        captures: [],
        contexts: [],
      }),
      close: async () => {},
    };
  }
  async readBaseline(): Promise<BaselineEvidence> {
    return { schemaVersion: 1, facts: this.facts, dependencyHashes: {} };
  }
  async submit(): Promise<Submission> {
    return {
      ...identity,
      userMessageId: "fact-user",
      operationId: "fact-operation",
    };
  }
  async collect(): Promise<RunEvidence> {
    return { schemaVersion: 1, facts: this.facts, contexts: [], unchanged: [] };
  }
  async cleanup() {}
}

class AsynchronousFactOnlyDriver extends FactOnlyDriver {
  override async subscribe(): Promise<TurnSubscription> {
    const subscription = await super.subscribe();
    return {
      waitForTurn: async (submission, context) => {
        await new Promise<void>((done) => setImmediate(done));
        return subscription.waitForTurn(submission, context);
      },
      close: (context) => subscription.close(context),
    };
  }
}

describe("driver-neutral acceptance foundation (synthetic only)", () => {
  it("bounds and pins licensed Builtin prerequisites without admitting external paths", () => {
    const builtin = { path: "Samples/IR.wav", bytes: 42, sha256: digest("IR") };
    validateFixture({ ...fixture, builtinResources: [builtin] });
    for (const patch of [
      { path: "../outside" },
      { path: "/outside" },
      { sha256: "wrong" },
      { bytes: 0 },
      { bytes: 16 * 1024 * 1024 + 1 },
      { unknown: true },
    ])
      expect(() =>
        validateFixture({
          ...fixture,
          builtinResources: [{ ...builtin, ...patch }],
        }),
      ).toThrow();
    expect(() =>
      validateFixture({ ...fixture, builtinResources: [builtin, builtin] }),
    ).toThrow();
  });
  it("accepts bounded protocol listener identities without treating them as filesystem identifiers", () => {
    const baseline = {
      schemaVersion: 1,
      facts: SUPPORTED_AUDIO_BASELINE,
      sources: {
        a: {
          facts: SUPPORTED_AUDIO_BASELINE,
          loadedMediaPath: "/owned/media/resource-001.wav",
          source,
          listenerId:
            "ableton-audio-listener:path:0ab15d6e26745d97a552b223ab10d013",
        },
      },
      dependencyHashes: {},
    };
    expect(() => validateAudioBaselineEvidence(baseline)).not.toThrow();
    expect(() =>
      validateAudioBaselineEvidence({
        ...baseline,
        sources: { a: { ...baseline.sources.a, listenerId: "" } },
      }),
    ).toThrow();
    expect(() =>
      validateAudioBaselineEvidence({
        ...baseline,
        sources: { a: { ...baseline.sources.a, listenerId: "a".repeat(129) } },
      }),
    ).toThrow();
  });
  it("validates exact top-level listener bindings and rejects malformed declarations", () => {
    const binding = {
      slot: "AudioTrack:175/DeviceChain/DeviceChain/Devices/MxDeviceAudioEffect:0",
      sourcePath: "Presets/Listener.amxd",
      dependency: "machine-listening",
      trackIndex: 0,
      deviceIndex: 0,
    };
    const declared = {
      ...fixture,
      dependencies: ["machine-listening"],
      listenerBindings: [binding],
    };
    validateFixture(declared);
    for (const patch of [
      { slot: "ReturnTrack:175/DeviceChain/Devices/MxDeviceAudioEffect:0" },
      { slot: "AudioTrack:175/Chains/0/Devices/MxDeviceAudioEffect:0" },
      { sourcePath: "../outside.amxd" },
      { sourcePath: "/absolute.amxd" },
      { dependency: "undeclared" },
      { trackIndex: -1 },
      { deviceIndex: 0.5 },
      { trackIndex: 1024 },
      { extra: true },
    ])
      expect(() =>
        validateFixture({
          ...declared,
          listenerBindings: [{ ...binding, ...patch }],
        }),
      ).toThrow();
    expect(() =>
      validateFixture({ ...declared, listenerBindings: [binding, binding] }),
    ).toThrow();
  });
  it("bounds and binds derived dependency records rather than trusting arbitrary output mounts", () => {
    const id = "production-listener";
    const frozen = {
      id,
      sourceTarget: baseCandidateInventory.resources[0]!.target,
      target: `dependencies/${id}/frozen/Listener.amxd`,
      sha256: digest("frozen"),
      bytes: 100,
    };
    const preparedProject = {
      target: "prepared.als",
      sha256: digest("prepared"),
      bytes: 100,
    };
    const inventory = {
      ...baseCandidateInventory,
      frozenDevices: [frozen],
      preparedProject,
    };
    validateDependencyInventory(inventory, fixture);
    for (const patch of [
      { sourceTarget: "missing.amxd" },
      { target: "project.als" },
      { target: "../outside.amxd" },
      { id: "undeclared" },
      { sha256: "not-a-hash" },
      { bytes: 64 * 1024 * 1024 + 1 },
      { extra: true },
    ])
      expect(() =>
        validateDependencyInventory({
          ...inventory,
          frozenDevices: [{ ...frozen, ...patch }],
        }),
      ).toThrow();
    expect(() =>
      validateDependencyInventory({
        ...inventory,
        frozenDevices: [frozen, frozen],
      }),
    ).toThrow();
    for (const patch of [
      { target: "project.als" },
      { bytes: 8 * 1024 * 1024 + 1 },
      { extra: true },
    ])
      expect(() =>
        validateDependencyInventory({
          ...inventory,
          preparedProject: { ...preparedProject, ...patch },
        }),
      ).toThrow();
    expect(() =>
      validateDependencyInventory({ ...inventory, frozenDevices: [] }),
    ).toThrow();
    expect(dependencyInventoryHashes(inventory)).not.toEqual(
      dependencyInventoryHashes(baseCandidateInventory),
    );
  });
  let root: string;
  let catalogRoot: string;
  let candidateRoot: string;
  let workingRoot: string;
  beforeEach(async () => {
    root = resolve(".test-artifacts", `shared-core-${randomUUID()}`);
    catalogRoot = join(root, "catalog");
    candidateRoot = join(root, "candidate");
    workingRoot = join(root, "working");
    await mkdir(catalogRoot, { recursive: true });
    await mkdir(workingRoot);
    await mkdir(candidateRoot);
    await writeFile(join(candidateRoot, "listener.amxd"), "candidate-resource");
    await writeFile(join(catalogRoot, "input.als"), "synthetic-not-live");
    await writeFile(join(catalogRoot, "input.wav"), "synthetic-not-audio");
  });
  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });
  const receipts: RunResult[] = [];
  async function provision(ctx: DriverContext): Promise<DependencyInventory> {
    const target = "dependencies/listener.amxd";
    await mkdir(join(ctx.stagedFixture!.workingDirectory, "dependencies"));
    await writeFile(
      join(ctx.stagedFixture!.workingDirectory, target),
      "candidate-resource",
    );
    return { ...baseCandidateInventory, candidateRoot };
  }
  async function provisionBundle(
    ctx: DriverContext,
  ): Promise<DependencyInventory> {
    const inventory = await provision(ctx);
    const resources = [...inventory.resources];
    for (const [path, content] of [
      ["processor.js", "synthetic-js"],
      ["native/Contents/MacOS/processor", "synthetic-native"],
      ["native/Contents/_CodeSignature/CodeResources", "synthetic-signature"],
    ] as const) {
      const sourcePath = join(candidateRoot, path);
      const target = `dependencies/${path}`;
      const destination = join(ctx.stagedFixture!.workingDirectory, target);
      await mkdir(dirname(sourcePath), { recursive: true });
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(sourcePath, content);
      await writeFile(destination, content);
      resources.push({
        id: "production-listener",
        path,
        target,
        sha256: digest(content),
        bytes: Buffer.byteLength(content),
      });
    }
    const target = "dependencies/agent_signal_storage.js";
    const content =
      'module.exports = {descriptorPath:"owned/descriptor.json",secretPath:"owned/secret"};';
    await writeFile(join(ctx.stagedFixture!.workingDirectory, target), content);
    return {
      ...inventory,
      resources,
      generatedConfigurations: [
        {
          id: "production-listener",
          target,
          sha256: digest(content),
          bytes: Buffer.byteLength(content),
        },
      ],
    };
  }
  async function execute(
    driver: ControlledDriver,
    overrides: Partial<Parameters<typeof runAcceptance>[0]> = {},
  ) {
    return runAcceptance({
      scenario,
      fixture,
      driver,
      stage: (ctx) =>
        stageFixture({
          fixture,
          catalogRoot,
          workingRoot,
          runId: ctx.runId,
          allowSynthetic: true,
          signal: ctx.signal,
        }),
      provision,
      persist: async (receipt) => {
        receipts.push(receipt);
        driver.calls.push("persist");
      },
      ...overrides,
    });
  }
  it.each(["buffered", "asynchronous"] as const)(
    "reuses one scenario and assertions with %s driver",
    async (delivery) => {
      const driver =
        delivery === "buffered"
          ? new ControlledDriver()
          : new AsynchronousControlledDriver();
      const events: LifecycleEvent[] = [];
      const result = await execute(driver, {
        event: (event) => events.push(event),
      });
      expect(result.status).toBe("passed");
      expect(result.cleanupComplete && result.persisted).toBe(true);
      expect(result.executed).toEqual(["first", "second"]);
      expect(result.unrun).toEqual([]);
      expect(driver.calls).toEqual([
        "launch",
        "ready",
        "subscribe",
        "baseline",
        "submit:first",
        "wait",
        "submit:second",
        "wait",
        "collect",
        "close",
        "cleanup",
        "persist",
      ]);
      expect(
        driver.contexts.every(
          (ctx) =>
            ctx.traceId === result.traceId &&
            ctx.correlationId === result.runId &&
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
              ctx.causationId,
            ) &&
            Number.isFinite(ctx.deadlineAt),
        ),
      ).toBe(true);
      expect(
        driver.submissions.every(
          (entry) => entry.conversationId === identity.conversationId,
        ),
      ).toBe(true);
      expect(events.at(-1)).toMatchObject({ stage: "run", phase: "completed" });
      for (const stage of [
        "stage",
        "provision",
        "launch",
        "readiness",
        "subscribe",
        "preconditions",
        "submit.first",
        "turn.first",
        "collect",
        "cleanup",
        "persistence",
      ]) {
        expect(
          events
            .filter((event) => event.stage === stage)
            .map((event) => event.phase),
        ).toEqual(["queued", "started", "completed"]);
      }
      expect(events.every((event) => event.durationMs >= 0)).toBe(true);
    },
  );
  it("creates isolated neutral copies and leaves source bytes unchanged", async () => {
    const first = await stageFixture({
      fixture,
      catalogRoot,
      workingRoot,
      runId: "one",
      allowSynthetic: true,
    });
    const second = await stageFixture({
      fixture,
      catalogRoot,
      workingRoot,
      runId: "two",
      allowSynthetic: true,
    });
    await writeFile(first.projectPath, "working mutation");
    expect(await readFile(second.projectPath, "utf8")).toBe(
      "synthetic-not-live",
    );
    expect(first.projectPath).toBe(
      join(workingRoot, `case-${digest("one").slice(0, 32)}`, "project.als"),
    );
    await first.verifySourceUnchanged();
    await expect(
      stageFixture({
        fixture,
        catalogRoot,
        workingRoot,
        runId: "one",
        allowSynthetic: true,
      }),
    ).rejects.toThrow();
    await writeFile(join(catalogRoot, "input.als"), "tampered-original");
    await expect(first.verifySourceUnchanged()).rejects.toThrow();
  });
  it.each([
    "media/resource-001.wav",
    "Samples/Imported/resource-001.wav",
    "Samples/Recorded/resource-001.wav",
  ])(
    "verifies loaded bytes at %s and rejects identical foreign media",
    async (mediaTarget) => {
      const staged = await stageFixture({
        fixture: {
          ...fixture,
          sources: fixture.sources!.map((source) => ({
            ...source,
            mediaTarget,
          })),
          resources: fixture.resources.map((resource) => ({
            ...resource,
            target: resource.target.startsWith("media/")
              ? mediaTarget
              : resource.target,
          })),
        },
        catalogRoot,
        workingRoot,
        runId: "verified-digest",
        allowSynthetic: true,
      });
      const mediaPath = join(staged.workingDirectory, mediaTarget);
      const projectInfo = join(staged.workingDirectory, "Ableton Project Info");
      expect((await lstat(projectInfo)).isDirectory()).toBe(true);
      expect((await lstat(projectInfo)).mode & 0o777).toBe(0o700);
      expect(await readdir(projectInfo)).toEqual([]);
      const expected = digest("synthetic-not-audio");
      await expect(
        verifyStagedMedia(staged, mediaPath, expected),
      ).resolves.toBe(expected);
      await expect(
        verifyStagedMedia(staged, join(catalogRoot, "input.wav"), expected),
      ).rejects.toThrow("outside owned staged inventory");
      await writeFile(mediaPath, "synthetic-not-AUDIO");
      await expect(
        verifyStagedMedia(staged, mediaPath, expected),
      ).rejects.toThrow("Source SHA-256 mismatch");
    },
  );
  it("does not claim synthetic placeholders playable", async () => {
    await expect(
      stageFixture({ fixture, catalogRoot, workingRoot, runId: "one" }),
    ).rejects.toThrow("not playable");
  });
  it.each([
    "../outside.als",
    "/outside.als",
    "a\\b.als",
    "a/../b.als",
    "a//b.als",
  ])("rejects escaping paths %s", (path) => {
    expect(() =>
      validateFixture({
        ...fixture,
        resources: [{ ...fixture.resources[0], path }],
      }),
    ).toThrow();
  });
  it("rejects missing resources, wrong hash, source links, ownership overlap and cancellation", async () => {
    const base = {
      fixture,
      catalogRoot,
      workingRoot,
      runId: "one",
      allowSynthetic: true,
    };
    await writeFile(join(catalogRoot, "input.als"), "wrong-sized");
    await expect(stageFixture(base)).rejects.toThrow();
    await writeFile(join(catalogRoot, "input.als"), "synthetic-not-Live");
    await expect(stageFixture(base)).rejects.toThrow("SHA-256");
    await rm(join(catalogRoot, "input.als"));
    await expect(stageFixture(base)).rejects.toThrow();
    await symlink(
      join(catalogRoot, "input.wav"),
      join(catalogRoot, "input.als"),
    );
    await expect(stageFixture(base)).rejects.toThrow("Symlink");
    await expect(
      stageFixture({ ...base, workingRoot: catalogRoot }),
    ).rejects.toThrow("overlap");
    await expect(
      stageFixture({ ...base, signal: AbortSignal.abort() }),
    ).rejects.toThrow();
  });
  it("validates malformed refs, versions, budgets, inventories and unsupported baseline", () => {
    const registry = createDefaultAssertions();
    const invalid = [
      { ...scenario, schemaVersion: 2 },
      { ...scenario, fixtureId: "missing" },
      { ...scenario, steps: [] },
      { ...scenario, assertions: [{ name: "unregistered", parameters: {} }] },
      { ...scenario, budget: { ...scenario.budget, runMs: Infinity } },
      { ...scenario, steps: [scenario.steps[0], scenario.steps[0]] },
    ];
    for (const definition of invalid)
      expect(() =>
        validateScenario(definition, fixture, registry.names),
      ).toThrow();
    for (const definition of [
      { ...fixture, provenance: { ownership: "unknown", description: "x" } },
      { ...fixture, resources: [fixture.resources[0], fixture.resources[0]] },
      { ...fixture, resources: [{ ...fixture.resources[0], sha256: "wrong" }] },
      {
        ...fixture,
        resources: [{ ...fixture.resources[0], target: "kick.als" }],
      },
    ])
      expect(() => validateFixture(definition)).toThrow();
    expect(() =>
      validateSupportedAudioBaseline({
        ...fixture.baseline,
        globalQuantization: "half",
      }),
    ).toThrow("Unsupported audio baseline");
  });
  it.each([
    ["none", 0],
    ["bar", 0],
    ["none", 5.5],
    ["bar", 5.5],
  ])(
    "admits declared stopped %s quantization at beat %s without claiming capture support",
    async (globalQuantization, currentSongTime) => {
      const facts = {
        ...SUPPORTED_AUDIO_BASELINE,
        globalQuantization,
        currentSongTime,
      };
      expect(() => validateSupportedAudioBaseline(facts)).not.toThrow();
      const driver = new ControlledDriver();
      driver.baseline = {
        ...driver.baseline,
        facts,
        sources: {
          a: { ...driver.baseline.sources.a!, facts },
        },
      };
      const result = await execute(driver, {
        fixture: { ...fixture, baseline: facts },
      });
      expect(result.status).toBe("passed");
      expect(driver.calls).toContain("cleanup");
      expect(result.persisted).toBe(true);
    },
  );
  it.each([
    { currentSongTime: -1 },
    { currentSongTime: 1_576_801 },
    { currentSongTime: Infinity },
    { currentSongTime: NaN },
    { currentSongTime: null },
    { currentSongTime: "5.5" },
    { globalQuantization: null },
    { globalQuantization: 4 },
    { globalQuantization: "half" },
    { clipLaunchQuantization: "bar" },
    { transportPlaying: true },
    { recording: true },
    { playingSessionClips: 1 },
    { queuedSessionClips: 1 },
    { signatureNumerator: 3 },
    { clipWarped: false },
    { loopStart: 1 },
    { activeLengthBeats: 8 },
    { launchMode: "gate" },
    { legato: true },
    { followActionsEnabled: true },
    { listenerBoundToSource: false },
  ])("keeps unsupported audio baseline fields denied: %j", (patch) => {
    expect(() =>
      validateSupportedAudioBaseline({
        ...SUPPORTED_AUDIO_BASELINE,
        globalQuantization: "bar",
        currentSongTime: 5.5,
        ...patch,
      }),
    ).toThrow();
  });
  it.each([
    { globalQuantization: "none", currentSongTime: 5.5 },
    { globalQuantization: "bar", currentSongTime: 0 },
  ])(
    "blocks a supported but undeclared starting state without submission: %j",
    async (state) => {
      const driver = new ControlledDriver();
      const facts = { ...SUPPORTED_AUDIO_BASELINE, ...state };
      driver.baseline = {
        ...driver.baseline,
        facts,
        sources: { a: { ...driver.baseline.sources.a!, facts } },
      };
      const result = await execute(driver, {
        fixture: {
          ...fixture,
          baseline: {
            ...SUPPORTED_AUDIO_BASELINE,
            globalQuantization: "bar",
            currentSongTime: 5.5,
          },
        },
      });
      expect(result.status).toBe("blocked");
      expect(driver.submissions).toEqual([]);
      expect(result.unrun).toEqual(["first", "second"]);
      expect(driver.calls).toContain("cleanup");
      expect(result.persisted).toBe(true);
    },
  );
  it.each([
    "globalQuantization",
    "clipLaunchQuantization",
    "currentSongTime",
    "playingSessionClips",
    "queuedSessionClips",
    "recording",
    "clipWarped",
    "loopStart",
    "activeLengthBeats",
    "legato",
  ])(
    "blocks baseline mismatch %s before submission without repair",
    async (key) => {
      const driver = new ControlledDriver();
      driver.baseline = {
        ...driver.baseline,
        facts: { ...driver.baseline.facts, [key]: "wrong" },
      };
      const result = await execute(driver);
      expect(result.status).toBe("blocked");
      expect(driver.submissions).toEqual([]);
      expect(result.unrun).toEqual(["first", "second"]);
      expect(driver.calls).toContain("cleanup");
      expect(result.persisted).toBe(true);
    },
  );
  it.each(["(A)", "Answer (B)", "(b)", "( B )", "(B)\nmore"])(
    "rejects incorrect or malformed answer %s",
    async (answer) => {
      const driver = new ControlledDriver();
      driver.answer = answer;
      const result = await execute(driver);
      expect(result.status).toBe("failed");
      expect(
        result.assertions.find((entry) => entry.name === "choice")?.code,
      ).toBe(answer === "(A)" ? "incorrect-choice" : "invalid-format");
    },
  );
  it("trims only outside exact complete parenthesized choices", () => {
    expect(parseParenthesizedChoice(" \n(B)\t")).toEqual({
      valid: true,
      choice: "B",
    });
    for (const text of ["( B)", "(B )", "B", "(E)", "(B)(B)", "(B)\n(B)", ""])
      expect(parseParenthesizedChoice(text)).toEqual({ valid: false });
  });
  it.each([
    "source",
    "metrics",
    "coverage",
    "cleanup",
    "context",
    "restart",
    "unchanged",
    "recapture",
  ] as const)("fails independently wrong %s evidence", async (kind) => {
    const driver = new ControlledDriver();
    if (kind === "source")
      driver.captured = { ...capture, source: { ...source, clipId: "wrong" } };
    if (kind === "metrics")
      driver.captured = { ...capture, metricFamilies: ["peak"] };
    if (kind === "coverage")
      driver.captured = { ...capture, endSample: capture.endSample - 1 };
    if (kind === "cleanup")
      driver.captured = { ...capture, cleanupComplete: false };
    if (kind === "context")
      driver.savedContext = { ...contextEvidence, passId: "wrong" };
    if (kind === "restart")
      driver.collected = { ...driver.collected, contexts: [contextEvidence] };
    if (kind === "unchanged")
      driver.collected = { ...driver.collected, unchanged: [] };
    if (kind === "recapture") driver.extraCapture = true;
    const result = await execute(driver);
    expect(result.status).toBe("failed");
    if (["source", "metrics", "coverage", "cleanup", "context"].includes(kind))
      expect(driver.submissions).toHaveLength(1);
  });
  it.each(["wrongIdentity", "turnIdentity", "malformedTurn"] as const)(
    "rejects %s without duplicate submission",
    async (key) => {
      const driver = new ControlledDriver();
      driver[key] = true;
      const result = await execute(driver);
      expect(result.status).toBe("failed");
      expect(driver.submissions).toHaveLength(1);
    },
  );
  it("cancels a hanging turn, then closes and cleans using fresh signals", async () => {
    const driver = new ControlledDriver();
    driver.hang = true;
    const controller = new AbortController();
    const events: LifecycleEvent[] = [];
    const pending = execute(driver, {
      signal: controller.signal,
      event: (event) => {
        events.push(event);
        if (event.stage === "turn.first" && event.phase === "started")
          queueMicrotask(() => controller.abort(new Error("cancelled")));
      },
    });
    const result = await pending;
    expect(result.status).toBe("cancelled");
    expect(result.cleanupComplete && result.persisted).toBe(true);
    expect(
      events.some(
        (event) => event.phase === "cancelled" && event.stage === "turn.first",
      ),
    ).toBe(true);
    expect(driver.submissions).toHaveLength(1);
  });
  it("bounds hung operations and preserves primary failure through cleanup/persistence failure", async () => {
    const driver = new ControlledDriver();
    driver.hang = true;
    driver.closeError = true;
    driver.cleanupError = true;
    const result = await execute(driver, {
      scenario: {
        ...scenario,
        steps: scenario.steps.map((step) => ({ ...step, timeoutMs: 20 })),
      },
      persist: async () => {
        throw new Error("receipt failure");
      },
    });
    expect(result.status).toBe("failed");
    expect(result.primaryFailure?.message).toContain("Deadline");
    expect(result.finalizationFailures.map((entry) => entry.stage)).toEqual([
      "unsubscribe",
      "cleanup",
      "persistence",
    ]);
    expect(result.cleanupComplete || result.persisted).toBe(false);
  });
  it("does not declare success when cleanup or persistence fails", async () => {
    const driver = new ControlledDriver();
    driver.cleanupError = true;
    expect((await execute(driver)).status).toBe("finalization-failed");
    expect(
      (
        await execute(new ControlledDriver(), {
          persist: async () => {
            throw new Error("disk full");
          },
        })
      ).status,
    ).toBe("finalization-failed");
  });
  it("cleans partially launched drivers and preserves failure evidence", async () => {
    const driver = new ControlledDriver();
    driver.failLaunch = true;
    const result = await execute(driver);
    expect(result.primaryFailure?.stage).toBe("launch");
    expect(driver.calls).toEqual(["launch", "cleanup", "persist"]);
    expect(result.unrun).toEqual(["first", "second"]);
  });
  it("redacts credentials from persisted and returned evidence", async () => {
    const driver = new ControlledDriver();
    driver.answer = "Bearer abcsecret";
    driver.cleanupError = true;
    const result = await execute(driver);
    expect(JSON.stringify(result)).not.toContain("abcsecret");
    expect(JSON.stringify(receipts.at(-1))).not.toContain("abcsecret");
    expect(JSON.stringify(result)).toContain("[REDACTED]");
  });
  it("requires declared capabilities/assertions before side effects", async () => {
    const driver = new ControlledDriver();
    await expect(
      execute(driver, {
        scenario: { ...scenario, requiredCapabilities: ["unknown"] },
      }),
    ).rejects.toThrow("Unsupported capability");
    await expect(
      execute(driver, {
        scenario: {
          ...scenario,
          steps: [{ ...scenario.steps[0]!, assertions: [] }],
          assertions: [],
        },
      }),
    ).rejects.toThrow("No assertions");
    expect(driver.calls).toEqual([]);
  });
  it("supports new scenario data and registered assertions without runner edits", async () => {
    const registry = createDefaultAssertions().register(
      "reviewed-custom",
      ({ turns }) => ({
        passed: turns.length === 2,
        code: "count",
        detail: "Custom reviewed assertion",
      }),
    );
    const result = await execute(new ControlledDriver(), {
      registry,
      scenario: {
        ...scenario,
        id: "a-different-case",
        assertions: [{ name: "reviewed-custom", parameters: {} }],
      },
    });
    expect(result.status).toBe("passed");
  });
  it("reports expected refusal and recovered execution separately from clean success", async () => {
    const refusing = new ControlledDriver();
    refusing.terminalStatus = "refused";
    const registry = createDefaultAssertions().register(
      "expected-denial",
      ({ turn }) => ({
        passed: turn?.status === "refused",
        code: "denial",
        detail: "Declared safety refusal",
      }),
    );
    const refused = await execute(refusing, {
      registry,
      scenario: {
        ...scenario,
        steps: [
          {
            ...scenario.steps[1]!,
            expectedStatus: "refused",
            assertions: [{ name: "expected-denial", parameters: {} }],
          },
        ],
        assertions: [{ name: "unchanged", parameters: { scopes: "media" } }],
      },
    });
    expect(refused.status).toBe("expected-refusal");
    const recovered = new ControlledDriver();
    recovered.collected = {
      ...recovered.collected,
      recoveries: ["An adapter reconnected before observation"],
    };
    expect((await execute(recovered)).status).toBe("recovered");
  });
  it("counts failed submission attempts as executed and never retries ambiguous acceptance", async () => {
    const driver = new ControlledDriver();
    let attempts = 0;
    driver.submit = async () => {
      attempts++;
      throw new Error("Permission denied");
    };
    const result = await execute(driver);
    expect(attempts).toBe(1);
    expect(result.executed).toEqual(["first"]);
    expect(result.unrun).toEqual(["second"]);
    expect(result.primaryFailure?.message).toContain("Permission denied");
  });
  it("bounds hung cleanup and persistence without skipping other owned cleanup", async () => {
    const driver = new ControlledDriver();
    driver.cleanup = async () => new Promise<void>(() => {});
    const result = await execute(driver, {
      scenario: {
        ...scenario,
        budget: { runMs: 2000, cleanupMs: 500, persistenceMs: 500 },
      },
      persist: async () => new Promise<void>(() => {}),
    });
    expect(result.status).toBe("finalization-failed");
    expect(result.finalizationFailures.map((entry) => entry.stage)).toEqual([
      "cleanup",
      "persistence",
    ]);
    expect(result.persisted).toBe(false);
  });
  it("freezes runner oracles before adapters execute", async () => {
    const driver = new ControlledDriver();
    const launch = driver.launch.bind(driver);
    driver.launch = async (ctx) => {
      await launch(ctx);
      expect(Object.isFrozen(ctx.fixture.baseline)).toBe(true);
      expect(Object.isFrozen(ctx.scenario.steps[0])).toBe(true);
    };
    expect((await execute(driver)).status).toBe("passed");
  });
  it("rejects unversioned drivers and turn evidence before claiming success", async () => {
    const driver = new ControlledDriver();
    Object.defineProperty(driver, "schemaVersion", { value: 2 });
    await expect(execute(driver)).rejects.toThrow("Unsupported driver version");
    expect(driver.calls).toEqual([]);
  });
  it("rejects linked directories and multiply-owned source inodes", async () => {
    const alias = join(root, "alias");
    await symlink(catalogRoot, alias);
    await expect(
      stageFixture({
        fixture,
        catalogRoot: alias,
        workingRoot,
        runId: "linked",
        allowSynthetic: true,
      }),
    ).rejects.toThrow("Symlink");
    await link(join(catalogRoot, "input.wav"), join(root, "outside-link.wav"));
    await expect(
      stageFixture({
        fixture,
        catalogRoot,
        workingRoot,
        runId: "shared",
        allowSynthetic: true,
      }),
    ).rejects.toThrow("ownership");
  });
  it.each([
    { capturePassIds: [] },
    { capturePassIds: ["pass-1", "hidden-recapture"] },
    { capturePassIds: ["wrong-pass"] },
  ])(
    "requires complete final capture inventory %j",
    async ({ capturePassIds }) => {
      const driver = new ControlledDriver();
      driver.collected = { ...driver.collected, capturePassIds };
      const result = await execute(driver);
      expect(result.status).toBe("failed");
      expect(result.primaryFailure?.stage).toBe("assert.run.capture-count");
    },
  );
  it("publishes precondition and finalization failure lifecycle without a completed run event", async () => {
    const events: LifecycleEvent[] = [];
    const driver = new ControlledDriver();
    driver.baseline = { ...driver.baseline, facts: {} };
    const result = await execute(driver, {
      event: (event) => events.push(event),
      persist: async () => {
        throw new Error("receipt unavailable");
      },
    });
    expect(result.status).toBe("blocked");
    expect(
      events
        .filter((event) => event.stage === "preconditions")
        .map((event) => event.phase),
    ).toEqual(["queued", "started", "failed"]);
    expect(events.at(-1)).toMatchObject({ stage: "run", phase: "failed" });
    expect(
      events.some(
        (event) => event.stage === "run" && event.phase === "completed",
      ),
    ).toBe(false);
  });
  it("blocks catalog-original playback even when its media hash matches", async () => {
    const driver = new ControlledDriver();
    driver.readBaseline = async () => ({
      ...driver.baseline,
      sources: {
        a: {
          ...driver.baseline.sources.a!,
          loadedMediaPath: join(catalogRoot, "input.wav"),
        },
      },
    });
    const result = await execute(driver);
    expect(result.status).toBe("blocked");
    expect(result.primaryFailure?.message).toContain(
      "outside owned staged inventory",
    );
    expect(driver.submissions).toEqual([]);
  });
  it("rejects post-stage source substitution through a working-media symlink", async () => {
    const driver = new ControlledDriver();
    const launch = driver.launch.bind(driver);
    driver.launch = async (ctx) => {
      await launch(ctx);
      await rm(driver.baseline.sources.a!.loadedMediaPath);
      await symlink(
        join(catalogRoot, "input.wav"),
        driver.baseline.sources.a!.loadedMediaPath,
      );
    };
    const result = await execute(driver);
    expect(result.status).toBe("blocked");
    expect(result.primaryFailure?.message).toContain("Symlink");
    expect(driver.submissions).toEqual([]);
  });
  it("requires explicit provisioning before dependency-bearing runs start", async () => {
    const driver = new ControlledDriver();
    await expect(
      runAcceptance({
        scenario,
        fixture,
        driver,
        stage: async () => {
          throw new Error("must not stage");
        },
        persist: async () => {},
      }),
    ).rejects.toThrow("explicit candidate provisioning");
    expect(driver.calls).toEqual([]);
  });
  it("retains a separate verified candidate inventory in driver context and receipt", async () => {
    const driver = new ControlledDriver();
    const result = await execute(driver);
    expect(result.status).toBe("passed");
    expect(result.dependencyInventory?.resources).toHaveLength(1);
    expect(driver.contexts[0]?.dependencyInventory).toEqual(
      result.dependencyInventory,
    );
    expect(result.dependencyInventory?.candidateRoot).toBe(candidateRoot);
    expect(
      fixture.resources.some((entry) => entry.target.endsWith(".amxd")),
    ).toBe(false);
  });
  it.each([
    "wrong-hash",
    "undeclared",
    "collision",
    "symlink",
    "repair",
  ] as const)("fails closed on candidate provisioning %s", async (kind) => {
    const driver = new ControlledDriver();
    const result = await execute(driver, {
      provision: async (ctx) => {
        const inventory = await provision(ctx);
        const resource = inventory.resources[0]!;
        if (kind === "wrong-hash")
          return {
            ...inventory,
            resources: [{ ...resource, sha256: digest("other-candidate") }],
          };
        if (kind === "undeclared")
          return {
            ...inventory,
            resources: [{ ...resource, id: "undeclared" }],
          };
        if (kind === "collision")
          return {
            ...inventory,
            resources: [{ ...resource, target: "project.als" }],
          };
        if (kind === "symlink") {
          const target = join(
            ctx.stagedFixture!.workingDirectory,
            resource.target,
          );
          await rm(target);
          await symlink(join(candidateRoot, resource.path), target);
        }
        if (kind === "repair")
          await writeFile(
            ctx.stagedFixture!.projectPath,
            "silent fixture repair",
          );
        return inventory;
      },
    });
    expect(result.status).toBe("failed");
    expect(driver.calls).not.toContain("launch");
    expect(driver.calls).toContain("cleanup");
    expect(result.primaryFailure?.stage).toBe(
      kind === "repair" ? "fixture-admission" : "provision",
    );
    expect(result.persisted).toBe(true);
  });
  it("rejects loaded dependency hashes different from the candidate inventory", async () => {
    const driver = new ControlledDriver();
    driver.baseline = {
      ...driver.baseline,
      dependencyHashes: { "production-listener": digest("old-listener") },
    };
    const result = await execute(driver);
    expect(result.status).toBe("blocked");
    expect(driver.submissions).toEqual([]);
  });
  it("cancels provisioning and still executes cleanup and persistence", async () => {
    const controller = new AbortController();
    const driver = new ControlledDriver();
    const result = await execute(driver, {
      signal: controller.signal,
      provision: async (ctx) => {
        controller.abort(new Error("cancel provisioning"));
        ctx.signal.throwIfAborted();
        return provision(ctx);
      },
    });
    expect(result.status).toBe("cancelled");
    expect(driver.calls).toEqual(["cleanup", "persist"]);
    expect(result.persisted && result.cleanupComplete).toBe(true);
  });
  it.each(["array", "fields", "text", "bytes"] as const)(
    "fails explicitly instead of retaining sanitizer-truncated %s evidence",
    async (kind) => {
      const driver = new ControlledDriver();
      if (kind === "array")
        driver.extraTurnFields = {
          extension: Array.from({ length: 5000 }, () => "x"),
        };
      if (kind === "fields")
        driver.extraTurnFields = {
          extension: Object.fromEntries(
            Array.from({ length: 2100 }, (_, index) => [
              `field${index}`,
              index,
            ]),
          ),
        };
      if (kind === "text")
        driver.extraTurnFields = { extension: "x".repeat(300_000) };
      if (kind === "bytes")
        driver.extraTurnFields = {
          extension: Array.from({ length: 3000 }, () => "x".repeat(1000)),
        };
      const result = await execute(driver);
      expect(result.status).toBe("failed");
      expect(result.primaryFailure?.message).toContain("sanitization");
      expect(result.turns).toEqual([]);
      expect(result.persisted).toBe(true);
    },
  );
  it("omits binary/audio extensions visibly without losing typed evidence", async () => {
    const driver = new ControlledDriver();
    driver.extraTurnFields = {
      audioBody: Buffer.from("private audio"),
      binaryBody: Buffer.from("private binary"),
    };
    const result = await execute(driver);
    expect(result.status).toBe("passed");
    const serialized = JSON.stringify(result);
    expect(serialized).toContain("[Audio data omitted]");
    expect(serialized).toContain("[Binary data omitted]");
    expect(serialized).not.toContain("private audio");
    expect(serialized).not.toContain("private binary");
    expect(result.turns[0]?.captures).toHaveLength(1);
  });
  it("validates sanitized required identifiers instead of coercing evidence types", async () => {
    const driver = new ControlledDriver();
    driver.baseline = {
      ...driver.baseline,
      sources: {
        a: {
          ...driver.baseline.sources.a!,
          listenerId: `ghp_${"a".repeat(30)}`,
        },
      },
    };
    const result = await execute(driver);
    expect(result.status).toBe("blocked");
    expect(driver.submissions).toEqual([]);
    expect(result.baseline).toBeUndefined();
  });
  it("awaits a late noncooperative launch before owned cleanup", async () => {
    const driver = new ControlledDriver();
    const controller = new AbortController();
    const order: string[] = [];
    let running = false;
    driver.launch = async () => {
      order.push("launch-start");
      controller.abort(new Error("cancel launch"));
      await new Promise<void>((done) => setTimeout(done, 20));
      running = true;
      order.push("launch-settled");
    };
    driver.cleanup = async () => {
      order.push("cleanup");
      expect(running).toBe(true);
      running = false;
    };
    const result = await execute(driver, { signal: controller.signal });
    expect(order).toEqual(["launch-start", "launch-settled", "cleanup"]);
    expect(running).toBe(false);
    expect(result.status).toBe("cancelled");
    expect(result.cleanupComplete).toBe(true);
  });
  it("never reports cleanup complete when acquisition exceeds its grace budget; later ownership is still reclaimed", async () => {
    const driver = new ControlledDriver();
    const controller = new AbortController();
    let release: () => void = () => {};
    const launched = new Promise<void>((done) => {
      release = done;
    });
    let finishLateCleanup: () => void = () => {};
    const reclaimed = new Promise<void>((done) => {
      finishLateCleanup = done;
    });
    let running = false;
    let cleanupCalls = 0;
    driver.launch = async () => {
      controller.abort(new Error("cancel launch"));
      await launched;
      running = true;
    };
    driver.cleanup = async () => {
      cleanupCalls++;
      expect(running).toBe(true);
      running = false;
    };
    const result = await execute(driver, {
      signal: controller.signal,
      scenario: { ...scenario, budget: { ...scenario.budget, cleanupMs: 100 } },
      event: (event) => {
        if (
          event.stage === "late.dependency-integrity" &&
          event.phase === "completed"
        )
          finishLateCleanup();
      },
    });
    expect(result.status).toBe("cancelled");
    expect(result.cleanupComplete).toBe(false);
    expect(
      result.finalizationFailures.some((entry) => entry.stage === "quiescence"),
    ).toBe(true);
    expect(cleanupCalls).toBe(0);
    release();
    await reclaimed;
    expect(cleanupCalls).toBe(1);
    expect(running).toBe(false);
    expect(result.cleanupComplete).toBe(false);
  });
  it.each(["buffered", "asynchronous"] as const)(
    "reuses non-listening admission with only fact assertions through %s driver",
    async (delivery) => {
      const driver =
        delivery === "buffered"
          ? new FactOnlyDriver()
          : new AsynchronousFactOnlyDriver();
      const genericFixture: FixtureManifest = {
        schemaVersion: 1,
        provenance: fixture.provenance,
        qualification: "synthetic-only",
        id: "facts-only",
        dependencies: [],
        resources: [fixture.resources[0]!],
        baseline: driver.facts,
      };
      const genericScenario: ScenarioManifest = {
        ...scenario,
        id: "inspect-facts",
        fixtureId: genericFixture.id,
        requiredCapabilities: ["inspect-facts"],
        permissions: [],
        steps: [
          {
            id: "inspect",
            message: "How many tracks are present?",
            timeoutMs: 1000,
            assertions: [
              {
                name: "fact-equals",
                parameters: { key: "trackCount", expected: 2 },
              },
            ],
          },
        ],
        assertions: [
          {
            name: "fact-equals",
            parameters: { key: "globalQuantization", expected: "bar" },
          },
        ],
      };
      validateFixture(genericFixture);
      expect(() =>
        validateSupportedAudioBaseline(genericFixture.baseline),
      ).toThrow("Unsupported audio baseline");
      const result = await runAcceptance({
        fixture: genericFixture,
        scenario: genericScenario,
        driver,
        stage: (ctx) =>
          stageFixture({
            fixture: genericFixture,
            catalogRoot,
            workingRoot,
            runId: ctx.runId,
            allowSynthetic: true,
            signal: ctx.signal,
          }),
        persist: async (receipt) => {
          receipts.push(receipt);
        },
      });
      expect(result.status).toBe("passed");
      expect(result.baseline?.sources).toBeUndefined();
      expect(result.turns[0]?.captures).toEqual([]);
      expect(result.turns[0]?.contexts).toEqual([]);
      expect(result.evidence?.contexts).toEqual([]);
      expect(result.assertions.every((entry) => entry.passed)).toBe(true);
    },
  );
  it("makes capture and context assertions explicitly fail without source/listener evidence", () => {
    const registry = createDefaultAssertions();
    const baseline: BaselineEvidence = {
      schemaVersion: 1,
      facts: {},
      dependencyHashes: {},
    };
    for (const reference of [
      {
        name: "capture",
        parameters: {
          sourceId: "a",
          metricFamilies: "peak,rms",
          sampleRate: 48_000,
          expectedFrames: 96_000,
        },
      },
      { name: "context", parameters: { afterRestart: true } },
    ]) {
      const checked = registry.evaluate(reference, {
        fixture,
        baseline,
        turns: [],
      });
      expect(checked).toMatchObject({ passed: false, code: "missing-source" });
    }
  });
  it("rejects unknown manifest envelope, nested, and built-in assertion parameter fields", () => {
    for (const invalid of [
      { ...fixture, basline: fixture.baseline },
      { ...fixture, provenance: { ...fixture.provenance, licence: "ignored" } },
      {
        ...fixture,
        resources: [{ ...fixture.resources[0], digest: "ignored" }],
      },
    ])
      expect(() => validateFixture(invalid)).toThrow("Unknown schema field");
    for (const invalid of [
      { ...scenario, assertion: [] },
      { ...scenario, budget: { ...scenario.budget, timeout: 100 } },
      {
        ...scenario,
        permissions: [{ ...scenario.permissions[0], permitted: true }],
      },
      {
        ...scenario,
        steps: [{ ...scenario.steps[0], expectdStatus: "failed" }],
      },
      {
        ...scenario,
        assertions: [
          { name: "choice", parameters: { expected: "B" }, optional: true },
        ],
      },
    ])
      expect(() => validateScenario(invalid, fixture)).toThrow(
        "Unknown schema field",
      );
    const registry = createDefaultAssertions();
    for (const reference of [
      { name: "choice", parameters: { expected: "B", expectd: "A" } },
      { name: "no-capture", parameters: { optional: true } },
      {
        name: "fact-equals",
        parameters: { key: "trackCount", expected: 2, fallback: true },
      },
    ])
      expect(() => registry.validate(reference)).toThrow(
        "Unknown schema field",
      );
  });
  it("validates bounded scoped permissions and resolves only explicit actual-source references", () => {
    const permission = {
      tool: "session.listen",
      action: "listen",
      risk: "medium" as const,
      maxUses: 2,
      arguments: {
        "target.trackId": "$source.trackId",
        "target.clipId": "$source.clipId",
        "target.slotIndex": "$source.slotIndex",
        "options.durationBeats": 4,
      },
    };
    validatePermission(permission);
    const actual = {
      source: {
        ...source,
        trackId: "observed-track",
        clipId: "observed-clip",
        slotIndex: 2,
      },
      listenerId: "listener",
      loadedMediaPath: "/owned/source.wav",
      facts: {},
    };
    const resolved = resolvePermissionArguments(permission, actual);
    expect(resolved).toEqual({
      "target.trackId": "observed-track",
      "target.clipId": "observed-clip",
      "target.slotIndex": 2,
      "options.durationBeats": 4,
    });
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(permission.arguments["target.trackId"]).toBe("$source.trackId");
    expect(() => resolvePermissionArguments(permission)).toThrow(
      "no actual source binding",
    );
    expect(
      resolvePermissionArguments({ ...permission, arguments: {} }),
    ).toEqual({});
    expect(
      resolvePermissionArguments({ ...permission, arguments: { label: "*" } }),
    ).toEqual({ label: "*" });
  });
  it("bounds and binds source inventories and per-step permission references", () => {
    const declared = fixture.sources![0]!;
    validateFixture(fixture);
    for (const sources of [
      [],
      [declared, declared],
      [declared, { ...declared, id: "b" }],
      [{ ...declared, mediaTarget: "media/resource-002.wav" }],
      [{ ...declared, sceneIndex: -1 }],
      [{ ...declared, unexpected: true }],
      Array.from({ length: 17 }, (_, index) => ({
        ...declared,
        id: `source-${index}`,
        sceneIndex: index,
      })),
    ])
      expect(() => validateFixture({ ...fixture, sources })).toThrow();
    const scoped = {
      ...scenario,
      steps: scenario.steps.map((step) => ({ ...step, sourceId: "a" })),
      permissions: [{ ...scenario.permissions[0]!, stepIds: ["first"] }],
    };
    validateScenario(scoped, fixture);
    for (const stepIds of [[], ["first", "first"], ["absent"]])
      expect(() =>
        validateScenario(
          {
            ...scoped,
            permissions: [{ ...scoped.permissions[0]!, stepIds }],
          },
          fixture,
        ),
      ).toThrow();
    expect(() =>
      validateScenario(
        {
          ...scoped,
          steps: [{ ...scoped.steps[0]!, sourceId: "absent" }],
        },
        fixture,
      ),
    ).toThrow("Unknown step source");
    const permission = {
      ...scenario.permissions[0]!,
      arguments: { listenerId: "$source.listenerId" },
    };
    expect(
      resolvePermissionArguments(permission, {
        source,
        listenerId: "listener:b",
        loadedMediaPath: "/owned/b.wav",
        facts: {},
      }),
    ).toEqual({ listenerId: "listener:b" });
  });
  it("rejects malformed or unbounded native ownership and measured content", () => {
    const native = {
      generation: randomUUID(),
      connectionId: randomUUID(),
      connectionEpoch: randomUUID(),
      nativeEpoch: 1,
    };
    const turn = {
      schemaVersion: 1,
      ...identity,
      userMessageId: "message-1",
      operationId: capture.operationId,
      assistantMessageId: "assistant-1",
      terminal: true,
      status: "completed",
      assistantText: "Observed.",
      facts: {},
      contexts: [contextEvidence],
      captures: [{ ...capture, native, spectralCentroidHz: 500 }],
    };
    validateTurn(turn);
    for (const patch of [
      { generation: "invalid" },
      { connectionId: "" },
      { connectionEpoch: "x".repeat(37) },
      { nativeEpoch: 0 },
      { nativeEpoch: 1.5 },
      { nativeEpoch: 1_000_001 },
      { extra: true },
    ])
      expect(() =>
        validateTurn({
          ...turn,
          captures: [{ ...capture, native: { ...native, ...patch } }],
        }),
      ).toThrow();
    for (const spectralCentroidHz of [-1, Infinity, NaN, 384_001, "500"])
      expect(() =>
        validateTurn({
          ...turn,
          captures: [{ ...capture, native, spectralCentroidHz }],
        }),
      ).toThrow("Invalid measured spectral centroid");
  });
  it.each([
    { risk: "high" },
    { risk: "destructive" },
    { risk: "unknown" },
    { maxUses: 0 },
    { maxUses: 17 },
    { maxUses: 1.5 },
    { maxUses: Infinity },
    { tool: "*" },
    { action: "" },
    { allowAll: true },
    { arguments: { trackId: "$source.unknown" } },
    { arguments: { "target..trackId": "$source.trackId" } },
    { arguments: { "target.constructor": "bad" } },
    { arguments: { target: "x", "target.trackId": "y" } },
    { arguments: { target: { trackId: "nested-not-flattened" } } },
  ])("rejects unsafe or malformed scoped permission %j", (override) => {
    expect(() =>
      validatePermission({ ...scenario.permissions[0], ...override }),
    ).toThrow();
  });
  it("verifies and reports the full production bundle plus separately generated configuration", async () => {
    const driver = new ControlledDriver();
    const result = await execute(driver, {
      provision: async (ctx) => {
        const inventory = await provisionBundle(ctx);
        driver.baseline = {
          ...driver.baseline,
          dependencyHashes: dependencyInventoryHashes(inventory),
        };
        return inventory;
      },
    });
    expect(result.status).toBe("passed");
    const inventory = result.dependencyInventory!;
    expect(inventory.resources).toHaveLength(4);
    expect(inventory.generatedConfigurations).toHaveLength(1);
    expect(new Set(inventory.resources.map((entry) => entry.id)).size).toBe(1);
    expect(result.baseline?.dependencyHashes).toEqual(
      dependencyInventoryHashes(inventory),
    );
    expect(result.baseline?.dependencyHashes["production-listener"]).not.toBe(
      inventory.resources[0]?.sha256,
    );
    expect(
      inventory.resources.some((entry) =>
        entry.target.endsWith("agent_signal_storage.js"),
      ),
    ).toBe(false);
  });
  it("hashes every bundle member canonically independent of inventory order or machine root", () => {
    const inventory: DependencyInventory = {
      ...baseCandidateInventory,
      resources: [
        ...baseCandidateInventory.resources,
        {
          id: "production-listener",
          path: "processor.js",
          target: "dependencies/processor.js",
          sha256: digest("js"),
          bytes: 2,
        },
      ],
      generatedConfigurations: [
        {
          id: "production-listener",
          target: "dependencies/agent_signal_storage.js",
          sha256: digest("config"),
          bytes: 6,
        },
      ],
    };
    const expected = dependencyInventoryHashes(inventory);
    expect(
      dependencyInventoryHashes({
        ...inventory,
        candidateRoot: "/different-candidate",
        resources: [...inventory.resources].reverse(),
      }),
    ).toEqual(expected);
    expect(
      dependencyInventoryHashes({
        ...inventory,
        resources: inventory.resources.map((entry) => ({
          ...entry,
          sha256: digest("changed"),
        })),
      }),
    ).not.toEqual(expected);
    expect(
      dependencyInventoryHashes({
        ...inventory,
        generatedConfigurations: inventory.generatedConfigurations!.map(
          (entry) => ({ ...entry, sha256: digest("changed-config") }),
        ),
      }),
    ).not.toEqual(expected);
  });
  it("admits a 256-file single dependency bundle but bounds files, configuration, and mount collisions", () => {
    const inventory: DependencyInventory = {
      ...baseCandidateInventory,
      resources: Array.from({ length: 256 }, (_, index) => ({
        id: "production-listener",
        path: `asset-${index}.js`,
        target: `dependencies/asset-${index}.js`,
        sha256: digest("x"),
        bytes: 1,
      })),
    };
    validateDependencyInventory(inventory, fixture);
    expect(Object.keys(dependencyInventoryHashes(inventory))).toEqual([
      "production-listener",
    ]);
    expect(() =>
      validateDependencyInventory(
        {
          ...inventory,
          resources: Array.from({ length: 513 }, (_, index) => ({
            ...inventory.resources[0],
            path: `asset-${index}.js`,
            target: `dependencies/asset-${index}.js`,
          })),
        },
        fixture,
      ),
    ).toThrow("bounded list");
    const config = {
      id: "production-listener",
      target: "dependencies/config.js",
      sha256: digest("x"),
      bytes: 1,
    };
    for (const invalid of [
      { ...inventory, generatedConfigurations: [{ ...config, id: "unknown" }] },
      { ...inventory, generatedConfigurations: [{ ...config, bytes: 65_537 }] },
      {
        ...inventory,
        generatedConfigurations: [
          { ...config, target: "dependencies/asset-0.js" },
        ],
      },
      {
        ...inventory,
        generatedConfigurations: [
          { ...config, target: "dependencies/asset-0.js/child" },
        ],
      },
      {
        ...inventory,
        generatedConfigurations: [{ ...config, target: "project.als" }],
      },
      {
        ...inventory,
        generatedConfigurations: [{ ...config, target: "../escape.js" }],
      },
      {
        ...inventory,
        generatedConfigurations: [
          { ...config, path: "not-candidate-owned.js" },
        ],
      },
    ])
      expect(() => validateDependencyInventory(invalid, fixture)).toThrow();
  });
  it.each(["candidate-js", "copied-native", "generated-config"] as const)(
    "rejects bundle tampering in %s before launch",
    async (kind) => {
      const driver = new ControlledDriver();
      const result = await execute(driver, {
        provision: async (ctx) => {
          const inventory = await provisionBundle(ctx);
          const target =
            kind === "candidate-js"
              ? join(candidateRoot, "processor.js")
              : join(
                  ctx.stagedFixture!.workingDirectory,
                  kind === "copied-native"
                    ? "dependencies/native/Contents/MacOS/processor"
                    : "dependencies/agent_signal_storage.js",
                );
          await writeFile(target, "tampered");
          return inventory;
        },
      });
      expect(result.status).toBe("failed");
      expect(result.primaryFailure?.stage).toBe("provision");
      expect(driver.calls).not.toContain("launch");
    },
  );
  it("rechecks immutable production bundle files during finalization", async () => {
    const driver = new ControlledDriver();
    const collect = driver.collect.bind(driver);
    driver.collect = async (ctx) => {
      await writeFile(join(candidateRoot, "processor.js"), "changed source");
      return collect(ctx);
    };
    const result = await execute(driver, {
      provision: async (ctx) => {
        const inventory = await provisionBundle(ctx);
        driver.baseline = {
          ...driver.baseline,
          dependencyHashes: dependencyInventoryHashes(inventory),
        };
        return inventory;
      },
    });
    expect(result.status).toBe("finalization-failed");
    expect(result.cleanupComplete).toBe(false);
    expect(
      result.finalizationFailures.some(
        (entry) => entry.stage === "dependency-integrity",
      ),
    ).toBe(true);
  });
  it("fails before combined bounded evidence can overflow final receipt sanitization", async () => {
    const facts = Object.fromEntries(
      Array.from({ length: 61 }, (_, index) => [
        `field${index}`,
        "x".repeat(8192),
      ]),
    );
    const turnFacts = Object.fromEntries(
      Array.from({ length: 31 }, (_, index) => [
        `turnField${index}`,
        "x".repeat(8192),
      ]),
    );
    const driver = new ControlledDriver();
    driver.baseline = {
      ...driver.baseline,
      facts: { ...driver.baseline.facts, ...facts },
    };
    driver.extraTurnFields = { facts: turnFacts };
    driver.collected = { ...driver.collected, facts };
    const result = await execute(driver, {
      fixture: { ...fixture, baseline: { ...fixture.baseline, ...facts } },
      scenario: {
        ...scenario,
        budget: { runMs: 15_000, cleanupMs: 1000, persistenceMs: 1000 },
        steps: scenario.steps.map((step) => ({ ...step, timeoutMs: 5000 })),
      },
    });
    expect(result.status).toBe("failed");
    expect(result.primaryFailure?.message).toContain(
      "Combined evidence exceeds report budget",
    );
    expect(result.evidence).toBeUndefined();
    expect(result.persisted).toBe(true);
    expect(result.turns).toHaveLength(2);
  }, 15_000);
  it("rejects legacy unbounded grants and duplicate permission scope budgets", () => {
    expect(() =>
      validatePermission({ action: "listen", arguments: {} }),
    ).toThrow();
    expect(() =>
      validateScenario(
        {
          ...scenario,
          permissions: [
            {
              tool: "session.listen",
              action: "listen",
              risk: "low",
              maxUses: 1,
              arguments: { trackId: "track-1", clipId: "clip-1" },
            },
            {
              tool: "session.listen",
              action: "listen",
              risk: "medium",
              maxUses: 16,
              arguments: { clipId: "clip-1", trackId: "track-1" },
            },
          ],
        },
        fixture,
      ),
    ).toThrow("Duplicate identifier");
  });
});
