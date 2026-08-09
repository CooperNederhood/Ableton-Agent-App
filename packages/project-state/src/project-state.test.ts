import { describe, expect, it, vi } from "vitest";

import {
  AmbiguousReferenceError,
  ChangeSetService,
  GuardedMutationService,
  InMemoryProjectStateStore,
  ProductionPlanService,
  ProjectStateService,
  RepositoryConflictError,
  SnapshotCache,
  StaleReferenceError,
  applySnapshotEvent,
  changeSetSchema,
  metadataValueSchema,
  normalizeSnapshot,
  projectIdentitySchema,
  type EntityReference,
  type MutationRecord,
  type ProjectIdentity,
  type ProjectSnapshot,
  type ProjectStateRepositories,
  type ServiceRuntime,
} from "./index.js";

const ids = {
  projectA: "00000000-0000-4000-8000-000000000001",
  projectB: "00000000-0000-4000-8000-000000000002",
  session: "00000000-0000-4000-8000-000000000003",
  plan: "00000000-0000-4000-8000-000000000004",
  correlation: "00000000-0000-4000-8000-000000000005",
  changeSet: "00000000-0000-4000-8000-000000000006",
  mutation: "00000000-0000-4000-8000-000000000007",
  approval: "00000000-0000-4000-8000-000000000008",
  extra: "00000000-0000-4000-8000-000000000009",
} as const;

const now = "2026-08-09T15:18:51.051Z";

function project(
  id: string = ids.projectA,
  abletonProjectId = "live-a",
): ProjectIdentity {
  return {
    id,
    abletonProjectId,
    displayName: abletonProjectId,
    firstSeenAt: now,
    lastSeenAt: now,
  };
}

function snapshot(projectIdentity = project(), revision = 4): ProjectSnapshot {
  return {
    project: projectIdentity,
    revision,
    liveVersion: "12.2",
    capabilities: { arrangement: true },
    transport: {
      tempo: 120,
      timeSignature: { numerator: 4, denominator: 4 },
      loop: { enabled: false, start: 0, duration: 16 },
      isPlaying: false,
      currentTime: 0,
    },
    tracks: [
      {
        id: "track-1",
        name: "Lead",
        kind: "midi",
        index: 0,
        color: null,
        isMuted: false,
        isSoloed: false,
        isArmed: true,
      },
    ],
    scenes: [{ id: "scene-1", name: "Intro", index: 0 }],
    sessionClips: [
      {
        id: "session-clip-1",
        name: "Idea",
        trackId: "track-1",
        sceneId: "scene-1",
        hasContent: true,
        isPlaying: false,
        isTriggered: false,
      },
    ],
    arrangementClips: [
      {
        id: "arrangement-clip-1",
        name: "Verse",
        trackId: "track-1",
        start: 0,
        duration: 16,
      },
    ],
    devices: [
      {
        id: "device-1",
        name: "Operator",
        trackId: "track-1",
        index: 0,
        className: "Operator",
        isEnabled: true,
      },
    ],
    cuePoints: [{ id: "cue-1", name: "Start", time: 0 }],
    selected: [
      {
        projectId: projectIdentity.id,
        kind: "track",
        id: "track-1",
        revision,
      },
    ],
  };
}

function reference(
  kind: EntityReference["kind"] = "track",
  id = "track-1",
  revision = 4,
  projectId: string = ids.projectA,
): EntityReference {
  return { projectId, kind, id, revision };
}

function runtime(
  sequence: readonly string[] = [ids.plan, ids.approval],
): ServiceRuntime {
  let index = 0;
  return {
    createId: () => sequence[index++] ?? ids.extra,
    now: () => now,
  };
}

function mutation(): MutationRecord {
  return {
    id: ids.mutation,
    operation: "track.rename",
    target: reference(),
    data: { name: "New name" },
    recordedAt: now,
  };
}

describe("strict state schemas", () => {
  it("rejects unknown keys and detailed musical persistence", () => {
    expect(() =>
      projectIdentitySchema.parse({ ...project(), tempo: 120 }),
    ).toThrow("unexpected key");
    expect(() =>
      metadataValueSchema.parse({ nested: { notes: [{ pitch: 60 }] } }),
    ).toThrow("Detailed musical content");
  });

  it("validates complete change-set audit records", () => {
    const candidate = {
      id: ids.changeSet,
      projectId: ids.projectA,
      sessionId: ids.session,
      correlationId: ids.correlation,
      userIntent: "Rename a track",
      workflow: "rename",
      targets: [reference()],
      beforeState: { name: "Lead" },
      requestedMutations: [mutation()],
      completedMutations: [],
      verification: { status: "pending" as const, summary: "" },
      warnings: [],
      errors: [],
      recovery: [],
      status: "pending" as const,
      createdAt: now,
      updatedAt: now,
    };
    expect(() => changeSetSchema.parse({ ...candidate, notes: [] })).toThrow(
      "unexpected key",
    );
    expect(() =>
      changeSetSchema.parse({
        ...candidate,
        targets: [reference("track", "track-1", 4, ids.projectB)],
      }),
    ).toThrow("must belong to its project");
  });
});

