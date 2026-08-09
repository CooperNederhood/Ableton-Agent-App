# Tool Design Implementation To-Do

Companion specification: [Tool Design](tool-design.md)

## Tool framework

- [x] Define typed tool metadata, risk, capability, and duration fields.
- [x] Build a tool factory around Copilot SDK custom tools.
- [ ] Standardize runtime validation and structured failure results.
- [ ] Standardize model-facing summaries and UI metadata.
- [ ] Add deferred/loading policy for large tool catalogs.
- [x] Ensure tools depend on application services, not raw sockets.

## Inspection tools

- [~] Implement project overview and capability tools.
- [ ] Implement track, clip, arrangement, and transport inspection.
- [~] Implement device/parameter, rack, Drum Rack, and browser inspection.
  - [x] Add read-risk bounded top-level device and exact-device parameter
    inspection for identity-bound regular tracks.
  - [x] Add read-risk bounded exact-rack chain/device and Drum Rack
    pad/chain/device inspection without recursive expansion.
- [ ] Implement external plug-in search with bounded cached results.

## Primitive mutation tools

- [~] Implement track and mixer operations.
  - [x] Implement approved MIDI/audio track creation.
  - [x] Implement destructive identity-bound track deletion.
  - [x] Implement identity-bound rename and normalized mixer controls.
  - [ ] Implement routing and group-aware structural operations.
- [~] Implement session clip and note operations.
  - [x] Implement approved MIDI clip creation in empty slots.
  - [x] Implement destructive bounded MIDI note replacement.
  - [x] Implement exact-reference clip launch, empty-slot duplication,
    destructive deletion, and conservative properties for existing MIDI and
    audio clips. Audio creation and file loading remain out of scope until
    separately capability-gated.
- [~] Implement arrangement placement and property operations.
  - [x] Implement approved non-overlapping MIDI clip placement.
  - [x] Implement bounded Arrangement inspection.
  - [x] Implement destructive identity-bound Arrangement clip deletion.
  - [x] Implement destructive bounded Arrangement MIDI note replacement.
  - [x] Implement reversible Session-to-Arrangement clip duplication.
  - [x] Implement reversible identity-bound Arrangement clip properties.
- [~] Implement browser/device load and parameter operations.
  - [x] Add reversible verified device enable/disable and normalized parameter
    mutation with quantized-value handling and rollback.
  - [ ] Add browser loading, device deletion, racks, Drum Rack, and plug-ins.
- [x] Implement transport, loop, and cue-point operations.
  - [x] Auto-approve bounded loop/cue inspection, classify loop updates and cue
    creation as reversible, and classify identity-bound cue deletion as
    destructive.

## Workflow tools

- [ ] Define a deterministic workflow transaction interface.
- [ ] Implement drum-pattern and chord-progression workflows.
- [ ] Implement song-section creation and variation.
- [ ] Implement mix change-set and preset audition workflows.
- [ ] Capture before-state, approval, execution, verification, and recovery.

## Tests

- [x] Unit-test schemas and formatting for every tool.
- [x] Unit-test risk and capability metadata completeness.
- [ ] Unit-test workflow ordering, partial failure, and compensation.
- [ ] Integration-test tools against fake and simulated bridges.
- [~] Add Copilot SDK invocation tests for representative tools.
- [ ] Validate every mutation against real Live before marking supported.
  - [ ] Validate Arrangement loop and cue-point LOM behavior in real Live.

## Exit criteria

- [ ] No accepted parameter is silently ignored.
- [ ] Large results are filtered or paginated.
- [x] Every mutation is classified and verified.
- [ ] CLI and React can render all tool outcomes from shared metadata.
