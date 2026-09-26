import {
  migrateNestedStorage,
  resolveLiveAgentStorage,
  type NestedStorageMigrationResult,
} from "./index.js";

export interface MigrationCliIo {
  readonly write: (text: string) => void;
  readonly writeError: (text: string) => void;
}

interface MigrationCliOptions {
  readonly apply: boolean;
  readonly json: boolean;
  readonly profile?: string;
}

function parseMigrationCliArgs(args: readonly string[]): MigrationCliOptions {
  let apply = false;
  let modeWasSet = false;
  let json = false;
  let profile: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") {
      continue;
    } else if (argument === "--apply") {
      if (modeWasSet) {
        throw new Error("Choose exactly one of --dry-run or --apply");
      }
      apply = true;
      modeWasSet = true;
    } else if (argument === "--dry-run") {
      if (modeWasSet) {
        throw new Error("Choose exactly one of --dry-run or --apply");
      }
      apply = false;
      modeWasSet = true;
    } else if (argument === "--json") {
      json = true;
    } else if (argument === "--profile") {
      profile = args[index + 1];
      if (profile === undefined || profile.startsWith("-")) {
        throw new Error("--profile requires a profile name");
      }
      index += 1;
    } else if (argument === "--help" || argument === "-h") {
      throw new Error("help");
    } else {
      throw new Error(`Unknown option '${argument}'`);
    }
  }
  return { apply, json, ...(profile === undefined ? {} : { profile }) };
}

const usage = `Usage: ableton-agent-storage-migrate [--profile NAME] [--dry-run|--apply] [--json]

Migrates one canonical LIVE_AGENT_HOME profile from storage v1 to v2.
Dry-run is the default. Use --apply to create a backup and publish changes.`;

function textReport(result: NestedStorageMigrationResult): string {
  const lines = [
    `Nested storage migration: ${result.status}`,
    `Profile: ${result.profile}`,
    `Version: ${String(result.sourceVersion ?? "unknown")} -> ${result.targetVersion}`,
    `Applied: ${result.applied ? "yes" : "no"}`,
  ];
  if (result.backupPath !== undefined) {
    lines.push(`Backup: ${result.backupPath}`);
  }
  for (const action of result.actions.slice(0, 100)) {
    lines.push(`- ${action}`);
  }
  if (result.actions.length > 100) {
    lines.push(`- … ${result.actions.length - 100} additional actions omitted`);
  }
  if (result.error !== undefined) lines.push(`Error: ${result.error}`);
  return lines.join("\n");
}

export async function runMigrationCli(
  args: readonly string[],
  environment: Readonly<Partial<Record<string, string>>>,
  io: MigrationCliIo,
): Promise<number> {
  let options: MigrationCliOptions;
  try {
    options = parseMigrationCliArgs(args);
  } catch (error) {
    if (error instanceof Error && error.message === "help") {
      io.write(usage);
      return 0;
    }
    io.writeError(error instanceof Error ? error.message : String(error));
    io.writeError(usage);
    return 2;
  }
  let result: NestedStorageMigrationResult;
  try {
    const layout = resolveLiveAgentStorage({
      environment,
      ...(options.profile === undefined ? {} : { profile: options.profile }),
    });
    result = await migrateNestedStorage({
      layout,
      apply: options.apply,
    });
  } catch (error) {
    io.writeError(error instanceof Error ? error.message : String(error));
    return 1;
  }
  const report = options.json
    ? JSON.stringify(result, undefined, 2)
    : textReport(result);
  if (result.status === "failed") {
    io.writeError(report);
    return 1;
  }
  io.write(report);
  return 0;
}
