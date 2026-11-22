import { createHash } from "node:crypto";

import { basename, join } from "node:path";
import { readFile } from "node:fs/promises";

import {
  loadAgentCatalog,
  loadLayeredAgentCatalog,
  MEMORY_SCOPE_ORDER,
  publishMemoryChanges,
  publishSkillToScope,
  readMemoryScope,
  type AgentCatalog,
  type LayeredAgentCatalog,
  type ToolOperationPatternEntry,
} from "@ableton-agent/agent-config";
import type {
  AgentSkillDescriptor,
  ArtifactAuthoringContext,
  ArtifactAuthoringPort,
  ArtifactPublication,
  ArtifactPublicationResult,
} from "@ableton-agent/application";
import {
  ensureArtifactScopeDirectories,
  resolveArtifactScopePaths,
  resolveMemoryScopeDirectory,
  type LiveAgentStorageLayout,
  type SessionStorageOwnershipContext,
} from "@ableton-agent/storage";

import {
  desktopAgentCatalogSchema,
  type DesktopAgentCatalog,
} from "../contracts.js";

export interface AgentCatalogOptions {
  readonly agentsDirectory: string;
  readonly skillsDirectory: string;
  readonly availableTools: readonly string[];
  readonly availableOperations?: readonly ToolOperationPatternEntry[];
  readonly compatibilityAliases?: Readonly<Record<string, string>>;
  readonly wildcardExcludedTools?: readonly string[];
  readonly storage?: LiveAgentStorageLayout;
  readonly resolveSessionOwnership?: (
    sessionId: string,
  ) => Promise<SessionStorageOwnershipContext | undefined>;
}

export function toDesktopCatalog(
  catalog: AgentCatalog,
  sessionId?: string,
): DesktopAgentCatalog {
  const value = {
    ...(sessionId === undefined ? {} : { sessionId }),
    definitions: catalog.agents.map((agent) => ({
      version: agent.definition.version,
      name: agent.definition.name,
      label: agent.definition.label,
      description: agent.definition.description,
      systemPrompt: agent.definition.systemPrompt,
      tools: agent.definition.tools,
      resolvedTools: agent.resolvedTools,
      resolvedOperations: agent.resolvedOperations,
      explicitCompatibilityAliases: agent.explicitCompatibilityAliases,
      editScope: agent.definition.editScope,
      skills: agent.definition.skills,
      inputChannels: agent.definition.inputChannels,
      model: agent.definition.model,
      reasoningEffort: agent.definition.reasoningEffort,
      autoApprove: agent.definition.autoApprove,
      eventListeners: agent.definition.eventListeners,
      origin: "origin" in agent ? agent.origin : "bundled",
      inherited: "inherited" in agent ? agent.inherited : false,
      overrides: "overrides" in agent ? agent.overrides : [],
      sourceFile: basename(agent.sourcePath),
      fingerprint: agent.fingerprint,
    })),
    skills: catalog.skills.map((skill) => ({
      name: skill.metadata.name,
      description: skill.metadata.description,
      ...(skill.metadata["argument-hint"] === undefined
        ? {}
        : { argumentHint: skill.metadata["argument-hint"] }),
      origin: "origin" in skill ? skill.origin : "bundled",
      inherited: "inherited" in skill ? skill.inherited : false,
      overrides: "overrides" in skill ? skill.overrides : [],
      sourceFile: `${basename(skill.directory)}/SKILL.md`,
      fingerprint: skill.fingerprint,
    })),
    diagnostics: catalog.diagnostics.map((diagnostic) => ({
      sourceFile: basename(diagnostic.sourcePath),
      code: diagnostic.code,
      message: diagnostic.message,
    })),
  };
  return desktopAgentCatalogSchema.parse({
    ...value,
    revision: createHash("sha256").update(JSON.stringify(value)).digest("hex"),
  });
}

export class AgentCatalogService {
  #catalog: DesktopAgentCatalog = desktopAgentCatalogSchema.parse({});
  #runtimeSkills: AgentSkillDescriptor[] = [];

  public constructor(private readonly options: AgentCatalogOptions) {}

  public get current(): DesktopAgentCatalog {
    return this.#catalog;
  }

  public get runtimeSkills(): readonly AgentSkillDescriptor[] {
    return this.#runtimeSkills;
  }

