import type { Database } from "sql.js";

import { JournalSchemaVersionError } from "./errors.js";

export interface ObservabilityMigration {
  readonly version: number;
  readonly description: string;
  readonly statements: readonly string[];
}

export const observabilityMigrations: readonly ObservabilityMigration[] = [
  {
    version: 1,
    description: "Create the local observability journal",
    statements: [
      `CREATE TABLE IF NOT EXISTS observability_schema_migrations (
        version INTEGER PRIMARY KEY,
        description TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )`,
      `CREATE TABLE telemetry_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        contract_version INTEGER NOT NULL,
        occurred_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        name TEXT NOT NULL,
        category TEXT,
        source TEXT NOT NULL,
        stage TEXT,
        level TEXT NOT NULL,
        outcome TEXT,
        correlation_id TEXT,
        causation_id TEXT,
        trace_id TEXT,
        span_id TEXT,
        parent_span_id TEXT,
        root_trace_id TEXT NOT NULL,
        project_id TEXT,
        session_id TEXT,
        active_agent_id TEXT,
        live_event_id TEXT,
        output_id TEXT,
        tool_name TEXT,
        duration_ms REAL,
        payload TEXT NOT NULL
      )`,
      `CREATE TABLE configuration_snapshots (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        snapshot_id TEXT NOT NULL UNIQUE,
        contract_version INTEGER NOT NULL,
        captured_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        component TEXT NOT NULL,
        configuration_version TEXT NOT NULL,
        project_id TEXT,
        session_id TEXT,
        active_agent_id TEXT,
        payload TEXT NOT NULL
      )`,
      `CREATE INDEX telemetry_events_occurred
        ON telemetry_events (occurred_at, sequence)`,
      `CREATE INDEX telemetry_events_trace
        ON telemetry_events (trace_id, sequence)`,
      `CREATE INDEX telemetry_events_root_trace
        ON telemetry_events (root_trace_id, sequence)`,
      `CREATE INDEX telemetry_events_name
        ON telemetry_events (name, sequence)`,
      `CREATE INDEX telemetry_events_category
        ON telemetry_events (category, sequence)`,
      `CREATE INDEX telemetry_events_source
        ON telemetry_events (source, sequence)`,
      `CREATE INDEX telemetry_events_stage
        ON telemetry_events (stage, sequence)`,
      `CREATE INDEX telemetry_events_level
        ON telemetry_events (level, sequence)`,
      `CREATE INDEX telemetry_events_outcome
        ON telemetry_events (outcome, sequence)`,
      `CREATE INDEX telemetry_events_session
        ON telemetry_events (session_id, sequence)`,
      `CREATE INDEX telemetry_events_correlation
        ON telemetry_events (correlation_id, sequence)`,
      `CREATE INDEX telemetry_events_project
        ON telemetry_events (project_id, sequence)`,
      `CREATE INDEX telemetry_events_active_agent
        ON telemetry_events (active_agent_id, sequence)`,
      `CREATE INDEX telemetry_events_live_event
        ON telemetry_events (live_event_id, sequence)`,
      `CREATE INDEX telemetry_events_output
        ON telemetry_events (output_id, sequence)`,
      `CREATE INDEX telemetry_events_tool
        ON telemetry_events (tool_name, sequence)`,
      `CREATE INDEX configuration_snapshots_captured
        ON configuration_snapshots (captured_at, sequence)`,
      `CREATE INDEX configuration_snapshots_component
        ON configuration_snapshots (component, sequence)`,
      `CREATE INDEX configuration_snapshots_session
        ON configuration_snapshots (session_id, sequence)`,
      `CREATE INDEX configuration_snapshots_project
        ON configuration_snapshots (project_id, sequence)`,
      `CREATE INDEX configuration_snapshots_active_agent
        ON configuration_snapshots (active_agent_id, sequence)`,
    ],
  },
  {
    version: 2,
    description:
      "Attribute observability records to Live Sets and optional Live Projects",
    statements: [
      `DROP INDEX IF EXISTS telemetry_events_project`,
      `DROP INDEX IF EXISTS configuration_snapshots_project`,
      `ALTER TABLE telemetry_events RENAME COLUMN project_id TO live_set_id`,
      `ALTER TABLE telemetry_events ADD COLUMN live_project_id TEXT`,
      `ALTER TABLE configuration_snapshots RENAME COLUMN project_id TO live_set_id`,
      `ALTER TABLE configuration_snapshots ADD COLUMN live_project_id TEXT`,
      `UPDATE telemetry_events
        SET contract_version = 2,
            payload = CASE
              WHEN json_type(payload, '$.projectId') IS NULL
                THEN json_set(payload, '$.version', 2)
              ELSE json_set(
                json_remove(payload, '$.projectId'),
                '$.version', 2,
                '$.liveSetId', json_extract(payload, '$.projectId')
              )
            END`,
      `UPDATE configuration_snapshots
        SET contract_version = 2,
            payload = CASE
              WHEN json_type(payload, '$.projectId') IS NULL
                THEN json_set(payload, '$.version', 2)
              ELSE json_set(
                json_remove(payload, '$.projectId'),
                '$.version', 2,
                '$.liveSetId', json_extract(payload, '$.projectId')
              )
            END`,
      `CREATE INDEX telemetry_events_live_set
        ON telemetry_events (live_set_id, sequence)`,
      `CREATE INDEX telemetry_events_live_project
        ON telemetry_events (live_project_id, sequence)`,
      `CREATE INDEX configuration_snapshots_live_set
        ON configuration_snapshots (live_set_id, sequence)`,
      `CREATE INDEX configuration_snapshots_live_project
        ON configuration_snapshots (live_project_id, sequence)`,
    ],
  },
];

export const observabilitySchemaVersion = observabilityMigrations.reduce(
  (highest, migration) => Math.max(highest, migration.version),
  0,
);

function appliedVersions(database: Database): Set<number> {
  const statement = database.prepare(
    "SELECT version FROM observability_schema_migrations",
  );
  try {
    const versions = new Set<number>();
    while (statement.step()) {
      const [version] = statement.get();
      if (typeof version === "number") versions.add(version);
    }
    return versions;
  } finally {
    statement.free();
  }
}

export function migrateObservabilityJournal(
  database: Database,
  now: () => string = () => new Date().toISOString(),
): number {
  database.run(`CREATE TABLE IF NOT EXISTS observability_schema_migrations (
    version INTEGER PRIMARY KEY,
    description TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const applied = appliedVersions(database);
  const current = [...applied].reduce(
    (highest, version) => Math.max(highest, version),
    0,
  );
  if (current > observabilitySchemaVersion) {
    throw new JournalSchemaVersionError(
      `Observability database schema version ${current} is newer than supported version ${observabilitySchemaVersion}`,
    );
  }
  for (const migration of observabilityMigrations) {
    if (applied.has(migration.version)) continue;
    database.run("BEGIN IMMEDIATE");
    try {
      for (const statement of migration.statements) database.run(statement);
      database.run(
        `INSERT INTO observability_schema_migrations
          (version, description, applied_at) VALUES (?, ?, ?)`,
        [migration.version, migration.description, now()],
      );
      database.run("COMMIT");
    } catch (error) {
      database.run("ROLLBACK");
      throw error;
    }
  }
  database.run(`PRAGMA user_version = ${observabilitySchemaVersion}`);
  return observabilitySchemaVersion;
}
