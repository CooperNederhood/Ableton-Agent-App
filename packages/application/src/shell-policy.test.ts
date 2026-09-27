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
  evaluateSpillFileShellPolicy,
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

function liveShellRequest(
  file: string,
  fullCommandText: string,
  commandSegments: NonNullable<
    Extract<PermissionRequest, { kind: "shell" }>["commandSegments"]
  >,
  resolvedWorkingDirectory?: string,
): Extract<PermissionRequest, { kind: "shell" }> {
  const request = shellRequest(file, {
    commands: [{ identifier: fullCommandText, readOnly: false }],
    commandSegments,
    fullCommandText,
    possiblePaths: [],
  });
  delete request.resolvedPaths;
  if (resolvedWorkingDirectory === undefined) {
    delete request.resolvedWorkingDirectory;
  } else {
    request.resolvedWorkingDirectory = resolvedWorkingDirectory;
  }
  return request;
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
    const fullCommandText = `jq -c '.parameters[] | select(.name|test("A Wave|A Coarse|A Fine|Pitch Env|A Attack|A Decay|A Sustain|A Release|Volume|A Level|Filter"))' ${file}`;

    expect(
      evaluateSpillFileShellPermission(
        liveShellRequest(file, fullCommandText, [
          { identifier: "jq", fullCommandText },
        ]),
        directory,
      ),
    ).toEqual({ kind: "approve-once" });
  });

  it("reports bounded diagnostics without command text or paths", async () => {
    const { directory, file } = await fixture();
    const fullCommandText = `jq -c '.pads[] | {note, name}' '${file}'`;
    const evaluation = evaluateSpillFileShellPolicy(
      liveShellRequest(file, fullCommandText, [
        { identifier: "jq", fullCommandText },
      ]),
      directory,
    );

    expect(evaluation).toMatchObject({
      result: { kind: "approve-once" },
      diagnostics: {
        stage: "approved",
        commandIdentifiers: ["jq"],
        commandCount: 1,
        segmentCount: 1,
        fileOperandCount: 1,
        sdkCommandSummaryDisagrees: true,
        sdkPathSummaryDisagrees: true,
      },
    });
    expect(evaluation.diagnostics?.durationMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(evaluation.diagnostics)).not.toContain(file);
    expect(JSON.stringify(evaluation.diagnostics)).not.toContain(".pads");
  });

  it("approves wc when the SDK advisory read-only classification is false", async () => {
    const { directory, file } = await fixture();
    const fullCommandText = `wc -l '${file}'`;

    expect(
      evaluateSpillFileShellPermission(
        liveShellRequest(file, fullCommandText, [
          { identifier: "wc", fullCommandText },
        ]),
        directory,
      ),
    ).toEqual({ kind: "approve-once" });
  });

  it("approves a read-only grep and head pipeline", async () => {
    const { directory, file } = await fixture();
    const grepCommand = `grep -o '"name":"[^"]*Osc A[^"]*"[^}]*' ${file}`;
    const fullCommandText = `${grepCommand} | head -50`;

    expect(
      evaluateSpillFileShellPermission(
        liveShellRequest(file, fullCommandText, [
          {
            identifier: "grep",
            fullCommandText: grepCommand,
          },
          { identifier: "head", fullCommandText: "head -50" },
        ]),
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
      name: "unapproved executable",
      overrides: {
        commands: [{ identifier: "python3 result.txt", readOnly: false }],
        commandSegments: [
          { identifier: "python3", fullCommandText: "python3 result.txt" },
        ],
        fullCommandText: "python3 result.txt",
      },
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
    {
      name: "tail from a starting line",
      overrides: {
        commands: [{ identifier: "tail -n +20 result.txt", readOnly: false }],
        fullCommandText: "tail -n +20 result.txt",
        commandSegments: [
          {
            identifier: "tail",
            fullCommandText: "tail -n +20 result.txt",
          },
        ],
      },
    },
    {
      name: "pipeline whose first command has no spill operand",
      overrides: {
        commands: [
          {
            identifier: "head -50 | jq -c '.' result.txt",
            readOnly: false,
          },
        ],
        fullCommandText: "head -50 | jq -c '.' result.txt",
        commandSegments: [
          { identifier: "head", fullCommandText: "head -50" },
          { identifier: "jq", fullCommandText: "jq -c '.' result.txt" },
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

  it("explains why tail from a starting line is unbounded", async () => {
    const { directory, file } = await fixture();
    const fullCommandText = `tail -n +32 '${file}'`;
    const evaluation = evaluateSpillFileShellPolicy(
      liveShellRequest(file, fullCommandText, [
        { identifier: "tail", fullCommandText },
      ]),
      directory,
    );

    expect(evaluation.diagnostics?.stage).toBe("unbounded_output");
    expect(evaluation.result?.kind).toBe("reject");
    if (evaluation.result?.kind !== "reject") {
      throw new Error("Expected a rejected shell request");
    }
    expect(evaluation.result.feedback).toContain("reads through end-of-file");
    expect(evaluation.result.feedback).toContain("jq");
  });

  it("rejects missing parsed command segments", async () => {
    const { directory, file } = await fixture();
    const request = shellRequest(file);
    delete request.commandSegments;

    expect(evaluateSpillFileShellPermission(request, directory)).toMatchObject({
      kind: "reject",
    });
  });

  it("rejects a valid spill file mixed with an outside file", async () => {
    const { directory, file } = await fixture();
    const fullCommandText = `jq -c '.' '${file}' /etc/hosts`;

    expect(
      evaluateSpillFileShellPermission(
        liveShellRequest(file, fullCommandText, [
          { identifier: "jq", fullCommandText },
        ]),
        directory,
      ),
    ).toMatchObject({ kind: "reject" });
  });

  it("rejects a repository-relative file operand", async () => {
    const { directory, file } = await fixture();
    const fullCommandText = `wc -l '${file}' package.json`;

    expect(
      evaluateSpillFileShellPermission(
        liveShellRequest(
          file,
          fullCommandText,
          [{ identifier: "wc", fullCommandText }],
          process.cwd(),
        ),
        directory,
      ),
    ).toMatchObject({ kind: "reject" });
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
