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
- [x] Store the shared production-session planning document at the nested
  `*/session-state/{app-session-id}/artifacts/plan.md` path through the shared
  resolver with owner-only permissions and atomic revision-checked writes.
- [x] Keep the event journal profile-wide rather than splitting it per session.
- [x] Rename fresh profile history storage to
  `observability/agent-set-event-history.sqlite` without migrating the former
  event-only database.
- [x] Physically separate App event/configuration tables, agent history tables,
  and Live Set history tables while exposing stable typed agent/Set views.
- [x] Expose bounded scalar, parameterized, worker-owned read-only SQL over the
  granular `agent_history_*` and `set_history_*` public views while rejecting
  physical tables, SQLite metadata, mutation statements, and multiple
  statements.
- [x] Keep v1 automatic age/size retention scoped to App events and
  configuration snapshots; retain agent and Live Set history until explicit
  clear.
- [x] Add root-owned profile registry and editable System Scope artifacts.
- [x] Add Profile and Session Scope agent/skill directories and tombstones.
- [ ] Preserve bundled agents and skills as immutable fallback resources.
- [x] Define strict Project -> Live Set -> app-session and unassigned Live Set
  physical paths, metadata contracts, and bounded Live Projects registry
  primitives.
- [x] Resolve Project Scope agents, skills, and tombstones under
  `project-state/{liveProjectId}/` from a required typed ownership context.
- [x] Reserve profile, project, Live Set, and app-session `memory/` ownership
  directories without defining memory behavior.

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
- [x] Add the operator-invoked, dry-run-by-default v1-to-v2 migration CLI.
- [x] Refuse unsupported and partial layouts, create backups before writes,
  rename legacy project fields and association filenames atomically, move
  complete legacy sessions under unassigned Live Sets, and publish the storage
  version last.
- [x] Populate missing immutable session `createdAt` values from legacy
  `updatedAt` and sort by creation time with session ID tie-breaks.
- [x] Keep nested-layout migration out of runtime startup.

## Visibility and tests

- [x] Surface typed storage version, root, profile, and migration diagnostics.
- [x] Include bounded storage diagnostics in local support bundles.
- [x] Cover path resolution, permissions, migration, conflicts, rollback,
  lifecycle events, Desktop History, and session manifests.
- [x] Cover typed agent session, turn, message, tool, approval, Live Set save,
  snapshot, and trajectory persistence, filtering, redaction, and bounds.
- [x] Cover plan artifact ownership, normalization, redaction, concurrent
  writers, and optimistic conflicts.
- [x] Document the canonical structure and require future persistence changes
  to follow it in repository Copilot instructions.
