/* global module, exports */
/* eslint no-var: "off", vars-on-top: "off", no-unused-vars: ["error", { "caughtErrors": "none" }] */
/* Exported as one global for classic Max JS include; no timers, IO, or persistence. */
var AudioListenerMeasurements = (function () {
  "use strict";
  var COUNTER_MAX = 17592186044415;
  var VALUE_MAX = 9007199254740991;
  var has = Object.prototype.hasOwnProperty;
  var METRIC_FIELDS = [
    ["sequence", "count"],
    ["startSample", "samples"],
    ["endSample", "samples"],
    ["count", "samples"],
    ["peakL", "linear"],
    ["peakR", "linear"],
    ["sumSquaresL", "linear-squared-samples"],
    ["sumSquaresR", "linear-squared-samples"],
  ];

  function integer(value, min, max) {
    return (
      typeof value === "number" &&
      isFinite(value) &&
      Math.floor(value) === value &&
      value >= min &&
      value <= max
    );
  }
  function numeric(value) {
    return (
      typeof value === "number" &&
      isFinite(value) &&
      Math.abs(value) <= VALUE_MAX
    );
  }
  function keys(value, allowed) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return false;
    var names = Object.keys(value);
    if (names.length !== allowed.length) return false;
    for (var i = 0; i < names.length; i++) {
      if (allowed.indexOf(names[i]) < 0) return false;
    }
    return true;
  }
  function token(value, max) {
    return (
      typeof value === "string" &&
      value.length <= max &&
      /^[A-Za-z][A-Za-z0-9_./-]*$/.test(value)
    );
  }
  function validateDeclaration(value) {
    var musical = value && value.kind === "native-musical-level/v1";
    var detector = value && value.kind === "native-detector-level/v1";
    var metric = musical || detector;
    if (
      !keys(value, [
        "version",
        "kind",
        "algorithmVersion",
        "sampleRate",
        "hopSamples",
        "windowSamples",
        "width",
        "capacity",
        "fields",
      ]) ||
      (value.version !== 1 && !(value.version === 2 && metric)) ||
      (metric && value.version !== 2) ||
      !token(value.kind, 64) ||
      typeof value.algorithmVersion !== "string" ||
      value.algorithmVersion.length > 64 ||
      !/^[A-Za-z0-9][A-Za-z0-9_.+-]*$/.test(value.algorithmVersion) ||
      (value.sampleRate !== 44100 && value.sampleRate !== 48000) ||
      (musical
        ? value.hopSamples !== null || value.windowSamples !== null
        : !integer(value.hopSamples, 1, 65536) ||
          !integer(value.windowSamples, 1, 65536)) ||
      !integer(value.width, 1, 64) ||
      !integer(value.capacity, 1, 128) ||
      !Array.isArray(value.fields) ||
      value.fields.length !== value.width
    ) {
      throw new Error("invalid_declaration");
    }
    var envelope =
      value.kind === "native-envelope" || value.kind === "native-envelope/v2";
    var spectrum =
      value.kind === "native-spectrum" || value.kind === "native-spectrum/v2";
    if (
      (envelope || spectrum) &&
      (value.algorithmVersion !== "2.0.0" ||
        value.width !== (envelope ? 16 : 6) ||
        value.capacity !== (envelope ? 16 : 32))
    ) {
      throw new Error("invalid_native_declaration");
    }
    if (
      metric &&
      (value.algorithmVersion !== "3.0.0" ||
        value.width !== 8 ||
        value.capacity !== 16 ||
        (detector &&
          (value.hopSamples !== Math.round(value.sampleRate / 10) ||
            value.windowSamples !== value.hopSamples)) ||
        value.fields.some(function (field, index) {
          return (
            !field ||
            field.name !== METRIC_FIELDS[index][0] ||
            field.unit !== METRIC_FIELDS[index][1]
          );
        }))
    )
      throw new Error("invalid_metric_declaration");
    var fields = [];
    var names = {};
    for (var i = 0; i < value.fields.length; i++) {
      var field = value.fields[i];
      if (
        !keys(field, ["name", "unit"]) ||
        !token(field.name, 64) ||
        !token(field.unit, 32) ||
        has.call(names, "$" + field.name)
      ) {
        throw new Error("invalid_fields");
      }
      names["$" + field.name] = true;
      fields.push(Object.freeze({ name: field.name, unit: field.unit }));
    }
    return Object.freeze({
      version: value.version,
      kind: value.kind,
      algorithmVersion: value.algorithmVersion,
      sampleRate: value.sampleRate,
      hopSamples: value.hopSamples,
      windowSamples: value.windowSamples,
      width: value.width,
      capacity: value.capacity,
      fields: Object.freeze(fields),
    });
  }
  function createMetricDeclaration(options) {
    if (
      !keys(options, ["family", "sampleRate"]) ||
      (options.family !== "level" && options.family !== "detector-level")
    )
      throw new Error("invalid_metric_declaration_options");
    var musical = options.family === "level";
    return validateDeclaration({
      version: 2,
      kind: musical ? "native-musical-level/v1" : "native-detector-level/v1",
      algorithmVersion: "3.0.0",
      sampleRate: options.sampleRate,
      hopSamples: musical ? null : Math.round(options.sampleRate / 10),
      windowSamples: musical ? null : Math.round(options.sampleRate / 10),
      width: 8,
      capacity: 16,
      fields: METRIC_FIELDS.map(function (field) {
        return { name: field[0], unit: field[1] };
      }),
    });
  }
  function validateRecord(value, declaration) {
    var d = validateDeclaration(declaration);
    if (
      !keys(value, [
        "version",
        "kind",
        "epoch",
        "sequence",
        "startSample",
        "endSample",
        "values",
      ]) ||
      value.version !== 1 ||
      value.kind !== d.kind ||
      !integer(value.epoch, 1, 1000000) ||
      !integer(value.sequence, 1, COUNTER_MAX) ||
      !integer(value.startSample, 0, COUNTER_MAX) ||
      !integer(value.endSample, value.startSample, COUNTER_MAX) ||
      !Array.isArray(value.values) ||
      value.values.length !== d.width
    ) {
      throw new Error("invalid_record");
    }
    for (var i = 0; i < value.values.length; i++) {
      if (!numeric(value.values[i])) throw new Error("invalid_values");
    }
    return Object.freeze({
      version: 1,
      kind: d.kind,
      epoch: value.epoch,
      sequence: value.sequence,
      startSample: value.startSample,
      endSample: value.endSample,
      values: Object.freeze(value.values.slice()),
    });
  }
  // Structural/sample-moment validation only. A null origin permits bounded
  // startup staging; the capture owner must still verify it against launch.
  function normalizeMetricRecord(value, declaration, expected) {
    var d = validateDeclaration(declaration);
    var record = validateRecord(value, d);
    if (
      d.version !== 2 ||
      !keys(expected, [
        "sequence",
        "startSample",
        "endSample",
        "sourceOriginCounter",
      ]) ||
      !integer(
        expected.sequence,
        1,
        d.kind === "native-musical-level/v1" ? 2000 : 300
      ) ||
      !integer(expected.startSample, 0, 30 * d.sampleRate - 1) ||
      !integer(
        expected.endSample,
        expected.startSample + 1,
        30 * d.sampleRate
      ) ||
      (expected.sourceOriginCounter !== null &&
        !integer(expected.sourceOriginCounter, 0, COUNTER_MAX))
    )
      throw new Error("invalid_metric_record_expectation");
    var values = record.values;
    var count = expected.endSample - expected.startSample;
    var origin = record.startSample - expected.startSample;
    if (
      record.sequence !== expected.sequence ||
      values[0] !== expected.sequence ||
      values[1] !== expected.startSample ||
      values[2] !== expected.endSample ||
      values[3] !== count ||
      record.endSample - record.startSample !== count ||
      count > Math.ceil((d.sampleRate * 60) / (20 * 4)) + 1 ||
      !integer(origin, 0, COUNTER_MAX - expected.endSample) ||
      (expected.sourceOriginCounter !== null &&
        origin !== expected.sourceOriginCounter) ||
      (d.kind === "native-detector-level/v1" &&
        (expected.startSample !== (expected.sequence - 1) * d.hopSamples ||
          count > d.windowSamples))
    )
      throw new Error("metric_record_coordinates_mismatch");
    var peaks = [values[4], values[5]];
    var sums = [values[6], values[7]];
    var rms = [];
    for (var channel = 0; channel < 2; channel++) {
      var peak = peaks[channel];
      var sum = sums[channel];
      var upper = count * peak * peak;
      var tolerance = 16 * 2.220446049250313e-16 * count * Math.max(upper, sum);
      if (
        peak < 0 ||
        peak > 64 ||
        sum < 0 ||
        (peak === 0 && sum !== 0) ||
        sum < peak * peak - tolerance ||
        sum > upper + tolerance
      )
        throw new Error("metric_record_moments_mismatch");
      var channelRms = Math.sqrt(sum / count);
      if (channelRms > 64) throw new Error("metric_record_moments_mismatch");
      rms.push(channelRms);
    }
    return Object.freeze({
      kind: d.kind,
      epoch: record.epoch,
      sequence: record.sequence,
      sourceOriginCounter: origin,
      startSample: expected.startSample,
      endSample: expected.endSample,
      count: count,
      peak: Object.freeze(peaks),
      rms: Object.freeze(rms),
      sumSquares: Object.freeze(sums),
    });
  }
  function ownerSnapshot(context) {
    var result = {};
    var names = [
      "generation",
      "passId",
      "connectionEpoch",
      "traceId",
      "correlationId",
      "causationId",
    ];
    for (var i = 0; i < names.length; i++) {
      var key = names[i];
      if (!context || !has.call(context, key)) continue;
      var value = context[key];
      if (key === "connectionEpoch" && integer(value, 0, VALUE_MAX))
        result[key] = value;
      else if (typeof value === "string") {
        result[key] =
          /^[A-Za-z0-9_:./-]{1,128}$/.test(value) &&
          !/(?:token|secret|password|bearer|authorization|github_pat_|gh[pousr]_|sk-|AKIA|ASIA)/i.test(
            value
          )
            ? value
            : "[redacted]";
      }
    }
    return Object.freeze(result);
  }
  function createReader(options) {
    // Caller applies returned actions in order, polls once per scheduler turn, and owns deadlines.
    // consume(record) must synchronously return true; lifecycle callbacks receive only safe snapshots.
    var declaration = validateDeclaration(options.declaration);
    if (
      !integer(options.epoch, 1, 1000000) ||
      typeof options.consume !== "function"
    ) {
      throw new Error("invalid_reader_options");
    }
    var epoch = options.epoch;
    var owner = ownerSnapshot(options.ownerContext);
    var consume = options.consume;
    var onEvent =
      typeof options.onEvent === "function" ? options.onEvent : null;
    var now =
      typeof options.now === "function"
        ? options.now
        : function () {
            return new Date().getTime();
          };
    var created = now();
    if (!numeric(created)) throw new Error("invalid_clock");
    var elapsed = 0;
    var state = "queued";
    var reason = null;
    var expected = 1;
    var candidate = null;
    var consecutive = false;
    var pendingAccepted = null;
    var ownerObserved = false;
    var lastProduced = 0;
    var lastAcknowledged = 0;
    var polling = false;
    var counts = {
      polls: 0,
      stale: 0,
      unstable: 0,
      waiting: 0,
      candidates: 0,
      accepted: 0,
      failures: 0,
      callbackErrors: 0,
    };
    function increment(key) {
      counts[key] = Math.min(VALUE_MAX, counts[key] + 1);
    }
    function stats() {
      return Object.freeze({
        state: state,
        reason: reason,
        expectedSequence: expected,
        elapsedMs: elapsed,
        polls: counts.polls,
        stale: counts.stale,
        unstable: counts.unstable,
        waiting: counts.waiting,
        candidates: counts.candidates,
        accepted: counts.accepted,
        failures: counts.failures,
        callbackErrors: counts.callbackErrors,
        candidatePending: candidate !== null,
        pendingControl: pendingAccepted !== null,
      });
    }
    function event(stage, eventReason) {
      var time;
      try {
        time = now();
      } catch (_) {
        time = created;
      }
      if (numeric(time))
        elapsed = Math.min(VALUE_MAX, Math.max(elapsed, time - created, 0));
      if (onEvent) {
        try {
          onEvent(
            Object.freeze({
              type: "listener-measurement-reader",
              stage: stage,
              ownerContext: owner,
              kind: declaration.kind,
              epoch: epoch,
              elapsedMs: elapsed,
              reason: eventReason === undefined ? reason : eventReason,
              stats: stats(),
            })
          );
        } catch (_) {
          increment("callbackErrors");
        }
      }
    }
    function terminal(stage, why) {
      if (state !== "queued" && state !== "started") return result();
      state = stage;
      reason = why;
      candidate = null;
      pendingAccepted = null;
      consecutive = false;
      consume = null;
      if (stage === "failed") increment("failures");
      event(stage);
      onEvent = null;
      return result();
    }
    function result(status, actions, record) {
      var value = { status: status || state, actions: actions || [] };
      if (record) value.record = record;
      if (reason) value.reason = reason;
      return value;
    }
    function fail(why) {
      return terminal("failed", why);
    }
    function begin() {
      if (state !== "queued") return result();
      state = "started";
      event("started");
      return state === "started"
        ? result("started", [{ type: "request", sequence: 1 }])
        : result();
    }
    function same(a, b) {
      if (a.startSample !== b.startSample || a.endSample !== b.endSample)
        return false;
      for (var i = 0; i < a.values.length; i++) {
        if (a.values[i] !== b.values[i]) return false;
      }
      return true;
    }
    function poll(row) {
      if (state !== "started") return result();
      if (polling) return fail("reentrant_poll");
      polling = true;
      try {
        return read(row);
      } finally {
        polling = false;
      }
    }
    function read(row) {
      increment("polls");
      // Old pages break consecutive settling but never erase immutable-slot evidence.
      if (
        Array.isArray(row) &&
        integer(row[1], 1, 1000000) &&
        row[1] !== epoch
      ) {
        consecutive = false;
        increment("stale");
        return result("stale");
      }
      var width = declaration.width;
      if (!Array.isArray(row) || row.length !== width + 14)
        return fail("invalid_arity");
      for (var i = 0; i < row.length; i++) {
        if (!numeric(row[i])) return fail("invalid_numeric");
      }
      if (row[0] !== 1) return fail("invalid_abi");
      // Reset clears ownership/readback, not the request Param; inactive requests carry no authority.
      if (row[1] === 0) {
        if (ownerObserved) return fail("invalid_owner_reset");
        if (!integer(row[2], 0, COUNTER_MAX) || row[2] !== row[width + 12])
          return fail("invalid_uninitialized_readback");
        for (var emptyIndex = 1; emptyIndex < row.length; emptyIndex++) {
          if (
            emptyIndex !== 2 &&
            emptyIndex !== width + 12 &&
            row[emptyIndex] !== 0
          )
            return fail("invalid_uninitialized_readback");
        }
        increment("waiting");
        return result("waiting");
      }
      if (
        !integer(row[1], 1, 1000000) ||
        !integer(row[3], 0, 1000000) ||
        !integer(row[2], 1, COUNTER_MAX) ||
        !integer(row[4], 0, COUNTER_MAX) ||
        !integer(row[5], 0, COUNTER_MAX) ||
        !integer(row[6], row[5], COUNTER_MAX) ||
        !integer(row[7], 0, COUNTER_MAX) ||
        !integer(row[8], 0, row[7]) ||
        !integer(row[9], 0, 2) ||
        !integer(row[width + 10], 0, COUNTER_MAX) ||
        !integer(row[width + 11], 0, 1000000) ||
        !integer(row[width + 12], 0, COUNTER_MAX) ||
        !integer(row[width + 13], 0, 1000000)
      )
        return fail("invalid_header_bounds");
      if (
        row[1] !== row[width + 13] ||
        row[2] !== row[width + 12] ||
        row[3] !== row[width + 11] ||
        row[4] !== row[width + 10]
      ) {
        // Channel snapshots can straddle an update; retain fingerprints, not settlement.
        consecutive = false;
        increment("unstable");
        event("progress", "unstable_acquisition");
        return state === "started" ? result("unstable") : result();
      }
      if (row[9] === 1) return fail("unread_capacity_overflow");
      if (row[9] === 2) return fail("invalid_dsp_control");
      if (row[7] - row[8] > declaration.capacity)
        return fail("unread_capacity_overflow");
      ownerObserved = true;
      if (
        row[8] > expected - 1 ||
        row[8] < lastAcknowledged ||
        row[7] < lastProduced
      )
        return fail("invalid_sequence_order");
      // Param writes are asynchronous. Retain at most the last accepted immutable slot
      // until the new request is observed, never treating this old page as fresh progress.
      if (pendingAccepted && row[2] === expected - 1) {
        if (
          row[3] !== epoch ||
          row[4] !== pendingAccepted.sequence ||
          row[7] < pendingAccepted.sequence ||
          row[8] >= pendingAccepted.sequence
        )
          return fail("invalid_sequence_order");
        if (
          !same(pendingAccepted, {
            startSample: row[5],
            endSample: row[6],
            values: row.slice(10, 10 + width),
          })
        )
          return fail("immutable_slot_changed");
        lastProduced = row[7];
        lastAcknowledged = row[8];
        increment("waiting");
        return result("waiting");
      }
      if (row[2] !== expected) {
        return fail("invalid_sequence_order");
      }
      pendingAccepted = null;
      lastProduced = row[7];
      lastAcknowledged = row[8];
      if (row[7] < expected) {
        if (candidate) return fail("slot_disappeared");
        increment("waiting");
        return result("waiting");
      }
      if (row[3] !== epoch || row[4] !== expected)
        return fail("invalid_slot_owner");
      var record = validateRecord(
        {
          version: 1,
          kind: declaration.kind,
          epoch: epoch,
          sequence: expected,
          startSample: row[5],
          endSample: row[6],
          values: row.slice(10, 10 + width),
        },
        declaration
      );
      if (!candidate) {
        candidate = record;
        consecutive = true;
        increment("candidates");
        return result("settling");
      }
      if (!same(candidate, record)) return fail("immutable_slot_changed");
      if (!consecutive) {
        consecutive = true;
        return result("settling");
      }
      // Request and ACK Params can execute in different DSP blocks. Do not
      // overwrite an unexecuted ACK with the next one: Gen rejects that jump.
      if (row[8] !== expected - 1) {
        increment("waiting");
        return result("waiting");
      }
      if (expected === COUNTER_MAX) return fail("sequence_exhausted");
      var accepted;
      try {
        accepted = consume(candidate);
      } catch (_) {
        return fail("consumer_failed");
      }
      if (state !== "started") return result();
      if (accepted !== true) return fail("consumer_rejected");
      candidate = null;
      pendingAccepted = record;
      consecutive = false;
      expected++;
      increment("accepted");
      event("progress");
      if (state !== "started") return result();
      // Separate Param writes must request the still-retained next slot before freeing this one.
      return result(
        "accepted",
        [
          { type: "request", sequence: expected },
          { type: "acknowledge", sequence: expected - 1 },
        ],
        record
      );
    }
    event("queued");
    return Object.freeze({
      declaration: declaration,
      ownerContext: owner,
      begin: begin,
      start: begin,
      poll: poll,
      complete: function () {
        return terminal("completed", "completed");
      },
      cancel: function () {
        return terminal("cancelled", "cancelled");
      },
      fail: function () {
        return fail("caller_failed");
      },
      stats: stats,
    });
  }
  return Object.freeze({
    COUNTER_MAX: COUNTER_MAX,
    VALUE_MAX: VALUE_MAX,
    validateDeclaration: validateDeclaration,
    validateRecord: validateRecord,
    createMetricDeclaration: createMetricDeclaration,
    normalizeMetricRecord: normalizeMetricRecord,
    createReader: createReader,
  });
})();
(function (api) {
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else if (typeof exports !== "undefined") {
    var names = Object.keys(api);
    for (var i = 0; i < names.length; i++) exports[names[i]] = api[names[i]];
  }
})(AudioListenerMeasurements);
