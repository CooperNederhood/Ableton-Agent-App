# Remote Script Implementation To-Do

Companion specification: [Remote Script](remote-script.md)

## Script foundation

- [x] Create the modular `AbletonAgent` Remote Script package.
- [x] Implement `create_instance`, ControlSurface lifecycle, logging, and
  disconnect cleanup.
- [x] Bind only to `127.0.0.1`.
- [x] Load/generate the installation authentication token safely.
- [x] Implement bounded socket, client, request, and response queues.

## Protocol and execution

- [x] Register and validate exact bounded read-only Session source inspection;
  retain unknown values and signed origins, report selected/queued identities,
  revalidate targets after reads, and expose no launch/readiness authority.
- [x] Cover strict inputs, missing/nonfinite metadata, clip replacement, source
  kind/units, queued-state distinction and a different selected clip in Python;
  exercise the production handler in simulator bridge tests and fresh Live 11.
- [x] Implement four exact guarded Session pass commands; classify only launch
  as a project mutation and retain unrelated revision guards after prepare.
- [x] Admit unknown follow state only with pass-owned public monitors and an
  explicit message-rate limitation; deny known enabled follow actions.
- [x] Require capture strictly before both loop end and natural end, without
  trimming or treating callback receipt as an exact transition timestamp.
- [x] Retain actual-origin/first-invalidation ledgers, bounded forty-second
  expiry, five-second launch readback, and 32 idempotent closed-pass receipts.
- [x] Clear pass monitors in scheduled client-disconnect and script-shutdown
  paths; cover deferred-fire fencing, dispatched leave-running behavior,
  repeated cleanup and removal failures without skipping other cleanup.
- [x] Include granular pass registration in cross-language catalog/fixture
  validation and keep source/native alignment authority separate.
- [x] Use explicit event-assisted `Clip.start_time` polling for the legacy
  get-only property, never require an origin listener, and disclose missed
  between-observation changes while retaining mandatory real subscriptions.
- [x] Cover get-only source success, tick/inspect origin-drift invalidation,
  unreadable origin and missing-listener refusal, and cleanup without origin
  subscription/removal calls.
- [x] Normalize Clip launch quantization through the installed public
  `ClipLaunchQuantization` named members; reject missing/ambiguous metadata
  and cover shifted native Global/1 Bar encodings without guessing raw `5`.
- [x] Qualify the guarded source/native join for MIDI and warped audio through
  reviewed real-Live scenarios and the Session group. Keep contract-representable
  candidates separate from application admission: only Global None at stopped
  beat zero is currently enabled; all one-bar/nonzero anchors are refused before
  source preparation. Message-rate monitors do not certify undetected edits,
  disabled unknown follow actions or physical/sample-accurate source onset.
  Record the full installed Live 11 version and probe actual Python event
  add/remove pairs, get-only origin reads, sampled onset/drift and cleanup;
  current LOM documentation does not prove Live 11 Python notification support.
- [ ] Record native clip launch quantization type/raw value plus
  `q_global`/`q_bar`/`q_none` on a fresh owned Live 11 process. Confirm
  normalization against the actual enum and clip setting, not serialized
  `LaunchQuantisation` or new-clip defaults.

- [x] Implement framed decoder/encoder compatible with protocol fixtures.
- [x] Implement handshake, authentication, version negotiation, and limits.
- [x] Implement declarative command registry and metadata.
- [x] Implement the single main-thread LOM executor.
- [x] Route reads and mutations through the executor.
- [x] Implement per-command validation and stable error mapping.
- [x] Publish complete bounded Live Set/Project identity with settled save
  observations so first save and Save As can update clients atomically.
- [~] Implement capability discovery by Live version and attribute checks.
- [ ] Preserve bounded opaque trace/correlation context through queue,
  main-thread execution, response, and outbound Live Event lifecycle metadata.

## LOM modules

