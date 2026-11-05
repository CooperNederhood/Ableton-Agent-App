# Test Strategy Implementation To-Do

## F3 mel-band smoke scope (#105)

- [x] Select full feature implementation with one existing-fixture packaged
  smoke, not a broader numerical or Arrangement real-host campaign.
- [x] Add independent bounded mel calculations and analytic periodic-Hann
  tone/impulse, gain, zeros and malformed-input tests at 44.1/48 kHz.
- [ ] Qualify actual analyzer frame/support and loss accounting independently
  of message deliveries before enabling authoritative publication.
- [x] Verify the compiled pinned-core engine against the independent numerical
  oracle and modeled capture origin, including retrospective vector offsets.
  This does not substitute for generated-graph or real-host evidence.
- [x] Add controller red/green mel-only and independent partial-result tests,
  physical cleanup/readiness guards, and stored default-four-metric runtime
  checks. Producer/reducer ownership: 120 passing tests; runtime: 263.
- [ ] Cover typed vectors/ratios, complete/partial budgets, lifecycle,
  cancellation, cleanup, report paging/reopening and affected Desktop boundaries.
- [ ] Register and execute the separately approved single packaged case on the
  unchanged `session-clip-identify` fixture; preserve terminal receipt and
  actual matched candidate/dependency/Live identities.
- [x] Register and admit `session-flucoma-melbands-smoke` offline on the unchanged
  fixture. Require separate mapped-adapter proof, native terminal-consumption
  facts, intact vectors/ratios/pages, actual agent consumption and restart
  persistence; registration does not establish a real-host pass.
- [ ] Complete the separately scoped applicable visual gate after exact-state
  validation. Leave broader numerical and Arrangement qualification deferred.

## Local suite qualification (#82)

- [x] Regress nested cleanup-cause preservation, evidence/resource failure
      separation, and lease release only with case-bound reclamation proof.

- [x] Cover discovery, one-attempt execution, blocked/unrun cases, cancellation,
      safe continuation and ambiguous ownership with deterministic regressions.
- [x] Reject stale candidate/catalog evidence, malformed terminal receipts,
      missing assertions, failed cleanup and failed persistence.
- [x] Validate lifecycle timing, trace attribution, bounded redaction and host
      serialization; keep hosted CI free of licensed Live launches.
- [ ] Record one complete discovered real-host suite result without automatic
      retries; product qualification remains separate from infrastructure checks.

Companion specification: [Test Strategy](test-strategy.md)

## Test infrastructure

- [x] Scope integration-testing activation to selected real-host validation or
  concrete Live-postcondition evidence gaps. Remove blanket code-change
  triggers and automatic scenario/group/full-suite escalation; stop at agreed
  terminal results while preserving failures and qualification limits.
- [x] Offer human-in-the-loop durable fixture authoring once per new user-facing
  agent capability, early enough for test-driven development. Honor prior
  decisions; decline/unavailability defers authoring without blocking ordinary
  implementation or lower-layer regressions.
- [x] Document current command discovery and separate runtime, unpackaged Electron,
  packaged smoke and attended MCP/UX evidence. Preserve packaged installer
  coverage and keep the future multi-turn packaged runner out of part 1.
- [x] Define receipt-v2 coverage/attempt boundaries: retain selected/executed/unrun
  identities, distinguish first-attempt and recovered results, reject silently
  excluded explicit IDs, and require non-success for skipped/blocked/unrun work.
  Verified expected refusal/partial contracts remain separate from capability
  success; unsupported prose cannot override failures.
- [x] Specify provisional native execution checkpoints versus terminal cleanup
  results; document separate checkpoint/final files, `executionClassification`,
  run provenance, final coverage and `observedTools` fields. Keep primary and
  cleanup/write failures and historical versions.
- [x] Document source-imported canonical receipt sanitization before build,
  owner-only atomic writes and receipt/string bounds with audio/binary omission.
  Distinguish successful cleanup from failed checkpoint persistence and preserve
  blocked/cancelled outcomes; observed native tools come from actual starts.
- [x] Align existing integration/UX skills with targeted selection, exact native
  inputs, stateful scenario boundaries, ordinary qualification approvals and
  resolver-owned isolated storage with explicit endpoint discovery.
