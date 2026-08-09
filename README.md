# Ableton Agent App

An Ableton-specific AI agent built with the GitHub Copilot SDK. It can inspect
and safely modify an open Ableton Live Set through a reference CLI or a
sandboxed Electron desktop app.

The project does **not** use MCP. The Node.js application exposes typed Copilot
tools, sends validated requests over an authenticated local TCP connection, and
a dependency-free Python Remote Script performs the actual Live Object Model
(LOM) operations inside Ableton.

```text
CLI or Electron UI
        |
GitHub Copilot SDK + typed Ableton tools
        |
TypeScript bridge (127.0.0.1:8765)
        |
Python Ableton Remote Script
        |
Ableton Live Object Model
```

## Setup

### Requirements

- macOS 13+ or Windows 10/11
- Ableton Live 11.3+ or 12.x
- Node.js 20.19+ (Node.js 22 LTS is recommended)
- Python 3
- A GitHub account with access to GitHub Copilot

### 1. Install the application

Clone the repository, install the pinned pnpm version, and run the project
bootstrap:

```bash
git clone https://github.com/CooperNederhood/Ableton-Agent-App.git
cd Ableton-Agent-App
npm install --global pnpm@10.15.1
npm run bootstrap
```

No Python or Node virtual environment needs to be activated. Node.js includes
`npm`; the first command uses it to install pnpm, the package manager used by
this monorepo. `npm run bootstrap` then installs the exact dependencies from
`pnpm-lock.yaml` and builds the CLI, desktop app, and shared packages.

If pnpm is already installed, verify that `pnpm --version` reports `10.15.1`
and skip the global installation command.

### 2. Install the Ableton Remote Script

First check which Ableton User Library locations were detected:

```bash
pnpm --filter @ableton-agent/desktop remote-script detect
```

Install the script into the detected User Library:

```bash
pnpm --filter @ableton-agent/desktop remote-script install --confirm
```

If detection fails, provide either your User Library or its `Remote Scripts`
directory:

```bash
pnpm --filter @ableton-agent/desktop remote-script install --confirm \
  --path "/path/to/Ableton/User Library"
```

The command prints the installed `AbletonAgent` destination. Managed updates
preserve its authentication token and back up the previous installation.

### 3. Enable the script in Ableton Live

1. Restart Ableton Live.
2. Open **Settings/Preferences > Link, Tempo & MIDI**.
3. Select **AbletonAgent** in an available **Control Surface** row.
4. Leave Ableton running with a Set open.

The Remote Script listens only on `127.0.0.1`, using port `8765` by default.

### 4. Configure the bridge token

The Remote Script creates this file inside its installed directory:

```text
AbletonAgent/.ableton-agent-token
```

Copy its contents into the shell that will launch the CLI or desktop app:

```bash
export ABLETON_AGENT_TOKEN="<contents of .ableton-agent-token>"
```

On Windows PowerShell:

```powershell
$env:ABLETON_AGENT_TOKEN = "<contents of .ableton-agent-token>"
```

Do not commit or share this token. Set `ABLETON_AGENT_PORT` only if you have
also configured the Remote Script to use a non-default port.

## Quickstart

With Ableton running, the Control Surface enabled, and
`ABLETON_AGENT_TOKEN` set, verify the connection:

```bash
node apps/cli/dist/main.js doctor
node apps/cli/dist/main.js live-smoke
```

Both commands should report a connected bridge, compatible protocol and Remote
Script versions, and successful non-mutating inspections.

Inspect the current Set:

```bash
node apps/cli/dist/main.js snapshot
node apps/cli/dist/main.js transport
node apps/cli/dist/main.js devices 1
node apps/cli/dist/main.js browser-roots
```

Start the agent chat:

```bash
node apps/cli/dist/main.js chat
```

Try prompts such as:

```text
Describe the current Live Set without changing anything.
What devices are on the first track?
Set the tempo to 124 BPM.
Create a MIDI track named Ideas.
```

Read-only operations run automatically. Mutations require a per-invocation
confirmation in interactive chat. Start with a disposable test Set while
manually validating mutation and recovery behavior.

### Start the desktop app

The desktop app uses the same runtime, bridge, tools, and approval policies as
the CLI:

```bash
pnpm --filter @ableton-agent/desktop dev
```

Use its Diagnostics view to confirm the bridge, Remote Script compatibility,
and Copilot session state before testing chat and mutations.

## Manual verification checklist

- `doctor` reports a healthy connection.
- `live-smoke` completes without errors.
- `snapshot` shows the tracks in the open Set.
- `transport` shows the current tempo, playback, loop, and cue-point state.
- A read-only chat prompt inspects the Set without requesting approval.
- A mutation prompt requests approval before changing Live.
- Denying approval leaves the Set unchanged.
- Approving a simple reversible mutation, such as changing tempo, updates Live.
- The Electron Diagnostics and chat views behave consistently with the CLI.

For formal release evidence, run:

```bash
pnpm live:validate -- --live-version <your-live-version>
```

This writes privacy-safe evidence under `.test-artifacts/live-validation/`.

## Development without Ableton

Run the included Python simulator:

```bash
python3 remote-script/simulator.py \
  --token "development-token-with-at-least-32-characters" \
  --port 8765
```

In another shell:

```bash
export ABLETON_AGENT_TOKEN="development-token-with-at-least-32-characters"
node apps/cli/dist/main.js live-smoke
```

The simulator validates bridge and protocol behavior, but it cannot validate
real LOM behavior.

## Common commands

| Command                                     | Purpose                                                     |
| ------------------------------------------- | ----------------------------------------------------------- |
| `pnpm check`                                | Run formatting, lint, docs, contracts, types, and all tests |
| `pnpm build`                                | Build every workspace                                       |
| `pnpm test:electron`                        | Run Electron end-to-end tests                               |
| `pnpm desktop:dist`                         | Produce unsigned local desktop artifacts                    |
| `pnpm live:validate -- --live-version 12.1` | Record real-Live smoke evidence                             |
| `node apps/cli/dist/main.js help`           | List CLI commands and options                               |

## Troubleshooting

| Problem                               | Check                                                                                          |
| ------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Bridge is disconnected                | Restart Live, confirm `AbletonAgent` is selected as a Control Surface, and verify port `8765`. |
| Authentication fails                  | Re-read the token from the installed script; do not use one from the source checkout.          |
| No Remote Script location is detected | Re-run installation with `--path` pointing to your Ableton User Library.                       |
| Agent session does not start          | Confirm your GitHub Copilot access and inspect the CLI error or desktop Diagnostics view.      |
| A tool is unavailable                 | Run `capabilities`; support can vary by Live version and exposed LOM APIs.                     |
| A mutation is denied                  | Use interactive `chat` and approve that exact invocation when prompted.                        |

## Documentation

- [Project overview and architecture](docs/overview.md)
- [System architecture](docs/architecture/system-architecture.md)
- [Remote Script and LOM integration](docs/remote-script/remote-script.md)
- [Tool design and safety model](docs/tools/tool-design.md)
- [Packaging, installation, and release operations](docs/platform/packaging-and-operations.md)
- [Implementation status](docs/implementation-workplan.md)

Real Ableton behavior and signed installers still require manual validation
across the supported Live and operating-system matrix.