describe("normalized snapshots and reducers", () => {
  it("builds entity indexes and rejects duplicate or orphan entities", () => {
    const normalized = normalizeSnapshot(snapshot());
    expect(normalized.entities.get("track")?.get("track-1")?.name).toBe("Lead");
    expect(normalized.entities.get("device")?.get("device-1")?.name).toBe(
      "Operator",
    );

    const duplicate = snapshot();
    expect(() =>
      normalizeSnapshot({
        ...duplicate,
        scenes: [...duplicate.scenes, duplicate.scenes[0]!],
      }),
    ).toThrow("Duplicate scene id");
    expect(() =>
      normalizeSnapshot({
        ...snapshot(),
        devices: [{ ...snapshot().devices[0]!, trackId: "missing" }],
      }),
    ).toThrow("invalid track");
  });

  it("applies updates/removals and targeted stale markers", () => {
    let state = normalizeSnapshot(snapshot());
    const invalidated = applySnapshotEvent(state, {
      projectId: ids.projectA,
      revision: 5,
      sequence: 10,
      change: {
        type: "entities.invalidated",
        references: [reference("device", "device-1", 4)],
      },
    });
    expect(invalidated.applied).toBe(true);
    expect(invalidated.refresh.scope).toBe("targeted");
    expect(invalidated.snapshot.stale.has("device:device-1")).toBe(true);

    state = invalidated.snapshot;
    const updated = applySnapshotEvent(state, {
      projectId: ids.projectA,
      revision: 5,
      sequence: 11,
      change: {
        type: "entity.upserted",
        kind: "device",
        entity: { ...snapshot().devices[0]!, isEnabled: false },
      },
    });
    expect(updated.snapshot.stale.size).toBe(0);
    expect(
      updated.snapshot.entities.get("device")?.get("device-1"),
    ).toMatchObject({ isEnabled: false });

    const removed = applySnapshotEvent(updated.snapshot, {
      projectId: ids.projectA,
      revision: 6,
      sequence: 12,
      change: {
        type: "entity.removed",
        reference: reference("track", "track-1", 5),
      },
    });
    expect(removed.snapshot.entities.get("track")?.has("track-1")).toBe(false);
    expect(removed.snapshot.entities.get("device")?.has("device-1")).toBe(
      false,
    );
    expect(
      removed.snapshot.entities.get("session-clip")?.has("session-clip-1"),
    ).toBe(false);
    expect(
      removed.snapshot.entities
        .get("arrangement-clip")
        ?.has("arrangement-clip-1"),
    ).toBe(false);
    expect(removed.snapshot.selected).toHaveLength(0);
  });

  it("rejects orphan child upserts", () => {
    const state = normalizeSnapshot(snapshot());
    expect(() =>
      applySnapshotEvent(state, {
        projectId: ids.projectA,
        revision: 5,
        sequence: 1,
        change: {
          type: "entity.upserted",
          kind: "device",
          entity: { ...snapshot().devices[0]!, trackId: "missing" },
        },
      }),
    ).toThrow(StaleReferenceError);
  });

  it("rejects revision regressions and detects sequence gaps", () => {
    const state = {
      ...normalizeSnapshot(snapshot()),
      lastSequence: 20,
    };
    expect(
      applySnapshotEvent(state, {
        projectId: ids.projectA,
        revision: 3,
        sequence: 21,
        change: { type: "transport.changed", transport: snapshot().transport },
      }),
    ).toMatchObject({
      applied: false,
      refresh: { scope: "full", reason: "revision-regression" },
    });
    expect(
      applySnapshotEvent(state, {
        projectId: ids.projectA,
        revision: 5,
        sequence: 22,
        change: { type: "transport.changed", transport: snapshot().transport },
      }),
    ).toMatchObject({
      applied: false,
      refresh: { scope: "full", reason: "sequence-gap" },
    });
  });
});

