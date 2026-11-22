import { randomUUID } from "node:crypto";

import {
  assertMemoryTopicBudget,
  formatMemoryIndex,
  MAX_MEMORY_TOPICS_PER_SCOPE,
  MEMORY_INDEX_FILE_NAME,
  MEMORY_SCOPE_DESCRIPTIONS,
  MEMORY_SCOPE_ORDER,
  memoryTopicNameSchema,
  parseMemoryTopic,
  parseSkillContent,
  skillNameSchema,
} from "@ableton-agent/agent-config";
import type {
  AgentArtifactKind,
  AgentArtifactReviewFile,
  AgentArtifactReviewRequest,
  AgentArtifactReviewTarget,
  AgentArtifactScope,
} from "@ableton-agent/shared";
import { defineTool, type Tool } from "@github/copilot-sdk";
import { z } from "zod";

/**
 * Built-in skills that open a reviewed draft when loaded, by slash command or
 * by the agent's own `skill(...)` call. They are enabled for every agent.
 */
export const AUTHORING_SKILL_KINDS: Readonly<
  Record<string, AgentArtifactKind>
> = {
  "update-memory": "memory",
  "learn-skill": "skill",
};

export function authoringKindForSkill(
  skillName: string,
): AgentArtifactKind | undefined {
  return Object.hasOwn(AUTHORING_SKILL_KINDS, skillName)
    ? AUTHORING_SKILL_KINDS[skillName]
    : undefined;
}

export const ARTIFACT_FILES_LIST_TOOL_NAME = "artifact_files_list";
export const ARTIFACT_FILE_READ_TOOL_NAME = "artifact_file_read";
export const ARTIFACT_FILE_WRITE_TOOL_NAME = "artifact_file_write";
export const ARTIFACT_FILE_DELETE_TOOL_NAME = "artifact_file_delete";
export const SUBMIT_ARTIFACT_DRAFT_TOOL_NAME = "submit_artifact_draft";
export const ARTIFACT_AUTHORING_TOOL_NAMES: readonly string[] = [
  ARTIFACT_FILES_LIST_TOOL_NAME,
  ARTIFACT_FILE_READ_TOOL_NAME,
  ARTIFACT_FILE_WRITE_TOOL_NAME,
  ARTIFACT_FILE_DELETE_TOOL_NAME,
  SUBMIT_ARTIFACT_DRAFT_TOOL_NAME,
];

export const SKILL_AUTHORING_DEFAULT_SCOPE: AgentArtifactScope = "profile";
const MAX_ARTIFACT_SUMMARY_LENGTH = 2_000;
const MAX_ARTIFACT_FILE_CONTENT_LENGTH = 512 * 1024;

export interface ArtifactAuthoringMemoryTopic {
  readonly name: string;
  readonly description: string;
  readonly content: string;
  readonly fingerprint: string;
}

export interface ArtifactAuthoringScopeState {
  readonly scope: AgentArtifactScope;
  readonly available: boolean;
  readonly unavailableReason?: string;
}

export interface ArtifactAuthoringMemoryScope extends ArtifactAuthoringScopeState {
  readonly topics: readonly ArtifactAuthoringMemoryTopic[];
}

export interface ArtifactAuthoringSkill {
  readonly name: string;
  readonly description: string;
  readonly origin: AgentArtifactScope | "bundled";
  readonly content: string;
  readonly fingerprint: string;
}

/** Everything a draft may read, captured when the draft opens. */
export interface ArtifactAuthoringContext {
  readonly memory: readonly ArtifactAuthoringMemoryScope[];
  readonly skillScopes: readonly ArtifactAuthoringScopeState[];
  /** Effective skill catalog for this session, one entry per name. */
  readonly skills: readonly ArtifactAuthoringSkill[];
}

export type SkillArtifactScope = Exclude<AgentArtifactScope, "live-set">;

export type ArtifactPublication =
  | {
      readonly kind: "memory";
      readonly scopes: readonly {
        readonly scope: AgentArtifactScope;
        readonly writes: readonly {
          readonly name: string;
          readonly content: string;
          readonly baseFingerprint: string | null;
        }[];
        readonly deletes: readonly {
          readonly name: string;
          readonly baseFingerprint: string;
        }[];
      }[];
    }
  | {
      readonly kind: "skill";
      readonly scope: SkillArtifactScope;
      readonly name: string;
      readonly description: string;
      readonly body: string;
      /** Effective catalog fingerprint the draft was based on. */
      readonly baseFingerprint: string | null;
    };

