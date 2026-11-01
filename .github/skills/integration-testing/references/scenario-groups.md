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

## Transport discoverability

`transport`

- `transport-stop`: independently establish safe playing transport in the
  runner-owned Set, then ask the real agent to stop playback without giving it
  action names. Require the exact ordinarily approved stop invocation, an
  independent stopped-state read before cleanup, unchanged content/settings
  apart from playback and naturally advancing position, and explicit owned
  cleanup. Refusal, denial, missing calls, timeout and prose-only success fail
  without an automatic actor retry.

Run the scenario alone, then its group and the remaining runnable suite.
Description/SDK and synthetic harness regressions do not establish real-agent
acceptance. A pre-existing user Live process blocks execution; never control it.

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

`native-listening-rebinding` uses `--native-v2-fixture-input` for
`native-descriptive-insert-before`: two separately verified beats-0–4 captures
in the same owned process, with an explicit stopped/recording-off exact Delay
insertion between them, using existing `browser.load_item` and `devices.move`
with independent intermediate identity/mutation checks, not the optional
adjacent-insert adapter. The runner verifies original listener identity at
index 1, renewed authenticated registration, only the permitted upstream
effect change, independent proof for each pass, and preservation of the first
historical entry. The actor receives the same one-capture prompt twice, with
the current listener ID; the second approval is unavailable until the edit
qualifies. No actor Browser/transport mutation, restart or capture retry is
allowed. Synthetic runner coverage is not real-Live or Desktop qualification.

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

## Session full-active-loop capture

### Native5 bounded same-source repeated capture

Production delivery qualification also includes
`native-metric-session-midi-production-phrase` and
`native-metric-session-audio-production-phrase`: exactly four beats with the
same eight-tool/one-mutation limits and deterministic metric/source/cleanup
verifier. The existing one-beat scenarios retain their exact reviewed scope.
Prepare positive fixtures from the production integration builder, copying
its hash-identified listening bundle without generating another parent in the
fixture helper. Compare the qualified payload inventory with
`apps/desktop/build/ableton-integrations/integration-devices.json` before
packaging, and use before-pack `--reuse` to preserve it. A failed source-identity
comparison requires a new candidate, not a qualification claim based on v5.

The separate `native-listening-metric-silent-tail` group contains
`native-metric-session-audio-silent-tail`: one four-beat scene-zero capture with
the same eight-tool/one-mutation bounds. Its managed audio fixture includes
actual silence and low-energy decay. The deterministic verifier requires a
complete, gap-free retained FFT timeline and at least one record with
`spectralEnergy: 0` and `centroidHz: null`; a steady-tone fixture is not a proxy.
Use an admitted minimal production fixture, not a human-review Set with
unmanifested dependencies or excess file references. Run the scenario, then
the owning group with the same pinned fixture:

```bash
pnpm live:agent-smoke --skip-install --scenario native-metric-session-audio-silent-tail --native-v5-fixture-input "$NATIVE_V5_SILENT_TAIL_INPUT" --output .test-artifacts/independent-metric-listening/silent-tail-evidence.json
pnpm live:agent-smoke --skip-install --group native-listening-metric-silent-tail --native-v5-fixture-input "$NATIVE_V5_SILENT_TAIL_INPUT" --output .test-artifacts/independent-metric-listening/silent-tail-group-evidence.json
```

`native-metric-session-midi-repeat-3` belongs to `native-listening-metric`.
It reuses the positive wire5 MIDI spectrum verifier for **three one-beat
captures of the same scene-zero MIDI clip**, not the retired wire4 metric
adapter. Each actor turn is exactly inspect-listeners, one
play-session-and-listen, one get-pass, optionally one known completed-context
get with includeHistorical=true. No actor polls, retries, shell waits, source
changes, repairs, stop or seek calls are authorized. The harness waits for
terminal completion and stops at the first failure, denial or cancellation.
Total budgets are 24 tools, three mutations and 270000 ms; each pass retains
eight tools, one mutation, durationBeats=1 and maximumDurationMs=30000.
The descriptive 64-sample clock-disagreement target remains **advisory**.

