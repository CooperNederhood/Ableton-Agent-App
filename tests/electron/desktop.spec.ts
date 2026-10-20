import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:net";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

import { _electron as electron, expect, test } from "@playwright/test";
import { sendAutomationMessage } from "../../packages/debug-control/src/client.js";
import { resolveLiveAgentStorage } from "../../packages/storage/src/index.js";
import type { DesktopEntityContextApi } from "../../apps/desktop/src/context-contracts.js";
import type { DesktopListeningPage } from "../../apps/desktop/src/listening-contracts.js";
import { preferencesSchema } from "../../apps/desktop/src/contracts.js";
import type { DesktopApi } from "../../apps/desktop/src/contracts.js";
import {
  listeningFixturePassId,
  listeningFixtureSessionId,
  seedListeningContext,
  seedMixedListeningContext,
  descriptiveFixturePassId,
} from "./listening-context-fixture.js";
import {
  createDesktopTestEnvironment,
  writeDesktopTestPreferences,
} from "./desktop-test-environment.js";

const desktopPath = resolve("apps/desktop");

interface ElectronTestDesktopApi {
  agent: DesktopApi["agent"];
  ableton: DesktopApi["ableton"];
  entityContext: DesktopEntityContextApi;
  agents: {
    listActive(): Promise<Array<{ id: string }>>;
  };
}

test.setTimeout(60_000);
const ownedRejectingBridges = new Set<Server>();
test.afterEach(async () => {
  await Promise.all(
    [...ownedRejectingBridges].map(async (server) => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      ownedRejectingBridges.delete(server);
    }),
  );
});

async function isolatedTestEnvironment(
  profile: string,
  overrides: Record<string, string> = {},
  signalPort?: number,
  automation = false,
) {
  const bridge = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => bridge.listen(0, "127.0.0.1", resolve));
  ownedRejectingBridges.add(bridge);
  const address = bridge.address();
  if (address === null || typeof address === "string")
    throw new Error("Expected owned rejecting bridge port");
  const environment = createDesktopTestEnvironment({
    profile,
    bridgePort: address.port,
    automation,
    overrides,
  });
  await mkdir(environment.HOME!, { recursive: true });
  await mkdir(environment.TMPDIR!, { recursive: true });
  if (signalPort === undefined) {
    const reservation = createServer();
    await new Promise<void>((resolve) =>
      reservation.listen(0, "127.0.0.1", resolve),
    );
    const reserved = reservation.address();
    await new Promise<void>((resolve, reject) =>
      reservation.close((error) => (error ? reject(error) : resolve())),
    );
    if (reserved === null || typeof reserved === "string")
      throw new Error("Expected owned signal fixture port");
    signalPort = reserved.port;
  }
  await writeDesktopTestPreferences(environment, signalPort);
  return environment;
}

async function launchIsolatedDesktop(
  overrides: Record<string, string> = {},
  signalPort?: number,
  setup?: (profile: string) => Promise<void>,
) {
  const profile = await mkdtemp(join(process.cwd(), "ableton-agent-electron-"));
  try {
    await setup?.(profile);
    const environment = await isolatedTestEnvironment(
      profile,
      overrides,
      signalPort,
    );
    const application = await electron.launch({
      args: [desktopPath, `--user-data-dir=${join(profile, "electron")}`],
      cwd: process.cwd(),
      env: environment,
    });
    return { application, profile, environment };
  } catch (error) {
    try {
      await rm(profile, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Electron launch and owned-profile cleanup failed",
      );
    }
    throw error;
  }
}

async function launchAutomationDesktop() {
  const profile = await mkdtemp(join(process.cwd(), "ableton-agent-electron-"));
  const application = await electron.launch({
    args: [
      desktopPath,
      `--user-data-dir=${join(profile, "electron")}`,
      "--automation",
      "--automation-profile",
      profile,
      "--automation-agent",
      "default",
      "--automation-yolo",
    ],
    cwd: process.cwd(),
    env: await isolatedTestEnvironment(profile, {}, undefined, true),
  });
  return { application, profile };
}

test("binds first-connected Live ownership through production main/preload and restores it after restart", async () => {
  const { application, profile, environment } = await launchIsolatedDesktop();
  const initialProcess = application.process();
  let restarted: typeof application | undefined;
  let simulator: ReturnType<typeof spawn> | undefined;
  try {
    const window = await application.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    const sessions = () =>
      window.evaluate(() =>
        (
          globalThis.window as unknown as {
            desktop: ElectronTestDesktopApi;
          }
        ).desktop.agent.getSessions(),
      );
    await expect
      .poll(async () => (await sessions()).length, { timeout: 30_000 })
      .toBe(1);
    const orphan = (await sessions())[0]!;
    expect(orphan.liveSetId).toBe(`orphan:${orphan.id}`);
    const port = Number(environment.ABLETON_AGENT_PORT);
    const rejectingBridge = [...ownedRejectingBridges].find((server) => {
      const address = server.address();
      return (
        address !== null && typeof address !== "string" && address.port === port
      );
    });
    if (rejectingBridge === undefined)
      throw new Error("Expected this test's rejecting bridge");
    await new Promise<void>((resolve, reject) =>
      rejectingBridge.close((error) => (error ? reject(error) : resolve())),
    );
    ownedRejectingBridges.delete(rejectingBridge);
    simulator = spawn(
      "python3",
      [
        "remote-script/simulator.py",
        "--port",
        String(port),
        "--token",
        environment.ABLETON_AGENT_TOKEN!,
        "--connections",
        "10",
        "--saved-live-set",
      ],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
    );
    const lines = createInterface({ input: simulator.stdout! });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Simulator startup timed out")),
          5000,
        );
        const finish = (error?: Error) => {
          clearTimeout(timer);
          if (error === undefined) resolve();
          else reject(error);
        };
        lines.once("line", (line) => {
          try {
            expect(JSON.parse(line)).toMatchObject({ host: "127.0.0.1", port });
            finish();
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
          }
        });
        simulator!.once("error", finish);
        simulator!.once("exit", (code) =>
          finish(new Error(`Simulator exited ${code}`)),
        );
      });
    } finally {
      lines.close();
    }
    await window.evaluate(() =>
      (
        globalThis.window as unknown as { desktop: ElectronTestDesktopApi }
      ).desktop.ableton.connect(),
    );
    await expect
      .poll(async () => (await sessions())[0]?.liveSetId)
      .toBe("simulated-live-set");
    expect((await sessions())[0]?.id).toBe(orphan.id);
    await window.getByRole("button", { name: "Profiles", exact: true }).click();
    await window
      .getByRole("button", { name: "Expand unassigned Live Sets" })
      .click();
    await expect(
      window.getByRole("button", {
        name: "Expand Simulated Set Live Set",
      }),
    ).toBeVisible();
    await expect(
      window.getByRole("button", {
        name: "Expand No connected Live Set Live Set",
      }),
    ).toHaveCount(0);
    await application.close();
    restarted = await electron.launch({
      args: [desktopPath, `--user-data-dir=${join(profile, "electron")}`],
      cwd: process.cwd(),
      env: environment,
    });
    const reopened = await restarted.firstWindow();
    await expect
      .poll(() =>
        reopened.evaluate(() =>
          (
            globalThis.window as unknown as { desktop: ElectronTestDesktopApi }
          ).desktop.agent.getSessions(),
        ),
      )
      .toContainEqual(
        expect.objectContaining({
          id: orphan.id,
          liveSetId: "simulated-live-set",
        }),
      );
  } finally {
    await restarted?.close();
    if (initialProcess.exitCode === null) await application.close();
    if (simulator !== undefined && simulator.exitCode === null) {
      const exited = new Promise<void>((resolve) =>
        simulator!.once("exit", () => resolve()),
      );
      simulator.kill();
      await exited;
    }
    await rm(profile, { recursive: true, force: true });
  }
});

