import { createHash, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { existsSync, symlinkSync, writeFileSync } from "node:fs";
import {
  access,
  chmod,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as storageServices from "@ableton-agent/storage";
import * as applicationServices from "@ableton-agent/application";
import * as runtimeServices from "@ableton-agent/runtime";
import * as observabilityServices from "@ableton-agent/observability";
import * as protocol from "@ableton-agent/protocol";
import { createSyntheticNativeListeningFixture } from "@ableton-agent/protocol/testing";
import { JsonSessionStore } from "../../apps/desktop/src/main/desktop-service.ts";
import { createDesktopSessionContextManager } from "../../apps/desktop/src/main/desktop-session-context.ts";
import { sessionSchema } from "../../apps/desktop/src/contracts.ts";
import { publishSignalSecrets } from "../../apps/desktop/src/main/signal-credentials.ts";
import {
  decodeAmxd,
  encodeAmxd,
  FLUCOMA_DEPENDENCY_FILES,
} from "@ableton-agent/shared/m4l-devices";

import {
  inspectNativeFixtureSet,
  stageNativeListeningFixture,
} from "./native-listening-fixture.mjs";
import { createNativeListeningRunner } from "./native-listening-runner.mjs";
import { runRestrictiveUmaskChild } from "./umask-child-test-support.js";
import {
  disposeNativeFixtureRoots,
  nativeFixtureInput as createNativeFixtureInput,
} from "./native-listening-fixture-test-support.mjs";

const roots = [];
const hash = (value) => createHash("sha256").update(value).digest("hex");
const nativeFixtureInput = (options) =>
  createNativeFixtureInput(roots, options);
afterEach(() => disposeNativeFixtureRoots(roots));

async function pinnedNativeFixture() {
  const f = await nativeFixtureInput({ nativeVersion: 4 });
  f.nativeVersion = f.input.nativeVersion = 5;
  const path = join(f.input.candidateDirectory, "audio-listener-manifest.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  Object.assign(manifest, {
    nativeVersion: 5,
    nativeAbiVersion: 3,
    nativeScope: "independent-metric-timelines/v1",
    algorithmVersion: "3.0.0",
    observationSchema: "metric-audio-observation/v1",
    providerLimits: { durationMs: 30000, maxWindows: 2000 },
  });
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
  await writeFile(join(f.input.candidateDirectory, f.input.deviceFile), device);
  f.input.deviceSha256 = manifest.deviceSha256 = hash(device);
  await cp(
    resolve("max-patches/audio-listener/dependencies"),
    join(f.input.candidateDirectory, "dependencies"),
    { recursive: true },
  );
  manifest.resources.push(
    ...FLUCOMA_DEPENDENCY_FILES.map(({ name, bytes, sha256 }) => ({
      name,
      bytes,
      sha256,
    })),
  );
  f.saveManifest = async () => {
    const bytes = JSON.stringify(manifest);
    await writeFile(path, bytes);
    f.input.candidateManifestSha256 = hash(bytes);
  };
  f.manifest = manifest;
  await f.saveManifest();
  return f;
}

async function addFixtureAudio(
  f,
  {
    name = "tone.wav",
    path = join(f.root, "Audio", name),
    referenceType = "3",
    relativePath = relative(f.root, path),
  } = {},
) {
  const bytes = Buffer.from("test-only pinned WAV placeholder, never loaded");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
  f.input.audioFiles.push({ path, sha256: hash(bytes) });
  const reference = `<FileRef><RelativePathType Value="${referenceType}" /><RelativePath Value="${relativePath}" /><Path Value="${path}" /></FileRef>`;
  f.source = gzipSync(
    gunzipSync(f.source)
      .toString("utf8")
      .replace("</Ableton>", `${reference}</Ableton>`),
  );
  await writeFile(f.input.sourceSet, f.source);
  f.input.sourceSetSha256 = hash(f.source);
  return { bytes, path, relativePath };
}

describe("native listening fixture staging", () => {
  it("preserves pinned modes under restrictive umask in an isolated native stager process", async () => {
    const f = await pinnedNativeFixture();
    const options = {
      input: f.input,
      destination: f.destination,
      storage: f.storage,
      nativeVersion: f.nativeVersion,
    };
    const stdout = await runRestrictiveUmaskChild(`
        import assert from "node:assert/strict";
        import { stat } from "node:fs/promises";
        import { join } from "node:path";
        import { stageNativeListeningFixture } from "./scripts/lib/native-listening-fixture.mjs";
        import { FLUCOMA_DEPENDENCY_FILES, validateFlucomaDependency } from "@ableton-agent/shared/m4l-devices";
        assert.equal(process.umask(), 0o077);
        const options = ${JSON.stringify(options)};
        const staged = await stageNativeListeningFixture(options);
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

  it("preserves pinned nested FluCoMa v5 resources and executable mode", async () => {
    const f = await pinnedNativeFixture();
    const staged = await stageNativeListeningFixture(f);
    const candidate = join(f.destination, "Native-Listener-Candidate");
    const bound = await readFile(join(candidate, f.input.deviceFile));
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
    expect(staged.sourceDeviceSha256).toBe(f.input.deviceSha256);
    expect(staged.deviceSha256).toBe(hash(bound));
    expect(staged.deviceSha256).not.toBe(f.input.deviceSha256);
    expect(
      hash(
        await readFile(join(f.input.candidateDirectory, f.input.deviceFile)),
      ),
    ).toBe(f.input.deviceSha256);
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
    "denies %s nested native dependency before creating a candidate",
    async (fault) => {
      const f = await pinnedNativeFixture();
      const pin = FLUCOMA_DEPENDENCY_FILES.find((file) => file.mode === 0o755);
      const path = join(f.input.candidateDirectory, pin.name);
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
      if (fault === "unlisted")
        f.manifest.resources = f.manifest.resources.filter(
          (file) => file.name !== pin.name,
        );
      if (fault === "arbitrary-path") {
        const name = "arbitrary/unreviewed.js";
        await mkdir(dirname(join(f.input.candidateDirectory, name)));
        await writeFile(join(f.input.candidateDirectory, name), "test");
        f.manifest.resources.push({ name, bytes: 4, sha256: hash("test") });
      }
      await f.saveManifest();
      await expect(stageNativeListeningFixture(f)).rejects.toThrow();
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
    "verifies nested native dependency immutability after %s changes",
    async (fault) => {
      const f = await pinnedNativeFixture();
      const staged = await stageNativeListeningFixture(f);
      const pin = FLUCOMA_DEPENDENCY_FILES.find((file) => file.mode === 0o755);
      const root = fault.startsWith("original")
        ? f.input.candidateDirectory
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
  it("cleans nested native dependency output when cancelled during copying", async () => {
    const f = await pinnedNativeFixture();
    const pin = FLUCOMA_DEPENDENCY_FILES.find((file) => file.mode === 0o755);
    const target = join(f.destination, "Native-Listener-Candidate", pin.name);
    await expect(
      stageNativeListeningFixture({
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
    expect(
      hash(await readFile(join(f.input.candidateDirectory, pin.name))),
    ).toBe(pin.sha256);
  });

  it("stages explicit wire3 ABI2 raw-v2 resources without relabeling the immutable Set", async () => {
    const f = await nativeFixtureInput({ nativeVersion: 3 });
    const staged = await stageNativeListeningFixture(f);
    expect(staged.nativeVersion).toBe(3);
    expect(await readFile(staged.setPath)).toEqual(f.source);
    expect(await readFile(f.input.sourceSet)).toEqual(f.source);
    await expect(staged.verifyImmutableInputs()).resolves.toMatchObject({
      verified: true,
    });
    await staged.cleanup();
    await expect(access(f.destination)).rejects.toThrow();
  });
  it.each([
    "set",
    "original-code",
    "copied-code",
    "original-audio",
    "copied-audio",
    "discovery",
    "inventory",
  ])(
    "independently rejects changed immutable Session fixture %s after staging",
    async (change) => {
      const f = await nativeFixtureInput({ nativeVersion: 3 });
      await addFixtureAudio(f);
      const staged = await stageNativeListeningFixture(f);
      const candidate = join(f.destination, "Native-Listener-Candidate");
      const path = {
        set: staged.setPath,
        "original-code": join(f.input.candidateDirectory, "engine.js"),
        "copied-code": join(candidate, "engine.js"),
        "original-audio": f.input.audioFiles[0].path,
        "copied-audio": join(f.destination, "Audio", "tone.wav"),
        discovery: join(candidate, "agent_signal_storage.js"),
        inventory: join(candidate, "extra.js"),
      }[change];
      await writeFile(path, "test-only changed fixture content");
      await expect(staged.verifyImmutableInputs()).rejects.toThrow(
        "Immutable fixture",
      );
      await staged.cleanup();
    },
  );
  it("requires Session audio to resolve to copied immutable project resources, not legacy absolute originals", async () => {
    const f = await nativeFixtureInput({ nativeVersion: 3 });
    await addFixtureAudio(f, { referenceType: "1" });
    await expect(stageNativeListeningFixture(f)).rejects.toThrow(
      "immutable project-relative",
    );
    await expect(access(f.destination)).rejects.toThrow();
  });
  it.each([
    ["nativeVersion", 2],
    ["nativeAbiVersion", 3],
    ["nativeScope", "arrangement-descriptive/v2"],
    ["sourceEvidence", "verified-source"],
    ["synchronization", "clip-clock"],
    ["maxDurationBeats", 8],
    ["observationSchema", "session-audio-observation/v1"],
    ["algorithmVersion", "3.0.0"],
  ])(
    "rejects mixed Session candidate %s before staging",
    async (key, value) => {
      const f = await nativeFixtureInput({ nativeVersion: 3 });
      const path = join(
        f.input.candidateDirectory,
        "audio-listener-manifest.json",
      );
      const manifest = JSON.parse(await readFile(path, "utf8"));
      manifest[key] = value;
      const bytes = JSON.stringify(manifest);
      await writeFile(path, bytes);
      f.input.candidateManifestSha256 = hash(bytes);
      await expect(stageNativeListeningFixture(f)).rejects.toThrow(
        "native candidate",
      );
      await expect(access(f.destination)).rejects.toThrow();
    },
  );

  it.each([1, 2, 3, 4])(
    "copies project-relative WAV dependencies for v%i before returning a loadable fixture",
    async (nativeVersion) => {
      const f = await nativeFixtureInput({ nativeVersion });
      const audio = await addFixtureAudio(f);
      const staged = await stageNativeListeningFixture(f);
      expect(await readFile(join(f.destination, audio.relativePath))).toEqual(
        audio.bytes,
      );

      expect(staged.audioResourceCount).toBe(1);
      expect(staged.audioResources).toEqual([
        {
          relativePath: audio.relativePath,
          sha256: hash(audio.bytes),
          bytes: audio.bytes.length,
        },
      ]);
      expect(await readFile(staged.setPath)).toEqual(f.source);
      expect(await readFile(audio.path)).toEqual(audio.bytes);
      await staged.cleanup();
      await expect(access(f.destination)).rejects.toThrow();
      expect(await readFile(audio.path)).toEqual(audio.bytes);
    },
  );

  it.each([
    { supportedModes: ["session"] },
    { modeNegotiation: "automatic" },
    { nativeAbiVersion: 3 },
    { nativeVersion: 3 },
  ])(
    "rejects a downgraded wire4 manifest before staging %j",
    async (change) => {
      const f = await nativeFixtureInput({ nativeVersion: 4 });
      const path = join(
        f.input.candidateDirectory,
        "audio-listener-manifest.json",
      );
      const bytes = JSON.stringify({
        ...JSON.parse(await readFile(path, "utf8")),
        ...change,
      });
      await writeFile(path, bytes);
      f.input.candidateManifestSha256 = hash(bytes);
      await expect(stageNativeListeningFixture(f)).rejects.toThrow(
        "native candidate",
      );
      await expect(access(f.destination)).rejects.toThrow();
    },
  );

  it("preserves nested project sample paths and stages each declared owned WAV once", async () => {
    const f = await nativeFixtureInput({ nativeVersion: 2 });
    const first = await addFixtureAudio(f, {
      path: join(f.root, "Samples", "Imported", "Transient 1.wav"),
    });
    const second = await addFixtureAudio(f, { name: "silence.wav" });
    const staged = await stageNativeListeningFixture(f);
    for (const audio of [first, second])
      expect(await readFile(join(f.destination, audio.relativePath))).toEqual(
        audio.bytes,
      );
    expect(staged.audioResourceCount).toBe(2);
    await staged.cleanup();
  });

  it.each([
    "../tone.wav",
    "/operator-owned/tone.wav",
    "Audio/../tone.wav",
    "Audio//tone.wav",
    "Audio/./tone.wav",
    "Audio\\tone.wav",
    "Native-Listener-Candidate/tone.wav",
    "Ableton Project Info/tone.wav",
    "Audio/different.wav",
  ])(
    "denies unsafe or inconsistent project audio reference %s",
    async (path) => {
      const f = await nativeFixtureInput({ nativeVersion: 2 });
      await addFixtureAudio(f, { relativePath: path });
      await expect(stageNativeListeningFixture(f)).rejects.toThrow(
        /Unsafe fixture|project-relative/,
      );
      await expect(access(f.destination)).rejects.toThrow();
    },
  );

  it("denies duplicate audio pins and changed or symlinked source audio before staging", async () => {
    const f = await nativeFixtureInput();
    const audio = await addFixtureAudio(f);
    f.input.audioFiles.push({ ...f.input.audioFiles[0] });
    await expect(stageNativeListeningFixture(f)).rejects.toThrow("Duplicate");
    f.input.audioFiles.pop();
    await writeFile(audio.path, "changed");
    await expect(stageNativeListeningFixture(f)).rejects.toThrow(
      "Audio dependency hash mismatch",
    );
    await rm(audio.path);
    const target = join(f.root, "target.wav");
    await writeFile(target, audio.bytes);
    await symlink(target, audio.path);
    await expect(stageNativeListeningFixture(f)).rejects.toThrow("regular");
    await expect(access(f.destination)).rejects.toThrow();
  });

  it("copies the verified audio snapshot even if the source changes after validation", async () => {
    const f = await nativeFixtureInput();
    const audio = await addFixtureAudio(f);
    let changed = false;
    const staged = await stageNativeListeningFixture({
      ...f,
      signal: {
        throwIfAborted() {
          if (!changed && existsSync(f.destination)) {
            writeFileSync(audio.path, "changed after pin verification");
            changed = true;
          }
        },
      },
    });
    expect(changed).toBe(true);
    expect(await readFile(join(f.destination, audio.relativePath))).toEqual(
      audio.bytes,
    );
    await staged.cleanup();
  });

  it("keeps legacy provisioned absolute external audio references unchanged", async () => {
    const f = await nativeFixtureInput();
    const external = resolve(
      ".test-artifacts",
      `native-external-audio-${randomUUID()}`,
    );
    roots.push(external);
    const audio = await addFixtureAudio(f, {
      path: join(external, "absolute.wav"),
      referenceType: "0",
      relativePath: "",
    });
    const staged = await stageNativeListeningFixture(f);
    expect(staged.audioResourceCount).toBe(0);
    expect(staged.audioResources).toEqual([]);
    expect(await readFile(staged.setPath)).toEqual(f.source);
    await staged.cleanup();
    expect(await readFile(audio.path)).toEqual(audio.bytes);
  });

  it("refuses staged audio-directory symlinks without creating external directories or files", async () => {
    const f = await nativeFixtureInput();
    await addFixtureAudio(f, {
      path: join(f.root, "Audio", "nested", "tone.wav"),
    });
    const outside = join(f.root, "outside");
    await mkdir(outside);
    let injected = false;
    await expect(
      stageNativeListeningFixture({
        ...f,
        signal: {
          throwIfAborted() {
            if (!injected && existsSync(f.destination)) {
              symlinkSync(outside, join(f.destination, "Audio"));
              injected = true;
            }
          },
        },
      }),
    ).rejects.toThrow("Unsafe staged audio directory");
    expect(await readdir(outside)).toEqual([]);
    await expect(access(f.destination)).rejects.toThrow();
  });

  it("cleans a partially copied audio tree on cancellation without changing originals", async () => {
    const f = await nativeFixtureInput({ nativeVersion: 2 });
    const first = await addFixtureAudio(f, { name: "first.wav" });
    const second = await addFixtureAudio(f, { name: "second.wav" });
    await expect(
      stageNativeListeningFixture({
        ...f,
        signal: {
          throwIfAborted() {
            if (existsSync(join(f.destination, first.relativePath)))
              throw new Error("cancelled during audio copy");
          },
        },
      }),
    ).rejects.toThrow("cancelled during audio copy");
    await expect(access(f.destination)).rejects.toThrow();
    for (const audio of [first, second])
      expect(await readFile(audio.path)).toEqual(audio.bytes);
    expect(await readFile(f.input.sourceSet)).toEqual(f.source);
  });

  it("explicitly stages v2 without relabelling or rewriting the pinned Set, candidate or original discovery", async () => {
    const f = await nativeFixtureInput({ nativeVersion: 2 });
    const staged = await stageNativeListeningFixture(f);
    expect(staged.nativeVersion).toBe(2);
    expect(await readFile(staged.setPath)).toEqual(f.source);
    expect(await readFile(f.input.sourceSet)).toEqual(f.source);
    for (const name of [
      "Candidate.amxd",
      "engine.js",
      "audio-listener-manifest.json",
    ])
      expect(
        await readFile(join(f.destination, "Native-Listener-Candidate", name)),
      ).toEqual(await readFile(join(f.input.candidateDirectory, name)));
    expect(
      await readFile(
        join(f.input.candidateDirectory, "agent_signal_storage.js"),
        "utf8",
      ),
    ).toBe("test-only old discovery, never executed");
    await staged.cleanup();
    await expect(access(f.destination)).rejects.toThrow();
    await expect(access(f.input.sourceSet)).resolves.toBeUndefined();
  });

  it("requires matching explicit v2 caller, input and manifest selection before copying", async () => {
    const f = await nativeFixtureInput({ nativeVersion: 2 });
    for (const nativeVersion of [undefined, 1, 3])
      await expect(
        stageNativeListeningFixture({ ...f, nativeVersion }),
      ).rejects.toThrow("native version");
    delete f.input.nativeVersion;
    await expect(stageNativeListeningFixture(f)).rejects.toThrow(
      "native version",
    );
    await expect(access(f.destination)).rejects.toThrow();
  });

  it.each([
    ["nativeVersion", 1],
    ["nativeScope", "arrangement-beat0-120bpm-48000hz-vector64/v1"],
    ["algorithmVersion", "1.0.1"],
    ["observationSchema", "audio-observation/v1"],
    ["providerLimits", { durationMs: 30000, maxWindows: 301 }],
    ["tempoPolicy", "independently-verified"],
    ["tempoAutomationSupported", true],
    ["realLiveValidated", true],
  ])(
    "denies mixed or promoted v2 manifest %s before copying",
    async (key, value) => {
      const f = await nativeFixtureInput({ nativeVersion: 2 });
      const path = join(
        f.input.candidateDirectory,
        "audio-listener-manifest.json",
      );
      const manifest = JSON.parse(await readFile(path, "utf8"));
      manifest[key] = value;
      const bytes = JSON.stringify(manifest);
      await writeFile(path, bytes);
      f.input.candidateManifestSha256 = hash(bytes);
      await expect(stageNativeListeningFixture(f)).rejects.toThrow(
        "native candidate",
      );
      await expect(access(f.destination)).rejects.toThrow();
      expect(await readFile(f.input.sourceSet)).toEqual(f.source);
    },
  );

  it("copies immutable input bytes, pins code/device hashes and changes only owned discovery", async () => {
    const f = await nativeFixtureInput();
    const staged = await stageNativeListeningFixture(f);
    expect(await readFile(staged.setPath)).toEqual(f.source);
    await expect(
      access(join(f.destination, "Ableton Project Info")),
    ).resolves.toBeUndefined();
    expect(await readFile(f.input.sourceSet)).toEqual(f.source);
    expect(
      await readFile(
        join(f.input.candidateDirectory, "agent_signal_storage.js"),
        "utf8",
      ),
    ).toBe("test-only old discovery, never executed");
    const discovery = await readFile(
      join(
        f.destination,
        "Native-Listener-Candidate",
        "agent_signal_storage.js",
      ),
      "utf8",
    );
    expect(discovery).toContain(f.storage.signalIngressDescriptorPath);
    expect(discovery).toContain(f.storage.signalIngressSecretPath);
    expect(staged.sourceSetSha256).toBe(f.input.sourceSetSha256);
    await staged.cleanup();
    await expect(access(f.destination)).rejects.toThrow();
    await expect(access(f.input.sourceSet)).resolves.toBeUndefined();
  });

  async function runnerFixture({
    failure,
    terminal = "completed",
    humanGate = false,
    journalFlushFailure = false,
    audioName,
  } = {}) {
    const f = await nativeFixtureInput();
    if (audioName) await addFixtureAudio(f, { name: audioName });
    const inputPath = join(f.root, "provisioned-input.json");
    await writeFile(inputPath, JSON.stringify(f.input));
    const manifest = JSON.parse(
      await readFile(
        "integration/live-scenarios/native-playback-and-listen.json",
      ),
    );
    const runId = randomUUID();
    const subscribers = new Set();
    const appEvents = new Set();
    const close = vi.fn();
    const journalClose = vi.fn();
    const wait = vi.fn();
    let ingressStarted = false;
    const startIngress = vi.fn(async () => {
      expect((await stat(options.signal.secretPath)).mode & 0o777).toBe(0o600);
      expect((await readFile(options.signal.secretPath, "utf8")).trim()).toBe(
        "x".repeat(40),
      );
      if (failure === "signal-start")
        throw new Error("test signal start failure");
      ingressStarted = true;
    });
    const stopIngress = vi.fn(async () => {
      ingressStarted = false;
      if (failure === "signal-stop")
        throw new Error("test signal stop failure");
    });
    let configuration;
    let agentServiceStarted = false;
    let playing = false;
    let ports;
    let job;
    let actorContext;
    let options;
    const listener = {
      connectionId: "connection",
      producer: {
        producerId: "native",
        instanceId: "instance",
        signalKind: "audio",
        schemaVersion: "audio-observation/v1",
        track: { id: "track" },
        device: { id: "device" },
      },
      binding: { trackId: "track", deviceId: "device" },
      registration: {
        connectionEpoch: "epoch",
        nativeStatus: {
          scope: protocol.NATIVE_LISTENER_SCOPE,
          timing: "UNVERIFIED",
          readiness: "BLOCKED",
          reason: "native_per_pass_validation_required",
        },
        sampleRate: 48000,
        deviceCanonicalPath: f.input.canonicalPath,
      },
      phase: "idle",
    };
    const target = {
      binding: {
        track: { expectedReference: "track", expectedName: f.input.trackName },
        expectedDeviceReference: "device",
        expectedDeviceName: f.input.deviceName,
      },
      canonicalPath: f.input.canonicalPath,
      pathAttestation: { canonicalDevicePath: f.input.canonicalPath },
      enabled: true,
      sessionOverride: false,
      clipsTruncated: false,
      dependenciesTruncated: false,
      clips: [],
      upstreamDevices: [],
    };
    const listeningOptions = {};
    const services = {
      ...applicationServices,
      ...runtimeServices,
      ...observabilityServices,
      ...storageServices,
      JsonSessionStore,
      LocalObservabilityJournal: {
        open: async (options) => {
          const journal =
            await observabilityServices.LocalObservabilityJournal.open(options);
          const flush = journal.flush.bind(journal);
          const close = journal.close.bind(journal);
          journal.flush = async () => {
            await flush();
            if (journalFlushFailure)
              throw new Error("test journal flush failure");
          };
          journal.close = async () => {
            journalClose();
            await close();
          };
          return journal;
        },
      },
      createDesktopSessionContextManager,
      publishSignalSecrets: vi.fn(async (...args) => {
        if (failure === "credentials")
          throw new Error("test credential publication failure");
        return publishSignalSecrets(...args);
      }),
      sessionSchema,
      protocol,
      createListeningRuntimeHost: vi.fn((_dependencies, supplied) => {
        Object.assign(listeningOptions, supplied);
        return {
          shutdown: vi.fn(),
          executeListeningOperation: async (params, context) => {
            await supplied.resolveOwner(context);
            if (params.action === "inspect-listeners")
              return {
                action: params.action,
                truncated: false,
                listeners: [
                  {
                    listenerId: "native",
                    ready: false,
                    limitations: ["native_per_pass_validation_required"],
                    trackReference: "track",
                    deviceReference: "device",
                  },
                ],
              };
            if (params.action === "play-arrangement-and-listen") {
              actorContext = context;
              job = {
                passId: randomUUID(),
                stage: "arming",
                contextIds: [],
                cleanupPolicy: "leave-running",
              };
              supplied.onChange(job);
              return { action: params.action, job };
            }
            return { action: params.action, job };
          },
          waitForListeningPass: async () => {
            wait();
            if (failure === "cancelled")
              throw new globalThis.DOMException(
                "test cancellation",
                "AbortError",
              );
            if (terminal !== "completed") {
              job = {
                ...job,
                stage: terminal,
                ...(failure === "marker"
                  ? {
                      error:
                        "Arrangement insert marker does not match the requested start",
                    }
                  : {}),
                ...(failure === "clock-and-policy"
                  ? { error: "native_clock_discontinuity" }
                  : {}),
              };
              supplied.onChange(job);
              return job;
            }
            const owner = await supplied.resolveOwner(actorContext);
            const repository = await supplied.resolveRepository(
              owner,
              actorContext,
            );
            const { proof, observation } =
              createSyntheticNativeListeningFixture({
                passId: job.passId,
                listenerId: "native",
              });
            observation.attacks = [0, 1, 2, 3].map((beat) => ({
              beat,
              sample: observation.startSample + beat * 24000,
              strength: 1,
            }));
            observation.reduction.originalAttacks = 4;
            const at = new Date().toISOString();
            const subject = (kind) => ({
              id: randomUUID(),
              sessionId: owner.sessionId,
              liveSetId: owner.liveSetId,
              kind,
              trackId: "track",
              binding: {
                version: 1,
                semanticLocator: {
                  name: "Fixture",
                  trackId: "track",
                  ...(kind === "arrangement-range"
                    ? { arrangementRange: { startBeat: 0, endBeat: 4 } }
                    : {}),
                },
                sourceIdentity: "test-owned",
                playbackSettingsHash: "a".repeat(64),
                upstreamProcessingHash: "b".repeat(64),
                routingHash: "c".repeat(64),
                dependencyScope: "unknown",
                previousRuntimeBindings: [],
              },
            });
            const publication = applicationServices.buildListeningPublication({
              passId: job.passId,
              owner,
              trace: actorContext.trace,
              requestedMode: "arrangement",
              actualMode: "arrangement",
              requestedRange: { startBeat: 0, endBeat: 4 },
              createdAt: at,
              startedAt: at,
              endedAt: at,
              observations: [observation],
              bindings: [
                {
                  listenerId: "native",
                  deviceReference: "device",
                  connectionEpoch: "epoch",
                  version: "1.0.0",
                  primary: subject("arrangement-range"),
                  contributors: [subject("track")],
                  attribution: "unknown",
                },
              ],
            });
            await repository.appendPass(publication, {
              trace: actorContext.trace,
              activeAgentId: owner.agentId,
            });
            for (const subscribe of subscribers)
              subscribe({
                connectionId: "connection",
                producer: listener.producer,
                binding: listener.binding,
                result: {
                  status: "completed",
                  connectionEpoch: "epoch",
                  passId: job.passId,
                  ...actorContext.trace,
                  nativeCapture: failure === "proof" ? undefined : proof,
                  observation,
                },
              });
            job = {
              ...job,
              stage: "completed",
              contextIds: [publication.entries[0].id],
            };
            supplied.onChange(job);
            playing = true;
            return job;
          },
        };
      }),
      createAgentRuntime: vi.fn((supplied) => {
        options = supplied;
        ports = supplied.listening({});
        return {
          ableton: {
            inspectListeningContext: async () => ({
              listeners: [target],
              transport: {
                playing,
                currentBeat: playing ? 4 : 0,
                tempo: 120,
                safeToStart: !playing,
                recording: {
                  recordMode: false,
                  sessionRecord: false,
                  arrangementOverdub: false,
                  sessionAutomationRecord: false,
                },
              },
            }),
          },
          signals: {
            start: startIngress,
            stop: stopIngress,
            listeners: {
              inspectListeners: () => [globalThis.structuredClone(listener)],
              onListenerResult: (subscriber) => {
                subscribers.add(subscriber);
                return () => subscribers.delete(subscriber);
              },
            },
          },
          application: {
            start: async ({ startAgent }) => {
              if (!ingressStarted)
                throw new Error("Signal ingress must start before application");
              if (failure === "start") throw new Error("test start failure");
              agentServiceStarted = startAgent === true;
            },
            stop: async () => {
              close();
              if (failure === "stop") throw new Error("test stop failure");
            },
            getStatus: async () => ({
              state: "connected",
              saved: true,
              liveSetId: "set",
              liveSetName: `${manifest.artifactPrefix}${runId}`,
              liveVersion: "11.3.43",
            }),
            inspectSession: async () => ({ isPlaying: playing, trackCount: 1 }),
            subscribe: (subscriber) => {
              appEvents.add(subscriber);
              return () => appEvents.delete(subscriber);
            },
            createManagedAgent: async (config) => {
              if (!agentServiceStarted)
                throw new Error("Copilot agent service is not started");
              configuration = config;
              return "sdk-session";
            },
            sendToManagedAgent: async (_agentId, prompt) => {
              expect(prompt).toContain('{"action":"inspect-listeners"}');
              expect(prompt).toContain("never supply listenerIds to it");
              expect(prompt).not.toContain("No other ID is approved");
              if (humanGate) {
                for (const subscriber of appEvents)
                  subscriber({ type: "agent.elicitation_requested" });
                return "No supplied answer";
              }
              const context = {
                sessionId: configuration.productionSessionId,
                agentId: configuration.instanceId,
                actorKind: "agent",
                trace: {
                  traceId: randomUUID(),
                  correlationId: "actor",
                  causationId: "invocation",
                },
              };
              for (const action of [
                "inspect-listeners",
                "play-arrangement-and-listen",
                "get-pass",
              ]) {
                const params =
                  action === "play-arrangement-and-listen"
                    ? {
                        action,
                        listenerIds: ["native"],
                        startBeat: 0,
                        endBeat: 4,
                        maximumDurationMs: 8000,
                      }
                    : action === "get-pass"
                      ? { action, passId: job.passId }
                      : { action };
                const allowed = await supplied.requestToolApproval({
                  metadata: {
                    name: "ableton_listening",
                    risk: params.action.startsWith("play")
                      ? "reversible"
                      : "read",
                  },
                  arguments: params,
                  agentInstanceId: configuration.instanceId,
                });
                if (!allowed) throw new Error("Test actor approval denied");
                await ports.executeListeningOperation(params, context);
                for (const subscriber of appEvents)
                  subscriber({ type: "operation.started" });
              }
              if (failure === "clock-and-policy")
                expect(
                  await supplied.requestToolApproval({
                    metadata: { name: "ableton_context", risk: "read" },
                    arguments: {
                      action: "get",
                      contextId: job.passId,
                      includeHistorical: true,
                    },
                    agentInstanceId: configuration.instanceId,
                  }),
                ).toBe(false);
              expect(job.stage).toBe("arming");
              return "Test model ends its turn while real terminal work remains";
            },
          },
        };
      }),
    };
    const runner = await createNativeListeningRunner({
      manifest,
      inputPath,
      directory: join(f.root, "runner"),
      environment: { ABLETON_AGENT_TOKEN: "x".repeat(40) },
      runId,
      services,
      waitForBridge: async () => ({ attempts: 1, elapsedMs: 0 }),
    });
    return {
      ...f,
      runner,
      services,
      close,
      journalClose,
      wait,
      startIngress,
      stopIngress,
      subscribers,
      appEvents,
      get configuration() {
        return configuration;
      },
      get options() {
        return options;
      },
    };
  }

  describe("native runner orchestration with production typed context services and test-only actor/capture", () => {
    it("persists only bounded audio hash and size receipts, not filenames or audio bodies", async () => {
      const f = await runnerFixture({
        audioName: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890.wav",
      });
      const result = await f.runner.run(async () => {});
      expect(result.ok).toBe(true);
      expect(result.fixture.audioResourceCount).toBe(1);
      const bytes = await readFile(f.input.audioFiles[0].path);
      expect(result.fixture.audioResources).toEqual([
        { sha256: hash(bytes), bytes: bytes.length },
      ]);
      expect(JSON.stringify(result.fixture)).not.toContain("ghp_");
      expect(JSON.stringify(result.fixture)).not.toContain("placeholder");
      await f.runner.close({ processStopped: true });
      await expect(access(f.runner.fixture.setPath)).rejects.toThrow();
    });

    it("fails credential publication before ingress startup or actor work", async () => {
      const f = await runnerFixture({ failure: "credentials" });
      const result = await f.runner.run(async () => {});
      expect(result.ok).toBe(false);
      expect(result.error).toContain("test credential publication failure");
      expect(f.startIngress).not.toHaveBeenCalled();
      expect(f.stopIngress).toHaveBeenCalledOnce();
      expect(f.wait).not.toHaveBeenCalled();
      expect(result.jobs).toEqual([]);
      await expect(
        access(f.runner.storage.signalIngressSecretPath),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await f.runner.close({ processStopped: true });
    });
    it.each(["signal-start", "signal-stop"])(
      "reports %s and always attempts owned ingress shutdown",
      async (failure) => {
        const f = await runnerFixture({ failure });
        const result = await f.runner.run(async () => {});
        expect(result.ok).toBe(false);
        expect(result.error ?? result.cleanupError).toContain(
          failure === "signal-start"
            ? "test signal start failure"
            : "test signal stop failure",
        );
        expect(f.startIngress).toHaveBeenCalledOnce();
        expect(f.stopIngress).toHaveBeenCalledOnce();
        expect(f.services.publishSignalSecrets).toHaveBeenCalledOnce();
        await expect(
          access(f.runner.storage.signalIngressSecretPath),
        ).rejects.toMatchObject({ code: "ENOENT" });
        expect(f.close).toHaveBeenCalledOnce();
        await f.runner.close({ processStopped: true });
      },
    );
    it("fails a post-arm insert-marker denial without seeking, retrying or publishing context", async () => {
      const f = await runnerFixture({ failure: "marker", terminal: "failed" });
      const result = await f.runner.run(async () => {});
      expect(result.ok).toBe(false);
      expect(result.error).toContain(
        "Arrangement insert marker does not match the requested start",
      );
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0]).toMatchObject({
        stage: "failed",
        contextIds: [],
        error: "Arrangement insert marker does not match the requested start",
      });
      expect(f.wait).toHaveBeenCalledOnce();
      expect(f.services.createAgentRuntime).toHaveBeenCalledOnce();
      const sessions = await new JsonSessionStore(
        f.runner.storage.sessionsPath,
        f.runner.storage,
      ).load();
      const manager = createDesktopSessionContextManager({
        storage: f.runner.storage,
        resolveSession: async () => sessions[0],
        publishSessionContext: async () => {
          throw new Error("Denied pass must never publish");
        },
      });
      try {
        const repository = await manager.resolveRepository({
          sessionId: sessions[0].id,
          agentId: sessions[0].activeAgents[0].id,
          actorKind: "application",
          trace: {
            traceId: randomUUID(),
            correlationId: "denial",
            causationId: "post-arm",
          },
        });
        expect(
          (await repository.listEntries({ includeHistorical: true, limit: 20 }))
            .items,
        ).toEqual([]);
      } finally {
        await manager.close();
        await f.runner.close({ processStopped: true });
      }
    });
    it("closes its journal even if final evidence flushing fails", async () => {
      const f = await runnerFixture({
        failure: "start",
        journalFlushFailure: true,
      });
      expect((await f.runner.run(async () => {})).ok).toBe(false);
      await expect(f.runner.close({ processStopped: true })).rejects.toThrow(
        "test journal flush failure",
      );
      expect(f.journalClose).toHaveBeenCalledOnce();
      await expect(access(f.runner.fixture.setPath)).rejects.toThrow();
    });
    it("retains a terminal native failure ahead of a secondary denied context request", async () => {
      const f = await runnerFixture({
        failure: "clock-and-policy",
        terminal: "failed",
      });
      const result = await f.runner.run(async () => {});
      expect(result.ok).toBe(false);
      expect(result.error).toContain("native_clock_discontinuity");
      expect(result.approvals.filter((item) => !item.approved)).toHaveLength(1);
      expect(result.jobs).toEqual([
        expect.objectContaining({
          stage: "failed",
          error: "native_clock_discontinuity",
          contextIds: [],
        }),
      ]);
      expect(f.wait).toHaveBeenCalledOnce();
      expect(f.stopIngress).toHaveBeenCalledOnce();
      await f.runner.close({ processStopped: true });
    });
    it("waits after model arming acceptance, verifies one atomic context and actually reopens the production store", async () => {
      const f = await runnerFixture();
      const ownership = vi.fn(async () => {});
      const result = await f.runner.run(ownership);
      expect(result.error).toBeUndefined();
      expect(result.cleanupError).toBeUndefined();
      expect(result.ok).toBe(true);
      expect(f.wait).toHaveBeenCalledOnce();
      expect(f.services.createListeningRuntimeHost).toHaveBeenCalledOnce();
      expect(result.evidence.stereoFrames).toBe(96000);
      expect(result.lifecycle.map((event) => event.name)).toContain(
        "integration.native_listening.typed-context-reopen.completed",
      );
      expect(f.configuration.resolvedOperations).toContain(
        "listening.play_arrangement_and_listen",
      );
      expect(f.options.agent.baseDirectory).toBe(
        f.runner.storage.copilotDirectory,
      );
      expect(f.close).toHaveBeenCalledOnce();
      expect(f.startIngress).toHaveBeenCalledOnce();
      expect(f.stopIngress).toHaveBeenCalledOnce();
      expect(result.lifecycle.map((event) => event.name)).toContain(
        "integration.native_listening.signal-start.completed",
      );
      expect(result.lifecycle.map((event) => event.name)).toContain(
        "integration.native_listening.signal-shutdown.completed",
      );
      expect(f.subscribers.size).toBe(0);
      expect(f.appEvents.size).toBe(0);
      await f.runner.close({ processStopped: true });
      await expect(access(f.runner.fixture.setPath)).rejects.toThrow();
    });
    it.each(["start", "proof", "cancelled", "stop"])(
      "fails %s without inferring success and closes only its own services",
      async (failure) => {
        const f = await runnerFixture({ failure });
        const result = await f.runner.run(async () => {});
        expect(result.ok).toBe(false);
        if (failure === "start")
          expect(result.error).toContain("test start failure");
        if (failure === "cancelled")
          expect(result.error).toContain("test cancellation");
        if (failure === "proof") expect(result.error).toContain("expected");
        if (failure === "stop")
          expect(result.cleanupError).toContain("test stop failure");
        expect(f.close).toHaveBeenCalledOnce();
        expect(f.stopIngress).toHaveBeenCalledOnce();
        expect(f.subscribers.size).toBe(0);
        await f.runner.close({ processStopped: true });
      },
    );
    it("denies a human gate and failed terminal state; never deletes a surviving process's fixture", async () => {
      for (const opts of [{ humanGate: true }, { terminal: "failed" }]) {
        const f = await runnerFixture(opts);
        const result = await f.runner.run(async () => {});
        expect(result.ok).toBe(false);
        expect(result.error).toContain(
          opts.humanGate ? "human gate" : "terminal job did not complete",
        );
        await expect(f.runner.close({ processStopped: false })).rejects.toThrow(
          "retained staging",
        );
        await expect(access(f.runner.fixture.setPath)).resolves.toBeUndefined();
      }
    });
  });

  it.each(["sourceSetSha256", "deviceSha256", "candidateManifestSha256"])(
    "rejects a mismatched %s before staging",
    async (field) => {
      const f = await nativeFixtureInput();
      f.input[field] = "f".repeat(64);
      await expect(stageNativeListeningFixture(f)).rejects.toThrow(
        /hash mismatch|Unsupported/,
      );
      await expect(access(f.destination)).rejects.toThrow();
    },
  );

  it("refuses missing resources, unexpected resources and symlinks", async () => {
    const f = await nativeFixtureInput();
    await rm(join(f.input.candidateDirectory, "engine.js"));
    await expect(stageNativeListeningFixture(f)).rejects.toThrow("Missing");
    await symlink(
      f.input.sourceSet,
      join(f.input.candidateDirectory, "engine.js"),
    );
    await expect(stageNativeListeningFixture(f)).rejects.toThrow("regular");
    await rm(join(f.input.candidateDirectory, "engine.js"));
    await writeFile(
      join(f.input.candidateDirectory, "unreviewed.js"),
      "unreviewed",
    );
    await expect(stageNativeListeningFixture(f)).rejects.toThrow("Unreviewed");
  });

  it("denies external unscoped Max code, unprovisioned audio and unsupported reference encodings", async () => {
    const f = await nativeFixtureInput();
    for (const path of [
      "/operator-owned/old.amxd",
      "/operator-owned/unprovisioned.wav",
      "/operator-owned/unprovisioned.aif",
    ]) {
      const source = gzipSync(
        `<Ableton ><FileRef><RelativePathType Value="3" /><RelativePath Value="Native-Listener-Candidate/Candidate.amxd" /><Path Value="${path}" /></FileRef></Ableton>`,
      );
      expect(() => inspectNativeFixtureSet(source, f.input)).toThrow(
        /Unsafe fixture/,
      );
    }
    expect(() =>
      inspectNativeFixtureSet(
        gzipSync("<!DOCTYPE example><Ableton />"),
        f.input,
      ),
    ).toThrow("Unsupported");
  });

  it("cancels without copying and preserves pre-existing destinations", async () => {
    const f = await nativeFixtureInput();
    const abort = new globalThis.AbortController();
    abort.abort(new Error("cancelled"));
    await expect(
      stageNativeListeningFixture({ ...f, signal: abort.signal }),
    ).rejects.toThrow("cancelled");
    await expect(access(f.destination)).rejects.toThrow();
    await mkdir(f.destination);
    await writeFile(join(f.destination, "owned-by-someone-else"), "preserve");
    await expect(stageNativeListeningFixture(f)).rejects.toThrow();
    expect(await readdir(f.destination)).toEqual(["owned-by-someone-else"]);
  });

  it.each([1, 2, 3])(
    "cleans a partially written v%i owned copy on cancellation",
    async (nativeVersion) => {
      const f = await nativeFixtureInput({ nativeVersion });
      const abort = new globalThis.AbortController();
      let checks = 0;
      const signal = {
        throwIfAborted() {
          if (++checks === 9) abort.abort(new Error("cancelled during copy"));
          abort.signal.throwIfAborted();
        },
      };
      await expect(
        stageNativeListeningFixture({ ...f, signal }),
      ).rejects.toThrow("cancelled");
      await expect(access(f.destination)).rejects.toThrow();
      expect(await readFile(f.input.sourceSet)).toEqual(f.source);
    },
  );
});
