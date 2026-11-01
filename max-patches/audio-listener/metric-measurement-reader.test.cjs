"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const measurements = require("./audio_listener_measurements.js");

function record(overrides = {}) {
  return {
    version: 1,
    kind: "native-musical-level/v1",
    epoch: 7,
    sequence: 1,
    startSample: 10_000,
    endSample: 15_625,
    values: [1, 0, 5_625, 5_625, 0.5, 0.25, 351.5625, 87.890625],
    ...overrides,
  };
}

function expectation(overrides = {}) {
  return {
    sequence: 1,
    startSample: 0,
    endSample: 5_625,
    sourceOriginCounter: 10_000,
    ...overrides,
  };
}

function declaration(family = "level", sampleRate = 48_000) {
  return measurements.createMetricDeclaration({ family, sampleRate });
}

function readback(value, { produced = 1, acknowledged = 0, fault = 0 } = {}) {
  return [
    1,
    value.epoch,
    value.sequence,
    value.epoch,
    value.sequence,
    value.startSample,
    value.endSample,
    produced,
    acknowledged,
    fault,
    ...value.values,
    value.sequence,
    value.epoch,
    value.sequence,
    value.epoch,
  ];
}

test("declares variable musical support separately from fixed detector cadence", () => {
  const level = declaration();
  assert.equal(level.version, 2);
  assert.equal(level.kind, "native-musical-level/v1");
  assert.equal(level.hopSamples, null);
  assert.equal(level.windowSamples, null);
  assert.equal(level.width, 8);
  assert.equal(level.capacity, 16);
  assert.equal(level.algorithmVersion, "3.0.0");
  assert.deepEqual(
    level.fields.map((field) => field.name),
    [
      "sequence",
      "startSample",
      "endSample",
      "count",
      "peakL",
      "peakR",
      "sumSquaresL",
      "sumSquaresR",
    ],
  );
  assert.equal(declaration("detector-level", 44_100).hopSamples, 4_410);
  assert.equal(declaration("detector-level").windowSamples, 4_800);
  assert.ok(Object.isFrozen(level));
  assert.ok(Object.isFrozen(level.fields[0]));
});

test("normalizes actual musical sample moments, not a split 100ms summary", () => {
  assert.deepEqual(
    measurements.normalizeMetricRecord(record(), declaration(), expectation()),
    {
      kind: "native-musical-level/v1",
      epoch: 7,
      sequence: 1,
      sourceOriginCounter: 10_000,
      startSample: 0,
      endSample: 5_625,
      count: 5_625,
      peak: [0.5, 0.25],
      rms: [0.25, 0.125],
      sumSquares: [351.5625, 87.890625],
    },
  );
});

test("permits explicitly unbound startup staging without fabricating a launch proof", () => {
  const result = measurements.normalizeMetricRecord(
    record(),
    declaration(),
    expectation({ sourceOriginCounter: null }),
  );
  assert.equal(result.sourceOriginCounter, 10_000);
  assert.equal(result.startSample, 0);
  assert.equal(result.endSample, 5_625);
});

test("keeps physical detector windows and clipped tails independent of musical rows", () => {
  const detector = record({
    kind: "native-detector-level/v1",
    sequence: 2,
    startSample: 14_800,
    endSample: 15_625,
    values: [2, 4_800, 5_625, 825, 0, 0, 0, 0],
  });
  const result = measurements.normalizeMetricRecord(
    detector,
    declaration("detector-level"),
    expectation({ sequence: 2, startSample: 4_800 }),
  );
  assert.deepEqual(result.rms, [0, 0]);
  assert.equal(result.count, 825);
  assert.equal(result.startSample, 4_800);
});

test("requires explicit new declarations and rejects forged layouts", () => {
  const good = declaration();
  for (const bad of [
    { ...good, version: 1 },
    { ...good, width: 16 },
    { ...good, capacity: 32 },
    { ...good, algorithmVersion: "2.0.0" },
    { ...good, hopSamples: 4_800 },
    { ...good, windowSamples: 4_800 },
    { ...good, kind: "native-envelope/v2" },
    { ...good, fields: [...good.fields].reverse() },
    {
      ...good,
      fields: good.fields.map((field, index) =>
        index === 6 ? { ...field, unit: "linear" } : field,
      ),
    },
  ]) {
    assert.throws(() => measurements.validateDeclaration(bad));
  }
  for (const input of [
    { family: "spectrum", sampleRate: 48_000 },
    { family: "level", sampleRate: 96_000 },
  ]) {
    assert.throws(() => measurements.createMetricDeclaration(input));
  }
});

