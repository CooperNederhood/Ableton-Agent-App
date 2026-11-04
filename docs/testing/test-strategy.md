# Test Strategy

For a high-level architecture, suite map, and shared-fixture vision, start with
the [integration testing summary](integration-testing-summary.md).

## Test classifications and quality gates

Support targets Live 11, not an exact patch version. Current development and
real-host testing use installed Suite 11.3.43 on Apple Silicon. Record the full
actual Live version in validation evidence, preserving older receipts unchanged
and tracking changes after automatic updates. A changed Live 11 patch alone is
not a blocker and does not require downgrade or qualification of an uninstalled
older patch. Investigate actual regressions and capability failures; evidence
for one host does not prove every Live 11 configuration. Live 12 is outside scope.

Tests use filename and command-level classifications:

- `*.test.ts` and script `*.test.mjs` for deterministic unit and package
  integration tests discovered by Vitest.
- Max patch `*.test.cjs` and `*.test.mjs` use `pnpm test:max-patches`
  (`node:test`), not Vitest. Private `.test-artifacts/` diagnostic helpers also
  stay outside Vitest discovery and run only through their explicit commands.
- Generated protocol fixtures plus Python decoder tests for `contract`.
- Simulator-backed bridge tests for `integration`.
- Playwright project `electron` for unpackaged Desktop integration and
  `electron-packaged` for generated-application smoke tests.
- Opt-in scripts and recorded release evidence under `real-live`.

Every critical path requires success, failure, denial/guard, and cleanup
coverage. Bug fixes must include a regression test at the narrowest owning
boundary. Vitest runs with default ten-second test/hook deadlines and zero retries;
flaky tests are fixed or explicitly quarantined rather than silently retried.

Retained-listener delivery failures require renderer and Electron preload/event
coverage: the failed pass has no new context references, prior completed-pass
references remain visible, and capture cancellation is disabled without
transport cleanup or automatic retry. Synthetic lifecycle fixtures test this
presentation contract, not actual descriptor capture or acoustic performance.

Hosted validation runs `pnpm check` through `tee` using explicitly selected Bash,
which enables pipefail. The validator's failure must fail the job and retain
stdout/stderr diagnostics; a successful log writer is not evidence that tests
passed. A deterministic test reads the actual workflow step and exercises both
successful and failing validators with controlled executables.

CLI subprocess tests launch `process.execPath --import tsx`, preserving the
actual runtime and process identity instead of signaling a package-manager
shell shim. Prompt readiness and exit observation are event-driven. Test-owned
children and pipes are reaped on assertion failure or test completion, including
timeout paths; existing readiness/test deadlines are not extended.

The Max test command explicitly loads `tsx` on the hosted Node 20 runtime.
Native source-schema tests use the supported asynchronous module resolver,
restricted to the existing protocol/signal source roots, rather than newer
`registerHooks` or implicit native TypeScript stripping. Plain-Node calibration
CLI commands use scoped TS imports, including transitive verifier imports;
their subprocess regression removes inherited loader options and disables native
stripping where available.

## Goals

Tests must catch:

- Schema and index conversion errors.
- MCP-era command drift in the new bridge/protocol design.
- Unsupported LOM assumptions.
- Main-thread scheduling mistakes.
- Stale-reference and ambiguity bugs.
- Partial workflow failures.
- UI regressions in approvals and operation progress.
- CLI regressions in streamed output, approvals, and exit behavior.
- Packaging and Remote Script installation failures.
- Invalid agent YAML, skill metadata, wildcard expansion, and packaged-resource
  discovery.
- Cross-agent transcript, approval, cancellation, and Output-routing leakage.
- Live Event listener leaks, cross-agent delivery leakage, event gaps, and
  continuous-source floods.
- Missing journal lifecycle stages, broken trace/correlation propagation,
  unsanitized payloads, retention/cap failures, and cross-agent query leakage.
- Edit-scope bypasses and overlapping multi-agent mutation races.
- Equivalent-but-distinct Live routing wrappers, ambiguous routing identities,
  stale type/channel snapshots, and routing assignment verification failures.

## Test layers

### Entry points and evidence boundaries

