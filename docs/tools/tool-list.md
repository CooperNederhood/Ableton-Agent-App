# Ableton Tool List

Maintenance checklist:
[Tool List Implementation To-Do](tool-list-implementation-to-do.md)

This document summarizes the Ableton tools currently registered with the agent.
The canonical source of truth is
[`packages/tools/src/index.ts`](../../packages/tools/src/index.ts), which defines
the exact descriptions, Zod input schemas, metadata, and handlers.

## Metadata

- **Risk**
  - `read`: does not mutate the Live Set.
  - `reversible`: mutates state with verification and, where applicable,
    rollback.
  - `destructive`: deletes or replaces existing material.
- **Scope**
  - `read`: edit scope does not restrict the operation.
  - `session`: requires an agent with full-session edit scope.
  - `track`: requires authorization for one identity-bound track.
  - `tracks`: requires authorization for every source and destination track.
- **Duration** is the expected runtime class: `instant`, `short`, or `long`.

Most track, clip, device, cue-point, and Browser mutations are
**identity-bound**. The agent first inspects Live, then supplies stable
`expected*Reference` and `expected*Name` values so the operation fails safely
if the target changed.

## Connection and Live Set inspection

`ableton_session` owns the session-level read surface:

| Action | Purpose | Risk | Duration |
| --- | --- | --- | --- |
| `connection-status` | Return the current Remote Script bridge connection status. | `read` | `instant` |
| `inspect` | Inspect tempo, time signature, playback, regular tracks, and Session clips. | `read` | `short` |

## Set History

| Tool | Purpose | Risk | Scope | Duration | Key inputs |
| --- | --- | --- | --- | --- | --- |
| `set_sql_search` | Run one bounded parameterized read-only SQL query over the documented agent and Set History public views. | `read` | `read` | `short` | `sql`, optional named scalar `parameters`, optional `limit` (1–200) |

The allowlisted views are `agent_history_sessions`, `agent_history_turns`,
`agent_history_messages`, `agent_history_tool_calls`,
`agent_history_tool_results`, `agent_history_approvals`, `set_history_saves`,
`set_history_snapshots`, `set_history_tracks`, `set_history_devices`,
`set_history_session_clips`, `set_history_arrangement_clips`,
`set_history_scenes`, `set_history_cue_points`, `set_history_trajectories`,
and `set_history_agent_links`. Results include `schemaVersion` and `elapsedMs`.
Grouped Ableton calls expose their stable `operation_id`, discriminated
`action`, `mutation_target`, and bounded `target_identity_json`; terminal
mutations are linked across agent and Set history by `tool_call_id`.
The backing service, not the agent, owns read-only database access and
cancellation.

Every agent receives a compact schema directly in the tool description,
including the important columns for each view, the `snapshot_id`,
`agent_session_id`, `turn_id`, and `tool_call_id` join paths, and bounded
discovery/detail examples. The bundled Set History skill adds deeper comparison
and interpretation patterns, but basic SQL queries do not depend on loading the
skill.

## Live 11 core-domain operations

The public surface is organized into action-discriminated domain tools rather
than separate tools for each operation. Every action has its own operation
descriptor, capability key, risk, edit scope, affected-track resolution, and
lifecycle identity.

