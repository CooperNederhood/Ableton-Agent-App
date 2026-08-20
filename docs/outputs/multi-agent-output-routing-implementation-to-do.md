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
- [x] Preserve subscriptions while producers are missing and reconnect by ID.
- [x] Exclude disconnected history from the current producer inventory.

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
- [ ] Test legacy assignment migration.
- [ ] Add renderer, preload, main-process, and real-MIDI integration coverage.
