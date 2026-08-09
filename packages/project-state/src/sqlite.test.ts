import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import initSqlJs from "sql.js";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import {
  ChangeSetService,
  InMemoryProjectStateStore,
  ProductionPlanService,
  ProjectStateService,
  RepositoryConflictError,
  SchemaVersionError,
  SqliteProjectStateStore,
  projectStateMigrations,
  projectStateSchemaVersion,
  type ApprovalDecision,
  type AppSession,
  type ChangeSet,
  type Preference,
  type ProductionPlan,
  type ProjectIdentity,
  type ProjectStateRepositories,
  type ProjectStateStore,
  type ServiceRuntime,
} from "./index.js";

const ids = {
  projectA: "00000000-0000-4000-8000-000000000001",
  projectB: "00000000-0000-4000-8000-000000000002",
  session: "00000000-0000-4000-8000-000000000003",
  otherSession: "00000000-0000-4000-8000-000000000004",
  planA: "00000000-0000-4000-8000-000000000005",
  planB: "00000000-0000-4000-8000-000000000006",
  changeSetA: "00000000-0000-4000-8000-000000000007",
  changeSetB: "00000000-0000-4000-8000-000000000008",
  correlationA: "00000000-0000-4000-8000-000000000009",
  correlationB: "00000000-0000-4000-8000-00000000000a",
  approvalA: "00000000-0000-4000-8000-00000000000b",
  approvalB: "00000000-0000-4000-8000-00000000000c",
} as const;

const earlier = "2026-08-09T15:18:51.051Z";
const now = "2026-08-09T16:18:51.051Z";

const temporaryRoot = fileURLToPath(new URL("../.test-tmp/", import.meta.url));

async function temporaryDatabasePath(
  name = "project-state.sqlite",
): Promise<string> {
  await mkdir(temporaryRoot, { recursive: true });
  return join(await mkdtemp(join(temporaryRoot, "sqlite-")), name);
}

function project(
  id: string = ids.projectA,
  abletonProjectId = "live-a",
): ProjectIdentity {
  return {
    id,
    abletonProjectId,
    displayName: abletonProjectId,
    firstSeenAt: earlier,
    lastSeenAt: now,
  };
}

function session(id: string = ids.session): AppSession {
  return {
    id,
    activeProjectId: ids.projectA,
    startedAt: earlier,
    updatedAt: now,
  };
}

function plan(
  id: string = ids.planA,
  projectId: string = ids.projectA,
  createdAt = earlier,
): ProductionPlan {
  return {
    id,
    projectId,
    goal: `Goal ${id}`,
    tempo: 124,
    sections: [],
    trackRoles: [],
    constraints: ["keep the drums dry"],
    status: "draft",
    version: 1,
    createdAt,
    updatedAt: createdAt,
  };
}

function changeSet(
  id: string = ids.changeSetA,
  correlationId: string = ids.correlationA,
  projectId: string = ids.projectA,
  createdAt = earlier,
): ChangeSet {
  return {
    id,
    projectId,
    sessionId: ids.session,
    correlationId,
    userIntent: "Rename the lead",
    workflow: "rename-track",
    targets: [{ projectId, kind: "track", id: "track-1", revision: 4 }],
    beforeState: { name: "Lead" },
    requestedMutations: [],
    completedMutations: [],
    verification: { status: "pending", summary: "" },
    warnings: [],
    errors: [],
    recovery: [],
    status: "pending",
    createdAt,
    updatedAt: createdAt,
  };
}

function preference(
  key: string,
  value: string,
  sessionId: string = ids.session,
): Preference {
  return { sessionId, key, value, updatedAt: now };
}

function approval(
  id: string = ids.approvalA,
  decidedAt = earlier,
  subjectId: string = ids.planA,
): ApprovalDecision {
  return {
    id,
    projectId: ids.projectA,
    sessionId: ids.session,
    subjectType: "plan",
    subjectId,
    decision: "approved",
    reason: "Looks good",
    decidedAt,
  };
}

async function inspect(
  path: string,
  sqlText: string,
): Promise<(string | number | Uint8Array | null)[][]> {
  const sql = await initSqlJs();
  const database = new sql.Database(new Uint8Array(await readFile(path)));
  try {
    return database.exec(sqlText)[0]?.values ?? [];
  } finally {
    database.close();
  }
}

