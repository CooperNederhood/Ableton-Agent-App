import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import type * as FsPromises from "node:fs/promises";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { decodeAmxd, encodeAmxd } from "@ableton-agent/shared/m4l-devices";
import type * as Shared from "@ableton-agent/shared/m4l-devices";
import { resolveLiveAgentStorage } from "@ableton-agent/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  IntegrationInstallError,
  inspectAbletonIntegrations,
  installAbletonIntegrations,
  type IntegrationInstallEvent,
} from "./ableton-integrations-install.js";
import * as hostProcess from "./ableton-host-process.js";

const payloadReader = vi.hoisted(() => vi.fn());
const fileFaults = vi.hoisted(() => ({
  rename: vi.fn(),
  write: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof FsPromises>();
  return {
    ...fs,
    rename: async (...args: Parameters<typeof fs.rename>) => {
      fileFaults.rename(...args);
      return fs.rename(...args);
    },
    writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
      fileFaults.write(...args);
      return fs.writeFile(...args);
    },
    rm: async (...args: Parameters<typeof fs.rm>) => {
      fileFaults.remove(...args);
      return fs.rm(...args);
    },
  };
});
vi.mock("@ableton-agent/shared/m4l-devices", async (original) => ({
  ...(await original<object>()),
  readIntegrationDevicePayloads: payloadReader,
}));

const roots: string[] = [];
const hash = (bytes: string) =>
  createHash("sha256").update(bytes).digest("hex");
async function fixture() {
  const root = join(
    process.cwd(),
    ".test-artifacts",
    `integrations-${randomUUID()}`,
  );
  roots.push(root);
  const source = join(root, "resources", "AbletonAgent");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "__init__.py"), "# one\n");
  const payloads = [];
  for (const [id, deviceFile] of [
    ["machine-listening", "Machine-Listening-Development.amxd"],
    ["midi-capture", "Midi-Capture.amxd"],
  ] as const) {
    const sourceDirectory = join(root, "resources", id);
    await mkdir(sourceDirectory);
    await writeFile(join(sourceDirectory, deviceFile), "device-one");
    await writeFile(
      join(sourceDirectory, "agent_signal_client.js"),
      "client-one",
    );
    const files = [
      { name: deviceFile, sha256: hash("device-one"), bytes: 10 },
      {
        name: "agent_signal_client.js",
        sha256: hash("client-one"),
        bytes: 10,
      },
    ];
    if (id === "machine-listening") {
      const manifest = JSON.stringify({
        discoveryConfigured: false,
        resources: [],
      });
      await writeFile(
        join(sourceDirectory, "audio-listener-manifest.json"),
        manifest,
      );
      files.push({
        name: "audio-listener-manifest.json",
        sha256: hash(manifest),
        bytes: Buffer.byteLength(manifest),
      });
    }
    payloads.push({
      id,
      deviceFile,
      sourceDirectory,
      files,
    });
  }
  payloadReader.mockResolvedValue(payloads);
  const events: IntegrationInstallEvent[] = [];
  const options = {
    payloadDirectory: join(root, "resources"),
    remoteScriptSourcePath: source,
    userLibraryPath: join(root, "Custom User Library"),
    storage: resolveLiveAgentStorage({
      homeDirectory: root,
      profile: "installer-test",
    }),
    remoteScriptVersion: "one",
    confirmed: true,
    assertHostStopped: vi.fn(async () => undefined),
    onEvent: (event: IntegrationInstallEvent) => {
      events.push(event);
    },
  };
  return { root, options, events, payloads };
}

