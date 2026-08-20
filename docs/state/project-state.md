# Project State

## Sources of truth

There are three distinct kinds of state:

1. **Ableton state:** authoritative musical/project state in the LOM.
2. **Application state:** connection, snapshots, selections, plans, approvals,
   and change sets.
3. **Agent session state:** one conversation and tool history per active agent,
   maintained by the Copilot runtime.

Agent conversation is never treated as authoritative project state.

## Project snapshot

A normalized snapshot should include:

- Project identity and revision.
- Live version and capabilities.
- Tempo, signature, loop, and transport.
- Track summaries.
- Session clip-slot summaries.
- Arrangement clip summaries.
- Device summaries.
- Selected objects.

Large data such as all notes or every device parameter is loaded on demand.

## Revisions and invalidation

The Remote Script increments a project revision when observed structural or
meaningful state changes occur. Responses and events include the revision.

The application:

- Applies events to its cache when possible.
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
- Ableton project identities.
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
