# ADR 0003: SQLite for Application Data

## Status

Accepted.

## Decision

Store the app's growing, queryable data (the event journal, Set history and
listening context) in local SQLite databases. Small settings files such as
preferences and agent definitions stay as JSON. Ableton stays the
source of truth for musical state; the app doesn't copy notes, audio or
project content by default.

Use `sql.js` (SQLite compiled to WebAssembly). It's plain JavaScript, so there
is no native build step for Node, Electron or packaging.

The event journal lives in `observability/agent-set-event-history.sqlite` in
the profile folder. It stores sanitized, size-bounded records of prompts,
responses, tool calls and Live events, with credentials redacted and audio
omitted.

## Consequences

- Each database's owning package (for the journal, `@ableton-agent/observability`)
  applies its schema migrations when the database is opened.
- Databases are held in memory and written to disk atomically (temp file plus
  rename). A PID lock stops two processes opening the same file.
- Tests can run the same store fully in memory.
- The journal is pruned by age and size so it can't grow without limit.
