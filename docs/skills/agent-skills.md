# Agent Skills

## Format and discovery

Skills follow the canonical Agent Skills layout:

```text
skills/
  skill-name/
    SKILL.md
```

The bundled `set-history-sql-search` skill documents the local Set History
public views and safe query workflow. It reinforces that historical snapshots
are evidence and that agents must inspect the current Live Set before acting.

Skills are resolved through Session, Profile, System, and immutable bundled
sources in that order. Lower scopes store a physical `SKILL.md` only after an
explicit copy or edit. A local tombstone may hide an inherited skill. Semantic
rename updates the skill frontmatter and same-scope agent references as one
validated operation.

`SKILL.md` begins with YAML frontmatter containing a lowercase `name` and a
short `description`. The Markdown body contains reusable Ableton instructions.
The application validates metadata for discovery while retaining the trusted
main-process source path needed to load the body on demand. Skill bodies and
source paths are not copied into renderer state.

The Desktop **Skills** tab uses the same effective catalog as Profiles. Its
left navigator selects a resolved skill; the detail pane shows immutable
published `name` and `description` metadata and an editable Markdown body.
Creating a skill starts an unpublished draft whose name, description, and body
can all be edited. The metadata becomes immutable after the first successful
publication.

Every create or save from Skills writes a Session-scope `SKILL.md` for the
active production session. Editing an inherited skill is copy-on-write:
Profile, System, and bundled sources are never changed. Publication is staged,
validated against the complete layered catalog, and rolled back on failure.
Profiles and the effective skill navigator refresh from the same result.

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

This is the application-owned `custom:skill` tool. The Copilot SDK's
`builtin:skill` implementation is deliberately excluded even when a custom
agent uses the global `*` tool pattern, so skill loading always follows the
same validated progressive-disclosure path.

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

Newly published Session skills enter the Workspace `/` completion list
immediately. Both direct slash invocation and the application-owned `skill`
tool resolve the current effective scoped skill by production session and name
at invocation time. A saved body is therefore used on the next invocation
without resetting or reconfiguring the active Agent conversation. Model-driven
loads still require the skill name in the active Agent definition's allowlist.
Changing production sessions invalidates the previous session's catalog before
the Skills editor or Workspace completion list can read from it.

The two authorization paths are intentionally different: agent-driven
`skill(...)` calls use the agent definition's allowlist, while user-driven slash
commands use the complete validated catalog.

When either path runs in plan mode, the application appends the canonical
`packages/application/prompts/plan-reminder.md` content after the expanded skill
body and user request. Edit-oriented skill instructions therefore describe
post-approval implementation and do not supersede the active read-only mode.
Interactive skill turns are sent without this suffix.

## Built-in skills

The initial resource set includes:

- `midi-composition`
- `techno-arrangement-planning`
- `sound-design`
- `mix-review`

The techno arrangement skill inspects the current Arrangement, classifies it as
beginner, intermediate, or advanced using phrase, energy, evolution,
transition, identity, and DJ-function criteria, and returns bar-specific
recommendations for reaching the next level.

Skills package domain guidance. Tool access and edit authority remain governed
by the active agent's tool set and edit scope.
