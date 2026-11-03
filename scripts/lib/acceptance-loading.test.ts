import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decodeAmxd,
  encodeAmxd,
  freezeAmxd,
} from "../../packages/shared/src/m4l-devices.js";
import { verifyActiveFrozenCandidate } from "../../tests/electron/acceptance-loading.js";
import type { runProcess } from "./live-process-controller.mjs";
import type { DependencyInventory } from "../../packages/test-support/src/integration/contracts.js";

let root: string;
const startedAt = "Sun Nov 1 23:00:00 2026";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "active-candidate-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
async function setup() {
  const source = encodeAmxd(
    {
      prefix: Buffer.from("616d7066040000006161616170746368", "hex"),
      suffix: Buffer.alloc(0),
    },
    {
      patcher: {
        boxes: [
          {
            box: {
              text: "node.script audio_listener_native_v5_max.js @autostart 1",
            },
          },
        ],
      },
    },
  );
  const bytes = freezeAmxd(
    source,
    "Listener.amxd",
    new Map([
      ["audio_listener_native_v5_max.js", Buffer.from("module.exports = 1;")],
      ["agent_signal_storage.js", Buffer.from("module.exports = {};")],
    ]),
  );
  const target = "dependencies/machine-listening/frozen/Listener.amxd";
  await mkdir(join(root, "dependencies/machine-listening/frozen"), {
    recursive: true,
  });
  await writeFile(join(root, target), bytes);
  const cwd = join(root, "extracted");
  await mkdir(cwd);
  for (const file of decodeAmxd(bytes).frozenFiles!.filter(
    (file) => file.flags === 8,
  ))
    await writeFile(join(cwd, file.name), file.data);
  const inventory: DependencyInventory = {
    schemaVersion: 1,
    candidateRoot: root,
    resources: [],
    frozenDevices: [
      {
        id: "machine-listening",
        sourceTarget: "source.amxd",
        target,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    ],
  };
  const ps = `10 1 ${startedAt} /Applications/Live.app/Contents/MacOS/Live\n11 10 ${startedAt} N4M PM\n12 11 ${startedAt} /Max/Node for Max/source/lib/nsRunner.js`;
  const run = vi.fn<typeof runProcess>(async (command) => ({
    status: 0,
    stdout: command === "ps" ? ps : `p12\nfcwd\nn${cwd}\n`,
    stderr: "",
    timedOut: false,
  }));
  return {
    cwd,
    ps,
    run,
    options: {
      live: { pid: 10, startedAt },
      workingDirectory: root,
      inventory,
      instances: 1,
      signal: new AbortController().signal,
    },
  };
}
describe("active frozen candidate loading evidence", () => {
  it("requires an owned Node process and exact extracted runtime/config bytes", async () => {
    const { options, run } = await setup();
    expect(await verifyActiveFrozenCandidate(options, run)).toMatchObject({
      activeCandidateVerified: true,
      activeNodePids: "12",
    });
    expect(run).toHaveBeenCalledTimes(3);
  });
  it.each(["foreign-parent", "reused-live", "no-node", "changed-node"])(
    "rejects %s instead of trusting copied hashes",
    async (kind) => {
      const { options, run, ps, cwd } = await setup();
      let reads = 0;
      run.mockImplementation(async (command) => {
        let output = ps;
        if (kind === "foreign-parent") output = ps.replace("12 11 ", "12 99 ");
        if (kind === "reused-live")
          output = ps.replace(startedAt, "Sun Nov 1 23:01:00 2026");
        if (kind === "no-node") output = ps.split("\n").slice(0, 2).join("\n");
        if (command === "ps" && ++reads === 2 && kind === "changed-node")
          output = ps.replace("12 11 ", "13 11 ");
        return {
          status: 0,
          stdout: command === "ps" ? output : `n${cwd}`,
          stderr: "",
          timedOut: false,
        };
      });
      await expect(verifyActiveFrozenCandidate(options, run)).rejects.toThrow();
    },
  );
  it.each(["tampered", "missing", "symlink"])(
    "rejects %s extracted dependency",
    async (kind) => {
      const { options, run, cwd } = await setup();
      const file = join(cwd, "agent_signal_storage.js");
      const original = await readFile(file);
      await rm(file);
      if (kind === "tampered")
        await writeFile(file, Buffer.alloc(original.length, 65));
      if (kind === "symlink") {
        await writeFile(join(root, "outside"), original);
        await symlink(join(root, "outside"), file);
      }
      await expect(verifyActiveFrozenCandidate(options, run)).rejects.toThrow();
    },
  );
  it("honors cancellation and failed process inspection", async () => {
    const { options, run } = await setup();
    await expect(
      verifyActiveFrozenCandidate(
        { ...options, signal: AbortSignal.abort() },
        run,
      ),
    ).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
    run.mockResolvedValue({
      status: 1,
      stdout: "",
      stderr: "denied",
      timedOut: false,
    });
    await expect(verifyActiveFrozenCandidate(options, run)).rejects.toThrow(
      "Unable",
    );
  });
});
