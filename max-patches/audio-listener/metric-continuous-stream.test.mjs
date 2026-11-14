import "./native-protocol-test-loader.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { Buffer } from "node:buffer";
import { setImmediate } from "node:timers";
import * as codec from "../../packages/protocol/src/metric-record-stream.ts";
import {
  createContinuousMetricListeningGeometry,
  METRIC_CONTINUOUS_LISTENING_CAPABILITY,
} from "../../packages/protocol/src/metric-continuous-geometry.ts";
import { createSyntheticMetricListeningObservation } from "../../packages/protocol/src/metric-testing.ts";
import { MEL_BAND_PROFILE } from "../../packages/protocol/src/mel-band-profile.ts";
import {
  PITCH_PROFILE,
  SPECTRAL_SHAPE_PROFILE,
} from "../../packages/protocol/src/analyzer-profile.ts";
import * as nativeCodec from "./audio_listener_metric_protocol.mjs";
const require = createRequire(import.meta.url);
const {
  createMetricRecordProducer,
} = require("./audio_listener_metric_stream.js");
const {
  createMetricTimelines,
  createMetricListeningGeometry,
} = require("./audio_listener_metric_timelines.js");
const { createMelBandHandoff } = require("./audio_listener_mel_handoff.js");

function descriptor(seconds, tempoBpm = 120) {
  const o = createSyntheticMetricListeningObservation();
  const geometry = createContinuousMetricListeningGeometry({
    captureMode: "arrangement-continuous",
    sampleRate: 48000,
    vectorSize: 64,
    tempoBpm,
    startBeat: 0,
    endBeat: (seconds * tempoBpm) / 60,
    startSample: 10000,
  });
  return codec.metricRecordStreamDescriptorSchema.parse({
    schema: "metric-record-stream/v1",
    capability: METRIC_CONTINUOUS_LISTENING_CAPABILITY,
    ownership: o.ownership,
    source: {
      ...o.source,
      transport: { startBeat: 0, endBeat: (seconds * tempoBpm) / 60 },
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
      { metric: "level", algorithm: o.metrics.level.algorithm },
      {
        metric: "spectral-centroid",
        algorithm: o.metrics["spectral-centroid"].algorithm,
      },
      { metric: "attacks", algorithm: o.metrics.attacks.algorithm },
      { metric: "mel-bands", algorithm: MEL_BAND_PROFILE },
      { metric: "pitch", algorithm: PITCH_PROFILE },
      { metric: "spectral-shape", algorithm: SPECTRAL_SHAPE_PROFILE },
    ].map((a) => ({
      ...a,
      availability: "available",
      unavailableReason: null,
    })),
    maxPendingChunks: 8,
  });
}

function frame(d, metric, index) {
  const g = d.geometry;
  const hop = metric === "attacks" ? 4800 : 2048;
  const row = g.rows[index];
  const support =
    metric === "level"
      ? { startSample: row.startSample, endSample: row.endSample }
      : {
          startSample: g.startSample + index * hop,
          endSample: Math.min(g.endSample, g.startSample + (index + 1) * hop),
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
      channels: [0, 1].map(() => ({
        state: "silence",
        hz: null,
        confidence: null,
      })),
    };
  return {
    ...base,
    channels: [0, 1].map(() => ({
      state: "silence",
      flatnessDb: null,
      spreadHz: null,
      rolloffHz: null,
    })),
  };
}

test("600s at maximum tempo sends compact source admission and keeps expanded descriptor digest identity", async () => {
  const d = descriptor(600, 999),
    sent = [],
    failures = [];
  const p = createMetricRecordProducer({
    codec,
    descriptor: d,
    send: (payload) => {
      sent.push(payload);
      return true;
    },
    onFailure: (reason) => failures.push(reason),
  });
  assert.equal(await p.flush(), true);
  assert.equal(sent.length, 1);
  assert.equal(
    sent[0].metricStream.schema,
    "metric-record-stream-admission/v1",
  );
  assert.equal(sent[0].metricStream.geometry.rows, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(d)) > 2 * 1024 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(sent[0])) < 128 * 1024);
  const expanded = codec.expandMetricRecordStreamAdmission(
    sent[0].metricStream,
  );
  assert.deepEqual(expanded, d);
  assert.equal(
    p.snapshot().state.descriptorDigest,
    await codec.metricRecordStreamDescriptorDigest(expanded),
  );
  assert.deepEqual(failures, []);
  p.cancel();
});

