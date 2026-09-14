# Tool Design Implementation To-Do

Companion specification: [Tool Design](tool-design.md)

## Tool framework

- [x] Define typed tool metadata, risk, capability, and duration fields.
- [x] Build a tool factory around Copilot SDK custom tools.
- [x] Standardize runtime validation and structured failure results.
  - [x] Preserve bounded code, message, retryability, and sanitized details
    across the Copilot SDK custom-tool boundary without throwing away the
    model/UI-visible failure.
- [x] Standardize model-facing summaries and UI metadata.
- [x] Add deferred/loading policy for large tool catalogs.
  - The initial bounded catalog remains eagerly registered; expansion beyond
    the current catalog requires grouped/deferred registration.
- [x] Ensure tools depend on application services, not raw sockets.
- [~] Require every tool/workflow to declare sanitized lifecycle events, safe
  payload summaries, trace propagation, and queue/execution timing.
  - [x] Add reusable action-aware operation descriptors and application-owned
    requested/policy/queued/started/verification/completed/failed/cancelled
    events for the first Live 11 device/rack slice.
  - [ ] Migrate the older tool families and add complete persisted timing and
    trace-continuity coverage.

## Inspection tools

- [~] Implement project overview and capability tools.
- [x] Implement track, clip, arrangement, and transport inspection.
- [~] Implement device/parameter, rack, Drum Rack, and browser inspection.
  - [x] Add read-risk bounded top-level device and exact-device parameter
    inspection for identity-bound regular tracks.
  - [x] Add read-risk bounded exact-rack chain/device and Drum Rack
    pad/chain/device inspection without recursive expansion.
  - [x] Add read-risk Browser root/direct-child inspection and deterministic
    bounded search with explicit truncation reporting.
- [x] Implement external plug-in search with bounded runtime-cached results.

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
  - [x] Add reversible exact-item Browser device/device-preset loading across
    roots with track/item identity gates, semantic load classification,
    before/after state, and postcondition verification.
  - [x] Add Live 11 destination preflight and verified movement/reordering for
    existing devices across regular tracks and existing rack/Drum Rack chains,
    including pre-removal index translation during same-parent rollback.
  - [x] Add verified, rollback-capable rename/palette-index and exposed mixer
    edits for existing rack and Drum Rack pad chains.
  - [ ] Add explicit sample, clip, and groove destination tools, device
    deletion, separately designed plug-in loading, empty-chain creation,
    single-chain deletion, and chain reordering.
- [x] Implement transport, loop, and cue-point operations.
  - [x] Auto-approve bounded loop/cue inspection, classify loop updates and cue
    creation as reversible, and classify identity-bound cue deletion as
    destructive.

## Workflow tools

- [x] Define a deterministic workflow transaction interface.
- [x] Implement drum-pattern and chord-progression workflows.
- [x] Implement song-section creation and variation.
- [x] Implement mix change-set and preset audition workflows.
- [x] Capture before-state, approval, execution, verification, and recovery.

## Tests

- [x] Unit-test schemas and formatting for every tool.
- [x] Unit-test risk and capability metadata completeness.
- [x] Unit-test workflow ordering, partial failure, and compensation.
- [x] Integration-test tools against fake and simulated bridges.
- [~] Add Copilot SDK invocation tests for representative tools.
  - [x] Cover structured Ableton failure results and application event
    recovery when the SDK reports the generic `failure` event code.
- [ ] Test journal lifecycle completeness, redaction, trace continuity, timing,
  cancellation/failure, and Desktop History visibility for every tool family.
- [x] Test descriptor-based argument resolution and affected-track
  authorization/locking for cross-track device movement.
- [ ] Validate every mutation against real Live before marking supported.
  - [ ] Validate Arrangement loop and cue-point LOM behavior in real Live.

## Exit criteria

- [x] No accepted parameter is silently ignored.
- [x] Large results are filtered or paginated.
- [x] Every mutation is classified and verified.
- [x] CLI and React can render all tool outcomes from shared metadata.
