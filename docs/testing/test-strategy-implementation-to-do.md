# Test Strategy Implementation To-Do

Companion specification: [Test Strategy](test-strategy.md)

## Test infrastructure

- [x] Select and configure TypeScript and Python test runners.
- [x] Add shared fixture, fake clock, fake ID, and log-capture utilities.
- [x] Build fake LOM object library.
- [x] Build simulated Python Remote Script server.
- [x] Build fake Copilot/session adapters for deterministic client tests.
- [x] Define test tags for unit, contract, integration, Electron, and real Live.
- [x] Keep Max CJS/MJS node:test suites and private diagnostic helpers out of
  Vitest discovery; retain the dedicated Max test command.
- [x] Preserve validator failure through CI diagnostic logging with explicit
  Bash pipefail. Exercise the actual workflow command with controlled passing
  and failing validators and assert retained stdout/stderr logs and cleanup.
- [x] Synchronize first-connected session fixtures on restoration completion,
  not early in-memory identity. Hold association persistence deterministically
  to cover event absence before settlement and publication afterward.
- [x] Pin CLI test subprocesses to the actual Node executable with explicit TS
  loading, register exit observation before signaling, and use prompt events
  rather than polling. Cover failed-test child/pipe cleanup and register
  completion cleanup for timeout paths without increasing deadlines.
- [x] Execute native source-schema tests on Node 20 with explicit TS loading
  and supported asynchronous source resolution. Preserve root restrictions,
  existing-JS preference and exact error propagation, including rejected
  asynchronous resolution.
- [x] Make plain-Node calibration build/check/verification use scoped TS imports;
  cover child commands without inherited loaders or native type stripping.

## Coverage implementation

- [x] Add unit-test requirements to every package template.
- [x] Implement cross-language protocol contract test runner.
- [~] Implement bridge fault-injection tests.
  - [x] Cover fragmentation, malformed frames, disconnects, reconnects,
    sequence gaps, and stale ownership.
  - [ ] Cover explicit queue saturation and cancellation races.
- [x] Implement workflow fake-bridge tests.
- [x] Cover Session clip identity guards, MIDI/audio duplication, launch
  recovery, destructive deletion, property rollback, capability gates, and
  simulator bridge parity.
- [x] Cover Arrangement loop finite bounds and rollback, runtime-stable cue
  references, reversible creation, destructive deletion, and simulator parity.
- [x] Cover Arrangement region-fill exact fits, reported remainders, bounded
  Live-tick chunks, mid-batch rollback, bridge parity, and mutation timeout
  uncertainty.
- [x] Cover bounded device/parameter pages, exact identity guards, quantized
  normalized mapping, disabled parameters, rollback, and simulator parity.
  - [x] Cover serial concurrent reads, dispatch-scoped timeout budgets,
    long-running Echo-style parameter inspection, bounded Session device
    summaries, prepared-context mutation invalidation, and a runner-owned Echo
    parameter-inspection scenario.
- [x] Cover bounded rack/chain/pad pages, exact nested identity guards,
  runtime-reference pruning, no-recursion behavior, CLI reads, and simulator
  parity.
- [x] Cover bounded Browser roots/children/search, deterministic traversal,
  strict node/result/depth/time limits, exact item revalidation, prohibited
  plug-in loading, approved CLI loading, and simulator bridge parity.
  - [x] Cover equivalent Browser URI encodings, loadable/navigable native
    devices, structured SDK failures, and the runner-owned Auto Filter audio
    scenario.
- [x] Cover strict Live 11 core-domain unions, per-action risk/scope/capability
  resolution, read-versus-mutation protocol separation, Python handler
  identity/rollback paths, simulator parity, and runner-owned scene, track, and
  transport inspection scenarios.
  - [x] Cover grouped-tool automatic-analysis policy, destructive note removal,
    scheduled-stop state, valid audio range ordering/rollback, exact warp-mode
    availability, and documented Live 11 scalar domains.
  - [x] Cover recording/history safety, exact empty-slot intent, workflow-job
    ordering, cancellation, bounded lifecycle payloads, and trace/correlation
    propagation for the final workflow-adapter layer.
- [x] Implement CLI transcript tests.
- [x] Implement Playwright Electron harness.
- [x] Add a production-mode smoke test for the generated macOS application and
  packaged resources.
- [x] Cover the debug-control contract, automation launch parsing, selected
  agent/YOLO startup, visible external user-turn attribution, and stdio MCP
  adapter arguments.
