import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import {
  open,
  mkdir,
  readFile,
  rename,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";

import initSqlJs, {
  type BindParams,
  type Database,
  type ParamsObject,
  type SqlJsStatic,
} from "sql.js";

import { migrateProjectState } from "./migrations.js";
import { compareOrderedRecords, comparePreferenceKeys } from "./ordering.js";
import {
  RepositoryConflictError,
  type ApprovalRepository,
  type ChangeSetRepository,
  type PlanRepository,
  type PreferenceRepository,
  type ProjectRepository,
  type ProjectStateRepositories,
  type ProjectStateStore,
  type SessionRepository,
} from "./repository.js";
import {
  appSessionSchema,
  approvalDecisionSchema,
  changeSetSchema,
  preferenceSchema,
  productionPlanSchema,
  projectIdentitySchema,
  type Schema,
} from "./schemas.js";

let runtime: Promise<SqlJsStatic> | undefined;

function loadSqlJs(): Promise<SqlJsStatic> {
  runtime ??= initSqlJs();
  return runtime;
}

function selectRows(
  database: Database,
  sql: string,
  parameters: BindParams,
): ParamsObject[] {
  const statement = database.prepare(sql);
  try {
    statement.bind(parameters);
    const rows: ParamsObject[] = [];
    while (statement.step()) {
      rows.push(statement.getAsObject());
    }
    return rows;
  } finally {
    statement.free();
  }
}

function selectRow(
  database: Database,
  sql: string,
  parameters: BindParams,
): ParamsObject | undefined {
  return selectRows(database, sql, parameters)[0];
}

function decode<T>(schema: Schema<T>, row: ParamsObject, label: string): T {
  const payload = row.payload;
  if (typeof payload !== "string") {
    throw new TypeError(`Stored ${label} payload is not text`);
  }
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    throw new TypeError(`Stored ${label} payload is not valid JSON`);
  }
  return schema.parse(value);
}

function decodeRow<T>(
  schema: Schema<T>,
  row: ParamsObject | undefined,
  label: string,
): T | undefined {
  return row === undefined ? undefined : decode(schema, row, label);
}

function decodeRows<T>(
  schema: Schema<T>,
  rows: readonly ParamsObject[],
  label: string,
): T[] {
  return rows.map((row) => decode(schema, row, label));
}

function encode(value: unknown): string {
  return JSON.stringify(value);
}

function conflictGuard<T>(operation: () => T, message: string): T {
  try {
    return operation();
  } catch (error) {
    if (
      error instanceof Error &&
      /constraint failed/iu.test(error.message) &&
      !(error instanceof RepositoryConflictError)
    ) {
      throw new RepositoryConflictError(message);
    }
    throw error;
  }
}

interface Executor {
  read<T>(operation: (database: Database) => T): Promise<T>;
  write<T>(operation: (database: Database) => T): Promise<T>;
}

class TransactionScope {
  #active = true;

  public assertActive(): void {
    if (!this.#active) {
      throw new Error(
        "The transaction repositories were used after the transaction completed",
      );
    }
  }

  public close(): void {
    this.#active = false;
  }
}

