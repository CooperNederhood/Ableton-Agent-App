# Live Events Implementation To-Do

Companion specification: [Live Events](live-events.md)

This document is the source of truth for Live Events and their local detailed
event-journal integration. Update the checkboxes and notes here as
implementation progresses. Related component to-do files remain broader
roadmaps and must not duplicate this checklist.

## Status

- Overall: `[~] In progress`
- Scope: Remote Script-owned subscriptions plus local Desktop history; no Max
  for Live or cloud-journal dependency

Status markers:

- `[ ]` Not started
- `[~]` In progress
- `[x]` Complete and verified
- `[!]` Blocked; record the blocker directly below the item

## Decisions

- [x] Keep Live Events separate from MIDI/audio Outputs.
- [x] Store event definitions once and fan out occurrences to agent listeners
  in the application.
- [x] Use only `Automatic` and `Next prompt` response modes in the Events
  UX.
- [x] Supersede the in-memory-only history decision with a default-on, local,
  redacted event journal; keep in-memory queues bounded for delivery only.
- [x] Do not require a Max for Live device.
- [x] Limit the first event catalog to parameter values and the three primary
  track transition types.

## Phase 1: contracts and persisted state

- [x] Add discriminated schemas for `LiveEventDefinition` target kinds:
  `parameter.value_changed`, `track.playing_clip_changed`,
  `track.triggered_clip_changed`, and `track.recording_state_changed`.
- [x] Add schemas for `LiveEventOccurrence`, resolution status, initial state,
  and invalidation.
- [x] Add `AgentEventListener` with event ID, enabled state, response mode,
  message prefix, and delivery cursor metadata.
- [x] Increment the desktop session version and migrate existing sessions with
  empty `liveEvents` and `eventListeners`.
- [x] Persist event definitions at production-session scope and listeners on
  active-agent instances.
- [x] Add stable ID helpers that cannot collide across events, listeners, and
  Output assignments.
- [x] Define bounded limits for event count, listeners per agent, prefix length,
  occurrence size, and history length.
- [x] Add schema and migration tests, including legacy Output subscriptions and
  `inputChannels`.

Likely files:

- `packages/agent-config/src/schemas.ts`
- `apps/desktop/src/contracts.ts`
- `apps/desktop/src/main/desktop-service.ts`
- `apps/desktop/src/main/headless-desktop-service.ts`
- associated tests

## Phase 2: Remote Script dynamic subscriptions

- [x] Introduce a `LomSubscriptionManager` separate from fixed project revision
  listeners.
- [x] Register dynamic command handlers for selection inspection, subscribe,
  unsubscribe, list, and clear.
- [x] Resolve parameter targets using exact track/device/parameter identities
  and track targets using exact track identity.
- [x] Return initial semantic state when a subscription is installed.
- [x] Implement parameter `value` listeners with normalization and display
  formatting.
- [x] Implement `playing_slot_index` translation for Session clip,
  Arrangement, and stopped states.
- [x] Implement `fired_slot_index` translation for pending clip launches and
  stop triggers.
- [x] Implement recording-state observation using the narrowest documented
  track/clip listeners validated against supported Live versions.
- [x] Deduplicate discrete callbacks whose semantic state did not change.
- [x] Coalesce parameter callbacks with named, tested frequency and delta
  limits.
- [x] Publish `live_event.occurred` and `live_event.invalidated`.
- [x] Remove callback references on unsubscribe, disconnect, Set replacement,
  and control-surface shutdown.
- [x] Add capability flags per supported event kind.
- [x] Extend the simulator with deterministic subscription and occurrence
  behavior.
- [x] Add Python tests for registration, initial state, translation,
  throttling, invalidation, and complete cleanup.

Likely files:

- `remote-script/AbletonAgent/listeners.py`
- new `remote-script/AbletonAgent/event_subscriptions.py`
- `remote-script/AbletonAgent/control_surface.py`
- `remote-script/AbletonAgent/system_commands.py` or a new command module
- `remote-script/AbletonAgent/capabilities.py`
- `remote-script/simulator.py`
- `remote-script/tests/`

## Phase 3: protocol and bridge

- [x] Add TypeScript command schemas and generated protocol contract fixtures.
- [x] Add Python validation matching the canonical TypeScript schemas.
- [x] Extend the bridge with inspect-selection and dynamic event subscription
  methods.
- [x] Request `live_event.occurred` and `live_event.invalidated` during the
  authenticated handshake.
- [x] Decode occurrences into typed bridge events.
- [x] Preserve sequence-gap reporting and expose a reconciliation signal to
  the event runtime.
- [x] Replay enabled event definitions after reconnect without delivering the
  returned initial state as a trigger.
