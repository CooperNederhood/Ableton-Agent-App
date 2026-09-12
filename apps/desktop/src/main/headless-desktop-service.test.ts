import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createFakeApplication,
  defaultFakeState,
} from "@ableton-agent/test-support";
import {
  MissingCopilotSessionError,
  type AgentSkillDescriptor,
} from "@ableton-agent/application";
import type {
  AgentLiveEventListener,
  LiveEventRuntime,
  LiveEventRuntimeEvent,
  LiveEventRuntimeState,
  SignalRuntime,
  SignalRuntimeEvent,
} from "@ableton-agent/runtime";
import type { LiveEventDefinition } from "@ableton-agent/agent-config";
import type {
  OutputAssignment,
  OutputConnection,
} from "@ableton-agent/signal-routing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { abletonToolMetadata } from "@ableton-agent/tools";
import type { RetentionPolicy } from "@ableton-agent/observability";

import {
  desktopAgentCatalogSchema,
  preferencesSchema,
  type DesktopAppEvent,
  type DesktopActiveAgent,
  type DesktopAgentCatalog,
  type DesktopAgentModel,
  type DesktopSession,
} from "../contracts.js";
import { ApprovalCoordinator, ApprovalPolicyController } from "./approvals.js";
import { DesktopJournalHost } from "./composition.js";
import { JsonPreferencesStore, JsonSessionStore } from "./desktop-service.js";
import {
  HeadlessDesktopService,
  type DesktopEventJournal,
} from "./headless-desktop-service.js";
import {
  JsonProjectSessionStore,
  type ProjectSessionStore,
} from "./project-session-store.js";

const temporaryDirectories: string[] = [];

function defaultCatalog(): DesktopAgentCatalog {
  return desktopAgentCatalogSchema.parse({
    definitions: [
      {
        name: "default",
        description: "General-purpose Ableton agent.",
        systemPrompt: "Help with Ableton.",
        tools: ["*"],
        resolvedTools: ["ableton_session_inspect"],
        editScope: ["session"],
        skills: [],
        inputChannels: [],
        sourceFile: "default.yaml",
        fingerprint: "a".repeat(64),
      },
    ],
  });
}

function agentModel(
  id: string,
  overrides: Partial<DesktopAgentModel> = {},
): DesktopAgentModel {
  return {
    id,
    displayName: `Model ${id}`,
    policyState: "enabled",
    capabilities: {
      vision: true,
      reasoningEffort: true,
      maxPromptTokens: 32_000,
      maxContextWindowTokens: 64_000,
    },
    supportedReasoningEfforts: ["low", "medium", "high"],
    defaultReasoningEffort: "medium",
    ...overrides,
  };
}

class FakeSignalRuntime implements SignalRuntime {
  readonly provider = {
    getPendingContexts: () => Promise.resolve([]),
    markDelivered: () => Promise.resolve(),
  };
  readonly assignments = new Map<string, OutputAssignment>();
  readonly connections: OutputConnection[] = [
    {
      connectionId: "connection-1",
      producer: {
        producerId: "producer-1",
        instanceId: "instance-1",
        displayName: "MIDI Capture",
        signalKind: "midi",
        schemaVersion: "midi-sample/v1",
      },
      status: "connected",
      connectedAt: 1,
      lastHeartbeatAt: 1,
    },
  ];
  activeSessionId: string | undefined;
  activeAgentIds: string[] = [];
  constructor(readonly lifecycle: string[] = []) {}
  getStatus() {
    return { state: "listening" as const, host: "127.0.0.1", port: 45832 };
  }
  start() {
    this.lifecycle.push("signals:start");
    return Promise.resolve();
  }
  stop() {
    this.lifecycle.push("signals:stop");
    return Promise.resolve();
  }
  setActiveAgentInstances(agentInstanceIds: readonly string[]) {
    this.activeAgentIds = [...agentInstanceIds];
  }
  addActiveAgentInstance(agentInstanceId: string) {
    void agentInstanceId;
  }
  removeActiveAgentInstance(agentInstanceId: string) {
    this.activeAgentIds = this.activeAgentIds.filter(
      (id) => id !== agentInstanceId,
    );
  }
  setActiveSession(sessionId: string | undefined) {
    this.activeSessionId = sessionId;
  }
  setDeliveryService() {}
  listConnections() {
    return this.connections;
  }
  listAssignments() {
    return [...this.assignments.values()];
  }
  upsertAssignment(assignment: OutputAssignment) {
    this.assignments.set(assignment.assignmentId, assignment);
    return assignment;
  }
  removeAssignment(assignmentId: string) {
    return this.assignments.delete(assignmentId);
  }
  subscribe(listener: (event: SignalRuntimeEvent) => void) {
    void listener;
    return () => undefined;
  }
}

class FakeLiveEventRuntime implements LiveEventRuntime {
  readonly provider = this;
  readonly states = new Map<string, LiveEventRuntimeState>();
  readonly subscribers = new Set<(event: LiveEventRuntimeEvent) => void>();
  configurations: Array<{
    definitions: readonly LiveEventDefinition[];
    listeners: readonly AgentLiveEventListener[];
  }> = [];
  activeAgentIds: string[] = [];
  inspectSelectionResult = {
    track: {
      index: 0,
      expectedReference: "00000000-0000-4000-8000-000000000010",
      expectedName: "Keys",
    },
    parameter: null,
  };
  start() {
    return Promise.resolve();
  }
  stop() {
    return Promise.resolve();
  }
  setDeliveryService() {}
  setActiveAgentInstances(agentInstanceIds: readonly string[]) {
    this.activeAgentIds = [...agentInstanceIds];
  }
  setConfiguration(
    definitions: readonly LiveEventDefinition[],
    listeners: readonly AgentLiveEventListener[],
  ) {
    this.configurations.push({ definitions, listeners });
    const ids = new Set(definitions.map(({ id }) => id));
    for (const id of this.states.keys()) {
      if (!ids.has(id)) this.states.delete(id);
    }
    for (const definition of definitions) {
      const existing = this.states.get(definition.id);
      this.states.set(definition.id, {
        definition,
        resolution: existing?.resolution ?? {
          status: "unresolved",
          reason: "not-connected",
        },
        ...(existing?.latestState === undefined
          ? {}
          : { latestState: existing.latestState }),
        history: existing?.history ?? [],
      });
    }
  }
  inspectSelection() {
    return Promise.resolve(this.inspectSelectionResult);
  }
  listStates() {
    return [...this.states.values()];
  }
  getState(eventId: string) {
    return this.states.get(eventId);
  }
  subscribe(listener: (event: LiveEventRuntimeEvent) => void) {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }
  getPendingLiveEventContexts() {
    return Promise.resolve([]);
  }
  markLiveEventContextsDelivered() {
    return Promise.resolve();
  }
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ableton-desktop-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function harness(
  options: Parameters<typeof createFakeApplication>[0] = {},
  serviceOptions: {
    onApprovalPolicyChange?: (
      policy: ReturnType<typeof preferencesSchema.parse>["approvalPolicy"],
    ) => void;
    agentCatalog?: {
      current: DesktopAgentCatalog;
      runtimeSkills?: readonly AgentSkillDescriptor[];
      refresh: () => Promise<DesktopAgentCatalog>;
    };
    signals?: SignalRuntime;
    liveEvents?: LiveEventRuntime;
    onAutoApprovedAgentIdsChange?: (
      agentInstanceIds: ReadonlySet<string>,
    ) => void;
    projectSessionStore?: ProjectSessionStore;
    projectIdentityPollIntervalMs?: number;
    eventJournal?: DesktopEventJournal;
    reconfigureEventJournal?: (policy: RetentionPolicy) => Promise<void>;
  } = {},
) {
  const directory = await temporaryDirectory();
  const preferencesStore = new JsonPreferencesStore(
    join(directory, "preferences.json"),
  );
  const sessionStore = new JsonSessionStore(join(directory, "sessions.json"));
  const fake = createFakeApplication(options);
  const approvals = new ApprovalCoordinator();
  const catalog = serviceOptions.agentCatalog?.current ?? defaultCatalog();
  const { agentCatalog, projectSessionStore, ...remainingServiceOptions } =
    serviceOptions;
  const service = new HeadlessDesktopService({
    application: fake.application,
    approvals,
    preferencesStore,
    sessionStore,
    ...(projectSessionStore === undefined ? {} : { projectSessionStore }),
    agentCatalog: agentCatalog ?? {
      current: catalog,
      refresh: () => Promise.resolve(catalog),
    },
    ...remainingServiceOptions,
  });
  const events: DesktopAppEvent[] = [];
  service.subscribe((event) => events.push(event));
  return {
    ...fake,
    approvals,
    service,
    events,
    sharedEvents: fake.events,
    directory,
    preferencesStore,
    sessionStore,
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function expectDeferredSessionMutationOrder(options: {
  initialAutoApprove: boolean;
  requestedAutoApprove: boolean;
  mutate: (
    fixture: Awaited<ReturnType<typeof harness>> & {
      first: DesktopActiveAgent;
      second: DesktopActiveAgent;
    },
  ) => Promise<void>;
  isMutationApplied: (session: DesktopSession) => boolean;
}): Promise<void> {
  const published: string[][] = [];
  const fixture = await harness(
    {},
    {
      onAutoApprovedAgentIdsChange: (ids) => published.push([...ids].sort()),
    },
  );
  const { service, sessionStore, events } = fixture;
  await service.start();
  const first = (await service.listActiveAgents())[0]!;
  const second = await service.createActiveAgent("default");
  if (options.initialAutoApprove) {
    await service.setAutoApproval("all", true);
  }

  events.length = 0;
  const entered = deferred<void>();
  const release = deferred<void>();
  const snapshots: DesktopSession[][] = [];
  const originalSave = sessionStore.save.bind(sessionStore);
  let blocked = false;
  vi.spyOn(sessionStore, "save").mockImplementation(async (sessions) => {
    const snapshot = structuredClone([...sessions]);
    snapshots.push(snapshot);
    if (
      !blocked &&
      snapshot[0]?.activeAgents.every(
        ({ autoApprove }) => autoApprove === options.requestedAutoApprove,
      )
    ) {
      blocked = true;
      entered.resolve();
      await release.promise;
    }
    await originalSave(sessions);
  });

  const yolo = service.setAutoApproval("all", options.requestedAutoApprove);
  await entered.promise;
  const mutation = options.mutate({ ...fixture, first, second });
  await settle();
  expect(snapshots).toHaveLength(1);
  expect(options.isMutationApplied(snapshots[0]![0]!)).toBe(false);

  release.resolve();
  await Promise.all([yolo, mutation]);

  const memory = (await service.getSessions())[0]!;
  const disk = (await sessionStore.load())[0]!;
  const changed = events.filter((event) => event.type === "sessions.changed");
  expect(options.isMutationApplied(memory)).toBe(true);
  expect(disk).toEqual(memory);
  expect(changed.at(-1)?.sessions[0]).toEqual(memory);
  expect(
    memory.activeAgents.every(
      ({ autoApprove }) => autoApprove === options.requestedAutoApprove,
    ),
  ).toBe(true);
  expect(published.at(-1)).toEqual(
    options.requestedAutoApprove
      ? memory.activeAgents.map(({ id }) => id).sort()
      : [],
  );
  expect(options.isMutationApplied(snapshots.at(-1)![0]!)).toBe(true);
  await service.stop();
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("desktop persistence stores", () => {
  it("uses defaults only for a missing preference file", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "preferences.json");
    const store = new JsonPreferencesStore(path);

    await expect(store.load()).resolves.toEqual(preferencesSchema.parse({}));
    await writeFile(path, "{not-json", "utf8");
    await expect(store.load()).rejects.toThrow(
      "Preferences could not be loaded",
    );
    expect(await readFile(path, "utf8")).toBe("{not-json");
  });

  describe("desktop active agent migration", () => {
    it("migrates a legacy mode session to one active agent snapshot", async () => {
      const directory = await temporaryDirectory();
      const sessionsPath = join(directory, "sessions.json");
      await writeFile(
        sessionsPath,
        JSON.stringify([
          {
            id: "legacy-sdk-session",
            title: "Legacy",
            updatedAt: new Date().toISOString(),
            projectName: "Legacy Project",
            mode: "explore",
            productionPlan: [],
            outputAssignments: [],
          },
        ]),
        "utf8",
      );
      const catalog = desktopAgentCatalogSchema.parse({
        definitions: [
          {
            name: "default",
            description: "General-purpose Ableton agent.",
            systemPrompt: "Help with Ableton.",
            tools: ["*"],
            resolvedTools: ["ableton_session_inspect"],
            editScope: ["session"],
            skills: [],
            inputChannels: [],
            sourceFile: "default.yaml",
            fingerprint: "a".repeat(64),
          },
        ],
        loadedAt: new Date().toISOString(),
      });

      const fake = createFakeApplication();
      const service = new HeadlessDesktopService({
        application: fake.application,
        approvals: new ApprovalCoordinator(),
        preferencesStore: new JsonPreferencesStore(
          join(directory, "preferences.json"),
        ),
        sessionStore: new JsonSessionStore(sessionsPath),
        agentCatalog: {
          current: catalog,
          refresh: () => Promise.resolve(catalog),
        },
      });

      await service.start();
      const [session] = await new JsonSessionStore(sessionsPath).load();
      expect(session).toMatchObject({
        version: 3,
        liveEvents: [],
        selectedAgentInstanceId: session?.activeAgents[0]?.id,
        activeAgents: [
          {
            definitionName: "default",
            label: "Default",
            sdkSessionId: "legacy-sdk-session",
            lifecycle: "ready",
            autoApprove: false,
            outputSubscriptions: [],
          },
        ],
      });
      await service.stop();
    });

    it("maps every legacy mode exactly and preserves SDK linkage and production data idempotently", async () => {
      const directory = await temporaryDirectory();
      const sessionsPath = join(directory, "sessions.json");
      const modeNames = [
        "explore",
        "compose",
        "arrange",
        "sound",
        "mix",
      ] as const;
      const assignment = {
        assignmentId: "assignment-legacy",
        producerId: "producer-legacy",
        enabled: true,
        deliveryMode: "next-prompt" as const,
        usageInstruction: "Use the captured material.",
        processingPolicyIds: ["latest-window"],
      };
      const plan = [
        {
          id: "section-legacy",
          name: "Verse",
          startBar: 1,
          endBar: 8,
          tracks: ["track-1"],
          status: "approved" as const,
        },
      ];
      const legacy = modeNames.map((mode) => ({
        id: `legacy-sdk-${mode}`,
        title: `${mode} session`,
        updatedAt: new Date().toISOString(),
        projectName: "Preserved Project",
        projectId: "preserved-project-id",
        mode,
        productionPlan: mode === "arrange" ? plan : [],
        outputAssignments: mode === "arrange" ? [assignment] : [],
      }));
      await writeFile(sessionsPath, JSON.stringify(legacy), "utf8");
      const catalog = desktopAgentCatalogSchema.parse({
        definitions: ["default", "compose", "arrange", "sound", "mix"].map(
          (name) => ({
            name,
            description: `${name} agent`,
            systemPrompt: `Act as ${name}.`,
            tools: ["*"],
            resolvedTools: ["ableton_session_inspect"],
            editScope: ["session"],
            skills: [],
            inputChannels: [],
            sourceFile: `${name}.yaml`,
            fingerprint: "a".repeat(64),
          }),
        ),
      });
      const build = () => {
        const fake = createFakeApplication();
        return {
          fake,
          service: new HeadlessDesktopService({
            application: fake.application,
            approvals: new ApprovalCoordinator(),
            preferencesStore: new JsonPreferencesStore(
              join(directory, "preferences.json"),
            ),
            sessionStore: new JsonSessionStore(sessionsPath),
            agentCatalog: {
              current: catalog,
              refresh: () => Promise.resolve(catalog),
            },
          }),
        };
      };

      const first = build();
      await first.service.start();
      const migrated = await new JsonSessionStore(sessionsPath).load();
      const expectedDefinitions = new Map([
        ["explore", "default"],
        ["compose", "compose"],
        ["arrange", "arrange"],
        ["sound", "sound"],
        ["mix", "mix"],
      ]);
      for (const mode of modeNames) {
        const session = migrated.find(
          ({ title }) => title === `${mode} session`,
        )!;
        expect(session.id).not.toBe(`legacy-sdk-${mode}`);
        expect(session.activeAgents[0]).toMatchObject({
          definitionName: expectedDefinitions.get(mode),
          sdkSessionId: `legacy-sdk-${mode}`,
        });
        expect(session.mode).toBe(mode);
      }
      const arranged = migrated.find(
        ({ title }) => title === "arrange session",
      )!;
      expect(arranged).toMatchObject({
        projectName: "Preserved Project",
        projectId: "preserved-project-id",
        productionPlan: plan,
        outputAssignments: [assignment],
      });
      expect(arranged.activeAgents[0]?.outputSubscriptions).toEqual([
        assignment,
      ]);
      const ids = new Map(migrated.map(({ title, id }) => [title, id]));
      await first.service.stop();

      const second = build();
      await second.service.start();
      expect(
        new Map(
          (await new JsonSessionStore(sessionsPath).load()).map(
            ({ title, id }) => [title, id],
          ),
        ),
      ).toEqual(ids);
      await second.service.stop();
    });

    it("preserves an unmigrated legacy record exactly when its canonical definition is missing", async () => {
      const directory = await temporaryDirectory();
      const sessionsPath = join(directory, "sessions.json");
      const legacy = [
        {
          id: "legacy-arrange-sdk",
          title: "Legacy Arrange",
          updatedAt: "2026-01-01T00:00:00.000Z",
          projectName: "Original Project",
          projectId: "original-project-id",
          mode: "arrange",
          productionPlan: [
            {
              id: "legacy-plan",
              name: "Original Plan",
              startBar: 1,
              endBar: 16,
              tracks: ["track-1"],
              status: "proposed",
            },
          ],
          outputAssignments: [],
        },
      ];
      const original = JSON.stringify(legacy);
      await writeFile(sessionsPath, original, "utf8");
      const catalog = defaultCatalog();
      const fake = createFakeApplication();
      const service = new HeadlessDesktopService({
        application: fake.application,
        approvals: new ApprovalCoordinator(),
        preferencesStore: new JsonPreferencesStore(
          join(directory, "preferences.json"),
        ),
        sessionStore: new JsonSessionStore(sessionsPath),
        agentCatalog: {
          current: catalog,
          refresh: () => Promise.resolve(catalog),
        },
      });
      const events: DesktopAppEvent[] = [];
      service.subscribe((event) => events.push(event));

      await service.start();

      expect(fake.agent.sessionId).toBe("legacy-arrange-sdk");
      expect(await readFile(sessionsPath, "utf8")).toBe(original);
      expect(
        events.some(
          (event) =>
            event.type === "diagnostic" &&
            event.level === "warning" &&
            event.message.includes("canonical agent definition 'arrange'") &&
            event.message.includes("preserved"),
        ),
      ).toBe(true);
      await service.send("Continue the legacy conversation", [], "arrange");
      await settle();
      expect(fake.agent.prompts[0]).toContain(
        "Continue the legacy conversation",
      );
      const [preservedAfterUse] = JSON.parse(
        await readFile(sessionsPath, "utf8"),
      ) as Array<Record<string, unknown>>;
      expect(preservedAfterUse).toMatchObject({
        id: "legacy-arrange-sdk",
        projectName: "Original Project",
        projectId: "original-project-id",
        mode: "arrange",
        productionPlan: legacy[0]!.productionPlan,
        outputAssignments: [],
      });
      expect(preservedAfterUse).not.toHaveProperty("version");
      await service.stop();
    });
  });

  it("round-trips multiple instances, selection, overrides, and subscriptions", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "sessions.json");
    const store = new JsonSessionStore(path);
    const firstId = "00000000-0000-4000-8000-000000000001";
    const secondId = "00000000-0000-4000-8000-000000000002";
    const baseAgent = {
      definitionName: "default",
      definitionFingerprint: "a".repeat(64),
      autoApprove: false,
      config: {
        description: "General-purpose Ableton agent.",
        systemPrompt: "Help with Ableton.",
        tools: ["*"],
        resolvedTools: ["ableton_session_inspect"],
        editScope: ["session" as const],
        skills: [],
        inputChannels: [],
      },
      lifecycle: "ready" as const,
      boundTracks: [],
      outputSubscriptions: [],
      eventListeners: [],
      modified: false,
    };
    const sessions = [
      {
        version: 3 as const,
        id: "00000000-0000-4000-8000-000000000010",
        title: "Production session",
        updatedAt: new Date().toISOString(),
        projectName: "Set",
        activeAgents: [
          {
            ...baseAgent,
            id: firstId,
            label: "Default A",
            sdkSessionId: "sdk-a",
          },
          {
            ...baseAgent,
            id: secondId,
            label: "Default B",
            sdkSessionId: "sdk-b",
            autoApprove: true,
            modified: true,
            config: {
              ...baseAgent.config,
              systemPrompt: "Focus on drums.",
            },
            boundTracks: [
              {
                selector: { track: { name: "Drums", occurrence: 0 } },
                projectId: "project-1",
                trackReference: "00000000-0000-4000-8000-000000000020",
                trackIndex: 0,
                expectedName: "Drums",
              },
            ],
            outputSubscriptions: [
              {
                assignmentId: "assignment-1",
                producerId: "producer-1",
                enabled: true,
                deliveryMode: "automatic-analysis" as const,
                usageInstruction: "Analyze the latest groove.",
                processingPolicyIds: ["latest-window"],
              },
            ],
          },
        ],
        selectedAgentInstanceId: secondId,
        mode: "explore" as const,
        productionPlan: [],
        outputAssignments: [],
        liveEvents: [],
      },
    ];

    await store.save(sessions);

    await expect(store.load()).resolves.toEqual(
      sessions.map((session) => ({
        ...session,
        activeAgents: session.activeAgents.map((agent) => ({
          ...agent,
          triggerHistory: [],
        })),
      })),
    );
    expect(await readdir(directory)).toEqual(["sessions.json"]);
  });

  it("migrates version-two sessions without changing inputs or Output subscriptions", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "sessions.json");
    const agentId = "00000000-0000-4000-8000-000000000001";
    const subscription = {
      assignmentId: "assignment-legacy",
      producerId: "producer-legacy",
      enabled: true,
      deliveryMode: "next-prompt",
      usageInstruction: "Use the legacy output.",
      processingPolicyIds: ["latest-window"],
    };
    await writeFile(
      path,
      JSON.stringify([
        {
          version: 2,
          id: "production-session",
          title: "Version two",
          updatedAt: new Date().toISOString(),
          projectName: "Set",
          activeAgents: [
            {
              id: agentId,
              definitionName: "default",
              definitionFingerprint: "a".repeat(64),
              label: "Default",
              lifecycle: "ready",
              config: {
                description: "General agent.",
                systemPrompt: "Help.",
                tools: ["*"],
                resolvedTools: [],
                editScope: ["session"],
                skills: [],
                inputChannels: ["producer-legacy"],
              },
              boundTracks: [],
              outputSubscriptions: [subscription],
              modified: false,
            },
          ],
          selectedAgentInstanceId: agentId,
          mode: "explore",
          productionPlan: [],
          outputAssignments: [subscription],
        },
      ]),
      "utf8",
    );

    const [migrated] = await new JsonSessionStore(path).load();

    expect(migrated).toMatchObject({
      version: 3,
      liveEvents: [],
      outputAssignments: [subscription],
      activeAgents: [
        {
          config: { inputChannels: ["producer-legacy"] },
          outputSubscriptions: [subscription],
          eventListeners: [],
          triggerHistory: [],
        },
      ],
    });
  });

  it("rejects invalid and corrupt session data without overwriting it", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "sessions.json");
    const store = new JsonSessionStore(path);
    const invalid = JSON.stringify([
      {
        version: 2,
        id: "production-session",
        title: "Invalid",
        updatedAt: new Date().toISOString(),
        projectName: "Set",
        activeAgents: [],
        selectedAgentInstanceId: "00000000-0000-4000-8000-000000000001",
      },
    ]);
    await writeFile(path, invalid, "utf8");
    await expect(store.load()).rejects.toThrow("Sessions could not be loaded");
    expect(await readFile(path, "utf8")).toBe(invalid);
    await writeFile(path, "{not-json", "utf8");
    await expect(store.load()).rejects.toThrow("Sessions could not be loaded");
    expect(await readFile(path, "utf8")).toBe("{not-json");
  });

  it("saves preferences atomically without leaving temporary files", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "preferences.json");
    const store = new JsonPreferencesStore(path);
    const preferences = preferencesSchema.parse({ loggingLevel: "debug" });

    await store.save(preferences);

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(preferences);
    expect(await readdir(directory)).toEqual(["preferences.json"]);
  });

  it("loads obsolete model and reasoning preferences and removes them on save", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "preferences.json");
    const store = new JsonPreferencesStore(path);
    await writeFile(
      path,
      JSON.stringify({ version: 1, model: "gpt-5.6", reasoning: "high" }),
      "utf8",
    );

    const preferences = await store.load();

    expect(preferences).toEqual(preferencesSchema.parse({}));
    expect(preferences).not.toHaveProperty("model");
    expect(preferences).not.toHaveProperty("reasoning");
    await store.save(preferences);
    const saved: unknown = JSON.parse(await readFile(path, "utf8"));
    expect(saved).not.toHaveProperty("model");
    expect(saved).not.toHaveProperty("reasoning");
  });
});