| Layer / command | Owns | Does not establish |
| --- | --- | --- |
| `pnpm test:ts` (Vitest) | Unit/component logic, controlled failures, workflow fakes and simulator-backed adapters | Actual Live or DSP execution |
| `pnpm contracts:check`, `pnpm test:python` | Cross-language schemas, compatibility and fake-LOM handlers | Host qualification |
| `pnpm test:max-patches` | Max source/generation contracts and synthetic publisher/readback regressions | Physical compilation, listening or acoustic quality |
| `pnpm test:acceptance:list` / `pnpm test:acceptance:validate` | Offline acceptance catalog/schema and registered-fixture validation | An empty catalog or schema-only template is not an executed acceptance case |
| `pnpm live:acceptance --scenario <registered-id>` | Packaged Automation Endpoint driver for reviewed fixture-backed conversations; `session-clip-identify` registered, qualification determined by terminal receipts | Desktop UI submission, migrated runtime/CLI coverage, or qualification from framework tests |
| `pnpm live:acceptance:suite` / `pnpm live:acceptance:verify` | Local sequential discovery of every registered packaged case, one attempt each, exact-candidate aggregate evidence and offline release verification | Hosted Live CI, automatic retries, broader compatibility or a passing release from incomplete/stale evidence |
| `pnpm live:agent-smoke --scenario <id>` / `--group <id>` | Reviewed runtime/CLI actions and independently checked Live outcomes | Uncoached packaged Default-agent UX or MCP stdio |
| `pnpm test:electron` | Main/preload/renderer integration with explicit fake or injected dependencies | Live outcomes from synthetic context/results |
| `pnpm test:electron:packaged` (after distribution build) | Packaged resources, startup, native modules, bundled installer and explicitly executed authentication checks | Completed musical workflows or actual Live loading of delivered devices |
| `pnpm live:ux-host` plus visible Desktop/MCP inspection | Attended cross-app workflows with correlated retained evidence | A continuously enforced packaged acceptance suite |

Run the narrowest owning regression first, then its broader owning suite.
This lower-layer regression rule does not automatically expand real-Live
coverage. Use `integration-testing` for explicitly requested real-host validation
or a concrete Live-postcondition evidence gap in the agreed task, not merely
because prompts, tools, workflows, bridge code, or protocols changed. Start with
the smallest relevant registered scenario. Broaden real-host coverage only for
an explicit request or a concrete regression risk; agree on material scope
expansion rather than automatically running a group and the remaining suite.
When the agreed scenarios and terminal cleanup pass, report the bounded result
and stop, preserving earlier failures without claiming unrestricted reliability.
Unsuccessful selected scenarios cannot be dropped or relabeled as passes.
If both exact-state and visual UX validation are selected, run the deterministic
validation before `desktop-ux-testing`; neither selects the other automatically.
`pnpm check` builds then runs quality checks; `pnpm check:quality` includes
format/lint/docs/ownership/version/contracts/typecheck and all three test runners.
No hosted job launches real Live. The new packaged multi-turn acceptance lane
uses the Automation Endpoint directly; MCP is optional, not another required
execution tier. See [acceptance authoring](acceptance-authoring.md) for its
authoring workflow and implementation/qualification boundaries.

The visible-message Electron test uses the direct automation client, not MCP
stdio, and asserts ingress/rendering plus metric-listener descriptors, not
terminal agent task completion. The separate packaged acceptance adapter is
`tests/electron/acceptance-driver.ts`; submission, attributable completion, and
independent evidence are distinct boundaries. MCP submission success itself
means only message acceptance. Screenshots and assistant prose cannot replace
exact postcondition reads.

Automation metric listeners now default to enabled, matching normal startup;
the legacy `--automation-metric-listeners` flag is accepted but not required.
This changes neither ordinary approvals nor the need for real-host qualification.

### Fixture-backed acceptance authoring

The development-agent-only
[`author-integration-test` skill](../../.github/skills/author-integration-test/SKILL.md)
is the primary interface: a developer supplies a Set, desired turns, correctness,
and protected state. Inspect only an owned copy, propose exact initial
conditions/actions/mutation scope/assertions, and obtain human review before
freezing portable licensed assets and a registered scenario. Keep oracle data
out of the ordinary Default agent's prompts, skills, context, and project paths.
Do not introduce a bespoke runner for each new case.

When adding a new user-facing agent capability, offer this human-in-the-loop
workflow once per capability, early enough to support fixture-backed test-driven
development when practical. Reuse an existing suitable case, and honor a prior
answer or explicit authoring request rather than asking again. If the user
declines or is unavailable, defer authoring and continue ordinary implementation
and deterministic regression coverage. Authoring opt-in is not blanket
authorization to launch Live or expand real-host testing.

