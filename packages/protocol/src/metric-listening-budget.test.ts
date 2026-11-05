import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import {
  admitMetricListeningBudget,
  MAX_METRIC_RESULT_FRAME_BYTES,
  type MetricListeningBudgetInput,
} from "./metric-listening-budget.js";
import { MAX_METRIC_OBSERVATION_BYTES } from "./audio-observation-limits.js";
import { createMetricListeningGeometry } from "./metric-listening-geometry.js";
import {
  createMetricObservationReportRows,
  deriveMetricAttackEvents,
  metricAudioObservationSchema,
  nativeMetricObservationMetricSchema as metricObservationMetricSchema,
} from "./metric-observation-schemas.js";
import {
  createSyntheticMetricListeningObservation,
  createSyntheticMetricSpectrumEvidence,
} from "./metric-testing.js";
import {
  assertNativeMetricSourceCoverage,
  nativeMetricListeningConfigSchema,
  nativeMetricSourceCoverageProofSchema,
} from "./native-metric-listening-schemas.js";
import { z } from "zod";

type Metric = z.infer<typeof metricObservationMetricSchema>;
type Clock = z.infer<
  typeof nativeMetricSourceCoverageProofSchema
>["launched"]["clock"];
const encoded = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;
const origin = 2 ** 44 - 4_000_000;
const escaped = "\u0000".repeat(240);
const longNumber = 0.0000010000000000000002;

