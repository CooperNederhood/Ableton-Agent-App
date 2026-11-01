/* global module, require, include, AudioListenerMeasurements, outlet, post, jsarguments, arrayfromargs, inlets:writable, outlets:writable */
/* eslint no-unused-vars: "off" -- Max invokes message handlers by name. */
// Metric pipeline only: passive ABI2 clock and retained FFT, never coupled
// envelope or latest-value capture. Musical envelopes use their separate IO.

var RETENTION_REJECTION_REASONS = Object.freeze([
  "reentrant_poll",
  "invalid_arity",
  "invalid_numeric",
  "invalid_abi",
  "invalid_owner_reset",
  "invalid_uninitialized_readback",
  "invalid_header_bounds",
  "torn_readback",
  "unread_capacity_overflow",
  "invalid_dsp_control",
  "invalid_sequence_order",
  "immutable_slot_changed",
  "slot_disappeared",
  "invalid_slot_owner",
  "sequence_exhausted",
  "consumer_failed",
  "consumer_rejected",
  "caller_failed",
]);
var RETENTION_REJECTION_MARKERS = Object.freeze([
  "invalid:nan",
  "invalid:positive-infinity",
  "invalid:negative-infinity",
  "invalid:string",
  "invalid:null",
  "invalid:undefined",
  "invalid:type",
]);
var RETENTION_REJECTION_LENGTH = 139;
var IO_REJECTION_LENGTH = 49;
var IO_REJECTION_CHECKS = Object.freeze([
  "packet-kind",
  "packet-numeric",
  "spectrum-diagnostics-shape",
  "spectrum-diagnostics-numeric",
  "reader-failed",
  "begin-generation",
  "begin-retention-control",
  "begin-epoch-monotonic",
  "anchor-pre",
  "anchor-clock",
  "anchor-post",
  "generation-current",
  "stop-quiescence",
]);
var RETENTION_SNAPSHOT_STATUSES = Object.freeze([
  "waiting",
  "settling",
  "accepted",
  "unstable",
  "stale",
  "failed",
]);
var RETENTION_SNAPSHOT_LENGTH = 140;
var SPECTRUM_CLEANUP_REASONS = Object.freeze([
  "none",
  "waiting",
  "deadline",
  "invalid_readback",
  "counter_incoherent",
  "counter_regression",
  "owner_mismatch",
  "disabled_readback_invalid",
  "unconfirmed_release",
  "control_failed",
  "event_delivery_failed",
  "host_clock_invalid",
  "host_clock_failed",
  "deleted",
  "invalid_stop_control",
  "watermark_acquired",
]);
function spectrumCleanupCounter(value) {
  return (
    typeof value === "number" &&
    isFinite(value) &&
    Math.floor(value) === value &&
    value >= 0 &&
    value <= 17592186044415
  );
}
function spectrumCleanupHostTime(value) {
  return (
    typeof value === "number" &&
    isFinite(value) &&
    value >= 0 &&
    value <= 9007199254740991
  );
}
function spectrumExecutedReceipt(row, before, after, hostTime) {
  return Object.freeze({
    raw: Object.freeze(row),
    counterBefore: before,
    counterAfter: after,
    nativeSourceCounter: before,
    observedHostReceiptMs: hostTime,
  });
}

function decodeRetentionSnapshot(values) {
  if (
    !Array.isArray(values) ||
    values.length !== RETENTION_SNAPSHOT_LENGTH ||
    !spectrumCleanupCounter(values[139])
  )
    return null;
  var decoded = decodeRetentionRejection(
    values.slice(0, 139),
    RETENTION_SNAPSHOT_STATUSES
  );
  return decoded
    ? {
        family: 2,
        nativeEpoch: decoded.nativeEpoch,
        status: decoded.readerReason,
        readbacks: decoded.readerReadbacks,
        dropped: values[139],
      }
    : null;
}

function decodeIORejection(values) {
  if (!Array.isArray(values) || values.length !== IO_REJECTION_LENGTH)
    return null;
  if (
    (values[0] !== 0 && values[0] !== 1) ||
    !spectrumCleanupCounter(values[1]) ||
    values[1] >= IO_REJECTION_CHECKS.length ||
    (values[2] !== -1 &&
      (!spectrumCleanupCounter(values[2]) ||
        values[2] < 1 ||
        values[2] > 1000000)) ||
    (values[3] !== 0 && values[3] !== 1)
  )
    return null;
  var input = decodeDiagnosticRow(values, 4, false);
  return input
    ? {
        mode: values[0] === 0 ? "clock" : "spectrum",
        check: IO_REJECTION_CHECKS[values[1]],
        nativeEpoch: values[2] === -1 ? null : values[2],
        generationMatches: values[3] === 1,
        input: {
          length: input.length === -1 ? null : input.length,
          cells: input.cells,
          truncated: input.length > 22,
        },
      }
    : null;
}

function retentionRejectionRow(row) {
  var length = Array.isArray(row) ? row.length : -1;
  var result = [length];
  for (var index = 0; index < 22; index++) {
    var tag = 8,
      number = 0;
    if (index < length) {
      var value = row[index];
      if (typeof value === "number") {
        if (isFinite(value)) {
          tag = 0;
          number = value;
        } else tag = value !== value ? 1 : value > 0 ? 2 : 3;
      } else
        tag =
          typeof value === "string"
            ? 4
            : value === null
              ? 5
              : typeof value === "undefined"
                ? 6
                : 7;
    }
    result.push(tag, number);
  }
  return result;
}

function decodeDiagnosticRow(values, offset, unused) {
  var length = values[offset],
    cells = [];
  if (!spectrumCleanupCounter(length) && length !== -1 && length !== -2)
    return null;
  if (unused ? length !== -2 : length < -1 || length > 4294967295) return null;
  for (var index = 0; index < 22; index++) {
    var tag = values[offset + 1 + index * 2],
      number = values[offset + 2 + index * 2];
    if (typeof number !== "number" || !isFinite(number)) return null;
    if (unused || index >= length) {
      if (tag !== 8 || number !== 0) return null;
    } else {
      if (
        !spectrumCleanupCounter(tag) ||
        tag > 7 ||
        (tag !== 0 && number !== 0)
      )
        return null;
      cells.push(tag === 0 ? number : RETENTION_REJECTION_MARKERS[tag - 1]);
    }
  }
  return { length: length, cells: cells };
}
function decodeRetentionRejection(values, reasons) {
  reasons = reasons || RETENTION_REJECTION_REASONS;
  if (
    !Array.isArray(values) ||
    values.length !== RETENTION_REJECTION_LENGTH ||
    values[0] !== 2 ||
    !spectrumCleanupCounter(values[1]) ||
    values[1] < 1 ||
    values[1] > reasons.length ||
    !spectrumCleanupCounter(values[2]) ||
    values[2] < 1 ||
    values[2] > 1000000 ||
    !spectrumCleanupCounter(values[3]) ||
    values[3] < 1 ||
    values[3] > 3
  )
    return null;
  var rows = [];
  for (var index = 0; index < 3; index++) {
    var row = decodeDiagnosticRow(values, 4 + index * 45, index >= values[3]);
    if (!row) return null;
    if (index < values[3]) rows.push(row);
  }
  return {
    family: 2,
    nativeEpoch: values[2],
    readerReason: reasons[values[1] - 1],
    readerReadbacks: rows,
  };
}

