# Playback Listening Implementation To-Do

Companion specification: [Playback Listening](playback-listening.md).

## Current priority: developer dogfood

The delivered developer build failed immediately in ordinary use. Prior
controlled successes below are not packaged Desktop acceptance.

- [x] Trace developer timeout `d3987415`: native prepare/arm acknowledged;
  the original ten-second coordinator timer expired in final safety inspection.
- [x] Reproduce cumulative healthy-stage timeout before the fix. Separate
  bounded preflight/reservation and preparation/final-inspection budgets;
  preserve all safety checks, capture deadlines and cleanup.
- [x] Cover healthy cumulative setup beyond ten seconds, stalled post-arm
  inspection, traced boundary/timing, no playback/publication on timeout and
  listener/quota release. Retain cancellation and takeover regressions.
- [x] Rerun the reviewed fractional native scenario on the fixed source:
  pass `47da7d1b`, 84,000 frames/18 windows, independent native proof, durable
  typed context/reopen and all nine postconditions. This remains runtime,
  not packaged Desktop, evidence.
- [ ] Prove one clean first-attempt short capture in the rebuilt production
  package, independently verify context and retrieve it after restart.
  The unchanged package later captured pass `b6d0d6ca`, independently verified
  native proof/context and restored it through Outputs after full App restart.
  That actor corrected invalid calls, so a clean updated-package turn remains
  pending; intermittent Keychain startup remains unexplained.
- [x] Clarify action-specific fields in actual SDK schemas and share
  queued-pass/no-shell-wait/no-retry guidance with configured listening agents.
  Remove the unconditional context-list-before-get instruction for known IDs.
- [x] Add red-before/green-after serialized default/scoped schema, invalid-call
  denial, managed-agent prompt and native verifier regressions.
- [x] Strengthen reviewed v2 manifests/runner to reject any failed actor tool
  instead of accepting a corrected workflow as clean.
- [ ] Qualify the strengthened v2 runner and updated packaged Default agent
  with fresh owned Live processes; retain every failed attempt.
  The first strict fractional run at `7a3f713` used correct tool arguments
  but native pass `b4233bbf` failed with
  `listening_alignment_budget_exceeded` before its first envelope window.
  No context, correction or retry; owned process/fixture cleanup passed.
  Group and updated-package qualification stopped at this gate.
- [x] Retain bounded, traced fault-time native alignment measurements and
  FFT previous/current sequence packets through existing failure diagnostics.
  Add red controller/runtime/contract regressions and validate ingress, SDK,
  bounds, ownership, cancellation/replacement and legacy isolation.
- [ ] Use the new snapshots to
  identify which guard/metric rejects the capture before proposing a fix.
  Older failure History retains only the last accepted alignment.
  Do not raise tolerance or retry-to-pass.
- [ ] Continue diagnosis, regression tests and fixes through every failed
  attempt until three consecutive clean same-package workflows with fresh
  owned processes and restart retrieval pass; only then request human
  normal-profile verification. Missing evidence is engineering work, not an
  external blocker or a reason to end the task.

The user-approved target is a usable developer build plus documented weak spots,
not exhaustive certification. See the
[dogfood handoff and user checklist](playback-listening-dogfood.md).

- [x] Finalize the normally saved current device bundle without source overrides.
- [x] Accept structurally valid single active `PatchSlot` binding without
  requiring optional historical `SourceContext` provenance; retain exact
  topology, path/type, resource and duplicate-listener guards.
- [x] Explicitly enumerate scoped listening actions after the first ordinary
  actor misread its correctly recorded schema; preserve argument validation
  and permission boundaries. No audio pass ran in that failed attempt.
- [x] Pass ordinary short fractional and 30-second capture/storage checks,
  independently validating native proof, durable context and nine final checks.
- [x] Exercise isolated desktop capture and guarded recovery; retain the initial
  spectrum failure, playing-arm denial and later verified completion separately.
  Clean first-attempt reliability and cancellation remain developer checks.
- [x] Document prioritized developer tests, known uncertainties and bug-report
  evidence. Defer unresolved diagnostic completeness unless it demonstrates a
  functional, safety, persistence or recovery defect.

Earlier qualification tasks remain tracked below; they are not all dogfood gates.

## Approved descriptive-listening finish-up

The first milestone assumes constant tempo; it does not promise independently
verified stability. Tempo automation remains unsupported. Existing useful
detected-tempo and timing/integrity guards stay in place.

- [x] Add shared descriptive/strict policy validation: default 64 samples,
  advanced 0..480 samples, immutable evaluation and explicit over-budget denial.
- [x] Define approximate `audio-observation/v2` and typed protocol reading of
  both versions without converting configured tolerance into absolute accuracy.
- [x] Generalize the internal native assembler for 44.1/48 kHz, 30 seconds,
  300 windows, explicit constant-tempo/nonzero coordinates and an exact partial
  final interval; preserve default v1 output. Verify historical source hashes
  against an exact bounded archive and current compatibility separately.
- [x] Establish one real Live 11.3.43 fractional-start primitive with deferred
  marker/position/playing reads and complete owned-probe restoration. Preserve
  the earlier empty-unsaved-name denial separately.
- [x] Define versioned native arm/launch/coverage proof, immutable App
  expectations, fixed-baseline/linear-and-phase extrema and independent descriptor
  checks. Keep held-clock/FFT corruption and transport regression hard failures.
- [x] Retain actual native envelope-window counters alongside processed RMS;
  verify native completeness independently of approximate host alignment.
- [x] Define isolated v2 capability/control/result schemas, actual DSP metadata
  and unchanged 128 KiB complete-result quota, including 30-second wire coverage.
- [x] Activate explicit authenticated v2 channel negotiation and independent
  App-configured arm/launch/result checks, without changing legacy validators.
  Cover version pairing, immutable policy, exact prior-proof binding, counter
  replay, causal/timed lifecycle, failure, cancellation, redaction and watchdogs.
- [x] Extend the existing portable shared client with explicit matching v2
  schema/capability/descriptor/control/result versions and bounded prepare-only
  geometry/policy. Preserve MIDI/v1 defaults and exercise actual authenticated
  shared-client completion, cancellation and disconnect with synthetic proof.
- [x] Keep the v1 App capture adapter from discovering or executing v2 until
  the separately validated playback/context integration is implemented.
- [ ] Generalize controller, engine and native graphs for ordinary music/silence,
  constant tempo, arbitrary ranges and supported DSP metadata.
- [x] Wire guarded source positioning before arm and independently validate
  approximate results through capture, atomic context publication and typed resume.
- [x] Snapshot trusted policy once per pass; derive actual v2 rate/vector/tempo
  geometry, reject mixed/unsupported configurations before reservation, preserve
  requested/quantized ranges and require fresh source/binding reads after positioning.
- [x] Cover exact default64 acceptance/65 rejection, fractional44.1k/127.5BPM,
  one-hop/one-sample-tail/30s geometry, policy immutability, redacted failure and
  cancellation without transport rollback in the production factory.
- [x] Compare identical frozen synthetic measurements under strict and
  descriptive 0/1/64/128/480 policies at both supported rates, including each
  limit-minus-one/exact/plus-one boundary. This pure policy matrix is not
  physical timing evidence or recorded native replay.
- [x] Finish Desktop supported-kind declaration compatibility through additive
  atomic publication while preserving legacy v1-only declarations.
- [ ] Qualify actual v2 native capture through the ordinary production factory,
  not a synthetic producer.
- [x] Align production-factory v2 admission with ingress/capture: exact scope
  and the specific fresh-per-pass blocked reason may attempt genuine proof,
  without changing readiness. Reproduce the first real runner admission failure
  offline; retain all other blocked-reason denials before reservation/positioning.
- [x] Extend the independent integration verifier with explicit v2 App expectations,
  exact native coverage, truthful quantized ranges and reopened alignment; retain
  an explicitly strict/zero legacy scenario without promoting old fixture evidence.
- [x] Generalize the internal capture state machine for explicit v2 geometry,
  immutable expected policy, native proof, alignment lifecycle and confirmed
  cancellation while preserving v1.
- [x] Register typed v2 publication/storage/query/IPC/resume payloads, preserve
  quality in summaries and history, keep requested/measured ranges separate,
  deny exclusive descriptive attribution and reconcile legacy kind declarations.
- [x] Add canonical profile preferences, per-pass snapshots, Settings and visible
  quality/warnings with component, IPC and Electron regression coverage.
- [x] Expose the constant-tempo assumption and unsupported automation in the
  agent tool, discovery and v2 historical Desktop detail. Do not label completion
  as proof that tempo stayed constant.
- [ ] Cover new lifecycle/trace/redaction/failure/cancellation boundaries, then
  qualify reviewed real-Live scenarios and Desktop UX using owned processes.
- [ ] Package/reopen the portable device, measure resource cost and pass-through,
  and reconcile the original issue criteria and actual supported host versions.
- [x] Add explicit v2 authored candidate staging with its matching bootstrap,
  generated graph resources, hashed manifest and honest limits/tempo scope.
  Preserve default/v1 behavior and deny implicit/mixed versions; cover source
  preservation, failure/cancellation and traced packaging lifecycle offline.
  This does not close native load/save/reopen or physical acceptance.
- [x] Add explicitly selected v2 immutable fixture staging, reject mismatched
  caller/input/manifest metadata before copying, and cover source preservation,
  owned discovery-only changes and cancellation cleanup. Retain strict v1
  runner admission; reviewed v2 scenario wiring and a separately pinned native
  fixture remain open.
- [x] Add explicit v2 independent Max-JS watchdog construction with a fixed
  60-second total ceiling, unchanged two-second heartbeat and v1 30-second
  defaults. Reject arbitrary version/deadline arguments, preserve generation
  ownership and traced/redacted lifecycle, and archive exact old guard bytes.
  Generated v2 constructor wiring and physical long-pass cleanup must also be
  qualified; offline watchdog arithmetic alone does not prove device behavior.
- [x] Handle actual forwarded v2 configuration/release selectors in the guard
  without unknown-method errors, deadline renewal, foreign-generation cleanup
  or fabricated native stopped/capture-complete claims.
- [x] Wire reviewed descriptive fractional and 30-second runner scenarios with
  explicit v2 input, immutable pre-capture App expectations/approval bounds,
  actual accepted DSP geometry, sequential fresh owned processes, terminal/
  atomic-context/reopen verification and cleanup receipts. Preserve the old
  strict v1 scenario and deny missing/wrong/null versions before setup.
