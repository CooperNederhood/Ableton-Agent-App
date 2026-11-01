import type { DesktopListeningJob } from "../../listening-contracts.js";

export function listeningFailureFixture(
  traceId: string,
  passId: string,
): NonNullable<DesktopListeningJob["failureEvidence"]> {
  return {
    schema: "listening-failure/v1",
    code: "stale_native_preflight",
    phase: "preflight",
    component: "native-controller",
    checkId: "preflight.accepted-clock-age",
    summary:
      "Synthetic fixture: accepted clock is older than the preflight deadline.",
    coverage: "partial",
    coverageReasons: ["missing-operands"],
    facts: [
      {
        field: "acceptedClockAge",
        actual: { state: "observed", value: 1034 },
        expected: { state: "observed", value: 1000 },
        comparison: "at-most",
        unit: "ms",
      },
      {
        field: "lastRejectedClock",
        actual: { state: "unavailable", reason: "not-reported" },
        unit: "samples",
      },
    ],
    reference: { traceId, passId, diagnosticScope: "native-preflight" },
  };
}
