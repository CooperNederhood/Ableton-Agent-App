import {
  mkdir,
  mkdtemp,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  LIVE_AGENT_STORAGE_VERSION,
  migrateNestedStorage,
  ensureLiveAgentStorage,
  createProfile,
  deleteProfile,
  loadProfileRegistry,
  migrateLegacyStorage,
  readArtifactTombstones,
  readLiveSetStorageMetadata,
  readProjectStorageMetadata,
  relocateLiveSetStorage,
  renameProfile,
  resolveArtifactScopePaths,
  resolveProjectStorage,
  resolveNestedSessionStorage,
  resolveLiveAgentStorage,
  selectProfile,
  writeArtifactTombstones,
  writeLiveProjectsRegistry,
  writeLiveSetStorageMetadata,
  writeProjectStorageMetadata,
} from "./index.js";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(process.cwd(), ".test-storage-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("live agent storage", () => {
  it("resolves bounded production-session artifacts under session-state", () => {
    const layout = resolveLiveAgentStorage({
      homeDirectory: join(process.cwd(), ".session-test-home"),
    });
    const ordinary = resolveNestedSessionStorage(layout, {
      liveSetId: "set:456",
      sessionId: "session:123",
    });
    const unsafe = resolveNestedSessionStorage(layout, {
      liveSetId: "../outside-set",
      sessionId: "../outside",
    });

    expect(ordinary.planPath).toBe(
      join(
        layout.unassignedLiveSetStateDirectory,
        "set:456",
        "session-state",
        "session:123",
        "artifacts",
        "plan.md",
      ),
    );
    expect(unsafe.sessionDirectory).toMatch(
      /unassigned-live-set-state[/\\]entity-[a-f0-9]{64}[/\\]session-state[/\\]session-[a-f0-9]{64}$/u,
    );
    expect(unsafe.planPath.startsWith(`${layout.profileRoot}/`)).toBe(true);
    expect(() =>
      resolveNestedSessionStorage(layout, {
        liveSetId: "set-1",
        sessionId: "",
      }),
    ).toThrow("must not be empty");
  });

  it("resolves isolated production and development profiles", async () => {
    const home = await temporaryRoot();
    const production = resolveLiveAgentStorage({ homeDirectory: home });
    const development = resolveLiveAgentStorage({
      homeDirectory: home,
      development: true,
    });

    expect(production.root).toBe(join(home, ".live-agent"));
    expect(production.profile).toBe("default");
    expect(development.profile).toBe("development");
    expect(production.eventJournalPath).toBe(
      join(
        home,
        ".live-agent",
        "profiles",
        "default",
        "observability",
        "event-history.sqlite",
      ),
    );
    expect(development.profileRoot).not.toBe(production.profileRoot);
    expect(production.profilesRegistryPath).toBe(
      join(home, ".live-agent", "config", "profiles.json"),
    );
    expect(production.systemAgentsDirectory).toBe(
      join(home, ".live-agent", "system", "agents"),
    );
    expect(production.profileSkillsDirectory).toBe(
      join(home, ".live-agent", "profiles", "default", "skills"),
    );
  });

  it("resolves typed system, profile, and session artifact scopes", async () => {
    const home = await temporaryRoot();
    const layout = resolveLiveAgentStorage({ homeDirectory: home });

    expect(resolveArtifactScopePaths(layout, "system")).toMatchObject({
      agentsDirectory: join(home, ".live-agent", "system", "agents"),
    });
    expect(resolveArtifactScopePaths(layout, "profile")).toMatchObject({
      skillsDirectory: join(
        home,
        ".live-agent",
        "profiles",
        "default",
        "skills",
      ),
    });
    expect(
      resolveArtifactScopePaths(layout, "project", {
        liveProjectId: "project:456",
      }),
    ).toMatchObject({
      root: join(
        home,
        ".live-agent",
        "profiles",
        "default",
        "project-state",
        "project:456",
      ),
      agentsDirectory: join(
        home,
        ".live-agent",
        "profiles",
        "default",
        "project-state",
        "project:456",
        "agents",
      ),
      agentTombstonesPath: join(
        home,
        ".live-agent",
        "profiles",
        "default",
        "project-state",
        "project:456",
        "artifact-state",
        "agents.json",
      ),
    });
    const nested = resolveNestedSessionStorage(layout, {
      liveProjectId: "project:456",
      liveSetId: "set:789",
      sessionId: "session:123",
    });
    expect(nested).toMatchObject({
      sessionDirectory: join(
        home,
        ".live-agent",
        "profiles",
        "default",
        "project-state",
        "project:456",
        "live-set-state",
        "set:789",
        "session-state",
        "session:123",
      ),
      memoryDirectory: join(
        home,
        ".live-agent",
        "profiles",
        "default",
        "project-state",
        "project:456",
        "live-set-state",
        "set:789",
        "session-state",
        "session:123",
        "memory",
      ),
    });
    expect(
      resolveArtifactScopePaths(layout, "session", {
        liveProjectId: "project:456",
        liveSetId: "set:789",
        sessionId: "session:123",
      }).root,
    ).toBe(nested.sessionDirectory);
    expect(
      resolveNestedSessionStorage(layout, {
        liveSetId: "set:789",
        sessionId: "session:123",
      }).sessionDirectory,
    ).toBe(
      join(
        home,
        ".live-agent",
        "profiles",
        "default",
        "unassigned-live-set-state",
        "set:789",
        "session-state",
        "session:123",
      ),
    );
    const resolveWithoutOwnership = resolveArtifactScopePaths as unknown as (
      layoutValue: ReturnType<typeof resolveLiveAgentStorage>,
      scope: "project" | "session",
    ) => unknown;
    expect(() => resolveWithoutOwnership(layout, "project")).toThrow(
      "Project ownership context is required",
    );
    expect(() => resolveWithoutOwnership(layout, "session")).toThrow(
      "Session ownership context is required",
    );
  });

  it("requires an absolute override and a safe profile", () => {
    expect(() =>
      resolveLiveAgentStorage({
        environment: { LIVE_AGENT_HOME: "relative" },
      }),
    ).toThrow("must be absolute");
    expect(() =>
      resolveLiveAgentStorage({
        environment: { LIVE_AGENT_HOME: "/" },
      }),
    ).toThrow("filesystem root");
    expect(() =>
      resolveLiveAgentStorage({
        environment: { LIVE_AGENT_PROFILE: "../escape" },
      }),
    ).toThrow("filesystem-safe");
  });

  it("creates owner-only directories and a version marker", async () => {
    const home = await temporaryRoot();
    const layout = resolveLiveAgentStorage({ homeDirectory: home });
    await ensureLiveAgentStorage(layout);

    expect((await stat(layout.profileRoot)).mode & 0o777).toBe(0o700);
    expect(
      JSON.parse(
        await readFile(join(layout.root, "storage-version.json"), "utf8"),
      ),
    ).toMatchObject({ version: LIVE_AGENT_STORAGE_VERSION });
    expect((await stat(layout.systemAgentsDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(layout.profileSkillsDirectory)).mode & 0o777).toBe(
      0o700,
    );
  });

  it("refuses an old version before creating v2 directories", async () => {
    const home = await temporaryRoot();
    const layout = resolveLiveAgentStorage({ homeDirectory: home });
    await mkdir(layout.profileRoot, { recursive: true });
    await writeFile(
      join(layout.root, "storage-version.json"),
      JSON.stringify({ version: 1 }),
    );

    await expect(ensureLiveAgentStorage(layout)).rejects.toThrow(
      "Storage version 1 is not supported",
    );
    await expect(stat(layout.projectStateDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("bootstraps and mutates the profile registry with revision checks", async () => {
    const home = await temporaryRoot();
    const layout = resolveLiveAgentStorage({ homeDirectory: home });
    const initial = await loadProfileRegistry(
      layout,
      () => new Date("2026-01-01T00:00:00.000Z"),
    );
    const created = await createProfile(
      layout,
      { name: "studio", displayName: "Studio" },
      { expectedRevision: initial.revision },
    );
    const renamed = await renameProfile(
      layout,
      "studio",
      { name: "writing" },
      { expectedRevision: created.revision },
    );
    expect(
      await stat(join(home, ".live-agent", "profiles", "writing")),
    ).toBeDefined();
    const selected = await selectProfile(layout, "writing", {
      expectedRevision: renamed.revision,
    });

    const selectedDefault = await selectProfile(layout, "default", {
      expectedRevision: selected.revision,
    });
    const deleted = await deleteProfile(layout, "writing", {
      expectedRevision: selectedDefault.revision,
    });

    expect(initial).toMatchObject({
      version: 1,
      revision: 1,
      selectedProfile: "default",
      profiles: [{ name: "default", displayName: "Default" }],
    });
    expect(deleted.profiles.map(({ name }) => name)).toEqual(["default"]);
    await expect(
      stat(join(home, ".live-agent", "profiles", "writing")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      createProfile(
        layout,
        { name: "other" },
        { expectedRevision: initial.revision },
      ),
    ).rejects.toThrow("revision conflict");
    await expect(
      createProfile(
        layout,
        { name: "development" },
        { expectedRevision: deleted.revision },
      ),
    ).rejects.toThrow("reserved");
    await expect(
      deleteProfile(layout, "default", { expectedRevision: deleted.revision }),
    ).rejects.toThrow("At least one visible user profile");
  });

  it("allows an OS-managed symlink ancestor outside the storage root", async () => {
    const root = await temporaryRoot();
    const physicalParent = join(root, "physical");
    const linkedParent = join(root, "linked");
    await mkdir(physicalParent);
    await symlink(physicalParent, linkedParent);
    const layout = resolveLiveAgentStorage({
      environment: { LIVE_AGENT_HOME: join(linkedParent, "live-agent") },
    });

    await expect(ensureLiveAgentStorage(layout)).resolves.toBeUndefined();
    expect((await stat(layout.profileRoot)).isDirectory()).toBe(true);
  });

  it("stores typed tombstones atomically with optimistic concurrency", async () => {
    const home = await temporaryRoot();
    const layout = resolveLiveAgentStorage({ homeDirectory: home });
    const statePath = layout.profileSkillTombstonesPath;

    expect(await readArtifactTombstones(statePath)).toMatchObject({
      revision: 0,
      names: [],
    });
    const updated = await writeArtifactTombstones(
      statePath,
      ["midi", "mix-review", "midi"],
      0,
    );
    expect(updated).toMatchObject({
      revision: 1,
      names: ["midi", "mix-review"],
    });
    await expect(writeArtifactTombstones(statePath, [], 0)).rejects.toThrow(
      "revision conflict",
    );
    await expect(
      writeArtifactTombstones(statePath, ["../escape"], 1),
    ).rejects.toThrow("Artifact name");
  });

  it("stores a bounded live-projects registry with revision checks", async () => {
    const home = await temporaryRoot();
    const layout = resolveLiveAgentStorage({ homeDirectory: home });
    const updated = await writeLiveProjectsRegistry(
      layout.liveProjectsRegistryPath,
      [
        {
          projectId: "project-1",
          displayName: "Studio Project",
          liveSetIds: ["set-1", "set-2"],
          updatedAt: "2026-09-20T12:00:00.000Z",
        },
      ],
      0,
    );
    expect(updated).toMatchObject({
      revision: 1,
      projects: [{ projectId: "project-1" }],
    });
    await expect(
      writeLiveProjectsRegistry(layout.liveProjectsRegistryPath, [], 0),
    ).rejects.toThrow("revision conflict");
  });

  it("validates project and Live Set metadata at their owning paths", async () => {
    const home = await temporaryRoot();
    const layout = resolveLiveAgentStorage({ homeDirectory: home });
    const nested = resolveNestedSessionStorage(layout, {
      liveProjectId: "project-1",
      liveSetId: "set-1",
      sessionId: "session-1",
    });

    const timestamp = "2026-09-20T12:00:00.000Z";
    await writeProjectStorageMetadata(nested.project!.metadataPath, {
      version: 1,
      projectId: "project-1",
      displayName: "Album",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await writeLiveSetStorageMetadata(nested.liveSet.metadataPath, {
      version: 1,
      projectId: "project-1",
      liveSetId: "set-1",
      displayName: "Song",
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    expect(
      await readProjectStorageMetadata(
        resolveProjectStorage(layout, "project-1").metadataPath,
      ),
    ).toMatchObject({ projectId: "project-1", displayName: "Album" });
    expect(
      await readLiveSetStorageMetadata(nested.liveSet.metadataPath),
    ).toMatchObject({
      projectId: "project-1",
      liveSetId: "set-1",
      displayName: "Song",
    });
    await expect(
      writeLiveSetStorageMetadata(nested.liveSet.metadataPath, {
        version: 1,
        liveSetId: "set-1",
        displayName: "x".repeat(513),
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    ).rejects.toThrow("between 1 and 512 characters");
  });

  it("relocates a complete unassigned Live Set subtree into a Project", async () => {
    const root = await temporaryRoot();
    const layout = resolveLiveAgentStorage({
      environment: { LIVE_AGENT_HOME: root },
    });
    await ensureLiveAgentStorage(layout);
    const unassigned = resolveNestedSessionStorage(layout, {
      liveSetId: "set-1",
      sessionId: "session-1",
    });
    await mkdir(unassigned.artifactsDirectory, { recursive: true });
    await writeFile(unassigned.planPath, "# Preserved plan");

    await expect(
      relocateLiveSetStorage(
        layout,
        { ownership: "unassigned", liveSetId: "set-1" },
        {
          ownership: "project",
          projectId: "project-1",
          liveSetId: "set-1",
        },
      ),
    ).resolves.toBe(true);

    const assigned = resolveNestedSessionStorage(layout, {
      liveProjectId: "project-1",
      liveSetId: "set-1",
      sessionId: "session-1",
    });
    await expect(readFile(assigned.planPath, "utf8")).resolves.toBe(
      "# Preserved plan",
    );
    await expect(
      relocateLiveSetStorage(
        layout,
        {
          ownership: "project",
          projectId: "project-1",
          liveSetId: "set-1",
        },
        {
          ownership: "project",
          projectId: "project-1",
          liveSetId: "set-1",
        },
      ),
    ).resolves.toBe(false);
  });

  it("publishes storage v2 only after every legacy profile is migrated", async () => {
    const root = await temporaryRoot();
    const environment = { LIVE_AGENT_HOME: root };
    const first = resolveLiveAgentStorage({ environment, profile: "first" });
    const second = resolveLiveAgentStorage({ environment, profile: "second" });
    await mkdir(join(root, "profiles", "first", "session-state"), {
      recursive: true,
    });
    await mkdir(join(root, "profiles", "second", "session-state"), {
      recursive: true,
    });
    await writeFile(
      join(root, "storage-version.json"),
      JSON.stringify({ version: 1 }),
    );

    await expect(
      migrateNestedStorage({ layout: first, apply: true }),
    ).resolves.toMatchObject({ status: "completed" });
    await expect(
      readFile(join(root, "storage-version.json"), "utf8"),
    ).resolves.toContain('"version":1');

    await expect(
      migrateNestedStorage({ layout: second, apply: true }),
    ).resolves.toMatchObject({ status: "completed" });
    await expect(
      readFile(join(root, "storage-version.json"), "utf8"),
    ).resolves.toContain('"version": 2');
  });

  it("dry-runs and applies the v1 nested migration without inferring projects", async () => {
    const home = await temporaryRoot();
    const layout = resolveLiveAgentStorage({ homeDirectory: home });
    const legacySessionStateDirectory = join(
      layout.profileRoot,
      "session-state",
    );
    const legacyProjectSessionsPath = join(
      layout.profileRoot,
      "state",
      "project-sessions.json",
    );
    await mkdir(join(layout.profileRoot, "state"), { recursive: true });
    await mkdir(join(legacySessionStateDirectory, "session-1", "artifacts"), {
      recursive: true,
    });
    await writeFile(
      join(layout.root, "storage-version.json"),
      JSON.stringify({ version: 1 }),
    );
    await writeFile(
      layout.sessionsPath,
      JSON.stringify({
        version: 3,
        sessions: [
          {
            id: "session-z",
            updatedAt: "2026-01-02T00:00:00.000Z",
            projectName: "Unsaved Live Set",
          },
          {
            id: "session-1",
            updatedAt: "2026-01-02T00:00:00.000Z",
            projectId: "legacy-set-1",
            projectName: "Song",
          },
        ],
      }),
    );
    await writeFile(
      legacyProjectSessionsPath,
      JSON.stringify({
        version: 1,
        associations: [
          {
            projectId: "legacy-set-1",
            projectName: "Song",
            sessionId: "session-1",
          },
        ],
      }),
    );
    await writeFile(
      join(legacySessionStateDirectory, "session-1", "session.json"),
      JSON.stringify({
        version: 1,
        productionSessionId: "session-1",
        updatedAt: "2026-01-02T00:00:00.000Z",
        projectId: "legacy-set-1",
        projectName: "Song",
      }),
    );
    const dryRun = await migrateNestedStorage({ layout });
    expect(dryRun.status).toBe("dry-run");
    expect(await stat(legacySessionStateDirectory)).toBeDefined();
    expect(
      JSON.parse(
        await readFile(join(layout.root, "storage-version.json"), "utf8"),
      ),
    ).toEqual({ version: 1 });

    const applied = await migrateNestedStorage({
      layout,
      apply: true,
      now: () => new Date("2026-09-20T12:00:00.000Z"),
    });
    expect(applied.status).toBe("completed");
    expect(applied.backupPath).toContain("backups/storage-v1-");
    expect(
      JSON.parse(
        await readFile(
          join(applied.backupPath!, "..", "storage-version.json"),
          "utf8",
        ),
      ),
    ).toEqual({ version: 1 });
    expect(
      JSON.parse(
        await readFile(join(layout.root, "storage-version.json"), "utf8"),
      ),
    ).toEqual({ version: LIVE_AGENT_STORAGE_VERSION });
    const migratedSession = resolveNestedSessionStorage(layout, {
      liveSetId: "legacy-set-1",
      sessionId: "session-1",
    });
    expect(
      JSON.parse(await readFile(migratedSession.manifestPath, "utf8")),
    ).toMatchObject({
      liveSetId: "legacy-set-1",
      liveSetName: "Song",
      createdAt: "2026-01-02T00:00:00.000Z",
    });
    expect(
      JSON.parse(await readFile(layout.sessionsPath, "utf8")),
    ).toMatchObject({
      version: 4,
      sessions: [
        {
          id: "session-1",
          createdAt: "2026-01-02T00:00:00.000Z",
          liveSetId: "legacy-set-1",
        },
        {
          id: "session-z",
          createdAt: "2026-01-02T00:00:00.000Z",
        },
      ],
    });
    expect(
      JSON.parse(await readFile(layout.liveSetSessionsPath, "utf8")),
    ).toMatchObject({
      associations: [
        {
          liveSetId: "legacy-set-1",
          liveSetName: "Song",
          sessionId: "session-1",
        },
      ],
    });
    await expect(stat(legacyProjectSessionsPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(legacySessionStateDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await stat(migratedSession.memoryDirectory)).toBeDefined();
    expect(await stat(layout.projectStateDirectory)).toBeDefined();
    expect(
      JSON.parse(await readFile(layout.liveProjectsRegistryPath, "utf8")),
    ).toEqual({ version: 1, revision: 0, projects: [] });
  });

  it("refuses partial nested layouts and incomplete legacy session directories", async () => {
    const home = await temporaryRoot();
    const layout = resolveLiveAgentStorage({ homeDirectory: home });
    await mkdir(layout.profileRoot, { recursive: true });
    await writeFile(
      join(layout.root, "storage-version.json"),
      JSON.stringify({ version: 1 }),
    );
    await mkdir(layout.projectStateDirectory);
    const partial = await migrateNestedStorage({ layout });
    expect(partial).toMatchObject({ status: "failed", applied: false });
    expect(partial.error).toContain("partial nested layout");

    await (
      await import("node:fs/promises")
    ).rm(layout.projectStateDirectory, {
      recursive: true,
    });
    await mkdir(join(layout.profileRoot, "session-state", "session-1"), {
      recursive: true,
    });
    const incomplete = await migrateNestedStorage({ layout });
    expect(incomplete.status).toBe("failed");
    expect(incomplete.error).toContain("has no session.json");
  });

  it("refuses unsupported storage versions", async () => {
    const home = await temporaryRoot();
    const layout = resolveLiveAgentStorage({ homeDirectory: home });
    await mkdir(layout.profileRoot, { recursive: true });
    await writeFile(
      join(layout.root, "storage-version.json"),
      JSON.stringify({ version: 99 }),
    );

    const result = await migrateNestedStorage({ layout });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("Storage version 99 is not supported");
  });

  it("rejects symbolic links in managed storage paths", async () => {
    const home = await temporaryRoot();
    const outside = await temporaryRoot();
    const root = join(home, ".live-agent");
    const { symlink } = await import("node:fs/promises");
    await mkdir(root);
    await symlink(outside, join(root, "system"));
    const layout = resolveLiveAgentStorage({ homeDirectory: home });

    await expect(ensureLiveAgentStorage(layout)).rejects.toThrow(
      "Symbolic links are not allowed",
    );
  });

  it("stages, validates, and publishes legacy data idempotently", async () => {
    const home = await temporaryRoot();
    const legacy = join(home, "legacy");
    await mkdir(join(legacy, "copilot"), { recursive: true });
    await writeFile(
      join(legacy, "preferences.json"),
      JSON.stringify({ version: 1 }),
    );
    await writeFile(join(legacy, "copilot", "session.json"), "{}");
    const layout = resolveLiveAgentStorage({ homeDirectory: home });

    const first = await migrateLegacyStorage({
      layout,
      entries: [
        {
          label: "preferences",
          source: join(legacy, "preferences.json"),
          destination: layout.preferencesPath,
          kind: "json",
        },
        {
          label: "copilot",
          source: join(legacy, "copilot"),
          destination: layout.copilotDirectory,
          kind: "directory",
        },
      ],
    });
    const second = await migrateLegacyStorage({ layout, entries: [] });

    expect(first.status).toBe("completed");
    expect(first.migrated).toEqual(["preferences", "copilot"]);
    expect(second.status).toBe("not-needed");
    expect(second.events.map(({ name }) => name)).toEqual([
      "storage.migration.queued",
      "storage.migration.cancelled",
    ]);
    expect(await readFile(layout.preferencesPath, "utf8")).toContain("version");
    expect(first.events.map(({ name }) => name)).toEqual([
      "storage.migration.queued",
      "storage.migration.started",
      "storage.migration.progress",
      "storage.migration.progress",
      "storage.migration.completed",
    ]);
  });

  it("skips legacy import for an explicitly isolated storage root", async () => {
    const home = await temporaryRoot();
    const source = join(home, "legacy-sessions.json");
    await writeFile(source, JSON.stringify([{ version: 3 }]));
    const layout = resolveLiveAgentStorage({
      environment: { LIVE_AGENT_HOME: join(home, "isolated") },
    });

    const result = await migrateLegacyStorage({
      layout,
      entries: [
        {
          label: "sessions",
          source,
          destination: layout.sessionsPath,
          kind: "json",
        },
      ],
      skipReason: "explicit-home-override",
    });

    expect(result.status).toBe("not-needed");
    expect(result.migrated).toEqual([]);
    expect(result.events.at(-1)).toMatchObject({
      name: "storage.migration.cancelled",
      outcome: "cancelled",
      attributes: {
        profile: layout.profile,
        reason: "explicit-home-override",
      },
    });
    await expect(readFile(layout.sessionsPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      readFile(layout.migrationMarkerPath, "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves legacy data untouched when validation fails", async () => {
    const home = await temporaryRoot();
    const source = join(home, "invalid.json");
    await writeFile(source, "not json");
    const layout = resolveLiveAgentStorage({ homeDirectory: home });

    const result = await migrateLegacyStorage({
      layout,
      entries: [
        {
          label: "preferences",
          source,
          destination: layout.preferencesPath,
          kind: "json",
        },
      ],
    });

    expect(result.status).toBe("failed");
    expect(await readFile(source, "utf8")).toBe("not json");
    await expect(stat(layout.profileRoot)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(result.events.at(-1)?.name).toBe("storage.migration.failed");
  });

  it("atomically merges non-conflicting canonical and legacy components", async () => {
    const home = await temporaryRoot();
    const layout = resolveLiveAgentStorage({ homeDirectory: home });
    await mkdir(layout.copilotDirectory, { recursive: true });
    await writeFile(join(layout.copilotDirectory, "cli-session.json"), "{}");
    const legacyPreferences = join(home, "preferences.json");
    await writeFile(legacyPreferences, JSON.stringify({ version: 1 }));

    const result = await migrateLegacyStorage({
      layout,
      entries: [
        {
          label: "preferences",
          source: legacyPreferences,
          destination: layout.preferencesPath,
          kind: "json",
        },
      ],
    });

    expect(result.status).toBe("completed");
    expect(await readFile(layout.preferencesPath, "utf8")).toContain("version");
    expect(
      await readFile(join(layout.copilotDirectory, "cli-session.json"), "utf8"),
    ).toBe("{}");
  });

  it("preserves both sides when canonical and legacy components conflict", async () => {
    const home = await temporaryRoot();
    const layout = resolveLiveAgentStorage({ homeDirectory: home });
    await mkdir(layout.copilotDirectory, { recursive: true });
    await writeFile(join(layout.copilotDirectory, "canonical.json"), "{}");
    const legacyCopilot = join(home, "legacy-copilot");
    await mkdir(legacyCopilot);
    await writeFile(join(legacyCopilot, "legacy.json"), "{}");

    const result = await migrateLegacyStorage({
      layout,
      entries: [
        {
          label: "copilot",
          source: legacyCopilot,
          destination: layout.copilotDirectory,
          kind: "directory",
        },
      ],
    });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("Migration conflict");
    expect(
      await readFile(join(layout.copilotDirectory, "canonical.json"), "utf8"),
    ).toBe("{}");
    expect(await readFile(join(legacyCopilot, "legacy.json"), "utf8")).toBe(
      "{}",
    );
  });
});
