# Test Strategy

## Test classifications and quality gates

Tests use filename and command-level classifications:

- `*.test.ts` for deterministic unit and package integration tests.
- Max patch `*.test.cjs` and `*.test.mjs` use `pnpm test:max-patches`
  (`node:test`), not Vitest. Private `.test-artifacts/` diagnostic helpers also
  stay outside Vitest discovery and run only through their explicit commands.
- Generated protocol fixtures plus Python decoder tests for `contract`.
- Simulator-backed bridge tests for `integration`.
- Playwright projects named `electron` for packaged desktop tests.
- Opt-in scripts and recorded release evidence under `real-live`.

Every critical path requires success, failure, denial/guard, and cleanup
coverage. Bug fixes must include a regression test at the narrowest owning
boundary. Vitest runs with default ten-second test/hook deadlines and zero retries;
flaky tests are fixed or explicitly quarantined rather than silently retried.

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

The external driver uses the local stdio MCP adapter only to submit a message.
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