test("round-trips listening Settings through typed preload and the isolated profile across restart without Live", async () => {
  const launched = await launchIsolatedDesktop();
  let application = launched.application;
  try {
    let window = await application.firstWindow();
    await window.getByRole("button", { name: "Settings", exact: true }).click();
    const mode = window.getByRole("combobox", {
      name: "Listening timing mode",
    });
    const limit = window.getByRole("spinbutton", {
      name: "Configured acceptance limit (samples)",
    });
    await expect(mode).toHaveValue("descriptive");
    await expect(limit).toHaveValue("64");
    await limit.fill("128");
    await expect(limit).toHaveValue("128");
    await window
      .getByRole("button", { name: "Save settings", exact: true })
      .click();
    await expect(
      window.getByText("Settings saved.", { exact: true }),
    ).toBeVisible();
    await expect(limit).toHaveValue("128");
    expect(
      (await window.evaluate(() => globalThis.window.desktop.preferences.get()))
        .listening,
    ).toEqual({
      mode: "descriptive",
      maxClockDisagreementSamples: 128,
    });
    await mode.selectOption("strict");
    await expect(limit).toBeDisabled();
    await expect(limit).toHaveValue("0");
    await expect(
      window.getByText("Settings saved.", { exact: true }),
    ).not.toBeVisible();
    await window
      .getByRole("button", { name: "Save settings", exact: true })
      .click();
    await expect
      .poll(
        async () =>
          (
            await window.evaluate(() =>
              globalThis.window.desktop.preferences.get(),
            )
          ).listening,
      )
      .toEqual({
        mode: "strict",
        maxClockDisagreementSamples: 0,
      });
    const storage = resolveLiveAgentStorage({
      environment: launched.environment,
    });
    const persisted = preferencesSchema.parse(
      JSON.parse(await readFile(storage.preferencesPath, "utf8")),
    );
    expect(persisted.listening).toEqual({
      mode: "strict",
      maxClockDisagreementSamples: 0,
    });
    await application.close();
    application = await electron.launch({
      args: [
        desktopPath,
        `--user-data-dir=${join(launched.profile, "electron")}`,
      ],
      cwd: process.cwd(),
      env: launched.environment,
    });
    window = await application.firstWindow();
    await window.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(
      window.getByRole("combobox", { name: "Listening timing mode" }),
    ).toHaveValue("strict");
    await expect(
      window.getByRole("spinbutton", {
        name: "Configured acceptance limit (samples)",
      }),
    ).toBeDisabled();
    await expect(
      window.getByText(
        /All new observations remain approximate and descriptive-only/,
      ),
    ).toBeVisible();
  } finally {
    await application.close();
    await rm(launched.profile, { recursive: true, force: true });
  }
});

