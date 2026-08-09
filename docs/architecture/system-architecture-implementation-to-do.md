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
- [ ] Add a smoke test booting the headless core with fake dependencies.
- [ ] Add an integration test running CLI and desktop adapters against the same
  fake service implementation.

## Exit criteria

- [ ] Both clients start from the same headless bootstrap.
- [ ] No presentation package owns agent, bridge, workflow, or safety logic.
- [x] Root validation commands run formatting, lint, typecheck, and tests.
- [ ] Architecture diagrams and repository layout match the implementation.
