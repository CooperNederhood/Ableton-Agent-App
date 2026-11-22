# Testing

We test at three layers. Fast tests cover code logic and run in seconds to
minutes; they are the inner loop. Two real-Live layers then check that the
agent actually works against Ableton Live 11: a capability check driven by the
CLI, and a user-message acceptance check driven through the packaged desktop
app.

| Layer                    | Command                 | What it proves                                                                                                                             |
| ------------------------ | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Fast tests               | `pnpm test`             | Code logic in TypeScript, Max device scripts and the Python Remote Script. No Live, no model.                                              |
| Capability (agent-smoke) | `pnpm live:agent-smoke` | One prompt through the CLI app against real Live. Checks which tools were called, call budgets, the Live state read back, and cleanup.     |
| User-message acceptance  | `pnpm live:acceptance`  | The packaged desktop app with the Default agent and real user messages against a prepared Live Set. The final check for agent-facing changes. |

## Fast tests

`pnpm test` runs three runners in a row:

| Script               | Runner                                    | Covers                                                        |
| -------------------- | ----------------------------------------- | ------------------------------------------------------------- |
| `pnpm test:ts`       | Vitest (`vitest.config.ts`)               | TypeScript in `packages/`, `apps/` and `scripts/`, including React components. |
| `pnpm test:max-patches` | Node test runner                       | `max-patches/**/*.test.{cjs,mjs}`: Max for Live device scripts. |
| `pnpm test:python`   | Python `unittest`                         | `remote-script/tests/test_*.py`: the Remote Script, with fake LOM objects. |

Tests live next to the code (`foo.ts` and `foo.test.ts`). Many TypeScript tests
use fakes or a simulator in place of Live, so they can check failures,
timeouts, cancellation and cleanup that are hard to trigger in real Live.

Electron tests use Playwright and run separately:

- `pnpm test:electron` builds and runs `tests/electron/` against the app in
  source mode (UI, IPC, approvals, progress, errors).
- `pnpm test:electron:packaged` checks the packaged app starts and ships its
  resources.

`pnpm check` is the full local gate: build, format, lint, docs link check,
typecheck, contract checks, then `pnpm test`. It doesn't run Playwright or
anything that needs Live.

| Command             | What it runs                                  |
| ------------------- | --------------------------------------------- |
| `pnpm check:static` | Everything except tests (format, lint, types) |
| `pnpm check:test`   | `pnpm test`                                   |

CI (`.github/workflows/ci.yml`) runs these two as parallel jobs.

Keep unit tests fast. A test that checks behaviour at scale should use the
smallest input that still shows it (for example, a capture long enough to span
two pages, not ten minutes).

## Capability tests (agent-smoke)

`scripts/agent-smoke.mjs` launches its own Ableton Live process, installs the
Remote Script, and runs the CLI (`apps/cli`) once per scenario with a single
prompt. Scenarios are JSON files in `integration/live-scenarios/`, grouped in
`suite.json`.

A scenario says:

- `prompt`: what the CLI agent is asked to do.
- `allowedTools`, `allowedActions`, `allowedRisks`: the only calls it may make.
- `maxToolCalls`, `maxMutations`, `timeoutMs`: budgets.
- `ordering`: calls that must happen in a given order.
- `assertions`: Live state read back after the run, for example "track X has
  device Y" or "clip Z has these MIDI notes".
- `artifactPrefix`: a name prefix for everything the run creates, so cleanup
  removes only its own artifacts.

```bash
pnpm build
pnpm live:agent-smoke --scenario four-on-floor
pnpm live:agent-smoke --group session-clips
```

Use this layer to check that a tool, bridge command, Remote Script path or Max
device path works in real Live, or to debug below the desktop app. Most
scenarios start from a fresh default Set; `native-*` listening scenarios need a
prepared fixture passed on the command line (the runner tells you which flag).
The JSON receipt and traces go to `.test-artifacts/agent-smoke/`.

## User-message acceptance

This is the closest thing to a real user. `scripts/acceptance.mjs` launches its
own Live and packaged desktop app with an isolated profile, opens a copy of a
fixture Set, sends each user message once through the app's automation
endpoint, and checks the outcome. The driver is `tests/electron/acceptance-driver.ts`.

```bash
pnpm desktop:dist                               # build the app under test
pnpm test:acceptance:list                       # list scenarios
pnpm test:acceptance:validate --scenario <id>   # check scenario + fixture files
pnpm live:acceptance --scenario <id>            # run one
pnpm live:acceptance:suite                      # run every registered scenario
```

### How a scenario is built

Scenarios live in `integration/acceptance-scenarios/` and are registered in
`suite.json`. Each points at a fixture in `integration/fixtures/<id>/`: a saved
Live project (`project.als`, its media) plus `fixture.json`, which records file
hashes, the named sources (track, clip, scene) and where listener devices sit.

A scenario file has four main parts (see
`integration/acceptance-scenarios/session-clip-identify.json`):

| Part          | What it holds                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------ |
| `fixtureId`   | Which prepared Set to open.                                                                            |
| `permissions` | Which tool calls the harness approves, with expected arguments, the step they belong to and how many times. |
| `steps`       | Ordered user messages, each with its own timeout and assertions.                                       |
| `assertions`  | Checks after the last step, such as total capture count, data surviving a restart, and nothing else changed. |

A `budget` caps total run, cleanup and persistence time.

### How results are checked

- **Change scenarios** (the agent edits or plays something): the harness reads
  the result back from Live or storage. Examples: `capture`, `capture-count`,
  `context`, and `unchanged`, which hashes named parts of the Set before and
  after to prove nothing else moved. The agent saying "done" is never enough.
- **Understanding scenarios** (the agent describes what it heard or saw): the
  agent's answer is checked against an expected answer, for example `choice`
  (multiple choice letter) or `fact-equals`.

Assertions are registered in `packages/test-support/src/integration/assertions.ts`.
Receipts, logs and the run's isolated profile go to `.test-artifacts/acceptance/`.

## The dev loop

1. Work in fast tests. Write or extend a test at the layer that owns the
   behavior, watch it fail, then make it pass.
2. When a bug is reported from real Live, reproduce it as a fast test first.
   Use the receipt, trace and Desktop History to find the failing layer.
3. Use agent-smoke to confirm a tool or Remote Script path in real Live when it
   helps.
4. Run the relevant acceptance scenario as the final check for any change the
   agent can feel.

Don't edit a scenario's messages, expected answer or allowed calls to make a
failing run pass. That changes what "correct" means and needs the user's
agreement.

For how-to details, use the skills:

- `.github/skills/integration-testing/SKILL.md`: choosing and running real-Live
  tests, reading failures, and a visual check of the desktop app when the UI
  changed.
- `.github/skills/author-integration-test/SKILL.md`: building a new acceptance
  scenario and fixture with a user.

## Where to look in the code

| Thing                          | Location                                       |
| ------------------------------ | ---------------------------------------------- |
| Test scripts                   | root `package.json`                            |
| Vitest and Playwright config   | `vitest.config.ts`, `playwright.config.ts`     |
| Remote Script tests            | `remote-script/tests/`                         |
| Electron tests                 | `tests/electron/`                              |
| Agent-smoke runner, scenarios  | `scripts/agent-smoke.mjs`, `integration/live-scenarios/` |
| Acceptance runner              | `scripts/acceptance.mjs`, `scripts/lib/acceptance-cli.ts` |
| Acceptance scenarios, fixtures | `integration/acceptance-scenarios/`, `integration/fixtures/` |
| Acceptance assertions          | `packages/test-support/src/integration/`       |
