import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  createMetricTimelines,
} = require("./audio_listener_metric_timelines.js");
const owner = Object.freeze({
  generation: "00000000-0000-4000-8000-000000000009",
  nativeEpoch: 1,
  arm: "explicit-reference",
});
const hop = 4800;

function fixture(levels, options = {}) {
  const total = (levels.length - 1) * hop + (options.tail ?? hop);
  const events = [];
  let time = 0;
  const collector = createMetricTimelines(
    {
      owner,
      originSample: 0,
      originBeat: 0,
      sampleRate: 48000,
      vectorSize: 64,
      tempo: 120,
      startBeat: 0,
      endBeat: total / 24000,
      captureStartSample: 0,
      captureEndSample: total,
      requestedMetrics: ["attacks"],
      attacks: { thresholdDb: 6, minSpacingSamples: hop, ...options.attacks },
      traceId: "detector-trace",
      correlationId: "detector-correlation",
      causationId: "detector-cause",
    },
    { now: () => time++, onEvent: (event) => events.push(event) },
  );
  const record = (index) => {
    const rms = Array.isArray(levels[index])
      ? levels[index]
      : [levels[index], levels[index]];
    const start = index * hop,
      end = Math.min(start + hop, total),
      count = end - start;
    return {
      owner,
      sequence: index + 1,
      startSample: start,
      endSample: end,
      count,
      peak: [...rms],
      rms: [...rms],
    };
  };
  return {
    collector,
    events,
    record,
    finish() {
      for (let index = 0; index < levels.length; index++)
        assert.equal(
          collector.ingestDetectorLevel(record(index)).accepted,
          true,
        );
      return collector.finalize({ owner, sourceEndSample: total });
    },
  };
}

const references = [
  { name: "silence", levels: [0, 0, 0], samples: [] },
  { name: "silence floor", levels: [0, 1e-7, 1e-6, 1e-7], samples: [] },
  {
    name: "continuous rise rearms only on plateau or fall",
    levels: [0.1, 0.2, 0.4, 0.4, 0.8, 0.8, 0.2, 0.8],
    samples: [4800, 24000, 38400],
  },
  {
    name: "refractory spacing",
    levels: [0, 0.1, 0.1, 0, 0.1, 0, 0.1],
    samples: [9600, 24000],
    attacks: { minSpacingSamples: 14400 },
  },
  {
    name: "subthreshold rise does not latch",
    levels: [0, 1.2e-6, 0.01],
    samples: [14400],
  },
  {
    name: "zero threshold sustained level",
    levels: [0.25, 0.25, 0.25],
    samples: [4800],
    attacks: { thresholdDb: 0 },
  },
  {
    name: "zero threshold still ignores silence and floor",
    levels: [0, 1e-7, 1e-6],
    samples: [],
    attacks: { thresholdDb: 0 },
  },
  {
    name: "threshold above rise suppresses weak episode",
    levels: [0, 0.001, 0.002],
    samples: [],
    attacks: { thresholdDb: 100 },
  },
  {
    name: "upper threshold is inclusive",
    levels: [0, 1],
    samples: [9600],
    attacks: { thresholdDb: 120 },
  },
  {
    name: "channel-independent level uses louder channel",
    levels: [
      [0, 0.1],
      [0.1, 0],
      [0, 0],
      [0, 0.2],
    ],
    samples: [4800, 19200],
  },
  {
    name: "one-sample final support is not a fabricated full window",
    levels: [0, 0, 0.1],
    samples: [9601],
    tail: 1,
  },
  {
    name: "recorded split-window bursts retain four independent events",
    levels: [
      0.08334607275022969, 0.35355295547947874, 0.35355295547947874,
      0.2165873145900059, 0, 0.08534456692400168, 0.35355295547947874,
      0.35355295547947874, 0.2165873145900059, 0, 0.08534456692400168,
      0.35355295547947874, 0.35355295547947874, 0.2165873145900059, 0,
      0.08534456692400168, 0.35355295547947874, 0.35355295547947874,
      0.2165873145900059, 0,
    ],
    samples: [4800, 28800, 52800, 76800],
  },
];
for (const reference of references) {
  test(`current detector explicit reference: ${reference.name}`, () => {
    for (let pass = 0; pass < 2; pass++) {
      const f = fixture(reference.levels, reference);
      const result = f.finish();
      assert.equal(result.metrics.attacks.status, "completed");
      assert.deepEqual(
        result.metrics.attacks.summary.events.map(({ sample }) => sample),
        reference.samples,
      );
      assert.equal(
        result.metrics.attacks.records.length,
        reference.levels.length,
      );
      assert(!JSON.stringify(result).includes("Infinity"));
      for (const event of f.events) {
        assert.equal(event.traceId, "detector-trace");
        assert.equal(event.correlationId, "detector-correlation");
        assert(event.elapsedMs >= 0);
      }
    }
  });
}

for (const attacks of [
  { thresholdDb: -1 },
  { thresholdDb: 121 },
  { thresholdDb: NaN },
  { thresholdDb: Infinity },
  { minSpacingSamples: -1 },
  { minSpacingSamples: 0.5 },
  { minSpacingSamples: 2 ** 44 },
  { windowSamples: hop + 1 },
  { rawAudio: "not-allowed" },
]) {
  test(`current detector rejects unsupported configuration ${JSON.stringify(attacks)}`, () => {
    assert.throws(
      () => fixture([0, 0.1], { attacks }),
      /invalid_attack_configuration/,
    );
  });
}

for (const mutate of [
  (record) => {
    record.rms[0] = NaN;
  },
  (record) => {
    record.peak[0] = Infinity;
  },
  (record) => {
    record.rms[0] = -1;
  },
  (record) => {
    record.rms[0] = 65;
    record.peak[0] = 65;
  },
  (record) => {
    record.count++;
  },
]) {
  test(`current detector malformed record cannot produce a completed family: ${mutate.toString()}`, () => {
    const f = fixture([0.1, 0.2]);
    const record = f.record(0);
    mutate(record);
    assert.equal(f.collector.ingestDetectorLevel(record).accepted, false);
    const result = f.collector.finalize({ owner, sourceEndSample: 2 * hop });
    assert.equal(result.metrics.attacks.status, "failed");
    assert.equal(result.metrics.attacks.records.length, 0);
  });
}

test("current detector cancelled pass cannot admit late records or leak state into a fresh pass", () => {
  const f = fixture([0.1, 0.2]);
  assert.equal(f.collector.ingestDetectorLevel(f.record(0)).accepted, true);
  const cancelled = f.collector.cancel();
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.metrics.attacks.status, "partial");
  assert.equal(cancelled.metrics.attacks.records.length, 1);
  assert.equal(f.collector.ingestDetectorLevel(f.record(1)).accepted, false);
  assert.equal(f.collector.cancel(), cancelled);
  assert.deepEqual(
    fixture([0.1, 0.1])
      .finish()
      .metrics.attacks.summary.events.map(({ sample }) => sample),
    [4800],
  );
});
