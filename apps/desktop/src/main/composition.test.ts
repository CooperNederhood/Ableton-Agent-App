import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LocalObservabilityJournal,
  type AgentHistoryRecord,
  type ConfigurationSnapshot,
  type PublicHistoryQueryResult,
  type SetHistoryRecord,
  type TelemetryEventEnvelope,
} from "@ableton-agent/observability";

import { preferencesSchema, sessionSchema } from "../contracts.js";
import { resolveLiveAgentStorage } from "@ableton-agent/storage";
import * as runtimeModule from "@ableton-agent/runtime";
import { ApprovalCoordinator, ApprovalPolicyController } from "./approvals.js";
import { bridgeTokenKey } from "./bridge-credentials.js";
import {
  createDesktopComposition as composeDesktop,
  DesktopJournalHost,
  resolveDesktopSignalOptions,
} from "./composition.js";
import { installRemoteScript } from "./remote-script-install.js";

const directories: string[] = [];
type OwnedService = Pick<
  Awaited<ReturnType<typeof composeDesktop>>["service"],
  "stop"
>;
const services = new Set<OwnedService>();

async function createDesktopComposition(
  options: Parameters<typeof composeDesktop>[0],
) {
  const composition = await composeDesktop(options);
  const stop = composition.service.stop.bind(composition.service);
  composition.service.stop = async () => {
    await stop();
    services.delete(composition.service);
  };
  services.add(composition.service);
  return composition;
}

async function paths() {
  const root = resolve(".test-artifacts");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "composition-cleanup-fixture-"));
  directories.push(directory);
  return {
    directory,
    preferencesPath: join(directory, "preferences.json"),
    sessionsPath: join(directory, "sessions.json"),
    agentBaseDirectory: join(directory, "copilot"),
    agentsDirectory: join(directory, "agents"),
    skillsDirectory: join(directory, "skills"),
  };
}

async function cleanupFixtures() {
  for (const service of services) {
    await service.stop();
  }
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
}

afterEach(cleanupFixtures);

