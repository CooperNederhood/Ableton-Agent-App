import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AgentCatalogService } from "./agent-catalog.js";

describe("desktop agent catalog", () => {
  it("loads renderer-safe definitions and refreshes changed files", async () => {
    const root = await mkdtemp(join(tmpdir(), "ableton-agent-catalog-"));
    const agentsDirectory = join(root, "agents");
    const skillsDirectory = join(root, "skills");
    await mkdir(agentsDirectory);
    await mkdir(skillsDirectory);
    const definitionPath = join(agentsDirectory, "default.yaml");
    const writeDefinition = (description: string) =>
      writeFile(
        definitionPath,
        [
          "version: 1",
          "name: default",
          `description: ${description}`,
          "systemPrompt: Help with Ableton.",
          "tools:",
          '  - "*"',
          "editScope:",
          "  - session",
          "skills: []",
          "inputChannels: []",
        ].join("\n"),
      );
    await writeDefinition("First description.");
    const service = new AgentCatalogService({
      agentsDirectory,
      skillsDirectory,
      availableTools: ["ableton_session_inspect"],
    });

    expect((await service.refresh()).definitions[0]).toMatchObject({
      name: "default",
      description: "First description.",
      resolvedTools: ["ableton_session_inspect"],
      sourceFile: "default.yaml",
    });
    await writeDefinition("Updated description.");
    expect((await service.refresh()).definitions[0]?.description).toBe(
      "Updated description.",
    );
  });
});
