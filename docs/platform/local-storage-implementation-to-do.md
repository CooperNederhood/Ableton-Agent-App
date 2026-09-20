# Local Storage Layout Implementation To-Do

Companion specification: [Local Storage Layout](local-storage.md)

## Canonical layout

- [x] Add the shared `@ableton-agent/storage` path resolver.
- [x] Default application-owned storage to `~/.live-agent`.
- [x] Isolate packaged, development, and automation profiles.
- [x] Support validated `LIVE_AGENT_HOME` and `LIVE_AGENT_PROFILE` overrides.
- [x] Store preferences, session metadata, credentials, Copilot SDK data,
  observability, logs, and per-session ownership in their defined directories.
- [x] Persist the global validated reasoning-summary visibility preference in
  profile-owned `config/preferences.json`; keep bounded Working content in the
  redacted observability journal rather than a parallel transcript store.
- [x] Store the shared production-session planning document at
  `session-state/{production-session-id}/artifacts/plan.md` through the shared
  resolver with owner-only permissions and atomic revision-checked writes.
- [x] Keep the event journal profile-wide rather than splitting it per session.
- [ ] Add root-owned profile registry and editable System Scope artifacts.
- [ ] Add Profile and Session Scope agent/skill directories and tombstones.
- [ ] Preserve bundled agents and skills as immutable fallback resources.

## Migration and safety

- [x] Stage, validate, permission-harden, and atomically publish legacy data.
- [x] Merge non-conflicting canonical client data and reject real destination
  conflicts without overwriting either side.
- [x] Retain legacy sources for rollback.
- [x] Emit and persist migration lifecycle, trace, causation, and timing.
- [x] Reject traversal, unsafe profile names, filesystem-root targets, and
  symbolic links.
- [x] Redact embedded credentials and enforce character/byte limits before
  publishing plan artifacts.

## Visibility and tests

- [x] Surface typed storage version, root, profile, and migration diagnostics.
- [x] Include bounded storage diagnostics in local support bundles.
- [x] Cover path resolution, permissions, migration, conflicts, rollback,
  lifecycle events, Desktop History, and session manifests.
- [x] Cover plan artifact ownership, normalization, redaction, concurrent
  writers, and optimistic conflicts.
- [x] Document the canonical structure and require future persistence changes
  to follow it in repository Copilot instructions.