function createRepositories(executor: Executor): ProjectStateRepositories {
  const sessions: SessionRepository = {
    get: (id) =>
      executor.read((database) =>
        decodeRow(
          appSessionSchema,
          selectRow(database, "SELECT payload FROM sessions WHERE id = ?", [
            id,
          ]),
          "session",
        ),
      ),
    save: (session) =>
      executor.write((database) => {
        const parsed = appSessionSchema.parse(session);
        database.run(
          `INSERT INTO sessions (id, active_project_id, updated_at, payload)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             active_project_id = excluded.active_project_id,
             updated_at = excluded.updated_at,
             payload = excluded.payload`,
          [
            parsed.id,
            parsed.activeProjectId ?? null,
            parsed.updatedAt,
            encode(parsed),
          ],
        );
      }),
  };

  const projects: ProjectRepository = {
    get: (id) =>
      executor.read((database) =>
        decodeRow(
          projectIdentitySchema,
          selectRow(database, "SELECT payload FROM projects WHERE id = ?", [
            id,
          ]),
          "project identity",
        ),
      ),
    findByAbletonId: (abletonProjectId) =>
      executor.read((database) =>
        decodeRow(
          projectIdentitySchema,
          selectRow(
            database,
            "SELECT payload FROM projects WHERE ableton_project_id = ?",
            [abletonProjectId],
          ),
          "project identity",
        ),
      ),
    save: (project) =>
      executor.write((database) => {
        const parsed = projectIdentitySchema.parse(project);
        const message = `Ableton project '${parsed.abletonProjectId}' already exists`;
        const conflicting = selectRow(
          database,
          "SELECT id FROM projects WHERE ableton_project_id = ? AND id <> ?",
          [parsed.abletonProjectId, parsed.id],
        );
        if (conflicting !== undefined) {
          throw new RepositoryConflictError(message);
        }
        conflictGuard(
          () =>
            database.run(
              `INSERT INTO projects (id, ableton_project_id, last_seen_at, payload)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET
                 ableton_project_id = excluded.ableton_project_id,
                 last_seen_at = excluded.last_seen_at,
                 payload = excluded.payload`,
              [
                parsed.id,
                parsed.abletonProjectId,
                parsed.lastSeenAt,
                encode(parsed),
              ],
            ),
          message,
        );
      }),
  };

  const plans: PlanRepository = {
    get: (id) =>
      executor.read((database) =>
        decodeRow(
          productionPlanSchema,
          selectRow(database, "SELECT payload FROM plans WHERE id = ?", [id]),
          "production plan",
        ),
      ),
    listByProject: (projectId) =>
      executor.read((database) =>
        decodeRows(
          productionPlanSchema,
          selectRows(
            database,
            `SELECT payload FROM plans
             WHERE project_id = ?
             ORDER BY created_at, id`,
            [projectId],
          ),
          "production plan",
        ).sort(compareOrderedRecords()),
      ),
    save: (plan, expectedVersion) =>
      executor.write((database) => {
        const parsed = productionPlanSchema.parse(plan);
        if (expectedVersion !== undefined) {
          const existing = selectRow(
            database,
            "SELECT version FROM plans WHERE id = ?",
            [parsed.id],
          );
          const currentVersion =
            existing === undefined || typeof existing.version !== "number"
              ? undefined
              : existing.version;
          if (currentVersion !== expectedVersion) {
            throw new RepositoryConflictError(
              `Plan '${parsed.id}' version changed`,
            );
          }
        }
        database.run(
          `INSERT INTO plans (id, project_id, version, status, created_at, payload)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             project_id = excluded.project_id,
             version = excluded.version,
             status = excluded.status,
             created_at = excluded.created_at,
             payload = excluded.payload`,
          [
            parsed.id,
            parsed.projectId,
            parsed.version,
            parsed.status,
            parsed.createdAt,
            encode(parsed),
          ],
        );
      }),
  };

  const changeSets: ChangeSetRepository = {
    get: (id) =>
      executor.read((database) =>
        decodeRow(
          changeSetSchema,
          selectRow(database, "SELECT payload FROM change_sets WHERE id = ?", [
            id,
          ]),
          "change set",
        ),
      ),
    findByCorrelationId: (correlationId) =>
      executor.read((database) =>
        decodeRow(
          changeSetSchema,
          selectRow(
            database,
            "SELECT payload FROM change_sets WHERE correlation_id = ?",
            [correlationId],
          ),
          "change set",
        ),
      ),
    listByProject: (projectId) =>
      executor.read((database) =>
        decodeRows(
          changeSetSchema,
          selectRows(
            database,
            `SELECT payload FROM change_sets
             WHERE project_id = ?
             ORDER BY created_at, id`,
            [projectId],
          ),
          "change set",
        ).sort(compareOrderedRecords()),
      ),
    save: (changeSet) =>
      executor.write((database) => {
        const parsed = changeSetSchema.parse(changeSet);
        const message = `Correlation '${parsed.correlationId}' already exists`;
        const conflicting = selectRow(
          database,
          "SELECT id FROM change_sets WHERE correlation_id = ? AND id <> ?",
          [parsed.correlationId, parsed.id],
        );
        if (conflicting !== undefined) {
          throw new RepositoryConflictError(message);
        }
        conflictGuard(
          () =>
            database.run(
              `INSERT INTO change_sets (
                 id, project_id, session_id, correlation_id, status, created_at, payload
               )
               VALUES (?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET
                 project_id = excluded.project_id,
                 session_id = excluded.session_id,
                 correlation_id = excluded.correlation_id,
                 status = excluded.status,
                 created_at = excluded.created_at,
                 payload = excluded.payload`,
              [
                parsed.id,
                parsed.projectId,
                parsed.sessionId,
                parsed.correlationId,
                parsed.status,
                parsed.createdAt,
                encode(parsed),
              ],
            ),
          message,
        );
      }),
  };

  const preferences: PreferenceRepository = {
    get: (sessionId, key) =>
      executor.read((database) =>
        decodeRow(
          preferenceSchema,
          selectRow(
            database,
            "SELECT payload FROM preferences WHERE session_id = ? AND key = ?",
            [sessionId, key],
          ),
          "preference",
        ),
      ),
    listBySession: (sessionId) =>
      executor.read((database) =>
        decodeRows(
          preferenceSchema,
          selectRows(
            database,
            `SELECT payload FROM preferences
             WHERE session_id = ?
             ORDER BY key`,
            [sessionId],
          ),
          "preference",
        ).sort(comparePreferenceKeys),
      ),
    save: (preference) =>
      executor.write((database) => {
        const parsed = preferenceSchema.parse(preference);
        database.run(
          `INSERT INTO preferences (session_id, key, updated_at, payload)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(session_id, key) DO UPDATE SET
             updated_at = excluded.updated_at,
             payload = excluded.payload`,
          [parsed.sessionId, parsed.key, parsed.updatedAt, encode(parsed)],
        );
      }),
  };

  const approvals: ApprovalRepository = {
    get: (id) =>
      executor.read((database) =>
        decodeRow(
          approvalDecisionSchema,
          selectRow(database, "SELECT payload FROM approvals WHERE id = ?", [
            id,
          ]),
          "approval decision",
        ),
      ),
    listBySubject: (subjectType, subjectId) =>
      executor.read((database) =>
        decodeRows(
          approvalDecisionSchema,
          selectRows(
            database,
            `SELECT payload FROM approvals
             WHERE subject_type = ? AND subject_id = ?
             ORDER BY decided_at, id`,
            [subjectType, subjectId],
          ),
          "approval decision",
        ).sort(compareOrderedRecords("decidedAt")),
      ),
    save: (decision) =>
      executor.write((database) => {
        const parsed = approvalDecisionSchema.parse(decision);
        database.run(
          `INSERT INTO approvals (
             id, project_id, session_id, subject_type, subject_id, decided_at, payload
           )
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             project_id = excluded.project_id,
             session_id = excluded.session_id,
             subject_type = excluded.subject_type,
             subject_id = excluded.subject_id,
             decided_at = excluded.decided_at,
             payload = excluded.payload`,
          [
            parsed.id,
            parsed.projectId,
            parsed.sessionId,
            parsed.subjectType,
            parsed.subjectId,
            parsed.decidedAt,
            encode(parsed),
          ],
        );
      }),
  };

  return { sessions, projects, plans, changeSets, preferences, approvals };
}

