# Playback Listening and Entity Context

## F1 FluCoMa flatness: initial diagnostic smoke

The first #92 milestone reuses the unchanged `session-clip-identify` audio Set
through a separate `session-flucoma-flatness-smoke` acceptance case. It does not
require the deferred custom numerical fixtures or the identification question.
The bounded smoke passed on **Live 11.3.43** in terminal receipt
`run-fOkqoI` on 2026-11-04: one 90,000-sample capture at 48 kHz, healthy native
level/centroid/attacks, 21 finite deliveries per channel, exact diagnostic/context
retention after owned Desktop restart, unchanged fixture scopes, and terminal
cleanup. The mapped binary's staged path, device/inode and pinned bytes were
verified at baseline and capture completion. No normal installation was changed.
This is a successful rerun after preserved failures, not a first-attempt or
unrestricted reliability claim.

Evidence is retained under `.test-artifacts/acceptance/run-fOkqoI/`.
The application candidate SHA-256 is
`be300068f8309838b720715c5969532cf9041bfb0b4c83673b5b9d2da0b5b83a`;
its separately versioned machine-listening dependency identity is
`88ea38513585cfecff57c6958656400cbdf78a98b9e803d1883f88bdfb3a48e6`.
Earlier receipts remain unchanged: `run-MwQ1f3` (gate syntax and retention),
`run-RTxtSt`, `run-gYKFH7`, `run-YmQ3s1` (loading),
`run-zsVb0U` (descriptor rejection and native reader failure),
`run-aLbLsJ` (History projection), and `run-7rXerC` (positive roundoff).
The earlier native reader failure is not explained or erased by the final pass.

The generated v5 parent taps left and right audio independently into the pinned
`fluid.spectralshape~` external with `@select flatness`, magnitude mode and
explicit 2,048-sample window/hop/FFT settings. Stereo audio still travels directly
from `plugin~` to `plugout~`; the existing native measurement algorithms are
unchanged. The diagnostic message gate opens after the native launch witness
and closes during owned cleanup. Its acknowledgement confirms that its timer
and queued values were cleared, not that an FFT acquired a particular frame.
The passive analyzers remain part of the device's DSP graph outside the gate.

This is **descriptor delivery evidence, not a new authoritative metric
observation**. The stock Max wrapper exposes latest descriptors through a
scheduled callback; delivery count and time cannot certify FFT identity or
input support. Diagnostic values use FluCoMa's native dB convention and
independent channel labels. `flatness.support` and `flatness.valueValidity`
are explicitly `unqualified`; lifecycle `frames` remains zero. Silence and
below-floor discrimination, exact numerical values and complete frame coverage
are deferred, so a finite value must not be interpreted as valid audible texture
or proof of a noise source.

At the theoretical zero-dB upper boundary, positive double-precision roundoff
of at most `1e-9` dB is normalized to zero. Larger positive values, values below
`-320` dB and non-finite values remain explicit malformed-output failures.
This narrow numeric normalization does not establish same-window silence
validity or numerical qualification; the smoke's finite nonpositive-value
assertions remain unchanged.

At most ten fresh outlet snapshots per second per channel cross the Max-to-Node
gate, and progress is further bounded to two events per second. These are not
retained FFT trajectories. Values, delivery counters and cleanup status travel
through the existing traced, bounded and redacted native diagnostic lifecycle
under `spectral-flatness`, visible via typed History. The registered observation
metrics and report schemas remain level, spectral-centroid and attacks; no
unqualified flatness is inserted into their immutable contexts.

