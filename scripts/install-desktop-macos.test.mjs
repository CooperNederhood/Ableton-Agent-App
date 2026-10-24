import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal()),
  platform: () => "darwin",
}));
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal()),
  rm: vi.fn(),
  access: vi.fn(),
  rename: vi.fn(),
}));

import {
  desktopProcesses,
  hostPackageDirectory,
  integrationInstallArguments,
  liveProcesses,
  parseInstallArguments,
} from "./install-desktop-macos.mjs";

describe("macOS desktop installer", () => {
  afterEach(() => vi.resetAllMocks());

  it("still refuses running Live when only Python installation is skipped", async () => {
    vi.mocked(spawnSync).mockImplementation((command) =>
      command === "ps"
        ? {
            status: 0,
            stdout:
              "201 /Applications/Ableton Live 11 Suite.app/Contents/MacOS/Live\n",
          }
        : { status: 1, stderr: "Unexpected build after unsafe preflight" },
    );
    const { installDesktopMacos } = await import("./install-desktop-macos.mjs");
    await expect(
      installDesktopMacos(
        parseInstallArguments(["--skip-remote-script", "--no-launch"]),
      ),
    ).rejects.toThrow("Fully quit Ableton Live");
    expect(vi.mocked(spawnSync).mock.calls.map(([command]) => command)).toEqual(
      ["ps"],
    );
  });

  it("uses safe full-install defaults", () => {
    expect(parseInstallArguments([])).toEqual({
      authSmoke: true,
      checks: true,
      launch: true,
      remoteScript: true,
    });
  });

  it("rechecks running hosts after the build before publishing integrations", async () => {
    const snapshots = [
      "",
      "201 /Applications/Ableton Live 11 Suite.app/Contents/MacOS/Live\n",
    ];
    vi.mocked(spawnSync).mockImplementation((command) =>
      command === "ps"
        ? { status: 0, stdout: snapshots.shift() ?? "" }
        : { status: 0 },
    );
    const { installDesktopMacos } = await import("./install-desktop-macos.mjs");
    await expect(
      installDesktopMacos(
        parseInstallArguments([
          "--skip-checks",
          "--skip-auth-smoke",
          "--no-launch",
        ]),
      ),
    ).rejects.toThrow("Fully quit Ableton Live");
    expect(
      vi
        .mocked(spawnSync)
        .mock.calls.some(([, args]) => args.includes("integrations")),
    ).toBe(false);
  });

  it("delivers both devices even when Python is skipped, with one explicit target", () => {
    const options = parseInstallArguments([
      "--skip-remote-script",
      "--user-library",
      "/Volumes/Audio/Library",
      "--profile",
      "studio",
    ]);
    expect(
      integrationInstallArguments(options, "/tmp/Ableton Agent.app", "trace"),
    ).toEqual([
      "--filter",
      "@ableton-agent/desktop",
      "integrations",
      "update",
      "--confirm",
      "--resources",
      "/tmp/Ableton Agent.app/Contents/Resources",
      "--trace-id",
      "trace",
      "--correlation-id",
      "trace",
      "--causation-id",
      "desktop-reinstall-trace",
      "--components",
      "machine-listening,midi-capture",
      "--user-library",
      "/Volumes/Audio/Library",
      "--profile",
      "studio",
    ]);
    expect(() => parseInstallArguments(["--user-library"])).toThrow(
      "Missing value",
    );
  });

  it("accepts explicit development shortcuts and rejects unknown options", () => {
    expect(
      parseInstallArguments([
        "--",
        "--skip-checks",
        "--skip-auth-smoke",
        "--skip-remote-script",
        "--no-launch",
      ]),
    ).toEqual({
      authSmoke: false,
      checks: false,
      launch: false,
      remoteScript: false,
    });
    expect(() => parseInstallArguments(["--force"])).toThrow(
      "Unknown option: --force",
    );
  });

  it("detects every main desktop copy without matching helper processes", () => {
    const table = [
      "101 /Applications/Ableton Agent.app/Contents/MacOS/Ableton Agent",
      "102 /tmp/Ableton Agent.app/Contents/MacOS/Ableton Agent",
      "103 /Applications/Ableton Agent.app/Contents/Frameworks/Ableton Agent Helper.app/Contents/MacOS/Ableton Agent Helper --type=renderer",
    ].join("\n");
    expect(desktopProcesses(table)).toEqual([
      "101 /Applications/Ableton Agent.app/Contents/MacOS/Ableton Agent",
      "102 /tmp/Ableton Agent.app/Contents/MacOS/Ableton Agent",
    ]);
  });

  it("detects supported Live 11 processes", () => {
    const table = [
      "201 /Applications/Ableton Live 11 Suite.app/Contents/MacOS/Live",
      "203 /Applications/Ableton Live 11 Suite.app/Contents/MacOS/Live /tmp/Owned.als",
      "202 /Applications/Ableton Live 12 Suite.app/Contents/MacOS/Live",
    ].join("\n");
    expect(liveProcesses(table)).toEqual([
      "201 /Applications/Ableton Live 11 Suite.app/Contents/MacOS/Live",
      "203 /Applications/Ableton Live 11 Suite.app/Contents/MacOS/Live /tmp/Owned.als",
    ]);
  });

  it("selects electron-builder's host output directory", () => {
    expect(hostPackageDirectory("arm64")).toBe("mac-arm64");
    expect(hostPackageDirectory("x64")).toBe("mac");
    expect(() => hostPackageDirectory("riscv64")).toThrow(
      "Unsupported macOS architecture",
    );
  });
});