The shared foundation lives at `@ableton-agent/test-support/integration`, with
`integration/fixtures/` and `integration/acceptance-scenarios/` catalogs.
Generic coordination compares declared scalar baseline facts and dependency
hashes without assuming audio sources or listeners. The Desktop audio driver
owns supported audio-baseline validation and staged-media verification; other
drivers can use non-listening baselines and assertions.
Independent cases stage fresh copies; ordered turns retain their working world.
Read and verify loaded preconditions before submission, without repairing them.
Resolve only explicit fixture-scoped ordinary approvals. Check terminal turn,
source, context, mutation scope, persistence, and cleanup independently rather
than treating acceptance acknowledgements or assistant prose as completion.
The adapter reads public typed `eventHistory.trace` and preserves bounded
redacted `product-evidence.json`. Capture/source cleanup needs separately
journaled evidence; a completed job lifecycle alone cannot prove it.
Unchanged-scope assertions apply only to explicitly named observed data. The
current `session-structure` hash includes public snapshot identities and exposed
mixer/routing fields, plus scenes/Arrangement/cues when present, not every device
or plug-in parameter. `source-settings` uses exact source launch/audio settings,
recording, and file identity. Broader protected-state contracts require broader
independent reads rather than an arbitrary all-parameter immutability claim.
The public source-read adapter reuses `listening.inspect_session_source` and
its existing query lifecycle, not a new protocol mutation or repair path.
Global recording preflight uses the separate read-only `inspectRecording()`
surface over `recording.inspect`: Arrangement Record and Session Record must both
be false. Target recording alone cannot establish this; missing/malformed global
evidence rejects admission rather than defaulting to false.
The compound `inspectSessionListeningPreflight` read joins existing source,
actual Live audio metadata, and global recording reads under the same query
correlation. It is sequential, not atomic. Validate target identity and reject
null path/sample-rate evidence; do not derive those observations from the fixture.
The audio read reports the loaded media sample rate, not the capture engine
rate. Verify the loaded path and hash the admitted staged file independently.
Strict unattended approvals require fully attributed, complete structured
tool/action/arguments; sanitizer changes or missing ownership fail closed.

Typed acceptance evidence must survive bounded sanitization without structural
loss. Revalidate it after sanitization; credential redaction and visible
binary/audio omission are allowed, but removed/renamed fields, truncated text or
arrays, and depth/byte fallback cannot silently become successful evidence.
Cancellation tracks in-flight owned-resource acquisition through staging,
provisioning, launch, subscription, and collection. Give it a bounded cleanup
grace; unsettled acquisition reports incomplete cleanup and explicit deferred
cleanup failure, then reclaims late-owned resources when acquisition settles.
Late lifecycle events remain observable, but a failed/cancelled receipt never
retroactively becomes a pass. Drivers still honor cancellation and register
ownership when creating resources.

Stage A delivered the foundation; joint user review has now registered two-turn
`session-clip-identify`; its
[review contract](../../.github/skills/author-integration-test/references/test-contract.md)
freezes the approved 128-BPM Global None / clip Global / stopped-zero baseline and strict
`(B)` answer plus independent capture/context/persistence/scope checks. No real
fixture, listening qualification, or UI acceptance adapter is implied by
controlled framework tests. The existing runtime/CLI catalog remains separate.
The registered case subsequently passed all independent assertions twice in
fresh owned Live 11.3.43 processes on 2026-11-02; see the authoring guide for
terminal receipts and limitations. This is bounded scenario qualification, not
a claim that the remaining listening/reliability gaps are closed.

Missing assets, invalid references, hash changes, unsupported drivers, and
failed preconditions are setup/admission failures, not red product tests. A
properly admitted product contract failure remains a useful red test; never
change its oracle to fit output. Preserve original failures, distinguish cleanup
and receipt-write failure, and require renewed human review for contract changes.
The [authoring guide](acceptance-authoring.md) owns the concise command workflow.

### Suite receipts and terminal evidence

Receipt v2 keeps the selected scenario set, executed set and selected-but-unrun
set visible (`selectedScenarioIds`, `executedScenarioIds`, `unrunScenarioIds`),
including after setup failure or stop-on-first-failure. Selection
is fixed before setup. Explicit scenario IDs excluded by group/resume selection
are rejected with the excluded IDs; deliberate valid subsets need not execute
every repository scenario.

A clean general CLI pass requires nonempty independently passing assertions,
the selected `scenarioId` and a completed `traceState`. An already-started
scenario record survives setup/execution exceptions; do not silently relabel it
as selected-but-unrun.

