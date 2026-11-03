---
name: author-integration-test
description: Turn a user's scenario into a fixture-backed integration test. Agree on correctness, give the user steps to prepare an Ableton Set, verify their project, and register and run it through shared tooling.
---

# Author a fixture-backed integration test

The user prepares the Set in Live. The development agent defines the contract,
writes the preparation instructions, verifies the supplied project, and packages
the test. Computer-use fixture creation is not a prerequisite.

Read the [authoring guide](../../../docs/testing/acceptance-authoring.md) for
supported drivers, schemas, commands, and storage rules. Use the
[contract checklist](references/test-contract.md) for review.

## 1. Understand the scenario

- Ask what the user wants to do, in what order, and what should happen.
- Identify observable success, failure, and state that must not change.
  Turn subjective criteria into agreed checks or flag them as unsupported.
- Establish whether the user will prepare a new Set or supply an existing one.
  Do not search personal projects without a user-provided location.
- Choose a supported test entry point. Flag missing driver or evidence support
  before asking the user to build a fixture.

## 2. Agree on the test contract

- Specify exact user messages, initial Set state, target identities, required
  devices/media, and finite execution deadlines.
- Define which turns share a conversation and project; independent cases get
  fresh copies and isolated application state.
- Specify allowed mutations and approvals, including tool/action, exact argument
  scope, risk, and use limits. Keep ordinary approvals; no YOLO or approve-all.
- Define independent assertions and their evidence sources, including persistence
  and cleanup where relevant. Assistant claims and message acceptance are not
  correctness checks; derive expected values independently of test output.
- Ask the user to approve the contract before fixture preparation. Changes to
  expected behavior or scope require renewed review, not adjustments to fit a
  failing result.

## 3. Give the user a Set-building recipe

- Provide an ordered checklist of concrete Live 11 actions: tracks and clips to
  create, names, media to import, devices to load, routing, and required settings.
  Include exact values rather than instructions such as "set up the baseline."
- Identify the files the user needs and where to get them. Distinguish approved
  fixture assets from devices supplied by the production candidate under test.
- Use neutral names where names could reveal the expected answer. Keep expected
  answers and test instructions out of the agent-visible project.
- Explain how to save a separate project and collect its required media into it.
  Request the project folder containing the `.als` and media, not just the `.als`.
- Include a short pre-handoff checklist and ask for an audition when the test
  depends on the source's musical identity. Wait for the user's prepared project.

## 4. Ingest and verify the project

- Use the [intake helper](scripts/intake-project.mjs), with an existing output
  directory outside the user's project:
  `node .github/skills/author-integration-test/scripts/intake-project.mjs --project "/path/to/Project" --output ".test-artifacts/fixture-authoring"`.
  It copies the root Set and project-local referenced files, records hashes,
  and reports external references without following them.
- Record source paths and hashes, then inspect an owned copy. Leave the original
  unchanged; reject missing files, symlinks, path escapes, and naming collisions.
- Review the helper's `*-intake.json` beside the copy. `copied-for-review` means
  basic intake succeeded, not that Live settings, device companions, or the
  musical scenario were verified. External references may include preset history.
- Check media redistribution rights, portable file references, and dependencies.
  Production-supplied devices must match the candidate, not a hidden older copy.
  Record exact saved listener slots and indexes in `listenerBindings`; the shared
  driver derives and verifies a separate frozen device and prepared Set. Only
  top-level Audio/MIDI slots are supported. Do not repair musical settings or
  dismiss active external preset/IR dependencies as source history. See
  [candidate binding](../../../docs/testing/acceptance-authoring.md#current-candidate-listener-binding).
- Verify the actual baseline against the contract. When Live inspection is
  needed, use a dedicated runner-owned Live 11 process and isolated app profile,
  not the user's running session or authenticated profile.
- For audio, verify the loaded file's owned path and hash, not just expected
  manifest values. Record the actual Live version and relevant sample rates.
- Report mismatches and agree on corrections; do not silently repair the Set.
  Obtain final asset and permission approval before freezing or registration.

## 5. Package and register the test

- Use `@ableton-agent/test-support/integration` contracts and the matching
  repository templates. Do not create a scenario-specific runner.
- Write `integration/fixtures/<fixture-id>/fixture.json` and approved assets,
  with hashes, provenance, rights, dependencies, and preparation instructions.
  Keep runner-only metadata outside the staged project.
- Write `integration/acceptance-scenarios/<scenario-id>.json` with the reviewed
  turns, permissions, budgets, and assertions. Register its ID in
  `integration/acceptance-scenarios/suite.json`.
- Reuse existing assertions. If a required check lacks evidence, add a narrowly
  scoped typed read/assertion with regression coverage; do not substitute a
  weaker check. Placeholder assets are not runnable fixtures.

## 6. Validate, run, and hand off

- Run `pnpm test:acceptance:list` and
  `pnpm test:acceptance:validate --scenario <id>` to verify registration and inputs.
- With real-host execution approved, use `integration-testing` and
  `pnpm live:acceptance --scenario <id>`. Use `desktop-ux-testing` separately when
  visible interaction needs qualification.
- Verify preconditions before submission; never repair them during execution.
  Submit each turn once, wait for its attributable completion, and do not resend
  after an ambiguous acknowledgement.
- Distinguish blocked setup from a valid test exposing a product failure.
  Missing evidence, cleanup failure, or receipt-write failure prevents a pass.
- Preserve failures through the shared runner's bounded, sanitized receipts and
  project retention. Never archive credentials or an authenticated profile.
- For a product defect, add a lower-level regression, fix it, and rerun the
  unchanged contract plus owning tests. Do not change expectations to obtain green.
- Report fixture/scenario paths, the run command, checked behavior, result,
  evidence location, cleanup outcome, and remaining blockers.