function NativeMessageIO(mode, send, control, diagnostic, options) {
  if (mode !== "clock" && mode !== "spectrum") {
    throw new Error("invalid_native_io_mode");
  }
  this.mode = mode;
  if (options === undefined) options = {};
  if (
    arguments.length !== 5 ||
    !options ||
    typeof options !== "object" ||
    Array.isArray(options) ||
    Object.keys(options).some(function (key) {
      return key !== "now";
    }) ||
    (options.now !== undefined && typeof options.now !== "function") ||
    typeof send !== "function" ||
    typeof control !== "function" ||
    typeof diagnostic !== "function"
  )
    throw new Error("invalid_metric_io_options");
  this.spectrumCleanupState = null;
  this.spectrumCounterHighWater = -1;
  this.spectrumAcquisition = null;
  this.spectrumGuardRelease = false;
  this.spectrumInputFailure = false;
  this.spectrumInputReason = null;
  this.retentionAPI = null;
  if (mode === "spectrum") {
    if (typeof outlet !== "function" && typeof require === "function")
      this.retentionAPI = require("./audio_listener_measurements.js");
    else {
      if (
        typeof AudioListenerMeasurements === "undefined" &&
        typeof include === "function"
      )
        include("audio_listener_measurements.js");
      if (typeof AudioListenerMeasurements !== "undefined")
        this.retentionAPI = AudioListenerMeasurements;
    }
    if (
      !this.retentionAPI ||
      typeof this.retentionAPI.createReader !== "function"
    )
      throw new Error("missing_measurement_reader");
  }
  this.retentionNow =
    options.now ||
    function () {
      return new Date().getTime();
    };
  this.retentionReader = null;
  this.retentionEpoch = null;
  this.retentionEpochHighWater = 0;
  this.retentionQueue = null;
  this.retentionProgressAt = -250;
  this.retentionUnstableAt = -250;
  this.retentionForwarding = false;
  this.retentionReadySent = false;
  this.retentionReadbacks = [];
  this.retentionSnapshotAt = -Infinity;
  this.retentionSnapshotDrops = 0;
  this.retentionSnapshotDropReported = false;
  this.retentionPolling = false;
  this.retentionMetricInvalid = false;
  this.retentionRejectionSent = false;
  this.stopping = false;
  this.stopControlsSent = false;
  this.send = function (packet) {
    return send(Object.freeze(packet));
  };
  this.control = control;
  this.diagnostic = diagnostic;
  this.generation = null;
  this.lastGeneration = null;
  this.pre = null;
  this.clock = null;
  this.invalidReported = false;
  this.metadata = {};
}

NativeMessageIO.prototype.validNumbers = function (values, length) {
  if (!Array.isArray(values) || values.length !== length) return false;
  for (var i = 0; i < length; i++) {
    if (
      typeof values[i] !== "number" ||
      !isFinite(values[i]) ||
      Math.abs(values[i]) > 9007199254740991
    )
      return false;
  }
  return true;
};

NativeMessageIO.prototype.fail = function (check, values) {
  if (IO_REJECTION_CHECKS.indexOf(check) < 0)
    throw new Error("invalid_io_rejection_check");
  if (!this.invalidReported) {
    this.invalidReported = true;
    var generation = this.generation;
    if (!generation) this.diagnostic("native_io_invalid_command");
    else {
      try {
        if (!this.retentionRejectionSent)
          this.reportRejection(generation, check, values);
      } finally {
        if (this.generation === generation)
          this.send(["native", generation, "ioError", 1]);
      }
    }
  }
  return false;
};

NativeMessageIO.prototype.reportRejection = function (
  generation,
  check,
  values
) {
  if (
    typeof generation !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      generation
    )
  )
    return false;
  var code = IO_REJECTION_CHECKS.indexOf(check);
  if (code < 0) throw new Error("invalid_io_rejection_check");
  var key = generation + "_" + code;
  if (this.lastRejectionKey === key) return false;
  this.lastRejectionKey = key;
  var packet = ["native", generation, "io-rejection"].concat(
    [
      this.mode === "clock" ? 0 : 1,
      code,
      this.retentionEpoch === null ? -1 : this.retentionEpoch,
      generation === this.generation ? 1 : 0,
    ],
    retentionRejectionRow(values)
  );
  try {
    return this.send(Object.freeze(packet)) !== false;
  } catch (_) {
    this.retentionSnapshotDrops = Math.min(
      1000000,
      this.retentionSnapshotDrops + 1
    );
    this.diagnostic("native_io_rejection_delivery_failed");
    return false;
  }
};

NativeMessageIO.prototype.packet = function (type, values) {
  if (!this.generation) return false;
  var widths =
    this.mode === "clock"
      ? {
          dsp: 3,
          tempo: 1,
          clock: 11,
          "abi-clock": 1,
          "clock-cohort-skipped": 5,
        }
      : {
          fftInfo: 4,
          spectrum: 6,
          "abi-spectrum": 1,
          "spectrum-acquisition": 4,
          "spectrum-readback": 6,
        };
  if (!Object.prototype.hasOwnProperty.call(widths, type))
    return this.fail("packet-kind", values);
  if (
    (type === "spectrum" || type === "spectrum-acquisition") &&
    !this.retentionForwarding
  )
    return false;
  if (!this.validNumbers(values, widths[type]))
    return this.fail("packet-numeric", values);
  if ((type === "abi-clock" || type === "abi-spectrum") && values[0] !== 2)
    return this.fail("packet-kind", values);
  var metadata = type !== "clock" && type !== "spectrum";
  var fingerprint = metadata ? values.join(",") : null;
  if (metadata && this.metadata[type] === fingerprint) return false;
  var generation = this.generation;
  var sent =
    this.send(Object.freeze(["native", generation, type].concat(values))) !==
    false;
  if (sent && metadata && this.generation === generation)
    this.metadata[type] = fingerprint;
  return sent;
};

