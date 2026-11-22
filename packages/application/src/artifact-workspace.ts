import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import {
  formatMemoryIndex,
  MEMORY_INDEX_FILE_NAME,
} from "@ableton-agent/agent-config";
import type {
  AgentArtifactKind,
  AgentArtifactScope,
} from "@ableton-agent/shared";
import type {
  PermissionRequest,
  PermissionRequestResult,
} from "@github/copilot-sdk";

import {
  MAX_ARTIFACT_FILE_CONTENT_LENGTH,
  parseArtifactPath,
  type ArtifactAuthoringContext,
} from "./artifact-authoring.js";

const MAX_WORKSPACE_FILES = 256;
const MAX_WORKSPACE_DEPTH = 4;
const IGNORED_FILE_NAMES = new Set([".DS_Store"]);

function isWithin(parent: string, child: string): boolean {
  const candidate = relative(parent, child);
  return (
    candidate === "" || (!candidate.startsWith("..") && !isAbsolute(candidate))
  );
}

function isGeneratedIndex(path: string): boolean {
  return (
    path.startsWith("memory/") && basename(path) === MEMORY_INDEX_FILE_NAME
  );
}

/**
 * A plain folder holding copies of the session's memory topics and skills, so
 * the SDK's own `view`, `glob`, `grep`, `edit`, and `create` tools can work on
 * them. The real stores are only changed by publishing a reviewed draft.
 */
export class ArtifactWorkspace {
  #baseline = new Map<string, string>();

  constructor(readonly root: string) {
    if (!isAbsolute(root)) {
      throw new Error("Artifact workspace directory must be absolute");
    }
  }

  /** One stable, path-safe folder per app session. */
  static forSession(parent: string, sessionKey: string): ArtifactWorkspace {
    return new ArtifactWorkspace(
      join(
        parent,
        createHash("sha256").update(sessionKey).digest("hex").slice(0, 32),
      ),
    );
  }

  /** Replaces the folder contents with a fresh copy of `context`. */
  async seed(context: ArtifactAuthoringContext): Promise<number> {
    const files = new Map<string, string>();
    const directories = ["skills"];
    for (const scope of context.memory) {
      if (!scope.available) continue;
      directories.push(`memory/${scope.scope}`);
      for (const topic of scope.topics) {
        files.set(`memory/${scope.scope}/${topic.name}.md`, topic.content);
      }
      files.set(
        `memory/${scope.scope}/${MEMORY_INDEX_FILE_NAME}`,
        formatMemoryIndex(scope.topics),
      );
    }
    for (const skill of context.skills) {
      files.set(`skills/${skill.name}/SKILL.md`, skill.content);
    }
    await mkdir(dirname(this.root), { recursive: true, mode: 0o700 });
    const stage = `${this.root}.stage-${randomUUID()}`;
    await mkdir(stage, { mode: 0o700 });
    try {
      for (const directory of directories) {
        await mkdir(join(stage, directory), { recursive: true, mode: 0o700 });
      }
      for (const [path, content] of files) {
        const target = join(stage, path);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, content, { mode: 0o600, flag: "wx" });
      }
      await rm(this.root, { recursive: true, force: true });
      await rename(stage, this.root);
    } catch (error) {
      await rm(stage, { recursive: true, force: true });
      throw error;
    }
    this.#baseline = files;
    return files.size;
  }

  /**
   * Edits since the last seed, as artifact path to new content. `null` means
   * the file was removed or emptied. Generated `INDEX.md` files are ignored.
   */
  async changes(): Promise<Map<string, string | null>> {
    const current = new Map<string, string>();
    await this.#collect(this.root, "", current, 0);
    const changes = new Map<string, string | null>();
    for (const [path, content] of current) {
      if (isGeneratedIndex(path) || this.#baseline.get(path) === content) {
        continue;
      }
      const empty = content.trim().length === 0;
      if (empty && !this.#baseline.has(path)) continue;
      changes.set(path, empty ? null : content);
    }
    for (const path of this.#baseline.keys()) {
      if (!current.has(path) && !isGeneratedIndex(path)) {
        changes.set(path, null);
      }
    }
    return changes;
  }

  async #collect(
    directory: string,
    prefix: string,
    files: Map<string, string>,
    depth: number,
  ): Promise<void> {
    if (depth > MAX_WORKSPACE_DEPTH) {
      throw new Error(`'${prefix}' is nested too deeply`);
    }
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (IGNORED_FILE_NAMES.has(entry.name)) continue;
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const absolute = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`'${path}' is a symbolic link; use regular files`);
      }
      if (entry.isDirectory()) {
        await this.#collect(absolute, path, files, depth + 1);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`'${path}' is not a regular file`);
      }
      if (files.size >= MAX_WORKSPACE_FILES) {
        throw new Error(
          `The workspace holds more than ${MAX_WORKSPACE_FILES} files`,
        );
      }
      const details = await lstat(absolute);
      if (details.size > MAX_ARTIFACT_FILE_CONTENT_LENGTH) {
        throw new Error(
          `'${path}' exceeds ${MAX_ARTIFACT_FILE_CONTENT_LENGTH} bytes`,
        );
      }
      files.set(path, await readFile(absolute, "utf8"));
    }
  }

  async remove(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }
}

