import { z } from "zod";

/** Availability must be advertised only after producer/host admission. Defining
 * this capability does not advertise it or upgrade historical diagnostics. */
export const LISTENER_CAPABILITY_ANALYZER_TIMELINES =
  "audio-listener/analyzer-timelines-v1";
export const ANALYZER_PRODUCER_ABI = 3;
export const ANALYZER_WINDOW_SAMPLES = 2048;
export const MAX_ANALYZER_SECONDS = 30;
export const MAX_ANALYZER_FRAMES = 703; // floor(48000 * 30 / 2048)
export const MAX_ANALYZER_SOURCE_SAMPLE = 2 ** 44 - 1;
export const MAX_ANALYZER_INPUT_AMPLITUDE = 64;
export const MAX_ANALYZER_MAGNITUDE = 64 * 2048;
export const SPECTRAL_MAGNITUDE_FLOOR = Number.EPSILON;
export const MIN_SPECTRAL_FLATNESS_DB = 20 * Math.log10(Number.EPSILON);
export const MAX_SPECTRAL_FLATNESS_DB = 1e-10; // floating-point roundoff only
export const PITCH_CONFIDENCE_THRESHOLD = 0.9;
export const PITCH_TESTED_MAX_ERROR_CENTS = 20;
export const PITCH_OUTPUT_MINIMUM_HZ = 196 * 2 ** (-20 / 1200);
export const PITCH_OUTPUT_MAXIMUM_HZ = 1760 * 2 ** (20 / 1200);

export const analyzerSampleRateSchema = z.union([
  z.literal(44100),
  z.literal(48000),
]);
/** Receipt from an actual ABI3 perform, not a bundled-binary/version claim.
 * The registration owner must also match its token and current DSP rate. */
export const analyzerNativeReadinessSchema = z
  .strictObject({
    schema: z.literal("analyzer-native-readiness/v1"),
    producerAbi: z.literal(3),
    sourceAbi: z.literal(3),
    probeToken: z.number().int().min(1).max(MAX_ANALYZER_SOURCE_SAMPLE),
    dspGeneration: z.number().int().min(1).max(MAX_ANALYZER_SOURCE_SAMPLE),
    sampleRate: analyzerSampleRateSchema,
    sourceClock: z.number().int().min(0).max(MAX_ANALYZER_SOURCE_SAMPLE),
  })
  .readonly();
export type AnalyzerNativeReadiness = z.infer<
  typeof analyzerNativeReadinessSchema
>;

/** Additive fault-point evidence, never readiness or measurement authority.
 * Actual operands deliberately allow invalid finite values; null explicitly
 * means nonfinite at the native serializer, not a fabricated zero. */
export const analyzerNativeSourceIdentitySchema = z
  .strictObject({
    schema: z.literal("analyzer-native-source-identity/v1"),
    producerAbi: z.literal(3),
    expectedEpoch: z.number().int().min(1).max(MAX_ANALYZER_SOURCE_SAMPLE),
    expectedGeneration: z.number().int().min(1).max(MAX_ANALYZER_SOURCE_SAMPLE),
    completedFrames: z.number().int().min(0).max(MAX_ANALYZER_FRAMES),
    sourceAbi: z.number().finite().nullable(),
    sourceEpoch: z.number().finite().nullable(),
    sourceRejected: z.number().finite().nullable(),
    sourceSealedEpoch: z.number().finite().nullable(),
    sourceClock: z.number().finite().nullable(),
  })
  .readonly();
export type AnalyzerNativeSourceIdentity = z.infer<
  typeof analyzerNativeSourceIdentitySchema
>;

/** Immutable upstream sources, not a claim to reproduce the stock Max wrapper.
 * The application adapter binary will be pinned separately on publication. */
