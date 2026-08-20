# Desktop Application

The desktop app is the primary product interface and a functional superset of
the CLI/TUI. It includes the same complete chat and agent-control experience,
then layers on visual project context and structured Ableton workflows.

Its main-process services must not depend on Electron presentation APIs. Shared
application composition and interaction contracts live in packages also used
by the CLI/TUI client. The desktop app builds on those contracts, not on CLI
argument parsing, ANSI rendering, or terminal process execution.

## Technology stack

- Electron
- React
- Vite
- TypeScript with strict mode
- pnpm workspaces
- Zod for runtime validation in TypeScript
- A lightweight, explicit state approach; avoid introducing a broad state
  framework until UI complexity justifies it
- Playwright for Electron end-to-end tests

## Electron process model

### Main process

The main process creates and owns:

- `CopilotService`
- `AgentSessionService`
- `AbletonConnectionService`
- `ProjectStateService`
- `ApprovalService`
- `ChangeSetService`
- `LoggingService`
- `RemoteScriptInstaller`

These services are constructed through an application bootstrap module shared
with the terminal client. Electron-specific lifecycle and IPC remain thin
adapters around that module.

### Preload

The preload script exposes a small typed API:

```ts
interface DesktopApi {
  agent: {
    send(agentInstanceId: string, message: string): Promise<void>;
    cancel(agentInstanceId: string): Promise<void>;
    create(definitionName: string): Promise<string>;
    select(agentInstanceId: string): Promise<void>;
    history(agentInstanceId: string): Promise<AgentMessage[]>;
  };
  ableton: {
    connect(): Promise<void>;
    getStatus(): Promise<ConnectionStatus>;
    requestSnapshot(): Promise<ProjectSnapshot>;
  };
  approvals: {
    resolve(id: string, decision: ApprovalDecision): Promise<void>;
  };
  events: {
    subscribe(handler: (event: AppEvent) => void): Unsubscribe;
  };
}
```

Do not expose generic `invoke(channel, payload)` or Node primitives to the
renderer.

### Renderer

The renderer maintains display state derived from typed application events. It
does not reconstruct business state from assistant prose.

At minimum, the renderer must support every interactive capability exposed by
the CLI:

- Chat input and streaming responses.
- Operation progress.
- Context display.
- Approvals and cancellation.
- Session creation and resume.
- Defined-agent discovery and active-agent lifecycle.
- Connection, capability, snapshot, and diagnostic status.

It then enhances those capabilities with visual selection, arrangement plans,
inspectors, change previews, and direct controls.

## Application event model

Normalize Copilot, bridge, approval, and project-state events into an
application-owned union:

```ts
type AppEvent =
  | AgentMessageDelta
  | AgentMessageComplete
  | AgentReasoningStatus
  | OperationStarted
  | OperationProgress
  | OperationCompleted
  | OperationFailed
  | ApprovalRequested
  | AbletonConnectionChanged
  | ProjectSnapshotChanged;
```

This prevents the UI from becoming tightly coupled to a specific Copilot SDK
event version.

## Lifecycle

Startup order:

1. Initialize logging and configuration.
2. Start the Copilot SDK client.
3. Start the Ableton bridge connection manager.
4. Detect or install the Remote Script.
5. Load recent sessions and user preferences.
6. Open the main window.

Shutdown order:

1. Stop accepting new UI actions.
2. Cancel or finish active agent work according to policy.
3. Flush change-set and session metadata.
4. Disconnect from Ableton.
5. Stop the Copilot SDK client.

## Configuration

Store non-secret preferences separately from credentials. Important settings:

- Model and reasoning level.
- Approval policy: always ask, ask for risky changes, deny changes, or
  immediately approve all tool requests without prompts. Approve-all remains
  subject to tool schema validation and structural safety checks.
- Supported Ableton port override for diagnostics.
- Remote Script location.
- Diagnostic logging level.
- Whether anonymous operational telemetry is enabled.
- Project-specific workflow preferences.

Credentials must use OS-backed secure storage where application-managed secrets
are necessary.

### Scoped automatic approval

The composer handles `/yolo` as a local desktop command. Its grammar is
deliberately strict and case-sensitive:

```text
/yolo
/yolo on
/yolo off
/yolo on all
/yolo off all
```

Only the exact lowercase forms with single spaces and no leading or trailing
whitespace are valid. `/yolo` is equivalent to `/yolo on` for the selected
agent. The `all` forms update every agent currently active in the selected
production session. Malformed forms show the usage
`/yolo [on|off] [all]`. The command is consumed locally through typed IPC: it
does not send an SDK prompt, append a conversation turn, or enter SDK history.

Each active-agent production-session snapshot persists an `autoApprove`
boolean, defaulting to `false` when older version-2 records omit it. The value
survives configuration reset, session switching, application restart, and
normal shutdown; deactivating an agent removes its override. Updates are
serialized with active-agent and session mutations, revalidate the captured
production session before committing, and are drained during shutdown.

The effective policy is layered:

- **Deny all** (`never`) denies every request, including agents with a YOLO
  override.
- **Approve all** (`approve-all`) approves every request globally.
- **Always ask** and **Risky changes** retain their normal base behavior, but
  requests attributed to a YOLO-enabled active agent are approved immediately.
- Unattributed requests and requests from other agents never inherit a
  per-agent override.

Enabling an override also approves already-pending requests attributed to the
target agent only. Global policy changes resolve all pending requests when they
become deny-all or approve-all. Removing an override does not retroactively
resolve requests that are already pending.

Automatic approval bypasses only the human approval prompt. Tool registration,
argument schemas, per-agent allowlists, edit-scope authorization, project and
track identity checks, stale-target detection, mutation locking, and
post-mutation verification still run. Therefore a permitted in-scope mutation
may proceed without a prompt, while an out-of-scope track mutation or a global
mutation requested by a track-scoped agent remains structurally denied.

The textarea uses one completion surface for built-in commands and the selected
agent's available skills. `/y` completes to `/yolo ` with Tab, Enter, arrow-key
selection, or mouse selection. Built-ins reserve their names over colliding
skills, and suggestions are hidden after whitespace or once request text
begins. YOLO badges appear for enabled agents, the composer warns whenever the
effective policy auto-approves, and Settings shows both the global base policy
and the current session's per-agent override count.
