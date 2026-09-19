# Scenario groups

## Implemented baseline

`inspection`

- `connection-and-session`: verify the authenticated connection and bounded
  Session snapshot against a fresh runner-owned Set.
- `transport-inspection`: inspect bounded Arrangement transport state without
  mutation.
- `browser-bounds`: verify Browser category and search traversal remain within
  reviewed node, result, depth, and duration limits.
- `capability-surface`: verify the supported command/capability inventory
  reported by the running Remote Script.

`live-events`

- `live-event-registration`: configure a Triggered Clip Event against a real
  track, assert target resolution and initial state, disable/unsubscribe,
  re-enable/resubscribe, verify a missing target remains unsubscribed, correct
  it, and restore an unchanged Set.

`tracks-and-clips`

- `track-lifecycle`: create, rename, inspect, and remove one namespaced track,
  then restore the baseline Set.
- `808-track`: search first, create exactly one namespaced MIDI track, load
  `808 Core Kit.adg`, and verify one `808 Core Kit` device.
- `four-on-floor`: create the namespaced 808 track and one-bar clip, write four
  pitch-36 notes at beats 0–3, and verify exact note content through
  `clips.inspect_notes`.
- `session-clip-lifecycle`: create, update, duplicate, launch, and remove
  namespaced Session clips, then restore the baseline Set.

`arrangement-and-cues`

- `arrangement-clip-lifecycle`: duplicate an identity-bound Session MIDI clip
  into Arrangement, inspect it, remove it, and restore the baseline Set.
- `arrangement-region-fill-lifecycle`: fill a non-divisible Arrangement region
  with one bulk tool call, verify complete-tile placement and the reported
  remainder, remove every created tile, and restore the baseline Set.
- `cue-point-lifecycle`: create an unnamed cue point at an exact time, inspect
  it, delete it by returned identity, and restore the cue state. Live 11.3.43
  naming support is covered as an explicit unsupported-capability path.

`instruments`

- `piano-and-string-bass`: search and browse Live's built-in Browser, create
  exactly two namespaced MIDI tracks, load `Childhood Home Piano.adg` and
  `Upright Bass.adv` onto their identity-bound targets, and verify both final
  devices.

`audio-effects`

- `auto-filter-audio`: search for Auto Filter, create exactly one namespaced
  audio track, load the identity-bound device even when Live reports preset
  children, and verify the final device.
- `echo-parameter-inspection`: search for Echo, create one namespaced audio
  track, load the identity-bound device, inspect its first 30 parameters, and
  verify the final device without a bridge timeout.

## Planned expansion

- Arrangement create, note write, properties, and audio-source duplication;
- rack, chain, and Drum Rack inspection;
- transport loop mutation/restoration, denial, and retry safety;
- startup, manual-refresh, and settled-idle performance profiling.

## Live 11 core-domain inspection

`inspection`

- `scenes-core-inspection`: bounded scene list followed by exact-identity get.
- `tracks-core-inspection`: bounded regular/return/master list followed by
  exact regular-track get.
- `transport-core-inspection`: consolidated transport and bounded cue-point
  state.
- `workflow-state-inspection`: recording state, bounded Groove Pool, exact
  selection/view state, global history availability, and workflow-job list
  without mutation.

Each group starts in a fresh runner-owned default Set. Copilot session context
may continue, but Live artifacts never carry across group restarts.
