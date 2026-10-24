/* global structuredClone */
import "./native-protocol-test-loader.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  nativeRuntimeDocuments,
  appendNativeRuntimeGraph,
} from "./native-runtime-source.mjs";
import { sourceDocuments } from "./native-source.mjs";
const require = createRequire(import.meta.url);
const { createRuntime } = require("./audio_listener_runtime.js");
const { v2Fixture, V2_OWNER } = require("./native-v2-fixture.cjs");
const {
  listenerRegistrationSessionSchema,
  listenerControlSessionSchema,
  listenerReplySessionSchema,
  listenerResultSessionSchema,
} =
  await import("../../packages/signal-routing/src/listener-session-contracts.ts");
const { assertNativeSessionCaptureObservation } =
  await import("../../packages/protocol/src/native-session-listening-schemas.ts");
const source = {
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
};
// Controlled client boundary; authentication is separately exercised by ingress tests.
function fixture(options = {}) {
  const handlers = {},
    outputs = [],
    wire = [],
    cleared = [];
  let sequence = 0,
    request = 0;
  class Client {
    constructor(options) {
      this.options = options;
      this.listener = {
        ...options.listener,
        connectionEpoch: V2_OWNER.connectionEpoch,
      };
      listenerRegistrationSessionSchema.parse(this.listener);
      this.producer = { producerId: "synthetic-session" };
    }
    configureProducer() {}
    start() {
      this.authenticated = true;
    }
    stop() {
      this.authenticated = false;
    }
    send(kind, control, data) {
      const frame = {
        ...control,
        ...data,
        type: `listener.${kind}`,
        sequence: sequence++,
      };
      delete frame.action;
      delete frame.config;
      (kind === "reply"
        ? listenerReplySessionSchema
        : listenerResultSessionSchema
      ).parse(frame);
      wire.push(frame);
      if (
        (kind === "reply" && ["cancelled", "failed"].includes(data.status)) ||
        (kind === "result" && data.status !== "progress")
      )
        this.listenerJob = null;
      return true;
    }
    sendListenerReply(control, data) {
      return this.send("reply", control, data);
    }
    sendListenerResult(control, data) {
      return this.send("result", control, data);
    }
  }
  const runtime = createRuntime({
    nativeMode: true,
    nativeVersion: 3,
    Client,
    clock: () => 0,
    maxApi: {
      addHandler: (name, fn) => {
        handlers[name] = fn;
      },
      outlet: (...v) => outputs.push(v),
    },
    env: {
      ABLETON_AGENT_SIGNAL_INGRESS_DESCRIPTOR:
        "/synthetic/session/descriptor.json",
      ABLETON_AGENT_SIGNAL_INGRESS_SECRET_PATH:
        "/synthetic/session/secret.json",
    },
    interval: (fn) => fn,
    clear: (fn) => cleared.push(fn),
  });
  handlers.identity(
    JSON.stringify({
      canonicalPath: "live_set tracks 0 devices 0",
      track: { id: "1", name: "synthetic" },
      device: { id: "2", name: "listener" },
    }),
  );
  handlers.dsp(1, 48000, 64);
  handlers.host(0, 5.25, 1000000, 31);
  const f = v2Fixture({ ...options, controller: runtime.nativeController });
  const dispatch = (action, patch = {}, validate = true) => {
    const control = {
      ...V2_OWNER,
      type: "listener.control",
      protocolVersion: 1,
      listenerVersion: 3,
      requestId: `session-${++request}`,
      jobId: "session-job",
      traceId: "session-trace",
      correlationId: "session-correlation",
      causationId: "session-cause",
      action,
      ...(action === "prepare"
        ? {
            config: {
              geometry: f.geometry,
              timingPolicy: f.timingPolicy,
              source: structuredClone(source),
            },
          }
        : {}),
      ...patch,
    };
    if (validate) listenerControlSessionSchema.parse(control);
    if (action === "prepare") runtime.client.listenerJob = control;
    return runtime.client.options.onListenerControl(control);
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
  };
  return { ...f, runtime, handlers, outputs, wire, cleared, dispatch, start };
}

test("wire3 source preparation supports bundled Node without Object.hasOwn", async () => {
  const original = Object.getOwnPropertyDescriptor(Object, "hasOwn");
  Object.defineProperty(Object, "hasOwn", { ...original, value: undefined });
  try {
    const f = fixture();
    await f.dispatch("prepare");
    assert.equal(f.wire.at(-1).status, "ready");
    f.runtime.stop();
  } finally {
    Object.defineProperty(Object, "hasOwn", original);
  }
});

