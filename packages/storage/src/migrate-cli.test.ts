import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runMigrationCli } from "./migrate-cli.js";

const roots: string[] = [];

async function legacyRoot(): Promise<string> {
  const root = join(process.cwd(), `.test-storage-cli-${crypto.randomUUID()}`);
  roots.push(root);
  await mkdir(join(root, "profiles", "studio", "state"), {
    recursive: true,
  });
  await writeFile(
    join(root, "storage-version.json"),
    JSON.stringify({ version: 1 }),
  );
  await writeFile(
    join(root, "profiles", "studio", "state", "sessions.json"),
    JSON.stringify({ version: 3, sessions: [] }),
  );
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("nested storage migration CLI", () => {
  it("defaults to a no-write dry run for LIVE_AGENT_HOME and profile", async () => {
    const root = await legacyRoot();
    const output: string[] = [];
    const errors: string[] = [];
    const exitCode = await runMigrationCli(
      ["--profile", "studio", "--json"],
      { LIVE_AGENT_HOME: root },
      {
        write: (text) => output.push(text),
        writeError: (text) => errors.push(text),
      },
    );

    expect(exitCode).toBe(0);
    expect(errors).toEqual([]);
    expect(JSON.parse(output.join("\n"))).toMatchObject({
      status: "dry-run",
      applied: false,
      profile: "studio",
    });
    expect(
      JSON.parse(await readFile(join(root, "storage-version.json"), "utf8")),
    ).toEqual({ version: 1 });
  });

  it("requires --apply to migrate and returns nonzero on validation failure", async () => {
    const root = await legacyRoot();
    const output: string[] = [];
    const errors: string[] = [];
    expect(
      await runMigrationCli(
        ["--profile", "studio", "--apply"],
        { LIVE_AGENT_HOME: root },
        {
          write: (text) => output.push(text),
          writeError: (text) => errors.push(text),
        },
      ),
    ).toBe(0);
    expect(output.join("\n")).toContain("completed");
    expect(
      JSON.parse(await readFile(join(root, "storage-version.json"), "utf8")),
    ).toEqual({ version: 2 });

    const invalidRoot = join(
      process.cwd(),
      `.test-storage-cli-${crypto.randomUUID()}`,
    );
    roots.push(invalidRoot);
    await mkdir(join(invalidRoot, "profiles", "studio"), { recursive: true });
    expect(
      await runMigrationCli(
        ["--profile", "studio"],
        { LIVE_AGENT_HOME: invalidRoot },
        {
          write: (text) => output.push(text),
          writeError: (text) => errors.push(text),
        },
      ),
    ).toBe(1);
    expect(errors.at(-1)).toContain("version marker is missing");
  });
});
