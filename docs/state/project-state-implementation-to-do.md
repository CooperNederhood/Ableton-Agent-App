# Project State Implementation To-Do

Companion specification: [Project State](project-state.md)

## Models and storage

- [x] Define project identity, snapshot, entity reference, revision, production
  plan, and change-set schemas.
- [ ] Create SQLite schema and migration tooling.
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
- [ ] Test SQLite migrations and repository transactions.
- [x] Integration-test event application and sequence-gap recovery.
- [x] Integration-test session resume and project switching.
- [x] Test that stale references are rejected before bridge mutation.

## Exit criteria

- [x] Ableton remains the authoritative musical state.
- [x] Agent context derives from explicit current state, not prose history.
- [x] Project switches cannot leak selections or plans.
- [x] Change sets provide a complete operation audit.

## SQLite blocker

The package provides typed repositories, deterministic in-memory persistence,
and transactional rollback. SQLite remains unchecked because `node:sqlite` is
not available across the repository's full Node >=20 support range. Adding a
third-party SQLite driver would introduce a native dependency and require
changes outside this package. Repository transaction behavior is covered by
tests; SQLite migration tests await a safe runtime-wide SQLite choice.