export const ANALYZER_SOURCE_PINS = Object.freeze({
  core: "f1551f7057bd0f14d2ca2b4a542715fe460354e0",
  hiss: "f3292adbc978c09dc43bedbfe2faa6e791b87594",
  eigen: "3147391d946bb4b6c68edd901f2add6ac1f31f8c",
  memory: "0f0775770fd1c506fa9c5ad566bd6ba59659db66",
  maxSdkBase: "c03a2922a2a8ff149165a1e2ea134e9321d6e202",
} as const);
export const ANALYZER_QUALIFICATION_BUILD = Object.freeze({
  compiler: "Apple clang version 17.0.0 (clang-1700.6.3.2)",
  cmake: "3.31.6",
  sdk: "26.2",
  executedArchitecture: "arm64",
  deploymentTarget: "11.0",
  scope: "offline-controlled-inputs",
} as const);
const pinsSchema = z
  .strictObject({
    core: z.literal(ANALYZER_SOURCE_PINS.core),
    hiss: z.literal(ANALYZER_SOURCE_PINS.hiss),
    eigen: z.literal(ANALYZER_SOURCE_PINS.eigen),
    memory: z.literal(ANALYZER_SOURCE_PINS.memory),
    maxSdkBase: z.literal(ANALYZER_SOURCE_PINS.maxSdkBase),
  })
  .readonly();
const buildSchema = z
  .strictObject({
    compiler: z.literal(ANALYZER_QUALIFICATION_BUILD.compiler),
    cmake: z.literal("3.31.6"),
    sdk: z.literal("26.2"),
    executedArchitecture: z.literal("arm64"),
    deploymentTarget: z.literal("11.0"),
    scope: z.literal("offline-controlled-inputs"),
  })
  .readonly();
const commonProfile = {
  sourcePins: ANALYZER_SOURCE_PINS,
  qualificationBuild: ANALYZER_QUALIFICATION_BUILD,
  channelMode: "independent-stereo",
  windowType: "hann-periodic",
  windowSamples: 2048,
  hopSamples: 2048,
  fftSamples: 2048,
  fftMagnitude: "unnormalized-real-dft",
  maximumInputAmplitude: MAX_ANALYZER_INPUT_AMPLITUDE,
  maximumMagnitude: MAX_ANALYZER_MAGNITUDE,
} as const;
const commonShape = {
  sourcePins: pinsSchema,
  qualificationBuild: buildSchema,
  channelMode: z.literal("independent-stereo"),
  windowType: z.literal("hann-periodic"),
  windowSamples: z.literal(2048),
  hopSamples: z.literal(2048),
  fftSamples: z.literal(2048),
  fftMagnitude: z.literal("unnormalized-real-dft"),
  maximumInputAmplitude: z.literal(MAX_ANALYZER_INPUT_AMPLITUDE),
  maximumMagnitude: z.literal(MAX_ANALYZER_MAGNITUDE),
};
const sineInputs = Object.freeze([
  196, 220, 261.625565, 440, 880, 1760,
] as const);
const sineAmplitudes = Object.freeze([0.01, 0.2, 0.9] as const);
const sinePhases = Object.freeze([0, 0.37, 1.3, 2.4] as const);
export const PITCH_PROFILE = Object.freeze({
  ...commonProfile,
  schema: "pitch-profile/v1",
  algorithm: "YinFFT",
  minimumHz: 50,
  maximumHz: 2000,
  units: "Hz",
  confidenceUnits: "algorithm-score-not-probability",
  confidenceThreshold: PITCH_CONFIDENCE_THRESHOLD,
  outputMinimumHz: PITCH_OUTPUT_MINIMUM_HZ,
  outputMaximumHz: PITCH_OUTPUT_MAXIMUM_HZ,
  testedInputHz: sineInputs,
  testedAmplitudes: sineAmplitudes,
  testedPhasesRadians: sinePhases,
  testedMaximumErrorCents: PITCH_TESTED_MAX_ERROR_CENTS,
  acceptanceMeaning: "estimate-gate-not-input-class-or-accuracy-proof",
  knownCounterexample: "2000Hz-sine-high-confidence-1000Hz-octave",
} as const);
export const pitchProfileSchema = z
  .strictObject({
    ...commonShape,
    schema: z.literal("pitch-profile/v1"),
    algorithm: z.literal("YinFFT"),
    minimumHz: z.literal(50),
    maximumHz: z.literal(2000),
    units: z.literal("Hz"),
    confidenceUnits: z.literal("algorithm-score-not-probability"),
    confidenceThreshold: z.literal(PITCH_CONFIDENCE_THRESHOLD),
    outputMinimumHz: z.literal(PITCH_OUTPUT_MINIMUM_HZ),
    outputMaximumHz: z.literal(PITCH_OUTPUT_MAXIMUM_HZ),
    testedInputHz: z
      .tuple([
        z.literal(196),
        z.literal(220),
        z.literal(261.625565),
        z.literal(440),
        z.literal(880),
        z.literal(1760),
      ])
      .readonly(),
    testedAmplitudes: z
      .tuple([z.literal(0.01), z.literal(0.2), z.literal(0.9)])
      .readonly(),
    testedPhasesRadians: z
      .tuple([z.literal(0), z.literal(0.37), z.literal(1.3), z.literal(2.4)])
      .readonly(),
    testedMaximumErrorCents: z.literal(20),
    acceptanceMeaning: z.literal(
      "estimate-gate-not-input-class-or-accuracy-proof",
    ),
    knownCounterexample: z.literal("2000Hz-sine-high-confidence-1000Hz-octave"),
  })
  .readonly();
