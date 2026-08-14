# MIDI Capture companion scripts

These scripts back the `Midi-Capture` Max for Live device:

- `midi_note_parser.js` synchronously parses raw MIDI bytes, including running
  status and velocity-zero note-offs, and emits atomic
  `channel pitch velocity is_note_on sequence` events.
- `midi_capture_writer.js` groups timestamped events into contiguous,
  transport-synchronized windows and appends one `midi-sample/v1` JSON object
  per line.

## Device use

1. Click **Choose Output...** and select a `.jsonl` destination.
2. Set **Sample Beats** from `0.25` to `64`.
3. Enable **Capture** and start Live's transport.
4. Stop the transport or disable Capture to flush a non-empty partial window.

The device keeps raw MIDI pass-through independent from capture. Output paths
are intentionally selected per device session; capture reports an error and
switches off if the writer is unavailable.

## Tests

```sh
node --test max-patches/midi-capture/midi_capture_writer.test.cjs
```
