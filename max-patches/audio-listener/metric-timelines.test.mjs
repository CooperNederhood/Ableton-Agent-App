import "./native-protocol-test-loader.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import process from "node:process";
const require = createRequire(import.meta.url);
const {
  AudioListenerEngine,
  VERSION: LEGACY_VERSION,
} = require("./audio_listener_engine.js");
const [
  { createMetricListeningGeometry: createProtocolGeometry },
  { metricAudioObservationSchema, createMetricObservationReportRows },
  { DEFAULT_LISTENING_TIMING_POLICY, evaluateListeningAlignment },
] = await Promise.all([
  import("../../packages/protocol/src/metric-listening-geometry.ts"),
  import("../../packages/protocol/src/metric-observation-schemas.ts"),
  import("../../packages/protocol/src/listening-timing-schemas.ts"),
]);

const {
  createMetricTimelines,
  createMusicalGrid,
  createMetricListeningGeometry,
  adaptMetricTimelineObservation,
  METRIC_LIMITS,
} = require("./audio_listener_metric_timelines.js");

const OWNER = Object.freeze({
  generation: "00000000-0000-4000-8000-000000000007",
  nativeEpoch: 19,
  arm: "arm-123",
});
function envelope(overrides = {}) {
  const input = {
    owner: { ...OWNER },
    originSample: 0,
    originBeat: 0,
    sampleRate: 48000,
    tempo: 120,
    startBeat: 0,
    endBeat: 4,
    requestedMetrics: ["level", "spectrum"],
    traceId: "trace-123",
    correlationId: "correlation-123",
    causationId: "cause-123",
    ...overrides,
  };
  if (
    input.requestedMetrics.includes("attacks") &&
    !Object.hasOwn(overrides, "attacks")
  )
    input.attacks = {
      thresholdDb: 6,
      minSpacingSamples: Math.round(input.sampleRate / 10),
    };
  const samplesPerBeat = (input.sampleRate * 60) / input.tempo;
  const at = (beat) =>
    input.originSample + Math.round((beat - input.originBeat) * samplesPerBeat);
  const captureStartSample =
    overrides.captureStartSample ?? at(input.startBeat);
  return {
    ...input,
    captureStartSample,
    captureEndSample:
      overrides.captureEndSample ??
      captureStartSample +
        Math.round((input.endBeat - input.startBeat) * samplesPerBeat),
  };
}
function fixture(overrides = {}) {
  const input = envelope(overrides);
  const events = [];
  let elapsed = 100;
  const collector = createMetricTimelines(input, {
    now: () => elapsed++,
    onEvent: (event) => events.push(event),
  });
  return {
    collector,
    input,
    events,
    finish: () =>
      collector.finalize({
        owner: OWNER,
        sourceEndSample: input.captureEndSample,
      }),
  };
}
test("bounded application trace identifiers retain tool-call punctuation without losing attribution", () => {
  const trace = {
    traceId: "integration:owned_capture.1",
    correlationId: "correlation_1",
    causationId: "tool_call:measurement-1",
  };
  const f = fixture({ requestedMetrics: ["level"], ...trace });
  assert.ok(f.events.length > 0);
  for (const event of f.events)
    for (const [field, value] of Object.entries(trace))
      assert.equal(event[field], value);
  assert.doesNotThrow(() => fixture({ traceId: "a".repeat(128) }));
  assert.throws(
    () => fixture({ traceId: "a".repeat(129) }),
    /invalid_trace_identity/,
  );
});

function level(row, overrides = {}) {
  const count = row.endSample - row.startSample;
  return {
    owner: { ...OWNER },
    sequence: row.index + 1,
    startSample: row.startSample,
    endSample: row.endSample,
    peak: [0.5, 0.25],
    sumSquares: [count / 8, count / 32],
    count,
    ...overrides,
  };
}

test("unknown FFT phase cannot invent supports or block independently retained level records", () => {
  const f = fixture({ requestedMetrics: ["level", "spectrum"],
    spectrum: { firstEndSample: null } });
  for (const row of createMusicalGrid(f.input))
    assert.equal(f.collector.ingestLevel(level(row)).accepted, true);
  const result = f.finish();
  assert.equal(result.status, "partial");
  assert.equal(result.metrics.level.status, "completed");
  assert.equal(result.metrics.spectrum.status, "failed");
  assert.equal(result.metrics.spectrum.expectedRecords, 0);
  assert.equal(result.envelope.spectrum.firstEndSample, null);
  assert.deepEqual(result.metrics.spectrum.records, []);
  assert.deepEqual(result.metrics.spectrum.missing, []);
  assert.ok(result.rows.every(row => row.spectrum.availability === "unknown-phase"));
});
function spectrum(input, sequence, overrides = {}) {
  const declaration = input.spectrum ?? {};
  const endSample =
    (declaration.firstEndSample ?? input.captureStartSample + 2048) +
    (sequence - 1) * (declaration.hopSamples ?? 2048);
  return {
    owner: { ...OWNER },
    sequence,
    startSample: endSample - 2048,
    endSample,
    centroidHz: 1200,
    energy: 2,
    ...overrides,
  };
}
function feedLevel(f, overrides = {}) {
  for (const row of f.collector.grid)
    assert.equal(f.collector.ingestLevel(level(row, overrides)).accepted, true);
}
function feedSpectrum(f, overrides = {}) {
  for (let sequence = 1; ; sequence++) {
    const record = spectrum(f.input, sequence, overrides);
    if (record.endSample > f.input.captureEndSample) break;
    assert.equal(f.collector.ingestSpectrum(record).accepted, true);
  }
}

function detectorLevel(f, sequence, rms = [0.25, 0.125], overrides = {}) {
  const hop = Math.round(f.input.sampleRate / 10);
  const startSample = f.input.captureStartSample + (sequence - 1) * hop;
  const endSample = Math.min(startSample + hop, f.input.captureEndSample);
  const count = endSample - startSample;
  return {
    owner: { ...OWNER },
    sequence,
    startSample,
    endSample,
    count,
    peak: [...rms],
    sumSquares: rms.map((value) => value * value * count),
    ...overrides,
  };
}
function feedDetector(f, levels = []) {
  const expected = Math.ceil(
    (f.input.captureEndSample - f.input.captureStartSample) /
      Math.round(f.input.sampleRate / 10),
  );
  for (let sequence = 1; sequence <= expected; sequence++)
    assert.equal(
      f.collector.ingestDetectorLevel(
        detectorLevel(f, sequence, levels[sequence - 1] ?? [0, 0]),
      ).accepted,
      true,
    );
}
function attackReference(inputRecords, { thresholdDb, minSpacingSamples }) {
  let previous = -120;
  let lastAttack = -Infinity;
  let rising = false;
  return inputRecords.map((record) => {
    const rms = Object.hasOwn(record, "rms")
      ? record.rms
      : record.sumSquares.map((sum) => Math.sqrt(sum / record.count));
    const level = Math.max(
      ...rms.map((value) => (value <= 1e-6 ? -120 : 20 * Math.log10(value))),
    );
    const rise = level - previous;
    if (rise <= 0) rising = false;
    const events = [];
    if (
      !rising &&
      level > -120 &&
      rise > 0 &&
      rise >= thresholdDb &&
      record.endSample - lastAttack >= minSpacingSamples
    ) {
      events.push({ sample: record.endSample, strength: rise });
      rising = true;
      lastAttack = record.endSample;
    }
    previous = level;
    return events;
  });
}

test("production collector loads with ordinary CommonJS require and executes detector ingestion without any loader", () => {
  const modulePath = require.resolve("./audio_listener_metric_timelines.js");
  const input = envelope({
    requestedMetrics: ["attacks"],
    endBeat: 0.2,
    originSample: 65536,
    captureStartSample: 65536,
  });
  const child = spawnSync(
    process.execPath,
    [
      "-e",
      `
    const assert = require("node:assert/strict");
    const api = require(process.argv[1]);
    assert.deepEqual(Object.keys(api).sort(), [
      "METRIC_LIMITS", "adaptMetricTimelineObservation", "createMetricListeningGeometry",
      "createMetricTimelines", "createMusicalGrid",
    ].sort());
    const input = JSON.parse(process.argv[2]);
    const collector = api.createMetricTimelines(input);
    const record = {
      owner: input.owner, sequence: 1,
      startSample: input.captureStartSample, endSample: input.captureEndSample,
      count: 4800, peak: [0.5, 0.5], rms: [0.5, 0.5],
    };
    assert.equal(collector.ingestDetectorLevel(record).accepted, true);
    const result = collector.finalize({owner: input.owner, sourceEndSample: input.captureEndSample});
    assert.equal(result.status, "completed");
    assert.equal(result.metrics.attacks.records[0].events[0].sample, input.captureEndSample);
    process.stdout.write("commonjs-production-ok");
  `,
      modulePath,
      JSON.stringify(input),
    ],
    {
      encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: "" },
      timeout: 10000,
      maxBuffer: 64 * 1024,
    },
  );
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, "commonjs-production-ok");
});

test("independent concurrent families finish without a cross-metric matching queue", () => {
  const f = fixture();
  for (const row of f.collector.grid.slice(0, 10))
    assert.equal(f.collector.ingestLevel(level(row)).accepted, true);
  assert.equal(f.collector.progress().metrics.level.acceptedRecords, 10);
  assert.equal(f.collector.progress().metrics.spectrum.acceptedRecords, 0);
  feedSpectrum(f);
  for (const row of f.collector.grid.slice(10))
    f.collector.ingestLevel(level(row));
  const result = f.finish();
  assert.equal(result.status, "completed");
  assert.equal(result.metrics.level.summary.count, 96000);
  assert.deepEqual(result.metrics.level.summary.peak, [0.5, 0.25]);
  assert.equal(result.metrics.level.summary.rms[0], Math.sqrt(1 / 8));
  assert.equal(result.metrics.spectrum.summary.centroidHz, 1200);
  assert.equal(result.rows.length, 16);
  assert.equal(
    result.rows.filter((row) => row.level.availability === "available").length,
    16,
  );
  assert.equal(
    result.rows.reduce((sum, row) => sum + row.spectrum.frameCount, 0),
    result.metrics.spectrum.acceptedRecords,
  );
  assert.deepEqual(result.metrics.level.missing, []);
  assert.deepEqual(result.metrics.spectrum.missing, []);
});

test("stalled spectrum leaves level eager and progressing for more than eight windows", () => {
  const f = fixture();
  f.collector.observeState("spectrum", {
    owner: OWNER,
    state: "stalled",
    sequence: 999,
    energy: 999,
  });
  f.collector.failMetric("spectrum", "stalled");
  feedLevel(f);
  assert.equal(f.collector.progress().metrics.level.acceptedRecords, 16);
  const result = f.finish();
  assert.equal(result.status, "partial");
  assert.equal(result.metrics.level.status, "completed");
  assert.equal(result.metrics.spectrum.status, "failed");
  assert.equal(result.metrics.spectrum.reason, "stalled");
  assert.equal(result.metrics.spectrum.acceptedRecords, 0);
  assert(
    f.events.filter(
      (event) => event.metricId === "level" && event.stage === "progress",
    ).length > 8,
  );
});