/** What the open draft, if any, allows the agent to change. */
export interface ArtifactWorkspaceAccess {
  readonly root: string;
  /** Other folders SDK file tools may read, such as tool-output spill files. */
  readonly extraReadRoots?: readonly string[];
  readonly draft?: {
    readonly kind: AgentArtifactKind;
    readonly reviewPending: boolean;
    /** Memory scopes the draft may write; ignored for skill drafts. */
    readonly writableScopes: readonly AgentArtifactScope[];
  };
}

export type ArtifactWorkspacePolicyStage =
  | "approved"
  | "outside_workspace"
  | "symbolic_link"
  | "workspace_unavailable"
  | "no_draft"
  | "review_pending"
  | "invalid_path"
  | "wrong_kind"
  | "generated_index"
  | "scope_locked";

export interface ArtifactWorkspacePolicyDiagnostics {
  readonly stage: ArtifactWorkspacePolicyStage;
  readonly access: "read" | "write" | "delete";
  /** Path relative to the workspace when it resolved inside it. */
  readonly workspacePath?: string;
  readonly durationMs: number;
}

export interface ArtifactWorkspacePolicyEvaluation {
  readonly result: PermissionRequestResult | undefined;
  readonly diagnostics?: ArtifactWorkspacePolicyDiagnostics;
}

type Located =
  | { readonly root: string; readonly path: string }
  | { readonly error: "outside_workspace" | "symbolic_link" };

type Canonical =
  { readonly path: string } | { readonly error: "symbolic_link" };

function canonicalize(path: string): Canonical | undefined {
  if (!isAbsolute(path)) return undefined;
  let existing = resolve(path);
  const rest: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return undefined;
    rest.unshift(basename(existing));
    existing = parent;
  }
  try {
    if (rest.length === 0 && lstatSync(existing).isSymbolicLink()) {
      return { error: "symbolic_link" };
    }
    return { path: join(realpathSync(existing), ...rest) };
  } catch {
    return undefined;
  }
}

function locate(path: string, roots: readonly string[]): Located {
  const canonical = canonicalize(path);
  if (canonical === undefined) return { error: "outside_workspace" };
  if ("error" in canonical) return canonical;
  for (const root of roots) {
    if (isWithin(root, canonical.path)) {
      return {
        root,
        path: relative(root, canonical.path).split(sep).join("/"),
      };
    }
  }
  return { error: "outside_workspace" };
}

