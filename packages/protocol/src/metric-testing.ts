import { createMetricListeningGeometry } from "./metric-listening-geometry.js";
import {
  createMetricObservationReportRows,
  deriveMetricAttackEvents,
  metricAudioObservationSchema,
  type MetricAudioObservation,
} from "./metric-observation-schemas.js";
import {
  DEFAULT_LISTENING_TIMING_POLICY,
  evaluateListeningAlignment,
} from "./listening-timing-schemas.js";
import {
  nativeMetricSpectrumPhaseSchema,
  nativeMetricSpectrumCleanupSchema,
  type NativeMetricSourceCoverageProof,
} from "./native-metric-listening-schemas.js";

/** Synthetic shared-counter acquisitions and cleared bank, never physical DSP evidence. */
export function createSyntheticMetricSpectrumEvidence(input: {
  ownership: NativeMetricSourceCoverageProof["armed"]["ownership"];
  clock: NativeMetricSourceCoverageProof["armed"]["before"];
  firstAcquisitionEndpoint: number;
  stopWatermark: number;
}) {
  const { ownership, clock, firstAcquisitionEndpoint, stopWatermark } = input;
  const receipt = (counter: number, hostMs: number) => {
    const raw = Array<number>(20).fill(0);
    raw[0] = 1;
    raw[2] = raw[18] = counter;
    return {
      raw,
      counterBefore: counter,
      counterAfter: counter,
      nativeSourceCounter: counter,
      observedHostReceiptMs: hostMs,
    };
  };
  return {
    spectrumPhase: nativeMetricSpectrumPhaseSchema.parse({
      scope: "native-metric-spectrum-phase/v1",
      ownership: structuredClone(ownership),
      fftInformation: [2048, 2048, 2048, 1],
      binding: { abi: 2, ready: [2, 1, ownership.nativeEpoch] },
      clock: structuredClone(clock),
      acquisitions: [
        firstAcquisitionEndpoint,
        firstAcquisitionEndpoint + 2048,
      ].map((endpoint) => [
        ownership.nativeEpoch,
        endpoint - 1,
        endpoint - 1,
        endpoint,
      ]),
    }),
    spectrumCleanup: nativeMetricSpectrumCleanupSchema.parse({
      type: "native-metric-spectrum-cleanup/v1",
      generation: ownership.generation,
      nativeEpoch: ownership.nativeEpoch,
      status: "completed",
      phase: "disabled-confirmed",
      outcome: "complete",
      diagnosticOnly: false,
      inputFailureReason: null,
      reason: null,
      stopWatermark,
      deadlineMs: 2010,
      requestedHostMs: 10,
      completedHostMs: 30,
      watermarkReceipt: { available: true, value: receipt(stopWatermark, 20) },
      receipt: {
        available: true,
        value: receipt(stopWatermark + clock.dsp[2], 30),
      },
    }),
  };
}

