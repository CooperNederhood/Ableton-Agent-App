# Scenario groups

## Implemented baseline

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

## Planned expansion

- connection and bounded inspection;
- Session clip duplicate, launch, properties, and delete;
- Arrangement create, note write, duplicate, properties, and delete;
- device, parameter, rack, chain, and Drum Rack inspection;
- transport mutation/restoration, cue points, denial, stale targets, and retry
  safety.

Each group starts in a fresh runner-owned default Set. Copilot session context
may continue, but Live artifacts never carry across group restarts.
