/* global Buffer */
import "./native-protocol-test-loader.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { createRuntime } = require("./audio_listener_runtime.js");
const { NativeMessageIO } = require("./audio_listener_native_io.js");
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
const {
  listenerControlDualSchema,
  listenerReplyDualSchema,
  listenerResultDualSchema,
} =
  await import("../../packages/signal-routing/src/listener-dual-contracts.ts");

// The real SDK owns control validation, ownership, framing and sequencing.
// Discovery/authentication and native hardware are controlled in this fixture.
function fixture(options = {}) {
  const wireVersion = options.wireVersion ?? 2;
  const mode = options.mode ?? "arrangement";
  const handlers = {},
    outputs = [],
    wire = [],
    timers = [],
    cleared = [];
  let now = 0,
    requests = 0,
    harness;
  class ControlHarnessClient extends (options.SDKClass ?? AgentSignalClient) {
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
      (wireVersion === 4
        ? frame.type === "listener.reply"
          ? listenerReplyDualSchema
          : listenerResultDualSchema
        : frame.type === "listener.reply"
          ? listenerReplyV2Schema
          : listenerResultV2Schema
      ).parse(frame);
      if (options.reject?.(frame)) return false;
      wire.push(
        options.serializeWire ? JSON.parse(JSON.stringify(frame)) : frame,
      );
      options.onSend?.(frame, harness);
      return true;
    }
  }
  const runtime = (options.runtimeFactory ?? createRuntime)({
    nativeMode: true,
    nativeVersion: wireVersion,
    retainedMeasurements: options.retainedMeasurements ?? false,
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
      listenerVersion: wireVersion,
      ...(wireVersion === 4 ? { mode } : {}),
      action,
      ...(action === "prepare"
        ? {
            config: {
              geometry: f.geometry,
              timingPolicy: f.timingPolicy,
              ...(wireVersion === 4 && mode === "session"
                ? { source: options.source }
                : {}),
            },
          }
        : {}),
      ...patch,
    };
    (wireVersion === 4
      ? listenerControlDualSchema
      : listenerControlV2Schema
    ).parse(message);
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
    f.packet(
      options.retainedMeasurements ? "envelope-state" : "envelope",
      f.envelope(),
    );
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

test("canonical beforePack payload preserves source bytes and transports the complete prearm failure through packaged RuntimeNode and SDK", async (t) => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
  const base = join(root, ".test-artifacts");
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "native-runtime-pack-boundary-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { buildAbletonIntegrations } =
    await import("../../scripts/build-ableton-integrations.mjs");
  const files = [
    [
      "max-patches/audio-listener/audio_listener_runtime.js",
      "audio_listener_runtime.js",
    ],
    [
      "max-patches/audio-listener/audio_listener_native_controller.js",
      "audio_listener_native_controller.js",
    ],
    [
      "max-patches/audio-listener/audio_listener_engine.js",
      "audio_listener_engine.js",
    ],
    [
      "max-patches/audio-listener/audio_listener_native_assembler.js",
      "audio_listener_native_assembler.js",
    ],
    [
      "max-patches/audio-listener/audio_listener_native_io.js",
      "audio_listener_native_io.js",
    ],
    [
      "max-patches/audio-listener/audio_listener_measurements.js",
      "audio_listener_measurements.js",
    ],
    [
      "max-patches/audio-listener/audio_listener_native_v4_max.js",
      "audio_listener_native_v4_max.js",
    ],
    [
      "max-patches/shared/agent_signal_client.js",
      "agent_signal_client_common.js",
    ],
  ];
  const before = new Map(
    await Promise.all(
      files.map(async ([source]) => [
        source,
        createHash("sha256")
          .update(await readFile(join(root, source)))
          .digest("hex"),
      ]),
    ),
  );
  const payload = await buildAbletonIntegrations(join(directory, "payload"));
  const packaged = join(payload, "machine-listening");
  for (const [source, name] of files) {
    assert.equal(
      createHash("sha256")
        .update(await readFile(join(root, source)))
        .digest("hex"),
      before.get(source),
      `generator rewrote source ${source}`,
    );
    assert.equal(
      createHash("sha256")
        .update(await readFile(join(packaged, name)))
        .digest("hex"),
      before.get(source),
      `shipping bytes differ for ${name}`,
    );
  }
  const packagedRequire = createRequire(join(packaged, "package.json"));
  const f = fixture({
    runtimeFactory: packagedRequire("./audio_listener_runtime.js")
      .createRuntime,
    SDKClass: packagedRequire("./agent_signal_client_common.js")
      .AgentSignalClient,
    wireVersion: 4,
    mode: "session",
    retainedMeasurements: true,
    total: 90000,
    serializeWire: true,
    geometry: { tempoBpm: 128, startBeat: 0, endBeat: 4 },
    source: {
      mode: "session",
      synchronization: "transport-coupled-first-iteration",
      target: {
        view: "session",
        sceneIndex: 0,
        expectedClipName: "clip",
        expectedClipReference: "11111111-1111-4111-8111-111111111111",
        track: {
          kind: "regular",
          index: 0,
          expectedName: "track",
          expectedReference: "22222222-2222-4222-8222-222222222222",
        },
      },
    },
  });
  try {
    f.dispatch("prepare");
    const pending = f.dispatch("arm");
    const p = f.runtime.nativeController.pass;
    const input = (type, row) => f.handlers.native(p.generation, type, ...row);
    for (const family of [1, 2]) {
      for (const stage of [0, 1])
        input("retention-state", [
          family,
          stage,
          p.nativeEpoch,
          1,
          0,
          0,
          family === 1 ? 16 : 32,
          0,
          0,
          0,
        ]);
      input("retention-ready", [family, 1, p.nativeEpoch]);
    }
    let firstClock, lastClock;
    for (let elapsed = 0; elapsed <= 1010; elapsed += 10) {
      f.time(elapsed);
      if (elapsed % 50 === 0)
        for (const [type, row] of [
          ["dsp", [1, 48000, 64]],
          ["tempo", [128]],
          ["fftInfo", [2048, 2048, 2048, 1]],
          ["abi-clock", [2]],
          ["abi-envelope", [2]],
          ["abi-spectrum", [2]],
        ])
          input(type, row);
      input(
        "envelope-state",
        [0, -1, -1, 0, 0, 0, -1, -1, 0, 0, 0, 0, 0, -1, -1, 2],
      );
      const row = f.clock(f.armCounter + elapsed * 48, false);
      firstClock ??= [...row];
      lastClock = [...row];
      input("clock", row);
    }
    await pending;
    assert.equal(
      f.wire.some((frame) =>
        ["progress", "armed", "failed"].includes(frame.status),
      ),
      false,
    );
    const source = p.nativeFailureDiagnostic;
    assert.equal(source.checkEvidence.phase, "preflight");
    assert.equal(source.checkEvidence.preflight.actualSpanSamples, 48480);
    assert.equal(source.checkEvidence.preflight.maximumSpanSamples, 48000);
    assert.deepEqual(source.checkEvidence.preflight.firstClock, firstClock);
    assert.deepEqual(source.checkEvidence.preflight.lastClock, lastClock);
    assert.equal(source.checkEvidence.preflightWaits.last.check, "spectrum");
    assert(
      source.checkEvidence.lifecycle.some(
        (event) => event.phase === "preflight" && event.stage === "started",
      ),
    );
    assert(
      source.checkEvidence.lifecycle.some(
        (event) => event.phase === "preflight" && event.stage === "failed",
      ),
    );
    f.stopReceipt(p.generation);
    const reply = f.wire.at(-1);
    assert.equal(reply.listenerVersion, 4);
    assert.equal(reply.mode, "session");
    assert.equal(reply.status, "failed");
    assert.equal(reply.reason, "stale_native_preflight");
    const { cleanup, ...transported } = reply.nativeFailureDiagnostic;
    assert.deepEqual(transported, source);
    assert.equal(cleanup.confirmed, true);
    assert.equal(reply.nativeArm, undefined);
    assert.equal(reply.observation, undefined);
    assert.equal(f.runtime.client.listenerJob, null);
    assert.equal(f.runtime.nativeController.pendingDisarm, null);
  } finally {
    f.runtime.stop();
  }
  for (const [source] of files)
    assert.equal(
      createHash("sha256")
        .update(await readFile(join(root, source)))
        .digest("hex"),
      before.get(source),
      `packaged execution rewrote source ${source}`,
    );
});

