import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { readAcceptanceProjectReferences } from "../../../../tests/electron/acceptance-project.js";
import {
  describeScenarioError,
  serializeScenarioReceipt,
  writeScenarioReceipt,
} from "../../../../scripts/lib/scenario-receipts.mjs";

interface IntakeEvent {
  name: "fixture.authoring.intake";
  stage: "started" | "progress" | "completed" | "failed" | "cancelled";
  traceId: string;
  occurredAt: string;
  durationMs: number;
}

function inside(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return (
    suffix === "" ||
    (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`))
  );
}

async function noSymlinks(path: string): Promise<void> {
  for (let current = resolve(path); ; current = dirname(current)) {
    if ((await lstat(current)).isSymbolicLink())
      throw new Error("Symlink project/output paths are not supported");
    if (dirname(current) === current) break;
  }
}

async function readBounded(path: string, signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted();
  await noSymlinks(path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size > 64 * 1024 * 1024
    )
      throw new Error("Project resource exceeds file ownership/size bounds");
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      signal.throwIfAborted();
      const read = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (read.bytesRead === 0) throw new Error("Resource changed during read");
      offset += read.bytesRead;
    }
    const after = await handle.stat();
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error("Resource changed during read");
    signal.throwIfAborted();
    return bytes;
  } finally {
    await handle.close();
  }
}

const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

export async function intakeProject(options: {
  project: string;
  output: string;
  signal?: AbortSignal;
  event?: (event: IntakeEvent) => void;
}) {
  const signal = options.signal ?? new AbortController().signal;
  const startedAt = Date.now();
  const traceId = randomUUID();
  const events: IntakeEvent[] = [];
  let copy: string | undefined;
  const emit = (stage: IntakeEvent["stage"]) => {
    const event: IntakeEvent = {
      name: "fixture.authoring.intake",
      stage,
      traceId,
      occurredAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
    };
    events.push(event);
    options.event?.(event);
  };
  emit("started");
  try {
    signal.throwIfAborted();
    const source = resolve(options.project);
    const output = resolve(options.output);
    await noSymlinks(source);
    // Output must already be an explicitly selected authoring directory.
    await noSymlinks(output);
    if (inside(source, output) || inside(output, source))
      throw new Error("Source and output ownership must not overlap");
    const sets = (await readdir(source, { withFileTypes: true })).filter(
      (entry) => /\.als$/iu.test(entry.name),
    );
    if (sets.length !== 1 || !sets[0]!.isFile())
      throw new Error(
        "Expected exactly one current .als at the project root (not Backup)",
      );
    const setName = sets[0]!.name;
    const set = await readBounded(join(source, setName), signal);
    const references = readAcceptanceProjectReferences(set);
    const externalReferences = references.filter(
      (ref) => ref.relativePathType !== "3",
    );
    const localPaths = new Set([setName]);
    for (const ref of references.filter(
      (item) => item.relativePathType === "3",
    )) {
      if (
        !ref.relativePath ||
        /[\\:]/u.test(ref.relativePath) ||
        [...ref.relativePath].some(
          (character) => character.charCodeAt(0) < 32,
        ) ||
        ref.relativePath
          .split("/")
          .some((part) => !part || part === "." || part === "..")
      )
        throw new Error("Unsafe project-relative reference");
      localPaths.add(ref.relativePath);
    }
    if (localPaths.size > 128)
      throw new Error("Project resource count exceeds bound");
    const files: { path: string; bytes: Buffer; sha256: string }[] = [];
    let total = 0;
    for (const path of localPaths) {
      const absolute = join(source, path);
      await noSymlinks(absolute);
      if (!inside(source, await realpath(absolute)))
        throw new Error("Resource escapes project");
      const bytes =
        path === setName ? set : await readBounded(absolute, signal);
      total += bytes.length;
      if (total > 128 * 1024 * 1024)
        throw new Error("Project exceeds total byte bound");
      files.push({ path, bytes, sha256: sha256(bytes) });
    }
    signal.throwIfAborted();
    copy = await mkdtemp(join(output, "draft-"));
    for (const file of files) {
      signal.throwIfAborted();
      const destination = join(copy, file.path);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, file.bytes, { flag: "wx", mode: 0o600 });
    }
    emit("progress");
    for (const file of files) {
      if (
        sha256(await readBounded(join(source, file.path), signal)) !==
          file.sha256 ||
        sha256(await readBounded(join(copy, file.path), signal)) !== file.sha256
      )
        throw new Error("Source or copied resource changed during intake");
    }
    const inventory = files.map((file) => ({
      path: file.path,
      bytes: file.bytes.length,
      sha256: file.sha256,
    }));
    const completed: IntakeEvent = {
      name: "fixture.authoring.intake",
      stage: "completed",
      traceId,
      occurredAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
    };
    const result = {
      status: "copied-for-review",
      source,
      copy,
      setName,
      inventory,
      externalReferences,
      limitations: [
        "No Live settings or musical identity have been verified.",
        "External references were reported, not followed or copied.",
        "Device companion dependencies must be supplied separately.",
        "Backups, analysis caches and unrelated project metadata were not copied.",
      ],
      traceId,
      events: [...events, completed],
    };
    signal.throwIfAborted();
    await writeScenarioReceipt(`${copy}-intake.json`, result);
    events.push(completed);
    options.event?.(completed);
    return result;
  } catch (error) {
    emit(signal.aborted ? "cancelled" : "failed");
    if (copy) {
      // Retain an interrupted copy for review; never touch the source on failure.
      try {
        await writeScenarioReceipt(`${copy}-intake-failed.json`, {
          status: signal.aborted ? "cancelled" : "failed",
          copy,
          traceId,
          events,
          error: describeScenarioError(error),
        });
      } catch (persistenceError) {
        throw new AggregateError(
          [error, persistenceError],
          "Draft intake and failure receipt persistence failed",
        );
      }
    }
    throw error;
  }
}

export async function intakeCli(args: string[]): Promise<number> {
  if (args.length !== 4 || args[0] !== "--project" || args[2] !== "--output")
    throw new Error(
      "Usage: intake-project.mjs --project PROJECT_FOLDER --output EXISTING_AUTHORING_FOLDER",
    );
  const signal = new AbortController();
  const cancel = () => signal.abort(new Error("Draft intake cancelled"));
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const result = await intakeProject({
      project: args[1]!,
      output: args[3]!,
      signal: signal.signal,
      event: (event) => console.log(serializeScenarioReceipt(event)),
    });
    console.log(serializeScenarioReceipt(result));
    return 0;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}
