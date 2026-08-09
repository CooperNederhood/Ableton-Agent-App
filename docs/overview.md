# Ableton Agent App

## Vision

Ableton Agent App is a desktop companion for Ableton Live that combines a
purpose-built music-production interface with an agent powered by the GitHub
Copilot SDK.

The product is not a generic chat client and is not primarily an MCP server. It
is an Ableton-specific application whose agent can inspect a Live set, propose
changes, execute validated production operations, explain its work, and help a
user move from an idea to a finished arrangement. It includes both a rich
desktop interface and a lightweight CLI/TUI chat client.

The project will reuse the strongest ideas and feature coverage found in the
existing `ableton-mcp` and `ableton-mcp-extended` projects while replacing their
MCP-first architecture with:

- A first-class Copilot SDK agent runtime.
- Typed, application-native Ableton tools.
- A robust local protocol between the desktop app and Ableton Live.
- A small Remote Script that owns all Live Object Model access.
- A frontend designed around production workflows rather than generic tool
  invocation.
- A lightweight terminal client for early development, smoke testing,
  diagnostics, automation, and users who prefer a keyboard-first workflow.

## Core architecture

```text
┌──────────────────────────────────────────────────────────────┐
│ Ableton Agent App                                           │
│                                                              │
│  React UI: CLI interaction contract + visual workflows      │
│                           │                                  │
│  CLI/TUI: reference/minimum agent interface                 │
│                           │                                  │
│                 headless application core                   │
│                           │                                  │
│           Copilot SDK runtime + typed tools                  │
│                                  │                           │
│                           Ableton bridge                     │
└──────────────────────────────────┬───────────────────────────┘
                                   │
                    authenticated local IPC
                                   │
┌──────────────────────────────────▼───────────────────────────┐
│ Ableton Live                                                 │
│                                                              │
│  Remote Script ── main-thread command executor ── LOM        │
└──────────────────────────────────────────────────────────────┘
```

The Copilot SDK process cannot directly access Ableton's Live Object Model
(LOM). The LOM is available only inside Ableton's embedded Python runtime.
Therefore, the Remote Script remains an essential process boundary even though
the MCP layer is removed.

## Key implementation decisions

### Desktop application

Use Electron, React, Vite, and strict TypeScript.

Electron is the initial choice because the Node.js Copilot SDK can run directly
in the Electron main process, while React provides a productive UI layer. The
renderer never receives direct filesystem, credential, Copilot, or Ableton
socket access; it communicates through a narrow, typed Electron IPC API.

The React product is a functional superset of the terminal experience. It
contains the same basic chat, streaming progress, approval, cancellation,
session, and diagnostic capabilities, then adds Ableton-specific visual
interaction such as track selection, arrangement planning, device inspection,
change previews, and direct manipulation.

This is a product and interaction hierarchy, not a dependency on terminal
rendering code. React and the CLI both consume the same headless application
core and interaction contracts.

### CLI/TUI client

Ship a lightweight Node.js terminal client early in development. It uses the
same application services, Copilot SDK session configuration, tool registry,
approval policy, Ableton bridge, and event model as the desktop app.

The CLI is not a separate implementation of the agent. It is the reference and
minimum-complete interface to the headless agent core. It defines the essential
interaction contract that the React UI must include and enhance:

- Interactive chat with streaming assistant output.
- Visible tool and operation progress.
- Terminal approval prompts.
- Connection and capability diagnostics.
- Scriptable one-shot prompts for smoke tests.
- A fallback interface when the desktop renderer is unavailable.

Essential agent functionality must remain operable through this contract.
React-only functionality should normally provide richer visualization,
selection, structured input, or direct interaction rather than separate agent
behavior.

### Agent runtime

Use the Node.js GitHub Copilot SDK with:

- Custom Ableton tools defined in application code.
- A production-focused system message and optional specialized sub-agents.
- Streaming session events rendered as visible progress.
- Session persistence for ongoing projects.
- Hooks for safety policy, audit logging, result normalization, and project
  context injection.
- An explicit tool allowlist so the music agent is not accidentally given
  unrelated shell or coding capabilities.

### Ableton integration

Use a dependency-free Python Remote Script loaded by Ableton Live. It will:

- Bind only to loopback.
- Authenticate the desktop app during connection setup.
- Decode framed, versioned requests.
- Validate commands and parameters.
- marshal all LOM access onto Ableton's main thread.
- Return structured results and emit selected Live-set change events.