- [x] Extend packaging triggers to Desktop's transitive workspace/test closure,
  Electron/configuration, bundled definitions and payload builder helpers;
  preserve payload-build ordering and existing jobs.
- [x] Validate workflow ownership before/after the fix: two missing-filter
  regressions fail before the change, all three contract tests pass afterward.
  The broader test-support suite passes 36 tests across six files; docs check
  validates 56 documents/plans and the new contract passes ESLint. These are
  deterministic configuration checks, not an Electron or physical Live run.
- [x] Extract side-effect-free native fixture/evidence test-support modules;
  filesystem callers own their roots and explicit disposal. Guard executable
  test imports and hook registration without changing owning assertions.
  The fixture-cleanup workstream's final report has 459 focused tests and lint
  passing; original owning assertions are preserved.
- [x] Complete broader native helper-extraction validation: 602 tests pass.
  These synthetic results do not establish real-Live qualification.
- [x] Complete shared reporting/finalization deterministic validation. The
  pre-reconciliation full `pnpm check` passes build, format/lint/docs/ownership,
  contracts/typecheck, 193 Vitest files / 3721 tests, 814 Max tests and 286 Python
  tests. An installed-artifact test timed out once during a concurrent scripts
  run, then passed standalone and in the full gate without threshold changes.
  Preserve that failed attempt rather than describing the work as first-run clean.
- [x] Complete the final blocked-native-admission provenance follow-up:
  `sourceRevision` / `sourceDirty` are present before native refusal and process
  inspection, verified red/green. The full-gate result above precedes this last
  change; the final complete scripts suite passes 39 files / 918 tests with
  `maxWorkers=2`, without increasing timeouts or skipping tests. Final selected
  formatting/lint/diff checks pass. Physical qualification remains blocked.
- [x] Document nonempty independent assertions and matching selected identity /
  completed trace requirements for clean CLI passes; retain started scenario
  records on setup/execution exceptions.
- [x] Complete physical reporting validation after the unowned Live precondition
  clears. Preserve the earlier blocked receipt for PID 32309 and the post-merge
  guard refusal for PID 78254. After user-confirmed closure, the connection
  scenario, full inspection group and remaining non-native suite pass on
  Live 11.3.43: nineteen distinct scenarios, fourteen clean and five recovered,
  no second-attempt retries, no selected skips/unrun work, verified cleanup.
  All ten owned processes closed; the final guard found no Live process.
  The recovered track/clip/Arrangement cases remain visible, not clean passes.
- [x] Reconcile the testing refactor with merged main `f84303e` after upstream
  publication fixes and qualification. Preserve strict reporting, isolated
  fixture helpers, packaging-reuse checks and the corrected `spectralEnergy`
  verifier. Replace obsolete unqualified/not-installed guidance without erasing
  historical failed receipts.
- [x] Record upstream bounded production-bundle qualification and reinstallation,
  including matched payload inventories and the corrected silent-tail scenario
  and group. The current [listening checkpoint](../tools/playback-listening.md)
  retains a later repeat failure and unresolved musical interpretation; this
  does not qualify the refactored runner or unrestricted listening.
- [x] Complete post-reconciliation quality and available runner-owned host
  validation. The merged build and 14 focused regression files / 446 tests pass.
  Full `pnpm check` and the final post-classifier-fix `pnpm check:quality` pass:
  194 Vitest files / 3726 tests, 819 Max tests and 286 Python tests. Real-host
  receipts are `testing-reconciled-connection.json`,
  `testing-reconciled-inspection-group.json` and `testing-reconciled-remaining.json`
  under `.test-artifacts/`; they are runtime/CLI, not packaged MCP acceptance.
- [ ] Requalify native physical scenarios when explicit reviewed versioned
  inputs are provisioned in this worktree. No such inputs were available for
  this run; no native physical pass is inferred from synthetic runner tests
  or upstream installation evidence. Portable fixture provision remains a
  follow-up dependency of the packaged-scenario phase.
- [x] Follow the merged fix-forward policy for unsupported-capability evidence:
  remove the standalone legacy field fallback and require the current
  `details.capability` contract. Its rejection regression fails before the fix;
  retain historical receipts without adding a compatibility execution path.
