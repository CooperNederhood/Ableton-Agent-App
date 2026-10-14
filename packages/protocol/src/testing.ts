import { audioObservationSchema } from "./audio-observation-schemas.js";
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
      windowSamples: 4800,
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
