import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFakeApplication } from "@ableton-agent/test-support";
import type { SignalRuntime, SignalRuntimeEvent } from "@ableton-agent/runtime";
import type {
  OutputAssignment,
  OutputConnection,
} from "@ableton-agent/signal-routing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { abletonToolMetadata } from "@ableton-agent/tools";

import {
  desktopAgentCatalogSchema,
  preferencesSchema,
  type DesktopAppEvent,
  type DesktopActiveAgent,
  type DesktopAgentCatalog,
  type DesktopSession,
} from "../contracts.js";
import { ApprovalCoordinator, ApprovalPolicyController } from "./approvals.js";
import { JsonPreferencesStore, JsonSessionStore } from "./desktop-service.js";
import { HeadlessDesktopService } from "./headless-desktop-service.js";

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
      skillsDirectory?: string;
      refresh: () => Promise<DesktopAgentCatalog>;
    };
    signals?: SignalRuntime;
    onAutoApprovedAgentIdsChange?: (
      agentInstanceIds: ReadonlySet<string>,
    ) => void;
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
  const { agentCatalog, ...remainingServiceOptions } = serviceOptions;
  const service = new HeadlessDesktopService({
    application: fake.application,
    approvals,
    preferencesStore,
    sessionStore,
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
        version: 2,
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
      modified: false,
    };
    const sessions = [
      {
        version: 2 as const,
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
      },
    ];

    await store.save(sessions);

    await expect(store.load()).resolves.toEqual(sessions);
    expect(await readdir(directory)).toEqual(["sessions.json"]);
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
    const preferences = preferencesSchema.parse({ model: "gpt-5.6" });

    await store.save(preferences);

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(preferences);
    expect(await readdir(directory)).toEqual(["preferences.json"]);
  });
});

describe("desktop adapter over the shared application", () => {
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
    ).rejects.toThrow("not configured");
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
      let policy!: ApprovalPolicyController;
      const published: string[][] = [];
      const { service, approvals, sessionStore, preferencesStore, events } =
        await harness(
          {},
          {
            onAutoApprovedAgentIdsChange: (ids) => {
              published.push([...ids].sort());
              policy?.setAutoApprovedAgentInstanceIds(ids);
            },
          },
        );
      policy = new ApprovalPolicyController("risky", approvals);
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
        ableton.state.status = {
          ...ableton.state.status,
          projectId: "ordered-project",
        };
        await service.getSnapshot();
      },
      isMutationApplied: (session) => session.projectId === "ordered-project",
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

  it("passes the canonical catalog skills directory to skill-enabled managed agents", async () => {
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
          skillsDirectory: "/canonical/desktop/skills",
          refresh: () => Promise.resolve(catalog),
        },
      },
    );

    await service.start();

    const [active] = await service.listActiveAgents();
    expect(agent.managedConfigurations.get(active!.id)).toMatchObject({
      skills: ["analyze"],
      skillDirectories: ["/canonical/desktop/skills"],
      availableSkills: ["analyze"],
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

    await service.start();

    expect(agent.started).toBe(true);
    expect(ableton.started).toBe(true);
    expect(await service.getLifecycleState()).toBe("ready");
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

  it("records a new session when a stored one cannot be resumed", async () => {
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

    expect(second.agent.sessionId).not.toBe(staleId);
    expect(
      events.some(
        (event) =>
          event.type === "diagnostic" &&
          event.message.includes("could not be resumed"),
      ),
    ).toBe(true);
    const sessions = await service.getSessions();
    expect(
      sessions.some(({ activeAgents }) =>
        activeAgents.some(
          ({ sdkSessionId }) => sdkSessionId === second.agent.sessionId,
        ),
      ),
    ).toBe(true);
    expect(sessions.some(({ id }) => id === staleId)).toBe(true);
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
      "project-sync:saved",
      "snapshot:event",
      "snapshot:event",
      "final:persistence",
      "application:stop",
    ]);
    expect((await sessionStore.load())[0]?.projectId).toBe("shutdown-project");

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
      preferencesSchema.parse({ model: "first" }),
    );
    const second = service.setPreferences(
      preferencesSchema.parse({
        model: "second",
        abletonPort: 9000,
        approvalPolicy: "never",
      }),
    );
    releaseFirst();
    await Promise.all([first, second]);

    expect(save.mock.calls.map(([value]) => value.model)).toEqual([
      "first",
      "second",
    ]);
    expect((await preferencesStore.load()).model).toBe("second");
    expect((await service.getPreferences()).model).toBe("second");
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
      preferencesSchema.parse({ model: "latest" }),
    );
    const stop = service.stop();
    releaseSave();
    await Promise.all([update, stop]);

    expect((await preferencesStore.load()).model).toBe("latest");
  });
});