No-output and malformed-output diagnostics fail locally while the native
measurements remain usable. The gate reports bounded actual Max class names as
`flatness.leftClass` and `flatness.rightClass`; an unresolved object (including
Max's `jbogus`) fails explicitly with `flatness_external_unavailable`. Class
identity alone is not loaded-binary provenance. No-output after a valid class
acknowledgement does not establish why descriptor callbacks were absent.
Dependency inventory validation supplies separate missing/stale/tampered
artifact evidence. Malformed packets retain bounded numeric/type descriptions
under `flatness.rejected.*`, never arbitrary incoming objects or strings.
Foreign/late ownership packets, diagnostic
delivery failure and unconfirmed gate cleanup prevent successful publication.
Cancellation clears the same owned gate without relabeling it no-output.

The smoke requires actual finite left/right diagnostics linked to its one
owned pass, healthy native evidence and confirmed cleanup. It does not claim
sample alignment or numerical qualification, and cannot close #92 by itself.
If stock delivery cannot support the later exact-frame contract, an
instrumented-adapter proposal requires review rather than fabricated coverage.

## Drum Rack spectrum scheduling regression

The registered `session-drum-rack-listening` case preserves the supplied Set and
sends exactly `listen to clip-1` through the packaged Default agent. Its ordinary
fresh-process runs passed before a spectrum fix: this was missing execution
condition coverage, not an oracle that accepted missing spectra.

The retained reader previously spread its two-read settlement over separate
low-priority timer ticks. A controlled **real-Max 30 ms polling** replay reproduced
pre-playback overflow: `run-EeD9MI` observed backlog 0, 12, 22, then 32 and native
fault 1; the message produced a partial pass and failed acceptance with cleanup.
At the same 30 ms condition, `run-c0ybSQ` passed every unchanged assertion after
pairing two actual counter-bookended acquisitions in each timer callback.
Its sampled backlog stayed at 1. This demonstrates the scheduling-sensitive
failure mechanism; 30 ms is an explicit diagnostic condition, not a measured
constant from the original human session.

Production retains its **10 ms timer**. Each tick requests two separate Max
acquisitions, not two copies of a cached JavaScript row. The existing coherent
counter brackets, two-read immutable-slot settlement, ownership and overflow
guards remain mandatory. No buffer was enlarged. The reader also waits for the
previous ACK to appear in DSP readback before consuming another settled slot.
Otherwise asynchronous Param updates can replace an unexecuted ACK with the
next ACK and trigger Gen's invalid-control guard. Actual generated Gen plus
reader regression coverage demonstrates that fault before the barrier.

Successful and failed captures now publish twelve bounded retention facts
(epoch, selected slot/request, produced/acknowledged counts, backlog, fault and
reader status) through the existing traced native lifecycle. Normal sampling is
limited to once per second; a rejection forces its actual fault row before
failure classification. Diagnostic delivery failure remains explicit and
requires owned cleanup. These facts are observation, never coverage or permission
to advance an ACK. The first observed readback in `run-VKcIuz` was epoch zero,
produced zero, backlog zero, followed by owned epoch-one production: this fresh
instance did not carry opening-time accumulation into its first request.

The real replays used the existing Remote Script token through the supported
environment credential source because the rebuilt app blocked in macOS Keychain
before creating a window. They exercised real authenticated Live, normal agent
approvals and context restart, but do not qualify Keychain startup. See the
[authoring evidence ledger](../testing/acceptance-authoring.md) for all receipts,
including failed setup attempts.

The routine registered scenario does **not** impose the adverse native polling
condition; it can pass with the old implementation under healthy scheduling.
Automated adverse-schedule protection currently lives in the graph-linked native
controller regression. The real 30 ms red/green runs remain controlled diagnostic
evidence, not an automatically enforced scenario-level timing regression.

A subsequent fresh installation on 2026-11-04 updated the normal installed app,
Remote Script and listener resources. Installed-path authentication smoke passed,
and the user confirmed that the installed fix works. This does not retroactively
qualify the earlier ephemeral candidate's Keychain startup or extend the
registered scenario's timing coverage.

## Quantized stopped-launch work (#81)

The user supplied one combined Set and replaced the earlier matrix with two
independent fresh-copy cases: `session-stopped-quantized-audio` listens to
`audio-track` / `clip-1`; `session-stopped-quantized-midi` listens to `midi-track` /
`clip-2`. Both begin stopped at the independently read Live position
2.059377861721612 with global One Bar and two remembered active clips. The audio
clip uses Global; the MIDI clip uses explicit One Bar. Remembered active flags
do not mean transport is moving. No stop, seek, quantization edit, classification
quiz or repetition campaign is authorized. Already-running support is deferred.

The immutable `session-stopped-quantized` fixture preserves the supplied notes,
Operator parameters, media and saved settings. Independent read-only preflight
includes complete MIDI notes and bounded flat-device parameter inventories.
Each four-beat listen requires 90,000 frames at 48 kHz/128 BPM, attributable
persisted context, unchanged source/settings/media, and terminal owned cleanup.

Runtime admission now distinguishes a consistent remembered target from moving,
queued, unknown or recording state. It accepts nonnegative stopped anchors,
global None/One Bar and clip Global/One Bar without settings repair. Live 11's
own `Clip.fire()` restarts the timeline at zero from this stopped state. The
application does not issue a seek: `stoppedBeat` pins the independently read
pre-launch position, while native capture geometry starts at the actual launch
origin zero. Ready/arm proofs validate the stopped coordinate; source/native
coverage permits only the initial stopped-to-playing reset, not later regression.
Native geometry/report rows retain global beats, while Session context/pass ranges and
primary clip links retain clip-local first-iteration duration; contributing
track links retain transport beats. Actual source origin must still match the
independently frozen native anchor; a delayed source cannot publish an earlier
capture. Existing arm-before-launch, traced stages and leave-running cleanup
remain unchanged.

Both unchanged packaged cases now pass on **Live Suite 11.3.43**, with one
90,000-frame capture, all three metric families, retained context, protected
source/settings/media and confirmed terminal cleanup. Receipts under
`.test-artifacts/acceptance/`:

| Case | Valid old-product failure | Passing candidate |
| --- | --- | --- |
| Audio | `run-5pZilH/receipt.json` | `run-6ToPzM/receipt.json` |
| MIDI | `run-ykOZt9/receipt.json` | `run-DYmu3b/receipt.json` |

Old packaged ASAR SHA-256:
`d0e2d35cfba046aafe5344c5d7d0bc1ddf14025b40f8ccd38eb7b2fa9bf3359a`.
Passing packaged ASAR SHA-256:
`074b5ebf13428888e7267e219b35eb6891df185698c68b7a39095d0d0261ab37`.
Both old runs admitted the fixture and reached
`session_launch_state_unknown_or_active`; neither was merely a setup rejection.
Preserve setup failures `run-9Pxf3v`/`run-aojMl7`, stale-script failure
`run-H7JUzk`, and origin failures `run-sWU1vj`/`run-FJGj8U`. The last established
the actual transition `2.059377861721612 -> 0.0196`, source origin zero.

The acceptance runner does not update the installed Remote Script. Install the
candidate script with the canonical installer while Live is closed, then launch
fresh owned processes; rebuilding Desktop alone does not refresh Live's Python.
Lower-layer regressions cover admission, origin matching, post-launch regression,
failure/cancellation and cleanup. Production Electron IPC coverage passes.
Separate attended visual qualification was not performed: this session has no
registered debug `send_user_message` adapter. These passes qualify the two
requested listens, not arbitrary running states, repetition reliability or
musical interpretation. Earlier beat-zero/None-only restrictions below describe
historical qualification.

## Current qualified installation

The original Max patch publishing/deployment scope is complete: JavaScript is
the single functional source, AMXD is generated output, and packaging/install
reuse the identified payload with explicit stale/tampered-artifact rejection.
The installed bundle matches production and qualification. Normal installed
startup discovers both listeners and completes all four MIDI/audio clip
captures with full retained metric coverage. This closes the publication bug,
not every outstanding listening accuracy or reliability concern.

User acceptance on 2026-10-31: the user tested the normal installed application,
reported it working and passing their tests, and accepted closure of the
original publishing/install fix. This is manual acceptance of that scope,
not a claim that unrestricted repetition or every listening mode is qualified.

The JS-authoritative patch/deployment cleanup is implemented. Normal installed
startup in isolated profiles discovers both listeners and has completed MIDI
and audio kick captures. A later full-phrase check exposed a zero-energy FFT
record with a nonzero centroid. The v5-only retained readback now makes the
centroid zero when retained energy is zero; the existing protocol represents
that measured silent record with `centroidHz: null`. Positive-energy records,
missing-record failures and frozen historical DSP sources remain unchanged.
Bounded observed centroid/energy failure facts now reach typed local History.

Final-boundary correction: the spectral producer also pairs the centroid with
the final retained energy before publication. Its six spectral scalars cross
classic Max to Node as a bounded JSON symbol (`spectrum-json`, at most 4096
characters), avoiding numeric-atom conversion of very small positive energies.
Node validates the exact six-number shape and forwards the original numeric
packet to the unchanged strict spectral decoder. Raw spectral atom packets,
malformed JSON and nonfinite values are explicitly rejected. Metadata and
ownership framing remain unchanged; matching producer/runtime bundle bytes
are required.

Failure snapshots can contain more than the lifecycle contract's 24 facts.
The runtime now sends separate, uniquely identified, attributed progress
events of at most 24 facts, preserving every fact and the original failure's
causation/timing. Previously an oversized diagnostic could trigger device
disconnect and obscure the original capture failure.

The unchanged managed silent-tail audio now passes its standalone scenario
and owning group on Live 11.3.43, including complete metric timelines, actual
zero-energy FFT records with null centroids, saved-report reopening and
cleanup. The earlier disconnect and malformed-record runs remain negative
evidence. Current local evidence:
`.test-artifacts/independent-metric-listening/single-source-silent-tail-final-group.json`.

The final Session production bundle is qualified and reinstalled. Seven
bounded Session scenarios pass, covering MIDI/audio, four-beat phrases,
same-source repeats and MIDI/audio/MIDI switching. Production, packaged and
installed application inventories match SHA-256
`787fe8b6cbb8a66ea6a69d45d81a09ec09c4e8d5888e277ea1e7aad438ac54a9`;
all 21 immutable installed listening files match qualification.
Installed authentication and packaged normal-startup/installation gates pass.
The startup test waits for actual readiness using the owning Electron suite's
30-second budget, not the default five-second assertion budget.

The installed executable, without automation flags or changed normal approval
preferences, also completes four independent full-phrase captures: both MIDI
clips and both audio clips. Every pass retains all expected level, spectral
and detector-input records, saves a report and leaves no missing records.
Each case uses a fresh owned Live process at stopped beat zero with global
quantization None; this does not qualify arbitrary nonzero stopped positions.
Normal review evidence is
`single-source-normal-installed-matrix-1793497253431.json`; every owned Desktop
and Live process in that matrix closed successfully. A separate automation-MCP
capture in `human-review-1793499606319/normal-installed-ux.json` also completed:
the accepted message/trace/correlation IDs match the exactly-once rendered
submission, and all three metric families are complete. Computer-use inspected
the owned Agent and Live windows and confirmed the connected app, completed
operations, audio-2 playback and enabled app-controlled listener. That private
helper exited unsuccessfully because importing the MCP executable also invoked
its CLI without `--descriptor`; it is not a clean harness pass.
The additional fractional
Arrangement attempts were denied at dependency-completeness preflight before
playback and are not qualified by these Session results.

Separate findings retained outside the publication-fix scope: the MCP assistant
misclassified half-beat-offset hats as on-beat despite intact numeric timing.
Shared listening/report guidance now explains zero-based beat phase, native
support and tempo-dependent sample conversion; unit and runner-owned
four-beat capture coverage pass, but a corrected musical interpretation has not
been visually qualified. A later owning Session run
(`metric-rhythm-guidance-owning-session.json`) passed five single-capture cases,
then failed before playback on the third same-source repetition with
`metric_spectrum_shared_failure`. Its isolated repeat-three rerun passed
(`metric-repeat-isolated.json`), so repeat reliability remains unresolved;
the earlier positive repeat/switch receipts do not erase that failure.
Packaged follow-up #78 has registered a jointly reviewed two-source fixture and
six-capture A/A/A/A/B/A schedule in one conversation, with explicit stop/return-to-
zero turns rather than hidden harness resets. Shared acceptance assertions now
reject reused pass IDs and require every capture's original source/context
identity/content on later reads, fresh native generations/epochs on unchanged
listener connections, and matching per-pass release ownership. The first
Live 11.3.43 attempt, `run-5VpmX3` (2026-11-03 UTC), stopped after one complete
capture: A measured 95.09 Hz against its frozen 100 Hz minimum. Independent PCM
analysis diagnoses an authoring magnitude-versus-energy weighting mismatch
(energy-weighted A is 84-91 Hz), not an established native capture defect.
The user subsequently approved correcting A's minimum to 50 Hz; B and every
other requirement remain unchanged. The remaining 16 turns in that first run
are unrun; a fresh complete schedule is required. Original identification passed on the
same app candidate in `run-YaPYyO`; both terminal receipts confirm owned cleanup.
See [acceptance authoring](../testing/acceptance-authoring.md#first-continuity-attempt-red-oracle-not-continuity-qualification)
for receipt hashes, candidate pins, and the reviewed correction.
These results do not resolve the historical third-repetition failure.
The final bounded #78 schedule subsequently **passed** in `run-QSnsCe`:
17 turns, six captures A/A/A/A/B/A, 60 assertions, stable contexts/connections,
native A epochs 1-5 and B epoch 1, all metric families and per-pass releases,
and terminal owned cleanup. The original case also passed on that final
candidate (`run-1VAnU1`). On 2026-11-03 the user accepted this passing bounded
schedule as sufficient for #78, deferring intermittent-failure investigation
and additional visual qualification rather than expanding this PR's scope.
Those follow-ups remain unresolved; this is not an unrestricted reliability
claim. App archive:
`14da7322062d931cc4bcd80d083d9323fd24b29ec35c66aeae8caa2b65aff3b9`.
An intervening reset omission was fixed with scoped track/transport tool
guidance; a runner History capacity failure was fixed without dropping evidence
or changing the 32 MiB aggregate byte limit. Preserve their failed receipts
`run-QHbXBo` and `run-Z5awFn`.

The earlier partial run `run-VECZgw` is also retained: only 36/43 spectral
records survived `upstream_immutable_slot_changed`. Its intermittent native
cause remains unresolved. Rejection diagnostics now expose at most 20 immutable
readback cells with current and previous values through bounded typed facts;
the previous snapshot is diagnostic comparison evidence, not repaired audio or
a substituted expected measurement. Native validation and cleanup remain strict.
The separate attended UX check was blocked before submission by its scratch
observer's descriptor-readiness race; owned cleanup was confirmed. Thus the
bounded automation schedule passes, not unrestricted repeat reliability or
attended cross-app UX. An additional diagnostic attempt (`run-gcP1xA`) failed
before capture at Remote Script readiness. After adding a bounded descriptor
wait, the fresh visual attempt (`issue-78-stop-02`) exposed Live's recovery
prompt and Desktop's connection-refused state, still before submission.
Approval to decline recovery was unavailable; recovery data remains untouched.
Supplemental exact-PID/profile cleanup was verified after the observer and host
reported cleanup errors. Further native reproduction and visual qualification
remain blocked, not passed. Full attempt ledger and pins:
[final bounded qualification](../testing/acceptance-authoring.md#final-bounded-qualification).
An additional MCP visual run was cancelled when scope was frozen. Its cleanup
receipt reported an owned-Live identity mismatch; both recorded Agent/Live PIDs
were independently confirmed absent. Do not count that run as a pass.
Historical console-message attribution, absolute/sample-accurate calibration,
public DMG/ZIP distribution and unrestricted restart behavior are not claimed.

Qualification note: the corrected candidate completed a fresh isolated
Desktop MIDI capture and retained both listener registrations in a subsequent
typed discovery read. The planned audio follow-up was blocked before capture:
stopping transport and seeking to beat zero left the previously playing MIDI
Session clip selected for playback. A stopped transport is not proof that all
Session clips are stopped. This run does not resolve the earlier long-lived
discovery loss or qualify cross-track switching; no automatic retry or source
repair was performed.

## Independent metric timelines migration

### Production artifact continuity

The first normal installation exposed a delivery gap: successful qualification
used a generated parent, while production loaded a different saved AMXD parent.
Normal discovery failed despite correct v5 companion versions. JavaScript now
defines the production parent and its native augmentation; AMXD is build output.
Default builds, positive qualification and packaging must use the same
production payload and retained device/resource hashes. Installed listening
bytes remain unchanged apart from separate profile configuration and manifest
metadata. The new source/packaging regressions do not by themselves prove Live
startup or resolve the user's reported invalid-object console messages.
Fresh production-bundle discovery/capture now passes in owned Live 11.3.43,
including four-beat MIDI and audio phrases: 96,000 samples, 16 report rows,
20 detector-input records and 47 FFT records each, with saved report reopening
and verified cleanup. Same-source repeats and MIDI/audio/MIDI switching also
retain registration. The packaged inventory matches the qualified production
bundle. That same bundle is now installed, with the final protected review copy
`installed-human-review-1793497475064/project/debug-two-clips-midi-audio-v1.als`.
Normal installed discovery/full-clip review is complete as described above;
specific attribution of the earlier Max console messages remains unproven.
The remaining Max background host exposes no
content window and has no active Node-for-Max device runners; it is not proof
of an open editor or a reason to terminate a user process.

### Current bounded result transport

Native v5 listening messages and metric observations have separate 2 MiB
compact-JSON/UTF-8 ceilings. Explicit independent-metric ingress advertises the
larger frame allowance; the same-folder compiled producer codec, SDK and runtime
enforce it. Generic ingress and producer identity/credential bounds remain
128 KiB, and earlier observation kinds retain their 256 KiB quota.
Runtime pre-launch result staging remains bounded to two metric frames per
listener. Identity, sequence, source, cleanup and cancellation checks are
unchanged; increasing size does not authorize reducing authoritative timelines.

Admission still reserves complete and possible partial publications, including
schema-valid escaped diagnostics and the source proof. The current estimator
admits all-three-metric 30-second ranges at 44.1/48 kHz through the reviewed
120/128/240 BPM cases, including eight bars in 4/4 at 128 BPM (15 seconds).
The existing 30-second duration ceiling remains. Extreme supported tempos can
still exceed the 2 MiB worst-case partial budget and are explicitly rejected.
This is not streaming or unrestricted long-form qualification.

Saved context entry/pass quotas include bounded metadata around the observation;
the canonical storage and retention contract applies. LLM-facing report paging,
Desktop IPC response bounds and history redaction limits do not grow with the
capture allowance. Both the app and a freshly compiled matched device bundle
are required; an old producer descriptor can still negotiate the old ceiling.
The earlier 128 KiB listening claims below are historical checkpoint evidence.

**Current development qualification:** the matched v5 package now completes
one-playback Session MIDI captures with all three requested metrics on owned
Live Suite 11.3.43. Actual spectral records, exact expected frame counts,
nonzero spectral energy, a pre-arm native phase witness, executed FFT cleanup
and saved-context reopening are required by the deterministic verifier.
Evidence: `seventeenth-three-metric-spectrum-owned-live.json` in
`.test-artifacts/independent-metric-listening/`. This does not qualify the
normal-profile installation, broader source modes or visible Desktop workflow.
Older unknown-phase captures below remain historical negative evidence; their
real-Live scenario needs an explicitly controlled unavailable-analyzer fixture
now that the default FFT path works.

The FFT source owns its poll lifecycle through the parent scheduler and has
one retained reader/ACK owner. Its phase is derived from two actual coherent
acquisitions and a fresh stopped-source clock bracket, not an assumed
`captureStart + 2048`. Publication of known spectral cadence requires that
matching phase witness and a newer executed cleared-bank cleanup receipt.
Classic Max loads the retained reader via `include`, even when the host exposes
a `require` function: the observed Max namespace lacked `createReader` and
threw before any measurement-epoch controls were sent. Node continues using
CommonJS. Reader API shape is checked explicitly. Bounded, redacted
`spectrum-start-error` metadata and source-counter/header facts travel under
the existing owned lifecycle into typed Desktop History diagnostics; they
are not additional ACKs or proof of native parameter execution.

The matching one-beat warped-audio Session scenario also passes on owned
Live 11.3.43 (`third-audio-spectrum-owned-live.json`). Its immutable audio
fixture has a four-beat active loop despite its historical eight-beat name;
qualification freezes the actual four-beat loop without changing launch
settings or capture budgets.

Human-operated review of the protected two-clip Set also produced persisted
complete one-beat MIDI and warped-audio terminal results: each has four level,
eleven spectral and five attack-input records, with no missing records.
Terminal completeness is separate from musical alignment. The audio agent
reported 122.25 ms beat disagreement; its actual clock witnesses, frozen policy
and cleanup ordering have now been audited. Clock disagreement is zero.
Launch and retained playing-row sample/beat-origin residuals are 63 samples.
The 5,868-sample maximum comes from a startup phase witness one sample before
native launch detection: host transport already reports playing at beat zero,
while DSP phase still matches its prior stopped value. Actual native origin
36,475,968 precedes detection counter 36,476,032 by the witnessed 64-sample
phase distance. This is not evidence of uniform 122.25 ms audio lateness or a
shift of every report row. The observation remains intact, with unknown
absolute accuracy. Descriptive mode accepts disagreement above the frozen
64-sample advisory target; only strict mode enforces that admission limit.
Cleanup precedes context publication, and typed saved-context/proof
revalidation agrees with the terminal result.

The same review host subsequently lost listener discovery. A coherent
read-only journal snapshot records producer reconnection churn followed by both
authenticated socket disconnections at 2026-10-31T12:21:06Z and no later ingress
frames through 12:38:06Z. Desktop and Live were still running with an established
Remote Script connection, before the user closed the test apps. An intact device
in the Set does not prove that its
producer connection is live. Source lifecycle coverage is unknown, and the
disconnection cause remains unresolved. The discovery limitation
`native_per_pass_validation_required` means independent validation is required
for each capture; it does not invalidate an already verified successful pass.

The reported console flood has a separate reproduced wiring cause: the v5
parent retained legacy `host`/`frame` message feeds that the metric runtime does
not implement. Its obsolete analysis/polling graph and unsupported
enabled/preview messages are removed rather than adding retired handlers.
Actual native plugsync/phasor acquisition, DSP metadata, initialization,
watchdog and transparent stereo routing remain. Shared identity collection
checks device/track IDs before asking for names, avoiding invalid-object
queries without retaining stale placement as valid. Neither correction alone
establishes the trigger for the original socket loss.

The corrected matched candidate passes fresh owned Live 11.3.43 MIDI and audio
all-metric scenarios and three consecutive one-beat MIDI captures on one loaded
producer/registration. The repeated scenario performs exactly two independently
verified harness-only stopped baselines, with no actor retry, replacement,
rebind or installation; epochs increase and earlier contexts remain immutable.
This does not qualify longer-lived Desktop discovery, MIDI/audio/MIDI
switching, or every duration/Arrangement range.

Normal Desktop startup now enables the same native-v5 admission in authenticated
signal ingress and the listening host, without changing normal approvals.
Isolated automation still uses explicit `--automation-metric-listeners`, which
requires `--automation` and its separate profile. Electron coverage checks
normal-startup v5 discovery and profile-scoped credentials, isolated opt-in and
visible-message IPC.
Production agent guidance identifies wire5 independent families and honest
partial results, not the retired wire3/wire4 requirement.

Saved-Set staging replaces both library-origin references and active
project-collected references to the exact pinned old device. It must not merely
update original preset history while leaving the active device pointing to an
old `.amxd` excluded from the copy. The reviewed two-track Set contains four
such file references (two active and two origin references); the explicit
inventory is checked, and every replacement uses the same complete matched
bundle. Source bytes, MIDI, audio and unrelated factory references remain
unchanged. Offline preparation alone still does not prove that Live loaded it.

The approved replacement design collects each measurement family independently
during one playback, then projects trustworthy results onto a shared musical
report. It applies to Session and Arrangement. A failed frequency family must
not block independently valid level/level-derived attack evidence. A published
partial result must identify usable metrics, actual support, gaps and reasons;
shared ownership/source/clock failures remain capture failures. Cancellation
does not silently publish a partial observation.

The new coordinate contract, `metric-listening-geometry/v1`, uses a global
quarter-beat (sixteenth-note in supported 4/4) grid clipped to the requested
interval. Each sample boundary is independently rounded relative to the frozen
capture origin; adding rounded hops repeatedly is not permitted. Fractional
Arrangement endpoints have clipped rows. The duration ceiling remains thirty
seconds; derived reporting rows are bounded to 2,000, spectral record admission
to the capture-dependent FFT count plus boundary allowance, and the separate
100 ms attack-detector cadence to at most 300 windows. These coordinate budgets
do not override encoded transport, context-entry or storage byte quotas and are
not physical source/timing proof.

At 128 BPM/48 kHz, four beats require 90,000 samples and sixteen 5,625-sample
reporting rows. Native FFT analysis retains its actual 2,048-sample support;
a row projection must not pretend it is an exact whole-row average, split an
old RMS/peak aggregate at a new boundary, or forward-fill missing spectra.

This migration is **in progress, not the installed capture behavior**. Geometry
and independent-collector foundations do not authorize a new listener capability
or partial publication before native/SDK/runtime/context/UI integration and
qualification. Existing saved schemas retain their historical semantics.
The installed pipeline still uses coupled descriptors until that negotiated
replacement is wired and qualified.

Offline saved-Set preparation uses `scripts/lib/saved-listening-fixture.mjs`.
It pins the original Set, project audio/device and referenced factory files,
then permits exact project-path rebinding only into a fresh owned candidate.
Bounds are 256 references, 8 MiB per file, 16 MiB expanded XML and 64 MiB total.
A separately reviewed, hash-pinned complete native-v5 bundle is required before
writing a candidate; without it the result is explicitly blocked. A prepared
offline copy is not loaded-code or real-Live qualification. Original Sets and
preserved copies remain read-only, and this utility never launches applications.

The latest user-Set attempts passed preflight and arm but failed during
collection: MIDI before any assembled window, audio after six, with controller
queue eight, assembler queue zero and retained spectral backlog. The delivered
preflight correction is scoped progress, not overall Session reliability.
The reported 7-8 second envelope age used a preflight-only timestamp and does not
establish collection latency. Preserve the observed predicates separately from
unproven delivery causes.

The shipping-boundary startup regressions now reproduce and correct a separate
launch race: a live state snapshot could be promoted to a measured window, and
a retained first window acknowledged before onset recognition could be lost.
The controller preserves state-only provenance and stages immutable measured
records until launch: at most sixteen retained envelopes and thirty-two spectra,
then admits them in order exactly once. Changed holds, real measured sequence
gaps and overflow still reject explicitly, with pre-cleanup counts and bounded
lifecycle diagnostics. Eligible FFT prefix and cancellation cleanup are covered.
The two corrected regressions fail before the source fix. This is source-level
causal evidence, not fresh physical qualification or an installed update.
The staging bound also covers a reproduced 6.83-second stopped-DSP armed wait:
prune only FFT endpoints proven before future onset by an accepted stopped
source clock or validated marker origin. Marker origin takes precedence once
known. Crossing/post-onset frames remain protected; unknown backlog still
rejects at the unchanged thirty-two-record capacity rather than rolling eviction.
The controlled paused-spectrum baseline still reproduces coupled controller
queue overflow with assembler pending zero; that remaining failure is not
reclassified as solved by the startup correction.

The additive `metric-audio-observation/v1` storage contract keeps independently
indexed metric records and explicit gaps authoritative. Existing capture
boundaries still parse legacy results explicitly: widening saved-context readers
does not authorize an unnegotiated capture. Separate metric publication builders
validate inspected source/range, connection epoch and trace ownership and persist
partial passes atomically without promoting legacy failures or cancellations.

Opt-in envelope ABI three / level configuration one now accumulates actual source
samples at musical boundaries and separately at the unchanged physical 100 ms
attack-input cadence. Both families retain bounded sixteen-slot FIFOs; native
headers use source-counter coordinates and the values retain capture-local
supports, counts, peaks and sums of squares. Version-two reader declarations
explicitly distinguish variable musical support from fixed detector cadence
while reusing the existing version-one FIFO framing, exact-once settlement and
request-before-ACK rules. Sample-moment/support validation precedes admission.
Controlled Gen-model-to-reader tests compare both timelines against independent
PCM references; they are not physical Max/Live qualification. Default shipping
wire-four/ABI-two generation remains unchanged and does not advertise this path.

The opt-in spectral handoff consumes the actual retained `NativeMessageIO`
forwards; it does not create another FIFO reader or issue another ACK. Capture
slots come from an independently admitted first native-counter FFT endpoint,
never the first delivered frame. Forwards omit the native epoch and FIFO sequence,
so actual ABI/retention-ready binding and a fresh generation for every capture
are required; these omissions must not be presented as measured packet metadata.
Reader acceptance/ACK and Node collector acceptance remain distinct stages.
Controlled Gen/reader/handoff/collector tests do not establish physical delivery.
Production phase admission must obtain a validated pre-capture retained FFT
endpoint under uninterrupted native-counter/DSP continuity. ABI, readiness,
FFT-size and failed-frame diagnostics alone do not supply that endpoint.
Changing retention epoch preserves FFT phase and can enqueue an already-cached
endpoint, so sequence one does not prove a new post-arm frame. The first expected
capture endpoint is the first anchored hop strictly after capture start, with
capture end included. A missing phase anchor makes spectra unavailable, not the
shared capture; a DSP/counter discontinuity invalidates the anchor. This optional
preflight probe and controller phase admission remain unwired.
Likewise, successful native IO stop/cleanup is not metric completeness: retained
prefixes remain available even if neither envelope family is complete. Shared
failures, cancellation and timeout cannot be converted into publishable data by
successful cleanup. The controller still owns source proof and useful requested
metric admission.
The native IO evidence getter exposes only actual admitted counter-stamped
timing/configuration receipts in eight fixed slots, including retained prelaunch
and cleanup evidence. Absent slots stay explicitly unavailable, failed/cancelled
receipts are diagnostic-only, and repeated queries do not refresh receipt age.
These scalar receipts are neither readiness nor source-coverage certificates.

The development-only metric IO is a clean break, not a fallback to the coupled
listening pipeline. `NativeMessageIO(mode, send, control, diagnostic, { now })`
accepts only passive `clock` or retained `spectrum` mode; classic Max loads it
with `<mode> metric-v1`. Removed version arguments, opt-in flags, coupled
envelope controls and latest-value/raw-bank selectors are not supported.
Physical clock ABI2, FFT descriptor algorithm2 and FIFO ABI1 remain actual DSP
primitives, not support for old application listening wires.

Clock acquisitions and musical timing/configuration/measurement banks must be
coherent before admission. A valid forward-moving counter that changes during
one acquisition means that acquisition crossed a DSP boundary: discard it and
retry within the existing deadline. Do not repair its values, refresh retained
receipt age, acknowledge a measurement, or treat it as coverage. Malformed or
backwards musical bookends remain fatal shared corruption. Owner-attributed
`native_clock_cohort_skipped` and `native_metric_cohort_skipped` progress carries
bounded acquisition operands; musical skip evidence is emitted on the first
skip and every sixteenth skip, with its counter reset for each admitted pass.
The required genuine clock cohorts, receipt counts and timing bounds are unchanged.

Asynchronous evidence/status/tick queries have bounded separate delivery
tracking: they cannot continually block readiness or arming solely by being
queued immediately before those decisions. Configuration, arm and other
controls retain their delivery barrier. Query rejection still fails the pass;
terminal release accounts for both classes of outstanding delivery. Trace,
correlation and causation identifiers preserve bounded application/tool-call
punctuation rather than accepting only UUID-shaped identifiers.

The first reviewed owned v5 Session MIDI capture passed on Live Suite 11.3.43:
one beat at 120 BPM, independent level and attack timelines, typed saved-report
reopen and executed cleanup. This is not spectrum, Arrangement, Session audio
or Desktop delivery qualification. Saved Session reports include the canonical
message-rate source/latency/routed-contributor limitations added by the host;
verification compares all measured data exactly and requires that enrichment.

An explicitly requested spectrum whose native FFT phase is not established is
retained as a failed acquisition, not dropped and not assigned a guessed first
endpoint. Its algorithm still identifies FFT size/hop/units, but
`firstFrameEndSample` is `null`. No timed records, expected slots or gaps can be
claimed until phase is known: `expectedRecords: 0` means no slots were assignable,
not that zero frames were expected physically. Every report row labels this
`unknown-phase`, distinct from known-cadence `no-frame` and measured silence.
The acquisition retains an explicit phase-unavailable limitation and attributed
failed lifecycle. Healthy level and attack timelines still publish a partial
report through the same source/cleanup proofs. A request with no trustworthy
metric data cannot publish a successful observation.

The v5 retained FFT graph now snapshots twenty retained cells between two
executed `sourceClock` taps (Gen output32), using bin2047 for all twenty-two
cells and the current `spectrum_measurement_frame` selector. Counter carry is
covered in generated-code/graph tests; retained reader-to-handoff tests use the
current bookended API and executed disarm/release. This prepares physical
readout, but does not itself qualify a native phase witness or authorize a
positive frequency report; that controller binding remains unfinished.

Forward-advancing FFT counter bookends discard a torn acquisition without
admitting data, moving reader acknowledgements, or repairing timing. The
existing bounded, owner-attributed `retention-unstable` progress event reports
the retry. This also applies while acquiring a cleanup watermark or disabled
receipt: only the next genuinely coherent bank may advance cleanup, and the
original deadline remains fixed. Malformed, backwards, or regressing counter
cohorts still fail rather than being retried.

FFT cleanup uses `requestSpectrumStop(generation, nativeEpoch, outcome,
absoluteDeadlineMs)` exclusively. Acceptance pauses forwarding/ACK; the next
fresh coherent counter-bookended bank atomically captures the real source
watermark and requests epoch zero. A separate newer cleared bank confirms
disarm. `retainedSpectrumFrame` consumes `[counterBefore, ...raw20,
counterAfter]`; explicit `spectrumCleanupTick` and `spectrumCleanupEvidence`
retain the fixed deadline and bounded actual receipts until `release`.
Classic-Max selectors are `request_spectrum_stop`,
`spectrum_measurement_frame`, `spectrum_cleanup_tick` and
`spectrum_cleanup_evidence`; the getter emits `native_metric_spectrum_cleanup`.
Queued/started/progress/completed-or-failed cleanup evidence preserves the
generation/epoch, timing and classified reason. No setter, reader completion,
wall time or descriptor endpoint substitutes for executed disarm.

Malformed FFT payload values fail the retained family without ACK or loss of
the accepted prefix; malformed ownership/framing or source-counter bookends
remain shared corruption. Cleanup receipts require fully numeric, coherent
actual banks regardless of earlier family failure. Local synchronous output
rejection does not ACK, but asynchronous Node collector acceptance is not an
additional FIFO ACK dependency. Production graph/entry and consumer integration
remain separate qualification gates; this source contract makes no installed
or physical-delivery claim.

The musical `metric_prefix_record <owner6> <family> <one-based-sequence>`
getter returns one immutable, already validated record with a verified origin,
not the entire prefix. `metric_status` supplies the genuine accepted count;
the Node-owned cursor advances after collector admission. Requests neither ACK
again nor refresh receipt age. `metric_record` remains the distinct clean-stop
getter. Shared-failed, cancelled, stale and released ownership cannot retrieve
publishable records through either getter.

Attack observation records retain their own detector input peak/RMS, declared as
`independent-100ms-level-windows`; missing musical-level packets are not missing
detector input. Validation replays the original threshold/refractory/rise-state
algorithm over a retained input prefix. A detector input gap ends trustworthy
attack coverage rather than guessing a reset or publishing later empty lists.
Threshold remains bounded to 120 dB, whereas measured strength can reach
`120 + 20 * log10(64)` dB-rise for the supported above-unity input range. Neither
measurement amplitude nor measured attack strength is clipped at 0 dBFS.

`projectMetricListeningReport` assembles a bounded value-bearing view of those
references, with default eight and maximum thirty-two reporting rows per page.
It preserves native support, indexed gaps, acquisition status and next-row offset.
Every page retains the source envelope, alignment and descriptive timing limits,
requested metrics, algorithm versions and units, per-metric expected/retained/
missing record counts and declared limitations. Paging must not strip the context
needed to interpret linear amplitude, hertz or detector dB-rise correctly.
The canonical strict `metricListeningReportSchema` enforces encoded page size,
ownership of row indices/end events and distinct missing/silence semantics.
`pageBudget` exposes the byte limit, requested row limit and whether a page was
reduced for encoded size; `nextOffset` resumes at the next intact row.
Offsets count retained row positions, not original musical row identities.
Every page carries `reduction`, distinguishing explicitly omitted display rows
from metric acquisition gaps. Selected rows retain their original indices and
sample/beat boundaries, including capture-end event ownership; even a display
reduced to zero rows retains its acquisition metadata and native timelines.
Centroids use spectral-energy weights over endpoint-assigned frames, never a
whole-row time average. No frames have null spectral energy; actual spectral
silence has zero energy and null centroid. Empty valid attack lists remain
distinct from unavailable support. Half-open musical rows and a final capture-end
convention prevent duplicate frame/event attribution. Attack timestamps remain
the end of their native detector window, not an inferred onset inside it.
Separate event references preserve a boundary attack in the following musical
row without extending the preceding detector's coverage into that row, including
when the following row's own detector coverage is missing. This pure projection
performs no playback, physical proof, retries or persistence, and does not change
installed capture behavior.

Agent-facing `ableton_context` adds `action: "report"` for a known metric context
ID. It uses the same App-session repository, freshness scope, caller cancellation,
trace and active-agent attribution as `get`. The request accepts `contextId`,
`includeHistorical` (default false), `offset` (default zero) and `limit` (default
eight, maximum thirty-two). Follow `report.nextOffset` until null; an offset at
the end returns an empty final page, while an offset beyond the end is rejected.
The complete `{action, entry, report}` response is limited to 64 KiB of encoded
UTF-8 JSON, including non-ASCII text rather than counting JavaScript characters.
Oversized entries or metadata fail the typed read; they never become truncated
success-shaped reports or a partial acquisition outcome. The projection's
separate 48 KiB page budget reserves room for the entry and response framing;
row reduction must preserve deterministic continuation and every retained
measurement, support and metadata field. Metadata or a single row that cannot
fit is an explicit failure, not permission to discard evidence.
The response contains the typed entry summary and `metric-listening-report/v1`
page only, not the full authoritative observation arrays. Each musical row
contains measured level records, weighted spectral centroid/energy with native
frame support, attack events and support, and per-metric availability/gaps.
Acquisition status and overall outcome remain separate from row availability.
No-frame/missing spectral energy is null; zero denotes measured silence only.
Existing `get` and all legacy payloads remain unchanged; `report` refuses legacy
conversion. The application-owned operation lifecycle and timed repository reads
remain authoritative for queued/started/completed/failed/cancelled events and
trace propagation; the pure synchronous projection creates no new persisted
state, audio body, network path or renderer storage access. Immediate reads do
not enter the mutation queue. Serialized SDK failures for `context.report` emit
an owning failed terminal operation event rather than a completed event, while
retaining the existing bounded redacted failure result. This reader does not
enable the still legacy-gated production capture pipeline.

Shared transport verification is now reusable independently of descriptor
completeness through `nativeSourceCoverageProofV2Schema` and
`assertNativeSourceCoverageV2`, with the corresponding expected-context-only
Session wrapper. They retain the existing armed policy/geometry, launch epoch,
coherent stopped/playing clock brackets, immutable holds, post-end coverage,
timing extrema and alignment checks. They do not prove clip identity, native
musical configuration or metric correctness, and are not capability admission.
Legacy full verification reuses this same transport check and still requires
all legacy descriptor windows and independently verified summaries.

The application coordinator has an explicit independent result-contract branch.
Only a prepared capture declaring `independent-metric-timelines/v1` can enter
it; the current legacy runtime does not declare that contract. It validates one
owned result per listener and exact pass/trace/correlation/causation, disarms and
cleans up before committing, and reports `partial` only after successful atomic
publication. Failed cleanup, cancellation, foreign identity and schema rejection
never become partial success. Existing legacy results retain strict completeness.
Public tools, the embedded agent's transport lease and Desktop inventory/events
carry that terminal outcome and bounded per-listener metric acquisition counts,
gap reasons and context references. `listening.partial` retains the owning trace
and duration; metric payloads are not copied into lifecycle metadata. This is
prepared application plumbing, not new negotiated native capture or installation.

Wire version 5 has a separate, explicitly opt-in authenticated ingress path.
The internal `independentMetricListeners` server option defaults to false:
normal descriptors and hello acknowledgements still advertise versions 1-4,
and a version-5 hello is denied unless the option is enabled. Structural
validation of version-5 messages does not by itself enable runtime admission.
The metric producer contract, track/device binding and capability must agree.
The server assigns the connection/listener identity, generation and control
sequence; prepare freezes the original configuration and attribution for arm,
cancel and publication.

`sourceContext` carries the frozen expected observation source from application
inspection. It supplies Arrangement track references and Session clip kind,
clip-start offset and coordinate metadata that the native audio reader cannot
infer from sound or manufacture as Bridge UUIDs. When supplied, its mode,
transport range and Session target must match configuration, and final source
metadata must match it exactly. Real capture orchestration and the native
controller require this input before collection; pure commissioning/clock
fixtures can omit it. It remains expected context, not a physical certificate
of exclusive clip attribution or a replacement for the source-continuity guard.

Ready proves stopped, unsealed idle preflight and reserves the future epoch;
it does not arm DSP. The explicit arm must match that reservation, followed by
a validated launch. Complete and partial publication must include the exact
accepted arm/launch proofs and pass canonical source/observation validation
against the original configuration, not a terminal-supplied replacement.
Metric-scoped failed lifecycle events can remain progress while healthy
collection continues. Shared failure, cancellation, deadline and uncertain
cleanup cannot acquire a published partial observation. Native lifecycle
events retain their own causal/event identity, metric scope and actual optional
stage duration; pass elapsed time is not relabelled as a stage duration.
Up to twenty-four canonical scalar evidence facts can carry actual per-family
read/accepted/ACK counts, backlog/capacity, support and receipt operands.
Unavailable operands remain explicitly unavailable, never invented zero values.
Lifecycle payloads are bounded/redacted, duplicate event IDs are emitted once
and mutation of an accepted ID is rejected. The capture deadline is fixed at
prepare, never extended by arm or progress. Production controller, SDK/runtime,
matched-resource delivery and real-host qualification remain separate gates.

The shipping producer SDK now loads the same-folder compiled canonical codec
for version 5, with no handwritten validator or legacy fallback. Its real TCP
integration covers both modes, complete/partial outcomes, buffered-write
backpressure, cancellation result-before-reply, cleanup failure and source
substitution denial. These tests use explicitly synthetic native proofs, not
physical DSP evidence. Runtime host integration has its own default-off
`independentMetricListeners` option; it must retain authorized Arrangement
positioning and Session source monitoring/sealing around the new control driver.
Expected source/configuration and returned per-listener ownership are checked
again at publication. Legacy listeners and historical observations keep their
existing readers; unused replacements and temporary scaffolding must be removed
rather than retained as alternate production paths.

## Installing the development listener

The normal app integration reinstall delivers the canonical
`Machine-Listening-Development.amxd` as a complete native-v4/ABI2 bundle in
`User Library/Presets/Audio Effects/Max Audio Effect/Machine-Listening-Development/`.
Companion JavaScript/DSP/patcher files and hash metadata are required; copying
only the authored AMXD is not equivalent. Packaging uses repository sources,
not a saved test fixture or a previously installed device.

The same integration operation installs canonical Midi-Capture into its own
Max MIDI Effect folder and resolves one selected normal-profile discovery
configuration for both. See [Packaging and Operations](../platform/packaging-and-operations.md)
for commands, exact paths, confirmation, partial recovery and diagnostics.

Insertion onto a track is manual. Installed-on-disk is distinct from loaded,
authenticated native readiness; the app's negotiated capability checks remain
authoritative. Installation does not itself establish capture readiness or
real-host qualification. Existing unrelated Library copies remain untouched.

Companion checklist:
[Playback Listening Implementation To-Do](playback-listening-implementation-to-do.md).

Architecture decision:
[ADR 0006](../architecture/decisions/0006-playback-listening-and-entity-context.md).

## Focused closeout candidate

### Retained FFT vector readback correction

The subsequent instrumented user session contains two original-Operator
successes and four native preflight failures on original audio and fresh
audio/Operator instances. Every failure received 80-92 accepted clocks, retained
32, and established both readers' readiness. The wait transitions identify an
FFT endpoint behind the newest clock, then stale metadata, followed by the
one-source-second span rejection before launch. A zero post-clock count is
expected before post-binding; it is not a missing preflight clock feed.

The wire4 retained spectrum graph sampled bin zero of its full 2048-bin
spectral vector even though the Gen producer commits a complete FFT descriptor
at bin 2047. This exposes an earlier vector's descriptor and can add a whole
FFT window of readback delay. The corrected measurement readback samples bin
2047. Envelope/configuration sampling, legacy/non-retained graphs, record
ordering, two-observation settlement, epoch ownership, capacities, deadlines
and the strict nonnegative, less-than-2048 clock/FFT bound are unchanged.
Post-clock count/span expectations are emitted only for post-binding failures.
Existing lifecycle events, bounded diagnostics and typed History remain the
observability path; no new storage or raw-audio logging is introduced.

`native-retained-preflight-timing.test.mjs` executes the shipping Gen producer,
IO, reader and controller with separate FFT-vector, parameter, clock and polling
schedules. First-bin sampling reproduces stale preflight; an occasional rejected
clock can make the old path pass at the exact 2047-sample boundary. Last-bin
sampling corrects that boundary, but was insufficient in actual Live: two
captures completed and the third still rejected preflight. The source model is
not a Max scheduler oracle; preserve that failed physical run as a counterexample.

### Bounded preflight clock-cohort join

The retained controller previously kept moving its newest-clock target while
immutable FFT evidence settled asynchronously. It now freezes an actual
32-row before-binding clock cohort once prerequisites are ready, waits for the
FFT endpoint to fit that cohort, and refreshes the cohort if the FFT is newer
than its end. This reuses the existing immutable before-binding snapshot rather
than inventing clocks or growing retention.

The current clock and rolling acquisition remain live. Metadata/reader
readiness, epoch ownership, stopped transport, the one-source-second acquisition
span, current-host freshness, the two-second wall deadline and the strict
nonnegative, less-than-2048 cohort/FFT distance remain enforced. Cleanup clears
the cohort before another pass. Independent Gen/IO/reader/controller regressions
reproduce the old refusal with 2048-6144 samples of delivery delay, pass after
the correction, and still reject stalled sources, changed transport and
over-budget acquisition.

Named `preflight-cohort-clock` and `preflight-cohort-age` operands distinguish
the selected cohort from the current source-span decision clocks. Both strict
contract/SDK vocabularies carry these bounded facts through existing rejection
events and typed History. No new storage or audio-body persistence is added.

Actual runner-owned Live **11.3.43** qualification now completes MIDI A-B-A
with three distinct immutable contexts, plus the wire4 Arrangement, MIDI
Session and warped-audio Session group. Each case passes independent native
coverage/source checks, typed reopen, exact postconditions and owned-process
cleanup. The Arrangement check uses a bounded audio fixture: the earlier
195-parameter synth fixture was refused before capture by the unchanged
dependency-completeness guard.

The four-beat audio loop also exposed a verifier omission: the existing Remote
Script legitimately reports `covered` after the requested first iteration.
The verifier now independently checks the unchanged epoch/clip, completed
loop timing, phase, origin, launch and recording state instead of mislabeling
that receipt invalidation. Source-driver completed lifecycle events retain
bounded, sanitized request/result receipts so future refusals expose their
actual action and status. This changes neither production source monitoring nor
capture admission.

A subsequent visible, isolated Desktop run on Live 11.3.43 established two
registered baseline instances before the human duplicated the audio track.
The new instance `02c5856e` and device `9a49d41d` then completed exactly one
four-beat Session capture (`9323f148`), publishing context `787ff748`. Typed
History and the returned observation independently confirm the new same-track
binding, five-track inventory, 96,000 source samples at 48 kHz, 20 untruncated
envelope windows, clip-local/global beats 0-4, nonzero peak and approximately
-15.06 dBFS RMS. There was no capture retry. Earlier actor setup failures and
denied duplicate requests remain separate, not recast as successful listening.

The final visible run displayed YOLO; it does not qualify ordinary approval
policy. The agent's one permitted immediate pass query correctly reported
pending/arming; a separate read-only follow-up confirmed completion and
retrieved the exact persisted context. The automation App closed cleanly at its
time limit.

The matched timing candidate was subsequently installed after Live/App closure,
trace `f4af0faf-da25-48a6-9b7e-d2c91aed3ec2`. All 24 packaged native
device/code/DSP resources match the physically qualified candidate; installed
App ASAR SHA-256 is
`9d39fd436c5a8c64dd5ad133eed84666b17a2e877ff1536987ac6f4cb6e6a2ab`.
Production launch/integration package checks and installed authentication pass.
Canonical detection reports all three integrations current; the Remote Script
and protected normal-profile state were preserved. Broader acceptance in the
user's own Set remains open. Use the canonical User Library device, not the
isolated fixture's automation-profile-bound copy.

### Earlier closeout history

The user's fresh Operator MIDI Set failed a four-beat Session capture at
128 BPM with `native_envelope_buffer_overflow` before any measurement assembled.
A later Arrangement beats-16-32 pass completed through the same listener
instance and connection, publishing 75 envelope samples and 16 attack estimates.
These are different capture conditions, not a controlled proof that Session
launch quantization caused the failure. The actual Session join blocker remains
unproven.

Retained captures now acquire the bounded 32-row post-clock proof when the
source counter reaches the capture endpoint, independently of descriptor
assembly latency. Confirmation still waits for exact descriptor coverage and
the existing engine host-binding, alignment and freshness checks. The one-source-
second evidence window, current-host freshness, descriptor age/capacity bounds,
deadlines and non-retained/legacy behavior are unchanged. This corrects a
reproduced acquisition-order defect: timely post clocks were previously discarded
while the final descriptor was delayed. Independent 10 ms clock regressions cover
700/900 ms tail delays at both 120 and 128 BPM, including strict policy, without
weakening rejection of missing, invalid, stale or unconfirmed evidence.

Failures can carry a first-owner, immutable
`native-capture-join-rejection/v1` diagnostic. It distinguishes controller versus
assembler envelope overflow and post-binding rejection, recording bounded pending
counts/endpoints, accepted clock and age, spectral descriptor/interval, fixed
retention state snapshots, and post-clock/coverage operands before cleanup.
The existing SDK and typed ingress validate fixed array lengths, finite counters,
closed enums and generation ownership. Trace/correlation/causation attribution
continues through the terminal result and redacted history. The diagnostic is
non-authoritative failure evidence: no raw audio, new storage path, completed
context, automatic retry or transport cleanup is introduced.

The eight-entry waiting-envelope bounds remain unchanged. The closeout candidate
contains an evidence-based post-clock correction plus diagnostics, not a claimed
fix for the user's still-unexplained MIDI overflow. A matched rebuilt App and
listener are required to carry the new optional diagnostic scope. Human-assisted
audio/MIDI repeated captures and an Arrangement sanity pass remain separate
acceptance gates. Earlier fixture checkpoints below are historical evidence,
not acceptance of the user's current Set.

The matched diagnostic candidate was installed on 2026-10-25 after the user
closed Live. The installed App `app.asar` SHA256 is
`a3150e2f1551cdf44bec522d942aa1cbd6575a165fcd6389ec7aeee47755a711`;
installation trace `d0d4b078-fd71-4a8e-8e23-612d422100a5` retains delivery
attribution. Thirty unchanged bundle assets match the package, and the canonical
detector validates both installer-normalized assets and reports all three
integrations current. Preferences, credentials, session/project registries and
the existing Remote Script were preserved; no rollback copy remains. This is
installation evidence only: the owned repeat fixture failed at bridge startup
before capture, and current-candidate human listening acceptance is still pending.
Saved Sets must load a fresh canonical listener instance before that pass.

## Rejection evidence closeout

Two subsequent installed-candidate Operator passes failed during arming with
`stale_native_preflight`, before launch or measurement. Complete typed traces
preserved preparation and the failed arm reply but no native predicate operands.
This is an application-owned rejection and an observability gap, not evidence
of an Ableton failure or clip identity mismatch. Discovery's `ready: false`
means independent per-pass native validation is required; it is not the failed
predicate. A retained preflight span above one source-second can reproduce this
code with several different missing or misaligned prerequisites. The physical
host prerequisite that failed is not yet established.

The shared `listening-failure/v1` contract retains the original code, owning
component, phase, stable check ID, bounded actual/expected scalar facts, units
and diagnostic trace/pass/job/request reference. Missing, invalid, nonfinite
and observed-zero values are distinct. Coverage is explicit: complete evidence
must have observed operands and no reported gaps; partial or unavailable
evidence must name its limitations. Truncation downgrades complete coverage.
The summary is non-authoritative and cannot make a rejected capture admissible.

Native owners use the strict `native-check-rejection/v1` carrier, or optional
`checkEvidence` on an existing diagnostic scope, for their stable predicate,
launch disposition, elapsed/deadline timing, operand tuples and clock domains.
The common summary preserves strict `less-than` separately from `at-most`
and bit-mask `contains-all-bits` separately from equality. Flags, epochs,
fractions and BPM retain their source units; thresholds are not rounded,
relaxed or clamped for presentation. Native clock
domains remain visible in fact names. The full validated native snapshot,
metadata ages, input/clock counts, bounded accepted/rejected inputs and
lifecycle remain in History. Source missing/suppressed/truncated evidence
stays explicitly partial even when the original rejection is fully known.

The optional native `checkEvidence.preflight` snapshot names
`actualSpanSamples` and `maximumSpanSamples`, retaining the exact first/last
11-cell decision clocks, prerequisite readiness/presence, receipt ages and
exclusive spectrum/clock alignment bound. The source-span limit is one
native-source second, not the separate wall-time acquisition deadline.
The authenticated-ingress/reopened-journal regression compares the entire
validated source diagnostic unchanged, including these decision rows.

The source guard/phase/evidence/test inventory is maintained in
`max-patches/audio-listener/native-rejection-inventory.mjs`. Source qualification
passes the 1,010-test Max suite, and the integrated application passes 3,500
TypeScript and 284 Python tests. The frozen-source authenticated-ingress,
coordinator/public-result and reopened-journal gate also passes, as does the
isolated Electron synthetic failure workflow. These are software qualification,
not actual-host listening acceptance.

The observability candidate is now installed. App ASAR SHA256:
`071eb249c4d4e61fb9c454d310b41c9327982f5ec1f3b3117b72b976601e7349`;
installation trace: `71950290-96e6-4f0f-b8e4-62aca4c46b8c`.
Canonical detection reports the listener, MIDI device and existing Remote
Script current; the Remote Script update was explicitly skipped. Twenty-five
listener assets match raw packaged bytes, and the installer-normalized manifest
is validated canonically. No rollback copy remains. Installed production
authentication passes.

The owned deterministic repeat run failed before capture at bridge startup.
The separate isolated desktop run connected to Live 11.3.43, completed one
read-only agent turn and repeated Refresh without the old error. Its Live
fixture exposed audio-disabled and missing-device conditions, so it does not
qualify listening. All owned App/Live processes were closed. The user's fresh
canonical-listener diagnostic pass and MIDI/audio/Arrangement acceptance remain
pending; neither installation nor these blocked fixtures prove a Session fix.

Capture and runtime stage errors preserve the first rejection through primary
cleanup aggregation rather than substituting a later cancellation error.
Evidence is checked against the owning trace/pass/job. Application ingress
rejections use an internal typed result side-channel, not a producer-controlled
wire field, so their evidence survives fatal connection release while pending
controls reject. This does not bypass ordinary result ownership, sequence,
proof or completion validation. Independently rejected native proofs retain
bounded validated inputs and the frozen expected configuration in History;
malformed messages retain issue codes/paths, never the raw rejected body.

Ingress records `output.listener.rejection.observed` and an explicit
`output.listener.diagnostics.coverage-gap` when native source evidence is
missing. Its rate-limited diagnostic callback reports bounded suppression
counts separately from journal rejection events; callback suppression does not
mean those rejection events were suppressed. Actual persistence and recorder
degradation remain the existing journal's responsibility. No new datastore,
renderer SQL/filesystem access, audio payload, upload path or capture dependency
on journal writes is introduced.

The current work adds source instrumentation and carries these summaries
through the public job, agent result and Desktop's typed History navigation.
An SDK/authenticated-ingress regression exercises native arm-counter
replay after a completed pass and retains the actual counter versus the
previous accepted counter plus one before socket closure. A separate regression
closes/reopens the real resolver-owned journal and verifies that a legacy
string-only preflight rejection is explicitly unavailable rather than invented
native evidence. Neither regression establishes the user's host cause.

A controlled missing-spectrum schedule now drives the shipping native
controller's actual preflight rejection through the shipping SDK, authenticated
TCP ingress, capture, coordinator and public `get-pass` tool result. After the
real resolver-owned journal is closed/reopened, typed History retains the
source-owned `preflight-source-span` check, 48,480 observed versus at most 48,000
native samples, 1,010 ms elapsed versus a 2,000 ms deadline, missing spectrum
and launch not attempted. The test verifies no playback/publication attempt and
one reservation release. These are simulated independent inputs to real source
code, not an actual-host capture or identification of the user's missing
prerequisite. Native runtime publication/cleanup qualification, matched delivery
and human acceptance remain separate gates. Do not request a blind retry or
label this observability work a listening fix.
The isolated real-Electron synthetic failure/lifecycle regression has passed
through preload events and read-only IPC without starting Live. It validates
presentation wiring, not a native source failure or a real listening pass.

## Audio-safe capture work in progress

Native clock and analysis collection now use request-gated low-priority
`qmetro 10` instead of `metro 10`. The initial scheduler-only candidate retained
all validators. The user reported clean ordinary playback with the updated
device both bypassed and enabled; a subsequent capture failed during arming
with `changed_native_clock_hold`. Its trace does not retain the differing clock
fields, so a physical cause has not been established.

Following explicit user approval, ordinary `descriptive` listening now treats
host/DSP timing disagreement as measured information, not an admission or
completion budget. `maxClockDisagreementSamples` remains in the wire contract
as an advisory target for this mode; neither the target nor the measurements
are increased, clamped or relabeled as verified accuracy. Observations retain
the actual clock/beat discrepancies and continue to declare approximate,
descriptive-only timing with no absolute error estimate or verified bound.
Explicit `strict` mode retains its zero-disagreement requirement. This
supersedes historical descriptive-budget rejection descriptions below.

Settings labels the retained preference as a timing target, and Context
details distinguish the descriptive advisory target from a strict acceptance
limit. Actual disagreements remain visible even when larger than the target;
changing the target never claims or enforces an absolute error bound.

Capture duration and complete descriptor coverage still use DSP counters.
Wrong source/owner, changed transport or tempo, malformed DSP data, missing
audio measurements and incomplete coverage remain failures. A duplicate DSP
snapshot whose message-rate fields changed is discarded, not promoted to
timing evidence, when transport state is unchanged and its beat has not
regressed. Mixed or pending clock reads can reacquire until the existing
preflight, arm, launch or capture deadline; they do not refresh clock freshness.
Progress is retained for at most 64 rejected reads per pass to bound diagnostic
volume. Strict/legacy rejection quotas and spectrum/envelope integrity checks
remain unchanged.

This is not a buffering architecture or a claim of frame-exact collection under
load. Compare ordinary capture behavior on the actual host before deciding
whether additional retention changes are necessary.
Idle DSP muting, parent metadata cadence and signal-sink changes are deliberately
excluded so this comparison isolates the scheduler substitution. Existing
capture/disarm/watchdog lifecycle events remain authoritative. Generated-source
changes do not mean the user's loaded device has changed or audible dropouts
have been resolved; the selected bundle must be installed and loaded afresh.

The integrated candidate combines advisory descriptive timing, explicit wire4
mode negotiation and full-active-region Session capture under bridge protocol8.
The shared producer SDK also accepts honest beyond-target descriptive results,
including partial failure observations; strict results retain their exact
acceptance rule. Both timing directions, eight-beat native duration, exact-end
source sealing and cancellation/cleanup are covered at their owning boundaries.
The canonical bundle was rebuilt, verified synthetically and installed after
the user confirmed app closure. Installed wire4 mode metadata and both qmetro
graphs were checked; Desktop was replaced, authenticated and launched. The user
reported crackle-free ordinary playback. One fresh-device eight-beat capture
subsequently completed; two further passes failed as recorded below. Saved Sets
must load a fresh device instance before qualifying newly installed resources.

### Descriptive spectral snapshot coverage

Descriptive ABI2 capture requires the latest complete FFT window for each
published envelope measurement, not every intermediate message-rate snapshot.
Low-priority collection may skip an intermediate FFT snapshot that no published
measurement needs. The existing assembler and independent proof verifier still
require a complete, correctly aligned 2048-sample spectral window ending before
each measurement and less than 2048 samples away. A missing required window,
changed duplicate, backward/off-grid packet or invalid-frame counter change
still fails; no stale substitute, interpolation or fabricated data is accepted.
Strict and legacy capture retain their every-frame sequence requirement.

The first integrated normal-profile attempt failed after 15 measurements:
its FFT counter jumped by 4096 samples, skipping one intermediate snapshot.
The requested range was eight beats at 128 BPM, not four, and no context was
published. Replaying those coordinates reproduces the overly strict rejection;
the corrected descriptive path completes independent coverage checks. The
older recorded five-frame loss still fails because it omits required
measurement coverage. These are synthetic regressions, not a successful retry
of the failed physical pass. The user reported no ordinary-playback crackles.
The corrected `a436fed` candidate was subsequently installed after user-confirmed
app closure (trace `39ba658f-2a7e-4190-8dc6-7956aed6b7e9`). Installed controller
bytes match the source and all integrations report current against the signed
app. On that loaded device, clip-1 pass
`ab097a2f-3181-4869-89b2-452a3ffb5131` completed with 38 measurements and context
`02cc2d12-6b1d-4398-bbb4-b8884e189eb1`. Subsequent clip-2 pass
`6a18c215-1787-46e1-84f7-69ad440c3320` and clip-1 pass
`58fdfc04-1bcc-4926-8991-76b493d53b02` failed `native_fft_window_missing` after
four and three measurements respectively, with no context. Native epochs
1/2/3 and clean reset receipts do not establish an allocation leak. Exact
rejecting FFT coordinates were not retained for those two failures.

### Modular measurement delivery development

The approved next step separates producer-specific measurement calculation from
reusable, owned delivery. Current spectrum and stereo envelope producers need
bounded retention before low-priority snapshots, not another JavaScript queue
after the loss point. One logical output contract permits per-producer FIFO
streams, independent rates and value layouts, and future asynchronous adapters.
It does not require a multi-writer audio-thread queue or arbitrary JSON output.
Actual FluCoMa analyzers and dependency installation remain deferred.

The initial native prototype uses local Gen `Data` for descriptor records, not
audio. Envelope and spectrum capacities are 16 and 32 records. Each reserves
2560 bytes of double-precision record storage, plus small fixed histories.
Selected records remain immutable until acknowledged; the consumer advances its
read request before acknowledging the previous record. Ownership/sequence
bookends identify stale or incoherent reads, and overflow latches an explicit
failure rather than overwriting unread data. Capacity does not extend existing
deadlines or establish tolerable physical scheduler delay.
Version1 record bounds are coordinates in the shared continuously running
native DSP sample counter; a new epoch does not reset that clock. A future
asynchronous adapter must map its known buffer origin into this coordinate
domain, never substitute message-arrival/completion time for source time.

`retained-measurement-source.mjs` generates the reusable primitive.
`retained-native-source.mjs` composes it with the existing envelope/spectrum
calculations and emits separate prototype documents; it does **not** select
those documents without matching versioned graph selection. Executable Gen-subset tests compare actual
producer outputs, preserve counters beyond float32 precision, retain earlier
FFT frames across delayed reads, and preserve full/fractional envelope windows.
Those tests are not a Max compiler, native readback or performance certificate.
The isolated native primitive gate passed on Live Suite 11.3.43
(`2025-10-06_b466d4f56c`) / Max 8.5.8: actual Gen compilation, FIFO recovery
after a reader pause, exact `16777217` counter retention, immutable unread
records, overflow/control-fault latching and epoch reset. Both complete native
producer compositions compiled with the 30-/20-value readback rows. This
qualifies the storage/readback primitive, not integrated listening, accuracy or
audio performance. Only runner-owned hosts were closed; user processes were
not adopted or stopped.

Production integration is in progress for wire4 only. Its graph and reader
explicitly select private `retention-v1`; the existing native ABI2 and public
observation formats remain unchanged. Each attempted arm reserves a fresh epoch
before initializing either queue, including attempts that fail preflight.
Actual coherent matching-epoch readbacks from **both** producers are required
before configuration/arming. A JavaScript constructor or lifecycle event is not
native readiness. Missing/mixed support fails explicitly, without fallback to
latest-only measurements. Wire1/2/3 retain their historical graphs and behavior.
The retained wire4 producer also advertises `audio-listener/retention-v1`.
Its endpoint must negotiate that feature before registration/arming, so an
older app cannot first discover unsupported measurement lifecycle phases after
playback has been authorized. Legacy single-capability producers remain usable
against an updated endpoint.

The low-priority selected-slot adapter accepts one settled record per two polls,
with independent envelope/spectrum scheduling. Latest envelope snapshots remain
on the control path for reset/launch receipts; they cannot provide measurement
coverage. Required spectral/envelope records still pass through the existing
assembler and independent proofs. New `measurement` lifecycle phases distinguish
collection progress/completion from completion of the overall listening pass.
Bounded `native-measurement-delivery-rejection/v1` failures retain stream identity,
expected/produced/acknowledged sequence, capacity, high-water mark and fault code.
Queue overflow means descriptor-delivery backpressure, not a claim of audio
clipping or a musical spectral change.
Retained native preflight timeout/stale-span failures emit at most sixteen
attributed progress reasons before cleanup, identifying missing/stale metadata,
producer readiness and control-state prerequisites, plus actual clock-span
coordinates. These bounded lifecycle reasons diagnose admission without
changing its deadlines, guards, failure result or capture authority.
The modular candidate was installed for explicitly approved manual evaluation
under trace `4b4ba604-7464-43e5-8252-faa47f0aa869`, preserving the default
profile's preferences, session registries and credentials. Installed payload
inventory, signature and production authentication matched the tested package.
This is installation evidence, not physical qualification. On that same loaded
instance, clip-2 pass `77d6bc40-f93d-4371-bbb9-f5a46bd5e71f` failed
`host_sample_discontinuity`; subsequent clip-1 pass
`83606312-3497-447d-a1af-5d5f50298a5b` failed
`stale_native_preflight_native_stop_ack_timeout_unconfirmed`. Neither published a
context. The combined latter error does not prove that a prior epoch leaked.

A deterministic controller reproduction at both supported sample rates showed
that valid retained descriptors could fail the old current-host-versus-record
comparison after delivery lagged the live clock. Retained descriptors now use
the independently bracketed native counter projected through the fixed launch
host offset, with a causal, declared-envelope-capacity-times-hop delivery bound.
They keep their original source coordinates; arrival time never becomes a
measurement timestamp. Future records, excess backlog and missing clock evidence
fail explicitly. The rejection lifecycle retains bounded clock operands and
caller attribution. Independent host timing, strict policy, freshness, complete
coverage, postchecks and existing deadlines still apply; legacy latest-only
ingestion is unchanged. This source correction is not a claim that either manual
failure, the failed-pass reset path or repeated real-host capture is qualified.

Failed-pass stop cleanup now claims its stopping state before terminal
callbacks and fences every remaining effect to its generation and reader
queue. Reentrant stop/terminal callbacks cannot clear or send errors for a
replacement generation; late configure/arm calls and remaining setters cannot
reactivate a stopping owner. The stop receipt still requires executed reset
controls followed by an epoch-zero, inactive ABI2 envelope.
Gen clears its configuration seal on epoch-zero reset. If the pre-stop seal
was never read, an independently read matching native epoch, all five unchanged
configuration parameters and zero seal can establish that reset instead;
wrong epochs/settings and an arm that never executed remain unconfirmed.
The shipping Gen-expression model covers failed-generation cleanup followed by
fresh-generation delivery at both sample rates, without retry or transport
mutation. Pre-arm stopping without configuration is separately covered and
was not a reproduced defect in the original implementation. These deterministic
fixes do not establish the exact cause of the manual stale-preflight failure.

The first owned-host rerun with these fixes completed a four-beat capture:
48 kHz, 96,000 stereo frames, twenty envelope/spectral windows, accepted native
and source proofs, and one durable context. Its reviewed fixture baseline then
failed the old synchronous `tracks.mutate stop-clips` check. Independent failure
reads showed both source clips stopped, slot index `-2` and no queued launch,
confirming that Live settled the command after that immediate check. The
Remote Script now dispatches once and verifies on the next Live tick, preserving
identity guards and explicit unconfirmed failure. No capture retry, baseline
permission expansion or production transport cleanup was added.
A subsequent fresh owned-host run instead failed spectrum delivery with
epoch1/expected38/produced37/acknowledged36/capacity32/high-water1/fault3 before
source launch. At that checkpoint the exact reader cause and row were still
unavailable, repeated qualification remained open, and the source correction
was not installed in the normal app/listener. The Remote Script alone had been
installed through the
canonical integration CLI with its authentication credential preserved.

The existing `native-measurement-delivery-rejection/v1` diagnostic now optionally
preserves a fixed `readerReason` and up to three oldest-to-current descriptor
readbacks. Each retains its actual length and at most thirty finite numbers or
fixed invalid markers; arbitrary strings, objects and audio are excluded.
Both optional fields occur together and survive the typed runtime, SDK and
history boundaries. A numeric-only private packet arrives before the unchanged
failure packets; the controller validates its exact encoding and latches only
the first matching generation, epoch and family. Evidence cannot advance
preflight, drain capture, alter reader guards or replace native stop proof.
Wire4, ABI2, source-counter invariants and legacy diagnostic shapes are unchanged.
Deterministic delayed-ACK replay reproduces the coarse counters with
`invalid_sequence_order`, but is not proof of the actual host cause.

A fresh instrumented owned-host run on Live 11.3.43 identified the actual
rejection as `torn_readback`, not overflow or the speculative old-page replay.
Pass `cb766fe4-87af-465f-a592-a24b6222e45c` failed before source launch.
Its spectrum readback began with requested/slot sequence 21 but ended with
slot/request sequence 22; the sampled row combined two producer updates.
The preceding two rows were identical sequence-21 pages, with capacity 32 and
high-water mark 1. Channel-by-channel signal sampling therefore does not
guarantee a coherent descriptor row even though the retained slot is immutable.
The reader now discards unstable acquisition without consuming or
acknowledging it, advancing accepted counters or refreshing readiness/source
freshness. It breaks consecutive settlement while preserving immutable
fingerprints, then requires two coherent matching descriptor reads. Bounded
generation/epoch-owned progress is descriptor-free and throttled to 250 ms per
family. Existing deadlines, malformed-bound checks and coherent corruption,
owner and overflow failures remain enforced. Internal partial collection/stop
cleanup uses `failed` while the public partial result and original reason stay
unchanged; an incomplete observation never becomes a completed context.

Post-correction host runs completed the first capture. A fixture baseline then
exposed the same premature verification problem for stopped transport seek;
independent reads proved beat zero and stopped transport after the error.
Stopped seeks now dispatch once and verify next tick with Song identity and
stopped-state checks, without a compensating rewrite. A fresh run verified the
entire reviewed baseline, then failed second-generation preflight on
`invalid_uninitialized_readback`: an all-zero inactive epoch-zero page retained
the prior bounded request sequence 144 in both bookends. No second context
was published. The reader now recognizes a coherent all-zero inactive page
with matching bounded request bookends as non-authoritative waiting, including
request 144. Dirty inactive data, malformed bounds, post-ownership reset and
active corruption remain rejected; persistent inactivity still times out.

The next host reached second-pass publication and exposed a separate immutable
track-subject collision: IDs covered only part of the stored binding. Track
and Arrangement subject IDs now include the complete sanitized binding snapshot,
including routing uncertainty, playback evidence and semantic name. Changed
evidence creates a new subject instead of overwriting history; identical
snapshots remain reusable. The repository's overwrite prohibition is unchanged.
The verifier also canonicalizes clip inventory order by exact target before
comparing all identities, intervals and settings: Live lists the playing
Session clip first, so launching scene 1 legitimately reorders that inventory.
Actual clip/setting mutations still fail the same binding postcondition.

The corrected candidate passed clip-1 -> clip-2 -> clip-1 on the same loaded
instance twice on fresh owned Live Suite 11.3.43 hosts, first as scenario run
`56f38478-21f0-4645-8779-42a7ec524f7a`, then as owning-group run
`88ebffa7-2af3-45f2-a7d1-166182fe9c45`. Each produced three distinct completed
contexts at native epochs 1, 2 and 3; each four-beat capture contained 96,000
stereo frames and twenty envelope/spectral windows at 48 kHz. Independent native
and source postconditions, both reviewed fixture-only resets and preservation
of prior contexts passed. All owned hosts and disposable fixtures closed.
The adjacent wire4 Session scenario also passed. The broader dual-mode group
stopped at Arrangement fixture admission because the Operator's dependency
inventory is incomplete; its guard was not weakened.
These are bounded descriptive Session results, not sample-accurate source
identity, exclusive attribution, a 44.1 kHz host result or a general native
qualification certificate.

The corrected package also completed one visible, ordinary-approval Desktop
workflow through `send_user_message`. Message
`2b6f91e5-07cf-461d-97f1-1b4505c72bbe` appeared once, the exact listening
approval was accepted once, and the turn returned to Ready with pass
`747d12f4-eafe-4cc4-a0e3-8f9170e3305c` and durable context
`5a49f69b-a8de-4ea9-a5f2-f1d54ac6ffdb`. Typed history independently recorded
completed listening/publication; Live showed the requested clip and transport
still running. No capture retry or auto-approval was used. Both owned apps
closed and the isolated profile/credentials were removed after typed evidence
extraction; the user's Set and unowned Max process were untouched.

The normal signed app and matching canonical listener were then updated under
installation trace `182d19a2-9847-4b84-9362-dc4f9723e1ee`. Exact installed
app.asar and reader/IO/controller/engine bytes match the tested package and
sources. Production authentication passed; preferences, sessions, project
registry, credentials and the already-corrected Remote Script stayed unchanged.
No rollback copies were retained. Apps were left closed. A fresh listener
insertion is required in the user's Set to avoid testing an already-loaded old
Max instance; that user-Set check remains separate from the owned-host results.

The shared classic-JS/Node reader and protocol declarations use the same bounded
record format. It settles an immutable selected slot before consumption and
returns ordered request/acknowledgement actions; the caller retains scheduling
and deadline ownership. Classic-Max IO and included reader sources must parse
as ES5, not merely execute in a modern Node VM. Their formatting overrides
exclude post-ES5 function-call trailing commas, and strict parser regressions
cover both scripts before the existing include/handler interoperability checks.
The helper also supports classic Max's CommonJS1 `exports` object separately
from Node's `module.exports`; a successful `require` is not proof that the
returned object exposes the reader API. Regression coverage exercises all
three loading paths: classic require, classic include, and Node require.
This first selected-slot prototype targets the current
producer rates, not unlimited throughput. A future higher-rate analyzer needs
an admitted publication cadence or a qualified batch adapter behind the same
contract, not an assumption that increasing queue capacity fixes sustained
under-consumption.

Missing required-window failures now retain `native-coverage-rejection/v1`
coordinates before assembler cleanup: expected envelope, required/available/
latest spectral intervals, native owner and completed-measurement count. The
existing runtime, authenticated SDK, ingress and typed terminal history accept
the bounded diagnostic; the failure reason and no-context behavior are unchanged.
Historical failures without this evidence remain without it.

The extension keeps current observation/context schemas, source attribution,
independent coverage proofs, strict/legacy behavior and leave-running cleanup.
Future analyzers will declare their units, dimensions, timing and limits and
provide an explicit typed result mapping; they will not silently add unknown
fields to existing historical contexts. Retention is transient memory only;
existing context/journal ownership and the shared storage resolver remain
unchanged. Overflow or missing required data still means a failed pass, not a
saved partial result or an automatic retry.

## Full-active-region Session listening

`play-session-and-listen` now defaults to one active loop for looping MIDI or
warped-audio clips, not the complete underlying file. For nonlooping clips it
uses the active start/end region. `durationBeats` is optional; an explicit
positive duration may be shorter than or equal to that region, including four
beats on an exactly four-beat clip. Admission still requires zero start/loop
offsets, stopped transport at beat zero, Global None with clip Global, Trigger
mode, legato off, 4/4, known recording-off and one exact same-track listener.
Quantized launches and nonzero offsets remain deferred.

There is no four-beat ceiling. Frozen metadata resolves the requested duration
before arming; native geometry must fit thirty seconds and 300 windows.
Oversized full loops fail without launching or silently truncating. Native
endpoints retain nearest-sample rounding, including fractional final windows;
only the unavoidable half-sample tail may cross the nominal active boundary.

An independently observed original source epoch remains immutable. Early wrap,
stop, retrigger, source replacement and settings edits invalidate capture.
A normal wrap or supported natural end at/after the requested interval can
produce a message-rate `covered` source receipt, but that is not completion:
publication also requires the exact completed native DSP interval/proof and a
fresh fingerprint/identity seal. Transport stop is never waived. Monitoring
and native cleanup remain generation-owned, traced, bounded, cancellable and
leave-running; no seek, transport ownership or timing-policy change is added.

These expanded boundaries have deterministic regression coverage, not fresh
physical qualification. Fresh runner-owned Real-Live smoke and visible UX reruns
remain pending; no user process is adopted or closed by automation. Installation
and synthetic acceptance do not qualify physical capture. The historical MVP evidence below
only qualifies its original four-beat-before-eight-beat-end cases.
The new `covered` output status requires bridge protocol 8. A protocol-7 Remote
Script must fail the handshake explicitly, not silently downgrade this behavior;
app and Remote Script must be rebuilt together before a fresh owned-host run.

## Historical Session MVP (#63)

The MVP sends MIDI rendered through its instrument chain and warped audio
through the same native audio listener. Both kinds now pass their isolated
runner-owned scenarios and the owning Session group on Live 11.3.43, without
relabeling Arrangement transport-start evidence. Demonstrated acceptance is
limited to stopped beat zero, Global None with clip Global, 120 BPM/4/4,
48 kHz/vector 64, and clip-local beats 0-4 strictly before the eight-beat end.
It does not qualify physical clip identity, sample-accurate source continuity,
absolute timing, other launch cases, or a general native-device rollout.

The development PR closes #63 for this bounded MVP, not for universal Session
support or completed physical commissioning. Remaining work is explicitly
handed off: #67 owns runner graceful shutdown, #68 the interrupted non-native
regression sweep, #69 immutable legacy v1/v2 fixtures and physical reruns, and
#70 the staged Session expansion roadmap. These follow-ups preserve unrun and
failed evidence; they do not waive code review, CI, identity/timing guards or
ordinary approvals for the feature PR.

Pre-PR branch review found and corrected an immutable clip-subject collision on
subsequent captures with different durations or upstream processing. Real-store
regressions reproduce the old failure and now preserve earlier history while
reusing identical snapshots. The reviewed candidate passes full build/quality
with 3,026 TypeScript/script, 672 Max and 271 Python tests, all twelve Electron
tests, and both real Session cases again (`2026-10-24T16-16-54.285Z`). Both native
runs independently verify leave-running idle/released resources, unchanged
source scope and successful exact-owned process/fixture cleanup; no Live process
remains. These results do not complete the separately tracked broader/legacy
coverage or change the descriptive timing limitations.

`listening.inspect_session_source` is an additive, read-only diagnostic, not an
agent listening tool or a readiness certificate. It resolves an exact regular
track/slot/clip identity before and after bounded LOM reads. Its versioned result
echoes the query/target and reports separate `before`/`after` source states,
signed `startTimeBeats`, playing/queued slot identities, clip kind, position
units, tempo, launch settings and markers. MIDI and warped audio use beats;
unwarped audio uses seconds for diagnosis only. Unknown metadata stays `null`,
including follow-action state. Deferred readings are not an atomic snapshot,
launch receipt, sample timestamp, continuity seal or proof that this target
owns a reported `start_time`. Another clip on the track can own that value.
The bridge rejects a response whose query or exact target does not match.

A fresh, runner-owned Live Suite **11.3.43** / Remote Script **0.7.0** process
returned valid diagnostics for 13 Session clips, including both MIDI and warped
audio, without changing the Session snapshot or starting playback. The queried
`follow_action_enabled` property supplied no usable boolean for any of them.
This is not evidence that follow actions are disabled. The MVP policy is now
to reject known-enabled follow actions and retain unknown settings explicitly,
with a pass-owned message-rate source monitor that invalidates observed source
changes. Changes between deferred observations may remain undetected: neither
the result nor the UI may claim guaranteed/sample-accurate source continuity or
independently verified disabled follow actions. This is an explicit limitation,
not a `null`-to-`false` safety default. These diagnostic reads alone did not
establish a safe launch fixture or capture; bounded real-host evidence follows
below and does not promote physical clip-onset accuracy.
Private evidence is in
`.test-artifacts/session-source-probe-6cb5d181-9830-4104-afe9-30a9e1a55d82/evidence.json`;
the matching bounded, redacted lifecycle/bridge journal uses the storage
resolver's isolated `automation` profile beneath that diagnostic directory.

The diagnostic reuses existing read-only request serialization, timeout,
queued/dispatched/completed/failed/cancelled events, and trace/correlation/
causation propagation. It does not persist an audio observation, add a context
kind, change storage ownership, fire clips, edit launch settings, stop transport
or broaden existing Arrangement support.

### Canonical Development dual-mode negotiation

The canonical **Machine-Listening-Development.amxd** package can now select
wire **4** (`build-native-authored --native-version 4`). It advertises exactly
`audio-listener/dual-mode-v1`, native status scope
`mode-negotiated-transport/v1`, and ordered `supportedModes:
["arrangement", "session"]`. ABI **2**, algorithm **2.0.0**, the measurement
graph, bounded resources and raw `audio-observation/v2` descriptors are shared.
There is one Development filename and one recorder/runtime, not separate
Arrangement and Session device variants. The authored source template remains
immutable; packaging selects `audio_listener_native_v4_max.js` and guard 4.
Manifest admission requires `nativeVersion: 4`, `nativeAbiVersion: 2`,
`modeNegotiation: "explicit-per-pass"` and the exact supported-mode list.

Every wire4 control, reply and result carries an explicit `mode`. Prepare
freezes that mode and the immutable mode-specific configuration for the owned
connection/job/pass/trace. Arm, cancellation, progress and terminal evidence
must match it; absent/unknown modes, unsupported versions and mismatched or mixed
proofs are denied, never downgraded. Arrangement still requires its unwrapped
`arrangement-descriptive/v2` arm/launch/completion chain, guarded positioning
and independent Arrangement source checks. Session still requires exact
`session-transport-coupled/v1` wrappers with frozen expected source context,
plus the independent source/origin join before publication. A wrapper is not
clip-identity evidence, and its inner ABI2 transport scope is not an Arrangement
pass. Wire1/2/3 keep their original contracts and selection behavior.

Mode negotiation uses the existing traced prepare/arm/capture/cancel lifecycle,
timing and redacted History paths; it adds no storage, buffering or idle-DSP
architecture. Reconnect invalidates the old generation and cannot silently
reuse its selected mode or source. Only fresh prepare can choose another mode.
The runner-owned `native-listening-dual` group exercises Arrangement and Session
against the same hash-pinned wire4 artifact through
`--native-v4-fixture-input`; terminal verification independently checks exact
wire version, explicit mode, coverage and the original mode-specific proof.
Deterministic SDK/native/ingress/application/package regressions do not qualify
physical Live behavior. No new Live/UI run or installation was performed while
the user's Live and Desktop processes were active; physical qualification and
the combined descriptive-jitter regression after the separate timing change
remain integration gates.

The implementation now composes the existing owned coordinator with guarded
Session source leases and explicitly negotiated listener wire version 3.
Wire 3 uses native ABI/DSP 2 and raw `audio-observation/v2` descriptors, wrapping
the unchanged v2 transport proofs in `session-transport-coupled/v1`; it does not
turn native transport onset into a clip-onset assertion. Before publication the
application independently joins the exact active clip's observed `start_time`
to its frozen stopped transport anchor. Mismatch, source invalidation,
incomplete native coverage or cleanup failure prevents successful publication.

Source-pass capability and result disclosures retain the existing 256-character
per-limitation bound without dropping their polling and uncertainty claims.
Validate actual emitted capability metadata, not only generated examples:
an oversized Session disclosure prevents bridge readiness even when no Session
capture is requested.

Fresh-host capability smoke now passes on Live 11.3.43 after that correction.
The first pinned Session MIDI attempt then stopped before listener registration,
approval, launch or capture. Live's Max 8.5.8 bundles Node 16.6.0, which does not
provide `Object.hasOwn`; the new Session SDK registration and source-freezing
guards must use `Object.prototype.hasOwnProperty.call`, as existing SDK guards
already do. Regressions reproduce both failures with the newer API unavailable
and pass after correction; SDK construction also passes under the actual bundled
Node executable. This is startup compatibility evidence, not a successful
Session capture. Preserve the failed immutable package and use a separately
packaged, normally saved fixture for the next physical attempt.

The separately packaged correction and normally saved fixture pass strict
device/media-reference admission, preserve the earlier Set, and register the
wire-3 listeners in fresh Live 11.3.43. Retry `ea824c61` then refuses at the
aggregate stopped-native preflight, before approval, jobs, launch or capture;
owned-process cleanup completes. Its Operator has 195 parameters, exceeding
the deliberately bounded 16-parameter inspection and therefore producing
incomplete dependency evidence. The distinction between that uncertainty and
actual source-safety failure was a qualification gate, not permission
to fabricate complete attribution or relax recording/identity checks.

The runner-only correction separates those conditions: Arrangement retains its
dependency-completeness requirement, while nonexclusive Session capture may
retain a truncated, unknown dependency fingerprint. All stopped transport,
recording, enabled-device, exact identity/path, complete clip inventory and
independent Session source/native-geometry guards remain required. The request
still uses `maxParameters: 16`; the existing separate bounded fixture-content
read checks all 195 Operator parameters before/after capture without increasing
its established budget. This is a synthetic regression correction, not a new
physical attempt or a reclassification of `ea824c61`.

Normal runner results now retain bounded, redacted `preflight` evidence:
named checks/failed checks, inspected transport/recording scalars, exact target
identity/path summary, query limits and incomplete/unknown/nonexclusive quality.
The traced/timed `stopped-preflight` lifecycle records the same allowlisted
evidence. Raw responses, parameter bodies and audio bodies are not dumped.
Refusals name the precise failed guard; missing recording or target evidence
fails closed rather than being discarded with an aggregate error.

The current deterministic quality gates pass 2,978 TypeScript, 672 Max and
270 Python tests. All twelve owning Electron tests also pass, including explicit
wire-3/Session capability discovery without exposed credentials, synthetic
lifecycle presentation and typed three-kind context retrieval across restart.
Those checks do not establish actual Session launch, native capture or visual
acceptance of the real workflow.

Subsequent real-host MIDI (`2026-10-24T03-53-13.302Z`) and warped-audio
(`2026-10-24T03-54-17.285Z`) scenarios pass, followed by the complete Session
group (`2026-10-24T03-57-38.579Z`). Each independently accepts the source/native
origin join, 96,000 stereo frames, twenty envelope/spectral windows, unchanged
bounded content and unselected scope, canonical associations, typed store reopen,
one persisted context and leave-running idle cleanup. Source continuity remains
message-rate monitored, follow actions remain unknown, and alignment is
approximate. All nineteen remaining non-native scenarios also qualify across
nine owned groups: fifteen pass and four recovered-pass
(`2026-10-24T04-00-31.972Z`). Fresh legacy native-v1/v2 fixture inputs are not
present in this worktree; those separate groups are not claimed as rerun.

The actual CLI admits the Session native group before build, installation,
credential access or process inspection. Native unsafe flags and missing
version-specific inputs cannot bypass that existing admission boundary.
A CLI regression reproduces the former credential-read precedence and passes
with Session included; the owning script suite passes 821 tests.

Visible ordinary approval additionally discloses Session launch/transport,
all-outcome leave-running, possible resumption of other selected sources and
accepted-launch cancellation limits before execution. Long argument identities
wrap inside the inspector. A denied visible request does not launch or measure.
The main regression reproduces the missing disclosure before correction; React
checks typed preload presentation and exact decisions without main/tool imports.
All twelve owning Electron tests cover the corrected main/preload-rendered preview,
exact decisions and unclipped identities without weakening approval policy.

The visible Default-agent MIDI pass `9ff60019` publishes context `465b1e7a`
through ordinary approval. After fully closing and restarting both applications
with the same isolated profile, read-only retrieval and Outputs retain that
context's original pass/entry IDs, local/global bounds, native sample bounds
and descriptors. Previous Live references remain historical and freshness/
attribution remain unknown; no recapture or current-source identity is inferred.
The subsequent visible warped-audio pass `6e3559a9` publishes context `4a107d61`
with local/global 0-4, 96,000 frames, approximate timing and the same limitations.
Outputs reports completed in 11.43 seconds and verified launch; Live visibly plays
only the target audio clip. Both exact-owned apps close, the owned host stops,
and the immutable staged Set retains its pinned hash.

The portable production producer SDK explicitly negotiates wire 3 through
`audio-listener/session-v1` and raw `audio-observation/v2`; neither missing
advertisement nor a v2-only endpoint permits fallback. Its exact v3 registration
requires the Session scope, ABI 2, bounded capability/readiness metadata and
`sourceEvidence: "expected-context-only"`. Prepare clones and deeply freezes the
bounded target/source, geometry and timing policy. V3 controls and replies retain
exact action/version/owner/request identity; stale or replayed controls cannot
release a replacement reservation. Results require the explicit Session
arm/launch/capture wrappers, matching expected source, unchanged v2 transport
scope, bounded native tuples/windows, raw descriptor shape and Session lifecycle
scope. Native completeness/alignment mathematics remain independently validated
by typed ingress; the SDK's shape/stage guards are not physical evidence.
The existing 128 KiB frame ceiling, no offline-audio replay, write-drain deadlines,
ACK sequencing, redacted failures and traced backpressure lifecycle also apply
to v3. V1/V2 behavior and packaging are unchanged. Loopback production-SDK,
typed-ingress and native-runtime fixtures verify these boundaries synthetically
at 44.1/48 kHz, including failure and owned cancellation; they do not qualify Live.

Requests select one exact regular-track clip and one independently bound native
listener on that track, with a default/maximum four-beat first-iteration range.
MIDI uses the existing instrument chain; warped audio uses the same audio DSP.
Unwarped audio, nonzero clip start/loop offsets, legato, non-Trigger launch,
known-enabled follow actions and running/recording transport are denied.
The nominal and sample-rounded capture must finish **strictly before both the
first loop boundary and natural end**, including nonlooping clips; no implicit
shortening or source-setting repair is allowed. Production admission accepts
only Global None from stopped beat zero. One-bar Global launch and every
nonzero stopped anchor, including bar boundaries, fail with
`session_launch_case_unqualified` before quota/source/native acquisition or
launch. The app never seeks or changes quantization to make them pass. Lower
contracts retain candidate coordinate shapes for future qualification, not
authority to advertise or execute those cases through agent tools. Source,
real shared-host and scoped-tool regressions fail before this restriction and
pass afterward, including failure trace attribution and zero publication.

After that restriction, the Session group passes again
(`2026-10-24T13-50-12.141Z`): both cases retain independently accepted native/
source evidence, exact coverage/context and owned cleanup. The complete
deterministic quality command passes 3,021 TypeScript/script tests, 672 Max tests
and 270 Python tests, plus formatting/lint/docs/contracts/compatibility/
typechecks; all twelve Electron tests pass against the final build.

Fresh visible acceptance on the final source also completes a single ordinary-
approval warped-audio request: pass `07fce696`, context `e8023531`, completed in
10.76 seconds. The one submitted message, completed reply, ready composer,
stored Outputs/detail and separately inspected Live target agree. Native samples
8,490,561-8,586,561 cover exactly 96,000 frames; observed clock/beat disagreement
is 0/64 samples under the unchanged descriptive64 budget, not an absolute error
bound. Unknown attribution/freshness/follow state and message-rate continuity
remain visible. Both final owned apps close with explicit user approval for
stopping test playback, the exact host stops, and staged/original saved Sets
and the recovered listener-free base retain their pins. The runner's overall
host qualification remains `unqualified`; these bounded passes do not certify
the broader device, physical timing or release matrix.

The pre-repair broader regression sweep (`2026-10-24T13-52-18.415Z`) is **not green**:
eleven pass and four recovered-pass before `piano-and-string-bass` fails.
Its piano load supplied an expected Browser URI containing `&amp;` while Live
independently returned `&`, causing `stale_reference`; its subsequent retry was
denied by the unchanged manifest guard. Two validation tracks and the bass load
had executed in the dedicated disposable Set; exact-owned discard/exit cleanup
passes. The run stops there, leaving the remaining three scenarios unrun.
This separate Browser argument/guard failure is retained, not hidden by the
earlier nineteen-case acceptance or repaired by changing Session scope, Browser
identity checks, retry rules or approval budgets.

The Browser argument defect is subsequently corrected at the agent-facing
handoff, not by accepting rewritten identities. Shared full/scoped tool and URI
field guidance plus the post-result hook require opaque copying from parsed
results. Three new guidance regressions fail before the correction and pass
afterward; Python confirms rewritten URIs still refuse before loading and the
exact URI succeeds. Full quality passes 3,024 TypeScript/script, 672 Max and 271
Python tests. The unchanged piano scenario and instruments group both pass
(`2026-10-24T15-26-46.131Z`, `2026-10-24T15-28-10.747Z`), with literal `&`, exact
final devices and successful owned cleanup.

The latest broader run (`2026-10-24T15-29-16.545Z`) again stops, but **not on the
Browser operation**: eleven pass/five recovered-pass, including piano and bass,
then the instruments group's graceful Live shutdown times out. The failed
cleanup event remains a failure; subsequent exact-owned discard succeeds and
PID 5272 is independently confirmed exited. Three later cases remain unrun.
Broader fresh-head acceptance remains blocked by that separate shutdown failure
and the absent legacy native physical inputs, not the corrected URI handoff.

Session `maximumDurationMs` is a monotonic overall budget from acceptance,
including preparation, source launch, capture and publication. Queued work
cancelled before bridge dispatch cannot fire. A dispatched/accepted launch
cannot be retracted: all terminal outcomes leave transport and source selection
unchanged by cleanup. Other already selected Session sources may resume when
transport starts. Local monitors and native capture have bounded independent
cleanup; unconfirmed cleanup is a visible failure.

Typed lifecycle jobs optionally retain bounded, redacted Session clip/track
names, scene, requested local duration and separate launch
`requested`/`queued`/`observed`/`verified`/`indeterminate` detail with host mutation
state. These are progress, not stored audio or timing certification. The same
strict shape reaches tools, main/preload IPC, read-only inventory and Outputs.
Stored `session-audio-observation/v1` uses local first-iteration beats while
preserving native sample indices and separate global transport coordinates;
one clip-primary and canonical track-contributor transaction uses the existing
session-owned context database. Historical retrieval is distinct from binding
those connection-scoped Live references to a current source.
Clip subject IDs cover the full immutable binding snapshot and canonical track
association, not only source settings. Repeated captures with a changed duration
or upstream processing therefore publish distinct snapshots without overwriting
the earlier observation; unchanged snapshots remain reusable. Real-store runtime
regressions reproduce both immutable-binding conflicts before correction.
Track and Arrangement subject IDs likewise include their entire sanitized
binding snapshot. Routing uncertainty, playback evidence or semantic-name
changes cannot reuse an ID with different immutable content; unchanged
snapshots remain reusable without altering older subject or observation rows.

The existing deterministic runner admits reviewed `native-session-midi` and
`native-session-warped-audio` cases only with an explicitly pinned wire-3 fixture
input. It copies the immutable Set/candidate/resources rather than authoring or
repairing them; the candidate manifest must retain ABI 2, raw v2 descriptors and
expected-context-only source evidence. Inspected `sessionSources[kind]` selectors
bind the exact clip and its one same-track listener. Before capture the runner
freezes source settings, global transport geometry and descriptive timing policy.
Session WAV references must resolve to the copied, pinned project resources,
not mutable legacy absolute originals. A post-capture integrity stage rechecks
original/copy Set, candidate/resource inventories, discovery and WAV hashes.
The actor may inspect once, launch that clip once for four beats/30,000 ms, get
its owned pass once, then optionally read completed historical context; denial
does not permit correction, retry, Arrangement playback or any other mutation.

Independent verification joins unchanged native-v2 transport proof inside the
wire-3 wrapper with bounded source-driver receipts observed before publication.
It checks the actual active source epoch against the frozen global origin,
local descriptor mapping without changing DSP sample indices, distinct local
clip/global track coverage, unknown attribution/freshness and real typed store
close/reopen. Session clip/track associations use the canonical contributor
subject ID; its `previousRuntimeBindings` separately binds the exact inspected
Live track reference. Canonical IDs must not be compared directly to Live UUIDs.
The first completed MIDI capture (`232754af`, context `ce7f8e20`) retained correct
unknown attribution/freshness, but the old verifier made that identity comparison
and refused qualification. Typed reads on a disposable store copy identified the
harness assumption; the original failed evidence remains unchanged. The narrow
association regression corrects verification without a new Live retry or a
qualification claim. Complete bounded reads compare MIDI notes, audio/warp metadata,
device parameters, source settings and unselected scope before/after capture;
truncated or unavailable critical content fails rather than proving equality.
A later leave-running loop epoch is never substituted for the sealed
pre-publication origin; this does not admit capture across a first-loop boundary.
Every new read/source stage uses the existing traced/timed runner lifecycle.
Synthetic composition tests are not physical qualification: the result retains
`qualificationStatus: "unqualified"` and explicitly does not claim physically
proven clip identity. Actual fixture/native launch geometry, delayed delivery,
first-window retention and supported Live 11 behavior remain separate host gates.

## Development milestone and follow-ups

On 2026-10-21 the developer approved treating this branch as a development
milestone, with known investigations tracked separately rather than requiring
release certification before merge. The delivered scope is bounded, on-demand,
constant-tempo Arrangement listening with native measurements, typed durable
range/track context, ordinary approvals and restart retrieval. It is not Session
listening, exclusive clip attribution, verified tempo stability or physical
timing certification. Review findings, regression tests and CI remain merge
checks; the further qualification below is explicitly follow-up work.

| Follow-up | Scope |
| --- | --- |
| [#55](https://github.com/CooperNederhood/Ableton-Agent-App/issues/55) | Independently detect tempo changes; current constant-tempo assumption remains explicit. |
| [#56](https://github.com/CooperNederhood/Ableton-Agent-App/issues/56) | Advertise existing transport start/stop, tempo and loop actions clearly to the agent. |
| [#57](https://github.com/CooperNederhood/Ableton-Agent-App/issues/57) | Diagnose the historical unknown Arrangement-source validation tri-state without weakening the guard. |
| [#58](https://github.com/CooperNederhood/Ableton-Agent-App/issues/58) | Reproduce and resolve listener placement/rebinding failure after device-chain edits. |
| [#59](https://github.com/CooperNederhood/Ableton-Agent-App/issues/59) | Extend controlled-edit/recovery and immutable fresh-process packaged qualification. |
| [#60](https://github.com/CooperNederhood/Ableton-Agent-App/issues/60) | Replace obsolete capture-disabled wording in the saved M4L device without changing DSP behavior. |
| [#62](https://github.com/CooperNederhood/Ableton-Agent-App/issues/62) | Close immutable-fixture admission gaps for externally referenced WAVs; current qualification covers project-relative copied inputs only. |

The evidence below is retained with its original scope. Deferred qualification
is not relabelled passed, and historical receipts do not certify a changed
candidate. Real-Live validation used installed Suite 11.3.43 on Apple Silicon,
the current development host. Support targets Live 11, not one patch version;
record actual versions after automatic updates without requiring an older patch.

### Milestone branch review

Scoped independent reviews covered native/device resources, protocol/bridge/
Remote Script, Desktop/CLI, and runtime/storage/runner; parent review covered
application/tools and documentation/CI. The external-WAV admission finding is
explicitly deferred above, with qualification limited to demonstrated copied
project-relative inputs.

The merge preparation fixed a false-green CI pipeline that let `tee` hide native
test failures, explicit Node 20 TS loading and supported source-resolution hooks,
and two test-only synchronization/process-identity defects. Restoration is still
published only after persistence settles; CLI SIGINT targets the actual Node
process. Deterministic regressions cover original failures, async resolver error
propagation, plain-Node calibration commands and owned child cleanup. Native DSP,
timing tolerances and qualified resource bytes are unchanged by these corrections.

The final local `pnpm check` passes build, formatting, lint, types, documentation,
contracts and all 2,235 TypeScript, 631 Max and 212 Python tests. Separate pinned
Node 20.20.2 runs also pass all 2,235 TypeScript and 631 Max tests with zero skips.
Hosted checks on the final PR revision remain a separate merge gate; earlier
green status that masked native failures is not accepted as validation.

## Current target: developer dogfood

The signed arm64 candidate built from `9941556` previously passed three consecutive
natural Default-agent packaged workflows with fresh isolated App/Live processes,
ordinary approvals and no actor failures, corrections or recaptures. Each
84,000-sample/18-window observation survives full App restart and production
renderer/preload/main retrieval with unchanged IDs/payload. Source hashes and
exact process cleanup pass. See the developer checklist for pins, receipts,
known limits and the normal-profile human example. The developer subsequently
reported normal-profile pass `017e9804` / context `90d5e6f8`, matching calibration
measurements, and confirmed the same IDs/measurements after full App restart
without recapture. That human-reported acceptance is separate from independent
machine verification of the isolated runs. Those historical checks qualify the
original fractional workflow, not the updated native bundle, general release or
physical timing accuracy.

**Reopened: repeated listening and whole-beat starts.** Subsequent normal-profile
passes at beats 4–12 and 0–4 failed at native launch alignment after Set edits;
an earlier 4–12 attempt failed source validation. The exact original 0.25–3.75
request then succeeded again (`effa569f` / context `793afcce`), confirmed by
application History. This does not establish that edits caused the failures or
that the session stayed broken. Both retained launch snapshots show 32 samples
of clock disagreement, but beat/phase disagreement of 5,888 and 320 samples,
respectively, against the unchanged 64-sample budget. In each rejected row the
native phase equals its stopped-anchor value although the host reports playing.
The exact tool arguments, native arm baselines and completed native proofs now
establish a startup acquisition race: message-rate host playing can precede the
signal-rate phase update. The controller admitted the still-stopped phase as a
playing timing witness, then rejected it when a valid native launch marker
arrived. Successful calls first admitted already-updated phase rows. A controlled
fractional-start replay also fails without the fix, so whole beats are not an
inherent restriction or an established cause.

The source candidate now keeps such first-playing brackets out of timing
witnesses while armed, until phase differs from the last stopped row. It uses
the existing bounded rejection limit and traced progress reason
`native_launch_phase_pending`; the native launch packet remains pending.
Host-offset limits are checked before reacquisition, and normal alignment,
genuine moving-phase drift and FFT completeness checks remain unchanged.
Seven of nine new regressions fail without the fix; all nine pass with it,
including independently verified native coverage for starts 0, 0.25 and 4,
bounded failure, strict-zero, cancellation and replacement-generation isolation.
At `98e30c8`, the full Max owning suite passed 619 tests; that checkpoint was
source/unit evidence only. Subsequent isolated real-Live qualification exposed
a second failure after four windows of a 0-4 capture. Disjoint diagnostic-only
native rejection codes established an upper phase endpoint greater than one
whose excess rounded to zero at 1e-9 resolution. Exact input bits were not
retained. After normalizing that representation boundary, a separate native
witness established 63 stationary phase samples followed by a 64-sample advance
at diagnostic precision (previous/current positions rounded to 0/64 samples). The prior
guard allowed the stationary interval, but incorrectly required the eventual
advance to represent only one sample.

V2 now aliases only the closed endpoint and up to 1e-9 upper representation
excess to zero, at most 0.000144 sample at the largest supported beat length.
Other out-of-range/nonfinite values still fail. A changing phase must account
for `stablePhaseSamples + 1` elapsed samples, with the unchanged 0.01-sample
residual limit. The existing one-vector stationary timeout, default64,
strict-zero, native counter, FFT completeness, configuration and generation
guards remain unchanged. Capture coverage still comes from every retained
native audio sample, not interpolated phase or missing descriptor frames.
The unsuccessful experiment adding an analysis-source `pong~` wrapper was
removed; authored analysis geometry, clock/spectrum code and default/v1
documents retain their prior bytes.

Endpoint and elapsed-phase regressions fail before their respective fixes.
They compare all 23 outputs with an independent continuously advancing
historical-input oracle, cover both supported rates, exact sample/window
coverage, unearned catch-up, adjacent drift residuals, stationary timeout,
cancellation and sealed epochs. Full Max ownership: 629 passing tests.
The native runner also waits boundedly for its exact-owned Remote Script TCP
listener before starting the application; a fresh Live process can predate
port readiness. The gate retries only startup refusal/timeout, retains ownership,
supports cancellation and emits the existing traced/timed `bridge-readiness`
lifecycle. It does not retry actor calls or captures, change App reconnect
behavior or treat TCP readiness as authentication.

The clean candidate, without diagnostic Gen overrides, now completes real 0-4
and 4-12 captures individually and the entire four-scenario descriptive group
(fractional, 0-4, 4-12 and 30 seconds), including independent native coverage,
durable context, unchanged binding/recording and owned cleanup. The seven
owning runner/device test files pass 329 tests. Fixes are committed at `98e30c8`
and `5b6c5d1`; the native bundle manifest is
`c395d19d8df59e1e729d6aee826f4ab1726ce625ab592921813604f3fdac3846`.

The unchanged signed App now also completes four ordinarily approved Default-agent
captures in the same owned App/Live processes: 0.25-3.75, 0-4, 4-12, then
0.25-3.75 again. Independent native/context verification establishes respectively
84,000/96,000/192,000/84,000 samples and 18/20/40/18 windows, four persisted
observations, eight range/contributor links, original attribution and unchanged
source Set bytes. After full App restart, all four observations are retrieved
through the production renderer/preload/main API with unchanged payload hashes;
Outputs renders the original IDs and selected observation's sample bounds.
No capture failed or retried. Playback was stopped manually between captures;
a separate unsupported agent stop request is retained, not counted as a capture.
The 4-12 interval is silent on the fixture listener's track: this verifies
timing/coverage, not new audio or edits on other tracks. This bounded repeated-use
check does not replace three fresh-process packaged workflows for the changed
bundle or establish controlled-edit/recovery behavior.

The earlier source rejection remains separate: its actual Session-override tri-state was
not retained in the inspection failure and cannot be recovered from that event.
Generation-owned numeric envelope rejection details and startup reacquisition
progress now reach typed History through `output.listener.native.progress`;
the public `native_envelope_binding_changed` terminal reason is unchanged.
The stopped-transport prerequisite remains explicit: the capture leaves
playback running. Actual normal-profile SDK registration contains all 17
`ableton_transport` actions, including `set-playing` with `isPlaying: false`.
The agent incorrectly claimed only `delete-cue-point` was available and never
attempted a stop; it did not receive a stop permission denial. The description
now explicitly advertises start/stop, tempo and Arrangement-loop guidance;
#56 tracks the scope-aware description fix and pending real-agent acceptance.
Manual Stop remains the dogfood
workaround, not evidence that Live or the application lacks the capability.
Do not count the agent's refusal as a native capture attempt.

### Arrangement-source validation and recovery (#57)

Arrangement-only listening checks the selected playback source, not which Live
view is open. A Session source can override a track even when the request names
an Arrangement interval. The guard still requires every listener's independently
inspected `sessionOverride` to be explicitly false:

| Inspected value | Meaning | Source refusal and recovery |
| --- | --- | --- |
| `false` | Arrangement source selection is confirmed by the available fields. | Continue only if all other safety, identity and native guards pass. |
| `true` | A Session source override is detected for that listener. | `arrangement_session_override`: return that track to Arrangement in Live, then explicitly request a new pass. |
| `null` | Available evidence cannot establish the source. | `arrangement_source_unknown`: check source/connection state and request a fresh inspection; do not claim a Session takeover. |

An unknown listener keeps a multi-listener request unknown even when another
listener has a confirmed override; the per-listener diagnostic preserves both.
Transport/recording and invalid identity/binding refusals retain their own
priority. No refusal publishes a complete observation or automatically switches
source, repairs Live, stops playback or retries capture. Session listening
support is separate work.

`listening.inspect_context` now optionally returns bounded `sourceEvidence` for
each listener, alongside the existing nullable boolean. Version 1 contains
`state`, an allowlisted `reason`, nullable Song/Track Back to Arrangement flags,
and nullable integer playing/fired slot indices. Missing, unreadable, invalid
or out-of-bounds inputs remain unknown, not default false. The schema rejects
contradictory state/basis and boolean/evidence pairs. Older responses remain
readable: the existing tri-state guard still applies, and absent detailed
evidence is retained as `null`, never fabricated. Protocol 7 and Remote Script
`0.7.0` are negotiated together to keep old strict clients from consuming the
extended wire shape; accepting an older fixture is not a mixed-version
connection guarantee.

The Remote Script captures the source inputs once per listener inspection so
the diagnostic and its decision share the same reads. An invalid reported
playing slot or mixed return/master placement explicitly downgrades the result
to unknown. A negative slot sentinel alone is not Arrangement proof:
`playing_slot_index == -2` denotes Session Clip Stop. With an unavailable
per-track flag, a known clear global flag plus a negative playing index
(`-1`/`-2`) and idle fired slot (`-1`) provides the existing independent
global fallback. The sentinel without that independent evidence remains
unknown. This closes an overly permissive fallback; it does not establish the
cause of the historical rejection.

The runtime rechecks owner and current listener inventory after the asynchronous
inspection, and validates its fresh binding-query nonce/path/instance/epoch
before attributing a source decision. Stale queries and replaced owners or
connections remain identity/freshness failures, not confirmed Session
takeovers. A fresh query and revision are not a universal native action-origin
or exclusive transport-ownership guarantee.

Each attributable source decision records `listening.source.validation` inside
the existing inspection/preparation lifecycle. Its typed inputs are sanitized
before persistence, bounded to eight listeners, 512 characters per string and
16 KiB of attributes, with no audio, prompts, clip contents or display names.
The snapshot retains the actual per-listener tri-state and optional source
inputs, pass and inspection boundary, Set/session/agent, query identity,
listener instance/connection epoch, project revision, inspection start/end,
elapsed time, and trace/correlation/causation IDs. The record is available through
existing typed, redacted Desktop History queries and canonical local journal
storage; no renderer filesystem/SQL access or upload channel is added.

The synchronous decision record is not a new asynchronous investigation or
recovery stage. Existing inspection, positioned-inspection and capture-preparation
queued/started/completed/failed/cancelled events retain lifecycle and timing.
Cancellation and stale replies cannot produce an attributed current-source
decision. Pre-arm refusals dispatch no native capture/start; post-arm refusals
disarm and release reserved quota without publication or rewinding a positioned
source.

Deterministic regressions cover classification, bounds, the independent global
fallback, stale query/owner/epoch, source transitions at each validation boundary,
redaction/typed journal retrieval, cancellation, cleanup and a new explicitly
requested successful pass after restoring safe evidence. These tests do not
reconstruct the original Set state or by themselves qualify real Live transitions.

The reviewed `native-listening-source-investigation` group adds four deterministic
runner scenarios: a beats 4-12 baseline, an exact Arrangement duplicate/delete
edit at independently empty beat 128 followed by restoration, a legitimate
Session-override refusal, and an explicit test-only guarded global return followed by a new
pass in a fresh copied fixture/process. The override setup independently proves
that the override remains true after its explicit fixture-preparation Stop, so
the stopped-transport prerequisite cannot mask the intended source denial.
The return action and Stop are reviewed runner setup, not agent repair,
application recovery controls or capture cleanup. Each actor makes exactly one
playback request with unchanged tool/risk allowlists.

Setup verification preserves command-specific receipts: track return requires
the `back-to-arrangement` action and nested `result.verified`, while the other
setup commands retain their top-level verification. Runner mocks are checked
against the tracks result schema; malformed, wrong-action and unverified return
receipts stop setup before further reads or mutations.

The verifier reads fresh state at transitions, immediately before the actor's
request and after terminal status. It checks query/Set/connection/epoch/binding
before attribution, retains partial setup receipts on failure, and requires the
exact known refusal with no context/native completion and an idle released
listener. Success still requires native proof, the expected 40 windows, typed
reopen and unchanged recording/source postconditions. Source receipts use the
existing bounded redacted runner lifecycle; the 256-receipt cap covers shutdown.

The source implementation at `6f66f38` passed complete local `pnpm check`
with one Vitest worker and no retries: 2,308 TypeScript tests across 137 files,
631 Max-patch tests and 215 Python tests. This includes 237
source-helper/runner-composition cases after
correcting the production-shaped track-return receipt regression. All 12
isolated Electron owning tests also pass in a sequential run, including source
refusal presentation through the real preload.

An initial Electron run concurrent with the quality gate retained two
startup/deadline failures; its logs and traces remain distinct from the
subsequent full sequential pass with unchanged assertions, deadlines and zero
retries. Earlier Desktop identity/SDK-rotation timing failures also remain
historical failures, not relabelled passes. None of these synthetic checks
establish real-Live or visual qualification.

The initial pre-existing-process and missing-input blockers were subsequently
resolved. Offline canonical staging validated a separately pinned immutable v2
fixture from the isolated #58 namespace: 25 candidate resources, three WAVs,
one four-beat Session source on the listener track and no Arrangement clip at
beat 128. The candidate includes #58's epoch-handoff fix; that provenance is
retained rather than treating it as a newly authored candidate from this branch.
Each actual run opened a byte-for-byte runner-owned copy with this branch's
fresh Remote Script 0.7.0/protocol 7. These are development observations on the
installed Live 11.3.43 host; full subversions are retained, not treated as
interchangeable evidence. Development does not require downgrading to the
previously recorded 11.3.42 installation. Live 12 remains unsupported.

| Observed-host run | Result |
| --- | --- |
| Source baseline 4-12 (`9a207291`) | Arrangement source validation passed through four runtime decisions, using global-clear/idle-slot evidence with the track-level Boolean unavailable. The producer then failed `native_launch_binding_mismatch`; no context was published. |
| Existing native 0-4 control (`5f8b0f32`) | Twenty measurement windows were produced, but the incomplete capture failed `listening_alignment_budget_exceeded`. The retained rejection snapshot records clock disagreement 32 samples and beat disagreement **65**, exceeding the unchanged **64**-sample policy. Replaying those recorded operands through the production validator reproduces the refusal; zero contexts were published. |
| Standalone Session-override refusal (`692445a0`) | PASS for this selected case: the exact Session slot remained selected after explicit stopped preparation, the one actor playback request produced `arrangement_session_override`, and independent checks proved no publication, released listener resources, recording off and unchanged Set/source state. |

The refusal is one selected scenario, not a passed four-case source group.
These observed-host runs used `6f66f38`, before the later main/PR #65
integration; they are not qualification of that integrated head.
The group was stopped at the baseline failure; the control and standalone
expected-refusal case were separate diagnostic selections, not retries that
erase that failure. No timing budget, native proof, source guard or actor
permission was relaxed. The 4-12 launch failure lacks rejected operands, so it
is not assigned the control's 65-sample cause or the historical issue's cause.

All three owned Live processes exited, their disposable fixtures were cleaned
up, and independent process inspection confirmed absence before slot release.
No pre-existing process or original Set was adopted or changed; existing
Remote Script authentication was preserved. Raw Set/audio and private profile
paths were not uploaded. At that checkpoint positive capture, Arrangement-edit/
explicit-return group completion and visible cross-app acceptance remained open.
The subsequent clock correction and its new evidence follow; those successes
do not erase the original failed runs or reconstruct the historical source state.

Native v2 failure snapshots now use the existing generation-owned
`nativeFailureDiagnostic` route for alignment and FFT sequence rejections.
Alignment snapshots preserve the exact rejecting check, anchor, previous and
rejected clock rows, immutable policy/geometry, bounded timing witnesses and
the computed disagreements; an uncomputed beat disagreement is explicitly
null. Sequence snapshots retain previous/current packets. They are accepted
only on failed v2 replies/results, never as successful capture authority;
legacy v1 and the 128 KiB frame ceiling are unchanged. Cleanup preserves the
first failure snapshot without allowing another generation to inherit it.
These snapshots enabled the following recorded-data fixes; historical failures
without rejected operands cannot be retroactively assigned the same cause.

Native launch-binding refusals also retain the existing alignment snapshot,
with `check: "launch-alignment"` and the unchanged public
`native_launch_binding_mismatch` reason. Here `startSample` is the rejected
projection computed from the validated arm/launch marker and frozen offset,
not an accepted launch or capture. Clock witnesses and disagreement
measurements use the same calculation as the enforcing validator. No new wire
fields, successful-capture authority, frame allowance or timing tolerance are
introduced. Controller and real-SDK regressions cover the missing diagnostic,
trace attribution, immutable operands, no publication, disarm confirmation or
timeout, cancellation and replacement-generation isolation.

The #57 timing investigation also identified a clock-acquisition hazard:
[`snapshot~`](https://docs.cycling74.com/reference/snapshot~/) with offset zero
can select the scheduler's sub-vector sample when Scheduler in Audio Interrupt
is enabled, while the bracketed host clock reports a buffer-boundary position.
The opt-in v2 clock graph now configures its MC snapshot to the actual DSP
vector size minus one before each bracket. This reads the latest available
sample rather than rewriting clock values, selecting a more favorable anchor
or discarding disagreement witnesses. Default/v1 and descriptor sampling,
Gen algorithms, bracket duplication, the frozen anchor and strict-zero/default64
limits remain unchanged. The graph regression fails before this change and
passes afterward. Fresh immutable-candidate captures now demonstrate the
correction on the observed host, with the limits below.

The continuation passes a fresh workspace build and the full quality gate:
2,394 TypeScript tests, 634 Max-patch tests and 215 Python tests, including
75 targeted typed-ingress/contract cases. A new candidate was authored from the
canonical clean `Machine-Listening-Development.amxd`, rather than repackaging
#58's native output. Ordinary Live Save As established owned references in
`Issue57-ClockIndex-Pinned.als`; no XML was rewritten. Its SHA-256 is
`eb627f86df0840364f8e8c7b1689628e4b53d4adc87072366663dda8ace11196`;
the candidate manifest is
`698000070e98ad77aee3ebc5fb7431da893c9059eb09e69b7edae69c808f0d26`.
All 29 original source/candidate/manifest/audio pins remain unchanged.

The former custom `Untitled` startup blocker was resolved by the user's
explicit closure, followed by independent process-absence verification.
Automation did not discard that content. A fresh exact-owned process opened
the isolated fixture directly, completed ordinary Save As and exited cleanly.

The following new runs use source head `deaf182` and the new pinned candidate
on installed Live 11.3.43, not the older #58 candidate or historical receipts:

| New observed-host run | Result |
| --- | --- |
| Failed baseline rerun (`5e6f4a31`) | PASS: beats 4-12, 192,000 stereo frames, 40 complete envelope/spectral windows, native proof and postconditions. Observed clock/beat disagreement is 0/1 samples. |
| Source group (`7a08c15f`) | Baseline, exact Arrangement duplicate/delete/restoration and intentional Session refusal PASS. Explicit track-return preparation FAILS because `tracks.back_to_arrangement` is unavailable. This is not a passed four-case group. |
| Entire native descriptive group (`9c076380`) | All four fresh-process cases PASS: fractional, 0-4, 4-12 and 30 seconds. Independent native/context/postcondition checks include 1,440,000 stereo frames and 300 windows for the long capture. Clock/beat disagreement is 1/2 samples in each case. |

Typed History independently retains every completed proof's original clock
operands. Audits of all three positive source captures, all four descriptive
captures and the additional Desktop capture find sample index 63 in all 69
retained clock rows per proof at vector64. This establishes execution of the
new fixed-index graph rather than a favorable numeric rewrite. The original
0-4 failure now passes, and the 64-sample budget remains unchanged. These are
bounded descriptive observations, not physical calibration, exclusive source
attribution, verified tempo stability or proof of the historical source cause.

An isolated visible Default-agent workflow with ordinary approval completes
0-4 capture `ebd2a01a` / context `0a7da622`: independent protocol verification
confirms 96,000 stereo frames, 20 windows, unchanged source/staged Set/WAV
hashes and clock/beat disagreement 0/1. The renderer displays the same IDs,
range and approximate-timing limits. A separate ordinarily approved request
after manual Session launch and stop fails `arrangement_session_override`
(`27503b87`), with slot 0/global override evidence, no positioning, native
capture or publication, and the original context unchanged. Renderer
accessibility exposes the new manual-return/new-pass guidance. That first
combined workflow left its offscreen scroll presentation inconclusive rather
than claiming a visual pass. A separate fresh-profile refusal-only workflow
(`347a06f8`) now confirms the single submitted message, ordinary approval,
terminal failure and full manual-return/new-pass guidance visibly in both the
conversation and Outputs, with usable controls and no success-shaped result.
Independent typed History verifies slot0/global override, no positioning or
native capture, no published context store and unchanged staged Set. Live
visibly remains stopped with the Session selection retained. The current-head
Electron owning suite separately passes all 12 tests sequentially, including
synthetic refusal IPC; synthetic coverage is not the visual/native proof.

The installed host lacks the track-scoped Return to Arrangement capability
required by the reviewed recovery setup, which explicitly prohibits global
return. No global fallback, capability fabrication, actor-policy widening or
source auto-repair was used. A test-scope decision is required before that
case can qualify; its failed trace and partial setup remain retained. The PR
stays draft, and the remaining suite is not claimed passed. Deterministic-run
disposable fixtures were cleaned; the isolated UX fixtures/profiles remain
private audit evidence. Both UX pairs exited (Desktop41955/Live41218 and
Desktop47007/Live46186), both exact hosts stopped, and final canonical
inspection at 2026-10-23T18:44:08.384Z confirmed no Live before explicit slot
release. Visible refusal acceptance does not qualify unsupported return/new-pass
recovery.

### Integrating the merged placement fix

PR #66 subsequently merged placement refresh, independent binding-validation
fences, device-lifetime native epoch high-water and the Live 11-only compatibility
policy into main. The integration preserves those guards and the fixed-index
clock, source distinctions and failure diagnostics together. Binding validation
rechecks owner and current registration after asynchronous reads before
attributing any source decision; an in-flight epoch change is now rejected as
`listener_placement_changed`, not mislabeled as a Session source refusal.
Combined regressions cover both confirmed and unknown source refusal after
authenticated placement renewal, unchanged prior context, no new reservation
or controls and the failed binding-validation lifecycle. Keeping the older
early generic source guard loses the diagnostic and fails both regressions.
The combined workspace builds and passes full quality: 2447 TypeScript tests
across 139 files, 642 Max tests and 217 Python tests. The combined Electron
owning suite passes all 12 tests sequentially without retries, including both
placement-refresh history and source-refusal guidance. The earlier Live receipts
above qualify their recorded source heads only; fresh immutable-candidate Live
acceptance remains separate, without inheriting either branch's qualification.

### Approved isolated recovery setup

The user subsequently approved changing only the disposable recovery test to
use Live's supported global Return to Arrangement. Production capture still
never returns a source or retries automatically. The original track-only
failure and pre-integration receipts remain historical, not relabeled passes.

The reviewed setup now requires an independently globally clear baseline,
complete unchanged regular-track identities (at most 32, with no truncated
device inventories), and exactly one Session source in the entire Set, on the
bound listener track. The only intervening mutation is its exact owned launch.
Immediately before the global command, a traced/timed scope-validation stage
rechecks ownership, complete track/source identity, the one-mutation lineage,
recording-off and fresh target/global override evidence. This proves the scope
from a known clear baseline and the sole permitted transition, not from idle
slot sentinels alone. Any missing, foreign, unknown or changed scope denies the
global command and retains partial evidence. Independent reads must then prove
global and target source clear, followed by the explicit stopped new-pass
preflight. The actor's tools, risk classes and mutation budget are unchanged.
These guards and their failure/cancellation tests do not themselves qualify
real-Live recovery; fresh execution is still required.
The revised helper passes 60 cases; runner composition and the broader native
helpers pass 435 cases across nine files, including guard lifecycle and
zero-global-return/no-actor denial. The full TypeScript suite passes 2468 tests
across 139 files. This test-only revision changes no production app/bridge API.

The first fresh combined recovery attempt (`1fccf46b`, head `f378ffc`) passes
the source-scope guard but fails the existing global transport command's
immediate verification before actor startup. No pass or context is produced;
the owned process and disposable fixture are cleaned. The global command now
uses the existing deferred executor for one next-tick verification after one
assignment, not a mutation retry. Bounded before/after failure diagnostics and
request-attributed lifecycle/queued cancellation are covered by red/green
Python regressions; the full Python suite passes 220 tests. This manual-command
correction does not add automatic source recovery or change the result schema.
The fresh-process rerun (`5e7f9759`, head `0d82504`, Live 11.3.43) now verifies
the single command's true-to-false transition on the scheduled tick, then
independently reads clear global/target state before the new pass. Pass
`1532782f` / context `b023fa10` has independently accepted 192,000 stereo
frames and 40 envelope/spectral windows, clock/beat disagreement 0/1, exact
postconditions and cleanup. A separate journal audit verifies all 69 clock rows
at index 63/vector 64. This supports the scheduling correction without widening
verification or capture bounds. The runner still incorrectly stamps this
receipt `supportedTargetQualified:false` using a stale 11.3.42 comparison,
despite the merged Live 11-only policy. Retain the original receipt; correct
current runner eligibility/labels and rerun the case/group before claiming
current-policy qualification. The current runner now derives `hostEligible`,
`supportedLive`, `observedLiveVersion` and `hostEvidenceLabel` from the shared
product compatibility policy for both source evidence and top-level results.
It removes the ambiguous exact-patch `supportedTargetQualified` field;
eligibility never promotes readiness, physical qualification or failed runs.
Live 11.3.43 eligibility, Live 12/minimum/unknown rejection and failure metadata
have red/green regressions. The full TypeScript suite passes 2478 tests across
139 files; current-policy real-Live reruns remain separate.

Current-policy standalone recovery (`731a35c4`, head `b031f70`, observed
11.3.43) passes with `hostEligible:true`, unchanged unqualified physical timing,
independent 192k-frame/40-window proof and exact cleanup. The owning source
group (`cc47bcdd`) then passes baseline and exact Arrangement edit/restoration.
The third case's independent Session-refusal assertions pass, but fixture
cleanup correctly refuses deletion while its owned Live91785 remains alive.
Outer fallback subsequently stops that exact process; an independent process
read confirms none remain. Staging is retained and the fourth case is not
attempted. This is a failed group, not three fully qualified cases. The refusal
branch must share stop-before-fixture-cleanup ordering and truthful cleanup
evidence with positive captures before another case/group run.
Runner inspection identifies the narrower cause: graceful quit timed out and
the active-fixture guard masked that primary error, rather than a bypassed
shutdown branch. Expected refusals now await exact-owned disposal before
fixture cleanup and report `unchanged-stopped` transport cleanup. Shutdown is
protected by `finally`; combined shutdown/fixture failures retain the primary
error and never delete an active fixture. Red/green disposal-order and
failure/cancellation coverage passes 452 native-helper tests across nine files;
the full TypeScript suite passes 2485 tests across 139 files. Fresh refusal and
group acceptance are still required.

### Combined candidate acceptance

At source head `436c5c6`, with the separately pinned combined candidate and
exact installed Remote Script, refusal alone (`f24f8500`) now passes complete
owned-process/fixture cleanup with unchanged stopped transport. The fresh
owning source matrix (`c1725ac9`) passes all four cases, including guarded
explicit return followed by a new native pass. This supersedes the acceptance
blocker without relabeling the prior failed group or its retained staging.

The merged placement/clock behavior also passes two-capture insertion alone
(`6dca4ab3`) and its fresh-process owning group (`be634acd`): the same exact
listener moves from index0 to index1 after only the permitted upstream Delay,
each pass has its own independently accepted 96k-frame/20-window proof,
native epochs are exactly1 then2, and the first historical context is preserved.
The complete descriptive group (`e2c31f71`) passes fractional,0-4,4-12 and
30-second cases; the last has1,440k frames/300 envelope+spectral windows.
All these cases verify ownership, postconditions and exact terminal cleanup.

An independent journal audit of all eleven completed captures across those
four reports, including both passes in each rebinding run, verifies759 retained
clock rows at index63/vector64. Maximum observed clock/beat disagreements are
1/2 with the original64-sample and strict-zero enforcement unchanged. Host
eligibility is true on observed11.3.43, not an exact patch pin. Physical timing
qualification/readiness remains unpromoted; attribution/freshness remains
unknown.

The remaining nineteen non-native cases also qualify across nine fresh owning
groups: fourteen `pass` and five `recovered-pass`, with every exact assertion
and cleanup check passing. Recovered cases retain their failed argument attempts;
they are not clean first-attempt passes. The explicit strict-v1 fixture case
was not rerun or replaced with v2 evidence, so this is not a claim that the
entire 29-case suite passed.

Fresh Default-agent Desktop checks use isolated profiles and ordinary approvals.
The first positive attempt fails strict argument validation because the model
adds unsupported `limit`; no capture is queued and no native proof is produced.
The next attempt completes pass `ed85a632` / context `681e6304`: independent
typed retrieval and native validation prove 96k stereo frames, 20 windows and
69 retained clock rows at index63/vector64 with clock/beat disagreement0/1.
The structured Outputs view correctly exposes approximate timing, unknown
attribution/freshness and leave-running policy. An independent bridge read
confirms playing transport, clear Arrangement source and all recording flags
off; staged Set/WAV hashes remain unchanged.

That attempt's generated prose incorrectly calls playback-starting capture
read-only. A separate stopped-Session workflow correctly refuses pass
`7b583e99` with slot0/global-override evidence, zero positioning/native capture
or context publication and unchanged stopped source, but its prose incorrectly
suggests stopping/deselecting a clip as an alternative way to clear the override.
These are failed prose-acceptance checks, not failures of the source guard or
permission enforcement. Both exact-owned Desktop/Live pairs exit normally,
and their hosts are stopped; original fixtures and failed receipts are retained.

The shared listening-agent handoff now explicitly says that successful capture
positions/starts transport and leaves it running, and that Back to Arrangement
restores the playback source rather than changing the view. Switching views,
stopping playback or deselecting clips does not clear the override. Recovery
remains manual followed by a new explicit request, never automatic repair/retry.
Regressions fail before this correction at both the tool-description and actual
new/resumed SDK-agent prompt boundaries; all 67 owning cases pass afterward.
No tool schema, permission, mutation budget, native acceptance or transport
behavior changes. Current-guidance baseline alone (`0eb0bd3e`) and the fresh
four-case source group (`3958b8fc`) pass all exact assertions and cleanup.
Independent audits verify all 276 retained rows across their four completed
captures at index63/vector64. The focused run observes clock/beat1/64, at the
unchanged inclusive descriptive limit; the group observes at most1/2. Neither
is an absolute accuracy certificate. All 2485 TypeScript tests and all twelve
sequential, no-retry Electron tests pass with the revised handoff; workspace
types, changed-source lint and paired documentation checks pass. Fresh visible
acceptance remains separate from the retained earlier attempts.

Fresh visible acceptance at `2e52827` now passes with the same two requests,
new isolated profiles and ordinary approvals. Positive pass `ac00ad74` /
context `dcffa7df` has independently accepted 96k-frame/20-window coverage and
69 index63/vector64 witnesses, observing clock/beat0/64 under the unchanged
descriptive64 policy. The assistant now accurately reports App-owned
positioning/start and leave-running playback; the structured stored context
retains approximate timing and unknown attribution/freshness. An independent
post-turn bridge read confirms playing transport, Arrangement selection and
all recording flags off. Live visibly remains in Session View while playing
the Arrangement source: the view is not the source-selection guard.

In the separate refusal fixture, independent reads first prove a Session
launch and then prove stopping transport preserves that override. Refused pass
`bef49b20` reports `arrangement_session_override`; both conversation and Outputs
show failure, no publication and manual Back to Arrangement followed by a new
explicit request. The explanation now expressly says switching views,
stopping playback or deselecting the clip does not clear the override.
Independent post-turn reads and typed journal audit verify unchanged stopped
Session source, no positioning/native capture or published context store, and
unchanged staged Set/WAVs.

Both final Desktop/Live pairs exit, and their exact UX hosts stop. Positive
cleanup stops only the owned transport after independently verifying the
leave-running postcondition; no capture or source-return retry is performed.
Canonical absence at `2026-10-23T22:14:47.149Z` confirms no Live processes
remain, and exact Desktop PIDs28156/29752 are absent. The shared Live slot is
released with no additional Live launch planned. Evidence profiles and failed
attempts remain private; the original historical source cause and physical
timing qualification remain unproven.

A capture-only read-pressure diagnostic reproduced a 65-sample rejection:
the initial host/native offset was -1, and a later host sample/beat pair was
one complete 64-sample vector ahead of the native counter/phase pair. V2 now
reuses v1's bounded mixed-vector reacquisition, generalized to the configured
rate, tempo and vector size. It requires a previously phase-coherent playing
row, an exact positive one-vector offset change and the same signed circular
phase change. The rejected acquisition never updates the clock, alignment
witnesses or capture proof. Other changes and stopped-clock mismatches remain
hard failures; persistent mixed-vector reads exhaust the existing 64-rejection
limit. The anchor, default64 and strict-zero policies are unchanged.

A separate diagnostic retained an actual FFT jump from 2359296 to 2371584:
five frames were missed inside the requested range, with zero invalid DSP
frames. Missing FFT data still fails; it is not interpolated or accepted as
silence. V2's authoritative clock and descriptor polling now uses scheduler
`metro`, not low-priority `qmetro`, whose documented queue-overload behavior
drops output. Idle/stop/generation ownership wiring and DSP algorithms are
unchanged; default/v1 documents retain their exact bytes. Scheduler-only owned
controls passed capture under read pressure. The canonical fractional/30-second
group and a canonical 30-second capture with 56 read-only inspections also pass,
with no source overrides and independent native/context/postcondition checks.
This is not packaged qualification or full App-restart retrieval.

Native-runner preflight timeouts also retain the last connection error code and
message, redacted and bounded before persistence (128/1024 characters). They do
not replace a concrete connection failure with only an uninformative `error`
state or relax reconnect/readiness admission.

Qualification is now an autonomous diagnose/regression/fix/retest loop. A
failed attempt stops and cleans up that attempt, not the debugging task.
The human handoff gate is three consecutive clean short packaged workflows
from fresh owned App/Live launches, each with full restart retrieval. A failure
invalidates that qualification sequence; unchanged retry-to-pass is forbidden.

Human-authorized native-vault provisioning and full restart/decryption now pass
on the unchanged signed candidate, without an environment-token override.
The first subsequent natural Default-agent request failed before capture:
pass `48528b95` used a track reference as its listener ID and correctly failed
`listener_unavailable_or_ambiguous`. The actual SDK configuration retained every
schema branch, including discovery; schema loss is not established. The
full-operation scope returned before the explicit action catalogue added for
restricted scopes. That path now receives the same catalogue and, when discovery
is authorized, an instruction to discover exact IDs rather than guess them.
The regression fails before the fix and preserves the full scope's parameter
and handler identities. Lookup-only scopes do not advertise discovery as allowed.
Existing configuration History retains this guidance with no new lifecycle or
storage channel. Native guards and permission checks are unchanged.

The fractional manifest also records a separate attended packaged-Default
qualification request and assertions. Unlike the canonical runtime prompt, it
does not prescribe tool names or their sequence. The CLI still executes the
canonical runtime scenario; its result is not the companion's packaged evidence.

The packaged capture `b6d0d6ca` now also survives a full normal App exit and
same-package/profile restart. Outputs retrieves the original context
`ac0b00cd`, including exact sample coverage and unchanged measurements, through
production renderer/preload/main without another capture. The earlier actor
still corrected invalid calls; this is persistence evidence, not a clean turn.

Agent-facing action schemas now distinguish zero-based `startBeat` and absolute
`endBeat` from Session-only `durationBeats`. A known context ID goes directly
to `get`; `list` is for discovering IDs and does not accept `contextId`. The
listening tool and configured listening agent share guidance that queued/arming
is nonterminal, status uses the existing `get-pass`, and shell waits or extra
playback calls are not waiting mechanisms. Explicit user no-retry instructions
also cover validation/permission errors; a `retryable` error is not permission
to retry. These are agent-facing instructions, not an NLP-enforced mutation
policy or a change to the asynchronous job contract.

The reviewed v2 scenarios now fail on any actor `operation.failed`, even if
the actor could correct the call and later capture successfully. A regression
demonstrates that the earlier runner accepted that recovered workflow. Existing
failure/cancellation, owner/trace, timing, redaction, capture and cleanup
lifecycle remain unchanged; updated guidance is recorded through existing SDK
configuration/history boundaries.

The first strict native qualification run at `7a3f713` failed again at the
native timing guard: pass `b4233bbf-8013-45eb-8231-94a4668878b2`,
`listening_alignment_budget_exceeded`, before producing an envelope window.
The actor made the three reviewed calls with correct arguments, without
correction or shell waiting; this does not make the failed capture a clean
acceptance. No context was published. Typed History locates the rejection in
native capture, but retains only the last accepted alignment, not the
fault-time measurements or which disagreement exceeded the limit. Do not
infer the rejected magnitude from that earlier alignment. The owned Live
process exited, fixture cleanup passed and the source Set hash was unchanged.
No retry, full-group run or updated-package qualification followed this
failure. Retaining the rejected timing evidence and establishing its cause is
the next gate; the default 64-sample policy and native guards are unchanged.

The user-approved target is developer dogfooding, not exhaustive release
certification. Ordinary, non-instrumented real-Live runs complete short fractional
and 30-second captures,
independently validate native proof, preserve all nine final checks and the
terminal connection/ACK, and retrieve durable track/range context in a fresh
process. The newest device bundle is normally saved and structurally validated.
The visible app also completed a short pass and fresh typed retrieval after a
guarded native spectrum failure and a playing-transport denial. This is recovered
functionality, not clean first-attempt reliability or a globally qualified release.
Normal-profile connection is the developer's first-launch check; automation
remains isolated.

Use the [developer checklist](playback-listening-dogfood.md) for bounded handoff
gates, exploratory weak spots and bug-report evidence. Missing low-level
backpressure History rows are an explicit diagnostic uncertainty, not a
dogfood blocker absent a demonstrated functional, safety, storage or recovery
defect. Authentication, exact binding, native completeness, recording guards
and honest failure/cancellation remain mandatory; no integrity guard is waived.
The checkpoints below retain historical evidence, not additional requirements
to exhaust before developer use.

The normal saved candidate passes structural inspection with one active
`PatchSlot` listener reference; the older fixture's second reference was
`SourceContext` provenance, not another device. The first ordinary fractional
attempt (`c259b44e`) stopped before any tool call/pass because the agent
misread the allowed actions. Its recorded scoped schema contains all three
required actions; this does not establish an SDK schema-loss defect or an
audio/DSP failure. Scoped listening descriptions now explicitly enumerate the
selected action values while retaining identical schemas, validation and
permissions. The subsequent ordinary short and 30-second runs passed independently.
Their native proofs, fresh typed reads and all nine final checks are retained in
`fixtures/native-v2-developer-dogfood-checkpoint.json`, alongside the separate
failed group (`listening_alignment_budget_exceeded`, rejected magnitude unknown)
and the visible app's failed first pass (`changed_native_spectrum_sequence`).
The App's eventual successful retry does not relabel either failure. The default
64-sample budget and all native integrity guards remain unchanged.

## Earlier acceptance checkpoint

At code baseline `b7569dd`, one actual authenticated native Arrangement pass
completes and publishes a typed, retrievable context entry: beats 0-4,
96,000 sample frames, 20 envelope windows, 20 FFT records and four estimated
attacks. Actual native proof independently satisfies the App boundary.
This establishes the bounded capture-to-context prototype, not production
readiness or exclusive clip attribution. Exact typed retrieval also survives
Desktop process restart without another capture. Runner-native acceptance,
the broader host/source matrix remain open.
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
acceptance.

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

Project-relative audio is now part of immutable fixture staging, not just an
original-file hash check. The owned copied project receives the exact verified
WAV snapshots at their project-relative paths before the Set is made available
for launch. Project-relative references must agree with the pinned source;
traversal, reserved paths, duplicate pins and symlinked output directories fail
closed. Cancellation or copy failure removes only the owned partial fixture.
Legacy explicitly provisioned absolute external references retain their old
behavior. Review found that current v2 admission also permits some external
references without staged audio snapshots; #62 tracks fail-closed admission
and reference-resolution coverage. The milestone's immutable-input evidence
covers project-relative copied resources only, not arbitrary external WAVs.
Audio receipts must not be interpreted as covering omitted external dependencies.
Staging returns bounded per-file receipts; persisted runner evidence
contains only audio counts, byte counts and hashes, not audio bodies or new
unredacted filenames.

This corrects a separate fixture omission: the old stager validated the original
WAVs but did not copy their `Audio/` tree, and the owned Live log reported a
quarter-sine file-open exception. It does not establish what audio the earlier
failed runs actually processed. Fail-before v1/v2 regressions reproduce the
missing staged file; real pinned three-WAV dry staging now verifies their exact
bytes and unchanged Set without launching Live.

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
Idle FFT publication does not qualify an armed passage capture.

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

The operator normally saved the fresh corrected candidate; read-only inspection
verified two AudioClips, one native device and project-local provisioned device/
WAV references without rewriting Set XML. The next ordinary immutable
fractional run `d7bc78dd` now passes genuine native arm: epoch1, arm counter
1026560, 32 stopped preflight rows, DSP48k/vector64 and the unchanged descriptive/
64 policy. Armed publication takes 372 ms. This is positive arm evidence, not
just idle diagnostics. The later playback-start path fails
`native_envelope_binding_changed`, with zero retained capture frames and no
context. Its capture-phase failure elapsed time is 1715 ms; the generic
capture-stage started event means waiting after arm, not a genuine launch.

The original rejected envelope row was not retained, so neither a changed arm
counter nor a nonzero native rejection code is assigned as its cause. The
completed arm proof and bounded negative record are preserved in
`fixtures/native-v2-envelope-binding-failure.json`; both guard branches remain
hard failures in controlled tests. Exact-owned process shutdown and copied-
fixture cleanup succeed. The next diagnostic must retain the actual rejected
values without suppressing, repairing or admitting data differently. The
descriptive group and Desktop qualification remain blocked on ordinary capture.

The subsequent read-only observer run `25e47a1f` retains the actual original
controller input at rejection, without changing SDK/control/admission/validation/
callback/timer/context behavior. Its 214 envelope invocations include the
rejected row
`[1,90624,-1,0,15,0,0,-1,0,0,0,0,0,1094144,1184768,2]`.
The retained arm counter is also 1094144: this failure is the nonzero native
rejection15 branch, not a changed arm counter. The original method throws the
same error; the observed pass/generation matches the actor job. Receipt timing
2260.733 ms is consumer-monotonic time from the first envelope, not native event
time. The row's launch markers are rejected data, not an accepted launch proof.
Actual inputs causing the Gen predicate still require focused diagnosis.
These values belong only to this new instrumented run and do not fill the
earlier ordinary run's missing row. No context is published; prototype
restoration, exact-owned process shutdown, fixture cleanup and source/copied
resource preservation succeed. See
`fixtures/native-v2-envelope-rejection-observation.json`.

Source audit maps native rejection15 to the delayed-stereo finite-input guard
`!(abs(delayedL) <= 1000000000000 && abs(delayedR) <= 1000000000000)`,
after active render-index/continuity checks. It is not a phase rejection:
phase faults use14 and unresolvable launch distance uses9. The row's index6 is
rounded phase distance from requested start fraction0.25, not raw phase.
At48k/120 BPM, raw phase0 would instead model distance18000 and rejection9.
The exact row can also be reproduced with delayed NaN, Infinity, above-limit
input or a synthetic false comparison on valid audio, including a fault later
than the first rendered sample. Therefore zero held descriptors cannot establish
zero input or identify the actual faulty sample. A passive probe must latch the
actual delayed inputs, explicit classification, original and equivalent bounded-
word predicates, and render/counter state at the rejection15 branch before
considering an equivalent guard correction.

The first 36-field passive finite-input probe did not produce input evidence.
Run `1da066a2` fails envelope ABI0 before arm, and the exact owned Live log
reports `gen_domain: dsp.gen: [string -- main2.lua...]:697: failed to compile
genpatcher`, followed by `gen~: failed to compile patcher`. The private probe,
not the unchanged production baseline, requires native compilation correction.
Its 113 inactive private messages are not zero-audio observations. Native stop
acknowledgement is unconfirmed; owned process shutdown, instrumentation
restoration, fixture cleanup and source/copied pin preservation succeed.
No failing helper, packet or input is treated as acceptance evidence.

The separate local-distance observer variant now executes natively. Owned run
`96f88bf6` retains an actual coherent latched rejection15 tuple: delayed left and
right are both displayable, unclipped `0`, not NaN/unknown placeholders. Both
original inclusive1e12 comparison rechecks return false; both equivalent
bounded-word checks return true, and the composite rejection recheck agrees
with the actual native rejection. The fault records render index/n/completed0,
48 kHz/vector64, epoch1 and matching serial3 bookends. Its actual rejected main
packet keeps arm counter1157632 unchanged. These observations justify an
equivalent finite-guard correction; they do not justify relaxing the bound.

The observer collects 178 owned tuples, including exactly one observed fault,
with no foreign/malformed/decoder errors. Fresh owned-load log bytes contain
neither Gen compile nor WAV-open errors. All original SDK/control/admission/
validation/timer/stop/context paths are unchanged; no completed capture or
context follows. Observer restoration, exact owned Live/Node exit, fixture
cleanup and original/copied code/audio pins pass. B is not a matched compile
comparison against the earlier missing-Audio A, nor proof of compiler internals
or non-silent source playback. Consumer receipt times are not native sample
timestamps. Permanent bounded evidence and the exact historical production
envelope resource are retained in
`fixtures/native-v2-envelope-finite-guard-observation.json` and
`fixtures/native-v2-envelope-wide-finite-bd4eb41.gendsp`.

The current v2 envelope now uses the same inclusive1e12 bounded-word finite
predicate as the physically observed spectrum. The predicate generator is
shared without changing spectrum output bytes. The only envelope admission
change is the equivalent finite check; all timing/phase/configuration/coverage/
stop rules, descriptor math, outputs and ABI remain unchanged. Frozen v1 is
unchanged. New envelope code SHA is
`4184116450b5754a50f616fddeeb3b32a930a1f25d13c7b512517da4210c1c54`;
pretty-JSON-plus-LF Gen SHA is
`b732aed30d37910c72362c790160758dd96f5087e5093e2dff3a8924d7c7b508`.
This source correction still requires fresh actual capture qualification.
Historical idle-envelope observations bind the archived f633 resource, not
this changed production revision.

The corrected 23-output production envelope now completes an actual
instrumented fractional capture in run `5f8282f5`: beats0.25..3.75, 84,000
stereo frames, 18 envelope/18 spectral windows, a 2,400-sample final partial
window and 32 before/32 after frames. Independent App validation accepts the
proof and atomically publishes context `781dd134-6876-4148-816f-63d5f219be4d`
for pass `ef6ee80a-9c63-4cd4-951d-893256d638e2`. A separate process retrieves
the same canonical observation through the production typed context API.

This is measured non-silent input, not only a complete zero-valued proof:
both peaks are0.5 within the predeclared0.4..0.6 fixture range. Typed
application History retains the exact native terminal proof; ten spectral
windows have positive numeric energy, totaling3888175.768319656. The measured
summary is RMS-12.161550283999496 dBFS per channel and centroid451.99794073445076 Hz.
Neither centroid nor actor success substitutes for the energy check. Warped
plugin input is not assumed exactly equal to raw-file RMS.

The result remains approximate/descriptive-only, with observed clock/beat
disagreement0 under policy64 and both physical error bounds unknown. The
415-row read-only observer records no rejection/error; source/copied code/audio
pins, instrumentation restoration, exact owned96890/97670 exit and fixture
cleanup pass. The explicit copied-current-envelope override and inspector make
this diagnostic completion, not ordinary immutable-candidate acceptance or
readiness promotion. Full bounded proof and typed-reopen evidence are retained
in `fixtures/native-v2-finite-word-capture.json`; a fresh normally saved candidate
and ordinary fractional/group qualification are still required.

The freshly rebuilt candidate has since been normally saved and qualified
without overrides or an inspector. Ordinary run `83806005` completes the same
84,000-frame fractional passage and publishes context
`bb6dead8-ff56-47c4-b619-513517f30a53`; a separate typed reopen and native-proof
replay verify both0.5 peaks, ten positive-energy windows and exact coverage.
The first ordinary proof is retained in
`fixtures/native-v2-ordinary-fractional-capture.json`.

Broader group run `a8785498` independently repeats the fractional success, but
the 30-second case fails `native_envelope_binding_changed` after a genuine arm
and observed launch. Native lifecycle reports33 capture frames at5151ms;
no context publishes and owned process/fixture cleanup passes. Its rejected
16-value row is not retained, so the native rejection code remains unknown:
do not assign the earlier finite rejection15 or infer a phase fault from timing.
The group remains failed and is not replaced with the earlier fractional pass.
Next isolate that actual long-capture row under unchanged controls before
altering any native guard or extending broader qualification.

The read-only long-scenario observer subsequently stops at a different, earlier
spectrum acquisition fault in run `c6a024c9`, before retaining an envelope
rejection. The typed failure diagnostic preserves
`[1134592,0,0,1132544,1136640,0]`: first end/start still describe the old complete
2,048-sample interval while the final end tag advances exactly one FFT frame;
invalid count is0, FFT diagnostics are clean and all three ABIs are2.
Capture lifecycle reports0 frames at1706ms after arm, with no retained native
launch receipt. This does not prove transport never started, reproduce the
earlier33-frame failure, or authorize admitting an incoherent packet.
No context publishes and all observer/source/code/audio/process/fixture cleanup
checks pass. Preserve this distinct actual case in
`fixtures/native-v2-long-spectrum-observation.json` while assessing only
narrowly identified acquisition discard under existing quotas and deadlines.

The current controller adds v2-only discard handling for that ordering only
when a retained coherent frame exactly matches the packet's old interval,
centroid, energy and invalid-frame counter, the final tag advances exactly one
FFT frame, and the retained observation is within the existing1,000ms freshness
limit. It charges the existing shared64-rejection quota and existing rejection
event. The incoherent packet is never admitted; no retained timestamp is
refreshed, deadline extended, counter repaired or capture binding replaced.
V1 recovery behavior and the Gen/coordinates/IO resources are unchanged.
New controller SHA is
`f6e1e2de0230c86fe2d534f98400648edb3160deaacbb2bb88e74bf667d6c9d2`.

The actual `c6a024c9` diagnostic did not retain its preceding coherent payload.
The exact-packet regression therefore uses explicitly modeled matching prior
state; physical recoverability is not established by that test. A missing or
different prior payload still fails.

A subsequent owned current-controller diagnostic `509eb299` reached the later
envelope failure and retained actual rejection14:
`[1,92160,-1,0,14,0,0,-1,0,0,0,0,158400,1083904,1176064,2]`.
The controller was capturing; the arm counter remained1083904 and33 completed
windows represented158400 samples. The current controller's loaded module and
prototype were attested, only the controller and its copied manifest were
overridden, no context was published, and restoration/process/fixture cleanup
passed. Evidence is `fixtures/native-v2-long-envelope-rejection.json`.
This establishes an actual new native rejection, not its raw phase cause:
held launch distance0 is not fault-time `plugphasor~` input. The raw phase and
previous phase remain unknown; no normalization or timing relaxation is
justified yet. The original `41efa008` row/code remain null, and this later run
does not prove physical recovery of the earlier `c6a024c9` acquisition.

An additional passive fault-time latch compiled and observed run `1a8b61cd`.
It identifies code 14's range branch, not the separate active phase-step branch.
The transport reports raw phase 1, independently computed phase-minus-one 0,
previous phase 0.999958333333333 and failed range recheck. Matching epoch 1 and
serial 2 bookends bind the private record to the owned pass. The fault counter
is 162000 samples after the launch origin; completed 158400 plus pending 3536
and the existing 64-sample lookback reconcile to that count. Step rechecks were
not evaluated and remain sentinel -1. Exact binary equality to 1 or a particular
epsilon is not established by the transport-reported numbers.

The main guards/outputs/control remain unchanged. No context was published;
all 502 private observations were bounded, with 501 unwritten and one observed
fault, no decoder errors, and exact handler/resource/process/fixture cleanup.
The permanent evidence is `fixtures/native-v2-phase-boundary-observation.json`.
This narrows the correction to periodic boundary semantics without authorizing
arbitrary wrapping, a wider phase-step tolerance, or retroactive attribution
to either earlier run.

The distinct endpoint precision probe then compiled in owned run `cb1d2aba`.
Its fault-time native predicates report equal-to-one 1, above-one 0 and
below-one 0; the independently scaled residual `(phase - 1) * 1048576` is 0.
The decoder reports `native_equal_one`, with matching epoch 1/serial 2 and
comparison/residual agreement. The range branch rejected again; the strict
step branch remained unevaluated. This supports an exact periodic endpoint
correction, not admission of adjacent overshoot or an arbitrary epsilon.
Evidence is `fixtures/native-v2-exact-endpoint-observation.json`; no context
was published and all owned resources/processes were cleaned up. Do not
retroassign the new native comparison to earlier runs with weaker probes.

Production v2 now canonicalizes only native phase exactly equal to 1 into 0,
consistently for validity, launch, step, stall and previous-phase history.
This is periodic endpoint semantics, not a timing-policy relaxation: adjacent
values above 1 still reject, as do negative/nonfinite inputs and genuine jumps;
the strict 0.01-sample step guard, counters, configuration, coverage and all
23 outputs remain. Frozen v1, clock and spectrum bytes are unchanged.
New envelope code is `321fac8f61507154dc05c63d6fe0360a8e20780ee050a3a24b402b077eb1f8ac`;
pretty-LF Gen is `be01a84ea0c4c86e95375401f59306ce67e7afab1b263ef9b3ffe6502f3dbb91`.
The pre-change `fixtures/native-v2-envelope-periodic-baseline-b732.gendsp`
preserves exact historical code/document identity for prior evidence and
private probes. Eight new regressions failed before correction; all nine new
tests and 567 owning Max tests pass. The subsequent native capture proof is
qualified below; end-to-end scenario acceptance remains separate.

Owned current-Gen/current-controller run `dc7ade30` then completed the full
30-second capture: 1,440,000 stereo frames, 300 envelope and 300 spectral windows,
and 32 before/32 after timing rows. The actual proof independently validates
against pre-capture queued geometry/policy, and a separate process retrieves
identical canonical context `b456194e-7ab1-4d5b-a409-9b8066fcc4a0` through typed
APIs. Peaks are 0.5 per channel, RMS -24.502382344333178 dBFS, with 10 positive
spectral windows and energy 3964573.9027342475. Observed clock/beat disagreement
is one sample under the existing 64-sample policy; physical bounds remain
unknown and authority remains approximate/descriptive-only.

The overall reviewed actor still **failed** its final leave-running/binding/
recording-state assertion. Successful capture and exact-owned process/resource
cleanup do not prove that separate application postcondition. No retry or
ordinary acceptance is claimed. Full evidence, including the failed verdict,
is `fixtures/native-v2-long-capture-with-failed-final-verifier.json`. Diagnose
the exact final-state mismatch rather than weakening the assertion.

The runner retains `native-listening-postconditions/v1` diagnostics for the
original nine leave-running checks: both playing flags, inactive recording,
idle listener, released pass/job, unchanged connection/registration, and
unchanged normalized binding inspection. Runner results and application-owned
`leave-running-postconditions` lifecycle events retain named failed checks,
redacted before/after scalar values, structured-value hashes, and up to eight
field-level differences (bounded traversal and explicit truncation). They do
not persist full inspection graphs or change any postcondition. Failed
postconditions still prevent independent scenario acceptance, even after a
completed native job and published context.

These diagnostics were absent from `dc7ade30`. Its retained bridge events
record the final `listening.inspect_context` and `session.inspect` request
identities/timing, not their response values; the historical failed field
cannot be reconstructed from those records. No synthetic poststate is assigned
to that actual run, and no retry or corrective policy change follows from the
generic error alone.

The separately attributed observation `b27296c3` again completes and independently
validates the full 30-second native proof/context. Its new final diagnostics
identify exactly `connectionUnchanged` and `registrationUnchanged` as failed:
the connection ID and registration connection epoch changed. Both playing
flags, inactive recording, idle/released listener and normalized binding all
pass. This rules out those seven conditions for this run, not for historical
`dc7ade30`. The timing and cause of the connection change remain unproven;
trace them before deciding whether the runtime or the verifier needs correction.
Bounded actual evidence is
`fixtures/native-v2-long-connection-change-observation.json`. The overall actor
remains failed; no connection invariant is waived.

A complete 928-event typed-journal trace places the b27296c3 change at terminal
delivery: native capture completed at 19:10:55.865Z, result `listener-57` was
accepted at .897Z, and the old connection recorded fatal ingress `internal-error`
at .951Z. Context publication/job completion followed at .991Z/.994Z; a new
connection hello was acknowledged at 19:10:56.136Z. No terminal ACK was recorded.
This is neither a mid-capture native failure nor established as a benign idle
reconnect. The original exception was not retained; do not infer peer-close,
backpressure or any particular throwing operation from this timeline alone.
Evidence is `fixtures/native-v2-terminal-connection-rotation-observation.json`.

Enriched `output.ingress.failed` diagnostics retain a bounded redacted error,
processing phase, active request/dispatch ownership, request timing, socket
metrics and retained owner trace attribution. These fields add attribution
only; authentication, sequencing, frame limits, ACK and close decisions remain
unchanged. A controlled terminal-ACK failure, active sequence denial and stale
ownership cleanup have regression coverage.

The shared producer did contain a separately proven Node write-semantics bug:
it treated `socket.write(false)` as failed delivery and immediately destroyed
the socket. On the installed Node 16.6.0, a 16384-byte write (including newline)
returns false while still delivering the data. A controlled 45879-byte replay
of the retained long-result body delivered once but lost the original client
connection before its delayed ACK. The corrected shared client drains, retains
the connection and consumes the ACK without resending. Server ACKs contain
metadata only and already handle drain correctly.

The new client is `559a7e93552f2e09e1c5b9a11e3b508d147d15b5d173aa2f3933731b30442302`
(46629 bytes). Its bounded FIFO, one-second drain timeout, cancellation and
status contract are specified in
[Output routing](../outputs/multi-agent-output-routing.md#producer-transport-backpressure).
Eleven changed-path regressions fail against the pinned original; corrected
producer/ingress and full Max checks pass. This proves the semantic bug, not
the unretained b272 exception. Saved candidates still contain historical
`bac0eea7`; physical follow-up must explicitly declare the corrected-client
override and preserve original pins, rather than silently rebasing them.

The explicitly attested corrected-client control `898d6ca2` then passes the
reviewed actor and all nine unchanged final checks. The real terminal
`listener-58` ACK is recorded on the same retained connection; a bounded complete
profile query finds no ingress failures. Independent native proof/fresh typed
retrieval confirms all 1,440,000 frames, 300 envelope/spectral windows and
32 before/32 after rows, with context `ddcb4f06-52a3-4d48-a6f0-a854bbd5ac40`.
Before/after loaded-module, class/prototype and ten-function attestations bind
the actual running client to `559a7e93`; exact-owned 87291/88013 cleanup passes.

Full evidence is `fixtures/native-v2-corrected-client-long-capture.json`.
This is a passed instrumented control, not ordinary immutable acceptance or
global readiness promotion. Signal peaks remain 0.5 and positive spectral energy
independently qualifies; fresh FFT alignment legitimately changes the centroid
and positive-window count. Approximate/descriptive-only authority and unknown
physical timing bounds remain. No earlier failed verdict or missing exception
is rewritten.

A separate required observability gap was identified: client559a7e93 emits bounded
backpressure lifecycle callbacks, but the audio runtime ignores them. They do
not reach application-owned local History. The passed898d6ca2 run contains no
retained write-return/drain/watermark measurements, so its loaded-code identity
does not independently prove whether that physical write entered backpressure.
Do not call callback-only coverage journal coverage; the passed capture/ACK
evidence remains valid under its original resource pins.

The software correction forwards actual callbacks through ordinary audio
runtime `d04205d1` and shared client `3825e643` into optional authenticated
heartbeat diagnostics. The existing application recorder/journal and typed
queries receive real source stages, timing, frozen ownership and socket metrics,
without routing them as musical observations. Negotiation, bounds, deduplication
and explicit coverage limitations follow the
[Output transport contract](../outputs/multi-agent-output-routing.md#producer-transport-backpressure).
Seven typed-journal boundary regressions and 592 full Max checks pass, including
the previously missing ordinary-runtime callback path. Native controllerf6 and
Gen321 remain unchanged.

Actual new-resource run `f3b93259` passed full30 native capture, all nine final
checks, the same-connection terminal ACK and fresh typed context retrieval.
Before/after loaded client AND runtime identity checks passed; all owned cleanup
passed. However, a complete typed query of all nine producer diagnostic event
names found zero source write-lifecycle rows and only one App-observed
disconnect coverage gap (`sourceLifecycleCoverage: unknown`). This is NOT a
History qualification pass. The six-second post-actor heartbeat opportunity is
not delivery proof. Actual callback emission, socket write-return and the cause
of the missing rows remain unproven; do not infer backpressure from packet size.
Full actual evidence is retained in
`native-v2-observability-history-observation.json`. Under the newer developer
dogfood target this diagnostic uncertainty is deferred, not relabelled a pass.
Proceed with normal candidate/save and bounded handoff checks; do not retry
solely to manufacture backpressure evidence or weaken the capture checks.

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
Live 11 Arrangement adapter must not use it. The candidate Session adapter also
uses leave-running cleanup and independently requires the source epoch/native
transport join; its actual admitted launch subset remains subject to the
Session qualification gate above.

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

The coordinator bounds preflight inspection plus context reservation to ten
seconds, then gives listener preparation plus the final post-arm safety
inspection a separate ten-second budget. Total pre-playback work is bounded to
twenty seconds, not ten seconds per individual bridge read. There is one active
deadline, replaced at the preparation boundary; an earlier preflight deadline
must not truncate healthy preparation. Final ownership, recording and transport
checks remain mandatory before playback. Readiness progress and timeout events
retain the bounded `readinessBoundary` (`initial-inspection`,
`context-reservation`, `listener-preparation` or `post-arm-inspection`); a
timeout does not imply that the device failed to acknowledge arm.
Each cleanup operation remains bounded to ten seconds.
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

### Placement refresh after device-chain edits (#58)

Listener placement is current metadata, not a fixed device index. The audio
identity companion now opts into `watch`: one generation-fenced Max scheduler
task re-resolves the actual `this_device` anchor and its owning track every
500 ms, independently of the audio polling clock. It emits only changed
identity, or an explicit identity-unavailable transition; an adapter-startup
bang always republishes current state. Loss of identity invalidates the old
registration, and deletion cancels the task and fences late callbacks. MIDI
retains its existing one-shot identity behavior. This bounded refresh does not
claim an immediate Live notification or a sample-accurate edit boundary.

A changed identity reuses registration replacement: fence old callbacks, fail
the old pass, request stop for its exact native generation, close the old
client and create a fresh instance/connection epoch. Path-derived producer IDs
also change when the canonical path changes. Fresh discovery must supply the
current listener ID for a new capture; stale IDs and in-flight proof are never
redirected. This fix does not migrate Output subscriptions or establish a
durable cross-placement producer identity.

Runtime binding validation re-reads authenticated inventory after independent
inspection and the final Set-identity check. It rejects changed registration
before reservation/controls. A bounded connection-scoped attestation cache
also rejects a different same-class device now occupying a previously attested
path, including across separate discovery/capture calls. Cache entries are
not persisted or treated as current proof: every admission still needs a new
query-scoped LOM attestation. Entries are retired with their connection/epoch
or Set and cleared at shutdown. A known stale path resolving to a non-Max
effect reports an actionable stale-placement diagnostic rather than claiming
the original listener changed class. Genuine class, activity, collision,
placement and source denials remain intact.

`listening.runtime.binding-validation.{queued,started,progress,completed,failed,cancelled}`
uses the existing application-owned recorder and typed History boundary, with
bounded/redacted details, elapsed duration and invoking session/agent,
trace/correlation/causation attribution. Normal unchanged metadata sampling
does not create a capture owner or flood History. Registration replacement
retains existing authenticated ingress lifecycle handling; no new transport
message or storage layout is introduced.

The reviewed `native-listening-rebinding` scenario
`native-descriptive-insert-before` qualifies a first beats-0–4 capture, stops
explicitly with recording off, inserts exactly one independently resolved
built-in Delay via `browser.load_item`, independently verifies the added device
and unchanged original listener, then moves that exact Delay before the listener
via `devices.move`. This uses the existing supported load/move APIs, not the
optional adjacent-insert adapter (unavailable on the validation host). It then
verifies the same listener reference at index 1. It waits at most eight
seconds for renewed authenticated registration, then runs the same bounded
actor prompt with the new listener ID. Both passes require independent native
proof and distinct persisted contexts; the original entry must remain
unchanged, the second capture must leave an idle/released listener and running
transport, and no other Set changes are allowed. A failed first pass, edit,
identity check or registration refresh prevents the second capture; there is
no restart, capture retry, class relaxation or timing-budget increase.
Post-edit verification requests the existing 32-parameter protocol limit to
inspect both the added effect and listener; a truncated chain still fails.
This changes only the runner's independent inspection, not capture admission
or the 64-sample timing policy.
The device runtime also preserves its native epoch high-water across
registration/controller renewal. DSP disarm reports zero but retains its
internal epoch high-water; a renewed controller must allocate a newer epoch
instead of reusing a completed, failed or cancelled pass's epoch. This
memory-only allocation fence is not readiness or capture proof: each pass still
requires fresh configuration, native reset acknowledgement and independent
application validation. Exhaustion fails closed without wrapping.

Deterministic source/registration, admission, native cleanup and owned-runner
regressions cover this mechanism. On 2026-10-23 the focused case and separate
fresh-process owning group passed on installed Live 11.3.43: both independently
validated captures before/after insertion, exact identity and Set assertions,
distinct contexts with the prior entry preserved, and exact-owned cleanup.
An isolated visible Default-agent run with ordinary approvals also completed
both captures without restarting Live or Desktop. Typed History independently
validates the received native proofs at epochs 1 then 2; Outputs displays both
distinct contexts and their honest unknown attribution/freshness. Live shows
Delay followed by the same enabled listener. The validation-only Set was saved,
and the owned Desktop/Live processes closed without discarding changes.
The visible edit turn retained an invalid `ableton_transport` action `stop`
probe before the correct approved `set-playing:false`; this is not a claim of
an error-free general agent workflow.

After preserving this implementation in `8d5b935`, merge `aff6742` incorporates
main's #65 (`f23ec65`) containing-track identity guidance and reviewed smoke
ordering/completion corrections without conflicts. Fresh evidence on this
merged branch qualifies the previously denied Session lifecycle standalone
(`cbdc7699`), its complete Session group (`c274539c`), then the 17 remaining
non-native scenarios (`722183c1`). All 19 non-native cases qualify across the
group and remaining selection: 15 pass and four recovered-pass, with all
deterministic postconditions passing, zero approval denials and no policy
violations. Recovered invalid-argument probes remain retained; guards,
allowlists and budgets are unchanged. All exact-owned processes close and a
canonical independent process check confirms no Live remains. These are this
branch's results, not borrowed #56 qualification. The earlier ten-case partial
run and Session wrong-track-name denial remain retained as failed evidence.
The native focused/group/visible evidence above predates the main merge;
the subsequent non-native run does not claim new native qualification.
Live 11 is the support boundary. The installed 11.3.43 results document that
host; an uninstalled 11.3.42 is not a separate development gate. Track future
patch changes in receipts without assuming every patch has been tested.
The historical issue's exact failing
registration was not retained, so these regressions do not retroactively prove
that run's precise cause.

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
read as 11.3.43; retain that exact host provenance. Production has no
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
That baseline does not qualify native capture.
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
The observed host version is Live 11.3.43; this receipt does not certify other
patch versions.

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