test("rejects sequence, support, origin and impossible sample moments", () => {
  const good = record();
  const changes = [
    { sequence: 2 },
    { startSample: 10_001, endSample: 15_626 },
    { endSample: 15_626 },
    { values: [2, ...good.values.slice(1)] },
    { values: [1, 1, ...good.values.slice(2)] },
    { values: [1, 0, 5_624, ...good.values.slice(3)] },
    { values: [1, 0, 5_625, 5_624, ...good.values.slice(4)] },
    { values: [...good.values.slice(0, 4), 65, ...good.values.slice(5)] },
    { values: [...good.values.slice(0, 6), -1, 87.890625] },
    { values: [...good.values.slice(0, 6), 0.1, 87.890625] },
    { values: [...good.values.slice(0, 6), 1_407, 87.890625] },
    { values: [...good.values.slice(0, 4), 0, 0, 1e-12, 0] },
    { values: [...good.values.slice(0, 4), 1e-12, 0, 0, 0] },
    { values: [...good.values.slice(0, 6), Infinity, 87.890625] },
  ];
  for (const change of changes) {
    assert.throws(() =>
      measurements.normalizeMetricRecord(
        record(change),
        declaration(),
        expectation(),
      ),
    );
  }
});

test("preserves very quiet sample moments without an absolute silence tolerance", () => {
  const sum = 5_625 * 1e-24;
  const normalized = measurements.normalizeMetricRecord(
    record({ values: [1, 0, 5_625, 5_625, 1e-12, 0, sum, 0] }),
    declaration(),
    expectation(),
  );
  assert.equal(normalized.sumSquares[0], sum);
  assert.equal(normalized.rms[0], Math.sqrt(sum / 5_625));
  assert.ok(normalized.rms[0] > 0);
});

test("rejects over-budget row and capture-local support before numeric reduction", () => {
  for (const endSample of [36_002, 1_440_001]) {
    assert.throws(() =>
      measurements.normalizeMetricRecord(
        record({
          endSample: 10_000 + endSample,
          values: [1, 0, endSample, endSample, 0, 0, 0, 0],
        }),
        declaration(),
        expectation({ endSample }),
      ),
    );
  }
});

test("admits a record before ACK, and a failed family never blocks its peer", () => {
  let time = 0;
  const events = [];
  const accepted = [];
  const ownerContext = {
    generation: "00000000-0000-4000-8000-000000000001",
    passId: "pass",
    connectionEpoch: "00000000-0000-4000-8000-000000000002",
    traceId: "00000000-0000-4000-8000-000000000003",
    correlationId: "correlation",
    causationId: "causation",
  };
  const makeReader = (family) =>
    measurements.createReader({
      declaration: declaration(family),
      epoch: 7,
      ownerContext,
      now: () => time,
      onEvent: (event) => events.push(event),
      consume: (value) => {
        accepted.push(
          measurements.normalizeMetricRecord(
            value,
            declaration(family),
            expectation({
              endSample: family === "detector-level" ? 4_800 : 5_625,
            }),
          ),
        );
        return true;
      },
    });
  const level = makeReader("level");
  const detector = makeReader("detector-level");
  level.begin();
  detector.begin();
  assert.equal(level.poll(readback(record(), { fault: 1 })).status, "failed");
  const frame = readback(
    record({
      kind: "native-detector-level/v1",
      endSample: 14_800,
      values: [1, 0, 4_800, 4_800, 0.5, 0.25, 300, 75],
    }),
  );
  time = 10;
  assert.equal(detector.poll(frame).status, "settling");
  assert.deepEqual(accepted, []);
  time = 20;
  const result = detector.poll(frame);
  assert.equal(result.status, "accepted");
  assert.equal(accepted.length, 1);
  assert.deepEqual(result.actions, [
    { type: "request", sequence: 2 },
    { type: "acknowledge", sequence: 1 },
  ]);
  detector.complete();
  assert.equal(events.at(-1).stage, "completed");
  assert.equal(events.at(-1).ownerContext.traceId, ownerContext.traceId);
  assert.ok(events.at(-1).elapsedMs >= 20);
});

test("never acknowledges a rejected moment record or admits data after cancellation", () => {
  let admitted = 0;
  const reader = measurements.createReader({
    declaration: declaration(),
    epoch: 7,
    consume: (value) => {
      measurements.normalizeMetricRecord(value, declaration(), expectation());
      admitted++;
      return true;
    },
  });
  reader.begin();
  const invalid = readback(
    record({ values: [1, 0, 5_625, 5_625, 0, 0, 1, 0] }),
  );
  reader.poll(invalid);
  const result = reader.poll(invalid);
  assert.equal(result.status, "failed");
  assert.deepEqual(result.actions, []);
  assert.equal(admitted, 0);
  reader.cancel();
  assert.deepEqual(reader.poll(readback(record())).actions, []);
  assert.equal(admitted, 0);
});
