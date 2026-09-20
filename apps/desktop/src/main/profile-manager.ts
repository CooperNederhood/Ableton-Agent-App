import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  compareArtifacts,
  copyArtifact,
  deleteArtifact,
  disableArtifact,
  loadLayeredAgentCatalog,
  moveArtifact,
  replaceAgentDefinitionInScope,
  readArtifactTombstones,
  renameAgentInScope,
  renameSkillInScope,
  resolveArtifactPathInScope,
  restoreArtifact,
  type LayeredAgentCatalog,
} from "@ableton-agent/agent-config";
import {
  APPLICATION_TOOL_NAMES,
  APPROVED_BUILTIN_TOOL_NAMES,
} from "@ableton-agent/application";
import {
  createProfile,
  deleteProfile,
  ensureLiveAgentStorage,
  loadProfileRegistry,
  renameProfile,
  resolveArtifactScopePaths,
  resolveLiveAgentStorage,
  selectProfile,
  type ArtifactScopePaths,
  type LiveAgentStorageLayout,
  type ProfileRegistry,
} from "@ableton-agent/storage";
import { abletonToolMetadata } from "@ableton-agent/tools";

import {
  desktopProfileManagerSnapshotSchema,
  desktopProfileStatusSchema,
  sessionSchema,
  type DesktopArtifactConflict,
  type DesktopArtifactKind,
  type DesktopArtifactLocation,
  type DesktopArtifactMutationResult,
  type DesktopArtifactScope,
  type DesktopAgentCatalog,
  type DesktopProfileManagerSnapshot,
  type DesktopScopedArtifact,
  type DesktopSession,
} from "../contracts.js";
import type { ProfileManagerActions } from "./ipc.js";

const availableTools = [
  ...abletonToolMetadata.map((tool) => tool.name),
  ...APPLICATION_TOOL_NAMES,
  ...APPROVED_BUILTIN_TOOL_NAMES,
];
const maximumSessionsFileBytes = 4 * 1024 * 1024;

type TelemetryWriter = (event: {
  version: 1;
  id: string;
  occurredAt: string;
  name: string;
  category: "storage";
  source: "desktop-profile-manager";
  level: "info" | "error";
  outcome?: "success" | "failure" | "cancelled";
  durationMs?: number;
  correlationId: string;
  causationId?: string;
  trace: {
    traceId: string;
    spanId: string;
    parentSpanId?: string;
  };
  attributes: Readonly<Record<string, string | number | boolean>>;
}) => void;

export interface ProfileManagerOptions {
  readonly rootLayout: LiveAgentStorageLayout;
  readonly bundledAgentsDirectory: string;
  readonly bundledSkillsDirectory: string;
  readonly environmentProfileOverride?: string;
  readonly getActiveProfile: () => string;
  readonly getActiveSessionId: () => Promise<string | undefined>;
  readonly persistActiveSession: () => Promise<DesktopSession>;
  readonly closeActiveSession: () => Promise<void>;
  readonly refreshActiveCatalog: () => Promise<DesktopAgentCatalog>;
  readonly switchProfile: (profile: string) => Promise<void>;
  readonly telemetry?: TelemetryWriter;
}

class ProfileOperationCancelledError extends Error {}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function artifactDescription(
  kind: DesktopArtifactKind,
  entry:
    | LayeredAgentCatalog["agents"][number]
    | LayeredAgentCatalog["skills"][number],
): string {
  return kind === "agent"
    ? (entry as LayeredAgentCatalog["agents"][number]).definition.description
    : (entry as LayeredAgentCatalog["skills"][number]).metadata.description;
}

function artifactName(
  kind: DesktopArtifactKind,
  entry:
    | LayeredAgentCatalog["agents"][number]
    | LayeredAgentCatalog["skills"][number],
): string {
  return kind === "agent"
    ? (entry as LayeredAgentCatalog["agents"][number]).definition.name
    : (entry as LayeredAgentCatalog["skills"][number]).metadata.name;
}

function artifactSourceFile(
  kind: DesktopArtifactKind,
  entry:
    | LayeredAgentCatalog["agents"][number]
    | LayeredAgentCatalog["skills"][number],
): string {
  return kind === "agent"
    ? basename(entry.sourcePath)
    : `${basename(
        (entry as LayeredAgentCatalog["skills"][number]).directory,
      )}/SKILL.md`;
}

