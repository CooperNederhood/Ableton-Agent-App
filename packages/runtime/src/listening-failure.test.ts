import { describe, expect, it } from "vitest";
import {
  captureFailureEvidence,
  denyListening,
  failureFact,
  ListeningRuntimeRejection,
} from "./listening-failure.js";

const trace = {
  traceId: "00000000-0000-4000-8000-000000000001",
  correlationId: "capture-correlation",
  causationId: "capture-cause",
};

describe("metric capture failure evidence", () => {
  it("distinguishes actual zero and false from missing or invalid values", () => {
    expect(failureFact("metric.count", 0).actual).toEqual({
      state: "observed",
      value: 0,
    });
    expect(failureFact("source.playing", false).actual).toEqual({
      state: "observed",
      value: false,
    });
    expect(failureFact("metric.count", undefined).actual).toEqual({
      state: "unavailable",
      reason: "not-reported",
    });
    expect(failureFact("metric.count", Number.NaN).actual).toEqual({
      state: "unavailable",
      reason: "nonfinite",
    });
  });

  it("keeps typed facts, source identity and incomplete diagnostic coverage", () => {
    const facts = [failureFact("source.counter", undefined, 1200)];
    const evidence = captureFailureEvidence({
      code: "native_source_incomplete",
      message: "Native source coverage is incomplete",
      phase: "capture",
      component: "native-controller",
      checkId: "native.source.counter",
      passId: "capture-pass",
      trace,
      facts,
      coverage: "complete",
    });
    expect(evidence).toMatchObject({
      code: "native_source_incomplete",
      phase: "capture",
      component: "native-controller",
      checkId: "native.source.counter",
      coverage: "partial",
      coverageReasons: ["missing-operands"],
      reference: { ...trace, passId: "capture-pass" },
      facts,
    });
    expect(Object.isFrozen(evidence.facts)).toBe(true);
    expect(Object.isFrozen(facts)).toBe(false);
  });

  it("bounds and redacts persisted failure text and scalar facts", () => {
    const secret = "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456";
    const evidence = captureFailureEvidence({
      code: "capture_failed",
      message: secret,
      phase: "capture",
      checkId: "capture.failed",
      passId: "capture-pass",
      trace,
      coverage: "complete",
      facts: Array.from({ length: 25 }, (_, index) =>
        failureFact(`capture.fact.${index}`, `${secret} ${"x".repeat(300)}`),
      ),
    });
    expect(JSON.stringify(evidence)).not.toContain(
      "abcdefghijklmnopqrstuvwxyz123456",
    );
    expect(evidence.facts).toHaveLength(24);
    expect(evidence.coverage).toBe("partial");
    expect(evidence.coverageReasons).toContain("diagnostic-truncated");
  });

  it("retains the rejected condition rather than returning success", () => {
    expect(() =>
      denyListening("source_changed", "Source changed", [
        failureFact("source.matches", false, true),
      ]),
    ).toThrow(ListeningRuntimeRejection);
  });
});