- [~] Implement system/session/transport serialization.
  - [x] Inspect Arrangement loop state and bounded cue-point pages; update loop
    enable/start/length with finite validation, verification, and rollback.
  - [x] Create reversible cue points and destructively delete identity-bound
    cue points using runtime-stable references where Live exposes no IDs.
  - [x] Add seek/jump, time signature, metronome, launch/record quantization,
    capability-gated Link, cue rename/jump, and Back to Arrangement.
  - [x] Verify explicit global Back to Arrangement on one scheduled tick, with
    one property assignment, unchanged typed result shape, request-attributed
    lifecycle/timing and bounded failure diagnostics. Never fake rollback by
    writing the aggregate highlight true. Add delayed-success, permanent-denial,
    exact-response attribution and queued-cancellation regressions.
  - [x] Verify deferred global command in fresh owned recovery run `5e7f9759`
    (`0d82504`, observed 11.3.43): one scheduled true-to-false assignment and
    independent clear-source reads precede the new accepted native capture.
    Retain earlier immediate-verification failure `1fccf46b`; current-policy
    runner qualification is separate from stale exact-patch evidence labels.
  - [x] Verify Arrangement duplication and cue-point creation with proxy-safe
    before/after collection deltas, stage-specific failures, and explicit
    rolled-back versus applied-indeterminate outcomes.
  - [x] Match cue proxies by their unique Arrangement time when Live returns
    fresh wrappers, and report read-only cue naming on Live 11.3.43 as an
    unsupported naming stage after verified rollback.
  - [x] Bound each main-thread executor drain so queued LOM work yields between
    batches instead of monopolizing one Live callback, and log bounded queued,
    started, completed, failed, cancelled, queue-depth, and duration fields.
- [~] Implement track and mixer handlers.
  - [x] Create MIDI/audio tracks with optional names and verified postconditions.
  - [x] Delete identity-bound non-group tracks with last-track protection.
  - [x] Rename identity-bound tracks and update verified mixer state.
  - [x] Implement return/master/group-aware inspection, return creation,
    regular-track duplication, monitoring/fold/state actions, mixer controls,
    bounded meters, and snapshot-bound routing assignment.
  - [x] Resolve equivalent routing wrappers by stable Live routing identifier
    across input/output types and channels, fail closed on ambiguous current
    state, and retain exact snapshot-token assignment.
- [~] Implement session clip and MIDI-note handlers.
  - [x] Create guarded MIDI clips in empty Session View slots.
  - [x] Replace bounded MIDI note sets with full-note verification and recovery.
  - [x] Launch exact Session clips with conservative playback recovery,
    duplicate MIDI/audio clips into exact empty destinations with rollback,
    delete exact clips with postcondition checks, and restore failed common
    property updates.
  - [ ] Validate launch quantization, cross-track duplication compatibility,
    audio mute/loop properties, and rollback timing in supported real Live
    versions.
  - [x] Add modern note-ID query/add/update/remove/duplicate/quantize operations
    and audio metadata/gain/pitch/warp/marker/RAM operations with read-only warp
    markers.
  - [x] Treat note-ID removal as destructive and non-retryable when application
    cannot be verified, accept scheduled quantized track stops, and order audio
    range assignment and rollback against current bounds.
  - [x] Enforce Live 11 quantization/pitch domains and exact currently available
    warp-mode selection.
- [~] Implement arrangement handlers.
  - [x] Create non-overlapping MIDI clips with verified placement and rollback.
  - [x] Inspect Arrangement clips with bounded pagination.
  - [x] Delete identity-bound Arrangement clips with postcondition checks.
  - [x] Replace bounded Arrangement MIDI notes with verification and recovery.
  - [x] Duplicate identity-bound Session clips to non-overlapping Arrangement
    destinations with verification and rollback.
  - [x] Fill a bounded Arrangement region transactionally through one deferred
    command, yielding after four tiles per Live tick and rolling back the whole
    batch after any failure.
  - [x] Keep region fill complete-tile-only because Live 11.3.43 marker
    boundaries do not change the read-only Arrangement `end_time`.
  - [x] Update supported Arrangement clip properties with full rollback.
- [~] Implement device, rack, Drum Rack, and parameter handlers.
  - [x] Inspect top-level regular-track devices and exact-device parameters
    with independent bounded pages and runtime-stable references.
  - [x] Batch runtime-reference allocation for bounded device-parameter pages
    so one inspection does not repeatedly rescan every reachable Set parameter
    and stall subsequent bridge commands.
  - [x] Enable/disable devices through the exposed `Device On` parameter and
    set exact enabled/writable parameters from normalized values with
    quantization, verification, and rollback.
  - [x] Inspect one exact top-level rack through independently bounded direct
    chain, chain-device, Drum Rack pad, pad-chain, and pad-chain-device pages
    with runtime-stable pruned references and no recursive traversal.
  - [x] Add Live 11 `find_device_position` preflight and verified
    `move_device` support within/between regular tracks and existing rack or
    Drum Rack pad chains, including same-parent index translation in forward
    moves and recovery.
  - [x] Add exact existing-chain name/palette-index and exposed
    mute/solo/volume/pan/send mutation with verification and rollback.
  - [ ] Keep empty-chain creation, direct native insertion, single-chain
    deletion, and chain reordering unsupported until separately approved APIs
    and semantics exist.
  - [ ] Add separately designed nested-rack traversal.