- [ ] Execute the separately saved/pinned v2 fixture: fractional first,
  then its owning group and remaining suite, followed by isolated Desktop UX.
  Do not mark actual capture or physical qualification complete from synthetic
  runner tests.
- [x] Save and pin the separate v2 source Set with its Session source and
  Arrangement copy; move only that new Set with operator approval and pass
  strict immutable staging. Preserve all original Set/device/WAV pins.
- [ ] Resolve the first post-admission real v2 failure: prepare succeeds but arm
  reports `native_metadata_changed`, followed by unconfirmed cancellation.
  Retain both failed runs and exact-owned process/fixture cleanup evidence;
  do not retry without a narrow regression-backed correction.
- [x] Preserve bounded v2 metadata-failure kind/actual-value attribution and the
  separately rebuilt diagnostic fixture. Record/replay the actual
  `abi-spectrum [0]` denial without weakening ABI validation or attributing the
  earlier generic failures retroactively. The underlying zero remains unresolved.
- [x] Read the canonical Live log for the exact owned diagnostic fixture: two
  `codebox: declarations must come before any expressions` errors follow its
  load. Preserve bounded compiler evidence with the negative fixture; do not
  infer an unnamed codebox or a successful corrected native load.
- [x] Correct the v2 spectrum codebox's sample-rate assignment before inherited
  `History` declarations. The actual emitted-codebox regression fails before
  the correction and passes afterward, including same-line declaration checks;
  preserve v1 graph/root byte hashes. Fresh native acceptance remains required.
- [x] Retain the constant-tempo/unsupported-automation producer limitation in
  every v2 terminal observation; preserve v1 and historical payloads unchanged.
- [x] Reproduce App re-cancellation of terminal v2 arm failure before the fix.
  Accept only attributed, increasing-sequence terminal failures as released wire
  ownership; preserve primary/unconfirmed-stop reasons and v1 compensation.
  Invalid/stale failures still require cleanup; native cancel timeout still
  rejects capture/disarm and removes subscriptions.
- [x] Verify v2 producer failed-arm/cancel settlement waits for actual exact-
  generation stop acknowledgement or explicitly fails its bounded deadline.
  Do not infer native cleanup from the App's terminal wire-ownership flag.
  Cover stale/wrong receipts, reentrancy, duplicate settlement, registration/
  disconnect/stop fencing and pass-ID reuse. Fresh real-Live acceptance remains
  open.
- [x] Normally save and strictly stage the separate compiler-fix fixture, then
  attempt the reviewed fractional scenario. Preserve the actual arm failure
  `invalid_native_spectrum_packet`, no context, no codebox compiler errors and
  successful exact-owned process/fixture cleanup. Do not invent missing raw
  spectrum values or claim capture acceptance.
- [x] Add bounded v2 spectrum rejection check/counter diagnostics with
  fail-before coverage; retain all validation and v1 failure reasons.
- [ ] Identify the actual rejected native spectrum snapshot/cause and complete
  fractional capture before escalating to the descriptive scenario group.
- [x] Add strict, bounded, failed-v2-only numeric failure diagnostics to the
  shared SDK/typed ingress and existing attributed failed History event.
  Fail-before contract/SDK coverage plus authenticated retention and malformed
  input/credential denial cover this non-authority data path.
- [x] Finish generation-owned controller/IO retention of actual rejected packet
  and five existing FFT diagnostics, with honest nulls for unavailable data;
  never use diagnostics to relax validation or fabricate a native receipt.
  Cover frozen failure snapshots, missing metadata, malformed debug values,
  pre-arm/active failure, stop timeout, stale owner and pass reuse. The fresh
  `fbfcbeb` load now verifies native diagnostic delivery to typed History.
- [x] Finish v2-only passive FFT diagnostic taps and snapshot ordering; retain
  frozen v1 graph bytes and avoid claiming atomicity across separate taps.
  Offline regression confirms FFT metadata, ABI, five diagnostic taps, then main
  spectrum ordering. The actual load retained five diagnostic values; separate
  taps still do not establish vector atomicity.
- [x] Build and normally save a fresh immutable diagnostic fixture, then retain
  the actual first rejected numbers and received metadata context. Run
  `3de2099b` failed arm after 42 ms with packet `[-1,0,0,-1,-1,494]`, latest
  FFT diagnostics `[0,1,0,1,255]`, FFT metadata `[2048,2048,2048,1]` and spectrum
  ABI 2. Other metadata remains honestly null. Preserve the actual attributed
  failed journal record, no context and successful exact-owned cleanup in
  `fixtures/native-v2-spectrum-fault-diagnostic.json`; physical cause and
  successful fractional capture remain open.
- [x] Observe actual raw clock packets in a bounded, nonaccepting diagnostic:
  83 received packets, native counters zero, independent host counter advancing,
  DSP on at 48 kHz/vector64, all ABI values 2. Retain first4/last4 snapshots,
  forced failure at 902 ms, zero admission/arm/context, genuine stop ACK and
  verified source/process/fixture preservation. Missing messages are not the
  cause in this probe; the source/update/output distinction remains open.
- [x] Isolate the zero clock using a predeclared fresh diagnostic-only capped
  versus uncapped clock-update contrast, without promoting the uncapped
  expression to production or changing saturation requirements.
  Actual B `b391dacf` changes only the final clock update plus unique resource
  reference/manifest plumbing; received native counters now advance with host
  counters at the same DSP geometry. Spectrum still rejects frames. Preserve
  both outcomes, forced failure at 901 ms, zero admission/arm/context and
  explicit exact-owned cleanup/original-pin receipts.
- [x] Replace the defective capped update with an equivalent saturating v2
  implementation, preserving the original counter ceiling and frozen v1.
  Bounded high/low-word update and equivalent eligibility comparison retain
  saturation and denial; fail-before coverage includes rollover, ceiling edges,
  oversized integer states and epoch/configuration/cancellation boundaries.
- [x] Confirm corrected saturating clock advancement in an actual fresh
  diagnostic process. Run `dfd61716` retained 83 clock packets, first4/last4
  counters 1012160 to 1054144 matching host at DSP48k/vector64/ABI2. Exact emitted
  resource is pinned; forced failure at 900 ms, zero admission/arm/context and
  successful cleanup/original-pin receipts. This is not a physical ceiling
  test or ordinary capture acceptance.
- [x] Isolate the separate remaining spectrum failure using actual FFT-local
  sample rate and retained per-frame failed-predicate flags.
  Run `ae0be55a` reports `[48000,4,15,0,0]`: correct local rate, only finite
  comparisons flagged, all four components, first faulty bin zero and reported
  maximum component magnitude zero. Original guards/math/main outputs/ABI stay
  unchanged; test-only diagnostic values never enter production SDK/History.
  Zero admission/arm/context and explicit cleanup/pin receipts remain intact.
- [x] Contrast original wide finite-input comparisons with a stricter
  small-bound diagnostic control on real inputs. Run `eeaff22d` changes only
  4 main/8 passive comparisons from 1e12 to 1048576; native silence frames now
  publish with zero invalid count and diagnostics `[48000,0,0,-1,0]`. Retain
  comparison-only scope, zero capture admission/arm/context, 902 ms forced
  failure and explicit successful cleanup/pin receipts.
- [x] Implement an equivalent finite-input guard retaining the original inclusive
  1e12 production bound. Bounded `2^20` words with high953674/remainder331776
  replace only the four finite comparisons, with normalized remainder
  arithmetic, fail-before emitted-code tests and independent bounds/adjacent
  doubles/sign/nonfinite/overflow regressions. All other guards/math/rate/ABI
  and frozen v1 remain unchanged.
- [x] Natively confirm idle silence-frame publication from the corrected
  full-range finite guard. Run `c7e9153f` pins the exact current production
  spectrum resource/code, retains 85 valid advancing packets with zero invalid
  count, and does not use the stricter diagnostic ceiling. Forced failure at
  900 ms, zero admission/arm/context and explicit cleanup/pin receipts preserve
  the nonaccepting scope. This does not qualify armed capture or compiler internals.
- [x] Observe the coupled envelope guards without changing original outputs,
  controls or arming. The same run retains 86 private 26-field tuples:
  local clock/capped next/wide literal evaluate to zero; isolated comparison-only
  epoch1 fails its bound; actual advancing counters below the ceiling fail
  validity and projected ends below the ceiling trigger headroom rejection.
  Live epoch remains zero; unconfigured idle state is not an arm failure.
- [x] Correct the directly coupled v2 envelope clock and epoch/counter/headroom
  predicates with equivalent bounded arithmetic, preserving original ceilings,
  strictness, generation/configuration/stop semantics and frozen v1.
  Compute local-clock saturation after epoch reset; include the continuous-clock
  epoch gate. Fail-before regressions cover the actual endpoints and modeled
  86-poll replay, boundary/nonfinite/rollover/reset/cancellation/continuity,
  sealed-ACK distinctions and final tails.
- [x] Observe the corrected native predicates from their exact current clock
  and envelope resources before creating another normally saved immutable
  capture candidate. Run `b9d11054` retains 83 advancing current-clock packets
  and 88 private envelope tuples with advancing local clocks, correct next
  update, passing isolated epoch1/counter bounds and no headroom rejection.
  The untrusted literal remains zero; live epoch/configuration remain disarmed.
  Current FFT retains 88 clean silence frames. Forced failure902ms, zero
  admission/arm/context and successful genuine-stop/callback/process/fixture/
  original-pin cleanup preserve the nonaccepting scope.
- [x] Normally save the separately staged corrected candidate, strictly pin
  its actual Set/device/resources/audio and retry ordinary fractional capture.
  Read-only inspection verifies two AudioClips/one native device/project-local
  dependencies. Run `d7bc78dd` now obtains a genuine epoch1 arm with 32 stopped
  rows, arm counter1026560, DSP48k/vector64 and descriptive64 policy.
- [ ] Resolve the subsequent actual `native_envelope_binding_changed` failure
  before any descriptive group escalation. Preserve the accepted arm but no
  genuine launch receipt, zero retained capture frames/no context and successful
  owned-process/fixture cleanup. The rejected row is unavailable in this run;
  observe its actual arm-counter/rejection values without changing validation,
  callbacks, admission or stop semantics, then add an evidence-backed fix.
