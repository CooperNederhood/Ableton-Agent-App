import "./native-protocol-test-loader.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { genModel } from "./gen-model.mjs";
import { retainedNativeSpectrumSource } from "./retained-native-source.mjs";
import { fftReference } from "./fft-reference.mjs";

const require = createRequire(import.meta.url);
const { NativeMessageIO } = require("./audio_listener_native_io.js");
const {
  createMetricTimelines,
  adaptMetricTimelineObservation,
} = require("./audio_listener_metric_timelines.js");
const {
  createMetricSpectrumHandoff,
  SpectrumHandoffError,
} = require("./audio_listener_metric_spectrum.js");
const [
  { metricAudioObservationSchema, createMetricObservationReportRows },
  { DEFAULT_LISTENING_TIMING_POLICY, evaluateListeningAlignment },
] = await Promise.all([
  import("../../packages/protocol/src/metric-observation-schemas.ts"),
  import("../../packages/protocol/src/listening-timing-schemas.ts"),
]);

const GENERATION = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const OWNER = Object.freeze({
  generation: GENERATION,
  nativeEpoch: 7,
  arm: 65000,
});
const SOURCE_START = 65536;
const CAPTURE_START = SOURCE_START + 1024;
const FIRST_END = SOURCE_START + 2048;
const CAPTURE_END = SOURCE_START + 5 * 2048;

function collectorInput(sampleRate = 48000, overrides = {}) {
  const start = overrides.captureStartSample ?? CAPTURE_START;
  const end = overrides.captureEndSample ?? CAPTURE_END;
  return {
    owner: OWNER,
    originSample: start,
    originBeat: 0,
    sampleRate,
    vectorSize: 64,
    tempo: 120,
    startBeat: 0,
    endBeat: ((end - start) * 120) / (sampleRate * 60),
    captureStartSample: start,
    captureEndSample: end,
    requestedMetrics: ["level", "spectrum", "attacks"],
    attacks: { thresholdDb: 6, minSpacingSamples: Math.round(sampleRate / 10) },
    spectrum: {
      supportSamples: 2048,
      hopSamples: 2048,
      firstEndSample: FIRST_END,
    },
    traceId: GENERATION,
    correlationId: "correlation-fft",
    causationId: "cause-fft",
    ...overrides,
  };
}
function make(input = collectorInput(), binding = {}) {
  const events = [];
  let ms = 0;
  const collector = createMetricTimelines(input);
  const expected = {
    sampleRate: input.sampleRate,
    captureStartSample: input.captureStartSample,
    captureEndSample: input.captureEndSample,
    firstFrameEndCounter: input.spectrum.firstEndSample,
    supportSamples: 2048,
    hopSamples: 2048,
    expectedCount: Math.max(
      0,
      Math.floor(
        (input.captureEndSample - input.spectrum.firstEndSample) / 2048,
      ) + 1,
    ),
    invalidFrames: 0,
  };
  const controls = {
    abi: ["native", input.owner.generation, "abi-spectrum", 2],
    ready: [
      "native",
      input.owner.generation,
      "retention-ready",
      2,
      1,
      input.owner.nativeEpoch,
    ],
    ...binding,
  };
  const handoff = createMetricSpectrumHandoff(
    {
      owner: input.owner,
      expected,
      binding: controls,
    },
    { collector, now: () => ms++, onEvent: (event) => events.push(event) },
  );
  return {
    input,
    collector,
    handoff,
    expected,
    controls,
    events,
    finish() {
      const delivery = handoff.finish();
      const result = collector.finalize({
        owner: input.owner,
        sourceEndSample: input.captureEndSample,
      });
      return { delivery, result };
    },
  };
}
function frame(index = 1, changes = {}) {
  const end = FIRST_END + (index - 1) * 2048;
  return [
    "native",
    changes.generation ?? GENERATION,
    "spectrum",
    changes.end ?? end,
    changes.centroidHz ?? 750,
    changes.energy ?? 2,
    changes.start ?? end - 2048,
    changes.frameEnd ?? end,
    changes.invalidFrames ?? 0,
  ];
}
function feedOtherFamilies(f, valueAt = () => [0.25, 0.125]) {
  const record = (startSample, endSample, sequence) => {
    const peak = [0, 0],
      sumSquares = [0, 0];
    for (let sample = startSample; sample < endSample; sample++) {
      const values = valueAt(sample);
      for (let channel = 0; channel < 2; channel++) {
        peak[channel] = Math.max(peak[channel], Math.abs(values[channel]));
        sumSquares[channel] += values[channel] ** 2;
      }
    }
    return {
      owner: f.input.owner,
      sequence,
      startSample,
      endSample,
      count: endSample - startSample,
      peak,
      sumSquares,
    };
  };
  if (f.input.requestedMetrics.includes("level"))
    for (const row of f.collector.grid)
      assert.equal(
        f.collector.ingestLevel(
          record(row.startSample, row.endSample, row.index + 1),
        ).accepted,
        true,
      );
  if (f.input.requestedMetrics.includes("attacks")) {
    const hop = Math.round(f.input.sampleRate / 10);
    for (
      let start = f.input.captureStartSample, index = 1;
      start < f.input.captureEndSample;
      start += hop, index++
    )
      assert.equal(
        f.collector.ingestDetectorLevel(
          record(start, Math.min(start + hop, f.input.captureEndSample), index),
        ).accepted,
        true,
      );
  }
}
function observation(f, result) {
  return adaptMetricTimelineObservation(
    result,
    {
      collectorOwner: f.input.owner,
      ownership: {
        listenerId: "fft-fixture",
        passId: "pass",
        connectionId: GENERATION,
        connectionEpoch: GENERATION,
        generation: f.input.owner.generation,
        nativeEpoch: f.input.owner.nativeEpoch,
        traceId: GENERATION,
        correlationId: f.input.correlationId,
        causationId: f.input.causationId,
      },
      sharedIntegrity: "validated",
      source: {
        view: "arrangement",
        target: { kind: "master", index: null, expectedReference: GENERATION },
        transport: { startBeat: f.input.startBeat, endBeat: f.input.endBeat },
      },
      sourceCoverage: {
        startSample: f.input.captureStartSample,
        endSample: f.input.captureEndSample,
      },
      alignment: evaluateListeningAlignment(DEFAULT_LISTENING_TIMING_POLICY, {
        sampleRate: f.input.sampleRate,
        vectorSize: 64,
        observedClockDisagreementSamples: 64,
        observedBeatDisagreementSamples: 1,
      }),
    },
    {
      schemaVersion: "metric-audio-observation/v1",
      parse: (value) => metricAudioObservationSchema.parse(value),
      createReportRows: createMetricObservationReportRows,
    },
  );
}

