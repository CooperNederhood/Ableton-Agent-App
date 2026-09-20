# Custom Agents Implementation To-Do

Companion specification: [Custom Agents](custom-agents.md)

## Definitions

- [~] Add runtime schemas for definitions, selectors, bindings, active
  instances, diagnostics, and tool patterns.
- [~] Add root `agents/` resources and packaged-resource copying.
- [~] Implement safe YAML discovery, validation, fingerprints, duplicate
  detection, wildcard expansion, and refresh.
- [x] Resolve `*` against Ableton, application-owned, and approved
  session-isolated SDK tools while always excluding `builtin:skill` and
  disabling SDK tool search.
- [x] Enforce the resolved surface through session `availableTools` and let the
  selected native custom agent inherit it so SDK built-ins remain callable.
- [~] Add Default, Compose, Arrange, Sound, and Mix definitions.
  - [x] Define Default as a general-purpose editing-capable agent.
- [x] Resolve definitions through bundled, System, Profile, and Session
      layers with deterministic override metadata and tombstones.
- [x] Add validated copy, move, delete, and semantic rename primitives.
- [x] Add version-2 definition defaults for label, model, reasoning,
  automatic approval, and Live Event listeners with version-1 migration.
- [x] Add revision-checked atomic Session-scope definition publication and
  effective-catalog/Profile refresh.
- [x] Promote an ephemeral unsaved-Set production session when the user
  explicitly saves a Session-scope agent definition.
- [x] Resolve drag-and-drop transfer sources physically so Session agents can
  retain inherited skills while moving between scopes.

## Runtime

- [ ] Replace the single SDK session service with a multi-agent manager.
- [ ] Configure one selected native SDK custom agent per active instance.
- [ ] Attribute messages, operations, approvals, and diagnostics to instances.
- [ ] Restore transcript history with SDK `getEvents()`.
- [ ] Support cold-resume reconfiguration and per-agent cancellation.
- [ ] Keep a one-Default-agent compatibility facade for the CLI.
- [ ] Emit sanitized effective-configuration snapshots on active-instance
  create, resume, reset, and change, linked to subsequent SDK/tool traces.

## Safety

- [ ] Classify every mutation as global, one-track, or multi-track.
- [ ] Register only tools resolved by an agent's allowlist.
- [ ] Bind track selectors to current project identities.
- [ ] Deny stale, ambiguous, cross-project, or unclassified mutations.
- [ ] Implement global and ordered track-reference mutation locks.
- [x] Keep per-agent automatic approval subordinate to global deny/approve
  policy and isolated by request attribution.
- [x] Resolve pending approvals only for newly enabled target instances.

## Persistence and migration

- [ ] Add versioned production sessions with multiple active instances.
- [ ] Persist definition snapshots, overrides, bindings, and selected instance.
- [x] Persist definition-owned model, reasoning, automatic-approval, and
  listener defaults while retaining active runtime snapshots until reset.
- [x] Remove the obsolete turn-mode field, prompt injection, IPC surface, and
  session migration path; active agents are the only workflow selector.
- [ ] Preserve SDK session histories, production plans, and output settings.

## Desktop

- [ ] Add typed definition and active-agent IPC.
- [x] Build the Agents tab and definition diagnostics with active-first
  instance navigation, inactive-definition status, and semantic General,
  Capabilities, and Connections detail views.
- [x] Replace the old selector with Active Agent selection.
- [ ] Partition transcript, activity, approvals, busy state, and cancellation.
- [ ] Remove mode-specific placeholder panels and prompt prefixes.
- [x] Add strict local `/yolo` control, unified slash completion, badges,
  effective-policy warning, and layered Settings status.
- [x] Add typed Profile Manager contracts and a scoped artifact view.
- [x] Add profile lifecycle and artifact-management main-process actions.
- [x] Give active and inactive definitions the same complete editable
  General, Capabilities, and Connections workspace.

## Verification

- [ ] Test invalid and duplicate definitions.
- [ ] Test duplicate active instances and independent histories.
- [ ] Test stale bindings and allowlist denials.
- [ ] Test parallel reads, disjoint edits, and overlapping edit serialization.
- [ ] Test development and packaged resource discovery.
- [ ] Add Electron and real-Live scoped-agent coverage.
- [ ] Test snapshot revision/hash attribution, redaction, and History visibility.
- [x] Test per-agent selected/all updates, switching, deactivation, restart,
  shutdown, races, policy precedence, and structural scope denials.
- [x] Test Session definition publication, stale revisions/fingerprints,
  listener validation, rollback, origin refresh, and active reset adoption.
