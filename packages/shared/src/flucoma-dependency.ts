import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir } from "node:fs/promises";
import { dirname, join, parse, resolve, sep } from "node:path";
import {
  NATIVE_MEL_DEPENDENCY_PINS,
  NATIVE_MEL_SOURCE_INPUTS,
} from "./native-mel-pins.js";

export const FLUCOMA_DEPENDENCY_DIRECTORY = "dependencies/flucoma";
export const FLUCOMA_SPECTRALSHAPE_BUNDLE = `${FLUCOMA_DEPENDENCY_DIRECTORY}/fluid.spectralshape~.mxo`;
export const FLUCOMA_PACKAGE_VERSION = "1.0.10+sha.a1f6f90.core.sha.f1551f70";
export const NATIVE_MEL_BUNDLE = `${FLUCOMA_DEPENDENCY_DIRECTORY}/listener.mel~.mxo`;
export const NATIVE_MEL_PRODUCER = Object.freeze({
  schema: "listener-mel-native/v1",
  abi: 2,
  bundle: NATIVE_MEL_BUNDLE,
  binarySha256: NATIVE_MEL_DEPENDENCY_PINS.find(
    ([name]) => name === "listener.mel~.mxo/Contents/MacOS/listener.mel~",
  )![2],
  controlSelector: "mel_native_control",
  returnSelector: "native_mel",
  receiptSelector: "mel_drain",
  hostQualified: false,
});

const pins = [
  [
    "LICENSE.md",
    3359,
    "599aaa4265ee17385565fe2bc2bc5ea910ae703a27a8b7b61298e0cb1e0c7db3",
  ],
  [
    "package-info.json",
    1182,
    "8fb00e9a5b9ccb01bff2057b0dfb2d594c27517ca5a100f72389c6a21b43d226",
  ],
  [
    "docs/fluid.spectralshape~.maxref.xml",
    10668,
    "85c01328c29c6cb7d00b189f67f011328c0734037074eef508445aca6004d972",
  ],
  [
    "fluid.spectralshape~.mxo/Contents/MacOS/fluid.spectralshape~",
    507040,
    "2df23d68d1f04ed5506824b508f566da7bcce670b7ac738acbaded7374857b11",
  ],
  [
    "fluid.spectralshape~.mxo/Contents/_CodeSignature/CodeResources",
    2200,
    "6686de10a28a2fe11b36cbb86dcbacc827cfc4ea116b4dabf1845e5aee629e9b",
  ],
  [
    "fluid.spectralshape~.mxo/Contents/CodeResources",
    1674,
    "5f1ba612c5ce20441d9e960fd14dc6757386c2940995aa575e790497ff535aad",
  ],
  [
    "fluid.spectralshape~.mxo/Contents/Info.plist",
    1169,
    "4ac15d470275af198b2f4b2cba7496529b28ae8c71146536066a76ae1b6ef42b",
  ],
  [
    "README.md",
    3316,
    "1cb8673fe14b09b1ebb1405b4494c6d1ddc0fc448c694100d1364ad7c8bd87fc",
  ],
  ...NATIVE_MEL_DEPENDENCY_PINS,
] as const;

export const FLUCOMA_DEPENDENCY_FILES = Object.freeze(
  pins.map(([name, bytes, sha256]) =>
    Object.freeze({
      name: `${FLUCOMA_DEPENDENCY_DIRECTORY}/${name}`,
      bytes,
      sha256,
      mode: name.includes("/MacOS/") ? 0o755 : 0o644,
    }),
  ),
);
export const FLUCOMA_DEPENDENCY_RESOURCE_NAMES: readonly string[] =
  Object.freeze(FLUCOMA_DEPENDENCY_FILES.map(({ name }) => name));

export function isFlucomaDependencyResource(name: string): boolean {
  return FLUCOMA_DEPENDENCY_RESOURCE_NAMES.includes(name);
}

export function validateFlucomaDependencyBytes(
  name: string,
  raw: Uint8Array,
): void {
  const pin = FLUCOMA_DEPENDENCY_FILES.find((file) => file.name === name);
  if (
    !pin ||
    raw.byteLength !== pin.bytes ||
    createHash("sha256").update(raw).digest("hex") !== pin.sha256
  )
    throw new Error(`Pinned FluCoMa dependency mismatch: ${name}`);
}

