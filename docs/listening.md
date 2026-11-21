# Machine listening

The agent can play a Session clip or an Arrangement range and "hear" it: it gets
back audio measurements such as loudness, brightness, attacks, pitch and
spectral shape, laid out on a musical grid. This page explains why listening
needs a special device, which pieces are involved, how one listen runs from
start to finish, and how the agent reads the results later.

## Why listening needs a Max for Live device

The rest of the app talks to Ableton Live through the **Live Object Model
(LOM)**: Live's programmable view of tracks, clips, devices and transport. Our
**Remote Script** (Python running inside Live, see
[live-connection.md](live-connection.md)) uses the LOM to read and change the
Set. The LOM can tell you a clip's name, notes, gain or warp settings. It can't
give you the audio samples.

To hear audio we put a **Max for Live** device on the track. Max for Live lets
you build Live devices in Max, a visual programming environment for audio and
MIDI. A Max for Live device sits in a track's device chain like any other
effect, sees the real signal (after instruments and effects), and can run
JavaScript and DSP code.

| Device                     | Where                       | What it does                                                                                                     |
| -------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Audio listener             | `max-patches/audio-listener` | Transparent audio effect. Captures samples and computes measurements. Controller: `audio_listener_metric_controller.js`. |
| MIDI capture               | `max-patches/midi-capture`  | Captures MIDI events on a track. Shares the same connection client.                                              |
| Shared producer client     | `max-patches/shared`        | `agent_signal_client.js` and `producer_identity.js`: find the app, authenticate, register, report track identity. |

Both devices are **producers**: they connect to the app's local signal ingress
(`SignalIngressServer` in `packages/signal-routing/src/ingress-server.ts`) over
loopback TCP, register, and stream measurements. The audio listener does its
analysis inside Max: native Gen/FFT code for level, attacks and spectrum, plus
bundled FluCoMa externals (`fluid.pitch~`, `fluid.spectralshape~`) and a mel-band
analyzer (`listener.mel~`) under `max-patches/audio-listener/dependencies/`.
Only processed measurements leave the device. Raw audio is never stored.

The listener is placed on a track by the user or a template; the app can't
insert Max devices through the Live 11 LOM.

## The pieces

```mermaid
flowchart LR
    Agent["Agent<br/>ableton_listening / ableton_context"] --> Tools["packages/tools<br/>listening-tools.ts"]
    Tools --> Coord["packages/application<br/>listening-coordinator.ts"]
    Coord --> Runtime["packages/runtime<br/>session-listening-runtime.ts<br/>listening-runtime-host.ts"]
    Runtime -->|bridge commands| RS["Remote Script<br/>listening_*.py"]
    Runtime <-->|signal ingress| Max["Audio listener<br/>Max for Live device"]
    RS --> Live["Live Set / transport"]
    Live --> Max
    Runtime --> Store["entity-context.sqlite<br/>packages/project-state"]
    Tools --> Store
```

| Layer            | Files                                                                                                                                                                                                           | Role                                                                                                     |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Agent tools      | `packages/tools/src/listening-tools.ts`, `listening-feature-views.ts`, `listening-summary.ts`                                                                                                                   | `ableton_listening` starts and inspects captures. `ableton_context` reads, compares and searches results. |
| Job coordinator  | `packages/application/src/listening-coordinator.ts`, `listening-host.ts`                                                                                                                                         | Runs one capture as a job through fixed stages, one at a time.                                           |
| Session runtime  | `packages/runtime/src/session-listening-runtime.ts`, `session-listening-driver.ts`, `session-listening-source.ts`                                                                                               | Checks the clip, predicts the start, drives the Remote Script pass, validates the result.                |
| Arrangement runtime | `packages/runtime/src/listening-runtime-host.ts`                                                                                                                                                             | Same job stages for an Arrangement range. Also wires Session services in.                                |
| Capture plumbing | `packages/runtime/src/metric-listening-capture.ts`, `metric-listening-config.ts`, `metric-stream-publication.ts`                                                                                                | Arms listeners, collects measurement streams, publishes them to storage.                                 |
| Remote Script    | `remote-script/AbletonAgent/session_listening_source.py`, `session_listening_pass.py`, `listening_commands.py`, `listening_playback.py`, `arrangement_listening_source.py`                                    | Reads clip and transport state, launches the clip, monitors it, positions Arrangement playback.          |
| Storage          | `packages/project-state/src/context-repository.ts`, `metric-capture-repository.ts`                                                                                                                              | Stores captures and derived features per App session.                                                    |

### Remote Script commands

| Command                                                  | File                              | Purpose                                                                          |
| -------------------------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------- |
| `listening.inspect_context`                              | `listening_commands.py`           | Find listener devices, attest which track they're on, read transport.            |
| `listening.inspect_session_source`                       | `session_listening_source.py`     | Read a Session clip's settings and before/after transport state.                 |
| `listening.prepare_session_pass` / `launch_` / `inspect_` / `release_` | `session_listening_pass.py` | One monitored Session pass: prepare, fire the clip, poll it, release monitors. |
| `listening.position_playback`, `listening.start_playback` | `listening_playback.py`          | Move the stopped Arrangement to the start beat, then start it.                   |
| `listening.inspect_arrangement_source`                   | `arrangement_listening_source.py` | Read-only Arrangement evidence (clips, MIDI, devices) for a track and range.     |

