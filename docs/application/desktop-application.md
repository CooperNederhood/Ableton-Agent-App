# Desktop Application

The desktop app is the primary product interface and a functional superset of
the CLI/TUI. It includes the same complete chat and agent-control experience,
then layers on visual project context and structured Ableton workflows.

Its main-process services must not depend on Electron presentation APIs. Shared
application composition and interaction contracts live in packages also used
by the CLI/TUI client. The desktop app builds on those contracts, not on CLI
argument parsing, ANSI rendering, or terminal process execution.

For developer-owned end-to-end UX tests, an explicit `--automation` launch may
start a narrowly scoped authenticated loopback endpoint in Electron main. It
uses the same visible desktop service and selected agent as the renderer; it
does not start another application composition. Ordinary launches expose no
endpoint.

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
- `EventJournalService`
- `RemoteScriptInstaller`

These services are constructed through an application bootstrap module shared
with the terminal client. Electron-specific lifecycle and IPC remain thin
adapters around that module.

The desktop application uses a black-and-gray, interlocking triple-A mark for
Ableton Agent App. The Electron main process applies the shared raster asset to
development windows and the macOS Dock; packaged applications use the
platform-specific assets in `apps/desktop/build`.

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
  history: {
    query(input: HistoryQuery): Promise<HistoryPage>;
    trace(traceId: string): Promise<HistoryTrace>;
    setCaptureEnabled(enabled: boolean): Promise<void>;
    clear(input?: HistoryDeleteScope): Promise<void>;
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

The primary workspace is a collapsible three-column shell: Project,
Conversation, and Inspector. Project and Inspector can be hidden independently,
and the connection header plus application navigation can be hidden together.
All regions return on each application launch. The prompt composer is part of
the Workspace Conversation column and follows its width as sidebars collapse.
It is not rendered in Agents, Skills, Outputs, Events, Browser, Profiles,
Diagnostics, Sessions, or Settings.
Composer-focus shortcuts return the application to Workspace. Newly received
elicitation, plan-approval, and tool-approval requests do so only when they
belong to the selected active agent. Agents remains mounted for its own
selected-agent request so an unsaved definition draft is never discarded by
forced navigation. Structured interaction controls receive focus instead of
the absent ordinary composer.

The Agents tab reads the same effective scoped catalog as Profiles. Its
active-first navigator uses activity lights only for runtime status; active and
inactive rows share the same editable definition surface. Every save publishes
a same-name Session-scope version-2 definition through typed main-process IPC,
then refreshes the effective catalog and Profile Manager snapshot. Active
conversation snapshots are unchanged until explicit Reset.

The Skills tab mirrors that scoped editing model for `SKILL.md` resources. A
narrow skill navigator drives an inspector-style metadata and Markdown editor.
Published name and description fields are read-only; new drafts can set them
until their first Session-scope save. Successful publication refreshes the
Profiles view and Workspace slash-command completion immediately.

After hiding both sidebars and the application toolbar, the desktop window can
be resized to a 320x360 chat-only view. At that size, conversation status is
condensed and timeline/composer spacing tightens while controls for restoring
all hidden regions remain available. Other multi-panel views may require a
larger window.

Settings includes an `Always on top` preference for keeping the desktop window
visible while working in Ableton. The setting applies immediately, persists
across launches, and on macOS keeps the window available across Spaces and over
full-screen windows. It defaults off.

Conversation presentation keeps assistant Markdown unboxed and left aligned,
places literal user text in a right-aligned card, and reduces typed operations
to muted icon-classified rows. Operation disclosures retain status, warnings,
affected objects, and supported retry or undo actions.

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

The application also writes the normalized lifecycle to the local detailed
event journal. Journal records use the same application-owned vocabulary but
are durable, versioned, sanitized, and correlated; transient renderer events
remain optimized for live presentation. Every asynchronous stage propagates a
trace/correlation context and records queued, started, completed, failed, or
cancelled state with relevant timing.

## Lifecycle

Startup order:

1. Initialize logging and configuration.
2. Load preferences and resolve the Remote Script credential from the OS vault,
   an explicit environment override, or the configured/detected installation.
3. Persist a discovered installation token in OS-backed storage and compose the
   Ableton bridge and Signal ingress with the same credential.
4. Load App sessions and saved Live Set associations.
5. Start the Ableton bridge and read the current dynamic Live Set identity.
6. Resume the canonical App session for that saved Live Set, or create
   one clean Default agent for an unmatched or unsaved set.
7. Start or resume only the selected agents' Copilot SDK conversations.
8. Open the main window and read the bounded core project snapshot. Device and
   parameter enrichment is reserved for an explicit refresh so startup does not
   issue a project-wide parameter scan against Live's main thread.

Desktop stores all application-owned local data below
`~/.live-agent/profiles/{profile}/`. Packaged builds use the `default` profile
and development builds use `development`; `LIVE_AGENT_HOME` and
`LIVE_AGENT_PROFILE` provide explicit overrides. The profile contains
preferences, App-session JSON, saved Live Set associations, OS-encrypted
credential blobs, Copilot SDK conversation data, structured logs, and
`observability/event-history.sqlite`. See
[Local Storage Layout](../platform/local-storage.md) for the canonical tree,
ownership boundaries, exceptions, and migration contract.

Each persisted App session also has a bounded ownership manifest beneath its
owning Live Set at `session-state/{app-session-id}/session.json` and a reserved
`artifacts/` directory. Live Project grouping is optional and does not replace
Live Set ownership. Transcripts remain in the Copilot SDK store and detailed
events remain in the shared profile journal rather than being duplicated per
session.

Desktop migrates prior Electron application-data/log locations and the former
`~/.ableton-agent/copilot` fallback before composing application services.
Migration copies into staging, validates known JSON/SQLite data, atomically
publishes the profile, retains legacy sources, and records a version marker.
Migration conflicts or corrupt sources are reported without overwriting either
copy.

Desktop opens the local event journal before agent sessions start, prunes
records older than 30 days, enforces the 250 MiB cap incrementally, and flushes
bounded pending batches during graceful shutdown. A journal failure degrades
History and raises a visible diagnostic; it must not crash or stall the
agent/Live control path. Storage migration lifecycle is replayed into this
journal after it opens and is also mirrored to the structured log.

Desktop persists schema-v4 App sessions with required `liveSetId` and
`liveSetName`, an immutable bounded ISO `createdAt`, and optional
`liveProjectId` and `liveProjectName`; older session schemas are rejected
rather than migrated at runtime. Creation timestamps are assigned
monotonically so multiple App sessions for one Live Set have a deterministic
creation order, while ordinary updates change only `updatedAt`. Unsaved Live
Sets keep an explicit identity but their App sessions remain ephemeral during
ordinary operation. Orphan sessions use an application-owned identity until
Live connects. If the open Live Set changes after startup, Desktop blocks
agent actions and Output delivery until the user resumes the associated App
session, forks the current setup for the new Set, or starts fresh. Canonical
association is keyed by `liveSetId`, so switching Sets inside one Live Project
still selects distinct App sessions and previous sessions remain in history.
Profiles still shows the active in-memory session before it is persisted.
Saving a clean Live Set promotes and associates that same session. Session
artifact creation or transfer also promotes it, while conversation history by
itself remains in Copilot SDK storage and does not create a `sessions.json`
record. Sessions associated with saved Live Sets are persisted immediately.
Forking creates new active-agent and Copilot SDK session IDs, carries the prior
transcript forward as bounded conversation context, and leaves the source Live
Set's stored session unchanged.

Shutdown order:

1. Stop accepting new UI actions.
2. Cancel or finish active agent work according to policy.
3. Flush change-set and session metadata.
4. Disconnect from Ableton.
5. Stop the Copilot SDK client.

In automation mode, endpoint ingress stops and its owned discovery/secret files
are removed before desktop services stop.

## Debug automation mode

Automation mode requires an absolute isolated Electron profile:

```text
--automation
--automation-profile <absolute-path>
[--automation-descriptor <absolute-path>]
[--automation-agent <definition-name>]
[--automation-yolo]
```

`--automation-yolo` requires an agent definition. The app selects the first
active instance of that definition or creates it when absent, then applies the
existing scoped automatic-approval setting inside the isolated profile.

The loopback control protocol accepts only a bounded `send_user_message`
request for the currently selected agent. It publishes a typed
`agent.user_message_submitted` event so the visible conversation renders the
same user text and attribution. The MCP adapter returns after acceptance;
streaming, operations, and final state remain visible through normal desktop
events.

## Configuration

Store non-secret preferences separately from credentials. Important settings:

- Model and reasoning level.
- Approval policy: always ask, ask for risky changes, deny changes, or
  immediately approve all tool requests without prompts. Approve-all remains
  subject to tool schema validation and structural safety checks.
- Supported Ableton port override for diagnostics.
- Remote Script location.
- Diagnostic logging level.
- Whether the application window stays above other applications.
- Whether anonymous operational telemetry is enabled.
- Local detailed-history capture (default on), retention status, clear, and
  per-session deletion controls.
- Local storage root/profile diagnostics. Root and profile overrides are
  process-level configuration and are not renderer-writable preferences.
- Project-specific workflow preferences.

Credentials must use OS-backed secure storage where application-managed secrets
are necessary. Desktop resolves the bridge token in this order: an existing
vault entry, `ABLETON_AGENT_TOKEN`, then the exact
`AbletonAgent/.ableton-agent-token` file under the selected or auto-detected
Remote Scripts directory. A discovered token is copied into the vault without
being exposed to renderer state or IPC. Multiple discovered installations with
different tokens are an explicit configuration error rather than an
auto-selection.

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
