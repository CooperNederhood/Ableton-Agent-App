const test = require("node:test");
const assert = require("node:assert/strict");
const { createRuntime } = require("./audio_listener_runtime.js");
const { VERSION } = require("./audio_listener_engine.js");

const SYNTHETIC_CERTIFICATE = {
  validated: true,
  algorithmVersion: VERSION,
  hostVersion: "test-double",
  maxVersion: "test-double",
  launchAligned: true,
  requiredHostFlags: 19,
  uncertaintySamples: 64,
  descriptorOffsetSamples: 0,
  sampleRate: 48000,
  vectorSize: 64,
};
const IDENTITY = {
  canonicalPath: "live_set tracks 0 devices 0",
  track: { id: "1", name: "fixture" },
  device: { id: "2", name: "Audio-Listener" },
};
const OWNER = {
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

function fixture({
  certificate = null,
  env = {
    ABLETON_AGENT_SIGNAL_INGRESS_DESCRIPTOR: "/fixture/descriptor.json",
    ABLETON_AGENT_SIGNAL_INGRESS_SECRET_PATH: "/fixture/credential.json",
  },
} = {}) {
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
    env,
    interval: (fn) => {
      timers.push(fn);
      return fn;
    },
    clear: (fn) => events.push(["clear", fn]),
    clock: () => 0,
    certificate,
  });
  const poll = () => {
    handlers.identity(JSON.stringify(IDENTITY));
    handlers.dsp(1, 48000, 64);
    handlers.host(0, 4, 10000, 19);
    timers[0]();
  };
  return { runtime, handlers, clients, output, events, timers, poll };
}

test("hosted registration does not require an unverified native preview flag", () => {
  const f = fixture();
  try {
    for (let i = 0; i < 200; i++) f.poll();
    assert.equal(f.clients.length, 1);
    assert.equal(f.runtime.client, f.clients[0]);
    assert.equal(f.runtime.nativeStatus.readiness, "BLOCKED");
    assert.deepEqual(
      f.output.filter((v) => v[0] === "diagnostic"),
      [],
    );
  } finally {
    f.runtime.stop();
  }
});

test("zero and one preview reports cannot deny registration or certify production capture", () => {
  for (const flag of [0, 1]) {
    const f = fixture();
    try {
      f.handlers["device-preview"](flag);
      f.poll();
      assert.equal(f.clients.length, 1);
      const client = f.runtime.client;
      assert.equal(client.options.listener.nativeStatus.readiness, "BLOCKED");
      const count = f.output.length;
      for (let i = 0; i < 200; i++) f.handlers["device-preview"](i % 2);
      assert.equal(f.runtime.client, client);
      assert.equal(f.output.length, count);
      assert.equal(f.events.filter((e) => e[0] === "stop").length, 0);
      const prepare = { ...OWNER, action: "prepare" };
      client.options.onListenerControl(prepare);
      const reply = f.events.filter((e) => e[0] === "reply").at(-1);
      assert.deepEqual(reply[1], prepare);
      assert.equal(reply[2].status, "failed");
      assert.equal(reply[2].reason, "real_live_timing_validation_required");
      assert.equal(f.events.filter((e) => e[0] === "result").length, 0);
    } finally {
      f.runtime.stop();
    }
  }
});

test("malformed preview metadata is diagnosed once without disconnect, reset or raw-value logging", () => {
  const f = fixture();
  try {
    f.poll();
    const client = f.runtime.client;
    const count = f.output.filter((v) => v[0] === "analysis").length;
    for (const value of [undefined, null, false, true, "0", "1", 2, -1, NaN]) {
      f.handlers["device-preview"](value);
      f.poll();
    }
    assert.equal(f.runtime.client, client);
    assert.equal(f.clients.length, 1);
    assert.equal(f.output.filter((v) => v[0] === "analysis").length, count);
    assert.deepEqual(
      f.output.filter((v) => v[0] === "diagnostic"),
      [["diagnostic", "invalid_device_preview_state_ignored"]],
    );
    f.handlers["device-preview"](1);
    f.handlers["device-preview"](undefined);
    assert.equal(f.output.filter((v) => v[0] === "diagnostic").length, 2);
  } finally {
    f.runtime.stop();
  }
});

test("identity replacement still releases registration, fences callbacks and creates a fresh instance", () => {
  const f = fixture();
  try {
    f.poll();
    const old = f.runtime.client;
    f.handlers.identity(
      JSON.stringify({ ...IDENTITY, device: { id: "3", name: "replacement" } }),
    );
    assert.equal(f.clients.length, 2);
    assert.notEqual(f.runtime.client.instanceId, old.instanceId);
    assert.deepEqual(
      f.events.filter((e) => e[0] === "stop"),
      [["stop", old]],
    );
    const count = f.output.length;
    old.options.onStatus("live", "connected");
    old.options.onListenerFailure("late_failure");
    old.options.onListenerControl({ ...OWNER, action: "prepare" });
    assert.equal(f.output.length, count);
    assert.equal(f.events.filter((e) => e[0] === "reply").length, 0);
    assert.equal(f.runtime.nativeStatus.readiness, "BLOCKED");
  } finally {
    f.runtime.stop();
  }
});