export interface SqliteProjectStateStoreOptions {
  /**
   * File that holds the database. Omit the option or pass `:memory:` for an
   * in-memory database that is never written to disk.
   */
  readonly path?: string;
  /** Write the database file after every committed write. Defaults to true. */
  readonly autoFlush?: boolean;
}

/**
 * Durable {@link ProjectStateStore} backed by SQLite compiled to WebAssembly,
 * so no native module is required on any supported Node runtime.
 *
 * Every operation is serialized through a single queue, and each write runs in
 * a real SQLite transaction. Repository calls made inside a
 * {@link SqliteProjectStateStore.transaction} callback join that transaction
 * instead of queueing behind it, while calls made elsewhere queue until the
 * transaction commits or rolls back.
 */
export class SqliteProjectStateStore implements ProjectStateStore {
  #database: Database;
  readonly #sql: SqlJsStatic;
  readonly #path: string | undefined;
  readonly #lock: FileHandle | undefined;
  readonly #lockPath: string | undefined;
  readonly #autoFlush: boolean;
  readonly #schemaVersion: number;
  readonly #context = new AsyncLocalStorage<TransactionScope>();
  readonly #repositories: ProjectStateRepositories;
  #tail: Promise<void> = Promise.resolve();
  #closed = false;

  private constructor(
    database: Database,
    sql: SqlJsStatic,
    path: string | undefined,
    lock: FileHandle | undefined,
    lockPath: string | undefined,
    autoFlush: boolean,
    schemaVersion: number,
  ) {
    this.#database = database;
    this.#sql = sql;
    this.#path = path;
    this.#lock = lock;
    this.#lockPath = lockPath;
    this.#autoFlush = autoFlush;
    this.#schemaVersion = schemaVersion;
    this.#repositories = createRepositories({
      read: (operation) => this.#perform(operation, false),
      write: (operation) => this.#perform(operation, true),
    });
  }

  public static async open(
    options: SqliteProjectStateStoreOptions = {},
  ): Promise<SqliteProjectStateStore> {
    const sql = await loadSqlJs();
    const path =
      options.path === undefined || options.path === ":memory:"
        ? undefined
        : resolve(options.path);
    const lockPath = path === undefined ? undefined : `${path}.lock`;
    if (path !== undefined) {
      await mkdir(dirname(path), { recursive: true });
    }
    const lock =
      lockPath === undefined ? undefined : await acquireDatabaseLock(lockPath);
    let existing: Uint8Array | undefined;
    try {
      existing = path === undefined ? undefined : await readDatabase(path);
    } catch (error) {
      await releaseDatabaseLock(lock, lockPath);
      throw error;
    }
    const database =
      existing === undefined ? new sql.Database() : new sql.Database(existing);
    let schemaVersion: number;
    try {
      schemaVersion = migrateProjectState(database);
    } catch (error) {
      database.close();
      await releaseDatabaseLock(lock, lockPath);
      throw error;
    }
    const store = new SqliteProjectStateStore(
      database,
      sql,
      path,
      lock,
      lockPath,
      options.autoFlush ?? true,
      schemaVersion,
    );
    if (path !== undefined) {
      try {
        await store.flush();
      } catch (error) {
        database.close();
        await releaseDatabaseLock(lock, lockPath);
        throw error;
      }
    }
    return store;
  }

  public get sessions(): SessionRepository {
    return this.#repositories.sessions;
  }

  public get projects(): ProjectRepository {
    return this.#repositories.projects;
  }

  public get plans(): PlanRepository {
    return this.#repositories.plans;
  }

  public get changeSets(): ChangeSetRepository {
    return this.#repositories.changeSets;
  }

  public get preferences(): PreferenceRepository {
    return this.#repositories.preferences;
  }

  public get approvals(): ApprovalRepository {
    return this.#repositories.approvals;
  }

  /** Absolute database path, or undefined for an in-memory database. */
  public get databasePath(): string | undefined {
    return this.#path;
  }

  /** Schema version applied by the migration runner when the store opened. */
  public get schemaVersion(): number {
    return this.#schemaVersion;
  }

  public get isOpen(): boolean {
    return !this.#closed;
  }

  public transaction<T>(
    operation: (repositories: ProjectStateRepositories) => Promise<T>,
  ): Promise<T> {
    if (this.#context.getStore() !== undefined) {
      return Promise.reject(
        new Error("Project state transactions cannot be nested"),
      );
    }
    return this.#enqueue(async () => {
      this.#assertOpen();
      const scope = new TransactionScope();
      const repositories = createRepositories({
        read: async (task) => this.#runScoped(scope, task),
        write: async (task) => this.#runScoped(scope, task),
      });
      const snapshot = this.#database.export();
      let committed = false;
      this.#database.run("BEGIN IMMEDIATE");
      try {
        const value = await this.#context.run(scope, () =>
          operation(repositories),
        );
        this.#database.run("COMMIT");
        committed = true;
        scope.close();
        await this.#persist();
        return value;
      } catch (error) {
        scope.close();
        if (committed) {
          this.#restore(snapshot);
        } else {
          this.#database.run("ROLLBACK");
        }
        throw error;
      }
    });
  }

  /** Writes the current database to its file atomically. */
  public flush(): Promise<void> {
    if (this.#path === undefined) {
      return Promise.resolve();
    }
    if (this.#context.getStore() !== undefined) {
      return Promise.reject(
        new Error("Project state cannot be flushed inside a transaction"),
      );
    }
    return this.#enqueue(async () => {
      this.#assertOpen();
      await this.#writeDatabaseFile();
    });
  }

  /** Flushes pending state and releases the database. Safe to call twice. */
  public close(): Promise<void> {
    if (this.#closed) {
      return Promise.resolve();
    }
    if (this.#context.getStore() !== undefined) {
      return Promise.reject(
        new Error("Project state cannot be closed inside a transaction"),
      );
    }
    return this.#enqueue(async () => {
      if (this.#closed) {
        return;
      }
      if (this.#path !== undefined) {
        await this.#writeDatabaseFile();
      }
      this.#database.close();
      this.#closed = true;
      await releaseDatabaseLock(this.#lock, this.#lockPath);
    });
  }

  #runScoped<T>(scope: TransactionScope, task: (database: Database) => T): T {
    scope.assertActive();
    this.#assertOpen();
    return task(this.#database);
  }

  #perform<T>(
    operation: (database: Database) => T,
    isWrite: boolean,
  ): Promise<T> {
    const scope = this.#context.getStore();
    if (scope !== undefined) {
      return new Promise<T>((resolve) => {
        resolve(this.#runScoped(scope, operation));
      });
    }
    return this.#enqueue(async () => {
      this.#assertOpen();
      if (!isWrite) {
        return operation(this.#database);
      }
      const snapshot = this.#database.export();
      this.#database.run("BEGIN IMMEDIATE");
      let committed = false;
      let value: T;
      try {
        value = operation(this.#database);
        this.#database.run("COMMIT");
        committed = true;
        await this.#persist();
      } catch (error) {
        if (committed) {
          this.#restore(snapshot);
        } else {
          this.#database.run("ROLLBACK");
        }
        throw error;
      }
      return value;
    });
  }

  #enqueue<T>(job: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(job);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #persist(): Promise<void> {
    if (this.#path === undefined || !this.#autoFlush) {
      return;
    }
    await this.#writeDatabaseFile();
  }

  async #writeDatabaseFile(): Promise<void> {
    const path = this.#path;
    if (path === undefined) {
      return;
    }
    const bytes = this.#database.export();
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
    await syncDirectory(dirname(path));
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error("The project state store is closed");
    }
  }

  #restore(snapshot: Uint8Array): void {
    this.#database.close();
    this.#database = new this.#sql.Database(snapshot);
  }
}