- [ ] Add deterministic local-journal fixtures for clocks, IDs, sensitive
  payloads, concurrent appends, size accounting, and persistence failures.
- [ ] Cover agent configuration snapshots and complete SDK, tool/workflow,
  approval, bridge, Live Event, and Output lifecycle producers.
- [ ] Cover producer/writer redaction, trace/correlation/causation propagation,
  per-agent fan-out isolation, and Desktop history visibility.
- [ ] Cover default-on and local-only behavior, pause/clear/per-session deletion,
  30-day pruning, 250 MiB eviction, restart, and interrupted writes.
- [ ] Cover indexed cursor/filter queries, stable concurrent pagination,
  cancellable stale requests, bounded ingestion, saturation, and degraded mode.
- [~] Create real-Live test project and manual runner.
  - [x] Add synthetic transport-stop coverage for safe playing setup, exact
    stop-argument approval guards, actor call/postcondition attribution,
    unchanged contents/settings, no retry, lifecycle tracing and owned cleanup.
    Include unsafe recording, refusal/prose-only success, still-playing state,
    incomplete/reversed evidence, timeout/cancellation, checkpoint and cleanup
    failures; do not equate synthetic coverage with real-agent acceptance.
  - [x] Complete real-agent `transport-stop` acceptance from independently
    confirmed playing transport, with an exact ordinarily approved stop,
    independently stopped postconditions, unchanged content/settings and
    successful owned-process cleanup. Focused and transport-group runs pass on
    2026-10-23 UTC (run IDs `ffb898d8-f6d3-4f52-8d73-dddc9e6fa548` and
    `5967d360-2f8a-41d2-8686-d1b0a7d21a6e`). Earlier admission correctly refused
    a pre-existing user process; execution began only after the user closed it
    and #58 explicitly released its separate runner slot.
  - [x] Reproduce and fix the first real-run verifier false negative: the agent
    stopped playback correctly, but the SDK appended post-tool-hook guidance
    to the JSON result. Validate the protocol payload before only that exact
    recognized transport-success separator. Regress the recorded result,
    unknown prose, other-tool guidance, unverified payload and missing result.
    The new positive regression fails without the fix; all 186 owning
    CLI/runner tests pass with it. No mutation guard or postcondition is relaxed.
  - [~] Complete the subsequent isolated visible Default-agent check with
    ordinary approvals and independent before/after state. Message
    `8ab0f753-f3fc-444e-8048-639cb8d3b1fa`, trace
    `7c0d20ac-d728-4e67-98e4-05ecacf59fc6`, appears once in the selected Default
    conversation. The normal approval UI displays exact `set-playing` /
    `isPlaying: false`; Approve once leads to a completed operation and turn,
    an enabled composer, and a visible verified true-to-false result. Live is
    visibly stopped before Desktop closes. Independent reads before Desktop
    launch and after Desktop closes, but before Live cleanup, confirm playing
    then stopped, recording off, and unchanged bounded content/settings
    (14 tracks, 13 Session clips, no Arrangement clips). Concurrent readers
    timed out while Desktop held the bridge, so independent reads bracketed
    Desktop's lifetime.
    Empirical host evidence is Live Suite 11.3.43, not separate qualification
    of the specified 11.3.42 build.
  - [ ] Finish explicit owned Live cleanup before calling visible acceptance
    complete or releasing the shared test slot. Desktop PIDs 41322 and 45044
    closed successfully. Live PID 40458, started 2026-10-23 01:15:01 local time,
    remains open after an unsaved-Set prompt. A non-destructive Save As attempt
    did not persist the Set; subsequent background close actions did not exit.
    The user was unavailable for explicit discard approval, so no discard or
    forced Live termination was performed. The Node UX controller was stopped
    without signaling Live; both isolated Desktop profiles and all failure
    evidence are retained. Save/close that validation Set or obtain explicit
    discard approval, confirm exact process exit, then release ownership.
  - [~] Escalate #56 acceptance to the remaining non-native real-Live suite.
    Run `3590fab9-0ee5-4910-aa9e-6986c73e0598` passed 10 scenarios across
    inspection, Live Events, tracks and the first Session-clip scenario, then
    stopped at `session-clip-lifecycle`: the agent supplied the clip name
    instead of the required track name for launch `expectedName`, and the
    unchanged approval guard correctly denied it. The partial Set is retained
    in the failure trace; all four owned processes were cleaned up.
    A fresh standalone run `83c93030-667f-45c6-9269-533a3b1a4963` passes without
    changing code, prompts, guards or budgets, but complete-group reproduction
    `be123273-529f-4db2-aaca-78730b71516d` fails at the same guard. Preserve both
    outcomes; do not call the broader suite green or hide failures with retries.
    Seven later non-native scenarios remain unexecuted in this qualification.
    Native listening groups require separate version-pinned fixture inputs and
    are not claimed as executed by #56.
  - [x] Run the broad repository quality components for #56.
    Build, repository formatting, full `pnpm lint`, all workspace/Electron-test
    typechecks and static/device/contract checks pass. Independent stop-harness
    review found no significant issues; Max patch tests (631), Python tests
    (212), and isolated non-Live Electron tests (12) pass. The final TypeScript
    suite, including the new framing regressions, passes all 2312 tests in
    136 files with
    `pnpm exec vitest run --maxWorkers=1`, without changing deadlines or retries.
    Earlier concurrent runs timed out in unchanged reasoning-visibility and
    native-v2 cases, and an earlier broad lint run was stopped after prolonged
    execution. Those failures remain recorded in session evidence; the final
    serialized suite and fresh full lint pass do not establish complete
    real-Live acceptance or successful visible-workflow cleanup.
  - [x] Add a runner that records versioned, commit-linked smoke evidence
    without storing project content.
  - [x] Make exact-PID cleanup tolerate process-exit races at the final
    liveness check and when a timed helper process has already exited.
  - [x] Give computer-use-coordinated UX readiness a bounded 600-second default
    without changing ordinary 120-second readiness or explicit helper deadlines;
    disable automatic recovery discard in coordinated startup. Cover successful
    late readiness, both timeout boundaries and explicit overrides.
  - [ ] Create and publish the canonical Ableton Live test project.
  - [ ] Record real-Live results for Session launch quantization and rollback,
    MIDI/audio duplication compatibility, deletion, and mute/loop property
    availability.
  - [ ] Record real-Live results for Arrangement loop setters, cue-point
    identity stability, naming, creation rollback, and deletion verification.
  - [ ] Record real-Live results for multi-tile region fill timing, complete
    rollback, and MIDI/warped/unwarped final-boundary behavior.
  - [ ] Record real-Live results for Device On discovery, native/plug-in
    parameter writability, quantized values, setter failures, and rollback.
  - [ ] Record real-Live results for rack/Drum Rack capabilities, chain/pad
    identity and ordering, empty pads, pad chains, and direct chain devices.
  - [ ] Record real-Live results for Browser roots, BrowserItem properties and
    URI stability, child ordering/latency, selected-track and hotswap behavior,
    `Browser.load_item` timing, track compatibility, multi-device presets, and
    indeterminate failure reporting.
  - [ ] Record real-Live results for recording/capture, Groove Pool,
    selection/view, Session automation, warp markers, and each optional
    Simpler/Looper/Wavetable API shape.