Exactly two harness-only `fixture-beat-zero-reset-v1` boundaries follow fully
verified completed captures. Existing reset stages stop the exact track's
clips unquantized, stop transport, seek beat0, and independently verify
stopped0, all recording modes off, no queued launch, unchanged musical/device
content and launch settings. All captures retain the same loaded producer,
instance, connection/connection epoch and registration; native pass epochs
increase. Every capture requires all metrics, actual FFT phase/retained-count
and cleanup proofs, nonzero spectrum, source/clock proof and exact typed saved
and reopened context. All prior contexts, passes, subjects and links are
rechecked after every pass. Final capture cleanup leaves playback running;
normal runner teardown closes only the fresh owned process.

Required immutable source: the existing
`.test-artifacts/spectrum-vector-readback-closeout/cohort-audio-fixture/provisioned-input.json`
pins `1-Operator`, `live_set tracks 0 devices 1`, scene0 and its eight-beat MIDI
clip (markers/loop start0, loop end8), plus a separately bound warped-audio
listener. Do not edit that source Set. Stage a fresh native5 bundle and copied
owned Set with the private `stage-metric-first-candidate.mjs`; the original
wire4 input is not admissible. Preserve source/audio SHA256 and candidate
manifest/device pins, constant120 BPM, stopped beat0 and recording-off.
Both existing source selectors must match independently inspected content.
This bounded case does not switch listeners MIDI→audio→MIDI; the existing
`native-metric-session-audio-spectrum` remains separate coverage.

Parent-owned real command: set `NATIVE_V5_INPUT` to the `inputPath` printed by
the private staging script (not the original wire4 provisioned input):

```bash
pnpm live:agent-smoke --skip-install --scenario native-metric-session-midi-repeat-3 --native-v5-fixture-input "$NATIVE_V5_INPUT" --output .test-artifacts/independent-metric-listening/repeated-native5-evidence.json
```

Run the new case, then its metric group and the remaining runnable suite only
under runner-owned Live11+isolated storage. Record the actual full Live
version. Unit/harness regressions are not real-Live, acoustic, or timing
qualification; real execution is a separate parent-owned acceptance step.

### Native5 fixed MIDI/audio/MIDI switching

`native-metric-session-midi-audio-midi` is a separately reviewed fixed
two-listener plan in `native-listening-metric`; it does not change
`native-metric-session-midi-repeat-3`. Exactly three serialized one-beat
Session captures use source kinds MIDI, warped-audio, MIDI. Each actor turn
has inspect-listeners, exactly one play-session-and-listen, exactly one
get-pass, optionally one known completed historical-context get. No actor
stop/seek/repair, polling, waits, retries, source edits or failed-pass replay.
Budgets are24 tools,3 mutations,270000 ms total; each pass remains8 tools,
1 mutation,90000 ms, durationBeats1/maximumDurationMs30000 and all three metrics.
The descriptive64-sample policy remains advisory.

Before the first capture the harness independently freezes both exact
source/track/listener bindings, source settings/configuration regions and
same-DSP native5 registrations. Exactly two harness-only reset boundaries
follow verified completed captures. Stop **only the previous selected track**
unquantized before transport stop/seek0; independently read both selected
sources and require no playing/triggered/queued Session clips, all recording
modes off and stopped0 before dispatching the next capture. Public transport
stop/seek0 alone does not stop Session clips and does not establish this
baseline. It is never agent auto-repair authority. Unrelated tracks are never
stopped. Baseline/identity/context/capture failure or cancellation aborts the
sequence without a later capture or reset.

Both producer instances, registration, connections/connection epochs and
bindings must remain stable. Native epochs increase **per producer**, so
MIDI1/audio1/MIDI2 is valid; a reused MIDI epoch is not. Every pass verifies
its own actual source/configuration/clock/FFT phase/retained-count and cleanup,
nonzero metrics, unique pass/context, exact typed persistent reopening and
preserved prior contexts/subjects/links. Existing lifecycle stages retain
queued/started/progress/completed/failed/cancelled timing/trace attribution;
reset evidence includes previous/next source and selected listener metadata.
Final capture cleanup leaves playback running; teardown closes only the
fresh exact-PID runner-owned Live11 process and isolated profile.

