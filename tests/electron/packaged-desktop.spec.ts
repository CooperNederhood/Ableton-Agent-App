import {
  access,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { _electron as electron, expect, test } from "@playwright/test";
import { sendAutomationMessage } from "@ableton-agent/debug-control";
import { resolveLiveAgentStorage } from "../../packages/storage/src/index.js";
import {
  decodeAmxd,
  FLUCOMA_DEPENDENCY_FILES,
  isFlucomaDependencyResource,
  readIntegrationDevicePayloads,
} from "../../packages/shared/src/m4l-devices.js";
import {
  preferencesSchema,
  type DesktopApi,
  type DesktopAppEvent,
} from "../../apps/desktop/src/contracts.js";
import { bridgeTokenKey } from "../../apps/desktop/src/main/bridge-credentials.js";
import {
  closeOwnedPackagedApplication,
  withPackagedFixtureCleanup,
} from "./packaged-cleanup.js";
import {
  packagedExecutable,
  packagedResources,
  finderLikeEnvironment,
} from "./packaged-paths.js";

const syntheticBridgeToken = "a".repeat(64);

function integrationReceipt(raw: string) {
  const value: unknown = JSON.parse(raw);
  if (
    value === null ||
    typeof value !== "object" ||
    !("profile" in value) ||
    typeof value.profile !== "string" ||
    !("components" in value) ||
    !Array.isArray(value.components)
  )
    throw new Error("Invalid integration CLI receipt");
  const components = value.components.map((component: unknown) => {
    if (
      component === null ||
      typeof component !== "object" ||
      !("status" in component) ||
      typeof component.status !== "string"
    )
      throw new Error("Invalid integration component receipt");
    return { status: component.status };
  });
  return { profile: value.profile, components };
}

interface PackagedDesktopWindow {
  desktop: Pick<DesktopApi, "lifecycle" | "agents" | "eventHistory">;
}

type AutomationTestWindow = typeof globalThis.window & {
  desktop: DesktopApi;
  automationEvents: DesktopAppEvent[];
};

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
  test.setTimeout(60_000);
  const profile = await mkdtemp(
    join(process.cwd(), "ableton-agent-packaged-electron-"),
  );
  const storage = resolveLiveAgentStorage({
    environment: { LIVE_AGENT_HOME: join(profile, "live-agent") },
    profile: "default",
  });
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
    await expect
      .poll(
        () =>
          window.evaluate(() =>
            (
              window as unknown as PackagedDesktopWindow
            ).desktop.lifecycle.get(),
          ),
        { timeout: 30_000 },
      )
      .toMatch(/^(ready|degraded)$/u);
    const descriptor: unknown = JSON.parse(
      await readFile(storage.signalIngressDescriptorPath, "utf8"),
    );
    expect(descriptor).toMatchObject({ listenerVersions: [5] });
  } finally {
    await application.close();
    await expect(
      access(storage.signalIngressDescriptorPath),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await rm(profile, { recursive: true, force: true });
  }
});

