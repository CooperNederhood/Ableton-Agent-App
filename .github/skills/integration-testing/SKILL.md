---
name: integration-testing
description: Use for deterministic validation of natural-language agent prompts, tools, workflows, bridge behavior, and exact Ableton project mutations against a runner-owned Live process with scenario manifests, traces, and postcondition assertions via pnpm live:agent-smoke. Do not use for visual Electron UX, layout, progress, approval, or cross-app computer-use testing.
---

# Ableton agent integration testing

Use this skill when validating natural-language Ableton workflows against real
Live. The deterministic harness, scenario manifests, traces, and bridge reads
are the source of truth; assistant prose is diagnostic evidence only.
This executes reviewed runtime/CLI scenarios, not a packaged Default-agent
conversation through MCP stdio. See the canonical
[test strategy](../../../docs/testing/test-strategy.md) for layer and receipt
boundaries; a packaged multi-turn acceptance runner is a future milestone.

## Procedure

1. Confirm the user's normal Ableton Live process is closed. Never terminate it
   on their behalf.
2. Start with the owning scenario (or the smallest owning group):

   ```bash
   pnpm live:agent-smoke --scenario <reviewed-scenario-id>
   pnpm live:agent-smoke --group <owning-group-id>
   ```

   Choose IDs from `integration/live-scenarios/suite.json` and
   `references/scenario-groups.md`. Native groups require their exact explicit
   versioned fixture inputs and `--skip-install`; never substitute another
   version or assume a private ignored fixture exists locally.

3. Read the machine-readable evidence path printed by the harness, the selected,
   executed and unrun sets, every attempt and the failed scenario trace.
4. Stop at the first failure and classify it using
   `references/failure-triage.md`.
5. Reproduce at the narrowest deterministic layer:
   protocol/bridge command before agent prompt when possible.
6. Fix the root cause and add a regression test.
7. If `remote-script/AbletonAgent/` changed, let the harness reinstall it and
   launch a fresh runner-owned Live process. Do not reuse stale Python modules.
8. Rerun the failed scenario, then its group, then the remaining suite.
   Independent attempts start fresh processes; intentional same-instance
   repeated passes, source changes and fixture-owned resets inside a reviewed
   scenario must retain that stateful contract. Do not reset or repair it ad hoc.

## Evidence and qualification

- Receipt v2 distinguishes first-attempt success, recovered outcomes and final
  scenario satisfaction. Preserve original attempts and historical receipt
  versions; do not rewrite old receipts.
- Skipped, blocked or selected-but-unrun scenarios prevent successful suite exit.
  A verified expected refusal/partial-metric contract can pass separately but
  does not prove the refused capability or all metrics succeeded.
- Native execution checkpoints are provisional until terminal cleanup is
  accounted for. Capture cleanup, process shutdown and fixture deletion are
  distinct; passing one cannot excuse failure of another. Read terminal `.json`,
  not only native `.checkpoint.json`; records distinguish
  `finalization: "checkpoint"` from `"final"` and retain `executionClassification` if cleanup
  or persistence fails. Final summaries use terminal results.
- The merged v5 production bundle has bounded Session and installed-startup
  qualification, including corrected silent-tail capture and matched payloads.
  A later repetition failure and incorrect offbeat interpretation remain open;
  isolated recovery does not erase them. Follow the current scope and candidate
  pins in [Playback Listening](../../../docs/tools/playback-listening.md).
  Upstream qualification does not qualify a changed runner, arbitrary launch
  states, or synthetic/bootstrap/engineering fixtures.
- Record actual full Live 11 version, candidate pins, selected coverage and
  cleanup evidence. Isolated app data follows the shared storage resolver and
  [local storage contract](../../../docs/platform/local-storage.md); disposable
  fixture/evidence artifacts do not define another application-state layout.

## Expanding deterministic coverage

Do not treat `pnpm live:agent-smoke` only as a fixed suite to rerun. Add or
expand a reviewed scenario when a change introduces or alters a user-facing
natural-language workflow whose success depends on real Live behavior.

1. Add the narrowest unit, protocol, bridge, tool, and workflow regression tests
   first. The real-Live scenario is not a substitute for deterministic lower
   layers.
2. Add or update a manifest under `integration/live-scenarios/` with:
   - one exact reviewed prompt;
   - the minimum tool and risk allowlist;
   - explicit budgets and ordering constraints;
   - a generated artifact namespace;
   - argument and identity guards;
   - deterministic baseline and final assertions; and
   - cleanup assertions that restore or explicitly account for the Set.
3. Add the scenario to `suite.json` in the smallest owning group.
4. Extend the verifier with read-only bridge assertions. Never ask the model to
   judge whether its own work succeeded.
5. Cover the unsupported, denied, partial-failure, timeout, rollback, or cleanup
   condition relevant to the capability at a lower deterministic layer. Add a
   real-Live failure scenario only when simulator or fake coverage cannot prove
   the behavior.
6. Run the new scenario alone, then its group, then the full remaining suite.

Do not add a real-Live scenario for renderer-only layout, styling, copy, or
presentation changes. Those require component, Electron Playwright, and visual
desktop UX testing instead.

## Non-negotiable safety

- Never add or use `--approve-all`.
- Never broaden a scenario allowlist, risk class, budget, or argument guard
  solely to make a failure pass.
- Never operate on a Live process the harness did not launch.
- Never use `killall`, `pkill`, or process-name termination.
- Never infer success from “Done”; require every deterministic assertion.
- Preserve and report partial mutations after failed or timed-out turns.
- Never classify unsupported capability by incidental prose substrings or let
  it override failed assertions, unrelated failures, denied unsafe calls or
  cleanup failure.

See `references/scenario-groups.md` for suite scope.
