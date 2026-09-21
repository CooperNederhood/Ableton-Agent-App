# Agent Runtime

## Role

The agent translates musical intent into safe, observable, verifiable
operations. It is not the source of truth for the Live set and does not execute
arbitrary code inside Ableton.

## Copilot SDK configuration

The default session should:

- Use the Node.js Copilot SDK.
- Enable streaming.
- Register approved application tools plus the SDK's session-isolated built-ins.
- Exclude host-capable coding, shell, unrestricted filesystem, and network
  tools.
- Provide a custom permission handler.
- Register lifecycle and tool hooks.
- Use a stable application-owned session ID.
- Enable session persistence for project continuity.

The app should prefer an empty or tightly restricted tool environment rather
than inheriting the general Copilot CLI tool set.

At SDK session creation, resume, and each effective configuration change, the
runtime writes a sanitized configuration snapshot to the local event journal.
It includes the agent-definition revision, model/reasoning settings, tool and
skill allowlists, edit scopes, approval policy, and Live Event/Output delivery
settings. Secrets and raw prompt/configuration content are excluded; revisions
and safe hashes preserve attribution. Bounded non-secret definitions and
configuration details remain available for local history.

The complete SDK lifecycle is journaled without sampling: session and turn
start/end, streaming lifecycle, message metadata, usage, idle, cancellation,
errors, hooks, tool requests, and tool results. “Complete” refers to lifecycle
coverage and bounded local content: prompts, assistant text, arguments and
results, paths, structured musical/MIDI data, and event payloads are preserved.
Sanitization redacts credentials embedded in every string and replaces
binary/audio bodies with visible omission markers before persistence.

Every SDK session explicitly enables streaming. Incremental assistant text is
normalized from `assistant.message_delta`, while `assistant.streaming_delta`
is treated only as a liveness heartbeat because it reports cumulative byte
counts rather than display text. Intent, model-provided reasoning summaries,
fusion activity, server-tool progress, and terminal outcomes are normalized
into bounded application-owned `agent.working_update` events with the outer
turn's trace, correlation, causation, agent, SDK-session, and assistant-message
attribution. The runtime never publishes raw hidden chain-of-thought or
provider tool-call fragments.

Desktop owns a global `none | concise | detailed` reasoning-summary preference,
defaulting to `concise`. A change does not interrupt the current turn. Before
the next turn for an active agent, the application resumes the same SDK session
with the updated `reasoningSummary` configuration so conversation history and
session identity are preserved. Models that do not provide summaries still
produce intent, liveness, operation, and terminal Working updates.

Managed desktop turns select an explicit SDK agent mode. Interactive is the
compatibility default; plan mode is persisted per active-agent instance and is
forwarded on normal messages, automation-originated messages, and explicit
skill invocations. Automation ingress records the same effective mode on its
visible user-turn event. Plan mode is also an application-enforced read-only
boundary: inspection tools remain available, but every Ableton mutation is
rejected before approval, locking, or bridge dispatch. The SDK client still
runs in `empty` mode. The application then
source-qualifies the approved `BuiltInTools.Isolated` set, excluding the SDK
`skill` implementation, disables SDK tool search so every allowed definition
is loaded directly, and adds application-owned Ableton, `read_plan`,
`write_plan`, and progressive-disclosure `skill` tools. Planning controls
(`ask_user`, `read_plan`, `write_plan`, and `exit_plan_mode`) remain available
even when an agent definition has an otherwise empty tool list. The
plan-mode pre-tool hook applies mutation denial only to tools positively
classified as Ableton mutations; SDK control tools such as `exit_plan_mode`
must pass through. SDK mode changes, plan changes, completed-plan approval
requests, artifact changes, structured elicitation requests, and approval
completions are normalized into application-owned, attributed events.
Sessions register both the SDK elicitation and legacy user-input capabilities
because some SDK/runtime combinations otherwise omit `ask_user` from native
custom agents. The model-facing variant remains structured elicitation. If the
runtime dispatches the compatibility callback, the application adapts it into
the same attributed elicitation events and Desktop composer takeover rather
than exposing terminal-style input. Choice-based `ask_user` requests are marked
as accepting one bounded custom string in addition to their declared choices,
so the Desktop can always render a final freeform answer field. Validation
retains strict enum behavior for unrelated SDK or MCP elicitation schemas that
do not carry this application-owned marker.

