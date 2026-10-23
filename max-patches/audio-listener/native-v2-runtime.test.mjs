/* global Buffer */
import "./native-protocol-test-loader.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createRuntime } = require("./audio_listener_runtime.js");
const { v2Fixture, V2_OWNER } = require("./native-v2-fixture.cjs");
const { AgentSignalClient } = require("../shared/agent_signal_client.js");
const {
  listenerRegistrationV2Schema,
  listenerControlV2Schema,
  listenerReplyV2Schema,
  listenerResultV2Schema,
} = await import("../../packages/signal-routing/src/listener-v2-contracts.ts");
const { assertNativeCaptureObservationV2 } =
  await import("../../packages/protocol/src/native-listening-v2-schemas.ts");

// The real SDK owns control validation, ownership, framing and sequencing.
// Discovery/authentication and native hardware are controlled in this fixture.
function fixture(options = {}) {
  const handlers = {},
    outputs = [],
    wire = [],
    timers = [],
    cleared = [];
  let now = 0,
    requests = 0,
    harness;
  class ControlHarnessClient extends AgentSignalClient {
    constructor(config) {
      super(config);
      this.options = config;
    }
    start() {
      this.started = true;
      this.authenticated = true;
      this.listener = {
        ...this.listener,
        connectionEpoch: V2_OWNER.connectionEpoch,
      };
      this.socket = {
        destroyed: false,
        destroy() {
          this.destroyed = true;
        },
        end() {
          this.destroyed = true;
        },
      };
    }
    writeMessage(frame) {
      if (!["listener.reply", "listener.result"].includes(frame.type))
        return true;
      assert(Buffer.byteLength(JSON.stringify(frame), "utf8") <= 128 * 1024);
      (frame.type === "listener.reply"
        ? listenerReplyV2Schema
        : listenerResultV2Schema
      ).parse(frame);
      if (options.reject?.(frame)) return false;
      wire.push(frame);
      options.onSend?.(frame, harness);
      return true;
    }
  }
  const runtime = createRuntime({
    nativeMode: true,
    nativeVersion: 2,
    Client: ControlHarnessClient,
    maxApi: {
      addHandler: (name, handler) => {
        handlers[name] = handler;
      },
      outlet: (...values) => {
        outputs.push(values);
        return options.onOutput?.(values, harness);
      },
    },
    env: {
      ABLETON_AGENT_SIGNAL_INGRESS_DESCRIPTOR:
        "/fixture/profile/descriptor.json",
      ABLETON_AGENT_SIGNAL_INGRESS_SECRET_PATH:
        "/fixture/profile/credential.json",
    },
    clock: () => now,
    interval: (fn) => {
      timers.push(fn);
      return fn;
    },
    clear: (fn) => cleared.push(fn),
  });
  const rate = options.rate ?? 48000;
  handlers.identity(
    JSON.stringify({
      canonicalPath: "live_set tracks 0 devices 0",
      track: { id: "1", name: "synthetic fixture" },
      device: { id: "2", name: "Audio-Listener" },
    }),
  );
  handlers.dsp(1, rate, options.vector ?? 64);
  handlers.host(0, 5.25, 1000000, 31);
  const f = v2Fixture({
    ...options,
    rate,
    controller: runtime.nativeController,
    setTime: (value) => {
      now = value;
    },
  });
  const dispatch = (action, patch = {}) => {
    const message = {
      ...V2_OWNER,
      traceId: "v2-trace",
      correlationId: "v2-correlation",
      causationId: "v2-root",
      jobId: "v2-job",
      requestId: `v2-request-${++requests}`,
      type: "listener.control",
      protocolVersion: 1,
      listenerVersion: 2,
      action,
      ...(action === "prepare"
        ? { config: { geometry: f.geometry, timingPolicy: f.timingPolicy } }
        : {}),
      ...patch,
    };
    listenerControlV2Schema.parse(message);
    return runtime.client.handleListenerControl(message);
  };
  const start = async () => {
    dispatch("prepare");
    const pending = dispatch("arm");
    f.preflight();
    f.configReceipt();
    f.ack();
    await pending;
    f.packet("clock", f.clock(f.origin + 640));
    f.packet("envelope", f.envelope());
    if (!options.reject && !options.onSend)
      assert.equal(
        runtime.nativeController.state,
        "capturing",
        JSON.stringify({ wire: wire.slice(-2), outputs: outputs.slice(-3) }),
      );
  };
  const stopReceipt = (
    generation = runtime.nativeController.pendingDisarm?.generation,
  ) => handlers.native(generation, "stopped", 0, 0, 2);
  harness = {
    ...f,
    runtime,
    handlers,
    outputs,
    wire,
    timers,
    cleared,
    dispatch,
    start,
    stopReceipt,
  };
  return harness;
}

