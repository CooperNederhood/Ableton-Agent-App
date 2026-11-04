# Supplied Drum Rack listening fixture

This is the user's unchanged `failing-listening-drum-rack-non-quant.als`,
stored as `project.als`. Its SHA256 is
`0f5103e1a8879eaa0a15c177db0830cd7944e067e9d5d270870ddae8718ad318`.
The user authorized copying this Set and sending exactly `listen to clip-1`.

## Preparation and prerequisites

1. Use licensed Ableton Live 11 with the Core Library samples and Builtin
   impulse responses declared in `fixture.json`. They are verified in the
   selected installation, not copied into this repository.
2. Retain the complete supplied Set, including its return tracks and Eventide
   Blackhole plug-in dependency. Do not remove devices, collect factory samples,
   reset transport, or change quantization to simplify admission.
3. Close normal Live processes before invoking the shared acceptance runner.
   It stages an owned copy, binds only the declared listener slot to the
   packaged candidate, and uses an isolated Desktop profile.

The separate authoring inspection used Live 11.3.43 and confirmed:

- MIDI track `1-808 Core Kit`, scene 0, `clip-1`; pitch 36 at beats 0, 1, 2, 3,
  duration 0.25, velocity 100, unmuted; four-beat loop at 128 BPM.
- Stopped beat `37.36462209665335`, remembered active target slot, recording
  disabled, and One Bar global and clip launch quantization. The historical
  filename does not override these observed settings.
- Complete instrument-tree evidence: 42 devices and 1,244 parameters.
  Reference-neutral note and instrument fingerprints are frozen in the manifest.

## Contract

Run `pnpm live:acceptance --scenario session-drum-rack-listening`.
The Default agent receives the exact prompt once. All three metric families
must complete without gaps over 90,000 samples at 48 kHz. The test also requires
one attributable capture, unchanged declared scopes, readable context after an
owned Desktop restart, and complete cleanup.

Ordinary fresh-process listening passed before the fix. A controlled real-Max
30 ms polling replay reproduced spectrum overflow and passed after paired
acquisitions; final production-cadence validation passed in `run-Amnyfh`.
The ordinary fixture alone does not guarantee adverse scheduler conditions.
See the red/green evidence and qualification boundaries in
[`acceptance-authoring.md`](../../../docs/testing/acceptance-authoring.md).
