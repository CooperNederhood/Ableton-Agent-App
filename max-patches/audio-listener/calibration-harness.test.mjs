/* global URL, process, structuredClone */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as builder from "../../scripts/audio-listener-device.mjs";
import { calibrationDocuments, CLOCK_CODE } from "./calibration-source.mjs";
const require = createRequire(import.meta.url);
const { CommissioningCollector } = require("./calibration_controller.js");
const {
  validateReport,
  ANALYSIS_RESOURCES,
} = require("./calibration_report.js");

async function staged(t) {
  const dir = await mkdtemp(join(tmpdir(), "native-commissioning-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const manifest = await builder.buildCalibration(dir);
  return { dir, manifest };
}
function syntheticCollector(manifest) {
  let now = 0;
  const events = [];
  const c = new CommissioningCollector({
    manifest,
    emit: (...v) => events.push(v),
    now: () => now,
  });
  const load = (id = "silence") => {
    c.authorize("runner-owned");
    c.fixture(id);
    c.loaded(48000, 2000, 2, `commission-${id}.wav`);
    c.dspState(1, 48000, 64, 256);
  };
  return {
    c,
    events,
    load,
    advance: (n) => {
      now += n;
      c.tick();
    },
  };
}
// Synthetic packets test collection contracts only, NOT executed Gen/FFT/DSP.
function fakePacket(sample, epoch, reset = 1024) {
  const clock = reset + sample;
  return [
    0,
    0,
    0,
    0,
    sample,
    0,
    0,
    clock,
    Math.floor(clock / 64),
    clock % 64,
    epoch,
    reset,
    sample < 96000 ? 1 : 0,
  ];
}
function syntheticComplete(c) {
  c.start();
  const epoch = c.expectedEpoch;
  c.frame(fakePacket(0, epoch));
  for (let sample = 4800; sample <= 96000; sample += 4800)
    c.frame(fakePacket(sample, epoch));
  assert.equal(c.result, null); // Guard receipt is not a native reset acknowledgement.
  c.guardEvent("fixture_end", c.expectedEpoch);
  c.frame(fakePacket(0, c.expectedEpoch, 97088));
  return c.result;
}

test("separate calibration staging/check API exists without a production commissioning bypass", () => {
  assert.equal(typeof builder.buildCalibration, "function");
  assert.equal(typeof builder.checkCalibrationArtifact, "function");
});
test("portable native commissioning patch exists and routes real PCM signals into exact analyzer", async () => {
  const d = JSON.parse(
    await readFile(
      new URL("./Audio-Listener-Commissioning.maxpat", import.meta.url),
      "utf8",
    ),
  );
  assert.ok(
    d.patcher.boxes.some(
      ({ box }) => box.text === "poly~ audio_listener_analysis 1 @parallel 0",
    ),
  );
  assert.ok(
    d.patcher.boxes.some(
      ({ box }) => box.text === "index~ #0-commission-fixture 1",
    ),
  );
  assert.ok(
    d.patcher.boxes.some(
      ({ box }) => box.text === "index~ #0-commission-fixture 2",
    ),
  );
  assert.deepEqual(
    d,
    calibrationDocuments()["Audio-Listener-Commissioning.maxpat"],
  );
  builder.validateDocument(d);
  const wired = (a, o, b, i = 0) =>
    d.patcher.lines.some(
      ({ patchline: p }) =>
        p.source[0] === a &&
        p.source[1] === o &&
        p.destination[0] === b &&
        p.destination[1] === i,
    );
  for (const [source, gate, channel] of [
    ["left", "gateL", 0],
    ["right", "gateR", 1],
  ]) {
    assert.ok(wired("clock", 0, source));
    assert.ok(wired(source, 0, gate));
    assert.ok(wired("clock", 6, gate, 1));
    assert.ok(wired(gate, 0, "analysis", channel));
  }
  for (let i = 0; i < 7; i++) assert.ok(wired("analysis", i, "packet", i + 1));
  for (let i = 1; i < 7; i++) assert.ok(wired("clock", i, "packet", i + 7));
  assert.ok(wired("guard", 1, "analysis", 2));
  assert.ok(wired("guard", 2, "clock"));
  assert.ok(wired("guard", 3, "buffer"));
  const packet = d.patcher.boxes.find(({ box }) => box.id === "packet").box
    .patcher;
  assert.equal(
    packet.boxes.filter(({ box }) => box.text === "snapshot~ @offset 0").length,
    13,
  );
  assert.match(CLOCK_CODE, /resetAt = clock/);
  assert.match(CLOCK_CODE, /clock = clock \+ 1/);
  assert.doesNotMatch(
    JSON.stringify(d),
    /AgentSignalClient|plugin~|plugout~|dac~|ezdac~|LiveAPI|producer_identity|plugsync/,
  );
});
test("descriptor-only commissioning schema is separate from production clip context", () => {
  const report = require("./calibration_report.js");
  assert.equal(typeof report.validateReport, "function");
  assert.equal(report.SCHEMA, "native-commissioning/v1");
});

test("checked artifact ships exact analyzer bytes and independently generated stereo PCM", async (t) => {
  const { dir, manifest } = await staged(t);
  assert.equal(manifest.resources.length, 13);
  assert.equal((await readdir(dir)).length, 14);
  await builder.checkCalibrationArtifact(dir);
  for (const name of ANALYSIS_RESOURCES) {
    assert.deepEqual(
      await readFile(join(dir, name)),
      await readFile(join(builder.SOURCE_DIRECTORY, name)),
    );
  }
  for (const fixture of manifest.fixtures) {
    const raw = await readFile(join(dir, fixture.file));
    assert.equal(raw.toString("ascii", 0, 4), "RIFF");
    assert.equal(raw.readUInt32LE(24), 48000);
    assert.equal(raw.readUInt16LE(22), 2);
    assert.equal(raw.readUInt16LE(34), 16);
    assert.equal(raw.readUInt32LE(40), 96000 * 4);
    let peak = 0,
      square = 0;
    for (let frame = 0; frame < 96000; frame++) {
      const l = raw.readInt16LE(44 + frame * 4),
        r = raw.readInt16LE(46 + frame * 4);
      if (fixture.id === "silence") assert.equal(l, 0);
      assert.equal(
        r,
        fixture.id === "anti-phase-quarter-sine" && l !== 0 ? -l : l,
      );
      peak = Math.max(peak, Math.abs(l / 32768));
      square += (l / 32768) ** 2;
    }
    assert.equal(peak, fixture.reference.peak[0]);
    assert.equal(
      square ? 10 * Math.log10(square / 96000) : null,
      fixture.reference.rmsDbfs[0],
    );
  }
});

test("artifact startup refuses tampering, missing dependencies, extra production files and nonempty staging", async (t) => {
  const { dir } = await staged(t);
  await assert.rejects(builder.buildCalibration(dir), /must be empty/);
  const file = join(dir, "calibration_guard.js"),
    original = await readFile(file);
  await writeFile(file, "tampered");
  await assert.rejects(builder.checkCalibrationArtifact(dir), /hash mismatch/);
  await writeFile(file, original);
  const { readArtifact } = require("./calibration_controller.js");
  await writeFile(
    join(dir, "agent_signal_storage.js"),
    "credentials must never load",
  );
  assert.throws(() => readArtifact(dir), /unexpected_calibration_file/);
  await rm(join(dir, "agent_signal_storage.js"));
  await rm(file);
  assert.throws(() => readArtifact(dir), /ENOENT/);
});

test("strict startup rejects duplicate fixture IDs and disguised production metadata", async (t) => {
  const { dir, manifest } = await staged(t);
  const { readArtifact } = require("./calibration_controller.js");
  for (const change of [
    (m) => {
      m.fixtures[1] = structuredClone(m.fixtures[0]);
    },
    (m) => {
      m.productionReady = true;
    },
    (m) => {
      m.fixtures[0].reference.waveform = [0, 1];
    },
    (m) => {
      m.fftWindowSamples = 4800;
    },
  ]) {
    const m = structuredClone(manifest);
    change(m);
    await writeFile(join(dir, "calibration-manifest.json"), JSON.stringify(m));
    assert.throws(() => readArtifact(dir));
  }
});

test("checked artifact detects changed PCM even if its manifest digest is replaced", async (t) => {
  const { dir, manifest } = await staged(t);
  const name = "commission-silence.wav",
    raw = await readFile(join(dir, name));
  raw.writeInt16LE(100, 44);
  await writeFile(join(dir, name), raw);
  const digest = createHash("sha256").update(raw).digest("hex");
  manifest.resources.find((r) => r.name === name).sha256 = digest;
  manifest.fixtures.find((f) => f.file === name).sha256 = digest;
  await writeFile(
    join(dir, "calibration-manifest.json"),
    JSON.stringify(manifest),
  );
  await assert.rejects(
    builder.checkCalibrationArtifact(dir),
    /independent known PCM/,
  );
});

test("synthetic collection requires ownership, load, DSP and actual packet reset markers", async (t) => {
  const { manifest } = await staged(t),
    { c, load } = syntheticCollector(manifest);
  assert.throws(() => c.fixture("silence"), /invalid_fixture/);
  assert.throws(() => c.authorize("anything"), /ownership/);
  assert.throws(() => c.start(), /not_loaded/);
  load();
  c.start();
  const epoch = c.expectedEpoch;
  const nonfiniteSilentPacket = fakePacket(0, epoch);
  nonfiniteSilentPacket[5] = NaN;
  assert.throws(() => c.frame(nonfiniteSilentPacket), /invalid_native_packet/);
  c.guardEvent("started", epoch);
  assert.equal(c.current.markers.start, null);
  c.frame(fakePacket(0, epoch - 1));
  assert.equal(c.state, "waiting-reset");
  c.frame(fakePacket(0, epoch));
  assert.equal(c.state, "collecting");
  c.frame(fakePacket(4800, epoch));
  c.frame(fakePacket(4800, epoch));
  assert.equal(c.current.descriptors.length, 1);
  c.cancel();
  c.frame(fakePacket(0, c.expectedEpoch, 6000));
  assert.equal(c.result.outcome, "cancelled");
  assert.equal(c.result.productionReady, false);
});

test("synthetic complete report stays unverified and strict descriptor schema rejects raw/context/status fields", async (t) => {
  const { manifest } = await staged(t),
    { c, load } = syntheticCollector(manifest);
  load();
  const report = syntheticComplete(c);
  assert.equal(report.outcome, "collected");
  assert.equal(report.descriptors.length, 20);
  assert.equal(report.nativeTiming, "UNVERIFIED");
  const mutations = [
    (v) => {
      v.productionReady = true;
    },
    (v) => {
      v.nativeTiming = "VERIFIED";
    },
    (v) => {
      v.passId = "production";
    },
    (v) => {
      v.waveform = [0, 1];
    },
    (v) => {
      v.descriptors[0].pcm = [0];
    },
    (v) => {
      v.descriptors[0].peak[0] = NaN;
    },
    (v) => {
      v.descriptors[0].rms[0] = Infinity;
    },
    (v) => {
      v.descriptors[0].centroidHz = 24001;
    },
    (v) => {
      v.descriptors[0].sourceActive = "true";
    },
    (v) => {
      v.descriptors[0].marker.vectorOffset++;
    },
    (v) => {
      v.descriptors[0].referenceSample++;
    },
    (v) => {
      v.descriptors[0].analysisSample++;
    },
    (v) => {
      v.descriptors[0].rms[0] = 1;
    },
    (v) => {
      v.descriptors = Array(129).fill(v.descriptors[0]);
    },
    (v) => {
      v.markers.stop = null;
    },
  ];
  for (const change of mutations) {
    const value = structuredClone(report);
    change(value);
    assert.throws(() => validateReport(value));
  }
});

test("synthetic gap, DSP change, timeout and absent stop markers never report collected", async (t) => {
  const { manifest } = await staged(t);
  {
    const { c, load, advance } = syntheticCollector(manifest);
    load();
    c.start();
    c.frame(fakePacket(9600, c.expectedEpoch));
    assert.equal(c.current.reason, "descriptor_gap");
    advance(1000);
    assert.equal(c.result.outcome, "failed");
    assert.equal(c.result.reason, "missing_reset_marker");
  }
  for (const operation of [
    (c) => c.dspState(0, 48000, 64, 256),
    (c) => c.dspState(1, 48000, 128, 256),
  ]) {
    const { c, load, advance } = syntheticCollector(manifest);
    load();
    c.start();
    operation(c);
    advance(1000);
    assert.equal(c.result.outcome, "failed");
  }
  const { c, load, advance, events } = syntheticCollector(manifest);
  load();
  c.start();
  advance(10000);
  assert.equal(c.current.reason, "watchdog");
  c.guardEvent("watchdog", c.expectedEpoch);
  const stops = events.filter((e) => e[0] === "stop").length;
  c.guardEvent("watchdog", c.expectedEpoch);
  assert.equal(events.filter((e) => e[0] === "stop").length, stops);
  c.frame(fakePacket(0, c.expectedEpoch, 128000));
  assert.equal(c.result.outcome, "failed");
});

test("loading mismatch, unsupported DSP and load cancellation clear without enabling native source", async (t) => {
  const { manifest } = await staged(t),
    { c, events, advance } = syntheticCollector(manifest);
  c.authorize("runner-owned");
  c.fixture("silence");
  assert.throws(
    () => c.loaded(44100, 2000, 2, "commission-silence.wav"),
    /metadata/,
  );
  assert.throws(() => c.dspState(1, 44100, 64, 256), /unsupported/);
  c.fixture("silence");
  advance(3000);
  assert.equal(c.state, "idle");
  c.fixture("silence");
  c.cancel();
  assert.equal(c.state, "idle");
  assert.equal(events.filter((e) => e[0] === "begin").length, 0);
  assert.ok(events.filter((e) => e[0] === "stop").length >= 3);
});

test("Node-VM classic-Max JS guard mutes, resets, disables PCM and clears on both watchdogs/deletion", async () => {
  const source = await readFile(
    new URL("./calibration_guard.js", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /,\s*\)/); // Classic Max function syntax.
  const events = [];
  let cancelled = false;
  const ctx = vm.createContext({
    outlet: (...e) => events.push(e),
    post: () => {},
    Task: function () {
      this.repeat = () => {};
      this.cancel = () => {
        cancelled = true;
      };
    },
  });
  vm.runInContext(source, ctx);
  ctx.configure(48000, 64);
  ctx.begin(17, 96000);
  for (let i = 0; i < 8; i++) ctx.check();
  assert.equal(ctx.active, false);
  assert.ok(events.some((e) => e.join(":") === "4:guard-event:watchdog:18"));
  for (const stop of [
    [0, "mute", 0, 1],
    [1, "reset"],
    [2, "enabled", 0],
    [3, "clear"],
  ]) {
    assert.ok(events.some((e) => JSON.stringify(e) === JSON.stringify(stop)));
  }
  ctx.stop("malformed", "bad");
  assert.ok(Number.isSafeInteger(ctx.serial));
  ctx.begin(ctx.serial + 1, 96000);
  for (let i = 0; i < 40; i++) {
    ctx.heartbeat();
    ctx.check();
  }
  assert.equal(ctx.active, false);
  ctx.notifydeleted();
  assert.equal(cancelled, true);
});

test("isolated staged runtime uses no connection/profile/context modules and exports bounded JSON only", async (t) => {
  const { dir } = await staged(t);
  const run = spawnSync(
    process.execPath,
    [
      "-e",
      `
    const Module = require("node:module");
    const allowed = new Set(["node:fs","node:path","node:crypto","./calibration_report.js", ${JSON.stringify(join(dir, "calibration_controller.js"))}]);
    const load = Module._load;
    Module._load = function(id, ...rest) {
      if (!allowed.has(id)) throw Error("forbidden dependency:" + id);
      return load.call(this,id,...rest);
    };
    const {createCommissioningRuntime} = require(${JSON.stringify(join(dir, "calibration_controller.js"))});
    const handlers = {}, messages = [];
    const r = createCommissioningRuntime({directory:${JSON.stringify(dir)},
      maxApi:{addHandler:(k,v)=>handlers[k]=v,outlet:(...v)=>messages.push(v)},
      interval:()=>1,clear:()=>{}});
    handlers.authorize("runner-owned"); handlers.fixture("silence");
    handlers.loaded(48000,2000,2,"commission-silence.wav"); handlers.dsp(1,48000,64,256);
    handlers.start();
    const epoch=r.collector.expectedEpoch;
    const packet=(n,e,reset=1024)=>[0,0,0,0,n,0,0,reset+n,Math.floor((reset+n)/64),(reset+n)%64,e,reset,n<96000?1:0];
    handlers.frame(...packet(0,epoch));
    for(let n=4800;n<=96000;n+=4800) handlers.frame(...packet(n,epoch));
    handlers.frame(...packet(0,r.collector.expectedEpoch,97088));
    handlers.report(); r.stop();
    console.log(JSON.stringify({state:r.collector.state,outcome:r.collector.result.outcome,ready:r.collector.result.productionReady}));
  `,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        ABLETON_AGENT_SIGNAL_DESCRIPTOR_PATH: "/nonexistent/credentials",
      },
    },
  );
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), {
    state: "done",
    outcome: "collected",
    ready: false,
  });
  const file = await readFile(join(dir, "native-commissioning-report.json"));
  assert.ok(file.length <= 65536);
  validateReport(JSON.parse(file));
  assert.equal(
    (await readdir(dir)).includes("native-commissioning-report.json.staged"),
    false,
  );
  await builder.checkCalibrationArtifact(dir);
});
