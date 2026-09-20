import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { extname, isAbsolute, join, resolve } from "node:path";

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

export type ArtifactOrigin = "bundled" | "system" | "profile" | "session";

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

export interface LayeredLoadedSkill extends LoadedSkill {
  readonly origin: ArtifactOrigin;
  readonly inherited: boolean;
  readonly overrides: readonly ArtifactOrigin[];
}

export interface LayeredLoadedAgentDefinition extends LoadedAgentDefinition {
  readonly origin: ArtifactOrigin;
  readonly inherited: boolean;
  readonly overrides: readonly ArtifactOrigin[];
}

export interface LayeredAgentCatalog {
  readonly agents: LayeredLoadedAgentDefinition[];
  readonly skills: LayeredLoadedSkill[];
  readonly diagnostics: DefinitionDiagnostic[];
}

export interface ArtifactLayerDirectories {
  readonly agentsDirectory: string;
  readonly skillsDirectory: string;
  readonly agentTombstones?: readonly string[] | string;
  readonly skillTombstones?: readonly string[] | string;
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
  const details = await lstat(path);
  if (details.isSymbolicLink() || !details.isFile()) {
    throw new Error(`Expected a regular file at '${path}'`);
  }
  if (details.size > maximumBytes) {
    throw Object.assign(new Error(`File exceeds ${maximumBytes} bytes`), {
      code: "file_too_large",
    });
  }
  const content = await readFile(path);
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

async function validatePhysicalLayer(
  origin: ArtifactOrigin,
  layer: ArtifactLayerDirectories,
): Promise<void> {
  for (const directory of [layer.agentsDirectory, layer.skillsDirectory]) {
    if (!isAbsolute(directory)) {
      throw new Error(`${origin} artifact directories must be absolute`);
    }
    try {
      const details = await lstat(directory);
      if (details.isSymbolicLink() || !details.isDirectory()) {
        throw new Error(`${origin} artifact path must be a physical directory`);
      }
      if ((await realpath(directory)) !== resolve(directory)) {
        throw new Error(
          `${origin} artifact directory contains a symbolic-link ancestor`,
        );
      }
      await rejectArtifactSymlinks(directory, origin);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async function rejectArtifactSymlinks(
    directory: string,
    origin: ArtifactOrigin,
    remainingEntries: { value: number } = { value: 4_096 },
  ): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      remainingEntries.value -= 1;
      if (remainingEntries.value < 0) {
        throw new Error(`${origin} artifact scope exceeds 4096 entries`);
      }
      if (entry.isSymbolicLink()) {
        throw new Error(
          `Symbolic links are not allowed in ${origin} artifact directories`,
        );
      }
      if (entry.isDirectory()) {
        await rejectArtifactSymlinks(
          join(directory, entry.name),
          origin,
          remainingEntries,
        );
      }
    }
  }
}

async function readTombstones(
  value: readonly string[] | string | undefined,
): Promise<Set<string>> {
  if (value === undefined) return new Set();
  let names: unknown;
  if (typeof value === "string") {
    try {
      names = (
        JSON.parse(await boundedRead(value, 256 * 1024)) as {
          names?: unknown;
        }
      ).names;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
      throw error;
    }
    names ??= [];
  } else {
    names = value;
  }
  if (!Array.isArray(names)) {
    throw new Error("Artifact tombstones must contain a names array");
  }
  return new Set(
    names.map((name) => skillMetadataSchema.shape.name.parse(name)),
  );
}

interface OriginEntry<T> {
  readonly origin: ArtifactOrigin;
  readonly value: T;
}

function resolveLayeredEntries<T>(
  entries: readonly OriginEntry<T>[],
  key: (entry: T) => string,
  tombstones: ReadonlyMap<ArtifactOrigin, ReadonlySet<string>>,
  activeOrigin: ArtifactOrigin,
): Array<
  T & {
    origin: ArtifactOrigin;
    inherited: boolean;
    overrides: ArtifactOrigin[];
  }
> {
  const resolved = new Map<
    string,
    { origin: ArtifactOrigin; value: T; overrides: ArtifactOrigin[] }
  >();
  const order: readonly ArtifactOrigin[] = [
    "bundled",
    "system",
    "profile",
    "session",
  ];
  for (const origin of order) {
    for (const name of tombstones.get(origin) ?? []) resolved.delete(name);
    for (const entry of entries.filter(
      (candidate) => candidate.origin === origin,
    )) {
      const name = key(entry.value);
      const previous = resolved.get(name);
      resolved.set(name, {
        origin,
        value: entry.value,
        overrides:
          previous === undefined
            ? []
            : [...previous.overrides, previous.origin],
      });
    }
  }
  return [...resolved.values()].map(({ origin, value, overrides }) => ({
    ...value,
    origin,
    inherited: origin !== activeOrigin,
    overrides,
  }));
}

export async function loadLayeredAgentCatalog(options: {
  readonly bundled: ArtifactLayerDirectories;
  readonly system?: ArtifactLayerDirectories;
  readonly profile?: ArtifactLayerDirectories;
  readonly session?: ArtifactLayerDirectories;
  readonly availableTools: readonly string[];
}): Promise<LayeredAgentCatalog> {
  const layers = (
    [
      ["bundled", options.bundled],
      ["system", options.system],
      ["profile", options.profile],
      ["session", options.session],
    ] as const
  ).filter(
    (entry): entry is readonly [ArtifactOrigin, ArtifactLayerDirectories] =>
      entry[1] !== undefined,
  );
  await Promise.all(
    layers.map(([origin, layer]) => validatePhysicalLayer(origin, layer)),
  );
  const loadedSkillLayers = await Promise.all(
    layers.map(async ([origin, layer]) => {
      const loaded = await loadSkills(layer.skillsDirectory);
      const deduplicated = removeDuplicates(
        loaded.skills,
        (skill) => skill.metadata.name,
        (skill) => skill.sourcePath,
        "duplicate_skill",
      );
      return {
        origin,
        loaded: {
          skills: deduplicated.unique,
          diagnostics: [...loaded.diagnostics, ...deduplicated.diagnostics],
        },
      };
    }),
  );
  const allSkills = loadedSkillLayers.flatMap(({ loaded }) => loaded.skills);
  const loadedAgentLayers = await Promise.all(
    layers.map(async ([origin, layer]) => {
      const loaded = await loadAgents(
        layer.agentsDirectory,
        options.availableTools,
        allSkills,
      );
      const deduplicated = removeDuplicates(
        loaded.agents,
        (agent) => agent.definition.name,
        (agent) => agent.sourcePath,
        "duplicate_agent",
      );
      return {
        origin,
        loaded: {
          agents: deduplicated.unique,
          diagnostics: [...loaded.diagnostics, ...deduplicated.diagnostics],
        },
      };
    }),
  );
  const skillTombstones = new Map<ArtifactOrigin, ReadonlySet<string>>();
  const agentTombstones = new Map<ArtifactOrigin, ReadonlySet<string>>();
  await Promise.all(
    layers.flatMap(([origin, layer]) => [
      readTombstones(layer.skillTombstones).then((names) =>
        skillTombstones.set(origin, names),
      ),
      readTombstones(layer.agentTombstones).then((names) =>
        agentTombstones.set(origin, names),
      ),
    ]),
  );
  const activeOrigin = layers.at(-1)?.[0] ?? "bundled";
  const skills = resolveLayeredEntries(
    loadedSkillLayers.flatMap(({ origin, loaded }) =>
      loaded.skills.map((value) => ({ origin, value })),
    ),
    (skill) => skill.metadata.name,
    skillTombstones,
    activeOrigin,
  );
  const agents = resolveLayeredEntries(
    loadedAgentLayers.flatMap(({ origin, loaded }) =>
      loaded.agents.map((value) => ({ origin, value })),
    ),
    (agent) => agent.definition.name,
    agentTombstones,
    activeOrigin,
  );
  const effectiveSkillNames = new Set(
    skills.map((skill) => skill.metadata.name),
  );
  const diagnostics = [
    ...loadedSkillLayers.flatMap(({ loaded }) => loaded.diagnostics),
    ...loadedAgentLayers.flatMap(({ loaded }) => loaded.diagnostics),
  ];
  const validAgents = agents.filter((agent) => {
    const unknown = agent.definition.skills.filter(
      (name) => !effectiveSkillNames.has(name),
    );
    if (unknown.length === 0) return true;
    diagnostics.push(
      diagnostic(
        agent.sourcePath,
        "unknown_skill",
        `Unknown skills: ${unknown.join(", ")}`,
      ),
    );
    return false;
  });
  return { agents: validAgents, skills, diagnostics };
}