test("retained lifecycle reaches typed SDK results before the completed observation and is trace-owned", async () => {
  const f = fixture({ retainedMeasurements: true });
  try {
    await f.start();
    assert.deepEqual(
      f.outputs
        .find(
          (values) => values[0] === "native_control" && values[1] === "begin",
        )
        .slice(3),
      [1, 48000],
    );
    f.capture();
    f.post();
    const measured = f.wire.filter(
      (frame) => frame.nativeLifecycle?.phase === "measurement",
    );
    assert.equal(measured.length, 6);
    assert.deepEqual(
      measured.map((frame) => frame.nativeLifecycle.stage),
      ["queued", "started", "queued", "started", "completed", "completed"],
    );
    assert(
      measured.every(
        (frame) =>
          frame.traceId === "v2-trace" &&
          frame.correlationId === "v2-correlation",
      ),
    );
    const terminal = f.wire.findLast((frame) => frame.status === "completed");
    assert(terminal);
    assert(f.wire.indexOf(measured.at(-1)) < f.wire.indexOf(terminal));
    assert.equal(f.runtime.nativeController.pass, null);
    assert.equal(
      f.outputs.findLast((values) => values[0] === "native_control").at(-1),
      "complete",
    );
  } finally {
    f.runtime.stop();
  }
});

