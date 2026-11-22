import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  createContinuousMetricListeningGeometry,
  METRIC_CONTINUOUS_LISTENING_CAPABILITY,
} from "./metric-continuous-geometry.js";
import {
  acceptMetricRecordChunk,
  canonicalMetricRecordJson,
  compactMetricRecordStreamDescriptor,
  expandMetricRecordStreamAdmission,
  metricRecordStreamAdmissionSchema,
  createMetricRecordStreamState,
  encodeMetricRecordChunk,
  metricRecordChunkDigest,
  metricRecordChunkSchema,
  metricRecordDigest,
  metricRecordStreamDescriptorSchema,
  metricRecordStreamExpectedCoverage,
  metricRecordStreamCapturedTrailingSupport,
  metricRecordStreamLifecycleSchema,
  metricRecordStreamManifestSchema,
  metricRecordStreamTerminalProofSchema,
  parseMetricRecordChunkWire,
  verifyMetricRecordStreamManifest,
  METRIC_RECORD_STREAM_CAPABILITY,
  type MetricRecordChunk,
  type MetricRecordStreamDescriptor,
  type MetricRecordStreamManifest,
  type MetricRecordStreamMetric,
  type MetricRecordStreamState,
} from "./metric-record-stream.js";
import {
  createSyntheticMetricListeningObservation,
  createSyntheticMetricSpectrumEvidence,
} from "./metric-testing.js";
import { MEL_BAND_PROFILE } from "./mel-band-profile.js";
import { PITCH_PROFILE, SPECTRAL_SHAPE_PROFILE } from "./analyzer-profile.js";
import type { NativeMetricLaunchProof } from "./native-metric-listening-schemas.js";
import { nativeCheckedTransportClockBindingSchema } from "./native-listening-v2-schemas.js";
import { summarizeMetricListeningStreamManifest } from "./metric-listening-job-schemas.js";
import { metricObservationSourceSchema } from "./metric-observation-schemas.js";
import {
  createSyntheticMetricRecordStreamFixture,
  createSyntheticMetricRecordStreamTerminalProof,
} from "./metric-stream-testing.js";

function descriptor(seconds = 0.5): MetricRecordStreamDescriptor {
  const observation = createSyntheticMetricListeningObservation();
  const geometry = createContinuousMetricListeningGeometry({
    captureMode: "finite-metric-stream",
    sampleRate: 48_000,
    vectorSize: 64,
    startBeat: 0,
    endBeat: seconds * 2,
    tempoBpm: 120,
    startSample: 10_000,
  });
  return metricRecordStreamDescriptorSchema.parse({
    schema: "metric-record-stream/v1",
    capability: METRIC_CONTINUOUS_LISTENING_CAPABILITY,
    ownership: observation.ownership,
    source: {
      ...observation.source,
      transport: { startBeat: 0, endBeat: seconds * 2 },
    },
    geometry,
    timingPolicy: { mode: "descriptive", maxClockDisagreementSamples: 64 },
    requestedMetrics: [
      "level",
      "spectral-centroid",
      "attacks",
      "mel-bands",
      "pitch",
      "spectral-shape",
    ],
    algorithms: [
      { metric: "level", algorithm: observation.metrics.level.algorithm },
      {
        metric: "spectral-centroid",
        algorithm: observation.metrics["spectral-centroid"].algorithm,
      },
      { metric: "attacks", algorithm: observation.metrics.attacks.algorithm },
      { metric: "mel-bands", algorithm: MEL_BAND_PROFILE },
      { metric: "pitch", algorithm: PITCH_PROFILE },
      { metric: "spectral-shape", algorithm: SPECTRAL_SHAPE_PROFILE },
    ].map((item) => ({
      ...item,
      availability: "available",
      unavailableReason: null,
    })),
    maxPendingChunks: 8,
  });
}

function sessionSource(
  transport: { startBeat: number; endBeat: number },
  kind: "midi" | "warped-audio" = "midi",
) {
  const reference = "00000000-0000-4000-8000-000000000001";
  return metricObservationSourceSchema.options[1].parse({
    view: "session",
    target: {
      view: "session",
      track: {
        kind: "regular",
        index: 0,
        expectedReference: reference,
        expectedName: "Track",
      },
      sceneIndex: 0,
      expectedClipReference: reference,
      expectedClipName: "Clip",
    },
    clipReference: reference,
    kind,
    coordinate: {
      unit: "beats",
      iteration: 0,
      startBeat: 0,
      endBeat: transport.endBeat - transport.startBeat,
    },
    transport,
    clipStartTimeBeats: transport.startBeat,
    synchronization: "transport-coupled-first-iteration",
  });
}

