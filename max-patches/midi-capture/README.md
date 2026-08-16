# MIDI Capture companion scripts

These scripts back the `Midi-Capture` Max for Live device:

- `midi_note_parser.js` synchronously parses raw MIDI bytes, including running
  status and velocity-zero note-offs, and emits atomic
  `channel pitch velocity is_note_on sequence` events.
- `midi_capture_writer.js` groups timestamped events into contiguous,
  transport-synchronized windows. Each sample is independently offered to the
  optional JSONL writer and the reconnecting local agent signal transport.
- `agent_signal_client.js` discovers the local newline-delimited JSON ingress,
  authenticates, registers the producer, heartbeats, and reconnects without
  blocking capture.

## Device use

1. Optionally click **Choose Output...** and select a `.jsonl` destination.
2. Set **Sample Beats** from `0.25` to `64`.
3. Enable **Capture** and start Live's transport.
4. Stop the transport or disable Capture to flush a non-empty partial window.

The existing `.amxd` patch remains unchanged and compatible: no new messages
or controls are required. Raw MIDI pass-through, capture, JSONL recording, and
live delivery are independent. Capture and live delivery continue when no
JSONL path is selected; app/ingress absence never disables capture or JSONL.

## Local signal ingress

By default, the desktop app and Node for Max rendezvous through user-only files:

- `~/.ableton-agent/signal-ingress.json`: secret-free ingress descriptor.
- `~/.ableton-agent/signal-ingress.secret`: local authentication secret.

These defaults work even when Live was started independently and therefore
cannot inherit the desktop process environment. They can be overridden with
`ABLETON_AGENT_SIGNAL_INGRESS_DESCRIPTOR` and
`ABLETON_AGENT_SIGNAL_INGRESS_SECRET_PATH`; tests and development may provide
`ABLETON_AGENT_SIGNAL_INGRESS_SECRET` directly.

The script registers automatically at startup with a runtime-unique producer
and instance ID, display name `Midi-Capture`, and schema `midi-sample/v1`.
This keeps multiple device instances distinct during one Live run. Stable
identity and assignment rebinding across Live restarts, along with related
`.amxd` changes, are explicitly deferred.

Offline samples are bounded and oldest samples are coalesced away when the
queue is full. Status transitions use the patch's existing `status` outlet.
The ingress converts authenticated `signal.frame` messages into
`SignalEnvelope` values using the connection ID returned by `producer.hello`.

## Tests

```sh
node --test max-patches/midi-capture/**/*.test.cjs
```
