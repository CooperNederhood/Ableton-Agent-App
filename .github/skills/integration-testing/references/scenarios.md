# Scenarios

What each registered real-Live scenario covers. The manifests are the source of
truth for prompts, allowed calls, budgets, and assertions.

## User-message acceptance (`integration/acceptance-scenarios/`)

Run with `pnpm live:acceptance --scenario <id>`.

| Scenario                                                         | Messages                                                                                                          | Checks                                                |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `session-drum-rack-listening`                                    | "listen to clip-1" on a Drum Rack track                                                                           | One capture stored from the right clip; set unchanged |
| `session-clip-identify`                                          | Listen to a Session clip, then pick what it is (A–D)                                                              | Capture stored; the answer is the kick                |
| `session-stopped-quantized-audio` / `-midi`                      | "Listen to the first Session clip…" starting from a saved, stopped, non-zero position with launch quantization on | One capture stored; set unchanged                     |
| `session-two-midi-listening`                                     | Listen to clip-1 on one track, then clip-2 on another                                                             | Two fresh captures, each from its own clip            |
| `session-listening-continuity`                                   | Six listen → identify → stop-and-reset rounds, including a second track                                           | Every capture is fresh, every answer is right         |
| `session-listening-peak-smoke`                                   | Listen twice to the same clip                                                                                     | Both captures stored and searchable                   |
| `session-listening-feature-search`                               | Listen twice with all six measurements, then read both back                                                       | Stored captures and feature search work               |
| `session-flucoma-{flatness,spread,rolloff,melbands,pitch}-smoke` | Listen and include one specific measurement                                                                       | That measurement is stored and reported               |
| `arrangement-long-form-listening`                                | Listen to a three-minute Arrangement range                                                                        | Capture covers the range and survives a restart       |
| `long-horizon-comprehension`                                     | Listen to four clips and the Arrangement, then work out the clip order                                            | The answer matches the real order                     |
| `listening-consolidation-{short,long}-{audio,midi}`              | Listen to a Session clip and an Arrangement range, then read both back                                            | Both captures stored with the expected shape          |

Most of these messages spell out exactly how to listen ("Listen exactly once…
using the pinned readTarget…"). Only `session-drum-rack-listening`,
`session-clip-identify`, and `session-stopped-quantized-*` read like something
a user would actually type.

## Real-Live capability (`integration/live-scenarios/`)

Run with `pnpm live:agent-smoke --scenario <id>` or `--group <group-id>`.

### General (fresh default Set, no fixture needed)

| Group                  | Scenarios                                                                                                             | Covers                                                      |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `inspection`           | `connection-and-session`, `transport-inspection`, `browser-bounds`, `capability-surface`, `workflow-state-inspection` | Reading Live state without changing it                      |
| `transport`            | `transport-stop`                                                                                                      | Stopping playback from a natural request                    |
| `live-events`          | `live-event-registration`                                                                                             | Setting up and toggling a triggered-clip event              |
| `tracks`               | `track-lifecycle`, `audio-input-routing`, `808-track`                                                                 | Creating, routing, and removing tracks; loading a Drum Rack |
| `session-clips`        | `four-on-floor`, `session-clip-lifecycle`                                                                             | Writing and editing Session clips and notes                 |
| `arrangement-and-cues` | `arrangement-clip-lifecycle`, `arrangement-region-fill-lifecycle`, `cue-point-lifecycle`                              | Arrangement clips and cue points                            |
| `instruments`          | `piano-and-string-bass`                                                                                               | Finding and loading instruments from the Browser            |
| `audio-effects`        | `auto-filter-audio`, `echo-parameter-inspection`                                                                      | Loading effects and reading their parameters                |
| `listening-fixtures`   | `operator-quarter-note-fixture`                                                                                       | Building a simple MIDI source for listening tests           |

### Listening (`native-*`, need a prepared fixture)

These prompts spell out the exact listening calls, so they test the listening
tools and Max device in real Live rather than agent judgment. Each manifest
names its fixture flag in `setupContract.inputOption`.

| Group                                   | Covers                                                                                  |
| --------------------------------------- | --------------------------------------------------------------------------------------- |
| `native-listening`                      | One basic play-and-listen pass                                                          |
| `native-listening-session`              | Session clips: MIDI, warped audio, whole loop, eight beats                              |
| `native-listening-metric`               | Measurement capture for Session and Arrangement sources, repeats, and switching sources |
| `native-listening-metric-silent-tail`   | A clip that ends in silence                                                             |
| `native-listening-metric-long`          | Eight-bar and 30-second captures                                                        |
| `native-listening-descriptive`          | Arrangement ranges: fractional start, start-up, 30 seconds                              |
| `native-listening-rebinding`            | Capturing again after a device is inserted before the listener                          |
| `native-listening-dual`                 | Two listeners at once                                                                   |
| `native-listening-repeated`             | Listening to clips 1, 2, then 1 again in one Live session                               |
| `native-listening-source-investigation` | How Live reports the playing source after edits and Session overrides                   |
