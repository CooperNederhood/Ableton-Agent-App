import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, opendir, readlink, realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { promisify } from "node:util";
import { sanitizePersistedText } from "../../packages/observability/src/sanitizer.js";

const execute = promisify(execFile);

export interface AcceptanceIdentityLimits {
  readonly entries: number;
  readonly fileBytes: number;
  readonly totalBytes: number;
  readonly depth: number;
}

export const ACCEPTANCE_IDENTITY_LIMITS: AcceptanceIdentityLimits =
  Object.freeze({
    entries: 100_000,
    fileBytes: 2 * 1024 ** 3,
    totalBytes: 8 * 1024 ** 3,
    depth: 64,
  });

export interface IdentityEntry {
  readonly path: string;
  readonly kind: "file" | "directory" | "symlink";
  readonly mode: number;
  readonly bytes?: number;
  readonly sha256?: string;
  readonly target?: string;
}

export interface PackagedCandidateIdentity {
  readonly schemaVersion: 1;
  readonly bundlePath: string;
  readonly executablePath: string;
  readonly sha256: string;
  readonly appAsarSha256: string;
  readonly inventory: readonly IdentityEntry[];
}

export interface AcceptanceSourceIdentity {
  readonly schemaVersion: 1;
  readonly root: string;
  readonly revision: string;
  readonly dirty: boolean;
  readonly statusSha256: string;
  readonly lockfile: IdentityEntry;
  readonly sha256: string;
  readonly inventory: readonly IdentityEntry[];
}

export interface AcceptanceInputsIdentity {
  readonly candidate: PackagedCandidateIdentity;
  readonly source: AcceptanceSourceIdentity;
  readonly sha256: string;
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function display(value: string): string {
  return sanitizePersistedText(value).slice(0, 4096);
}

function contained(root: string, path: string): boolean {
  const rel = relative(root, path);
  return (
    rel === "" ||
    (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))
  );
}

function safePath(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4096 ||
    isAbsolute(value) ||
    value.includes("\\") ||
    [...value].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    value
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  )
    throw new Error("Unsafe identity input path");
}

function stamp(info: BigIntStats): string {
  return [
    info.dev,
    info.ino,
    info.mode,
    info.nlink,
    info.size,
    info.mtimeNs,
    info.ctimeNs,
  ].join(":");
}

function boundedLimits(
  overrides: Partial<AcceptanceIdentityLimits>,
): AcceptanceIdentityLimits {
  const limits = { ...ACCEPTANCE_IDENTITY_LIMITS, ...overrides };
  for (const key of Object.keys(limits) as (keyof AcceptanceIdentityLimits)[]) {
    if (
      !Number.isSafeInteger(limits[key]) ||
      limits[key] < 1 ||
      limits[key] > ACCEPTANCE_IDENTITY_LIMITS[key]
    )
      throw new Error("Invalid acceptance identity bound");
  }
  return limits;
}

class Inventory {
  readonly entries = new Map<string, IdentityEntry>();
  readonly stamps = new Map<string, string>();
  private bytes = 0;

  constructor(
    readonly root: string,
    readonly signal: AbortSignal | undefined,
    readonly limits: AcceptanceIdentityLimits,
    readonly allowLinks: boolean,
  ) {}

  async checkPath(path: string, allowLinks = this.allowLinks): Promise<void> {
    this.signal?.throwIfAborted();
    if (!contained(this.root, path))
      throw new Error("Identity input escapes its root");
    let current = this.root;
    for (const part of relative(this.root, path).split(sep).filter(Boolean)) {
      current = join(current, part);
      const info = await lstat(current, { bigint: true });
      if (info.isSymbolicLink()) {
        if (!allowLinks)
          throw new Error("Source identity symlinks are forbidden");
        if (!contained(this.root, await realpath(current)))
          throw new Error("Packaged identity symlink escapes its bundle");
      }
    }
  }