test("control snapshots are separate from admissible records and cannot manufacture silence", () => {
  const f = fixture();
  f.collector.observeState("level", {
    owner: OWNER,
    state: "collecting",
    ...level(f.collector.grid[0]),
  });
  f.collector.observeState("spectrum", { owner: OWNER, state: "ready" });
  const result = f.finish();
  assert.equal(result.status, "failed");
  assert.equal(result.metrics.level.acceptedRecords, 0);
  assert.equal(result.metrics.level.summary, null);
  assert.equal(result.metrics.spectrum.summary, null);
  assert.equal(result.metrics.level.snapshot.state, "collecting");
  assert.deepEqual(Object.keys(result.metrics.level.snapshot), [
    "state",
    "receivedMs",
  ]);
  assert.deepEqual(result.rows, []);
});

test("sequence gaps and tails have explicit local missing intervals; no forward-fill", () => {
  const f = fixture();
  f.collector.ingestLevel(level(f.collector.grid[0]));
  f.collector.ingestLevel(level(f.collector.grid[2]));
  f.collector.ingestSpectrum(spectrum(f.input, 1));
  f.collector.ingestSpectrum(spectrum(f.input, 3));
  const result = f.finish();
  assert.equal(result.status, "partial");
  assert.deepEqual(result.metrics.level.missing[0], {
    firstSequence: 2,
    lastSequence: 2,
    startSample: 6000,
    endSample: 12000,
    reason: "sequence_gap",
  });
  assert.equal(result.metrics.level.missing[1].reason, "missing_records");
  assert.equal(result.metrics.spectrum.missing[0].reason, "sequence_gap");
  assert.equal(result.rows[1].level.availability, "missing");
  assert.equal(result.rows[2].spectrum.availability, "missing");
  assert.equal(result.rows[2].spectrum.centroidHz, null);
  assert.equal(result.rows[2].spectrum.frameCount, 0);
});

test("a late out-of-order missing record terminates only its family, preserving the prefix", () => {
  const f = fixture();
  f.collector.ingestLevel(level(f.collector.grid[2]));
  assert.equal(
    f.collector.ingestLevel(level(f.collector.grid[1])).reason,
    "sequence_regression",
  );
  assert.equal(
    f.collector.ingestLevel(level(f.collector.grid[3])).reason,
    "metric_terminal",
  );
  feedSpectrum(f);
  const result = f.finish();
  assert.equal(result.status, "partial");
  assert.equal(result.metrics.level.acceptedRecords, 1);
  assert.equal(result.metrics.spectrum.status, "completed");
});

test("malformed level does not destroy complete spectrum; old 100ms RMS is never split", () => {
  const f = fixture();
  const legacy = level(f.collector.grid[0], {
    endSample: 4800,
    count: 4800,
    sumSquares: [600, 150],
  });
  assert.equal(f.collector.ingestLevel(legacy).reason, "support_mismatch");
  feedSpectrum(f);
  const result = f.finish();
  assert.equal(result.status, "partial");
  assert.equal(result.metrics.level.usable, false);
  assert.equal(result.metrics.spectrum.status, "completed");
  assert.equal(result.metrics.spectrum.summary.centroidHz, 1200);
});

test("2048-sample support and declared FFT hop/phase are enforced locally", () => {
  for (const overrides of [
    { startSample: 1 },
    { endSample: 2049, startSample: 1 },
    { centroidHz: 24001 },
    { energy: -1 },
    { energy: 0, centroidHz: 0 },
  ]) {
    const f = fixture();
    assert.equal(
      f.collector.ingestSpectrum(spectrum(f.input, 1, overrides)).accepted,
      false,
    );
    feedLevel(f);
    const result = f.finish();
    assert.equal(result.status, "partial");
    assert.equal(result.metrics.level.status, "completed");
    assert.equal(result.metrics.spectrum.status, "failed");
  }
});

test("zero levels and zero-energy FFT frames are available silence, not missing data", () => {
  const f = fixture();
  feedLevel(f, { peak: [0, 0], sumSquares: [0, 0] });
  feedSpectrum(f, { energy: 0, centroidHz: null });
  const result = f.finish();
  assert.equal(result.status, "completed");
  assert.deepEqual(result.metrics.level.summary.rms, [0, 0]);
  assert.equal(result.metrics.spectrum.summary.centroidHz, null);
  assert.equal(result.metrics.spectrum.summary.energy, 0);
  assert(result.rows.every((row) => row.level.availability === "available"));
  assert(result.rows.every((row) => row.spectrum.availability === "available"));
});

test("exact interval RMS converts to sums of squares; inconsistent count/peak aggregates fail", () => {
  const f = fixture({ requestedMetrics: ["level"] });
  for (const row of f.collector.grid) {
    const record = level(row);
    delete record.sumSquares;
    record.rms = [0.25, 0.125];
    assert.equal(f.collector.ingestLevel(record).accepted, true);
  }
  const result = f.finish();
  assert.deepEqual(result.metrics.level.summary.rms, [0.25, 0.125]);
  assert.equal(result.metrics.level.summary.count, 96000);
  for (const overrides of [
    { count: 5999 },
    { sumSquares: [-1, 0] },
    { sumSquares: [6001, 0] },
    { peak: [1, 1], sumSquares: [0, 0] },
    { rms: [0.1, 0.1] },
    { count: 0 },
    { peak: [Infinity, 0] },
  ]) {
    const invalid = fixture({ requestedMetrics: ["level"] });
    assert.equal(
      invalid.collector.ingestLevel(level(invalid.collector.grid[0], overrides))
        .accepted,
      false,
    );
    assert.equal(invalid.finish().status, "failed");
  }
});

test("unequal clipped rows use exact linear square/count weighting, not RMS/dB or peak averages", () => {
  const f = fixture({
    startBeat: 0.13,
    endBeat: 0.5,
    requestedMetrics: ["level"],
  });
  const amplitudes = [
    [0.5, 0],
    [0.125, 0.25],
  ];
  for (const [index, row] of f.collector.grid.entries()) {
    const record = level(row, {
      peak: amplitudes[index],
      rms: amplitudes[index],
    });
    delete record.sumSquares;
    assert.equal(f.collector.ingestLevel(record).accepted, true);
  }
  const result = f.finish();
  const summary = result.metrics.level.summary;
  assert.equal(result.status, "completed");
  assert.equal(summary.count, 8880);
  assert.deepEqual(summary.sumSquares, [813.75, 375]);
  assert.deepEqual(summary.peak, [0.5, 0.25]);
  assert.deepEqual(summary.rms, [
    Math.sqrt(813.75 / 8880),
    Math.sqrt(375 / 8880),
  ]);
  assert.notEqual(summary.rms[0], (0.5 + 0.125) / 2);
  assert.notEqual(summary.rms[0], Math.sqrt(0.5 * 0.125));
  assert.notEqual(summary.peak[0], (0.5 + 0.125) / 2);
  const db = fixture({ requestedMetrics: ["level"] });
  const record = level(db.collector.grid[0]);
  delete record.sumSquares;
  record.rmsDb = [-6, -12];
  assert.equal(db.collector.ingestLevel(record).reason, "malformed_record");
  assert.equal(db.finish().status, "failed");
});

test("same record holds are exactly once and copied; subsequent mutation cannot rewrite evidence", () => {
  const f = fixture();
  const record = level(f.collector.grid[0]);
  f.collector.ingestLevel(record);
  for (let hold = 0; hold < 100; hold++)
    assert.deepEqual(f.collector.ingestLevel(record), {
      accepted: false,
      duplicate: true,
      reason: "duplicate",
    });
  record.sumSquares[0] = 1000;
  assert.equal(f.collector.ingestLevel(record).reason, "duplicate_mutation");
  feedSpectrum(f);
  const result = f.finish();
  assert.equal(result.metrics.level.acceptedRecords, 1);
  assert.equal(result.metrics.level.duplicates, 100);
  assert.equal(result.metrics.level.records[0].sumSquares[0], 750);
  assert.equal(result.metrics.level.reason, "duplicate_mutation");
  assert.throws(() => result.metrics.level.records[0].peak.push(1), TypeError);
});

test("FFT duplicate mutation fails only spectrum; changed representation is not an immutable level hold", () => {
  const f = fixture();
  const frame = spectrum(f.input, 1);
  f.collector.ingestSpectrum(frame);
  assert.equal(f.collector.ingestSpectrum({ ...frame }).duplicate, true);
  frame.centroidHz = 1600;
  assert.equal(f.collector.ingestSpectrum(frame).reason, "duplicate_mutation");
  feedLevel(f);
  assert.equal(f.finish().metrics.level.status, "completed");
  const other = fixture({ requestedMetrics: ["level"] });
  const record = level(other.collector.grid[0]);
  other.collector.ingestLevel(record);
  record.rms = record.sumSquares.map((sum) => Math.sqrt(sum / record.count));
  delete record.sumSquares;
  assert.equal(
    other.collector.ingestLevel(record).reason,
    "duplicate_mutation",
  );
});

test("active owner/epoch/arm corruption is shared fatal, not an optional analyzer failure", () => {
  for (const corruptOwner of [
    { ...OWNER, generation: 8 },
    { ...OWNER, nativeEpoch: 20 },
    { ...OWNER, arm: "another-arm" },
  ]) {
    const f = fixture();
    feedLevel(f);
    assert.equal(
      f.collector.ingestSpectrum(spectrum(f.input, 1, { owner: corruptOwner }))
        .reason,
      "owner_corruption",
    );
    const result = f.finish();
    assert.equal(result.status, "failed");
    assert.equal(result.reason, "owner_corruption");
    assert.deepEqual(result.rows, []);
    assert.equal(f.events.at(-1).stage, "failed");
    assert.equal(
      f.collector.ingestLevel(level(f.collector.grid[0])).reason,
      "sealed",
    );
  }
});