// Numeric execution/reference only: no Max host, transport or delivery proof.
function executedFixture(
  sampleRate,
  { beforeDrain, expectedAccepted = 5, dropFirst = false } = {},
) {
  const source = retainedNativeSpectrumSource();
  const model = genModel(
    `${source.code}\nout32 = sourceClock;`,
    32,
    sampleRate,
  );
  const frames = new Map(),
    references = [];
  function samples(index) {
    if (!frames.has(index)) {
      const left = Array.from({ length: 2048 }, (_, sample) =>
        index === 2 ? 0 : 0.25 * Math.sin((2 * Math.PI * 16 * sample) / 2048),
      );
      const right = Array.from({ length: 2048 }, (_, sample) =>
        index === 2 ? 0 : 0.125 * Math.sin((2 * Math.PI * 48 * sample) / 2048),
      );
      frames.set(index, {
        left,
        right,
        l: fftReference(left),
        r: fftReference(right),
      });
    }
    return frames.get(index);
  }
  const reference = (index) => {
    const fft = samples(index);
    let energy = 0,
      weighted = 0;
    for (let bin = 0; bin <= 1024; bin++) {
      const e =
        fft.l.real[bin] ** 2 +
        fft.l.imag[bin] ** 2 +
        fft.r.real[bin] ** 2 +
        fft.r.imag[bin] ** 2;
      energy += e;
      weighted += (e * bin * sampleRate) / 2048;
    }
    return { energy, centroidHz: energy > 1e-20 ? weighted / energy : 0 };
  };
  const packets = [],
    controls = [];
  let counter = SOURCE_START,
    page,
    handoff,
    ms = 0;
  const io = new NativeMessageIO(
    "spectrum",
    (packet) => {
      packets.push([...packet]);
      // Transport accepts the packet; only downstream Node delivery is dropped.
      if (
        handoff &&
        dropFirst &&
        packet[2] === "spectrum" &&
        packet[3] === FIRST_END
      )
        return true;
      if (handoff) handoff.receive(packet);
    },
    (control) => {
      controls.push([...control]);
      if (control[0].startsWith("measurement"))
        model.configure({ [control[0]]: control[1] });
    },
    () => {},
    { now: () => ms },
  );
  let sourceCounter;
  const readback = (values) =>
    io.retainedSpectrumFrame(GENERATION, OWNER.nativeEpoch, [
      sourceCounter,
      ...values,
      sourceCounter,
    ]);
  function step() {
    const index = Math.floor((counter - SOURCE_START) / 2048);
    const bin = (counter - SOURCE_START) % 2048;
    const fft = samples(index);
    const row = model.step(
      fft.l.real[bin],
      fft.l.imag[bin],
      fft.r.real[bin],
      fft.r.imag[bin],
      bin,
      counter % 1048576,
      Math.floor(counter / 1048576),
    );
    if (bin === 2047) references.push(reference(index));
    counter++;
    sourceCounter = row[31];
    page = row.slice(11, 31);
    return row;
  }
  assert.equal(io.begin(GENERATION, OWNER.nativeEpoch, sampleRate), true);
  const initial = step();
  io.packet("abi-spectrum", [initial[10]], 1);
  readback(page);
  const input = collectorInput(sampleRate);
  const f = make(input, {
    abi: packets.find((packet) => packet[2] === "abi-spectrum"),
    ready: packets.find((packet) => packet[2] === "retention-ready"),
  });
  handoff = f.handoff;
  while (counter < CAPTURE_END) step();
  const controlsBeforeHandoff = controls.length;
  const reader = io.retentionReader;
  if (beforeDrain)
    beforeDrain({
      io,
      reader,
      handoff,
      controls,
      page: () => [...page],
      step: () => {
        step();
        return [...page];
      },
      readback,
    });
  for (
    let polls = 0;
    polls < 30 &&
    reader.stats().state === "started" &&
    reader.stats().accepted < expectedAccepted;
    polls++
  ) {
    readback(page);
    step();
  }
  assert.equal(reader.stats().accepted, expectedAccepted);
  step();
  ms = 1000;
  readback(page);
  io.publishRetentionSnapshot("waiting");
  // Only actual reader completion supplies the unthrottled final forwarded count.
  assert.equal(
    io.requestSpectrumStop(
      GENERATION,
      OWNER.nativeEpoch,
      reader.stats().state === "failed" ? "failed" : "complete",
      ms + 2000,
    ),
    true,
  );
  step();
  readback(page);
  step();
  readback(page);
  assert.equal(
    io.spectrumCleanupEvidence(GENERATION, OWNER.nativeEpoch).status,
    "completed",
  );
  assert.equal(io.release(GENERATION), true);
  return {
    ...f,
    io,
    reader,
    packets,
    controls,
    references,
    controlsBeforeHandoff,
    valueAt(sample) {
      const index = Math.floor((sample - SOURCE_START) / 2048);
      const at = (sample - SOURCE_START) % 2048;
      const values = samples(index);
      return [values.left[at], values.right[at]];
    },
  };
}

