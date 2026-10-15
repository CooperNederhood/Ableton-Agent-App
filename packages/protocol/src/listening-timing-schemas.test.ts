import { describe, expect, it } from "vitest";
import {
  DEFAULT_LISTENING_TIMING_POLICY,
  evaluateListeningAlignment,
  listeningAlignmentQualitySchema,
  listeningDisagreementMilliseconds,
  listeningTimingPolicySchema,
} from "./listening-timing-schemas.js";

const measurements = {
  sampleRate: 48_000,
  vectorSize: 64,
  observedClockDisagreementSamples: 0,
  observedBeatDisagreementSamples: 0,
};

describe("descriptive listening timing policy", () => {
  it("defaults to descriptive use, without a claimed absolute error bound", () => {
    const quality = evaluateListeningAlignment(
      DEFAULT_LISTENING_TIMING_POLICY,
      measurements,
    );
    expect(quality).toEqual({
      schema: "listening-alignment/v2",
      policy: { mode: "descriptive", maxClockDisagreementSamples: 64 },
      ...measurements,
      alignment: "approximate",
      intendedUse: "descriptive-only",
      estimatedAbsoluteErrorSamples: null,
      verifiedAbsoluteErrorBoundSamples: null,
    });
    expect(Object.isFrozen(DEFAULT_LISTENING_TIMING_POLICY)).toBe(true);
  });

  it.each([0, 64, 480])("accepts the exact configured boundary %i", (limit) => {
    const policy = {
      mode: "descriptive" as const,
      maxClockDisagreementSamples: limit,
    };
    for (const field of [
      "observedClockDisagreementSamples",
      "observedBeatDisagreementSamples",
    ] as const) {
      for (const observed of [Math.max(0, limit - 1), limit]) {
        expect(
          evaluateListeningAlignment(policy, {
            ...measurements,
            [field]: observed,
          })[field],
        ).toBe(observed);
      }
      expect(() =>
        evaluateListeningAlignment(policy, {
          ...measurements,
          [field]: limit + 1,
        }),
      ).toThrow("listening_alignment_budget_exceeded");
    }
  });

  it("never silently relaxes a strict policy or retries with a larger limit", () => {
    const policy = {
      mode: "strict" as const,
      maxClockDisagreementSamples: 0 as const,
    };
    expect(evaluateListeningAlignment(policy, measurements).policy.mode).toBe(
      "strict",
    );
    expect(() =>
      evaluateListeningAlignment(policy, {
        ...measurements,
        observedClockDisagreementSamples: 1,
      }),
    ).toThrow("listening_alignment_budget_exceeded");
    expect(policy.maxClockDisagreementSamples).toBe(0);
    expect(
      listeningTimingPolicySchema.safeParse({
        mode: "strict",
        maxClockDisagreementSamples: 64,
      }).success,
    ).toBe(false);
  });

  it.each([-1, 0.5, 481, NaN, Infinity, "64"])(
    "rejects an invalid configured limit %s",
    (limit) => {
      expect(
        listeningTimingPolicySchema.safeParse({
          mode: "descriptive",
          maxClockDisagreementSamples: limit,
        }).success,
      ).toBe(false);
    },
  );

  it("snapshots the policy without sharing mutable objects", () => {
    const policy = {
      mode: "descriptive" as const,
      maxClockDisagreementSamples: 64,
    };
    const quality = evaluateListeningAlignment(policy, measurements);
    policy.maxClockDisagreementSamples = 480;
    expect(quality.policy.maxClockDisagreementSamples).toBe(64);
    expect(Object.isFrozen(quality)).toBe(true);
    expect(Object.isFrozen(quality.policy)).toBe(true);
  });

  it.each([
    { alignment: "exact" },
    { intendedUse: "realtime" },
    { estimatedAbsoluteErrorSamples: 64 },
    { verifiedAbsoluteErrorBoundSamples: 64 },
    { captureEligible: true },
    { observedClockDisagreementSamples: 65 },
    { observedBeatDisagreementSamples: 65 },
    { sampleRate: Infinity },
    { vectorSize: 0 },
    { observedClockDisagreementSamples: -1 },
    { observedBeatDisagreementSamples: 0.5 },
  ])("rejects invalid measurements or unsupported authority %#", (change) => {
    const quality = evaluateListeningAlignment(
      DEFAULT_LISTENING_TIMING_POLICY,
      measurements,
    );
    expect(
      listeningAlignmentQualitySchema.safeParse({ ...quality, ...change })
        .success,
    ).toBe(false);
  });

  it("shows equivalent milliseconds using the actual sample rate", () => {
    expect(listeningDisagreementMilliseconds(64, 48_000)).toBeCloseTo(1.333333);
    expect(listeningDisagreementMilliseconds(64, 44_100)).toBeCloseTo(1.451247);
    expect(listeningDisagreementMilliseconds(480, 48_000)).toBe(10);
    expect(() => listeningDisagreementMilliseconds(64, 0)).toThrow();
    expect(() => listeningDisagreementMilliseconds(NaN, 48_000)).toThrow();
  });
});
