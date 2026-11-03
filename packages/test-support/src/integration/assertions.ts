import type {
  Assertion,
  AssertionInput,
  AssertionReference,
  AssertionResult,
  Facts,
  SourceIdentity,
} from "./contracts.js";
import {
  identifier,
  rejectUnknownFields,
  requireCondition,
  validateFacts,
} from "./validation.js";

export class AssertionRegistry {
  private readonly entries = new Map<
    string,
    { check: Assertion; validate: (parameters: Facts) => void }
  >();
  register(
    name: string,
    check: Assertion,
    validate: (parameters: Facts) => void = validateFacts,
  ): this {
    identifier(name);
    requireCondition(!this.entries.has(name), `Duplicate assertion: ${name}`);
    this.entries.set(name, { check, validate });
    return this;
  }
  get names(): ReadonlySet<string> {
    return new Set(this.entries.keys());
  }
  validate(reference: AssertionReference): void {
    const entry = this.entries.get(reference.name);
    requireCondition(entry, `Unknown assertion: ${reference.name}`);
    validateFacts(reference.parameters);
    entry.validate(reference.parameters);
  }
  evaluate(
    reference: AssertionReference,
    input: AssertionInput,
  ): AssertionResult {
    this.validate(reference);
    const result = this.entries
      .get(reference.name)!
      .check(input, reference.parameters);
    requireCondition(
      typeof result.passed === "boolean" &&
        typeof result.code === "string" &&
        result.code.length > 0 &&
        result.code.length <= 256 &&
        typeof result.detail === "string" &&
        result.detail.length > 0 &&
        result.detail.length <= 8192,
      "Invalid assertion result",
    );
    return {
      name: reference.name,
      passed: result.passed,
      code: result.code,
      detail: result.detail,
    };
  }
}
function result(
  passed: boolean,
  code: string,
  detail: string,
): Omit<AssertionResult, "name"> {
  return { passed, code: passed ? "ok" : code, detail };
}
export function sameSource(
  left: SourceIdentity,
  right: SourceIdentity,
): boolean {
  return (
    left.trackId === right.trackId &&
    left.clipId === right.clipId &&
    left.slotIndex === right.slotIndex &&
    left.mediaSha256 === right.mediaSha256
  );
}
export function parseParenthesizedChoice(
  text: string,
):
  | { readonly valid: true; readonly choice: "A" | "B" | "C" | "D" }
  | { readonly valid: false } {
  const match = /^\(([A-D])\)$/.exec(text.trim());
  const choice = match?.[1];
  return choice === "A" || choice === "B" || choice === "C" || choice === "D"
    ? { valid: true, choice }
    : { valid: false };
}
function requiredStrings(parameters: Facts, keys: readonly string[]): void {
  for (const key of keys)
    requireCondition(
      typeof parameters[key] === "string" && String(parameters[key]).length > 0,
      `Missing assertion parameter: ${key}`,
    );
}
export function createDefaultAssertions(): AssertionRegistry {
  return new AssertionRegistry()
    .register(
      "choice",
      ({ turn }, parameters) => {
        if (!turn)
          return result(
            false,
            "missing-turn",
            "Choice requires a terminal turn",
          );
        const parsed = parseParenthesizedChoice(turn.assistantText);
        if (!parsed.valid)
          return result(
            false,
            "invalid-format",
            "Expected one uppercase parenthesized letter",
          );
        return result(
          parsed.choice === parameters.expected,
          "incorrect-choice",
          `Observed ${parsed.choice}`,
        );
      },
      (parameters) => {
        rejectUnknownFields(parameters, ["expected"]);
        requireCondition(
          ["A", "B", "C", "D"].includes(String(parameters.expected)),
          "Invalid expected choice",
        );
      },
    )
    .register(
      "fact-equals",
      ({ turn, evidence }, parameters) => {
        const facts = turn?.facts ?? evidence?.facts;
        const key = String(parameters.key);
        return result(
          !!facts &&
            Object.hasOwn(facts, key) &&
            facts[key] === parameters.expected,
          "fact-mismatch",
          `Fact ${key}`,
        );
      },
      (parameters) => {
        rejectUnknownFields(parameters, ["key", "expected"]);
        requiredStrings(parameters, ["key"]);
        requireCondition(
          Object.hasOwn(parameters, "expected"),
          "Missing expected fact",
        );
      },
    )
    .register(
      "capture",
      ({ turn, baseline }, parameters) => {
        if (!baseline.source || !baseline.listenerId)
          return result(
            false,
            "missing-source",
            "Capture requires independently read source and listener evidence",
          );
        const capture = turn?.captures[0];
        if (!turn || turn.captures.length !== 1 || !capture)
          return result(false, "capture-count", "Exactly one capture required");
        if (
          !sameSource(capture.source, baseline.source) ||
          capture.listenerId !== baseline.listenerId ||
          capture.operationId !== turn.operationId
        )
          return result(
            false,
            "wrong-source",
            "Capture source, listener, or operation mismatch",
          );
        const families = String(parameters.metricFamilies).split(",");
        const complete =
          capture.complete &&
          capture.nonSilent &&
          !capture.truncated &&
          capture.missingRecords === 0 &&
          capture.cleanupComplete &&
          capture.failure === null &&
          capture.sampleRate === parameters.sampleRate &&
          capture.endSample - capture.startSample ===
            parameters.expectedFrames &&
          families.every((family) => capture.metricFamilies.includes(family));
        return result(
          complete,
          "incomplete-capture",
          "Capture must satisfy independent coverage and quality oracle",
        );
      },
      (parameters) => {
        rejectUnknownFields(parameters, [
          "metricFamilies",
          "sampleRate",
          "expectedFrames",
        ]);
        requiredStrings(parameters, ["metricFamilies"]);
        for (const key of ["sampleRate", "expectedFrames"])
          requireCondition(
            typeof parameters[key] === "number" &&
              Number.isSafeInteger(parameters[key]) &&
              Number(parameters[key]) > 0,
            `Invalid ${key}`,
          );
        String(parameters.metricFamilies).split(",").forEach(identifier);
      },
    )
    .register(
      "capture-count",
      ({ evidence, turns }, parameters) => {
        const recorded = turns.flatMap((turn) =>
          turn.captures.map((entry) => entry.passId),
        );
        const complete = evidence?.capturePassIds;
        return result(
          complete !== undefined &&
            complete.length === parameters.expected &&
            recorded.length === complete.length &&
            recorded.every((passId) => complete.includes(passId)),
          "capture-count",
          "Complete run inventory must match attributable passes without hidden recapture",
        );
      },
      (parameters) => {
        rejectUnknownFields(parameters, ["expected"]);
        requireCondition(
          typeof parameters.expected === "number" &&
            Number.isSafeInteger(parameters.expected) &&
            parameters.expected >= 0,
          "Invalid expected capture count",
        );
      },
    )
    .register(
      "no-capture",
      ({ turn }) =>
        result(
          !!turn && turn.captures.length === 0,
          "unexpected-capture",
          "No capture may start during this turn",
        ),
      (parameters) => rejectUnknownFields(parameters, []),
    )
    .register(
      "context",
      ({ turn, turns, evidence, baseline }, parameters) => {
        if (!baseline.source || !baseline.listenerId)
          return result(
            false,
            "missing-source",
            "Context requires independently read source and listener evidence",
          );
        const capture = turns
          .flatMap((entry) => entry.captures)
          .find((entry) => entry.complete);
        const candidates =
          parameters.afterRestart === true
            ? evidence?.contexts
            : turn?.contexts;
        if (!capture || !candidates?.length)
          return result(
            false,
            "missing-context",
            "Capture and public readable context required",
          );
        const original = turns
          .flatMap((entry) => entry.contexts)
          .find(
            (entry) =>
              entry.passId === capture.passId &&
              entry.readable &&
              sameSource(entry.source, capture.source),
          );
        const matching = candidates.find(
          (entry) =>
            entry.passId === capture.passId &&
            entry.readable &&
            sameSource(entry.source, capture.source) &&
            (parameters.afterRestart !== true ||
              (entry.afterOwnedRestart &&
                original?.contextId === entry.contextId &&
                original.contentSha256 === entry.contentSha256)),
        );
        return result(
          !!matching,
          "context-mismatch",
          "Context must retain pass, source, identity and content",
        );
      },
      (parameters) => {
        rejectUnknownFields(parameters, ["afterRestart"]);
        requireCondition(
          typeof parameters.afterRestart === "boolean",
          "afterRestart is required",
        );
      },
    )
    .register(
      "unchanged",
      ({ evidence }, parameters) => {
        const scopes = String(parameters.scopes).split(",");
        return result(
          scopes.every((scope) => {
            const entry = evidence?.unchanged.find(
              (candidate) => candidate.scope === scope,
            );
            return (
              entry !== undefined && entry.beforeSha256 === entry.afterSha256
            );
          }),
          "changed-scope",
          "Every requested scope must be independently read and unchanged",
        );
      },
      (parameters) => {
        rejectUnknownFields(parameters, ["scopes"]);
        requiredStrings(parameters, ["scopes"]);
        String(parameters.scopes).split(",").forEach(identifier);
      },
    );
}