/** Independent synthetic encoding, not DSP/readiness evidence or estimator data. */
function fixture(
  options: {
    rate?: 44_100 | 48_000;
    seconds?: number;
    tempo?: number;
    startBeat?: number;
    metrics?: Metric[];
    partial?: boolean;
    silence?: boolean;
    noFrame?: boolean;
    session?: boolean;
    adversarial?: boolean;
  } = {},
) {
  const rate = options.rate ?? 48_000;
  const tempo = options.tempo ?? 120;
  const startBeat = options.session ? 0 : (options.startBeat ?? 5.13);
  const endBeat = startBeat + ((options.seconds ?? 0.1) * tempo) / 60;
  const geometry = createMetricListeningGeometry({
    sampleRate: rate,
    vectorSize: 64,
    tempoBpm: tempo,
    startBeat,
    endBeat,
    startSample: origin,
  });
  const observation = createSyntheticMetricListeningObservation();
  observation.geometry = geometry;
  observation.sourceCoverage = {
    startSample: origin,
    endSample: geometry.endSample,
  };
  observation.requestedMetrics = options.metrics ?? [
    "level",
    "spectral-centroid",
    "attacks",
  ];
  observation.reduction.originalReportRows = geometry.rows.length;
  observation.reduction.retainedReportRows = geometry.rows.length;
  observation.source = {
    view: "arrangement",
    target: {
      kind: "master",
      index: null,
      expectedReference: observation.ownership.connectionId,
    },
    transport: { startBeat, endBeat },
  };
  if (options.adversarial) {
    for (const key of [
      "listenerId",
      "passId",
      "correlationId",
      "causationId",
    ] as const)
      observation.ownership[key] = "\u0001".repeat(128);
    observation.limitations = Array<string>(16).fill(escaped);
  }
  const { level, attacks } = observation.metrics;
  const spectrum = observation.metrics["spectral-centroid"];
  level.records = geometry.rows.map((row, index) => ({
    index,
    support: { startSample: row.startSample, endSample: row.endSample },
    peak: options.silence ? [0, 0] : [64, 64],
    rms: options.silence ? [0, 0] : [longNumber, longNumber],
  }));
  const firstFrameEnd = origin + (options.noFrame ? 2_048 : 1);
  spectrum.algorithm!.firstFrameEndSample = firstFrameEnd;
  spectrum.records = [];
  for (let end = firstFrameEnd; end <= geometry.endSample; end += 2_048)
    spectrum.records.push({
      index: spectrum.records.length,
      support: { startSample: end - 2_048, endSample: end },
      centroidHz: options.silence ? null : longNumber,
      spectralEnergy: options.silence ? 0 : longNumber,
    });
  const hop = rate / 10;
  attacks.algorithm!.windowSamples = hop;
  attacks.algorithm!.minSpacingSamples = hop;
  attacks.records = [];
  for (let start = origin; start < geometry.endSample; start += hop) {
    const rms = options.silence || attacks.records.length % 2 !== 0 ? 0 : 64;
    attacks.records.push({
      index: attacks.records.length,
      support: {
        startSample: start,
        endSample: Math.min(start + hop, geometry.endSample),
      },
      inputLevel: {
        peak: options.silence ? [0, 0] : [64, 64],
        rms: [rms, rms],
      },
      events: [],
    });
  }
  const detected = deriveMetricAttackEvents(
    attacks.records,
    attacks.algorithm!,
  );
  for (const record of attacks.records)
    record.events = detected.filter(
      (event) => event.sample === record.support.endSample,
    );
  for (const metric of metricObservationMetricSchema.options) {
    const data = observation.metrics[metric];
    data.expectedRecords = data.records.length;
    if (options.adversarial) data.limitations = Array<string>(8).fill(escaped);
    if (!observation.requestedMetrics.includes(metric)) {
      Object.assign(data, {
        status: "not-requested",
        expectedRecords: 0,
        algorithm: null,
        records: [],
        gaps: [],
        limitations: [],
      });
      continue;
    }
    if (options.partial && metric !== "level" && data.records.length > 0) {
      const missing = data.records.filter((_, index) =>
        metric === "attacks" ? index > 0 : index % 2 === 0,
      );
      for (let index = data.records.length - 1; index >= 0; index--)
        if (missing.includes(data.records[index]!))
          data.records.splice(index, 1);
      data.gaps = missing.map((row) => ({
        firstIndex: row.index,
        count: 1,
        ...row.support,
        reason: "dependency-unavailable",
        detail: "\u0002".repeat(160),
      }));
      if (missing.length > 0)
        data.status = data.records.length === 0 ? "failed" : "partial";
    }
  }
  observation.outcome = observation.requestedMetrics.every(
    (metric) => observation.metrics[metric]?.status === "complete",
  )
    ? "complete"
    : "partial";
  observation.rows = createMetricObservationReportRows(observation);
  if (options.session) {
    const target = {
      view: "session" as const,
      sceneIndex: 255,
      expectedClipReference: observation.ownership.connectionId,
      expectedClipName: options.adversarial
        ? escaped.slice(0, 128)
        : "synthetic-clip",
      track: {
        kind: "regular" as const,
        index: 255,
        expectedReference: observation.ownership.connectionId,
        expectedName: options.adversarial
          ? escaped.slice(0, 128)
          : "synthetic-track",
      },
    };
    observation.source = {
      view: "session",
      target,
      clipReference: target.expectedClipReference,
      kind: "warped-audio",
      coordinate: { unit: "beats", iteration: 0, startBeat: 0, endBeat },
      transport: { startBeat: 0, endBeat },
      clipStartTimeBeats: 0,
      synchronization: "transport-coupled-first-iteration",
    };
  }
  const config = nativeMetricListeningConfigSchema.parse({
    scope: "independent-metric-timelines/v1",
    algorithmVersion: "3.0.0",
    geometry: createMetricListeningGeometry({
      sampleRate: rate,
      vectorSize: 64,
      tempoBpm: tempo,
      startBeat,
      endBeat,
      startSample: 0,
    }),
    requestedMetrics: observation.requestedMetrics,
    timingPolicy: { mode: "descriptive", maxClockDisagreementSamples: 64 },
    grid: {
      beats: 0.25,
      anchor: "global-beat-grid",
      rounding: "nearest-sample",
      coordinates: "capture-local",
    },
    ...(observation.requestedMetrics.includes("attacks")
      ? { attacks: { thresholdDb: 6, minSpacingSamples: hop } }
      : {}),
    ...(observation.source.view === "session"
      ? {
          mode: "session",
          stoppedBeat: 0,
          sourceEvidence: "expected-context-only",
          source: {
            mode: "session",
            synchronization: "transport-coupled-first-iteration",
            target: observation.source.target,
          },
        }
      : { mode: "arrangement", sourceEvidence: "transport-only" }),
  });
  const ownership = observation.ownership;
  const arm = origin - 1_000;
  const clock = (counter: number, playing: boolean): Clock => {
    const beat = playing
      ? startBeat + ((counter - origin) * tempo) / (rate * 60)
      : startBeat;
    const sample = counter + 1_000_000_000_000_000;
    return [
      playing ? 1 : 0,
      beat,
      sample,
      31,
      counter,
      playing ? beat % 1 : longNumber,
      counter,
      playing ? 1 : 0,
      beat,
      sample,
      31,
    ];
  };
  const before = Array.from({ length: 32 }, (_, i) =>
    clock(arm - (32 - i) * 512, false),
  );
  const after = Array.from({ length: 32 }, (_, i) =>
    clock(geometry.endSample + 128 + i * 512, true),
  );
  const launch = clock(origin + 64, true);
  const fields = [
    ownership.nativeEpoch,
    geometry.totalSamples,
    hop,
    tempo,
    startBeat - Math.floor(startBeat),
    64,
    1,
    startBeat,
    endBeat,
    geometry.rows.length,
    ownership.nativeEpoch,
    ownership.nativeEpoch,
  ];
  const timing = [ownership.nativeEpoch, 1_064, 0, 0, 64, arm, origin, 3];
  const armedTiming = [ownership.nativeEpoch, -1, 0, 0, -1, arm, -1, 3];
  const clocks = [...before, ...after, launch];
  const playing = [...after, launch];
  const extreme = (
    rows: Clock[],
    value: (row: Clock) => number,
    max: boolean,
  ) =>
    rows.reduce((best, row) =>
      (max ? value(row) > value(best) : value(row) < value(best)) ? row : best,
    );
  const beatOrigin = (r: Clock) =>
    r[2] - Math.round(((r[1] - startBeat) * rate * 60) / tempo);
  const phase = (r: Clock) => {
    const difference = Math.abs(
      Math.round((r[5] * rate * 60) / tempo) -
        Math.round(((r[1] % 1) * rate * 60) / tempo),
    );
    return Math.min(
      difference,
      Math.abs(Math.round((rate * 60) / tempo) - difference),
    );
  };
  const proof = nativeMetricSourceCoverageProofSchema.parse({
    armed: {
      scope: config.scope,
      ownership,
      config,
      before: { dsp: [1, rate, 64], frames: before },
      receipt: {
        fields,
        confirmedFields: fields,
        timing: armedTiming,
        confirmedTiming: armedTiming,
        elapsedMs: longNumber,
      },
    },
    launched: {
      scope: config.scope,
      ownership,
      timing: timing.map((value, i) => (i === 3 ? 1 : value)),
      clock: launch,
      elapsedMs: longNumber,
    },
    completion: {
      fields,
      confirmedFields: fields,
      timing,
      confirmedTiming: timing,
      elapsedMs: longNumber,
    },
    after: { dsp: [1, rate, 64], frames: after },
    timingWitnesses: {
      minHostOffset: extreme(clocks, (r) => r[2] - r[4], false),
      maxHostOffset: extreme(clocks, (r) => r[2] - r[4], true),
      minBeatOrigin: extreme(playing, beatOrigin, false),
      maxBeatOrigin: extreme(playing, beatOrigin, true),
      maxPhaseDisagreement: extreme(playing, phase, true),
    },
    postElapsedMs: longNumber,
    ...createSyntheticMetricSpectrumEvidence({
      ownership,
      clock: { dsp: [1, rate, 64], frames: before },
      firstAcquisitionEndpoint: origin + (options.noFrame ? 0 : 1) - 8192,
      stopWatermark: after[0]![4],
    }),
  });
  observation.alignment = {
    ...assertNativeMetricSourceCoverage(proof, { ...ownership, config })
      .alignment,
  };
  const input: MetricListeningBudgetInput = {
    config,
    ownership,
    source: observation.source,
    jobId: options.adversarial ? "\u0004".repeat(128) : "job",
  };
  const wireOwner = Object.fromEntries(
    Object.entries(ownership).filter(([key]) => key !== "nativeEpoch"),
  );
  const frame = {
    ...wireOwner,
    protocolVersion: 1,
    listenerVersion: 5,
    mode: config.mode,
    requestId: options.adversarial ? "\u0003".repeat(128) : "request",
    jobId: input.jobId,
    sequence: Number.MAX_SAFE_INTEGER,
    type: "listener.result",
    status: observation.outcome === "complete" ? "completed" : "partial",
    observation,
    nativeSourceCoverage: proof,
    reason: "\u0005".repeat(512),
  };
  return { input, observation, proof, frame };
}

