import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { preferencesSchema } from "../contracts.js";
import { ApprovalCoordinator, ApprovalPolicyController } from "./approvals.js";
import { createDesktopComposition } from "./composition.js";

const directories: string[] = [];

async function paths() {
  const directory = await mkdtemp(join(tmpdir(), "ableton-desktop-comp-"));
  directories.push(directory);
  return {
    directory,
    preferencesPath: join(directory, "preferences.json"),
    sessionsPath: join(directory, "sessions.json"),
    agentBaseDirectory: join(directory, "copilot"),
    agentsDirectory: join(directory, "agents"),
    skillsDirectory: join(directory, "skills"),
  };
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("desktop composition", () => {
  it("configures the bridge from preferences and the stored token", async () => {
    const location = await paths();
    await writeFile(
      location.preferencesPath,
      JSON.stringify(preferencesSchema.parse({ abletonPort: 9123 })),
      "utf8",
    );

    const { runtime, preferences } = await createDesktopComposition({
      ...location,
      storedToken: "b".repeat(32),
      environment: {},
    });

    expect(preferences.abletonPort).toBe(9123);
    expect(runtime.abletonConfigured).toBe(true);
    await expect(runtime.ableton.getStatus()).resolves.toEqual({
      state: "disconnected",
    });
  });

  it("falls back to the environment token", async () => {
    const location = await paths();

    const { runtime } = await createDesktopComposition({
      ...location,
      environment: { ABLETON_AGENT_TOKEN: "c".repeat(32) },
    });

    expect(runtime.abletonConfigured).toBe(true);
  });

  it("reports a missing token instead of faking a connection", async () => {
    const location = await paths();

    const { runtime, service } = await createDesktopComposition({
      ...location,
      environment: {},
    });

    expect(runtime.abletonConfigured).toBe(false);
    await expect(runtime.ableton.getStatus()).resolves.toMatchObject({
      state: "error",
      code: "configuration_missing",
    });
    await expect(service.getDiagnostics()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "Bridge credentials",
          status: "warn",
        }),
      ]),
    );
  });

  it("keeps starting when a token is unusable and says why", async () => {
    const location = await paths();

    const { runtime, service } = await createDesktopComposition({
      ...location,
      storedToken: "too-short",
      environment: {},
    });

    expect(runtime.abletonConfigured).toBe(false);
    await expect(service.getDiagnostics()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "Bridge credentials",
          status: "fail",
        }),
      ]),
    );
  });

  it("uses defaults and warns when stored preferences are unreadable", async () => {
    const location = await paths();
    await writeFile(location.preferencesPath, "{not-json", "utf8");

    const { preferences, service } = await createDesktopComposition({
      ...location,
      environment: {},
    });

    expect(preferences).toEqual(preferencesSchema.parse({}));
    await expect(service.getDiagnostics()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Preferences", status: "warn" }),
      ]),
    );
  });

  it("wires effective active-agent YOLO IDs into the approval policy", async () => {
    const location = await paths();
    const publish = vi.spyOn(
      ApprovalPolicyController.prototype,
      "setAutoApprovedAgentInstanceIds",
    );
    const approvePending = vi.spyOn(
      ApprovalCoordinator.prototype,
      "approveForAgentInstanceIds",
    );
    const { service } = await createDesktopComposition({
      ...location,
      environment: {},
    });

    const callback = (
      service as unknown as {
        options: {
          onAutoApprovedAgentIdsChange: (ids: ReadonlySet<string>) => void;
        };
      }
    ).options.onAutoApprovedAgentIdsChange;
    const ids = new Set(["00000000-0000-4000-8000-000000000001"]);
    callback(ids);
    callback(new Set());

    expect(publish).toHaveBeenCalledWith(ids);
    expect(publish).toHaveBeenLastCalledWith(new Set());
    expect(approvePending).toHaveBeenCalledWith(ids);
    expect(approvePending).toHaveBeenCalledTimes(1);
    publish.mockRestore();
    approvePending.mockRestore();
  });
});