The outer Copilot turn timeout is a cumulative active-work budget rather than a
wall-clock deadline. Its budget runs while the SDK, model, hooks, and tools are
working, but pauses without a deadline while the application is waiting for a
structured elicitation answer, completed-plan decision, or human tool approval.
Desktop defaults this budget to 10 minutes and exposes a bounded 1-120 minute
setting that applies to subsequent turns immediately.
Nested human gates use reference-counted pauses, so resolving one request cannot
restart the timer while another remains pending. Resuming continues from the
remaining budget rather than resetting it. Explicit cancellation, disconnect,
session replacement, and shutdown still settle pending requests immediately.
Attributed `agent.turn.timeout.paused` and `agent.turn.timeout.resumed` records
capture the gate reason, request ID, remaining budget, pending-gate count, and
human-wait duration. `agent.turn.timeout.cancelled` records interrupted waits
without briefly restarting the timer during cancellation or disconnect.
Tool- and bridge-level operation timeouts remain independent and unchanged.

Immediately before a plan-mode turn is sent to the SDK, the application appends
`packages/application/prompts/plan-reminder.md` after all prepared context,
direct-skill content, and the user's request. This final prompt suffix reminds
the model that skill editing instructions are post-approval work and that the
current turn must use `ask_user` for user-owned decisions, maintain the
canonical file through `read_plan` and `write_plan`, and finish through
`exit_plan_mode`. Interactive turns do not receive the suffix. This is a
compliance aid, not the safety boundary; the
pre-tool mutation denial and mutation-handler guard remain authoritative. Turn
lifecycle records include whether the reminder was applied and its version.

Each App session owns one canonical plan at
`project-state/{live-project-id}/live-set-state/{live-set-id}/session-state/{app-session-id}/artifacts/plan.md`,
or beneath `unassigned-live-set-state/{live-set-id}` when no verified Project
exists. The fixed-target
`read_plan` and `write_plan` tools accept no path, bypass ordinary tool
permission prompts, reject symbolic links, sanitize embedded credentials,
enforce size limits, publish atomically, and use SHA-256 revisions for
optimistic writes. They cannot access arbitrary host files.

When the SDK requests a completed-plan decision, the application ignores the
SDK-provided plan body and reads the canonical artifact. A missing or empty
file declines immediately with actionable feedback. The application retains
request ownership on the originating active-agent instance, revalidates the
artifact revision before approval, and republishes an updated pending request
when the file changes during review. The desktop may approve and continue
interactively, request changes with bounded feedback, or exit plan mode without
implementation. SDK autopilot and fleet actions are not exposed. Artifact,
elicitation, and plan-response lifecycle records include queued, started,
completed, failed, stale, and cancelled outcomes where applicable, with timing
and original trace/session attribution. The bounded SDK summary remains in the
runtime contract and local history for compatibility and diagnostics, but the
Desktop review composer does not repeat it beside the canonical Inspector
rendering.

The deterministic unit and Electron suites enforce the application contract.
SDK compatibility can additionally be checked with
`RUN_COPILOT_PLAN_EXIT_SMOKE=1 pnpm live:copilot-plan-exit`; this authenticated,
opt-in smoke exposes only fixed-target `write_plan` and `exit_plan_mode`,
requires the artifact before approval, and always resolves `exit_only`.

## System behavior

The canonical shared system message is
`packages/application/prompts/base-system-message.md`. The conditional
plan-turn suffix is independently editable at
`packages/application/prompts/plan-reminder.md`. The application loads both
files relative to its source or compiled module, and the application build
copies them into `dist/prompts` for packaged execution. Missing or empty prompt
content is a startup error. Agent-definition YAML files contain only
specialization prompts and do not duplicate shared guidance.

