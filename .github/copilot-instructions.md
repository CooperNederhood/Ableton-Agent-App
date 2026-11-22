# Repository-wide Copilot instructions

## The goal

Ableton Agent lets a musician ask an AI agent to inspect, change, and listen to
their Ableton Live 11 set. Every change should make that work more reliably for
a real user sending real messages. Keep that goal in view; do not let process,
guards, or bookkeeping become the work.

## How to develop

1. **Make it work end to end first.** Build the simplest version of the
   feature that does the job in real Live.
2. **Make it general and extensible.** Extend existing code and structures
   instead of adding parallel ones. Before adding a file, function, or class,
   check whether something already does most of the job.
3. **Add checks only for problems that have actually happened.** Do not guard
   against failures nobody has observed. When a real failure shows up (usually
   in user testing), follow the bug loop below.

### Runtime checks

- Reject an operation only when continuing would put the user's project at
  risk: wrong target, unintended recording or edits, data loss, or failed
  cleanup.
- Anything else that looks unusual should be **recorded** (logged with its
  values) and the operation should continue.
- Prefer trusting what Ableton Live reports over predicting it and comparing.

### Visibility

Make failures easy to diagnose without front-loading work:

- Each user-facing operation records a started event and a completed or failed
  event, with the values needed to understand what happened. Reuse the existing
  event and trace plumbing; do not add per-stage event families by default.
- Redact credentials and omit audio/binary bodies before anything is persisted.
  History stays local and is read through typed Desktop History queries.

### The bug loop

1. A failure is observed, usually through user testing.
2. Read the session transcript, Desktop History, and event telemetry to find
   what actually happened.
3. Reproduce it in the fastest test that can show it (it should fail).
4. Fix it (the test should now pass).
5. Rerun the relevant user-message acceptance scenario.

## Testing

| Layer                     | Command                 | Real Live? | Use it for                                                                                                                  |
| ------------------------- | ----------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------- |
| Unit, component, contract | `pnpm test`             | No         | The inner loop: every change and every bug reproduction.                                                                    |
| Real-Live capability      | `pnpm live:agent-smoke` | Yes        | Checking that a tool, bridge, Remote Script, or Max device path works in real Live, one layer below the Desktop app.        |
| User-message acceptance   | `pnpm live:acceptance`  | Yes        | **The final check** for agent-facing changes: a real message in the packaged Desktop app produces the right result in Live. |

- Unit tests cover logic that is genuinely tricky and every real bug that was
  fixed. Do not add tests for hypothetical failures.
- Real-Live runs are slow. Use them to confirm work, not as the inner loop.
- Check each scenario against what it is testing. When the agent changes the
  set, read the result back from Live; the agent saying it succeeded is not
  enough. When the test is about the agent's understanding (for example,
  describing a clip it listened to), check its answer against the expected
  answer.
- Use the `integration-testing` skill to run real-Live tests and
  `author-integration-test` to build a new scenario with the user.
- Automation uses an isolated Desktop profile and its own Live process. Never
  close or change the user's own Live session or work.

## Documentation

`docs/` is a guide for a new engineer learning how the app works. Update it
when a main concept or the architecture changes. It is not a changelog,
to-do list, or record of test runs; those belong in pull requests, issues,
and git history.

## Storage

Persisted data uses the shared `@ableton-agent/storage` resolver and the
`~/.live-agent/profiles/{profile}` layout described in
[`docs/storage.md`](../docs/storage.md). Do not
invent other application-data paths.

## Ableton

- Supports Ableton Live 11 **only**, not Live 12. Development uses Live Suite
  11.3.x on Apple Silicon. A Live 11 patch update is not a reason to block
  work; investigate actual failures.

## Rules

- **No backwards-compatibility code.** The app is in development. Fix forward
  and make clean breaks; do not keep legacy paths.
- **No code sprawl.** Extend existing code before adding new code.
