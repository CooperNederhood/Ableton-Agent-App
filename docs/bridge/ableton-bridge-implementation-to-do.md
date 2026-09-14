# Ableton Bridge Implementation To-Do

Companion specification: [Ableton Bridge](ableton-bridge.md)

## Client API

- [x] Define `AbletonBridge` and domain operation interfaces.
- [x] Generate/import protocol request and result types.
- [~] Implement structured `BridgeResult`, warnings, and error types.
- [~] Implement capability-aware method guards.
- [~] Implement stable reference types and stale-reference checks.
- [x] Keep raw `sendCommand` private to the bridge package.

## Connection manager

- [x] Implement loopback TCP connection and authentication handshake.
- [x] Implement length-prefixed frame encoding and incremental decoding.
- [x] Track pending requests by request ID.
- [x] Implement command-specific timeouts and cancellation.
- [~] Serialize Live requests and support workflow mutation leases.
  - [x] Serialize all primitive reads and mutations through a bounded FIFO
    bridge queue, starting response timeouts at dispatch.
  - [ ] Add multi-step workflow mutation leases.
- [x] Implement bounded reconnect with jitter and explicit connection states.
- [x] Reject all pending requests predictably after disconnect.
- [x] Implement event ordering, subscription, and revision propagation.
- [x] Propagate trace/correlation context and publish sanitized queue, dispatch,
  completion, failure, timeout, cancellation, reconnect, and event-ingestion
  lifecycle with queue, execution, and total timing.

## Domain modules

- [x] Implement system/capability operations.
- [~] Implement transport and snapshot operations.
  - [x] Implement capability-gated Arrangement loop/cue inspection and
    serialized loop/cue mutations.
- [~] Implement track, clip, arrangement, device, and browser clients.
  - [x] Implement capability-gated track creation and identity-bound deletion.
  - [x] Implement paginated Arrangement inspection and identity-bound clip deletion.
  - [x] Implement identity-bound Arrangement MIDI note replacement.
  - [x] Implement guarded Session-to-Arrangement duplication and clip properties.
  - [x] Implement capability-gated, schema-validated Session launch,
    duplication, deletion, and property clients.
  - [x] Implement capability-gated bounded regular-track device/parameter
    inspection and serialized verified device/parameter mutations.
  - [x] Implement capability-gated bounded exact-rack chains, chain devices,
    Drum Rack pads, pad chains, and pad-chain devices.
  - [x] Implement capability-gated bounded Browser roots/children/search and
    serialized exact-item built-in loading with strict result schemas.
  - [ ] Implement remaining track, clip, arrangement, device, and browser clients.
- [x] Add pagination and filtering for large browser/parameter results.

## Tests

- [x] Unit-test encoder, decoder, request tracking, and timeout policy.
- [x] Unit-test stale references and capability guards.
- [x] Integration-test against the Python simulator.
  - [x] Cover stateful Arrangement loop updates and cue creation/deletion.
- [x] Test fragmented, combined, malformed, oversized, and out-of-order frames.
- [x] Test reconnect, event sequence gaps, queue saturation, and cancellation.
  - [x] Test bounded reconnect, event sequence-gap reporting, serialized reads,
    dispatch-scoped timeout budgets, queue saturation, and stop cancellation.
- [x] Run contract tests for every bridge method.
- [~] Test lifecycle coverage, timing, trace continuity, and non-blocking
  observability during saturation, gaps, cancellation, and reconnect.
  Queue/dispatch/completion timing and cancellation coverage are implemented;
  sustained non-blocking saturation coverage remains.
- [x] Route final Live 11 workflow-adapter reads and mutations through the
  all-request serialized queue with action-specific capabilities and mutation
  invalidation.
- [x] Validate curated state and workflow-job events and retain job
  trace/correlation/causation IDs in observability records.
- [x] Route final workflow actions to granular internal commands and retain
  additive capability evidence/details from the Live 11 handshake.

## Exit criteria

- [x] Bridge has no Copilot, Electron, CLI, or React dependencies.
- [x] All disconnections and timeouts produce stable errors.
- [x] Primitive mutations cannot interleave unexpectedly.
- [~] Simulator and real-Live connectivity tests pass.
  - [x] Simulator connectivity passes through the same `live-smoke` command.
  - [ ] Record supported real-Live connectivity evidence.
