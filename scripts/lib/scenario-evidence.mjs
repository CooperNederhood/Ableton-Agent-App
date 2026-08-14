export function classifyScenario(manifest, result) {
  if (result.status === 0 && result.json?.ok === true) return "pass";
  const payload = result.json;
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
