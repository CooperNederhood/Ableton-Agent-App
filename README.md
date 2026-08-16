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
pnpm run bootstrap
```

No Python or Node virtual environment needs to be activated. Node.js includes
`npm`; the first command uses it to install pnpm, the package manager used by
this monorepo. `pnpm run bootstrap` then installs the exact dependencies from
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

Load its contents into the shell that will launch the CLI or desktop app. Using
command substitution avoids accidentally copying zsh's trailing `%` marker,
which is not part of the token:

```bash
export ABLETON_AGENT_TOKEN="$(
  cat "$HOME/Music/Ableton/User Library/Remote Scripts/AbletonAgent/.ableton-agent-token"
)"
```

On Windows PowerShell:

```powershell
$env:ABLETON_AGENT_TOKEN = "<contents of .ableton-agent-token>"
```

Do not commit or share this token. Set `ABLETON_AGENT_PORT` only if you have
also configured the Remote Script to use a non-default port.

After installing or updating the Remote Script, fully quit and reopen Ableton
Live. Toggling the Control Surface off and on does not reliably reload Python
modules that Live has already imported.

### Max Patch Creator knowledge

Copilot CLI and coding agents opened in this repository can use the
repository-level `Max Patch Creator` agent while keeping the canonical scripts
and knowledge in a local Max4Live-MCP checkout:

```bash
export MAX4LIVE_MCP_ROOT="/Users/cooper/Documents/coding/Max4Live-MCP"
export ABLETON_MAX_PATH="/Users/cooper/Music/Ableton/User Library/Presets/Audio Effects/Max Audio Effect"
```

Set these variables in the environment that launches Copilot CLI.
`MAX4LIVE_MCP_ROOT` is required and must be an absolute path;
`ABLETON_MAX_PATH` is needed only when inspecting or copying user-saved
devices. Max4Live-MCP remains the source of truth for the patch database,
object documentation, tutorials, scripts, and learning artifacts.

The validated MIDI Capture device has a separate promote/install workflow:

```bash
pnpm midi-capture:promote -- --source "/path/to/midi-capture.amxd"
pnpm midi-capture:check
pnpm midi-capture:install -- --user-library "/path/to/Ableton/User Library"
```

Promote only after testing the working User Library device in Live. Promotion
updates the portable repository template; installation is a separate explicit
step so repository publishing cannot overwrite in-progress Max work.

This repository-level agent is separate from the production assistant embedded
in the Ableton Agent App. The local path also is not available to
GitHub-hosted or cloud agents; those environments require the knowledge to be
exposed remotely or copied into their workspace.

### One-shot agent runs

Use `run` for a non-interactive natural-language turn:

```bash
node apps/cli/dist/main.js run "inspect the set" --json
```

Reviewed real-Live integration scenarios opt into narrowly scoped automatic
approvals and deterministic post-turn assertions:

```bash
node apps/cli/dist/main.js run \
  "create a new track and add an 808 drum rack to it" \
  --scenario 808-track \
  --trace .test-artifacts/808-track.json \
  --json
```

Ordinary `run` remains mutation-denying. A scenario ID is accepted only with
its exact reviewed prompt, tool/risk allowlist, budgets, ordering constraints,
generated artifact namespace, and argument guards.

Run the real-Live workflow suite with:

```bash
pnpm live:agent-smoke
```

Close your normal Live session first. The harness refuses any pre-existing Live
process, launches a disposable instance, records and revalidates its exact PID
identity, and stops only that process. A failed runner-owned Set may be closed
without saving.

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

In an interactive terminal, chat responses render Markdown as styled headings,
wrapped lists and code, and width-aware tables. Narrow terminals automatically
switch wide tables to labeled records. Redirected output remains plain and
deterministic, and `NO_COLOR=1` disables color without disabling the readable
layout.

Try prompts such as:

```text
Describe the current Live Set without changing anything.
What devices are on the first track?
Set the tempo to 124 BPM.
Create a MIDI track named Ideas.
Find an available 808 drum kit, then create one MIDI track and load it.
```

Read-only operations run automatically. Mutations require a per-invocation
confirmation in interactive chat. Start with a disposable test Set while
manually validating mutation and recovery behavior.

### Ableton Browser loading

The agent can inspect and search every Browser root, including Drums, Packs,
User Library, and Live's virtual categories. Search results are bound to exact
runtime references rather than accepted as arbitrary filesystem paths.

Loading is narrower than searching because different Browser items act on
different Live targets. The track-loading tool accepts devices and device
presets that Live can apply to an exact compatible track. Live may add a device
or reconfigure an existing default device in place; the tool verifies and
reports which mutation occurred. Samples, clips, grooves, folders, and unknown
item types remain searchable but are rejected before mutation until they have
explicit destination tools, such as a Drum Rack pad or Session clip slot.

For combined requests such as creating a drum track, the agent searches and
resolves a supported item before creating the track. If track creation
succeeds but loading fails, the empty track is kept and reported as a partial
result; the agent does not retry track creation.

Agent turns have an application-owned three-minute deadline. A timed-out turn
is cancelled before the prompt returns so late tool output cannot leak into
the next command.

### Start the desktop app

The desktop app uses the same runtime, bridge, tools, and approval policies as
the CLI:

```bash
pnpm desktop:dev
```

Use its Diagnostics view to confirm the bridge, Remote Script compatibility,
and Copilot session state before testing chat and mutations.

For a debug launch with `ABLETON_AGENT_LOG_LEVEL=debug` and DevTools opened
automatically, run:

```bash
pnpm desktop:debug
```

Renderer changes use Vite hot reload. Changes to the Electron main process or
preload must be picked up by stopping and restarting the development command.
The app prints the development log path at startup; follow it in another shell
with `tail -f "<printed-path>"` on macOS/Linux or
`Get-Content "<printed-path>" -Wait` in PowerShell.

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
| `pnpm desktop:dev`                          | Start the desktop renderer development workflow             |
| `pnpm desktop:debug`                        | Start desktop development with debug logs and DevTools      |
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
