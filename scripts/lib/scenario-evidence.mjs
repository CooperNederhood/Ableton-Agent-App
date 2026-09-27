export function classifyScenario(manifest, result) {
  if (result.status === 0 && result.json?.ok === true) return "pass";
  const payload = result.json;
  if (
    Array.isArray(payload?.operationFailures) &&
    payload.operationFailures.length > 0 &&
    payload.operationFailures.every(
      (failure) => failure.code === "invalid_tool_arguments",
    ) &&
    payload.assertions?.length > 0 &&
    payload.assertions.every((assertion) => assertion.passed === true) &&
    (payload.policyViolations?.length ?? 0) === 0
  ) {
    return "recovered-pass";
  }
  if (
    manifest.expectedOutcome === "expected-denial" &&
    Array.isArray(payload?.approvals) &&
    payload.approvals.some((approval) => approval.approved === false) &&
    payload.assertions?.every((assertion) => assertion.passed === true) &&
    (payload.operationFailures?.length ?? 0) === 0 &&
    payload.policyViolations?.every(
      (violation) =>
        violation === "scenario approval policy denied a tool request",
    )
  ) {
    return "expected-denial-pass";
  }
  if (
    Array.isArray(manifest.unsupportedCapabilities) &&
    manifest.unsupportedCapabilities.length > 0 &&
    payload?.operationFailures?.some((failure) => {
      const serialized = JSON.stringify(failure);
      return (
        serialized.includes("unsupported_capability") &&
        manifest.unsupportedCapabilities.some((capability) =>
          serialized.includes(capability),
        )
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
