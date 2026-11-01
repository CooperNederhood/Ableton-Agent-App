import { describe, expect, it } from "vitest";
import {
  listeningFailureEvidenceSchema,
  readListeningFailureEvidence,
} from "./listening-failure-schemas.js";

const evidence = {
  schema: "listening-failure/v1",
  code: "stale_native_preflight",
  phase: "preflight",
  component: "native-controller",
  checkId: "native.preflight.clock-freshness",
  summary: "Native clock evidence was unavailable before arming.",
  coverage: "partial",
  coverageReasons: ["source-evidence-not-reported"],
  facts: [
    {
      field: "clock.age",
      actual: { state: "unavailable", reason: "not-reported" },
      expected: { state: "observed", value: 350 },
      comparison: "at-most",
      unit: "ms",
    },
  ],
  reference: {
    traceId: "11111111-1111-4111-8111-111111111111",
    passId: "pass",
  },
};

describe("bounded listening failure evidence", () => {
  it.each([
    { comparison: "contains-all-bits", unit: "flags" },
    { comparison: "at-most", unit: "fraction" },
    { comparison: "equal", unit: "bpm" },
  ])("retains native scalar vocabulary %j", (vocabulary) => {
    const fact = {
      field: "native.operand",
      actual: { state: "observed", value: 0 },
      expected: { state: "observed", value: 1 },
      ...vocabulary,
    };
    expect(
      listeningFailureEvidenceSchema.parse({ ...evidence, facts: [fact] })
        .facts,
    ).toEqual([fact]);
  });

  it("distinguishes unavailable operands from an observed zero", () => {
    expect(
      listeningFailureEvidenceSchema.parse(evidence).facts[0]?.actual,
    ).toEqual({
      state: "unavailable",
      reason: "not-reported",
    });
    expect(
      listeningFailureEvidenceSchema.parse({
        ...evidence,
        facts: [
          { field: "clock.count", actual: { state: "observed", value: 0 } },
        ],
      }).facts[0]?.actual,
    ).toEqual({ state: "observed", value: 0 });
  });

  it.each([
    { facts: Array.from({ length: 25 }, () => evidence.facts[0]) },
    { summary: "x".repeat(1025) },
    {
      facts: [
        { field: "clock.age", actual: { state: "observed", value: Infinity } },
      ],
    },
    {
      facts: [
        {
          field: "clock.age",
          actual: { state: "observed", value: { audio: "body" } },
        },
      ],
    },
    { reference: { ...evidence.reference, arbitraryPath: "/not-allowed" } },
    { arbitraryPayload: "not-allowed" },
    { coverage: "success" },
    { coverage: "complete", coverageReasons: [] },
    { coverageReasons: [] },
  ])("rejects malformed or unbounded evidence %j", (override) => {
    expect(
      listeningFailureEvidenceSchema.safeParse({ ...evidence, ...override })
        .success,
    ).toBe(false);
  });

  it("reads the primary failure through cleanup aggregation without substituting a later error", () => {
    const primary = Object.assign(new Error("preflight"), {
      failureEvidence: evidence,
    });
    const cleanup = Object.assign(new Error("cleanup"), {
      failureEvidence: { ...evidence, code: "cleanup_failed" },
    });
    expect(
      readListeningFailureEvidence(new AggregateError([primary, cleanup])),
    ).toMatchObject({
      status: "present",
      evidence: { code: "stale_native_preflight" },
    });
    expect(
      readListeningFailureEvidence(new Error("wrapper", { cause: primary })),
    ).toMatchObject({
      status: "present",
      evidence: { code: "stale_native_preflight" },
    });
  });

  it("distinguishes missing evidence from invalid evidence without invoking accessors", () => {
    expect(readListeningFailureEvidence(new Error("missing"))).toEqual({
      status: "absent",
    });
    expect(
      readListeningFailureEvidence({ failureEvidence: { audio: "invalid" } }),
    ).toMatchObject({ status: "invalid" });
    let invoked = false;
    const error = Object.defineProperty(
      new Error("getter"),
      "failureEvidence",
      {
        get: () => {
          invoked = true;
          return evidence;
        },
      },
    );
    expect(readListeningFailureEvidence(error)).toEqual({
      status: "invalid",
      reason: "accessor",
    });
    expect(invoked).toBe(false);
  });

  it("bounds cyclic error chains", () => {
    const error = new Error("cycle");
    error.cause = error;
    expect(readListeningFailureEvidence(error)).toEqual({
      status: "invalid",
      reason: "error-chain-limit",
    });
  });
});