test("clock/source corruption and incomplete source proof cannot be salvaged as partial", () => {
  for (const overrides of [
    { sampleRate: 44100 },
    { tempo: 121 },
    { originSample: 1 },
    { sourceSample: Number.MAX_SAFE_INTEGER + 1 },
    { originBeat: 0.25 },
    { sourceSample: -1 },
    { sourceSample: 0.5 },
  ]) {
    const f = fixture();
    feedLevel(f);
    f.collector.observeClock({
      owner: OWNER,
      sampleRate: 48000,
      tempo: 120,
      originSample: 0,
      originBeat: 0,
      sourceSample: 100,
      ...overrides,
    });
    assert.equal(f.finish().reason, "clock_corruption");
  }
  const f = fixture();
  const clock = {
    owner: OWNER,
    sampleRate: 48000,
    tempo: 120,
    originSample: 0,
    originBeat: 0,
    sourceSample: 100,
  };
  assert.equal(f.collector.observeClock(clock).measurement, false);
  f.collector.observeClock({ ...clock, sourceSample: 99 });
  assert.equal(f.finish().status, "failed");
  const incomplete = fixture();
  feedLevel(incomplete);
  assert.equal(
    incomplete.collector.finalize({ owner: OWNER, sourceEndSample: 95999 })
      .status,
    "failed",
  );
  const timeout = fixture();
  feedLevel(timeout);
  assert.equal(timeout.collector.failShared("global_timeout").status, "failed");
  const draining = fixture();
  feedLevel(draining);
  assert.equal(
    draining.collector.observeClock({ ...clock, sourceSample: 96064 }).accepted,
    true,
  );
  assert.equal(draining.finish().status, "partial");
});

test("finalization/cancellation are sealed, immutable, idempotent and reject all late/foreign input", () => {
  for (const cancel of [true, false]) {
    const f = fixture();
    feedLevel(f);
    const result = cancel ? f.collector.cancel() : f.finish();
    const serialized = JSON.stringify(result);
    const eventCount = f.events.length;
    assert.equal(f.collector.cancel(), result);
    assert.equal(f.finish(), result);
    assert.equal(f.collector.failShared("global_timeout"), result);
    assert.equal(
      f.collector.ingestSpectrum(spectrum(f.input, 1, { owner: {} })).reason,
      "sealed",
    );
    assert.equal(
      f.collector.observeState("level", { owner: {}, state: "ready" }).reason,
      "sealed",
    );
    assert.equal(f.collector.observeClock({ owner: {} }).reason, "sealed");
    assert.equal(f.collector.failMetric("level", "stalled").reason, "sealed");
    assert.equal(JSON.stringify(result), serialized);
    assert.equal(f.events.length, eventCount);
    assert(Object.isFrozen(result));
    assert(Object.isFrozen(result.envelope.owner));
    assert.equal(result.status, cancel ? "cancelled" : "partial");
    if (cancel) assert.deepEqual(result.rows, []);
  }
});

test("envelope, records and snapshots are isolated from caller mutation", () => {
  const f = fixture();
  const raw = level(f.collector.grid[0]);
  f.collector.ingestLevel(raw);
  const state = { owner: { ...OWNER }, state: "ready" };
  f.collector.observeState("spectrum", state);
  f.input.owner.arm = "changed";
  f.input.sampleRate = 44100;
  f.input.requestedMetrics.length = 0;
  raw.peak[0] = 9;
  state.state = "unavailable";
  const result = f.finish();
  assert.equal(result.envelope.owner.arm, OWNER.arm);
  assert.equal(result.envelope.sampleRate, 48000);
  assert.deepEqual(result.envelope.requestedMetrics, ["level", "spectrum"]);
  assert.equal(result.metrics.level.records[0].peak[0], 0.5);
  assert.equal(result.metrics.spectrum.snapshot.state, "ready");
});

test("FFT projection uses half-open endpoints, the capture-end exception and distinct energy weights", () => {
  const f = fixture({
    originSample: 1000,
    endBeat: 0.5,
    spectrum: { supportSamples: 2048, hopSamples: 2000, firstEndSample: 3000 },
  });
  feedLevel(f);
  for (let sequence = 1; sequence <= 6; sequence++)
    assert.equal(
      f.collector.ingestSpectrum(
        spectrum(f.input, sequence, {
          centroidHz: sequence === 1 ? 100 : sequence === 2 ? 300 : 1000,
          energy: sequence === 1 ? 1 : sequence === 2 ? 3 : 2,
        }),
      ).accepted,
      true,
    );
  const result = f.finish();
  assert.equal(result.status, "completed");
  assert.equal(result.rows[0].spectrum.frameCount, 2);
  assert.equal(result.rows[0].spectrum.centroidHz, 250);
  assert.equal(result.rows[1].spectrum.frameCount, 4);
  assert.equal(result.rows[1].spectrum.centroidHz, 1000);
  assert.equal(result.rows[1].spectrum.supports[0].sequence, 3);
  assert.equal(result.rows[1].spectrum.supports[0].endSample, 7000);
  assert.equal(result.rows[1].spectrum.supports[0].crossesRowBoundary, true);
  assert.equal(
    result.rows[0].spectrum.supports[0].crossesCaptureBoundary,
    true,
  );
  assert.equal(result.rows[1].spectrum.supports.at(-1).endSample, 13000);
  assert.equal(result.rows[0].spectrum.wholeRowMeasurement, false);
  assert.equal(result.metrics.spectrum.summary.frameCount, 6);
  assert.equal(result.metrics.spectrum.summary.energy, 12);
  assert(Math.abs(result.metrics.spectrum.summary.centroidHz - 750) < 1e-10);
  assert.equal(result.metrics.spectrum.coverage[0].startSample, 952);
});

test("legitimate no-frame rows are not missing analyzer output or fabricated zeroes", () => {
  const f = fixture({ tempo: 999, endBeat: 0.5 });
  feedLevel(f);
  const result = f.finish();
  assert.equal(result.status, "completed");
  assert.equal(result.metrics.spectrum.status, "completed");
  assert.equal(result.metrics.spectrum.expectedRecords, 0);
  assert.equal(result.metrics.spectrum.usable, false);
  assert.equal(result.metrics.spectrum.summary, null);
  assert(result.rows.every((row) => row.spectrum.availability === "no-frame"));
  const spectralOnly = fixture({
    tempo: 999,
    endBeat: 0.5,
    requestedMetrics: ["spectrum"],
  });
  assert.equal(spectralOnly.finish().status, "failed");
  assert.equal(spectralOnly.finish().metrics.spectrum.status, "completed");
});

test("no metric is mandatory and missing detector input is explicit, never an invented empty list", () => {
  const spectralOnly = fixture({ requestedMetrics: ["spectrum"] });
  feedSpectrum(spectralOnly);
  const result = spectralOnly.finish();
  assert.equal(result.status, "completed");
  assert.equal(result.rows[0].level.availability, "not-requested");
  const withAttacks = fixture({ requestedMetrics: ["level", "attacks"] });
  feedLevel(withAttacks, { peak: [0, 0], sumSquares: [0, 0] });
  const partial = withAttacks.finish();
  assert.equal(partial.status, "partial");
  assert.deepEqual(partial.metrics.attacks.dependencies, [
    "independent-100ms-level-windows",
  ]);
  assert.equal(partial.metrics.attacks.reason, "missing_records");
  assert.equal(partial.metrics.attacks.summary, null);
  assert.equal(partial.metrics.attacks.usable, false);
  assert.notDeepEqual(partial.metrics.attacks.summary, []);
});

test("musical grid is absolute, fractional/clipped, capture-relative and exact at every supported rate", () => {
  for (const sampleRate of [44100, 48000]) {
    const input = envelope({
      sampleRate,
      tempo: 123.45,
      originSample: 100000,
      originBeat: 8,
      startBeat: 8.13,
      endBeat: 12.62,
    });
    const rows = createMusicalGrid(input);
    assert.equal(rows[0].startBeat, 8.13);
    assert.equal(rows[0].endBeat, 8.25);
    assert.equal(rows.at(-1).startBeat, 12.5);
    assert.equal(rows.at(-1).endBeat, 12.62);
    assert.equal(rows[0].clippedStart, true);
    assert.equal(rows.at(-1).clippedEnd, true);
    assert.equal(rows.at(-1).endSample, input.captureEndSample);
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      assert.equal(
        row.startSample,
        input.captureStartSample +
          Math.round(
            (row.startBeat - input.startBeat) *
              ((sampleRate * 60) / input.tempo),
          ),
      );
      if (index > 0) assert.equal(rows[index - 1].endSample, row.startSample);
    }
    const fullLengths = rows
      .slice(1, -1)
      .map((row) => row.endSample - row.startSample);
    assert.equal(new Set(fullLengths).size, 2);
  }
  const at128 = createMusicalGrid(envelope({ tempo: 128 }));
  assert(at128.every((row) => row.endSample - row.startSample === 5625));
  assert.throws(
    () =>
      createMusicalGrid(
        envelope({ originSample: 100000, startBeat: -0.13, endBeat: 0.13 }),
      ),
    /invalid_capture_envelope/,
  );
});

test("duration/report/metric quotas are admitted before collection, with bounded runtime overflow", () => {
  assert.throws(() => fixture({ endBeat: 61 }), /capture_duration_exceeded/);
  assert.throws(() => fixture({ maxReportRows: 15 }), /report_quota_exceeded/);
  assert.throws(
    () => fixture({ maxRecords: { level: 15 } }),
    /metric_quota_exceeded/,
  );
  assert.throws(
    () => fixture({ spectrum: { hopSamples: 1 }, endBeat: 4 }),
    /metric_quota_exceeded/,
  );
  assert.throws(
    () =>
      fixture({ maxRecords: { spectrum: METRIC_LIMITS.recordsPerMetric + 1 } }),
    /invalid_budget/,
  );
  const f = fixture({ requestedMetrics: ["level"] });
  feedLevel(f);
  assert.equal(
    f.collector.ingestLevel(level(f.collector.grid[15], { sequence: 17 }))
      .reason,
    "quota_overflow",
  );
  const result = f.finish();
  assert.equal(result.status, "partial");
  assert.equal(result.metrics.level.acceptedRecords, 16);
  assert.equal(result.metrics.level.reason, "quota_overflow");
});

test("30 seconds at 999 BPM derives about 2000 rows, not a 300-row or 8-window ceiling", () => {
  const f = fixture({
    sampleRate: 48000,
    tempo: 999,
    endBeat: 499.5,
    requestedMetrics: ["level"],
  });
  assert.equal(f.collector.grid.length, 1998);
  feedLevel(f);
  const result = f.finish();
  assert.equal(result.status, "completed");
  assert.equal(result.metrics.level.summary.count, 1440000);
  assert.equal(result.rows.at(-1).endSample, 1440000);
  assert.equal(result.budgets.maxRecords.level, 1998);
  const progress = f.events.filter((event) => event.stage === "progress");
  assert(progress.length <= METRIC_LIMITS.progressEventsPerMetric);
  assert(progress.length > 1);
});

