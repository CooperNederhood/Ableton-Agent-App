import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";

const githubCliOverride = "ABLETON_AGENT_GH_PATH";

export type GitHubCliDiscovery =
  | {
      readonly status: "found";
      readonly source: "environment-path" | "explicit" | "standard-location";
      readonly executablePath: string;
      readonly runtimeEnvironment: NodeJS.ProcessEnv;
    }
  | {
      readonly status: "missing";
      readonly runtimeEnvironment: NodeJS.ProcessEnv;
    };

export interface GitHubCliDiscoveryOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly isExecutable?: (path: string) => Promise<boolean>;
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    const details = await stat(path);
    if (!details.isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function executableName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "gh.exe" : "gh";
}

function pathCandidates(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): readonly {
  path: string;
  source: "environment-path" | "explicit" | "standard-location";
}[] {
  const name = executableName(platform);
  const candidates: {
    path: string;
    source: "environment-path" | "explicit" | "standard-location";
  }[] = [];
  const explicit = environment[githubCliOverride]?.trim();
  if (explicit) candidates.push({ path: explicit, source: "explicit" });
  for (const directory of (environment.PATH ?? "")
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)) {
    candidates.push({
      path: join(directory, name),
      source: "environment-path",
    });
  }
  if (platform === "darwin") {
    candidates.push(
      {
        path: `/opt/homebrew/bin/${name}`,
        source: "standard-location",
      },
      {
        path: `/usr/local/bin/${name}`,
        source: "standard-location",
      },
    );
  }
  return candidates;
}

export async function discoverGitHubCli(
  options: GitHubCliDiscoveryOptions = {},
): Promise<GitHubCliDiscovery> {
  const environment = { ...(options.environment ?? process.env) };
  const platform = options.platform ?? process.platform;
  const check = options.isExecutable ?? isExecutableFile;
  const visited = new Set<string>();
  for (const candidate of pathCandidates(environment, platform)) {
    if (visited.has(candidate.path)) continue;
    visited.add(candidate.path);
    if (!(await check(candidate.path))) continue;
    const directory = dirname(candidate.path);
    const existingPath = environment.PATH ?? "";
    const entries = existingPath.split(delimiter).filter(Boolean);
    return {
      status: "found",
      source: candidate.source,
      executablePath: candidate.path,
      runtimeEnvironment: {
        ...environment,
        PATH: entries.includes(directory)
          ? existingPath
          : [directory, ...entries].join(delimiter),
      },
    };
  }
  return { status: "missing", runtimeEnvironment: environment };
}
