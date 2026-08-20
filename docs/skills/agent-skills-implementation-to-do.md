# Agent Skills Implementation To-Do

Companion specification: [Agent Skills](agent-skills.md)

## Resources and loading

- [x] Add root canonical skill directories and `SKILL.md` files.
- [x] Validate bounded YAML frontmatter and duplicate skill names.
- [x] Resolve development and packaged skill roots.
- [x] Expose skill metadata and diagnostics through typed Desktop APIs.

## Progressive disclosure

- [x] Add enabled skill frontmatter to each agent's system instructions.
- [x] Register an application-owned `skill(skill_name)` tool.
- [x] Restrict model-driven tool calls to skills enabled by the agent
  definition.
- [x] Keep complete skill bodies out of SDK startup context.

## Desktop invocation

- [x] Parse `/skill-name` with or without trailing request text.
- [x] Allow direct slash invocation of every valid catalog skill.
- [x] Reject unknown or unavailable skills before starting an SDK turn.
- [x] Add composer discovery and completion.
- [x] Show configured skills in defined and active agent details.

## Verification

- [x] Test canonical metadata parsing and malformed frontmatter.
- [x] Test per-agent tool isolation.
- [x] Test direct invocation with and without trailing user text.
- [x] Test history preservation after skill configuration edits.
- [x] Test packaged resource loading.
