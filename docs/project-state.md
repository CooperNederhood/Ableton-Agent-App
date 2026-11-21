# Project State

This page explains what the app knows about your Live Set, and where that
knowledge lives. Live itself is always the source of truth for the music. The
app keeps **snapshots** (summaries of the Set at a moment), a searchable **Set
History**, and **entity context** (facts the app learned about specific clips
and tracks, such as listening measurements). Agent chat history is never
treated as project state.

## Three kinds of state

| Kind              | Owner                         | Examples                                                       |
| ----------------- | ----------------------------- | -------------------------------------------------------------- |
| Ableton state     | Live, read through the LOM    | Tracks, clips, devices, tempo, notes                           |
| Application state | The app (`~/.live-agent/...`) | App sessions, active agents, snapshots, Set History, entity context |
| Agent sessions    | The Copilot SDK               | One conversation and tool history per active agent             |

The **LOM** (Live Object Model) is Live's object API. See
[Live Connection](live-connection.md). For the folder layout on disk, see
[Storage](storage.md).

## Identity: Live Set, Live Project, App session

- **`liveSetId`** identifies one Set. For a saved Set it is a hash of the file
  path; an unsaved Set gets a temporary random ID. The Remote Script computes
  it (`remote-script/AbletonAgent/identity.py`).
- **`liveProjectId`** (optional) groups Sets in the same Live Project folder.
  It is only used for grouping, never for matching objects.
- An **App session** (also called a production session) is the app's working
  session for one Live Set: its active agents, their settings, and Live Event
  setup. `apps/desktop/src/main/live-set-session-store.ts` maps each saved
  `liveSetId` to its App session, so reopening a Set restores it.

When an unsaved Set is saved for the first time, its `liveSetId` changes from
the temporary ID to the path-based one. The Remote Script reports this as
`live_set.save_observed` with `firstSave: true`. The app then moves the App
session to the new ID before accepting the next message. Records written
earlier keep the old ID; they are not rewritten.

## Live Set snapshots

A snapshot is a bounded, normalized summary of the Set. The Desktop schema is
`liveSetSnapshotSchema` in `apps/desktop/src/contracts.ts`:

- identity (`liveSetId`, name, optional Live Project);
- tempo, time signature, transport, and Arrangement loop;
- tracks, scenes, Session clips, Arrangement clips, and cue points;
- top-level devices and their parameters;
- `completeness`: which areas were truncated or aren't supported.

Snapshots are built in two steps (`apps/desktop/src/main/headless-desktop-service.ts`):

1. **Core:** one `session.inspect` request gives tracks, clips, scenes, and
   transport.
2. **Enrichment:** device and parameter pages for each track, capped at 32
   devices per track and 64 parameters per device. If a newer refresh starts
   during enrichment, the older one stops.

`apps/desktop/src/main/snapshot-adapter.ts` turns protocol results into the
Desktop shape. Full note lists and every parameter of every device are never
in a snapshot. Agents read those on demand with tools.

A snapshot's `source` says why it was taken: `startup`, `internal`, `manual`
(the user pressed Refresh), or `save` (Live saved the Set). Only **manual**
and **save** snapshots are written to Set History. Startup and internal
refreshes update only the UI.

## Set History

Set History is a log of how a Set changed over time. It is stored in the
app's local journal database (`packages/observability`), next to agent
history. There are three record types:

| Record          | Written when                                                    | Holds                                                                                   |
| --------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `set_save`      | Live saves the Set, or the user presses Refresh                  | When it happened, file time/size, and the active agents                                 |
| `set_snapshot`  | Same moment as the save record                                  | The full bounded snapshot plus a content hash (`revision`)                              |
| `set_trajectory`| An agent's mutating tool call finishes; also one per active agent at each save | Tool, agent, turn, target, and outcome (`completed`, `failed`, `cancelled`, `indeterminate`) |

The snapshot writer is `createSnapshotHistoryRepository` in
`apps/desktop/src/main/composition.ts`. Tool trajectories are written in
`packages/runtime/src/composition.ts`. Taking a full snapshot after every edit
would be slow. Instead, the app stores snapshots at checkpoints and a small
record for each edit in between, which is enough to rebuild how the Set got
from one state to the next. Failed and uncertain edits are recorded too, so
history never implies an edit worked when it didn't.

### Searching history with SQL

Agents query history with the `set_sql_search` tool
(`packages/tools/src/set-sql-search.ts`):

