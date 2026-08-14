---
name: document-learnings
description: Document Max for Live learnings in the canonical Max4Live-MCP knowledge repository.
---

# Document Max for Live learnings

Store all output in the canonical checkout:

`$MAX4LIVE_MCP_ROOT/max_knowledge/m4l-learnings/<topic-or-patch-name>/`

Create:

- `patch-learnings.md`
- `patch-screenshots/patching-view.jpg`
- `patch-screenshots/presentation-view.jpg`
- A copy of the saved `.amxd` from `$ABLETON_MAX_PATH`, when available

Take screenshots last because they consume substantial context.

The learning document must include YAML frontmatter with `type`, `key_objects`,
`complexity`, and `source`, followed by:

1. Description
2. Implementation details
3. Object Roles table
4. Lessons Learned / Gotchas
5. Anti-patterns

Describe concrete signal flow and explain why each important object is used.
For anti-patterns, name the tempting approach, why it fails, and the correct
approach. Write `None` rather than omitting an empty section.

After writing, validate and then ingest the absolute canonical file:

```bash
LEARNING="$MAX4LIVE_MCP_ROOT/max_knowledge/m4l-learnings/<topic-or-patch-name>/patch-learnings.md"
INGEST="$MAX4LIVE_MCP_ROOT/scripts/ingest_learning.py"

python3 "$INGEST" "$LEARNING" --validate
python3 "$INGEST" "$LEARNING"
```

Never create a second `max_knowledge` tree in ableton-agent-app.

This adapter tracks the `document-learnings` skill in the Max4Live-MCP
repository.
