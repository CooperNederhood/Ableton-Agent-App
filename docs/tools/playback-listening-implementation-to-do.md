# Playback Listening Implementation To-Do

Companion specification: [Playback Listening](playback-listening.md).

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
- Preserve the production timing denial. Producer self-reporting, a generic
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
