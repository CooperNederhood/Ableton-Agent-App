# Implementation Workplan

## Planning model

Use a hybrid plan:

- This document is the master sequence, dependency map, and release checklist.
- Each component specification has a colocated `*-implementation-to-do.md`
  containing its concrete engineering checklist.

A single large checklist would make component ownership and review difficult.
Only separate plans, however, would hide cross-component dependencies. The
hybrid structure provides both local detail and a coherent build order.

## Status conventions

- `[ ]` Not started.
- `[~]` In progress.
- `[x]` Complete and verified.
- `[!]` Blocked; add the blocker immediately below the item.

An item is complete only when its implementation, tests, documentation, and
relevant validation pass.

## Component plans

| Area | Specification | Implementation plan |
|---|---|---|
| Architecture | [System architecture](architecture/system-architecture.md) | [To-do](architecture/system-architecture-implementation-to-do.md) |
| Application | [Desktop application](application/desktop-application.md) | [To-do](application/desktop-application-implementation-to-do.md) |
| CLI | [Terminal client](cli/terminal-client.md) | [To-do](cli/terminal-client-implementation-to-do.md) |
| Agent | [Agent runtime](agent/agent-runtime.md) | [To-do](agent/agent-runtime-implementation-to-do.md) |
| Bridge | [Ableton bridge](bridge/ableton-bridge.md) | [To-do](bridge/ableton-bridge-implementation-to-do.md) |
| Remote Script | [Remote Script](remote-script/remote-script.md) | [To-do](remote-script/remote-script-implementation-to-do.md) |
| Protocol | [IPC protocol](protocol/ipc-protocol.md) | [To-do](protocol/ipc-protocol-implementation-to-do.md) |
| Tools | [Tool design](tools/tool-design.md) | [To-do](tools/tool-design-implementation-to-do.md) |
| UI | [Product experience](ui/product-experience.md) | [To-do](ui/product-experience-implementation-to-do.md) |
| State | [Project state](state/project-state.md) | [To-do](state/project-state-implementation-to-do.md) |
| Safety | [Safety and recovery](safety/safety-and-recovery.md) | [To-do](safety/safety-and-recovery-implementation-to-do.md) |
| Testing | [Test strategy](testing/test-strategy.md) | [To-do](testing/test-strategy-implementation-to-do.md) |
| Platform | [Packaging and operations](platform/packaging-and-operations.md) | [To-do](platform/packaging-and-operations-implementation-to-do.md) |
| Delivery | [Roadmap](delivery/roadmap.md) | [To-do](delivery/roadmap-implementation-to-do.md) |

## Dependency sequence

### Stage 1: repository and contracts

- [~] Complete architecture foundation tasks.
- [~] Establish monorepo tooling, CI, shared TypeScript configuration, and
  package boundaries.
- [~] Define protocol schemas, fixtures, error taxonomy, and versioning.
- [x] Establish the test harness before implementing feature breadth.

### Stage 2: Ableton connectivity

- [x] Implement the minimal Remote Script lifecycle and main-thread executor.
- [x] Implement framed authenticated transport.
- [x] Implement the TypeScript bridge connection manager.
- [ ] Pass simulator, fragmentation, timeout, reconnect, and contract tests.
- [ ] Validate `system.hello`, capabilities, ping, and session inspection in
  real Ableton.

### Stage 3: headless agent core and reference CLI

- [x] Implement application services and the shared event contract.
- [x] Integrate the Copilot SDK with a restricted tool environment.
- [x] Implement the first inspection tools.
- [~] Build the CLI chat loop, status commands, streaming, and approvals.
- [ ] Demonstrate an end-to-end prompt reading and safely modifying Live.

### Stage 4: core production features

- [~] Implement tracks, transport, session clips, notes, and arrangement
  primitives.
- [ ] Add project snapshots, revisions, stable references, and change sets.
- [ ] Add verification and recovery behavior.
- [~] Add device, rack, browser, and plug-in features.
  - [x] Add bounded top-level device/parameter inspection and verified
    enable/disable plus normalized parameter mutation for regular tracks.
  - [ ] Add return/group/rack-chain traversal, Drum Rack, browser, and loading.
- [ ] Complete unit, contract, simulator, and real-Live tests for each command.

### Stage 5: React product superset

- [ ] Implement the complete reference chat interaction contract in React.
- [ ] Add project outline, inspectors, context selection, modes, plans, and
  change previews.
- [ ] Ensure React actions resolve through shared services and tools.
- [ ] Complete Electron end-to-end coverage.

### Stage 6: workflows and release

- [ ] Implement deterministic compose, arrange, sound, and mix workflows.
- [ ] Complete installation, Remote Script updates, diagnostics, logging, and
  privacy controls.
- [ ] Validate supported OS and Ableton matrices.
- [ ] Produce signed builds and complete release gates.

## Cross-cutting definition of done

For every feature:

- [ ] Public schemas and types are defined.
- [ ] Inputs are runtime validated.
- [ ] Errors use stable codes.
- [ ] Unit tests cover success, validation, and failure paths.
- [ ] Integration tests cover the next process boundary.
- [ ] A real-Live validation exists for uncertain LOM behavior.
- [ ] Safety classification and approval behavior are defined.
- [ ] Postconditions are verified after mutation.
- [ ] CLI output represents progress, success, and failure.
- [ ] React can represent the same essential interaction.
- [ ] User and developer documentation is updated.