NativeMessageIO.prototype.spectrumDiagnostics = function (values) {
  if (!this.generation) return false;
  if (this.mode !== "spectrum" || !Array.isArray(values) || values.length !== 5)
    return this.fail("spectrum-diagnostics-shape", values);
  if (!this.validNumbers(values, 5))
    return this.fail("spectrum-diagnostics-numeric", values);
  return (
    this.send(
      Object.freeze(
        ["native", this.generation, "spectrum-diagnostics"].concat(values)
      )
    ) !== false
  );
};
NativeMessageIO.prototype.retentionEvent = function (event) {
  if (!this.generation) return;
  var stages = [
    "queued",
    "started",
    "progress",
    "completed",
    "failed",
    "cancelled",
  ];
  var stage = stages.indexOf(event.stage);
  var elapsed = Math.min(120000, Math.max(0, event.elapsedMs));
  if (stage === 2 && event.reason === "unstable_acquisition") {
    if (elapsed - this.retentionUnstableAt < 250) return;
    this.retentionUnstableAt = elapsed;
    this.send([
      "native",
      this.generation,
      "retention-unstable",
      2,
      event.epoch,
    ]);
    return;
  }
  if (stage === 2 && elapsed - this.retentionProgressAt < 250) return;
  if (stage === 2) this.retentionProgressAt = elapsed;
  var reason = event.reason;
  var fault = 0;
  if (stage === 4) {
    fault =
      reason === "unread_capacity_overflow"
        ? 1
        : reason === "invalid_dsp_control"
          ? 2
          : reason === "consumer_failed" || reason === "consumer_rejected"
            ? 4
            : reason === "invalid_owner_reset"
              ? 5
              : 3;
  }
  var queue = this.retentionQueue;
  var generation = this.generation;
  try {
    var reasonIndex = RETENTION_REJECTION_REASONS.indexOf(reason);
    if (
      stage === 4 &&
      this.retentionPolling &&
      !this.retentionRejectionSent &&
      reasonIndex >= 0
    ) {
      this.retentionRejectionSent = true;
      var rejection = [
        2,
        reasonIndex + 1,
        event.epoch,
        this.retentionReadbacks.length,
      ];
      for (var row = 0; row < 3; row++)
        rejection = rejection.concat(
          row < this.retentionReadbacks.length
            ? this.retentionReadbacks[row]
            : [-2].concat(retentionRejectionRow(null).slice(1))
        );
      this.send(
        ["native", generation, "retention-rejection"].concat(rejection)
      );
    }
  } finally {
    if (this.generation === generation && this.retentionQueue === queue) {
      this.send([
        "native",
        this.generation,
        "retention-state",
        2,
        stage,
        event.epoch,
        event.stats.expectedSequence,
        queue.produced,
        queue.acknowledged,
        queue.capacity,
        queue.highWaterMark,
        elapsed,
        fault,
      ]);
      if (
        stage === 4 &&
        fault !== 1 &&
        fault !== 4 &&
        !(reason === "invalid_numeric" && this.retentionMetricInvalid) &&
        this.generation === generation &&
        this.retentionQueue === queue
      )
        this.fail("reader-failed");
    }
  }
};

NativeMessageIO.prototype.beginRetention = function (epoch, sampleRate) {
  var self = this,
    generation = this.generation;
  var layout = [
    ["endCounter", "samples"],
    ["centroidHz", "Hz"],
    ["energy", "linear"],
    ["startCounter", "samples"],
    ["frameEndCounter", "samples"],
    ["invalidFrames", "count"],
  ];
  var queue = { produced: 0, acknowledged: 0, capacity: 32, highWaterMark: 0 };
  this.retentionQueue = queue;
  this.retentionProgressAt = this.retentionUnstableAt = -250;
  this.retentionReadySent = false;
  this.retentionReadbacks = [];
  this.retentionSnapshotAt = -Infinity;
  this.retentionSnapshotDrops = 0;
  this.retentionSnapshotDropReported = false;
  var reader;
  try {
    reader = this.retentionAPI.createReader({
      declaration: {
        version: 1,
        kind: "native-spectrum/v2",
        algorithmVersion: "2.0.0",
        sampleRate: sampleRate,
        hopSamples: 2048,
        windowSamples: 2048,
        width: 6,
        capacity: 32,
        fields: layout.map(function (field) {
          return { name: field[0], unit: field[1] };
        }),
      },
      epoch: epoch,
      now: this.retentionNow,
      consume: function (record) {
        self.retentionForwarding = true;
        try {
          var acquisition = self.spectrumAcquisition;
          if (!acquisition) return false;
          self.packet("spectrum-acquisition", [
            epoch,
            acquisition[0],
            acquisition[1],
            record.values[4],
          ]);
          if (
            self.generation !== generation ||
            self.retentionReader !== reader ||
            self.stopping
          )
            return false;
          var values = record.values.slice();
          // Use the final retained energy, not an upstream DSP value.
          if (values[2] === 0) values[1] = 0;
          return self.packet("spectrum", values);
        } finally {
          self.retentionForwarding = false;
        }
      },
      onEvent: function (event) {
        if (self.generation === generation && self.retentionQueue === queue)
          self.retentionEvent(event);
      },
    });
  } catch (error) {
    var errorName =
      [
        "Error",
        "TypeError",
        "ReferenceError",
        "RangeError",
        "SyntaxError",
      ].indexOf(error.name) >= 0
        ? error.name
        : "Error";
    var errorMessage = String(error.message)
      .replace(
        /(?:token|secret|password|bearer|authorization)\s*[:=]\s*\S+/gi,
        "[redacted]"
      )
      .replace(
        /(?:github_pat_|gh[pousr]_|sk-|AKIA|ASIA)[A-Za-z0-9_-]+/g,
        "[redacted]"
      )
      .slice(0, 128);
    this.send([
      "native",
      generation,
      "spectrum-start-error",
      epoch,
      errorName,
      errorMessage,
    ]);
    throw error;
  }
  if (
    this.generation !== generation ||
    this.retentionEpoch !== epoch ||
    this.stopping
  ) {
    reader.cancel();
    return false;
  }
  this.retentionReader = reader;
  reader.begin();
  var controls = [
    ["measurementReadSequence", 1],
    ["measurementAcknowledged", 0],
    ["measurementEpoch", epoch],
  ];
  for (var index = 0; index < controls.length; index++) {
    if (
      this.generation !== generation ||
      this.retentionReader !== reader ||
      this.stopping
    )
      return false;
    this.control(controls[index]);
  }
  if (
    this.generation === generation &&
    this.retentionReader === reader &&
    !this.stopping
  )
    this.control(["poll", 1]);
  return (
    this.generation === generation &&
    this.retentionReader === reader &&
    !this.stopping
  );
};

