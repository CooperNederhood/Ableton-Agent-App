export interface ToolPatternResolution {
  readonly tools: string[];
  readonly unmatchedPatterns: string[];
}

function patternExpression(pattern: string): RegExp {
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[\\^$+?.()|[\]{}]/gu, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`, "u");
}

export function resolveToolPatterns(
  patterns: readonly string[],
  availableTools: readonly string[],
): ToolPatternResolution {
  const available = [...new Set(availableTools)].sort();
  const selected = new Set<string>();
  const unmatchedPatterns: string[] = [];
  for (const pattern of patterns) {
    const expression = patternExpression(pattern);
    const matches = available.filter((tool) => expression.test(tool));
    if (matches.length === 0) {
      unmatchedPatterns.push(pattern);
      continue;
    }
    for (const match of matches) selected.add(match);
  }
  return {
    tools: [...selected].sort(),
    unmatchedPatterns,
  };
}
