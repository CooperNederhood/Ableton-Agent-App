import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { genModel } from "./gen-model.mjs";
import {
  descriptiveEnvelopeCode,
  musicalEnvelopeCode,
  musicalEnvelopeDocument,
  MUSICAL_CONFIGURATION_FIELDS,
  MUSICAL_RECORD_FIELDS,
} from "./synchronized-envelope-source.mjs";
import {
  retainedMusicalEnvelopeSource,
  retainedMusicalEnvelopeDocument,
  retainedNativeEnvelopeSource,
} from "./retained-native-source.mjs";
import { nativeRuntimeDocuments } from "./native-runtime-source.mjs";

const { createReader, createMetricDeclaration, normalizeMetricRecord } =
  createRequire(import.meta.url)("./audio_listener_measurements.js");
const hash = (value) => createHash("sha256").update(value).digest("hex");

function geometry(rate, tempo, startBeat, endBeat, vector = 64) {
  const at = (beat) => Math.round(((beat - startBeat) * rate * 60) / tempo);
  const total = at(endBeat);
  const bounds = [0];
  for (let grid = Math.floor(startBeat * 4) + 1; grid / 4 < endBeat; grid++)
    bounds.push(at(grid / 4));
  bounds.push(total);
  return {
    rate,
    tempo,
    startBeat,
    endBeat,
    vector,
    total,
    bounds,
    parameters: {
      totalSamples: total,
      hopSamples: rate / 10,
      tempoBpm: tempo,
      startBeatFraction: startBeat - Math.floor(startBeat),
      captureVector: vector,
      levelConfigurationVersion: 1,
      reportStartBeat: startBeat,
      reportEndBeat: endBeat,
      reportRowCount: bounds.length - 1,
    },
  };
}

function harness(g, pcm = () => [0, 0], options = {}) {
  const model = genModel(
    options.code ??
      descriptiveEnvelopeCode({
        configurationReadback: true,
        musicalLevels: true,
      }),
    options.outputs ?? 44,
    g.rate,
  );
  model.configure(g.parameters);
  model.configure(options.parameters ?? {});
  let counter = 2 ** 32;
  const stopped = 0.618;
  for (let i = 0; i < 2048; i++) model.step(stopped, 0, 0, counter++);
  model.configure({ epoch: 1 });
  let output = model.step(stopped, 0, 0, counter++);
  const armCounter = counter - 1;
  const origin = armCounter + 128;
  let sample = -127;
  return {
    model,
    rate: g.rate,
    origin,
    armCounter,
    get output() {
      return output;
    },
    get sample() {
      return sample - 1;
    },
    step() {
      const phase =
        sample < g.vector
          ? stopped
          : (g.startBeat + (sample * g.tempo) / (g.rate * 60)) % 1;
      const values = sample >= 0 && sample < g.total ? pcm(sample) : [0, 0];
      output = model.step(phase, ...values, counter++);
      sample++;
      return output;
    },
    run(visit, extra = 0) {
      while (sample <= g.total + g.vector + 2 + extra) visit(this.step());
    },
  };
}

test("opt-in production Gen closes its first 128 BPM musical level row at sample 5625, not the legacy 4800-sample hop", () => {
  const g = geometry(48000, 128, 0, 4);
  const h = harness(g);
  let first = null;
  h.run((output) => {
    if (first === null && output[12] > 0) first = output[12];
  });
  assert.equal(first, 5625);
});

function reference(bounds, pcm) {
  return bounds.slice(1).map((end, index) => {
    const start = bounds[index];
    let peakL = 0,
      peakR = 0,
      sumL = 0,
      sumR = 0;
    for (let sample = start; sample < end; sample++) {
      const [left, right] = pcm(sample);
      peakL = Math.max(peakL, Math.abs(left));
      peakR = Math.max(peakR, Math.abs(right));
      sumL += left * left;
      sumR += right * right;
    }
    return [index + 1, start, end, end - start, peakL, peakR, sumL, sumR];
  });
}

function detectorBounds(g) {
  const result = [0];
  for (let end = g.rate / 10; end < g.total; end += g.rate / 10)
    result.push(end);
  result.push(g.total);
  return result;
}

