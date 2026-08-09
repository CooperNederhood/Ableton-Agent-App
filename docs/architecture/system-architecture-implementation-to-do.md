# System Architecture Implementation To-Do

Companion specification: [System Architecture](system-architecture.md)

## Foundation

- [ ] Create the `pnpm` workspace and root package scripts.
- [ ] Create `apps/desktop`, `apps/cli`, and the documented package directories.
- [ ] Enable strict TypeScript, project references, shared linting, and
  formatting.
- [ ] Define dependency-boundary rules and enforce them with lint checks.
- [ ] Create a headless application bootstrap independent of Electron and CLI.
- [ ] Define shared interfaces for clock, IDs, logging, configuration, secure
  storage, and event publishing.
- [ ] Add architecture decision records for Electron, TCP framing, SQLite, and
  TypeScript/Python schema ownership.

## Runtime composition

- [ ] Implement dependency injection/composition for application services.
- [ ] Define startup, ready, degraded, and shutdown lifecycle states.
- [ ] Implement graceful shutdown ordering and cancellation propagation.
- [ ] Define mutation serialization and workflow lease interfaces.
- [ ] Define stable error categories across agent, bridge, protocol, and LOM.
- [ ] Add correlation IDs spanning agent calls, workflows, bridge requests, and
  Remote Script logs.

## Tests

- [ ] Unit-test dependency composition and lifecycle state transitions.
- [ ] Unit-test cancellation and shutdown ordering.
- [ ] Add architecture tests that reject forbidden package imports.
- [ ] Add a smoke test booting the headless core with fake dependencies.
- [ ] Add an integration test running CLI and desktop adapters against the same
  fake service implementation.

## Exit criteria

- [ ] Both clients start from the same headless bootstrap.
- [ ] No presentation package owns agent, bridge, workflow, or safety logic.
- [ ] Root validation commands run formatting, lint, typecheck, and tests.
- [ ] Architecture diagrams and repository layout match the implementation.

