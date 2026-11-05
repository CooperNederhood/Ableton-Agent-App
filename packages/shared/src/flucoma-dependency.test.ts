import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  FLUCOMA_DEPENDENCY_FILES,
  FLUCOMA_DEPENDENCY_RESOURCE_NAMES,
  FLUCOMA_PACKAGE_VERSION,
  isSafeDeviceResourceName,
  readFlucomaDependencyFile,
  validateFlucomaDependency,
  validateNativeMelSourceInputs,
  NATIVE_MEL_BUNDLE,
  NATIVE_MEL_PRODUCER,
} from "./flucoma-dependency.js";
import { NATIVE_MEL_SOURCE_INPUTS } from "./native-mel-pins.js";
import {
  publishResources,
  decodeAmxd,
  encodeAmxd,
  freezeAmxd,
} from "./max-device.js";
import type { ResourcePublicationEvent } from "./max-device.js";

const source = resolve("max-patches/audio-listener");
const scratch = resolve(".test-artifacts/flucoma-dependency", randomUUID());
const executable = FLUCOMA_DEPENDENCY_FILES.find(
  (file) => file.mode === 0o755,
)!;
afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function fixture(): Promise<string> {
  const root = join(scratch, randomUUID());
  await mkdir(root, { recursive: true });
  await cp(join(source, "dependencies"), join(root, "dependencies"), {
    recursive: true,
  });
  return root;
}

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "validates the exact dependency subtree without enumerating unrelated source files",
  async () => {
    const root = await fixture();
    await chmod(root, 0o111);
    try {
      await validateFlucomaDependency(root);
    } finally {
      await chmod(root, 0o755);
    }
  },
);

it("preserves stock universal pins alongside the app-owned native mel dependency", async () => {
  await validateFlucomaDependency(source);
  expect(FLUCOMA_DEPENDENCY_FILES).toHaveLength(17);
  expect(
    FLUCOMA_DEPENDENCY_FILES.reduce((total, file) => total + file.bytes, 0),
  ).toBeLessThan(1_000_000);
  const version = JSON.parse(
    (
      await readFlucomaDependencyFile(
        source,
        "dependencies/flucoma/package-info.json",
      )
    ).toString("utf8"),
  ) as { version: string };
  expect(version.version).toBe(FLUCOMA_PACKAGE_VERSION);
  const binary = await readFlucomaDependencyFile(source, executable.name);
  expect(binary.readUInt32BE(0)).toBe(0xcafebabe);
  expect(binary.readUInt32BE(4)).toBe(2);
  expect([binary.readUInt32BE(8), binary.readUInt32BE(28)].sort()).toEqual([
    0x01000007, 0x0100000c,
  ]);
});

it("publishes the exact nested bundle and executable mode with attributable lifecycle", async () => {
  const events: ResourcePublicationEvent[] = [];
  const target = join(scratch, "published");
  await publishResources({
    destinationDirectory: target,
    resources: FLUCOMA_DEPENDENCY_RESOURCE_NAMES.map((fileName) => ({
      fileName,
      source: join(source, fileName),
    })),
    traceId: "trace",
    correlationId: "correlation",
    causationId: "cause",
    onEvent: (event) => events.push(event),
  });
  await validateFlucomaDependency(target);
  expect((await lstat(join(target, executable.name))).mode & 0o777).toBe(0o755);
  expect(events.map((event) => event.stage)).toEqual([
    "queued",
    "started",
    ...Array.from(
      { length: FLUCOMA_DEPENDENCY_FILES.length },
      () => "progress",
    ),
    "completed",
  ]);
  for (const event of events) {
    expect(event).toMatchObject({
      traceId: "trace",
      correlationId: "correlation",
      causationId: "cause",
    });
    expect(event.durationMs).toBeGreaterThanOrEqual(0);
  }
});

