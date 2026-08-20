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
