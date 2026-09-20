import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  loadAgentCatalog,
  loadLayeredAgentCatalog,
  readSkillDocument,
} from "./loader.js";

const roots: string[] = [];

async function temporaryRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(process.cwd(), `.${label}-`));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("agent catalog loading", () => {
  it("loads Default as a general-purpose editing-capable agent", async () => {
    const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
    const catalog = await loadAgentCatalog({
      agentsDirectory: resolve(repositoryRoot, "agents"),
      skillsDirectory: resolve(repositoryRoot, "skills"),
      availableTools: ["ableton_session_inspect"],
    });
    const defaultAgent = catalog.agents.find(
      ({ definition }) => definition.name === "default",
    );

    expect(catalog.diagnostics).toEqual([]);
    expect(defaultAgent?.definition.editScope).toEqual(["session"]);
    expect(defaultAgent?.definition.systemPrompt).toMatch(
      /directly perform the user's requested supported\s+edits/u,
    );
    expect(defaultAgent?.definition.systemPrompt).not.toContain("mode");
  });

  it("loads validated definitions and canonical skills", async () => {
    const root = await temporaryRoot("agent-config");
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
    const root = await temporaryRoot("agent-config");
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

  it("reads a validated skill body without frontmatter", async () => {
    const root = await temporaryRoot("agent-skill");
    const sourcePath = join(root, "SKILL.md");
    await writeFile(
      sourcePath,
      [
        "---",
        "name: mix-review",
        "description: Review a mix.",
        "---",
        "",
        "# Mix review",
        "",
        "Preserve headroom.",
      ].join("\n"),
    );

    const document = await readSkillDocument(sourcePath, "mix-review");
    expect(document).toMatchObject({
      metadata: {
        name: "mix-review",
        description: "Review a mix.",
      },
      body: "# Mix review\n\nPreserve headroom.",
    });
    expect(document.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects malformed, empty, and mismatched skill documents", async () => {
    const root = await temporaryRoot("agent-skill");
    const sourcePath = join(root, "SKILL.md");
    await writeFile(sourcePath, "name: missing-frontmatter\n");
    await expect(readSkillDocument(sourcePath)).rejects.toThrow(
      "must start with YAML frontmatter",
    );

    await writeFile(
      sourcePath,
      "---\nname: mix-review\ndescription: Review a mix.\n---\n",
    );
    await expect(readSkillDocument(sourcePath)).rejects.toThrow(
      "body must not be empty",
    );

    await writeFile(
      sourcePath,
      "---\nname: mix-review\ndescription: Review a mix.\n---\n\n# Review",
    );
    await expect(readSkillDocument(sourcePath, "sound-design")).rejects.toThrow(
      "does not match expected skill",
    );
  });

  it("resolves semantic overrides and tombstones across scopes", async () => {
    const root = await temporaryRoot("layered-catalog");
    const layer = async (
      name: string,
      skillDescription?: string,
      agentPrompt?: string,
    ) => {
      const agentsDirectory = join(root, name, "agents");
      const skillsDirectory = join(root, name, "skills");
      await mkdir(agentsDirectory, { recursive: true });
      await mkdir(skillsDirectory, { recursive: true });
      if (skillDescription !== undefined) {
        await mkdir(join(skillsDirectory, "folder"));
        await writeFile(
          join(skillsDirectory, "folder", "SKILL.md"),
          `---\nname: midi\ndescription: ${skillDescription}\n---\n\n# MIDI`,
        );
      }
      if (agentPrompt !== undefined) {
        await writeFile(
          join(agentsDirectory, "compose.yaml"),
          [
            "version: 1",
            "name: compose",
            "description: Compose.",
            `systemPrompt: ${agentPrompt}`,
            "tools: [ableton_clips_create]",
            "editScope: [session]",
            "skills: [midi]",
            "inputChannels: []",
          ].join("\n"),
        );
      }
      return { agentsDirectory, skillsDirectory };
    };
    const bundled = await layer("bundled", "Bundled.", "Bundled prompt.");
    const system = await layer("system", "System.", undefined);
    const profile = await layer("profile", undefined, "Profile prompt.");
    const project = await layer("project", "Project.", "Project prompt.");
    const session = await layer("session", undefined, "Session prompt.");

    const catalog = await loadLayeredAgentCatalog({
      bundled,
      system,
      profile,
      project,
      session: { ...session, agentTombstones: ["unused"] },
      availableTools: ["ableton_clips_create"],
    });

    expect(catalog.diagnostics).toEqual([]);
    expect(catalog.skills[0]).toMatchObject({
      metadata: { name: "midi", description: "Project." },
      origin: "project",
      inherited: true,
      overrides: ["bundled", "system"],
    });
    expect(catalog.agents[0]).toMatchObject({
      definition: { name: "compose", systemPrompt: "Session prompt." },
      origin: "session",
      inherited: false,
      overrides: ["bundled", "profile", "project"],
    });

    const tombstoned = await loadLayeredAgentCatalog({
      bundled,
      system,
      profile: { ...profile, skillTombstones: ["midi"] },
      availableTools: ["ableton_clips_create"],
    });
    expect(tombstoned.skills).toEqual([]);
    expect(tombstoned.agents).toEqual([]);
    expect(tombstoned.diagnostics).toEqual([
      expect.objectContaining({ code: "unknown_skill" }),
    ]);
  });

  it("rejects non-physical layered scope paths", async () => {
    const root = await temporaryRoot("layered-symlink");
    const physical = join(root, "physical");
    const agents = join(physical, "agents");
    const skills = join(physical, "skills");
    await mkdir(agents, { recursive: true });
    await mkdir(skills);
    const linkedAgents = join(root, "linked-agents");
    await symlink(agents, linkedAgents);

    await expect(
      loadLayeredAgentCatalog({
        bundled: { agentsDirectory: linkedAgents, skillsDirectory: skills },
        availableTools: [],
      }),
    ).rejects.toThrow("physical directory");
  });
});
