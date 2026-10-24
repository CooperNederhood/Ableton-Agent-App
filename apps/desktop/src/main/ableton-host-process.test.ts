import { describe, expect, it } from "vitest";

import {
  assertAbletonLive11Stopped,
  hasRunningLive11,
} from "./ableton-host-process.js";
import { assertAbletonLive11Stopped as installerHostGuard } from "./ableton-integrations-install.js";

describe("Live 11 installation guard", () => {
  it("exports the same production guard through the installer entry point", () => {
    expect(installerHostGuard).toBe(assertAbletonLive11Stopped);
  });
  it("identifies actual supported Live 11 host executables, not helper apps or unrelated processes", () => {
    expect(
      hasRunningLive11(
        "/Applications/Ableton Live 11 Suite.app/Contents/MacOS/Live",
      ),
    ).toBe(true);
    expect(
      hasRunningLive11(
        "C:\\ProgramData\\Ableton\\Live 11 Suite\\Program\\Ableton Live 11 Suite.exe",
      ),
    ).toBe(true);
    expect(
      hasRunningLive11("Ableton Live 11 Suite.exe,123,Console,1,100 K"),
    ).toBe(true);
    expect(
      hasRunningLive11(
        "/Applications/Ableton Live 12 Suite.app/Contents/MacOS/Live",
      ),
    ).toBe(false);
    expect(
      hasRunningLive11(
        "/Applications/Ableton Live 11 Suite.app/Contents/MacOS/Index",
      ),
    ).toBe(false);
    expect(
      hasRunningLive11(
        "/Applications/Ableton Live 11 Suite.app/Contents/MacOS/LiveHelper /Users/example/Owned.als",
      ),
    ).toBe(false);
    expect(hasRunningLive11("node unrelated.js")).toBe(false);
  });

  it.each(["darwin", "win32"] as const)(
    "refuses a running supported host on %s, without terminating it",
    async (platform) => {
      const processes =
        platform === "darwin"
          ? "/Applications/Ableton Live 11 Suite.app/Contents/MacOS/Live"
          : '"Ableton Live 11 Suite.exe","123","Console","1","100 K"';
      await expect(
        assertAbletonLive11Stopped({
          platform,
          readProcessList: async () => processes,
        }),
      ).rejects.toThrow("Quit Ableton Live 11");
      await expect(
        assertAbletonLive11Stopped({
          platform,
          readProcessList: async () => "node unrelated.js",
        }),
      ).resolves.toBeUndefined();
    },
  );

  it.each([
    "/Applications/Ableton Live 11 Suite.app/Contents/MacOS/Live /Users/example/Owned.als",
    '"/Applications/Ableton Live 11 Suite.app/Contents/MacOS/Live" "/Users/example/Live Sets/Owned.als"',
    "C:\\ProgramData\\Ableton\\Live 11 Suite\\Program\\Ableton Live 11 Suite.exe C:\\Users\\example\\Owned.als",
  ])(
    "refuses a supported host executable followed by arguments: %s",
    async (command) => {
      expect(hasRunningLive11(command)).toBe(true);
      await expect(
        installerHostGuard({
          platform: command.startsWith("C:") ? "win32" : "darwin",
          readProcessList: async () =>
            `node unrelated.js\n${command}\nnode other.js`,
        }),
      ).rejects.toThrow("Quit Ableton Live 11");
    },
  );

  it("fails closed if process inspection fails or the platform cannot be inspected", async () => {
    await expect(
      assertAbletonLive11Stopped({
        platform: "darwin",
        readProcessList: async () => {
          throw new Error("process inspection denied");
        },
      }),
    ).rejects.toThrow("process inspection denied");
    await expect(
      assertAbletonLive11Stopped({
        platform: "linux",
        readProcessList: async () => "",
      }),
    ).rejects.toThrow("Cannot safely inspect");
  });
});