export interface ArtifactPublicationResult {
  readonly published: readonly {
    readonly scope: AgentArtifactScope;
    readonly path: string;
    readonly change: "added" | "modified" | "deleted";
  }[];
}

/** Host-owned storage for memory and skills. Desktop implements it. */
export interface ArtifactAuthoringPort {
  loadContext(productionSessionId: string): Promise<ArtifactAuthoringContext>;
  publish(
    productionSessionId: string,
    publication: ArtifactPublication,
  ): Promise<ArtifactPublicationResult>;
}

type ParsedPath =
  | {
      readonly kind: "memory";
      readonly scope: AgentArtifactScope;
      readonly topic: string;
    }
  | { readonly kind: "skill"; readonly name: string };

const memoryScopeValues = new Set<string>(MEMORY_SCOPE_ORDER);

export function parseArtifactPath(path: string): ParsedPath {
  const memory = /^memory\/([a-z-]+)\/([^/]+)$/u.exec(path);
  if (memory !== null) {
    const [, scope, file] = memory;
    if (!memoryScopeValues.has(scope!)) {
      throw new Error(
        `Unknown memory scope '${scope}'. Use ${MEMORY_SCOPE_ORDER.join(", ")}.`,
      );
    }
    if (file === MEMORY_INDEX_FILE_NAME) {
      return {
        kind: "memory",
        scope: scope as AgentArtifactScope,
        topic: "INDEX",
      };
    }
    if (!file!.endsWith(".md")) {
      throw new Error("Memory topic files must end in .md");
    }
    return {
      kind: "memory",
      scope: scope as AgentArtifactScope,
      topic: memoryTopicNameSchema.parse(file!.slice(0, -3)),
    };
  }
  const skill = /^skills\/([^/]+)\/SKILL\.md$/u.exec(path);
  if (skill !== null) {
    return { kind: "skill", name: skillNameSchema.parse(skill[1]) };
  }
  throw new Error(
    "Paths must look like memory/{scope}/{topic}.md, memory/{scope}/INDEX.md, or skills/{name}/SKILL.md",
  );
}

function memoryPath(scope: AgentArtifactScope, topic: string): string {
  return `memory/${scope}/${topic}.md`;
}

function scopeLabel(scope: AgentArtifactScope): string {
  return MEMORY_SCOPE_DESCRIPTIONS[scope].label;
}

/**
 * Pending memory or skill changes for one turn. Nothing touches disk until the
 * user approves the review; publishing goes through the host port.
 */
export class ArtifactDraft {
  readonly id = randomUUID();
  readonly openedAt = Date.now();
  revision = 0;
  /** Virtual path to new content; `null` deletes the topic. */
  readonly #changes = new Map<string, string | null>();

  constructor(
    readonly kind: AgentArtifactKind,
    readonly skillName: string,
    readonly context: ArtifactAuthoringContext,
    /** Memory: every write must use this scope. Skill: initial target. */
    readonly requestedScope: AgentArtifactScope | undefined,
  ) {
    if (kind === "skill" && requestedScope === "live-set") {
      throw new Error("Skills have no Live Set scope. Use project or session.");
    }
    const scope = this.#scopeState(this.targetScope);
    if (requestedScope !== undefined && !scope.available) {
      throw new Error(
        `${scopeLabel(requestedScope)} scope is unavailable: ${scope.unavailableReason ?? "no owner"}`,
      );
    }
  }

  get targetScope(): AgentArtifactScope {
    return (
      this.requestedScope ??
      (this.kind === "skill" ? SKILL_AUTHORING_DEFAULT_SCOPE : "session")
    );
  }

  get changeCount(): number {
    return this.#changes.size;
  }

