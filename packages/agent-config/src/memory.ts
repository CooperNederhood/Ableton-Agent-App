import { createHash, randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

import { parseDocument } from "yaml";
import { z } from "zod";

/**
 * Memory is plain Markdown the agent keeps between sessions. Each scope owns
 * one `memory/` folder: one file per general topic plus an app-generated
 * `INDEX.md` that maps topic names to one-line descriptions.
 */
export const memoryScopeSchema = z.enum([
  "system",
  "profile",
  "project",
  "live-set",
  "session",
]);
export type MemoryScopeName = z.infer<typeof memoryScopeSchema>;

/** Broadest first. Narrower scopes override broader ones on conflict. */
export const MEMORY_SCOPE_ORDER: readonly MemoryScopeName[] =
  memoryScopeSchema.options;

/**
 * Canonical scope meanings shared by the system-message index headings, the
 * `update-memory` skill, and the review pane so the wording never drifts.
 */
export const MEMORY_SCOPE_DESCRIPTIONS: Readonly<
  Record<MemoryScopeName, { readonly label: string; readonly meaning: string }>
> = {
  system: {
    label: "System",
    meaning: "always-true knowledge base for all of Ableton Live",
  },
  profile: {
    label: "Profile",
    meaning: "a unified artistic aesthetic spanning many tracks",
  },
  project: {
    label: "Project",
    meaning: "an Ableton project, often a single musical track",
  },
  "live-set": {
    label: "Live Set",
    meaning: "one version or arrangement of that track",
  },
  session: {
    label: "Session",
    meaning: "this working session only; short-lived experiments and decisions",
  },
};

export const MEMORY_INDEX_FILE_NAME = "INDEX.md";
/** Fewer than 20 general topics per scope keeps memory consolidated. */
export const MAX_MEMORY_TOPICS_PER_SCOPE = 19;
export const MAX_MEMORY_TOPIC_BYTES = 16 * 1024;
export const MAX_MEMORY_DESCRIPTION_LENGTH = 200;
export const DEFAULT_MEMORY_INDEX_PROMPT_BYTES = 12 * 1024;

export const memoryTopicNameSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9-]{0,63}$/u,
    "Memory topic names must be lowercase kebab-case identifiers",
  )
  .refine((name) => name !== "index", "'index' is reserved for INDEX.md");

const memoryTopicFrontmatterSchema = z
  .object({
    name: memoryTopicNameSchema,
    description: z
      .string()
      .trim()
      .min(1, "Memory topics require a description")
      .max(MAX_MEMORY_DESCRIPTION_LENGTH)
      .refine(
        (value) => !/[|\n\r]/u.test(value),
        "Memory topic descriptions must be one line without '|'",
      ),
  })
  .strict();

export interface MemoryTopicSummary {
  readonly name: string;
  readonly description: string;
}

export interface MemoryTopic extends MemoryTopicSummary {
  readonly content: string;
  readonly fingerprint: string;
}

