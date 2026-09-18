---
name: desktop-ux-testing
description: Drive the visible Ableton Agent desktop app through its debug MCP tool and inspect the app and Ableton Live with computer-use.
---

# Ableton Agent desktop UX testing

Use this skill for end-to-end UX diagnosis that must exercise the real Electron
renderer and the real selected production agent.

## Launch

1. Build the workspace:

   ```bash
   pnpm build
   ```

2. Choose an absolute isolated profile path and launch the app:

   ```bash
   PROFILE="$PWD/.test-artifacts/desktop-automation-profile"
   pnpm desktop:dev -- \
     --automation \
     --automation-profile "$PROFILE" \
     --automation-agent default \
     --automation-yolo
   ```

3. Configure the local stdio MCP server with this command and the same
   descriptor path:

   ```bash
   pnpm --filter @ableton-agent/debug-mcp dev -- \
     --descriptor "$PROFILE/automation-endpoint.json"
   ```

## Procedure

1. Confirm the visible app shows the requested selected agent and YOLO state.
2. Call `send_user_message` with one bounded plain-text request.
3. Use computer-use to inspect Ableton Agent while the request streams.
4. Use computer-use to inspect Ableton Live for the resulting state.
5. Capture screenshots only through computer-use.
6. Diagnose failures from the visible operation state, Desktop History trace,
   logs, and deterministic bridge reads rather than assistant prose alone.

## Safety

- Use only an isolated automation profile, never the normal desktop profile.
- Do not expose or copy the automation secret.
- The MCP tool targets only the currently selected agent.
- Treat tool success as message acceptance; verify the final result in the app
  and Ableton.
- Close the automation app before removing its specific isolated profile.
