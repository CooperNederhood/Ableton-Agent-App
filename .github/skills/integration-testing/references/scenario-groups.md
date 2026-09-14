# Scenario groups

## Implemented baseline

`live-events`

- `live-event-registration`: configure a Triggered Clip Event against a real
  track, assert target resolution and initial state, disable/unsubscribe,
  re-enable/resubscribe, verify a missing target remains unsubscribed, correct
  it, and restore an unchanged Set.

`tracks-and-clips`

- `808-track`: search first, create exactly one namespaced MIDI track, load
  `808 Core Kit.adg`, and verify one `808 Core Kit` device.
- `four-on-floor`: create the namespaced 808 track and one-bar clip, write four
  pitch-36 notes at beats 0–3, and verify exact note content through
  `clips.inspect_notes`.

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

- connection and bounded inspection;
- Session clip duplicate, launch, properties, and delete;
- Arrangement create, note write, duplicate, properties, and delete;
- rack, chain, and Drum Rack inspection;
- transport mutation/restoration, cue points, denial, and retry safety.

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