function catalogArtifacts(
  scope: DesktopArtifactScope,
  catalog: LayeredAgentCatalog,
  owner: { profile?: string; sessionId?: string } = {},
  includeInherited = false,
): DesktopScopedArtifact[] {
  const convert = (
    kind: DesktopArtifactKind,
    entry:
      | LayeredAgentCatalog["agents"][number]
      | LayeredAgentCatalog["skills"][number],
  ): DesktopScopedArtifact => ({
    kind,
    name: artifactName(kind, entry),
    description: artifactDescription(kind, entry),
    scope,
    origin: entry.origin,
    state:
      entry.origin === scope
        ? entry.overrides.length === 0
          ? "local"
          : "overridden"
        : "inherited",
    sourceFile: artifactSourceFile(kind, entry),
    fingerprint: entry.fingerprint,
    ...owner,
    overriddenOrigins: [...entry.overrides],
    diagnostics: catalog.diagnostics
      .filter(
        ({ sourcePath }) => basename(sourcePath) === basename(entry.sourcePath),
      )
      .map(({ message }) => message),
  });
  return [
    ...catalog.agents
      .filter((entry) => includeInherited || entry.origin === scope)
      .map((entry) => convert("agent", entry)),
    ...catalog.skills
      .filter((entry) => includeInherited || entry.origin === scope)
      .map((entry) => convert("skill", entry)),
  ].sort(
    (left, right) =>
      left.kind.localeCompare(right.kind) ||
      left.name.localeCompare(right.name),
  );
}

