# Desktop Application Implementation To-Do

Companion specification: [Desktop Application](desktop-application.md)

## Electron shell

- [x] Scaffold Electron, React, Vite, and strict TypeScript.
- [x] Implement secure BrowserWindow defaults, context isolation, and disabled
  Node integration in the renderer.
- [x] Implement typed preload APIs without a generic IPC escape hatch.
- [x] Connect Electron main to the shared headless application bootstrap.
- [x] Implement single-instance locking and safe deep-link handling.
- [x] Implement startup, shutdown, crash, and reconnect presentation states.
- [x] Apply the Ableton Agent App icon to development windows and the macOS Dock.
- [x] Add a persisted always-on-top window preference with macOS Spaces and
  full-screen visibility.
- [x] Support a 320x360 terminal-sized chat view when workspace sidebars and
  application chrome are hidden.

Electron main now composes `createAgentRuntime` from `packages/runtime`, the
same composition root the CLI uses, and adapts it through
`HeadlessDesktopService`. The bridge port, model, and reasoning effort come
from persisted preferences. The bridge token resolves from the OS-backed
credential vault, `ABLETON_AGENT_TOKEN`, or the configured/auto-detected Remote
Script installation. A discovered installation token is persisted to the vault
and shared with Signal ingress without entering renderer state. Because bridge
credentials and locations are read while the composition is built, changing
the location takes effect on the next launch, which the app states explicitly
when that preference is saved.

Actual startup order differs from the specification's sketch: logging and the
composition are prepared first, then preferences, stored sessions, and saved
Live Set associations load. The shared application starts the Ableton bridge
and reads the current LOM project identity before Desktop selects a production
session. A saved Live Set resumes only its own canonical session; an unmatched
or unsaved set starts with a clean Default agent. The app no longer resumes the
newest global conversation merely because it was updated most recently.
Remote Script location detection, managed installation, and automatic
credential provisioning are implemented. One-click installation and update
controls are still not exposed in the renderer.

The shared application gained only the ports the desktop contract needs:
`cancel`, `createAgentSession`, `resumeAgentSession`, `agentSessionId`, and
`connectAbleton`. Approvals resolve through a typed `ApprovalCoordinator`
rather than a new shared port: the desktop supplies the existing
`requestToolApproval` callback, publishes an `approval.requested` event, and
resolves the pending promise from `approvals:resolve`. Approvals are denied,
never left pending, when no renderer is listening or the app is shutting down.

## Desktop interaction contract

- [x] Add typed definition discovery and refresh APIs.
- [x] Add active-agent create, edit, reset, select, deactivate, history, send,
  and cancel APIs.
- [x] Attribute messages, operations, approvals, and busy state to active-agent
  instances.
- [x] Implement chat send, cancel, create session, and resume session APIs.
- [x] Implement connection, status, capability, snapshot, and diagnostic APIs.
- [x] Keep automatic startup snapshots to bounded core Session state; publish
  device and parameter enrichment only for explicit coalesced refreshes.
- [x] Implement approval resolution APIs.
- [x] Forward shared `AppEvent` values to the renderer with runtime validation.
- [x] Ensure every essential CLI interaction has a desktop equivalent.
- [x] Add visual-only APIs through shared application services, not direct
  bridge calls.
- [x] Add transient Project, Inspector, and combined top-chrome visibility
  controls while keeping the composer aligned with the conversation column.
- [x] Render the prompt composer only in Workspace and let every management or
  diagnostic view consume the full remaining application height.
- [x] Route only selected-agent blocking interactions to Workspace, preserve
  Agents drafts, and focus structured question/approval controls.
- [x] Add typed atomic Session-scope agent-definition saves and refresh Agents
  and Profiles from the same scoped source.
- [x] Preserve optional tool identity in desktop operation view models and
  render compact typed activity rows without removing recovery details.
- [x] Add opt-in isolated desktop automation launch flags, selected-agent
  startup, scoped YOLO startup, and visible external user-turn attribution.
- [x] Host a debug-only authenticated loopback endpoint that sends through the
  running visible desktop service rather than a second headless composition.

Project snapshots are read through the shared application (`inspectSession`,
`inspectDevices`, `inspectDeviceParameters`) and mapped into desktop view
models; the mapping invents no names, colors, or clip positions, and reports
truncated device or parameter pages as diagnostics. `operation:retry` and
`operation:undo` remain unimplemented: both return `false` and explain that the
shared runtime cannot replay or revert an operation. Production plans are
presentation state and say so; they are not applied to Live.

