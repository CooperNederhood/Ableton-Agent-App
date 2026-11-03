import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, lstat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export function finderLikeEnvironment(
  overrides: NodeJS.ProcessEnv = {},
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries({
    ...process.env,
    ...overrides,
  })) {
    if (value !== undefined) environment[name] = value;
  }
  environment.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
  for (const name of [
    "COPILOT_GITHUB_TOKEN",
    "COPILOT_HMAC_KEY",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GITHUB_COPILOT_API_TOKEN",
  ])
    delete environment[name];
  return environment;
}

export function packagedResources(directory: string): string {
  const explicit = process.env.ABLETON_AGENT_PACKAGED_EXECUTABLE?.trim();
  if (explicit) return join(dirname(dirname(explicit)), "Resources");
  return join(
    resolve("release"),
    directory,
    "Ableton Agent.app",
    "Contents",
    "Resources",
  );
}

export async function packagedExecutable(
  options: {
    explicit?: string;
    releaseRoot?: string;
    architecture?: string;
  } = {},
): Promise<string> {
  const explicit =
    options.explicit?.trim() ??
    process.env.ABLETON_AGENT_PACKAGED_EXECUTABLE?.trim();
  if (explicit) {
    await access(explicit);
    return resolve(explicit);
  }

  const architecture = options.architecture ?? process.arch;
  const root = options.releaseRoot ?? resolve("release");
  const directories =
    architecture === "arm64" ? ["mac-arm64", "mac"] : ["mac", "mac-x64"];
  for (const directory of directories) {
    const executable = join(
      root,
      directory,
      "Ableton Agent.app",
      "Contents",
      "MacOS",
      "Ableton Agent",
    );
    try {
      await access(executable);
      return executable;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
    }
  }
  throw new Error(
    `No packaged Ableton Agent executable for ${architecture} was found under ${root}. Run 'pnpm desktop:dist' first.`,
  );
}

export async function packagedCandidateHash(
  executable: string,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  const path = resolve(dirname(executable), "../Resources/app.asar");
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size === 0 ||
    info.size > 1024 ** 3
  )
    throw new Error(
      "Packaged application archive is missing or exceeds its evidence bound",
    );
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { signal })) {
    if (!Buffer.isBuffer(chunk))
      throw new Error("Unexpected packaged archive chunk");
    hash.update(chunk);
  }
  return hash.digest("hex");
}
