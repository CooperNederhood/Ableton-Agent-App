import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { URL } from "node:url";
import { synchronizedAnalysisDocument } from "./calibration-source.mjs";

const require = createRequire(import.meta.url);
const { HostedCalibrationCollector } = require("./hosted_calibration_probe.js");
const trace = "11111111-1111-4111-8111-111111111111";
const packet = (sample, reference = [0.25, 0.25]) => [
  sample,
  1,
  576,
  1000,
  1,
  0,
  1,
  64,
  1000,
  0.5,
  0.5,
  0.25,
  0.25,
  ...reference,
];
const ack = [0, 1, -1, -1, 0, 0, 0, -1, -1, 0, 0, 0, 0, 0, 0];

test("actual Max script exposes reference handlers globally without starting a poll before an owned request", () => {
  const emitted = [];
  const context = {
    outlet: (...values) => emitted.push(values),
    arrayfromargs: (value) => Array.from(value),
    Task: function () {
      this.repeat = () => {};
      this.cancel = () => {};
    },
  };
  runInNewContext(
    readFileSync(
      new URL("./hosted_calibration_probe.js", import.meta.url),
      "utf8",
    ),
    context,
  );
  assert.equal(typeof context.start_reference, "function");
  assert.equal(typeof context.rms_reference, "function");
  assert.equal(
    emitted.some((row) => row.includes("reference_poll")),
    false,
  );
  context.start_reference("runner-owned", trace, 1);
  context.rms_reference(...ack);
  context.rms_reference(...packet(4800));
  assert.equal(context.hostedCollector.result.frames.length, 1);
  assert.equal(context.hostedCollector.result.frames[0][7], 0.25);
  context.notifydeleted();
});

function fixture() {
  let now = 0;
  const controls = [],
    emitted = [];
  const collector = new HostedCalibrationCollector({
    now: () => now,
    control: (...values) => controls.push(values),
    emit: (...values) => emitted.push(values),
  });
  collector.startReference("runner-owned", trace, 1);
  return {
    collector,
    controls,
    emitted,
    time: (value) => {
      now = value;
    },
  };
}

test("reference graph uses independent MSP RMS and integer delay, latched at exact native window completion", () => {
  const normal = synchronizedAnalysisDocument();
  const document = synchronizedAnalysisDocument({ rmsReference: true });
  const boxes = new Map(document.patcher.boxes.map(({ box }) => [box.id, box]));
  assert.equal(boxes.get("refDelay0").text, "delay~ 64 64");
  assert.equal(boxes.get("refAverage0").text, "average~ 4800 rms");
  assert.equal(boxes.get("refInterval").text, "4800");
  assert.equal(boxes.get("refDone").text, "delta~");
  assert.equal(boxes.get("refHold0").text, "sah~ 0");
  assert.equal(boxes.get("channels").numinlets, 15);
  assert.equal(boxes.get("gate").numoutlets, 15);
  assert.equal(boxes.get("pack").numinlets, 16);
  assert.equal(boxes.get("poll").text, "qmetro 10 @active 0");
  const connected = (source, outlet, destination, inlet) =>
    document.patcher.lines.some(
      ({ patchline }) =>
        patchline.source[0] === source &&
        patchline.source[1] === outlet &&
        patchline.destination[0] === destination &&
        patchline.destination[1] === inlet,
    );
  assert.ok(connected("gen", 12, "refDone", 0));
  assert.ok(connected("refDone", 0, "refHold0", 1));
  assert.ok(connected("refInterval", 0, "refAverage0", 0));
  assert.ok(connected("refHold0", 0, "channels", 13));
  assert.ok(connected("gate", 12, "pack", 1));
  assert.ok(connected("gate", 14, "refHot", 0));
  assert.ok(connected("refHot", 1, "pack", 15));
  assert.ok(connected("collector", 1, "refRoute", 0));
  assert.ok(connected("refRoute", 0, "poll", 0));
  assert.ok(connected("refRoute", 1, "gen", 0));
  assert.equal(connected("collector", 1, "gen", 0), false);
  assert.equal(
    normal.patcher.boxes.some(({ box }) => box.id === "refDone"),
    false,
  );
});

test("reference collection preserves native ACK/order, 100 bounded paired rows, trace timing and leave-running cleanup", () => {
  const f = fixture();
  assert.equal(
    f.controls.some((values) => values.includes("start_playing")),
    false,
  );
  f.collector.referenceFrame(ack);
  assert.equal(
    f.controls.filter((values) => values.includes("start_playing")).length,
    1,
  );
  for (let index = 1; index <= 100; index++) {
    f.time(index * 100);
    f.collector.referenceFrame(packet(index * 4800));
  }
  assert.equal(
    f.collector.result.schema,
    "hosted-native-envelope-reference/v1",
  );
  assert.equal(f.collector.result.outcome, "collected");
  assert.equal(f.collector.result.frames.length, 100);
  assert.ok(
    f.collector.result.frames.every(
      (row) => row.length === 9 && row[7] === 0.25 && row[8] === 0.25,
    ),
  );
  assert.equal(f.collector.result.reference.integerDelaySamples, 64);
  const events = f.collector.result.events;
  assert.equal(events.at(-1).stage, "completed");
  assert.equal(events.at(-1).elapsedMs, 10000);
  assert.ok(
    events.every(
      (event) => event.traceId === trace && event.correlationId === trace,
    ),
  );
  assert.equal(
    f.controls.some((values) => values.includes("stop_playing")),
    false,
  );
  f.collector.dump();
  const rows = f.emitted
    .filter(([kind]) => kind === "chunk")
    .flatMap(([, body]) => JSON.parse(body).frames);
  assert.deepEqual(rows, f.collector.result.frames);
});

test("reference failures, changed holds, cancellation and timeout remain explicit and disarm native analysis", () => {
  for (const kind of ["nonfinite", "hold", "cancel", "timeout"]) {
    const f = fixture();
    f.collector.referenceFrame(ack);
    if (kind === "nonfinite")
      f.collector.referenceFrame(packet(4800, [NaN, 0]));
    if (kind === "hold") {
      f.collector.referenceFrame(packet(4800));
      f.collector.referenceFrame(packet(4800, [0.3, 0.25]));
    }
    if (kind === "cancel") f.collector.cancel();
    if (kind === "timeout") {
      f.time(12000);
      f.collector.tick();
    }
    assert.equal(f.collector.state, "done");
    assert.equal(
      f.collector.result.outcome,
      kind === "cancel" ? "cancelled" : "failed",
    );
    assert.ok(
      f.controls.some(
        (values) =>
          values[0] === "native" && values[1] === "epoch" && values[2] === 0,
      ),
    );
    assert.equal(
      f.controls.some((values) => values.includes("stop_playing")),
      false,
    );
  }
});
