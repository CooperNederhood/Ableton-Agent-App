# Multi-Agent Output Routing Implementation To-Do

Companion specification:
[Multi-Agent Output Routing](multi-agent-output-routing.md)

## Contracts

- [ ] Add active-agent identity to Desktop output subscriptions.
- [ ] Replace implicit active-session IPC with explicit agent-instance IDs.
- [ ] Version and migrate existing output assignments.

## Runtime

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
- [ ] Forward the audio client's backpressure lifecycle callbacks through
  authenticated ingress into typed local History. The current runtime ignores
  them; callback tests/Max output are not end-to-end journal coverage.

## Desktop

- [ ] Add an active-agent checkbox matrix to Outputs.
- [ ] Scope delivery mode and usage instruction controls to subscriptions.
- [ ] Reflect subscription changes in active-agent session editing.
- [ ] Update live when agents are activated, deactivated, or renamed.
- [x] Separate live outputs from unmatched active-agent subscriptions.
- [x] Refresh signal state when Outputs opens and on explicit request.

## Verification

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
