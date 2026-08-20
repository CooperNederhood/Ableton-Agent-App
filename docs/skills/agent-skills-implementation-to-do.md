# Agent Skills Implementation To-Do

Companion specification: [Agent Skills](agent-skills.md)

## Resources and loading

- [~] Add root canonical skill directories and `SKILL.md` files.
- [~] Validate bounded YAML frontmatter and duplicate skill names.
- [ ] Resolve development and packaged skill roots.
- [ ] Expose skill metadata and diagnostics through typed Desktop APIs.

## SDK integration

- [ ] Supply canonical roots through SDK `skillDirectories`.
- [ ] Pass configured skill names to each native custom agent.
- [ ] Verify active-agent cold resume applies skill edits without losing
  history.

## Desktop invocation

- [ ] Parse `/skill-name` and optional trailing requests.
- [ ] Reject unknown or unavailable skills before starting an SDK turn.
- [ ] Add composer discovery and completion.
- [ ] Show configured skills in defined and active agent details.

## Verification

- [ ] Test canonical metadata parsing and malformed frontmatter.
- [ ] Test per-agent skill isolation.
- [ ] Test direct invocation with and without trailing user text.
- [ ] Test history preservation after skill configuration edits.
- [ ] Test packaged resource loading.
