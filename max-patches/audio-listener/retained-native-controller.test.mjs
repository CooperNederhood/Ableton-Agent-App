import "./native-protocol-test-loader.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { v2Fixture, V2_OWNER } = require("./native-v2-fixture.cjs");
const { nativeFailureDiagnosticV2Schema } =
  await import("../../packages/signal-routing/src/listener-v2-contracts.ts");
const { nativeListenerLifecycleV2Schema } =
  await import("../../packages/protocol/src/native-listening-v2-schemas.ts");

test("failed preflight retains bounded missing-prerequisite and clock-span lifecycle evidence", async () => {
  const f = v2Fixture({ retainedMeasurements: true, retentionReady: false });
  f.controller.prepare(f.command);
  const pending = f.controller.arm(V2_OWNER);
  for (let counter = 0; counter <= 49152; counter += 2048)
    f.packet("clock", f.clock(counter, false));
  await assert.rejects(pending, /stale_native_preflight/);
  const diagnostics = f.observed.filter((event) =>
    event.reason?.startsWith("native_preflight_"),
  );
  const reasons = diagnostics.map((event) => event.reason);
  assert(reasons.includes("native_preflight_missing_envelope_state"));
  assert(reasons.includes("native_preflight_missing_retention_envelope"));
  assert(reasons.includes("native_preflight_missing_retention_spectrum"));
  assert(reasons.includes("native_preflight_missing_abi_envelope"));
  assert(reasons.includes("native_preflight_clock_span_0_49152"));
  assert(diagnostics.length <= 16);
  for (const event of diagnostics) {
    nativeListenerLifecycleV2Schema.parse({
      scope: event.scope,
      eventId: event.eventId,
      causationId: event.causationId,
      phase: "preflight",
      generation: event.generation,
      stage: event.stage,
      nativeEpoch: event.nativeEpoch,
      elapsedMs: event.elapsedMs,
      frames: event.frames,
      reason: event.reason,
    });
    assert.equal(event.traceId, f.command.traceId);
  }
  f.controller.tick();
  assert.equal(
    f.observed.filter((event) => event.reason?.startsWith("native_preflight_"))
      .length,
    diagnostics.length,
  );
});

test("retained control allocates an immutable epoch before begin and requires both executed DSP handshakes", async () => {
  const f = v2Fixture({ retainedMeasurements: true, retentionReady: false });
  f.controller.prepare(f.command);
  const pending = f.controller.arm(V2_OWNER);
  const pass = f.controller.pass;
  const owner = pass.owner;
  assert.deepEqual(f.sent[0], {
    action: "begin",
    generation: pass.generation,
    nativeEpoch: 1,
    sampleRate: 48000,
  });
  assert(Object.isFrozen(owner));
  f.preflight();
  assert.equal(f.controller.state, "preflight");
  f.packet("retention-ready", [1, 1, 1]);
  assert.equal(f.controller.state, "preflight");
  f.packet("retention-ready", [2, 1, 1]);
  assert.equal(f.controller.state, "native-arming");
  assert.equal(pass.owner, owner);
  f.configReceipt();
  f.ack();
  await pending;
  assert.equal(pass.nativeEpoch, 1);
  f.controller.cancel(V2_OWNER);
  assert.equal(pass.closed, true);
  assert.deepEqual(pass.retentionReady, {});
});

test("missing or mixed retention capability fails explicitly without configuring or reusing a failed epoch", async () => {
  const f = v2Fixture({ retainedMeasurements: true, retentionReady: false });
  f.controller.prepare(f.command);
  const first = f.controller.arm(V2_OWNER);
  const generation = f.controller.pass.generation;
  f.preflight();
  f.time(2000);
  f.controller.tick();
  await assert.rejects(first, /native_measurement_readiness_timeout/);
  assert.equal(
    f.sent.some((event) => event.action === "configure_v2"),
    false,
  );
  f.packet("stopped", [0, 0, 2], generation);
  f.controller.prepare({ ...f.command, passId: "second-pass" });
  const next = f.controller.arm({ ...V2_OWNER, passId: "second-pass" });
  assert.equal(f.controller.pass.nativeEpoch, 2);
  f.packet("retention-ready", [1, 1, 1], generation);
  assert.deepEqual(f.controller.pass.retentionReady, {});
  f.packet("retention-ready", [2, 2, 2]);
  await assert.rejects(next, /native_measurement_readiness_mismatch/);
});

