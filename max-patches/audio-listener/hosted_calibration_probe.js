/* global module, Task, outlet, arrayfromargs, autowatch:writable, inlets:writable, outlets:writable */
/* eslint no-unused-vars: "off" -- Max invokes message handlers by name. */
// Engineering-only descriptor collection; no audio, file access or readiness certificate.
function checkEngineeringCaller(ownership, traceId) {
  if (
    ownership !== "runner-owned" ||
    typeof traceId !== "string" ||
    traceId.length !== 36 ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
      traceId
    )
  )
    throw new Error("runner_ownership_and_trace_required");
}

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
      (this.eventNamespace
        ? ":" + this.eventNamespace
        : this.synchronized
          ? ":native:" + this.expectedEpoch
          : "") +
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
  checkEngineeringCaller(ownership, traceId);
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
    values[5] > 12 ||
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
        schema: report.schema,
        traceId: report.traceId,
        index: index,
        frames: report.frames.slice(index * 8, index * 8 + 8),
      })
    );
};

function HostClockCollector(options) {
  this.now = options.now;
  this.emit = options.emit;
  this.control = options.control;
  this.state = "idle";
}
HostClockCollector.prototype.event = HostedCalibrationCollector.prototype.event;
HostClockCollector.prototype.dump = HostedCalibrationCollector.prototype.dump;

HostClockCollector.prototype.start = function (ownership, traceId) {
  checkEngineeringCaller(ownership, traceId);
  if (this.state === "collecting") throw new Error("collection_already_active");
  this.startedAt = this.now();
  this.pendingHost = null;
  this.pendingClock = null;
  this.result = {
    schema: "host-clock-probe/v1",
    calibrationOnly: true,
    productionReady: false,
    nativeTiming: "UNVERIFIED",
    scope: "bracketed_host_counter_and_phase_only",
    traceId: traceId,
    maxFrames: 32,
    rejectedReads: 0,
    dsp: null,
    clockOffsetSamples: null,
    phaseLagSamples: null,
    hostBeatZeroSample: null,
    outcome: "pending",
    reason: "pending",
    events: [],
    frames: [],
  };
  this.event("queued");
  this.state = "collecting";
  this.event("started");
  this.control("clock-poll", 1);
};
HostClockCollector.prototype.finish = function (outcome, reason) {
  if (this.state !== "collecting") return;
  this.state = "done";
  this.result.outcome = outcome;
  this.result.reason = reason;
  this.pendingHost = null;
  this.pendingClock = null;
  this.control("clock-poll", 0);
  this.event(outcome === "collected" ? "completed" : outcome);
};
HostClockCollector.prototype.dsp = function (values) {
  if (this.state !== "collecting") return;
  if (
    Array.isArray(values) &&
    values.length === 3 &&
    values.every(function (v) {
      return typeof v === "number" && isFinite(v) && v >= 0;
    }) &&
    values[0] <= 1 &&
    values[1] <= 384000 &&
    values[2] <= 65536
  )
    this.result.dsp = values.slice();
  if (
    !Array.isArray(values) ||
    values.length !== 3 ||
    values[0] !== 1 ||
    values[1] !== 48000 ||
    values[2] !== 64
  ) {
    this.finish("failed", "unsupported_dsp");
    return;
  }
};
HostClockCollector.prototype.pre = function (values) {
  if (this.state !== "collecting") return;
  this.pendingClock = null;
  if (!this.validHost(values)) {
    this.finish("failed", "invalid_host_packet");
    return;
  }
  this.pendingHost = values.slice();
};
HostClockCollector.prototype.validHost = function (values) {
  return (
    Array.isArray(values) &&
    values.length === 4 &&
    values.every(function (v) {
      return typeof v === "number" && isFinite(v) && v >= 0;
    }) &&
    (values[0] === 0 || values[0] === 1) &&
    values[1] <= 1000000000 &&
    Math.floor(values[2]) === values[2] &&
    values[2] <= 9007199254740991 &&
    Math.floor(values[3]) === values[3] &&
    values[3] <= 2147483647 &&
    (values[3] & 19) === 19
  );
};
HostClockCollector.prototype.clock = function (values) {
  if (this.state !== "collecting") return;
  if (
    !Array.isArray(values) ||
    values.length !== 3 ||
    !values.every(function (v) {
      return typeof v === "number" && isFinite(v) && v >= 0;
    }) ||
    Math.floor(values[0]) !== values[0] ||
    Math.floor(values[2]) !== values[2] ||
    values[0] > 9007199254740991 ||
    values[2] > 9007199254740991 ||
    values[1] > 1
  ) {
    this.finish("failed", "invalid_clock_packet");
    return;
  }
  this.pendingClock = values.slice();
};
HostClockCollector.prototype.post = function (values) {
  if (this.state !== "collecting") return;
  if (!this.validHost(values)) {
    this.finish("failed", "invalid_host_packet");
    return;
  }
  if (!this.result.dsp) {
    this.finish("failed", "dsp_not_observed");
    return;
  }
  var pre = this.pendingHost;
  var clock = this.pendingClock;
  this.pendingHost = null;
  this.pendingClock = null;
  if (
    !pre ||
    !clock ||
    clock[0] !== clock[2] ||
    pre.some(function (v, i) {
      return v !== values[i];
    })
  ) {
    this.result.rejectedReads++;
    if (this.result.rejectedReads >= 32)
      this.finish("failed", "unstable_bracketed_read");
    return;
  }
  var points = this.result.frames;
  var previous = points.length ? points[points.length - 1] : null;
  if (previous && clock[0] <= previous[4]) {
    this.result.rejectedReads++;
    if (this.result.rejectedReads >= 32)
      this.finish("failed", "clock_not_advancing");
    return;
  }
  var offset = pre[2] - clock[0];
  var lag = pre[0]
    ? (Math.round((pre[1] - Math.floor(pre[1])) * 24000) -
        Math.round(clock[1] * 24000) +
        24000) %
      24000
    : null;
  var beatZero = pre[0] ? pre[2] - Math.round(pre[1] * 24000) : null;
  if (previous) {
    if (previous[0] !== pre[0]) {
      this.finish("failed", "transport_changed");
      return;
    }
    if (offset !== this.result.clockOffsetSamples) {
      this.finish("failed", "clock_offset_changed");
      return;
    }
    if (
      lag !== this.result.phaseLagSamples ||
      beatZero !== this.result.hostBeatZeroSample
    ) {
      this.finish("failed", "host_phase_mapping_changed");
      return;
    }
  }
  this.result.clockOffsetSamples = offset;
  this.result.phaseLagSamples = lag;
  this.result.hostBeatZeroSample = beatZero;
  points.push(pre.concat(clock, values));
  if (points.length % 8 === 0) this.event("progress");
  if (points.length === this.result.maxFrames)
    this.finish("collected", "bounded_bracketed_window_end");
};
HostClockCollector.prototype.tick = function () {
  if (this.state === "collecting" && this.now() - this.startedAt >= 2000)
    this.finish("failed", "host_clock_timeout");
};
HostClockCollector.prototype.cancel = function () {
  this.finish("cancelled", "operator_cancelled");
};

