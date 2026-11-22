import type {
  DesktopAgentArtifactReviewRequest,
  DesktopAgentArtifactScope,
} from "../contracts.js";

type ReviewFile = DesktopAgentArtifactReviewRequest["files"][number];

export type ArtifactDiffLine = {
  readonly kind: "same" | "add" | "del";
  readonly text: string;
};

export interface ArtifactDiff {
  readonly lines: readonly ArtifactDiffLine[];
  readonly added: number;
  readonly removed: number;
  /** True when inputs exceeded the LCS budget and a whole-file replace is shown. */
  readonly coarse: boolean;
}

export const artifactScopeOrder: readonly DesktopAgentArtifactScope[] = [
  "system",
  "profile",
  "project",
  "live-set",
  "session",
];

export const artifactScopeGlyph: Readonly<
  Record<DesktopAgentArtifactScope, string>
> = {
  system: "◆",
  profile: "●",
  project: "■",
  "live-set": "▲",
  session: "○",
};

const maxDiffCells = 4_000_000;

function splitLines(content: string): string[] {
  if (content.length === 0) return [];
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

export function artifactLineDiff(before: string, after: string): ArtifactDiff {
  const a = splitLines(before);
  const b = splitLines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start += 1;
  }
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const head = a
    .slice(0, start)
    .map((text) => ({ kind: "same" as const, text }));
  const tail = a.slice(endA).map((text) => ({ kind: "same" as const, text }));
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const coarse = (midA.length + 1) * (midB.length + 1) > maxDiffCells;
  const middle: ArtifactDiffLine[] = coarse
    ? [
        ...midA.map((text) => ({ kind: "del" as const, text })),
        ...midB.map((text) => ({ kind: "add" as const, text })),
      ]
    : lcsDiff(midA, midB);
  const lines = [...head, ...middle, ...tail];
  return {
    lines,
    added: lines.filter(({ kind }) => kind === "add").length,
    removed: lines.filter(({ kind }) => kind === "del").length,
    coarse,
  };
}

function lcsDiff(
  a: readonly string[],
  b: readonly string[],
): ArtifactDiffLine[] {
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        a[i] === b[j]
          ? table[(i + 1) * width + j + 1]! + 1
          : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    }
  }
  const lines: ArtifactDiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({ kind: "same", text: a[i]! });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) {
      lines.push({ kind: "del", text: a[i]! });
      i += 1;
    } else {
      lines.push({ kind: "add", text: b[j]! });
      j += 1;
    }
  }
  for (; i < a.length; i += 1) lines.push({ kind: "del", text: a[i]! });
  for (; j < b.length; j += 1) lines.push({ kind: "add", text: b[j]! });
  return lines;
}

export function artifactFileTarget(
  file: ReviewFile,
  targets: Readonly<Record<string, DesktopAgentArtifactScope>> | undefined,
): DesktopAgentArtifactScope {
  return file.movable ? (targets?.[file.id] ?? file.scope) : file.scope;
}

/** The change this file makes when published to `scope`, re-derived after a scope move. */
export function artifactFileChange(
  file: ReviewFile,
  scope: DesktopAgentArtifactScope,
): "added" | "modified" | "deleted" | "unchanged" {
  if (file.after === null) return "deleted";
  const current = file.currentByScope[scope];
  if (current === undefined) return "added";
  return current === file.after ? "unchanged" : "modified";
}

export function artifactFileDiff(
  file: ReviewFile,
  scope: DesktopAgentArtifactScope,
): ArtifactDiff {
  return artifactLineDiff(file.currentByScope[scope] ?? "", file.after ?? "");
}

/** Topic count per scope after publishing the draft with the reviewer's targets. */
export function artifactTopicBudget(
  review: DesktopAgentArtifactReviewRequest,
  targets: Readonly<Record<string, DesktopAgentArtifactScope>> | undefined,
): Map<DesktopAgentArtifactScope, number> {
  const counts = new Map<DesktopAgentArtifactScope, number>();
  for (const scope of review.scopes) {
    if (scope.topicCount !== undefined)
      counts.set(scope.scope, scope.topicCount);
  }
  if (review.kind !== "memory") return counts;
  for (const file of review.files) {
    const scope = artifactFileTarget(file, targets);
    const change = artifactFileChange(file, scope);
    const delta = change === "added" ? 1 : change === "deleted" ? -1 : 0;
    counts.set(scope, (counts.get(scope) ?? 0) + delta);
  }
  return counts;
}

export function artifactReviewTargets(
  review: DesktopAgentArtifactReviewRequest,
  targets: Readonly<Record<string, DesktopAgentArtifactScope>> | undefined,
): { fileId: string; scope: DesktopAgentArtifactScope }[] {
  return review.files
    .filter((file) => file.movable)
    .map((file) => ({
      fileId: file.id,
      scope: artifactFileTarget(file, targets),
    }));
}

/** First blocking problem with the reviewer's current targets, if any. */
export function artifactReviewBlocker(
  review: DesktopAgentArtifactReviewRequest,
  targets: Readonly<Record<string, DesktopAgentArtifactScope>> | undefined,
): string | undefined {
  const claimed = new Set<string>();
  for (const file of review.files) {
    const scope = artifactFileTarget(file, targets);
    const state = review.scopes.find((candidate) => candidate.scope === scope);
    if (state === undefined || !state.available) {
      return `${state?.label ?? scope} is unavailable${state?.unavailableReason ? `: ${state.unavailableReason}` : ""}.`;
    }
    const key = `${scope}/${file.name}`;
    if (claimed.has(key)) {
      return `Two changes target '${file.name}' in ${state.label}; move one.`;
    }
    claimed.add(key);
    const shadow = artifactSkillShadow(file, scope);
    if (shadow !== undefined) return shadow;
  }
  for (const [scope, count] of artifactTopicBudget(review, targets)) {
    if (count > review.maxTopicsPerScope) {
      const label =
        review.scopes.find((candidate) => candidate.scope === scope)?.label ??
        scope;
      return `${label} would hold ${count} topics; the limit is ${review.maxTopicsPerScope}.`;
    }
  }
  return undefined;
}

/** Explains when a narrower existing skill would hide the published one. */
export function artifactSkillShadow(
  file: ReviewFile,
  scope: DesktopAgentArtifactScope,
): string | undefined {
  const origin = file.existingOrigin;
  if (file.kind !== "skill" || origin === undefined || origin === "bundled") {
    return undefined;
  }
  return artifactScopeOrder.indexOf(origin) > artifactScopeOrder.indexOf(scope)
    ? `A ${origin} skill named '${file.name}' would still win over this one; publish to ${origin} or narrower.`
    : undefined;
}