`listening.stop_playback` is registered but always refuses: the app never
stops or rewinds Live on its own after a capture.

## The core idea: what a listen needs

Forget the code for a moment. To turn "listen to this clip" into numbers per
beat, you need four things:

1. **Which sound.** Identity of the clip and track. This comes from the Remote
   Script, which can name the exact clip, its slot and whether it's playing.
2. **Where beat 0 is.** The sample at which the clip starts. Only the Max device
   knows sample time. It runs its own transport clock in Gen and reports rows of
   (playing, song beat, sample counter).
3. **Samples per beat.** `sampleRate × 60 / tempo`. Tempo comes from the Set,
   sample rate from the listener's registration (44.1 or 48 kHz). See
   `packages/protocol/src/metric-listening-geometry.ts`.
4. **Enough samples.** Capture must run from beat 0 to the requested end.

The hard part is (2): the Remote Script sees the clip start only at message
rate (a few times per second), while the device sees samples but doesn't know
which clip is playing. Today these are joined with an **anchor** and an
**onset window**:

- Before launch, the runtime predicts the global beat where the clip will start
  (the anchor) from the stopped transport position.
- The Max device refuses to arm unless the transport is stopped exactly at that
  beat.
- After `clip.fire()`, the Remote Script accepts the clip's reported start time
  only if it falls inside a small window after the anchor (exactly the anchor
  without quantization, up to one bar later with One Bar quantization).
- The runtime then checks that start matches the prediction, and the device
  counts samples from its own clock.

This alignment design is under review.

## Session flow, start to finish

The agent calls `ableton_listening` with `action: "play-session-and-listen"` and
a target clip (track index and reference, scene index, clip reference). The
coordinator moves the job through stages: `validating`, `reserving-context`,
`arming`, `starting-playback`, `capturing`, `persisting`, then `completed`,
`partial`, `failed` or `cancelled`.

```mermaid
sequenceDiagram
    participant A as Agent
    participant App as App + runtime
    participant U as User
    participant RS as Remote Script
    participant M as Max listener
    participant L as Live

    A->>App: ableton_listening play-session-and-listen
    App->>RS: inspect_context / inspect_session_source
    RS-->>App: clip identity, settings, stopped transport beat
    App->>U: approval request (plays audio)
    U-->>App: approve
    App->>App: freeze expectation, predict anchor
    App->>RS: prepare_session_pass (timingAnchor)
    RS-->>App: prepared (monitors installed)
    App->>M: configure + arm
    M->>M: check transport stopped at anchor beat
    M-->>App: armed
    App->>RS: launch_session_pass
    RS->>L: clip.fire()
    loop every tick, up to 5 s
        RS->>L: read clip + transport state
    end
    RS-->>App: playing (clip start within onset window)
    L-->>M: audio
    M-->>App: measurement records
    App->>RS: inspect_session_pass (continuity, every ~100 ms)
    App->>App: seal: check covered boundary and source unchanged
    App->>App: publish measurements to storage
    App->>RS: release_session_pass
    App->>M: disarm
    App-->>A: job + summary (playback left running)
```

Step by step:

1. **Resolve the target.** `listening.inspect_context` finds the listener on the
   clip's track. `listening.inspect_session_source` reads the clip settings and
   transport state twice (before/after) so a changing Set is caught.
2. **Approval.** Play actions are mutations (they start playback), so the user
   approves them like any other change. See [safety.md](safety.md).
3. **Freeze and predict.** `freezeSessionSourceExpectation` in
   `session-listening-source.ts` checks the supported case and computes
   `stoppedBeat`, `startBeat` (the anchor) and `durationBeats`. By default the
   capture covers one loop, or the start/end region of a non-looping clip.
4. **Prepare.** The driver (`createSessionSourceDriver`) sends
   `listening.prepare_session_pass` with `timingAnchor: { globalBeat }`. The
   Remote Script records a baseline and subscribes to LOM change listeners.
5. **Arm the device.** `prepareMetricListenerStream` configures and arms the
   listener. The controller's `clock()` check throws
   `metric_transport_not_stopped` or `metric_source_position_mismatch` if the
   transport isn't stopped at the expected beat.
6. **Launch.** `listening.launch_session_pass` makes the Remote Script call
   `clip.fire()` once. It polls every Live tick; the runtime polls with
   `inspect` every 50 ms. If the clip isn't seen playing within 5 seconds the
   pass fails as `session_launch_unverified`.
7. **Onset.** The Remote Script sets the clip's "epoch" when the clip is playing,
   its slot matches, and its start time is inside the onset window. The runtime
   runs `assertTransportCoupledSessionOrigin`, then waits for the device to
   confirm its own onset.
