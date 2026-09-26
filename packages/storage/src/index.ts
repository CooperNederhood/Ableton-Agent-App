import { createHash, randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
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
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

export const LIVE_AGENT_STORAGE_VERSION = 2;
export const LIVE_AGENT_HOME_ENVIRONMENT_VARIABLE = "LIVE_AGENT_HOME";
export const LIVE_AGENT_PROFILE_ENVIRONMENT_VARIABLE = "LIVE_AGENT_PROFILE";
export const PROFILE_REGISTRY_VERSION = 1;
export const ARTIFACT_STATE_VERSION = 1;
export const STORAGE_METADATA_VERSION = 1;
export const LIVE_PROJECTS_REGISTRY_VERSION = 1;
export const MAX_LIVE_PROJECTS = 256;
export const MAX_LIVE_PROJECT_LIVE_SETS = 1_024;

const profilePattern = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u;
const artifactPattern = /^[a-z][a-z0-9-]{0,63}$/u;
const reservedProfileNames = new Set(["development", "automation"]);

export type ArtifactKind = "agent" | "skill";
export type ArtifactScope = "system" | "profile" | "project" | "session";

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
  readonly liveSetSessionsPath: string;
  readonly liveProjectsRegistryPath: string;
  readonly credentialsDirectory: string;
  readonly copilotDirectory: string;
  readonly observabilityDirectory: string;
  readonly eventJournalPath: string;
  readonly logsDirectory: string;
  readonly desktopLogPath: string;
  readonly memoryDirectory: string;
  readonly projectStateDirectory: string;
  readonly unassignedLiveSetStateDirectory: string;
  readonly migrationMarkerPath: string;
}

export interface ResolveLiveAgentStorageOptions {
  readonly homeDirectory?: string;
  readonly environment?: Readonly<Partial<Record<string, string>>>;
  readonly profile?: string;
  readonly development?: boolean;
}

