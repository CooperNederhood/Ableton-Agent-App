# Terminal Client Implementation To-Do

Companion specification: [Terminal Client](terminal-client.md)

## CLI foundation

- [x] Scaffold `apps/cli` with a testable command parser.
- [x] Connect it to the shared headless application bootstrap.
  - [x] Wire Session clip launch, duplication, deletion, and property services
    through the bridge, application, agent tools, and approval UI.
  - [x] Wire Arrangement loop and cue-point services through the bridge,
    headless application, Copilot tools, and approval UI.
- [ ] Implement TTY detection, `NO_COLOR`, and redirected-output behavior.
- [ ] Implement human, quiet, and JSON output writers.
- [ ] Define and document stable exit-code mapping.

## Interactive client

- [x] Implement line-oriented chat with streamed assistant output.
- [x] Render operation start, progress, completion, and failure events.
- [~] Implement `/help`, `/status`, `/connect`, `/snapshot`, `/mode`,
  `/session`, `/verbose`, `/cancel`, `/doctor`, and `/exit`.
- [ ] Implement interactive approval, denial, and detail inspection.
- [ ] Handle Ctrl+C as cancellation first and process exit second.
- [ ] Support session selection and resume.

## Non-interactive client

- [x] Implement `run`, `status`, `doctor`, `capabilities`, `snapshot`, and
  bounded Arrangement `transport` inspection.
- [x] Implement one-based `devices` and `parameters` commands backed by bounded
  identity-bound regular-track inspection.
- [x] Implement explicit non-interactive approval policies.
- [x] Return structured JSON operation and final-result data.
- [x] Ensure diagnostics avoid model invocation where possible.

## Tests

- [x] Unit-test argument parsing, invalid input, and exit codes.
- [x] Unit-test event-to-terminal rendering.
- [ ] Snapshot representative plain and colored transcripts.
- [x] Integration-test interactive prompts with fake input/output adapters.
- [ ] Integration-test one-shot commands against the simulated Remote Script.
- [ ] Test interruption, denial, timeout, disconnect, and agent failure.
- [ ] Add an opt-in real-Live smoke command.

## Exit criteria

- [ ] CLI proves the full minimum interaction contract.
- [ ] All initial tools can be exercised without Electron.
- [ ] Output is deterministic and useful in CI.
- [ ] React requirements can reference stable CLI-proven events and actions.