test("v2 registration reports actual DSP rate and vector without inferring capture support or READY", () => {
  for (const [rate, vector] of [
    [44100, 32],
    [48000, 128],
    [96000, 2048],
    [48000, 65536],
  ]) {
    const f = fixture({ rate, vector });
    try {
      const registration = f.runtime.client.listener;
      listenerRegistrationV2Schema.parse(registration);
      assert.equal(registration.sampleRate, rate);
      assert.equal(registration.vectorSize, vector);
      assert.equal(registration.nativeStatus.readiness, "BLOCKED");
      assert.equal(f.runtime.nativeController.pass, null);
      assert.equal(
        f.outputs.some((row) => row[0] === "native_control"),
        false,
      );
      const ready = {
        ...registration,
        nativeStatus: { ...registration.nativeStatus, readiness: "READY" },
      };
      assert.equal(
        listenerRegistrationV2Schema.safeParse(ready).success,
        registration.nativeStatus.acceptedSampleRates.includes(rate) &&
          registration.nativeStatus.acceptedVectorSizes.includes(vector),
      );
      const oldClient = f.runtime.client;
      f.handlers.dsp(1, 44100, 256);
      assert.notEqual(f.runtime.client, oldClient);
      assert.equal(oldClient.authenticated, false);
      assert.equal(f.runtime.client.listener.sampleRate, 44100);
      assert.equal(f.runtime.client.listener.vectorSize, 256);
      listenerRegistrationV2Schema.parse(f.runtime.client.listener);
    } finally {
      f.runtime.stop();
    }
    assert.deepEqual(f.cleared, f.timers);
  }
});

test("v2 startup and envelope-rejection progress reaches the typed wire before the unchanged failure", async () => {
  const f = fixture();
  try {
    await f.start();
    const p = f.runtime.nativeController.pass;
    f.runtime.nativeController.local(
      p,
      "progress",
      "native_launch_phase_pending",
    );
    const packet = f.envelope();
    packet[4] = 14;
    f.packet("envelope", packet);
    const reasons = f.wire
      .filter((frame) => frame.status === "progress")
      .map((frame) => frame.nativeLifecycle?.reason);
    assert(reasons.includes("native_launch_phase_pending"));
    const reason = `native_envelope_binding_r14_a${f.armCounter}_e${f.armCounter}_p${packet[6]}`;
    assert(reasons.includes(reason));
    const progress = f.wire.find(
      (frame) => frame.nativeLifecycle?.reason === reason,
    );
    assert.equal(progress.nativeLifecycle.scope, "arrangement-descriptive/v2");
    assert.equal(progress.nativeLifecycle.generation, p.generation);
    assert.equal(progress.traceId, f.command.traceId);
    assert.equal(progress.correlationId, f.command.correlationId);
    assert.equal(progress.passId, f.command.passId);
    assert(progress.nativeLifecycle.elapsedMs >= 0);
    assert.equal(f.wire.filter((frame) => frame.status === "failed").length, 1);
    assert.equal(f.wire.at(-1).reason, "native_envelope_binding_changed");
    f.stopReceipt(p.generation);
  } finally {
    f.runtime.stop();
  }
});

for (const rate of [44100, 48000]) {
  test(`explicit v2 ${rate}Hz runtime composes traced controls and App-valid proof without changing v1 registration`, async () => {
    const f = fixture({ rate, total: (rate / 10) * 299 + 1 });
    try {
      assert.equal(
        f.runtime.client.options.schemaVersion,
        "audio-observation/v2",
      );
      listenerRegistrationV2Schema.parse(f.runtime.client.listener);
      assert.equal(f.runtime.nativeStatus.readiness, "BLOCKED");
      f.handlers["attack-threshold"](120);
      f.handlers["attack-spacing-ms"](2000);
      await f.start();
      const controls = f.outputs.filter((row) => row[0] === "native_control");
      assert.deepEqual(
        controls.map((row) => row[1]),
        ["begin", "configure_v2", "arm"],
      );
      assert.deepEqual(controls[1].slice(3), [
        f.geometry.totalSamples,
        f.geometry.hopSamples,
        93,
        0.25,
        64,
      ]);
      f.capture();
      f.post();
      const complete = f.wire.find((row) => row.status === "completed");
      assert(complete);
      assertNativeCaptureObservationV2(
        complete.nativeCapture,
        complete.observation,
        {
          listenerId: f.runtime.engine.listenerId,
          passId: V2_OWNER.passId,
          geometry: f.geometry,
          policy: f.timingPolicy,
        },
      );
      assert.equal(complete.observation.samples.length, 300);
      assert.deepEqual(complete.observation.algorithm.settings, {
        attackThresholdDb: 6,
        minAttackSpacingSamples: rate / 10,
      });
      assert(Buffer.byteLength(JSON.stringify(complete), "utf8") < 128 * 1024);
      assert(
        f.wire.every(
          (row) =>
            row.traceId === "v2-trace" &&
            row.correlationId === "v2-correlation",
        ),
      );
      const armedIndex = f.wire.findIndex((row) => row.status === "armed");
      assert(armedIndex > 0);
      assert(
        f.wire
          .slice(0, armedIndex)
          .every((row) => row.type === "listener.reply"),
      );
      const lifecycles = f.wire.flatMap((row) =>
        row.nativeLifecycle ? [row.nativeLifecycle] : [],
      );
      assert(lifecycles.length > 0);
      assert(
        lifecycles.every(
          (event) => event.scope === "arrangement-descriptive/v2",
        ),
      );
      assert.equal(
        new Set(lifecycles.map((event) => event.eventId)).size,
        lifecycles.length,
      );
      f.stopReceipt("stale");
      assert(f.runtime.nativeController.pendingDisarm);
      f.stopReceipt();
      assert.equal(f.runtime.nativeController.pendingDisarm, null);
    } finally {
      f.runtime.stop();
    }
    assert.deepEqual(f.cleared, f.timers);
  });
}

