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

## LOM compatibility

The script should:

- Detect attributes with narrow capability checks.
- Avoid broad exception swallowing.
- Return `unsupported_capability` distinctly from operation failures.
- Keep serializers stable across versions.
- Maintain an explicit supported Live-version matrix.

## Events

Initially emit a conservative event set:

- Song tempo/signature changed.
- Track list changed.
- Track name or mixer state changed.
- Selected track/clip changed.
- Transport state changed.
- Clip-slot occupancy changed.

Listeners must be removed during disconnect. High-frequency parameter events
require throttling and are not part of the first milestone.

## Security

- Bind to `127.0.0.1`, never `0.0.0.0`.
- Require a per-installation authentication token.
- Reject requests before authentication completes.
- Limit frame size and queue depth.
- Validate every command and parameter.
- Never implement arbitrary Python evaluation or unrestricted filesystem access.