- [x] Fix the final review finding: a returned native execution failure must stay
  primary when checkpoint persistence or fixture cleanup subsequently fails.
  Both regressions fail before the fix and pass afterward; 195 focused tests
  and the final full quality gate pass (194 Vitest files / 3728 tests,
  819 Max tests, 286 Python tests). Finalization preserves phase ordering and
  redaction without changing capture behavior.
- [x] Complete the shared packaged automation acceptance foundation and
  send-once readiness boundary; MCP is optional, and the existing runtime/CLI
  suite remains separate. Framework tests do not establish physical acceptance.
  Complete dependency bundles and generated configuration use one canonical
  inventory digest; loaded media identity comes from verified actual bytes.
  A packaged two-message Default-agent smoke test checks pinned attribution,
  terminal responses, conversation memory, single visible submissions, ordinary
  approval policy and confirmed shutdown before profile removal.
- [x] Add the human-reviewed `author-integration-test` development skill,
  persistent fixture/scenario workflow, exact first-case review example, and
  [authoring guide](acceptance-authoring.md). Keep oracle data out of the product
  agent and distinguish valid red tests from invalid/blocked setup.
- [x] Align integration/UX guidance with default automation metric-listener
  parity and the accepted legacy flag; retain ordinary approval requirements.
  Document separate journal-backed capture/source cleanup evidence rather than
  inferring cleanup from completed listening-job status.
- [x] Stop after Stage A validation, then jointly onboard the first portable
  fixture with the user through the skill. Verify Global None, clip Global,
  stopped-zero/all-clips-stopped and existing source/launch guards before
  registering the real `session-clip-identify` case.
- [x] Qualify the packaged two-turn scenario, independently verifying capture,
  source, complete metrics, strict `(B)`, no extra capture, context persistence
  across owned Desktop restart, mutation scope, and terminal cleanup. No
  historical/private fixture or upstream evidence substitutes for this run.
  Fresh terminal passes: `run-c27nOv` and `run-jTIy7p`, Live 11.3.43,
  2026-11-02; earlier failures remain preserved. See the authoring guide for
  receipt/candidate provenance and the persistence-versus-recapture boundary.
- [x] Register #92's single-turn `session-flucoma-flatness-smoke` sibling using
  the unchanged identification fixture, scoped permission, and budgets. Add a
  bounded typed History diagnostic projection, strict stereo delivery/ownership/
  lifecycle/cleanup assertions, and owned-restart re-read checks. Flatness remains
  unqualified diagnostic evidence, not frame-supported numerical measurement.
  Acceptance staging retains pinned signed nested files adjacent to the frozen
  device, verifies source/staged bytes and executable mode, and rejects symlinks.
  Smoke fixtures are parsed against the canonical ingress lifecycle schema,
  including `not-reported` unavailable facts and `flatness_no_output` failure.
  The authentic ingress-shaped projection regression retains both actual Max
  class witnesses and enforces their queued/started transition without relaxing
  stereo values, ownership, cleanup or failure rejection.
  Artifact retention uses exact shared pin paths for nested signed FluCoMa files,
  preserving failure evidence without weakening ordinary path or link guards.
  The smoke-only loader witness verifies the staged pinned Mach-O's mapped path,
  device/inode and bytes in owned Live/Max ancestry at baseline and capture
  completion; missing or global mappings fail closed with bounded provenance.
  Native/saved runtime fixture regressions also cover pinned nested dependency
  staging, executable permissions, integrity guards and cancellation cleanup.
- [x] Execute the reviewed flatness smoke on the explicitly approved owned host:
  `run-fOkqoI`, Live 11.3.43, 2026-11-04. One capture, 21 finite deliveries per
  channel, loaded-binary identity, restart persistence, unchanged scopes and
  terminal cleanup pass. Earlier failed receipts are preserved; this is bounded
  delivery qualification, not exact numerical or general reliability evidence.
- [ ] Deliver a real UI acceptance adapter and migrate appropriate existing
  runtime cases in a later phase; controlled adapters only demonstrate reuse.
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

- [x] Exercise actual retained Gen producers through the declared reader/native
  IO at 44.1/48 kHz, including precise counters, fractional tails, FIFO ACKs
  and release. Preserve latest-only loss and explicit overflow regressions.