test("lifecycle ordering, trace attribution, bounded timing and payloads cover partial/failure/cancellation", () => {
  for (const status of ["completed", "partial", "failed", "cancelled"]) {
    const f = fixture();
    if (status !== "failed") feedLevel(f);
    if (status === "completed") feedSpectrum(f);
    const result = status === "cancelled" ? f.collector.cancel() : f.finish();
    assert.equal(result.status, status);
    assert.equal(f.events[0].stage, "queued");
    assert.equal(f.events[1].stage, "started");
    assert.deepEqual(
      f.events
        .filter((event) => event.metricId === "assembly")
        .map((event) => event.stage),
      ["queued", "started", status],
    );
    assert.equal(f.events.at(-1).stage, status);
    for (let index = 0; index < f.events.length; index++) {
      const event = f.events[index];
      assert.equal(event.traceId, "trace-123");
      assert.equal(event.correlationId, "correlation-123");
      assert.equal(event.causationId, "cause-123");
      assert.equal(event.generation, OWNER.generation);
      assert.equal(event.nativeEpoch, OWNER.nativeEpoch);
      assert(Object.isFrozen(event));
      assert(event.elapsedMs >= 0);
      if (index > 0) assert(event.elapsedMs >= f.events[index - 1].elapsedMs);
      assert(JSON.stringify(event).length < 512);
      for (const forbidden of [
        "peak",
        "sumSquares",
        "centroidHz",
        "rms",
        "audio",
        "owner",
        "arm",
        "records",
      ])
        assert.equal(Object.hasOwn(event, forbidden), false);
    }
    for (const metric of ["level", "spectrum"]) {
      const events = f.events.filter((event) => event.metricId === metric);
      assert.equal(events[0].stage, "queued");
      assert.equal(events[1].stage, "started");
      assert.equal(
        events.filter((event) =>
          ["completed", "partial", "failed", "cancelled"].includes(event.stage),
        ).length,
        1,
      );
    }
  }
});

test("guard failures are explicit and callbacks do not silently catch infrastructure errors", () => {
  assert.throws(
    () => fixture({ requestedMetrics: [] }),
    /invalid_requested_metrics/,
  );
  assert.throws(
    () => fixture({ requestedMetrics: ["level", "level"] }),
    /invalid_requested_metrics/,
  );
  assert.throws(
    () => fixture({ sampleRate: 22050 }),
    /invalid_capture_envelope/,
  );
  assert.throws(
    () => fixture({ captureEndSample: 96001 }),
    /capture_endpoint_mismatch/,
  );
  assert.throws(
    () => fixture({ spectrum: { supportSamples: 1024 } }),
    /invalid_spectrum_declaration/,
  );
  assert.throws(
    () => fixture({ spectrum: { firstEndSample: 6000 } }),
    /invalid_spectrum_declaration/,
  );
  assert.throws(
    () => fixture({ traceId: "Bearer credential-do-not-persist" }),
    /invalid_trace_identity/,
  );
  const f = fixture({ requestedMetrics: ["level"] });
  assert.throws(
    () => f.collector.ingestSpectrum(spectrum(f.input, 1)),
    /metric_not_requested/,
  );
  assert.throws(
    () => f.collector.failMetric("level", "user-supplied-secret"),
    /invalid_metric_failure_reason/,
  );
  assert.throws(
    () => f.collector.failShared("optional-analyzer-broke"),
    /invalid_shared_failure_reason/,
  );
  assert.throws(
    () =>
      f.collector.observeState("level", {
        owner: OWNER,
        state: "arbitrary-secret",
      }),
    /invalid_metric_state/,
  );
  assert.throws(
    () =>
      createMetricTimelines(envelope(), {
        onEvent: () => {
          throw new Error("sink_failed");
        },
      }),
    /sink_failed/,
  );
  assert.throws(
    () => createMetricTimelines(envelope(), { now: () => NaN }),
    /invalid_receipt_clock/,
  );
  let ticks = 0;
  assert.throws(
    () =>
      createMetricTimelines(envelope(), {
        now: () => (ticks++ === 0 ? 1 : 0),
      }),
    /invalid_receipt_clock/,
  );
  ticks = 0;
  assert.throws(
    () =>
      createMetricTimelines(envelope(), {
        now: () => (ticks++ === 0 ? 0 : Number.MAX_VALUE),
      }),
    /invalid_receipt_clock/,
  );
});

test("native JS generation UUID, native epoch and arm identity are validated without counter coercion", () => {
  for (const owner of [
    { ...OWNER, generation: 7 },
    { ...OWNER, generation: "7" },
    { ...OWNER, generation: "not-a-native-js-generation" },
    { ...OWNER, nativeEpoch: 0 },
    { ...OWNER, nativeEpoch: 1000001 },
    { ...OWNER, nativeEpoch: 19.5 },
    { ...OWNER, arm: -1 },
    { ...OWNER, arm: 2 ** 44 },
  ]) {
    assert.throws(() => fixture({ owner }), /invalid_owner/);
  }
  const nativeOwner = { ...OWNER, arm: 4096 };
  const input = envelope({ owner: nativeOwner, requestedMetrics: ["level"] });
  const collector = createMetricTimelines(input);
  assert.deepEqual(collector.envelope.owner, nativeOwner);
  for (const row of collector.grid)
    assert.equal(
      collector.ingestLevel(level(row, { owner: nativeOwner })).accepted,
      true,
    );
  assert.equal(
    collector.finalize({
      owner: nativeOwner,
      sourceEndSample: input.captureEndSample,
    }).status,
    "completed",
  );
  const strict = fixture();
  assert.equal(
    strict.collector.ingestLevel(
      level(strict.collector.grid[0], {
        owner: { ...OWNER, nativeEpoch: "19" },
      }),
    ).reason,
    "owner_corruption",
  );
  assert.equal(strict.finish().status, "failed");
});

test("explicit malformed Gen/configuration/callback options are rejected, never silently defaulted", () => {
  for (const changes of [
    { vectorSize: null },
    { maxReportRows: null },
    { maxRecords: null },
    { maxRecords: [] },
    { maxRecords: { level: null } },
    { maxRecords: { unknown: 1 } },
    { spectrum: null },
    { spectrum: [] },
    { spectrum: { supportSamples: null } },
    { spectrum: { hopSamples: null } },
    { spectrum: { unexpectedGenOption: 1 } },
  ])
    assert.throws(() => fixture(changes));
  for (const options of [
    null,
    [],
    { now: null },
    { onEvent: null },
    { now: 1 },
    { onEvent: 1 },
    { silentLoggingFallback: true },
  ])
    assert.throws(() => createMetricTimelines(envelope(), options));
  assert.throws(
    () =>
      fixture({
        requestedMetrics: ["level"],
        maxRecords: { spectrum: 4 },
      }),
    /invalid_budget/,
  );
});

test("finalization seals admission before delivering assembly callbacks", () => {
  const input = envelope();
  let collector;
  let attempted = false;
  collector = createMetricTimelines(input, {
    onEvent(event) {
      if (event.metricId !== "assembly" || event.stage !== "queued") return;
      attempted = true;
      assert.equal(
        collector.ingestLevel(level(collector.grid[0])).reason,
        "sealed",
      );
      assert.throws(() => collector.cancel(), /reentrant_finalization/);
    },
  });
  const result = collector.finalize({
    owner: OWNER,
    sourceEndSample: input.captureEndSample,
  });
  assert.equal(attempted, true);
  assert.equal(result.status, "failed");
  assert.equal(result.metrics.level.acceptedRecords, 0);
});

test("JS geometry exactly conforms to canonical protocol arithmetic, rows and budgets", () => {
  for (const sampleRate of [44100, 48000]) {
    for (const tempoBpm of [20, 123.45, 128, 999]) {
      for (const startBeat of [0, 0.13, 1576200.13]) {
        for (const durationSeconds of [0.037, 3.14159, 30]) {
          const input = {
            sampleRate,
            vectorSize: 64,
            tempoBpm,
            startBeat,
            endBeat: startBeat + (durationSeconds * tempoBpm) / 60,
            startSample: 17592180000000,
          };
          const actual = createMetricListeningGeometry(input);
          assert.deepEqual(actual, createProtocolGeometry(input));
          assert.equal(actual.endSample, actual.rows.at(-1).endSample);
          assert.equal(actual.budgets.levelRecords, actual.rows.length);
          assert(actual.rows.length <= 2000);
          assert(actual.budgets.spectrumRecords <= 706);
          assert(actual.budgets.attackDetectorWindows <= 300);
          assert(Object.isFrozen(actual));
          assert(Object.isFrozen(actual.budgets));
        }
      }
    }
  }
});

test("canonical geometry support guards reject the same unsupported request operands", () => {
  const valid = {
    sampleRate: 48000,
    vectorSize: 64,
    tempoBpm: 120,
    startBeat: 0.13,
    endBeat: 4.62,
    startSample: 12345,
  };
  for (const changes of [
    { sampleRate: 96000 },
    { sampleRate: 88200 },
    { tempoBpm: 19.99 },
    { tempoBpm: 1000 },
    { vectorSize: 3 },
    { vectorSize: 2048 },
    { startBeat: -0.13 },
    { endBeat: 1576801 },
    { endBeat: valid.startBeat },
    { endBeat: 1000 },
    { startSample: 2 ** 44 - 1 },
    { startSample: -1 },
    { startSample: 0.5 },
    { unknownField: 1 },
  ]) {
    const input = { ...valid, ...changes };
    assert.throws(() => createMetricListeningGeometry(input));
    assert.throws(() => createProtocolGeometry(input));
  }
  const f = fixture({
    startBeat: valid.startBeat,
    endBeat: valid.endBeat,
    captureStartSample: valid.startSample,
  });
  const canonical = createProtocolGeometry(valid);
  assert.deepEqual(
    f.collector.grid.map(({ startBeat, endBeat, startSample, endSample }) => ({
      startBeat,
      endBeat,
      startSample,
      endSample,
    })),
    canonical.rows,
  );
  assert.equal(f.input.captureEndSample, canonical.endSample);
  // Frozen transport origin does not silently rephase or re-round this capture.
  assert.equal(f.collector.grid[0].startSample, valid.startSample);
  const result = f.finish();
  for (const key of [
    "levelRecords",
    "spectrumRecords",
    "attackDetectorWindows",
  ])
    assert.equal(result.budgets[key], canonical.budgets[key]);
  assert.equal(
    result.budgets.maxRecords.spectrum,
    canonical.budgets.spectrumRecords,
  );
});

