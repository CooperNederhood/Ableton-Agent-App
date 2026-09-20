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
│ Connection · Project · Active Agent                         │
├──────────────────┬───────────────────────────┬───────────────┤
│ Project outline  │ Conversation / operation  │ ◉ ☑ +         │
│ Tracks/sections  │ timeline                  │ Inspector     │
│ Context · Refresh│                           │ view panes    │
├──────────────────┴───────────────────────────┴───────────────┤
│ Prompt composer                 interactive            ↑     │
└──────────────────────────────────────────────────────────────┘
```

The conversation/operation timeline is the graphical form of the reference
CLI chat experience. The surrounding project outline, inspector, context
controls, and plan/change views progressively enhance it.

The workspace opens as three columns without repeated Project, Conversation,
or Inspector heading rows. The Project and Inspector columns each have an
independent, subtle icon control at the workspace edge, and the connection
header plus application tabs can be hidden as one top-chrome region.
These visibility choices are intentionally transient and reset on launch. The
composer belongs exclusively to the Workspace center conversation column,
expanding with it when either sidebar is hidden so users can isolate chat
without losing input. Agents, Outputs, Events, Browser, Profiles, Diagnostics,
Sessions, and Settings use their full content area without a chat composer.
The global focus-composer shortcut returns to Workspace before focusing the
saved draft, and incoming questions or plan approvals return to Workspace so a
blocking interaction is never hidden on a management tab.
The Project and Inspector edges are pointer-draggable. The Project sidebar
retains a bounded maximum, while the Inspector may expand through all workspace
width available after the visible Project sidebar and minimum usable
conversation column are reserved. Each sidebar retains its selected width while
hidden and reopened, and widths reset when the desktop app restarts. Hide/show
buttons remain the keyboard-accessible sidebar controls; the resize edges do
not add separate keyboard controls.
Project refresh sits beside the project-selection context switch so the only
remaining project toolbar action is adjacent to the state it refreshes.

Assistant turns are borderless, left-aligned reading content. User turns are
compact right-aligned cards. Interactive user cards use a gray outline and
surface; plan user cards use a blue outline and surface plus the textual
`plan` label. Older history without mode metadata is rendered as interactive.
Neither role needs a repeated textual label in every turn; streaming state
remains announced. This distinction must remain semantic and must not rely on
color alone.

An active assistant turn begins with a compact **Working** disclosure before
final answer text is available. It remains expanded while work is running,
shows concise model-provided reasoning summaries when enabled, and may also
show intent and safe progress text. It collapses automatically after
completion, failure, cancellation, or timeout and remains manually reopenable.
The disclosure does not expose hidden chain-of-thought, raw provider fragments,
tool arguments, or byte counters; detailed tool activity remains in the typed
operation rows. Incremental updates are frame-batched without waiting for the
final assistant message.

Each active agent also owns an interaction mode. `/plan` enters plan mode
without creating a chat turn, and Shift+Tab toggles between plan and
interactive modes for the selected agent. The ordinary composer uses a compact
bottom action row: the current mode is a low-emphasis text button and the
send/stop action is a small circular semantic icon button.
User turns submitted in plan mode use a distinct card treatment and a compact
textual `plan` label so the distinction does not depend on color. Messages
submitted through the isolated automation endpoint inherit and display the
selected agent's effective mode rather than defaulting to interactive.

Planning interaction replaces the ordinary composer in place while preserving
the visible conversation timeline and the user's unsent message draft.
Takeover priority is structured elicitation, pending plan approval/change
feedback, manual Markdown editing, then the ordinary prompt composer. The
controls use schema-driven text, choice, multi-choice, boolean, and numeric
fields and remain a back-and-forth human-in-the-loop conversation. Single
choice fields show all named options as radios. Agent `ask_user` choices append
an always-visible custom text entry, while unrelated strict schema enums remain
restricted to their declared values. The question panel grows with its content
up to a bounded viewport height and has an accessible top-edge resize handle
for temporary session-local adjustment.

The Inspector is a modular workspace. Selection, Plan, and Approval views
appear as compact icon tabs only while their content exists. Tabs can be
reordered, moved between panes, or dropped at a pane edge to create a vertical
split. Split panes begin at uniform heights, resize with horizontal dividers,
and scroll independently. Closing a tab makes it available from the `+` menu;
newly available views open automatically. This layout is transient and resets
when the app launches.

The Plan view is a read-only rendering of the production session's canonical
`plan.md`. Its Edit Markdown action opens a large editor in the composer area
and saves through the same revision-checked artifact API used by the agent.
Approval, request-changes feedback, and exit-only controls also live in the
composer, but the SDK's plain-text plan summary is not duplicated there; the
Inspector is the plan review surface. Until interactive approval is recorded,
Ableton mutations remain blocked even when ordinary mutation auto-approval is
enabled. Duplicate submissions are disabled, stale revisions remain visible
with an actionable error, and only normalized actions offered by the SDK
request are rendered.

Settings exposes the agent's cumulative active-work timeout in minutes. It
defaults to 10 minutes, accepts values from 1 through 120, applies to subsequent
turns without restarting Desktop, and excludes time spent waiting for
elicitation, plan review, or tool approval.
Settings also exposes a global Agent reasoning visibility control with Off,
Concise, and Detailed choices. Concise is the default. Changes apply before
each active agent's next turn without replacing its conversation.

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

The production session owns one shared plan document, while pending approval
and elicitation requests remain attributed to the active agent and SDK session
that initiated them. Completing a plan reveals the Inspector automatically and
replaces the composer with approve-and-continue, request-changes, or exit-only
controls. Autopilot and fleet actions remain hidden. Main-process event
delivery, preload validation, typed artifact/edit/elicitation IPC, and composer
takeover are covered together in the Electron harness; application-owned
success, failure, stale, duplicate, cancellation, and isolation branches remain
deterministically unit-tested.

Plan content remains stored and transported as sanitized model- or user-authored
GitHub-Flavored Markdown. The Inspector applies one narrow presentation-only
cleanup when a single-line plan contains multiple unmistakable bold labeled
section markers such as ` - **Intro:**`: those markers become Markdown bullets,
and labeled `Implementation:` or `Verification:` text becomes a separate
section. Existing multiline Markdown and unrelated one-line prose remain
unchanged. Approval IPC and History retain the original raw plan text.

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
