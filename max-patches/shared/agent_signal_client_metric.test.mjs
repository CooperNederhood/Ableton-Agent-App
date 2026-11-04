/* global Buffer, clearTimeout, process, setTimeout, structuredClone, URL */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { Writable } from "node:stream";
import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { build } from "esbuild";
import { compileNativeMetricProtocol } from "../../scripts/lib/native-metric-protocol-bundle.mjs";

const require = createRequire(import.meta.url);
const SECRET = "synthetic-metric-sdk-secret-not-a-user-credential";
let directory, AgentSignalClient, codec, createFixture, bindFixture;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "metric-signal-sdk-"));
  await writeFile(join(directory, "package.json"), '{"type":"commonjs"}');
  await copyFile(
    new URL("./agent_signal_client.js", import.meta.url),
    join(directory, "agent_signal_client.js")
  );
  const compiled = await compileNativeMetricProtocol({
    stage: (_name, execute) => execute()
  });
  await writeFile(join(directory, compiled.fileName), compiled.source);
  const fixture = await build({
    entryPoints: [
      resolve("packages/signal-routing/src/listener-metric-test-support.ts")
    ],
    alias: {
      "@ableton-agent/protocol/testing": resolve(
        "packages/protocol/src/testing.ts"
      ),
      "@ableton-agent/protocol": resolve("packages/protocol/src/index.ts")
    },
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "es2020",
    write: false
  });
  await writeFile(
    join(directory, "synthetic-fixture.js"),
    fixture.outputFiles[0].text
  );
  ({ AgentSignalClient } = require(join(directory, "agent_signal_client.js")));
  codec = require(join(directory, compiled.fileName));
  const helpers = require(join(directory, "synthetic-fixture.js"));
  createFixture = helpers.createSyntheticMetricWireFixture;
  bindFixture = helpers.bindMetricFixtureToControl;
});
after(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

function setup(mode = "arrangement", partial = false, options = {}) {
  const { fixtureGeometry = false, ...clientOptions } = options;
  const raw = createFixture(mode, partial, fixtureGeometry);
  const registration = structuredClone(raw.registration);
  registration.nativeStatus = {
    ...registration.nativeStatus,
    readiness: "BLOCKED",
    reason: "fresh_per_pass_native_validation_required"
  };
  delete registration.nativeStatus.executedGen;
  const writes = [],
    failures = [],
    admitted = [],
    statuses = [];
  const client = new AgentSignalClient({
    env: {},
    signalKind: "audio",
    schemaVersion: "metric-audio-observation/v1",
    listener: registration,
    secret: SECRET,
    onStatus: (...items) => statuses.push(items),
    onListenerFailure: (reason, job, diagnostic) =>
      failures.push({ reason, job, diagnostic }),
    onListenerControl: (control) => admitted.push(control),
    ...clientOptions
  });
  client.configureProducer({
    canonicalPath: "live_set tracks 0 devices 0",
    track: { id: "1", name: "Synthetic track" },
    device: { id: "2", name: "Synthetic listener" }
  });
  client.authenticated = true;
  client.connectionId = raw.wire.connectionId;
  client.socket = {
    destroyed: false,
    write(encoded) {
      writes.push(JSON.parse(encoded));
      return true;
    },
    destroy() {
      this.destroyed = true;
    }
  };
  let sequence = 0;
  const control = (action = "prepare", patch = {}) => ({
    ...raw.wire,
    listenerId: client.producer.producerId,
    requestId: `metric-control-${sequence}`,
    sequence: sequence++,
    type: "listener.control",
    action,
    ...(action === "prepare" ? { config: structuredClone(raw.config) } : {}),
    ...patch
  });
  const prepare = control();
  const native = bindFixture(raw, prepare);
  return {
    client,
    native,
    prepare,
    control,
    writes,
    failures,
    admitted,
    statuses
  };
}

test("matched SDK negotiates 2 MiB and delivers thirty-second complete/partial observations without reduction", () => {
  for (const { partial, fixtureGeometry, nearCeiling } of [
    { partial: false, fixtureGeometry: { tempoBpm: 128, endBeat: 64 } },
    { partial: true, fixtureGeometry: { tempoBpm: 128, endBeat: 64 } },
    {
      partial: true,
      fixtureGeometry: { tempoBpm: 999, endBeat: 499.5 },
      nearCeiling: true
    }
  ]) {
    const f = setup("session", partial, {
      fixtureGeometry
    });
    if (nearCeiling) {
      const observation = f.native.observation;
      for (const metric of observation.requestedMetrics) {
        const acquisition = observation.metrics[metric];
        const retained = metric === "level" ? 1 : 0;
        const source = createFixture("session", false, fixtureGeometry)
          .observation.metrics[metric];
        acquisition.gaps = source.records.slice(retained).map((record) => ({
          firstIndex: record.index,
          count: 1,
          ...record.support,
          reason: "unavailable",
          detail: "\u754c".repeat(114)
        }));
        acquisition.records = source.records.slice(0, retained);
        acquisition.status = retained ? "partial" : "failed";
      }
      observation.rows = codec.createMetricObservationReportRows(observation);
    }
    f.client.descriptor = {
      maxFrameBytes: codec.MAX_METRIC_RESULT_FRAME_BYTES
    };
    assert.equal(f.client.maxFrameBytes(), 2 * 1024 * 1024);
    f.client.handleListenerControl(f.prepare);
    assert.equal(
      f.client.sendListenerReply(f.prepare, {
        status: "ready",
        nativeReady: f.native.ready
      }),
      true
    );
    const arm = f.control("arm");
    f.client.handleListenerControl(arm);
    assert.equal(
      f.client.sendListenerReply(arm, {
        status: "armed",
        nativeArm: f.native.proof.armed
      }),
      true
    );
    assert.equal(
      f.client.sendListenerResult(f.prepare, {
        status: "progress",
        nativeLaunch: f.native.proof.launched
      }),
      true
    );
    assert.equal(
      f.client.sendListenerResult(f.prepare, {
        status: partial ? "partial" : "completed",
        observation: f.native.observation,
        nativeSourceCoverage: f.native.proof
      }),
      true
    );
    const terminal = f.writes.at(-1);
    assert(Buffer.byteLength(JSON.stringify(terminal)) > 128 * 1024);
    assert.deepEqual(terminal.observation, f.native.observation);
    assert.equal(
      terminal.observation.rows.length,
      f.native.observation.geometry.rows.length
    );
    if (nearCeiling)
      assert(
        Buffer.byteLength(JSON.stringify(terminal)) >
          codec.MAX_METRIC_RESULT_FRAME_BYTES - 16_384
      );
    assert.equal(terminal.traceId, f.prepare.traceId);
    assert.equal(f.failures.length, 0);
    f.client.descriptor.maxFrameBytes = 128 * 1024;
    assert.equal(f.client.maxFrameBytes(), 128 * 1024);
  }
});

test("wire5 constructor accepts canonical cold BLOCKED registration without arming", () => {
  const f = setup();
  assert.equal(f.client.listener.version, 5);
  assert.equal(f.client.listener.nativeStatus.executedGen, undefined);
  assert(Object.isFrozen(f.client.listener.nativeStatus.acceptedVectorSizes));
  f.client.handleListenerControl(f.prepare);
  assert.equal(f.admitted.length, 1);
  assert(Object.isFrozen(f.admitted[0].config.geometry.rows[0]));
  assert(Object.isFrozen(f.admitted[0].config.attacks));
  assert.equal(f.writes.length, 0);
});

function admitReady(f) {
  f.client.handleListenerControl(f.prepare);
  assert.equal(
    f.client.sendListenerReply(f.prepare, {
      status: "ready",
      nativeReady: f.native.ready
    }),
    true
  );
}
function admitArm(f) {
  admitReady(f);
  const arm = f.control("arm");
  f.client.handleListenerControl(arm);
  assert.equal(
    f.client.sendListenerReply(arm, {
      status: "armed",
      nativeArm: f.native.proof.armed
    }),
    true
  );
  return arm;
}
function launch(f) {
  assert.equal(
    f.client.sendListenerResult(f.prepare, {
      status: "progress",
      nativeLaunch: f.native.proof.launched
    }),
    true
  );
}
function complete(f) {
  return f.client.sendListenerResult(f.prepare, {
    status:
      f.native.observation.outcome === "complete" ? "completed" : "partial",
    observation: f.native.observation,
    nativeSourceCoverage: f.native.proof
  });
}
function lifecycle(f, patch = {}) {
  return {
    scope: "independent-metric-timelines/v1",
    eventId: f.native.wire.traceId,
    causationId: "synthetic-sdk-stage-parent",
    generation: f.prepare.generation,
    nativeEpoch: f.native.ready.ownership.nativeEpoch,
    stage: "progress",
    phase: "capture",
    elapsedMs: 100,
    frames: 1,
    ...patch
  };
}

test("canonical producer metadata and actual configured identity are validated and deeply frozen", () => {
  for (const patch of [
    { displayName: "x".repeat(257) },
    { instanceId: "x".repeat(1000) }
  ])
    assert.throws(() => setup("arrangement", false, patch));
  assert.throws(() =>
    setup("arrangement", false, {
      producerIdPrefix: "x".repeat(256)
    })
  );
  const f = setup();
  assert(
    codec.listenerMetricProducerSchema.safeParse(f.client.producer).success
  );
  assert(Object.isFrozen(f.client.producer.track));
  assert(Object.isFrozen(f.client.producer.device));
  assert.throws(() => {
    f.client.producer.track.name = "foreign-track";
  });
  assert.equal(f.client.producer.track.name, "Synthetic track");
});

test("ordinary CommonJS SDK/codec require has no workspace dependency or loader", () => {
  const f = setup();
  const result = execFileSync(
    process.execPath,
    [
      "--input-type=commonjs",
      "-e",
      `
    const Module = require("node:module");
    const original = Module._load;
    Module._load = function(name, ...args) {
      if (!name.startsWith("node:") &&
          name !== process.argv[1] &&
          name !== "./audio_listener_metric_protocol.js" &&
          name !== "./agent_signal_storage.js")
        throw new Error("external_dependency:" + name);
      return original.call(this,name,...args);
    };
    const {AgentSignalClient} = require(process.argv[1]);
    const client = new AgentSignalClient({
      signalKind:"audio", schemaVersion:"metric-audio-observation/v1",
      listener:JSON.parse(process.argv[2]), env:{}
    });
    process.stdout.write(String(client.listener.version));
  `,
      join(directory, "agent_signal_client.js"),
      JSON.stringify(f.client.listener)
    ],
    {
      encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" }
    }
  );
  assert.equal(result, "5");
});

test("only metric listening is admitted; removed metadata/control families never fall back", () => {
  for (const version of [1, 2, 3, 4]) {
    assert.throws(
      () =>
        new AgentSignalClient({
          signalKind: "audio",
          schemaVersion: `audio-observation/v${version === 1 ? 1 : 2}`,
          listener: { version, capabilities: [`audio-listener/v${version}`] }
        }),
      /only.*metric.*5/i
    );
    const f = setup();
    f.prepare.listenerVersion = version;
    f.client.handleListenerControl(f.prepare);
    assert.equal(f.admitted.length, 0);
    assert.equal(f.client.socket.destroyed, true);
  }
  for (const schemaVersion of [
    "audio-observation/v1",
    "audio-observation/v2",
    "audio-observation/v3",
    "metric-audio-observation/v1"
  ])
    assert.throws(
      () =>
        new AgentSignalClient({
          signalKind: "audio",
          schemaVersion
        }),
      /requires.*metric.*listener/i
    );
  assert.equal(
    AgentSignalClient.prototype.sendListenerFailureMessage,
    undefined
  );
});

test("wire5 requires the literal same-folder valid companion; nonlisteners never load it", async () => {
  const folder = join(directory, "missing");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(folder);
  const sdk = join(folder, "agent_signal_client.js");
  await copyFile(new URL("./agent_signal_client.js", import.meta.url), sdk);
  const { AgentSignalClient: MissingClient } = require(sdk);
  const listener = setup().client.listener;
  assert.throws(
    () =>
      new MissingClient({
        signalKind: "audio",
        schemaVersion: "metric-audio-observation/v1",
        listener
      }),
    /companion_unavailable/
  );
  assert.doesNotThrow(() => new MissingClient({}));
  assert.throws(
    () =>
      new MissingClient({
        signalKind: "audio",
        schemaVersion: "audio-observation/v1",
        listener: { version: 1, capabilities: ["audio-listener/v1"] }
      }),
    /only.*metric.*5/i
  );
  await writeFile(
    join(folder, "audio_listener_metric_protocol.js"),
    "module.exports={LISTENER_VERSION_METRIC:4};"
  );
  assert.throws(
    () =>
      new MissingClient({
        signalKind: "audio",
        schemaVersion: "metric-audio-observation/v1",
        listener
      }),
    /companion_invalid/
  );
});

test("staged metric SDK authenticates fragmented TCP replies and preserves actual control ownership through disconnect", async () => {
  const messages = [],
    sockets = new Set();
  let resolveDone, rejectDone, client, owner, bound, prepare;
  const done = new Promise((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", rejectDone);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line) continue;
        try {
          const message = JSON.parse(line);
          messages.push(message);
          if (message.type === "producer.hello") {
            codec.listenerMetricProducerSchema.parse(message.producer);
            codec.listenerRegistrationMetricSchema.parse(message.listener);
            owner = {
              ...createFixture("session").wire,
              listenerId: message.producer.producerId,
              connectionEpoch: message.listener.connectionEpoch,
              connectionId: randomUUID(),
              generation: randomUUID(),
              traceId: randomUUID(),
              requestId: "tcp-prepare",
              passId: "tcp-pass",
              jobId: "tcp-job",
              correlationId: "tcp-correlation",
              causationId: "tcp-root-cause"
            };
            const ack = JSON.stringify({
              type: "producer.ack",
              protocolVersion: 1,
              requestId: message.requestId,
              action: "hello",
              connectionId: owner.connectionId,
              listenerCapabilities: [codec.LISTENER_CAPABILITY_METRIC]
            });
            socket.write(ack.slice(0, 17));
            socket.write(
              `${ack.slice(17)}\n${JSON.stringify({
                ...owner,
                type: "listener.control",
                action: "prepare",
                config: createFixture("session").config
              })}\n`
            );
          } else if (message.type === "listener.reply") {
            codec.listenerReplyMetricSchema.parse(message);
            if (message.status === "ready")
              socket.write(
                `${JSON.stringify({
                  ...owner,
                  type: "listener.control",
                  action: "arm",
                  requestId: "tcp-arm",
                  sequence: 1
                })}\n`
              );
          } else if (message.type === "listener.result") {
            codec.listenerResultMetricSchema.parse(message);
            if (message.status === "completed") client.stop();
          } else if (message.type === "producer.disconnect") resolveDone();
        } catch (error) {
          rejectDone(error);
        }
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const descriptor = {
    host: "127.0.0.1",
    port: server.address().port,
    protocol: "newline-delimited-json",
    protocolVersion: 1,
    maxFrameBytes: 128 * 1024,
    listenerVersions: [5],
    listenerCapabilities: [codec.LISTENER_CAPABILITY_METRIC]
  };
  const f = setup("session", false, {
    descriptorPath: "/synthetic/profile/signal-ingress.json",
    readText: async () => JSON.stringify(descriptor)
  });
  client = f.client;
  client.socket = null;
  client.authenticated = false;
  client.connectionId = null;
  client.onListenerControl = (control) => {
    f.admitted.push(control);
    if (control.action === "prepare") {
      prepare = control;
      bound = bindFixture(f.native, control);
      assert.equal(
        client.sendListenerReply(control, {
          status: "ready",
          nativeReady: bound.ready
        }),
        true
      );
    } else {
      assert.equal(control.action, "arm");
      assert.equal(
        client.sendListenerReply(control, {
          status: "armed",
          nativeArm: bound.proof.armed
        }),
        true
      );
      assert.equal(
        client.sendListenerResult(prepare, {
          status: "progress",
          nativeLaunch: bound.proof.launched
        }),
        true
      );
      assert.equal(
        client.sendListenerResult(prepare, {
          status: "completed",
          observation: bound.observation,
          nativeSourceCoverage: bound.proof
        }),
        true
      );
    }
  };
  const timeout = setTimeout(
    () => rejectDone(new Error("metric TCP SDK timeout")),
    3000
  );
  try {
    client.start();
    await done;
    const frames = messages.filter((message) =>
      message.type.startsWith("listener.")
    );
    assert.deepEqual(
      frames.map((message) => message.status),
      ["ready", "armed", "progress", "completed"]
    );
    for (const [sequence, message] of frames.entries()) {
      assert.equal(message.sequence, sequence);
      for (const field of [
        "listenerId",
        "connectionId",
        "connectionEpoch",
        "generation",
        "jobId",
        "passId",
        "traceId",
        "correlationId",
        "causationId"
      ])
        assert.equal(message[field], owner[field]);
    }
    assert.equal(client.metricPhase, null);
    assert.equal(client.metricControls.size, 0);
    assert.deepEqual(f.failures, []);
  } finally {
    clearTimeout(timeout);
    client.stop();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("canonical registration/schema/capability/DSP guards reject mismatches and clone all nested data", () => {
  const base = setup().client.listener;
  for (const patch of [
    { algorithmVersion: "2.0.0" },
    { capabilities: ["audio-listener/v5"] },
    { sampleRate: 96000 },
    { vectorSize: 128 },
    { vectorSize: undefined },
    { connectionEpoch: "old-non-uuid" },
    { nativeStatus: undefined },
    { nativeStatus: { ...base.nativeStatus, readiness: "READY" } },
    {
      nativeStatus: { ...base.nativeStatus, executedGen: createFixture().ready }
    }
  ]) {
    assert.throws(
      () =>
        new AgentSignalClient({
          signalKind: "audio",
          schemaVersion: "metric-audio-observation/v1",
          listener: { ...base, ...patch }
        })
    );
  }
  assert.throws(
    () =>
      new AgentSignalClient({
        signalKind: "audio",
        schemaVersion: "metric-audio-observation/v1"
      })
  );
  assert.throws(
    () =>
      new AgentSignalClient({
        signalKind: "audio",
        schemaVersion: "audio-observation/v2",
        listener: base
      })
  );
  const source = structuredClone(base);
  const f = setup("arrangement", false, { listener: source });
  source.nativeStatus.acceptedVectorSizes[0] = 128;
  assert.equal(f.client.listener.nativeStatus.acceptedVectorSizes[0], 64);
});

for (const mode of ["arrangement", "session"]) {
  for (const partial of [false, true]) {
    test(`exact ${mode} ${partial ? "partial" : "complete"} sequence publishes canonical native evidence`, () => {
      const f = setup(mode, partial);
      admitArm(f);
      launch(f);
      assert.equal(complete(f), true);
      assert.equal(f.client.listenerJob, null);
      assert.equal(f.client.metricPhase, null);
      assert.equal(f.client.metricControls.size, 0);
      assert.equal(f.writes.length, 4);
      f.writes.forEach((value, index) => {
        assert.equal(value.sequence, index);
        assert.equal(value.listenerId, f.prepare.listenerId);
        assert.equal(value.connectionId, f.prepare.connectionId);
        assert.equal(value.generation, f.prepare.generation);
        assert.equal(value.causationId, f.prepare.causationId);
        assert(Buffer.byteLength(JSON.stringify(value)) <= 128 * 1024);
        const identity = Object.fromEntries(
          Object.keys(codec.listenerMetricWireIdentitySchema.shape).map(
            (key) => [key, value[key]]
          )
        );
        assert.deepEqual(
          codec.listenerMetricWireIdentitySchema.parse(identity),
          identity
        );
      });
      assert(codec.listenerResultMetricSchema.safeParse(f.writes[3]).success);
      assert.equal(f.writes[3].observation.geometry.startSample, 200000);
      assert.equal(
        f.writes[3].observation.outcome,
        partial ? "partial" : "complete"
      );
      assert.deepEqual(f.failures, []);
      assert.equal(complete(f), false);
    });
  }
}

for (const mode of ["arrangement", "session"]) {
  test(`canonical ${mode} sourceContext survives immutable admission and binds final observed source`, () => {
    const f = setup(mode);
    const context = structuredClone(f.native.observation.source);
    for (const config of [
      f.prepare.config,
      f.native.ready.config,
      f.native.proof.armed.config
    ])
      config.sourceContext = structuredClone(context);
    admitArm(f);
    const admitted = f.client.listenerJob;
    assert.deepEqual(admitted.config.sourceContext, context);
    assert(Object.isFrozen(admitted.config.sourceContext.target));
    assert(Object.isFrozen(admitted.config.sourceContext.transport));
    if (mode === "session")
      assert(Object.isFrozen(admitted.config.sourceContext.target.track));
    assert.deepEqual(f.writes[0].nativeReady.config.sourceContext, context);
    assert.deepEqual(f.writes[1].nativeArm.config.sourceContext, context);
    launch(f);
    const foreign = structuredClone(f.native.observation);
    if (mode === "arrangement")
      foreign.source.target.expectedReference =
        "11111111-1111-4111-8111-111111111111";
    else foreign.source.kind = "midi";
    assert(codec.metricAudioObservationSchema.safeParse(foreign).success);
    assert.equal(
      f.client.sendListenerResult(f.prepare, {
        status: "completed",
        observation: foreign,
        nativeSourceCoverage: f.native.proof
      }),
      false
    );
    assert.equal(f.client.listenerJob, admitted);
    assert.equal(complete(f), true);
  });
}

test("prepare is deeply cloned/frozen; owner/auth/mode/generation/control-sequence/replay guards never forward", () => {
  const f = setup("session");
  f.client.handleListenerControl(f.prepare);
  const admitted = f.admitted[0];
  f.prepare.config.geometry.rows[0].startSample = -1;
  f.prepare.config.attacks.thresholdDb = 99;
  assert.notEqual(admitted.config.geometry.rows[0].startSample, -1);
  assert.notEqual(admitted.config.attacks.thresholdDb, 99);
  assert(Object.isFrozen(admitted.config.source.target.track));
  for (const mutate of [
    (x) => {
      x.client.authenticated = false;
    },
    (x) => {
      x.client.stopping = true;
    },
    (x) => {
      x.prepare.listenerId = "foreign-listener";
    },
    (x) => {
      x.prepare.connectionId = "11111111-1111-4111-8111-111111111111";
    },
    (x) => {
      x.prepare.connectionEpoch = "11111111-1111-4111-8111-111111111111";
    },
    (x) => {
      x.prepare.mode = "session";
    },
    (x) => {
      x.prepare.config.geometry.sampleRate = 44100;
    },
    (x) => {
      x.prepare.sequence = -1;
    },
    (x) => {
      x.prepare.raw = {};
    }
  ]) {
    const bad = setup();
    mutate(bad);
    bad.client.handleListenerControl(bad.prepare);
    assert.equal(bad.admitted.length, 0);
    assert.equal(bad.client.socket.destroyed, true);
  }
  for (const patch of [
    { generation: "11111111-1111-4111-8111-111111111111" },
    { mode: "session" },
    { causationId: "foreign-root" },
    { passId: "foreign-pass" },
    { traceId: "11111111-1111-4111-8111-111111111111" }
  ]) {
    const owned = setup();
    admitReady(owned);
    const job = owned.client.listenerJob;
    owned.client.handleListenerControl(owned.control("arm", patch));
    assert.equal(owned.admitted.length, 1);
    assert.equal(owned.client.listenerJob, job);
    assert.equal(owned.writes.at(-1).status, "failed");
  }
  const seq = setup();
  admitReady(seq);
  seq.client.handleListenerControl(seq.control("arm", { sequence: 0 }));
  assert.equal(seq.admitted.length, 1);
  assert.equal(seq.client.socket.destroyed, true);
  const replay = setup();
  admitReady(replay);
  replay.client.handleListenerControl(
    replay.control("arm", {
      requestId: replay.prepare.requestId
    })
  );
  assert.equal(replay.admitted.length, 1);
  assert.equal(replay.client.socket.destroyed, true);
});

test("concurrent prepare and arm-before-ready fail explicitly without replacing/releasing the owner", () => {
  const f = setup();
  f.client.handleListenerControl(f.prepare);
  const job = f.client.listenerJob;
  f.client.handleListenerControl(f.control("prepare", { passId: "next-pass" }));
  assert.equal(f.writes.at(-1).reason, "listener_busy");
  assert.equal(f.client.listenerJob, job);
  f.client.handleListenerControl(f.control("arm"));
  assert.equal(f.writes.at(-1).reason, "invalid_metric_phase");
  assert.equal(f.client.listenerJob, job);
  assert.equal(f.admitted.length, 1);
});

test("ready and arm are distinct, and canonical proof config/ownership is bound to the admitted job", () => {
  const f = setup();
  f.client.handleListenerControl(f.prepare);
  assert.equal(
    f.client.sendListenerReply(f.prepare, {
      status: "ready",
      nativeReady: f.native.proof.armed
    }),
    false
  );
  const wrong = structuredClone(f.native.ready);
  wrong.config.attacks.thresholdDb += 1;
  assert(
    codec.listenerReplyMetricSchema.safeParse({
      ...f.native.wire,
      type: "listener.reply",
      status: "ready",
      nativeReady: wrong
    }).success
  );
  assert.equal(
    f.client.sendListenerReply(f.prepare, {
      status: "ready",
      nativeReady: wrong
    }),
    false
  );
  const wrongOwner = structuredClone(f.native.ready);
  wrongOwner.ownership.passId = "other-pass";
  assert.equal(
    f.client.sendListenerReply(f.prepare, {
      status: "ready",
      nativeReady: wrongOwner
    }),
    false
  );
  assert.equal(
    f.client.sendListenerReply(f.prepare, {
      status: "ready",
      nativeReady: f.native.ready
    }),
    true
  );
  assert.equal(
    f.client.sendListenerReply(f.prepare, {
      status: "armed",
      nativeArm: f.native.proof.armed
    }),
    false
  );
  const arm = f.control("arm");
  f.client.handleListenerControl(arm);
  assert.equal(
    f.client.sendListenerReply(arm, {
      status: "armed",
      nativeArm: f.native.ready
    }),
    false
  );
  const epoch = structuredClone(f.native.proof.armed);
  epoch.ownership.nativeEpoch += 1;
  epoch.receipt.fields = epoch.receipt.fields.map((n, i) =>
    [0, 10, 11].includes(i) ? epoch.ownership.nativeEpoch : n
  );
  epoch.receipt.confirmedFields = [...epoch.receipt.fields];
  epoch.receipt.timing[0] = epoch.ownership.nativeEpoch;
  epoch.receipt.confirmedTiming = [...epoch.receipt.timing];
  assert(
    codec.listenerReplyMetricSchema.safeParse({
      ...f.native.wire,
      type: "listener.reply",
      status: "armed",
      nativeArm: epoch
    }).success
  );
  assert.equal(
    f.client.sendListenerReply(arm, {
      status: "armed",
      nativeArm: epoch
    }),
    false
  );
  assert.equal(f.client.metricPhase.armed, null);
  assert.equal(
    f.client.sendListenerReply(arm, {
      status: "armed",
      nativeArm: f.native.proof.armed
    }),
    true
  );
});

test("self-consistent prepare geometry and arm detector/request settings cannot replace the frozen admission", () => {
  const f = setup();
  f.client.handleListenerControl(f.prepare);
  const ready = structuredClone(f.native.ready);
  ready.config.geometry = codec.createMetricListeningGeometry({
    sampleRate: ready.config.geometry.sampleRate,
    vectorSize: ready.config.geometry.vectorSize,
    tempoBpm: ready.config.geometry.tempoBpm,
    startBeat: ready.config.geometry.startBeat,
    startSample: 0,
    endBeat: ready.config.geometry.endBeat + 0.25
  });
  assert(
    codec.listenerReplyMetricSchema.safeParse({
      ...f.native.wire,
      type: "listener.reply",
      status: "ready",
      nativeReady: ready
    }).success
  );
  assert.equal(
    f.client.sendListenerReply(f.prepare, {
      status: "ready",
      nativeReady: ready
    }),
    false
  );
  assert.equal(
    f.client.sendListenerReply(f.prepare, {
      status: "ready",
      nativeReady: f.native.ready
    }),
    true
  );
  const pinnedReady = f.client.metricPhase.ready;
  f.native.ready.config.attacks.thresholdDb = 70;
  assert.notEqual(pinnedReady.config.attacks.thresholdDb, 70);
  assert(Object.isFrozen(pinnedReady.config.geometry.rows[0]));
  const arm = f.control("arm");
  f.client.handleListenerControl(arm);
  for (const change of [
    (proof) => {
      proof.config.attacks.thresholdDb += 1;
    },
    (proof) => {
      proof.config.attacks.minSpacingSamples += 1;
    },
    (proof) => {
      proof.config.requestedMetrics = ["level"];
      proof.config.attacks = null;
    }
  ]) {
    const proof = structuredClone(f.native.proof.armed);
    change(proof);
    assert(
      codec.listenerReplyMetricSchema.safeParse({
        ...f.native.wire,
        type: "listener.reply",
        status: "armed",
        nativeArm: proof
      }).success
    );
    assert.equal(
      f.client.sendListenerReply(arm, {
        status: "armed",
        nativeArm: proof
      }),
      false
    );
  }
  assert.equal(
    f.client.sendListenerReply(
      { ...f.prepare, action: "arm" },
      { status: "armed", nativeArm: f.native.proof.armed }
    ),
    false
  );
  assert.equal(
    f.client.sendListenerReply(arm, {
      status: "armed",
      nativeArm: f.native.proof.armed
    }),
    true
  );
  const pinnedArm = f.client.metricPhase.armed;
  f.native.proof.armed.receipt.fields[1] = 123;
  assert.notEqual(pinnedArm.receipt.fields[1], 123);
  assert(Object.isFrozen(pinnedArm.receipt.fields));
});

test("no publication before pinned arm+launch, nor from a self-consistent different accepted-arm receipt", () => {
  const f = setup();
  f.client.handleListenerControl(f.prepare);
  assert.equal(complete(f), false);
  assert.equal(
    f.client.sendListenerResult(f.prepare, {
      status: "progress",
      nativeLaunch: f.native.proof.launched
    }),
    false
  );
  assert.equal(
    f.client.sendListenerReply(f.prepare, {
      status: "ready",
      nativeReady: f.native.ready
    }),
    true
  );
  const arm = f.control("arm");
  f.client.handleListenerControl(arm);
  assert.equal(
    f.client.sendListenerReply(arm, {
      status: "armed",
      nativeArm: f.native.proof.armed
    }),
    true
  );
  assert.equal(complete(f), false);
  launch(f);
  const alternate = structuredClone(f.native.proof);
  alternate.armed.receipt.elapsedMs += 1;
  assert.equal(
    f.client.sendListenerResult(f.prepare, {
      status: "completed",
      observation: f.native.observation,
      nativeSourceCoverage: alternate
    }),
    false
  );
  const original = f.native.observation;
  const forged = structuredClone(original);
  forged.metrics.attacks.algorithm.thresholdDb += 1;
  assert.equal(
    f.client.sendListenerResult(f.prepare, {
      status: "completed",
      observation: forged,
      nativeSourceCoverage: f.native.proof
    }),
    false
  );
  assert(f.client.listenerJob);
  assert.equal(complete(f), true);
});

test("metric-local failed/cancelled progress continues; global failures/unknown family/epoch cannot hide in progress", () => {
  const f = setup();
  admitArm(f);
  for (const metric of ["level", "spectral-centroid", "attacks"]) {
    for (const stage of ["failed", "cancelled"]) {
      assert.equal(
        f.client.sendListenerResult(f.prepare, {
          status: "progress",
          nativeLifecycle: lifecycle(f, {
            metric,
            stage,
            reason: "metric_unavailable"
          })
        }),
        true
      );
      assert(f.client.listenerJob);
    }
  }
  for (const patch of [
    { stage: "failed", reason: "shared_failed" },
    { stage: "cancelled", reason: "shared_cancelled" },
    { stage: "failed", metric: "unknown", reason: "invalid_metric" },
    { stage: "failed", metric: "level" },
    { nativeEpoch: f.native.ready.ownership.nativeEpoch + 1 },
    { generation: "11111111-1111-4111-8111-111111111111" }
  ])
    assert.equal(
      f.client.sendListenerResult(f.prepare, {
        status: "progress",
        nativeLifecycle: lifecycle(f, patch)
      }),
      false
    );
  assert(f.client.listenerJob);
  assert.equal(
    f.client.sendListenerResult(f.prepare, {
      status: "failed",
      reason: "shared_failed"
    }),
    true
  );
  assert.equal(f.client.listenerJob, null);
});

test("canonical lifecycle facts preserve real scalar/unavailable operands and separate stage duration", () => {
  const f = setup();
  admitArm(f);
  const facts = [
    {
      field: "retained.requested",
      actual: { state: "observed", value: 12 },
      expected: { state: "observed", value: 24 },
      comparison: "at-most",
      unit: "count"
    },
    {
      field: "retained.ackCounter",
      actual: { state: "unavailable", reason: "not-reported" },
      unit: "samples"
    },
    ...Array.from({ length: 22 }, (_, index) => ({
      field: `retained.accepted${index}`,
      actual: { state: "observed", value: index },
      unit: "count"
    }))
  ];
  const event = lifecycle(f, { elapsedMs: 1800, durationMs: 42, facts });
  assert.equal(
    f.client.sendListenerResult(f.prepare, {
      status: "progress",
      nativeLifecycle: event
    }),
    true
  );
  const sent = f.writes.at(-1).nativeLifecycle;
  assert.deepEqual(sent.facts, facts);
  assert.equal(sent.elapsedMs, 1800);
  assert.equal(sent.durationMs, 42);
  facts[0].actual.value = 999;
  assert.equal(sent.facts[0].actual.value, 12);
  assert.equal(sent.eventId, event.eventId);
  assert.equal(sent.causationId, event.causationId);
  assert.equal(
    f.client.sendListenerResult(f.prepare, {
      status: "progress",
      nativeLifecycle: lifecycle(f, { facts: [] })
    }),
    true
  );
  assert.equal(
    Object.hasOwn(f.writes.at(-1).nativeLifecycle, "durationMs"),
    false
  );
  for (const patch of [
    { facts: [...facts, facts[0]] },
    {
      facts: [
        { field: "counter", actual: { state: "observed", value: Infinity } }
      ]
    },
    {
      facts: [
        {
          field: "counter",
          actual: { state: "unavailable", reason: "made-up" }
        }
      ]
    },
    {
      facts: [
        { field: "counter", actual: { state: "observed", value: { raw: 1 } } }
      ]
    },
    { durationMs: 120001 }
  ])
    assert.equal(
      f.client.sendListenerResult(f.prepare, {
        status: "progress",
        nativeLifecycle: lifecycle(f, patch)
      }),
      false
    );
  assert(f.client.listenerJob);
});

test("cancel blocks late/future positive results; stale owner cannot release a newer pass", () => {
  const f = setup();
  admitArm(f);
  const cancel = f.control("cancel");
  f.client.handleListenerControl(cancel);
  assert.equal(complete(f), false);
  assert.equal(
    f.client.sendListenerResult(f.prepare, {
      status: "progress",
      nativeLifecycle: lifecycle(f)
    }),
    false
  );
  assert.equal(
    f.client.sendListenerReply(cancel, {
      status: "cancelled",
      reason: "capture_cancelled"
    }),
    true
  );
  assert.equal(f.client.listenerJob, null);
  const next = f.control("prepare", {
    generation: "11111111-1111-4111-8111-111111111111",
    passId: "next-pass"
  });

  f.client.handleListenerControl(next);
  const job = f.client.listenerJob;
  assert.equal(
    f.client.sendListenerResult(f.prepare, {
      status: "cancelled",
      reason: "late_cancelled"
    }),
    false
  );
  assert.equal(f.client.listenerJob, job);
  assert.equal(f.client.metricPhase.ready, null);
});

test("flatness cancellation physically cleans up despite the SDK progress-rejection policy", () => {
  const {
    createFlatnessProbe
  } = require("../audio-listener/audio_listener_flatness_probe.js");
  const f = setup();
  admitArm(f);
  const epoch = f.native.ready.ownership.nativeEpoch;
  const commands = [];
  const probe = createFlatnessProbe({
    now: () => 0,
    sendControl: (...atoms) => commands.push(atoms),
    emit: (control, lifecycle) =>
      f.client.sendListenerDiagnostic(control, lifecycle)
  });
  probe.start(f.prepare, epoch, randomUUID());
  probe.receive([
    f.prepare.generation,
    epoch,
    "started",
    "fluid.spectralshape~",
    "fluid.spectralshape~"
  ]);
  const cancel = f.control("cancel");
  f.client.handleListenerControl(cancel);
  assert.equal(probe.stop(f.prepare, true), false);
  assert.deepEqual(commands.at(-1), ["stop", f.prepare.generation, epoch]);
  probe.receive([f.prepare.generation, epoch, "stopped"]);
  assert.equal(probe.stop(f.prepare, true), true);
  assert.equal(probe.snapshot().diagnosticDeliveryFailed, true);
  assert.equal(probe.snapshot().failure, null);
  assert(f.client.listenerJob);
  assert.equal(
    f.client.sendListenerResult(cancel, {
      status: "cancelled",
      reason: "cancelled"
    }),
    true
  );
  assert.equal(
    f.client.sendListenerReply(cancel, {
      status: "cancelled",
      reason: "cancelled"
    }),
    true
  );
  assert.equal(f.client.listenerJob, null);
});

test("flatness stops its gate when the actual SDK loses its authenticated connection", () => {
  const {
    createFlatnessProbe
  } = require("../audio-listener/audio_listener_flatness_probe.js");
  const f = setup();
  admitArm(f);
  const epoch = f.native.ready.ownership.nativeEpoch;
  const commands = [];
  const probe = createFlatnessProbe({
    now: () => 0,
    sendControl: (...atoms) => commands.push(atoms),
    emit: (control, lifecycle) =>
      f.client.sendListenerDiagnostic(control, lifecycle)
  });
  probe.start(f.prepare, epoch, randomUUID());
  f.client.authenticated = false;
  assert.throws(() => probe.stop(f.prepare), /diagnostic_delivery_failed/);
  assert.deepEqual(commands.at(-1), ["stop", f.prepare.generation, epoch]);
  assert.throws(
    () => probe.receive([f.prepare.generation, epoch, "stopped"]),
    /diagnostic_delivery_failed/
  );
  assert.equal(probe.stop(f.prepare), true);
  assert.equal(probe.snapshot().diagnosticDeliveryFailed, true);
});

test("cancelled result before cancel reply preserves only pending cancel completion authority", () => {
  const f = setup();
  const arm = admitArm(f);
  const cancel = f.control("cancel");
  f.client.handleListenerControl(cancel);
  const job = f.client.listenerJob;
  assert.equal(
    f.client.sendListenerResult(f.prepare, {
      status: "cancelled",
      reason: "native_cancelled"
    }),
    true
  );
  assert.equal(f.client.listenerJob, job);
  assert(f.client.listenerJobControlIds.has(cancel.requestId));
  assert.equal(
    f.client.sendListenerReply(arm, {
      status: "armed",
      nativeArm: f.native.proof.armed
    }),
    false
  );
  assert.equal(
    f.client.sendListenerReply(f.prepare, {
      status: "failed",
      reason: "late_prepare_failed"
    }),
    false
  );
  assert.equal(
    f.client.sendListenerResult(f.prepare, {
      status: "cancelled",
      reason: "duplicate_native_cancelled"
    }),
    false
  );
  assert.deepEqual(f.failures, []);
  f.client.handleListenerControl(f.control("prepare", { passId: "next-pass" }));
  assert.equal(f.client.listenerJob, job);
  assert.equal(f.writes.at(-1).reason, "listener_busy");
  assert.equal(
    f.client.sendListenerReply(cancel, {
      status: "cancelled",
      reason: "cancel_control_completed"
    }),
    true
  );
  assert.equal(f.writes.at(-1).requestId, cancel.requestId);
  assert.equal(f.client.listenerJob, null);
  assert.equal(f.client.metricControls.size, 0);
});

test("shared failure during cancellation releases pending cancel; cancel reply first blocks late result", () => {
  for (const resultFirst of [false, true]) {
    const f = setup();
    admitArm(f);
    const cancel = f.control("cancel");
    f.client.handleListenerControl(cancel);
    if (resultFirst)
      assert.equal(
        f.client.sendListenerResult(f.prepare, {
          status: "cancelled",
          reason: "native_cancelled"
        }),
        true
      );
    assert.equal(
      f.client.sendListenerResult(f.prepare, {
        status: "failed",
        reason: "shared_cleanup_failed"
      }),
      true
    );
    assert.equal(f.client.listenerJob, null);
    assert.equal(f.client.metricPhase, null);
    assert.equal(
      f.client.sendListenerReply(cancel, {
        status: "cancelled",
        reason: "late_cancel_reply"
      }),
      false
    );
  }
  const f = setup();
  admitArm(f);
  const cancel = f.control("cancel");
  f.client.handleListenerControl(cancel);
  assert.equal(
    f.client.sendListenerReply(cancel, {
      status: "cancelled",
      reason: "cancel_reply_first"
    }),
    true
  );
  assert.equal(
    f.client.sendListenerResult(f.prepare, {
      status: "cancelled",
      reason: "late_native_cancelled"
    }),
    false
  );
});

test("failed cancel reply delivery retains cancellation ownership until connection cleanup", () => {
  const f = setup();
  admitArm(f);
  const cancel = f.control("cancel");
  f.client.handleListenerControl(cancel);
  assert.equal(
    f.client.sendListenerResult(f.prepare, {
      status: "cancelled",
      reason: "native_cancelled"
    }),
    true
  );
  const job = f.client.listenerJob;
  f.client.socket.write = () => {
    throw new Error("cancel reply write failed");
  };
  assert.equal(
    f.client.sendListenerReply(cancel, {
      status: "cancelled",
      reason: "cancel_control_completed"
    }),
    false
  );
  assert.equal(f.client.listenerJob, job);
  assert(f.client.listenerJobControlIds.has(cancel.requestId));
  assert.equal(f.client.metricPhase.cancelledResultDelivered, true);
  f.client.handleClose(f.client.socket);
  assert.equal(f.client.listenerJob, null);
  assert.equal(f.client.metricPhase, null);
  assert.equal(f.client.metricControls.size, 0);
});

test("parse/serialize canonical clones reject getters/toJSON/prototypes without writes", () => {
  for (const decorate of [
    (value) =>
      Object.defineProperty(value, "nativeReady", {
        enumerable: true,
        get() {
          throw new Error("untrusted accessor");
        }
      }),
    (value) => {
      value.toJSON = () => ({ status: "armed" });
    },
    (value) => Object.setPrototypeOf(value, { toJSON: () => ({}) })
  ]) {
    const f = setup();
    f.client.handleListenerControl(f.prepare);
    const payload = { status: "ready", nativeReady: f.native.ready };
    decorate(payload);
    assert.equal(f.client.sendListenerReply(f.prepare, payload), false);
    assert.equal(f.writes.length, 0);
    assert.equal(f.client.metricPhase.ready, null);
  }
  const f = setup();
  let getterCalls = 0;
  Object.defineProperty(f.prepare.config.attacks, "thresholdDb", {
    enumerable: true,
    get() {
      getterCalls++;
      return 6;
    }
  });
  f.client.handleListenerControl(f.prepare);
  assert.equal(getterCalls, 0);
  assert.equal(f.admitted.length, 0);
});

test("cyclic and coupled diagnostic payloads cannot bypass canonical failure delivery or advance sequence", () => {
  const f = setup();
  f.client.handleListenerControl(f.prepare);
  const cyclic = { status: "ready", nativeReady: f.native.ready };
  cyclic.loop = cyclic;
  assert.equal(f.client.sendListenerReply(f.prepare, cyclic), false);
  for (const payload of [
    { status: "ready" },
    { status: "failed", reason: "capture_failed", nativeFailureDiagnostic: {} },
    {
      status: "completed",
      observation: { schema: "audio-observation/v2" },
      nativeCapture: f.native.proof
    }
  ])
    assert.equal(f.client.sendListenerResult(f.prepare, payload), false);
  assert.equal(f.client.listenerSequence, 0);
  assert.equal(f.writes.length, 0);
  assert(f.client.listenerJob);
  assert.equal(
    f.client.sendListenerResult(f.prepare, {
      status: "failed",
      reason: "capture_failed"
    }),
    true
  );
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].nativeFailureDiagnostic, undefined);
  assert.equal(f.client.listenerJob, null);
});

test("stop clears the selected native phase and controller ownership without accepting late callbacks", () => {
  const f = setup();
  admitArm(f);
  const job = f.client.listenerJob;
  f.client.socket.end = () => {
    f.client.socket.destroy();
  };
  f.client.stop();
  assert.equal(f.client.listenerJob, null);
  assert.equal(f.client.metricPhase, null);
  assert.equal(f.client.metricControls.size, 0);
  assert.equal(f.client.listenerJobControlIds.size, 0);
  assert(
    f.failures.some(
      (failure) => failure.reason === "stopped" && failure.job === job
    )
  );
  assert.equal(complete(f), false);
  assert.equal(
    f.client.sendListenerReply(f.prepare, {
      status: "ready",
      nativeReady: f.native.ready
    }),
    false
  );
});

test("write exceptions keep phase unadvanced and delivery diagnostics redacted with new proof geometry", () => {
  const f = setup();
  admitReady(f);
  const arm = f.control("arm");
  f.client.handleListenerControl(arm);
  f.client.socket.write = () => {
    throw new Error(`secret=${SECRET}`);
  };
  assert.equal(
    f.client.sendListenerReply(arm, {
      status: "armed",
      nativeArm: f.native.proof.armed
    }),
    false
  );
  assert.equal(f.client.metricPhase.armed, null);
  const diagnostic = f.failures.at(-1).diagnostic;
  assert.equal(
    diagnostic.armGeometry.actual,
    f.native.config.geometry.totalSamples
  );
  assert.equal(
    diagnostic.armGeometry.expected,
    f.native.config.geometry.totalSamples
  );
  assert(!JSON.stringify(f.statuses).includes(SECRET));
});

test("standard stream false accepts one ready proof while later frames obey bounded drain semantics", async () => {
  const f = setup();
  const writes = [],
    callbacks = [];
  const socket = new Writable({
    highWaterMark: 1,
    write(chunk, _encoding, done) {
      writes.push(JSON.parse(chunk));
      callbacks.push(done);
    }
  });
  socket.on("error", () => {});
  f.client.socket = socket;
  admitReady(f);
  assert(f.client.metricPhase.ready);
  assert(f.client.writeDrain);
  const arm = f.control("arm");
  f.client.handleListenerControl(arm);
  assert.equal(
    f.client.sendListenerReply(arm, {
      status: "armed",
      nativeArm: f.native.proof.armed
    }),
    true
  );
  assert.equal(writes.length, 1);
  assert.equal(f.client.writeQueue.length, 1);
  callbacks.shift()();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(writes.length, 2);
  assert.equal(writes[1].status, "armed");
  callbacks.shift()();
  await new Promise((resolve) => setTimeout(resolve, 0));
  f.client.clearWriteDrain("cancelled", "stopped");
  socket.destroy();
});

test("discovery and authenticated hello must explicitly acknowledge wire5 capability", async () => {
  const f = setup();
  f.client.descriptorPath = "/synthetic/profile/signal-ingress.json";
  const descriptor = {
    host: "127.0.0.1",
    port: 43210,
    protocol: "newline-delimited-json",
    protocolVersion: 1,
    maxFrameBytes: 128 * 1024,
    listenerVersions: [1, 2, 3, 4, 5],
    listenerCapabilities: [codec.LISTENER_CAPABILITY_METRIC]
  };
  for (const patch of [
    { listenerVersions: [1, 2, 3, 4] },
    { listenerVersions: [] },
    { listenerCapabilities: [] },
    { listenerVersions: undefined }
  ]) {
    f.client.readText = async () => JSON.stringify({ ...descriptor, ...patch });
    await assert.rejects(f.client.loadDescriptor(), /not advertised/);
  }
  f.client.readText = async () => JSON.stringify(descriptor);
  assert.equal((await f.client.loadDescriptor()).listenerVersions.at(-1), 5);
  for (const capabilities of [undefined, [], ["audio-listener/dual-mode-v1"]]) {
    const bad = setup();
    bad.client.authenticated = false;
    bad.client.pending.set("hello-test", "hello");
    bad.client.handleResponse(
      JSON.stringify({
        type: "producer.ack",
        protocolVersion: 1,
        action: "hello",
        requestId: "hello-test",
        connectionId: bad.client.connectionId,
        ...(capabilities ? { listenerCapabilities: capabilities } : {})
      })
    );
    assert.equal(bad.client.authenticated, false);
    assert.equal(bad.client.socket.destroyed, true);
  }
  const invalidIdentity = setup();
  invalidIdentity.client.authenticated = false;
  invalidIdentity.client.pending.set("invalid-identity-hello", "hello");
  invalidIdentity.client.handleResponse(
    JSON.stringify({
      type: "producer.ack",
      protocolVersion: 1,
      action: "hello",
      requestId: "invalid-identity-hello",
      connectionId: "not-a-canonical-connection-id",
      listenerCapabilities: [codec.LISTENER_CAPABILITY_METRIC]
    })
  );
  assert.equal(invalidIdentity.client.authenticated, false);
  assert.equal(invalidIdentity.client.socket.destroyed, true);
  f.client.pending.set("hello-good", "hello");
  f.client.handleResponse(
    JSON.stringify({
      type: "producer.ack",
      protocolVersion: 1,
      action: "hello",
      requestId: "hello-good",
      connectionId: f.client.connectionId,
      listenerCapabilities: [codec.LISTENER_CAPABILITY_METRIC]
    })
  );
  assert.equal(f.client.authenticated, true);
  f.client.stopHeartbeat();
});

test("new connection clears control/phase pins and drops prior READY execution evidence", async () => {
  const f = setup();
  admitArm(f);
  const previous = f.client.socket;
  f.client.handleClose(previous);
  assert.equal(f.client.metricPhase, null);
  assert.equal(f.client.listenerJob, null);
  const registration = structuredClone(f.native.registration);
  f.client.listener =
    codec.listenerRegistrationMetricSchema.parse(registration);
  const socket = new EventEmitter();
  socket.destroyed = false;
  socket.write = (encoded) => {
    f.writes.push(JSON.parse(encoded));
    return true;
  };
  socket.destroy = () => {
    socket.destroyed = true;
  };
  f.client.socket = null;
  f.client.started = true;
  f.client.createConnection = () => socket;
  f.client.loadDescriptor = async () => ({
    host: "127.0.0.1",
    port: 43210,
    maxFrameBytes: 128 * 1024
  });
  f.client.loadSecret = async () => SECRET;
  await f.client.connect();
  assert.equal(f.client.listenerControlSequence, -1);
  assert.equal(f.client.listenerSequence, 0);
  assert.equal(f.client.metricPhase, null);
  assert.equal(f.client.listener.nativeStatus.readiness, "BLOCKED");
  assert.equal(f.client.listener.nativeStatus.executedGen, null);
  assert.notEqual(f.client.listener.connectionEpoch, f.prepare.connectionEpoch);
  assert(Object.isFrozen(f.client.listener.nativeStatus));
  socket.emit("connect");
  assert.equal(f.writes.at(-1).listener.nativeStatus.executedGen, null);
  const failureCount = f.failures.length;
  assert.equal(
    f.client.sendListenerReply(f.prepare, {
      status: "armed",
      nativeArm: f.native.proof.armed
    }),
    false
  );
  assert.equal(f.failures.length, failureCount);
  f.client.stopping = true;
  socket.emit("close");
});

test("zero-data global cancellation and cleanup uncertainty are terminal without publishing observation", () => {
  for (const status of ["failed", "cancelled"]) {
    const f = setup();
    f.client.handleListenerControl(f.prepare);
    assert.equal(
      f.client.sendListenerResult(f.prepare, {
        status,
        reason:
          status === "failed" ? "cleanup_uncertain" : "cancelled_before_arm"
      }),
      true
    );
    assert.equal(f.client.listenerJob, null);
    assert.equal(f.writes.at(-1).observation, undefined);
    assert.equal(f.writes.at(-1).nativeSourceCoverage, undefined);
  }
  const f = setup("arrangement", true);
  admitArm(f);
  launch(f);
  const missingCompletion = structuredClone(f.native.proof);
  delete missingCompletion.completion;
  assert.equal(
    f.client.sendListenerResult(f.prepare, {
      status: "partial",
      observation: f.native.observation,
      nativeSourceCoverage: missingCompletion
    }),
    false
  );
  assert(f.client.listenerJob);
});

test("host control per-job quota, transport bounds and raw sample guard are unchanged for wire5", () => {
  const f = setup();
  f.client.handleListenerControl(f.prepare);
  f.client.listenerJobControlIds = new Set(
    Array.from({ length: 64 }, (_, i) => `admitted-${i}`)
  );
  f.client.handleListenerControl(f.control("cancel"));
  assert.equal(f.admitted.length, 1);
  assert.equal(f.client.socket.destroyed, true);
  assert(
    f.failures.some(
      (value) => value.reason === "listener_control_quota_exceeded"
    )
  );
  const limited = setup("arrangement", false, { maxFrameBytes: 200 });
  limited.client.handleListenerControl(limited.prepare);
  assert.equal(limited.admitted.length, 0);
  const outbound = setup();
  outbound.client.handleListenerControl(outbound.prepare);
  outbound.client.configuredMaxFrameBytes = 200;
  assert.equal(
    outbound.client.sendListenerReply(outbound.prepare, {
      status: "ready",
      nativeReady: outbound.native.ready
    }),
    false
  );
  assert.equal(outbound.client.metricPhase.ready, null);
  assert.equal(outbound.writes.length, 0);
  assert(outbound.failures.at(-1).diagnostic.encodedBytes > 200);
  assert.equal(
    outbound.client.sendSample({ raw: "not-an-observation" }),
    false
  );
  assert.equal(outbound.writes.length, 0);
});

test("failed admission to write queue and synchronous write callback errors never advance ready/arm state", () => {
  for (const fail of [
    (f) => {
      f.client.maxPendingRequests = 0;
    },
    (f) => {
      f.client.socket.write = (_chunk, done) => {
        done(new Error("synthetic transport failure"));
        return true;
      };
    }
  ]) {
    const f = setup();
    f.client.handleListenerControl(f.prepare);
    fail(f);
    assert.equal(
      f.client.sendListenerReply(f.prepare, {
        status: "ready",
        nativeReady: f.native.ready
      }),
      false
    );
    assert.equal(f.client.metricPhase.ready, null);
    assert.equal(f.client.listenerSequence, 0);
    assert(f.client.listenerJob);
  }
});

test("callback errors retain owner trace and redact credentials before failed reply publication", async () => {
  for (const asynchronous of [false, true]) {
    const f = setup("arrangement", false, {
      onListenerControl: () => {
        const error = new Error(`secret=${SECRET}`);
        if (asynchronous) return Promise.reject(error);
        throw error;
      }
    });
    f.client.handleListenerControl(f.prepare);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(f.writes.length, 1);
    assert.equal(f.writes[0].status, "failed");
    assert(!JSON.stringify(f.writes).includes(SECRET));
    assert.equal(f.writes[0].traceId, f.prepare.traceId);
    assert.equal(f.writes[0].correlationId, f.prepare.correlationId);
    assert.equal(f.writes[0].causationId, f.prepare.causationId);
    assert.equal(f.client.listenerJob, null);
  }
});