The run `outcome` is `passed`, `failed`, `blocked` or `incomplete`.
`sourceRevision`, `sourceDirty` and `buildPolicy.skipBuild` /
`buildPolicy.skipInstall` retain source/build provenance. A dirty worktree is not
the unchanged revision named by HEAD. `coverage` reports `selected`, `executed`, `passed`,
`cleanPasses`, `recovered`, `passedAfterRetry`, `expectedDenials`,
`expectedPartials`, `skipped`, `blocked`, `failed`, `cancelled` and `unrun`.
Here `passed` counts satisfied reviewed contracts, not only clean capability
successes. `expected-denial-pass` and `expected-partial-pass` contribute to
contract satisfaction, not `cleanPasses`. `observedTools` has `count` and `names`,
replacing the older `coverage.tools` / `toolCount`; observed starts are not
successful capability coverage. Native names come from actual
`operation.started` events, not the scenario allowlist.
Source provenance is captured before native admission refusal and process
inspection, including on blocked admission receipts.

Keep every attempt and evidence reference. Report first-attempt success
separately from a recovered final attempt or a recovered invalid-argument call.
The attempt summary exposes `firstAttemptClassification`,
`finalAttemptClassification`, `firstAttemptPassed` and `passedAfterRetry`.
Executed/satisfied/skipped/blocked/unrun counts and attempt quality are distinct;
tool starts do not count successfully supported capabilities. A requested suite
with skipped, blocked or unrun selected work must exit unsuccessfully. Verified
expected refusals and expected partial metric results can satisfy their own
reviewed contracts, but are not successful mutation or all-metrics claims.
Unsupported capability classification requires `code: "unsupported_capability"`
and an exact reviewed `details.capability` in the current structured failure
contract. Standalone legacy capability fields and diagnostic prose are not
accepted, and cannot override failed assertions, unsafe/denied calls, unrelated
failures or cleanup failure.

A native execution checkpoint is provisional: records use
`finalization: "checkpoint"` or `"final"`, and native `.checkpoint.json`
evidence is separate from terminal `.json` evidence. `executionClassification`
preserves the execution result when cleanup or persistence later fails; the
summary is computed from final results, not copied from provisional success.
Successful cleanup preserves a blocked or cancelled execution classification;
it does not turn setup failure or cancellation into a pass. Checkpoint
persistence failure independently fails acceptance even if `cleanup.status`
reports successful cleanup.
Terminal results must account
for service/journal shutdown, exact-owned process release and fixture cleanup.
Preserve the original failure alongside subsequent cleanup or writer failures,
including failures returned as `ok: false` rather than thrown exceptions;
per-scenario traces and aggregate outcomes must agree. Failure to persist
evidence is a non-success diagnostic, not a fabricated receipt. Keep lifecycle
timing and trace/correlation/causation attribution, sanitizing and bounding all
persisted facts. Read receipts according to their version; never rewrite or
silently reinterpret historical receipts as v2.

`scripts/lib/scenario-receipts.mjs` uses the canonical sanitizer through the
existing `tsx` source-import path, so admission failures can be reported before
a build. Receipt writes are owner-only and atomic, bounded to 64 MiB per receipt
and 16 KiB per scalar string, with visible omission markers for audio/binary
bodies. These are test-evidence persistence guarantees, not a new application
storage layout or feature.

### Native fixture and qualification boundaries

Version-specific native1–native5 inputs are not interchangeable. Start independent
attempts with fresh owned processes, but preserve intentional same-instance
passes, source switches and fixture-owned resets inside a reviewed scenario.
`native-listening-fixture.mjs` stages byte-preserving execution copies;
`saved-listening-fixture.mjs` explicitly migrates/provisions reviewed offline
device references. Synthetic DTO builders belong in non-test helpers with
caller-owned cleanup, not imports from executable test modules. The separate
v2 external-WAV admission follow-up is not a new policy for later fixtures.

Session capture supports the full active loop by default and guarded exact-end
coverage, bounded to thirty seconds; the old universal four-beat or
strictly-before-end limit does not apply. Wire4 adds explicit per-pass dual-mode
behavior; wire5 uses independent level, spectral and attack timelines with
`metric-audio-observation/v1`. Descriptive disagreement is advisory; strict timing
is a distinct policy. Existing stopped-beat-zero and None global-quantization
guards remain unchanged.

The v5 verifier freezes source/geometry independently and requires non-silent
level evidence, actual spectral coverage/energy when requested, immutable
context reopening and cleanup proofs. This is not semantic kick classification,
a general independent PCM oracle, or a no-crackle certificate. Expected unavailable
spectrum cases remain explicitly partial; engineering-only and bootstrap-only
evidence cannot qualify production delivery.

