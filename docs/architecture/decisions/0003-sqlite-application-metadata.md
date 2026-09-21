# ADR 0003: SQLite for Application Metadata

## Status

Accepted.

## Decision

Persist application-owned sessions, project identities, plans, change sets,
preferences, approvals, and operational diagnostics in a local SQLite
database. Ableton remains the source of truth for musical state; detailed
notes, audio, and project content are not duplicated by default.

The local detailed event journal uses the same storage abstractions and
migration ownership. It stores versioned, sanitized, append-oriented records
for agent configuration, SDK/tool activity, Live Event traces, and Output
delivery. Bounded prompts, responses, tool definitions/arguments/results, paths,
structured musical/MIDI data, and event payloads are required local history
content. Credentials embedded in strings are redacted, and binary/audio bodies
are replaced with visible omission markers.

The profile-wide database is named
`observability/agent-set-event-history.sqlite`. App events and configuration
snapshots, agent sessions/turns/messages/tool calls/results/approvals, and Live
Set saves/snapshots/trajectory records occupy separate physical tables. Typed
repositories read agent and Set timelines through stable `agent_history` and
`set_history` views. The former `event-history.sqlite` is not migrated into
this database.

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
- Support bundles can exclude project content independently of the required
  bounded, sanitized local journal.
- Journal repositories provide bounded asynchronous batches, indexed
  cursor/trace queries, 30-day pruning, and a 250 MiB profile cap. Storage
  implementations must demonstrate these semantics and must not make the
  in-memory image or atomic publication strategy block SDK, bridge, Live Event,
  or renderer critical paths at the cap.
- The journal remains local-only and default-on. Anonymous product telemetry
  consent and transport are separate concerns.
