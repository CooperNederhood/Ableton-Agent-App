import { createHash } from "node:crypto";
import { basename } from "node:path";

import {
  loadAgentCatalog,
  loadLayeredAgentCatalog,
  type AgentCatalog,
} from "@ableton-agent/agent-config";
import type { AgentSkillDescriptor } from "@ableton-agent/application";
import {
  resolveArtifactScopePaths,
  type LiveAgentStorageLayout,
} from "@ableton-agent/storage";

import {
  desktopAgentCatalogSchema,
  type DesktopAgentCatalog,
} from "../contracts.js";

export interface AgentCatalogOptions {
  readonly agentsDirectory: string;
  readonly skillsDirectory: string;
  readonly availableTools: readonly string[];
  readonly storage?: LiveAgentStorageLayout;
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

  async #loadScopedCatalog(sessionId?: string): Promise<AgentCatalog> {
    const storage = this.options.storage!;
    const system = resolveArtifactScopePaths(storage, "system");
    const profile = resolveArtifactScopePaths(storage, "profile");
    const session =
      sessionId === undefined
        ? undefined
        : resolveArtifactScopePaths(storage, "session", sessionId);
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
    });
  }
}
