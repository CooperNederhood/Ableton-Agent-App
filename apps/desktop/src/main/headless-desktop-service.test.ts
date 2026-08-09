import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFakeApplication } from "@ableton-agent/test-support";
import { afterEach, describe, expect, it, vi } from "vitest";

import { preferencesSchema, type DesktopAppEvent } from "../contracts.js";
import { ApprovalCoordinator } from "./approvals.js";
import { JsonPreferencesStore, JsonSessionStore } from "./desktop-service.js";
import { HeadlessDesktopService } from "./headless-desktop-service.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ableton-desktop-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function harness(
  options: Parameters<typeof createFakeApplication>[0] = {},
) {
  const directory = await temporaryDirectory();
  const preferencesStore = new JsonPreferencesStore(
    join(directory, "preferences.json"),
  );
  const sessionStore = new JsonSessionStore(join(directory, "sessions.json"));
  const fake = createFakeApplication(options);
  const approvals = new ApprovalCoordinator();
  const service = new HeadlessDesktopService({
    application: fake.application,
    approvals,
    preferencesStore,
    sessionStore,
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

  it("passes selected context and mode into the shared prompt", async () => {
    const { service, agent } = await harness();
    await service.start();

    await service.send(
      "Make it darker",
      [{ id: "track:1", kind: "track", label: "Bass" }],
      "sound",
    );
    await settle();

    expect(agent.prompts[0]).toContain("Mode: sound");
    expect(agent.prompts[0]).toContain("- track: Bass (track:1)");
    expect(agent.prompts[0]).toContain("Make it darker");
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
      return {
        fake,
        service: new HeadlessDesktopService({
          application: fake.application,
          approvals: new ApprovalCoordinator(),
          preferencesStore: new JsonPreferencesStore(preferencesPath),
          sessionStore: new JsonSessionStore(sessionsPath),
        }),
      };
    };

    const first = build();
    await first.service.start();
    const sessionId = await first.service.createSession();
    expect(first.fake.agent.sessionId).toBe(sessionId);
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
    expect(restarted.fake.agent.sessionId).toBe(sessionId);
    await expect(restarted.service.getSessions()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: sessionId,
          mode: "arrange",
          productionPlan: plan,
        }),
      ]),
    );
    const restoredContext = events.find(
      (event) => event.type === "session.context_restored",
    );
    expect(restoredContext?.type).toBe("session.context_restored");
    if (restoredContext?.type === "session.context_restored") {
      expect(restoredContext.session).toMatchObject({
        id: sessionId,
        mode: "arrange",
        productionPlan: plan,
      });
    }
    await expect(
      restarted.service.resumeSession(sessionId),
    ).resolves.toBeUndefined();
    expect(restarted.fake.agent.sessionId).toBe(sessionId);
    await expect(restarted.service.resumeSession("unknown")).rejects.toThrow(
      "Session not found",
    );
    await restarted.service.stop();
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
    const first = createFakeApplication();
    const firstService = new HeadlessDesktopService({
      application: first.application,
      approvals: new ApprovalCoordinator(),
      preferencesStore: new JsonPreferencesStore(preferencesPath),
      sessionStore: new JsonSessionStore(sessionsPath),
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
    await expect(service.getSessions()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: second.agent.sessionId }),
        expect.objectContaining({ id: staleId }),
      ]),
    );
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

  it("denies pending approvals during shutdown", async () => {
    const { service, approvals } = await harness();
    await service.start();
    const decision = approvals.request({
      metadata: {
        name: "ableton_tracks_create",
        title: "Create track",
        risk: "reversible",
        duration: "short",
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
    expect(agent.prompts[0]).toContain("- track: Bass (track-1)");
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
          event.message.includes("approvalPolicy") &&
          event.message.includes("next time the app starts"),
      ),
    ).toBe(true);
    await service.stop();
  });

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