function collect(g, pcm) {
  const h = harness(g, pcm);
  const levels = [],
    attacks = [];
  h.run((output) => {
    assert.equal(output[4], 0);
    for (const [offset, records] of [
      [28, levels],
      [36, attacks],
    ]) {
      const sequence = output[offset];
      if (sequence > records.length) {
        assert.equal(sequence, records.length + 1);
        const row = output.slice(offset, offset + 8);
        records.push(row);
        assert.equal(h.sample, row[2] + g.vector - 1);
        if (offset === 28) {
          assert.deepEqual(output.slice(8, 12), [
            row[4],
            row[5],
            Math.sqrt(row[6] / row[3]),
            Math.sqrt(row[7] / row[3]),
          ]);
        }
      }
    }
  });
  assert.equal(h.output[5], 0);
  assert.equal(h.output[15], 3);
  assert.equal(h.output[14], h.origin);
  assert.deepEqual(levels, reference(g.bounds, pcm));
  assert.deepEqual(attacks, reference(detectorBounds(g), pcm));
  return { h, levels, attacks };
}

for (const rate of [44100, 48000]) {
  for (const [tempo, start, end] of [
    [128, 0, 4],
    [93.7, 5.13, 5.91],
    [137, 12.125, 13.01],
    [999, 100.249, 101.251],
  ]) {
    test(`${rate}Hz ${tempo}BPM ${start}..${end}: production Gen equals independent per-sample PCM at every clipped global grid boundary`, () => {
      const g = geometry(rate, tempo, start, end);
      const pcm = (sample) => [
        sample % 7 === 0 ? -0.5 : 0.125,
        sample % 11 === 0 ? 0.75 : -0.25,
      ];
      const { levels, attacks } = collect(g, pcm);
      assert.equal(levels.at(-1)[2], g.total);
      assert.equal(attacks.at(-1)[2], g.total);
      if (tempo === 137)
        assert(new Set(levels.slice(1, -1).map((row) => row[3])).size > 1);
    });
  }
  test(`${rate}Hz: impulses on either side of a musical boundary belong to exactly one physical row`, () => {
    const g = geometry(rate, 128, 0, 1);
    const edge = g.bounds[1];
    const { levels } = collect(g, (sample) => [
      sample === edge ? 1 : 0,
      sample === edge - 1 ? -0.5 : 0,
    ]);
    assert.deepEqual(levels[0].slice(4), [0, 0.5, 0, 0.25]);
    assert.deepEqual(levels[1].slice(4), [1, 0, 1, 0]);
  });
  for (const vector of [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024]) {
    test(`${rate}Hz vector${vector}: a sub-100ms fractional capture retains sample zero and its one exact tail`, () => {
      const g = geometry(rate, 128, 8.13, 8.2, vector);
      assert(g.total < rate / 10);
      const { levels, attacks } = collect(g, (sample) => [
        sample === 0 ? 1 : 0,
        sample === g.total - 1 ? -0.5 : 0,
      ]);
      assert.equal(levels.length, 1);
      assert.equal(attacks.length, 1);
      assert.equal(levels[0][3], g.total);
    });
  }
  test(`${rate}Hz: a one-sample clip remains a measured row even when shorter than the retained vector`, () => {
    const g = geometry(rate, 128, 0, 128 / (rate * 60), 1024);
    assert.equal(g.total, 1);
    const { levels, attacks } = collect(g, () => [0.5, -0.25]);
    assert.deepEqual(levels, [[1, 0, 1, 1, 0.5, 0.25, 0.25, 0.0625]]);
    assert.deepEqual(attacks, levels);
  });
  test(`${rate}Hz: valid silence has nonempty exact coverage in both independent cadences`, () => {
    const g = geometry(rate, 20, 1.99, 2.26);
    const { levels, attacks } = collect(g, () => [0, 0]);
    assert(
      levels.every((row) => row[3] > 0 && row.slice(4).every((v) => v === 0)),
    );
    assert(
      attacks.every((row) => row[3] > 0 && row.slice(4).every((v) => v === 0)),
    );
  });
}