test("connection epoch replacement still refreshes registration and fences old controls", () => {
  const f = fixture();
  try {
    f.poll();
    const old = f.runtime.client;
    old.listener = { connectionEpoch: "first" };
    assert.equal(f.runtime.refreshRegistration(), false);
    old.listener.connectionEpoch = "replacement";
    assert.equal(f.runtime.refreshRegistration(), true);
    assert.equal(f.clients.length, 2);
    assert.notEqual(f.runtime.client.instanceId, old.instanceId);
    old.options.onListenerControl({ ...OWNER, action: "prepare" });
    assert.equal(f.events.filter((e) => e[0] === "reply").length, 0);
  } finally {
    f.runtime.stop();
  }
});

test("preview metadata does not terminate synthetic capture; actual identity loss retains partial attribution", () => {
  const f = fixture({ certificate: SYNTHETIC_CERTIFICATE });
  try {
    f.poll();
    const client = f.runtime.client;
    client.options.onListenerControl({ ...OWNER, action: "prepare" });
    client.options.onListenerControl({ ...OWNER, action: "arm" });
    f.handlers.host(1, 4, 10000, 19);
    assert.equal(f.runtime.engine.state, "capturing");
    f.handlers["device-preview"](1);
    f.handlers["device-preview"](undefined);
    assert.equal(f.runtime.engine.state, "capturing");
    assert.equal(f.events.filter((e) => e[0] === "result").length, 0);
    f.handlers.identity("invalid");
    const terminal = f.events.findIndex((e) => e[0] === "result");
    const stop = f.events.findIndex((e) => e[0] === "stop");
    assert.ok(terminal >= 0 && stop > terminal);
    assert.deepEqual(f.events[terminal][1], { ...OWNER, action: "arm" });
    assert.equal(f.events[terminal][2].status, "partial");
    assert.equal(f.events[terminal][2].reason, "invalid_canonical_device_path");
    assert.equal(f.events[terminal][2].observation.complete, false);
    assert.equal(f.events.filter((e) => e[0] === "result").length, 1);
    assert.ok(
      f.output.every((v) => !["transport", "play", "stop"].includes(v[0])),
    );
  } finally {
    f.runtime.stop();
  }
});

test("ignoring preview metadata cannot bypass DSP or identity prerequisites", () => {
  const f = fixture();
  try {
    f.handlers["device-preview"](1);
    f.handlers.dsp(1, 48000, 64);
    f.handlers.host(0, 4, 10000, 19);
    assert.equal(f.clients.length, 0);
    f.handlers.dsp(0, 48000, 64);
    f.handlers.identity(JSON.stringify(IDENTITY));
    assert.equal(f.clients.length, 0);
    f.handlers.dsp(1, 48000, 64);
    assert.equal(f.clients.length, 1);
  } finally {
    f.runtime.stop();
  }
});

test("preview metadata cannot bypass explicit profile discovery; failure stays bounded", () => {
  const f = fixture({
    env: {
      ABLETON_AGENT_SIGNAL_INGRESS_DESCRIPTOR: "relative.json",
      ABLETON_AGENT_SIGNAL_INGRESS_SECRET_PATH: "/fixture/credential.json",
    },
  });
  try {
    f.handlers["device-preview"](1);
    for (let i = 0; i < 200; i++) f.poll();
    assert.equal(f.clients.length, 0);
    assert.deepEqual(
      f.output.filter((v) => v[0] === "diagnostic"),
      [["diagnostic", "explicit_profile_discovery_required"]],
    );
  } finally {
    f.runtime.stop();
  }
});

test("cancelled synthetic pass stays cancelled and stopped runtime cannot restart from later metadata", () => {
  const f = fixture({ certificate: SYNTHETIC_CERTIFICATE });
  try {
    f.poll();
    const client = f.runtime.client;
    client.options.onListenerControl({ ...OWNER, action: "prepare" });
    const cancel = { ...OWNER, action: "cancel" };
    client.options.onListenerControl(cancel);
    assert.deepEqual(f.events.filter((e) => e[0] === "reply").at(-1), [
      "reply",
      cancel,
      { status: "cancelled" },
    ]);
    f.runtime.stop();
    const count = f.events.filter((e) => e[0] === "reply").length;
    f.handlers["device-preview"](1);
    f.handlers["device-preview"](undefined);
    f.poll();
    client.options.onListenerControl({ ...OWNER, action: "arm" });
    assert.equal(f.clients.length, 1);
    assert.equal(f.events.filter((e) => e[0] === "reply").length, count);
    assert.equal(f.events.filter((e) => e[0] === "result").length, 0);
    assert.equal(f.events.filter((e) => e[0] === "clear").length, 1);
  } finally {
    f.runtime.stop();
  }
});
