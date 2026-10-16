# Playback Listening and Entity Context

Companion checklist:
[Playback Listening Implementation To-Do](playback-listening-implementation-to-do.md).

Architecture decision:
[ADR 0006](../architecture/decisions/0006-playback-listening-and-entity-context.md).

## Current acceptance checkpoint

At code baseline `b7569dd`, one actual authenticated native Arrangement pass
completes and publishes a typed, retrievable context entry: beats 0-4,
96,000 sample frames, 20 envelope windows, 20 FFT records and four estimated
attacks. Actual native proof independently satisfies the App boundary.
This establishes the bounded capture-to-context prototype, not production
readiness or exclusive clip attribution. Exact typed retrieval also survives
Desktop process restart without another capture. Runner-native acceptance,
the broader host/source matrix and supported 11.3.42 remain open.
The actual host is 11.3.43.

The earlier [implementation checkpoint and regression
baseline](playback-listening-implementation-to-do.md#issue-29-checkpoint---2026-10-13)
retains historical measurements, remaining acceptance and rerun commands from
`bf61bc3`; later checkpoints below supersede its open implementation gates.

Earlier development registration on DRUMS remains historical evidence. The
candidate at `bf61bc3` on `14 Audio` retained its initial flag but reported
`editor_preview_blocked` with the editor closed, preventing discovery. The
approved prototype now removes that unverified flag as a registration
requirement; automatic editor isolation is deferred and the editor must stay
closed during hosted-device commissioning. Actual hosted registration and
reconnect passed; the native envelope follow-up is recorded below. Authentication,
duplicate-listener protection, exact identity/epoch ownership, production timing
denial and safe transport cleanup remain mandatory.

The next acceptance target is a reviewed runner-native workflow.
Session onset support, portable promotion
and production enablement remain unaccepted. Synthetic capture/IPC tests and
the source-fixture scenario alone are not real audio evidence; the recorded
authenticated pass below is separate actual capture evidence.

## Descriptive-listening implementation in progress

The approved next release uses descriptive timing by default, with a 64-sample
observed-disagreement limit adjustable from 0 through 480 samples. Explicit
strict mode accepts zero observed disagreement; it never silently falls back.
The first milestone assumes constant tempo rather than independently proving
stability. Tempo automation is unsupported: do not change tempo during a pass,
and do not interpret completion as proof that no change occurred.
The App capture path and Desktop preferences/Settings are wired and covered
deterministically. Actual native v2 capture and physical/visible qualification
remain open; this is not a readiness promotion.

The shared `listening-timing-schemas.ts` contract defines immutable per-evaluation
policy snapshots, separate observed clock/beat disagreement and actual-rate
millisecond conversion. `audio-observation/v2` removes the v1 algorithm's
`timingUncertaintySamples` field in favor of explicit approximate,
descriptive-only alignment. Estimated absolute error and independently verified
absolute error bound are both null: neither a chosen limit nor a zero observed
disagreement establishes physical accuracy. The protocol's typed historical
reader accepts both versions without changing v1 validation. Authenticated
ingress and independent capture validation now support either version explicitly.
Typed publication, storage and context queries preserve each version without
relabeling it. The production playback host now selects explicit v2 geometry
and immutable trusted timing policy, positions before arm, and independently
validates its capture path. This is deterministic integration, not a claim that
the new native device has completed physical qualification.

The separately versioned native v2 arm, launch and completed-capture contracts
are implemented. The App freezes its expected policy, musical range, actual DSP
geometry, listener and pass identities rather than accepting producer-selected
limits. Independent validation fixes the host/native offset at the first
coherent preflight row; four linear extrema plus a circular-phase maximum
witness expose observed offset, beat-origin and phase disagreement across
capture. The budget cannot excuse changed data
at a held native counter, backwards retained clocks, stopped-after-playing
evidence, malformed brackets, missing native coverage or invalid FFT data.
Exact native counts and final partial-window duration remain distinct from
approximate beat/host attribution.

Compact proof retains each reported native window-end counter and processed
stereo RMS, independently verifies exact window coverage, and recomputes
duration-weighted RMS and spectral summaries, and independently checks the fixed
attack estimator. A reused final-window FFT must retain identical values.
A complete synthetic 30-second/300-window result fits the unchanged 128 KiB
ingress limit; this is a wire-budget regression, not actual capture evidence.
Separate v2 registration/control/reply/result schemas require explicit ABI and
capabilities, actual DSP rate/vector metadata and a prepare-only configuration.
Authenticated ingress advertises both versions while retaining the legacy v1
schemas. Producer schema, registration, controls, replies and results must agree
on version. The channel clones the App prepare configuration, verifies actual
registered DSP geometry and independently checks arm, launch and completed
capture against it. Completion must retain the exact previously accepted arm
and launch evidence. Subsequent arm counters must advance beyond retained
evidence on that connection. Watchdogs derive duration from native counts;
failure, cancellation, sequencing, trace ownership and redaction use the same
existing lifecycle rather than a parallel transport stack.

The shared portable `AgentSignalClient` also negotiates the explicitly selected
listener version. V2 requires matching observation schema, single capability
and ingress advertisement; it cannot fall back to v1. Prepare alone carries
the bounded coherent geometry/policy. Arm and cancel cannot replace it.
Replies/results retain the selected version, connection epoch, sequence and
causal owner. MIDI defaults and v1 wire behavior remain unchanged. Actual
shared-client-to-ingress tests cover completed synthetic proof, confirmed
cancellation and disconnect without complete publication; these do not
establish physical native execution.

V2 SDK registration and prepare inputs are copied/frozen, exact-version/stage
guards reject mixed or unsupported frames, and busy/foreign/late callbacks
cannot orphan another reservation. Cyclic/oversized local output fails
explicitly without an offline audio queue or sequence advance; the encoded
frame ceiling remains 128 KiB and callback failures are bounded/redacted.
Generic `signal.frame` cannot bypass native result proof. Cancelled replies
retain the protocol's optional reason, while failed replies still require one;
the SDK does not replace a valid cancellation with an ingress timeout.

The production playback host exposes negotiated v2 listeners with approximate,
descriptive-only and unknown-absolute-accuracy limitations; metadata alone never
sets `ready:true`. It snapshots Settings policy once per pass, derives geometry
from actual registered rate/vector and inspected constant tempo, and rejects
mixed versions/DSP geometries or unsupported duration before reservation.
Descriptive mode never falls back to v1. Explicit strict mode can retain the
old restricted v1 prototype or request v2 with a zero observed-disagreement
budget; even strict v2 does not acquire a physical accuracy certificate.

After reserving context and before native arm, v2 calls the explicit guarded
Arrangement positioning command, then freshly resolves binding/source/revision.
Only this authorized positioning may reconcile its own transport revision;
source fingerprint, tempo, instance/rate/vector changes still fail. Native
capture independently validates policy, geometry, launch and complete proof,
with attributed/timed alignment lifecycle and confirmed cancellation. Accepted
host offset disagreement of 64 samples can publish under default policy;
65 samples cannot, even if a producer underreports its own quality.
Native window coverage/count errors remain hard failures. Cancellation while
positioning cannot arm/start afterward or undo a late admitted position.
Both v2 ingress and internal capture watchdogs allow native audio duration plus
15 seconds for the bounded launch/post-processing stages; legacy ingress keeps
its original five-second slack. The caller's overall wall-clock budget remains
an independent, potentially earlier deadline.

The context repository registers both bounded payload kinds at the same owned
SQLite path/schema version. Entry kind must match payload version. V2 quality
survives compact summaries, detail, close/reopen, typed tools/IPC and resume;
v1 history retains its original fields. Requested and measured/quantized beat
ranges remain separate, and descriptive observations cannot certify exclusive
attribution. Legacy v1-only kind declarations reconcile through the existing
atomic registry/manifest hook before a new append, not an independent store.

The native descriptor assembler now accepts explicit 44.1/48 kHz geometry with
approximately 100 ms hops, at most 30 seconds/300 windows and an honest partial
final interval. Separate explicit constant-tempo/start coordinates map those
native samples to nonzero beats without changing default beat-zero/120 BPM
arithmetic. Its default remains byte-compatible with the v1 assembler.
This is an internal assembler prerequisite, **not yet support in the native
producer**: controller, engine, Gen source/onset model and resource composition
still need the separately versioned generalization.

Historical controller/SDK executions retain their original assembler hash,
verified against the exact bounded source archive from commit
`0a0159882589333640144769e502ecc135803279`. A separate recorded-packet replay
checks current default and explicit-default descriptor output against that
archive. Neither source preservation nor deterministic compatibility is
fresh execution evidence for the changed assembler. The unchanged recorded
manifests are not rewritten to claim it was measured.

An instrumented fresh-process probe established one supported ordinary-start
primitive on installed Live 11.3.43: assign `Song.start_time = 5.25`, independently
read the marker, assign/read stopped `current_song_time = 5.25`, then call
`start_playing`. The later playing read was beat 5.642222222222222, rather than
the previous stopped position above beat 827. The probe restored marker 128,
the exact previous stopped position and stopped transport before closing owned
PID 85822; installed Remote Script source was restored byte-for-byte. This is
capability evidence, not independently measured source onset or native capture
acceptance, and does not qualify 11.3.42.

The first probe guard incorrectly required the display name `Untitled`; Live's
native name for this unsaved Set was empty. The denied, non-mutating inventory
is retained separately from the successful probe. Unsaved identity must check
the actual file-path/identity contract, not infer a saved Set from an empty name.
The probe source, numeric readbacks and exact process record are preserved in
`max-patches/audio-listener/fixtures/arrangement-start-marker-probe*` with
regression coverage. The production insert-marker guard remains unchanged.

Generalized native device/controller capture, real Settings/visible-quality
acceptance and fresh end-to-end qualification remain required. Desktop
supported-kind compatibility, Settings persistence and mixed v1/v2 historical
typed reopening pass isolated component/IPC/Electron coverage. Ordinary App
positioning/configuration/capture/context wiring is
covered deterministically, not yet by an actual v2 native capture.
The independent integration verifier now accepts v2 only with an explicit
App-owned geometry/policy expectation, preserves requested versus quantized
ranges, and revalidates proof, attribution and reopened quality. Synthetic
verifier tests are not real-Live acceptance. The legacy native scenario pins
strict/zero policy explicitly; it is not silently upgraded by the new default.
Existing detected tempo changes and timing/integrity violations still fail
explicitly. Guaranteed detection of brief/small tempo changes, including changes
that return to the initial tempo or fit within the disagreement budget, is
deferred to [#55](https://github.com/CooperNederhood/Ableton-Agent-App/issues/55)
and is not a first-milestone release gate. This does not add tempo-automation
support or certify beat/range mapping outside the constant-tempo assumption.
The agent tool/discovery and v2 Desktop detail expose that limitation even
when an older observation omitted a producer-declared warning.
Native corruption, missing
frames, unsafe recording/source state, stale ownership, timeout and unconfirmed
cleanup remain hard failures regardless of the timing limit.

### Explicit v2 candidate staging

`node scripts/audio-listener-device.mjs build-native-v2-authored --source
<authored-device.amxd> --out <fresh-staging-directory>` selects the v2 bootstrap
and `nativeRuntimeDocuments({ nativeVersion: 2 })` resources. The equivalent
build API requires both `nativeMode: true` and `nativeVersion: 2`; unknown or
implicit version selections fail before publication.

The authored UI/direct stereo and source device are preserved. The manifest
pins every adjacent resource, selects algorithm 2.0.0 / `audio-observation/v2`,
declares 30 seconds / 300 windows, and explicitly records the constant-tempo
assumption and unsupported automation. Its 60-second watchdog value is a
fixed outer native-monitor ceiling, not host qualification or a promise of
measured execution.
Artifact checking rejects mixed bootstrap/version/schema/scope/limit metadata.
Default builds and `build-native-authored` retain their old v1 behavior and
manifest compatibility.

This command only stages a candidate. It never installs/promotes, changes
`realLiveValidated: false`, rewrites a saved Set, or substitutes new resources
for old physical evidence. Actual Max compilation, native receipt delivery,
capture, save/reopen, pass-through and resource-cost acceptance remain required.

The immutable fixture stager also requires an explicit matching v2 caller
selection and `nativeVersion: 2` in the pinned fixture input. It checks matching
v2 manifest scope/schema/algorithm/limits/tempo disclosures before copying
anything, preserves the Set and all device/code/manifest bytes, and regenerates
only the copied profile discovery configuration through the shared storage
resolver. Cancellation removes only its new owned copy. The existing strict
v1 scenario does not opt into v2 or accept v2 inputs. Separately reviewed
descriptive v2 scenarios are wired below, but still require a newly saved/pinned
v2 fixture and real execution.

The v2 graph must construct the independent Max-JS guard as
`js audio_listener_guard.js 2`: its fixed 60-second begin-to-stop budget covers
up to 30 seconds of audio plus bounded preparation, launch and postchecks.
Default/explicit-v1 guards retain their 30-second total ceiling. Both retain
the two-second heartbeat cutoff, exact-generation stop/replacement/deletion,
and no transport control. Heartbeats and repeated arm requests cannot extend
the total deadline; invalid constructor versions or supplied deadline arguments
fail closed. V2 watchdog lifecycle records retain redacted trace identity and
the selected version/ceiling; monitor completion still leaves capture outcome
unknown. Historical guard bytes are archived with their original source/hash,
not substituted into old physical evidence.
The shared control fanout is explicit: `configure_v2` is validated by envelope
IO and cannot renew the guard deadline; generation-owned `release` ends the
monitor with a cancelled/unknown-capture outcome and one best-effort stop,
never fabricating a native stopped receipt.

The production v2 factory admits the exact descriptive scope when registration
is `READY`, or remains `BLOCKED` specifically because
`fresh_per_pass_native_validation_required`. This matches capture and ingress
admission; it does not promote registration or waive genuine arm, launch or
completion proof. Other blocked reasons still deny before reservation or
positioning. The first real v2 runner attempt exposed an inconsistent
factory-only `READY` requirement and failed without context publication;
that failed attempt remains evidence, not a native DSP qualification.
After correcting admission, the next fresh-process attempt independently
positioned beats 0.25–3.75 and completed native prepare at 48 kHz/vector64.
Native arm then failed `native_metadata_changed`, before playback launch or
publication. Cancellation was unconfirmed after an ownership-mismatch denial.
The runner closed only its owned Live process and cleaned its copied fixture.
This remains an open native integration failure; neither attempt is a successful
v2 capture or justification for a wider timing budget.
The separately rebuilt and normally saved diagnostic fixture retains the
previous candidate unchanged. Its next owned attempt records
`native_metadata_changed_abi_spectrum_0`: the actual spectrum ABI snapshot was
zero, not the required two. The bounded typed failure attribution identifies
the rejected packet without accepting it or establishing why it was zero.
`fixtures/native-v2-arm-metadata-failure.json` preserves that negative evidence;
its replay remains a denial, not physical capture authority. Earlier generic
failures are not retroactively assigned this cause.
The canonical Live log also records two Max codebox compiler errors immediately
after loading that exact runner-owned fixture: declarations must precede
expressions. These are actual compilation diagnostics, not inferred initialization
behavior; the log does not identify the offending codeboxes. The source correction
still requires a fresh native load and capture before physical acceptance.
The emitted v2 spectrum codebox did contain a matching declaration-order defect:
`sourceSampleRate = samplerate;` preceded inherited `History` declarations.
The v2 generator now emits that assignment after all declarations. A recursive
regression on the actual emitted codeboxes failed specifically on spectrum
before the fix and passes afterward; existing v1 byte hashes are unchanged.
This source finding does not establish which instances produced the two log
messages or replace real compiler, ABI and capture confirmation.

V2 producer observations also retain the constant-tempo assumption and
unsupported-automation warning for completed, failed and cancelled results.
The warning is durable producer data, not an App rewrite of historical payloads.

V2 failed-arm and cancellation settlement must distinguish terminal wire
ownership from confirmed native cleanup. After native begin, terminal control
publication waits for the exact generation's actual stopped receipt or its
bounded stop deadline. A missing receipt is an explicit failed/unconfirmed
outcome, never a successful cancellation. A prepare-only reservation can cancel
without native stop because native acquisition never began. The App validates
reply attribution and increasing sequence before accepting a v2 failed reply
as terminal wire ownership; it preserves the primary/stop-failure reason rather
than sending an impossible second cancellation to an already released owner.
V1 compensation behavior is retained. This does not promote a failed reply,
an absent owner or a synthetic replay into native stop evidence.
The producer enforces this ordering for failed arm before armed publication and
for cancellation, including reentrant receipts and registration/disconnect/stop
fencing. Its one-second stop timeout retains the primary failure followed by
`_native_stop_ack_timeout_unconfirmed`; it returns failed, never cancelled.
Prepared-only cancellation, v1 behavior, normal v2 completion and frame-quota
failure settlement retain their existing paths.

The next fresh corrected fixture (implementation `72cd9aa`) loaded without
codebox compiler errors but still failed arm with
`invalid_native_spectrum_packet`. No launch or context was published; the primary
failure was preserved instead of the earlier redundant-cancel ownership error,
and exact-owned process/fixture cleanup succeeded. Its bounded evidence is
`fixtures/native-v2-spectrum-preflight-failure.json`. That run did not retain the
rejected spectrum numbers, so no actual packet or physical cause is invented.
V2 rejection diagnostics now identify the failed check and safe integer
end/start/frame-end/invalid-frame counters, bounded to the existing reason
format. Fractional, negative or unsafe counter values are visibly marked invalid.
These diagnostics do not relax counter, energy, Nyquist, silence, interval or
torn-snapshot validation; v1 reasons remain unchanged.

V2 failed replies/results may also carry `nativeFailureDiagnostic` with scope
`native-spectrum-rejection/v1`.
This strictly bounded, non-authority object contains the generation UUID,
failed-check enum, exact six finite spectrum values, the latest five finite
Gen FFT diagnostics (or explicit null), and actually received DSP/FFT/ABI
metadata (each unavailable entry is null). Unknown keys, strings in numeric
slots, non-finite values, wrong lengths and diagnostic payloads on any
non-failed stage are denied by both the shared producer SDK and typed ingress.
No audio or arbitrary text body is admitted.

The existing failed lifecycle record retains this object through the redacted
application-owned journal and typed History, with the outer job/pass/trace/
correlation/causation attribution and elapsed timing. It is never native arm,
launch, completion or stop proof and cannot authorize context publication.
The additional v2-only FFT taps are passive; their poll is ordered before the
main spectrum snapshot but does not claim vector-atomic sampling across taps.
V1 wire shapes and frozen graph bytes remain unchanged. These diagnostics must
be paired with the updated v2 App/SDK, not silently downgraded for older readers.

The fresh diagnostic load at implementation `fbfcbeb` verified this complete
native-to-typed-journal path. Arm failed after 42 ms with the actual spectrum
packet `[-1, 0, 0, -1, -1, 494]` and latest FFT diagnostics `[0, 1, 0, 1, 255]`.
FFT metadata was `[2048, 2048, 2048, 1]` and spectrum ABI was 2; the other
metadata entries had not arrived at rejection and remain null. These separately
polled diagnostics do not establish a physical cause or vector-atomic snapshot.
The bounded evidence is `fixtures/native-v2-spectrum-fault-diagnostic.json`.
No launch/context occurred, and exact-owned process/fixture cleanup succeeded.
The spectrum failure remains unresolved; diagnostic delivery is not capture
acceptance and does not replace the earlier run's missing raw values.

A separate fail-only, runtime-instrumented probe retained 83 received clock
packets over a 900 ms observation window. Its first4/last4 snapshots show the
native counter remaining zero while independent host samples advance from
1619904 to 1661888. Actual DSP was on at 48 kHz/vector64 and all three ABI values
were 2. This rules out missing clock messages in that probe, but does not yet
isolate Gen arithmetic from output/readback wiring. All measurement admission
was blocked, failure was forced after 902 ms, and one genuine stop ACK arrived.
No native arm/playback/context was authorized. Copied resources and original
pins were unchanged, and exact-owned cleanup was verified. The bounded record is
`fixtures/native-v2-counter-observation.json`, not ordinary capture acceptance.

The predeclared fresh-process B control changed only the final emitted clock
update from `clock = min(17592186044416, clock + 1);` to `clock = clock + 1;`
in a uniquely named Gen copy, with one parent reference and declared manifest
updates. At the same actual DSP geometry, its first4/last4 native counters
advance from 1048512 to 1090496, matching independent host counters. This isolates
the capped update expression in that contrast, not the compiler's internal
cause. Uncapped B is not a production correction: saturation at the original
counter ceiling must be preserved. Spectrum frames still failed publication,
now with advancing diagnostic frame starts and no recorded continuity-failure
bin. The fail-only probe admitted no data or arm/playback/context and forced
failure after 901 ms. Cleanup and unchanged original pins have explicit
receipts. See `fixtures/native-v2-clock-update-control.json`.

The v2 clock implementation now replaces that capped update with bounded
high/low-word arithmetic. It preserves the original 17,592,186,044,416 ceiling,
increments below it, holds at it and clamps oversized integer states to it.
The directly coupled clock-eligibility check uses the equivalent high-word
comparison and still denies the ceiling or higher. Epoch/configuration gates,
other native sources, packet layouts and ABI2 remain unchanged. Boundary
regressions cover zero/one, word rollover, ceiling-minus-one, ceiling, oversized
states and configuration/cancellation/epoch denial; frozen v1 bytes remain
unchanged. A separate fresh fail-only run of the exact corrected resource now
confirms native advancement: 83 received clock packets with first4/last4
counters 1012160 to 1054144 matching independent host samples at DSP48k/vector64,
ABI2. Failure was forced after 900 ms with no admission/arm/playback/context;
explicit cleanup and original-pin receipts succeeded. The resource hash and
bounded evidence are in `fixtures/native-v2-saturating-clock-observation.json`.
This confirms advancement at the observed values, not a physical ceiling test
or ordinary capture acceptance. The separate spectrum rejection remains.

A diagnostic-only spectrum variant retained actual FFT-local sample rate and
per-frame failed-predicate flags while preserving all original guards, math,
main outputs and ABI. It reported `[48000, 4, 15, 0, 0]`: local rate 48 kHz,
finite-comparison failure only, all four FFT components flagged, first faulty
bin zero and reported maximum component magnitude zero. The corrected clock
continued advancing, but original spectrum publication still failed. These
repurposed private diagnostic outputs never entered the SDK/typed failure
contract; live rate and retained flags are not atomic. The bounded evidence is
`fixtures/native-v2-fft-guard-observation.json`. No production finite-bound
rewrite follows from this observation alone. Forced failure at 902 ms admitted
no capture, and exact-owned cleanup/original-pin receipts succeeded.

The declared stricter comparison control then changed only the original four
finite-input comparisons and eight passive observer comparisons from the
inclusive 1e12 ceiling to 1048576 in a unique test Gen. Native silence frames
now publish: first `[1083392,0,0,1081344,1083392,0]`, last
`[1126400,0,0,1124352,1126400,0]`, with no invalid frames and diagnostic tuple
`[48000,0,0,-1,0]`. This isolates the comparison-ceiling expression in that
contrast, not compiler internals. The stricter test ceiling is not a production
correction; production must retain the original inclusive 1e12 range. The
900 ms nonaccepting tap again forced failure at 902 ms with zero admission/
arm/playback/context and successful explicit cleanup/pin receipts. See
`fixtures/native-v2-finite-bound-control.json`. Idle silence-frame publication
does not qualify capture of a played passage.

The v2 production guard now uses bounded `2^20` words with high threshold
953674 and remainder 331776, preserving the original inclusive absolute 1e12
limit for every FFT component. Normalized remainder arithmetic avoids a wide
literal comparison without narrowing the accepted range. Boundary regressions
cover exact limits and adjacent doubles, signs, subword values, overflow,
NaN/Infinity and the actual zero-input failure pattern at both rates. Other
guards, spectral math, rate handling, ABI/wire and frozen v1 bytes remain
unchanged.

Actual nonaccepting run `c7e9153f` now confirms idle native silence-frame
publication from that full-range production source: exact code hash
`5bd377dc1eee13b58e1567880fb1a1d99cd0da0d1b20a104a913fbbfd08e34f4`,
85 spectrum packets, first `[954368,0,0,952320,954368,0]`, last
`[997376,0,0,995328,997376,0]`, and zero invalid frames. This run did not
substitute the stricter ceiling. It also retained 86 private envelope diagnostic
tuples without changing original outputs1–23, ABI16, controls or stopped-ACK
routing. At actual DSP48k/vector64, local clock, computed capped-next clock and
the tapped wide literal all evaluated to zero. A comparison-only isolated
epoch1 failed its bound/full gate. Actual input counters advanced from 957696
to 1000384 but failed validity; projected ends 1437696 to 1480384 triggered
headroom rejection despite being below the intended ceiling.

These are separate, non-vector-atomic private taps, not native ownership or
arming receipts. Live epoch stayed zero and configuration stayed unset;
the idle configuration is not itself a failure. The observations identify
directly coupled envelope expressions requiring correction, not universal
compiler behavior. The exact earlier corrected-clock resource is archived as
`fixtures/native-v2-clock-saturating-8e33f8d.gendsp`; its physical record cannot
qualify subsequent epoch-guard changes. The combined bounded record is
`fixtures/native-v2-coupled-guard-observation.json`. Forced failure at 900 ms,
zero measurement admission/native arm/playback/context, removal of the private
callback, and exact-owned process/fixture/original-pin cleanup all succeeded.
Idle FFT publication does not qualify an armed passage capture or Live11.3.42.

The directly coupled v2 envelope correction now replaces its local-clock cap
with the same bounded-word saturation, evaluated after any epoch reset.
Envelope epoch/counter/projected-headroom bounds and the continuous-clock
epoch gate use equivalent high-word comparisons, retaining the exact `2^44`
ceiling and original integer, positivity, strictness, configuration, timing,
continuity and stopped-receipt rules. No timing budget, spectral math, wire
layout, audio path or frozen v1 behavior changes. Fail-before regressions cover
the actual endpoint failure pattern, modeled 86-poll idle replay, nonfinite and
ceiling edges, rollover, reset ordering, cancellation, sealed-ACK distinctions
and final tails. Historical reversal reproduces the archived clock and envelope
code rather than rewriting their physical evidence. Current clock resource
hash `39b40099140ceda608c824174f25f9755e66a1fa46f5b001c6be405e47a3caf6`
and envelope resource hash
`f633c46d00e998473013512652e86b5778c75b692b79cba82d5a58cc36e83589`
are bound to the subsequent native observation.

Actual nonaccepting run `b9d11054` confirms corrected idle behavior: 83
continuous-clock packets advance with host counters, and 88 private envelope
tuples show advancing local clocks, next-clock equal to pre-update clock plus
one, valid input-counter bounds and no headroom rejection. The isolated
comparison-only epoch1 now passes its bound/full gate. The untrusted wide-literal
tap remains zero and is not used by corrected guards. Live epoch stays zero,
configuration stays unset, and no arm or sealed receipt is claimed. The first
tuple retains different sample counters across taps, explicitly demonstrating
why these observations are not vector-atomic. Current full-range FFT still
publishes 88 clean idle silence frames. Forced failure at 902 ms, zero admission/
arm/playback/context, genuine stopped acknowledgement, callback removal and
exact-owned process/fixture/original-pin cleanup all succeed. See
`fixtures/native-v2-corrected-envelope-observation.json`. The next gate is a
fresh normally saved immutable candidate and genuine fractional capture, not
another widening of timing limits.

### Reviewed descriptive native runner scenarios

The `native-listening-descriptive` group contains
`native-descriptive-fractional` (beats 0.25–3.75, 8-second request budget) and
`native-descriptive-30-seconds` (beats 0.25–60.25 at 120 BPM, 45-second request
budget). Both freeze descriptive/64 policy and derive geometry from independent
tempo inspection plus the actual accepted 44.1/48 kHz registration/vector
metadata before the actor starts capture. Expected proof is bound to the
App-owned queued pass, never reconstructed from producer output. Approval
retains a snapshot of the reviewed range, not a mutable manifest reference.

After a coordinated workspace build and verifying the installed Remote Script,
run the fractional scenario alone with
`pnpm live:agent-smoke --scenario native-descriptive-fractional
--native-v2-fixture-input <pinned-v2-input.json> --skip-build --skip-install`.
Only after that passes run the owning group, then the remaining suite.
Native selection checks version-specific inputs and unsafe flags before setup;
v1 and v2 fixture inputs are never substituted. Every scenario uses a fresh
owned process/artifact namespace and finishes shutdown/cleanup before the next.
Source positioning stays in the guarded production host, never runner repair,
retry, or stop/rewind cleanup. The verifier requires a real terminal pass,
independent proof, one atomic track/range context, typed reopening and unchanged
Set content. These are implemented deterministic contracts, not actual native
or physical qualification.

## Ownership and scope

A listener is a transparent Max Audio Effect measuring the signal at its
device-chain position. Several listeners may share a track. Distinct listener
observations never overwrite one another merely because the track or clip is
the same.

An App session owns the context store. Subjects identify the exact Live Set,
clip/track/range, and observed settings. Agents in the same App session share
validated context; independent App sessions do not implicitly merge records.
Ableton remains the authority for musical state.

Tool execution carries the invoking agent's App-session ID, agent ID and
tool-call trace explicitly to the host. Never infer ownership from the globally
selected Desktop session; background agents and resumed agents retain their
own scope.

The first payload kind is `audio-observation/v1`. Persist measurements, not
recordings. Future typed context kinds can add other evidence without changing
the owning session or exposing arbitrary SQL/filesystem writes.

## Intended tool surface

The `ableton_listening` group provides bounded listener discovery, exact Session
clip playback-and-listen, Arrangement range playback-and-listen, pass get/list,
and owner-scoped cancellation. The `ableton_context` group provides bounded
context discovery/detail and destructive, explicitly approved pruning.

Play-and-listen is reversible-risk transport work. Require recording off and
stopped transport, acquire the application's shared transport lease, resolve exact inspected
targets, and wait for all listener readiness before starting. Never implicitly
solo/mute tracks, clear Session overrides, change routing, or alter loop/effect
settings. Existing ordinary launch and transport tools retain their behavior.

Recheck transport and recording guards after readiness. The playback adapter
must enforce those guards again at its mutation boundary and clean up partially
armed listeners or aborted starts. Retain the transport lease through the
owned pass's terminal cleanup, not merely through the initial tool response.

Capture begins at actual playback/clip launch, including quantization. A
requested start timestamp is not measured audio time. Use sample/beat/time
coordinates, frame sequence, epoch, and documented descriptor offsets.

Arrangement capture is bounded, but playback deliberately continues after
completion, cancellation, failure, or timeout. Cleanup disarms listeners and
releases local monitors and the application lease; it never stops or rewinds
Live. A cancellation request cancels measurement/publication, not transport.
Expose `cleanupPolicy: "leave-running"` in pass results and lifecycle events.

Live 11 property notifications cannot establish exclusive transport ownership:
a forward seek can resemble natural advancement, a same-value retrigger need
not notify, and polling can miss transient user actions. Therefore a successful
start must not mint an ownership token or imply that a later automatic stop is
safe. An application lease serializes application work only; it cannot prevent
the user's transport actions. The coordinator retains a legacy `stop-owned`
adapter contract for explicitly ownership-capable backends and tests, but the
Live 11 Arrangement adapter must not use it. Session capture remains unsupported
until actual quantized source onset can be independently established.

This policy is the conservative implementation decision while user confirmation
is unavailable. It preserves the ordinary playback-tool semantics without
risking an automatic stop of subsequent user playback. Listener disconnect and
timeout still require bounded watchdog cleanup; failed disarm or monitor release
is a visible failed pass, not fabricated cleanup success.

After initial transport/recording validation, the coordinator enters
`reserving-context` before any listener control or playback mutation. The
production publication adapter reserves the canonical two-MiB pass ceiling
against the invoking session's repository and preserves the caller trace and
agent attribution. Full-store failure therefore occurs before listening rather
than after an expensive capture. The reservation remains held through atomic
publication and is released idempotently during terminal cleanup for success,
failure, cancellation, and shutdown. Aborted reservation setup must compensate
its own late completion; release failures are visible failures, not successful
cleanup. No existing context is pruned implicitly to make room.

Caller abort is checked before job allocation and propagated through ownership
and Session-target resolution, capture and terminal cleanup. Queued lifecycle
notification occurs only after the terminal waiter is installed, so immediate
cancellation cannot return a misleading nonterminal receipt. Agent cancellation
also settles owned background passes after SDK idle; it never cancels another
agent's pass. Under the Arrangement `leave-running` policy it never stops
transport.

The coordinator bounds readiness and each cleanup operation to ten seconds.
An unresponsive disarm or monitor-release adapter produces a visible failed pass
even when the original request was cancellation.
The playback/capture wall-clock budget starts at the playback mutation boundary;
unused readiness time does not extend it. The listener's actual sample/beat
window remains the measurement authority.
Publication also observes cancellation and the remaining pass deadline.
An interrupted publication acknowledgement is an indeterminate failed pass,
not proof that no context was committed; query by pass ID before retrying.
Persistence adapters must honor abort before their atomic commit point.

The concrete `createListeningHost` facade owns one coordinator and an inventory
of at most 100 jobs. Typed get/list/wait/cancel requests are checked against the
invoking App session and initiating agent, not UI selection. Pagination cursors
are opaque, owner-scoped, and fail explicitly after their anchor is evicted.
Historical job ownership is retained across a Set-identity transition within
the same App session. Inspection and playback adapters receive the pass owner
and trace explicitly even after the initial SDK tool invocation returns.

## Measurement semantics

Native descriptors include peak, RMS envelope, estimated envelope-rise attacks,
and spectral centroid. Channel handling must preserve anti-phase stereo energy.
Silence must not persist non-finite values. Record units, algorithm/version,
window/hop/settings, captured coordinates, limitations, and truncation.

The current shared control contract bounds a provider capture to 120 seconds
and 512 windows; the tool's 300-second budget and canonical 1,024-point payload
are ceilings, not proof of provider support. Reconcile provider limits before
playback and reject unsupported coverage rather than silently truncating a
complete observation.

Peak/RMS dBFS is not perceptual LUFS. Estimated attacks are not guaranteed
onsets or section boundaries. Centroid differences are not proof of quality or
that one specific effect caused a change.

## Attribution and freshness

Persist each listening pass as immutable evidence and create independently
validated links to entities. Record actual Session/Arrangement activity,
listener placement, and relevant source/upstream/routing context.

The implemented `listening.inspect_context` boundary supports exact top-level
Max Audio Effects and reports bounded Live activity/settings evidence.
Its fingerprints describe available LOM fields, not source-file content or
durable entity identity, so incomplete dependencies remain unknown. The
reported current beat is inspection evidence, not a sample-aligned onset
certificate. A Session launch acknowledgement can mean triggered rather than
actually sounding; neither acknowledgement can certify a complete capture.

Max LiveAPI physical IDs and bridge connection-scoped reference UUIDs are
different identity namespaces. Do not copy the transport's physical track or
device IDs into bridge-reference fields or certify their equivalence from
names. The implemented binding helpers join authenticated
`descriptor.registration.deviceCanonicalPath` and `trackCanonicalPath` against
independent Remote Script LOM path attestations with fresh query IDs, exact
connection/instance/epoch checks and collision rejection. Top-level regular,
return and master devices are supported; nested placements remain unsupported.
`nativeStatus` is producer-reported readiness, not certification. A successful
path join proves only the current connection binding, not DSP timing, durable
identity, exclusive audio, or playback ownership.

Mixed/master observations belong primarily to track/range context. Contributors
can be linked without storing a mix as an isolated descriptor of each clip.
Unknown attribution is a valid historical outcome, not a successful exclusive
clip attribution.

`buildListeningPublication` projects inspected bindings and complete canonical
observations into one atomic pass publication. It retains one entry per listener
and uses primary/contributor links instead of duplicating mixed measurements
onto each clip. Conflicting subject evidence, duplicate bindings, foreign
owners, mismatched pass IDs, empty coverage and payload-budget violations fail
before publication. Initial link freshness is explicitly unknown; even a
completed capture is not proof of current source/dependency identity.

Source, gain/pitch/warp/marker changes invalidate affected links. Track
relocation and listener movement have explicit placement/range effects.
Upstream changes do not automatically invalidate unaffected upstream taps.
Unobservable plug-in state or external input makes freshness unverified.

Revalidate relevant fingerprints before returning current-only context.
Events accelerate invalidation but cannot prove freshness alone. Runtime UUIDs,
track indices, names, and canonical M4L paths are not durable identity. On
reconnect, ambiguous clip/device reconciliation preserves unresolved historical
records instead of attaching them to replacement entities.

## Session persistence and resume

The shared storage resolver owns the nested App-session context path. Store
references, not duplicate measurements, in the session manifest/registry.
Publishing the first context for an unsaved in-memory session must also make
that session rediscoverable after restart.

Resuming restores passes and context links before preparing the agent's bounded
inventory. Detailed arrays stay behind typed queries. Set/session switching
clears prepared context. Missing or corrupt stores surface recovery failures,
not silently empty inventories.

Context and pass pages are capped at 100 entries. Opaque continuation cursors
are bounded to 2,048 characters independently of entity IDs, matching the
repository contract; they do not expose SQL or filesystem query access.

The headless `createSessionContextHost` adapter connects list/get/prune and
resume-inventory callbacks to the typed repository through an invoking-session
resolver. It forwards per-query trace, agent and cancellation context, includes
subject names and attribution caveats in summaries, and retains explicit
unknown freshness rather than presenting it as fresh evidence. Detailed arrays
are returned only by get. Inventory JSON stays within 16,384 characters by
dropping excess summaries with an explicit truncation flag, not by cutting JSON.
Missing/corrupt repositories fail visibly. Production Desktop now composes the
canonical invoking-session resolver, first-publication registry/manifest hook,
readonly main reader, SDK inventory and transactional ownership relocation.
The synthetic Electron restart fixture proves typed persistence and isolation,
not real-device measurements.

The event journal records lifecycle and trace history but is not the context
store. Disabling diagnostics or pruning 30-day journal data does not erase
session context. Enforce bounded entry/pass/session quotas; full-store failure
is visible. Pruning requires exact reviewed scope and must not delete source
audio or musical Live objects.

## Device/app integration and lifecycle

Build on MIDI-Capture's shared producer transport. Authenticate registration,
negotiate listener capabilities, and handle prepare/arm/readiness, bounded
results, completion, cancellation, epochs, sequencing, and reconnect on the
same ingress. Preserve MIDI IDs, schema, subscriptions, JSONL independence,
and existing overflow semantics.

Audio gaps/overflow cannot be treated as complete capture. Native sampling and
measurement work stays separate from Node message transport. Device audio
pass-through must keep working with the app absent.
Completed playback observations must cover positive sample and beat intervals;
a complete flag on an empty interval is not publication evidence.

Lifecycle records cover queued, started, progress, completed, failed, cancelled,
interrupted, persistence, invalidation, and recovery with timing and
trace/correlation/causation IDs. Sanitize/bound descriptors, metadata, settings,
paths, errors, and results before persistence. Raw audio is never an ingress or
journal payload. Typed Desktop context/history views remain local-only.

Runtime composition accepts an optional listening-host factory supplied with
the same Ableton bridge, authenticated Signal runtime, event publisher and
recorder used by other tools. It does not construct an independent transport.
Static and factory-produced playback hosts must both provide a terminal-pass
wait boundary; host shutdown runs before normal runtime teardown.
Production Desktop now composes `createListeningRuntimeHost` alongside the
canonical context manager when profile storage is configured. Invoking-owner
and repository callbacks preserve exact session attribution. The fixed
application-owned gate refuses legacy/unscoped capture before reservation,
controls, playback, or publication; producer `READY` and synthetic adapter
evidence do not unlock it. Only the exact native scope may attempt fresh
per-pass validation as described below; scope metadata never establishes
timing, source onset or publication authority.

## Production readiness

The guarded Arrangement start backend and production runtime assembly are
separate implementation gates. No transport generation tokens are minted, and
`listening.stop_playback` remains unavailable. An Arrangement start may report
`sourceOnset: "unverified"`; neither its bridge acknowledgement nor its requested
beat establishes measured audio onset. Do not substitute an
inspect-then-`setPlaying` sequence for atomic mutation-boundary guards. Session
quantized source onset remains unproved. Native commissioning and independent
capture timing evidence are required before enabling successful production
playback/capture/publication, even when guarded start is available.

Guarded Arrangement start skips the position setter when Live is already at
the exact requested beat, avoiding an unnecessary retrigger after native arm.
It still rechecks all transport/listener guards and the observed position.
Only an attempted real seek may waive the second revision check; a skipped
seek must retain it. Failures before any mutation attempt report `mutated:
false`. An attempted seek or continue remains indeterminate on failure and
never restores position or stops playback. This does not prove the physical
effect of a redundant setter or upgrade the unverified onset acknowledgement.

Live 11 may omit Track `back_to_arranger`. Inspection and source guards share
one conservative proof: a playing Session slot or explicit track override wins;
otherwise an explicit clear track flag or Arrangement-playing sentinel `-2`
establishes no override. With an unavailable track flag and idle sentinel `-1`,
only independently known `Song.back_to_arranger == False` and
`fired_slot_index == -1` establish no override. Unknown global/fired state
cannot authorize that fallback. Start still requires every regular track idle;
independent post-start verification additionally permits Arrangement sentinel
`-2`, while retaining clear global override, no pending launches, recording and
all other guards. Canonical `Song.overdub` must be a known false boolean; an
absent optional `arrangement_overdub` alias is not required, but an unreadable,
unknown or true alias still denies execution.

The separate `Audio-Listener-Commissioning.maxpat` harness feeds independent PCM
through the exact production native analysis resources without the production
client, credentials, context repository or preparation API. Its bounded
`native-commissioning/v1` reports always retain calibration-only, unverified,
not-production-ready status. Portable resource and synthetic report checks do
not establish actual Max compilation, DSP correctness, host vector phase,
transparent pass-through or Live onset alignment.

Do not advertise installed-device capability solely because a development MCP
connection exists. Promotion and installation are explicit, separate workflows;
the shipped device must not contain `mcp_bridge`.

The authored-device staging command preserves a saved Audio Effect's AMXD
container, layout, presentation, unrelated objects and direct stereo cords:
`node scripts/audio-listener-device.mjs build-authored --source <device.amxd>
--out <empty-staging-directory>`. It relinks the four owned listener entry
objects to adjacent resources, removes development search-path helpers and
stale dependency metadata, and rejects remaining absolute development paths.
The source file is never written. The destination must be empty; a failed or
cancelled stage can retain already published resources for inspection, but must
not be installed or opened as a completed bundle. Device and manifest writes
are exclusive, resources are published atomically per file, and cancellation is
checked before terminal success.

Authored packages use manifest format 2; existing canonical format-1 artifacts
remain readable. `--keep-authoring-bridge` explicitly retains the external MCP
dependency for continued development: the manifest then declares
`externalAuthoringBridge: true`, `portable: false`, and
`listenerResourcesPortable: true`. Omitting it strips MCP for a self-contained
candidate, not a production readiness claim. Packaging emits
`m4l.audio-listener.package` queued/started/completed/failed/cancelled events,
with resource progress supplied by `m4l.resources.publish`, elapsed timing,
bounded failure codes and propagated trace/correlation/causation IDs; events
contain neither source paths nor device contents. Staging does not install,
reopen, configure the App profile, or establish native timing acceptance.

The authorized `Machine-Listening` development copy has now been published into
a dedicated folder under the User Library's Max Audio Effect presets and loaded
on DRUMS, with its panel preserved and the original AMXD retained. A temporary
read-only metadata probe confirmed that the loaded analysis and spectrum
patchers and both Gen patchers resolve from that adjacent folder. Native
`node.script` reveal and Finder Get Info confirmed the same location for the
Node entry. The probes were removed; the packaged device has no temporary
search-path helpers. These checks establish resource provenance for this load,
not independent timing or capture readiness. The normal Max editor save/reopen
round-trip now preserves the panel, relative listener references and stereo
wiring. Max adds local dependency-cache metadata and changes the AMXD digest;
the working development manifest was updated only after inspection, and the
saved device was rebuilt through authored staging to remove that metadata from
the checkpoint asset. Repackaging remains necessary after further authoring.

The working device now has path-only discovery configuration for the explicitly
selected `development` profile, generated through the shared storage resolver.
No secret was copied into the device or repository. The App ingress descriptor
was initially absent. After manual development-App startup, the App advertised
`audio-listener/v1`, and its typed Outputs view showed one connected
Audio-Listener on DRUMS associated with Machine-Listening. This output remained
connected after the editor-preview adapter was stopped and the Max editor was
closed. Opening the editor also produced duplicate-listener connection
rejections. An earlier candidate used the documented third outlet of
[`live.thisdevice`](https://docs.cycling74.com/reference/live.thisdevice) rather
than guessing editor state from identity, DSP activity, names or connection
errors. The native third-outlet preview emission is also retained in the cold
inlet of `int -1`, so an emission before Node readiness is not lost. After
`adapter-started`, a native `trigger b b b` queries enabled state with `getstate`,
reads the retained preview flag, then requests identity. `getstate` is **not**
relied on to query preview: the isolated Live 11.3.43 device emitted enabled
state `1` on outlet 1 but nothing on outlet 2 when queried. Native
zero/one gate semantics were not validated: fresh loading retained a flag
that blocked a hosted device with its editor closed. That policy is superseded.

Registration now depends on actual identity, valid DSP/host metadata and
explicit profile discovery through the existing shared authenticated client,
not on a preview flag. The authored `device-preview` selector and native
metadata routing remain compatible without replacing the layout. Numeric
zero/one reports have no control effect; malformed reports produce one bounded
`invalid_device_preview_state_ignored` diagnostic per invalid run, without
logging their raw value, disarming analysis or closing registration. No preview
value grants capture readiness or disables authentication.

Actual identity, DSP configuration and producer instance/connection-epoch
changes still reset local analysis, terminate affected passes with existing
attribution, close stale registrations and fence late callbacks. Stop remains
terminal. Existing authenticated ingress/disconnect and capture-terminal
events retain their application-owned lifecycle. The single-active-listener
ingress guard is unchanged; editor duplicates are still denied by ingress,
not guessed from this native flag. Keep the editor closed for the first
prototype; automatic editor-preview isolation is explicitly deferred.

Native metadata helpers remain for authored compatibility, including
idempotent migration of complete earlier routing and rejection of partial or
conflicting routing. They are not an authoritative context classifier.
Runtime and staged-artifact regressions cover missing/zero/one/malformed flags,
bounded diagnostics, identity/epoch replacement, stale callbacks, partial-pass
attribution, cancellation and production denial. The User Library installation
has **not** been replaced. Registration
establishes transport connectivity only, not capture readiness or calibrated
timing; `real_live_timing_validation_required` remains unchanged.

The isolated staged device was confirmed on `14-Audio`, with native
`dsp 1 48000 64`, stopped transport, valid host metadata and canonical identity
`live_set tracks 13 devices 0`. The isolated App was restarted after its prior
process exited; it connected to Live but discovered no output from the earlier
candidate. Startup console evidence showed preview messages arriving before
Node readiness. Temporary metadata probes were removed without saving the
loaded patch or changing audio routing. The subsequent latch candidate still
reported `editor_preview_blocked` with the editor closed, motivating the
approved simpler registration policy.

After code checkpoint `a0cb4e8`, the actual hosted listener registered with the
fresh isolated App on `14-Audio`. The checked runtime, path-only profile
configuration and manifest were published into the already loaded engineering
bundle with its polling paused and Node adapter stopped. Original
companions were backed up. The AMXD and Node entry were byte-identical to the
staged candidate and were not replaced; stereo wiring, presentation and the
User Library installation were unchanged. An unsuccessful UI loading attempt
also left an empty temporary `15-Audio` track, which remains explicitly
accounted for rather than silently deleted.

The App Outputs view showed exactly one connected Audio-Listener. A completed
agent turn used only `ableton_listening:inspect-listeners`; its expanded
observed tool result returned one non-truncated listener with exact App track
and device references. Independent native inspection resolved
`Machine-Listening-Development` on `14-Audio`, canonical path
`live_set tracks 13 devices 0`, LOM device ID `2142`. Pausing the 10 ms poll
before stopping the adapter removed the output. Restarting it and restoring
polling returned exactly one output. A second single-inspection turn returned
the same listener/track/device references and a fresh producer instance ID.
Both observed results retained `ready: false`,
`real_live_timing_validation_required` and `source_onset_unverified`.
`inspect-listeners` does not expose sample rate or connection epoch; those
fields were not inferred from assistant prose.

This passes the narrow hosted connection/reconnect milestone, not native
timing or audio acceptance. Transport remained stopped, no listening pass or
stored observation was created, and the Max editor remained closed. The next
measurement step required a clean runner-owned known-source Set without armed
external-hardware tracks. The unsaved template was not played or discarded
during those connection checks. Approval to replace it was subsequently
granted: the user saved the original Set and approved a clean calibration Set.
The later known-PCM check below records that continuation.
These connection checks are not timing certification.

`max-patches/audio-listener/Machine-Listening-Development.amxd` checkpoints the
authored layout and presentation with relative listener references and the
external authoring bridge retained. Reconstruct a staging bundle with
`build-authored --source <checkpointed-amxd> --out <empty-directory>
--keep-authoring-bridge`; never treat this development asset as a production
release or readiness certificate.

Require deterministic protocol/repository/coordinator/device tests, reviewed
runner-owned Live scenarios with exact postconditions, and isolated desktop UX
validation. Timing accuracy, transparent pass-through, numerical descriptor
tolerances, bounded resources, cancellation/cleanup, and session resumption must
be demonstrated. A connected user-owned Live process is not an isolated runner.

## Known-source acceptance tests

Use independently generated test inputs, not listener-generated expectations.
`@ableton-agent/test-support` provides two-second 48 kHz stereo PCM fixtures:
440 Hz sine bursts at beats 0, 1, 2 and 3 at 120 BPM, half-beat gates and
five-millisecond fades; the same input with opposite stereo phase; and exact
silence. Their peak and whole-pass RMS references are calculated from the
quantized PCM samples independently of the listener. The WAV bytes are test
source assets, never recordings or runtime context payloads.

`verifyKnownListeningObservation` validates the canonical result and checks
pass/listener identity, complete coverage, sample rate, per-channel peak within
0.001 linear, and whole-pass RMS within 0.25 dB of those PCM references.
Centroid must be within two declared FFT bins; a window too short to distinguish
the reference frequency is rejected rather than enlarging the tolerance without
bound. Silence requires null RMS/centroid and no attacks. Quarter-note fixtures
require exactly four attacks, each within the source fade plus descriptor hop
plus one DSP vector in both sample and beat coordinates. Coarse hops that cannot
separate attacks are rejected. Anti-phase fixtures retain the same independent
per-channel level expectations.

The native candidate declares a 2,048-sample rectangular, non-overlapping FFT
window in `algorithm.windowSamples`. Its `algorithm.hopSamples` instead declares
the 100 ms envelope/reporting interval, not the FFT hop. Spectral reports use
the latest complete FFT frame rather than an average across that envelope
interval. Centroid tolerance therefore uses the FFT window; attack tolerance
uses the separate reporting interval. This source-level metadata distinction
does not certify actual Max operation or descriptor offsets.

The Max-facing Node entry installs handlers before emitting `adapter-started`.
Only that acknowledgement requests device identity again, avoiding a race with
`live.thisdevice` firing before Node startup. It is not capture readiness.
Missing or invalid profile discovery emits one diagnostic and disarms once per
distinct failure reason rather than resetting native analysis on every poll.
Both Gen analyzers compile without the shared compiled-code cache; development
reload is an explicit native command, not a timing certificate.

Spectral Gen code uses `binEnergy`, not Gen's built-in Euler constant `e`.
Completed centroid/energy values are sampled inside `pfft~` and returned as
messages to outer native `sig~` holds. They never traverse `fftout~` synthesis
windowing/overlap-add, which can scale a descriptor or produce zero between
frames. Reset clears these holds. The 10 ms scheduler polls spectral values
before the seven-value frame collector; the envelope interval remains 100 ms.
Control-to-signal conversion and FFT/report offsets still require independent
timing calibration.

Direct development checks in the authorized `Machine-Listening` device on
Live 11.3.43 measured a continuous, inaudible 440 Hz native test source:
stereo peak 0.5, RMS 0.353553, and centroid 452.028311 Hz. Opposite-polarity
stereo retained those levels and a 442.163645 Hz centroid; both frequencies
are within the declared two-bin tolerance. Reset/mute returned seven zeros.
The temporary source fed only the analyzer, never `plugout~`, and was removed.
These limited native measurements are not independent PCM acceptance,
transparent-pass-through measurement, attack timing, host alignment, or an
App capture/publication result. Production remains blocked.

The subsequent clean, runner-owned Set now has an actual generated stereo PCM
clip feeding the hosted device through Live's audio track, not an injected
`cycle~` source. Native `live.object` inspection confirmed the exact generated
`ML-Calibration-quarter-sine.wav` path. Its independently checked bytes are
48 kHz, stereo 16-bit PCM, 96,000 frames, SHA-256
`f04440ac779afee5aa9352244d03312c9b03b65d5e798fad01c68b47a14e7f21`.
The listener is on track index 2; importing the clip automatically renamed
`3-Audio` to `3-ML-Calibration-quarter-sine`. Looping and warping were disabled.

A manual, watchdog-protected analyzer enable and temporary native console
probe measured per-channel peak **0.5** and maximum 100 ms window RMS
**0.353553**. Independent quantized PCM samples 4,800-9,599 give plateau-window
RMS **0.3535529554794787** per channel; the measured peak and window RMS pass
the 0.001-linear and 0.25 dB subset tolerances. Twelve retained full-level,
high-energy spectral frames reported centroids **441.668179-459.932376 Hz**,
within two 2,048-sample FFT bins of 440 Hz. These are selected steady-signal
frames, not a claim that every transient FFT frame has that centroid.

This is **partial native level/spectral evidence**, not a complete listening
pass. The Max bridge retains only 200 console messages: the first unfiltered
collection lost the active region and was inconclusive. A temporary `zl change`
removed duplicate held frames for the repeat; its retained evidence contains
33 nonzero records but still does not establish complete pass coverage or
four verified attacks. Whole-pass RMS, anti-phase PCM, independent timing,
offsets/gaps, transparent pass-through and actual capture/publication remain
unaccepted. No certificate or production prepare/arm path was enabled.

The Master fader was temporarily set to zero for inaudible playback and restored
to its observed 0.85 after the non-looping source finished. Analysis was
disabled/reset, all four temporary probe objects were removed, the object list
and named cables were checked, and both direct stereo pass-through cables were
verified. The inspector populated previously blank nested destination IDs, so
those initial unnamed endpoints are not a byte-for-byte wiring oracle. The
authored AMXD on disk and User Library were not replaced. Transport was left
running; the source clip itself was verified no longer playing.

Engineering evidence is bounded in
`.test-artifacts/listener-calibration-native-quarter-sine-levels.json`.
The earlier clean-Set attempt exposed stale bridge reads/timeouts and was
abandoned, not counted as success. Recovery of the empty test Set was declined
only after explicit user approval. The coordinated UX readiness deadline fix
at `3d78a19` preserves the ordinary deadline and prevents the interactive path
from inheriting its short timeout; see the testing specification.

### Bounded hosted descriptor collection

`hosted_calibration_probe.js` is a temporary engineering probe, not an installed
listener companion or commissioning authority. It taps the existing seven-value
native frame list; it does not synthesize descriptors or change the stereo
audio path. The operator must independently attest the owned Live process and
exact source clip before providing the `runner-owned` acknowledgement and a
UUID trace. Acknowledgement is not process or source attestation.

The probe resets/enables analysis through the existing watchdog guard, observes
a zero counter, then requires one completed, silent 4,800-sample native window
before requesting the source clip's `fire`. A stale zero alone cannot trigger
the source. It retains exactly 100 contiguous envelope windows in bounded
memory, ignores duplicate held counters, fails on malformed data, non-silent
baseline, gaps or resets, and has a 12-second reset/collection deadline.
Completion, failure and cancellation disable/reset analysis. Object deletion
requests the same cleanup and cancels the probe timer, but native cleanup must
explicitly disarm before removal rather than relying on cables during object
destruction. None of these paths stops a clip, rewinds or stops transport.

Queued, started, four progress checkpoints and terminal events retain elapsed
time and trace/correlation/causation identifiers in the descriptor-only report.
Exports contain one bounded header and at most 13 indexed eight-frame chunks,
well below the console's 200-record cap. JSON is hex-encoded as ASCII for the
Max message boundary: directly printing JSON symbols reinterpreted quotes and
commas in the observed native path. Consumers must decode, verify the trace,
require every declared chunk exactly once, and check all sample increments
before using a collected report. Native `js` syntax is checked as ES5 and its
message handlers are tested with eval-scoped loading, rather than assuming
modern Node parsing proves Max compatibility.

The report always declares `calibrationOnly: true`, `nativeTiming: UNVERIFIED`
and `productionReady: false`. It has no filesystem, credentials, network,
context publication or production prepare/arm access. Source identity/hash,
independent sample-rate verification, host/source timing and transparent
pass-through still require separate evidence. Any retained engineering report
belongs under the documented test artifacts, not the App context database.

The actual guarded-start run retained all 100 windows (10 seconds) with an
initial silent window; source fire was requested after 106 ms. Both the normal
and independently generated anti-phase PCM measured stereo peak 0.5. Summing
the squared native 100 ms RMS windows and normalizing by the known 96,000
source frames gives **0.24662070585665122**, versus independent whole-fixture
PCM RMS **0.24665487816027645**: **-0.001203452463732628 dB** error per channel.
The denominator is the two-second source, not the ten-second padded collection.
Each run has four separated positive-envelope groups and trailing silence.
Four selected steady spectral windows per run remain within the two-bin
tolerance: normal **442.4286824110682-459.9323760696037 Hz**, anti-phase
**441.71705667354917-459.77766789894224 Hz**. This demonstrates non-cancelled
spectral analysis of actual opposite-polarity track input, not an internally
inverted synthetic signal.

The anti-phase and silence sources were imported into previously empty Session
slots 1 and 2 through the running Live 11 ClipSlot's inspected
`create_audio_clip` method. Native reads confirmed the exact generated paths;
looping/warping were disabled and end markers set to two seconds. This is
engineering setup, not a new advertised agent import or Session-listening tool.
After the anti-phase run, the silence run retained 100 windows with exactly
zero peak, RMS, centroid signal and spectral energy. Independent track
`playing_slot_index` observation changed from -2 to 2 and back to -2 across
the two-second source. The Clip's `is_playing` property could not be observed
through `live.observer`; track slot state supplied the separate playback proof.
These are scheduler-level observations, not sample-accurate launch markers.

An actual cancellation retained 28 contiguous windows and reported
`cancelled/operator_cancelled` after 2,848 ms rather than presenting a partial
report as collected. Earlier native syntax/framing failures and a zero-frame
collection timeout remain failed engineering attempts; they are not acceptance.
After all runs, analysis was disabled/reset, all six temporary objects and
their cables removed, and the entire inspected native graph matched this run's
complete baseline exactly. All three non-looping source clips were independently
verified no longer playing before the Master fader was restored to 0.85.
Transport was deliberately not stopped. The current calibration Set retains
the three generated clips; no saved authored device or User Library asset
was replaced.

Bounded evidence is in
`.test-artifacts/listener-calibration-hosted-contiguous-quarter-sine-guarded-start.json`,
`.test-artifacts/listener-calibration-hosted-contiguous-anti-phase.json`,
`.test-artifacts/listener-calibration-hosted-contiguous-silence.json` and
`.test-artifacts/listener-calibration-hosted-cancelled.json`. These results
establish the narrow continuous level/energy and silence-reset checks. Four
envelope groups do not certify production attack events. Host/source
sample/beat alignment, FFT/report offsets, attack timing, transparent
pass-through, actual Arrangement capture/publication and resource-cost
acceptance remain open; production readiness is still denied.

### Attack phase correction and host-validity fencing

Algorithm **1.0.1** fixes a phase-dependent double count found in the retained
native windows: the same four-burst PCM source could produce four or eight
estimates depending on how its rising envelope crossed the reporting windows.
After one estimate is emitted, subsequent increasing windows in that same
continuous rise do not emit another. A plateau or fall rearms estimation;
threshold and minimum-spacing controls still apply. A subthreshold or
spacing-suppressed rise does not latch the episode. State resets for each pass.
This remains a coarse envelope-rise estimator, not exact onset detection.

Four regressions failed before the correction. The corrected engine produces
four estimates for both retained normal-source phases and the anti-phase run,
and none for silence when replayed with explicitly synthetic host coordinates.
Independent quantized-PCM tests sweep 76 reporting phases for normal,
anti-phase and silence at thresholds 0 and 6 dB: 456 combinations check counts
and the declared coarse timing bound. Neither replay nor numeric integration
certifies execution/timing of an actual production capture.

The source manifest, staged package metadata and runtime now share algorithm
version 1.0.1. An older 1.0.0 timing certificate cannot authorize this version;
historical 1.0.0 observations remain readable. These code/packaging changes
have not replaced the current hosted engineering bundle or User Library.

Approved-runner timing declarations must require `plugsync~` validity bits
sample count (1), PPQ beats (2) and transport (16), minimum mask **19**.
The official [Max reference](https://docs.cycling74.com/legacy/max8/refpages/plugsync~)
defines those bits; sample validity alone is not transport validity.
Loss of mandatory flags before actual launch fails without enabling analysis.
Loss during capture yields an explicit partial result. A changed DSP vector
invalidates an in-flight timing binding just as a changed sample rate does.
These fences do not supply a missing certificate or calibrate a launch.

Read-only native probes on the owned device observed `host` flags **31** and
`dsp 1 48000 64`, corroborated by a separate Live transport read at 120 BPM.
Two host sample/PPQ pairs advanced coherently at 24,000 samples/beat; this is
counter/beat evidence, not a source-launch or FFT-offset measurement. The
sixth `plugsync~` outlet returned **120** in this host, despite the legacy
reference describing samples/beat there; do not blindly apply that legacy
unit conversion. The listener uses the separately verified PPQ/sample/flag
outlets, not that tempo outlet. Both temporary probes were removed and the
inspected native graph restored exactly, without altering transport.

The remaining launch-adapter gap is concrete: a 10 ms scheduler poll and a
Node receipt cannot prove the requested DSP launch boundary or align an
analyzer reset to it. The current exact-boundary guard must continue rejecting
missed launches; widening tolerance or writing a generic certificate is not a
fix. The engineering signal-marker proof below does not yet supply the adapter,
independent host coordinates or descriptor-offset evidence.

Capture boundaries and declared timing uncertainty must remain within one DSP
vector of independently supplied host coordinates. The verifier must not be
given start coordinates copied from the observation being tested. These numeric
criteria do not establish transport synchronization, calibrated descriptor
offsets, transparent pass-through, or entity attribution on their own.

Source-fixture and synthetic verifier tests do not establish an end-to-end result.
Runner-owned scenarios still must load the real device, verify exact source
content/settings, call the actual playback-and-listen tool, compare observed
coverage/onsets/levels/centroid to independent references, verify subject
attribution and persistence/resume, and assert listener cleanup plus deliberately
continued playback. A tool-built
Operator sequence supplies complementary workflow coverage; its preset defaults
are not an absolute-amplitude oracle.

The reviewed `operator-quarter-note-fixture` scenario in `listening-fixtures`
constructs the Operator/Arrangement source through normal bounded agent tools
by writing a Session source and duplicating its exact identity into Arrangement
(direct Arrangement MIDI creation is not advertised by the observed Live 11
tool surface). It independently verifies device identity plus exact A4 notes in
both clips at beats 0-3,
half-beat durations and velocity 100. It does not play or listen, and leaves only
the generated Session source and Arrangement copy in its runner-owned group Set.
It is a source-fixture
scenario, not real listener acceptance; waveform/settings and measured audio
still need independent verification.

### Controlled native launch/source marker proof

The user approved a narrow engineering proof: stopped transport, Arrangement
beat zero, 120 BPM, 48 kHz and a 64-sample signal vector. This is not a permanent
product restriction or permission to stop/rewind during capture cleanup.
Before fixture setup, native reads verified disabled recording, unarmed tracks,
empty target Arrangement and the known unwarped, non-looping source. Native
`Track.duplicate_clip_to_arrangement` copied that exact Session clip to beats
0-4; the resulting file path, gain and range were independently read back.
Session override was cleared. Master volume was read as 0.85, then muted for
the inaudible experiment.

`host_timing_probe.gendsp`, generated from `host-timing-source.mjs`, is a
temporary passive branch from `plugphasor~` and the actual stereo `plugin~`
input. It never feeds `plugout~`, enables analysis, authorizes readiness,
publishes observations or persists audio. Its original six held outputs are arm epoch,
phase-change clock, last source-onset clock, onset count, rejection and active
state. Clocks are local samples since a valid arm, **not global host samples**.
Positive integer epochs are monotonic within the probe instance. Arming requires
a stable phase for at least 64 samples and silent current input, alongside the
external stopped/beat-zero preflight. Source onsets require 240 prior quiet
samples and are retained while armed as well as active. Arm and active windows
are each bounded to 480,000 samples; rate mismatch, stale/invalid epochs, excess
onsets, moving phase, timeout, phase stall and cancellation fail explicitly.

The actual host invalidated the initial zero-phase assumption: after stopping
and seeking to zero, `plugphasor~` retained values such as 0.304 and 0.538667.
Repeated native snapshots corroborated the first held value. The prototype now
detects phase movement rather than a positive value; a sustained phase stall
marks stopped playback. Two regressions failed before this correction.
Numeric GenExpr tests remain models, not evidence of native compilation.
After editing/recreating the external Gen resource, the earlier native
rejection/stop behavior persisted until an explicit `reload` with `nocache 1`.
Disarm before external edits, explicitly reload and verify changed behavior;
file contents, attributes or a successful object-creation response alone do not
prove the running compiled routine.

Native collection used `mc.pack~ 6` into `mc.snapshot~`. The latter emits
`voice N` on its right outlet before each left-outlet value, **not one list**.
`route voice` selects `gate 6`; the sixth channel triggers the hot inlet of an
integer `pack` after the first five populate cold inlets. Console order is
`[active, epoch, launchClock, lastSourceClock, onsetCount, rejected]`.
`zl.change` bounds output to changed held states. Separate cold-inlet `zl reg`
taps retain existing DSP/host metadata without 100 Hz console flooding.
This engineering readout is not the application-owned trace/journal adapter.

After explicit reload, native epoch 9 acknowledged arming before playback.
It retained four source clocks **431617, 455617, 479617 and 503617**, exactly
24,000 samples apart. The phase-change clock was **431680**: input preceded it
by **63 samples**, within the reviewed one-vector bound, not sample-exact global
alignment. Earlier fresh-phase runs had zero difference; do not hard-code a
63-sample correction. The native active window ended after ten seconds with
four onsets and no rejection. Separate runs produced rejection 3 on actual
transport stop, 4 on explicit cancellation and 1 on arming during playback.
Pre/post native metadata retained flags 31 and `dsp 1 48000 64`; a separate
transport read confirmed 120 BPM and disabled looping. Earlier draft,
pre-reload and timeout attempts are retained as non-acceptance evidence.

The bounded numeric report is
`.test-artifacts/listener-calibration-native-host-markers.json`; it includes
source/probe disk hashes, all retained marker states, narrow acceptance,
failed/cancelled/denied outcomes and cleanup. Both probes were disarmed,
analysis disabled/reset, and all 21 temporary objects removed. The complete
native graph matched its baseline exactly: 130 boxes and 150 cables. All three
Session sources and the Arrangement copy were read as no longer playing before
Master volume was restored to 0.85. Fixture setup deliberately stopped/seeked;
cleanup left transport running. The current calibration Set retains the three
Session sources plus the one Arrangement copy. No authored AMXD, saved original
Set or User Library asset was replaced.

This passes only the bounded native phase/source-marker experiment. The
production runtime and its timing gate are unchanged; the running engineering
bundle was not promoted to algorithm 1.0.1. Native analyzer launch/reset
integration, independent global host coordinates, envelope/FFT/report offsets,
application-owned lifecycle/trace propagation, actual capture/publication/resume,
transparent audio and resource-cost acceptance remain open. The standalone
marker is intentionally absent from production resource packaging.

### Phase-derived local beat-zero origin

The engineering marker now appends two held signals: `launchPhaseSamples`
and `firstSourceClock`. Both reset to -1 on a new valid epoch. At the first
phase change, the former records the rounded beat phase times 24,000; the latter
retains the first actual input onset, including an onset before phase movement.
This conversion is **only** the approved 48 kHz/120 BPM/beat-zero experiment.
It is not a general tempo adapter or an independent global sample clock.
The original six signals retain their order; the temporary eight-channel
integer readout is
`[firstSourceClock, epoch, launchClock, lastSourceClock, onsetCount, rejected, active, launchPhaseSamples]`.

Two actual hosted runs established why the captured phase matters:

| Native run | Phase-change clock | Captured phase in samples | Phase-derived local origin | First input |
| --- | --- | --- | --- | --- |
| Fresh phase, epoch 2 | 513 | 1 | 512 | 513 |
| Held stopped phase, epoch 3 | 576 | 64 | 512 | 513 |

Subtract the captured phase samples from the phase-change clock, not a fixed
63-sample correction. Independently reading the generated PCM bytes finds first
nonzero frames 1, 24001, 48001 and 72001. In both runs, all four native source
clocks match those independent offsets from the phase-derived origin with zero
sample error. The first-input marker is verification evidence, **not an input
to the origin calculation**. Both native windows completed without rejection.
This is local-coordinate evidence for the bounded source, not an actual
analyzer reset or accepted production observation.

The first attempt expired the unchanged ten-second arm deadline across separate
MCP round trips. The successful fixture instead starts the Song only after the
changed native readout acknowledges the exact expected epoch, negative launch
and source markers, zero onsets, zero rejection and inactive state. A temporary
`trigger b l` sends all eight values through `prepend set` into `if` before
banging its condition; a matching packet triggers `call start_playing` on the
independently resolved Song. No arbitrary sleep or wider deadline was used.
This is an engineering fixture control, not the application's capture adapter
or trace/journal lifecycle. An attempted external `bpatcher` harness did not
load through the authoring constructor; it was removed and is not acceptance.

Production resources and readiness remain unchanged. Pre/post metadata retained
48 kHz/vector 64 and flags 31, with separate 120 BPM transport reads. All
temporary instrumentation was disarmed/removed, analysis reset/disabled and
the complete 130-box/150-cable graph restored exactly. All four fixture clips
were read stopped before restoring Master 0.85; transport was left running
and no new Set clip, AMXD replacement or User Library update was made.
Bounded numeric evidence, the timeout and source/probe hashes are retained in
`.test-artifacts/listener-calibration-native-origin.json`.

### Synchronized native envelope pre-roll

The engineering-only `synchronized_envelope_probe.gendsp` composes the same
envelope accumulation/output fragments as the original analyzer with the
phase-derived marker. The generated production envelope remains byte-identical.
Two native 64-sample `Delay` buffers retain stereo input until host phase
movement is observed. A valid new epoch resets envelope state at signal rate;
accumulation uses `clock - origin - 64`, requires exact counter continuity,
and retains all 100 windows, including the final delayed window. Sample labels
remain origin-relative multiples of 4,800, not scheduler delivery times.
Require 64 quiet samples before arm. Reject invalid inferred phase/origin,
insufficient pre-roll history or a discontinuous render index. Rate is checked
inside Gen; vector 64 is independently preflighted/postchecked, not intrinsically
certified by the Gen routine.

The existing bounded engineering collector now has a separate
`start_synchronized runner-owned <trace UUID> <native epoch>` mode. Its
13-channel packet contains the completed counter, exact epoch, phase/source
markers, rejection/active state and stereo peak/RMS. It starts the Song only
after a same-packet native epoch/reset acknowledgement. Use an explicitly
float-typed `pack`: JSON `0.0` became integer zero and would truncate RMS.
Fractional initial atoms establish float typing; they must be overwritten before
the hot counter outlet emits a valid packet. Changed duplicate descriptors,
gaps, invalid packets, foreign epochs and bounded arm/collection timeouts fail
explicitly. Terminal cleanup disarms the native epoch without stopping playback.
Deletion cancels the collector's owned timer. Existing legacy collection remains
covered. Reports retain bounded lifecycle timing and trace/correlation/causation
IDs; this is not proof of application-wide journal/trace propagation.

Actual hosted results on Live **11.3.43**, 48 kHz/vector 64, 120 BPM and stopped
Arrangement beat-zero setup:

| Run | Phase-change clock / phase samples | Origin | Result |
| --- | --- | --- | --- |
| Fresh phase, epoch 1 | 513 / 1 | 512 | 100 windows, four source onsets. |
| Held phase, epoch 2 | 576 / 64 | 512 | All 100 stereo windows exactly equal the fresh run, including the first window. |
| Silent clip edge, epoch 3 | 576 / 64 | 512 | All 100 windows match independent PCM within `1e-12` absolute; maximum observed difference `5.551115123125783e-17`. |
| Operator cancellation, epoch 4 | 576 / 64 | 512 | Cancelled at 2,741 ms, retaining 27 windows exactly equal to the original run's prefix. |
| Arm while playing, epoch 5 | No launch | None | Failed with native rejection 1 after 9 ms, zero frames and no source-start request. |

The original source's first-window RMS is `0.34713641522274874`, versus raw-file
PCM `0.3476300464841661`; the other 99 windows match the independent reference.
Do not call that a full raw-file pass or widen tolerance. To isolate the edge,
the stopped Arrangement clip's unwarped `loop_start` was temporarily set to
0.251 seconds (12,048 source samples), placing its initial edge in silence and
retaining three later bursts. Readback confirmed start marker 0.251, Arrangement
start 0 and end 4 beats. Setting `start_marker` alone had left it at zero in this
host; the readback, not the setter acknowledgement, determined the fixture.
Independent bytes predict first nonzero input at relative sample 11,953; native
clock 12,465 minus origin 512 matches exactly. The exact host processing behind
the original edge discrepancy remains unverified; this experiment does not
claim to disable or characterize Live fades.

Bounded processed native evidence, including cancellation/denial lifecycle and
the original discrepancy, is checked into
`max-patches/audio-listener/fixtures/synchronized-native-envelope.json`.
Consecutive peak/RMS rows plus an exact zero-tail count encode the verified
windows without audio. Replays bind the source and generated Gen hashes and
check the independent PCM, phase offsets, terminal ordering and trace chains.
A 63-sample-tap mutation fails the sample-zero and source-offset regressions;
the latter detects a one-sample error that periodic zero-crossing fixtures
alone can miss. The test-only Gen interpreter remains neither a Max compiler
nor an independent native timing oracle.

The fixture's start marker was restored to zero; all four source clips were
read stopped before restoring Master 0.85. All fourteen temporary objects were
disarmed/removed and the entire original 130-box/150-cable graph restored
exactly. Postchecks retained DSP 48 kHz/vector 64, host flags 31, tempo 120,
loop/record off and running transport. No clip was added/deleted, temporary
AMXD saved, authored resource promoted or User Library updated.

This passes the bounded local-origin envelope experiment only. The two reserved
FFT fields in its seven-field export are zero placeholders, **not collected
spectral data**. Global host anchoring, FFT/report/reset alignment, full native
source coverage, actual App capture/publication/resume, pass-through/resource
cost and portable release remain open. The installed host was independently
read as 11.3.43; this is not a separate 11.3.42 qualification. Production has no
certificate-file loader, remains timing-denied, and does not package this probe.

### Independent host and tagged FFT experiment

The next engineering experiment binds the existing continuous calibration
counter to actual `plugsync~` host samples. Each read brackets duplicate
counter/`plugphasor~` snapshots with before/after host metadata. Retain only
identical brackets, require actual DSP `[1, 48000, 64]`, and require 32 advancing
pairs with one exact host-minus-counter offset. Torn reads are discarded,
never averaged; missing DSP, changed offset/phase/transport, timeout and
cancellation terminate the bounded collection. While stopped, do not invent
a PPQ beat-zero intercept from the held phase.

`clock_anchored_envelope_probe.gendsp` adds an independent continuous-counter
input to the unchanged local-origin envelope experiment. It holds the arm
counter, requires exact subsequent continuity, and exports both the arm counter
and absolute inferred origin. Its engineering counter range is below `2^44`,
reserving 480,000 samples at the upper bound. This is not a general transport
or sample-rate implementation.

The passive compound probe also sends stereo input and split low/high counter
words into an actual full-spectrum, rectangular, non-overlapping 2,048-sample
`pfft~`. `fftin~ 3 nofft` and `fftin~ 4 nofft` imaginary outlets retain the
unwindowed counter words. Splitting at `2^20` preserves exact integer coordinates
even through float32 control buffers. The tagged Gen reuses the canonical
stereo complex-energy math; it publishes centroid, energy and the source
interval together only after all 2,048 clock samples pass exact continuity.
The collector fences duplicate end snapshots, rejects changed holds, gaps,
invalid frames and malformed data, and retains at most 64 frames within five
seconds. Envelope and FFT chunks include their schema as well as trace/index,
and FFT event IDs have a distinct namespace.

Native wide-literal and constant-folded-power bounds failed with guard mask
253, despite contiguous clocks; expressing the same bound using the split
words passed. Keep this measured limitation separate from an explanation of
compiler internals. Model arithmetic alone had not exposed it. Native reload
also produced all-zero snapshots and lost diagnostic cables; the engineering
`reload_native` command now explicitly denies in-place reload. Recreate only
the owned passive parent with fresh, explicitly staged resources, then verify
the graph. Absolute development paths are staging inputs, not portable release
packaging. A continuous signal output and snapshot sink are needed to keep
the passive probe's DSP graph active.

Actual stopped/Arrangement-beat-zero, held-phase results on Live 11.3.43,
48 kHz/vector 64, 120 BPM and the same 12,048-sample silent-edge source offset:

| Independent quantity | Measured result |
| --- | --- |
| Before/after host-minus-counter offset | Exactly `842480212` in both 32-pair bindings; each discarded three torn reads. |
| Native arm / absolute origin | `166446080` / `166446592`; local origin remains 512. |
| Post-launch host beat-zero intercept | `1008926804`, exactly absolute origin plus independent host offset. |
| Native FFT metadata | `[2048, 2048, 2048, 1]`. |
| Envelope | 100 contiguous windows; all stereo peaks/RMS match independent PCM within `1e-12`, maximum difference `5.551115123125783e-17`. |
| Tagged FFT | 64 contiguous windows, 20 nonzero; every centroid matches the independently transformed exact PCM interval within `1e-9` Hz and every energy within `1e-12` relative. Silent frames are exactly zero. |
| Observed numerical differences | Maximum centroid difference `1.7053025658242404e-13` Hz; maximum relative energy difference below `6e-16`. No fitted scale or timing offset. |

The pre-launch reference is silence **before** applying the file offset.
Otherwise negative launch-relative coordinates incorrectly read earlier
non-silent file samples. The FFT's two real stereo transforms retain their
separate complex energies; waveform downmixing is not used.

Processed, source/code-bound evidence and failed native attempts are retained
in `max-patches/audio-listener/fixtures/native-host-spectrum.json`, without
audio or absolute paths. Regression replay verifies exact bracket identities,
independent host origin, window order, source onsets, lifecycle attribution and
timing. Negative cases reject a one-sample origin/tag shift, wrong host binding,
missing stereo energy, a frame gap and omitted pre-launch gating.

This establishes host/envelope/FFT coordinates for this one engineering
fixture, not production readiness. The native envelope report still exports
zero FFT placeholders; the separate tagged report is the spectral evidence.
Full source/host coverage, production wiring and application journal
propagation, actual capture/context publication/resume, transparent audio,
resource cost and portable packaging remain unaccepted. No production
certificate loader or generic JSON readiness bypass is added.

After this experiment the source marker was read back at zero, Master was read
back at its original 0.85, all four fixture clips were read stopped and transport
was read running. All seven owned top-level probes/sinks/metadata objects were
removed without saving them. The entire 130-box/150-cable graph is exactly equal
to the pre-experiment baseline. The calibration Set and existing processes were
preserved; neither the authored AMXD nor User Library was replaced.

### Signal-mode engine integration, not yet activated

The engine now has an explicit internal `launchAlignment: "signal"` path for
the native adapter under construction. The default runtime path, shipping
certificate denial and native device graphs remain unchanged. This is not a
ready listener or a completed real-device integration.

In signal mode, preparation requires Arrangement mode, stopped PPQ zero,
120 BPM/48 kHz/vector 64, zero descriptor offset, at most one vector declared
uncertainty, whole 100 ms windows and a range no longer than ten seconds.
Require the control's trace/correlation/causation IDs. Arming enables/reset
analysis once with a bounded native epoch and enters `native-arming`; it does
not acknowledge readiness until the exact zero-state native packet and an
independently validated 32-row stopped host binding arrive. Reject stale
bindings and changed native arm counters. An early transport/position change,
lost validity or tempo/DSP change cannot silently become a launch.

Host playback notifications alone never launch signal capture or reset its
pre-roll. Native phase/counter markers infer the absolute origin from the held
arm counter and independently derived offset. Require the current host
sample/PPQ intercept to match it, valid active/rejection state and a bounded
launch-notification delay. Each descriptor must have the exact beat derived
from its source sample and a complete latest 2,048-sample FFT interval on one
unchanged grid, never a future/stale frame. Duplicate holds are value-based;
changed held measurements fail explicitly.

Full envelope coverage alone cannot claim completion. Require 32 coherent
post-capture host brackets with the same offset and origin, beyond the
requested range and no later than the freshly observed host. Bound capture/
postcheck waiting separately from arm waiting. Success, partial failure,
cancellation, reset and timeout disable/reset analysis without transport
commands. Native stage events carry bounded lifecycle timing, pass/native/
connection epochs and the control's causal trace chain.

`audio_listener_native_coordinates.js` is an explicit hashed bundle companion,
not a persisted certificate or a filesystem/configuration reader. Internal FFT
intervals are validated before conversion; canonical `audio-observation/v1`
and listener result wire shapes remain unchanged. The deterministic engine
tests replay actual recorded coordinates with **synthetic timely host callbacks**
and approved test certificates. They do not prove native runtime delivery,
application journal forwarding or actual context publication. Node/Max graph
wiring and independent end-to-end acceptance remain required before activation.

### Independent App-side native evidence boundary (inactive)

The next integration step extends the existing `listener.reply` and
`listener.result` messages with bounded optional evidence, not a new registration
service or certificate loader. The opt-in native status scope is
`arrangement-beat0-120bpm-48000hz-vector64/v1`; its presence is not proof of
readiness. Legacy producers retain their existing wire behavior. The shipping
default runtime still reports `UNVERIFIED/BLOCKED` without the opt-in scope
and remains denied. A scoped candidate stays honestly unverified/blocked;
the App allows only its bounded fresh validation attempt, never an upgrade
from metadata to measured timing.

An `armed` reply carries `nativeArm`: the exact epoch/reset acknowledgment,
absolute arm counter and 32 coherent stopped PPQ-zero host/counter brackets.
A `progress` result carries `nativeLaunch`: the same epoch/arm, signal-derived
launch clock/phase and playing host sample/PPQ intercept. A `completed` result
carries `nativeCapture`: the identical accepted arm/launch evidence, 32 playing
post-capture brackets and one complete latest 2,048-sample FFT interval for
each retained envelope point, including its centroid and pooled stereo energy.
These fields are stage-restricted strict schemas.
They contain processed numeric evidence only, never PCM or arbitrary objects.

The App independently derives the origin and host offset, verifies all envelope
sample/beat coordinates and whole-window coverage, rejects future/stale FFT
intervals or a changed FFT grid, recomputes centroid values/energy-weighted
summary, and requires all 32 post brackets after range
coverage with the same clock mapping. The last post bracket must be within
48,000 samples of the range end. Calculate range length in integer 4,800-sample
windows rather than multiplying fractional beats into an inexact sample count.
Canonical `algorithm.windowSamples` remains 2,048 (FFT), while `hopSamples`
is 4,800 and RMS integrates each 4,800-sample envelope window. Only non-null
spectral points contribute to the energy-weighted summary.
Changed proof, missing/duplicate launch, missing arm acknowledgment or scope/
instance/epoch change cannot publish a completed observation. Scope and quota
denials occur before dispatch; failure/cancellation retains exact-owner cleanup.

Native lifecycle uses existing `progress` results with `nativeLifecycle`.
Send the armed wire reply before flushing native progress; contiguous sequence
validation is not relaxed. Arm-only lifecycle progress does not imply measured
playback onset. Native source event IDs are UUIDs and remain unique across
repeated pass IDs. Ingress namespaces journal IDs by connection, instance,
connection epoch, job and pass, preserving native causal edges without allowing
producer IDs to impersonate unrelated application events. Original SDK trace,
correlation and root causation remain attached; result causation mismatches are
rejected before telemetry/result delivery.

The existing application journal retains bounded, recursively sanitized proof
and native queued/started/progress/completed/failed/cancelled lifecycle records
through typed Desktop History. No storage layout, SQL renderer access, audio
retention or upload path is added. Canonical `audio-observation/v1` remains
unchanged and contains no private FFT proof fields. Shared synthetic contract
fixtures are isolated under `@ableton-agent/protocol/testing`, not exposed as a
production readiness API.

This boundary is exercised with explicitly synthetic timely callbacks, including
authenticated loopback transport. It does not establish actual Node/Max packet
delivery, a new native graph, native resource cost or real context publication.
The actual capture controller/assembler and per-pass physical evidence are still
required before activating this scope. The existing Live calibration Set and
Desktop/Max processes must be preserved; the deterministic Live runner must not
adopt them.

### Bounded native descriptor assembly (inactive)

`audio_listener_native_assembler.js` pairs processed envelope packets with
their latest complete tagged stereo FFT window on the original sample grid.
It waits for a delayed matching FFT instead of using an older or future one,
and fails when advancing FFT delivery proves that a required interval was
missed. No fitted timing or scaling is applied. Retain at most eight pending
envelopes, 128 FFT packets and 100 selected spectral intervals. Release pending
buffers after coverage; retain only an immutable-copy completion proof until
terminal cleanup.

Check pass/connection/native epoch ownership before mutation, exact arm/origin
tags, whole 4,800-sample envelope cadence, unchanged held values, coherent
2,048-sample FFT tags/grid and a stable invalid-frame counter. Failure rejects
explicitly and invokes the owning failure callback after clearing buffers.
Cancellation is idempotent, does not terminate a replacement owner, and
reentrant consumer cancellation cannot manufacture completion. The owning
engine supplies traced capture lifecycle; this synchronous bounded assembler
does not introduce a separate service, timer or persistence path.

Source-backed composition now replays 20 nonzero/silent recorded-coordinate
envelope windows through the actual assembler, signal engine, independent App
validator and strict result schema. Timely host callbacks and post brackets
in this test are explicitly synthetic. This composition regresses the
distinction between canonical 2,048-sample FFT metadata and the 4,800-sample
envelope cadence, including below-floor spectral weighting. It is still not
proof of real Node/Max delivery. The companion is hashed in both bundle resource
lists and excluded from calibration-only staging; the shipping runtime does
not instantiate it and remains timing-denied.

### Independent actual-input RMS measurement

The remaining first-window question was checked against actual plugin input,
not an adjusted WAV oracle. Each channel branches through integer
`delay~ 64 64`, `average~ 4800 rms` with an explicit 4,800-sample interval, and
`sah~ 0` triggered by the native completed-window step through `delta~`.
This is the existing fixed 64-sample signal history, not a fitted shift.
Signal-controlled delay was not used because it adds interpolation latency.

Actual trace `b0a55fb6-dffa-4b57-ae0c-bc9411e38138` collected all 100 paired
windows at source offset zero, 120 BPM/48 kHz/vector 64. Every stereo squared-RMS
error was below the predeclared `1e-12` criterion; maximum observed error was
`8.326672684688674e-17`. First-window native and independent MSP RMS were
exactly `0.34713641522274874`, while the verified source WAV gives
`0.3476300464841661`. The native RMS calculation therefore agrees with the
actual plugin input. The exact upstream Live rendering difference is still
unproven; do not claim a particular fade, fit a gain or shift the source.
The clip's normalized gain `0.4` was read back as `0.00 dB`, not linear 0.4.

Before/after each retained 32 coherent brackets with identical host offset
`1407845460`, discarding three/two torn reads. Arm `20619776` plus local origin
512 gives absolute origin `20620288`; adding the offset exactly equals the
independent PPQ-zero intercept `1428465748`. First source onset is at relative
sample 1 and the fourth at 72,001. These manual engineering bindings are not
timely Node/Max delivery or production capture acceptance.

The reference-only parent starts its polling only after an owned request and
stops it on completion, failure, cancellation or deletion. A native attempt
exposed nested message handlers invisible to Max; a Max-like VM regression now
requires global handlers. The failed parent was removed and recreated from
fresh resources, not reloaded in place. Default calibration graphs and all
production Gen bytes remain unchanged.

Bounded processed evidence is retained in
`max-patches/audio-listener/fixtures/native-rms-reference.json`; rows append two
reference scalars to the original seven processed fields. No raw audio was
recorded/exported. All six temporary roots/sinks/metadata objects were removed,
and the full 130-box/150-cable graph matched the pre-experiment baseline exactly.
Source markers stayed zero, Arrangement clip 14 read stopped, Master read 0.85
without modification and Song read running. Existing Set/Live/Desktop/Max
processes and User Library device were preserved.

### Asynchronous native onset receipt

A scoped capture exposes an internal `nativeLaunch` promise. It resolves only
after every selected scoped listener's launch proof passes the independent
App validator and all arm replies have been admitted. Arm/progress telemetry,
legacy progress, a first listener's proof, and the bridge's scheduler start
acknowledgement cannot resolve it. Buffered proof arriving after the wire arm
reply but before its promise continuation is handled identically.

The runtime retains that receipt with its exact pass. An honestly `unverified`
bridge acknowledgement may proceed only for an entirely scoped native cohort
and only after the receipt resolves. Mixed/legacy cohorts cannot acquire this
authority from a promise or producer READY metadata. Scoped listeners also
require the receipt when a test adapter claims a measured start. Exact start
beat checking remains mandatory.

The existing bounded capture deadline, cancellation, disconnect/epoch and
invalid-proof paths reject an unresolved receipt. Waiting is abortable; failed
or cancelled onset releases only the playback monitor, with a separate bounded
cleanup deadline, and never stops transport. Late receipts cannot publish or
release a second time. Failed cleanup is explicit rather than a successful
capture. Capture `native-onset` actions and runtime `native-onset` stages retain
queued/started/progress/terminal timing, redacted errors and caller trace IDs
through the existing journal, with no new persisted store or upload surface.

The default shipping device remains blocked and unscoped. Real Node/Max
launch delivery has since passed the recorded native-controller milestone
below; authenticated capture publication and isolated Live/Desktop acceptance
remain required before a shipping-device promotion.

### Signal-mode measured preflight

The internal signal engine no longer accepts an injected test certificate as
preparation authority. Each pass requires 32 coherent stopped native brackets
at beat zero with a stable held phase, actual `[1, 48000, 64]` DSP metadata,
native FFT information `[2048, 2048, 2048, 1]`, and a complete six-scalar tagged
FFT baseline. No supplied `validated` flag, certificate file, source path or
raw audio field is accepted.

The bracket span and lag behind the latest independently supplied host sample
must each fit 48,000 samples; the FFT must end no later than the final bracket
and less than 2,048 samples before it. Tags, finite stereo energy, silent
centroid convention, safe counters and invalid-frame baseline are checked.
Sparse arrays fail, including a missing held-phase value in a stopped row.
The observed FFT grid is translated into host coordinates and binds the first
descriptor as well as subsequent descriptors.

The engine defensively retains only bounded native evidence. Arm and reset
acknowledgement must occur within 1,000 ms of preparation; the arm counter is
at most 48,000 samples beyond the final preflight bracket. A reset ACK cannot
swap in another binding. The actual controller must therefore gather this
fresh evidence immediately before native arm, not collect it during an early
wire prepare and let it expire while other listeners prepare.

Recorded-coordinate composition now uses explicitly synthetic timely preflight
measurements rather than certificate injection. This does not attest executed
native code or constitute real delivery acceptance. The default host-mode
shipping denial and blocked registration remain. The scoped App admission
below does not replace the native controller/graph's actual measurements.

### Narrow per-pass native admission

The production App composition accepts only an entirely native cohort with
scope `arrangement-beat0-120bpm-48000hz-vector64/v1` for a fresh validation
attempt. Independent inspection must show stopped beat zero, 120 BPM, safe
recording/source state and registered sample rate 48000. The range starts at
zero, ends at most at beat 20 and lies on the 0.2-beat envelope grid.
Unsupported rates, positions, tempo, ranges and mixed cohorts deny before
reservation or controls. Vector 64, executed ABI, current metadata and timing
are subsequently established by fresh native preflight/arm proof, not
registration.

Registration remains `UNVERIFIED/BLOCKED`; discovery still reports `ready: false`
with `native_per_pass_validation_required`. This identifies eligibility to
attempt preflight, not readiness or a certificate. All scoped listeners must
return a valid matching `nativeArm` before guarded playback; native measured
launch and complete coverage/FFT/postcheck proof remain mandatory before
atomic publication. Legacy and unscoped producer `READY/VERIFIED` claims
remain denied. No file, flag or injected certified adapter unlocks the
production path.

The existing authenticated ingress applies the same exact-scope eligibility
rule to `prepare`; otherwise it would reject honest blocked metadata before
the controller could gather proof. It preserves the unchanged registration,
normal ownership/sequence/phase guards, and legacy blocked denial. The real
authenticated socket regression carries bounded synthetic arm/launch/complete
geometry and namespaced causal events while registration stays blocked.
This proves transport behavior, not fresh native hardware or tool acceptance.

Deterministic production-composition tests use explicitly synthetic native
geometry to exercise admission, missing-arm denial, unsupported scope,
discovery, cleanup and invalid completion. They do not establish authenticated
delivery or real tool/publication acceptance. The native runtime constructor
and generated graph remain opt-in candidates; the default authored device is
not promoted by this App-side integration.

### Inactive native controller

The existing authenticated runtime accepts `createRuntime({ nativeMode: true })`;
default wrappers omit it. It reuses the same SDK client,
identity and epoch fencing. Max inputs are `native <generation> <type>
<numbers...>`; outputs are `native_control <begin|arm|stop> <generation>
[epoch]` plus bounded `native_diagnostic` metadata. Source transport remains
App-owned. Actual arm proof is sent synchronously in the armed reply before
buffered capture events, never as a duplicate promise-resolution reply.
Attack threshold/spacing are frozen at prepare and truthfully reported;
they do not alter native acquisition/timing constants.

Native lifecycle metadata optionally identifies phase `preflight`, `reset` or
`capture` and the UUID generation. Omitted phase retains legacy capture naming.
Ingress records preflight/reset-specific History event names while retaining
one UUID namespace across phases, so causal parents do not disappear at a
phase boundary. These bounded diagnostics remain non-authoritative; only
actual arm/launch/capture proof validates measurements.

The runtime buffers at most 200 actual preflight/reset lifecycle records, then
publishes them through the existing result channel only after the synchronous
armed reply and before capture events. Reset queued/started follows the actual
arm command; completion requires its genuine acknowledgement. Failed pre-arm
attempts retain local diagnostics and failed/cancelled control outcomes, never
illegal pre-armed results. Overflow fails explicitly and cancellation releases
the buffer. The native-only watchdog context outlet must succeed before begin;
default mode emits neither native controls nor watchdog context.

The combined checkpoint passes 320 Max tests, including 25 SDK-runtime
regressions, and 301 broader protocol/ingress/capture/runtime-host tests.
The full workspace builds. These checks establish implementation boundaries,
not fresh authenticated native capture or context/resume acceptance.

### First authenticated candidate load and real capture attempt

After the operator saved `Machine-Listening-Calibration.als`, a fresh owned
Live 11.3.43 process loaded that Set and the freshly installed Remote Script.
The operator approved staging and loading the native candidate as one additional
effect, preserving the original device and the saved Set. Actual browser/load
and device-inspection results establish track index 2, candidate device index 1
and an unchanged original at index 0. A typed, journaled `inspect-listeners`
result independently returns both physical devices: the original remains
unscoped/blocked; the candidate reports `native_per_pass_validation_required`
and `ready:false`. This proves actual candidate load and authenticated discovery,
not native arm, capture or publication.

The first real `play-arrangement-and-listen` request selected only the candidate
and beats 0-4. Pass `9bcbfc07-9289-4ff0-89fa-f60c57e412f8` failed in validation
after 396 ms with no context IDs: the runtime passed the entire structurally
compatible capture request as the bridge's strict `range`, leaking `mode`,
`listenerIds` and `maximumDurationMs`. The strict protocol correctly rejected it.
The adapter now projects only `startBeat`/`endBeat` at that boundary; it does not
weaken the protocol or any recording/readiness guard. The focused regression
reproduces the exact real error before the fix; all host fixture inspections
and native source-start calls now parse their actual strict protocol schemas.
The complete 52-test host suite passes. The operator restarted Desktop with the
corrected runtime; no audio acceptance follows from this fix alone.

Two further candidate-only attempts published no context. Pass
`09cb72d7-ab14-4e64-ac3c-6b37c871f506` failed after 1416 ms with
`transport_not_safe_to_start`; actual Automation Arm was enabled. After explicit
calibration setup cleared that flag and returned the stopped transport to beat
zero, pass `bb436511-62b2-448c-b3f4-fa6a9b7f6bb1` failed after 1657 ms with
`arrangement_source_unknown`. Actual typed reads establish the target track's
override property unavailable and the global flag false. This error denotes
unknown override evidence, not proof that Arrangement clips are absent.

Regressions reproduce the missing-track-field and Arrangement-sentinel failures
before the Live 11 guard fix. Canonical overdub without the optional alias is
also covered, but absence of that Python alias has not been measured in the
actual host. The full 200-test Python suite and 137 protocol/simulator bridge
tests pass, followed by 679 broader owning TypeScript tests. Simulator source
start now omits the synthetic optional overdub
alias and reports actual Arrangement-playing slot semantics. Fresh Python
requires a new owned Live process. Native arm, capture and context publication
remain unaccepted until a new actual pass establishes them.

The operator subsequently saved a separate
`Machine-Listening-Native-SDK-Calibration.als` with both effects, preserving the
original one-effect Set. Installed guard source hashes match the checkpoint;
a fresh runner-owned `capability-surface` baseline passes on Live 11.3.43.
That baseline does not qualify native capture or the exact supported 11.3.42.
The reopened copy again establishes two authenticated listener instances,
stopped beat zero, tempo 120 and clear global override.

Fourth pass `1377d418-3ba6-4e39-82f0-66a28e1e71fb` fails after 3814 ms with
`unsupported_native_capture_scope` and no context IDs. Correlated typed History
establishes completed inspection and reservation, followed by a failed actual
device `prepare`; native arm and source start were not reached. The App was
using its generic 512-window budget, exceeding the real native controller's
100-window ceiling. The fixed native cohort now receives exactly five
canonical windows per requested beat (20 for beats 0-4), while non-native
preparation retains its existing 512-window budget. App capture admission also
rejects native budgets over 100 before dispatch or subscription; it does not
widen the device's scope. Regressions reproduce the dispatch and 101/512
admission failures before the fix and preserve the valid 100-window ceiling.
All 122 owning capture/host tests, 683 broader TypeScript tests, 320 Max tests
and 200 Python tests pass; the workspace builds and runtime type-checks.
Fresh actual preparation must still qualify DSP metadata and subsequent
native proof; the budget correction
alone is not audio acceptance.

### First actual native SDK capture and context publication

After the corrected App reload, candidate-only pass
`596663d0-0a70-4285-8d95-894df152524e` completes on the preserved calibration
copy. Actual ingress reports ready, genuine armed/reset proof and measured
launch, then complete observation plus before/after host proof. Independent
App parsing/assertion accepts all 32 stopped brackets, 32 playing postchecks,
20 FFT records and 20 canonical envelope windows. The exact observed span is
samples 129561486-129657486 at 48 kHz, beats 0-4: 96,000 frames per channel,
two seconds of audio. The whole guarded workflow takes 8199 ms, including
inspection, reservation, preparation, source start and publication.

Atomic publication returns context `335ff745-4c1c-4d61-b7b6-57a84aec4881`;
actual typed `ableton_context get` returns the same canonical observation as
the authenticated wire result. Its primary association is the correct
`3-ML-Calibration-quarter-sine` Arrangement range, with unknown attribution
and freshness. This is not an isolated descriptor of a clip or a current
mutation-authority reference. Peak is 0.5 on both channels, aggregate RMS
-12.159430090285273 dBFS and centroid 453.29712384376825 Hz; four estimated
attacks occur at window ends 0.2, 1.2, 2.2 and 3.2 beats, not exact onsets.

All descriptors match the prior actual controller capture after translating
only absolute host coordinates. Four independently generated settled PCM
windows match measured RMS within `1e-12`; no gain or time fitting is used.
Bare source PCM is not asserted as a whole-stream oracle across Live edge
processing. Candidate controller/engine/assembler/coordinate/IO and Gen hashes
match the earlier measured sources; actual SDK wrapper/runtime/watchdog
hashes also match their checked source. The controller remains pinned.

The retained
`max-patches/audio-listener/fixtures/native-sdk-capture.json`
contains bounded actual proof, exact typed result, 74 selected lifecycle
records, identity/source hashes and no raw audio or credentials.
Regressions preserve armed-before-diagnostics ordering, shared cross-phase
causation, complete-capture-before-publication, context/wire identity,
independent numeric checks, unchanged readiness/unknown attribution and
leave-running cleanup. Corrupted native coverage or foreign stored context
cannot pass. Only one `listening.start_playback` command occurs; no ordinary
transport stop, Session launch or device load is part of the pass.
All six new evidence regressions and the complete 326-test Max suite pass.

Desktop process 52905 was then closed and a distinct process 62352 started
with the same isolated profile. After the new automation endpoint publication,
an actual typed get returns the unchanged original context, pass, subject,
creation time and complete canonical measurement. Three read-only calls
retrieve that entry, inspect listeners and inspect transport: no capture or
mutation occurs. Both devices still report `ready:false`; the native candidate
retains per-pass limitations. Transport is independently observed still playing
past the historical range. The retained fixture records actual restart/get
timestamps, process identity, status and exact read-only arguments; a seventh
regression protects this durable resume result. All seven evidence regressions
and the complete 327-test Max suite pass.

The next controlled probe requested cancellation during a 0-20 beat capture.
It genuinely armed native epoch 2, but source start failed the existing
insert-marker guard before capture. Pass
`c990a4c2-3126-4d92-9702-afdbc7316ff1` failed in 6277 ms with no context IDs.
Its exact native generation was cancelled with zero frames, followed by an
authenticated cancellation acknowledgement. There was no native launch,
complete capture or publication. This proves **post-arm source-denial cleanup**,
not cancellation during active audio capture or a successful 100-window pass.
Stopped `currentSongTime: 0` alone did not establish the required
`Song.start_time` insert marker; do not weaken that guard or treat public seek
as proof of the marker.

Three subsequent read-only calls independently found no context for the
failed pass (including historical entries), retrieved the unchanged original
context and observed transport stopped at beat 0/120 BPM. The bounded
`fixtures/native-sdk-source-denial.json` records the actual arm, 17 selected
lifecycle records and exact context-result digest. Its three regressions
protect denial-before-generation-cleanup, zero publication and unchanged prior
context. Active-capture cancellation remains unqualified. The two owned
Desktop/Live processes were then gracefully closed; the pre-existing Max
process was preserved. All 330 owning Max tests pass.

The user approved narrow deterministic runner hooks for explicit
staged-candidate loading and reuse of production listening/context composition.
The reviewed `native-playback-and-listen` scenario now uses the existing
production runtime, listening host, Desktop context manager and session store,
without a Desktop window or alternate capture adapter. It waits for the actual
terminal job even if the model ends its turn during arming, then independently
validates native proof, exact actor/connection ownership, one atomic range/track
context, typed retrieval/reopen, unchanged Set and leave-running idle cleanup.
Deterministic implementation is not completed real-Live acceptance.

The explicit `--native-fixture-input` JSON pins the source Set, candidate
manifest/device and every referenced WAV, plus the exact canonical device
path and track/device names. Staging copies the Set byte-for-byte and changes
only the copied producer discovery configuration through the shared storage
resolver. External Max devices, unpinned dependencies, symlinks, hash mismatch
and promoted candidates fail before launch. Source files remain unchanged.
The former two-listener calibration Set required a separate saved candidate-only
fixture; the old listener cannot silently execute as an unprovisioned dependency.
With explicit user approval, `Machine-Listening-Native-Runner-Calibration.als`
was copied and only its older listener removed through Live, then saved.
The original one-listener and two-listener Sets retain their prior hashes.
All three generated WAV dependencies are explicitly pinned. The staged fixture
includes the standard empty `Ableton Project Info` directory for its
project-relative references.

```bash
pnpm build
pnpm live:agent-smoke --scenario native-playback-and-listen \
  --native-fixture-input .test-artifacts/native-fixture-input.json \
  --skip-build --skip-install
```

The native group requires that explicit fixture and `--skip-install`, including
when selected as part of the complete suite. Its exact-PID startup hook does
not accept `--computer-use`; existing non-native groups retain their normal
startup modes. No device installation, process adoption, unsupported Set XML
editing or fake/skipped acceptance is permitted. Application shutdown, owned
Live shutdown and deletion of staged resources are separate from capture
cleanup; resources are retained beneath a surviving process.

The first fresh automated attempt staged the approved candidate-only Set and
all pinned dependencies but timed out before listener discovery, with no actor
calls or capture jobs. The harness had instantiated the signal runtime without
starting its ingress endpoint. It now explicitly starts that production
service before the application and always attempts signal shutdown, including
partial startup or application-stop failure, with separate causal lifecycle
events and deterministic regressions. No native timing or source guard changes
are part of this correction. Real acceptance requires a fresh rerun.

Further actual startup checks established that the native Node process runs
from the copied candidate directory. The remaining discovery blocker was the
missing private credential file, not evidence of an absolute-path fallback.
The runner now reuses Desktop's `publishSignalSecrets` with canonical profile
paths before ingress startup and removes only its own credential during
shutdown. It starts the production agent service before managed-session
creation and adapts the actual `ToolApprovalRequest.metadata` contract rather
than a test-only flattened shape. Each omission has a regression reproducing
the failure before correction; startup/stop/publication failures retain cleanup.
Reviewed actor actions are narrowed to inspect, play, get-pass and context get,
with serial requests and explicit pass-ID/context-ID distinction. The original
mutation, identity, range, risk and timing guards are unchanged.

The first automatic actor-driven capture then genuinely armed epoch 1 and
observed native launch, but failed `native_clock_discontinuity` after five
windows (24,000 frames/channel, beats 0-1). No complete proof or context was
published; the typed persisted session has no context-store reference. A
secondary model request incorrectly used the pass ID as a context ID and was
denied, so this is unequivocally a **failed scenario**, not recovered acceptance.
`fixtures/native-runner-clock-failure.json` retains the real arm/launch,
incomplete observation, selected lifecycle and zero-publication evidence.
The rejected raw clock row was not recorded; counter regression, a gap over
48,000 samples and a changed host/counter offset cannot yet be distinguished.
Do not infer a cause, weaken those guards or treat earlier successful manual
passes as qualification of this cold-runner case.

Subsequent exact-owned-Node inspector diagnostics retained numeric inputs
without changing the saved candidate or native DSP. One rejected clock row
has agreeing host brackets but a native counter/phase one 64-sample vector
behind; an FFT row holds the previous first end tag while its start and second
end tags describe the next 2,048-sample frame. The physical scheduler mechanism
is still unproven. These are separate recorded diagnostics, not proof of the
unrecorded row in the first five-window failure.

The opt-in controller now rejects only those precisely identified acquisition
cohorts without admitting their values, refreshing accepted capture clocks or
changing the established offset. The clock case requires capture already
started, a playing predecessor, exactly +64 offset and exactly 64 samples of
independent phase lag. The FFT case requires a known held first end tag and
exactly the next-frame start/end pair with unchanged ABI. Arbitrary mismatches,
missing subsequent FFT frames, regression, long gaps, changed holds and actual
coherent offset changes still fail. Both use the existing shared 64-rejection
budget; cancellation, freshness and complete coverage remain mandatory.
Acquisition progress is forwarded through the existing authenticated native
lifecycle with original event/causation IDs, capture-relative time and measured
frame count; failed writes and reentrant cancellation cannot retain a pass.

Before native arming, no clock binding exists until 32 fresh stopped rows
agree exactly. A changing candidate offset clears that uncommitted cohort,
records `native_preflight_binding_restart` and starts a new exact cohort within
the same two-second deadline and rejection budget. It does not average offsets
or alter an armed binding. Host/counter regression still fails immediately;
after preflight, the established offset cannot be replaced.

A declared private source-override diagnostic genuinely recovered both observed
acquisition cohorts at frames 9 and 18, completed all 20 envelope/FFT windows and
32/32 clock rows, and published one 96,000-frame observation. An independent
typed read in a new process reopened the same context unchanged.
`fixtures/native-acquisition-recovery.json` pins that capture's actual source
hashes separately from the current source snapshot. Exact current byte hashes
subsequently completed an inspector-attached diagnostic without a rejection-site
pause: both cohorts recovered at frames 13/15 and the complete observation
reopened unchanged through typed reads in another process. This is current-byte
diagnostic evidence, not immutable-candidate or standard-scenario acceptance.
Earlier cold trials remain failed, including clock continuity and pre-arm
failure with unconfirmed cancellation; repeatability is not yet qualified.
No saved candidate, installed device or readiness was promoted. Historical DSP,
engine/assembler/coordinate and unchanged SDK/watchdog pins remain exact;
revised acquisition/diagnostic JavaScript has explicit separate provenance and
its own measured pass, not inherited historical byte-level qualification.

The separately rebuilt `Machine-Listening-Native-Hardened-Runner-Calibration.als`
was subsequently saved normally in Live with operator assistance. Its new
absolute/project-relative native references pass the unchanged strict fixture
inspector; the new native Node ran from that rebuilt bundle. All three original
Sets and the original candidate manifest retain their hashes. The first ordinary
immutable-candidate run still failed `native_clock_discontinuity` after genuine
arming, before measured launch, with zero context publication. A distinct
unchanged-source owned-inspector run captured a stopped, armed row whose host
brackets agree but whose host/counter offset changes from 0 to 64: host delta
512, native delta 448, held phase 0. Unlike the earlier playing mismatch, this
row has no independent advancing phase that corroborates an acquisition tear.
It remains denied; the ordinary run's unrecorded row is not presumed identical.

A single explicitly overridden copied-clock experiment changed only its
10 ms poller from low-priority `qmetro` to scheduler `metro`. It exhausted the
unchanged preflight rejection quota before arming and is rejected as a fix;
the actual terminal cancellation uncertainty remains recorded. No source
change or scheduler experiment was promoted into the candidate.
`fixtures/native-hardened-fixture-failure.json` preserves these three failed
attempts, actual arm proofs, typed zero-publication evidence, numeric diagnostic
and separate source provenance. Regression coverage protects continued denial
and exact-generation cleanup, not a claimed recovery. Native clock acquisition
and ordinary repeatability remain unresolved; no further group/suite acceptance
is inferred from the earlier successful diagnostics.

A subsequent explicitly fail-only runtime-instrumented diagnostic retained
the next raw clock after a stopped/armed fault, admitting no intervening data
and forcing the original failure on that row or a 100 ms deadline. It observed
offsets -1, 0, 0 across previous/rejected/following stopped rows, not the earlier
+64 playing-phase cohort. Both native counter copies and host brackets agree
within each row; the held phase remains 0. It failed before measured launch and
published nothing. This shows another unresolved exact-binding case, not its
physical cause or a tolerance decision. The same failure fixture preserves the
runtime instrumentation separately; no production offset guard is loosened.

The operator then explicitly approved prototyping a bounded timing proof while
keeping publication gated. The first development-only implementation,
`native-clock-interval-prototype.mjs`, intersects conditional offset intervals
from structurally coherent stopped observations. Acquisition error is an
explicit **assumption**, not a measured guarantee or certificate. Independent
timing error and offset uncertainty share one total 64-sample budget; they do
not receive 64 samples each. Inconsistent intervals, malformed/torn/moving
rows, regressions, changed holds, stale observations and invalid scope fail.

This analyzer accepts bounded pairs/sets for research, not a runtime binding:
every result is frozen, `authority: none`, `physicallyValidated: false` and
`captureEligible: false`; the current arm-proof schema rejects it. It is absent
from shipping and candidate resource lists and does not alter ingress, tools,
SDK capture, stored observations or the existing exact-clock verifier.
Recorded fault pairs exercise the arithmetic. Combining their much older
preflight rows with those faults is correctly rejected as stale rather than
pretending to have a fresh 32-row cohort.

Before any proposed replacement can authorize capture, independently establish
the physical acquisition-error bounds, define the composed host/onset/FFT timing
budget, review a versioned wire/proof contract, and validate complete actual
captures plus failure/cancellation and trace coverage. Historical v1 failures
remain failures, with no retroactive conversion to bounded-proof acceptance.

Real runs also exposed a quit/exit race. Failed-quit fallback now first checks
for an already exited exact owned PID, revalidates birth/executable identity
before each signal and tolerates only an `ESRCH` exit during that signal.
A replacement PID is never signalled; surviving-process staging remains retained.
The actor prompt now scopes `listenerIds` to playback instead of ambiguously
forbidding all other ID types; malformed calls are still rejected, not repaired.

`NativeCaptureController` composes the actual signal engine and bounded native
assembler. `prepare` only validates/freezes eligibility with a bounded
reservation; `arm` gathers fresh generation-owned DSP/FFT/ABI metadata,
32 stopped brackets and a complete recent FFT immediately before engine
preparation/reset. Preflight has a 2000 ms deadline and reset acknowledgement
1000 ms. Cached recordings and constructor certificates cannot authorize it.

The controller learns the prior native epoch rather than reusing an epoch after
a Node restart. During reset waiting, at most 64 snapshots of that explicitly
observed prior epoch may be discarded under the acknowledgement deadline.
They cannot resolve arm or publish progress. Unknown/future epochs, invalid
target-epoch reset fields and post-ACK epoch changes still fail closed.
The synchronous `onArmed` callback must confirm actual reply publication before
buffered native lifecycle/progress is released. A promise or queued scheduler
source request is not that confirmation.

Actual native launch plus a fresh coherent playing clock establishes origin;
source-control return and ordinary playing state alone cannot. Exact descriptor
coverage and 32 coherent post brackets remain prerequisites for completion.
Cancel/reset/disconnect fence the owned generation, reject pending work and
disable only owned polling/analysis, never transport. Queued/started/progress/
terminal stages retain bounded timing and trace/correlation/causation IDs.
Natural 480000-sample Gen completion may have `active: 0`; that is not permission
to complete without coverage/postcheck or to accept arbitrary inactivity.

Max's bundled Node is `v16.6.0`: `Object.hasOwn` is absent even though
`Array.prototype.at` and `crypto.randomUUID` exist. The first actual metadata
packet exposed this incompatibility. The controller uses the compatible
`Object.prototype.hasOwnProperty.call` pattern; a missing-API regression and
an execution under the exact bundled binary protect this boundary.

The separate engineering N4M adapter records arm proof locally and starts the
guarded calibration source only afterward. It does not exercise authenticated
reply publication or activate the shipping runtime. Actual arm and launch from
the phase-normalized pass independently parse and bind in the App protocol:
origin counter `421888`, host offset `1905365588`, start sample `1905787476`.
That attempt retained thirteen explicitly incomplete windows; missing
completion proof was rejected. A torn active clock bracket advanced 64 host
samples during acquisition. The controller now discards at most 64 torn
active/postcheck reads without updating coordinates or host freshness.
An eight-packet envelope queue waits for a fresh covering coherent host and
complete FFT. Neither mechanism interpolates or widens timing uncertainty.

The next actual pass completed the requested beats 0-4 in 2825 ms. The App's
actual `nativeCaptureProofSchema`, `audioObservationSchema` and
`assertNativeCaptureObservation` independently accepted all 20 canonical
windows, 20 FFT records, 96000 samples and 32 coherent brackets before and
after capture. Native origin `381440` plus host offset `1957279316` equals
start sample `1957660756`. Stereo peak was `[0.5, 0.5]`, RMS was
`[-12.159430090285273, -12.159430090285273]` dBFS and weighted centroid
`453.29712384376825` Hz. These are actual processed measurements, not a
replayed or synthetic hardware pass.

`fixtures/native-controller-capture.json` preserves the bounded complete
proof, numeric packets, traced lifecycle, executed-source hashes and four
honest failed attempts. Its regression independently rejects missing windows,
shifted origin, torn postchecks and altered FFT data. It checks executable
source identity while normalizing only the staging-directory prefix; matching
path length preserves generated box geometry. All five trials removed six
temporary roots, exited their owned Node process and restored the exact
130-box/150-cable graph, Automation Arm 1 and running transport without
recording/export, save or promotion.

This validates only the recorded scoped pass, not cached readiness. The
engineering adapter still recorded its arm reply locally: authenticated wire
delivery, real tool/context publication and resume retrieval remain open.
The installed Live 11.3.43 is not separate qualification of supported 11.3.42.

### Executed native message graph

The opt-in `appendNativeRuntimeGraph` authored-device composition preserves
every existing box except the runtime entry filename, keeps direct stereo
cords and presentation metadata, and adds five private objects: clock/analyzer
parents, two passive signal sinks and one `route native_control`. It reuses
the existing SDK Node, forwards every previous outlet-zero destination through
the unmatched route, and connects only native processed messages back to that
Node. No transport control or second registration is introduced.

The actual preserved authored source composes from 63 boxes to 62 after the
existing portable bridge removal, then 67 with native wiring. This was a
read-only composition check: no AMXD was written/loaded and no device promoted.
The runtime, resource publication and watchdog changes below still require
fresh host acceptance. Ambiguous runtime/input/guard ownership, missing routes,
duplicate native objects and unsafe entry paths fail without changing the
source document.

The candidate now wires its existing Max guard's unused outlet 2 to native
parents, increasing the composition by 13 cords rather than 10. Native begin
reaches both parents before the guard, so a missing context can fail closed
with an exact-generation stop. `native_watchdog_context` precedes begin and
retains bounded/redacted trace/correlation/causation IDs. The guard cancels
owned polling/envelopes after a 2000 ms heartbeat loss or 30000 ms total
bound, on replacement or deletion; stale arm/stop cannot affect a new owner.
It never controls transport or resets the independent native clock/FFT.
Local watchdog lifecycle completion means monitoring ended, not capture
success; Node-dead App failure remains the existing producer-disconnect/
control-failure record, not fabricated completion.

`build-native-authored --source <device.amxd> --out <staging-directory>`
stages the explicit candidate only. It preserves authored presentation,
uses `audio_listener_native_max.js`, hashes the adjacent native IO and seven
generated DSP/message resources, and retains `realLiveValidated: false`.
Its manifest limits are 10000 ms, 100 windows and a 30000 ms watchdog.
Default builds remain unchanged; no installation or promotion is performed.
Resource corruption, unsafe source/destination and missing authored source
are denied. Packaging and VM tests do not establish actual loaded-host or
tool/publication acceptance.

The unactivated `native-runtime-source.mjs` candidate derives separate clock,
envelope and tagged-FFT parents from the measured native math without changing
any existing default graph or production Gen resource. Each processor appends
a DSP constant ABI outlet; all three must actually be read as 1. The ES5
`audio_listener_native_io.js` helper sends only bounded numeric packets stamped
with the owning UUID generation. It does not read files, register a device,
start playback or authorize readiness.

An owned begin clears held brackets, cancels the previous envelope request and
enables polling; exact-generation stop/deletion disables polling and cancels
the envelope without resetting the independent clock or FFT. Stale arm/stop
commands cannot control another generation. Malformed data produces one fixed
owned error marker, without echoing unsafe values. Unchanged DSP, tempo, FFT
information and ABI metadata are deduplicated per generation; changes and all
descriptor packets remain visible.

Actual generation `87ad150c-7e5c-491f-81d2-becbc3900218` delivered 84 clock
and 85 envelope/spectrum packets over 906 ms, all three executed ABI values 1,
DSP `[1, 48000, 64]` and FFT information `[2048, 2048, 2048, 1]`. Each
metadata kind arrived once, with zero rejected generation packets. Thirty-two
unique coherent playing brackets yielded offset `1639726676` and PPQ-zero
intercept `1428465748`. The actual transport was already running and was never
changed. These playing/inactive-envelope packets deliberately fail stopped
preflight; they prove executed code/message delivery, not an audio capture.

Native testing caught separate poly~ signal/message outlet numbering: `out~ 1`
plus `out 2` placed messages at physical outlet 2, not 1, initially delivering
no packets to the assumed receiver. The corrected parents use `out~ 1` plus
`out 1`, with messages at physical outlet 1. A prior run emitted 851 unchanged
tempo packets against 84 clock packets; per-generation deduplication corrected
that without hiding changes. Initial invalid-cord loading attempts were
removed/recreated with the existing global Max port-initialization pattern;
the exact first-load cause is not separately proven.

Processed evidence and negative acceptance regressions live in
`fixtures/native-runtime-io.json` and `recorded-native-runtime-io.test.mjs`.
All six temporary roots were removed; the entire 130-box/150-cable graph
matched its fresh baseline exactly. Existing Live/Desktop/Max processes and
Set were preserved, with no audio recording/export, AMXD save or promotion.
The candidate still retains the engineering quiet-before-arm and at-most-eight
source-onset guards. It is not arbitrary-music or production acceptance.

Actual native capture exposed `plugphasor~` output
`1.000000000000003` at an integer-beat boundary. The candidate clock now uses
signal-rate `pong~ 1 0. 1.` wrapping before its phase snapshot. This represents
the periodic signal within its declared range; it does not shift samples,
delay the counter, change Gen/envelope/FFT math or widen validation/timing
uncertainty. Raw invalid clock packets still fail. The graph regression failed
before the correction; the next actual pass crossed that boundary and retained
13 windows before the independent torn-read failure described above. With
bounded torn-read recovery, the following pass completed all 20 requested
windows and the independent App postcheck.

Actual stopped generation `18bde6bc-b6f9-4a66-a26f-83569a59868a` then
delivered 84 clock and 85 envelope/spectrum packets in 905 ms, every ABI 1,
with zero rejected packets. Thirty-two coherent stopped PPQ-zero/held-phase-zero
rows yield host offset `1732217428`; the recent complete silent FFT baseline
ends at native sample `567296`, 1984 samples before the final bracket.
Recorded-coordinate preflight validation derives host-coordinate FFT grid
`596` and invalid-frame baseline 0. This is actual stopped IO, not a fresh
runtime arm, native launch, capture, readiness certificate or publication.
Evidence is retained in `fixtures/native-stopped-preflight.json`.

The experiment also exposed source-control limitations:
Max LiveAPI stop/seek/continue requests require later independent readback,
not same-stack acknowledgement. After independently confirmed stopped beat
zero, `continue_playing` resumed near the previous stop position above beat
12000, not the requested zero. That required validating the documented
insert-marker `start_playing` path rather than treating a requested position
as audio onset. Max LiveAPI also did not expose
Track `back_to_arranger`; this does not establish Python API availability or
permit dropping the production guards.

The separate marker-zero probe confirmed `start_time: 0` without changing
the insert marker. Max `start_playing` then yielded running beat `12.866375`
6.460 seconds after the request, rather than resuming the old stop above
beat 13931. This supports the documented marker-start distinction, not exact
native launch timing or Python backend acceptance. Its one helper was removed,
the complete graph matched exactly and Automation Arm was restored/read back.
`fixtures/native-marker-start.json` retains the bounded state trajectory.
Native arm/launch and a freshly installed Python path still require acceptance.

The Python guarded backend now uses `start_playing` only when the known existing
`start_time` insert marker equals the requested start; it never changes that
marker. A necessary seek is independently read on a later scheduled tick before
revalidating all source/recording/binding guards and starting. No-seek starts
still revalidate revision and never write the phase-sensitive position setter.
A separate later tick checks running state, Set identity, marker and transport
guards before acknowledging, still explicitly `sourceOnset: "unverified"`.
Native proof, not this acknowledgement, establishes actual onset.

The existing executor owns queued/started/progress/terminal timing and request
attribution. Deferred progress identifies `listening_seek_verification` and
`listening_start_verification`. Missing scheduling support or marker mismatch
denies before mutation; failed attempted seeks/starts or scheduled verification
remain indeterminate and never stop/rewind. Seven added regressions cover the
old-resume primitive, asynchronous seek/start, changed marker/recording state
and scheduler failure. The simulator models bounded scheduled callbacks;
neither its passing tests nor the Max source-start experiment qualify a freshly
installed Python path. That runner-owned acceptance remains open.

All six owned roots were removed and the exact 130-box/150-cable baseline was
restored. Automation Arm was explicitly changed from 1 to 0 for the guarded
calibration experiment, then restored to 1 and independently read back.
Transport was independently confirmed running; original processes, Set and
stereo cords remain preserved. No AMXD was saved/promoted and no audio was
recorded or exported.