beforeEach(() => {
  payloadReader.mockReset();
  for (const fault of Object.values(fileFaults)) fault.mockReset();
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fault of Object.values(fileFaults)) fault.mockReset();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("typed Ableton integration installation", () => {
  it("installs and verifies real generated canonical native5/ABI3 and portable MIDI resources through the production validator", async () => {
    const { root, options } = await fixture();
    const generated = join(root, "generated-integrations");
    await promisify(execFile)(
      process.execPath,
      ["scripts/build-ableton-integrations.mjs", "--out", generated],
      { cwd: process.cwd() },
    );
    const shared = await vi.importActual<typeof Shared>(
      "@ableton-agent/shared/m4l-devices",
    );
    payloadReader.mockImplementation(shared.readIntegrationDevicePayloads);
    const first = await installAbletonIntegrations({
      ...options,
      payloadDirectory: generated,
    });
    const payloads = await shared.readIntegrationDevicePayloads(generated);
    for (const payload of payloads) {
      const target = first.components.find(
        (item) => item.component === payload.id,
      )!.destination;
      const names = await readdir(target);
      expect(names.sort()).toEqual(
        [
          ...payload.files.map((file) => file.name),
          "agent_signal_storage.js",
          ".ableton-agent-device-install.json",
        ].sort(),
      );
      const metadata = JSON.parse(
        await readFile(
          join(target, ".ableton-agent-device-install.json"),
          "utf8",
        ),
      ) as { nativeVersion?: number; nativeAbiVersion?: number };
      if (payload.id === "machine-listening")
        expect(metadata).toMatchObject({
          nativeVersion: 5,
          nativeAbiVersion: 3,
        });
      if (payload.id === "machine-listening") {
        const portableManifest = await readFile(
          join(payload.sourceDirectory, "audio-listener-manifest.json"),
        );
        const installedManifest = await readFile(
          join(target, "audio-listener-manifest.json"),
        );
        const discovery = JSON.parse(installedManifest.toString("utf8")) as {
          discoveryConfigured: boolean;
          resources: {
            name: string;
            sha256: string;
            bytes: number;
            scope: string;
          }[];
        };
        const configuration = await readFile(
          join(target, "agent_signal_storage.js"),
        );
        expect(discovery.discoveryConfigured).toBe(true);
        expect(discovery.resources.at(-1)).toEqual({
          name: "agent_signal_storage.js",
          sha256: createHash("sha256").update(configuration).digest("hex"),
          bytes: configuration.length,
          scope: "profile",
        });
        expect(
          JSON.parse(portableManifest.toString("utf8")) as {
            discoveryConfigured: boolean;
          },
        ).toMatchObject({ discoveryConfigured: false });
        const receipt = JSON.parse(
          await readFile(
            join(target, ".ableton-agent-device-install.json"),
            "utf8",
          ),
        ) as {
          sourceIdentity: string;
          installedHashes: Record<string, string>;
        };
        expect(receipt.sourceIdentity).toBe(
          hash(JSON.stringify(payload.files)),
        );
        expect(receipt.installedHashes["audio-listener-manifest.json"]).toBe(
          createHash("sha256").update(installedManifest).digest("hex"),
        );
        expect(
          receipt.installedHashes["audio-listener-manifest.json"],
        ).not.toBe(createHash("sha256").update(portableManifest).digest("hex"));
        await promisify(execFile)(
          process.execPath,
          ["scripts/audio-listener-device.mjs", "check-artifact", target],
          { cwd: process.cwd() },
        );
        expect(
          await readFile(
            join(payload.sourceDirectory, "audio-listener-manifest.json"),
          ),
        ).toEqual(portableManifest);
      }
      const device = decodeAmxd(
        await readFile(join(target, payload.deviceFile)),
      );
      if (payload.id === "midi-capture") {
        expect(JSON.stringify(device.document)).toContain(target);
        expect(JSON.stringify(device.document)).not.toContain(
          "__ABLETON_AGENT_MIDI_CAPTURE_DIR__",
        );
      }
    }
    const repeated = await installAbletonIntegrations({
      ...options,
      payloadDirectory: generated,
    });
    expect(repeated.components.every((item) => item.status === "current")).toBe(
      true,
    );
    const otherProfile = resolveLiveAgentStorage({
      homeDirectory: root,
      profile: "listener-profile-change",
    });
    const reconfigured = await installAbletonIntegrations({
      ...options,
      payloadDirectory: generated,
      storage: otherProfile,
      components: ["machine-listening"],
    });
    expect(reconfigured.components[1]!.status).toBe("installed");
    const listenerTarget = reconfigured.components[1]!.destination;
    await promisify(execFile)(
      process.execPath,
      ["scripts/audio-listener-device.mjs", "check-artifact", listenerTarget],
      { cwd: process.cwd() },
    );
    const stable = await installAbletonIntegrations({
      ...options,
      payloadDirectory: generated,
      storage: otherProfile,
      components: ["machine-listening"],
    });
    expect(stable.components[1]!.status).toBe("current");
    await writeFile(
      join(generated, "midi-capture", "midi_capture_writer.js"),
      "// corrupt packaged file",
    );
    await expect(
      installAbletonIntegrations({ ...options, payloadDirectory: generated }),
    ).rejects.toBeInstanceOf(IntegrationInstallError);
    const midiTarget = first.components.find(
      (item) => item.component === "midi-capture",
    )!.destination;
    expect(
      await readFile(join(midiTarget, "midi_capture_writer.js"), "utf8"),
    ).not.toContain("// corrupt packaged file");
  }, 30_000);

  it("supports read-only detection and dry-run without confirmation, host checks, locks or Library creation", async () => {
    const { options, events } = await fixture();
    fileFaults.write.mockClear();
    fileFaults.rename.mockClear();
    fileFaults.remove.mockClear();
    const guard = vi
      .spyOn(hostProcess, "assertAbletonLive11Stopped")
      .mockRejectedValue(new Error("Live running"));
    const result = await inspectAbletonIntegrations(options);
    expect(result.components.map((item) => item.status)).toEqual([
      "missing",
      "missing",
      "missing",
    ]);
    expect(guard).not.toHaveBeenCalled();
    await expect(lstat(options.userLibraryPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    const selected = await installAbletonIntegrations({
      ...options,
      confirmed: false,
      dryRun: true,
      components: ["midi-capture"],
      assertHostStopped: () => hostProcess.assertAbletonLive11Stopped(),
    });
    expect(selected.components.map((item) => item.status)).toEqual([
      "skipped",
      "skipped",
      "planned",
    ]);
    expect(fileFaults.write).not.toHaveBeenCalled();
    expect(fileFaults.rename).not.toHaveBeenCalled();
    expect(fileFaults.remove).not.toHaveBeenCalled();
    expect(
      events.some((event) =>
        /staging|publication|lock|cleanup/u.test(event.name),
      ),
    ).toBe(false);
    await expect(lstat(options.storage.root)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(lstat(options.storage.profileRoot)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await installAbletonIntegrations(options);
    const repeated = await installAbletonIntegrations({
      ...options,
      confirmed: false,
      dryRun: true,
      assertHostStopped: () => hostProcess.assertAbletonLive11Stopped(),
    });
    expect(repeated.components.map((item) => item.status)).toEqual([
      "current",
      "current",
      "current",
    ]);
    expect(guard).not.toHaveBeenCalled();
    payloadReader.mockRejectedValueOnce(new Error("invalid generated payload"));
    await expect(inspectAbletonIntegrations(options)).rejects.toBeInstanceOf(
      IntegrationInstallError,
    );
  });

  it("inspects current, outdated and unmanaged components with the installer's exact receipt/hash/profile rules", async () => {
    const { options, payloads, root } = await fixture();
    const installed = await installAbletonIntegrations(options);
    const remote = installed.components[0]!.destination;
    const machine = installed.components[1]!.destination;
    const midi = installed.components[2]!.destination;
    fileFaults.write.mockClear();
    fileFaults.rename.mockClear();
    fileFaults.remove.mockClear();
    const current = await inspectAbletonIntegrations(options);
    expect(current.components).toEqual(
      installed.components.map((item) => ({ ...item, status: "current" })),
    );
    const otherProfile = await inspectAbletonIntegrations({
      ...options,
      storage: resolveLiveAgentStorage({
        homeDirectory: root,
        profile: "second",
      }),
    });
    expect(otherProfile.components.map((item) => item.status)).toEqual([
      "current",
      "outdated",
      "outdated",
    ]);
    expect(fileFaults.write).not.toHaveBeenCalled();
    expect(fileFaults.rename).not.toHaveBeenCalled();
    expect(fileFaults.remove).not.toHaveBeenCalled();

    await writeFile(
      join(options.remoteScriptSourcePath, "__init__.py"),
      "# new release\n",
    );
    const payload = payloads[0]!;
    await writeFile(
      join(payload.sourceDirectory, payload.deviceFile),
      "device-two",
    );
    payload.files[0] = {
      name: payload.deviceFile,
      sha256: hash("device-two"),
      bytes: 10,
    };
    const outdated = await inspectAbletonIntegrations({
      ...options,
      remoteScriptVersion: "two",
    });
    expect(outdated.components.map((item) => item.status)).toEqual([
      "outdated",
      "outdated",
      "current",
    ]);

    await writeFile(join(machine, "unrelated.txt"), "keep");
    await writeFile(
      join(midi, ".ableton-agent-device-install.json"),
      "{invalid",
    );
    await rm(join(remote, ".ableton-agent-install.json"));
    const unmanaged = await inspectAbletonIntegrations(options);
    expect(unmanaged.components.map((item) => item.status)).toEqual([
      "unmanaged",
      "unmanaged",
      "unmanaged",
    ]);
    expect(await readFile(join(machine, "unrelated.txt"), "utf8")).toBe("keep");
    expect(
      await readFile(join(midi, ".ableton-agent-device-install.json"), "utf8"),
    ).toBe("{invalid");
    expect(await readFile(join(remote, "__init__.py"), "utf8")).toBe("# one\n");
  });

  it("reports unsafe managed destinations as unmanaged without traversing symlinks or mutating other components", async () => {
    const { options, root } = await fixture();
    const installed = await installAbletonIntegrations(options);
    const machine = installed.components[1]!.destination;
    const outside = join(root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "private.txt"), "untouched");
    await rm(machine, { recursive: true });
    await symlink(outside, machine);
    const inspected = await inspectAbletonIntegrations(options);
    expect(inspected.components.map((item) => item.status)).toEqual([
      "current",
      "unmanaged",
      "current",
    ]);
    expect(await readdir(outside)).toEqual(["private.txt"]);
    expect(await readFile(join(outside, "private.txt"), "utf8")).toBe(
      "untouched",
    );
  });

  it("renders MIDI paths with the shared AMXD primitives and records portable versus installed hashes separately", async () => {
    const { options, payloads } = await fixture();
    const midi = payloads[1]!;
    const pathPlaceholder = "__ABLETON_AGENT_MIDI_CAPTURE_DIR__";
    const portable = encodeAmxd(
      { prefix: Buffer.from("ampfmmmmptch"), suffix: Buffer.from("suffix") },
      {
        patcher: {
          boxes: [
            {
              box: {
                text: `node.script "${pathPlaceholder}/midi_capture_writer.js"`,
              },
            },
          ],
        },
      },
    );
    await writeFile(join(midi.sourceDirectory, midi.deviceFile), portable);
    payloadReader.mockResolvedValue([
      payloads[0],
      {
        ...midi,
        pathPlaceholder,
        files: [
          {
            name: midi.deviceFile,
            sha256: createHash("sha256").update(portable).digest("hex"),
            bytes: portable.length,
          },
          midi.files[1],
        ],
      },
    ]);
    const result = await installAbletonIntegrations({
      ...options,
      components: ["midi-capture"],
    });
    const target = result.components[2]!.destination;
    const rendered = await readFile(join(target, midi.deviceFile));
    expect(JSON.stringify(decodeAmxd(rendered).document)).toContain(target);
    expect(JSON.stringify(decodeAmxd(rendered).document)).not.toContain(
      pathPlaceholder,
    );
    const metadata = JSON.parse(
      await readFile(
        join(target, ".ableton-agent-device-install.json"),
        "utf8",
      ),
    ) as { installedHashes: Record<string, string> };
    expect(metadata.installedHashes[midi.deviceFile]).toBe(
      createHash("sha256").update(rendered).digest("hex"),
    );
    expect(metadata.installedHashes[midi.deviceFile]).not.toBe(
      createHash("sha256").update(portable).digest("hex"),
    );
    expect(await readFile(join(midi.sourceDirectory, midi.deviceFile))).toEqual(
      portable,
    );
  });

  it("installs complete dedicated payloads into a custom Library, preserves tokens and unrelated copies, and repeats idempotently", async () => {
    const { options, root } = await fixture();
    const unrelated = join(root, "unrelated.amxd");
    await writeFile(unrelated, "keep");
    const first = await installAbletonIntegrations(options);
    expect(first.components.map((item) => item.status)).toEqual([
      "installed",
      "installed",
      "installed",
    ]);
    const remote = first.components[0]!.destination;
    const token = await readFile(join(remote, ".ableton-agent-token"), "utf8");
    for (const item of first.components.slice(1)) {
      expect(item.destination.startsWith(options.userLibraryPath)).toBe(true);
      const config = await readFile(
        join(item.destination, "agent_signal_storage.js"),
        "utf8",
      );
      expect(config).toContain(options.storage.signalIngressDescriptorPath);
      expect(config).toContain(options.storage.signalIngressSecretPath);
      expect(
        (await lstat(join(item.destination, "agent_signal_storage.js"))).mode &
          0o777,
      ).toBe(0o600);
    }
    const repeated = await installAbletonIntegrations(options);
    expect(repeated.components[0]!.status).toBe("current");
    expect(repeated.components.slice(1).map((item) => item.status)).toEqual([
      "current",
      "current",
    ]);
    expect(await readFile(join(remote, ".ableton-agent-token"), "utf8")).toBe(
      token,
    );
    expect(await readFile(unrelated, "utf8")).toBe("keep");
    expect(await readdir(options.userLibraryPath)).not.toContain(
      ".ableton-agent-integrations.lock",
    );
  });

  it("supports Remote Script-only installation without requiring unselected device artifacts", async () => {
    const { options } = await fixture();
    payloadReader.mockRejectedValue(new Error("device payload absent"));
    const result = await installAbletonIntegrations({
      ...options,
      components: ["remote-script"],
    });
    expect(result.components.map((item) => item.status)).toEqual([
      "installed",
      "skipped",
      "skipped",
    ]);
    expect(payloadReader).not.toHaveBeenCalled();
    expect(options.assertHostStopped).toHaveBeenCalled();
  });

  it("preserves the Remote Script token and backup during a Python/version update and cleans source staging", async () => {
    const { options } = await fixture();
    const first = await installAbletonIntegrations(options);
    const target = first.components[0]!.destination;
    const token = await readFile(join(target, ".ableton-agent-token"), "utf8");
    await writeFile(
      join(options.remoteScriptSourcePath, "__init__.py"),
      "# updated\n",
    );
    const updated = await installAbletonIntegrations({
      ...options,
      remoteScriptVersion: "two",
      components: ["remote-script"],
    });
    expect(updated.components[0]!.status).toBe("installed");
    expect(await readFile(join(target, ".ableton-agent-token"), "utf8")).toBe(
      token,
    );
    expect(await readFile(join(target, "__init__.py"), "utf8")).toBe(
      "# updated\n",
    );
    const backups = join(target, "..", ".ableton-agent-backups");
    const entries = await readdir(backups);
    expect(entries).toHaveLength(1);
    expect(
      await readFile(join(backups, entries[0]!, "__init__.py"), "utf8"),
    ).toBe("# one\n");
    expect(
      (await readdir(join(target, ".."))).some((name) =>
        name.startsWith(".ableton-agent-source-"),
      ),
    ).toBe(false);
  });

  it("updates changed bundled Python without a version bump while preserving the token and allowing owned metadata/pycache", async () => {
    const { options } = await fixture();
    const first = await installAbletonIntegrations({
      ...options,
      components: ["remote-script"],
    });
    const target = first.components[0]!.destination;
    const token = await readFile(join(target, ".ableton-agent-token"), "utf8");
    await mkdir(join(target, "__pycache__"));
    await writeFile(
      join(target, "__pycache__", "__init__.cpython-37.pyc"),
      "runtime-cache",
    );
    const unchanged = await installAbletonIntegrations({
      ...options,
      components: ["remote-script"],
    });
    expect(unchanged.components[0]!.status).toBe("current");
    expect(
      (await inspectAbletonIntegrations(options)).components[0]!.status,
    ).toBe("current");

    await writeFile(
      join(options.remoteScriptSourcePath, "__init__.py"),
      "# development edit, unchanged product version\n",
    );
    await writeFile(
      join(options.remoteScriptSourcePath, "new_resource.py"),
      "# added resource\n",
    );
    const detected = await inspectAbletonIntegrations(options);
    expect(detected.components[0]!.status).toBe("outdated");
    const updated = await installAbletonIntegrations({
      ...options,
      components: ["remote-script"],
    });
    expect(updated.components[0]!.status).toBe("installed");
    expect(await readFile(join(target, "__init__.py"), "utf8")).toBe(
      "# development edit, unchanged product version\n",
    );
    expect(await readFile(join(target, "new_resource.py"), "utf8")).toBe(
      "# added resource\n",
    );
    expect(await readFile(join(target, ".ableton-agent-token"), "utf8")).toBe(
      token,
    );
    const receipt = JSON.parse(
      await readFile(join(target, ".ableton-agent-install.json"), "utf8"),
    ) as { remoteScriptVersion: string };
    expect(receipt.remoteScriptVersion).toBe(options.remoteScriptVersion);
    const repeated = await installAbletonIntegrations({
      ...options,
      components: ["remote-script"],
    });
    expect(repeated.components[0]!.status).toBe("current");
    expect(
      (await inspectAbletonIntegrations(options)).components[0]!.status,
    ).toBe("current");
    const backups = join(target, "..", ".ableton-agent-backups");
    const entries = await readdir(backups);
    expect(entries).toHaveLength(1);
    expect(
      await readFile(join(backups, entries[0]!, "__init__.py"), "utf8"),
    ).toBe("# one\n");
    expect(
      await readFile(
        join(backups, entries[0]!, "__pycache__", "__init__.cpython-37.pyc"),
        "utf8",
      ),
    ).toBe("runtime-cache");
  });

  it("rejects unsafe Remote Script source files before creating a Library", async () => {
    const { options, root } = await fixture();
    const outside = join(root, "external.py");
    await writeFile(outside, "# external\n");
    const entry = join(options.remoteScriptSourcePath, "__init__.py");
    await rm(entry);
    await symlink(outside, entry);
    await expect(installAbletonIntegrations(options)).rejects.toBeInstanceOf(
      IntegrationInstallError,
    );
    await expect(lstat(options.userLibraryPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(outside, "utf8")).toBe("# external\n");
  });

  it("refuses an unmanaged canonical folder and destination symlink while leaving unrelated Library copies untouched", async () => {
    const { options, root } = await fixture();
    const parent = join(
      options.userLibraryPath,
      "Presets",
      "Audio Effects",
      "Max Audio Effect",
    );
    const canonical = join(parent, "Machine-Listening-Development");
    await mkdir(canonical, { recursive: true });
    await writeFile(join(canonical, "user.amxd"), "keep");
    const duplicate = join(parent, "Machine-Listening-Development.amxd");
    await writeFile(duplicate, "old copy");
    await expect(installAbletonIntegrations(options)).rejects.toBeInstanceOf(
      IntegrationInstallError,
    );
    expect(await readFile(join(canonical, "user.amxd"), "utf8")).toBe("keep");
    await rm(canonical, { recursive: true });
    const outside = join(root, "outside");
    await mkdir(outside);
    await symlink(outside, canonical);
    await expect(installAbletonIntegrations(options)).rejects.toBeInstanceOf(
      IntegrationInstallError,
    );
    expect(await readdir(outside)).toEqual([]);
    expect(await readFile(duplicate, "utf8")).toBe("old copy");
    await expect(
      lstat(join(options.userLibraryPath, "Remote Scripts")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("updates validated source identity and rerenders changed profile discovery paths without reading secrets", async () => {
    const { options, payloads, root } = await fixture();
    const initial = await installAbletonIntegrations(options);
    const machine = payloads[0]!;
    await writeFile(
      join(machine.sourceDirectory, machine.deviceFile),
      "device-two",
    );
    machine.files[0] = {
      name: machine.deviceFile,
      sha256: hash("device-two"),
      bytes: 10,
    };
    const second = await installAbletonIntegrations({
      ...options,
      storage: resolveLiveAgentStorage({
        homeDirectory: root,
        profile: "second",
      }),
    });
    expect(
      second.components.slice(1).every((item) => item.status === "installed"),
    ).toBe(true);
    expect(
      await readFile(
        join(initial.components[1]!.destination, machine.deviceFile),
        "utf8",
      ),
    ).toBe("device-two");
    const metadata = JSON.parse(
      await readFile(
        join(
          initial.components[1]!.destination,
          ".ableton-agent-device-install.json",
        ),
        "utf8",
      ),
    ) as { sourceIdentity: string; installedHashes: Record<string, string> };
    expect(metadata.sourceIdentity).toMatch(/^[a-f0-9]{64}$/u);
    expect(metadata.installedHashes["agent_signal_storage.js"]).toMatch(
      /^[a-f0-9]{64}$/u,
    );
  });

  it("refuses unconfirmed, running Live (including devices-only), and corrupted payloads before mutation", async () => {
    const { options } = await fixture();
    await expect(
      installAbletonIntegrations({ ...options, confirmed: false }),
    ).rejects.toBeInstanceOf(IntegrationInstallError);
    expect(options.assertHostStopped).not.toHaveBeenCalled();
    await expect(
      installAbletonIntegrations({
        ...options,
        components: ["machine-listening"],
        assertHostStopped: async () => {
          throw new Error("Live running");
        },
      }),
    ).rejects.toBeInstanceOf(IntegrationInstallError);
    payloadReader.mockRejectedValue(new Error("corrupt artifact"));
    await expect(installAbletonIntegrations(options)).rejects.toBeInstanceOf(
      IntegrationInstallError,
    );
    await expect(lstat(options.userLibraryPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses source changes after preflight validation", async () => {
    const { options, payloads } = await fixture();
    await writeFile(
      join(payloads[1]!.sourceDirectory, payloads[1]!.deviceFile),
      "corrupt",
    );
    await expect(installAbletonIntegrations(options)).rejects.toBeInstanceOf(
      IntegrationInstallError,
    );
    await expect(lstat(options.userLibraryPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("leaves unmanaged collisions and modified managed files untouched", async () => {
    const { options } = await fixture();
    const first = await installAbletonIntegrations(options);
    const target = first.components[1]!.destination;
    await writeFile(join(target, "unrelated.txt"), "keep");
    await expect(installAbletonIntegrations(options)).rejects.toBeInstanceOf(
      IntegrationInstallError,
    );
    expect(await readFile(join(target, "unrelated.txt"), "utf8")).toBe("keep");
    await rm(join(target, "unrelated.txt"));
    await writeFile(
      join(target, "Machine-Listening-Development.amxd"),
      "user-modified",
    );
    await expect(installAbletonIntegrations(options)).rejects.toBeInstanceOf(
      IntegrationInstallError,
    );
    expect(
      await readFile(
        join(target, "Machine-Listening-Development.amxd"),
        "utf8",
      ),
    ).toBe("user-modified");
  });

  it("rejects Library, destination and Remote Script token symlinks without following them", async () => {
    const { options, root } = await fixture();
    const outside = join(root, "outside");
    await mkdir(outside);
    await symlink(outside, options.userLibraryPath);
    await expect(installAbletonIntegrations(options)).rejects.toBeInstanceOf(
      IntegrationInstallError,
    );
    expect(await readdir(outside)).toEqual([]);
    await rm(options.userLibraryPath);
    const first = await installAbletonIntegrations(options);
    const token = join(
      first.components[0]!.destination,
      ".ableton-agent-token",
    );
    await rm(token);
    await symlink(join(outside, "secret"), token);
    await expect(installAbletonIntegrations(options)).rejects.toBeInstanceOf(
      IntegrationInstallError,
    );
  });

  it("cancels before publication, cleans staging and lock, and preserves the prior component", async () => {
    const { options, payloads } = await fixture();
    const first = await installAbletonIntegrations(options);
    const machine = payloads[0]!;
    await writeFile(
      join(machine.sourceDirectory, machine.deviceFile),
      "device-two",
    );
    machine.files[0] = {
      name: machine.deviceFile,
      sha256: hash("device-two"),
      bytes: 10,
    };
    const abort = new AbortController();
    await expect(
      installAbletonIntegrations({
        ...options,
        components: ["machine-listening"],
        signal: abort.signal,
        onEvent: (event) => {
          if (
            event.name === "integrations.staging" &&
            event.stage === "completed"
          )
            abort.abort();
        },
      }),
    ).rejects.toMatchObject({ cancelled: true });
    const target = first.components[1]!.destination;
    expect(await readFile(join(target, machine.deviceFile), "utf8")).toBe(
      "device-one",
    );
    expect(
      (await readdir(join(target, ".."))).filter((name) =>
        name.startsWith(".ableton-agent"),
      ),
    ).toEqual([]);
    expect(await readdir(options.userLibraryPath)).not.toContain(
      ".ableton-agent-integrations.lock",
    );
  });

  it("rejects conflicting concurrent runs and never removes another run's lock", async () => {
    const { options } = await fixture();
    let unblock!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((done) => {
      entered = done;
    });
    let guards = 0;
    const running = installAbletonIntegrations({
      ...options,
      assertHostStopped: async () => {
        guards++;
        if (guards === 2) {
          entered();
          await new Promise<void>((done) => {
            unblock = done;
          });
        }
      },
    });
    await waiting;
    await expect(installAbletonIntegrations(options)).rejects.toBeInstanceOf(
      IntegrationInstallError,
    );
    expect(
      (
        await lstat(
          join(options.userLibraryPath, ".ableton-agent-integrations.lock"),
        )
      ).isDirectory(),
    ).toBe(true);
    unblock();
    await running;
  });

  it("retains committed partial outcomes when a later guard fails and keeps event data bounded and secret-free", async () => {
    const { options, events } = await fixture();
    let calls = 0;
    let failure: IntegrationInstallError | undefined;
    try {
      await installAbletonIntegrations({
        ...options,
        assertHostStopped: async () => {
          if (++calls === 3) throw new Error("token=super-secret");
        },
      });
    } catch (error) {
      failure = error as IntegrationInstallError;
    }
    expect(failure?.components).toMatchObject([
      { component: "remote-script", status: "installed" },
      { component: "machine-listening", status: "failed", committed: false },
    ]);
    expect(events[0]).toMatchObject({
      name: "integrations.install",
      stage: "queued",
    });
    expect(events.at(-1)).toMatchObject({
      name: "integrations.install",
      stage: "failed",
    });
    expect(
      events.every(
        (event) => Number.isFinite(event.durationMs) && event.durationMs >= 0,
      ),
    ).toBe(true);
    expect(JSON.stringify(events)).not.toContain("super-secret");
    expect(JSON.stringify(events)).not.toContain(
      options.storage.signalIngressSecretPath,
    );
  });

  it("fails closed on event callback failure, reports already-committed outcomes and cleans locks", async () => {
    const { options } = await fixture();
    let failure: IntegrationInstallError | undefined;
    try {
      await installAbletonIntegrations({
        ...options,
        onEvent: (event) => {
          if (
            event.name === "integrations.publication" &&
            event.stage === "completed"
          )
            throw new Error("journal unavailable");
        },
      });
    } catch (error) {
      failure = error as IntegrationInstallError;
    }
    expect(failure?.components[0]).toMatchObject({
      component: "remote-script",
      status: "failed",
      committed: true,
    });
    expect(failure?.failures.length).toBeGreaterThan(0);
    expect(await readdir(options.userLibraryPath)).not.toContain(
      ".ableton-agent-integrations.lock",
    );
  });

  it.each(["write", "rename"] as const)(
    "preserves the previous device after deterministic %s failure and cleans staging",
    async (kind) => {
      const { options, payloads } = await fixture();
      const first = await installAbletonIntegrations(options);
      const device = payloads[0]!;
      await writeFile(
        join(device.sourceDirectory, device.deviceFile),
        "device-two",
      );
      device.files[0] = {
        name: device.deviceFile,
        sha256: hash("device-two"),
        bytes: 10,
      };
      fileFaults[kind].mockImplementation((path: string) => {
        if (path.includes(".ableton-agent-stage-")) {
          throw Object.assign(new Error("injected filesystem denial"), {
            code: "EACCES",
          });
        }
      });
      let failure: IntegrationInstallError | undefined;
      try {
        await installAbletonIntegrations({
          ...options,
          components: ["machine-listening"],
        });
      } catch (error) {
        failure = error as IntegrationInstallError;
      }
      expect(failure?.components.at(-1)).toEqual({
        component: "machine-listening",
        status: "failed",
        destination: first.components[1]!.destination,
        committed: false,
      });
      expect(
        await readFile(
          join(first.components[1]!.destination, device.deviceFile),
          "utf8",
        ),
      ).toBe("device-one");
      expect(
        (await readdir(join(first.components[1]!.destination, ".."))).filter(
          (name) => name.startsWith(".ableton-agent"),
        ),
      ).toEqual([]);
    },
  );

  it("retains rollback and cleanup errors rather than claiming everything was unchanged", async () => {
    const { options, payloads } = await fixture();
    await installAbletonIntegrations(options);
    const device = payloads[0]!;
    await writeFile(
      join(device.sourceDirectory, device.deviceFile),
      "device-two",
    );
    device.files[0] = {
      name: device.deviceFile,
      sha256: hash("device-two"),
      bytes: 10,
    };
    fileFaults.rename.mockImplementation((path: string) => {
      if (
        path.includes(".ableton-agent-stage-") ||
        path.includes(".ableton-agent-previous-")
      )
        throw new Error("rename denied");
    });
    fileFaults.remove.mockImplementation((path: string) => {
      if (path.includes(".ableton-agent-stage-"))
        throw new Error("cleanup denied");
    });
    let failure: IntegrationInstallError | undefined;
    try {
      await installAbletonIntegrations({
        ...options,
        components: ["machine-listening"],
      });
    } catch (error) {
      failure = error as IntegrationInstallError;
    }
    expect(failure).toBeInstanceOf(IntegrationInstallError);
    expect(failure?.failures.length).toBe(3);
    expect(failure?.components.at(-1)).toMatchObject({
      component: "machine-listening",
      status: "failed",
    });
  });

  it("reports completed commits truthfully even when cancellation arrives after publication", async () => {
    const { options } = await fixture();
    const abort = new AbortController();
    const events: IntegrationInstallEvent[] = [];
    const result = await installAbletonIntegrations({
      ...options,
      components: ["midi-capture"],
      signal: abort.signal,
      onEvent: (event) => {
        events.push(event);
        if (
          event.name === "integrations.publication" &&
          event.stage === "completed"
        )
          abort.abort();
      },
    });
    expect(
      result.components.find((item) => item.component === "midi-capture")
        ?.status,
    ).toBe("installed");
    expect(events.at(-1)?.stage).toBe("completed");
    expect(events.some((event) => event.stage === "cancelled")).toBe(false);
  });

  it("orders each validation, staging, publication and verification lifecycle", async () => {
    const { options, events } = await fixture();
    await installAbletonIntegrations(options);
    const machine = events.filter(
      (event) => event.component === "machine-listening",
    );
    for (const name of [
      "validation",
      "staging",
      "publication",
      "verification",
    ]) {
      const stages = machine
        .filter((event) => event.name === `integrations.${name}`)
        .map((event) => event.stage);
      expect(stages[0]).toBe("queued");
      expect(stages[1]).toBe("started");
      expect(stages.at(-1)).toBe("completed");
      const durations = machine
        .filter((event) => event.name === `integrations.${name}`)
        .map((event) => event.durationMs);
      expect(durations).toEqual([...durations].sort((a, b) => a - b));
    }
    const publication = machine.findIndex(
      (event) =>
        event.name === "integrations.publication" &&
        event.stage === "completed",
    );
    const verification = machine.findIndex(
      (event) =>
        event.name === "integrations.verification" && event.stage === "started",
    );
    expect(verification).toBeGreaterThan(publication);
    expect(
      Math.max(...events.map((event) => JSON.stringify(event).length)),
    ).toBeLessThan(1024);
  });
});
