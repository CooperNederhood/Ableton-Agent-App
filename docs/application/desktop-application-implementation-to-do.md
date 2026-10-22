# Desktop Application Implementation To-Do

Companion specification: [Desktop Application](desktop-application.md)

## Electron shell

- [x] Add a real packaged OS-vault regression without an environment-token or
  mock-Keychain bypass: require installed-token provisioning, encrypted
  persistence, same-profile restart/decrypt and typed credential lifecycle.
  Capture a bounded native sample on first-window failure.
- [x] Cover adapter encryption unavailability, encryption/decryption denial,
  encrypted-byte preservation, missing credentials and invalid-key guards.
- [x] Include packaged Electron tests in strict TypeScript project checking,
  rather than ESLint's default inferred project.
- [ ] Resolve intermittent native-vault startup. The first real regression run
  timed out before the first window; a later run passed provision/restart/decrypt
  with the unchanged package. No production fix explains that transition.
  Do not count the later pass as proof of a repaired startup or package listening.

- [x] Reconcile first connection after disconnected startup: adopt an untouched
  orphan transactionally; require a decision for offline history or an existing
  canonical session. Reuse ownership barriers and promotion rollback.
- [x] Reproduce the orphan-binding defect before the fix; cover clean binding,
  offline-conversation denial, canonical resume and session/association write
  failures with explicit recovery.
- [x] Verify first connection, visible ownership and restart restoration through
  production Electron main/preload with an isolated protocol simulator.
  The regression failed against the pre-fix build with the original orphan
  identity, then passed with transactional binding. The full Electron suite
  passed; this is not real-audio or packaged listening acceptance.

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
- [x] Present workflow-job lifecycle events through the existing sanitized
  diagnostics and typed Desktop History surfaces.

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
- [x] Keep periodic identity polling and snapshot enrichment off the prompt
  critical path; gate sends only on active ownership commits for at most two
  seconds.
- [x] Present a distinct accessible composer submission state, add the user
  message only after IPC acceptance, and preserve failed drafts for retry.
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
- [x] Preserve bounded, redacted tool request/result context across terminal
  updates and render meaningful Requested, Result/Observed, Failure, recovery,
  policy attribution, and duration disclosures.
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

- [x] Define strictly typed read-only context list/detail IPC and preload APIs
  with explicit App-session scope and application-attributed query traces.
- [x] Add bounded Outputs context summaries/detail, historical inclusion,
  unknown-freshness labels, retry, and session/profile race protection.
- [x] Record ordered query lifecycle, timing, sanitized failure, and supported
  cancellation events without impersonating an agent.
- [x] Include the context restart fixture and primary Electron suite in strict
  test-project typechecking through the normal quality gate.
- [x] Wire canonical session repositories and publication references into
  production Desktop composition and pass the Electron restart regression.
- [x] Compose the concrete listening factory with the existing runtime and
  context ports, reject missing invoking owners/unavailable ingress explicitly,
  and preserve ordered listening shutdown and the native commissioning gate.
- [ ] Validate stored listening context and listening lifecycle presentation
  visually in a fresh isolated Desktop/runner-owned Live session.
- [x] Present bounded, sanitized listening job DTOs through read-only inventory
  IPC/preload and typed main-process lifecycle change/reset events.
- [x] Present owned listening progress/cancellation after SDK idle through the
  existing agent cancellation path, with expected-session guards and explicit
  leave-playback-running policy and actionable failures.
- [x] Cover selected-agent/session/profile races, stale inventory, bounded
  ownership, redaction, traced UI reads and cleanup in deterministic tests.
- [x] Verify isolated synthetic Electron listening lifecycle regression.
- [x] Isolate every primary Electron launch/restart from inherited credentials,
  home directories, SDK/renderer overrides and production bridge/signal ports;
  verify preference-selected endpoints without weakening UI postconditions.
- [ ] Complete physical listening lifecycle acceptance after permission and
  runner-owned Live/native timing prerequisites are satisfied.

- [x] Store conversations in versioned App sessions with
  multiple active agents.
- [x] Persist session-level agent overrides and output subscriptions.
- [x] Persist per-active-agent automatic approval with a safe default, atomic
  selected/all updates, session-switch revalidation, and shutdown draining.
- [x] Implement validated preferences and migration support.
- [x] Default older preferences to descriptive listening with a 64-sample
  observed clock/beat disagreement acceptance limit; validate whole-sample
  0–480 advanced limits and strict zero/no-fallback consistency through the
  existing profile preferences store and typed IPC.
- [x] Apply successfully persisted listening policy changes only to future
  passes through an application-owned immutable policy provider.
- [x] Add Settings controls and truthful v2 quality detail at actual sample
  rates, unknown absolute error/bound, and separate historical v1 labelling.
- [x] Show constant-tempo assumption/not independently verified and unsupported
  automation for v2 context, including historical producers with no warning.
- [x] Bind Settings save feedback to the submitted draft revision; retain edits
  made during persistence without falsely labelling them saved. Component
  regressions reproduce both stale-success cases before the fix.
- [x] Verify listening preferences and mixed v1/v2 typed historical context
  through isolated Electron IPC/profile restarts (11-test owning suite).
  One earlier intermittent 128-to-64 Settings result remains unexplained;
  17 targeted repetitions and subsequent complete-suite runs did not reproduce
  it. Do not treat revision-feedback hardening as its established root cause.
- [x] Accept unique nonempty v1/v2 context-kind declarations at the Desktop
  session boundary while preserving v1-only references and the existing
  schema-version-2 context database path.
- [x] Reconcile supported kinds additively through the existing atomic
  registry/ownership-manifest publisher, retaining declarations on stale
  requests and leaving observation bytes/ownership unchanged.
- [ ] Qualify descriptive listening Settings and quality display in the
  integrated runner-owned Live/Desktop UX loop after deterministic integration
  validation (synthetic component/IPC tests alone do not qualify real UX).
- [x] Persist one canonical App-session association per saved `liveSetId` in
  `live-set-sessions.json`, while retaining historical App sessions.
- [x] Adopt Desktop session schema v4 with required Live Set identity and
  optional Live Project grouping, plus an immutable bounded `createdAt` used
  for deterministic per-Set App-session numbering; reject older schemas at
  runtime.
- [x] Resolve Live Set transitions independently inside the same Live Project.
- [x] Drive save-time identity transitions from authoritative bridge events and
  settle App-session ownership before accepting the next agent prompt.
- [x] Record bounded queued, started, completed, failed, timed-out, and
  cancelled ownership-gate events with timing and trace relationships.
- [x] Promote meaningful unsaved App sessions in place on authoritative first
  save, preserving App-session, active-agent, and SDK-session IDs.
- [x] Resolve first-save canonical conflicts without deleting either session;
  keep current work active and normalize titles to `App session`, `_2`, `_3`,
  and so on while retaining immutable ID-based history joins.
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
- [x] Serialize journal batch publication and bound public-history read barriers
  so a stalled writer cannot leave `set_sql_search` running indefinitely.

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
- [x] Regress slow snapshot enrichment, bounded ownership waits and timeouts,
  pending transition decisions, lifecycle telemetry, accepted-message IDs, and
  renderer draft recovery.
- [~] Add Playwright Electron tests for launch, chat, streaming, approval,
  cancellation, resume, connection failure, and shutdown.
  - [x] Cover real Electron launch, preload isolation, application landmarks,
    keyboard shortcuts, and clean shutdown.
  - [x] Cover packaged Copilot authentication-required recovery and an
    authenticated installed-app model-discovery smoke.
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