test("v2 encoded frame overflow never reaches the transport and waits for a generation-owned native disarm receipt", async () => {
  const f = fixture();
  try {
    await f.start();
    const adapter = f.runtime.nativeController;
    const generation = adapter.pass.generation;
    adapter.emit({
      type: "terminal",
      status: "complete",
      reason: "range_complete",
      observation: { syntheticOversizedPayload: "x".repeat(128 * 1024) },
      nativeCapture: {},
    });
    assert.equal(adapter.pass, null);
    assert.equal(adapter.pendingDisarm.generation, generation);
    assert.equal(
      f.wire.some((row) => row.reason === "native_result_frame_quota_exceeded"),
      false,
    );
    f.stopReceipt("foreign");
    assert(adapter.pendingDisarm);
    f.stopReceipt(generation);
    assert.equal(adapter.pendingDisarm, null);
    const failures = f.wire.filter(
      (row) => row.reason === "native_result_frame_quota_exceeded",
    );
    assert.equal(failures.length, 1);
    assert.equal(failures[0].status, "failed");
    assert.equal(failures[0].observation, undefined);
    assert.equal(f.runtime.client.authenticated, true);
    assert(
      f.outputs.some(
        (row) =>
          row[0] === "native_control" &&
          row[1] === "stop" &&
          row[2] === generation,
      ),
    );
  } finally {
    f.runtime.stop();
  }
});

test("v2 missing disarm acknowledgement times out explicitly and releases only the stopped generation", async () => {
  const f = fixture();
  try {
    await f.start();
    const adapter = f.runtime.nativeController;
    const generation = adapter.pass.generation;
    adapter.emit({
      type: "terminal",
      status: "complete",
      reason: "range_complete",
      observation: { syntheticOversizedPayload: "x".repeat(128 * 1024) },
      nativeCapture: {},
    });
    f.time(1000);
    f.timers[0]();
    assert.equal(adapter.pendingDisarm, null);
    assert(
      f.wire.some(
        (row) =>
          row.status === "failed" && row.reason === "native_stop_ack_timeout",
      ),
    );
    assert(
      f.outputs.some(
        (row) =>
          row[0] === "native_control" &&
          row[1] === "release" &&
          row[2] === generation,
      ),
    );
    assert.equal(f.runtime.client.authenticated, true);
  } finally {
    f.runtime.stop();
  }
});

test("v2 ABI0 failed arm retains ownership until the exact stop receipt before its terminal reply", async () => {
  const order = [];
  const f = fixture({
    rate: 48000,
    total: 84000,
    geometry: { tempoBpm: 120, startBeat: 0.25, endBeat: 3.75 },
    onOutput: (value) => {
      if (value[0] === "native_diagnostic") {
        const event = JSON.parse(value[1]);
        if (event.type === "native-disarm-stage") order.push(event.stage);
      }
    },
    onSend: (frame) => {
      if (frame.status === "failed") order.push("failed-reply");
    },
  });
  try {
    f.dispatch("prepare");
    const pending = f.dispatch("arm");
    const generation = f.runtime.nativeController.pass.generation;
    f.handlers.native(generation, "abi-clock", 0);
    await pending;
    assert.equal(
      f.wire.some((frame) => frame.status === "failed"),
      false,
    );
    assert.equal(f.runtime.client.listenerJob.passId, V2_OWNER.passId);
    f.stopReceipt("foreign");
    for (const values of [
      [0, 0, 1],
      [0, 1, 2],
      [1, 0, 2],
      [0, 0, 2, 2],
    ])
      f.handlers.native(generation, "stopped", ...values);
    assert.equal(
      f.wire.some((frame) => frame.status === "failed"),
      false,
    );
    f.stopReceipt(generation);
    const failed = f.wire.filter((frame) => frame.status === "failed");
    assert.equal(failed.length, 1);
    assert.equal(failed[0].type, "listener.reply");
    assert.equal(failed[0].reason, "native_metadata_changed_abi_clock_0");
    assert.deepEqual(order, ["queued", "started", "completed", "failed-reply"]);
    assert.equal(failed[0].traceId, "v2-trace");
    assert.equal(failed[0].correlationId, "v2-correlation");
    assert.equal(failed[0].causationId, "v2-root");
    assert(
      f.wire.every((frame) => !["armed", "completed"].includes(frame.status)),
    );
    assert(f.wire.every((frame) => frame.nativeCapture === undefined));
    assert.equal(f.runtime.nativeController.pass, null);
    assert.equal(f.runtime.nativeController.pendingDisarm, null);
    f.stopReceipt(generation);
    assert.equal(f.wire.filter((frame) => frame.status === "failed").length, 1);
    assert.equal(f.runtime.nativeController.pendingDisarm, null);
    assert.equal(f.runtime.client.authenticated, true);
    assert(f.outputs.every((value) => value[0] !== "transport"));
  } finally {
    f.runtime.stop();
  }
});