  public async refresh(sessionId?: string): Promise<DesktopAgentCatalog> {
    const loaded =
      this.options.storage === undefined
        ? await loadAgentCatalog({
            agentsDirectory: this.options.agentsDirectory,
            skillsDirectory: this.options.skillsDirectory,
            availableTools: this.options.availableTools,
            ...(this.options.availableOperations === undefined
              ? {}
              : { availableOperations: this.options.availableOperations }),
            ...(this.options.compatibilityAliases === undefined
              ? {}
              : { compatibilityAliases: this.options.compatibilityAliases }),
            ...(this.options.wildcardExcludedTools === undefined
              ? {}
              : {
                  wildcardExcludedTools: this.options.wildcardExcludedTools,
                }),
          })
        : await this.#loadScopedCatalog(sessionId);
    this.#runtimeSkills = loaded.skills.map((skill) => ({
      name: skill.metadata.name,
      description: skill.metadata.description,
      sourcePath: skill.sourcePath,
      fingerprint: skill.fingerprint,
    }));
    this.#catalog = toDesktopCatalog(loaded, sessionId);
    return this.#catalog;
  }

  public refreshForSession(sessionId?: string): Promise<DesktopAgentCatalog> {
    return this.refresh(sessionId);
  }

  public async resolveRuntimeSkill(
    sessionId: string | undefined,
    name: string,
  ): Promise<AgentSkillDescriptor | undefined> {
    const loaded =
      this.options.storage === undefined
        ? await loadAgentCatalog({
            agentsDirectory: this.options.agentsDirectory,
            skillsDirectory: this.options.skillsDirectory,
            availableTools: this.options.availableTools,
            ...(this.options.availableOperations === undefined
              ? {}
              : { availableOperations: this.options.availableOperations }),
            ...(this.options.compatibilityAliases === undefined
              ? {}
              : { compatibilityAliases: this.options.compatibilityAliases }),
            ...(this.options.wildcardExcludedTools === undefined
              ? {}
              : {
                  wildcardExcludedTools: this.options.wildcardExcludedTools,
                }),
          })
        : await this.#loadScopedCatalog(sessionId);
    const skill = loaded.skills.find(({ metadata }) => metadata.name === name);
    return skill === undefined
      ? undefined
      : {
          name: skill.metadata.name,
          description: skill.metadata.description,
          sourcePath: skill.sourcePath,
          fingerprint: skill.fingerprint,
        };
  }

  /** Memory and skill storage for reviewed agent drafts. */
  public get artifactAuthoring(): ArtifactAuthoringPort | undefined {
    if (this.options.storage === undefined) return undefined;
    return {
      loadContext: (sessionId) => this.#authoringContext(sessionId),
      publish: (sessionId, publication) =>
        this.#publishArtifact(sessionId, publication),
    };
  }

  async #ownership(
    sessionId: string,
  ): Promise<SessionStorageOwnershipContext | undefined> {
    return this.options.resolveSessionOwnership?.(sessionId);
  }

  #unavailableReason(
    scope: (typeof MEMORY_SCOPE_ORDER)[number],
    ownership: SessionStorageOwnershipContext | undefined,
  ): string | undefined {
    if (scope === "system" || scope === "profile") return undefined;
    if (ownership === undefined) {
      return "this production session is not saved to a Live Set yet";
    }
    if (scope === "project" && ownership.liveProjectId === undefined) {
      return "the Live Set is not in a verified Live Project";
    }
    return undefined;
  }

  async #authoringContext(
    sessionId: string,
  ): Promise<ArtifactAuthoringContext> {
    const storage = this.options.storage!;
    const ownership = await this.#ownership(sessionId);
    const memory = await Promise.all(
      MEMORY_SCOPE_ORDER.map(async (scope) => {
        const unavailableReason = this.#unavailableReason(scope, ownership);
        if (unavailableReason !== undefined) {
          return { scope, available: false, unavailableReason, topics: [] };
        }
        const contents = await readMemoryScope(
          resolveMemoryScopeDirectory(storage, scope, ownership),
        );
        return { scope, available: true, topics: contents.topics };
      }),
    );
    const catalog = await this.#loadScopedCatalog(sessionId);
    const skills = await Promise.all(
      catalog.skills.map(async (skill) => ({
        name: skill.metadata.name,
        description: skill.metadata.description,
        origin: skill.origin,
        content: await readFile(skill.sourcePath, "utf8"),
        fingerprint: skill.fingerprint,
      })),
    );
    return {
      memory,
      skillScopes: MEMORY_SCOPE_ORDER.filter(
        (scope) => scope !== "live-set",
      ).map((scope) => {
        const unavailableReason = this.#unavailableReason(scope, ownership);
        return unavailableReason === undefined
          ? { scope, available: true }
          : { scope, available: false, unavailableReason };
      }),
      skills,
    };
  }

  async #publishArtifact(
    sessionId: string,
    publication: ArtifactPublication,
  ): Promise<ArtifactPublicationResult> {
    const storage = this.options.storage!;
    const ownership = await this.#ownership(sessionId);
    if (publication.kind === "memory") {
      const published = await publishMemoryChanges(
        publication.scopes.map((change) => ({
          ...change,
          directory: resolveMemoryScopeDirectory(
            storage,
            change.scope,
            ownership,
          ),
        })),
      );
      return {
        published: published.flatMap((scope) => {
          const change = publication.scopes.find(
            (candidate) => candidate.scope === scope.scope,
          )!;
          return [
            ...change.writes.map((write) => ({
              scope: scope.scope,
              path: join(scope.directory, `${write.name}.md`),
              change:
                write.baseFingerprint === null
                  ? ("added" as const)
                  : ("modified" as const),
            })),
            ...change.deletes.map((removed) => ({
              scope: scope.scope,
              path: join(scope.directory, `${removed.name}.md`),
              change: "deleted" as const,
            })),
          ];
        }),
      };
    }
    const reason = this.#unavailableReason(publication.scope, ownership);
    if (reason !== undefined) {
      throw new Error(`Cannot publish a ${publication.scope} skill: ${reason}`);
    }
    const paths =
      publication.scope === "system" || publication.scope === "profile"
        ? resolveArtifactScopePaths(storage, publication.scope)
        : publication.scope === "project"
          ? resolveArtifactScopePaths(storage, "project", {
              liveProjectId: ownership!.liveProjectId!,
            })
          : resolveArtifactScopePaths(storage, "session", ownership!);
    await ensureArtifactScopeDirectories(paths);
    const load = () => this.#loadScopedCatalog(sessionId);
    const current = (await load()).skills.find(
      ({ metadata }) => metadata.name === publication.name,
    );
    if ((current?.fingerprint ?? null) !== publication.baseFingerprint) {
      throw new Error(
        `Skill '${publication.name}' changed since the draft was made; re-read it and resubmit`,
      );
    }
    const saved = await publishSkillToScope({
      scope: publication.scope,
      skillsDirectory: paths.skillsDirectory,
      metadata: {
        name: publication.name,
        description: publication.description,
      },
      body: publication.body,
      loadCatalog: load,
    });
    return {
      published: [
        {
          scope: publication.scope,
          path: saved.sourcePath,
          change: current?.origin === publication.scope ? "modified" : "added",
        },
      ],
    };
  }

  async #loadScopedCatalog(sessionId?: string): Promise<LayeredAgentCatalog> {
    const storage = this.options.storage!;
    const system = resolveArtifactScopePaths(storage, "system");
    const profile = resolveArtifactScopePaths(storage, "profile");
    const ownership =
      sessionId === undefined
        ? undefined
        : await this.options.resolveSessionOwnership?.(sessionId);
    const project =
      ownership?.liveProjectId === undefined
        ? undefined
        : resolveArtifactScopePaths(storage, "project", {
            liveProjectId: ownership.liveProjectId,
          });
    const session =
      ownership === undefined
        ? undefined
        : resolveArtifactScopePaths(storage, "session", ownership);
    return loadLayeredAgentCatalog({
      bundled: {
        agentsDirectory: this.options.agentsDirectory,
        skillsDirectory: this.options.skillsDirectory,
      },
      system: {
        agentsDirectory: system.agentsDirectory,
        skillsDirectory: system.skillsDirectory,
        agentTombstones: system.agentTombstonesPath,
        skillTombstones: system.skillTombstonesPath,
      },
      profile: {
        agentsDirectory: profile.agentsDirectory,
        skillsDirectory: profile.skillsDirectory,
        agentTombstones: profile.agentTombstonesPath,
        skillTombstones: profile.skillTombstonesPath,
      },
      ...(project === undefined
        ? {}
        : {
            project: {
              agentsDirectory: project.agentsDirectory,
              skillsDirectory: project.skillsDirectory,
              agentTombstones: project.agentTombstonesPath,
              skillTombstones: project.skillTombstonesPath,
            },
          }),
      ...(session === undefined
        ? {}
        : {
            session: {
              agentsDirectory: session.agentsDirectory,
              skillsDirectory: session.skillsDirectory,
              agentTombstones: session.agentTombstonesPath,
              skillTombstones: session.skillTombstonesPath,
            },
          }),
      availableTools: this.options.availableTools,
      ...(this.options.availableOperations === undefined
        ? {}
        : { availableOperations: this.options.availableOperations }),
      ...(this.options.compatibilityAliases === undefined
        ? {}
        : { compatibilityAliases: this.options.compatibilityAliases }),
      ...(this.options.wildcardExcludedTools === undefined
        ? {}
        : { wildcardExcludedTools: this.options.wildcardExcludedTools }),
    });
  }
}
