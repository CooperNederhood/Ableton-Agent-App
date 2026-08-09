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

## Product modes

The UI should support task-oriented modes without creating separate products:

- **Explore:** inspect and understand the current Live set.
- **Compose:** generate or edit notes, rhythm, harmony, and motifs.
- **Arrange:** build sections and place clips on the timeline.
- **Sound:** browse, load, and shape instruments/effects.
- **Mix:** adjust levels, pan, devices, and comparative balance.

Modes influence visible controls, selected context, agent instructions, and
tool availability.

## Main workspace

Suggested layout:

```text
┌──────────────────────────────────────────────────────────────┐
│ Connection · Project · Mode · Model                         │
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

## Superset interaction model

Every essential CLI action has a React equivalent:

| Reference interaction | React enhancement |
|---|---|
| Type a prompt | Prompt composer with selected-context chips |
| Stream operation text | Expandable visual operation timeline |
| `/snapshot` | Navigable project outline |
| `/mode arrange` | Visible mode switcher and mode-specific workspace |
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

## Selection-aware interaction

Selections in the app become explicit prompt context:

- Selected track.
- Selected clip.
- Selected arrangement range.
- Selected device.
- Selected section in the production plan.

The UI should clearly show context chips before submission so users know what
the agent will act on.

## Plan and preview

Broad requests such as “turn this loop into a full arrangement” should produce
a visual plan before execution:

- Sections and bar ranges.
- Tracks affected.
- Proposed new clips/devices.
- Estimated operation count.
- Potential destructive changes.

Users can approve, edit, or narrow the plan.

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

## Terminal experience

The terminal client should preserve the essential interaction model:

```text
Ableton: connected · Live 12.1 · Project "Sketch 04"
Mode: Arrange

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
