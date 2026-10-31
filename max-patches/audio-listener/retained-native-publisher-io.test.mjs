import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { genModel } from "./gen-model.mjs";
import {
  retainedNativeEnvelopeSource,
  retainedNativeSpectrumSource,
} from "./retained-native-source.mjs";
const { NativeMessageIO } = createRequire(import.meta.url)(
  "./audio_listener_native_io.js",
);

for (const rate of [44100, 48000])
  for (const family of ["envelope", "spectrum"])
    test(`actual ${rate}Hz ${family} publisher crosses retained native IO without latest-snapshot substitution`, () => {
      const source =
        family === "envelope"
          ? retainedNativeEnvelopeSource()
          : retainedNativeSpectrumSource();
      const model = genModel(source.code, source.outputs, rate);
      const packets = [],
        diagnostics = [],
        controls = [];
      const generation = "11111111-1111-4111-8111-111111111111";
      let counter = 2 ** 32,
        bin = 0;
      let phase = 0.75;
      const step = () => {
        const result =
          family === "envelope"
            ? model.step(phase, 0.25, -0.5, counter++)
            : model.step(
                bin === 32 ? 1 : 0,
                0,
                bin === 64 ? 2 : 0,
                0,
                bin,
                counter % 1048576,
                Math.floor(counter++ / 1048576),
              );
        bin = (bin + 1) % 2048;
        return result.slice(source.outputs - source.retention.readbackWidth);
      };
      const io = new NativeMessageIO(
        family,
        (packet) => {
          packets.push(packet);
          return true;
        },
        (control) => {
          controls.push(control);
          if (control[0] !== "poll")
            model.configure({ [control[0]]: control[1] });
          return true;
        },
        (reason) => diagnostics.push(reason),
        2,
        { retainedMeasurements: true, now: () => 0 },
      );
      assert.equal(io.begin(generation, 1, rate), true);
      for (let i = 0; i < 4; i++) io.retainedFrame(step());
      assert.equal(
        packets.filter((packet) => packet[2] === "retention-ready").length,
        1,
      );
      if (family === "spectrum") {
        for (let frame = 0; frame < 4; frame++)
          for (let i = 0; i < 2048; i++) step();
      } else {
        for (let warmup = 0; warmup < 1024; warmup++) step();
        const hop = rate / 10,
          total = hop * 3 + 1;
        assert.equal(
          io.configureV2(generation, [total, hop, 120, 0.375, 64]),
          true,
        );
        assert.equal(io.arm(generation, 1), true);
        step();
        const launch = 145;
        for (let clock = 1; clock < launch + 64 + hop * 5; clock++) {
          phase =
            clock < launch + 64
              ? 0.75
              : (0.375 + (clock - launch) / (rate / 2)) % 1;
          step();
        }
      }
      assert.equal(
        packets.some((packet) => packet[2] === family),
        false,
      );
      const before = step();
      assert.equal(
        before[7],
        4,
        JSON.stringify({ before, packets, diagnostics, controls }),
      );
      assert.equal(before[9], 0);
      for (let poll = 0; poll < 20; poll++) io.retainedFrame(step());
      const delivered = packets.filter((packet) => packet[2] === family);
      assert.equal(
        delivered.length,
        4,
        JSON.stringify({ packets, diagnostics, controls }),
      );
      assert.equal(
        packets.some((packet) => packet[2] === "ioError"),
        false,
      );
      assert.deepEqual(diagnostics, []);
      for (let i = 0; i < 4; i++) {
        const values = delivered[i].slice(3);
        assert.equal(delivered[i][1], generation);
        if (family === "envelope")
          assert.equal(
            values[12],
            Math.min(((i + 1) * rate) / 10, (3 * rate) / 10 + 1),
          );
        else {
          assert.equal(values[4] - values[3], 2048);
          if (i) assert.equal(values[4] - delivered[i - 1][7], 2048);
          assert(values[4] > 2 ** 32);
        }
      }
      const acknowledgements = controls.filter(
        ([name]) => name === "measurementAcknowledged",
      );
      assert.deepEqual(
        acknowledgements.map(([, value]) => value),
        [0, 1, 2, 3, 4],
      );
      assert.equal(io.stop(generation, "complete"), true);
      assert.equal(step()[1], 0);
      const releasedCount = packets.length;
      assert.equal(io.retainedFrame(before), false);
      assert.equal(packets.length, releasedCount);
    });