test("shows synthetic listening lifecycle through real preload events and read-only IPC without starting Live", async () => {
  const bridge = createServer((socket) => socket.destroy());
  const reservation = createServer();
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
  let profile: string | undefined;
  try {
    await new Promise<void>((resolve) =>
      bridge.listen(0, "127.0.0.1", resolve),
    );
    await new Promise<void>((resolve) =>
      reservation.listen(0, "127.0.0.1", resolve),
    );
    const address = bridge.address();
    const signalAddress = reservation.address();
    if (
      address === null ||
      typeof address === "string" ||
      signalAddress === null ||
      typeof signalAddress === "string"
    )
      throw new Error("Expected owned isolated fixture ports");
    await new Promise<void>((resolve, reject) =>
      reservation.close((error) => (error ? reject(error) : resolve())),
    );
    const launched = await launchIsolatedDesktop(
      {
        ABLETON_AGENT_TOKEN: "isolated-listening-lifecycle-synthetic-fixture",
        ABLETON_AGENT_PORT: String(address.port),
      },
      signalAddress.port,
      seedListeningContext,
    );
    application = launched.application;
    profile = launched.profile;
    const window = await application.firstWindow();
    await window.getByRole("button", { name: "Outputs", exact: true }).click();
    await expect(
      window.getByText("Listening passes", { exact: true }),
    ).toBeVisible();
    await expect(
      window.getByText(
        "No listening passes for this agent in this App session.",
      ),
    ).toBeVisible();
    const owner = await window.evaluate(async () => {
      const desktop = globalThis.window.desktop;
      const outputs = await desktop.outputs.list();
      const sessions = await desktop.agent.getSessions();
      const session = sessions.find(({ id }) => id === outputs.activeSessionId);
      if (session?.selectedAgentInstanceId === undefined)
        throw new Error("Missing isolated selected agent");
      return {
        sessionId: session.id,
        liveSetId: session.liveSetId,
        agentId: session.selectedAgentInstanceId,
      };
    });
    const page: DesktopListeningPage = {
      sessionId: owner.sessionId,
      revision: 100,
      jobs: [
        {
          ...owner,
          passId: "synthetic-electron-pass-not-measured",
          trace: {
            traceId: "00000000-0000-4000-8000-000000000001",
            correlationId: "synthetic-electron",
            causationId: "fixture",
          },
          stage: "queued",
          createdAt: "2026-10-12T00:00:00.000Z",
          updatedAt: "2026-10-12T00:00:00.000Z",
          durationMs: 1250,
          contextIds: [],
          cleanupPolicy: "leave-running",
          evidence: "lifecycle-only",
          error: "Synthetic lifecycle fixture—not measured audio.",
        },
      ],
    };
    const inject = async (value: DesktopListeningPage) => {
      await application!.evaluate(({ BrowserWindow }, snapshot) => {
        // Test-owned Electron fixture only; no production injection/debug endpoint.
        for (const browser of BrowserWindow.getAllWindows())
          browser.webContents.send("app:event", {
            type: "listening.changed",
            page: snapshot,
          });
      }, value);
    };
    await inject(page);
    await expect(window.locator("[data-listening-stage=queued]")).toBeVisible();
    await expect(
      window.getByText("Synthetic lifecycle fixture—not measured audio.", {
        exact: false,
      }),
    ).toBeVisible();
    await window
      .getByRole("button", {
        name: "Cancel owned capture (not transport)",
        exact: true,
      })
      .click();
    await expect(
      window.getByText(
        "No cancellable work remains for this agent. Refresh listening passes.",
      ),
    ).toBeVisible();
    for (const stage of [
      "capturing",
      "failed",
      "completed",
      "cancelled",
    ] as const) {
      page.revision++;
      page.jobs[0] = { ...page.jobs[0]!, stage };
      await inject(page);
      await expect(
        window.locator(`[data-listening-stage=${stage}]`),
      ).toBeVisible();
    }
    await expect(
      window.getByText("Cancel capture does not stop transport.", {
        exact: false,
      }),
    ).toBeVisible();
    const inventory = await window.evaluate(
      async ({ sessionId, agentId }) =>
        globalThis.window.desktop.listening.list({ sessionId, agentId }),
      owner,
    );
    expect(inventory.jobs).toEqual([]);
    expect(
      await window.evaluate(() =>
        Object.keys(globalThis.window.desktop.listening),
      ),
    ).toEqual(["list"]);
    await expect(
      window.evaluate(
        async ({ sessionId, agentId }) =>
          globalThis.window.desktop.listening.list(
            Object.assign({ sessionId, agentId }, { sql: "SELECT *" }),
          ),
        owner,
      ),
    ).rejects.toThrow();
    await application.evaluate(({ BrowserWindow }) => {
      for (const browser of BrowserWindow.getAllWindows())
        browser.webContents.send("app:event", {
          type: "listening.reset",
          reason: "shutdown",
        });
    });
    await expect(window.locator("[data-listening-stage]")).toHaveCount(0);
    await expect(
      window.getByText(
        "Listening runtime stopped. Restart the app before retrying.",
      ),
    ).toBeVisible();
  } finally {
    await application?.close();
    if (reservation.listening)
      await new Promise<void>((resolve, reject) =>
        reservation.close((error) => (error ? reject(error) : resolve())),
      );
    await new Promise<void>((resolve, reject) =>
      bridge.close((error) => (error ? reject(error) : resolve())),
    );
    if (profile !== undefined)
      await rm(profile, { recursive: true, force: true });
  }
});

test("restores typed v1/v2 listening context and approximate quality across Electron restarts without renderer filesystem access", async () => {
  const bridge = createServer((socket) => socket.destroy());
  const reservation = createServer();
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
  let profile: string | undefined;
  try {
    await new Promise<void>((resolve) =>
      bridge.listen(0, "127.0.0.1", resolve),
    );
    const address = bridge.address();
    if (address === null || typeof address === "string")
      throw new Error("Expected owned bridge port");
    await new Promise<void>((resolve) =>
      reservation.listen(0, "127.0.0.1", resolve),
    );
    const signalAddress = reservation.address();
    if (signalAddress === null || typeof signalAddress === "string")
      throw new Error("Expected owned signal port");
    await new Promise<void>((resolve, reject) =>
      reservation.close((error) => (error ? reject(error) : resolve())),
    );
    const environment = {
      ABLETON_AGENT_TOKEN: "isolated-context-authentication-fixture",
      ABLETON_AGENT_PORT: String(address.port),
    };
    const launched = await launchIsolatedDesktop(
      environment,
      signalAddress.port,
      seedMixedListeningContext,
    );
    application = launched.application;
    profile = launched.profile;
    let firstContextId: string | undefined;
    let firstDescriptiveId: string | undefined;
    for (let cycle = 0; cycle < 2; cycle += 1) {
      if (application === undefined) {
        application = await electron.launch({
          args: [desktopPath, `--user-data-dir=${join(profile, "electron")}`],
          cwd: process.cwd(),
          env: launched.environment,
        });
      }
      const pageWindow = await application.firstWindow();
      await pageWindow
        .getByRole("button", { name: "Outputs", exact: true })
        .click();
      await expect(
        pageWindow.getByText("Stored listening context", { exact: true }),
      ).toBeVisible();
      const page = await pageWindow.evaluate(async (sessionId) => {
        const desktop = globalThis.window.desktop;
        return desktop.entityContext.list({
          sessionId,
          includeHistorical: true,
          limit: 20,
        });
      }, listeningFixtureSessionId);
      expect(page.entries).toHaveLength(2);
      const legacy = page.entries.find(
        (entry) => entry.kind === "audio-observation/v1",
      );
      const descriptive = page.entries.find(
        (entry) => entry.kind === "audio-observation/v2",
      );
      expect(legacy).toMatchObject({
        passId: listeningFixturePassId,
        listenerId: "fixture-listener",
        freshness: "unknown",
      });
      expect(legacy?.summary).toContain("Known sine persistence fixture");
      const contextId = legacy?.contextId;
      if (contextId === undefined)
        throw new Error("Missing restored context ID");
      if (cycle === 0) firstContextId = contextId;
      else expect(contextId).toBe(firstContextId);
      const detail = await pageWindow.evaluate(
        async ({ sessionId, contextId }) => {
          const desktop = globalThis.window.desktop;
          return desktop.entityContext.get({
            sessionId,
            contextId,
            includeHistorical: true,
          });
        },
        { sessionId: listeningFixtureSessionId, contextId },
      );
      expect(detail.observation.summaries.peak).toEqual([0.5, 0.5]);
      expect(detail.observation.summaries.centroidHz).toBe(440);
      expect(detail.observation.limitations).toContain(
        "Synthetic persistence fixture, not measured listener output",
      );
      const descriptiveId = descriptive?.contextId;
      if (descriptiveId === undefined)
        throw new Error("Missing descriptive context");
      if (cycle === 0) firstDescriptiveId = descriptiveId;
      else expect(descriptiveId).toBe(firstDescriptiveId);
      const approximate = await pageWindow.evaluate(
        async ({ sessionId, contextId }) =>
          globalThis.window.desktop.entityContext.get({
            sessionId,
            contextId,
            includeHistorical: true,
          }),
        { sessionId: listeningFixtureSessionId, contextId: descriptiveId },
      );
      expect(approximate.entry.passId).toBe(descriptiveFixturePassId);
      expect(approximate.observation).toMatchObject({
        schema: "audio-observation/v2",
        sampleRate: 44_100,
        startBeat: 5.25,
        endBeat: 9.5,
        alignment: {
          alignment: "approximate",
          intendedUse: "descriptive-only",
          policy: { mode: "descriptive", maxClockDisagreementSamples: 64 },
          observedClockDisagreementSamples: 64,
          observedBeatDisagreementSamples: 32,
          estimatedAbsoluteErrorSamples: null,
          verifiedAbsoluteErrorBoundSamples: null,
        },
      });
      expect(descriptive?.summary).toContain("1.451");
      expect(descriptive?.summary).toContain("absolute");
      await expect(
        pageWindow.evaluate(async () => {
          const desktop = globalThis.window.desktop;
          return desktop.entityContext.list({
            sessionId: "foreign-session",
            includeHistorical: true,
            limit: 20,
          });
        }),
      ).rejects.toThrow();
      expect(
        await pageWindow.evaluate(() => {
          const desktop = globalThis.window.desktop;
          return Object.keys(desktop.entityContext);
        }),
      ).toEqual(["list", "get"]);
      await application.close();
      application = undefined;
    }
  } finally {
    await application?.close();
    if (reservation.listening) {
      await new Promise<void>((resolve, reject) =>
        reservation.close((error) => (error ? reject(error) : resolve())),
      );
    }
    await new Promise<void>((resolve, reject) =>
      bridge.close((error) => (error ? reject(error) : resolve())),
    );
    if (profile !== undefined)
      await rm(profile, { recursive: true, force: true });
  }
});