const PUBLIC_UUID = "00000000-0000-4000-8000-000000000001";
function adapterFixture(overrides = {}) {
  const admitted = envelope({
    traceId: PUBLIC_UUID,
    ...overrides,
  });
  return fixture({ ...admitted, originSample: admitted.captureStartSample });
}
function adapterContext(f) {
  return {
    collectorOwner: { ...OWNER },
    ownership: {
      listenerId: "listener",
      passId: "pass",
      connectionId: PUBLIC_UUID,
      connectionEpoch: PUBLIC_UUID,
      generation: f.input.owner.generation,
      nativeEpoch: OWNER.nativeEpoch,
      traceId: f.input.traceId,
      correlationId: f.input.correlationId,
      causationId: f.input.causationId,
    },
    sharedIntegrity: "validated",
    source: {
      view: "arrangement",
      target: { kind: "master", index: null, expectedReference: PUBLIC_UUID },
      transport: { startBeat: f.input.startBeat, endBeat: f.input.endBeat },
    },
    sourceCoverage: {
      startSample: f.input.captureStartSample,
      endSample: f.input.captureEndSample,
    },
    alignment: evaluateListeningAlignment(DEFAULT_LISTENING_TIMING_POLICY, {
      sampleRate: f.input.sampleRate,
      vectorSize: f.input.vectorSize ?? 64,
      observedClockDisagreementSamples: 64,
      observedBeatDisagreementSamples: 1,
    }),
  };
}
function adapterContract(overrides = {}) {
  return {
    schemaVersion: "metric-audio-observation/v1",
    parse: (value) => metricAudioObservationSchema.parse(value),
    createReportRows: createMetricObservationReportRows,
    ...overrides,
  };
}

test("adapter validates complete independent timelines against the explicit versioned public schema", () => {
  const f = adapterFixture();
  feedLevel(f);
  feedSpectrum(f);
  const result = f.finish();
  const context = adapterContext(f);
  const observation = adaptMetricTimelineObservation(
    result,
    context,
    adapterContract(),
  );
  assert.equal(observation.schema, "metric-audio-observation/v1");
  assert.equal(observation.outcome, "complete");
  assert.deepEqual(observation.requestedMetrics, [
    "level",
    "spectral-centroid",
  ]);
  assert.equal(observation.ownership.generation, OWNER.generation);
  assert.equal(result.envelope.owner.generation, OWNER.generation);
  assert.notEqual(observation.ownership.generation, PUBLIC_UUID);
  assert.equal(observation.metrics.level.records[0].index, 0);
  assert.equal(observation.metrics.level.records[0].rms[0], Math.sqrt(1 / 8));
  assert.equal(
    observation.metrics["spectral-centroid"].records[0].spectralEnergy,
    2,
  );
  assert.equal(observation.metrics.attacks.status, "not-requested");
  assert.equal(observation.metrics.attacks.algorithm, null);
  assert(
    observation.rows.every(
      (row) => row.attacks.eventRecordIndices.length === 0,
    ),
  );
  assert.deepEqual(
    observation.rows,
    createMetricObservationReportRows(observation),
  );
  assert.deepEqual(
    metricAudioObservationSchema.parse(observation),
    observation,
  );
  assert.equal(Object.hasOwn(observation, "complete"), false);
  assert.equal(
    Object.hasOwn(observation.metrics.level.records[0], "sumSquares"),
    false,
  );
  assert(Object.isFrozen(observation.rows));
  assert(Object.isFrozen(observation.ownership));
  context.ownership.passId = "changed";
  context.source.transport.endBeat = 900;
  assert.equal(observation.ownership.passId, "pass");
  assert.equal(observation.source.transport.endBeat, 4);
});

test("adapter preserves missing FFT and level slots without legacy matching, renumbering or data loss", () => {
  const stalled = adapterFixture();
  stalled.collector.failMetric("spectrum", "stalled");
  feedLevel(stalled);
  const partial = adaptMetricTimelineObservation(
    stalled.finish(),
    adapterContext(stalled),
    adapterContract(),
  );
  assert.equal(partial.outcome, "partial");
  assert.equal(partial.metrics.level.status, "complete");
  assert.equal(partial.metrics["spectral-centroid"].status, "failed");
  assert.equal(partial.metrics["spectral-centroid"].gaps[0].firstIndex, 0);
  assert.equal(partial.metrics["spectral-centroid"].gaps[0].count, 46);
  assert.equal(
    partial.metrics["spectral-centroid"].gaps[0].reason,
    "unavailable",
  );
  assert.match(partial.metrics["spectral-centroid"].gaps[0].detail, /stalled/);
  assert(
    partial.rows.every(
      (row) => row["spectral-centroid"].availability === "missing",
    ),
  );
  const gapped = adapterFixture();
  gapped.collector.ingestLevel(level(gapped.collector.grid[0]));
  gapped.collector.ingestLevel(level(gapped.collector.grid[2]));
  feedSpectrum(gapped);
  const observation = adaptMetricTimelineObservation(
    gapped.finish(),
    adapterContext(gapped),
    adapterContract(),
  );
  assert.deepEqual(
    observation.metrics.level.records.map((record) => record.index),
    [0, 2],
  );
  assert.equal(observation.metrics.level.gaps[0].firstIndex, 1);
  assert.equal(observation.metrics.level.gaps[0].count, 1);
  assert.equal(observation.metrics.level.gaps[0].reason, "sequence-gap");
  assert.deepEqual(observation.rows[2].level.recordIndices, [2]);
  assert.deepEqual(observation.rows[1].level.recordIndices, []);
  assert.equal(observation.metrics["spectral-centroid"].status, "complete");
});

test("adapter preserves valid silence, no-frame resolution and optional metric independence", () => {
  const silence = adapterFixture();
  feedLevel(silence, { peak: [0, 0], sumSquares: [0, 0] });
  feedSpectrum(silence, { energy: 0, centroidHz: null });
  const silent = adaptMetricTimelineObservation(
    silence.finish(),
    adapterContext(silence),
    adapterContract(),
  );
  assert.equal(silent.outcome, "complete");
  assert(
    silent.metrics["spectral-centroid"].records.every(
      (record) => record.centroidHz === null,
    ),
  );
  assert(
    silent.rows.every(
      (row) => row["spectral-centroid"].availability === "available",
    ),
  );
  const short = adapterFixture({ tempo: 999, endBeat: 0.5 });
  feedLevel(short);
  const noFrame = adaptMetricTimelineObservation(
    short.finish(),
    adapterContext(short),
    adapterContract(),
  );
  assert.equal(noFrame.metrics["spectral-centroid"].expectedRecords, 0);
  assert.equal(noFrame.metrics["spectral-centroid"].status, "complete");
  assert(
    noFrame.rows.every(
      (row) => row["spectral-centroid"].availability === "no-frame",
    ),
  );
  const spectrumOnly = adapterFixture({ requestedMetrics: ["spectrum"] });
  feedSpectrum(spectrumOnly);
  const independent = adaptMetricTimelineObservation(
    spectrumOnly.finish(),
    adapterContext(spectrumOnly),
    adapterContract(),
  );
  assert.equal(independent.outcome, "complete");
  assert.equal(independent.metrics.level.status, "not-requested");
  assert.equal(independent.metrics.level.algorithm, null);
});

test("adapter retains admitted detector parameters and explicit missing input, never invented empty detections", () => {
  const f = adapterFixture({ requestedMetrics: ["level", "attacks"] });
  feedLevel(f);
  const result = f.finish();
  const context = adapterContext(f);
  const admitted = adaptMetricTimelineObservation(
    result,
    context,
    adapterContract(),
  );
  assert.deepEqual(admitted.metrics.attacks.algorithm, result.envelope.attacks);
  context.attackAlgorithm = {
    name: "level-window-rise",
    version: 1,
    dependency: "level",
    inputSource: "independent-100ms-level-windows",
    windowSamples: 4800,
    thresholdDb: 6,
    minSpacingSamples: 4800,
    units: "dB-rise",
  };
  const observation = adaptMetricTimelineObservation(
    result,
    context,
    adapterContract(),
  );
  assert.equal(observation.outcome, "partial");
  assert.equal(observation.metrics.attacks.status, "failed");
  assert.equal(observation.metrics.attacks.expectedRecords, 20);
  assert.deepEqual(observation.metrics.attacks.records, []);
  assert.equal(observation.metrics.attacks.gaps[0].count, 20);
  assert.equal(observation.metrics.attacks.gaps[0].reason, "unavailable");
  assert(
    observation.rows.every((row) => row.attacks.availability === "missing"),
  );
  assert(
    observation.rows.every(
      (row) => row.attacks.eventRecordIndices.length === 0,
    ),
  );
  const missingInputSource = { ...context.attackAlgorithm };
  delete missingInputSource.inputSource;
  assert.throws(
    () =>
      adaptMetricTimelineObservation(
        result,
        {
          ...context,
          attackAlgorithm: missingInputSource,
        },
        adapterContract(),
      ),
    /metric_adapter_attack_configuration_mismatch/,
  );
  const withoutMusicalLevel = adapterFixture({
    requestedMetrics: ["spectrum", "attacks"],
  });
  feedSpectrum(withoutMusicalLevel);
  const independent = adaptMetricTimelineObservation(
    withoutMusicalLevel.finish(),
    {
      ...adapterContext(withoutMusicalLevel),
      attackAlgorithm: context.attackAlgorithm,
    },
    adapterContract(),
  );
  assert.equal(independent.outcome, "partial");
  assert.equal(independent.metrics.level.status, "not-requested");
  assert.equal(independent.metrics["spectral-centroid"].status, "complete");
  assert.equal(independent.metrics.attacks.status, "failed");
  assert.deepEqual(independent.metrics.attacks.records, []);
  assert.equal(independent.metrics.attacks.gaps[0].count, 20);
});

test("adapter supports explicit Session clip-local and Arrangement absolute source envelopes", () => {
  const arrangement = adapterFixture({
    startBeat: 8.13,
    endBeat: 12.62,
    captureStartSample: 12345,
  });
  feedLevel(arrangement);
  feedSpectrum(arrangement);
  const absolute = adaptMetricTimelineObservation(
    arrangement.finish(),
    adapterContext(arrangement),
    adapterContract(),
  );
  assert.equal(absolute.source.view, "arrangement");
  assert.equal(absolute.geometry.startBeat, 8.13);
  assert.equal(absolute.geometry.rows[0].endBeat, 8.25);
  const session = adapterFixture();
  feedLevel(session);
  feedSpectrum(session);
  const context = adapterContext(session);
  context.source = {
    view: "session",
    target: {
      view: "session",
      track: {
        kind: "regular",
        index: 0,
        expectedReference: PUBLIC_UUID,
        expectedName: "Track",
      },
      sceneIndex: 0,
      expectedClipReference: PUBLIC_UUID,
      expectedClipName: "Clip",
    },
    clipReference: PUBLIC_UUID,
    kind: "midi",
    coordinate: { unit: "beats", iteration: 0, startBeat: 0, endBeat: 4 },
    transport: { startBeat: 0, endBeat: 4 },
    clipStartTimeBeats: 0,
    synchronization: "transport-coupled-first-iteration",
  };
  const local = adaptMetricTimelineObservation(
    session.finish(),
    context,
    adapterContract(),
  );
  assert.equal(local.source.view, "session");
  assert.equal(local.source.coordinate.startBeat, 0);
  assert.equal(local.geometry.startBeat, 0);
});