- [x] Implement bounded Browser root/category pages, deterministic
  breadth-first search with node/result/depth/time limits, a 512-entry
  runtime-reference cache, exact path/URI revalidation, and verified built-in
  device loading on selected identity-bound regular tracks.
  - [x] Normalize equivalent Browser URI encodings during identity
    revalidation and allow explicitly loadable devices that expose preset
    children while retaining container and external-content guards.
- [x] Implement selected low-frequency LOM listeners and cleanup.
- [x] Observe stable Live Set save metadata without reading or exposing `.als`
  paths/content, including first save, Save As, Set-switch baselines, temporary
  absence, reconnect baselines, and shutdown cancellation.

## Tests

- [x] Add guarded Arrangement positioning-before-arm with deferred independent
  marker/position reads, no redundant writes, source/revision/safety checks,
  explicit partial failures, no start/stop/rollback and simulator persistence.
- [ ] Qualify the new positioning command through the integrated ordinary
  listening host against a fresh runner-owned Live 11 process.

- [~] Build fake Song, Track, Clip, Device, Browser, and Application objects.
- [x] Add capability-detected recording, grooves, selection/view, Live history,
  Session automation, warp-marker, Browser adapter, specialized-device, and
  workflow-job handlers with exact identity and readback.
- [x] Add curated state listeners with topology rebinding, bounded/coalesced
  meters, initial snapshots, and complete cleanup.
- [ ] Record real-Live evidence for every optional private Browser, Simpler,
  Looper, Wavetable, envelope, and warp-marker API shape before enabling it in
  release builds.
- [~] Unit-test every handler's validation, success, and LOM failure paths.
- [~] Unit-test main-thread scheduling and timeout behavior.
- [x] Unit-test listener registration and removal.
- [x] Unit-test save metadata stability, debounce, bounds, Save As, Set switch,
  unavailable files, and cancellation.
- [x] Run Python protocol contract fixtures.
- [ ] Test trace propagation, lifecycle timing/redaction, and zero journal I/O
  or unbounded observability work on Live's main thread.
- [ ] Add real-Live tests for each uncertain API and supported version.
  - [ ] Validate cue-point object identity, create/delete return behavior,
    naming, loop setter ordering, and rollback against supported Live versions.
  - [ ] Validate Device On identity/order/localization, parameter writability,
    quantized value mapping, setter failures, and rollback in supported Live
    versions.
  - [ ] Validate rack/Drum Rack capability properties, chain/pad ordering and
    object identity, empty pads, pad-chain exposure, and chain device access in
    supported Live versions.
  - [ ] Validate Live 11 device movement and chain mixer/property behavior
    against real Live using the checked-in capability matrix.
  - [ ] Validate Browser roots and BrowserItem properties, URI/object
    stability, child ordering and latency, selected-track targeting,
    `Browser.load_item` timing, hotswap state, track compatibility,
    multi-device presets, and load failure timing in supported Live versions.
- [x] Test that browser operations remain bounded and responsive in unit and
  simulator coverage.

## Exit criteria

- [x] Implement bounded, main-thread guarded Arrangement seek/continue with
  explicit leave-running cleanup policy and no ownership/stop token.
- [x] Cover changed Set/revision/targets, unknown recording/source state,
  partial mutations, ordering and no rollback using Python and bridge simulators.
- [ ] Validate guarded Arrangement start against runner-owned installed Live 11,
  recording its actual full version (current development host: 11.3.43);
  native capture timing and Session sounding onset remain unverified.

- [x] No model, cloud, MCP, or third-party dependency exists in the script.
- [x] All commands are registered, validated, scheduled, and tested.
- [x] Disconnect leaves no listeners, sockets, or active client threads.
- [ ] Supported Live versions produce an accurate capability report.
# Live identity terminology

- [x] Expose explicit Live Set identity and optional nearest-ancestor Live
  Project identity without transmitting filesystem paths.
- [x] Keep unsaved Set IDs collision-resistant and stable for the Remote Script
  runtime, and bound orphan-Set diagnostics.
- [x] Scope dynamic Live Event stale guards to `liveSetId`.
