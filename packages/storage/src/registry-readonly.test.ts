import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadProfileRegistry, resolveLiveAgentStorage } from "./index.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "live-agent-registry-readonly-"));
  roots.push(root);
  return resolveLiveAgentStorage({
    environment: { LIVE_AGENT_HOME: join(root, "state") },
  });
}

describe("read-only profile registry inspection", () => {
  it("returns the default in memory without creating directories or registry files", async () => {
    const layout = await fixture();
    expect(
      await loadProfileRegistry(layout, undefined, { readOnly: true }),
    ).toMatchObject({
      selectedProfile: "default",
      profiles: [{ name: "default" }],
    });
    await expect(access(layout.root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps existing initialization behavior for a writable caller", async () => {
    const layout = await fixture();
    await loadProfileRegistry(layout);
    await expect(access(layout.profilesRegistryPath)).resolves.toBeUndefined();
  });

  it("does not substitute defaults for corrupt existing registry data", async () => {
    const layout = await fixture();
    await mkdir(dirname(layout.profilesRegistryPath), { recursive: true });
    await writeFile(
      layout.profilesRegistryPath,
      JSON.stringify({ selectedProfile: "../unsafe" }),
    );
    await expect(
      loadProfileRegistry(layout, undefined, { readOnly: true }),
    ).rejects.toThrow();
    await expect(access(layout.profileRoot)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
