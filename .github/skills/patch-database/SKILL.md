---
name: patch-database
description: Query the canonical Max/MSP patch database for patterns, examples, roles, and gotchas.
---

# Patch database adapter

This skill uses the canonical implementation and database in the local
Max4Live-MCP checkout. Do not copy either into ableton-agent-app.

Require an absolute `MAX4LIVE_MCP_ROOT`, then initialize:

```bash
PATCH_DB="$MAX4LIVE_MCP_ROOT/.github/skills/patch-database/patch_db.py"
KNOWLEDGE_DB="$MAX4LIVE_MCP_ROOT/max_knowledge/patches.db"
test -f "$PATCH_DB"
test -f "$KNOWLEDGE_DB"
```

Every query must pass the database explicitly because `patch_db.py` otherwise
resolves its default relative to the current working directory:

```bash
python3 "$PATCH_DB" --db "$KNOWLEDGE_DB" similar "visualize audio"
python3 "$PATCH_DB" --db "$KNOWLEDGE_DB" details basic-audio-vis
python3 "$PATCH_DB" --db "$KNOWLEDGE_DB" gotchas jit.catch~
python3 "$PATCH_DB" --db "$KNOWLEDGE_DB" gotchas --search "audio thread"
python3 "$PATCH_DB" --db "$KNOWLEDGE_DB" roles jit.qball
python3 "$PATCH_DB" --db "$KNOWLEDGE_DB" connects-to jit.catch~
python3 "$PATCH_DB" --db "$KNOWLEDGE_DB" connects-from jit.graph
python3 "$PATCH_DB" --db "$KNOWLEDGE_DB" find jit.catch~ jit.graph
python3 "$PATCH_DB" --db "$KNOWLEDGE_DB" chain jit.catch~
python3 "$PATCH_DB" --db "$KNOWLEDGE_DB" search "oscilloscope"
python3 "$PATCH_DB" --db "$KNOWLEDGE_DB" example peakamp~
python3 "$PATCH_DB" --db "$KNOWLEDGE_DB" stats
```

Start with `similar`, inspect promising results with `details`, use `gotchas`
before implementation, and use connection/role queries before wiring objects.
Use raw `.amxd` inspection only when the indexed knowledge lacks an exact
detail.

This adapter tracks the `patch-database` skill in the Max4Live-MCP repository.