function TaggedSpectrumCollector(options) {
  this.now = options.now;
  this.emit = options.emit;
  this.state = "idle";
  this.eventNamespace = "fft";
}
TaggedSpectrumCollector.prototype.event =
  HostedCalibrationCollector.prototype.event;
TaggedSpectrumCollector.prototype.dump =
  HostedCalibrationCollector.prototype.dump;
TaggedSpectrumCollector.prototype.start = function (ownership, traceId) {
  checkEngineeringCaller(ownership, traceId);
  if (this.state === "collecting") throw new Error("collection_already_active");
  this.startedAt = this.now();
  this.result = {
    schema: "tagged-native-spectrum/v1",
    calibrationOnly: true,
    productionReady: false,
    nativeTiming: "UNVERIFIED",
    scope: "continuous_counter_tagged_fft_only",
    traceId: traceId,
    maxFrames: 64,
    initialInvalidFrames: null,
    lastPacket: null,
    rejectedReads: 0,
    outcome: "pending",
    reason: "pending",
    events: [],
    frames: [],
  };
  this.event("queued");
  this.state = "collecting";
  this.event("started");
};
TaggedSpectrumCollector.prototype.finish = function (outcome, reason) {
  if (this.state !== "collecting") return;
  this.state = "done";
  this.result.outcome = outcome;
  this.result.reason = reason;
  this.event(outcome === "collected" ? "completed" : outcome);
};
TaggedSpectrumCollector.prototype.frame = function (values) {
  if (this.state !== "collecting") return;
  if (
    !Array.isArray(values) ||
    values.length !== 6 ||
    values.some(function (v) {
      return typeof v !== "number" || !isFinite(v);
    }) ||
    [0, 3, 4, 5].some(function (i) {
      return (
        Math.floor(values[i]) !== values[i] ||
        values[i] < -1 ||
        values[i] > 9007199254740991
      );
    }) ||
    values[1] < 0 ||
    values[1] > 24000 ||
    values[2] < 0 ||
    values[2] > 1e20 ||
    values[5] < 0 ||
    values[5] > 4096
  ) {
    this.finish("failed", "invalid_spectral_packet");
    return;
  }
  if (values[0] !== values[4]) {
    this.result.rejectedReads++;
    if (this.result.rejectedReads >= 32)
      this.finish("failed", "unstable_spectral_read");
    return;
  }
  var points = this.result.frames;
  this.result.lastPacket = values.slice();
  if (values[0] === -1 && values[3] === -1 && !points.length) return;
  if (values[3] < 0 || values[0] - values[3] !== 2048) {
    this.finish("failed", "invalid_spectral_window");
    return;
  }
  if (this.result.initialInvalidFrames === null)
    this.result.initialInvalidFrames = values[5];
  if (values[5] !== this.result.initialInvalidFrames) {
    this.finish("failed", "spectral_clock_discontinuity");
    return;
  }
  var previous = points.length ? points[points.length - 1] : null;
  if (previous && values[0] === previous[0]) {
    if (
      values.some(function (v, i) {
        return v !== previous[i];
      })
    )
      this.finish("failed", "changed_spectral_hold");
    return;
  }
  if (previous && values[0] !== previous[0] + 2048) {
    this.finish("failed", "spectral_frame_gap_or_reset");
    return;
  }
  points.push(values.slice());
  if (points.length % 16 === 0) this.event("progress");
  if (points.length === this.result.maxFrames)
    this.finish("collected", "bounded_spectral_window_end");
};
TaggedSpectrumCollector.prototype.tick = function () {
  if (this.state === "collecting" && this.now() - this.startedAt >= 5000)
    this.finish("failed", "spectral_timeout");
};
TaggedSpectrumCollector.prototype.cancel = function () {
  this.finish("cancelled", "operator_cancelled");
};

