# Project State

## Sources of truth

There are three distinct kinds of state:

1. **Ableton state:** authoritative musical Live Set state in the LOM.
2. **Application state:** connection, snapshots, selections, plans, approvals,
   and change sets.
3. **Agent session state:** one conversation and tool history per active agent,
   maintained by the Copilot runtime.

Agent conversation is never treated as authoritative project state.

## Live Set snapshot

A normalized snapshot should include:

- Required Live Set identity and revision, plus optional Live Project grouping.
- Live version and capabilities.
- Tempo, signature, loop, and transport.
- Track summaries.
- Session clip-slot summaries.
- Arrangement clip summaries.
- Device summaries.
- Selected objects.

Large data such as all notes or every device parameter is loaded on demand.
Automatic startup reads only the bounded core Session snapshot. An explicit
refresh may enrich it with top-level device and parameter summaries, bounded to
32 devices per track and 64 parameters per device, with truncation reported
explicitly.

The Desktop snapshot contract also carries bounded, query-ready scene,
Session-clip, Arrangement-clip, cue-point, and top-level device collections.
Scene identities are derived from the scene indices exposed by the current
protocol; group membership and routing are marked unsupported until those
fields are available through a reviewed Live 11 protocol surface. Manual user
Refresh persists the completed snapshot through an injected history repository.
Startup and internal refreshes update current UI state only and never create
history records.

Set History storage exposes a read-only application service rather than a raw
database handle. Agent SQL is restricted to one `SELECT` or CTE, allowlisted
public views, and a caller-supplied result limit capped at 200 rows. The
repository remains responsible for read-only database access, cancellation, and
returning bounded scalar rows.

## Revisions and invalidation

The Remote Script increments a Live Set revision when observed structural or
meaningful state changes occur. Responses and events include the revision.

The application:

- Applies events to its cache when possible.
- Invalidates prepared context after successful application-owned bridge
  mutations, including device loading and parameter changes.
- Marks affected entities stale when detail is unknown.
- Refreshes targeted state rather than the entire project.
- Rejects mutations based on stale ambiguous references.

## Production plan

Maintain an application-owned structured plan:

```ts
interface ProductionPlan {
  goal: string;
  tempo?: number;
  key?: string;
  sections: SectionPlan[];
  trackRoles: TrackRole[];
  constraints: string[];
  status: "draft" | "approved" | "in-progress" | "complete";
}
```

This gives the UI and agent a shared representation beyond prose.

## Change sets

Each user-visible operation records:

- Correlation and session IDs.
- User intent.
- Tool/workflow name.
- Targets.
- Minimal before-state.
- Requested mutations.
- Completed mutations.
- Verification result.
- Warnings and errors.
- Recovery information.

Change sets support audit, troubleshooting, and compensating actions.

## Persistence

Store application metadata in a local SQLite database. Do not duplicate the
entire Ableton project. Suggested records:

- App sessions.
- Active agent instances, definition snapshots, bindings, and subscriptions.
- Live Set identities and optional Live Project grouping.
- Production plans.
- Change sets.
- User preferences.
- Approval decisions.
- Diagnostic operation metadata.

Musical content should remain local and should not be included in telemetry by
default.

The database is opened through a versioned migration runner, and every stored
payload is validated by the state schemas on write and on read. Writes run in
real SQLite transactions, and the database file is replaced atomically.

The current Desktop adapter incrementally implements this model with validated,
atomically replaced JSON records under
`~/.live-agent/profiles/{profile}/state/`:

- `sessions.json` stores production-session and active-agent snapshots;
- `live-set-sessions.json` maps each saved `liveSetId` to its canonical App
  session without deleting historical sessions;
- `../copilot/` remains the Copilot SDK's conversation store; and
- the owning Live Set's `session-state/{app-session-id}/session.json` records
  bounded ownership links to the Live Set, optional Live Project, active-agent,
  and SDK-session IDs without duplicating conversation or event content.

Desktop session schema v4 requires `liveSetId` and `liveSetName`, with optional
`liveProjectId` and `liveProjectName`. Connection and snapshot entity ownership
use `liveSetId`; Live Project identity is grouping metadata only. Unsaved and
orphan App sessions retain explicit Live Set ownership in memory but are
excluded from ordinary persistence and canonical association until persisted
or saved. A Live Set change is a transaction boundary: agent work and Output
delivery pause until the target App session is selected. Switching between
Live Sets inside one Live Project still resolves independently by `liveSetId`.
Consumers that resolve Session-scoped paths must first obtain the typed
`{ liveSetId, liveProjectId?, sessionId }` ownership context from the validated
Desktop session registry; a session ID alone never selects a storage path.