The merged production bundle has **bounded Session and installed-startup
qualification**, including matched production/package/install inventories and
the corrected silent-tail scenario and owning group. This supersedes the
unqualified deployment checkpoint at `5f8de53`; retain its failed receipts as
historical evidence. A later same-source repetition failed before playback and
passed only on isolated rerun, so repeat reliability remains unresolved.
Incorrect offbeat interpretation also remains unqualified despite intact numeric
timing. These results do not qualify arbitrary launch states or changes to this
test runner. The current checkpoint in
[Playback Listening](../tools/playback-listening.md) and delivery requirements in
[Packaging and Operations](../platform/packaging-and-operations.md) are
authoritative; this strategy does not duplicate their historical run ledger.
Private `.test-artifacts/` inputs referenced in evidence are not portable fixtures
or guaranteed to exist in another checkout.

Before reconciliation with merged main, the attempted part-1
`connection-and-session` run found an existing unowned Live process (PID 32309)
and launched or changed no process. Its receipt reports blocked, zero executed
and one unrun selected scenario with a nonzero exit. This safety refusal is not
green real-host qualification; retain it as historical evidence.

After reconciliation with `f84303e` and user-confirmed closure of the existing
Live instance, the refactored runner passed `connection-and-session`, its full
five-scenario inspection group, and all fourteen remaining non-native scenarios
on Live 11.3.43. Across nineteen distinct scenarios, fourteen were clean passes
and five recovered from invalid-argument calls within their first attempt; no scenario
needed a fresh second attempt. All independent assertions and final cleanup
passed, with no skipped or unrun selected scenarios. The recovered cases were
track lifecycle, four-on-floor, Session clip lifecycle, Arrangement clip lifecycle
and Arrangement region-fill lifecycle; they are not clean agent executions.
Receipts are `.test-artifacts/testing-reconciled-connection.json`,
`.test-artifacts/testing-reconciled-inspection-group.json` and
`.test-artifacts/testing-reconciled-remaining.json`. All ten runner-owned Live
processes closed, and a final process guard found none remaining.
These are runtime/CLI results, not packaged MCP acceptance. Explicit native
fixture inputs were not available in this worktree, so native physical scenarios
were not selected or rerun; their synthetic coverage and upstream qualification
must remain separately labeled.

Application state uses the shared `@ableton-agent/storage` resolver and
[Local Storage Layout](../platform/local-storage.md), including isolated automation
roots and their `profiles/automation` ownership. Disposable fixture/evidence
directories are not another application-state root. Reserved memory directories
do not imply implemented general memory persistence.

### Canonical integration delivery

Device delivery requires publisher and installer regressions as well as app
launch coverage. Check complete canonical native-v5 and MIDI payload inventories,
portable/installed hashes, path rendering, selected-profile and custom-Library
resolution, idempotent update, corrupt/missing/wrong-version resources, live-host
guards, unrelated-file/token preservation, partial failures, cleanup/cancellation,
and redacted trace/timing coverage. Detect/dry-run must not create profile data.

Packaged Electron coverage executes the bundled integration CLI with an isolated
Library/profile and a working directory without a checkout. Assert both devices
and Remote Script are delivered, repeat installation is current, and a missing
companion refuses all publication. An app launch/authentication test alone does
not prove device delivery.

Fresh owned Live11 acceptance must load newly installed bundles, resolve adjacent
resources and verify listener registration/bounded capture plus exact MIDI
ingress. Record the actual full host version and clean only owned processes and
fixtures. Do not replace this check with an older independently packaged device,
or claim static package checks complete the separate legacy physical matrix.

### Retained measurement delivery

Exercise the actual Gen publisher with delayed low-priority reads, not only an
already-perfect JavaScript FIFO. Preserve the latest-only missing-window
regression; require coherent owned FIFO recovery, full counter precision,
fractional tails, explicit overflow/control faults and release at both supported
sample rates. Cover the shared reader, native IO, controller, authenticated SDK,
ingress telemetry and immutable context publication independently. Qualify
actual Gen compilation/readback in an isolated host before production wiring.

The reviewed `native-dual-session-repeat-1-2-1` scenario belongs to
`native-listening-repeated`. It requires explicit pinned native4 input and
ordinary guarded approvals; admission must run before setup, credentials or
process inspection. Three captures target scenes 0, 1, 0 on the same loaded
producer/connection/binding, with three distinct pass/context IDs, increasing
native epochs and independently verified source/coverage proofs. The only
between-pass stops are two explicit fixture-owned baseline operations, after
the preceding pass verifies. Their explicitly user-approved contract revision
also positions the stopped disposable Set to beat zero and independently
verifies that qualified anchor, source identity and unchanged settings. The
original stop-only/no-seek contract is preserved in historical failure evidence;
it could not establish the existing production Session precondition.
No actor stop/seek/retry permission or production guard is relaxed.
Preserve earlier contexts and fail at the first
failed subpass without retrying. Preparation/unit success is not a physical
run; non-silent/nonclipping descriptors are not a no-crackle certificate.

