# ADR 0001: Electron Security Boundary

## Status

Accepted.

## Decision

Electron main owns Copilot, Ableton transport, persistence, credentials, and
installation services. The renderer uses a narrow validated preload API with
context isolation and sandboxing enabled and Node integration disabled.

The renderer never receives a generic IPC, filesystem, socket, or process
escape hatch. CLI and desktop compose the same headless application services;
the renderer does not execute terminal code.

## Consequences

- Privileged operations remain testable outside React.
- New renderer capabilities require an explicit typed IPC contract.
- Main/preload integration requires dedicated security tests.
