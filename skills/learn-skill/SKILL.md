---
name: learn-skill
description: Turn a repeatable procedure from this session into a reusable skill, or improve an existing skill, when the user asks you to learn or remember how to do something.
---

# Learn skill

A skill is one `SKILL.md` file that teaches a repeatable procedure. Nothing is
saved until the user approves your draft in the review pane. Skills default to
Profile scope; the user can move the draft to System, Project, or Session.

Loading this skill opens a draft and names a workspace folder holding copies
of the skills as `skills/{name}/SKILL.md`. Use `view`, `glob`, and `grep` to
read it and `create` and `edit` to change it, always with absolute paths
inside the workspace.

## Procedure

1. **Find the procedure.** Use the request. With no request, reflect on this
   session for a workflow worth repeating. Use `set_sql_search` over the
   `agent_history_*` views when you need exact earlier steps.
2. **Avoid duplicates.** `glob` the workspace's `skills/` folder and `view`
   related skills. Prefer improving an existing skill's body over adding a
   near-duplicate.
3. **Write one skill** with `create` or `edit` at
   `{workspace}/skills/{name}/SKILL.md`. For a new skill, first run
   `mkdir -p {workspace}/skills/{name}`; `create` needs the folder to exist:

   ```markdown
   ---
   name: sidechain-pumping
   description: Set up kick-triggered sidechain pumping on bass and pads.
   ---

   # Sidechain pumping

   1. ...
   ```

   Use a lowercase hyphenated `name`, a `description` that says when the
   skill applies, and clear numbered steps in plain language.

4. **For an existing skill**, keep its name and description exactly and change
   the body only.
5. **Do not grant tools or authority.** Skills cannot change permissions.
6. **Submit** with `submit_artifact_draft({ summary })`. If the user requests
   changes, edit the workspace file and submit again.