function runtime(sequence: readonly string[]): ServiceRuntime {
  let index = 0;
  return {
    createId: () => sequence[index++] ?? ids.approvalB,
    now: () => now,
  };
}

interface StoreHandle {
  readonly store: ProjectStateStore;
  readonly dispose: () => Promise<void>;
}

const factories = [
  {
    name: "in-memory store",
    create: (): Promise<StoreHandle> =>
      Promise.resolve({
        store: new InMemoryProjectStateStore(),
        dispose: () => Promise.resolve(),
      }),
  },
  {
    name: "sqlite store",
    create: async (): Promise<StoreHandle> => {
      const store = await SqliteProjectStateStore.open();
      return { store, dispose: () => store.close() };
    },
  },
] as const;

afterAll(async () => {
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe.each(factories)("$name repository parity", ({ create }) => {
  const handles: StoreHandle[] = [];

  async function openStore(): Promise<ProjectStateStore> {
    const handle = await create();
    handles.push(handle);
    return handle.store;
  }

  afterEach(async () => {
    while (handles.length > 0) {
      await handles.pop()?.dispose();
    }
  });

  it("round-trips every record type", async () => {
    const store = await openStore();
    await store.sessions.save(session());
    await store.projects.save(project());
    await store.plans.save(plan());
    await store.changeSets.save(changeSet());
    await store.preferences.save(preference("theme", "dark"));
    await store.approvals.save(approval());

    expect(await store.sessions.get(ids.session)).toEqual(session());
    expect(await store.projects.get(ids.projectA)).toEqual(project());
    expect(await store.plans.get(ids.planA)).toEqual(plan());
    expect(await store.changeSets.get(ids.changeSetA)).toEqual(changeSet());
    expect(await store.preferences.get(ids.session, "theme")).toEqual(
      preference("theme", "dark"),
    );
    expect(await store.approvals.get(ids.approvalA)).toEqual(approval());
    expect(await store.projects.get(ids.projectB)).toBeUndefined();
    expect(await store.preferences.get(ids.session, "missing")).toBeUndefined();
  });

  it("omits absent optional fields and updates existing rows", async () => {
    const store = await openStore();
    const withoutProject: AppSession = {
      id: ids.session,
      startedAt: earlier,
      updatedAt: earlier,
    };
    await store.sessions.save(withoutProject);
    const stored = await store.sessions.get(ids.session);
    expect(stored).toEqual(withoutProject);
    expect(stored).not.toHaveProperty("activeProjectId");

    await store.sessions.save(session());
    expect(await store.sessions.get(ids.session)).toEqual(session());
  });

  it("finds records through unique lookups", async () => {
    const store = await openStore();
    await store.projects.save(project());
    await store.changeSets.save(changeSet());

    expect(await store.projects.findByAbletonId("live-a")).toEqual(project());
    expect(await store.projects.findByAbletonId("live-z")).toBeUndefined();
    expect(
      await store.changeSets.findByCorrelationId(ids.correlationA),
    ).toEqual(changeSet());
    expect(
      await store.changeSets.findByCorrelationId(ids.correlationB),
    ).toBeUndefined();
  });

  it("scopes and orders project and session collections", async () => {
    const store = await openStore();
    await store.plans.save(plan(ids.planB, ids.projectA, now));
    await store.plans.save(plan(ids.planA, ids.projectA, earlier));
    await store.plans.save(plan(ids.changeSetB, ids.projectB, earlier));
    await store.changeSets.save(
      changeSet(ids.changeSetB, ids.correlationB, ids.projectA, now),
    );
    await store.changeSets.save(
      changeSet(ids.changeSetA, ids.correlationA, ids.projectA, earlier),
    );
    await store.approvals.save(approval(ids.approvalB, now));
    await store.approvals.save(approval(ids.approvalA, earlier));
    await store.preferences.save(preference("theme", "dark"));
    await store.preferences.save(preference("accent", "green"));
    await store.preferences.save(
      preference("theme", "light", ids.otherSession),
    );

    expect(
      (await store.plans.listByProject(ids.projectA)).map((item) => item.id),
    ).toEqual([ids.planA, ids.planB]);
    expect(
      (await store.changeSets.listByProject(ids.projectA)).map(
        (item) => item.id,
      ),
    ).toEqual([ids.changeSetA, ids.changeSetB]);
    expect(
      (await store.approvals.listBySubject("plan", ids.planA)).map(
        (item) => item.id,
      ),
    ).toEqual([ids.approvalA, ids.approvalB]);
    expect(
      await store.approvals.listBySubject("change-set", ids.planA),
    ).toEqual([]);
    expect(
      (await store.preferences.listBySession(ids.session)).map(
        (item) => item.key,
      ),
    ).toEqual(["accent", "theme"]);
    expect(await store.preferences.listBySession(ids.otherSession)).toEqual([
      preference("theme", "light", ids.otherSession),
    ]);
  });

  it("rejects duplicate ableton projects and correlations", async () => {
    const store = await openStore();
    await store.projects.save(project());
    await expect(
      store.projects.save(project(ids.projectB, "live-a")),
    ).rejects.toThrow(RepositoryConflictError);
    await store.projects.save({ ...project(), displayName: "Renamed" });
    expect((await store.projects.get(ids.projectA))?.displayName).toBe(
      "Renamed",
    );

    await store.changeSets.save(changeSet());
    await expect(
      store.changeSets.save(changeSet(ids.changeSetB, ids.correlationA)),
    ).rejects.toThrow(RepositoryConflictError);
  });

  it("enforces optimistic plan versions", async () => {
    const store = await openStore();
    await expect(store.plans.save(plan(), 1)).rejects.toThrow(
      RepositoryConflictError,
    );
    await store.plans.save(plan());
    await expect(
      store.plans.save({ ...plan(), version: 2 }, 99),
    ).rejects.toThrow(RepositoryConflictError);
    expect((await store.plans.get(ids.planA))?.version).toBe(1);

    await store.plans.save({ ...plan(), version: 2, goal: "Next" }, 1);
    expect(await store.plans.get(ids.planA)).toMatchObject({
      version: 2,
      goal: "Next",
    });
  });

  it("validates payloads through the state schemas", async () => {
    const store = await openStore();
    await expect(
      store.projects.save({ ...project(), tempo: 120 } as ProjectIdentity),
    ).rejects.toThrow("unexpected key");
    await expect(
      store.projects.save({ ...project(), id: "not-a-uuid" }),
    ).rejects.toThrow("id must be a UUID");
    await expect(
      store.preferences.save({
        ...preference("mix", "loud"),
        value: { notes: [60] },
      }),
    ).rejects.toThrow("Detailed musical content");
    expect(await store.projects.get(ids.projectA)).toBeUndefined();
  });

  it("commits successful transactions and rolls failures back", async () => {
    const store = await openStore();
    await store.transaction(async (repositories) => {
      await repositories.projects.save(project());
      await repositories.plans.save(plan());
    });
    expect(await store.projects.get(ids.projectA)).toEqual(project());
    expect(await store.plans.get(ids.planA)).toEqual(plan());

    await expect(
      store.transaction(async (repositories) => {
        await repositories.projects.save(project(ids.projectB, "live-b"));
        await repositories.plans.save(plan(ids.planB, ids.projectB));
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await store.projects.get(ids.projectB)).toBeUndefined();
    expect(await store.plans.get(ids.planB)).toBeUndefined();
    expect(await store.plans.listByProject(ids.projectA)).toHaveLength(1);
  });

  it("rolls back when a repository rejects inside a transaction", async () => {
    const store = await openStore();
    await store.projects.save(project());
    await expect(
      store.transaction(async (repositories) => {
        await repositories.plans.save(plan());
        await repositories.projects.save(project(ids.projectB, "live-a"));
      }),
    ).rejects.toThrow(RepositoryConflictError);
    expect(await store.plans.get(ids.planA)).toBeUndefined();
    expect(await store.projects.get(ids.projectB)).toBeUndefined();
  });

  it("never applies writes made after a transaction completed", async () => {
    const store = await openStore();
    let escaped!: ProjectStateRepositories;
    await store.transaction(async (repositories) => {
      escaped = repositories;
      await repositories.projects.save(project());
    });

    await escaped.projects
      .save(project(ids.projectB, "live-b"))
      .catch(() => undefined);

    expect(await store.projects.get(ids.projectA)).toEqual(project());
    expect(await store.projects.get(ids.projectB)).toBeUndefined();
  });

  it("supports the plan and change-set services", async () => {
    const store = await openStore();
    const plans = new ProductionPlanService(
      store,
      runtime([ids.planA, ids.approvalA]),
    );
    const draft = await plans.create({
      projectId: ids.projectA,
      goal: "Arrange the drop",
    });
    const approved = await plans.approve(draft.id, ids.session, "Ship it");
    expect(approved.status).toBe("approved");
    expect(await store.approvals.listBySubject("plan", ids.planA)).toHaveLength(
      1,
    );
    expect((await plans.transition(ids.planA, "in-progress")).status).toBe(
      "in-progress",
    );

    const changeSets = new ChangeSetService(store, runtime([ids.changeSetA]));
    const created = await changeSets.create({
      projectId: ids.projectA,
      sessionId: ids.session,
      correlationId: ids.correlationA,
      userIntent: "Rename",
      workflow: "rename",
    });
    const failed = await changeSets.fail(created.id, "Live rejected mutation");
    expect(failed.status).toBe("failed");
    expect((await changeSets.recover(created.id, "Restored")).status).toBe(
      "recovered",
    );
    expect(
      (await store.changeSets.listByProject(ids.projectA)).map(
        (item) => item.status,
      ),
    ).toEqual(["recovered"]);
  });

  it("resumes sessions and isolates plans across project switches", async () => {
    const store = await openStore();
    const state = new ProjectStateService(store, runtime([ids.session]));
    const started = await state.startSession();
    await state.switchProject(project());
    await store.plans.save(plan());
    await store.plans.save(plan(ids.planB, ids.projectB));
    expect(await state.activePlans()).toHaveLength(1);

    await state.switchProject(project(ids.projectB, "live-b"));
    expect((await state.activePlans()).map((item) => item.id)).toEqual([
      ids.planB,
    ]);

    const resumed = new ProjectStateService(store, runtime([]));
    await resumed.resumeSession(started.id);
    expect(resumed.activeProject()?.id).toBe(ids.projectB);
  });
});

describe("sqlite persistence", () => {
  const stores: SqliteProjectStateStore[] = [];

  async function openStore(
    options: { path?: string } = {},
  ): Promise<SqliteProjectStateStore> {
    const store = await SqliteProjectStateStore.open(options);
    stores.push(store);
    return store;
  }

  afterEach(async () => {
    while (stores.length > 0) {
      await stores.pop()?.close();
    }
  });

  it("creates the database file and reopens with the same records", async () => {
    const path = await temporaryDatabasePath();
    const store = await openStore({ path });
    expect(store.databasePath).toBe(path);
    expect(store.schemaVersion).toBe(projectStateSchemaVersion);
    expect((await readdir(dirname(path))).sort()).toEqual([
      "project-state.sqlite",
      "project-state.sqlite.lock",
    ]);

    await store.projects.save(project());
    await store.plans.save(plan());
    await store.preferences.save(preference("theme", "dark"));
    await store.close();
    expect(store.isOpen).toBe(false);

    const reopened = await openStore({ path });
    expect(await reopened.projects.get(ids.projectA)).toEqual(project());
    expect(await reopened.plans.listByProject(ids.projectA)).toEqual([plan()]);
    expect(await reopened.preferences.listBySession(ids.session)).toEqual([
      preference("theme", "dark"),
    ]);
  });

  it("writes atomically and leaves no temporary files behind", async () => {
    const path = await temporaryDatabasePath();
    const store = await openStore({ path });
    await store.projects.save(project());
    await store.flush();
    const entries = await readdir(dirname(path));
    expect(entries.sort()).toEqual([
      "project-state.sqlite",
      "project-state.sqlite.lock",
    ]);
    expect(entries.some((entry) => entry.endsWith(".tmp"))).toBe(false);
  });

  it("defers disk writes until flush or close when auto flush is off", async () => {
    const path = await temporaryDatabasePath();
    const store = await SqliteProjectStateStore.open({
      path,
      autoFlush: false,
    });
    await store.projects.save(project());
    expect(await inspect(path, "SELECT count(*) FROM projects")).toEqual([[0]]);

    await store.flush();
    expect(await inspect(path, "SELECT count(*) FROM projects")).toEqual([[1]]);

    await store.plans.save(plan());
    expect(await inspect(path, "SELECT count(*) FROM plans")).toEqual([[0]]);
    await store.close();
    expect(await inspect(path, "SELECT count(*) FROM plans")).toEqual([[1]]);
  });

  it("keeps rolled-back transactions out of the database file", async () => {
    const path = await temporaryDatabasePath();
    const store = await openStore({ path });
    await store.projects.save(project());
    await expect(
      store.transaction(async (repositories) => {
        await repositories.plans.save(plan());
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await store.close();

    const reopened = await openStore({ path });
    expect(await reopened.plans.get(ids.planA)).toBeUndefined();
    expect(await reopened.projects.get(ids.projectA)).toEqual(project());
  });

  it("joins store-level repository calls to an open transaction", async () => {
    const store = await openStore();
    await expect(
      store.transaction(async () => {
        await store.plans.save(plan());
        expect(await store.plans.get(ids.planA)).toEqual(plan());
        throw new Error("discard");
      }),
    ).rejects.toThrow("discard");
    expect(await store.plans.get(ids.planA)).toBeUndefined();

    await store.transaction(async () => {
      await store.projects.save(project());
    });
    expect(await store.projects.get(ids.projectA)).toEqual(project());
  });

  it("serializes concurrent operations", async () => {
    const store = await openStore({ path: await temporaryDatabasePath() });
    await Promise.all([
      store.projects.save(project()),
      store.projects.save(project(ids.projectB, "live-b")),
      store.plans.save(plan()),
      store.plans.save(plan(ids.planB, ids.projectB)),
      store.preferences.save(preference("theme", "dark")),
    ]);
    expect(await store.projects.get(ids.projectA)).toEqual(project());
    expect(await store.projects.get(ids.projectB)).toEqual(
      project(ids.projectB, "live-b"),
    );
    expect(await store.plans.listByProject(ids.projectA)).toHaveLength(1);
  });

  it("prevents multiple stores from owning the same database file", async () => {
    const path = await temporaryDatabasePath();
    const store = await openStore({ path });

    await expect(SqliteProjectStateStore.open({ path })).rejects.toThrow(
      "already open",
    );
    await store.close();

    const reopened = await openStore({ path });
    expect(reopened.isOpen).toBe(true);
  });

  it("reclaims a lock left by a process that is no longer running", async () => {
    const path = await temporaryDatabasePath();
    await writeFile(`${path}.lock`, "2147483647", "utf8");

    const store = await openStore({ path });

    expect(store.isOpen).toBe(true);
  });

  it("allows only one concurrent stale-lock reclaimer", async () => {
    const path = await temporaryDatabasePath();
    await writeFile(`${path}.lock`, "2147483647", "utf8");

    const attempts = await Promise.allSettled([
      SqliteProjectStateStore.open({ path }),
      SqliteProjectStateStore.open({ path }),
    ]);
    const opened = attempts.filter(
      (attempt): attempt is PromiseFulfilledResult<SqliteProjectStateStore> =>
        attempt.status === "fulfilled",
    );
    const rejected = attempts.filter(
      (attempt): attempt is PromiseRejectedResult =>
        attempt.status === "rejected",
    );
    stores.push(...opened.map((attempt) => attempt.value));

    expect(opened).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(RepositoryConflictError);
    expect(await readdir(dirname(path))).not.toContain(
      "project-state.sqlite.lock.recovery",
    );
  });

  it("rejects nested transactions and use after close", async () => {
    const store = await openStore();
    await expect(
      store.transaction(() => store.transaction(() => Promise.resolve(1))),
    ).rejects.toThrow("cannot be nested");

    await store.close();
    await store.close();
    await expect(store.projects.get(ids.projectA)).rejects.toThrow(
      "store is closed",
    );
    await expect(store.projects.save(project())).rejects.toThrow(
      "store is closed",
    );
  });
});

describe("sqlite migrations", () => {
  async function writeLegacyDatabase(path: string): Promise<void> {
    const sql = await initSqlJs();
    const database = new sql.Database();
    const [initial] = projectStateMigrations;
    for (const statement of initial?.statements ?? []) {
      database.run(statement);
    }
    database.run(
      "INSERT INTO schema_migrations (version, description, applied_at) VALUES (1, ?, ?)",
      [initial?.description ?? "", earlier],
    );
    const legacyProject = project();
    const legacyPlan = plan();
    const legacyChangeSet = changeSet();
    database.run("INSERT INTO sessions (id, payload) VALUES (?, ?)", [
      ids.session,
      JSON.stringify(session()),
    ]);
    database.run(
      "INSERT INTO projects (id, ableton_project_id, payload) VALUES (?, ?, ?)",
      [
        legacyProject.id,
        legacyProject.abletonProjectId,
        JSON.stringify(legacyProject),
      ],
    );
    database.run(
      "INSERT INTO plans (id, project_id, version, payload) VALUES (?, ?, ?, ?)",
      [
        legacyPlan.id,
        legacyPlan.projectId,
        legacyPlan.version,
        JSON.stringify(legacyPlan),
      ],
    );
    database.run(
      "INSERT INTO change_sets (id, project_id, correlation_id, payload) VALUES (?, ?, ?, ?)",
      [
        legacyChangeSet.id,
        legacyChangeSet.projectId,
        legacyChangeSet.correlationId,
        JSON.stringify(legacyChangeSet),
      ],
    );
    database.run(
      "INSERT INTO preferences (session_id, key, payload) VALUES (?, ?, ?)",
      [ids.session, "theme", JSON.stringify(preference("theme", "dark"))],
    );
    database.run(
      "INSERT INTO approvals (id, subject_type, subject_id, payload) VALUES (?, ?, ?, ?)",
      [ids.approvalA, "plan", ids.planA, JSON.stringify(approval())],
    );
    await writeFile(path, database.export());
    database.close();
  }

  it("upgrades an older schema version without losing records", async () => {
    const path = await temporaryDatabasePath("legacy.sqlite");
    await writeLegacyDatabase(path);

    const store = await SqliteProjectStateStore.open({ path });
    try {
      expect(store.schemaVersion).toBe(projectStateSchemaVersion);
      expect(await store.sessions.get(ids.session)).toEqual(session());
      expect(await store.projects.findByAbletonId("live-a")).toEqual(project());
      expect(await store.plans.listByProject(ids.projectA)).toEqual([plan()]);
      expect(
        await store.changeSets.findByCorrelationId(ids.correlationA),
      ).toEqual(changeSet());
      expect(await store.preferences.get(ids.session, "theme")).toEqual(
        preference("theme", "dark"),
      );
      expect(await store.approvals.listBySubject("plan", ids.planA)).toEqual([
        approval(),
      ]);

      await expect(
        store.projects.save(project(ids.projectB, "live-a")),
      ).rejects.toThrow(RepositoryConflictError);
    } finally {
      await store.close();
    }

    expect(
      await inspect(
        path,
        "SELECT version FROM schema_migrations ORDER BY version",
      ),
    ).toEqual([[1], [2]]);
    expect(await inspect(path, "PRAGMA user_version")).toEqual([
      [projectStateSchemaVersion],
    ]);
    expect(await inspect(path, "SELECT status, created_at FROM plans")).toEqual(
      [["draft", earlier]],
    );
    expect(
      await inspect(path, "SELECT active_project_id FROM sessions"),
    ).toEqual([[ids.projectA]]);
    expect(
      await inspect(path, "SELECT session_id, status FROM change_sets"),
    ).toEqual([[ids.session, "pending"]]);
    expect(await inspect(path, "SELECT decided_at FROM approvals")).toEqual([
      [earlier],
    ]);
    expect(
      await inspect(
        path,
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'change_sets_correlation_id'",
      ),
    ).toEqual([["change_sets_correlation_id"]]);
  });

  it("is idempotent when every migration is already applied", async () => {
    const path = await temporaryDatabasePath();
    const first = await SqliteProjectStateStore.open({ path });
    await first.projects.save(project());
    await first.close();

    const second = await SqliteProjectStateStore.open({ path });
    try {
      expect(second.schemaVersion).toBe(projectStateSchemaVersion);
      expect(await second.projects.get(ids.projectA)).toEqual(project());
    } finally {
      await second.close();
    }
    expect(
      await inspect(path, "SELECT count(*) FROM schema_migrations"),
    ).toEqual([[projectStateMigrations.length]]);
  });

  it("refuses databases newer than the supported schema version", async () => {
    const path = await temporaryDatabasePath("future.sqlite");
    const store = await SqliteProjectStateStore.open({ path });
    await store.close();

    const sql = await initSqlJs();
    const database = new sql.Database(new Uint8Array(await readFile(path)));
    database.run(
      "INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, 'future', ?)",
      [projectStateSchemaVersion + 1, now],
    );
    await writeFile(path, database.export());
    database.close();

    await expect(SqliteProjectStateStore.open({ path })).rejects.toThrow(
      SchemaVersionError,
    );
  });
});
