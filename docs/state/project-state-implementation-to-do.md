# Project State Implementation To-Do

Companion specification: [Project State](project-state.md)

## Models and storage

- [ ] Define project identity, snapshot, entity reference, revision, production
  plan, and change-set schemas.
- [ ] Create SQLite schema and migration tooling.
- [ ] Implement repositories for sessions, projects, plans, change sets,
  preferences, and approvals.
- [ ] Keep detailed musical content out of persistent metadata unless needed.

## Snapshot and cache

- [ ] Implement normalized snapshot ingestion.
- [ ] Implement entity indexes and targeted stale markers.
- [ ] Apply Remote Script events with revision checks.
- [ ] Detect sequence gaps and trigger targeted/full refresh.
- [ ] Implement on-demand clip-note and parameter detail caches.
- [ ] Prevent stale or ambiguous references from reaching mutations.

## Plans and change sets

- [ ] Implement production plan create/update/approve/status transitions.
- [ ] Implement change-set creation and correlation.
- [ ] Capture minimal before-state and completed mutation records.
- [ ] Persist verification, warnings, failures, and recovery data.
- [ ] Expose state through presentation-independent application services.

## Tests

- [ ] Unit-test reducers, indexes, revisions, and invalidation.
- [ ] Unit-test plan and change-set state machines.
- [ ] Test SQLite migrations and repository transactions.
- [ ] Integration-test event application and sequence-gap recovery.
- [ ] Integration-test session resume and project switching.
- [ ] Test that stale references are rejected before bridge mutation.

## Exit criteria

- [ ] Ableton remains the authoritative musical state.
- [ ] Agent context derives from explicit current state, not prose history.
- [ ] Project switches cannot leak selections or plans.
- [ ] Change sets provide a complete operation audit.

