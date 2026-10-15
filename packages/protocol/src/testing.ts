import {
  audioObservationSchema,
  audioObservationV2Schema,
} from "./audio-observation-schemas.js";
import { createNativeListeningGeometry } from "./native-listening-geometry.js";
import {
  DEFAULT_LISTENING_TIMING_POLICY,
  evaluateListeningAlignment,
  type ListeningTimingPolicy,
} from "./listening-timing-schemas.js";
import {
  nativeCaptureProofV2Schema,
  NATIVE_LISTENER_SCOPE_V2,
} from "./native-listening-v2-schemas.js";
import {
  nativeCaptureProofSchema,
  NATIVE_LISTENER_SCOPE,
} from "./native-listening-schemas.js";

/** Synthetic timely callbacks, not recorded native execution or readiness evidence. */
export function createSyntheticNativeListeningFixture(
  options: {
    listenerId?: string;
    passId?: string;
    algorithmVersion?: string;
    endBeat?: number;
  } = {},
) {
  const armCounter = 100032;
  const originCounter = armCounter + 512;
  const hostOffset = 1_000_000 - originCounter;
  const endBeat = options.endBeat ?? 4;
  if (endBeat <= 0 || endBeat > 20 || !Number.isInteger(endBeat * 5))
    throw new Error("Unsupported synthetic native listening range");
  const windows = Math.round(endBeat * 5);
  const duration = windows * 4800;
  const binding = (playing: boolean) => ({
    dsp: [1, 48000, 64],
    frames: Array.from({ length: 32 }, (_, index) => {
      const counter = playing
        ? originCounter + duration + 64 + index * 512
        : armCounter - 32768 + index * 512;
      const sample = counter + hostOffset;
      const beat = playing ? (counter - originCounter) / 24000 : 0;
      const phase = playing ? beat % 1 : 0.75;
      return [
        Number(playing),
        beat,
        sample,
        31,
        counter,
        phase,
        counter,
        Number(playing),
        beat,
        sample,
        31,
      ];
    }),
  });
  const spectralWindows = Array.from({ length: windows }, (_, index) => {
    const endCounter =
      Math.floor((originCounter + (index + 1) * 4800) / 2048) * 2048;
    return [endCounter - 2048 + hostOffset, endCounter + hostOffset, 0, 0];
  });
  const proof = nativeCaptureProofSchema.parse({
    armed: {
      scope: NATIVE_LISTENER_SCOPE,
      nativeEpoch: 1,
      armCounter,
      before: binding(false),
      reset: {
        launchClock: -1,
        sourceClock: -1,
        onsetCount: 0,
        rejected: 0,
        active: 0,
        launchPhaseSamples: -1,
        firstSourceClock: -1,
        completedSamples: 0,
      },
    },
    launched: {
      nativeEpoch: 1,
      armCounter,
      launchClock: 576,
      launchPhaseSamples: 64,
      rejected: 0,
      active: 1,
      host: {
        sample: 1_000_640,
        beat: 640 / 24000,
        flags: 31,
        playing: true,
      },
    },
    after: binding(true),
    spectralWindows,
  });
  const observation = audioObservationSchema.parse({
    schema: "audio-observation/v1",
    listenerId: options.listenerId ?? "native-listener",
    passId: options.passId ?? "pass",
    sampleRate: 48000,
    startSample: 1_000_000,
    endSample: 1_000_000 + duration,
    startBeat: 0,
    endBeat,
    complete: true,
    limitations: ["Synthetic unit-test fixture; not native acceptance"],
    algorithm: {
      name: "native",
      version: options.algorithmVersion ?? "1.0.0",
      windowSamples: 2048,
      hopSamples: 4800,
      settings: { attackThresholdDb: 6, minAttackSpacingSamples: 4800 },
      units: { amplitude: "linear", rms: "dBFS", centroid: "Hz" },
      timingUncertaintySamples: 64,
    },
    summaries: { peak: [0, 0], rmsDbfs: [null, null], centroidHz: null },
    samples: Array.from({ length: windows }, (_, index) => ({
      sample: 1_000_000 + (index + 1) * 4800,
      beat: ((index + 1) * 4800) / 24000,
      peak: [0, 0],
      rmsDbfs: [null, null],
      centroidHz: null,
    })),
    attacks: [],
    reduction: {
      originalSamples: windows,
      originalAttacks: 0,
      truncated: false,
    },
  });
  return { proof, observation };
}

