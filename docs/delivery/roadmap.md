# Delivery Roadmap

## Phase 0: foundation and validation

Deliverables:

- Confirm supported Ableton and OS matrix.
- Build a minimal CLI chat client around Copilot SDK custom tools.
- Prototype framed bridge communication with a minimal Remote Script.
- Validate main-thread LOM scheduling.
- Validate Electron main-process SDK hosting.
- Define the shared interaction contract that both CLI and React implement.
- Record architecture decisions.

Exit criteria:

- A prompt can call a custom tool that reads session info from Live.
- The CLI streams agent output and tool progress.
- Connection failure is surfaced cleanly.
- The CLI exits cleanly and supports a non-interactive smoke-test command.
- The minimum chat, event, status, and approval contracts are presentation
  independent.

## Phase 1: protocol and bridge

Deliverables:

- Versioned framed protocol.
- Authentication handshake.
- Capability negotiation.
- TypeScript bridge.
- Python command registry and executor.
- Simulator and contract-test harness.
- CLI connection and capability commands.

Exit criteria:

- Contract and fragmentation tests pass.
- Reconnection does not leak pending requests.
- All LOM access uses the executor.
- The CLI can exercise every initial bridge command without Electron.

## Phase 2: core inspection and editing

Deliverables:

- Project snapshot.
- Track and transport operations.
- Session MIDI clips and notes.
- Arrangement inspection and placement.
- Structured tool catalog.
- CLI operation timeline.
- Initial Electron chat and operation timeline implementing the same reference
  interaction contract.

Exit criteria:

- Core workflows work against a real test project.
- Every mutation verifies postconditions.
- No broad action runs without approval.

## Phase 3: devices, browser, and sound design

Deliverables:

- Device and parameter inspection.
- Normalized parameter setting.
- Enable/disable/delete device.
- Rack chains and Drum Rack pads.
- Paginated browser navigation.
- Built-in and external plug-in loading.
- URI caching outside Live where possible.

Exit criteria:

- Browser operations do not freeze Live.
- Ambiguous devices and plug-ins are never silently selected.
- Capability differences are reflected in UI/tool availability.

## Phase 4: workflow engine and production UX

Deliverables:

- Structured production plan.
- Compose, Arrange, Sound, and Mix modes.
- Transactional musical workflows.
- Change sets and recovery actions.
- Plan preview and approval UI.
- Project-aware session persistence.

Exit criteria:

- A user can turn an existing loop into a reviewed arrangement plan and execute
  it section by section.
- Partial failure has a clear recovery path.

## Phase 5: hardening and release

Deliverables:

- Signed macOS and Windows builds.
- Remote Script installer/updater.
- Diagnostics and support bundle.
- Privacy settings and optional telemetry.
- Real-Live compatibility suite results.
- Security review and performance profiling.

Exit criteria:

- Installation succeeds on clean supported systems.
- Upgrade and incompatible-version flows are tested.
- Critical end-to-end tests pass.
- Known limitations are documented.

## Later opportunities

- Optional MCP adapter backed by the same bridge.
- Audio waveform or piano-roll visual previews.
- Reference-track analysis through separate local services.
- Multi-agent production workflows where specialization proves valuable.
- Controller and low-latency parameter surfaces using a separately designed
  real-time channel.
- Collaborative project plans and reusable production templates.

## Prioritization rule

Prefer reliability and observability over tool count. A small set of operations
that are typed, verified, recoverable, and pleasant in the UI is more valuable
than reproducing every MCP-era endpoint without improving its engineering.
