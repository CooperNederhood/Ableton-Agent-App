# IPC Protocol Implementation To-Do

Companion specification: [IPC Protocol](ipc-protocol.md)

## Schema design

- [ ] Define canonical Zod schemas for every envelope and shared scalar.
- [ ] Define protocol constants, frame limits, timeout classes, and versions.
- [ ] Define `system.hello`, authentication, capability, ping, and event schemas.
- [x] Define the complete stable error-code union.
- [ ] Define command-specific request/result schemas.
  - [x] Define exact-reference Session clip launch, duplication, deletion, and
    conservative property request/result schemas.
  - [x] Define bounded Arrangement transport inspection, verified loop update,
    and identity-bound cue-point mutation schemas.
  - [x] Define bounded regular-track device/parameter inspection, verified
    device enable, and normalized parameter mutation schemas.
  - [x] Define bounded exact-rack chain, direct chain-device, Drum Rack pad,
    pad-chain, and pad-chain-device inspection schemas.
- [ ] Export JSON Schema and representative fixtures for Python tests.

## Framing and negotiation

- [x] Implement four-byte big-endian length framing in TypeScript.
- [x] Implement matching incremental framing in Python.
- [ ] Reject zero, oversized, truncated, and invalid UTF-8 payloads.
- [ ] Implement protocol-version selection and incompatibility errors.
- [ ] Define request ID, event sequence, and project revision semantics.
- [ ] Document additive compatibility and version-bump rules.

## Contract automation

- [ ] Generate a command catalog from canonical schemas.
- [ ] Validate that each command has request, success, and failure fixtures.
- [ ] Validate that every bridge command has a Remote Script registry entry.
- [ ] Add schema-diff checks to CI for breaking changes.
- [ ] Add golden fixtures for all error classes.

## Tests

- [x] Unit-test frame encoding/decoding in both languages.
- [ ] Property-test random fragmentation and frame concatenation.
- [ ] Cross-test TypeScript messages in Python and Python messages in
  TypeScript.
- [ ] Test authentication, version, malformed request, and sequence failures.
- [ ] Fuzz decoders with bounded random input.

## Exit criteria

- [x] No implementation relies on “read until JSON parses.”
- [ ] Protocol fixtures are the shared compatibility source.
- [ ] Breaking schema changes fail CI.
- [ ] Every production command is represented in the catalog.