/** Synthetic silent v2 fixture; never native execution or physical accuracy evidence. */
export function createSyntheticNativeListeningFixtureV2(
  options: {
    listenerId?: string;
    passId?: string;
    endBeat?: number;
    timingPolicy?: ListeningTimingPolicy;
    geometry?: Parameters<typeof createNativeListeningGeometry>[0];
  } = {},
) {
  const old = createSyntheticNativeListeningFixture();
  const geometry = createNativeListeningGeometry(
    options.geometry ?? {
      sampleRate: 48_000,
      vectorSize: 64,
      tempoBpm: 120,
      startBeat: 0,
      endBeat: options.endBeat ?? 4,
    },
  );
  const armCounter = old.proof.armed.armCounter;
  const originCounter = armCounter + 512;
  const hostOffset = 1_000_000 - originCounter;
  const samplesPerBeat = (geometry.sampleRate * 60) / geometry.tempoBpm;
  const windows = Math.ceil(geometry.totalSamples / geometry.hopSamples);
  const endCounter = (index: number) =>
    originCounter +
    Math.min((index + 1) * geometry.hopSamples, geometry.totalSamples);
  const binding = (playing: boolean) => ({
    dsp: [1, geometry.sampleRate, geometry.vectorSize],
    frames: Array.from({ length: 32 }, (_, index) => {
      const counter = playing
        ? originCounter +
          geometry.totalSamples +
          geometry.vectorSize +
          index * 512
        : armCounter - 32768 + index * 512;
      const sample = counter + hostOffset;
      const beat =
        geometry.startBeat +
        (playing ? (counter - originCounter) / samplesPerBeat : 0);
      const phase = beat - Math.floor(beat);
      return [
        Number(playing),
        beat,
        sample,
        31,
        counter,
        phase,
        counter,
        Number(playing),
        beat,
        sample,
        31,
      ];
    }),
  });
  const before = binding(false);
  const after = binding(true);
  const policy = options.timingPolicy ?? DEFAULT_LISTENING_TIMING_POLICY;
  const proof = nativeCaptureProofV2Schema.parse({
    ...old.proof,
    armed: {
      ...old.proof.armed,
      scope: NATIVE_LISTENER_SCOPE_V2,
      geometry,
      policy,
      before,
    },
    launched: {
      ...old.proof.launched,
      launchClock: 512 + geometry.vectorSize,
      launchPhaseSamples: geometry.vectorSize,
      host: {
        sample: 1_000_640,
        beat: geometry.startBeat + 640 / samplesPerBeat,
        flags: 31,
        playing: true,
      },
    },
    after,
    timingWitnesses: {
      minHostOffset: before.frames[0],
      maxHostOffset: before.frames[0],
      minBeatOrigin: after.frames[0],
      maxBeatOrigin: after.frames[0],
      maxPhaseDisagreement: after.frames[0],
    },
    envelopeWindows: Array.from({ length: windows }, (_, index) => [
      endCounter(index),
      0,
      0,
    ]),
    spectralWindows: Array.from({ length: windows }, (_, index) => {
      const end = Math.floor(endCounter(index) / 2048) * 2048 + hostOffset;
      return [end - 2048, end, 0, 0];
    }),
  });
  const algorithm = old.observation.algorithm;
  const observation = audioObservationV2Schema.parse({
    ...old.observation,
    schema: "audio-observation/v2",
    listenerId: options.listenerId ?? "native-listener",
    passId: options.passId ?? "pass",
    sampleRate: geometry.sampleRate,
    startBeat: geometry.startBeat,
    endBeat: geometry.startBeat + geometry.totalSamples / samplesPerBeat,
    endSample: 1_000_000 + geometry.totalSamples,
    samples: Array.from({ length: windows }, (_, index) => ({
      sample: endCounter(index) + hostOffset,
      beat:
        geometry.startBeat +
        (endCounter(index) - originCounter) / samplesPerBeat,
      peak: [0, 0],
      rmsDbfs: [null, null],
      centroidHz: null,
    })),
    reduction: {
      originalSamples: windows,
      originalAttacks: 0,
      truncated: false,
    },
    algorithm: {
      name: "native-max-stereo-energy-envelope-rise",
      version: "2.0.0",
      windowSamples: algorithm.windowSamples,
      hopSamples: geometry.hopSamples,
      settings: {
        attackThresholdDb: 6,
        minAttackSpacingSamples: geometry.hopSamples,
      },
      units: algorithm.units,
    },
    alignment: evaluateListeningAlignment(policy, {
      sampleRate: geometry.sampleRate,
      vectorSize: geometry.vectorSize,
      observedClockDisagreementSamples: 0,
      observedBeatDisagreementSamples: 0,
    }),
  });
  return { proof, observation };
}
