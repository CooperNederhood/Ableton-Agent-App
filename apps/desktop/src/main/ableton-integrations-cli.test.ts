import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { resolveLiveAgentStorage } from "@ableton-agent/storage";
import { LocalObservabilityJournal } from "@ableton-agent/observability";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  inspectAbletonIntegrations,
  installAbletonIntegrations,
} from "./ableton-integrations-install.js";

const installer = vi.hoisted(() => ({
  installAbletonIntegrations: vi.fn<typeof installAbletonIntegrations>(),
  inspectAbletonIntegrations: vi.fn<typeof inspectAbletonIntegrations>(),
}));
vi.mock("./ableton-integrations-install.js", () => installer);

import {
  integrationFailureResult,
  integrationSourcePaths,
  parseIntegrationArguments,
  resolveIntegrationLibrary,
  resolveIntegrationStorage,
  runIntegrationCommand,
} from "./ableton-integrations-cli.js";

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ableton-integrations-cli-"));
  roots.push(root);
  const userLibrary = join(root, "Library");
  await mkdir(userLibrary);
  const environment = {
    LIVE_AGENT_HOME: join(root, "live-agent"),
    ABLETON_USER_LIBRARY: userLibrary,
  };
  return { root, userLibrary, environment };
}

afterEach(async () => {
  vi.resetAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("integration CLI", () => {
  it("reports bounded redacted causes and partial outcomes instead of a generic failure alone", () => {
    const cause = new Error("Quit Ableton Live before updating integrations");
    const credential = `ghp_${"a".repeat(36)}`;
    const failure = new AggregateError(
      [cause, new Error(`Request failed: ${credential}`)],
      "Integration installation failed",
      { cause },
    );
    const result = integrationFailureResult(
      Object.assign(failure, {
        components: [{ component: "remote-script", status: "installed" }],
        failures: [failure],
      }),
      false,
    );
    expect(result).toMatchObject({
      status: "failed",
      message: "Integration installation failed",
      components: [{ component: "remote-script", status: "installed" }],
    });
    expect(JSON.stringify(result)).toContain("Quit Ableton Live");
    expect(JSON.stringify(result)).not.toContain(credential);
    const bounded = integrationFailureResult(
      new AggregateError(
        Array.from(
          { length: 100 },
          (_, index) => new Error(`Failure ${index}`),
        ),
        "Cancelled",
      ),
      true,
    );
    expect(bounded).toMatchObject({ status: "cancelled" });
    expect(bounded.details).toHaveLength(7);
  });

  it("keeps full delivery explicit and rejects invalid/repeated options", () => {
    expect(parseIntegrationArguments([])).toMatchObject({
      command: "detect",
      confirmed: false,
      dryRun: false,
    });
    expect(
      parseIntegrationArguments([
        "update",
        "--confirm",
        "--components",
        "machine-listening,midi-capture",
      ]),
    ).toMatchObject({
      command: "update",
      confirmed: true,
      components: ["machine-listening", "midi-capture"],
    });
    for (const args of [
      ["install", "--components", "midi-capture,midi-capture"],
      ["install", "--components", "unknown"],
      ["install", "--profile"],
      ["install", "--confirm", "--confirm"],
      ["install", "--trace-id", "../invalid"],
      ["install", "--unknown=secret"],
    ])
      expect(() => parseIntegrationArguments(args)).toThrow();
  });

  it("resolves packaged resources instead of requiring repository sources", () => {
    expect(
      integrationSourcePaths({
        runtimeResourcesPath:
          "/Applications/Ableton Agent.app/Contents/Resources",
      }),
    ).toEqual({
      payloadDirectory:
        "/Applications/Ableton Agent.app/Contents/Resources/ableton-integrations",
      remoteScriptSourcePath:
        "/Applications/Ableton Agent.app/Contents/Resources/remote-script/AbletonAgent",
    });
  });

  it("reads the selected packaged profile without creating registry data", async () => {
    const { root, environment } = await fixture();
    expect((await resolveIntegrationStorage({ environment })).profile).toBe(
      "default",
    );
    await expect(access(join(root, "live-agent"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const layout = resolveLiveAgentStorage({ environment });
    await mkdir(dirname(layout.profilesRegistryPath), { recursive: true });
    const timestamp = "2026-10-24T20:00:00Z";
    await writeFile(
      layout.profilesRegistryPath,
      JSON.stringify({
        version: 1,
        revision: 1,
        selectedProfile: "studio",
        profiles: ["default", "studio"].map((name) => ({
          name,
          displayName: name,
          createdAt: timestamp,
          updatedAt: timestamp,
        })),
      }),
    );
    expect((await resolveIntegrationStorage({ environment })).profile).toBe(
      "studio",
    );
    expect(
      (await resolveIntegrationStorage({ environment, profile: "automation" }))
        .profile,
    ).toBe("automation");
    expect(
      (
        await resolveIntegrationStorage({
          environment: { ...environment, LIVE_AGENT_PROFILE: "isolated" },
        })
      ).profile,
    ).toBe("isolated");
  });

  it("uses one custom Library, rejects a missing override, and never falls back", async () => {
    const { root, userLibrary, environment } = await fixture();
    expect(
      await resolveIntegrationLibrary({
        environment,
        homeDirectory: root,
      }),
    ).toBe(userLibrary);
    await expect(
      resolveIntegrationLibrary({
        environment: { ABLETON_USER_LIBRARY: join(root, "missing") },
        homeDirectory: root,
      }),
    ).rejects.toThrow("does not exist");
  });

  it("requires confirmation before creating profile/journal state", async () => {
    const { root, environment } = await fixture();
    await expect(
      runIntegrationCommand(["install"], { environment }),
    ).rejects.toThrow("--confirm");
    expect(installer.installAbletonIntegrations).not.toHaveBeenCalled();
    await expect(access(join(root, "live-agent"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps detect/dry-run read-only and forwards isolated component selection", async () => {
    const { root, environment } = await fixture();
    installer.inspectAbletonIntegrations.mockResolvedValue({ components: [] });
    installer.installAbletonIntegrations.mockResolvedValue({ components: [] });
    await runIntegrationCommand(["detect"], { environment });
    await runIntegrationCommand(
      [
        "install",
        "--dry-run",
        "--components",
        "midi-capture",
        "--payload",
        join(root, "payload"),
      ],
      { environment },
    );
    expect(installer.installAbletonIntegrations).toHaveBeenCalledWith(
      expect.objectContaining({
        userLibraryPath: environment.ABLETON_USER_LIBRARY,
        dryRun: true,
        components: ["midi-capture"],
        payloadDirectory: join(root, "payload"),
      }),
    );
    expect(
      installer.installAbletonIntegrations.mock.calls[0]?.[0].storage.profile,
    ).toBe("default");
    await expect(access(join(root, "live-agent"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("persists traced, redacted installer events and closes its journal on success and failure", async () => {
    const { environment } = await fixture();
    for (const failure of [false, true]) {
      installer.installAbletonIntegrations.mockImplementation(
        async ({ onEvent }) => {
          onEvent?.({
            name: "ableton.integrations.install",
            stage: "started",
            durationMs: 0,
          });
          onEvent?.({
            name: "ableton.integrations.install",
            stage: failure ? "failed" : "completed",
            durationMs: 5,
            attributes: { detail: "Bearer private-install-token" },
          });
          if (failure) throw new Error("Component publication failed");
          return { components: [] };
        },
      );
      const pending = runIntegrationCommand(["install", "--confirm"], {
        environment,
      });
      if (failure)
        await expect(pending).rejects.toThrow("Component publication failed");
      else await expect(pending).resolves.toMatchObject({ profile: "default" });
    }
    const storage = resolveLiveAgentStorage({ environment });
    const journal = await LocalObservabilityJournal.open({
      path: storage.eventJournalPath,
    });
    try {
      const page = await journal.read({ order: "asc" });
      expect(page.items.map(({ stage }) => stage)).toEqual([
        "started",
        "completed",
        "started",
        "failed",
      ]);
      expect(new Set(page.items.map(({ trace }) => trace?.traceId)).size).toBe(
        2,
      );
      expect(JSON.stringify(page.items)).not.toContain("private-install-token");
    } finally {
      await journal.shutdown();
    }
  });

  it("retains changed-component outcomes when history shutdown fails", async () => {
    const { environment } = await fixture();
    const components = [
      {
        component: "midi-capture",
        status: "installed",
        destination: "/custom/Library/Midi-Capture",
      },
    ] as const;
    installer.installAbletonIntegrations.mockResolvedValue({ components });
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Rebound to the actual journal below.
    const shutdown = LocalObservabilityJournal.prototype.shutdown;
    const fault = vi
      .spyOn(LocalObservabilityJournal.prototype, "shutdown")
      .mockImplementation(async function (this: LocalObservabilityJournal) {
        await shutdown.call(this);
        throw new Error("History shutdown failed");
      });
    try {
      await expect(
        runIntegrationCommand(["install", "--confirm"], { environment }),
      ).rejects.toMatchObject({
        name: "IntegrationHistoryError",
        components,
      });
    } finally {
      fault.mockRestore();
    }
  });

  it("refuses ambiguous Libraries while honoring explicit selection", async () => {
    const { root, userLibrary } = await fixture();
    await mkdir(join(root, "Music", "Ableton", "User Library"), {
      recursive: true,
    });
    await mkdir(join(root, "Documents", "Ableton", "User Library"), {
      recursive: true,
    });
    await expect(
      resolveIntegrationLibrary({
        environment: {},
        homeDirectory: root,
        platform: "darwin",
      }),
    ).rejects.toThrow("Multiple Ableton User Libraries");
    expect(
      await resolveIntegrationLibrary({
        environment: { ABLETON_USER_LIBRARY: userLibrary },
        homeDirectory: root,
        platform: "darwin",
      }),
    ).toBe(userLibrary);
    expect(
      await resolveIntegrationLibrary({
        userLibrary: "C:\\Audio\\User Library",
        environment: {},
        homeDirectory: root,
        platform: "win32",
      }),
    ).toBe("C:\\Audio\\User Library");
  });

  it("matches the selected profile's configured Remote Script Library", async () => {
    const { root, environment } = await fixture();
    const custom = join(root, "Configured Library");
    await mkdir(custom);
    const layout = resolveLiveAgentStorage({ environment });
    await mkdir(dirname(layout.preferencesPath), { recursive: true });
    await writeFile(
      layout.preferencesPath,
      JSON.stringify({
        remoteScriptLocation: join(custom, "Remote Scripts"),
      }),
    );
    installer.inspectAbletonIntegrations.mockResolvedValue({ components: [] });
    await runIntegrationCommand(["detect"], {
      environment: { LIVE_AGENT_HOME: environment.LIVE_AGENT_HOME },
      homeDirectory: root,
    });
    expect(
      installer.inspectAbletonIntegrations.mock.calls[0]?.[0].userLibraryPath,
    ).toBe(custom);
    await expect(
      resolveIntegrationLibrary({
        environment: {},
        homeDirectory: root,
        configuredRemoteScriptLocation: "relative-script-path",
      }),
    ).rejects.toThrow("Configured Remote Script location");
  });
});
