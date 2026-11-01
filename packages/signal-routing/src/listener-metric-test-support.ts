import type { z } from "zod";
import {
  assertNativeMetricSourceCoverage,
  createMetricListeningGeometry,
  metricAudioObservationSchema,
  nativeMetricSourceCoverageProofSchema,
  nativeMetricReadyProofSchema,
  type NativeMetricListeningConfig,
  type nativeHostClockRowSchema,
} from "@ableton-agent/protocol";
import {
  createSyntheticMetricListeningObservation,
  createSyntheticPartialMetricListeningObservation,
  createSyntheticMetricSpectrumEvidence,
} from "@ableton-agent/protocol/testing";
import {
  LISTENER_CAPABILITY_METRIC,
  LISTENER_METRIC_SCOPE,
  listenerControlMetricSchema,
  type ListenerControlMetric,
} from "./listener-metric-contracts.js";

export type NativeHostClockRow = z.infer<typeof nativeHostClockRowSchema>;

/** New ABI3 synthetic readbacks only; never legacy capture/physical DSP proof. */
export function createSyntheticMetricWireFixture(
  mode: "arrangement" | "session" = "arrangement",
  partial = false,
  large: boolean | { tempoBpm: number; endBeat: number } = false,
) {
  const observation = (
    partial
      ? createSyntheticPartialMetricListeningObservation
      : createSyntheticMetricListeningObservation
  )({
    startSample: 200_000,
    ...(typeof large === "object"
      ? large
      : large
        ? { tempoBpm: 999, endBeat: 80 }
        : {}),
  });
  const ownership = observation.ownership;
  const wire = {
    protocolVersion: 1,
    listenerVersion: 5,
    mode,
    listenerId: ownership.listenerId,
    connectionId: ownership.connectionId,
    connectionEpoch: ownership.connectionEpoch,
    generation: ownership.generation,
    requestId: "synthetic-request",
    jobId: "synthetic-job",
    passId: ownership.passId,
    traceId: ownership.traceId,
    correlationId: ownership.correlationId,
    causationId: ownership.causationId,
    sequence: 0,
  };
  const target = {
    view: "session" as const,
    sceneIndex: 0,
    expectedClipReference: ownership.connectionId,
    expectedClipName: "Synthetic clip",
    track: {
      kind: "regular" as const,
      index: 0,
      expectedReference: ownership.connectionId,
      expectedName: "Synthetic track",
    },
  };
  const attackAlgorithm = observation.metrics.attacks.algorithm;
  if (attackAlgorithm === null)
    throw new Error("Synthetic fixture requires explicit attack settings");
  const config: NativeMetricListeningConfig = {
    scope: "independent-metric-timelines/v1",
    algorithmVersion: "3.0.0",
    geometry: createMetricListeningGeometry({
      sampleRate: observation.geometry.sampleRate,
      vectorSize: observation.geometry.vectorSize,
      tempoBpm: observation.geometry.tempoBpm,
      startBeat: observation.geometry.startBeat,
      endBeat: observation.geometry.endBeat,
      startSample: 0,
    }),
    timingPolicy: observation.alignment.policy,
    grid: {
      beats: 0.25,
      anchor: "global-beat-grid",
      rounding: "nearest-sample",
      coordinates: "capture-local",
    },
    requestedMetrics: observation.requestedMetrics,
    attacks: {
      thresholdDb: attackAlgorithm.thresholdDb,
      minSpacingSamples: attackAlgorithm.minSpacingSamples,
    },
    ...(mode === "session"
      ? {
          mode,
          sourceEvidence: "expected-context-only",
          source: {
            mode,
            synchronization: "transport-coupled-first-iteration",
            target,
          },
        }
      : { mode, sourceEvidence: "transport-only" }),
  };
  if (mode === "session")
    observation.source = {
      view: "session",
      target,
      clipReference: target.expectedClipReference,
      kind: "warped-audio",
      coordinate: {
        unit: "beats",
        iteration: 0,
        startBeat: 0,
        endBeat: observation.geometry.endBeat,
      },
      transport: { startBeat: 0, endBeat: observation.geometry.endBeat },
      clipStartTimeBeats: 0,
      synchronization: "transport-coupled-first-iteration",
    };
  const owner = {
    ...ownership,
    listenerId: ownership.listenerId,
    passId: ownership.passId,
    connectionEpoch: ownership.connectionEpoch,
    generation: ownership.generation,
    nativeEpoch: ownership.nativeEpoch,
  };
  const g = observation.geometry;
  const origin = 200_000;
  const armCounter = origin - 1_000;
  const row = (counter: number, playing: boolean): NativeHostClockRow => {
    const beat = playing
      ? ((counter - origin) * g.tempoBpm) / (g.sampleRate * 60)
      : 0;
    return [
      Number(playing) as 0 | 1,
      beat,
      counter + 800_000,
      31,
      counter,
      playing ? beat % 1 : 0.618,
      counter,
      Number(playing) as 0 | 1,
      beat,
      counter + 800_000,
      31,
    ];
  };
  const before = Array.from({ length: 32 }, (_, index) =>
    row(armCounter - (32 - index) * 512, false),
  );
  const after = Array.from({ length: 32 }, (_, index) =>
    row(origin + g.totalSamples + g.vectorSize + 64 + index * 512, true),
  );
  const launch = row(origin + g.vectorSize, true);
  const fields = [
    owner.nativeEpoch,
    g.totalSamples,
    g.sampleRate / 10,
    g.tempoBpm,
    0,
    g.vectorSize,
    1,
    0,
    g.endBeat,
    g.rows.length,
    owner.nativeEpoch,
    owner.nativeEpoch,
  ];
  const armedTiming = [owner.nativeEpoch, -1, 0, 0, -1, armCounter, -1, 3];
  const launchTiming = [
    owner.nativeEpoch,
    1_000 + g.vectorSize,
    0,
    1,
    g.vectorSize,
    armCounter,
    origin,
    3,
  ];
  const completionTiming = [...launchTiming];
  completionTiming[3] = 0;
  const clocks = [...before, ...after, launch];
  const playing = [...after, launch];
  const extreme = (
    rows: NativeHostClockRow[],
    value: (r: NativeHostClockRow) => number,
    max: boolean,
  ) =>
    rows.reduce((best, current) =>
      (max ? value(current) > value(best) : value(current) < value(best))
        ? current
        : best,
    );
  const beatOrigin = (r: NativeHostClockRow) =>
    r[2] - Math.round((r[1] * g.sampleRate * 60) / g.tempoBpm);
  const phase = (r: NativeHostClockRow) =>
    Math.abs(
      Math.round((r[5] * g.sampleRate * 60) / g.tempoBpm) -
        Math.round(((r[1] % 1) * g.sampleRate * 60) / g.tempoBpm),
    );
  const proof = nativeMetricSourceCoverageProofSchema.parse({
    armed: {
      scope: LISTENER_METRIC_SCOPE,
      ownership: owner,
      config,
      before: { dsp: [1, g.sampleRate, g.vectorSize], frames: before },
      receipt: {
        fields,
        confirmedFields: fields,
        timing: armedTiming,
        confirmedTiming: armedTiming,
        elapsedMs: 20,
      },
    },
    launched: {
      scope: LISTENER_METRIC_SCOPE,
      ownership: owner,
      timing: launchTiming,
      clock: launch,
      elapsedMs: 100,
    },
    completion: {
      fields,
      confirmedFields: fields,
      timing: completionTiming,
      confirmedTiming: completionTiming,
      elapsedMs: 20,
    },
    after: { dsp: [1, g.sampleRate, g.vectorSize], frames: after },
    timingWitnesses: {
      minHostOffset: extreme(clocks, (r) => r[2] - r[4], false),
      maxHostOffset: extreme(clocks, (r) => r[2] - r[4], true),
      minBeatOrigin: extreme(playing, beatOrigin, false),
      maxBeatOrigin: extreme(playing, beatOrigin, true),
      maxPhaseDisagreement: extreme(playing, phase, true),
    },
    postElapsedMs: 100,
    ...createSyntheticMetricSpectrumEvidence({
      ownership: owner,
      clock: { dsp: [1, g.sampleRate, g.vectorSize], frames: before },
      firstAcquisitionEndpoint: origin - 8192,
      stopWatermark: after[0]![4],
    }),
  });
  observation.alignment = {
    ...assertNativeMetricSourceCoverage(proof, { ...owner, config }).alignment,
  };
  const firstCounter = proof.armed.before.frames[0]![4];
  const idleFields = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const idleTiming = [0, -1, 0, 0, -1, -1, -1, 3];
  const ready = nativeMetricReadyProofSchema.parse({
    scope: LISTENER_METRIC_SCOPE,
    phase: "idle-preflight",
    configurationEvidence: "admitted-not-executed",
    ownership,
    config,
    disarmCounter: firstCounter - 1,
    before: proof.armed.before,
    idle: {
      fields: idleFields,
      confirmedFields: idleFields,
      timing: idleTiming,
      confirmedTiming: idleTiming,
      configurationCounter: firstCounter + 1,
      confirmedConfigurationCounter: firstCounter + 2,
      timingCounter: firstCounter + 1,
      confirmedTimingCounter: firstCounter + 2,
      elapsedMs: 20,
    },
    elapsedMs: 40,
  });
  return {
    wire,
    config,
    proof,
    ready,
    observation: metricAudioObservationSchema.parse(observation),
    registration: {
      version: 5,
      connectionEpoch: ownership.connectionEpoch,
      capabilities: [LISTENER_CAPABILITY_METRIC],
      algorithmVersion: "3.0.0",
      sampleRate: g.sampleRate,
      vectorSize: g.vectorSize,
      deviceCanonicalPath: "live_set tracks 0 devices 0",
      trackCanonicalPath: "live_set tracks 0",
      nativeStatus: {
        version: 5,
        scope: LISTENER_METRIC_SCOPE,
        readiness: "READY",
        alignment: "approximate",
        verifiedAbsoluteErrorBoundSamples: null,
        acceptedSampleRates: [44_100, 48_000],
        acceptedVectorSizes: [64],
        supportedModes: ["arrangement", "session"],
        timingModes: ["descriptive", "strict"],
        maxClockDisagreementSamples: 480,
        maxAudioDurationMs: 30_000,
        maxReportRows: 2_000,
        executedGen: proof.armed,
      },
    },
  };
}

