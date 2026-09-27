import { describe, expect, it } from "vitest";

import {
  desktopProcesses,
  hostPackageDirectory,
  liveProcesses,
  parseInstallArguments,
} from "./install-desktop-macos.mjs";

describe("macOS desktop installer", () => {
  it("uses safe full-install defaults", () => {
    expect(parseInstallArguments([])).toEqual({
      checks: true,
      launch: true,
      remoteScript: true,
    });
  });

  it("accepts explicit development shortcuts and rejects unknown options", () => {
    expect(
      parseInstallArguments([
        "--",
        "--skip-checks",
        "--skip-remote-script",
        "--no-launch",
      ]),
    ).toEqual({
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
      "202 /Applications/Ableton Live 12 Suite.app/Contents/MacOS/Live",
    ].join("\n");
    expect(liveProcesses(table)).toEqual([
      "201 /Applications/Ableton Live 11 Suite.app/Contents/MacOS/Live",
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
