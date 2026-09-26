import {
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  truncate,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PermissionRequest } from "@github/copilot-sdk";
import { afterEach, describe, expect, it } from "vitest";

import {
  evaluateSpillFileShellPermission,
  prepareSpillDirectory,
} from "./shell-policy.js";

const roots: string[] = [];

async function fixture(): Promise<{
  directory: string;
  file: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "ableton-shell-policy-"));
  roots.push(root);
  const directory = join(root, "tool-output");
  await mkdir(directory, { mode: 0o700 });
  const file = join(directory, "123-copilot-tool-output-abcdef0123456789.txt");
  await writeFile(file, '{"pads":[]}\n', { mode: 0o600 });
  return { directory, file };
}

function shellRequest(
  file: string,
  overrides: Partial<Extract<PermissionRequest, { kind: "shell" }>> = {},
): Extract<PermissionRequest, { kind: "shell" }> {
  return {
    kind: "shell",
    canOfferSessionApproval: false,
    commands: [{ identifier: "jq", readOnly: true }],
    commandSegments: [
      {
        identifier: "jq",
        fullCommandText: `jq '.pads[] | select(.chainCount > 0)' '${file}'`,
      },
    ],
    fullCommandText: `jq '.pads[] | select(.chainCount > 0)' '${file}'`,
    hasWriteFileRedirection: false,
    intention: "Inspect a spilled JSON result",
    possiblePaths: [file],
    possibleUrls: [],
    resolvedPaths: { [file]: file },
    resolvedWorkingDirectory: "/",
    ...overrides,
  };
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("spill file shell permission", () => {
  it("removes expired spill files without touching unrelated files", async () => {
    const { directory, file } = await fixture();
    const unrelated = join(directory, "keep.txt");
    await writeFile(unrelated, "keep");
    const now = Date.now();
    await utimes(
      file,
      new Date(now - 25 * 60 * 60 * 1000),
      new Date(now - 25 * 60 * 60 * 1000),
    );

    expect(prepareSpillDirectory(directory, now)).toMatchObject({
      removedFileCount: 1,
      retainedFileCount: 0,
    });
    await expect(readFile(unrelated, "utf8")).resolves.toBe("keep");
  });

  it("approves bounded jq inspection of a profile-owned spill file", async () => {
    const { directory, file } = await fixture();

    expect(
      evaluateSpillFileShellPermission(shellRequest(file), directory),
    ).toEqual({ kind: "approve-once" });
  });

  it("approves a read-only grep and head pipeline", async () => {
    const { directory, file } = await fixture();
    const fullCommandText = `grep -n 'chainCount' '${file}' | head -n 25`;

    expect(
      evaluateSpillFileShellPermission(
        shellRequest(file, {
          commands: [
            { identifier: "grep", readOnly: true },
            { identifier: "head", readOnly: true },
          ],
          commandSegments: [
            {
              identifier: "grep",
              fullCommandText: `grep -n 'chainCount' '${file}'`,
            },
            { identifier: "head", fullCommandText: "head -n 25" },
          ],
          fullCommandText,
        }),
        directory,
      ),
    ).toEqual({ kind: "approve-once" });
  });

  it.each([
    {
      name: "write redirection",
      overrides: { hasWriteFileRedirection: true },
    },
    {
      name: "network access",
      overrides: { possibleUrls: [{ url: "https://example.com" }] },
    },
    {
      name: "sandbox bypass",
      overrides: { requestSandboxBypass: true },
    },
    {
      name: "non-read-only command",
      overrides: { commands: [{ identifier: "grep", readOnly: false }] },
    },
    {
      name: "unapproved executable",
      overrides: { commands: [{ identifier: "python3", readOnly: true }] },
    },
    {
      name: "command substitution",
      overrides: {
        fullCommandText: 'grep x "$(env)"',
        commandSegments: [
          { identifier: "grep", fullCommandText: 'grep x "$(env)"' },
        ],
      },
    },
    {
      name: "environment expansion",
      overrides: {
        fullCommandText: 'grep "$SECRET" result.txt',
        commandSegments: [
          {
            identifier: "grep",
            fullCommandText: 'grep "$SECRET" result.txt',
          },
        ],
      },
    },
    {
      name: "absolute executable path",
      overrides: {
        fullCommandText: "/usr/bin/jq '.pads' result.txt",
        commandSegments: [
          {
            identifier: "jq",
            fullCommandText: "/usr/bin/jq '.pads' result.txt",
          },
        ],
      },
    },
    {
      name: "unsafe jq environment access",
      overrides: {
        fullCommandText: "jq 'env' result.txt",
        commandSegments: [
          { identifier: "jq", fullCommandText: "jq 'env' result.txt" },
        ],
      },
    },
    {
      name: "unbounded tail",
      overrides: {
        commands: [{ identifier: "tail", readOnly: true }],
        fullCommandText: "tail -f result.txt",
        commandSegments: [
          { identifier: "tail", fullCommandText: "tail -f result.txt" },
        ],
      },
    },
  ])("rejects $name", async ({ overrides }) => {
    const { directory, file } = await fixture();

    expect(
      evaluateSpillFileShellPermission(
        shellRequest(file, overrides),
        directory,
      ),
    ).toMatchObject({ kind: "reject" });
  });

  it("rejects missing parsed command segments", async () => {
    const { directory, file } = await fixture();
    const request = shellRequest(file);
    delete request.commandSegments;

    expect(evaluateSpillFileShellPermission(request, directory)).toMatchObject({
      kind: "reject",
    });
  });

  it("rejects files outside the spill directory", async () => {
    const { directory } = await fixture();
    const outside = join(tmpdir(), "copilot-tool-output-outside.txt");
    await writeFile(outside, "{}");
    roots.push(outside);

    expect(
      evaluateSpillFileShellPermission(shellRequest(outside), directory),
    ).toMatchObject({ kind: "reject" });
  });

  it("rejects symlinked spill files", async () => {
    const { directory, file } = await fixture();
    const link = join(
      directory,
      "124-copilot-tool-output-abcdef0123456789.txt",
    );
    await symlink(file, link);

    expect(
      evaluateSpillFileShellPermission(shellRequest(link), directory),
    ).toMatchObject({ kind: "reject" });
  });

  it("rejects spill files larger than the inspection limit", async () => {
    const { directory, file } = await fixture();
    await truncate(file, 16 * 1024 * 1024 + 1);

    expect(
      evaluateSpillFileShellPermission(shellRequest(file), directory),
    ).toMatchObject({ kind: "reject" });
  });
});
