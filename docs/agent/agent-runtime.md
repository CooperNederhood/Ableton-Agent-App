# Agent Runtime

## Role

The agent translates musical intent into safe, observable, verifiable
operations. It is not the source of truth for the Live set and does not execute
arbitrary code inside Ableton.

## Copilot SDK configuration

The default session should:

- Use the Node.js Copilot SDK.
- Enable streaming.
- Register only approved custom tools.
- Exclude unrelated built-in coding and shell tools.
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

Managed desktop turns select an explicit SDK agent mode. Interactive is the
compatibility default; plan mode is persisted per active-agent instance and is
forwarded on normal messages and explicit skill invocations. Plan mode is also
an application-enforced read-only boundary: inspection tools remain available,
but every Ableton mutation is rejected before approval, locking, or bridge
dispatch. Because the SDK client runs with an empty built-in tool environment,
the session allowlist must include exactly `builtin:exit_plan_mode` in addition
to the qualified application tools, and the selected custom agent allowlist
must include the bare `exit_plan_mode` name. Enabling the full isolated
built-in set would exceed the application's least-authority contract. The
plan-mode pre-tool hook applies mutation denial only to tools positively
classified as Ableton mutations; SDK control tools such as `exit_plan_mode`
must pass through. SDK mode changes, plan changes, completed-plan approval
requests, and approval completions are normalized into application-owned,
attributed events. Plan summaries, content, and feedback are bounded and
sanitized before journaling or renderer delivery.

Immediately before a plan-mode turn is sent to the SDK, the application appends
`packages/application/prompts/plan-reminder.md` after all prepared context,
direct-skill content, and the user's request. This final prompt suffix reminds
the model that skill editing instructions are post-approval work and that the
current turn must finish through `exit_plan_mode`. Interactive turns do not
receive the suffix. This is a compliance aid, not the safety boundary; the
pre-tool mutation denial and mutation-handler guard remain authoritative. Turn
lifecycle records include whether the reminder was applied and its version.

When the SDK requests a completed-plan decision, the application retains
request ownership on the originating active-agent instance. The desktop may
approve and continue interactively, request changes with bounded feedback, or
exit plan mode without implementation. SDK autopilot and fleet actions are not
exposed by this product surface. Plan response lifecycle records queued,
started, completed, failed, and stale/cancelled outcomes with timing and the
original session attribution. Interactive approval updates the effective mode
before the paused turn resumes, so same-turn implementation is permitted only
after that transition.

The deterministic unit and Electron suites enforce the application contract.
SDK compatibility can additionally be checked with
`RUN_COPILOT_PLAN_EXIT_SMOKE=1 pnpm live:copilot-plan-exit`; this authenticated,
opt-in smoke exposes only `exit_plan_mode` and always resolves `exit_only`.

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
treat skill mutation instructions as future implementation, ask a concise chat
question only when ambiguity blocks an actionable plan, produce multiline GFM,
and call `exit_plan_mode`.

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
