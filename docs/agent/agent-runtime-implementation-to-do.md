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

- [x] Register the first read-only Ableton session inspection tool.
- [x] Register bounded Arrangement transport inspection and risk-classified
  loop/cue-point mutation tools.
- [x] Register bounded device/parameter reads and reversible verified
  device-enable and normalized-parameter tools.
- [x] Register bounded read-only exact-rack chain/device and Drum Rack
  pad/chain/device tools without recursive expansion.

## Agent behavior

- [x] Write and version the base Ableton system message.
- [x] Define compact project-context injection.
- [x] Implement session-start, prompt, pre-tool, post-tool, and failure hooks.
- [x] Add retry guidance based on structured error codes.
- [x] Prevent retry loops for denial, unsupported capability, and stale targets.
- [x] Define task modes and mode-specific context.
- [x] Add specialized agents only after parent-agent workflows are stable.
  - The initial release intentionally keeps one parent agent because the
    deterministic workflows do not yet justify delegated subagents.

## Session management

- [x] Persist application session metadata and Copilot session IDs.
- [x] Restore project association, mode, and production plan on resume.
- [x] Handle project switches without leaking stale context.
- [x] Implement context compaction/refresh strategy for long sessions.

## Tests

- [~] Unit-test event normalization and context generation.
- [x] Unit-test hook decisions for every risk and error class.
- [x] Test system-message/tool compatibility with deterministic fixtures.
- [x] Integration-test custom tool invocation through the Copilot SDK.
- [x] Integration-test cancellation, idle completion, resume, and SDK failure.
- [x] Add transcript/evaluation cases for inspect-before-edit and verification.

## Exit criteria

- [x] Agent can inspect, mutate, verify, and report through custom tools.
- [x] No unrelated built-in tools are available.
- [x] Session resume restores useful app context.
- [x] CLI and React receive identical normalized events.
