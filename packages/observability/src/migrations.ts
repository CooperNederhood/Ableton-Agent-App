import type { Database } from "sql.js";

import { JournalSchemaVersionError } from "./errors.js";

export interface ObservabilityMigration {
  readonly version: number;
  readonly description: string;
  readonly statements: readonly string[];
}

export const observabilityMigrations: readonly ObservabilityMigration[] = [
  {
    version: 1,
    description: "Create the local observability journal",
    statements: [
      `CREATE TABLE IF NOT EXISTS observability_schema_migrations (
        version INTEGER PRIMARY KEY,
        description TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )`,
      `CREATE TABLE telemetry_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        contract_version INTEGER NOT NULL,
        occurred_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        name TEXT NOT NULL,
        category TEXT,
        source TEXT NOT NULL,
        stage TEXT,
        level TEXT NOT NULL,
        outcome TEXT,
        correlation_id TEXT,
        causation_id TEXT,
        trace_id TEXT,
        span_id TEXT,
        parent_span_id TEXT,
        root_trace_id TEXT NOT NULL,
        project_id TEXT,
        session_id TEXT,
        active_agent_id TEXT,
        live_event_id TEXT,
        output_id TEXT,
        tool_name TEXT,
        duration_ms REAL,
        payload TEXT NOT NULL
      )`,
      `CREATE TABLE configuration_snapshots (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        snapshot_id TEXT NOT NULL UNIQUE,
        contract_version INTEGER NOT NULL,
        captured_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        component TEXT NOT NULL,
        configuration_version TEXT NOT NULL,
        project_id TEXT,
        session_id TEXT,
        active_agent_id TEXT,
        payload TEXT NOT NULL
      )`,
      `CREATE INDEX telemetry_events_occurred
        ON telemetry_events (occurred_at, sequence)`,
      `CREATE INDEX telemetry_events_trace
        ON telemetry_events (trace_id, sequence)`,
      `CREATE INDEX telemetry_events_root_trace
        ON telemetry_events (root_trace_id, sequence)`,
      `CREATE INDEX telemetry_events_name
        ON telemetry_events (name, sequence)`,
      `CREATE INDEX telemetry_events_category
        ON telemetry_events (category, sequence)`,
      `CREATE INDEX telemetry_events_source
        ON telemetry_events (source, sequence)`,
      `CREATE INDEX telemetry_events_stage
        ON telemetry_events (stage, sequence)`,
      `CREATE INDEX telemetry_events_level
        ON telemetry_events (level, sequence)`,
      `CREATE INDEX telemetry_events_outcome
        ON telemetry_events (outcome, sequence)`,
      `CREATE INDEX telemetry_events_session
        ON telemetry_events (session_id, sequence)`,
      `CREATE INDEX telemetry_events_correlation
        ON telemetry_events (correlation_id, sequence)`,
      `CREATE INDEX telemetry_events_project
        ON telemetry_events (project_id, sequence)`,
      `CREATE INDEX telemetry_events_active_agent
        ON telemetry_events (active_agent_id, sequence)`,
      `CREATE INDEX telemetry_events_live_event
        ON telemetry_events (live_event_id, sequence)`,
      `CREATE INDEX telemetry_events_output
        ON telemetry_events (output_id, sequence)`,
      `CREATE INDEX telemetry_events_tool
        ON telemetry_events (tool_name, sequence)`,
      `CREATE INDEX configuration_snapshots_captured
        ON configuration_snapshots (captured_at, sequence)`,
      `CREATE INDEX configuration_snapshots_component
        ON configuration_snapshots (component, sequence)`,
      `CREATE INDEX configuration_snapshots_session
        ON configuration_snapshots (session_id, sequence)`,
      `CREATE INDEX configuration_snapshots_project
        ON configuration_snapshots (project_id, sequence)`,
      `CREATE INDEX configuration_snapshots_active_agent
        ON configuration_snapshots (active_agent_id, sequence)`,
    ],
  },
  {
    version: 2,
    description:
      "Attribute observability records to Live Sets and optional Live Projects",
    statements: [
      `DROP INDEX IF EXISTS telemetry_events_project`,
      `DROP INDEX IF EXISTS configuration_snapshots_project`,
      `ALTER TABLE telemetry_events RENAME COLUMN project_id TO live_set_id`,
      `ALTER TABLE telemetry_events ADD COLUMN live_project_id TEXT`,
      `ALTER TABLE configuration_snapshots RENAME COLUMN project_id TO live_set_id`,
      `ALTER TABLE configuration_snapshots ADD COLUMN live_project_id TEXT`,
      `UPDATE telemetry_events
        SET contract_version = 2,
            payload = CASE
              WHEN json_type(payload, '$.projectId') IS NULL
                THEN json_set(payload, '$.version', 2)
              ELSE json_set(
                json_remove(payload, '$.projectId'),
                '$.version', 2,
                '$.liveSetId', json_extract(payload, '$.projectId')
              )
            END`,
      `UPDATE configuration_snapshots
        SET contract_version = 2,
            payload = CASE
              WHEN json_type(payload, '$.projectId') IS NULL
                THEN json_set(payload, '$.version', 2)
              ELSE json_set(
                json_remove(payload, '$.projectId'),
                '$.version', 2,
                '$.liveSetId', json_extract(payload, '$.projectId')
              )
            END`,
      `CREATE INDEX telemetry_events_live_set
        ON telemetry_events (live_set_id, sequence)`,
      `CREATE INDEX telemetry_events_live_project
        ON telemetry_events (live_project_id, sequence)`,
      `CREATE INDEX configuration_snapshots_live_set
        ON configuration_snapshots (live_set_id, sequence)`,
      `CREATE INDEX configuration_snapshots_live_project
        ON configuration_snapshots (live_project_id, sequence)`,
    ],
  },
  {
    version: 3,
    description:
      "Separate App events, agent history, and Live Set history with stable views",
    statements: [
      `ALTER TABLE telemetry_events RENAME TO app_events`,
      `ALTER TABLE configuration_snapshots RENAME TO app_configuration_snapshots`,
      `DROP INDEX IF EXISTS telemetry_events_occurred`,
      `DROP INDEX IF EXISTS telemetry_events_trace`,
      `DROP INDEX IF EXISTS telemetry_events_root_trace`,
      `DROP INDEX IF EXISTS telemetry_events_name`,
      `DROP INDEX IF EXISTS telemetry_events_category`,
      `DROP INDEX IF EXISTS telemetry_events_source`,
      `DROP INDEX IF EXISTS telemetry_events_stage`,
      `DROP INDEX IF EXISTS telemetry_events_level`,
      `DROP INDEX IF EXISTS telemetry_events_outcome`,
      `DROP INDEX IF EXISTS telemetry_events_session`,
      `DROP INDEX IF EXISTS telemetry_events_correlation`,
      `DROP INDEX IF EXISTS telemetry_events_active_agent`,
      `DROP INDEX IF EXISTS telemetry_events_live_event`,
      `DROP INDEX IF EXISTS telemetry_events_output`,
      `DROP INDEX IF EXISTS telemetry_events_tool`,
      `DROP INDEX IF EXISTS telemetry_events_live_set`,
      `DROP INDEX IF EXISTS telemetry_events_live_project`,
      `DROP INDEX IF EXISTS configuration_snapshots_captured`,
      `DROP INDEX IF EXISTS configuration_snapshots_component`,
      `DROP INDEX IF EXISTS configuration_snapshots_session`,
      `DROP INDEX IF EXISTS configuration_snapshots_active_agent`,
      `DROP INDEX IF EXISTS configuration_snapshots_live_set`,
      `DROP INDEX IF EXISTS configuration_snapshots_live_project`,
      `CREATE INDEX app_events_occurred ON app_events (occurred_at, sequence)`,
      `CREATE INDEX app_events_trace ON app_events (trace_id, sequence)`,
      `CREATE INDEX app_events_root_trace ON app_events (root_trace_id, sequence)`,
      `CREATE INDEX app_events_name ON app_events (name, sequence)`,
      `CREATE INDEX app_events_category ON app_events (category, sequence)`,
      `CREATE INDEX app_events_source ON app_events (source, sequence)`,
      `CREATE INDEX app_events_stage ON app_events (stage, sequence)`,
      `CREATE INDEX app_events_level ON app_events (level, sequence)`,
      `CREATE INDEX app_events_outcome ON app_events (outcome, sequence)`,
      `CREATE INDEX app_events_session ON app_events (session_id, sequence)`,
      `CREATE INDEX app_events_correlation ON app_events (correlation_id, sequence)`,
      `CREATE INDEX app_events_live_set ON app_events (live_set_id, sequence)`,
      `CREATE INDEX app_events_live_project ON app_events (live_project_id, sequence)`,
      `CREATE INDEX app_events_active_agent ON app_events (active_agent_id, sequence)`,
      `CREATE INDEX app_events_live_event ON app_events (live_event_id, sequence)`,
      `CREATE INDEX app_events_output ON app_events (output_id, sequence)`,
      `CREATE INDEX app_events_tool ON app_events (tool_name, sequence)`,
      `CREATE INDEX app_configuration_snapshots_captured
        ON app_configuration_snapshots (captured_at, sequence)`,
      `CREATE INDEX app_configuration_snapshots_component
        ON app_configuration_snapshots (component, sequence)`,
      `CREATE INDEX app_configuration_snapshots_session
        ON app_configuration_snapshots (session_id, sequence)`,
      `CREATE INDEX app_configuration_snapshots_live_set
        ON app_configuration_snapshots (live_set_id, sequence)`,
      `CREATE INDEX app_configuration_snapshots_live_project
        ON app_configuration_snapshots (live_project_id, sequence)`,
      `CREATE INDEX app_configuration_snapshots_active_agent
        ON app_configuration_snapshots (active_agent_id, sequence)`,
      `CREATE TABLE agent_sessions (
        record_id TEXT PRIMARY KEY,
        occurred_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        app_session_id TEXT NOT NULL,
        agent_session_id TEXT NOT NULL,
        active_agent_id TEXT NOT NULL,
        live_set_id TEXT,
        live_project_id TEXT,
        status TEXT NOT NULL,
        payload TEXT NOT NULL
      )`,
      `CREATE UNIQUE INDEX agent_sessions_identity
        ON agent_sessions (agent_session_id)`,
      `CREATE INDEX agent_sessions_time
        ON agent_sessions (occurred_at, recorded_at, record_id)`,
      `CREATE INDEX agent_sessions_app
        ON agent_sessions (app_session_id, occurred_at)`,
      `CREATE TABLE agent_turns (
        record_id TEXT PRIMARY KEY,
        occurred_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        app_session_id TEXT NOT NULL,
        agent_session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        active_agent_id TEXT NOT NULL,
        live_set_id TEXT,
        live_project_id TEXT,
        status TEXT NOT NULL,
        payload TEXT NOT NULL
      )`,
      `CREATE UNIQUE INDEX agent_turns_identity ON agent_turns (turn_id)`,
      `CREATE INDEX agent_turns_time
        ON agent_turns (occurred_at, recorded_at, record_id)`,
      `CREATE INDEX agent_turns_session
        ON agent_turns (agent_session_id, occurred_at)`,
      `CREATE TABLE agent_messages (
        record_id TEXT PRIMARY KEY,
        occurred_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        app_session_id TEXT NOT NULL,
        agent_session_id TEXT NOT NULL,
        turn_id TEXT,
        active_agent_id TEXT NOT NULL,
        live_set_id TEXT,
        live_project_id TEXT,
        status TEXT NOT NULL,
        payload TEXT NOT NULL
      )`,
      `CREATE INDEX agent_messages_time
        ON agent_messages (occurred_at, recorded_at, record_id)`,
      `CREATE INDEX agent_messages_turn
        ON agent_messages (turn_id, occurred_at)`,
      `CREATE TABLE agent_tool_calls (
        record_id TEXT PRIMARY KEY,
        occurred_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        app_session_id TEXT NOT NULL,
        agent_session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        active_agent_id TEXT NOT NULL,
        live_set_id TEXT,
        live_project_id TEXT,
        status TEXT NOT NULL,
        payload TEXT NOT NULL
      )`,
      `CREATE UNIQUE INDEX agent_tool_calls_identity
        ON agent_tool_calls (tool_call_id)`,
      `CREATE INDEX agent_tool_calls_time
        ON agent_tool_calls (occurred_at, recorded_at, record_id)`,
      `CREATE INDEX agent_tool_calls_turn
        ON agent_tool_calls (turn_id, occurred_at)`,
      `CREATE TABLE agent_tool_results (
        record_id TEXT PRIMARY KEY,
        occurred_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        app_session_id TEXT NOT NULL,
        agent_session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        active_agent_id TEXT NOT NULL,
        live_set_id TEXT,
        live_project_id TEXT,
        status TEXT NOT NULL,
        payload TEXT NOT NULL
      )`,
      `CREATE INDEX agent_tool_results_time
        ON agent_tool_results (occurred_at, recorded_at, record_id)`,
      `CREATE INDEX agent_tool_results_call
        ON agent_tool_results (tool_call_id, occurred_at)`,
      `CREATE TABLE agent_approvals (
        record_id TEXT PRIMARY KEY,
        occurred_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        app_session_id TEXT NOT NULL,
        agent_session_id TEXT NOT NULL,
        turn_id TEXT,
        tool_call_id TEXT,
        active_agent_id TEXT NOT NULL,
        live_set_id TEXT,
        live_project_id TEXT,
        status TEXT NOT NULL,
        payload TEXT NOT NULL
      )`,
      `CREATE INDEX agent_approvals_time
        ON agent_approvals (occurred_at, recorded_at, record_id)`,
      `CREATE INDEX agent_approvals_call
        ON agent_approvals (tool_call_id, occurred_at)`,
      `CREATE TABLE set_saves (
        record_id TEXT PRIMARY KEY,
        occurred_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        app_session_id TEXT,
        live_set_id TEXT NOT NULL,
        live_project_id TEXT,
        status TEXT NOT NULL,
        payload TEXT NOT NULL
      )`,
      `CREATE INDEX set_saves_time
        ON set_saves (occurred_at, recorded_at, record_id)`,
      `CREATE INDEX set_saves_set ON set_saves (live_set_id, occurred_at)`,
      `CREATE TABLE set_snapshots (
        record_id TEXT PRIMARY KEY,
        occurred_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        app_session_id TEXT,
        live_set_id TEXT NOT NULL,
        live_project_id TEXT,
        status TEXT NOT NULL,
        payload TEXT NOT NULL
      )`,
      `CREATE INDEX set_snapshots_time
        ON set_snapshots (occurred_at, recorded_at, record_id)`,
      `CREATE INDEX set_snapshots_set
        ON set_snapshots (live_set_id, occurred_at)`,
      `CREATE TABLE set_trajectory_records (
        record_id TEXT PRIMARY KEY,
        occurred_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        app_session_id TEXT,
        agent_session_id TEXT,
        turn_id TEXT,
        tool_call_id TEXT,
        active_agent_id TEXT,
        live_set_id TEXT NOT NULL,
        live_project_id TEXT,
        status TEXT NOT NULL,
        payload TEXT NOT NULL
      )`,
      `CREATE INDEX set_trajectory_time
        ON set_trajectory_records (occurred_at, recorded_at, record_id)`,
      `CREATE INDEX set_trajectory_set
        ON set_trajectory_records (live_set_id, occurred_at)`,
      `CREATE VIEW agent_history AS
        SELECT 'agent_session' AS record_type, record_id, occurred_at,
          recorded_at, app_session_id, agent_session_id, NULL AS turn_id,
          NULL AS tool_call_id, active_agent_id, live_set_id, live_project_id,
          status, payload
        FROM agent_sessions
        UNION ALL
        SELECT 'turn', record_id, occurred_at, recorded_at, app_session_id,
          agent_session_id, turn_id, NULL, active_agent_id, live_set_id,
          live_project_id, status, payload
        FROM agent_turns
        UNION ALL
        SELECT 'message', record_id, occurred_at, recorded_at, app_session_id,
          agent_session_id, turn_id, NULL, active_agent_id, live_set_id,
          live_project_id, status, payload
        FROM agent_messages
        UNION ALL
        SELECT 'tool_call', record_id, occurred_at, recorded_at,
          app_session_id, agent_session_id, turn_id, tool_call_id,
          active_agent_id, live_set_id, live_project_id, status, payload
        FROM agent_tool_calls
        UNION ALL
        SELECT 'tool_result', record_id, occurred_at, recorded_at,
          app_session_id, agent_session_id, turn_id, tool_call_id,
          active_agent_id, live_set_id, live_project_id, status, payload
        FROM agent_tool_results
        UNION ALL
        SELECT 'approval', record_id, occurred_at, recorded_at, app_session_id,
          agent_session_id, turn_id, tool_call_id, active_agent_id, live_set_id,
          live_project_id, status, payload
        FROM agent_approvals`,
      `CREATE VIEW set_history AS
        SELECT 'set_save' AS record_type, record_id, occurred_at, recorded_at,
          app_session_id, NULL AS agent_session_id, NULL AS turn_id,
          NULL AS tool_call_id, NULL AS active_agent_id, live_set_id,
          live_project_id, status, payload
        FROM set_saves
        UNION ALL
        SELECT 'set_snapshot', record_id, occurred_at, recorded_at,
          app_session_id, NULL, NULL, NULL, NULL, live_set_id, live_project_id,
          status, payload
        FROM set_snapshots
        UNION ALL
        SELECT 'set_trajectory', record_id, occurred_at, recorded_at,
          app_session_id, agent_session_id, turn_id, tool_call_id,
          active_agent_id, live_set_id, live_project_id, status, payload
        FROM set_trajectory_records`,
    ],
  },
  {
    version: 4,
    description: "Add granular stable public history views",
    statements: [
      `CREATE VIEW set_history_saves AS
        SELECT record_id AS save_id, occurred_at AS saved_at, recorded_at,
          app_session_id, live_set_id, live_project_id, status AS outcome,
          json_extract(payload, '$.trigger') AS trigger,
          json_extract(payload, '$.path') AS path,
          json_extract(payload, '$.durationMs') AS duration_ms,
          json_extract(payload, '$.traceId') AS trace_id,
          json_extract(payload, '$.correlationId') AS correlation_id,
          json_extract(payload, '$.causationId') AS causation_id,
          json_extract(payload, '$.details') AS details_json
        FROM set_saves`,
      `CREATE VIEW set_history_snapshots AS
        SELECT record_id AS snapshot_id, occurred_at AS captured_at,
          recorded_at, app_session_id, live_set_id, live_project_id,
          status AS snapshot_kind,
          json_extract(payload, '$.revision') AS revision,
          json_extract(payload, '$.snapshot.liveSetName') AS live_set_name,
          json_extract(payload, '$.snapshot.liveProjectName') AS live_project_name,
          json_extract(payload, '$.snapshot.tempo') AS tempo,
          json_extract(payload, '$.snapshot.timeSignature') AS time_signature,
          json_extract(payload, '$.snapshot.source') AS source,
          json_extract(payload, '$.snapshot.transport.isPlaying') AS is_playing,
          json_extract(payload, '$.snapshot.transport.arrangementLoop.enabled')
            AS arrangement_loop_enabled,
          json_extract(payload, '$.snapshot.transport.arrangementLoop.start')
            AS arrangement_loop_start,
          json_extract(payload, '$.snapshot.transport.arrangementLoop.length')
            AS arrangement_loop_length,
          json_array_length(json_extract(payload, '$.snapshot.tracks'))
            AS track_count,
          json_array_length(json_extract(payload, '$.snapshot.scenes'))
            AS scene_count,
          json_array_length(json_extract(payload, '$.snapshot.sessionClips'))
            AS session_clip_count,
          json_array_length(json_extract(payload, '$.snapshot.arrangementClips'))
            AS arrangement_clip_count,
          json_array_length(json_extract(payload, '$.snapshot.devices'))
            AS device_count,
          json_array_length(json_extract(payload, '$.snapshot.cuePoints'))
            AS cue_point_count,
          json_extract(payload, '$.snapshot.completeness.truncatedDomains')
            AS truncated_domains_json,
          json_extract(payload, '$.snapshot.completeness.unsupportedDomains')
            AS unsupported_domains_json
        FROM set_snapshots`,
      `CREATE VIEW set_history_tracks AS
        SELECT snapshots.record_id AS snapshot_id,
          snapshots.occurred_at AS captured_at, snapshots.app_session_id,
          snapshots.live_set_id, snapshots.live_project_id,
          json_extract(track.value, '$.id') AS track_id,
          COALESCE(
            json_extract(track.value, '$.index'),
            CAST(track.key AS INTEGER)
          ) AS track_index,
          json_extract(track.value, '$.name') AS name,
          json_extract(track.value, '$.kind') AS kind,
          json_extract(track.value, '$.color') AS color,
          json_extract(track.value, '$.volume') AS volume,
          json_extract(track.value, '$.pan') AS pan,
          json_extract(track.value, '$.muted') AS muted,
          json_extract(track.value, '$.soloed') AS soloed,
          json_extract(track.value, '$.armed') AS armed,
          json_extract(track.value, '$.groupTrackId') AS group_track_id,
          json_extract(track.value, '$.inputRouting') AS input_routing,
          json_extract(track.value, '$.outputRouting') AS output_routing,
          json_extract(track.value, '$.devicesTruncated') AS devices_truncated
        FROM set_snapshots AS snapshots,
          json_each(snapshots.payload, '$.snapshot.tracks') AS track`,
      `CREATE VIEW set_history_devices AS
        SELECT snapshots.record_id AS snapshot_id,
          snapshots.occurred_at AS captured_at, snapshots.app_session_id,
          snapshots.live_set_id, snapshots.live_project_id,
          json_extract(device.value, '$.id') AS device_id,
          json_extract(device.value, '$.trackId') AS track_id,
          json_extract(device.value, '$.trackIndex') AS track_index,
          json_extract(device.value, '$.index') AS device_index,
          json_extract(device.value, '$.name') AS name,
          COALESCE(
            json_extract(device.value, '$.className'),
            json_extract(device.value, '$.type')
          ) AS class_name,
          json_extract(device.value, '$.classDisplayName') AS class_display_name,
          json_extract(device.value, '$.enabled') AS enabled,
          COALESCE(
            json_extract(device.value, '$.parameterCount'),
            json_array_length(json_extract(device.value, '$.parameters'))
          ) AS parameter_count,
          json_extract(device.value, '$.canHaveChains') AS can_have_chains,
          json_extract(device.value, '$.canHaveDrumPads') AS can_have_drum_pads
        FROM set_snapshots AS snapshots,
          json_each(snapshots.payload, '$.snapshot.devices') AS device
        UNION ALL
        SELECT snapshots.record_id, snapshots.occurred_at,
          snapshots.app_session_id, snapshots.live_set_id,
          snapshots.live_project_id,
          json_extract(device.value, '$.id'),
          json_extract(track.value, '$.id'),
          COALESCE(
            json_extract(track.value, '$.index'),
            CAST(track.key AS INTEGER)
          ),
          CAST(device.key AS INTEGER),
          json_extract(device.value, '$.name'),
          json_extract(device.value, '$.type'),
          NULL,
          json_extract(device.value, '$.enabled'),
          json_array_length(json_extract(device.value, '$.parameters')),
          NULL,
          NULL
        FROM set_snapshots AS snapshots,
          json_each(snapshots.payload, '$.snapshot.tracks') AS track,
          json_each(track.value, '$.devices') AS device
        WHERE NOT EXISTS (
          SELECT 1
          FROM json_each(snapshots.payload, '$.snapshot.devices') AS detailed
          WHERE json_extract(detailed.value, '$.id') =
            json_extract(device.value, '$.id')
        )`,
      `CREATE VIEW set_history_session_clips AS
        SELECT snapshots.record_id AS snapshot_id,
          snapshots.occurred_at AS captured_at, snapshots.app_session_id,
          snapshots.live_set_id, snapshots.live_project_id,
          json_extract(clip.value, '$.id') AS clip_id,
          json_extract(clip.value, '$.trackId') AS track_id,
          json_extract(clip.value, '$.trackIndex') AS track_index,
          json_extract(clip.value, '$.sceneIndex') AS scene_index,
          json_extract(clip.value, '$.name') AS name,
          json_extract(clip.value, '$.kind') AS kind,
          json_extract(clip.value, '$.lengthBeats') AS length_beats,
          json_extract(clip.value, '$.noteCount') AS note_count,
          json_extract(clip.value, '$.muted') AS muted,
          json_extract(clip.value, '$.looping') AS looping,
          json_extract(clip.value, '$.status') AS status
        FROM set_snapshots AS snapshots,
          json_each(snapshots.payload, '$.snapshot.sessionClips') AS clip`,
      `CREATE VIEW set_history_arrangement_clips AS
        SELECT snapshots.record_id AS snapshot_id,
          snapshots.occurred_at AS captured_at, snapshots.app_session_id,
          snapshots.live_set_id, snapshots.live_project_id,
          json_extract(clip.value, '$.id') AS clip_id,
          json_extract(clip.value, '$.trackId') AS track_id,
          json_extract(clip.value, '$.trackIndex') AS track_index,
          json_extract(clip.value, '$.name') AS name,
          json_extract(clip.value, '$.kind') AS kind,
          json_extract(clip.value, '$.startTime') AS start_time,
          json_extract(clip.value, '$.endTime') AS end_time,
          json_extract(clip.value, '$.lengthBeats') AS length_beats,
          json_extract(clip.value, '$.noteCount') AS note_count,
          json_extract(clip.value, '$.muted') AS muted,
          json_extract(clip.value, '$.looping') AS looping
        FROM set_snapshots AS snapshots,
          json_each(snapshots.payload, '$.snapshot.arrangementClips') AS clip`,
      `CREATE VIEW set_history_scenes AS
        SELECT snapshots.record_id AS snapshot_id,
          snapshots.occurred_at AS captured_at, snapshots.app_session_id,
          snapshots.live_set_id, snapshots.live_project_id,
          json_extract(scene.value, '$.id') AS scene_id,
          COALESCE(
            json_extract(scene.value, '$.index'),
            CAST(scene.key AS INTEGER)
          ) AS scene_index,
          json_extract(scene.value, '$.name') AS name,
          json_extract(scene.value, '$.derived') AS derived
        FROM set_snapshots AS snapshots,
          json_each(snapshots.payload, '$.snapshot.scenes') AS scene`,
      `CREATE VIEW set_history_cue_points AS
        SELECT snapshots.record_id AS snapshot_id,
          snapshots.occurred_at AS captured_at, snapshots.app_session_id,
          snapshots.live_set_id, snapshots.live_project_id,
          json_extract(cue.value, '$.id') AS cue_point_id,
          json_extract(cue.value, '$.name') AS name,
          json_extract(cue.value, '$.time') AS time
        FROM set_snapshots AS snapshots,
          json_each(snapshots.payload, '$.snapshot.cuePoints') AS cue`,
      `CREATE VIEW set_history_trajectories AS
        SELECT record_id AS trajectory_id, occurred_at, recorded_at,
          app_session_id, agent_session_id, turn_id, tool_call_id,
          active_agent_id, live_set_id, live_project_id,
          status AS trajectory_type,
          json_extract(payload, '$.summary') AS summary,
          json_extract(payload, '$.traceId') AS trace_id,
          json_extract(payload, '$.correlationId') AS correlation_id,
          json_extract(payload, '$.causationId') AS causation_id,
          json_extract(payload, '$.data') AS data_json
        FROM set_trajectory_records`,
      `CREATE VIEW set_history_agent_links AS
        SELECT record_id AS trajectory_id, occurred_at, app_session_id,
          live_set_id, live_project_id, agent_session_id, turn_id,
          tool_call_id, active_agent_id
        FROM set_trajectory_records
        WHERE agent_session_id IS NOT NULL OR turn_id IS NOT NULL
          OR tool_call_id IS NOT NULL OR active_agent_id IS NOT NULL`,
      `CREATE VIEW agent_history_sessions AS
        SELECT record_id, occurred_at, recorded_at, app_session_id,
          agent_session_id, active_agent_id, live_set_id, live_project_id,
          status, json_extract(payload, '$.sdkSessionId') AS sdk_session_id,
          json_extract(payload, '$.endedAt') AS ended_at,
          json_extract(payload, '$.traceId') AS trace_id,
          json_extract(payload, '$.correlationId') AS correlation_id,
          json_extract(payload, '$.causationId') AS causation_id,
          json_extract(payload, '$.metadata') AS metadata_json
        FROM agent_sessions`,
      `CREATE VIEW agent_history_turns AS
        SELECT record_id, occurred_at, recorded_at, app_session_id,
          agent_session_id, turn_id, active_agent_id, live_set_id,
          live_project_id, status,
          json_extract(payload, '$.completedAt') AS completed_at,
          json_extract(payload, '$.prompt') AS prompt,
          json_extract(payload, '$.durationMs') AS duration_ms,
          json_extract(payload, '$.traceId') AS trace_id,
          json_extract(payload, '$.correlationId') AS correlation_id,
          json_extract(payload, '$.causationId') AS causation_id,
          json_extract(payload, '$.metadata') AS metadata_json
        FROM agent_turns`,
      `CREATE VIEW agent_history_messages AS
        SELECT record_id, occurred_at, recorded_at, app_session_id,
          agent_session_id, turn_id, active_agent_id, live_set_id,
          live_project_id, status AS role,
          json_extract(payload, '$.content') AS content,
          json_extract(payload, '$.messageIndex') AS message_index,
          json_extract(payload, '$.traceId') AS trace_id,
          json_extract(payload, '$.correlationId') AS correlation_id,
          json_extract(payload, '$.causationId') AS causation_id,
          json_extract(payload, '$.metadata') AS metadata_json
        FROM agent_messages`,
      `CREATE VIEW agent_history_tool_calls AS
        SELECT record_id, occurred_at, recorded_at, app_session_id,
          agent_session_id, turn_id, tool_call_id, active_agent_id,
          live_set_id, live_project_id, status,
          json_extract(payload, '$.toolName') AS tool_name,
          json_extract(payload, '$.arguments') AS arguments_json,
          json_extract(payload, '$.traceId') AS trace_id,
          json_extract(payload, '$.correlationId') AS correlation_id,
          json_extract(payload, '$.causationId') AS causation_id,
          json_extract(payload, '$.metadata') AS metadata_json
        FROM agent_tool_calls`,
      `CREATE VIEW agent_history_tool_results AS
        SELECT record_id, occurred_at, recorded_at, app_session_id,
          agent_session_id, turn_id, tool_call_id, active_agent_id,
          live_set_id, live_project_id, status AS outcome,
          json_extract(payload, '$.durationMs') AS duration_ms,
          json_extract(payload, '$.result') AS result_json,
          json_extract(payload, '$.error') AS error,
          json_extract(payload, '$.traceId') AS trace_id,
          json_extract(payload, '$.correlationId') AS correlation_id,
          json_extract(payload, '$.causationId') AS causation_id,
          json_extract(payload, '$.metadata') AS metadata_json
        FROM agent_tool_results`,
      `CREATE VIEW agent_history_approvals AS
        SELECT record_id, occurred_at, recorded_at, app_session_id,
          agent_session_id, turn_id, tool_call_id, active_agent_id,
          live_set_id, live_project_id, status,
          json_extract(payload, '$.resolvedAt') AS resolved_at,
          json_extract(payload, '$.summary') AS summary,
          json_extract(payload, '$.traceId') AS trace_id,
          json_extract(payload, '$.correlationId') AS correlation_id,
          json_extract(payload, '$.causationId') AS causation_id,
          json_extract(payload, '$.details') AS details_json
        FROM agent_approvals`,
    ],
  },
];