Use the original immutable
`.test-artifacts/spectrum-vector-readback-closeout/cohort-audio-fixture/provisioned-input.json`
(Set SHA256 `089a2dc15d61b685b035672b58cc81ccfb81d0f97471ea2d10efe168390c9fcb`).
Require MIDI scene0 on `1-Operator`, `live_set tracks 0 devices 1`, loop0..8;
warped-audio scene0 on `3-AA_SESSION_120BPM_8BEATS`,
`live_set tracks 2 devices 0`, loop0..4; device
`Machine-Listening-Development`, constant120 BPM, stopped0/recording-off and
no selected-track Session launch/trigger at admission. Preserve both exact
`sessionSources` selectors. Parent's private staging helper accepts this
source input as argv2, builds a fresh native5 bundle and copies the pinned
Set/audio dependencies; neither original source nor user profile is edited.
The original native4 input is not admissible. Set `NATIVE_V5_INPUT` to staging's
emitted native5 inputPath, including current manifest/device/Set/audio SHA256
pins and both enabled native5 producer resources.

```bash
pnpm live:agent-smoke --skip-install --scenario native-metric-session-midi-audio-midi --native-v5-fixture-input "$NATIVE_V5_INPUT" --output .test-artifacts/independent-metric-listening/midi-audio-midi-native5-evidence.json
```

Run the new case, then its metric group and remaining runnable suite with
compatible version-specific inputs. Synthetic safety/lifecycle and runtime
regressions are not physical qualification; real execution remains parent-owned.

### Native5 fractional Arrangement qualification

`native-metric-arrangement-audio-fractional-spectrum` uses the same native5
independent-metric host/verifier, explicitly in Arrangement mode. One actor
turn is inspect-listeners, one play-arrangement-and-listen with
`startBeat=0.25`, `endBeat=1.25`, `maximumDurationMs=30000`, one get-pass,
optionally one completed historical-context get. Session target/duration
arguments, polls, retries, repairs, shell waits, actor seek/stop and edits are
denied. Budgets remain eight calls, one mutation and 90000 ms. All three
metrics, actual FFT phase/retained-count and cleanup, nonzero spectrum,
clock/source join, exact range/track associations, typed persistent reopening
and unchanged source/settings must verify. Descriptive64-sample disagreement
remains advisory.

The production playback operation positions the **runner-owned** Arrangement
insert marker and stopped playhead to0.25 before native prepare/arm, then
independently re-inspects before launch. The harness records one exact owned
positioning receipt and requires positioning before any native control.
This is not actor seek authority or onset verification. Capture cleanup leaves
playback running and does not restore the prior marker/playhead; normal
teardown closes only the runner's exact-PID process.

Use the existing immutable source
`.test-artifacts/spectrum-vector-readback-closeout/cohort-bounded-fixture/provisioned-input.json`,
not the Session-only cohort-audio input. Its source Set SHA256 is
`7b8c8d03d18838a29dbca17087e4ad56fae08356175bdd9a837d9a8b2cb2649b`;
it has an enabled warped audio Arrangement clip
`AA_SESSION_120BPM_8BEATS` at0..8 on regular track2,
`3-AA_SESSION_120BPM_8BEATS`, listener `live_set tracks 2 devices 0`.
Loop0..4, warped120 BPM, constant Set tempo120 and pinned48 kHz stereo WAV
already cover0.25..1.25 without source edits. WAV SHA256 is
`1bae0212d0f4b0f7ed18d0d9a97dbd008145559e8c28586d415b659329a0012c`.
Source/audio hashes and enabled/non-silent WAV bytes were inspected read-only;
that is source suitability evidence, not native5 physical qualification.
Require fresh stopped, recording-off Live11, no selected-track Session
override, exact nontruncated Arrangement inventory and one covering audio source.