| Tool | Supported actions |
| --- | --- |
| `ableton_session` | `connection-status` and full Set `inspect` |
| `ableton_scenes` | Bounded `list`/`get`; `create`, `duplicate`, `rename`, `set-color`, `set-tempo-time-signature`, `fire`, and exact destructive `delete` |
| `ableton_tracks` | Bounded `list`/`get`; regular MIDI/audio `create`; return-track creation; regular-track `duplicate`; exact `rename`; color, monitoring, fold, stop-clips, Back to Arrangement, and guarded regular/return `delete` |
| `ableton_mixer_routing` | Mixer `inspect`; bounded `meters`; combined `set-track-mixer`; volume, pan, sends, activator, crossfade assignment, master crossfader, and cue volume updates; routing option discovery and exact snapshot-token assignment |
| `ableton_transport` | Full state `get`; tempo and playback; Arrangement loop/cue inspection and mutation; seek/jump, time signature, metronome, launch/record quantization, Link when exposed, cue rename/jump, and Back to Arrangement |
| `ableton_session_clips` | MIDI clip creation; destructive note replacement; launch, duplicate, delete, and conservative property updates |
| `ableton_arrangement` | Bounded inspection; MIDI clip creation; destructive clip deletion/note replacement; isolated duplication; transactional `fill-region`; conservative clip property updates |
| `ableton_midi_notes` | Modern note-ID `query`, `add`, `update`, exact destructive `remove`, `duplicate`, and `quantize`, preserving probability, velocity deviation, and release velocity |
| `ableton_audio_clips` | Metadata `inspect`, including currently available warp modes; gain, pitch, warp state/mode, start/end/loop markers, and RAM mode updates; bounded warp-marker reads |
| `ableton_devices` | Bounded device/parameter/rack/chain/Drum Rack inspection; parameter and enabled state mutation; chain mixer/properties; exact device position validation and movement |
| `ableton_browser` | Browser roots/direct children, bounded search, external plug-in search, and exact supported item loading |
| `ableton_recording` | Recording-state inspection and verified Arrangement/Session record, overdub, automation record, punch, Capture MIDI, and timed empty-slot recording jobs |
| `ableton_grooves` | Revision-bound Groove Pool inspection, clip assignment/clear, percentage-unit property edits, and global amount up to Live's 130% limit |
| `ableton_selection_view` | Exact selection reads/setters and supported major view, follow, draw, fold, and collapse controls |
| `ableton_live_history` | Global `canUndo`/`canRedo`, undo, and redo with explicit warning/confirmation |
| `ableton_browser_adapters` | Preview/stop preview and capability-detected Hot-Swap, adjacent insertion, and empty Drum Rack pad loading with state restoration |
| `ableton_clip_automation` | Session envelope discovery/sampling, bounded step insertion, and explicit clear-one/clear-all |
| `ableton_warp_markers` | Revision-bound add/move/remove with ordering, BPM validation, verification, and compensation |
| `ableton_special_devices` | Capability-detected Live 11 Simpler, Looper, and Wavetable operations |
| `ableton_workflow_jobs` | Get/list bounded asynchronous workflow jobs and cancel only jobs owned by the active agent |

Routing assignments require a recent option snapshot, exact option token, exact
display name, target identity, and routing direction. Results surface warnings
for feedback-prone routes and external MIDI destinations.

MIDI note removal is destructive and requires destructive-operation approval.
Warp-mode assignment must select a mode from the exact availability list
returned by inspection; changed availability is rejected as stale.
Live 11 launch quantization is bounded to `0..13`, record quantization to
`0..8`, pitch fine to `-50..49`, and warp-mode identifiers to `0..6`.

Bulk note-replacement actions remain destructive. The core-domain layer does
not expose scene-scoped stop, arbitrary track reordering, per-note expression
editing, or unrestricted file import.

## Session View clips and MIDI notes

These operations are branches of `ableton_session_clips`:

| Action | Purpose | Risk | Scope | Duration |
| --- | --- | --- | --- | --- |
| `create-midi` | Create a MIDI clip in an empty Session View slot. | `reversible` | `track` | `short` |
| `replace-notes` | Replace every note in an exact Session MIDI clip. | `destructive` | `track` | `short` |
| `launch` | Launch and verify an exact MIDI or audio Session clip. | `reversible` | `track` | `instant` |
| `duplicate` | Duplicate an exact clip into an empty slot on an exact destination track. | `reversible` | `tracks` | `short` |
| `delete` | Delete an exact MIDI or audio Session clip. | `destructive` | `track` | `short` |
| `set-properties` | Update an exact clip's name, mute state, and/or loop state. | `reversible` | `track` | `short` |

MIDI note entries contain `pitch`, `startTime`, `duration`, `velocity`, and
optional `mute`. Replacement tools accept at most 2,048 notes. Existing
per-note MPE/expression data cannot be preserved and requires explicit opt-in
when replacing notes in a non-empty clip.

## Arrangement clips and MIDI notes

These operations are branches of `ableton_arrangement`:

| Action | Purpose | Risk | Scope | Duration |
| --- | --- | --- | --- | --- |
| `create-midi-clip` | Create an empty MIDI clip in a non-overlapping range. | `reversible` | `track` | `short` |
| `inspect` | Return a bounded page of clips ordered by time and track. | `read` | `read` | `short` |
| `delete-clip` | Delete an exact clip after track and start-time revalidation. | `destructive` | `track` | `short` |
| `replace-notes` | Replace every note in an exact Arrangement MIDI clip. | `destructive` | `track` | `short` |
| `duplicate-clip` | Duplicate a Session clip into a verified non-overlapping destination. | `reversible` | `track` | `short` |
| `fill-region` | Fill a half-open region with up to 128 complete copies in one transactional invocation. | `reversible` | `track` | `long` |
| `set-clip-properties` | Update an exact clip's name, mute state, and/or loop state. | `reversible` | `track` | `short` |