for (const sampleRate of [44100, 48000])
  test(`${sampleRate}: executed retained Gen -> existing NativeMessageIO -> handoff -> actual collector -> schema`, () => {
    const f = executedFixture(sampleRate);
    feedOtherFamilies(f, f.valueAt);
    const { delivery, result } = f.finish();
    assert.equal(delivery.status, "completed");
    assert.equal(result.status, "completed");
    const saved = observation(f, result);
    const records = saved.metrics["spectral-centroid"].records;
    assert.equal(records.length, 5);
    assert.deepEqual(records[0].support, {
      startSample: SOURCE_START,
      endSample: FIRST_END,
    });
    assert.equal(records.at(-1).support.endSample, CAPTURE_END);
    assert.equal(records[2].spectralEnergy, 0);
    assert.equal(records[2].centroidHz, null);
    records.forEach((record, index) => {
      const expected = f.references[index];
      assert(
        Math.abs(record.spectralEnergy - expected.energy) <=
          Math.max(1, expected.energy) * 1e-12,
      );
      if (record.centroidHz !== null)
        assert(Math.abs(record.centroidHz - expected.centroidHz) < 1e-9);
    });
    const acks = f.controls.filter(
      (control) => control[0] === "measurementAcknowledged",
    );
    assert.deepEqual(
      acks.map((control) => control[1]),
      [0, 1, 2, 3, 4, 5],
    );
    assert.equal(
      f.controls.filter((control) => control[0] === "measurementReadSequence")
        .length,
      6,
    );
    assert.equal(delivery.counters.node.acceptedRecords, 5);
    assert.equal(delivery.counters.upstream.producedSequence, 5);
    assert.equal(delivery.counters.upstream.requestedSequence, 6);
    assert.equal(delivery.counters.upstream.visibleReadSequence, 0);
    assert.equal(delivery.counters.upstream.forwardedRecords, 5);
    assert.equal(delivery.counters.upstream.acknowledgedSequence, 5);
    assert.equal(delivery.counters.upstream.backlog, 0);
    assert.equal(delivery.counters.upstream.highWaterMark, 5);
    assert.equal(delivery.counters.node.pendingRecords, 0);
    assert.equal(delivery.counters.node.acknowledgementsIssued, 0);
  });