8. **Capture.** The device streams records for each metric family
   independently. Meanwhile the runtime checks continuity every ~100 ms; any
   retrigger, other launch, wrap or settings change invalidates the pass.
9. **Seal.** When capture finishes, `seal()` waits for evidence that the clip
   reached its boundary, re-reads the source and checks nothing changed.
10. **Publish and clean up.** Measurements are written to storage. Cleanup
    releases the Remote Script monitors and disarms the device. **Playback is
    left running** (`cleanupPolicy: "leave-running"`); the agent stops
    transport only if asked.

### What Session listening supports

- Transport stopped, recording off, no clip queued.
- MIDI clips (heard through their instrument) or warped audio clips.
- 4/4, known constant tempo.
- Clip in Trigger mode, legato off, zero start marker and loop start, follow
  actions not enabled.
- Clip quantization Global or One Bar; global quantization None or One Bar.
- At most one loop (or the non-looping region), and at most 600 seconds.

Anything else is refused before anything plays. Rejected passes are never
retried automatically.

## Arrangement flow

`play-arrangement-and-listen` captures the exact range `[startBeat, endBeat)`
on one or more tracks (up to 8), each with its own listener. It reuses the same
job stages and capture plumbing in `listening-runtime-host.ts`:

1. Inspect listeners with `listening.inspect_context`.
2. `listening.position_playback` moves the stopped Arrangement to `startBeat`,
   and the runtime reads the position back.
3. Arm all listeners. Each device checks the transport is stopped at
   `startBeat`.
4. `listening.start_playback` starts the transport; the runtime checks it
   started at `startBeat` and waits for each device's onset.
5. Capture, validate, publish, then disarm. Playback keeps running.

Arrangement timing is simpler: the start position is set directly, so no onset
window is needed.

## Measurements

Each capture records several metric families side by side. If one family fails,
the others can still publish, and the job ends as `partial`. Missing data is
shown as unavailable, never as zero.

From those records the app derives musical **features** on a sixteenth-note
grid (`packages/protocol/src/listening-feature-contracts.ts`):

| Feature type                                                        | Meaning                                   |
| ------------------------------------------------------------------- | ----------------------------------------- |
| `peak-summary/v1`, `level-grid/v1`                                  | Peak and RMS level over time.             |
| `attack-activity-grid/v1`, `attack-strength-grid/v1`                | Where note/hit onsets happen and how hard. |
| `centroid-grid/v1`, `spectral-energy-summary/v1`                    | Brightness and spectral energy.           |
| `mel-grid/v1`, `mel-shape/v1`, `mel-region-summary/v1`, `mel-ratio-summary/v1` | Mel-band spectrum: tonal "fingerprint". |
| `pitch-grid/v1`, `pitch-confidence-summary/v1`                      | Estimated pitch and confidence (FluCoMa). |
| `flatness-summary/v1`, `spread-summary/v1`, `rolloff-summary/v1`    | Spectral shape: noisy vs tonal, width, rolloff (FluCoMa). |

Timing is descriptive, not sample-accurate, and the signal at a listener can
include effect tails or other routed audio. Results say which clip was playing,
not that the clip was the only sound.

## Storage and reading results back

Captures are stored per App session in `context/entity-context.sqlite` under
the profile's session-state folder (see [storage.md](storage.md)). They're
linked to the clip, track or Arrangement range they describe, and they survive
restarts. Each stored capture has a freshness state (`fresh`, `stale`,
`unknown`, ...) based on whether the source and settings still match.

The agent reads results without replaying:

- The `ableton_listening` result includes a compact summary and a `readTarget`.
- `ableton_context` with `action: "read"` reads stored values for a capture or
  for a source and beat range, page by page (`nextCursor`). `detail: "evidence"`
  or `"original-measurements"` give deeper data when needed.
- `action: "compare"` compares features between ranges; `action: "search"`
  finds similar passages (mel-grid by default).
- `action: "prune"` deletes named captures, with approval.

At the start of a turn the agent also gets a short inventory of stored captures
(`getSessionContextInventory`, served by
`packages/application/src/session-context-host.ts`), so it knows what it has
already heard without loading all the data into the prompt.

## Where to look in the code

| Question                              | Look at                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------ |
| What can the agent ask for?           | `packages/tools/src/listening-tools.ts`                                  |
| Job stages and ordering               | `packages/application/src/listening-coordinator.ts`                      |
| Session checks and anchor prediction  | `packages/runtime/src/session-listening-source.ts`                       |
| Session pass driver                   | `packages/runtime/src/session-listening-driver.ts`                       |
| Arrangement flow                      | `packages/runtime/src/listening-runtime-host.ts`                         |
| Clip launch and onset window          | `remote-script/AbletonAgent/session_listening_pass.py`                   |
| Device arm and clock checks           | `max-patches/audio-listener/audio_listener_metric_controller.js`         |
| Feature definitions                   | `packages/protocol/src/listening-feature-contracts.ts`                   |
| Stored captures                       | `packages/project-state/src/context-repository.ts`                       |
| Design decision                       | [ADR 0006](decisions/0006-playback-listening-and-entity-context.md)      |
