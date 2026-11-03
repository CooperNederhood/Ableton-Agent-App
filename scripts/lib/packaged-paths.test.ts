import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  packagedExecutable,
  packagedCandidateHash,
  finderLikeEnvironment,
} from "../../tests/electron/packaged-paths.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

async function root(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "acceptance-paths-"));
  roots.push(directory);
  return directory;
}

describe("shared packaged executable discovery", () => {
  it("shares the production-like PATH and excludes injected authentication tokens", () => {
    const environment = finderLikeEnvironment({
      GH_TOKEN: "test-only",
      COPILOT_GITHUB_TOKEN: "test-only",
      LIVE_AGENT_PROFILE: "automation",
    });
    expect(environment.PATH).toBe("/usr/bin:/bin:/usr/sbin:/sbin");
    expect(environment.GH_TOKEN).toBeUndefined();
    expect(environment.COPILOT_GITHUB_TOKEN).toBeUndefined();
    expect(environment.LIVE_AGENT_PROFILE).toBe("automation");
  });
  it("uses the reviewed explicit executable without a fallback", async () => {
    const directory = await root();
    const executable = join(directory, "app");
    await writeFile(executable, "test only");
    expect(await packagedExecutable({ explicit: executable })).toBe(executable);
    await expect(
      packagedExecutable({ explicit: join(directory, "missing") }),
    ).rejects.toThrow();
  });

  it("finds the architecture-specific packaged output", async () => {
    vi.stubEnv("ABLETON_AGENT_PACKAGED_EXECUTABLE", "");
    const directory = await root();
    const executable = join(
      directory,
      "mac-arm64",
      "Ableton Agent.app",
      "Contents",
      "MacOS",
      "Ableton Agent",
    );
    await mkdir(join(executable, ".."), { recursive: true });
    await writeFile(executable, "test only");
    expect(
      await packagedExecutable({
        releaseRoot: directory,
        architecture: "arm64",
      }),
    ).toBe(executable);
  });

  it("reports missing builds instead of launching a development fallback", async () => {
    vi.stubEnv("ABLETON_AGENT_PACKAGED_EXECUTABLE", "");
    await expect(
      packagedExecutable({ releaseRoot: await root(), architecture: "arm64" }),
    ).rejects.toThrow("pnpm desktop:dist");
  });

  it("fingerprints actual packaged bytes and rejects unsafe archives or cancellation", async () => {
    const directory = await root();
    const executable = join(directory, "Contents/MacOS/Agent");
    const archive = join(directory, "Contents/Resources/app.asar");
    await mkdir(join(directory, "Contents/Resources"), { recursive: true });
    await writeFile(archive, "candidate");
    expect(
      await packagedCandidateHash(executable, new AbortController().signal),
    ).toBe(createHash("sha256").update("candidate").digest("hex"));
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(
      packagedCandidateHash(executable, cancelled.signal),
    ).rejects.toThrow();
    await rm(archive);
    await writeFile(join(directory, "external"), "candidate");
    await symlink(join(directory, "external"), archive);
    await expect(
      packagedCandidateHash(executable, new AbortController().signal),
    ).rejects.toThrow("archive");
  });
});