test("unstable acquisition uses existing typed progress without refreshing capture and coherent delivery still completes", async () => {
  const f = fixture({ retainedMeasurements: true });
  try {
    await f.start();
    const pass = f.runtime.nativeController.pass;
    const before = [
      pass.clockAt,
      pass.spectrumAt,
      pass.envelopeAt,
      pass.assembler.frames,
    ];
    for (const family of [1, 2])
      f.packet("retention-unstable", [family, pass.nativeEpoch]);
    const progress = f.wire.filter((frame) =>
      frame.nativeLifecycle?.reason?.endsWith("_acquisition_unstable"),
    );
    assert.equal(progress.length, 2);
    for (const frame of progress) {
      assert.equal(frame.status, "progress");
      assert.equal(frame.nativeLifecycle.phase, "measurement");
      assert.equal(frame.nativeLifecycle.stage, "progress");
      assert.equal(frame.traceId, "v2-trace");
      assert.equal(frame.correlationId, "v2-correlation");
      assert.equal(frame.nativeFailureDiagnostic, undefined);
      assert.equal(frame.observation, undefined);
    }
    assert.deepEqual(
      [pass.clockAt, pass.spectrumAt, pass.envelopeAt, pass.assembler.frames],
      before,
    );
    f.capture();
    f.post();
    assert.equal(f.wire.at(-1).status, "completed");
    assert.equal(f.runtime.nativeController.pass, null);
  } finally {
    f.runtime.stop();
  }
});

test("unstable capture timing failure keeps its partial reason through typed lifecycle and failed native cleanup", async () => {
  const f = fixture({ retainedMeasurements: true });
  try {
    await f.start();
    f.packet("retention-unstable", [
      2,
      f.runtime.nativeController.pass.nativeEpoch,
    ]);
    f.time(1001);
    f.runtime.nativeController.tick();
    const terminal = f.wire.find((frame) => frame.status === "partial");
    assert.ok(terminal);
    assert.equal(terminal.reason, "host_timing_stale");
    assert.equal(terminal.observation.complete, false);
    assert.deepEqual(terminal.observation.samples, []);
    assert.equal(terminal.nativeCapture, undefined);
    assert.equal(
      f.wire.some((frame) => frame.status === "completed"),
      false,
    );
    assert.equal(
      f.wire.some((frame) => frame.nativeLifecycle?.stage === "partial"),
      false,
    );
    assert.equal(
      f.outputs
        .findLast(
          (values) => values[0] === "native_control" && values[1] === "stop",
        )
        .at(-1),
      "failed",
    );
    f.stopReceipt();
    assert.equal(f.runtime.nativeController.pendingDisarm, null);
  } finally {
    f.runtime.stop();
  }
});

