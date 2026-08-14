---
name: integration-testing
description: Run and repair the runner-owned Ableton agent workflow smoke suite.
---

# Ableton agent integration testing

Use this skill when validating natural-language Ableton workflows against real
Live. The deterministic harness, scenario manifests, traces, and bridge reads
are the source of truth; assistant prose is diagnostic evidence only.

## Procedure

1. Confirm the user's normal Ableton Live process is closed. Never terminate it
   on their behalf.
2. Run:

   ```bash
   pnpm live:agent-smoke
   ```

3. Read the machine-readable evidence path printed by the harness and the
   failed scenario trace.
4. Stop at the first failure and classify it using
   `references/failure-triage.md`.
5. Reproduce at the narrowest deterministic layer:
   protocol/bridge command before agent prompt when possible.
6. Fix the root cause and add a regression test.
7. If `remote-script/AbletonAgent/` changed, let the harness reinstall it and
   launch a fresh runner-owned Live process. Do not reuse stale Python modules.
8. Rerun the failed scenario, then its group, then the remaining suite.

## Non-negotiable safety

- Never add or use `--approve-all`.
- Never broaden a scenario allowlist, risk class, budget, or argument guard
  solely to make a failure pass.
- Never operate on a Live process the harness did not launch.
- Never use `killall`, `pkill`, or process-name termination.
- Never infer success from “Done”; require every deterministic assertion.
- Preserve and report partial mutations after failed or timed-out turns.

See `references/scenario-groups.md` for suite scope.
