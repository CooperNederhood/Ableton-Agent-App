import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSessionContextHost,
  type ListeningExecutionContext,
} from "@ableton-agent/application";
import {
  SESSION_CONTEXT_STORE_REFERENCE,
  type AppendContextPass,
  type SessionContextPublicationRequest,
} from "@ableton-agent/project-state";
import {
  telemetryEventEnvelopeSchema,
  type TelemetryEventEnvelope,
} from "@ableton-agent/observability";
import {
  resolveLiveAgentStorage,
  resolveNestedSessionStorage,
} from "@ableton-agent/storage";
import { sessionSchema, type DesktopSession } from "../contracts.js";
import { JsonSessionStore } from "./desktop-service.js";
import {
  createDesktopSessionContextManager,
  type DesktopSessionContextManagerOptions,
} from "./desktop-session-context.js";

const at = "2026-10-12T00:00:00.000Z";
const roots: string[] = [];
const managers: ReturnType<typeof createDesktopSessionContextManager>[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
function session(liveSetId = "set:unsaved"): DesktopSession {
  const agentId = randomUUID();
  return sessionSchema.parse({
    version: 4,
    id: randomUUID(),
    title: "App session",
    createdAt: at,
    updatedAt: at,
    liveSetId,
    liveSetName: "Untitled",
    selectedAgentInstanceId: agentId,
    activeAgents: [
      {
        id: agentId,
        label: "Agent",
        definitionName: "default",
        definitionFingerprint: "a".repeat(64),
        autoApprove: false,
        modified: false,
        lifecycle: "ready",
        boundTracks: [],
        eventListeners: [],
        outputSubscriptions: [],
        config: {
          description: "Agent",
          systemPrompt: "Help",
          tools: ["*"],
          resolvedTools: ["ableton_session"],
          resolvedOperations: ["session.inspect"],
          editScope: ["session"],
          skills: [],
          inputChannels: [],
        },
      },
    ],
  });
}
function invocation(owner: DesktopSession): ListeningExecutionContext {
  return {
    sessionId: owner.id,
    agentId: owner.activeAgents[0]!.id,
    trace: {
      traceId: randomUUID(),
      correlationId: "tool:context",
      causationId: "call:context",
    },
  };
}
function pass(
  owner: DesktopSession,
  context: ListeningExecutionContext,
): AppendContextPass {
  const passId = randomUUID();
  const entryId = randomUUID();
  const subjectId = randomUUID();
  const trackId = randomUUID();
  const owned = { sessionId: owner.id, liveSetId: owner.liveSetId };
  const fingerprint = {
    version: 1 as const,
    semanticLocator: { name: "Track", trackId },
    sourceIdentity: "unknown-live-source",
    playbackSettingsHash: "unknown",
    upstreamProcessingHash: "unknown",
    routingHash: "unknown",
    dependencyScope: "unknown" as const,
    previousRuntimeBindings: [],
  };
  return {
    pass: {
      id: passId,
      ...owned,
      initiatorAgentId: context.agentId,
      listenerIds: ["listener:1"],
      requestedMode: "session",
      actualMode: "session",
      requestedRange: { startBeat: 0, endBeat: 2 },
      actualRange: { startBeat: 0, endBeat: 2 },
      status: "completed",
      complete: true,
      createdAt: at,
      startedAt: at,
      endedAt: at,
      interruptionReason: null,
      trace: context.trace,
    },
    subjects: [
      {
        id: subjectId,
        ...owned,
        kind: "track",
        trackId,
        location: "track",
        binding: fingerprint,
      },
    ],
    entries: [
      {
        id: entryId,
        ...owned,
        passId,
        kind: "audio-observation/v1",
        createdAt: at,
        capturedAt: at,
        trace: context.trace,
        producer: {
          listenerId: "listener:1",
          deviceId: "device:1",
          agentId: context.agentId,
          connectionEpoch: "epoch:1",
          version: "1",
        },
        payload: {
          schema: "audio-observation/v1",
          passId,
          listenerId: "listener:1",
          sampleRate: 48000,
          startSample: 0,
          endSample: 48000,
          startBeat: 0,
          endBeat: 2,
          complete: true,
          limitations: [],
          algorithm: {
            name: "native",
            version: "1",
            windowSamples: 1024,
            hopSamples: 512,
            settings: { attackThresholdDb: 6, minAttackSpacingSamples: 2400 },
            units: { amplitude: "linear", rms: "dBFS", centroid: "Hz" },
            timingUncertaintySamples: 64,
          },
          summaries: { peak: [0, 0], rmsDbfs: [null, null], centroidHz: null },
          samples: [],
          attacks: [],
          reduction: {
            originalSamples: 0,
            originalAttacks: 0,
            truncated: false,
          },
        },
      },
    ],
    links: [
      {
        id: randomUUID(),
        ...owned,
        entryId,
        subjectId,
        relationship: "primary",
        coverage: { startBeat: 0, endBeat: 2 },
        attribution: "unknown",
        observedContributorIds: [],
        sourceFingerprint: fingerprint,
        freshness: {
          status: "unknown",
          assessedAt: at,
          reason: "Unverified source",
        },
      },
    ],
  };
}
async function harness(initial = [session(), session("set:other")]) {
  const root = join(process.cwd(), `.desktop-context-${randomUUID()}`);
  await mkdir(root);
  roots.push(root);
  const storage = resolveLiveAgentStorage({
    homeDirectory: root,
    environment: {},
    profile: "isolated",
  });
  const store = new JsonSessionStore(storage.sessionsPath, storage);
  let sessions = initial;
  const events: TelemetryEventEnvelope[] = [];
  const resolveSession = async (id: string) =>
    structuredClone(sessions.find((candidate) => candidate.id === id));
  const publishSessionContext = vi.fn(
    async (request: SessionContextPublicationRequest) => {
      const owner = sessions.find(
        (candidate) => candidate.id === request.sessionId,
      )!;
      const next = { ...owner, contextStore: request.contextStore };
      const updated = sessions.map((candidate) =>
        candidate.id === owner.id ? next : candidate,
      );
      await store.save(updated, {
        trace: request.trace,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      sessions = updated;
      return next;
    },
  );
  const create = (
    profile = storage,
    overrides: Partial<DesktopSessionContextManagerOptions> = {},
  ) => {
    const manager = createDesktopSessionContextManager({
      storage: profile,
      resolveSession,
      publishSessionContext,
      recorder: {
        enqueue: (event) => {
          events.push(telemetryEventEnvelopeSchema.parse(event));
        },
      },
      ...overrides,
    });
    managers.push(manager);
    return manager;
  };
  const manager = create();
  store.setSessionContextTransitionHandler(manager.prepareSessionTransition);
  return {
    storage,
    store,
    manager,
    create,
    resolveSession,
    publishSessionContext,
    events,
    get sessions() {
      return sessions;
    },
    async save(next: DesktopSession[]) {
      await store.save(next);
      sessions = next;
    },
  };
}

describe("Desktop session context manager", () => {
  it("honors caller-context cancellation while resolution is queued without publishing or opening a store", async () => {
    const h = await harness();
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const manager = h.create(h.storage, {
      resolveSession: async (id) => {
        entered();
        await waiting;
        return h.resolveSession(id);
      },
    });
    const owner = h.sessions[0]!;
    const first = manager.resolveRepository(invocation(owner));
    await started;
    const callerAbort = new AbortController();
    const other = h.sessions[1]!;
    const context = { ...invocation(other), signal: callerAbort.signal };
    const pending = manager.resolveRepository(context, {
      signal: new AbortController().signal,
    });
    callerAbort.abort();
    release();
    await first;
    await expect(pending).rejects.toThrow();
    const paths = resolveNestedSessionStorage(h.storage, {
      sessionId: other.id,
      liveSetId: other.liveSetId,
    });
    await expect(stat(paths.entityContextPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(h.publishSessionContext).not.toHaveBeenCalled();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    const lifecycle = h.events.filter(
      (event) => event.trace?.traceId === context.trace.traceId,
    );
    expect(lifecycle.map((event) => event.stage)).toEqual([
      "queued",
      "started",
      "cancelled",
    ]);
  });

  it("allows unattributed application inventory reads but denies mutations without weakening cached agent ownership", async () => {
    const h = await harness();
    const owner = h.sessions[0]!;
    const agent = invocation(owner);
    const application: ListeningExecutionContext = {
      ...invocation(owner),
      actorKind: "application",
      agentId: "desktop-context",
    };
    const reader = await h.manager.resolveRepository(application);
    expect(await reader.listPasses({}, { trace: application.trace })).toEqual({
      items: [],
    });
    const input = pass(owner, agent);
    await expect(reader.appendPass(input)).rejects.toThrow("cannot mutate");
    await expect(reader.reservePass(input.pass.id, 4096)).rejects.toThrow(
      "cannot mutate",
    );
    await expect(reader.releaseReservation(input.pass.id)).rejects.toThrow(
      "cannot mutate",
    );
    await expect(
      reader.prune({ passIds: [input.pass.id], trace: application.trace }),
    ).rejects.toThrow("cannot mutate");
    expect(h.publishSessionContext).not.toHaveBeenCalled();
    expect(await h.store.load()).toEqual([]);
    const writer = await h.manager.resolveRepository(agent);
    await writer.appendPass(input);
    expect(
      await reader.getPass(input.pass.id, { trace: application.trace }),
    ).toEqual(input.pass);
    await expect(
      h.manager.resolveRepository({
        ...application,
        sessionId: randomUUID(),
      }),
    ).rejects.toThrow("Unknown");
    await expect(
      h.manager.resolveRepository({ ...agent, agentId: "desktop-context" }),
    ).rejects.toThrow("initiating agent");
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    const lifecycle = h.events.filter(
      (event) => event.trace?.traceId === application.trace.traceId,
    );
    expect(lifecycle.length).toBeGreaterThan(0);
    expect(lifecycle.every((event) => event.activeAgentId === undefined)).toBe(
      true,
    );
  });

  it("publishes the invoking session only on first append and restores durable inventory after close/reopen", async () => {
    const h = await harness();
    const owner = h.sessions[0]!;
    const context = invocation(owner);
    const repository = await h.manager.resolveRepository(context);
    expect(await h.manager.resolveRepository(context)).toBe(repository);
    expect(h.publishSessionContext).not.toHaveBeenCalled();
    expect(await h.store.load()).toEqual([]);
    const input = pass(owner, context);
    await repository.appendPass(input, {
      trace: context.trace,
      activeAgentId: context.agentId,
    });
    expect(h.publishSessionContext).toHaveBeenCalledTimes(1);
    const manifest = JSON.parse(
      await readFile(
        resolveNestedSessionStorage(h.storage, {
          sessionId: owner.id,
          liveSetId: owner.liveSetId,
        }).manifestPath,
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(manifest.contextStore).toEqual(SESSION_CONTEXT_STORE_REFERENCE);
    await h.manager.close();
    const resumed = h.create();
    const restored = await resumed.resolveRepository(context);
    expect(await restored.getEntry(input.entries[0]!.id)).toEqual(
      input.entries[0],
    );
    const inventory = await createSessionContextHost({
      resolveRepository: (request) => resumed.resolveRepository(request),
    }).getSessionContextInventory(owner.id, context);
    expect(inventory).toContain(input.entries[0]!.id);
    expect(inventory).toContain("unknown");
    const other = await resumed.resolveRepository(invocation(h.sessions[1]!));
    expect(
      (await other.listEntries({ includeHistorical: true })).items,
    ).toEqual([]);
  });

  it("denies unknown sessions, foreign agents and undeclared/corrupt/missing stores rather than empty recovery", async () => {
    const h = await harness();
    const owner = h.sessions[0]!;
    const context = invocation(owner);
    await expect(
      h.manager.resolveRepository({ ...context, sessionId: randomUUID() }),
    ).rejects.toThrow("Unknown");
    await expect(
      h.manager.resolveRepository({ ...context, agentId: randomUUID() }),
    ).rejects.toThrow("initiating agent");
    const repository = await h.manager.resolveRepository(context);
    await repository.appendPass(pass(owner, context));
    await h.manager.close();
    const path = resolveNestedSessionStorage(h.storage, {
      sessionId: owner.id,
      liveSetId: owner.liveSetId,
    }).entityContextPath;
    const bytes = await readFile(path);
    await writeFile(path, "corrupt-database");
    const resumed = h.create();
    await expect(resumed.resolveRepository(context)).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe("corrupt-database");
    await rm(path);
    await expect(resumed.resolveRepository(context)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await writeFile(path, bytes);
    const wrongProfile = resolveLiveAgentStorage({
      homeDirectory: h.storage.root,
      environment: {},
      profile: "other",
    });
    await expect(
      h.create(wrongProfile).resolveRepository(context),
    ).rejects.toThrow();
  });

  it("does not leave unregistered context evidence after failed/cancelled publication or clean shutdown", async () => {
    const h = await harness();
    const owner = h.sessions[0]!;
    const context = invocation(owner);
    const repository = await h.manager.resolveRepository(context);
    const input = pass(owner, context);
    h.publishSessionContext.mockRejectedValueOnce(
      new Error("publication failed password=do-not-persist"),
    );
    await expect(repository.appendPass(input)).rejects.toThrow(
      "publication failed",
    );
    expect(await repository.getPass(input.pass.id)).toBeUndefined();
    const abort = new AbortController();
    abort.abort();
    await expect(
      repository.appendPass(input, { signal: abort.signal }),
    ).rejects.toThrow();
    expect(await h.store.load()).toEqual([]);
    const paths = resolveNestedSessionStorage(h.storage, {
      sessionId: owner.id,
      liveSetId: owner.liveSetId,
    });
    await h.manager.close();
    await expect(stat(paths.entityContextPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(`${paths.entityContextPath}.lock`)).rejects.toMatchObject(
      { code: "ENOENT" },
    );
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(JSON.stringify(h.events)).not.toContain("do-not-persist");
  });

  it("cleans and reopens cancelled pre-publication capture stores without retaining reservation ownership", async () => {
    const h = await harness();
    const owner = h.sessions[0]!;
    const context = invocation(owner);
    const input = pass(owner, context);
    const repository = await h.manager.resolveRepository(context);
    await repository.reservePass(input.pass.id, 4096);
    const abort = new AbortController();
    abort.abort();
    await expect(
      repository.appendPass(input, { signal: abort.signal }),
    ).rejects.toThrow();
    await repository.close();
    const paths = resolveNestedSessionStorage(h.storage, {
      sessionId: owner.id,
      liveSetId: owner.liveSetId,
    });
    await expect(stat(paths.entityContextPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(`${paths.entityContextPath}.lock`)).rejects.toMatchObject(
      {
        code: "ENOENT",
      },
    );
    const reopened = await h.manager.resolveRepository(context);
    expect(await reopened.listPasses()).toEqual({ items: [] });
    expect(await reopened.listEntries()).toEqual({ items: [] });
    expect(h.publishSessionContext).not.toHaveBeenCalled();
    expect(await h.store.load()).toEqual([]);
    expect((await h.resolveSession(owner.id))?.contextStore).toBeUndefined();
    const lease = await h.manager.prepareSessionTransition(h.sessions, [
      { ...owner, liveSetId: "set:saved-after-cancel" },
      h.sessions[1]!,
    ]);
    await lease.apply();
    lease.complete();
  });

  it("relocates saved ownership only after closing handles, preserving original provenance and reopening destination", async () => {
    const h = await harness();
    const before = h.sessions[0]!;
    const context = invocation(before);
    const repository = await h.manager.resolveRepository(context);
    const input = pass(before, context);
    await repository.appendPass(input);
    const original = resolveNestedSessionStorage(h.storage, {
      sessionId: before.id,
      liveSetId: before.liveSetId,
    });
    const next = h.sessions.map((record) =>
      record.id === before.id
        ? { ...record, liveSetId: "set:saved", liveProjectId: "project:1" }
        : record,
    );
    await h.save(next);
    await expect(repository.getPass(input.pass.id)).rejects.toThrow("closed");
    await expect(stat(original.entityContextPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    const moved = await h.manager.resolveRepository(context);
    expect(moved.liveSetId).toBe("set:saved");
    expect((await moved.getEntry(input.entries[0]!.id))?.liveSetId).toBe(
      before.liveSetId,
    );
    await h.manager.close();
    const reopened = await h.create().resolveRepository(context);
    expect(await reopened.getPass(input.pass.id)).toEqual(input.pass);
  });

  it("rolls back context headers and directories when registry publication fails after relocation", async () => {
    const h = await harness();
    const before = h.sessions[0]!;
    const context = invocation(before);
    const repository = await h.manager.resolveRepository(context);
    const input = pass(before, context);
    await repository.appendPass(input);
    const registry = await readFile(h.storage.sessionsPath);
    await rm(h.storage.sessionsPath);
    await mkdir(h.storage.sessionsPath);
    // load must remain readable during preparation, but final rename fails.
    const originalLoad = h.store.load.bind(h.store);
    vi.spyOn(h.store, "load").mockResolvedValue(h.sessions);
    await expect(
      h.save(
        h.sessions.map((record) =>
          record.id === before.id
            ? { ...record, liveSetId: "set:saved" }
            : record,
        ),
      ),
    ).rejects.toThrow();
    await rm(h.storage.sessionsPath, { recursive: true });
    await writeFile(h.storage.sessionsPath, registry);
    vi.spyOn(h.store, "load").mockImplementation(originalLoad);
    const restored = await h.manager.resolveRepository(context);
    expect(restored.liveSetId).toBe(before.liveSetId);
    expect(await restored.getEntry(input.entries[0]!.id)).toEqual(
      input.entries[0],
    );
  });

  it("fails closed during active reservations and rejects symlinked context directories", async () => {
    const h = await harness();
    const owner = h.sessions[0]!;
    const context = invocation(owner);
    const repository = await h.manager.resolveRepository(context);
    await repository.appendPass(pass(owner, context));
    await repository.reservePass("pending:1", 4096);
    await expect(
      h.save(
        h.sessions.map((record) =>
          record.id === owner.id
            ? { ...record, liveSetId: "set:saved" }
            : record,
        ),
      ),
    ).rejects.toThrow("reservation");
    await repository.releaseReservation("pending:1");
    await h.manager.close();
    const paths = resolveNestedSessionStorage(h.storage, {
      sessionId: owner.id,
      liveSetId: owner.liveSetId,
    });
    const bytes = await readFile(paths.entityContextPath);
    await rm(paths.contextDirectory, { recursive: true });
    const external = join(roots[0]!, "external-context");
    await mkdir(external);
    await writeFile(join(external, "entity-context.sqlite"), bytes);
    await symlink(external, paths.contextDirectory);
    await expect(h.create().resolveRepository(context)).rejects.toThrow(
      "symbolic",
    );
  });

  it("denies relocation while a reservation is queued but not yet recorded", async () => {
    const h = await harness();
    const owner = h.sessions[0]!;
    const repository = await h.manager.resolveRepository(invocation(owner));
    const reservation = repository.reservePass("pending:queued", 4096);
    const transition = h.manager.prepareSessionTransition(h.sessions, [
      { ...owner, liveSetId: "set:saved" },
      h.sessions[1]!,
    ]);
    await expect(transition).rejects.toThrow("reservation");
    await reservation;
    await repository.releaseReservation("pending:queued");
  });

  it("bounds cached repositories and queue admission, while attributing cancellation to the invoking agent", async () => {
    const h = await harness();
    await h.manager.close();
    const bounded = h.create(h.storage, { maxCachedSessions: 1 });
    const first = h.sessions[0]!;
    const firstContext = invocation(first);
    const repository = await bounded.resolveRepository(firstContext);
    const input = pass(first, firstContext);
    await repository.appendPass(input);
    await bounded.resolveRepository(invocation(h.sessions[1]!));
    await expect(repository.getPass(input.pass.id)).rejects.toThrow("closed");
    expect(
      await (
        await bounded.resolveRepository(firstContext)
      ).getEntry(input.entries[0]!.id),
    ).toEqual(input.entries[0]);
    const reopened = await bounded.resolveRepository(firstContext);
    await repository.close();
    expect(await bounded.resolveRepository(firstContext)).toBe(reopened);
    await bounded.close();
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });

    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const queued = h.create(h.storage, {
      maxPendingOperations: 1,
      resolveSession: async (id) => {
        entered!();
        await blocked;
        return h.resolveSession(id);
      },
    });
    const pending = queued.resolveRepository(firstContext);
    await started;
    await expect(queued.resolveRepository(firstContext)).rejects.toThrow(
      "queue is full",
    );
    release!();
    await pending;
    const abort = new AbortController();
    abort.abort();
    const cancelledContext = invocation(first);
    await expect(
      queued.resolveRepository(cancelledContext, { signal: abort.signal }),
    ).rejects.toThrow();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    const lifecycle = h.events.filter(
      (event) => event.trace?.traceId === cancelledContext.trace.traceId,
    );
    expect(lifecycle.map((event) => event.stage)).toEqual([
      "queued",
      "started",
      "cancelled",
    ]);
    expect(
      lifecycle.every(
        (event) =>
          event.activeAgentId === firstContext.agentId &&
          event.sessionId === first.id,
      ),
    ).toBe(true);
  });

  it("rolls back an aborted relocation and keeps all source-directory sessions bound together", async () => {
    const first = session();
    const second = session(first.liveSetId);
    const h = await harness([first, second]);
    const context = invocation(first);
    const repository = await h.manager.resolveRepository(context);
    const input = pass(first, context);
    await repository.appendPass(input);
    await expect(
      h.save(
        h.sessions.map((record) =>
          record.id === first.id
            ? { ...record, liveSetId: "set:saved" }
            : record,
        ),
      ),
    ).rejects.toThrow("transition together");
    const abort = new AbortController();
    h.store.setSessionContextTransitionHandler(async (...args) => {
      const lease = await h.manager.prepareSessionTransition(...args);
      return {
        ...lease,
        apply: async () => {
          await lease.apply();
          abort.abort();
        },
      };
    });
    await expect(
      h.store.save(
        h.sessions.map((record) => ({ ...record, liveSetId: "set:saved" })),
        {
          signal: abort.signal,
          trace: context.trace,
        },
      ),
    ).rejects.toThrow();
    const restored = await h.manager.resolveRepository(context);
    expect(restored.liveSetId).toBe(first.liveSetId);
    expect(await restored.getEntry(input.entries[0]!.id)).toEqual(
      input.entries[0],
    );
    await expect(
      h.store.save(h.sessions.filter(({ id }) => id !== first.id)),
    ).rejects.toThrow("implicitly removed");
    await expect(
      h.store.save(
        h.sessions.map((record) => {
          const copy = { ...record };
          delete copy.contextStore;
          return copy;
        }),
      ),
    ).rejects.toThrow("silently removed");
  });

  it("persists redacted bounded manifests and rejects unsupported or mismatched declarations", async () => {
    const owner = session();
    owner.title = "Session password=super-private";
    const h = await harness([owner]);
    const context = invocation(owner);
    const repository = await h.manager.resolveRepository(context);
    await repository.appendPass(pass(owner, context));
    const paths = resolveNestedSessionStorage(h.storage, {
      sessionId: owner.id,
      liveSetId: owner.liveSetId,
    });
    const manifestText = await readFile(paths.manifestPath, "utf8");
    expect(manifestText).not.toContain("super-private");
    expect(manifestText).toContain("[REDACTED]");
    expect((await stat(paths.entityContextPath)).mode & 0o777).toBe(0o600);
    expect((await stat(paths.contextDirectory)).mode & 0o777).toBe(0o700);
    await h.manager.close();
    const manifest = JSON.parse(manifestText) as Record<string, unknown>;
    await writeFile(
      paths.manifestPath,
      JSON.stringify({ ...manifest, appSessionId: randomUUID() }),
    );
    const resumed = h.create();
    await expect(resumed.resolveRepository(context)).rejects.toThrow(
      "does not match",
    );
    await writeFile(
      paths.manifestPath,
      JSON.stringify({
        ...manifest,
        contextStore: {
          ...SESSION_CONTEXT_STORE_REFERENCE,
          schemaVersion: 999,
        },
      }),
    );
    await expect(resumed.resolveRepository(context)).rejects.toThrow();
    expect(() =>
      sessionSchema.parse({
        ...owner,
        contextStore: {
          ...SESSION_CONTEXT_STORE_REFERENCE,
          rawAudio: "not permitted",
        },
      }),
    ).toThrow();
  });

  it("retires unpublished empty inventory on first save without adopting it as historical evidence", async () => {
    const h = await harness();
    const owner = h.sessions[0]!;
    const context = invocation(owner);
    const empty = await h.manager.resolveRepository(context);
    const oldPath = resolveNestedSessionStorage(h.storage, {
      sessionId: owner.id,
      liveSetId: owner.liveSetId,
    }).entityContextPath;
    await h.save(
      h.sessions.map((record) =>
        record.id === owner.id ? { ...record, liveSetId: "set:saved" } : record,
      ),
    );
    const saved = await h.manager.resolveRepository(context);
    expect(saved.liveSetId).toBe("set:saved");
    expect(
      (await saved.listEntries({ includeHistorical: true })).items,
    ).toEqual([]);
    expect(h.publishSessionContext).not.toHaveBeenCalled();
    await expect(empty.getPass(randomUUID())).rejects.toThrow("closed");
    await expect(stat(oldPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