test("join overflow operands cross runtime and SDK with trace before unchanged native cleanup", async () => {
  const f = fixture({ retainedMeasurements: true });
  try {
    await f.start();
    const pass = f.runtime.nativeController.pass;
    for (let hop = 1; hop <= 9; hop++) {
      f.packet("clock", f.clock(f.origin + hop * 4800 + 64));
      f.packet("envelope", f.envelope(hop * 4800));
    }
    const terminal = f.wire.find((frame) => frame.status === "failed");
    assert.equal(terminal.reason, "native_envelope_buffer_overflow");
    assert.equal(
      terminal.nativeFailureDiagnostic.check,
      "controller-envelope-overflow",
    );
    assert.equal(terminal.nativeFailureDiagnostic.blocker, "spectrum-behind");
    assert.equal(terminal.nativeFailureDiagnostic.generation, pass.generation);
    assert.equal(terminal.nativeFailureDiagnostic.controllerPending, 8);
    assert.equal(terminal.nativeFailureDiagnostic.completedMeasurements, 0);
    assert.equal(terminal.traceId, "v2-trace");
    assert.equal(terminal.correlationId, "v2-correlation");
    assert.equal(
      f.wire.some((frame) => frame.status === "completed"),
      false,
    );
    f.stopReceipt(pass.generation);
    assert.equal(f.runtime.nativeController.pendingDisarm, null);
  } finally {
    f.runtime.stop();
  }
});

test("retained preflight failure preserves owned delivery evidence until native release acknowledgement", async () => {
  const f = fixture({ retainedMeasurements: true });
  try {
    f.dispatch("prepare");
    const pending = f.dispatch("arm");
    const generation = f.runtime.nativeController.pass.generation;
    f.packet("retention-state", [2, 4, 1, 1, 32, 0, 32, 32, 10, 1]);
    await pending;
    assert.equal(
      f.wire.some((frame) => frame.status === "failed"),
      false,
    );
    f.stopReceipt(generation);
    const terminal = f.wire.at(-1);
    assert.equal(terminal.type, "listener.reply");
    assert.equal(terminal.status, "failed");
    assert.equal(terminal.reason, "native_measurement_queue_overflow");
    assert.equal(terminal.nativeFailureDiagnostic.generation, generation);
    assert.equal(terminal.nativeFailureDiagnostic.nativeEpoch, 1);
    assert.equal(
      f.wire.some((frame) => frame.observation),
      false,
    );
  } finally {
    f.runtime.stop();
  }
});

for (const refuse of [false, true])
  test(`malformed observational snapshot${refuse ? " and refused gap delivery" : ""} cannot refresh or interrupt capture`, async () => {
    const f = fixture({
      retainedMeasurements: true,
      reject: refuse
        ? (frame) =>
            frame.nativeLifecycle?.reason ===
            "native_diagnostic_snapshot_invalid"
        : undefined,
    });
    try {
      await f.start();
      const p = f.runtime.nativeController.pass;
      const before = [
        p.clockAt,
        p.spectrumAt,
        p.envelopeAt,
        p.assembler.frames,
      ];
      f.packet("retention-snapshot", [0]);
      assert.equal(f.runtime.nativeController.pass, p);
      assert.equal(f.runtime.nativeController.state, "capturing");
      assert.deepEqual(
        [p.clockAt, p.spectrumAt, p.envelopeAt, p.assembler.frames],
        before,
      );
      const gap = f.wire.find(
        (frame) =>
          frame.nativeLifecycle?.reason ===
          "native_diagnostic_snapshot_invalid",
      );
      assert.equal(!!gap, !refuse);
      if (gap) assert.equal(gap.nativeLifecycle.frames, 0);
      f.capture();
      f.post();
      assert.equal(f.wire.at(-1).status, "completed");
    } finally {
      f.runtime.stop();
    }
  });

