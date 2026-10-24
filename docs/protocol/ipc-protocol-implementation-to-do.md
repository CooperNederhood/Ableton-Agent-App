# IPC Protocol Implementation To-Do

Companion specification: [IPC Protocol](ipc-protocol.md)

## Schema design

- [x] Add capability-negotiated read-only `listening.inspect_session_source`
  contracts and generated cross-language fixtures, with bounded exact selectors,
  signed origins, nullable unknowns and explicit unverified/message-rate labels.
- [x] Cover strict bounds/authority rejection, clip-kind units, registry parity,
  simulator reads, stale/invalid guards, traced timing and shutdown cancellation.
- [x] Add strict granular Session pass prepare/launch/inspect/release schemas
  and capabilities; only launch is marked mutating, so observational polling
  does not emit project mutations or waive unrelated revision guards.
- [x] Regenerate canonical schemas/command fixtures with truthful playing
  origins, unknown-follow limitations, and nonlaunching cancellation receipts;
  include pass registration in the Remote Script catalog scan.
- [x] Cover TypeScript/Python granular request validation and framing, bounded
  32-receipt release idempotence, deferred-fire fences, disconnect/shutdown
  cleanup, and strict-before-wrap/natural-end admission with no trimming.
- [x] Disclose event-assisted origin polling and missed-between-observation
  limits in Session results/fixtures, without changing wire shapes, claiming
  get-only property notification coverage, or relaxing native alignment gates.
- [x] Specify canonical clip launch quantization ordinals separately from raw
  Python/serialized values, normalize only through guarded public enum members,
  preserve unknown refusal and add shifted/default-Global regression coverage.
- [ ] Qualify a separate native Session launch/capture contract; source inspection
  does not authorize Session playback or establish native alignment.

- [x] Add bounded tri-state listening source inputs with cross-field validation.
  Negotiate protocol 7 / Remote Script and minimum `0.7.0` because old strict
  clients cannot read the extended inspection result.
- [x] Preserve existing wire schemas for placement refresh: replace authenticated
  registration, fence old connection/instance/epoch, recheck after asynchronous
  LOM inspection, and retain query-scoped independent attestation.
- [x] Cover insert-before preserving the original reference, genuine non-Max
  class refusal, same-class replacement identity and stale registration races.
- [ ] Qualify the reviewed edit/relisten scenario against supported owned Live;
  deterministic cross-language evidence does not establish physical acceptance.

- [x] Replace prospective listening start ownership with strict Arrangement
  `cleanupPolicy:"leave-running"` acknowledgement and unverified source onset.
- [x] Regenerate paired JSON fixtures and cover strict rejection of ownership
  fields, traced guarded start, changed identity and unsupported Session/stop.

- [x] Define canonical Zod schemas for every envelope and shared scalar.
- [x] Define protocol constants, frame limits, timeout classes, and versions.
- [x] Define `system.hello`, authentication, capability, ping, and event schemas.
- [x] Define the metadata-only `live_set.save_observed` event with complete
  bounded Live Set/Project identity, decimal nanosecond mtime, and safely
  bounded byte size, plus a backward-compatible same-Song `firstSave` marker.
- [x] Define the complete stable error-code union.
- [x] Define command-specific request/result schemas.
- [x] Add guarded Arrangement positioning-before-arm contracts, exact stopped
  readback/request matching, bridge mutation serialization and cross-language fixtures.
  - [x] Define exact-reference Session clip launch, duplication, deletion, and
    conservative property request/result schemas.
  - [x] Define bounded Arrangement transport inspection, verified loop update,
    and identity-bound cue-point mutation schemas.
  - [x] Define bounded regular-track device/parameter inspection, verified
    device enable, and normalized parameter mutation schemas.
  - [x] Include bounded top-level device summaries and truncation metadata in
    Session track summaries without embedding parameter bodies.
  - [x] Define bounded exact-rack chain, direct chain-device, Drum Rack pad,
    pad-chain, and pad-chain-device inspection schemas.
  - [x] Define strict discriminated Live 11 device source/destination targets,
    exact-position preflight, verified move results, and existing-chain
    name/palette-index property and mixer mutation schemas.
  - [x] Define bounded Browser root/child/search schemas, exact runtime item
    targets, strict traversal limits, and verified built-in load results.
  - [x] Define strict action-discriminated Live 11 scene, track,
    mixer/routing, transport, modern MIDI-note, and audio-clip schemas with
    bounded pages and exact runtime identities.
  - [x] Bound Live 11 launch/record quantization and audio pitch-fine domains,
    and require exact available-warp-mode state for warp-mode assignment.
- [x] Export JSON Schema and representative fixtures for Python tests.

## Framing and negotiation

- [x] Implement four-byte big-endian length framing in TypeScript.
- [x] Implement matching incremental framing in Python.
- [x] Reject zero, oversized, truncated, and invalid UTF-8 payloads.
- [x] Implement protocol-version selection and incompatibility errors.
- [x] Define request ID, event sequence, and project revision semantics.
- [x] Classify expensive device-parameter inspection as a long-running command.
- [x] Keep core-domain inspection and mutation commands separate so read-only
  actions do not trigger project mutation invalidation.
- [ ] Propagate bounded opaque trace/correlation context through command,
  response, and unsolicited-event envelopes and contract fixtures.
- [x] Document additive compatibility and version-bump rules.

## Contract automation

- [x] Compare large committed protocol baselines without silently treating a
  subprocess output overflow or invalid JSON as an absent schema. Add a
  red-before/green-after regression against the actual committed contract.
- [x] Add action-discriminated contracts for the final Live 11 workflow
  adapters and asynchronous jobs.
- [x] Add a typed curated-state snapshot and event envelope.
- [x] Regenerate the committed JSON Schema fixtures without changing the
  protocol version.

- [x] Generate a command catalog from canonical schemas.
- [x] Validate that each command has request, success, and failure fixtures.
- [x] Validate that every bridge command has a Remote Script registry entry.
- [x] Add schema-diff checks to CI for breaking changes.
- [x] Add golden fixtures for all error classes.

## Tests

- [x] Unit-test frame encoding/decoding in both languages.
- [x] Property-test deterministic random fragmentation and frame concatenation.
- [~] Cross-test TypeScript messages in Python and Python messages in
  TypeScript.
- [x] Test authentication, version, malformed request, and sequence failures.
- [x] Test save-observation schema bounds and Python/TypeScript framing.
- [x] Test first-save and Save As identity replacement before downstream save
  listeners observe the event.
- [x] Fuzz decoders with bounded random input.

## Exit criteria

- [x] No implementation relies on “read until JSON parses.”
- [~] Protocol fixtures are a checked compatibility source; per-command golden
  request/result fixtures remain to be added.
- [x] Breaking schema changes fail CI.
- [x] Every production command is represented in the catalog.
# Live identity terminology

- [x] Version the wire contract for `liveSetId`, `liveSetName`, `saved`, and
  optional `liveProjectId`/`liveProjectName`.
- [x] Update capability, identity-command, and Live Event subscription fixtures
  with bounded diagnostics and Live Set-scoped stale guards.
