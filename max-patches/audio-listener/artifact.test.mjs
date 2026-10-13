/* global process, structuredClone, URL */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { runInNewContext } from "node:vm";
import {
  build,
  checkArtifact,
  checkSource,
  validateDocument,
  ALL_RESOURCES,
  SOURCE_DIRECTORY,
} from "../../scripts/audio-listener-device.mjs";
import { sourceDocuments } from "./native-source.mjs";
import { decodeAmxd } from "../../scripts/max-device-publisher.mjs";

test("Max module-loaded entry starts the adapter and owns signal cleanup without require.main", async () => {
  const code = await readFile(
    join(SOURCE_DIRECTORY, "audio_listener_max.js"),
    "utf8",
  );
  const calls = [],
    signals = {};
  const maxApi = { outlet: (message) => calls.push(message) };
  runInNewContext(code, {
    require(name) {
      if (name === "max-api") return maxApi;
      assert.equal(name, "./audio_listener_runtime.js");
      return {
        createRuntime(options) {
          assert.equal(options.maxApi, maxApi);
          calls.push("start");
          return {
            stop() {
              calls.push("stop");
            },
          };
        },
      };
    },
    process: {
      once(name, handler) {
        signals[name] = handler;
      },
      exit(code) {
        calls.push(`exit:${code}`);
      },
    },
  });
  assert.deepEqual(calls, ["start", "adapter-started"]);
  assert.deepEqual(Object.keys(signals), ["SIGTERM", "SIGINT"]);
  signals.SIGTERM();
  assert.deepEqual(calls, ["start", "adapter-started", "stop", "exit:0"]);
  signals.SIGINT();
  assert.deepEqual(calls.slice(-2), ["stop", "exit:0"]);
});
test("Max startup failure never emits an adapter-started acknowledgement", async () => {
  const code = await readFile(
    join(SOURCE_DIRECTORY, "audio_listener_max.js"),
    "utf8",
  );
  const output = [];
  assert.throws(
    () =>
      runInNewContext(code, {
        require(name) {
          if (name === "max-api")
            return { outlet: (message) => output.push(message) };
          return {
            createRuntime() {
              throw new Error("missing_companion");
            },
          };
        },
      }),
    /missing_companion/,
  );
  assert.deepEqual(output, []);
});

test("authored native metadata latch retains early values without making getstate a preview query", () => {
  const p = sourceDocuments()["Audio-Listener.maxpat"].patcher;
  const latch = p.boxes.find(({ box }) => box.id === "ml_device_preview_latch");
  assert.equal(latch?.box.text, "int -1");
  assert.equal(
    p.boxes.find(({ box }) => box.id === "ml_adapter_init").box.text,
    "trigger b b b",
  );
  for (const [source, outlet, destination, inlet] of [
    ["init", 2, "ml_device_preview_latch", 1],
    ["ml_adapter_init", 2, "ml_device_state_query", 0],
    ["ml_adapter_init", 1, "ml_device_preview_latch", 0],
    ["ml_device_preview_latch", 0, "ml_device_preview", 0],
  ]) {
    assert.ok(
      p.lines.some(
        ({ patchline: l }) =>
          l.source[0] === source &&
          l.source[1] === outlet &&
          l.destination[0] === destination &&
          l.destination[1] === inlet,
      ),
    );
  }
  assert.ok(
    !p.lines.some(
      ({ patchline: l }) =>
        l.source[0] === "init" &&
        l.source[1] === 1 &&
        l.destination[0] === "ml_device_preview_latch",
    ),
  );
});