function assertBounded(value: ReturnType<typeof fixture>) {
  const decision = admitMetricListeningBudget(value.input);
  const outcome = value.observation.outcome;
  expect(encoded(value.observation)).toBeLessThanOrEqual(
    decision.upperBounds[outcome].observationBytes,
  );
  expect(encoded(value.frame)).toBeLessThanOrEqual(
    decision.upperBounds[outcome].frameBytes,
  );
  expect(encoded(value.proof)).toBeLessThanOrEqual(
    decision.operands.nativeSourceCoverageBytes,
  );
  expect(encoded(value.observation.geometry)).toBeLessThanOrEqual(
    decision.operands.geometryBytes,
  );
  expect(encoded(value.observation.rows)).toBeLessThanOrEqual(
    decision.operands.reportRowsBytes,
  );
  expect(encoded(value.observation.metrics)).toBeLessThanOrEqual(
    decision.operands.metricsBytes[outcome],
  );
  const parsed = metricAudioObservationSchema.safeParse(value.observation);
  if (encoded(value.observation) <= MAX_METRIC_OBSERVATION_BYTES)
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  else {
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.message)).toEqual([
      "Observation exceeds encoded payload quota",
    ]);
  }
  if (decision.admitted) {
    expect(encoded(value.observation)).toBeLessThanOrEqual(
      MAX_METRIC_OBSERVATION_BYTES,
    );
    expect(encoded(value.frame)).toBeLessThanOrEqual(
      MAX_METRIC_RESULT_FRAME_BYTES,
    );
  }
  return decision;
}

