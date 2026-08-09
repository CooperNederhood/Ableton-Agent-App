# Ableton Bridge Implementation To-Do

Companion specification: [Ableton Bridge](ableton-bridge.md)

## Client API

- [ ] Define `AbletonBridge` and domain operation interfaces.
- [ ] Generate/import protocol request and result types.
- [ ] Implement structured `BridgeResult`, warnings, and error types.
- [ ] Implement capability-aware method guards.
- [ ] Implement stable reference types and stale-reference checks.
- [ ] Keep raw `sendCommand` private to the bridge package.

## Connection manager

- [ ] Implement loopback TCP connection and authentication handshake.
- [ ] Implement length-prefixed frame encoding and incremental decoding.
- [ ] Track pending requests by request ID.
- [ ] Implement command-specific timeouts and cancellation.
- [ ] Serialize mutations and support workflow mutation leases.
- [ ] Implement bounded reconnect with jitter and explicit connection states.
- [ ] Reject all pending requests predictably after disconnect.
- [ ] Implement event ordering, subscription, and revision propagation.

## Domain modules

- [ ] Implement system/capability operations.
- [ ] Implement transport and snapshot operations.
- [ ] Implement track, clip, arrangement, device, and browser clients.
- [ ] Add pagination and filtering for large browser/parameter results.

## Tests

- [ ] Unit-test encoder, decoder, request tracking, and timeout policy.
- [ ] Unit-test stale references and capability guards.
- [ ] Integration-test against the Python simulator.
- [ ] Test fragmented, combined, malformed, oversized, and out-of-order frames.
- [ ] Test reconnect, event sequence gaps, queue saturation, and cancellation.
- [ ] Run contract tests for every bridge method.

## Exit criteria

- [ ] Bridge has no Copilot, Electron, CLI, or React dependencies.
- [ ] All disconnections and timeouts produce stable errors.
- [ ] Mutations cannot interleave unexpectedly.
- [ ] Simulator and real-Live connectivity tests pass.

