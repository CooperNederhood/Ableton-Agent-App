import type { AudioObservation } from "@ableton-agent/protocol";
import { describe, expect, it } from "vitest";
import { createKnownListeningFixture } from "./listening-fixture.js";
import {
  verifyKnownListeningObservation,
  type KnownListeningExpectation,
} from "./listening-verifier.js";

const expected: KnownListeningExpectation = {
  passId: "pass-oracle",
  listenerId: "listener-oracle",
  startSample: 240_000,
  startBeat: 10,
  dspVectorSamples: 64,
};

function syntheticObservation(
  kind: Parameters<typeof createKnownListeningFixture>[0] = "quarter-sine",
): AudioObservation {
  const fixture = createKnownListeningFixture(kind);
  return {
    schema: "audio-observation/v1",
    passId: expected.passId,
    listenerId: expected.listenerId,
    sampleRate: fixture.sampleRate,
    startSample: expected.startSample,
    endSample: expected.startSample + 96_000,
    startBeat: expected.startBeat,
    endBeat: expected.startBeat + 4,
    complete: true,
    limitations: [],
    algorithm: {
      name: "synthetic-oracle-test-only",
      version: "1",
      windowSamples: 2048,
      hopSamples: 512,
      settings: { attackThresholdDb: 6, minAttackSpacingSamples: 6000 },
      units: { amplitude: "linear", rms: "dBFS", centroid: "Hz" },
      timingUncertaintySamples: 64,
    },
    summaries: {
      peak: [...fixture.reference.peak],
      rmsDbfs: [...fixture.reference.rmsDbfs],
      centroidHz: fixture.frequencyHz,
    },
    samples: [],
    attacks: fixture.onsetBeats.map((beat) => ({
      sample: expected.startSample + beat * 24_000,
      beat: expected.startBeat + beat,
      strength: 0.5,
    })),
    reduction: {
      originalSamples: 0,
      originalAttacks: fixture.onsetBeats.length,
      truncated: false,
    },
  };
}

describe("independent listening measurement verifier", () => {
  it.each(["quarter-sine", "anti-phase-quarter-sine", "silence"] as const)(
    "accepts matching synthetic %s results without claiming live validation",
    (kind) => {
      expect(
        verifyKnownListeningObservation(
          syntheticObservation(kind),
          createKnownListeningFixture(kind),
          expected,
        ),
      ).toEqual({ passed: true, failures: [] });
    },
  );

  it.each([
    [
      "wrong pass",
      (value: AudioObservation) => {
        value.passId = "other";
      },
    ],
    [
      "wrong listener",
      (value: AudioObservation) => {
        value.listenerId = "other";
      },
    ],
    [
      "wrong sample rate",
      (value: AudioObservation) => {
        value.sampleRate = 44_100;
      },
    ],
    [
      "partial",
      (value: AudioObservation) => {
        value.complete = false;
      },
    ],
    [
      "truncated",
      (value: AudioObservation) => {
        value.complete = false;
        value.reduction.truncated = true;
      },
    ],
    [
      "sample coverage",
      (value: AudioObservation) => {
        value.endSample -= 128;
      },
    ],
    [
      "beat coverage",
      (value: AudioObservation) => {
        value.endBeat -= 0.1;
      },
    ],
    [
      "timing uncertainty",
      (value: AudioObservation) => {
        value.algorithm.timingUncertaintySamples = 128;
      },
    ],
    [
      "phase-cancelling downmix",
      (value: AudioObservation) => {
        value.summaries.peak = [0, 0];
        value.summaries.rmsDbfs = [null, null];
      },
    ],
    [
      "steady rather than gated RMS",
      (value: AudioObservation) => {
        value.summaries.rmsDbfs = [-9.03, -9.03];
      },
    ],
    [
      "wrong frequency",
      (value: AudioObservation) => {
        value.summaries.centroidHz = 880;
      },
    ],
    [
      "unresolvable frequency",
      (value: AudioObservation) => {
        value.algorithm.windowSamples = 1;
        value.summaries.centroidHz = 880;
      },
    ],
    [
      "missing frequency",
      (value: AudioObservation) => {
        value.summaries.centroidHz = null;
      },
    ],
    [
      "missed attack",
      (value: AudioObservation) => {
        value.attacks.pop();
        value.reduction.originalAttacks -= 1;
      },
    ],
    [
      "shifted attack",
      (value: AudioObservation) => {
        value.attacks[1]!.sample += 2400;
        value.attacks[1]!.beat += 0.1;
      },
    ],
    [
      "false-positive attack",
      (value: AudioObservation) => {
        value.attacks.push({
          sample: expected.startSample + 90_000,
          beat: expected.startBeat + 3.75,
          strength: 0.5,
        });
        value.reduction.originalAttacks += 1;
      },
    ],
    [
      "inconsistent attack coordinates",
      (value: AudioObservation) => {
        value.attacks[1]!.beat += 0.1;
      },
    ],
    [
      "coarse hop",
      (value: AudioObservation) => {
        value.algorithm.hopSamples = 12_000;
      },
    ],
  ] as const)("rejects %s", (_name, mutate) => {
    const result = syntheticObservation("anti-phase-quarter-sine");
    mutate(result);
    expect(
      verifyKnownListeningObservation(
        result,
        createKnownListeningFixture("anti-phase-quarter-sine"),
        expected,
      ).passed,
    ).toBe(false);
  });

  it("keeps FFT resolution separate from the native 100 ms reporting interval", () => {
    const fixture = createKnownListeningFixture("quarter-sine");
    const result = syntheticObservation();
    result.algorithm.windowSamples = 2048;
    result.algorithm.hopSamples = 4800;
    result.attacks = result.attacks.map((attack) => ({
      ...attack,
      sample: attack.sample + 4800,
      beat: attack.beat + 0.2,
    }));
    expect(
      verifyKnownListeningObservation(result, fixture, expected).passed,
    ).toBe(true);
    result.summaries.centroidHz = 470;
    expect(
      verifyKnownListeningObservation(result, fixture, expected).passed,
    ).toBe(true);
    result.summaries.centroidHz = 490;
    expect(
      verifyKnownListeningObservation(result, fixture, expected).passed,
    ).toBe(false);
  });

  it("accepts the stated numeric tolerance boundary and rejects values beyond it", () => {
    const fixture = createKnownListeningFixture("quarter-sine");
    const result = syntheticObservation();
    result.startSample += expected.dspVectorSamples;
    result.startBeat += expected.dspVectorSamples / 24_000;
    result.attacks[0]!.sample = result.startSample;
    result.attacks[0]!.beat = result.startBeat;
    result.summaries.rmsDbfs[0] = fixture.reference.rmsDbfs[0]! + 0.25;
    expect(
      verifyKnownListeningObservation(result, fixture, expected).passed,
    ).toBe(true);
    result.startSample += 1;
    expect(
      verifyKnownListeningObservation(result, fixture, expected).passed,
    ).toBe(false);
  });

  it("rejects malformed results, invented silent descriptors and unsafe host expectations", () => {
    const fixture = createKnownListeningFixture("silence");
    expect(verifyKnownListeningObservation({}, fixture, expected).passed).toBe(
      false,
    );
    const result = syntheticObservation("silence");
    result.summaries.centroidHz = 440;
    result.summaries.rmsDbfs = [-120, -120];
    expect(
      verifyKnownListeningObservation(result, fixture, expected).passed,
    ).toBe(false);
    expect(() =>
      verifyKnownListeningObservation(result, fixture, {
        ...expected,
        dspVectorSamples: Number.NaN,
      }),
    ).toThrow("Invalid independently supplied listening expectation");
  });
});