NativeMessageIO.prototype.coherentSpectrumHeader = function (values, epoch) {
  var width = 6;
  var limit = 17592186044415;
  var coherent =
    Array.isArray(values) &&
    values.length === width + 14 &&
    values[0] === 1 &&
    values[1] === epoch &&
    values[1] === values[width + 13] &&
    values[2] === values[width + 12] &&
    values[3] === values[width + 11] &&
    values[4] === values[width + 10];
  if (coherent) {
    for (var i = 2; i <= 9; i++)
      if (
        Math.floor(values[i]) !== values[i] ||
        values[i] < 0 ||
        values[i] > (i === 3 ? 1000000 : i === 9 ? 2 : limit)
      )
        coherent = false;
    if (values[2] < 1 || values[6] < values[5] || values[8] > values[7])
      coherent = false;
  }
  return coherent;
};
NativeMessageIO.prototype.readSpectrumRow = function (values) {
  var reader = this.retentionReader;
  if (!this.generation || !reader || this.stopping) return false;
  var width = 6;
  var coherent = this.coherentSpectrumHeader(values, this.retentionEpoch);
  if (coherent) {
    // Fault rows terminate synchronously in poll; terminal telemetry needs these raw counters first.
    this.retentionQueue.produced = values[7];
    this.retentionQueue.acknowledged = values[8];
    this.retentionQueue.highWaterMark = Math.min(
      this.retentionQueue.capacity,
      Math.max(this.retentionQueue.highWaterMark, values[7] - values[8])
    );
  }
  this.retentionReadbacks.push(retentionRejectionRow(values));
  if (this.retentionReadbacks.length > 3) this.retentionReadbacks.shift();
  var wasPolling = this.retentionPolling;
  var wasMetricInvalid = this.retentionMetricInvalid;
  var result;
  this.retentionPolling = true;
  this.retentionMetricInvalid = coherent && !this.validNumbers(values, 20);
  try {
    result = reader.poll(values);
  } finally {
    this.retentionPolling = wasPolling;
    this.retentionMetricInvalid = wasMetricInvalid;
  }
  if (this.retentionReader !== reader || !this.generation || this.stopping)
    return false;
  var readySlot =
    coherent && values[3] === this.retentionEpoch && values[4] === values[2];
  if (coherent && values[7] < values[2]) {
    readySlot =
      values[3] === 0 && values[4] === 0 && values[5] === 0 && values[6] === 0;
    for (var empty = 10; empty < width + 10; empty++)
      if (values[empty] !== 0) readySlot = false;
  }
  if (
    !this.retentionReadySent &&
    coherent &&
    readySlot &&
    values[9] === 0 &&
    values[7] - values[8] <= this.retentionQueue.capacity &&
    ["waiting", "settling", "accepted"].indexOf(result.status) >= 0
  ) {
    // Only executed, healthy DSP readback is readiness evidence; JS lifecycle is not.
    this.retentionReadySent = true;
    this.send([
      "native",
      this.generation,
      "retention-ready",
      2,
      1,
      this.retentionEpoch,
    ]);
    if (this.retentionReader !== reader || !this.generation || this.stopping)
      return false;
  }
  if (result.status === "accepted") {
    for (var action = 0; action < result.actions.length; action++) {
      if (this.retentionReader !== reader || !this.generation || this.stopping)
        return false;
      var next = result.actions[action];
      this.control([
        next.type === "request"
          ? "measurementReadSequence"
          : "measurementAcknowledged",
        next.sequence,
      ]);
    }
    if (this.retentionReader === reader)
      this.publishRetentionSnapshot(result.status);
    return true;
  }
  this.publishRetentionSnapshot(result.status);
  return false;
};
// One counter-bookended bank, no second reader or ACK path. Epoch zero
// is a disabled FIFO receipt, not a spectrum descriptor or a transport proof.
NativeMessageIO.prototype.rejectSpectrumInput = function (reason) {
  if (this.mode !== "spectrum" || !this.generation) return false;
  if (SPECTRUM_CLEANUP_REASONS.indexOf(reason) < 0)
    throw new Error("invalid_spectrum_cleanup_reason");
  this.spectrumInputFailure = true;
  this.spectrumInputReason = reason;
  if (this.spectrumCleanupState) return this.failSpectrumCleanup(reason);
  var generation = this.generation;
  var epoch = this.retentionEpoch;
  try {
    this.send(
      Object.freeze([
        "native",
        generation,
        "spectrum-input-rejection",
        2,
        epoch,
        SPECTRUM_CLEANUP_REASONS.indexOf(reason),
      ])
    );
  } finally {
    if (this.generation === generation && this.retentionEpoch === epoch) {
      try {
        if (this.retentionReader) this.retentionReader.fail();
      } finally {
        if (this.generation === generation && this.retentionEpoch === epoch)
          this.fail("stop-quiescence");
      }
    }
  }
  return false;
};
NativeMessageIO.prototype.spectrumOwner = function (generation, epoch) {
  if (
    this.mode !== "spectrum" ||
    !this.generation ||
    generation !== this.generation
  )
    return false;
  if (epoch !== this.retentionEpoch) {
    this.rejectSpectrumInput("owner_mismatch");
    return false;
  }
  return true;
};
NativeMessageIO.prototype.spectrumCleanupEvent = function (
  state,
  stage,
  reason
) {
  if (
    this.spectrumCleanupState !== state ||
    this.generation !== state.generation
  )
    return false;
  var elapsed =
    state.requestedHostMs === null || state.lastHostMs === null
      ? -1
      : Math.min(120000, state.lastHostMs - state.requestedHostMs);
  var packet = Object.freeze([
    "native",
    state.generation,
    "spectrum-cleanup-state",
    2,
    stage,
    state.nativeEpoch,
    ["complete", "failed", "cancelled"].indexOf(state.outcome),
    state.stopWatermark === null ? -1 : state.stopWatermark,
    state.deadlineMs,
    elapsed,
    SPECTRUM_CLEANUP_REASONS.indexOf(reason || "none"),
  ]);
  try {
    if (this.send(packet) === false)
      throw new Error("native_io_spectrum_cleanup_event_rejected");
  } catch (error) {
    if (
      this.spectrumCleanupState === state &&
      this.generation === state.generation
    ) {
      state.status = "failed";
      state.reason = "event_delivery_failed";
      try {
        this.diagnostic("native_io_spectrum_cleanup_event_failed");
      } finally {
        if (
          this.spectrumCleanupState === state &&
          this.generation === state.generation
        )
          this.finishSpectrumRetention("failed");
      }
    }
    throw error;
  }
  return (
    this.spectrumCleanupState === state && this.generation === state.generation
  );
};
NativeMessageIO.prototype.finishSpectrumRetention = function (outcome) {
  if (this.mode !== "spectrum") return;
  var reader = this.retentionReader;
  this.retentionReader = null;
  this.retentionForwarding = false;
  if (!reader) return;
  if (outcome === "complete") reader.complete();
  else if (outcome === "cancelled") reader.cancel();
  else reader.fail();
};
NativeMessageIO.prototype.failSpectrumCleanup = function (reason) {
  var state = this.spectrumCleanupState;
  if (this.mode !== "spectrum" || !state || state.status === "failed")
    return false;
  if (SPECTRUM_CLEANUP_REASONS.indexOf(reason) < 0)
    throw new Error("invalid_spectrum_cleanup_reason");
  state.status = "failed";
  state.reason = reason;
  state.completedHostMs = state.lastHostMs;
  try {
    this.spectrumCleanupEvent(state, 4, reason);
  } finally {
    if (
      this.spectrumCleanupState === state &&
      this.generation === state.generation
    ) {
      try {
        if (!this.stopControlsSent && !state.controlInFlight)
          this.sendSpectrumDisable(state);
      } finally {
        if (
          this.spectrumCleanupState === state &&
          this.generation === state.generation
        )
          this.finishSpectrumRetention(
            state.outcome === "cancelled" ? "cancelled" : "failed"
          );
      }
    }
  }
  return false;
};
NativeMessageIO.prototype.spectrumCleanupTick = function (generation, epoch) {
  if (!this.spectrumOwner(generation, epoch)) return false;
  var state = this.spectrumCleanupState;
  if (!state || state.status !== "pending") return false;
  var now;
  try {
    now = this.retentionNow();
  } catch (error) {
    if (this.spectrumCleanupState === state && this.generation === generation)
      this.failSpectrumCleanup("host_clock_failed");
    throw error;
  }
  if (this.spectrumCleanupState !== state || this.generation !== generation)
    return false;
  if (!spectrumCleanupHostTime(now) || now < state.lastHostMs)
    return this.failSpectrumCleanup("host_clock_invalid");
  state.lastHostMs = now;
  if (now >= state.deadlineMs) return this.failSpectrumCleanup("deadline");
  return true;
};
NativeMessageIO.prototype.spectrumCleanupEvidence = function (
  generation,
  epoch
) {
  if (!this.spectrumOwner(generation, epoch)) return false;
  var state = this.spectrumCleanupState;
  if (!state) return false;
  return Object.freeze({
    type: "native-metric-spectrum-cleanup/v1",
    generation: state.generation,
    nativeEpoch: state.nativeEpoch,
    status: state.status,
    phase: state.phase,
    outcome: state.outcome,
    diagnosticOnly:
      state.status === "failed" ||
      state.outcome !== "complete" ||
      this.spectrumInputFailure,
    inputFailureReason: this.spectrumInputReason,
    reason: state.reason,
    stopWatermark: state.stopWatermark,
    deadlineMs: state.deadlineMs,
    requestedHostMs: state.requestedHostMs,
    completedHostMs: state.completedHostMs,
    watermarkReceipt: Object.freeze({
      available: state.watermarkReceipt !== null,
      value: state.watermarkReceipt,
    }),
    receipt: Object.freeze({
      available: state.receipt !== null,
      value: state.receipt,
    }),
  });
};
NativeMessageIO.prototype.retainedSpectrumFrame = function (
  generation,
  epoch,
  values
) {
  if (!this.spectrumOwner(generation, epoch)) return false;
  var state = this.spectrumCleanupState;
  if (this.stopping && (!state || state.status !== "pending")) return false;
  if (this.spectrumInputFailure && !this.stopping) return false;
  if (this.stopping && !this.spectrumCleanupTick(generation, epoch))
    return false;
  var reason = null;
  if (!Array.isArray(values) || values.length !== 22)
    reason = "invalid_readback";
  else if (
    !spectrumCleanupCounter(values[0]) ||
    !spectrumCleanupCounter(values[21]) ||
    values[21] < values[0]
  )
    reason = "counter_incoherent";
  if (reason) {
    if (this.stopping) return this.failSpectrumCleanup(reason);
    return this.rejectSpectrumInput(reason);
  }
  var counter = values[0];
  if (
    this.stopping &&
    state.stopWatermark !== null &&
    counter <= state.stopWatermark
  )
    return false;
  if (counter < this.spectrumCounterHighWater) {
    if (this.stopping) return this.failSpectrumCleanup("counter_regression");
    return this.rejectSpectrumInput("counter_regression");
  }
  if (values[21] > counter) {
    this.retentionEvent({
      stage: "progress",
      reason: "unstable_acquisition",
      epoch: epoch,
      elapsedMs: this.retentionReader.stats().elapsedMs,
    });
    return false;
  }
  var row = values.slice(1, 21);
  if (
    !this.stopping &&
    [row[0], row[1], row[7], row[9]].every(function (value) {
      return typeof value === "number" && isFinite(value);
    }) &&
    this.retentionNow() -
      (this.lastSpectrumReadbackAt === undefined
        ? -Infinity
        : this.lastSpectrumReadbackAt) >=
      250
  ) {
    this.lastSpectrumReadbackAt = this.retentionNow();
    this.packet("spectrum-readback", [
      epoch,
      counter,
      row[0],
      row[1],
      row[7],
      row[9],
    ]);
  }
  if (!this.stopping) {
    var idle =
      row.every(function (cell) {
        return cell === 0;
      }) ||
      (row[0] === 1 &&
        spectrumCleanupCounter(row[2]) &&
        row[2] === row[18] &&
        row.every(function (cell, index) {
          return index === 0 || index === 2 || index === 18 || cell === 0;
        }));
    if (!this.retentionReadySent && idle) {
      this.retentionReadbacks.push(retentionRejectionRow(row));
      if (this.retentionReadbacks.length > 3) this.retentionReadbacks.shift();
      this.publishRetentionSnapshot("waiting");
      return false;
    }
    var reader = this.retentionReader;
    var acquisition = Object.freeze([values[0], values[21]]);
    this.spectrumAcquisition = acquisition;
    var accepted;
    try {
      accepted = this.readSpectrumRow(row);
    } finally {
      if (this.spectrumAcquisition === acquisition)
        this.spectrumAcquisition = null;
    }
    if (
      this.generation === generation &&
      this.retentionReader === reader &&
      reader &&
      reader.stats().state === "started"
    )
      this.spectrumCounterHighWater = counter;
    return accepted;
  }
  if (!this.validNumbers(row, 20))
    return this.failSpectrumCleanup("invalid_readback");
  var acquiring = state.phase === "acquiring-watermark";
  if (acquiring && counter === this.spectrumCounterHighWater) return false;
  if (!acquiring && !this.stopControlsSent) return false;
  if (
    row[0] !== 1 ||
    row[1] !== row[19] ||
    row[2] !== row[18] ||
    row[3] !== row[17] ||
    row[4] !== row[16]
  )
    return this.failSpectrumCleanup("invalid_readback");
  if (row[1] !== 0 && row[1] !== epoch)
    return this.failSpectrumCleanup("owner_mismatch");
  if (row[1] === epoch && !this.coherentSpectrumHeader(row, epoch))
    return this.failSpectrumCleanup("invalid_readback");
  if (row[1] === 0) {
    if (!spectrumCleanupCounter(row[2]))
      return this.failSpectrumCleanup("disabled_readback_invalid");
    for (var index = 1; index < row.length; index++)
      if (index !== 2 && index !== 18 && row[index] !== 0)
        return this.failSpectrumCleanup("disabled_readback_invalid");
  }
  if (acquiring) {
    state.watermarkReceipt = spectrumExecutedReceipt(
      row,
      counter,
      values[21],
      state.lastHostMs
    );
    state.stopWatermark = counter;
    state.phase = "awaiting-disabled";
    state.progressSent = true;
    this.spectrumCounterHighWater = counter;
    try {
      this.spectrumCleanupEvent(state, 2, "watermark_acquired");
    } finally {
      this.sendSpectrumDisable(state);
    }
    return false;
  }
  if (row[1] === epoch) {
    if (!state.progressSent) {
      state.progressSent = true;
      this.spectrumCleanupEvent(state, 2, "waiting");
    }
    return false;
  }
  state.receipt = spectrumExecutedReceipt(
    row,
    counter,
    values[21],
    state.lastHostMs
  );
  this.spectrumCounterHighWater = counter;
  state.status = "completed";
  state.phase = "disabled-confirmed";
  state.reason = null;
  state.completedHostMs = state.lastHostMs;
  try {
    this.spectrumCleanupEvent(state, 3);
  } finally {
    if (this.spectrumCleanupState === state && this.generation === generation)
      this.finishSpectrumRetention(
        state.status === "completed" ? state.outcome : "failed"
      );
  }
  return (
    this.spectrumCleanupState === state &&
    this.generation === generation &&
    state.status === "completed"
  );
};
// Stop acquisition and the zero-epoch setter share one JS callback; a Node
// query/command roundtrip cannot safely race the local counter high-water mark.