test("the physical 100ms detector equals legacy PCM summaries while musical rows use a different cadence", () => {
  const g = geometry(48000, 128, 0, 4);
  const pcm = (sample) => [
    sample % 301 < 15 ? 0.875 : 0.0625,
    sample % 503 < 32 ? -0.5 : 0,
  ];
  const { levels, attacks } = collect(g, pcm);
  assert.equal(levels[0][2], 5625);
  assert.equal(attacks[0][2], 4800);
  const legacy = harness(g, pcm, {
    code: descriptiveEnvelopeCode({ configurationReadback: true }),
    outputs: 23,
  });
  const rows = [];
  let completed = 0;
  legacy.run((output) => {
    if (output[12] !== completed) {
      completed = output[12];
      rows.push(output.slice(8, 13));
    }
  }, g.rate / 10);
  assert.deepEqual(
    rows,
    attacks.map((row) => [
      row[4],
      row[5],
      Math.sqrt(row[6] / row[3]),
      Math.sqrt(row[7] / row[3]),
      row[2],
    ]),
  );
});

for (const rate of [44100, 48000]) {
  test(`${rate}Hz: 30s at999BPM independently rounds up to1999 musical rows without hop drift`, () => {
    const start = 10.13;
    const g = geometry(rate, 999, start, start + 499.5, 1024);
    assert.equal(g.total, rate * 30);
    assert.equal(g.bounds.length - 1, 1999);
    const { levels, attacks } = collect(g, (sample) => [
      sample === g.total - 1 ? 1 : 0,
      sample === 0 ? -0.5 : 0,
    ]);
    assert.equal(levels.length, 1999);
    assert.equal(attacks.length, 300);
    assert.equal(
      levels.reduce((sum, row) => sum + row[3], 0),
      g.total,
    );
    assert.equal(
      attacks.reduce((sum, row) => sum + row[3], 0),
      g.total,
    );
  });
}

test("opt-in is explicit and every default shipping graph/source remains byte-identical", () => {
  for (const [version, expected] of [
    [1, "d102081c366e48f040661f4d08d0ae8c597f8549ee0493a341c3f0fd2fe4473e"],
    [2, "31f79ee084b39a3eead7d7a63dd7781aa1ee38f33b88fd2537efaef1efe7136e"],
    [3, "31f79ee084b39a3eead7d7a63dd7781aa1ee38f33b88fd2537efaef1efe7136e"],
    [4, "838b20d3ba61c2cf933c02d53d283aa57a9c7ad537d7a5c2eba5a77e76493b57"],
  ])
    assert.equal(
      hash(JSON.stringify(nativeRuntimeDocuments({ nativeVersion: version }))),
      expected,
    );
  assert.equal(
    hash(descriptiveEnvelopeCode({ configurationReadback: true })),
    "02051b221f89df2c1280c89f210d1c8882edff0651be9dae6b98b87c1a57e3a7",
  );
  assert.equal(
    hash(retainedNativeEnvelopeSource().code),
    "9fdaa673f0b5bf999234f2929871478f9cf65babfad961f750dc2295a0b25e93",
  );
  assert.equal(
    musicalEnvelopeDocument().patcher.boxes[0].box.code,
    musicalEnvelopeCode(),
  );
  assert.equal(
    retainedMusicalEnvelopeDocument().patcher.boxes[0].box.code,
    retainedMusicalEnvelopeSource().code,
  );
});

for (const [name, value] of [
  ["levelConfigurationVersion", 0],
  ["levelConfigurationVersion", 2],
  ["reportStartBeat", -1],
  ["reportEndBeat", 0],
  ["reportRowCount", 2001],
  ["reportRowCount", 15],
  ["totalSamples", 90001],
  ["hopSamples", 5625],
  ["captureVector", 3],
  ["tempoBpm", 1000],
]) {
  test(`invalid opt-in geometry ${name}=${value} cannot seal or measure`, () => {
    const h = harness(geometry(48000, 128, 0, 4), undefined, {
      parameters: { [name]: value },
    });
    for (let step = 0; step < 2048; step++) h.step();
    assert.equal(h.output[4], 13);
    assert.equal(h.output[5], 0);
    assert.equal(h.output[26], 0);
    assert.equal(h.output[28], 0);
    assert.equal(h.output[36], 0);
  });
}

