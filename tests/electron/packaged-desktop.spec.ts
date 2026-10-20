import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { _electron as electron, expect, test } from "@playwright/test";
import { resolveLiveAgentStorage } from "../../packages/storage/src/index.js";
import {
  preferencesSchema,
  type DesktopApi,
} from "../../apps/desktop/src/contracts.js";
import { bridgeTokenKey } from "../../apps/desktop/src/main/bridge-credentials.js";

const releaseRoot = resolve("release");
const syntheticBridgeToken = "a".repeat(64);

interface PackagedDesktopWindow {
  desktop: Pick<DesktopApi, "lifecycle" | "agents" | "eventHistory">;
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
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries({
    ...process.env,
    ...overrides,
  })) {
    if (value !== undefined) environment[name] = value;
  }
  environment.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
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
    expect(auth).toMatchObject({ state: "authenticated", authType: "gh-cli" });
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

test("provisions and decrypts an installed token through the real packaged OS vault without an environment-token override", async () => {
  test.skip(process.platform !== "darwin", "Requires the macOS Keychain");
  test.setTimeout(90_000);
  const profile = await mkdtemp(
    join(process.cwd(), "ableton-agent-packaged-native-vault-"),
  );
  const bridge = createServer((socket) => socket.destroy());
  const signal = createServer();
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    await new Promise<void>((resolve) =>
      bridge.listen(0, "127.0.0.1", resolve),
    );
    await new Promise<void>((resolve) =>
      signal.listen(0, "127.0.0.1", resolve),
    );
    const bridgeAddress = bridge.address();
    const signalAddress = signal.address();
    if (
      bridgeAddress === null ||
      typeof bridgeAddress === "string" ||
      signalAddress === null ||
      typeof signalAddress === "string"
    )
      throw new Error("Expected owned fixture ports");
    await new Promise<void>((resolve, reject) =>
      signal.close((error) => (error ? reject(error) : resolve())),
    );
    const environment = finderLikeEnvironment({
      LIVE_AGENT_HOME: join(profile, "live-agent"),
      LIVE_AGENT_PROFILE: "automation",
      NODE_ENV: "production",
    });
    delete environment.ABLETON_AGENT_TOKEN;
    expect(environment.ABLETON_AGENT_TOKEN).toBeUndefined();
    const storage = resolveLiveAgentStorage({ environment });
    const remoteScripts = join(
      profile,
      "fixture-user-library",
      "Remote Scripts",
    );
    await mkdir(join(remoteScripts, "AbletonAgent"), { recursive: true });
    await writeFile(
      join(remoteScripts, "AbletonAgent", ".ableton-agent-token"),
      syntheticBridgeToken,
      { mode: 0o600 },
    );
    await mkdir(dirname(storage.preferencesPath), { recursive: true });
    await writeFile(
      storage.preferencesPath,
      JSON.stringify(
        preferencesSchema.parse({
          remoteScriptLocation: remoteScripts,
          abletonPort: bridgeAddress.port,
          signalPort: signalAddress.port,
        }),
      ),
      { mode: 0o600 },
    );
    const encryptedTokenPath = join(
      storage.credentialsDirectory,
      bridgeTokenKey,
    );
    let encrypted: Buffer | undefined;
    const traceIds: string[] = [];
    for (const source of ["remote-script", "vault"] as const) {
      application = await electron.launch({
        executablePath: await packagedExecutable(),
        args: [
          `--user-data-dir=${join(profile, "electron")}`,
          "--automation",
          "--automation-profile",
          profile,
          "--automation-descriptor",
          join(profile, "automation-endpoint.json"),
          "--automation-agent",
          "default",
        ],
        cwd: process.cwd(),
        env: environment,
        timeout: 20_000,
      });
      const launch = await application.evaluate(({ app }) => ({
        packaged: app.isPackaged,
        arguments: process.argv,
        environmentTokenPresent: process.env.ABLETON_AGENT_TOKEN !== undefined,
      }));
      expect(launch.packaged).toBe(true);
      expect(launch.environmentTokenPresent).toBe(false);
      expect(launch.arguments).not.toContain("--use-mock-keychain");
      expect(launch.arguments).not.toContain("--password-store=basic");
      const window = await application
        .firstWindow({ timeout: 15_000 })
        .catch(async (error: unknown) => {
          const processId = application?.process().pid;
          if (processId !== undefined) {
            try {
              const sample = await promisify(execFile)(
                "/usr/bin/sample",
                [String(processId), "1", "1"],
                { timeout: 5_000, maxBuffer: 2_000_000 },
              );
              await test.info().attach("owned-startup-native-sample", {
                body: sample.stdout,
                contentType: "text/plain",
              });
            } catch (sampleError) {
              await test.info().attach("owned-startup-sample-error", {
                body: String(sampleError),
                contentType: "text/plain",
              });
            }
          }
          throw error;
        });
      await expect(
        window.getByRole("navigation", {
          name: "Application views",
        }),
      ).toBeVisible();
      await expect
        .poll(() =>
          window.evaluate(() =>
            (
              window as unknown as PackagedDesktopWindow
            ).desktop.lifecycle.get(),
          ),
        )
        .toMatch(/^(ready|degraded)$/u);
      const history = await window.evaluate(async () => {
        const api = (window as unknown as PackagedDesktopWindow).desktop;
        const roots = await api.eventHistory.search({
          names: ["desktop.bridge_credentials.completed"],
          order: "desc",
          limit: 5,
        });
        const root = roots.items[0];
        if (root === undefined) throw new Error("Missing credential lifecycle");
        return api.eventHistory.trace(root.rootTraceId, {
          order: "asc",
          limit: 20,
        });
      });
      const credentialEvents = history.items.filter((event) =>
        event.name.startsWith("desktop.bridge_credentials."),
      );
      expect(credentialEvents.map((event) => event.name)).toEqual([
        "desktop.bridge_credentials.queued",
        "desktop.bridge_credentials.started",
        "desktop.bridge_credentials.completed",
      ]);
      const completed = credentialEvents.at(-1)!;
      expect(completed.attributes).toMatchObject({
        source,
        ...(source === "remote-script" ? { persisted: true } : {}),
      });
      expect(completed.durationMs).toBeGreaterThanOrEqual(0);
      expect(completed.trace?.traceId).toBeDefined();
      expect(completed.correlationId).toBeDefined();
      expect(
        credentialEvents.every(
          (event) =>
            event.trace?.traceId === completed.trace?.traceId &&
            event.correlationId === completed.correlationId,
        ),
      ).toBe(true);
      expect(JSON.stringify(history).includes(syntheticBridgeToken)).toBe(
        false,
      );
      traceIds.push(completed.trace!.traceId);
      const bytes = await readFile(encryptedTokenPath);
      expect(bytes.length).toBeGreaterThan(0);
      expect(bytes.includes(Buffer.from(syntheticBridgeToken))).toBe(false);
      if (encrypted === undefined) encrypted = bytes;
      else expect(bytes.equals(encrypted)).toBe(true);
      await application.close();
      application = undefined;
    }
    expect(new Set(traceIds).size).toBe(2);
  } finally {
    await application?.close();
    if (signal.listening)
      await new Promise<void>((resolve, reject) =>
        signal.close((error) => (error ? reject(error) : resolve())),
      );
    if (bridge.listening)
      await new Promise<void>((resolve, reject) =>
        bridge.close((error) => (error ? reject(error) : resolve())),
      );
    await rm(profile, { recursive: true, force: true });
  }
});
