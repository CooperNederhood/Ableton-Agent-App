import { memoryFingerprint } from "@ableton-agent/agent-config";
import { describe, expect, it } from "vitest";

import {
  ArtifactDraft,
  authoringKindForSkill,
  parseArtifactPath,
  type ArtifactAuthoringContext,
} from "./artifact-authoring.js";

const topic = (name: string, description: string, body = "Body.") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;

const existingMix = topic("mixing", "Mix habits");

function context(
  overrides: Partial<ArtifactAuthoringContext> = {},
): ArtifactAuthoringContext {
  return {
    memory: [
      { scope: "system", available: true, topics: [] },
      {
        scope: "profile",
        available: true,
        topics: [
          {
            name: "mixing",
            description: "Mix habits",
            content: existingMix,
            fingerprint: memoryFingerprint(existingMix),
          },
        ],
      },
      {
        scope: "project",
        available: false,
        unavailableReason: "no verified Live Project",
        topics: [],
      },
      { scope: "live-set", available: true, topics: [] },
      { scope: "session", available: true, topics: [] },
    ],
    skillScopes: [
      { scope: "system", available: true },
      { scope: "profile", available: true },
      { scope: "project", available: false, unavailableReason: "no project" },
      { scope: "session", available: true },
    ],
    skills: [
      {
        name: "mix-review",
        description: "Review a mix",
        origin: "system",
        content:
          "---\nname: mix-review\ndescription: Review a mix\n---\n\nOld.\n",
        fingerprint: "skill-fp",
      },
    ],
    ...overrides,
  };
}

const skill = (name: string, description: string, body = "Do it.") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;

