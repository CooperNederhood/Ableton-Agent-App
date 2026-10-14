import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { URL } from "node:url";

const source = await readFile(
  new URL("./audio_listener_guard.js", import.meta.url),
  "utf8",
);
const a = "11111111-1111-4111-8111-111111111111";
const b = "22222222-2222-4222-8222-222222222222";
function fixture() {
  const controls = [],
    events = [];
  const context = {
    Task: function () {
      this.repeat = () => {};
      this.cancel = () => {
        this.cancelled = true;
      };
    },
    outlet: (...values) => controls.push(values),
    post: (value) =>
      events.push(JSON.parse(value.slice("native-watchdog ".length))),
  };
  runInNewContext(source, context);
  const prepare = (generation, trace = "trace") => {
    context.native_watchdog_context(generation, trace, "correlation", "cause");
    context.begin(generation);
  };
  return { context, controls, events, prepare };
}

test("native watchdog fails closed without context and cancels only its exact generation after lost heartbeat", () => {
  const { context, controls, events, prepare } = fixture();
  context.begin(a);
  assert.deepEqual(controls, [[2, "stop", a]]);
  assert.equal(events[0].reason, "native_context_required");
  controls.length = 0;
  events.length = 0;
  prepare(a);
  context.arm(a, 1);
  for (let i = 0; i < 7; i++) context.check();
  assert.deepEqual(controls, []);
  context.check();
  assert.deepEqual(controls, [[2, "stop", a]]);
  assert.deepEqual(
    events.map((event) => event.stage),
    ["queued", "started", "progress", "failed"],
  );
  assert.equal(events.at(-1).reason, "native_heartbeat_timeout");
  assert.equal(events.at(-1).elapsedMs, 2000);
  assert.equal(events.at(-1).traceId, "trace");
  assert.equal(events.at(-1).captureOutcome, "unknown");
  assert.equal(context.nativeGeneration, null);
  context.check();
  assert.equal(controls.length, 1);
});

test("replacement and stale arm/stop cannot renew or cancel another native generation", () => {
  const { context, controls, events, prepare } = fixture();
  prepare(a, "trace-a");
  prepare(b, "trace-b");
  assert.deepEqual(controls, [[2, "stop", a]]);
  context.stop(a);
  context.arm(a, 1);
  for (let i = 0; i < 8; i++) context.check();
  assert.deepEqual(controls, [
    [2, "stop", a],
    [2, "stop", b],
  ]);
  assert.equal(
    events.find((event) => event.reason === "generation_replaced").traceId,
    "trace-a",
  );
  assert.equal(events.at(-1).traceId, "trace-b");
  assert.equal(events.at(-1).generation, b);
});

test("duplicate begin and invalid owned epochs fail closed exactly once", () => {
  for (const action of ["duplicate", 0, 1.5, 1000001, "1"]) {
    const { context, controls, events, prepare } = fixture();
    prepare(a);
    if (action === "duplicate") context.begin(a);
    else context.arm(a, action);
    assert.deepEqual(controls, [[2, "stop", a]]);
    assert.equal(events.at(-1).stage, "failed");
    assert.equal(
      events.at(-1).reason,
      action === "duplicate" ? "duplicate_begin" : "invalid_native_epoch",
    );
    assert.equal(context.nativeGeneration, null);
    context.stop(a);
    context.check();
    assert.equal(controls.length, 1);
  }
});

test("native total bound expires despite healthy Node heartbeats and never controls transport", () => {
  const { context, controls, events, prepare } = fixture();
  prepare(a);
  for (let i = 0; i < 120; i++) {
    context.heartbeat();
    context.check();
  }
  assert.deepEqual(controls, [[2, "stop", a]]);
  assert.equal(events.at(-1).reason, "native_total_timeout");
  assert.equal(events.at(-1).elapsedMs, 30000);
  assert.doesNotMatch(
    source,
    /LiveAPI|start_playing|stop_playing|current_song_time/,
  );
});

test("owned stop completes monitoring, not capture, and local trace payloads are bounded/redacted", () => {
  const { context, controls, events } = fixture();
  context.native_watchdog_context(
    a,
    "trace",
    "token=private",
    "github_pat_private",
  );
  context.begin(a);
  context.stop(a);
  assert.deepEqual(controls, []);
  assert.equal(events.at(-1).stage, "completed");
  assert.equal(events.at(-1).reason, "owned_monitor_stop");
  assert.equal(events.at(-1).captureOutcome, "unknown");
  assert.equal(events.at(-1).correlationId, "[redacted]");
  assert.equal(events.at(-1).causationId, "[redacted]");
  assert.doesNotMatch(
    JSON.stringify(events),
    /token=private|github_pat_private/,
  );
  context.native_watchdog_context(
    "private-invalid-generation",
    "trace",
    "c",
    "p",
  );
  assert.equal(events.at(-1).reason, "invalid_context_generation");
  assert.doesNotMatch(JSON.stringify(events), /private-invalid-generation/);
});

test("pending context expires and deletion cancels owned DSP once while retaining legacy cleanup", () => {
  const { context, controls, events, prepare } = fixture();
  context.native_watchdog_context(a, "trace", "correlation", "cause");
  for (let i = 0; i < 8; i++) context.check();
  assert.equal(context.pendingContext, null);
  assert.equal(events.at(-1).reason, "pending_context_timeout");
  assert.deepEqual(controls, []);
  prepare(b);
  context.notifydeleted();
  assert.deepEqual(
    controls.filter(([outlet]) => outlet === 2),
    [[2, "stop", b]],
  );
  assert.equal(events.at(-1).stage, "cancelled");
  assert.equal(events.at(-1).reason, "device_deleted");
  assert.ok(controls.some((row) => row.join(":") === "0:mute:0:1"));
  assert.ok(controls.some((row) => row.join(":") === "1:reset"));
  assert.equal(context.timer.cancelled, true);
});
