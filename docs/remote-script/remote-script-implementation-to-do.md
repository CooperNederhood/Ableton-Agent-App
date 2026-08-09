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

- [x] Implement framed decoder/encoder compatible with protocol fixtures.
- [x] Implement handshake, authentication, version negotiation, and limits.
- [x] Implement declarative command registry and metadata.
- [x] Implement the single main-thread LOM executor.
- [x] Route reads and mutations through the executor.
- [x] Implement per-command validation and stable error mapping.
- [~] Implement capability discovery by Live version and attribute checks.

## LOM modules

- [~] Implement system/session/transport serialization.
  - [x] Inspect Arrangement loop state and bounded cue-point pages; update loop
    enable/start/length with finite validation, verification, and rollback.
  - [x] Create reversible cue points and destructively delete identity-bound
    cue points using runtime-stable references where Live exposes no IDs.
- [~] Implement track and mixer handlers.
  - [x] Create MIDI/audio tracks with optional names and verified postconditions.
  - [x] Delete identity-bound non-group tracks with last-track protection.
  - [x] Rename identity-bound tracks and update verified mixer state.
  - [ ] Implement routing and group-aware structural operations.
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
- [~] Implement arrangement handlers.
  - [x] Create non-overlapping MIDI clips with verified placement and rollback.
  - [x] Inspect Arrangement clips with bounded pagination.
  - [x] Delete identity-bound Arrangement clips with postcondition checks.
  - [x] Replace bounded Arrangement MIDI notes with verification and recovery.
  - [x] Duplicate identity-bound Session clips to non-overlapping Arrangement
    destinations with verification and rollback.
  - [x] Update supported Arrangement clip properties with full rollback.
- [~] Implement device, rack, Drum Rack, and parameter handlers.
  - [x] Inspect top-level regular-track devices and exact-device parameters
    with independent bounded pages and runtime-stable references.
  - [x] Enable/disable devices through the exposed `Device On` parameter and
    set exact enabled/writable parameters from normalized values with
    quantization, verification, and rollback.
  - [x] Inspect one exact top-level rack through independently bounded direct
    chain, chain-device, Drum Rack pad, pad-chain, and pad-chain-device pages
    with runtime-stable pruned references and no recursive traversal.
  - [ ] Add return/group tracks and separately designed nested-rack traversal.
- [x] Implement bounded Browser root/category pages, deterministic
  breadth-first search with node/result/depth/time limits, a 512-entry
  runtime-reference cache, exact path/URI revalidation, and verified built-in
  device loading on selected identity-bound regular tracks.
- [x] Implement selected low-frequency LOM listeners and cleanup.

## Tests

- [~] Build fake Song, Track, Clip, Device, Browser, and Application objects.
- [~] Unit-test every handler's validation, success, and LOM failure paths.
- [~] Unit-test main-thread scheduling and timeout behavior.
- [x] Unit-test listener registration and removal.
- [x] Run Python protocol contract fixtures.
- [ ] Add real-Live tests for each uncertain API and supported version.
  - [ ] Validate cue-point object identity, create/delete return behavior,
    naming, loop setter ordering, and rollback against supported Live versions.
  - [ ] Validate Device On identity/order/localization, parameter writability,
    quantized value mapping, setter failures, and rollback in supported Live
    versions.
  - [ ] Validate rack/Drum Rack capability properties, chain/pad ordering and
    object identity, empty pads, pad-chain exposure, and chain device access in
    supported Live versions.
  - [ ] Validate Browser roots and BrowserItem properties, URI/object
    stability, child ordering and latency, selected-track targeting,
    `Browser.load_item` timing, hotswap state, track compatibility,
    multi-device presets, and load failure timing in supported Live versions.
- [x] Test that browser operations remain bounded and responsive in unit and
  simulator coverage.

## Exit criteria

- [x] No model, cloud, MCP, or third-party dependency exists in the script.
- [x] All commands are registered, validated, scheduled, and tested.
- [x] Disconnect leaves no listeners, sockets, or active client threads.
- [ ] Supported Live versions produce an accurate capability report.