Parent must parameterize the private candidate staging script with that
provisioned input: build a fresh native5 bundle, preserve track2/device0
selection, copy the pinned Set and audio dependencies, and replace only
candidate/resource references in the copy. Do not edit original fixtures.
Set `NATIVE_V5_INPUT` to its emitted native5 inputPath. Only after the parent
closes its current discovery-reproduction host and the runner can enforce
no pre-existing Live:

```bash
pnpm live:agent-smoke --skip-install --scenario native-metric-arrangement-audio-fractional-spectrum --native-v5-fixture-input "$NATIVE_V5_INPUT" --output .test-artifacts/independent-metric-listening/fractional-arrangement-native5-evidence.json
```

Run the new case, then its metric group and remaining runnable suite with
compatible version-specific inputs. Synthetic host/guard/verifier regressions
are not real-Live qualification. Existing Session/repeated cases are unchanged.

### Explicit unavailable-spectrum engineering qualification

`native-metric-session-midi-partial-spectrum` requires the deliberately
engineered `native5-unavailable-spectrum/v1` candidate, never the repaired
default package. Build it explicitly with `nativeMode:true`, `nativeVersion:5`,
`engineeringOnly:true`, and
`engineeringFixture:"native5-unavailable-spectrum/v1"`. This is a harness-only
fixture admission contract, not environment/profile selection or actor repair
authority.

The hash-pinned native5 input must copy the checked package's exact
`manifest.engineeringFixture` object: schema
`native-metric-engineering-fixture/v1`, ID above, `engineeringOnly:true`,
`unavailableMetric:"spectral-centroid"`,
`sourceSemantics:"spectral-acquisition-not-started"`,
`runtimeEntry:"audio_listener_native_v5_unavailable_spectrum_max.js"`, and its
lowercase SHA256. The package root must retain `realLiveValidated:false`.
Keep all existing immutable MIDI Set, device, manifest, resource, audio and
selector pins; changing a tag alone does not create a qualifying fixture.

Admission checks input/manifest metadata, the resource and actual runtime-entry
hash, and the canonical artifact checker before staging or launching Live.
Mutation during checking, missing/foreign metadata, and repaired defaults
are denied without retry. Normal metric scenarios reject engineering-tagged
inputs/packages. Consequently run this case separately from ordinary positive
cases; a mixed group cannot share one native5 input. The journaled
`metric-fixture-admission` stage records bounded variant/hash proof and
failure/timing attribution. Existing partial metrics, actual source/cleanup,
saved-context reopening and leave-running postconditions remain mandatory.

```bash
pnpm live:agent-smoke --skip-install --scenario native-metric-session-midi-partial-spectrum --native-v5-fixture-input "$NATIVE_V5_INPUT" --output .test-artifacts/independent-metric-listening/unavailable-spectrum-native5-evidence.json
```

Controlled admission tests are not physical qualification; the parent-owned
fresh Live run must verify the deliberately unavailable spectrum outcome.

`native-listening-session` requires `--native-v3-fixture-input`, with immutable
Session MIDI and warped-audio sources on their matching listener tracks. The
reviewed fixture has zero start markers and loop starts, MIDI loop/end markers
at 8 beats, and warped-audio loop/end markers at 4 beats. No fixture edits or
launch-setting repair are permitted.

- `native-session-midi`: explicit 4 beats inside the 8-beat active region
  (20 windows at 120 BPM).
- `native-session-warped-audio`: explicit 4 beats on an exactly 4-beat clip;
  endpoint equality must succeed (20 windows).
- `native-session-midi-full-loop`: omit the `durationBeats` argument entirely;
  independently freeze the exact active loop end at 8 beats, not the previous
  four-beat default (40 windows).
- `native-session-midi-eight-beats`: explicit 8 beats on the same 8-beat active
  region; durations above four and endpoint equality must succeed (40 windows).