describe("desktop adapter over the shared application", () => {
  it("uses root pagination for history and preserves trace page metadata", async () => {
    const traceId = "00000000-0000-4000-8000-000000000100";
    const roots = {
      version: 1 as const,
      items: [
        {
          rootTraceId: traceId,
          eventCount: 2,
          firstSequence: 1,
          lastSequence: 2,
          firstOccurredAt: "2026-01-01T00:00:00.000Z",
          lastOccurredAt: "2026-01-01T00:00:01.000Z",
          firstEventName: "agent.turn",
          lastEventName: "agent.completed",
          hasErrors: false,
        },
      ],
      page: {
        limit: 10,
        returnedItems: 1,
        totalItems: 1,
        hasMore: false,
        order: "desc" as const,
      },
    };
    const trace = {
      version: 1 as const,
      items: [],
      page: {
        limit: 10,
        returnedItems: 0,
        totalItems: 2,
        hasMore: true,
        order: "asc" as const,
      },
      nextCursor: "next",
      trace: {
        rootTraceId: traceId,
        totalEvents: 2,
        firstSequence: 1,
        lastSequence: 2,
      },
    };
    const readRootTraces = vi.fn().mockResolvedValue(roots);
    const readTrace = vi.fn().mockResolvedValue(trace);
    const { service } = await harness(
      {},
      {
        eventJournal: {
          readRootTraces,
          readTrace,
        } as unknown as DesktopEventJournal,
      },
    );

    await expect(
      service.searchEventHistory({ limit: 10, order: "desc" }),
    ).resolves.toEqual(roots);
    await expect(
      service.getEventTrace(traceId, { limit: 10, order: "asc" }),
    ).resolves.toEqual(trace);
    expect(readRootTraces).toHaveBeenCalledWith({
      limit: 10,
      order: "desc",
    });
    expect(readTrace).toHaveBeenCalledWith(traceId, {
      limit: 10,
      order: "asc",
    });
  });

  it("keeps queries and shutdown bound to a recovered journal after retention fails", async () => {
    const roots = {
      version: 1 as const,
      items: [],
      page: {
        limit: 10,
        returnedItems: 0,
        totalItems: 0,
        hasMore: false,
        order: "desc" as const,
      },
    };
    const journal = (readRoots = vi.fn().mockResolvedValue(roots)) => ({
      enqueue: vi.fn().mockResolvedValue(undefined),
      enqueueConfigurationSnapshot: vi.fn().mockResolvedValue(undefined),
      readRootTraces: readRoots,
      readTrace: vi.fn(),
      readConfigurationSnapshots: vi.fn(),
      getHealth: vi.fn().mockResolvedValue({
        retention: {
          maxAgeDays: 30,
          maxBytes: 250 * 1024 * 1024,
        },
      }),
      runRetention: vi.fn(),
      deleteTrace: vi.fn(),
      clear: vi.fn(),
      shutdown: vi.fn().mockResolvedValue(undefined),
    });
    const first = journal();
    const recovered = journal();
    const open = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockRejectedValueOnce(new Error("replacement denied"))
      .mockResolvedValueOnce(recovered);
    const host = await DesktopJournalHost.create({
      path: "journal.sqlite",
      retention: { maxAgeDays: 30, maxBytes: 250 * 1024 * 1024 },
      enabled: true,
      open: open as never,
    });
    const { service } = await harness(
      {},
      {
        eventJournal: host,
        reconfigureEventJournal: (policy) => host.reconfigure(policy),
      },
    );
    await service.start();
    const preferences = await service.getPreferences();

    await expect(
      service.setPreferences({
        ...preferences,
        eventHistoryRetentionDays: 7,
      }),
    ).rejects.toThrow("replacement denied");
    await expect(service.getPreferences()).resolves.toEqual(preferences);
    await expect(service.getDiagnostics()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Event journal", status: "warn" }),
      ]),
    );
    await expect(
      service.searchEventHistory({ limit: 10, order: "desc" }),
    ).resolves.toEqual(roots);
    expect(recovered.readRootTraces).toHaveBeenCalledOnce();

    await service.stop();
    expect(first.shutdown).toHaveBeenCalledOnce();
    expect(recovered.shutdown).toHaveBeenCalledOnce();
  });

  it("does not reconfigure or prune history when preference persistence fails", async () => {
    const roots = {
      version: 1 as const,
      items: [],
      page: {
        limit: 10,
        returnedItems: 0,
        totalItems: 0,
        hasMore: false,
        order: "desc" as const,
      },
    };
    const readRootTraces = vi.fn().mockResolvedValue(roots);
    const eventJournal = {
      enqueue: vi.fn(),
      enqueueConfigurationSnapshot: vi.fn(),
      readRootTraces,
      readTrace: vi.fn(),
      readConfigurationSnapshots: vi.fn(),
      getHealth: vi.fn(),
      runRetention: vi.fn(),
      deleteTrace: vi.fn(),
      clear: vi.fn(),
      shutdown: vi.fn(),
    } as unknown as DesktopEventJournal;
    const reconfigureEventJournal = vi.fn().mockResolvedValue(undefined);
    const { service, preferencesStore } = await harness(
      {},
      { eventJournal, reconfigureEventJournal },
    );
    await service.start();
    const preferences = await service.getPreferences();
    vi.spyOn(preferencesStore, "save").mockRejectedValueOnce(
      new Error("disk full"),
    );

    await expect(
      service.setPreferences({
        ...preferences,
        eventHistoryRetentionDays: 7,
      }),
    ).rejects.toThrow("disk full");
    expect(reconfigureEventJournal).not.toHaveBeenCalled();
    await expect(
      service.searchEventHistory({ limit: 10, order: "desc" }),
    ).resolves.toEqual(roots);
    expect(readRootTraces).toHaveBeenCalledOnce();
    await service.stop();
  });

  it("resolves track edit selectors into authoritative bindings before activation and reconfiguration", async () => {
    const catalog = defaultCatalog();
    catalog.definitions.push({
      name: "bass-editor",
      description: "Edits only the bass track.",
      systemPrompt: "Edit the bound bass track.",
      tools: ["ableton_tracks_rename", "ableton_session_inspect"],
      resolvedTools: ["ableton_tracks_rename", "ableton_session_inspect"],
      editScope: [{ track: { name: "Bass", occurrence: 0 } }],
      skills: [],
      inputChannels: [],
      sourceFile: "bass-editor.yaml",
      fingerprint: "b".repeat(64),
    });
    const { service, agent, ableton, sessionStore } = await harness(
      {},
      {
        agentCatalog: {
          current: catalog,
          refresh: () => Promise.resolve(catalog),
        },
      },
    );
    await service.start();

    const created = await service.createActiveAgent("bass-editor");
    expect(created.boundTracks).toEqual([
      {
        selector: { track: { name: "Bass", occurrence: 0 } },
        projectId: "project-fake",
        trackReference: ableton.state.snapshot.tracks[0]?.reference,
        trackIndex: 0,
        expectedName: "Bass",
      },
    ]);
    expect(agent.managedConfigurations.get(created.id)).toMatchObject({
      editScope: [{ track: { name: "Bass", occurrence: 0 } }],
      boundTracks: created.boundTracks,
    });
    expect((await sessionStore.load())[0]?.activeAgents).toContainEqual(
      expect.objectContaining({
        id: created.id,
        boundTracks: created.boundTracks,
      }),
    );

    await expect(
      service.configureActiveAgent(created.id, {
        editScope: [{ track: { name: "Bass", occurrence: 1 } }],
      }),
    ).rejects.toMatchObject({ code: "binding_missing" });
    expect(agent.managedConfigurations.get(created.id)?.boundTracks).toEqual(
      created.boundTracks,
    );
    await service.stop();
  });

  it("manages duplicate definition instances with independent history, selection, and reset snapshots", async () => {
    const initial = defaultCatalog();
    initial.definitions[0]!.skills = ["analyze"];
    initial.skills = [
      {
        name: "analyze",
        description: "Analyze material.",
        sourceFile: "skills/analyze/SKILL.md",
        fingerprint: "c".repeat(64),
      },
    ];
    const refreshed = desktopAgentCatalogSchema.parse({
      ...initial,
      definitions: initial.definitions.map((definition) => ({
        ...definition,
        systemPrompt: "Use the refreshed definition.",
        fingerprint: "b".repeat(64),
      })),
    });
    const agentCatalog = {
      current: initial,
      refreshCount: 0,
      async refresh() {
        this.refreshCount += 1;
        if (this.refreshCount === 1) return initial;
        this.current = refreshed;
        return refreshed;
      },
    };
    const { service, agent, sessionStore } = await harness(
      {},
      { agentCatalog },
    );
    await service.start();

    const first = await service.createActiveAgent("default");
    const second = await service.createActiveAgent("default");
    expect(first.id).not.toBe(second.id);
    expect(
      (await service.listActiveAgents()).filter(
        ({ definitionName }) => definitionName === "default",
      ),
    ).toHaveLength(3);

    await service.sendToActiveAgent(first.id, "first history");
    await settle();
    await service.sendToActiveAgent(second.id, "second history");
    await settle();
    await service.invokeActiveAgentSkill(second.id, "analyze", "the drums");
    await settle();
    expect(agent.managedPrompts.get(second.id)).toContain("/analyze the drums");
    await expect(
      service.invokeActiveAgentSkill(second.id, "missing", ""),
    ).rejects.toThrow("Unknown skill");
    expect(await service.hydrateActiveAgentHistory(first.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "user", content: "first history" }),
      ]),
    );
    expect(await service.hydrateActiveAgentHistory(second.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "user", content: "second history" }),
      ]),
    );

    await service.renameActiveAgent(second.id, "Drum specialist");
    const configured = await service.configureActiveAgent(second.id, {
      systemPrompt: "Focus only on drums.",
    });
    expect(configured.modified).toBe(true);
    await service.selectActiveAgent(second.id);
    expect((await sessionStore.load())[0]?.selectedAgentInstanceId).toBe(
      second.id,
    );

    await service.refreshAgentCatalog();
    expect(
      (await service.listActiveAgents()).find(({ id }) => id === first.id)
        ?.definitionFingerprint,
    ).toBe("a".repeat(64));
    const reset = await service.resetActiveAgent(second.id);
    expect(reset).toMatchObject({
      id: second.id,
      label: "Drum specialist",
      definitionFingerprint: "b".repeat(64),
      modified: false,
      config: { systemPrompt: "Use the refreshed definition." },
    });
    expect(agent.managedConfigurations.get(second.id)?.systemPrompt).toBe(
      "Use the refreshed definition.",
    );
    await expect(service.createActiveAgent("missing")).rejects.toThrow(
      "Agent definition 'missing' not found",
    );
    await expect(
      service.selectActiveAgent("00000000-0000-4000-8000-000000000099"),
    ).rejects.toThrow("not found");
    await service.stop();
  });

  it("changes one agent model and reasoning with a fresh session while preserving instance state", async () => {
    const liveEvents = new FakeLiveEventRuntime();
    const { service, agent, approvals, sharedEvents, sessionStore, events } =
      await harness({}, { liveEvents });
    agent.models = [agentModel("model-a"), agentModel("model-b")];
    await service.start();
    const original = (await service.listActiveAgents())[0]!;
    const createManagedAgent = vi.spyOn(agent, "createManagedAgent");
    await service.assignOutput(original.id, "producer-1");
    const event = await service.createLiveEvent({
      kind: "track.playing_clip_changed",
      classification: "discrete",
      name: "Keys clip",
      enabled: true,
      target: { track: { name: "Keys", occurrence: 0 } },
    });
    await service.assignLiveEventListener(original.id, event.id, {
      enabled: true,
      responseMode: "automatic",
      messagePrefix: "Check it.",
    });
    await service.setAutoApproval(original.id, true);
    sharedEvents.publish({
      type: "agent.live_event_trigger_changed",
      trigger: {
        deliveryId: "model-trigger",
        occurrenceId: "00000000-0000-4000-8000-000000000101",
        eventId: "live-event.00000000-0000-4000-8000-000000000001",
        listenerId: "event-listener.00000000-0000-4000-8000-000000000001",
        agentInstanceId: original.id,
        sdkSessionId: original.sdkSessionId!,
        kind: "track.triggered_clip_changed",
        sourceTrack: "Lead drum",
        state: {
          kind: "track.triggered_clip_changed",
          state: { state: "session-clip", slotIndex: 1 },
        },
        observedAt: "2026-08-30T20:00:00.000Z",
        occurrence: "{}",
        summary: "Queued pattern2 in scene 2",
        status: "completed",
        updatedAt: "2026-08-30T20:00:01.000Z",
      },
    });
    await settle();
    await settle();
    const pendingApproval = approvals.request({
      metadata: {
        name: "ableton_tracks_create",
        title: "Create track",
        risk: "reversible",
        duration: "short",
        mutationTarget: "session",
      },
      arguments: {},
      agentInstanceId: original.id,
      sdkSessionId: original.sdkSessionId!,
    });
    const before = (await service.listActiveAgents())[0]!;
    const eventStart = events.length;

    const changed = await service.setActiveAgentConversationSettings(
      original.id,
      { model: "model-a", reasoningEffort: "high" },
    );

    expect(changed).toMatchObject({
      id: original.id,
      label: original.label,
      model: "model-a",
      reasoningEffort: "high",
      config: original.config,
      boundTracks: original.boundTracks,
      eventListeners: before.eventListeners,
      outputSubscriptions: before.outputSubscriptions,
      autoApprove: true,
      triggerHistory: [],
      forkedHistory: [],
    });
    expect(changed.eventListeners).toEqual(before.eventListeners);
    expect(changed.sdkSessionId).not.toBe(original.sdkSessionId);
    expect(createManagedAgent).toHaveBeenCalledOnce();
    expect(agent.managedConfigurations.get(original.id)?.model).toBe("model-a");
    expect(agent.managedConfigurations.get(original.id)?.reasoningEffort).toBe(
      "high",
    );
    expect((await service.getSessions())[0]?.selectedAgentInstanceId).toBe(
      original.id,
    );
    await expect(pendingApproval).resolves.toBe(false);
    expect(approvals.pendingCount).toBe(0);
    expect(events.slice(eventStart)).toContainEqual({
      type: "agent.instance_changed",
      instance: changed,
      change: "conversation-settings-changed",
    });
    expect((await sessionStore.load())[0]?.activeAgents[0]).toMatchObject({
      id: original.id,
      model: "model-a",
      reasoningEffort: "high",
      triggerHistory: [],
    });

    const reset = await service.resetActiveAgent(original.id);
    expect(reset.model).toBe("model-a");
    expect(reset.reasoningEffort).toBe("high");
    expect(agent.managedConfigurations.get(original.id)?.model).toBe("model-a");
    expect(agent.managedConfigurations.get(original.id)?.reasoningEffort).toBe(
      "high",
    );
    await service.stop();
  });

  it("replaces the conversation once when only reasoning changes", async () => {
    const { service, agent } = await harness();
    agent.models = [agentModel("model-a")];
    await service.start();
    const original = (await service.listActiveAgents())[0]!;
    const configured = await service.setActiveAgentConversationSettings(
      original.id,
      { model: "model-a", reasoningEffort: "low" },
    );
    const createManagedAgent = vi.spyOn(agent, "createManagedAgent");

    const changed = await service.setActiveAgentConversationSettings(
      original.id,
      { model: "model-a", reasoningEffort: "high" },
    );

    expect(createManagedAgent).toHaveBeenCalledOnce();
    expect(changed.model).toBe("model-a");
    expect(changed.reasoningEffort).toBe("high");
    expect(changed.sdkSessionId).not.toBe(configured.sdkSessionId);
    await service.stop();
  });

  it("rejects session switching while conversation settings are changing", async () => {
    const { service, agent } = await harness();
    agent.models = [agentModel("model-a")];
    await service.start();
    const session = (await service.getSessions())[0]!;
    const original = session.activeAgents[0]!;
    const models = deferred<readonly DesktopAgentModel[]>();
    vi.spyOn(agent, "listModels").mockReturnValueOnce(models.promise);

    const changing = service.setActiveAgentConversationSettings(original.id, {
      model: "model-a",
    });
    await settle();

    await expect(service.resumeSession(session.id)).rejects.toThrow(
      "conversation settings are changing",
    );

    models.resolve([agentModel("model-a")]);
    await expect(changing).resolves.toMatchObject({ model: "model-a" });
    await service.stop();
  });

  it("restores persisted per-agent conversation settings after a desktop restart", async () => {
    const directory = await temporaryDirectory();
    const preferencesStore = new JsonPreferencesStore(
      join(directory, "preferences.json"),
    );
    const sessionStore = new JsonSessionStore(join(directory, "sessions.json"));
    const projectSessionStore = new JsonProjectSessionStore(
      join(directory, "project-sessions.json"),
    );
    const catalog = defaultCatalog();
    const first = createFakeApplication();
    first.agent.models = [agentModel("model-a")];
    const firstService = new HeadlessDesktopService({
      application: first.application,
      approvals: new ApprovalCoordinator(),
      preferencesStore,
      sessionStore,
      projectSessionStore,
      agentCatalog: {
        current: catalog,
        refresh: () => Promise.resolve(catalog),
      },
    });
    await firstService.start();
    const original = (await firstService.listActiveAgents())[0]!;
    const changed = await firstService.setActiveAgentConversationSettings(
      original.id,
      { model: "model-a", reasoningEffort: "high" },
    );
    await firstService.stop();

    const second = createFakeApplication();
    const secondService = new HeadlessDesktopService({
      application: second.application,
      approvals: new ApprovalCoordinator(),
      preferencesStore,
      sessionStore,
      projectSessionStore,
      agentCatalog: {
        current: catalog,
        refresh: () => Promise.resolve(catalog),
      },
    });
    await secondService.start();

    expect(await secondService.listActiveAgents()).toEqual([
      expect.objectContaining({
        id: original.id,
        model: "model-a",
        reasoningEffort: "high",
        sdkSessionId: changed.sdkSessionId,
      }),
    ]);
    expect(second.agent.managedConfigurations.get(original.id)?.model).toBe(
      "model-a",
    );
    expect(
      second.agent.managedConfigurations.get(original.id)?.reasoningEffort,
    ).toBe("high");
    await secondService.stop();
  });

  it("rejects invalid or busy conversation settings and rolls back failed replacements", async () => {
    const { service, agent, sessionStore, events } = await harness();
    agent.models = [
      agentModel("disabled", { policyState: "disabled" }),
      agentModel("low-only", {
        supportedReasoningEfforts: ["low"],
        defaultReasoningEffort: "low",
      }),
      agentModel("fixed", {
        capabilities: {
          vision: false,
          reasoningEffort: false,
        },
        supportedReasoningEfforts: [],
        defaultReasoningEffort: undefined,
      }),
      agentModel("valid"),
    ];
    await service.start();
    const original = (await service.listActiveAgents())[0]!;
    const create = vi.spyOn(agent, "createManagedAgent");

    await expect(
      service.setActiveAgentConversationSettings(original.id, {}),
    ).resolves.toBe(original);
    expect(create).not.toHaveBeenCalled();
    await expect(
      service.setActiveAgentConversationSettings(original.id, {
        model: "missing",
      }),
    ).rejects.toThrow("unavailable");
    await expect(
      service.setActiveAgentConversationSettings(original.id, {
        model: "disabled",
      }),
    ).rejects.toThrow("disabled by policy");
    await expect(
      service.setActiveAgentConversationSettings(original.id, {
        model: "low-only",
        reasoningEffort: "high",
      }),
    ).rejects.toThrow("does not support");
    await expect(
      service.setActiveAgentConversationSettings(original.id, {
        reasoningEffort: "low",
      }),
    ).rejects.toThrow("SDK default");
    await expect(
      service.setActiveAgentConversationSettings(original.id, {
        model: "fixed",
        reasoningEffort: "high",
      }),
    ).rejects.toThrow("does not support");
    await expect(
      service.setActiveAgentConversationSettings(original.id, {
        model: "valid",
        reasoningEffort: "max",
      }),
    ).rejects.toThrow("does not support");

    agent.setBehavior({ block: true });
    await service.sendToActiveAgent(original.id, "hold");
    await settle();
    await expect(
      service.setActiveAgentConversationSettings(original.id, {
        model: "valid",
      }),
    ).rejects.toThrow("turn in progress");
    agent.release();
    await settle();
    agent.setBehavior({});

    create.mockRejectedValueOnce(new Error("creation failed"));
    await expect(
      service.setActiveAgentConversationSettings(original.id, {
        model: "valid",
      }),
    ).rejects.toThrow("creation failed");
    expect(agent.getManagedAgentSessionId(original.id)).toBe(
      original.sdkSessionId,
    );

    const eventStart = events.length;
    const save = vi
      .spyOn(sessionStore, "save")
      .mockRejectedValueOnce(new Error("persistence failed"));
    const resume = vi.spyOn(agent, "resumeManagedAgent");
    await expect(
      service.setActiveAgentConversationSettings(original.id, {
        model: "valid",
        reasoningEffort: "high",
      }),
    ).rejects.toThrow("persistence failed");
    expect(resume).toHaveBeenCalledWith(
      expect.objectContaining({ instanceId: original.id }),
      original.sdkSessionId,
    );
    expect(resume.mock.calls[0]?.[0]).not.toHaveProperty("model");
    expect(resume.mock.calls[0]?.[0]).not.toHaveProperty("reasoningEffort");
    expect(agent.getManagedAgentSessionId(original.id)).toBe(
      original.sdkSessionId,
    );
    expect((await service.listActiveAgents())[0]).not.toHaveProperty("model");
    expect(
      events
        .slice(eventStart)
        .some(
          (event) =>
            event.type === "agent.instance_changed" &&
            event.change === "conversation-settings-changed",
        ),
    ).toBe(false);

    const cleanupEventStart = events.length;
    save.mockRejectedValueOnce(new Error("persistence failed again"));
    resume.mockRejectedValueOnce(new Error("cleanup failed"));
    await expect(
      service.setActiveAgentConversationSettings(original.id, {
        model: "valid",
      }),
    ).rejects.toThrow("rollback was incomplete");
    expect(
      events
        .slice(cleanupEventStart)
        .some(
          (event) =>
            event.type === "agent.instance_changed" &&
            event.change === "conversation-settings-changed",
        ),
    ).toBe(false);
    await service.stop();
  });

  it("persists per-instance auto approval, preserves reset state, and publishes effective IDs", async () => {
    const published: string[][] = [];
    const { service, sessionStore, preferencesStore, events } = await harness(
      {},
      {
        onAutoApprovedAgentIdsChange: (ids) => published.push([...ids].sort()),
      },
    );
    await service.start();
    const [first] = await service.listActiveAgents();
    expect(first?.autoApprove).toBe(false);
    expect(published.at(-1)).toEqual([]);

    const second = await service.createActiveAgent("default");
    expect(second.autoApprove).toBe(false);
    expect(published.at(-1)).toEqual([]);

    const enabled = await service.setAutoApproval(first!.id, true);
    expect(enabled.instances).toEqual([
      expect.objectContaining({ id: first!.id, autoApprove: true }),
    ]);
    expect(enabled.session.activeAgents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: first!.id, autoApprove: true }),
        expect.objectContaining({ id: second.id, autoApprove: false }),
      ]),
    );
    expect(published.at(-1)).toEqual([first!.id]);

    await service.configureActiveAgent(first!.id, {
      systemPrompt: "Temporary prompt",
    });
    expect((await service.resetActiveAgent(first!.id)).autoApprove).toBe(true);

    await service.setAutoApproval("all", true);
    expect(published.at(-1)).toEqual([first!.id, second.id].sort());
    const originalSessionId = enabled.session.id;
    const otherSessionId = await service.createSession();
    expect(published.at(-1)).toEqual([]);
    await service.setAutoApproval("all", false);
    expect(
      (await service.getSessions()).find(({ id }) => id === originalSessionId)
        ?.activeAgents,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: first!.id, autoApprove: true }),
        expect.objectContaining({ id: second.id, autoApprove: true }),
      ]),
    );

    await service.resumeSession(originalSessionId);
    expect(published.at(-1)).toEqual([first!.id, second.id].sort());
    await service.deactivateActiveAgent(second.id);
    expect(published.at(-1)).toEqual([first!.id]);
    expect(
      (await sessionStore.load()).find(({ id }) => id === originalSessionId)
        ?.activeAgents,
    ).toEqual([expect.objectContaining({ id: first!.id, autoApprove: true })]);
    expect(
      events.some(
        (event) =>
          event.type === "agent.instance_changed" &&
          event.instance.id === first!.id &&
          event.instance.autoApprove === true,
      ),
    ).toBe(true);
    expect(otherSessionId).not.toBe(originalSessionId);
    await service.stop();
    expect(published.at(-1)).toEqual([]);

    const restartedPublished: string[][] = [];
    const restartedFake = createFakeApplication();
    const catalog = defaultCatalog();
    const restarted = new HeadlessDesktopService({
      application: restartedFake.application,
      approvals: new ApprovalCoordinator(),
      preferencesStore,
      sessionStore,
      agentCatalog: {
        current: catalog,
        refresh: () => Promise.resolve(catalog),
      },
      onAutoApprovedAgentIdsChange: (ids) =>
        restartedPublished.push([...ids].sort()),
    });
    await restarted.start();
    expect(restartedPublished.at(-1)).toEqual([first!.id]);
    expect((await restarted.listActiveAgents())[0]?.autoApprove).toBe(true);
    await restarted.stop();
  });

  it.each([
    { initial: false, requested: true },
    { initial: true, requested: false },
  ])(
    "rolls back every auto-approval effect when an all-agent $requested save fails",
    async ({ initial, requested }) => {
      const policyReference: { current?: ApprovalPolicyController } = {};
      const published: string[][] = [];
      const { service, approvals, sessionStore, preferencesStore, events } =
        await harness(
          {},
          {
            onAutoApprovedAgentIdsChange: (ids) => {
              published.push([...ids].sort());
              policyReference.current?.setAutoApprovedAgentInstanceIds(ids);
            },
          },
        );
      const policy = new ApprovalPolicyController("risky", approvals);
      policyReference.current = policy;
      await service.start();
      const first = (await service.listActiveAgents())[0]!;
      const second = await service.createActiveAgent("default");
      if (initial) await service.setAutoApproval("all", true);
      const expectedIds = initial ? [first.id, second.id].sort() : [];
      const pending = initial
        ? undefined
        : policy.request({
            metadata: abletonToolMetadata.find(
              ({ risk }) => risk === "reversible",
            )!,
            arguments: {},
            agentInstanceId: first.id,
          });
      expect(approvals.pendingCount).toBe(initial ? 0 : 1);
      events.length = 0;
      vi.spyOn(sessionStore, "save").mockRejectedValueOnce(
        new Error("strict save exploded"),
      );

      await expect(service.setAutoApproval("all", requested)).rejects.toThrow(
        "strict save exploded",
      );

      expect(
        (await service.listActiveAgents()).map(
          ({ autoApprove }) => autoApprove,
        ),
      ).toEqual([initial, initial]);
      expect(
        (await sessionStore.load())[0]?.activeAgents.map(
          ({ autoApprove }) => autoApprove,
        ),
      ).toEqual([initial, initial]);
      expect(published.at(-1)).toEqual(expectedIds);
      expect(
        events.some(
          ({ type }) =>
            type === "agent.instance_changed" || type === "sessions.changed",
        ),
      ).toBe(false);

      if (pending !== undefined) {
        expect(approvals.pendingCount).toBe(1);
        approvals.resolveAll(false);
        await expect(pending).resolves.toBe(false);
      } else {
        await expect(
          policy.request({
            metadata: abletonToolMetadata.find(
              ({ risk }) => risk === "reversible",
            )!,
            arguments: {},
            agentInstanceId: first.id,
          }),
        ).resolves.toBe(true);
      }

      await service.stop();
      const restartedFake = createFakeApplication();
      const catalog = defaultCatalog();
      const restarted = new HeadlessDesktopService({
        application: restartedFake.application,
        approvals: new ApprovalCoordinator(),
        preferencesStore,
        sessionStore,
        agentCatalog: {
          current: catalog,
          refresh: () => Promise.resolve(catalog),
        },
      });
      await restarted.start();
      expect(
        (await restarted.listActiveAgents()).map(
          ({ autoApprove }) => autoApprove,
        ),
      ).toEqual([initial, initial]);
      await restarted.stop();
    },
  );

  it("orders YOLO enable before a deferred plan update", async () => {
    await expectDeferredSessionMutationOrder({
      initialAutoApprove: false,
      requestedAutoApprove: true,
      mutate: ({ service }) =>
        service.updatePlan([
          {
            id: "ordered-plan",
            name: "Ordered plan",
            startBar: 1,
            endBar: 8,
            tracks: [],
            status: "proposed",
          },
        ]),
      isMutationApplied: (session) =>
        session.productionPlan[0]?.id === "ordered-plan",
    });
  });

  it("orders YOLO disable before a deferred output update", async () => {
    await expectDeferredSessionMutationOrder({
      initialAutoApprove: true,
      requestedAutoApprove: false,
      mutate: ({ service, first }) =>
        service.assignOutput(first.id, "producer-1").then(() => undefined),
      isMutationApplied: (session) =>
        session.activeAgents[0]?.outputSubscriptions.some(
          ({ producerId }) => producerId === "producer-1",
        ) === true,
    });
  });

  it("orders YOLO enable before a deferred agent selection", async () => {
    let selectedId: string | undefined;
    await expectDeferredSessionMutationOrder({
      initialAutoApprove: false,
      requestedAutoApprove: true,
      mutate: async ({ service, first }) => {
        selectedId = first.id;
        await service.selectActiveAgent(first.id);
      },
      isMutationApplied: (session) =>
        selectedId !== undefined &&
        session.selectedAgentInstanceId === selectedId,
    });
  });

  it("orders YOLO disable before a deferred background project update", async () => {
    await expectDeferredSessionMutationOrder({
      initialAutoApprove: true,
      requestedAutoApprove: false,
      mutate: async ({ service, ableton }) => {
        if (ableton.state.status.state !== "connected") {
          throw new Error("Expected the fake Ableton service to be connected");
        }
        ableton.state.projectIdentity = {
          projectId: ableton.state.status.projectId,
          projectName: "Ordered Project",
          saved: true,
        };
        await service.getSnapshot();
      },
      isMutationApplied: (session) => session.projectName === "Ordered Project",
    });
  });

  it("revalidates auto approval after a queued update races a session switch", async () => {
    const { service, agent, sessionStore } = await harness();
    await service.start();
    const source = (await service.getSessions())[0]!;
    const sourceAgent = source.activeAgents[0]!;
    const targetSessionId = await service.createSession();
    await service.resumeSession(source.id);
    const originalReconfigure = agent.reconfigureManagedAgent.bind(agent);
    const entered = deferred<void>();
    const release = deferred<void>();
    agent.reconfigureManagedAgent = async (configuration) => {
      await originalReconfigure(configuration);
      if (configuration.instanceId === sourceAgent.id) {
        entered.resolve();
        await release.promise;
      }
    };

    const configure = service.configureActiveAgent(sourceAgent.id, {
      systemPrompt: "Slow prompt",
    });
    await entered.promise;
    const update = service.setAutoApproval(sourceAgent.id, true);
    await service.resumeSession(targetSessionId);
    release.resolve();

    await expect(configure).rejects.toThrow(
      "Active production session changed",
    );
    await expect(update).rejects.toThrow("Active production session changed");
    expect(
      (await sessionStore.load()).find(({ id }) => id === source.id)
        ?.activeAgents[0]?.autoApprove,
    ).toBe(false);
    await service.stop();
  });

  it("drains an auto-approval save on shutdown and rejects later updates", async () => {
    const { service, sessionStore } = await harness();
    await service.start();
    const [active] = await service.listActiveAgents();
    const entered = deferred<void>();
    const release = deferred<void>();
    const originalSave = sessionStore.save.bind(sessionStore);
    vi.spyOn(sessionStore, "save").mockImplementation(async (sessions) => {
      if (sessions[0]?.activeAgents[0]?.autoApprove === true) {
        entered.resolve();
        await release.promise;
      }
      await originalSave(sessions);
    });

    const update = service.setAutoApproval(active!.id, true);
    await entered.promise;
    let stopped = false;
    const stop = service.stop().then(() => {
      stopped = true;
    });
    await expect(service.setAutoApproval(active!.id, false)).rejects.toThrow(
      "Desktop service is not accepting actions",
    );
    await settle();
    expect(stopped).toBe(false);

    release.resolve();
    await Promise.all([update, stop]);
    expect(stopped).toBe(true);
    expect((await sessionStore.load())[0]?.activeAgents[0]?.autoApprove).toBe(
      true,
    );
  });

  it("passes trusted runtime skill descriptors to skill-enabled managed agents", async () => {
    const catalog = defaultCatalog();
    catalog.definitions[0]!.skills = ["analyze"];
    catalog.skills = [
      {
        name: "analyze",
        description: "Analyze material.",
        sourceFile: "analyze/SKILL.md",
        fingerprint: "c".repeat(64),
      },
    ];
    const { service, agent } = await harness(
      {},
      {
        agentCatalog: {
          current: catalog,
          runtimeSkills: [
            {
              name: "analyze",
              description: "Analyze material.",
              sourcePath: "/canonical/desktop/skills/analyze/SKILL.md",
              fingerprint: "c".repeat(64),
            },
          ],
          refresh: () => Promise.resolve(catalog),
        },
      },
    );

    await service.start();

    const [active] = await service.listActiveAgents();
    expect(agent.managedConfigurations.get(active!.id)).toMatchObject({
      skills: ["analyze"],
      availableSkills: [
        {
          name: "analyze",
          description: "Analyze material.",
          sourcePath: "/canonical/desktop/skills/analyze/SKILL.md",
          fingerprint: "c".repeat(64),
        },
      ],
    });
    await service.stop();
  });

  it("prepares concurrent active-agent creation independently without losing instances", async () => {
    const { service, agent, sessionStore } = await harness();
    await service.start();
    const originalCreate = agent.createManagedAgent.bind(agent);
    const firstEntered = deferred<void>();
    const releaseFirst = deferred<void>();
    let calls = 0;
    agent.createManagedAgent = async (configuration) => {
      calls += 1;
      if (calls === 1) {
        firstEntered.resolve();
        await releaseFirst.promise;
      }
      return originalCreate(configuration);
    };

    const firstCreation = service.createActiveAgent("default");
    await firstEntered.promise;
    const secondCreation = service.createActiveAgent("default");
    await expect(secondCreation).resolves.toBeDefined();
    expect(calls).toBe(2);
    releaseFirst.resolve();
    const first = await firstCreation;

    expect((await service.listActiveAgents()).map(({ id }) => id)).toEqual(
      expect.arrayContaining([first.id]),
    );
    expect((await sessionStore.load())[0]?.activeAgents).toHaveLength(3);
    expect(agent.managedConfigurations.size).toBe(3);
    await service.stop();
  });

  it("serializes configure and reset for the same active agent", async () => {
    const { service, agent, sessionStore } = await harness();
    await service.start();
    const [active] = await service.listActiveAgents();
    const originalReconfigure = agent.reconfigureManagedAgent.bind(agent);
    const firstEntered = deferred<void>();
    const releaseFirst = deferred<void>();
    const configurations: string[] = [];
    agent.reconfigureManagedAgent = async (configuration) => {
      configurations.push(configuration.systemPrompt);
      if (configurations.length === 1) {
        firstEntered.resolve();
        await releaseFirst.promise;
      }
      await originalReconfigure(configuration);
    };

    const configure = service.configureActiveAgent(active!.id, {
      systemPrompt: "Temporary concurrent prompt",
    });
    const reset = service.resetActiveAgent(active!.id);
    await firstEntered.promise;
    expect(configurations).toEqual(["Temporary concurrent prompt"]);

    releaseFirst.resolve();
    const [configured, resetAgent] = await Promise.all([configure, reset]);
    expect(configured.config.systemPrompt).toBe("Temporary concurrent prompt");
    expect(resetAgent.config.systemPrompt).toBe("Help with Ableton.");
    expect(configurations).toEqual([
      "Temporary concurrent prompt",
      "Help with Ableton.",
    ]);
    expect(agent.managedConfigurations.get(active!.id)?.systemPrompt).toBe(
      "Help with Ableton.",
    );
    expect((await sessionStore.load())[0]?.activeAgents[0]).toMatchObject({
      id: active!.id,
      modified: false,
      config: { systemPrompt: "Help with Ableton." },
    });
    await service.stop();
  });

  it("keeps slow preparation per-agent while preserving same-agent order and shutdown drain", async () => {
    const { service, agent } = await harness();
    await service.start();
    const [first] = await service.listActiveAgents();
    const second = await service.createActiveAgent("default");
    await service.assignOutput(second.id, "producer-1");
    const originalReconfigure = agent.reconfigureManagedAgent.bind(agent);
    const configureEntered = deferred<void>();
    const releaseConfigure = deferred<void>();
    const lifecycle: string[] = [];
    agent.reconfigureManagedAgent = async (configuration) => {
      await originalReconfigure(configuration);
      if (configuration.instanceId === first!.id) {
        lifecycle.push("configure:prepared");
        configureEntered.resolve();
        await releaseConfigure.promise;
      }
    };
    service.subscribe((event) => {
      if (event.type === "agent.instance_changed") {
        lifecycle.push(`${event.instance.id}:${event.change}`);
      }
    });

    const configure = service.configureActiveAgent(first!.id, {
      systemPrompt: "Slow prepared prompt",
    });
    await configureEntered.promise;
    const sameAgentRename = service.renameActiveAgent(
      first!.id,
      "Configured first",
    );
    const otherAgentRename = service.renameActiveAgent(
      second.id,
      "Fast second",
    );
    const otherAgentOutput = service.setOutputDeliveryMode(
      second.id,
      "producer-1",
      "automatic-analysis",
    );

    await expect(otherAgentRename).resolves.toMatchObject({
      id: second.id,
      label: "Fast second",
    });
    await expect(otherAgentOutput).resolves.toMatchObject({
      agentInstanceId: second.id,
      deliveryMode: "automatic-analysis",
    });
    let sameAgentFinished = false;
    void sameAgentRename.then(() => {
      sameAgentFinished = true;
    });
    await settle();
    expect(sameAgentFinished).toBe(false);

    let stopped = false;
    const stop = service.stop().then(() => {
      stopped = true;
    });
    await settle();
    expect(stopped).toBe(false);

    releaseConfigure.resolve();
    await Promise.all([configure, sameAgentRename, stop]);
    expect(lifecycle.indexOf(`${first!.id}:configured`)).toBeLessThan(
      lifecycle.indexOf(`${first!.id}:renamed`),
    );
    expect(agent.managedConfigurations.size).toBe(0);
  });

  it("rolls back prepared runtime replacement when the production session switches", async () => {
    const { service, agent, sessionStore } = await harness();
    await service.start();
    const originalSession = (await service.getSessions())[0]!;
    const originalAgent = originalSession.activeAgents[0]!;
    const otherSessionId = await service.createSession();
    const otherAgentIds = (await service.listActiveAgents()).map(
      ({ id }) => id,
    );
    await service.resumeSession(originalSession.id);
    const originalBefore = structuredClone(
      (await service.getSessions()).find(
        ({ id }) => id === originalSession.id,
      )!,
    );
    const originalReconfigure = agent.reconfigureManagedAgent.bind(agent);
    const prepared = deferred<void>();
    const release = deferred<void>();
    agent.reconfigureManagedAgent = async (configuration) => {
      await originalReconfigure(configuration);
      if (configuration.instanceId === originalAgent.id) {
        prepared.resolve();
        await release.promise;
      }
    };

    const configure = service.configureActiveAgent(originalAgent.id, {
      systemPrompt: "Must not cross the session switch",
    });
    await prepared.promise;
    await service.resumeSession(otherSessionId);
    release.resolve();

    await expect(configure).rejects.toThrow(
      `Active production session changed from '${originalSession.id}' to '${otherSessionId}' while the operation was queued`,
    );
    expect([...agent.managedConfigurations.keys()].sort()).toEqual(
      [...otherAgentIds].sort(),
    );
    expect(
      (await sessionStore.load()).find(({ id }) => id === originalSession.id),
    ).toEqual(originalBefore);
    await service.stop();
    expect(agent.managedConfigurations.size).toBe(0);
  });

  it("does not resurrect a deactivated agent after its production session switches", async () => {
    const signals = new FakeSignalRuntime();
    const { service, agent, sessionStore } = await harness({}, { signals });
    await service.start();
    const sourceSession = (await service.getSessions())[0]!;
    const sourceAgent = sourceSession.activeAgents[0]!;
    const targetSessionId = await service.createSession();
    const targetAgentIds = (await service.listActiveAgents()).map(
      ({ id }) => id,
    );
    await service.resumeSession(sourceSession.id);
    const sourceBefore = structuredClone(
      (await service.getSessions()).find(({ id }) => id === sourceSession.id)!,
    );
    const originalDeactivate = agent.deactivateManagedAgent.bind(agent);
    const deactivated = deferred<void>();
    const release = deferred<void>();
    let sourceDeactivationCalls = 0;
    agent.deactivateManagedAgent = async (instanceId) => {
      await originalDeactivate(instanceId);
      if (instanceId === sourceAgent.id && sourceDeactivationCalls++ === 0) {
        deactivated.resolve();
        await release.promise;
      }
    };

    const mutation = service.deactivateActiveAgent(sourceAgent.id);
    await deactivated.promise;
    await service.resumeSession(targetSessionId);
    release.resolve();

    await expect(mutation).rejects.toThrow(
      `Active production session changed from '${sourceSession.id}' to '${targetSessionId}' while the operation was queued`,
    );
    expect([...agent.managedConfigurations.keys()].sort()).toEqual(
      [...targetAgentIds].sort(),
    );
    expect(signals.activeAgentIds).toEqual(targetAgentIds);
    expect(
      (await sessionStore.load()).find(({ id }) => id === sourceSession.id),
    ).toEqual(sourceBefore);
    await service.stop();
  });

  it("rejects a stale deactivation after switching away from and back to its session", async () => {
    const signals = new FakeSignalRuntime();
    const { service, agent } = await harness({}, { signals });
    await service.start();
    const sourceSession = (await service.getSessions())[0]!;
    const sourceAgent = sourceSession.activeAgents[0]!;
    const targetSessionId = await service.createSession();
    await service.resumeSession(sourceSession.id);
    const originalDeactivate = agent.deactivateManagedAgent.bind(agent);
    const deactivated = deferred<void>();
    const release = deferred<void>();
    let sourceDeactivationCalls = 0;
    agent.deactivateManagedAgent = async (instanceId) => {
      await originalDeactivate(instanceId);
      if (instanceId === sourceAgent.id && sourceDeactivationCalls++ === 0) {
        deactivated.resolve();
        await release.promise;
      }
    };

    const mutation = service.deactivateActiveAgent(sourceAgent.id);
    await deactivated.promise;
    await service.resumeSession(targetSessionId);
    await service.resumeSession(sourceSession.id);
    release.resolve();

    await expect(mutation).rejects.toThrow(
      `Agent instance '${sourceAgent.id}' changed in production session '${sourceSession.id}' while the operation was preparing`,
    );
    expect([...agent.managedConfigurations.keys()]).toEqual([sourceAgent.id]);
    expect(signals.activeAgentIds).toEqual([sourceAgent.id]);
    expect(await service.listActiveAgents()).toHaveLength(1);
    await service.stop();
  });

  it("restores a deactivated agent when its original session remains active and still expects it", async () => {
    const signals = new FakeSignalRuntime();
    const { service, agent } = await harness({}, { signals });
    await service.start();
    const session = (await service.getSessions())[0]!;
    const active = session.activeAgents[0]!;
    const originalDeactivate = agent.deactivateManagedAgent.bind(agent);
    const entered = deferred<void>();
    const release = deferred<void>();
    let firstDeactivation = true;
    agent.deactivateManagedAgent = async (instanceId) => {
      if (instanceId === active.id && firstDeactivation) {
        firstDeactivation = false;
        entered.resolve();
        await release.promise;
      }
      await originalDeactivate(instanceId);
    };

    const mutation = service.deactivateActiveAgent(active.id);
    await entered.promise;
    await service.resumeSession(session.id);
    release.resolve();

    await expect(mutation).rejects.toThrow(
      `Agent instance '${active.id}' changed in production session '${session.id}' while the operation was preparing`,
    );
    expect(agent.getManagedAgentSessionId(active.id)).toBe(active.sdkSessionId);
    expect(agent.managedConfigurations.has(active.id)).toBe(true);
    expect(signals.activeAgentIds).toEqual([active.id]);
    expect(await service.listActiveAgents()).toHaveLength(1);
    await service.stop();
  });

  it("does not restore a deactivated agent after stop begins during rollback", async () => {
    const signals = new FakeSignalRuntime();
    const { service, agent } = await harness({}, { signals });
    await service.start();
    const session = (await service.getSessions())[0]!;
    const active = session.activeAgents[0]!;
    const originalDeactivate = agent.deactivateManagedAgent.bind(agent);
    const originalResume = agent.resumeManagedAgent.bind(agent);
    const entered = deferred<void>();
    const release = deferred<void>();
    let firstDeactivation = true;
    let resumeCalls = 0;
    agent.deactivateManagedAgent = async (instanceId) => {
      if (instanceId === active.id && firstDeactivation) {
        firstDeactivation = false;
        entered.resolve();
        await release.promise;
      }
      await originalDeactivate(instanceId);
    };
    agent.resumeManagedAgent = async (configuration, sdkSessionId) => {
      resumeCalls += 1;
      await originalResume(configuration, sdkSessionId);
    };

    const mutation = service.deactivateActiveAgent(active.id);
    await entered.promise;
    await service.resumeSession(session.id);
    const stop = service.stop();
    release.resolve();

    await expect(mutation).rejects.toThrow(
      `Agent instance '${active.id}' changed in production session '${session.id}' while the operation was preparing`,
    );
    await stop;
    expect(resumeCalls).toBe(1);
    expect(agent.managedConfigurations.size).toBe(0);
    expect(signals.activeAgentIds).toEqual([]);
  });

  it("preserves the operation error when deactivation rollback restore fails", async () => {
    const signals = new FakeSignalRuntime();
    const { service, agent } = await harness({}, { signals });
    await service.start();
    const session = (await service.getSessions())[0]!;
    const active = session.activeAgents[0]!;
    const originalDeactivate = agent.deactivateManagedAgent.bind(agent);
    const originalResume = agent.resumeManagedAgent.bind(agent);
    const entered = deferred<void>();
    const release = deferred<void>();
    let firstDeactivation = true;
    let resumeCalls = 0;
    agent.deactivateManagedAgent = async (instanceId) => {
      if (instanceId === active.id && firstDeactivation) {
        firstDeactivation = false;
        entered.resolve();
        await release.promise;
      }
      await originalDeactivate(instanceId);
    };
    agent.resumeManagedAgent = async (configuration, sdkSessionId) => {
      resumeCalls += 1;
      if (resumeCalls === 2) throw new Error("restore failed");
      await originalResume(configuration, sdkSessionId);
    };

    const mutation = service.deactivateActiveAgent(active.id);
    await entered.promise;
    await service.resumeSession(session.id);
    release.resolve();

    const error = await mutation.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors[0]).toMatchObject({
      message: `Agent instance '${active.id}' changed in production session '${session.id}' while the operation was preparing`,
    });
    expect((error as AggregateError).errors[1]).toMatchObject({
      message: "restore failed",
    });
    expect(agent.getManagedAgentSessionId(active.id)).toBeUndefined();
    expect(signals.activeAgentIds).toEqual([]);
    await service.stop();
  });

  it("drains queued configure and reset actions before shutdown", async () => {
    const { service, agent, application, sessionStore } = await harness();
    await service.start();
    const [active] = await service.listActiveAgents();
    const lifecycle: string[] = [];
    const firstEntered = deferred<void>();
    const secondEntered = deferred<void>();
    const releaseFirst = deferred<void>();
    const releaseSecond = deferred<void>();
    const originalReconfigure = agent.reconfigureManagedAgent.bind(agent);
    const originalSave = sessionStore.save.bind(sessionStore);
    const originalStop = application.stop.bind(application);
    let reconfigureCalls = 0;
    agent.reconfigureManagedAgent = async (configuration) => {
      reconfigureCalls += 1;
      const call = reconfigureCalls;
      lifecycle.push(`reconfigure:${call}:entered`);
      (call === 1 ? firstEntered : secondEntered).resolve();
      await (call === 1 ? releaseFirst : releaseSecond).promise;
      await originalReconfigure(configuration);
      lifecycle.push(`reconfigure:${call}:complete`);
    };
    vi.spyOn(sessionStore, "save").mockImplementation(async (sessions) => {
      await originalSave(sessions);
      lifecycle.push("sessions:saved");
    });
    application.stop = async () => {
      lifecycle.push("application:stop");
      await originalStop();
    };
    service.subscribe((event) => {
      if (
        event.type === "agent.instance_changed" &&
        (event.change === "configured" || event.change === "reset")
      ) {
        lifecycle.push(`event:${event.change}`);
      }
    });

    const configure = service.configureActiveAgent(active!.id, {
      systemPrompt: "Slow shutdown prompt",
    });
    await firstEntered.promise;
    const reset = service.resetActiveAgent(active!.id);
    let stopped = false;
    const stop = service.stop().then(() => {
      stopped = true;
    });

    await expect(
      service.configureActiveAgent(active!.id, { systemPrompt: "rejected" }),
    ).rejects.toThrow("Desktop service is not accepting actions");
    await expect(service.resetActiveAgent(active!.id)).rejects.toThrow(
      "Desktop service is not accepting actions",
    );
    await expect(service.deactivateActiveAgent(active!.id)).rejects.toThrow(
      "Desktop service is not accepting actions",
    );
    await expect(service.createActiveAgent("default")).rejects.toThrow(
      "Desktop service is not accepting actions",
    );
    await settle();
    expect(stopped).toBe(false);
    expect(lifecycle).not.toContain("application:stop");

    releaseFirst.resolve();
    await secondEntered.promise;
    await settle();
    expect(stopped).toBe(false);
    expect(lifecycle).not.toContain("application:stop");

    releaseSecond.resolve();
    await Promise.all([configure, reset, stop]);

    expect(lifecycle.indexOf("reconfigure:1:complete")).toBeLessThan(
      lifecycle.indexOf("event:configured"),
    );
    expect(lifecycle.indexOf("reconfigure:2:complete")).toBeLessThan(
      lifecycle.indexOf("event:reset"),
    );
    expect(lifecycle.lastIndexOf("sessions:saved")).toBeLessThan(
      lifecycle.indexOf("application:stop"),
    );
    expect(lifecycle.indexOf("event:reset")).toBeLessThan(
      lifecycle.indexOf("application:stop"),
    );
    const afterStop = [...lifecycle];
    await settle();
    expect(lifecycle).toEqual(afterStop);
  });

  it("drains a slow deactivate before shutdown persistence and stop", async () => {
    const { service, agent, application, sessionStore } = await harness();
    await service.start();
    const [active] = await service.listActiveAgents();
    const lifecycle: string[] = [];
    const entered = deferred<void>();
    const release = deferred<void>();
    const originalDeactivate = agent.deactivateManagedAgent.bind(agent);
    const originalSave = sessionStore.save.bind(sessionStore);
    const originalStop = application.stop.bind(application);
    agent.deactivateManagedAgent = async (instanceId) => {
      lifecycle.push("deactivate:entered");
      entered.resolve();
      await release.promise;
      await originalDeactivate(instanceId);
      lifecycle.push("deactivate:complete");
    };
    vi.spyOn(sessionStore, "save").mockImplementation(async (sessions) => {
      await originalSave(sessions);
      lifecycle.push("sessions:saved");
    });
    application.stop = async () => {
      lifecycle.push("application:stop");
      await originalStop();
    };
    service.subscribe((event) => {
      if (
        event.type === "agent.instance_changed" &&
        event.change === "deactivated"
      ) {
        lifecycle.push("event:deactivated");
      }
    });

    const deactivate = service.deactivateActiveAgent(active!.id);
    await entered.promise;
    let stopped = false;
    const stop = service.stop().then(() => {
      stopped = true;
    });
    await settle();
    expect(stopped).toBe(false);
    expect(lifecycle).toEqual(["deactivate:entered"]);

    release.resolve();
    await Promise.all([deactivate, stop]);

    expect(lifecycle).toEqual([
      "deactivate:entered",
      "deactivate:complete",
      "sessions:saved",
      "event:deactivated",
      "application:stop",
    ]);
    const afterStop = [...lifecycle];
    await settle();
    expect(lifecycle).toEqual(afterStop);
  });

  it("drains a slow selection before stop and rejects selection while stopping or stopped", async () => {
    const { service, application, sessionStore } = await harness();
    await service.start();
    const second = await service.createActiveAgent("default");
    const lifecycle: string[] = [];
    const saveEntered = deferred<void>();
    const releaseSave = deferred<void>();
    const originalSave = sessionStore.save.bind(sessionStore);
    const originalStop = application.stop.bind(application);
    vi.spyOn(sessionStore, "save").mockImplementation(async (sessions) => {
      lifecycle.push("selection:save-entered");
      saveEntered.resolve();
      await releaseSave.promise;
      await originalSave(sessions);
      lifecycle.push("selection:saved");
    });
    application.stop = async () => {
      lifecycle.push("application:stop");
      await originalStop();
    };
    service.subscribe((event) => {
      if (
        event.type === "agent.instance_changed" &&
        event.change === "selected"
      ) {
        lifecycle.push("event:selected");
      }
    });

    const selection = service.selectActiveAgent(second.id);
    await saveEntered.promise;
    let stopped = false;
    const stop = service.stop().then(() => {
      stopped = true;
    });
    await expect(service.selectActiveAgent(second.id)).rejects.toThrow(
      "Desktop service is not accepting actions",
    );
    await settle();
    expect(stopped).toBe(false);
    expect(lifecycle).toEqual(["selection:save-entered"]);

    releaseSave.resolve();
    await Promise.all([selection, stop]);
    expect(lifecycle).toEqual([
      "selection:save-entered",
      "selection:saved",
      "event:selected",
      "application:stop",
    ]);

    const afterStop = [...lifecycle];
    await expect(service.selectActiveAgent(second.id)).rejects.toThrow(
      "Desktop service is not accepting actions",
    );
    await settle();
    expect(lifecycle).toEqual(afterStop);
  });

  it("orders selection before a later deactivate of the same agent", async () => {
    const { service, agent, sessionStore } = await harness();
    await service.start();
    const second = await service.createActiveAgent("default");
    const lifecycle: string[] = [];
    const saveEntered = deferred<void>();
    const releaseSave = deferred<void>();
    const originalSave = sessionStore.save.bind(sessionStore);
    const originalDeactivate = agent.deactivateManagedAgent.bind(agent);
    vi.spyOn(sessionStore, "save").mockImplementation(async (sessions) => {
      if (!lifecycle.includes("selection:save-entered")) {
        lifecycle.push("selection:save-entered");
        saveEntered.resolve();
        await releaseSave.promise;
      }
      await originalSave(sessions);
    });
    agent.deactivateManagedAgent = async (instanceId) => {
      lifecycle.push("deactivate:entered");
      await originalDeactivate(instanceId);
    };
    service.subscribe((event) => {
      if (
        event.type === "agent.instance_changed" &&
        (event.change === "selected" || event.change === "deactivated")
      ) {
        lifecycle.push(`event:${event.change}`);
      }
    });

    const selection = service.selectActiveAgent(second.id);
    await saveEntered.promise;
    const deactivate = service.deactivateActiveAgent(second.id);
    await settle();
    expect(lifecycle).toEqual(["selection:save-entered"]);

    releaseSave.resolve();
    await Promise.all([selection, deactivate]);
    expect(lifecycle.indexOf("event:selected")).toBeLessThan(
      lifecycle.indexOf("deactivate:entered"),
    );
    expect(lifecycle.indexOf("deactivate:entered")).toBeLessThan(
      lifecycle.indexOf("event:deactivated"),
    );
    await service.stop();
  });

  it("rejects selection queued behind deactivation of the same agent", async () => {
    const { service, agent, events } = await harness();
    await service.start();
    const second = await service.createActiveAgent("default");
    const entered = deferred<void>();
    const release = deferred<void>();
    const originalDeactivate = agent.deactivateManagedAgent.bind(agent);
    agent.deactivateManagedAgent = async (instanceId) => {
      entered.resolve();
      await release.promise;
      await originalDeactivate(instanceId);
    };

    const deactivate = service.deactivateActiveAgent(second.id);
    await entered.promise;
    const selection = service.selectActiveAgent(second.id);
    release.resolve();

    await deactivate;
    await expect(selection).rejects.toThrow(
      `Agent instance '${second.id}' not found`,
    );
    expect(
      events.some(
        (event) =>
          event.type === "agent.instance_changed" &&
          event.change === "selected" &&
          event.instance.id === second.id,
      ),
    ).toBe(false);
    await service.stop();
  });

  it("cancels only the targeted managed instance", async () => {
    const { service, agent, events } = await harness({
      agent: { block: true },
    });
    await service.start();
    const [first] = await service.listActiveAgents();
    const second = await service.createActiveAgent("default");

    await service.sendToActiveAgent(first!.id, "first");
    await service.sendToActiveAgent(second.id, "second");
    await expect(service.cancelActiveAgent(first!.id)).resolves.toEqual({
      cancelled: true,
    });
    await expect(service.cancelActiveAgent(first!.id)).resolves.toEqual({
      cancelled: false,
    });
    agent.releaseManaged(second.id);
    await settle();

    expect(
      events.some(
        (event) =>
          event.type === "operation.changed" &&
          event.agentInstanceId === first!.id &&
          event.operation.status === "cancelled",
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === "operation.changed" &&
          event.agentInstanceId === second.id &&
          event.operation.status === "completed",
      ),
    ).toBe(true);
    await service.stop();
  });

  it("starts the shared application and reports its real lifecycle", async () => {
    const { service, ableton, agent, events } = await harness();
    let snapshotAtReady: ReturnType<typeof service.getSnapshot> | undefined;
    service.subscribe((event) => {
      if (event.type === "lifecycle.changed" && event.state === "ready") {
        snapshotAtReady = service.getSnapshot();
      }
    });

    await service.start();

    expect(agent.started).toBe(true);
    expect(ableton.started).toBe(true);
    expect(await service.getLifecycleState()).toBe("ready");
    await expect(snapshotAtReady).resolves.toMatchObject({
      tracks: [expect.objectContaining({ name: "Bass" })],
    });
    expect(await service.getStatus()).toMatchObject({ state: "connected" });
    expect(
      events.some(
        (event) =>
          event.type === "project.snapshot_changed" &&
          event.snapshot.tracks[0]?.name === "Bass",
      ),
    ).toBe(true);
    await service.stop();
    expect(await service.getLifecycleState()).toBe("stopped");
  });

  it("streams a turn through shared events under one message id", async () => {
    const { service, events } = await harness({
      agent: { deltas: ["Insp", "ecting"], reply: "Inspecting the set" },
    });
    await service.start();

    const { messageId } = await service.send(
      "What is in the set?",
      [{ id: "track:1", kind: "track", label: "Bass" }],
      "explore",
    );
    await settle();

    const deltas = events.filter(
      (event) => event.type === "agent.message_delta",
    );
    expect(deltas.map((event) => event.content)).toEqual(["Insp", "ecting"]);
    expect(deltas.every((event) => event.messageId === messageId)).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === "operation.changed" &&
          event.operation.id === messageId &&
          event.operation.status === "completed",
      ),
    ).toBe(true);
    await service.stop();
  });

  it("keeps automatic response stream IDs stable and isolated by agent session", async () => {
    const { service, events, sharedEvents } = await harness();
    await service.start();
    const first = {
      agentInstanceId: "00000000-0000-4000-8000-000000000001",
      sdkSessionId: "sdk:shared",
    };
    const second = {
      agentInstanceId: "00000000-0000-4000-8000-000000000002",
      sdkSessionId: "sdk:shared",
    };

    sharedEvents.publish({
      type: "agent.message_delta",
      content: "first-a",
      ...first,
    });
    sharedEvents.publish({
      type: "agent.message_delta",
      content: "second-a",
      ...second,
    });
    sharedEvents.publish({
      type: "agent.message_delta",
      content: "first-b",
      ...first,
    });
    sharedEvents.publish({
      type: "agent.message_complete",
      content: "first complete",
      ...first,
    });

    const messages = events.filter(
      (event) =>
        event.type === "agent.message_delta" ||
        event.type === "agent.message_complete",
    );
    const firstMessages = messages.filter(
      (event) => event.agentInstanceId === first.agentInstanceId,
    );
    const secondMessage = messages.find(
      (event) => event.agentInstanceId === second.agentInstanceId,
    );
    expect(new Set(firstMessages.map(({ messageId }) => messageId)).size).toBe(
      1,
    );
    expect(secondMessage?.messageId).not.toBe(firstMessages[0]?.messageId);

    sharedEvents.publish({
      type: "agent.message_delta",
      content: "next first",
      ...first,
    });
    const nextFirst = events
      .filter(
        (event) =>
          event.type === "agent.message_delta" &&
          event.agentInstanceId === first.agentInstanceId,
      )
      .at(-1);
    expect(
      nextFirst !== undefined && "messageId" in nextFirst
        ? nextFirst.messageId
        : undefined,
    ).not.toBe(firstMessages[0]?.messageId);

    sharedEvents.publish({
      type: "operation.failed",
      operationId: "automatic-response",
      code: "agent_failed",
      message: "Automatic response failed",
      ...second,
    });
    sharedEvents.publish({
      type: "agent.message_delta",
      content: "next second",
      ...second,
    });
    const nextSecond = events
      .filter(
        (event) =>
          event.type === "agent.message_delta" &&
          event.agentInstanceId === second.agentInstanceId,
      )
      .at(-1);
    expect(
      nextSecond !== undefined && "messageId" in nextSecond
        ? nextSecond.messageId
        : undefined,
    ).not.toBe(secondMessage?.messageId);
    await service.stop();
  });

  it("sends active-agent prompts without legacy mode or context prefixes", async () => {
    const { service, agent } = await harness();
    await service.start();

    await service.send(
      "Make it darker",
      [{ id: "track:1", kind: "track", label: "Bass" }],
      "sound",
    );
    await settle();

    expect(agent.prompts[0]).toBe("Make it darker");
    await service.stop();
  });

  it("reports cancellation only when a turn was actually aborted", async () => {
    const { service, agent, events } = await harness({
      agent: { block: true },
    });
    await service.start();

    await expect(service.cancel()).resolves.toEqual({ cancelled: false });
    const { messageId } = await service.send("Long job", [], "arrange");
    await settle();
    await expect(service.cancel()).resolves.toEqual({ cancelled: true });
    await settle();

    // The first cancel never reached the agent: no turn was in flight.
    expect(agent.cancelCalls).toBe(1);
    expect(
      events.find(
        (event) =>
          event.type === "operation.changed" &&
          event.operation.id === messageId &&
          event.operation.status === "cancelled",
      ),
    ).toBeDefined();
    expect(
      events.some(
        (event) =>
          event.type === "diagnostic" && event.message.includes("not undone"),
      ),
    ).toBe(true);
    await service.stop();
  });

  it("rejects overlapping sends and surfaces turn failures", async () => {
    const { service, agent, events } = await harness({
      agent: { block: true },
    });
    await service.start();

    await service.send("First", [], "explore");
    await expect(service.send("Second", [], "explore")).rejects.toThrow(
      "already in progress",
    );
    agent.setBehavior({ failWith: new Error("model unavailable") });
    agent.release();
    await settle();

    expect(
      events.some(
        (event) =>
          event.type === "diagnostic" && event.message === "model unavailable",
      ),
    ).toBe(true);
    await service.stop();
  });

  it("persists agent sessions so a cold start can resume them", async () => {
    const directory = await temporaryDirectory();
    const preferencesPath = join(directory, "preferences.json");
    const sessionsPath = join(directory, "sessions.json");
    const build = () => {
      const fake = createFakeApplication();
      const catalog = defaultCatalog();
      return {
        fake,
        service: new HeadlessDesktopService({
          application: fake.application,
          approvals: new ApprovalCoordinator(),
          preferencesStore: new JsonPreferencesStore(preferencesPath),
          sessionStore: new JsonSessionStore(sessionsPath),
          agentCatalog: {
            current: catalog,
            refresh: () => Promise.resolve(catalog),
          },
        }),
      };
    };

    const first = build();
    await first.service.start();
    const productionSessionId = await first.service.createSession();
    const sdkSessionId = first.fake.agent.sessionId;
    expect(sdkSessionId).toBeDefined();
    expect(productionSessionId).not.toBe(sdkSessionId);
    const plan = [
      {
        id: "section-1",
        name: "Intro",
        startBar: 1,
        endBar: 8,
        tracks: ["track-1"],
        status: "proposed" as const,
      },
    ];
    await first.service.updatePlan(plan);
    await first.service.send("Use arrangement mode", [], "arrange");
    await settle();
    await first.service.stop();

    const restarted = build();
    const events: DesktopAppEvent[] = [];
    restarted.service.subscribe((event) => events.push(event));
    await restarted.service.start();

    // A cold start continues the newest stored conversation instead of
    // silently opening a different one.
    expect(restarted.fake.agent.sessionId).toBe(sdkSessionId);
    const restoredSession = (await restarted.service.getSessions()).find(
      ({ id }) => id === productionSessionId,
    );
    expect(restoredSession?.mode).toBe("arrange");
    expect(restoredSession?.productionPlan).toEqual(plan);
    expect(typeof restoredSession?.selectedAgentInstanceId).toBe("string");
    expect(restoredSession?.activeAgents).toEqual([
      expect.objectContaining({
        definitionName: "default",
        sdkSessionId,
      }),
    ]);
    const restoredContext = events.find(
      (event) => event.type === "session.context_restored",
    );
    expect(restoredContext?.type).toBe("session.context_restored");
    if (restoredContext?.type === "session.context_restored") {
      expect(restoredContext.session).toMatchObject({
        id: productionSessionId,
        mode: "arrange",
        productionPlan: plan,
      });
    }
    await expect(
      restarted.service.resumeSession(productionSessionId),
    ).resolves.toBeUndefined();
    expect(restarted.fake.agent.sessionId).toBe(sdkSessionId);
    await expect(restarted.service.resumeSession("unknown")).rejects.toThrow(
      "Session not found",
    );
    await restarted.service.stop();
  });

  it("starts clean instead of resuming the newest session from another Live Set", async () => {
    const directory = await temporaryDirectory();
    const preferencesStore = new JsonPreferencesStore(
      join(directory, "preferences.json"),
    );
    const sessionStore = new JsonSessionStore(join(directory, "sessions.json"));
    const projectSessionStore = new JsonProjectSessionStore(
      join(directory, "project-sessions.json"),
    );
    const catalog = defaultCatalog();
    const build = (projectId: string, projectName: string) => {
      const ableton = defaultFakeState();
      if (ableton.status.state !== "connected") {
        throw new Error("Expected connected fake state");
      }
      ableton.status = { ...ableton.status, projectId };
      ableton.projectIdentity = { projectId, projectName, saved: true };
      const fake = createFakeApplication({ ableton });
      return {
        fake,
        service: new HeadlessDesktopService({
          application: fake.application,
          approvals: new ApprovalCoordinator(),
          preferencesStore,
          sessionStore,
          projectSessionStore,
          agentCatalog: {
            current: catalog,
            refresh: () => Promise.resolve(catalog),
          },
        }),
      };
    };

    const first = build("project-a", "Project A");
    await first.service.start();
    const firstSession = (await first.service.getSessions())[0]!;
    await first.service.sendToActiveAgent(
      firstSession.activeAgents[0]!.id,
      "Remember project A",
    );
    await settle();
    await first.service.stop();

    const second = build("project-b", "Project B");
    await second.service.start();
    const active = (await second.service.getSessions())[0]!;
    expect(active.id).not.toBe(firstSession.id);
    expect(active.projectId).toBe("project-b");
    await expect(
      second.service.hydrateActiveAgentHistory(active.activeAgents[0]!.id),
    ).resolves.toEqual([]);
    await second.service.stop();
  });

  it("keeps unsaved Live Set sessions ephemeral across shutdown", async () => {
    const directory = await temporaryDirectory();
    const ableton = defaultFakeState();
    ableton.projectIdentity = {
      projectId: "untitled-name-hash",
      projectName: "Untitled",
      saved: false,
    };
    const fake = createFakeApplication({ ableton });
    const sessionStore = new JsonSessionStore(join(directory, "sessions.json"));
    const service = new HeadlessDesktopService({
      application: fake.application,
      approvals: new ApprovalCoordinator(),
      preferencesStore: new JsonPreferencesStore(
        join(directory, "preferences.json"),
      ),
      sessionStore,
      projectSessionStore: new JsonProjectSessionStore(
        join(directory, "project-sessions.json"),
      ),
      agentCatalog: {
        current: defaultCatalog(),
        refresh: () => Promise.resolve(defaultCatalog()),
      },
    });

    await service.start();
    const active = (await service.getSessions())[0]!;
    expect(active.projectId).toBeUndefined();
    await service.sendToActiveAgent(
      active.activeAgents[0]!.id,
      "Temporary idea",
    );
    await settle();
    await service.stop();

    await expect(sessionStore.load()).resolves.toEqual([]);
  });

  it("requests a decision when the open Live Set changes mid-run", async () => {
    const directory = await temporaryDirectory();
    const projectSessionStore = new JsonProjectSessionStore(
      join(directory, "project-sessions.json"),
    );
    const { service, ableton, events } = await harness(
      {},
      { projectSessionStore },
    );
    await service.start();
    ableton.state.projectIdentity = {
      projectId: "project-b",
      projectName: "Project B",
      saved: true,
    };
    if (ableton.state.status.state === "connected") {
      ableton.state.status = {
        ...ableton.state.status,
        projectId: "project-b",
      };
    }

    await service.getSnapshot();
    const requested = events.find(
      (event) => event.type === "project.transition_requested",
    );
    expect(requested).toMatchObject({
      transition: {
        kind: "unassociated",
        project: { projectId: "project-b" },
        decisions: ["fork-current", "start-fresh"],
      },
    });
    const activeAgentId = (await service.listActiveAgents())[0]!.id;
    expect(() =>
      service.sendToActiveAgent(activeAgentId, "Do not run"),
    ).toThrow("transition decision");
    if (requested?.type !== "project.transition_requested") {
      throw new Error("Expected a pending project transition");
    }
    const session = await service.resolveProjectTransition(
      requested.transition.token,
      "start-fresh",
    );
    expect(session.projectId).toBe("project-b");
    expect(session.productionPlan).toEqual([]);
    await service.stop();
  });

  it("detects a Live Set change through the lifecycle-owned identity monitor", async () => {
    const directory = await temporaryDirectory();
    const { service, ableton, events } = await harness(
      {},
      {
        projectSessionStore: new JsonProjectSessionStore(
          join(directory, "project-sessions.json"),
        ),
        projectIdentityPollIntervalMs: 5,
      },
    );
    await service.start();
    ableton.state.projectIdentity = {
      projectId: "polled-project",
      projectName: "Polled Project",
      saved: true,
    };

    await vi.waitFor(
      () => {
        expect(
          events.some(
            (event) =>
              event.type === "project.transition_requested" &&
              event.transition.project.projectId === "polled-project",
          ),
        ).toBe(true);
      },
      { timeout: 500 },
    );
    await service.stop();
  });

  it("forks conversation context without sharing SDK sessions across Live Sets", async () => {
    const directory = await temporaryDirectory();
    const projectSessionStore = new JsonProjectSessionStore(
      join(directory, "project-sessions.json"),
    );
    const { service, ableton, events } = await harness(
      {},
      { projectSessionStore },
    );
    await service.start();
    const source = (await service.getSessions())[0]!;
    const sourceAgent = source.activeAgents[0]!;
    await service.sendToActiveAgent(sourceAgent.id, "Remember this direction");
    await settle();
    ableton.state.projectIdentity = {
      projectId: "project-fork",
      projectName: "Forked Project",
      saved: true,
    };
    if (ableton.state.status.state === "connected") {
      ableton.state.status = {
        ...ableton.state.status,
        projectId: "project-fork",
      };
    }
    events.length = 0;
    await service.getSnapshot();
    const requested = events.find(
      (event) => event.type === "project.transition_requested",
    );
    if (requested?.type !== "project.transition_requested") {
      throw new Error("Expected a pending project transition");
    }

    const fork = await service.resolveProjectTransition(
      requested.transition.token,
      "fork-current",
    );
    expect(fork.projectId).toBe("project-fork");
    expect(fork.id).not.toBe(source.id);
    expect(fork.activeAgents[0]?.id).not.toBe(sourceAgent.id);
    expect(fork.activeAgents[0]?.sdkSessionId).not.toBe(
      sourceAgent.sdkSessionId,
    );
    await expect(
      service.hydrateActiveAgentHistory(fork.activeAgents[0]!.id),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: "Remember this direction",
        }),
      ]),
    );
    expect(
      (await service.getSessions()).some(({ id }) => id === source.id),
    ).toBe(true);
    await service.stop();
  });

  it("resumes the canonical saved session when switching back to an associated Live Set", async () => {
    const directory = await temporaryDirectory();
    const preferencesStore = new JsonPreferencesStore(
      join(directory, "preferences.json"),
    );
    const sessionStore = new JsonSessionStore(join(directory, "sessions.json"));
    const projectSessionStore = new JsonProjectSessionStore(
      join(directory, "project-sessions.json"),
    );
    const catalog = defaultCatalog();
    const build = (projectId: string, projectName: string) => {
      const ableton = defaultFakeState();
      if (ableton.status.state !== "connected") {
        throw new Error("Expected connected fake state");
      }
      ableton.status = { ...ableton.status, projectId };
      ableton.projectIdentity = { projectId, projectName, saved: true };
      const fake = createFakeApplication({ ableton });
      const events: DesktopAppEvent[] = [];
      const service = new HeadlessDesktopService({
        application: fake.application,
        approvals: new ApprovalCoordinator(),
        preferencesStore,
        sessionStore,
        projectSessionStore,
        agentCatalog: {
          current: catalog,
          refresh: () => Promise.resolve(catalog),
        },
      });
      service.subscribe((event) => events.push(event));
      return { ...fake, service, events };
    };

    const projectA = build("project-a", "Project A");
    await projectA.service.start();
    const projectASession = (await projectA.service.getSessions())[0]!;
    await projectA.service.stop();

    const projectB = build("project-b", "Project B");
    await projectB.service.start();
    const projectBSession = (await projectB.service.getSessions())[0]!;
    await projectB.service.stop();

    const activeA = build("project-a", "Project A");
    await activeA.service.start();
    expect((await activeA.service.getSessions())[0]?.id).toBe(
      projectASession.id,
    );
    activeA.ableton.state.projectIdentity = {
      projectId: "project-b",
      projectName: "Project B",
      saved: true,
    };
    if (activeA.ableton.state.status.state !== "connected") {
      throw new Error("Expected connected fake state");
    }
    activeA.ableton.state.status = {
      ...activeA.ableton.state.status,
      projectId: "project-b",
    };
    activeA.events.length = 0;
    await activeA.service.getSnapshot();
    const requested = activeA.events.find(
      (event) => event.type === "project.transition_requested",
    );
    expect(requested).toMatchObject({
      transition: {
        kind: "associated",
        associatedSession: { id: projectBSession.id },
        decisions: ["resume-associated", "start-fresh"],
      },
    });
    if (requested?.type !== "project.transition_requested") {
      throw new Error("Expected an associated project transition");
    }
    const resumed = await activeA.service.resolveProjectTransition(
      requested.transition.token,
      "resume-associated",
    );
    expect(resumed.id).toBe(projectBSession.id);
    await activeA.service.stop();
  });

  it("does not assign newly discovered outputs and hides disconnected producers", async () => {
    const directory = await temporaryDirectory();
    const fake = createFakeApplication();
    const signals = new FakeSignalRuntime();
    const service = new HeadlessDesktopService({
      application: fake.application,
      approvals: new ApprovalCoordinator(),
      preferencesStore: new JsonPreferencesStore(
        join(directory, "preferences.json"),
      ),
      sessionStore: new JsonSessionStore(join(directory, "sessions.json")),
      signals,
      agentCatalog: {
        current: defaultCatalog(),
        refresh: async () => defaultCatalog(),
      },
    });

    await service.start();
    const session = (await service.getSessions())[0]!;
    expect(session.activeAgents[0]?.config.inputChannels).toEqual([]);
    expect(session.activeAgents[0]?.outputSubscriptions).toEqual([]);
    expect(await service.listOutputs()).toMatchObject({
      connections: [expect.objectContaining({ producerId: "producer-1" })],
      assignments: [],
    });

    signals.connections[0] = {
      ...signals.connections[0]!,
      status: "disconnected",
      disconnectedAt: 2,
    };
    expect(await service.listOutputs()).toMatchObject({
      connections: [],
      assignments: [],
    });
    await service.stop();
  });

  it("manages Live events and explicitly attributed listeners across agents", async () => {
    const liveEvents = new FakeLiveEventRuntime();
    const { service, events } = await harness({}, { liveEvents });
    await service.start();
    const first = (await service.listActiveAgents())[0]!;
    const second = await service.createActiveAgent("default");
    const firstConfig = first.config;

    const definition = await service.createLiveEvent({
      kind: "track.playing_clip_changed",
      classification: "discrete",
      name: "Keys clip",
      enabled: true,
      target: { track: { name: "Keys", occurrence: 0 } },
    });
    liveEvents.states.set(definition.id, {
      definition,
      resolution: {
        status: "resolved",
        projectId: definition.projectId,
        trackReference: "00000000-0000-4000-8000-000000000010",
        track: { name: "Keys" },
      },
      latestState: {
        kind: "track.playing_clip_changed",
        state: { state: "stopped" },
      },
      history: [],
    });

    await service.assignLiveEventListener(first.id, definition.id, {
      enabled: true,
      responseMode: "next-prompt",
      messagePrefix: "First",
      preparedContext: {
        scope: "whole-session",
        includeSessionClips: true,
      },
    });
    await service.assignLiveEventListener(second.id, definition.id, {
      enabled: true,
      responseMode: "automatic",
    });
    const recording = await service.createLiveEvent({
      kind: "track.recording_state_changed",
      classification: "discrete",
      name: "Keys recording",
      enabled: true,
      target: { track: { name: "Keys", occurrence: 0 } },
    });
    await service.assignLiveEventListener(first.id, recording.id, {
      enabled: false,
      responseMode: "next-prompt",
      messagePrefix: "Recording changed:",
    });
    const updated = await service.updateLiveEventListener(
      first.id,
      definition.id,
      {
        enabled: false,
        responseMode: "automatic",
        messagePrefix: null,
        preparedContext: {
          scope: "selected-tracks",
          tracks: [{ track: { name: "Keys", occurrence: 0 } }],
          includeSessionClips: false,
        },
      },
    );
    expect(updated).toMatchObject({
      agentInstanceId: first.id,
      agentLabel: first.label,
      listener: {
        enabled: false,
        responseMode: "automatic",
        preparedContext: {
          scope: "selected-tracks",
          tracks: [{ track: { name: "Keys", occurrence: 0 } }],
          includeSessionClips: false,
        },
      },
    });
    expect(updated.listener).not.toHaveProperty("messagePrefix");

    const state = await service.listLiveEvents();
    expect(state.activeSessionId).toBeDefined();
    expect(state.events[0]?.definition).toEqual(definition);
    expect(state.events[0]?.resolution.status).toBe("resolved");
    expect(state.events[0]?.latestState).toEqual({
      kind: "track.playing_clip_changed",
      state: { state: "stopped" },
    });
    expect(state.events[0]?.history).toEqual([]);
    expect(
      state.events[0]?.listeners.map(({ agentInstanceId }) => agentInstanceId),
    ).toEqual(expect.arrayContaining([first.id, second.id]));
    const recordingListeners = state.events.find(
      ({ definition }) => definition.id === recording.id,
    )?.listeners;
    expect(recordingListeners).toHaveLength(1);
    expect(recordingListeners?.[0]?.agentInstanceId).toBe(first.id);
    expect(recordingListeners?.[0]?.listener).toMatchObject({
      enabled: false,
      responseMode: "next-prompt",
      messagePrefix: "Recording changed:",
    });
    const persistedAgents = (await service.getSessions())[0]!.activeAgents;
    expect(
      persistedAgents.find(({ id }) => id === first.id)?.eventListeners,
    ).toHaveLength(2);
    expect(
      persistedAgents.find(({ id }) => id === second.id)?.eventListeners,
    ).toHaveLength(1);
    expect(persistedAgents.find(({ id }) => id === first.id)?.config).toEqual(
      firstConfig,
    );
    await expect(service.inspectLiveEventSelection()).resolves.toEqual(
      liveEvents.inspectSelectionResult,
    );

    const disabled = await service.setLiveEventEnabled(definition.id, false);
    expect(disabled.enabled).toBe(false);
    const renamed = await service.updateLiveEvent(definition.id, {
      kind: "track.playing_clip_changed",
      classification: "discrete",
      name: "Renamed clip event",
      enabled: false,
      target: { track: { name: "Keys", occurrence: 0 } },
    });
    expect(renamed).toMatchObject({
      id: definition.id,
      name: "Renamed clip event",
      createdAt: definition.createdAt,
    });
    expect(
      events.some(
        (event) =>
          event.type === "events.changed" &&
          event.events.events[0]?.definition.name === "Renamed clip event",
      ),
    ).toBe(true);
    await service.stop();
  });

  it("transactionally cascades Live event deletion across multiple agents", async () => {
    const liveEvents = new FakeLiveEventRuntime();
    const { service, sessionStore } = await harness({}, { liveEvents });
    await service.start();
    const first = (await service.listActiveAgents())[0]!;
    const second = await service.createActiveAgent("default");
    const definition = await service.createLiveEvent({
      kind: "track.recording_state_changed",
      classification: "discrete",
      name: "Recording",
      enabled: true,
      target: { track: { name: "Keys", occurrence: 0 } },
    });
    await service.assignLiveEventListener(first.id, definition.id, {
      enabled: true,
      responseMode: "next-prompt",
    });
    await service.assignLiveEventListener(second.id, definition.id, {
      enabled: true,
      responseMode: "automatic",
    });

    const save = vi.spyOn(sessionStore, "save");
    save.mockRejectedValueOnce(new Error("disk unavailable"));
    await expect(service.deleteLiveEvent(definition.id)).rejects.toThrow(
      "disk unavailable",
    );
    expect((await service.listLiveEvents()).events).toHaveLength(1);
    expect(
      (await service.getSessions())[0]?.activeAgents.map(
        ({ eventListeners }) => eventListeners.length,
      ),
    ).toEqual([1, 1]);
    expect(liveEvents.configurations.at(-1)?.definitions).toHaveLength(1);

    save.mockRestore();
    await expect(service.deleteLiveEvent(definition.id)).resolves.toBe(true);
    const session = (await service.getSessions())[0]!;
    expect(session.liveEvents).toEqual([]);
    expect(
      session.activeAgents.map(({ eventListeners }) => eventListeners),
    ).toEqual([[], []]);
    expect(liveEvents.configurations.at(-1)).toMatchObject({
      definitions: [],
      listeners: [],
    });
    await service.stop();
  });

  it("persists output assignments and rebinds them to the selected session", async () => {
    const directory = await temporaryDirectory();
    const preferencesStore = new JsonPreferencesStore(
      join(directory, "preferences.json"),
    );
    const sessionStore = new JsonSessionStore(join(directory, "sessions.json"));
    const fake = createFakeApplication();
    const signals = new FakeSignalRuntime();
    const service = new HeadlessDesktopService({
      application: fake.application,
      approvals: new ApprovalCoordinator(),
      preferencesStore,
      sessionStore,
      signals,
      agentCatalog: {
        current: defaultCatalog(),
        refresh: async () => defaultCatalog(),
      },
    });
    await service.start();
    const first = (await service.getSessions())[0]!;
    const firstSession = first.id;
    const firstAgentId = first.activeAgents[0]!.id;
    const assignment = await service.assignOutput(firstAgentId, "producer-1");
    expect(assignment).toMatchObject({
      enabled: true,
      deliveryMode: "next-prompt",
      processingPolicyIds: ["latest-window"],
    });
    expect(signals.assignments.get(assignment.assignmentId)?.consumer).toEqual({
      kind: "agent-instance",
      id: firstAgentId,
    });

    const secondSession = await service.createSession();
    expect(secondSession).not.toBe(firstSession);
    expect(signals.assignments.size).toBe(0);
    await service.resumeSession(firstSession);
    expect(signals.assignments.get(assignment.assignmentId)?.consumer).toEqual({
      kind: "agent-instance",
      id: firstAgentId,
    });
    expect(
      (await sessionStore.load()).find(({ id }) => id === firstSession)
        ?.activeAgents[0]?.outputSubscriptions,
    ).toContainEqual(
      expect.objectContaining({ producerId: assignment.producerId }),
    );
    await service.stop();
    expect(signals.lifecycle).toEqual(["signals:start", "signals:stop"]);
  });

  it("keeps per-agent output subscriptions independent across disconnect and deactivation", async () => {
    const directory = await temporaryDirectory();
    const sessionStore = new JsonSessionStore(join(directory, "sessions.json"));
    const fake = createFakeApplication();
    const signals = new FakeSignalRuntime();
    const service = new HeadlessDesktopService({
      application: fake.application,
      approvals: new ApprovalCoordinator(),
      preferencesStore: new JsonPreferencesStore(
        join(directory, "preferences.json"),
      ),
      sessionStore,
      signals,
      agentCatalog: {
        current: defaultCatalog(),
        refresh: async () => defaultCatalog(),
      },
    });
    await service.start();
    const firstAgent = (await service.listActiveAgents())[0]!;
    const secondAgent = await service.createActiveAgent("default");

    const first = await service.assignOutput(firstAgent.id, "producer-1");
    const second = await service.assignOutput(secondAgent.id, "producer-1");
    expect(first.assignmentId).not.toBe(second.assignmentId);
    expect(signals.assignments.get(first.assignmentId)?.consumer).toEqual({
      kind: "agent-instance",
      id: firstAgent.id,
    });
    expect(signals.assignments.get(second.assignmentId)?.consumer).toEqual({
      kind: "agent-instance",
      id: secondAgent.id,
    });

    await service.setOutputDeliveryMode(
      firstAgent.id,
      "producer-1",
      "automatic-analysis",
    );
    await service.setOutputUsageInstruction(
      secondAgent.id,
      "producer-1",
      "Preserve the second agent's independent instruction.",
    );
    await service.setOutputProcessingPolicies(secondAgent.id, "producer-1", [
      "latest-window",
      "deduplicate",
    ]);
    let agents = await service.listActiveAgents();
    expect(agents[0]?.outputSubscriptions[0]?.deliveryMode).toBe(
      "automatic-analysis",
    );
    expect(agents[1]?.outputSubscriptions[0]).toMatchObject({
      deliveryMode: "next-prompt",
      usageInstruction: "Preserve the second agent's independent instruction.",
      processingPolicyIds: ["latest-window", "deduplicate"],
    });

    signals.connections.length = 0;
    expect((await service.listOutputs()).assignments).toHaveLength(2);
    signals.connections.push({
      connectionId: "connection-reconnected",
      producer: {
        producerId: "producer-1",
        instanceId: "instance-2",
        displayName: "MIDI Capture",
        signalKind: "midi",
        schemaVersion: "midi-sample/v1",
      },
      status: "connected",
      connectedAt: 2,
      lastHeartbeatAt: 2,
    });
    expect((await service.listOutputs()).assignments).toHaveLength(2);

    await service.deactivateActiveAgent(firstAgent.id);
    agents = await service.listActiveAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0]?.id).toBe(secondAgent.id);
    expect(signals.assignments.has(first.assignmentId)).toBe(false);
    expect(signals.assignments.has(second.assignmentId)).toBe(true);
    expect(signals.activeAgentIds).toEqual([secondAgent.id]);
    expect(
      (await sessionStore.load())[0]?.activeAgents[0]?.outputSubscriptions[0],
    ).toMatchObject({ producerId: "producer-1" });
    await service.stop();
  });

  it.each([
    {
      name: "select",
      run: (service: HeadlessDesktopService, agent: DesktopActiveAgent) =>
        service.selectActiveAgent(agent.id),
    },
    {
      name: "rename",
      run: (service: HeadlessDesktopService, agent: DesktopActiveAgent) =>
        service.renameActiveAgent(agent.id, "Wrong session"),
    },
    {
      name: "configure",
      run: (service: HeadlessDesktopService, agent: DesktopActiveAgent) =>
        service.configureActiveAgent(agent.id, {
          systemPrompt: "Wrong session prompt",
        }),
    },
    {
      name: "deactivate",
      run: (service: HeadlessDesktopService, agent: DesktopActiveAgent) =>
        service.deactivateActiveAgent(agent.id),
    },
    {
      name: "output assignment",
      run: (service: HeadlessDesktopService, agent: DesktopActiveAgent) =>
        service.assignOutput(agent.id, "producer-1"),
    },
  ])(
    "revalidates the production session after a queued $name races a session switch",
    async ({ run }) => {
      const signals = new FakeSignalRuntime();
      const { service, agent, sessionStore } = await harness({}, { signals });
      await service.start();
      const sourceSession = (await service.getSessions())[0]!;
      const sourceAgentIds = sourceSession.activeAgents.map(({ id }) => id);
      const targetSessionId = await service.createSession();
      const targetFirst = (await service.listActiveAgents())[0]!;
      const targetAgent = await service.createActiveAgent("default");
      await service.selectActiveAgent(targetFirst.id);
      const targetBefore = structuredClone(
        (await service.getSessions()).find(({ id }) => id === targetSessionId)!,
      );
      const resumeEntered = deferred<void>();
      const releaseResume = deferred<void>();
      const originalResume = agent.resumeManagedAgent.bind(agent);
      agent.resumeManagedAgent = async (configuration, sdkSessionId) => {
        if (sourceAgentIds.includes(configuration.instanceId)) {
          resumeEntered.resolve();
          await releaseResume.promise;
        }
        return originalResume(configuration, sdkSessionId);
      };

      const resume = service.resumeSession(sourceSession.id);
      await resumeEntered.promise;
      const mutation = run(service, targetAgent);
      await settle();
      releaseResume.resolve();

      await resume;
      await expect(mutation).rejects.toThrow(
        `Active production session changed from '${targetSessionId}' to '${sourceSession.id}' while the operation was queued`,
      );
      const persisted = await sessionStore.load();
      expect(persisted.find(({ id }) => id === targetSessionId)).toEqual(
        targetBefore,
      );
      expect(persisted[0]?.id).toBe(sourceSession.id);
      expect([...agent.managedConfigurations.keys()].sort()).toEqual(
        [...sourceAgentIds].sort(),
      );
      expect(signals.activeAgentIds).toEqual(sourceAgentIds);
      expect(signals.assignments.size).toBe(0);
      await service.stop();
    },
  );

  it("starts ingress before the application and stops it first", async () => {
    const directory = await temporaryDirectory();
    const lifecycle: string[] = [];
    const fake = createFakeApplication();
    const originalStart = fake.application.start.bind(fake.application);
    const originalStop = fake.application.stop.bind(fake.application);
    fake.application.start = async (options) => {
      lifecycle.push("application:start");
      await originalStart(options);
    };
    fake.application.stop = async () => {
      lifecycle.push("application:stop");
      await originalStop();
    };
    const service = new HeadlessDesktopService({
      application: fake.application,
      approvals: new ApprovalCoordinator(),
      preferencesStore: new JsonPreferencesStore(
        join(directory, "preferences.json"),
      ),
      sessionStore: new JsonSessionStore(join(directory, "sessions.json")),
      signals: new FakeSignalRuntime(lifecycle),
    });

    await service.start();
    await service.stop();

    expect(lifecycle).toEqual([
      "signals:start",
      "application:start",
      "signals:stop",
      "application:stop",
    ]);
  });

  it("rejects sends while a session transition is in progress", async () => {
    const { service, agent } = await harness();
    await service.start();
    let release!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    const originalCreate = agent.createSession.bind(agent);
    agent.createSession = async () => {
      await paused;
      return originalCreate();
    };

    const creating = service.createSession();
    await expect(service.send("race", [], "explore")).rejects.toThrow(
      "session transition",
    );
    release();
    await creating;
    await service.stop();
  });

  it("fails closed without replacing a production session on generic resume failure", async () => {
    const directory = await temporaryDirectory();
    const sessionsPath = join(directory, "sessions.json");
    const preferencesPath = join(directory, "preferences.json");
    const catalog = defaultCatalog();
    const first = createFakeApplication();
    const firstService = new HeadlessDesktopService({
      application: first.application,
      approvals: new ApprovalCoordinator(),
      preferencesStore: new JsonPreferencesStore(preferencesPath),
      sessionStore: new JsonSessionStore(sessionsPath),
      agentCatalog: {
        current: catalog,
        refresh: () => Promise.resolve(catalog),
      },
    });
    await firstService.start();
    const staleId = await firstService.createSession();
    await firstService.stop();

    const second = createFakeApplication();
    second.agent.resumeSession = () =>
      Promise.reject(new Error("session was deleted"));
    const service = new HeadlessDesktopService({
      application: second.application,
      approvals: new ApprovalCoordinator(),
      preferencesStore: new JsonPreferencesStore(preferencesPath),
      sessionStore: new JsonSessionStore(sessionsPath),
      agentCatalog: {
        current: catalog,
        refresh: () => Promise.resolve(catalog),
      },
    });
    const events: DesktopAppEvent[] = [];
    service.subscribe((event) => events.push(event));

    await service.start();

    expect(
      events.some(
        (event) =>
          event.type === "diagnostic" &&
          event.message.includes("could not be resumed"),
      ),
    ).toBe(true);
    const sessions = await service.getSessions();
    expect(sessions.some(({ id }) => id === staleId)).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === "session.context_restored" &&
          event.session.id === staleId,
      ),
    ).toBe(false);
    await service.stop();
  });

  it("rotates and persists only the missing SDK session during startup restoration", async () => {
    const directory = await temporaryDirectory();
    const sessionsPath = join(directory, "sessions.json");
    const preferencesPath = join(directory, "preferences.json");
    const catalog = defaultCatalog();
    const first = createFakeApplication();
    first.agent.models = [agentModel("model-a")];
    const firstService = new HeadlessDesktopService({
      application: first.application,
      approvals: new ApprovalCoordinator(),
      preferencesStore: new JsonPreferencesStore(preferencesPath),
      sessionStore: new JsonSessionStore(sessionsPath),
      agentCatalog: {
        current: catalog,
        refresh: () => Promise.resolve(catalog),
      },
    });
    await firstService.start();
    const initial = (await firstService.getSessions())[0]!;
    const original = await firstService.setActiveAgentConversationSettings(
      initial.activeAgents[0]!.id,
      { model: "model-a", reasoningEffort: "high" },
    );
    first.events.publish({
      type: "agent.live_event_trigger_changed",
      trigger: {
        deliveryId: "startup-trigger",
        occurrenceId: "00000000-0000-4000-8000-000000000101",
        eventId: "live-event.00000000-0000-4000-8000-000000000001",
        listenerId: "event-listener.00000000-0000-4000-8000-000000000001",
        agentInstanceId: original.id,
        sdkSessionId: original.sdkSessionId!,
        kind: "track.triggered_clip_changed",
        sourceTrack: "Lead drum",
        state: {
          kind: "track.triggered_clip_changed" as const,
          state: { state: "session-clip" as const, slotIndex: 1 },
        },
        observedAt: "2026-08-30T20:00:00.000Z",
        occurrence: "{}",
        summary: "Queued pattern2 in scene 2",
        status: "completed",
        updatedAt: "2026-08-30T20:00:01.000Z",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const [before] = await firstService.getSessions();
    await firstService.stop();

    const second = createFakeApplication();
    second.agent.resumeManagedAgent = vi.fn(async () => {
      throw new MissingCopilotSessionError(original.sdkSessionId!);
    });
    const originalCreateManagedAgent = second.agent.createManagedAgent.bind(
      second.agent,
    );
    const createManagedAgent = vi
      .spyOn(second.agent, "createManagedAgent")
      .mockImplementation(async (configuration) => {
        await originalCreateManagedAgent(configuration);
        return "replacement-sdk";
      });
    const service = new HeadlessDesktopService({
      application: second.application,
      approvals: new ApprovalCoordinator(),
      preferencesStore: new JsonPreferencesStore(preferencesPath),
      sessionStore: new JsonSessionStore(sessionsPath),
      agentCatalog: {
        current: catalog,
        refresh: () => Promise.resolve(catalog),
      },
    });
    const events: DesktopAppEvent[] = [];
    service.subscribe((event) => events.push(event));
    await service.start();

    const [restored] = await service.getSessions();
    const rotated = restored!.activeAgents[0]!;
    expect(restored!.id).toBe(before!.id);
    expect(rotated.id).toBe(original.id);
    expect(rotated.sdkSessionId).not.toBe(original.sdkSessionId);
    expect(rotated.model).toBe("model-a");
    expect(rotated.reasoningEffort).toBe("high");
    expect(rotated.config).toEqual(original.config);
    expect(rotated.forkedHistory).toEqual(original.forkedHistory);
    expect(rotated.boundTracks).toEqual(original.boundTracks);
    expect(rotated.outputSubscriptions).toEqual(original.outputSubscriptions);
    expect(rotated.eventListeners).toEqual(original.eventListeners);
    expect(rotated.triggerHistory).toEqual(
      before!.activeAgents[0]!.triggerHistory,
    );
    expect(createManagedAgent).toHaveBeenCalledOnce();
    expect(createManagedAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "model-a",
        reasoningEffort: "high",
      }),
    );
    expect(
      (await new JsonSessionStore(sessionsPath).load())[0]!.activeAgents[0]!
        .sdkSessionId,
    ).toBe(rotated.sdkSessionId);
    expect(events).toContainEqual({
      type: "agent.instance_changed",
      instance: rotated,
      change: "session-rotated",
    });
    expect(events).toContainEqual({
      type: "session.context_restored",
      session: restored,
    });
    expect((await service.listActiveAgents()).map(({ id }) => id)).toEqual([
      original.id,
    ]);
    expect((await service.listOutputs()).activeSessionId).toBe(restored!.id);
    expect((await service.listLiveEvents()).activeSessionId).toBe(restored!.id);
    await service.stop();
  });

  it("cleans up a provisional startup rotation when target persistence fails", async () => {
    const directory = await temporaryDirectory();
    const sessionsPath = join(directory, "sessions.json");
    const preferencesPath = join(directory, "preferences.json");
    const catalog = defaultCatalog();
    const first = createFakeApplication();
    const firstService = new HeadlessDesktopService({
      application: first.application,
      approvals: new ApprovalCoordinator(),
      preferencesStore: new JsonPreferencesStore(preferencesPath),
      sessionStore: new JsonSessionStore(sessionsPath),
      agentCatalog: {
        current: catalog,
        refresh: () => Promise.resolve(catalog),
      },
    });
    await firstService.start();
    const original = (await firstService.getSessions())[0]!.activeAgents[0]!;
    await firstService.stop();

    const second = createFakeApplication();
    second.agent.resumeManagedAgent = vi.fn(async () => {
      throw new MissingCopilotSessionError(original.sdkSessionId!);
    });
    const sessionStore = new JsonSessionStore(sessionsPath);
    vi.spyOn(sessionStore, "save").mockRejectedValueOnce(
      new Error("persistence failed"),
    );
    const service = new HeadlessDesktopService({
      application: second.application,
      approvals: new ApprovalCoordinator(),
      preferencesStore: new JsonPreferencesStore(preferencesPath),
      sessionStore,
      agentCatalog: {
        current: catalog,
        refresh: () => Promise.resolve(catalog),
      },
    });
    const events: DesktopAppEvent[] = [];
    service.subscribe((event) => events.push(event));
    await service.start();

    expect(second.agent.managedConfigurations.size).toBe(0);
    expect(
      (await new JsonSessionStore(sessionsPath).load())[0]!.activeAgents[0]!
        .sdkSessionId,
    ).toBe(original.sdkSessionId);
    expect((await service.listOutputs()).activeSessionId).toBeUndefined();
    expect(
      events.some((event) => event.type === "session.context_restored"),
    ).toBe(false);
    expect(
      events.some(
        (event) =>
          event.type === "diagnostic" &&
          event.message.includes("persistence failed"),
      ),
    ).toBe(true);
    await service.stop();
  });

  it("persists bounded workspace trigger updates and runtime SDK rotation idempotently", async () => {
    const { service, sharedEvents, sessionStore, events } = await harness();
    await service.start();
    const [session] = await service.getSessions();
    const instance = session!.activeAgents[0]!;
    const trigger = {
      deliveryId: "delivery-1",
      occurrenceId: "00000000-0000-4000-8000-000000000101",
      eventId: "live-event.00000000-0000-4000-8000-000000000001",
      listenerId: "event-listener.00000000-0000-4000-8000-000000000001",
      agentInstanceId: instance.id,
      sdkSessionId: instance.sdkSessionId!,
      kind: "track.triggered_clip_changed",
      sourceTrack: "Lead drum",
      state: {
        kind: "track.triggered_clip_changed" as const,
        state: { state: "session-clip" as const, slotIndex: 1 },
      },
      observedAt: "2026-08-30T20:00:00.000Z",
      messagePrefix: "Check the launch.",
      occurrence: '{"summary":"Queued pattern2 in scene 2"}',
      summary: "Queued pattern2 in scene 2",
      status: "queued" as const,
      updatedAt: "2026-08-30T20:00:00.010Z",
    };
    sharedEvents.publish({
      type: "agent.live_event_trigger_changed",
      trigger,
    });
    sharedEvents.publish({
      type: "agent.live_event_trigger_changed",
      trigger: {
        ...trigger,
        status: "completed",
        updatedAt: "2026-08-30T20:00:01.000Z",
      },
    });
    await settle();
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(
      (await sessionStore.load())[0]!.activeAgents[0]!.triggerHistory,
    ).toEqual([
      {
        ...trigger,
        status: "completed",
        updatedAt: "2026-08-30T20:00:01.000Z",
      },
    ]);

    sharedEvents.publish({
      type: "agent.sdk_session_rotated",
      agentInstanceId: instance.id,
      oldSdkSessionId: instance.sdkSessionId!,
      newSdkSessionId: "replacement-sdk",
      reason: "missing-session",
    });
    await settle();
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 20));
    sharedEvents.publish({
      type: "agent.sdk_session_rotated",
      agentInstanceId: instance.id,
      oldSdkSessionId: instance.sdkSessionId!,
      newSdkSessionId: "replacement-sdk",
      reason: "missing-session",
    });
    await settle();

    expect((await sessionStore.load())[0]!.activeAgents[0]!.sdkSessionId).toBe(
      "replacement-sdk",
    );
    expect(
      events.filter(
        (event) =>
          event.type === "agent.instance_changed" &&
          event.change === "session-rotated",
      ),
    ).toHaveLength(1);
    await service.stop();
  });

  it("does not emit rotation success when persistence fails", async () => {
    const { service, sharedEvents, sessionStore, events } = await harness();
    await service.start();
    const instance = (await service.getSessions())[0]!.activeAgents[0]!;
    vi.spyOn(sessionStore, "save").mockRejectedValueOnce(
      new Error("disk unavailable"),
    );
    sharedEvents.publish({
      type: "agent.sdk_session_rotated",
      agentInstanceId: instance.id,
      oldSdkSessionId: instance.sdkSessionId!,
      newSdkSessionId: "replacement-sdk",
      reason: "missing-session",
    });
    await settle();
    await settle();
    expect(
      events.some(
        (event) =>
          event.type === "agent.instance_changed" &&
          event.change === "session-rotated",
      ),
    ).toBe(false);
    await service.stop();
  });

  it("routes tool approvals to the renderer and back to the agent", async () => {
    const { service, approvals, events } = await harness();
    await service.start();

    const decision = approvals.request({
      metadata: {
        name: "ableton_tracks_delete",
        title: "Delete track",
        risk: "destructive",
        duration: "short",
        mutationTarget: "track",
      },
      arguments: { index: 2 },
    });
    const requested = events.find(
      (event) => event.type === "approval.requested",
    );
    expect(requested).toMatchObject({
      approval: { risk: "high", destructive: true, title: "Delete track" },
    });
    const id =
      requested?.type === "approval.requested" ? requested.approval.id : "";
    await expect(service.resolveApproval(id, "approve")).resolves.toBe(true);
    await expect(decision).resolves.toBe(true);
    await expect(service.resolveApproval(id, "approve")).resolves.toBe(false);
    await service.stop();
  });

  it("keeps concurrent approvals attributed to their originating agents", async () => {
    const { service, approvals, events } = await harness();
    await service.start();
    const [first] = await service.listActiveAgents();
    const second = await service.createActiveAgent("default");
    const request = {
      metadata: {
        name: "ableton_tracks_create" as const,
        title: "Create track",
        risk: "reversible" as const,
        duration: "short" as const,
        mutationTarget: "session" as const,
      },
      arguments: {},
    };

    const firstDecision = approvals.request({
      ...request,
      agentInstanceId: first!.id,
      sdkSessionId: first!.sdkSessionId!,
    });
    const secondDecision = approvals.request({
      ...request,
      agentInstanceId: second.id,
      sdkSessionId: second.sdkSessionId!,
    });
    const requested = events.filter(
      (event) => event.type === "approval.requested",
    );
    expect(requested).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agentInstanceId: first!.id,
          sdkSessionId: first!.sdkSessionId,
        }),
        expect.objectContaining({
          agentInstanceId: second.id,
          sdkSessionId: second.sdkSessionId,
        }),
      ]),
    );

    const firstApproval = requested.find(
      (event) =>
        event.type === "approval.requested" &&
        event.agentInstanceId === first!.id,
    );
    const secondApproval = requested.find(
      (event) =>
        event.type === "approval.requested" &&
        event.agentInstanceId === second.id,
    );
    await service.resolveApproval(
      firstApproval?.type === "approval.requested"
        ? firstApproval.approval.id
        : "",
      "approve",
    );
    await service.resolveApproval(
      secondApproval?.type === "approval.requested"
        ? secondApproval.approval.id
        : "",
      "deny",
    );
    await expect(firstDecision).resolves.toBe(true);
    await expect(secondDecision).resolves.toBe(false);
    await service.stop();
  });

  it("rolls back a failed production-session switch after one target agent resumes", async () => {
    const { service, agent, sessionStore } = await harness();
    await service.start();
    const [previousAgent] = await service.listActiveAgents();
    const previousSessionId = (await service.getSessions())[0]!.id;
    const targetSessionId = await service.createSession();
    const targetSecond = await service.createActiveAgent("default");
    const targetAgents = await service.listActiveAgents();
    await service.resumeSession(previousSessionId);
    const originalResume = agent.resumeManagedAgent.bind(agent);
    agent.resumeManagedAgent = async (configuration, sdkSessionId) => {
      if (configuration.instanceId === targetSecond.id) {
        throw new Error("target resume failed");
      }
      return originalResume(configuration, sdkSessionId);
    };

    await expect(service.resumeSession(targetSessionId)).rejects.toThrow(
      `Could not switch to production session '${targetSessionId}' during resume target agents: target resume failed`,
    );

    expect((await service.listActiveAgents()).map(({ id }) => id)).toEqual([
      previousAgent!.id,
    ]);
    expect(agent.managedConfigurations.has(previousAgent!.id)).toBe(true);
    for (const target of targetAgents) {
      expect(agent.managedConfigurations.has(target.id)).toBe(false);
    }
    expect((await sessionStore.load())[0]?.id).toBe(previousSessionId);
    await service.stop();
  });

  it("denies pending approvals during shutdown", async () => {
    const { service, approvals } = await harness();
    await service.start();
    const decision = approvals.request({
      metadata: {
        name: "ableton_tracks_create",
        title: "Create track",
        risk: "reversible",
        duration: "short",
        mutationTarget: "session",
      },
      arguments: {},
    });

    await service.stop();

    await expect(decision).resolves.toBe(false);
  });

  it("denies pending approvals when the renderer disconnects", async () => {
    const directory = await temporaryDirectory();
    const fake = createFakeApplication();
    const approvals = new ApprovalCoordinator();
    const service = new HeadlessDesktopService({
      application: fake.application,
      approvals,
      preferencesStore: new JsonPreferencesStore(
        join(directory, "preferences.json"),
      ),
      sessionStore: new JsonSessionStore(join(directory, "sessions.json")),
    });
    const unsubscribe = service.subscribe(() => undefined);
    await service.start();
    const decision = approvals.request({
      metadata: {
        name: "ableton_tracks_create",
        title: "Create track",
        risk: "reversible",
        duration: "short",
        mutationTarget: "session",
      },
      arguments: {},
    });

    unsubscribe();

    await expect(decision).resolves.toBe(false);
    await service.stop();
  });

  it("reports unsupported recovery and honest diagnostics", async () => {
    const { service } = await harness();
    await service.start();

    await expect(service.retryOperation("op")).resolves.toBe(false);
    await expect(service.undoOperation("op")).resolves.toBe(false);
    const diagnostics = await service.getDiagnostics();
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "Shared composition",
          status: "pass",
        }),
        expect.objectContaining({ label: "Ableton bridge", status: "pass" }),
        expect.objectContaining({
          label: "Product compatibility",
          status: "pass",
        }),
        expect.objectContaining({
          label: "Operation recovery",
          status: "warn",
        }),
      ]),
    );
    await expect(service.getCapabilities()).resolves.toEqual([
      "session.inspect",
    ]);
    await service.stop();
  });

  it("refuses to invent a snapshot while Ableton is disconnected", async () => {
    const { service, ableton } = await harness();
    await service.start();
    await ableton.stop();

    await expect(service.getSnapshot()).rejects.toThrow("not connected");
    await service.stop();
  });

  it("publishes the core snapshot before device reads finish", async () => {
    const { service, application, events } = await harness();
    await service.start();
    events.length = 0;

    const deviceRead = deferred<void>();
    const order: string[] = [];
    const originalInspectDevices = application.inspectDevices.bind(application);
    vi.spyOn(application, "inspectDevices").mockImplementation(
      async (params) => {
        order.push("device-read");
        await deviceRead.promise;
        return originalInspectDevices(params);
      },
    );
    const unsubscribe = service.subscribe((event) => {
      if (event.type !== "project.snapshot_changed") return;
      order.push(
        event.snapshot.tracks[0]?.devices.length === 0 ? "core" : "enriched",
      );
    });

    let completed = false;
    const refresh = service.getSnapshot().then((snapshot) => {
      completed = true;
      return snapshot;
    });
    await vi.waitFor(() => expect(order).toEqual(["core", "device-read"]));

    expect(completed).toBe(false);
    expect(
      events.filter((event) => event.type === "project.snapshot_changed"),
    ).toHaveLength(1);

    deviceRead.resolve(undefined);
    const finalSnapshot = await refresh;

    expect(finalSnapshot.tracks[0]?.devices).toHaveLength(1);
    expect(order).toEqual(["core", "device-read", "enriched"]);
    unsubscribe();
    await service.stop();
  });

  it("keeps partial snapshots when one track device inspection fails", async () => {
    const { service, application, ableton, events } = await harness();
    await service.start();

    const bass = ableton.state.snapshot.tracks[0]!;
    const bassDevice =
      ableton.state.devicesByTrackReference[bass.reference]![0]!;
    const drumsReference = "55555555-5555-4555-8555-555555555555";
    const drumsDeviceReference = "66666666-6666-4666-8666-666666666666";
    const drumsParameterReference = "77777777-7777-4777-8777-777777777777";
    ableton.state.snapshot = {
      ...ableton.state.snapshot,
      trackCount: 2,
      tracks: [
        bass,
        {
          ...bass,
          index: 1,
          reference: drumsReference,
          name: "Drums",
        },
      ],
    };
    ableton.state.devicesByTrackReference = {
      ...ableton.state.devicesByTrackReference,
      [drumsReference]: [
        {
          summary: {
            ...bassDevice.summary,
            reference: drumsDeviceReference,
            trackReference: drumsReference,
            trackIndex: 1,
            name: "Drum Rack",
          },
          parameters: [
            {
              ...bassDevice.parameters[0]!,
              reference: drumsParameterReference,
              deviceReference: drumsDeviceReference,
              name: "Chain volume",
            },
          ],
        },
      ],
    };

    const originalInspectDevices = application.inspectDevices.bind(application);
    vi.spyOn(application, "inspectDevices").mockImplementation(
      async (params) => {
        if (params.expectedReference === bass.reference) {
          throw new Error(`device read exploded ${"x".repeat(2_000)}`);
        }
        return originalInspectDevices(params);
      },
    );
    events.length = 0;

    const snapshot = await service.getSnapshot();

    expect(snapshot.tracks[0]?.devices).toEqual([]);
    expect(snapshot.tracks[1]?.devices).toEqual([
      expect.objectContaining({
        name: "Drum Rack",
        parameters: [expect.objectContaining({ name: "Chain volume" })],
      }),
    ]);
    const published = events.filter(
      (event) => event.type === "project.snapshot_changed",
    );
    expect(published).toHaveLength(2);
    expect(
      published[0]?.snapshot.tracks.every(
        (track) => track.devices.length === 0,
      ),
    ).toBe(true);
    expect(published[1]?.snapshot).toEqual(snapshot);

    const warnings = events.flatMap((event) =>
      event.type === "diagnostic" &&
      event.level === "warning" &&
      event.message.startsWith("Could not inspect devices")
        ? [event.message]
        : [],
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("track Bass");
    expect(warnings[0]).toContain("device read exploded");
    expect(warnings[0]?.length).toBeLessThanOrEqual(512);
    await service.stop();
  });

  it("retains devices with empty parameters when one parameter read fails", async () => {
    const { service, application, ableton, events } = await harness();
    await service.start();

    const track = ableton.state.snapshot.tracks[0]!;
    const firstDevice =
      ableton.state.devicesByTrackReference[track.reference]![0]!;
    const secondDeviceReference = "88888888-8888-4888-8888-888888888888";
    const secondParameterReference = "99999999-9999-4999-8999-999999999999";
    ableton.state.devicesByTrackReference = {
      ...ableton.state.devicesByTrackReference,
      [track.reference]: [
        firstDevice,
        {
          summary: {
            ...firstDevice.summary,
            reference: secondDeviceReference,
            index: 1,
            name: "Compressor",
            className: "Compressor2",
            classDisplayName: "Compressor",
          },
          parameters: [
            {
              ...firstDevice.parameters[0]!,
              reference: secondParameterReference,
              deviceReference: secondDeviceReference,
              name: "Threshold",
            },
          ],
        },
      ],
    };

    const originalInspectParameters =
      application.inspectDeviceParameters.bind(application);
    vi.spyOn(application, "inspectDeviceParameters").mockImplementation(
      async (params) => {
        if (params.expectedDeviceReference === firstDevice.summary.reference) {
          throw new Error("parameter read exploded");
        }
        return originalInspectParameters(params);
      },
    );
    events.length = 0;

    const snapshot = await service.getSnapshot();

    expect(snapshot.tracks[0]?.devices).toEqual([
      expect.objectContaining({ name: "Wavetable", parameters: [] }),
      expect.objectContaining({
        name: "Compressor",
        parameters: [expect.objectContaining({ name: "Threshold" })],
      }),
    ]);
    const warnings = events.flatMap((event) =>
      event.type === "diagnostic" &&
      event.level === "warning" &&
      event.message.startsWith("Could not inspect parameters")
        ? [event.message]
        : [],
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("device Wavetable");
    expect(warnings[0]).toContain("track Bass");
    expect(warnings[0]).toContain("parameter read exploded");
    await service.stop();
  });

  it("stops optional enrichment after a device inspection times out", async () => {
    const { service, application, ableton } = await harness();
    await service.start();

    const firstTrack = ableton.state.snapshot.tracks[0]!;
    ableton.state.snapshot = {
      ...ableton.state.snapshot,
      trackCount: 2,
      tracks: [
        firstTrack,
        {
          ...firstTrack,
          index: 1,
          reference: "55555555-5555-4555-8555-555555555555",
          name: "Drums",
        },
      ],
    };
    const inspectDevices = vi
      .spyOn(application, "inspectDevices")
      .mockRejectedValueOnce(
        Object.assign(new Error("device inspection timed out"), {
          code: "operation_timeout",
        }),
      );

    const snapshot = await service.getSnapshot();

    expect(snapshot.tracks.every((track) => track.devices.length === 0)).toBe(
      true,
    );
    expect(inspectDevices).toHaveBeenCalledOnce();
    await service.stop();
  });

  it("stops optional enrichment after a parameter inspection times out", async () => {
    const { service, application, ableton } = await harness();
    await service.start();

    const track = ableton.state.snapshot.tracks[0]!;
    const firstDevice =
      ableton.state.devicesByTrackReference[track.reference]![0]!;
    ableton.state.devicesByTrackReference = {
      ...ableton.state.devicesByTrackReference,
      [track.reference]: [
        firstDevice,
        {
          ...firstDevice,
          summary: {
            ...firstDevice.summary,
            reference: "88888888-8888-4888-8888-888888888888",
            index: 1,
            name: "Compressor",
          },
        },
      ],
    };
    const inspectParameters = vi
      .spyOn(application, "inspectDeviceParameters")
      .mockRejectedValueOnce(
        Object.assign(new Error("parameter inspection timed out"), {
          code: "operation_timeout",
        }),
      );

    const snapshot = await service.getSnapshot();

    expect(snapshot.tracks[0]?.devices).toEqual([
      expect.objectContaining({ name: "Wavetable", parameters: [] }),
    ]);
    expect(inspectParameters).toHaveBeenCalledOnce();
    await service.stop();
  });

  it("still rejects snapshot refreshes when core inspection fails", async () => {
    const { service, application, events } = await harness();
    await service.start();
    events.length = 0;
    vi.spyOn(application, "inspectSession").mockRejectedValueOnce(
      new Error("core inspection exploded"),
    );
    const inspectDevices = vi.spyOn(application, "inspectDevices");

    await expect(service.getSnapshot()).rejects.toThrow(
      "core inspection exploded",
    );
    expect(inspectDevices).not.toHaveBeenCalled();
    expect(
      events.some((event) => event.type === "project.snapshot_changed"),
    ).toBe(false);
    await service.stop();
  });

  it("coalesces concurrent snapshot refreshes into one Live read", async () => {
    const { service, application } = await harness();
    await service.start();

    const deviceRead = deferred<void>();
    const originalInspectDevices = application.inspectDevices.bind(application);
    const inspectSession = vi.spyOn(application, "inspectSession");
    const inspectDevices = vi
      .spyOn(application, "inspectDevices")
      .mockImplementation(async (params) => {
        await deviceRead.promise;
        return originalInspectDevices(params);
      });
    const inspectParameters = vi.spyOn(application, "inspectDeviceParameters");

    const first = service.getSnapshot();
    const second = service.getSnapshot();

    expect(second).toBe(first);
    await vi.waitFor(() => {
      expect(inspectSession).toHaveBeenCalledTimes(1);
      expect(inspectDevices).toHaveBeenCalledTimes(1);
    });

    deviceRead.resolve(undefined);
    const [firstSnapshot, secondSnapshot] = await Promise.all([first, second]);

    expect(secondSnapshot).toEqual(firstSnapshot);
    expect(inspectSession).toHaveBeenCalledTimes(1);
    expect(inspectDevices).toHaveBeenCalledTimes(1);
    expect(inspectParameters).toHaveBeenCalledTimes(1);

    await service.getSnapshot();
    expect(inspectSession).toHaveBeenCalledTimes(2);
    expect(inspectDevices).toHaveBeenCalledTimes(2);
    expect(inspectParameters).toHaveBeenCalledTimes(2);
    await service.stop();
  });

  it("interrupts optional enrichment before binding a newly created Live Event", async () => {
    const liveEvents = new FakeLiveEventRuntime();
    const { service, application, events } = await harness({}, { liveEvents });
    await service.start();

    const deviceRead = deferred<void>();
    const deviceReadEntered = deferred<void>();
    const originalInspectDevices = application.inspectDevices.bind(application);
    const inspectSession = vi.spyOn(application, "inspectSession");
    vi.spyOn(application, "inspectDevices").mockImplementation(
      async (params) => {
        deviceReadEntered.resolve(undefined);
        await deviceRead.promise;
        return originalInspectDevices(params);
      },
    );
    const inspectParameters = vi.spyOn(application, "inspectDeviceParameters");
    const configurationCount = liveEvents.configurations.length;
    events.length = 0;

    const refresh = service.getSnapshot();
    await deviceReadEntered.promise;
    const creation = service.createLiveEvent({
      kind: "track.triggered_clip_changed",
      classification: "discrete",
      name: "Keys triggered clip",
      enabled: true,
      target: { track: { name: "Keys", occurrence: 0 } },
    });
    await settle();

    expect(liveEvents.configurations).toHaveLength(configurationCount);
    expect(inspectSession).toHaveBeenCalledOnce();

    deviceRead.resolve(undefined);
    const [snapshot, created] = await Promise.all([refresh, creation]);

    expect(inspectSession).toHaveBeenCalledOnce();
    expect(inspectParameters).not.toHaveBeenCalled();
    expect(snapshot.tracks[0]?.devices).toEqual([]);
    expect(
      liveEvents.configurations.at(-1)?.definitions.map(({ id }) => id),
    ).toContain(created.id);
    expect(
      events.filter((event) => event.type === "project.snapshot_changed"),
    ).toHaveLength(1);
    await service.stop();
  });

  it("defers identity polling while snapshot enrichment is in progress", async () => {
    const { service, application } = await harness(
      {},
      { projectIdentityPollIntervalMs: 5 },
    );
    await service.start();

    const deviceRead = deferred<void>();
    const deviceReadEntered = deferred<void>();
    const originalInspectDevices = application.inspectDevices.bind(application);
    vi.spyOn(application, "inspectDevices").mockImplementation(
      async (params) => {
        deviceReadEntered.resolve();
        await deviceRead.promise;
        return originalInspectDevices(params);
      },
    );
    const getProjectIdentity = vi.spyOn(application, "getProjectIdentity");

    const refresh = service.getSnapshot();
    await deviceReadEntered.promise;
    expect(getProjectIdentity).toHaveBeenCalledOnce();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(getProjectIdentity).toHaveBeenCalledOnce();

    deviceRead.resolve(undefined);
    await refresh;
    await vi.waitFor(() =>
      expect(getProjectIdentity.mock.calls.length).toBeGreaterThan(1),
    );
    await service.stop();
  });

  it("waits for an in-flight identity poll before starting a snapshot", async () => {
    const { service, application } = await harness(
      {},
      { projectIdentityPollIntervalMs: 5 },
    );
    await service.start();

    const identityReadEntered = deferred<void>();
    const releaseIdentityRead = deferred<void>();
    const originalGetProjectIdentity =
      application.getProjectIdentity.bind(application);
    vi.spyOn(application, "getProjectIdentity").mockImplementationOnce(
      async () => {
        identityReadEntered.resolve();
        await releaseIdentityRead.promise;
        return originalGetProjectIdentity();
      },
    );
    const inspectSession = vi.spyOn(application, "inspectSession");

    await identityReadEntered.promise;
    const refresh = service.getSnapshot();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(inspectSession).not.toHaveBeenCalled();

    releaseIdentityRead.resolve();
    await refresh;
    expect(inspectSession).toHaveBeenCalledOnce();
    await service.stop();
  });

  it("backs off identity polling after a failed read", async () => {
    const { service, application } = await harness(
      {},
      { projectIdentityPollIntervalMs: 20 },
    );
    await service.start();

    const getProjectIdentity = vi
      .spyOn(application, "getProjectIdentity")
      .mockRejectedValueOnce(new Error("identity timeout"));
    while (getProjectIdentity.mock.calls.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(getProjectIdentity).toHaveBeenCalledOnce();
    await vi.waitFor(() =>
      expect(getProjectIdentity.mock.calls.length).toBeGreaterThan(1),
    );
    await service.stop();
  });

  it("resumes identity polling after a snapshot fails", async () => {
    const { service, application } = await harness(
      {},
      { projectIdentityPollIntervalMs: 5 },
    );
    await service.start();

    const inspectionEntered = deferred<void>();
    const rejectInspection = deferred<never>();
    vi.spyOn(application, "inspectSession").mockImplementationOnce(() => {
      inspectionEntered.resolve();
      return rejectInspection.promise;
    });
    const getProjectIdentity = vi.spyOn(application, "getProjectIdentity");

    const refresh = service.getSnapshot();
    await inspectionEntered.promise;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(getProjectIdentity).not.toHaveBeenCalled();

    rejectInspection.reject(new Error("snapshot failed"));
    await expect(refresh).rejects.toThrow("snapshot failed");
    await vi.waitFor(() => expect(getProjectIdentity).toHaveBeenCalled());
    await service.stop();
  });

  it("drains an in-flight snapshot and its project sync before final shutdown persistence", async () => {
    const {
      service,
      application,
      ableton,
      events,
      sessionStore,
      preferencesStore,
    } = await harness();
    await service.start();
    events.length = 0;

    if (ableton.state.status.state !== "connected") {
      throw new Error("Expected the fake Ableton service to be connected");
    }
    ableton.state.status = {
      ...ableton.state.status,
      projectId: "shutdown-project",
    };
    ableton.state.projectIdentity = {
      projectId: "shutdown-project",
      projectName: "Shutdown Project",
      saved: true,
    };

    const inspectionEntered = deferred<void>();
    const releaseInspection = deferred<void>();
    const lifecycle: string[] = [];
    const originalInspectSession = application.inspectSession.bind(application);
    const originalSessionSave = sessionStore.save.bind(sessionStore);
    const originalPreferenceSave = preferencesStore.save.bind(preferencesStore);
    const originalStop = application.stop.bind(application);
    vi.spyOn(application, "inspectSession").mockImplementation(async () => {
      inspectionEntered.resolve();
      await releaseInspection.promise;
      const snapshot = await originalInspectSession();
      lifecycle.push("snapshot:complete");
      return snapshot;
    });
    vi.spyOn(sessionStore, "save").mockImplementation(async (sessions) => {
      await originalSessionSave(sessions);
      lifecycle.push("project-sync:saved");
    });
    vi.spyOn(preferencesStore, "save").mockImplementation(
      async (preferences) => {
        await originalPreferenceSave(preferences);
        lifecycle.push("final:persistence");
      },
    );
    application.stop = async () => {
      lifecycle.push("application:stop");
      await originalStop();
    };
    service.subscribe((event) => {
      if (event.type === "project.snapshot_changed") {
        lifecycle.push("snapshot:event");
      }
    });

    const refresh = service.getSnapshot();
    await inspectionEntered.promise;
    let stopped = false;
    const stop = service.stop().then(() => {
      stopped = true;
    });

    await expect(service.getSnapshot()).rejects.toThrow(
      "Desktop service is not accepting actions",
    );
    await settle();
    expect(stopped).toBe(false);
    expect(lifecycle).toEqual([]);

    releaseInspection.resolve();
    await Promise.all([refresh, stop]);

    expect(lifecycle).toEqual([
      "snapshot:complete",
      "snapshot:event",
      "snapshot:event",
      "final:persistence",
      "application:stop",
    ]);
    expect((await sessionStore.load())[0]?.projectId).toBe("project-fake");

    const postStopLifecycle = [...lifecycle];
    const postStopSnapshotEvents = events.filter(
      (event) => event.type === "project.snapshot_changed",
    ).length;
    await expect(service.getSnapshot()).rejects.toThrow(
      "Desktop service is not accepting actions",
    );
    await settle();
    expect(lifecycle).toEqual(postStopLifecycle);
    expect(
      events.filter((event) => event.type === "project.snapshot_changed"),
    ).toHaveLength(postStopSnapshotEvents);
  });

  it("continues shutdown after an in-flight snapshot inspection rejects", async () => {
    const { service, application, events, sessionStore, preferencesStore } =
      await harness();
    await service.start();
    events.length = 0;

    const inspectionEntered = deferred<void>();
    const rejectInspection = deferred<never>();
    const lifecycle: string[] = [];
    const sessionSave = vi.spyOn(sessionStore, "save");
    const originalPreferenceSave = preferencesStore.save.bind(preferencesStore);
    const originalStop = application.stop.bind(application);
    vi.spyOn(application, "inspectSession").mockImplementation(async () => {
      inspectionEntered.resolve();
      return rejectInspection.promise;
    });
    vi.spyOn(preferencesStore, "save").mockImplementation(
      async (preferences) => {
        await originalPreferenceSave(preferences);
        lifecycle.push("final:persistence");
      },
    );
    application.stop = async () => {
      lifecycle.push("application:stop");
      await originalStop();
    };

    const refreshResult = service
      .getSnapshot()
      .catch((error: unknown) => error);
    await inspectionEntered.promise;
    const stop = service.stop();
    rejectInspection.reject(new Error("shutdown inspection exploded"));

    await expect(refreshResult).resolves.toMatchObject({
      message: "shutdown inspection exploded",
    });
    await expect(stop).resolves.toBeUndefined();
    expect(lifecycle).toEqual(["final:persistence", "application:stop"]);
    expect(sessionSave).not.toHaveBeenCalled();
    expect(events).toContainEqual({
      type: "diagnostic",
      level: "error",
      message:
        "Project snapshot could not be read: shutdown inspection exploded",
    });

    const postStopEventCount = events.length;
    await settle();
    expect(events).toHaveLength(postStopEventCount);
    expect(sessionSave).not.toHaveBeenCalled();
  });

  it("pins context into later prompts and persists plans", async () => {
    const { service, agent, events } = await harness();
    await service.start();

    await service.setContext([{ id: "track-1", kind: "track", label: "Bass" }]);
    await service.updatePlan([
      {
        id: "section-1",
        name: "Intro",
        startBar: 1,
        endBar: 8,
        tracks: ["track-1"],
        status: "proposed",
      },
    ]);

    const messages = events
      .filter((event) => event.type === "diagnostic")
      .map((event) => event.message);
    expect(
      messages.some((message) =>
        message.startsWith("Context updated with 1 selection(s)"),
      ),
    ).toBe(true);
    expect(
      messages.some((message) =>
        message.startsWith("Production plan saved with 1 section(s)"),
      ),
    ).toBe(true);

    await service.send("Warm it up", [], "sound");
    await settle();
    expect(agent.prompts[0]).toBe("Warm it up");
    await service.stop();
  });

  it("serializes preference writes and warns about restart-scoped settings", async () => {
    const { service, preferencesStore, events } = await harness();
    await service.start();
    const originalSave = preferencesStore.save.bind(preferencesStore);
    let releaseFirst!: () => void;
    const firstPaused = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const save = vi
      .spyOn(preferencesStore, "save")
      .mockImplementationOnce(async (value) => {
        await firstPaused;
        await originalSave(value);
      })
      .mockImplementation((value) => originalSave(value));

    const first = service.setPreferences(
      preferencesSchema.parse({ loggingLevel: "debug" }),
    );
    const second = service.setPreferences(
      preferencesSchema.parse({
        loggingLevel: "error",
        abletonPort: 9000,
        approvalPolicy: "never",
      }),
    );
    releaseFirst();
    await Promise.all([first, second]);

    expect(save.mock.calls.map(([value]) => value.loggingLevel)).toEqual([
      "debug",
      "error",
    ]);
    expect((await preferencesStore.load()).loggingLevel).toBe("error");
    expect((await service.getPreferences()).loggingLevel).toBe("error");
    expect(
      events.some(
        (event) =>
          event.type === "diagnostic" &&
          event.message.includes("abletonPort") &&
          event.message.includes("next time the app starts"),
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === "diagnostic" &&
          event.message.includes("approvalPolicy") &&
          event.message.includes("next time the app starts"),
      ),
    ).toBe(false);
    await service.stop();
  });

  it("applies approval policy changes immediately without a restart warning", async () => {
    const onApprovalPolicyChange = vi.fn();
    const { service, events } = await harness({}, { onApprovalPolicyChange });
    await service.start();

    await service.setPreferences(
      preferencesSchema.parse({ approvalPolicy: "approve-all" }),
    );

    expect(onApprovalPolicyChange).toHaveBeenCalledWith("approve-all");
    expect(
      events.some(
        (event) =>
          event.type === "diagnostic" &&
          event.message.includes("approvalPolicy") &&
          event.message.includes("next time the app starts"),
      ),
    ).toBe(false);
    await service.stop();
  });

  it.each([
    ["approve-all", "risky"],
    ["risky", "approve-all"],
  ] as const)(
    "serializes deferred approval policy changes from %s to %s",
    async (firstPolicy, secondPolicy) => {
      const onApprovalPolicyChange = vi.fn();
      const { service, preferencesStore } = await harness(
        {},
        { onApprovalPolicyChange },
      );
      await service.start();
      await service.setPreferences(
        preferencesSchema.parse({ approvalPolicy: "always" }),
      );
      onApprovalPolicyChange.mockClear();
      const originalSave = preferencesStore.save.bind(preferencesStore);
      const entered = deferred<void>();
      const release = deferred<void>();
      vi.spyOn(preferencesStore, "save")
        .mockImplementationOnce(async (value) => {
          entered.resolve();
          await release.promise;
          await originalSave(value);
        })
        .mockImplementation((value) => originalSave(value));

      const first = service.setPreferences(
        preferencesSchema.parse({ approvalPolicy: firstPolicy }),
      );
      await entered.promise;
      const second = service.setPreferences(
        preferencesSchema.parse({ approvalPolicy: secondPolicy }),
      );
      release.resolve();
      await Promise.all([first, second]);

      expect(onApprovalPolicyChange.mock.calls).toEqual([
        [firstPolicy],
        [secondPolicy],
      ]);
      expect((await preferencesStore.load()).approvalPolicy).toBe(secondPolicy);
      expect((await service.getPreferences()).approvalPolicy).toBe(
        secondPolicy,
      );
      const callbackCount = onApprovalPolicyChange.mock.calls.length;
      await settle();
      expect(onApprovalPolicyChange).toHaveBeenCalledTimes(callbackCount);
      await service.stop();
    },
  );

  it("waits for queued preference writes before shutdown persistence", async () => {
    const { service, preferencesStore } = await harness();
    await service.start();
    const originalSave = preferencesStore.save.bind(preferencesStore);
    let releaseSave!: () => void;
    const paused = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    vi.spyOn(preferencesStore, "save").mockImplementationOnce(async (value) => {
      await paused;
      await originalSave(value);
    });

    const update = service.setPreferences(
      preferencesSchema.parse({ loggingLevel: "debug" }),
    );
    const stop = service.stop();
    releaseSave();
    await Promise.all([update, stop]);

    expect((await preferencesStore.load()).loggingLevel).toBe("debug");
  });
});
