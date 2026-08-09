# IPC Protocol Implementation To-Do

Companion specification: [IPC Protocol](ipc-protocol.md)

## Schema design

- [x] Define canonical Zod schemas for every envelope and shared scalar.
- [x] Define protocol constants, frame limits, timeout classes, and versions.
- [x] Define `system.hello`, authentication, capability, ping, and event schemas.
- [x] Define the complete stable error-code union.
- [x] Define command-specific request/result schemas.
  - [x] Define exact-reference Session clip launch, duplication, deletion, and
    conservative property request/result schemas.
  - [x] Define bounded Arrangement transport inspection, verified loop update,
    and identity-bound cue-point mutation schemas.
  - [x] Define bounded regular-track device/parameter inspection, verified
    device enable, and normalized parameter mutation schemas.
  - [x] Define bounded exact-rack chain, direct chain-device, Drum Rack pad,
    pad-chain, and pad-chain-device inspection schemas.
  - [x] Define bounded Browser root/child/search schemas, exact runtime item
    targets, strict traversal limits, and verified built-in load results.
- [x] Export JSON Schema and representative fixtures for Python tests.

## Framing and negotiation

- [x] Implement four-byte big-endian length framing in TypeScript.
- [x] Implement matching incremental framing in Python.
- [x] Reject zero, oversized, truncated, and invalid UTF-8 payloads.
- [x] Implement protocol-version selection and incompatibility errors.
- [x] Define request ID, event sequence, and project revision semantics.
- [x] Document additive compatibility and version-bump rules.

## Contract automation

- [x] Generate a command catalog from canonical schemas.
- [ ] Validate that each command has request, success, and failure fixtures.
- [x] Validate that every bridge command has a Remote Script registry entry.
- [x] Add schema-diff checks to CI for breaking changes.
- [x] Add golden fixtures for all error classes.

## Tests

- [x] Unit-test frame encoding/decoding in both languages.
- [x] Property-test deterministic random fragmentation and frame concatenation.
- [~] Cross-test TypeScript messages in Python and Python messages in
  TypeScript.
- [x] Test authentication, version, malformed request, and sequence failures.
- [x] Fuzz decoders with bounded random input.

## Exit criteria

- [x] No implementation relies on “read until JSON parses.”
- [~] Protocol fixtures are a checked compatibility source; per-command golden
  request/result fixtures remain to be added.
- [x] Breaking schema changes fail CI.
- [x] Every production command is represented in the catalog.
