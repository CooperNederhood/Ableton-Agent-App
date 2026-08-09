# ADR 0003: SQLite for Application Metadata

## Status

Accepted.

## Decision

Persist application-owned sessions, project identities, plans, change sets,
preferences, approvals, and operational diagnostics in a local SQLite
database. Ableton remains the source of truth for musical state; detailed
notes, audio, and project content are not duplicated by default.

The storage package exposes repository interfaces so runtime code does not
depend on a particular SQLite driver. `sql.js`, SQLite compiled to
WebAssembly, is the selected driver: it is a plain JavaScript dependency that
needs no native build step, so it satisfies the project's Node and desktop
packaging matrix without weakening reproducibility.

## Consequences

- Migrations and compatibility checks are required before release. The storage
  package owns a versioned migration table and applies pending migrations when
  a database is opened.
- The deterministic in-memory repositories remain available, and the SQLite
  store also runs fully in memory for tests.
- Databases are held in memory and published to disk atomically through a
  temporary file and a rename, so writes are all-or-nothing.
- File-backed stores use an exclusive PID lock. Stale locks are reclaimed
  under a separate recovery lock so simultaneous openers cannot both assume
  ownership of the same database image.
- Support bundles and telemetry can exclude musical content by construction.
