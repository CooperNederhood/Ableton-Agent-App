---
name: integration-testing
description: Use for running and diagnosing deterministic natural-language agent/Live tests with reviewed scenarios and independent postconditions. Distinguish the existing pnpm live:agent-smoke runtime/CLI suite from fixture-backed packaged automation acceptance. Use author-integration-test to author reviewed fixture/scenario contracts, and desktop-ux-testing for visual cross-app UX.
---

# Ableton agent integration testing

Use this skill when validating natural-language Ableton workflows against real
Live. The deterministic harness, scenario manifests, traces, and bridge reads
are the source of truth; assistant prose is diagnostic evidence only.
Choose the evidence layer explicitly. The existing runtime/CLI suite is separate
from packaged Default-agent automation acceptance; MCP stdio is not required for
either. See the canonical
[test strategy](../../../docs/testing/test-strategy.md) for layer and receipt
boundaries and [acceptance authoring](../../../docs/testing/acceptance-authoring.md)
for command availability and qualification status.

## Choose the workflow

- **Author or revise a persistent fixture-backed case:** invoke
  `author-integration-test` with the developer. That skill owns copy-only
  inspection, human contract review, portable assets, and registration. Never
  inject it or runner-only oracle data into the product agent.
- **Run an existing runtime/CLI case:** follow the procedure below, selecting
  from `integration/live-scenarios/suite.json`.
- **Run packaged automation acceptance:** use `pnpm test:acceptance:list` and
  `pnpm test:acceptance:validate`, then the explicit
  `pnpm live:acceptance --scenario <registered-id>` entry point according to the
  authoring guide. Its catalog is `integration/acceptance-scenarios/`, with
  fixtures in `integration/fixtures/`. Do not substitute `live:agent-smoke`.
  `session-clip-identify` now has reviewed assets and a registered manifest.
  Registration is not qualification: inspect terminal receipts for its current
  status. Do not infer success from framework checks or claim a UI driver.

For acceptance, read the frozen contract before execution. Verify the loaded
baseline without repair, submit each exact turn once, wait for attributable
terminal work, and require independent source/context/postcondition and cleanup
checks. A lost acknowledgement is ambiguous failure, not permission to resend.
List/schema validation alone is not fixture admission or real-host success.

## Runtime/CLI procedure

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

- For fixture-backed acceptance, distinguish invalid/blocked setup from a valid
  red product test. Missing assets, hash mismatch, failed baseline, unsupported
  driver, or absent dependencies cannot become a pass or a product-quality
  claim. Preserve failures and never change expected answers, prompts, fixtures,
  permissions, or assertions to match observed output. Contract changes return
  to human authoring review.
- Require the intended same Default agent/session/conversation throughout an
  acceptance case, no extra capture where forbidden, typed context reads, and
  an owned Desktop restart for persistence claims. A correct answer alone,
  accepted submission, or in-memory cached read is insufficient.
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

## Expanding runtime/CLI deterministic coverage

Do not treat `pnpm live:agent-smoke` only as a fixed suite to rerun. Add or
expand a reviewed scenario when a change introduces or alters a user-facing
natural-language workflow whose success depends on real Live behavior.
For the new reusable fixture-backed acceptance catalog, use
`author-integration-test` instead of copying this older manifest format.

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