## Configuration and persistence

- [x] Store conversations in versioned App sessions with
  multiple active agents.
- [x] Persist session-level agent overrides and output subscriptions.
- [x] Persist per-active-agent automatic approval with a safe default, atomic
  selected/all updates, session-switch revalidation, and shutdown draining.
- [x] Implement validated preferences and migration support.
- [x] Persist one canonical App-session association per saved `liveSetId` in
  `live-set-sessions.json`, while retaining historical App sessions.
- [x] Adopt Desktop session schema v4 with required Live Set identity and
  optional Live Project grouping, plus an immutable bounded `createdAt` used
  for deterministic per-Set App-session numbering; reject older schemas at
  runtime.
- [x] Resolve Live Set transitions independently inside the same Live Project.
- [x] Drive save-time identity transitions from authoritative bridge events and
  settle App-session ownership before accepting the next agent prompt.
- [x] Keep unsaved and orphan Live Set sessions explicit but ephemeral during
  ordinary operation instead of inferring ownership from names or history.
- [x] Store secrets in OS-backed secure storage.
- [x] Implement development and production logging locations.
- [x] Consolidate application-owned Desktop data under versioned
  `~/.live-agent/profiles/{profile}` storage with isolated development and
  production profiles.
- [x] Add staged legacy migration and per-production-session ownership
  manifests without splitting the shared event journal.
- [ ] Open the local event journal before agent sessions, capture default-on
  sanitized records, and flush bounded batches during graceful shutdown.
- [ ] Add typed journal query/detail, pause, clear, and per-session deletion IPC
  and preload APIs without exposing SQL or filesystem access.
- [ ] Surface journal health, retention truncation, capture-paused, and write
  failure states without blocking core agent or Ableton behavior.

## Scoped automatic approval

- [x] Add strict local `/yolo [on|off] [all]` handling without an SDK send or
  history turn.
- [x] Layer per-agent overrides beneath deny-all and approve-all global policy,
  with targeted pending-request resolution and unattributed-request isolation.
- [x] Add unified built-in/skill textarea completion, YOLO badges, composer
  warning, and layered Settings status.
- [x] Verify automatic approval does not bypass tool allowlists, edit scopes,
  identity validation, mutation locks, or structural mutation denials.
- [x] Add model, reasoning, approval, diagnostics, and project preferences.

## Tests

- [x] Unit-test preload request/response schemas.
- [x] Unit-test Electron lifecycle adapters with mocked services.
- [x] Integration-test main/preload/renderer event delivery.
- [ ] Test journal startup/shutdown, typed query validation, redacted view
  models, deletion controls, and non-blocking degraded behavior.
- [x] Test that unapproved IPC channels and Node primitives are unavailable.
- [x] Test the desktop adapter against the shared application with fake
  services (start, streaming, cancellation, approvals, sessions, snapshot
  refusal, diagnostics, preferences).
- [~] Add Playwright Electron tests for launch, chat, streaming, approval,
  cancellation, resume, connection failure, and shutdown.
  - [x] Cover real Electron launch, preload isolation, application landmarks,
    keyboard shortcuts, and clean shutdown.
  - [ ] Cover live Copilot chat/tool streaming and approval flows in packaged
    builds.
  - [x] Cover isolated automation launch and an externally submitted visible
    user message.

Playwright and packaged Electron launch coverage are configured. The item
remains partial because live Copilot chat/tool streaming and approval workflows
still need complete packaged-build coverage.

## Exit criteria

- [x] Desktop chat matches the CLI reference contract.
- [x] Renderer has no direct Copilot, filesystem, credential, or socket access.
- [x] App exits without orphaning Copilot or bridge processes.
- [x] Default the application-owned Copilot active-work deadline to 600 seconds,
  expose a bounded Desktop setting, and classify any still-running Ableton
  mutation as applied-indeterminate on timeout so the UI requires reinspection
  instead of claiming cancellation.
- [x] Packaged development builds pass Electron smoke tests.

Packaging metadata, packaged-app smoke coverage, and isolated automation launch
support are present. Full packaged live-Copilot workflow coverage remains open
under the Playwright item above.
