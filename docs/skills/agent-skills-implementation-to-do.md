# Agent Skills Implementation To-Do

Companion specification: [Agent Skills](agent-skills.md)

## Resources and loading

- [x] Bundle Set History SQL query guidance for the read-only
  `set_sql_search` tool.
- [x] Add root canonical skill directories and `SKILL.md` files.
- [x] Validate bounded YAML frontmatter and duplicate skill names.
- [x] Resolve development and packaged skill roots.
- [x] Expose skill metadata and diagnostics through typed Desktop APIs.
- [x] Replace generic arrangement guidance with a researched, three-level
      techno arrangement assessment and recommendation rubric.
- [x] Resolve skills through bundled, System, Profile, Project, and Session
  layers.
- [x] Support tombstones, conflict comparison, and atomic scoped copies.
- [x] Support semantic skill rename with same-scope agent reference updates.
- [x] Add atomic Session-scope skill creation and body-only copy-on-write edits.

## Progressive disclosure

- [x] Add enabled skill frontmatter to each agent's system instructions.
- [x] Register an application-owned `skill(skill_name)` tool.
- [x] Exclude the SDK `builtin:skill` implementation from explicit and wildcard
  tool grants.
- [x] Restrict model-driven tool calls to skills enabled by the agent
  definition.
- [x] Keep complete skill bodies out of SDK startup context.
- [x] Resolve the latest effective scoped body for every direct and model-owned
      skill invocation without resetting the active conversation.

## Desktop invocation

- [x] Parse `/skill-name` with or without trailing request text.
- [x] Allow direct slash invocation of every valid catalog skill.
- [x] Reject unknown or unavailable skills before starting an SDK turn.
- [x] Add composer discovery and completion.
- [x] Show configured skills in defined and active agent details.
- [x] Add an Agents-aligned Skills tab with immutable published metadata and an
      editable Markdown body.
- [x] Allow new-skill drafts to define name and description before first save.
- [x] Refresh Profiles and Workspace slash completion after Session publication.
- [x] Invalidate stale skill catalogs when the active production session changes.
- [x] Allow persisted inactive sessions to supply and receive moved or copied
      artifacts, and promote an active in-memory destination on first transfer.

## Verification

- [x] Test canonical metadata parsing and malformed frontmatter.
- [x] Test per-agent tool isolation.
- [x] Test direct invocation with and without trailing user text.
- [x] Test history preservation after skill configuration edits.
- [x] Test packaged resource loading.
- [x] Test Session creation, inherited copy-on-write, frontmatter preservation,
      rollback, renderer editing, typed IPC, and dynamic second invocation.
- [x] Test fresh-session catalog isolation and inactive-to-active skill transfer.
