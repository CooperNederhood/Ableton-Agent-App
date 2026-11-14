import {
  acceptMetricRecordChunk,
  compactMetricRecordStreamDescriptor,
  createMetricRecordStreamState,
  metricRecordChunkDigest,
  metricRecordChunkSchema,
  metricRecordStreamCapturedTrailingSupport,
  metricRecordStreamDescriptorSchema,
  metricRecordStreamExpectedCoverage,
  metricRecordStreamManifestSchema,
  metricRecordStreamTerminalProofSchema,
  verifyMetricRecordStreamManifest,
  type MetricRecordChunk,
  type MetricRecordStreamDescriptor,
  type MetricRecordStreamMetric,
  type MetricRecordStreamState,
  type MetricRecordStreamTerminalProof,
  type MetricRecordStreamAdmission,
  type MetricRecordStreamManifest,
} from "./metric-record-stream.js";
import {
  createContinuousMetricListeningGeometry,
  METRIC_CONTINUOUS_LISTENING_CAPABILITY,
} from "./metric-continuous-geometry.js";
import {
  createSyntheticMetricListeningObservation,
  createSyntheticMetricSpectrumEvidence,
} from "./metric-testing.js";
import { MEL_BAND_PROFILE } from "./mel-band-profile.js";
import { PITCH_PROFILE, SPECTRAL_SHAPE_PROFILE } from "./analyzer-profile.js";
import type { NativeMetricLaunchProof } from "./native-metric-listening-schemas.js";

/** Synthetic counters only, never actual DSP, transport or readiness evidence. */
export function createSyntheticMetricRecordStreamTerminalProof(
  descriptor: MetricRecordStreamDescriptor,
  options: {
    status?: MetricRecordStreamTerminalProof["status"];
    capturedSamples?: number;
  } = {},
): MetricRecordStreamTerminalProof {
  const d = metricRecordStreamDescriptorSchema.parse(descriptor);
  const g = d.geometry;
  if (g.startSample < 10_000)
    throw new RangeError("synthetic_metric_stream_origin_too_small");
  const status = options.status ?? "completed";
  const capturedSamples = options.capturedSamples ?? g.totalSamples;
  if (
    !Number.isSafeInteger(capturedSamples) ||
    capturedSamples < 0 ||
    capturedSamples > g.totalSamples
  )
    throw new RangeError("synthetic_metric_stream_captured_sample_limit");
  const origin = g.startSample;
  const arm = origin - 1000;
  const end = origin + capturedSamples;
  const samplesPerBeat = (g.sampleRate * 60) / g.tempoBpm;
  type Row = NativeMetricLaunchProof["clock"];
  const row = (counter: number, playing: boolean): Row => {
    const beat = playing
      ? g.startBeat + (counter - origin) / samplesPerBeat
      : g.startBeat;
    return [
      playing ? 1 : 0,
      beat,
      counter + 1_000_000,
      19,
      counter,
      playing ? beat % 1 : 0.125,
      counter,
      playing ? 1 : 0,
      beat,
      counter + 1_000_000,
      19,
    ];
  };
  const before = {
    dsp: [1, g.sampleRate, g.vectorSize],
    frames: Array.from({ length: 32 }, (_, i) =>
      row(arm - (32 - i) * 256, false),
    ),
  };
  const after = {
    dsp: [1, g.sampleRate, g.vectorSize],
    frames: Array.from({ length: 32 }, (_, i) =>
      row(end + g.vectorSize + i * g.vectorSize, true),
    ),
  };
  const clock = {
    dsp: [1, g.sampleRate, g.vectorSize],
    frames: Array.from({ length: 32 }, (_, i) =>
      row(end + 4096 + i * g.vectorSize, true),
    ),
  };
  const launchClock = row(origin + g.vectorSize, true);
  const timing = [
    d.ownership.nativeEpoch,
    1000 + g.vectorSize,
    0,
    0,
    g.vectorSize,
    arm,
    origin,
    3,
  ];
  const configuration = [
    d.ownership.nativeEpoch,
    g.totalSamples,
    Math.round(g.sampleRate / 10),
    g.tempoBpm,
    g.startBeat - Math.floor(g.startBeat),
    g.vectorSize,
    1,
    g.startBeat,
    g.endBeat,
    g.rows.length,
    d.ownership.nativeEpoch,
    d.ownership.nativeEpoch,
  ];
  const clocks = [...before.frames, ...after.frames, launchClock];
  const playing = [...after.frames, launchClock];
  const extreme = (rows: Row[], value: (row: Row) => number, max: boolean) =>
    rows.reduce((a, b) =>
      (max ? value(b) > value(a) : value(b) < value(a)) ? b : a,
    );
  const beatOrigin = (r: Row) =>
    r[2] - Math.round((r[1] - g.startBeat) * samplesPerBeat);
  const phase = (r: Row) => {
    const difference = Math.abs(
      Math.round(r[5] * samplesPerBeat) -
        Math.round((r[1] % 1) * samplesPerBeat),
    );
    return Math.min(
      difference,
      Math.abs(Math.round(samplesPerBeat) - difference),
    );
  };
  const centroid = d.algorithms.find(
    (item) => item.metric === "spectral-centroid",
  );
  const phaseShift =
    centroid?.metric === "spectral-centroid"
      ? ((centroid.algorithm?.firstFrameEndSample ?? origin + 2048) - origin) %
        2048
      : 0;
  const spectrum = createSyntheticMetricSpectrumEvidence({
    ownership: d.ownership,
    clock: before as Parameters<
      typeof createSyntheticMetricSpectrumEvidence
    >[0]["clock"],
    firstAcquisitionEndpoint: origin - 6144 + phaseShift,
    stopWatermark: end,
  });
  return metricRecordStreamTerminalProofSchema.parse({
    schema: "metric-record-stream-terminal/v1",
    ownership: d.ownership,
    status,
    launch: {
      scope: "independent-metric-timelines/v1",
      ownership: d.ownership,
      timing: [
        d.ownership.nativeEpoch,
        1000 + g.vectorSize,
        0,
        1,
        g.vectorSize,
        arm,
        origin,
        3,
      ],
      clock: launchClock,
      elapsedMs: 100,
    },
    timing,
    confirmedTiming: timing,
    configuration,
    confirmedConfiguration: configuration,
    before,
    after,
    clock,
    timingWitnesses: {
      minHostOffset: extreme(clocks, (r) => r[2] - r[4], false),
      maxHostOffset: extreme(clocks, (r) => r[2] - r[4], true),
      minBeatOrigin: extreme(playing, beatOrigin, false),
      maxBeatOrigin: extreme(playing, beatOrigin, true),
      maxPhaseDisagreement: extreme(playing, phase, true),
    },
    capturedSamples,
    sourceOrigin: origin,
    sourceEnd: end,
    drain: status === "completed" ? "completed" : status,
    spectrumCleanup: spectrum.spectrumCleanup,
    spectrumPhase: spectrum.spectrumPhase,
  });
}

