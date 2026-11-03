# Failure triage

| Layer             | Evidence                                                           | First action                                              |
| ----------------- | ------------------------------------------------------------------ | --------------------------------------------------------- |
| Agent planning    | Wrong/missing tool order in trace                                  | Tighten system/tool guidance; do not broaden approvals    |
| Approval policy   | Denied decision with guard reason                                  | Compare arguments to the reviewed manifest                |
| Tool              | Tool execution failure                                             | Reproduce through the typed application/bridge method     |
| Bridge/protocol   | Validation, timeout, or framing error                              | Run direct command and inspect structured error details   |
| Remote Script/LOM | `lom_error`, stale proxy, failed postcondition                     | Reproduce in Live 11, fix Python, add fake-LOM regression |
| Assertion         | Agent succeeded but state mismatch                                 | Inspect direct bridge evidence and verifier assumptions   |
| Timeout           | Turn or bridge deadline                                            | Determine whether work applied before retrying            |
| Cleanup/process   | PID identity or exit mismatch                                      | Fail closed; never switch to name-based termination       |
| Coverage/setup    | Selected IDs missing from executed results, blocked setup or skips | Retain unrun IDs; suite exit must remain unsuccessful     |
| Receipt writer    | Evidence write or finalization error                               | Report non-success; never invent a persisted receipt      |

An `invalid_tool_arguments` probe may be classified as `recovered-pass` only
when every deterministic postcondition and cleanup assertion passes and there
are no policy violations. The failed call remains in the trace; bridge errors,
executed partial mutations, failed assertions, and denied unsafe calls still
fail the scenario.

Distinguish a recovered call inside one attempt from recovery on a later
attempt. Receipt v2 retains every attempt and separates first-attempt quality
from final satisfaction. Verified expected refusals and expected metric partial
outcomes may pass only their reviewed assertion contracts, not as capability or
all-metrics success. Unsupported classification requires recognized structured
failure payloads; a token in diagnostic prose is not an override.

An early native execution checkpoint is not terminal success. Check capture
resource cleanup, then final service/process/fixture/journal cleanup and the
final per-scenario and aggregate evidence. Preserve the original failure and
later cleanup failures separately. Historical managed v5 silent-tail failures
remain negative evidence even though the corrected scenario and group now pass.
The merged bundle has bounded installed Session qualification, but a later
same-source repetition failure is not erased by its passing isolated rerun.
Consult the canonical
[listening checkpoint](../../../../docs/tools/playback-listening.md) for current
candidate pins and scope; do not generalize successful candidate receipts.

After a fix, rerun the failed scenario first. If it passes, rerun the complete
group with fresh owned processes and the group's declared default Set or exact
versioned immutable fixtures before continuing. Preserve intentionally stateful
passes/resets within each reviewed scenario; do not add repairs or retries.
Blocked/skipped/unrun selected work is incomplete, never a green suite.
