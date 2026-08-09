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

Electron main now composes `createAgentRuntime` from `packages/runtime`, the
same composition root the CLI uses, and adapts it through
`HeadlessDesktopService`. The bridge port, model, and reasoning effort come
from persisted preferences; the bridge token comes from the OS-backed
credential vault or `ABLETON_AGENT_TOKEN`. Because both are read while the
composition is built, changing them takes effect on the next launch, which the
app states explicitly when those preferences are saved.

Actual startup order differs from the specification's sketch: logging and the
composition are prepared first, then preferences and stored sessions load, then
the shared application starts the Ableton bridge before the Copilot session,
then the newest stored conversation is resumed, and finally a project snapshot
is read only when Live is connected. Remote Script detection and installation
are still not implemented.

The shared application gained only the ports the desktop contract needs:
`cancel`, `createAgentSession`, `resumeAgentSession`, `agentSessionId`, and
`connectAbleton`. Approvals resolve through a typed `ApprovalCoordinator`
rather than a new shared port: the desktop supplies the existing
`requestToolApproval` callback, publishes an `approval.requested` event, and
resolves the pending promise from `approvals:resolve`. Approvals are denied,
never left pending, when no renderer is listening or the app is shutting down.

## Desktop interaction contract

- [x] Implement chat send, cancel, create session, and resume session APIs.
- [x] Implement connection, status, capability, snapshot, and diagnostic APIs.
- [x] Implement approval resolution APIs.
- [x] Forward shared `AppEvent` values to the renderer with runtime validation.
- [x] Ensure every essential CLI interaction has a desktop equivalent.
- [x] Add visual-only APIs through shared application services, not direct
  bridge calls.

Project snapshots are read through the shared application (`inspectSession`,
`inspectDevices`, `inspectDeviceParameters`) and mapped into desktop view
models; the mapping invents no names, colors, or clip positions, and reports
truncated device or parameter pages as diagnostics. `operation:retry` and
`operation:undo` remain unimplemented: both return `false` and explain that the
shared runtime cannot replay or revert an operation. Production plans are
presentation state and say so; they are not applied to Live.

## Configuration and persistence

- [x] Implement validated preferences and migration support.
- [x] Store secrets in OS-backed secure storage.
- [x] Implement development and production logging locations.
- [x] Add model, reasoning, approval, diagnostics, and project preferences.

## Tests

- [x] Unit-test preload request/response schemas.
- [x] Unit-test Electron lifecycle adapters with mocked services.
- [x] Integration-test main/preload/renderer event delivery.
- [x] Test that unapproved IPC channels and Node primitives are unavailable.
- [x] Test the desktop adapter against the shared application with fake
  services (start, streaming, cancellation, approvals, sessions, snapshot
  refusal, diagnostics, preferences).
- [ ] Add Playwright Electron tests for launch, chat, streaming, approval,
  cancellation, resume, connection failure, and shutdown.

Playwright was not already configured. It remains unchecked because a reliable
Electron packaging/launch harness would add substantial setup beyond the
existing Vitest workspace; the same flows are covered at contract, reducer,
component, lifecycle, adapter, and security boundaries. The adapter tests run
the real `HeadlessApplication` on the fakes in `packages/test-support`, so
Electron itself is the only untested layer of those flows.

## Exit criteria

- [x] Desktop chat matches the CLI reference contract.
- [x] Renderer has no direct Copilot, filesystem, credential, or socket access.
- [x] App exits without orphaning Copilot or bridge processes.
- [ ] Packaged development builds pass Electron smoke tests.

Packaging metadata and a packaged-app smoke harness are not yet present in the
repository, so only the production Vite/Electron compilation is verified. The
compiled `dist/main/composition.js` was additionally booted in plain Node to
confirm the shared composition resolves, starts a Copilot session, reports the
unconfigured bridge honestly, and refuses to produce a snapshot while
disconnected.