test("adapter rejects legacy/reopened/unsealed input and never publishes failed or cancelled captures", () => {
  let parseCalls = 0;
  const contract = adapterContract({
    parse: () => {
      parseCalls++;
      throw new Error("unexpected_parse");
    },
  });
  const f = adapterFixture();
  feedLevel(f);
  const result = f.finish();
  for (const legacy of [
    { complete: true, rows: [] },
    { schema: "audio-observation/v1", complete: true },
    JSON.parse(JSON.stringify(result)),
    { ...result, schema: "metric-timeline-result/v1" },
    f.collector.progress(),
  ]) {
    assert.throws(
      () => adaptMetricTimelineObservation(legacy, adapterContext(f), contract),
      /metric_adapter_fresh_result_required/,
    );
  }
  for (const ending of ["failed", "cancelled", "owner_corruption"]) {
    const invalid = adapterFixture();
    const ended =
      ending === "cancelled"
        ? invalid.collector.cancel()
        : ending === "owner_corruption"
          ? invalid.collector.failShared("owner_corruption")
          : invalid.finish();
    assert.throws(
      () =>
        adaptMetricTimelineObservation(
          ended,
          adapterContext(invalid),
          contract,
        ),
      /metric_adapter_result_not_publishable/,
    );
  }
  assert.equal(parseCalls, 0);
  assert.throws(
    () =>
      adaptMetricTimelineObservation(result, adapterContext(f), {
        ...contract,
        schemaVersion: "audio-observation/v1",
      }),
    /metric_adapter_versioned_contract_required/,
  );
});

test("adapter never fabricates shared proof, ownership, alignment, trace lineage or unsupported algorithms", () => {
  const f = adapterFixture();
  feedLevel(f);
  feedSpectrum(f);
  const result = f.finish();
  for (const change of [
    (context) => {
      context.collectorOwner.arm = "foreign";
    },
    (context) => {
      context.ownership.nativeEpoch++;
    },
    (context) => {
      context.ownership.generation = PUBLIC_UUID;
    },
    (context) => {
      context.ownership.traceId = "00000000-0000-4000-8000-000000000002";
    },
    (context) => {
      context.ownership.causationId = "foreign-cause";
    },
    (context) => {
      delete context.sharedIntegrity;
    },
    (context) => {
      context.sourceCoverage.endSample--;
    },
    (context) => {
      delete context.alignment;
    },
    (context) => {
      context.source.transport.endBeat++;
    },
  ]) {
    const context = adapterContext(f);
    change(context);
    assert.throws(() =>
      adaptMetricTimelineObservation(result, context, adapterContract()),
    );
  }
  const otherHop = adapterFixture({
    endBeat: 0.5,
    originSample: 1000,
    spectrum: { supportSamples: 2048, hopSamples: 2000, firstEndSample: 3000 },
  });
  feedLevel(otherHop);
  feedSpectrum(otherHop);
  assert.throws(
    () =>
      adaptMetricTimelineObservation(
        otherHop.finish(),
        adapterContext(otherHop),
        adapterContract(),
      ),
    /metric_adapter_unsupported_spectrum_hop/,
  );
  const healthFailure = adapterFixture({ requestedMetrics: ["level"] });
  feedLevel(healthFailure);
  healthFailure.collector.failMetric("level", "analyzer_failed");
  const failedAfterCoverage = healthFailure.finish();
  assert.equal(failedAfterCoverage.status, "partial");
  assert.throws(
    () =>
      adaptMetricTimelineObservation(
        failedAfterCoverage,
        adapterContext(healthFailure),
        adapterContract(),
      ),
    /metric_adapter_unrepresentable_metric_failure/,
  );
});

test("adapter propagates schema/byte-quota failures without truncation or success-shaped fallback", () => {
  const f = adapterFixture();
  feedLevel(f);
  const result = f.finish();
  const serialized = JSON.stringify(result);
  const original = new Error("controlled_contract_failure");
  assert.throws(
    () =>
      adaptMetricTimelineObservation(
        result,
        adapterContext(f),
        adapterContract({
          parse: () => {
            throw original;
          },
        }),
      ),
    (error) => error === original,
  );
  assert.equal(JSON.stringify(result), serialized);
  const oversized = adapterFixture({
    tempo: 999,
    endBeat: 499.5,
    requestedMetrics: ["level"],
  });
  feedLevel(oversized);
  const largeResult = oversized.finish();
  assert.throws(
    () =>
      adaptMetricTimelineObservation(
        largeResult,
        adapterContext(oversized),
        adapterContract(),
      ),
    /encoded payload quota/,
  );
  assert.equal(largeResult.metrics.level.records.length, 1998);
  assert.equal(largeResult.rows.length, 1998);
});

test("adapter lifecycle is bounded and attributed on success, partial, schema failure and cancellation", () => {
  for (const status of ["completed", "partial", "failed", "cancelled"]) {
    const f = adapterFixture();
    feedLevel(f);
    if (status === "completed") feedSpectrum(f);
    const result = status === "cancelled" ? f.collector.cancel() : f.finish();
    const events = [];
    let tick = 0;
    const contract = adapterContract({
      now: () => tick++,
      onEvent: (event) => events.push(event),
      ...(status === "failed"
        ? {
            parse: () => {
              throw new Error("controlled_failure");
            },
          }
        : {}),
    });

    if (status === "cancelled" || status === "failed")
      assert.throws(() =>
        adaptMetricTimelineObservation(result, adapterContext(f), contract),
      );
    else adaptMetricTimelineObservation(result, adapterContext(f), contract);
    assert.equal(events[0].stage, "queued");
    assert.equal(events[1].stage, "started");
    assert.equal(events.at(-1).stage, status);
    assert(events.length <= 4);
    for (let index = 0; index < events.length; index++) {
      const event = events[index];
      assert.equal(event.metricId, "protocol-adapter");
      assert.equal(event.generation, OWNER.generation);
      assert.equal(event.nativeEpoch, OWNER.nativeEpoch);
      assert.equal(event.traceId, PUBLIC_UUID);
      assert.equal(event.correlationId, f.input.correlationId);
      assert.equal(event.causationId, f.input.causationId);
      assert(event.elapsedMs >= 0);
      if (index) assert(event.elapsedMs >= events[index - 1].elapsedMs);
      assert(JSON.stringify(event).length < 512);
      for (const key of [
        "source",
        "records",
        "alignment",
        "ownership",
        "audio",
        "error",
      ])
        assert.equal(Object.hasOwn(event, key), false);
    }
  }
});

test("detector inputs independently complete all three metrics and retain schema-replayable input levels", () => {
  const f = adapterFixture({
    requestedMetrics: ["level", "spectrum", "attacks"],
  });
  feedDetector(f, [
    [0.25, 0.125],
    [0.5, 0.25],
    [0.5, 0.25],
    [1, 0.5],
  ]);
  assert.equal(f.collector.progress().metrics.attacks.acceptedRecords, 20);
  assert.equal(f.collector.progress().metrics.level.acceptedRecords, 0);
  feedLevel(f);
  feedSpectrum(f);
  const result = f.finish();
  assert.equal(result.status, "completed");
  assert.equal(result.metrics.attacks.expectedRecords, 20);
  assert.equal(result.metrics.attacks.summary.eventCount, 2);
  assert.equal(result.metrics.attacks.summary.inputWindows, 20);
  assert.deepEqual(result.metrics.attacks.records[0].inputLevel, {
    peak: [0.25, 0.125],
    rms: [0.25, 0.125],
  });
  const observation = adaptMetricTimelineObservation(
    result,
    adapterContext(f),
    adapterContract(),
  );
  assert.equal(observation.outcome, "complete");
  assert.equal(observation.metrics.attacks.status, "complete");
  assert.equal(observation.metrics.attacks.algorithm.thresholdDb, 6);
  assert.equal(observation.metrics.attacks.algorithm.minSpacingSamples, 4800);
  assert.deepEqual(observation.metrics.attacks.records[0].events, [
    { sample: 4800, strength: 120 + 20 * Math.log10(0.25) },
  ]);
  assert.deepEqual(
    metricAudioObservationSchema.parse(observation),
    observation,
  );
});

test("legacy detector preserves sustained-rise suppression, zero/falling rearm and stereo-max RMS", () => {
  const levels = [
    [0, 0.125],
    [0.125, 0.25],
    [0.25, 0.5],
    [0.5, 1],
    [0.25, 0.5],
    [0.5, 1],
    [1, 1],
    [1, 2],
  ];
  const f = adapterFixture({ requestedMetrics: ["attacks"], endBeat: 1.6 });
  const inputs = levels.map((rms, index) => detectorLevel(f, index + 1, rms));
  for (const record of inputs) f.collector.ingestDetectorLevel(record);
  const result = f.finish();
  assert.equal(result.status, "completed");
  assert.deepEqual(
    result.metrics.attacks.records.map((record) => record.events),
    attackReference(inputs, f.input.attacks),
  );
  assert.deepEqual(
    result.metrics.attacks.summary.events.map((event) => event.sample),
    [4800, 28800, 38400],
  );
  const observation = adaptMetricTimelineObservation(
    result,
    adapterContext(f),
    adapterContract(),
  );
  assert.equal(observation.metrics.level.status, "not-requested");
  assert.equal(observation.metrics.attacks.records.length, 8);
});

test("detector threshold equality, refractory spacing and missed rises preserve unchanged state semantics", () => {
  const rise = 20 * Math.log10(2);
  for (const thresholdDb of [rise, rise + 1e-10]) {
    const f = adapterFixture({
      requestedMetrics: ["attacks"],
      endBeat: 0.6,
      attacks: { thresholdDb, minSpacingSamples: 4800 },
    });
    feedDetector(f, [
      [1, 1],
      [0.5, 0.5],
      [1, 1],
    ]);
    const result = f.finish();
    assert.equal(
      result.metrics.attacks.summary.eventCount,
      thresholdDb === rise ? 2 : 1,
    );
    adaptMetricTimelineObservation(
      result,
      adapterContext(f),
      adapterContract(),
    );
  }
  const refractory = adapterFixture({
    requestedMetrics: ["attacks"],
    endBeat: 1,
    attacks: { thresholdDb: 6, minSpacingSamples: 14400 },
  });
  const levels = [
    [1, 1],
    [0.5, 0.5],
    [1, 1],
    [0.5, 0.5],
    [1, 1],
  ];
  const inputs = levels.map((rms, index) =>
    detectorLevel(refractory, index + 1, rms),
  );
  feedDetector(refractory, levels);
  const result = refractory.finish();
  assert.deepEqual(
    result.metrics.attacks.records.map((record) => record.events),
    attackReference(inputs, refractory.input.attacks),
  );
  assert.deepEqual(
    result.metrics.attacks.summary.events.map((event) => event.sample),
    [4800, 24000],
  );
  adaptMetricTimelineObservation(
    result,
    adapterContext(refractory),
    adapterContract(),
  );
  const belowThreshold = adapterFixture({
    requestedMetrics: ["attacks"],
    endBeat: 0.4,
    attacks: { thresholdDb: 120, minSpacingSamples: 4800 },
  });
  feedDetector(belowThreshold, [
    [0.25, 0.25],
    [0.5, 0.5],
  ]);
  const empty = adaptMetricTimelineObservation(
    belowThreshold.finish(),
    adapterContext(belowThreshold),
    adapterContract(),
  );
  assert.equal(empty.metrics.attacks.status, "complete");
  assert(
    empty.metrics.attacks.records.every((record) => record.events.length === 0),
  );
});

