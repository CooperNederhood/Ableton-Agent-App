import { constants } from "node:fs";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { TextDecoder } from "node:util";
import { writeProducerDiscoveryConfiguration } from "../m4l-producer-companions.mjs";

const NAMESPACE = resolve(".test-artifacts/independent-metric-listening");
const MAX_FILE = 8 * 1024 * 1024;
const MAX_TOTAL = 64 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function hasControls(value, xmlWhitespace = false) {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 32 && !(xmlWhitespace && [9, 10, 13].includes(code)))
      return true;
  }
  return false;
}
const roles = [
  "device",
  "controller",
  "guard",
  "identity",
  "signal-client",
  "clock",
  "analysis",
  "detector-input",
];
const inside = (root, path) => {
  const suffix = relative(root, path);
  return (
    suffix !== "" &&
    suffix !== ".." &&
    !suffix.startsWith(`..${sep}`) &&
    !suffix.startsWith(sep)
  );
};

function safeRelative(path) {
  if (
    typeof path !== "string" ||
    path.length > 1024 ||
    /[\\:<>]/.test(path) ||
    hasControls(path) ||
    path.split("/").length > 16 ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error("unsafe_relative_resource");
  return path;
}

function safeAbsolute(path) {
  if (
    typeof path !== "string" ||
    path.length > 4096 ||
    resolve(path) !== path ||
    /[\\<>]/.test(path) ||
    hasControls(path)
  )
    throw new Error("unsafe_absolute_resource");
  return path;
}

async function regular(path, limit, signal) {
  signal?.throwIfAborted();
  safeAbsolute(path);
  const before = await lstat(path, { bigint: true });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size <= 0n ||
    before.size > BigInt(limit) ||
    (await realpath(path)) !== path
  )
    throw new Error("resource_not_regular_or_bounded");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await file.stat({ bigint: true });
    const bytes = await file.readFile();
    const after = await file.stat({ bigint: true });
    const named = await lstat(path, { bigint: true });
    if (
      [opened, after, named].some(
        (s) =>
          s.dev !== before.dev ||
          s.ino !== before.ino ||
          s.size !== before.size ||
          s.mtimeNs !== before.mtimeNs ||
          s.ctimeNs !== before.ctimeNs,
      ) ||
      BigInt(bytes.length) !== before.size ||
      (await realpath(path)) !== path
    )
      throw new Error("resource_changed_during_read");
    signal?.throwIfAborted();
    return bytes;
  } finally {
    await file.close();
  }
}

