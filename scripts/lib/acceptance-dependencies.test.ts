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
  chmod,
  stat,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
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
  FLUCOMA_DEPENDENCY_FILES,
  readFlucomaDependencyFile,
} from "../../packages/shared/src/m4l-devices.js";
import {
  verifyDependencyInventory,
  verifyStagedFixture,
} from "../../packages/test-support/src/integration/staging.js";
import type { FixtureManifest } from "../../packages/test-support/src/integration/contracts.js";
import { runRestrictiveUmaskChild } from "./umask-child-test-support.js";

let root: string;
beforeEach(async () => {
  const scratch = resolve(".test-artifacts/acceptance-dependencies");
  await mkdir(scratch, { recursive: true });
  root = await realpath(await mkdtemp(join(scratch, "run-")));
  vi.resetAllMocks();
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function setup(includeFlucoma = false) {
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
  if (includeFlucoma)
    for (const pin of FLUCOMA_DEPENDENCY_FILES) {
      const target = join(sourceDirectory, pin.name);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(
        target,
        await readFile(
          new URL(
            `../../max-patches/audio-listener/${pin.name}`,
            import.meta.url,
          ),
        ),
        { mode: pin.mode },
      );
    }
  payloads.mockResolvedValue([
    {
      id: "machine-listening",
      sourceDirectory,
      deviceFile: file.name,
      files: [file, ...(includeFlucoma ? FLUCOMA_DEPENDENCY_FILES : [])],
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
  it("preserves pinned modes under restrictive umask in an isolated acceptance process", async () => {
    const workingDirectory = join(root, "restricted-working");
    await mkdir(workingDirectory);
    const options = {
      resourcesPath: root,
      workingDirectory,
      dependencies: ["machine-listening"],
      storage: {
        signalIngressDescriptorPath: join(root, "isolated/descriptor.json"),
        signalIngressSecretPath: join(root, "isolated/secret"),
      },
    };
    const stdout = await runRestrictiveUmaskChild(`
        import assert from "node:assert/strict";
        import { stat } from "node:fs/promises";
        import { dirname, join } from "node:path";
        import { buildAbletonIntegrations } from "./scripts/build-ableton-integrations.mjs";
        import { provisionPackagedDependencies } from "./tests/electron/acceptance-dependencies.ts";
        import { FLUCOMA_DEPENDENCY_FILES, validateFlucomaDependency } from "@ableton-agent/shared/m4l-devices";
        assert.equal(process.umask(), 0o077);
        await buildAbletonIntegrations(${JSON.stringify(join(root, "ableton-integrations"))});
        const options = ${JSON.stringify(options)};
        options.signal = new AbortController().signal;
        const result = await provisionPackagedDependencies(options);
        const target = join(options.workingDirectory, dirname(result.inventory.frozenDevices[0].target));
        await validateFlucomaDependency(target);
        for (const pin of FLUCOMA_DEPENDENCY_FILES)
          assert.equal((await stat(join(target, pin.name))).mode & 0o777, pin.mode, pin.name);
        assert.equal((await stat(join(target, "../agent_signal_storage.js"))).mode & 0o777, 0o600);
        console.log("umask-verified");
      `);
    expect(stdout.trim()).toBe("umask-verified");
  });

  it("preserves pinned nested signed resources adjacent to the frozen device and independently verifies their identity and modes", async () => {
    const options = await setup(true);
    const result = await provisionPackagedDependencies(options);
    const frozen = result.inventory.frozenDevices![0]!;
    const frozenRoot = join(options.workingDirectory, dirname(frozen.target));
    for (const pin of FLUCOMA_DEPENDENCY_FILES) {
      expect(
        await readFlucomaDependencyFile(frozenRoot, pin.name),
      ).toHaveLength(pin.bytes);
      expect(
        result.inventory.resources.find((entry) =>
          entry.path.endsWith(pin.name),
        )?.target,
      ).toBe(`${dirname(frozen.target)}/${pin.name}`);
      if (pin.mode === 0o755)
        expect((await stat(join(frozenRoot, pin.name))).mode & 0o111).toBe(
          0o111,
        );
    }
    const container = decodeAmxd(
      await readFile(join(options.workingDirectory, frozen.target)),
    );
    expect(container.document).toMatchObject({
      patcher: {
        project: {
          searchpath: {
            "0": {
              bootpath: join(frozenRoot, "dependencies/flucoma"),
              enabled: 1,
              recursive: 0,
              includeincollective: 0,
            },
          },
        },
      },
    });
    expect(JSON.stringify(container.document)).not.toContain(
      "projectrelativepath",
    );
    expect(
      container.frozenFiles?.some((file) =>
        file.name.startsWith("dependencies/"),
      ),
    ).toBe(false);
    const fixture: FixtureManifest = {
      schemaVersion: 1,
      id: "controlled-pinned",
      qualification: "synthetic-only",
      provenance: {
        ownership: "authored",
        description: "Controlled adjacent bundle staging",
      },
      resources: [
        {
          path: "project.als",
          target: "project.als",
          bytes: 1,
          sha256: createHash("sha256").update("x").digest("hex"),
        },
      ],
      dependencies: ["machine-listening"],
      baseline: {},
    };
    const staged = {
      workingDirectory: options.workingDirectory,
      projectPath: join(options.workingDirectory, "project.als"),
      resources: fixture.resources,
      verifySourceUnchanged: async () => {},
    };
    await verifyDependencyInventory(staged, fixture, result.inventory);
    const devicePath = join(options.workingDirectory, frozen.target);
    const originalFrozen = await readFile(devicePath);
    const changed = decodeAmxd(originalFrozen);
    const document = changed.document as {
      patcher: {
        project: { searchpath: Record<string, { bootpath: string }> };
      };
    };
    document.patcher.project.searchpath["0"]!.bootpath = join(
      options.workingDirectory,
      "wrong-root",
    );
    const rebound = encodeAmxd(changed, changed.document);
    await writeFile(devicePath, rebound);
    await expect(
      verifyDependencyInventory(staged, fixture, {
        ...result.inventory,
        frozenDevices: [
          {
            ...frozen,
            sha256: createHash("sha256").update(rebound).digest("hex"),
            bytes: rebound.length,
          },
        ],
      }),
    ).rejects.toThrow("Frozen dependency does not derive");
    await writeFile(devicePath, originalFrozen);
    const executable = FLUCOMA_DEPENDENCY_FILES.find(
      (pin) => pin.mode === 0o755,
    )!;
    await chmod(join(frozenRoot, executable.name), 0o600);
    await expect(
      verifyDependencyInventory(staged, fixture, result.inventory),
    ).rejects.toThrow("Pinned FluCoMa dependency");
  });
  it.each(["corrupted", "linked-parent", "non-executable", "missing"])(
    "rejects invalid pinned source resources before mounting: %s",
    async (fault) => {
      const options = await setup(true);
      const source = join(root, "ableton-integrations/machine-listening");
      const executable = FLUCOMA_DEPENDENCY_FILES.find(
        (pin) => pin.mode === 0o755,
      )!;
      if (fault === "missing")
        await rm(join(source, "dependencies/flucoma"), { recursive: true });
      if (fault === "corrupted")
        await writeFile(
          join(source, executable.name),
          Buffer.alloc(executable.bytes),
        );
      if (fault === "non-executable")
        await chmod(join(source, executable.name), 0o600);
      if (fault === "linked-parent") {
        const pin = FLUCOMA_DEPENDENCY_FILES.find((entry) =>
          entry.name.includes("/docs/"),
        )!;
        const directory = dirname(join(source, pin.name));
        await rm(directory, { recursive: true });
        await symlink(source, directory);
      }
      await expect(provisionPackagedDependencies(options)).rejects.toThrow();
    },
  );
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
    ).rejects.toThrow("Unsupported frozen resource path");
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