for (const rate of [44100, 48000])
  test(`latest envelope state cannot impersonate queued coverage at ${rate} Hz, including fractional tail`, async () => {
    const f = v2Fixture({ retainedMeasurements: true, rate, total: rate + 23 });
    await f.start();
    const pass = f.controller.pass;
    f.packet("envelope-state", f.envelope(f.geometry.hopSamples));
    assert.equal(pass.assembler.frames, 0);
    assert.equal(pass.envelopes.length, 0);
    assert.equal(pass.lastEnvelope, null);
    f.capture();
    f.post();
    const terminal = f.events.find((event) => event.type === "terminal");
    assert.equal(terminal.status, "complete");
    assert.equal(
      terminal.observation.endSample - terminal.observation.startSample,
      rate + 23,
    );
    assert.deepEqual(pass.retentionStats, {});
    const lifecycle = f.observed.filter(
      (event) => event.type === "native-measurement-stage",
    );
    for (const family of ["envelope", "spectrum"]) {
      const events = lifecycle.filter((event) => event.reason.includes(family));
      assert.deepEqual(
        events.map((event) => event.stage),
        ["queued", "started", "completed"],
      );
      assert.equal(events[1].causationId, events[0].eventId);
      assert.equal(events[2].causationId, events[1].eventId);
      assert(
        events.every(
          (event) =>
            event.traceId === f.command.traceId && event.nativeEpoch === 1,
        ),
      );
      const event = events.at(-1);
      nativeListenerLifecycleV2Schema.parse({
        scope: event.scope,
        eventId: event.eventId,
        causationId: event.causationId,
        phase: "measurement",
        generation: event.generation,
        stage: event.stage,
        nativeEpoch: event.nativeEpoch,
        elapsedMs: event.elapsedMs,
        frames: event.frames,
        reason: event.reason,
      });
    }
  });

for (const rate of [44100, 48000])
  for (const mode of ["descriptive", "strict"])
    test(`retained ${rate} Hz ${mode} descriptors keep source coordinates when delivery trails the live clock`, async () => {
      const f = v2Fixture({
        retainedMeasurements: true,
        rate,
        total: rate + 23,
        policy: {
          mode,
          maxClockDisagreementSamples: mode === "strict" ? 0 : 64,
        },
      });
      await f.start();
      const pass = f.controller.pass;
      let nextFFT = 64000 + 2048;
      for (
        let count = f.geometry.hopSamples;
        ;
        count = Math.min(count + f.geometry.hopSamples, f.geometry.totalSamples)
      ) {
        const end = f.origin + count;
        f.packet(
          "clock",
          f.clock(
            Math.max(end + 64, f.origin + 4 * f.geometry.hopSamples + 64),
          ),
        );
        while (nextFFT <= end) {
          f.packet("spectrum", f.spectrum(nextFFT));
          nextFFT += 2048;
        }
        f.packet("envelope", f.envelope(count));
        assert.equal(f.controller.pass, pass);
        if (count === f.geometry.totalSamples) break;
      }
      f.post();
      const terminals = f.events.filter((event) => event.type === "terminal");
      assert.equal(terminals.length, 1);
      assert.equal(terminals[0].status, "complete");
      const observation = terminals[0].observation;
      assert.deepEqual(
        observation.samples.map((sample) => sample.sample),
        Array.from(
          { length: 11 },
          (_, index) =>
            observation.startSample +
            Math.min(
              (index + 1) * f.geometry.hopSamples,
              f.geometry.totalSamples,
            ),
        ),
      );
      assert.equal(
        terminals[0].observation.endSample -
          terminals[0].observation.startSample,
        rate + 23,
      );
      assert.equal(pass.closed, true);
      assert.deepEqual(pass.retentionStats, {});
    });

test("retained descriptors beyond their declared delivery capacity fail without publication", async () => {
  const f = v2Fixture({ retainedMeasurements: true, total: 3 * 48000 });
  await f.start();
  const pass = f.controller.pass;
  const end = f.origin + f.geometry.hopSamples;
  for (let hop = 1; hop <= 18; hop++)
    f.packet("clock", f.clock(f.origin + hop * f.geometry.hopSamples + 64));
  for (let fft = 64000 + 2048; fft <= end; fft += 2048)
    f.packet("spectrum", f.spectrum(fft));
  f.packet("envelope", f.envelope(f.geometry.hopSamples));
  const terminal = f.events.find((event) => event.type === "terminal");
  assert.equal(terminal.reason, "host_sample_discontinuity");
  assert.notEqual(terminal.status, "complete");
  assert.equal(pass.closed, true);
  assert.equal(
    f.events.some((event) => event.status === "complete"),
    false,
  );
  const diagnostic = f.events.find((event) =>
    event.reason?.startsWith("native_descriptor_clock_"),
  );
  assert(diagnostic);
  assert.equal(diagnostic.traceId, f.command.traceId);
  assert.equal(diagnostic.correlationId, f.command.correlationId);
  assert.equal(diagnostic.nativeEpoch, pass.nativeEpoch);
  assert.equal(terminal.reason, "host_sample_discontinuity");
  assert(diagnostic.reason.length <= 128);
  nativeListenerLifecycleV2Schema.parse({
    scope: diagnostic.scope,
    eventId: diagnostic.eventId,
    causationId: diagnostic.causationId,
    phase: "capture",
    generation: pass.generation,
    stage: diagnostic.stage,
    nativeEpoch: diagnostic.nativeEpoch,
    elapsedMs: diagnostic.elapsedMs,
    frames: diagnostic.frames,
    reason: diagnostic.reason,
  });
});