Region filling preflights every destination before mutation and applies at most
four tiles per scheduled Live tick. Any placement failure removes all clips
created by that call and verifies the original collection. An unverified
rollback returns `applied_indeterminate`. Live 11.3.43 exposes Arrangement
`end_time` as a read-only edge, so region filling intentionally supports only
complete tiles. Callers must use a shorter source clip when exact coverage is
required and must never place a full tile past `regionEnd`.

## Devices, racks, Drum Racks, and parameters

`ableton_devices` exposes `inspect`, `inspect-parameters`,
`inspect-rack-chains`, `inspect-rack-chain-devices`,
`inspect-drum-rack-pads`, `inspect-drum-pad-chains`,
`inspect-drum-pad-chain-devices`, `inspect-chain-mixer`, `find-position`,
`move`, `set-chain-properties`, `set-chain-mixer`, `set-enabled`, and
`set-parameter`. Each branch retains its own risk, duration, capability,
identity shape, and affected-track authorization.

Device inspection is intentionally bounded and non-recursive. Nested rack
contents are reached through the rack-, chain-, pad-, and device-specific
inspection tools. Device movement and chain editing are Live 11 operations:
they preflight with `Song.find_device_position`, account for same-parent index
shifts in both forward moves and rollback, mutate chain colors through the
exact `Chain.color_index` palette index, verify the canonical state, and fail
closed on stale or ambiguous topology. Chain-property results retain Live's
observed RGB `color` alongside `colorIndex`. Drum Rack pad inspection scans
the bounded 128-pad map and returns only occupied pads by default, with
total/occupied/empty counts. `includeEmpty: true` preserves paginated
diagnostic access to the complete pad map.

This slice does **not** support creating empty rack chains, direct native
device insertion, deleting one chain, or reordering chains. Those operations
are not registered as tools or advertised as capabilities.

## Ableton Browser and content loading

`ableton_browser` exposes `roots`, `children`, `search`,
`search-external-plugins`, and `load-item`. Inspection and search branches are
read-only; exact supported item loading remains a long reversible,
identity-bound track mutation.

Browser roots include sounds, drums, instruments, audio effects, MIDI
effects, Max for Live, plug-ins, clips, samples, Packs, User Library, and the
current project. Loading currently rejects folders, samples, clips, grooves,
unknown load types, arbitrary paths, incompatible tracks, and active hotswap.

## Tool selection in custom agents

Agent definitions select tools with exact names, operation IDs, or wildcard
patterns:

```yaml
tools:
  - session.inspect
  - recording.inspect
  - grooves.set_*
```

`"*"` enables the canonical catalog. Operation patterns select only matching
actions and prune the grouped tool's strict schema. Connected capability flags
prune unsupported actions as the session is configured. Superseded direct
names are removed rather than registered beside canonical grouped tools.
Definitions that still name a removed tool are invalid and receive an
unmatched-pattern diagnostic; use the documented canonical operation ID or
grouped tool instead.

## Specialized tools intentionally kept separate

| Tool | Why it remains separate |
| --- | --- |
| `ableton_browser_adapters` | Evidence-gated private Browser preview, Hot-Swap, adjacent insertion, and empty-pad adapters have distinct restoration and capability semantics from documented Browser traversal/loading. |
| `ableton_clip_automation` | Envelope discovery, sampling, step insertion, and destructive clearing form a specialized Session automation workflow. |
| `ableton_warp_markers` | Revision-bound marker mutation has ordering, BPM, compensation, and stale-snapshot requirements beyond ordinary audio-clip properties. |
| `ableton_special_devices` | Simpler, Looper, and Wavetable branches are capability-detected device-specific adapters rather than general device CRUD. |
| `ableton_workflow_jobs` | Job inspection and cancellation manage application-owned asynchronous execution rather than direct LOM objects. |
| `set_sql_search` | This queries application-owned Agent and Set History rather than the current Live object model. |
