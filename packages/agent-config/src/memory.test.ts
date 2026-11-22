import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  deleteMemoryTopic,
  formatMemoryIndex,
  formatMemorySystemSection,
  MAX_MEMORY_TOPICS_PER_SCOPE,
  parseMemoryTopic,
  publishMemoryChanges,
  readMemoryScope,
  renameMemoryTopic,
  StaleMemoryError,
  transferMemoryTopic,
} from "./memory.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "memory-test-"));
  roots.push(root);
  return root;
}

function topic(
  name: string,
  description = `About ${name}`,
  body = "Notes.",
): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
}

describe("memory topics", () => {
  it("parses topics whose frontmatter matches the file name", () => {
    expect(parseMemoryTopic("mix-notes", topic("mix-notes"))).toMatchObject({
      name: "mix-notes",
      description: "About mix-notes",
    });
  });

  it.each([
    ["missing frontmatter", "mix-notes", "Just text"],
    ["mismatched name", "mix-notes", topic("other")],
    ["reserved index name", "index", topic("index")],
    ["missing description", "mix-notes", "---\nname: mix-notes\n---\n\nBody\n"],
    ["pipe in description", "mix-notes", topic("mix-notes", "a | b")],
    [
      "empty body",
      "mix-notes",
      "---\nname: mix-notes\ndescription: x\n---\n\n",
    ],
    ["oversized", "mix-notes", topic("mix-notes", "x", "a".repeat(17_000))],
  ])("rejects %s", (_label, name, content) => {
    expect(() => parseMemoryTopic(name, content)).toThrow();
  });

  it("formats a sorted one-row-per-topic index", () => {
    expect(
      formatMemoryIndex([
        { name: "tempo", description: "Tempo habits" },
        { name: "drums", description: "Drum taste" },
      ]),
    ).toBe(
      "drums | Drum taste | ./drums.md\ntempo | Tempo habits | ./tempo.md\n",
    );
  });

  it("orders scopes broadest first and truncates with a visible marker", () => {
    const section = formatMemorySystemSection([
      { scope: "session", topics: [{ name: "today", description: "Today" }] },
      { scope: "profile", topics: [{ name: "taste", description: "Taste" }] },
      { scope: "project", topics: [] },
    ]);
    expect(section).toContain("<memory_index>");
    expect(section!.indexOf("Profile scope")).toBeLessThan(
      section!.indexOf("Session scope"),
    );
    expect(section).not.toContain("Project scope");
    expect(formatMemorySystemSection([])).toBeUndefined();

    const many = Array.from({ length: 19 }, (_, index) => ({
      name: `topic-${index}`,
      description: "d".repeat(150),
    }));
    const truncated = formatMemorySystemSection(
      [{ scope: "profile", topics: many }],
      1200,
    )!;
    expect(Buffer.byteLength(truncated, "utf8")).toBeLessThanOrEqual(1200);
    expect(truncated).toContain("[memory index truncated]");
  });
});

describe("memory scope storage", () => {
  it("treats a missing folder as empty and reports invalid topics", async () => {
    const root = await temporaryRoot();
    expect(await readMemoryScope(join(root, "missing"))).toEqual({
      topics: [],
      diagnostics: [],
    });
    const directory = join(root, "memory");
    await mkdir(directory);
    await writeFile(join(directory, "good.md"), topic("good"));
    await writeFile(join(directory, "bad.md"), "no frontmatter");
    await writeFile(join(directory, "INDEX.md"), "ignored");
    const contents = await readMemoryScope(directory);
    expect(contents.topics.map(({ name }) => name)).toEqual(["good"]);
    expect(contents.diagnostics).toHaveLength(1);
  });

  it("publishes across scopes atomically and regenerates INDEX.md", async () => {
    const root = await temporaryRoot();
    const profile = join(root, "profile", "memory");
    const session = join(root, "session", "memory");
    await mkdir(profile, { recursive: true });
    await writeFile(join(profile, "old.md"), topic("old"));
    const old = (await readMemoryScope(profile)).topics[0]!;

    const published = await publishMemoryChanges([
      {
        scope: "profile",
        directory: profile,
        writes: [
          { name: "taste", content: topic("taste"), baseFingerprint: null },
        ],
        deletes: [{ name: "old", baseFingerprint: old.fingerprint }],
      },
      {
        scope: "session",
        directory: session,
        writes: [
          { name: "today", content: topic("today"), baseFingerprint: null },
        ],
        deletes: [],
      },
    ]);

    expect(published.map(({ scope }) => scope)).toEqual(["profile", "session"]);
    expect((await readdir(profile)).sort()).toEqual(["INDEX.md", "taste.md"]);
    expect(await readFile(join(profile, "INDEX.md"), "utf8")).toBe(
      "taste | About taste | ./taste.md\n",
    );
    expect(await readFile(join(session, "INDEX.md"), "utf8")).toContain(
      "today",
    );
    expect(await readdir(root)).toEqual(["profile", "session"]);
    expect(await readdir(join(root, "profile"))).toEqual(["memory"]);
  });

  it("rejects a stale base and leaves every scope unchanged", async () => {
    const root = await temporaryRoot();
    const profile = join(root, "profile");
    const session = join(root, "session");
    await mkdir(profile);
    await writeFile(join(profile, "taste.md"), topic("taste"));

    await expect(
      publishMemoryChanges([
        {
          scope: "session",
          directory: session,
          writes: [
            { name: "today", content: topic("today"), baseFingerprint: null },
          ],
          deletes: [],
        },
        {
          scope: "profile",
          directory: profile,
          writes: [
            {
              name: "taste",
              content: topic("taste", "Changed"),
              baseFingerprint: "stale",
            },
          ],
          deletes: [],
        },
      ]),
    ).rejects.toBeInstanceOf(StaleMemoryError);
    expect(await readdir(root)).toEqual(["profile"]);
    expect(await readFile(join(profile, "taste.md"), "utf8")).toBe(
      topic("taste"),
    );
  });

  it("enforces the per-scope topic cap", async () => {
    const root = await temporaryRoot();
    const directory = join(root, "memory");
    await expect(
      publishMemoryChanges([
        {
          scope: "project",
          directory,
          writes: Array.from(
            { length: MAX_MEMORY_TOPICS_PER_SCOPE + 1 },
            (_, index) => ({
              name: `topic-${index}`,
              content: topic(`topic-${index}`),
              baseFingerprint: null,
            }),
          ),
          deletes: [],
        },
      ]),
    ).rejects.toThrow(/merge related topics/u);
    expect(await readdir(root)).toEqual([]);
  });

  it("restores already swapped scopes when a later swap fails", async () => {
    const root = await temporaryRoot();
    const first = join(root, "first");
    await mkdir(first);
    await writeFile(join(first, "keep.md"), topic("keep"));
    // A regular file where a parent directory is required forces mkdir to fail.
    await writeFile(join(root, "blocked"), "file");
    await expect(
      publishMemoryChanges([
        {
          scope: "profile",
          directory: first,
          writes: [
            { name: "new", content: topic("new"), baseFingerprint: null },
          ],
          deletes: [],
        },
        {
          scope: "session",
          directory: join(root, "blocked", "memory"),
          writes: [
            { name: "today", content: topic("today"), baseFingerprint: null },
          ],
          deletes: [],
        },
      ]),
    ).rejects.toThrow();
    expect(await readdir(first)).toEqual(["keep.md"]);
    expect((await readdir(root)).sort()).toEqual(["blocked", "first"]);
  });
});

