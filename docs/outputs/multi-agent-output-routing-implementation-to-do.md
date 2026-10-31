# Multi-Agent Output Routing Implementation To-Do

Companion specification:
[Multi-Agent Output Routing](multi-agent-output-routing.md)

## Contracts

- [x] Define bounded typed listening failure summaries and source
  check/predicate/operand coverage without adding audio payloads or capture
  authority. Preserve strict comparisons, clock domains and unknown values.
- [x] Finish native failed/partial/cancelled serializer, source lifecycle and
  private non-authoritative reader-snapshot qualification with unchanged
  capture/readiness/ACK/cleanup guards.
- [x] Negotiate optional wire4 retained measurement delivery with exact legacy
  and feature-bearing capability tuples, preserving existing observation
  formats and wire1/2/3 primary-capability compatibility.
- [x] Reuse that exact protocol validator at independent application binding,
  admitting retained listeners without filtering them from discovery. Reproduce
  the old one-capability rejection at both binding and production-runtime
  boundaries; preserve unknown/duplicate/reordered capability denial.
- [ ] Add active-agent identity to Desktop output subscriptions.
- [ ] Replace implicit active-session IPC with explicit agent-instance IDs.
- [ ] Version and migrate existing output assignments.

## Runtime

- [x] Publish one supported-capability list, including `audio-listener/retention-v1`,
  in canonical/legacy ingress discovery and listener hello ACKs. Reject missing
  producer feature support before arm/results without silently downgrading.
- [x] Refresh audio listener placement from its own device anchor, renew
  authenticated registration on change and fence old native proof/callbacks.
  Preserve path-derived ID semantics and do not migrate subscriptions by name,
  old index or numeric-ID coincidence.
- [x] Cover one-shot MIDI compatibility, changed/unavailable placement,
  same-class replacement, registration races and exact-generation cleanup.
- [ ] Qualify insert-before/relisten in an owned Live process and ordinary
  Desktop approvals; existing user Live currently blocks the isolated gate.

- [ ] Replace the single active signal session with registered agent consumers.
- [ ] Fan out producer frames to every enabled subscription.
- [ ] Isolate inboxes, latest windows, acknowledgements, and deduplication.
- [ ] Route automatic turns to the matching managed agent session.
- [ ] Emit sanitized, correlated Output ingress and per-agent delivery lifecycle
  records through the shared local journal, retaining bounded structured
  MIDI/event payloads while omitting binary/audio bodies with visible markers.
- [ ] Reuse journal writer, retention, and query infrastructure while keeping
  Output and Live Event schemas, inventories, routing, and UI separate.
- [x] Preserve subscriptions while producers are missing and reconnect by ID.
- [x] Exclude disconnected history from the current producer inventory.
- [x] Handle accepted producer writes under backpressure with bounded
  same-connection FIFO/drain, unchanged protocol ACK/authority, explicit failure
  and cancellation cleanup, and redacted attributed lifecycle status.
- [x] Forward actual audio-client backpressure callbacks through negotiated
  authenticated heartbeats into the production recorder and typed journal.
  Bound batches/retention, preserve frozen source ownership/timing, isolate
  diagnostic errors and deduplicate metadata-only normal reconnect delivery.
- [ ] Qualify real-native lifecycle rows and socket metrics in typed History;
  callback/console output and a heartbeat ACK alone are not proof of persistence.
  First new-resource attempt f3b93259 passes capture/final checks, but complete
  producer History has only an unknown-coverage disconnect and no source rows;
  actual callbacks/write-return/cause remain unproven.

## Desktop

- [ ] Add an active-agent checkbox matrix to Outputs.
- [ ] Scope delivery mode and usage instruction controls to subscriptions.
- [ ] Reflect subscription changes in active-agent session editing.
- [ ] Update live when agents are activated, deactivated, or renamed.
- [x] Separate live outputs from unmatched active-agent subscriptions.
- [x] Refresh signal state when Outputs opens and on explicit request.

## Verification

- [x] Drive an actual controlled native-controller preflight rejection through
  shipping SDK/authenticated ingress, capture/coordinator/public agent result
  and real journal close/reopen with typed trace reads. Retain exact operands,
  timing, explicit coverage and no playback/publication.
- [x] Drive the shipping FAILED-only SDK helper with an unsupported optional
  diagnostic through authenticated TCP, coordinator/public result and reopened
  typed History. Preserve the original failure exactly once, explicit coverage
  gap, no private body, no playback/publication and one reservation release.
- [x] Verify callback suppression accounting without dropping journal
  rejection events; reproduce/fix canonical nested diagnostic credential
  redaction and repeated sanitation.
- [x] Verify isolated Electron failure/preload/read-only-IPC presentation and
  owned History trace navigation without excluding native/system rows lacking
  App-session/agent IDs.
- [x] Validate actual persisted canonical/legacy descriptors with the real shared
  SDK and authenticated typed ingress for retained and primary-only wire4
  producers; preserve old-peer rejection and lifecycle/diagnostic guards.
- [ ] Test one producer feeding multiple agents.
- [ ] Test independent next-prompt acknowledgement.
- [ ] Test automatic fan-out and per-agent errors.
- [x] Test disconnected producer recovery and current-inventory cleanup.
- [x] Cover large native results through authenticated TCP, exact-once delivery,
  stable connection/epoch, and shared MIDI compatibility; include drain timeout,
  byte/pending quotas, callback errors, cancellation and stale callbacks.
- [ ] Test legacy assignment migration.
- [ ] Add renderer, preload, main-process, and real-MIDI integration coverage.
- [ ] Test journal redaction, trace continuity, fan-out attribution, and the
  separation of Output and Live Event query categories.
