# Agent Skills

## Format and discovery

Skills follow the canonical Agent Skills layout:

```text
skills/
  skill-name/
    SKILL.md
```

`SKILL.md` begins with YAML frontmatter containing a lowercase `name` and a
short `description`. The Markdown body contains reusable Ableton instructions.
The application validates metadata for display and passes the root directory to
the Copilot SDK through `skillDirectories`.

## Agent configuration

An agent definition opts into skills by name:

```yaml
skills:
  - midi-composition
```

The SDK eagerly loads those skills into that agent's context. Skills are
opt-in; active agents do not receive every installed skill automatically.
Unknown skills invalidate the definition.

## Direct invocation

The Desktop composer supports:

```text
/midi-composition
/midi-composition write a sparse two-bar answer phrase
```

Slash invocation is available only when the selected active agent configures
that skill. The application validates the command locally and starts a turn
that explicitly invokes the already loaded skill. Raw skill contents are not
copied into renderer state.

## Built-in skills

The initial resource set includes:

- `midi-composition`
- `arrangement-planning`
- `sound-design`
- `mix-review`

Skills package domain guidance. Tool access and edit authority remain governed
by the active agent's tool set and edit scope.
