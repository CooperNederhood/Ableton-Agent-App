# System Architecture

## Architectural goals

The architecture must be:

- Safe for Ableton's embedded runtime and UI thread.
- Typed across all application-owned boundaries.
- Testable without launching Ableton for most development.
- Resilient to application or Ableton restarts.
- Compatible with multiple supported Live versions.
- Independent enough that an MCP adapter can be added without changing core
  Ableton behavior.
- Observable without collecting users' musical content by default.

## Runtime topology

### Presentation clients

The headless application core defines a minimum agent interaction contract:
chat, events, context, approvals, cancellation, sessions, status, and
diagnostics.

The CLI/TUI is the reference implementation of that complete contract. The
React renderer is a product superset: it implements the same contract and adds
visual and structured Ableton workflows. Neither presentation owns agent tools,
bridge logic, workflow behavior, or safety policy.

The React renderer does not execute the CLI process or import terminal
rendering code. “Built on top of the CLI” means built on top of the interaction
contract proven by the CLI and the same underlying application services.

### Electron renderer

Owns presentation and local UI state. It includes the complete conversational
experience available through the CLI plus richer project visualization and
interaction. It has no direct access to:

- Copilot credentials or authentication.
- The Copilot SDK client.
- The Ableton socket.
- Arbitrary Node.js APIs.
- Application secrets.

### Electron main process

Owns all privileged application services:

- Copilot SDK client and sessions.
- Tool registration and execution.
- Ableton bridge connection.
- Project-state store.
- Permission and approval policy.
- Application logging.
- Update and installation services.

Long-running or CPU-heavy work may later move into Node worker threads or a
dedicated local service, but the first implementation should avoid unnecessary
processes.

### CLI/TUI process

The terminal client hosts the same application-service composition without
Electron. It can run interactively or execute a one-shot prompt. It is the
first client used to prove the minimum interaction contract end to end and
remains a supported diagnostic and fallback surface.

### Copilot runtime

The Node.js SDK manages or connects to the Copilot CLI runtime over JSON-RPC.
The runtime owns the model/tool loop. The application owns the tools, policy,
and presentation of emitted session events.

### Ableton Remote Script

Runs inside Live and is the only component allowed to access the LOM. It should
contain no model logic, no cloud API clients, and no third-party dependencies.

## Dependency direction

Dependencies point inward toward domain contracts:

```text
React UI (reference contract + visual workflows) ─┐
                                                  ├→ headless application core
CLI/TUI (reference interaction contract) ─────────┘
                                                           │
                                                           ▼
                                      agent tools/workflows → Ableton bridge
                                                → project state

Remote Script transport → command handlers → LOM adapter
```

The agent layer depends on the `AbletonBridge` interface, not on TCP details.
The UI depends on application view models, not raw Copilot events or LOM
objects.

## Proposed repository layout

```text
ableton-agent-app/
├── apps/
│   ├── desktop/
│       ├── src/main/
│       ├── src/preload/
│       └── src/renderer/
│   └── cli/
│       └── src/
├── packages/
│   ├── agent/
│   ├── ableton-bridge/
│   ├── ableton-protocol/
│   ├── ableton-tools/
│   ├── project-state/
│   ├── shared/
│   └── test-support/
├── remote-script/
│   └── AbletonAgent/
│       └── __init__.py
├── tests/
│   ├── contract/
│   ├── integration/
│   └── e2e/
└── docs/
```

Use a `pnpm` workspace and TypeScript project references. The protocol package
should generate or export JSON Schema artifacts consumed by Remote Script
contract tests.

## Main request flow

```text
1. User sends a prompt or invokes a UI action.
2. Application enriches the prompt with selected project context.
3. Copilot runtime chooses one or more custom tools.
4. Tool validates typed arguments.
5. Safety policy approves, rejects, or asks for confirmation.
6. Tool calls a primitive bridge operation or deterministic workflow.
7. Bridge sends a framed request with a request ID.
8. Remote Script schedules the command on Live's main thread.
9. Handler reads or mutates the LOM.
10. Remote Script returns a structured response.
11. Workflow verifies relevant postconditions.
12. Tool returns concise model context plus structured UI metadata.
13. UI renders progress, changes, warnings, and the final response.
```

## Failure boundaries

Failures must be distinguishable:

- Agent/model failure.
- Tool argument validation failure.
- Permission denial.
- Bridge disconnected.
- Protocol incompatibility.
- Command timeout.
- Unsupported Live capability.
- Invalid project reference.
- LOM operation failure.
- Postcondition verification failure.

Each layer adds context but preserves a stable error code. User-facing messages
must not depend on parsing exception strings.

## Concurrency model

- One logical Ableton connection per app instance.
- Multiple in-flight read requests may be supported only after request IDs and
  Remote Script scheduling are proven safe.
- Mutations are serialized by a bridge-side command scheduler.
- Multi-command workflows acquire a mutation lease to prevent interleaving.
- Every LOM operation, including reads, executes through the main-thread
  executor unless verified safe otherwise.
- Cancellation stops queued work where possible but does not claim to undo a
  mutation that already reached Live.

## Extensibility

New features should normally require:

1. A protocol command schema.
2. A Remote Script handler.
3. A bridge method.
4. Tests at each boundary.
5. Optionally, a primitive tool.
6. Optionally, one or more workflow integrations.

The model-facing tool catalog is not required to mirror every protocol command.
Some commands exist only to support deterministic workflows.
