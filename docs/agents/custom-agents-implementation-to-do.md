# Custom Agents Implementation To-Do

Companion specification: [Custom Agents](custom-agents.md)

## Definitions

- [~] Add runtime schemas for definitions, selectors, bindings, active
  instances, diagnostics, and tool patterns.
- [~] Add root `agents/` resources and packaged-resource copying.
- [~] Implement safe YAML discovery, validation, fingerprints, duplicate
  detection, wildcard expansion, and refresh.
- [~] Add Default, Compose, Arrange, Sound, and Mix definitions.

## Runtime

- [ ] Replace the single SDK session service with a multi-agent manager.
- [ ] Configure one selected native SDK custom agent per active instance.
- [ ] Attribute messages, operations, approvals, and diagnostics to instances.
- [ ] Restore transcript history with SDK `getEvents()`.
- [ ] Support cold-resume reconfiguration and per-agent cancellation.
- [ ] Keep a one-Default-agent compatibility facade for the CLI.

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
- [x] Persist `autoApprove` per active instance with a migration default of
  `false`.
- [ ] Migrate legacy mode sessions atomically and idempotently.
- [ ] Preserve SDK session histories, production plans, and output settings.

## Desktop

- [ ] Add typed definition and active-agent IPC.
- [ ] Build the Agents tab and definition diagnostics.
- [ ] Replace Mode with Agent Mode.
- [ ] Partition transcript, activity, approvals, busy state, and cancellation.
- [ ] Remove mode-specific placeholder panels and prompt prefixes.
- [x] Add strict local `/yolo` control, unified slash completion, badges,
  effective-policy warning, and layered Settings status.

## Verification

- [ ] Test invalid and duplicate definitions.
- [ ] Test duplicate active instances and independent histories.
- [ ] Test stale bindings and allowlist denials.
- [ ] Test parallel reads, disjoint edits, and overlapping edit serialization.
- [ ] Test development and packaged resource discovery.
- [ ] Add Electron and real-Live scoped-agent coverage.
- [x] Test per-agent selected/all updates, switching, deactivation, restart,
  shutdown, races, policy precedence, and structural scope denials.