describe("cache revisions and mutation guards", () => {
  it("invalidates revision-bound details and rejects stale references", () => {
    const cache = new SnapshotCache();
    cache.ingest(snapshot());
    const clip = reference("session-clip", "session-clip-1");
    cache.setClipNotes(clip, [{ pitch: 60 }]);
    expect(cache.clipNotes(clip)).toEqual([{ pitch: 60 }]);

    cache.apply({
      projectId: ids.projectA,
      revision: 5,
      sequence: 1,
      change: {
        type: "transport.changed",
        transport: { ...snapshot().transport, tempo: 121 },
      },
    });
    expect(() => cache.clipNotes(clip)).toThrow(StaleReferenceError);
    expect(() => cache.assertMutable(reference("track", "track-1"))).toThrow(
      "revision is stale",
    );
  });

  it("rejects targeted stale and ambiguous references", () => {
    const cache = new SnapshotCache();
    cache.ingest({
      ...snapshot(),
      tracks: [
        snapshot().tracks[0]!,
        { ...snapshot().tracks[0]!, id: "track-2", index: 1 },
      ],
    });
    expect(() => cache.resolveByName("track", "Lead")).toThrow(
      AmbiguousReferenceError,
    );
    cache.apply({
      projectId: ids.projectA,
      revision: 4,
      sequence: 1,
      change: {
        type: "entities.invalidated",
        references: [reference()],
      },
    });
    expect(() => cache.assertMutable(reference())).toThrow("marked stale");
  });

  it("never calls the bridge for a stale reference", async () => {
    const store = new InMemoryProjectStateStore();
    const state = new ProjectStateService(store, runtime([ids.session]));
    await state.startSession();
    await state.switchProject(project());
    state.cache.ingest(snapshot());
    const bridgeMutation = vi.fn(() => Promise.resolve("done"));
    const guarded = new GuardedMutationService(state);

    await expect(
      guarded.execute(reference("track", "track-1", 3), bridgeMutation),
    ).rejects.toThrow(StaleReferenceError);
    expect(bridgeMutation).not.toHaveBeenCalled();
  });
});

describe("production plan state machine", () => {
  it("creates, edits, approves, and completes plans in order", async () => {
    const store = new InMemoryProjectStateStore();
    const service = new ProductionPlanService(
      store,
      runtime([ids.plan, ids.approval]),
    );
    const draft = await service.create({
      projectId: ids.projectA,
      goal: "Build an arrangement",
      tempo: 120,
    });
    expect(draft.status).toBe("draft");
    const edited = await service.update(draft.id, {
      goal: "Build a focused arrangement",
      tempo: null,
    });
    expect(edited).not.toHaveProperty("tempo");
    expect(edited.version).toBe(2);

    const approved = await service.approve(edited.id, ids.session, "LGTM");
    expect(approved.status).toBe("approved");
    expect(await store.approvals.listBySubject("plan", ids.plan)).toHaveLength(
      1,
    );
    await expect(
      service.update(ids.plan, { goal: "Too late" }),
    ).rejects.toThrow("Only draft");
    expect((await service.transition(ids.plan, "in-progress")).status).toBe(
      "in-progress",
    );
    expect((await service.transition(ids.plan, "complete")).status).toBe(
      "complete",
    );
    await expect(service.transition(ids.plan, "approved")).rejects.toThrow(
      "Invalid production plan transition",
    );
  });
});

describe("change-set state machine", () => {
  it("records requested/completed work and verification", async () => {
    const store = new InMemoryProjectStateStore();
    const service = new ChangeSetService(store, runtime([ids.changeSet]));
    const created = await service.create({
      projectId: ids.projectA,
      sessionId: ids.session,
      correlationId: ids.correlation,
      userIntent: "Rename the lead",
      workflow: "rename-track",
      targets: [reference()],
      beforeState: { name: "Lead" },
      requestedMutations: [mutation()],
    });
    await service.begin(created.id);
    await expect(
      service.recordCompletedMutation(created.id, {
        ...mutation(),
        id: ids.extra,
      }),
    ).rejects.toThrow("was not requested");
    await expect(service.verify(created.id, "verified")).rejects.toThrow(
      "incomplete",
    );
    await service.recordCompletedMutation(created.id, mutation());
    await expect(
      service.recordCompletedMutation(created.id, mutation()),
    ).rejects.toThrow("already recorded");
    await service.addWarning(created.id, "Name was normalized");
    const verified = await service.verify(created.id, "Track name matched");
    expect(verified).toMatchObject({
      status: "verified",
      verification: { status: "passed", summary: "Track name matched" },
      warnings: ["Name was normalized"],
    });
  });

  it("captures failures and recovery and rejects duplicate correlations", async () => {
    const store = new InMemoryProjectStateStore();
    const service = new ChangeSetService(
      store,
      runtime([ids.changeSet, ids.extra]),
    );
    const created = await service.create({
      projectId: ids.projectA,
      sessionId: ids.session,
      correlationId: ids.correlation,
      userIntent: "Rename",
      workflow: "rename",
    });
    const failed = await service.fail(created.id, "Live rejected mutation");
    expect(failed.errors).toEqual(["Live rejected mutation"]);
    expect(
      (await service.recover(created.id, "Restored old name")).status,
    ).toBe("recovered");
    await expect(
      service.create({
        projectId: ids.projectA,
        sessionId: ids.session,
        correlationId: ids.correlation,
        userIntent: "Duplicate",
        workflow: "rename",
      }),
    ).rejects.toThrow("already exists");
  });
});

