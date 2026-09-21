# Agent Runtime Implementation To-Do

Companion specification: [Agent Runtime](agent-runtime.md)

## Copilot integration

- [x] Add the Node.js Copilot SDK and pin a tested version.
- [x] Implement `CopilotService` lifecycle and authentication diagnostics.
- [x] Implement session create, resume, send, cancel, event subscription, and
  idle detection.
- [x] Configure a restricted tool environment with explicit allowlists.
- [x] Define model and reasoning configuration with validated defaults.
- [x] Normalize SDK events into application-owned `AppEvent` values.
- [x] Explicitly enable SDK streaming and normalize assistant deltas, liveness,
  intent, bounded model-provided reasoning summaries, and terminal Working
  lifecycle without exposing raw hidden chain-of-thought.
- [x] Apply the global Off/Concise/Detailed reasoning-summary preference before
  each active agent's next turn by resuming the same SDK session.
- [x] Forward per-agent interactive/plan mode to SDK turns and normalize
  attributed mode, plan, and completed-plan approval lifecycle.
- [x] Preserve the selected agent's effective mode across automation ingress
  and its visible user-turn attribution.
- [x] Resolve completed-plan requests through the owning SDK session while
  hiding autopilot/fleet actions and recording bounded resolution lifecycle.
- [x] Enforce plan mode as read-only at both hook and mutation-handler
  boundaries, then permit same-turn implementation only after interactive
  approval.
- [x] Restore the approved SDK session-isolated built-ins while excluding
  `builtin:skill` and all host-capable coding, shell, filesystem, and network
  tools.
- [x] Disable SDK tool search so the runtime never injects an implicit
  discovery tool into agent turns.
- [x] Add permission-free fixed-target `read_plan` and `write_plan` tools with
  canonical production-session ownership, redaction, limits, atomic writes,
  revisions, and stale-write rejection.
- [x] Configure SDK `ask_user` as structured elicitation and normalize
  requested/completed/cancelled lifecycle through attributed application
  events.
- [x] Register the legacy SDK user-input capability for native custom-agent
  compatibility while adapting any callback into the same structured
  elicitation lifecycle and Desktop UI.
- [x] Scope the plan-mode pre-tool denial to classified Ableton mutations so it
  cannot block the SDK `exit_plan_mode` control tool.
- [x] Replace the SDK wall-clock turn wait with an application-owned cumulative
  active-work timeout that pauses indefinitely across elicitation, plan
  decisions, and human tool approvals, including attributed pause/resume
  lifecycle and nested-gate cleanup.
- [x] Default the active-work budget to 10 minutes and expose a validated,
  immediately applied Desktop setting for subsequent turns.
- [ ] Journal sanitized configuration snapshots on session create/resume and
  effective configuration changes.
- [ ] Journal the complete unsampled SDK/session/turn/stream/hook/tool lifecycle
  with trace/correlation continuity and bounded payloads.

- [x] Register the first read-only Ableton session inspection tool.
- [x] Register bounded Arrangement transport inspection and risk-classified
  loop/cue-point mutation tools.
- [x] Register bounded device/parameter reads and reversible verified
  device-enable and normalized-parameter tools.
- [x] Register bounded read-only exact-rack chain/device and Drum Rack
  pad/chain/device tools without recursive expansion.

## Agent behavior

- [x] Write and version the base Ableton system message.
- [x] Keep shared agent guidance in the canonical editable
  `packages/application/prompts/base-system-message.md`, copy it into the
  compiled package, and fail explicitly when it is missing or empty.
- [x] Keep the active plan-turn suffix independently editable in
  `packages/application/prompts/plan-reminder.md`, copy it into the compiled
  package, and append it after expanded skill/user prompts only in plan mode.
- [x] Require every custom agent to maintain the canonical Markdown artifact,
  use structured questions for user-owned decisions, and finish adequate
  plan-mode work with `exit_plan_mode`, without duplicating guidance in agent
  YAML definitions.
- [x] Define compact project-context injection, including bounded top-level
  device summaries and mutation-driven invalidation.
- [x] Attach bounded UI selection context atomically to managed-agent messages
  and explicit skill turns without duplicating the general project snapshot.
- [x] Implement session-start, prompt, pre-tool, post-tool, and failure hooks.
- [x] Add retry guidance based on structured error codes.
- [x] Prevent retry loops for denial, unsupported capability, and stale targets.
- [x] Use YAML-defined active agents for workflow specialization and remove the
  obsolete turn classifier from prompts and transport fields.
- [x] Add canonical Agent Skills through application-owned progressive
  disclosure.
- [ ] Add independent SDK sessions, scoped tools, edit scopes, and attributed
  events for multiple active agents.

## Session management

- [x] Persist application session metadata and Copilot session IDs.
- [x] Restore project association, mode, and production plan on resume.
- [x] Persist SDK interaction mode independently for each active-agent
  instance.
- [x] Handle project switches without leaking stale context.
- [x] Dispatch observed saves through ordered, per-Live-Set injectable actions
  with deduplication, Set-switch/shutdown cancellation, and full lifecycle
  observability.
- [x] Implement context compaction/refresh strategy for long sessions.

## Tests

- [~] Unit-test event normalization and context generation.
- [x] Test plan-mode forwarding, action filtering, request ownership, and
  renderer-safe plan approval contracts.
- [x] Regression-test plan-mode read access, mutation denial, and post-approval
  interactive continuation.
- [x] Regression-test approved built-in/application allowlists across create,
  resume, empty, skill-enabled, wildcard, and deduplicated configurations,
  including managed cancellation and bounded approval payloads.
- [x] Regression-test canonical plan reads/writes, redaction, permissions,
  optimistic conflicts, stale approval, manual updates during review, and
  structured elicitation resolution.
- [x] Regression-test active-work timeout exhaustion, unlimited human wait,
  nested pause counts, remaining-budget resume, cancellation, and cleanup.
- [x] Regression-test managed message and skill prompt composition, selection
  disabling, deduplication, and replacement between turns.
- [x] Regression-test final plan-reminder ordering after direct skill expansion,
  interactive exclusion, source/dist prompt copying, and reminder attribution.
- [x] Regression-test save-action ordering, deduplication, failure, progress,
  trace attribution, Set-switch cancellation, and shutdown cleanup.
- [ ] Test configuration snapshot revisions, SDK event coverage, redaction,
  lifecycle ordering, cancellation/failure timing, and trace propagation.
- [x] Unit-test hook decisions for every risk and error class.
- [x] Test system-message/tool compatibility with deterministic fixtures.
- [x] Integration-test custom tool invocation through the Copilot SDK.
- [x] Integration-test cancellation, idle completion, resume, and SDK failure.
- [x] Add transcript/evaluation cases for inspect-before-edit and verification.

## Exit criteria

- [x] Agent can inspect, mutate, verify, and report through custom tools.
- [x] Only approved session-isolated built-ins are available; host-capable
  built-ins and the SDK skill implementation remain unavailable.
- [x] Session resume restores useful app context.
- [x] CLI and React receive identical normalized events.