Each scenario retains the same eight-tool-call/one-mutation budget, read and
reversible risks, listening/context allowlist, 30000 ms capture budget and
90000 ms scenario timeout. The native ceiling remains 30 seconds/300 windows;
no truncation, implicit duration substitution, actor retry, transport cleanup
or source edits are allowed. Source geometry is inspected and frozen before
launch, joined to native receipts/proof, and verified through one atomic
Session clip/track context, typed historical reopening and unchanged content
with playback left running and capture resources idle.

Run the new scenario alone, then this group and the remaining suite only when
the normal user Live is closed and explicit immutable v3 pins are supplied.
Synthetic composition tests do not qualify actual Live launch/source alignment
or physical timing. A pre-existing user Live/desktop process blocks physical
execution; never control it or install integrations to bypass ownership.

## Native5 longer metric captures (qualification pending)

`native-listening-metric-long` is a separate fixture cohort, not an expanded
actor authorization in `native-listening-metric`. Four reviewed cases capture
MIDI and warped audio independently:

- `native-metric-session-midi-eight-bars` and
  `native-metric-session-audio-eight-bars`: eight bars of 4/4 at constant128 BPM,
  **32 beats = 15 seconds**;
- `native-metric-session-midi-30-seconds` and
  `native-metric-session-audio-30-seconds`: **64 beats = exactly30 seconds** at
  the same tempo.

The upcoming2 MiB allowance is for native metric terminal results and metric
observations, not permission to omit rows, substitute measurements, increase
duration, or change other ingress limits. Each actor retains eight tool calls,
one mutation, a90000 ms turn budget, one exact Session target/listener,
`maximumDurationMs=30000`, one get-pass, and at most one completed historical
context read. Failure/denial/cancellation aborts; no retries, stop, seek, edits,
new listeners or later passes are authorized. The runner owns terminal waiting,
source-pin admission, trace-linked lifecycle stages, native cleanup verification,
full immutable-content comparisons and reopening the saved typed context.
Every invocation launches its own exact-PID Live11 process and isolated storage;
capture cleanup leaves transport running and idle, then teardown closes only
that owned process.

Do not use the original short fixture unchanged. Its MIDI loop/end is8 beats
(only four notes) and its audio loop/end is4 beats, with a192000-frame stereo
PCM16/48kHz file at warp120. Neither supports these first-iteration captures.
The offline preparation script reads **only harness-owned `.test-artifacts/`
inputs**, refuses symlinks/overwrites and writes a fresh copied project. It
requires the canonical cohort-audio provisioned input with original Set SHA256
`089a2dc15d61b685b035672b58cc81ccfb81d0f97471ea2d10efe168390c9fcb` and original WAV SHA256
`1bae0212d0f4b0f7ed18d0d9a97dbd008145559e8c28586d415b659329a0012c`.
It also requires an explicit **current checked default native5 candidate input**,
including exact candidate manifest, device and all resource hashes; the wire4
candidate and unavailable-spectrum engineering variant are inadmissible.
Rebuild/stage the candidate with the normal offline packaging workflow if its
artifact check fails. Never install into the normal profile.

Preparation changes only the copied project: Set tempo and its single constant
baseline envelope120→128; MIDI scene0 becomes `AA_METRIC_MIDI_64BEATS`, with64
explicit notes (the four-note motif copied16 times, final note clipped at beat64);
audio scene0 becomes `AA_METRIC_AUDIO_64BEATS`, with eight byte-identical copies
of the pinned four-second PCM source. That WAV contains1536000 frames /32 seconds
at48kHz, with warp markers(0sec,0beats)/(32sec,64beats), so it plays30 seconds at
Set128. Both clips have start/loop start0, loop/end marker64, unchanged unquantized
trigger, legato off and follow actions disabled. No capture crosses a short clip
loop. The original track/device selectors remain `1-Operator`,
`live_set tracks 0 devices 1`, and `3-AA_SESSION_120BPM_8BEATS`,
`live_set tracks 2 devices 0`, device `Machine-Listening-Development`, scene0.
The new WAV SHA256 is
`ca796950dea55f9c794a774553d139cb4692dbfa440ebad8470a2c3e7dfb4a0f`.
Prepared Set hashes depend on copied absolute resource paths and must be taken
from the emitted `input.json`, never copied from another preparation.

