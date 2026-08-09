# Remote Script Implementation To-Do

Companion specification: [Remote Script](remote-script.md)

## Script foundation

- [x] Create the modular `AbletonAgent` Remote Script package.
- [ ] Implement `create_instance`, ControlSurface lifecycle, logging, and
  disconnect cleanup.
- [ ] Bind only to `127.0.0.1`.
- [ ] Load/generate the installation authentication token safely.
- [ ] Implement bounded socket, client, request, and response queues.

## Protocol and execution

- [x] Implement framed decoder/encoder compatible with protocol fixtures.
- [ ] Implement handshake, authentication, version negotiation, and limits.
- [ ] Implement declarative command registry and metadata.
- [ ] Implement the single main-thread LOM executor.
- [ ] Route reads and mutations through the executor.
- [ ] Implement per-command validation and stable error mapping.
- [ ] Implement capability discovery by Live version and attribute checks.

## LOM modules

- [ ] Implement system/session/transport serialization.
- [ ] Implement track and mixer handlers.
- [ ] Implement session clip and MIDI-note handlers.
- [ ] Implement arrangement handlers.
- [ ] Implement device, rack, Drum Rack, and parameter handlers.
- [ ] Implement paginated browser handlers and loading.
- [ ] Implement selected low-frequency LOM listeners and cleanup.

## Tests

- [ ] Build fake Song, Track, Clip, Device, Browser, and Application objects.
- [ ] Unit-test every handler's validation, success, and LOM failure paths.
- [ ] Unit-test main-thread scheduling and timeout behavior.
- [ ] Unit-test listener registration and removal.
- [ ] Run Python protocol contract fixtures.
- [ ] Add real-Live tests for each uncertain API and supported version.
- [ ] Test that browser operations remain bounded and responsive.

## Exit criteria

- [ ] No model, cloud, MCP, or third-party dependency exists in the script.
- [ ] All commands are registered, validated, scheduled, and tested.
- [ ] Disconnect leaves no listeners, sockets, or active client threads.
- [ ] Supported Live versions produce an accurate capability report.