test("v2 spectrum failure numeric diagnostic survives deferred arm reply, timeout and post-armed failed result", async () => {
  for (const phase of ["preflight", "capturing"])
    for (const confirmed of [true, false]) {
      const f = fixture();
      try {
        if (phase === "capturing") await f.start();
        else f.dispatch("prepare");
        const pending = phase === "preflight" ? f.dispatch("arm") : null;
        const p = f.runtime.nativeController.pass;
        const debug = [17, 2048, 0.125, 123.5, -0.25];
        const packet = [64000, 24001, 1, 61952, 64000, 0];
        f.handlers.native(p.generation, "spectrum-diagnostics", ...debug);
        f.handlers.native(p.generation, "spectrum", ...packet);
        await pending;
        if (phase === "preflight")
          assert.equal(
            f.wire.some((frame) => frame.status === "failed"),
            false,
          );
        if (confirmed) f.stopReceipt(p.generation);
        else {
          f.time(1000);
          f.timers[0]();
        }
        const failures = f.wire.filter((frame) => frame.status === "failed");
        assert.equal(
          failures.length,
          1,
          JSON.stringify({
            phase,
            confirmed,
            wire: f.wire,
            outputs: f.outputs.slice(-5),
          }),
        );
        const failed = failures[0];
        assert.equal(
          failed.type,
          phase === "preflight" ? "listener.reply" : "listener.result",
        );
        assert.deepEqual(
          failed.nativeFailureDiagnostic,
          p.nativeFailureDiagnostic,
        );
        assert.deepEqual(failed.nativeFailureDiagnostic.packet, packet);
        assert.deepEqual(failed.nativeFailureDiagnostic.fftDiagnostics, debug);
        assert.equal(failed.nativeFailureDiagnostic.check, "centroid");
        assert.equal(failed.nativeFailureDiagnostic.generation, p.generation);
        assert.deepEqual(
          failed.nativeFailureDiagnostic.metadata,
          phase === "preflight"
            ? {
                dsp: null,
                fftInfo: null,
                clockAbi: null,
                envelopeAbi: null,
                spectrumAbi: null,
              }
            : {
                dsp: [1, 48000, 64],
                fftInfo: [2048, 2048, 2048, 1],
                clockAbi: 2,
                envelopeAbi: 2,
                spectrumAbi: 2,
              },
        );
        if (!confirmed && phase === "preflight")
          assert(
            failed.reason.endsWith("_native_stop_ack_timeout_unconfirmed"),
          );
        for (const key of [
          "traceId",
          "correlationId",
          "passId",
          "connectionEpoch",
        ])
          assert.equal(failed[key], f.command[key]);
        assert(Buffer.byteLength(JSON.stringify(failed), "utf8") < 128 * 1024);
        assert(
          f.wire
            .filter((frame) => frame.status !== "failed")
            .every((frame) => frame.nativeFailureDiagnostic === undefined),
        );
        f.stopReceipt(p.generation);
        assert.equal(
          f.wire.filter((frame) => frame.status === "failed").length,
          1,
        );
      } finally {
        f.runtime.stop();
      }
    }
});

test("v2 refused-launch diagnostic crosses the real SDK once and survives confirmed or timed-out disarm", async () => {
  for (const confirmed of [true, false]) {
    const f = fixture();
    try {
      f.dispatch("prepare");
      const pending = f.dispatch("arm");
      f.preflight();
      f.configReceipt();
      f.ack();
      await pending;
      const p = f.runtime.nativeController.pass;
      const row = f.clock(f.origin + 640);
      row[1] += 128 / ((f.geometry.sampleRate * 60) / f.geometry.tempoBpm);
      row[8] = row[1];
      row[5] = row[1] % 1;
      f.packet("clock", row);
      f.packet("envelope", f.envelope());
      if (confirmed) f.stopReceipt(p.generation);
      else {
        f.time(1000);
        f.timers[0]();
      }
      const failed = f.wire.filter((frame) => frame.status === "failed");
      assert.equal(failed.length, 1);
      assert.equal(failed[0].reason, "native_launch_binding_mismatch");
      const diagnostic = failed[0].nativeFailureDiagnostic;
      assert.equal(diagnostic.check, "launch-alignment");
      assert.equal(diagnostic.generation, p.generation);
      assert.equal(diagnostic.startSample, f.origin + p.anchorHostOffset);
      assert.deepEqual(diagnostic.rejectedClock, row);
      assert.deepEqual(diagnostic.measurements, {
        observedClockDisagreementSamples: 0,
        observedBeatDisagreementSamples: 128,
      });
      for (const key of [
        "traceId",
        "correlationId",
        "passId",
        "connectionEpoch",
      ])
        assert.equal(failed[0][key], f.command[key]);
      assert.equal(failed[0].nativeCapture, undefined);
      assert.equal(failed[0].observation, undefined);
      assert(
        f.wire
          .filter((frame) => frame.status !== "failed")
          .every((frame) => frame.nativeFailureDiagnostic === undefined),
      );
      f.stopReceipt(p.generation);
      assert.equal(
        f.wire.filter((frame) => frame.status === "failed").length,
        1,
      );
      assert.equal(f.runtime.nativeController.pendingDisarm, null);
    } finally {
      f.runtime.stop();
    }
  }
});

