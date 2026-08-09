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

## Test layers

### Unit tests

TypeScript:

- Schemas and normalization.
- Bar/beat conversion.
- Reference resolution.
- Tool result formatting.
- Risk classification.
- Workflow planning and compensation.
- Project-state reducers.

Python:

- Protocol decoding.
- Command validation.
- LOM serialization.
- Capability detection.
- Command handlers with fake LOM objects.
- Listener registration/removal.

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
- Exercise browser lookup.
- Verify listeners and disconnect cleanup.

These tests are not expected to run on ordinary hosted CI.

### Electron end-to-end tests

Critical workflows:

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

## Quality gates

A feature is not complete until:

- Schemas, bridge method, handler, and capability behavior are documented.
- Unit and contract tests exist.
- Failure and unsupported paths are tested.
- User-facing tool behavior is verified.
- Real Live validation is recorded when the feature touches uncertain LOM APIs.
