---
name: agent-ux-debug
description: Debug Ableton Agent requests with send_user_message and computer-use while reliably targeting both the Agent and Ableton Live 11 windows.
---

# Ableton Agent UX debugging

Use this skill to submit a request to the running Ableton Agent desktop app and
diagnose the real renderer and Ableton Live outcome.

## Resolve and pin both applications

Do not assume `Ableton Agent` is a stable computer-use app identity. The app is
an Electron process, and resolving it by its window title can select or launch
the wrong instance.

Call computer-use `list_apps` before the first inspection and resolve both
targets independently.

### Ableton Agent

1. Find the row whose window title is `Ableton Agent`.
2. Record its returned app identity, app name, and numeric window ID.
3. On development builds, target the discovered app name `Electron` together
   with that exact window ID.
4. Pass the same app/window pair to every subsequent Agent read and action.

On development builds, the discovered row may identify the process as
`Electron` even though the window title is `Ableton Agent`. Prefer the
discovered target over a guessed display name or bundle identifier. A generic
Electron bundle identifier may be ambiguous when multiple Electron apps are
installed.

### Ableton Live

1. Find the row whose title is the current Live Set, such as `Untitled`, and
   whose returned app name is `Live`.
2. Record its numeric window ID separately from the Agent window.
3. Target it using the installed product display name
   `Ableton Live 11 Suite` together with that exact window ID.
4. Do not assume the `Live` name or `com.ableton.live` bundle identifier will
   resolve correctly. Computer-use may report that `Live` is not installed or
   that the bundle identifier matches multiple installed Live versions.
5. This project supports Ableton Live 11 only; do not select an Ableton Live 12
   installation.

If computer-use reports that an app identity changed, a target cannot be
resolved, or a window ID changes unexpectedly, call `list_apps` again and
re-resolve both intended windows. Do not continue using stale element indexes.
Keep the Agent and Live app/window pairs separate throughout the workflow.

## Send one bounded request

1. Inspect the target Agent window first.
2. Confirm that desktop startup has completed, Ableton is connected, and an
   agent is selected.
3. Call `send_user_message` with one bounded, plain-text request.
4. Preserve the returned message, trace, and correlation IDs for diagnosis.

`send_user_message` success means only that the visible desktop app accepted
the message. It does not prove that the renderer displayed it, the selected
agent processed it, tools ran, or Ableton changed.

If the Agent window shows `Starting desktop services`, `Connecting`,
`Waiting for snapshot`, `No project`, or `No active agents`, report the
precondition failure. Do not attribute existing Ableton content to the accepted
message.

## Inspect the workflow

Use computer-use to inspect the same Agent window while the request runs:

- Verify the user's message appears in the conversation.
- Verify an operation or assistant response starts.
- Look for visible queued, running, completed, failed, or cancelled state.
- Inspect Desktop History or Diagnostics when the conversation does not explain
  the outcome.
- Correlate visible records with the IDs returned by `send_user_message`.

Element indexes are snapshot-local. Re-read the window before acting after a
navigation, reload, startup transition, or identity error.

Use accessibility text first. Capture screenshots through computer-use only
after the initial text read, particularly for Electron-rendered or custom-drawn
surfaces that accessibility does not expose completely.

## Verify Ableton Live independently

Use the separately pinned Ableton Live 11 app/window pair. Inspect Live for the
exact requested result, including track type, track name, devices, clips,
notes, timing, routing, and playback state where relevant.

Existing tracks or clips are not proof of success. Attribute a result to the
request only when the Agent conversation/history shows the corresponding
workflow and Live shows the expected final state. When possible, compare the
before and after Live state.

## Diagnose and report

Classify the result explicitly:

- **Completed:** the request is visible, the workflow completed, and Live
  contains the verified result.
- **Failed:** the workflow ran and exposed a failure.
- **Blocked:** startup, connection, agent selection, permissions, or another
  precondition prevented execution.
- **Inconclusive:** Live resembles the requested outcome, but the trace or
  conversation cannot establish attribution.

Report observable evidence rather than relying on assistant prose. Include the
Agent status, conversation/history state, Live state, and the specific reason
for the classification.

## Common pitfalls

- Addressing the app as `Ableton Agent` without first discovering its window.
- Confusing a window title with the process identity.
- Using `Live` as the computer-use application target and receiving a false
  "not installed" result.
- Using the ambiguous `com.ableton.live` bundle identifier when multiple Live
  installations are present.
- Mixing the Agent window ID with the Ableton Live window ID.
- Reusing an element index after the window or accessibility tree changed.
- Treating message acceptance as workflow completion.
- Inspecting only Ableton Live and attributing pre-existing content.
- Inspecting only the Agent response and not validating Live.
- Taking screenshots without first reading the accessibility tree.
- Continuing after `No active agents` or another visible startup failure.
