# Playback Listening Developer Dogfood

## Development milestone status

This is a developer/dogfood milestone, not a release-certified listening system.
On 2026-10-21 the developer approved documenting outstanding investigations and
fixing forward. The current native timing fixes and durable-context workflow
remain the delivered scope. Further edit/recovery and fresh-launch qualification
is tracked in [#59](https://github.com/CooperNederhood/Ableton-Agent-App/issues/59);
the source-state investigation is
[#57](https://github.com/CooperNederhood/Ableton-Agent-App/issues/57), and
device-chain listener rebinding is
[#58](https://github.com/CooperNederhood/Ableton-Agent-App/issues/58).
The obsolete device-panel caption is separately tracked in
[#60](https://github.com/CooperNederhood/Ableton-Agent-App/issues/60).

Normal-profile typed History also records a completed 0-4 pass
`5f7b2f32-0cb2-4010-936f-0b1f1f14a89c` and successful retrieval of context
`407089b2-0c8d-43b5-8fc8-3372bbbe3b98` after the updated handoff. This is
recorded normal-profile completion/retrieval, not a new independent native-proof
audit or edited-session acceptance. A later pass after a device-chain edit
failed safely without context publication; #58 retains that evidence.

## Updated timing-fix example

**The reproduced launch/whole-beat timing defects are fixed at `98e30c8` and
`5b6c5d1`, with failing-before/passing-after regressions.** Full Max ownership:
629 tests; owning runner/device suites: 329 tests. The clean native bundle,
without diagnostic overrides, passes all four reviewed real-Live descriptive
scenarios, including the previously failing 0-4 and 4-12 ranges.

Four additional ordinarily approved Default-agent captures complete in the
same packaged App/Live processes, with manual Stop between requests:

| Beats | Pass | Samples / windows |
| --- | --- | --- |
| 0.25-3.75 | `90972702-d9cc-4815-8fea-66cc36bb1f7b` | 84,000 / 18 |
| 0-4 | `f1af9238-a1ed-433e-94e1-ef650ce97e31` | 96,000 / 20 |
| 4-12 | `93615467-8b27-4806-8694-4fe0345cfb71` | 192,000 / 40 |
| 0.25-3.75 | `a0ecd6f7-949c-4ed7-9ad3-13a01bc70218` | 84,000 / 18 |

Independent verification checks native proofs, all four stored observations,
eight range/contributor links, attribution and unchanged source Set bytes.
After full App restart, all four original payload hashes match through
production renderer/preload/main retrieval. Outputs renders the original IDs
and selected context `15727646-8015-420c-b09b-0fb6a8d16e0e`, including its
original sample bounds. Both owned Apps and dedicated Live are closed.
The separate agent stop-refusal turn and earlier setup failures remain retained.
This is bounded repeat/restart evidence, not three new clean fresh-process
workflows, controlled-edit qualification or resolution of the historical
`arrangement_source_unknown` tri-state.

**No App reinstall is required.** The fixed external native companions are
pinned by manifest
`c395d19d8df59e1e729d6aee826f4ab1726ce625ab592921813604f3fdac3846`;
the signed App and normally saved device bytes are unchanged. Open a fresh
Live process to load these companions. The distinct prepared Set is:
`.test-artifacts/machine-listening-human-example-startup-fix/project/AA_NATIVE_DEVELOPER_DOGFOOD.als`.
Its receipt is `.test-artifacts/machine-listening-human-example-startup-fix.json`.
The normal profile, original Set, old example and installed App were untouched.

1. Open this updated Set in Live 11 with recording off and transport stopped.
2. Open `release/mac-arm64/Ableton Agent.app`, select profile `default` and
   agent `Default`, and wait for Connected. Keep Descriptive/64 settings.
3. Ask: "Use the listener on track 3-ML-Calibration-quarter-sine to listen to
   Arrangement beats 0 through 4, at most 8 seconds. Use exactly one capture,
   retrieve its saved observation, and report the pass/context IDs. Leave
   playback running, change no contents, and stop without retrying if it fails."
   Approve the bounded playback request. Expect 96,000 samples/20 windows at
   48 kHz, peak 0.5 and RMS approximately -12.16 dBFS.
4. **Stop Live manually before every further listen.** Capture intentionally
   leaves it running. The application already exposes transport stop through
   `set-playing` / `isPlaying: false`; the agent incorrectly failed to recognize
   it. [#56](https://github.com/CooperNederhood/Ableton-Agent-App/issues/56)
   tracks the incomplete description and real-agent verification, not a missing
   Live capability or proven permissions restriction.
   Repeat with beats 0.25-3.75 and 4-12. This example's 4-12 interval is silent
   on the listener track; expect completed silent measurements, not audio
   from another track. A track-scoped listener does not hear other tracks.
5. Fully quit/reopen the App and use Outputs/View observation to retrieve the
   same saved results without recapture. Freshness and exclusive clip
   attribution remain unknown.

The remaining sections retain the **earlier `9941556` native-bundle**
qualification and human check. Their three-fresh-process result does not
qualify the changed native bundle above.

## Target and limits

**Historical status: bounded normal-profile human MVP check passed, not release certified.**
The corrected signed candidate passed **three consecutive natural Default-agent
workflows**, each with fresh owned Live/App processes, an isolated profile,
ordinary approvals, exactly one capture and zero failed/corrected actor calls.
Each original observation was retrieved through Outputs/View observation after
full same-profile App restart, with unchanged payload hash and no recapture.
Exact process cleanup and unchanged source Set hashes passed for every run.
The earlier ownership, preparation-deadline, native-acquisition and full-Default
discovery defects have regression coverage; their failed receipts remain retained.

| Run | Pass | Context |
| --- | --- | --- |
| 1 | `db6e3409-2686-4d0b-a9e7-a70fc6e358cf` | `c267118e-bd35-4fc8-9483-cffaad1a34df` |
| 2 | `d89d2011-db94-446f-9751-e8a9ef26692b` | `e3015581-6783-4a1a-8c17-b934b974f55e` |
| 3 | `a14c69e0-56b3-45de-b4be-8e3806b00787` | `2b6d3081-9e27-4211-ac88-ada399e5342c` |

All three independently verified 84,000 samples/18 windows at 48 kHz for beats
0.25-3.75, peak 0.5, RMS approximately -12.16 dBFS, centroid approximately
450 Hz and four estimated attacks. Track/range association remains truthful:
freshness and exclusive clip attribution are unknown. Each turn used ten
successful calls, including seven reads of the same pending pass, not retries.
The scripted runtime scenario's eight-call budget is unchanged and is not the
separate attended companion's call budget.

## Human verification example

The earlier generated copy is available at
`.test-artifacts/machine-listening-human-example-9941556/project/AA_NATIVE_DEVELOPER_DOGFOOD.als`.
It includes the paired device, 26 resources and three calibration audio files;
only its copied discovery configuration targets the shared resolver's `default`
profile. Preparation did not modify the normal profile or original developer Set.

1. Open that Set copy in Live 11 first, with transport stopped and recording off.
2. Open `release/mac-arm64/Ableton Agent.app`, not an older installed build.
   Select profile `default` and agent `Default`; wait for Connected.
3. Use the fractional manifest's `desktopQualification.prompt`, or ask:
   “Listen to the listener on track 3-ML-Calibration-quarter-sine over
   Arrangement beats 0.25 through 3.75. Use one capture, retrieve its saved
   observation and describe loudness, dynamics and brightness. Leave playback
   running, change no contents, and stop without retrying if anything fails.”
   Approve the bounded playback request.
4. Expect a completed pass/context with the measurements above. Restart the App
   and open Outputs/View observation: the same result must remain available
   without another listening pass.

The developer completed this check manually in profile `default` with agent
`Default`, after confirming Connected and saving Descriptive/64 settings.
Reported pass `017e9804-969c-41b7-93e3-30bbb553af5e` produced context
`90d5e6f8-99bc-445c-8bb2-e20ff21a5902`, with RMS approximately -12.16 dBFS,
peak 0.5, mean centroid approximately 453 Hz and four estimated attacks.
After fully quitting and reopening the App, the developer confirmed that exact
context, pass ID and measurements remained available without another capture.
This is human-reported desktop acceptance, not a separate independent native
proof audit of that normal-profile pass. The three isolated runs above retain
their independent machine verification.

The M4L development panel still has static legacy “Capture not enabled yet”
wording; it is not the native backend's pass status. Use the App's correlated
pass, stored context and History, not that placeholder, as the result.

## Current source qualification

Native failures are now reproduced with exact data, not inferred from a later
success. Capture-only read pressure exposed a mixed-vector clock read reporting
65 samples; its recorded replay failed before the fix. V2 now reuses bounded
phase-corroborated reacquisition from v1 without changing the anchor or limit.
The first fix then exposed a stopped-clock variant, which remains a hard
failure rather than being ignored. A clock-only scheduler control exposed five
missing FFT frames inside the requested range. The FFT loss guard remains
unchanged. Both authoritative v2 samplers now use scheduler `metro`, not the
dropping low-priority `qmetro`; default/v1 documents remain byte-identical.

The canonical saved-device copy, with **no source overrides**, passes the
ordinary fractional/30-second group. A separate canonical capture-only pressure
diagnostic also completes 1,440,000 samples/300 windows under 56 concurrent
sequential read-only inspections (maximum observed read duration 962 ms), with
independent native proof, reopened typed context and all nine final checks.
The original developer Set/device remain untouched. These are runtime/source
checks, not packaged Desktop acceptance or App-restart retrieval.

All 2,129 TypeScript, 610 Max and 212 Python tests pass after the workspace build.
Two retained full-suite attempts exposed composition fixtures deleting files
before owned services/journals stopped. A test-only ownership/shutdown fix has
two regressions, including a failing-before shutdown-order check; no production
behavior, timeout or cleanup retry changed. All 24 composition tests, workspace
types, build, targeted lint, 12 ordinary Electron tests and the final signed
native-vault provisioning/restart regression pass. Recorded-data tests
cover strict-zero, phase wrap, genuine drift, stopped mismatches, rejection
limits, unchanged FFT failure and exact coverage after reacquisition.

Genuine human Keychain authorization has now unblocked the pinned package.
Attended real-vault provisioning/restart/decryption and the official packaged
regression pass without environment credentials. The first natural packaged
Default-agent request then failed safely before capture: pass `48528b95`
guessed a track reference instead of discovering the listener. Its actual SDK
configuration contained all schema alternatives, but the full-scope early
return omitted the explicit action catalogue used by restricted probes.
That path is now covered by a failing-before/fixed-after regression and receives
the catalogue plus exact-listener discovery guidance. Tools/application: 315
tests pass. The replacement candidate's three packaged workflows above now pass.

The three-run gate is **3/3**, using the fractional manifest's natural
packaged-Default companion rather than its scripted runtime prompt.
None is counted from diagnostic or source runs. Private verifier corrections
(misapplying the scripted call budget and expecting an unrendered duration
literal rather than the actual sample boundaries) are retained with 17
regressions; neither retried an actor turn or capture. Older timing
and spectrum failures without rejected operands cannot be retroactively proven
to have the same cause.

The paired candidate is frozen from source `9941556`: the ad-hoc signed arm64
App verifies with CodeDirectory hash
`c7628cd0e57e27a047a06d09051914f8c02cde1a` and `app.asar` SHA-256
`b2315b563bbff4f5caeb8d8276bae111092eb139869f30a59084aeb13539ad0d`.
The fixed external native bundle is separately pinned by manifest SHA-256
`64fa4693763bacc6c40d8189fd10265f2ec23e014bcbd627fb1b25ca6eef9a61`;
the normally saved device bytes remain unchanged. The failed `48528b95` attempt
belongs to the preceding candidate, not these three successes.
A changed App or native bundle must be repinned and requalified.
App identity alone does not pin the external device's
JS/graph resources.

## Earlier capture and startup receipts

The fixed source passed 1,023 application/runtime/Desktop/owned-host tests,
all 12 Electron tests and 212 Python tests. The first-connect Electron test
verified visible ownership and restart restoration. A fresh reviewed short
native-runtime scenario independently verified pass
`47da7d1b-10ae-4b45-a4cb-7e5c1c2879ec`, context
`1b77622d-4fb9-4478-b6e4-c6feb00269f2`, 84,000 frames/18 windows and all nine
postconditions on Live 11.3.43. These are not packaged listening acceptance.

The exact new signed package was launched with ordinary approvals, an isolated
profile and a runner-owned copy of the saved Set. Before opening its window,
it blocked in macOS Keychain access (`SecKeychainFindGenericPassword` in the
owned startup sample). No authentication prompt was directly observed, so the
precise reason for that Keychain wait is not yet established. No listening
message was submitted and no pass/context was created. The developer was
unavailable to check or handle any OS authentication prompt; access was not
bypassed. Both owned processes were closed and the original
saved Set hash was unchanged. The next physical check requires the developer
to handle any macOS Keychain prompt for this new local signature. A second
isolated launch after the developer reported completing key entry reproduced
the same native Keychain wait. This does not establish that the developer's
entry failed or which application's authorization it applied to.

The missing startup boundary now has a packaged regression:
`pnpm exec playwright test --project=electron-packaged -g 'provisions and decrypts'`.
It removes the environment-token override, uses the real OS vault, and requires
installed-token provisioning followed by restart/decryption, encrypted-only
persistence and typed, redacted credential lifecycle history. Its first run
**failed** waiting for the first window. A later owning-suite run passed native
provision/restart/decryption in 8.5 seconds with the unchanged package; no
production fix explains that transition, so the original startup stall remains
unresolved. Existing packaged startup/authentication tests inject
`ABLETON_AGENT_TOKEN` and bypass provisioning/encryption. Playwright's Electron
launcher does not itself mock Keychain. The candidate and installed app are
ad-hoc signed with different hash-bound identities; fresh authorization is
plausible, but the reason the wait persists remains unresolved.
The same owning run passed package startup/authentication, but the separate
dual-architecture packaging check failed because this dogfood output contains
only arm64, not the required x64 bundle. No x64 qualification is claimed.

After those regressions, the unchanged package opened through the ordinary
direct executable launch, with no environment token, and completed its first
actual native capture using ordinary approval mode:
pass `b6d0d6ca-1aaa-404b-901a-64742e4de7ac`,
context `ac0b00cd-8c22-478c-a062-7af4bd00606b`,
trace `9a9bc28a-d17e-4273-84b0-8beb6ce1f61a`.
Independent verification checked the actual native proof against the requested
0.25-3.75 beat geometry: 84,000 samples, 18 windows, stereo peak 0.5,
RMS -12.16 dBFS and centroid 451.39 Hz. The result was visible in the packaged
app and matched fresh-process typed retrieval after normal App exit. Track/range
links retained unknown attribution/freshness; no exclusive clip claim was added.

This is **not a clean agent-turn acceptance**: the Default agent first supplied
`durationBeats` instead of `endBeat`, attempted a disabled `bash` wait, and used
an invalid context-list call before correcting it. Exactly one real pass was
created and it completed; the tool argument failures remain recorded. Full App-restart retrieval subsequently passed through Outputs and View
observation on the same exact package/profile, with the original IDs, sample
coverage and measurements and no recapture. Normal-profile developer acceptance
and a clean updated-agent turn remain pending. The owned Live copy was initially
left stopped at an unreadable quit dialog; after developer approval, both owned
apps subsequently closed normally. The original saved Set hash is unchanged.

The guidance/verifier fix is committed at `7a3f713`. Its first strict
fractional native run (`dc9d2801-1c09-4d59-99f3-365014bb0c2f`) made the correct
three reviewed tool calls without validation errors or shell waits. Native
pass `b4233bbf-8013-45eb-8231-94a4668878b2` nevertheless failed with
`listening_alignment_budget_exceeded` in capture before any envelope window;
no context was published. Typed failure History preserves the reason, trace,
policy and geometry, but not the rejected measurements. The incomplete
observation's last accepted disagreement is not the fault-time magnitude.
The exact owned Live process exited, fixture cleanup passed and the original
Set was unchanged. The run was not retried; the group and updated-package
steps remain blocked rather than substituting a later successful run.

The target is useful developer feedback, not general release certification.
Use copies of projects and audio you own or generated test audio.

Initial dogfood scope is Arrangement playback plus descriptive analysis, captures
up to 30 seconds, constant tempo, and the default descriptive timing policy
(64 samples). Keep that default initially so failures are comparable.
Do not depend on exact physical onset timing, exclusive clip attribution,
Session listening, transcription, pitch/key recognition, or tempo automation.
Tempo-change work is deferred to issue #55.

The normally saved bundle now passes ordinary, non-instrumented short fractional
and 30-second captures: 84,000 frames/18 windows and 1,440,000 frames/300 windows,
respectively. Both have independently validated native proof, real signal,
fresh-process typed context retrieval and all nine runner postconditions.

The isolated visible app also completed the short capture, displayed its result
and retrieved durable context. It recovered after a first pass failed with
`changed_native_spectrum_sequence` and an intervening playing-transport denial;
this is **not a clean first-attempt pass**. The failed pass remains failed.
The separate earlier group timing rejection also remains unresolved. Evidence
is retained in `max-patches/audio-listener/fixtures/native-v2-developer-dogfood-checkpoint.json`.

## Before developer handoff

- [x] Freeze and normally save the final device bundle, retaining its sibling
      resources; verify the saved references and packaged source identity.
- [x] Bind discovery to the intended normal Desktop profile through the shared
      storage resolver, not a preparation-only automation profile.
- [ ] Developer first launch: verify normal-profile app/device connection.
      Isolated automation does not prove this normal-profile connection.
- [x] Run ordinary, non-instrumented short fractional and 30-second captures.
      Require real signal, correct track/range, durable retrieval and cleanup.
- [x] Exercise visible capture and guarded failure/recovery with isolated
      runner-owned processes. Retain first-attempt failures; cancellation is
      still an exploratory developer check, not physically qualified here.
- [x] Record the exact app/device revision, Live version and sample rate for
      the developer build. Do not silently promote the prototype to globally
      qualified or physically precise.

These are the bounded handoff gates. Exhaustive diagnostic and hardware-matrix
qualification is not a prerequisite for developer use unless it exposes a
functional, safety, persistence or recovery defect.

## Earlier diagnostic checkpoint before acquisition fixes

The fault-time evidence change is committed at `cae70d9`. Alignment failures now
retain the actual rejected operands; spectrum-sequence failures retain the
previous and current packets. These are diagnostic changes, **not established
fixes** for the historical native failures. All timing and integrity guards,
including the default64 limit, remain unchanged.

An owned copy of the normally saved device was refreshed with current canonical
sidecars. The device bytes are unchanged; only the three diagnostic JS resources
and resolver-generated discovery storage differ from the previous candidate.
The original developer project/device were not modified. A fresh short capture
and the fractional/30-second group passed independently checked native coverage,
signal, stored context and cleanup. Their observed alignment disagreements were
1 sample for the short capture and 64 for the long one. A separate stopped-DSP
warmup control passed with zero disagreement; it did not establish the proposed
counter-range hypothesis or explain the old rejection.

The newly signed arm64 diagnostic package has `app.asar` SHA-256
`324ddb928889734186efe3265e86454b6b43db1d844500903ceb757846fc97b6`.
Its real-vault regression again failed before the first window, at owned
PID 55998, and then exceeded teardown's deadline. The native sample and failure
trace are retained. No listening request was submitted and no packaged
qualification run is counted. Exact-PID securityd records now establish the
consent prompt at 13:10:50.370 -0400, before its 13:11:05.285 native wait sample;
no matching approval was found. Earlier PID 88059's sample likewise preceded
its matching approval. Neither establishes a post-consent application hang.
The next startup check must be human-attended so the genuine OS prompt can be
handled without an unattended timeout or credential bypass.

The packaged-test cleanup now bounds graceful close and escalates only against
its captured child process. It retains the original startup failure, attaches
separate timed teardown evidence, and attempts independent cleanup even when
another cleanup step fails. If the owned process cannot be confirmed stopped,
its profile is retained. Fifteen controlled unit regressions pass; six failed
before the fix. No production vault code or package bytes were changed.

The full unit command now passes 2,123 TypeScript, 596 Max and 212 Python tests.
Its initial run exposed a premature rehoming-test assertion: session fields can
be visible while persistence/association is still awaited, before catalog
refresh. The regression now waits for both ownership fields and refresh rather
than treating the in-memory field update as the terminal boundary. No
production rehoming behavior was changed. Desktop/Electron types and targeted
lint pass for the cleanup change; the preceding diagnostic build and 12 ordinary
Electron checks also passed. No App or Live process was launched for this
cleanup validation, and none of these checks substitutes for packaged native
startup.

Human verification remains blocked. The agreed gate is **three consecutive
clean workflows on one unchanged package**, each with fresh owned App/Live
launches, ordinary approvals, independent native/context checks and full App
restart retrieval. Runtime successes and diagnostic controls do not count.

## Last captured package setup (historical, not the current candidate)

The earlier captured Apple Silicon app was at `release/mac-arm64/Ableton Agent.app`;
the installed `/Applications` app is not overwritten by this workflow.
That local package was rebuilt with the first-connection and readiness-budget
fixes (`faa134a` and `349eebe`), ad-hoc signed and verified.
Its `Contents/Resources/app.asar` SHA-256 is
`78ca31e0d8230654af187bde063a1300e499dec0395760f351aa9315ca2006f2`.
The earlier `6ea0d20` package passed startup/authentication checks but failed
developer listening; those checks do not certify this new package.
This is a local developer build, not a notarized release.
The normally saved developer bundle is in
`~/Documents/Machine-Listening-Developer-Dogfood-nBR5zW/`. Open
`Machine-Listening-Developer-Dogfood-Saved.als` and keep
`Native-Listener-Candidate/` and all sibling resources together. No further
device replacement or manual save is required.

Use ordinary approval mode initially, a disposable project copy, a stopped
transport and constant 120 BPM/48 kHz. The automation walkthrough used an isolated
profile and YOLO; the newest packaged capture used ordinary approvals.
Neither is a recommendation to disable developer approvals.
Confirm the normal app reports Connected and discovers the intended listener.
After a pass leaves playback running, explicitly stop it before another capture
when doing so is safe. An already-playing arm is currently guarded.

## First dogfood pass

For each row, record pass/fail and the captured pass/context or History trace ID
when available. Start with a simple constant-tempo Arrangement at 48 kHz.

| Check | What to do | Expected outcome / bug signal |
| --- | --- | --- |
| Basic usefulness | Listen to a short region containing obvious audio. Ask for loudness/dynamics and brightness, then retrieve the saved result. | A terminal completed pass and matching track/range context, not just queued acceptance or confident assistant prose. Clearly audible input must not inexplicably become empty analysis. |
| Musical contrast | Capture comparable regions of silence, sustained sound and percussive sound. | Measurements and descriptions broadly distinguish the inputs. No invented pitch, transcription or exact clip ownership. A genuinely silent region is valid, not automatically a failure. |
| Correct target | Use two audibly different tracks and two different regions. Capture each explicitly. | Each result belongs to the requested listener/track/range. No swapped target or previous-pass data. |
| Boundaries and duration | Try a short nonzero/fractional range, then a 30-second range. | Requested coverage completes without a truncated tail, endless running state or unexplained timing rejection. A single capture over 30 seconds must be refused, not silently truncated or widened; an explicit multi-pass plan is different. |
| Repeatability | Repeat a region several times from stopped transport; separately try an already-playing request. | Completed passes retain separate identities. Already-playing arm is explicitly refused; stop safely before retrying. No reconnect requirement, stuck busy state or accidental overwrite. Exact FFT-derived summaries need not be bit-identical. |
| Persistence | Note a saved result, close normally, reopen the same saved project/app and retrieve it. | The historical result remains available with its original identity/range. Missing or misattributed context is a priority bug. |
| Cancellation and recovery | Cancel a running listening pass through its operation control, then try a short capture. | Cancellation is explicit, partial work is not advertised as complete, and the next pass works without restarting everything. Record actual playback behavior rather than assuming cancellation stops transport. |
| Missing listener | In a throwaway copy, make the requested listener unavailable, then request a capture. Restore it and retry. | Actionable refusal/failure, no fabricated completed analysis, and recovery after the listener is restored. |

Example request, adjusted to an existing listener and a constant 120 BPM Set:

> Use the listener on track "My Track" to listen to the Arrangement from bar 2
> to bar 6. Describe its loudness, dynamics and brightness, and retrieve the
> saved result when the listening pass completes. Leave playback running.
> Do not edit clips, routing or devices. If a pass fails, report its ID and
> reason and stop; do not retry automatically. If transport is already playing,
> ask before stopping it.

This is four bars/eight seconds at 120 BPM. Check the resolved range in the
result; do not rely on the assistant's wording alone.

## Weak spots to explore next

| Area | Useful test / uncertainty |
| --- | --- |
| Packaged native startup | The new no-environment-token vault regression initially timed out, then passed twice without a package change; direct packaged startup subsequently worked. Capture any recurrence before retrying. These successes do not explain the original Keychain stall or certify another ad-hoc signature. |
| Real project signal paths | Try drums, instruments, effect-heavy tracks, stereo/anti-phase audio and track level/mute/solo changes. Compare analysis to the signal reaching the listener: listener placement can differ from what the master output sounds like. Record placement and routing when results surprise you. |
| Multiple listeners | Put listeners on different eligible tracks and request each explicitly. Ambiguity must be surfaced rather than capturing an arbitrary track. |
| Safety guards | On a disposable Set, try listening while recording is already active or the audio engine is unavailable. Expect a clear guard/failure, not disrupted recording or false success. |
| Interruption | Quit/disconnect the device or Live during a disposable capture. Expect terminal failure/cancellation and understandable recovery, not a permanently active pass or completed context. |
| Historical freshness | Edit the source after a capture, then retrieve the old result. It must remain historical/unknown-freshness rather than silently claiming to describe the edited audio. |
| Agent action selection | A first ordinary actor refused before making any call despite all required actions being present in its recorded schema. Scoped descriptions now make action alternatives explicit. Report false "tool unavailable" claims separately from audio failures; this remains a natural-language reliability weak spot to watch. |
| Default-agent retries and tool selection | The visible app recovered, but made failed tool attempts and retried the failed native pass after stopping transport. Do not judge only its final success: retain every failed pass/reason, keep approvals enabled and request no automatic retry when collecting a reproduction. This walkthrough does not establish clean first-attempt reliability. |
| Packaged argument selection | The newest package completed one real pass, but first used `durationBeats` instead of `endBeat`, attempted a disabled `bash` wait and confused context `list` with `get`. Preserve these failed calls independently from the successful native pass; this is an agent-interface reliability gap, not an audio-capture failure. |
| Timing rejection reliability | One ordinary short capture passed with real signal and durable context; the next group attempt failed with `listening_alignment_budget_exceeded` after two windows, published no context and cleaned up correctly. The rejected measurement/magnitude was not retained, so neither its cause nor a suitable tolerance increase is established. Report these failures; do not silently retry until success or loosen integrity guards. The group remains failed. |
| Native spectrum rejection | The first visible-app pass failed with `changed_native_spectrum_sequence`; a later pass completed at the unchanged 64-sample default and survived fresh typed retrieval. The first failure's root cause is not established, and recovery does not erase it or justify relaxing the integrity guard. |
| Device caption | The development device still displays a prototype "Capture not enabled yet" caption even though the per-pass v2 path can complete. Treat the App's authenticated discovery/pass result as authoritative; the static caption is not a live readiness indicator or a release certification. |
| Portability | Save, close and reopen a copied project with its device resources. Missing JS/Gen/audio dependencies, reconnect failures and stale device bindings are priority bugs. |
| Rate/vector settings | Controlled positive evidence is currently 48 kHz/vector 64. Try 44.1 kHz and other practical buffer/vector settings separately and record the actual settings. Intended support and unit coverage are not physical qualification of every combination. |
| Live patch version | Current physical evidence is Live 11.3.43; the contextual target 11.3.42 is not separately qualified. Live 12 is outside scope. |
| Diagnostic completeness | The newest controlled capture succeeded but its typed History had no source write-backpressure lifecycle rows, only an explicit unknown-coverage disconnect. Whether callbacks/backpressure actually occurred is unproven. This is a documented diagnostic uncertainty, not proof audio capture failed. |

Stop normal dogfooding and prioritize a fix for wrong-target capture, unintended
Set edits, recording interference, lost/corrupt context, crashes or recovery
that requires repeatedly restarting Live. Merely imperfect descriptive wording
or absent low-level diagnostics should not be conflated with these failures.

## Useful bug report

Include the exact request, expected versus actual result, approximate time,
pass/context/trace ID, app/device revision, Live version, sample rate, track
and listener placement, region and tempo, whether transport was already
playing, and whether a clean retry worked. Capture the visible error and
relevant typed History details before restarting, when practical.

Do not send credentials, raw profile databases, private project bundles or
audio unless separately requested and deliberately approved. A minimal
reproduction using generated audio is preferable.
