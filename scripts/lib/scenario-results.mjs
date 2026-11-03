export const SCENARIO_RECEIPT_VERSION = 2;

/** @typedef {"pass"|"recovered-pass"|"expected-denial-pass"|"expected-partial-pass"|"unsupported-skip"|"fail"|"cancelled"|"blocked"} ScenarioClassification */

const passClassifications = new Set([
  "pass",
  "recovered-pass",
  "expected-denial-pass",
  "expected-partial-pass",
]);

/** @param {ScenarioClassification} classification */
export function scenarioPassed(classification) {
  return passClassifications.has(classification);
}

export function summarizeScenarioAttempts(attempts = [], classification) {
  const first = attempts[0]?.classification ?? classification;
  const last = attempts.at(-1)?.classification ?? classification;
  return {
    attemptCount: attempts.length || 1,
    firstAttemptClassification: first,
    finalAttemptClassification: last,
    firstAttemptPassed: scenarioPassed(first) && first !== "recovered-pass",
    passedAfterRetry: attempts.length > 1 && scenarioPassed(last),
  };
}

export function finalizeScenarioRecord(record, cleanup) {
  if (!["completed", "failed"].includes(cleanup.status))
    throw new Error("Scenario finalization requires a terminal cleanup status");
  const executionClassification =
    record.executionClassification ?? record.classification;
  const classification =
    cleanup.status === "completed" && record.persistenceError === undefined
      ? executionClassification
      : "fail";
  return {
    ...record,
    executionClassification,
    classification,
    passed: scenarioPassed(classification),
    finalization: "final",
    cleanup,
    retry: summarizeScenarioAttempts(record.attempts, executionClassification),
  };
}

/** Retain evidence in memory even if its durable writer fails. */
export async function publishScenarioRecord(
  scenarios,
  record,
  persist,
  describeError,
) {
  const index = scenarios.findIndex((entry) => entry.id === record.id);
  if (index < 0) scenarios.push(record);
  else scenarios[index] = record;
  try {
    await persist(record);
  } catch (error) {
    const message = describeError(error);
    record.executionClassification ??= record.classification;
    record.classification = "fail";
    record.passed = false;
    record.finalization = "final";
    record.persistenceError = message;
    throw error;
  }
}

/** Version 2 never promotes incomplete selection or provisional evidence. */
export function summarizeScenarioRun(
  selectedScenarioIds,
  scenarios,
  failed = false,
) {
  const selected = new Set(selectedScenarioIds);
  if (selected.size !== selectedScenarioIds.length)
    throw new Error("Duplicate selected scenario identity");
  const seen = new Set();
  for (const scenario of scenarios) {
    if (!selected.has(scenario.id))
      throw new Error(`Unselected scenario result: ${scenario.id}`);
    if (seen.has(scenario.id))
      throw new Error(`Duplicate scenario result: ${scenario.id}`);
    seen.add(scenario.id);
  }
  const executedScenarioIds = scenarios
    .filter((scenario) => scenario.executionStarted !== false)
    .map((scenario) => scenario.id);
  const unrunScenarioIds = selectedScenarioIds.filter((id) => !seen.has(id));
  const satisfied = scenarios.filter(
    (scenario) =>
      scenario.finalization === "final" &&
      scenarioPassed(scenario.classification),
  );
  const count = (classification) =>
    scenarios.filter((scenario) => scenario.classification === classification)
      .length;
  const retries = satisfied.map((scenario) => ({
    classification: scenario.classification,
    ...summarizeScenarioAttempts(scenario.attempts, scenario.classification),
  }));
  const passed =
    !failed && selected.size > 0 && satisfied.length === selected.size;
  const hasFailure = failed || count("fail") > 0 || count("cancelled") > 0;
  return {
    passed,
    outcome: passed
      ? "passed"
      : hasFailure
        ? executedScenarioIds.length === 0
          ? "blocked"
          : "failed"
        : count("blocked") > 0
          ? "blocked"
          : "incomplete",
    selectedScenarioIds: [...selectedScenarioIds],
    executedScenarioIds,
    unrunScenarioIds,
    coverage: {
      selected: selected.size,
      executed: executedScenarioIds.length,
      passed: satisfied.length,
      cleanPasses: retries.filter(
        (retry) =>
          retry.classification === "pass" &&
          retry.firstAttemptPassed &&
          !retry.passedAfterRetry,
      ).length,
      recovered: satisfied.filter(
        (scenario) => scenario.classification === "recovered-pass",
      ).length,
      passedAfterRetry: retries.filter((retry) => retry.passedAfterRetry)
        .length,
      expectedDenials: satisfied.filter(
        (scenario) => scenario.classification === "expected-denial-pass",
      ).length,
      expectedPartials: satisfied.filter(
        (scenario) => scenario.classification === "expected-partial-pass",
      ).length,
      skipped: count("unsupported-skip"),
      blocked: count("blocked"),
      failed: count("fail"),
      cancelled: count("cancelled"),
      unrun: unrunScenarioIds.length,
    },
  };
}
