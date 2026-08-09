# Ableton Agent App

An Ableton-specific agent application built on the GitHub Copilot SDK. The
current implementation includes a headless TypeScript core, a reference CLI,
an authenticated TCP bridge, and a dependency-free Ableton Remote Script.

## Development

Requirements:

- Node.js 20 or newer
- pnpm 10.15.1
- Python 3 for Remote Script tests and the simulator

```bash
pnpm install
pnpm check
pnpm build
```

## CLI

The Remote Script creates `.ableton-agent-token` in its installed
`AbletonAgent` directory. Copy that value into the environment before running
the CLI:

```bash
export ABLETON_AGENT_TOKEN="<token>"
node apps/cli/dist/main.js doctor
node apps/cli/dist/main.js snapshot
node apps/cli/dist/main.js chat
```

Set `ABLETON_AGENT_PORT` to override the default port `8765`.
Read-only tools are approved automatically. Interactive chat asks for
per-invocation confirmation before reversible mutations; non-interactive
commands deny mutations by default and return exit code `4`.
Current mutations include tempo, playback, MIDI/audio track creation, and
identity-bound non-group track deletion with last-track protection.

For development without Ableton:

```bash
python3 remote-script/simulator.py \
  --token "development-token-with-at-least-32-characters" \
  --port 8765
```

See [`docs/overview.md`](docs/overview.md) for the architecture and
[`docs/implementation-workplan.md`](docs/implementation-workplan.md) for
delivery status.