NativeMessageIO.prototype.sendSpectrumDisable = function (state) {
  if (
    this.mode !== "spectrum" ||
    this.spectrumCleanupState !== state ||
    this.generation !== state.generation ||
    !this.stopping
  )
    return false;
  if (this.stopControlsSent) return true;
  if (state.controlInFlight) return false;
  try {
    state.controlInFlight = true;
    this.control(["measurementEpoch", 0]);
    if (
      this.spectrumCleanupState === state &&
      this.generation === state.generation
    )
      this.stopControlsSent = true;
  } catch (error) {
    if (
      this.spectrumCleanupState === state &&
      this.generation === state.generation
    )
      this.failSpectrumCleanup("control_failed");
    throw error;
  } finally {
    state.controlInFlight = false;
    if (
      this.spectrumCleanupState === state &&
      this.generation === state.generation &&
      state.status === "failed"
    )
      this.finishSpectrumRetention("failed");
  }
  return (
    this.spectrumCleanupState === state &&
    this.generation === state.generation &&
    this.stopControlsSent
  );
};

NativeMessageIO.prototype.requestSpectrumStop = function (
  generation,
  epoch,
  outcome,
  deadline
) {
  if (!this.spectrumOwner(generation, epoch) || this.stopping) return false;
  if (
    ["complete", "failed", "cancelled"].indexOf(outcome) < 0 ||
    !spectrumCleanupHostTime(deadline)
  )
    return this.rejectSpectrumInput("invalid_stop_control");
  var now = null,
    clockError,
    clockFailed = false;
  try {
    now = this.retentionNow();
  } catch (error) {
    clockError = error;
    clockFailed = true;
  }
  if (
    this.generation !== generation ||
    this.retentionEpoch !== epoch ||
    this.stopping
  ) {
    if (clockFailed) throw clockError;
    return false;
  }
  var validClock = spectrumCleanupHostTime(now);
  if (validClock && deadline - now > 120000)
    return this.rejectSpectrumInput("invalid_stop_control");
  var state = {
    generation: generation,
    nativeEpoch: epoch,
    status: "pending",
    phase: "acquiring-watermark",
    outcome: outcome,
    reason: null,
    stopWatermark: null,
    deadlineMs: deadline,
    requestedHostMs: validClock ? now : null,
    lastHostMs: validClock ? now : null,
    completedHostMs: null,
    watermarkReceipt: null,
    receipt: null,
    progressSent: false,
    controlInFlight: false,
    releasing: false,
  };
  this.spectrumCleanupState = state;
  this.stopping = true;
  this.stopControlsSent = false;
  var notificationError,
    notificationFailed = false;
  try {
    if (this.spectrumCleanupEvent(state, 0))
      this.spectrumCleanupEvent(state, 1);
  } catch (error) {
    notificationError = error;
    notificationFailed = true;
  }
  if (this.spectrumCleanupState !== state || this.generation !== generation) {
    if (notificationFailed) throw notificationError;
    return false;
  }
  if (!validClock || notificationFailed) this.sendSpectrumDisable(state);
  if (notificationFailed) throw notificationError;
  if (this.spectrumCleanupState !== state || this.generation !== generation)
    return false;
  if (!validClock) {
    this.failSpectrumCleanup(
      clockFailed ? "host_clock_failed" : "host_clock_invalid"
    );
    if (clockFailed) throw clockError;
    return false;
  }
  return this.spectrumCleanupTick(generation, epoch);
};
NativeMessageIO.prototype.release = function (generation) {
  if (this.mode === "clock") {
    if (!this.generation || generation !== this.generation || this.stopping)
      return false;
    this.stopping = true;
    this.control(["poll", 0]);
    if (this.generation !== generation) return false;
    this.generation = null;
    this.retentionEpoch = null;
    this.pre = this.clock = null;
    this.clockCohortSkips = 0;
    this.metadata = {};
    this.stopping = false;
    return true;
  }
  var state = this.spectrumCleanupState;
  if (
    this.mode !== "spectrum" ||
    !state ||
    this.generation !== generation ||
    !this.stopping ||
    state.releasing
  )
    return false;
  state.releasing = true;
  try {
    if (state.status === "pending")
      this.failSpectrumCleanup("unconfirmed_release");
    if (this.spectrumCleanupState !== state || this.generation !== generation)
      return false;
    if (!this.stopControlsSent && !state.controlInFlight) {
      this.sendSpectrumDisable(state);
      if (this.spectrumCleanupState !== state || this.generation !== generation)
        return false;
    }
    this.finishSpectrumRetention(state.outcome);
    if (this.spectrumCleanupState !== state || this.generation !== generation)
      return false;
    this.control(["poll", 0]);
    if (this.spectrumCleanupState !== state || this.generation !== generation)
      return false;
    this.retentionEpoch = null;
    this.retentionQueue = null;
    this.retentionReadbacks = [];
    this.retentionReadySent = false;
    this.spectrumCleanupState = null;
    this.generation = null;
    this.stopping = false;
    this.stopControlsSent = false;
    this.pre = this.clock = null;
    this.metadata = {};
    return true;
  } finally {
    state.releasing = false;
  }
};
NativeMessageIO.prototype.retentionSnapshotGap = function (reason) {
  var generation = this.generation;
  var reader = this.retentionReader;
  this.retentionSnapshotDrops = Math.min(
    1000000,
    this.retentionSnapshotDrops + 1
  );
  if (!this.retentionSnapshotDropReported) {
    this.retentionSnapshotDropReported = true;
    try {
      this.diagnostic(reason);
    } catch (diagnosticError) {
      if (this.generation === generation && this.retentionReader === reader)
        this.retentionSnapshotDrops = Math.min(
          1000000,
          this.retentionSnapshotDrops + 1
        );
    }
  }
};
NativeMessageIO.prototype.publishRetentionSnapshot = function (status) {
  if (!this.retentionReader || !this.generation || this.stopping) return;
  var reader = this.retentionReader;
  var generation = this.generation;
  var snapshotNow;
  try {
    snapshotNow = this.retentionNow();
  } catch (clockError) {
    if (this.retentionReader === reader && this.generation === generation)
      this.retentionSnapshotGap("native_retention_snapshot_clock_failed");
    return;
  }
  if (this.retentionReader !== reader || this.generation !== generation) return;
  if (typeof snapshotNow !== "number" || !isFinite(snapshotNow)) {
    this.retentionSnapshotGap("native_retention_snapshot_clock_invalid");
    return;
  }
  var snapshotStatus = RETENTION_SNAPSHOT_STATUSES.indexOf(status);
  if (snapshotStatus >= 0 && snapshotNow - this.retentionSnapshotAt >= 250) {
    this.retentionSnapshotAt = snapshotNow;
    var snapshot = [
      2,
      snapshotStatus + 1,
      this.retentionEpoch,
      this.retentionReadbacks.length,
    ];
    for (var snapshotRow = 0; snapshotRow < 3; snapshotRow++)
      snapshot = snapshot.concat(
        snapshotRow < this.retentionReadbacks.length
          ? this.retentionReadbacks[snapshotRow]
          : [-2].concat(retentionRejectionRow(null).slice(1))
      );
    snapshot.push(this.retentionSnapshotDrops);
    var delivered = false;
    try {
      delivered =
        this.send(
          ["native", this.generation, "retention-snapshot"].concat(snapshot)
        ) !== false;
    } catch (snapshotError) {
      delivered = false;
    }
    if (this.retentionReader !== reader || this.generation !== generation)
      return;
    if (!delivered) {
      this.retentionSnapshotGap("native_retention_snapshot_delivery_failed");
    }
  }
};