test("publishes producer discovery and credential references only inside the isolated profile", async () => {
  const bridge = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => bridge.listen(0, "127.0.0.1", resolve));
  const address = bridge.address();
  if (address === null || typeof address === "string")
    throw new Error("Expected owned bridge port");
  const reservation = createServer();
  await new Promise<void>((resolve) =>
    reservation.listen(0, "127.0.0.1", resolve),
  );
  const signalAddress = reservation.address();
  if (signalAddress === null || typeof signalAddress === "string")
    throw new Error("Expected owned signal port");
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  );
  const token = "isolated-electron-producer-authentication-fixture";
  const { application, profile } = await launchIsolatedDesktop(
    {
      ABLETON_AGENT_TOKEN: token,
      ABLETON_AGENT_PORT: String(address.port),
    },
    signalAddress.port,
  );
  const storage = resolveLiveAgentStorage({
    environment: {
      LIVE_AGENT_HOME: join(profile, "live-agent"),
      LIVE_AGENT_PROFILE: "default",
    },
  });
  try {
    const window = await application.firstWindow();
    await expect(window).toHaveTitle("Ableton Agent");
    await expect
      .poll(async () => {
        try {
          return await readFile(storage.signalIngressSecretPath, "utf8");
        } catch (error) {
          if (
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          )
            return null;
          throw error;
        }
      })
      .toBe(`${token}\n`);
    await expect
      .poll(async () => {
        try {
          return await readFile(storage.signalIngressDescriptorPath, "utf8");
        } catch (error) {
          if (
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          )
            return null;
          throw error;
        }
      })
      .not.toBeNull();
    const descriptor: unknown = JSON.parse(
      await readFile(storage.signalIngressDescriptorPath, "utf8"),
    );
    expect(descriptor).toMatchObject({
      secretPath: storage.signalIngressSecretPath,
      port: signalAddress.port,
      listenerVersions: [1, 2],
    });
    expect(JSON.stringify(descriptor)).not.toContain(token);
    await expect(window.locator("body")).not.toContainText(token);
  } finally {
    await application.close();
    await new Promise<void>((resolve, reject) =>
      bridge.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(profile, { recursive: true, force: true });
  }
});

