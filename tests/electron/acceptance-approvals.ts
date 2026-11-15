import {
  resolvePermissionArguments,
  validatePermission,
  type Facts,
  type ScenarioPermission,
  type SessionSourceEvidence,
  type ArrangementSourceEvidence,
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
    source?: SessionSourceEvidence | ArrangementSourceEvidence,
    stepId?: string,
    sources: Readonly<
      Record<string, SessionSourceEvidence | ArrangementSourceEvidence>
    > = {},
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
        rule.risk !== request.risk
      )
        return [];
      const selected =
        rule.sourceId === undefined ? source : sources[rule.sourceId];
      if (rule.sourceId !== undefined && !selected) return [];
      if (
        !selected &&
        Object.values(rule.arguments).some(
          (value) => typeof value === "string" && value.startsWith("$source."),
        )
      )
        return [];
      let resolved: Facts;
      try {
        resolved = resolvePermissionArguments(rule, selected);
      } catch {
        return [];
      }
      const normalized = { ...actual };
      if (rule.sourceId && rule.tool === "ableton_listening") {
        const defaultDuration =
          rule.action === "play-session-and-listen"
            ? 300_000
            : rule.action === "play-arrangement-and-listen"
              ? 900_000
              : undefined;
        if (
          defaultDuration !== undefined &&
          !Object.hasOwn(resolved, "maximumDurationMs") &&
          normalized.maximumDurationMs === defaultDuration
        )
          delete normalized.maximumDurationMs;
        if (
          defaultDuration !== undefined &&
          resolved.maximumDurationMs === defaultDuration &&
          !Object.hasOwn(normalized, "maximumDurationMs")
        )
          normalized.maximumDurationMs = defaultDuration;
        if (
          rule.action === "play-session-and-listen" &&
          selected &&
          "midi" in selected
        ) {
          const settings = selected.midi.source.settings;
          const start = settings.looping
            ? settings.loopStart
            : settings.startMarker;
          const end = settings.looping ? settings.loopEnd : settings.endMarker;
          if (
            typeof start === "number" &&
            typeof end === "number" &&
            end > start
          ) {
            const duration = end - start;
            if (
              !Object.hasOwn(resolved, "durationBeats") &&
              normalized.durationBeats === duration
            )
              delete normalized.durationBeats;
            if (
              resolved.durationBeats === duration &&
              !Object.hasOwn(normalized, "durationBeats")
            )
              normalized.durationBeats = duration;
          }
        }
      }
      const exact =
        Object.keys(resolved).length === Object.keys(normalized).length &&
        Object.entries(resolved).every(
          ([key, expected]) =>
            Object.hasOwn(normalized, key) && normalized[key] === expected,
        );
      return exact ? [index] : [];
    });
    if (
      matches.length === 0 &&
      request.tool === "ableton_context" &&
      request.action === "derive-features" &&
      request.arguments !== null &&
      typeof request.arguments === "object" &&
      "contextIds" in request.arguments &&
      Array.isArray(request.arguments.contextIds)
    ) {
      const args = request.arguments;
      const ids: unknown[] = request.arguments.contextIds;
      if (
        ids.length < 2 ||
        ids.length > 8 ||
        ids.some((id) => typeof id !== "string") ||
        new Set(ids).size !== ids.length
      )
        return false;
      const transaction = new ScopedApprovalPolicy(this.permissions);
      this.#uses.forEach((value, key) => transaction.#uses.set(key, value));
      this.#usedSteps.forEach((key) => transaction.#usedSteps.add(key));
      for (const id of ids)
        if (
          !transaction.decide(
            { ...request, arguments: { ...args, contextIds: [id] } },
            owner,
            source,
            stepId,
            sources,
          )
        )
          return false;
      this.#uses.clear();
      transaction.#uses.forEach((value, key) => this.#uses.set(key, value));
      this.#usedSteps.clear();
      transaction.#usedSteps.forEach((key) => this.#usedSteps.add(key));
      return true;
    }
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
