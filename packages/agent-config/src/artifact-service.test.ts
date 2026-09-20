import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  compareArtifacts,
  copyArtifact,
  disableArtifact,
  readArtifactTombstones,
  renameAgentInScope,
  renameSkillInScope,
  restoreArtifact,
} from "./artifact-service.js";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(process.cwd(), ".artifact-service-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function writeAgent(
  directory: string,
  name: string,
  skills: readonly string[],
): Promise<string> {
  const path = join(directory, `${name}.yaml`);
  await writeFile(
    path,
    [
      "version: 1",
      `name: ${name}`,
      "description: Test agent.",
      "systemPrompt: Test prompt.",
      "tools: [ableton_session_inspect]",
      "editScope: [session]",
      `skills: [${skills.join(", ")}]`,
      "inputChannels: []",
    ].join("\n"),
  );
  return path;
}

async function writeSkill(directory: string, folder: string, name: string) {
  const skillDirectory = join(directory, folder);
  await mkdir(skillDirectory);
  await writeFile(
    join(skillDirectory, "SKILL.md"),
    `---\nname: ${name}\ndescription: Test skill.\n---\n\n# Test\n`,
  );
  return skillDirectory;
}

describe("artifact service", () => {
  it("copies without overwrite and compares content", async () => {
    const root = await temporaryRoot();
    const source = join(root, "source");
    const destination = join(root, "destination");
    await mkdir(source);
    await mkdir(destination);
    const sourcePath = await writeAgent(source, "compose", []);

    const copied = await copyArtifact({
      kind: "agent",
      name: "compose",
      sourceDirectory: source,
      destinationDirectory: destination,
    });

    expect(
      await compareArtifacts({
        kind: "agent",
        leftPath: sourcePath,
        rightPath: copied,
      }),
    ).toMatchObject({ equal: true });
    await expect(
      copyArtifact({
        kind: "agent",
        name: "compose",
        sourceDirectory: source,
        destinationDirectory: destination,
      }),
    ).rejects.toThrow("already exists");
  });

  it("semantically renames a skill and same-scope agent references", async () => {
    const root = await temporaryRoot();
    const agents = join(root, "agents");
    const skills = join(root, "skills");
    await mkdir(agents);
    await mkdir(skills);
    await writeAgent(agents, "compose", ["midi"]);
    await writeSkill(skills, "legacy-folder", "midi");

    await renameSkillInScope({
      agentsDirectory: agents,
      skillsDirectory: skills,
      currentName: "midi",
      replacementName: "midi-writing",
    });

    expect(
      await readFile(join(skills, "midi-writing", "SKILL.md"), "utf8"),
    ).toContain("name: midi-writing");
    expect(await readFile(join(agents, "compose.yaml"), "utf8")).toContain(
      "skills:\n  - midi-writing",
    );
  });

  it("updates the semantic agent name and refuses conflicts", async () => {
    const root = await temporaryRoot();
    const agents = join(root, "agents");
    await mkdir(agents);
    await writeAgent(agents, "compose", []);

    const renamed = await renameAgentInScope({
      agentsDirectory: agents,
      currentName: "compose",
      replacementName: "arrange",
    });
    expect(await readFile(renamed, "utf8")).toContain("name: arrange");
    await writeAgent(agents, "compose", []);
    await expect(
      renameAgentInScope({
        agentsDirectory: agents,
        currentName: "compose",
        replacementName: "arrange",
      }),
    ).rejects.toThrow("already exists");
  });

  it("disables and restores artifacts with revision checks", async () => {
    const root = await temporaryRoot();
    const statePath = join(root, "artifact-state", "skills.json");

    const disabled = await disableArtifact(statePath, "midi", 0);
    expect(disabled).toMatchObject({ revision: 1, names: ["midi"] });
    await expect(disableArtifact(statePath, "mix", 0)).rejects.toThrow(
      "revision conflict",
    );
    const restored = await restoreArtifact(statePath, "midi", 1);
    expect(restored).toMatchObject({ revision: 2, names: [] });
    expect(await readArtifactTombstones(statePath)).toEqual(restored);
  });
});