async function readSessions(
  layout: LiveAgentStorageLayout,
): Promise<ReturnType<typeof sessionSchema.parse>[]> {
  try {
    const details = await lstat(layout.sessionsPath);
    if (!details.isFile() || details.size > maximumSessionsFileBytes) return [];
    const parsed: unknown = JSON.parse(
      await readFile(layout.sessionsPath, "utf8"),
    );
    return sessionSchema.array().parse(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function layer(paths: ArtifactScopePaths) {
  return {
    agentsDirectory: paths.agentsDirectory,
    skillsDirectory: paths.skillsDirectory,
    agentTombstones: paths.agentTombstonesPath,
    skillTombstones: paths.skillTombstonesPath,
  };
}

async function ensureScope(paths: ArtifactScopePaths): Promise<void> {
  await Promise.all([
    mkdir(paths.agentsDirectory, { recursive: true, mode: 0o700 }),
    mkdir(paths.skillsDirectory, { recursive: true, mode: 0o700 }),
    mkdir(paths.stateDirectory, { recursive: true, mode: 0o700 }),
  ]);
}

async function physicalArtifact(
  kind: DesktopArtifactKind,
  directory: ArtifactScopePaths,
  name: string,
  ensureDirectories = true,
): Promise<string | undefined> {
  if (ensureDirectories) await ensureScope(directory);
  return resolveArtifactPathInScope({
    kind,
    directory:
      kind === "agent" ? directory.agentsDirectory : directory.skillsDirectory,
    name,
  });
}

function sourceDescription(
  artifact: DesktopScopedArtifact | undefined,
  fallback: string,
): string {
  return artifact?.description || fallback;
}

export class DesktopProfileManager implements ProfileManagerActions {
  public constructor(private readonly options: ProfileManagerOptions) {}

  public async get(
    selectedProfile?: string,
  ): Promise<DesktopProfileManagerSnapshot> {
    const registry = await loadProfileRegistry(this.options.rootLayout);
    const activeProfile = this.options.getActiveProfile();
    const selected =
      selectedProfile !== undefined &&
      (registry.profiles.some(({ name }) => name === selectedProfile) ||
        (this.options.environmentProfileOverride !== undefined &&
          selectedProfile === activeProfile))
        ? selectedProfile
        : registry.selectedProfile;
    return this.#snapshot(registry, selected);
  }

  public async status() {
    const registry = await loadProfileRegistry(this.options.rootLayout);
    const activeProfile = this.options.getActiveProfile();
    const activeSessionId = await this.options.getActiveSessionId();
    return desktopProfileStatusSchema.parse({
      revision: fingerprint({
        registryRevision: registry.revision,
        activeProfile,
        activeSessionId,
      }),
      activeProfile,
      ...(activeSessionId === undefined ? {} : { activeSessionId }),
      ...(this.options.environmentProfileOverride === undefined
        ? {}
        : {
            switchingDisabledReason:
              "Profile switching is disabled because LIVE_AGENT_PROFILE is set.",
          }),
      profiles: [
        ...registry.profiles.map(({ name }) => ({
          name,
          active: name === activeProfile,
          reserved: false,
        })),
        ...(registry.profiles.some(({ name }) => name === activeProfile)
          ? []
          : [{ name: activeProfile, active: true, reserved: true }]),
      ],
    });
  }

  public async saveAgentDefinition({
    definition,
    expectedRevision,
    expectedFingerprint,
  }: Parameters<ProfileManagerActions["saveAgentDefinition"]>[0]) {
    return this.#artifactOperation(
      "save-definition",
      "agent",
      definition.name,
      async () => {
        const activeProfile = this.options.getActiveProfile();
        let snapshot: DesktopProfileManagerSnapshot;
        try {
          snapshot = await this.#assertRevision(
            expectedRevision,
            activeProfile,
          );
        } catch (error) {
          throw new ProfileOperationCancelledError(
            error instanceof Error ? error.message : String(error),
          );
        }
        const sessionId = snapshot.activeSessionId;
        if (sessionId === undefined) {
          throw new Error("An active persisted production session is required");
        }
        const selectedLayout = resolveLiveAgentStorage({
          environment: { LIVE_AGENT_HOME: this.options.rootLayout.root },
          profile: snapshot.activeProfile,
        });
        let session = (await readSessions(selectedLayout)).find(
          ({ id }) => id === sessionId,
        );
        if (session === undefined) {
          session = await this.options.persistActiveSession();
          if (session.id !== sessionId) {
            throw new Error(
              "The active production session changed during save",
            );
          }
        }
        const eventIds = new Set(session.liveEvents.map(({ id }) => id));
        const unknownEventIds = definition.eventListeners
          .map(({ eventId }) => eventId)
          .filter((eventId) => !eventIds.has(eventId));
        if (unknownEventIds.length > 0) {
          throw new Error(
            `Agent event listeners reference unknown events: ${[...new Set(unknownEventIds)].join(", ")}`,
          );
        }
        const sessionPaths = resolveArtifactScopePaths(
          selectedLayout,
          "session",
          sessionId,
        );
        await ensureScope(sessionPaths);
        const bundled = {
          agentsDirectory: this.options.bundledAgentsDirectory,
          skillsDirectory: this.options.bundledSkillsDirectory,
        };
        const system = resolveArtifactScopePaths(selectedLayout, "system");
        const profile = resolveArtifactScopePaths(selectedLayout, "profile");
        const load = () =>
          loadLayeredAgentCatalog({
            bundled,
            system: layer(system),
            profile: layer(profile),
            session: layer(sessionPaths),
            availableTools,
          });
        const current = (await load()).agents.find(
          ({ definition: candidate }) => candidate.name === definition.name,
        );
        if (current === undefined) {
          throw new Error(
            `Agent definition '${definition.name}' does not exist`,
          );
        }
        if (current.fingerprint !== expectedFingerprint) {
          throw new ProfileOperationCancelledError(
            "Agent definition changed; refresh before trying again",
          );
        }
        try {
          await this.#assertSnapshotUnchanged(snapshot);
        } catch (error) {
          throw new ProfileOperationCancelledError(
            error instanceof Error ? error.message : String(error),
          );
        }
        let result:
          | {
              catalog: DesktopAgentCatalog;
              profileSnapshot: DesktopProfileManagerSnapshot;
            }
          | undefined;
        try {
          await replaceAgentDefinitionInScope({
            agentsDirectory: sessionPaths.agentsDirectory,
            definition: definition,
            validatePublishedCatalog: async () => {
              const validated = await load();
              const saved = validated.agents.find(
                ({ definition: candidate }) =>
                  candidate.name === definition.name,
              );
              if (
                saved?.origin !== "session" ||
                !isDeepStrictEqual(saved.definition, definition)
              ) {
                throw new Error(
                  `Saved agent definition '${definition.name}' did not resolve from Session Scope`,
                );
              }
              result = {
                catalog: await this.options.refreshActiveCatalog(),
                profileSnapshot: await this.get(snapshot.activeProfile),
              };
            },
          });
        } catch (error) {
          await this.options.refreshActiveCatalog().catch(() => undefined);
          throw error;
        }
        if (result === undefined) {
          throw new Error("Agent definition save did not produce a snapshot");
        }
        return result;
      },
    );
  }

  public async create({
    name,
    expectedRevision,
  }: Parameters<ProfileManagerActions["create"]>[0]) {
    return this.#profileOperation("create", { profile: name }, async () => {
      const snapshot = await this.#assertRevision(expectedRevision);
      const registry = await createProfile(
        this.options.rootLayout,
        { name, displayName: name },
        { expectedRevision: await this.#registryRevision(snapshot) },
      );
      return this.#snapshot(registry, name);
    });
  }

  public async rename({
    name,
    newName,
    expectedRevision,
  }: Parameters<ProfileManagerActions["rename"]>[0]) {
    return this.#profileOperation(
      "rename",
      { profile: name, replacement_profile: newName },
      async () => {
        const snapshot = await this.#assertRevision(expectedRevision, name);
        if (name === this.options.getActiveProfile()) {
          throw new Error(
            "Close and switch away from a profile before renaming it",
          );
        }
        const registry = await renameProfile(
          this.options.rootLayout,
          name,
          { name: newName, displayName: newName },
          { expectedRevision: await this.#registryRevision(snapshot) },
        );
        return this.#snapshot(registry, newName);
      },
    );
  }

  public async delete({
    name,
    expectedRevision,
  }: Parameters<ProfileManagerActions["delete"]>[0]) {
    return this.#profileOperation("delete", { profile: name }, async () => {
      const snapshot = await this.#assertRevision(expectedRevision, name);
      if (name === this.options.getActiveProfile()) {
        throw new Error("The active profile cannot be deleted");
      }
      const registry = await deleteProfile(this.options.rootLayout, name, {
        expectedRevision: await this.#registryRevision(snapshot),
      });
      return this.#snapshot(registry, registry.selectedProfile);
    });
  }

  public async switch({
    name,
    expectedRevision,
    closeActiveSession,
  }: Parameters<ProfileManagerActions["switch"]>[0]): Promise<void> {
    await this.#profileOperation("switch", { profile: name }, async () => {
      const registry = await loadProfileRegistry(this.options.rootLayout);
      const activeProfile = this.options.getActiveProfile();
      const activeSessionId = await this.options.getActiveSessionId();
      if (
        fingerprint({
          registryRevision: registry.revision,
          activeProfile,
          activeSessionId,
        }) !== expectedRevision
      ) {
        throw new Error("Profiles changed; refresh before trying again");
      }
      if (this.options.environmentProfileOverride !== undefined) {
        throw new Error(
          "Profile switching is disabled by LIVE_AGENT_PROFILE for this process",
        );
      }
      if (activeSessionId !== undefined) {
        if (!closeActiveSession) {
          throw new Error(
            "Confirm closing the active production session before switching",
          );
        }
        await this.options.closeActiveSession();
        if ((await this.options.getActiveSessionId()) !== undefined) {
          throw new Error("The active production session could not be closed");
        }
      }
      const selected = await selectProfile(this.options.rootLayout, name, {
        expectedRevision: registry.revision,
      });
      try {
        await this.options.switchProfile(name);
      } catch (error) {
        await selectProfile(
          this.options.rootLayout,
          this.options.getActiveProfile(),
          { expectedRevision: selected.revision },
        );
        throw error;
      }
    });
  }

  public copyArtifact(
    request: Parameters<ProfileManagerActions["copyArtifact"]>[0],
  ): Promise<DesktopArtifactMutationResult> {
    return this.#transferArtifact("copy", request);
  }

  public moveArtifact(
    request: Parameters<ProfileManagerActions["moveArtifact"]>[0],
  ): Promise<DesktopArtifactMutationResult> {
    return this.#transferArtifact("move", request);
  }

  public async renameArtifact(
    request: Parameters<ProfileManagerActions["renameArtifact"]>[0],
  ): Promise<DesktopProfileManagerSnapshot> {
    return this.#artifactOperation(
      "rename",
      request.kind,
      request.name,
      async () => {
        const snapshot = await this.#assertRevision(request.expectedRevision);
        const paths = await this.#paths(request.location, snapshot);
        if (request.kind === "agent") {
          await renameAgentInScope({
            agentsDirectory: paths.agentsDirectory,
            currentName: request.name,
            replacementName: request.newName,
          });
        } else {
          await renameSkillInScope({
            agentsDirectory: paths.agentsDirectory,
            skillsDirectory: paths.skillsDirectory,
            currentName: request.name,
            replacementName: request.newName,
          });
        }
        await this.#refreshIfActive(request.location);
        return this.get(snapshot.selectedProfile);
      },
    );
  }

  public async deleteArtifact(
    request: Parameters<ProfileManagerActions["deleteArtifact"]>[0],
  ): Promise<DesktopProfileManagerSnapshot> {
    return this.#artifactOperation(
      "delete",
      request.kind,
      request.name,
      async () => {
        const snapshot = await this.#assertRevision(request.expectedRevision);
        const paths = await this.#paths(request.location, snapshot);
        await deleteArtifact({
          kind: request.kind,
          directory:
            request.kind === "agent"
              ? paths.agentsDirectory
              : paths.skillsDirectory,
          name: request.name,
        });
        await this.#refreshIfActive(request.location);
        return this.get(snapshot.selectedProfile);
      },
    );
  }

  public async setArtifactDisabled(
    request: Parameters<ProfileManagerActions["setArtifactDisabled"]>[0],
  ): Promise<DesktopProfileManagerSnapshot> {
    return this.#artifactOperation(
      request.disabled ? "disable" : "restore",
      request.kind,
      request.name,
      async () => {
        const snapshot = await this.#assertRevision(request.expectedRevision);
        const paths = await this.#paths(request.location, snapshot);
        const tombstonePath =
          request.kind === "agent"
            ? paths.agentTombstonesPath
            : paths.skillTombstonesPath;
        const tombstones = await readArtifactTombstones(tombstonePath);
        if (request.disabled) {
          await disableArtifact(
            tombstonePath,
            request.name,
            tombstones.revision,
          );
        } else {
          await restoreArtifact(
            tombstonePath,
            request.name,
            tombstones.revision,
          );
        }
        await this.#refreshIfActive(request.location);
        return this.get(snapshot.selectedProfile);
      },
    );
  }

  async #transferArtifact(
    operation: "copy" | "move",
    request: Parameters<ProfileManagerActions["copyArtifact"]>[0],
  ): Promise<DesktopArtifactMutationResult> {
    return this.#artifactOperation(
      operation,
      request.kind,
      request.name,
      async () => {
        const snapshot = await this.#assertRevision(request.expectedRevision);
        const source = await this.#paths(request.source, snapshot);
        const destination = await this.#paths(request.destination, snapshot);
        const sourceDirectory =
          request.kind === "agent"
            ? source.agentsDirectory
            : source.skillsDirectory;
        const destinationDirectory =
          request.kind === "agent"
            ? destination.agentsDirectory
            : destination.skillsDirectory;
        const existing = await physicalArtifact(
          request.kind,
          destination,
          request.name,
        );
        const sourcePath = await physicalArtifact(
          request.kind,
          source,
          request.name,
          request.source.scope !== "bundled",
        );
        if (sourcePath === undefined) {
          throw new Error(`Artifact '${request.name}' does not exist`);
        }
        if (
          existing !== undefined &&
          request.conflictResolution === undefined
        ) {
          const comparison = await compareArtifacts({
            kind: request.kind,
            leftPath: sourcePath,
            rightPath: existing,
          });
          const sourceArtifact = snapshot.artifacts.find(
            (artifact) =>
              artifact.kind === request.kind &&
              artifact.name === request.name &&
              artifact.origin === request.source.scope,
          );
          const destinationArtifact = snapshot.artifacts.find(
            (artifact) =>
              artifact.kind === request.kind &&
              artifact.name === request.name &&
              artifact.scope === request.destination.scope,
          );
          const conflict: DesktopArtifactConflict = {
            kind: request.kind,
            name: request.name,
            sourceFingerprint: comparison.leftFingerprint,
            destinationFingerprint: comparison.rightFingerprint,
            sourceDescription: sourceDescription(
              sourceArtifact,
              `${request.source.scope} ${request.kind}`,
            ),
            destinationDescription: sourceDescription(
              destinationArtifact,
              `${request.destination.scope} ${request.kind}`,
            ),
            suggestedName: `${request.name}-copy`,
          };
          return { status: "conflict", conflict };
        }

        const transferName =
          request.conflictResolution === "rename"
            ? request.renamedName
            : request.name;
        if (transferName === undefined) {
          throw new Error("A renamed artifact requires a replacement name");
        }
        let backup: string | undefined;
        if (
          existing !== undefined &&
          request.conflictResolution === "replace"
        ) {
          backup = `${existing}.${randomUUID()}.backup`;
          await rename(existing, backup);
        }
        const temporaryRoot =
          request.conflictResolution === "rename"
            ? join(dirname(destinationDirectory), `.artifact-${randomUUID()}`)
            : undefined;
        try {
          let preparedSourceDirectory = sourceDirectory;
          if (temporaryRoot !== undefined) {
            const temporaryAgents = join(temporaryRoot, "agents");
            const temporarySkills = join(temporaryRoot, "skills");
            await Promise.all([
              mkdir(temporaryAgents, { recursive: true, mode: 0o700 }),
              mkdir(temporarySkills, { recursive: true, mode: 0o700 }),
            ]);
            await copyArtifact({
              kind: request.kind,
              name: request.name,
              sourceDirectory,
              destinationDirectory:
                request.kind === "agent" ? temporaryAgents : temporarySkills,
            });
            if (request.kind === "agent") {
              await renameAgentInScope({
                agentsDirectory: temporaryAgents,
                currentName: request.name,
                replacementName: transferName,
              });
            } else {
              await renameSkillInScope({
                agentsDirectory: temporaryAgents,
                skillsDirectory: temporarySkills,
                currentName: request.name,
                replacementName: transferName,
              });
            }
            preparedSourceDirectory =
              request.kind === "agent" ? temporaryAgents : temporarySkills;
          }
          const transfer = operation === "copy" ? copyArtifact : moveArtifact;
          await transfer({
            kind: request.kind,
            name: transferName,
            sourceDirectory: preparedSourceDirectory,
            destinationDirectory,
          });
          if (operation === "move" && request.conflictResolution === "rename") {
            await deleteArtifact({
              kind: request.kind,
              directory: sourceDirectory,
              name: request.name,
            });
          }
          if (backup !== undefined) {
            await rm(backup, {
              recursive: request.kind === "skill",
              force: true,
            });
          }
        } catch (error) {
          if (backup !== undefined) {
            await rm(existing!, {
              recursive: request.kind === "skill",
              force: true,
            });
            await rename(backup, existing!);
          }
          throw error;
        } finally {
          if (temporaryRoot !== undefined) {
            await rm(temporaryRoot, { recursive: true, force: true });
          }
        }
        await this.#refreshIfActive(request.destination);
        if (operation === "move") await this.#refreshIfActive(request.source);
        return {
          status: "completed",
          snapshot: await this.get(snapshot.selectedProfile),
        };
      },
    );
  }

  async #snapshot(
    registry: ProfileRegistry,
    selectedProfile: string,
  ): Promise<DesktopProfileManagerSnapshot> {
    const selectedLayout = resolveLiveAgentStorage({
      environment: { LIVE_AGENT_HOME: this.options.rootLayout.root },
      profile: selectedProfile,
    });
    await ensureLiveAgentStorage(selectedLayout);
    const system = resolveArtifactScopePaths(selectedLayout, "system");
    const profile = resolveArtifactScopePaths(selectedLayout, "profile");
    const activeProfile = this.options.getActiveProfile();
    const currentActiveSessionId = await this.options.getActiveSessionId();
    const activeSessionId =
      selectedProfile === activeProfile ? currentActiveSessionId : undefined;
    await Promise.all([system, profile].map(ensureScope));
    const selectedSessions = await readSessions(selectedLayout);
    const bundled = {
      agentsDirectory: this.options.bundledAgentsDirectory,
      skillsDirectory: this.options.bundledSkillsDirectory,
    };
    const systemCatalog = await loadLayeredAgentCatalog({
      bundled,
      system: layer(system),
      availableTools,
    });
    const profileCatalog = await loadLayeredAgentCatalog({
      bundled,
      system: layer(system),
      profile: layer(profile),
      availableTools,
    });
    const sessionArtifacts = (
      await Promise.all(
        selectedSessions.map(async ({ id }) => {
          const session = resolveArtifactScopePaths(
            selectedLayout,
            "session",
            id,
          );
          const catalog = await loadLayeredAgentCatalog({
            bundled,
            system: layer(system),
            profile: layer(profile),
            session: layer(session),
            availableTools,
          });
          const artifacts = catalogArtifacts(
            "session",
            catalog,
            { profile: selectedProfile, sessionId: id },
            false,
          );
          await this.#appendDisabledArtifacts(
            artifacts,
            "session",
            session,
            profileCatalog,
            { profile: selectedProfile, sessionId: id },
          );
          return artifacts;
        }),
      )
    ).flat();
    const artifacts = [
      ...catalogArtifacts("system", systemCatalog, {}, true),
      ...catalogArtifacts(
        "profile",
        profileCatalog,
        { profile: selectedProfile },
        false,
      ),
      ...sessionArtifacts,
    ];
    await this.#appendDisabledArtifacts(
      artifacts,
      "system",
      system,
      await loadLayeredAgentCatalog({ bundled, availableTools }),
    );
    await this.#appendDisabledArtifacts(
      artifacts,
      "profile",
      profile,
      systemCatalog,
      { profile: selectedProfile },
    );
    const profiles = await Promise.all(
      registry.profiles.map(async ({ name }) => {
        const sessions = await readSessions(
          resolveLiveAgentStorage({
            environment: { LIVE_AGENT_HOME: this.options.rootLayout.root },
            profile: name,
          }),
        );
        return {
          name,
          active: name === activeProfile,
          reserved: false,
          sessionCount: sessions.length,
          sessions: sessions.map(({ id, title }) => ({
            id,
            title,
            active: name === activeProfile && id === currentActiveSessionId,
          })),
        };
      }),
    );
    const revision = fingerprint({
      registryRevision: registry.revision,
      activeProfile,
      selectedProfile,
      activeSessionId,
      artifacts: artifacts.map((artifact) => ({
        scope: artifact.scope,
        kind: artifact.kind,
        name: artifact.name,
        state: artifact.state,
        origin: artifact.origin,
        fingerprint: artifact.fingerprint,
      })),
    });
    return desktopProfileManagerSnapshotSchema.parse({
      revision,
      activeProfile,
      selectedProfile,
      ...(activeSessionId === undefined ? {} : { activeSessionId }),
      ...(this.options.environmentProfileOverride === undefined
        ? {}
        : {
            switchingDisabledReason:
              "Profile switching is disabled because LIVE_AGENT_PROFILE is set.",
          }),
      profiles,
      artifacts,
    });
  }

  async #appendDisabledArtifacts(
    artifacts: DesktopScopedArtifact[],
    scope: DesktopArtifactScope,
    paths: ArtifactScopePaths,
    upstream: LayeredAgentCatalog,
    owner: { profile?: string; sessionId?: string } = {},
  ): Promise<void> {
    for (const kind of ["agent", "skill"] as const) {
      const tombstones = await readArtifactTombstones(
        kind === "agent"
          ? paths.agentTombstonesPath
          : paths.skillTombstonesPath,
      );
      const entries = kind === "agent" ? upstream.agents : upstream.skills;
      for (const name of tombstones.names) {
        const entry = entries.find(
          (candidate) => artifactName(kind, candidate) === name,
        );
        artifacts.push({
          kind,
          name,
          description:
            entry === undefined ? "" : artifactDescription(kind, entry),
          scope,
          origin: entry?.origin ?? "bundled",
          state: "disabled",
          sourceFile:
            entry === undefined ? name : artifactSourceFile(kind, entry),
          ...owner,
          ...(entry === undefined
            ? { overriddenOrigins: [] }
            : {
                fingerprint: entry.fingerprint,
                overriddenOrigins: [...entry.overrides],
              }),
          diagnostics: [],
        });
      }
    }
  }

  async #paths(
    location: DesktopArtifactLocation,
    snapshot: DesktopProfileManagerSnapshot,
  ): Promise<ArtifactScopePaths> {
    if (location.scope === "bundled") {
      return {
        scope: "system",
        root: dirname(this.options.bundledAgentsDirectory),
        agentsDirectory: this.options.bundledAgentsDirectory,
        skillsDirectory: this.options.bundledSkillsDirectory,
        stateDirectory: dirname(this.options.bundledAgentsDirectory),
        agentTombstonesPath: join(
          dirname(this.options.bundledAgentsDirectory),
          ".no-agent-tombstones.json",
        ),
        skillTombstonesPath: join(
          dirname(this.options.bundledSkillsDirectory),
          ".no-skill-tombstones.json",
        ),
      };
    }
    const profile = location.profile ?? snapshot.selectedProfile;
    const layout = resolveLiveAgentStorage({
      environment: { LIVE_AGENT_HOME: this.options.rootLayout.root },
      profile,
    });
    await ensureLiveAgentStorage(layout);
    if (location.scope === "session") {
      if (
        location.sessionId === undefined ||
        profile !== this.options.getActiveProfile() ||
        location.sessionId !== (await this.options.getActiveSessionId())
      ) {
        throw new Error(
          "Session Scope is available only for the active session",
        );
      }
      const paths = resolveArtifactScopePaths(
        layout,
        "session",
        location.sessionId,
      );
      await ensureScope(paths);
      return paths;
    }
    const paths = resolveArtifactScopePaths(layout, location.scope);
    await ensureScope(paths);
    return paths;
  }

  async #refreshIfActive(location: DesktopArtifactLocation): Promise<void> {
    if (
      location.scope === "system" ||
      location.profile === this.options.getActiveProfile()
    ) {
      await this.options.refreshActiveCatalog();
    }
  }

  async #assertRevision(
    expectedRevision: string,
    selectedProfile?: string,
  ): Promise<DesktopProfileManagerSnapshot> {
    const snapshot = await this.get(selectedProfile);
    if (snapshot.revision !== expectedRevision) {
      throw new Error("Profile Manager changed; refresh before trying again");
    }
    return snapshot;
  }

  async #registryRevision(
    snapshot: DesktopProfileManagerSnapshot,
  ): Promise<number> {
    await this.#assertSnapshotUnchanged(snapshot);
    return (await loadProfileRegistry(this.options.rootLayout)).revision;
  }

  async #assertSnapshotUnchanged(
    snapshot: DesktopProfileManagerSnapshot,
  ): Promise<void> {
    const current = await this.get(snapshot.selectedProfile);
    if (current.revision !== snapshot.revision) {
      throw new Error("Profile Manager changed; refresh before trying again");
    }
  }

  async #profileOperation<T>(
    operation: string,
    attributes: Readonly<Record<string, string>>,
    action: () => Promise<T>,
  ): Promise<T> {
    return this.#operation(`profile.${operation}`, attributes, action);
  }

  async #artifactOperation<T>(
    operation: string,
    kind: DesktopArtifactKind,
    name: string,
    action: () => Promise<T>,
  ): Promise<T> {
    return this.#operation(
      `profile.artifact-${operation}`,
      { artifact_kind: kind, artifact_name: name },
      action,
    );
  }

  async #operation<T>(
    name: string,
    attributes: Readonly<Record<string, string>>,
    action: () => Promise<T>,
  ): Promise<T> {
    const startedAt = Date.now();
    const traceId = randomUUID();
    const correlationId = randomUUID();
    const rootSpanId = randomUUID();
    const queuedId = this.#record(
      `${name}.queued`,
      traceId,
      rootSpanId,
      correlationId,
      {
        ...attributes,
        active_profile: this.options.getActiveProfile(),
      },
    );
    const startedSpanId = randomUUID();
    const startedId = this.#record(
      `${name}.started`,
      traceId,
      startedSpanId,
      correlationId,
      attributes,
      rootSpanId,
      undefined,
      undefined,
      queuedId,
    );
    try {
      const progressId = this.#record(
        `${name}.progress`,
        traceId,
        randomUUID(),
        correlationId,
        { ...attributes, phase: "validating" },
        startedSpanId,
        undefined,
        undefined,
        startedId,
      );
      const result = await action();
      if (
        typeof result === "object" &&
        result !== null &&
        "status" in result &&
        result.status === "conflict"
      ) {
        this.#record(
          `${name}.cancelled`,
          traceId,
          randomUUID(),
          correlationId,
          { ...attributes, reason: "destination-conflict" },
          startedSpanId,
          "cancelled",
          Date.now() - startedAt,
          progressId,
        );
        return result;
      }
      this.#record(
        `${name}.completed`,
        traceId,
        randomUUID(),
        correlationId,
        attributes,
        startedSpanId,
        "success",
        Date.now() - startedAt,
        progressId,
      );
      return result;
    } catch (error) {
      this.#record(
        `${name}.${error instanceof ProfileOperationCancelledError ? "cancelled" : "failed"}`,
        traceId,
        randomUUID(),
        correlationId,
        {
          ...attributes,
          error:
            error instanceof Error
              ? error.message.slice(0, 512)
              : String(error).slice(0, 512),
        },
        startedSpanId,
        error instanceof ProfileOperationCancelledError
          ? "cancelled"
          : "failure",
        Date.now() - startedAt,
        startedId,
      );
      throw error;
    }
  }

  #record(
    name: string,
    traceId: string,
    spanId: string,
    correlationId: string,
    attributes: Readonly<Record<string, string | number | boolean>>,
    parentSpanId?: string,
    outcome?: "success" | "failure" | "cancelled",
    durationMs?: number,
    causationId?: string,
  ): string {
    const id = randomUUID();
    this.options.telemetry?.({
      version: 1,
      id,
      occurredAt: new Date().toISOString(),
      name,
      category: "storage",
      source: "desktop-profile-manager",
      level: outcome === "failure" ? "error" : "info",
      ...(outcome === undefined ? {} : { outcome }),
      ...(durationMs === undefined ? {} : { durationMs }),
      correlationId,
      ...(causationId === undefined ? {} : { causationId }),
      trace: {
        traceId,
        spanId,
        ...(parentSpanId === undefined ? {} : { parentSpanId }),
      },
      attributes,
    });
    return id;
  }
}