### Unit tests

TypeScript:

- Agent and skill definition schemas and loaders.
- Tool-pattern expansion, scope authorization, and mutation locks.
- Multi-agent SDK session lifecycle and event attribution.
- Schemas and normalization.
- Bar/beat conversion.
- Reference resolution.
- Tool result formatting.
- Risk classification.
- Workflow planning and compensation.
- Project-state reducers.
- Journal envelope/schema migrations, producer sanitization, configuration
  snapshots, lifecycle normalization, batching, retention, and cursor queries.

Python:

- Protocol decoding.
- Command validation.
- LOM serialization.
- Capability detection.
- Command handlers with fake LOM objects.
- Live 11 device destination preflight, stale/ambiguous topology rejection,
  same-parent index translation, verified movement/recovery, and existing-chain
  property/mixer rollback.
- Listener registration/removal.
- Dynamic event subscription resolution, semantic transition translation,
  parameter coalescing, invalidation, and reconnect cleanup.

### Protocol contract tests

Use shared JSON fixtures to verify:

- TypeScript encoding is accepted by Python.
- Python responses decode into TypeScript schemas.
- Every command has request/result schemas.
- Every declared command has a registered handler.
- Error codes and required fields remain stable.
- Version negotiation behaves correctly.

### Bridge integration tests

Run the real TypeScript bridge against a simulated Python Remote Script server.
Test:

- Handshake and authentication.
- Fragmented and combined TCP frames.
- Request correlation.
- Timeouts and disconnects.
- Reconnection.
- Event sequencing.
- Dynamic Live Event replay and reconciliation after reconnect or sequence
  gaps.
- Trace/correlation continuity across bridge requests and Live Event observed,
  transported, normalized, persisted, routed, and delivery stages.
- Oversized and malformed frames.
- Mutation serialization.
- Live 11 device move and chain-edit protocol dispatch against the simulator.

### Workflow tests

Use an in-memory fake `AbletonBridge` with controllable failures. Assert exact
operation order, verification, partial failure behavior, approval requirements,
and change-set records.

### Real Ableton tests

Maintain a small manually triggered suite for supported Live versions:

- Connect and report capabilities.
- Read a known test project.
- Create/rename/delete a track.
- Create a MIDI clip and add notes.
- Place a clip in Arrangement.
- Load a built-in device and set a parameter.
- Validate the supported existing-device moves and existing-chain edits in the
  Live 11 capability matrix; explicitly confirm unsupported structural
  operations remain absent.
- Exercise Browser lookup through Live virtual roots and load a device preset
  discovered under Drums, Packs, or User Library.
- Load Auto Filter onto a generated audio track to cover loadable devices that
  Live also reports as navigable because they expose preset children.
- Confirm unsupported Browser item categories fail before mutation and a
  failed post-create load leaves exactly one clearly reported empty track.
- Verify listeners and disconnect cleanup.

These tests are not expected to run on ordinary hosted CI.

#### Opaque Browser identities

Regress exact Browser identity handoff in full and load-only serialized tool
metadata and the post-result hook. The hook adds copying guidance without
rewriting result bodies or weakening stale-reference retry policy. Preserve
literal ampersands and existing percent escapes; HTML/XML entity rewriting is
not URI identity equivalence.

Python fake-LOM coverage must reject entity-rewritten URIs before any Browser
load or device mutation, and accept the exact original URI. Keep existing
percent-encoding compatibility coverage. Use the unchanged reviewed
`piano-and-string-bass` scenario to require actual identity-bound piano and bass
devices, exactly two loads and ordinary approval/mutation budgets. Run it
alone, its instruments group and the remaining runnable suite; one passing
model turn is not a guarantee against all future argument rewriting.

#### Transport stop discoverability

The `transport` group includes `transport-stop`, run alone with
`pnpm live:agent-smoke --scenario transport-stop`. Its reviewed prompt asks to
stop playback without supplying an action name or arguments. Runner setup must
independently establish playing transport with recording off before the actor
turn. Setup must not count as an actor tool invocation.

The actor uses ordinary approvals with an exact stop-argument guard and one
mutation budget. The verifier requires the actual stop call and an independent
`isPlaying === false` read before cleanup, plus unchanged content and relevant
transport settings. Naturally advancing position is not an unrelated edit.
Missing calls, refusals, denials, timeout, incomplete evidence or prose-only
success must fail; cleanup cannot convert a failed actor result into a pass.
Do not automatically retry the discoverability request.