for (const sampleRate of [44100, 48000]) {
  test(`actual retained FFT preserves phase across epochs and can enqueue a pre-arm cached endpoint at ${sampleRate} Hz`, () => {
    const source = retainedNativeSpectrumSource();
    const model = genModel(source.code, source.outputs, sampleRate);
    const origin = SOURCE_START + 137;
    let counter = origin;
    let samples = 0;
    function advance(count) {
      let row;
      for (let index = 0; index < count; index++) {
        row = model.step(
          1,
          0,
          0,
          0,
          samples % 2048,
          counter % 1048576,
          Math.floor(counter / 1048576),
        );
        counter++;
        samples++;
      }
      return row;
    }

    const idle = advance(2048);
    const idleEnd = origin + 2048;
    assert.equal(idle[2], origin);
    assert.equal(idle[3], idleEnd);
    assert.equal(idle[4], 0);

    model.configure({ measurementEpoch: 7, measurementReadSequence: 1 });
    const firstActivation = advance(1);
    assert.equal(firstActivation[3], idleEnd);
    assert.equal(firstActivation.slice(-6)[0], idleEnd);
    const preflight = advance(2047);
    const verifiedEnd = idleEnd + 2048;
    assert.equal(preflight[2], idleEnd);
    assert.equal(preflight[3], verifiedEnd);
    assert.equal(preflight[4], 0);

    advance(173);
    model.configure({ measurementEpoch: 8, measurementReadSequence: 1 });
    const activated = advance(1);
    const captureStart = counter;
    assert.equal(activated[3], verifiedEnd);
    assert.equal(activated.slice(-6)[0], verifiedEnd);
    assert(verifiedEnd < captureStart);

    const firstAfter = (start) =>
      verifiedEnd + (Math.floor((start - verifiedEnd) / 2048) + 1) * 2048;
    const firstExpected = firstAfter(captureStart);
    const fresh = advance(2048 - 174);
    assert.equal(fresh[2], verifiedEnd);
    assert.equal(fresh[3], firstExpected);
    assert.equal(fresh[3], origin + 3 * 2048);
    assert.equal(fresh[4], 0);
    assert.equal((fresh[3] - verifiedEnd) % 2048, 0);
    const countThrough = (end) =>
      Math.max(0, Math.floor((end - firstExpected) / 2048) + 1);
    assert.equal(countThrough(firstExpected - 1), 0);
    assert.equal(countThrough(firstExpected), 1);
    assert.equal(firstAfter(verifiedEnd), verifiedEnd + 2048);

    counter++;
    const discontinuous = advance(2048);
    assert.equal(discontinuous[3], firstExpected);
    assert(discontinuous[4] > 0);
  });
}

test("first expected endpoint is independently admitted, never the first delivered frame", () => {
  const f = make();
  assert.equal(f.handoff.receive(frame(2)).accepted, true);
  for (let index = 3; index <= 5; index++) f.handoff.receive(frame(index));
  feedOtherFamilies(f);
  const { delivery, result } = f.finish();
  assert.equal(delivery.status, "partial");
  assert.equal(delivery.gaps[0].firstSequence, 1);
  assert.equal(result.metrics.spectrum.records[0].sequence, 2);
  const saved = observation(f, result);
  assert.equal(saved.metrics["spectral-centroid"].gaps[0].firstIndex, 0);
  assert.equal(saved.metrics["spectral-centroid"].gaps[0].count, 1);
});

test("gaps remain explicit; exact duplicates are immutable and no later out-of-order repair is allowed", () => {
  const f = make();
  const record = frame(1);
  assert.equal(f.handoff.receive(record).accepted, true);
  for (let hold = 0; hold < 100; hold++)
    assert.equal(f.handoff.receive([...record]).duplicate, true);
  f.handoff.receive(frame(3));
  assert.equal(f.handoff.receive(frame(2)).classification, "metric");
  assert.equal(f.handoff.receive(frame(4)).reason, "sealed");
  feedOtherFamilies(f);
  const { delivery, result } = f.finish();
  assert.equal(delivery.status, "partial");
  assert.equal(delivery.reason, "out_of_order_spectrum");
  assert.equal(delivery.counters.node.duplicateRecords, 100);
  assert.equal(result.metrics.spectrum.acceptedRecords, 2);
  observation(f, result);
  const changed = make();
  changed.handoff.receive(frame(1));
  assert.equal(
    changed.handoff.receive(frame(1, { centroidHz: 751 })).reason,
    "duplicate_mutation",
  );
  feedOtherFamilies(changed);
  assert.equal(
    changed.finish().result.metrics.spectrum.records[0].centroidHz,
    750,
  );
});

