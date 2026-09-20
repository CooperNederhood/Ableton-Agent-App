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
  replaceSkillInScope,
  readArtifactTombstones,
  readSkillDocument,
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
  readLiveProjectsRegistry,
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
  type DesktopSkillDocument,
} from "../contracts.js";
import type { ProfileManagerActions } from "./ipc.js";
import { JsonLiveSetSessionStore } from "./live-set-session-store.js";

const availableTools = [
  ...abletonToolMetadata.map((tool) => tool.name),
  ...APPLICATION_TOOL_NAMES,
  ...APPROVED_BUILTIN_TOOL_NAMES,
];
const maximumSessionsFileBytes = 4 * 1024 * 1024;

type TelemetryWriter = (event: {
  version: 2;
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
  readonly getActiveSession: () => Promise<DesktopSession | undefined>;
  readonly persistActiveSession: () => Promise<DesktopSession>;
  readonly closeActiveSession: () => Promise<void>;
  readonly refreshActiveCatalog: () => Promise<DesktopAgentCatalog>;
  readonly switchProfile: (profile: string) => Promise<void>;
  readonly telemetry?: TelemetryWriter;
}

class ProfileOperationCancelledError extends Error {}

type OperationProgress = (
  phase: string,
  attributes?: Readonly<Record<string, string>>,
) => void;

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
  owner: {
    profile?: string;
    liveProjectId?: string;
    liveSetId?: string;
    sessionId?: string;
  } = {},
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

function sessionSummaries(
  sessions: readonly DesktopSession[],
  activeProfile: boolean,
  activeSessionId: string | undefined,
  persistedSessionIds: ReadonlySet<string>,
  canonicalSessionIds: ReadonlySet<string>,
) {
  const ordered = [...sessions].sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      left.id.localeCompare(right.id),
  );
  const counts = new Map<string, number>();
  for (const session of ordered) {
    counts.set(session.liveSetId, (counts.get(session.liveSetId) ?? 0) + 1);
  }
  const positions = new Map<string, number>();
  return ordered.map((session) => {
    const position = (positions.get(session.liveSetId) ?? 0) + 1;
    positions.set(session.liveSetId, position);
    const multiple = (counts.get(session.liveSetId) ?? 0) > 1;
    return {
      id: session.id,
      title: multiple
        ? `${session.liveSetName}-${position}`
        : session.liveSetName,
      liveSetId: session.liveSetId,
      liveSetName: session.liveSetName,
      ...(session.liveProjectId === undefined
        ? {}
        : { liveProjectId: session.liveProjectId }),
      ...(session.liveProjectName === undefined
        ? {}
        : { liveProjectName: session.liveProjectName }),
      createdAt: session.createdAt,
      active: activeProfile && session.id === activeSessionId,
      canonical: canonicalSessionIds.has(session.id),
      persisted: persistedSessionIds.has(session.id),
    };
  });
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
          snapshot = await this.get(activeProfile);
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
        const sessionOwnership = {
          liveSetId: session.liveSetId,
          ...(session.liveProjectId === undefined
            ? {}
            : { liveProjectId: session.liveProjectId }),
          sessionId,
        };
        const sessionPaths = resolveArtifactScopePaths(
          selectedLayout,
          "session",
          sessionOwnership,
        );
        await ensureScope(sessionPaths);
        const bundled = {
          agentsDirectory: this.options.bundledAgentsDirectory,
          skillsDirectory: this.options.bundledSkillsDirectory,
        };
        const system = resolveArtifactScopePaths(selectedLayout, "system");
        const profile = resolveArtifactScopePaths(selectedLayout, "profile");
        const project =
          session.liveProjectId === undefined
            ? undefined
            : resolveArtifactScopePaths(selectedLayout, "project", {
                liveProjectId: session.liveProjectId,
              });
        const load = () =>
          loadLayeredAgentCatalog({
            bundled,
            system: layer(system),
            profile: layer(profile),
            ...(project === undefined ? {} : { project: layer(project) }),
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

  public async readSkill({
    name,
  }: Parameters<
    ProfileManagerActions["readSkill"]
  >[0]): Promise<DesktopSkillDocument> {
    return this.#artifactOperation("read", "skill", name, async () => {
      const snapshot = await this.get(this.options.getActiveProfile());
      const catalog = await this.#loadCatalog(
        snapshot.activeProfile,
        snapshot.activeSessionId,
      );
      const skill = catalog.skills.find(
        ({ metadata }) => metadata.name === name,
      );
      if (skill === undefined)
        throw new Error(`Skill '${name}' does not exist`);
      const document = await readSkillDocument(skill.sourcePath, name);
      return {
        name: document.metadata.name,
        description: document.metadata.description,
        body: document.body,
        origin: skill.origin,
        fingerprint: document.fingerprint,
      };
    });
  }

  public createSkill(
    request: Parameters<ProfileManagerActions["createSkill"]>[0],
  ): ReturnType<ProfileManagerActions["createSkill"]> {
    return this.#publishSkill(request, true);
  }

  public saveSkill(
    request: Parameters<ProfileManagerActions["saveSkill"]>[0],
  ): ReturnType<ProfileManagerActions["saveSkill"]> {
    return this.#publishSkill(request, false);
  }

  async #publishSkill(
    request:
      | Parameters<ProfileManagerActions["createSkill"]>[0]
      | Parameters<ProfileManagerActions["saveSkill"]>[0],
    creating: boolean,
  ): ReturnType<ProfileManagerActions["saveSkill"]> {
    return this.#artifactOperation(
      creating ? "create-skill" : "save-skill",
      "skill",
      request.name,
      async () => {
        const activeProfile = this.options.getActiveProfile();
        let snapshot: DesktopProfileManagerSnapshot;
        try {
          snapshot = await this.#assertRevision(
            request.expectedRevision,
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
          snapshot = await this.get(activeProfile);
        }
        const sessionPaths = resolveArtifactScopePaths(
          selectedLayout,
          "session",
          {
            liveSetId: session.liveSetId,
            ...(session.liveProjectId === undefined
              ? {}
              : { liveProjectId: session.liveProjectId }),
            sessionId,
          },
        );
        await ensureScope(sessionPaths);
        const load = () => this.#loadCatalog(snapshot.activeProfile, sessionId);
        const current = (await load()).skills.find(
          ({ metadata }) => metadata.name === request.name,
        );
        if (creating) {
          if (current !== undefined) {
            throw new Error(`Skill '${request.name}' already exists`);
          }
        } else {
          if (current === undefined) {
            throw new Error(`Skill '${request.name}' does not exist`);
          }
          const expectedFingerprint =
            "expectedFingerprint" in request
              ? request.expectedFingerprint
              : undefined;
          if (current.fingerprint !== expectedFingerprint) {
            throw new ProfileOperationCancelledError(
              "Skill changed; refresh before trying again",
            );
          }
        }
        try {
          await this.#assertSnapshotUnchanged(snapshot);
        } catch (error) {
          throw new ProfileOperationCancelledError(
            error instanceof Error ? error.message : String(error),
          );
        }
        const metadata = creating
          ? {
              name: request.name,
              description: "description" in request ? request.description : "",
            }
          : current!.metadata;
        let result:
          Awaited<ReturnType<ProfileManagerActions["saveSkill"]>> | undefined;
        try {
          await replaceSkillInScope({
            skillsDirectory: sessionPaths.skillsDirectory,
            metadata,
            body: request.body,
            validatePublishedCatalog: async () => {
              const validated = await load();
              const saved = validated.skills.find(
                ({ metadata: candidate }) => candidate.name === request.name,
              );
              if (
                saved?.origin !== "session" ||
                saved.metadata.description !== metadata.description
              ) {
                throw new Error(
                  `Saved skill '${request.name}' did not resolve from Session Scope (${saved?.origin ?? "missing"}; ${validated.diagnostics
                    .map(({ code, message }) => `${code}: ${message}`)
                    .join("; ")})`,
                );
              }
              const document = await readSkillDocument(
                saved.sourcePath,
                request.name,
              );
              if (document.body !== request.body.trim()) {
                throw new Error(
                  `Saved skill '${request.name}' body did not match`,
                );
              }
              result = {
                document: {
                  name: document.metadata.name,
                  description: document.metadata.description,
                  body: document.body,
                  origin: saved.origin,
                  fingerprint: document.fingerprint,
                },
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
          throw new Error("Skill save did not produce a snapshot");
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
      async (progress) => {
        const snapshot = await this.#assertRevision(request.expectedRevision);
        const source = await this.#paths(request.source, snapshot, "source");
        const destination = await this.#paths(
          request.destination,
          snapshot,
          "destination",
          () =>
            progress("persisting-active-session", {
              destination_session_id: request.destination.sessionId!,
            }),
        );
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
    const activeSessionCandidate = await this.options.getActiveSession();
    const activeSession =
      activeSessionCandidate?.id === currentActiveSessionId
        ? activeSessionCandidate
        : undefined;
    await Promise.all([system, profile].map(ensureScope));
    const persistedSelectedSessions = await readSessions(selectedLayout);
    const persistedSelectedSessionIds = new Set(
      persistedSelectedSessions.map(({ id }) => id),
    );
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
    const selectedProjectRegistry = await readLiveProjectsRegistry(
      selectedLayout.liveProjectsRegistryPath,
    );
    const selectedProjectIds = new Set([
      ...selectedProjectRegistry.projects.map(({ projectId }) => projectId),
      ...persistedSelectedSessions.flatMap(({ liveProjectId }) =>
        liveProjectId === undefined ? [] : [liveProjectId],
      ),
    ]);
    const projectCatalogs = new Map<string, LayeredAgentCatalog>();
    const projectArtifacts = (
      await Promise.all(
        [...selectedProjectIds].map(async (liveProjectId) => {
          const projectPaths = resolveArtifactScopePaths(
            selectedLayout,
            "project",
            { liveProjectId },
          );
          await ensureScope(projectPaths);
          const catalog = await loadLayeredAgentCatalog({
            bundled,
            system: layer(system),
            profile: layer(profile),
            project: layer(projectPaths),
            availableTools,
          });
          projectCatalogs.set(liveProjectId, catalog);
          const artifacts = catalogArtifacts(
            "project",
            catalog,
            { profile: selectedProfile, liveProjectId },
            false,
          );
          await this.#appendDisabledArtifacts(
            artifacts,
            "project",
            projectPaths,
            profileCatalog,
            { profile: selectedProfile, liveProjectId },
          );
          return artifacts;
        }),
      )
    ).flat();
    const sessionArtifacts = (
      await Promise.all(
        persistedSelectedSessions.map(async (storedSession) => {
          const { id } = storedSession;
          const session = resolveArtifactScopePaths(selectedLayout, "session", {
            liveSetId: storedSession.liveSetId,
            ...(storedSession.liveProjectId === undefined
              ? {}
              : { liveProjectId: storedSession.liveProjectId }),
            sessionId: id,
          });
          const project =
            storedSession.liveProjectId === undefined
              ? undefined
              : resolveArtifactScopePaths(selectedLayout, "project", {
                  liveProjectId: storedSession.liveProjectId,
                });
          const catalog = await loadLayeredAgentCatalog({
            bundled,
            system: layer(system),
            profile: layer(profile),
            ...(project === undefined ? {} : { project: layer(project) }),
            session: layer(session),
            availableTools,
          });
          const artifacts = catalogArtifacts(
            "session",
            catalog,
            {
              profile: selectedProfile,
              liveSetId: storedSession.liveSetId,
              ...(storedSession.liveProjectId === undefined
                ? {}
                : { liveProjectId: storedSession.liveProjectId }),
              sessionId: id,
            },
            false,
          );
          await this.#appendDisabledArtifacts(
            artifacts,
            "session",
            session,
            storedSession.liveProjectId === undefined
              ? profileCatalog
              : (projectCatalogs.get(storedSession.liveProjectId) ??
                  profileCatalog),
            {
              profile: selectedProfile,
              liveSetId: storedSession.liveSetId,
              ...(storedSession.liveProjectId === undefined
                ? {}
                : { liveProjectId: storedSession.liveProjectId }),
              sessionId: id,
            },
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
      ...projectArtifacts,
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
        const profileLayout = resolveLiveAgentStorage({
          environment: { LIVE_AGENT_HOME: this.options.rootLayout.root },
          profile: name,
        });
        const persistedSessions = await readSessions(profileLayout);
        const sessions =
          name === activeProfile &&
          activeSession !== undefined &&
          !persistedSessions.some(({ id }) => id === activeSession.id)
            ? [...persistedSessions, activeSession]
            : persistedSessions;
        const persistedSessionIds =
          name === selectedProfile
            ? persistedSelectedSessionIds
            : new Set(persistedSessions.map(({ id }) => id));
        const associations = await new JsonLiveSetSessionStore(
          profileLayout.liveSetSessionsPath,
        ).load(persistedSessions);
        const canonicalSessionIds = new Set(
          associations.map(({ sessionId }) => sessionId),
        );
        const summaries = sessionSummaries(
          sessions,
          name === activeProfile,
          currentActiveSessionId,
          persistedSessionIds,
          canonicalSessionIds,
        );
        const liveSets = new Map<
          string,
          {
            id: string;
            name: string;
            saved: boolean;
            liveProjectId?: string;
            sessions: typeof summaries;
          }
        >();
        for (const summary of summaries) {
          const current = liveSets.get(summary.liveSetId);
          if (current === undefined) {
            liveSets.set(summary.liveSetId, {
              id: summary.liveSetId,
              name: summary.liveSetName,
              saved: summary.liveProjectId !== undefined,
              ...(summary.liveProjectId === undefined
                ? {}
                : { liveProjectId: summary.liveProjectId }),
              sessions: [summary],
            });
          } else {
            current.sessions.push(summary);
          }
        }
        const projectRegistry = await readLiveProjectsRegistry(
          profileLayout.liveProjectsRegistryPath,
        );
        const projectNames = new Map(
          projectRegistry.projects.map(({ projectId, displayName }) => [
            projectId,
            displayName,
          ]),
        );
        for (const summary of summaries) {
          if (
            summary.liveProjectId !== undefined &&
            summary.liveProjectName !== undefined &&
            !projectNames.has(summary.liveProjectId)
          ) {
            projectNames.set(summary.liveProjectId, summary.liveProjectName);
          }
        }
        const liveProjects = [...projectNames]
          .map(([id, projectName]) => ({
            id,
            name: projectName,
            active:
              name === activeProfile &&
              summaries.some(
                (session) => session.active && session.liveProjectId === id,
              ),
            liveSets: [...liveSets.values()]
              .filter(({ liveProjectId }) => liveProjectId === id)
              .map(({ id, name, saved, sessions }) => ({
                id,
                name,
                saved,
                sessions,
              })),
          }))
          .sort((left, right) => left.name.localeCompare(right.name));
        const unassignedLiveSets = [...liveSets.values()]
          .filter(({ liveProjectId }) => liveProjectId === undefined)
          .map(({ id, name, saved, sessions }) => ({
            id,
            name,
            saved,
            sessions,
          }));
        return {
          name,
          active: name === activeProfile,
          reserved: false,
          sessionCount: sessions.length,
          sessions: summaries,
          liveProjects,
          unassignedLiveSets,
        };
      }),
    );
    const revision = fingerprint({
      registryRevision: registry.revision,
      activeProfile,
      selectedProfile,
      activeSessionId,
      sessions: profiles.flatMap(({ name, sessions }) =>
        sessions.map(
          ({ id, persisted, canonical, liveSetId, liveProjectId }) => ({
            profile: name,
            id,
            persisted,
            canonical,
            liveSetId,
            liveProjectId,
          }),
        ),
      ),
      artifacts: artifacts.map((artifact) => ({
        scope: artifact.scope,
        profile: artifact.profile,
        liveProjectId: artifact.liveProjectId,
        liveSetId: artifact.liveSetId,
        sessionId: artifact.sessionId,
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
    owner: {
      profile?: string;
      liveProjectId?: string;
      liveSetId?: string;
      sessionId?: string;
    } = {},
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

  async #loadCatalog(
    profileName: string,
    sessionId?: string,
  ): Promise<LayeredAgentCatalog> {
    const selectedLayout = resolveLiveAgentStorage({
      environment: { LIVE_AGENT_HOME: this.options.rootLayout.root },
      profile: profileName,
    });
    const system = resolveArtifactScopePaths(selectedLayout, "system");
    const profile = resolveArtifactScopePaths(selectedLayout, "profile");
    const persistedSession =
      sessionId === undefined
        ? undefined
        : (await readSessions(selectedLayout)).find(
            ({ id }) => id === sessionId,
          );
    const activeSession =
      sessionId === undefined || persistedSession !== undefined
        ? undefined
        : await this.options.getActiveSession();
    const storedSession =
      persistedSession ??
      (activeSession?.id === sessionId ? activeSession : undefined);
    if (sessionId !== undefined && storedSession === undefined)
      throw new Error(`App session '${sessionId}' is not listed`);
    const project =
      storedSession?.liveProjectId === undefined
        ? undefined
        : resolveArtifactScopePaths(selectedLayout, "project", {
            liveProjectId: storedSession.liveProjectId,
          });
    const session =
      persistedSession === undefined
        ? undefined
        : resolveArtifactScopePaths(selectedLayout, "session", {
            liveSetId: persistedSession.liveSetId,
            ...(persistedSession.liveProjectId === undefined
              ? {}
              : { liveProjectId: persistedSession.liveProjectId }),
            sessionId: persistedSession.id,
          });
    return loadLayeredAgentCatalog({
      bundled: {
        agentsDirectory: this.options.bundledAgentsDirectory,
        skillsDirectory: this.options.bundledSkillsDirectory,
      },
      system: layer(system),
      profile: layer(profile),
      ...(project === undefined ? {} : { project: layer(project) }),
      ...(session === undefined ? {} : { session: layer(session) }),
      availableTools,
    });
  }

  async #paths(
    location: DesktopArtifactLocation,
    snapshot: DesktopProfileManagerSnapshot,
    sessionAccess: "active" | "source" | "destination" = "active",
    onPromote?: () => void,
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
    if (location.scope === "project") {
      if (location.liveProjectId === undefined) {
        throw new Error("Project Scope requires a Live Project");
      }
      const projectExists = snapshot.profiles
        .find(({ name }) => name === profile)
        ?.liveProjects.some(({ id }) => id === location.liveProjectId);
      if (projectExists !== true) {
        throw new Error("Project Scope target is not a listed Live Project");
      }
      const paths = resolveArtifactScopePaths(layout, "project", {
        liveProjectId: location.liveProjectId,
      });
      await ensureScope(paths);
      return paths;
    }
    if (location.scope === "session") {
      if (location.sessionId === undefined) {
        throw new Error("Session Scope requires a session");
      }
      const sessionIsActive =
        profile === snapshot.activeProfile &&
        location.sessionId === snapshot.activeSessionId;
      const session = snapshot.profiles
        .find(({ name }) => name === profile)
        ?.sessions.find(({ id }) => id === location.sessionId);
      const sessionIsPersisted = session?.persisted !== false;
      if (sessionAccess === "active" && !sessionIsActive) {
        throw new Error(
          "Session Scope is available only for the active session",
        );
      }
      if (session === undefined) {
        throw new Error("Session Scope target is not a listed session");
      }
      if (sessionAccess === "source" && !sessionIsPersisted) {
        throw new Error("Session Scope source is not a persisted session");
      }
      if (sessionAccess === "destination" && !sessionIsPersisted) {
        if (!sessionIsActive) {
          throw new Error("Only the active ephemeral session can be promoted");
        }
        onPromote?.();
        const persisted = await this.options.persistActiveSession();
        if (persisted.id !== location.sessionId) {
          throw new Error(
            "The active production session changed during transfer",
          );
        }
      }
      const paths = resolveArtifactScopePaths(layout, "session", {
        liveSetId: session.liveSetId,
        ...(session.liveProjectId === undefined
          ? {}
          : { liveProjectId: session.liveProjectId }),
        sessionId: location.sessionId,
      });
      await ensureScope(paths);
      return paths;
    }
    const paths = resolveArtifactScopePaths(layout, location.scope);
    await ensureScope(paths);
    return paths;
  }

  async #refreshIfActive(location: DesktopArtifactLocation): Promise<void> {
    const activeProfile = this.options.getActiveProfile();
    const profile = location.profile ?? activeProfile;
    const affectsActiveScope =
      location.scope === "system" ||
      (location.scope === "profile" && profile === activeProfile) ||
      (location.scope === "project" &&
        profile === activeProfile &&
        location.liveProjectId !== undefined &&
        location.liveProjectId ===
          (await this.options.getActiveSession())?.liveProjectId) ||
      (location.scope === "session" &&
        profile === activeProfile &&
        location.sessionId === (await this.options.getActiveSessionId()));
    if (affectsActiveScope) {
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
    action: (progress: OperationProgress) => Promise<T>,
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
    action: (progress: OperationProgress) => Promise<T>,
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
      let progressId = startedId;
      const progress: OperationProgress = (phase, progressAttributes = {}) => {
        const nextProgressId = this.#record(
          `${name}.progress`,
          traceId,
          randomUUID(),
          correlationId,
          { ...attributes, ...progressAttributes, phase },
          startedSpanId,
          undefined,
          undefined,
          progressId,
        );
        progressId = nextProgressId;
      };
      progress("validating");
      const result = await action(progress);
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
      version: 2,
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
