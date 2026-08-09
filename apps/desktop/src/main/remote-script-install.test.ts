import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  detectRemoteScriptLocations,
  inspectRemoteScriptInstallation,
  installRemoteScript,
  normalizeManualRemoteScriptsPath,
} from "./remote-script-install.js";

const artifacts = join(process.cwd(), ".test-artifacts");
const created: string[] = [];

async function workspace(): Promise<string> {
  const path = join(artifacts, randomUUID());
  created.push(path);
  await mkdir(path, { recursive: true });
  return path;
}

afterEach(async () => {
  await Promise.all(
    created.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("Remote Script location detection", () => {
  it("detects macOS User Library locations and an environment override", async () => {
    const home = await workspace();
    const custom = join(home, "Custom Library");
    await mkdir(custom, { recursive: true });
    const locations = await detectRemoteScriptLocations({
      platform: "darwin",
      homeDirectory: home,
      environment: { ABLETON_USER_LIBRARY: custom },
    });
    expect(locations[0]).toMatchObject({
      path: join(custom, "Remote Scripts"),
      source: "environment",
      available: true,
    });
    expect(locations.map(({ source }) => source)).toContain("macos-music");
  });

  it("normalizes User Library selections and preserves explicit script paths", () => {
    expect(
      normalizeManualRemoteScriptsPath("/Music/Ableton/User Library", "darwin"),
    ).toBe("/Music/Ableton/User Library/Remote Scripts");
    expect(
      normalizeManualRemoteScriptsPath(
        "C:\\Users\\me\\Remote Scripts",
        "win32",
      ),
    ).toBe("C:\\Users\\me\\Remote Scripts");
  });

  it("detects Windows Documents and OneDrive variants", async () => {
    const locations = await detectRemoteScriptLocations({
      platform: "win32",
      homeDirectory: "C:\\Users\\me",
      environment: {
        USERPROFILE: "C:\\Users\\me",
        OneDrive: "C:\\Users\\me\\OneDrive",
      },
    });
    expect(locations.map(({ path }) => path)).toEqual([
      "C:\\Users\\me\\Documents\\Ableton\\User Library\\Remote Scripts",
      "C:\\Users\\me\\OneDrive\\Documents\\Ableton\\User Library\\Remote Scripts",
    ]);
  });
});

describe("Remote Script installation", () => {
  it("installs, updates with a backup, and preserves the generated token", async () => {
    const root = await workspace();
    const source = join(root, "source");
    const remoteScripts = join(root, "User Library", "Remote Scripts");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "__init__.py"), "# script\n");
    await writeFile(join(source, ".ableton-agent-token"), "source-secret");

    const first = await installRemoteScript({
      sourcePath: source,
      remoteScriptsPath: remoteScripts,
      version: "1.0.0",
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(first.backupPath).toBeUndefined();
    await expect(
      readFile(join(first.destination, ".ableton-agent-token"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(join(first.destination, ".ableton-agent-token"), "secret");

    await writeFile(join(source, "__init__.py"), "# updated\n");
    const second = await installRemoteScript({
      sourcePath: source,
      remoteScriptsPath: remoteScripts,
      version: "1.1.0",
      now: new Date("2026-01-02T00:00:00.000Z"),
    });

    expect(second.backupPath).toBeDefined();
    expect(
      await readFile(join(second.destination, "__init__.py"), "utf8"),
    ).toBe("# updated\n");
    expect(
      await readFile(join(second.destination, ".ableton-agent-token"), "utf8"),
    ).toBe("secret");
    expect(
      await inspectRemoteScriptInstallation(remoteScripts, "1.1.0"),
    ).toMatchObject({ state: "current", installedVersion: "1.1.0" });
    expect(
      await readFile(join(second.backupPath!, "__init__.py"), "utf8"),
    ).toBe("# script\n");
  });

  it("recognizes unmanaged installations", async () => {
    const root = await workspace();
    const destination = join(root, "Remote Scripts", "AbletonAgent");
    await mkdir(destination, { recursive: true });
    await writeFile(join(destination, "__init__.py"), "# unmanaged\n");
    await expect(
      inspectRemoteScriptInstallation(join(root, "Remote Scripts"), "1.0.0"),
    ).resolves.toMatchObject({ state: "unmanaged" });
  });
});
