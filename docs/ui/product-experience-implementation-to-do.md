# Product Experience Implementation To-Do

Companion specification: [Product Experience](product-experience.md)

## Reference interaction superset

- [x] Document the shared chat/context/approval/session interaction contract.
- [x] Implement every essential CLI interaction in React.
- [x] Map shared `AppEvent` values to stable UI view models.
- [x] Ensure visual interactions call shared services rather than duplicate
  agent or Ableton logic.

The desktop contract is a narrow preload API with named agent, Ableton,
approval, diagnostic, preference, project-context, plan, and recovery
operations. Inputs and outputs are runtime validated; application events are
normalized before reducer/view-model consumption. The renderer cannot invoke
arbitrary channels. Selection and visual controls become context updates or
typed service calls, and sessions use explicit create/resume operations.

## Core workspace

- [x] Build application shell, connection header, mode switcher, and model
  status.
- [x] Build chat composer with explicit context chips.
- [x] Build streaming assistant and operation timeline.
- [x] Build project outline and selection model.
- [x] Build inspector for tracks, clips, devices, and parameters.
- [x] Build approval and change-preview panel.
- [x] Build diagnostics, sessions, and settings views.

## Production workflows

- [x] Implement Explore, Compose, Arrange, Sound, and Mix layouts.
- [x] Implement editable structured production plan.
- [x] Implement arrangement section/timeline visualization.
- [x] Implement browser and plug-in selection views.
- [x] Implement recovery, retry, and partial-failure UX.
- [x] Add direct controls that produce shared context or service calls.

## Accessibility and performance

- [x] Implement keyboard navigation and focus management.
- [x] Add semantic labels and non-color status indicators.
- [ ] Virtualize large lists and throttle streaming updates.
- [x] Define loading, empty, degraded, and disconnected states.

## Tests

- [x] Unit-test view-model reducers and context-chip behavior.
- [x] Component-test operation, approval, inspector, and plan views.
- [ ] Test accessibility with automated checks and keyboard scenarios.
- [ ] Playwright-test chat parity with CLI, selections, approvals, recovery,
  sessions, and project switches.
- [ ] Performance-test long event histories and browser lists.

Semantic markup, labels, focus shortcuts, Enter-to-send, and reduced-motion
support are implemented, but automated accessibility tooling and full keyboard
scenario automation remain unchecked. Playwright remains blocked on the
packaged Electron launch harness noted in the desktop checklist.
Histories and result sets are bounded and CSS-contained, and the reducer has a
long-history regression test. True viewport virtualization, frame-batched
stream rendering, and browser-list performance instrumentation remain future
work.

## Exit criteria

- [x] React is a demonstrable functional superset of the CLI.
- [x] Essential actions remain available through chat.
- [x] Visual controls never bypass safety or change-set recording.
- [ ] Critical workflows pass desktop end-to-end tests.
