# Failure triage

| Layer             | Evidence                                       | First action                                              |
| ----------------- | ---------------------------------------------- | --------------------------------------------------------- |
| Agent planning    | Wrong/missing tool order in trace              | Tighten system/tool guidance; do not broaden approvals    |
| Approval policy   | Denied decision with guard reason              | Compare arguments to the reviewed manifest                |
| Tool              | Tool execution failure                         | Reproduce through the typed application/bridge method     |
| Bridge/protocol   | Validation, timeout, or framing error          | Run direct command and inspect structured error details   |
| Remote Script/LOM | `lom_error`, stale proxy, failed postcondition | Reproduce in Live 11, fix Python, add fake-LOM regression |
| Assertion         | Agent succeeded but state mismatch             | Inspect direct bridge evidence and verifier assumptions   |
| Timeout           | Turn or bridge deadline                        | Determine whether work applied before retrying            |
| Cleanup/process   | PID identity or exit mismatch                  | Fail closed; never switch to name-based termination       |

An `invalid_tool_arguments` probe may be classified as `recovered-pass` only
when every deterministic postcondition and cleanup assertion passes and there
are no policy violations. The failed call remains in the trace; bridge errors,
executed partial mutations, failed assertions, and denied unsafe calls still
fail the scenario.

After a fix, rerun the failed scenario first. If it passes, rerun the complete
group from a fresh default Set before continuing.