function fourBeatTextCounterexample() {
  const value = fixture({ seconds: 2, startBeat: 0 });
  value.observation.limitations = Array<string>(16).fill(escaped);
  for (const metric of metricObservationMetricSchema.options) {
    const data = value.observation.metrics[metric];
    const retained = metric === "level" ? 1 : 0;
    data.limitations = Array<string>(8).fill(escaped);
    data.gaps = data.records.slice(retained).map((record) => ({
      firstIndex: record.index,
      count: 1,
      ...record.support,
      reason: "unavailable",
      detail: "\u0000".repeat(160),
    }));
    data.records.splice(retained);
    data.status = retained === 0 ? "failed" : "partial";
  }
  value.observation.metrics.level.records[0]!.peak = [0.5, 0.5];
  value.observation.metrics.level.records[0]!.rms = [0.25, 0.25];
  value.observation.outcome = "partial";
  value.observation.rows = createMetricObservationReportRows(value.observation);
  value.frame.status = "partial";
  value.frame.sequence = 1;
  Reflect.deleteProperty(value.frame, "reason");
  return value;
}

async function actualMetricWireSchema(): Promise<z.ZodType> {
  const wireModule = "@ableton-agent/signal-routing";
  const peer: unknown = await import(wireModule);
  if (
    !peer ||
    typeof peer !== "object" ||
    !("listenerResultMetricSchema" in peer) ||
    !(peer.listenerResultMetricSchema instanceof z.ZodType)
  )
    throw new Error("Missing canonical metric wire contract");
  return peer.listenerResultMetricSchema;
}

function callTestCollector(
  receiver: unknown,
  methodName: string,
  args: unknown[],
): unknown {
  if (!receiver || typeof receiver !== "object")
    throw new Error("Missing actual metric collector");
  const method: unknown = Reflect.get(receiver, methodName);
  if (typeof method !== "function")
    throw new Error(`Missing actual metric collector method:${methodName}`);
  const result: unknown = Reflect.apply(method, receiver, args);
  return result;
}