test("bad spectral values/support fault only FFT while healthy levels and detector inputs continue", () => {
  for (const changes of [
    { centroidHz: NaN },
    { centroidHz: -1 },
    { centroidHz: 24001 },
    { energy: -1 },
    { energy: Infinity },
    { energy: 0, centroidHz: 750 },
    { start: SOURCE_START + 1 },
    { frameEnd: FIRST_END + 1 },
    { invalidFrames: 1 },
  ]) {
    const f = make();
    const outcome = f.handoff.receive(frame(1, changes));
    assert.equal(outcome.accepted, false);
    assert.equal(outcome.classification, "metric");
    feedOtherFamilies(f);
    const { result } = f.finish();
    assert.equal(result.status, "partial");
    assert.equal(result.metrics.level.status, "completed");
    assert.equal(result.metrics.attacks.status, "completed");
    assert.equal(result.metrics.spectrum.status, "failed");
    observation(f, result);
  }
});

test("foreign generation, epoch or shared framing cannot be downgraded into an FFT-local result", () => {
  for (const packet of [
    frame(1, { generation: OTHER }),
    ["native", GENERATION, "retention-ready", 2, 1, 8],
    ["native", GENERATION, "abi-spectrum", 1],
    ["native", GENERATION, "ioError", 1],
    ["native", GENERATION, "retention-state", 99, 0, 7, 1, 0, 0, 32, 0, 0, 0],
    ["native", GENERATION, "spectrum", 1],
    ["not-native", GENERATION, "spectrum", ...frame(1).slice(3)],
  ]) {
    const f = make();
    assert.equal(f.handoff.receive(packet).classification, "shared");
    assert.equal(f.finish().result.status, "failed");
  }
});

test("stalled spectrum leaves a usable prefix and FFT-only capture remains independent from unavailable other families", () => {
  const prefix = make();
  prefix.handoff.receive(frame(1));
  prefix.handoff.stall();
  feedOtherFamilies(prefix);
  const partial = prefix.finish();
  assert.equal(partial.delivery.status, "partial");
  assert.equal(partial.result.metrics.spectrum.acceptedRecords, 1);
  assert.equal(partial.result.metrics.level.status, "completed");
  const only = make(collectorInput(48000, { requestedMetrics: ["spectrum"] }));
  for (let index = 1; index <= 5; index++) only.handoff.receive(frame(index));
  assert.equal(only.finish().result.status, "completed");
  const independent = make();
  independent.collector.failMetric("level", "analyzer_failed");
  independent.collector.failMetric("attacks", "stalled");
  for (let index = 1; index <= 5; index++)
    independent.handoff.receive(frame(index));
  const result = independent.finish().result;
  assert.equal(result.status, "partial");
  assert.equal(result.metrics.spectrum.status, "completed");
  observation(independent, result);
});

test("short rows with no ending FFT stay no-frame, not inferred silence; pre/post-capture frames are explicit exclusions", () => {
  const f = make(
    collectorInput(48000, {
      captureStartSample: CAPTURE_START,
      captureEndSample: CAPTURE_START + 512,
    }),
  );
  assert.equal(f.handoff.receive(frame(0)).reason, "before_expected_support");
  assert.equal(f.handoff.receive(frame(1)).reason, "after_capture");
  feedOtherFamilies(f);
  const { delivery, result } = f.finish();
  assert.equal(delivery.status, "completed");
  assert.equal(delivery.counters.node.acceptedRecords, 0);
  assert.equal(result.status, "completed");
  assert(result.rows.every((row) => row.spectrum.availability === "no-frame"));
});

test("cancellation, sealed late calls and replacement owners cannot mutate retained admissions or issue ACKs", () => {
  const old = make();
  old.handoff.receive(frame(1));
  const cancelled = old.handoff.cancel();
  old.collector.cancel();
  assert.equal(old.handoff.receive(frame(2)).reason, "sealed");
  assert.equal(old.handoff.cancel(), cancelled);
  assert.equal(old.handoff.finish(), cancelled);
  const otherOwner = { ...OWNER, generation: OTHER, nativeEpoch: 8 };
  const replacement = make(collectorInput(48000, { owner: otherOwner }));
  assert.equal(
    replacement.handoff.receive(frame(1, { generation: OTHER })).accepted,
    true,
  );
  assert.equal(
    old.handoff.receive(frame(2, { generation: OTHER })).reason,
    "sealed",
  );
  assert.equal(replacement.handoff.stats().node.acceptedRecords, 1);
  assert.equal(cancelled.counters.node.acknowledgementsIssued, 0);
});

