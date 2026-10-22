/* global module, require, __dirname, process, setInterval, clearInterval */
"use strict";
// Only native descriptor/marker messages are collected. No DSP model runs here.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const {
  SCHEMA,
  MAX_POINTS,
  FIXTURES,
  ANALYSIS_RESOURCES,
  integer,
  marker,
  validateReport,
  exact,
} = require("./calibration_report.js");
const hash = (raw) => crypto.createHash("sha256").update(raw).digest("hex");

function readArtifact(directory = __dirname) {
  const manifestFile = path.join(directory, "calibration-manifest.json");
  if (fs.statSync(manifestFile).size > 65536)
    throw new Error("manifest_size_limit");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  exact(manifest, [
    "schema",
    "calibrationOnly",
    "realDeviceValidated",
    "patch",
    "fftWindowSamples",
    "envelopeWindowSamples",
    "maxReportBytes",
    "fixtures",
    "resources",
  ]);
  if (
    manifest.schema !== "native-commissioning-resources/v1" ||
    manifest.calibrationOnly !== true ||
    manifest.realDeviceValidated !== false ||
    manifest.patch !== "Audio-Listener-Commissioning.maxpat" ||
    manifest.fftWindowSamples !== 2048 ||
    manifest.envelopeWindowSamples !== 4800 ||
    manifest.maxReportBytes !== 65536 ||
    !Array.isArray(manifest.resources) ||
    manifest.resources.length > 20
  ) {
    throw new Error("invalid_calibration_manifest");
  }
  const seen = new Set();
  for (const r of manifest.resources) {
    exact(r, ["name", "sha256", "bytes"]);
    integer(r.bytes, 1048576);
    if (
      !r.bytes ||
      typeof r.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(r.sha256)
    ) {
      throw new Error("invalid_calibration_resource");
    }
    if (
      typeof r.name !== "string" ||
      path.basename(r.name) !== r.name ||
      seen.has(r.name) ||
      !/^(audio_listener_(analysis|spectrum)\.maxpat|audio_listener_(envelope|spectrum_energy)\.gendsp|calibration_(clock\.gendsp|controller\.js|guard\.js|report\.js)|Audio-Listener-Commissioning\.maxpat|package\.json|commission-(silence|quarter-sine|anti-phase-quarter-sine)\.wav)$/.test(
        r.name,
      )
    ) {
      throw new Error("forbidden_calibration_resource");
    }
    seen.add(r.name);
    const file = path.join(directory, r.name);
    const size = fs.statSync(file).size;
    if (
      size > 1048576 ||
      size !== r.bytes ||
      hash(fs.readFileSync(file)) !== r.sha256
    )
      throw new Error("resource_hash_mismatch");
  }
  if (
    manifest.resources.length !== 13 ||
    !ANALYSIS_RESOURCES.every((name) => seen.has(name)) ||
    !FIXTURES.every((id) => seen.has(`commission-${id}.wav`))
  )
    throw new Error("missing_calibration_resource");
  if (
    !Array.isArray(manifest.fixtures) ||
    manifest.fixtures.length !== 3 ||
    new Set(manifest.fixtures.map((f) => f.id)).size !== 3
  )
    throw new Error("invalid_fixture_manifest");
  for (const f of manifest.fixtures) {
    exact(f, ["id", "file", "sha256", "sampleRate", "frames", "reference"]);
    exact(f.reference, ["peak", "rmsDbfs"]);
    if (
      !Array.isArray(f.reference.peak) ||
      f.reference.peak.length !== 2 ||
      f.reference.peak.some((v) => !Number.isFinite(v) || v < 0 || v > 1) ||
      !Array.isArray(f.reference.rmsDbfs) ||
      f.reference.rmsDbfs.length !== 2 ||
      f.reference.rmsDbfs.some(
        (v) => v !== null && (!Number.isFinite(v) || v < -120 || v > 0),
      )
    ) {
      throw new Error("invalid_fixture_reference");
    }
    const resource = manifest.resources.find((r) => r.name === f.file);
    if (
      !FIXTURES.includes(f.id) ||
      f.file !== `commission-${f.id}.wav` ||
      !resource ||
      f.sha256 !== resource.sha256 ||
      f.frames !== 96000 ||
      f.sampleRate !== 48000
    )
      throw new Error("invalid_fixture_manifest");
  }
  const allowed = new Set([
    ...seen,
    "calibration-manifest.json",
    "native-commissioning-report.json",
  ]);
  for (const name of fs.readdirSync(directory)) {
    if (!allowed.has(name)) throw new Error("unexpected_calibration_file");
    if (!fs.lstatSync(path.join(directory, name)).isFile())
      throw new Error("nonregular_calibration_file");
  }
  return manifest;
}