test("rounded-empty clipped rows are denied rather than duplicated or padded", () => {
  const g = geometry(48000, 128, 0.25 - 1e-8, 0.5);
  const h = harness(g);
  assert.equal(g.bounds[1], 0);
  assert.equal(h.output[4], 13);
  assert.equal(h.output[26], 0);
});

for (const field of Object.keys(geometry(48000, 128, 5.13, 5.91).parameters)) {
  test(`frozen DSP geometry rejects live ${field} mutation without echoing the setter`, () => {
    const g = geometry(48000, 128, 5.13, 5.91);
    const h = harness(g);
    const expected = [
      1,
      g.total,
      g.rate / 10,
      g.tempo,
      g.startBeat % 1,
      g.vector,
      1,
      g.startBeat,
      g.endBeat,
      g.bounds.length - 1,
      1,
      1,
    ];
    assert.deepEqual(h.output.slice(16, 28), expected);
    for (let step = 0; step < 256; step++) h.step();
    const before = h.output.slice(28, 44);
    h.model.configure({ [field]: g.parameters[field] + 1 });
    h.step();
    assert.equal(h.output[4], 13);
    assert.equal(h.output[5], 0);
    expected[10] = 0; // the DSP seal is revoked; frozen histories stay unchanged
    assert.deepEqual(h.output.slice(16, 28), expected);
    assert.deepEqual(h.output.slice(28, 44), before);
  });
}

test("sample-rate mutation revokes the executed seal and active capture", () => {
  // genModel's samplerate is intentionally immutable; splice an input only at
  // this test seam to exercise the exact shipping samplerate guard.
  const g = geometry(48000, 128, 0, 4);
  const code = musicalEnvelopeCode().replaceAll("samplerate", "in5");
  const model = genModel(code, 44, g.rate);
  model.configure(g.parameters);
  for (let i = 0; i < 2048; i++) model.step(0.618, 0, 0, i, 48000);
  model.configure({ epoch: 1 });
  assert.equal(model.step(0.618, 0, 0, 2048, 48000)[26], 1);
  const output = model.step(0.618, 0, 0, 2049, 44100);
  assert.equal(output[4], 13);
  assert.equal(output[26], 0);
});

test("cancellation and nonfinite/oversized PCM do not invent final level or detector tails", () => {
  for (const cause of ["cancel", NaN, Infinity, 65]) {
    const g = geometry(48000, 128, 0, 4);
    const h = harness(g, (sample) =>
      sample === 20000 && cause !== "cancel" ? [cause, 0] : [0.25, -0.5],
    );
    while (h.sample < 20000 + g.vector) {
      h.step();
      if (cause === "cancel" && h.sample === 20000)
        h.model.configure({ cancel: 1 });
    }
    assert.equal(h.output[4], cause === "cancel" ? 4 : 15);
    const prefix = h.output.slice(28, 44);
    for (let i = 0; i < 10000; i++) h.step();
    assert.deepEqual(h.output.slice(28, 44), prefix);
    assert.equal(h.output[5], 0);
    assert(h.output[30] < g.total);
    assert(h.output[38] < g.total);
  }
});

