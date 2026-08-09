# Safety and Recovery Implementation To-Do

Companion specification: [Safety and Recovery](safety-and-recovery.md)

## Policy engine

- [x] Define read, reversible, destructive, and broad risk rules.
- [x] Require risk metadata on every mutating tool/workflow.
- [~] Implement configurable session approval policies.
- [ ] Implement pre-tool checks for connection, project identity, capability,
  stale targets, conflicts, and limits.
- [~] Implement approval request schemas and expiration.
- [ ] Prevent ambiguous blanket approval for destructive/broad operations.

## Guardrails

- [ ] Implement last-track, occupied-slot, ambiguous-name, stale-reference, and
  payload-limit guards.
  - [x] Protect the last track, reject group-track deletion, and revalidate
    expected track name and kind immediately before deletion.
  - [x] Refuse occupied clip slots and bind note replacement to track and clip
    references.
  - [x] Reject Arrangement overlap and revalidate Session/Arrangement clip
    identity and timing before duplication or property updates.
- [ ] Validate file imports and supported media.
- [ ] Report all clamping and coercion.
- [ ] Add workflow mutation-count and duration budgets.
- [ ] Investigate and capability-gate native Live undo grouping.

## Verification and recovery

- [~] Define verifiers for every primitive mutation.
- [~] Implement minimal before-state capture.
- [~] Implement supported compensating operations.
  - [x] Remove clips created by failed creation and restore core MIDI note
    attributes after replacement or verification failure.
  - [x] Require explicit approval-visible opt-in before a non-empty note
    replacement can discard per-note MPE/expression data.
  - [x] Delete failed Arrangement duplicates and restore all applied clip
    properties after mutation or verification failure.
- [ ] Define non-reversible operation metadata.
- [ ] Stop dependent workflow steps after failure.
- [ ] Refresh affected state before reporting partial outcomes.

## Tests

- [x] Unit-test every risk classification and approval transition.
- [ ] Unit-test every guardrail and bypass attempt.
- [ ] Unit-test postcondition tolerances and compensation decisions.
- [~] Integration-test denial, expiration, partial failure, and reconnect.
- [ ] Test CLI and React approval parity.
- [ ] Real-Live test native undo behavior before exposing it.

## Exit criteria

- [x] No mutation tool lacks risk metadata and a verifier.
- [ ] Destructive/broad actions cannot run without valid approval.
- [ ] Partial outcomes are explicit and recoverable where promised.
- [ ] The product never claims atomic rollback without validation.
