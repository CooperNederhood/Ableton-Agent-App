/* global setImmediate */
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { readFile } = require("node:fs/promises");
const vm = require("node:vm");
const runtimeModule = require("./audio_listener_runtime.js");
const { AgentSignalClient } = require("../shared/agent_signal_client.js");

const BLOCKED = {
  version: 1,
  timing: "UNVERIFIED",
  readiness: "BLOCKED",
  reason: "real_live_timing_validation_required",
};
function fixture(path = "live_set tracks 0 devices 1") {
  const handlers = {},
    created = [],
    outputs = [],
    ticks = [];
  class OfflineClient extends AgentSignalClient {
    constructor(options) {
      super(options);
      this.options = options;
      created.push(this);
    }
    configureProducer(identity) {
      assert.equal(
        this.started,
        false,
        "identity must be configured before startup",
      );
      return super.configureProducer(identity);
    }
    start() {
      assert.ok(this.producer);
      this.started = true;
    }
  }
  const runtime = runtimeModule.createRuntime({
    maxApi: {
      addHandler: (name, fn) => {
        handlers[name] = fn;
      },
      outlet: (...args) => outputs.push(args),
    },
    Client: OfflineClient,
    clock: () => 0,
    env: {
      ABLETON_AGENT_SIGNAL_INGRESS_DESCRIPTOR:
        "/fixture/profile/descriptor.json",
      ABLETON_AGENT_SIGNAL_INGRESS_SECRET_PATH:
        "/fixture/profile/credential.json",
    },
    interval: (fn) => {
      ticks.push(fn);
      return 1;
    },
    clear: () => {},
  });
  const identity = (canonicalPath = path, changes = {}) =>
    handlers.identity(
      JSON.stringify({
        canonicalPath,
        track: { id: "101", name: "name is not path evidence" },
        device: { id: "202", name: "UUID is not path evidence" },
        ...changes,
      }),
    );
  identity();
  handlers.dsp(1, 48000, 64);
  handlers.host(0, 4, 10000, 3);
  return { runtime, identity, handlers, created, outputs, ticks };
}

