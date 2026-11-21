# Ableton Agent docs

A guide for engineers new to this repo. Each page explains one part of the
app: what it is, why it exists, how it works, and where the code lives.

For setup and install steps, see the [root README](../README.md).

## Reading order

| Page | Read it to learn |
| --- | --- |
| [Overview](overview.md) | What the app does and how one user message becomes a change in Live |
| [Architecture](architecture.md) | The repo map: every app and package, and how they depend on each other |
| [Agent](agent.md) | How the Copilot SDK agent is set up: custom agents, skills, hooks, approvals |
| [Tools](tools.md) | How Ableton tools are defined and what families exist |
| [Live connection](live-connection.md) | How the app talks to Live: bridge, protocol and Remote Script |
| [Listening](listening.md) | How the agent hears audio through Max for Live devices |
| [Live events](live-events.md) | Watching Live for changes and delivering them to agents |
| [Project state](project-state.md) | Set snapshots, Set history and stored context |
| [Safety](safety.md) | Risk levels, approvals and undo |
| [Desktop app](desktop-app.md) | The Electron app and its screens |
| [CLI](cli.md) | The terminal client |
| [Storage](storage.md) | What the app stores on disk and where |
| [Observability](observability.md) | Where logs and events go, and how to debug a failed session |
| [Packaging](packaging.md) | Building and installing the app, Remote Script and Max devices |
| [Testing](testing.md) | The three test layers and when to use each |

## Decisions

Short records of the big architectural choices, in `decisions/`:

| ADR | Decision |
| --- | --- |
| [0001](decisions/0001-electron-security-boundary.md) | Electron main owns everything privileged; the renderer is sandboxed |
| [0002](decisions/0002-loopback-framed-tcp.md) | The app talks to Live over authenticated local TCP |
| [0003](decisions/0003-sqlite-application-metadata.md) | App data lives in local SQLite |
| [0004](decisions/0004-typescript-python-schema-ownership.md) | TypeScript schemas are canonical; Python mirrors them |
| [0005](decisions/0005-desktop-automation-mcp-adapter.md) | Debug-only MCP adapter for driving the desktop app |
| [0006](decisions/0006-playback-listening-and-entity-context.md) | Listening uses real-time Max for Live devices |

## Keeping these docs useful

These pages describe how things work now. They are not a changelog, a test
log or a to-do list; those belong in pull requests, issues and git history.
When you change how something works, update the page that explains it.
