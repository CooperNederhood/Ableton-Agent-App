import { describe, expect, it, vi } from "vitest";

import { discoverGitHubCli } from "./copilot-auth.js";

describe("discoverGitHubCli", () => {
  it("preserves an executable already available through PATH", async () => {
    const isExecutable = vi.fn(async (path: string) => path === "/tools/gh");

    await expect(
      discoverGitHubCli({
        environment: { PATH: "/tools:/usr/bin" },
        platform: "darwin",
        isExecutable,
      }),
    ).resolves.toMatchObject({
      status: "found",
      source: "environment-path",
      executablePath: "/tools/gh",
      runtimeEnvironment: { PATH: "/tools:/usr/bin" },
    });
  });

  it("adds the Homebrew directory for a Finder-like macOS PATH", async () => {
    const isExecutable = vi.fn(
      async (path: string) => path === "/opt/homebrew/bin/gh",
    );

    const result = await discoverGitHubCli({
      environment: {
        HOME: "/Users/example",
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      },
      platform: "darwin",
      isExecutable,
    });

    expect(result).toMatchObject({
      status: "found",
      source: "standard-location",
      executablePath: "/opt/homebrew/bin/gh",
      runtimeEnvironment: {
        HOME: "/Users/example",
        PATH: "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      },
    });
  });

  it("honors an explicit executable override without invoking a shell", async () => {
    const isExecutable = vi.fn(
      async (path: string) => path === "/custom/github-cli",
    );

    const result = await discoverGitHubCli({
      environment: {
        ABLETON_AGENT_GH_PATH: "/custom/github-cli",
        PATH: "/usr/bin",
      },
      platform: "darwin",
      isExecutable,
    });

    expect(result).toMatchObject({
      status: "found",
      source: "explicit",
      executablePath: "/custom/github-cli",
      runtimeEnvironment: {
        PATH: "/custom:/usr/bin",
      },
    });
    expect(isExecutable).toHaveBeenCalledWith("/custom/github-cli");
  });

  it("reports missing when no bounded candidate is executable", async () => {
    await expect(
      discoverGitHubCli({
        environment: { PATH: "/usr/bin:/bin" },
        platform: "darwin",
        isExecutable: async () => false,
      }),
    ).resolves.toEqual({
      status: "missing",
      runtimeEnvironment: { PATH: "/usr/bin:/bin" },
    });
  });
});
