import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { analyzeStoppedClockInterval } from "./native-clock-interval-prototype.mjs";
import { nativeArmProofSchema } from "../../packages/protocol/src/native-listening-schemas.ts";
import {
  ALL_RESOURCES,
  NATIVE_CANDIDATE_RESOURCES,
} from "../../scripts/audio-listener-device.mjs";

const require = createRequire(import.meta.url);
const recorded = require("./fixtures/native-hardened-fixture-failure.json");
const policy = {
  acquisitionBoundSamples: 64,
  independentTimingErrorSamples: 0,
};
const cohort = (clock) => ({
  dsp: [1, 48000, 64],
  frames: [[...clock.previous], [...clock.row]],
});
const source = () => cohort(recorded.diagnostic.clock);

test("conditional interval intersection analyzes the actual stopped +64 discrepancy without granting runtime authority", () => {
  const input = source();
  const original = JSON.stringify(input);
  const result = analyzeStoppedClockInterval(input, policy);
  assert.equal(JSON.stringify(input), original);
  assert.equal(result.kind, "native-stopped-clock-interval-analysis/v1");
  assert.equal(result.authority, "none");
  assert.equal(result.physicallyValidated, false);
  assert.equal(result.captureEligible, false);
  assert.equal(result.assumedAcquisitionBoundSamples, 64);
  assert.equal(result.lowerOffsetSamples, 0);
  assert.equal(result.upperOffsetSamples, 64);
  assert.equal(result.proposedCenterOffsetSamples, 32);
  assert.equal(result.combinedUncertaintySamples, 32);
  assert.equal(result.freshRowCount, 2);
  assert.equal(
    result.combinedUncertaintySamples,
    result.offsetUncertaintySamples,
  );
  assert.ok(Object.isFrozen(result));
  assert.equal(nativeArmProofSchema.safeParse(result).success, false);
});

test("one-sample stopped lookahead is a separate conditional case, not a fitted exact offset", () => {
  const attempt = recorded.failOnlyLookahead;
  const input = cohort(attempt.clock.initial);
  input.frames.push(attempt.clock.following.row);
  const result = analyzeStoppedClockInterval(input, policy);
  assert.equal(result.lowerOffsetSamples, -64);
  assert.equal(result.upperOffsetSamples, 63);
  assert.equal(result.proposedCenterOffsetSamples, -1);
  assert.equal(result.combinedUncertaintySamples, 64);
  assert.equal(result.freshRowCount, 3);
  assert.equal(result.captureEligible, false);
  assert.equal(result.physicallyValidated, false);
});

test("every allowed assumed bound agrees with an independent exhaustive integer-offset reference", () => {
  const input = source();
  for (let bound = 0; bound <= 64; bound++) {
    const possible = [];
    for (let candidate = -64; candidate <= 128; candidate++)
      if (
        input.frames.every(
          (row) => Math.abs(row[2] - row[4] - candidate) <= bound,
        )
      )
        possible.push(candidate);
    const assumptions = { ...policy, acquisitionBoundSamples: bound };
    if (possible.length === 0) {
      assert.throws(
        () => analyzeStoppedClockInterval(input, assumptions),
        /native_interval_empty/,
      );
      continue;
    }
    const result = analyzeStoppedClockInterval(input, assumptions);
    assert.equal(result.lowerOffsetSamples, possible[0]);
    assert.equal(result.upperOffsetSamples, possible.at(-1));
    const worstError = Math.max(
      ...possible.map((candidate) =>
        Math.abs(candidate - result.proposedCenterOffsetSamples),
      ),
    );
    assert.equal(result.offsetUncertaintySamples, worstError);
    assert.ok(worstError <= 64);
  }
});

test("uncertainty is one shared 64-sample budget, not 64 samples per component", () => {
  const result = analyzeStoppedClockInterval(source(), policy);
  const remaining = 64 - result.offsetUncertaintySamples;
  const atLimit = analyzeStoppedClockInterval(source(), {
    ...policy,
    independentTimingErrorSamples: remaining,
  });
  assert.equal(atLimit.combinedUncertaintySamples, 64);
  assert.throws(
    () =>
      analyzeStoppedClockInterval(source(), {
        ...policy,
        independentTimingErrorSamples: remaining + 1,
      }),
    /native_interval_uncertainty_budget_exceeded/,
  );
});