/** Synthetic contract evidence, never physical DSP or source identity proof. */
export function createSyntheticMetricListeningObservation(
  input: Partial<Parameters<typeof createMetricListeningGeometry>[0]> = {},
): MetricAudioObservation {
  const geometry = createMetricListeningGeometry({
    sampleRate: 48_000,
    vectorSize: 64,
    tempoBpm: 120,
    startBeat: 0,
    endBeat: 1,
    startSample: 10_000,
    ...input,
  });
  const uuid = "00000000-0000-4000-8000-000000000001";
  const spectralRecords: MetricAudioObservation["metrics"]["spectral-centroid"]["records"] =
    [];
  for (
    let end = geometry.startSample + 2_048;
    end <= geometry.endSample;
    end += 2_048
  ) {
    spectralRecords.push({
      index: spectralRecords.length,
      support: { startSample: end - 2_048, endSample: end },
      centroidHz: 500,
      spectralEnergy: 2,
    });
  }
  const attackRecords: MetricAudioObservation["metrics"]["attacks"]["records"] =
    [];
  const hop = Math.round(geometry.sampleRate / 10);
  for (
    let start = geometry.startSample;
    start < geometry.endSample;
    start += hop
  ) {
    attackRecords.push({
      index: attackRecords.length,
      support: {
        startSample: start,
        endSample: Math.min(start + hop, geometry.endSample),
      },
      inputLevel: { peak: [0.5, 0.5], rms: [0.25, 0.25] },
      events: [],
    });
  }
  const observation: MetricAudioObservation = {
    schema: "metric-audio-observation/v1",
    outcome: "complete",
    ownership: {
      listenerId: "listener",
      passId: "pass",
      connectionId: uuid,
      connectionEpoch: uuid,
      generation: uuid,
      nativeEpoch: 1,
      traceId: uuid,
      correlationId: "correlation",
      causationId: "causation",
    },
    sharedIntegrity: "validated",
    source: {
      view: "arrangement",
      target: { kind: "master", index: null, expectedReference: uuid },
      transport: { startBeat: geometry.startBeat, endBeat: geometry.endBeat },
    },
    geometry,
    sourceCoverage: {
      startSample: geometry.startSample,
      endSample: geometry.endSample,
    },
    alignment: evaluateListeningAlignment(DEFAULT_LISTENING_TIMING_POLICY, {
      sampleRate: geometry.sampleRate,
      vectorSize: geometry.vectorSize,
      observedClockDisagreementSamples: 64,
      observedBeatDisagreementSamples: 1,
    }),
    requestedMetrics: ["level", "spectral-centroid", "attacks"],
    metrics: {
      level: {
        status: "complete",
        expectedRecords: geometry.rows.length,
        algorithm: {
          name: "sample-grid-peak-rms",
          version: 1,
          units: "linear-amplitude",
        },
        records: geometry.rows.map((row, index) => ({
          index,
          support: { startSample: row.startSample, endSample: row.endSample },
          peak: [0.5, 0.5],
          rms: [0.25, 0.25],
        })),
        gaps: [],
        limitations: [],
      },
      "spectral-centroid": {
        status: "complete",
        expectedRecords: spectralRecords.length,
        algorithm: {
          name: "fft-energy-centroid",
          version: 1,
          fftSamples: 2_048,
          hopSamples: 2_048,
          firstFrameEndSample: geometry.startSample + 2_048,
          units: "Hz",
        },
        records: spectralRecords,
        gaps: [],
        limitations: [],
      },
      attacks: {
        status: "complete",
        expectedRecords: attackRecords.length,
        algorithm: {
          name: "level-window-rise",
          version: 1,
          dependency: "level",
          inputSource: "independent-100ms-level-windows",
          windowSamples: hop,
          thresholdDb: 6,
          minSpacingSamples: hop,
          units: "dB-rise",
        },
        records: attackRecords,
        gaps: [],
        limitations: [],
      },
    },
    rows: [],
    reduction: {
      mode: "none",
      originalReportRows: geometry.rows.length,
      retainedReportRows: geometry.rows.length,
      authoritativeTimelines: "retained",
    },
    limitations: ["Synthetic contract fixture; not actual audio evidence"],
  };
  const attackAlgorithm = observation.metrics.attacks.algorithm;
  if (attackAlgorithm === null)
    throw new Error(
      "Synthetic detector fixture requires its declared algorithm",
    );
  const detected = new Map(
    deriveMetricAttackEvents(attackRecords, attackAlgorithm).map((event) => [
      event.sample,
      event,
    ]),
  );
  for (const record of attackRecords) {
    const event = detected.get(record.support.endSample);
    record.events = event === undefined ? [] : [event];
  }
  observation.rows = createMetricObservationReportRows(observation);
  return metricAudioObservationSchema.parse(observation);
}

export function createSyntheticPartialMetricListeningObservation(
  input: Parameters<typeof createSyntheticMetricListeningObservation>[0] = {},
): MetricAudioObservation {
  const observation = createSyntheticMetricListeningObservation(input);
  const spectrum = observation.metrics["spectral-centroid"];
  const missing = spectrum.records.shift();
  if (missing === undefined)
    throw new RangeError(
      "Synthetic partial fixture requires an expected FFT frame",
    );
  spectrum.status = spectrum.records.length === 0 ? "failed" : "partial";
  spectrum.gaps = [
    {
      firstIndex: 0,
      count: 1,
      ...missing.support,
      reason: "drain-timeout",
      detail: "Synthetic missing frame; not actual audio evidence",
    },
  ];
  observation.outcome = "partial";
  observation.rows = createMetricObservationReportRows(observation);
  return metricAudioObservationSchema.parse(observation);
}
