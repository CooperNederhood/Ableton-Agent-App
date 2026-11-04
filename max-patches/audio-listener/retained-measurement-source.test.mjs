import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { retainedMeasurementSource } from "./retained-measurement-source.mjs";
import { genModel } from "./gen-model.mjs";
const measurements = createRequire(import.meta.url)(
  "./audio_listener_measurements.js",
);

function fixture({ width = 2, capacity = 4, rate = 48000 } = {}) {
  const source = retainedMeasurementSource({
    capacity,
    publish: "in1",
    startSample: "in2",
    endSample: "in3",
    values: Array.from({ length: width }, (_, index) => `in4 + ${index}`),
  });
  const model = genModel(
    `${source.declarations}\n${source.step}\n${source.outputs}`,
    source.readbackWidth,
    rate,
  );
  model.configure({ measurementEpoch: 1 });
  return { source, model };
}

test("private retention stores bounded descriptors, never an audio buffer", () => {
  const { source, model } = fixture();
  assert.equal(source.storageBytes, 192);
  assert.equal(source.readbackWidth, 16);
  assert.match(source.declarations, /Data measurementRecords\(4, 6\)/);
  assert.doesNotMatch(source.declarations, /Buffer|Delay/);
  const empty = model.step();
  assert.equal(empty[1], 1);
  assert.equal(empty[4], 0);
  assert.equal(empty[7], 0);
  for (const [literal] of (
    source.declarations +
    source.step +
    source.outputs
  ).matchAll(/\b\d+(?:\.\d+)?\b/g))
    assert(Number(literal) <= 2147483647, `unsupported Gen literal ${literal}`);
});

for (const rate of [44100, 48000])
  for (const width of [1, 6, 13, 16])
    test(`retention preserves ${width}-value descriptors at ${rate}Hz across a delayed read`, () => {
      const { model } = fixture({ width, rate });
      for (let frame = 0; frame < 4; frame++)
        model.step(
          1,
          2 ** 32 + frame * 2048,
          2 ** 32 + (frame + 1) * 2048,
          frame + 0.123456789012345,
        );
      for (let sequence = 1; sequence <= 4; sequence++) {
        const row = model.step();
        assert.equal(row[9], 0);
        assert.equal(row[4], sequence);
        assert.equal(row[5], 2 ** 32 + (sequence - 1) * 2048);
        assert.equal(row[6], 2 ** 32 + sequence * 2048);
        for (let index = 0; index < width; index++)
          assert.equal(
            row[10 + index],
            sequence - 1 + 0.123456789012345 + index,
          );
        assert.equal(row[10 + width], sequence);
        model.configure({ measurementReadSequence: sequence + 1 });
        model.step();
        model.configure({ measurementAcknowledged: sequence });
        model.step();
      }
    });

test("an unread slot is immutable and overflow is latched instead of overwriting", () => {
  const { model } = fixture({ capacity: 2 });
  const first = model.step(1, 0, 2048, 10);
  model.step(1, 2048, 4096, 20);
  assert.deepEqual(model.step().slice(3, 7), first.slice(3, 7));
  const overflow = model.step(1, 4096, 6144, 30);
  assert.equal(overflow[7], 2);
  assert.equal(overflow[9], 1);
  model.configure({ measurementReadSequence: 2, measurementAcknowledged: 1 });
  assert.equal(model.step()[9], 1);
});

test("acknowledged slots wrap in FIFO order without changing the source counter", () => {
  const { model } = fixture({ capacity: 2 });
  for (let sequence = 1; sequence <= 20; sequence++) {
    const row = model.step(1, sequence * 4800, (sequence + 1) * 4800, sequence);
    assert.equal(row[4], sequence);
    assert.equal(row[5], sequence * 4800);
    assert.equal(row[9], 0);
    model.configure({ measurementReadSequence: sequence + 1 });
    model.step();
    model.configure({ measurementAcknowledged: sequence });
    model.step();
  }
});

test("a consumer cannot acknowledge an unread batch in one jump", () => {
  const { model } = fixture();
  for (let sequence = 1; sequence <= 3; sequence++)
    model.step(1, sequence * 2048, (sequence + 1) * 2048, sequence);
  model.configure({ measurementReadSequence: 4, measurementAcknowledged: 3 });
  const rejected = model.step();
  assert.equal(rejected[8], 0);
  assert.equal(rejected[9], 2);
});