for (const seconds of [180, 600]) {
  test(`${seconds}s all-six continuous producer drains canonical bounded records without a full observation`, async () => {
    const d = descriptor(seconds);
    const failures = [];
    let receiver = await codec.createMetricRecordStreamState(d);
    let chunks = 0;
    const producer = createMetricRecordProducer({
      codec,
      descriptor: d,
      onFailure: (r) => failures.push(r),
      send: async (payload) => {
        assert.equal(payload.observation, undefined);
        if (payload.metricChunk) {
          chunks++;
          assert.ok(
            Buffer.byteLength(JSON.stringify(payload.metricChunk)) <=
              128 * 1024,
          );
          receiver = await codec.acceptMetricRecordChunk(
            d,
            receiver,
            payload.metricChunk,
          );
        }

        return true;
      },
    });
    for (const metric of d.requestedMetrics) {
      const { expectedRecords } = codec.metricRecordStreamExpectedCoverage(
        d,
        metric,
      );
      for (let index = 0; index < expectedRecords; index++) {
        assert.equal(producer.ingest(metric, frame(d, metric, index)), true);
        // A scheduler drain, NOT an acquisition/FFT/detector reset.
        if (index % 127 === 126) assert.equal(await producer.flush(), true);
      }
      assert.equal(await producer.flush(), true);
    }
    assert.deepEqual(failures, []);
    assert.ok(chunks > 100);
    assert.equal(producer.snapshot().bufferedEntries, 0);
    assert.equal(producer.snapshot().pendingChunks, 0);
    assert.ok(producer.snapshot().pendingHighWater <= 8);
    assert.deepEqual(producer.snapshot().state, receiver);
    for (const m of receiver.metrics)
      assert.equal(
        m.nextRecordOffset,
        codec.metricRecordStreamExpectedCoverage(d, m.metric).expectedRecords,
      );
    await assert.rejects(producer.finalize({}), /./); // geometry/data are not physical drain proof
    assert.equal(producer.cancel(), true);
    assert.equal(producer.ingest("level", frame(d, "level", 0)), false);
  });
}