All128/256 quarter-beat rows,150/300 independent100 ms attack-input windows and
every actual phase-sensitive FFT record are required, without reduction or gaps.
At48kHz the exact FFT count is351–352 for15 seconds and703–704 for30 seconds;
at44.1kHz it is322–323 and645–646. It is calculated from the measured first
frame endpoint using2048-sample hops and endpoints no later than capture end,
**not** the conservative allocation budget. Source identity, shared source/clock
proof, trace/correlation/causation attribution, executed FFT cleanup and exact
typed saved/reopened payloads remain mandatory. Synthetic unit fixtures and
offline preparation are not physical/acoustic qualification.

Offline safe preparation (no Live launch, no user profile installation):

After the parent finishes and validates the2 MiB protocol/ingress changes,
rebuild the application packages with `pnpm build` before qualification.
Regenerate a **matched** default native5 bundle; never edit the old compiled
codec or change an old candidate's pins in place. The packaging command below
compiles `audio_listener_metric_protocol.js` directly from current protocol
source and records codec provenance alongside all matching publisher resources.
Create the candidate-selection input from the newly checked manifest:

```bash
STAGE=".test-artifacts/independent-metric-listening/long-2mib-$(date +%s)"
mkdir -m 700 "$STAGE"
node scripts/audio-listener-device.mjs build --out "$STAGE/Native5"
node scripts/audio-listener-device.mjs check-artifact "$STAGE/Native5"
node --input-type=module - "$STAGE" <<'JS'
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
const stage = resolve(process.argv[2]);
const candidateDirectory = join(stage, "Native5");
const bytes = await readFile(join(candidateDirectory, "audio-listener-manifest.json"));
const manifest = JSON.parse(bytes);
if (manifest.nativeVersion !== 5 || manifest.engineeringFixture)
  throw new Error("Default native5 candidate required");
await writeFile(join(stage, "candidate-input.json"), JSON.stringify({
  formatVersion: 1,
  nativeVersion: 5,
  candidateDirectory,
  candidateManifestSha256: createHash("sha256").update(bytes).digest("hex"),
  deviceFile: manifest.deviceFile,
  deviceSha256: manifest.deviceSha256
}, null, 2) + "\n", { flag: "wx", mode: 0o600 });
JS
node scripts/lib/native-metric-scenario-prepare.mjs \
  --source-input .test-artifacts/spectrum-vector-readback-closeout/cohort-audio-fixture/provisioned-input.json \
  --candidate-input "$STAGE/candidate-input.json" \
  --out "$STAGE/long-fixture"
node scripts/audio-listener-device.mjs check-artifact \
  "$STAGE/long-fixture/fixture/LongListener-native5"
NATIVE_V5_LONG_INPUT="$STAGE/long-fixture/fixture/input.json"
```

This recipe preserves the generic128 KiB ingress default; qualification uses
the parent's explicit independent-metric2 MiB mode. The old prepared input is
fixture-preparation evidence only, not evidence of the new compiled codec.
Its Set hash cannot be carried forward because copied resource paths change.

Alternatively, when the parent already has a current checked native5
candidate input with regenerated codec/resource pins:

```bash
node scripts/lib/native-metric-scenario-prepare.mjs \
  --source-input .test-artifacts/spectrum-vector-readback-closeout/cohort-audio-fixture/provisioned-input.json \
  --candidate-input "$CURRENT_CHECKED_NATIVE_V5_INPUT" \
  --out .test-artifacts/independent-metric-listening/long-metric-prepared-NEW
node scripts/audio-listener-device.mjs check-artifact \
  .test-artifacts/independent-metric-listening/long-metric-prepared-NEW/fixture/LongListener-native5
```

The wrapper journals queued/started/progress/completed/failed/cancelled stages,
timing and trace-linked failure cleanup through the shared storage resolver in
the new namespace's isolated automation profile. It preserves original errors,
flushes/closes the journal and removes only its new copied fixture on failure or
cancellation. No binary/audio body is journaled.

