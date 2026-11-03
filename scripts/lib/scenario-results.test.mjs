import { describe, expect, it } from "vitest";
import {
  summarizeScenarioAttempts,
  summarizeScenarioRun,
  finalizeScenarioRecord,
  publishScenarioRecord,
} from "./scenario-results.mjs";

const record = (id, classification = "pass", extra = {}) => ({
  id,
  classification,
  finalization: "final",
  ...extra,
});

describe("versioned scenario result summaries", () => {
  it("does not count a reviewed skip as completed acceptance", () => {
    expect(
      summarizeScenarioRun(
        ["a", "b"],
        [record("a"), record("b", "unsupported-skip")],
      ),
    ).toMatchObject({
      passed: false,
      outcome: "incomplete",
      coverage: { selected: 2, executed: 2, passed: 1, skipped: 1, unrun: 0 },
    });
  });

  it("retains selected but unrun work on failure or blocked setup", () => {
    expect(
      summarizeScenarioRun(["a", "b"], [record("a", "fail")], true),
    ).toMatchObject({
      passed: false,
      outcome: "failed",
      unrunScenarioIds: ["b"],
    });
    expect(summarizeScenarioRun(["a", "b"], [], true)).toMatchObject({
      passed: false,
      outcome: "blocked",
      unrunScenarioIds: ["a", "b"],
    });
  });

  it("does not claim a running checkpoint is finalized acceptance", () => {
    expect(
      summarizeScenarioRun(
        ["a"],
        [record("a", "pass", { finalization: "checkpoint" })],
      ),
    ).toMatchObject({
      passed: false,
      outcome: "incomplete",
      coverage: { passed: 0 },
    });
  });

  it("counts reviewed refusals and partial results separately from ordinary passes", () => {
    expect(
      summarizeScenarioRun(
        ["a", "b", "c", "d"],
        [
          record("a"),
          record("b", "expected-denial-pass"),
          record("c", "expected-partial-pass"),
          record("d", "recovered-pass"),
        ],
      ),
    ).toMatchObject({
      passed: true,
      outcome: "passed",
      coverage: {
        passed: 4,
        cleanPasses: 1,
        expectedDenials: 1,
        expectedPartials: 1,
        recovered: 1,
      },
    });
  });

  it("retains first attempt failure when a fresh second attempt passes", () => {
    const attempts = [
      { classification: "fail", tracePath: "first.json" },
      { classification: "pass", tracePath: "second.json" },
    ];
    expect(summarizeScenarioAttempts(attempts, "pass")).toEqual({
      attemptCount: 2,
      firstAttemptClassification: "fail",
      finalAttemptClassification: "pass",
      firstAttemptPassed: false,
      passedAfterRetry: true,
    });
    expect(attempts[0].tracePath).toBe("first.json");
    expect(
      summarizeScenarioRun(["a"], [record("a", "pass", { attempts })]),
    ).toMatchObject({
      coverage: { passed: 1, passedAfterRetry: 1, cleanPasses: 0 },
    });
  });

  it("failure or incomplete evidence always prevents overall success", () => {
    expect(summarizeScenarioRun(["a"], [record("a")], true).passed).toBe(false);
    expect(summarizeScenarioRun([], []).passed).toBe(false);
    expect(summarizeScenarioRun(["a"], [record("a", "cancelled")]).passed).toBe(
      false,
    );
    expect(summarizeScenarioRun(["a"], [record("a", "blocked")]).passed).toBe(
      false,
    );
    expect(() =>
      summarizeScenarioRun(["a"], [record("a"), record("a")]),
    ).toThrow("Duplicate");
    expect(() => summarizeScenarioRun(["a"], [record("b")])).toThrow(
      "Unselected",
    );
  });

  it("finalizes cleanup failure without erasing successful actor evidence", () => {
    const before = record("a", "pass", {
      finalization: "checkpoint",
      result: { ok: true },
    });
    const result = finalizeScenarioRecord(before, {
      status: "failed",
      errors: ["shutdown failed"],
    });
    expect(result).toMatchObject({
      classification: "fail",
      executionClassification: "pass",
      passed: false,
      finalization: "final",
      cleanup: { status: "failed", errors: ["shutdown failed"] },
      result: { ok: true },
    });
    expect(before.finalization).toBe("checkpoint");
  });

  it("retains actor evidence and fails the record if final persistence fails", async () => {
    const scenarios = [];
    const value = record("a", "pass", { passed: true, result: { ok: true } });
    await expect(
      publishScenarioRecord(
        scenarios,
        value,
        async () => {
          throw new Error("write failed");
        },
        (error) => error.message,
      ),
    ).rejects.toThrow("write failed");
    expect(scenarios).toEqual([
      expect.objectContaining({
        classification: "fail",
        executionClassification: "pass",
        passed: false,
        persistenceError: "write failed",
        result: { ok: true },
      }),
    ]);
    expect(summarizeScenarioRun(["a"], scenarios).passed).toBe(false);
  });
});
