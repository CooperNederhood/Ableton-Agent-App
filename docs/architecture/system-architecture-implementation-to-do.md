# System Architecture Implementation To-Do

Companion specification: [System Architecture](system-architecture.md)

## Foundation

- [x] Create the `pnpm` workspace and root package scripts.
- [x] Create `apps/desktop`, `apps/cli`, and the implemented package
  directories.
- [x] Enable strict TypeScript, project references, shared linting, and
  formatting.
- [x] Define dependency-boundary rules and enforce them with lint checks.
- [x] Create a headless application bootstrap independent of Electron and CLI.
- [x] Define shared interfaces for clock, IDs, logging, configuration, secure
  storage, and event publishing.
- [x] Add architecture decision records for Electron, TCP framing, SQLite, and
  TypeScript/Python schema ownership.

## Runtime composition

- [x] Implement dependency injection/composition for application services.
- [x] Define startup, ready, degraded, and shutdown lifecycle states.
- [x] Implement graceful shutdown ordering and cancellation propagation.
- [x] Define mutation serialization and workflow lease interfaces.
- [ ] Define stable error categories across agent, bridge, protocol, and LOM.
- [ ] Add correlation IDs spanning agent calls, workflows, bridge requests, and
  Remote Script logs.

## Tests

- [x] Unit-test dependency composition and lifecycle state transitions.
- [x] Unit-test cancellation and shutdown ordering.
- [x] Add architecture lint checks that reject forbidden package imports.
- [x] Add a smoke test booting the headless core with fake dependencies.
- [x] Add an integration test running CLI and desktop adapters against the same
  fake service implementation.

The fakes live in `packages/test-support`; `createFakeApplication` boots the
real `HeadlessApplication` on them. `apps/cli/src/cli.test.ts` and
`apps/desktop/src/main/headless-desktop-service.test.ts` drive their own
adapter against that one implementation, so both suites assert the same
underlying behavior. They remain two suites rather than one shared harness,
because a package cannot import either app without inverting the dependency
direction.

## Exit criteria

- [x] Both clients start from the same headless bootstrap.
- [x] No presentation package owns agent, bridge, workflow, or safety logic.
- [x] Root validation commands run formatting, lint, typecheck, and tests.
- [~] Architecture diagrams and repository layout match the implementation.

The CLI and Electron main both compose through `createAgentRuntime` in
`packages/runtime`; neither constructs a bridge, Copilot client, or tool set.
Electron main owns only the `DesktopService` adapter that maps shared events,
status, and snapshots into desktop view models. The repository layout in the
specification now matches the workspace, except that contract, integration, and
end-to-end suites still live beside the code they cover instead of under a
top-level `tests/` directory.
