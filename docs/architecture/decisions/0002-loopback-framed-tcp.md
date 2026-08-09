# ADR 0002: Loopback Framed TCP Bridge

## Status

Accepted.

## Decision

The desktop or CLI connects to the Ableton Remote Script over authenticated,
loopback-only TCP. Each message is UTF-8 JSON prefixed by a four-byte unsigned
big-endian payload length.

The first request negotiates the protocol version and authenticates with a
per-installation secret. The Remote Script schedules every LOM operation on
Live's main thread.

## Consequences

- Message boundaries are deterministic under fragmentation and concatenation.
- The bridge remains independent of MCP and Electron.
- Frame limits, version negotiation, authentication, and decoder fuzzing are
  release-critical protocol concerns.
