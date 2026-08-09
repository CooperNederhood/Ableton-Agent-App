# ADR 0003: SQLite for Application Metadata

## Status

Accepted with implementation pending.

## Decision

Persist application-owned sessions, project identities, plans, change sets,
preferences, approvals, and operational diagnostics in a local SQLite
database. Ableton remains the source of truth for musical state; detailed
notes, audio, and project content are not duplicated by default.

The storage package exposes repository interfaces so runtime code does not
depend on a particular SQLite driver. Driver selection must support the
project's Node and desktop packaging matrix without weakening reproducibility.

## Consequences

- Migrations and compatibility checks are required before release.
- Tests use deterministic in-memory repositories until the portable driver is
  selected.
- Support bundles and telemetry can exclude musical content by construction.