## CI

- [x] Add formatting, lint, typecheck, unit, contract, and integration jobs.
- [x] Add macOS build/smoke jobs.
- [ ] Restore Windows build/smoke jobs before Windows release support.
- [x] Cache dependencies without caching generated test results.
- [x] Publish validation/build diagnostics on failure.
- [x] Enforce package build and protocol compatibility checks.
- [x] Build workspace entry points before tests that execute compiled package
  and CLI subprocesses.
- [x] Document how real-Live release validation is recorded.

## Quality controls

- [x] Define minimum critical-path coverage expectations.
- [x] Require regression tests with bug fixes.
- [x] Track flaky tests and prevent silent retries from hiding failures.
- [x] Add deterministic timeouts to all process/network tests.
- [x] Add security-oriented malformed-input/fuzz coverage.
- [ ] Add journal payload/schema fuzzing and tests proving sensitive fixture
  values never reach disk, query view models, diagnostics, or exports.

## Tests

- [x] Unit-test test-support utilities and fixture builders.
- [x] Integration-test the test runners themselves against known pass/fail
  fixtures.
- [x] Verify CI reports failures, timeouts, and artifacts correctly.
- [x] Run a clean-checkout rehearsal of every documented test command.
- [ ] Add sustained-ingestion and cap-sized query benchmarks enforcing 200 ms
  p95 first-page queries without visible SDK streaming or event-delivery stalls.

## Exit criteria

- [x] A clean checkout can run all non-Live tests with one command.
- [x] CI covers every application-owned boundary.
- [x] Release checklist includes recorded real-Live results.
- [x] Test failures provide enough diagnostics to reproduce locally.
