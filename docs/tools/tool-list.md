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

| Tool | Purpose | Risk | Scope | Duration | Key inputs |
| --- | --- | --- | --- | --- | --- |
| `ableton_connection_status` | Return the current Remote Script bridge connection status. | `read` | `read` | `instant` | None |
| `ableton_session_inspect` | Inspect transport, tempo, time signature, project identity, tracks, scenes, clips, and capabilities. | `read` | `read` | `short` | None |

## Transport, Arrangement loop, and cue points

| Tool | Purpose | Risk | Scope | Duration | Key inputs |
| --- | --- | --- | --- | --- | --- |
| `ableton_transport_set_tempo` | Set and verify the Live Set tempo. | `reversible` | `session` | `instant` | `tempo` (20–999 BPM) |
| `ableton_transport_set_playing` | Start or stop transport and verify playback state. | `reversible` | `session` | `instant` | `isPlaying` |
| `ableton_transport_inspect_arrangement` | Inspect Arrangement loop state and a bounded page of cue points. | `read` | `read` | `short` | `offset`, `limit` |
| `ableton_transport_set_arrangement_loop` | Update loop enablement, start, and/or length with verification and rollback. | `reversible` | `session` | `instant` | At least one of `enabled`, `start`, `length` |
| `ableton_transport_create_cue_point` | Create and verify a cue point at an unoccupied Arrangement time. | `reversible` | `session` | `short` | `time`, optional `name` |
| `ableton_transport_delete_cue_point` | Delete an exact cue point after identity, name, and time revalidation. | `destructive` | `session` | `short` | `expectedReference`, `expectedName`, `expectedTime` |

## Tracks and mixer

| Tool | Purpose | Risk | Scope | Duration | Key inputs |
| --- | --- | --- | --- | --- | --- |
| `ableton_tracks_create` | Create one MIDI or audio track at the end of the Live Set. | `reversible` | `session` | `short` | `kind`, optional `name` |
| `ableton_tracks_delete` | Delete an exact track; refuses to delete the final remaining track. | `destructive` | `track` | `short` | Track `index`, identity, expected kind |
| `ableton_tracks_rename` | Rename an exact inspected track. | `reversible` | `track` | `short` | Track identity, `name` |
| `ableton_tracks_set_mixer` | Update mute, solo, arm, normalized volume, and/or pan. | `reversible` | `track` | `short` | Track identity plus one or more mixer properties |

## Session View clips and MIDI notes

| Tool | Purpose | Risk | Scope | Duration | Key inputs |
| --- | --- | --- | --- | --- | --- |
| `ableton_clips_create_midi` | Create a MIDI clip in an empty Session View slot on a MIDI track. | `reversible` | `track` | `short` | Track identity, `sceneIndex`, `length`, optional `name` |
| `ableton_clips_replace_notes` | Replace every note in an exact Session MIDI clip. | `destructive` | `track` | `short` | Track/clip identity, `notes`, `allowPerNoteExpressionLoss` |
| `ableton_clips_launch` | Launch an exact MIDI or audio Session clip and verify its playback state. | `reversible` | `track` | `instant` | Track/clip identity and `sceneIndex` |
| `ableton_clips_duplicate` | Duplicate an exact Session clip into an empty slot on an exact destination track. | `reversible` | `tracks` | `short` | Source track/clip identity and destination track/scene identity |
| `ableton_clips_delete` | Delete an exact MIDI or audio Session clip. | `destructive` | `track` | `short` | Track/clip identity and `sceneIndex` |
| `ableton_clips_set_properties` | Update an exact Session clip's name, mute state, and/or loop state. | `reversible` | `track` | `short` | Track/clip identity plus one or more properties |

MIDI note entries contain `pitch`, `startTime`, `duration`, `velocity`, and
optional `mute`. Replacement tools accept at most 2,048 notes. Existing
per-note MPE/expression data cannot be preserved and requires explicit opt-in
when replacing notes in a non-empty clip.

## Arrangement clips and MIDI notes