NativeMessageIO.prototype.begin = function (
  generation,
  nativeEpoch,
  sampleRate
) {
  if (this.generation) {
    if (generation !== this.generation)
      this.reportRejection(generation, "generation-current");
    return false;
  }
  if (
    typeof generation !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      generation
    )
  )
    return this.fail("begin-generation");
  if (generation === this.lastGeneration) {
    this.reportRejection(generation, "begin-generation");
    return false;
  }
  if (
    !spectrumCleanupCounter(nativeEpoch) ||
    nativeEpoch < 1 ||
    nativeEpoch > 1000000 ||
    (sampleRate !== 44100 && sampleRate !== 48000)
  ) {
    this.reportRejection(generation, "begin-retention-control", [
      nativeEpoch,
      sampleRate,
    ]);
    return false;
  }
  if (nativeEpoch <= this.retentionEpochHighWater) {
    this.reportRejection(generation, "begin-epoch-monotonic", [nativeEpoch]);
    this.diagnostic("native_io_retention_epoch_reuse");
    return false;
  }
  this.retentionEpochHighWater = nativeEpoch;
  this.generation = generation;
  this.lastGeneration = generation;
  this.retentionEpoch = nativeEpoch;
  this.clockCohortSkips = 0;
  this.invalidReported = false;
  this.lastRejectionKey = null;
  this.metadata = {};
  this.retentionReadbacks = [];
  this.retentionRejectionSent = false;
  this.pre = this.clock = null;
  this.stopping = false;
  this.stopControlsSent = false;
  this.spectrumCleanupState = null;
  this.spectrumInputFailure = false;
  this.spectrumGuardRelease = false;
  this.spectrumAcquisition = null;
  this.spectrumInputReason = null;
  if (this.mode === "spectrum")
    return this.beginRetention(nativeEpoch, sampleRate);
  this.control(["poll", 0]);
  if (this.generation !== generation || this.stopping) return false;
  this.control(["poll", 1]);
  return this.generation === generation && !this.stopping;
};

