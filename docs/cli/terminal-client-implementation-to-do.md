# Terminal Client Implementation To-Do

Companion specification: [Terminal Client](terminal-client.md)

## CLI foundation

- [ ] Scaffold `apps/cli` with a testable command parser.
- [ ] Connect it to the shared headless application bootstrap.
- [ ] Implement TTY detection, `NO_COLOR`, and redirected-output behavior.
- [ ] Implement human, quiet, and JSON output writers.
- [ ] Define and document stable exit-code mapping.

## Interactive client

- [ ] Implement line-oriented chat with streamed assistant output.
- [ ] Render operation start, progress, completion, and failure events.
- [ ] Implement `/help`, `/status`, `/connect`, `/snapshot`, `/mode`,
  `/session`, `/verbose`, `/cancel`, `/doctor`, and `/exit`.
- [ ] Implement interactive approval, denial, and detail inspection.
- [ ] Handle Ctrl+C as cancellation first and process exit second.
- [ ] Support session selection and resume.

## Non-interactive client

- [ ] Implement `run`, `status`, `doctor`, `capabilities`, and `snapshot`.
- [ ] Implement explicit non-interactive approval policies.
- [ ] Return structured JSON operation and final-result data.
- [ ] Ensure diagnostics avoid model invocation where possible.

## Tests

- [ ] Unit-test argument parsing, invalid input, and exit codes.
- [ ] Unit-test event-to-terminal rendering.
- [ ] Snapshot representative plain and colored transcripts.
- [ ] Integration-test interactive prompts with fake input/output adapters.
- [ ] Integration-test one-shot commands against the simulated Remote Script.
- [ ] Test interruption, denial, timeout, disconnect, and agent failure.
- [ ] Add an opt-in real-Live smoke command.

## Exit criteria

- [ ] CLI proves the full minimum interaction contract.
- [ ] All initial tools can be exercised without Electron.
- [ ] Output is deterministic and useful in CI.
- [ ] React requirements can reference stable CLI-proven events and actions.

