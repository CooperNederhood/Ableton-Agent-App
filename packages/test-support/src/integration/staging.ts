import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { freezeAmxd } from "@ableton-agent/shared/m4l-devices";
import { bindFixtureProject } from "./project-binding.js";
import type {
  DependencyInventory,
  FixtureManifest,
  FixtureResource,
  StagedFixture,
} from "./contracts.js";
import {
  identifier,
  isFixtureMediaTarget,
  immutableCopy,
  requireCondition,
  validateFixture,
  validateDependencyInventory,
} from "./validation.js";

/** Canonical bundle identity excludes machine-specific roots, but includes every mounted file. */
export function dependencyInventoryHashes(
  inventory: DependencyInventory,
): Readonly<Record<string, string>> {
  validateDependencyInventory(inventory);
  const hashes: Record<string, string> = {};
  const compareTargets = (
    left: { target: string },
    right: { target: string },
  ) => (left.target < right.target ? -1 : left.target > right.target ? 1 : 0);
  for (const id of [
    ...new Set(inventory.resources.map((entry) => entry.id)),
  ].sort()) {
    const resources = inventory.resources
      .filter((entry) => entry.id === id)
      .map(({ path, target, sha256, bytes }) => ({
        path,
        target,
        sha256,
        bytes,
      }))
      .sort(compareTargets);
    const generatedConfigurations = (inventory.generatedConfigurations ?? [])
      .filter((entry) => entry.id === id)
      .map(({ target, sha256, bytes }) => ({ target, sha256, bytes }))
      .sort(compareTargets);
    hashes[id] = createHash("sha256")
      .update(
        JSON.stringify({
          schemaVersion: 1,
          id,
          resources,
          generatedConfigurations,
          ...(inventory.frozenDevices === undefined
            ? {}
            : {
                frozenDevices: inventory.frozenDevices.filter(
                  (entry) => entry.id === id,
                ),
              }),
          ...(inventory.preparedProject === undefined
            ? {}
            : { preparedProject: inventory.preparedProject }),
        }),
      )
      .digest("hex");
  }
  return Object.freeze(hashes);
}