export interface AppSessionStoragePaths {
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

export interface ProjectStoragePaths {
  readonly projectDirectory: string;
  readonly metadataPath: string;
  readonly memoryDirectory: string;
  readonly liveSetStateDirectory: string;
  readonly agentsDirectory: string;
  readonly skillsDirectory: string;
  readonly artifactStateDirectory: string;
  readonly agentTombstonesPath: string;
  readonly skillTombstonesPath: string;
}

export interface LiveSetStoragePaths {
  readonly liveSetDirectory: string;
  readonly metadataPath: string;
  readonly memoryDirectory: string;
  readonly sessionStateDirectory: string;
}

export interface SessionStoragePaths extends AppSessionStoragePaths {
  readonly ownership: "project" | "unassigned";
  readonly project?: ProjectStoragePaths;
  readonly liveSet: LiveSetStoragePaths;
  readonly memoryDirectory: string;
}

export interface SessionStorageOwnershipContext {
  readonly liveSetId: string;
  readonly liveProjectId?: string;
  readonly sessionId: string;
}

export interface ProjectStorageOwnershipContext {
  readonly liveProjectId: string;
}

export type LiveSetStorageLocation =
  | {
      readonly ownership: "project";
      readonly projectId: string;
      readonly liveSetId: string;
    }
  | {
      readonly ownership: "unassigned";
      readonly liveSetId: string;
    };

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

export function storageEntityDirectoryName(identifier: string): string {
  if (identifier.length === 0) {
    throw new Error("Storage entity ID must not be empty");
  }
  if (
    identifier.length <= 200 &&
    /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/u.test(identifier)
  ) {
    return identifier;
  }
  return `entity-${createHash("sha256").update(identifier).digest("hex")}`;
}

function resolveNestedSessionStorageAtRoot(
  sessionStateDirectory: string,
  sessionId: string,
): AppSessionStoragePaths {
  if (sessionId.length === 0) {
    throw new Error("App session ID must not be empty");
  }
  const root = resolve(sessionStateDirectory);
  const sessionDirectory = join(
    root,
    productionSessionDirectoryName(sessionId),
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

export function resolveProjectStorage(
  layout: LiveAgentStorageLayout,
  projectId: string,
): ProjectStoragePaths {
  const projectDirectory = join(
    layout.projectStateDirectory,
    storageEntityDirectoryName(projectId),
  );
  assertWithin(layout.profileRoot, projectDirectory);
  return {
    projectDirectory,
    metadataPath: join(projectDirectory, "project.json"),
    memoryDirectory: join(projectDirectory, "memory"),
    liveSetStateDirectory: join(projectDirectory, "live-set-state"),
    agentsDirectory: join(projectDirectory, "agents"),
    skillsDirectory: join(projectDirectory, "skills"),
    artifactStateDirectory: join(projectDirectory, "artifact-state"),
    agentTombstonesPath: join(
      projectDirectory,
      "artifact-state",
      "agents.json",
    ),
    skillTombstonesPath: join(
      projectDirectory,
      "artifact-state",
      "skills.json",
    ),
  };
}

export function resolveLiveSetStorage(
  layout: LiveAgentStorageLayout,
  location: LiveSetStorageLocation,
): LiveSetStoragePaths {
  const project =
    location.ownership === "project"
      ? resolveProjectStorage(layout, location.projectId)
      : undefined;
  const liveSetDirectory = join(
    project?.liveSetStateDirectory ?? layout.unassignedLiveSetStateDirectory,
    storageEntityDirectoryName(location.liveSetId),
  );
  assertWithin(layout.profileRoot, liveSetDirectory);
  return {
    liveSetDirectory,
    metadataPath: join(liveSetDirectory, "live-set.json"),
    memoryDirectory: join(liveSetDirectory, "memory"),
    sessionStateDirectory: join(liveSetDirectory, "session-state"),
  };
}

export function resolveNestedSessionStorage(
  layout: LiveAgentStorageLayout,
  context: SessionStorageOwnershipContext,
): SessionStoragePaths {
  const project =
    context.liveProjectId === undefined
      ? undefined
      : resolveProjectStorage(layout, context.liveProjectId);
  const location: LiveSetStorageLocation =
    context.liveProjectId === undefined
      ? { ownership: "unassigned", liveSetId: context.liveSetId }
      : {
          ownership: "project",
          projectId: context.liveProjectId,
          liveSetId: context.liveSetId,
        };
  const liveSet = resolveLiveSetStorage(layout, location);
  const session = resolveNestedSessionStorageAtRoot(
    liveSet.sessionStateDirectory,
    context.sessionId,
  );
  assertWithin(layout.profileRoot, session.sessionDirectory);
  return {
    ...session,
    ownership: context.liveProjectId === undefined ? "unassigned" : "project",
    ...(project === undefined ? {} : { project }),
    liveSet,
    memoryDirectory: join(session.sessionDirectory, "memory"),
  };
}

export async function relocateLiveSetStorage(
  layout: LiveAgentStorageLayout,
  source: LiveSetStorageLocation,
  destination: LiveSetStorageLocation,
): Promise<boolean> {
  const sourcePaths = resolveLiveSetStorage(layout, source);
  const destinationPaths = resolveLiveSetStorage(layout, destination);
  if (sourcePaths.liveSetDirectory === destinationPaths.liveSetDirectory) {
    return false;
  }
  let sourceDetails;
  try {
    sourceDetails = await lstat(sourcePaths.liveSetDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (sourceDetails.isSymbolicLink() || !sourceDetails.isDirectory()) {
    throw new Error("Live Set storage source must be a physical directory");
  }
  try {
    await lstat(destinationPaths.liveSetDirectory);
    throw new Error("Live Set storage destination already exists");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(dirname(destinationPaths.liveSetDirectory), {
    recursive: true,
    mode: 0o700,
  });
  await rename(sourcePaths.liveSetDirectory, destinationPaths.liveSetDirectory);
  return true;
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
  const resolvedRoot = resolvePhysicalAncestors(root);
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
    liveSetSessionsPath: join(profileRoot, "state", "live-set-sessions.json"),
    liveProjectsRegistryPath: join(profileRoot, "state", "live-projects.json"),
    credentialsDirectory: join(profileRoot, "credentials"),
    copilotDirectory: join(profileRoot, "copilot"),
    observabilityDirectory: join(profileRoot, "observability"),
    eventJournalPath: join(
      profileRoot,
      "observability",
      "agent-set-event-history.sqlite",
    ),
    logsDirectory: join(profileRoot, "logs"),
    desktopLogPath: join(profileRoot, "logs", "desktop.log"),
    memoryDirectory: join(profileRoot, "memory"),
    projectStateDirectory: join(profileRoot, "project-state"),
    unassignedLiveSetStateDirectory: join(
      profileRoot,
      "unassigned-live-set-state",
    ),
    migrationMarkerPath: join(
      profileRoot,
      `storage-migration-v${LIVE_AGENT_STORAGE_VERSION}.json`,
    ),
  };
}

function resolvePhysicalAncestors(path: string): string {
  let existing = resolve(path);
  const missingSegments: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    missingSegments.unshift(basename(existing));
    existing = parent;
  }
  return join(realpathSync(existing), ...missingSegments);
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
  scope: "system" | "profile",
): ArtifactScopePaths;
export function resolveArtifactScopePaths(
  layout: LiveAgentStorageLayout,
  scope: "project",
  ownership: ProjectStorageOwnershipContext,
): ArtifactScopePaths;
export function resolveArtifactScopePaths(
  layout: LiveAgentStorageLayout,
  scope: "session",
  ownership: SessionStorageOwnershipContext,
): ArtifactScopePaths;
export function resolveArtifactScopePaths(
  layout: LiveAgentStorageLayout,
  scope: ArtifactScope,
  ownership?: ProjectStorageOwnershipContext | SessionStorageOwnershipContext,
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
  if (scope === "project") {
    if (ownership === undefined || !("liveProjectId" in ownership)) {
      throw new Error(
        "Project ownership context is required for project scope",
      );
    }
    const project = resolveProjectStorage(layout, ownership.liveProjectId);
    return {
      scope,
      root: project.projectDirectory,
      agentsDirectory: project.agentsDirectory,
      skillsDirectory: project.skillsDirectory,
      stateDirectory: project.artifactStateDirectory,
      agentTombstonesPath: project.agentTombstonesPath,
      skillTombstonesPath: project.skillTombstonesPath,
    };
  }
  if (
    ownership === undefined ||
    !("liveSetId" in ownership) ||
    !("sessionId" in ownership)
  ) {
    throw new Error("Session ownership context is required for session scope");
  }
  const session = resolveNestedSessionStorage(layout, ownership);
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
  const versionPath = join(layout.root, "storage-version.json");
  const hasVersionMarker = await exists(versionPath);
  if (hasVersionMarker) {
    const stored = JSON.parse(await readFile(versionPath, "utf8")) as {
      version?: unknown;
    };
    if (stored.version !== LIVE_AGENT_STORAGE_VERSION) {
      throw new Error(
        `Storage version ${String(stored.version)} is not supported`,
      );
    }
  }
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
    layout.memoryDirectory,
    layout.projectStateDirectory,
    layout.unassignedLiveSetStateDirectory,
  ];
  for (const directory of directories) {
    assertWithin(layout.root, directory);
    await assertNoSymbolicLinkPath(layout.root, directory);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }
  if (!hasVersionMarker) {
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

const MAX_STORAGE_DISPLAY_NAME_CHARACTERS = 512;

function validateStorageIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw new Error(`${label} must be between 1 and 512 characters`);
  }
  return value;
}

function validateStorageDisplayName(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_STORAGE_DISPLAY_NAME_CHARACTERS
  ) {
    throw new Error(
      `${label} must be between 1 and ${MAX_STORAGE_DISPLAY_NAME_CHARACTERS} characters`,
    );
  }
  return value;
}

function validateStorageTimestamp(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length > 64 ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new Error(`${label} must be an ISO-8601 timestamp`);
  }
  return value;
}

export interface ProjectStorageMetadata {
  readonly version: typeof STORAGE_METADATA_VERSION;
  readonly projectId: string;
  readonly displayName: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface LiveSetStorageMetadata {
  readonly version: typeof STORAGE_METADATA_VERSION;
  readonly liveSetId: string;
  readonly displayName: string;
  readonly projectId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface LiveProjectRegistryEntry {
  readonly projectId: string;
  readonly displayName: string;
  readonly liveSetIds: readonly string[];
  readonly updatedAt: string;
}

export interface LiveProjectsRegistry {
  readonly version: typeof LIVE_PROJECTS_REGISTRY_VERSION;
  readonly revision: number;
  readonly projects: readonly LiveProjectRegistryEntry[];
}

export function validateProjectStorageMetadata(
  value: unknown,
): ProjectStorageMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Project metadata must be an object");
  }
  const input = value as Record<string, unknown>;
  if (input.version !== STORAGE_METADATA_VERSION) {
    throw new Error("Project metadata version is not supported");
  }
  return {
    version: STORAGE_METADATA_VERSION,
    projectId: validateStorageIdentifier(input.projectId, "Project ID"),
    displayName: validateStorageDisplayName(
      input.displayName,
      "Project display name",
    ),
    createdAt: validateStorageTimestamp(input.createdAt, "Project createdAt"),
    updatedAt: validateStorageTimestamp(input.updatedAt, "Project updatedAt"),
  };
}

export function validateLiveSetStorageMetadata(
  value: unknown,
): LiveSetStorageMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Live Set metadata must be an object");
  }
  const input = value as Record<string, unknown>;
  if (input.version !== STORAGE_METADATA_VERSION) {
    throw new Error("Live Set metadata version is not supported");
  }
  const projectId =
    input.projectId === undefined
      ? undefined
      : validateStorageIdentifier(input.projectId, "Project ID");
  return {
    version: STORAGE_METADATA_VERSION,
    liveSetId: validateStorageIdentifier(input.liveSetId, "Live Set ID"),
    displayName: validateStorageDisplayName(
      input.displayName,
      "Live Set display name",
    ),
    ...(projectId === undefined ? {} : { projectId }),
    createdAt: validateStorageTimestamp(input.createdAt, "Live Set createdAt"),
    updatedAt: validateStorageTimestamp(input.updatedAt, "Live Set updatedAt"),
  };
}