test("installs both canonical Max bundles and Remote Script from packaged resources without a checkout", async () => {
  const root = await mkdtemp(
    join(process.cwd(), "ableton-agent-packaged-integrations-"),
  );
  try {
    const executable = await packagedExecutable();
    const resources = resolve(dirname(executable), "../Resources");
    const payload = join(resources, "ableton-integrations");
    expect(await readFile(join(payload, "integration-devices.json"))).toEqual(
      await readFile(
        resolve(
          "apps/desktop/build/ableton-integrations/integration-devices.json",
        ),
      ),
    );
    const devices = await readIntegrationDevicePayloads(payload);
    expect(devices.map(({ id }) => id).sort()).toEqual([
      "machine-listening",
      "midi-capture",
    ]);
    const userLibrary = join(root, "Library");
    await mkdir(userLibrary);
    const environment = finderLikeEnvironment({
      ELECTRON_RUN_AS_NODE: "1",
      LIVE_AGENT_HOME: join(root, "live-agent"),
      LIVE_AGENT_PROFILE: "automation",
    });
    const cli = join(
      resources,
      "app.asar",
      "dist",
      "main",
      "ableton-integrations-cli.js",
    );
    const args = [
      cli,
      "install",
      "--confirm",
      "--resources",
      resources,
      "--user-library",
      userLibrary,
    ];
    const first = await promisify(execFile)(executable, args, {
      cwd: root,
      env: environment,
      timeout: 60_000,
    });
    const receipt = integrationReceipt(first.stdout);
    expect(receipt.profile).toBe("automation");
    expect(receipt.components).toHaveLength(3);
    expect(
      receipt.components.every((component: { status: string }) =>
        ["installed", "current"].includes(component.status),
      ),
    ).toBe(true);
    await expect(
      access(
        join(userLibrary, "Remote Scripts", "AbletonAgent", "__init__.py"),
      ),
    ).resolves.toBeUndefined();
    for (const device of devices) {
      const folder =
        device.id === "machine-listening"
          ? [
              "Audio Effects",
              "Max Audio Effect",
              "Machine-Listening-Development",
            ]
          : ["MIDI Effects", "Max MIDI Effect", "Midi-Capture"];
      const installed = join(userLibrary, "Presets", ...folder);
      await expect(
        access(join(installed, device.deviceFile)),
      ).resolves.toBeUndefined();
      const configuration = await readFile(
        join(installed, "agent_signal_storage.js"),
        "utf8",
      );
      expect(configuration).toContain(
        join(root, "live-agent").replaceAll("\\", "\\\\"),
      );
      expect(configuration).toContain("automation");
      expect(configuration).not.toContain("Bearer ");
      for (const file of device.files)
        await expect(
          access(join(installed, file.name)),
        ).resolves.toBeUndefined();
      if (device.id === "machine-listening") {
        const frozen = decodeAmxd(
          await readFile(join(installed, device.deviceFile)),
        );
        expect(frozen.frozenFiles?.map((file) => file.name).sort()).toEqual(
          [
            ...device.files
              .map((file) => file.name)
              .filter(
                (name) =>
                  name !== "audio-listener-manifest.json" &&
                  !isFlucomaDependencyResource(name),
              ),
            "agent_signal_storage.js",
          ].sort(),
        );
        for (const dependency of FLUCOMA_DEPENDENCY_FILES) {
          const path = join(installed, dependency.name);
          expect(
            createHash("sha256")
              .update(await readFile(path))
              .digest("hex"),
          ).toBe(dependency.sha256);
          expect((await lstat(path)).mode & 0o777).toBe(dependency.mode);
        }
        expect(frozen.document).toMatchObject({
          patcher: {
            project: {
              searchpath: {
                "0": {
                  bootpath: join(installed, "dependencies/flucoma"),
                  enabled: 1,
                  recursive: 0,
                  includeincollective: 0,
                },
              },
            },
          },
        });
        for (const file of frozen.frozenFiles!.slice(1)) {
          expect(file.data).toEqual(await readFile(join(installed, file.name)));
          expect(file.flags).toBe(
            /\.(?:[cm]?js|json)$/u.test(file.name) ? 8 : 0,
          );
        }
        expect(
          frozen.frozenFiles!.find(
            (file) => file.name === "audio_listener_native_v5_max.js",
          )?.flags,
        ).toBe(8);
        for (const file of device.files) {
          if (
            file.name === "audio-listener-manifest.json" ||
            file.name === device.deviceFile
          )
            continue;
          expect(await readFile(join(installed, file.name))).toEqual(
            await readFile(join(device.sourceDirectory, file.name)),
          );
        }
      }
    }
    const second = await promisify(execFile)(executable, args, {
      cwd: root,
      env: environment,
      timeout: 60_000,
    });
    expect(
      integrationReceipt(second.stdout).components.every(
        (component: { status: string }) => component.status === "current",
      ),
    ).toBe(true);

    const damaged = join(root, "damaged-payload");
    await cp(payload, damaged, { recursive: true });
    const staged = await readIntegrationDevicePayloads(damaged);
    const midi = staged.find(({ id }) => id === "midi-capture");
    expect(midi).toBeDefined();
    if (midi === undefined) throw new Error("Packaged MIDI payload is missing");
    await rm(join(midi.sourceDirectory, "midi_capture_writer.js"));
    const otherLibrary = join(root, "Other Library");
    await mkdir(otherLibrary);
    await expect(
      promisify(execFile)(
        executable,
        [
          cli,
          "install",
          "--confirm",
          "--resources",
          resources,
          "--payload",
          damaged,
          "--user-library",
          otherLibrary,
        ],
        { cwd: root, env: environment, timeout: 60_000 },
      ),
    ).rejects.toMatchObject({
      code: 1,
    });
    await expect(
      access(join(otherLibrary, "Remote Scripts")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
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

test("completes two pinned automation turns with the packaged Default agent", async () => {
  test.skip(
    process.env.ABLETON_AGENT_AUTH_SMOKE !== "1",
    "Requires an authenticated local GitHub CLI and Copilot entitlement",
  );
  test.setTimeout(180_000);
  const profile = await mkdtemp(
    join(process.cwd(), "ableton-agent-packaged-conversation-"),
  );
  const descriptorPath = join(profile, "automation-endpoint.json");
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    application = await electron.launch({
      executablePath: await packagedExecutable(),
      args: [
        "--automation",
        "--automation-profile",
        profile,
        "--automation-descriptor",
        descriptorPath,
        "--automation-agent",
        "default",
      ],
      cwd: process.cwd(),
      env: finderLikeEnvironment({
        ABLETON_AGENT_TOKEN: syntheticBridgeToken,
        NODE_ENV: "production",
      }),
    });
    const window = await application.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    await expect
      .poll(
        async () => {
          try {
            const descriptor: unknown = JSON.parse(
              await readFile(descriptorPath, "utf8"),
            );
            return descriptor !== null &&
              typeof descriptor === "object" &&
              "processId" in descriptor
              ? descriptor.processId
              : null;
          } catch (error) {
            if (
              error instanceof Error &&
              "code" in error &&
              error.code === "ENOENT"
            )
              return null;
            throw error;
          }
        },
        { timeout: 60_000 },
      )
      .toBe(application.process().pid);
    await expect
      .poll(
        async () =>
          window.evaluate(async () => {
            const desktop = (globalThis.window as AutomationTestWindow).desktop;
            const [agents, sessions, outputs] = await Promise.all([
              desktop.agents.listActive(),
              desktop.agent.getSessions(),
              desktop.outputs.list(),
            ]);
            const session = sessions.find(
              ({ id }) => id === outputs.activeSessionId,
            );
            return agents.find(
              ({ id }) => id === session?.selectedAgentInstanceId,
            )?.lifecycle;
          }),
        { timeout: 60_000 },
      )
      .toBe("ready");
    const target = await window.evaluate(async () => {
      const desktop = (globalThis.window as AutomationTestWindow).desktop;
      const outputs = await desktop.outputs.list();
      const session = (await desktop.agent.getSessions()).find(
        ({ id }) => id === outputs.activeSessionId,
      );
      const agent = (await desktop.agents.listActive()).find(
        ({ id }) => id === session?.selectedAgentInstanceId,
      );
      if (
        !session ||
        !agent?.sdkSessionId ||
        agent.definitionName !== "default" ||
        agent.modified ||
        agent.autoApprove ||
        agent.mode === "plan"
      )
        throw new Error(
          "Expected unmodified Default agent with normal approvals",
        );
      return {
        appSessionId: session.id,
        agentInstanceId: agent.id,
        sdkSessionId: agent.sdkSessionId,
      };
    });
    const descriptor: unknown = JSON.parse(
      await readFile(descriptorPath, "utf8"),
    );
    expect(descriptor).toMatchObject({ processId: application.process().pid });
    await window.evaluate(() => {
      const state = globalThis.window as AutomationTestWindow;
      state.automationEvents = [];
      state.desktop.events.subscribe((event) => {
        if (state.automationEvents.length >= 1000)
          throw new Error("Automation smoke event bound exceeded");
        state.automationEvents.push(event);
      });
    });
    const operationIds = new Set<string>();
    for (const [message, response] of [
      [
        "Remember the codeword violet for this conversation. Reply exactly READY. Do not use any tools.",
        "READY",
      ],
      [
        "What codeword did I ask you to remember? Reply with only that word. Do not use any tools.",
        "violet",
      ],
    ]) {
      const accepted = await sendAutomationMessage({
        descriptorPath,
        message: message!,
        expectedTarget: target,
      });
      expect(accepted.turn?.target).toEqual(target);
      expect(accepted.turn?.assistantMessageId).toBeTruthy();
      expect(operationIds.has(accepted.messageId)).toBe(false);
      operationIds.add(accepted.messageId);
      const assistantMessageId = accepted.turn!.assistantMessageId;
      await expect
        .poll(
          async () =>
            window.evaluate(
              ({ operationId, assistantMessageId, target }) => {
                const events = (
                  globalThis.window as AutomationTestWindow
                ).automationEvents.filter(
                  (event) =>
                    "agentInstanceId" in event &&
                    event.agentInstanceId === target.agentInstanceId &&
                    "sdkSessionId" in event &&
                    event.sdkSessionId === target.sdkSessionId,
                );
                const completion = events.find(
                  (event) =>
                    event.type === "agent.message_complete" &&
                    event.messageId === assistantMessageId,
                );
                const operation = events
                  .filter(
                    (event) =>
                      event.type === "operation.changed" &&
                      event.operation.id === operationId,
                  )
                  .at(-1);
                return {
                  text:
                    completion?.type === "agent.message_complete"
                      ? completion.content.trim()
                      : null,
                  status:
                    operation?.type === "operation.changed"
                      ? operation.operation.status
                      : null,
                  approvals: events.filter(
                    (event) => event.type === "approval.requested",
                  ).length,
                };
              },
              { operationId: accepted.messageId, assistantMessageId, target },
            ),
          { timeout: 60_000 },
        )
        .toEqual({
          text: response,
          status: "completed",
          approvals: 0,
        });
      await expect(window.getByText(message!, { exact: true })).toHaveCount(1);
    }
  } finally {
    if (application) {
      const cleanup = await closeOwnedPackagedApplication(application);
      expect(
        cleanup.successful,
        "Owned Desktop shutdown must precede profile removal",
      ).toBe(true);
    }
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
  const run = async () => {
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
      const receipt = await closeOwnedPackagedApplication(application);
      if (receipt.stopped) application = undefined;
      await test.info().attach(`owned-packaged-${source}-shutdown`, {
        body: JSON.stringify(receipt),
        contentType: "application/json",
      });
      if (!receipt.successful)
        throw new Error(
          "Packaged vault restart shutdown failed; inspect its cleanup receipt",
        );
    }
    expect(new Set(traceIds).size).toBe(2);
  };
  await withPackagedFixtureCleanup({
    run,
    getApplication: () => application,
    resources: [
      async () => {
        if (signal.listening)
          await new Promise<void>((resolve, reject) =>
            signal.close((error) => (error ? reject(error) : resolve())),
          );
      },
      async () => {
        if (bridge.listening)
          await new Promise<void>((resolve, reject) =>
            bridge.close((error) => (error ? reject(error) : resolve())),
          );
      },
    ],
    removeProfile: () => rm(profile, { recursive: true, force: true }),
    report: (receipt) =>
      test.info().attach("owned-packaged-fixture-cleanup", {
        body: JSON.stringify(receipt),
        contentType: "application/json",
      }),
  });
});
