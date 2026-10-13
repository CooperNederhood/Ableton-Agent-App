const test = require("node:test");
const assert = require("node:assert/strict");
const { createRuntime } = require("./audio_listener_runtime.js");

const SYNTHETIC_CERTIFICATE = {
  validated: true,
  algorithmVersion: "1.0.0",
  hostVersion: "test-double",
  maxVersion: "test-double",
  launchAligned: true,
  requiredHostFlags: 3,
  uncertaintySamples: 64,
  descriptorOffsetSamples: 0,
  sampleRate: 48000,
  vectorSize: 64,
};

function fixture({ certificate = null } = {}) {
  const handlers = {},
    clients = [],
    output = [],
    events = [],
    timers = [];
  class Client {
    constructor(options) {
      this.options = options;
      this.instanceId = options.instanceId;
      clients.push(this);
    }
    configureProducer() {}
    start() {
      events.push(["start", this]);
    }
    stop() {
      events.push(["stop", this]);
    }
    sendListenerReply(control, value) {
      events.push(["reply", control, value]);
    }
    sendListenerResult(control, value) {
      events.push(["result", control, value]);
    }
  }
  const runtime = createRuntime({
    maxApi: {
      addHandler: (name, fn) => {
        handlers[name] = fn;
      },
      outlet: (...args) => output.push(args),
    },
    Client,
    env: {
      ABLETON_AGENT_SIGNAL_INGRESS_DESCRIPTOR: "/fixture/descriptor.json",
      ABLETON_AGENT_SIGNAL_INGRESS_SECRET_PATH: "/fixture/credential.json",
    },
    interval: (fn) => {
      timers.push(fn);
      return fn;
    },
    clear: (fn) => {
      events.push(["clear", fn]);
    },
    clock: () => 0,
    certificate,
  });
  const poll = () => {
    handlers.identity(
      JSON.stringify({
        canonicalPath: "live_set tracks 0 devices 0",
        track: { id: "1", name: "fixture" },
        device: { id: "2", name: "Audio-Listener" },
      }),
    );
    handlers.dsp(1, 48000, 64);
    handlers.host(0, 4, 10000, 3);
    timers[0]();
  };
  return { runtime, handlers, clients, output, events, timers, poll };
}

test("registration waits for explicit native preview state even with valid identity, DSP and discovery", () => {
  const f = fixture();
  try {
    for (let i = 0; i < 200; i++) f.poll();
    assert.equal(f.clients.length, 0);
    assert.equal(f.runtime.engine, null);
    assert.deepEqual(
      f.output.filter((v) => v[0] === "diagnostic"),
      [["diagnostic", "device_preview_state_required"]],
    );
    f.handlers["device-preview"](0);
    assert.equal(f.clients.length, 1);
    assert.equal(f.runtime.nativeStatus.readiness, "BLOCKED");
  } finally {
    f.runtime.stop();
  }
});

test("native editor preview cannot register; polling and repeated preview notifications stay bounded", () => {
  const f = fixture();
  try {
    f.handlers["device-preview"](1);
    for (let i = 0; i < 200; i++) {
      f.poll();
      f.handlers["device-preview"](1);
    }
    assert.equal(f.clients.length, 0);
    assert.equal(f.output.filter((v) => v[0] === "analysis").length, 1);
    assert.deepEqual(
      f.output.filter((v) => v[0] === "diagnostic"),
      [["diagnostic", "editor_preview_blocked"]],
    );
    f.handlers["device-preview"](0);
    assert.equal(f.clients.length, 1);
    f.handlers["device-preview"](0);
    assert.equal(f.clients.length, 1);
  } finally {
    f.runtime.stop();
  }
});

test("preview transition releases registration, fences callbacks and reconnects with a fresh instance", () => {
  const f = fixture();
  try {
    f.handlers["device-preview"](0);
    f.poll();
    const old = f.runtime.client;
    f.handlers["device-preview"](1);
    assert.equal(f.runtime.client, null);
    assert.equal(f.runtime.engine, null);
    assert.deepEqual(
      f.events.filter((e) => e[0] === "stop"),
      [["stop", old]],
    );
    const count = f.output.length;
    old.options.onStatus("live", "connected");
    old.options.onListenerFailure("late_failure");
    old.options.onListenerControl({ action: "prepare", passId: "stale" });
    assert.equal(f.output.length, count);
    assert.equal(f.events.filter((e) => e[0] === "reply").length, 0);
    f.poll();
    assert.equal(f.clients.length, 1);
    f.handlers["device-preview"](0);
    assert.equal(f.clients.length, 2);
    assert.notEqual(f.runtime.client.instanceId, old.instanceId);
    assert.equal(f.runtime.nativeStatus.readiness, "BLOCKED");
    f.runtime.stop();
    f.handlers["device-preview"](0);
    f.handlers["device-preview"](1);
    f.poll();
    assert.equal(f.clients.length, 2);
    assert.equal(f.events.filter((e) => e[0] === "clear").length, 1);
  } finally {
    f.runtime.stop();
  }
});