function validateLiveProjectsRegistry(value: unknown): LiveProjectsRegistry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Live projects registry must be an object");
  }
  const input = value as Record<string, unknown>;
  if (input.version !== LIVE_PROJECTS_REGISTRY_VERSION) {
    throw new Error("Live projects registry version is not supported");
  }
  if (
    !Number.isInteger(input.revision) ||
    (input.revision as number) < 0 ||
    !Array.isArray(input.projects) ||
    input.projects.length > MAX_LIVE_PROJECTS
  ) {
    throw new Error("Live projects registry is invalid or exceeds its limit");
  }
  const seenProjects = new Set<string>();
  const projects = input.projects.map((candidate) => {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate)
    ) {
      throw new Error("Live project registry entry must be an object");
    }
    const entry = candidate as Record<string, unknown>;
    const projectId = validateStorageIdentifier(entry.projectId, "Project ID");
    if (seenProjects.has(projectId)) {
      throw new Error(`Duplicate live project '${projectId}'`);
    }
    seenProjects.add(projectId);
    if (
      !Array.isArray(entry.liveSetIds) ||
      entry.liveSetIds.length > MAX_LIVE_PROJECT_LIVE_SETS
    ) {
      throw new Error(`Live project '${projectId}' exceeds its Live Set limit`);
    }
    const liveSetIds = [
      ...new Set(
        entry.liveSetIds.map((id) =>
          validateStorageIdentifier(id, "Live Set ID"),
        ),
      ),
    ];
    return {
      projectId,
      displayName: validateStorageDisplayName(
        entry.displayName,
        "Project display name",
      ),
      liveSetIds,
      updatedAt: validateStorageTimestamp(entry.updatedAt, "Project updatedAt"),
    };
  });
  return {
    version: LIVE_PROJECTS_REGISTRY_VERSION,
    revision: input.revision as number,
    projects,
  };
}