it("pins the universal app-owned binary, ABI, notices, provenance and exact source inputs", async () => {
  const name = `${NATIVE_MEL_BUNDLE}/Contents/MacOS/listener.mel~`;
  const binary = await readFlucomaDependencyFile(source, name);
  expect(binary.readUInt32BE(0)).toBe(0xcafebabe);
  expect(binary.readUInt32BE(4)).toBe(2);
  expect([binary.readUInt32BE(8), binary.readUInt32BE(28)].sort()).toEqual([
    0x01000007, 0x0100000c,
  ]);
  expect(createHash("sha256").update(binary).digest("hex")).toBe(
    NATIVE_MEL_PRODUCER.binarySha256,
  );
  const provenance = JSON.parse(
    (
      await readFlucomaDependencyFile(
        source,
        "dependencies/flucoma/listener-mel-build.json",
      )
    ).toString("utf8"),
  ) as Record<string, unknown>;
  expect(provenance).toMatchObject({
    schema: "listener-mel-native-build/v1",
    producerAbi: 2,
    architectures: ["arm64", "x86_64"],
    deploymentTarget: "11.0",
    binarySha256: NATIVE_MEL_PRODUCER.binarySha256,
    inputs: NATIVE_MEL_SOURCE_INPUTS,
    hostQualified: false,
  });
  await validateNativeMelSourceInputs(resolve("."));
  const copy = join(scratch, "source-copy");
  for (const input of NATIVE_MEL_SOURCE_INPUTS) {
    const target = join(copy, input.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, await readFile(resolve(input.path)));
  }
  await validateNativeMelSourceInputs(copy);
  await writeFile(
    join(copy, NATIVE_MEL_SOURCE_INPUTS[0].path),
    "changed source",
  );
  await expect(validateNativeMelSourceInputs(copy)).rejects.toThrow(
    /source pin/,
  );
});

it.each([
  "listener.mel~.mxo/Contents/MacOS/listener.mel~",
  "listener.mel~.mxo/Contents/Resources/licenses/source-pins.json",
  "listener.mel~.mxo/Contents/Resources/licenses/Eigen-MPL2.txt",
  "listener-mel-build.json",
])(
  "rejects altered native mel resource %s independently of a payload manifest",
  async (relative) => {
    const root = await fixture();
    const path = join(root, "dependencies/flucoma", relative);
    const raw = await readFile(path);
    raw[10] = raw[10]! ^ 1;
    await writeFile(path, raw);
    await expect(validateFlucomaDependency(root)).rejects.toThrow(/mismatch/);
  },
);

it("requires the pinned adjacent native bundle even without a stock analyzer", async () => {
  const template = await readFile(join(source, "audio-effect-template.amxd"));
  const raw = encodeAmxd(decodeAmxd(template), {
    patcher: {
      boxes: [{ box: { maxclass: "newobj", text: "listener.mel~" } }],
      lines: [],
    },
  });
  expect(() =>
    freezeAmxd(raw, "Listener.amxd", new Map(), {
      deviceDirectory: scratch,
    }),
  ).toThrow(/Missing pinned adjacent/);
});

it.each([
  "missing",
  "tampered",
  "extra",
  "sibling",
  "file-link",
  "parent-link",
  "mode",
])("rejects %s dependency input without publishing", async (failure) => {
  const root = await fixture();
  const file = join(root, executable.name);
  if (failure === "missing") await rm(file);
  if (failure === "mode") await chmod(file, 0o644);
  if (failure === "tampered") {
    const bytes = await readFile(file);
    bytes[100] = bytes[100]! ^ 1;
    await writeFile(file, bytes);
  }
  if (failure === "extra")
    await writeFile(
      join(root, "dependencies/flucoma/unpinned.js"),
      "unexpected",
    );
  if (failure === "sibling")
    await writeFile(join(root, "dependencies/unpinned.js"), "unexpected");
  if (failure === "file-link") {
    await rm(file);
    await symlink(join(source, executable.name), file);
  }
  if (failure === "parent-link") {
    await rm(dirname(file), { recursive: true });
    await symlink(dirname(join(source, executable.name)), dirname(file));
  }
  await expect(validateFlucomaDependency(root)).rejects.toThrow();
  if (failure !== "extra" && failure !== "sibling") {
    const events: ResourcePublicationEvent[] = [];
    const target = join(scratch, "rejected");
    await expect(
      publishResources({
        destinationDirectory: target,
        resources: [{ fileName: executable.name, source: file }],
        onEvent: (event) => events.push(event),
      }),
    ).rejects.toThrow();
    expect(events.map((event) => event.stage)).toEqual([
      "queued",
      "started",
      "failed",
    ]);
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  }
});