  async add(path: string): Promise<void> {
    this.signal?.throwIfAborted();
    const name = relative(this.root, path).split(sep).join("/") || ".";
    if (name !== ".") safePath(name);
    if (name.split("/").length > this.limits.depth)
      throw new Error("Identity inventory depth bound exceeded");
    if (this.entries.has(name)) return;
    if (!this.entries.has(name) && this.entries.size >= this.limits.entries)
      throw new Error("Identity inventory entry bound exceeded");
    await this.checkPath(path);
    const before = await lstat(path, { bigint: true });
    const common = { path: name, mode: Number(before.mode & 0o7777n) };
    let entry: IdentityEntry;
    if (before.isSymbolicLink()) {
      const target = await readlink(path);
      if (target.length > 4096)
        throw new Error("Identity link target exceeds bound");
      entry = { ...common, kind: "symlink", target };
    } else if (before.isDirectory()) {
      entry = { ...common, kind: "directory" };
    } else if (before.isFile()) {
      const bytes = Number(before.size);
      if (bytes > this.limits.fileBytes)
        throw new Error("Identity file byte bound exceeded");
      if (!this.entries.has(name)) this.bytes += bytes;
      if (this.bytes > this.limits.totalBytes)
        throw new Error("Identity total byte bound exceeded");
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (stamp(await file.stat({ bigint: true })) !== stamp(before))
          throw new Error("Identity input changed before reading");
        const hash = createHash("sha256");
        const buffer = Buffer.alloc(Math.min(bytes + 1, 1024 ** 2));
        let length = 0;
        while (true) {
          this.signal?.throwIfAborted();
          const { bytesRead } = await file.read(
            buffer,
            0,
            Math.min(buffer.length, bytes - length + 1),
            length,
          );
          if (!bytesRead) break;
          length += bytesRead;
          if (length > bytes)
            throw new Error("Identity input changed while reading");
          hash.update(buffer.subarray(0, bytesRead));
        }
        if (
          length !== bytes ||
          stamp(await file.stat({ bigint: true })) !== stamp(before)
        )
          throw new Error("Identity input changed while reading");
        entry = { ...common, kind: "file", bytes, sha256: hash.digest("hex") };
      } finally {
        await file.close();
      }
    } else {
      throw new Error(
        "Identity input must be a regular file, directory, or internal bundle link",
      );
    }
    if (stamp(await lstat(path, { bigint: true })) !== stamp(before))
      throw new Error("Identity input changed during inspection");
    const previous = this.entries.get(name);
    if (previous && JSON.stringify(previous) !== JSON.stringify(entry))
      throw new Error("Identity input changed between reads");
    this.entries.set(name, entry);
    this.stamps.set(name, stamp(before));
  }

  async tree(path: string): Promise<void> {
    await this.add(path);
    const name = relative(this.root, path).split(sep).join("/") || ".";
    // Links are inventory entries, never traversal edges. Framework aliases
    // therefore remain supported without duplicating bytes or following cycles.
    if (this.entries.get(name)?.kind !== "directory") return;
    const directory = await opendir(path);
    for await (const entry of directory) {
      this.signal?.throwIfAborted();
      await this.tree(join(path, entry.name));
    }
  }

  async finish(): Promise<IdentityEntry[]> {
    for (const [name, expected] of this.stamps) {
      this.signal?.throwIfAborted();
      const path = join(this.root, name);
      await this.checkPath(path);
      if (stamp(await lstat(path, { bigint: true })) !== expected)
        throw new Error("Identity input changed during inventory");
    }
    return [...this.entries.values()].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    );
  }
}

function persistedInventory(
  entries: readonly IdentityEntry[],
): IdentityEntry[] {
  return entries.map((entry) => ({
    ...entry,
    path: display(entry.path),
    ...(entry.target === undefined ? {} : { target: display(entry.target) }),
  }));
}

/** Hash every bundle byte, not just app.asar; never follow directory aliases. */
export async function inspectPackagedCandidate(
  executablePath: string,
  signal?: AbortSignal,
  bounds: Partial<AcceptanceIdentityLimits> = {},
): Promise<PackagedCandidateIdentity> {
  signal?.throwIfAborted();
  const executable = resolve(executablePath);
  const contents = dirname(dirname(executable));
  const bundle = dirname(contents);
  if (
    basename(dirname(executable)) !== "MacOS" ||
    basename(contents) !== "Contents" ||
    !basename(bundle).endsWith(".app")
  )
    throw new Error(
      "Acceptance executable must be inside a macOS .app/Contents/MacOS bundle",
    );
  if (
    (await lstat(bundle)).isSymbolicLink() ||
    (await realpath(bundle)) !== bundle
  )
    throw new Error("Packaged bundle and its ancestors must not be symlinks");
  const inventory = new Inventory(bundle, signal, boundedLimits(bounds), true);
  await inventory.checkPath(executable);
  const executableInfo = await lstat(executable);
  if (
    !executableInfo.isFile() ||
    executableInfo.size === 0 ||
    (executableInfo.mode & 0o111) === 0
  )
    throw new Error(
      "Packaged executable must be a nonempty executable regular file",
    );
  await inventory.tree(bundle);
  const entries = await inventory.finish();
  const archive = inventory.entries.get("Contents/Resources/app.asar");
  if (archive?.kind !== "file" || !archive.bytes)
    throw new Error("Packaged application archive is missing or empty");
  return {
    schemaVersion: 1,
    bundlePath: display(bundle),
    executablePath: display(executable),
    appAsarSha256: archive.sha256!,
    sha256: digest(
      JSON.stringify({
        executable: relative(bundle, executable),
        inventory: entries,
      }),
    ),
    inventory: persistedInventory(entries),
  };
}