describe("desktop composition", () => {
  it("preserves fixture files and surfaces an owned shutdown failure", async () => {
    const location = await paths();
    const failure = new Error("fixture shutdown failed");
    const stop = vi.fn().mockRejectedValue(failure);
    const service: OwnedService = {
      stop,
    };
    services.add(service);
    try {
      await expect(cleanupFixtures()).rejects.toBe(failure);
      expect(stop).toHaveBeenCalledOnce();
      await expect(readdir(location.directory)).resolves.toEqual([]);
    } finally {
      services.delete(service);
    }
  });

  it("awaits owned journal shutdown before removing fixture files", async () => {
    const location = await paths();
    const open = LocalObservabilityJournal.open.bind(LocalObservabilityJournal);
    let journal: LocalObservabilityJournal | undefined;
    const capture = vi
      .spyOn(LocalObservabilityJournal, "open")
      .mockImplementation(async (options) => {
        journal = await open(options);
        return journal;
      });
    const releaseShutdown = deferred<void>();
    const shutdownEntered = deferred<void>();
    let cleanup: Promise<void> | undefined;
    let service:
      Awaited<ReturnType<typeof composeDesktop>>["service"] | undefined;
    try {
      ({ service } = await createDesktopComposition({
        ...location,
        environment: {},
      }));
      if (journal === undefined)
        throw new Error("Fixture journal was not opened");
      const ownedJournal = journal;
      const shutdown = ownedJournal.shutdown.bind(ownedJournal);
      vi.spyOn(ownedJournal, "shutdown").mockImplementation(async () => {
        shutdownEntered.resolve(undefined);
        await releaseShutdown.promise;
        await shutdown();
      });

      cleanup = cleanupFixtures();
      expect(
        await Promise.race([
          shutdownEntered.promise.then(() => "shutdown"),
          cleanup.then(() => "removed"),
        ]),
      ).toBe("shutdown");
      expect(ownedJournal.isOpen).toBe(true);
      await expect(readdir(location.directory)).resolves.toContain(
        "agent-set-event-history.sqlite",
      );
      releaseShutdown.resolve(undefined);
      await cleanup;
      expect(ownedJournal.isOpen).toBe(false);
      await expect(readdir(location.directory)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      releaseShutdown.resolve(undefined);
      await cleanup;
      if (journal?.isOpen) {
        await service?.stop();
        await rm(location.directory, { recursive: true, force: true });
      }
      capture.mockRestore();
    }
  });

  it("loads the persisted listening policy into the runtime provider before any pass", async () => {
    const location = await paths();
    await writeFile(
      location.preferencesPath,
      JSON.stringify(
        preferencesSchema.parse({
          listening: { mode: "descriptive", maxClockDisagreementSamples: 128 },
        }),
      ),
    );
    const storage = resolveLiveAgentStorage({
      environment: {
        LIVE_AGENT_HOME: join(location.directory, "owned-storage"),
      },
    });
    const factory = vi.spyOn(runtimeModule, "createListeningRuntimeHost");
    let composition:
      Awaited<ReturnType<typeof createDesktopComposition>> | undefined;
    try {
      composition = await createDesktopComposition({
        ...location,
        storage,
        environment: {},
      });
      const policy = factory.mock.calls[0]?.[1].resolveTimingPolicy?.();
      expect(policy).toEqual({
        mode: "descriptive",
        maxClockDisagreementSamples: 128,
      });
      expect(Object.isFrozen(policy)).toBe(true);
    } finally {
      await composition?.service.stop();
      factory.mockRestore();
    }
  });

  it("composes listening with the existing runtime and resolves the invoking owner", async () => {
    const location = await paths();
    const storage = resolveLiveAgentStorage({
      environment: {
        LIVE_AGENT_HOME: join(location.directory, "owned-storage"),
        LIVE_AGENT_PROFILE: "listening-composition",
      },
    });
    const createHost = runtimeModule.createListeningRuntimeHost;
    const created: {
      host?: ReturnType<typeof createHost>;
    } = {};
    const factory = vi
      .spyOn(runtimeModule, "createListeningRuntimeHost")
      .mockImplementation((dependencies, options) => {
        const host = createHost(dependencies, options);
        created.host = host;
        return host;
      });
    let composition:
      Awaited<ReturnType<typeof createDesktopComposition>> | undefined;
    try {
      composition = await createDesktopComposition({
        ...location,
        agentsDirectory: resolve("agents"),
        skillsDirectory: resolve("skills"),
        environment: {},
        storage,
      });
      expect(factory).toHaveBeenCalledOnce();
      const invocation = factory.mock.calls[0];
      expect(invocation?.[0].signals).toBe(composition.runtime.signals);
      const resolvePolicy = invocation?.[1].resolveTimingPolicy;
      expect(resolvePolicy).toBeTypeOf("function");
      const startingPolicy = resolvePolicy?.();
      expect(startingPolicy).toEqual({
        mode: "descriptive",
        maxClockDisagreementSamples: 64,
      });
      expect(Object.isFrozen(startingPolicy)).toBe(true);
      await composition.service.start();
      await composition.service.setPreferences(
        preferencesSchema.parse({
          listening: { mode: "strict", maxClockDisagreementSamples: 0 },
        }),
      );
      expect(resolvePolicy?.()).toEqual({
        mode: "strict",
        maxClockDisagreementSamples: 0,
      });
      expect(startingPolicy).toEqual({
        mode: "descriptive",
        maxClockDisagreementSamples: 64,
      });
      const host = created.host;
      if (host === undefined)
        throw new Error("Listening factory did not return a host");
      expect(host.waitForListeningPass).toBeTypeOf("function");
      expect(host.executeContextOperation).toBeTypeOf("function");
      expect(host.getSessionContextInventory).toBeTypeOf("function");
      const context = {
        sessionId: "invoking-session-not-selected",
        agentId: "invoking-agent",
        trace: {
          traceId: "00000000-0000-4000-8000-000000000001",
          correlationId: "00000000-0000-4000-8000-000000000002",
          causationId: "00000000-0000-4000-8000-000000000003",
        },
      };
      const ownership = vi
        .spyOn(composition.service, "getSessionForContext")
        .mockResolvedValue(
          sessionSchema.parse({
            version: 4,
            id: context.sessionId,
            title: "Invoking session",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            liveSetId: "invoking-live-set",
            liveSetName: "Invoking Set",
          }),
        );
      await expect(
        host.executeListeningOperation(
          { action: "inspect-listeners" },
          context,
        ),
      ).rejects.toMatchObject({
        code: "listener_ingress_unavailable",
      });
      ownership.mockResolvedValue(undefined);
      await expect(
        host.executeListeningOperation(
          {
            action: "play-arrangement-and-listen",
            listenerIds: ["uncommissioned-listener"],
            startBeat: 0,
            endBeat: 4,
            maximumDurationMs: 300_000,
          },
          context,
        ),
      ).rejects.toThrow(
        "No App session belongs to the invoking listening owner",
      );
      expect(ownership).toHaveBeenCalledWith(context.sessionId);
      const lifecycle = vi
        .spyOn(composition.service, "reportListeningJob")
        .mockImplementation(() => {});
      const now = new Date().toISOString();
      const job = {
        passId: "00000000-0000-4000-8000-000000000004",
        owner: {
          sessionId: context.sessionId,
          liveSetId: "invoking-live-set",
          agentId: context.agentId,
        },
        trace: context.trace,
        stage: "failed" as const,
        createdAt: now,
        updatedAt: now,
        durationMs: 10,
        contextIds: [],
        cleanupPolicy: "leave-running" as const,
        error: "Synthetic callback fixture; native timing remains unverified",
      };
      expect(invocation?.[1].onChange).toBeTypeOf("function");
      invocation?.[1].onChange?.(job);
      expect(lifecycle).toHaveBeenCalledWith(job);
      const shutdown = vi.spyOn(host, "shutdown");
      await composition.service.stop();
      composition = undefined;
      expect(shutdown).toHaveBeenCalled();
    } finally {
      await composition?.service.stop();
      factory.mockRestore();
    }
  });

  it("does not construct listening without canonical session storage", async () => {
    const location = await paths();
    const factory = vi.spyOn(runtimeModule, "createListeningRuntimeHost");
    try {
      const composition = await createDesktopComposition({
        ...location,
        environment: {},
      });
      try {
        expect(factory).not.toHaveBeenCalled();
      } finally {
        await composition.service.stop();
      }
    } finally {
      factory.mockRestore();
    }
  });

  it("uses canonical profile discovery and credential references without implicit legacy publication", () => {
    const storage = resolveLiveAgentStorage({
      environment: {
        LIVE_AGENT_HOME: "/tmp/owned-signal-profile",
        LIVE_AGENT_PROFILE: "automation",
      },
    });
    expect(resolveDesktopSignalOptions({ storage }, 9001)).toEqual({
      port: 9001,
      descriptorPath: storage.signalIngressDescriptorPath,
      secretPath: storage.signalIngressSecretPath,
    });
    expect(
      resolveDesktopSignalOptions(
        {
          storage,
          legacySignalDescriptorPath: "/tmp/owned-legacy/descriptor.json",
        },
        9001,
      ),
    ).toMatchObject({
      legacyDescriptorPath: "/tmp/owned-legacy/descriptor.json",
      secretPath: storage.signalIngressSecretPath,
    });
    expect(
      resolveDesktopSignalOptions(
        {
          storage,
          legacySignalDescriptorPath: storage.legacySignalIngressDescriptorPath,
        },
        9001,
      ),
    ).toEqual({
      port: 9001,
      descriptorPath: storage.signalIngressDescriptorPath,
      secretPath: storage.signalIngressSecretPath,
      legacyDescriptorPath: storage.legacySignalIngressDescriptorPath,
    });
  });

  it("preserves explicit discovery overrides and does not invent paths without storage", () => {
    const storage = resolveLiveAgentStorage({
      environment: { LIVE_AGENT_HOME: "/tmp/owned-signal-profile" },
    });
    expect(
      resolveDesktopSignalOptions(
        {
          storage,
          signalDescriptorPath: "/tmp/endpoint.json",
          signalSecretPath: "/tmp/credential",
        },
        9001,
      ),
    ).toEqual({
      port: 9001,
      descriptorPath: "/tmp/endpoint.json",
      secretPath: "/tmp/credential",
    });
    expect(resolveDesktopSignalOptions({}, 9001)).toEqual({ port: 9001 });
  });

  it("replays bootstrap storage migration lifecycle into local history", async () => {
    const location = await paths();
    const traceId = "00000000-0000-4000-8000-000000000001";
    const { service } = await createDesktopComposition({
      ...location,
      environment: {},
      storageMigrationEvents: [
        {
          id: "00000000-0000-4000-8000-000000000002",
          name: "storage.migration.completed",
          occurredAt: new Date().toISOString(),
          durationMs: 12,
          outcome: "success",
          traceId,
          spanId: "00000000-0000-4000-8000-000000000003",
          correlationId: "00000000-0000-4000-8000-000000000004",
          attributes: { profile: "development", migratedCount: 4 },
        },
      ],
    });

    await vi.waitFor(async () => {
      expect((await service.getEventTrace(traceId)).items).toHaveLength(1);
    });
    const history = await service.getEventTrace(traceId);

    expect(history.items).toEqual([
      expect.objectContaining({
        name: "storage.migration.completed",
        category: "storage",
        source: "desktop-storage",
        outcome: "success",
        durationMs: 12,
      }),
    ]);
    await service.stop();
  });

  it("degrades safely and preserves a corrupt journal file", async () => {
    const location = await paths();
    const journalPath = join(
      location.directory,
      "agent-set-event-history.sqlite",
    );
    const corruptBytes = "not a sqlite database";
    await writeFile(journalPath, corruptBytes, "utf8");

    const { preferences, service } = await createDesktopComposition({
      ...location,
      environment: {},
    });

    expect(preferences.eventHistoryEnabled).toBe(false);
    await expect(readFile(journalPath, "utf8")).resolves.toBe(corruptBytes);
    const journalDiagnostic = (await service.getDiagnostics()).find(
      ({ label, status }) => label === "Event journal" && status === "fail",
    );
    expect(journalDiagnostic?.detail).toContain("disabled");
    await expect(service.getEventJournalHealth()).rejects.toThrow(
      "unavailable",
    );
  });

  it("degrades safely when another process holds the journal lock", async () => {
    const location = await paths();
    const journalPath = join(
      location.directory,
      "agent-set-event-history.sqlite",
    );
    const blocker = await LocalObservabilityJournal.open({ path: journalPath });
    try {
      const { preferences, service } = await createDesktopComposition({
        ...location,
        environment: {},
      });

      expect(preferences.eventHistoryEnabled).toBe(false);
      await expect(service.getDiagnostics()).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ label: "Event journal", status: "fail" }),
        ]),
      );
    } finally {
      await blocker.shutdown();
    }
  });

  it("buffers writes during retention swaps and drains them to the new journal", async () => {
    const first = fakeJournal();
    const second = fakeJournal();
    const releaseShutdown = deferred<void>();
    first.shutdown.mockImplementation(async () => {
      await releaseShutdown.promise;
      first.closed = true;
    });

    const open = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const host = await DesktopJournalHost.create({
      path: "journal.sqlite",
      retention: { maxAgeDays: 30, maxBytes: 1_000 },
      enabled: true,
      open: open as never,
    });
    const event = telemetryEvent("00000000-0000-4000-8000-000000000001");

    const swap = host.reconfigure({ maxAgeDays: 7, maxBytes: 2_000 });
    await Promise.resolve();
    void host.enqueue(event);
    expect(first.enqueue).not.toHaveBeenCalled();
    releaseShutdown.resolve(undefined);

    await expect(swap).resolves.toBeUndefined();
    expect(second.enqueue).toHaveBeenCalledWith(event);
    expect(first.enqueue).not.toHaveBeenCalled();
    await host.shutdown();
    expect(first.shutdown).toHaveBeenCalledOnce();
    expect(second.shutdown).toHaveBeenCalledOnce();
  });

  it("keeps agent and Set history active when detailed App events are disabled", async () => {
    const journal = fakeJournal();
    const host = await DesktopJournalHost.create({
      path: "journal.sqlite",
      retention: { maxAgeDays: 30, maxBytes: 1_000 },
      enabled: false,
      open: vi.fn().mockResolvedValue(journal) as never,
    });
    const occurredAt = "2026-01-01T00:00:00.000Z";
    const agentRecord: AgentHistoryRecord = {
      version: 1,
      id: "agent-history-record",
      kind: "agent_session",
      appSessionId: "app-session",
      agentSessionId: "sdk-session",
      activeAgentId: "agent-instance",
      occurredAt,
      status: "active",
      metadata: {},
    };
    const setRecord: SetHistoryRecord = {
      version: 1,
      id: "set-history-record",
      kind: "set_save",
      appSessionId: "app-session",
      liveSetId: "live-set",
      occurredAt,
      trigger: "live",
      outcome: "success",
      details: {},
    };
    const queryResult: PublicHistoryQueryResult = {
      version: 1,
      schemaVersion: 4,
      columns: ["record_id"],
      rows: [{ record_id: "set-history-record" }],
      rowCount: 1,
      truncated: false,
      elapsedMs: 1,
    };
    journal.queryPublicHistory.mockResolvedValue(queryResult);

    await host.enqueue(telemetryEvent("00000000-0000-4000-8000-000000000010"));
    await host.appendAgentHistory(agentRecord);
    await host.appendSetHistory(setRecord);
    await expect(
      host.queryPublicHistory(
        "SELECT record_id FROM set_history_saves LIMIT 1",
        [],
        1,
      ),
    ).resolves.toEqual(queryResult);

    expect(journal.enqueue).not.toHaveBeenCalled();
    expect(journal.appendAgentHistory).toHaveBeenCalledWith(agentRecord);
    expect(journal.appendSetHistory).toHaveBeenCalledWith(setRecord);
    expect(journal.queryPublicHistory).toHaveBeenCalledWith(
      "SELECT record_id FROM set_history_saves LIMIT 1",
      [],
      1,
      undefined,
    );
    await host.shutdown();
  });

  it("rolls retention swaps back and drains buffered writes without loss", async () => {
    const first = fakeJournal();
    const rollback = fakeJournal();
    const failedOpen = deferred<LocalObservabilityJournal>();
    const open = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockImplementationOnce(() => failedOpen.promise)
      .mockResolvedValueOnce(rollback);
    const host = await DesktopJournalHost.create({
      path: "journal.sqlite",
      retention: { maxAgeDays: 30, maxBytes: 1_000 },
      enabled: true,
      open: open as never,
    });
    const snapshot = configurationSnapshot(
      "00000000-0000-4000-8000-000000000002",
    );

    const swap = host.reconfigure({ maxAgeDays: 1, maxBytes: 500 });
    await Promise.resolve();
    void host.enqueueConfigurationSnapshot(snapshot);
    failedOpen.reject(new Error("replacement denied"));

    await expect(swap).rejects.toThrow("replacement denied");
    expect(host.journal).toBe(rollback);
    expect(rollback.enqueueConfigurationSnapshot).toHaveBeenCalledWith(
      snapshot,
    );
    expect(first.enqueueConfigurationSnapshot).not.toHaveBeenCalled();
    const roots = {
      version: 2 as const,
      items: [],
      page: {
        limit: 10,
        returnedItems: 0,
        totalItems: 0,
        hasMore: false,
        order: "desc" as const,
      },
    };
    rollback.readRootTraces.mockResolvedValue(roots);
    await expect(
      host.readRootTraces({ limit: 10, order: "desc" }),
    ).resolves.toEqual(roots);
    expect(rollback.readRootTraces).toHaveBeenCalledWith({
      limit: 10,
      order: "desc",
    });

    await host.shutdown();
    expect(first.shutdown).toHaveBeenCalledOnce();
    expect(rollback.shutdown).toHaveBeenCalledOnce();
  });

  it("recovers a usable host when the previous journal shutdown fails", async () => {
    const first = fakeJournal();
    const recovered = fakeJournal();
    const failedShutdown = deferred<void>();
    first.shutdown.mockImplementationOnce(async () => {
      try {
        await failedShutdown.promise;
      } finally {
        first.closed = true;
      }
    });
    const open = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(recovered);
    const host = await DesktopJournalHost.create({
      path: "journal.sqlite",
      retention: { maxAgeDays: 30, maxBytes: 1_000 },
      enabled: true,
      open: open as never,
    });
    const buffered = telemetryEvent("00000000-0000-4000-8000-000000000003");

    const transition = host.reconfigure({ maxAgeDays: 7, maxBytes: 500 });
    await Promise.resolve();
    await expect(host.enqueue(buffered)).resolves.toBeUndefined();
    expect(first.enqueue).not.toHaveBeenCalled();
    failedShutdown.reject(new Error("shutdown interrupted"));
    await expect(transition).rejects.toThrow("shutdown interrupted");
    expect(host.journal).toBe(recovered);
    expect(recovered.enqueue).toHaveBeenCalledWith(buffered);
    expect(first.enqueue).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledTimes(2);

    await expect(host.shutdown()).resolves.toBeUndefined();
    expect(first.shutdown).toHaveBeenCalledOnce();
    expect(recovered.shutdown).toHaveBeenCalledOnce();
  });

  it("keeps the local journal in the main-process composition", async () => {
    const location = await paths();
    const { service } = await createDesktopComposition({
      ...location,
      environment: {},
    });

    await expect(service.getEventJournalHealth()).resolves.toMatchObject({
      status: "healthy",
      retention: {
        maxAgeDays: 30,
        maxBytes: 250 * 1024 * 1024,
      },
    });
    await expect(service.getDiagnostics()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Event journal", status: "pass" }),
      ]),
    );
  });

  it("configures the bridge from preferences and the stored token", async () => {
    const location = await paths();
    await writeFile(
      location.preferencesPath,
      JSON.stringify(preferencesSchema.parse({ abletonPort: 9123 })),
      "utf8",
    );

    const { runtime, preferences } = await createDesktopComposition({
      ...location,
      storedToken: "b".repeat(32),
      environment: {},
    });

    expect(preferences.abletonPort).toBe(9123);
    expect(runtime.abletonConfigured).toBe(true);
    await expect(runtime.ableton.getStatus()).resolves.toEqual({
      state: "disconnected",
    });
  });

  it("regresses fresh install startup without a vault or environment token", async () => {
    const location = await paths();
    const source = join(location.directory, "remote-script-source");
    const userLibrary = join(location.directory, "User Library");
    const remoteScriptsPath = join(userLibrary, "Remote Scripts");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "__init__.py"), "# remote script\n", "utf8");
    const installation = await installRemoteScript({
      sourcePath: source,
      remoteScriptsPath,
      version: "1.0.0",
    });
    const installedToken = await readFile(
      join(installation.destination, ".ableton-agent-token"),
      "utf8",
    );
    await writeFile(
      location.preferencesPath,
      JSON.stringify(
        preferencesSchema.parse({ remoteScriptLocation: userLibrary }),
      ),
      "utf8",
    );
    const vault = new Map<string, string>();

    const { runtime, service, bridgeToken } = await createDesktopComposition({
      ...location,
      agentsDirectory: resolve("agents"),
      skillsDirectory: resolve("skills"),
      environment: {},
      platform: "darwin",
      credentialVault: {
        get: async (key) => vault.get(key),
        set: async (key, value) => {
          vault.set(key, value);
        },
      },
    });

    expect(runtime.abletonConfigured).toBe(true);
    expect(bridgeToken).toBe(installedToken);
    expect(vault.get(bridgeTokenKey)).toBe(installedToken);
    expect(
      (await service.getDiagnostics()).filter(
        ({ label, status }) =>
          label === "Bridge credentials" && status !== "pass",
      ),
    ).toEqual([]);
    const provisioned = (await service.getDiagnostics()).find(
      ({ label }) => label === "Bridge credentials",
    );
    expect(provisioned?.status).toBe("pass");
    expect(provisioned?.detail).toContain("discovered and stored");
    expect(JSON.stringify(await service.getDiagnostics())).not.toContain(
      installedToken,
    );
    await service.stop();
  });

  function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    return { promise, resolve, reject };
  }

  function fakeJournal() {
    return {
      closed: false,
      get isOpen() {
        return !this.closed;
      },
      enqueue: vi.fn(async function (this: { closed: boolean }) {
        if (this.closed) throw new Error("closed journal");
      }),
      enqueueConfigurationSnapshot: vi.fn(async function (this: {
        closed: boolean;
      }) {
        if (this.closed) throw new Error("closed journal");
      }),
      appendAgentHistory: vi.fn(async function (this: { closed: boolean }) {
        if (this.closed) throw new Error("closed journal");
      }),
      appendSetHistory: vi.fn(async function (this: { closed: boolean }) {
        if (this.closed) throw new Error("closed journal");
      }),
      queryPublicHistory: vi.fn(),
      shutdown: vi.fn(async function (this: { closed: boolean }) {
        this.closed = true;
      }),
      readRootTraces: vi.fn(),
      readTrace: vi.fn(),
      readConfigurationSnapshots: vi.fn(),
      getHealth: vi.fn(),
      runRetention: vi.fn(),
      deleteTrace: vi.fn(),
      clear: vi.fn(),
    };
  }

  function telemetryEvent(id: string): TelemetryEventEnvelope {
    return {
      version: 2,
      id,
      occurredAt: "2026-01-01T00:00:00.000Z",
      name: "agent.turn",
      source: "desktop",
      level: "info",
      attributes: {},
    };
  }

  function configurationSnapshot(id: string): ConfigurationSnapshot {
    return {
      version: 2,
      id,
      capturedAt: "2026-01-01T00:00:00.000Z",
      component: "desktop",
      configurationVersion: "1",
      values: {},
    };
  }

  it("falls back to the environment token", async () => {
    const location = await paths();

    const { runtime } = await createDesktopComposition({
      ...location,
      environment: { ABLETON_AGENT_TOKEN: "c".repeat(32) },
    });

    expect(runtime.abletonConfigured).toBe(true);
  });

  it("reports a missing token instead of faking a connection", async () => {
    const location = await paths();

    const { runtime, service } = await createDesktopComposition({
      ...location,
      environment: {},
    });

    expect(runtime.abletonConfigured).toBe(false);
    await expect(runtime.ableton.getStatus()).resolves.toMatchObject({
      state: "error",
      code: "configuration_missing",
    });
    await expect(service.getDiagnostics()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "Bridge credentials",
          status: "warn",
        }),
      ]),
    );
  });

  it("keeps starting when a token is unusable and says why", async () => {
    const location = await paths();

    const { runtime, service } = await createDesktopComposition({
      ...location,
      storedToken: "too-short",
      environment: {},
    });

    expect(runtime.abletonConfigured).toBe(false);
    await expect(service.getDiagnostics()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "Bridge credentials",
          status: "fail",
        }),
      ]),
    );
  });

  it("uses defaults and warns when stored preferences are unreadable", async () => {
    const location = await paths();
    await writeFile(location.preferencesPath, "{not-json", "utf8");

    const { preferences, service } = await createDesktopComposition({
      ...location,
      environment: {},
    });

    expect(preferences).toEqual(preferencesSchema.parse({}));
    await expect(service.getDiagnostics()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Preferences", status: "warn" }),
      ]),
    );
  });

  it("applies the saved active-work timeout to subsequent agent turns", async () => {
    const location = await paths();
    const { runtime, service } = await createDesktopComposition({
      ...location,
      agentsDirectory: resolve("agents"),
      skillsDirectory: resolve("skills"),
      environment: {},
    });
    const timeoutProvider = (
      runtime.agent as unknown as {
        options: { turnTimeoutMs: () => number };
      }
    ).options.turnTimeoutMs;

    expect(timeoutProvider()).toBe(600_000);
    await service.start();
    await service.setPreferences(
      preferencesSchema.parse({ agentTurnTimeoutMinutes: 25 }),
    );
    expect(timeoutProvider()).toBe(1_500_000);
    await service.stop();
  });

  it("provides the saved reasoning visibility to subsequent SDK turns", async () => {
    const location = await paths();
    const { runtime, service } = await createDesktopComposition({
      ...location,
      agentsDirectory: resolve("agents"),
      skillsDirectory: resolve("skills"),
      environment: {},
    });
    const reasoningSummaryProvider = (
      runtime.agent as unknown as {
        options: { reasoningSummary: () => string };
      }
    ).options.reasoningSummary;

    expect(reasoningSummaryProvider()).toBe("concise");
    await service.start();
    await service.setPreferences(
      preferencesSchema.parse({ agentReasoningVisibility: "detailed" }),
    );
    expect(reasoningSummaryProvider()).toBe("detailed");
    await service.stop();
  });

  it("wires effective active-agent YOLO IDs into the approval policy", async () => {
    const location = await paths();
    const publish = vi.spyOn(
      ApprovalPolicyController.prototype,
      "setAutoApprovedAgentInstanceIds",
    );
    const approvePending = vi.spyOn(
      ApprovalCoordinator.prototype,
      "approveForAgentInstanceIds",
    );
    const { service } = await createDesktopComposition({
      ...location,
      environment: {},
    });

    const callback = (
      service as unknown as {
        options: {
          onAutoApprovedAgentIdsChange: (ids: ReadonlySet<string>) => void;
        };
      }
    ).options.onAutoApprovedAgentIdsChange;
    const ids = new Set(["00000000-0000-4000-8000-000000000001"]);
    callback(ids);
    callback(new Set());

    expect(publish).toHaveBeenCalledWith(ids);
    expect(publish).toHaveBeenLastCalledWith(new Set());
    expect(approvePending).toHaveBeenCalledWith(ids);
    expect(approvePending).toHaveBeenCalledTimes(1);
    publish.mockRestore();
    approvePending.mockRestore();
  });
});
