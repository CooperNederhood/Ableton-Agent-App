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
export const PROFILE_REGISTRY_VERSION = 1;
export const ARTIFACT_STATE_VERSION = 1;

const profilePattern = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u;
const artifactPattern = /^[a-z][a-z0-9-]{0,63}$/u;
const reservedProfileNames = new Set(["development", "automation"]);

export type ArtifactKind = "agent" | "skill";
export type ArtifactScope = "system" | "profile" | "session";

export interface LiveAgentStorageLayout {
  readonly version: typeof LIVE_AGENT_STORAGE_VERSION;
  readonly root: string;
  readonly configDirectory: string;
  readonly profilesRegistryPath: string;
  readonly systemDirectory: string;
  readonly systemAgentsDirectory: string;
  readonly systemSkillsDirectory: string;
  readonly profile: string;
  readonly profileRoot: string;
  readonly profileAgentsDirectory: string;
  readonly profileSkillsDirectory: string;
  readonly profileArtifactStateDirectory: string;
  readonly profileAgentTombstonesPath: string;
  readonly profileSkillTombstonesPath: string;
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
  readonly agentsDirectory: string;
  readonly skillsDirectory: string;
  readonly artifactStateDirectory: string;
  readonly agentTombstonesPath: string;
  readonly skillTombstonesPath: string;
}

