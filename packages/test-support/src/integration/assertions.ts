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
import { validateFlatnessSmoke } from "./flatness-smoke.js";
import { validateSpreadSmoke } from "./spread-smoke.js";
import { validateRolloffSmoke } from "./rolloff-smoke.js";
import { verifyMelSmoke } from "./mel-smoke.js";
import { verifyPitchSmoke } from "./pitch-smoke.js";
import {
  verifyAgentListeningResult,
  verifyRestoredAgentListeningEvidence,
} from "./agent-listening-result.js";

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
    ("mediaSha256" in left
      ? "mediaSha256" in right && left.mediaSha256 === right.mediaSha256
      : "midiNotesSha256" in right &&
        left.midiNotesSha256 === right.midiNotesSha256 &&
        left.instrumentChainSha256 === right.instrumentChainSha256)
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
function registerSmokeAssertions(
  registry: AssertionRegistry,
): AssertionRegistry {
  for (const kind of ["flatness", "spread", "rolloff"] as const) {
    const key = `${kind}Smoke` as const;
    registry.register(
      `${kind}-smoke`,
      ({ turn, turns, evidence, baseline }, parameters) => {
        const afterRestart = parameters.afterRestart === true;
        const captures = (turn ? [turn] : turns).flatMap(
          (entry) => entry.captures,
        );
        const selected =
          turn ?? turns.find((entry) => entry.captures.length > 0);
        const smoke = afterRestart ? evidence?.[key] : selected?.[key];
        const capture = captures[0];
        const source = baseline.sources?.[String(parameters.sourceId)];
        const entry = smoke?.[0];
        if (
          !selected ||
          captures.length !== 1 ||
          !capture ||
          !capture.native ||
          !source ||
          !sameSource(capture.source, source.source) ||
          capture.listenerId !== source.listenerId ||
          capture.operationId !== selected.operationId ||
          smoke?.length !== 1 ||
          !entry
        )
          return result(
            false,
            `${kind}-owner`,
            "Smoke requires one independently owned capture and source",
          );
        try {
          if (kind === "flatness") validateFlatnessSmoke(entry);
          else if (kind === "spread") validateSpreadSmoke(entry);
          else validateRolloffSmoke(entry);
          const original = selected[key]?.[0];
          const matches =
            entry.traceId === selected.facts.sdkTurnId &&
            entry.correlationId === selected.facts.sdkTurnId &&
            entry.passId === capture.passId &&
            entry.listenerId === capture.listenerId &&
            Object.entries(capture.native).every(
              ([key, value]) => Reflect.get(entry.native, key) === value,
            ) &&
            entry.afterOwnedRestart === afterRestart &&
            (!afterRestart ||
              (!!original &&
                JSON.stringify({ ...original, afterOwnedRestart: true }) ===
                  JSON.stringify(entry)));
          return result(
            matches,
            `${kind}-owner`,
            "Unqualified stereo diagnostics and cleanup must retain exact ownership after restart",
          );
        } catch {
          return result(
            false,
            `${kind}-lifecycle`,
            "Smoke requires fresh bounded stereo deliveries, ordered lifecycle and successful cleanup",
          );
        }
      },
      (parameters) => {
        rejectUnknownFields(parameters, ["sourceId", "afterRestart"]);
        requiredStrings(parameters, ["sourceId"]);
        identifier(parameters.sourceId);
        requireCondition(
          typeof parameters.afterRestart === "boolean",
          "Missing smoke restart requirement",
        );
      },
    );
  }
  return registry;
}
export function createDefaultAssertions(): AssertionRegistry {
  return registerSmokeAssertions(new AssertionRegistry())
    .register(
      "pitch-smoke",
      (input, parameters) => {
        try {
          verifyPitchSmoke(
            input,
            String(parameters.sourceId),
            parameters.afterRestart === true,
          );
          return result(
            true,
            "ok",
            "Unqualified paired pitch History, independent pinned loading and owned cleanup survive restart",
          );
        } catch {
          return result(
            false,
            "pitch-evidence",
            "Missing, foreign, malformed or changed pitch diagnostics or loading proof",
          );
        }
      },
      (parameters) => {
        rejectUnknownFields(parameters, ["sourceId", "afterRestart"]);
        requiredStrings(parameters, ["sourceId"]);
        identifier(parameters.sourceId);
        requireCondition(
          typeof parameters.afterRestart === "boolean",
          "Missing smoke restart requirement",
        );
      },
    )
    .register(
      "melbands-smoke",
      (input, parameters) => {
        try {
          verifyMelSmoke(
            input,
            String(parameters.sourceId),
            parameters.afterRestart === true,
          );
          return result(
            true,
            "ok",
            "Complete stereo mel context, lossless projected reports and acquisition cleanup",
          );
        } catch {
          return result(
            false,
            "melbands-evidence",
            "Missing, foreign, truncated or changed mel evidence",
          );
        }
      },
      (parameters) => {
        rejectUnknownFields(parameters, ["sourceId", "afterRestart"]);
        requiredStrings(parameters, ["sourceId"]);
        identifier(parameters.sourceId);
        requireCondition(
          typeof parameters.afterRestart === "boolean",
          "Missing smoke restart requirement",
        );
      },
    )
    .register(
      "agent-listening-result",
      (input, parameters) => {
        try {
          verifyAgentListeningResult(input, String(parameters.sourceId));
          if (!input.turn)
            verifyRestoredAgentListeningEvidence(
              input.turns,
              input.evidence?.agentListening ?? [],
            );
          return result(
            true,
            "ok",
            "Original start delivered the matching completed pass and the same agent read its measurement context before answering",
          );
        } catch (error) {
          return result(
            false,
            "agent-listening-result",
            error instanceof Error
              ? error.message
              : "Invalid agent listening evidence",
          );
        }
      },
      (parameters) => {
        rejectUnknownFields(parameters, ["sourceId"]);
        requiredStrings(parameters, ["sourceId"]);
        identifier(parameters.sourceId);
      },
    )
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
        const expected = baseline.sources?.[String(parameters.sourceId)];
        if (!expected)
          return result(
            false,
            "missing-source",
            "Capture requires independently read source and listener evidence",
          );
        const capture = turn?.captures[0];
        if (!turn || turn.captures.length !== 1 || !capture)
          return result(false, "capture-count", "Exactly one capture required");
        if (
          !sameSource(capture.source, expected.source) ||
          capture.listenerId !== expected.listenerId ||
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
          "sourceId",
        ]);
        requiredStrings(parameters, ["metricFamilies", "sourceId"]);
        identifier(parameters.sourceId);
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
      "native-freshness",
      ({ turns }) => {
        const captures = turns.flatMap((turn) => turn.captures);
        const generations = new Set<string>();
        const passes = new Set<string>();
        const listeners = new Map<
          string,
          NonNullable<(typeof captures)[number]["native"]>
        >();
        const fresh =
          captures.length > 0 &&
          captures.every((capture) => {
            const native = capture.native;
            if (
              !native ||
              generations.has(native.generation) ||
              passes.has(capture.passId)
            )
              return false;
            generations.add(native.generation);
            passes.add(capture.passId);
            const prior = listeners.get(capture.listenerId);
            listeners.set(capture.listenerId, native);
            return (
              capture.complete &&
              capture.cleanupComplete &&
              (!prior ||
                (native.connectionId === prior.connectionId &&
                  native.connectionEpoch === prior.connectionEpoch &&
                  native.nativeEpoch > prior.nativeEpoch))
            );
          });
        return result(
          fresh,
          "stale-native-capture",
          "Passes require unique generations and increasing epochs on unchanged listener connections",
        );
      },
      (parameters) => rejectUnknownFields(parameters, []),
    )
    .register(
      "spectral-range",
      ({ turn }, parameters) => {
        const centroid = turn?.captures[0]?.spectralCentroidHz;
        return result(
          turn?.captures.length === 1 &&
            centroid !== undefined &&
            centroid >= Number(parameters.minHz) &&
            centroid <= Number(parameters.maxHz),
          "source-content-mismatch",
          "Measured spectral content must fall within the independently reviewed source range",
        );
      },
      (parameters) => {
        rejectUnknownFields(parameters, ["minHz", "maxHz"]);
        requireCondition(
          typeof parameters.minHz === "number" &&
            typeof parameters.maxHz === "number" &&
            parameters.minHz >= 0 &&
            parameters.maxHz > parameters.minHz &&
            parameters.maxHz <= 24_000,
          "Invalid spectral range",
        );
      },
    )
    .register(
      "capture-count",
      ({ evidence, turns }, parameters) => {
        const recorded = turns.flatMap((turn) =>
          turn.captures.map((entry) => entry.passId),
        );
        const complete = evidence?.capturePassIds;
        const recordedIds = new Set(recorded);
        const completeIds = new Set(complete);
        return result(
          complete !== undefined &&
            complete.length === parameters.expected &&
            recorded.length === complete.length &&
            recordedIds.size === recorded.length &&
            completeIds.size === complete.length &&
            recorded.every((passId) => completeIds.has(passId)),
          "capture-count",
          "Complete run inventory must match distinct attributable passes without reuse or hidden recapture",
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
        if (!baseline.sources || Object.keys(baseline.sources).length === 0)
          return result(
            false,
            "missing-source",
            "Context requires independently read source and listener evidence",
          );
        const captures = turns.flatMap((owner) =>
          owner.captures.map((capture) => ({ capture, owner })),
        );
        const candidates =
          parameters.afterRestart === true
            ? evidence?.contexts
            : turn?.contexts;
        if (!captures.length || !candidates?.length)
          return result(
            false,
            "missing-context",
            "Capture and public readable context required",
          );
        if (
          candidates.length !== captures.length ||
          new Set(captures.map(({ capture }) => capture.passId)).size !==
            captures.length ||
          new Set(candidates.map((entry) => entry.contextId)).size !==
            candidates.length ||
          new Set(candidates.map((entry) => entry.passId)).size !==
            candidates.length
        )
          return result(
            false,
            "context-mismatch",
            "Every distinct capture requires exactly one distinct context",
          );
        const matching = captures.every(({ capture, owner }) => {
          const originals = owner.contexts.filter(
            (entry) => entry.passId === capture.passId,
          );
          const original = originals[0];
          const retained = candidates.find(
            (entry) => entry.passId === capture.passId,
          );
          return (
            capture.complete &&
            Object.values(baseline.sources!).some(
              (source) =>
                sameSource(capture.source, source.source) &&
                capture.listenerId === source.listenerId,
            ) &&
            capture.operationId === owner.operationId &&
            originals.length === 1 &&
            original !== undefined &&
            original.readable &&
            sameSource(original.source, capture.source) &&
            retained !== undefined &&
            retained.readable &&
            sameSource(retained.source, capture.source) &&
            retained.contextId === original.contextId &&
            retained.contentSha256 === original.contentSha256 &&
            (parameters.afterRestart !== true || retained.afterOwnedRestart)
          );
        });
        return result(
          matching,
          "context-mismatch",
          "Every capture must retain its original pass, source, context identity and content",
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
