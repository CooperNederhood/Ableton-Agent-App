import { createHash } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import type { DependencyInventory } from "@ableton-agent/test-support/integration";
import { decodeAmxd } from "../../packages/shared/src/m4l-devices.js";
import { runProcess } from "../../scripts/lib/live-process-controller.mjs";

/** Establish bytes in the actual owned Node process, not merely the staged bundle. */
export async function verifyActiveFrozenCandidate(
  options: {
    live: { pid: number; startedAt: string };
    workingDirectory: string;
    inventory: DependencyInventory;
    instances: number;
    signal: AbortSignal;
  },
  run = runProcess,
): Promise<{
  activeCandidateVerified: true;
  activeNodePids: string;
  activeFrozenSha256: string;
}> {
  options.signal.throwIfAborted();
  const device = options.inventory.frozenDevices?.find(
    (entry) => entry.id === "machine-listening",
  );
  if (!device || options.instances < 1 || options.instances > 32)
    throw new Error("Missing frozen loading contract");
  const frozen = await readFile(join(options.workingDirectory, device.target));
  if (createHash("sha256").update(frozen).digest("hex") !== device.sha256)
    throw new Error("Frozen candidate changed before loading proof");
  const files = decodeAmxd(frozen).frozenFiles?.filter(
    (entry) => entry.flags === 8,
  );
  if (!files?.some((entry) => entry.name === "audio_listener_native_v5_max.js"))
    throw new Error("Missing production Node runtime");
  const snapshot = async () => {
    const result = await run("ps", ["-axo", "pid=,ppid=,lstart=,command="], {
      timeoutMs: 10_000,
    });
    if (
      result.status !== 0 ||
      result.timedOut ||
      result.stdout.length >= 2_000_000
    )
      throw new Error("Unable to inspect bounded owned processes");
    const rows = result.stdout.split("\n").flatMap((line) => {
      const match =
        /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d+:\d+:\d+\s+\d{4})\s+(.+)$/u.exec(
          line,
        );
      return match
        ? [
            {
              pid: Number(match[1]),
              parent: Number(match[2]),
              startedAt: match[3]!.replace(/\s+/gu, " "),
              command: match[4]!,
            },
          ]
        : [];
    });
    if (
      !rows.some(
        (row) =>
          row.pid === options.live.pid &&
          row.startedAt === options.live.startedAt.replace(/\s+/gu, " ") &&
          row.command.endsWith(".app/Contents/MacOS/Live"),
      )
    )
      throw new Error("Owned Live identity changed during loading proof");
    const descendants = new Set([options.live.pid]);
    for (let depth = 0; depth < 16; depth++)
      for (const row of rows)
        if (descendants.has(row.parent)) descendants.add(row.pid);
    return rows.filter(
      (row) =>
        descendants.has(row.pid) &&
        row.command.includes("/Node for Max/source/lib/nsRunner.js"),
    );
  };
  const nodes = await snapshot();
  if (nodes.length !== options.instances)
    throw new Error(
      "Active Node instance count differs from declared listeners",
    );
  for (const node of nodes) {
    options.signal.throwIfAborted();
    const cwd = await run(
      "/usr/sbin/lsof",
      ["-a", "-p", String(node.pid), "-d", "cwd", "-Fn"],
      { timeoutMs: 10_000 },
    );
    const paths = cwd.stdout.split("\n").filter((line) => line.startsWith("n"));
    if (
      cwd.status !== 0 ||
      cwd.timedOut ||
      cwd.stdout.length > 8192 ||
      paths.length !== 1 ||
      !paths[0]!.startsWith("n/")
    )
      throw new Error("Cannot attribute Node extraction directory");
    for (const file of files) {
      options.signal.throwIfAborted();
      const path = join(paths[0]!.slice(1), file.name);
      const handle = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const before = await handle.stat();
        if (!before.isFile() || before.size !== file.data.length)
          throw new Error("Invalid extracted candidate file");
        const bytes = await handle.readFile();
        const after = await handle.stat();
        if (
          before.ctimeMs !== after.ctimeMs ||
          before.mtimeMs !== after.mtimeMs ||
          !bytes.equals(file.data)
        )
          throw new Error("Active extracted runtime differs from candidate");
      } finally {
        await handle.close();
      }
    }
  }
  options.signal.throwIfAborted();
  const after = await snapshot();
  if (JSON.stringify(nodes) !== JSON.stringify(after))
    throw new Error("Node ownership changed during loading proof");
  return {
    activeCandidateVerified: true,
    activeNodePids: nodes.map((node) => node.pid).join(","),
    activeFrozenSha256: device.sha256,
  };
}
