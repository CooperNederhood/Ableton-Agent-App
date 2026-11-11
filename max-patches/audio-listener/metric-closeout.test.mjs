import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { runInNewContext, runInThisContext } from "node:vm";
import { URL } from "node:url";
import { Buffer } from "node:buffer";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { compileNativeMetricProtocol } from "../../scripts/lib/native-metric-protocol-bundle.mjs";

const require = createRequire(import.meta.url);
const { createMetricRuntime } = require("./audio_listener_metric_runtime.js");
const bundle = await compileNativeMetricProtocol({
  stage: async (_name, work) => work(),
});
const module = { exports: {} };
runInThisContext(`(function(require, module, exports) {${bundle.source}\n})`)(
  require,
  module,
  module.exports,
);
const codec = module.exports;
const clientModule = { exports: {} };
const clientURL = new URL("../shared/agent_signal_client.js", import.meta.url);
runInThisContext(
  `(function(require, module, exports, __dirname) {${await readFile(clientURL, "utf8")}\n})`,
)(
  (name) =>
    name === "./audio_listener_metric_protocol.js" ? codec : require(name),
  clientModule,
  clientModule.exports,
  dirname(fileURLToPath(clientURL)),
);
const { AgentSignalClient } = clientModule.exports;
const identity = (canonicalPath = "live_set tracks 0 devices 0") => ({
  canonicalPath,
  track: { id: "17", name: "name is not ownership" },
  device: { id: "29", name: "name is not ownership" },
});

test("shared SDK rejects retired listener versions instead of negotiating a capture fallback", () => {
  for (const version of [1, 2, 3, 4]) {
    assert.throws(
      () =>
        new AgentSignalClient({
          signalKind: "audio",
          listener: { version },
          env: {},
          descriptorPath: "/fixture/profile/descriptor.json",
          secretPath: "/fixture/profile/secret.json",
        }),
      /Only canonical metric5 audio listening is supported/,
    );
  }
});

function fixture(options = {}) {
  const handlers = {},
    clients = [],
    outputs = [],
    calls = [];
  let tick, controllerOptions;
  const controller = {
    snapshot: () => ({ state: "idle", cleanup: "completed" }),
    prepare: (...args) => calls.push(["prepare", ...args]),
    arm: (...args) => calls.push(["arm", ...args]),
    cancel: (...args) => calls.push(["cancel", ...args]),
    dispose: () => calls.push(["dispose"]),
    receiveNative: (...args) => calls.push(["receive", ...args]),
    tick() {},
    ...options.controller,
  };
  class OfflineClient extends AgentSignalClient {
    constructor(config) {
      super(config);
      this.config = config;
      clients.push(this);
    }
    configureProducer(value) {
      assert.equal(this.started, false);
      calls.push(["configure"]);
      return super.configureProducer(value);
    }
    start() {
      assert.ok(this.producer);
      calls.push(["start"]);
      this.started = true;
    }
    stop() {
      calls.push(["stop"]);
      return super.stop();
    }
  }
  const runtime = createMetricRuntime({
    maxApi: {
      addHandler: (name, handler) => (handlers[name] = handler),
      outlet: (...atoms) => outputs.push(atoms),
    },
    Client: OfflineClient,
    protocol: codec,
    createController(config) {
      controllerOptions = config;
      return controller;
    },
    env: {
      ABLETON_AGENT_SIGNAL_INGRESS_DESCRIPTOR:
        "/fixture/profile/descriptor.json",
      ABLETON_AGENT_SIGNAL_INGRESS_SECRET_PATH: "/fixture/profile/secret.json",
      ...options.env,
    },
    now: () => 100,
    interval(handler) {
      tick = handler;
      return 1;
    },
    clear: () => calls.push(["clear"]),
  });
  const ready = () => {
    const probe = outputs.find(
      ([selector, action]) =>
        selector === "mel_native_control" && action === "probe",
    );
    if (probe)
      handlers.native_mel("analyzer_ready", 3, probe[2], 1, 48000, 3, 10, 1);
  };
  return {
    runtime,
    handlers,
    clients,
    calls,
    outputs,
    tick: () => tick(),
    ready,
    get controllerOptions() {
      return controllerOptions;
    },
    start(value = identity()) {
      handlers.identity(JSON.stringify(value));
      handlers.dsp(1, 48000, 64);
      ready();
    },
  };
}