// The existing generic reader exercises framing/retention only here. Its
// one-sample declaration is not a negotiated variable-window metric capability.
function framingReaders(
  h,
  source,
  consume = () => true,
  { metricDeclarations = false } = {},
) {
  return ["level", "attacks"].map((family) => {
    const retention = source[family];
    const reader = createReader({
      declaration: metricDeclarations
        ? createMetricDeclaration({
            family: family === "level" ? "level" : "detector-level",
            sampleRate: h.rate,
          })
        : {
            version: 1,
            kind: "musical-framing-test",
            algorithmVersion: "1",
            sampleRate: h.rate,
            hopSamples: 1,
            windowSamples: 1,
            width: 8,
            capacity: 16,
            fields: MUSICAL_RECORD_FIELDS.map((name) => ({
              name,
              unit: "descriptor",
            })),
          },
      epoch: 1,
      now: () => 0,
      consume: (record) => consume(family, record),
    });
    reader.begin();
    h.model.configure({
      [retention.parameters.epoch]: 1,
      [retention.parameters.requestedSequence]: 1,
      [retention.parameters.acknowledgedSequence]: 0,
    });
    return {
      reader,
      poll(output) {
        const first = source.readbacks[family].firstOutput - 1;
        const row = output.slice(first, first + source.readbacks[family].width);
        const result = reader.poll(row);
        for (const action of result.actions ?? [])
          h.model.configure({
            [action.type === "request"
              ? retention.parameters.requestedSequence
              : retention.parameters.acknowledgedSequence]: action.sequence,
          });
        return result;
      },
    };
  });
}

test("both bounded retained DSP families deliver exact sufficient statistics and global headers through existing FIFO framing", () => {
  const g = geometry(48000, 128, 5.13, 6.01);
  const pcm = (sample) => [
    sample % 5 ? 0.125 : -0.5,
    sample % 7 ? -0.25 : 0.75,
  ];
  const source = retainedMusicalEnvelopeSource();
  const h = harness(g, pcm, { code: source.code, outputs: source.outputs });
  const records = { level: [], attacks: [] };
  const readers = framingReaders(h, source, (family, record) => {
    records[family].push(record);
    return true;
  });
  h.run((output) => {
    assert.equal(output[2], 0);
    for (const reader of readers) reader.poll(output);
  }, 8);
  for (const [family, bounds] of [
    ["level", g.bounds],
    ["attacks", detectorBounds(g)],
  ]) {
    assert.deepEqual(
      records[family].map((record) => record.values),
      reference(bounds, pcm),
    );
    for (const record of records[family]) {
      assert.equal(record.startSample, h.origin + record.values[1]);
      assert.equal(record.endSample, h.origin + record.values[2]);
      assert.equal(Object.isFrozen(record.values), true);
    }
  }
  for (const { reader } of readers) {
    reader.complete();
    assert.equal(reader.stats().state, "completed");
  }
  assert.equal(source.envelopeAbi, 3);
  assert.equal(source.outputs, 64);
  assert.equal(source.configurationVersion, 1);
  assert.equal(source.level.capacity, 16);
  assert.equal(source.attacks.capacity, 16);
  assert.equal(source.level.storageBytes + source.attacks.storageBytes, 3072);
  assert.deepEqual(source.configuration.fields, MUSICAL_CONFIGURATION_FIELDS);
});

for (const rate of [44100, 48000]) {
  for (const [tempo, startBeat, endBeat] of [
    [128, 0, 1.1],
    [137.3, 5.13, 6.01],
    [999, 0, 4],
  ]) {
    test(`${rate}Hz/${tempo}BPM: actual retained Gen moments pass versioned variable-window readers against independent PCM`, () => {
      const g = geometry(rate, tempo, startBeat, endBeat);
      const pcm = (sample) => [
        sample % 5 ? 0.125 : -0.5,
        sample % 7 ? -0.25 : 0.75,
      ];
      const source = retainedMusicalEnvelopeSource();
      const h = harness(g, pcm, { code: source.code, outputs: source.outputs });
      const expected = {
        level: reference(g.bounds, pcm),
        attacks: reference(detectorBounds(g), pcm),
      };
      const accepted = { level: [], attacks: [] };
      const readers = framingReaders(
        h,
        source,
        (family, record) => {
          const row = expected[family][record.sequence - 1];
          assert.ok(row);
          const normalized = normalizeMetricRecord(
            record,
            createMetricDeclaration({
              family: family === "level" ? "level" : "detector-level",
              sampleRate: rate,
            }),
            {
              sequence: row[0],
              startSample: row[1],
              endSample: row[2],
              sourceOriginCounter: h.origin,
            },
          );
          assert.deepEqual(normalized.peak, row.slice(4, 6));
          assert.deepEqual(normalized.sumSquares, row.slice(6, 8));
          assert.deepEqual(normalized.rms, [
            Math.sqrt(row[6] / row[3]),
            Math.sqrt(row[7] / row[3]),
          ]);
          accepted[family].push(normalized);
          return true;
        },
        { metricDeclarations: true },
      );
      h.run((output) => {
        for (const reader of readers) {
          const result = reader.poll(output);
          assert.notEqual(result.status, "failed");
        }
      }, 8);
      for (const family of ["level", "attacks"]) {
        assert.equal(accepted[family].length, expected[family].length);
        assert.equal(
          accepted[family].reduce((sum, record) => sum + record.count, 0),
          g.total,
        );
      }
    });
  }
}

