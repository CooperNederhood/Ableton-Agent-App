import { basename } from "node:path";

import {
  loadAgentCatalog,
  type AgentCatalog,
} from "@ableton-agent/agent-config";
import type { AgentSkillDescriptor } from "@ableton-agent/application";

import {
  desktopAgentCatalogSchema,
  type DesktopAgentCatalog,
} from "../contracts.js";

export interface AgentCatalogOptions {
  readonly agentsDirectory: string;
  readonly skillsDirectory: string;
  readonly availableTools: readonly string[];
}

function toDesktopCatalog(catalog: AgentCatalog): DesktopAgentCatalog {
  return desktopAgentCatalogSchema.parse({
    definitions: catalog.agents.map((agent) => ({
      name: agent.definition.name,
      description: agent.definition.description,
      systemPrompt: agent.definition.systemPrompt,
      tools: agent.definition.tools,
      resolvedTools: agent.resolvedTools,
      editScope: agent.definition.editScope,
      skills: agent.definition.skills,
      inputChannels: agent.definition.inputChannels,
      sourceFile: basename(agent.sourcePath),
      fingerprint: agent.fingerprint,
    })),
    skills: catalog.skills.map((skill) => ({
      name: skill.metadata.name,
      description: skill.metadata.description,
      sourceFile: `${basename(skill.directory)}/SKILL.md`,
      fingerprint: skill.fingerprint,
    })),
    diagnostics: catalog.diagnostics.map((diagnostic) => ({
      sourceFile: basename(diagnostic.sourcePath),
      code: diagnostic.code,
      message: diagnostic.message,
    })),
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

  public async refresh(): Promise<DesktopAgentCatalog> {
    const loaded = await loadAgentCatalog({
      agentsDirectory: this.options.agentsDirectory,
      skillsDirectory: this.options.skillsDirectory,
      availableTools: this.options.availableTools,
    });
    this.#runtimeSkills = loaded.skills.map((skill) => ({
      name: skill.metadata.name,
      description: skill.metadata.description,
      sourcePath: skill.sourcePath,
      fingerprint: skill.fingerprint,
    }));
    this.#catalog = toDesktopCatalog(loaded);
    return this.#catalog;
  }
}