- one `SELECT` (or `WITH … SELECT`) only; write keywords are rejected;
- only allowlisted views, such as `set_history_snapshots`,
  `set_history_tracks`, `set_history_devices`, `set_history_session_clips`,
  `set_history_trajectories`, and `agent_history_*`;
- at most 200 rows per query (default 100), with long cell values truncated.

The query runs against a read-only connection
(`queryPublicHistory` in `packages/observability/src/journal.ts`). The
renderer never gets raw SQL or file access. For the journal itself, see
[Observability](observability.md).

## App-session entity context

**Entity context** stores facts the app has learned about specific parts of
the Set, which Live itself doesn't save. Today these are listening results:
audio and MIDI measurements captured while playing a clip or Arrangement range
(see [Listening](listening.md)). Context never changes the `.als` file and
never stores raw audio.

The model, in `packages/project-state/src/context-schemas.ts`:

- **Subject**: what a fact is about: a `clip`, `track`, or `arrangement-range`
  in one Live Set. It is stored with binding evidence (names, positions, the
  references seen at capture time).
- **Pass**: one listening run. Passes never change after they are written, so
  the evidence stays intact.
- **Entry**: one typed result from a pass, such as
  `metric-audio-observation/v1`.
- **Link**: connects an entry to a subject. Links have a **freshness** status
  (`fresh`, `stale`, `unknown`, `unresolved`, `historical`). Freshness is
  re-checked against the current Set, because a clip may have been edited
  since it was measured.

Each App session has its own SQLite file at
`session-state/{app-session-id}/context/entity-context.sqlite`, managed by
`EntityContextRepository` (`packages/project-state/src/context-repository.ts`).
All agents in one App session share it; different sessions are isolated. The
repository also derives searchable **features** from measurements.

Agents read context with the `ableton_context` tool
(`packages/tools/src/listening-tools.ts`), using actions like `list`, `get`,
`report`, `list-features`, and `search-features`.
`packages/application/src/session-context-host.ts` always resolves the
repository from the **calling** agent's session, never from whatever is
selected in the UI. The Desktop shows context in `EntityContextPanel.tsx`.

## Revisions

The Remote Script keeps a **project revision** counter. It goes up whenever
its fixed LOM listeners (`remote-script/AbletonAgent/listeners.py`) see a
Set-wide change: tempo, transport, tracks, scenes, selection, clip slots,
devices, or routing. It sends `live_set.changed` and attaches the current
revision to responses and events.

The app uses revisions to know when its cached view is out of date:

- The bridge records the latest revision and watches for event sequence gaps.
- The prepared-context cache (`packages/runtime/src/prepared-context.ts`)
  marks itself stale and refreshes in the background when it sees
  `live_set.changed`, a higher revision, an event gap, or an app-made edit.

A revision only says that **something** changed. It doesn't mean every object
reference is invalid. Edits still check each object directly with
`expectedReference` and `expectedName`, and fail with `stale_reference`
instead of guessing.

## What else is in `packages/project-state`

The package also contains models for production plans, change sets, a
SQLite-backed project store, and an in-memory snapshot cache
(`services.ts`, `repository.ts`, `sqlite.ts`, `snapshot.ts`). The Desktop app
doesn't use these yet. Workflows use only the `ChangeSetService` types, for
audit records.

## Where to look in the code

| What                             | Where                                                    |
| -------------------------------- | -------------------------------------------------------- |
| Set identity                     | `remote-script/AbletonAgent/identity.py`                 |
| Live Set → App session mapping   | `apps/desktop/src/main/live-set-session-store.ts`        |
| Snapshot schema                  | `apps/desktop/src/contracts.ts` (`liveSetSnapshotSchema`) |
| Snapshot capture and enrichment  | `apps/desktop/src/main/headless-desktop-service.ts`      |
| Set History writer               | `apps/desktop/src/main/composition.ts`                   |
| Set History tables and views     | `packages/observability/src/migrations.ts`               |
| SQL search tool                  | `packages/tools/src/set-sql-search.ts`                   |
| Entity context schemas and store | `packages/project-state/src/context-schemas.ts`, `context-repository.ts` |
| Context access for agents        | `packages/application/src/session-context-host.ts`       |
| Per-session context resolver     | `apps/desktop/src/main/desktop-session-context.ts`       |
| Revision counter                 | `remote-script/AbletonAgent/listeners.py`                |
| Prepared-context cache           | `packages/runtime/src/prepared-context.ts`               |
