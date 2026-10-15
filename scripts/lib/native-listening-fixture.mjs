import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";

import { writeProducerDiscoveryConfiguration } from "../m4l-producer-companions.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hashPattern = /^[a-f0-9]{64}$/;
const scopes = {
  1: "arrangement-beat0-120bpm-48000hz-vector64/v1",
  2: "arrangement-descriptive/v2",
};

async function boundedFile(path, limit) {
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size > limit ||
    info.size === 0 ||
    (await realpath(path)) !== resolve(path)
  )
    throw new Error("Fixture input must be a regular, nonempty bounded file");
  const bytes = await readFile(path);
  if (bytes.length !== info.size)
    throw new Error("Fixture input changed while reading");
  return bytes;
}

function within(root, path) {
  const suffix = relative(root, path);
  return (
    suffix !== "" &&
    !suffix.startsWith(`..${sep}`) &&
    suffix !== ".." &&
    !suffix.startsWith(sep)
  );
}

function xmlValue(element, tag) {
  const value = element.match(
    new RegExp(`<${tag}\\s+Value="([^"]*)"\\s*/>`),
  )?.[1];
  if (value === undefined || /&/.test(value))
    throw new Error("Unsupported fixture reference encoding");
  return value;
}

/** Inspection only: the Set is copied byte-for-byte, never rewritten. */
export function inspectNativeFixtureSet(bytes, input) {
  const xml = gunzipSync(bytes, { maxOutputLength: 16 * 1024 * 1024 }).toString(
    "utf8",
  );
  if (!xml.includes("<Ableton ") || /<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new Error("Unsupported Live Set input");
  const references = [
    ...xml.matchAll(/<FileRef(?:\s[^>]*)?>([\s\S]*?)<\/FileRef>/g),
  ].map((match) => match[1]);
  if (references.length > 128)
    throw new Error("Fixture reference quota exceeded");
  const native = references.filter(
    (ref) =>
      xmlValue(ref, "RelativePath") ===
      `${basename(input.candidateDirectory)}/${input.deviceFile}`,
  );
  if (
    native.length === 0 ||
    native.some((ref) => xmlValue(ref, "RelativePathType") !== "3")
  )
    throw new Error(
      "Set does not contain the reviewed project-relative native candidate",
    );
  for (const ref of references) {
    const path = xmlValue(ref, "Path");
    if (!/\.(?:amxd|wav|aiff?|flac|mp3|ogg|m4a|mp4|caf|rx2)$/i.test(path))
      continue;
    if (/\.amxd$/i.test(path)) {
      if (
        resolve(path) !==
        join(resolve(input.candidateDirectory), input.deviceFile)
      )
        throw new Error(
          "Unsafe fixture: external Max device reference; provision a candidate-only Set",
        );
    } else if (!/\.wav$/i.test(path)) {
      throw new Error(
        "Unsafe fixture: only explicitly provisioned WAV sources are supported",
      );
    } else if (
      !input.audioFiles.some((file) => resolve(file.path) === resolve(path))
    ) {
      throw new Error(
        "Unsafe fixture: audio dependency was not explicitly provisioned",
      );
    }
  }
  return { nativeReferenceCount: native.length };
}

/** The caller supplies a new runner directory, never a user project or profile. */
export async function stageNativeListeningFixture({
  input,
  destination,
  storage,
  nativeVersion = 1,
  signal,
  stage = async (_name, operation) => operation(),
}) {
  return stage("fixture-stage", async () => {
    signal?.throwIfAborted();
    if (
      ![1, 2].includes(nativeVersion) ||
      (input.nativeVersion === undefined ? 1 : input.nativeVersion) !==
        nativeVersion
    )
      throw new Error("Explicit matching native version selection required");
    if (
      !hashPattern.test(input.sourceSetSha256) ||
      !hashPattern.test(input.deviceSha256) ||
      !hashPattern.test(input.candidateManifestSha256)
    )
      throw new Error(
        "Explicit source Set, native device and manifest SHA-256 pins are required",
      );
    if (
      !/^[A-Za-z0-9_-]+\.amxd$/.test(input.deviceFile) ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(input.artifactPrefix) ||
      !Array.isArray(input.audioFiles) ||
      input.audioFiles.length > 8
    )
      throw new Error("Invalid provisioned native fixture");
    const source = await boundedFile(input.sourceSet, 8 * 1024 * 1024);
    if (sha256(source) !== input.sourceSetSha256)
      throw new Error("Source Set hash mismatch");
    const directory = resolve(input.candidateDirectory);
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Unsafe candidate directory");
    const names = (await readdir(directory)).sort();
    if (names.length > 64) throw new Error("Candidate resource quota exceeded");
    const manifestBytes = await boundedFile(
      join(directory, "audio-listener-manifest.json"),
      64 * 1024,
    );
    if (sha256(manifestBytes) !== input.candidateManifestSha256)
      throw new Error("Candidate manifest hash mismatch");
    const manifest = JSON.parse(manifestBytes);
    if (
      manifest.nativeMode !== true ||
      manifest.nativeScope !== scopes[nativeVersion] ||
      manifest.realLiveValidated !== false ||
      manifest.deviceFile !== input.deviceFile ||
      manifest.deviceSha256 !== input.deviceSha256 ||
      manifest.externalAuthoringBridge !== false ||
      (nativeVersion === 1
        ? manifest.nativeVersion !== undefined
        : manifest.nativeVersion !== 2 ||
          manifest.algorithmVersion !== "2.0.0" ||
          manifest.observationSchema !== "audio-observation/v2" ||
          manifest.providerLimits?.durationMs !== 30000 ||
          manifest.providerLimits?.maxWindows !== 300 ||
          manifest.tempoPolicy !== "constant-tempo-assumed" ||
          manifest.tempoAutomationSupported !== false)
    )
      throw new Error("Unsupported or promoted native candidate");
    const resources = new Map(
      manifest.resources.map((item) => [item.name, item]),
    );
    if (resources.size !== manifest.resources.length || resources.size > 60)
      throw new Error("Invalid candidate resource manifest");
    const snapshots = new Map();
    for (const name of names) {
      signal?.throwIfAborted();
      if (basename(name) !== name || !/^[A-Za-z0-9_.-]+$/.test(name))
        throw new Error("Unsafe candidate resource name");
      const bytes = await boundedFile(join(directory, name), 2 * 1024 * 1024);
      const expected =
        name === input.deviceFile
          ? input.deviceSha256
          : resources.get(name)?.sha256;
      if (
        expected !== undefined &&
        (!hashPattern.test(expected) || sha256(bytes) !== expected)
      )
        throw new Error("Native candidate resource hash mismatch");
      if (
        expected === undefined &&
        !["audio-listener-manifest.json", "agent_signal_storage.js"].includes(
          name,
        )
      )
        throw new Error("Unreviewed native candidate resource");
      if (resources.has(name) && resources.get(name).bytes !== bytes.length)
        throw new Error("Native candidate resource length mismatch");
      snapshots.set(name, bytes);
    }
    if (
      [...resources.keys(), input.deviceFile].some(
        (name) => !snapshots.has(name),
      )
    )
      throw new Error("Missing native candidate resource");
    inspectNativeFixtureSet(source, input);
    for (const file of input.audioFiles) {
      signal?.throwIfAborted();
      if (!hashPattern.test(file.sha256))
        throw new Error("Audio dependency hash pin required");
      if (sha256(await boundedFile(file.path, 4 * 1024 * 1024)) !== file.sha256)
        throw new Error("Audio dependency hash mismatch");
    }
    const root = resolve(destination);
    if (
      !within(resolve(".test-artifacts"), root) ||
      root === directory ||
      within(root, directory)
    )
      throw new Error(
        "Staging must use a fresh runner-owned artifact namespace",
      );
    if ((await realpath(dirname(root))) !== dirname(root))
      throw new Error("Staging must not traverse symbolic links");
    await mkdir(root, { recursive: false, mode: 0o700 });
    try {
      await mkdir(join(root, "Ableton Project Info"), { mode: 0o700 });
      const candidate = join(root, basename(directory));
      await mkdir(candidate, { mode: 0o700 });
      for (const [name, bytes] of snapshots) {
        signal?.throwIfAborted();
        await writeFile(join(candidate, name), bytes, {
          flag: "wx",
          mode: 0o600,
        });
      }
      // Only the copied discovery file changes; code/device hashes remain pinned.
      await writeProducerDiscoveryConfiguration(candidate, storage);
      const setPath = join(root, `${input.artifactPrefix}.als`);
      await writeFile(setPath, source, { flag: "wx", mode: 0o600 });
      return {
        nativeVersion,
        setPath,
        sourceSetSha256: sha256(source),
        deviceSha256: input.deviceSha256,
        discoverySha256: sha256(
          await readFile(join(candidate, "agent_signal_storage.js")),
        ),
        resourceCount: snapshots.size,
        async cleanup() {
          await stage("fixture-cleanup", () =>
            rm(root, { recursive: true, force: true }),
          );
        },
      };
    } catch (error) {
      await rm(root, { recursive: true, force: true });
      throw error;
    }
  });
}
