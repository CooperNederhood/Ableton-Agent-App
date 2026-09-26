export interface ToolPatternResolution {
  readonly tools: string[];
  readonly unmatchedPatterns: string[];
}

export interface ToolPatternResolutionOptions {
  readonly wildcardExcludedTools?: readonly string[];
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
  options: ToolPatternResolutionOptions = {},
): ToolPatternResolution {
  const available = [...new Set(availableTools)].sort();
  const wildcardExcluded = new Set(options.wildcardExcludedTools ?? []);
  const selected = new Set<string>();
  const unmatchedPatterns: string[] = [];
  for (const pattern of patterns) {
    const expression = patternExpression(pattern);
    const matches = available.filter(
      (tool) =>
        expression.test(tool) &&
        (!pattern.includes("*") || !wildcardExcluded.has(tool)),
    );
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
