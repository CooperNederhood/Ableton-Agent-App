# Ableton Bridge Implementation To-Do

Companion specification: [Ableton Bridge](ableton-bridge.md)

## Client API

- [ ] Define `AbletonBridge` and domain operation interfaces.
- [x] Generate/import protocol request and result types.
- [~] Implement structured `BridgeResult`, warnings, and error types.
- [~] Implement capability-aware method guards.
- [~] Implement stable reference types and stale-reference checks.
- [x] Keep raw `sendCommand` private to the bridge package.

## Connection manager

- [x] Implement loopback TCP connection and authentication handshake.
- [x] Implement length-prefixed frame encoding and incremental decoding.
- [x] Track pending requests by request ID.
- [~] Implement command-specific timeouts and cancellation.
- [~] Serialize mutations and support workflow mutation leases.
  - [x] Serialize all primitive mutations through a FIFO bridge queue.
  - [ ] Add multi-step workflow mutation leases.
- [ ] Implement bounded reconnect with jitter and explicit connection states.
- [x] Reject all pending requests predictably after disconnect.
- [ ] Implement event ordering, subscription, and revision propagation.

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
  - [ ] Implement remaining track, clip, arrangement, device, and browser clients.
- [ ] Add pagination and filtering for large browser/parameter results.

## Tests

- [ ] Unit-test encoder, decoder, request tracking, and timeout policy.
- [ ] Unit-test stale references and capability guards.
- [x] Integration-test against the Python simulator.
  - [x] Cover stateful Arrangement loop updates and cue creation/deletion.
- [ ] Test fragmented, combined, malformed, oversized, and out-of-order frames.
- [ ] Test reconnect, event sequence gaps, queue saturation, and cancellation.
- [ ] Run contract tests for every bridge method.

## Exit criteria

- [x] Bridge has no Copilot, Electron, CLI, or React dependencies.
- [x] All disconnections and timeouts produce stable errors.
- [x] Primitive mutations cannot interleave unexpectedly.
- [ ] Simulator and real-Live connectivity tests pass.
