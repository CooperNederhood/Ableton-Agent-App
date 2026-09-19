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
   coverage.
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

## Inspection procedure

1. Confirm the visible app selected the requested agent and shows the expected
   YOLO or approval state.
2. Send one representative bounded user request through `send_user_message`.
3. Observe the submitted user turn, streaming response, operation rows,
   approvals, warnings, errors, and final ready state.
4. Inspect Ableton Live for the expected visible result and absence of
   unintended changes.
5. Use Desktop History, logs, and read-only bridge inspection to diagnose what
   happened. Never treat assistant prose as proof of success.

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