for (const seconds of [180, 600]) {
  test(`${seconds}s native analyzer handoff releases streamed vectors and still requires physical terminal consumption`, () => {
    const total = seconds * 48000,
      origin = 10000,
      end = origin + total;
    const expected = Math.floor(total / 2048);
    const counts = { "mel-bands": 0, pitch: 0, "spectral-shape": 0 };
    const controls = [],
      gaps = [];
    let time = 0;
    const h = createMelBandHandoff({
      epoch: 7,
      sampleRate: 48000,
      totalSamples: total,
      captureMode: "arrangement-continuous",
      requestedMetrics: Object.keys(counts),
      analyzerReadiness: {
        schema: "analyzer-native-readiness/v1",
        producerAbi: 3,
        sourceAbi: 3,
        probeToken: 1,
        dspGeneration: 1,
        sampleRate: 48000,
        sourceClock: 9999,
      },
      codec: { ...nativeCodec, ...codec },
      now: () => time,
      send: (...args) => controls.push(args),
      emit: () => {},
      onRecord(metric, record) {
        assert.equal(record.index, counts[metric]++);
        return true;
      },
      onGap(metric, gap) {
        gaps.push({ metric, gap });
        return true;
      },
    });
    const header = (
      sequence,
      start,
      stop,
      lost = 0,
      partial = 0,
      reason = 0,
    ) => [3, 7, 1, sequence, start, stop, lost, partial, reason, 48000, 24];
    h.arm();
    h.receive(["mel_ready", ...header(0, 9999, 9999)]);
    h.receive(["mel_started", ...header(0, origin, end)]);
    h.bind({ startSample: origin, endSample: end });
    for (let i = 0; i < expected; i++) {
      h.receive([
        "mel_frame",
        ...header(i + 1, origin + i * 2048, origin + (i + 1) * 2048),
        ...Array(48).fill(0.25),
        ...[0, 1].flatMap(() => [1, "null", "null", 1, "null", "null", "null"]),
      ]);
      assert.equal(h.snapshot().retainedFrames, 0);
    }
    assert.throws(() => h.settleStream(), /not_settled/);
    h.receive([
      "mel_stopped",
      ...header(expected, origin + expected * 2048, end, 0, total % 2048, 10),
    ]);
    assert.equal(h.stop(), false); // native terminal alone is not physical drain proof
    time += 10;
    h.tick();
    const token = controls.findLast(([selector]) => selector === "drain")[1][0];
    h.receive(["mel_drain", 3, token, 7, 1, expected + 3, expected, 1, 1, end]);
    assert.equal(h.stop(), true);
    const summary = h.settleStream();
    assert.equal(summary.receivedFrames, expected);
    assert.deepEqual(
      counts,
      Object.fromEntries(Object.keys(counts).map((m) => [m, expected])),
    );
    assert.deepEqual(gaps, []);
    assert.equal(controls.filter(([selector]) => selector === "arm").length, 1);
    assert.throws(() => h.timeline(), /terminal_manifest/);
    assert.throws(() => h.analyzerTimelines(), /terminal_manifest/);
    assert.equal(h.settleStream().receipt.sourceClockExclusive, end);
  });
}

test("slow writer has explicit bounded overflow and cancellation never retries ambiguous delivery", async () => {
  const d = descriptor(600);
  let release;
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  const failures = [],
    sent = [];
  const p = createMetricRecordProducer({
    codec,
    descriptor: d,
    onFailure: (r) => failures.push(r),
    send: async (payload) => {
      sent.push(payload);
      await wait;
      return true;
    },
  });
  let accepted = 0;
  while (
    accepted < 10000 &&
    p.ingest("mel-bands", frame(d, "mel-bands", accepted))
  )
    accepted++;
  assert.ok(accepted < 10000);
  assert.equal(p.snapshot().failure, "metric_stream_pending_overflow");
  assert.equal(p.snapshot().pendingHighWater, 8);
  assert.equal(p.snapshot().pendingChunks, 0);
  assert.equal(p.snapshot().bufferedEntries, 0);
  assert.deepEqual(failures, ["metric_stream_pending_overflow"]);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.filter((m) => m.metricChunk).length, 0);
  assert.equal(await p.flush(), false);
});

test("periodic control ticks deliver sparse level tails within five seconds without resetting acquisition", async () => {
  const d = descriptor(600),
    failures = [],
    chunks = [];
  let delivered;
  const received = new Promise((resolve) => {
    delivered = resolve;
  });
  const p = createMetricRecordProducer({
    codec,
    descriptor: d,
    onFailure: (r) => failures.push(r),
    send: (payload) => {
      if (payload.metricChunk) {
        chunks.push(payload.metricChunk);
        delivered();
      }
      return true;
    },
  });
  assert.equal(p.tick(100), true);
  assert.equal(p.ingest("level", frame(d, "level", 0)), true);
  assert.equal(p.tick(5099), true);
  assert.equal(p.snapshot().pendingChunks, 0);
  assert.equal(p.tick(5100), true);
  await received;
  await p.flush();
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].chunkSequence, 0);
  assert.equal(chunks[0].records.length, 1);
  assert.equal(p.ingest("level", frame(d, "level", 1)), true);
  assert.equal(p.tick(10100), true);
  await p.flush();
  assert.equal(chunks[1].chunkSequence, 1);
  assert.equal(chunks[1].recordOffset, 1);
  assert.equal(chunks[1].previousDigest, chunks[0].digest);
  assert.deepEqual(failures, []);
  p.cancel();
  assert.equal(p.tick(15100), false);
});