test("raw/torn readback snapshots never become measurement records; existing reader owns settling and ACK", () => {
  const f = executedFixture(48000, {
    beforeDrain({ readback, reader, handoff, controls, page }) {
      const torn = page();
      torn[16]++;
      const before = controls.length;
      assert.equal(readback(torn), false);
      assert.equal(reader.stats().unstable, 1);
      assert.equal(handoff.stats().node.acceptedRecords, 0);
      assert.equal(controls.length, before);
    },
  });
  const count = f.handoff.stats().node.acceptedRecords;
  const snapshots = f.packets.filter(
    (packet) => packet[2] === "retention-snapshot",
  );
  assert(snapshots.length > 0);
  for (const snapshot of snapshots)
    assert.equal(f.handoff.receive(snapshot).measurement, false);
  assert.equal(f.handoff.stats().node.acceptedRecords, count);
  assert.equal(f.reader.stats().accepted, count);
  const reads = f.reader.stats();
  assert(reads.polls > reads.accepted);
});

test("configuration requires actual binding/geometry and does not infer a phase or add another reader/control owner", () => {
  const f = make();
  const config = {
    owner: OWNER,
    expected: f.expected,
    binding: f.controls,
  };
  for (const expected of [
    null,
    { ...f.expected, firstFrameEndCounter: undefined },
    { ...f.expected, expectedCount: 4 },
    { ...f.expected, supportSamples: 1024 },
    { ...f.expected, hopSamples: 1024 },
  ])
    assert.throws(
      () =>
        createMetricSpectrumHandoff(
          { ...config, expected },
          { collector: f.collector },
        ),
      SpectrumHandoffError,
    );
  for (const binding of [undefined, {}, { ...f.controls, ready: null }])
    assert.throws(
      () =>
        createMetricSpectrumHandoff(
          { ...config, binding },
          { collector: f.collector },
        ),
      SpectrumHandoffError,
    );
  assert.throws(
    () =>
      createMetricSpectrumHandoff(config, {
        collector: f.collector,
        acknowledge: () => {},
      }),
    /invalid_handoff_options/,
  );
});

test("upstream forwarding/ACK is not Node acceptance and this handoff never acknowledges twice", () => {
  const f = executedFixture(48000, { dropFirst: true });
  const delivery = f.handoff.finish();
  assert.equal(f.reader.stats().accepted, 5);
  assert.equal(
    f.controls
      .filter((control) => control[0] === "measurementAcknowledged")
      .at(-1)[1],
    5,
  );
  assert.equal(delivery.status, "partial");
  assert.equal(delivery.counters.node.acceptedRecords, 4);
  assert.equal(delivery.counters.node.acknowledgementsIssued, 0);
  assert.equal(delivery.gaps[0].firstSequence, 1);
  assert.equal(delivery.counters.upstream.forwardedRecords, 5);
  assert.equal(delivery.counters.upstream.acknowledgedSequence, 5);
  feedOtherFamilies(f);
  const result = f.collector.finalize({
    owner: OWNER,
    sourceEndSample: CAPTURE_END,
  });
  assert.equal(result.status, "partial");
  observation(f, result);
});

test("actual reader payload corruption retains an independently admitted prefix; header corruption is shared fatal", () => {
  for (const [cell, classification] of [
    [12, "metric"],
    [7, "shared"],
  ]) {
    const f = executedFixture(48000, {
      expectedAccepted: 1,
      beforeDrain({ readback, reader, handoff, controls, page, step }) {
        readback(page());
        assert.equal(readback(page()), true);
        assert.equal(handoff.stats().node.acceptedRecords, 1);
        const row = step();
        row[cell] = NaN;
        const acknowledgements = controls.filter(
          (control) => control[0] === "measurementAcknowledged",
        ).length;
        assert.equal(readback(row), false);
        assert.equal(reader.stats().state, "failed");
        assert.equal(handoff.finish().classification, classification);
        assert.equal(
          controls.filter((control) => control[0] === "measurementAcknowledged")
            .length,
          acknowledgements,
        );
      },
    });
    if (classification === "metric") feedOtherFamilies(f);
    const { delivery, result } = f.finish();
    assert.equal(
      result.status,
      classification === "metric" ? "partial" : "failed",
    );
    assert.equal(delivery.counters.node.acceptedRecords, 1);
    assert.equal(delivery.counters.node.acknowledgementsIssued, 0);
    if (classification === "metric") observation(f, result);
  }
});