test("wire3 reuses the byte-identical ABI2 graph, one recorder and explicit bootstrap/guard", async () => {
  assert.deepEqual(
    nativeRuntimeDocuments({ nativeVersion: 3 }),
    nativeRuntimeDocuments({ nativeVersion: 2 }),
  );
  const documents = await sourceDocuments();
  for (const { box } of documents["Audio-Listener.maxpat"].patcher.boxes) {
    if (box.text?.startsWith("node.script ")) box.varname = "ml_runtime";
    if (box.text === "js audio_listener_guard.js") box.varname = "ml_guard";
  }
  const graph = appendNativeRuntimeGraph(documents["Audio-Listener.maxpat"], {
    nativeVersion: 3,
    runtimeEntry: "audio_listener_native_v3_max.js",
  });
  const boxes = graph.patcher.boxes.map(({ box }) => box);
  assert.equal(boxes.filter((box) => box.text === "plugin~").length, 1);
  assert(boxes.some((box) => box.text === "js audio_listener_guard.js 3"));
  assert(
    boxes.some((box) => box.text?.includes("audio_listener_native_v3_max.js")),
  );
});
test("wire3 completes bounded transport measurement with explicit non-authority source wrapper", async () => {
  const f = fixture();
  try {
    assert.equal(f.runtime.nativeController.nativeVersion, 2);
    assert.equal(f.runtime.nativeStatus.abiVersion, 2);
    assert.equal(f.runtime.nativeStatus.readiness, "BLOCKED");
    assert.equal(
      f.runtime.client.options.schemaVersion,
      "audio-observation/v2",
    );
    await f.start();
    f.capture();
    f.post();
    const completed = f.wire.find((v) => v.status === "completed");
    assert(completed, JSON.stringify(f.wire.slice(-2)));
    assert.equal(completed.nativeCapture.scope, "session-transport-coupled/v1");
    assert.equal(
      completed.nativeCapture.transport.armed.scope,
      "arrangement-descriptive/v2",
    );
    assert.equal(completed.observation.schema, "audio-observation/v2");
    assert.equal(completed.observation.algorithm.version, "2.0.0");
    assertNativeSessionCaptureObservation(
      completed.nativeCapture,
      completed.observation,
      {
        source,
        policy: f.timingPolicy,
        geometry: f.geometry,
        listenerId: completed.observation.listenerId,
        passId: V2_OWNER.passId,
      },
    );
    assert(f.wire.some((v) => v.nativeLaunch));
    assert(
      f.wire
        .filter((v) => v.nativeLifecycle)
        .every(
          (v) => v.nativeLifecycle.scope === "session-transport-coupled/v1",
        ),
    );
  } finally {
    f.runtime.stop();
  }
  assert.equal(f.cleared.length, 1);
});
test("wire3 cancellation disarms ABI2 and does not invent clip proof", async () => {
  const f = fixture();
  try {
    await f.start();
    f.dispatch("cancel");
    const generation = f.runtime.nativeController.pendingDisarm?.generation;
    assert(generation);
    f.handlers.native(generation, "stopped", 0, 0, 2);
    assert(f.wire.some((v) => v.status === "cancelled"));
    assert.equal(
      f.wire.some((v) => v.nativeCapture),
      false,
    );
  } finally {
    f.runtime.stop();
  }
});

for (const kind of ["abi", "clock", "config", "spectrum", "tempo", "strict"])
  test(`wire3 ${kind} failure remains fail-closed with owned ABI2 cleanup`, async () => {
    const f = fixture(
      kind === "strict"
        ? { policy: { mode: "strict", maxClockDisagreementSamples: 0 } }
        : {},
    );
    try {
      await f.start();
      if (kind === "abi") f.packet("abi-envelope", [3]);
      if (kind === "clock" || kind === "strict")
        f.packet("clock", f.clock(f.origin + 1280, true, 65));
      if (kind === "config")
        f.packet("config", [
          f.controller.pass.nativeEpoch,
          1,
          4800,
          93,
          0.25,
          64,
          f.controller.pass.nativeEpoch,
        ]);
      if (kind === "spectrum") f.packet("spectrum", [0, 0, 0, 0, 0, 37]);
      if (kind === "tempo") f.packet("tempo", [93 + 1e-6]);
      const generation = f.controller.pendingDisarm?.generation;
      assert(generation, `${kind}: missing owned cleanup`);
      f.handlers.native(
        "22222222-2222-4222-8222-222222222222",
        "stopped",
        0,
        0,
        2,
      );
      assert(f.controller.pendingDisarm);
      f.handlers.native(generation, "stopped", 0, 0, 2);
      assert(
        f.wire.some((v) => v.status === "failed"),
        JSON.stringify(f.wire.slice(-2)),
      );
      assert.equal(
        f.wire.some((v) => v.nativeCapture),
        false,
      );
    } finally {
      f.runtime.stop();
    }
  });

test("wire3 rejects unbounded source contexts, duration and configuration keys before native begin", () => {
  for (const change of [
    (config) => ({ ...config, source: { ...source, authority: "native" } }),
    (config) => ({
      ...config,
      source: { ...source, target: { ...source.target, sceneIndex: 256 } },
    }),
    (config) => ({
      ...config,
      geometry: {
        ...config.geometry,
        endBeat: config.geometry.startBeat + 5,
        totalSamples: Math.round((5 * 48000 * 60) / 93),
      },
    }),
    (config) => ({ ...config, extra: true }),
    (config) => ({
      ...config,
      timingPolicy: { mode: "strict", maxClockDisagreementSamples: 1 },
    }),
  ]) {
    const f = fixture();
    try {
      f.dispatch(
        "prepare",
        {
          config: change({
            geometry: f.geometry,
            timingPolicy: f.timingPolicy,
            source,
          }),
        },
        false,
      );
      assert(f.wire.some((v) => v.status === "failed"));
      assert.equal(
        f.outputs.some((v) => v[0] === "native_control" && v[1] === "begin"),
        false,
      );
    } finally {
      f.runtime.stop();
    }
  }
});
