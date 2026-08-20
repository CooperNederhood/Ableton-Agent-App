import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { loadAgentCatalog } from "./loader.js";

describe("agent catalog loading", () => {
  it("loads validated definitions and canonical skills", async () => {
    const root = await mkdtemp(join(tmpdir(), "ableton-agent-config-"));
    const agents = join(root, "agents");
    const skills = join(root, "skills");
    await mkdir(agents);
    await mkdir(join(skills, "midi"), { recursive: true });
    await writeFile(
      join(skills, "midi", "SKILL.md"),
      [
        "---",
        "name: midi",
        "description: MIDI guidance.",
        "---",
        "",
        "# MIDI",
      ].join("\n"),
    );
    await writeFile(
      join(agents, "compose.yaml"),
      [
        "version: 1",
        "name: compose",
        "description: Compose MIDI.",
        "systemPrompt: Compose musical material.",
        "tools:",
        '  - "ableton_clips_*"',
        "editScope:",
        "  - session",
        "skills:",
        "  - midi",
        "inputChannels: []",
      ].join("\n"),
    );

    const catalog = await loadAgentCatalog({
      agentsDirectory: agents,
      skillsDirectory: skills,
      availableTools: ["ableton_clips_create", "ableton_tracks_create"],
    });

    expect(catalog.diagnostics).toEqual([]);
    expect(catalog.skills[0]?.metadata.name).toBe("midi");
    expect(catalog.agents[0]).toMatchObject({
      definition: { name: "compose" },
      resolvedTools: ["ableton_clips_create"],
    });
  });

  it("isolates invalid definitions as diagnostics", async () => {
    const root = await mkdtemp(join(tmpdir(), "ableton-agent-config-"));
    const agents = join(root, "agents");
    const skills = join(root, "skills");
    await mkdir(agents);
    await mkdir(skills);
    await writeFile(
      join(agents, "invalid.yaml"),
      "version: 1\nname: Invalid Name\n",
    );

    const catalog = await loadAgentCatalog({
      agentsDirectory: agents,
      skillsDirectory: skills,
      availableTools: ["ableton_session_inspect"],
    });

    expect(catalog.agents).toEqual([]);
    expect(catalog.diagnostics).toEqual([
      expect.objectContaining({ code: "invalid_definition" }),
    ]);
  });
});
