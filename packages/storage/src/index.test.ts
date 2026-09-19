import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ensureLiveAgentStorage,
  migrateLegacyStorage,
  resolveLiveAgentStorage,
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