export function memoryFingerprint(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Parses one topic file and verifies its frontmatter matches its file name. */
export function parseMemoryTopic(
  expectedName: string,
  content: string,
): MemoryTopic {
  const name = memoryTopicNameSchema.parse(expectedName);
  if (Buffer.byteLength(content, "utf8") > MAX_MEMORY_TOPIC_BYTES) {
    throw new Error(
      `Memory topic '${name}' exceeds ${MAX_MEMORY_TOPIC_BYTES} bytes`,
    );
  }
  if (content.includes("\u0000")) {
    throw new Error(`Memory topic '${name}' must be text`);
  }
  const normalized = content.replace(/\r\n/gu, "\n");
  if (!normalized.startsWith("---\n")) {
    throw new Error(
      `Memory topic '${name}' must start with frontmatter (name, description)`,
    );
  }
  const end = normalized.indexOf("\n---\n", 4);
  if (end < 0) {
    throw new Error(`Memory topic '${name}' frontmatter is not terminated`);
  }
  const document = parseDocument(normalized.slice(4, end), { customTags: [] });
  if (document.errors.length > 0) {
    throw new Error(
      `Memory topic '${name}' frontmatter is invalid: ${document.errors
        .map((error) => error.message)
        .join("; ")}`,
    );
  }
  const parsed = memoryTopicFrontmatterSchema.safeParse(
    document.toJS({ maxAliasCount: 0 }),
  );
  if (!parsed.success) {
    throw new Error(
      `Memory topic '${name}' frontmatter is invalid: ${parsed.error.issues
        .map((issue) => issue.message)
        .join("; ")}`,
    );
  }
  if (parsed.data.name !== name) {
    throw new Error(
      `Memory topic file '${name}.md' declares name '${parsed.data.name}'`,
    );
  }
  if (normalized.slice(end + 5).trim().length === 0) {
    throw new Error(`Memory topic '${name}' body must not be empty`);
  }
  return {
    name,
    description: parsed.data.description,
    content: normalized,
    fingerprint: memoryFingerprint(normalized),
  };
}

export function assertMemoryTopicBudget(
  scope: MemoryScopeName,
  topicCount: number,
): void {
  if (topicCount > MAX_MEMORY_TOPICS_PER_SCOPE) {
    throw new Error(
      `${MEMORY_SCOPE_DESCRIPTIONS[scope].label} memory would have ${topicCount} topics; merge related topics to stay at or below ${MAX_MEMORY_TOPICS_PER_SCOPE}`,
    );
  }
}

/** One row per topic: `name | description | ./name.md`. */
export function formatMemoryIndex(
  topics: readonly MemoryTopicSummary[],
): string {
  const rows = [...topics]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(({ name, description }) => `${name} | ${description} | ./${name}.md`);
  return rows.length === 0 ? "" : `${rows.join("\n")}\n`;
}

export function memoryScopeHeading(scope: MemoryScopeName): string {
  const { label, meaning } = MEMORY_SCOPE_DESCRIPTIONS[scope];
  return `## Memory — ${label} scope: ${meaning}`;
}

/**
 * Concatenates every non-empty scope index, broadest first, inside a byte
 * budget. Rows that do not fit are dropped with a visible marker.
 */
export function formatMemorySystemSection(
  scopes: readonly {
    readonly scope: MemoryScopeName;
    readonly topics: readonly MemoryTopicSummary[];
  }[],
  maximumBytes = DEFAULT_MEMORY_INDEX_PROMPT_BYTES,
): string | undefined {
  const ordered = MEMORY_SCOPE_ORDER.flatMap((scope) =>
    scopes.filter(
      (candidate) => candidate.scope === scope && candidate.topics.length > 0,
    ),
  );
  if (ordered.length === 0) return undefined;
  const opening = [
    "<memory_index>",
    "Durable memory the user has reviewed, grouped by scope from broadest to narrowest. Narrower scopes override broader ones when they conflict. Each row is `topic | description | file`; read a topic file when it is relevant.",
  ].join("\n");
  const closing = "</memory_index>";
  const truncated = "[memory index truncated]";
  const lines: string[] = [opening];
  let bytes =
    Buffer.byteLength(opening, "utf8") +
    Buffer.byteLength(closing, "utf8") +
    Buffer.byteLength(truncated, "utf8") +
    3;
  let omitted = false;
  for (const { scope, topics } of ordered) {
    const heading = `\n${memoryScopeHeading(scope)}`;
    const headingBytes = Buffer.byteLength(heading, "utf8") + 1;
    if (bytes + headingBytes > maximumBytes) {
      omitted = true;
      break;
    }
    lines.push(heading);
    bytes += headingBytes;
    for (const row of formatMemoryIndex(topics).trimEnd().split("\n")) {
      const rowBytes = Buffer.byteLength(row, "utf8") + 1;
      if (bytes + rowBytes > maximumBytes) {
        omitted = true;
        break;
      }
      lines.push(row);
      bytes += rowBytes;
    }
    if (omitted) break;
  }
  if (omitted) lines.push(truncated);
  lines.push(closing);
  return lines.join("\n");
}

export interface MemoryScopeContents {
  readonly topics: readonly MemoryTopic[];
  readonly diagnostics: readonly {
    readonly path: string;
    readonly message: string;
  }[];
}

async function pathKind(
  path: string,
): Promise<"missing" | "directory" | "file" | "other"> {
  try {
    const details = await lstat(path);
    if (details.isSymbolicLink()) return "other";
    if (details.isDirectory()) return "directory";
    return details.isFile() ? "file" : "other";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

/**
 * Reads every `{topic}.md` in one memory folder. A missing folder is empty
 * memory; invalid topics become diagnostics instead of failing the scope.
 */
export async function readMemoryScope(
  directory: string,
): Promise<MemoryScopeContents> {
  if (!isAbsolute(directory)) {
    throw new Error("Memory directories must be absolute");
  }
  const kind = await pathKind(directory);
  if (kind === "missing") return { topics: [], diagnostics: [] };
  if (kind !== "directory") {
    throw new Error(`Expected a physical memory directory at '${directory}'`);
  }
  const topics: MemoryTopic[] = [];
  const diagnostics: { path: string; message: string }[] = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (!entry.name.endsWith(".md") || entry.name === MEMORY_INDEX_FILE_NAME) {
      continue;
    }
    const path = join(directory, entry.name);
    try {
      if (!entry.isFile())
        throw new Error("Memory topics must be regular files");
      const details = await lstat(path);
      if (details.size > MAX_MEMORY_TOPIC_BYTES) {
        throw new Error(`Memory topic exceeds ${MAX_MEMORY_TOPIC_BYTES} bytes`);
      }
      topics.push(
        parseMemoryTopic(
          entry.name.slice(0, -".md".length),
          await readFile(path, "utf8"),
        ),
      );
    } catch (error) {
      diagnostics.push({
        path,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { topics, diagnostics };
}

export interface MemoryTopicWrite {
  readonly name: string;
  readonly content: string;
  /** Fingerprint the draft was based on; `null` means the topic was new. */
  readonly baseFingerprint: string | null;
}

export interface MemoryTopicDelete {
  readonly name: string;
  readonly baseFingerprint: string;
}

export interface MemoryScopeChange {
  readonly scope: MemoryScopeName;
  readonly directory: string;
  readonly writes: readonly MemoryTopicWrite[];
  readonly deletes: readonly MemoryTopicDelete[];
}

export class StaleMemoryError extends Error {
  readonly code = "stale_memory";
  constructor(
    readonly scope: MemoryScopeName,
    readonly topic: string,
  ) {
    super(
      `${MEMORY_SCOPE_DESCRIPTIONS[scope].label} memory topic '${topic}' changed since the draft was made; re-read it and resubmit`,
    );
  }
}

export interface PublishedMemoryScope {
  readonly scope: MemoryScopeName;
  readonly directory: string;
  readonly topics: readonly MemoryTopic[];
  readonly written: readonly string[];
  readonly deleted: readonly string[];
}

/**
 * Publishes topic changes across several scopes as one unit. Each scope is
 * rebuilt in a staged sibling folder with a regenerated INDEX.md, then all
 * folders are swapped in. Any failure restores every original folder.
 */
export async function publishMemoryChanges(
  changes: readonly MemoryScopeChange[],
): Promise<readonly PublishedMemoryScope[]> {
  const seen = new Set<string>();
  const plans: {
    change: MemoryScopeChange;
    topics: MemoryTopic[];
    existed: boolean;
  }[] = [];
  for (const change of changes) {
    if (!isAbsolute(change.directory)) {
      throw new Error("Memory directories must be absolute");
    }
    if (seen.has(change.directory)) {
      throw new Error(`Memory directory '${change.directory}' appears twice`);
    }
    seen.add(change.directory);
    const names = new Set<string>();
    for (const name of [
      ...change.writes.map((write) => write.name),
      ...change.deletes.map((removal) => removal.name),
    ]) {
      if (names.has(name)) {
        throw new Error(`Memory topic '${name}' is changed twice in one scope`);
      }
      names.add(name);
    }
    const existed = (await pathKind(change.directory)) === "directory";
    const current = await readMemoryScope(change.directory);
    const byName = new Map(current.topics.map((topic) => [topic.name, topic]));
    const invalid = new Set(
      current.diagnostics.map((diagnostic) =>
        basename(diagnostic.path).replace(/\.md$/u, ""),
      ),
    );
    for (const write of change.writes) {
      const existing = byName.get(write.name);
      const actual =
        existing?.fingerprint ?? (invalid.has(write.name) ? "invalid" : null);
      if (actual !== write.baseFingerprint) {
        throw new StaleMemoryError(change.scope, write.name);
      }
      byName.set(write.name, parseMemoryTopic(write.name, write.content));
    }
    for (const removal of change.deletes) {
      if (byName.get(removal.name)?.fingerprint !== removal.baseFingerprint) {
        throw new StaleMemoryError(change.scope, removal.name);
      }
      byName.delete(removal.name);
    }
    assertMemoryTopicBudget(change.scope, byName.size);
    plans.push({ change, topics: [...byName.values()], existed });
  }

  const staged: { directory: string; stage: string; backup?: string }[] = [];
  const swapped: { directory: string; stage: string; backup?: string }[] = [];
  try {
    for (const { change, topics, existed } of plans) {
      const stage = `${change.directory}.${randomUUID()}.staged`;
      await mkdir(dirname(change.directory), { recursive: true, mode: 0o700 });
      if (existed) {
        await cp(change.directory, stage, {
          recursive: true,
          errorOnExist: true,
          verbatimSymlinks: true,
        });
      } else {
        await mkdir(stage, { mode: 0o700 });
      }
      staged.push({
        directory: change.directory,
        stage,
        ...(existed
          ? { backup: `${change.directory}.${randomUUID()}.backup` }
          : {}),
      });
      for (const removal of change.deletes) {
        await rm(join(stage, `${removal.name}.md`), { force: true });
      }
      for (const write of change.writes) {
        await writeFile(join(stage, `${write.name}.md`), write.content, {
          encoding: "utf8",
          mode: 0o600,
        });
      }
      const index = formatMemoryIndex(topics);
      if (index.length === 0) {
        await rm(join(stage, MEMORY_INDEX_FILE_NAME), { force: true });
      } else {
        await writeFile(join(stage, MEMORY_INDEX_FILE_NAME), index, {
          encoding: "utf8",
          mode: 0o600,
        });
      }
    }
    for (const entry of staged) {
      if (entry.backup !== undefined) {
        await rename(entry.directory, entry.backup);
      }
      swapped.push(entry);
      await rename(entry.stage, entry.directory);
    }
  } catch (error) {
    for (const entry of [...swapped].reverse()) {
      if ((await pathKind(entry.directory)) === "directory") {
        await rename(entry.directory, entry.stage).catch(() => undefined);
      }
      if (entry.backup !== undefined) {
        await rename(entry.backup, entry.directory).catch(() => undefined);
      }
    }
    await Promise.all(
      staged.map((entry) => rm(entry.stage, { recursive: true, force: true })),
    );
    throw error;
  }
  await Promise.all(
    swapped.map((entry) =>
      entry.backup === undefined
        ? Promise.resolve()
        : rm(entry.backup, { recursive: true, force: true }),
    ),
  );
  return plans.map(({ change, topics }) => ({
    scope: change.scope,
    directory: change.directory,
    topics: topics.sort((left, right) => left.name.localeCompare(right.name)),
    written: change.writes.map((write) => write.name),
    deleted: change.deletes.map((removal) => removal.name),
  }));
}