Validate completed stop payloads against the protocol result schema. Accept
standalone JSON or its exact SDK transport-success post-tool-hook framing;
unrecognized trailing prose, other tool framing and unverified payloads remain
failures. Hook guidance and assistant prose are not state evidence.

Run the scenario, its group and the remaining runnable suite in that order.
Follow deterministic acceptance with an isolated visible Default-agent check,
using ordinary approvals and independently verified state. A pre-existing
user Live process blocks both checks; never reuse or terminate it. Implemented
description/SDK contracts and synthetic verifier tests are not proof of real
agent action selection.

#### Session clip lifecycle consistency

The reviewed `session-clip-lifecycle` request and its detailed instructions
must agree with the existing guarded order: create the source, launch it,
stop transport, change properties, duplicate, then delete the generated clips
and track. Do not ask for properties/duplication before launch while enforcing
the reverse order. Existing identity, zero-based scene indices, risk classes,
ordering constraints, mutation budgets and unchanged-Set assertions remain
authoritative.

All Session clip actions use `expectedName` for the containing track, never
the clip name. Regress that distinction in the tool description, every
action's serialized parameter metadata, full and restricted SDK registration,
and approval rejection of a clip name in the track-name field. Retain prior
failed runs; do not broaden guards or treat corrected guidance as empirical
acceptance before rerunning the failed scenario and complete owning group.

#### Reviewed scenario planning contract

Render every reviewed tool/action ordering constraint into the actor prompt,
including tool-wide constraints without invented action names. Sequential
execution alone does not tell the actor which action must precede another.
Keep the unhinted `transport-stop` prompt unchanged.

When every assertion verifies only loaded tracks/devices, successful load
results may finish the actor task; the runner still independently verifies
the exact final state. Uncertain outcomes may use only reviewed inspections,
not unlisted Drum Rack pad/chain actions. Do not apply this completion shortcut
to scenarios with additional note, parameter, lifecycle or tool-call assertions.
Regress both guidance and unchanged rejection of unreviewed actions; retain
prior failed runs and require fresh scenario/group/remaining-suite acceptance.

### Electron end-to-end tests

Critical workflows:

- Launch the generated macOS application with `app.isPackaged`, packaged
  resources, production profile selection, and isolated local storage.
- Launch with token variables removed and a Finder-like minimal PATH. Cover the
  explicit authentication-required UX without credentials, and gate a local
  macOS smoke that verifies `gh-cli` authentication and model discovery against
  the exact installed `/Applications` executable.

- Definition refresh and active-agent creation.
- Switching independent active-agent conversations.
- Duplicate instances of one definition.
- Output subscription fan-out across active agents.
- Live Event creation, per-agent response modes, message prefixes, and hidden
  occurrence history.
- History filters, cursor pagination, trace expansion, default-on/pause/clear
  controls, retention notices, and journal-unavailable states.
- Slash-skill discovery and invocation.
- First launch and Remote Script setup.
- Connection loss and recovery.
- Send prompt and render streaming output.
- Tool progress presentation.
- Destructive approval.
- Partial failure.
- Session resume.
- Project switch.
- Debug-only isolated automation launch, selected startup agent/YOLO state,
  authenticated external message acceptance, and visible user-turn rendering.
- Slow snapshot enrichment that remains active while a prompt reaches visible
  submission and acceptance without waiting for optional enrichment.
- Ownership-transition submission states: bounded waiting, accepted-message
  identity, actionable timeout, preserved retry text, and no duplicate user
  bubble.

The attended external driver uses the local stdio MCP adapter only to submit a message.
Computer-use owns screenshots and visual inspection of the Electron app and
Ableton Live.

The runner-owned UX host keeps ordinary Remote Script readiness bounded to
120 seconds. With `pnpm live:ux-host --computer-use`, launch/dialog handling is
coordinated externally and readiness has a bounded 600-second deadline so a
manual recovery decision does not silently inherit the ordinary deadline.
Explicit helper deadlines remain authoritative. Coordinated startup disables
automatic recovery discard; recovery decisions require the operator's approval.
Timeouts still fail visibly and clean up only the identity-attested owned
process. A connected socket or cached snapshot does not establish fresh bridge
readiness after a Set transition.

### CLI integration tests

Run the real CLI presentation adapter against fake application services and the
simulated Remote Script. Test:

- Interactive prompt submission.
- Streaming assistant and operation output.
- Approval, denial, and plan inspection.
- Connection loss and recovery messages.
- Non-interactive one-shot prompts.
- Stable exit codes for success, denial, connection failure, and agent failure.
- Plain and JSON output modes.
- Session creation and resume commands.