test("malformed preview state fails closed and cannot use truthiness to permit registration", () => {
  for (const value of [undefined, null, false, true, "0", "1", 2, -1, NaN]) {
    const f = fixture();
    try {
      f.handlers["device-preview"](0);
      f.poll();
      const old = f.runtime.client;
      f.handlers["device-preview"](value);
      for (let i = 0; i < 5; i++) {
        f.handlers["device-preview"](value);
        f.poll();
      }
      assert.equal(f.runtime.client, null);
      assert.equal(f.clients.length, 1);
      assert.deepEqual(
        f.events.filter((e) => e[0] === "stop"),
        [["stop", old]],
      );
      assert.deepEqual(
        f.output.filter((v) => v[0] === "diagnostic"),
        [["diagnostic", "invalid_device_preview_state"]],
      );
    } finally {
      f.runtime.stop();
    }
  }
});

test("preview takeover terminates only its own synthetic pass before closing transport, retaining attribution", () => {
  const f = fixture({ certificate: SYNTHETIC_CERTIFICATE });
  try {
    f.handlers["device-preview"](0);
    f.poll();
    const client = f.runtime.client;
    const owner = {
      passId: "pass",
      jobId: "job",
      connectionEpoch: "epoch",
      traceId: "trace",
      correlationId: "correlation",
      causationId: "cause",
      config: {
        source: { mode: "arrangement", startBeat: 4, endBeat: 8 },
        durationMs: 1000,
        maxWindows: 10,
      },
    };
    client.options.onListenerControl({ ...owner, action: "prepare" });
    client.options.onListenerControl({ ...owner, action: "arm" });
    f.handlers.host(1, 4, 10000, 3);
    assert.equal(f.runtime.engine.state, "capturing");
    f.handlers["device-preview"](1);
    const terminal = f.events.findIndex((e) => e[0] === "result");
    const stop = f.events.findIndex((e) => e[0] === "stop");
    assert.ok(terminal >= 0 && stop > terminal);
    assert.deepEqual(f.events[terminal][1], { ...owner, action: "arm" });
    assert.equal(f.events[terminal][2].status, "partial");
    assert.equal(f.events[terminal][2].reason, "editor_preview_blocked");
    assert.equal(f.events[terminal][2].observation.complete, false);
    assert.equal(f.events.filter((e) => e[0] === "result").length, 1);
    assert.ok(
      f.output.every((v) => !["transport", "play", "stop"].includes(v[0])),
    );
  } finally {
    f.runtime.stop();
  }
});

test("explicit non-preview state cannot bypass DSP or identity prerequisites", () => {
  const f = fixture();
  try {
    f.handlers["device-preview"](0);
    f.handlers.dsp(1, 48000, 64);
    f.handlers.host(0, 4, 10000, 3);
    assert.equal(f.clients.length, 0);
    f.handlers.dsp(0, 48000, 64);
    f.handlers.identity(
      JSON.stringify({
        canonicalPath: "live_set tracks 0 devices 0",
        track: { id: "1", name: "fixture" },
        device: { id: "2", name: "Audio-Listener" },
      }),
    );
    assert.equal(f.clients.length, 0);
    f.handlers.dsp(1, 48000, 64);
    assert.equal(f.clients.length, 1);
  } finally {
    f.runtime.stop();
  }
});

test("cancelled synthetic pass stays cancelled across preview shutdown without a duplicate terminal", () => {
  const f = fixture({ certificate: SYNTHETIC_CERTIFICATE });
  try {
    f.handlers["device-preview"](0);
    f.poll();
    const client = f.runtime.client;
    const owner = {
      passId: "pass",
      jobId: "job",
      connectionEpoch: "epoch",
      traceId: "trace",
      correlationId: "correlation",
      causationId: "cause",
      config: {
        source: { mode: "arrangement", startBeat: 4, endBeat: 8 },
        durationMs: 1000,
        maxWindows: 10,
      },
    };
    client.options.onListenerControl({ ...owner, action: "prepare" });
    const cancel = { ...owner, action: "cancel" };
    client.options.onListenerControl(cancel);
    assert.deepEqual(f.events.filter((e) => e[0] === "reply").at(-1), [
      "reply",
      cancel,
      { status: "cancelled" },
    ]);
    const count = f.events.filter((e) => e[0] === "reply").length;
    f.handlers["device-preview"](1);
    client.options.onListenerControl({ ...owner, action: "arm" });
    assert.equal(f.events.filter((e) => e[0] === "reply").length, count);
    assert.equal(f.events.filter((e) => e[0] === "result").length, 0);
    assert.equal(f.runtime.client, null);
  } finally {
    f.runtime.stop();
  }
});