test("actual immutable retained-slot mutation fails FFT only and never ACKs the changed candidate", () => {
  const f = executedFixture(48000, {
    expectedAccepted: 0,
    beforeDrain({ readback, page, reader }) {
      readback(page());
      const changed = page();
      changed[12]++;
      assert.equal(readback(changed), false);
      assert.equal(reader.stats().reason, "immutable_slot_changed");
    },
  });
  feedOtherFamilies(f);
  const { delivery, result } = f.finish();
  assert.equal(delivery.reason, "upstream_immutable_slot_changed");
  assert.equal(result.status, "partial");
  assert.deepEqual(
    f.controls
      .filter((control) => control[0] === "measurementAcknowledged")
      .map((control) => control[1]),
    [0],
  );
  observation(f, result);
});

test("unknown counters stay unknown; missing failure diagnostics are shared-fatal, not fabricated metric data", () => {
  const f = make();
  for (const key of [
    "producedSequence",
    "requestedSequence",
    "forwardedRecords",
    "acknowledgedSequence",
    "highWaterMark",
    "backlog",
  ])
    assert.equal(f.handoff.stats().upstream[key], null);
  const raw = [
    "native",
    GENERATION,
    "retention-state",
    2,
    4,
    OWNER.nativeEpoch,
    1,
    0,
    0,
    32,
    0,
    1,
    3,
  ];
  assert.equal(f.handoff.receive(raw).classification, "shared");
  assert.equal(f.finish().result.status, "failed");
  const malformed = make();
  assert.equal(
    malformed.handoff.receive(["native", GENERATION, "retention-snapshot", 2])
      .classification,
    "shared",
  );
});

test("explicit upstream FIFO exhaustion is spectral-local; levels continue beyond eight musical windows", () => {
  const f = make(
    collectorInput(48000, { captureEndSample: CAPTURE_START + 3 * 48000 }),
  );
  const failure = [
    "native",
    GENERATION,
    "retention-state",
    2,
    4,
    OWNER.nativeEpoch,
    1,
    33,
    0,
    32,
    32,
    100,
    1,
  ];
  assert.equal(f.handoff.receive(failure).classification, "metric");
  feedOtherFamilies(f);
  const { delivery, result } = f.finish();
  assert.equal(delivery.counters.upstream.backlog, 33);
  assert.equal(delivery.counters.upstream.highWaterMark, 32);
  assert(result.metrics.level.acceptedRecords > 8);
  assert.equal(result.metrics.attacks.status, "completed");
  assert.equal(result.status, "partial");
  observation(f, result);
});

test("admission is immutable and uses native coordinates; no post-creation phase/configuration substitution", () => {
  const f = make();
  const config = {
    owner: { ...OWNER },
    expected: { ...f.expected },
    binding: { abi: [...f.controls.abi], ready: [...f.controls.ready] },
  };
  const handoff = createMetricSpectrumHandoff(config, {
    collector: f.collector,
  });
  config.expected.firstFrameEndCounter += 2048;
  config.owner.nativeEpoch++;
  config.binding.ready[5]++;
  assert.equal(handoff.receive(frame(1)).accepted, true);
  assert.equal(handoff.admission.expected.firstFrameEndCounter, FIRST_END);
  assert(Object.isFrozen(handoff.admission.binding.ready));
  assert.throws(
    () =>
      createMetricSpectrumHandoff(
        {
          owner: OWNER,
          binding: f.controls,
          expected: {
            ...f.expected,
            captureStartSample: 1024,
            captureEndSample: 10240,
            firstFrameEndCounter: 2048,
          },
        },
        { collector: f.collector },
      ),
    /geometry_mismatch/,
  );
});