- [x] Prepare the reviewed native4 same-loaded-instance scene 0 -> 1 -> 0
  verifier, distinct immutable contexts and explicit stopped baselines.
- [x] Admit the repeated-native group before setup/credential/process work;
  reproduce its former missing-input guard bypass and verify the correction.
- [ ] Execute the retained native4 repeat scenario, owning group and remaining
  real-host suite with explicit fixture pins and exact-PID ownership.
- [x] Verify retained delivery failures through Electron preload/events:
  failed status, zero new context references, preserved prior references and
  disabled capture cancellation without transport cleanup or automatic retry.
- [ ] Complete visible desktop and human repeated-listening acceptance after
  deterministic native verification. Preserve the user's installed-version
  no-crackle acceptance; descriptors do not establish acoustic performance.
- [x] Add canonical Max payload, shared installer/CLI, profile/dry-run,
  guard/cancellation/partial recovery, lifecycle and corruption regressions.
- [x] Exercise the actual packaged integration CLI in an isolated no-checkout
  Library, including repeated-current delivery and pre-publication failure.
- [ ] Validate fresh owned Live11 loading/registration and MIDI ingress from
  newly installed bundles, preserving unrelated user processes/data.

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
  - [x] Regress opaque Browser copying guidance in full/load-only serialized
    metadata and post-result context without rewriting the result. Preserve
    pre-mutation rejection of HTML-entity-rewritten URIs and exact-URI success;
    leave percent-encoding compatibility and approval/retry guards unchanged.
  - [x] Qualify that correction in the unchanged piano scenario and instruments
    group on Live 11.3.43, retaining exact final-device assertions and owned
    cleanup (`2026-10-24T15-26-46.131Z`, `2026-10-24T15-28-10.747Z`).
  - [ ] Clear the distinct instruments-group shutdown failure in the broader
    rerun `2026-10-24T15-29-16.545Z`. All sixteen executed scenarios qualify
    (eleven pass/five recovered-pass), including corrected piano/bass; graceful
    cleanup fails, subsequent owned discard succeeds, PID 5272 exits, and three
    later scenarios remain unrun. The overall run is not green.
    Exact-owned shutdown repair is #67; reproducible remaining-suite coverage is
    #68. Missing legacy v1/v2 immutable physical inputs/reruns are #69. These
    explicit development follow-ups do not convert unrun cases into passes.
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
  - [x] Complete the subsequent isolated visible Default-agent check with
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
    Empirical host evidence is installed Live Suite 11.3.43. Record exact
    versions without treating automatic Live 11 patch changes as blockers.
  - [x] Finish explicit owned Live cleanup before calling visible acceptance
    complete or releasing the shared test slot. Desktop PIDs 41322 and 45044
    closed successfully. Live PID 40458 initially remained open after an
    unsaved-Set prompt and an unsuccessful non-destructive Save As attempt.
    The Node UX controller was stopped without signaling Live while discard
    approval was unavailable. The user subsequently approved discard/closure
    and closed Live themselves. Canonical process inspection at
    2026-10-23T13:49:36.730Z confirms PID 40458 exited and no Live processes
    remained. The shared slot was explicitly released to #58 and #57 notified.
    Both isolated Desktop profiles and failure evidence remain retained for
    diagnostics; no pre-existing user process was adopted or terminated.
  - [x] Escalate #56 acceptance to the remaining non-native real-Live suite.
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
    The seven later scenarios were initially unreached; subsequent qualification
    after the guidance fix is recorded below.
    Native listening groups require separate version-pinned fixture inputs and
    are not claimed as executed by #56.
  - [x] Reproduce missing Session clip containing-track identity guidance and
    inconsistent lifecycle opening-prompt order before fixing them. Four
    assertions fail without the fix; the original clip-name launch guard still
    rejects the observed bad argument. Clarify metadata for all six actions and
    align the reviewed opening request with the existing enforced order,
    without changing validation constraints, guards, budgets or handlers.
    All 497 owning tool/application/CLI/runner tests, build and affected package
    typechecks pass after the fix. The complete serialized TypeScript suite
    passes all 2316 tests; changed-source lint, docs and protocol contracts pass.
  - [x] Requalify the failing Session lifecycle and its complete group after
    #58's explicit slot release, independent process-absence verification and
    fresh branch-script installation. Focused run
    `02d837d6-d7d8-4f66-a991-df0609236ec7` and owning-group run
    `607350d0-1a62-4198-aef7-60a0021eea08` pass with correct containing-track
    launch identity, zero approval denials and independently restored Sets.
    Both retain recovered invalid-argument probes (track delete and Session
    duplicate respectively); neither is claimed error-free. Exact-owned
    cleanup succeeds for Live PIDs 61233 and 62410.
  - [x] Qualify all seven previously unreached non-native scenarios. Run
    `5d955dbb-c852-4b50-a33d-f3bd00fd4cd2` passes Arrangement clip lifecycle,
    Arrangement region fill, cue lifecycle, piano/string-bass instruments,
    Auto Filter, Echo parameter inspection and the exact Operator MIDI fixture.
    Arrangement lifecycle scenarios independently restore the Set; both retain
    recovered invalid-argument probes without approval denials. The other five
    scenarios pass without tool failures. All four exact-owned Live processes
    (63173, 63496, 63799, 64122) finish successful cleanup.
  - [x] Finish current-snapshot remaining-suite qualification. Final tracks
    group `2bbcef23-2951-4679-816f-c29541116079` and remaining-16 run
    `9da895d6-f322-4b57-9694-fa5dc6bda2c5` collectively cover every one of the
    suite's 19 non-native scenarios, with 15 passes and four recovered passes.
    Every deterministic assertion passes, with zero approval denials. Track
    lifecycle, Session lifecycle, Arrangement lifecycle and region fill retain
    eight total invalid-argument probes; these are not error-free turns.
    Exact-owned cleanup succeeds for all nine processes in those final runs;
    canonical independent process inspection confirms no Live processes remain
    before explicit release to #58/#57. No Desktop or UX host was started in
    this final deterministic round. Empirical evidence is Live 11.3.43; native
    fixtures are not claimed qualified by this non-native run.
  - [x] Fix two additional reviewed-harness planning omissions exposed by
    current-snapshot escalation. Run
    `b745a2ad-16bb-43d3-b8e4-a97ab6411477` passed nine scenarios, but `808-track`
    attempted unreviewed pad inspection after loading the correct device.
    Loading-only completion guidance passed focused run
    `9b1bcd63-8d36-4eed-987d-c0052ee3edec`, but owning-group run
    `f1ce2cbe-7510-42a5-9a6a-524d198b43bc` exposed the missing explicit
    search-before-create instruction: browsing children did not satisfy the
    unchanged search ordering guard. Render existing ordering constraints
    into prompts, including tool-wide cases. Three new guidance assertions
    fail before their fixes; negative tests preserve unreviewed-action denial
    and exclude scenarios with additional assertions from early completion.
    All 121 owning CLI tests, CLI types/lint/build pass. Neither manifest,
    allowlist, approval guard, budget nor production mutation behavior changes.
    Focused run `4f082703-73ce-4cd9-9dc7-a2784ec4df0c` and complete tracks run
    `2bbcef23-2951-4679-816f-c29541116079` pass with successful exact-owned
    cleanup. `808-track` is error-free in both; track lifecycle retains two
    recovered argument probes. Preserve both earlier failing traces.
  - [x] Run the broad repository quality components for #56.
    Build, repository formatting, full `pnpm lint`, all workspace/Electron-test
    typechecks and static/device/contract checks pass. Independent stop-harness
    review found no significant issues; Max patch tests (631), Python tests
    (212), and isolated non-Live Electron tests (12) pass. The final TypeScript
    suite, including framing, Session identity and reviewed-prompt regressions,
    passes all 2321
    tests in 136 files with
    `pnpm exec vitest run --maxWorkers=1`, without changing deadlines or retries.
    Earlier concurrent runs timed out in unchanged reasoning-visibility and
    native-v2 cases, and an earlier broad lint run was stopped after prolonged
    execution. Those failures remain recorded in session evidence; the final
    serialized suite and fresh full lint pass alone do not establish real-Live
    acceptance; the separate empirical and owned-cleanup evidence is recorded
    above. Full workspace build/typechecks, formatting, docs, protocol contracts,
    test ownership and generated-version checks also pass after the final
    reviewed-prompt changes.
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
