---
name: debug-raw-amxd
description: Inspect raw Max for Live patch files using the canonical denoised AMXD CLI.
---

# Raw AMXD debugging adapter

Use this only when learning documents and the patch database do not capture an
exact outlet index, box attribute, parameter range, or hidden subpatcher.

Require an absolute `MAX4LIVE_MCP_ROOT` and invoke the canonical script:

```bash
AMXD_DEBUG="$MAX4LIVE_MCP_ROOT/.github/skills/debug-raw-amxd/amxd_debug.py"
test -f "$AMXD_DEBUG"

python3 "$AMXD_DEBUG" summary "$MAX4LIVE_MCP_ROOT/max_knowledge/m4l-learnings/<patch>/<patch>.amxd"
python3 "$AMXD_DEBUG" objects "$MAX4LIVE_MCP_ROOT/max_knowledge/m4l-learnings/<patch>/<patch>.amxd"
python3 "$AMXD_DEBUG" lines "$MAX4LIVE_MCP_ROOT/max_knowledge/m4l-learnings/<patch>/<patch>.amxd"
python3 "$AMXD_DEBUG" box "$MAX4LIVE_MCP_ROOT/max_knowledge/m4l-learnings/<patch>/<patch>.amxd" <varname>
python3 "$AMXD_DEBUG" params "$MAX4LIVE_MCP_ROOT/max_knowledge/m4l-learnings/<patch>/<patch>.amxd"
python3 "$AMXD_DEBUG" subs "$MAX4LIVE_MCP_ROOT/max_knowledge/m4l-learnings/<patch>/<patch>.amxd"
python3 "$AMXD_DEBUG" graph "$MAX4LIVE_MCP_ROOT/max_knowledge/m4l-learnings/<patch>/<patch>.amxd"
```

For user-saved devices, use an absolute path below `$ABLETON_MAX_PATH`.

Prefer:

- `summary` for identity and object counts.
- `objects` or `search` to locate boxes.
- `box` or `lines --obj` for exact inlet/outlet wiring.
- `params` for Live parameter metadata.
- `subs` and `objects --recursive` for hidden patchers.
- `raw` only for a targeted `jq` or grep pipeline.

If inspection reveals a critical missing fact, update the canonical
`patch-learnings.md` and re-ingest it. Do not write learning artifacts into
ableton-agent-app.

This adapter tracks the `debug-raw-amxd` skill in the Max4Live-MCP repository.