describe("artifact authoring drafts", () => {
  it("maps only the bundled authoring skills to draft kinds", () => {
    expect(authoringKindForSkill("update-memory")).toBe("memory");
    expect(authoringKindForSkill("learn-skill")).toBe("skill");
    expect(authoringKindForSkill("toString")).toBeUndefined();
  });

  it.each([
    "memory/galaxy/x.md",
    "memory/profile/x.txt",
    "../etc/passwd",
    "skills/a/b/SKILL.md",
    "memory/profile/index.md",
  ])("rejects path %s", (path) => {
    expect(() => parseArtifactPath(path)).toThrow();
  });

  it("refuses to write the generated INDEX.md", () => {
    const draft = new ArtifactDraft(
      "memory",
      "update-memory",
      context(),
      undefined,
    );
    expect(() => draft.write("memory/profile/INDEX.md", "anything")).toThrow(
      /generated/,
    );
  });

  it("replaces draft changes with the workspace edits", () => {
    const draft = new ArtifactDraft(
      "memory",
      "update-memory",
      context(),
      undefined,
    );
    draft.write("memory/session/stale.md", topic("stale", "Stale"));
    draft.applyWorkspaceChanges(
      new Map([
        ["memory/session/genres.md", topic("genres", "Genres")],
        ["memory/profile/mixing.md", null],
      ]),
    );
    expect(draft.changeCount).toBe(2);
    expect(draft.describe("/ws")).toContain('workspace="/ws"');
    expect(draft.writableMemoryScopes).toEqual([
      "system",
      "profile",
      "live-set",
      "session",
    ]);
    expect(() =>
      draft.applyWorkspaceChanges(
        new Map([["memory/session/bad.md", topic("other", "Wrong")]]),
      ),
    ).toThrow();
  });

  it("validates topics on write and guards unavailable or forced scopes", () => {
    const draft = new ArtifactDraft(
      "memory",
      "update-memory",
      context(),
      undefined,
    );
    expect(() =>
      draft.write("memory/profile/sidechain.md", topic("other", "Wrong name")),
    ).toThrow();
    expect(() =>
      draft.write("memory/project/drums.md", topic("drums", "Drums")),
    ).toThrow(/unavailable/);
    expect(() => draft.write("skills/x/SKILL.md", skill("x", "X"))).toThrow(
      /memory draft/,
    );

    const forced = new ArtifactDraft(
      "memory",
      "update-memory",
      context(),
      "session",
    );
    expect(() => forced.write("memory/profile/a.md", topic("a", "A"))).toThrow(
      /Session scope/i,
    );
    expect(
      () => new ArtifactDraft("memory", "update-memory", context(), "project"),
    ).toThrow(/unavailable/);
  });

  it("moves a reviewed topic to a new scope with the right base fingerprint", () => {
    const draft = new ArtifactDraft(
      "memory",
      "update-memory",
      context(),
      undefined,
    );
    draft.write("memory/session/mixing.md", topic("mixing", "Mix habits v2"));
    draft.delete("memory/profile/mixing.md");
    const review = draft.review("req-1", "Promote mixing");
    expect(review.files.map(({ id, change }) => [id, change])).toEqual([
      ["memory:mixing@profile", "deleted"],
      ["memory:mixing@session", "added"],
    ]);
    expect(() =>
      draft.publication(review, [
        { fileId: "memory:mixing@session", scope: "profile" },
      ]),
    ).toThrow(/Two draft changes/);

    const promoted = new ArtifactDraft(
      "memory",
      "update-memory",
      context(),
      undefined,
    );
    promoted.write(
      "memory/session/mixing.md",
      topic("mixing", "Mix habits v2"),
    );
    const promotedReview = promoted.review("req-2", "Promote");
    expect(
      promoted.publication(promotedReview, [
        { fileId: "memory:mixing@session", scope: "profile" },
      ]),
    ).toEqual({
      kind: "memory",
      scopes: [
        {
          scope: "profile",
          writes: [
            {
              name: "mixing",
              content: topic("mixing", "Mix habits v2"),
              baseFingerprint: memoryFingerprint(existingMix),
            },
          ],
          deletes: [],
        },
      ],
    });
  });

  it("enforces the per-scope topic budget at review time", () => {
    const draft = new ArtifactDraft(
      "memory",
      "update-memory",
      context(),
      undefined,
    );
    for (let index = 0; index < 20; index += 1) {
      draft.write(`memory/session/t${index}.md`, topic(`t${index}`, "T"));
    }
    expect(() => draft.review("req", "Too many")).toThrow();
  });

  it("holds one skill, locks existing descriptions, and refuses Live Set scope", () => {
    expect(
      () => new ArtifactDraft("skill", "learn-skill", context(), "live-set"),
    ).toThrow(/Live Set/);
    const draft = new ArtifactDraft(
      "skill",
      "learn-skill",
      context(),
      undefined,
    );
    expect(() =>
      draft.write(
        "skills/mix-review/SKILL.md",
        skill("mix-review", "New desc"),
      ),
    ).toThrow(/locked/);
    draft.write(
      "skills/mix-review/SKILL.md",
      skill("mix-review", "Review a mix", "New."),
    );
    expect(() =>
      draft.write("skills/other/SKILL.md", skill("other", "Other")),
    ).toThrow(/one skill/);
    expect(() => draft.delete("skills/mix-review/SKILL.md")).toThrow();

    const review = draft.review("req", "Improve mix review");
    expect(review.files[0]).toMatchObject({
      id: "skill:mix-review",
      change: "modified",
      scope: "profile",
      existingOrigin: "system",
    });
    expect(() =>
      draft.publication(review, [
        { fileId: "skill:mix-review", scope: "project" },
      ]),
    ).toThrow(/unavailable/);
    expect(
      draft.publication(review, [
        { fileId: "skill:mix-review", scope: "session" },
      ]),
    ).toMatchObject({
      kind: "skill",
      scope: "session",
      name: "mix-review",
      description: "Review a mix",
      baseFingerprint: "skill-fp",
    });
  });

  it("refuses to submit an empty draft", () => {
    const draft = new ArtifactDraft(
      "memory",
      "update-memory",
      context(),
      undefined,
    );
    expect(() => draft.review("req", "Nothing")).toThrow(/no changes/);
  });
});
