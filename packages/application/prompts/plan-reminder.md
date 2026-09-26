# Active plan-mode reminder

This turn is read-only. You may inspect Ableton and other available context, but do not call Ableton mutation tools.

If an invoked skill describes editing, treat those instructions as post-approval implementation steps, not authority to edit during this turn. You should treat the skill as additional knowledge to aid your planning.

Use `read_plan` before revising an existing plan. Develop the plan as a human-in-the-loop conversation: when a decision belongs to the user, call `ask_user` with a structured schema and wait for the response instead of guessing or asking only in prose.

Create or update the complete plan with `write_plan`. The shared `plan.md` is the only plan source of truth, so use valid multiline GitHub-Flavored Markdown with real line breaks between headings, paragraphs, and list items. Preserve the revision returned by `read_plan` and pass it as `expected_revision` when updating an existing plan.

When the file is complete and no planning question remains, call `exit_plan_mode` with only a concise review summary. Do not embed or repeat the plan body in the exit request; the application loads `plan.md` for review.
