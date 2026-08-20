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
The application validates metadata for discovery while retaining the trusted
main-process source path needed to load the body on demand. Skill bodies and
source paths are not copied into renderer state.

## Agent configuration

An agent definition opts into skills by name:

```yaml
skills:
  - midi-composition
```

The application adds only the enabled skills' `name` and `description`
frontmatter to the agent's system message. When a description is relevant, the
agent can call `skill(skill_name="skill-name")`. The tool returns the Markdown
body only after verifying that the requested skill is enabled in that agent's
definition. Unknown skills invalidate the definition.

## Direct invocation

The Desktop composer supports:

```text
/midi-composition
/midi-composition write a sparse two-bar answer phrase
```

Every valid catalog skill is available for explicit slash invocation, even when
it is not enabled for model-driven use by the selected agent. `/skill-name`
loads the skill by itself; text after the name asks the agent to apply the skill
to that request. The application validates the command and loads the body in
the main process before starting the user turn. Raw skill contents are not
copied into renderer state.

The two authorization paths are intentionally different: agent-driven
`skill(...)` calls use the agent definition's allowlist, while user-driven slash
commands use the complete validated catalog.

## Built-in skills

The initial resource set includes:

- `midi-composition`
- `arrangement-planning`
- `sound-design`
- `mix-review`

Skills package domain guidance. Tool access and edit authority remain governed
by the active agent's tool set and edit scope.