test("periodic sparse flushes preserve the global pending cap under stalled acknowledgements", async () => {
  const d = descriptor(600),
    failures = [];
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const p = createMetricRecordProducer({
    codec,
    descriptor: d,
    onFailure: (r) => failures.push(r),
    send: () => blocked,
  });
  p.tick(0);
  for (let i = 0; i < 9; i++) {
    assert.equal(p.ingest("level", frame(d, "level", i)), true);
    assert.equal(p.tick((i + 1) * 5000), i < 8);
  }
  assert.equal(p.snapshot().pendingHighWater, 8);
  assert.equal(p.snapshot().bufferedEntries, 0);
  assert.deepEqual(failures, ["metric_stream_pending_overflow"]);
  release(true);
  await p.flush();
});

test("nonfinite values cannot be serialized into legitimate undefined descriptor values", () => {
  const d = descriptor(1),
    failures = [];
  const p = createMetricRecordProducer({
    codec,
    descriptor: d,
    send: () => true,
    onFailure: (r) => failures.push(r),
  });
  const value = frame(d, "spectral-centroid", 0);
  value.centroidHz = NaN;
  assert.equal(p.ingest("spectral-centroid", value), false);
  assert.deepEqual(failures, ["metric_stream_invalid_record"]);
  assert.equal(p.snapshot().bufferedEntries, 0);
});

test("writer rejection fails once and retains no claimed-delivered prefix", async () => {
  const d = descriptor(1),
    failures = [];
  const p = createMetricRecordProducer({
    codec,
    descriptor: d,
    onFailure: (r) => failures.push(r),
    send: (payload) => !payload.metricChunk,
  });
  assert.equal(p.ingest("level", frame(d, "level", 0)), true);
  assert.equal(await p.flush(), false);
  assert.deepEqual(failures, ["metric_stream_chunk_delivery_failed"]);
  assert.equal(p.snapshot().state.metrics[0].nextRecordOffset, 0);
});

test("cancellation during an in-flight batch clears retention without claiming delivery or cleanup", async () => {
  const d = descriptor(1),
    sent = [],
    failures = [];
  let release;
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  const p = createMetricRecordProducer({
    codec,
    descriptor: d,
    onFailure: (r) => failures.push(r),
    send: async (payload) => {
      sent.push(payload);
      if (payload.metricChunk) await wait;
      return true;
    },
  });
  p.ingest("level", frame(d, "level", 0));
  const flushed = p.flush();
  for (let turn = 0; turn < 1000 && !sent.some((m) => m.metricChunk); turn++)
    await new Promise((resolve) => setImmediate(resolve));
  assert.ok(sent.some((m) => m.metricChunk));
  assert.equal(p.cancel(), true);
  release();
  assert.equal(await flushed, false);
  assert.equal(p.snapshot().pendingChunks, 0);
  assert.equal(p.snapshot().bufferedEntries, 0);
  assert.equal(p.snapshot().state.metrics[0].nextRecordOffset, 0);
  assert.equal(p.snapshot().complete, false);
  assert.deepEqual(failures, []);
  await assert.rejects(p.finalize({}), /closed/);
  assert.equal(sent.filter((m) => m.metricManifest).length, 0);
});

