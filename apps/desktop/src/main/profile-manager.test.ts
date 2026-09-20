import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ensureLiveAgentStorage,
  resolveLiveAgentStorage,
} from "@ableton-agent/storage";

import { DesktopProfileManager } from "./profile-manager.js";

const roots: string[] = [];

async function fixture(
  options: {
    activeSessionId?: string;
    switchFailure?: Error;
  } = {},
) {
  const root = await mkdtemp(join(process.cwd(), ".test-profile-manager-"));
  roots.push(root);
  const bundledAgentsDirectory = join(root, "bundled", "agents");
  const bundledSkillsDirectory = join(root, "bundled", "skills");
  await mkdir(bundledAgentsDirectory, { recursive: true });
  await mkdir(join(bundledSkillsDirectory, "mix-review"), { recursive: true });
  await writeFile(
    join(bundledAgentsDirectory, "default.yaml"),
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
  await writeFile(
    join(bundledSkillsDirectory, "mix-review", "SKILL.md"),
    [
      "---",
      "name: mix-review",
      "description: Review the mix.",
      "---",
      "Review the current mix.",
    ].join("\n"),
  );
  const layout = resolveLiveAgentStorage({
    environment: { LIVE_AGENT_HOME: join(root, "live-agent") },
  });
  await ensureLiveAgentStorage(layout);
  const events: Array<{ name: string }> = [];
  let activeProfile = "default";
  const switchProfile = vi.fn(async (profile: string) => {
    if (options.switchFailure !== undefined) throw options.switchFailure;
    activeProfile = profile;
  });
  const manager = new DesktopProfileManager({
    rootLayout: layout,
    bundledAgentsDirectory,
    bundledSkillsDirectory,
    getActiveProfile: () => activeProfile,
    getActiveSessionId: () => Promise.resolve(options.activeSessionId),
    refreshActiveCatalog: vi.fn().mockResolvedValue(undefined),
    switchProfile,
    telemetry: (event) => events.push(event),
  });
  return { manager, events, switchProfile };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("DesktopProfileManager", () => {
  it("shows the System baseline without repeating it in lower scopes", async () => {
    const { manager, events } = await fixture({
      activeSessionId: "session-1",
    });
    const initial = await manager.get();

    expect(initial.activeProfile).toBe("default");
    expect(initial.profiles.map(({ name }) => name)).toEqual(["default"]);
    expect(
      initial.artifacts.map(({ scope, kind, name }) => ({
        scope,
        kind,
        name,
      })),
    ).toEqual([
      { scope: "system", kind: "agent", name: "default" },
      { scope: "system", kind: "skill", name: "mix-review" },
    ]);
    expect(initial.profiles[0]?.sessions).toEqual([]);

    const created = await manager.create({
      name: "ambient",
      expectedRevision: initial.revision,
    });

    expect(created.selectedProfile).toBe("ambient");
    expect(created.profiles.map(({ name }) => name)).toEqual([
      "default",
      "ambient",
    ]);
    expect(events.map(({ name }) => name)).toEqual([
      "profile.create.queued",
      "profile.create.started",
      "profile.create.progress",
      "profile.create.completed",
    ]);
  });

  it("copies a bundled artifact into profile scope and uses tombstones", async () => {
    const { manager } = await fixture({ activeSessionId: "session-1" });
    const initial = await manager.get();

    const copied = await manager.copyArtifact({
      kind: "skill",
      name: "mix-review",
      source: { scope: "bundled" },
      destination: { scope: "profile", profile: "default" },
      expectedRevision: initial.revision,
    });
    expect(copied.status).toBe("completed");
    if (copied.status !== "completed") throw new Error("Expected completion");
    expect(
      copied.snapshot.artifacts.find(
        ({ scope, kind, name }) =>
          scope === "profile" && kind === "skill" && name === "mix-review",
      ),
    ).toMatchObject({ origin: "profile", state: "overridden" });

    const disabled = await manager.setArtifactDisabled({
      kind: "agent",
      name: "default",
      location: { scope: "profile", profile: "default" },
      disabled: true,
      expectedRevision: copied.snapshot.revision,
    });
    expect(
      disabled.artifacts.find(
        ({ scope, kind, name }) =>
          scope === "profile" && kind === "agent" && name === "default",
      ),
    ).toMatchObject({ state: "disabled", origin: "bundled" });
  });

  it("blocks profile switching while a production session is active", async () => {
    const { manager } = await fixture({ activeSessionId: "session-1" });
    const initial = await manager.get();
    const created = await manager.create({
      name: "ambient",
      expectedRevision: initial.revision,
    });

    await expect(
      manager.switch({
        name: "ambient",
        expectedRevision: created.revision,
      }),
    ).rejects.toThrow("Close the active production session");
  });

  it("switches profiles after the active session is closed", async () => {
    const { manager, switchProfile } = await fixture();
    const initial = await manager.get();
    const created = await manager.create({
      name: "ambient",
      expectedRevision: initial.revision,
    });

    await manager.switch({
      name: "ambient",
      expectedRevision: created.revision,
    });

    expect(switchProfile).toHaveBeenCalledWith("ambient");
    expect((await manager.get()).activeProfile).toBe("ambient");
  });

  it("rolls back profile selection when composition switching fails", async () => {
    const { manager } = await fixture({
      switchFailure: new Error("replacement failed"),
    });
    const initial = await manager.get();
    const created = await manager.create({
      name: "ambient",
      expectedRevision: initial.revision,
    });

    await expect(
      manager.switch({
        name: "ambient",
        expectedRevision: created.revision,
      }),
    ).rejects.toThrow("replacement failed");

    expect((await manager.get()).selectedProfile).toBe("default");
  });
});