test("exact bounds cannot fit these recordings and explicit assumptions cannot silently widen", () => {
  assert.throws(
    () =>
      analyzeStoppedClockInterval(source(), {
        ...policy,
        acquisitionBoundSamples: 0,
      }),
    /native_interval_empty/,
  );
  for (const patch of [
    { acquisitionBoundSamples: 65 },
    { acquisitionBoundSamples: -1 },
    { acquisitionBoundSamples: 0.5 },
    { independentTimingErrorSamples: 65 },
    { independentTimingErrorSamples: -1 },
    { independentTimingErrorSamples: NaN },
    { certified: true },
  ])
    assert.throws(
      () => analyzeStoppedClockInterval(source(), { ...policy, ...patch }),
      /invalid_native_interval_assumptions/,
    );
  assert.throws(
    () => analyzeStoppedClockInterval(source()),
    /invalid_native_interval_assumptions/,
  );
  const inconsistent = source();
  inconsistent.frames[1][2] = inconsistent.frames[1][9] =
    inconsistent.frames[1][4] + 129;
  assert.throws(
    () => analyzeStoppedClockInterval(inconsistent, policy),
    /native_interval_empty/,
  );
});

test("malformed, torn, moving, regressing, stale and changed-held rows cannot become interval evidence", () => {
  for (const change of [
    (input) => {
      input.frames[1][9] += 1;
    },
    (input) => {
      input.frames[1][6] += 1;
    },
    (input) => {
      input.frames[1][0] = input.frames[1][7] = 1;
    },
    (input) => {
      input.frames[1][1] = input.frames[1][8] = 0.01;
    },
    (input) => {
      input.frames[1][5] += 0.01;
    },
    (input) => {
      input.frames[1][4] = input.frames[1][6] = input.frames[0][4] - 1;
    },
    (input) => {
      input.frames[1][2] = input.frames[1][9] = input.frames[0][2] - 1;
    },
    (input) => {
      input.frames[1][4] = input.frames[1][6] = input.frames[0][4];
    },
    (input) => {
      input.frames.at(-1)[4] = input.frames.at(-1)[6] =
        input.frames[0][4] + 48001;
    },
    (input) => {
      input.frames[1][3] = input.frames[1][10] = 3;
    },
    (input) => {
      input.frames[1][4] = input.frames[1][6] = NaN;
    },
    (input) => {
      input.frames[1].length = 10;
    },
  ]) {
    const input = source();
    change(input);
    assert.throws(() => analyzeStoppedClockInterval(input, policy));
  }
});

test("observation set and host scope stay bounded; held rows cannot manufacture fresh evidence", () => {
  for (const input of [
    { ...source(), dsp: [1, 44100, 64] },
    { ...source(), dsp: [1, 48000, 128] },
    { ...source(), dsp: [0, 48000, 64] },
    { ...source(), frames: source().frames.slice(0, 1) },
    { ...source(), frames: Array(129).fill(source().frames[0]) },
    { ...source(), frames: Array(32).fill(source().frames[0]) },
  ])
    assert.throws(() => analyzeStoppedClockInterval(input, policy));
  const input = source();
  input.frames.splice(1, 0, [...input.frames[0]]);
  assert.equal(
    analyzeStoppedClockInterval(input, policy).freshRowCount,
    analyzeStoppedClockInterval(source(), policy).freshRowCount,
  );
});

test("old preflight rows cannot be combined with later faults and presented as one fresh cohort", () => {
  const input = source();
  input.frames.unshift(...recorded.diagnostic.nativeArm.before.frames);
  assert.throws(
    () => analyzeStoppedClockInterval(input, policy),
    /stale_native_interval_cohort/,
  );
  const preflightOnly = analyzeStoppedClockInterval(
    recorded.diagnostic.nativeArm.before,
    policy,
  );
  assert.equal(preflightOnly.freshRowCount, 32);
  assert.equal(preflightOnly.captureEligible, false);
});

test("interval analysis is not shipped or staged as a native device resource", () => {
  assert.equal(
    [...ALL_RESOURCES, ...NATIVE_CANDIDATE_RESOURCES].some((name) =>
      name.includes("native-clock-interval-prototype"),
    ),
    false,
  );
});