test("top-level path parser preserves actual device evidence and extracts only its canonical parent", () => {
  assert.equal(typeof runtimeModule.canonicalPaths, "function");
  for (const [path, track] of [
    ["live_set tracks 0 devices 1", "live_set tracks 0"],
    ["live_set tracks 123 devices 456", "live_set tracks 123"],
    ["live_set return_tracks 2 devices 3", "live_set return_tracks 2"],
    ["live_set master_track devices 0", "live_set master_track"],
  ]) {
    assert.deepEqual(runtimeModule.canonicalPaths(path), {
      deviceCanonicalPath: path,
      trackCanonicalPath: track,
    });
  }
  for (const path of [
    undefined,
    null,
    1,
    "",
    " live_set tracks 0 devices 1",
    "live_set tracks 0 devices 1 ",
    "live_set tracks 0 devices 1\n",
    "live_set tracks -1 devices 0",
    "live_set tracks 01 devices 0",
    "live_set tracks 0 devices 0 chains 1 devices 2",
    "live_set tracks 0 devices 0 parameters 1",
    "live_set this_device",
    "id 202",
    "track named Kick",
    "live_set master_track devices 0 extra",
    "live_set tracks 9007199254740992 devices 0",
    "x".repeat(257),
  ])
    assert.throws(
      () => runtimeModule.canonicalPaths(path),
      /invalid_canonical_device_path/,
    );
});
test("actual shared registration reports ordinary/return/master paths and blocked production readiness", () => {
  for (const path of [
    "live_set tracks 0 devices 1",
    "live_set return_tracks 2 devices 3",
    "live_set master_track devices 0",
  ]) {
    const f = fixture(path);
    try {
      assert.equal(f.created.length, 1);
      assert.equal(f.runtime.client.listener.deviceCanonicalPath, path);
      assert.equal(
        f.runtime.client.listener.trackCanonicalPath,
        path.replace(/ devices \d+$/, ""),
      );
      assert.deepEqual(f.runtime.client.listener.nativeStatus, BLOCKED);
      assert.deepEqual(f.runtime.nativeStatus, BLOCKED);
      assert.equal(Object.isFrozen(f.runtime.nativeStatus), true);
      assert.deepEqual(f.runtime.client.listener.capabilities, [
        "audio-listener/v1",
      ]);
      assert.equal(
        f.runtime.engine.listenerId,
        f.runtime.client.producer.producerId,
      );
      // A connection acknowledgement is not native readiness.
      f.runtime.client.listener.connectionEpoch = "first-observed-epoch";
      f.runtime.client.options.onStatus("live", "connected", "connection");
      assert.deepEqual(f.runtime.nativeStatus, BLOCKED);
      assert.equal(f.runtime.engine.state, "idle");
      assert.throws(
        () =>
          f.runtime.engine.prepare({
            passId: "pass",
            connectionEpoch: "first-observed-epoch",
            startBeat: 4,
            endBeat: 8,
          }),
        /real_live_timing_validation_required/,
      );
    } finally {
      f.runtime.stop();
    }
  }
});
test("published paths consume the actual shared identity output, not names, numeric IDs or hashes", async () => {
  const source = await readFile(
    require.resolve("../shared/producer_identity.js"),
    "utf8",
  );
  for (const [devicePath, trackPath] of [
    ["live_set tracks 3 devices 5", "live_set tracks 3"],
    ["live_set return_tracks 4 devices 6", "live_set return_tracks 4"],
    ["live_set master_track devices 7", "live_set master_track"],
  ]) {
    const context = vm.createContext({
      LiveAPI: function (path) {
        const device = path === "live_set this_device";
        this.id = device ? 202 : 101;
        this.type = device ? "Device" : "Track";
        this.unquotedpath = device ? devicePath : trackPath;
        this.get = () => ["names", "are", "not", "paths"];
      },
      outlet() {},
      post() {},
      Task: function () {},
    });
    vm.runInContext(source, context);
    const reported = context.buildIdentity();
    assert.equal(reported.canonicalPath, devicePath);
    assert.equal(
      reported.track.canonicalPath,
      undefined,
      "do not claim an independently published track field",
    );
    const f = fixture(devicePath);
    try {
      f.handlers.identity(JSON.stringify(reported));
      assert.equal(
        f.runtime.client.listener.deviceCanonicalPath,
        reported.canonicalPath,
      );
      assert.equal(f.runtime.client.listener.trackCanonicalPath, trackPath);
      assert.deepEqual(f.runtime.nativeStatus, BLOCKED);
    } finally {
      f.runtime.stop();
    }
  }
});
test("invalid identity updates disarm and remove the old registration instead of retaining stale paths", () => {
  const f = fixture();
  try {
    const old = f.runtime.client;
    f.identity("live_set tracks 0 devices 1 chains 0 devices 0");
    assert.equal(old.stopping, true);
    assert.equal(f.runtime.client, null);
    assert.ok(
      f.outputs.some(
        (v) =>
          v[0] === "diagnostic" && v[1] === "invalid_canonical_device_path",
      ),
    );
    f.handlers.host(0, 4, 10000, 3);
    assert.equal(f.created.length, 1);
    f.identity("live_set return_tracks 0 devices 1");
    assert.equal(f.created.length, 2);
    assert.equal(
      f.runtime.client.listener.trackCanonicalPath,
      "live_set return_tracks 0",
    );
  } finally {
    f.runtime.stop();
  }
});
test("path, actual client instance and connection epoch changes recreate configure-before-start registrations", () => {
  const f = fixture();
  try {
    const old = f.runtime.client;
    old.listener.connectionEpoch = "observed-epoch-1";
    old.options.onStatus("live", "connected", "connection-1");
    assert.equal(
      f.created.length,
      1,
      "first epoch must not cause a reconnect loop",
    );
    old.listener.connectionEpoch = "observed-epoch-2";
    f.ticks[0]();
    assert.equal(f.created.length, 2);
    assert.equal(old.stopping, true);
    assert.notEqual(f.runtime.client.instanceId, old.instanceId);
    const second = f.runtime.client;
    second.instanceId = "changed-live-producer-instance";
    f.ticks[0]();
    assert.equal(f.created.length, 3);
    assert.equal(second.stopping, true);
    f.identity("live_set tracks 1 devices 2");
    assert.equal(f.created.length, 4);
    assert.equal(
      f.runtime.client.listener.deviceCanonicalPath,
      "live_set tracks 1 devices 2",
    );
    const latest = f.runtime.client;
    // Old callbacks are fenced from the replacement registration.
    old.options.onStatus("live", "connected", "stale-connection");
    old.options.onListenerFailure("stale-failure", null);
    old.options.onListenerControl({ action: "prepare", passId: "stale" });
    assert.equal(f.runtime.client, latest);
    assert.equal(f.created.length, 4);
    assert.deepEqual(f.runtime.nativeStatus, BLOCKED);
  } finally {
    f.runtime.stop();
  }
});
test("actual shared hello serialization and reconnect retain path/status capabilities without a ready claim", async () => {
  const sockets = [],
    frames = [],
    clients = [],
    reconnect = [],
    handlers = {};
  class Socket extends EventEmitter {
    constructor() {
      super();
      this.destroyed = false;
    }
    setEncoding() {}
    write(encoded) {
      const frame = JSON.parse(encoded);
      delete frame.secret; // Never include credential material in assertion output.
      frames.push(frame);
      return true;
    }
    destroy() {
      if (!this.destroyed) {
        this.destroyed = true;
        this.emit("close");
      }
    }
    end() {
      this.destroy();
    }
  }
  class LocalClient extends AgentSignalClient {
    constructor(options) {
      super({
        ...options,
        secret: "synthetic-test-only-credential".repeat(2),
        readText: async () =>
          JSON.stringify({
            host: "127.0.0.1",
            port: 1,
            protocol: "newline-delimited-json",
            protocolVersion: 1,
            maxFrameBytes: 131072,
            listenerVersions: [1],
            listenerCapabilities: ["audio-listener/v1"],
          }),
        createConnection: () => {
          const socket = new Socket();
          sockets.push(socket);
          return socket;
        },
        setTimeout: (fn) => {
          reconnect.push(fn);
          return fn;
        },
        clearTimeout() {},
        setInterval: () => 1,
        clearInterval() {},
      });
      clients.push(this);
    }
    configureProducer(identity) {
      assert.equal(this.started, false);
      return super.configureProducer(identity);
    }
  }
  const runtime = runtimeModule.createRuntime({
    maxApi: {
      addHandler: (name, fn) => {
        handlers[name] = fn;
      },
      outlet() {},
    },
    Client: LocalClient,
    clock: () => 0,
    interval: () => 1,
    clear() {},
    env: {
      ABLETON_AGENT_SIGNAL_INGRESS_DESCRIPTOR: "/fixture/descriptor.json",
      ABLETON_AGENT_SIGNAL_INGRESS_SECRET_PATH: "/fixture/credential.json",
    },
  });
  const settled = () => new Promise((resolve) => setImmediate(resolve));
  try {
    handlers.identity(
      JSON.stringify({
        canonicalPath: "live_set master_track devices 2",
        track: { id: "101", name: "fixture" },
        device: { id: "202", name: "fixture" },
      }),
    );
    handlers.dsp(1, 48000, 64);
    handlers.host(0, 4, 10000, 3);
    await settled();
    assert.equal(sockets.length, 1);
    sockets[0].emit("connect");
    const first = frames.find((frame) => frame.type === "producer.hello");
    assert.ok(first);
    assert.equal(
      first.listener.deviceCanonicalPath,
      "live_set master_track devices 2",
    );
    assert.equal(first.listener.trackCanonicalPath, "live_set master_track");
    assert.deepEqual(first.listener.nativeStatus, BLOCKED);
    assert.equal(
      clients.length,
      1,
      "initial connection must not trigger a replacement loop",
    );
    sockets[0].destroy();
    assert.equal(reconnect.length, 1);
    reconnect.shift()();
    await settled();
    sockets[1].emit("connect");
    await settled();
    assert.equal(
      clients.length,
      2,
      "changed epoch recreates a configure-before-start registration",
    );
    assert.equal(sockets.length, 3);
    sockets[2].emit("connect");
    const hellos = frames.filter((frame) => frame.type === "producer.hello");
    assert.equal(hellos.length, 2);
    assert.notEqual(
      hellos[0].producer.instanceId,
      hellos[1].producer.instanceId,
    );
    assert.notEqual(
      hellos[0].listener.connectionEpoch,
      hellos[1].listener.connectionEpoch,
    );
    assert.equal(hellos[0].producer.producerId, hellos[1].producer.producerId);
    assert.equal(
      hellos[1].listener.deviceCanonicalPath,
      hellos[0].listener.deviceCanonicalPath,
    );
    assert.deepEqual(hellos[1].listener.nativeStatus, BLOCKED);
    assert.deepEqual(runtime.nativeStatus, BLOCKED);
    assert.equal(runtime.engine.state, "idle");
  } finally {
    runtime.stop();
  }
});