test("detector accepts above-unity through64 without strength clipping and valid silence/empty lists are data", () => {
  for (const amplitude of [0, 1e-7, 1e-6, 2, 64]) {
    const f = adapterFixture({ requestedMetrics: ["attacks"], endBeat: 0.2 });
    feedDetector(f, [[amplitude, amplitude]]);
    const result = f.finish();
    assert.equal(result.status, "completed");
    const observation = adaptMetricTimelineObservation(
      result,
      adapterContext(f),
      adapterContract(),
    );
    const record = observation.metrics.attacks.records[0];
    assert.deepEqual(record.inputLevel.rms, [amplitude, amplitude]);
    if (amplitude <= 1e-6) assert.deepEqual(record.events, []);
    else {
      assert.equal(record.events[0].strength, 120 + 20 * Math.log10(amplitude));
      assert(record.events[0].strength > 120);
    }
    assert.equal(observation.rows[0].attacks.availability, "available");
  }
});

test("physical detector supports and clipped tail are independent of fractional musical boundaries at both rates", () => {
  for (const sampleRate of [44100, 48000]) {
    const hop = Math.round(sampleRate / 10);
    const total = 2 * hop + 17;
    const f = adapterFixture({
      sampleRate,
      requestedMetrics: ["attacks"],
      startBeat: 8.13,
      endBeat: 8.13 + (total * 120) / (sampleRate * 60),
      captureStartSample: 12345,
    });
    const inputs = [
      [0, 0],
      [0, 0],
      [0.5, 0.25],
    ].map((rms, index) => detectorLevel(f, index + 1, rms));
    for (const input of inputs)
      assert.equal(f.collector.ingestDetectorLevel(input).accepted, true);
    const result = f.finish();
    assert.equal(result.metrics.attacks.records[2].count, 17);
    assert.equal(
      result.metrics.attacks.records[2].endSample,
      f.input.captureEndSample,
    );
    assert.deepEqual(result.metrics.attacks.summary.events, [
      {
        sample: f.input.captureEndSample,
        strength: 120 + 20 * Math.log10(0.5),
      },
    ]);
    const observation = adaptMetricTimelineObservation(
      result,
      adapterContext(f),
      adapterContract(),
    );
    assert.equal(observation.metrics.attacks.algorithm.windowSamples, hop);
    assert.equal(observation.rows.at(-1).attacks.eventRecordIndices[0], 2);
  }
});

test("detector END events at a musical start and capture end use event ownership, never extra detector coverage", () => {
  const f = adapterFixture({ requestedMetrics: ["attacks"] });
  const levels = Array.from({ length: 20 }, () => [0, 0]);
  levels[4] = [1, 1];
  levels[19] = [1, 1];
  feedDetector(f, levels);
  const result = f.finish();
  const observation = adaptMetricTimelineObservation(
    result,
    adapterContext(f),
    adapterContract(),
  );
  assert.deepEqual(observation.rows[4].attacks.eventRecordIndices, [4]);
  assert.equal(observation.rows[4].attacks.recordIndices.includes(4), false);
  assert.deepEqual(observation.rows.at(-1).attacks.eventRecordIndices, [19]);
  assert.deepEqual(result.rows[4].attacks.events, [
    { sample: 24000, strength: 120 },
  ]);
  assert.equal(result.rows[4].attacks.recordSequences.includes(5), false);
  assert.deepEqual(result.rows[4].attacks.eventRecordSequences, [5]);
  assert.deepEqual(result.rows.at(-1).attacks.events, [
    { sample: 96000, strength: 120 },
  ]);
  assert.equal(
    result.rows.reduce((count, row) => count + row.attacks.events.length, 0),
    2,
  );
  assert.equal(
    observation.rows.reduce(
      (count, row) => count + row.attacks.eventRecordIndices.length,
      0,
    ),
    2,
  );
});

test("detector delivery is independent from missing/unrequested musical level and from a stalled spectrum", () => {
  for (const requestedMetrics of [
    ["attacks"],
    ["level", "attacks"],
    ["level", "spectrum", "attacks"],
  ]) {
    const f = adapterFixture({ requestedMetrics });
    if (requestedMetrics.includes("spectrum")) {
      feedLevel(f);
      f.collector.failMetric("spectrum", "stalled");
    }
    feedDetector(f, [[0.5, 0.5]]);
    const result = f.finish();
    assert.equal(result.metrics.attacks.status, "completed");
    assert.equal(
      result.status,
      requestedMetrics.length === 1 ? "completed" : "partial",
    );
    const observation = adaptMetricTimelineObservation(
      result,
      adapterContext(f),
      adapterContract(),
    );
    assert.equal(observation.metrics.attacks.status, "complete");
  }
  const absent = adapterFixture({
    requestedMetrics: ["level", "spectrum", "attacks"],
  });
  feedLevel(absent);
  feedSpectrum(absent);
  const missing = absent.finish();
  assert.equal(missing.status, "partial");
  assert.equal(missing.metrics.attacks.acceptedRecords, 0);
  assert.equal(missing.metrics.attacks.summary, null);
  assert.equal(missing.metrics.attacks.missing[0].firstSequence, 1);
});

test("a missing detector input stops only that family at its trustworthy prefix with no guessed replay reset", () => {
  for (const firstSequence of [1, 2]) {
    const f = adapterFixture({
      requestedMetrics: ["level", "spectrum", "attacks"],
    });
    if (firstSequence === 1)
      f.collector.ingestDetectorLevel(detectorLevel(f, 1, [0.5, 0.5]));
    const skipped = firstSequence === 1 ? 3 : 2;
    assert.equal(
      f.collector.ingestDetectorLevel(detectorLevel(f, skipped, [1, 1])).reason,
      "sequence_gap",
    );
    assert.equal(
      f.collector.ingestDetectorLevel(
        detectorLevel(f, firstSequence === 1 ? 2 : 1),
      ).reason,
      "metric_terminal",
    );
    feedLevel(f);
    feedSpectrum(f);
    const result = f.finish();
    assert.equal(
      result.metrics.attacks.acceptedRecords,
      firstSequence === 1 ? 1 : 0,
    );
    assert.equal(
      result.metrics.attacks.missing[0].firstSequence,
      firstSequence === 1 ? 2 : 1,
    );
    assert.equal(result.metrics.attacks.missing[0].lastSequence, 20);
    assert.equal(result.metrics.attacks.missing[0].reason, "sequence_gap");
    assert.equal(result.metrics.level.status, "completed");
    const observation = adaptMetricTimelineObservation(
      result,
      adapterContext(f),
      adapterContract(),
    );
    assert.deepEqual(
      observation.metrics.attacks.records.map((record) => record.index),
      firstSequence === 1 ? [0] : [],
    );
    assert.equal(
      observation.metrics.attacks.gaps[0].count,
      firstSequence === 1 ? 19 : 20,
    );
  }
});

test("detector holds are immutable exact-once and never advance previous level or refractory state", () => {
  const f = adapterFixture({ requestedMetrics: ["attacks"], endBeat: 0.8 });
  const first = detectorLevel(f, 1, [1, 1]);
  f.collector.ingestDetectorLevel(first);
  f.collector.ingestDetectorLevel(detectorLevel(f, 2, [0.5, 0.5]));
  for (let hold = 0; hold < 100; hold++)
    assert.equal(f.collector.ingestDetectorLevel(first).duplicate, true);
  f.collector.ingestDetectorLevel(detectorLevel(f, 3, [1, 1]));
  first.sumSquares[0] /= 2;
  assert.equal(
    f.collector.ingestDetectorLevel(first).reason,
    "duplicate_mutation",
  );
  assert.equal(
    f.collector.ingestDetectorLevel(detectorLevel(f, 4)).reason,
    "metric_terminal",
  );
  const result = f.finish();
  assert.equal(result.status, "partial");
  assert.equal(result.metrics.attacks.duplicates, 100);
  assert.deepEqual(
    result.metrics.attacks.summary.events.map((event) => event.sample),
    [4800, 14400],
  );
  assert.deepEqual(result.metrics.attacks.records[0].inputLevel.rms, [1, 1]);
  const observation = adaptMetricTimelineObservation(
    result,
    adapterContext(f),
    adapterContract(),
  );
  assert.equal(observation.metrics.attacks.gaps[0].firstIndex, 3);
  assert.equal(observation.metrics.attacks.gaps[0].reason, "malformed-record");
});

test("detector count/support/moments/linear bounds fail locally and preserve already validated inputs", () => {
  for (const changes of [
    { count: 4799 },
    { startSample: 0 },
    { endSample: 10000 },
    { peak: [65, 1] },
    { sumSquares: [-1, 0] },
    { peak: [0, 0] },
    { sumSquares: [Infinity, 0] },
  ]) {
    const f = adapterFixture({
      requestedMetrics: ["level", "attacks"],
      endBeat: 0.6,
    });
    f.collector.ingestDetectorLevel(detectorLevel(f, 1, [0.5, 0.5]));
    assert.equal(
      f.collector.ingestDetectorLevel(detectorLevel(f, 2, [0.5, 0.5], changes))
        .accepted,
      false,
    );
    feedLevel(f);
    const result = f.finish();
    assert.equal(result.metrics.attacks.acceptedRecords, 1);
    assert.equal(result.metrics.level.status, "completed");
    adaptMetricTimelineObservation(
      result,
      adapterContext(f),
      adapterContract(),
    );
  }
  const rmsInput = adapterFixture({
    requestedMetrics: ["attacks"],
    endBeat: 0.2,
  });
  const record = detectorLevel(rmsInput, 1, [0.5, 0.25]);
  delete record.sumSquares;
  record.rms = [0.5, 0.25];
  assert.equal(rmsInput.collector.ingestDetectorLevel(record).accepted, true);
  adaptMetricTimelineObservation(
    rmsInput.finish(),
    adapterContext(rmsInput),
    adapterContract(),
  );
});