- [x] Retain the actual original envelope input through a bounded read-only
  observer, with unchanged controls/admission/validation/callbacks/timers.
  New run `25e47a1f` sees native rejection15 and the unchanged arm counter1094144,
  not a counter-binding change. Original error is rethrown, pass/generation
  matches the actor, no context publishes and all restoration/cleanup/pins pass.
  Keep the prior run's unavailable row null; rejected launch markers are not a
  genuine launch proof. Map and measure the actual Gen predicate next.
- [x] Map native rejection15 to the unchanged delayed-stereo inclusive1e12
  finite-input guard after render-index/continuity validation. Do not confuse
  it with phase14/launch-distance9, interpret rounded phase distance as raw
  phase, or infer actual audio from unchanged held descriptors.
- [x] Latch actual delayed inputs and explicit classification/original per-
  channel guard/passive equivalent word-guard results at rejection15, with exact
  render/counter state, before implementing a production correction. Preserve
  original guards, outputs, controls, timers, stop and admission in the probe.
  Actual `96f88bf6` retains displayable unclipped left/right0, original rechecks0
  and equivalent word checks1, composite rejection1 at n/render/completed0,
  epoch1/serial3 with matching bookends. No inference from held descriptors.
- [x] Correct/minimize native compilation of the passive finite-input probe.
  First run `1da066a2` fails envelope ABI0 with actual Gen compiler errors before
  arm; no delayed values are observed. Preserve the unchanged production
  baseline, failed helper pins and unconfirmed native-stop outcome.
  Separate local-distance B executes and collects the owned fault. It is not a
  matched A/B against the missing-Audio run or proof of compiler internals.
- [x] Correct the production v2 delayed-stereo finite guard with equivalent
  inclusive1e12 bounded words, preserving qualified FFT bytes, frozen v1,
  original controls/timing/phase/coverage/stop rules and descriptor mathematics.
  Share the emitted finite-predicate generator without changing FFT bytes.
- [x] Qualify an explicitly pinned copied-current-envelope control before requesting
  another normal immutable candidate save.
  Run `5f8282f5` completes84,000frames/18envelope/18spectral/32before+after with
  a2,400sample tail, one atomic context and exact canonical fresh-process typed
  reopening. Keep the explicit override/inspector run diagnostic-only.
- [x] Copy verified project-owned WAV snapshots into each isolated fixture at
  their exact project-relative paths before launch, rather than merely hashing
  originals. Fail-before v1/v2 tests, nested/reference/tamper/duplicate/symlink/
  snapshot-race/cancellation/cleanup and legacy absolute-source coverage pass;
  dry staging verifies the three real pinned WAVs and unchanged Set. Persist
  bounded count/hash/size receipts without audio bodies or new raw filenames.
- [x] Verify actual owned Live loading and processed source audio after the
  fixture-copy repair; prior file-open exceptions do not prove zero input.
  Run `96f88bf6` has no fresh WAV-open error and all copied-audio pins pass,
  but its two delayed zeros at fault0 do not qualify non-silent source playback.
  New `5f8282f5` passes predeclared bothpeak0.4..0.6 with actual0.5/0.5; retained
  typed History proves ten positive-energy spectral windows, sum3888175.768319656.
  Source/proof/context reopening and exact-owned cleanup pass. This does not
  grant ordinary immutable-candidate acceptance or a physical timing bound.
- [x] Qualify the normally saved immutable corrected candidate through ordinary
  fractional playback with no inspector or copied-code override. Run83806005
  completes84,000frames/18windows/onecontext, fresh-process typed reopening
  and independent peak/energy/native-proof checks; groupa8785498 repeats the
  fractional pass with a distinct context and exact-owned cleanup.
- [ ] Resolve first actual 30-second failure in groupa8785498. Pass79e8621b
  genuinely arms/launches, then reports33 capture frames at5151ms and fails
  native_envelope_binding_changed with no context. Preserve the unknown raw
  rejected row/code as null, isolate through the read-only observer, and fix
  only the actual predicate. Do not relabel the failed group or widen timing.
- [ ] Resolve the distinct earlier spectrum acquisition failure observed by
  long-scenario observerc6a024c9; later envelope observation does not establish
  physical recovery of that acquisition.
  Actual packet1134592/0/0/1132544/1136640/0 has an old complete interval and
  final tag advanced one2048sample frame, clean FFT diagnostics/ABI2, with
  0 reported frames at1706ms. Assess existing narrowly bounded discard policy;
  never admit/interpolate/rebind the incoherent packet or increase budgets.
  Keep the original33-frame envelope row/code unknown until actually observed.
- [x] Add narrowly scoped v2 old-interval/new-final acquisition discard only
  with an exact matching retained coherent payload/counter, one FFT advance,
  existing1,000ms freshness and shared64-rejection quota. Never admit the packet,
  refresh timestamps, extend deadlines or change v1 recovery.
- [x] Physically load/attest current controllerf6e1e2de through an explicitly pinned
  copied-resource control. C6 did not retain its preceding coherent payload;
  exact-packet regression uses modeled prior state, not observed recovery.
  Run509eb299 retains actual separate later rejection14 with unchanged arm
  counter1083904 and158400 completed samples; no context and cleanup passes.
  Original41efa raw row/code stay null; earlier C6 recovery remains unproven.
 - [x] Observe actual fault-time phase for the later rejection14 before changing
  any phase guard. Packet held launch distance0 is not current raw phase.
  Preserve main outputs/guards/control/deadlines with a reversible passive
  latch. New run 1a8b61cd identifies the range branch with transport-reported
  phase 1/residual 0 and previous phase 0.999958333333333; step checks unevaluated.
  Exact binary endpoint/epsilon remains unproven; original earlier inputs remain
  unknown. Preserve actual 27-field record, ownership, boundedness and cleanup.
 - [x] Disambiguate the rounded endpoint with native comparison flags and an
   independently scaled residual. Run cb1d2aba reports native equal-to-one 1,
   above-one/below-one 0 and scaled residual 0, with coherent owned fault record.
   Earlier probes retain their original precision limits.
 - [x] Canonicalize only the exact periodic endpoint 1 to 0, retaining the strict
  0.01-sample step, counter, finite-input, configuration and coverage guards.
  Do not add an arbitrary epsilon or unconditional wrapping. Establish further
  native precision evidence if needed. Native equality established in cb1d2aba;
  code321fac8f/Genbe01a84e now use consistent exact endpoint semantics.
  Archive pre-change b732; eight regressions fail before, nine new tests and
  all567 owning Max checks pass. No v1/clock/spectrum/IO change.
 - [x] Compile and qualify the exact-endpoint correction through an explicitly
  pinned current-Gen/current-controller copied control, independently validate
  the complete 30-second proof/context/fresh typed read. Run dc7ade30 completes
  1,440,000 frames/300 envelope and spectral windows/32 before+after; peaks0.5
  and positive energy independently qualify. Observed disagreement1 sample;
  physical bounds remain unknown. Overall actor final verifier still fails.
 - [ ] Identify the exact failed leave-running/binding/recording-state condition
  after the otherwise completed dc7ade30 capture. Preserve actor failure and
  actual proof separately; add bounded diagnostic attribution if absent.
  Do not weaken the assertion or infer success from owned-process cleanup.
  Then finish ordinary immutable acceptance and the owning native group.
  Separate observed run b27296c3 identifies only connection/registration
  changes; all seven other checks pass and full native proof/context qualifies.
  Preserve dc7ade30's unknown field; establish the actual reconnect timeline
  and cause before correcting runtime or verifier scope.
  The complete typed timeline places fatal ingress after terminal acceptance
  and before context/job completion, with a new hello afterward. Underlying
  exception and initial close trigger remain unretained; do not call it a
  benign idle reconnect.
 - [x] Add bounded redacted ingress failure attribution for processing phase,
  request/ownership/timing/socket state and retained owner trace IDs without
  changing authentication, sequence, ACK, queue, deadline or close policy.
 - [x] Correct the independently reproduced shared-client `write(false)` misuse:
  bounded same-connection FIFO/drain, no resend, unchanged ACK/auth/epoch/
  sequence authority, explicit limits/failure/cancel cleanup and lifecycle.
  Installed Node16.6 threshold and controlled long-body replay discriminate
  accepted data from delivery failure; eleven changed paths fail on old bac0.
 - [x] Physically qualify explicit corrected client559a7e93 with current
  Gen321/be01 and controllerf6; require actual terminal ACK and all unchanged
  final connection/registration checks. Historical b272 exception stays unknown.
  Run 898d6ca2 passes all nine checks and exact same-connection terminal ACK,
  with independent full 300-window proof/fresh typed context and exact cleanup.
  This is still instrumented, not ordinary immutable acceptance.
 - [ ] Provision a strict current immutable fixture without modifying old
  candidate/input pins; minimize any normal-save step under the existing
  reference inspector contract. Status forwarding is implemented and the
  current bundle is frozen: proceed to the normal save and ordinary short/long
  dogfood checks. Broader group/suite qualification remains tracked separately.
 - [x] Wire actual write-backpressure callbacks through ordinary runtime and
  negotiated authenticated heartbeats into application-owned typed History.
  Preserve frozen source ownership/timing, bounds/redaction, deduplication and
  nonfatal explicit coverage gaps without recursive telemetry or data replay.
 - [ ] Qualify actual native History/socket metrics with new client3825e643 and
  runtime d04205d1 while preserving all capture/ACK/final-state checks. Software
  source/journal tests do not replace this physical qualification. Actual
  f3b93259 passes capture/all nine checks/ACK/fresh context and both loaded
  modules, but complete producer History has no source write rows, only an
  unknown-coverage disconnect. Cause/callback emission/write-return unproven;
  retain as deferred diagnostic uncertainty under the developer dogfood target,
  without blocking the normal save or claiming a History pass.
 - [x] Retain bounded typed before/after leave-running postcondition diagnostics
  with nine unchanged named checks, redacted scalar differences/structured
  hashes, lifecycle timing/trace attribution and failure/cleanup regressions.
  The dc7ade30 response values were not retained: its actual failed field stays
  unknown, and successful native capture/context remains distinct from the
  failed end-to-end actor verdict. No host retry or assertion relaxation.
- [x] Harden the actual shared v2 SDK's immutable inputs, wire/stage/size
  guards, reservation ownership and redacted failures without changing MIDI/v1.
  Cover optional cancellation reasons through the real authenticated TS ingress,
  rather than treating synthetic runtime-only cleanup as that boundary's proof.

### Deferred follow-up, not a first-milestone release gate