export type PitchProfile = z.infer<typeof pitchProfileSchema>;

export const SPECTRAL_SHAPE_PROFILE = Object.freeze({
  ...commonProfile,
  schema: "spectral-shape-profile/v1",
  algorithm: "SpectralShape",
  magnitudeMode: "magnitude",
  frequencyScale: "linear",
  minimumHz: 0,
  maximumHz: "nyquist",
  rolloffPercent: 95,
  magnitudeFloor: SPECTRAL_MAGNITUDE_FLOOR,
  firstIncludedBin: 0,
  lastIncludedBin: 1023,
  nyquistBin: "excluded",
  frequencyGrid: "k*sampleRate/(2*1023)",
  flatness: "20log10(max(geometricMean/arithmeticMean,epsilon))",
  spread: "magnitude-weighted-population-standard-deviation-Hz",
  rolloff: "magnitude-cumulative-95-percent-linear-interpolation-Hz",
  silencePolicy: "exact-zero-unavailable",
  floorOnlyPolicy: "no-selected-magnitude-above-epsilon-unavailable",
  minimumFlatnessDb: MIN_SPECTRAL_FLATNESS_DB,
  maximumFlatnessDb: MAX_SPECTRAL_FLATNESS_DB,
  oracleToleranceDb: 1e-5,
  oracleToleranceHz: 1e-7,
} as const);
export const spectralShapeProfileSchema = z
  .strictObject({
    ...commonShape,
    schema: z.literal("spectral-shape-profile/v1"),
    algorithm: z.literal("SpectralShape"),
    magnitudeMode: z.literal("magnitude"),
    frequencyScale: z.literal("linear"),
    minimumHz: z.literal(0),
    maximumHz: z.literal("nyquist"),
    rolloffPercent: z.literal(95),
    magnitudeFloor: z.literal(SPECTRAL_MAGNITUDE_FLOOR),
    firstIncludedBin: z.literal(0),
    lastIncludedBin: z.literal(1023),
    nyquistBin: z.literal("excluded"),
    frequencyGrid: z.literal(SPECTRAL_SHAPE_PROFILE.frequencyGrid),
    flatness: z.literal(SPECTRAL_SHAPE_PROFILE.flatness),
    spread: z.literal(SPECTRAL_SHAPE_PROFILE.spread),
    rolloff: z.literal(SPECTRAL_SHAPE_PROFILE.rolloff),
    silencePolicy: z.literal("exact-zero-unavailable"),
    floorOnlyPolicy: z.literal(
      "no-selected-magnitude-above-epsilon-unavailable",
    ),
    minimumFlatnessDb: z.literal(MIN_SPECTRAL_FLATNESS_DB),
    maximumFlatnessDb: z.literal(MAX_SPECTRAL_FLATNESS_DB),
    oracleToleranceDb: z.literal(1e-5),
    oracleToleranceHz: z.literal(1e-7),
  })
  .readonly();
export type SpectralShapeProfile = z.infer<typeof spectralShapeProfileSchema>;