test("launches the built desktop contract securely", async () => {
  const { application, profile, environment } = await launchIsolatedDesktop();
  try {
    const window = await application.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    await expect
      .poll(async () => {
        const preferences = await window.evaluate(() =>
          globalThis.window.desktop.preferences.get(),
        );
        return preferences.abletonPort;
      })
      .toBe(Number(environment.ABLETON_AGENT_PORT));
    await expect(window).toHaveTitle("Ableton Agent");
    await expect(
      window.getByRole("navigation", { name: "Application views" }),
    ).toBeVisible();
    await expect(
      window.getByRole("button", { name: "Workspace" }),
    ).toBeVisible();
    await window.getByRole("button", { name: "Hide project sidebar" }).click();
    await expect(
      window.getByRole("complementary", { name: "Project outline" }),
    ).toHaveCount(0);
    await window.getByRole("button", { name: "Show project sidebar" }).click();
    await expect(
      window.getByRole("complementary", { name: "Project outline" }),
    ).toBeVisible();
    await window
      .getByRole("button", { name: "Hide inspector sidebar" })
      .click();
    await expect(
      window.getByRole("complementary", { name: "Inspector workspace" }),
    ).toBeHidden();
    await window
      .getByRole("button", { name: "Show inspector sidebar" })
      .click();
    await expect(
      window.getByRole("complementary", { name: "Inspector workspace" }),
    ).toBeVisible();
    await window
      .getByRole("button", { name: "Hide application toolbar" })
      .click();
    await expect(
      window.getByRole("navigation", { name: "Application views" }),
    ).toHaveCount(0);
    await window
      .getByRole("button", { name: "Show application toolbar" })
      .click();
    await expect(
      window.getByRole("navigation", { name: "Application views" }),
    ).toBeVisible();
    await expect(
      window.getByRole("button", { name: "Settings" }),
    ).toBeVisible();
    const composer = window.getByRole("textbox", {
      name: "Message the Ableton agent",
    });
    await composer.fill("Keep this draft");
    await window.getByRole("button", { name: "Events" }).click();
    await expect(window.getByRole("heading", { name: "Events" })).toBeVisible();
    await expect(composer).toHaveCount(0);

    await window.getByRole("button", { name: "Agents" }).click();
    await expect(
      window.getByRole("heading", { name: "Agents", exact: true }),
    ).toBeVisible();
    await expect(composer).toHaveCount(0);
    await window.getByRole("tab", { name: "Connections" }).first().click();
    await expect(
      window.getByRole("group", { name: "Listening Events" }).first(),
    ).toBeVisible();
    await expect(
      window.getByText(
        "No Live events are available in this production session.",
      ),
    ).toBeVisible();

    await window.getByRole("button", { name: "Skills" }).click();
    await expect(
      window.getByRole("heading", { name: "Skills", exact: true }),
    ).toBeVisible();
    await expect(composer).toHaveCount(0);
    await window.getByText("mix-review", { exact: true }).first().click();
    await expect(
      window.getByRole("textbox", { name: "Markdown instructions" }),
    ).toBeVisible();
    await window.getByRole("tab", { name: "Skill overview" }).click();
    await expect(window.getByRole("textbox", { name: "Name" })).toBeDisabled();
    await expect(
      window.getByRole("textbox", { name: "Description" }),
    ).toBeDisabled();

    await window.getByRole("button", { name: "Profiles" }).click();
    await expect(
      window.getByRole("heading", { name: "Profiles", exact: true }),
    ).toBeVisible();
    await expect(composer).toHaveCount(0);
    await expect(
      window.getByRole("heading", { name: "System", exact: true }),
    ).toBeVisible();
    await window
      .getByRole("button", { name: "Expand unassigned Live Sets" })
      .click();
    await window
      .getByRole("button", { name: "Expand No connected Live Set Live Set" })
      .click();
    await expect(
      window.getByText("In memory · saves on first customization"),
    ).toBeVisible();
    await expect(
      window.getByText(/Profile switching is disabled/u),
    ).toBeVisible();
    await expect(
      window.getByLabel("Active Profile", { exact: true }),
    ).toBeDisabled();
    await window.getByRole("button", { name: "Create profile" }).click();
    await window.getByLabel("New profile").fill("ambient");
    await window.getByRole("button", { name: "Create", exact: true }).click();
    const ambientProfile = window.getByRole("button", {
      name: "ambient",
      exact: true,
    });
    await expect(ambientProfile).toBeVisible();
    await ambientProfile.click({ button: "right" });
    await expect(
      window.getByRole("menuitem", { name: "Rename" }),
    ).toBeVisible();
    await expect(window.getByText("Selected artifact")).toHaveCount(0);

    const isolation = await window.evaluate(() => ({
      desktop: typeof globalThis.window.desktop,
      require: typeof (window as unknown as { require?: unknown }).require,
      process: typeof (window as unknown as { process?: unknown }).process,
    }));
    expect(isolation).toEqual({
      desktop: "object",
      require: "undefined",
      process: "undefined",
    });

    const shortcutModifier = process.platform === "darwin" ? "Meta" : "Control";
    await window.keyboard.press(`${shortcutModifier}+,`);
    await expect(
      window.getByRole("heading", { name: "Settings" }),
    ).toBeVisible();
    const activeWorkTimeout = window.getByRole("spinbutton", {
      name: "Active-work timeout (minutes)",
    });
    await expect(activeWorkTimeout).toBeVisible();
    await expect(activeWorkTimeout).toHaveAttribute("min", "1");
    await expect(activeWorkTimeout).toHaveAttribute("max", "120");
    const reasoningVisibility = window.getByRole("combobox", {
      name: "Agent reasoning visibility",
    });
    await expect(reasoningVisibility).toBeVisible();
    await expect(reasoningVisibility).toHaveValue("concise");
    await reasoningVisibility.selectOption("detailed");
    await expect(reasoningVisibility).toHaveValue("detailed");
    await expect(composer).toHaveCount(0);
    await window.keyboard.press(`${shortcutModifier}+k`);
    await expect(
      window.getByRole("region", {
        name: "Conversation and operation timeline",
      }),
    ).toBeVisible();
    await expect(composer).toBeEnabled();
    await expect(composer).toBeFocused();
    await expect(composer).toHaveValue("Keep this draft");
  } finally {
    await application.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test("exposes essential landmarks and labels", async () => {
  const { application, profile } = await launchIsolatedDesktop();
  try {
    const window = await application.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    await expect(window.locator("main#main-content")).toBeVisible();
    await expect(window.locator("header")).toBeVisible();
    await expect(window.locator("nav[aria-label]")).toHaveCount(1);
    const unnamedButtons = await window
      .locator("button")
      .evaluateAll(
        (buttons) =>
          buttons.filter(
            (button) =>
              !button.getAttribute("aria-label")?.trim() &&
              !button.textContent?.trim(),
          ).length,
      );
    expect(unnamedButtons).toBe(0);
  } finally {
    await application.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test("renders useful successful and blocked tool disclosures", async () => {
  const { application, profile } = await launchAutomationDesktop();
  try {
    const window = await application.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    const rendererUrl = window.url();
    await expect
      .poll(
        () =>
          window.evaluate(async () => {
            const desktop = (
              window as unknown as {
                desktop: ElectronTestDesktopApi;
              }
            ).desktop;
            try {
              const agents = await desktop.agents.listActive();
              return agents[0]?.id ?? "";
            } catch {
              return "";
            }
          }),
        { timeout: 15_000 },
      )
      .not.toBe("");
    const agentInstanceId = await window.evaluate(async () => {
      const desktop = (
        window as unknown as {
          desktop: ElectronTestDesktopApi;
        }
      ).desktop;
      const agents = await desktop.agents.listActive();
      const selected = agents[0];
      if (selected === undefined)
        throw new Error("Expected an active test agent");
      return selected.id;
    });

    const publish = async (events: readonly unknown[]) => {
      const delivered = await application.evaluate(
        ({ BrowserWindow }, input) => {
          const desktopWindow = BrowserWindow.getAllWindows().find(
            (candidate) => candidate.webContents.getURL() === input.url,
          );
          for (const event of input.events)
            desktopWindow?.webContents.send("app:event", event);
          return desktopWindow !== undefined;
        },
        { events, url: rendererUrl },
      );
      expect(delivered).toBe(true);
    };

    const disclosureEvents = [
      {
        type: "operation.changed",
        agentInstanceId,
        operation: {
          id: "inspect-parameters",
          label: "Inspect device parameters · sine-kick › Operator",
          toolName: "ableton_devices",
          action: "inspect-parameters",
          status: "running",
          request: {
            details: [
              { label: "Expected Name", value: "sine-kick" },
              { label: "Expected Device Name", value: "Operator" },
              { label: "Limit", value: "128" },
            ],
          },
          warnings: [],
          changed: [],
          unchanged: [],
          retryable: false,
          undoable: false,
          timestamp: 1,
        },
      },
      {
        type: "operation.changed",
        agentInstanceId,
        operation: {
          id: "inspect-parameters",
          label: "Inspect device parameters · sine-kick › Operator",
          status: "completed",
          outcome: {
            kind: "observed",
            details: [
              { label: "Total Parameters", value: "195" },
              { label: "Parameters", value: "128 items" },
            ],
          },
          durationMs: 420,
          warnings: [],
          changed: [],
          unchanged: [],
          retryable: false,
          undoable: false,
          timestamp: 2,
        },
      },
      {
        type: "operation.changed",
        agentInstanceId,
        operation: {
          id: "blocked-shell",
          label: "Run shell command",
          toolName: "bash",
          status: "failed",
          request: {
            details: [
              {
                label: "Command",
                value: "tail -n +32 <spill-file>",
                format: "code",
              },
            ],
          },
          failure: {
            source: "application_policy",
            code: "shell_policy_blocked",
            message: "Blocked by shell safety policy",
            recovery: "Use bounded tail -n N or a jq slice.",
            details: [
              {
                label: "Shell Policy",
                value: '{ "stage": "unbounded_output" }',
                format: "code",
              },
            ],
          },
          warnings: [],
          changed: [],
          unchanged: [],
          retryable: false,
          undoable: false,
          timestamp: 3,
        },
      },
    ];

    await publish(disclosureEvents);
    const successful = window
      .locator("details.operation")
      .filter({ hasText: "Inspect device parameters" });
    await expect(successful.locator("summary")).toContainText("420 ms");
    await successful.locator("summary").click();
    await expect(successful).toContainText("Requested");
    await expect(successful).toContainText("Expected Device Name");
    await expect(successful).toContainText("Observed");
    await expect(successful).toContainText("195");
    await expect(successful).not.toContainText("Changed:");

    const blocked = window
      .locator("details.operation")
      .filter({ hasText: "Run shell command" });
    await blocked.locator("summary").click();
    await expect(blocked).toContainText("Blocked by application policy");
    await expect(blocked).toContainText("shell_policy_blocked");
    await expect(blocked).toContainText("How to correct it");
    await expect(blocked).toContainText("tail -n +32 <spill-file>");
    await expect(blocked).not.toContainText("The user rejected this tool call");
  } finally {
    await application.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test("supports a terminal-sized chat-only window", async () => {
  const { application, profile } = await launchIsolatedDesktop();

  try {
    const window = await application.firstWindow();
    await window.waitForLoadState("domcontentloaded");

    await window.getByRole("button", { name: "Hide project sidebar" }).click();
    await window
      .getByRole("button", { name: "Hide inspector sidebar" })
      .click();
    await window
      .getByRole("button", { name: "Hide application toolbar" })
      .click();

    const size = await application.evaluate(({ BrowserWindow }) => {
      const desktopWindow = BrowserWindow.getAllWindows()[0];
      if (desktopWindow === undefined)
        throw new Error("Desktop window missing");
      desktopWindow.setSize(320, 360);
      return desktopWindow.getSize();
    });

    expect(size).toEqual([320, 360]);
    await expect(
      window.getByRole("region", {
        name: "Conversation and operation timeline",
      }),
    ).toBeVisible();
    const composer = window.getByRole("textbox", {
      name: "Message the Ableton agent",
    });
    await expect(composer).toBeVisible();
    await composer.fill("Compact chat");
    await expect(composer).toHaveValue("Compact chat");
    await expect(
      window.getByRole("button", { name: "Show application toolbar" }),
    ).toBeVisible();
    await expect(
      window.getByRole("button", { name: "Show project sidebar" }),
    ).toBeVisible();
    await expect(
      window.getByRole("button", { name: "Show inspector sidebar" }),
    ).toBeVisible();
  } finally {
    await application.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test("accepts an MCP-style user message in the visible desktop session", async () => {
  const profilePath = await mkdtemp(
    join(process.cwd(), "ableton-agent-electron-automation-"),
  );
  const descriptorPath = join(profilePath, "automation-endpoint.json");
  const application = await electron.launch({
    args: [
      desktopPath,
      "--automation",
      "--automation-profile",
      profilePath,
      "--automation-agent",
      "default",
      "--automation-yolo",
    ],
    cwd: process.cwd(),
    env: await isolatedTestEnvironment(profilePath, {}, undefined, true),
  });
  try {
    const window = await application.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    await expect
      .poll(
        async () =>
          sendAutomationMessage({
            descriptorPath,
            message: "Verify this message is visible in the desktop app.",
          })
            .then(() => "accepted")
            .catch(() => "waiting"),
        { timeout: 15_000 },
      )
      .toBe("accepted");
    await expect(
      window.getByText("Verify this message is visible in the desktop app.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      window.getByText("YOLO", { exact: true }).first(),
    ).toBeVisible();
  } finally {
    await application.close();
    await rm(profilePath, { recursive: true, force: true });
  }
});

test("renders plan.md in the Inspector and routes composer approval through IPC", async () => {
  const { application, profile } = await launchIsolatedDesktop();
  try {
    const window = await application.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    await expect
      .poll(
        () =>
          window.evaluate(async () => {
            const desktop = (
              window as unknown as {
                desktop: {
                  lifecycle: { get: () => Promise<string> };
                };
              }
            ).desktop;
            return await desktop.lifecycle.get();
          }),
        { timeout: 30_000 },
      )
      .toMatch(/ready|degraded/u);
    const agentInstanceId = await window.evaluate(async () => {
      const desktop = (
        window as unknown as {
          desktop: {
            agent: {
              getSessions: () => Promise<
                Array<{ selectedAgentInstanceId?: string }>
              >;
              createSession: () => Promise<string>;
            };
          };
        }
      ).desktop;
      let sessions = await desktop.agent.getSessions();
      if (!sessions.some((session) => session.selectedAgentInstanceId)) {
        await desktop.agent.createSession();
        sessions = await desktop.agent.getSessions();
      }
      const selected = sessions.find(
        (session) => session.selectedAgentInstanceId !== undefined,
      )?.selectedAgentInstanceId;
      if (selected === undefined) throw new Error("Selected agent missing");
      return selected;
    });
    await expect(window.getByLabel("Active Agent")).toHaveValue(
      agentInstanceId,
    );
    const composer = window.getByRole("textbox", {
      name: "Message the Ableton agent",
    });
    await composer.fill("Preserve this ordinary draft");
    await window
      .getByRole("button", { name: "Hide inspector sidebar" })
      .click();
    await expect(
      window.getByRole("complementary", { name: "Inspector workspace" }),
    ).toBeHidden();

    await application.evaluate(
      ({ BrowserWindow }, selectedAgentInstanceId: string) => {
        const desktopWindow = BrowserWindow.getAllWindows()[0];
        if (desktopWindow === undefined)
          throw new Error("Desktop window missing");
        desktopWindow.webContents.send("app:event", {
          type: "agent.elicitation_requested",
          agentInstanceId: selectedAgentInstanceId,
          request: {
            requestId: "electron-question",
            message: "Choose the arrangement density.",
            properties: {
              density: {
                type: "string",
                title: "Density",
                enum: ["Sparse", "Dense"],
                allowFreeform: true,
                minLength: 1,
                maxLength: 8_192,
              },
            },
            required: ["density"],
          },
        });
      },
      agentInstanceId,
    );
    await expect(window.getByRole("radio", { name: "Sparse" })).toBeVisible();
    await expect(window.getByRole("radio", { name: "Dense" })).toBeVisible();
    await expect(
      window.getByRole("textbox", { name: "Custom answer for Density" }),
    ).toBeVisible();
    const questionDeck = window.locator(".elicitation-deck");
    const questionBefore = await questionDeck.boundingBox();
    const questionResize = window.getByRole("separator", {
      name: "Resize question panel",
    });
    const questionResizeBox = await questionResize.boundingBox();
    if (questionBefore === null || questionResizeBox === null) {
      throw new Error("Question panel geometry is unavailable");
    }
    await window.mouse.move(
      questionResizeBox.x + questionResizeBox.width / 2,
      questionResizeBox.y + questionResizeBox.height / 2,
    );
    await window.mouse.down();
    await window.mouse.move(
      questionResizeBox.x + questionResizeBox.width / 2,
      questionResizeBox.y - 45,
    );
    await window.mouse.up();
    await expect
      .poll(async () => (await questionDeck.boundingBox())?.height)
      .toBeGreaterThan(questionBefore.height + 25);
    await application.evaluate(
      ({ BrowserWindow }, selectedAgentInstanceId: string) => {
        const desktopWindow = BrowserWindow.getAllWindows()[0];
        if (desktopWindow === undefined)
          throw new Error("Desktop window missing");
        desktopWindow.webContents.send("app:event", {
          type: "agent.elicitation_completed",
          requestId: "electron-question",
          action: "cancel",
          agentInstanceId: selectedAgentInstanceId,
        });
      },
      agentInstanceId,
    );
    await expect(composer).toHaveValue("Preserve this ordinary draft");

    const revision = "a".repeat(64);
    const updatedAt = new Date().toISOString();
    await application.evaluate(
      (
        { BrowserWindow },
        payload: {
          agentInstanceId: string;
          revision: string;
          updatedAt: string;
        },
      ) => {
        const desktopWindow = BrowserWindow.getAllWindows()[0];
        if (desktopWindow === undefined)
          throw new Error("Desktop window missing");
        desktopWindow.webContents.send("app:event", {
          type: "agent.plan_artifact_changed",
          agentInstanceId: payload.agentInstanceId,
          artifact: {
            exists: true,
            productionSessionId: "electron-production-session",
            content:
              "# Electron plan\n\n- Inspect the Arrangement\n- Place existing clips\n\n## Implementation\n\nPreserve the canonical plan artifact.",
            revision: payload.revision,
            updatedAt: payload.updatedAt,
            bytes: 139,
          },
        });
        desktopWindow.webContents.send("app:event", {
          type: "agent.plan_approval_requested",
          agentInstanceId: payload.agentInstanceId,
          request: {
            requestId: "electron-plan-request",
            summary: "Electron approval plan",
            planContent:
              "# Electron plan\n\n- Inspect the Arrangement\n- Place existing clips\n\n## Implementation\n\nPreserve the canonical plan artifact.",
            planRevision: payload.revision,
            planUpdatedAt: payload.updatedAt,
            recommendedAction: "interactive",
            actions: ["interactive", "exit_only"],
          },
        });
        desktopWindow.webContents.send("app:event", {
          type: "approval.requested",
          agentInstanceId: payload.agentInstanceId,
          approval: {
            id: "electron-tool-approval",
            title: "Create arrangement clips",
            risk: "medium",
            summary: "Create the clips described by the plan.",
            changes: ["Create two clips"],
            destructive: false,
          },
        });
      },
      {
        agentInstanceId,
        revision,
        updatedAt,
      },
    );

    await expect(
      window.getByRole("complementary", { name: "Inspector workspace" }),
    ).toBeVisible();
    await expect(window.getByRole("tab", { name: "Plan" })).toBeVisible();
    await expect(window.getByRole("tab", { name: "Approval" })).toBeVisible();
    await expect(window.getByText("Electron approval plan")).toHaveCount(0);
    await window.getByRole("tab", { name: "Plan" }).click();
    await expect(window.locator(".plan-approval-content li")).toHaveCount(2);
    await expect(
      window.getByRole("heading", { name: "Implementation" }),
    ).toBeVisible();
    await expect(
      window.getByRole("region", { name: "Session plan" }),
    ).toBeVisible();
    await expect(
      window.getByRole("region", { name: "Plan approval" }),
    ).toBeVisible();
    await window
      .getByRole("tab", { name: "Plan" })
      .dragTo(window.locator(".inspector-split-drop-after").first());
    await expect(window.locator(".inspector-pane")).toHaveCount(2);
    const paneDivider = window.locator(".inspector-pane-divider");
    await expect(paneDivider).toBeVisible();
    const paneContents = window.locator(".inspector-pane-content");
    await expect(paneContents).toHaveCount(2);
    await expect
      .poll(() =>
        paneContents.evaluateAll((elements) =>
          elements.every(
            (element) => getComputedStyle(element).overflowY === "auto",
          ),
        ),
      )
      .toBe(true);
    const firstPaneBefore = await window
      .locator(".inspector-pane")
      .first()
      .boundingBox();
    const dividerBox = await paneDivider.boundingBox();
    if (firstPaneBefore === null || dividerBox === null) {
      throw new Error("Inspector split geometry is unavailable");
    }
    await window.mouse.move(
      dividerBox.x + dividerBox.width / 2,
      dividerBox.y + dividerBox.height / 2,
    );
    await window.mouse.down();
    await window.mouse.move(
      dividerBox.x + dividerBox.width / 2,
      dividerBox.y + 45,
    );
    await window.mouse.up();
    await expect
      .poll(
        async () =>
          (await window.locator(".inspector-pane").first().boundingBox())
            ?.height,
      )
      .toBeGreaterThan(firstPaneBefore.height + 25);
    await window.getByRole("button", { name: "Approve and continue" }).click();
    await expect(
      window.getByText("This plan request is no longer pending."),
    ).toBeVisible();
    await expect(window.getByText("Electron approval plan")).toHaveCount(0);
    await application.evaluate(
      ({ BrowserWindow }, selectedAgentInstanceId: string) => {
        const desktopWindow = BrowserWindow.getAllWindows()[0];
        if (desktopWindow === undefined)
          throw new Error("Desktop window missing");
        desktopWindow.webContents.send("app:event", {
          type: "agent.plan_approval_completed",
          requestId: "electron-plan-request",
          approved: false,
          agentInstanceId: selectedAgentInstanceId,
        });
      },
      agentInstanceId,
    );
    await expect(composer).toHaveValue("Preserve this ordinary draft");
    await window.getByRole("button", { name: "Edit Markdown" }).click();
    const planEditor = window.getByRole("textbox", { name: "Plan Markdown" });
    await expect(planEditor).toHaveValue(/# Electron plan/u);
    await window.getByRole("button", { name: "Cancel" }).click();
    await expect(composer).toHaveValue("Preserve this ordinary draft");
  } finally {
    await application.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test("resizes both workspace sidebars and restores their session widths", async () => {
  const { application, profile } = await launchIsolatedDesktop();
  try {
    const window = await application.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    await expect
      .poll(
        () =>
          window.evaluate(async () => {
            const desktop = (
              window as unknown as {
                desktop: {
                  lifecycle: { get: () => Promise<string> };
                };
              }
            ).desktop;
            return await desktop.lifecycle.get();
          }),
        { timeout: 30_000 },
      )
      .toMatch(/ready|degraded/u);
    await application.evaluate(({ BrowserWindow }) => {
      const desktopWindow = BrowserWindow.getAllWindows()[0];
      if (desktopWindow === undefined) {
        throw new Error("Desktop window missing");
      }
      desktopWindow.setSize(1440, 780);
    });
    const workspace = window.locator(".workspace");
    await expect(workspace).toBeVisible({ timeout: 30_000 });
    const project = window.getByRole("complementary", {
      name: "Project outline",
    });
    const inspector = window.getByRole("complementary", {
      name: "Inspector workspace",
    });
    const leftHandle = window.locator(".sidebar-resize-handle-left");
    const rightHandle = window.locator(".sidebar-resize-handle-right");
    await expect(project).toBeVisible();
    await expect(inspector).toBeVisible();
    await expect(leftHandle).toBeVisible();
    await expect(rightHandle).toBeVisible();
    const projectBefore = await project.boundingBox();
    const inspectorBefore = await inspector.boundingBox();
    const leftHandleBox = await leftHandle.boundingBox();
    if (
      projectBefore === null ||
      inspectorBefore === null ||
      leftHandleBox === null
    ) {
      throw new Error("Workspace resize geometry is unavailable");
    }

    await window.mouse.move(
      leftHandleBox.x + leftHandleBox.width / 2,
      leftHandleBox.y + 40,
    );
    await window.mouse.down();
    await window.mouse.move(leftHandleBox.x + 70, leftHandleBox.y + 40);
    await window.mouse.up();
    await expect
      .poll(async () => (await project.boundingBox())?.width)
      .toBeGreaterThan(projectBefore.width + 40);
    const expandedProject = await project.boundingBox();
    const rightHandleBox = await rightHandle.boundingBox();
    if (expandedProject === null || rightHandleBox === null) {
      throw new Error("Updated workspace resize geometry is unavailable");
    }

    await window.mouse.move(
      rightHandleBox.x + rightHandleBox.width / 2,
      rightHandleBox.y + 40,
    );
    await window.mouse.down();
    await window.mouse.move(rightHandleBox.x - 70, rightHandleBox.y + 40);
    await window.mouse.up();
    await expect
      .poll(async () => (await inspector.boundingBox())?.width)
      .toBeGreaterThan(inspectorBefore.width + 40);
    const expandedHandleBox = await rightHandle.boundingBox();
    if (expandedHandleBox === null) {
      throw new Error("Expanded Inspector resize handle is unavailable");
    }
    await window.mouse.move(
      expandedHandleBox.x + expandedHandleBox.width / 2,
      expandedHandleBox.y + 40,
    );
    await window.mouse.down();
    await window.mouse.move(0, expandedHandleBox.y + 40);
    await window.mouse.up();
    await expect
      .poll(async () => (await inspector.boundingBox())?.width)
      .toBeGreaterThan(560);
    await expect
      .poll(
        async () =>
          (await window.locator("section.conversation").boundingBox())?.width,
      )
      .toBeGreaterThanOrEqual(319);
    const expandedInspector = await inspector.boundingBox();
    if (expandedInspector === null) {
      throw new Error("Expanded Inspector geometry is unavailable");
    }

    await window.getByRole("button", { name: "Hide project sidebar" }).click();
    await expect(project).toHaveCount(0);
    await window.getByRole("button", { name: "Show project sidebar" }).click();
    await expect
      .poll(async () => (await project.boundingBox())?.width)
      .toBeCloseTo(expandedProject.width, 0);
    await expect
      .poll(async () => (await inspector.boundingBox())?.width)
      .toBeCloseTo(expandedInspector.width, 0);
  } finally {
    await application.close();
    await rm(profile, { recursive: true, force: true });
  }
});
