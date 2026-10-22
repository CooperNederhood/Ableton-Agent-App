import { audioObservationSchema } from "@ableton-agent/protocol";
import type { KnownListeningFixture } from "./listening-fixture.js";

export interface KnownListeningExpectation {
  readonly passId: string;
  readonly listenerId: string;
  /** Independently observed host coordinates, not copied from the result. */
  readonly startSample: number;
  readonly startBeat: number;
  readonly dspVectorSamples: number;
}

export interface ListeningVerification {
  readonly passed: boolean;
  readonly failures: readonly string[];
}

/** Numeric acceptance oracle; synthetic results do not certify a live device. */
export function verifyKnownListeningObservation(
  input: unknown,
  fixture: KnownListeningFixture,
  expected: KnownListeningExpectation,
): ListeningVerification {
  if (
    !Number.isSafeInteger(expected.startSample) ||
    expected.startSample < 0 ||
    !Number.isFinite(expected.startBeat) ||
    expected.startBeat < 0 ||
    !Number.isSafeInteger(expected.dspVectorSamples) ||
    expected.dspVectorSamples < 1 ||
    expected.dspVectorSamples > 65_536 ||
    expected.passId.length === 0 ||
    expected.listenerId.length === 0
  ) {
    throw new Error("Invalid independently supplied listening expectation");
  }
  const parsed = audioObservationSchema.safeParse(input);
  if (!parsed.success) {
    return {
      passed: false,
      failures: ["Result does not satisfy the canonical observation schema"],
    };
  }
  const observation = parsed.data;
  const failures: string[] = [];
  const check = (condition: boolean, failure: string) => {
    if (!condition) failures.push(failure);
  };
  check(observation.passId === expected.passId, "Pass identity mismatch");
  check(
    observation.listenerId === expected.listenerId,
    "Listener identity mismatch",
  );
  check(
    observation.complete && !observation.reduction.truncated,
    "Capture is partial or truncated",
  );
  check(
    observation.sampleRate === fixture.sampleRate,
    "Sample rate differs from the fixture",
  );
  check(
    observation.algorithm.timingUncertaintySamples <= expected.dspVectorSamples,
    "Reported timing uncertainty exceeds one DSP vector",
  );
  const samplesPerBeat = (fixture.sampleRate * 60) / fixture.tempo;
  const beatTolerance = expected.dspVectorSamples / samplesPerBeat;
  const durationSamples = fixture.durationBeats * samplesPerBeat;
  check(
    Math.abs(observation.startSample - expected.startSample) <=
      expected.dspVectorSamples &&
      Math.abs(
        observation.endSample - (expected.startSample + durationSamples),
      ) <= expected.dspVectorSamples,
    "Sample capture boundaries differ from independently observed host bounds",
  );
  check(
    Math.abs(observation.startBeat - expected.startBeat) <= beatTolerance &&
      Math.abs(
        observation.endBeat - (expected.startBeat + fixture.durationBeats),
      ) <= beatTolerance,
    "Beat capture boundaries differ from independently observed host bounds",
  );
  for (const channel of [0, 1] as const) {
    check(
      Math.abs(
        observation.summaries.peak[channel] - fixture.reference.peak[channel],
      ) <= 0.001,
      `Channel ${channel + 1} peak differs from quantized PCM by more than 0.001 linear`,
    );
    const actualRms = observation.summaries.rmsDbfs[channel];
    const referenceRms = fixture.reference.rmsDbfs[channel];
    check(
      referenceRms === null
        ? actualRms === null
        : actualRms !== null && Math.abs(actualRms - referenceRms) <= 0.25,
      `Channel ${channel + 1} whole-pass RMS differs from quantized PCM by more than 0.25 dB`,
    );
  }
  const centroid = observation.summaries.centroidHz;
  const centroidTolerance =
    (2 * fixture.sampleRate) / observation.algorithm.windowSamples;
  check(
    fixture.frequencyHz === null ||
      centroidTolerance <= fixture.frequencyHz / 4,
    "Analysis window is too short to discriminate the reference frequency",
  );
  check(
    fixture.frequencyHz === null
      ? centroid === null
      : centroid !== null &&
          Math.abs(centroid - fixture.frequencyHz) <= centroidTolerance,
    "Spectral centroid differs from the source by more than two FFT bins",
  );
  check(
    observation.attacks.length === fixture.onsetBeats.length,
    "Attack count has false positives or missed quarter-note gates",
  );
  const attackToleranceSamples =
    fixture.fadeSamples +
    observation.algorithm.hopSamples +
    expected.dspVectorSamples;
  check(
    attackToleranceSamples < samplesPerBeat / 2,
    "Descriptor hop is too coarse to distinguish the expected attacks",
  );
  fixture.onsetBeats.forEach((onsetBeat, index) => {
    const attack = observation.attacks[index];
    if (attack === undefined) return;
    check(
      Math.abs(
        attack.sample - (expected.startSample + onsetBeat * samplesPerBeat),
      ) <= attackToleranceSamples &&
        Math.abs(attack.beat - (expected.startBeat + onsetBeat)) <=
          attackToleranceSamples / samplesPerBeat,
      `Attack ${index + 1} is outside the source fade/hop/timing tolerance`,
    );
  });
  return { passed: failures.length === 0, failures };
}