test("preflight source-span rejection reaches shipping SDK with immutable operands and separate stop evidence", async () => {
  const f = fixture({ retainedMeasurements: true });
  try {
    f.dispatch("prepare");
    const pending = f.dispatch("arm");
    const p = f.runtime.nativeController.pass;
    f.packet("clock", f.clock(0, false));
    f.time(500);
    f.packet("clock", f.clock(24000, false));
    f.time(1010);
    f.packet("clock", f.clock(48480, false));
    await pending;
    assert.equal(
      f.wire.some((v) => v.status === "failed"),
      false,
    );
    f.stopReceipt(p.generation);
    const reply = f.wire.at(-1);
    assert.equal(reply.type, "listener.reply");
    assert.equal(reply.reason, "stale_native_preflight");
    const d = reply.nativeFailureDiagnostic;
    assert.equal(d.checkEvidence.check, "preflight-source-span");
    assert.equal(d.checkEvidence.reason, reply.reason);
    assert.equal(d.checkEvidence.elapsedMs, 1010);
    assert.equal(d.checkEvidence.preflight.actualSpanSamples, 48480);
    assert.equal(d.checkEvidence.preflight.maximumSpanSamples, 48000);
    assert.equal(d.checkEvidence.preflight.clockCount, 3);
    assert.equal(d.checkEvidence.preflight.firstClock[4], 0);
    assert.equal(d.checkEvidence.preflight.lastClock[4], 48480);
    assert(
      d.checkEvidence.lifecycle.some(
        (e) => e.phase === "preflight" && e.stage === "started",
      ),
    );
    assert(
      d.checkEvidence.lifecycle.some(
        (e) => e.phase === "preflight" && e.stage === "failed",
      ),
    );
    assert.equal(
      f.wire.some((v) => v.status === "progress"),
      false,
    );
    assert.equal(reply.nativeArm, undefined);
    assert.equal(reply.nativeLaunch, undefined);
    assert.equal(reply.nativeCapture, undefined);
    assert.equal(
      d.checkEvidence.operands.find((o) => o.field === "source-span").actual,
      48480,
    );
    assert(d.checkEvidence.coverage.missing.includes("spectrum"));
    assert.equal(d.cleanup.confirmed, true);
    assert.equal(d.cleanup.generation, p.generation);
    assert.equal(reply.traceId, "v2-trace");
    assert.equal(reply.correlationId, "v2-correlation");
    assert.equal(reply.observation, undefined);
    assert.equal(f.runtime.nativeController.pendingDisarm, null);
  } finally {
    f.runtime.stop();
  }
});

for (const variant of ["unsupported", "encoding", "oversized"])
  test(`prearm ${variant} optional diagnostic cannot erase the original failed ARM reply or replay its buffer`, async () => {
    const f = fixture({ retainedMeasurements: true });
    let job = f.runtime.client.listenerJob;
    let releases = 0;
    Object.defineProperty(f.runtime.client, "listenerJob", {
      configurable: true,
      get: () => job,
      set: (value) => {
        if (job && value === null) releases++;
        job = value;
      },
    });
    try {
      f.dispatch("prepare");
      const pending = f.dispatch("arm");
      const p = f.runtime.nativeController.pass;
      f.packet("clock", f.clock(0, false));
      f.time(500);
      f.packet("clock", f.clock(24000, false));
      f.time(1010);
      f.packet("clock", f.clock(48480, false));
      await pending;
      if (variant === "encoding") {
        const evidence = { ...p.nativeFailureDiagnostic.checkEvidence };
        Object.defineProperty(evidence, "toJSON", {
          value: () => {
            throw new Error("synthetic optional evidence encoding failure");
          },
        });
        p.nativeFailureDiagnostic = {
          ...p.nativeFailureDiagnostic,
          checkEvidence: evidence,
        };
      } else {
        p.nativeFailureDiagnostic = {
          ...p.nativeFailureDiagnostic,
          unsupportedExtension:
            variant === "oversized" ? "x".repeat(130 * 1024) : true,
        };
      }
      assert.equal(
        f.wire.some((v) => v.status === "failed" || v.status === "progress"),
        false,
      );
      f.stopReceipt(p.generation);
      const replies = f.wire.filter(
        (v) => v.type === "listener.reply" && v.status === "failed",
      );
      assert.equal(replies.length, 1);
      assert.equal(replies[0].reason, "stale_native_preflight");
      assert.equal(replies[0].traceId, "v2-trace");
      assert.equal(replies[0].nativeFailureDiagnostic, undefined);
      assert.equal(f.runtime.nativeController.pendingDisarm, null);
      assert.equal(f.runtime.nativeController.pass, null);
      assert.equal(f.runtime.client.listenerJob, null);
      assert.equal(releases, 1);
      assert.equal(f.runtime.client.listenerSequence, 2);
      assert.equal(
        f.wire.some((v) => v.status === "progress"),
        false,
      );
      assert.equal(
        f.wire.some((v) => v.status === "completed" || v.status === "armed"),
        false,
      );
      assert(f.outputs.some((row) => row.includes("native_diagnostic_gap")));
      assert(
        f.outputs.some((row) =>
          row.includes(
            variant === "encoding"
              ? "listener_native_failure_diagnostic_encoding_failed"
              : "listener_native_failure_diagnostic_invalid",
          ),
        ),
      );
      f.stopReceipt(p.generation);
      assert.equal(
        f.wire.filter(
          (v) => v.type === "listener.reply" && v.status === "failed",
        ).length,
        1,
      );
      assert.equal(releases, 1);
    } finally {
      f.runtime.stop();
    }
  });

