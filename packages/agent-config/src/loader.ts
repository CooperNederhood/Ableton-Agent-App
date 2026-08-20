import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { extname, join } from "node:path";

import { parseDocument } from "yaml";

import {
  agentDefinitionSchema,
  type AgentDefinition,
  type DefinitionDiagnostic,
  skillMetadataSchema,
  type SkillMetadata,
} from "./schemas.js";
import { resolveToolPatterns } from "./tool-patterns.js";

const maximumDefinitionBytes = 256 * 1024;
const maximumSkillBytes = 512 * 1024;

export interface LoadedSkill {
  readonly metadata: SkillMetadata;
  readonly sourcePath: string;
  readonly directory: string;
  readonly fingerprint: string;
}

export interface SkillDocument {
  readonly metadata: SkillMetadata;
  readonly body: string;
  readonly fingerprint: string;
}

export interface LoadedAgentDefinition {
  readonly definition: AgentDefinition;
  readonly resolvedTools: string[];
  readonly sourcePath: string;
  readonly fingerprint: string;
}

export interface AgentCatalog {
  readonly agents: LoadedAgentDefinition[];
  readonly skills: LoadedSkill[];
  readonly diagnostics: DefinitionDiagnostic[];
}

function fingerprint(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function boundedRead(
  path: string,
  maximumBytes: number,
): Promise<string> {
  const content = await readFile(path);
  if (content.byteLength > maximumBytes) {
    throw Object.assign(new Error(`File exceeds ${maximumBytes} bytes`), {
      code: "file_too_large",
    });
  }
  return content.toString("utf8");
}

function parseYaml(content: string): unknown {
  const document = parseDocument(content, { customTags: [] });
  if (document.errors.length > 0) {
    throw new Error(document.errors.map((error) => error.message).join("; "));
  }
  return document.toJS({ maxAliasCount: 0 });
}

function parseSkillDocument(content: string): {
  frontmatter: unknown;
  body: string;
} {
  const normalized = content.replace(/\r\n/gu, "\n");
  if (!normalized.startsWith("---\n")) {
    throw new Error("SKILL.md must start with YAML frontmatter");
  }
  const end = normalized.indexOf("\n---\n", 4);
  if (end < 0) throw new Error("SKILL.md frontmatter is not terminated");
  const body = normalized.slice(end + 5).trim();
  if (body.length === 0) throw new Error("SKILL.md body must not be empty");
  return {
    frontmatter: parseYaml(normalized.slice(4, end)),
    body,
  };
}

export async function readSkillDocument(
  sourcePath: string,
  expectedName?: string,
): Promise<SkillDocument> {
  const content = await boundedRead(sourcePath, maximumSkillBytes);
  const parsed = parseSkillDocument(content);
  const metadata = skillMetadataSchema.parse(parsed.frontmatter);
  if (expectedName !== undefined && metadata.name !== expectedName) {
    throw new Error(
      `Skill '${metadata.name}' does not match expected skill '${expectedName}'`,
    );
  }
  return {
    metadata,
    body: parsed.body,
    fingerprint: fingerprint(content),
  };
}

function diagnostic(
  sourcePath: string,
  code: DefinitionDiagnostic["code"],
  error: unknown,
): DefinitionDiagnostic {
  return { sourcePath, code, message: message(error) };
}

async function loadSkills(skillsDirectory: string): Promise<{
  skills: LoadedSkill[];
  diagnostics: DefinitionDiagnostic[];
}> {
  const skills: LoadedSkill[] = [];
  const diagnostics: DefinitionDiagnostic[] = [];
  let entries;
  try {
    entries = await readdir(skillsDirectory, { withFileTypes: true });
  } catch (error) {
    diagnostics.push(diagnostic(skillsDirectory, "read_failed", error));
    return { skills, diagnostics };
  }
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (!entry.isDirectory()) continue;
    const sourcePath = join(skillsDirectory, entry.name, "SKILL.md");
    try {
      const document = await readSkillDocument(sourcePath);
      skills.push({
        metadata: document.metadata,
        sourcePath,
        directory: join(skillsDirectory, entry.name),
        fingerprint: document.fingerprint,
      });
    } catch (error) {
      const code =
        (error as { code?: string }).code === "file_too_large"
          ? "file_too_large"
          : "invalid_skill";
      diagnostics.push(diagnostic(sourcePath, code, error));
    }
  }
  return { skills, diagnostics };
}