describe("consolidated source admission", () => {
  it.each(["midi", "warped-audio"] as const)(
    "preserves global 16..96 native proof and explicit clip-local 0..80 mapping for %s",
    (kind) => {
      const base = descriptor(37.5);
      const transport = { startBeat: 16, endBeat: 96 };
      const geometry = createContinuousMetricListeningGeometry({
        captureMode: "finite-metric-stream",
        sampleRate: 48_000,
        vectorSize: 64,
        tempoBpm: 128,
        ...transport,
        startSample: 100_000,
      });
      const nativeDescriptor = metricRecordStreamDescriptorSchema.parse({
        ...base,
        geometry,
        source: { ...base.source, transport },
        algorithms: base.algorithms.map((item) =>
          item.metric === "spectral-centroid" && item.algorithm !== null
            ? {
                ...item,
                algorithm: {
                  ...item.algorithm,
                  firstFrameEndSample: geometry.startSample + 2048,
                },
              }
            : item,
        ),
      });
      const nativeProof =
        createSyntheticMetricRecordStreamTerminalProof(nativeDescriptor);
      expect(nativeProof.configuration.slice(7, 9)).toEqual([16, 96]);
      expect(nativeProof.before.frames.every((clock) => clock[1] === 16)).toBe(
        true,
      );
      expect(nativeProof.sourceOrigin).toBe(100_000);
      expect(nativeProof.sourceEnd).toBe(1_900_000);
      const source = sessionSource(transport, kind);
      const session = metricRecordStreamDescriptorSchema.parse({
        ...nativeDescriptor,
        source,
      });
      expect(session.source).toEqual(source);
      expect(source.coordinate).toEqual({
        unit: "beats",
        iteration: 0,
        startBeat: 0,
        endBeat: 80,
      });
      expect(source.clipStartTimeBeats).toBe(16);
      expect(source.synchronization).toBe("transport-coupled-first-iteration");
      expect(createSyntheticMetricRecordStreamTerminalProof(session)).toEqual(
        nativeProof,
      );
      const toClipBeat = (sample: number) =>
        session.geometry.startBeat +
        ((sample - session.geometry.startSample) * 128) / (48_000 * 60) -
        source.clipStartTimeBeats;
      expect(toClipBeat(nativeProof.sourceOrigin)).toBe(0);
      expect(toClipBeat(nativeProof.sourceEnd)).toBe(80);
      expect(
        expandMetricRecordStreamAdmission(
          compactMetricRecordStreamDescriptor(session),
        ),
      ).toEqual(session);
    },
  );

  it.each([1.875, 37.5])(
    "admits a Session source into the same %ss canonical descriptor without changing profiles",
    (seconds) => {
      const arrangement = descriptor(seconds);
      const source = sessionSource(arrangement.source.transport);
      const session = metricRecordStreamDescriptorSchema.parse({
        ...arrangement,
        source,
      });
      expect(session.source).toEqual(source);
      expect(session.algorithms).toEqual(arrangement.algorithms);
      expect(session.geometry).toEqual(arrangement.geometry);
      expect(session.requestedMetrics).toEqual(arrangement.requestedMetrics);
      expect(
        expandMetricRecordStreamAdmission(
          compactMetricRecordStreamDescriptor(session),
        ),
      ).toEqual(session);
      expect(
        metricRecordStreamDescriptorSchema.safeParse({
          ...session,
          source: {
            ...source,
            transport: {
              ...source.transport,
              endBeat: source.transport.endBeat + 1,
            },
          },
        }).success,
      ).toBe(false);
    },
  );
});

function records(
  d: MetricRecordStreamDescriptor,
  metric: MetricRecordStreamMetric,
  from = 0,
  to?: number,
): unknown[] {
  const g = d.geometry;
  const expected = metricRecordStreamExpectedCoverage(
    d,
    metric,
  ).expectedRecords;
  return Array.from({ length: (to ?? expected) - from }, (_, offset) => {
    const index = from + offset;
    const row = g.rows[index];
    const hop = metric === "attacks" ? Math.round(g.sampleRate / 10) : 2048;
    const support =
      metric === "level"
        ? { startSample: row!.startSample, endSample: row!.endSample }
        : {
            startSample: g.startSample + index * hop,
            endSample: Math.min(g.startSample + (index + 1) * hop, g.endSample),
          };
    const base = { index, support };
    if (metric === "level") return { ...base, peak: [0, 0], rms: [0, 0] };
    if (metric === "spectral-centroid")
      return { ...base, spectralEnergy: 0, centroidHz: null };
    if (metric === "attacks")
      return { ...base, inputLevel: { peak: [0, 0], rms: [0, 0] }, events: [] };
    if (metric === "mel-bands")
      return {
        ...base,
        magnitudes: [Array(24).fill(0.123), Array(24).fill(0.456)],
      };
    if (metric === "pitch")
      return {
        ...base,
        channels: [
          { state: "silence", hz: null, confidence: null },
          { state: "silence", hz: null, confidence: null },
        ],
      };
    return {
      ...base,
      channels: Array.from({ length: 2 }, () => ({
        state: "silence",
        flatnessDb: null,
        spreadHz: null,
        rolloffHz: null,
      })),
    };
  });
}

async function chunk(
  d: MetricRecordStreamDescriptor,
  state: MetricRecordStreamState,
  metric: MetricRecordStreamMetric,
  values: unknown[],
  gaps: unknown[] = [],
): Promise<MetricRecordChunk> {
  const prefix = state.metrics.find((item) => item.metric === metric)!;
  const value = metricRecordChunkSchema.parse({
    schema: "metric-record-chunk/v1",
    descriptorDigest: state.descriptorDigest,
    ownership: d.ownership,
    metric,
    chunkSequence: prefix.nextChunkSequence,
    recordOffset: prefix.nextRecordOffset,
    slotOffset: prefix.nextIndex,
    previousDigest: prefix.lastDigest,
    digest: "0".repeat(64),
    records: values,
    gaps,
  });
  return { ...value, digest: await metricRecordChunkDigest(value) };
}

