import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PermissionRequest } from "@github/copilot-sdk";
import { afterEach, describe, expect, it } from "vitest";

import type { ArtifactAuthoringContext } from "./artifact-authoring.js";
import {
  ArtifactWorkspace,
  evaluateArtifactWorkspacePermission,
  type ArtifactWorkspaceAccess,
} from "./artifact-workspace.js";

const topic = (name: string, description: string, body = "Body.") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;

const mixing = topic("mixing", "Mix habits");
const skill = "---\nname: mix-review\ndescription: Review a mix\n---\n\nOld.\n";

const context: ArtifactAuthoringContext = {
  memory: [
    {
      scope: "profile",
      available: true,
      topics: [
        {
          name: "mixing",
          description: "Mix habits",
          content: mixing,
          fingerprint: "fp",
        },
      ],
    },
    { scope: "session", available: true, topics: [] },
    {
      scope: "project",
      available: false,
      unavailableReason: "none",
      topics: [],
    },
  ],
  skillScopes: [{ scope: "profile", available: true }],
  skills: [
    {
      name: "mix-review",
      description: "Review a mix",
      origin: "profile",
      content: skill,
      fingerprint: "skill-fp",
    },
  ],
};

const roots: string[] = [];

async function seeded(): Promise<ArtifactWorkspace> {
  const parent = await mkdtemp(join(tmpdir(), "ableton-artifact-workspace-"));
  roots.push(parent);
  const workspace = ArtifactWorkspace.forSession(parent, "production-1");
  await workspace.seed(context);
  return workspace;
}

function access(
  workspace: ArtifactWorkspace,
  draft?: Partial<NonNullable<ArtifactWorkspaceAccess["draft"]>>,
  extraReadRoots: string[] = [],
): ArtifactWorkspaceAccess {
  return {
    root: workspace.root,
    extraReadRoots,
    ...(draft === undefined
      ? {}
      : {
          draft: {
            kind: "memory",
            reviewPending: false,
            writableScopes: ["profile", "session"],
            ...draft,
          },
        }),
  };
}

const read = (path: string): PermissionRequest =>
  ({ kind: "read", toolCallId: "r", intention: "Read", path }) as never;
const write = (fileName: string): PermissionRequest =>
  ({
    kind: "write",
    toolCallId: "w",
    intention: "Write",
    fileName,
    diff: "",
  }) as never;

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("artifact workspace", () => {
  it("seeds available scopes with topics, generated indexes, and skills", async () => {
    const workspace = await seeded();
    await expect(
      readFile(join(workspace.root, "memory/profile/mixing.md"), "utf8"),
    ).resolves.toBe(mixing);
    await expect(
      readFile(join(workspace.root, "memory/profile/INDEX.md"), "utf8"),
    ).resolves.toContain("mixing | Mix habits | ./mixing.md");
    await expect(
      readFile(join(workspace.root, "skills/mix-review/SKILL.md"), "utf8"),
    ).resolves.toBe(skill);
    await expect(
      readFile(join(workspace.root, "memory/session/INDEX.md"), "utf8"),
    ).resolves.toBeDefined();
    await expect(
      readFile(join(workspace.root, "memory/project/INDEX.md"), "utf8"),
    ).rejects.toThrow();
    await expect(workspace.changes()).resolves.toEqual(new Map());
  });

  it("reports added, modified, removed, and emptied files but not indexes", async () => {
    const workspace = await seeded();
    const added = topic("genres", "Genres");
    await writeFile(join(workspace.root, "memory/session/genres.md"), added);
    await writeFile(join(workspace.root, "memory/session/blank.md"), "  \n");
    await writeFile(join(workspace.root, "memory/profile/mixing.md"), "\n");
    await writeFile(join(workspace.root, "memory/profile/INDEX.md"), "edited");
    await writeFile(join(workspace.root, ".DS_Store"), "x");
    await writeFile(join(workspace.root, "skills/mix-review/SKILL.md"), "New");
    await expect(workspace.changes()).resolves.toEqual(
      new Map<string, string | null>([
        ["memory/session/genres.md", added],
        ["memory/profile/mixing.md", null],
        ["skills/mix-review/SKILL.md", "New"],
      ]),
    );
    await rm(join(workspace.root, "skills/mix-review/SKILL.md"));
    expect((await workspace.changes()).get("skills/mix-review/SKILL.md")).toBe(
      null,
    );
  });

  it("reseeding discards edits", async () => {
    const workspace = await seeded();
    await writeFile(join(workspace.root, "memory/session/x.md"), "x");
    await workspace.seed(context);
    await expect(workspace.changes()).resolves.toEqual(new Map());
  });

  it("rejects symbolic links and oversized files when collecting changes", async () => {
    const workspace = await seeded();
    await symlink(
      join(workspace.root, "memory/profile/mixing.md"),
      join(workspace.root, "memory/session/link.md"),
    );
    await expect(workspace.changes()).rejects.toThrow(/symbolic link/);
    await rm(join(workspace.root, "memory/session/link.md"));
    await writeFile(
      join(workspace.root, "memory/session/big.md"),
      "x".repeat(512 * 1024 + 1),
    );
    await expect(workspace.changes()).rejects.toThrow(/exceeds/);
  });

  it("removes its folder", async () => {
    const workspace = await seeded();
    await workspace.remove();
    await expect(readFile(join(workspace.root, "memory"))).rejects.toThrow();
  });
});

