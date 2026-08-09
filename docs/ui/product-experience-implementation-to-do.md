# Product Experience Implementation To-Do

Companion specification: [Product Experience](product-experience.md)

## Reference interaction superset

- [ ] Document the shared chat/context/approval/session interaction contract.
- [ ] Implement every essential CLI interaction in React.
- [ ] Map shared `AppEvent` values to stable UI view models.
- [ ] Ensure visual interactions call shared services rather than duplicate
  agent or Ableton logic.

## Core workspace

- [ ] Build application shell, connection header, mode switcher, and model
  status.
- [ ] Build chat composer with explicit context chips.
- [ ] Build streaming assistant and operation timeline.
- [ ] Build project outline and selection model.
- [ ] Build inspector for tracks, clips, devices, and parameters.
- [ ] Build approval and change-preview panel.
- [ ] Build diagnostics, sessions, and settings views.

## Production workflows

- [ ] Implement Explore, Compose, Arrange, Sound, and Mix layouts.
- [ ] Implement editable structured production plan.
- [ ] Implement arrangement section/timeline visualization.
- [ ] Implement browser and plug-in selection views.
- [ ] Implement recovery, retry, and partial-failure UX.
- [ ] Add direct controls that produce shared context or service calls.

## Accessibility and performance

- [ ] Implement keyboard navigation and focus management.
- [ ] Add semantic labels and non-color status indicators.
- [ ] Virtualize large lists and throttle streaming updates.
- [ ] Define loading, empty, degraded, and disconnected states.

## Tests

- [ ] Unit-test view-model reducers and context-chip behavior.
- [ ] Component-test operation, approval, inspector, and plan views.
- [ ] Test accessibility with automated checks and keyboard scenarios.
- [ ] Playwright-test chat parity with CLI, selections, approvals, recovery,
  sessions, and project switches.
- [ ] Performance-test long event histories and browser lists.

## Exit criteria

- [ ] React is a demonstrable functional superset of the CLI.
- [ ] Essential actions remain available through chat.
- [ ] Visual controls never bypass safety or change-set recording.
- [ ] Critical workflows pass desktop end-to-end tests.