async function loadAgents(
  agentsDirectory: string,
  availableTools: readonly string[],
  skills: readonly LoadedSkill[],
): Promise<{
  agents: LoadedAgentDefinition[];
  diagnostics: DefinitionDiagnostic[];
}> {
  const agents: LoadedAgentDefinition[] = [];
  const diagnostics: DefinitionDiagnostic[] = [];
  const skillNames = new Set(skills.map((skill) => skill.metadata.name));
  let entries;
  try {
    entries = await readdir(agentsDirectory, { withFileTypes: true });
  } catch (error) {
    diagnostics.push(diagnostic(agentsDirectory, "read_failed", error));
    return { agents, diagnostics };
  }
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (
      !entry.isFile() ||
      ![".yaml", ".yml"].includes(extname(entry.name).toLowerCase())
    ) {
      continue;
    }
    const sourcePath = join(agentsDirectory, entry.name);
    try {
      const content = await boundedRead(sourcePath, maximumDefinitionBytes);
      let parsed: unknown;
      try {
        parsed = parseYaml(content);
      } catch (error) {
        diagnostics.push(diagnostic(sourcePath, "invalid_yaml", error));
        continue;
      }
      const definition = agentDefinitionSchema.parse(parsed);
      const unknownSkills = definition.skills.filter(
        (skill) => !skillNames.has(skill),
      );
      if (unknownSkills.length > 0) {
        diagnostics.push(
          diagnostic(
            sourcePath,
            "unknown_skill",
            `Unknown skills: ${unknownSkills.join(", ")}`,
          ),
        );
        continue;
      }
      const resolution = resolveToolPatterns(definition.tools, availableTools);
      if (resolution.unmatchedPatterns.length > 0) {
        diagnostics.push(
          diagnostic(
            sourcePath,
            "unmatched_tool_pattern",
            `Tool patterns matched no tools: ${resolution.unmatchedPatterns.join(", ")}`,
          ),
        );
        continue;
      }
      agents.push({
        definition,
        resolvedTools: resolution.tools,
        sourcePath,
        fingerprint: fingerprint(content),
      });
    } catch (error) {
      const code =
        (error as { code?: string }).code === "file_too_large"
          ? "file_too_large"
          : "invalid_definition";
      diagnostics.push(diagnostic(sourcePath, code, error));
    }
  }
  return { agents, diagnostics };
}

function removeDuplicates<T>(
  entries: readonly T[],
  key: (entry: T) => string,
  sourcePath: (entry: T) => string,
  code: "duplicate_agent" | "duplicate_skill",
): { unique: T[]; diagnostics: DefinitionDiagnostic[] } {
  const unique: T[] = [];
  const diagnostics: DefinitionDiagnostic[] = [];
  const firstByKey = new Map<string, T>();
  for (const entry of entries) {
    const entryKey = key(entry);
    const first = firstByKey.get(entryKey);
    if (first === undefined) {
      firstByKey.set(entryKey, entry);
      unique.push(entry);
      continue;
    }
    diagnostics.push(
      diagnostic(
        sourcePath(entry),
        code,
        `${entryKey} duplicates ${sourcePath(first)}`,
      ),
    );
  }
  return { unique, diagnostics };
}

export async function loadAgentCatalog(options: {
  readonly agentsDirectory: string;
  readonly skillsDirectory: string;
  readonly availableTools: readonly string[];
}): Promise<AgentCatalog> {
  const loadedSkills = await loadSkills(options.skillsDirectory);
  const deduplicatedSkills = removeDuplicates(
    loadedSkills.skills,
    (skill) => skill.metadata.name,
    (skill) => skill.sourcePath,
    "duplicate_skill",
  );
  const loadedAgents = await loadAgents(
    options.agentsDirectory,
    options.availableTools,
    deduplicatedSkills.unique,
  );
  const deduplicatedAgents = removeDuplicates(
    loadedAgents.agents,
    (agent) => agent.definition.name,
    (agent) => agent.sourcePath,
    "duplicate_agent",
  );
  return {
    agents: deduplicatedAgents.unique,
    skills: deduplicatedSkills.unique,
    diagnostics: [
      ...loadedSkills.diagnostics,
      ...deduplicatedSkills.diagnostics,
      ...loadedAgents.diagnostics,
      ...deduplicatedAgents.diagnostics,
    ],
  };
}