Prefer deterministic transcript and event assertions over brittle terminal
screen coordinates.

### Local event journal tests

Use fake clocks, deterministic IDs, and bounded stores to verify:

- capture defaults on and remains local-only with no network transport;
- configuration snapshots are emitted on create, resume, and effective change;
- every supported SDK, tool/workflow, approval, bridge, Live Event, and Output
  lifecycle path records the required stages, outcomes, and timings;
- prompt ownership gates record queued, started, completed, failed, timed-out,
  and cancelled stages without storing prompt text, and correlate those stages
  to the accepted message ID;
- trace/correlation/causation IDs survive fan-out, reconnect, automatic turns,
  failures, cancellation, and retries without cross-agent attribution;
- bounded prompts, assistant text, paths, structured musical/MIDI and event
  payloads, and tool definitions/arguments/results survive persistence, while
  credentials embedded in strings and binary/audio bodies cannot reach storage
  or query view models;
- age pruning removes records older than 30 days and oldest-first eviction keeps
  storage at or below 250 MiB, including restart and interrupted-write cases;
- cursor pagination remains stable under concurrent appends and every filter is
  bounded, indexed, cancellable, and access-scoped;
- saturation and persistence failure are visible, ordered records are retained
  where possible, and critical SDK/bridge/tool work remains non-blocking; and
- Outputs reuse journal infrastructure while remaining distinct from Live Event
  schemas, inventory, routing, and filters.

Run sustained-ingestion and cap-sized query benchmarks on the supported desktop
baseline. The first page of a normal filtered query must meet 200 ms p95 at the
250 MiB cap, without visible regression to SDK streaming, tool execution, or
Live Event delivery. Treat thresholds as testable named constants and publish
enough diagnostics to explain regressions.

## CI

The hosted validation job runs `pnpm check`; the macOS platform job builds.
`package-desktop.yml` builds the workspace and integration payloads, runs the
unpackaged `electron` project, then produces the macOS distribution. It does
not currently execute `electron-packaged`; that remains an explicit local
command, including bundled-installer tests without a checkout.

Packaging selection follows Desktop's transitive workspace/test dependencies,
Electron tests and configuration, workspace/TypeScript configuration, bundled
`agents/` and `skills/`, and the integration builder's source/helper inputs.
A configuration regression reads the actual workflow and dependency manifests,
checks missing ownership triggers and preserves payload-build ordering before
Electron/distribution. These filters select existing work; they introduce no
new CI jobs, authentication provisioning or real-Live release gate.

Every pull request should run:

- A full workspace build before checks or tests that execute compiled entry
  points.
- Formatting and linting.
- Type checking.
- TypeScript unit tests.
- Python unit tests across supported interpreter syntax targets.
- Protocol contract tests.
- Simulated bridge integration tests.
- CLI integration and transcript tests.
- Electron smoke tests on macOS. Windows CI is deferred during macOS-first
  development and must be restored before Windows support is claimed for a
  release.
- Package/build validation.
- Packaged agents and skills resource validation.
- Journal schema/migration, redaction, trace continuity, retention/cap, query,
  and bounded-ingestion tests.

Typed ESLint runs each application and package workspace in an isolated process,
followed by a separate support-file process, so TypeScript project state is
released between source groups. Generated `dist/` and `release/` artifacts are
never lint inputs.

## Quality gates

A feature is not complete until:

- Schemas, bridge method, handler, and capability behavior are documented.
- Unit and contract tests exist.
- Failure and unsupported paths are tested.
- User-facing tool behavior is verified.
- Real Live validation is recorded when the feature touches uncertain LOM APIs.
- New capabilities and asynchronous stages define observable lifecycle events,
  appear in Desktop history, and include redaction and trace-propagation tests.
## Agent workflow smoke tests

Natural-language workflow tests use the existing one-shot CLI `run` command
with reviewed scenario manifests under `integration/live-scenarios/`.
Scenario mode adds scoped approvals, a complete bounded trace, shared Copilot
session selection, and deterministic bridge assertions after the model turn.

The verifier never asks the model whether it succeeded. It compares baseline
references with refreshed Live state and uses read-only APIs such as
`clips.inspect_notes` for exact MIDI content.

`pnpm live:agent-smoke` owns the Live process lifecycle. It refuses a
pre-existing user process, launches a fresh Live instance, waits for the
authenticated Remote Script handshake, runs scenarios until the first failure,
and controls only the recorded PID after revalidating its executable identity.