  /** Instructions appended to the authoring skill body when the draft opens. */
  describe(): string {
    const lines = [
      `<artifact_draft id="${this.id}" kind="${this.kind}">`,
      "A reviewed draft is open for this turn. Use artifact_files_list and artifact_file_read to inspect, artifact_file_write and artifact_file_delete to change the draft, and submit_artifact_draft to send it to the user for review. Nothing is saved until the user approves.",
    ];
    if (this.kind === "memory") {
      lines.push(
        this.requestedScope === undefined
          ? "Choose a scope for each topic; write paths are memory/{scope}/{topic}.md."
          : `The user asked for ${scopeLabel(this.requestedScope)} scope. Write every topic to memory/${this.requestedScope}/.`,
      );
    } else {
      lines.push(
        `Write one skill to skills/{name}/SKILL.md. It will be proposed at ${scopeLabel(this.targetScope)} scope; the user can change that in review.`,
      );
    }
    for (const scope of this.kind === "memory"
      ? this.context.memory
      : this.context.skillScopes) {
      if (!scope.available) {
        lines.push(
          `${scopeLabel(scope.scope)} scope is unavailable: ${scope.unavailableReason ?? "no owner"}.`,
        );
      }
    }
    lines.push("</artifact_draft>");
    return lines.join("\n");
  }

