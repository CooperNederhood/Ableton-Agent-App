# Test Strategy Implementation To-Do

Companion specification: [Test Strategy](test-strategy.md)

## Test infrastructure

- [x] Select and configure TypeScript and Python test runners.
- [ ] Add shared fixture, fake clock, fake ID, and log-capture utilities.
- [ ] Build fake LOM object library.
- [x] Build simulated Python Remote Script server.
- [x] Build fake Copilot/session adapters for deterministic client tests.
- [ ] Define test tags for unit, contract, integration, Electron, and real Live.

## Coverage implementation

- [ ] Add unit-test requirements to every package template.
- [ ] Implement cross-language protocol contract test runner.
- [ ] Implement bridge fault-injection tests.
- [ ] Implement workflow fake-bridge tests.
- [x] Cover Session clip identity guards, MIDI/audio duplication, launch
  recovery, destructive deletion, property rollback, capability gates, and
  simulator bridge parity.
- [ ] Implement CLI transcript tests.
- [ ] Implement Playwright Electron harness.
- [ ] Create real-Live test project and manual runner.
  - [ ] Record real-Live results for Session launch quantization and rollback,
    MIDI/audio duplication compatibility, deletion, and mute/loop property
    availability.

## CI

- [ ] Add formatting, lint, typecheck, unit, contract, and integration jobs.
- [ ] Add macOS and Windows build/smoke jobs.
- [ ] Cache dependencies without caching generated test results.
- [ ] Publish test reports and artifacts on failure.
- [ ] Enforce package build and protocol compatibility checks.
- [ ] Document how real-Live release validation is recorded.

## Quality controls

- [ ] Define minimum critical-path coverage expectations.
- [ ] Require regression tests with bug fixes.
- [ ] Track flaky tests and prevent silent retries from hiding failures.
- [ ] Add deterministic timeouts to all process/network tests.
- [ ] Add security-oriented malformed-input/fuzz coverage.

## Tests

- [ ] Unit-test test-support utilities and fixture builders.
- [ ] Integration-test the test runners themselves against known pass/fail
  fixtures.
- [ ] Verify CI reports failures, timeouts, and artifacts correctly.
- [ ] Run a clean-checkout rehearsal of every documented test command.

## Exit criteria

- [ ] A clean checkout can run all non-Live tests with one command.
- [ ] CI covers every application-owned boundary.
- [ ] Release checklist includes recorded real-Live results.
- [ ] Test failures provide enough diagnostics to reproduce locally.
