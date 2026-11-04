import { createHash, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { existsSync } from "node:fs";
import {
  access,
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
import { gzipSync, gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { resolveLiveAgentStorage } from "@ableton-agent/storage";
import {
  decodeAmxd,
  encodeAmxd,
  FLUCOMA_DEPENDENCY_FILES,
} from "@ableton-agent/shared/m4l-devices";
import {
  planSavedListeningFixture,
  stageSavedListeningFixture,
} from "./saved-listening-fixture.mjs";
import { runRestrictiveUmaskChild } from "./umask-child-test-support.js";

const namespace = resolve(".test-artifacts/independent-metric-listening");
const roots = [];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

function aiff() {
  const pcm = Buffer.from([0x12, 0x34, 0xab, 0xcd]);
  const bytes = Buffer.alloc(58);
  bytes.write("FORM");
  bytes.writeUInt32BE(50, 4);
  bytes.write("AIFFCOMM", 8);
  bytes.writeUInt32BE(18, 16);
  bytes.writeUInt16BE(2, 20);
  bytes.writeUInt32BE(1, 22);
  bytes.writeUInt16BE(16, 26);
  Buffer.from("400eac44000000000000", "hex").copy(bytes, 28);
  bytes.write("SSND", 38);
  bytes.writeUInt32BE(12, 42);
  pcm.copy(bytes, 54);
  return bytes;
}

function ref(type, relative, path) {
  return `<FileRef><RelativePathType Value="${type}" /><RelativePath Value="${relative}" /><Path Value="${path}" /><OriginalFileSize Value="0" /></FileRef>`;
}

async function fixture() {
  const id = randomUUID();
  const root = join(namespace, `saved-input-${id}`);
  const destination = join(namespace, `candidate-unit-${id}`);
  roots.push(root, destination);
  const project = join(root, "readonly-project");
  const original = join(root, "user-original");
  const factory = join(root, "Core Library");
  const directory = join(root, "reviewed-synthetic-bundle");
  await mkdir(join(project, "Samples"), { recursive: true });
  await mkdir(join(project, "Presets"));
  await mkdir(join(factory, "Presets"), { recursive: true });
  await mkdir(directory);
  const audio = aiff();
  const oldDevice = Buffer.from(
    "SYNTHETIC old v4 bytes; never loaded or decoded",
  );
  const preset = Buffer.from(
    "SYNTHETIC immutable factory preset; never loaded",
  );
  await writeFile(join(project, "Samples/tone.aif"), audio);
  await writeFile(join(project, "Presets/Old.amxd"), oldDevice);
  await writeFile(join(factory, "Presets/Factory.adg"), preset);
  const history = ref(
    "1",
    "../../../../historical/Library",
    "/../../../historical/Library",
  );
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Ableton Creator="Ableton Live 11.3.43"><LiveSet><Tracks>
<AudioTrack><Clip><WarpMarker BeatTime="0.125" SecTime="0.5" />${ref("3", "Samples/tone.aif", `${original}/Samples/tone.aif`)}</Clip>
${ref("6", "Presets/Old.amxd", "/reviewed-user-library/Old.amxd")}</AudioTrack>
<MidiTrack><Notes><MidiNoteEvent Time="0.25" Duration="0.5" Key="60" Velocity="96" /></Notes>
${ref("5", "Presets/Factory.adg", join(factory, "Presets/Factory.adg"))}
<LastPresetRef>${history}</LastPresetRef>${ref("0", "", "")}</MidiTrack>
</Tracks><Routing Value="Master" /><Tempo Value="128" /></LiveSet></Ableton>`;
  const sourceSet = join(project, "Synthetic.als");
  await writeFile(sourceSet, gzipSync(xml));
  const input = {
    sourceProject: project,
    originalProjectPrefix: original,
    sourceSet,
    sourceSetSha256: hash(await readFile(sourceSet)),
    expected: {
      creator: "Ableton Live 11.3.43",
      fileReferences: 5,
      audioTracks: 1,
      midiTracks: 1,
      deviceReferences: 1,
    },
    projectFiles: [
      { relativePath: "Samples/tone.aif", sha256: hash(audio) },
      { relativePath: "Presets/Old.amxd", sha256: hash(oldDevice) },
    ],
    device: {
      relativePath: "Presets/Old.amxd",
      absolutePath: "/reviewed-user-library/Old.amxd",
      sha256: hash(oldDevice),
    },
    factoryRoots: [factory],
    externalFiles: [
      { path: join(factory, "Presets/Factory.adg"), sha256: hash(preset) },
    ],
    historicalReferences: [{ index: 3, sha256: hash(history) }],
  };
  const resources = [
    ["Candidate.amxd", ["device"]],
    ["audio_listener_native_v5_max.js", ["controller"]],
    ["audio_listener_guard.js", ["guard"]],
    ["producer_identity_common.js", ["identity"]],
    ["agent_signal_client_common.js", ["signal-client"]],
    ["clock.maxpat", ["clock"]],
    ["analysis.maxpat", ["analysis", "detector-input"]],
  ];
  const manifest = {
    schema: "saved-listening-native-bundle/v1",
    nativeVersion: 5,
    guardNativeVersion: 5,
    observationSchema: "metric-audio-observation/v1",
    provenance: {
      kind: "synthetic-test",
      reviewId: "unit-test-not-loaded-code",
    },
    deviceFile: "Candidate.amxd",
    resources: [],
  };
  for (const [name, roles] of resources) {
    const bytes = Buffer.from(`SYNTHETIC ${name}; never executed or loaded`);
    await writeFile(join(directory, name), bytes);
    manifest.resources.push({
      name,
      roles,
      sha256: hash(bytes),
      bytes: bytes.length,
    });
  }
  const bundle = {
    directory,
    manifestFile: "manifest.json",
    requiredCompanions: resources.slice(1).map(([name]) => name),
  };
  const saveManifest = async () => {
    const bytes = Buffer.from(JSON.stringify(manifest));
    await writeFile(join(directory, bundle.manifestFile), bytes);
    bundle.manifestSha256 = hash(bytes);
  };
  await saveManifest();
  const storage = resolveLiveAgentStorage({
    environment: {
      LIVE_AGENT_HOME: join(root, "isolated-home"),
      LIVE_AGENT_PROFILE: "fixture-test",
    },
  });
  const options = { input, destination, bundle, storage };
  return {
    ...options,
    root,
    audio,
    oldDevice,
    xml,
    manifest,
    saveManifest,
    async changeXml(change) {
      const bytes = gzipSync(change(xml));
      await writeFile(sourceSet, bytes);
      input.sourceSetSha256 = hash(bytes);
    },
  };
}

async function pinnedSavedFixture() {
  const f = await fixture();
  const device = encodeAmxd(
    decodeAmxd(
      await readFile(
        resolve("max-patches/audio-listener/audio-effect-template.amxd"),
      ),
    ),
    {
      patcher: {
        boxes: [],
        lines: [],
        project: {
          searchpath: {
            0: {
              bootpath: "./dependencies/flucoma",
              projectrelativepath: "./dependencies/flucoma",
            },
          },
        },
      },
    },
  );
  await writeFile(join(f.bundle.directory, f.manifest.deviceFile), device);
  Object.assign(
    f.manifest.resources.find((file) => file.name === f.manifest.deviceFile),
    {
      sha256: hash(device),
      bytes: device.length,
    },
  );
  await cp(
    resolve("max-patches/audio-listener/dependencies"),
    join(f.bundle.directory, "dependencies"),
    { recursive: true },
  );
  for (const { name, bytes, sha256 } of FLUCOMA_DEPENDENCY_FILES) {
    f.manifest.resources.push({ name, bytes, sha256, roles: ["companion"] });
    f.bundle.requiredCompanions.push(name);
  }
  await f.saveManifest();
  return f;
}

describe("reviewed saved Set offline preparation", () => {
  it("preserves pinned modes under restrictive umask in an isolated saved stager process", async () => {
    const f = await pinnedSavedFixture();
    const options = {
      input: f.input,
      destination: f.destination,
      bundle: f.bundle,
      storage: f.storage,
    };
    const stdout = await runRestrictiveUmaskChild(`
        import assert from "node:assert/strict";
        import { stat } from "node:fs/promises";
        import { join } from "node:path";
        import { stageSavedListeningFixture } from "./scripts/lib/saved-listening-fixture.mjs";
        import { FLUCOMA_DEPENDENCY_FILES, validateFlucomaDependency } from "@ableton-agent/shared/m4l-devices";
        assert.equal(process.umask(), 0o077);
        const options = ${JSON.stringify(options)};
        const staged = await stageSavedListeningFixture(options);
        try {
          const target = join(options.destination, "Native-Listener-Candidate");
          await validateFlucomaDependency(target);
          for (const pin of FLUCOMA_DEPENDENCY_FILES)
            assert.equal((await stat(join(target, pin.name))).mode & 0o777, pin.mode, pin.name);
          assert.equal((await stat(join(target, "agent_signal_storage.js"))).mode & 0o777, 0o600);
          await staged.verifyImmutableInputs();
          console.log("umask-verified");
        } finally { await staged.cleanup(); }
      `);
    expect(stdout.trim()).toBe("umask-verified");
    await expect(access(f.destination)).rejects.toThrow();
  });

  it("preserves pinned nested FluCoMa saved-bundle resources and executable mode", async () => {
    const f = await pinnedSavedFixture();
    const staged = await stageSavedListeningFixture(f);
    const candidate = join(f.destination, "Native-Listener-Candidate");
    const bound = await readFile(join(candidate, f.manifest.deviceFile));
    expect(decodeAmxd(bound).document).toMatchObject({
      patcher: {
        project: {
          searchpath: {
            0: { bootpath: join(candidate, "dependencies/flucoma") },
          },
        },
      },
    });
    expect(JSON.stringify(decodeAmxd(bound).document)).not.toContain(
      "projectrelativepath",
    );
    const sourceHash = f.manifest.resources.find(
      (file) => file.name === f.manifest.deviceFile,
    ).sha256;
    expect(staged.dependencyBinding).toMatchObject({
      sourceDeviceSha256: sourceHash,
      deviceSha256: hash(bound),
    });
    expect(hash(bound)).not.toBe(sourceHash);
    expect(
      hash(await readFile(join(f.bundle.directory, f.manifest.deviceFile))),
    ).toBe(sourceHash);
    for (const pin of FLUCOMA_DEPENDENCY_FILES) {
      expect(hash(await readFile(join(candidate, pin.name)))).toBe(pin.sha256);
      expect((await lstat(join(candidate, pin.name))).mode & 0o777).toBe(
        pin.mode,
      );
    }
    await expect(staged.verifyImmutableInputs()).resolves.toMatchObject({
      verified: true,
    });
    await staged.cleanup();
    await expect(access(f.destination)).rejects.toThrow();
  });
  it.each([
    "missing",
    "self-rehashed",
    "nonexec",
    "file-link",
    "parent-link",
    "unlisted",
    "arbitrary-path",
  ])(
    "denies %s nested saved-bundle dependency before creating a candidate",
    async (fault) => {
      const f = await pinnedSavedFixture();
      const pin = FLUCOMA_DEPENDENCY_FILES.find((file) => file.mode === 0o755);
      const path = join(f.bundle.directory, pin.name);
      if (fault === "missing") await rm(path);
      if (fault === "nonexec") await chmod(path, 0o600);
      if (fault === "self-rehashed") {
        const bytes = await readFile(path);
        bytes[100] ^= 1;
        await writeFile(path, bytes);
        f.manifest.resources.find((file) => file.name === pin.name).sha256 =
          hash(bytes);
      }
      if (fault === "file-link") {
        await rm(path);
        await symlink(resolve("max-patches/audio-listener", pin.name), path);
      }
      if (fault === "parent-link") {
        await rm(dirname(path), { recursive: true });
        await symlink(
          dirname(resolve("max-patches/audio-listener", pin.name)),
          dirname(path),
        );
      }
      if (fault === "unlisted") {
        f.manifest.resources = f.manifest.resources.filter(
          (file) => file.name !== pin.name,
        );
        f.bundle.requiredCompanions = f.bundle.requiredCompanions.filter(
          (name) => name !== pin.name,
        );
      }
      if (fault === "arbitrary-path") {
        const name = "arbitrary/unreviewed.js";
        await mkdir(dirname(join(f.bundle.directory, name)));
        await writeFile(join(f.bundle.directory, name), "test");
        f.manifest.resources.push({
          name,
          bytes: 4,
          sha256: hash("test"),
          roles: ["companion"],
        });
        f.bundle.requiredCompanions.push(name);
      }
      await f.saveManifest();
      await expect(stageSavedListeningFixture(f)).rejects.toThrow();
      await expect(access(f.destination)).rejects.toThrow();
    },
  );
  it.each([
    "original-bytes",
    "staged-bytes",
    "original-mode",
    "staged-mode",
    "staged-extra",
  ])(
    "verifies nested saved-bundle immutability after %s changes",
    async (fault) => {
      const f = await pinnedSavedFixture();
      const staged = await stageSavedListeningFixture(f);
      const pin = FLUCOMA_DEPENDENCY_FILES.find((file) => file.mode === 0o755);
      const root = fault.startsWith("original")
        ? f.bundle.directory
        : join(f.destination, "Native-Listener-Candidate");
      const path = join(root, pin.name);
      if (fault.endsWith("mode")) await chmod(path, 0o600);
      else if (fault === "staged-extra")
        await writeFile(join(dirname(path), "unexpected"), "test");
      else {
        const bytes = await readFile(path);
        bytes[100] ^= 1;
        await writeFile(path, bytes);
      }
      await expect(staged.verifyImmutableInputs()).rejects.toThrow();
      await staged.cleanup();
      await expect(access(f.destination)).rejects.toThrow();
    },
  );
  it("cleans nested saved-bundle output when cancelled during copying", async () => {
    const f = await pinnedSavedFixture();
    const pin = FLUCOMA_DEPENDENCY_FILES.find((file) => file.mode === 0o755);
    const target = join(f.destination, "Native-Listener-Candidate", pin.name);
    await expect(
      stageSavedListeningFixture({
        ...f,
        signal: {
          throwIfAborted() {
            if (existsSync(target)) {
              const error = new Error("cancelled after nested copy");
              error.name = "AbortError";
              throw error;
            }
          },
        },
      }),
    ).rejects.toThrow("cancelled after nested copy");
    await expect(access(f.destination)).rejects.toThrow();
    expect(hash(await readFile(join(f.bundle.directory, pin.name)))).toBe(
      pin.sha256,
    );
  });

  it("replaces both library-origin and active project-collected references to the same pinned device", async () => {
    const f = await fixture();
    f.input.expected.fileReferences = 6;
    f.input.expected.deviceReferences = 2;
    await f.changeXml((xml) =>
      xml.replace(
        "</Tracks>",
        `</Tracks><DeviceReferences>${ref(
          "3",
          f.input.device.relativePath,
          `${f.input.originalProjectPrefix}/${f.input.device.relativePath}`,
        )}</DeviceReferences>`,
      ),
    );
    const before = await readFile(f.input.sourceSet);
    const staged = await stageSavedListeningFixture(f);
    const xml = gunzipSync(await readFile(staged.setPath)).toString();
    expect([
      ...xml.matchAll(
        /RelativePath Value="Native-Listener-Candidate\/Candidate.amxd"/g,
      ),
    ]).toHaveLength(2);
    expect(xml).not.toContain('RelativePath Value="Presets/Old.amxd"');
    expect(await readFile(f.input.sourceSet)).toEqual(before);
    expect(
      staged.generatedFiles.some((file) => file.name === "Presets/Old.amxd"),
    ).toBe(false);
    await expect(staged.verifyImmutableInputs()).resolves.toMatchObject({
      verified: true,
      sourceSetUnchanged: true,
    });
  });
  it("reports BLOCKED with an exact bounded plan when the real matched v5 bundle is absent", async () => {
    const f = await fixture();
    const before = await readFile(f.input.sourceSet);
    const report = await stageSavedListeningFixture({
      ...f,
      bundle: undefined,
    });
    expect(report.status).toBe("blocked");
    expect(report.blockers).toEqual([
      "missing-reviewed-matched-native-v5-bundle",
    ]);
    expect(report.loadedOrLiveValidated).toBe(false);
    expect(report.references).toHaveLength(5);
    expect(report.rebindings).toHaveLength(1);
    expect(report.requiredDeviceReplacement.completeBundlePinned).toBe(false);
    expect(await readFile(f.input.sourceSet)).toEqual(before);
    await expect(access(f.destination)).rejects.toThrow();
  });

  it("only rebinds approved references, preserves musical XML and PCM bytes, and never qualifies synthetic code", async () => {
    const f = await fixture();
    const source = await readFile(f.input.sourceSet);
    const staged = await stageSavedListeningFixture(f);
    expect(staged.status).toBe("prepared-offline");
    expect(staged.candidateProvenance.kind).toBe("synthetic-test");
    expect(staged.loadedOrLiveValidated).toBe(false);
    const rebound = gunzipSync(await readFile(staged.setPath)).toString();
    const stripRefs = (xml) =>
      xml.replace(/<FileRef>[\s\S]*?<\/FileRef>/g, "REFERENCE");
    expect(stripRefs(rebound)).toBe(stripRefs(f.xml));
    expect(rebound).toContain(`${f.destination}/Samples/tone.aif`);
    expect(rebound).not.toContain(
      `${f.input.originalProjectPrefix}/Samples/tone.aif`,
    );
    expect(rebound).toContain(
      `${f.destination}/Native-Listener-Candidate/Candidate.amxd`,
    );
    expect(rebound).toContain(
      'RelativePath Value="Native-Listener-Candidate/Candidate.amxd"',
    );
    expect(rebound).toContain(f.input.externalFiles[0].path);
    expect(rebound).toContain("/../../../historical/Library");
    const copied = await readFile(join(f.destination, "Samples/tone.aif"));
    expect(copied).toEqual(f.audio);
    expect(hash(copied.subarray(54))).toBe(hash(f.audio.subarray(54)));
    expect(await readFile(f.input.sourceSet)).toEqual(source);
    expect(
      await readFile(join(f.input.sourceProject, "Presets/Old.amxd")),
    ).toEqual(f.oldDevice);
    expect(
      staged.generatedFiles.some((file) => file.name === "Presets/Old.amxd"),
    ).toBe(false);
    await expect(staged.verifyImmutableInputs()).resolves.toMatchObject({
      verified: true,
      sourceSetUnchanged: true,
    });
  });

  it("is deterministic for the same explicit owned destination without overwriting an existing candidate", async () => {
    const f = await fixture();
    const first = await stageSavedListeningFixture(f);
    await expect(stageSavedListeningFixture(f)).rejects.toThrow();
    await first.verifyImmutableInputs();
    const expected = await readFile(first.setPath);
    await first.cleanup();
    const second = await stageSavedListeningFixture(f);
    expect(await readFile(second.setPath)).toEqual(expected);
    expect(second.stagedSetSha256).toBe(first.stagedSetSha256);
  });

  it.each([
    "device",
    "controller",
    "guard",
    "identity",
    "signal-client",
    "clock",
    "analysis",
    "detector-input",
  ])("requires pinned %s companion evidence", async (role) => {
    const f = await fixture();
    f.manifest.resources.forEach((resource) => {
      resource.roles = resource.roles.filter((value) => value !== role);
    });
    await f.saveManifest();
    await expect(planSavedListeningFixture(f)).rejects.toThrow();
  });

  it.each([
    "version",
    "guard-version",
    "extra-file",
    "missing-file",
    "changed-file",
    "manifest-pin",
    "companion-review",
  ])("rejects ambiguous or incomplete bundle %s", async (change) => {
    const f = await fixture();
    if (change === "version") {
      f.manifest.nativeVersion = 4;
      await f.saveManifest();
    }
    if (change === "guard-version") {
      f.manifest.guardNativeVersion = 4;
      await f.saveManifest();
    }
    if (change === "extra-file")
      await writeFile(join(f.bundle.directory, "unreviewed.js"), "not pinned");
    if (change === "missing-file")
      await rm(join(f.bundle.directory, "clock.maxpat"));
    if (change === "changed-file")
      await writeFile(join(f.bundle.directory, "clock.maxpat"), "changed");
    if (change === "manifest-pin") f.bundle.manifestSha256 = "0".repeat(64);
    if (change === "companion-review") f.bundle.requiredCompanions.pop();
    await expect(stageSavedListeningFixture(f)).rejects.toThrow();
    await expect(access(f.destination)).rejects.toThrow();
  });

  it.each(["source", "project", "external", "bundle"])(
    "rejects a symbolic link in %s inputs",
    async (kind) => {
      const f = await fixture();
      const path = {
        source: f.input.sourceSet,
        project: join(f.input.sourceProject, "Samples/tone.aif"),
        external: f.input.externalFiles[0].path,
        bundle: join(f.bundle.directory, "clock.maxpat"),
      }[kind];
      const copy = join(f.root, `real-${kind}`);
      await writeFile(copy, await readFile(path));
      await rm(path);
      await symlink(copy, path);
      await expect(planSavedListeningFixture(f)).rejects.toThrow(
        "resource_not_regular_or_bounded",
      );
    },
  );

  it.each([
    (xml) =>
      xml.replace(
        "<LiveSet>",
        '<!DOCTYPE LiveSet [<!ENTITY file SYSTEM "file:///private">]><LiveSet>',
      ),
    (xml) => xml.replace("</Tracks>", "</WRONG>"),
    (xml) =>
      xml.replace("<Ableton ", "<Other ").replace("</Ableton>", "</Other>"),
    (xml) => `${xml}<Ableton />`,
    (xml) =>
      xml.replace(
        'Creator="Ableton Live 11.3.43"',
        'Creator="Ableton Live 12"',
      ),
    (xml) =>
      xml.replace(
        'RelativePath Value="Samples/tone.aif"',
        'RelativePath Value="../tone.aif"',
      ),
    (xml) =>
      xml.replace(
        'Path Value="/../../../historical/Library"',
        'Path Value="/../../../OTHER/Library"',
      ),
    (xml) =>
      xml
        .replace("<LastPresetRef>", "<NotHistory>")
        .replace("</LastPresetRef>", "</NotHistory>"),
    (xml) => xml.replace('Path Value=""', 'Path Value="&unknown;"'),
  ])(
    "rejects malformed, unreviewed or traversal-bearing XML %#",
    async (change) => {
      const f = await fixture();
      await f.changeXml(change);
      await expect(planSavedListeningFixture(f)).rejects.toThrow();
    },
  );

  it("does not mistake a colliding project prefix for the exact reviewed source prefix", async () => {
    const f = await fixture();
    await f.changeXml((xml) =>
      xml.replace(
        `${f.input.originalProjectPrefix}/Samples`,
        `${f.input.originalProjectPrefix}-OTHER/Samples`,
      ),
    );
    await expect(planSavedListeningFixture(f)).rejects.toThrow(
      "unreviewed_file_reference",
    );
  });

  it("preserves hash-reviewed factory directory history without admitting directories as active resources", async () => {
    const f = await fixture();
    const old = [...f.xml.matchAll(/<FileRef>[\s\S]*?<\/FileRef>/g)][3][0];
    const historical = ref(
      "5",
      "Presets",
      join(f.input.factoryRoots[0], "Presets"),
    );
    f.input.historicalReferences[0].sha256 = hash(historical);
    await f.changeXml((xml) => xml.replace(old, historical));
    const report = await planSavedListeningFixture(f);
    expect(report.references[3].kind).toBe("pinned-inert-history");
    await f.changeXml((xml) =>
      xml
        .replace(old, historical)
        .replace("<LastPresetRef>", "<NotHistory>")
        .replace("</LastPresetRef>", "</NotHistory>"),
    );
    await expect(planSavedListeningFixture(f)).rejects.toThrow(
      "unreviewed_file_reference_3",
    );
  });

  it("preserves reviewed SourceContext directory provenance without treating it as a loaded resource", async () => {
    const f = await fixture();
    const old = [...f.xml.matchAll(/<FileRef>[\s\S]*?<\/FileRef>/g)][3][0];
    const historical = ref(
      "5",
      "Presets",
      join(f.input.factoryRoots[0], "Presets"),
    );
    f.input.historicalReferences[0].sha256 = hash(historical);
    await f.changeXml((xml) =>
      xml.replace(
        `<LastPresetRef>${old}</LastPresetRef>`,
        `<SourceContext><Value><BranchSourceContext><OriginalFileRef>${historical}</OriginalFileRef></BranchSourceContext></Value></SourceContext>`,
      ),
    );
    expect((await planSavedListeningFixture(f)).references[3].kind).toBe(
      "pinned-inert-history",
    );
  });

  it("fails closed when otherwise valid AIFF PCM changes under its declared hash pin", async () => {
    const f = await fixture();
    const changed = Buffer.from(f.audio);
    changed[changed.length - 1] ^= 1;
    await writeFile(join(f.input.sourceProject, "Samples/tone.aif"), changed);
    await expect(planSavedListeningFixture(f)).rejects.toThrow(
      "resource_hash_mismatch",
    );
  });

  it("never promotes the old saved AMXD merely because a new manifest claims native v5", async () => {
    const f = await fixture();
    const resource = f.manifest.resources.find(
      (entry) => entry.name === "Candidate.amxd",
    );
    resource.sha256 = hash(f.oldDevice);
    resource.bytes = f.oldDevice.length;
    await writeFile(join(f.bundle.directory, "Candidate.amxd"), f.oldDevice);
    await f.saveManifest();
    await expect(planSavedListeningFixture(f)).rejects.toThrow(
      "old_saved_device_cannot_qualify_as_native_v5",
    );
  });

  it.each([
    "project-files",
    "external-files",
    "history",
    "references",
    "file-bytes",
  ])("enforces the independent %s preparation budget", async (kind) => {
    const f = await fixture();
    if (kind === "project-files")
      f.input.projectFiles = Array.from(
        { length: 17 },
        () => f.input.projectFiles[0],
      );
    if (kind === "external-files")
      f.input.externalFiles = Array.from(
        { length: 129 },
        () => f.input.externalFiles[0],
      );
    if (kind === "history")
      f.input.historicalReferences = Array.from(
        { length: 65 },
        () => f.input.historicalReferences[0],
      );
    if (kind === "references") {
      await f.changeXml((xml) =>
        xml.replace("</Tracks>", `${ref("0", "", "").repeat(252)}</Tracks>`),
      );
      f.input.expected.fileReferences = 257;
    }
    if (kind === "file-bytes") {
      const bytes = Buffer.alloc(8 * 1024 * 1024 + 1);
      await writeFile(join(f.input.sourceProject, "Samples/tone.aif"), bytes);
      f.input.projectFiles[0].sha256 = hash(bytes);
    }
    await expect(planSavedListeningFixture(f)).rejects.toThrow();
    await expect(access(f.destination)).rejects.toThrow();
  });

  it.each(["project", "factory", "set"])(
    "rejects missing or mutated %s dependencies before staging",
    async (kind) => {
      const f = await fixture();
      const path =
        kind === "project"
          ? join(f.input.sourceProject, "Samples/tone.aif")
          : kind === "factory"
            ? f.input.externalFiles[0].path
            : f.input.sourceSet;
      await writeFile(path, "unexpected file contents");
      await expect(stageSavedListeningFixture(f)).rejects.toThrow(
        "resource_hash_mismatch",
      );
      await expect(access(f.destination)).rejects.toThrow();
    },
  );

  it("requires a fresh direct-child candidate, never either pre-existing copy or the namespace", async () => {
    const f = await fixture();
    for (const destination of [
      namespace,
      join(namespace, "fixture-owned"),
      f.input.sourceProject,
      join(namespace, "candidate-x/nested"),
    ]) {
      await expect(
        stageSavedListeningFixture({ ...f, destination }),
      ).rejects.toThrow("fresh_explicit_candidate_namespace_required");
    }
    await mkdir(f.destination);
    await writeFile(join(f.destination, "sentinel"), "leave untouched");
    await expect(stageSavedListeningFixture(f)).rejects.toThrow();
    expect(await readFile(join(f.destination, "sentinel"), "utf8")).toBe(
      "leave untouched",
    );
  });

  it("cleans only its newly created candidate after partial staging failure", async () => {
    const f = await fixture();
    await expect(
      stageSavedListeningFixture({
        ...f,
        storage: {
          signalIngressDescriptorPath: "relative",
          signalIngressSecretPath: "relative",
        },
      }),
    ).rejects.toThrow("absolute paths");
    await expect(access(f.destination)).rejects.toThrow();
    expect(
      await readFile(join(f.input.sourceProject, "Samples/tone.aif")),
    ).toEqual(f.audio);
    expect(await readdir(f.root)).toContain("readonly-project");
  });

  it.each(["before", "after-copy"])(
    "supports cancellation %s without retaining partial candidate state",
    async (when) => {
      const f = await fixture();
      const controller = new globalThis.AbortController();
      if (when === "before") controller.abort();
      const stages = [];
      await expect(
        stageSavedListeningFixture({
          ...f,
          signal: controller.signal,
          stage: async (name, operation) => {
            stages.push(name);
            const result = await operation();
            if (when === "after-copy" && name === "saved-fixture-copy")
              controller.abort();
            return result;
          },
        }),
      ).rejects.toThrow();
      await expect(access(f.destination)).rejects.toThrow();
      if (when === "after-copy")
        expect(stages).toContain("saved-fixture-cleanup");
    },
  );

  it("detects input mutation after copying and cleans the generated candidate", async () => {
    const f = await fixture();
    await expect(
      stageSavedListeningFixture({
        ...f,
        stage: async (name, operation) => {
          const result = await operation();
          if (name === "saved-fixture-copy")
            await writeFile(
              join(f.input.sourceProject, "Samples/tone.aif"),
              "changed after snapshot",
            );
          return result;
        },
      }),
    ).rejects.toThrow("immutable_fixture_input_changed");
    await expect(access(f.destination)).rejects.toThrow();
  });

  it.each([true, false])(
    "rejects snapshot mutation before returning a plan with bundle present=%s",
    async (hasBundle) => {
      const f = await fixture();
      await expect(
        stageSavedListeningFixture({
          ...f,
          bundle: hasBundle ? f.bundle : undefined,
          stage: async (name, operation) => {
            const result = await operation();
            if (name === "saved-fixture-plan") {
              const changed = Buffer.from(f.audio);
              changed[changed.length - 1] ^= 1;
              await writeFile(
                join(f.input.sourceProject, "Samples/tone.aif"),
                changed,
              );
            }
            return result;
          },
        }),
      ).rejects.toThrow("immutable_fixture_input_changed");
      await expect(access(f.destination)).rejects.toThrow();
    },
  );

  it.each(["external", "staged-audio", "companion", "extra"])(
    "independently rejects later %s mutation",
    async (kind) => {
      const f = await fixture();
      const staged = await stageSavedListeningFixture(f);
      const path = {
        external: f.input.externalFiles[0].path,
        "staged-audio": join(f.destination, "Samples/tone.aif"),
        companion: join(
          f.destination,
          "Native-Listener-Candidate/clock.maxpat",
        ),
        extra: join(f.destination, "unreviewed-extra.js"),
      }[kind];
      await writeFile(path, "changed");
      await expect(staged.verifyImmutableInputs()).rejects.toThrow();
    },
  );
});
