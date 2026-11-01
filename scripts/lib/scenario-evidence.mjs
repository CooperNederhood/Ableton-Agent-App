import { readFile, stat } from "node:fs/promises";

export async function recoverScenarioTrace(result, tracePath, scenarioId) {
  if (result.json !== undefined) {
    return { ...result, evidenceSource: "stdout" };
  }
  try {
    if ((await stat(tracePath)).size > 2 * 1024 * 1024) {
      throw new Error("Scenario trace exceeds the 2 MiB evidence limit");
    }
    const json = JSON.parse(await readFile(tracePath, "utf8"));
    if (
      json === null ||
      typeof json !== "object" ||
      json.scenarioId !== scenarioId ||
      !["running", "failed", "completed"].includes(json.traceState) ||
      !Array.isArray(json.operations)
    ) {
      throw new Error("Scenario trace identity or checkpoint shape is invalid");
    }
    return { ...result, json, evidenceSource: "trace-checkpoint" };
  } catch (error) {
    return {
      ...result,
      evidenceSource: "unavailable",
      traceEvidenceError:
        error instanceof SyntaxError
          ? "Scenario trace is not valid JSON"
          : error instanceof Error && "code" in error
            ? `Scenario trace read failed (${String(error.code)})`
            : error instanceof Error
              ? error.message.slice(0, 2048)
              : "Trace read failed",
    };
  }
}

function incompleteResult(result) {
  const payload = result.json;
  return (
    result.timedOut === true ||
    result.signal != null ||
    (payload?.traceState !== undefined && payload.traceState !== "completed") ||
    payload?.operationsTruncated === true ||
    payload?.approvalsTruncated === true
  );
}

export function classifyScenario(manifest, result) {
  if (incompleteResult(result)) return "fail";
  const payload = result.json;
  if (payload === null || typeof payload !== "object") return "fail";
  if (
    manifest.id !== undefined &&
    (payload.scenarioId !== manifest.id || payload.traceState !== "completed")
  )
    return "fail";
  for (const field of [
    "assertions",
    "operationFailures",
    "policyViolations",
    "approvals",
  ]) {
    if (payload[field] !== undefined && !Array.isArray(payload[field]))
      return "fail";
  }
  const assertions = payload.assertions ?? [];
  const failures = payload.operationFailures ?? [];
  const violations = payload.policyViolations ?? [];
  if (assertions.some((assertion) => assertion?.passed !== true)) return "fail";
  if (
    result.status === 0 &&
    payload.ok === true &&
    assertions.length > 0 &&
    failures.length === 0 &&
    violations.length === 0
  )
    return "pass";
  if (
    failures.length > 0 &&
    failures.every((failure) => failure?.code === "invalid_tool_arguments") &&
    assertions.length > 0 &&
    violations.length === 0
  ) {
    return "recovered-pass";
  }
  if (
    manifest.expectedOutcome === "expected-denial" &&
    Array.isArray(payload?.approvals) &&
    payload.approvals.some((approval) => approval?.approved === false) &&
    assertions.length > 0 &&
    failures.length === 0 &&
    violations.every(
      (violation) =>
        violation === "scenario approval policy denied a tool request",
    )
  ) {
    return "expected-denial-pass";
  }
  if (
    Array.isArray(manifest.unsupportedCapabilities) &&
    manifest.unsupportedCapabilities.length > 0 &&
    violations.length === 0 &&
    failures.length > 0 &&
    failures.every((failure) => {
      const capability = failure?.details?.capability;
      return (
        failure?.code === "unsupported_capability" &&
        typeof capability === "string" &&
        manifest.unsupportedCapabilities.includes(capability)
      );
    })
  ) {
    return "unsupported-skip";
  }
  return "fail";
}

export function collectToolNames(result) {
  if (!Array.isArray(result.json?.operations)) return [];
  return [
    ...new Set(
      result.json.operations.flatMap((operation) =>
        operation?.type === "operation.started" &&
        typeof operation.toolName === "string"
          ? [operation.toolName]
          : [],
      ),
    ),
  ].sort();
}

export function shouldRetryAgentScenario(result) {
  const payload = result.json;
  if (payload === null || typeof payload !== "object") return false;
  if (incompleteResult(result)) return false;
  if ((payload.budgets?.mutations ?? 0) > 0) return false;
  const policyViolations = payload.policyViolations ?? [];
  if (
    policyViolations.some(
      (violation) =>
        violation !== "scenario approval policy denied a tool request",
    )
  ) {
    return false;
  }
  const failures = payload.operationFailures ?? [];
  if (failures.length > 0) {
    return failures.every(
      (failure) =>
        failure.code === "invalid_tool_arguments" ||
        (failure.code === "user_denied" &&
          payload.approvals?.some(
            (approval) =>
              approval.approved === false &&
              approval.reason === "argument_guard_rejected",
          )),
    );
  }
  const failedAssertions = (payload.assertions ?? []).filter(
    ({ passed }) => passed !== true,
  );
  return (
    (payload.operations?.length ?? 0) === 0 &&
    failedAssertions.length > 0 &&
    failedAssertions.every(({ assertion }) => assertion === "tool-calls")
  );
}
