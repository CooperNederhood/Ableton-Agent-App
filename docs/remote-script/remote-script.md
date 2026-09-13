# Ableton Remote Script

## Responsibilities

The Remote Script is a narrow adapter between local protocol commands and the
Live Object Model.

It owns:

- Socket lifecycle inside Live.
- Authentication and protocol negotiation.
- Request decoding and response encoding.
- Main-thread scheduling.
- Command registration.
- LOM capability detection.
- LOM object serialization.
- Selected LOM listeners and outbound events.

It does not own:

- Agent prompts or model calls.
- User-facing prose.
- Production planning.
- Long-term project state.
- Third-party Python dependencies.
- Cloud communication.

## Structure

Avoid a single 2,000-line `__init__.py`. Organize the installable script while
remaining compatible with Ableton's loader:

```text
AbletonAgent/
├── __init__.py
├── control_surface.py
├── transport.py
├── protocol.py
├── executor.py
├── capabilities.py
├── serialization.py
└── commands/
    ├── session.py
    ├── tracks.py
    ├── clips.py
    ├── arrangement.py
    ├── devices.py
    └── browser.py
```

## Command registry

Use a registry rather than a central `if/elif` chain:

```python
@command("tracks.create_midi", mutates=True)
def create_midi_track(context, params):
    ...
```

Registry metadata should include:

- Command name.
- Mutation classification.
- Required capability.
- Timeout class.
- Validation function.
- Handler.

## Main-thread executor

All LOM access should flow through one executor:

1. Socket thread validates and enqueues work.
2. `schedule_message` schedules queue draining on Live's thread.
3. Handler performs bounded work.
4. Result is placed on a response queue.
5. Socket thread encodes and returns the response.

Large traversals such as browser discovery should be bounded and paginated.
Avoid blocking Live's thread for recursive full-tree scans.

Opaque bounded trace/correlation IDs from the request are carried through
queueing, main-thread execution, response, and outbound Live Events. Remote
Script logs and protocol metadata may record lifecycle and timing, but never
raw authentication, paths, or musical payloads. Journal persistence remains in
the application and must not add work to Live's main thread.

## LOM compatibility

The script should:

- Detect attributes with narrow capability checks.
- Avoid broad exception swallowing.
- Return `unsupported_capability` distinctly from operation failures.
- Keep serializers stable across versions.
- Maintain an explicit supported Live-version matrix.

Browser item identity remains exact across the search/load round trip. Runtime
reference, root, path, and name must match, while URI comparison treats
equivalent percent-encoded and decoded spellings as the same identity. A
materially different decoded URI remains a `stale_reference`.

Live may expose a loadable device such as Auto Filter as navigable because it
also has preset children. An item explicitly reported as both `is_device` and
`is_loadable` remains a supported device even when navigable. Navigable
non-device containers, unsupported media types, and external plug-ins remain
rejected before mutation.

## Live Set identity

The Remote Script derives project identity directly from the LOM:

- saved sets use a SHA-256 hash of `Song.file_path`, truncated to 24
  hexadecimal characters;
- unsaved sets use the same hash shape over `Song.name`, but explicitly report
  `saved: false`.

`project.get_identity` computes this value on demand and returns only
`projectId`, `projectName`, and `saved`. It never sends the raw filesystem path.
Capability negotiation and the dynamic command share the same helper so Save
As and reconnect behavior cannot use different identity rules.

## Events

The script has two listener layers:

- fixed low-frequency listeners that invalidate project state;
- dynamic user-defined Live Event subscriptions.

Dynamic subscriptions are installed and removed at runtime through validated
protocol commands. They initially support parameter value changes, playing and
triggered clip transitions, and recording-state transitions. The script
normalizes raw LOM values into semantic occurrences before publishing them.

Listeners must be removed during unsubscribe, client disconnect, Set
replacement, and script shutdown. Continuous parameter changes are coalesced
and bounded before crossing the socket. The application persists subscription
intent and reinstalls listeners after reconnect; runtime LOM references are not
durable.

See [Live Events](../events/live-events.md).

## Security

- Bind to `127.0.0.1`, never `0.0.0.0`.
- Require a per-installation authentication token.
- Reject requests before authentication completes.
- Limit frame size and queue depth.
- Validate every command and parameter.
- Never implement arbitrary Python evaluation or unrestricted filesystem access.