describe("repositories and transactions", () => {
  it("rolls back failed transactions and prevents version conflicts", async () => {
    const store = new InMemoryProjectStateStore();
    await expect(
      store.transaction(async (repositories) => {
        await repositories.projects.save(project());
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await store.projects.get(ids.projectA)).toBeUndefined();

    const plans = new ProductionPlanService(store, runtime([ids.plan]));
    const plan = await plans.create({
      projectId: ids.projectA,
      goal: "Arrange",
    });
    await expect(store.plans.save({ ...plan, version: 2 }, 99)).rejects.toThrow(
      RepositoryConflictError,
    );
  });

  it("returns deterministic copies and isolates preferences by session", async () => {
    const store = new InMemoryProjectStateStore();
    await store.preferences.save({
      sessionId: ids.session,
      key: "theme",
      value: "dark",
      updatedAt: now,
    });
    await store.preferences.save({
      sessionId: ids.extra,
      key: "theme",
      value: "light",
      updatedAt: now,
    });
    expect(await store.preferences.listBySession(ids.session)).toEqual([
      {
        sessionId: ids.session,
        key: "theme",
        value: "dark",
        updatedAt: now,
      },
    ]);
  });

  it("rejects a transaction rather than losing a concurrent direct write", async () => {
    const store = new InMemoryProjectStateStore();
    let releaseTransaction!: () => void;
    const paused = new Promise<void>((resolve) => {
      releaseTransaction = resolve;
    });
    let transactionStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      transactionStarted = resolve;
    });
    const transaction = store.transaction(async (repositories) => {
      transactionStarted();
      await paused;
      await repositories.projects.save(project(ids.projectB, "live-b"));
    });

    await started;
    await store.projects.save(project());
    releaseTransaction();

    await expect(transaction).rejects.toThrow(RepositoryConflictError);
    expect(await store.projects.get(ids.projectA)).toEqual(project());
    expect(await store.projects.get(ids.projectB)).toBeUndefined();
  });

  it("keeps cached repository handles attached after a transaction commits", async () => {
    const store = new InMemoryProjectStateStore();
    const cachedProjects = store.projects;
    await store.transaction(async (repositories) => {
      await repositories.projects.save(project());
    });

    await cachedProjects.save(project(ids.projectB, "live-b"));

    expect(await store.projects.get(ids.projectA)).toEqual(project());
    expect(await store.projects.get(ids.projectB)).toEqual(
      project(ids.projectB, "live-b"),
    );
  });

  it("detaches transaction-scoped repositories after commit", async () => {
    const store = new InMemoryProjectStateStore();
    let transactionRepositories: ProjectStateRepositories | undefined;
    await store.transaction(async (repositories) => {
      transactionRepositories = repositories;
      await repositories.projects.save(project());
    });

    await transactionRepositories!.projects.save(
      project(ids.projectB, "live-b"),
    );

    expect(await store.projects.get(ids.projectA)).toEqual(project());
    expect(await store.projects.get(ids.projectB)).toBeUndefined();
  });
});

describe("project switching and session resume", () => {
  it("clears snapshots and never leaks plans across projects", async () => {
    const store = new InMemoryProjectStateStore();
    const state = new ProjectStateService(store, runtime([ids.session]));
    const session = await state.startSession();
    await state.switchProject(project());
    state.cache.ingest(snapshot());
    await store.plans.save({
      id: ids.plan,
      projectId: ids.projectA,
      goal: "A plan",
      sections: [],
      trackRoles: [],
      constraints: [],
      status: "draft",
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    await store.plans.save({
      id: ids.extra,
      projectId: ids.projectB,
      goal: "B plan",
      sections: [],
      trackRoles: [],
      constraints: [],
      status: "draft",
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    expect(await state.activePlans()).toHaveLength(1);

    await state.switchProject(project(ids.projectB, "live-b"));
    expect(state.cache.current()).toBeUndefined();
    expect((await state.activePlans()).map((plan) => plan.goal)).toEqual([
      "B plan",
    ]);
    expect(() => state.assertMutable(reference())).toThrow("different project");

    const resumed = new ProjectStateService(store, runtime());
    await resumed.resumeSession(session.id);
    expect(resumed.activeProject()?.id).toBe(ids.projectB);
    expect(resumed.cache.current()).toBeUndefined();
  });
});
