# Scenario groups

## Implemented baseline

`inspection`

- `connection-and-session`: verify the authenticated connection and bounded
  Session snapshot against a fresh runner-owned Set.
- `transport-inspection`: inspect bounded Arrangement transport state without
  mutation.
- `browser-bounds`: verify Browser category and search traversal remain within
  reviewed node, result, depth, and duration limits.
- `capability-surface`: directly verify the supported command/capability
  inventory reported by the running Remote Script without model mediation.

`live-events`

- `live-event-registration`: configure a Triggered Clip Event against a real
  track, assert target resolution and initial state, disable/unsubscribe,
  re-enable/resubscribe, verify a missing target remains unsubscribed, correct
  it, and restore an unchanged Set.

`tracks-and-clips`

- `track-lifecycle`: create, rename, inspect, and remove one namespaced track,
  then restore the baseline Set.
- `audio-input-routing`: create namespaced MIDI/audio tracks, resolve a
  current-only audio input route, assign the source and `Post FX`, verify both
  from fresh option snapshots, then restore the baseline Set.
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
- `cue-point-lifecycle`: directly create an unnamed cue point at an exact time,
  inspect it, delete it by returned identity, and restore the cue state without
  model-mediated action selection.

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

## Listening source fixtures

`listening-fixtures`

- `operator-quarter-note-fixture`: search for Operator, create one namespaced
  MIDI track with that exact instrument, write a four-beat Session source, and
  duplicate its exact identity into Arrangement using supported Live 11 actions.
  Independently verify exactly four A4 notes in both clips at beats 0-3 with
  half-beat duration and velocity 100. Playback, recording, routing, mixer and instrument-parameter changes are
  excluded. The generated Session source and Arrangement copy are retained only
  in the runner-owned group Set.
  This proves instrument/MIDI structure, not a sine waveform, calibrated
  amplitude, actual listener measurements or listening readiness.

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

Each group starts in a fresh runner-owned default Set. Every scenario also uses
a fresh Copilot session so prior prompts and tool calls cannot contaminate its
reviewed action contract. Live artifacts never carry across group restarts.

## Explicit native listening fixtures

`native-listening` retains the strict-v1 `native-playback-and-listen` scenario
unchanged, with `--native-fixture-input`.

`native-listening-descriptive` requires a separately pinned explicit v2 fixture
via `--native-v2-fixture-input`:

- `native-descriptive-fractional`: beats 0.25–3.75, maximumDurationMs 8000.
- `native-descriptive-startup-0-4`: exact beats 0–4 at 120 BPM,
  maximumDurationMs 8000; one capture and 20 windows.
- `native-descriptive-startup-4-12`: exact beats 4–12 at 120 BPM,
  maximumDurationMs 8000; one capture and 40 windows.
- `native-descriptive-30-seconds`: beats 0.25–60.25 at independently inspected
  120 BPM, maximumDurationMs 45000; exactly 30 seconds and 300 windows.

All use the frozen App-owned descriptive timing policy capped at 64 samples.
Before capture, geometry comes from independent tempo inspection and accepted
44.1/48 kHz DSP registration/vector metadata; the expectation is bound to the
App-owned queued pass ID, never reconstructed from producer results. Constant
tempo is assumed; tempo automation and physical timing qualification are not
claimed. Readiness stays false and historical attribution/freshness stays
unknown, not exclusive clip audio.

Each scenario creates its own artifact namespace and fresh exact-PID owned Live
process. The first process must finish shutdown and fixture cleanup before the
next starts, even when they share immutable source pins. Native admission
rejects missing/wrong-version inputs, installation, approve-all, and external
computer-use startup before build/setup. Full native selection requires both
version-specific inputs; no substitution or silent fallback.

The production v2 host owns guarded nonzero positioning before arming. The runner
never seeks, repairs an insert marker, retries playback, or stops transport as
capture cleanup. Real terminal jobs, independently accepted proof, exactly one
atomic context, typed reopening, unchanged Set and leave-running idle capture
must all verify. Implementation and synthetic deterministic tests are complete;
real fixture execution, resource resolution, and physical qualification remain
separate acceptance work owned by the operator.

The two exact integer-range startup regressions cover the native-v2 transition
from stopped signal phase to host playback. They retain the same immutable v2
input pins, current 44.1/48 kHz registration, exact approval bounds, no-failed-tool
requirement and independent proof/context/cleanup verification as the fractional
scenario. Their reviewed manifests and synthetic runner tests do not establish
real-Live acceptance or same-process repeated-pass qualification.