- [ ] Independently detect brief/small tempo changes across a pass using genuine
  observed evidence, including within-budget changes and change-and-return.
  Track in [#55](https://github.com/CooperNederhood/Ableton-Agent-App/issues/55).
  Detection/rejection is separate from future support for tempo automation.

The completed contract/geometry and App/Desktop integration items are
prerequisites, not actual descriptive capture. The production factory selects
explicit v2 for default descriptive mode and never falls back to v1; native
device execution and physical/visible qualification remain open. Legacy v1
remains restricted to explicitly selected strict mode.

## Issue 29 checkpoint - 2026-10-13

Original code baseline: `bf61bc3`. Later registration changes and hosted
acceptance after `a0cb4e8` are recorded below. This documentation checkpoint
does not change capture-readiness, transport or storage behavior. Checked
implementation items are not automatically real-Live acceptance.

| Area | Achieved | Remaining acceptance |
| --- | --- | --- |
| Architecture and scope | ADR 0006; bounded playback-first native descriptors and App-session entity context. | Reconcile original issue criteria with the narrow Arrangement prototype; do not silently expand scope to Session onset, transcription or source separation. |
| Native analyzer | Stereo tap; native peak/RMS, estimated envelope-rise attacks and centroid; Gen/FFT corrections, reset/watchdog; continuous normal/anti-phase/silence PCM evidence. Algorithm 1.0.1 fixes split-window duplicate attack estimates and hardens launch validity/vector fences. | Independent native source/host timing, production attacks, transparent pass-through and measured resource cost. |
| Authored packaging | Actual authored layout preserved, adjacent resources, hashes, source/destination guards, explicit profiles, save/reopen evidence and original fallback. | Portable release without the external development MCP bridge; no candidate promotion has occurred. |
| Connection | Shared authenticated MIDI/audio ingress, bounded listener controls and exact instance/epoch binding. After `a0cb4e8`, actual hosted registration and reconnect passed on `14-Audio` with one output, unchanged track/device references and a fresh producer instance. | Independent audio/timing and capture acceptance; automatic editor-preview isolation remains deferred. |
| Capture and tools | Guarded Arrangement assembly, bounded jobs, readiness, owner cancellation, cleanup and publication implemented with deterministic coverage. | Successful real-device capture. Session capture remains unsupported. Production still denies uncommissioned timing. |
| Storage and Desktop | Canonical profile ownership, immutable observations, atomic publication, quota reservation, attribution/freshness, typed queries, resume and synthetic Electron lifecycle/context tests. | A real observation reaching the correct clip/track/range and remaining queryable after resume. |

### Historical preview-classification failure, now superseded

The user freshly loaded the latch candidate on `14 Audio` from
`.test-artifacts/listener-preview-latch-live-2026-10-13/`. The bridge confirmed
the added native latch. Startup now reports `editor_preview_blocked`, although
the Max editor is closed; the isolated App has no discovered listener. Native
preview-state classification is therefore **provisional and not accepted**.
Retaining an early state event does not prove what that state means in each
host/editor context. Tests that inject zero/one prove the gate's implementation,
not the correctness of its host-context interpretation.

The existing handshake is necessary for identity/control/result routing.
Automatic editor-preview isolation is not a prerequisite for the first narrow
prototype. The proposed next development step is a controlled hosted-device
connection with the editor closed and the existing authentication and
single-active-listener protections retained. No gate has been removed or
readiness enabled at this checkpoint; any policy replacement must update the
provisional tests rather than preserve a known-bad assumption.

### Regression baseline and rerun commands

The targeted 20-file listening baseline passed 335 tests, then its broader
owning suites passed 1,183 tests (including those targeted tests). Additional
storage/History, Python, Max and Electron checks below also passed. Counts must
not be added twice. All commands run from the worktree root.

| Boundary | Reproducible owning check | Checkpoint result |
| --- | --- | --- |
| Protocol, ingress, context, coordinator, tools, runtime, Desktop/components | `pnpm exec vitest run packages/protocol packages/signal-routing packages/project-state packages/application packages/runtime packages/tools apps/desktop/src` | 77 files / 1,183 tests passed. |
| Canonical storage, journal, redaction and typed History | `pnpm exec vitest run packages/storage packages/observability` | 6 files / 73 tests passed. |
| Native graph/runtime/artifacts and MIDI shared-client compatibility | `pnpm test:max-patches` | 116 tests passed. |
| Remote Script/Python contracts and simulated commands | `pnpm test:python` | 184 tests passed. |
| Real Electron preload/IPC lifecycle and restart persistence, using synthetic evidence only | Electron command below. | 2 tests passed; no Live playback or audio acceptance claim. |
| Workspace and static artifacts | `pnpm build` and `pnpm audio-listener:check` | Passed for the code baseline. |
| Documentation and diff hygiene | `pnpm docs:check` and `git diff --check` | Required before committing checkpoint updates. |

```bash
pnpm exec playwright test --project=electron --grep 'synthetic listening lifecycle|restores typed listening context'
```

Engineering logs are under `.test-artifacts/issue-29-checkpoint-*.log`; the
commands, results and limitations are recorded here so ignored local logs are
not the only durable evidence.

### Invariants to protect while completing the prototype

- Keep direct stereo pass-through, native DSP/reset/watchdog behavior and
  bounded descriptor/payload rates. Do not replace the authored device or its
  presentation with an unrelated generated harness.
- Preserve MIDI schemas, producer IDs, delivery and compatibility while
  extending the shared authenticated ingress. Do not dispatch to a replacement
  producer instance/connection epoch or another agent's work.
- Preserve recording/transport guards, readiness-before-playback, bounded
  failure/cancellation/cleanup and `leave-running`; capture cancellation is
  not permission to stop or rewind transport.
- Preserve legacy/unscoped production timing denial and require fresh scoped
  native arm/launch/completion proof. Producer self-reporting, a generic
  certificate file, assistant prose and screenshots cannot certify native audio.
- Preserve atomic bounded publication/reservation, canonical profile ownership,
  immutable provenance, honest mixed/unknown attribution and explicit freshness.
  Never persist raw audio or add renderer SQL/filesystem access.
- Preserve application-owned event ordering, bounded redaction, timing and
  trace/correlation/causation attribution through failure and cancellation.
- Update or add failing-before-fix regressions at each changed boundary.
  Start narrow, rerun the owning suite, then use independent Live postconditions
  and visible Desktop checks where applicable. Deterministic tests cannot
  guarantee untested host behavior.

### Completion order

1. Restore one authenticated hosted listener connection and verify exact
   device/track binding; defer automatic editor-preview isolation if necessary.
2. Establish independent real-Live levels, spectral/attack and timing evidence,
   stereo pass-through, gaps, watchdog and error/reset behavior.
3. Prove one bounded Arrangement capture publishes real observations to the
   correct context, including truthful mixed/unknown links and resume.
4. Verify real failure, cancellation, disconnect and timeout cleanup plus
   visible Desktop presentation; add reviewed deterministic Live coverage.
5. Finish portable packaging, versions/licensing/resource-cost/limitations and
   original issue acceptance documentation; checkpoint before promotion.

Session onset support is a separate unaccepted capability, not a blocker for
the narrow Arrangement prototype. The full Live smoke suite and real listening
acceptance remain incomplete; previously passing fixture/scenario groups do not
substitute for them.

## Shared foundation

- [x] Decide on bounded playback-first observations and App-session context.
- [x] Add canonical bounded observation/context contracts and regression tests.
- [x] Extract MIDI producer connection/registration into shared companions.
- [x] Preserve MIDI IDs, schemas, subscriptions, JSONL, and overflow behavior
  with deterministic compatibility coverage.
- [x] Extend the same authenticated ingress with owned listener control/results.
- [ ] Generalize identity/runtime/publisher helpers where semantics match.
- [ ] Validate mixed MIDI/audio producers and installed shared resources.

## Approved connection simplification

- [x] Commit the durable foundation checkpoint and regression baseline at
  `3d368a6`, before changing runtime policy.
- [x] Remove the unverified preview flag as a registration requirement. Keep
  its authored selector compatible without interpreting zero/one as a host
  classifier or capture certificate. Bound malformed diagnostics without
  logging raw values or resetting/disconnecting the listener.
- [x] Replace obsolete preview-policy assertions with failing-before-fix
  registration tests; preserve identity/epoch fencing, partial attribution,
  cancellation, profile/DSP/identity guards and blocked production prepare.
  Installed positive fixtures must not depend on a preview notification.
- [x] Verify exactly one actual authenticated hosted listener in the isolated
  App, with its inspected track/device identity, editor closed, stopped
  playback and unchanged production readiness.
- [x] Verify bounded disconnect/reconnect against the actual owned instance.

The nine registration regressions failed before the policy change and pass
after it. The full Max suite passes 118 tests; five owning ingress/capture/
coordinator suites pass 152 tests. Actual hosted registration and reconnect
were subsequently observed as described below. No production timing gate or
transport policy changed. Native routing/latch objects remain for authored
compatibility, not as registration authority. Automatic editor isolation is
deferred rather than replaced by another unverified detector.

### Hosted connection acceptance after `a0cb4e8`

The fresh isolated App showed exactly one connected Audio-Listener on
`14-Audio`. Two completed agent turns each used only one read-only
`inspect-listeners` call, before and after an adapter stop/restart. Their
expanded observed tool outputs returned one non-truncated listener, unchanged
track/device references and different producer instances. Readiness stayed
false with `real_live_timing_validation_required` and
`source_onset_unverified`. Sample rate and connection epoch are not fields of
this inspection result and were not claimed as inspected.

Independent native inspection confirmed the hosted Max Audio Effect at
`live_set tracks 13 devices 0` (LOM ID `2142`), with one device on `14-Audio`.
Polling was paused before the adapter stopped; Outputs then showed no
discovered output. After native start success and restored 10 ms polling,
Outputs again showed exactly one connected listener. The editor remained
closed and transport stayed stopped. There were no listening passes or stored
observations. This is connection lifecycle evidence, not real capture cleanup.

Only checked runtime/configuration/manifest companions in the already loaded
engineering bundle were published, with backups and traced publication events.
Its AMXD and Node entry were byte-identical to the staged candidate and stayed
unchanged. The User Library was not replaced. A failed auxiliary UI loading
attempt left an empty `15-Audio` track; it remains accounted for, not deleted.
The earlier zero-listener baseline's failed cancel call is retained separately
and is not classified as a clean inspection workflow.

**Historical clean-Set blocker:** the earlier unsaved runner-owned template contained
external-hardware tracks and could not be played for calibration. Approval was
requested to save it under `.test-artifacts/issue-29-preserved-set/` before
opening a clean known-source Set. The user was unavailable, so no save,
discard, Set replacement or playback occurred. Real native measurement,
Arrangement capture/publication, resume and release acceptance remain open.

### Known-PCM native level subset

- [x] User saved the original Set, approved replacement and explicitly approved
  declining recovery of the empty test Set. A fresh owned Live process became
  ready; no pre-existing user process was adopted or terminated.
- [x] Load the checked authored listener and generated quarter-sine PCM in a
  clean Set. Verify the actual source path, disabled warping/looping and one
  hosted device on track index 2. The imported clip renamed the track.
- [x] Observe actual track audio through the native analyzer: stereo peak 0.5,
  maximum 100 ms RMS 0.353553, selected steady centroids 441.668179-459.932376 Hz.
  Check the level subset against independently quantized PCM, not the observed
  result or a MIDI preset.
- [x] Disable/reset manual analysis, remove all four temporary probes, verify
  named cables/direct stereo wiring, and restore the inaudible test's Master
  fader from zero to its observed 0.85 after the source finished. Leave transport
  running; do not save probe changes into the authored AMXD or User Library.
- [x] Retain 100 contiguous native envelope windows spanning the known source
  and trailing silence. Normal and anti-phase whole-fixture energy agree with
  independent quantized PCM within -0.001204 dB; four envelope burst groups are
  present in each. This is level/energy acceptance, not source/host timing or
  production attack-event certification.
- [x] Add an engineering-only bounded native collector: reset plus fresh silent
  window before source fire, 100 contiguous windows, held-counter deduplication,
  12-second timeout, visible failure/cancellation and analysis reset on deletion.
  Export indexed eight-frame ASCII-hex chunks with trace/timing lifecycle data;
  no installed device, readiness or context-publication behavior changes.
- [x] Protect native compatibility and report framing with failing-before-fix
  ES5, eval-scoped handler, JSON-symbol framing and stale-zero launch/baseline
  regressions. Eight targeted tests and the 126-test owning Max suite pass.
- [x] Observe actual anti-phase PCM with non-cancelled spectrum, then 100 silent
  windows after reset. Observe the silence source's actual playing slot
  transition, not just its fire request. Import only generated source assets
  into independently verified empty slots; retain/account for all three clips.
- [x] Exercise actual probe cancellation: retain 28 contiguous windows and
  explicit cancelled outcome after 2,848 ms. Disable/reset analysis, remove six
  temporary objects and verify exact native graph restoration. Verify all
  sources finished before restoring Master volume; leave transport running.
- [ ] Complete production attack events, independent sample/beat alignment,
  FFT/report offsets, transparent pass-through and resource-cost checks.
- [x] Correct phase-dependent duplicate attack estimates in algorithm 1.0.1.
  Replay both recorded normal-envelope phases and anti-phase/silence inputs;
  independently sweep 76 phases across three PCM sources and two thresholds.
  Preserve threshold/spacing semantics, pass reset and historical observations.
  Numeric/replay checks do not certify real host launch timing.
- [x] Require sample/beat/transport validity (mask 19) in approved-runner timing
  declarations. Fail before enabling analysis if launch validity is lost;
  invalidate captures on DSP vector changes. Keep production uncertified.
- [x] Read actual flags 31 and DSP 48 kHz/vector 64 without transport mutation;
  remove both read-only probes and verify exact native graph restoration.
- [x] Observe seven attack/timing-fence regressions failing before their fixes;
  pass the full 137-test Max owning suite, production source/package checks,
  scoped lint and paired documentation checks. Preserve historical algorithm
  observations and reject outdated algorithm certificates. The existing hosted
  engineering bundle has not been promoted/replaced by these code changes.
- [ ] Replace scheduler/Node launch inference with independently validated
  native signal-rate launch/source markers. Do not loosen exact-boundary
  tolerance, infer certificate readiness from flags, or assume legacy tempo
  outlet units without native evidence.
- [ ] Commission timing through a reviewed bound path, then prove actual agent
  Arrangement capture/publication/resume. Manual analyzer enable grants none
  of these capabilities or production readiness.

### Approved bounded native marker proof

- [x] Record user approval for stopped transport, Arrangement beat zero,
  120 BPM, 48 kHz/vector 64 as an engineering proof, not a product restriction.
  Verify recording/arm/source guards and empty target Arrangement before
  copying the exact known Session source to beats 0-4.
- [x] Add a passive engineering Gen marker with bounded arm/active clocks,
  monotonic instance-local epochs, source-onset retention while armed,
  explicit denial/failure/cancellation, and no analysis or readiness authority.
  Extract the shared test-only numeric GenExpr interpreter without replacing
  actual native compilation/execution evidence with model results.
- [x] Correct the native-observed stopped nonzero phase assumption. Observe two
  regressions failing before the fix; cover held phase, pre-launch source input,
  normal/anti-phase/silence, invalid/stale epochs, rate, timeout, stop,
  cancellation and excess-onset guards. Explicit native reload is required
  after the changed external resource; pre-reload attempts are not passes.
- [x] Physically verify four source markers 24,000 samples apart. After reload,
  first input precedes the phase marker by 63 samples, within one vector.
  Verify actual stop/cancel/playing-arm rejection and bounded normal completion.
  Do not hard-code this offset or claim global sample-exact host alignment.
- [x] Disarm both probes, disable/reset analysis, remove all 21 temporary
  objects, and compare the full native graph exactly with its baseline.
  Independently read all source clips stopped, restore observed Master 0.85,
  retain the accounted-for Arrangement source and leave transport running.
- [x] Pass the full 146-test Max owning suite, scoped lint/format checks,
  production resource checks and paired documentation validation. Ingest the
  observed phase/reload/channel-readout gotchas in canonical Max knowledge.
- [ ] Integrate native launch/reset with the actual analyzer and independently
  calibrate global host coordinates and envelope/FFT/report offsets. Retain
  application-owned lifecycle/timing/trace events and instance/epoch fencing.
  The engineering marker is not shipped or a production timing certificate.

### Phase-derived local origin

- [x] Append held launch-phase samples and first-input clock to the engineering
  marker without changing the original six output fields. Keep the 24,000
  samples/beat conversion explicitly scoped to 48 kHz/120 BPM/beat-zero.
  New epochs clear both markers; silence/cancellation cannot invent input.
- [x] Prove the phase-based origin in the actual hosted device for fresh and
  previously stopped phase: 513 minus 1 and 576 minus 64 both give local
  origin 512. All four source offsets match independently read PCM frames
  1, 24001, 48001 and 72001 with zero sample error. Do not derive the origin
  from the first-input marker or generalize this to global coordinates.
- [x] Retain the separate-round-trip arm timeout as failure. Start the fixture
  only from an exact native acknowledged-arm packet; do not widen the deadline
  or use an arbitrary sleep. Remove the failed external harness and all
  temporary native start controls after the experiment.
- [x] Verify unchanged host conditions, all four sources stopped, restored
  Master 0.85, exact full graph restoration and continued transport. Retain
  the existing calibration sources without any new Set/AMXD/library mutation.
- [x] Observe the three phase/first-input model regressions and updated artifact
  contract failing before the extension, then pass all 149 owning Max tests,
  source/resource isolation, scoped lint/format and paired documentation checks.
- [x] Use bounded native pre-roll and signal-rate reset to align real envelope
  windows to the independently verified origin. Reject unhandled phase/rate/
  vector conditions instead of truncating early input or inventing readiness.
  Acceptance is the narrow experiment below, not a production adapter.

### Synchronized native envelope subset

- [x] Compose the original envelope fragments with a 64-sample stereo native
  delay, epoch reset, phase-derived render index, quiet-history/continuity guards
  and complete 100-window coverage. Preserve the production envelope bytes and
  standalone marker behavior; exclude the probe from shipped resources.
- [x] Extend the existing engineering collector with an epoch-bound 13-channel
  mode, same-packet native arm acknowledgement, traced lifecycle/timing,
  bounded export, explicit rejection/timeout/cancellation and timer cleanup.
  Preserve legacy mode; never stop transport as capture cleanup.
- [x] In actual hosted Live, collect fresh- and held-phase windows with origins
  `513 - 1 = 512` and `576 - 64 = 512`. Require all 100 stereo descriptors to
  match between runs, including the input preceding held-phase movement.
- [x] Retain the original first-window PCM discrepancy rather than widening
  tolerance. Temporarily place the clip edge in silence using independently
  read `loop_start = 0.251` seconds, then match all 100 windows to source bytes
  within `1e-12`; maximum observed error is `5.551115123125783e-17`.
  The three-burst window sequence and first/last input offsets (11,953/59,953)
  agree with the phase-derived origin. Restore the original start marker.
- [x] Exercise actual synchronized cancellation (27 retained windows, 2,741 ms)
  and playing-arm denial (zero windows/no source request, rejection 1).
  Read transport still running and all four source clips stopped; restore
  Master 0.85 and remove all fourteen probes. Assert exact original graph
  equality: 130 boxes and 150 cables.
- [x] Check in bounded recorded-native descriptor/lifecycle evidence and source/
  Gen hashes. Add model coverage for normal/anti-phase/silence, first-sample
  retention, new epochs and guards; observe two early/boundary regressions fail
  with a 63-sample tap before restoring the 64-sample implementation.
- [x] Pass all 171 owning Max tests, production resource isolation, scoped
  lint/format, paired documentation and knowledge-root checks. Validate/ingest
  the measured result and limitations in canonical Max knowledge.
- [ ] Integrate global host anchoring and FFT/reset/report offsets with the
  actual runtime, exact instance/epoch ownership and App-wide trace/journal
  events. Verify production attacks and the remaining native source/host matrix
  before enabling capture; engineering collector events do not complete this.

Actual latest host version is Live 11.3.43, independently read from its bundle;
the 48 kHz/vector-64 subset does not separately qualify 11.3.42. The export's
two reserved FFT fields are uncollected placeholders. Production readiness and
packaging remain unchanged, with no certificate-file bypass. The original
first-window discrepancy's host-processing mechanism is still unverified.
The later independent actual-input RMS measurement verifies the native
calculation at that same file-start boundary; only the upstream rendering
mechanism remains uncharacterized.

The earlier unfiltered collection retained only silence and is inconclusive;
the repeated duplicate-filtered collection contains 33 nonzero records and
12 selected steady spectral frames. Bounded processed engineering evidence is
in `.test-artifacts/listener-calibration-native-quarter-sine-levels.json`.
The later bounded collector supersedes the console-fragment coverage limit;
its continuous normal/anti-phase/silence and partial-cancellation evidence is
listed in the companion specification. It does not grant timing readiness.
The earlier stale-bridge attempt also remains a failed preflight, not a pass.
Startup recovery exposed the separate coordinated-readiness deadline bug;
`3d78a19` fixes it with failing-before-fix regressions and 31 passing owning
runner-helper tests. Production capture remains denied.

Desktop discovery now uses canonical profile paths; non-isolated startup
explicitly preserves the existing global legacy MIDI endpoint, while automation
and custom roots skip it. Isolated Electron startup and staged configuration
coverage do not replace real installed-device/Live validation.

## Live and device

- [x] Add exact, bounded activity/dependency inspection and bridge contracts.
- [x] Author a native peak/RMS/attack/centroid source candidate and portable builder.
- [x] Fix Max module-loaded startup and acknowledge handler installation before
  requesting device identity.
- [x] Bound missing-profile diagnostics and native disarm/reset to one per
  distinct failure reason, including a failing-before-fix polling regression.
- [x] Remove the Gen Euler-constant identifier collision and FFT synthesis from
  descriptor transport; reset native holds and poll before frame collection.
- [x] Check on-device continuous sine levels, centroid, opposite-polarity stereo,
  and reset/mute in the authorized development device on Live 11.3.43.
- [x] Stage the actual authored AMXD with its layout and presentation preserved,
  adjacent listener resources, explicit development MCP retention, source and
  nonempty-destination guards, lifecycle events and manifest/hash checks.
- [x] Publish and load the authorized development copy on DRUMS from a dedicated
  User Library folder, retaining the external MCP bridge and original AMXD.
- [x] Verify native loaded-patcher metadata for analysis, spectrum and both Gen
  resources, plus Node entry reveal/Get Info, resolve to the adjacent folder
  rather than the temporary development search path.
- [x] Verify the normal Max editor save/reopen round-trip, preserve presentation
  and relative listener references, recheck stereo wiring, and refresh the
  working development manifest digest after editor serialization.
- [x] Configure the working device for the explicitly selected development
  profile using the shared storage resolver and path-only discovery writer.
- [x] Start the development App ingress and verify its advertised listener
  capability plus the connected Audio-Listener output on DRUMS associated with
  Machine-Listening; verify it remains connected after quiescing the editor
  preview adapter and closing the editor.
- [x] Implement the earlier candidate gate on native `live.thisdevice` preview state,
  retained before Node readiness and read before identity after adapter startup.
  Do not rely on `getstate` to query preview. Unknown,
  malformed and preview states fail closed with bounded diagnostics; preview
  transitions disarm only local analysis, terminate partial passes with existing
  attribution, close registration and fence late callbacks. Add regressions for
  state ordering/denial, polling, recovery, partial-pass timing and cleanup.
  This interpretation was disproved as a reliable hosted-device gate and is
  superseded by the approved connection simplification above.
- [x] Regenerate the canonical patch and normalized authored AMXD; upgrade older
  authored staging with four native routing objects while preserving layout,
  presentation, unrelated cords and stereo pass-through. Reject ambiguous
  startup bindings and partial/conflicting routing.
- [x] Correct the observed early-preview startup race with a cold-inlet
  `int -1` latch and ordered three-bang startup; migrate complete earlier
  three-object routing idempotently. Never infer hosted state from enabled
  state or from an unobserved flag. Add serialized-graph and migration regressions.
- [ ] Deferred after the narrow prototype: validate authoring-preview isolation
  in fresh runner-owned Live: editor
  open, preview on/off, close/reopen, hosted registration continuity, no duplicate
  App listener and transparent audio. The updated candidate is staged only;
  the existing User Library copy is unchanged. A pre-existing user-owned Live
  process blocks isolated validation. Keep the single-active-listener ingress
  guard; do not treat an editor-preview connection as an extra listener.
- [ ] Verify candidate compilation and transparent stereo DSP in actual Max.
- [ ] Verify transport validity, sample timing, quantized launches, and gaps.
- [ ] Reconcile provider limits and physical-ID/bridge-reference binding.
- [ ] Verify idle/error/cancel/disconnect pass-through and watchdog cleanup.
- [x] Consume shared generated profile discovery configuration in staged artifacts.
- [ ] Validate Live 11.3.42/Max/Apple Silicon versions and measured resource cost.
- [ ] Promote/install explicitly without a production MCP dependency.

The candidate builder supports `check`, `build --out <directory>`,
`build-authored --source <device.amxd> --out <empty-directory>
[--keep-authoring-bridge]`, and `check-artifact <directory>`; it does not
implement install/promotion. Authored manifest format 2 distinguishes portable
listener resources from the explicitly retained external development bridge.
Canonical format-1 manifests remain readable. Failed/cancelled stages can leave
partial resource files for inspection, not an installable success.
Numeric/model/wire/artifact tests do not prove Max compilation or Live timing.
Limited direct native checks now have measured peak/RMS/centroid and reset
evidence, but independent PCM, timing, passthrough, save/reopen and App capture
acceptance are still outstanding. Development resource paths are not a
portable installed-device claim.
The production startup has no certificate-file bypass and fails preparation
with `real_live_timing_validation_required`. Generated profile configuration is
consumed through the shared reader without a separate parser or legacy audio
fallback. Configuration/isolation tests do not certify actual authentication,
DSP or real-device readiness.

Preview-isolation checkpoint: the new runtime regressions failed before the
guard, and canonical-source/checkpoint-asset checks detected the missing native
routing before regeneration. The focused runtime/artifact/profile suites pass
37 tests, and the full Max owning suite passes 114 tests; workspace build,
listener static checks, scoped lint and paired-document checks pass.
`.test-artifacts/listener-preview-isolation-2026-10-13/` holds a checked,
development-only staging bundle with no profile credentials/configuration.
No User Library replacement, editor round-trip or real-Live preview acceptance
was performed for this candidate. The pre-existing manual Live process remains
user-owned; it was not adopted, mutated or terminated.

Subsequent runner-owned Live validation confirmed the staged device on
`14-Audio`, native DSP at 48 kHz/vector 64, valid canonical identity and host
metadata, and stopped playback. The isolated App was recovered after its
process exited; Live connectivity returned but the earlier candidate still
discovered no listener. Native probes showed `getstate` emitting enabled state
on outlet 1 and no preview flag on outlet 2, while startup had sent preview
before Node readiness. Temporary probes were removed. The latch correction
passes 27 focused tests and all 116 Max owning tests, plus listener static
checks; fresh-load registration and preview-toggle acceptance are still
pending in that historical checkpoint. A subsequent fresh load retains state
but reports `editor_preview_blocked` with the editor closed; see the current
checkpoint above. The production timing gate is unchanged.

## Native host/FFT continuation - 2026-10-14

- [x] Bind 32 coherent native host/counter/phase brackets before and after
  capture, discarding torn snapshots without averaging or invented stopped PPQ.
- [x] Add bounded traced host-clock and tagged-FFT engineering collectors with
  deterministic denial, invalid input, timeout, cancellation and deletion cleanup.
- [x] Preserve canonical production spectrum/envelope bytes while composing
  separate clock-anchored envelope and full-frame tagged-FFT experiments.
- [x] Measure one actual held-phase, beat-zero, 120 BPM/48 kHz/vector 64
  normal-PCM capture at source offset 12,048. Its absolute inferred origin plus
  independent host offset equals the independent PPQ intercept exactly.
- [x] Compare all 100 native stereo envelope windows and all 64 tagged FFT
  intervals with independently quantized/transformed PCM, including exact
  silence and both-channel energy. No fitted scale or shifted reference.
- [x] Retain source/code-bound processed evidence and failed native bound/reload
  attempts. Regress one-sample origin/tags, wrong host offset, missing stereo
  energy, gaps, pre-launch gating and native wide-bound hazards.
- [ ] Generalize the accepted signal-rate launch and coherent FFT coordinates
  into the actual listener/runtime, preserving instance/epoch/trace fences.
- [x] Add an internal, unactivated signal-mode engine path with native epoch/
  reset acknowledgement, validated pre/post 32-row bindings, no scheduler
  launch reset, exact latest FFT grid/interval checks, scoped controls, causal
  stage events and bounded failure/cancellation/cleanup regression coverage.
- [x] Include the coordinate validator in both bundle resource declarations
  and preserve installed-artifact and canonical wire contracts.
- [x] Define bounded optional native arm/launch/completion evidence on the
  existing listener reply/result topology, with a narrow opt-in scope and no
  certificate loader or new registration service.
- [x] Independently validate native origin/offset, exact envelope/beat coverage,
  latest FFT intervals/grid/centroid/energy-weighted summary and all 32 timely
  post-capture brackets at the App
  capture boundary. Fence missing/changed proof, scope changes and stale owners.
- [x] Forward source native lifecycle and processed evidence through bounded,
  recursively redacted existing journal records with namespaced causal event
  IDs, SDK trace propagation and no renderer/storage/upload expansion.
- [x] Regress native scope denial before controls, arm/launch/completion evidence,
  queued-result ordering, fractional-beat integer windows, cancellation, cleanup,
  authenticated wire transport, causal attribution and credential redaction
  with explicitly synthetic fixtures; this is not native runtime acceptance.
- [ ] Connect that engine path to actual Node/Max native messages and forward
  its actual lifecycle/evidence through the implemented App boundary;
  deterministic recorded-coordinate replay with synthetic timely host callbacks
  is not runtime acceptance.
- [x] Add bounded envelope/latest-FFT assembly with exact owner/epoch/source
  tags, stable invalid-frame counts, changed-hold/gap/torn/future denial,
  fixed queue quotas, failure cleanup and idempotent/reentrant cancellation.
- [x] Compose recorded nonzero/silent coordinates through the actual assembler,
  engine, independent App validator and strict wire schema, using explicitly
  synthetic timely host/post callbacks. Keep FFT window metadata distinct from
  envelope cadence and preserve below-floor centroid weighting.
- [x] Independently measure actual plugin-input RMS with integer-delay MSP
  averaging/sample-hold at native window completion. At source offset zero,
  all 100 stereo windows pass the predeclared `1e-12` squared-error bound
  (maximum `8.326672684688674e-17`), including the disputed first window.
- [x] Preserve the raw-WAV/input distinction and normalized gain units without
  fitted corrections or claiming an unproven Live fade. Retain processed
  source/code-bound evidence, global-handler/request-gated-poll regressions,
  exact graph restoration and leave-running cleanup.
- [x] Expose an abortable pass-owned native-onset receipt resolved only after
  all scoped proofs validate and all arm replies arrive. Await it after an
  unverified scheduler start only for an entirely native scoped cohort; deny
  missing proofs, legacy promises and mixed-cohort upgrades.
- [x] Regress buffered ordering, multiple listeners, no-onset arm/progress,
  invalid proof, capture timeout, cancellation, changed epochs, late receipt,
  failed bounded monitor cleanup, redaction and traced lifecycle timing.
  Preserve shipping commissioning denial; actual native delivery remains open.
- [x] Replace the signal engine's certificate prerequisite with bounded fresh
  per-pass stopped brackets, native DSP/FFT information and tagged FFT baseline.
  Reject stale/moving/torn/sparse measurements, certificate substitution,
  changed ACK binding and first-frame FFT-grid drift; retain immutable evidence.
- [x] Gather fresh preflight immediately before actual native arm in the
  bounded Node/Max controller. Keep wire-prepare eligibility separate from
  reset proof, require all executed ABI markers and enforce reset deadlines.
  Bound known pre-arm epoch snapshots without accepting them as acknowledgement;
  deny unknown/future and post-ACK changes. Preserve synchronous reply ordering.
- [x] Regress Node16.6 compatibility without `Object.hasOwn`; reproduce the
  original first-metadata failure and verify the fix under Max's exact binary.
- [x] Generate an inactive native message graph with three actual DSP ABI
  outlets and an ES5 generation-fenced IO helper, preserving existing graphs
  and math. Bound/deduplicate metadata without dropping descriptor changes.
- [x] Compose native parents into the authored graph without replacing its
  presentation, stereo path or SDK client. Preserve all old runtime routes,
  isolate native control/message wiring and deny ambiguous/unsafe composition.
  Check the actual preserved authored source without loading/saving it.
- [ ] Package and exercise the candidate entry/resources with native generation
  watchdog, real authenticated runtime delivery and fresh host acceptance.
- [x] Implement candidate-only authored staging with the explicit native wrapper,
  relative adjacent generated resources, bounded manifest limits, hashes and
  unchanged default builds. No installation/promotion or real-host claim.
- [x] Extend the existing Max watchdog with generation-owned native controls,
  redacted trace context, 2-second heartbeat/30-second total bounds and exact
  stop on replacement/deletion. Wire fail-closed control order and preserve
  independent clock/FFT and transport. Actual loaded-host acceptance is open.
- [x] Add bounded optional preflight/reset/capture phase and generation metadata
  to native lifecycle contracts and phase-specific History events with one
  cross-phase causal UUID namespace. Forward at most 200 actual diagnostics
  after armed reply and before capture events; preserve local-only failed
  pre-arm outcomes, ownership, cancellation and overflow denial.
- [x] Integrate the native controller into the existing SDK runtime with one
  client, synchronous armed-reply ordering, frozen attack settings and bounded
  reentrant control handling. Publish watchdog context before native begin.
  Pass 25 runtime regressions, 320 owning Max tests and 301 broader
  protocol/ingress/capture/runtime-host tests; full workspace build passes.
  Fresh authenticated native delivery and actual tool/context/resume remain open.
- [x] Verify real compiled ABI/message delivery with 84 clock and 85
  envelope/spectrum packets, all ABI values 1, observed DSP/FFT metadata and
  32 coherent host brackets; correct physical poly~ outlet numbering.
  Retain initial failures and exact six-root/130-box/150-cable cleanup.
- [x] Connect the actual native graph, Node controller and authenticated channel.
  Actual pass `596663d0-0a70-4285-8d95-894df152524e` establishes full fresh
  preflight/reset/arm/launch/capture proof and App publication. ABI-only data
  and cached proof remain insufficient for any future pass.
- [x] Load the approved portable candidate as an additional device in fresh
  owned Live with corrected Python. Verify exact browser/device identity and
  authenticated listener discovery through typed tool results, preserving
  original device and blocked readiness. This is not capture acceptance.
- [x] Reproduce the first real capture's strict inspection-range failure before
  native controls or publication. Project only beat bounds into bridge range;
  require strict request parsing in all host inspection fixtures and native
  source-start fixtures. Focused regression fails before fix; 52 host tests pass.
- [x] Reload the corrected App runtime and repeat candidate-only beats 0-4.
  Retain the 396 ms range failure, 1416 ms recording-state denial and 1657 ms
  unknown-override denial with empty publication. Actual track override is
  unavailable and global override false; this is not absent-clip evidence.
- [x] Share conservative Live 11 override evidence between inspection and
  mutation guards. Require clear global state and both idle slots when the
  track flag is unavailable; accept Arrangement `-2` only after source start.
  Require canonical overdub, treat only an absent optional alias as optional,
  and deny unreadable/unknown/contradictory recording evidence. Reproduce
  failures before fix; pass 200 Python, 137 protocol/simulator bridge and 679
  broader owning TypeScript tests.
  Actual Python alias absence remains unqualified.
- [x] Preserve the additional-device state as a separate named calibration Set;
  verify two saved effects versus one in the untouched original. Match installed
  Python source hashes, pass fresh runner-owned capability baseline and reopen
  the copy with authenticated discovery. Baseline is not native acceptance.
- [x] Retain fourth real pass: inspection and reservation complete, actual
  device prepare rejects `unsupported_native_capture_scope` after 3814 ms,
  with no arm, source start or context IDs. Reproduce generic 512-window
  dispatch against the native 100-window contract; send the exact native
  window count, reject 101/512 before control/subscription and preserve the
  valid 100 ceiling and non-native 512 behavior. Pass 122 capture/host, 683
  broader TypeScript, 320 Max and 200 Python tests; build/type-check pass.
- [x] Reload the corrected App budget and complete one fresh candidate-only
  pass: 32 before/32 post brackets, 20 envelope/20 FFT windows, 96,000 frames,
  beats 0-4 and 8199 ms whole workflow. Independently validate actual wire proof
  and exact typed context `335ff745-4c1c-4d61-b7b6-57a84aec4881`.
- [x] Preserve bounded authenticated proof and source hashes as a regression
  fixture. Match all relative descriptors to prior actual controller results
  and four settled PCM RMS windows within `1e-12`, without fitting. Cover
  causal phase ordering, native/canonical/context identity, corrupted proof,
  unknown attribution/readiness and exact leave-running command scope.
  Pass six new recorded-evidence regressions and all 326 owning Max tests.
- [x] Compose the actual controller/engine/assembler with N4M and native graph;
  observe genuine reset ACK and launch, then independently validate their
  origin in the App protocol without claiming authenticated wire acceptance.
- [x] Wrap periodic host phase at signal rate before snapshot, protecting
  integer-beat floating overshoot without delaying counters or weakening
  validators. Preserve all original Gen/envelope/FFT bytes and timing bounds.
- [x] Recover at most 64 torn active/postcheck acquisitions without using their
  coordinates or refreshing host age. Bound pending envelopes to eight packets
  awaiting fresh coherent covering host/FFT; never interpolate or widen bounds.
- [x] Complete a real 20-window/96000-sample/20-FFT pass with 32 coherent
  before/post brackets, independently accepted by actual App schemas and
  capture assertion. Preserve source hashes, trace ancestry, four failed trials,
  corruption guards and exact cleanup. Recorded proof cannot authorize a fresh
  capture; authenticated channel/context publication remain open.
- [x] Admit only a fixed-scope native cohort to fresh App-side validation without
  falsely upgrading `UNVERIFIED/BLOCKED` registration or `ready: false` discovery.
  Deny unsupported tempo/position/rate/range and mixed cohorts before reservation.
  Require armed proof before source start and measured launch/full proof before
  publication; preserve legacy/unscoped denial and traced cleanup.
- [x] Extend deterministic native admission and production composition coverage
  to honest blocked status, missing arm, invalid completion, unsupported scope,
  discovery and unchanged readiness. Synthetic tests are not real SDK acceptance.
- [x] Apply exact native-scope eligibility at authenticated ingress `prepare`,
  preserving blocked registration and unscoped denial. Exercise real socket
  framing, synthetic native proof, causal attribution and unchanged ownership;
  this is not actual Node/native capture delivery acceptance.
- [x] Skip an exact same-position Arrangement seek after arm, retaining all
  guards, position readback and revision revalidation when no seek occurred.
  Distinguish pre-mutation denial/errors from indeterminate attempted starts;
  regress phase-sensitive setters, revision changes and leave-running failure.
  The actual physical phase effect and fresh-runner acceptance remain open.
- [x] Observe actual stopped-beat-zero native IO with all three ABI values 1,
  32 coherent host brackets and a complete recent FFT baseline. Regress
  recorded-coordinate preflight, freshness denial, source hashes and exact
  graph/Automation Arm cleanup; do not authorize arm from cached evidence.
- [x] Replace prior-stop resume with guarded `start_playing` only for a matching
  existing insert marker. Independently read a necessary seek on a later tick,
  revalidate before source start and verify running/Set/marker/transport later.
  Preserve skipped-seek revision checks, bounded executor progress, unverified
  acknowledgement and indeterminate leave-running failures.
- [x] Regress asynchronous seek/start, old-resume denial, marker mismatch/change,
  missing/failed scheduling and post-start recording changes at Python and
  simulator-backed bridge boundaries; preserve all original guards.
- [x] Qualify fresh installed Python source start on owned Live 11.3.43:
  guarded source acknowledgement plus independent measured native launch and
  complete capture succeed. Preserve all guards and the original saved Set.
  This is not exact supported 11.3.42 qualification.
- [x] Contrast actual marker-zero Max `start_playing` with the prior continue
  behavior: observed running beat12.866375 after6.460 seconds, not the old
  stop above13931. Preserve unchanged marker, exact one-helper cleanup and
  restored Automation Arm. This is not native launch or Python acceptance.
- [ ] Verify the broader native source/host matrix, production reset and
  cancellation/disconnect behavior; the single offset fixture is not a certificate.
- [x] Prove real agent playback-and-listen publishes one correct track/range
  context and typed get matches the actual complete canonical observation.
  Attribution/freshness remain unknown; do not claim exclusive clip audio.
- [x] Prove exact typed retrieval after Desktop process restart/resume:
  distinct process, new endpoint publication and later typed get return the
  original context/pass/subject/time and complete observation unchanged.
  Verify only three read calls, still-blocked readiness and continued
  transport; preserve actual restart evidence and a seventh regression.
  All 327 owning Max tests pass.
- [x] Preserve actual post-arm source-denial cleanup: epoch 2 armed, existing
  insert-marker guard denied start, exact generation cancelled with zero
  frames, authenticated cancel acknowledgement and no publication. Three
  independent reads found no failed-pass context, unchanged original context
  and stopped transport at beat 0. Three recorded-evidence regressions retain
  this distinct failure case; active-capture cancellation is not proven.
- [ ] Add reviewed runner-native acceptance using explicit staged-candidate
  loading and production listening/context composition; the narrow hooks,
  reviewed manifest, exact terminal wait and independent verifier are
  implemented with deterministic coverage. The user-approved separate
  candidate-only fixture is saved, all WAVs pinned, copied native registration
  and stopped preflight proven. Full real acceptance remains pending:
  the first actual actor-driven cold capture failed its clock-continuity guard
  after five windows, with no publication. The original two-listener Set is
  still rejected before launch; no
  unsupported XML rewriting or dependency execution is used to bypass setup.
  Both formerly missing runner hooks are implemented. Do not silently
  install/promote or add fake/skipped proof.
- [x] Correct runner signal-ingress lifecycle after the first actual
  discovery-only timeout: start the existing service before application
  startup and always attempt its shutdown, including partial startup and
  failed application stop. Preserve bounded causal stage events and
  failure/cancellation regressions. This does not qualify real capture.
- [x] Reuse production credential publication/owned removal and agent-service
  startup; adapt the production metadata-shaped approval request. Add failing
  regressions for each actual runner bootstrap omission and preserve private
  file permissions plus partial-start/application-stop cleanup.
- [x] Preserve actual cold-runner arm/launch followed by clock-continuity denial:
  five incomplete windows, no publication and no context-store reference.
  Retain the separate denied actor context-ID request; no recovered-pass claim.
- [x] Collect exact numeric clock and FFT inputs with an owned loopback Node
  inspector, immediate resume/closure and no saved candidate/DSP changes.
  Preserve the one-vector phase/counter mismatch and held-to-next FFT tag tear.
- [x] Add exact-cohort bounded acquisition rejection and causal typed progress,
  retaining unchanged accepted offsets, timing/freshness/coverage, quotas and
  cleanup. Require 32 fresh exact stopped rows before committing any initial
  clock binding; candidate restarts never extend the preflight deadline.
- [x] Preserve actual diagnostic recovery of both cohorts, full native proof,
  publication and unchanged typed reopening in a new process. Keep capture
  source hashes distinct from later revisions. Exact current bytes also
  completed an inspector-attached diagnostic (recoveries at frames 13/15),
  with independently valid proof and new-process typed retrieval. This does
  not grant immutable-candidate or ordinary scenario acceptance.
- [x] Protect failed-quit fallback against an already exited process, exit
  during signalling and replacement PID; reproduce all three regressions first.
- [x] Provision a separately rebuilt calibration project and normally Live-save
  its runner Set with operator assistance. Verify strict saved references and
  preserve all three original Set hashes plus the original candidate manifest.
- [x] Preserve the new ordinary pre-launch clock denial and a separate actual
  stopped/armed +64 offset diagnostic. Held phase cannot establish the earlier
  playing acquisition cohort; retain denial, exact-generation cleanup and zero
  publication. Record the failed copied `qmetro` -> `metro` experiment without
  promoting it or claiming its cancellation uncertainty is resolved.
- [x] Record one fail-only runtime-instrumented stopped-clock lookahead:
  offsets -1/0/0 across prior/rejected/following rows. No data is admitted after
  the fault; failure is forced within 100 ms. Preserve this separate unknown
  exact-binding case without changing production tolerance or acceptance.
- [x] Obtain explicit approval for an uncertainty-aware proof prototype with
  publication still gated. Add an unpackaged conditional interval analyzer,
  explicit assumed acquisition bounds, one shared 64-sample error budget and
  regressions proving it cannot become a current arm proof or capture authority.
- [ ] Independently measure physical acquisition bounds and compose host,
  native-onset and FFT uncertainty before designing the versioned replacement
  proof. Add traced lifecycle, protocol/runtime and real-Live failure coverage
  before any activation; never promote a conditional arithmetic result.
- [ ] Finish current-source and immutable-candidate cold-run qualification.
  Later clock-continuity/pre-arm failures remain unresolved and safely publish
  nothing. Do not turn a successful source-override diagnostic into standard
  scenario acceptance or weaken source/clock guards to hide remaining failures.
- [ ] Complete deterministic integration and visible Desktop acceptance.

The measured host offset is `842480212`; arm counter `166446080` and local
origin 512 give absolute origin `166446592`, exactly matching the post-launch
PPQ intercept `1008926804` after conversion. Before/after bindings each retained
32 pairs and discarded three torn reads. All 100 envelope windows match
independent PCM within `1e-12`; all 64 FFT windows (20 nonzero) match exact
source intervals within `1e-9` Hz centroid and `1e-12` relative energy, with
exact zero silence. The fixture is
`max-patches/audio-listener/fixtures/native-host-spectrum.json`.

Native guard mask 253 rejected wide integer, decimal and constant-folded
power bounds; split-word bounds passed without widening validity. In-place
native reload yielded zero snapshots/lost diagnostic cables and is denied by
the engineering wrapper, not reported as a successful deployment. Recreate
the owned probe with fresh staged resources instead. Production readiness and
resources are unchanged; the running host is 11.3.43, not separately qualified
11.3.42.

## Application context

- [x] Add App-session-owned repository, canonical resolver, quotas, and pruning.
- [x] Require pre-arming context quota reservation in the coordinator; retain
  quota through publication and release on terminal cleanup with late-abort
  compensation, caller attribution, and visible release failures.
- [x] Link caller abort through pending resolution and capture, install the
  completion waiter before queued notification, and cancel owned background
  passes after SDK idle without cancelling another agent's work.
- [x] Support bounded capture with explicit `leave-running` cleanup: release
  local monitors without stopping/rewinding transport on success or cancellation,
  and surface monitor-release failures in the terminal result.
- [x] Wire the guarded Arrangement backend and production runtime to the
  `leave-running` policy without an ownership token or timing certification.
- [ ] Expose continued playback in visible listening lifecycle copy.
- [ ] Verify actual quantized source onset before enabling Session listening.
- [x] Preserve immutable passes and independent attribution/freshness links.
- [x] Restore bounded queryable context on resume without session/Set leakage.
- [ ] Add guarded Session/Arrangement play-and-listen and owner-scoped jobs.
- [x] Adapt typed repository list/get/prune and bounded inventory to owner-scoped
  tool callbacks, including per-query traces and explicit freshness.
- [x] Implement the owner-scoped listening tool/job facade, bounded opaque job
  pagination, and explicit deferred-stage owner/trace forwarding.
- [x] Project complete observations into atomic multi-tap context publications
  with distinct entries, primary/contributor links and unknown initial freshness.
- [x] Supply the shared bridge/ingress through a runtime host factory with an
  obligatory terminal-pass lease boundary and ordered shutdown.
- [ ] Handle transport takeover, denial, recording, cancellation, and failures.
- [ ] Propagate lifecycle/timing/trace IDs through every boundary.
- [ ] Expose redacted typed Desktop context/history/progress/approval surfaces.

Implemented headless foundations include optional typed tool registration,
per-invoking-agent App-session attribution, a guarded coordinator, bounded
readiness/cleanup, owner-only cancellation, and terminal-completion lease
contracts. Canonical Desktop persistence/resume and readonly context surfaces are wired.
Independent canonical-path binding and concrete same-ingress capture are
implemented. Exclusive transport ownership cannot be established from Live 11
property notifications; the Arrangement backend uses bounded capture with
continued playback rather than an unsafe automatic stop. Native timing remains
unverified; the concrete runtime factory and Desktop wiring deny capture before
controls until independent commissioning evidence exists. Positive production
execution and visible listening lifecycle acceptance are incomplete.
The items above are not end-to-end completion claims.

## Validation

Latest isolated runs verified the Operator source fixture and the session-clip
group, including owned-process cleanup. The broader run completed eleven
passing scenarios before legacy group shutdown failed. Coordinated startup now
has a tested bounded deadline. Arrangement clip lifecycle subsequently passed,
but region-fill cleanup correctly failed because the agent skipped its required
inspection. Explicit inspection/identity guidance has failing-before-fix
regression coverage. After an initial rerun was blocked at MIDI startup and
the operator confirmed normal startup had recovered, the corrected isolated
region-fill scenario passed with exactly one fill, one required inspection,
two tile deletions and complete baseline restoration; corrected argument
probes remain recorded as a recovered pass. Owned-process cleanup completed.
The full owning-group rerun again timed out before bridge readiness and executed
no scenarios. Its exact owned process was cleaned up; a later manually launched
Live process was not adopted or controlled by the runner. The full owning group,
remaining smoke groups and real listening acceptance remain incomplete; no
production gate was enabled.

- [x] Generate independent PCM sine, silence and anti-phase source fixtures
  with exact quarter-note spacing, gates and quantized peak/RMS references.
- [x] Add a canonical-result numeric verifier with independent host anchors,
  bounded level/frequency/attack tolerances, and negative measurement cases.
- [x] Add a reviewed, tool-built Operator Arrangement source-fixture manifest
  with exact quarter-note onsets and deterministic MIDI/device assertions,
  explicitly excluding playback and listening-readiness claims.
- [x] Correct the source fixture to the observed Live 11 capability surface:
  write an exact Session source, then duplicate it into Arrangement; deny
  unsupported direct creation rather than broadening the runtime capabilities.
- [ ] Show new regression tests fail without the corresponding implementation.
- [ ] Run smallest suites, then broader owning suites and compatibility checks.
- [ ] Add reviewed Live manifests and deterministic measurement/state verifiers.
- [ ] Run integration-testing on runner-owned Live, then desktop-ux-testing.
- [x] Verify context survives closure/restart/resume independently of the journal.
- [ ] Gate production enablement until timing/attribution/device evidence exists.

The numeric verifier currently has synthetic regression coverage only. No real
listening scenario invokes it yet; actual Max compilation, timing calibration,
guarded playback and real attribution remain acceptance gates. Synthetic Electron
persistence/resume passes and is not actual listening evidence.
Synthetic coverage distinguishes the candidate's FFT analysis window from its
separate 100 ms reporting hop so centroid tolerances do not use the wrong size.
