import { createHash, randomUUID } from "node:crypto";
import {
  access,
  chmod,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export const LIVE_AGENT_STORAGE_VERSION = 1;
export const LIVE_AGENT_HOME_ENVIRONMENT_VARIABLE = "LIVE_AGENT_HOME";
export const LIVE_AGENT_PROFILE_ENVIRONMENT_VARIABLE = "LIVE_AGENT_PROFILE";

const profilePattern = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u;

export interface LiveAgentStorageLayout {
  readonly version: typeof LIVE_AGENT_STORAGE_VERSION;
  readonly root: string;
  readonly profile: string;
  readonly profileRoot: string;
  readonly preferencesPath: string;
  readonly sessionsPath: string;
  readonly projectSessionsPath: string;
  readonly credentialsDirectory: string;
  readonly copilotDirectory: string;
  readonly observabilityDirectory: string;
  readonly eventJournalPath: string;
  readonly logsDirectory: string;
  readonly desktopLogPath: string;
  readonly sessionStateDirectory: string;
  readonly migrationMarkerPath: string;
}

export interface ResolveLiveAgentStorageOptions {
  readonly homeDirectory?: string;
  readonly environment?: Readonly<Partial<Record<string, string>>>;
  readonly profile?: string;
  readonly development?: boolean;
}

export interface ProductionSessionStoragePaths {
  readonly sessionDirectory: string;
  readonly manifestPath: string;
  readonly artifactsDirectory: string;
  readonly planPath: string;
}

function productionSessionDirectoryName(productionSessionId: string): string {
  if (
    productionSessionId.length <= 200 &&
    /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/u.test(productionSessionId)
  ) {
    return productionSessionId;
  }
  return `session-${createHash("sha256").update(productionSessionId).digest("hex")}`;
}

export function resolveProductionSessionStorage(
  sessionStateDirectory: string,
  productionSessionId: string,
): ProductionSessionStoragePaths {
  if (productionSessionId.length === 0) {
    throw new Error("Production session ID must not be empty");
  }
  const root = resolve(sessionStateDirectory);
  const sessionDirectory = join(
    root,
    productionSessionDirectoryName(productionSessionId),
  );
  assertWithin(root, sessionDirectory);
  const artifactsDirectory = join(sessionDirectory, "artifacts");
  return {
    sessionDirectory,
    manifestPath: join(sessionDirectory, "session.json"),
    artifactsDirectory,
    planPath: join(artifactsDirectory, "plan.md"),
  };
}

export function resolveLiveAgentStorage(
  options: ResolveLiveAgentStorageOptions = {},
): LiveAgentStorageLayout {
  const environment = options.environment ?? {};
  const configuredRoot =
    environment[LIVE_AGENT_HOME_ENVIRONMENT_VARIABLE]?.trim();
  const root =
    configuredRoot === undefined || configuredRoot === ""
      ? join(options.homeDirectory ?? homedir(), ".live-agent")
      : configuredRoot;
  if (!isAbsolute(root)) {
    throw new Error(`${LIVE_AGENT_HOME_ENVIRONMENT_VARIABLE} must be absolute`);
  }
  if (dirname(resolve(root)) === resolve(root)) {
    throw new Error(
      `${LIVE_AGENT_HOME_ENVIRONMENT_VARIABLE} cannot be a filesystem root`,
    );
  }
  const profile =
    options.profile ??
    environment[LIVE_AGENT_PROFILE_ENVIRONMENT_VARIABLE]?.trim() ??
    (options.development === true ? "development" : "default");
  if (!profilePattern.test(profile)) {
    throw new Error(
      `${LIVE_AGENT_PROFILE_ENVIRONMENT_VARIABLE} must be a filesystem-safe name`,
    );
  }
  const resolvedRoot = resolve(root);
  const profileRoot = join(resolvedRoot, "profiles", profile);
  assertWithin(resolvedRoot, profileRoot);
  return {
    version: LIVE_AGENT_STORAGE_VERSION,
    root: resolvedRoot,
    profile,
    profileRoot,
    preferencesPath: join(profileRoot, "config", "preferences.json"),
    sessionsPath: join(profileRoot, "state", "sessions.json"),
    projectSessionsPath: join(profileRoot, "state", "project-sessions.json"),
    credentialsDirectory: join(profileRoot, "credentials"),
    copilotDirectory: join(profileRoot, "copilot"),
    observabilityDirectory: join(profileRoot, "observability"),
    eventJournalPath: join(
      profileRoot,
      "observability",
      "event-history.sqlite",
    ),
    logsDirectory: join(profileRoot, "logs"),
    desktopLogPath: join(profileRoot, "logs", "desktop.log"),
    sessionStateDirectory: join(profileRoot, "session-state"),
    migrationMarkerPath: join(
      profileRoot,
      `storage-migration-v${LIVE_AGENT_STORAGE_VERSION}.json`,
    ),
  };
}

function assertWithin(root: string, path: string): void {
  const child = relative(root, path);
  if (child === "" || (!child.startsWith("..") && !isAbsolute(child))) return;
  throw new Error(`Storage path resolves outside '${root}'`);
}

export async function ensureLiveAgentStorage(
  layout: LiveAgentStorageLayout,
): Promise<void> {
  const directories = [
    layout.root,
    join(layout.root, "profiles"),
    layout.profileRoot,
    dirname(layout.preferencesPath),
    dirname(layout.sessionsPath),
    layout.credentialsDirectory,
    layout.copilotDirectory,
    layout.observabilityDirectory,
    layout.logsDirectory,
    layout.sessionStateDirectory,
  ];
  for (const directory of directories) {
    assertWithin(layout.root, directory);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }
  const versionPath = join(layout.root, "storage-version.json");
  try {
    const stored = JSON.parse(await readFile(versionPath, "utf8")) as {
      version?: unknown;
    };
    if (stored.version !== LIVE_AGENT_STORAGE_VERSION) {
      throw new Error(
        `Storage version ${String(stored.version)} is not supported`,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await writeJsonAtomically(versionPath, {
      version: LIVE_AGENT_STORAGE_VERSION,
    });
  }
}

export type LegacyStorageKind = "file" | "json" | "sqlite" | "directory";

export interface LegacyStorageEntry {
  readonly label: string;
  readonly source: string;
  readonly destination: string;
  readonly kind: LegacyStorageKind;
}

export interface StorageMigrationEvent {
  readonly id: string;
  readonly name:
    | "storage.migration.queued"
    | "storage.migration.started"
    | "storage.migration.progress"
    | "storage.migration.completed"
    | "storage.migration.failed"
    | "storage.migration.cancelled";
  readonly occurredAt: string;
  readonly durationMs?: number;
  readonly outcome?: "success" | "failure" | "cancelled";
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly attributes: Readonly<Record<string, string | number | boolean>>;
}

export interface StorageMigrationResult {
  readonly status: "completed" | "not-needed" | "failed";
  readonly migrated: readonly string[];
  readonly events: readonly StorageMigrationEvent[];
  readonly error?: string;
}

export interface MigrateLegacyStorageOptions {
  readonly layout: LiveAgentStorageLayout;
  readonly entries: readonly LegacyStorageEntry[];
  readonly now?: () => Date;
}

export async function migrateLegacyStorage(
  options: MigrateLegacyStorageOptions,
): Promise<StorageMigrationResult> {
  const now = options.now ?? (() => new Date());
  const traceId = randomUUID();
  const correlationId = randomUUID();
  const events: StorageMigrationEvent[] = [];
  const startedAt = now();
  const rootSpanId = randomUUID();
  let previousEventId: string | undefined;
  const emit = (
    event: Omit<
      StorageMigrationEvent,
      "id" | "occurredAt" | "traceId" | "correlationId"
    >,
  ): void => {
    const id = randomUUID();
    events.push({
      id,
      ...event,
      occurredAt: now().toISOString(),
      traceId,
      correlationId,
      ...(event.causationId === undefined && previousEventId !== undefined
        ? { causationId: previousEventId }
        : {}),
    });
    previousEventId = id;
  };
  emit({
    name: "storage.migration.queued",
    spanId: rootSpanId,
    attributes: {
      profile: options.layout.profile,
      candidateCount: options.entries.length,
    },
  });

  if (await exists(options.layout.migrationMarkerPath)) {
    emit({
      name: "storage.migration.cancelled",
      spanId: rootSpanId,
      outcome: "cancelled",
      durationMs: now().getTime() - startedAt.getTime(),
      attributes: {
        profile: options.layout.profile,
        reason: "already-migrated",
      },
    });
    return { status: "not-needed", migrated: [], events };
  }
  const stagingRoot = `${options.layout.profileRoot}.migration-${randomUUID()}`;
  const rollbackRoot = `${options.layout.profileRoot}.rollback-${randomUUID()}`;
  const profileExists = await exists(options.layout.profileRoot);
  const migrated: string[] = [];
  emit({
    name: "storage.migration.started",
    spanId: rootSpanId,
    attributes: { profile: options.layout.profile },
  });
  try {
    if (profileExists) {
      await cp(options.layout.profileRoot, stagingRoot, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
      await hardenPermissions(stagingRoot);
    } else {
      await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
    }
    for (const entry of options.entries) {
      if (!(await exists(entry.source))) continue;
      const destinationRelative = relative(
        options.layout.profileRoot,
        entry.destination,
      );
      if (
        destinationRelative.startsWith("..") ||
        isAbsolute(destinationRelative)
      ) {
        throw new Error(
          `Migration destination for '${entry.label}' is outside the profile`,
        );
      }
      const stagedDestination = join(stagingRoot, destinationRelative);
      if (await exists(stagedDestination)) {
        throw new Error(
          `Migration conflict for '${entry.label}': the destination already exists`,
        );
      }
      await mkdir(dirname(stagedDestination), {
        recursive: true,
        mode: 0o700,
      });
      await cp(entry.source, stagedDestination, {
        recursive: entry.kind === "directory",
        errorOnExist: true,
        force: false,
      });
      await validateMigratedEntry(stagedDestination, entry.kind);
      await hardenPermissions(stagedDestination);
      migrated.push(entry.label);
      emit({
        name: "storage.migration.progress",
        spanId: randomUUID(),
        parentSpanId: rootSpanId,
        attributes: {
          profile: options.layout.profile,
          component: entry.label,
          migratedCount: migrated.length,
        },
      });
    }
    await writeJsonAtomically(
      join(
        stagingRoot,
        `storage-migration-v${LIVE_AGENT_STORAGE_VERSION}.json`,
      ),
      {
        version: LIVE_AGENT_STORAGE_VERSION,
        completedAt: now().toISOString(),
        migrated,
      },
    );
    await mkdir(dirname(options.layout.profileRoot), {
      recursive: true,
      mode: 0o700,
    });
    if (profileExists) {
      await rename(options.layout.profileRoot, rollbackRoot);
      try {
        await rename(stagingRoot, options.layout.profileRoot);
      } catch (error) {
        await rename(rollbackRoot, options.layout.profileRoot);
        throw error;
      }
      await rm(rollbackRoot, { recursive: true, force: true });
    } else {
      await rename(stagingRoot, options.layout.profileRoot);
    }
    await ensureLiveAgentStorage(options.layout);
    emit({
      name: "storage.migration.completed",
      spanId: rootSpanId,
      outcome: "success",
      durationMs: now().getTime() - startedAt.getTime(),
      attributes: {
        profile: options.layout.profile,
        migratedCount: migrated.length,
      },
    });
    return { status: "completed", migrated, events };
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true });
    if (
      !(await exists(options.layout.profileRoot)) &&
      (await exists(rollbackRoot))
    ) {
      await rename(rollbackRoot, options.layout.profileRoot);
    }
    const message = error instanceof Error ? error.message : String(error);
    emit({
      name: "storage.migration.failed",
      spanId: rootSpanId,
      outcome: "failure",
      durationMs: now().getTime() - startedAt.getTime(),
      attributes: {
        profile: options.layout.profile,
        migratedCount: migrated.length,
        error: message,
      },
    });
    return { status: "failed", migrated, events, error: message };
  }
}

async function validateMigratedEntry(
  path: string,
  kind: LegacyStorageKind,
): Promise<void> {
  if (kind === "directory") {
    if (!(await stat(path)).isDirectory()) {
      throw new Error(`Migrated directory '${path}' is invalid`);
    }
    await access(path);
    return;
  }
  const value = await readFile(path);
  if (kind === "json") JSON.parse(value.toString("utf8"));
  if (
    kind === "sqlite" &&
    value.byteLength > 0 &&
    !value.subarray(0, 16).equals(Buffer.from("SQLite format 3\0"))
  ) {
    throw new Error(`Migrated SQLite file '${path}' has an invalid header`);
  }
}

async function hardenPermissions(path: string): Promise<void> {
  const details = await lstat(path);
  if (details.isSymbolicLink()) {
    throw new Error("Symbolic links are not allowed in migrated storage");
  }
  if (!details.isDirectory()) {
    await chmod(path, 0o600);
    return;
  }
  await chmod(path, 0o700);
  for (const name of await readdir(path)) {
    await hardenPermissions(join(path, name));
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function writeJsonAtomically(
  path: string,
  value: Readonly<Record<string, unknown>>,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, JSON.stringify(value, undefined, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}
