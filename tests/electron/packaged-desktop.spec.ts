import { access, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { _electron as electron, expect, test } from "@playwright/test";

const releaseRoot = resolve("release");

function packagedResources(directory: string): string {
  return join(
    releaseRoot,
    directory,
    "Ableton Agent.app",
    "Contents",
    "Resources",
  );
}

async function packagedExecutable(): Promise<string> {
  const directories =
    process.arch === "arm64" ? ["mac-arm64", "mac"] : ["mac", "mac-x64"];
  for (const directory of directories) {
    const executable = join(
      releaseRoot,
      directory,
      "Ableton Agent.app",
      "Contents",
      "MacOS",
      "Ableton Agent",
    );
    try {
      await access(executable);
      return executable;
    } catch {
      // Try the next electron-builder output directory for this architecture.
    }
  }
  throw new Error(
    `No packaged Ableton Agent executable for ${process.arch} was found under ${releaseRoot}. Run 'pnpm desktop:dist' first.`,
  );
}

test("bundles native runtime packages for both macOS architectures", async () => {
  for (const [directory, architecture] of [
    ["mac", "x64"],
    ["mac-arm64", "arm64"],
  ] as const) {
    const unpackedModules = join(
      packagedResources(directory),
      "app.asar.unpacked",
      "node_modules",
    );
    await expect(
      access(
        join(unpackedModules, "@github", `copilot-sdk-darwin-${architecture}`),
      ),
    ).resolves.toBeUndefined();
    await expect(
      access(join(unpackedModules, "@koromix", `koffi-darwin-${architecture}`)),
    ).resolves.toBeUndefined();
  }
});

test("launches the generated production application", async () => {
  const profile = await mkdtemp(
    join(process.cwd(), "ableton-agent-packaged-electron-"),
  );
  const application = await electron.launch({
    executablePath: await packagedExecutable(),
    args: [`--user-data-dir=${join(profile, "electron")}`],
    cwd: process.cwd(),
    env: {
      ...process.env,
      LIVE_AGENT_HOME: join(profile, "live-agent"),
      LIVE_AGENT_PROFILE: "default",
      NODE_ENV: "production",
    },
  });

  try {
    const runtime = await application.evaluate(({ app }) => ({
      appPath: app.getAppPath(),
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
    }));
    expect(runtime.isPackaged).toBe(true);
    expect(runtime.appPath).toMatch(/app\.asar$/u);
    await expect(
      access(join(runtime.resourcesPath, "agents")),
    ).resolves.toBeUndefined();
    await expect(
      access(join(runtime.resourcesPath, "skills")),
    ).resolves.toBeUndefined();
    await expect(
      access(join(runtime.resourcesPath, "remote-script", "AbletonAgent")),
    ).resolves.toBeUndefined();

    const window = await application.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    await expect(window).toHaveTitle("Ableton Agent");
    await expect(
      window.getByRole("navigation", { name: "Application views" }),
    ).toBeVisible();
  } finally {
    await application.close();
    await rm(profile, { recursive: true, force: true });
  }
});