for (const seconds of [180, 600]) {
  test(`${seconds}s reducer preserves detector/FFT state over 256-record cuts with constant record retention`, () => {
    const d = descriptor(seconds),
      g = d.geometry;
    assert.deepEqual(
      createMetricListeningGeometry({
        captureMode: g.captureMode,
        sampleRate: g.sampleRate,
        vectorSize: g.vectorSize,
        tempoBpm: g.tempoBpm,
        startBeat: g.startBeat,
        endBeat: g.endBeat,
        startSample: g.startSample,
      }),
      g,
    );
    const owner = {
      generation: d.ownership.generation,
      nativeEpoch: 1,
      arm: "arm-1",
    };
    const counts = { level: 0, attacks: 0, "spectral-centroid": 0 };
    let previousDb = -120,
      lastAttack = -Infinity,
      riseHasAttack = false;
    const attack = d.algorithms.find((a) => a.metric === "attacks").algorithm;
    const c = createMetricTimelines(
      {
        owner,
        captureMode: g.captureMode,
        originSample: g.startSample,
        originBeat: 0,
        sampleRate: g.sampleRate,
        vectorSize: g.vectorSize,
        tempo: g.tempoBpm,
        startBeat: g.startBeat,
        endBeat: g.endBeat,
        captureStartSample: g.startSample,
        captureEndSample: g.endSample,
        requestedMetrics: ["level", "spectrum", "attacks"],
        attacks: {
          thresholdDb: attack.thresholdDb,
          minSpacingSamples: attack.minSpacingSamples,
        },
      },
      {
        now: () => 1,
        onRecord(metric, record) {
          assert.equal(record.index, counts[metric]++);
          if (metric === "attacks") {
            const db = Math.max(
              -120,
              20 * Math.log10(record.inputLevel.rms[0]),
            );
            const rise = db - previousDb;
            if (rise <= 0) riseHasAttack = false;
            const expected =
              !riseHasAttack &&
              rise >= attack.thresholdDb &&
              record.support.endSample - lastAttack >= attack.minSpacingSamples;
            assert.equal(record.events.length, expected ? 1 : 0);
            if (expected) {
              assert.equal(record.events[0].sample, record.support.endSample);
              lastAttack = record.support.endSample;
              riseHasAttack = true;
            }
            previousDb = db;
          }
          return true;
        },
      },
    );
    for (const row of c.grid) {
      const n = row.endSample - row.startSample;
      assert.equal(
        c.ingestLevel({
          owner,
          sequence: row.index + 1,
          startSample: row.startSample,
          endSample: row.endSample,
          count: n,
          peak: [0.5, 0.5],
          sumSquares: [n / 4, n / 4],
        }).accepted,
        true,
      );
    }
    for (let i = 0; i < Math.ceil(g.totalSamples / 4800); i++) {
      const startSample = g.startSample + i * 4800,
        endSample = Math.min(g.endSample, startSample + 4800);
      const n = endSample - startSample;
      // Rising and falling runs deliberately cross multiples of 256.
      const amp = 10 ** ((-60 + (i % 7) * 8) / 20);
      assert.equal(
        c.ingestDetectorLevel({
          owner,
          sequence: i + 1,
          startSample,
          endSample,
          count: n,
          peak: [amp, amp],
          sumSquares: [n * amp * amp, n * amp * amp],
        }).accepted,
        true,
      );
    }
    for (let i = 0; i < Math.floor(g.totalSamples / 2048); i++)
      assert.equal(
        c.ingestSpectrum({
          owner,
          sequence: i + 1,
          startSample: g.startSample + i * 2048,
          endSample: g.startSample + (i + 1) * 2048,
          energy: i % 2,
          centroidHz: i % 2 ? 440 : null,
        }).accepted,
        true,
      );
    for (const m of Object.values(c.progress().metrics))
      assert.equal(m.retainedRecords, 1);
    assert.throws(
      () => c.finalize({ owner, sourceEndSample: g.endSample }),
      /terminal_manifest/,
    );
    const terminal = c.finalizeStream({ owner, sourceEndSample: g.endSample });
    assert.equal(terminal.status, "completed");
    assert.equal(terminal.rows, undefined);
    assert.equal(terminal.metrics.attacks.acceptedRecords, seconds * 10);
    assert.equal(c.cancel(), terminal);
  });
}
