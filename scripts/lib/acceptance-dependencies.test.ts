import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const payloads = vi.hoisted(() => vi.fn());
vi.mock("../../packages/shared/src/m4l-devices.js", async (original) => ({
  ...(await original<object>()),
  readIntegrationDevicePayloads: payloads,
}));
import { provisionPackagedDependencies } from "../../tests/electron/acceptance-dependencies.js";
import {
  decodeAmxd,
  encodeAmxd,
} from "../../packages/shared/src/m4l-devices.js";
import {
  verifyDependencyInventory,
  verifyStagedFixture,
} from "../../packages/test-support/src/integration/staging.js";
import type { FixtureManifest } from "../../packages/test-support/src/integration/contracts.js";

let root: string;
beforeEach(async () => {
  root = await realpath(
    await mkdtemp(join(tmpdir(), "acceptance-dependencies-")),
  );
  vi.resetAllMocks();
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function setup() {
  const sourceDirectory = join(root, "ableton-integrations/machine-listening");
  const workingDirectory = join(root, "working");
  await mkdir(sourceDirectory, { recursive: true });
  await mkdir(workingDirectory);
  const bytes = encodeAmxd(
    {
      prefix: Buffer.from("616d7066040000006161616170746368", "hex"),
      suffix: Buffer.alloc(0),
    },
    { patcher: { boxes: [], lines: [] } },
  );
  const file = {
    name: "device.amxd",
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  await writeFile(join(sourceDirectory, file.name), bytes);
  payloads.mockResolvedValue([
    {
      id: "machine-listening",
      sourceDirectory,
      deviceFile: file.name,
      files: [file],
    },
  ]);
  return {
    resourcesPath: root,
    workingDirectory,
    dependencies: ["machine-listening"],
    storage: {
      signalIngressDescriptorPath: join(root, "isolated/descriptor.json"),
      signalIngressSecretPath: join(root, "isolated/secret"),
    },
    signal: new AbortController().signal,
  };
}
describe("packaged dependency staging", () => {
  it("derives a separate Set and frozen device, independently rejects rehashed repairs and embedded tampering", async () => {
    const options = await setup();
    const original = gzipSync(
      '<Ableton Version="11"><LiveSet><Tempo Value="120" /><Tracks><AudioTrack Id="175"><DeviceChain><DeviceChain><Devices><MxDeviceAudioEffect Id="0"><PatchSlot><Value><MxDPatchRef Id="1"><FileRef><RelativePathType Value="3" /><RelativePath Value="Presets/Machine-Listening-Development.amxd" /><Path Value="/original/device.amxd" /></FileRef></MxDPatchRef></Value></PatchSlot></MxDeviceAudioEffect></Devices></DeviceChain></DeviceChain></AudioTrack></Tracks></LiveSet></Ableton>',
    );
    const projectPath = join(options.workingDirectory, "project.als");
    await writeFile(projectPath, original);
    const digest = (bytes: Uint8Array) =>
      createHash("sha256").update(bytes).digest("hex");
    const fixture: FixtureManifest = {
      schemaVersion: 1,
      id: "controlled-binding",
      qualification: "synthetic-only",
      provenance: {
        ownership: "authored",
        description: "Controlled binding regression",
      },
      resources: [
        {
          path: "source.als",
          target: "project.als",
          sha256: digest(original),
          bytes: original.length,
        },
      ],
      dependencies: ["machine-listening"],
      baseline: {},
      listenerBindings: [
        {
          slot: "AudioTrack:175/DeviceChain/DeviceChain/Devices/MxDeviceAudioEffect:0",
          sourcePath: "Presets/Machine-Listening-Development.amxd",
          dependency: "machine-listening",
          trackIndex: 0,
          deviceIndex: 0,
        },
      ],
    };
    const staged = {
      projectPath,
      workingDirectory: options.workingDirectory,
      resources: fixture.resources,
      verifySourceUnchanged: async () => {},
    };
    const result = await provisionPackagedDependencies({
      ...options,
      listenerBindings: fixture.listenerBindings!,
    });
    await verifyStagedFixture(staged, fixture);
    await verifyDependencyInventory(staged, fixture, result.inventory);
    expect(await readFile(projectPath)).toEqual(original);
    const shadow = Buffer.from("must not be silently overwritten");
    const shadowResource = {
      id: "machine-listening",
      path: "machine-listening/shadow/agent_signal_storage.js",
      target: "dependencies/machine-listening/shadow/agent_signal_storage.js",
      sha256: digest(shadow),
      bytes: shadow.length,
    };
    for (const [base, relative] of [
      [result.inventory.candidateRoot, shadowResource.path],
      [options.workingDirectory, shadowResource.target],
    ] as const) {
      const path = join(base, relative);
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, shadow);
    }
    await expect(
      verifyDependencyInventory(staged, fixture, {
        ...result.inventory,
        resources: [...result.inventory.resources, shadowResource],
      }),
    ).rejects.toThrow("Duplicate frozen resource");
    const target = join(options.workingDirectory, "prepared.als");
    const prepared = await readFile(target);
    const repaired = gzipSync(
      gunzipSync(prepared)
        .toString()
        .replace('Tempo Value="120"', 'Tempo Value="121"'),
    );
    await writeFile(target, repaired);
    await expect(
      verifyDependencyInventory(staged, fixture, {
        ...result.inventory,
        preparedProject: {
          target: "prepared.als",
          sha256: digest(repaired),
          bytes: repaired.length,
        },
      }),
    ).rejects.toThrow("changed beyond");
    await writeFile(target, prepared);
    const frozen = result.inventory.frozenDevices![0]!;
    const frozenPath = join(options.workingDirectory, frozen.target);
    const container = decodeAmxd(await readFile(frozenPath));
    const tampered = encodeAmxd(
      {
        ...container,
        frozenFiles: container.frozenFiles!.map((file) =>
          file.name === "agent_signal_storage.js"
            ? { ...file, data: Buffer.from("changed") }
            : file,
        ),
      },
      container.document,
    );
    await writeFile(frozenPath, tampered);
    await expect(
      verifyDependencyInventory(staged, fixture, {
        ...result.inventory,
        frozenDevices: [
          { ...frozen, sha256: digest(tampered), bytes: tampered.length },
        ],
      }),
    ).rejects.toThrow("does not derive");
  });
  it("copies verified inventory and fingerprints profile-specific discovery without copying credentials", async () => {
    const options = await setup();
    const first = await provisionPackagedDependencies(options);
    expect(first.hashes["machine-listening"]).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.inventory.resources).toMatchObject([
      {
        id: "machine-listening",
        path: "machine-listening/device.amxd",
        target: "dependencies/machine-listening/device.amxd",
      },
    ]);
    expect(first.inventory.generatedConfigurations).toHaveLength(1);
    const directory = join(
      options.workingDirectory,
      "dependencies/machine-listening",
    );
    expect(await readdir(directory)).toEqual([
      "agent_signal_storage.js",
      "device.amxd",
      "frozen",
    ]);
    expect(
      decodeAmxd(await readFile(join(directory, "device.amxd"))).frozenFiles,
    ).toBeUndefined();
    const frozen = decodeAmxd(
      await readFile(join(directory, "frozen/device.amxd")),
    );
    expect(
      frozen.frozenFiles
        ?.find(({ name }) => name === "agent_signal_storage.js")
        ?.data.toString(),
    ).toContain(options.storage.signalIngressDescriptorPath);
    expect(first.inventory.frozenDevices).toHaveLength(1);
    expect(
      await readFile(join(directory, "agent_signal_storage.js"), "utf8"),
    ).toContain(options.storage.signalIngressDescriptorPath);
    const secondRoot = join(root, "second");
    await mkdir(secondRoot);
    const second = await provisionPackagedDependencies({
      ...options,
      workingDirectory: secondRoot,
      storage: {
        ...options.storage,
        signalIngressDescriptorPath: join(root, "other/descriptor.json"),
      },
    });
    expect(second.hashes["machine-listening"]).not.toBe(
      first.hashes["machine-listening"],
    );
  });
  it("rejects a payload changed after package verification", async () => {
    const options = await setup();
    const path = join(
      root,
      "ableton-integrations/machine-listening/device.amxd",
    );
    await writeFile(path, "X".repeat((await readFile(path)).length));
    await expect(provisionPackagedDependencies(options)).rejects.toThrow(
      "hash mismatch",
    );
  });
  it("rejects symlink replacement and undeclared dependencies", async () => {
    const options = await setup();
    await rm(join(root, "ableton-integrations/machine-listening/device.amxd"));
    await writeFile(join(root, "outside"), "controlled device fixture");
    await symlink(
      join(root, "outside"),
      join(root, "ableton-integrations/machine-listening/device.amxd"),
    );
    await expect(provisionPackagedDependencies(options)).rejects.toThrow(
      "changed after verification",
    );
    await expect(
      provisionPackagedDependencies({
        ...options,
        dependencies: ["unreviewed"],
      }),
    ).rejects.toThrow("Unknown packaged");
  });
  it("honors cancellation before creating dependency files", async () => {
    const options = await setup();
    const abort = new AbortController();
    abort.abort();
    await expect(
      provisionPackagedDependencies({ ...options, signal: abort.signal }),
    ).rejects.toThrow();
    expect(await readdir(options.workingDirectory)).toEqual([]);
    expect(payloads).not.toHaveBeenCalled();
  });
});