export interface ArtifactScopePaths {
  readonly scope: ArtifactScope;
  readonly root: string;
  readonly agentsDirectory: string;
  readonly skillsDirectory: string;
  readonly stateDirectory: string;
  readonly agentTombstonesPath: string;
  readonly skillTombstonesPath: string;
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
  const artifactStateDirectory = join(sessionDirectory, "artifact-state");
  return {
    sessionDirectory,
    manifestPath: join(sessionDirectory, "session.json"),
    artifactsDirectory,
    planPath: join(artifactsDirectory, "plan.md"),
    agentsDirectory: join(sessionDirectory, "agents"),
    skillsDirectory: join(sessionDirectory, "skills"),
    artifactStateDirectory,
    agentTombstonesPath: join(artifactStateDirectory, "agents.json"),
    skillTombstonesPath: join(artifactStateDirectory, "skills.json"),
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
  const configDirectory = join(resolvedRoot, "config");
  const systemDirectory = join(resolvedRoot, "system");
  const profileArtifactStateDirectory = join(profileRoot, "artifact-state");
  assertWithin(resolvedRoot, profileRoot);
  return {
    version: LIVE_AGENT_STORAGE_VERSION,
    root: resolvedRoot,
    configDirectory,
    profilesRegistryPath: join(configDirectory, "profiles.json"),
    systemDirectory,
    systemAgentsDirectory: join(systemDirectory, "agents"),
    systemSkillsDirectory: join(systemDirectory, "skills"),
    profile,
    profileRoot,
    profileAgentsDirectory: join(profileRoot, "agents"),
    profileSkillsDirectory: join(profileRoot, "skills"),
    profileArtifactStateDirectory,
    profileAgentTombstonesPath: join(
      profileArtifactStateDirectory,
      "agents.json",
    ),
    profileSkillTombstonesPath: join(
      profileArtifactStateDirectory,
      "skills.json",
    ),
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

export function validateProfileName(profile: string): string {
  if (!profilePattern.test(profile)) {
    throw new Error("Profile name must be a filesystem-safe identifier");
  }
  return profile;
}

export function validateArtifactName(name: string): string {
  if (!artifactPattern.test(name)) {
    throw new Error(
      "Artifact name must be a lowercase identifier using letters, numbers, and hyphens",
    );
  }
  return name;
}

export function resolveArtifactScopePaths(
  layout: LiveAgentStorageLayout,
  scope: ArtifactScope,
  productionSessionId?: string,
): ArtifactScopePaths {
  if (scope === "system") {
    return {
      scope,
      root: layout.systemDirectory,
      agentsDirectory: layout.systemAgentsDirectory,
      skillsDirectory: layout.systemSkillsDirectory,
      stateDirectory: join(layout.systemDirectory, "artifact-state"),
      agentTombstonesPath: join(
        layout.systemDirectory,
        "artifact-state",
        "agents.json",
      ),
      skillTombstonesPath: join(
        layout.systemDirectory,
        "artifact-state",
        "skills.json",
      ),
    };
  }
  if (scope === "profile") {
    return {
      scope,
      root: layout.profileRoot,
      agentsDirectory: layout.profileAgentsDirectory,
      skillsDirectory: layout.profileSkillsDirectory,
      stateDirectory: layout.profileArtifactStateDirectory,
      agentTombstonesPath: layout.profileAgentTombstonesPath,
      skillTombstonesPath: layout.profileSkillTombstonesPath,
    };
  }
  if (productionSessionId === undefined) {
    throw new Error("Production session ID is required for session scope");
  }
  const session = resolveProductionSessionStorage(
    layout.sessionStateDirectory,
    productionSessionId,
  );
  return {
    scope,
    root: session.sessionDirectory,
    agentsDirectory: session.agentsDirectory,
    skillsDirectory: session.skillsDirectory,
    stateDirectory: session.artifactStateDirectory,
    agentTombstonesPath: session.agentTombstonesPath,
    skillTombstonesPath: session.skillTombstonesPath,
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
    layout.configDirectory,
    layout.systemDirectory,
    layout.systemAgentsDirectory,
    layout.systemSkillsDirectory,
    join(layout.root, "profiles"),
    layout.profileRoot,
    layout.profileAgentsDirectory,
    layout.profileSkillsDirectory,
    layout.profileArtifactStateDirectory,
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
    await assertNoSymbolicLinkPath(layout.root, directory);
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

export interface ProfileRegistryEntry {
  readonly name: string;
  readonly displayName: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ProfileRegistry {
  readonly version: typeof PROFILE_REGISTRY_VERSION;
  readonly revision: number;
  readonly selectedProfile: string;
  readonly profiles: readonly ProfileRegistryEntry[];
}

export interface ProfileRegistryMutationOptions {
  readonly expectedRevision: number;
  readonly now?: () => Date;
}

function defaultProfileRegistry(now: Date): ProfileRegistry {
  const timestamp = now.toISOString();
  return {
    version: PROFILE_REGISTRY_VERSION,
    revision: 1,
    selectedProfile: "default",
    profiles: [
      {
        name: "default",
        displayName: "Default",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
  };
}

function validateProfileRegistry(value: unknown): ProfileRegistry {
  if (typeof value !== "object" || value === null) {
    throw new Error("Profile registry must be an object");
  }
  const candidate = value as Partial<ProfileRegistry>;
  if (
    candidate.version !== PROFILE_REGISTRY_VERSION ||
    !Number.isSafeInteger(candidate.revision) ||
    (candidate.revision ?? 0) < 1 ||
    !Array.isArray(candidate.profiles)
  ) {
    throw new Error("Profile registry is invalid or unsupported");
  }
  const profiles = candidate.profiles.map((entry) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error("Profile registry entry is invalid");
    }
    const profile = entry as Partial<ProfileRegistryEntry>;
    validateProfileName(profile.name ?? "");
    if (
      typeof profile.displayName !== "string" ||
      profile.displayName.trim().length === 0 ||
      profile.displayName.length > 128 ||
      typeof profile.createdAt !== "string" ||
      typeof profile.updatedAt !== "string"
    ) {
      throw new Error("Profile registry entry is invalid");
    }
    return profile as ProfileRegistryEntry;
  });
  if (profiles.length === 0) {
    throw new Error("Profile registry must contain a visible user profile");
  }
  if (new Set(profiles.map(({ name }) => name)).size !== profiles.length) {
    throw new Error("Profile registry contains duplicate profile names");
  }
  validateProfileName(candidate.selectedProfile ?? "");
  if (!profiles.some(({ name }) => name === candidate.selectedProfile)) {
    throw new Error("Selected profile must be a visible user profile");
  }
  return {
    version: PROFILE_REGISTRY_VERSION,
    revision: candidate.revision as number,
    selectedProfile: candidate.selectedProfile as string,
    profiles,
  };
}

export async function loadProfileRegistry(
  layout: LiveAgentStorageLayout,
  now: () => Date = () => new Date(),
): Promise<ProfileRegistry> {
  await ensureLiveAgentStorage(layout);
  try {
    const content = await boundedReadFile(
      layout.profilesRegistryPath,
      256 * 1024,
    );
    return validateProfileRegistry(JSON.parse(content));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const registry = defaultProfileRegistry(now());
    await writeJsonAtomically(layout.profilesRegistryPath, registry);
    return registry;
  }
}

async function updateProfileRegistry(
  layout: LiveAgentStorageLayout,
  options: ProfileRegistryMutationOptions,
  mutate: (registry: ProfileRegistry, timestamp: string) => ProfileRegistry,
  lifecycle?: {
    readonly prepare?: (
      registry: ProfileRegistry,
      updated: ProfileRegistry,
    ) => Promise<(() => Promise<void>) | undefined>;
    readonly committed?: () => Promise<void>;
  },
): Promise<ProfileRegistry> {
  await ensureLiveAgentStorage(layout);
  const lockPath = `${layout.profilesRegistryPath}.lock`;
  try {
    await writeFile(lockPath, String(process.pid), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("Profile registry is currently being modified");
    }
    throw error;
  }
  let rollback: (() => Promise<void>) | undefined;
  try {
    const registry = await loadProfileRegistry(layout, options.now);
    if (registry.revision !== options.expectedRevision) {
      throw new Error(
        `Profile registry revision conflict: expected ${options.expectedRevision}, current ${registry.revision}`,
      );
    }
    const updated = validateProfileRegistry(
      mutate(registry, (options.now ?? (() => new Date()))().toISOString()),
    );
    rollback = await lifecycle?.prepare?.(registry, updated);
    try {
      await writeJsonAtomically(layout.profilesRegistryPath, updated);
    } catch (error) {
      await rollback?.();
      throw error;
    }
    await lifecycle?.committed?.();
    return updated;
  } finally {
    await rm(lockPath, { force: true });
  }
}

export async function createProfile(
  layout: LiveAgentStorageLayout,
  profile: { readonly name: string; readonly displayName?: string },
  options: ProfileRegistryMutationOptions,
): Promise<ProfileRegistry> {
  const name = validateProfileName(profile.name);
  if (reservedProfileNames.has(name)) {
    throw new Error(`Profile '${name}' is reserved`);
  }
  const targetLayout = resolveLiveAgentStorage({
    environment: { [LIVE_AGENT_HOME_ENVIRONMENT_VARIABLE]: layout.root },
    profile: name,
  });
  let createdDirectory = false;
  return updateProfileRegistry(
    layout,
    options,
    (registry, timestamp) => {
      if (registry.profiles.some((entry) => entry.name === name)) {
        throw new Error(`Profile '${name}' already exists`);
      }
      const displayName = (profile.displayName ?? name).trim();
      return {
        ...registry,
        revision: registry.revision + 1,
        profiles: [
          ...registry.profiles,
          { name, displayName, createdAt: timestamp, updatedAt: timestamp },
        ],
      };
    },
    {
      prepare: async () => {
        createdDirectory = !(await exists(targetLayout.profileRoot));
        await ensureLiveAgentStorage(targetLayout);
        return createdDirectory
          ? () => rm(targetLayout.profileRoot, { recursive: true, force: true })
          : undefined;
      },
    },
  );
}

export async function renameProfile(
  layout: LiveAgentStorageLayout,
  currentName: string,
  replacement: { readonly name: string; readonly displayName?: string },
  options: ProfileRegistryMutationOptions,
): Promise<ProfileRegistry> {
  validateProfileName(currentName);
  const name = validateProfileName(replacement.name);
  if (reservedProfileNames.has(currentName) || reservedProfileNames.has(name)) {
    throw new Error("Reserved profiles cannot be renamed");
  }
  const currentRoot = join(layout.root, "profiles", currentName);
  const replacementRoot = join(layout.root, "profiles", name);
  return updateProfileRegistry(
    layout,
    options,
    (registry, timestamp) => {
      if (!registry.profiles.some((entry) => entry.name === currentName)) {
        throw new Error(`Profile '${currentName}' does not exist`);
      }
      if (
        name !== currentName &&
        registry.profiles.some((entry) => entry.name === name)
      ) {
        throw new Error(`Profile '${name}' already exists`);
      }
      return {
        ...registry,
        revision: registry.revision + 1,
        selectedProfile:
          registry.selectedProfile === currentName
            ? name
            : registry.selectedProfile,
        profiles: registry.profiles.map((entry) =>
          entry.name === currentName
            ? {
                ...entry,
                name,
                displayName: (
                  replacement.displayName ?? entry.displayName
                ).trim(),
                updatedAt: timestamp,
              }
            : entry,
        ),
      };
    },
    {
      prepare: async () => {
        if (name === currentName || !(await exists(currentRoot)))
          return undefined;
        if (await exists(replacementRoot)) {
          throw new Error(`Profile directory '${name}' already exists`);
        }
        await rename(currentRoot, replacementRoot);
        return () => rename(replacementRoot, currentRoot);
      },
    },
  );
}

export async function deleteProfile(
  layout: LiveAgentStorageLayout,
  name: string,
  options: ProfileRegistryMutationOptions,
): Promise<ProfileRegistry> {
  validateProfileName(name);
  if (reservedProfileNames.has(name)) {
    throw new Error("Reserved profiles cannot be deleted");
  }
  const profileRoot = join(layout.root, "profiles", name);
  const stagedDeletion = `${profileRoot}.deleting-${randomUUID()}`;
  return updateProfileRegistry(
    layout,
    options,
    (registry) => {
      if (!registry.profiles.some((entry) => entry.name === name)) {
        throw new Error(`Profile '${name}' does not exist`);
      }
      if (registry.profiles.length === 1) {
        throw new Error("At least one visible user profile is required");
      }
      if (registry.selectedProfile === name) {
        throw new Error("Selected profile cannot be deleted");
      }
      return {
        ...registry,
        revision: registry.revision + 1,
        profiles: registry.profiles.filter((entry) => entry.name !== name),
      };
    },
    {
      prepare: async () => {
        if (!(await exists(profileRoot))) return undefined;
        await rename(profileRoot, stagedDeletion);
        return () => rename(stagedDeletion, profileRoot);
      },
      committed: () => rm(stagedDeletion, { recursive: true, force: true }),
    },
  );
}

export async function selectProfile(
  layout: LiveAgentStorageLayout,
  name: string,
  options: ProfileRegistryMutationOptions,
): Promise<ProfileRegistry> {
  validateProfileName(name);
  if (reservedProfileNames.has(name)) {
    throw new Error("Reserved profiles cannot be selected");
  }
  return updateProfileRegistry(layout, options, (registry) => {
    if (!registry.profiles.some((entry) => entry.name === name)) {
      throw new Error(`Profile '${name}' does not exist`);
    }
    return {
      ...registry,
      revision: registry.revision + 1,
      selectedProfile: name,
    };
  });
}

export interface ArtifactTombstoneState {
  readonly version: typeof ARTIFACT_STATE_VERSION;
  readonly revision: number;
  readonly names: readonly string[];
}

export async function readArtifactTombstones(
  path: string,
): Promise<ArtifactTombstoneState> {
  try {
    const value = JSON.parse(
      await boundedReadFile(path, 256 * 1024),
    ) as Partial<ArtifactTombstoneState>;
    if (
      value.version !== ARTIFACT_STATE_VERSION ||
      !Number.isSafeInteger(value.revision) ||
      (value.revision ?? -1) < 0 ||
      !Array.isArray(value.names)
    ) {
      throw new Error("Artifact tombstone state is invalid");
    }
    const names = value.names.map(validateArtifactName);
    if (new Set(names).size !== names.length) {
      throw new Error("Artifact tombstone state contains duplicate names");
    }
    return {
      version: ARTIFACT_STATE_VERSION,
      revision: value.revision as number,
      names,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: ARTIFACT_STATE_VERSION, revision: 0, names: [] };
    }
    throw error;
  }
}

export async function writeArtifactTombstones(
  path: string,
  names: readonly string[],
  expectedRevision: number,
): Promise<ArtifactTombstoneState> {
  const current = await readArtifactTombstones(path);
  if (current.revision !== expectedRevision) {
    throw new Error(
      `Artifact state revision conflict: expected ${expectedRevision}, current ${current.revision}`,
    );
  }
  const validated = [...new Set(names.map(validateArtifactName))].sort();
  const updated: ArtifactTombstoneState = {
    version: ARTIFACT_STATE_VERSION,
    revision: current.revision + 1,
    names: validated,
  };
  await writeJsonAtomically(path, updated);
  return updated;
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

async function boundedReadFile(
  path: string,
  maximumBytes: number,
): Promise<string> {
  const details = await lstat(path);
  if (details.isSymbolicLink() || !details.isFile()) {
    throw new Error(`Expected a regular file at '${path}'`);
  }
  if (details.size > maximumBytes) {
    throw new Error(`File exceeds ${maximumBytes} bytes`);
  }
  return readFile(path, "utf8");
}

async function assertNoSymbolicLinkPath(
  root: string,
  target: string,
): Promise<void> {
  assertWithin(dirname(root), root);
  assertWithin(root, target);
  const candidates: string[] = [];
  let candidate = resolve(target);
  while (true) {
    candidates.push(candidate);
    const parent = dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  candidates.reverse();
  for (const candidate of candidates) {
    try {
      if ((await lstat(candidate)).isSymbolicLink()) {
        throw new Error(
          `Symbolic links are not allowed in storage path '${candidate}'`,
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export async function writeJsonAtomically(
  path: string,
  value: unknown,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await assertNoSymbolicLinkPath(dirname(path), path);
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