- [x] Mark unresolved and invalidated targets explicitly.
- [x] Add contract tests and simulator-backed bridge tests for subscribe,
  unsubscribe, reconnect replay, event ordering, and gaps.

Likely files:

- `packages/protocol/src/schemas.ts`
- `packages/protocol/src/catalog.ts`
- generated files under `packages/protocol/contracts/`
- `packages/bridge/src/index.ts`
- `packages/runtime/src/composition.ts`
- associated tests

## Phase 4: application event runtime and delivery

- [x] Add an application-owned Live Event runtime that keeps one active Remote
  Script subscription per enabled event definition.
- [x] Maintain resolution status and latest state; use bounded in-memory queues
  for delivery rather than as durable occurrence history.
- [x] Fan one occurrence out to every enabled `AgentEventListener`.
- [x] Reuse or extract Output delivery primitives for per-agent inboxes,
  cursors, automatic-turn scheduling, and deduplication without adding Live
  Events to the Output producer inventory.
- [x] Implement `Next prompt`: latest-only continuous context and bounded
  ordered discrete context.
- [x] Implement `Automatic`: settled continuous delivery and ordered discrete
  delivery through the target managed agent session.
- [x] Attach listener-scoped prepared project context to automatic turns without
  duplicating it into the visible occurrence payload.
- [x] Treat prepared-context TTL expiry as mutable-state age rather than exact
  identity invalidation, and direct automatic turns to use complete guarded
  references without a preliminary inspection.
- [x] Fall back to inspection for missing, ambiguous, unresolved, truncated, or
  explicitly rejected identities, while blocking unchanged stale-reference
  retries.
- [x] Record bounded prepared-context age, revision, identity-count, truncation,
  and unresolved-locator diagnostics without persisting the context body.
- [x] Prepend the configured message immediately before the normalized event
  summary.
- [x] Preserve normal agent tool permissions, edit scopes, auto-approval, and
  mutation locks for automatic turns.
- [x] Define busy-agent behavior: queue one delivery per discrete occurrence
  and coalesce continuous deliveries to the latest unsettled value.
- [x] Reconcile from current state after a bridge event gap rather than
  replaying uncertain transitions.
- [x] Transactionally remove agent listeners when an event is deleted.
- [x] Add unit tests for fan-out, per-agent isolation, response modes, prefix
  formatting, coalescing, deletion, reconnect, and failure isolation.

Likely files:

- new package or module under `packages/runtime` or `packages/application`
- `packages/application/src/index.ts`
- existing signal-delivery code if generalized
- `apps/desktop/src/main/headless-desktop-service.ts`
- associated tests

## Phase 5: desktop IPC and preload

- [x] Add IPC operations to list, create, update, enable, disable, and delete
  Live Events.
- [x] Add selection-inspection IPC used by **Watch selected parameter**.
- [x] Add IPC operations to assign/unassign an event listener to an explicit
  active-agent instance and update response mode or message prefix.
- [x] Include Events state in initial hydration and shared desktop events.
- [x] Add preload methods with schema validation for every operation.
- [x] Test malformed payload rejection and explicit agent attribution.

Likely files:

- `apps/desktop/src/contracts.ts`
- `apps/desktop/src/main/desktop-service.ts`
- `apps/desktop/src/main/headless-desktop-service.ts`
- `apps/desktop/src/main/ipc.ts`
- `apps/desktop/src/preload/api.ts`
- associated tests

## Phase 6: Events tab UX

- [x] Add `events` to `WorkspaceView` and the top-level navigation.
- [x] Add the Events state slice, hydration, reducer actions, loading states,
  and diagnostics.
- [x] Build **Add event** with quick actions for selected parameter and selected
  track.
- [x] Present the selected track first and show only the three recommended
  discrete events before **Browse all**.
- [x] Add a bounded Parameter → Track → Device → Parameter fallback picker.
- [x] Group event cards by track using snapshot color metadata.
- [x] Add separate Global and Unresolved groups.
- [x] Show type, current value/state, resolution, enabled state, and listening
  agents on each card.
- [x] Add edit, disable, and delete actions with appropriate confirmation.
- [x] Add collapsed-by-default **Recent activity** with bounded newest-first
  occurrences.
- [ ] Back **Recent activity** with cursor-paginated local journal queries
  instead of process-memory history.
- [x] Ensure event state is not represented by color alone and all controls are
  keyboard accessible.
- [x] Throttle renderer updates independently from socket ingestion.
- [x] Add renderer tests for creation paths, grouping, stale targets,
  disclosure state, listener labels, and empty/error states.

Likely files:

- `apps/desktop/src/renderer/App.tsx`
- `apps/desktop/src/renderer/state.ts`
- `apps/desktop/src/renderer/styles.css`
- renderer tests