test("SDK ARM geometry denial preserves bounded source receipt and waits for native cleanup before failing ARM", async () => {
  const f = fixture({ retainedMeasurements: true });
  try {
    const original = f.runtime.client.sendListenerReply.bind(f.runtime.client);
    f.runtime.client.sendListenerReply = (control, payload) =>
      original(
        control,
        payload.status === "armed"
          ? {
              ...payload,
              nativeArm: {
                ...payload.nativeArm,
                geometry: {
                  ...payload.nativeArm.geometry,
                  totalSamples: payload.nativeArm.geometry.totalSamples + 64,
                },
              },
            }
          : payload,
      );
    f.dispatch("prepare");
    const pending = f.dispatch("arm");
    const p = f.runtime.nativeController.pass;
    f.preflight();
    f.configReceipt();
    f.ack();
    await pending;
    assert.equal(
      f.wire.some(
        (frame) => frame.status === "armed" || frame.status === "failed",
      ),
      false,
    );
    f.stopReceipt(p.generation);
    const reply = f.wire.at(-1);
    assert.equal(reply.status, "failed");
    assert.equal(reply.reason, "native_armed_publication_failed");
    assert.equal(reply.traceId, "v2-trace");
    const e = reply.nativeFailureDiagnostic.checkEvidence;
    assert.equal(e.owner, "sdk");
    assert.equal(e.phase, "publication");
    assert.equal(e.reason, "invalid_listener_payload");
    assert.equal(e.sdk.check, "invalid_listener_payload");
    assert.equal(e.predicate, "owned-native-contract");
    assert.deepEqual(e.sdk.armGeometry, {
      field: "totalSamples",
      actual: f.geometry.totalSamples + 64,
      expected: f.geometry.totalSamples,
    });
    assert.equal(reply.nativeFailureDiagnostic.cleanup.confirmed, true);
    assert.equal(f.runtime.nativeController.pendingDisarm, null);
    assert.equal(reply.nativeArm, undefined);
    assert.equal(reply.observation, undefined);
    for (const patch of [
      { actual: NaN },
      { actual: "raw-invalid-body" },
      { field: "audio" },
      { raw: [1, 2, 3] },
    ])
      assert.equal(
        listenerReplyV2Schema.safeParse({
          ...reply,
          nativeFailureDiagnostic: {
            ...reply.nativeFailureDiagnostic,
            checkEvidence: {
              ...e,
              sdk: {
                ...e.sdk,
                armGeometry: { ...e.sdk.armGeometry, ...patch },
              },
            },
          },
        }).success,
        false,
      );
  } finally {
    f.runtime.stop();
  }
});

test("Max IO malformed numeric evidence precedes generic ioError and survives the real SDK", async () => {
  const f = fixture();
  try {
    f.dispatch("prepare");
    const pending = f.dispatch("arm");
    const p = f.runtime.nativeController.pass;
    const io = new NativeMessageIO(
      "spectrum",
      (packet) => f.handlers.native(...packet.slice(1)),
      () => {},
      () => {},
      2,
    );
    io.begin(p.generation);
    io.spectrumDiagnostics([1, 2, 3, NaN, 5]);
    await pending;
    f.stopReceipt(p.generation);
    const d = f.wire.at(-1).nativeFailureDiagnostic;
    assert.equal(f.wire.at(-1).reason, "native_io_packet_failed");
    assert.equal(d.checkEvidence.owner, "io");
    assert.equal(d.checkEvidence.io.site, "spectrumDiagnostics");
    assert.equal(d.checkEvidence.io.mode, "spectrum");
    assert.equal(d.checkEvidence.rejected.cells[3], "non-finite");
    assert.equal(d.cleanup.confirmed, true);
  } finally {
    f.runtime.stop();
  }
});

