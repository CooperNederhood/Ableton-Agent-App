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
pnpm test:electron
```

## CLI

The Remote Script creates `.ableton-agent-token` in its installed
`AbletonAgent` directory. Copy that value into the environment before running
the CLI:

```bash
export ABLETON_AGENT_TOKEN="<token>"
node apps/cli/dist/main.js doctor
node apps/cli/dist/main.js snapshot
node apps/cli/dist/main.js transport
node apps/cli/dist/main.js devices 1
node apps/cli/dist/main.js parameters 1 1
node apps/cli/dist/main.js rack-chains 1 1
node apps/cli/dist/main.js chain-devices 1 1 1
node apps/cli/dist/main.js drum-pads 1 1
node apps/cli/dist/main.js pad-chains 1 1 1
node apps/cli/dist/main.js pad-chain-devices 1 1 1 1
node apps/cli/dist/main.js browser-roots
node apps/cli/dist/main.js browser-category instruments
node apps/cli/dist/main.js browser-search "operator" --root instruments
node apps/cli/dist/main.js browser-load 1 "operator" 1 --root instruments --approve
node apps/cli/dist/main.js chat
```

Set `ABLETON_AGENT_PORT` to override the default port `8765`, and
`ABLETON_AGENT_MODEL` to pin a Copilot model instead of the runtime default.
Without `ABLETON_AGENT_TOKEN` the CLI still runs, but every Ableton operation
fails with the stable `configuration_missing` code instead of a fake result.
Read-only tools are approved automatically. Interactive chat asks for
per-invocation confirmation before reversible mutations; non-interactive
commands deny mutations by default and return exit code `4`.
Current mutations include tempo, playback, MIDI/audio track creation, and
identity-bound track rename, normalized mixer controls, and non-group track
deletion with last-track protection.
Session composition supports guarded MIDI clip creation and destructive,
reference-bound note replacement with bounded payloads, core-note recovery,
and explicit opt-in for per-note expression loss. Session inspection includes
identity-bound MIDI and audio clip summaries for safe follow-up operations.
Existing Session MIDI and audio clips can be launched, duplicated into empty
identity-bound slots, deleted, and conservatively updated for name, mute, and
supported loop state. Launch, duplication, and property updates verify their
postconditions and restore prior playback, destination occupancy, or property
values where the Live Object Model permits; deletion is destructive. Audio
clip creation and file loading are intentionally not implemented.
Arrangement composition supports verified, non-overlapping empty MIDI clip
placement with rollback on failed creation, bounded inspection, and destructive
identity-bound clip deletion. Arrangement MIDI note replacement uses the same
bounded payloads, verification, recovery, and expression-loss consent as
Session clips. Identity-bound Session MIDI clips can be duplicated to
non-overlapping Arrangement destinations with rollback, and Arrangement clip
name, mute, and supported loop state can be updated with verified restoration
of prior values on failure.
Arrangement transport inspection returns the loop state plus a bounded page of
cue points. Loop enable/start/length updates validate finite bounded beat
values, verify the complete before/after state, and restore prior values after
partial failure. Cue-point creation is reversible and rolls back failed
creation; cue-point deletion is destructive and requires the stable runtime
reference, name, and time returned by a recent inspection. Cue references are
stable only for the current Remote Script runtime because Live does not expose
persistent cue-point IDs.
Top-level devices on identity-bound regular tracks can be inspected in bounded
pages, and parameters are fetched only for one exact device in a separate
bounded page. Device and parameter references are stable only for the current
Remote Script runtime. One explicitly targeted top-level rack can now be
inspected through separate bounded pages for direct rack chains, direct chain
devices, Drum Rack pads, pad chains, and direct pad-chain devices. Rack, chain,
pad, and nested-device references are runtime-stable and pruned when their LOM
objects are no longer reachable. Every follow-up revalidates the exact regular
track, top-level rack, and requested chain or pad identity. Nested racks are
reported as devices but never expanded recursively. Return tracks, group
tracks, nested-rack traversal, and chain-device parameter access remain out of
scope.
Ableton Browser roots and direct folder children can be inspected in bounded
pages. Search uses deterministic breadth-first traversal with explicit limits
of 256 visited nodes, 32 results, depth 6, 128 query characters, and 250 ms of
main-thread work per request. Results receive runtime-stable references from a
512-entry bounded cache, and every follow-up revalidates the exact root,
indexed/name path, item name, and URI.
Loading is limited to an explicitly selected identity-bound regular track and
an exact loadable item under Instruments, Audio Effects, or MIDI Effects.
Plug-ins, Max for Live, user-library/current-project content, samples, clips,
arbitrary filesystem paths, folders, incompatible tracks, and active hotswap
are rejected. Loading is reversible-risk and requires approval; the operation
captures bounded before/after device and Session clip state and succeeds only
after observing added top-level devices. Unverified or partially observed
loads return an explicit indeterminate/not-observed failure.
Device enable/disable uses the documented first `Device On` parameter when it
is exposed. Parameter updates accept normalized `0..1` values, map through the
parameter's current minimum and maximum, snap quantized parameters to the
nearest discrete value, reject disabled or known non-writable parameters, and
verify or restore the prior value after failure.

Real-Live validation still required: confirm `Device On` naming and ordering
across supported Live versions and localized installations, plug-in and native
device writability behavior, quantized `value_items` mapping, setter exception
timing, and rollback verification. Also confirm `can_have_chains`, `chains`,
`can_have_drum_pads`, `drum_pads`, DrumPad `chains`/`note`/`name`, chain
`devices`/`name`/`color`, object-identity stability, ordering, empty-pad
behavior, and capability detection across supported Live versions.
Also validate Browser root availability and ordering; BrowserItem `name`,
`uri`, `children`, `is_folder`, and `is_loadable`; URI and object stability;
child access latency; `Browser.load_item`; selected-track targeting and
selection restoration; hotswap behavior; MIDI/audio track compatibility;
synchronous versus delayed device appearance; multi-device presets; and
failure timing across supported Live versions and installed Packs.

## Desktop

The Electron app composes the same headless application as the CLI
(`packages/runtime`), so chat, streaming, approvals, cancellation, sessions,
status, and diagnostics all run through the shared services. Electron main adds
only a `DesktopService` adapter that maps shared events, connection status, and
project snapshots into the typed desktop contracts; the sandboxed renderer
still reaches the main process exclusively through named, schema-validated IPC.

The bridge token is read from the OS-backed credential vault
(`ableton-bridge-token`) or `ABLETON_AGENT_TOKEN`, and the bridge port, model,
and reasoning effort come from stored preferences, where `auto` leaves the
Copilot runtime defaults untouched. Those values are read while the app
composes, so changing them applies at the next launch and the app says so.
Retry and undo are reported as unsupported rather than simulated, and no
project snapshot is produced while Ableton is disconnected.

```bash
pnpm --filter @ableton-agent/desktop build
pnpm --filter @ableton-agent/desktop start
```

For development without Ableton:

```bash
python3 remote-script/simulator.py \
  --token "development-token-with-at-least-32-characters" \
  --port 8765
```

See [`docs/overview.md`](docs/overview.md) for the architecture and
[`docs/implementation-workplan.md`](docs/implementation-workplan.md) for
delivery status.

Real Ableton release validation is recorded with `pnpm live:validate`; see the
release-evidence section in
[`docs/platform/packaging-and-operations.md`](docs/platform/packaging-and-operations.md).
