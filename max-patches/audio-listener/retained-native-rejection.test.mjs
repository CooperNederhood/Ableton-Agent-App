import "./native-protocol-test-loader.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { v2Fixture } = require("./native-v2-fixture.cjs");
const { NativeMessageIO } = require("./audio_listener_native_io.js");
const { nativeFailureDiagnosticV2Schema } =
  await import("../../packages/signal-routing/src/listener-v2-contracts.ts");

function rejectionPacket(epoch = 1) {
  const packets = [];
  const io = new NativeMessageIO(
    "spectrum",
    (p) => packets.push(p),
    () => {},
    () => {},
    2,
    { retainedMeasurements: true, now: () => 1 },
  );
  io.begin("11111111-1111-4111-8111-111111111111", epoch, 48000);
  const row = [
    1,
    epoch,
    1,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    1,
    epoch,
  ];
  io.retainedFrame(row);
  io.retainedFrame(row);
  const invalid = row.slice();
  invalid[10] = "secret=not-a-cell";
  io.retainedFrame(invalid);
  const packet = packets.find((p) => p[2] === "retention-rejection");
  assert.ok(packet);
  return packet.slice(3);
}

test("controller attaches first owned bounded reader evidence to the unchanged delivery failure", async () => {
  const f = v2Fixture({ retainedMeasurements: true });
  await f.start();
  const pass = f.controller.pass;
  const values = rejectionPacket(pass.nativeEpoch);
  assert.equal(f.packet("retention-rejection", values, "foreign"), false);
  const drain = f.controller.drain;
  f.controller.drain = () =>
    assert.fail("diagnostic evidence cannot drain capture");
  assert.equal(f.packet("retention-rejection", values), true);
  const changed = values.slice();
  changed[1] = 1;
  f.packet("retention-rejection", changed);
  f.controller.drain = drain;
  f.packet("retention-state", [
    2,
    4,
    pass.nativeEpoch,
    38,
    37,
    36,
    32,
    1,
    100,
    3,
  ]);
  f.packet("ioError", [1], pass.generation);
  const terminal = f.events.filter((e) => e.type === "terminal");
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].reason, "native_measurement_delivery_failed");
  assert.equal(terminal[0].status, "failed");
  const diagnostic = terminal[0].nativeFailureDiagnostic;
  assert.equal(diagnostic.readerReason, "invalid_numeric");
  assert.equal(diagnostic.readerReadbacks.length, 3);
  assert.equal(diagnostic.readerReadbacks[2].cells[10], "invalid:string");
  assert.equal(JSON.stringify(diagnostic).includes("secret="), false);
  assert.deepEqual(
    nativeFailureDiagnosticV2Schema.parse(diagnostic),
    diagnostic,
  );
  assert.equal(
    f.events.some((e) => e.status === "complete"),
    false,
  );
  assert.equal(f.sent.at(-1).action, "stop");
});

test("malformed numeric rejection operands cannot enter controller evidence", async () => {
  for (const mutate of [
    (p) => p.pop(),
    (p) => {
      p[0] = 3;
    },
    (p) => {
      p[1] = 100;
    },
    (p) => {
      p[3] = 4;
    },
    (p) => {
      p[5] = 99;
    },
    (p) => {
      p[6] = Infinity;
    },
  ]) {
    const f = v2Fixture({ retainedMeasurements: true });
    await f.start();
    const values = rejectionPacket();
    mutate(values);
    assert.equal(f.packet("retention-rejection", values), false);
    assert.equal(
      f.events.some((e) => e.status === "complete"),
      false,
    );
    assert.equal(f.controller.pass, null);
  }
});