class CommissioningCollector {
  constructor({ manifest, emit = () => {}, now = Date.now } = {}) {
    this.manifest = manifest;
    this.emit = emit;
    this.now = now;
    this.authorized = false;
    this.state = "idle";
    this.serial = 16;
    this.dsp = null;
    this.selected = null;
    this.current = null;
    this.result = null;
  }
  authorize(value) {
    if (value !== "runner-owned")
      throw new Error("runner_ownership_ack_required");
    this.authorized = true; // Operator acknowledgement, not a claim of PID attestation.
  }
  fixture(id) {
    if (!this.authorized || !FIXTURES.includes(id) || this.current)
      throw new Error("invalid_fixture_selection");
    const f = this.manifest.fixtures.find((v) => v.id === id);
    this.selected = f;
    this.state = "loading";
    this.changedAt = this.now();
    this.result = null;
    this.emit("load", f.file);
  }
  loaded(sr, duration, channels, filename) {
    if (this.state !== "loading") return;
    if (
      sr !== 48000 ||
      Math.round((duration * sr) / 1000) !== 96000 ||
      channels !== 2 ||
      filename !== this.selected.file
    ) {
      this.state = "idle";
      this.emit("stop", ++this.serial, "fixture_metadata_mismatch");
      throw new Error("fixture_metadata_mismatch");
    }
    this.state = "loaded";
  }
  dspState(on, sampleRate, vectorSize, ioVectorSize) {
    if (!on) {
      if (this.current) this.finish("failed", "dsp_stopped");
      this.dsp = null;
      return;
    }
    integer(vectorSize, 4096);
    integer(ioVectorSize, 65536);
    if (sampleRate !== 48000 || !vectorSize || !ioVectorSize)
      throw new Error("unsupported_dsp");
    const next = { sampleRate, vectorSize, ioVectorSize };
    if (this.current && JSON.stringify(next) !== JSON.stringify(this.dsp)) {
      this.finish("failed", "dsp_changed");
      return;
    }
    this.dsp = next;
    this.emit("configure", sampleRate, vectorSize);
  }
  start() {
    if (
      !this.authorized ||
      this.state !== "loaded" ||
      !this.dsp ||
      this.current
    )
      throw new Error("not_loaded_or_authorized");
    const resources = Object.fromEntries(
      ANALYSIS_RESOURCES.map((name) => [
        name,
        this.manifest.resources.find((r) => r.name === name).sha256,
      ]),
    );
    this.current = {
      schema: SCHEMA,
      calibrationOnly: true,
      nativeTiming: "UNVERIFIED",
      productionReady: false,
      outcome: "failed",
      reason: "pending",
      fixture: {
        id: this.selected.id,
        sha256: this.selected.sha256,
        sampleRate: this.selected.sampleRate,
        frames: this.selected.frames,
      },
      dsp: { ...this.dsp },
      resources,
      markers: { start: null, stop: null },
      descriptors: [],
      limitations: [
        "Harness-local Gen sample clock; vector groups use reported DSP vector size, not certified global host phase.",
        "Snapshot and queue timing/FFT offsets require runner-owned real Max validation.",
        "No host/source-launch timing or cross-boundary identity attestation is supplied.",
        "Collected is not validated and never enables production readiness.",
      ],
    };
    this.expectedEpoch = ++this.serial;
    this.state = "waiting-reset";
    this.changedAt = this.now();
    this.startedAt = this.now();
    this.emit("begin", this.expectedEpoch, this.selected.frames);
  }
  frame(values) {
    if (!this.current) return;
    if (
      !Array.isArray(values) ||
      values.length !== 13 ||
      !values.every(Number.isFinite)
    )
      throw new Error("invalid_native_packet");
    if (values[5] < 0 || values[5] > 24000)
      throw new Error("invalid_native_centroid");
    const p = this.current;
    if (values[12] !== 0 && values[12] !== 1)
      throw new Error("invalid_source_gate");
    const m = marker(
      {
        dspSample: values[7],
        vectorIndex: values[8],
        vectorOffset: values[9],
        resetEpoch: values[10],
        resetSample: values[11],
      },
      p.dsp.vectorSize,
    );
    if (this.state === "draining") {
      if (m.resetEpoch === this.expectedEpoch) {
        p.markers.stop = m;
        this.complete();
      }
      return;
    }
    if (m.resetEpoch !== this.expectedEpoch) return;
    if (!p.markers.start) {
      p.markers.start = m;
      this.state = "collecting";
    }
    const sample = values[4],
      previous = p.descriptors.at(-1)?.analysisSample ?? 0;
    if (sample === 0 || sample === previous) return;
    if (sample !== previous + 4800 || sample > 96000) {
      this.finish("failed", "descriptor_gap");
      return;
    }
    if (p.descriptors.length >= MAX_POINTS) {
      this.finish("failed", "descriptor_limit");
      return;
    }
    const point = {
      analysisSample: sample,
      referenceSample: m.dspSample - m.resetSample,
      marker: m,
      sourceActive: values[12] === 1,
      peak: [values[0], values[1]],
      rms: [values[2], values[3]],
      centroidHz: values[6] <= 1e-20 ? null : values[5],
      spectralEnergy: values[6],
    };
    p.descriptors.push(point);
    try {
      validateReport(p);
    } catch (e) {
      p.descriptors.pop();
      this.finish("failed", "invalid_descriptor");
      throw e;
    }
    if (sample === 96000) this.finish("collected", "fixture_end");
  }
  finish(outcome, reason) {
    if (!this.current) return;
    if (this.state === "draining") {
      if (outcome !== "collected") {
        this.current.outcome = outcome;
        this.current.reason = reason;
      }
      return;
    }
    this.current.outcome = outcome;
    this.current.reason = reason;
    this.state = "draining";
    this.changedAt = this.now();
    this.expectedEpoch = ++this.serial;
    this.emit("stop", this.expectedEpoch, reason);
  }
  cancel() {
    if (this.current) {
      this.finish("cancelled", "cancelled");
      return;
    }
    this.state = "idle";
    this.selected = null;
    this.result = null;
    this.emit("stop", ++this.serial, "cancelled");
  }
  guardEvent(reason, serial) {
    integer(serial, 1000000);
    this.serial = Math.max(this.serial, serial);
    if (!this.current) return;
    if (reason === "started") {
      if (serial !== this.expectedEpoch)
        this.finish("failed", "reset_epoch_mismatch");
      return;
    }
    // A guard-originated stop already applied this epoch. Do not issue another
    // reset and race its native acknowledgement (especially watchdog shutdown).
    this.expectedEpoch = serial;
    if (this.state !== "draining") {
      this.current.outcome = "failed";
      this.current.reason = "native_guard_stopped";
      this.state = "draining";
      this.changedAt = this.now();
    }
  }
  complete() {
    const value = validateReport(this.current);
    this.result = value;
    this.current = null;
    this.state = "done";
    this.emit("notice", "report_available");
  }
  tick() {
    if (this.state === "loading" && this.now() - this.changedAt >= 3000) {
      this.state = "idle";
      this.emit("stop", ++this.serial, "load_timeout");
    } else if (this.current) {
      if (this.state === "draining" && this.now() - this.changedAt >= 1000) {
        this.current.outcome = "failed";
        this.current.reason = "missing_reset_marker";
        this.complete();
      } else if (this.now() - this.startedAt >= 10000)
        this.finish("failed", "watchdog");
    }
  }
}

