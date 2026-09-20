import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
  ensureLiveAgentStorage,
  resolveArtifactScopePaths,
  resolveLiveAgentStorage,
} from "@ableton-agent/storage";

import { AgentCatalogService } from "./agent-catalog.js";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(process.cwd(), ".test-agent-catalog-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("desktop agent catalog", () => {
  it("loads renderer-safe definitions and refreshes changed files", async () => {
    const root = await temporaryRoot();
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
      label: "Default",
      description: "First description.",
      resolvedTools: ["ableton_session_inspect"],
      origin: "bundled",
      inherited: false,
      overrides: [],
      sourceFile: "default.yaml",
    });
    await writeDefinition("Updated description.");
    expect((await service.refresh()).definitions[0]?.description).toBe(
      "Updated description.",
    );
  });

  it("resolves a wildcard across Ableton, application, and SDK tools", async () => {
    const root = await temporaryRoot();
    const agentsDirectory = join(root, "agents");
    const skillsDirectory = join(root, "skills");
    await mkdir(agentsDirectory);
    await mkdir(skillsDirectory);
    await writeFile(
      join(agentsDirectory, "default.yaml"),
      [
        "version: 1",
        "name: default",
        "description: General agent.",
        "systemPrompt: Help with Ableton.",
        "tools:",
        '  - "*"',
        "editScope:",
        "  - session",
        "skills: []",
        "inputChannels: []",
      ].join("\n"),
    );
    const service = new AgentCatalogService({
      agentsDirectory,
      skillsDirectory,
      availableTools: [
        "ableton_session_inspect",
        "read_plan",
        "ask_user",
        "task",
      ],
    });

    expect((await service.refresh()).definitions[0]?.resolvedTools).toEqual([
      "ableton_session_inspect",
      "ask_user",
      "read_plan",
      "task",
    ]);
  });

  it("preserves layered origin metadata through the desktop catalog", async () => {
    const root = await temporaryRoot();
    const agentsDirectory = join(root, "bundled", "agents");
    const skillsDirectory = join(root, "bundled", "skills");
    await mkdir(agentsDirectory, { recursive: true });
    await mkdir(skillsDirectory, { recursive: true });
    const definition = [
      "version: 1",
      "name: default",
      "description: General agent.",
      "systemPrompt: Help with Ableton.",
      "tools: [ableton_session_inspect]",
      "editScope: [session]",
      "skills: []",
      "inputChannels: []",
    ];
    await writeFile(
      join(agentsDirectory, "default.yaml"),
      definition.join("\n"),
    );
    const storage = resolveLiveAgentStorage({
      environment: { LIVE_AGENT_HOME: join(root, "storage") },
    });
    await ensureLiveAgentStorage(storage);
    const session = resolveArtifactScopePaths(storage, "session", "session-1");
    await mkdir(session.agentsDirectory, { recursive: true });
    await mkdir(session.skillsDirectory, { recursive: true });
    await writeFile(
      join(session.agentsDirectory, "default.yaml"),
      definition
        .map((line) =>
          line === "description: General agent."
            ? "description: Session agent."
            : line,
        )
        .join("\n"),
    );
    const service = new AgentCatalogService({
      agentsDirectory,
      skillsDirectory,
      availableTools: ["ableton_session_inspect"],
      storage,
    });

    expect(
      (await service.refreshForSession("session-1")).definitions[0],
    ).toMatchObject({
      description: "Session agent.",
      origin: "session",
      inherited: false,
      overrides: ["bundled"],
    });
  });
});