/** Only known dependency paths extend the existing flat resource contract. */
export function isSafeDeviceResourceName(name: string): boolean {
  return (
    isFlucomaDependencyResource(name) ||
    (name.length > 0 &&
      name.length <= 256 &&
      name !== "." &&
      name !== ".." &&
      !/[\\/\0]/u.test(name))
  );
}

/** Refuse linked ancestors, including a linked dependency or output root. */
export async function assertResourceParents(
  filePath: string,
  create = false,
): Promise<void> {
  const parent = dirname(resolve(filePath));
  let current = parse(parent).root;
  for (const part of parent.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    if (create) {
      try {
        await mkdir(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    const metadata = await lstat(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      throw new Error("Resource parent must be a regular directory");
  }
}

export async function readFlucomaDependencyFile(
  root: string,
  name: string,
): Promise<Buffer> {
  const pin = FLUCOMA_DEPENDENCY_FILES.find((file) => file.name === name);
  if (!pin) throw new Error("Unknown FluCoMa dependency resource");
  const path = join(root, name);
  await assertResourceParents(path);
  const metadata = await lstat(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size !== pin.bytes ||
    (process.platform !== "win32" &&
      pin.mode === 0o755 &&
      (metadata.mode & 0o111) !== 0o111)
  )
    throw new Error(
      `Pinned FluCoMa dependency requires a bounded regular file: ${name}`,
    );
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const current = await handle.stat();
    if (current.ino !== metadata.ino || current.size !== pin.bytes)
      throw new Error("FluCoMa dependency changed during validation");
    const raw = await handle.readFile();
    validateFlucomaDependencyBytes(name, raw);
    return raw;
  } finally {
    await handle.close();
  }
}

/** Exact shallow-by-shallow inventory; no arbitrary directory traversal. */
export async function assertDeviceResourceInventory(
  root: string,
  names: readonly string[],
): Promise<void> {
  if (names.some((name) => !isSafeDeviceResourceName(name)))
    throw new Error("Unsafe device resource inventory");
  await assertResourceTree(root, names);
}

async function assertResourceTree(
  path: string,
  remaining: readonly string[],
): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink())
    throw new Error("Integration payload directory inventory mismatch");
  const expected = [
    ...new Set(remaining.map((name) => name.split("/")[0]!)),
  ].sort();
  const actual = (await readdir(path)).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error("Integration payload directory inventory mismatch");
  for (const name of expected) {
    const children = remaining
      .filter((item) => item.startsWith(`${name}/`))
      .map((item) => item.slice(name.length + 1));
    if (children.length) await assertResourceTree(join(path, name), children);
  }
}

export async function validateFlucomaDependency(root: string): Promise<void> {
  const dependencyRoot = join(root, FLUCOMA_DEPENDENCY_DIRECTORY);
  await assertResourceParents(join(dependencyRoot, "LICENSE.md"));
  // Source files can change independently; only the pinned dependency tree
  // belongs to this inventory check.
  if (
    FLUCOMA_DEPENDENCY_RESOURCE_NAMES.some(
      (name) =>
        !name.startsWith("dependencies/") || !isSafeDeviceResourceName(name),
    )
  )
    throw new Error("Unsafe device resource inventory");
  await assertResourceTree(
    join(root, "dependencies"),
    FLUCOMA_DEPENDENCY_RESOURCE_NAMES.map((name) =>
      name.slice("dependencies/".length),
    ),
  );
  for (const name of FLUCOMA_DEPENDENCY_RESOURCE_NAMES)
    await readFlucomaDependencyFile(root, name);
}

/** Source-check only: ordinary app builds verify pins; they never fetch/build/repin. */
export async function validateNativeMelSourceInputs(
  repositoryRoot: string,
): Promise<void> {
  for (const pin of NATIVE_MEL_SOURCE_INPUTS) {
    const path = join(repositoryRoot, pin.path);
    await assertResourceParents(path);
    const handle = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.size !== pin.bytes)
        throw new Error(`Native mel source pin mismatch: ${pin.path}`);
      const raw = await handle.readFile();
      if (createHash("sha256").update(raw).digest("hex") !== pin.sha256)
        throw new Error(`Native mel source pin mismatch: ${pin.path}`);
    } finally {
      await handle.close();
    }
  }
}