function decode(value) {
  if (/&(?!amp;|quot;|apos;|lt;|gt;)/.test(value))
    throw new Error("unsupported_xml_entity");
  return value.replace(
    /&(amp|quot|apos|lt|gt);/g,
    (_, key) => ({ amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" })[key],
  );
}
const encode = (value) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

function field(block, tag) {
  const matches = [
    ...block.matchAll(new RegExp(`<${tag}\\s+Value="([^"]*)"\\s*/>`, "g")),
  ];
  if (matches.length !== 1) throw new Error("ambiguous_reference_field");
  return decode(matches[0][1]);
}

function replaceField(block, tag, value) {
  field(block, tag);
  return block.replace(
    new RegExp(`(<${tag}\\s+Value=")[^"]*("\\s*/>)`),
    (_, start, end) => `${start}${encode(value)}${end}`,
  );
}

/** Deliberately limited to reviewed Live 11 XML, not a general XML parser. */
function inspectXml(bytes, expected) {
  const expanded = gunzipSync(bytes, { maxOutputLength: 16 * 1024 * 1024 });
  const xml = new TextDecoder("utf-8", { fatal: true }).decode(expanded);
  if (/<!|<\?(?!xml\s)/i.test(xml) || hasControls(xml, true))
    throw new Error("unsupported_xml_markup");
  if (
    expected.creator !== "Ableton Live 11.3.43" ||
    !xml.includes(`Creator="${expected.creator}"`)
  )
    throw new Error("unreviewed_live_creator");
  const stack = [];
  const references = [];
  let pending;
  let tokens = 0;
  let audioTracks = 0;
  let midiTracks = 0;
  let cursor = 0;
  let rootSeen = false;
  for (const token of xml.matchAll(
    /<\?xml\s[^<>]*\?>|<\/?[A-Za-z_][\w.-]*(?:\s+[\w.-]+="[^"<]*")*\s*\/?>/g,
  )) {
    const text = xml.slice(cursor, token.index);
    if (
      ++tokens > 250_000 ||
      /[<>]/.test(text) ||
      (stack.length === 0 && text.trim() !== "")
    )
      throw new Error("malformed_or_large_xml");
    cursor = token.index + token[0].length;
    if (token[0].startsWith("<?xml")) {
      if (tokens !== 1) throw new Error("misplaced_xml_declaration");
      continue;
    }
    const name = token[0].match(/^<\/?([\w.-]+)/)[1];
    if (token[0].startsWith("</")) {
      if (stack.pop() !== name) throw new Error("unbalanced_xml");
      if (name === "FileRef") {
        references.push({
          ...pending,
          end: cursor,
          block: xml.slice(pending.start, cursor),
        });
        pending = undefined;
      }
    } else {
      if (stack.length === 0) {
        if (rootSeen || name !== "Ableton")
          throw new Error("invalid_saved_set_root");
        rootSeen = true;
      }
      if (name === "AudioTrack") audioTracks++;
      if (name === "MidiTrack") midiTracks++;
      if (name === "FileRef") {
        if (pending || token[0].endsWith("/>"))
          throw new Error("unsupported_file_reference");
        pending = {
          start: token.index,
          historical:
            stack.includes("LastPresetRef") ||
            (stack.includes("SourceContext") &&
              stack.includes("BranchSourceContext") &&
              (stack.at(-1) === "OriginalFileRef" ||
                (stack.at(-1) === "AbletonDefaultPresetRef" &&
                  stack.includes("PresetRef")))),
        };
      }
      if (!token[0].endsWith("/>")) stack.push(name);
      if (stack.length > 256) throw new Error("xml_depth_limit");
    }
  }
  if (
    stack.length ||
    pending ||
    xml.slice(cursor).trim() !== "" ||
    references.length !== expected.fileReferences ||
    references.length > 256 ||
    audioTracks !== expected.audioTracks ||
    midiTracks !== expected.midiTracks ||
    audioTracks !== 1 ||
    midiTracks !== 1
  )
    throw new Error("unreviewed_saved_set_structure");
  return { xml, references };
}

function audioHeader(path, bytes) {
  if (
    /\.aiff?$/i.test(path) &&
    !(
      bytes.subarray(0, 4).toString() === "FORM" &&
      ["AIFF", "AIFC"].includes(bytes.subarray(8, 12).toString())
    )
  )
    throw new Error("invalid_aiff_resource");
  if (
    /\.wav$/i.test(path) &&
    !(
      bytes.subarray(0, 4).toString() === "RIFF" &&
      bytes.subarray(8, 12).toString() === "WAVE"
    )
  )
    throw new Error("invalid_wav_resource");
}

function destinationPath(destination) {
  const root = safeAbsolute(resolve(destination));
  if (
    dirname(root) !== NAMESPACE ||
    !/^candidate-[A-Za-z0-9_-]{1,120}$/.test(basename(root))
  )
    throw new Error("fresh_explicit_candidate_namespace_required");
  return root;
}

async function directory(path) {
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (await realpath(path)) !== path
  )
    throw new Error("unsafe_resource_directory");
}

async function bundleSnapshot(bundle, read, signal) {
  if (!bundle) return null;
  if (!HASH.test(bundle.manifestSha256))
    throw new Error("bundle_manifest_pin_required");
  const root = safeAbsolute(bundle.directory);
  await directory(root);
  const manifestName = safeRelative(bundle.manifestFile);
  if (basename(manifestName) !== manifestName)
    throw new Error("flat_bundle_required");
  const bytes = await read(
    join(root, manifestName),
    bundle.manifestSha256,
    64 * 1024,
  );
  const manifest = JSON.parse(bytes.toString("utf8"));
  if (
    manifest.schema !== "saved-listening-native-bundle/v1" ||
    manifest.nativeVersion !== 5 ||
    manifest.guardNativeVersion !== 5 ||
    manifest.observationSchema !== "metric-audio-observation/v1" ||
    !["reviewed-candidate", "synthetic-test"].includes(
      manifest.provenance?.kind,
    ) ||
    typeof manifest.provenance?.reviewId !== "string" ||
    !/^[A-Za-z0-9_.-]{1,128}$/.test(manifest.provenance.reviewId) ||
    !Array.isArray(manifest.resources) ||
    manifest.resources.length > 60 ||
    !Array.isArray(bundle.requiredCompanions) ||
    bundle.requiredCompanions.length < 1 ||
    bundle.requiredCompanions.length > 60
  )
    throw new Error("unreviewed_or_ambiguous_native_v5_bundle");
  const files = new Map([[manifestName, bytes]]);
  const foundRoles = new Set();
  for (const resource of manifest.resources) {
    signal?.throwIfAborted();
    const name = safeRelative(resource.name);
    if (
      basename(name) !== name ||
      files.has(name) ||
      name === "agent_signal_storage.js" ||
      !/^[A-Za-z0-9_.-]+$/.test(name) ||
      /native_v[1-4](?:_|[.])/i.test(name) ||
      !Number.isSafeInteger(resource.bytes) ||
      resource.bytes < 1 ||
      !Array.isArray(resource.roles) ||
      resource.roles.length < 1 ||
      resource.roles.some(
        (role) => !roles.includes(role) && role !== "companion",
      )
    )
      throw new Error("unsafe_or_ambiguous_bundle_resource");
    const content = await read(
      join(root, name),
      resource.sha256,
      2 * 1024 * 1024,
    );
    if (content.length !== resource.bytes)
      throw new Error("bundle_resource_size_mismatch");
    files.set(name, content);
    resource.roles.forEach((role) => foundRoles.add(role));
  }
  const names = [...files.keys()].sort();
  const companionNames = manifest.resources
    .filter((r) => r.name !== manifest.deviceFile)
    .map((r) => r.name)
    .sort();
  if (
    JSON.stringify((await readdir(root)).sort()) !== JSON.stringify(names) ||
    roles.some((role) => !foundRoles.has(role)) ||
    JSON.stringify(bundle.requiredCompanions.map(safeRelative).sort()) !==
      JSON.stringify(companionNames) ||
    !/^[A-Za-z0-9_-]+\.amxd$/.test(manifest.deviceFile) ||
    !files.has(manifest.deviceFile) ||
    names.filter((name) => /\.amxd$/i.test(name)).length !== 1 ||
    !manifest.resources
      .find((r) => r.name === manifest.deviceFile)
      ?.roles.includes("device") ||
    !manifest.resources.some(
      (r) =>
        r.roles.includes("controller") && /native_v5[_.].*\.js$/.test(r.name),
    ) ||
    roles.some(
      (role) =>
        !manifest.resources.some(
          (r) =>
            r.roles.includes(role) &&
            (role === "device"
              ? /\.amxd$/.test(r.name)
              : ["clock", "analysis", "detector-input"].includes(role)
                ? /\.maxpat$/.test(r.name)
                : /\.js$/.test(r.name)),
        ),
    )
  )
    throw new Error("incomplete_matched_native_v5_companions");
  return { root, manifest, manifestName, files };
}

async function plan({ input, destination, bundle, signal }) {
  const root = destinationPath(destination);
  const sourceProject = safeAbsolute(input.sourceProject);
  const originalPrefix = safeAbsolute(input.originalProjectPrefix);
  await directory(sourceProject);
  const sourceSet = safeAbsolute(input.sourceSet);
  if (dirname(sourceSet) !== sourceProject || !/\.als$/i.test(sourceSet))
    throw new Error("source_set_outside_reviewed_project");
  if (
    !Array.isArray(input.projectFiles) ||
    input.projectFiles.length > 16 ||
    !Array.isArray(input.externalFiles) ||
    input.externalFiles.length > 128 ||
    !Array.isArray(input.historicalReferences) ||
    input.historicalReferences.length > 64 ||
    !Array.isArray(input.factoryRoots) ||
    input.factoryRoots.length > 2
  )
    throw new Error("saved_fixture_resource_quota");
  const pins = [];
  let total = 0;
  const read = async (path, expected, limit = MAX_FILE) => {
    if (!HASH.test(expected)) throw new Error("resource_hash_pin_required");
    const bytes = await regular(path, limit, signal);
    if (hash(bytes) !== expected) throw new Error("resource_hash_mismatch");
    total += bytes.length;
    if (total > MAX_TOTAL) throw new Error("saved_fixture_total_byte_quota");
    pins.push({ path, sha256: expected, limit });
    return bytes;
  };
  const source = await read(sourceSet, input.sourceSetSha256);
  const parsed = inspectXml(source, input.expected);
  const projectFiles = new Map();
  for (const file of input.projectFiles) {
    const name = safeRelative(file.relativePath);
    if (projectFiles.has(name)) throw new Error("duplicate_project_resource");
    const bytes = await read(join(sourceProject, name), file.sha256);
    audioHeader(name, bytes);
    projectFiles.set(name, bytes);
  }
  const externalFiles = new Map();
  const factoryRoots = input.factoryRoots.map(safeAbsolute);
  for (const file of input.externalFiles) {
    const path = safeAbsolute(file.path);
    if (
      !factoryRoots.some((base) => inside(base, path)) ||
      externalFiles.has(path)
    )
      throw new Error("unreviewed_external_resource");
    const bytes = await read(path, file.sha256);
    audioHeader(path, bytes);
    externalFiles.set(path, { sha256: file.sha256, bytes: bytes.length });
  }
  const candidate = await bundleSnapshot(bundle, read, signal);
  if (
    candidate &&
    hash(candidate.files.get(candidate.manifest.deviceFile)) ===
      input.device.sha256
  )
    throw new Error("old_saved_device_cannot_qualify_as_native_v5");
  const historical = new Map(
    input.historicalReferences.map((ref) => [ref.index, ref.sha256]),
  );
  if (historical.size !== input.historicalReferences.length)
    throw new Error("duplicate_history_pin");
  const usedProject = new Set();
  const usedExternal = new Set();
  const usedHistory = new Set();
  let deviceReferences = 0;
  const changes = [];
  const evidence = [];
  let rebound = "";
  let masked = "";
  let cursor = 0;
  for (const [index, ref] of parsed.references.entries()) {
    signal?.throwIfAborted();
    const path = field(ref.block, "Path");
    const relativePath = field(ref.block, "RelativePath");
    const type = field(ref.block, "RelativePathType");
    let updated = ref.block;
    let mask = ref.block;
    let kind;
    if (!path && !relativePath && type === "0") kind = "empty";
    else if (
      ["1", "5"].includes(type) &&
      ref.historical &&
      historical.get(index) === hash(ref.block)
    ) {
      // Reviewed inert preset/source history is preserved byte-for-byte, never
      // interpreted as a filesystem path (including historical traversal text).
      if (type === "5") {
        const base = factoryRoots.find((base) => inside(base, path));
        if (!base || path !== `${base}/${safeRelative(relativePath)}`)
          throw new Error("unreviewed_factory_history_coordinate");
      }
      kind = "pinned-inert-history";
      usedHistory.add(index);
    } else if (
      type === "3" &&
      relativePath !== input.device.relativePath &&
      path === `${originalPrefix}/${safeRelative(relativePath)}` &&
      projectFiles.has(relativePath)
    ) {
      kind = "project";
      usedProject.add(relativePath);
      updated = replaceField(updated, "Path", join(root, relativePath));
      mask = replaceField(mask, "Path", "OWNED_PROJECT_REFERENCE");
      changes.push({
        index,
        field: "Path",
        source: path,
        destination: join(root, relativePath),
      });
    } else if (
      relativePath === input.device.relativePath &&
      ((type === "6" && path === input.device.absolutePath) ||
        (type === "3" &&
          path === `${originalPrefix}/${safeRelative(relativePath)}`)) &&
      projectFiles.has(relativePath)
    ) {
      kind = "native-device";
      deviceReferences++;
      usedProject.add(relativePath);
      if (candidate) {
        const target = `Native-Listener-Candidate/${candidate.manifest.deviceFile}`;
        for (const [tag, value] of [
          ["RelativePathType", "3"],
          ["RelativePath", target],
          ["Path", join(root, target)],
        ]) {
          updated = replaceField(updated, tag, value);
          mask = replaceField(mask, tag, `OWNED_NATIVE_${tag}`);
          changes.push({ index, field: tag, destination: value });
        }
      }
    } else if (["5", "7"].includes(type) && externalFiles.has(path)) {
      safeRelative(relativePath);
      const base = factoryRoots.find((base) => inside(base, path));
      if (relative(base, path).split(sep).join("/") !== relativePath)
        throw new Error("factory_reference_coordinate_mismatch");
      kind = "pinned-immutable-factory";
      usedExternal.add(path);
    } else throw new Error(`unreviewed_file_reference_${index}`);
    let maskedUpdated = updated;
    for (const tag of kind === "project"
      ? ["Path"]
      : kind === "native-device" && candidate
        ? ["RelativePathType", "RelativePath", "Path"]
        : []) {
      maskedUpdated = replaceField(
        maskedUpdated,
        tag,
        kind === "project" ? "OWNED_PROJECT_REFERENCE" : `OWNED_NATIVE_${tag}`,
      );
    }
    if (maskedUpdated !== mask)
      throw new Error("musical_xml_preservation_failed");
    evidence.push({
      index,
      kind,
      referenceSha256: hash(ref.block),
      ...(kind === "project" ? { relativePath } : {}),
    });
    rebound += parsed.xml.slice(cursor, ref.start) + updated;
    masked += parsed.xml.slice(cursor, ref.start) + mask;
    cursor = ref.end;
  }
  rebound += parsed.xml.slice(cursor);
  masked += parsed.xml.slice(cursor);
  if (
    usedProject.size !== projectFiles.size ||
    usedExternal.size !== externalFiles.size ||
    usedHistory.size !== historical.size ||
    deviceReferences !== input.expected.deviceReferences
  )
    throw new Error("unused_pins_or_unreviewed_device_count");
  const deviceBytes = projectFiles.get(input.device.relativePath);
  if (!deviceBytes || hash(deviceBytes) !== input.device.sha256)
    throw new Error("source_device_pin_mismatch");
  const stagedSet = gzipSync(rebound, { level: 9 });
  if (stagedSet.length > MAX_FILE) throw new Error("staged_set_byte_quota");
  return {
    root,
    source,
    sourceSet,
    projectFiles,
    pins,
    candidate,
    stagedSet,
    report: {
      schema: "saved-listening-fixture-plan/v1",
      status: candidate ? "planned-offline" : "blocked",
      blockers: candidate ? [] : ["missing-reviewed-matched-native-v5-bundle"],
      loadedOrLiveValidated: false,
      sourceSetSha256: hash(source),
      preservedXmlSha256: hash(masked),
      creator: input.expected.creator,
      referenceCount: evidence.length,
      projectResources: [...projectFiles].map(([relativePath, bytes]) => ({
        relativePath,
        bytes: bytes.length,
        sha256: hash(bytes),
      })),
      externalResources: [...externalFiles].map(([path, value]) => ({
        path,
        ...value,
      })),
      references: evidence,
      rebindings: changes,
      candidateProvenance: candidate?.manifest.provenance ?? null,
      requiredDeviceReplacement: {
        referenceCount: deviceReferences,
        sourceSha256: input.device.sha256,
        nativeVersion: 5,
        completeBundlePinned: candidate !== null,
      },
      limitations: [
        "Offline hash-pinned preparation only; no proof of loaded Max code or physical audio.",
        "Profile/discovery ownership and process launch remain caller responsibilities.",
      ],
    },
  };
}

/**
 * No writes. Input pins the Set/creator/track and reference counts, exact old
 * project prefix, project files, external factory files, old device binding,
 * and individually reviewed inert history blocks. No resource is discovered
 * recursively. A missing matched bundle is explicitly blocked, never ready.
 *
 * A supplied bundle uses saved-listening-native-bundle/v1 with nativeVersion
 * and guardNativeVersion 5, metric-audio-observation/v1, review provenance,
 * deviceFile and resources [{name,bytes,sha256,roles}]. The separately reviewed
 * requiredCompanions list must equal every non-device resource. Bundle contents
 * remain opaque: declaration/hash review is not authentic loaded-code proof.
 */
export async function planSavedListeningFixture(options) {
  const snapshot = await plan(options);
  await verifyPins(snapshot.pins, options.signal);
  return snapshot.report;
}

async function verifyPins(pins, signal) {
  for (const pin of pins) {
    if (hash(await regular(pin.path, pin.limit, signal)) !== pin.sha256)
      throw new Error("immutable_fixture_input_changed");
  }
}

async function writeOwned(root, name, bytes, generated, signal) {
  safeRelative(name);
  let parent = root;
  for (const part of name.split("/").slice(0, -1)) {
    signal?.throwIfAborted();
    parent = join(parent, part);
    await mkdir(parent, { mode: 0o700 }).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
    await directory(parent);
  }
  signal?.throwIfAborted();
  await writeFile(join(root, name), bytes, { flag: "wx", mode: 0o600 });
  generated.set(name, hash(bytes));
}

async function inventory(root) {
  const files = [];
  let count = 0;
  const walk = async (parent) => {
    await directory(parent);
    for (const entry of await readdir(parent, { withFileTypes: true })) {
      if (++count > 512 || entry.isSymbolicLink())
        throw new Error("unsafe_staged_inventory");
      const path = join(parent, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile())
        files.push(relative(root, path).split(sep).join("/"));
      else throw new Error("unsafe_staged_inventory");
    }
  };
  await walk(root);
  return files.sort();
}

/** Only creates a fresh named candidate; original projects and copies are read-only. */
export async function stageSavedListeningFixture({
  input,
  destination,
  bundle,
  storage,
  signal,
  stage = async (_name, operation) => operation(),
}) {
  const snapshot = await stage("saved-fixture-plan", () =>
    plan({ input, destination, bundle, signal }),
  );
  await verifyPins(snapshot.pins, signal);
  if (!snapshot.candidate) return snapshot.report;
  if (!storage) throw new Error("caller_resolved_discovery_storage_required");
  const { root, candidate } = snapshot;
  await directory(NAMESPACE);
  signal?.throwIfAborted();
  await mkdir(root, { mode: 0o700 });
  const generated = new Map();
  const removeOwned = async () => {
    await directory(NAMESPACE);
    await directory(root);
    await rm(root, { recursive: true, force: false });
  };
  try {
    await stage("saved-fixture-copy", async () => {
      await mkdir(join(root, "Ableton Project Info"), { mode: 0o700 });
      for (const [name, bytes] of snapshot.projectFiles) {
        if (name !== input.device.relativePath)
          await writeOwned(root, name, bytes, generated, signal);
      }
      for (const [name, bytes] of candidate.files)
        await writeOwned(
          root,
          `Native-Listener-Candidate/${name}`,
          bytes,
          generated,
          signal,
        );
      signal?.throwIfAborted();
      const target = join(root, "Native-Listener-Candidate");
      await directory(target);
      await writeProducerDiscoveryConfiguration(target, storage);
      const discoveryName = "Native-Listener-Candidate/agent_signal_storage.js";
      const discovery = await regular(
        join(root, discoveryName),
        64 * 1024,
        signal,
      );
      generated.set(discoveryName, hash(discovery));
      await writeOwned(
        root,
        basename(input.sourceSet),
        snapshot.stagedSet,
        generated,
        signal,
      );
    });
    const verifyImmutableInputs = async () =>
      stage("saved-fixture-integrity", async () => {
        await verifyPins(snapshot.pins, signal);
        await directory(root);
        for (const [name, expected] of generated) {
          if (
            hash(await regular(join(root, name), MAX_FILE, signal)) !== expected
          )
            throw new Error("immutable_staged_resource_changed");
        }
        if (
          JSON.stringify(await inventory(root)) !==
          JSON.stringify([...generated.keys()].sort())
        )
          throw new Error("immutable_staged_inventory_changed");
        return {
          verified: true,
          files: generated.size,
          sourceSetUnchanged: true,
        };
      });
    await verifyImmutableInputs();
    return {
      ...snapshot.report,
      status: "prepared-offline",
      setPath: join(root, basename(input.sourceSet)),
      stagedSetSha256: hash(snapshot.stagedSet),
      generatedFiles: [...generated].map(([name, sha256]) => ({
        name,
        sha256,
      })),
      verifyImmutableInputs,
      cleanup: () => stage("saved-fixture-cleanup", removeOwned),
    };
  } catch (error) {
    try {
      await stage("saved-fixture-cleanup", removeOwned);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "saved_fixture_failed_and_cleanup_failed",
      );
    }
    throw error;
  }
}