export interface StageFixtureOptions {
  readonly fixture: FixtureManifest;
  readonly catalogRoot: string;
  /** Caller resolves this owned artifact directory through the application storage contract. */
  readonly workingRoot: string;
  readonly runId: string;
  readonly allowSynthetic?: boolean;
  readonly signal?: AbortSignal;
}
export async function verifyStagedFixture(
  staged: StagedFixture,
  fixture: FixtureManifest,
  signal?: AbortSignal,
): Promise<void> {
  requireCondition(
    staged.resources.length === fixture.resources.length &&
      fixture.resources.every((expected) =>
        staged.resources.some(
          (actual) =>
            actual.path === expected.path &&
            actual.target === expected.target &&
            actual.sha256 === expected.sha256 &&
            actual.bytes === expected.bytes,
        ),
      ),
    "Staged fixture inventory does not match admitted manifest",
  );
  for (const resource of fixture.resources)
    await readVerified(
      staged.workingDirectory,
      { ...resource, path: resource.target },
      signal,
    );
}
export async function verifyDependencyInventory(
  staged: StagedFixture,
  fixture: FixtureManifest,
  inventory: DependencyInventory,
  signal?: AbortSignal,
): Promise<void> {
  validateDependencyInventory(inventory, fixture);
  requireCondition(
    isAbsolute(inventory.candidateRoot),
    "Candidate root must be absolute",
  );
  const candidateRoot = resolve(inventory.candidateRoot);
  requireCondition(
    !inside(candidateRoot, staged.workingDirectory) &&
      !inside(staged.workingDirectory, candidateRoot),
    "Candidate and working ownership overlap",
  );
  for (const resource of inventory.resources) {
    await readVerified(candidateRoot, resource, signal);
    await readVerified(
      staged.workingDirectory,
      { ...resource, path: resource.target },
      signal,
    );
  }
  for (const configuration of inventory.generatedConfigurations ?? [])
    await readVerified(
      staged.workingDirectory,
      { ...configuration, path: configuration.target },
      signal,
    );
  for (const frozen of inventory.frozenDevices ?? []) {
    const source = inventory.resources.find(
      (entry) => entry.target === frozen.sourceTarget && entry.id === frozen.id,
    )!;
    const payload = await readVerified(candidateRoot, source, signal);
    const resources = new Map<string, Uint8Array>();
    for (const entry of inventory.resources.filter(
      (entry) =>
        entry.id === frozen.id &&
        entry.target !== frozen.sourceTarget &&
        !entry.path.endsWith("/audio-listener-manifest.json"),
    )) {
      const name = entry.path.split("/").at(-1)!;
      requireCondition(!resources.has(name), "Duplicate frozen resource");
      resources.set(
        name,
        (await readVerified(candidateRoot, entry, signal)).bytes,
      );
    }
    for (const entry of inventory.generatedConfigurations?.filter(
      (entry) => entry.id === frozen.id,
    ) ?? []) {
      const name = entry.target.split("/").at(-1)!;
      requireCondition(!resources.has(name), "Duplicate frozen resource");
      resources.set(
        name,
        (
          await readVerified(
            staged.workingDirectory,
            { ...entry, path: entry.target },
            signal,
          )
        ).bytes,
      );
    }
    const expected = freezeAmxd(
      payload.bytes,
      source.path.split("/").at(-1)!,
      resources,
    );
    const actual = await readVerified(
      staged.workingDirectory,
      { ...frozen, path: frozen.target },
      signal,
    );
    requireCondition(
      expected.equals(actual.bytes),
      "Frozen dependency does not derive from verified candidate",
    );
  }
  if (inventory.preparedProject) {
    requireCondition(
      fixture.listenerBindings?.length,
      "Prepared project has no reviewed bindings",
    );
    const source = fixture.resources.find(
      (entry) => entry.target === "project.als",
    )!;
    const original = await readVerified(
      staged.workingDirectory,
      { ...source, path: source.target },
      signal,
    );
    const expected = bindFixtureProject(
      original.bytes,
      fixture.listenerBindings,
      inventory.frozenDevices ?? [],
      staged.workingDirectory,
    );
    const actual = await readVerified(
      staged.workingDirectory,
      { ...inventory.preparedProject, path: inventory.preparedProject.target },
      signal,
    );
    requireCondition(
      expected.equals(actual.bytes),
      "Prepared project changed beyond declared listener bindings",
    );
  } else
    requireCondition(
      !fixture.listenerBindings?.length,
      "Declared listener bindings require prepared project",
    );
}
export async function verifyStagedMedia(
  staged: StagedFixture,
  loadedMediaPath: string,
  mediaSha256: string,
  signal?: AbortSignal,
): Promise<string> {
  requireCondition(
    isAbsolute(loadedMediaPath),
    "Loaded media path must be absolute",
  );
  const resource = staged.resources.find(
    (entry) =>
      isFixtureMediaTarget(entry.target) &&
      entry.sha256 === mediaSha256 &&
      resolve(staged.workingDirectory, entry.target) ===
        resolve(loadedMediaPath),
  );
  requireCondition(resource, "Loaded media is outside owned staged inventory");
  const verified = await readVerified(
    staged.workingDirectory,
    { ...resource, path: resource.target },
    signal,
  );
  return verified.sha256;
}
function abort(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}
function inside(root: string, candidate: string): boolean {
  const suffix = relative(root, candidate);
  return (
    suffix === "" ||
    (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`))
  );
}
async function noSymlinks(path: string): Promise<void> {
  const absolute = resolve(path);
  const parts = absolute.split(sep).filter(Boolean);
  let current: string = sep;
  for (const part of parts) {
    current = join(current, part);
    const stat = await lstat(current);
    requireCondition(!stat.isSymbolicLink(), "Symlink paths are forbidden");
  }
}
async function readVerified(
  root: string,
  resource: FixtureResource,
  signal?: AbortSignal,
): Promise<{ bytes: Buffer; sha256: string }> {
  abort(signal);
  const path = resolve(root, resource.path);
  requireCondition(inside(root, path), "Resource escapes source ownership");
  await noSymlinks(path);
  requireCondition(
    inside(root, await realpath(path)),
    "Resource real path escapes source ownership",
  );
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    requireCondition(
      before.isFile() && before.nlink === 1 && before.size === resource.bytes,
      "Invalid source file size, type or ownership",
    );
    const buffer = Buffer.alloc(resource.bytes);
    let offset = 0;
    while (offset < buffer.length) {
      abort(signal);
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      requireCondition(bytesRead > 0, "Source changed while reading");
      offset += bytesRead;
    }
    const after = await handle.stat();
    requireCondition(
      before.size === after.size && before.mtimeMs === after.mtimeMs,
      "Source changed while reading",
    );
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    requireCondition(sha256 === resource.sha256, "Source SHA-256 mismatch");
    return { bytes: buffer, sha256 };
  } finally {
    await handle.close();
  }
}
export async function stageFixture(
  options: StageFixtureOptions,
): Promise<StagedFixture> {
  const { signal } = options;
  const fixture = immutableCopy(options.fixture);
  validateFixture(fixture);
  identifier(options.runId);
  abort(signal);
  requireCondition(
    fixture.qualification !== "synthetic-only" ||
      options.allowSynthetic === true,
    "Synthetic fixture is not playable",
  );
  const catalogRoot = resolve(options.catalogRoot);
  const workingRoot = resolve(options.workingRoot);
  await noSymlinks(catalogRoot);
  await noSymlinks(workingRoot);
  requireCondition(
    (await lstat(catalogRoot)).isDirectory() &&
      (await lstat(workingRoot)).isDirectory(),
    "Roots must be directories",
  );
  requireCondition(
    !inside(catalogRoot, workingRoot) && !inside(workingRoot, catalogRoot),
    "Source and working ownership overlap",
  );
  // Admission reads the complete bounded inventory before creating any output.
  const inventory = [];
  for (const resource of fixture.resources)
    inventory.push({
      resource,
      bytes: (await readVerified(catalogRoot, resource, signal)).bytes,
    });
  const opaqueName = createHash("sha256")
    .update(options.runId)
    .digest("hex")
    .slice(0, 32);
  const workingDirectory = join(workingRoot, `case-${opaqueName}`);
  await mkdir(workingDirectory, { mode: 0o700 });
  try {
    abort(signal);
    // Live resolves type-3 paths against the nearest recognized Project root.
    await mkdir(join(workingDirectory, "Ableton Project Info"), {
      mode: 0o700,
    });
    for (const { resource, bytes } of inventory) {
      abort(signal);
      const target = join(workingDirectory, resource.target);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await noSymlinks(dirname(target));
      const handle = await open(
        target,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.writeFile(bytes);
      } finally {
        await handle.close();
      }
    }
    abort(signal);
  } catch (error) {
    await rm(workingDirectory, { recursive: true, force: true });
    throw error;
  }
  return Object.freeze({
    projectPath: join(workingDirectory, "project.als"),
    workingDirectory,
    resources: Object.freeze(
      fixture.resources.map((resource) => Object.freeze({ ...resource })),
    ),
    async verifySourceUnchanged() {
      for (const resource of fixture.resources)
        await readVerified(catalogRoot, resource);
    },
  });
}
