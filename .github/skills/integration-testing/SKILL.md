---
name: integration-testing
description: Run real-Ableton tests. Use live:acceptance (a real user message in the packaged Desktop app) as the final check for agent-facing changes, live:agent-smoke to check a tool, bridge, Remote Script, or Max device path in real Live, and the visual check when the Desktop UI itself changed. Also covers reading failures and turning them into fast regression tests.
---

# Real-Ableton testing

Real-Live tests are slow, so they confirm work rather than drive the inner
loop. Do day-to-day work with `pnpm test`, then use this skill to check the
result in real Live.

## Which test to run

| Test                        | Command                                 | What it runs                                                                                                            | Use it when                                                                                                                             |
| --------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **User-message acceptance** | `pnpm live:acceptance --scenario <id>`  | The packaged Desktop app and Default agent, driven by real user messages, against a prepared Live Set.                  | **Final check** for any agent-facing change.                                                                                            |
| **Real-Live capability**    | `pnpm live:agent-smoke --scenario <id>` | The CLI agent with one prompt against a runner-owned Live Set. Checks allowed tool calls and the Live state afterwards. | Checking that a tool, bridge command, Remote Script, or Max device path works in real Live, or debugging a layer below the Desktop app. |
| **Visual check**            | See [Visual check](#visual-check)       | You drive the visible Desktop app next to Live.                                                                         | The Desktop UI itself changed (layout, approvals, progress, errors).                                                                    |

Pick the scenario that covers the change. Run a whole group or suite only when
the change touches shared code that many scenarios depend on.

## How scenarios are checked

- **Change scenarios** (the agent edits the set): the harness reads the result
  back from Live. The agent saying it succeeded is not enough.
- **Understanding scenarios** (the agent describes what it heard or saw): the
  agent's answer is checked against the expected answer.

## User-message acceptance

Scenarios live in `integration/acceptance-scenarios/` (registered in
`suite.json`), with their Live Sets in `integration/fixtures/`. See
[`references/scenarios.md`](references/scenarios.md) for what each covers.

```bash
pnpm desktop:dist                                  # build the packaged app under test
pnpm test:acceptance:list                          # list scenarios
pnpm test:acceptance:validate --scenario <id>      # check the scenario and fixture files
pnpm live:acceptance --scenario <id>               # run it
```

- The runner launches its own Live and Desktop processes with an isolated
  profile, opens a copy of the fixture, sends each message once, checks the
  results, and cleans up.
- The receipt and logs are written under `.test-artifacts/acceptance/`.
- To build a new scenario with the user, use `author-integration-test`.

## Real-Live capability (agent-smoke)

Scenarios live in `integration/live-scenarios/`, grouped in `suite.json`.

```bash
pnpm build
pnpm live:agent-smoke --scenario <id>
pnpm live:agent-smoke --group <group-id>
```

- General scenarios start from a fresh default Set and need nothing else.
- `native-*` listening scenarios need a prepared fixture passed with
  `--native-vN-fixture-input <input.json>` and usually `--skip-install`. Each
  manifest names its flag in `setupContract.inputOption`, and the runner tells
  you if it's missing.
- If `remote-script/AbletonAgent/` changed, let the runner reinstall it; it
  always starts a fresh Live process.
- The runner prints the path of its JSON receipt.

## When a test fails

1. Read the receipt and the failing turn's trace: tool calls, arguments, and
   errors.
2. Read the app's event history for the same trace ID (Desktop History, or the
   `app_events` table in the run's isolated profile) to see what each layer
   did and with what values.
3. Find the layer that went wrong with
   [`references/failure-triage.md`](references/failure-triage.md).
4. Reproduce it in the fastest test that can show it, and watch it fail.
5. Fix it, watch that test pass, then rerun the real-Live scenario.

Don't change a scenario's prompt, expected answer, or allowed calls just to
make it pass. If the scenario itself is wrong, agree the change with the user.

## Visual check

Use this when the Desktop UI changed and you need to see it working alongside
Live.

1. Build: `pnpm build`.
2. Start a runner-owned Live in a background shell: `pnpm live:ux-host` (add
   `--fixture-path /absolute/copy.als` to open a copy of a fixture). Wait for
   its JSON ready line.
3. Start Desktop with an isolated profile:

   ```bash
   PROFILE="$PWD/.test-artifacts/desktop-ux/run-$(node -e 'console.log(crypto.randomUUID())')"
   DESCRIPTOR="$PWD/.test-artifacts/desktop-ux/automation-endpoint.json"
   mkdir -p "$(dirname "$DESCRIPTOR")"
   pnpm desktop:dev -- --automation --automation-profile "$PROFILE" \
     --automation-descriptor "$DESCRIPTOR" --automation-agent default
   ```

4. Register the debug MCP server with
   `pnpm --filter @ableton-agent/debug-mcp dev -- --descriptor "$DESCRIPTOR"`
   and send a message with its `send_user_message` tool.
5. Look at both apps with computer-use. Use `list_apps` to find each window
   (Desktop shows as `Electron` in dev; Live as `Ableton Live 11 Suite`).
6. Close the Desktop app and stop the `live:ux-host` process you started, then
   delete the profile directory.

## Safety rules

- Never use, close, or change the user's own Live session or their projects;
  tests always use their own Live process and copies of fixtures.
- Close only processes the test started, by exact process ID. Never use
  `killall` or `pkill`.
- Never auto-approve every tool call (no `--approve-all`); approvals are part
  of what is being tested.
- Never copy the user's normal profile or credentials into test artifacts.