describe("pre-playback independent metric encoded-result admission", () => {
  it.each([44_100, 48_000] as const)(
    "admits eight-bar and thirty-second complete/partial capture bounds at%sHz",
    (rate) => {
      expect(MAX_METRIC_RESULT_FRAME_BYTES).toBe(2 * 1_024 * 1_024);
      for (const seconds of [15, 30])
        for (const tempo of [120, 128, 240])
          for (const partial of [false, true]) {
            const value = fixture({
              rate,
              seconds,
              tempo,
              partial,
              session: true,
              adversarial: true,
            });
            const decision = admitMetricListeningBudget(value.input);
            expect(decision.admitted).toBe(true);
            expect(
              metricAudioObservationSchema.safeParse(value.observation).success,
            ).toBe(true);
            expect(value.observation.rows).toHaveLength(
              value.observation.geometry.rows.length,
            );
          }
    },
  );

  it.each([false, true])(
    "counts sourceContext in armed config separately from observation source (Session=%s)",
    async (session) => {
      const wire = await actualMetricWireSchema();
      for (const rate of [44_100, 48_000] as const)
        for (const partial of [false, true]) {
          const value = fixture({
            rate,
            session,
            partial,
            adversarial: true,
            seconds: 0.125,
          });
          const withoutContext = assertBounded(value);
          const previousProofBytes = encoded(value.proof);
          const previousFrameBytes = encoded(value.frame);
          const addedBytes = encoded({ sourceContext: value.input.source }) - 1;
          value.input.config = nativeMetricListeningConfigSchema.parse({
            ...value.input.config,
            sourceContext: value.input.source,
          });
          value.proof.armed.config = value.input.config;
          const withContext = assertBounded(value);
          expect(wire.safeParse(value.frame).success).toBe(true);
          expect(withContext.snapshot.config.sourceContext).toEqual(
            withContext.snapshot.source,
          );
          expect(
            Object.isFrozen(withContext.snapshot.config.sourceContext),
          ).toBe(true);
          expect(
            withContext.operands.nativeSourceCoverageBytes -
              withoutContext.operands.nativeSourceCoverageBytes,
          ).toBe(addedBytes);
          expect(encoded(value.proof) - previousProofBytes).toBe(addedBytes);
          expect(encoded(value.frame) - previousFrameBytes).toBe(addedBytes);
          for (const outcome of ["complete", "partial"] as const) {
            expect(withContext.upperBounds[outcome].observationBytes).toBe(
              withoutContext.upperBounds[outcome].observationBytes,
            );
            expect(
              withContext.upperBounds[outcome].frameBytes -
                withoutContext.upperBounds[outcome].frameBytes,
            ).toBe(addedBytes);
          }
          expect(withoutContext.snapshot.config.sourceContext).toBeUndefined();
        }
    },
  );

  it("rejects a standalone source smaller than the sourceContext pinned by the native proof", () => {
    const value = fixture({ session: true });
    const source = value.input.source;
    if (source.view !== "session")
      throw new Error("Expected synthetic Session source");
    const config = nativeMetricListeningConfigSchema.parse({
      ...value.input.config,
      sourceContext: source,
    });
    const smallerSource = { ...source, kind: "midi" as const };
    expect(encoded(smallerSource)).toBeLessThan(encoded(source));
    expect(() =>
      admitMetricListeningBudget({
        ...value.input,
        config,
        source: smallerSource,
      }),
    ).toThrow("metric_budget_source_context_mismatch");
  });

  it("realizes a valid four-beat partial observation over ingress using permitted text and adjacent gaps", async () => {
    const value = fourBeatTextCounterexample();
    const observationBytes = encoded(value.observation);
    const frameBytes = encoded(value.frame);
    const textContentBytes = [
      ...value.observation.limitations,
      ...metricObservationMetricSchema.options.flatMap((metric) => [
        ...value.observation.metrics[metric].limitations,
        ...value.observation.metrics[metric].gaps.map((gap) => gap.detail),
      ]),
    ].reduce((sum, text) => sum + encoded(text) - 2, 0);
    expect({ observationBytes, frameBytes, textContentBytes }).toEqual({
      observationBytes: 153_346,
      frameBytes: 170_217,
      textContentBytes: 136_320,
    });
    expect(textContentBytes).toBeGreaterThan(128 * 1_024);
    expect(value.input.ownership).toEqual(
      createSyntheticMetricListeningObservation().ownership,
    );
    expect(value.input.config.geometry).toMatchObject({
      sampleRate: 48_000,
      tempoBpm: 120,
      startBeat: 0,
      endBeat: 4,
      totalSamples: 96_000,
    });
    expect(value.observation.metrics.level.records).toHaveLength(1);
    expect(
      metricObservationMetricSchema.options.map(
        (metric) => value.observation.metrics[metric].gaps.length,
      ),
    ).toEqual([15, 47, 20]);
    for (const metric of metricObservationMetricSchema.options) {
      const data = value.observation.metrics[metric];
      expect(
        data.records.length +
          data.gaps.reduce((sum, gap) => sum + gap.count, 0),
      ).toBe(data.expectedRecords);
    }
    expect(
      metricAudioObservationSchema.safeParse(value.observation).success,
    ).toBe(true);
    expect(observationBytes).toBeGreaterThan(128 * 1_024);
    expect(observationBytes).toBeLessThan(MAX_METRIC_OBSERVATION_BYTES);
    expect(frameBytes).toBeGreaterThan(128 * 1_024);
    const wire = await actualMetricWireSchema();
    const parsed = wire.safeParse(value.frame);
    expect(parsed.success).toBe(true);
    expect(assertBounded(value).admitted).toBe(true);
  });

  it("the actual collector fits identical four-beat numeric timelines with fixed text and coalesced gaps", async () => {
    const value = fourBeatTextCounterexample();
    const module: unknown = createRequire(import.meta.url)(
      "../../../max-patches/audio-listener/audio_listener_metric_timelines.js",
    );
    const ownership = value.input.ownership;
    const owner = {
      generation: ownership.generation,
      nativeEpoch: ownership.nativeEpoch,
      arm: "synthetic-arm",
    };
    const g = value.observation.geometry;
    let time = 0;
    const collector = callTestCollector(module, "createMetricTimelines", [
      {
        owner,
        originSample: g.startSample,
        originBeat: g.startBeat,
        sampleRate: g.sampleRate,
        vectorSize: g.vectorSize,
        tempo: g.tempoBpm,
        startBeat: g.startBeat,
        endBeat: g.endBeat,
        captureStartSample: g.startSample,
        captureEndSample: g.endSample,
        requestedMetrics: ["level", "spectrum", "attacks"],
        attacks: value.input.config.attacks,
        spectrum: {
          supportSamples: 2_048,
          hopSamples: 2_048,
          firstEndSample:
            value.observation.metrics["spectral-centroid"].algorithm!
              .firstFrameEndSample,
        },
        traceId: ownership.traceId,
        correlationId: ownership.correlationId,
        causationId: ownership.causationId,
      },
      { now: () => time++ },
    ]);
    const record = value.observation.metrics.level.records[0]!;
    expect(
      callTestCollector(collector, "ingestLevel", [
        {
          owner,
          sequence: 1,
          ...record.support,
          count: record.support.endSample - record.support.startSample,
          peak: record.peak,
          rms: record.rms,
        },
      ]),
    ).toMatchObject({ accepted: true });
    const result = callTestCollector(collector, "finalize", [
      { owner, sourceEndSample: g.endSample },
    ]);
    const nativeObservation = metricAudioObservationSchema.parse(
      callTestCollector(module, "adaptMetricTimelineObservation", [
        result,
        {
          collectorOwner: owner,
          ownership,
          source: value.observation.source,
          sharedIntegrity: "validated",
          sourceCoverage: value.observation.sourceCoverage,
          alignment: value.observation.alignment,
        },
        {
          schemaVersion: "metric-audio-observation/v1",
          parse: (candidate: unknown) =>
            metricAudioObservationSchema.parse(candidate),
          createReportRows: createMetricObservationReportRows,
          now: () => time++,
        },
      ]),
    );
    for (const metric of metricObservationMetricSchema.options) {
      const actual = nativeObservation.metrics[metric];
      const unrestricted = value.observation.metrics[metric];
      expect(actual.records).toEqual(unrestricted.records);
      expect(actual.gaps).toHaveLength(1);
      expect(actual.gaps[0]!.count).toBe(unrestricted.gaps.length);
    }
    expect(nativeObservation.rows).toEqual(value.observation.rows);
    expect(nativeObservation.geometry).toEqual(value.observation.geometry);
    expect(nativeObservation.reduction.mode).toBe("none");
    const frame = { ...value.frame, observation: nativeObservation };
    expect({
      observationBytes: encoded(nativeObservation),
      frameBytes: encoded(frame),
    }).toEqual({ observationBytes: 8_463, frameBytes: 25_334 });
    const wire = await actualMetricWireSchema();
    expect(wire.safeParse(frame).success).toBe(true);
    expect(encoded(frame)).toBeLessThan(MAX_METRIC_RESULT_FRAME_BYTES);
  });

  it("matches the actual metric wire ceiling without enlarging the generic ingress default", async () => {
    // Test-only peer validation without a protocol -> signal-routing compile
    // dependency. Production admission imports only canonical protocol schemas.
    const wire = await actualMetricWireSchema();
    const capModule = "@ableton-agent/signal-routing";
    const caps: unknown = await import(capModule);
    if (
      !caps ||
      typeof caps !== "object" ||
      !("DEFAULT_MAX_INGRESS_FRAME_BYTES" in caps)
    )
      throw new Error("Missing canonical metric wire contract");
    expect(caps.DEFAULT_MAX_INGRESS_FRAME_BYTES).toBe(128 * 1_024);
    expect(MAX_METRIC_RESULT_FRAME_BYTES).toBe(2 * 1_024 * 1_024);
    for (const session of [false, true])
      for (const partial of [false, true]) {
        const value = fixture({ session, partial, adversarial: true });
        expect(wire.safeParse(value.frame).success).toBe(true);
        assertBounded(value);
      }
    const overIngress = fixture({ seconds: 30, tempo: 20 });
    expect(wire.safeParse(overIngress.frame).success).toBe(true);
    expect(assertBounded(overIngress).admitted).toBe(true);
  });

  it.each([44_100, 48_000] as const)(
    "bounds independent complete/partial timelines, escaping and fractions at%sHz",
    (rate) => {
      for (const partial of [false, true])
        for (const seconds of [0.125, 0.751, 2.9])
          for (const session of [false, true])
            assertBounded(
              fixture({
                rate,
                seconds,
                tempo: Number("137.12345678901234"),
                startBeat: 1_000_000.13,
                partial,
                session,
                adversarial: true,
              }),
            );
    },
  );

  it.each([44_100, 48_000] as const)(
    "admits useful complete and possible partial results at%sHz",
    (rate) => {
      const full = fixture({ rate, seconds: 0.125, adversarial: true });
      const partial = fixture({
        rate,
        seconds: 0.125,
        partial: true,
        adversarial: true,
      });
      expect(assertBounded(full).admitted).toBe(true);
      expect(assertBounded(partial).admitted).toBe(true);
      expect(partial.observation.outcome).toBe("partial");
      expect(partial.observation.metrics.attacks.records).toHaveLength(1);
      expect(
        partial.observation.metrics["spectral-centroid"].gaps.length,
      ).toBeGreaterThan(1);
    },
  );

  it.each([44_100, 48_000] as const)(
    "bounds measured silence and one-sample no-frame results at%sHz",
    (rate) => {
      const silence = fixture({ rate, seconds: 0.125, silence: true });
      expect(assertBounded(silence).admitted).toBe(true);
      expect(
        silence.observation.metrics.attacks.records.flatMap((r) => r.events),
      ).toEqual([]);
      expect(
        silence.observation.metrics["spectral-centroid"].records[0],
      ).toMatchObject({
        centroidHz: null,
        spectralEnergy: 0,
      });
      const noFrame = fixture({ rate, seconds: 1 / rate, noFrame: true });
      expect(assertBounded(noFrame).admitted).toBe(true);
      expect(noFrame.observation.geometry.totalSamples).toBe(1);
      expect(noFrame.observation.metrics["spectral-centroid"].records).toEqual(
        [],
      );
      expect(
        noFrame.observation.rows[0]!["spectral-centroid"].availability,
      ).toBe("no-frame");
    },
  );

  it("uses only requested acquisitions; independent detector input doesn't require musical level", () => {
    const combinations: Metric[][] = [
      ["level"],
      ["spectral-centroid"],
      ["attacks"],
      ["level", "spectral-centroid"],
      ["level", "attacks"],
      ["spectral-centroid", "attacks"],
      ["level", "spectral-centroid", "attacks"],
    ];
    for (const metrics of combinations) {
      const decision = assertBounded(fixture({ metrics }));
      for (const metric of metricObservationMetricSchema.options)
        expect(decision.operands.expectedRecords[metric] > 0).toBe(
          metrics.includes(metric),
        );
    }
  });

  it("bounds each fully failed metric with maximal per-slot gaps while another metric remains useful", () => {
    for (const metric of metricObservationMetricSchema.options) {
      const value = fixture({ seconds: 0.751, adversarial: true });
      const data = value.observation.metrics[metric];
      data.gaps = data.records.map((record) => ({
        firstIndex: record.index,
        count: 1,
        ...record.support,
        reason: "overflow",
        detail: "\u0000".repeat(160),
      }));
      data.records = [];
      data.status = "failed";
      value.observation.outcome = "partial";
      value.frame.status = "partial";
      value.observation.rows = createMetricObservationReportRows(
        value.observation,
      );
      assertBounded(value);
    }
  });

  it.each([44_100, 48_000] as const)(
    "does not pretend30s/fast tempos fit at%sHz or reduce authoritative data",
    (rate) => {
      for (const partial of [false, true])
        for (const tempo of [20, 120, 999]) {
          const value = fixture({ rate, seconds: 30, tempo, partial });
          const decision = assertBounded(value);
          expect(decision.admitted).toBe(tempo !== 999);
          expect(value.observation.reduction.mode).toBe("none");
          expect(value.observation.rows.length).toBe(
            value.observation.geometry.rows.length,
          );
          expect(decision.operands.expectedRecords.attacks).toBe(300);
          expect(decision.operands.expectedRecords["spectral-centroid"]).toBe(
            Math.ceil((30 * rate) / 2_048),
          );
        }
    },
  );

  it("admits a genuinely bounded30s level-only range at low tempo", () => {
    const value = fixture({ seconds: 30, tempo: 20, metrics: ["level"] });
    expect(assertBounded(value).admitted).toBe(true);
  });

  it("denies on the possible partial bound even when the complete bound fits", () => {
    const value = fixture({ seconds: 30, tempo: 999 });
    const decision = assertBounded(value);
    expect(decision.upperBounds.complete.frameBytes).toBeLessThan(
      MAX_METRIC_RESULT_FRAME_BYTES,
    );
    expect(decision.upperBounds.partial.frameBytes).toBeGreaterThan(
      MAX_METRIC_RESULT_FRAME_BYTES,
    );
    expect(decision.admitted).toBe(false);
    if (decision.admitted) throw new Error("expected typed denial");
    expect(decision.reason).toBe("metric_result_budget_exceeded");
    expect(decision.violations).toContainEqual({
      outcome: "partial",
      boundary: "frame",
      upperBoundBytes: decision.upperBounds.partial.frameBytes,
      byteLimit: MAX_METRIC_RESULT_FRAME_BYTES,
      excessBytes:
        decision.upperBounds.partial.frameBytes - MAX_METRIC_RESULT_FRAME_BYTES,
    });
  });

  it("exposes both quotas and all independently derived operands on denial", () => {
    const decision = assertBounded(
      fixture({ seconds: 30, tempo: 999, adversarial: true }),
    );
    expect(decision.limits).toEqual({
      observationBytes: MAX_METRIC_OBSERVATION_BYTES,
      frameBytes: MAX_METRIC_RESULT_FRAME_BYTES,
    });
    expect(decision.admitted).toBe(false);
    if (decision.admitted) throw new Error("expected typed denial");
    for (const outcome of ["partial"])
      for (const boundary of ["observation", "frame"])
        expect(decision.violations).toContainEqual(
          expect.objectContaining({ outcome, boundary }),
        );
    expect(decision.operands.nativeSourceCoverageBytes).toBeGreaterThan(10_000);
    expect(decision.operands.reportRowsBytes).toBeGreaterThan(300_000);
  });

  it("admits a thirty-second result formerly denied by its proof-bearing frame", () => {
    const value = fixture({ seconds: 30, tempo: 20 });
    const decision = assertBounded(value);
    expect(
      metricAudioObservationSchema.safeParse(value.observation).success,
    ).toBe(true);
    expect(encoded(value.observation)).toBeLessThan(
      MAX_METRIC_OBSERVATION_BYTES,
    );
    expect(encoded(value.frame)).toBeGreaterThan(128 * 1_024);
    expect(decision.admitted).toBe(true);
  });

  it("counts a maximal regenerated terminal requestId, not a short prepare requestId", () => {
    const value = fixture();
    const decision = assertBounded(value);
    value.frame.requestId = "\u0000".repeat(128);
    expect(assertBounded(value)).toEqual(decision);
    const header = Object.fromEntries(
      Object.entries(value.frame).filter(
        ([key]) =>
          !["status", "observation", "nativeSourceCoverage", "reason"].includes(
            key,
          ),
      ),
    );
    expect(encoded(header)).toBe(decision.operands.wireHeaderBytes);
  });

  it.each(["雪", "😀", "\ud800", '"\\', "\u0000"])(
    "accounts for UTF8 and JSON escaping in immutable source/owner text %j",
    (text) => {
      const value = fixture({ session: true });
      value.input.ownership.listenerId = text.repeat(30);
      value.observation.ownership.listenerId = value.input.ownership.listenerId;
      value.proof.armed.ownership.listenerId = value.input.ownership.listenerId;
      value.proof.launched.ownership.listenerId =
        value.input.ownership.listenerId;
      Object.assign(value.frame, {
        listenerId: value.input.ownership.listenerId,
      });
      if (
        value.input.source.view !== "session" ||
        value.input.config.mode !== "session"
      )
        throw new Error("expected synthetic Session context");
      value.input.source.target.expectedClipName = text.repeat(30);
      value.input.config.source.target.expectedClipName = text.repeat(30);
      value.proof.armed.config = value.input.config;
      expect(assertBounded(value).admitted).toBe(true);
    },
  );

  it("retains conservative full-row bounds when the stored result selects fewer rows", () => {
    const value = fixture({ seconds: 0.125, partial: true });
    const before = admitMetricListeningBudget(value.input);
    value.observation.rows = [];
    value.observation.reduction.mode = "selected-report-rows";
    value.observation.reduction.retainedReportRows = 0;
    expect(assertBounded(value)).toEqual(before);
  });

  it("clones and deeply freezes admission operands without freezing caller objects", () => {
    const { input } = fixture({ session: true });
    const original = JSON.stringify(input);
    const decision = admitMetricListeningBudget(input);
    expect(JSON.stringify(input)).toBe(original);
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(decision.snapshot.config.geometry.rows[0])).toBe(
      true,
    );
    expect(Object.isFrozen(decision.operands.expectedRecords)).toBe(true);
    expect(Object.isFrozen(decision.upperBounds.partial)).toBe(true);
    input.ownership.listenerId = "changed";
    expect(decision.snapshot.ownership.listenerId).not.toBe("changed");
    expect(
      Reflect.set(decision.snapshot.config.geometry.rows[0]!, "endSample", 1),
    ).toBe(false);
  });

  it("rejects malformed configuration, identity, source and unknown input fields explicitly", () => {
    const input = fixture().input;
    expect(() => admitMetricListeningBudget({ ...input, jobId: "" })).toThrow();
    expect(() =>
      admitMetricListeningBudget({
        ...input,
        ownership: { ...input.ownership, generation: "old-numeric-generation" },
      }),
    ).toThrow();
    expect(() =>
      admitMetricListeningBudget({
        ...input,
        config: {
          ...input.config,
          geometry: { ...input.config.geometry, totalSamples: 1 },
        },
      }),
    ).toThrow();
    expect(() => {
      Reflect.apply(admitMetricListeningBudget, undefined, [
        { ...input, source: { ...input.source, view: "invalid" } },
      ]);
    }).toThrow();
    const extended = { ...input, byteLimit: Infinity };
    expect(() => admitMetricListeningBudget(extended)).toThrow();
    expect(() =>
      admitMetricListeningBudget({
        ...input,
        source: fixture({ session: true }).input.source,
      }),
    ).toThrow("metric_budget_source_mode_mismatch");
  });
});
