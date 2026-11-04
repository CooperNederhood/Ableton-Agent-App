import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { resolveLiveHostAutomationStorage } from "../../packages/storage/dist/index.js";

const handles = new WeakMap();
const execute = promisify(execFile);
const startPattern = /^\w{3}\s+\w{3}\s+\d+\s+\d+:\d+:\d+\s+\d{4}$/;

/** Validate capability provenance, not just a release-shaped object. */
export function isLiveHostLease(value) {
  return handles.has(value);
}

async function processIdentity() {
  const { stdout } = await execute(
    "ps",
    ["-p", String(process.pid), "-o", "lstart=,command="],
    { timeout: 10_000, maxBuffer: 64 * 1024 },
  );
  const match = stdout
    .trim()
    .match(/^(\w{3}\s+\w{3}\s+\d+\s+\d+:\d+:\d+\s+\d{4})\s+(.+)$/);
  if (!match)
    throw new Error("Unable to establish host lease process identity");
  return {
    pid: process.pid,
    startedAt: match[1],
    commandSha256: createHash("sha256").update(match[2]).digest("hex"),
  };
}

/**
 * A lease is local to this dedicated operator account, not a run or worktree.
 * No stale-PID or age-based reclamation: an orphan may still own a Live child.
 */
export async function acquireLiveHostLease({
  homeDirectory,
  signal,
  onEvent = () => undefined,
  traceId = randomUUID(),
  correlationId = traceId,
  causationId = correlationId,
  inspectOwner = processIdentity,
} = {}) {
  const started = Date.now();
  for (const id of [traceId, correlationId, causationId]) {
    if (typeof id !== "string" || !/^[\w.-]{1,128}$/.test(id)) {
      throw new Error("Invalid host lease trace identity");
    }
  }
  const emit = (stage) => {
    try {
      onEvent({
        type: `live.host_lease.${stage}`,
        traceId,
        correlationId,
        causationId,
        durationMs: Date.now() - started,
      });
    } catch {
      // Observers cannot invalidate ownership or skip cleanup.
    }
  };
  emit("queued");
  let acquired = false;
  const { directory, leaseDirectory } = resolveLiveHostAutomationStorage({
    homeDirectory,
  });
  try {
    signal?.throwIfAborted();
    emit("started");
    const identity = await inspectOwner();
    if (
      !Number.isSafeInteger(identity.pid) ||
      identity.pid < 1 ||
      typeof identity.startedAt !== "string" ||
      identity.startedAt.length > 128 ||
      !startPattern.test(identity.startedAt) ||
      !/^[a-f0-9]{64}$/.test(identity.commandSha256)
    )
      throw new Error("Invalid host lease process identity");
    signal?.throwIfAborted();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await mkdir(leaseDirectory, { mode: 0o700 });
    acquired = true;
    const ownerToken = randomUUID();
    const ownerPath = join(leaseDirectory, `owner-${ownerToken}.json`);
    const info = await lstat(leaseDirectory);
    const record = JSON.stringify({
      version: 1,
      pid: identity.pid,
      startedAt: identity.startedAt,
      commandSha256: identity.commandSha256,
      ownerToken,
    });
    await writeFile(ownerPath, record, { flag: "wx", mode: 0o600 });
    const state = {
      reserved: undefined,
      retained: false,
      released: false,
      releasing: false,
    };
    const assertOwned = async () => {
      if (state.released) throw new Error("Live host lease is released");
      const current = await lstat(leaseDirectory);
      const ownerInfo = await lstat(ownerPath);
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        current.dev !== info.dev ||
        current.ino !== info.ino ||
        !ownerInfo.isFile() ||
        ownerInfo.isSymbolicLink() ||
        ownerInfo.size > 4096 ||
        (await readFile(ownerPath, "utf8")) !== record
      )
        throw new Error("Live host lease ownership changed; refusing control");
    };
    const handle = Object.freeze({
      assertOwned,
      retain() {
        state.retained = true;
        emit("retained");
      },
      async release() {
        if (state.released) return;
        if (state.releasing)
          throw new Error("Live host lease release already in progress");
        state.releasing = true;
        emit("release_started");
        try {
          if (state.retained || state.reserved !== undefined) {
            throw new Error(
              "Live host lease cleanup is uncertain or still reserved; retaining lease",
            );
          }
          await assertOwned();
          if (state.retained)
            throw new Error(
              "Live host lease cleanup is uncertain; retaining lease",
            );
          // Only remove our unguessable owner entry, never recursively remove a lock.
          await unlink(ownerPath);
          await rmdir(leaseDirectory);
          state.released = true;
          emit("released");
        } catch (error) {
          emit("release_failed");
          throw error;
        } finally {
          state.releasing = false;
        }
      },
    });
    handles.set(handle, state);
    emit("completed");
    if (signal?.aborted) {
      await handle.release();
      signal.throwIfAborted();
    }
    return handle;
  } catch (error) {
    emit(signal?.aborted ? "cancelled" : "failed");
    if (error?.code === "EEXIST" && !acquired) {
      throw new Error(
        "Live host lease is already held. Do not reclaim by age or PID alone; verify all runner-owned applications have stopped before operator recovery.",
      );
    }
    // An incomplete acquisition remains fail-closed for explicit operator recovery.
    throw error;
  }
}

/** Internal in-process capability: sharing a suite lease does not allow parallel Live owners. */
export async function reserveLiveHostLease(handle, owner) {
  if (owner === null || typeof owner !== "object") {
    throw new Error("Invalid Live host lease reservation owner");
  }
  const state = handles.get(handle);
  if (!state) throw new Error("Invalid Live host lease handle");
  if (state.releasing || state.released)
    throw new Error("Live host lease is releasing or released");
  if (state.retained)
    throw new Error("Live host lease retained after uncertain cleanup");
  if (state.reserved !== undefined && state.reserved !== owner) {
    throw new Error("Live host lease already has an active controller");
  }
  state.reserved = owner;
  try {
    await handle.assertOwned();
  } catch (error) {
    state.retained = true;
    throw error;
  }
}

export function unreserveLiveHostLease(handle, owner) {
  const state = handles.get(handle);
  if (!state || state.reserved !== owner) {
    throw new Error("Live host lease reservation is not owned");
  }
  state.reserved = undefined;
}
