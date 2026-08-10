# Terminal Client Implementation To-Do

Companion specification: [Terminal Client](terminal-client.md)

## CLI foundation

- [x] Scaffold `apps/cli` with a testable command parser.
- [x] Connect it to the shared headless application bootstrap.
  - [x] Wire Session clip launch, duplication, deletion, and property services
    through the bridge, application, agent tools, and approval UI.
  - [x] Wire Arrangement loop and cue-point services through the bridge,
    headless application, Copilot tools, and approval UI.
- [x] Implement TTY detection, `NO_COLOR`, and redirected-output behavior.
- [x] Implement human, quiet, and JSON output writers.
- [x] Define and document stable exit-code mapping.

## Interactive client

- [x] Implement line-oriented chat with streamed assistant output.
- [x] Render assistant Markdown with terminal-width-aware headings, lists,
  emphasis, code, and adaptive tables.
- [x] Incrementally commit complete streamed Markdown blocks without redrawing
  transcript history or duplicating the final response.
- [x] Add a rich TTY transcript shell with connection, Live-version, and
  session context while preserving plain redirected output.
- [x] Render structured approval metadata and readable nested arguments.
- [x] Render operation start, progress, completion, and failure events.
- [~] Implement `/help`, `/status`, `/connect`, `/snapshot`, `/mode`,
  `/session`, `/verbose`, `/cancel`, `/doctor`, and `/exit`.
- [x] Implement interactive approval, denial, and detail inspection.
- [~] Handle Ctrl+C as cancellation first and process exit second. (Ctrl+C
  now reliably exits with code 130 from any mode; it does not yet attempt a
  graceful in-flight operation cancellation before exiting.)
- [x] Support session selection and resume.

## Non-interactive client

- [x] Implement `run`, `status`, `doctor`, `capabilities`, `snapshot`, and
  bounded Arrangement `transport` inspection.
- [x] Implement one-based `devices` and `parameters` commands backed by bounded
  identity-bound regular-track inspection.
- [x] Implement paginated one-based rack-chain, chain-device, Drum Rack pad,
  pad-chain, and pad-chain-device read commands.
- [x] Implement Browser root/category inspection, bounded deterministic search,
  and explicitly approved selection-by-result built-in loading.
- [x] Implement explicit non-interactive approval policies.
- [x] Return structured JSON operation and final-result data.
- [x] Ensure diagnostics avoid model invocation where possible.

## Tests

- [x] Unit-test argument parsing, invalid input, and exit codes.
- [x] Unit-test event-to-terminal rendering.
- [x] Snapshot representative plain and colored transcripts.
- [x] Integration-test interactive prompts with fake input/output adapters.
- [x] Integration-test one-shot commands against the simulated Remote Script.
- [~] Test interruption, denial, timeout, disconnect, and agent failure.
  (Interruption, denial, and disconnect are covered; timeout and generic
  agent-failure paths are not yet tested.)
- [x] Add an opt-in real-Live smoke command.
- [x] Test Markdown rendering, narrow table fallback, wrapping, streamed block
  boundaries, rich command output, and terminal control-sequence removal.

## Exit criteria

- [x] CLI proves the full minimum interaction contract.
- [x] All initial tools can be exercised without Electron.
- [x] Output is deterministic and useful in CI.
- [x] React requirements can reference stable CLI-proven events and actions.