test("v2 alignment diagnostic survives deferred arm failure and post-launch failure through confirmed or timed-out disarm", async () => {
  for (const phase of ["preflight", "capturing"])
    for (const confirmed of [true, false]) {
      const f = fixture();
      try {
        if (phase === "capturing") await f.start();
        else f.dispatch("prepare");
        const pending = phase === "preflight" ? f.dispatch("arm") : null;
        if (phase === "preflight") f.preflight();
        const p = f.runtime.nativeController.pass;
        const row = f.clock(p.clock[4] + 64, phase === "capturing");
        row[2] += 65;
        row[9] += 65;
        f.handlers.native(p.generation, "clock", ...row);
        await pending;
        if (confirmed) f.stopReceipt(p.generation);
        else {
          f.time(1000);
          f.timers[0]();
        }
        const failed = f.wire.filter((frame) => frame.status === "failed");
        assert.equal(failed.length, 1);
        const diagnostic = failed[0].nativeFailureDiagnostic;
        assert.equal(diagnostic.scope, "native-alignment-rejection/v1");
        assert.equal(diagnostic.check, "host-offset");
        assert.deepEqual(diagnostic.rejectedClock, row);
        assert.equal(
          diagnostic.measurements.observedClockDisagreementSamples,
          65,
        );
        for (const key of [
          "traceId",
          "correlationId",
          "passId",
          "connectionEpoch",
        ])
          assert.equal(failed[0][key], f.command[key]);
        assert.equal(failed[0].nativeCapture, undefined);
        assert(
          f.wire
            .filter((frame) => frame.status !== "failed")
            .every((frame) => frame.nativeFailureDiagnostic === undefined),
        );
        f.stopReceipt(p.generation);
        assert.equal(
          f.wire.filter((frame) => frame.status === "failed").length,
          1,
        );
      } finally {
        f.runtime.stop();
      }
    }
});

test("v2 diagnostic stays generation-owned through cancel, replacement, shutdown and pass identifier reuse", async () => {
  for (const diagnosticKind of ["spectrum", "alignment"])
    for (const mode of [
      "cancel",
      "cancel-failure",
      "identity",
      "epoch",
      "disconnect",
      "stop",
      "reuse",
    ]) {
      const f = fixture();
      try {
        f.dispatch("prepare");
        const pending = f.dispatch("arm");
        const p = f.runtime.nativeController.pass;
        f.handlers.native(p.generation, "spectrum-diagnostics", 1, 2, 3, 4, 5);
        if (diagnosticKind === "alignment") f.preflight();
        if (mode === "cancel") await f.dispatch("cancel");
        else if (diagnosticKind === "alignment") {
          const row = f.clock(p.clock[4] + 64, false);
          row[2] += 65;
          row[9] += 65;
          f.handlers.native(p.generation, "clock", ...row);
        } else
          f.handlers.native(
            p.generation,
            "spectrum",
            64000,
            24001,
            1,
            61952,
            64000,
            0,
          );
        await pending;
        if (mode === "cancel-failure") await f.dispatch("cancel");
        if (mode === "identity")
          f.handlers.identity(
            JSON.stringify({
              canonicalPath: "live_set tracks 1 devices 0",
              track: { id: "3", name: "replacement" },
              device: { id: "4", name: "Audio-Listener" },
            }),
          );
        if (mode === "epoch") {
          f.runtime.client.listener.connectionEpoch = "replacement-epoch";
          f.runtime.refreshRegistration();
        }
        if (mode === "disconnect")
          f.runtime.client.options.onStatus("live", "disconnected");
        if (mode === "stop") f.runtime.stop();
        f.stopReceipt(p.generation);
        if (mode === "cancel")
          assert(
            f.wire.every(
              (frame) => frame.nativeFailureDiagnostic === undefined,
            ),
          );
        if (["identity", "epoch", "disconnect", "stop"].includes(mode))
          assert.equal(
            f.wire.some((frame) => frame.status === "failed"),
            false,
          );
        if (mode === "cancel-failure") {
          const failed = f.wire.filter((frame) => frame.status === "failed");
          assert.equal(failed.length, 1);
          assert.deepEqual(
            failed[0].nativeFailureDiagnostic,
            p.nativeFailureDiagnostic,
          );
          assert.equal(
            f.wire.some((frame) => frame.status === "cancelled"),
            false,
          );
        }
        if (mode === "reuse") {
          f.dispatch("prepare");
          const nextArm = f.dispatch("arm");
          const next = f.runtime.nativeController.pass;
          f.handlers.native(
            p.generation,
            "spectrum-diagnostics",
            9,
            9,
            9,
            9,
            9,
          );
          f.handlers.native(
            next.generation,
            "spectrum",
            64000,
            -1,
            1,
            61952,
            64000,
            0,
          );
          await nextArm;
          f.stopReceipt(p.generation);
          assert.equal(
            f.wire.filter((frame) => frame.status === "failed").length,
            1,
          );
          f.stopReceipt(next.generation);
          const failure = f.wire
            .filter((frame) => frame.status === "failed")
            .at(-1);
          assert.equal(
            failure.nativeFailureDiagnostic.generation,
            next.generation,
          );
          assert.equal(failure.nativeFailureDiagnostic.fftDiagnostics, null);
        }
      } finally {
        f.runtime.stop();
      }
    }
});

