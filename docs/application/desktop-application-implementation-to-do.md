# Desktop Application Implementation To-Do

Companion specification: [Desktop Application](desktop-application.md)

## Electron shell

- [x] Scaffold Electron, React, Vite, and strict TypeScript.
- [x] Implement secure BrowserWindow defaults, context isolation, and disabled
  Node integration in the renderer.
- [x] Implement typed preload APIs without a generic IPC escape hatch.
- [ ] Connect Electron main to the shared headless application bootstrap.
- [x] Implement single-instance locking and safe deep-link handling.
- [x] Implement startup, shutdown, crash, and reconnect presentation states.

The shared `HeadlessApplication` currently has no public cancellation,
create/resume-session, approval-resolution, preferences, or desktop visual
workflow ports. The first desktop client therefore uses a typed
`DesktopService` port with a demo composition. Replacing that composition with
the shared bootstrap is the only shell item blocked on changes outside desktop
ownership.

## Desktop interaction contract

- [x] Implement chat send, cancel, create session, and resume session APIs.
- [x] Implement connection, status, capability, snapshot, and diagnostic APIs.
- [x] Implement approval resolution APIs.
- [x] Forward shared `AppEvent` values to the renderer with runtime validation.
- [x] Ensure every essential CLI interaction has a desktop equivalent.
- [x] Add visual-only APIs through shared application services, not direct
  bridge calls.

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
- [ ] Add Playwright Electron tests for launch, chat, streaming, approval,
  cancellation, resume, connection failure, and shutdown.

Playwright was not already configured. It remains unchecked because a reliable
Electron packaging/launch harness would add substantial setup beyond the
existing Vitest workspace; the same flows are covered at contract, reducer,
component, lifecycle, and security boundaries.

## Exit criteria

- [x] Desktop chat matches the CLI reference contract.
- [x] Renderer has no direct Copilot, filesystem, credential, or socket access.
- [x] App exits without orphaning Copilot or bridge processes.
- [ ] Packaged development builds pass Electron smoke tests.

Packaging metadata and a packaged-app smoke harness are not yet present in the
repository, so only the production Vite/Electron compilation is verified.