it.each([
  "../escape",
  "/escape",
  "dependencies/flucoma/../../escape",
  "arbitrary/child.js",
  "dependencies\\flucoma\\LICENSE.md",
])("does not generalize nested access to %s", async (fileName) => {
  expect(isSafeDeviceResourceName(fileName)).toBe(false);
  await expect(
    publishResources({
      destinationDirectory: join(scratch, "rejected"),
      resources: [{ fileName, source: join(source, executable.name) }],
    }),
  ).rejects.toThrow(/resource names/i);
});

it("refuses linked output ancestors without writing outside the output", async () => {
  const outside = join(scratch, "outside");
  const target = join(scratch, "target");
  await mkdir(outside, { recursive: true });
  await mkdir(target);
  await symlink(outside, join(target, "dependencies"));
  await expect(
    publishResources({
      destinationDirectory: target,
      resources: [
        { fileName: executable.name, source: join(source, executable.name) },
      ],
    }),
  ).rejects.toThrow(/parent/);
  expect(await readdir(outside)).toEqual([]);
});

it("cancels nested publication with no staged-file residue", async () => {
  const target = join(scratch, "cancelled");
  const controller = new AbortController();
  const events: ResourcePublicationEvent[] = [];
  await expect(
    publishResources({
      destinationDirectory: target,
      resources: FLUCOMA_DEPENDENCY_RESOURCE_NAMES.map((fileName) => ({
        fileName,
        source: join(source, fileName),
      })),
      signal: controller.signal,
      onEvent: (event) => {
        events.push(event);
        if (event.stage === "progress") controller.abort();
      },
    }),
  ).rejects.toThrow();
  expect(events.map((event) => event.stage)).toEqual([
    "queued",
    "started",
    "progress",
    "cancelled",
  ]);
  expect(await readdir(join(target, "dependencies/flucoma"))).toEqual([
    "LICENSE.md",
  ]);
});

it("keeps signed native dependencies adjacent rather than falsely freezing them as text", async () => {
  const resources = new Map<string, Buffer>();
  for (const name of FLUCOMA_DEPENDENCY_RESOURCE_NAMES)
    resources.set(name, await readFlucomaDependencyFile(source, name));
  const template = await readFile(join(source, "audio-effect-template.amxd"));
  const analyzerWithoutPins = encodeAmxd(decodeAmxd(template), {
    patcher: {
      boxes: [{ box: { maxclass: "newobj", text: "fluid.spectralshape~" } }],
      lines: [],
    },
  });
  expect(() =>
    freezeAmxd(analyzerWithoutPins, "Listener.amxd", new Map(), {
      deviceDirectory: join(scratch, "missing-pins"),
    }),
  ).toThrow("Missing pinned adjacent FluCoMa dependency resources");
  const deviceDirectory = join(scratch, "final-device");
  expect(() => freezeAmxd(template, "Listener.amxd", resources)).toThrow(
    "Explicit final device directory",
  );
  for (const invalid of ["", "relative", "/", `${deviceDirectory}/../other`])
    expect(() =>
      freezeAmxd(template, "Listener.amxd", resources, {
        deviceDirectory: invalid,
      }),
    ).toThrow("Explicit final device directory");
  const frozen = freezeAmxd(template, "Listener.amxd", resources, {
    deviceDirectory,
  });
  expect(decodeAmxd(frozen).frozenFiles).toHaveLength(1);
  expect(decodeAmxd(frozen).document).toMatchObject({
    patcher: {
      project: {
        searchpath: {
          "0": {
            bootpath: join(deviceDirectory, "dependencies/flucoma"),
            enabled: 1,
            recursive: 0,
            includeincollective: 0,
          },
        },
      },
    },
  });
  expect(JSON.stringify(decodeAmxd(frozen).document)).not.toContain(
    "projectrelativepath",
  );
  expect(
    freezeAmxd(template, "Listener.amxd", resources, { deviceDirectory }),
  ).toEqual(frozen);
  expect(
    freezeAmxd(template, "Listener.amxd", resources, {
      deviceDirectory: join(scratch, "other-device"),
    }),
  ).not.toEqual(frozen);
  const changed = Buffer.from(resources.get(executable.name)!);
  changed[100] = changed[100]! ^ 1;
  expect(createHash("sha256").update(changed).digest("hex")).not.toBe(
    executable.sha256,
  );
  resources.set(executable.name, changed);
  expect(() => freezeAmxd(template, "Listener.amxd", resources)).toThrow(
    /Pinned FluCoMa/,
  );
});
