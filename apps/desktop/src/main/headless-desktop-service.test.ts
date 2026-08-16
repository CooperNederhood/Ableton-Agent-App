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

import { preferencesSchema, type DesktopAppEvent } from "../contracts.js";
import { ApprovalCoordinator } from "./approvals.js";
import { JsonPreferencesStore, JsonSessionStore } from "./desktop-service.js";
import { HeadlessDesktopService } from "./headless-desktop-service.js";

const temporaryDirectories: string[] = [];

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
  } = {},
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
    ...serviceOptions,
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
    });
    await service.start();
    const firstSession = fake.agent.sessionId!;
    const assignment = await service.assignOutput("producer-1");
    expect(assignment).toMatchObject({
      enabled: true,
      deliveryMode: "next-prompt",
      processingPolicyIds: ["latest-window"],
    });
    expect(signals.assignments.get(assignment.assignmentId)?.consumer).toEqual({
      kind: "agent-session",
      id: firstSession,
    });

    const secondSession = await service.createSession();
    expect(signals.activeSessionId).toBe(secondSession);
    expect(signals.assignments.size).toBe(0);
    await service.resumeSession(firstSession);
    expect(signals.assignments.get(assignment.assignmentId)?.consumer).toEqual({
      kind: "agent-session",
      id: firstSession,
    });
    expect(
      (await sessionStore.load()).find(({ id }) => id === firstSession)
        ?.outputAssignments,
    ).toContainEqual(assignment);
    await service.stop();
    expect(signals.lifecycle).toEqual(["signals:start", "signals:stop"]);
  });

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
