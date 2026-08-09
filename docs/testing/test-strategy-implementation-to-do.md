# Test Strategy Implementation To-Do

Companion specification: [Test Strategy](test-strategy.md)

## Test infrastructure

- [x] Select and configure TypeScript and Python test runners.
- [x] Add shared fixture, fake clock, fake ID, and log-capture utilities.
- [x] Build fake LOM object library.
- [x] Build simulated Python Remote Script server.
- [x] Build fake Copilot/session adapters for deterministic client tests.
- [x] Define test tags for unit, contract, integration, Electron, and real Live.

## Coverage implementation

- [ ] Add unit-test requirements to every package template.
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
- [x] Cover bounded device/parameter pages, exact identity guards, quantized
  normalized mapping, disabled parameters, rollback, and simulator parity.
- [x] Cover bounded rack/chain/pad pages, exact nested identity guards,
  runtime-reference pruning, no-recursion behavior, CLI reads, and simulator
  parity.
- [x] Cover bounded Browser roots/children/search, deterministic traversal,
  strict node/result/depth/time limits, exact item revalidation, prohibited
  plug-in loading, approved CLI loading, and simulator bridge parity.
- [x] Implement CLI transcript tests.
- [x] Implement Playwright Electron harness.
- [~] Create real-Live test project and manual runner.
  - [x] Add a runner that records versioned, commit-linked smoke evidence
    without storing project content.
  - [ ] Create and publish the canonical Ableton Live test project.
  - [ ] Record real-Live results for Session launch quantization and rollback,
    MIDI/audio duplication compatibility, deletion, and mute/loop property
    availability.
  - [ ] Record real-Live results for Arrangement loop setters, cue-point
    identity stability, naming, creation rollback, and deletion verification.
  - [ ] Record real-Live results for Device On discovery, native/plug-in
    parameter writability, quantized values, setter failures, and rollback.
  - [ ] Record real-Live results for rack/Drum Rack capabilities, chain/pad
    identity and ordering, empty pads, pad chains, and direct chain devices.
  - [ ] Record real-Live results for Browser roots, BrowserItem properties and
    URI stability, child ordering/latency, selected-track and hotswap behavior,
    `Browser.load_item` timing, track compatibility, multi-device presets, and
    indeterminate failure reporting.

## CI

- [x] Add formatting, lint, typecheck, unit, contract, and integration jobs.
- [x] Add macOS and Windows build/smoke jobs.
- [x] Cache dependencies without caching generated test results.
- [x] Publish validation/build diagnostics on failure.
- [x] Enforce package build and protocol compatibility checks.
- [x] Document how real-Live release validation is recorded.

## Quality controls

- [x] Define minimum critical-path coverage expectations.
- [x] Require regression tests with bug fixes.
- [x] Track flaky tests and prevent silent retries from hiding failures.
- [x] Add deterministic timeouts to all process/network tests.
- [x] Add security-oriented malformed-input/fuzz coverage.

## Tests

- [x] Unit-test test-support utilities and fixture builders.
- [ ] Integration-test the test runners themselves against known pass/fail
  fixtures.
- [x] Verify CI reports failures, timeouts, and artifacts correctly.
- [ ] Run a clean-checkout rehearsal of every documented test command.

## Exit criteria

- [x] A clean checkout can run all non-Live tests with one command.
- [x] CI covers every application-owned boundary.
- [x] Release checklist includes recorded real-Live results.
- [x] Test failures provide enough diagnostics to reproduce locally.
