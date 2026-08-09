# ADR 0004: TypeScript and Python Schema Ownership

## Status

Accepted.

## Decision

Zod schemas in `@ableton-agent/protocol` are canonical for application-owned
messages and command contracts. The dependency-free Python Remote Script
implements matching validation suitable for Ableton's embedded interpreter.

The protocol package publishes a command catalog and will export fixtures and
JSON Schema for cross-language contract tests. Python must not gain third-party
runtime dependencies to consume the TypeScript definitions.

## Consequences

- Contract generation and compatibility checks belong in CI.
- Protocol changes are additive within a version; breaking changes require a
  negotiated version bump.
- Real LOM capability differences remain runtime capability data, not schema
  forks.
