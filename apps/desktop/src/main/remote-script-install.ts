import { randomUUID } from "node:crypto";
import {
  cp,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, posix, win32 } from "node:path";

const scriptDirectoryName = "AbletonAgent";
const installMetadataName = ".ableton-agent-install.json";
const tokenName = ".ableton-agent-token";

export interface RemoteScriptLocation {
  readonly path: string;
  readonly source:
    | "environment"
    | "macos-music"
    | "macos-documents"
    | "windows-documents"
    | "windows-onedrive";
  readonly available: boolean;
}

export type RemoteScriptInstallState =
  "not-installed" | "current" | "outdated" | "unmanaged";

export interface RemoteScriptInspection {
  readonly state: RemoteScriptInstallState;
  readonly path: string;
  readonly installedVersion?: string;
}

interface InstallMetadata {
  readonly formatVersion: 1;
  readonly remoteScriptVersion: string;
  readonly installedAt: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function remoteScriptsPath(
  pathApi: Pick<typeof posix, "join">,
  userLibrary: string,
): string {
  return pathApi.join(userLibrary, "Remote Scripts");
}

export async function detectRemoteScriptLocations(options: {
  readonly platform?: NodeJS.Platform;
  readonly environment?: NodeJS.ProcessEnv;
  readonly homeDirectory: string;
}): Promise<RemoteScriptLocation[]> {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const pathApi = platform === "win32" ? win32 : posix;
  const candidates: Omit<RemoteScriptLocation, "available">[] = [];
  const custom = environment.ABLETON_USER_LIBRARY;
  if (custom !== undefined && custom.trim() !== "") {
    candidates.push({
      path: remoteScriptsPath(pathApi, custom),
      source: "environment",
    });
  }
  if (platform === "darwin") {
    candidates.push(
      {
        path: join(
          options.homeDirectory,
          "Music",
          "Ableton",
          "User Library",
          "Remote Scripts",
        ),
        source: "macos-music",
      },
      {
        path: join(
          options.homeDirectory,
          "Documents",
          "Ableton",
          "User Library",
          "Remote Scripts",
        ),
        source: "macos-documents",
      },
    );
  } else if (platform === "win32") {
    const home = environment.USERPROFILE ?? options.homeDirectory;
    candidates.push({
      path: win32.join(
        home,
        "Documents",
        "Ableton",
        "User Library",
        "Remote Scripts",
      ),
      source: "windows-documents",
    });
    if (environment.OneDrive !== undefined) {
      candidates.push({
        path: win32.join(
          environment.OneDrive,
          "Documents",
          "Ableton",
          "User Library",
          "Remote Scripts",
        ),
        source: "windows-onedrive",
      });
    }
  }
  const unique = new Map(
    candidates.map((candidate) => [candidate.path, candidate]),
  );
  return Promise.all(
    [...unique.values()].map(async (candidate) => ({
      ...candidate,
      available: await exists(pathApi.dirname(candidate.path)),
    })),
  );
}

export function normalizeManualRemoteScriptsPath(
  selectedPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const pathApi = platform === "win32" ? win32 : posix;
  const normalized = pathApi.normalize(selectedPath);
  return pathApi.basename(normalized).toLowerCase() === "user library"
    ? pathApi.join(normalized, "Remote Scripts")
    : normalized;
}

export async function inspectRemoteScriptInstallation(
  remoteScriptsPathValue: string,
  expectedVersion: string,
): Promise<RemoteScriptInspection> {
  const destination = join(remoteScriptsPathValue, scriptDirectoryName);
  if (!(await exists(destination))) {
    return { state: "not-installed", path: destination };
  }
  try {
    const metadata = JSON.parse(
      await readFile(join(destination, installMetadataName), "utf8"),
    ) as Partial<InstallMetadata>;
    if (typeof metadata.remoteScriptVersion !== "string") {
      return { state: "unmanaged", path: destination };
    }
    return {
      state:
        metadata.remoteScriptVersion === expectedVersion
          ? "current"
          : "outdated",
      path: destination,
      installedVersion: metadata.remoteScriptVersion,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { state: "unmanaged", path: destination };
    }
    throw new Error(`Remote Script metadata at ${destination} is invalid`, {
      cause: error,
    });
  }
}

export async function installRemoteScript(options: {
  readonly sourcePath: string;
  readonly remoteScriptsPath: string;
  readonly version: string;
  readonly now?: Date;
}): Promise<{
  readonly destination: string;
  readonly backupPath?: string;
}> {
  if (!(await exists(join(options.sourcePath, "__init__.py")))) {
    throw new Error(
      `Remote Script source is missing __init__.py: ${options.sourcePath}`,
    );
  }
  const now = options.now ?? new Date();
  const destination = join(options.remoteScriptsPath, scriptDirectoryName);
  const staging = join(
    options.remoteScriptsPath,
    `.${scriptDirectoryName}.install-${randomUUID()}`,
  );
  const backupRoot = join(options.remoteScriptsPath, ".ableton-agent-backups");
  const backup = join(
    backupRoot,
    `${scriptDirectoryName}-${now.toISOString().replaceAll(":", "-")}`,
  );
  const hadExisting = await exists(destination);
  await mkdir(options.remoteScriptsPath, { recursive: true });
  try {
    await cp(options.sourcePath, staging, {
      recursive: true,
      errorOnExist: true,
      filter: (source) => {
        const name = source.split(/[\\/]/u).at(-1);
        return (
          name !== tokenName &&
          name !== installMetadataName &&
          name !== "__pycache__" &&
          !source.endsWith(".pyc")
        );
      },
    });
    if (hadExisting && (await exists(join(destination, tokenName)))) {
      await cp(join(destination, tokenName), join(staging, tokenName));
    }
    const metadata: InstallMetadata = {
      formatVersion: 1,
      remoteScriptVersion: options.version,
      installedAt: now.toISOString(),
    };
    await writeFile(
      join(staging, installMetadataName),
      `${JSON.stringify(metadata, undefined, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    if (hadExisting) {
      await mkdir(backupRoot, { recursive: true });
      await rename(destination, backup);
    }
    try {
      await rename(staging, destination);
    } catch (error) {
      if (hadExisting) await rename(backup, destination);
      throw error;
    }
  } catch (error) {
    await rm(staging, { force: true, recursive: true });
    throw new Error(`Remote Script installation failed at ${destination}`, {
      cause: error,
    });
  }
  return {
    destination,
    ...(hadExisting ? { backupPath: backup } : {}),
  };
}
