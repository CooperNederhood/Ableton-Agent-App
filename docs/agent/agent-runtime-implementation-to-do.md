# Agent Runtime Implementation To-Do

Companion specification: [Agent Runtime](agent-runtime.md)

## Copilot integration

- [x] Add the Node.js Copilot SDK and pin a tested version.
- [ ] Implement `CopilotService` lifecycle and authentication diagnostics.
- [ ] Implement session create, resume, send, cancel, event subscription, and
  idle detection.
- [x] Configure a restricted tool environment with explicit allowlists.
- [ ] Define model and reasoning configuration with validated defaults.
- [x] Normalize SDK events into application-owned `AppEvent` values.

- [x] Register the first read-only Ableton session inspection tool.
- [x] Register bounded Arrangement transport inspection and risk-classified
  loop/cue-point mutation tools.
- [x] Register bounded device/parameter reads and reversible verified
  device-enable and normalized-parameter tools.

## Agent behavior

- [x] Write and version the base Ableton system message.
- [ ] Define compact project-context injection.
- [ ] Implement session-start, prompt, pre-tool, post-tool, and failure hooks.
- [ ] Add retry guidance based on structured error codes.
- [ ] Prevent retry loops for denial, unsupported capability, and stale targets.
- [ ] Define task modes and mode-specific context.
- [ ] Add specialized agents only after parent-agent workflows are stable.

## Session management

- [ ] Persist application session metadata and Copilot session IDs.
- [ ] Restore project association, mode, and production plan on resume.
- [ ] Handle project switches without leaking stale context.
- [ ] Implement context compaction/refresh strategy for long sessions.

## Tests

- [~] Unit-test event normalization and context generation.
- [ ] Unit-test hook decisions for every risk and error class.
- [x] Test system-message/tool compatibility with deterministic fixtures.
- [ ] Integration-test custom tool invocation through the Copilot SDK.
- [ ] Integration-test cancellation, idle completion, resume, and SDK failure.
- [ ] Add transcript/evaluation cases for inspect-before-edit and verification.

## Exit criteria

- [ ] Agent can inspect, mutate, verify, and report through custom tools.
- [x] No unrelated built-in tools are available.
- [ ] Session resume restores useful app context.
- [ ] CLI and React receive identical normalized events.