  #scopeState(scope: AgentArtifactScope): ArtifactAuthoringScopeState {
    const scopes =
      this.kind === "memory" ? this.context.memory : this.context.skillScopes;
    return (
      scopes.find((candidate) => candidate.scope === scope) ?? {
        scope,
        available: false,
        unavailableReason:
          this.kind === "skill" && scope === "live-set"
            ? "skills have no Live Set scope"
            : "not offered for this session",
      }
    );
  }

  #memoryScope(scope: AgentArtifactScope) {
    return this.context.memory.find((candidate) => candidate.scope === scope);
  }

  #publishedTopic(scope: AgentArtifactScope, topic: string) {
    return this.#memoryScope(scope)?.topics.find(({ name }) => name === topic);
  }

  #draftTopics(
    scope: AgentArtifactScope,
  ): { name: string; description: string }[] {
    const topics = new Map(
      (this.#memoryScope(scope)?.topics ?? []).map((topic) => [
        topic.name,
        { name: topic.name, description: topic.description },
      ]),
    );
    for (const [path, content] of this.#changes) {
      const parsed = parseArtifactPath(path);
      if (parsed.kind !== "memory" || parsed.scope !== scope) continue;
      if (content === null) topics.delete(parsed.topic);
      else topics.set(parsed.topic, parseMemoryTopic(parsed.topic, content));
    }
    return [...topics.values()];
  }

  list(): unknown {
    const status = (path: string, exists: boolean) => {
      if (!this.#changes.has(path)) return "unchanged";
      if (this.#changes.get(path) === null) return "deleted";
      return exists ? "modified" : "added";
    };
    const memory = this.context.memory.map((scope) => {
      const names = new Set(scope.topics.map(({ name }) => name));
      for (const path of this.#changes.keys()) {
        const parsed = parseArtifactPath(path);
        if (parsed.kind === "memory" && parsed.scope === scope.scope) {
          names.add(parsed.topic);
        }
      }
      return {
        scope: scope.scope,
        meaning: MEMORY_SCOPE_DESCRIPTIONS[scope.scope].meaning,
        available: scope.available,
        ...(scope.unavailableReason === undefined
          ? {}
          : { unavailableReason: scope.unavailableReason }),
        topicLimit: MAX_MEMORY_TOPICS_PER_SCOPE,
        files: [...names].sort().map((name) => {
          const path = memoryPath(scope.scope, name);
          const published = scope.topics.find((topic) => topic.name === name);
          return {
            path,
            status: status(path, published !== undefined),
            ...(published === undefined
              ? {}
              : { description: published.description }),
          };
        }),
      };
    });
    const skills = this.context.skills.map((skill) => {
      const path = `skills/${skill.name}/SKILL.md`;
      return {
        path,
        description: skill.description,
        origin: skill.origin,
        status: status(path, true),
      };
    });
    for (const path of this.#changes.keys()) {
      const parsed = parseArtifactPath(path);
      if (
        parsed.kind === "skill" &&
        !this.context.skills.some(({ name }) => name === parsed.name)
      ) {
        skills.push({
          path,
          description: "",
          origin: this.targetScope,
          status: "added",
        });
      }
    }
    return {
      draft: {
        id: this.id,
        kind: this.kind,
        targetScope: this.targetScope,
        changes: this.#changes.size,
      },
      memory,
      skills,
    };
  }

  read(path: string): string {
    const parsed = parseArtifactPath(path);
    if (parsed.kind === "memory") {
      if (parsed.topic === "INDEX") {
        return formatMemoryIndex(this.#draftTopics(parsed.scope));
      }
      if (this.#changes.has(path)) {
        const content = this.#changes.get(path);
        if (content === null) {
          throw new Error(`'${path}' is deleted in this draft`);
        }
        return content!;
      }
      const topic = this.#publishedTopic(parsed.scope, parsed.topic);
      if (topic === undefined) throw new Error(`'${path}' does not exist`);
      return topic.content;
    }
    const draft = this.#changes.get(path);
    if (typeof draft === "string") return draft;
    const skill = this.context.skills.find(({ name }) => name === parsed.name);
    if (skill === undefined) throw new Error(`'${path}' does not exist`);
    return skill.content;
  }

  write(path: string, content: string): { path: string; status: string } {
    const parsed = parseArtifactPath(path);
    if (parsed.kind !== this.kind) {
      throw new Error(
        `This is a ${this.kind} draft; it cannot change ${parsed.kind} files`,
      );
    }
    if (parsed.kind === "memory") {
      if (parsed.topic === "INDEX") {
        throw new Error(
          "INDEX.md is generated from each topic's frontmatter description; edit the topic instead",
        );
      }
      this.#assertMemoryScopeWritable(parsed.scope);
      parseMemoryTopic(parsed.topic, content);
      const exists =
        this.#publishedTopic(parsed.scope, parsed.topic) !== undefined;
      this.#changes.set(path, content);
      return { path, status: exists ? "modified" : "added" };
    }
    const document = parseSkillContent(content, parsed.name);
    const existing = this.context.skills.find(
      ({ name }) => name === parsed.name,
    );
    if (
      existing !== undefined &&
      existing.description !== document.metadata.description
    ) {
      throw new Error(
        `Skill '${parsed.name}' already exists; its name and description are locked. Keep description "${existing.description}" and change the body only.`,
      );
    }
    const other = [...this.#changes.keys()].find((key) => key !== path);
    if (other !== undefined) {
      throw new Error(
        `This draft already changes '${other}'. A skill draft holds one skill.`,
      );
    }
    this.#changes.set(path, content);
    return { path, status: existing === undefined ? "added" : "modified" };
  }

  delete(path: string): { path: string; status: string } {
    const parsed = parseArtifactPath(path);
    if (parsed.kind !== "memory" || this.kind !== "memory") {
      throw new Error("Only memory topics can be deleted in a draft");
    }
    if (parsed.topic === "INDEX") {
      throw new Error("INDEX.md is generated; delete topics instead");
    }
    this.#assertMemoryScopeWritable(parsed.scope);
    if (this.#publishedTopic(parsed.scope, parsed.topic) === undefined) {
      if (this.#changes.delete(path)) return { path, status: "reverted" };
      throw new Error(`'${path}' does not exist`);
    }
    this.#changes.set(path, null);
    return { path, status: "deleted" };
  }

  #assertMemoryScopeWritable(scope: AgentArtifactScope): void {
    if (this.requestedScope !== undefined && scope !== this.requestedScope) {
      throw new Error(
        `The user asked for ${scopeLabel(this.requestedScope)} scope; write to memory/${this.requestedScope}/ instead`,
      );
    }
    const state = this.#scopeState(scope);
    if (!state.available) {
      throw new Error(
        `${scopeLabel(scope)} memory is unavailable: ${state.unavailableReason ?? "no owner"}`,
      );
    }
  }

  /** Validates the whole draft and builds the review shown in the Inspector. */
  review(requestId: string, summary: string): AgentArtifactReviewRequest {
    if (this.#changes.size === 0) {
      throw new Error("The draft has no changes to submit");
    }
    const files: AgentArtifactReviewFile[] = [];
    if (this.kind === "memory") {
      for (const scope of MEMORY_SCOPE_ORDER) {
        if (this.#memoryScope(scope) === undefined) continue;
        assertMemoryTopicBudget(scope, this.#draftTopics(scope).length);
      }
      for (const [path, after] of this.#changes) {
        const parsed = parseArtifactPath(path);
        if (parsed.kind !== "memory") continue;
        const currentByScope: Partial<Record<AgentArtifactScope, string>> = {};
        for (const scope of this.context.memory) {
          const topic = scope.topics.find(({ name }) => name === parsed.topic);
          if (topic !== undefined) currentByScope[scope.scope] = topic.content;
        }
        files.push({
          id: `memory:${parsed.topic}@${parsed.scope}`,
          kind: "memory_topic",
          name: parsed.topic,
          change:
            after === null
              ? "deleted"
              : currentByScope[parsed.scope] === undefined
                ? "added"
                : "modified",
          scope: parsed.scope,
          movable: after !== null && this.requestedScope === undefined,
          after,
          currentByScope,
        });
      }
    } else {
      const [path, after] = [...this.#changes][0]!;
      const parsed = parseArtifactPath(path);
      if (parsed.kind !== "skill" || after === null) {
        throw new Error("A skill draft must write one SKILL.md");
      }
      const existing = this.context.skills.find(
        ({ name }) => name === parsed.name,
      );
      files.push({
        id: `skill:${parsed.name}`,
        kind: "skill",
        name: parsed.name,
        change: existing === undefined ? "added" : "modified",
        scope: this.targetScope,
        movable: true,
        after,
        currentByScope:
          existing === undefined || existing.origin === "bundled"
            ? {}
            : { [existing.origin]: existing.content },
        ...(existing === undefined ? {} : { existingOrigin: existing.origin }),
      });
    }
    this.revision += 1;
    const scopes =
      this.kind === "memory"
        ? this.context.memory
        : MEMORY_SCOPE_ORDER.map((scope) => this.#scopeState(scope));
    return {
      requestId,
      draftId: this.id,
      kind: this.kind,
      summary: summary.trim().slice(0, MAX_ARTIFACT_SUMMARY_LENGTH),
      revision: this.revision,
      maxTopicsPerScope: MAX_MEMORY_TOPICS_PER_SCOPE,
      files: files.sort((left, right) => left.id.localeCompare(right.id)),
      scopes: scopes.map((scope) => ({
        scope: scope.scope,
        label: scopeLabel(scope.scope),
        meaning: MEMORY_SCOPE_DESCRIPTIONS[scope.scope].meaning,
        available: scope.available,
        ...(scope.unavailableReason === undefined
          ? {}
          : { unavailableReason: scope.unavailableReason }),
        ...("topics" in scope
          ? {
              topicCount: scope.topics.length,
            }
          : {}),
      })),
    };
  }

  /** Applies the user's scope choices to a reviewed draft. */
  publication(
    review: AgentArtifactReviewRequest,
    targets: readonly AgentArtifactReviewTarget[] = [],
  ): ArtifactPublication {
    const fileIds = new Set(review.files.map(({ id }) => id));
    const targetById = new Map<string, AgentArtifactScope>();
    for (const target of targets) {
      if (!fileIds.has(target.fileId)) {
        throw new Error(`Unknown review file '${target.fileId}'`);
      }
      targetById.set(target.fileId, target.scope);
    }
    if (this.kind === "skill") {
      const file = review.files[0]!;
      const scope = targetById.get(file.id) ?? file.scope;
      const state = this.#scopeState(scope);
      if (scope === "live-set" || !state.available) {
        throw new Error(
          `${scopeLabel(scope)} scope is unavailable for skills: ${state.unavailableReason ?? "no owner"}`,
        );
      }
      const document = parseSkillContent(file.after!, file.name);
      return {
        kind: "skill",
        scope,
        name: file.name,
        description: document.metadata.description,
        body: document.body,
        baseFingerprint:
          this.context.skills.find(({ name }) => name === file.name)
            ?.fingerprint ?? null,
      };
    }
    const byScope = new Map<
      AgentArtifactScope,
      {
        writes: {
          name: string;
          content: string;
          baseFingerprint: string | null;
        }[];
        deletes: { name: string; baseFingerprint: string }[];
      }
    >();
    const claimed = new Set<string>();
    for (const file of review.files) {
      const scope =
        file.change === "deleted" || !file.movable
          ? file.scope
          : (targetById.get(file.id) ?? file.scope);
      const state = this.#scopeState(scope);
      if (!state.available) {
        throw new Error(
          `${scopeLabel(scope)} memory is unavailable: ${state.unavailableReason ?? "no owner"}`,
        );
      }
      const key = `${scope}/${file.name}`;
      if (claimed.has(key)) {
        throw new Error(
          `Two draft changes target ${scopeLabel(scope)} topic '${file.name}'; keep one`,
        );
      }
      claimed.add(key);
      const entry = byScope.get(scope) ?? { writes: [], deletes: [] };
      byScope.set(scope, entry);
      const base = this.#publishedTopic(scope, file.name)?.fingerprint ?? null;
      if (file.after === null) {
        entry.deletes.push({ name: file.name, baseFingerprint: base! });
      } else {
        entry.writes.push({
          name: file.name,
          content: file.after,
          baseFingerprint: base,
        });
      }
    }
    for (const [scope, entry] of byScope) {
      const count =
        (this.#memoryScope(scope)?.topics.length ?? 0) +
        entry.writes.filter(({ baseFingerprint }) => baseFingerprint === null)
          .length -
        entry.deletes.length;
      assertMemoryTopicBudget(scope, count);
    }
    return {
      kind: "memory",
      scopes: MEMORY_SCOPE_ORDER.flatMap((scope) => {
        const entry = byScope.get(scope);
        return entry === undefined ? [] : [{ scope, ...entry }];
      }),
    };
  }
}

export interface ArtifactAuthoringToolHandlers {
  list(): Promise<unknown>;
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<unknown>;
  delete(path: string): Promise<unknown>;
  submit(summary: string): Promise<unknown>;
}

const artifactPathSchema = z
  .string()
  .min(1)
  .max(256)
  .describe(
    "memory/{scope}/{topic}.md, memory/{scope}/INDEX.md, or skills/{name}/SKILL.md",
  );

/** Plain file tools over memory and skills; writes only reach the draft. */
export function createArtifactAuthoringTools(
  handlers: ArtifactAuthoringToolHandlers,
): Tool[] {
  return [
    defineTool(ARTIFACT_FILES_LIST_TOOL_NAME, {
      description:
        "List memory topics in every scope of this session and the effective skills, with draft status when a memory or skill draft is open.",
      parameters: z.object({}).strict(),
      skipPermission: true,
      defer: "never",
      handler: async () => handlers.list(),
    }) as Tool,
    defineTool(ARTIFACT_FILE_READ_TOOL_NAME, {
      description:
        "Read one memory topic, a generated memory INDEX.md, or a skill's SKILL.md. Reads include unsaved draft changes.",
      parameters: z.object({ path: artifactPathSchema }).strict(),
      skipPermission: true,
      defer: "never",
      handler: async ({ path }) => handlers.read(path),
    }) as Tool,
    defineTool(ARTIFACT_FILE_WRITE_TOOL_NAME, {
      description:
        "Create or replace one file in the open draft. Memory topics need frontmatter with name (the file name) and a one-line description. Only available after loading update-memory or learn-skill.",
      parameters: z
        .object({
          path: artifactPathSchema,
          content: z.string().min(1).max(MAX_ARTIFACT_FILE_CONTENT_LENGTH),
        })
        .strict(),
      skipPermission: true,
      defer: "never",
      handler: async ({ path, content }) => handlers.write(path, content),
    }) as Tool,
    defineTool(ARTIFACT_FILE_DELETE_TOOL_NAME, {
      description:
        "Delete one memory topic in the open draft, for example after merging it into a broader topic.",
      parameters: z.object({ path: artifactPathSchema }).strict(),
      skipPermission: true,
      defer: "never",
      handler: async ({ path }) => handlers.delete(path),
    }) as Tool,
    defineTool(SUBMIT_ARTIFACT_DRAFT_TOOL_NAME, {
      description:
        "Send the open draft to the user for review and wait for their decision. The result says whether it was published, needs changes, or was discarded.",
      parameters: z
        .object({
          summary: z
            .string()
            .trim()
            .min(1)
            .max(MAX_ARTIFACT_SUMMARY_LENGTH)
            .describe(
              "What changed and why, including merges and replacements",
            ),
        })
        .strict(),
      skipPermission: true,
      defer: "never",
      handler: async ({ summary }) => handlers.submit(summary),
    }) as Tool,
  ];
}
