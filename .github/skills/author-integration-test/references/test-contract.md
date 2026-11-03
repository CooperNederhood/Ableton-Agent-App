# Contract review checklist

Use this as a short human-review form, not a second plan or executable schema:

| Question       | Contract to agree                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------ |
| Starting world | Proposed Set or supplied `.als`, resources/rights, baseline, immutable and build-supplied dependencies |
| Preparation    | User-facing Live steps, exact settings, required files, and project/media handoff checklist            |
| Interaction    | Supported driver, exact ordered turns, same-conversation boundaries, terminal conditions               |
| Scope          | Intended source/targets, allowed actions/arguments, approvals, finite budgets, protected state         |
| Correctness    | Independent evidence and named assertions at each turn and at finalization                             |
| Ownership      | Fresh neutral working copy/profile, owned processes, cancellation and cleanup                          |
| Handoff        | Persistent fixture/scenario, reproducible command, receipt and failure classification                  |

If one row is ambiguous, ask a focused question before freezing the contract.
Do not require the developer to know the manifest format.

## First authoring example: `session-clip-identify`

The real fixture and scenario are registered under `session-clip-identify`;
the separate template remains non-runnable. User review and registration do not
establish a passing run: require the terminal receipt and every assertion below.

Starting world: Session clip `clip-1` on the neutrally named `audio-track` track,
containing one bar of four-on-the-floor kick audio at 128 BPM in 4/4. The kick
identity is runner-only oracle information; track, clip, media, and working
directory names do not reveal it. Confirm the WAV's rights and actual sample
rate and record the actual host rate independently.

The user approved these names, tempo and the supplied Set's existing return/
Master processing and factory preset/reverb resources on 2026-11-02. Preserve
that processing rather than requiring a minimal rebuilt Set. This approves the
fixture contents, not missing resources: verify required factory content resolves
in the owned test environment and declare its provenance/prerequisites before
registration. Do not waive dependency admission or redistribute factory content
without suitable rights.

At 128 BPM, four beats last 1.875 seconds. The template's illustrative 48 kHz
capture therefore expects 90,000 frames, not the former 120-BPM 96,000 frames.
Confirm the host rate and loaded four-beat region independently before finalizing
those parameters; do not derive expected coverage from the captured result.

### Exact initial conditions

- Global Quantization **None**; clip launch quantization **Global**.
- Transport stopped at `currentSongTime === 0` in beat coordinates.
- All Session clips stopped, with no pending/queued launch.
- Target is warped audio, with zero start and loop offsets and a four-beat
  active region; Trigger launch mode, legato off, follow actions disabled.
- Recording off: independently read global Arrangement Record and Session Record
  as false, as well as target recording off. Never infer global recording state
  from the target clip. Tempo 128 BPM; time signature 4/4.
- Intended same-track listener independently bound and production candidate
  resource inventory verified.
- Live 11 returns unknown for its public follow-action property. When unavailable,
  require the explicit boolean in the exact saved Session slot of the verified
  loaded Set, and record its hash as evidence. Missing/ambiguous evidence and an
  enabled flag still block admission. This establishes initial saved state, not
  continuous independent monitoring of every device/clip parameter.

Authoring may establish these agreed conditions on the owned copy before it is
frozen. Execution must read and verify them before turn 1; mismatch blocks
submission rather than triggering hidden repair. Quantization and source
settings remain unchanged throughout the scenario.

### Exact user turns

Turn 1:

> Listen to the first Session clip on track audio-track.

Wait for its attributable turn and listening job to finish. Independently
verify intended source capture and retained context before sending turn 2.

Turn 2 (preserve this text exactly):

> What does the clip you listened to do? Pick from (A) hihat (B) kick drum (C) synth lead (D) snare. Reply in the form '({Letter})', nothing else.

Use the complete terminal assistant response for turn 2, trim only outer
whitespace, require regex `^\(([A-D])\)$`, then require `(B)`. Invalid format is
different from a valid incorrect choice. Reject prose, substrings, lowercase,
partial streams, or another turn's response. No model grades the answer.

### Independent assertions (all required)

1. Loaded baseline was read and valid before any submission; no unsupported
   launch was attempted and no settings were repaired.
2. Both messages were accepted exactly once and linked to the same pinned
   unmodified Default agent, application session, and conversation.
3. Turn 1 created exactly one intended listening pass for the correct Session
   source. Required metrics are complete and non-silent, with independently
   derived capture coverage, no truncation/missing records, unresolved failure,
   or cleanup error. Require separately journaled capture/source cleanup, not
   merely a completed job lifecycle. Result counters alone cannot define
   expected coverage.
4. Public typed context reads identify that pass/source and retained content.
   After the conversation, restart only the owned Desktop process using the
   same isolated profile and verify retained identity/content without recapture.
   An in-memory read does not prove persistence.
5. Turn 2 is exactly `(B)` and starts no additional capture.
6. Original clip/media content and unrelated Set state stay unchanged. Only the
   reviewed playback/capture effects occur; approvals stay within declared
   action, argument, target, risk, and budget bounds. The template's unchanged
   scopes are `session-structure`, `source-settings`, and `fixture-media`.
7. All owned work/processes reach terminal cleanup outcomes, and the final
   bounded sanitized receipt persists.

Correct `(B)` alone fails if any independent check fails. Do not recapture,
reset the conversation, coach the Default agent, or broaden permissions after
observing failure. Missing evidence is not an empty successful result.

### Mutation-oracle boundary to review

The current `session-structure` oracle hashes public snapshot track/clip/device
identities and exposed mixer/routing fields, plus scenes/Arrangement/cues when
present. It does **not** independently enumerate every plug-in/device parameter.
`source-settings` covers the source's exact launch/audio settings, recording
state, and file identity from the typed source read. These checks cover named,
observed scopes, not arbitrary all-parameter immutability. If the developer's
protected-state contract includes additional parameters or unavailable fields,
add the required independent reads/assertions before claiming that protection;
do not silently weaken the contract to fit current evidence.
