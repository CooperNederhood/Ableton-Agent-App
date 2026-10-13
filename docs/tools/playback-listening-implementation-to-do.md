# Playback Listening Implementation To-Do

Companion specification: [Playback Listening](playback-listening.md).

## Shared foundation

- [x] Decide on bounded playback-first observations and App-session context.
- [ ] Add canonical bounded observation/context contracts and regression tests.
- [ ] Extract MIDI producer connection/registration into shared companions.
- [ ] Preserve MIDI IDs, schemas, subscriptions, JSONL, and overflow behavior.
- [ ] Extend the same authenticated ingress with owned listener control/results.
- [ ] Generalize identity/runtime/publisher helpers where semantics match.
- [ ] Validate mixed MIDI/audio producers and installed shared resources.

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
- [ ] Handle authoring-preview connection collisions explicitly. The ingress
  currently rejects a second connection for the same listener producer; keep
  that guard and do not treat an editor-preview connection as an extra listener.
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
inspection. Explicit inspection/identity guidance now has failing-before-fix
regression coverage; its live rerun executed no scenarios because Live stalled
at MIDI input/output initialization and never exposed the bridge. The owned
process was cleaned up. The full smoke suite and real listening acceptance
remain incomplete; no production gate was enabled.

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