test("v2 failed-arm timeout preserves the primary failure and explicitly reports unconfirmed cleanup", async () => {
  const f = fixture();
  try {
    f.dispatch("prepare");
    const pending = f.dispatch("arm");
    const generation = f.runtime.nativeController.pass.generation;
    f.handlers.native(generation, "abi-clock", 0);
    await pending;
    f.time(999);
    f.timers[0]();
    assert.equal(
      f.wire.some((frame) => frame.status === "failed"),
      false,
    );
    f.time(1000);
    f.timers[0]();
    const failed = f.wire.filter((frame) => frame.status === "failed");
    assert.equal(failed.length, 1);
    assert.equal(
      failed[0].reason,
      "native_metadata_changed_abi_clock_0_native_stop_ack_timeout_unconfirmed",
    );
    assert.equal(failed[0].nativeCapture, undefined);
    assert(failed[0].reason.length <= 512);
    assert(
      f.outputs.some(
        (value) =>
          value[0] === "native_control" &&
          value[1] === "release" &&
          value[2] === generation,
      ),
    );
    f.stopReceipt(generation);
    f.timers[0]();
    assert.equal(f.wire.filter((frame) => frame.status === "failed").length, 1);
  } finally {
    f.runtime.stop();
  }
});

test("v2 cancel during failed-arm cleanup retains the primary error and cannot release ownership before stop", async () => {
  for (const afterRejection of [false, true])
    for (const confirmed of [false, true]) {
      const f = fixture();
      try {
        f.dispatch("prepare");
        const arm = f.dispatch("arm");
        const generation = f.runtime.nativeController.pass.generation;
        f.handlers.native(generation, "abi-clock", 0);
        if (afterRejection) await arm;
        await f.dispatch("cancel");
        await arm;
        assert.equal(
          f.wire.some((frame) =>
            ["failed", "cancelled"].includes(frame.status),
          ),
          false,
        );
        if (confirmed) f.stopReceipt(generation);
        else {
          f.time(1000);
          f.timers[0]();
        }
        const terminal = f.wire.filter((frame) =>
          ["failed", "cancelled"].includes(frame.status),
        );
        assert.equal(terminal.length, 1);
        assert.equal(terminal[0].status, "failed");
        assert.equal(
          terminal[0].reason,
          "native_metadata_changed_abi_clock_0" +
            (confirmed ? "" : "_native_stop_ack_timeout_unconfirmed"),
        );
      } finally {
        f.runtime.stop();
      }
    }
});

test("v2 pre-arm and post-arm cancellation waits for an actual stop and timeout never becomes cancelled success", async () => {
  for (const phase of ["preflight", "armed", "capturing"])
    for (const confirmed of [true, false]) {
      const f = fixture();
      try {
        f.dispatch("prepare");
        const arm = f.dispatch("arm");
        if (phase !== "preflight") {
          f.preflight();
          f.configReceipt();
          f.ack();
          await arm;
        }
        if (phase === "capturing") {
          f.packet("clock", f.clock(f.origin + 640));
          f.packet("envelope", f.envelope());
        }
        const generation = f.runtime.nativeController.pass.generation;
        await f.dispatch("cancel");
        await arm;
        assert.equal(
          f.wire.some((frame) =>
            ["cancelled", "failed"].includes(frame.status),
          ),
          false,
        );
        assert.equal(f.runtime.client.listenerJob.passId, V2_OWNER.passId);
        f.stopReceipt("foreign");
        if (confirmed) f.stopReceipt(generation);
        else {
          f.time(1000);
          f.timers[0]();
        }
        const terminal = f.wire.filter((frame) =>
          ["cancelled", "failed"].includes(frame.status),
        );
        assert.equal(terminal.length, 1);
        assert.equal(terminal[0].type, "listener.reply");
        assert.equal(terminal[0].status, confirmed ? "cancelled" : "failed");
        assert.equal(
          terminal[0].reason,
          confirmed
            ? "cancelled"
            : "cancelled_native_stop_ack_timeout_unconfirmed",
        );
        assert.equal(terminal[0].nativeCapture, undefined);
        assert.equal(f.runtime.nativeController.pendingDisarm, null);
        f.stopReceipt(generation);
        assert.equal(
          f.wire.filter((frame) =>
            ["cancelled", "failed"].includes(frame.status),
          ).length,
          1,
        );
      } finally {
        f.runtime.stop();
      }
    }
});

