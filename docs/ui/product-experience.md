# Product Experience

The product has a layered presentation model:

1. The CLI/TUI is the minimum-complete, reference interface to the agent.
2. The Electron/React interface includes that complete conversational
   experience and adds project visualization and production workflows.

The React UI is therefore a product superset of the CLI/TUI. Both consume the
same application event model and invoke the same application services, so core
agent behavior must not diverge.

React should not shell out to the CLI or reuse terminal rendering components.
The reusable layer is the headless interaction contract and application core.

## Active agents

The UI switches among active custom-agent instances. Canonical definitions
include:

- **Default:** general inspection and editing.
- **Compose:** generate or edit notes, rhythm, harmony, and motifs.
- **Arrange:** build sections and place clips on the timeline.
- **Sound:** browse, load, and shape instruments/effects.
- **Mix:** adjust levels, pan, devices, and comparative balance.

Multiple instances may use the same definition and retain independent
conversation histories. Selecting an active agent changes the conversation,
composer target, activity, approvals, and cancellation target. Agent-specific
placeholder panels are not part of the initial custom-agent release.

## Main workspace

Suggested layout:

```text
┌──────────────────────────────────────────────────────────────┐
│ Connection · Project · Active Agent · Model                 │
├──────────────────┬───────────────────────────┬───────────────┤
│ Project outline  │ Conversation / operation  │ Inspector     │
│ Tracks/sections  │ timeline                  │ Selection     │
│                  │                           │ Plan/changes  │
├──────────────────┴───────────────────────────┴───────────────┤
│ Prompt composer · context chips · approval controls          │
└──────────────────────────────────────────────────────────────┘
```

The conversation/operation timeline is the graphical form of the reference
CLI chat experience. The surrounding project outline, inspector, context
controls, and plan/change views progressively enhance it.

The workspace opens as three columns. The Project and Inspector columns each
have an independent accessible toggle in the conversation heading, and the
connection header plus application tabs can be hidden as one top-chrome region.
These visibility choices are intentionally transient and reset on launch. The
composer belongs to the center conversation column, expanding with it when
either sidebar is hidden so users can isolate chat without losing input.

Assistant turns are borderless, left-aligned reading content. User turns are
compact right-aligned cards. Neither role needs a repeated textual label in
every turn; streaming state remains announced. This distinction must remain
semantic and must not rely on color alone.

Each active agent also owns an interaction mode. `/plan` enters plan mode
without creating a chat turn, and Shift+Tab toggles between plan and
interactive modes for the selected agent. The composer shows the current mode.
User turns submitted in plan mode use a distinct card treatment and a compact
textual `plan` label so the distinction does not depend on color.

## Events

The top-level **Events** view manages user-defined observations of Live. Event
creation prioritizes current context:

- **Watch selected parameter** creates a continuous parameter event.
- **Watch selected track** presents playing clip, triggered clip, and recording
  transitions first.
- **Browse all event types** provides a bounded fallback picker.

Events are grouped by track and use the track's color without relying on color
alone. Cards show current state, resolution, continuous/discrete classification,
and listening agents. A bounded **Recent activity** disclosure is hidden by
default.

Active-agent editing provides a Skills-style **Listening Events** selector.
Each selected event has an `Automatic` or `Next prompt` response mode and
an optional message prefix.

## History

The top-level **History** surface queries the local detailed event journal. It
shows sanitized agent configuration changes, SDK and tool/workflow lifecycle,
Live Event traces, and Output deliveries. Live Events and Outputs use the same
trace and query infrastructure but remain distinct categories and link back to
their own product surfaces.

Users can filter by time, category, lifecycle stage, outcome, active agent,
Live Event, Output, tool, session, trace ID, or correlation ID. Selecting a
record opens a redacted trace view with parent/child stages and timing. The UI
must clearly distinguish no matches, history removed by retention, capture
paused, incomplete/dropped traces, and journal unavailable.

History uses bounded cursor pages, virtualized results, cancellable stale
queries, and on-demand details. The renderer never receives raw SQL, a database
path, or unsanitized payloads.

