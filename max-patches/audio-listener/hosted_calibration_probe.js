/* global module, Task, outlet, arrayfromargs, autowatch:writable, inlets:writable, outlets:writable */
/* eslint no-unused-vars: "off" -- Max invokes message handlers by name. */
// Engineering-only descriptor collection; no audio, file access or readiness certificate.
function HostedCalibrationCollector(options) {
  this.now = options.now;
  this.emit = options.emit;
  this.control = options.control;
  this.state = "idle";
  this.result = null;
}

HostedCalibrationCollector.prototype.event = function (stage) {
  var previous = this.result.events;
  var event = {
    stage: stage,
    eventId: this.result.traceId + ":" + previous.length,
    traceId: this.result.traceId,
    correlationId: this.result.traceId,
    causationId: previous.length
      ? previous[previous.length - 1].eventId
      : this.result.traceId,
    elapsedMs: Math.max(0, this.now() - this.startedAt),
    frames: this.result.frames.length,
  };
  previous.push(event);
};

HostedCalibrationCollector.prototype.start = function (ownership, traceId) {
  if (
    ownership !== "runner-owned" ||
    typeof traceId !== "string" ||
    traceId.length !== 36 ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
      traceId
    )
  )
    throw new Error("runner_ownership_and_trace_required");
  if (this.state === "waiting-reset" || this.state === "collecting")
    throw new Error("collection_already_active");
  this.startedAt = this.now();
  this.result = {
    schema: "hosted-native-capture/v1",
    calibrationOnly: true,
    productionReady: false,
    nativeTiming: "UNVERIFIED",
    traceId: traceId,
    sampleRate: 48000,
    envelopeWindowSamples: 4800,
    maxFrames: 100,
    outcome: "pending",
    reason: "pending",
    sourceRequestedAtMs: null,
    events: [],
    frames: [],
  };
  this.event("queued");
  this.state = "waiting-reset";
  this.event("started");
  this.control("analysis", 1, 1, 48000);
};

HostedCalibrationCollector.prototype.finish = function (outcome, reason) {
  if (this.state !== "waiting-reset" && this.state !== "collecting") return;
  this.state = "done";
  this.result.outcome = outcome;
  this.result.reason = reason;
  this.control("analysis", 0, 1, 48000);
  this.event(outcome === "collected" ? "completed" : outcome);
};

HostedCalibrationCollector.prototype.frame = function (values) {
  if (this.state !== "waiting-reset" && this.state !== "collecting") return;
  if (
    !Array.isArray(values) ||
    values.length !== 7 ||
    values.some(function (v) {
      return typeof v !== "number" || !isFinite(v) || v < 0;
    }) ||
    values[0] > 64 ||
    values[1] > 64 ||
    values[2] > values[0] + 0.000001 ||
    values[3] > values[1] + 0.000001 ||
    values[4] > 9007199254740991 ||
    Math.floor(values[4]) !== values[4] ||
    values[5] > 24000 ||
    values[6] > 1e20
  ) {
    this.finish("failed", "invalid_native_frame");
    return;
  }
  var sample = values[4];
  if (this.state === "waiting-reset") {
    if (sample !== 0) return;
    this.state = "collecting";
    return;
  }
  var points = this.result.frames;
  var previous = points.length ? points[points.length - 1][4] : 0;
  if (sample === previous) return;
  if (sample !== previous + 4800) {
    this.finish("failed", "descriptor_gap_or_reset");
    return;
  }
  if (
    !points.length &&
    (values[0] !== 0 ||
      values[1] !== 0 ||
      values[2] !== 0 ||
      values[3] !== 0 ||
      values[5] !== 0 ||
      values[6] !== 0)
  ) {
    this.finish("failed", "baseline_not_silent");
    return;
  }
  points.push(values.slice());
  if (this.result.sourceRequestedAtMs === null) {
    this.result.sourceRequestedAtMs = Math.max(0, this.now() - this.startedAt);
    this.control("source", "call", "fire");
  }
  if (points.length % 25 === 0) this.event("progress");
  if (points.length === this.result.maxFrames)
    this.finish("collected", "bounded_window_end");
};

HostedCalibrationCollector.prototype.tick = function () {
  if (
    (this.state === "waiting-reset" || this.state === "collecting") &&
    this.now() - this.startedAt >= 12000
  )
    this.finish(
      "failed",
      this.state === "waiting-reset" ? "reset_timeout" : "collection_timeout"
    );
};

HostedCalibrationCollector.prototype.cancel = function () {
  this.finish("cancelled", "operator_cancelled");
};

HostedCalibrationCollector.prototype.dump = function () {
  if (this.state !== "done") throw new Error("report_not_ready");
  var report = this.result;
  var header = {};
  Object.keys(report).forEach(function (key) {
    if (key !== "frames") header[key] = report[key];
  });
  header.frameCount = report.frames.length;
  header.chunkCount = Math.ceil(report.frames.length / 8);
  this.emit("header", JSON.stringify(header));
  for (var index = 0; index < header.chunkCount; index++)
    this.emit(
      "chunk",
      JSON.stringify({
        traceId: report.traceId,
        index: index,
        frames: report.frames.slice(index * 8, index * 8 + 8),
      })
    );
};

if (typeof module !== "undefined") {
  module.exports = { HostedCalibrationCollector: HostedCalibrationCollector };
}

if (typeof outlet === "function") {
  autowatch = 0;
  inlets = 1;
  outlets = 3;
  var hostedCollector = new HostedCalibrationCollector({
    now: function () {
      return Date.now();
    },
    emit: function (kind, value) {
      // Max message parsing must not reinterpret JSON quotes or commas.
      var encoded = "";
      for (var index = 0; index < value.length; index++)
        encoded += ("0" + value.charCodeAt(index).toString(16)).slice(-2);
      outlet(0, kind, encoded);
    },
    control: function (kind, a, b, c) {
      if (kind === "analysis") outlet(1, kind, a, b, c);
      else outlet(2, a, b);
    },
  });
  var hostedTimer = new Task(function () {
    hostedCollector.tick();
  }, this);
  hostedTimer.interval = 100;
  hostedTimer.repeat();
}

function start(ownership, traceId) {
  try {
    hostedCollector.start(ownership, traceId);
  } catch (error) {
    outlet(0, "rejected", "invalid_start_or_active_collection");
  }
}
function list() {
  hostedCollector.frame(arrayfromargs(arguments));
}
function cancel() {
  hostedCollector.cancel();
}
function dump() {
  try {
    hostedCollector.dump();
  } catch (error) {
    outlet(0, "rejected", "report_not_ready");
  }
}
function notifydeleted() {
  hostedCollector.cancel();
  hostedTimer.cancel();
}
