# IPC Protocol

## Goals

The protocol must provide:

- Unambiguous message framing.
- Request/response correlation.
- Protocol version negotiation.
- Structured errors.
- Capability discovery.
- Optional events from Ableton.
- Cross-platform local operation.
- Backward-compatible evolution.

## Transport

Use TCP bound to loopback for the first release because it works consistently
on macOS and Windows and is supported by Ableton's embedded Python.

Each message is:

```text
4-byte unsigned big-endian payload length
UTF-8 JSON payload
```

Set a conservative maximum payload size. Larger musical data should use
chunking or purpose-specific batching rather than unlimited frames.

## Envelope

Request:

```json
{
  "protocolVersion": 2,
  "kind": "request",
  "requestId": "uuid",
  "command": "clips.add_notes",
  "params": {},
  "projectRevision": 42
}
```

Success:

```json
{
  "protocolVersion": 2,
  "kind": "response",
  "requestId": "uuid",
  "ok": true,
  "result": {},
  "projectRevision": 43,
  "warnings": []
}
```

Failure:

```json
{
  "protocolVersion": 2,
  "kind": "response",
  "requestId": "uuid",
  "ok": false,
  "error": {
    "code": "stale_reference",
    "message": "The target track changed after the snapshot was created.",
    "retryable": true,
    "details": {}
  }
}
```

Event:

```json
{
  "protocolVersion": 2,
  "kind": "event",
  "event": "tracks.changed",
  "sequence": 104,
  "payload": {},
  "projectRevision": 44
}
```

## Handshake

The client begins with `system.hello` containing:

- Authentication token.
- Supported protocol versions.
- App version.
- Requested event subscriptions.

The Remote Script returns:

- Selected protocol version.
- Remote Script version.
- Ableton version.
- Project identity.
- Capability document.
- Limits such as maximum frame and batch size.

## Error taxonomy

Initial stable error codes:

- `authentication_failed`
- `protocol_version_unsupported`
- `invalid_request`
- `unknown_command`
- `invalid_params`
- `unsupported_capability`
- `not_found`
- `ambiguous_reference`
- `stale_reference`
- `conflict`
- `operation_timeout`
- `queue_full`
- `lom_error`
- `internal_error`

## Schema ownership

TypeScript schemas are canonical for the application packages. Export JSON
Schema fixtures and validate them against Python-side parsing in contract tests.
Do not rely on manually synchronized interfaces.

## Compatibility rules

- `system.hello` selects the highest version present in both the client's
  `supportedProtocolVersions` and the Remote Script's available versions. No
  overlap returns `protocol_version_unsupported` and the connection is not
  authenticated.
- Request IDs are UUIDs unique for the lifetime of a client process. A
  response repeats exactly one request ID; unknown or duplicate responses are
  ignored by the client.
- Event sequences are monotonically increasing per Remote Script process. The
  first event after a connection may have any non-negative sequence; every
  subsequent event must increment by one. A gap invalidates incremental cache
  assumptions and requires targeted refresh.
- Project revisions are monotonically increasing observations of meaningful
  LOM changes. Clients attach their latest revision to requests. Responses and
  events advance the client's revision; exact-reference mutations still
  perform their own identity checks.
- Additive result fields are backward compatible.
- New optional request fields are backward compatible when old peers can
  ignore them. New required fields, removed fields, narrowed values, changed
  defaults, and changed error semantics are breaking.
- Existing field meanings cannot change within a protocol version.
- New commands do not require a protocol bump.
- Framing, envelope, or semantic changes require a new protocol version.
- Capability negotiation handles Live-version differences separately from
  protocol versions.