| Tool | Purpose | Risk | Scope | Duration | Key inputs |
| --- | --- | --- | --- | --- | --- |
| `ableton_arrangement_create_midi_clip` | Create an empty MIDI clip in a non-overlapping Arrangement range. | `reversible` | `track` | `short` | Track identity, `startTime`, `length`, optional `name` |
| `ableton_arrangement_inspect` | Return a bounded page of Arrangement clips ordered by time and track. | `read` | `read` | `short` | `offset`, `limit` |
| `ableton_arrangement_delete_clip` | Delete an exact Arrangement clip after track and start-time revalidation. | `destructive` | `track` | `short` | Track/clip identity, `expectedStartTime` |
| `ableton_arrangement_replace_notes` | Replace every note in an exact Arrangement MIDI clip. | `destructive` | `track` | `short` | Track/clip identity, start time, notes, expression-loss opt-in |
| `ableton_arrangement_duplicate_clip` | Duplicate a Session MIDI clip into a verified, non-overlapping Arrangement destination. | `reversible` | `track` | `short` | Track/Session clip identity, `destinationTime` |
| `ableton_arrangement_set_clip_properties` | Update an Arrangement clip's name, mute state, and/or loop state. | `reversible` | `track` | `short` | Track/clip identity, start time, one or more properties |

## Devices, racks, Drum Racks, and parameters

| Tool | Purpose | Risk | Scope | Duration | Key inputs |
| --- | --- | --- | --- | --- | --- |
| `ableton_devices_inspect` | Inspect a bounded page of top-level devices on an exact regular track. | `read` | `read` | `short` | Track identity, `offset`, `limit` |
| `ableton_device_parameters_inspect` | Inspect a bounded page of parameters on an exact top-level device. | `read` | `read` | `short` | Track/device identity, `offset`, `limit` |
| `ableton_rack_chains_inspect` | Inspect direct chains of an exact top-level rack without recursive expansion. | `read` | `read` | `short` | Track/rack identity, `offset`, `limit` |
| `ableton_rack_chain_devices_inspect` | Inspect direct devices in an exact rack chain. | `read` | `read` | `short` | Track/rack/chain identity, `offset`, `limit` |
| `ableton_drum_rack_pads_inspect` | Inspect a bounded page of pads on an exact top-level Drum Rack. | `read` | `read` | `short` | Track/Drum Rack identity, `offset`, `limit` |
| `ableton_drum_pad_chains_inspect` | Inspect direct chains for an exact Drum Rack pad. | `read` | `read` | `short` | Track/rack/pad identity, `offset`, `limit` |
| `ableton_drum_pad_chain_devices_inspect` | Inspect direct devices in an exact Drum Rack pad chain. | `read` | `read` | `short` | Track/rack/pad/chain identity, `offset`, `limit` |
| `ableton_device_set_enabled` | Enable or disable an exact top-level device through its Device On parameter. | `reversible` | `track` | `short` | Track/device identity, `enabled` |
| `ableton_device_set_parameter` | Set an exact writable parameter using normalized `0..1` input, with quantization support and rollback. | `reversible` | `track` | `short` | Track/device/parameter identity, `normalizedValue` |

Device inspection is intentionally bounded and non-recursive. Nested rack
contents are reached through the rack-, chain-, pad-, and device-specific
inspection tools.

## Ableton Browser and content loading

| Tool | Purpose | Risk | Scope | Duration | Key inputs |
| --- | --- | --- | --- | --- | --- |
| `ableton_browser_roots_inspect` | Inspect documented Ableton Browser root categories and their runtime references. | `read` | `read` | `instant` | None |
| `ableton_browser_children_inspect` | Inspect one bounded page of direct children for an exact Browser container. | `read` | `read` | `short` | Browser item identity/path, `offset`, `limit` |
| `ableton_browser_search` | Perform deterministic bounded search across selected Browser roots. | `read` | `read` | `short` | `query`, `roots`, traversal/result/depth/time limits |
| `ableton_browser_search_external_plugins` | Search only the Plug-ins root; does not load a plug-in. | `read` | `read` | `short` | `query`, traversal/result/depth/time limits |
| `ableton_browser_load_item` | Load an exact supported built-in device or preset onto a compatible regular track. | `reversible` | `track` | `long` | Track identity plus exact Browser item identity/path |

Browser roots include sounds, drums, instruments, audio effects, MIDI
effects, Max for Live, plug-ins, clips, samples, Packs, User Library, and the
current project. Loading currently rejects folders, samples, clips, grooves,
unknown load types, arbitrary paths, incompatible tracks, and active hotswap.

## Tool selection in custom agents

Agent definitions select tools with exact names or wildcard patterns:

```yaml
tools:
  - ableton_session_inspect
  - ableton_tracks_*
  - ableton_clips_*
```

`"*"` enables the complete catalog. Patterns are expanded against the
registered tool names when definitions load; unmatched patterns are reported
as definition diagnostics.
