import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type * as FileSystem from "node:fs/promises";
import {
  assertAcceptanceInputsUnchanged,
  inspectAcceptanceInputs,
  inspectAcceptanceSource,
  inspectPackagedCandidate,
} from "./acceptance-identity.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FileSystem>();
  return { ...actual, open: vi.fn(actual.open) };
});

async function workspace(run: (root: string) => Promise<void>) {
  const parent = resolve(".test-artifacts/acceptance-identity");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "case-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function file(root: string, path: string, bytes: string | Buffer) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), bytes);
}

async function bundle(root: string) {
  const app = join(root, "Candidate.app");
  const executable = join(app, "Contents/MacOS/Candidate");
  await file(app, "Contents/MacOS/Candidate", "executable");
  await chmod(executable, 0o755);
  await file(app, "Contents/Resources/app.asar", "archive");
  await file(
    app,
    "Contents/Frameworks/Framework.framework/Versions/A/Framework",
    "framework",
  );
  await file(app, "Contents/Resources/native/bridge.node", "native module");
  await file(app, "Contents/Resources/integrations/device.amxd", "integration");
  await symlink(
    "A",
    join(app, "Contents/Frameworks/Framework.framework/Versions/Current"),
  );
  await symlink(
    "Versions/Current/Framework",
    join(app, "Contents/Frameworks/Framework.framework/Framework"),
  );
  return { app, executable };
}