test("delayed DSP ACK application cannot make the real reader skip a Gen acknowledgement", () => {
  const { model } = fixture();
  for (let sequence = 1; sequence <= 3; sequence++)
    model.step(1, (sequence - 1) * 2048, sequence * 2048, sequence);
  const records = [];
  const reader = measurements.createReader({
    declaration: {
      version: 1,
      kind: "scalar",
      algorithmVersion: "v1",
      sampleRate: 48000,
      hopSamples: 2048,
      windowSamples: 2048,
      width: 2,
      capacity: 4,
      fields: [
        { name: "a", unit: "linear" },
        { name: "b", unit: "linear" },
      ],
    },
    epoch: 1,
    consume(record) {
      records.push(record);
      return true;
    },
  });
  reader.begin();
  reader.poll(model.step());
  assert.equal(reader.poll(model.step()).status, "accepted");
  model.configure({ measurementReadSequence: 2 });
  const unacknowledged = model.step();
  assert.equal(unacknowledged[8], 0);
  reader.poll(unacknowledged);
  const pending = reader.poll(unacknowledged);
  for (const action of pending.actions)
    model.configure({
      [action.type === "request"
        ? "measurementReadSequence"
        : "measurementAcknowledged"]: action.sequence,
    });
  assert.equal(
    model.step()[9],
    0,
    "a second ACK must not overwrite the still-unexecuted first ACK",
  );
  assert.equal(pending.status, "waiting");
  model.configure({ measurementAcknowledged: 1 });
  const committed = model.step();
  const next = reader.poll(committed);
  assert.equal(next.status, "accepted");
  for (const action of next.actions)
    model.configure({
      [action.type === "request"
        ? "measurementReadSequence"
        : "measurementAcknowledged"]: action.sequence,
    });
  assert.equal(model.step()[9], 0);
  assert.deepEqual(
    records.map((record) => record.sequence),
    [1, 2],
  );
});

test("new capture ownership invalidates old slots without storing or clearing audio", () => {
  const { model } = fixture({ capacity: 2 });
  model.step(1, 1000, 2000, 10);
  model.step(1, 2000, 3000, 20);
  model.step(1, 3000, 4000, 30);
  model.configure({
    measurementReadSequence: 1,
    measurementAcknowledged: 0,
    measurementEpoch: 2,
  });
  const reset = model.step();
  assert.equal(reset[1], 2);
  assert.equal(reset[3], 0);
  assert.equal(reset[7], 0);
  assert.equal(reset[9], 0);
  const next = model.step(1, 5000, 6000, 40);
  assert.equal(next[3], 2);
  assert.equal(next[4], 1);
  assert.equal(next[10], 40);
});

test("disarm hides retained data and a DSP reset cannot continue an old read cursor", () => {
  const { model } = fixture();
  model.step(1, 0, 2048, 10);
  model.configure({ measurementReadSequence: 2 });
  model.step();
  model.configure({ measurementAcknowledged: 1 });
  model.step();
  model.reset();
  assert.equal(model.step()[9], 2);
  model.configure({ measurementEpoch: 0 });
  const disarmed = model.step();
  assert.equal(disarmed[1], 0);
  assert.equal(disarmed[4], 0);
  assert.equal(disarmed[7], 0);
  model.configure({
    measurementReadSequence: 1,
    measurementAcknowledged: 0,
    measurementEpoch: 2,
  });
  const fresh = model.step(1, 10000, 12048, 20);
  assert.equal(fresh[3], 2);
  assert.equal(fresh[4], 1);
  assert.equal(fresh[9], 0);
});

test("invalid acknowledgements cannot free unread records or corrupt memory", () => {
  for (const parameters of [
    { measurementAcknowledged: 1 },
    { measurementReadSequence: 0 },
    { measurementReadSequence: 2 },
    { measurementReadSequence: 1.5 },
    { measurementEpoch: -1 },
    { measurementEpoch: 1000001 },
  ]) {
    const { model } = fixture();
    model.configure(parameters);
    assert.equal(model.step()[9], 2, JSON.stringify(parameters));
  }
});

test("producer declarations cannot create oversized or malformed native storage", () => {
  const base = {
    capacity: 16,
    values: ["in4"],
    publish: "in1",
    startSample: "in2",
    endSample: "in3",
  };
  for (const change of [
    { capacity: 0 },
    { capacity: 129 },
    { capacity: 1.5 },
    { values: [] },
    { values: Array(65).fill("in4") },
    { values: ["in1; out1 = 7"] },
    { firstOutput: 0 },
    { name: "invalid-name" },
  ])
    assert.throws(
      () => retainedMeasurementSource({ ...base, ...change }),
      /invalid_retained_measurement/,
    );
});
