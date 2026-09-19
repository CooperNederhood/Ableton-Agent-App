# 0005: Debug-only desktop automation through an MCP adapter

## Status

Accepted

## Context

Copilot coding agents can launch Ableton Live and the Ableton Agent desktop app
and inspect their windows with computer-use. They also need to submit a user
message into the already running, visible desktop session so UX and Live
behavior can be diagnosed end to end.

Electron IPC is private to the trusted renderer and must not be exposed to
external processes. The CLI cannot substitute for the desktop app because it
creates a separate application composition and conversation. Embedding a broad
network MCP server in the product would add unnecessary protocol and security
surface to normal launches.

## Decision

The desktop app supports an explicit `--automation` launch mode with an
isolated Electron user-data profile. In that mode only, Electron main starts an
authenticated ephemeral loopback endpoint and writes owner-only discovery and
secret files below the automation profile.

A separate local stdio MCP adapter reads those files and exposes one tool:
`send_user_message`. The endpoint accepts only a bounded plain-text message and
submits it to the currently selected agent through the same desktop service
instance used by the visible renderer. Startup flags select or create an agent
definition and optionally enable YOLO inside the isolated profile.

The submitted message is emitted as a typed desktop event so the renderer shows
it as a normal attributed user turn. Agent streaming, operations, approvals,
and Ableton mutations continue through the existing runtime.

Computer-use remains responsible for screenshots and UI interaction. The MCP
adapter does not expose renderer evaluation, arbitrary IPC, filesystem access,
history reads, cancellation, agent switching, or preference mutation.

## Consequences

- Normal desktop launches expose no automation listener or discovery files.
- Debug runs cannot alter the normal desktop profile.
- MCP dependencies remain outside the desktop product core.
- The adapter reports message acceptance, not fictional turn completion;
  Copilot observes progress and results in the real UI.
- The loopback endpoint requires versioned schemas, bounded framing,
  per-launch authentication, cleanup, lifecycle telemetry, and regression
  coverage.