test("v2 cleanup handles reentrant stop receipts and release-time receipts exactly once", async () => {
  for (const mode of ["arm-failure", "cancel", "release"]) {
    const f = fixture({
      onOutput: (value, harness) => {
        if (
          harness &&
          value[0] === "native_control" &&
          value[1] === (mode === "release" ? "release" : "stop")
        )
          harness.stopReceipt(value[2]);
      },
    });
    try {
      f.dispatch("prepare");
      const arm = f.dispatch("arm");
      if (mode === "arm-failure") {
        const generation = f.runtime.nativeController.pass.generation;
        f.handlers.native(generation, "abi-clock", 0);
      } else {
        await f.dispatch("cancel");
        if (mode === "release") {
          f.time(1000);
          f.timers[0]();
        }
      }
      await arm;
      const terminal = f.wire.filter((frame) =>
        ["cancelled", "failed"].includes(frame.status),
      );
      assert.equal(terminal.length, 1);
      assert.equal(
        terminal[0].status,
        mode === "arm-failure" ? "failed" : "cancelled",
      );
      assert.equal(
        terminal[0].reason,
        mode === "arm-failure"
          ? "native_metadata_changed_abi_clock_0"
          : "cancelled",
      );
      assert.equal(f.runtime.nativeController.pendingDisarm, null);
    } finally {
      f.runtime.stop();
    }
  }
});

test("v2 pending cleanup cannot publish through replaced registrations, disconnect or runtime stop", async () => {
  for (const mode of ["identity", "epoch", "disconnect", "stop"]) {
    const f = fixture();
    try {
      f.dispatch("prepare");
      const arm = f.dispatch("arm");
      const adapter = f.runtime.nativeController;
      const generation = adapter.pass.generation;
      f.handlers.native(generation, "abi-clock", 0);
      await arm;
      assert.equal(
        f.wire.some((frame) => frame.status === "failed"),
        false,
      );
      if (mode === "identity")
        f.handlers.identity(
          JSON.stringify({
            canonicalPath: "live_set tracks 1 devices 0",
            track: { id: "3", name: "replacement" },
            device: { id: "4", name: "Audio-Listener" },
          }),
        );
      if (mode === "epoch") {
        f.runtime.client.listener.connectionEpoch = "replacement-epoch";
        f.runtime.refreshRegistration();
      }
      if (mode === "disconnect")
        f.runtime.client.options.onStatus("live", "disconnected");
      if (mode === "stop") f.runtime.stop();
      adapter.ingest({ generation, type: "stopped", values: [0, 0, 2] });
      f.time(2000);
      adapter.tick();
      assert.equal(
        f.wire.some((frame) => ["failed", "cancelled"].includes(frame.status)),
        false,
      );
    } finally {
      f.runtime.stop();
    }
  }
});

test("v2 stop before registration is idempotent and needs no fabricated cleanup receipt", () => {
  const outputs = [],
    cleared = [];
  const runtime = createRuntime({
    nativeMode: true,
    nativeVersion: 2,
    maxApi: {
      addHandler() {},
      outlet: (...values) => outputs.push(values),
    },
    interval: (callback) => callback,
    clear: (callback) => cleared.push(callback),
  });
  runtime.stop();
  runtime.stop();
  assert.equal(runtime.client, null);
  assert.equal(cleared.length, 1);
  assert.equal(
    outputs.some((value) => value[0] === "native_control"),
    false,
  );
});

test("v2 cleanup receipt from an old pass cannot settle a reused pass identifier", async () => {
  const f = fixture();
  try {
    let prior;
    for (let index = 0; index < 2; index++) {
      f.dispatch("prepare");
      const arm = f.dispatch("arm");
      const generation = f.runtime.nativeController.pass.generation;
      assert.notEqual(generation, prior);
      f.handlers.native(generation, "abi-clock", 0);
      await arm;
      if (prior) f.stopReceipt(prior);
      assert.equal(
        f.wire.filter((frame) => frame.status === "failed").length,
        index,
      );
      f.stopReceipt(generation);
      assert.equal(
        f.wire.filter((frame) => frame.status === "failed").length,
        index + 1,
      );
      prior = generation;
    }
  } finally {
    f.runtime.stop();
  }
});

