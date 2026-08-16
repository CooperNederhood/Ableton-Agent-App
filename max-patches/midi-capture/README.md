# MIDI Capture companion scripts

These scripts back the `Midi-Capture` Max for Live device:

- `Midi-Capture.amxd` is the portable canonical template. Its script paths use
  an install-time placeholder rather than a developer machine path.
- `midi_note_parser.js` synchronously parses raw MIDI bytes, including running
  status and velocity-zero note-offs, and emits atomic
  `channel pitch velocity is_note_on sequence` events.
- `midi_capture_identity.js` resolves the device's canonical Live path and its
  containing track, including devices nested inside racks, then emits one
  atomic identity payload.
- `midi_capture_writer.js` groups timestamped events into contiguous,
  transport-synchronized windows. Each sample is independently offered to the
  optional JSONL writer and the reconnecting local agent signal transport.
- `agent_signal_client.js` discovers the local newline-delimited JSON ingress,
  authenticates, registers the producer, heartbeats, and reconnects without
  blocking capture.

## Installation

Close Live before replacing an installed device, then run:

```sh
pnpm midi-capture:install
```

The installer detects the standard macOS/Windows User Library locations and
honors `ABLETON_USER_LIBRARY`. An explicit location can be supplied with:

```sh
pnpm midi-capture:install -- --user-library "/path/to/User Library"
```

It renders the portable AMXD with the selected destination path, installs all
four companion scripts beside it, and writes install metadata. Use `--dry-run`
to inspect the destination without changing files.

## Promoting a validated Live device

Live/Max is the working source of truth while patching. Do not repeatedly copy
the repository AMXD over an open development device.

After the device has been tested in Live and explicitly approved:

```sh
pnpm midi-capture:promote -- \
  --source "/path/to/User Library/Presets/MIDI Effects/Max MIDI Effect/midi-capture.amxd"
pnpm midi-capture:check
```

Promotion imports the validated AMXD, copies its adjacent companion scripts,
replaces machine-specific paths with the portable placeholder, and removes the
development-only `mcp_bridge`. It does not reinstall the device. Installation
is always a separate command.

`pnpm midi-capture:check` rejects missing companions, absolute machine paths,
an absent install placeholder, or a remaining MCP bridge.

## Device use

1. Optionally click **Choose Output...** and select a `.jsonl` destination.
2. Set **Sample Beats** from `0.25` to `64`.
3. Enable **Capture** and start Live's transport.
4. Stop the transport or disable Capture to flush a non-empty partial window.

Raw MIDI pass-through, capture, JSONL recording, and live delivery are
independent. Capture and live delivery continue when no JSONL path is selected;
app/ingress absence never disables capture or JSONL.

## Local signal ingress

By default, the desktop app and Node for Max rendezvous through user-only files:

- `~/.ableton-agent/signal-ingress.json`: secret-free ingress descriptor.
- `~/.ableton-agent/signal-ingress.secret`: local authentication secret.

These defaults work even when Live was started independently and therefore
cannot inherit the desktop process environment. They can be overridden with
`ABLETON_AGENT_SIGNAL_INGRESS_DESCRIPTOR` and
`ABLETON_AGENT_SIGNAL_INGRESS_SECRET_PATH`; tests and development may provide
`ABLETON_AGENT_SIGNAL_INGRESS_SECRET` directly.

After Node for Max and the Live API are ready, the device registers with:

- a producer ID derived from the device's canonical Live path;
- a random instance ID for the current Node runtime;
- track ID, index, and name;
- device ID and name;
- display name `Midi-Capture` and schema `midi-sample/v1`.

The producer ID remains stable across socket reconnects, Node restarts, and
ordinary set reopen operations while the canonical device path is unchanged.
Duplicated devices have different paths and producer IDs, so multiple instances
register independently. Moving or reordering a track or device changes its
canonical path and can require assigning that output again in Desktop.

Track/device renames are refreshed when the producer re-registers, such as
after reloading the device. The current signal protocol does not update
producer metadata in place.

Offline samples are bounded and oldest samples are coalesced away when the
queue is full. Status transitions use the patch's existing `status` outlet.
The ingress converts authenticated `signal.frame` messages into
`SignalEnvelope` values using the connection ID returned by `producer.hello`.

## Tests

```sh
node --test max-patches/midi-capture/**/*.test.cjs
```