describe("artifact workspace permission", () => {
  it("leaves non-file requests to the caller", async () => {
    const workspace = await seeded();
    expect(
      evaluateArtifactWorkspacePermission(
        { kind: "shell" } as never,
        access(workspace),
      ),
    ).toEqual({ result: undefined });
  });

  it("allows reads inside the workspace and extra read roots only", async () => {
    const workspace = await seeded();
    const spill = await mkdtemp(join(tmpdir(), "ableton-artifact-spill-"));
    roots.push(spill);
    const policy = access(workspace, undefined, [spill]);
    expect(
      evaluateArtifactWorkspacePermission(
        read(join(workspace.root, "memory/profile/mixing.md")),
        policy,
      ),
    ).toMatchObject({
      result: { kind: "approve-once" },
      diagnostics: {
        stage: "approved",
        access: "read",
        workspacePath: "memory/profile/mixing.md",
      },
    });
    expect(
      evaluateArtifactWorkspacePermission(read(join(spill, "out.txt")), policy),
    ).toMatchObject({ result: { kind: "approve-once" } });
    expect(
      evaluateArtifactWorkspacePermission(read("/etc/hosts"), policy),
    ).toMatchObject({
      result: { kind: "reject" },
      diagnostics: { stage: "outside_workspace" },
    });
    expect(
      evaluateArtifactWorkspacePermission(
        read(join(workspace.root, "../other")),
        policy,
      ),
    ).toMatchObject({ diagnostics: { stage: "outside_workspace" } });
  });

  it.each([
    [undefined, "memory/session/a.md", "no_draft"],
    [{ reviewPending: true }, "memory/session/a.md", "review_pending"],
    [{}, "memory/session/a.txt", "invalid_path"],
    [{}, "skills/new-skill/SKILL.md", "wrong_kind"],
    [{}, "memory/session/INDEX.md", "generated_index"],
    [{ writableScopes: ["session"] }, "memory/profile/a.md", "scope_locked"],
    [{}, "memory/session/a.md", "approved"],
    [{ kind: "skill" }, "skills/new-skill/SKILL.md", "approved"],
  ] as const)("write with draft %j to %s is %s", async (draft, path, stage) => {
    const workspace = await seeded();
    const evaluation = evaluateArtifactWorkspacePermission(
      write(join(workspace.root, path)),
      access(workspace, draft),
    );
    expect(evaluation.diagnostics).toMatchObject({
      stage,
      access: "write",
      workspacePath: path,
    });
    expect(evaluation.result?.kind).toBe(
      stage === "approved" ? "approve-once" : "reject",
    );
  });

  it("rejects writes outside the workspace and through symbolic links", async () => {
    const workspace = await seeded();
    const outside = await mkdtemp(join(tmpdir(), "ableton-artifact-outside-"));
    roots.push(outside);
    await mkdir(join(outside, "x"));
    await symlink(
      join(outside, "x"),
      join(workspace.root, "memory/session/escape"),
    );
    expect(
      evaluateArtifactWorkspacePermission(
        write(join(outside, "a.md")),
        access(workspace, {}),
      ),
    ).toMatchObject({ diagnostics: { stage: "outside_workspace" } });
    expect(
      evaluateArtifactWorkspacePermission(
        write(join(workspace.root, "memory/session/escape/a.md")),
        access(workspace, {}),
      ),
    ).toMatchObject({ result: { kind: "reject" } });
    expect(
      evaluateArtifactWorkspacePermission(
        write(join(workspace.root, "memory/session/escape")),
        access(workspace, {}),
      ),
    ).toMatchObject({ diagnostics: { stage: "symbolic_link" } });
  });

  it("rejects everything when the workspace has not been created", async () => {
    const parent = await mkdtemp(join(tmpdir(), "ableton-artifact-missing-"));
    roots.push(parent);
    const workspace = ArtifactWorkspace.forSession(parent, "missing");
    expect(
      evaluateArtifactWorkspacePermission(
        read(join(workspace.root, "memory")),
        access(workspace),
      ),
    ).toMatchObject({
      result: { kind: "reject" },
      diagnostics: { stage: "workspace_unavailable" },
    });
  });
});