test("v2 native-handler tempo changes fail through the real SDK despite a 480-sample budget and zero clock residual", async () => {
  for (const rate of [44100, 48000])
    for (const change of [-1e-6, 1e-6]) {
      const f = fixture({
        rate,
        policy: { mode: "descriptive", maxClockDisagreementSamples: 480 },
      });
      try {
        await f.start();
        const generation = f.runtime.nativeController.pass.generation;
        f.handlers.native("foreign", "tempo", 93 + change);
        assert.equal(f.runtime.nativeController.state, "capturing");
        f.handlers.native(generation, "tempo", 93 + change);
        f.handlers.native(generation, "tempo", 93);
        assert.equal(f.runtime.nativeController.pass, null);
        f.stopReceipt(generation);
        const failures = f.wire.filter(
          (row) => row.type === "listener.result" && row.status === "failed",
        );
        assert.equal(failures.length, 1);
        assert.equal(failures[0].reason, "native_host_tempo_changed");
        assert(f.wire.every((row) => row.nativeCapture === undefined));
        const evidence = f.outputs
          .filter((row) => row[0] === "native_diagnostic")
          .map((row) => JSON.parse(row[1]))
          .filter((row) => row.type === "native-tempo-observation");
        assert.equal(evidence.length, 2);
        assert.equal(evidence.at(-1).phase, "capture");
        assert.equal(evidence.at(-1).observedTempoBpm, 93 + change);
        assert.equal(evidence.at(-1).generation, generation);
        assert.equal(f.runtime.nativeController.pendingDisarm, null);
        assert.equal(f.runtime.client.authenticated, true);
        assert(
          f.outputs.some(
            (row) =>
              row[0] === "native_control" &&
              row[1] === "stop" &&
              row[2] === generation,
          ),
        );
        assert(f.outputs.every((row) => row[0] !== "transport"));
      } finally {
        f.runtime.stop();
      }
      assert.equal(f.cleared.length, 1);
    }
});

test("v2 cancellation, disconnect and reset discard complete proofs, preserve bounded reasons and stop no transport", async () => {
  for (const mode of ["cancel", "disconnect", "reset"]) {
    const f = fixture();
    try {
      await f.start();
      const generation = f.runtime.nativeController.pass.generation;
      if (mode === "cancel") f.dispatch("cancel");
      if (mode === "disconnect")
        f.runtime.client.options.onStatus("live", "disconnected");
      if (mode === "reset") f.handlers.reset();
      assert.equal(f.runtime.nativeController.pass, null);
      assert(f.wire.every((row) => row.nativeCapture === undefined));
      assert(
        f.wire
          .filter((row) => ["failed", "partial"].includes(row.status))
          .every((row) => typeof row.reason === "string"),
      );
      f.stopReceipt(generation);
      assert.equal(f.runtime.nativeController.pendingDisarm, null);
      assert(
        f.outputs.every((row) => row[0] !== "transport" && row[0] !== "start"),
      );
    } finally {
      f.runtime.stop();
    }
  }
});

test("v2 armed publication denial cleans up without leaking capture progress or complete proof", async () => {
  const f = fixture({ reject: (frame) => frame.status === "armed" });
  try {
    await f.start();
    assert.equal(f.runtime.nativeController.pass, null);
    assert.equal(
      f.wire.some(
        (row) =>
          row.status === "armed" ||
          row.status === "progress" ||
          row.nativeCapture,
      ),
      false,
    );
    assert.equal(
      f.wire.some((row) => row.status === "failed"),
      false,
    );
    f.stopReceipt();
    assert(
      f.wire.some(
        (row) =>
          row.status === "failed" &&
          row.reason === "native_armed_publication_failed",
      ),
    );
    assert.equal(f.runtime.nativeController.pendingDisarm, null);
  } finally {
    f.runtime.stop();
  }
});

test("v2 cancelling a reservation before native begin needs no fictitious native receipt or poll cleanup", () => {
  const f = fixture();
  try {
    f.dispatch("prepare");
    f.dispatch("cancel");
    assert.equal(f.runtime.nativeController.pass, null);
    assert.equal(f.runtime.nativeController.pendingDisarm, null);
    assert(
      f.wire.some(
        (row) => row.status === "cancelled" && row.reason === "cancelled",
      ),
    );
    assert.equal(
      f.outputs.some((row) => row[0] === "native_control"),
      false,
    );
    f.dispatch("prepare");
    assert(f.runtime.nativeController.pass);
  } finally {
    f.runtime.stop();
  }
});

test("v2 reentrant cancellation is queued until armed publication, retains causal diagnostics and never launches transport", async () => {
  let injected = false;
  const f = fixture({
    onSend: (frame, harness) => {
      if (!injected && frame.status === "armed") {
        injected = true;
        harness.dispatch("cancel");
      }
    },
  });

  try {
    await f.start();
    assert.equal(f.runtime.nativeController.pass, null);
    assert(f.wire.some((row) => row.status === "armed"));
    assert.equal(
      f.wire.some((row) => row.status === "cancelled"),
      false,
    );
    f.stopReceipt();
    assert(f.wire.some((row) => row.status === "cancelled"));
    const queued = f.outputs
      .filter((row) => row[0] === "native_diagnostic")
      .map((row) => JSON.parse(row[1]))
      .filter((event) => event.type === "native-runtime-control-stage");
    assert.deepEqual(
      queued.map((event) => event.stage),
      ["queued", "started", "completed"],
    );
    assert.equal(queued[1].causationId, queued[0].eventId);
    assert.equal(queued[2].causationId, queued[1].eventId);
    assert(f.wire.every((row) => row.nativeCapture === undefined));
    assert.equal(f.runtime.nativeController.pendingDisarm, null);
    assert(
      f.outputs.every((row) => row[0] !== "transport" && row[0] !== "start"),
    );
  } finally {
    f.runtime.stop();
  }
});