describe("memory topic management", () => {
  async function scopes() {
    const root = await temporaryRoot();
    const profile = { scope: "profile" as const, directory: join(root, "p") };
    const project = { scope: "project" as const, directory: join(root, "q") };
    await mkdir(profile.directory, { recursive: true });
    await writeFile(join(profile.directory, "taste.md"), topic("taste"));
    await writeFile(join(profile.directory, "INDEX.md"), "stale\n");
    return { profile, project };
  }

  it("moves a topic and regenerates INDEX.md in both scopes", async () => {
    const { profile, project } = await scopes();
    await expect(
      transferMemoryTopic({
        operation: "move",
        name: "taste",
        source: profile,
        destination: project,
      }),
    ).resolves.toEqual({ status: "completed" });
    expect(await readdir(profile.directory)).toEqual([]);
    expect(await readFile(join(project.directory, "INDEX.md"), "utf8")).toBe(
      "taste | About taste | ./taste.md\n",
    );
  });

  it("reports a conflict, then replaces or renames on request", async () => {
    const { profile, project } = await scopes();
    await mkdir(project.directory, { recursive: true });
    await writeFile(
      join(project.directory, "taste.md"),
      topic("taste", "Older"),
    );
    const conflict = await transferMemoryTopic({
      operation: "copy",
      name: "taste",
      source: profile,
      destination: project,
    });
    expect(conflict.status).toBe("conflict");

    await transferMemoryTopic({
      operation: "copy",
      name: "taste",
      source: profile,
      destination: project,
      resolution: { rename: "taste-copy" },
    });
    const renamed = await readFile(
      join(project.directory, "taste-copy.md"),
      "utf8",
    );
    expect(renamed).toContain("name: taste-copy");

    await transferMemoryTopic({
      operation: "copy",
      name: "taste",
      source: profile,
      destination: project,
      resolution: "replace",
    });
    expect(
      (await readMemoryScope(project.directory)).topics
        .map(({ name, description }) => [name, description])
        .sort(),
    ).toEqual([
      ["taste", "About taste"],
      ["taste-copy", "About taste"],
    ]);
    expect((await readMemoryScope(profile.directory)).topics).toHaveLength(1);
  });

  it("rejects a transfer into the same scope", async () => {
    const { profile } = await scopes();
    await expect(
      transferMemoryTopic({
        operation: "copy",
        name: "taste",
        source: profile,
        destination: profile,
      }),
    ).rejects.toThrow("same scope");
  });

  it("renames and deletes topics, refusing an existing name", async () => {
    const { profile } = await scopes();
    await writeFile(join(profile.directory, "mix.md"), topic("mix"));
    await expect(
      renameMemoryTopic({ ...profile, name: "taste", newName: "mix" }),
    ).rejects.toThrow("already exists");

    await renameMemoryTopic({ ...profile, name: "taste", newName: "sound" });
    expect(
      await readFile(join(profile.directory, "sound.md"), "utf8"),
    ).toContain("name: sound");

    await deleteMemoryTopic({ ...profile, name: "mix" });
    expect(await readFile(join(profile.directory, "INDEX.md"), "utf8")).toBe(
      "sound | About taste | ./sound.md\n",
    );
    await expect(
      deleteMemoryTopic({ ...profile, name: "missing" }),
    ).rejects.toThrow();
  });
});