The base system message should teach every custom agent:

- Ableton terminology and project structure.
- The difference between Session and Arrangement views.
- One-based identifiers shown to users versus internal stable references.
- The need to inspect before editing.
- The requirement to verify state after mutation.
- When user approval is required.
- How to report assumptions and partial failures.
- That tool results, not chat memory, determine current Live state.

Detailed genre recipes and composition guidance belong in skills or reference
content, not in an ever-growing base system message.

The separate plan reminder should teach active plan turns to remain read-only,
treat skill mutation instructions as future implementation, use structured
`ask_user` elicitation for user-owned decisions, read and revision-safely update
the shared Markdown artifact, and call `exit_plan_mode` with only a concise
review summary.

## Session context

Each turn may receive a compact context block containing:

- Current connection and capability status.
- Selected tracks, clips, and devices.
- Project tempo, signature, and arrangement summary.
- Current production plan.
- Pending approvals.
- Recent change sets.
- Relevant user preferences.

Prepared track context includes at most 32 ordered top-level device summaries
per track: identity, name/class, enabled state, and parameter count. It does not
automatically enumerate parameter bodies or nested rack chains. Successful
bridge mutations explicitly invalidate the cache so a newly loaded effect is
visible on the next refreshed turn.

Do not inject a full project dump on every turn. The agent can call inspection
tools for detail.

For user-authored managed-agent messages and explicit skill invocations, the
renderer sends the visible selection in the same validated IPC request as the
user text. The main process composes that bounded selection into the effective
prompt before starting the turn. This atomic boundary prevents a prior
selection update from becoming stale or being dropped. The general per-turn
project snapshot remains an independent hook context and must not repeat the
explicit selection block.

## Hooks

### Session start

- Load project preferences.
- Inject current Ableton connection status.
- Restore the active production plan.

### User prompt submitted

- Attach explicit UI selections atomically to normal and skill turns.
- Avoid silently rewriting musical intent.

### Pre-tool use

- Enforce tool allowlists.
- Classify risk.
- Validate connection and project identity.
- Require approval for destructive or broad changes.
- Attach and propagate trace/correlation/causation IDs.
- Record request, policy, approval, queue, and start lifecycle with relevant
  timing.

### Post-tool use

- Record change-set metadata.
- Redact internal protocol details.
- Update project state.
- Produce UI operation events.
- Record sanitized progress, bridge/workflow children, result, verification,
  duration, and completed lifecycle.

### Tool failure

- Preserve structured failure codes.
- Tell the agent whether retrying is useful.
- Prevent retry loops for unsupported capabilities or permission denials.
- Record failed or cancelled lifecycle and timing under the original trace.

## Custom agents

The application supports multiple explicitly activated custom agents. Each
active instance owns an independent SDK session and uses a YAML-defined prompt,
tool allowlist, edit scope, skills, and input subscriptions. See
[Custom Agents](../agents/custom-agents.md).

These are user-selected primary conversations, not autonomous hidden
sub-agents. The application selects exactly one custom-agent definition inside
each SDK session and attributes every event to its active instance.

## Completion

An agent turn is complete only when:

- Requested operations have returned.
- Required verification has completed.
- Any partial failures are clearly surfaced.
- Project-state updates are persisted.

Use the SDK's idle event as the mechanical completion signal. Application
workflow completion should be represented separately by operation and
change-set status.

## Live Set save actions

The runtime consumes typed `live_set.save_observed` bridge events through a
per-Live-Set dispatcher. Duplicate metadata tuples are ignored, observations
for one Set are serialized, and registered actions execute in deterministic
order. A Set switch or runtime shutdown aborts obsolete work.

Actions are injected through `LiveSetSaveAction`, allowing snapshot capture or
persistence to remain a separate package. Each action receives the bounded
metadata observation, bridge receipt time, project revision, `AbortSignal`, and
a progress hook. Observation and action queued, started, progress, completed,
failed, and cancelled stages emit application-owned telemetry with stable
trace/correlation/causation relationships.
