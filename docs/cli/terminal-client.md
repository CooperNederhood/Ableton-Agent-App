# Terminal Client

## Purpose

The CLI/TUI is the reference and minimum-complete interface to the Ableton
Agent App's headless core. It serves five purposes:

1. Prove core agent and bridge functionality before the desktop UI is mature.
2. Provide fast smoke tests and development diagnostics.
3. Offer a lightweight keyboard-first chat workflow.
4. Remain a fallback client when Electron or renderer-specific functionality is
   unavailable.
5. Define and verify the essential interaction contract that the React UI
   includes and enhances.

It must share production application services rather than becoming a parallel
prototype with duplicated tools or connection logic. The React UI is expected
to support all essential interactions documented here, while adding visual and
structured ways to perform them.

“React builds on the CLI” does not mean that React launches the terminal
program. The CLI proves the shared interaction contract; both clients call the
same headless services.

## Technology

Use Node.js and strict TypeScript in `apps/cli`. Start with:

- Standard terminal input/output.
- A repository-owned terminal presentation layer.
- `marked` for Markdown tokenization.
- `cli-table3`, `string-width`, and `wrap-ansi` for adaptive tables and
  ANSI-safe terminal-width layout.
- A testable prompt abstraction.
- Shared `AppEvent` rendering.
- The same Node.js Copilot SDK and application bootstrap used by Electron.

Do not adopt a full-screen TUI framework for the reference client. A rich,
line-oriented transcript preserves normal terminal scrollback, copy/paste,
resizing, SSH/tmux behavior, redirected output, and transcript tests. Reassess
Ink or another framework only if the terminal product later requires
persistent panes or keyboard-navigable project browsers that justify overlap
with the Electron UI.

## Modes

### Interactive chat

```bash
ableton-agent
```

Starts or resumes a session, connects to Live, and opens a prompt loop.

### One-shot prompt

```bash
ableton-agent run "summarize the current arrangement"
```

Runs one prompt, waits for the agent to become idle, prints the result, and
returns a stable exit code.

### Diagnostics

```bash
ableton-agent doctor
ableton-agent status
ableton-agent capabilities
ableton-agent snapshot --summary
```

These commands should work without invoking the model where possible.

## Interactive commands

Initial slash commands:

- `/help`
- `/status`
- `/connect`
- `/snapshot`
- `/mode explore|compose|arrange|sound|mix`
- `/session new`
- `/session resume <id>`
- `/verbose on|off`
- `/cancel`
- `/doctor`
- `/exit`

Slash commands invoke application services directly. Ordinary input is sent to
the active Copilot session.

## Event rendering

Map shared application events to compact terminal output:

| Event | Default rendering |
|---|---|
| Assistant delta | Stream text inline |
| Operation started | `• Inspecting arrangement...` |
| Operation completed | `✓ Inspected 6 tracks` |
| Operation failed | `✗ Device load failed: item unavailable` |
| Approval requested | Interactive prompt with summary |
| Connection changed | Status line |
| Snapshot changed | Hidden unless verbose |

Assistant Markdown is rendered as semantic terminal blocks:

- Styled headings, emphasis, lists, quotations, links, and code blocks.
- Width-aware tables in sufficiently wide terminals.
- Labeled row records when a table cannot retain useful column widths.
- Terminal-width-aware wrapping based on visible width rather than ANSI bytes.
- Model-provided terminal control sequences are removed before rendering.

Streaming commits complete Markdown blocks and buffers only the unfinished
paragraph, table, or code fence. It does not repeatedly redraw transcript
history.

The renderer must handle non-TTY output. Rich formatting is used only for an
interactive TTY. Redirected output remains deterministic plain Markdown/text
without cursor movement or ANSI codes. `NO_COLOR` disables color while
retaining structural layout.

## Approvals

Interactive mode presents approve, deny, and view-details choices. One-shot
mode defaults to denying actions that require approval unless the caller
provides an explicit policy flag.

Examples:

```bash
ableton-agent run "rename track one to Bass" --approve reversible
ableton-agent run "delete all empty tracks" --approve none
```

Broad or destructive approval should not be grantable through an ambiguous
blanket `--yes` flag.

## Output formats and exit codes

Support:

- Human-readable terminal output.
- `--json` for structured automation output.
- `--quiet` for final-result-only output.

Initial exit codes:

- `0`: completed successfully.
- `2`: invalid CLI input.
- `3`: Ableton connection or compatibility failure.
- `4`: approval denied or required in non-interactive mode.
- `5`: agent/tool operation failed.
- `130`: interrupted by the user.

## Architecture

```text
CLI argument/parser and prompt loop
              │
              ▼
shared application bootstrap
  ├── CopilotService
  ├── AgentSessionService
  ├── AbletonConnectionService
  ├── ApprovalService
  ├── ProjectStateService
  └── ChangeSetService
              │
              ▼
shared AppEvent stream → terminal renderer
```

The CLI package may depend on shared application packages. Desktop packages
must not depend on the CLI.

## Testing

- Unit-test argument parsing and exit-code mapping.
- Inject fake prompt, output, and application-service adapters.
- Snapshot stable human-readable transcripts.
- Test wide and narrow terminal layouts, including adaptive table fallback.
- Split streamed Markdown at arbitrary chunk boundaries.
- Reject model-provided ANSI and terminal control sequences.
- Assert structured JSON output directly.
- Test TTY and redirected-output behavior.
- Run one-shot smoke tests against the simulated Remote Script in CI.
- Maintain an optional real-Live smoke command for local release validation.

## Delivery order

Build the CLI before the rich renderer:

1. Basic Copilot SDK chat.
2. Connection/status commands.
3. Shared custom tools.
4. Streaming operation events.
5. Approvals.
6. Session resume.
7. JSON output and smoke-test commands.

Once these work, the Electron UI can reuse proven services and focus on richer
visual workflows rather than debugging the underlying agent loop. A capability
is not considered fully integrated into the product if the desktop chat
experience cannot represent its progress, approval, result, and failure state.
