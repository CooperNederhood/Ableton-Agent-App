import { access, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { _electron as electron, expect, test } from "@playwright/test";

const releaseRoot = resolve("release");
const syntheticBridgeToken = "a".repeat(64);

interface PackagedDesktopWindow {
  desktop: {
    lifecycle: { get(): Promise<string> };
    agents: {
      getAuthStatus(): Promise<{
        state: string;
        authType?: string;
      }>;
      refreshAuthentication(): Promise<{
        state: string;
        authType?: string;
      }>;
      listModels(): Promise<readonly { id: string }[]>;
    };
  };
}

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
  const explicit = process.env.ABLETON_AGENT_PACKAGED_EXECUTABLE?.trim();
  if (explicit) {
    await access(explicit);
    return explicit;
  }
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

function finderLikeEnvironment(
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const environment = {
    ...process.env,
    ...overrides,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  };
  for (const name of [
    "COPILOT_GITHUB_TOKEN",
    "COPILOT_HMAC_KEY",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GITHUB_COPILOT_API_TOKEN",
  ]) {
    delete environment[name];
  }
  return environment;
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
    env: finderLikeEnvironment({
      ABLETON_AGENT_TOKEN: syntheticBridgeToken,
      LIVE_AGENT_HOME: join(profile, "live-agent"),
      LIVE_AGENT_PROFILE: "default",
      NODE_ENV: "production",
    }),
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

test("authenticates the installed production application", async () => {
  test.skip(
    process.env.ABLETON_AGENT_AUTH_SMOKE !== "1",
    "Requires an authenticated local GitHub CLI and Copilot entitlement",
  );
  const profile = await mkdtemp(
    join(process.cwd(), "ableton-agent-packaged-auth-"),
  );
  const application = await electron.launch({
    executablePath: await packagedExecutable(),
    args: [`--user-data-dir=${join(profile, "electron")}`],
    cwd: process.cwd(),
    env: finderLikeEnvironment({
      ABLETON_AGENT_TOKEN: syntheticBridgeToken,
      LIVE_AGENT_HOME: join(profile, "live-agent"),
      LIVE_AGENT_PROFILE: "default",
      NODE_ENV: "production",
    }),
  });

  try {
    const window = await application.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    await expect
      .poll(() =>
        window.evaluate(() =>
          (window as unknown as PackagedDesktopWindow).desktop.lifecycle.get(),
        ),
      )
      .toMatch(/^(ready|degraded)$/u);
    const auth = await window.evaluate(() =>
      (
        window as unknown as PackagedDesktopWindow
      ).desktop.agents.getAuthStatus(),
    );
    expect(auth).toMatchObject({
      state: "authenticated",
      authType: "gh-cli",
    });
    const refreshed = await window.evaluate(() =>
      (
        window as unknown as PackagedDesktopWindow
      ).desktop.agents.refreshAuthentication(),
    );
    expect(refreshed).toMatchObject({
      state: "authenticated",
      authType: "gh-cli",
    });
    const models = await window.evaluate(() =>
      (window as unknown as PackagedDesktopWindow).desktop.agents.listModels(),
    );
    expect(models.length).toBeGreaterThan(0);
  } finally {
    await application.close();
    await rm(profile, { recursive: true, force: true });
  }
});
