# Local Storage Layout

This document is the canonical source of truth for application-owned local
storage. New persistence must follow this layout instead of selecting an
independent Electron, operating-system, repository, or home-directory path.

## Canonical root and profiles

The default root is:

```text
~/.live-agent/
```

Root-owned profile selection and editable System Scope artifacts are stored
outside individual profiles:

```text
~/.live-agent/config/profiles.json
~/.live-agent/system/agents/
~/.live-agent/system/skills/
~/.live-agent/system/artifact-state/{agents,skills}.json
```

`LIVE_AGENT_HOME` may override the root with an absolute path for tests,
portable environments, automation, and recovery. Data is isolated below a
profile:

```text
~/.live-agent/profiles/{profile}/
```

Profile selection follows these rules:

- packaged applications use `default`;
- development applications use `development`;
- isolated Desktop automation uses its automation-owned root and the
  `automation` profile; and
- `LIVE_AGENT_PROFILE` may select another filesystem-safe profile.

The shared resolver in `@ableton-agent/storage` owns these decisions. Callers
must consume its typed paths rather than reconstructing them.
App-session paths require a `SessionStorageOwnershipContext` containing
`liveSetId`, optional `liveProjectId`, and `sessionId`; a session ID alone is
never sufficient and no flat session-state compatibility path is exposed.

## Required directory structure

```text
~/.live-agent/
├── storage-version.json
└── profiles/
    ├── default/
    │   ├── storage-migration-v2.json
    │   ├── config/
    │   │   └── preferences.json
    │   ├── state/
    │   │   ├── sessions.json
    │   │   ├── live-set-sessions.json
    │   │   └── live-projects.json
    │   ├── credentials/
    │   │   └── {credential-key}
    │   ├── copilot/
    │   │   └── {Copilot SDK-owned data}
    │   ├── observability/
    │   │   ├── event-history.sqlite
    │   │   └── event-history.sqlite.lock
    │   ├── logs/
    │   │   └── desktop.log
    │   ├── agents/
    │   ├── skills/
    │   ├── artifact-state/
    │   │   ├── agents.json
    │   │   └── skills.json
    │   ├── memory/
    │   ├── project-state/
    │   │   └── {project-id}/
    │   │       ├── project.json
    │   │       ├── memory/
    │   │       ├── agents/
    │   │       ├── skills/
    │   │       ├── artifact-state/
    │   │       │   ├── agents.json
    │   │       │   └── skills.json
    │   │       └── live-set-state/
    │   │           └── {live-set-id}/
    │   │               ├── live-set.json
    │   │               ├── memory/
    │   │               └── session-state/
    │   │                   └── {app-session-id}/
    │   │                       └── {session-owned contents below}
    │   └── unassigned-live-set-state/
    │       └── {live-set-id}/
    │           ├── live-set.json
    │           ├── memory/
    │           └── session-state/
    │               └── {app-session-id}/
    │                   ├── session.json
    │                   ├── memory/
    │                   ├── agents/
    │                   ├── skills/
    │                   ├── artifact-state/
    │                   │   ├── agents.json
    │                   │   └── skills.json
    │                   └── artifacts/
    │                       └── plan.md
    ├── development/
    │   └── {same profile layout}
    └── automation/
        └── {same profile layout under the automation-owned root}
```

Lock and temporary files created beside an owned file are implementation
details. They must remain within the owning component directory and be cleaned
up or recovered atomically.

## Ownership by directory

| Path | Owner | Contents and rules |
| --- | --- | --- |
| `storage-version.json` | `@ableton-agent/storage` | Root layout version only. It is independent of application-data schema versions. |
| `config/profiles.json` | Profile registry | Versioned visible-profile registry and selected packaged-app profile. Reserved development and automation profiles are hidden. |
| `system/` | Scoped artifact manager | Editable System Scope agent and skill additions, overrides, and tombstones. Bundled resources remain immutable fallback content. |
| `config/` | Desktop/application configuration | Validated, non-secret preferences, including the global Off/Concise/Detailed agent reasoning-summary visibility setting. |
| `state/` | Desktop production-session stores | Validated app-session records, Live Set associations, and the bounded, revision-checked Live Projects registry. |
| `credentials/` | Main process secure store | Ciphertext encrypted through OS-backed facilities. Credentials never enter renderer state, logs, journal payloads, or support bundles. |
| `copilot/` | Copilot SDK adapter | SDK conversation/session data. Application code must not invent a parallel transcript store. |
| `observability/` | Local observability journal | One profile-wide SQLite journal for cross-session queries, traces, retention, and health. Do not create one journal per production session. |
| `logs/` | Structured diagnostic logger | Bounded, redacted newline-delimited JSON logs. |
| `memory/` | Reserved ownership scope | Reserved at profile, project, Live Set, and app-session scopes. No memory persistence behavior is defined yet. |
| `project-state/{project-id}/` | Live Project ownership | Project metadata, reserved memory, and child Live Sets. Project association must be explicit; storage never infers it. |
| `project-state/{project-id}/live-set-state/{live-set-id}/` | Project-owned Live Set persistence | Live Set metadata, reserved memory, and nested app sessions. |
| `unassigned-live-set-state/{live-set-id}/` | Unassigned Live Set persistence | Live Sets without a known Live Project, including all migrated legacy sets. |
| `*/session-state/{app-session-id}/` | App-session persistence | Bounded ownership manifest plus session-owned artifacts. `artifacts/plan.md` is the shared planning document for the app session. |