test("source parity, valid native cords, usable coordinates, explicit analysis gating and stereo path", async () => {
  const docs = await checkSource();
  assert.equal(Object.keys(docs).length, 5);
  const p = docs["Audio-Listener.maxpat"].patcher;
  for (const channel of [0, 1])
    assert.ok(
      p.lines.some(
        ({ patchline }) =>
          patchline.source[0] === "input" &&
          patchline.source[1] === channel &&
          patchline.destination[0] === "output" &&
          patchline.destination[1] === channel,
      ),
    );
  for (const [source, outlet, destination] of [
    ["init", 2, "ml_device_preview"],
    ["ml_device_preview", 0, "node"],
    ["ml_adapter_init", 2, "ml_device_state_query"],
    ["ml_device_state_query", 0, "init"],
    ["ml_adapter_init", 0, "init"],
  ]) {
    assert.ok(
      p.lines.some(
        ({ patchline }) =>
          patchline.source[0] === source &&
          patchline.source[1] === outlet &&
          patchline.destination[0] === destination &&
          patchline.destination[1] === 0,
      ),
    );
  }
  assert.equal(
    p.boxes.find(({ box }) => box.id === "ml_device_preview").box.text,
    "prepend device-preview",
  );
  assert.equal(
    p.boxes.find(({ box }) => box.id === "ml_device_state_query").box.text,
    "getstate",
  );
  assert.ok(
    !p.lines.some(
      ({ patchline }) =>
        patchline.source[0] === "nodeMessages" &&
        patchline.source[1] === 0 &&
        patchline.destination[0] === "init",
    ),
  );
  assert.ok(p.boxes.some(({ box }) => box.text === "loadmess mute 0 1"));
  assert.ok(
    p.boxes.some(({ box }) => box.text.includes("audio_listener_guard.js")),
  );
  assert.ok(p.boxes.some(({ box }) => box.text === "qmetro 10 @active 1"));
  assert.ok(
    p.lines.some(
      ({ patchline }) =>
        patchline.source[0] === "nodeMessages" &&
        patchline.source[1] === 0 &&
        patchline.destination[0] === "ml_adapter_init",
    ),
  );
  assert.ok(!JSON.stringify(docs).includes("buffer~")); // no recording/waveform buffer
  const energy =
    docs["audio_listener_spectrum_energy.gendsp"].patcher.boxes[0].box.code;
  assert.ok(energy.includes("in1 * in1 + in2 * in2 + in3 * in3 + in4 * in4"));
  const spectrum = docs["audio_listener_spectrum.maxpat"].patcher;
  assert.ok(spectrum.boxes.some(({ box }) => box.text === "out 1"));
  assert.ok(spectrum.boxes.some(({ box }) => box.text === "out 2"));
  assert.ok(!spectrum.boxes.some(({ box }) => box.text.startsWith("fftout~")));
  assert.ok(
    spectrum.boxes.some(
      ({ box }) =>
        box.text === "gen~ audio_listener_spectrum_energy @nocache 1",
    ),
  );
  assert.ok(
    spectrum.lines.some(
      ({ patchline }) =>
        patchline.source[0] === "centroidSnap" &&
        patchline.destination[0] === "centroid",
    ),
  );
  const analysis = docs["audio_listener_analysis.maxpat"].patcher;
  assert.ok(
    analysis.boxes.some(
      ({ box }) => box.text === "gen~ audio_listener_envelope @nocache 1",
    ),
  );
  assert.ok(
    analysis.lines.some(
      ({ patchline }) =>
        patchline.source[0] === "spectrum" &&
        patchline.destination[0] === "centroidHold",
    ),
  );
  assert.ok(
    p.lines.some(
      ({ patchline }) =>
        patchline.source[0] === "spectralSnapshot" &&
        patchline.destination[0] === "analysis" &&
        patchline.destination[1] === 2,
    ),
  );
  for (const destination of ["centroidHold", "energyHold"]) {
    assert.ok(
      analysis.lines.some(
        ({ patchline }) =>
          patchline.source[0] === "clearHold" &&
          patchline.destination[0] === destination,
      ),
    );
  }
  assert.ok(!spectrum.boxes.some(({ box }) => /^out~/.test(box.text)));
});
test("invalid graph, outlet, coordinate, absolute path and bridge mutations fail static validation", () => {
  for (const mutate of [
    (d) => {
      d.patcher.lines[0].patchline.destination[0] = "nonexistent";
    },
    (d) => {
      d.patcher.lines[0].patchline.source[1] = 4;
    },
    (d) => {
      d.patcher.boxes[0].box.patching_rect[1] = 400;
    },
    (d) => {
      d.patcher.boxes[0].box.text = "js /Users/person/secret.js";
    },
    (d) => {
      d.patcher.boxes[0].box.text = "mcp_bridge";
    },
  ]) {
    const d = structuredClone(sourceDocuments()["Audio-Listener.maxpat"]);
    mutate(d);
    assert.throws(() => validateDocument(d));
  }
});
test("installed-artifact isolation: real Audio Effect container, all resources, shared runtime import", async () => {
  const directory = await mkdtemp(join(SOURCE_DIRECTORY, ".artifact-test-"));
  try {
    const manifest = await build(directory); // temporary staging, NOT a user's User Library installation
    assert.equal(manifest.realLiveValidated, false);
    assert.deepEqual(
      manifest.resources.map((r) => r.name),
      ALL_RESOURCES,
    );
    const raw = await readFile(join(directory, "Audio-Listener.amxd"));
    assert.equal(raw.subarray(8, 12).toString("ascii"), "aaaa");
    const { document } = decodeAmxd(raw);
    validateDocument(document);
    const boot = spawnSync(
      process.execPath,
      [
        "-e",
        `const {createRuntime}=require(${JSON.stringify(join(directory, "audio_listener_runtime.js"))});
       const r=createRuntime({maxApi:{outlet(){},addHandler(){}},interval(){return 1},clear(){}});
       if(r.nativeStatus.timing!=="UNVERIFIED" || r.nativeStatus.readiness!=="BLOCKED")
         throw new Error("portable runtime incorrectly advertises ready");
       r.stop(); console.log("isolated portable runtime loaded");`,
      ],
      { cwd: directory, encoding: "utf8" },
    );
    assert.equal(boot.status, 0, boot.stderr);
    assert.ok(boot.stdout.includes("portable runtime loaded"));
    for (const name of ["Audio-Listener.amxd", ...ALL_RESOURCES]) {
      const path = join(directory, name),
        saved = await readFile(path);
      await rm(path);
      await assert.rejects(
        () => checkArtifact(directory),
        undefined,
        `missing ${name} must fail`,
      );
      await writeFile(path, saved);
    }
    const path = join(directory, "audio_listener_engine.js");
    await writeFile(path, (await readFile(path, "utf8")) + "\n// tampered\n");
    await assert.rejects(() => checkArtifact(directory), /hash mismatch/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("runtime control API uses shared client; uncertified prepare explicitly fails, preserves pass-through", () => {
  const require = createRequire(import.meta.url);
  const { createRuntime } = require("./audio_listener_runtime.js");
  const handlers = {},
    output = [],
    replies = [],
    result = [];
  let options;
  class FakeClient {
    constructor(o) {
      options = o;
    }
    configureProducer() {}
    start() {}
    stop() {}
    sendListenerReply(c, p) {
      replies.push([c, p]);
      return true;
    }
    sendListenerResult(c, p) {
      result.push([c, p]);
      return true;
    }
  }
  const runtime = createRuntime({
    maxApi: {
      addHandler: (name, fn) => {
        handlers[name] = fn;
      },
      outlet: (...args) => output.push(args),
    },
    Client: FakeClient,
    env: {
      ABLETON_AGENT_SIGNAL_INGRESS_DESCRIPTOR:
        "/runner/profile/signal-ingress.json",
      ABLETON_AGENT_SIGNAL_INGRESS_SECRET_PATH:
        "/runner/profile/signal-ingress.secret",
    },
    clock: () => 0,
    interval: () => 1,
    clear: () => {},
  });
  handlers.identity(
    JSON.stringify({
      canonicalPath: "live_set tracks 0 devices 0",
      track: { id: "1", name: "test" },
      device: { id: "2", name: "Audio-Listener" },
    }),
  );
  handlers.dsp(1, 48000, 64);
  handlers.host(0, 4, 10000, 3);
  assert.equal(options.signalKind, "audio");
  assert.equal(options.schemaVersion, "audio-observation/v1");
  assert.ok(options.listener);
  const message = {
    action: "prepare",
    passId: "pass",
    jobId: "job",
    connectionEpoch: "epoch",
    config: {
      source: { mode: "session", startBeat: 4, endBeat: 8 },
      durationMs: 1000,
      maxWindows: 10,
    },
  };
  options.onListenerControl(message);
  assert.equal(replies[0][1].status, "failed");
  assert.equal(replies[0][1].reason, "real_live_timing_validation_required");
  assert.equal(result.length, 0);
  assert.ok(
    output.some((m) => m[0] === "analysis" && m[1] === 0 && m[2] === 1),
  );
  runtime.stop();
});
test("runtime requires explicit profile discovery; no audio legacy default", () => {
  const require = createRequire(import.meta.url);
  const { createRuntime } = require("./audio_listener_runtime.js");
  const handlers = {},
    messages = [];
  const runtime = createRuntime({
    maxApi: {
      addHandler: (name, fn) => {
        handlers[name] = fn;
      },
      outlet: (...args) => messages.push(args),
    },
    env: {},
    clock: () => 0,
    interval: () => 1,
    clear: () => {},
  });
  handlers.identity(
    JSON.stringify({
      canonicalPath: "live_set tracks 0 devices 0",
      track: { id: "1", name: "test" },
      device: { id: "2", name: "Audio-Listener" },
    }),
  );
  handlers.dsp(1, 48000, 64);
  handlers.host(0, 4, 10000, 3);
  assert.equal(runtime.client, null);
  assert.ok(
    messages.some((m) => m[1] === "explicit_profile_discovery_required"),
  );
  for (let poll = 0; poll < 200; poll++) {
    handlers.dsp(1, 48000, 64);
    handlers.host(0, 4, 10000 + poll * 64, 3);
  }
  assert.equal(messages.filter((m) => m[0] === "diagnostic").length, 1);
  assert.equal(messages.filter((m) => m[0] === "analysis").length, 1);
  runtime.stop();
});
test("runtime adapter wire lifecycle with synthetic calibrated host frames (NOT a real-Live gate)", () => {
  const require = createRequire(import.meta.url);
  const { createRuntime } = require("./audio_listener_runtime.js");
  const handlers = {},
    replies = [],
    results = [];
  let options;
  class Client {
    constructor(o) {
      options = o;
    }
    configureProducer() {}
    start() {}
    stop() {}
    sendListenerReply(c, value) {
      replies.push(value);
      return true;
    }
    sendListenerResult(c, value) {
      results.push(value);
      return true;
    }
  }
  const runtime = createRuntime({
    maxApi: {
      addHandler: (name, fn) => {
        handlers[name] = fn;
      },
      outlet() {},
    },
    Client,
    env: {
      ABLETON_AGENT_SIGNAL_INGRESS_DESCRIPTOR: "/test/profile.json",
      ABLETON_AGENT_SIGNAL_INGRESS_SECRET_PATH: "/test/profile.secret",
    },
    clock: () => 0,
    interval: () => 1,
    clear: () => {},
    certificate: {
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
    },
  });
  handlers.identity(
    JSON.stringify({
      canonicalPath: "live_set tracks 0 devices 0",
      track: { id: "1", name: "test" },
      device: { id: "2", name: "Audio-Listener" },
    }),
  );
  handlers.dsp(1, 48000, 64);
  handlers.host(0, 4, 10000, 3);
  handlers["attack-threshold"](9);
  handlers["attack-spacing-ms"](200);
  const control = {
    passId: "pass",
    jobId: "job",
    connectionEpoch: "epoch",
    config: {
      source: { mode: "arrangement", startBeat: 4, endBeat: 4.2 },
      durationMs: 1000,
      maxWindows: 10,
    },
  };
  options.onListenerControl({ ...control, action: "prepare" });
  options.onListenerControl({ ...control, action: "arm" });
  assert.deepEqual(replies, [{ status: "ready" }, { status: "armed" }]);
  handlers.host(1, 4, 10000, 3);
  handlers.host(1, 4.2, 14800, 3);
  handlers.frame(1, 0.5, 0.7, 0.35, 4800, 750, 10);
  assert.equal(results.length, 1);
  assert.equal(results[0].status, "completed");
  assert.equal(results[0].observation.complete, true);
  assert.equal(results[0].observation.algorithm.settings.attackThresholdDb, 9);
  assert.equal(
    results[0].observation.algorithm.settings.minAttackSpacingSamples,
    9600,
  );
  assert.equal(results[0].observation.startSample, 10000);
  assert.equal(results[0].observation.endSample, 14800);
  runtime.stop();
});
test("actual shared client identity API and registration refresh: no invented setIdentity method", () => {
  const require = createRequire(import.meta.url);
  const { createRuntime } = require("./audio_listener_runtime.js");
  const { AgentSignalClient } = require("../shared/agent_signal_client.js");
  const handlers = {},
    created = [];
  class OfflineClient extends AgentSignalClient {
    constructor(options) {
      super(options);
      created.push(this);
    }
    // No sockets or discovery-file reads: only startup registration semantics.
    start() {
      this.started = true;
    }
  }
  const runtime = createRuntime({
    maxApi: {
      addHandler: (name, fn) => {
        handlers[name] = fn;
      },
      outlet() {},
    },
    Client: OfflineClient,
    env: {
      ABLETON_AGENT_SIGNAL_INGRESS_DESCRIPTOR: "/runner/profile.json",
      ABLETON_AGENT_SIGNAL_INGRESS_SECRET_PATH: "/runner/profile.secret",
    },
    clock: () => 0,
    interval: () => 1,
    clear: () => {},
  });
  const identity = {
    canonicalPath: "live_set tracks 0 devices 0",
    track: { id: "1", name: "test" },
    device: { id: "2", name: "Audio-Listener" },
  };
  handlers.identity(JSON.stringify(identity));
  handlers.dsp(1, 48000, 64);
  handlers.host(0, 4, 10000, 3);
  assert.equal(created.length, 1);
  assert.ok(runtime.client.producer);
  assert.equal(runtime.engine.listenerId, runtime.client.producer.producerId);
  handlers.identity(JSON.stringify(identity)); // identical refresh must not reconfigure a started client
  assert.equal(created.length, 1);
  handlers.identity(
    JSON.stringify({
      ...identity,
      canonicalPath: "live_set tracks 0 devices 1",
    }),
  );
  assert.equal(created.length, 2);
  assert.equal(created[0].stopping, true);
  assert.notEqual(
    created[0].producer.producerId,
    created[1].producer.producerId,
  );
  assert.equal(runtime.engine.listenerId, runtime.client.producer.producerId);
  handlers.dsp(1, 44100, 128);
  assert.equal(created.length, 3);
  assert.equal(runtime.client.listener.sampleRate, 44100);
  assert.equal(runtime.engine.host.sampleRate, 44100);
  assert.notEqual(created[1].instanceId, created[2].instanceId);
  runtime.stop();
});
test("audio never reads legacy credentials when only an explicit descriptor is given", () => {
  const require = createRequire(import.meta.url);
  const { createRuntime } = require("./audio_listener_runtime.js");
  const handlers = {};
  const runtime = createRuntime({
    maxApi: {
      addHandler: (name, fn) => {
        handlers[name] = fn;
      },
      outlet() {},
    },
    env: { ABLETON_AGENT_SIGNAL_INGRESS_DESCRIPTOR: "/runner/profile.json" },
    clock: () => 0,
    interval: () => 1,
    clear: () => {},
  });
  handlers.identity(
    JSON.stringify({
      canonicalPath: "live_set tracks 0 devices 0",
      track: { id: "1", name: "test" },
      device: { id: "2", name: "Audio-Listener" },
    }),
  );
  handlers.dsp(1, 48000, 64);
  handlers.host(0, 4, 10000, 3);
  assert.equal(runtime.client, null);
  runtime.stop();
});
test("shipping runtime cannot enable production completion by loading an unverified certificate file", async () => {
  const source = await readFile(
    new URL("./audio_listener_runtime.js", import.meta.url),
    "utf8",
  );
  assert.ok(!source.includes("ABLETON_AGENT_AUDIO_TIMING_CERTIFICATE"));
  assert.ok(source.includes('createRuntime({ maxApi: require("max-api") })'));
});
