import {
  resolvePermissionArguments,
  validatePermission,
  type Facts,
  type ScenarioPermission,
  type SessionSourceEvidence,
} from "@ableton-agent/test-support/integration";

export type ScopedPermission = ScenarioPermission;
export interface ScopedApproval {
  readonly tool: string;
  readonly action: string;
  readonly risk: string;
  readonly destructive: boolean;
  readonly arguments: unknown;
  readonly operationId: string;
  readonly appSessionId: string;
  readonly agentId: string;
  readonly conversationId: string;
}
export type ApprovalOwner = Pick<
  ScopedApproval,
  "operationId" | "appSessionId" | "agentId" | "conversationId"
>;

function flatten(value: unknown): Facts {
  const result: Record<string, string | number | boolean | null> = {};
  const walk = (item: unknown, path: string, depth: number) => {
    if (depth > 8 || Object.keys(result).length > 64)
      throw new Error("Approval arguments exceed their bound");
    if (
      item === null ||
      typeof item === "boolean" ||
      (typeof item === "number" && Number.isFinite(item)) ||
      typeof item === "string"
    ) {
      if (
        !path ||
        (typeof item === "string" &&
          (item.length > 2048 ||
            /\[(?:redacted|truncated|omitted)[^\]]*\]/iu.test(item)))
      )
        throw new Error(
          "Approval arguments are missing, redacted or truncated",
        );
      result[path] = item;
      return;
    }
    if (item === null || typeof item !== "object")
      throw new Error("Unsupported structured approval arguments");
    const prototype: unknown = Object.getPrototypeOf(item);
    if (
      !Array.isArray(item) &&
      prototype !== null &&
      prototype !== Object.prototype
    )
      throw new Error("Unsupported structured approval arguments");
    const entries = Object.entries(item);
    if (entries.length > 64 || (path && entries.length === 0))
      throw new Error("Ambiguous or oversized approval argument container");
    for (const [key, nested] of entries) {
      if (
        !/^[a-zA-Z0-9_-]+$/u.test(key) ||
        ["__proto__", "prototype", "constructor"].includes(key)
      )
        throw new Error("Unsafe approval argument key");
      walk(nested, path ? `${path}.${key}` : key, depth + 1);
    }
  };
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Approval arguments must be an object");
  walk(value, "", 0);
  if (Object.keys(result).length > 64)
    throw new Error("Approval argument count exceeded");
  return result;
}

export class ScopedApprovalPolicy {
  readonly #uses = new Map<number, number>();
  readonly #usedSteps = new Set<string>();
  constructor(private readonly permissions: readonly ScopedPermission[]) {
    permissions.forEach(validatePermission);
  }

  decide(
    request: ScopedApproval,
    owner: ApprovalOwner,
    source?: SessionSourceEvidence,
    stepId?: string,
  ): boolean {
    if (
      request.destructive ||
      !["low", "medium"].includes(request.risk) ||
      Object.entries(owner).some(
        ([key, value]) => request[key as keyof ApprovalOwner] !== value,
      )
    )
      return false;
    const actual = flatten(request.arguments);
    const matches = this.permissions.flatMap((rule, index) => {
      if (
        (rule.stepIds !== undefined &&
          (!stepId || !rule.stepIds.includes(stepId))) ||
        rule.tool !== request.tool ||
        rule.action !== request.action ||
        rule.risk !== request.risk ||
        Object.keys(rule.arguments).length !== Object.keys(actual).length
      )
        return [];
      if (
        !source &&
        Object.values(rule.arguments).some(
          (value) => typeof value === "string" && value.startsWith("$source."),
        )
      )
        return [];
      const exact = Object.entries(
        resolvePermissionArguments(rule, source),
      ).every(
        ([key, expected]) =>
          Object.hasOwn(actual, key) && actual[key] === expected,
      );
      return exact ? [index] : [];
    });
    if (matches.length !== 1) return false;
    const index = matches[0]!;
    const stepKey = `${index}:${stepId}`;
    if (this.permissions[index]!.stepIds && this.#usedSteps.has(stepKey))
      return false;
    const count = this.#uses.get(index) ?? 0;
    if (count >= this.permissions[index]!.maxUses) return false;
    this.#uses.set(index, count + 1);
    if (this.permissions[index]!.stepIds) this.#usedSteps.add(stepKey);
    return true;
  }
}
