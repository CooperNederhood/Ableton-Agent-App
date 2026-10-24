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

Desktop owns App-session identity. Ableton integration owns Live Set and Live
Project identity. When a save event replaces an unsaved or Save As identity,
Desktop serializes only the ownership-changing commit before the next prompt is
accepted, with a maximum wait of two seconds. Periodic identity polling,
startup snapshots, explicit snapshot enrichment, and prepared-context refreshes
never become prompt barriers. A Remote Script `firstSave` observation identifies
the same open Song acquiring its first saved identity. Desktop promotes that
exact App session regardless of conversation or configuration state and without
changing its App-session, active-agent, or Copilot SDK session IDs. A dialog
appears only when the saved target already has a different canonical App
session; prompts remain immediately fail-closed while that decision is pending.

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
  entityContext: {
    list(input: DesktopContextListRequest): Promise<DesktopContextPage>;
    get(input: DesktopContextGetRequest): Promise<DesktopContextDetail>;
  };
}
```

Do not expose generic `invoke(channel, payload)` or Node primitives to the
renderer.

`entity-context:list` and `entity-context:get` are read-only, strictly validated
main-process boundaries scoped to an explicit App session. Preload creates a
WebCrypto trace/correlation/causation tuple for each query and main forwards it
through the shared context host to the application-owned repository. UI reads
are application actors, never fabricated model-agent operations. Main records
queued, started, completed, failed, and supported cancellation query events with
bounded sanitized errors and elapsed timing. The renderer receives no database
path, SQL, prune, arbitrary context-write, or filesystem capability.
Public query input types preserve schema defaults: historical inclusion
defaults to false and list pages default to twenty items; validated results
remain separate output DTOs.

Outputs includes a **Stored listening context** panel with bounded paginated
summaries and detail, an explicit historical-inclusion control, and retryable
errors. Unknown freshness is displayed as unknown rather than certified fresh;
mixed or unresolved attribution is not presented as isolated clip evidence.
Changing App session or profile refresh epoch clears selection and invalidates
pending results; mismatched detail IDs are rejected. Reading stored context
does not depend on the listener remaining connected. A context-file or
composition failure is an actionable error, not a successful empty page.

When canonical profile storage is configured, production Desktop composition
shares one session-context manager between SDK queries/resume inventory and the
main-only context reader. Ownership resolves by the invoking session, not the
selected conversation. First publication registers that exact session and
manifest; ordinary empty reads do not publish metadata. JsonSessionStore
ownership transitions use the manager's close/relocate/reopen transaction.
The same runtime's concrete listening factory supplies SDK discovery, pass and
cancellation ports alongside context queries. Its owner resolver uses the
invoking session ID, never the selected conversation; absent canonical storage
does not construct a listening host. Native capture remains explicitly gated
before controls pending real-device timing evidence. Producer readiness
self-report cannot unlock this gate. Arrangement capture cleanup leaves playback
running; cancelling a pass does not stop Live.
Shutdown first quiesces listening while ingress is available, preserves the
existing ingress-before-application stop order, then closes context handles
after runtime/action drain and before journal closure. A quiescence failure
retains ingress for cleanup; a context-close failure is surfaced rather than
reported as clean shutdown.

Outputs also includes **Listening passes**, scoped to the explicit App-session
and selected agent. `listening:list` is the only listening inventory IPC/preload
method: it accepts bounded identifiers, a limit of at most 100, and an optional
UI trace; it exposes no SQL, paths, controls, raw audio or mutation API. Main
retains at most 100 runtime lifecycle snapshots, evicts only terminal jobs, and
rejects foreign owners, rebound pass IDs and unsupported playback-ownership
claims. These snapshots are ephemeral lifecycle state, not stored observations
or proof of certified native capture. All outbound strings are sanitized and
bounded. `HeadlessDesktopService.reportListeningJob(job)` is the concrete
runtime's `onChange` adapter and emits typed `listening.changed` snapshots;
the coordinator remains the authority for capture lifecycle and original traces.

The panel shows queued, validation, reservation, arming, playback-start, capture,
publication and terminal stages, elapsed duration and actionable failure detail.
It explicitly states that bounded playback is **left running** on completion,
cancellation, failure and timeout; production timing certification is still
unavailable. Session jobs additionally show bounded redacted clip/track
names, scene, requested clip-local first-iteration duration, launch progress and
host mutation state. An observed/verified source epoch is not exclusive audio
attribution or absolute timing accuracy. Unknown follow-action settings remain
unknown, with message-rate continuity limitations in the stored context. An
accepted or queued Session launch may still execute after cancellation, and
other selected Session material may resume. The cancel control
uses the existing `agents:cancel` service path for that agent's active turn and
all its owned captures, including after SDK idle. Its expected App-session ID is
revalidated before cancellation; no arbitrary renderer actor, direct bridge stop
or transport-ownership token is introduced.

Before ordinary approval, Session listening explicitly discloses the clip launch,
transport start, leave-running behavior on all outcomes, possible resumption of
other selected Session sources, and that cancellation cannot retract an accepted
launch. It does not describe those effects merely as a reversible operation.
The metadata-derived approval risk and scoped approval policy are unchanged.
Long target identities and argument previews wrap inside the inspector instead
of clipping horizontally. Main mapping, React approve/deny interactions and the
Electron preload/rendered preview preserve those disclosures and exact decisions.

Visible ordinary-approval MIDI and warped-audio captures qualify this bounded
Session presentation on Live 11.3.43. After both apps fully restart, Outputs and
read-only agent retrieval preserve the original MIDI pass/context IDs, sample
bounds and descriptors without recapture; old Live references remain historical
and freshness/attribution unknown. Application admission and tool guidance remain
limited to Global None from stopped beat zero, not general quantized launch.
Synthetic v1/v2/Session Electron restart tests remain separate evidence.

Inventory and user-cancellation boundaries record ordered queued, started,
progress, completed, failed or supported cancelled events with sanitized payloads,
elapsed timing and UI trace/causation IDs. UI reads are application-attributed,
with the target agent recorded as a subject rather than a fabricated model
actor. The presentation relay preserves coordinator agent/Set attribution and
does not start an independent capture lifecycle. Selection/profile changes,
shutdown and owner removal clear stale views and subscriptions; monotonic
inventory revisions prevent late queries from replacing newer events.
Deterministic component/main/IPC/preload tests and an isolated, explicitly
synthetic Electron event fixture cover these boundaries. Synthetic presentation
is not positive measured-Max evidence. Physical visual acceptance remains gated
on Accessibility/Screen Recording permissions and a runner-owned Live process;
pre-existing user Live instances must not be controlled.

Electron regressions use workspace-owned homes, caches and temporary directories,
an allowlisted child environment with no inherited credentials/SDK or renderer
overrides, and owned rejecting bridge endpoints. Both bridge and signal ports
are written into resolver-owned preferences before launch: Desktop selects its
bridge port from `preferences.abletonPort`, not `ABLETON_AGENT_PORT`. A process
environment port override alone is therefore not sufficient isolation. Explicit
synthetic fixture credentials/endpoints are the only permitted overrides;
restart and automation launches retain the same protection. The secure-contract
test verifies the exact owned preference port and preserves the exact
**No connected Live Set** tree postcondition rather than matching arbitrary
user Set names. Owned servers and profiles are closed/removed by the harness.
Persistent launch-isolation coverage lives in the normal Desktop Vitest suite,
not the excluded Electron test directory:
`pnpm exec vitest run apps/desktop/src/main/desktop-test-environment.test.ts`.
It uses synthetic environments and actual shared-resolver preference writes
for initial/restart and normal/automation profiles, including the reviewed
51234 bridge port versus the unsafe product default 8765.

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
affected objects, and supported retry or undo actions. The compact row names
the operation target when safe identity arguments are available and shows its
terminal duration. Expanding a tool operation shows bounded, credential-redacted
Requested and Result or Observed sections, plus exact Failure and How to correct
it sections when applicable. Structured results are summarized by top-level
fields and collection counts instead of exposing raw unbounded payloads.
Profile-owned Copilot spill paths appear as `<spill-file>`.

The composer distinguishes IPC submission from an accepted agent turn. While
Desktop checks a real ownership-transition barrier, the composer shows an
accessible `Waiting for message acceptance` status and prevents duplicate
submission without presenting the agent as running. The user bubble is added
only after main-process acceptance, using the accepted message ID. If
acceptance fails or the two-second ownership gate expires, the draft remains
available for retry and no Copilot prompt or conversation turn is created.

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
`observability/agent-set-event-history.sqlite`. See
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
Journal writes drain through one worker batch at a time. Public-history queries
wait only for a bounded accepted-write barrier and fail as temporarily
unavailable instead of remaining in a running state indefinitely when durable
publication is stalled. Health includes pending, in-flight, rejected, and
high-water write counts plus the latest drain timing.

Desktop persists schema-v4 App sessions with required `liveSetId` and
`liveSetName`, an immutable bounded ISO `createdAt`, and optional
`liveProjectId` and `liveProjectName`; older session schemas are rejected
rather than migrated at runtime. Creation timestamps are assigned
monotonically so multiple App sessions for one Live Set have a deterministic
creation order, while ordinary updates change only `updatedAt`. Unsaved Live
Sets keep an explicit identity but their App sessions remain ephemeral during
ordinary operation. Orphan sessions use an application-owned identity until
Live connects. The first connected identity must reconcile an existing orphan,
not merely populate the identity cache. An untouched ephemeral session with no
canonical conflict binds to the saved Set through the existing transactional
promotion path, preserving App/agent IDs and rolling back ownership and
associations on persistence failure. Existing offline conversation/configuration
or a canonical association instead requires the normal explicit transition
decision; first connection never silently reassigns that history.
The first ownership-changing commit participates in the same bounded prompt
barrier as later ownership changes. If the open Live Set changes after startup, Desktop blocks
agent actions and Output delivery until the user resumes the associated App
session, forks the current setup for the new Set, or starts fresh. Canonical
association is keyed by `liveSetId`, so switching Sets inside one Live Project
still selects distinct App sessions and previous sessions remain in history.
Background Set observation remains independent from prompt acceptance. A
message waits only while an ownership mutation is actively committing, and
only for two seconds; after the wait Desktop revalidates the active session and
agent before creating the turn. Timeout, transition failure, or shutdown
rejects the message with an actionable retry error.
Profiles still shows the active in-memory session before it is persisted.
The first save of the same open Song promotes and associates the current
session even when it contains meaningful work. If the target already has a
canonical session, the user chooses whether the current or existing session is
canonical; both are retained and the current session remains active. The
canonical title is `App session`; non-canonical titles are deterministically
`App session_2`, `App session_3`, and so on by immutable creation order. Titles
are display metadata only: history and ownership continue to use immutable App
session IDs. Session artifact creation or transfer also promotes an ephemeral
session, while conversation history by itself remains in Copilot SDK storage
and does not create a `sessions.json` record. Sessions associated with saved
Live Sets are persisted immediately. Snapshot/history capture occurs after
ownership settlement and a failure there reports degraded history without
rolling back the successful session promotion.
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
- Listening alignment acceptance: defaults to descriptive mode with a
  64-sample observed clock/beat disagreement limit. Advanced limits are whole
  samples from 0 through 480; strict mode explicitly requires zero with no
  fallback. This policy is persisted in the existing profile-owned
  `config/preferences.json` via `JsonPreferencesStore` and typed preferences
  IPC. A successful save updates only the policy used by future passes;
  each pass freezes its starting policy. A failed persistence operation
  leaves the active policy unchanged. Save feedback belongs to the submitted
  draft revision: editing after a save clears the success message, and edits
  made during persistence remain unsaved when the older request completes.
  The pending save still disables duplicate submission.
- Stored v2 listening detail distinguishes the pass's configured acceptance
  limit from measured clock and beat disagreement, converting each to
  milliseconds at the observation's actual sample rate. All v2 observations
  remain approximate and descriptive-only, even in strict mode at zero
  disagreement. Estimated absolute timing error and verified absolute error
  bound remain unknown; observed disagreement is not physical uncertainty.
  V2 detail also states that constant tempo is assumed and stability is not
  independently verified; tempo automation remains unsupported. Completion is
  not evidence that tempo stayed constant.
  Historical v1 timing uncertainty retains its legacy label and is not
  relabelled as v2 alignment.
- Desktop session context declarations accept one or both unique
  `audio-observation/v1` and `audio-observation/v2` kinds. Existing v1-only
  declarations remain readable; the canonical schema version 2 and
  `context/entity-context.sqlite` path do not change.
  Context publication reconciles supported kinds additively through the
  existing atomic registry/ownership-manifest save. Repeated or stale v1-only
  publication cannot remove an existing v2 declaration, change ownership, or
  rewrite observation content; persistence failure/cancellation leaves the
  in-memory declaration unchanged.
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

Packaged startup qualification must exercise both credential boundaries.
Environment-token startup/authentication checks do not test installed-token
provisioning or native OS encryption. The macOS packaged regression therefore
uses an isolated profile and synthetic Remote Script installation with no
`ABLETON_AGENT_TOKEN`, mock Keychain, or basic password-store override. It must
open the window, persist encrypted bytes, and then restart the same profile and
decrypt through the real OS vault. Typed Desktop History must attribute ordered,
redacted credential lifecycles to discovery and subsequent vault retrieval.
A first-window timeout is a failed qualification, not an automatic skip; the
test retains an exact-owned-process native sample before teardown. OS
authentication remains a developer action. Ad-hoc builds have hash-bound
signing identities, so another build's successful Keychain authorization does
not qualify a newly signed package.

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
