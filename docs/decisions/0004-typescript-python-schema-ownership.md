# ADR 0004: TypeScript and Python Schema Ownership

## Status

Accepted.

## Decision

Zod schemas in `@ableton-agent/protocol` are canonical for application-owned
messages and command contracts. The dependency-free Python Remote Script
implements matching validation suitable for Ableton's embedded interpreter.

The protocol package publishes a command catalog that cross-language contract
tests check the Python side against. The Remote Script has no third-party
Python dependencies.

## Consequences

- `pnpm contracts:check` compares the two sides.
- Protocol changes are additive within a version; breaking changes require a
  negotiated version bump.
- Real LOM capability differences remain runtime capability data, not schema
  forks.