test("reader rejection traverses runtime and SDK before failed preflight cleanup without changing failure or trace", async () => {
  const f = fixture({ retainedMeasurements: true });
  try {
    f.dispatch("prepare");
    const pending = f.dispatch("arm");
    const generation = f.runtime.nativeController.pass.generation;
    const packets = [];
    const io = new NativeMessageIO(
      "spectrum",
      (packet) => packets.push(packet),
      () => {},
      () => {},
      2,
      { retainedMeasurements: true },
    );
    io.begin(generation, 1, 48000);
    const accepted = [
      1, 1, 1, 1, 1, 0, 64, 1, 0, 0, 1, 2, 3, 4, 5, 6, 1, 1, 1, 1,
    ];
    const empty = [1, 1, 2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 1];
    io.retainedFrame(accepted);
    io.retainedFrame(accepted);
    io.retainedFrame(empty);
    io.retainedFrame(accepted);
    const evidence = packets.find(
      (packet) => packet[2] === "retention-rejection",
    );
    assert.ok(evidence);
    f.handlers.native(...evidence.slice(1));
    f.packet("retention-state", [2, 4, 1, 2, 1, 0, 32, 1, 10, 3]);
    await pending;
    assert.equal(
      f.wire.some((frame) => frame.status === "failed"),
      false,
    );
    f.stopReceipt(generation);
    const terminal = f.wire.at(-1);
    assert.equal(terminal.reason, "native_measurement_delivery_failed");
    assert.equal(
      terminal.nativeFailureDiagnostic.readerReason,
      "invalid_sequence_order",
    );
    assert.deepEqual(
      terminal.nativeFailureDiagnostic.readerReadbacks,
      [accepted, empty, accepted].map((cells) => ({ length: 20, cells })),
    );
    assert.equal(terminal.nativeFailureDiagnostic.generation, generation);
    assert.equal(terminal.traceId, "v2-trace");
    assert.equal(terminal.correlationId, "v2-correlation");
    assert.equal(
      f.wire.some((frame) => frame.observation),
      false,
    );
    assert.equal(f.runtime.nativeController.pendingDisarm, null);
  } finally {
    f.runtime.stop();
  }
});

test("measurement progress publication denial releases retained ownership without a completed context", async () => {
  const f = fixture({
    retainedMeasurements: true,
    reject: (frame) =>
      frame.nativeLifecycle?.phase === "measurement" &&
      frame.nativeLifecycle.stage === "progress",
  });
  try {
    await f.start();
    const pass = f.runtime.nativeController.pass;
    f.packet("retention-state", [1, 2, 1, 2, 1, 1, 16, 1, 250, 0]);
    assert.equal(f.runtime.nativeController.pass, null);
    assert.equal(pass.closed, true);
    assert.deepEqual(pass.retentionStats, {});
    assert.equal(
      f.wire.some(
        (frame) => frame.status === "completed" || frame.observation?.complete,
      ),
      false,
    );
  } finally {
    f.runtime.stop();
  }
});

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

test("placement change or loss disarms only the old v2 generation and fences its late packets", async () => {
  for (const mode of ["move", "unavailable"]) {
    const f = fixture();
    try {
      await f.start();
      const oldClient = f.runtime.client;
      const oldPass = f.runtime.nativeController.pass;
      if (mode === "move")
        f.handlers.identity(
          JSON.stringify({
            canonicalPath: "live_set tracks 0 devices 1",
            track: { id: "1", name: "synthetic fixture" },
            device: { id: "2", name: "Audio-Listener" },
          }),
        );
      else f.handlers["identity-unavailable"]();
      assert.equal(oldClient.stopping, true);
      assert(
        f.outputs.some(
          (row) =>
            row[0] === "native_control" &&
            row[1] === "stop" &&
            row[2] === oldPass.generation,
        ),
      );
      const wireCount = f.wire.length;
      f.handlers.native(
        oldPass.generation,
        "clock",
        ...f.clock(f.origin + 1280),
      );
      f.stopReceipt(oldPass.generation);
      assert.equal(f.wire.length, wireCount);
      if (mode === "move") {
        assert.notEqual(f.runtime.client.instanceId, oldClient.instanceId);
        assert.equal(f.runtime.nativeController.pass, null);
        assert.equal(
          f.runtime.client.listener.deviceCanonicalPath,
          "live_set tracks 0 devices 1",
        );
      } else assert.equal(f.runtime.client, null);
    } finally {
      f.runtime.stop();
    }
  }
});

