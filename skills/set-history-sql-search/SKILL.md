---
name: set-history-sql-search
description: Query local Ableton Set and agent history with bounded, parameterized, read-only SQL.
---

# Set History SQL search

Use `set_sql_search` for historical questions about prior Live Sets, snapshots,
tracks, devices, scenes, clips, cue points, and linked agent activity.

## Public views

- Agent history: `agent_history_sessions`, `agent_history_turns`,
  `agent_history_messages`, `agent_history_tool_calls`,
  `agent_history_tool_results`, `agent_history_approvals`
- Set history: `set_history_saves`, `set_history_snapshots`,
  `set_history_tracks`, `set_history_devices`, `set_history_session_clips`,
  `set_history_arrangement_clips`, `set_history_scenes`,
  `set_history_cue_points`, `set_history_trajectories`,
  `set_history_agent_links`

## Bounded query rules

- Submit exactly one `SELECT` or non-recursive `WITH ... SELECT`.
- Select only needed columns; never use `SELECT *`.
- Filter narrowly by `live_set_id`, `live_project_id`, time range, or exact IDs.
- Put values in the optional `parameters` object and reference them as
  `:name`, `@name`, or `$name`; do not interpolate values into SQL.
- Use a modest SQL `LIMIT` as well as the tool's result `limit`.
- Retrieve summaries and IDs first, then request details for selected IDs.
- Avoid broad joins, broad scans, recursive CTEs, and large payload columns
  unless they are specifically needed.
- If `truncated` is true, narrow the filters or requested columns rather than
  increasing scope. Use `schemaVersion` for schema-aware interpretation and
  `elapsedMs` to recognize unexpectedly expensive queries.

## Examples

Find recent snapshots for one Live Set:

```json
{
  "sql": "SELECT snapshot_id, captured_at, live_set_name, tempo, track_count FROM set_history_snapshots WHERE live_set_id = :live_set_id AND captured_at >= :after ORDER BY captured_at DESC LIMIT 20",
  "parameters": {
    "live_set_id": "current-live-set-id",
    "after": "2026-09-01T00:00:00.000Z"
  },
  "limit": 20
}
```

After selecting a snapshot ID, inspect its devices:

```json
{
  "sql": "SELECT track_id, device_index, name, class_name, enabled FROM set_history_devices WHERE snapshot_id = :snapshot_id ORDER BY track_index, device_index LIMIT 50",
  "parameters": {
    "snapshot_id": "selected-snapshot-id"
  },
  "limit": 50
}
```

Find nearby tool activity through explicit Set/agent links:

```json
{
  "sql": "SELECT links.occurred_at, calls.tool_name, calls.outcome FROM set_history_agent_links AS links JOIN agent_history_tool_results AS calls ON calls.tool_call_id = links.tool_call_id WHERE links.live_set_id = :live_set_id AND links.occurred_at >= :after ORDER BY links.occurred_at DESC LIMIT 25",
  "parameters": {
    "live_set_id": "current-live-set-id",
    "after": "2026-09-01T00:00:00.000Z"
  },
  "limit": 25
}
```

Historical snapshots are evidence, not current Live state. Before making a
change, inspect the current Set with the appropriate Ableton tools. Explain
missing or truncated snapshot domains rather than inferring absent content.