test("detector epoch forgery, global failure, cancellation and sealed late inputs cannot publish", () => {
  for (const ending of ["foreign", "global", "cancel"]) {
    const f = adapterFixture({ requestedMetrics: ["attacks"] });
    f.collector.ingestDetectorLevel(detectorLevel(f, 1));
    let result;
    if (ending === "foreign") {
      assert.equal(
        f.collector.ingestDetectorLevel(
          detectorLevel(f, 2, [1, 1], {
            owner: { ...OWNER, nativeEpoch: OWNER.nativeEpoch + 1 },
          }),
        ).reason,
        "owner_corruption",
      );
      result = f.finish();
    } else
      result =
        ending === "cancel"
          ? f.collector.cancel()
          : f.collector.failShared("global_timeout");
    const encoded = JSON.stringify(result);
    const events = f.events.length;
    assert.equal(
      f.collector.ingestDetectorLevel(detectorLevel(f, 2)).reason,
      "sealed",
    );
    assert.equal(f.collector.cancel(), result);
    assert.equal(f.finish(), result);
    assert.equal(JSON.stringify(result), encoded);
    assert.equal(f.events.length, events);
    assert.throws(
      () =>
        adaptMetricTimelineObservation(
          result,
          adapterContext(f),
          adapterContract(),
        ),
      /metric_adapter_result_not_publishable/,
    );
  }
  const unrequested = fixture();
  assert.throws(
    () =>
      unrequested.collector.ingestDetectorLevel(detectorLevel(unrequested, 1)),
    /metric_not_requested/,
  );
});

test("detector algorithm admission is explicit, frozen and cannot be changed by adapter context", () => {
  for (const attacks of [
    undefined,
    null,
    {},
    { thresholdDb: 6 },
    { minSpacingSamples: 4800 },
    { thresholdDb: -1, minSpacingSamples: 4800 },
    { thresholdDb: 121, minSpacingSamples: 4800 },
    { thresholdDb: NaN, minSpacingSamples: 4800 },
    { thresholdDb: 6, minSpacingSamples: -1 },
    { thresholdDb: 6, minSpacingSamples: 0.5 },
    { thresholdDb: 6, minSpacingSamples: 4800, windowSamples: 2400 },
    { thresholdDb: 6, minSpacingSamples: 4800, unexpected: true },
  ])
    assert.throws(
      () => fixture({ requestedMetrics: ["attacks"], attacks }),
      /attack_configuration/,
    );
  const config = { thresholdDb: 0, minSpacingSamples: 0, windowSamples: 4800 };
  const f = adapterFixture({
    requestedMetrics: ["attacks"],
    endBeat: 0.2,
    attacks: config,
  });
  config.thresholdDb = 120;
  config.minSpacingSamples = 14400;
  feedDetector(f, [[0.25, 0.25]]);
  const result = f.finish();
  assert.equal(result.metrics.attacks.algorithm.thresholdDb, 0);
  assert.equal(result.metrics.attacks.algorithm.minSpacingSamples, 0);
  assert(Object.isFrozen(result.envelope.attacks));
  const context = adapterContext(f);
  context.attackAlgorithm = {
    ...result.metrics.attacks.algorithm,
    thresholdDb: 6,
  };
  assert.throws(
    () => adaptMetricTimelineObservation(result, context, adapterContract()),
    /metric_adapter_attack_configuration_mismatch/,
  );
  const budgeted = () =>
    fixture({ requestedMetrics: ["attacks"], maxRecords: { attacks: 19 } });
  assert.throws(budgeted, /metric_quota_exceeded/);
});

test("the unchanged shipping legacy engine and independent detector produce identical full-window numeric events", () => {
  const f = adapterFixture({ requestedMetrics: ["attacks"], endBeat: 1.6 });
  const levels = [
    [0.125, 0.125],
    [0.25, 0.25],
    [0.5, 0.5],
    [1, 1],
    [0.5, 0.5],
    [1, 1],
    [1, 1],
    [2, 2],
  ];
  const legacyOwner = {
    passId: "numeric-only",
    connectionEpoch: "synthetic-epoch",
  };
  const host = {
    sampleRate: 48000,
    vectorSize: 64,
    sample: 0,
    beat: 0,
    flags: 19,
    playing: false,
    dspOn: true,
  };
  // Synthetic numeric reference only, never native timing/source certification.
  const engine = new AudioListenerEngine({
    listenerId: "numeric-only",
    now: () => 0,
    certificate: {
      validated: true,
      algorithmVersion: LEGACY_VERSION,
      hostVersion: "synthetic",
      maxVersion: "synthetic",
      launchAligned: true,
      requiredHostFlags: 19,
      sampleRate: 48000,
      vectorSize: 64,
      uncertaintySamples: 64,
      descriptorOffsetSamples: 0,
    },
  });
  engine.configureHost(host);
  engine.prepare({
    ...legacyOwner,
    startBeat: 0,
    endBeat: 8,
    settings: { attackThresholdDb: 6, minAttackSpacingSamples: 4800 },
  });
  engine.arm(legacyOwner);
  engine.configureHost({ ...host, playing: true });
  for (const [index, rms] of levels.entries()) {
    const record = detectorLevel(f, index + 1, rms);
    f.collector.ingestDetectorLevel(record);
    const beat = record.endSample / 24000;
    engine.configureHost({
      ...host,
      playing: true,
      sample: record.endSample,
      beat,
    });
    assert.equal(
      engine.ingest(
        {
          sample: record.endSample,
          beat,
          windowSamples: record.count,
          peak: record.peak,
          rms,
          centroidHz: 440,
          spectralEnergy: rms[0] ** 2 + rms[1] ** 2,
        },
        legacyOwner,
      ),
      true,
    );
  }
  const legacy = engine.cancel(legacyOwner).observation;
  assert.deepEqual(
    f.finish().metrics.attacks.summary.events,
    legacy.attacks.map(({ sample, strength }) => ({ sample, strength })),
  );
});

test("detector failure and reentrant cancellation terminate once with measured family duration and immutable cleanup", () => {
  let ms = 0;
  const input = envelope({ requestedMetrics: ["level", "attacks"] });
  const events = [];
  const collector = createMetricTimelines(input, {
    now: () => ms,
    onEvent: (event) => events.push(event),
  });
  const f = { input, collector };
  ms = 10;
  collector.ingestDetectorLevel(detectorLevel(f, 1));
  ms = 20;
  collector.ingestDetectorLevel(detectorLevel(f, 3));
  ms = 200;
  for (const row of collector.grid) collector.ingestLevel(level(row));
  const result = collector.finalize({
    owner: OWNER,
    sourceEndSample: input.captureEndSample,
  });
  const terminal = events.filter(
    (event) =>
      event.metricId === "attacks" &&
      ["completed", "partial", "failed", "cancelled"].includes(event.stage),
  );
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].stage, "partial");
  assert.equal(terminal[0].reason, "sequence_gap");
  assert.equal(terminal[0].durationMs, 20);
  assert.equal(result.metrics.attacks.durationMs, 20);
  assert.equal(result.metrics.attacks.endedMs, 20);
  assert.equal(result.metrics.level.durationMs, 200);
  let reentrant;
  let cancelled;
  const cancellationEvents = [];
  reentrant = createMetricTimelines(
    envelope({ requestedMetrics: ["attacks"] }),
    {
      onEvent(event) {
        cancellationEvents.push(event);
        if (event.metricId === "attacks" && event.stage === "progress")
          cancelled = reentrant.cancel();
      },
    },
  );
  const record = detectorLevel({ input: envelope(), collector: reentrant }, 1);
  assert.equal(reentrant.ingestDetectorLevel(record).accepted, true);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.metrics.attacks.acceptedRecords, 1);
  assert.equal(
    reentrant.ingestDetectorLevel({ ...record, sequence: 2 }).reason,
    "sealed",
  );
  assert.equal(reentrant.cancel(), cancelled);
  assert.equal(
    cancellationEvents.filter(
      (event) => event.metricId === "attacks" && event.stage === "cancelled",
    ).length,
    1,
  );
});

test("adapter binds production geometry/support/events to native originCounter, never a legacy host offset", () => {
  const originCounter = 65536;
  const f = adapterFixture({
    captureStartSample: originCounter,
    requestedMetrics: ["level", "spectrum", "attacks"],
    spectrum: {
      supportSamples: 2048,
      hopSamples: 2048,
      firstEndSample: originCounter + 1024,
    },
  });
  feedLevel(f);
  feedSpectrum(f);
  feedDetector(f, [[0.5, 0.5]]);
  const context = adapterContext(f);
  context.legacyHostOffsetSamples = -70000;
  const observation = adaptMetricTimelineObservation(
    f.finish(),
    context,
    adapterContract(),
  );
  assert.equal(observation.geometry.startSample, originCounter);
  assert.equal(observation.sourceCoverage.startSample, originCounter);
  assert.deepEqual(
    observation.metrics["spectral-centroid"].records[0].support,
    {
      startSample: originCounter - 1024,
      endSample: originCounter + 1024,
    },
  );
  assert.equal(
    observation.metrics.attacks.records[0].events[0].sample,
    originCounter + 4800,
  );
  assert.equal(Object.hasOwn(observation, "legacyHostOffsetSamples"), false);
  const mixed = fixture({
    traceId: PUBLIC_UUID,
    originSample: originCounter,
    captureStartSample: 12345,
    requestedMetrics: ["level"],
  });
  feedLevel(mixed);
  assert.throws(
    () =>
      adaptMetricTimelineObservation(
        mixed.finish(),
        adapterContext(mixed),
        adapterContract(),
      ),
    /metric_adapter_native_source_origin_mismatch/,
  );
});

test("detector telemetry is bounded, attributed, timed and carries count health without level/event bodies", () => {
  const f = adapterFixture({ requestedMetrics: ["attacks"], endBeat: 60 });
  feedDetector(f);
  const result = f.finish();
  assert.equal(result.status, "completed");
  assert.equal(result.metrics.attacks.acceptedRecords, 300);
  const events = f.events.filter((event) => event.metricId === "attacks");
  assert.equal(events[0].stage, "queued");
  assert.equal(events[1].stage, "started");
  assert.equal(events.at(-1).stage, "completed");
  assert.equal(events.at(-1).expectedRecords, 300);
  assert.equal(events.at(-1).acceptedRecords, 300);
  assert.equal(events.at(-1).missingRecords, 0);
  assert(events.at(-1).durationMs >= 0);
  assert(events.filter((event) => event.stage === "progress").length <= 128);
  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    assert.equal(event.traceId, PUBLIC_UUID);
    assert.equal(event.generation, OWNER.generation);
    assert.equal(event.nativeEpoch, OWNER.nativeEpoch);
    if (index) assert(event.elapsedMs >= events[index - 1].elapsedMs);
    for (const key of [
      "peak",
      "rms",
      "sumSquares",
      "inputLevel",
      "events",
      "audio",
    ])
      assert.equal(Object.hasOwn(event, key), false);
  }
});