test("terminal events cover partial, failed and cancelled exactly once; sealed collector cannot accept a late frame", () => {
  for (const outcome of ["partial", "failed", "cancelled"]) {
    const f = make();
    if (outcome === "partial") f.handoff.receive(frame(1));
    const ended =
      outcome === "cancelled" ? f.handoff.cancel() : f.handoff.finish();
    assert.equal(ended.status, outcome);
    assert.equal(f.handoff.finish(), ended);
    assert.equal(f.handoff.cancel(), ended);
    assert.equal(f.handoff.receive(frame(2)).reason, "sealed");
    assert.deepEqual(
      f.events
        .filter((event) =>
          ["partial", "failed", "cancelled"].includes(event.stage),
        )
        .map((event) => event.stage),
      [outcome],
    );
  }
  const f = make();
  f.collector.cancel();
  assert.equal(f.handoff.receive(frame(1)).reason, "collector_sealed");
  assert.equal(f.handoff.finish().status, "cancelled");
  assert.equal(f.handoff.stats().node.acceptedRecords, 0);
  const peer = make();
  peer.handoff.receive(frame(1));
  assert.equal(
    peer.handoff.receive([
      "native",
      GENERATION,
      "retention-state",
      2,
      5,
      OWNER.nativeEpoch,
      2,
      5,
      0,
      32,
      5,
      10,
      0,
    ]).reason,
    "upstream_cancelled",
  );
  assert.equal(peer.handoff.finish().status, "cancelled");
  assert.equal(peer.handoff.receive(frame(2)).reason, "sealed");
  peer.collector.cancel();
});

test("ordinary production Node require loads the CommonJS adapter without test loaders", () => {
  const path = fileURLToPath(
    new URL("./audio_listener_metric_spectrum.js", import.meta.url),
  );
  const child = spawnSync(
    process.execPath,
    [
      "-e",
      `
    const api = require(process.argv[1]);
    if (typeof api.createMetricSpectrumHandoff !== "function" ||
        typeof api.SpectrumHandoffError !== "function") process.exit(1);
  `,
      path,
    ],
    { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } },
  );
  assert.equal(child.status, 0, child.stderr);
});

test("positive energy below the FFT division floor is not rewritten into silence", () => {
  const f = make(collectorInput(48000, { requestedMetrics: ["spectrum"] }));
  assert.equal(
    f.handoff.receive(frame(1, { energy: 1e-30, centroidHz: 0 })).accepted,
    true,
  );
  const { result } = f.finish();
  const saved = observation(f, result);
  assert.equal(saved.metrics["spectral-centroid"].records[0].centroidHz, 0);
  assert.equal(
    saved.metrics["spectral-centroid"].records[0].spectralEnergy,
    1e-30,
  );
});

test("maximum-duration spectrum admission bounds retained fingerprints and progress without another FIFO", () => {
  const f = make(
    collectorInput(48000, {
      captureEndSample: CAPTURE_START + 30 * 48000,
      requestedMetrics: ["spectrum"],
    }),
  );
  for (let index = 1; index <= f.expected.expectedCount; index++)
    assert.equal(f.handoff.receive(frame(index)).accepted, true);
  const result = f.handoff.finish();
  assert.equal(result.status, "completed");
  assert.equal(result.counters.node.acceptedRecords, f.expected.expectedCount);
  assert.equal(result.counters.node.pendingHighWaterMark, 0);
  assert.equal(result.counters.node.pendingRecords, 0);
  assert(result.counters.node.acceptedRecords <= 706);
  assert(f.events.filter((event) => event.stage === "progress").length <= 128);
  assert.deepEqual(result.gaps, []);
});

test("handoff lifecycle is bounded, attributed, timed and contains counters not raw packets/audio", () => {
  const f = make();
  for (let hold = 0; hold < 1000; hold++) f.handoff.receive(frame(1));
  for (let index = 2; index <= 5; index++) f.handoff.receive(frame(index));
  const delivery = f.handoff.finish();
  const encoded = JSON.stringify(delivery);
  const count = f.events.length;
  assert.equal(f.handoff.receive(frame(5)).reason, "sealed");
  assert.equal(JSON.stringify(f.handoff.finish()), encoded);
  assert.equal(f.events.length, count);
  assert.equal(f.events[0].stage, "queued");
  assert.equal(f.events[1].stage, "started");
  assert.equal(f.events.at(-1).stage, "completed");
  assert(f.events.filter((event) => event.stage === "progress").length <= 128);
  for (let index = 0; index < f.events.length; index++) {
    const event = f.events[index];
    assert.equal(event.metricId, "spectrum");
    assert.equal(event.generation, GENERATION);
    assert.equal(event.nativeEpoch, OWNER.nativeEpoch);
    assert.equal(event.traceId, GENERATION);
    if (index) assert(event.elapsedMs >= f.events[index - 1].elapsedMs);
    assert(JSON.stringify(event).length < 2048);
    for (const key of ["packet", "values", "energy", "centroidHz", "audio"])
      assert.equal(Object.hasOwn(event, key), false);
  }
});