Profile, Project, and app-session `agents/`, `skills/`, and `artifact-state/`
files implement copy-on-write scoped customization. Effective resolution is
Session, then Project when assigned, then Profile, then System, then bundled
fallback. Project artifact resolution requires a typed `liveProjectId`
ownership context. See [Scoped Profiles](scoped-profiles.md).

An active session for an unsaved Live Set may exist only in Desktop memory and
therefore be absent from `state/sessions.json`. Profiles still presents that
session as an in-memory active destination. The first Session-scope artifact
publication or transfer persists the session record and creates its canonical
`unassigned-live-set-state/{live-set-id}/session-state/{app-session-id}/`
directories. Conversation history
alone remains Copilot SDK-owned and does not promote the Desktop session.

## Data that intentionally remains outside the root

- The installed Remote Script token remains in the managed Ableton Remote
  Script directory because Live must read it. Desktop may copy it into the
  encrypted credential vault.
- User-selected exports and support bundles are written only to the explicit
  destination selected by the user.
- Build, test, and release artifacts remain in their repository-defined or
  temporary locations and are not runtime application state.
- Operating-system keychain material used by Electron `safeStorage` remains
  operating-system managed.

## Security and durability invariants

- Create profile directories with owner-only permissions and persisted files
  with owner read/write permissions.
- Validate root/profile overrides and reject traversal, filesystem-root
  targets, and unsafe profile names.
- Do not follow or migrate symbolic links into the canonical store.
- Sanitize and bound persisted payloads. Redact credentials embedded in every
  string and replace binary/audio bodies with visible omission markers.
- Persist only the reasoning-summary preference, never model reasoning text, in
  `config/preferences.json`. Bounded, redacted Working summaries belong in the
  profile-wide observability journal and typed renderer history.
- Keep renderer access typed and redacted. Never expose raw filesystem access,
  raw SQLite access, or a generic storage IPC channel.
- Keep one writer lock per profile-wide journal. A second writer degrades with
  an actionable diagnostic instead of forking or corrupting history.
- Publish files atomically and preserve the prior valid state when validation,
  migration, or publication fails.
- Plan artifact updates require the current SHA-256 revision once the file
  exists. The application rejects stale or missing expected revisions rather
  than silently overwriting concurrent agent or user edits.
- Do not add a network upload path. Anonymous product telemetry is a separate,
  opt-in facility and is disabled unless explicitly implemented and consented.

## Migration contract

Legacy Electron application-data/log locations and
`~/.ableton-agent/copilot` migrate through a staged copy:

1. Discover legacy components.
2. Copy existing canonical data into staging when a profile already contains
   non-conflicting client data.
3. Copy legacy components only when their destination is absent.
4. Validate known JSON and SQLite files.
5. Harden permissions and reject symbolic links.
6. Atomically publish the complete profile.
7. Write the migration marker and retain legacy sources for rollback.

A destination conflict or corrupt source fails without overwriting either side.
Migration emits application-owned queued, started, progress, completed, failed,
and cancelled lifecycle events with trace, correlation, causation, attribution,
and timing. Bootstrap records are mirrored to the structured log and replayed
into Desktop History after the journal opens.

### Storage v1 to v2 nested-layout migration

The v1-to-v2 migration is operator invoked. Runtime startup does not migrate or
silently reinterpret storage.

```sh
# Dry-run is the default.
LIVE_AGENT_HOME="$HOME/.live-agent" \
  pnpm --filter @ableton-agent/storage migrate:v2 -- --profile default

# Apply after reviewing the report.
LIVE_AGENT_HOME="$HOME/.live-agent" \
  pnpm --filter @ableton-agent/storage migrate:v2 -- --profile default --apply
```

`LIVE_AGENT_PROFILE` is honored when `--profile` is omitted. The command:

1. requires a complete supported v1 layout and refuses missing version markers,
   mixed v1/v2 paths, symbolic links, and incomplete session directories;
2. creates `backups/storage-v1-{timestamp}/{profile}` and backs up the root
   version marker before changing profile data;
3. atomically renames top-level legacy `projectId`/`projectName` session fields
   to `liveSetId`/`liveSetName`, upgrades the session collection to v4, and
   populates missing immutable `createdAt` values from `updatedAt`;
4. renames `state/project-sessions.json` to
   `state/live-set-sessions.json`;
5. groups complete legacy session directories below
   `unassigned-live-set-state/{live-set-id}/session-state/`, never inferring a
   Live Project;
6. creates the empty bounded Live Projects registry and reserved `memory/`
   ownership directories; and
7. publishes the root storage version only after every profile with legacy
   session data has been migrated.

Run the command once for each legacy profile. Until the last profile is
migrated, the root remains marked as v1 and Desktop startup continues to fail
closed rather than accepting a mixed layout.

Using legacy `updatedAt` as `createdAt` is an explicit approximation because v3
did not retain the original creation time. Migrated sessions are ordered by
`createdAt`, with session ID as the deterministic tie-break, so user-facing
session numbering remains stable across repeated reads and migrations.

Reports are bounded. Validation or application failures return a nonzero exit
status, preserve the legacy profile, and retain any completed backup.

## Adding new persisted data

Before adding a file, database, cache, or directory:

1. Choose the owning directory from the table above. Extend the shared typed
   resolver only when no existing owner fits.
2. Define schema/version, size bounds, retention/deletion, atomicity, and
   concurrency behavior.
3. Define redaction and binary-omission behavior before persistence.
4. Add application-owned lifecycle and timing events for asynchronous work.
5. Expose only typed, redacted queries or diagnostics to Desktop.
6. Add tests for path safety, permissions, migration, ordering, redaction,
   failure/cancellation, trace propagation, cleanup, and restart behavior.
7. Update this document and the relevant feature specification and
   implementation to-do file.