for (const rate of [44100, 48000]) {
  test(`${rate}Hz: consecutive 100ms-plus-one-sample detector records both survive retained readback`, () => {
    const total = rate / 10 + 1;
    const g = geometry(rate, 128, 0, (total * 128) / (rate * 60));
    const source = retainedMusicalEnvelopeSource();
    const pcm = (sample) => [sample === total - 1 ? 1 : 0, -0.25];
    const h = harness(g, pcm, { code: source.code, outputs: source.outputs });
    const records = { level: [], attacks: [] };
    const readers = framingReaders(h, source, (family, record) => {
      records[family].push(record.values);
      return true;
    });
    h.run((output) => {
      for (const reader of readers) reader.poll(output);
    }, 8);
    assert.deepEqual(records.level, reference(g.bounds, pcm));
    assert.deepEqual(records.attacks, reference([0, rate / 10, total], pcm));
    assert.equal(records.attacks[1][3], 1);
    assert.equal(records.attacks[1][4], 1);
  });
}

test("a stalled musical reader faults at16 without growing/overwriting or stopping the separate 100ms detector", () => {
  const g = geometry(48000, 999, 0, 8);
  const source = retainedMusicalEnvelopeSource();
  const h = harness(g, () => [0.25, -0.5], {
    code: source.code,
    outputs: source.outputs,
  });
  const detector = [];
  const readers = framingReaders(h, source, (family, record) => {
    if (family === "attacks") detector.push(record.values);
    return true;
  });
  let first = null;
  h.run((output) => {
    if (output[24] === 1 && first === null) first = output.slice(30, 38);
    readers[1].poll(output);
  }, 8);
  const output = h.output;
  assert.equal(output[27], 16);
  assert.equal(output[28], 0);
  assert.equal(output[29], 1);
  assert.deepEqual(output.slice(30, 38), first);
  assert.equal(output[2], 0);
  assert.equal(output[3], 0);
  assert.deepEqual(
    detector,
    reference(detectorBounds(g), () => [0.25, -0.5]),
  );
  assert.equal(output[51], 0); // independent detector ring has no fault
});

test("cancel/disarm clears both retained owners without publishing a padded partial row", () => {
  const g = geometry(48000, 128, 0, 4);
  const source = retainedMusicalEnvelopeSource();
  const h = harness(g, () => [0.25, -0.5], {
    code: source.code,
    outputs: source.outputs,
  });
  framingReaders(h, source);
  while (h.sample < 20000) h.step();
  const before = h.output;
  assert(before[27] > 0);
  assert(before[49] > 0);
  h.model.configure({ cancel: 1 });
  for (let step = 0; step < 1000; step++) h.step();
  assert.equal(h.output[2], 4);
  assert.equal(h.output[27], before[27]);
  assert.equal(h.output[49], before[49]);
  h.model.configure({
    epoch: 0,
    levelMeasurementEpoch: 0,
    attackMeasurementEpoch: 0,
  });
  h.step();
  assert.equal(h.output[0], 0);
  assert.equal(h.output[3], 0);
  for (const first of [20, 42]) {
    assert.equal(h.output[first + 1], 0);
    assert.equal(h.output[first + 7], 0);
    assert.equal(h.output[first + 8], 0);
    assert(
      h.output.slice(first + 10, first + 18).every((value) => value === 0),
    );
  }
});
