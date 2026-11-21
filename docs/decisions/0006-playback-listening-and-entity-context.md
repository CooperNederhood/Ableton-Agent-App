# ADR 0006: Playback Listening and App-Session Entity Context

## Status

Accepted.

## Context

Live's API (the LOM) describes clips and devices but can't tell the agent what
anything sounds like. Meters are coarse and don't capture spectral content or
attacks. To describe a sound, something has to listen to the actual audio
signal in Live.

## Decision

- **Listen in real time with a Max for Live device.** A transparent Audio
  Effect device sits on the track at the point to measure. The app arms it,
  starts playback, and the device captures samples and computes measurements.
- **Devices measure; the app decides.** Devices publish measurements. The
  application owns validation, matching results to the right clip or range,
  storage and approvals.
- **Reuse the MIDI-capture connection.** Audio and MIDI devices share the same
  authenticated producer client and ingress instead of each having their own.
- **Listening is playback.** A listen starts Live's transport, so it is treated
  as a change that needs approval, not a read.
- **Store results as context for the app session.** Processed measurements are
  saved and linked to clips, tracks and Arrangement ranges. They survive app
  restarts but are not written into the `.als` file. Raw audio is never stored.
  Later tool calls read the stored results back instead of putting every
  number into each prompt.

## Alternatives

| Approach | Strengths | Limitations | Decision |
| --- | --- | --- | --- |
| LOM metadata and meters only | No extra device; cheap | Can't describe effects, attacks or spectral content | Used for targeting and basic context |
| Offline analysis of source files | Repeatable; no playback | Doesn't hear effects or the mix | Possible later addition |
| Real-time Max for Live device | Hears the actual signal at a chosen point | Device must be on the track; timing must be aligned | Chosen |

## Consequences

- The listener device must already be on the track; Live 11's API can't insert
  Max for Live devices.
- A track's playing clip identifies what was heard, but effects tails, routing
  and sidechains can still colour the audio.
- Timing has to be aligned between Live's song position and the device's
  sample clock. See [listening](../listening.md).
