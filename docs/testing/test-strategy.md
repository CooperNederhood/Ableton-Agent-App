# Test Strategy

## Test classifications and quality gates

Tests use filename and command-level classifications:

- `*.test.ts` for deterministic unit and package integration tests.
- Generated protocol fixtures plus Python decoder tests for `contract`.
- Simulator-backed bridge tests for `integration`.
- Playwright projects named `electron` for packaged desktop tests.
- Opt-in scripts and recorded release evidence under `real-live`.

Every critical path requires success, failure, denial/guard, and cleanup
coverage. Bug fixes must include a regression test at the narrowest owning
boundary. Vitest runs with ten-second test/hook deadlines and zero retries;
flaky tests are fixed or explicitly quarantined rather than silently retried.

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
- Exercise Browser lookup through Live virtual roots and load a device preset
  discovered under Drums, Packs, or User Library.
- Confirm unsupported Browser item categories fail before mutation and a
  failed post-create load leaves exactly one clearly reported empty track.
- Verify listeners and disconnect cleanup.

These tests are not expected to run on ordinary hosted CI.

### Electron end-to-end tests

Critical workflows:

- Definition refresh and active-agent creation.
- Switching independent Agent Mode conversations.
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

- Formatting and linting.
- Type checking.
- TypeScript unit tests.
- Python unit tests across supported interpreter syntax targets.
- Protocol contract tests.
- Simulated bridge integration tests.
- CLI integration and transcript tests.
- Electron smoke tests on macOS and Windows where practical.
- Package/build validation.
- Packaged agents and skills resource validation.
- Journal schema/migration, redaction, trace continuity, retention/cap, query,
  and bounded-ingestion tests.

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