function proof(
  d: MetricRecordStreamDescriptor,
  status: "completed" | "failed" | "cancelled" = "completed",
  capturedSamples = d.geometry.totalSamples,
) {
  const g = d.geometry;
  const origin = g.startSample;
  const arm = origin - 1000;
  const end = origin + capturedSamples;
  type Row = NativeMetricLaunchProof["clock"];
  const row = (
    counter: number,
    playing: boolean,
    stoppedBeat = g.startBeat,
  ): Row => {
    const beat = playing
      ? g.startBeat + (counter - origin) / 24000
      : stoppedBeat;
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
    frames: Array.from({ length: 32 }, (_, i) => row(end + 64 + i * 64, true)),
  };
  const clock = {
    dsp: [1, g.sampleRate, g.vectorSize],
    frames: Array.from({ length: 32 }, (_, i) =>
      row(end + 4096 + i * 64, true),
    ),
  };
  const launchClock = row(origin + 64, true);
  const timing = [d.ownership.nativeEpoch, 1064, 0, 0, 64, arm, origin, 3];
  const configuration = [
    d.ownership.nativeEpoch,
    g.totalSamples,
    4800,
    g.tempoBpm,
    g.startBeat % 1,
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
    r[2] - Math.round((r[1] - g.startBeat) * 24000);
  const phase = (r: Row) => {
    const difference = Math.abs(
      Math.round(r[5] * 24000) - Math.round((r[1] % 1) * 24000),
    );
    return Math.min(difference, Math.abs(24000 - difference));
  };
  const spectrum = createSyntheticMetricSpectrumEvidence({
    ownership: d.ownership,
    clock: before as Parameters<
      typeof createSyntheticMetricSpectrumEvidence
    >[0]["clock"],
    firstAcquisitionEndpoint: origin - 4096,
    stopWatermark: end,
  });
  return metricRecordStreamTerminalProofSchema.parse({
    schema: "metric-record-stream-terminal/v1",
    ownership: d.ownership,
    status,
    launch: {
      scope: "independent-metric-timelines/v1",
      ownership: d.ownership,
      timing: [d.ownership.nativeEpoch, 1064, 0, 1, 64, arm, origin, 3],
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

function manifest(
  d: MetricRecordStreamDescriptor,
  state: MetricRecordStreamState,
  outcome: MetricRecordStreamManifest["outcome"] = "complete",
  native = proof(d),
) {
  return metricRecordStreamManifestSchema.parse({
    schema: "metric-record-stream-manifest/v1",
    descriptorDigest: state.descriptorDigest,
    ownership: d.ownership,
    outcome,
    algorithms: d.algorithms,
    metrics: state.metrics.map((prefix) => {
      const algorithm = d.algorithms.find(
        (item) => item.metric === prefix.metric,
      )!;
      return {
        ...prefix,
        ...metricRecordStreamExpectedCoverage(d, prefix.metric),
        trailingSupport: metricRecordStreamCapturedTrailingSupport(
          d,
          prefix.metric,
          native.sourceEnd,
        ),
        availability: algorithm.availability,
        status:
          algorithm.availability === "unavailable"
            ? "failed"
            : prefix.missingRecords === 0
              ? "complete"
              : prefix.nextRecordOffset === 0
                ? "failed"
                : "partial",
      };
    }),
    nativeProof: native,
    limitations: [],
  });
}

async function complete(d: MetricRecordStreamDescriptor) {
  let state = await createMetricRecordStreamState(d);
  for (const metric of d.requestedMetrics) {
    const expected = metricRecordStreamExpectedCoverage(
      d,
      metric,
    ).expectedRecords;
    for (let from = 0; from < expected; from += 256) {
      const value = await chunk(
        d,
        state,
        metric,
        records(d, metric, from, Math.min(from + 256, expected)),
      );
      state = await acceptMetricRecordChunk(
        d,
        state,
        parseMetricRecordChunkWire(encodeMetricRecordChunk(value)),
      );
    }
  }
  return state;
}

describe("bounded continuous six-metric record stream", () => {
  it("accepts cross-V8 rounding only in the derived attack replay level", async () => {
    const fixture = await createSyntheticMetricRecordStreamFixture({
      requestedMetrics: ["level", "attacks"],
    });
    const manifest = structuredClone(fixture.manifest);
    const replay = manifest.metrics.find(
      (item) => item.metric === "attacks",
    )!.attackReplay!;
    replay.previousLevelDb += Number.EPSILON * Math.abs(replay.previousLevelDb);
    expect(replay.previousLevelDb).not.toBe(
      fixture.state.metrics.find((item) => item.metric === "attacks")!
        .attackReplay!.previousLevelDb,
    );
    await expect(
      verifyMetricRecordStreamManifest(
        fixture.descriptor,
        fixture.state,
        manifest,
      ),
    ).resolves.toEqual(manifest);

    for (const change of [
      { previousLevelDb: replay.previousLevelDb + 1e-8 },
      { lastAttackSample: (replay.lastAttackSample ?? 0) + 1 },
      { riseHasAttack: !replay.riseHasAttack },
    ]) {
      const forged = structuredClone(manifest);
      Object.assign(
        forged.metrics.find((item) => item.metric === "attacks")!.attackReplay!,
        change,
      );
      await expect(
        verifyMetricRecordStreamManifest(
          fixture.descriptor,
          fixture.state,
          forged,
        ),
      ).rejects.toThrow("prefix_or_metadata");
    }
  });

  it("does not require or fabricate FFT ownership for an independent metric subset", async () => {
    const fixture = await createSyntheticMetricRecordStreamFixture({
      requestedMetrics: ["level", "attacks"],
    });
    const manifest = metricRecordStreamManifestSchema.parse({
      ...fixture.manifest,
      nativeProof: {
        ...fixture.manifest.nativeProof,
        spectrumCleanup: null,
        spectrumPhase: null,
      },
    });
    await expect(
      verifyMetricRecordStreamManifest(
        fixture.descriptor,
        fixture.state,
        manifest,
      ),
    ).resolves.toEqual(manifest);
  });

  it("still requires genuine FFT phase and cleanup for an available centroid", async () => {
    const fixture = await createSyntheticMetricRecordStreamFixture();
    const manifest = metricRecordStreamManifestSchema.parse({
      ...fixture.manifest,
      nativeProof: {
        ...fixture.manifest.nativeProof,
        spectrumCleanup: null,
        spectrumPhase: null,
      },
    });
    await expect(
      verifyMetricRecordStreamManifest(
        fixture.descriptor,
        fixture.state,
        manifest,
      ),
    ).rejects.toThrow("metric_stream_native_spectrum_phase_mismatch");
  });
  it("binds stable canonical SHA256 independently of insertion order", async () => {
    expect(
      canonicalMetricRecordJson({ z: [1, { b: 2, a: "é" }], a: null }),
    ).toBe('{"a":null,"z":[1,{"a":"é","b":2}]}');
    expect(await metricRecordDigest({ b: 2, a: 1 })).toBe(
      createHash("sha256").update('{"a":1,"b":2}').digest("hex"),
    );
    expect(await metricRecordDigest({ a: 1, b: 2 })).toBe(
      await metricRecordDigest({ b: 2, a: 1 }),
    );
  });

  it("persists geometry-input-only admission and restores the identical canonical descriptor identity", async () => {
    const d = descriptor(600);
    const admission = compactMetricRecordStreamDescriptor(d);
    expect(Object.keys(admission.geometry).sort()).toEqual([
      "captureMode",
      "endBeat",
      "sampleRate",
      "startBeat",
      "startSample",
      "tempoBpm",
      "vectorSize",
    ]);
    expect(JSON.stringify(admission)).not.toContain('"rows":');
    expect(JSON.stringify(admission)).not.toContain('"budgets":');
    const expanded = expandMetricRecordStreamAdmission(admission);
    expect(expanded).toEqual(d);
    expect(
      (await createMetricRecordStreamState(expanded)).descriptorDigest,
    ).toBe((await createMetricRecordStreamState(d)).descriptorDigest);
    expect(
      metricRecordStreamAdmissionSchema.safeParse({
        ...admission,
        geometry: d.geometry,
      }).success,
    ).toBe(false);
    expect(
      metricRecordStreamAdmissionSchema.safeParse({
        ...admission,
        source: {
          ...admission.source,
          transport: { startBeat: 0, endBeat: 1199 },
        },
      }).success,
    ).toBe(false);
  });

  it("streams all original metric shapes and finalizes counts/profiles/tails without terminal records", async () => {
    const d = descriptor();
    const state = await complete(d);
    const final = manifest(d, state);
    expect(await verifyMetricRecordStreamManifest(d, state, final)).toEqual(
      final,
    );
    expect(state.metrics.map((item) => item.nextRecordOffset)).toEqual([
      4, 11, 5, 11, 11, 11,
    ]);
    expect(
      final.metrics.find((item) => item.metric === "pitch")?.trailingSupport,
    ).toEqual({ startSample: 32_528, endSample: 34_000 });
    expect(JSON.stringify(final)).not.toContain('"records":');
    expect(JSON.stringify(final)).not.toContain('"rows":');
    expect(d.algorithms).toHaveLength(6);
  });

  it("keeps host transport running after capture and confirmed native cleanup", async () => {
    const d = descriptor();
    const state = await complete(d);
    const final = manifest(d, state);
    expect(final.nativeProof.timing[3]).toBe(0);
    expect(final.nativeProof.spectrumCleanup).toMatchObject({
      phase: "disabled-confirmed",
    });
    expect(final.nativeProof.clock.frames.every((row) => row[0] === 1)).toBe(
      true,
    );
    await expect(
      verifyMetricRecordStreamManifest(d, state, final),
    ).resolves.toEqual(final);
    const stoppedClock = {
      ...final.nativeProof.clock,
      frames: final.nativeProof.clock.frames.map((row) => {
        const stopped = [...row];
        stopped[0] = stopped[7] = 0;
        stopped[1] = stopped[8] = final.nativeProof.clock.frames[0]![1];
        stopped[5] = 0.125;
        return stopped;
      }),
    };
    expect(
      nativeCheckedTransportClockBindingSchema(false).safeParse(stoppedClock)
        .success,
    ).toBe(true);
    expect(
      metricRecordStreamManifestSchema.safeParse({
        ...final,
        nativeProof: {
          ...final.nativeProof,
          clock: stoppedClock,
        },
      }).success,
    ).toBe(false);
  });

  it("keeps per-metric ordering independent under interleaved chunks", async () => {
    const d = descriptor();
    const initial = await createMetricRecordStreamState(d);
    let state = initial;
    for (const metric of ["pitch", "level", "pitch"] as const) {
      const start = state.metrics.find(
        (item) => item.metric === metric,
      )!.nextIndex;
      state = await acceptMetricRecordChunk(
        d,
        state,
        await chunk(d, state, metric, records(d, metric, start, start + 1)),
      );
    }
    expect(
      state.metrics.find((item) => item.metric === "pitch")?.nextChunkSequence,
    ).toBe(2);
    expect(
      state.metrics.find((item) => item.metric === "level")?.nextChunkSequence,
    ).toBe(1);
    expect(initial.metrics.every((item) => item.nextChunkSequence === 0)).toBe(
      true,
    );
  });

  it.each([
    "chunkSequence",
    "recordOffset",
    "slotOffset",
    "previousDigest",
    "descriptorDigest",
    "digest",
  ] as const)("rejects forged/replayed %s", async (key) => {
    const d = descriptor();
    const state = await createMetricRecordStreamState(d);
    const value = await chunk(d, state, "level", records(d, "level", 0, 1));
    const changed = {
      ...value,
      [key]: typeof value[key] === "number" ? 1 : "f".repeat(64),
    };
    if (key !== "digest")
      changed.digest = await metricRecordChunkDigest(changed);
    await expect(acceptMetricRecordChunk(d, state, changed)).rejects.toThrow(
      "metric_stream_identity_sequence_or_digest_mismatch",
    );
    const next = await acceptMetricRecordChunk(d, state, value);
    await expect(acceptMetricRecordChunk(d, next, value)).rejects.toThrow();
  });

  it("rejects source, ownership, geometry or algorithm mutation after admission", async () => {
    const d = descriptor();
    const state = await createMetricRecordStreamState(d);
    const value = await chunk(d, state, "level", records(d, "level", 0, 1));
    for (const field of [
      "listenerId",
      "passId",
      "correlationId",
      "causationId",
    ] as const)
      await expect(
        acceptMetricRecordChunk(d, state, {
          ...value,
          ownership: { ...value.ownership, [field]: "changed" },
        }),
      ).rejects.toThrow();
    if (d.source.view !== "arrangement")
      throw new Error("Expected Arrangement fixture");
    for (const changed of [
      {
        ...d,
        source: {
          ...d.source,
          target: {
            ...d.source.target,
            expectedReference: "00000000-0000-4000-8000-000000000099",
          },
        },
      },
      {
        ...d,
        geometry: createContinuousMetricListeningGeometry({
          captureMode: "finite-metric-stream",
          sampleRate: 48_000,
          vectorSize: 64,
          tempoBpm: 120,
          startBeat: 0,
          endBeat: 1,
          startSample: d.geometry.startSample + 1,
        }),
      },
      {
        ...d,
        algorithms: d.algorithms.map((item) =>
          item.metric === "attacks"
            ? { ...item, algorithm: { ...item.algorithm!, thresholdDb: 7 } }
            : item,
        ),
      },
    ])
      await expect(
        acceptMetricRecordChunk(changed, state, value),
      ).rejects.toThrow();
  });

  it("rejects malformed, overlapping or missing record supports even after rehashing", async () => {
    const d = descriptor();
    const state = await createMetricRecordStreamState(d);
    for (const values of [
      [
        {
          index: 0,
          support: { startSample: 10_001, endSample: 16_000 },
          peak: [0, 0],
          rms: [0, 0],
        },
      ],
      records(d, "level", 1, 2),
      [records(d, "level")[0], records(d, "level")[0]],
    ]) {
      await expect(
        (async () =>
          acceptMetricRecordChunk(
            d,
            state,
            await chunk(d, state, "level", values),
          ))(),
      ).rejects.toThrow();
    }
  });

  it("retains explicit gaps and resumes non-detector metrics without fabricating silence", async () => {
    const d = descriptor();
    let state = await createMetricRecordStreamState(d);
    const gap = {
      firstIndex: 1,
      count: 2,
      support: { startSample: 16_000, endSample: 28_000 },
      reason: "overflow",
      detail: "bounded producer queue overflow",
    };
    state = await acceptMetricRecordChunk(
      d,
      state,
      await chunk(
        d,
        state,
        "level",
        [records(d, "level")[0], records(d, "level")[3]],
        [gap],
      ),
    );
    expect(state.metrics[0]).toMatchObject({
      nextRecordOffset: 2,
      nextIndex: 4,
      missingRecords: 2,
      gapReasons: ["overflow"],
    });
    for (const metric of d.requestedMetrics.filter(
      (metric) => metric !== "level",
    ))
      state = await acceptMetricRecordChunk(
        d,
        state,
        await chunk(d, state, metric, records(d, metric)),
      );
    await expect(
      verifyMetricRecordStreamManifest(d, state, manifest(d, state, "partial")),
    ).resolves.toBeDefined();
  });

  it("enforces byte bounds on serialized multibyte payloads and raw wire before parsing", async () => {
    const d = descriptor(20);
    const state = await createMetricRecordStreamState(d);
    const value = await chunk(
      d,
      state,
      "mel-bands",
      records(d, "mel-bands", 0, 1),
    );
    expect(parseMetricRecordChunkWire(encodeMetricRecordChunk(value))).toEqual(
      value,
    );
    expect(() =>
      parseMetricRecordChunkWire(" ".repeat(128 * 1024 + 1)),
    ).toThrow("metric_stream_chunk_wire_byte_limit");
    expect(() => parseMetricRecordChunkWire(new Uint8Array([0xff]))).toThrow();
    const big = records(d, "mel-bands", 0, 256).map((value) => ({
      ...(value as object),
      magnitudes: [
        Array(24).fill(Number("0.12345678901234567")),
        Array(24).fill(Number("0.12345678901234567")),
      ],
    }));
    await expect(chunk(d, state, "mel-bands", big)).rejects.toThrow("128 KiB");
    await expect(chunk(d, state, "level", [])).rejects.toThrow();
    await expect(
      chunk(d, state, "level", records(d, "level", 0, 1), [
        {
          firstIndex: 1,
          count: 1,
          support: { startSample: 16_000, endSample: 22_000 },
          reason: "unavailable",
          detail: "é".repeat(161),
        },
      ]),
    ).rejects.toThrow();
  });

  it("accepts long analyzer indices without retaining a giant missing-prefix array", async () => {
    const d = descriptor(600);
    let state = await createMetricRecordStreamState(d);
    const first = await chunk(
      d,
      state,
      "pitch",
      [],
      [
        {
          firstIndex: 0,
          count: 14_000,
          support: { startSample: 10_000, endSample: 28_682_000 },
          reason: "unavailable",
          detail: "explicit missing prefix",
        },
      ],
    );
    state = await acceptMetricRecordChunk(d, state, first);
    const last = await chunk(
      d,
      state,
      "pitch",
      records(d, "pitch", 14_000, 14_001),
    );
    expect(last.records[0]?.index).toBe(14_000);
    state = await acceptMetricRecordChunk(d, state, last);
    expect(
      state.metrics.find((item) => item.metric === "pitch")?.nextIndex,
    ).toBe(14_001);
  });

  it("streams a multi-chunk capture of all six families through bounded chunks and a compact final manifest", async () => {
    const d = descriptor(60);
    const state = await complete(d);
    const final = manifest(d, state);
    await expect(
      verifyMetricRecordStreamManifest(d, state, final),
    ).resolves.toEqual(final);
    expect(state.metrics.map((item) => item.nextRecordOffset)).toEqual([
      480, 1406, 600, 1406, 1406, 1406,
    ]);
    expect(state.metrics.every((item) => item.nextChunkSequence > 1)).toBe(
      true,
    );
    expect(
      new TextEncoder().encode(JSON.stringify(final)).byteLength,
    ).toBeLessThan(128 * 1024);
    expect(
      final.metrics.find((item) => item.metric === "mel-bands")
        ?.trailingSupport,
    ).toEqual({ startSample: 2_889_488, endSample: 2_890_000 });
    const result = summarizeMetricListeningStreamManifest(final);
    expect(result.nativeStatus).toBe("completed");
    expect(result.metrics.map((metric) => metric.retainedRecords)).toEqual([
      480, 1406, 600, 1406, 1406, 1406,
    ]);
  });

  it("distinguishes known sub-window no-frame tails from unavailable algorithms and failed output", async () => {
    const tiny = descriptor(1 / 48_000);
    const short = await complete(tiny);
    const final = manifest(tiny, short);
    await expect(
      verifyMetricRecordStreamManifest(tiny, short, final),
    ).resolves.toBeDefined();
    expect(final.metrics.find((item) => item.metric === "pitch")).toMatchObject(
      {
        status: "complete",
        expectedRecords: 0,
        trailingSupport: { startSample: 10_000, endSample: 10_001 },
      },
    );
    const original = descriptor();
    const unavailable = metricRecordStreamDescriptorSchema.parse({
      ...original,
      requestedMetrics: ["pitch"],
      algorithms: [
        {
          metric: "pitch",
          availability: "unavailable",
          unavailableReason: "producer unavailable",
          algorithm: null,
        },
      ],
    });
    let state = await createMetricRecordStreamState(unavailable);
    await expect(
      acceptMetricRecordChunk(
        unavailable,
        state,
        await chunk(
          unavailable,
          state,
          "pitch",
          records(unavailable, "pitch", 0, 1),
        ),
      ),
    ).rejects.toThrow("unavailable_records");
    state = await acceptMetricRecordChunk(
      unavailable,
      state,
      await chunk(
        unavailable,
        state,
        "pitch",
        [],
        [
          {
            firstIndex: 0,
            count: 11,
            support: { startSample: 10_000, endSample: 32_528 },
            reason: "dependency-unavailable",
            detail: "actual native producer unavailable",
          },
        ],
      ),
    );
    const failed = manifest(unavailable, state, "failed");
    await expect(
      verifyMetricRecordStreamManifest(unavailable, state, failed),
    ).resolves.toBeDefined();
    expect(failed.metrics[0]).toMatchObject({
      status: "failed",
      availability: "unavailable",
      missingRecords: 11,
      gapReasons: ["dependency-unavailable"],
    });
    expect(() => summarizeMetricListeningStreamManifest(failed)).toThrow(
      "not_publishable",
    );
  });

  it.each([
    [-1.2676062401770316, 94.64787519645938],
    [-1.2676062401770314, 94.64787519645937],
  ])(
    "replays cross-V8 attack strength %s across chunk boundaries",
    async (log, strength) => {
      const d = descriptor();
      let state = await createMetricRecordStreamState(d);
      state = await acceptMetricRecordChunk(
        d,
        state,
        await chunk(d, state, "attacks", records(d, "attacks", 0, 1)),
      );
      const record = {
        index: 1,
        support: { startSample: 14_800, endSample: 19_600 },
        inputLevel: { peak: [0.054, 0.054], rms: [0.054, 0.054] },
        events: [{ sample: 19_600, strength }],
      };
      const valid = await chunk(d, state, "attacks", [record]);
      const forged = await chunk(d, state, "attacks", [
        {
          ...record,
          events: [{ sample: 19_600, strength: strength + 1e-10 }],
        },
      ]);
      const original = Math.log10;
      const spy = vi
        .spyOn(Math, "log10")
        .mockImplementation((value) =>
          value === 0.054 ? log : original(value),
        );
      try {
        const next = await acceptMetricRecordChunk(d, state, valid);
        expect(
          next.metrics.find((item) => item.metric === "attacks"),
        ).toMatchObject({
          nextIndex: 2,
          attackReplay: { lastAttackSample: 19_600, riseHasAttack: true },
        });
        await expect(acceptMetricRecordChunk(d, state, forged)).rejects.toThrow(
          "attack_replay_mismatch",
        );
      } finally {
        spy.mockRestore();
      }
    },
  );

  it("replays exact attack history across chunks and refuses resumption after a history gap", async () => {
    const d = descriptor();
    let state = await createMetricRecordStreamState(d);
    const input = {
      index: 0,
      support: { startSample: 10_000, endSample: 14_800 },
      inputLevel: { peak: [0.1, 0.1], rms: [0.1, 0.1] },
      events: [{ sample: 14_800, strength: 100 }],
    };
    state = await acceptMetricRecordChunk(
      d,
      state,
      await chunk(d, state, "attacks", [input]),
    );
    const wrong = {
      ...input,
      index: 1,
      support: { startSample: 14_800, endSample: 19_600 },
      events: [{ sample: 19_600, strength: 100 }],
    };
    await expect(
      acceptMetricRecordChunk(
        d,
        state,
        await chunk(d, state, "attacks", [wrong]),
      ),
    ).rejects.toThrow("attack_replay");
    state = await acceptMetricRecordChunk(
      d,
      state,
      await chunk(
        d,
        state,
        "attacks",
        [],
        [
          {
            firstIndex: 1,
            count: 1,
            support: wrong.support,
            reason: "unavailable",
            detail: "missing input",
          },
        ],
      ),
    );
    await expect(
      acceptMetricRecordChunk(
        d,
        state,
        await chunk(d, state, "attacks", records(d, "attacks", 2, 3)),
      ),
    ).rejects.toThrow("attack_history_gap");
  });

  it("summarizes useful native failures and single-family streams without rebuilding observations", async () => {
    const d = descriptor();
    const state = await complete(d);
    const partial = summarizeMetricListeningStreamManifest(
      manifest(d, state, "partial", proof(d, "failed")),
    );
    expect(partial).toMatchObject({
      outcome: "partial",
      nativeStatus: "failed",
    });
    expect(
      partial.metrics.every((metric) => metric.status === "complete"),
    ).toBe(true);
    const pitch = metricRecordStreamDescriptorSchema.parse({
      ...d,
      requestedMetrics: ["pitch"],
      algorithms: d.algorithms.filter((item) => item.metric === "pitch"),
    });
    const pitchState = await complete(pitch);
    const result = summarizeMetricListeningStreamManifest(
      manifest(pitch, pitchState),
    );
    expect(
      result.metrics.map((metric) => [metric.metric, metric.status]),
    ).toEqual([
      ["level", "not-requested"],
      ["spectral-centroid", "not-requested"],
      ["attacks", "not-requested"],
      ["pitch", "complete"],
    ]);
  });

  it("rejects Nyquist violations without changing finite centroid value semantics", async () => {
    const d = descriptor();
    const changed = metricRecordStreamDescriptorSchema.parse({
      ...d,
      geometry: createContinuousMetricListeningGeometry({
        captureMode: "finite-metric-stream",
        sampleRate: 44100,
        vectorSize: 64,
        tempoBpm: 120,
        startBeat: 0,
        endBeat: 1,
        startSample: 10_000,
      }),
      algorithms: d.algorithms.map((item) =>
        item.metric === "attacks"
          ? { ...item, algorithm: { ...item.algorithm!, windowSamples: 4410 } }
          : item,
      ),
    });
    const state = await createMetricRecordStreamState(changed);
    await expect(
      acceptMetricRecordChunk(
        changed,
        state,
        await chunk(changed, state, "spectral-centroid", [
          {
            index: 0,
            support: { startSample: 10_000, endSample: 12_048 },
            spectralEnergy: 1,
            centroidHz: 23000,
          },
        ]),
      ),
    ).rejects.toThrow("nyquist");
  });

  it("rejects terminal manifest count, digest, tail, timing, phase or native coverage forgeries", async () => {
    const d = descriptor();
    const state = await complete(d);
    const final = manifest(d, state);
    for (const change of [
      {
        metrics: final.metrics.map((item, index) =>
          index ? item : { ...item, lastDigest: "f".repeat(64) },
        ),
      },
      {
        metrics: final.metrics.map((item) =>
          item.metric === "pitch" ? { ...item, trailingSupport: null } : item,
        ),
      },
      {
        metrics: final.metrics.map((item, index) =>
          index
            ? item
            : { ...item, nextRecordOffset: item.nextRecordOffset - 1 },
        ),
      },
      {
        nativeProof: {
          ...final.nativeProof,
          capturedSamples: 23999,
          sourceEnd: 33999,
        },
      },
      {
        nativeProof: {
          ...final.nativeProof,
          configuration: final.nativeProof.configuration.map((cell, index) =>
            index === 3 ? 121 : cell,
          ),
          confirmedConfiguration: final.nativeProof.configuration.map(
            (cell, index) => (index === 3 ? 121 : cell),
          ),
        },
      },
      { nativeProof: { ...final.nativeProof, spectrumPhase: null } },
      {
        nativeProof: {
          ...final.nativeProof,
          spectrumCleanup: {
            ...final.nativeProof.spectrumCleanup,
            status: "failed",
          },
        },
      },
    ])
      await expect(
        verifyMetricRecordStreamManifest(d, state, {
          ...final,
          ...change,
        } as MetricRecordStreamManifest),
      ).rejects.toThrow();
  });

  it("finalizes cancellation with explicit unmeasured suffixes and rejects retained data past native stop", async () => {
    const d = descriptor();
    let state = await createMetricRecordStreamState(d);
    for (const metric of d.requestedMetrics) {
      const expected = metricRecordStreamExpectedCoverage(
        d,
        metric,
      ).expectedRecords;
      const values = records(d, metric);
      const first = values[0] as {
        support: { startSample: number; endSample: number };
      };
      const last = values.at(-1) as typeof first;
      state = await acceptMetricRecordChunk(
        d,
        state,
        await chunk(
          d,
          state,
          metric,
          [],
          [
            {
              firstIndex: 0,
              count: expected,
              support: {
                startSample: first.support.startSample,
                endSample: last.support.endSample,
              },
              reason: "cancelled",
              detail: "cancelled before first complete window",
            },
          ],
        ),
      );
    }
    const final = manifest(d, state, "cancelled", proof(d, "cancelled", 100));
    await expect(
      verifyMetricRecordStreamManifest(d, state, final),
    ).resolves.toBeDefined();
    expect(
      final.metrics.every(
        (metric) =>
          metric.trailingSupport?.startSample === 10_000 &&
          metric.trailingSupport.endSample === 10_100,
      ),
    ).toBe(true);
    expect(() => summarizeMetricListeningStreamManifest(final)).toThrow(
      "not_publishable",
    );
    const completeState = await complete(d);
    const forged = manifest(
      d,
      completeState,
      "cancelled",
      proof(d, "cancelled", 100),
    );
    await expect(
      verifyMetricRecordStreamManifest(d, completeState, forged),
    ).rejects.toThrow("prefix_or_metadata");
  });

  it("exposes the shared finite capability and attributed lifecycle failure/cleanup", () => {
    expect(METRIC_RECORD_STREAM_CAPABILITY).toMatchObject({
      modes: ["session", "arrangement"],
      maxDurationSeconds: 600,
      maxListeners: 8,
      maxPendingChunks: 8,
      maxChunkBytes: 131072,
      terminal: "manifest-only",
    });
    const d = descriptor();
    const event = {
      schema: "metric-record-stream-lifecycle/v1",
      descriptorDigest: "a".repeat(64),
      ownership: d.ownership,
      stage: "cleanup",
      status: "failed",
      elapsedMs: 100,
      requestedSamples: d.geometry.totalSamples,
      capturedSamples: d.geometry.totalSamples,
      durablyPersistedSamples: 0,
      pendingChunks: 0,
      metric: null,
      chunkSequence: null,
      retainedRecords: 0,
      missingRecords: 1,
      reason: "cleanup failed",
    };
    expect(metricRecordStreamLifecycleSchema.parse(event).ownership).toEqual(
      d.ownership,
    );
    expect(
      metricRecordStreamLifecycleSchema.safeParse({ ...event, reason: null })
        .success,
    ).toBe(false);
    expect(
      metricRecordStreamLifecycleSchema.safeParse({ ...event, elapsedMs: -1 })
        .success,
    ).toBe(false);
    expect(
      metricRecordStreamLifecycleSchema.safeParse({
        ...event,
        chunkSequence: 1,
      }).success,
    ).toBe(false);
    for (const invalid of [
      { capturedSamples: event.requestedSamples + 1 },
      { capturedSamples: 0, durablyPersistedSamples: 1 },
      { durablyPersistedSamples: event.requestedSamples + 1 },
      { pendingChunks: 9 },
    ])
      expect(
        metricRecordStreamLifecycleSchema.safeParse({ ...event, ...invalid })
          .success,
      ).toBe(false);
    expect(
      metricRecordStreamLifecycleSchema.safeParse({
        ...event,
        capturedSamples: null,
        durablyPersistedSamples: null,
        pendingChunks: null,
      }).success,
    ).toBe(true);
    expect(
      metricRecordStreamDescriptorSchema.safeParse({
        ...d,
        maxPendingChunks: 9,
      }).success,
    ).toBe(false);
  });
});