NativeMessageIO.prototype.anchorPre = function (values) {
  if (!this.generation) return false;
  this.pre = this.clock = null;
  if (this.mode !== "clock" || !this.validNumbers(values, 4))
    return this.fail("anchor-pre", values);
  this.pre = values.slice();
  return true;
};

NativeMessageIO.prototype.anchorClock = function (values) {
  if (!this.generation) return false;
  this.clock = null;
  if (this.mode !== "clock" || !this.validNumbers(values, 4) || values[3] !== 2)
    return this.fail("anchor-clock", values);
  this.clock = values.slice(0, 3);
  return this.packet("abi-clock", [values[3]]);
};

NativeMessageIO.prototype.anchorPost = function (values) {
  if (!this.generation) return false;
  var pre = this.pre,
    clock = this.clock;
  this.pre = this.clock = null;
  if (this.mode !== "clock" || !this.validNumbers(values, 4) || !pre || !clock)
    return this.fail("anchor-post", values);
  if (
    pre.some(function (value, index) {
      return value !== values[index];
    }) ||
    clock[0] !== clock[2]
  ) {
    this.clockCohortSkips = (this.clockCohortSkips || 0) + 1;
    if (this.clockCohortSkips === 1 || this.clockCohortSkips % 16 === 0)
      this.packet("clock-cohort-skipped", [
        this.clockCohortSkips,
        pre[2],
        values[2],
        clock[0],
        clock[2],
      ]);
    return false;
  }
  return this.packet("clock", pre.concat(clock, values));
};

