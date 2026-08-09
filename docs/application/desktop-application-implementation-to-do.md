# Desktop Application Implementation To-Do

Companion specification: [Desktop Application](desktop-application.md)

## Electron shell

- [ ] Scaffold Electron, React, Vite, and strict TypeScript.
- [ ] Implement secure BrowserWindow defaults, context isolation, and disabled
  Node integration in the renderer.
- [ ] Implement typed preload APIs without a generic IPC escape hatch.
- [ ] Connect Electron main to the shared headless application bootstrap.
- [ ] Implement single-instance locking and safe deep-link handling.
- [ ] Implement startup, shutdown, crash, and reconnect presentation states.

## Desktop interaction contract

- [ ] Implement chat send, cancel, create session, and resume session APIs.
- [ ] Implement connection, status, capability, snapshot, and diagnostic APIs.
- [ ] Implement approval resolution APIs.
- [ ] Forward shared `AppEvent` values to the renderer with runtime validation.
- [ ] Ensure every essential CLI interaction has a desktop equivalent.
- [ ] Add visual-only APIs through shared application services, not direct
  bridge calls.

## Configuration and persistence

- [ ] Implement validated preferences and migration support.
- [ ] Store secrets in OS-backed secure storage.
- [ ] Implement development and production logging locations.
- [ ] Add model, reasoning, approval, diagnostics, and project preferences.

## Tests

- [ ] Unit-test preload request/response schemas.
- [ ] Unit-test Electron lifecycle adapters with mocked services.
- [ ] Integration-test main/preload/renderer event delivery.
- [ ] Test that unapproved IPC channels and Node primitives are unavailable.
- [ ] Add Playwright Electron tests for launch, chat, streaming, approval,
  cancellation, resume, connection failure, and shutdown.

## Exit criteria

- [ ] Desktop chat matches the CLI reference contract.
- [ ] Renderer has no direct Copilot, filesystem, credential, or socket access.
- [ ] App exits without orphaning Copilot or bridge processes.
- [ ] Packaged development builds pass Electron smoke tests.