export type SyntheticMetricWireFixture = ReturnType<
  typeof createSyntheticMetricWireFixture
>;

/**
 * Test-only ownership rebinding, not readiness or physical source evidence.
 * Request/job IDs, sequence, mode and all admitted/native data are untouched;
 * callers explicitly construct their reply envelopes from the actual control.
 */
export function bindMetricFixtureToControl(
  fixture: SyntheticMetricWireFixture,
  actualWire5Control: ListenerControlMetric,
): SyntheticMetricWireFixture {
  const control = listenerControlMetricSchema.parse(actualWire5Control);
  const bound = structuredClone(fixture);
  const ownership = {
    listenerId: control.listenerId,
    passId: control.passId,
    connectionId: control.connectionId,
    connectionEpoch: control.connectionEpoch,
    generation: control.generation,
    traceId: control.traceId,
    correlationId: control.correlationId,
    causationId: control.causationId,
  };
  for (const owner of [
    bound.wire,
    bound.ready.ownership,
    bound.proof.armed.ownership,
    bound.proof.launched.ownership,
    ...(bound.proof.spectrumPhase ? [bound.proof.spectrumPhase.ownership] : []),
    bound.observation.ownership,
    bound.registration.nativeStatus.executedGen.ownership,
  ])
    Object.assign(owner, ownership);
  bound.registration.connectionEpoch = control.connectionEpoch;
  if (bound.proof.spectrumCleanup)
    bound.proof.spectrumCleanup.generation = control.generation;
  return bound;
}
