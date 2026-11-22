---
name: update-memory
description: Save durable facts, preferences, and decisions to scoped memory when the user asks you to remember something or important context should outlive this session.
---

# Update memory

Memory is a small wiki of Markdown topic files in each scope. The app shows
every scope's `INDEX.md` in your system message, generates `INDEX.md` from each
topic's frontmatter `description`, and saves nothing until the user approves
your draft in the review pane.

Loading this skill opens a draft and names a workspace folder. It holds
copies of the memory as `memory/{scope}/{topic}.md`. Use `view`, `glob`, and
`grep` to read it and `create` and `edit` to change it, always with absolute
paths inside the workspace. Only the scopes the draft lists are writable.

## Scopes

- **System:** always true for all of Ableton Live. For example, Live
  behaviours, device quirks, and the app or hardware setup.
- **Profile:** a unified artistic aesthetic across many tracks. For example,
  genres, taste, workflow habits, and signature sounds.
- **Project:** one Ableton project, often a single musical track. For example,
  key, tempo, references, stems, and creative goals.
- **Live Set:** one version or arrangement of that track. For example, its
  arrangement plan, track roles, and outstanding to-dos.
- **Session:** this working session only. For example, current experiments and
  in-progress decisions.

If the request contains a scope, every topic must use that scope.

## Procedure

1. **Decide what to remember.** Use the request. With no request, reflect on
   this session. For history beyond the conversation, use `set_sql_search`
   over the `agent_history_*` and `set_history_*` views, bounded by the app
   session ID and Live Set ID. Skip transient chatter and anything already
   recorded.
2. **Choose the scope** for each item using the guide above.
3. **Check existing memory.** `glob` the workspace's `memory/` folder, then
   `view` each topic you might change.
   - Add the item to the existing general topic it belongs to, under the right
     heading.
   - Replace a fact that is outdated or contradicted; do not keep both.
   - Create a topic only when no existing theme fits. Name it for the broad
     theme, not the single fact.
4. **Consolidate.** Merge related topics into a more general one, for example
   `kick-tuning` and `bass-sidechain` into `low-end-mixing`, then delete the
   old files with `rm` (or empty them). Keep each scope under 20 topics;
   merge before adding when it nears the limit.
5. **Write** each topic with `create` or `edit` at
   `{workspace}/memory/{scope}/{topic}.md`:

   ```markdown
   ---
   name: low-end-mixing
   description: Kick and bass tuning, sidechain depth, and sub mono habits.
   ---

   # Low-end mixing

   - Tune the kick to the track key before balancing bass.
   ```

   `name` is a lowercase hyphenated topic name matching the file. Keep
   `description` to one line, widen it when the topic's coverage grows, and
   never write `INDEX.md` yourself. Never write secrets or raw audio. Cite
   provenance IDs such as Live Set or turn IDs when they help.

6. **Submit** with `submit_artifact_draft({ summary })`. List what you added,
   replaced, merged, and deleted. If the user requests changes, edit the
   workspace files and submit again.
