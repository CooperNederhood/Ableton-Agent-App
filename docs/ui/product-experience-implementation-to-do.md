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

- [x] Replace the obsolete workflow switcher with Active Agent selection.
- [x] Add an Agents tab with definition discovery, diagnostics, active-first
  navigation, and semantic icon-based detail views.
- [x] Add active-agent creation, editing, reset, deactivate, and modified state.
- [x] Unify active/inactive definition editing and publish every save as a
  Session-scope override visible in Profiles.
- [x] Add an Agents-aligned Skills tab with Session-scope create/edit,
  immutable published metadata, Profiles synchronization, and immediate
  Workspace slash-command discovery.
- [x] Show active in-memory sessions in Profiles, promote them on first scoped
  mutation, and allow artifact transfer into inactive persisted sessions.
- [x] Build application shell, connection header, and active-agent selector
  without redundant SDK/model-default status.
- [x] Add transient independent Project/Inspector sidebars and combined
  top-chrome controls, with the composer aligned to the expanding conversation
  column.
- [x] Add session-only pointer dragging with a bounded Project width and a
  workspace-derived Inspector maximum, preserving the conversation minimum and
  hide/reopen width.
- [x] Remove redundant workspace heading rows, move project Refresh beside the
  context switch, and retain subtle edge controls for sidebar visibility.
- [x] Build a compact chat composer with explicit context chips, a text mode
  control, and circular semantic send/stop actions.
- [x] Keep the chat composer exclusive to Workspace so management and
  diagnostic tabs use their full content height.
- [x] Add per-active-agent plan mode with `/plan`, Shift+Tab toggling, composer
  mode status, and mode-attributed sends.
- [x] Propagate and attribute the selected mode for automation-originated
  messages.
- [x] Send bounded, deduplicated context chips atomically with managed-agent
  messages and explicit skill invocations.
- [x] Build streaming assistant and operation timeline.
- [x] Add an attributed per-turn Working disclosure for streaming intent,
  bounded reasoning summaries, liveness, and terminal state; keep it expanded
  while running, collapse it afterward, and allow manual reopening.
- [x] Present borderless assistant turns, right-aligned user cards, and compact
  typed operation rows with expandable recovery details.
- [x] Build project outline and selection model.
- [x] Build inspector for tracks, clips, devices, and parameters.
- [x] Build approval and change-preview panel.
- [x] Present `plan.md` as a read-only Inspector preview while structured
  questions, approval, change feedback, exit-only controls, and manual Markdown
  editing replace the composer in place.
- [x] Keep the canonical Inspector plan as the sole visible plan body during
  review instead of duplicating the SDK summary in the composer.
- [x] Present single-choice questions as visible radios with an explicit,
  bounded custom-answer field for agent `ask_user` requests and a vertically
  growing, manually resizable question deck.
- [x] Replace the fixed Inspector stack with transient Selection, Plan, and
  Approval tabs that support close/re-add, reordering, vertical drag splits,
  uniform initial pane heights, manual divider resizing, and independent
  scrolling.
- [x] Enforce read-only plan execution and cover the SDK request through
  Inspector rendering and resolution with regression tests.
- [x] Prevent duplicate plan responses, retain stale failures for retry, and
  render only normalized actions offered by the pending request.
- [x] Preserve ordinary message drafts during composer takeover and enforce
  elicitation, approval, manual editor, then ordinary-composer priority.
- [x] Route selected-agent blocking interactions to Workspace, preserve Agents
  drafts, and focus the structured interaction control.
- [x] Render model-authored GFM while applying narrow presentation-only cleanup
  to recognized compact labeled plans, preserving raw plan state, History, and
  approval IPC.
- [x] Build diagnostics, sessions, and settings views.
- [x] Expose the validated 10-minute default agent active-work timeout in
  Settings and apply changes to subsequent turns without restarting.
- [x] Expose global Off/Concise/Detailed reasoning visibility in Settings and
  apply it before the next turn without replacing SDK conversation history.
- [ ] Build the queryable History surface with filters, cursor pagination,
  virtualized results, redacted trace details, and explicit paused, retained,
  incomplete, and unavailable states.

## Production workflows

- [x] Remove hard-coded workflow layouts in favor of definition-driven agents.
- [x] Partition transcript, operations, approvals, and cancellation by active
  agent.
- [x] Add per-active-agent Output subscription controls and slash-skill
  discovery.
- [x] Implement editable structured production plan.
- [x] Implement arrangement section/timeline visualization.
- [x] Implement browser and plug-in selection views.
- [x] Implement recovery, retry, and partial-failure UX.
- [x] Add direct controls that produce shared context or service calls.

## Accessibility and performance

- [x] Implement keyboard navigation and focus management.
- [x] Add semantic labels and non-color status indicators.
- [x] Label plan-mode user turns textually in addition to distinct color.
- [x] Render explicit gray interactive user cards and blue plan user cards,
  defaulting legacy mode-less history to interactive.
- [x] Add accessible expanded-state labels and controls for all collapsible
  workspace regions.
- [x] Virtualize large lists and throttle streaming updates.
- [x] Define loading, empty, degraded, and disconnected states.

## Tests

- [x] Unit-test view-model reducers and context-chip behavior.
- [x] Test selection-context enablement, deduplication, per-turn replacement,
  and managed message/skill delivery.
- [x] Component-test operation, approval, inspector, and plan views.
- [x] Component-test structured elicitation, composer priority/draft
  preservation, and revision-checked manual plan editing.
- [x] Component-test radio/custom answers, question-panel resizing, compact
  composer actions, and modular Inspector state transitions.
- [x] Component-test `/plan`, per-agent mode changes, plan-mode sends, and
  textual plan-message attribution.
- [~] Test accessibility with automated checks and keyboard scenarios.
  - [x] Verify landmarks, labels, focus shortcuts, and sandboxed preload in
    Electron.
  - [ ] Complete a WCAG audit with a dedicated accessibility engine.
- [~] Playwright-test chat parity with CLI, selections, approvals, recovery,
  sessions, and project switches.
  - [x] Cover launch and navigation in the real Electron shell.
  - [x] Cover main-process plan event delivery, automatic Inspector opening,
    and typed response IPC in the real Electron shell.
  - [x] Cover compact one-line plan formatting in the Inspector while retaining
    the original event and response payload.
  - [x] Cover Project and Inspector drag geometry and hide/reopen width
    restoration in the real Electron shell, including Inspector expansion
    beyond the former fixed maximum.
  - [x] Cover visible radio/custom question controls and Inspector tab splitting,
    independent scrolling, and divider resizing.
  - [ ] Cover all shared runtime workflows with deterministic injected fakes.
- [x] Performance-test long event histories and browser lists.
- [ ] Performance-test History queries/details at the 250 MiB cap, stale-query
  cancellation, sustained ingestion, and concurrent SDK streaming.

Semantic markup, labels, focus shortcuts, Enter-to-send, and reduced-motion
support are implemented, but automated accessibility tooling and full keyboard
scenario automation remain unchecked. Playwright has a packaged Electron
launch harness; complete live Copilot workflow coverage remains open.
Histories and result sets are bounded and CSS-contained, and the reducer has a
long-history regression test. True viewport virtualization, frame-batched
stream rendering, and browser-list performance instrumentation remain future
work.

## Exit criteria

- [x] React is a demonstrable functional superset of the CLI.
- [x] Essential actions remain available through chat.
- [x] Visual controls never bypass safety or change-set recording.
- [~] Critical workflows pass desktop end-to-end tests.
