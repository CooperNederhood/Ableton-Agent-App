# Project State Implementation To-Do

Companion specification: [Project State](project-state.md)

## Models and storage

- [x] Define project identity, snapshot, entity reference, revision, production
  plan, and change-set schemas.
- [x] Create SQLite schema and migration tooling.
- [x] Implement repositories for sessions, projects, plans, change sets,
  preferences, and approvals.
- [x] Keep detailed musical content out of persistent metadata unless needed.

## Snapshot and cache

- [x] Implement normalized snapshot ingestion.
- [x] Implement entity indexes and targeted stale markers.
- [x] Apply Remote Script events with revision checks.
- [x] Detect sequence gaps and trigger targeted/full refresh.
- [x] Implement on-demand clip-note and parameter detail caches.
- [x] Prevent stale or ambiguous references from reaching mutations.

## Plans and change sets

- [x] Implement production plan create/update/approve/status transitions.
- [x] Implement change-set creation and correlation.
- [x] Capture minimal before-state and completed mutation records.
- [x] Persist verification, warnings, failures, and recovery data.
- [x] Expose state through presentation-independent application services.

## Tests

- [x] Unit-test reducers, indexes, revisions, and invalidation.
- [x] Unit-test plan and change-set state machines.
- [x] Test SQLite migrations and repository transactions.
- [x] Integration-test event application and sequence-gap recovery.
- [x] Integration-test session resume and project switching.
- [x] Test that stale references are rejected before bridge mutation.

## Exit criteria

- [x] Ableton remains the authoritative musical state.
- [x] Agent context derives from explicit current state, not prose history.
- [x] Project switches cannot leak selections or plans.
- [x] Change sets provide a complete operation audit.

## SQLite persistence

`SqliteProjectStateStore` implements `ProjectStateStore` on top of `sql.js`,
SQLite compiled to WebAssembly. The driver is a plain JavaScript dependency, so
every Node >=20 runtime and the desktop packaging matrix stay portable and
reproducible without a native module or a prebuilt binary.

- A versioned `schema_migrations` table records each applied migration, and the
  runner applies pending migrations in one transaction per version. Opening a
  database newer than the supported version fails with `SchemaVersionError`.
- Tables hold the validated record as a JSON payload plus the scalar columns
  used for keys, uniqueness, and lookups. Unique indexes cover Ableton project
  identity and change-set correlation; indexes cover project, session, and
  approval-subject queries. Musical detail is never projected into columns.
- Every payload is validated by the package schemas on write and on read.
- Operations are serialized, each write runs in a real
  `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK` transaction, plans keep optimistic
  `expectedVersion` checks, and the database file is published atomically
  through a temporary file and a rename.
- File-backed stores hold an exclusive PID lock, reject concurrent live
  owners, and reclaim stale locks under a separate recovery lock.
- Passing no path (or `:memory:`) keeps the database in memory for tests.

Repository parity, transaction rollback, conflict, migration, and reopen
persistence behavior are covered by `packages/project-state/src/sqlite.test.ts`.
