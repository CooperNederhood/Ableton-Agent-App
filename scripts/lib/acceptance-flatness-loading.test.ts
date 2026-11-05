import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  rm,
  lstat,
  chmod,
  symlink,
  rename,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FLUCOMA_DEPENDENCY_FILES,
  FLUCOMA_SPECTRALSHAPE_BUNDLE,
  NATIVE_MEL_BUNDLE,
} from "../../packages/shared/src/m4l-devices.js";
import {
  verifyLoadedFlatnessBinary,
  verifyLoadedMelBinary,
} from "../../tests/electron/acceptance-flatness-loading.js";
import type { runProcess } from "./live-process-controller.mjs";
import type { DependencyInventory } from "../../packages/test-support/src/integration/contracts.js";

let root: string;
const startedAt = "Wed Nov 4 00:00:00 2026";
const command = "/Applications/Live.app/Contents/MacOS/Live";
beforeEach(async () => {
  const parent = resolve(".test-artifacts/flatness-loader-unit");
  await mkdir(parent, { recursive: true });
  root = await mkdtemp(join(parent, "case-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function setup(name: string) {
  const pin = FLUCOMA_DEPENDENCY_FILES.find((entry) => entry.name === name)!;
  const target = `dependencies/machine-listening/frozen/${name}`;
  const path = join(root, target);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    await readFile(
      new URL(`../../max-patches/audio-listener/${name}`, import.meta.url),
    ),
    { mode: 0o755 },
  );
  const stat = await lstat(path, { bigint: true });
  const ps = [
    `10 1 ${startedAt} ${command}`,
    `11 10 ${startedAt} /Applications/Max.app/Contents/MacOS/Max`,
    `12 11 ${startedAt} N4M PM`,
    `13 12 ${startedAt} /Max/Node for Max/source/lib/nsRunner.js`,
    `99 1 ${startedAt} /Applications/Max.app/Contents/MacOS/Max`,
    `100 99 ${startedAt} /Max/Node for Max/source/lib/nsRunner.js`,
  ].join("\n");
  const mapping = (pid: number, mappedPath = path, inode = String(stat.ino)) =>
    `p${pid}\0\nftxt\0i${inode}\0D0x${stat.dev.toString(16)}\0n${mappedPath}\0\n`;
  const run = vi.fn<typeof runProcess>(async (cmd, args) => ({
    status: 0,
    stderr: "",
    timedOut: false,
    stdout:
      cmd === "ps"
        ? ps
        : mapping(Number(args[2]), args[2] === "11" ? path : command),
  }));
  const inventory: DependencyInventory = {
    schemaVersion: 1,
    candidateRoot: "/unused-candidate",
    resources: [
      {
        id: "machine-listening",
        path: `machine-listening/${name}`,
        target,
        bytes: pin.bytes,
        sha256: pin.sha256,
      },
    ],
    frozenDevices: [
      {
        id: "machine-listening",
        sourceTarget: "dependencies/machine-listening/device.amxd",
        target: "dependencies/machine-listening/frozen/device.amxd",
        bytes: 1,
        sha256: "a".repeat(64),
      },
    ],
  };
  return {
    path,
    ps,
    mapping,
    run,
    options: {
      live: { pid: 10, startedAt, command },
      activeNodePids: "13",
      workingDirectory: root,
      inventory,
      signal: new AbortController().signal,
    },
  };
}
describe.each([
  {
    kind: "flatness",
    name: `${FLUCOMA_SPECTRALSHAPE_BUNDLE}/Contents/MacOS/fluid.spectralshape~`,
    verify: verifyLoadedFlatnessBinary,
    schema: "owned-mapped-flucoma/v1",
  },
  {
    kind: "mel",
    name: `${NATIVE_MEL_BUNDLE}/Contents/MacOS/listener.mel~`,
    verify: verifyLoadedMelBinary,
    schema: "owned-mapped-listener-mel/v1",
  },
])("owned mapped $kind binary identity", ({ kind, name, verify, schema }) => {
  const pin = FLUCOMA_DEPENDENCY_FILES.find((entry) => entry.name === name)!;
  it("attests actual mapped path, inode, device and pinned bytes without reading unrelated processes", async () => {
    const { options, run, path } = await setup(name);
    expect(await verify(options, run)).toMatchObject({
      [`${kind}LoadedBinaryVerified`]: true,
      [`${kind}LoadedBinarySchema`]: schema,
      [`${kind}LoadedBinaryPath`]: path,
      [`${kind}LoadedBinarySha256`]: pin.sha256,
      [`${kind}LoadedBinaryPids`]: "11",
    });
    expect(
      run.mock.calls.filter(([cmd]) => cmd !== "ps").map(([, args]) => args),
    ).toEqual([
      ["-a", "-p", "10", "-d", "txt", "-F0pfiDn"],
      ["-a", "-p", "11", "-d", "txt", "-F0pfiDn"],
    ]);
  });
  it.each([
    "absent",
    "global",
    "additional-global",
    "other-producer-only",
    "wrong-inode",
    "wrong-device",
    "foreign-pid",
    "not-mapped",
    "malformed",
    "oversized",
    "denied",
    "timeout",
  ])("fails closed on %s mapping evidence", async (fault) => {
    const { options, run, ps, mapping, path } = await setup(name);
    run.mockImplementation(async (cmd, args) => {
      let stdout =
        cmd === "ps"
          ? ps
          : mapping(Number(args[2]), args[2] === "11" ? path : command);
      if (cmd !== "ps" && args[2] === "11") {
        if (fault === "absent") stdout = mapping(11, command);
        if (fault === "global") stdout = mapping(11, `/Global/${name}`);
        if (fault === "additional-global")
          stdout += mapping(11, `/Global/${name}`);
        if (fault === "other-producer-only")
          stdout = mapping(
            11,
            kind === "mel"
              ? "/Global/fluid.spectralshape~"
              : "/Global/listener.mel~",
          );
        if (fault === "wrong-inode") stdout = mapping(11, path, "0");
        if (fault === "wrong-device")
          stdout = stdout.replace(/D0x[0-9a-f]+/u, "D0x0");
        if (fault === "foreign-pid") stdout = mapping(99);
        if (fault === "not-mapped") stdout = stdout.replace("ftxt", "f3");
        if (fault === "malformed") stdout = stdout.replace(/\0i\d+/u, "");
        if (fault === "oversized") stdout = "n".repeat(1_048_576);
      }
      return {
        status: fault === "denied" && cmd !== "ps" ? 1 : 0,
        stdout,
        stderr: "",
        timedOut: fault === "timeout" && cmd !== "ps",
      };
    });
    await expect(verify(options, run)).rejects.toThrow();
  });
  it.each(["reused-live", "reparented-node", "changed-loader"])(
    "rejects %s ownership without attaching to an unrelated process",
    async (fault) => {
      const { options, run, ps, mapping } = await setup(name);
      let reads = 0;
      run.mockImplementation(async (cmd, args) => {
        let output = ps;
        if (cmd === "ps") {
          reads++;
          if (fault === "reused-live")
            output = ps.replace(startedAt, "Wed Nov 4 00:01:00 2026");
          if (fault === "reparented-node")
            output = ps.replace("13 12 ", "13 99 ");
          if (fault === "changed-loader" && reads === 2)
            output = ps.replace("11 10 ", "11 1 ");
        }
        return {
          status: 0,
          stdout: cmd === "ps" ? output : mapping(Number(args[2])),
          stderr: "",
          timedOut: false,
        };
      });
      await expect(verify(options, run)).rejects.toThrow();
      expect(run.mock.calls.some(([, args]) => args.includes("99"))).toBe(
        false,
      );
    },
  );
  it.each(["bytes", "mode", "symlink", "inventory", "repinned-inventory"])(
    "rejects changed staged %s before mapping inspection",
    async (fault) => {
      const { options, run, path } = await setup(name);
      if (fault === "bytes") await writeFile(path, Buffer.alloc(pin.bytes));
      if (fault === "mode") await chmod(path, 0o600);
      if (fault === "symlink") {
        const original = await readFile(path);
        await rm(path);
        const other = join(root, "other");
        await writeFile(other, original, { mode: 0o755 });
        await symlink(other, path);
      }
      if (fault === "inventory")
        options.inventory = { ...options.inventory, resources: [] };
      if (fault === "repinned-inventory") {
        const substituted = Buffer.alloc(pin.bytes);
        await writeFile(path, substituted);
        options.inventory = {
          ...options.inventory,
          resources: options.inventory.resources.map((resource) => ({
            ...resource,
            sha256: createHash("sha256").update(substituted).digest("hex"),
          })),
        };
      }
      await expect(verify(options, run)).rejects.toThrow();
      expect(run).not.toHaveBeenCalled();
    },
  );
  it("honors cancellation before and after bounded process reads", async () => {
    const { options, run } = await setup(name);
    await expect(
      verify({ ...options, signal: AbortSignal.abort() }, run),
    ).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
    const abort = new AbortController();
    run.mockImplementation(async () => {
      abort.abort();
      return { status: 0, stdout: "", stderr: "", timedOut: false };
    });
    await expect(
      verify({ ...options, signal: abort.signal }, run),
    ).rejects.toThrow();
    expect(run).toHaveBeenCalledOnce();
  });
  it.each(["bytes", "same-bytes-new-inode"])(
    "rejects a staged binary changed during mapping (%s)",
    async (fault) => {
      const { options, run, ps, mapping, path } = await setup(name);
      run.mockImplementation(async (cmd, args) => {
        if (cmd !== "ps" && args[2] === "11") {
          if (fault === "bytes") await writeFile(path, Buffer.alloc(pin.bytes));
          else {
            const replacement = join(root, "replacement");
            await writeFile(replacement, await readFile(path), { mode: 0o755 });
            await rename(replacement, path);
          }
        }
        return {
          status: 0,
          stdout: cmd === "ps" ? ps : mapping(Number(args[2])),
          stderr: "",
          timedOut: false,
        };
      });
      await expect(verify(options, run)).rejects.toThrow();
    },
  );
});
