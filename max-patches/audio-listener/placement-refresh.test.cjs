/* global __dirname */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { createRuntime } = require("./audio_listener_runtime.js");
const { AgentSignalClient } = require("../shared/agent_signal_client.js");

const source = fs.readFileSync(
  path.join(__dirname, "../shared/producer_identity.js"),
  "utf8",
);

function fixture({ watch = true } = {}) {
  const handlers = {};
  const clients = [];
  const reports = [];
  const pending = new Set();
  const device = {
    id: 29,
    name: "Listener",
    path: "live_set tracks 0 devices 0",
    type: "MaxDevice",
  };
  const track = {
    id: 17,
    name: "Track",
    path: "live_set tracks 0",
    type: "Track",
  };
  class Client extends AgentSignalClient {
    constructor(options) {
      super(options);
      clients.push(this);
    }
    start() {
      this.started = true;
    }
  }
  const runtime = createRuntime({
    maxApi: {
      addHandler: (name, handler) => {
        handlers[name] = handler;
      },
      outlet() {},
    },
    Client,
    env: {
      ABLETON_AGENT_SIGNAL_INGRESS_DESCRIPTOR: "/fixture/profile.json",
      ABLETON_AGENT_SIGNAL_INGRESS_SECRET_PATH: "/fixture/profile.secret",
    },
    interval: () => 1,
    clear() {},
  });
  const context = {
    Array,
    JSON,
    Number,
    String,
    isFinite,
    jsarguments: watch
      ? ["producer_identity_common.js", "watch"]
      : ["identity.js"],
    LiveAPI: function (apiPath) {
      const object = apiPath === "live_set this_device" ? device : track;
      return {
        get id() {
          return object.id;
        },
        get unquotedpath() {
          return object.path;
        },
        get type() {
          return object.type;
        },
        get() {
          return object.name;
        },
      };
    },
    Task: function (fn, target, ...args) {
      this.cancel = () => pending.delete(this);
      this.schedule = (delay) => {
        assert.ok(delay >= 250);
        pending.add(this);
      };
      this.fire = () => {
        pending.delete(this);
        fn.apply(target, args);
      };
    },
    outlet: (_outlet, name, value) => {
      reports.push([name, value]);
      handlers[name]?.(value);
    },
    post() {},
  };
  vm.runInNewContext(source, context);
  context.bang();
  handlers.dsp(1, 48000, 64);
  handlers.host(0, 0, 10000, 3);
  return {
    context,
    device,
    track,
    clients,
    runtime,
    reports,
    pending,
    tick() {
      const tasks = [...pending];
      assert.ok(
        tasks.length > 0,
        "device identity must refresh after initialization",
      );
      tasks.forEach((task) => task.fire());
    },
    close() {
      context.notifydeleted();
      runtime.stop();
      assert.equal(pending.size, 0);
    },
  };
}

test("insert-before refreshes the actual this_device path and authenticated registration", () => {
  const f = fixture();
  try {
    const first = f.runtime.client;
    assert.equal(
      first.listener.deviceCanonicalPath,
      "live_set tracks 0 devices 0",
    );
    f.device.path = "live_set tracks 0 devices 1";
    f.tick();
    assert.equal(f.runtime.client.listener.deviceCanonicalPath, f.device.path);
    assert.equal(f.runtime.client.producer.device.id, "29");
    assert.equal(first.stopping, true);
    assert.notEqual(f.runtime.client.instanceId, first.instanceId);
    assert.notEqual(
      f.runtime.client.producer.producerId,
      first.producer.producerId,
    );
    const count = f.clients.length;
    f.tick();
    assert.equal(
      f.clients.length,
      count,
      "unchanged placement must not reconnect",
    );
    assert.equal(
      f.reports.length,
      2,
      "unchanged placement must not emit identity",
    );
  } finally {
    f.close();
  }
});

test("reorder and track movement refresh ownership without following the old index", () => {
  const f = fixture();
  try {
    f.device.path = "live_set tracks 0 devices 3";
    f.tick();
    f.track.id = 18;
    f.track.path = "live_set tracks 2";
    f.device.path = "live_set tracks 2 devices 1";
    f.tick();
    assert.equal(
      f.runtime.client.listener.trackCanonicalPath,
      "live_set tracks 2",
    );
    assert.equal(f.runtime.client.listener.deviceCanonicalPath, f.device.path);
    assert.equal(f.runtime.client.producer.device.id, "29");
  } finally {
    f.close();
  }
});

test("unavailable identity invalidates registration once and recovers even at the same path", () => {
  const f = fixture();
  try {
    const first = f.runtime.client;
    f.device.id = 0;
    f.tick();
    assert.equal(f.runtime.client, null);
    assert.equal(first.stopping, true);
    const reports = f.reports.length;
    f.tick();
    assert.equal(f.reports.length, reports);
    f.device.id = 29;
    f.tick();
    assert.notEqual(f.runtime.client.instanceId, first.instanceId);
    assert.equal(f.runtime.client.listener.deviceCanonicalPath, f.device.path);
  } finally {
    f.close();
  }
});

test("adapter restart resends current identity and deletion fences late refresh callbacks", () => {
  const f = fixture();
  try {
    f.context.bang();
    assert.equal(f.reports.length, 2);
    assert.equal(f.pending.size, 1);
    const late = [...f.pending];
    f.context.notifydeleted();
    const count = f.reports.length;
    f.device.path = "live_set tracks 0 devices 1";
    late.forEach((task) => task.fire());
    assert.equal(f.reports.length, count);
    assert.equal(f.pending.size, 0);
  } finally {
    f.close();
  }
});

test("legacy MIDI identity remains a one-shot report", () => {
  const f = fixture({ watch: false });
  try {
    assert.equal(f.pending.size, 0);
    f.context.bang();
    assert.equal(f.reports.length, 2);
  } finally {
    f.close();
  }
});