async function acquireDatabaseLock(path: string): Promise<FileHandle> {
  try {
    return await createDatabaseLock(path);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      (error as NodeJS.ErrnoException).code !== "EEXIST"
    ) {
      throw error;
    }
    return reclaimDatabaseLock(path);
  }
}

async function createDatabaseLock(path: string): Promise<FileHandle> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(String(process.pid), "utf8");
    await handle.sync();
    return handle;
  } catch (error) {
    await handle.close();
    await rm(path, { force: true });
    throw error;
  }
}

async function reclaimDatabaseLock(path: string): Promise<FileHandle> {
  const recoveryPath = `${path}.recovery`;
  let recovery: FileHandle;
  try {
    recovery = await createDatabaseLock(recoveryPath);
  } catch (error) {
    if (
      error instanceof Error &&
      (error as NodeJS.ErrnoException).code === "EEXIST"
    ) {
      throw new RepositoryConflictError(
        `Project state database lock recovery is already in progress: ${path.slice(0, -5)}`,
      );
    }
    throw error;
  }

  try {
    const owner = await readLockOwner(path);
    if (owner !== undefined && isProcessAlive(owner)) {
      throw new RepositoryConflictError(
        `Project state database is already open: ${path.slice(0, -5)}`,
      );
    }
    await rm(path, { force: true });
    return await createDatabaseLock(path);
  } catch (error) {
    if (error instanceof RepositoryConflictError) throw error;
    throw new RepositoryConflictError(
      `Project state database lock could not be reclaimed: ${path.slice(0, -5)}`,
    );
  } finally {
    await releaseDatabaseLock(recovery, recoveryPath);
  }
}

async function readLockOwner(path: string): Promise<number | undefined> {
  try {
    const owner = Number.parseInt(await readFile(path, "utf8"), 10);
    return Number.isInteger(owner) && owner > 0 ? owner : undefined;
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function releaseDatabaseLock(
  handle: FileHandle | undefined,
  path: string | undefined,
): Promise<void> {
  if (handle === undefined || path === undefined) return;
  await handle.close();
  await rm(path, { force: true });
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

async function readDatabase(path: string): Promise<Uint8Array | undefined> {
  try {
    const bytes = await readFile(path);
    return bytes.byteLength === 0 ? undefined : new Uint8Array(bytes);
  } catch (error) {
    if (isMissingFile(error)) {
      return undefined;
    }
    throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch {
    // Directory synchronization is a durability hint and is not supported on
    // every platform; the rename itself already published the new database.
  } finally {
    await handle?.close();
  }
}
