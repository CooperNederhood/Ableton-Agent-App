# ADR 0006: Playback Listening and App-Session Entity Context

## Status

Accepted architecture; production readiness remains subject to the listening
validation gates.

## Context

Live 11 audio-clip inspection already provides gain, pitch, warp state, markers,
source path, sample length/rate, and identity. Mixer inspection also exposes
bounded meter reads. These describe state, not the signal heard through effects.
Clip source analysis, track playback observations, and master observations are
different evidence and must not be conflated.

The initial user workflow is explicit playback-and-listen, not an always-on
listener. Multiple listeners may occupy different positions on the same track.
Results must survive resuming the App session and support future context kinds.

## Decision

Use a transparent Max for Live Audio Effect at each selected measurement point.
Arm requested listeners before the application starts playback. Associate
observations with actual playback coordinates and activity, not socket receipt
time. Devices publish measurements; the application owns validation, attribution,
context persistence, and authorization.

Generalize the existing MIDI-Capture producer client, authentication,
registration, connection lifecycle, identity helpers, and portable publication
infrastructure. MIDI and audio use the same authenticated ingress. Audio DSP and
sample timing remain specialized. Do not fork another connection stack or make
the development MCP bridge a shipped-device requirement.

Initial descriptors are native-Max peak/RMS envelopes, estimated attacks, and
spectral brightness. RMS dBFS is not LUFS. Attack boundaries are estimates, not
guaranteed musical sections. Pitch, key, transcription, similarity search,
source separation, and FluCoMa dependencies are deferred.

The approved descriptive-listening extension separates native measurement
completeness from host/beat alignment quality. Its default observed-disagreement
budget is 64 samples, configurable from 0 through 480; explicit strict mode
accepts zero observed disagreement without claiming sample-exact physical
accuracy. Versioned v2 observations retain approximate/descriptive-only
alignment and unknown absolute error. The shared contracts, internal assembler
prerequisites, independent v2 proof checks and explicit authenticated v2 channel
negotiation are implemented. The App factory now selects v2 for default
descriptive requests, snapshots trusted Settings policy once per pass,
independently positions/re-inspects before arm, and preserves quality through
typed context publication/resume and Desktop. Explicit strict mode retains the
restricted v1 path without fallback. Native v2 execution and physical/visible
qualification are still required; deterministic integration is not a readiness
certificate.
Recording/source safety, native integrity,
ownership and cleanup are never softened by the timing policy.
The first descriptive milestone assumes constant tempo without independently
proving stability. Keep existing detected-tempo/timing failures, but defer
guaranteed brief/small-change detection to
[#55](https://github.com/CooperNederhood/Ableton-Agent-App/issues/55).
Tempo automation remains unsupported; completion does not certify unchanged
tempo or valid beat association outside that assumption.

Persist immutable observations and typed entity links in an App-session-owned
context repository. Register `audio-observation/v1` and
`audio-observation/v2` explicitly, require exact kind/payload-version agreement,
and reconcile old v1-only declarations additively without rewriting history.
This is not a generic JSON dump or an agent
note-writing API. Context is associated with clips, tracks, and Arrangement
ranges but does not modify the `.als` or live in an Ableton Project sidecar.

Resolve storage through `@ableton-agent/storage` with exact App-session/Live Set
ownership. Context survives journal retention and App-session closure. Resume
prepares a bounded inventory; tools retrieve detail. Never inject all recorded
arrays into each agent prompt.

## Alternatives

| Approach | Strengths | Limitations | Decision |
| --- | --- | --- | --- |
| LOM metadata and meters only | No extra device; cheap bounded reads | Cannot describe effect-chain audio, attacks, or spectral content | Reuse for binding and baseline context |
| Offline FluCoMa source analysis | Repeatable source measurements without transport | Does not hear effects, monitoring, or the master; external dependency | Future provider behind the same context model |
| Real-time M4L observation | Measures the actual signal at explicit chain positions | Requires installed/placed devices and verified timing/CPU limits | First bounded, on-demand implementation |
| Hybrid capture plus offline analysis | Separates capture from expensive analysis; supports richer engines | More lifecycle/dependency/resource complexity | Extension path, not first-release requirement |

## Consequences

- Playback tools are mutations with transport authorization, not read-only
  analysis. Initially require stopped transport and recording off.
- Arrangement listening bounds capture, not transport: playback continues
  after completion, cancellation, failure, or timeout. Cleanup disarms listeners
  and releases local monitors, never stops or rewinds Live. Live 11 property
  notifications cannot prove exclusive transport ownership, so the application
  lease must not be interpreted as an ownership token. This conservative
  implementation policy was selected while user confirmation was unavailable.
- Session listening remains unsupported until actual quantized source onset
  can be independently established; an unverified Arrangement start timestamp
  is likewise not proof of measured audio timing.
- A track's active clip is attribution context, not proof of isolated clip
  audio. Effects tails, routing, monitoring, sidechains, and master mixes must
  remain explicit limitations.
- Context freshness depends on source/settings, listener placement, upstream
  processing, and playback context. Unknown dependencies mean unverified
  freshness, not fresh.
- Runtime references and canonical device paths are not durable identity across
  restarts/reordering. Ambiguous reconciliation retains unresolved history.
- Persist processed measurements only. Omit raw audio/binary bodies and redact
  credentials in every persisted string.
- Context quotas and destructive, explicit pruning are independent of journal
  retention. A full store fails visibly rather than deleting observations.
- Listener placement is manual or template-preloaded initially. Do not claim
  arbitrary M4L insertion is available through Live 11's LOM.
- Native Max/Node for Max, transparent pass-through, sample timing, descriptor
  correctness, installed resources, and Apple Silicon performance require
  evidence on installed Live 11 before production enablement, recording the
  actual full version (current development host: Suite 11.3.43 on Apple Silicon).
  Support is not pinned to a patch; automatic updates alone are not a blocker.