function syntheticRecord(
  d: MetricRecordStreamDescriptor,
  metric: MetricRecordStreamMetric,
  index: number,
) {
  const g = d.geometry;
  const hop = metric === "attacks" ? Math.round(g.sampleRate / 10) : 2048;
  const gridRow = g.rows[index];
  const support =
    metric === "level"
      ? { startSample: gridRow!.startSample, endSample: gridRow!.endSample }
      : {
          startSample: g.startSample + index * hop,
          endSample: Math.min(g.startSample + (index + 1) * hop, g.endSample),
        };
  const base = { index, support };
  switch (metric) {
    case "level":
      return { ...base, peak: [0, 0], rms: [0, 0] };
    case "spectral-centroid":
      return { ...base, spectralEnergy: 0, centroidHz: null };
    case "attacks":
      return { ...base, inputLevel: { peak: [0, 0], rms: [0, 0] }, events: [] };
    case "mel-bands":
      return {
        ...base,
        magnitudes: [Array<number>(24).fill(0), Array<number>(24).fill(0)],
      };
    case "pitch":
      return {
        ...base,
        channels: Array.from({ length: 2 }, () => ({
          state: "silence",
          hz: null,
          confidence: null,
        })),
      };
    case "spectral-shape":
      return {
        ...base,
        channels: Array.from({ length: 2 }, () => ({
          state: "silence",
          flatnessDb: null,
          spreadHz: null,
          rolloffHz: null,
        })),
      };
  }
}

async function* syntheticChunks(
  descriptor: MetricRecordStreamDescriptor,
  recordsPerChunk: number,
): AsyncGenerator<MetricRecordChunk, MetricRecordStreamState> {
  let state = await createMetricRecordStreamState(descriptor);
  for (const metric of descriptor.requestedMetrics) {
    const expected = metricRecordStreamExpectedCoverage(
      descriptor,
      metric,
    ).expectedRecords;
    for (let from = 0; from < expected; from += recordsPerChunk) {
      const prefix = state.metrics.find((item) => item.metric === metric)!;
      const value = metricRecordChunkSchema.parse({
        schema: "metric-record-chunk/v1",
        descriptorDigest: state.descriptorDigest,
        ownership: descriptor.ownership,
        metric,
        chunkSequence: prefix.nextChunkSequence,
        recordOffset: prefix.nextRecordOffset,
        slotOffset: prefix.nextIndex,
        previousDigest: prefix.lastDigest,
        digest: "0".repeat(64),
        gaps: [],
        records: Array.from(
          { length: Math.min(recordsPerChunk, expected - from) },
          (_, offset) => syntheticRecord(descriptor, metric, from + offset),
        ),
      });
      value.digest = await metricRecordChunkDigest(value);
      state = await acceptMetricRecordChunk(descriptor, state, value);
      yield value;
    }
  }
  return state;
}

export interface SyntheticMetricRecordStreamFixture {
  descriptor: MetricRecordStreamDescriptor;
  admission: MetricRecordStreamAdmission;
  chunks: () => AsyncGenerator<MetricRecordChunk, MetricRecordStreamState>;
  state: MetricRecordStreamState;
  manifest: MetricRecordStreamManifest;
}