async function git(
  root: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  try {
    const { stdout } = await execute("git", ["-C", root, ...args], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 ** 2,
      timeout: 30_000,
      ...(signal ? { signal } : {}),
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    return stdout;
  } catch (error) {
    signal?.throwIfAborted();
    throw new Error(
      `Cannot inspect acceptance source Git provenance: ${display(error instanceof Error ? error.message : String(error))}`,
    );
  }
}

/** Pins runner worktree bytes and Git provenance; the suite owns case admission. */
export async function inspectAcceptanceSource(
  root: string,
  signal?: AbortSignal,
  bounds: Partial<AcceptanceIdentityLimits> = {},
): Promise<AcceptanceSourceIdentity> {
  const sourceRoot = resolve(root);
  signal?.throwIfAborted();
  if ((await realpath(sourceRoot)) !== sourceRoot)
    throw new Error(
      "Acceptance source root and its ancestors must not be symlinks",
    );
  if (
    (await git(sourceRoot, ["rev-parse", "--show-toplevel"], signal)).trim() !==
    sourceRoot
  )
    throw new Error("Acceptance source must be the Git worktree root");
  const revision = (
    await git(sourceRoot, ["rev-parse", "--verify", "HEAD"], signal)
  ).trim();
  if (!/^[a-f0-9]{40,64}$/u.test(revision))
    throw new Error("Missing acceptance source revision");
  const status = await git(
    sourceRoot,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    signal,
  );
  const files = await git(
    sourceRoot,
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    signal,
  );
  const inventory = new Inventory(
    sourceRoot,
    signal,
    boundedLimits(bounds),
    true,
  );
  // Pin all non-ignored runner/workspace inputs, including dirty and newly added
  // helpers. The suite separately owns catalog, scenario, and fixture snapshots.
  for (const file of [...new Set(files.split("\0").filter(Boolean))].sort()) {
    safePath(file);
    if (
      file.startsWith("integration/acceptance-scenarios/") ||
      file.startsWith("integration/fixtures/")
    )
      continue;
    await inventory.add(join(sourceRoot, file));
    if (inventory.entries.get(file)?.kind === "symlink") {
      const target = await realpath(join(sourceRoot, file));
      if (!(await lstat(target)).isFile())
        throw new Error("Source identity aliases must target regular files");
      await inventory.add(target);
    } else if (inventory.entries.get(file)?.kind !== "file") {
      throw new Error("Source identity requires regular worktree files");
    }
  }
  const lockPath = "pnpm-lock.yaml";
  await inventory.add(join(sourceRoot, lockPath));
  await inventory.add(join(sourceRoot, "scripts/acceptance.mjs"));
  const entries = await inventory.finish();
  if (
    (
      await git(sourceRoot, ["rev-parse", "--verify", "HEAD"], signal)
    ).trim() !== revision ||
    (await git(
      sourceRoot,
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      signal,
    )) !== status ||
    (await git(
      sourceRoot,
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      signal,
    )) !== files
  )
    throw new Error("Acceptance source changed during inspection");
  const statusSha256 = digest(status);
  return {
    schemaVersion: 1,
    root: display(sourceRoot),
    revision,
    dirty: status.length > 0,
    statusSha256,
    lockfile: inventory.entries.get(lockPath)!,
    sha256: digest(
      JSON.stringify({ revision, statusSha256, inventory: entries }),
    ),
    inventory: persistedInventory(entries),
  };
}

export async function inspectAcceptanceInputs(options: {
  readonly root: string;
  readonly executablePath: string;
  readonly signal?: AbortSignal;
}): Promise<AcceptanceInputsIdentity> {
  const source = await inspectAcceptanceSource(options.root, options.signal);
  const candidate = await inspectPackagedCandidate(
    options.executablePath,
    options.signal,
  );
  return {
    candidate,
    source,
    sha256: digest(
      JSON.stringify({ candidate: candidate.sha256, source: source.sha256 }),
    ),
  };
}

/** Call inspection again at each ownership boundary, then compare exact digests. */
export function assertAcceptanceInputsUnchanged(
  before: AcceptanceInputsIdentity,
  after: AcceptanceInputsIdentity,
): void {
  if (
    before.source.sha256 !== after.source.sha256 ||
    before.candidate.sha256 !== after.candidate.sha256 ||
    before.sha256 !== after.sha256
  )
    throw new Error("Acceptance source or packaged candidate changed");
}