test("closeout wire codec is compiled from actual sources with bounded byte/config provenance", async () => {
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  assert.equal(hash(bundle.source), bundle.provenance.sha256);
  assert.equal(Buffer.byteLength(bundle.source), bundle.provenance.bytes);
  assert(bundle.provenance.bytes < 4 * 1024 * 1024);
  for (const input of bundle.provenance.inputs) {
    assert.doesNotMatch(input.path, /(?:^|\/)dist\//);
    if (
      input.path.startsWith("packages/") ||
      input.path.startsWith("max-patches/")
    ) {
      const bytes = await readFile(
        new URL(`../../${input.path}`, import.meta.url),
      );
      assert.equal(hash(bytes), input.sha256, input.path);
      assert.equal(bytes.length, input.bytes, input.path);
    }
  }
  assert.equal(codec.LISTENER_VERSION_METRIC, 5);
  assert.equal(typeof codec.listenerControlMetricSchema.parse, "function");
  assert.equal(typeof codec.nativeMetricLifecycleSchema.parse, "function");
});

for (const path of [
  "live_set tracks 0 devices 1",
  "live_set return_tracks 2 devices 3",
  "live_set master_track devices 0",
]) {
  test(`actual metric shared client configures identity before start: ${path}`, async () => {
    const f = fixture();
    f.start(identity(path));
    const client = f.clients[0];
    assert.equal(f.clients.length, 1);
    assert.deepEqual(f.calls.slice(0, 2), [["configure"], ["start"]]);
    codec.listenerRegistrationMetricSchema.parse(client.listener);
    assert.equal(client.listener.deviceCanonicalPath, path);
    assert.equal(
      client.listener.trackCanonicalPath,
      path.replace(/ devices \d+$/, ""),
    );
    assert.equal(client.producer.device.id, "29");
    assert.equal(client.listener.version, 5);
    assert.equal(client.listener.nativeStatus.readiness, "BLOCKED");
    assert.equal(
      client.listener.nativeStatus.verifiedAbsoluteErrorBoundSamples,
      null,
    );
    f.handlers.identity(JSON.stringify(identity(path)));
    assert.equal(f.clients.length, 1);
    client.config.onStatus("live", "connected");
    assert.equal(client.listener.nativeStatus.readiness, "BLOCKED");
    await f.runtime.stop();
    assert.equal(client.stopping, true);
    assert(f.calls.some(([name]) => name === "clear"));
  });
}

for (const [change, reason] of [
  [
    (f) =>
      f.handlers.identity(
        JSON.stringify(identity("live_set tracks 0 devices 1")),
      ),
    "identity_changed_requires_reload",
  ],
  [
    (f) => f.handlers["identity-unavailable"](),
    "listener_placement_unavailable",
  ],
  [
    (f) =>
      f.handlers.identity(
        JSON.stringify({ ...identity(), device: { id: "", name: "bad" } }),
      ),
    "invalid_producer_identity",
  ],
  [(f) => f.handlers.dsp(1, 44100, 64), "dsp_configuration_changed"],
  [(f) => f.handlers.dsp(0, 48000, 64), "dsp_disabled"],
  [
    (f) => f.clients[0].config.onStatus("live", "disconnected"),
    "disconnected_requires_reload",
  ],
  [(f) => f.handlers.reset(), "device_reset"],
]) {
  test(`metric invalidation is terminal, not a compatibility reconnect: ${reason}`, async () => {
    const f = fixture();
    f.start();
    change(f);
    assert(
      f.outputs.some(
        (atoms) => atoms[0] === "diagnostic" && atoms[1] === reason,
      ),
    );
    assert.equal(f.clients[0].stopping, true);
    const controls = f.calls.filter(([name]) =>
      ["prepare", "arm", "cancel"].includes(name),
    ).length;
    assert.throws(
      () => f.clients[0].config.onListenerControl({ action: "arm" }),
      /metric_runtime_stopping/,
    );
    f.start();
    assert.equal(f.clients.length, 1);
    assert.equal(
      f.calls.filter(([name]) => ["prepare", "arm", "cancel"].includes(name))
        .length,
      controls,
    );
    await f.runtime.stop();
  });
}

test("native budget rejection consumes no epoch or source lease and keeps its exact SDK failure reason", async () => {
  let deny = true,
    admission;
  const f = fixture({
    controller: {
      prepare(_control, value) {
        if (deny)
          throw Object.assign(new Error("metric_result_budget_exceeded"), {
            code: "metric_result_budget_exceeded",
          });
        admission = value;
      },
    },
  });
  f.start();
  const command = {
    action: "prepare",
    generation: "generation-budget",
    traceId: "trace-budget",
    correlationId: "correlation-budget",
    causationId: "cause-budget",
    config: { geometry: { totalSamples: 1440000, sampleRate: 48000 } },
  };
  assert.throws(
    () => f.clients[0].config.onListenerControl(command),
    (error) => {
      assert.equal(
        f.clients[0].listenerErrorReason(error),
        "metric_result_budget_exceeded",
      );
      return true;
    },
  );
  assert.equal(
    f.outputs.some(
      ([selector, action]) =>
        selector === "native_control" && action === "begin",
    ),
    false,
  );
  deny = false;
  f.clients[0].config.onListenerControl(command);
  assert.equal(admission.nativeEpoch, 1);
  assert.equal(admission.maxObservationBytes, 2 * 1024 * 1024);
  await f.runtime.stop();
});

test("metric generation lease propagates attribution, deadline and monotonic epochs through cancel/cleanup", async () => {
  const f = fixture();
  f.start();
  const first = {
    action: "prepare",
    generation: "generation-1",
    traceId: "trace-1",
    correlationId: "correlation-1",
    causationId: "cause-1",
    config: { geometry: { totalSamples: 48000, sampleRate: 48000 } },
  };
  f.clients[0].config.onListenerControl(first);
  assert.deepEqual(f.calls.find(([name]) => name === "prepare").slice(1), [
    first,
    {
      nativeEpoch: 1,
      deadlineMs: 21100,
      maxObservationBytes: codec.MAX_METRIC_OBSERVATION_BYTES,
    },
  ]);
  assert.deepEqual(f.outputs.slice(-2), [
    [
      "native_watchdog_context",
      first.generation,
      first.traceId,
      first.correlationId,
      first.causationId,
    ],
    ["native_control", "begin", first.generation, 1, 48000],
  ]);
  assert.throws(
    () =>
      f.clients[0].config.onListenerControl({
        ...first,
        generation: "foreign",
      }),
    /metric_clock_still_owned/,
  );
  f.clients[0].config.onListenerControl({ ...first, action: "cancel" });
  f.tick();
  assert.deepEqual(f.outputs.slice(-2), [
    ["native_control", "stop", first.generation],
    ["native_control", "release", first.generation],
  ]);
  f.clients[0].config.onListenerControl({
    ...first,
    generation: "generation-2",
  });
  assert.equal(
    f.calls.filter(([name]) => name === "prepare").at(-1)[2].nativeEpoch,
    2,
  );
  await f.runtime.stop();
  assert(!f.outputs.some((row) => row.includes("transport")));
});

for (const packet of ["{", "x".repeat(32769), null, 42]) {
  test(`malformed metric packet is bounded and cannot reach the controller: ${typeof packet}/${String(packet).length}`, async () => {
    const f = fixture();
    f.start();
    f.handlers.native_metric(packet);
    assert(!f.calls.some(([name]) => name === "receive"));
    assert(f.outputs.some((row) => row[1] === "invalid_metric_packet"));
    assert(!JSON.stringify(f.outputs).includes("x".repeat(100)));
    await f.runtime.stop();
  });
}

test("shutdown waits for genuine cleanup, is idempotent, and failed cleanup stays failure", async () => {
  let state = { state: "capturing", cleanup: "pending" };
  const f = fixture({ controller: { snapshot: () => state } });
  f.start();
  let settled = false;
  const stopped = f.runtime.stop();
  stopped.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  assert.equal(f.runtime.stop(), stopped);
  await Promise.resolve();
  assert.equal(settled, false);
  assert(!f.calls.some(([name]) => name === "clear"));
  state = { state: "failed", cleanup: "failed" };
  f.tick();
  await assert.rejects(stopped, /native_cleanup_unconfirmed/);
  assert(f.calls.some(([name]) => name === "clear"));
  assert(
    !f.outputs.some(
      (row) => row[0] === "native_control" && row[1] === "release",
    ),
  );
});

test("actual shared watcher fences deleted callbacks while metric placement changes require reload", async () => {
  const f = fixture();
  const pending = new Set(),
    reports = [];
  const device = { id: 29, path: "live_set tracks 0 devices 0" };
  const track = { id: 17, path: "live_set tracks 0" };
  const context = {
    jsarguments: ["producer_identity_common.js", "watch"],
    LiveAPI: function (...args) {
      const object = args.at(-1) === "live_set this_device" ? device : track;
      return {
        get id() {
          return object.id;
        },
        get unquotedpath() {
          return object.path;
        },
        get type() {
          return object === device ? "MaxDevice" : "Track";
        },
        get: () => "fixture",
      };
    },
    Task: function (fn, target, ...args) {
      this.cancel = () => pending.delete(this);
      this.schedule = (delay) => {
        assert(delay >= 250);
        pending.add(this);
      };
      this.fire = () => {
        pending.delete(this);
        fn.apply(target, args);
      };
    },
    outlet: (_outlet, name, value) => {
      reports.push([name, value]);
      f.handlers[name]?.(value);
    },
    post() {},
  };
  runInNewContext(
    await readFile(
      new URL("../shared/producer_identity.js", import.meta.url),
      "utf8",
    ),
    context,
  );
  context.bang();
  f.handlers.dsp(1, 48000, 64);
  f.ready();
  assert.equal(f.clients.length, 1);
  const tick = () => [...pending].forEach((task) => task.fire());
  tick();
  assert.equal(reports.length, 1);
  device.path = "live_set tracks 0 devices 1";
  tick();
  assert.equal(JSON.parse(reports.at(-1)[1]).canonicalPath, device.path);
  assert.equal(f.clients[0].stopping, true);
  assert.equal(f.clients.length, 1);
  device.id = 0;
  tick();
  assert.equal(reports.at(-1)[0], "identity-unavailable");
  const late = [...pending],
    count = reports.length;
  context.notifydeleted();
  late.forEach((task) => task.fire());
  assert.equal(reports.length, count);
  assert.equal(pending.size, 0);
  await f.runtime.stop();
});
