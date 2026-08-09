# Tool Design Implementation To-Do

Companion specification: [Tool Design](tool-design.md)

## Tool framework

- [ ] Define typed tool metadata, risk, capability, and duration fields.
- [ ] Build a tool factory around Copilot SDK custom tools.
- [ ] Standardize runtime validation and structured failure results.
- [ ] Standardize model-facing summaries and UI metadata.
- [ ] Add deferred/loading policy for large tool catalogs.
- [ ] Ensure tools depend on application services, not raw sockets.

## Inspection tools

- [ ] Implement project overview and capability tools.
- [ ] Implement track, clip, arrangement, and transport inspection.
- [ ] Implement device/parameter, rack, Drum Rack, and browser inspection.
- [ ] Implement external plug-in search with bounded cached results.

## Primitive mutation tools

- [ ] Implement track and mixer operations.
- [ ] Implement session clip and note operations.
- [ ] Implement arrangement placement and property operations.
- [ ] Implement browser/device load and parameter operations.
- [ ] Implement transport, loop, and cue-point operations.

## Workflow tools

- [ ] Define a deterministic workflow transaction interface.
- [ ] Implement drum-pattern and chord-progression workflows.
- [ ] Implement song-section creation and variation.
- [ ] Implement mix change-set and preset audition workflows.
- [ ] Capture before-state, approval, execution, verification, and recovery.

## Tests

- [ ] Unit-test schemas and formatting for every tool.
- [ ] Unit-test risk and capability metadata completeness.
- [ ] Unit-test workflow ordering, partial failure, and compensation.
- [ ] Integration-test tools against fake and simulated bridges.
- [ ] Add Copilot SDK invocation tests for representative tools.
- [ ] Validate every mutation against real Live before marking supported.

## Exit criteria

- [ ] No accepted parameter is silently ignored.
- [ ] Large results are filtered or paginated.
- [ ] Every mutation is classified and verified.
- [ ] CLI and React can render all tool outcomes from shared metadata.