## Superset interaction model

Every essential CLI action has a React equivalent:

| Reference interaction | React enhancement |
|---|---|
| Type a prompt | Prompt composer with selected-context chips |
| Stream operation text | Expandable visual operation timeline |
| `/snapshot` | Navigable project outline |
| Select an active agent | Visible active-agent selector and independent workspace |
| Terminal approval | Visual change preview and approval panel |
| `/status` and `/doctor` | Connection and diagnostics views |
| Text arrangement plan | Editable section/timeline plan |
| Text device details | Device and parameter inspector |

New React interactions should resolve into shared context updates, application
service calls, or agent prompts. They must not create a second implementation
of Ableton operations.

## Agent activity

Display structured activity rather than hidden tool calls:

- Inspecting arrangement.
- Creating clip.
- Adding 32 notes.
- Loading Wavetable.
- Setting filter cutoff.
- Verifying section placement.

Users can expand an operation to inspect parameters, warnings, and affected
objects. Internal protocol details remain hidden by default.

In the conversation timeline, activity defaults to a muted one-line row with a
small icon for its broad type, such as Ableton, search/read, terminal, edit,
agent, or generic activity. Long tool names and previews truncate rather than
expanding the row. Status remains textual, and recovery details, warnings,
retry, and undo remain available in the disclosure.

## Selection-aware interaction

Selections in the app become explicit prompt context:

- Selected track.
- Selected clip.
- Selected arrangement range.
- Selected device.
- Selected section in the production plan.

The UI should clearly show context chips before submission so users know what
the agent will act on. The composer sends those chips atomically with each
managed-agent message or explicit skill invocation. Turning project selection
context off excludes generated track, clip, and device chips from that turn,
while explicitly pinned chips remain. A later selection replaces the generated
selection from the prior turn.

## Plan and preview

Broad requests such as “turn this loop into a full arrangement” should produce
a visual plan before execution:

- Sections and bar ranges.
- Tracks affected.
- Proposed new clips/devices.
- Estimated operation count.
- Potential destructive changes.

Users can approve, edit, or narrow the plan.

SDK completed plans appear in the right Inspector for the selected active
agent. The panel presents the bounded plan content and only three product
actions: approve and continue interactively, request changes with feedback, or
exit plan mode without implementation. Autopilot and fleet actions advertised
by the SDK remain hidden. Opening a completed plan reveals the Inspector
automatically, while plan state and responses remain isolated by active-agent
instance.

## Recovery UX

Every mutation operation should expose:

- Completed, partially completed, or failed status.
- What changed.
- What did not change.
- Warnings.
- Undo or compensating action when available.
- A retry action when safe.

## Accessibility and performance

- Keyboard-first navigation.
- Proper focus handling and semantic controls.
- No dependence on color alone for status.
- Virtualized long activity and browser lists.
- Throttled rendering of streaming events.
- UI remains responsive during model and Ableton operations.
- History's first filtered page meets 200 ms p95 at the 250 MiB journal cap on
  the supported baseline and does not regress SDK streaming or event delivery.

## Terminal experience

The terminal client should preserve the essential interaction model:

```text
Ableton: connected · Live 12.1 · Project "Sketch 04"
Agent: Arrange

You: turn the selected four-bar loop into a 16-bar intro

  ✓ Inspected selected tracks
  • Planning arrangement...
  ! Approval required: place 8 clips across 3 tracks
    [a]pprove  [d]eny  [v]iew plan

Assistant: I created a sparse 16-bar intro and verified all clip positions.
```

It should support:

- Streaming assistant text.
- Compact and verbose operation views.
- Interactive approval prompts.
- Slash commands for connection, snapshot, mode, sessions, diagnostics, and
  exit.
- Optional context selectors expressed as command arguments.
- Non-interactive output suitable for smoke tests and scripts.

The first implementation may use plain ANSI output and line-oriented prompts.
Adopt a full-screen TUI framework only if it improves usability without making
the client harder to test or maintain.