/** Why `path` (relative to the workspace) may not be changed, if anything. */
export function artifactWorkspaceWriteError(
  access: ArtifactWorkspaceAccess,
  path: string,
  change: "write" | "delete",
): { stage: ArtifactWorkspacePolicyStage; feedback: string } | undefined {
  const draft = access.draft;
  if (draft === undefined) {
    return {
      stage: "no_draft",
      feedback:
        "Memory and skills are read-only until the update-memory or learn-skill skill opens a draft.",
    };
  }
  if (draft.reviewPending) {
    return {
      stage: "review_pending",
      feedback: "The draft is waiting for the user's review.",
    };
  }
  let parsed;
  try {
    parsed = parseArtifactPath(path);
  } catch (error) {
    return {
      stage: "invalid_path",
      feedback: error instanceof Error ? error.message : String(error),
    };
  }
  if (parsed.kind !== draft.kind) {
    return {
      stage: "wrong_kind",
      feedback: `This is a ${draft.kind} draft; it cannot change ${parsed.kind} files.`,
    };
  }
  if (parsed.kind === "memory") {
    if (parsed.topic === "INDEX") {
      return {
        stage: "generated_index",
        feedback:
          "INDEX.md is generated from each topic's frontmatter description; edit the topic instead.",
      };
    }
    if (!draft.writableScopes.includes(parsed.scope)) {
      return {
        stage: "scope_locked",
        feedback: `This draft cannot write ${parsed.scope} memory. Writable scopes: ${draft.writableScopes.join(", ") || "none"}.`,
      };
    }
  } else if (change === "delete") {
    return {
      stage: "wrong_kind",
      feedback: "Skills cannot be deleted in a draft.",
    };
  }
  return undefined;
}

/**
 * Confines SDK `read` and `write` permission requests to the artifact
 * workspace. Reads are always allowed inside it; writes need an open draft of
 * the matching kind. Other request kinds are left to the caller.
 */
export function evaluateArtifactWorkspacePermission(
  request: PermissionRequest,
  access: ArtifactWorkspaceAccess,
): ArtifactWorkspacePolicyEvaluation {
  if (request.kind !== "read" && request.kind !== "write") {
    return { result: undefined };
  }
  const startedAt = performance.now();
  const kind = request.kind;
  const finish = (
    stage: ArtifactWorkspacePolicyStage,
    workspacePath?: string,
    feedback?: string,
  ): ArtifactWorkspacePolicyEvaluation => ({
    result:
      stage === "approved"
        ? { kind: "approve-once" }
        : { kind: "reject", feedback: feedback ?? "Not allowed." },
    diagnostics: {
      stage,
      access: kind,
      ...(workspacePath === undefined ? {} : { workspacePath }),
      durationMs: Math.max(0, performance.now() - startedAt),
    },
  });
  let workspaceRoot: string;
  try {
    workspaceRoot = realpathSync(access.root);
  } catch {
    return finish(
      "workspace_unavailable",
      undefined,
      "The memory and skills workspace is unavailable.",
    );
  }
  const outsideFeedback = `File access is limited to the memory and skills workspace at ${workspaceRoot}.`;
  if (kind === "read") {
    const roots = [workspaceRoot];
    for (const extra of access.extraReadRoots ?? []) {
      try {
        roots.push(realpathSync(extra));
      } catch {
        // An absent optional root simply cannot be read.
      }
    }
    const located = locate(request.path, roots);
    if ("error" in located) {
      return finish(located.error, undefined, outsideFeedback);
    }
    return finish(
      "approved",
      located.root === workspaceRoot ? located.path : undefined,
    );
  }
  const located = locate(request.fileName, [workspaceRoot]);
  if ("error" in located) {
    return finish(located.error, undefined, outsideFeedback);
  }
  const error = artifactWorkspaceWriteError(access, located.path, "write");
  if (error !== undefined) {
    return finish(error.stage, located.path, error.feedback);
  }
  return finish("approved", located.path);
}