export const observabilitySchemaVersion = observabilityMigrations.reduce(
  (highest, migration) => Math.max(highest, migration.version),
  0,
);

function appliedVersions(database: Database): Set<number> {
  const statement = database.prepare(
    "SELECT version FROM observability_schema_migrations",
  );
  try {
    const versions = new Set<number>();
    while (statement.step()) {
      const [version] = statement.get();
      if (typeof version === "number") versions.add(version);
    }
    return versions;
  } finally {
    statement.free();
  }
}

export function migrateObservabilityJournal(
  database: Database,
  now: () => string = () => new Date().toISOString(),
): number {
  database.run(`CREATE TABLE IF NOT EXISTS observability_schema_migrations (
    version INTEGER PRIMARY KEY,
    description TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const applied = appliedVersions(database);
  const current = [...applied].reduce(
    (highest, version) => Math.max(highest, version),
    0,
  );
  if (current > observabilitySchemaVersion) {
    throw new JournalSchemaVersionError(
      `Observability database schema version ${current} is newer than supported version ${observabilitySchemaVersion}`,
    );
  }
  for (const migration of observabilityMigrations) {
    if (applied.has(migration.version)) continue;
    database.run("BEGIN IMMEDIATE");
    try {
      for (const statement of migration.statements) database.run(statement);
      database.run(
        `INSERT INTO observability_schema_migrations
          (version, description, applied_at) VALUES (?, ?, ?)`,
        [migration.version, migration.description, now()],
      );
      database.run("COMMIT");
    } catch (error) {
      database.run("ROLLBACK");
      throw error;
    }
  }
  database.run(`PRAGMA user_version = ${observabilitySchemaVersion}`);
  return observabilitySchemaVersion;
}
