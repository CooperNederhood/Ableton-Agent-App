export interface ToolPatternResolution {
  readonly tools: string[];
  readonly operationIds: string[];
  readonly explicitAliases: string[];
  readonly unmatchedPatterns: string[];
}

export interface ToolOperationPatternEntry {
  readonly operationId: string;
  readonly toolName: string;
}

export interface ToolPatternOptions {
  readonly operations?: readonly ToolOperationPatternEntry[];
  readonly compatibilityAliases?: Readonly<Record<string, string>>;
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
  options: ToolPatternOptions = {},
): ToolPatternResolution {
  const available = [...new Set(availableTools)].sort();
  const operations = [...(options.operations ?? [])].sort((left, right) =>
    left.operationId.localeCompare(right.operationId),
  );
  const aliases = options.compatibilityAliases ?? {};
  const selected = new Set<string>();
  const selectedOperations = new Set<string>();
  const explicitAliases = new Set<string>();
  const unmatchedPatterns: string[] = [];
  for (const pattern of patterns) {
    const expression = patternExpression(pattern);
    const isWildcard = pattern.includes("*");
    const aliasMatches = isWildcard
      ? available.filter(
          (tool) => expression.test(tool) && aliases[tool] !== undefined,
        )
      : [];
    const canonicalAliasMatches = aliasMatches.flatMap((alias) => {
      const operationId = aliases[alias];
      const operation = operations.find(
        (candidate) => candidate.operationId === operationId,
      );
      return operation !== undefined && available.includes(operation.toolName)
        ? [operation]
        : [];
    });
    const toolMatches = available.filter(
      (tool) =>
        expression.test(tool) && (!isWildcard || aliases[tool] === undefined),
    );
    const operationMatches = operations.filter((operation) =>
      expression.test(operation.operationId),
    );
    if (
      toolMatches.length === 0 &&
      operationMatches.length === 0 &&
      canonicalAliasMatches.length === 0
    ) {
      unmatchedPatterns.push(pattern);
      continue;
    }
    for (const match of toolMatches) {
      selected.add(match);
      const aliasOperation = aliases[match];
      if (!isWildcard && aliasOperation !== undefined) {
        explicitAliases.add(match);
        selectedOperations.add(aliasOperation);
      }
      for (const operation of operations) {
        if (operation.toolName === match) {
          selectedOperations.add(operation.operationId);
        }
      }
    }
    for (const operation of operationMatches) {
      selected.add(operation.toolName);
      selectedOperations.add(operation.operationId);
    }
    for (const operation of canonicalAliasMatches) {
      selected.add(operation.toolName);
      selectedOperations.add(operation.operationId);
    }
  }
  return {
    tools: [...selected].sort(),
    operationIds: [...selectedOperations].sort(),
    explicitAliases: [...explicitAliases].sort(),
    unmatchedPatterns,
  };
}
