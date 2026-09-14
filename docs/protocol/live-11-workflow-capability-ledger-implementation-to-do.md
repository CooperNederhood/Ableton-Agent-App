# Live 11 workflow capability ledger implementation plan

## Contract and safety

- [x] Define strict grouped schemas for recording, grooves, selection/view,
  Live history, Browser adapters, Session automation, warp markers,
  specialized devices, and workflow jobs.
- [x] Route every public action through a granular internal protocol command
  and command-specific validator.
- [x] Add action-specific capabilities, approval metadata, edit scopes, locks,
  exact identities, bounded payloads, verification, and mutation invalidation.
- [x] Require exact scene reference/name as well as track and occupancy identity
  for Session-slot recording, slot selection, and Looper export.
- [x] Fail closed when an advertised capability document omits an
  action-required capability.
- [x] Preserve boolean capability compatibility while adding evidence,
  minimum/tested versions, and bounded limitations.
- [x] Compile operation-ID agent patterns into capability-pruned canonical
  domain schemas and keep migrated compatibility aliases exact-only.

## Runtime

- [x] Implement capability-detected Live 11 Remote Script handlers.
- [x] Implement timed recording and Looper export as cancellable jobs with
  queued, started, progress, completed, failed, cancelled, and indeterminate
  lifecycle events.
- [x] Retain mutation locks and delay application completion lifecycle until
  workflow jobs become terminal; keep cancellation executable and terminal.
- [x] Add curated initial state, listener rebinding, bounded meter coalescing,
  cleanup, and trace/correlation/causation propagation.
- [x] Keep meter publications out of project mutation revisions and verify
  Browser restoration, including explicit null state.
- [x] Keep segment BPM read-only when no proven Live 11 marker setter exists.

## Clients and verification

- [x] Wire bridge, application, tools, simulator, fakes, CLI, and Desktop
  presentation.
- [x] Add protocol, policy, bridge, Remote Script, listener, lifecycle,
  cancellation, attribution, and redaction tests.
- [x] Model running, completion, cancellation, and terminal job semantics in
  the simulator.
- [x] Generate and compatibility-check protocol contracts.
- [ ] Complete real-Live smoke validation for private Live 11 API shapes.