export interface SyntheticMetricRecordStreamOptions {
  target?: MetricRecordStreamDescriptor["source"]["target"];
  seconds?: number;
  requestedMetrics?: readonly MetricRecordStreamMetric[];
  sampleRate?: 44_100 | 48_000;
  tempoBpm?: number;
  startBeat?: number;
  sourceOrigin?: number;
  recordsPerChunk?: number;
}

/** Synthetic contract evidence only, never actual audio or native qualification. */
export async function createSyntheticMetricRecordStreamManifest(
  options: SyntheticMetricRecordStreamOptions = {},
): Promise<MetricRecordStreamManifest> {
  return (await createSyntheticMetricRecordStreamFixture(options)).manifest;
}

/** Reentrant bounded iterators, not retained long timelines or real-host proof. */
export async function createSyntheticMetricRecordStreamFixture(
  options: SyntheticMetricRecordStreamOptions = {},
): Promise<SyntheticMetricRecordStreamFixture> {
  const seconds = options.seconds ?? 0.5;
  const sampleRate = options.sampleRate ?? 48_000;
  const tempoBpm = options.tempoBpm ?? 120;
  const startBeat = options.startBeat ?? 0;
  const recordsPerChunk = options.recordsPerChunk ?? 32;
  if (
    !Number.isInteger(recordsPerChunk) ||
    recordsPerChunk < 1 ||
    recordsPerChunk > 256
  )
    throw new RangeError("synthetic_metric_stream_chunk_record_limit");
  const base = createSyntheticMetricListeningObservation();
  const geometry = createContinuousMetricListeningGeometry({
    captureMode: "arrangement-continuous",
    sampleRate,
    vectorSize: 64,
    tempoBpm,
    startBeat,
    endBeat: startBeat + (seconds * tempoBpm) / 60,
    startSample: options.sourceOrigin ?? 100_000,
  });
  const requestedMetrics = [
    ...(options.requestedMetrics ?? [
      "level",
      "spectral-centroid",
      "attacks",
      "mel-bands",
      "pitch",
      "spectral-shape",
    ]),
  ];
  const algorithms = [
    { metric: "level", algorithm: base.metrics.level.algorithm },
    {
      metric: "spectral-centroid",
      algorithm: {
        ...base.metrics["spectral-centroid"].algorithm!,
        firstFrameEndSample: geometry.startSample + 2048,
      },
    },
    {
      metric: "attacks",
      algorithm: {
        ...base.metrics.attacks.algorithm!,
        windowSamples: Math.round(sampleRate / 10),
        minSpacingSamples: Math.round(sampleRate / 10),
      },
    },
    { metric: "mel-bands", algorithm: MEL_BAND_PROFILE },
    { metric: "pitch", algorithm: PITCH_PROFILE },
    { metric: "spectral-shape", algorithm: SPECTRAL_SHAPE_PROFILE },
  ]
    .filter((item) =>
      requestedMetrics.includes(item.metric as MetricRecordStreamMetric),
    )
    .map((item) => ({
      ...item,
      availability: "available",
      unavailableReason: null,
    }));
  const descriptor = metricRecordStreamDescriptorSchema.parse({
    schema: "metric-record-stream/v1",
    capability: METRIC_CONTINUOUS_LISTENING_CAPABILITY,
    ownership: base.ownership,
    source: {
      ...base.source,
      target: options.target ?? base.source.target,
      transport: { startBeat: geometry.startBeat, endBeat: geometry.endBeat },
    },
    geometry,
    timingPolicy: { mode: "descriptive", maxClockDisagreementSamples: 64 },
    requestedMetrics,
    algorithms,
    maxPendingChunks: 8,
  });
  const iterator = syntheticChunks(descriptor, recordsPerChunk);
  let next = await iterator.next();
  while (!next.done) next = await iterator.next();
  const state = next.value;
  const nativeProof =
    createSyntheticMetricRecordStreamTerminalProof(descriptor);
  const manifest = metricRecordStreamManifestSchema.parse({
    schema: "metric-record-stream-manifest/v1",
    descriptorDigest: state.descriptorDigest,
    ownership: descriptor.ownership,
    outcome: "complete",
    algorithms: descriptor.algorithms,
    metrics: state.metrics.map((prefix) => ({
      ...prefix,
      ...metricRecordStreamExpectedCoverage(descriptor, prefix.metric),
      trailingSupport: metricRecordStreamCapturedTrailingSupport(
        descriptor,
        prefix.metric,
      ),
      availability: "available",
      status: "complete",
    })),
    nativeProof,
    limitations: [
      "Synthetic contract evidence only; not actual audio or Live qualification.",
    ],
  });
  await verifyMetricRecordStreamManifest(descriptor, state, manifest);
  return {
    descriptor,
    admission: compactMetricRecordStreamDescriptor(descriptor),
    chunks: () => syntheticChunks(descriptor, recordsPerChunk),
    state,
    manifest,
  };
}