if (typeof module !== "undefined") {
  module.exports = {
    HostedCalibrationCollector: HostedCalibrationCollector,
    HostClockCollector: HostClockCollector,
    TaggedSpectrumCollector: TaggedSpectrumCollector,
  };
}

if (typeof outlet === "function") {
  autowatch = 0;
  inlets = 1;
  outlets = 3;
  var hostedOptions = {
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
      else if (kind === "clock-poll") outlet(1, a);
      else outlet(2, a, b);
    },
  };
  var hostedCollector = new HostedCalibrationCollector(hostedOptions);
  var hostClockCollector = new HostClockCollector(hostedOptions);
  var taggedSpectrumCollector = new TaggedSpectrumCollector(hostedOptions);
  var hostedTimer = new Task(function () {
    hostedCollector.tick();
    hostClockCollector.tick();
    taggedSpectrumCollector.tick();
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
  hostClockCollector.cancel();
  taggedSpectrumCollector.cancel();
  hostedTimer.cancel();
}

function anchor_start(ownership, traceId) {
  try {
    hostClockCollector.start(ownership, traceId);
  } catch (error) {
    outlet(0, "rejected", "invalid_start_or_active_collection");
  }
}
function anchor_pre() {
  hostClockCollector.pre(arrayfromargs(arguments));
}
function anchor_dsp() {
  hostClockCollector.dsp(arrayfromargs(arguments));
}
function anchor_clock() {
  hostClockCollector.clock(arrayfromargs(arguments));
}
function anchor_post() {
  hostClockCollector.post(arrayfromargs(arguments));
}
function anchor_cancel() {
  hostClockCollector.cancel();
}
function anchor_dump() {
  try {
    hostClockCollector.dump();
  } catch (error) {
    outlet(0, "rejected", "report_not_ready");
  }
}
function combined_start(ownership, traceId, epoch) {
  try {
    checkEngineeringCaller(ownership, traceId);
    if (taggedSpectrumCollector.state === "collecting")
      throw new Error("collection_already_active");
    hostedCollector.startSynchronized(ownership, traceId, epoch);
    taggedSpectrumCollector.start(ownership, traceId);
  } catch (error) {
    outlet(0, "rejected", "invalid_start_or_active_collection");
  }
}
function spectrum_frame() {
  taggedSpectrumCollector.frame(arrayfromargs(arguments));
}
function spectrum_start(ownership, traceId) {
  try {
    taggedSpectrumCollector.start(ownership, traceId);
  } catch (error) {
    outlet(0, "rejected", "invalid_start_or_active_collection");
  }
}
function spectrum_dump() {
  try {
    taggedSpectrumCollector.dump();
  } catch (error) {
    outlet(0, "rejected", "spectral_report_not_ready");
  }
}
function combined_dump() {
  dump();
  spectrum_dump();
}
function combined_cancel() {
  hostedCollector.cancel();
  taggedSpectrumCollector.cancel();
}
function reload_native() {
  if (
    hostedCollector.state === "waiting-reset" ||
    hostedCollector.state === "collecting" ||
    taggedSpectrumCollector.state === "collecting"
  ) {
    outlet(0, "rejected", "native_collection_active");
    return;
  }
  outlet(0, "rejected", "native_probe_recreation_required");
}
