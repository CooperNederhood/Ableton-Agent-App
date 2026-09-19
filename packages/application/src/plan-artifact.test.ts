import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveProductionSessionStorage } from "@ableton-agent/storage";

import {
  FilePlanArtifactStore,
  PlanArtifactConflictError,
} from "./plan-artifact.js";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ableton-plan-artifact-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("FilePlanArtifactStore", () => {
  it("creates a canonical owner-only plan artifact", async () => {
    const root = await temporaryRoot();
    const store = new FilePlanArtifactStore(root);

    const artifact = await store.write("production-1", {
      content: "# Plan\r\n\r\n1. Inspect the Live Set.\r\n",
    });
    const paths = resolveProductionSessionStorage(root, "production-1");

    expect(artifact).toMatchObject({
      exists: true,
      productionSessionId: "production-1",
      content: "# Plan\n\n1. Inspect the Live Set.\n",
    });
    expect((await lstat(paths.sessionDirectory)).mode & 0o777).toBe(0o700);
    expect((await lstat(paths.artifactsDirectory)).mode & 0o777).toBe(0o700);
    expect((await lstat(paths.planPath)).mode & 0o777).toBe(0o600);
    await expect(store.read("production-1")).resolves.toEqual(artifact);
  });

  it("redacts embedded credentials before persistence", async () => {
    const root = await temporaryRoot();
    const store = new FilePlanArtifactStore(root);

    const artifact = await store.write("production-1", {
      content: "# Plan\n\nUse Authorization: Bearer never-store-this.\n",
    });

    expect(artifact.exists && artifact.content).toContain("[REDACTED]");
    expect(artifact.exists && artifact.content).not.toContain(
      "never-store-this",
    );
  });

  it("requires the current revision for replacements", async () => {
    const root = await temporaryRoot();
    const store = new FilePlanArtifactStore(root);
    const first = await store.write("production-1", { content: "# First\n" });
    if (!first.exists) throw new Error("Expected a stored plan");

    await expect(
      store.write("production-1", { content: "# Missing revision\n" }),
    ).rejects.toBeInstanceOf(PlanArtifactConflictError);
    await expect(
      store.write("production-1", {
        content: "# Stale\n",
        expectedRevision: "0".repeat(64),
      }),
    ).rejects.toBeInstanceOf(PlanArtifactConflictError);
    await expect(
      store.write("production-1", {
        content: "# Updated\n",
        expectedRevision: first.revision,
      }),
    ).resolves.toMatchObject({ exists: true, content: "# Updated\n" });
  });

  it("serializes concurrent writes and rejects the stale writer", async () => {
    const root = await temporaryRoot();
    const store = new FilePlanArtifactStore(root);
    const first = await store.write("production-1", { content: "# First\n" });
    if (!first.exists) throw new Error("Expected a stored plan");

    const results = await Promise.allSettled([
      store.write("production-1", {
        content: "# Writer A\n",
        expectedRevision: first.revision,
      }),
      store.write("production-1", {
        content: "# Writer B\n",
        expectedRevision: first.revision,
      }),
    ]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1,
    );
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(
      1,
    );
    const rejected = results.find(({ status }) => status === "rejected");
    expect(rejected?.status).toBe("rejected");
    if (rejected?.status !== "rejected") {
      throw new Error("Expected one conflicting writer");
    }
    expect(rejected.reason).toBeInstanceOf(PlanArtifactConflictError);
  });
});
