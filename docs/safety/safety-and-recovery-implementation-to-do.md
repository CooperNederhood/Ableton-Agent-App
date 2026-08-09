# Safety and Recovery Implementation To-Do

Companion specification: [Safety and Recovery](safety-and-recovery.md)

## Policy engine

- [x] Define read, reversible, destructive, and broad risk rules.
- [x] Require risk metadata on every mutating tool/workflow.
- [~] Implement configurable session approval policies.
- [x] Implement pre-tool checks for connection, project identity, capability,
  stale targets, conflicts, and limits.
  - [x] Enforce one shared connection precondition before every project tool.
  - [x] Revalidate identities, capabilities, stale targets, conflicts, and
    operation limits at the application/bridge boundary.
- [~] Implement approval request schemas and expiration.
- [x] Prevent ambiguous blanket approval for destructive/broad operations.

## Guardrails

- [ ] Implement last-track, occupied-slot, ambiguous-name, stale-reference, and
  payload-limit guards.
  - [x] Protect the last track, reject group-track deletion, and revalidate
    expected track name and kind immediately before deletion.
  - [x] Refuse occupied clip slots and bind note replacement to track and clip
    references.
  - [x] Reject Arrangement overlap and revalidate Session/Arrangement clip
    identity and timing before duplication or property updates.
  - [x] Require exact source/destination track identity and exact Session clip
    identity for launch, duplication, deletion, and property updates.
  - [x] Bind cue deletion to a runtime-stable reference plus expected name/time,
    reject duplicate cue times, and bound all loop/cue beat values.
  - [x] Bind regular-track device and parameter operations to exact runtime
    references and names, bound both inspection pages, and reject disabled or
    known non-writable parameters.
  - [x] Bind rack, chain, Drum Rack pad, and pad-chain reads to exact runtime
    references and expected identity fields, prune unreachable references, and
    bound every independently requested page without recursion.
- [x] Validate file imports and supported media.
- [x] Report all clamping and coercion.
- [x] Add workflow mutation-count and duration budgets.
- [x] Investigate and capability-gate native Live undo grouping.

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
  - [x] Restore prior Session playback after failed launch where safe, remove
    failed Session duplicates, and restore applied Session clip properties.
  - [x] Restore the complete Arrangement loop state after partial updates and
    remove cue points created by failed creation.
  - [x] Restore prior device-enable and parameter values after failed mutation
    or verification.
- [x] Define non-reversible operation metadata.
- [x] Stop dependent workflow steps after failure.
- [x] Refresh affected state before reporting partial outcomes.

## Tests

- [x] Unit-test every risk classification and approval transition.
- [ ] Unit-test every guardrail and bypass attempt.
- [ ] Unit-test postcondition tolerances and compensation decisions.
- [~] Integration-test denial, expiration, partial failure, and reconnect.
- [x] Test CLI and React approval parity.
- [ ] Real-Live test native undo behavior before exposing it.

## Exit criteria

- [x] No mutation tool lacks risk metadata and a verifier.
- [x] Destructive/broad actions cannot run without valid approval.
- [x] Partial outcomes are explicit and recoverable where promised.
- [x] The product never claims atomic rollback without validation.
