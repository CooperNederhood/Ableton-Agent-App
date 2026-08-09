# Delivery Roadmap Implementation To-Do

Companion specification: [Delivery Roadmap](roadmap.md)

## Project tracking

- [x] Convert roadmap phases into GitHub milestones.
- [x] Create labels for component, risk, test layer, platform, and Live version.
- [x] Create issue templates requiring acceptance criteria and test plans.
- [ ] Link every implementation checklist item to an issue before execution.
- [x] Maintain dependency links and milestone exit criteria.

Remaining release work is grouped into:

- [Real-Live compatibility matrix](https://github.com/CooperNederhood/Ableton-Agent-App/issues/1)
- [Signed release pipeline](https://github.com/CooperNederhood/Ableton-Agent-App/issues/2)
- [Desktop E2E and performance](https://github.com/CooperNederhood/Ableton-Agent-App/issues/3)
- [Safety hardening](https://github.com/CooperNederhood/Ableton-Agent-App/issues/4)
- [Release documentation and audit](https://github.com/CooperNederhood/Ableton-Agent-App/issues/5)

## Phase execution

- [x] Complete Phase 0 foundation prototype and architecture decisions.
- [x] Complete Phase 1 protocol, Remote Script, bridge, and simulator.
- [x] Complete Phase 2 reference CLI and core production operations.
- [x] Complete Phase 3 devices, browser, racks, and plug-ins.
- [x] Complete Phase 4 React superset and deterministic workflows.
- [ ] Complete Phase 5 packaging, compatibility, security, and release.

## Review cadence

- [ ] Review master and component plans at each milestone boundary.
- [ ] Record deviations as architecture decisions rather than silent changes.
- [ ] Reprioritize feature breadth behind reliability blockers.
- [ ] Track unsupported/experimental LOM features separately.
- [ ] Require milestone demonstrations using a real Ableton test project.

## Release readiness

- [ ] Complete security and privacy review.
- [ ] Complete performance profiling and responsiveness checks.
- [ ] Complete supported-platform install matrix.
- [ ] Complete real-Live compatibility matrix.
- [ ] Resolve or document all known critical/high issues.
- [ ] Publish installation, troubleshooting, privacy, and release notes.

## Tests

- [x] Add an automated check that every specification retains a paired plan.
- [~] Add an automated check for broken documentation and issue links.
  - [x] Validate every local Markdown link in `pnpm check`.
  - [ ] Validate external GitHub issue links when issue tracking is populated.
- [ ] Rehearse each milestone exit checklist against objective test evidence.
- [ ] Run a full release-candidate validation before closing the final
  milestone.

## Exit criteria

- [ ] Every specification has a completed implementation checklist.
- [ ] Every milestone exit criterion has objective evidence.
- [ ] No feature is marked complete without required tests.
- [ ] The release delivers the reference CLI and React superset over the same
  production core.
