import { lstat, realpath } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { DependencyInventory } from "@ableton-agent/test-support/integration";
import {
  FLUCOMA_DEPENDENCY_FILES,
  FLUCOMA_SPECTRALSHAPE_BUNDLE,
  readFlucomaDependencyFile,
} from "../../packages/shared/src/m4l-devices.js";
import { runProcess } from "../../scripts/lib/live-process-controller.mjs";
import { readOwnedLiveProcessTree } from "./acceptance-loading.js";

export interface FlatnessBinaryIdentity {
  flatnessLoadedBinaryVerified: true;
  flatnessLoadedBinarySchema: "owned-mapped-flucoma/v1";
  flatnessLoadedBinaryPath: string;
  flatnessLoadedBinarySha256: string;
  flatnessLoadedBinaryPids: string;
  flatnessLoadedBinaryInode: string;
  flatnessLoadedBinaryDevice: string;
}
const binaryName = `${FLUCOMA_SPECTRALSHAPE_BUNDLE}/Contents/MacOS/fluid.spectralshape~`;
const pin = FLUCOMA_DEPENDENCY_FILES.find(
  (entry) => entry.name === binaryName,
)!;

/** Read mapping metadata only from verified Live/Max ancestors of owned Node runtimes. */
export async function verifyLoadedFlatnessBinary(
  options: {
    live: { pid: number; startedAt: string; command: string };
    activeNodePids: string;
    workingDirectory: string;
    inventory: DependencyInventory;
    signal: AbortSignal;
  },
  run = runProcess,
): Promise<FlatnessBinaryIdentity> {
  options.signal.throwIfAborted();
  const devices = options.inventory.frozenDevices?.filter(
    (entry) => entry.id === "machine-listening",
  );
  if (
    devices?.length !== 1 ||
    !/^[1-9]\d*(?:,[1-9]\d*){0,31}$/u.test(options.activeNodePids)
  )
    throw new Error("Missing owned flatness binary loading contract");
  const device = devices[0]!;
  const target = `${dirname(device.target)}/${binaryName}`;
  const resources = options.inventory.resources.filter(
    (entry) =>
      entry.id === "machine-listening" &&
      entry.target === target &&
      entry.sha256 === pin.sha256 &&
      entry.bytes === pin.bytes,
  );
  if (
    resources.length !== 1 ||
    dirname(device.target) !== "dependencies/machine-listening/frozen"
  )
    throw new Error("Missing pinned staged flatness binary");
  const root = await realpath(options.workingDirectory);
  const binaryRoot = join(root, dirname(device.target));
  await readFlucomaDependencyFile(binaryRoot, binaryName);
  const path = await realpath(join(binaryRoot, binaryName));
  if (
    !path.startsWith(`${root}${sep}`) ||
    path !== resolve(binaryRoot, binaryName) ||
    path.length > 4096
  )
    throw new Error("Flatness binary escapes owned staged dependencies");
  const before = await lstat(path, { bigint: true });
  const snapshot = async () => {
    const tree = await readOwnedLiveProcessTree(
      options.live,
      options.signal,
      run,
    );
    const nodes = options.activeNodePids.split(",").map(Number);
    const ancestors = new Set<number>([options.live.pid]);
    for (const pid of nodes) {
      let row = tree.find((candidate) => candidate.pid === pid);
      if (!row?.command.includes("/Node for Max/source/lib/nsRunner.js"))
        throw new Error("Owned flatness Node identity is unavailable");
      for (
        let depth = 0;
        row && row.pid !== options.live.pid && depth < 16;
        depth++
      ) {
        ancestors.add(row.pid);
        row = tree.find((candidate) => candidate.pid === row!.parent);
      }
      if (row?.pid !== options.live.pid)
        throw new Error(
          "Cannot attribute flatness loader ancestry to owned Live",
        );
    }
    const owned = tree.filter((row) => ancestors.has(row.pid));
    const hosts = owned.filter((row) =>
      /\.app\/Contents\/MacOS\/(?:Live|Max)$/u.test(row.command),
    );
    if (hosts.length < 1 || hosts.length > 8)
      throw new Error("Cannot identify bounded owned Live/Max loaders");
    return { owned, hosts };
  };
  const ownership = await snapshot();
  const mapped = new Set<number>();
  for (const host of ownership.hosts) {
    options.signal.throwIfAborted();
    const result = await run(
      "/usr/sbin/lsof",
      ["-a", "-p", String(host.pid), "-d", "txt", "-F0pfiDn"],
      { timeoutMs: 10_000, maxOutputBytes: 1_048_576 },
    );
    options.signal.throwIfAborted();
    if (
      result.status !== 0 ||
      result.timedOut ||
      result.stdout.length >= 1_048_576
    )
      throw new Error("Cannot read bounded owned loader mappings");
    let pid: number | undefined;
    let file: Record<string, string> = {};
    const finish = () => {
      if (!file.n?.includes("spectralshape")) return;
      if (
        pid !== host.pid ||
        file.f !== "txt" ||
        file.n !== path ||
        file.i !== String(before.ino) ||
        !/^0x[0-9a-f]+$/iu.test(file.D ?? "") ||
        BigInt(file.D!) !== BigInt(before.dev)
      )
        throw new Error(
          "Mapped flatness binary is not the pinned staged identity",
        );
      mapped.add(host.pid);
    };
    for (const field of result.stdout.split("\0")) {
      const token = field.replace(/^\n/u, "");
      if (!token) continue;
      const code = token[0]!;
      const value = token.slice(1);
      if (code === "p") {
        finish();
        file = {};
        pid = Number(value);
        if (pid !== host.pid)
          throw new Error("Foreign PID in owned loader mapping read");
      } else if (code === "f") {
        finish();
        file = { f: value };
      } else if (["i", "D", "n"].includes(code)) {
        if (Object.hasOwn(file, code))
          throw new Error("Ambiguous owned loader mapping");
        file[code] = value;
      }
    }
    finish();
  }
  if (mapped.size === 0)
    throw new Error(
      "No mapped flatness binary in attributable owned Live/Max loaders",
    );
  const afterOwnership = await snapshot();
  if (JSON.stringify(ownership) !== JSON.stringify(afterOwnership))
    throw new Error(
      "Owned loader identity changed during flatness mapping proof",
    );
  await readFlucomaDependencyFile(binaryRoot, binaryName);
  const after = await lstat(path, { bigint: true });
  options.signal.throwIfAborted();
  if (
    before.ino !== after.ino ||
    before.dev !== after.dev ||
    before.ctimeMs !== after.ctimeMs ||
    before.mtimeMs !== after.mtimeMs
  )
    throw new Error("Pinned flatness binary changed during mapping proof");
  return {
    flatnessLoadedBinaryVerified: true,
    flatnessLoadedBinarySchema: "owned-mapped-flucoma/v1",
    flatnessLoadedBinaryPath: path,
    flatnessLoadedBinarySha256: pin.sha256,
    flatnessLoadedBinaryPids: [...mapped].sort((a, b) => a - b).join(","),
    flatnessLoadedBinaryInode: String(before.ino),
    flatnessLoadedBinaryDevice: String(before.dev),
  };
}