export async function readLiveProjectsRegistry(
  path: string,
): Promise<LiveProjectsRegistry> {
  try {
    return validateLiveProjectsRegistry(
      JSON.parse(await boundedReadFile(path, 1024 * 1024)),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return {
      version: LIVE_PROJECTS_REGISTRY_VERSION,
      revision: 0,
      projects: [],
    };
  }
}

export async function writeLiveProjectsRegistry(
  path: string,
  projects: readonly LiveProjectRegistryEntry[],
  expectedRevision: number,
): Promise<LiveProjectsRegistry> {
  const current = await readLiveProjectsRegistry(path);
  if (current.revision !== expectedRevision) {
    throw new Error(
      `Live projects registry revision conflict: expected ${expectedRevision}, current ${current.revision}`,
    );
  }
  const updated = validateLiveProjectsRegistry({
    version: LIVE_PROJECTS_REGISTRY_VERSION,
    revision: current.revision + 1,
    projects,
  });
  await writeJsonAtomically(path, updated);
  return updated;
}

export async function writeProjectStorageMetadata(
  path: string,
  metadata: ProjectStorageMetadata,
): Promise<void> {
  await writeJsonAtomically(path, validateProjectStorageMetadata(metadata));
}

export async function readProjectStorageMetadata(
  path: string,
): Promise<ProjectStorageMetadata> {
  return validateProjectStorageMetadata(
    JSON.parse(await boundedReadFile(path, 64 * 1024)),
  );
}

export async function writeLiveSetStorageMetadata(
  path: string,
  metadata: LiveSetStorageMetadata,
): Promise<void> {
  await writeJsonAtomically(path, validateLiveSetStorageMetadata(metadata));
}

export async function readLiveSetStorageMetadata(
  path: string,
): Promise<LiveSetStorageMetadata> {
  return validateLiveSetStorageMetadata(
    JSON.parse(await boundedReadFile(path, 64 * 1024)),
  );
}

export interface NestedStorageMigrationEvent {
  readonly id: string;
  readonly name:
    | "storage.nested-migration.queued"
    | "storage.nested-migration.started"
    | "storage.nested-migration.progress"
    | "storage.nested-migration.completed"
    | "storage.nested-migration.failed"
    | "storage.nested-migration.cancelled";
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

export interface NestedStorageMigrationResult {
  readonly status: "dry-run" | "completed" | "not-needed" | "failed";
  readonly applied: boolean;
  readonly profile: string;
  readonly sourceVersion?: number;
  readonly targetVersion: typeof LIVE_AGENT_STORAGE_VERSION;
  readonly backupPath?: string;
  readonly actions: readonly string[];
  readonly events: readonly NestedStorageMigrationEvent[];
  readonly error?: string;
}

export interface MigrateNestedStorageOptions {
  readonly layout: LiveAgentStorageLayout;
  readonly apply?: boolean;
  readonly now?: () => Date;
}

interface LegacySessionLocation {
  readonly directoryName: string;
  readonly appSessionId: string;
  readonly liveSetId: string;
  readonly liveSetName: string;
}

const MAX_MIGRATION_REPORT_ACTIONS = 1_000;

function legacyProjectSessionsPath(layout: LiveAgentStorageLayout): string {
  return join(layout.profileRoot, "state", "project-sessions.json");
}

function legacySessionStateDirectory(layout: LiveAgentStorageLayout): string {
  return join(layout.profileRoot, "session-state");
}

function migrationAction(actions: string[], value: string): void {
  if (actions.length < MAX_MIGRATION_REPORT_ACTIONS) actions.push(value);
}

function legacyUnassignedLiveSetId(appSessionId: string): string {
  return `legacy-unassigned-${createHash("sha256")
    .update(appSessionId)
    .digest("hex")
    .slice(0, 32)}`;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function renameLegacyProjectFields(
  value: Record<string, unknown>,
): Record<string, unknown> {
  if ("liveSetId" in value || "liveSetName" in value) {
    throw new Error("Legacy record already contains Live Set fields");
  }
  const { projectId, projectName, ...rest } = value;
  return {
    ...rest,
    ...(projectId === undefined ? {} : { liveSetId: projectId }),
    ...(projectName === undefined ? {} : { liveSetName: projectName }),
  };
}

function migrateLegacySessionRecord(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const id = validateStorageIdentifier(value.id, "Legacy session ID");
  const updatedAt = validateStorageTimestamp(
    value.updatedAt,
    `Legacy session '${id}' updatedAt`,
  );
  const createdAt =
    value.createdAt === undefined
      ? updatedAt
      : validateStorageTimestamp(
          value.createdAt,
          `Legacy session '${id}' createdAt`,
        );
  return {
    ...renameLegacyProjectFields(value),
    createdAt,
  };
}

function migrateLegacySessionManifest(
  value: Record<string, unknown>,
  appSessionId: string,
): Record<string, unknown> {
  const updatedAt = validateStorageTimestamp(
    value.updatedAt,
    `Legacy session '${appSessionId}' updatedAt`,
  );
  const createdAt =
    value.createdAt === undefined
      ? updatedAt
      : validateStorageTimestamp(
          value.createdAt,
          `Legacy session '${appSessionId}' createdAt`,
        );
  return {
    ...renameLegacyProjectFields(value),
    createdAt,
  };
}

function compareMigratedSessions(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): number {
  const createdAtComparison =
    Date.parse(String(left.createdAt)) - Date.parse(String(right.createdAt));
  if (createdAtComparison !== 0) return createdAtComparison;
  const leftId = String(left.id);
  const rightId = String(right.id);
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

async function readJsonObject(
  path: string,
  label: string,
): Promise<Record<string, unknown>> {
  return objectValue(
    JSON.parse(await boundedReadFile(path, 4 * 1024 * 1024)),
    label,
  );
}

async function discoverLegacySessionLocations(
  layout: LiveAgentStorageLayout,
): Promise<LegacySessionLocation[]> {
  const legacyRoot = legacySessionStateDirectory(layout);
  if (!(await exists(legacyRoot))) return [];
  const rootDetails = await lstat(legacyRoot);
  if (rootDetails.isSymbolicLink() || !rootDetails.isDirectory()) {
    throw new Error("Legacy session-state must be a regular directory");
  }
  const locations: LegacySessionLocation[] = [];
  for (const directoryName of (await readdir(legacyRoot)).sort()) {
    const directory = join(legacyRoot, directoryName);
    const details = await lstat(directory);
    if (details.isSymbolicLink() || !details.isDirectory()) {
      throw new Error(
        `Legacy session-state entry '${directoryName}' is incomplete`,
      );
    }
    const manifestPath = join(directory, "session.json");
    if (!(await exists(manifestPath))) {
      throw new Error(
        `Legacy session-state entry '${directoryName}' has no session.json`,
      );
    }
    const manifest = await readJsonObject(
      manifestPath,
      `Legacy session manifest '${directoryName}'`,
    );
    renameLegacyProjectFields(manifest);
    const appSessionId = validateStorageIdentifier(
      manifest.productionSessionId,
      "Production session ID",
    );
    migrateLegacySessionManifest(manifest, appSessionId);
    if (productionSessionDirectoryName(appSessionId) !== directoryName) {
      throw new Error(
        `Legacy session-state entry '${directoryName}' does not match its session ID`,
      );
    }
    const liveSetId =
      manifest.projectId === undefined
        ? legacyUnassignedLiveSetId(appSessionId)
        : validateStorageIdentifier(manifest.projectId, "Legacy project ID");
    const liveSetName =
      manifest.projectName === undefined
        ? "Unassigned Live Set"
        : validateStorageDisplayName(
            manifest.projectName,
            "Legacy project name",
          );
    locations.push({ directoryName, appSessionId, liveSetId, liveSetName });
  }
  return locations;
}

async function assertTreeHasNoSymbolicLinks(path: string): Promise<void> {
  const details = await lstat(path);
  if (details.isSymbolicLink()) {
    throw new Error(`Symbolic links are not allowed in storage path '${path}'`);
  }
  if (!details.isDirectory()) return;
  for (const name of await readdir(path)) {
    await assertTreeHasNoSymbolicLinks(join(path, name));
  }
}

async function validateNestedMigrationSource(
  layout: LiveAgentStorageLayout,
): Promise<{
  readonly sourceVersion: number;
  readonly sessions?: Record<string, unknown>;
  readonly associations?: Record<string, unknown>;
  readonly locations: readonly LegacySessionLocation[];
}> {
  const versionPath = join(layout.root, "storage-version.json");
  if (!(await exists(versionPath))) {
    throw new Error(
      "Storage version marker is missing; refusing a partial or unsupported layout",
    );
  }
  const version = await readJsonObject(versionPath, "Storage version marker");
  if (!Number.isInteger(version.version)) {
    throw new Error("Storage version marker is invalid");
  }
  const sourceVersion = version.version as number;
  if (sourceVersion !== 1 && sourceVersion !== LIVE_AGENT_STORAGE_VERSION) {
    throw new Error(`Storage version ${sourceVersion} is not supported`);
  }
  const hasLegacyProfileLayout =
    (await exists(join(layout.profileRoot, "session-state"))) ||
    (await exists(join(layout.profileRoot, "state", "project-sessions.json")));
  if (sourceVersion === LIVE_AGENT_STORAGE_VERSION && !hasLegacyProfileLayout) {
    return { sourceVersion, locations: [] };
  }
  if (!(await exists(layout.profileRoot))) {
    throw new Error(`Profile '${layout.profile}' does not exist`);
  }
  await assertNoSymbolicLinkPath(layout.root, layout.profileRoot);
  await assertTreeHasNoSymbolicLinks(layout.profileRoot);
  const newLayoutPaths = [
    layout.liveSetSessionsPath,
    layout.liveProjectsRegistryPath,
    layout.projectStateDirectory,
    layout.unassignedLiveSetStateDirectory,
    layout.memoryDirectory,
  ];
  for (const path of newLayoutPaths) {
    if (await exists(path)) {
      throw new Error(
        `Refusing partial nested layout because '${relative(layout.profileRoot, path)}' already exists`,
      );
    }
  }
  const sessions = (await exists(layout.sessionsPath))
    ? await readJsonObject(layout.sessionsPath, "Legacy sessions manifest")
    : undefined;
  if (sessions !== undefined) {
    if (!Array.isArray(sessions.sessions)) {
      throw new Error("Legacy sessions manifest has no sessions array");
    }
    for (const [index, value] of sessions.sessions.entries()) {
      const session = objectValue(value, `Legacy session ${index}`);
      migrateLegacySessionRecord(session);
      if (session.projectId !== undefined) {
        validateStorageIdentifier(session.projectId, "Legacy project ID");
      }
      if (session.projectName !== undefined) {
        validateStorageDisplayName(session.projectName, "Legacy project name");
      }
      renameLegacyProjectFields(session);
    }
  }
  const projectSessionsPath = legacyProjectSessionsPath(layout);
  const associations = (await exists(projectSessionsPath))
    ? await readJsonObject(
        projectSessionsPath,
        "Legacy project sessions manifest",
      )
    : undefined;
  if (associations !== undefined && !Array.isArray(associations.associations)) {
    throw new Error(
      "Legacy project sessions manifest has no associations array",
    );
  }
  if (associations !== undefined) {
    for (const [index, value] of (
      associations.associations as unknown[]
    ).entries()) {
      const association = objectValue(value, `Legacy association ${index}`);
      validateStorageIdentifier(association.projectId, "Legacy project ID");
      validateStorageDisplayName(
        association.projectName,
        "Legacy project name",
      );
      validateStorageIdentifier(association.sessionId, "Legacy session ID");
      renameLegacyProjectFields(association);
    }
  }
  const locations = await discoverLegacySessionLocations(layout);
  const knownSessionIds = new Set(
    sessions === undefined
      ? []
      : (sessions.sessions as unknown[]).map((value, index) =>
          validateStorageIdentifier(
            objectValue(value, `Legacy session ${index}`).id,
            "Legacy session ID",
          ),
        ),
  );
  for (const location of locations) {
    if (!knownSessionIds.has(location.appSessionId)) {
      throw new Error(
        `Legacy session-state '${location.directoryName}' has no matching session record`,
      );
    }
  }
  return {
    sourceVersion: 1,
    ...(sessions === undefined ? {} : { sessions }),
    ...(associations === undefined ? {} : { associations }),
    locations,
  };
}

async function everyProfileUsesNestedStorage(
  layout: LiveAgentStorageLayout,
): Promise<boolean> {
  const profilesRoot = join(layout.root, "profiles");
  for (const entry of await readdir(profilesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (
      entry.name.includes(".pre-v2-") ||
      entry.name.includes(".nested-migration-") ||
      entry.name.includes(".migration-") ||
      entry.name.includes(".rollback-")
    ) {
      continue;
    }
    const profileRoot = join(profilesRoot, entry.name);
    if (
      (await exists(join(profileRoot, "session-state"))) ||
      (await exists(join(profileRoot, "state", "project-sessions.json")))
    ) {
      return false;
    }
  }
  return true;
}

function transformLegacySessions(
  document: Record<string, unknown>,
): Record<string, unknown> {
  const sessions = (document.sessions as unknown[])
    .map((value, index) =>
      migrateLegacySessionRecord(
        objectValue(value, `Legacy sessions record ${index}`),
      ),
    )
    .sort(compareMigratedSessions);
  return {
    ...document,
    version: 4,
    sessions,
  };
}

function transformLegacyAssociations(
  document: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...document,
    associations: (document.associations as unknown[]).map((value, index) =>
      renameLegacyProjectFields(
        objectValue(value, `Legacy associations record ${index}`),
      ),
    ),
  };
}

export async function migrateNestedStorage(
  options: MigrateNestedStorageOptions,
): Promise<NestedStorageMigrationResult> {
  const apply = options.apply === true;
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const traceId = randomUUID();
  const correlationId = randomUUID();
  const rootSpanId = randomUUID();
  const events: NestedStorageMigrationEvent[] = [];
  const actions: string[] = [];
  let previousEvent: string | undefined;
  const emit = (
    name: NestedStorageMigrationEvent["name"],
    attributes: NestedStorageMigrationEvent["attributes"],
    outcome?: NestedStorageMigrationEvent["outcome"],
    child = false,
  ): void => {
    const causationId = previousEvent;
    const id = randomUUID();
    previousEvent = id;
    events.push({
      id,
      name,
      occurredAt: now().toISOString(),
      traceId,
      spanId: child ? randomUUID() : rootSpanId,
      ...(child ? { parentSpanId: rootSpanId } : {}),
      correlationId,
      ...(causationId === undefined ? {} : { causationId }),
      attributes,
      ...(outcome === undefined ? {} : { outcome }),
      ...(name.endsWith("completed") ||
      name.endsWith("failed") ||
      name.endsWith("cancelled")
        ? { durationMs: now().getTime() - startedAt.getTime() }
        : {}),
    });
  };
  emit("storage.nested-migration.queued", {
    profile: options.layout.profile,
    apply,
  });
  try {
    emit("storage.nested-migration.started", {
      profile: options.layout.profile,
      apply,
    });
    const rootVersionPath = join(options.layout.root, "storage-version.json");
    const rootVersion = (await exists(rootVersionPath))
      ? objectValue(
          JSON.parse(await boundedReadFile(rootVersionPath, 64 * 1024)),
          "Storage version",
        ).version
      : undefined;
    const profileMigrationMarker = join(
      options.layout.profileRoot,
      `storage-migration-v${LIVE_AGENT_STORAGE_VERSION}.json`,
    );
    if (
      rootVersion === 1 &&
      (await exists(profileMigrationMarker)) &&
      !(await exists(join(options.layout.profileRoot, "session-state"))) &&
      !(await exists(
        join(options.layout.profileRoot, "state", "project-sessions.json"),
      ))
    ) {
      if (!(await everyProfileUsesNestedStorage(options.layout))) {
        emit(
          "storage.nested-migration.cancelled",
          {
            profile: options.layout.profile,
            reason: "waiting-for-other-profiles",
          },
          "cancelled",
        );
        return {
          status: "not-needed",
          applied: false,
          profile: options.layout.profile,
          sourceVersion: 1,
          targetVersion: LIVE_AGENT_STORAGE_VERSION,
          actions,
          events,
        };
      }
      migrationAction(
        actions,
        `update storage version to ${LIVE_AGENT_STORAGE_VERSION} after all legacy profiles are migrated`,
      );
      emit(
        "storage.nested-migration.progress",
        {
          profile: options.layout.profile,
          actionCount: actions.length,
          phase: "validated",
        },
        undefined,
        true,
      );
      if (!apply) {
        emit(
          "storage.nested-migration.completed",
          {
            profile: options.layout.profile,
            actionCount: actions.length,
            mode: "dry-run",
          },
          "success",
        );
        return {
          status: "dry-run",
          applied: false,
          profile: options.layout.profile,
          sourceVersion: 1,
          targetVersion: LIVE_AGENT_STORAGE_VERSION,
          actions,
          events,
        };
      }
      const timestamp = now().toISOString().replace(/[:.]/gu, "-");
      const backupRoot = join(
        options.layout.root,
        "backups",
        `storage-v1-${timestamp}`,
      );
      await mkdir(backupRoot, { recursive: true, mode: 0o700 });
      await cp(rootVersionPath, join(backupRoot, "storage-version.json"), {
        errorOnExist: true,
        force: false,
      });
      await hardenPermissions(backupRoot);
      emit(
        "storage.nested-migration.progress",
        { profile: options.layout.profile, phase: "backup-completed" },
        undefined,
        true,
      );
      await writeJsonAtomically(rootVersionPath, {
        version: LIVE_AGENT_STORAGE_VERSION,
      });
      emit(
        "storage.nested-migration.completed",
        {
          profile: options.layout.profile,
          actionCount: actions.length,
          mode: "apply",
        },
        "success",
      );
      return {
        status: "completed",
        applied: true,
        profile: options.layout.profile,
        sourceVersion: 1,
        targetVersion: LIVE_AGENT_STORAGE_VERSION,
        backupPath: backupRoot,
        actions,
        events,
      };
    }
    const source = await validateNestedMigrationSource(options.layout);
    if (source.sourceVersion === LIVE_AGENT_STORAGE_VERSION) {
      emit(
        "storage.nested-migration.cancelled",
        { profile: options.layout.profile, reason: "already-current" },
        "cancelled",
      );
      return {
        status: "not-needed",
        applied: false,
        profile: options.layout.profile,
        sourceVersion: source.sourceVersion,
        targetVersion: LIVE_AGENT_STORAGE_VERSION,
        actions,
        events,
      };
    }
    if (source.sessions !== undefined) {
      migrationAction(
        actions,
        "upgrade state/sessions.json to v4 with deterministic createdAt values and Live Set fields",
      );
    }
    if (source.associations !== undefined) {
      migrationAction(
        actions,
        "rename state/project-sessions.json to state/live-set-sessions.json",
      );
    }
    for (const location of source.locations) {
      migrationAction(
        actions,
        `move session-state/${location.directoryName} to unassigned-live-set-state/${storageEntityDirectoryName(location.liveSetId)}/session-state/${location.directoryName}`,
      );
    }
    migrationAction(actions, "create bounded state/live-projects.json");
    migrationAction(actions, "reserve nested memory ownership directories");
    migrationAction(
      actions,
      `update storage version to ${LIVE_AGENT_STORAGE_VERSION} after all legacy profiles are migrated`,
    );
    emit(
      "storage.nested-migration.progress",
      {
        profile: options.layout.profile,
        actionCount: actions.length,
        phase: "validated",
      },
      undefined,
      true,
    );
    if (!apply) {
      emit(
        "storage.nested-migration.completed",
        {
          profile: options.layout.profile,
          actionCount: actions.length,
          mode: "dry-run",
        },
        "success",
      );
      return {
        status: "dry-run",
        applied: false,
        profile: options.layout.profile,
        sourceVersion: source.sourceVersion,
        targetVersion: LIVE_AGENT_STORAGE_VERSION,
        actions,
        events,
      };
    }

    const timestamp = now().toISOString().replace(/[:.]/gu, "-");
    const backupRoot = join(
      options.layout.root,
      "backups",
      `storage-v1-${timestamp}`,
    );
    const backupPath = join(backupRoot, options.layout.profile);
    const stagingRoot = `${options.layout.profileRoot}.nested-migration-${randomUUID()}`;
    const previousRoot = `${options.layout.profileRoot}.pre-v2-${randomUUID()}`;
    await mkdir(backupRoot, { recursive: true, mode: 0o700 });
    await cp(options.layout.profileRoot, backupPath, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    await cp(
      join(options.layout.root, "storage-version.json"),
      join(backupRoot, "storage-version.json"),
      { errorOnExist: true, force: false },
    );
    await hardenPermissions(backupRoot);
    emit(
      "storage.nested-migration.progress",
      {
        profile: options.layout.profile,
        phase: "backup-completed",
      },
      undefined,
      true,
    );

    try {
      await cp(options.layout.profileRoot, stagingRoot, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
      if (source.sessions !== undefined) {
        await writeJsonAtomically(
          join(stagingRoot, "state", "sessions.json"),
          transformLegacySessions(source.sessions),
        );
      }
      if (source.associations !== undefined) {
        const legacyPath = join(stagingRoot, "state", "project-sessions.json");
        await writeJsonAtomically(
          join(stagingRoot, "state", "live-set-sessions.json"),
          transformLegacyAssociations(source.associations),
        );
        await rm(legacyPath);
      }
      await writeJsonAtomically(
        join(stagingRoot, "state", "live-projects.json"),
        {
          version: LIVE_PROJECTS_REGISTRY_VERSION,
          revision: 0,
          projects: [],
        },
      );
      await mkdir(join(stagingRoot, "memory"), {
        recursive: true,
        mode: 0o700,
      });
      await mkdir(join(stagingRoot, "project-state"), {
        recursive: true,
        mode: 0o700,
      });
      await mkdir(join(stagingRoot, "unassigned-live-set-state"), {
        recursive: true,
        mode: 0o700,
      });
      const liveSets = new Map<string, LegacySessionLocation>();
      for (const location of source.locations) {
        const liveSetDirectory = join(
          stagingRoot,
          "unassigned-live-set-state",
          storageEntityDirectoryName(location.liveSetId),
        );
        const sessionDirectory = join(
          liveSetDirectory,
          "session-state",
          location.directoryName,
        );
        await mkdir(dirname(sessionDirectory), {
          recursive: true,
          mode: 0o700,
        });
        await rename(
          join(stagingRoot, "session-state", location.directoryName),
          sessionDirectory,
        );
        await mkdir(join(liveSetDirectory, "memory"), {
          recursive: true,
          mode: 0o700,
        });
        await mkdir(join(sessionDirectory, "memory"), {
          recursive: true,
          mode: 0o700,
        });
        const manifestPath = join(sessionDirectory, "session.json");
        const manifest = await readJsonObject(
          manifestPath,
          `Legacy session manifest '${location.directoryName}'`,
        );
        await writeJsonAtomically(
          manifestPath,
          migrateLegacySessionManifest(manifest, location.appSessionId),
        );
        liveSets.set(location.liveSetId, location);
      }
      await rm(join(stagingRoot, "session-state"), {
        recursive: true,
        force: true,
      });
      for (const location of liveSets.values()) {
        const liveSetDirectory = join(
          stagingRoot,
          "unassigned-live-set-state",
          storageEntityDirectoryName(location.liveSetId),
        );
        await writeLiveSetStorageMetadata(
          join(liveSetDirectory, "live-set.json"),
          {
            version: STORAGE_METADATA_VERSION,
            liveSetId: location.liveSetId,
            displayName: location.liveSetName,
            createdAt: now().toISOString(),
            updatedAt: now().toISOString(),
          },
        );
      }
      await writeJsonAtomically(
        join(
          stagingRoot,
          `storage-migration-v${LIVE_AGENT_STORAGE_VERSION}.json`,
        ),
        {
          version: LIVE_AGENT_STORAGE_VERSION,
          sourceVersion: source.sourceVersion,
          completedAt: now().toISOString(),
          backupPath,
          actionCount: actions.length,
        },
      );
      await hardenPermissions(stagingRoot);
      await rename(options.layout.profileRoot, previousRoot);
      try {
        await rename(stagingRoot, options.layout.profileRoot);
        if (await everyProfileUsesNestedStorage(options.layout)) {
          await writeJsonAtomically(
            join(options.layout.root, "storage-version.json"),
            { version: LIVE_AGENT_STORAGE_VERSION },
          );
        }
      } catch (error) {
        await rm(options.layout.profileRoot, { recursive: true, force: true });
        await rename(previousRoot, options.layout.profileRoot);
        throw error;
      }
      await rm(previousRoot, { recursive: true, force: true });
    } catch (error) {
      await rm(stagingRoot, { recursive: true, force: true });
      throw error;
    }
    emit(
      "storage.nested-migration.completed",
      {
        profile: options.layout.profile,
        actionCount: actions.length,
        mode: "apply",
      },
      "success",
    );
    return {
      status: "completed",
      applied: true,
      profile: options.layout.profile,
      sourceVersion: source.sourceVersion,
      targetVersion: LIVE_AGENT_STORAGE_VERSION,
      backupPath,
      actions,
      events,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit(
      "storage.nested-migration.failed",
      { profile: options.layout.profile, error: message.slice(0, 1_024) },
      "failure",
    );
    return {
      status: "failed",
      applied: false,
      profile: options.layout.profile,
      targetVersion: LIVE_AGENT_STORAGE_VERSION,
      actions,
      events,
      error: message.slice(0, 4_096),
    };
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
  readonly skipReason?: "automation-profile" | "explicit-home-override";
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

  if (options.skipReason !== undefined) {
    emit({
      name: "storage.migration.cancelled",
      spanId: rootSpanId,
      outcome: "cancelled",
      durationMs: now().getTime() - startedAt.getTime(),
      attributes: {
        profile: options.layout.profile,
        reason: options.skipReason,
      },
    });
    return { status: "not-needed", migrated: [], events };
  }

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
  assertWithin(root, target);
  const candidates: string[] = [];
  const boundary = resolve(root);
  let candidate = resolve(target);
  while (true) {
    candidates.push(candidate);
    if (candidate === boundary) break;
    const parent = dirname(candidate);
    if (parent === candidate) {
      throw new Error(`Storage path '${target}' escaped root '${root}'`);
    }
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