## Phase 7: Agents tab UX

- [x] Add a **Listening Events** summary to every active-agent card.
- [x] Add a Skills-style event selector inside **Edit overrides**.
- [x] Expand selected event rows to show `Automatic` or `Next prompt`.
- [x] Add the optional message-prefix textarea per listener.
- [x] Save listener edits independently from canonical agent config overrides
  so event changes do not rewrite tools, scope, skills, or `inputChannels`.
- [x] Leave the existing free-form **Inputs** editor unchanged alongside the new
  **Listening Events** editor.
- [x] Update live when Events are created, renamed, disabled, or deleted.
- [x] Add renderer and service tests for multiple agents listening to one event,
  one agent listening to many events, and independent listener settings.

Likely files:

- `apps/desktop/src/renderer/App.tsx`
- `apps/desktop/src/contracts.ts`
- `apps/desktop/src/main/headless-desktop-service.ts`
- associated tests

## Phase 8: verification and documentation

- [x] Add protocol contract fixtures for every new command and event payload.
- [x] Add Remote Script listener leak tests and reconnect cleanup tests.
- [x] Add simulator integration covering continuous and discrete events.
- [x] Add application tests proving automatic delivery targets the correct
  agent session and next-message delivery waits for that agent's user turn.
- [x] Add prepared-context and application tests proving expired exact
  identities remain usable, automatic guidance is listener-scoped, insufficient
  identities require inspection, and context diagnostics exclude exact
  references.
- [x] Add Electron tests for the Events tab and Listening Events editor.
- [x] Add real-Live scenarios:
  - turn a rack macro and observe bounded parameter occurrences;
  - launch two clips on one track and observe ordered playing-clip changes;
  - queue a quantized clip and observe triggered then playing transitions;
  - reconnect the desktop app and verify subscriptions are restored once;
  - delete a watched target and verify invalidation and cleanup.
- [x] Update README and user-facing help after the feature behavior is stable.
- [x] Run the smallest relevant test suites per phase, then the repository's
  existing full validation before merge.

The real-Live scenarios above are the manual acceptance suite for a supported
Live 11.3+ or 12.x installation. They require installing the updated Remote
Script and restarting Live; automated tests cover the same normalization,
ordering, reconnect, invalidation, and cleanup contracts without controlling
the Ableton application lifecycle.

## Phase 9: local detailed event journal

- [ ] Add a versioned, append-only journal record envelope with event/source
  type, lifecycle stage, timestamps, trace/correlation/causation IDs, scoped
  entity IDs, outcome, timings, and bounded sanitized payloads.
- [ ] Capture sanitized agent-configuration snapshots on create, resume, and
  change.
- [ ] Capture the complete unsampled SDK, tool, workflow, approval, bridge, Live
  Event, and Output activity lifecycle without persisting raw sensitive
  content.
- [ ] Record the Live Event stages observed, transported, normalized, persisted,
  routed, and delivered, including child delivery events for fan-out.
- [ ] Propagate trace and correlation IDs through automatic turns, SDK events,
  tool/workflow execution, bridge requests, and Remote Script activity.
- [ ] Reuse the journal writer, trace envelope, retention, and query
  infrastructure for Outputs while preserving separate Output and Live Event
  domains, source inventories, delivery rules, and UI filters.
- [x] Store the journal only under the current user's
  `~/.live-agent/profiles/{profile}/observability` directory, with capture
  defaulting on and no upload path.
- [ ] Add pause, clear, and per-session deletion controls, 30-day age pruning,
  and a 250 MiB hard cap with oldest-first eviction.
- [ ] Add typed History query/detail APIs and a paginated, virtualized Desktop
  UI with time, category, stage, outcome, agent, source, tool, session, trace,
  and correlation filters.
- [ ] Make ingestion asynchronous and bounded, preserve per-trace order in
  batches, incrementally prune, index cursor queries, cancel stale UI queries,
  and surface saturation or persistence failure.
- [ ] Add schema/migration, producer coverage, sanitization, local-only/default
  settings, trace continuity, stage ordering, fan-out isolation, retention/cap,
  query/pagination, failure, and sustained-load tests.
- [ ] Demonstrate 200 ms p95 first-page filtered queries at the 250 MiB cap and
  no visible regression to SDK streaming or Live Event delivery.

## Out of scope

- Max for Live companion devices.
- Arbitrary user-entered LOM paths or property names.
- Cloud journal transport or upload.
- Audio-rate observation.
- User-defined scripting or transformations.
- A complete catalog of every observable LOM property.
- Consolidating Outputs and Live Events into one UI before both workflows are
  validated independently.
