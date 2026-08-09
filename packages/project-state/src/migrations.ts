import type { Database } from "sql.js";

import { GENERATED_DATABASE_VERSION } from "./version.generated.js";

export interface ProjectStateMigration {
  readonly version: number;
  readonly description: string;
  readonly statements: readonly string[];
}

/**
 * Migration 1 creates the durable record tables. Rows keep the validated
 * record as a JSON payload; scalar columns exist only for keys, uniqueness,
 * and lookups. Musical detail never reaches these tables.
 */
const initialSchema: ProjectStateMigration = {
  version: 1,
  description: "Create application metadata tables",
  statements: [
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )`,
    `CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      payload TEXT NOT NULL
    )`,
    `CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      ableton_project_id TEXT NOT NULL,
      payload TEXT NOT NULL
    )`,
    `CREATE TABLE plans (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      payload TEXT NOT NULL
    )`,
    `CREATE TABLE change_sets (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      correlation_id TEXT NOT NULL,
      payload TEXT NOT NULL
    )`,
    `CREATE TABLE preferences (
      session_id TEXT NOT NULL,
      key TEXT NOT NULL,
      payload TEXT NOT NULL,
      PRIMARY KEY (session_id, key)
    )`,
    `CREATE TABLE approvals (
      id TEXT PRIMARY KEY,
      subject_type TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      payload TEXT NOT NULL
    )`,
  ],
};

/**
 * Migration 2 projects the columns the repositories query on, backfills them
 * from existing payloads, and adds the indexes and unique constraints that
 * mirror repository semantics. Cross-record foreign keys are deliberately
 * absent: Ableton owns musical state, so plans and change sets may outlive or
 * precede the project rows the application has observed.
 */
const projectionsAndConstraints: ProjectStateMigration = {
  version: 2,
  description: "Add lookup projections, indexes, and unique constraints",
  statements: [
    `ALTER TABLE sessions ADD COLUMN active_project_id TEXT`,
    `ALTER TABLE sessions ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''`,
    `UPDATE sessions SET
      active_project_id = json_extract(payload, '$.activeProjectId'),
      updated_at = COALESCE(json_extract(payload, '$.updatedAt'), '')`,
    `ALTER TABLE projects ADD COLUMN last_seen_at TEXT NOT NULL DEFAULT ''`,
    `UPDATE projects SET
      last_seen_at = COALESCE(json_extract(payload, '$.lastSeenAt'), '')`,
    `ALTER TABLE plans ADD COLUMN status TEXT NOT NULL DEFAULT 'draft'`,
    `ALTER TABLE plans ADD COLUMN created_at TEXT NOT NULL DEFAULT ''`,
    `UPDATE plans SET
      status = COALESCE(json_extract(payload, '$.status'), 'draft'),
      created_at = COALESCE(json_extract(payload, '$.createdAt'), '')`,
    `ALTER TABLE change_sets ADD COLUMN session_id TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE change_sets ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'`,
    `ALTER TABLE change_sets ADD COLUMN created_at TEXT NOT NULL DEFAULT ''`,
    `UPDATE change_sets SET
      session_id = COALESCE(json_extract(payload, '$.sessionId'), ''),
      status = COALESCE(json_extract(payload, '$.status'), 'pending'),
      created_at = COALESCE(json_extract(payload, '$.createdAt'), '')`,
    `ALTER TABLE preferences ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''`,
    `UPDATE preferences SET
      updated_at = COALESCE(json_extract(payload, '$.updatedAt'), '')`,
    `ALTER TABLE approvals ADD COLUMN project_id TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE approvals ADD COLUMN session_id TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE approvals ADD COLUMN decided_at TEXT NOT NULL DEFAULT ''`,
    `UPDATE approvals SET
      project_id = COALESCE(json_extract(payload, '$.projectId'), ''),
      session_id = COALESCE(json_extract(payload, '$.sessionId'), ''),
      decided_at = COALESCE(json_extract(payload, '$.decidedAt'), '')`,
    `CREATE UNIQUE INDEX projects_ableton_project_id
      ON projects (ableton_project_id)`,
    `CREATE INDEX sessions_active_project_id
      ON sessions (active_project_id)`,
    `CREATE INDEX plans_project_id ON plans (project_id, created_at, id)`,
    `CREATE UNIQUE INDEX change_sets_correlation_id
      ON change_sets (correlation_id)`,
    `CREATE INDEX change_sets_project_id
      ON change_sets (project_id, created_at, id)`,
    `CREATE INDEX change_sets_session_id ON change_sets (session_id)`,
    `CREATE INDEX approvals_subject
      ON approvals (subject_type, subject_id, decided_at, id)`,
    `CREATE INDEX approvals_project_id ON approvals (project_id)`,
  ],
};

export const projectStateMigrations: readonly ProjectStateMigration[] = [
  initialSchema,
  projectionsAndConstraints,
];

export const projectStateSchemaVersion: number = projectStateMigrations.reduce(
  (highest, migration) => Math.max(highest, migration.version),
  0,
);

if (projectStateSchemaVersion !== GENERATED_DATABASE_VERSION) {
  throw new Error(
    `Configured database version ${GENERATED_DATABASE_VERSION} does not match migration version ${projectStateSchemaVersion}`,
  );
}

export class SchemaVersionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "SchemaVersionError";
  }
}

function appliedVersions(database: Database): Set<number> {
  const statement = database.prepare("SELECT version FROM schema_migrations");
  try {
    const versions = new Set<number>();
    while (statement.step()) {
      const [version] = statement.get();
      if (typeof version === "number") {
        versions.add(version);
      }
    }
    return versions;
  } finally {
    statement.free();
  }
}

/**
 * Applies every pending migration in one transaction per version and records
 * it in the versioned migration table. Returns the resulting schema version.
 */
export function migrateProjectState(
  database: Database,
  now: () => string = () => new Date().toISOString(),
): number {
  database.run(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    description TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const applied = appliedVersions(database);
  const current = [...applied].reduce(
    (highest, version) => Math.max(highest, version),
    0,
  );
  if (current > projectStateSchemaVersion) {
    throw new SchemaVersionError(
      `Database schema version ${current} is newer than supported version ${projectStateSchemaVersion}`,
    );
  }
  for (const migration of projectStateMigrations) {
    if (applied.has(migration.version)) {
      continue;
    }
    database.run("BEGIN IMMEDIATE");
    try {
      for (const statement of migration.statements) {
        database.run(statement);
      }
      database.run(
        "INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)",
        [migration.version, migration.description, now()],
      );
      database.run("COMMIT");
    } catch (error) {
      database.run("ROLLBACK");
      throw error;
    }
  }
  database.run(`PRAGMA user_version = ${projectStateSchemaVersion}`);
  return projectStateSchemaVersion;
}