`--out` must not exist; its parent must already exist. Set `NATIVE_V5_LONG_INPUT`
to preparation's emitted `inputPath`. **Parent runs the following only after the
user confirms closing their normal Live process**, beginning with one scenario,
then the separately pinned owning group. Record the actual full Live11 version:

```bash
pnpm live:agent-smoke --skip-install --scenario native-metric-session-midi-eight-bars --native-v5-fixture-input "$NATIVE_V5_LONG_INPUT" --output .test-artifacts/independent-metric-listening/long-midi-eight-bars-evidence.json
pnpm live:agent-smoke --skip-install --group native-listening-metric-long --native-v5-fixture-input "$NATIVE_V5_LONG_INPUT" --output .test-artifacts/independent-metric-listening/long-metric-group-evidence.json
```

The original `native-listening-metric` group still requires its original short
native5 copied input. Do not combine short and long groups with one input, do
not run the default all-group selection with the long input, and stop at the
first failure instead of editing the fixture or retrying the actor.

## Same-instance retained Session listening

`native-listening-repeated` requires explicit immutable wire4 pins through
`--native-v4-fixture-input`, with two distinct eight-beat MIDI sources in
scenes 0 and 1 on the same instrument/listener track.

- `native-dual-session-repeat-1-2-1`: listen to scenes 0, 1, then 0 through
  the same loaded producer, instance, connection and independently resolved
  binding. Verify increasing native epochs, three distinct completed contexts,
  unchanged prior observations/associations and exact source/native proofs.

Exactly two reviewed fixture-owned stopped baselines are allowed, each only
after the preceding pass verifies. The user-approved baseline revision stops
fixture clips/transport, positions the stopped disposable Set to beat zero,
and independently verifies stopped-zero/no-queued-launch state and unchanged
musical/launch/device settings. This replaces the original stop-only/no-seek
contract, which left a nonzero position incompatible with Session qualification.
Actor seek/stop/retry permissions and production guards remain unchanged.
These fixture operations are not product cleanup or retries.
First failure stops the sequence. Use `--skip-install`; preserve pinned inputs,
source/content guards and owned-process cleanup. Message-loader and Gen
primitive qualifications do not substitute for this integrated scenario.

## Arrangement source investigation

`native-listening-source-investigation` requires an explicit immutable v2 fixture
via `--native-v2-fixture-input`. In addition to the native-v2 pins, the fixture
must contain exactly one bounded Session source on the listener's regular track,
with a clip length no greater than 16 beats.

- `native-source-baseline`: capture beats 4-12 without a source-state mutation.
- `native-source-arrangement-edit`: duplicate the exact Session source into an
  independently empty Arrangement region at beat 128, inspect and delete the
  returned exact clip identity, verify restoration, then capture beats 4-12.
- `native-source-session-override`: establish and independently verify a Session
  override during reviewed fixture setup; require the exact source refusal, no
  capture publication, and released idle listener resources.
- `native-source-explicit-return`: use the user-approved test-only global Return
  to Arrangement from a globally clear baseline with exactly one Set-wide
  Session source on the listener track. Require complete unchanged track/source
  identities and only that owned launch before a fresh recording-off/source
  guard. Deny unknown/foreign/changed scope; independently verify global and
  target source clear, then stop and request a new explicit pass. This is not
  production auto-recovery or a retry of the separate refusal case.

Each scenario uses a fresh fixture and runner-owned process, with exactly one
actor playback request. Source reads at transitions, immediately before the
actor request, and after termination must match the current query, Set, process,
listener connection, epoch, and binding. Success retains the native-v2 proof,
40-window, atomic-context, typed-reopening, and cleanup requirements. Setup
actions are not product auto-recovery or capture retries.

Unknown-source handling is covered by deterministic protocol and runtime
regressions; this real-Live matrix does not fabricate unavailable source
properties. Its manifests and synthetic tests do not reconstruct the historical
source state or establish real-Live qualification without fixture execution.
