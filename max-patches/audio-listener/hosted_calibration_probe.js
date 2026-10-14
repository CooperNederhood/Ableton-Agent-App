/* global module, Task, outlet, arrayfromargs, autowatch:writable, inlets:writable, outlets:writable */
/* eslint no-unused-vars: "off" -- Max invokes message handlers by name. */
// Engineering-only descriptor collection; no audio, file access or readiness certificate.
function HostedCalibrationCollector(options) {
  this.now = options.now;
  this.emit = options.emit;
  this.control = options.control;
  this.state = "idle";
  this.result = null;
  this.highestNativeEpoch = 0;
}

HostedCalibrationCollector.prototype.event = function (stage) {
  var previous = this.result.events;
  var event = {
    stage: stage,
    eventId:
      this.result.traceId +
      (this.synchronized ? ":native:" + this.expectedEpoch : "") +
      ":" +
      previous.length,
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
  this.begin(ownership, traceId);
};

HostedCalibrationCollector.prototype.startSynchronized = function (
  ownership,
  traceId,
  epoch
) {
  if (
    typeof epoch !== "number" ||
    !isFinite(epoch) ||
    Math.floor(epoch) !== epoch ||
    epoch <= this.highestNativeEpoch ||
    epoch > 1000000
  )
    throw new Error("invalid_native_epoch");
  this.begin(ownership, traceId, epoch);
  this.highestNativeEpoch = epoch;
};

HostedCalibrationCollector.prototype.begin = function (
  ownership,
  traceId,
  epoch
) {
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
  this.synchronized = epoch !== undefined;
  this.expectedEpoch = epoch;
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
  if (this.synchronized) {
    this.result.schema = "hosted-native-envelope/v1";
    this.result.scope = "signal-preroll-envelope-only";
    this.result.nativeEpoch = epoch;
    this.result.originClock = null;
    this.result.nativeMarker = null;
  }
  this.event("queued");
  this.state = "waiting-reset";
  this.event("started");
  if (this.synchronized) {
    this.control("native", "cancel", 0);
    this.control("native", "epoch", epoch);
  } else this.control("analysis", 1, 1, 48000);
};

HostedCalibrationCollector.prototype.finish = function (outcome, reason) {
  if (this.state !== "waiting-reset" && this.state !== "collecting") return;
  this.state = "done";
  this.result.outcome = outcome;
  this.result.reason = reason;
  if (this.synchronized) this.control("native", "epoch", 0);
  else this.control("analysis", 0, 1, 48000);
  this.event(outcome === "collected" ? "completed" : outcome);
};

HostedCalibrationCollector.prototype.frame = function (values) {
  if (!this.synchronized) {
    this.consumeFrame(values);
    return;
  }
  if (this.state !== "waiting-reset" && this.state !== "collecting") return;
  if (
    !Array.isArray(values) ||
    values.length !== 13 ||
    values.some(function (v) {
      return typeof v !== "number" || !isFinite(v);
    }) ||
    values.slice(0, 9).some(function (v) {
      return Math.floor(v) !== v || v < -1 || v > 1000000;
    }) ||
    values[0] < 0 ||
    values[0] > 480000 ||
    values[1] < 0 ||
    values[4] < 0 ||
    values[4] > 9 ||
    values[5] < 0 ||
    values[5] > 11 ||
    values[6] < 0 ||
    values[6] > 1
  ) {
    this.finish("failed", "invalid_native_packet");
    return;
  }
  if (this.state === "waiting-reset" && values[1] < this.expectedEpoch) return;
  if (values[1] !== this.expectedEpoch) {
    this.finish("failed", "native_epoch_changed");
    return;
  }
  this.result.nativeMarker = values.slice(1, 9);
  if (values[5] !== 0) {
    this.finish(
      values[5] === 4 ? "cancelled" : "failed",
      "native_rejected_" + values[5]
    );
    return;
  }
  if (this.state === "waiting-reset" && values[2] >= 0) {
    this.finish("failed", "launch_before_acknowledgement");
    return;
  }
  if (values[2] >= 0) {
    var origin = values[2] - values[7];
    if (
      values[7] < 0 ||
      values[7] > 64 ||
      origin < 0 ||
      (this.result.originClock !== null && this.result.originClock !== origin)
    ) {
      this.finish("failed", "invalid_native_boundary");
      return;
    }
    if (this.result.originClock === null) {
      this.result.originClock = origin;
      this.event("native-launched");
    }
  }
  if (this.state === "waiting-reset") {
    if (
      values[0] !== 0 ||
      values[2] !== -1 ||
      values[3] !== -1 ||
      values[4] !== 0 ||
      values[6] !== 0 ||
      values[7] !== -1 ||
      values[8] !== -1 ||
      values.slice(9).some(function (v) {
        return v !== 0;
      })
    ) {
      this.finish("failed", "native_arm_not_ready");
      return;
    }
    this.state = "collecting";
    this.event("armed");
    this.result.sourceRequestedAtMs = Math.max(0, this.now() - this.startedAt);
    this.event("source-start-requested");
    this.control("source", "call", "start_playing");
    return;
  }
  this.consumeFrame([
    values[9],
    values[10],
    values[11],
    values[12],
    values[0],
    0,
    0,
  ]);
};

HostedCalibrationCollector.prototype.consumeFrame = function (values) {
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
  if (sample === previous) {
    if (
      this.synchronized &&
      points.length &&
      values.some(function (v, i) {
        return v !== points[points.length - 1][i];
      })
    )
      this.finish("failed", "changed_native_hold");
    return;
  }
  if (sample !== previous + 4800) {
    this.finish("failed", "descriptor_gap_or_reset");
    return;
  }
  if (
    !this.synchronized &&
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
  if (points.length === this.result.maxFrames) {
    if (this.synchronized && this.result.originClock === null)
      this.finish("failed", "missing_native_boundary");
    else this.finish("collected", "bounded_window_end");
  }
};

HostedCalibrationCollector.prototype.tick = function () {
  if (
    this.synchronized &&
    (this.state === "waiting-reset" || this.state === "collecting")
  ) {
    var elapsed = this.now() - this.startedAt;
    var sinceSource = this.result.sourceRequestedAtMs;
    if (elapsed - (sinceSource === null ? 0 : sinceSource) >= 12000)
      this.finish(
        "failed",
        sinceSource === null ? "native_arm_timeout" : "collection_timeout"
      );
    return;
  }
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
  if (
    this.synchronized &&
    (this.state === "waiting-reset" || this.state === "collecting")
  )
    this.control("native", "cancel", 1);
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
      else if (kind === "native") outlet(1, a, b);
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
function start_synchronized(ownership, traceId, epoch) {
  try {
    hostedCollector.startSynchronized(ownership, traceId, epoch);
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
