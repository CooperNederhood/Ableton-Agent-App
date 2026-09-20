import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ensureLiveAgentStorage,
  createProfile,
  deleteProfile,
  loadProfileRegistry,
  migrateLegacyStorage,
  readArtifactTombstones,
  renameProfile,
  resolveArtifactScopePaths,
  resolveProductionSessionStorage,
  resolveLiveAgentStorage,
  selectProfile,
  writeArtifactTombstones,
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
    const root = join(process.cwd(), ".session-state");
    const ordinary = resolveProductionSessionStorage(root, "session:123");
    const unsafe = resolveProductionSessionStorage(root, "../outside");

    expect(ordinary.planPath).toBe(
      join(root, "session:123", "artifacts", "plan.md"),
    );
    expect(ordinary.manifestPath).toBe(
      join(root, "session:123", "session.json"),
    );
    expect(unsafe.sessionDirectory).toMatch(
      new RegExp(
        `^${root.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}/session-[a-f0-9]{64}$`,
        "u",
      ),
    );
    expect(unsafe.planPath.startsWith(`${root}/`)).toBe(true);
    expect(() => resolveProductionSessionStorage(root, "")).toThrow(
      "must not be empty",
    );
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
      resolveArtifactScopePaths(layout, "session", "session:123"),
    ).toMatchObject({
      agentTombstonesPath: join(
        home,
        ".live-agent",
        "profiles",
        "default",
        "session-state",
        "session:123",
        "artifact-state",
        "agents.json",
      ),
    });
    expect(() => resolveArtifactScopePaths(layout, "session")).toThrow(
      "Production session ID is required",
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
    ).toMatchObject({ version: 1 });
    expect((await stat(layout.systemAgentsDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(layout.profileSkillsDirectory)).mode & 0o777).toBe(
      0o700,
    );
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
