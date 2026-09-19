---
name: desktop-ux-testing
description: Use after implementing or changing Electron UI, desktop interactions, approvals, progress/error presentation, or cross-app workflows that require visual end-to-end validation. Iteratively build, launch a dedicated Ableton instance and the visible app in automation mode, send a message through the debug MCP tool, inspect both apps with computer-use, and fix/retest failures. Do not use for the deterministic runner-owned workflow smoke suite.
---

# Ableton Agent desktop UX testing

Use this skill after implementing a feature whose correctness depends on the
real Electron renderer, the embedded production agent, visible application
state, or the interaction between Ableton Agent and Ableton Live.

## Required loop

Repeat this loop until the observed behavior matches the expected user
experience:

1. **Implement** the feature and add the narrowest deterministic regression
   coverage. Add or update component interaction and Electron Playwright tests
   when the behavior can be preserved as an automated UI regression.
2. **Build** the workspace so Electron main, preload, renderer, shared packages,
   and the MCP adapter reflect the current source.
3. **Launch Ableton** as a dedicated validation process. Never reuse or take
   control of a user's pre-existing Live process.
4. **Launch the app** in automation mode with an isolated profile and the agent
   definition and approval policy appropriate to the scenario.
5. **Message** the visible app through `send_user_message`.
6. **Wait** for the accepted turn to visibly leave its busy/running state. MCP
   success means only that Desktop accepted the message.
7. **Inspect** Ableton Agent and Ableton Live with computer-use. Capture
   screenshots when they help explain or prove the result.
8. **Close** only the app and Ableton processes started for this validation.
   Handle save/discard prompts explicitly; never silently discard user work.
9. **Fix** the root cause and add or refine regression coverage when the
   observed behavior is wrong.
10. **Repeat** from the build step with fresh processes. Do not trust stale
    Electron main, preload, Remote Script, or embedded Python modules.

## Launch commands

Build from the repository root:

```bash
pnpm build
```

Choose an absolute isolated profile path and launch the app:

```bash
PROFILE="$HOME/.ableton-agent/ux-test-profile"
pnpm desktop:dev -- \
  --automation \
  --automation-profile "$PROFILE" \
  --automation-agent default \
  --automation-yolo
```

The profile is created on first launch. Replace `default` with the definition
that owns the behavior under test.

The registered local stdio MCP server must use the same descriptor:

```bash
pnpm --filter @ableton-agent/debug-mcp dev -- \
  --descriptor "$PROFILE/automation-endpoint.json"
```

## Resolve and pin both application windows

Before the first inspection, call computer-use `list_apps` and resolve Ableton
Agent and Ableton Live independently. Do not assume a window title is a stable
application identity.

For a development build of Ableton Agent:

1. Find the row whose window title is `Ableton Agent`.
2. Record its returned app identity, app name, and numeric window ID.
3. Target the discovered app name, commonly `Electron`, together with that exact
   window ID for every subsequent Agent read or action.

For Ableton Live:

1. Find the row whose title is the runner-owned Set and whose app name is
   `Live`.
2. Record its numeric window ID separately.
3. Target `Ableton Live 11 Suite` together with that exact window ID. This
   project supports Live 11; never select an installed Live 12 instance.

Do not use a generic Electron or `com.ableton.live` bundle identifier when it
matches multiple applications. If an identity or window ID changes, call
`list_apps` again and repin both targets. Element indexes are snapshot-local;
re-read the relevant window after navigation, reload, startup transitions, or
identity errors.

## Inspection procedure

1. Inspect the pinned Agent window and confirm startup completed, Ableton is
   connected, the requested agent is selected, and the expected YOLO or
   approval state is visible.
2. Send one representative bounded user request through `send_user_message`.
   Preserve the returned message, trace, and correlation IDs.
3. Observe the submitted user turn, streaming response, operation rows,
   approvals, warnings, errors, and final ready state. Message acceptance does
   not prove that the renderer displayed it, the agent processed it, tools ran,
   or Ableton changed.
4. Inspect the separately pinned Ableton Live window for the exact expected
   track, device, clip, note, timing, routing, and playback result, plus the
   absence of unintended changes. Compare before and after state where
   possible.
5. Use Desktop History, Diagnostics, logs, and read-only bridge inspection to
   correlate the workflow with the captured IDs. Never treat assistant prose or
   pre-existing Ableton content as proof of success.
6. Prefer accessibility text for inspection. Capture computer-use screenshots
   when custom Electron or Live surfaces are not adequately exposed or when a
   visual artifact helps prove the result.

Classify the result explicitly:

- **Completed:** the message is visible, the correlated workflow completed, and
  Live contains the verified result.
- **Failed:** the workflow ran and exposed a failure.
- **Blocked:** startup, connection, agent selection, permissions, or another
  precondition prevented execution.
- **Inconclusive:** Agent or Live resembles the expected result, but the
  available evidence cannot attribute it to the submitted request.

## Visual success criteria

A desktop UX validation passes only when:

- the external message appears once in the correct selected-agent conversation;
- busy, streaming, approval, progress, completion, failure, and cancellation
  states are understandable and attributed to the correct agent;
- controls remain usable and no unexpected modal, crash, blank state, clipped
  content, or stale status appears;
- the visible final state in Ableton Agent agrees with Ableton Live;
- errors provide an actionable recovery path instead of success-shaped output;
  and
- screenshots and observations contain no exposed credentials or automation
  secrets.

## Escalate to deterministic integration testing

Visual inspection is insufficient when the requirement depends on exact MIDI
notes, clip or track counts, ordering, identity references, rollback, mutation
budgets, tool allowlists, protocol behavior, or postcondition verification.
Run the runner-owned `pnpm live:agent-smoke` scenario workflow for those
requirements. Use visual desktop testing afterward when the same change also
affects presentation or interaction.

## Process ownership and safety

- Use only an isolated automation profile, never the normal desktop profile.
- Do not expose or copy the automation secret.
- The MCP tool targets only the currently selected agent.
- Treat tool success as message acceptance; verify the final result in the app
  and Ableton.
- Record the exact Ableton and Desktop processes started for validation. Close
  only those processes; never use process-name-wide termination.
- Do not close, modify, save, or discard a Live Set that predates the validation
  run.
- Close the automation app before removing its specific isolated profile.
- If `remote-script/AbletonAgent/**` changed, fully restart the dedicated Live
  process before retesting so embedded Python cannot remain stale.
- Stop and report a precondition failure when the Agent shows startup,
  connection, snapshot, project, or agent-selection failure. Do not attribute
  existing Live content to the accepted message.