if (typeof module !== "undefined")
  module.exports = {
    NativeMessageIO: NativeMessageIO,
    decodeRetentionRejection: decodeRetentionRejection,
    RETENTION_REJECTION_LENGTH: RETENTION_REJECTION_LENGTH,
    decodeIORejection: decodeIORejection,
    IO_REJECTION_LENGTH: IO_REJECTION_LENGTH,
    decodeRetentionSnapshot: decodeRetentionSnapshot,
    RETENTION_SNAPSHOT_LENGTH: RETENTION_SNAPSHOT_LENGTH,
    IO_REJECTION_CHECKS: IO_REJECTION_CHECKS,
    SPECTRUM_CLEANUP_REASONS: SPECTRUM_CLEANUP_REASONS,
  };
var nativeIO = null;

if (typeof outlet === "function") {
  if (jsarguments.length !== 3 || jsarguments[2] !== "metric-v1")
    throw new Error("unsupported_metric_io_mode");
  inlets = 1;
  outlets = 2;
  nativeIO = new NativeMessageIO(
    jsarguments[1],
    function (values) {
      if (values[2] === "spectrum")
        return outlet(0, [
          values[0],
          values[1],
          "spectrum-json",
          JSON.stringify(values.slice(3)),
        ]);
      return outlet(0, values);
    },
    function (values) {
      return outlet(1, values[0], values[1]);
    },
    function (reason) {
      post(reason + "\n");
    },
    {}
  );
}
function begin(generation, nativeEpoch, sampleRate) {
  return nativeIO.begin(generation, nativeEpoch, sampleRate);
}

function release(generation) {
  return nativeIO.release(generation);
}
function anchor_pre() {
  return nativeIO.anchorPre(arrayfromargs(arguments));
}
function anchor_clock() {
  return nativeIO.anchorClock(arrayfromargs(arguments));
}
function anchor_post() {
  return nativeIO.anchorPost(arrayfromargs(arguments));
}
function anchor_dsp() {
  return nativeIO.packet("dsp", arrayfromargs(arguments));
}
function tempo(value) {
  return nativeIO.packet("tempo", [value]);
}
function fft_info() {
  return nativeIO.packet("fftInfo", arrayfromargs(arguments));
}

function spectrum_measurement_frame() {
  var generation = nativeIO.generation;
  var accepted = nativeIO.retainedSpectrumFrame(
    nativeIO.generation,
    nativeIO.retentionEpoch,
    arrayfromargs(arguments)
  );
  if (
    nativeIO.spectrumGuardRelease &&
    nativeIO.generation === generation &&
    nativeIO.spectrumCleanupState
  ) {
    if (nativeIO.spectrumCleanupState.status === "completed")
      nativeIO.release(generation);
    else if (nativeIO.spectrumCleanupState.status === "failed")
      nativeIO.control(["poll", 0]);
  }
  return accepted;
}

function metric_spectrum_guard_stop(generation) {
  if (
    nativeIO.mode !== "spectrum" ||
    !nativeIO.generation ||
    generation !== nativeIO.generation
  )
    return false;
  nativeIO.spectrumGuardRelease = true;
  nativeIO.control(["poll", 1]);
  if (nativeIO.stopping) return true;
  return nativeIO.requestSpectrumStop(
    generation,
    nativeIO.retentionEpoch,
    "failed",
    nativeIO.retentionNow() + 2000
  );
}
function spectrum_cleanup_tick(generation, epoch) {
  return nativeIO.spectrumCleanupTick(generation, epoch);
}
function request_spectrum_stop(generation, epoch, outcome, deadline) {
  return nativeIO.requestSpectrumStop(generation, epoch, outcome, deadline);
}
function spectrum_cleanup_evidence(generation, epoch) {
  var evidence = nativeIO.spectrumCleanupEvidence(generation, epoch);
  if (!evidence) return false;
  nativeIO.send(["native_metric_spectrum_cleanup", JSON.stringify(evidence)]);
  return true;
}
function spectrum_diagnostics() {
  return nativeIO.spectrumDiagnostics(arrayfromargs(arguments));
}

function abi_value(value) {
  return nativeIO.packet("abi-spectrum", [value]);
}

function notifydeleted() {
  if (!nativeIO || !nativeIO.generation) return;
  var generation = nativeIO.generation;
  if (nativeIO.mode === "clock") {
    nativeIO.release(generation);
    return;
  }
  if (nativeIO.spectrumCleanupState) {
    if (nativeIO.spectrumCleanupState.status === "pending")
      nativeIO.failSpectrumCleanup("deleted");
    nativeIO.release(generation);
    return;
  }
  try {
    nativeIO.diagnostic("native_io_spectrum_cleanup_deleted_unconfirmed");
    nativeIO.rejectSpectrumInput("deleted");
  } finally {
    if (nativeIO.generation === generation) {
      try {
        nativeIO.control(["measurementEpoch", 0]);
      } finally {
        if (nativeIO.generation === generation)
          nativeIO.finishSpectrumRetention("cancelled");
      }
    }
  }
}