function createCommissioningRuntime({
  maxApi,
  directory = __dirname,
  now = Date.now,
  interval = setInterval,
  clear = clearInterval,
} = {}) {
  const manifest = readArtifact(directory);
  const emit = (kind, ...args) => {
    if (kind === "load") args[0] = path.join(directory, args[0]);
    maxApi.outlet(kind, ...args);
  };
  const collector = new CommissioningCollector({ manifest, emit, now });
  const handle = (name, action) =>
    maxApi.addHandler(name, (...args) => {
      try {
        action(...args);
      } catch {
        collector.finish("failed", "invalid_native_input");
        emit("notice", "commissioning_input_rejected");
      }
    });
  handle("authorize", (value) => collector.authorize(value));
  handle("fixture", (id) => collector.fixture(id));
  handle("loaded", (...v) => collector.loaded(...v));
  handle("dsp", (...v) => collector.dspState(...v));
  handle("start", () => collector.start());
  handle("cancel", () => collector.cancel());
  handle("frame", (...v) => collector.frame(v));
  handle("guard-event", (reason, serial) =>
    collector.guardEvent(reason, serial),
  );
  handle("report", () => {
    if (!collector.result) throw new Error("report_not_ready");
    const value = validateReport(collector.result);
    const destination = path.join(
      directory,
      "native-commissioning-report.json",
    );
    const staged = `${destination}.staged`;
    try {
      fs.writeFileSync(staged, `${JSON.stringify(value, null, 2)}\n`, {
        mode: 0o600,
      });
      fs.renameSync(staged, destination);
    } finally {
      fs.rmSync(staged, { force: true });
    }
    emit("notice", "report_exported");
  });
  const timer = interval(() => {
    emit("heartbeat");
    collector.tick();
  }, 250);
  return {
    collector,
    stop() {
      emit("stop", ++collector.serial, "collector_stopped");
      clear(timer);
    },
  };
}
module.exports = {
  readArtifact,
  CommissioningCollector,
  createCommissioningRuntime,
};
if (require.main === module) {
  const runtime = createCommissioningRuntime({ maxApi: require("max-api") });
  process.once("SIGTERM", () => {
    runtime.stop();
    process.exit(0);
  });
  process.once("SIGINT", () => {
    runtime.stop();
    process.exit(0);
  });
}