### Protocol

Replace the current “read bytes until JSON parses” protocol with a versioned,
length-prefixed message envelope. Every request has a request ID and receives
exactly one response. The protocol also supports unsolicited events from Live.

### Tool design

Tools are split into two layers:

1. **Primitive tools** expose reliable Ableton operations such as reading a
   project snapshot, creating a track, editing a clip, or setting a parameter.
2. **Workflow tools** implement deterministic production transactions such as
   creating a drum pattern, laying out a section, or applying a mix change set.

The model decides intent and chooses operations; deterministic code performs
multi-step mutations, validation, rollback where possible, and verification.

### State and safety

The app maintains an explicit project model rather than relying only on chat
history. Mutating actions generate change-set records and are grouped into
user-visible operations. Destructive or broad changes require approval.

The agent should follow:

```text
inspect → plan → preview/approve when needed → execute → verify → report
```

### Testing

The system is tested at multiple boundaries:

- Pure unit tests for schemas, transforms, and workflows.
- Protocol contract tests shared by TypeScript and Python.
- A simulated Remote Script server for fast integration tests.
- Remote Script tests using mocked LOM objects.
- A small real-Ableton compatibility suite.
- Electron end-to-end tests for critical user workflows.
- CLI integration and snapshot tests for chat, progress, approvals, failures,
  and non-interactive commands.

## Core pieces

The detailed execution sequence and links to every component checklist are in
the [Implementation Workplan](implementation-workplan.md).

| Piece | Responsibility | Detailed plan |
|---|---|---|
| System architecture | Boundaries, dependency direction, runtime topology | [Architecture](architecture/system-architecture.md) |
| Desktop application | React superset of the reference agent interaction contract | [Application](application/desktop-application.md) |
| CLI/TUI client | Reference/minimum interface to the headless agent core | [CLI](cli/terminal-client.md) |
| Agent runtime | Copilot SDK sessions, prompts, events, hooks, and permissions | [Agent](agent/agent-runtime.md) |
| Ableton bridge | Typed client used by tools and workflows | [Bridge](bridge/ableton-bridge.md) |
| Remote Script | Safe access to Ableton's LOM | [Remote Script](remote-script/remote-script.md) |
| IPC protocol | Framing, messages, errors, capabilities, and compatibility | [Protocol](protocol/ipc-protocol.md) |
| Tool system | Primitive tools, workflow tools, schemas, and results | [Tools](tools/tool-design.md) |
| Product experience | Music-production UI and agent interaction model | [UI](ui/product-experience.md) |
| Project state | Snapshots, cache invalidation, session context, and change sets | [State](state/project-state.md) |
| Safety | Permissions, destructive actions, verification, and recovery | [Safety](safety/safety-and-recovery.md) |
| Testing | Unit, contract, simulated, Live, and UI testing | [Testing](testing/test-strategy.md) |
| Packaging and operations | Installation, updates, logging, support, and releases | [Platform](platform/packaging-and-operations.md) |
| Delivery plan | Milestones, sequencing, and completion criteria | [Roadmap](delivery/roadmap.md) |

## Initial feature scope

The first production-capable version should cover the proven feature set from
the two MCP implementations:

- Session and transport inspection.
- MIDI and audio track creation, naming, deletion, mixer level, pan, mute,
  solo, and arm.
- Session clip creation, naming, playback, and MIDI-note editing.
- Arrangement inspection, clip placement, duplication, naming, deletion, loop
  control, and cue points.
- Device inspection, enable/disable, parameter discovery, and normalized
  parameter control.
- Rack-chain and Drum Rack inspection.
- Ableton browser navigation and loading by stable browser URI.
- External plug-in discovery and loading where the LOM exposes it.
- Live-version and capability discovery.

Features known to be fragile or highly version-dependent, including detailed
automation-envelope editing and preset navigation, remain experimental until
validated against supported Live versions.

## Non-goals for the first release

- Running the Copilot SDK or network client inside Ableton's Python process.
- Replacing deterministic music operations with unconstrained generated Python.
- Supporting arbitrary remote-network control of Ableton.
- Shipping the experimental UDP controller as core infrastructure.
- Building a DAW inside the companion app.
- Requiring MCP for the main product workflow.

An MCP compatibility adapter may be added later over the same framework-neutral
Ableton bridge.
