import type { MemoryScopeName } from "./memory.js";
import { skillNameSchema } from "./schemas.js";

export interface SkillInvocation {
  readonly skillName: string;
  readonly request: string;
}

export class InvalidSkillInvocationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "InvalidSkillInvocationError";
  }
}

export function parseSkillInvocation(
  input: string,
): SkillInvocation | undefined {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return undefined;

  const separator = trimmed.search(/\s/u);
  const token = trimmed.slice(1, separator === -1 ? undefined : separator);
  const skillName = skillNameSchema.safeParse(token);
  if (!skillName.success) {
    throw new InvalidSkillInvocationError(
      "Invalid skill invocation. Use /skill-name followed by an optional request.",
    );
  }

  return {
    skillName: skillName.data,
    request: separator === -1 ? "" : trimmed.slice(separator).trim(),
  };
}

export function formatSkillInvocation(invocation: SkillInvocation): string {
  const skillName = skillNameSchema.parse(invocation.skillName);
  return invocation.request.length === 0
    ? `/${skillName}`
    : `/${skillName} ${invocation.request}`;
}

const scopeTokenAliases: Readonly<Record<string, MemoryScopeName>> = {
  system: "system",
  profile: "profile",
  project: "project",
  set: "live-set",
  "live-set": "live-set",
  session: "session",
};

/**
 * Extracts an optional `--scope <scope>` token from an authoring request.
 * `set` is accepted as shorthand for the Live Set scope.
 */
export function parseArtifactScopeToken(request: string): {
  readonly scope?: MemoryScopeName;
  readonly request: string;
} {
  const match = /(^|\s)--scope(?:=|\s+)(\S+)(?=\s|$)/u.exec(request);
  if (match === null) {
    if (/(^|\s)--scope(\s|=|$)/u.test(request)) {
      throw new InvalidSkillInvocationError(
        "--scope needs a value: system, profile, project, set, or session.",
      );
    }
    return { request: request.trim() };
  }
  const scope = scopeTokenAliases[match[2]!.toLowerCase()];
  if (scope === undefined) {
    throw new InvalidSkillInvocationError(
      `Unknown scope '${match[2]}'. Use system, profile, project, set, or session.`,
    );
  }
  return {
    scope,
    request: `${request.slice(0, match.index)}${match[1]}${request.slice(
      match.index + match[0].length,
    )}`
      .replace(/\s+/gu, " ")
      .trim(),
  };
}