for (const future of [true, false])
  test(`retained descriptors reject ${future ? "future source coordinates" : "missing native-clock evidence"}`, async () => {
    const f = v2Fixture({ retainedMeasurements: true });
    await f.start();
    const engine = f.controller.engine;
    const ingest = engine.ingest.bind(engine);
    engine.ingest = (frame, owner, timing) =>
      ingest(
        frame,
        owner,
        future
          ? { ...timing, counter: f.origin + f.geometry.hopSamples - 1 }
          : { capacity: timing.capacity },
      );
    f.capture();
    const terminal = f.events.find((event) => event.type === "terminal");
    assert(terminal);
    assert.notEqual(terminal.status, "complete");
    assert.equal(f.controller.pass, null);
    assert.equal(
      f.events.some((event) => event.status === "complete"),
      false,
    );
  });

test("owned queue overflow retains strict bounded evidence and emits one failure without publication", async () => {
  const f = v2Fixture({ retainedMeasurements: true });
  await f.start();
  const pass = f.controller.pass;
  f.packet("retention-state", [2, 4, 1, 1, 32, 0, 32, 32, 100, 1]);
  f.packet("ioError", [1], pass.generation);
  const terminals = f.events.filter((event) => event.type === "terminal");
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0].reason, "native_measurement_queue_overflow");
  assert.equal(terminals[0].status, "failed");
  const diagnostic = terminals[0].nativeFailureDiagnostic;
  nativeFailureDiagnosticV2Schema.parse(diagnostic);
  assert.equal(diagnostic.scope, "native-measurement-delivery-rejection/v1");
  assert.equal(diagnostic.generation, pass.generation);
  assert.equal(diagnostic.producedSequence, 32);
  assert.equal(diagnostic.acknowledgedSequence, 0);
  assert.equal(diagnostic.highWaterMark, 32);
  assert.equal(
    f.events.some((event) => event.status === "complete"),
    false,
  );
  assert.deepEqual(pass.retentionStats, {});
  assert.equal(f.sent.at(-1).outcome, "failed");
});

test("same controller releases success, failure, and cancellation before a fresh owned success", async () => {
  const first = v2Fixture({ retainedMeasurements: true });
  const generations = [];
  const ids = [];
  for (const [index, outcome] of [
    "complete",
    "failed",
    "cancelled",
    "complete",
  ].entries()) {
    const f =
      index === 0
        ? first
        : v2Fixture({
            retainedMeasurements: true,
            controller: first.controller,
            armCounter: 65536 + index * 100352,
            fftBaseline: 64000 + index * 100352,
          });

    f.command.passId = `repeat-${index}`;
    await f.start();
    const pass = f.controller.pass;
    generations.push(pass.generation);
    ids.push(pass.command.passId);
    assert.equal(pass.nativeEpoch, index + 1);
    if (outcome === "complete") {
      f.capture();
      f.post();
    } else if (outcome === "failed")
      f.packet("retention-state", [1, 4, index + 1, 1, 16, 0, 16, 16, 100, 1]);
    else f.controller.cancel({ ...V2_OWNER, passId: f.command.passId });
    assert.equal(first.controller.state, outcome);
    assert.equal(first.controller.pass, null);
    assert.deepEqual(pass.retentionReady, {});
    assert.deepEqual(pass.retentionStats, {});
    f.packet("stopped", [0, 0, 2], pass.generation);
    assert.equal(first.controller.pendingDisarm, null);
  }
  assert.equal(new Set(generations).size, 4);
  assert.equal(new Set(ids).size, 4);
  assert.equal(
    first.events.filter(
      (event) => event.type === "terminal" && event.status === "complete",
    ).length,
    2,
  );
});

test("reentrant cancellation at collection completion cannot publish the displaced completed observation", async () => {
  let f;
  f = v2Fixture({
    retainedMeasurements: true,
    observe: (event) => {
      if (
        event.type === "native-measurement-stage" &&
        event.stage === "completed"
      )
        f.controller.cancel(V2_OWNER);
    },
  });
  await f.start();
  const pass = f.controller.pass;
  f.capture();
  f.post();
  assert.equal(f.controller.pass, null);
  assert.equal(f.controller.state, "cancelled");
  assert.equal(pass.closed, true);
  assert.equal(
    f.events.some((event) => event.status === "complete"),
    false,
  );
  assert.deepEqual(pass.retentionStats, {});
});