function git(root: string, args: string[]) {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

async function source(root: string, scenarios: string[] = ["first"]) {
  await mkdir(root, { recursive: true });
  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.email", "test@example.invalid"]);
  git(root, ["config", "user.name", "Identity Test"]);
  await file(root, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  await file(root, "scripts/acceptance.mjs", "runner source");
  await file(
    root,
    "integration/acceptance-scenarios/suite.json",
    JSON.stringify({ schemaVersion: 1, scenarios }),
  );
  for (const id of scenarios) {
    await file(
      root,
      `integration/acceptance-scenarios/${id}.json`,
      JSON.stringify({ schemaVersion: 1, id, fixtureId: id }),
    );
    const bytes = Buffer.from(`asset ${id}`);
    await file(root, `integration/fixtures/${id}/project.als`, bytes);
    await file(
      root,
      `integration/fixtures/${id}/fixture.json`,
      JSON.stringify({
        schemaVersion: 1,
        id,
        resources: [
          {
            path: "project.als",
            target: "project.als",
            bytes: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          },
        ],
      }),
    );
  }
  git(root, ["add", "."]);
  git(root, ["commit", "--quiet", "-m", "Initial identity fixture"]);
}

describe("packaged acceptance identity", () => {
  it("pins full bundle bytes and safe framework aliases in deterministic sorted inventory", async () => {
    await workspace(async (root) => {
      const { app, executable } = await bundle(root);
      const before = await inspectPackagedCandidate(executable);
      expect(before.appAsarSha256).toBe(
        createHash("sha256").update("archive").digest("hex"),
      );
      expect(await inspectPackagedCandidate(executable)).toEqual(before);
      expect(JSON.parse(JSON.stringify(before))).toEqual(before);
      expect(before.inventory.map((entry) => entry.path)).toEqual(
        before.inventory.map((entry) => entry.path).sort(),
      );
      expect(before.inventory).toContainEqual(
        expect.objectContaining({
          path: "Contents/Frameworks/Framework.framework/Versions/Current",
          kind: "symlink",
          target: "A",
        }),
      );
      for (const path of [
        "Contents/MacOS/Candidate",
        "Contents/Resources/app.asar",
        "Contents/Frameworks/Framework.framework/Versions/A/Framework",
        "Contents/Resources/native/bridge.node",
        "Contents/Resources/integrations/device.amxd",
      ]) {
        const original = await readFile(join(app, path));
        await writeFile(join(app, path), `${original.toString()} mutation`);
        expect((await inspectPackagedCandidate(executable)).sha256).not.toBe(
          before.sha256,
        );
        await writeFile(join(app, path), original);
        expect((await inspectPackagedCandidate(executable)).sha256).toBe(
          before.sha256,
        );
      }
      await file(app, "Contents/Resources/new-resource", "new");
      expect((await inspectPackagedCandidate(executable)).sha256).not.toBe(
        before.sha256,
      );
    });
  });

  it("records ancestor aliases without traversal and rejects escaping, broken, and cyclic links", async () => {
    await workspace(async (root) => {
      const { app, executable } = await bundle(root);
      const link = join(app, "Contents/Resources/link");
      await symlink("..", link);
      const safe = await inspectPackagedCandidate(executable);
      expect(
        safe.inventory.filter((entry) => entry.path.includes("Resources/link")),
      ).toHaveLength(1);
      await rm(link);
      await file(root, "outside", "private");
      for (const target of [
        "../../../outside",
        join(root, "outside"),
        "missing",
        "link",
      ]) {
        await symlink(target, link);
        await expect(inspectPackagedCandidate(executable)).rejects.toThrow();
        await rm(link);
      }
    });
  });

  it("rejects missing candidates, invalid layout, nonexecutable files, and symlink bundle roots", async () => {
    await workspace(async (root) => {
      await expect(
        inspectPackagedCandidate(
          join(root, "missing.app/Contents/MacOS/Candidate"),
        ),
      ).rejects.toThrow();
      await expect(
        inspectPackagedCandidate(join(root, "candidate")),
      ).rejects.toThrow("macOS");
      const { app, executable } = await bundle(root);
      await chmod(executable, 0o644);
      await expect(inspectPackagedCandidate(executable)).rejects.toThrow(
        "executable",
      );
      await symlink(app, join(root, "Alias.app"));
      await expect(
        inspectPackagedCandidate(
          join(root, "Alias.app/Contents/MacOS/Candidate"),
        ),
      ).rejects.toThrow("symlinks");
    });
  });

  it("enforces file, total, entry and depth bounds and cancellation", async () => {
    await workspace(async (root) => {
      const { executable } = await bundle(root);
      for (const limit of [
        { fileBytes: 2 },
        { totalBytes: 2 },
        { entries: 2 },
        { depth: 2 },
      ])
        await expect(
          inspectPackagedCandidate(executable, undefined, limit),
        ).rejects.toThrow("bound");
      await expect(
        inspectPackagedCandidate(executable, undefined, { entries: Infinity }),
      ).rejects.toThrow("bound");
      const controller = new AbortController();
      controller.abort(new Error("inspection cancelled"));
      await expect(
        inspectPackagedCandidate(executable, controller.signal),
      ).rejects.toThrow("inspection cancelled");
    });
  });

  it("redacts persisted paths without changing the raw-byte identity", async () => {
    await workspace(async (root) => {
      const { app, executable } = await bundle(root);
      const secret = `ghp_${"A".repeat(36)}`;
      const path = `Contents/Resources/${secret}`;
      await file(app, path, "first");
      const before = await inspectPackagedCandidate(executable);
      expect(JSON.stringify(before)).not.toContain(secret);
      await file(app, path, "second");
      expect((await inspectPackagedCandidate(executable)).sha256).not.toBe(
        before.sha256,
      );
    });
  });

  it.each(["mutation", "cancellation"] as const)(
    "detects %s during streaming and closes its handle",
    async (failure) => {
      await workspace(async (root) => {
        const { app, executable } = await bundle(root);
        const module = await import("node:fs/promises");
        const originalOpen = (
          await vi.importActual<typeof FileSystem>("node:fs/promises")
        ).open;
        let changed = false;
        const controller = new AbortController();
        const opened: Awaited<ReturnType<typeof originalOpen>>[] = [];
        const spy = vi
          .spyOn(module, "open")
          .mockImplementation(async (...args) => {
            const handle = await originalOpen(...args);
            opened.push(handle);
            if (String(args[0]).endsWith("app.asar")) {
              const originalRead = handle.read.bind(handle);
              handle.read = async (
                ...readArgs: Parameters<typeof originalRead>
              ) => {
                const result = await originalRead(...readArgs);
                if (!changed) {
                  changed = true;
                  if (failure === "mutation") {
                    await writeFile(
                      join(app, "Contents/Resources/app.asar"),
                      "changed archive",
                    );
                  } else {
                    controller.abort(new Error("inspection cancelled"));
                  }
                }
                return result;
              };
            }
            return handle;
          });
        try {
          await expect(
            inspectPackagedCandidate(executable, controller.signal),
          ).rejects.toThrow(failure === "mutation" ? "changed" : "cancelled");
          expect(changed).toBe(true);
          expect(opened.every((handle) => handle.fd === -1)).toBe(true);
        } finally {
          spy.mockRestore();
        }
      });
    },
  );
});

describe("acceptance source provenance", () => {
  it("pins revision, lockfile and runner, including dirty and untracked inputs", async () => {
    await workspace(async (root) => {
      await source(root);
      const before = await inspectAcceptanceSource(root);
      expect(before.dirty).toBe(false);
      expect(before.revision).toBe(git(root, ["rev-parse", "HEAD"]));
      expect(await inspectAcceptanceSource(root)).toEqual(before);
      await file(root, "scripts/acceptance.mjs", "dirty runner");
      const dirty = await inspectAcceptanceSource(root);
      expect(dirty.dirty).toBe(true);
      expect(dirty.revision).toBe(before.revision);
      expect(dirty.sha256).not.toBe(before.sha256);
      await file(root, "scripts/new-helper.ts", "untracked runner");
      expect((await inspectAcceptanceSource(root)).sha256).not.toBe(
        dirty.sha256,
      );
      await file(root, "pnpm-lock.yaml", "changed lockfile");
      expect((await inspectAcceptanceSource(root)).lockfile.sha256).not.toBe(
        before.lockfile.sha256,
      );
    });
  });

  it("leaves malformed and missing catalog, scenario and fixture inputs to the suite owner", async () => {
    await workspace(async (root) => {
      await source(root, ["first", "second", "third"]);
      await file(root, "integration/acceptance-scenarios/first.json", "{");
      await rm(join(root, "integration/fixtures/second/fixture.json"));
      await file(root, "integration/acceptance-scenarios/suite.json", "{");
      const result = await inspectAcceptanceSource(root);
      expect(result.dirty).toBe(true);
      expect(
        result.inventory.some((entry) => entry.path.startsWith("integration/")),
      ).toBe(false);
      await file(
        root,
        "integration/fixtures/first/project.als",
        "changed asset",
      );
      expect((await inspectAcceptanceSource(root)).inventory).toEqual(
        result.inventory,
      );
    });
  });

  it("rejects missing lockfiles, missing runner inputs, and non-Git roots", async () => {
    await workspace(async (root) => {
      await expect(inspectAcceptanceSource(root)).rejects.toThrow("Git");
      await source(root);
      await rm(join(root, "pnpm-lock.yaml"));
      await expect(inspectAcceptanceSource(root)).rejects.toThrow();
      await file(root, "pnpm-lock.yaml", "lock restored");
      await rm(join(root, "scripts/acceptance.mjs"));
      await expect(inspectAcceptanceSource(root)).rejects.toThrow();
    });
  });

  it("pins legitimate internal source file aliases and rejects external aliases", async () => {
    await workspace(async (root) => {
      await source(root);
      await file(root, "shared/identity.js", "shared identity");
      await symlink("../shared/identity.js", join(root, "scripts/identity.js"));
      const before = await inspectAcceptanceSource(root);
      expect(before.inventory).toContainEqual(
        expect.objectContaining({
          path: "scripts/identity.js",
          kind: "symlink",
          target: "../shared/identity.js",
        }),
      );
      await file(root, "shared/identity.js", "mutated shared identity");
      expect((await inspectAcceptanceSource(root)).sha256).not.toBe(
        before.sha256,
      );
      await rm(join(root, "scripts/identity.js"));
      await symlink("../../external.js", join(root, "scripts/identity.js"));
      await expect(inspectAcceptanceSource(root)).rejects.toThrow();
    });
  });

  it("supports exact pre/post comparison and rejects independently changed source or candidate", async () => {
    await workspace(async (root) => {
      const sourceRoot = join(root, "source");
      await source(sourceRoot);
      const { app, executable } = await bundle(root);
      const options = { root: sourceRoot, executablePath: executable };
      const before = await inspectAcceptanceInputs(options);
      expect(() =>
        assertAcceptanceInputsUnchanged(before, before),
      ).not.toThrow();
      await file(
        app,
        "Contents/Resources/integrations/device.amxd",
        "changed device",
      );
      const candidateChanged = await inspectAcceptanceInputs(options);
      expect(() =>
        assertAcceptanceInputsUnchanged(before, candidateChanged),
      ).toThrow("changed");
      await file(sourceRoot, "scripts/acceptance.mjs", "changed runner");
      const sourceChanged = await inspectAcceptanceInputs(options);
      expect(() =>
        assertAcceptanceInputsUnchanged(candidateChanged, sourceChanged),
      ).toThrow("changed");
    });
  });
});
