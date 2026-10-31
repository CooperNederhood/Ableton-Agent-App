import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { genModel } from "./gen-model.mjs";
import {
  retainedNativeEnvelopeSource,
  retainedNativeSpectrumSource,
  retainedNativePrototypeDocuments,
} from "./retained-native-source.mjs";
import { descriptiveSpectrumCode } from "./synchronized-spectrum-source.mjs";
import { validateDocument } from "../../scripts/audio-listener-device.mjs";

const { NativeDescriptorAssembler } = createRequire(import.meta.url)(
  "./audio_listener_native_assembler.js",
);
const measurements = createRequire(import.meta.url)(
  "./audio_listener_measurements.js",
);

test("both native prototype compositions keep every declaration before expressions", () => {
  for (const source of [
    retainedNativeEnvelopeSource(),
    retainedNativeSpectrumSource(),
  ]) {
    const stripped = source.code.replace(/\/\/[^\n]*/g, " ");
    const body = stripped.replace(
      /^(?:\s*(?:Param|History|Buffer|Data|Delay)\s+\w+\s*\([^;]*\)\s*;)*/,
      "",
    );
    assert.doesNotMatch(
      body,
      /\b(?:Param|History|Buffer|Data|Delay)\s+\w+\s*\(/,
    );
    assert.equal(source.retention.storageBytes, 2560);
    assert.equal(source.retention.readbackWidth, source.retention.width + 14);
  }
});

test("native-host prototype documents expose complete readback without selecting production graphs", () => {
  const documents = retainedNativePrototypeDocuments();
  assert.equal(Object.keys(documents).length, 2);
  for (const [name, document] of Object.entries(documents)) {
    assert.match(name, /-prototype\.gendsp$/);
    assert.doesNotThrow(() => validateDocument(document));
    const codebox = document.patcher.boxes.find(
      ({ box }) => box.maxclass === "codebox",
    ).box;
    assert.equal(codebox.numoutlets, name.includes("envelope") ? 53 : 31);
  }
});
for (const rate of [44100, 48000])
  test(`actual ${rate}Hz FFT producer retains frames that latest-only polling loses`, () => {
    const retained = retainedNativeSpectrumSource();
    const latest = genModel(descriptiveSpectrumCode(), 10, rate);
    const queued = genModel(retained.code, retained.outputs, rate);
    queued.configure({ measurementEpoch: 1 });
    let before;
    const published = [];
    const origin = 2 ** 32;
    for (let frame = 0; frame < 4; frame++) {
      for (let bin = 0; bin < 2048; bin++) {
        const counter = origin + frame * 2048 + bin;
        const inputs = [
          bin === 32 ? 1 : 0,
          0,
          bin === 64 ? 2 : 0,
          0,
          bin,
          counter % 1048576,
          Math.floor(counter / 1048576),
        ];
        before = latest.step(...inputs);
        const after = queued.step(...inputs);
        assert.deepEqual(after.slice(0, 10), before);
        if (bin === 2047) published.push([...before]);
      }
    }
    assert.equal(before[3], origin + 8192);
    const output = queued.step(0, 0, 0, 0, 0, 8192, 4096);
    const page = output.slice(11);
    assert.equal(page[4], 1);
    assert.equal(page[5], origin);
    assert.equal(page[6], origin + 2048);
    assert.deepEqual(page.slice(10, 16), [
      published[0][3],
      published[0][0],
      published[0][1],
      published[0][2],
      published[0][3],
      published[0][4],
    ]);
    assert.equal(page[7], 4);
    assert.notEqual(page[14], before[3]);

    const owner = {
      passId: "controlled-delayed-read",
      connectionEpoch: "owned-model",
      nativeEpoch: 1,
    };
    const makeAssembler = () =>
      new NativeDescriptorAssembler({
        owner,
        armCounter: origin - 512,
        originCounter: origin,
        hostOffsetSamples: 0,
        geometry: {
          sampleRate: rate,
          hopSamples: rate / 10,
          totalSamples: rate / 5,
        },
        invalidFrames: 0,
        onFrame: () => true,
        onFailure: () => {},
      });

    const envelope = (index) => ({
      nativeEpoch: 1,
      armCounter: origin - 512,
      originCounter: origin,
      endCounter: origin + (index * rate) / 10,
      peak: [0.8, 0.6],
      rms: [0.3, 0.2],
    });
    const latestOnly = makeAssembler();
    latestOnly.pushSpectrum(
      [before[3], before[0], before[1], before[2], before[3], before[4]],
      owner,
    );
    assert.throws(
      () => latestOnly.pushEnvelope(envelope(1), owner),
      /native_fft_window_missing/,
    );
    const retainedAssembly = makeAssembler();
    retainedAssembly.pushEnvelope(envelope(1), owner);
    retainedAssembly.pushEnvelope(envelope(2), owner);
    const reader = measurements.createReader({
      declaration: {
        version: 1,
        kind: "native-spectrum/v2",
        algorithmVersion: "2.0.0",
        sampleRate: rate,
        hopSamples: 2048,
        windowSamples: 2048,
        width: 6,
        capacity: 32,
        fields: [
          { name: "endCounter", unit: "samples" },
          { name: "centroidHz", unit: "Hz" },
          { name: "energy", unit: "linear" },
          { name: "startCounter", unit: "samples" },
          { name: "frameEnd", unit: "samples" },
          { name: "invalidFrames", unit: "count" },
        ],
      },
      epoch: 1,
      ownerContext: {
        generation: "owned-model-generation",
        ...owner,
      },
      consume: (record) => {
        assert.equal(record.startSample, record.values[3]);
        assert.equal(record.endSample, record.values[0]);
        return retainedAssembly.pushSpectrum(record.values, owner);
      },
    });
    reader.begin();
    let current = page;
    let readCounter = origin + 8193;
    const advance = () => {
      const bin = (readCounter - origin) % 2048;
      const low = readCounter % 1048576;
      const high = Math.floor(readCounter++ / 1048576);
      return queued.step(0, 0, 0, 0, bin, low, high).slice(11);
    };
    for (let sequence = 1; sequence <= 4; sequence++) {
      assert.equal(current[4], sequence);
      assert.equal(reader.poll(current).status, "settling");
      current = advance();
      const accepted = reader.poll(current);
      assert.equal(accepted.status, "accepted", JSON.stringify(accepted));
      assert.notEqual(reader.poll(current).status, "failed");
      for (const action of accepted.actions) {
        queued.configure(
          action.type === "request"
            ? { measurementReadSequence: action.sequence }
            : { measurementAcknowledged: action.sequence },
        );
        current = advance();
      }
    }
    assert.equal(reader.complete().status, "completed");
    assert.equal(reader.stats().accepted, 4);
    assert.equal(retainedAssembly.state, "covered");
    assert.equal(retainedAssembly.frames, 2);
    assert.equal(retainedAssembly.spectralWindows(owner).length, 2);
  });

for (const rate of [44100, 48000])
  test(`actual ${rate}Hz envelope producer retains complete hops and fractional tail`, () => {
    const source = retainedNativeEnvelopeSource();
    const model = genModel(source.code, source.outputs, rate);
    const hop = rate / 10;
    const total = hop * 3 + 1;
    let counter = 2 ** 32;
    const step = (phase = 0.75) => model.step(phase, 0.25, -0.5, counter++);
    for (let index = 0; index < 2048; index++) step();
    model.configure({
      totalSamples: total,
      hopSamples: hop,
      tempoBpm: 120,
      startBeatFraction: 0.375,
      captureVector: 64,
      epoch: 1,
      measurementEpoch: 1,
    });
    step();
    const launchOrigin = 145;
    for (let clock = 1; clock < launchOrigin + 64 + hop * 5; clock++)
      step(
        clock < launchOrigin + 64
          ? 0.75
          : (0.375 + (clock - launchOrigin) / (rate / 2)) % 1,
      );
    let row = step().slice(23);
    assert.equal(row[7], 4);
    assert.equal(row[9], 0);
    const firstStart = row[5];
    let previousEnd = firstStart;
    for (let sequence = 1; sequence <= 4; sequence++) {
      assert.equal(row[4], sequence);
      assert.equal(row[5], previousEnd);
      assert.equal(row[6] - row[5], sequence === 4 ? 1 : hop);
      assert.equal(row[10], 1);
      assert.equal(row[22], Math.min(sequence * hop, total));
      assert.equal(row[24] + row[22], row[6]);
      previousEnd = row[6];
      model.configure({ measurementReadSequence: sequence + 1 });
      step();
      model.configure({ measurementAcknowledged: sequence });
      row = step().slice(23);
    }
    assert.equal(previousEnd - firstStart, total);
  });
