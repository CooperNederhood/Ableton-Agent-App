import { describe, expect, it } from "vitest";

import type { DesktopAgentArtifactReviewRequest } from "../contracts";
import {
  artifactLineDiff,
  artifactReviewBlocker,
  artifactTopicBudget,
} from "./artifact-review";

function memoryReview(
  files: DesktopAgentArtifactReviewRequest["files"],
  topicCount = 0,
): DesktopAgentArtifactReviewRequest {
  return {
    requestId: "review-1",
    draftId: "draft-1",
    kind: "memory",
    summary: "Memory",
    revision: 1,
    maxTopicsPerScope: 3,
    scopes: [
      {
        scope: "project",
        label: "Project",
        meaning: "Project",
        available: true,
        topicCount,
      },
      {
        scope: "session",
        label: "Session",
        meaning: "Session",
        available: true,
        topicCount: 0,
      },
    ],
    files,
  };
}

function topic(
  name: string,
  scope: "project" | "session",
  currentByScope: Partial<Record<"project" | "session", string>> = {},
): DesktopAgentArtifactReviewRequest["files"][number] {
  return {
    id: `memory:${name}@${scope}`,
    kind: "memory_topic",
    name,
    change: "added",
    scope,
    movable: true,
    after: `# ${name}\n`,
    currentByScope,
  };
}

describe("artifact review helpers", () => {
  it("diffs only the changed middle lines", () => {
    const diff = artifactLineDiff("a\nb\nc\nd\n", "a\nx\nc\nd\ne\n");
    expect(diff.lines).toEqual([
      { kind: "same", text: "a" },
      { kind: "del", text: "b" },
      { kind: "add", text: "x" },
      { kind: "same", text: "c" },
      { kind: "same", text: "d" },
      { kind: "add", text: "e" },
    ]);
    expect([diff.added, diff.removed, diff.coarse]).toEqual([2, 1, false]);
  });

  it("falls back to a whole replace beyond the diff budget", () => {
    const before = Array.from({ length: 2_100 }, (_, i) => `a${i}`).join("\n");
    const after = Array.from({ length: 2_100 }, (_, i) => `b${i}`).join("\n");
    const diff = artifactLineDiff(before, after);
    expect(diff.coarse).toBe(true);
    expect([diff.added, diff.removed]).toEqual([2_100, 2_100]);
  });

  it("re-derives topic budgets and blocks over-limit or colliding moves", () => {
    const review = memoryReview(
      [topic("mix", "session"), topic("drums", "session", { project: "x" })],
      3,
    );
    expect(artifactTopicBudget(review, {}).get("session")).toBe(2);
    expect(artifactReviewBlocker(review, {})).toBeUndefined();
    const moved = { "memory:mix@session": "project" as const };
    expect(artifactTopicBudget(review, moved).get("project")).toBe(4);
    expect(artifactReviewBlocker(review, moved)).toBe(
      "Project would hold 4 topics; the limit is 3.",
    );
    const colliding = memoryReview([
      topic("mix", "session"),
      topic("mix", "project"),
    ]);
    expect(
      artifactReviewBlocker(colliding, { "memory:mix@session": "project" }),
    ).toBe("Two changes target 'mix' in Project; move one.");
  });
});
