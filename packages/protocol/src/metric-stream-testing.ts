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
  type MetricRecordStreamGap,
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
import {
  NATIVE_CONTINUOUS_METRIC_LISTENING_SCOPE,
  nativeContinuousMetricListeningConfigSchema,
  nativeContinuousMetricReadyProofSchema,
  nativeContinuousMetricArmProofSchema,
  type NativeContinuousMetricListeningConfig,
  type NativeContinuousMetricReadyProof,
  type NativeContinuousMetricArmProof,
} from "./native-continuous-metric-listening-schemas.js";

/** Synthetic counters only, never actual DSP, transport or readiness evidence. */
export function createSyntheticMetricRecordStreamTerminalProof(
  descriptor: MetricRecordStreamDescriptor,
  options: {
    status?: MetricRecordStreamTerminalProof["status"];
    capturedSamples?: number;
    stoppedBeat?: number;
    launchBeat?: number;
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
      ? (options.launchBeat ?? g.startBeat) +
        (counter - origin) / samplesPerBeat
      : (options.stoppedBeat ?? g.startBeat);
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
  missing: NonNullable<SyntheticMetricRecordStreamOptions["gaps"]>,
  suppliedRecords: SyntheticMetricRecordStreamOptions["records"],
): AsyncGenerator<MetricRecordChunk, MetricRecordStreamState> {
  let state = await createMetricRecordStreamState(descriptor);
  for (const metric of descriptor.requestedMetrics) {
    const supplied = suppliedRecords?.[metric];
    const byIndex = new Map(supplied?.map((record) => [record.index, record]));
    if (supplied && byIndex.size !== supplied.length)
      throw new RangeError("synthetic_metric_stream_duplicate_record");
    const expected = metricRecordStreamExpectedCoverage(
      descriptor,
      metric,
    ).expectedRecords;
    if (
      supplied &&
      [...byIndex.keys()].some(
        (index) =>
          !Number.isSafeInteger(index) ||
          index < 0 ||
          index >= expected ||
          missing.some(
            (gap) =>
              gap.metric === metric &&
              index >= gap.firstIndex &&
              index < gap.firstIndex + gap.count,
          ),
      )
    )
      throw new RangeError("synthetic_metric_stream_supplied_record_range");
    for (let from = 0; from < expected; from += recordsPerChunk) {
      const prefix = state.metrics.find((item) => item.metric === metric)!;
      const end = Math.min(from + recordsPerChunk, expected);
      const records = [];
      const gaps = [];
      const reasonAt = (index: number) =>
        missing.find(
          (gap) =>
            gap.metric === metric &&
            index >= gap.firstIndex &&
            index < gap.firstIndex + gap.count,
        )?.reason;
      for (let index = from; index < end;) {
        const reason = reasonAt(index);
        if (reason === undefined) {
          const record = supplied
            ? byIndex.get(index)
            : syntheticRecord(descriptor, metric, index);
          if (!record)
            throw new RangeError("synthetic_metric_stream_missing_record");
          records.push(record);
          index++;
          continue;
        }
        const firstIndex = index++;
        while (index < end && reasonAt(index) === reason) index++;
        gaps.push({
          firstIndex,
          count: index - firstIndex,
          reason,
          detail: "Synthetic explicit measurement gap.",
          support: {
            startSample: syntheticRecord(descriptor, metric, firstIndex).support
              .startSample,
            endSample: syntheticRecord(descriptor, metric, index - 1).support
              .endSample,
          },
        });
      }
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
        gaps,
        records,
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
  config: NativeContinuousMetricListeningConfig;
  ready: NativeContinuousMetricReadyProof;
  armed: NativeContinuousMetricArmProof;
}

export interface SyntheticMetricRecordStreamOptions {
  records?: {
    readonly [K in MetricRecordStreamMetric]?: readonly Extract<
      MetricRecordChunk,
      { metric: K }
    >["records"][number][];
  };
  target?: Extract<
    MetricRecordStreamDescriptor["source"],
    { view: "arrangement" }
  >["target"];
  seconds?: number;
  requestedMetrics?: readonly MetricRecordStreamMetric[];
  sampleRate?: 44_100 | 48_000;
  tempoBpm?: number;
  startBeat?: number;
  sourceOrigin?: number;
  recordsPerChunk?: number;
  source?: MetricRecordStreamDescriptor["source"];
  ownership?: MetricRecordStreamDescriptor["ownership"];
  timingPolicy?: MetricRecordStreamDescriptor["timingPolicy"];
  /** Song beat of the device's stopped clock frames (Session may differ from the clip-local start). */
  stoppedBeat?: number;
  /** Song beat Live's transport starts playing from at the capture origin. */
  launchBeat?: number;
  vectorSize?: number;
  gaps?: readonly (Pick<
    MetricRecordStreamGap,
    "firstIndex" | "count" | "reason"
  > & {
    metric: MetricRecordStreamMetric;
  })[];
  unavailableMetrics?: readonly MetricRecordStreamMetric[];
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
    captureMode: "finite-metric-stream",
    sampleRate,
    vectorSize: options.vectorSize ?? 64,
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
  if (
    Object.keys(options.records ?? {}).some(
      (metric) => !requestedMetrics.some((requested) => requested === metric),
    )
  )
    throw new RangeError("synthetic_metric_stream_unrequested_records");
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
      availability: options.unavailableMetrics?.includes(
        item.metric as MetricRecordStreamMetric,
      )
        ? "unavailable"
        : "available",
      unavailableReason: options.unavailableMetrics?.includes(
        item.metric as MetricRecordStreamMetric,
      )
        ? "Synthetic unavailable metric."
        : null,
    }));
  const descriptor = metricRecordStreamDescriptorSchema.parse({
    schema: "metric-record-stream/v1",
    capability: METRIC_CONTINUOUS_LISTENING_CAPABILITY,
    ownership: options.ownership ?? base.ownership,
    source: options.source ?? {
      ...base.source,
      target: options.target ?? base.source.target,
      transport: { startBeat: geometry.startBeat, endBeat: geometry.endBeat },
    },
    geometry,
    timingPolicy: options.timingPolicy ?? {
      mode: "descriptive",
      maxClockDisagreementSamples: 64,
    },
    requestedMetrics,
    algorithms,
    maxPendingChunks: 8,
  });
  const gaps = [
    ...(options.gaps ?? []),
    ...descriptor.algorithms.flatMap((algorithm) => {
      const count = metricRecordStreamExpectedCoverage(
        descriptor,
        algorithm.metric,
      ).expectedRecords;
      return algorithm.availability === "unavailable" && count > 0
        ? [
            {
              metric: algorithm.metric,
              firstIndex: 0,
              count,
              reason: "dependency-unavailable" as const,
            },
          ]
        : [];
    }),
  ];
  for (const gap of gaps) {
    if (
      !requestedMetrics.includes(gap.metric) ||
      !Number.isSafeInteger(gap.firstIndex) ||
      gap.firstIndex < 0 ||
      !Number.isSafeInteger(gap.count) ||
      gap.count < 1 ||
      gap.firstIndex + gap.count >
        metricRecordStreamExpectedCoverage(descriptor, gap.metric)
          .expectedRecords ||
      gaps.some(
        (other) =>
          other !== gap &&
          other.metric === gap.metric &&
          other.firstIndex < gap.firstIndex + gap.count &&
          gap.firstIndex < other.firstIndex + other.count,
      )
    )
      throw new RangeError("synthetic_metric_stream_gap_range");
  }
  const iterator = syntheticChunks(
    descriptor,
    recordsPerChunk,
    gaps,
    options.records,
  );
  let next = await iterator.next();
  while (!next.done) next = await iterator.next();
  const state = next.value;
  const nativeProof = createSyntheticMetricRecordStreamTerminalProof(
    descriptor,
    {
      ...(options.stoppedBeat === undefined
        ? {}
        : { stoppedBeat: options.stoppedBeat }),
      ...(options.launchBeat === undefined
        ? {}
        : { launchBeat: options.launchBeat }),
    },
  );
  const config = nativeContinuousMetricListeningConfigSchema.parse({
    scope: NATIVE_CONTINUOUS_METRIC_LISTENING_SCOPE,
    capability: METRIC_CONTINUOUS_LISTENING_CAPABILITY,
    algorithmVersion: "3.0.0",
    mode: descriptor.source.view,
    captureMode: geometry.captureMode,
    sourceEvidence:
      descriptor.source.view === "session"
        ? "expected-context-only"
        : "transport-only",
    ...(descriptor.source.view === "session"
      ? {
          source: {
            mode: "session",
            synchronization: "transport-coupled-first-iteration",
            target: descriptor.source.target,
          },
        }
      : {}),
    geometry: createContinuousMetricListeningGeometry({
      captureMode: geometry.captureMode,
      sampleRate,
      vectorSize: geometry.vectorSize,
      tempoBpm,
      startBeat,
      endBeat: geometry.endBeat,
      startSample: 0,
    }),
    timingPolicy: descriptor.timingPolicy,
    grid: {
      beats: 0.25,
      anchor: "global-beat-grid",
      rounding: "nearest-sample",
      coordinates: "capture-local",
    },
    sourceContext: descriptor.source,
    requestedMetrics,
    ...(requestedMetrics.includes("attacks")
      ? {
          attacks: {
            thresholdDb: 6,
            minSpacingSamples: Math.round(sampleRate / 10),
          },
        }
      : {}),
    maxPendingChunks: 8,
    maxChunkBytes: 128 * 1024,
  });
  const before = nativeProof.before;
  const first = before.frames[0]![4];
  const configurationCounter = before.frames[8]![4];
  const idleFields = Array<number>(12).fill(0);
  const idleTiming = [0, -1, 0, 0, -1, first - 1, -1, 3];
  const ready = nativeContinuousMetricReadyProofSchema.parse({
    scope: NATIVE_CONTINUOUS_METRIC_LISTENING_SCOPE,
    analyzerProducerAbi: 3,
    phase: "idle-preflight",
    configurationEvidence: "admitted-not-executed",
    ownership: descriptor.ownership,
    config,
    before,
    disarmCounter: first - 1,
    elapsedMs: 100,
    idle: {
      fields: idleFields,
      confirmedFields: idleFields,
      timing: idleTiming,
      confirmedTiming: idleTiming,
      configurationCounter,
      confirmedConfigurationCounter: configurationCounter + 1,
      timingCounter: configurationCounter + 2,
      confirmedTimingCounter: configurationCounter + 3,
      elapsedMs: 20,
    },
  });
  const timing = [
    descriptor.ownership.nativeEpoch,
    -1,
    0,
    0,
    -1,
    nativeProof.launch.timing[5],
    -1,
    3,
  ];
  const armed = nativeContinuousMetricArmProofSchema.parse({
    scope: NATIVE_CONTINUOUS_METRIC_LISTENING_SCOPE,
    analyzerProducerAbi: 3,
    ownership: descriptor.ownership,
    config,
    before,
    receipt: {
      fields: nativeProof.configuration,
      confirmedFields: nativeProof.configuration,
      timing,
      confirmedTiming: timing,
      elapsedMs: 20,
    },
  });
  const metrics = state.metrics.map((prefix) => ({
    ...prefix,
    ...metricRecordStreamExpectedCoverage(descriptor, prefix.metric),
    trailingSupport: metricRecordStreamCapturedTrailingSupport(
      descriptor,
      prefix.metric,
    ),
    availability: descriptor.algorithms.find(
      (algorithm) => algorithm.metric === prefix.metric,
    )!.availability,
    status:
      descriptor.algorithms.find(
        (algorithm) => algorithm.metric === prefix.metric,
      )!.availability === "unavailable"
        ? "failed"
        : prefix.missingRecords === 0
          ? "complete"
          : prefix.nextRecordOffset === 0
            ? "failed"
            : "partial",
  }));
  const manifest = metricRecordStreamManifestSchema.parse({
    schema: "metric-record-stream-manifest/v1",
    descriptorDigest: state.descriptorDigest,
    ownership: descriptor.ownership,
    outcome: metrics.every((metric) => metric.status === "complete")
      ? "complete"
      : metrics.some(
            (metric) =>
              metric.nextRecordOffset > 0 || metric.status === "complete",
          )
        ? "partial"
        : "failed",
    algorithms: descriptor.algorithms,
    metrics,
    nativeProof,
    limitations: [
      "Synthetic contract evidence only; not actual audio or Live qualification.",
    ],
  });
  await verifyMetricRecordStreamManifest(descriptor, state, manifest);
  return {
    descriptor,
    admission: compactMetricRecordStreamDescriptor(descriptor),
    chunks: () =>
      syntheticChunks(descriptor, recordsPerChunk, gaps, options.records),
    state,
    manifest,
    config,
    ready,
    armed,
  };
}
