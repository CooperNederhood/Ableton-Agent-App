import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
  ensureLiveAgentStorage,
  resolveArtifactScopePaths,
  resolveLiveAgentStorage,
  resolveMemoryScopeDirectory,
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
      availableTools: ["ableton_session"],
    });

    expect((await service.refresh()).definitions[0]).toMatchObject({
      name: "default",
      label: "Default",
      description: "First description.",
      resolvedTools: ["ableton_session"],
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

  it("carries a skill's argument hint to the renderer catalog", async () => {
    const root = await temporaryRoot();
    const agentsDirectory = join(root, "agents");
    const skillsDirectory = join(root, "skills");
    await mkdir(agentsDirectory);
    await mkdir(join(skillsDirectory, "learn-skill"), { recursive: true });
    await mkdir(join(skillsDirectory, "mix-review"));
    await writeFile(
      join(skillsDirectory, "learn-skill", "SKILL.md"),
      '---\nname: learn-skill\ndescription: Learn a skill.\nargument-hint: "[what to learn]"\n---\n\nLearn.\n',
    );
    await writeFile(
      join(skillsDirectory, "mix-review", "SKILL.md"),
      "---\nname: mix-review\ndescription: Review a mix.\n---\n\nReview.\n",
    );
    const service = new AgentCatalogService({
      agentsDirectory,
      skillsDirectory,
      availableTools: [],
    });

    const [learn, mix] = (await service.refresh()).skills;
    expect(learn).toMatchObject({
      name: "learn-skill",
      argumentHint: "[what to learn]",
    });
    expect(mix).not.toHaveProperty("argumentHint");
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
        "ableton_session",
        "read_plan",
        "ask_user",
        "bash",
        "task",
      ],
      wildcardExcludedTools: ["task"],
    });

    expect((await service.refresh()).definitions[0]?.resolvedTools).toEqual([
      "ableton_session",
      "ask_user",
      "bash",
      "read_plan",
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
      "tools: [session.inspect]",
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
    const ownership = {
      liveSetId: "live-set-1",
      liveProjectId: "live-project-1",
      sessionId: "session-1",
    };
    const project = resolveArtifactScopePaths(storage, "project", {
      liveProjectId: ownership.liveProjectId,
    });
    const session = resolveArtifactScopePaths(storage, "session", ownership);
    await mkdir(project.agentsDirectory, { recursive: true });
    await mkdir(project.skillsDirectory, { recursive: true });
    await writeFile(
      join(project.agentsDirectory, "default.yaml"),
      definition
        .map((line) =>
          line === "description: General agent."
            ? "description: Project agent."
            : line,
        )
        .join("\n"),
    );
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
      availableTools: ["ableton_session"],
      availableOperations: [
        { operationId: "session.inspect", toolName: "ableton_session" },
      ],
      storage,
      resolveSessionOwnership: async () => ownership,
    });

    const catalog = await service.refreshForSession("session-1");
    expect(catalog.sessionId).toBe("session-1");
    expect(catalog.definitions[0]).toMatchObject({
      description: "Session agent.",
      origin: "session",
      inherited: false,
      overrides: ["bundled", "project"],
    });
  });

  it("resolves the latest scoped skill descriptor without replacing the catalog snapshot", async () => {
    const root = await temporaryRoot();
    const agentsDirectory = join(root, "bundled", "agents");
    const skillsDirectory = join(root, "bundled", "skills");
    await mkdir(agentsDirectory, { recursive: true });
    await mkdir(join(skillsDirectory, "mix-review"), { recursive: true });
    await writeFile(
      join(skillsDirectory, "mix-review", "SKILL.md"),
      "---\nname: mix-review\ndescription: Review the mix.\n---\n\nBundled body.",
    );
    const storage = resolveLiveAgentStorage({
      environment: { LIVE_AGENT_HOME: join(root, "storage") },
    });
    await ensureLiveAgentStorage(storage);
    const ownership = {
      liveSetId: "live-set-1",
      liveProjectId: "live-project-1",
      sessionId: "session-1",
    };
    const project = resolveArtifactScopePaths(storage, "project", {
      liveProjectId: ownership.liveProjectId,
    });
    await mkdir(join(project.skillsDirectory, "mix-review"), {
      recursive: true,
    });
    const projectPath = join(project.skillsDirectory, "mix-review", "SKILL.md");
    await writeFile(
      projectPath,
      "---\nname: mix-review\ndescription: Review the mix.\n---\n\nProject body.",
    );
    const session = resolveArtifactScopePaths(storage, "session", ownership);
    await mkdir(join(session.skillsDirectory, "mix-review"), {
      recursive: true,
    });
    const sessionPath = join(session.skillsDirectory, "mix-review", "SKILL.md");
    await writeFile(
      sessionPath,
      "---\nname: mix-review\ndescription: Review the mix.\n---\n\nSession body.",
    );
    const service = new AgentCatalogService({
      agentsDirectory,
      skillsDirectory,
      availableTools: [],
      storage,
      resolveSessionOwnership: async () => ownership,
    });

    await expect(
      service.resolveRuntimeSkill("session-1", "mix-review"),
    ).resolves.toMatchObject({
      name: "mix-review",
      sourcePath: sessionPath,
    });
    await rm(join(session.skillsDirectory, "mix-review"), {
      recursive: true,
    });
    await expect(
      service.resolveRuntimeSkill("session-1", "mix-review"),
    ).resolves.toMatchObject({
      name: "mix-review",
      sourcePath: projectPath,
    });
  });

  it("loads authoring context and publishes reviewed memory and skills into owned scopes", async () => {
    const root = await temporaryRoot();
    const agentsDirectory = join(root, "bundled", "agents");
    const skillsDirectory = join(root, "bundled", "skills");
    await mkdir(agentsDirectory, { recursive: true });
    await mkdir(skillsDirectory, { recursive: true });
    const storage = resolveLiveAgentStorage({
      environment: { LIVE_AGENT_HOME: join(root, "storage") },
    });
    await ensureLiveAgentStorage(storage);
    const owned = {
      liveSetId: "live-set-1",
      liveProjectId: "live-project-1",
      sessionId: "session-1",
    };
    const ownership = new Map<
      string,
      typeof owned | { liveSetId: string; sessionId: string }
    >([
      ["session-1", owned],
      ["loose", { liveSetId: "live-set-2", sessionId: "loose" }],
    ]);
    const service = new AgentCatalogService({
      agentsDirectory,
      skillsDirectory,
      availableTools: [],
      storage,
      resolveSessionOwnership: async (sessionId) => ownership.get(sessionId),
    });
    const port = service.artifactAuthoring!;
    const topic = (description: string) =>
      `---\nname: mixing\ndescription: ${description}\n---\n\nKeep the low end mono.\n`;

    const unsaved = await port.loadContext("unsaved");
    expect(
      unsaved.memory.map(({ scope, available }) => [scope, available]),
    ).toEqual([
      ["system", true],
      ["profile", true],
      ["project", false],
      ["live-set", false],
      ["session", false],
    ]);
    const loose = await port.loadContext("loose");
    expect(loose.skillScopes).toEqual([
      { scope: "system", available: true },
      { scope: "profile", available: true },
      {
        scope: "project",
        available: false,
        unavailableReason: "the Live Set is not in a verified Live Project",
      },
      { scope: "session", available: true },
    ]);

    const published = await port.publish("session-1", {
      kind: "memory",
      scopes: [
        {
          scope: "profile",
          writes: [
            {
              name: "mixing",
              content: topic("Mix habits."),
              baseFingerprint: null,
            },
          ],
          deletes: [],
        },
      ],
    });
    const profileDirectory = resolveMemoryScopeDirectory(storage, "profile");
    expect(published.published).toEqual([
      {
        scope: "profile",
        path: join(profileDirectory, "mixing.md"),
        change: "added",
      },
    ]);
    await expect(
      readFile(join(profileDirectory, "INDEX.md"), "utf8"),
    ).resolves.toContain("mixing");
    const context = await port.loadContext("session-1");
    const profileTopic = context.memory
      .find(({ scope }) => scope === "profile")!
      .topics.find(({ name }) => name === "mixing")!;
    expect(profileTopic.description).toBe("Mix habits.");
    await expect(
      port.publish("session-1", {
        kind: "memory",
        scopes: [
          {
            scope: "profile",
            writes: [
              {
                name: "mixing",
                content: topic("Stale."),
                baseFingerprint: null,
              },
            ],
            deletes: [],
          },
        ],
      }),
    ).rejects.toThrow(/changed since the draft/u);
    await expect(
      port.publish("unsaved", {
        kind: "memory",
        scopes: [
          {
            scope: "session",
            writes: [
              {
                name: "mixing",
                content: topic("Nope."),
                baseFingerprint: null,
              },
            ],
            deletes: [],
          },
        ],
      }),
    ).rejects.toThrow();

    const skill = {
      kind: "skill" as const,
      name: "low-end-check",
      description: "Check the low end.",
      body: "Solo the bass and kick.",
    };
    await expect(
      port.publish("loose", {
        ...skill,
        scope: "project",
        baseFingerprint: null,
      }),
    ).rejects.toThrow(/verified Live Project/u);
    const savedSkill = await port.publish("session-1", {
      ...skill,
      scope: "project",
      baseFingerprint: null,
    });
    const projectSkills = resolveArtifactScopePaths(storage, "project", {
      liveProjectId: owned.liveProjectId,
    }).skillsDirectory;
    expect(savedSkill.published).toEqual([
      {
        scope: "project",
        path: join(projectSkills, "low-end-check", "SKILL.md"),
        change: "added",
      },
    ]);
    const loaded = (await port.loadContext("session-1")).skills.find(
      ({ name }) => name === "low-end-check",
    )!;
    expect(loaded).toMatchObject({ origin: "project" });
    expect(loaded.content).toContain("Solo the bass and kick.");
    await expect(
      port.publish("session-1", {
        ...skill,
        scope: "project",
        baseFingerprint: null,
      }),
    ).rejects.toThrow(/changed since the draft/u);
    await expect(
      port.publish("session-1", {
        ...skill,
        body: "Solo the bass, kick, and sub.",
        scope: "project",
        baseFingerprint: loaded.fingerprint,
      }),
    ).resolves.toMatchObject({
      published: [{ scope: "project", change: "modified" }],
    });
  });
});
