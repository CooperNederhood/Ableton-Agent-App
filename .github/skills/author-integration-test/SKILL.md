---
name: author-integration-test
description: Turn a user's scenario into a fixture-backed user-message acceptance test. Agree what correct looks like, give the user steps to prepare an Ableton Set, take in and check their project, then register and run the test.
---

# Author a user-message acceptance test

The user builds the Live Set; you define the test, write the preparation steps,
check the project they hand over, and register the scenario. The result runs
with `pnpm live:acceptance --scenario <id>` (see `integration-testing`).

## 1. Understand the scenario

- Ask what the user wants to say to the agent, in what order, and what should
  happen.
- Write the messages the way a user would actually type them. Don't spell out
  tool calls or arguments unless that is what's being tested.
- Decide how each turn is checked: Live state read back for changes, or the
  agent's answer against an expected answer for understanding.

## 2. Agree the test with the user

Use [`references/test-contract.md`](references/test-contract.md) as a short
review form. Agree:

- the starting Set and anything that must not change,
- the exact messages and which share a conversation,
- which tool calls need approval and how many times,
- what is checked after each turn and at the end.

Get the user's OK before they build the Set. Later changes to what counts as
correct go back to the user; don't adjust a test to fit a failing result.

## 3. Give the user a Set-building recipe

- An ordered checklist of Live 11 steps with exact values: tracks, clips,
  names, media, devices, settings.
- Use neutral names that don't give away the expected answer.
- Ask them to save a separate project, collect all media into it, and send the
  whole project folder.

## 4. Take in and check the project

```bash
node .github/skills/author-integration-test/scripts/intake-project.mjs \
  --project "/path/to/Project" --output ".test-artifacts/fixture-authoring"
```

- The helper copies the Set and its project-local media, records hashes, and
  lists external references. Work only on the copy.
- Check the copy matches the agreed starting state. If you need to inspect it
  in Live, use a runner-owned Live (`pnpm live:ux-host --fixture-path <copy>`).
- Record listener device positions in `listenerBindings`.
- Report mismatches to the user rather than silently fixing the Set.
- Confirm the user may redistribute any media in the fixture.

## 5. Register the test

- Fixture: `integration/fixtures/<fixture-id>/fixture.json` plus assets.
- Scenario: `integration/acceptance-scenarios/<scenario-id>.json`, registered
  in that folder's `suite.json`. Copy the closest existing scenario.
- Reuse existing assertions. Add a new one only when nothing existing can check
  what was agreed.

## 6. Validate and run

```bash
pnpm test:acceptance:validate --scenario <id>
pnpm live:acceptance --scenario <id>
```

- A setup failure (missing asset, wrong hash, Live didn't start) isn't a
  product result; fix the setup.
- A product failure: reproduce it in a fast test, fix it, rerun the scenario
  unchanged.
- Report the scenario path, the run command, the result, and where the receipt
  is.