test("renewed placement registration advances the DSP epoch high-water and completes a distinct fresh capture", async () => {
  for (const terminal of ["completed", "cancelled", "failed"])
    for (const unavailable of [false, true]) {
      const f = fixture();
      try {
        await f.start();
        if (terminal === "completed") {
          f.capture();
          f.post();
        } else if (terminal === "cancelled") await f.dispatch("cancel");
        else f.packet("abi-clock", [0]);
        f.stopReceipt();
        const first = f.wire.find((row) => row.status === terminal);
        assert(first);
        const previous = f.runtime.nativeController;
        const firstEpoch = previous.allocatedEpoch;
        if (unavailable) f.handlers["identity-unavailable"]();
        f.handlers.identity(
          JSON.stringify({
            canonicalPath: "live_set tracks 0 devices 1",
            track: { id: "1", name: "synthetic fixture" },
            device: { id: "2", name: "Audio-Listener" },
          }),
        );
        assert.notEqual(f.runtime.nativeController, previous);
        const next = v2Fixture({
          controller: f.runtime.nativeController,
          setTime: f.time,
        });
        const owner = { passId: "renewed-pass", jobId: "renewed-job" };
        f.dispatch("prepare", owner);
        const pending = f.dispatch("arm", owner);
        next.preflight();
        assert.equal(
          f.runtime.nativeController.pass.nativeEpoch,
          firstEpoch + 1,
        );
        next.configReceipt();
        next.ack();
        await pending;
        next.packet("clock", next.clock(next.origin + 640));
        next.packet("envelope", next.envelope());
        next.capture();
        next.post();
        f.stopReceipt();
        const completed = f.wire.filter((row) => row.status === "completed");
        assert.equal(completed.length, terminal === "completed" ? 2 : 1);
        const last = completed.at(-1);
        assert.equal(last.passId, owner.passId);
        assert.notEqual(last.passId, first.passId);
        assertNativeCaptureObservationV2(last.nativeCapture, last.observation, {
          listenerId: f.runtime.engine.listenerId,
          passId: owner.passId,
          geometry: next.geometry,
          policy: next.timingPolicy,
        });
        assert.equal(f.runtime.nativeController.pendingDisarm, null);
        assert.equal(f.runtime.nativeController.pass, null);
      } finally {
        f.runtime.stop();
      }
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
        assert.deepEqual(failed.nativeFailureDiagnostic, {
          ...p.nativeFailureDiagnostic,
          ...(failed.nativeFailureDiagnostic.cleanup
            ? { cleanup: failed.nativeFailureDiagnostic.cleanup }
            : {}),
        });
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
    const f = fixture({
      policy: { mode: "strict", maxClockDisagreementSamples: 0 },
    });
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
      const f = fixture({
        policy: { mode: "strict", maxClockDisagreementSamples: 0 },
      });
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
      const f = fixture({
        policy: { mode: "strict", maxClockDisagreementSamples: 0 },
      });
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
              (frame) =>
                frame.nativeFailureDiagnostic === undefined ||
                frame.nativeFailureDiagnostic.checkEvidence.reason ===
                  "cancelled",
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
          assert.deepEqual(failed[0].nativeFailureDiagnostic, {
            ...p.nativeFailureDiagnostic,
            cleanup: failed[0].nativeFailureDiagnostic.cleanup,
          });
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

test("v2 real SDK carries descriptive timing jitter without changing native duration or source attribution", async () => {
  const f = fixture({ deviation: 4800 });
  try {
    await f.start();
    f.capture();
    f.post();
    const completed = f.wire.find((value) => value.status === "completed");
    assert(completed, JSON.stringify(f.wire.slice(-2)));
    assert.equal(
      completed.observation.alignment.observedClockDisagreementSamples,
      4800,
    );
    assertNativeCaptureObservationV2(
      completed.nativeCapture,
      completed.observation,
      {
        policy: f.timingPolicy,
        geometry: f.geometry,
        listenerId: completed.observation.listenerId,
        passId: V2_OWNER.passId,
      },
    );
    assert.equal(
      f.wire.some((value) => value.status === "failed"),
      false,
    );
    f.stopReceipt(f.runtime.nativeController.pendingDisarm.generation);
    assert.equal(f.runtime.nativeController.pendingDisarm, null);
  } finally {
    f.runtime.stop();
  }
});

test("v2 native-handler tempo changes fail through the real SDK despite a 480-sample target and zero clock residual", async () => {
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
