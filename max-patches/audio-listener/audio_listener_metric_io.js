/* eslint-disable-next-line no-unused-vars -- Max owns the writable inlet/outlet globals. */
/* global AudioListenerMeasurements, module, require, include, outlet, jsarguments, arrayfromargs, messagename, inlets:writable, outlets:writable */
/* eslint no-var: "off", vars-on-top: "off", no-unused-vars: ["error", { "caughtErrors": "none", "varsIgnorePattern": "^(inlets|outlets|anything|notifydeleted)$" }] */
// Metric source IO. No capability/READY advertisement, timers or persistence.
// Include audio_listener_measurements.js first in classic Max JS.
// The owner supplies a fixed absolute deadline and monotonically fresh native
// epochs. begin -> executed idle timing/configuration -> configure_metric -> arm
// -> executed sealed configuration AND timing -> verified launch -> family reads.
// control receives frozen ["envelope", exactGenParamName, numericValue] arrays.
// consume(family, normalizedRecord, frozenOwner) must synchronously accept true;
// this is bounded pass-local admission, not durable/public publication.
// send/onEvent receive frozen, bounded native-metric lifecycle evidence only.
// Timing/configuration frames carry a separately sampled native source counter;
// Readback wiring must preserve its acquisition attribution, not host time.
// stop/cancel/fatal request epoch0; release requires both fresh executed zero-
// active timing and cleared-seal configuration. callerTick owns all timeouts.
if (
  typeof module === "undefined" &&
  typeof AudioListenerMeasurements === "undefined" &&
  typeof include === "function"
)
  include("audio_listener_measurements.js");
// Keep ES5 call syntax without changing the parallel-owned formatter config.
// prettier-ignore
var AudioListenerMetricIO = (function (measurements) {
  "use strict";
  var MAX = 17592186044415;
  var FAMILIES = ["level", "detector-level"];
  var IDS = [
    "generation",
    "passId",
    "connectionEpoch",
    "traceId",
    "correlationId",
    "causationId",
  ];
  var CONFIG = [
    "sampleRate",
    "totalSamples",
    "hopSamples",
    "tempoBpm",
    "startBeatFraction",
    "captureVector",
    "levelConfigurationVersion",
    "reportStartBeat",
    "reportEndBeat",
    "reportRowCount",
  ];
  var RECEIPT_GROUPS = ["idle", "currentEpoch", "prelaunch", "cleanup"];
  var MISSING_RECEIPT = Object.freeze({ available: false, receipt: null });
  var LOCAL_FAILURES = [
    "invalid_arity",
    "invalid_numeric",
    "invalid_abi",
    "invalid_header_bounds",
    "unread_capacity_overflow",
    "invalid_sequence_order",
    "invalid_slot_owner",
    "immutable_slot_changed",
    "slot_disappeared",
    "sequence_exhausted",
    "consumer_failed",
    "consumer_rejected",
    "invalid_record",
    "invalid_values",
    "metric_record_coordinates_mismatch",
    "metric_record_moments_mismatch",
  ];
  function number(value) {
    return (
      typeof value === "number" && isFinite(value) && Math.abs(value) <= MAX
    );
  }
  function integer(value, low, high) {
    return (
      number(value) &&
      Math.floor(value) === value &&
      value >= low &&
      value <= high
    );
  }
  function numericRow(row, width) {
    if (!Array.isArray(row) || row.length !== width) return false;
    for (var i = 0; i < width; i++) {
      if (!number(row[i])) return false;
    }
    return true;
  }
  function sameOwner(a, b) {
    return (
      b &&
      IDS.every(function (key) {
        return a[key] === b[key];
      })
    );
  }
  function ownerCopy(owner) {
    var result = {};
    if (!owner || Object.keys(owner).length !== IDS.length)
      throw new Error("invalid_owner");
    IDS.forEach(function (key) {
      var value = owner[key];
      if (
        typeof value !== "string" ||
        !/^[A-Za-z0-9_:./-]{1,128}$/.test(value) ||
        /token|secret|password|bearer|authorization|github_pat_|gh[pousr]_|sk-|AKIA|ASIA/i.test(
          value
        )
      ) {
        throw new Error("invalid_owner");
      }
      result[key] = value;
    });
    return Object.freeze(result);
  }
  function geometry(value) {
    if (
      !value ||
      Object.keys(value).length !== CONFIG.length ||
      CONFIG.some(function (key) {
        return !number(value[key]);
      })
    )
      throw new Error("invalid_configuration");
    var c = {};
    CONFIG.forEach(function (key) {
      c[key] = value[key];
    });
    if (
      (c.sampleRate !== 44100 && c.sampleRate !== 48000) ||
      !integer(c.totalSamples, 1, 30 * c.sampleRate) ||
      c.hopSamples !== Math.round(c.sampleRate / 10) ||
      c.tempoBpm < 20 ||
      c.tempoBpm > 999 ||
      !integer(c.captureVector, 1, 1024) ||
      (c.captureVector & (c.captureVector - 1)) !== 0 ||
      c.levelConfigurationVersion !== 1 ||
      c.reportStartBeat < 0 ||
      c.reportEndBeat > 1576800 ||
      c.reportEndBeat <= c.reportStartBeat ||
      c.startBeatFraction !==
        c.reportStartBeat - Math.floor(c.reportStartBeat) ||
      !integer(c.reportRowCount, 1, 2000) ||
      c.reportRowCount !==
        Math.ceil(c.reportEndBeat * 4) - Math.floor(c.reportStartBeat * 4) ||
      c.totalSamples !==
        Math.round(
          ((c.reportEndBeat - c.reportStartBeat) * c.sampleRate * 60) /
            c.tempoBpm
        )
    )
      throw new Error("invalid_configuration");
    var bounds = [0];
    for (var n = 1; n <= c.reportRowCount; n++) {
      var beat = Math.min(
        (Math.floor(c.reportStartBeat * 4) + n) / 4,
        c.reportEndBeat
      );
      var end = Math.round(
        ((beat - c.reportStartBeat) * c.sampleRate * 60) / c.tempoBpm
      );
      if (end <= bounds[n - 1]) throw new Error("invalid_configuration");
      bounds.push(end);
    }
    return { configuration: Object.freeze(c), bounds: Object.freeze(bounds) };
  }
  function createMetricEnvelopeIO(options) {
    if (
      !options ||
      typeof options.control !== "function" ||
      typeof options.send !== "function" ||
      typeof options.consume !== "function"
    )
      throw new Error("invalid_metric_io_options");
    var now =
      options.now ||
      function () {
        return new Date().getTime();
      };
    var highwater = 0,
      pass = null,
      callbackDepth = 0,
      lastGeneration = null,
      eventQueue = [],
      delivering = false;
    function callback(fn, args) {
      callbackDepth++;
      try {
        return fn.apply(null, args);
      } finally {
        callbackDepth--;
      }
    }
    function clock() {
      var time = now();
      if (!number(time) || time < 0) throw new Error("invalid_clock");
      return time;
    }
    function emptyReceipts() {
      var groups = {};
      RECEIPT_GROUPS.forEach(function (name) {
        groups[name] = { timing: MISSING_RECEIPT, configuration: MISSING_RECEIPT };
      });
      return groups;
    }
    function rememberReceipt(group, family, raw, nativeSourceCounter) {
      pass.receipts[group][family] = Object.freeze({
        available: true,
        receipt: Object.freeze({
          raw: Object.freeze(raw.slice()),
          nativeSourceCounter: nativeSourceCounter,
          observedHostReceiptMs: clock(),
        }),
      });
      if (group !== "currentEpoch") return;
      var current = pass.receipts.currentEpoch;
      if (current.timing.available && current.configuration.available &&
        current.timing.receipt.raw[1] === -1 &&
        current.timing.receipt.nativeSourceCounter === current.configuration.receipt.nativeSourceCounter) {
        pass.receipts.prelaunch.timing = current.timing;
        pass.receipts.prelaunch.configuration = current.configuration;
      }
    }
    function event(family, stage, reason, extra) {
      var p = pass;
      p.elapsed = Math.max(p.elapsed, clock() - p.started, 0);
      var frame = {
        type: "native-metric",
        generation: p.owner.generation,
        owner: p.owner,
        nativeEpoch: p.epoch,
        family: family,
        status: stage,
        stage: stage,
        elapsedMs: p.elapsed,
        reason: reason || null,
      };
      if (extra) frame.progress = extra;
      var frozen = Object.freeze(frame);
      if (p.deliveryFailed) return;
      if (eventQueue.length >= 64) throw new Error("event_reentrancy_bound");
      eventQueue.push(frozen);
      if (delivering) return;
      delivering = true;
      try {
        while (eventQueue.length > 0) {
          var next = eventQueue.shift();
          callback(options.send, [next]);
          if (typeof options.onEvent === "function")
            callback(options.onEvent, [next]);
        }
      } catch (_) {
        eventQueue.length = 0;
        p.deliveryFailed = true;
        p.state = "failed";
        p.reason = "event_delivery_failed";
        cleanup();
        throw new Error("event_delivery_failed");
      } finally {
        delivering = false;
      }
    }
    function terminal() {
      return (
        !pass ||
        ["completed", "failed", "cancelled", "released"].indexOf(pass.state) >=
          0
      );
    }
    function gate(owner) {
      if (!pass || pass.state === "released") return false;
      if (!owner || owner.generation !== pass.owner.generation) return false;
      if (!sameOwner(pass.owner, owner)) {
        fatal("foreign_owner");
        return false;
      }
      return true;
    }
    function write(name, value) {
      if (pass.cleanup !== "blocked" && !(name === "epoch" && value === 0))
        return;
      callback(options.control, [Object.freeze(["envelope", name, value])]);
    }
    function cleanup() {
      if (pass.cleanup !== "blocked") return;
      pass.cleanup = "started";
      pass.stopTiming = false;
      pass.stopConfiguration = false;
      pass.stopCounter = pass.lastCounter;
      try {
        event("cleanup", "queued");
        event("cleanup", "started");
      } finally {
        try {
          write("epoch", 0);
        } catch (_) {
          pass.cleanup = "failed";
          event("cleanup", "failed", "control_failed");
        }
      }
    }
    function fatal(reason, detail) {
      if (!pass || pass.state === "released") return false;
      var cleaning = pass.cleanup === "started";
      if (!terminal()) {
        pass.state = "failed";
        pass.reason = reason;
        FAMILIES.forEach(function (name) {
          var f = pass.families[name];
          if (f && (f.state === "queued" || f.state === "started")) {
            f.state = "cancelled";
            if (f.reader) f.reader.cancel();
            event(name, "cancelled", "shared_failure");
          }
        });
        event("control", "failed", reason, detail);
      }
      if (cleaning) {
        pass.cleanup = "failed";
        event("cleanup", "failed", reason);
      } else cleanup();
      return false;
    }
    function familyFail(name, reason) {
      var f = pass.families[name];
      if (
        f.state === "failed" ||
        f.state === "completed" ||
        f.state === "cancelled"
      )
        return;
      f.state = "failed";
      f.reason = reason;
      if (f.reader) f.reader.fail();
      event(
        name,
        "failed",
        reason,
        Object.freeze({ accepted: f.accepted, expected: f.expected })
      );
    }
    function actions(name, result) {
      var f = pass.families[name];
      if (
        terminal() ||
        pass.cleanup !== "blocked" ||
        f.state === "failed" ||
        f.state === "cancelled"
      )
        return;
      if (result.status === "failed") {
        if (LOCAL_FAILURES.indexOf(result.reason) >= 0)
          familyFail(name, result.reason);
        else
          fatal(
            result.reason === "invalid_dsp_control"
              ? "shared_dsp_control"
              : "shared_reader_integrity"
          );
        return;
      }
      try {
        result.actions.forEach(function (action) {
          if (terminal() || pass.cleanup !== "blocked") return;
          write(
            f.prefix +
              (action.type === "request" ? "ReadSequence" : "Acknowledged"),
            action.sequence
          );
        });
      } catch (_) {
        fatal("control_failed");
      }
      if (!terminal() && f.accepted === f.expected && f.state === "started") {
        f.state = "completed";
        f.reader.complete();
        event(
          name,
          "completed",
          null,
          Object.freeze({ accepted: f.accepted, expected: f.expected })
        );
      }
    }
    function readers() {
      FAMILIES.forEach(function (name) {
        if (terminal() || pass.cleanup !== "blocked") return;
        var f = pass.families[name];
        if (f.state === "failed") return;
        f.reader = measurements.createReader({
          declaration: f.declaration,
          epoch: pass.epoch,
          ownerContext: pass.owner,
          now: now,
          onEvent: function (e) {
            if (["started", "progress"].indexOf(e.stage) < 0) return;
            event(
              name,
              e.stage,
              e.reason,
              Object.freeze({
                readerStage: e.stage,
                accepted: e.stats.accepted,
                polls: e.stats.polls,
              })
            );
          },
          consume: function (raw) {
            if (
              terminal() ||
              pass.state !== "capturing" ||
              pass.origin === null
            )
              return false;
            var start =
              name === "level"
                ? pass.bounds[raw.sequence - 1]
                : (raw.sequence - 1) * pass.config.hopSamples;
            var end =
              name === "level"
                ? pass.bounds[raw.sequence]
                : Math.min(
                    start + pass.config.hopSamples,
                    pass.config.totalSamples
                  );
            var record;
            try {
              record = measurements.normalizeMetricRecord(raw, f.declaration, {
                sequence: f.accepted + 1,
                startSample: start,
                endSample: end,
                sourceOriginCounter: pass.origin,
              });
            } catch (error) {
              if (LOCAL_FAILURES.indexOf(error.message) >= 0)
                familyFail(name, error.message);
              else fatal("shared_normalization_integrity");
              return false;
            }
            var accepted;
            try {
              accepted = callback(options.consume, [name, record, pass.owner]);
            } catch (_) {
              familyFail(name, "consumer_failed");
              return false;
            }
            if (terminal() || f.state !== "started") return false;
            if (accepted !== true) {
              familyFail(name, "consumer_rejected");
              return false;
            }
            f.accepted++;
            return true;
          },
        });
        if (terminal() || pass.cleanup !== "blocked") f.reader.cancel();
      });
    }
    function begin(input) {
      if (callbackDepth > 0) throw new Error("reentrant_begin");
      if (pass && pass.state !== "released") throw new Error("metric_io_busy");
      var owner = ownerCopy(input.owner);
      if (!integer(input.nativeEpoch, highwater + 1, 1000000))
        throw new Error("invalid_native_epoch");
      if (owner.generation === lastGeneration)
        throw new Error("reused_generation");
      var time = clock();
      if (!number(input.deadlineMs) || input.deadlineMs <= time)
        throw new Error("invalid_deadline");
      highwater = input.nativeEpoch;
      lastGeneration = owner.generation;
      pass = {
        owner: owner,
        epoch: highwater,
        deadline: input.deadlineMs,
        started: time,
        elapsed: 0,
        state: "idle",
        reason: null,
        cleanup: "blocked",
        config: null,
        idleTiming: false,
        idleConfiguration: false,
        receipt: false,
        timingReceipt: false,
        readbackSkips: 0,
        origin: null,
        armCounter: null,
        launchClock: null,
        launchPhaseSamples: null,
        lastCounter: null,
        idleSeenEpoch: null,
        stopCounter: null,
        families: {},
        deliveryFailed: false,
        receipts: emptyReceipts(),
      };
      event("control", "queued");
      return true;
    }
    function configure_metric(owner, configuration) {
      if (!gate(owner)) return false;
      if (callbackDepth > 0) return fatal("reentrant_control");
      if (pass.config !== null) return fatal("configuration_mutation");
      if (pass.state !== "idle" || !pass.idleTiming || !pass.idleConfiguration)
        throw new Error("configuration_requires_executed_idle");
      var g = geometry(configuration);
      pass.config = g.configuration;
      pass.bounds = g.bounds;
      pass.state = "configured";
      FAMILIES.forEach(function (name) {
        pass.families[name] = {
          declaration: measurements.createMetricDeclaration({
            family: name,
            sampleRate: pass.config.sampleRate,
          }),
          prefix: name === "level" ? "levelMeasurement" : "attackMeasurement",
          state: "queued",
          reason: null,
          accepted: 0,
          expected:
            name === "level"
              ? pass.config.reportRowCount
              : Math.ceil(pass.config.totalSamples / pass.config.hopSamples),
        };
      });
      FAMILIES.forEach(function (name) {
        if (!terminal() && pass.cleanup === "blocked") event(name, "queued");
      });
      if (terminal() || pass.cleanup !== "blocked") return false;
      try {
        CONFIG.forEach(function (key) {
          if (key !== "sampleRate") write(key, pass.config[key]);
        });
      } catch (_) {
        return fatal("control_failed");
      }
      return true;
    }
    function arm(owner) {
      if (!gate(owner)) return false;
      if (callbackDepth > 0) return fatal("reentrant_control");
      if (pass.state !== "configured")
        throw new Error("arm_requires_configuration");
      pass.state = "arming";
      event("control", "started");
      if (terminal() || pass.cleanup !== "blocked") return false;
      readers();
      if (terminal() || pass.cleanup !== "blocked") return false;
      try {
        FAMILIES.forEach(function (name) {
          var f = pass.families[name];
          write(f.prefix + "Epoch", 0);
          write(f.prefix + "Acknowledged", 0);
          write(f.prefix + "ReadSequence", 1);
          write(f.prefix + "Epoch", pass.epoch);
        });
        write("epoch", pass.epoch);
      } catch (_) {
        return fatal("control_failed");
      }
      return true;
    }
    function maybeArmed() {
      if (pass.state !== "arming" || !pass.receipt || !pass.timingReceipt)
        return;
      pass.state = pass.origin === null ? "armed" : "capturing";
      event("control", "progress", "executed_configuration");
      FAMILIES.forEach(function (name) {
        if (terminal()) return;
        var f = pass.families[name];
        if (f.state === "failed") return;
        f.state = "started";
        if (terminal() || pass.cleanup !== "blocked") return;
        actions(name, f.reader.begin());
      });
      if (pass.origin !== null && !terminal())
        event("control", "progress", "verified_launch");
    }
    function cleanupConfirmed() {
      if (
        pass.cleanup !== "started" ||
        !pass.stopTiming ||
        !pass.stopConfiguration
      )
        return;
      pass.cleanup = "completed";
      event("cleanup", "completed");
      if (pass.state === "stopping") {
        // Control completion is not source coverage or observation viability.
        // The controller/collector own requested-metric and usable-prefix policy.
        pass.state = "completed";
        pass.reason = null;
        event("control", pass.state, pass.reason);
      }
    }
    function maybeIdle() {
      if (pass.state === "idle" && pass.idleTiming && pass.idleConfiguration && !pass.idleAnnounced) {
        pass.idleAnnounced = true;
        event("control", "progress", "executed_idle");
      }
    }
    function metric_configuration_frame(owner, row, sourceCounter) {
      if (!gate(owner)) return false;
      if (pass.cleanup === "completed" || pass.cleanup === "failed")
        return false;
      if (!integer(sourceCounter, 0, MAX) || !numericRow(row, 12))
        return fatal("invalid_shared_configuration");
      if (pass.cleanup === "started") {
        pass.stopConfiguration =
          (pass.stopCounter === null || sourceCounter > pass.stopCounter) &&
          row[10] === 0 &&
          row[0] === row[11] &&
          (row[0] === pass.epoch || row[0] === pass.idleSeenEpoch);
        if (pass.stopConfiguration) rememberReceipt("cleanup", "configuration", row, sourceCounter);
        cleanupConfirmed();
        return pass.stopConfiguration;
      }
      if (pass.lastCounter !== null && sourceCounter < pass.lastCounter)
        return fatal("shared_clock_regressed");
      pass.lastCounter = sourceCounter;
      if (pass.state === "idle") {
        if (
          row[10] !== 0 ||
          row[0] !== row[11] ||
          !integer(row[0], 0, pass.epoch - 1)
        )
          return fatal("foreign_configuration_owner");
        pass.idleConfiguration = true;
        pass.idleSeenEpoch = row[0];
        rememberReceipt("idle", "configuration", row, sourceCounter);
        maybeIdle();
        return true;
      }
      if (pass.state === "configured") {
        if (
          row[0] !== pass.idleSeenEpoch ||
          row[11] !== pass.idleSeenEpoch ||
          row[10] !== 0
        )
          return fatal("foreign_configuration_owner");
        rememberReceipt("idle", "configuration", row, sourceCounter);
        return true;
      }
      if (
        pass.state === "arming" &&
        !pass.receipt &&
        row[0] === pass.idleSeenEpoch &&
        row[11] === pass.idleSeenEpoch &&
        row[10] === 0
      )
        return false;
      var c = pass.config;
      var expected = [
        pass.epoch,
        c.totalSamples,
        c.hopSamples,
        c.tempoBpm,
        c.startBeatFraction,
        c.captureVector,
        c.levelConfigurationVersion,
        c.reportStartBeat,
        c.reportEndBeat,
        c.reportRowCount,
        pass.epoch,
        pass.epoch,
      ];
      if (
        row.some(function (v, i) {
          return v !== expected[i];
        })
      )
        return fatal("executed_configuration_mismatch");
      rememberReceipt("currentEpoch", "configuration", row, sourceCounter);
      pass.receipt = true;
      maybeArmed();
      return true;
    }
    function skipReadback(owner, bank, before, after) {
      if (!gate(owner)) return false;
      if (pass.cleanup === "completed" || pass.cleanup === "failed") return false;
      if (["metric_configuration_sample", "metric_timing_sample", "metric_level_sample", "metric_detector_sample"].indexOf(bank) < 0 ||
        !integer(before, 0, MAX) || !integer(after, 0, MAX) || after <= before ||
        pass.readbackSkips >= 1000000) return fatal("invalid_shared_timing");
      pass.readbackSkips++;
      if (pass.readbackSkips === 1 || pass.readbackSkips % 16 === 0)
        event("control", "progress", "readback_cohort_skipped", Object.freeze({
          bank: bank,
          skipped: pass.readbackSkips,
          counterBefore: before,
          counterAfter: after,
        }));
      return false;
    }
    function metric_timing_frame(owner, row, sourceCounter, readbackFailure) {
      if (!gate(owner)) return false;
      if (pass.cleanup === "completed" || pass.cleanup === "failed")
        return false;
      if (
        !numericRow(row, 8) ||
        !integer(sourceCounter, 0, MAX) ||
        row[7] !== 3 ||
        !integer(row[0], 0, 1000000) ||
        !integer(row[2], 0, 15) ||
        !integer(row[3], 0, 1)
      )
        return fatal("invalid_shared_timing", readbackFailure || Object.freeze({
          readback: Object.freeze(Array.isArray(row) ? row.slice(0, 8) : []),
          sourceCounter: sourceCounter,
        }));
      if (pass.cleanup === "started") {
        pass.stopTiming =
          (pass.stopCounter === null || sourceCounter > pass.stopCounter) &&
          row[0] === 0 &&
          row[3] === 0;
        if (pass.stopTiming) rememberReceipt("cleanup", "timing", row, sourceCounter);
        cleanupConfirmed();
        return pass.stopTiming;
      }
      if (pass.lastCounter !== null && sourceCounter < pass.lastCounter)
        return fatal("shared_clock_regressed");
      pass.lastCounter = sourceCounter;
      if (pass.state === "idle" || pass.state === "configured") {
        if (row[0] !== 0 || row[3] !== 0) return fatal("foreign_timing_owner");
        pass.idleTiming = true;
        rememberReceipt("idle", "timing", row, sourceCounter);
        maybeIdle();
        return true;
      }
      if (
        pass.state === "arming" &&
        !pass.timingReceipt &&
        row[0] === 0 &&
        row[3] === 0
      )
        return false;
      if (row[0] !== pass.epoch || row[2] !== 0)
        return fatal("shared_dsp_rejected");
      if (
        !integer(row[5], 0, sourceCounter) ||
        (pass.armCounter !== null && pass.armCounter !== row[5])
      )
        return fatal("shared_arm_counter");
      pass.armCounter = row[5];
      pass.timingReceipt = true;
      if (row[1] !== -1) {
        if (
          !integer(row[1], 0, MAX) ||
          row[5] + row[1] > sourceCounter ||
          !integer(row[4], 0, pass.config.captureVector) ||
          !integer(row[6], pass.armCounter, sourceCounter) ||
          row[6] !== pass.armCounter + row[1] - row[4] ||
          (pass.origin !== null &&
            (pass.origin !== row[6] ||
              pass.launchClock !== row[1] ||
              pass.launchPhaseSamples !== row[4]))
        )
          return fatal("shared_launch_coordinates");
        var finalCounter =
          row[6] + pass.config.totalSamples + pass.config.captureVector - 1;
        if (
          (row[3] === 0 && sourceCounter < finalCounter) ||
          (row[3] === 1 && sourceCounter >= finalCounter)
        )
          return fatal("shared_active_interval");
        var launched = pass.origin === null;
        pass.origin = row[6];
        pass.launchClock = row[1];
        pass.launchPhaseSamples = row[4];
        rememberReceipt("currentEpoch", "timing", row, sourceCounter);
        if (pass.state === "armed") {
          pass.state = "capturing";
          if (launched) event("control", "progress", "verified_launch");
        }
      } else if (
        pass.origin !== null ||
        row[3] !== 0 ||
        row[4] !== -1 ||
        row[6] !== -1
      )
        return fatal("shared_launch_reset");
      else rememberReceipt("currentEpoch", "timing", row, sourceCounter);
      maybeArmed();
      return true;
    }
    function frame(name, owner, row) {
      if (!gate(owner) || terminal() || pass.cleanup !== "blocked")
        return false;
      var f = pass.families[name];
      if (!f || f.state === "completed" || f.state === "failed") return false;
      if (Array.isArray(row) && integer(row[1], pass.epoch + 1, 1000000))
        return fatal("foreign_metric_epoch");
      if (pass.state !== "capturing") {
        if (!numericRow(row, 22)) familyFail(name, "unavailable_output");
        return false;
      }
      try {
        actions(name, f.reader.poll(row));
      } catch (error) {
        if (LOCAL_FAILURES.indexOf(error.message) >= 0)
          familyFail(name, error.message);
        else fatal("shared_reader_integrity");
      }
      return true;
    }
    function stop(owner) {
      if (!gate(owner)) return false;
      if (!terminal() && pass.state !== "stopping") {
        pass.state = "stopping";
        FAMILIES.forEach(function (name) {
          var f = pass.families[name];
          if (f && f.state !== "completed" && f.state !== "failed")
            familyFail(name, "incomplete_at_stop");
        });
      }
      cleanup();
      return true;
    }
    function cancel(owner) {
      if (!gate(owner) || terminal()) return false;
      pass.state = "cancelled";
      pass.reason = "cancelled";
      FAMILIES.forEach(function (name) {
        var f = pass.families[name];
        if (f && f.state !== "completed" && f.state !== "failed") {
          f.state = "cancelled";
          if (f.reader) f.reader.cancel();
          event(name, "cancelled");
        }
      });
      event("control", "cancelled");
      cleanup();
      return true;
    }
    function callerTick(owner) {
      if (!gate(owner)) return false;
      if (clock() < pass.deadline || pass.cleanup === "completed") return true;
      if (!terminal()) fatal("deadline_exceeded");
      if (pass.cleanup === "started") {
        pass.cleanup = "failed";
        event("cleanup", "failed", "cleanup_deadline_exceeded");
      }
      return false;
    }
    function release(owner) {
      if (callbackDepth > 0) return false;
      if (!gate(owner) || pass.cleanup !== "completed" || !terminal())
        return false;
      pass.state = "released";
      return true;
    }
    function snapshot() {
      if (!pass)
        return Object.freeze({ state: "blocked", epochHighwater: highwater });
      var families = {};
      FAMILIES.forEach(function (name) {
        var f = pass.families[name];
        if (f)
          families[name] = Object.freeze({
            state: f.state,
            reason: f.reason,
            accepted: f.accepted,
            expected: f.expected,
          });
      });
      return Object.freeze({
        state: pass.state,
        reason: pass.reason,
        cleanup: pass.cleanup,
        owner: pass.owner,
        nativeEpoch: pass.epoch,
        epochHighwater: highwater,
        sourceOriginCounter: pass.origin,
        idleConfirmed: pass.idleTiming && pass.idleConfiguration,
        families: Object.freeze(families),
      });
    }
    // Raw receipts are not nativeReady, source coverage or publication authority.
    // Host receipt time records admission, never native sample position/freshness.
    // The prelaunch group retains only equal-counter actual row pairs; cleanup
    // never erases them. Current-epoch rows can have different acquisition stamps.
    function evidence(owner) {
      if (!gate(owner)) return false;
      var groups = {};
      RECEIPT_GROUPS.forEach(function (name) {
        groups[name] = Object.freeze({
          timing: pass.receipts[name].timing,
          configuration: pass.receipts[name].configuration,
        });
      });
      return Object.freeze({
        type: "native-metric-envelope-evidence/v1",
        owner: pass.owner,
        nativeEpoch: pass.epoch,
        status: pass.state,
        cleanup: pass.cleanup,
        reason: pass.reason,
        diagnosticOnly: pass.state === "failed" || pass.state === "cancelled" || pass.cleanup === "failed",
        receipts: Object.freeze(groups),
      });
    }
    return Object.freeze({
      begin: begin,
      configure_metric: configure_metric,
      arm: arm,
      metric_configuration_frame: metric_configuration_frame,
      metric_timing_frame: metric_timing_frame,
      skipReadback: skipReadback,
      metric_level_frame: function (owner, row) {
        return frame("level", owner, row);
      },
      metric_detector_frame: function (owner, row) {
        return frame("detector-level", owner, row);
      },
      stop: stop,
      cancel: cancel,
      callerTick: callerTick,
      release: release,
      snapshot: snapshot,
      evidence: evidence,
    });
  }
  // Control selectors start with all six IDS, then their control arguments.
  // Native readbacks use the counter-cohorted Max adapter below.
  function handlersFor(io) {
    var handlers = {};
    [
      "begin",
      "configure_metric",
      "arm",
      "stop",
      "cancel",
      "callerTick",
      "release",
    ].forEach(function (selector) {
      handlers[selector] = function () {
        var args = Array.prototype.slice.call(arguments),
          owner = {};
        IDS.forEach(function (key, i) {
          owner[key] = args[i];
        });
        var rest = args.slice(IDS.length);
        var arity =
          selector === "begin"
            ? 2
            : selector === "configure_metric"
              ? 10
              : 0;
        if (rest.length !== arity) throw new Error("invalid_selector_arity");
        if (selector === "begin")
          return io.begin({
            owner: owner,
            nativeEpoch: rest[0],
            deadlineMs: rest[1],
          });
        if (selector === "configure_metric") {
          var configuration = {};
          CONFIG.forEach(function (key, i) {
            configuration[key] = rest[i];
          });
          return io.configure_metric(owner, configuration);
        }
        return io[selector](owner);
      };
    });
    return Object.freeze(handlers);
  }
  // The actual js entry owns fixed-size pass-result storage, not another DSP
  // FIFO. Clean-stop reads and eager-prefix reads share this accepted store.
  // Prefix handoff is input for a separate collector, not publication authority.
  // A clean control stop exposes validated prefixes, including failed families;
  // it does not assert an endpoint or a publishable observation.
  // Numeric readbacks are accepted only during the synchronous outlet2 poll;
  // that cohort freezes attribution while native counter bookends prove sample
  // provenance. Neither a poll request nor a wall clock is native evidence.
  function createMaxAdapter(options) {
    if (!options || typeof options.emit !== "function") throw new Error("invalid_max_adapter");
    var currentOwner = null, pollOwner = null, pollSeen = null, pollCounters = null,
      watermark = null, floor = null, captureVector = null,
      records = {}, closed = false, io;
    function emit(index, values) { options.emit(index, Object.freeze(values)); }
    function packet(selector, value) { emit(0, [selector, JSON.stringify(value)]); }
    io = createMetricEnvelopeIO({
      now: options.now,
      send: function (frame) { packet("native_metric", frame); },
      control: function (action) { emit(1, [action[1], action[2]]); },
      consume: function (family, record) {
        var rows = records[family];
        if (!rows || record.sequence < 1 || record.sequence > rows.length ||
          rows[record.sequence - 1] !== undefined || !currentOwner ||
          !sameOwner(io.snapshot().owner, currentOwner) || !pollCounters ||
          !integer(pollCounters[family], 0, MAX) ||
          record.sourceOriginCounter + record.endSample + captureVector - 1 > pollCounters[family])
          return false;
        rows[record.sequence - 1] = record;
        return true;
      },
    });
    var handlers = handlersFor(io);
    function ownerFrom(args) {
      var owner = {};
      IDS.forEach(function (key, index) { owner[key] = args[index]; });
      return owner;
    }
    function sameCurrent(owner) {
      if (!currentOwner || owner.generation !== currentOwner.generation) return false;
      if (!sameOwner(currentOwner, owner)) { io.callerTick(owner); return false; }
      return true;
    }
    function prefixRecord(owner, family, sequence) {
      if (closed || !sameCurrent(owner)) return false;
      var state = io.snapshot(), health = state.families[family];
      if (["capturing", "stopping", "completed"].indexOf(state.state) < 0 ||
        state.cleanup === "failed" ||
        (state.state === "completed" && state.cleanup !== "completed") ||
        !integer(state.sourceOriginCounter, 0, MAX) ||
        FAMILIES.indexOf(family) < 0 || !health ||
        !integer(sequence, 1, health.expected) || sequence > health.accepted)
        throw new Error("metric_prefix_record_unavailable");
      var record = records[family] && records[family][sequence - 1];
      if (!record || record.sequence !== sequence || record.epoch !== state.nativeEpoch ||
        record.sourceOriginCounter !== state.sourceOriginCounter)
        throw new Error("metric_prefix_record_unavailable");
      return Object.freeze({ owner: currentOwner, nativeEpoch: state.nativeEpoch,
        sourceOriginCounter: state.sourceOriginCounter, family: family, record: record });
    }
    function readback(selector, args) {
      if (!pollOwner || !currentOwner || !sameOwner(pollOwner, currentOwner)) return false;
      if (pollSeen[selector]) return false;
      pollSeen[selector] = true;
      var timing = selector === "metric_timing_sample";
      var configuration = selector === "metric_configuration_sample";
      var width = timing ? 8 : configuration ? 12 : 22;
      if (!timing && !configuration && args.length !== width + 2)
        return io[selector === "metric_level_sample" ? "metric_level_frame" : "metric_detector_frame"](pollOwner, null);
      if (args.length === width + 2 && integer(args[0], 0, MAX) &&
        integer(args[width + 1], 0, MAX) && args[width + 1] > args[0])
        return io.skipReadback(pollOwner, selector, args[0], args[width + 1]);
      if (args.length !== width + 2 || !integer(args[0], 0, MAX) ||
        !integer(args[width + 1], 0, MAX) || args[0] !== args[width + 1]) {
        // A torn counter cohort is shared corruption, never a family downgrade.
        return io.metric_timing_frame(pollOwner, null, null, Object.freeze({
          bank: selector,
          expectedWidth: width + 2,
          actualWidth: args.length,
          counterBefore: args[0],
          counterAfter: args[width + 1],
        }));
      }
      var counter = args[0];
      if (floor !== null && counter <= floor) return false;
      if (watermark !== null && counter < watermark)
        return io.metric_timing_frame(pollOwner, null, null, Object.freeze({
          bank: selector,
          counterBefore: counter,
          watermark: watermark,
        }));
      if (watermark === null || counter > watermark) watermark = counter;
      var row = args.slice(1, width + 1);
      if (timing) return io.metric_timing_frame(pollOwner, row, counter);
      if (configuration) return io.metric_configuration_frame(pollOwner, row, counter);
      pollCounters[selector === "metric_level_sample" ? "level" : "detector-level"] = counter;
      return io[selector === "metric_level_sample" ? "metric_level_frame" : "metric_detector_frame"](pollOwner, row);
    }
    function poll() {
      if (!currentOwner || closed) return false;
      if (pollOwner !== null) return io.metric_timing_frame(currentOwner, null, null);
      io.callerTick(currentOwner);
      var state = io.snapshot();
      if (state.cleanup === "completed" || state.cleanup === "failed") {
        emit(1, ["poll", 0]); return false;
      }
      pollOwner = currentOwner;
      pollSeen = {};
      pollCounters = {};
      try { emit(2, ["poll_frames"]); }
      finally {
        pollOwner = null;
        pollSeen = null;
        pollCounters = null;
        var cleanupState = io.snapshot().cleanup;
        if (cleanupState === "completed" || cleanupState === "failed") emit(1, ["poll", 0]);
      }
      return true;
    }
    function dispatch(selector, args) {
      if (closed) return false;
      if (!Array.isArray(args)) throw new Error("invalid_selector_arguments");
      if (selector === "metric_guard_stop") {
        if (args.length !== 1) throw new Error("invalid_selector_arity");
        if (!currentOwner || args[0] !== currentOwner.generation) return false;
        io.cancel(currentOwner);
        emit(1, ["epoch", 0]);
        return true;
      }
      if (selector === "metric_poll") {
        if (args.length !== 0) throw new Error("invalid_selector_arity");
        return poll();
      }
      if (["metric_timing_sample", "metric_configuration_sample", "metric_level_sample", "metric_detector_sample"].indexOf(selector) >= 0)
        return readback(selector, args);
      if (["begin", "configure_metric", "arm", "stop", "cancel", "callerTick", "release", "metric_status", "metric_record", "metric_spectrum_poll", "metric_evidence", "metric_prefix_record"].indexOf(selector) < 0)
        throw new Error("unknown_metric_selector");
      var owner = ownerFrom(args);
      if (selector !== "begin" && !sameCurrent(owner)) return false;
      if (selector === "begin") {
        if (pollOwner !== null) throw new Error("begin_during_poll");
        var begun = handlers.begin.apply(null, args);
        currentOwner = io.snapshot().owner;
        floor = watermark; records = {}; captureVector = null;
        emit(1, ["poll", 1]);
        return begun;
      }
      if (selector === "metric_status") {
        if (args.length !== 6) throw new Error("invalid_selector_arity");
        packet("native_metric_status", io.snapshot()); return true;
      }
      if (selector === "metric_evidence") {
        if (args.length !== 6) throw new Error("invalid_selector_arity");
        var admitted = io.evidence(owner);
        if (admitted === false) return false;
        packet("native_metric_evidence", admitted); return true;
      }
      if (selector === "metric_prefix_record") {
        if (args.length !== 8) throw new Error("invalid_selector_arity");
        var prefix = prefixRecord(owner, args[6], args[7]);
        if (prefix === false) return false;
        packet("native_metric_prefix_record", prefix); return true;
      }
      if (selector === "metric_spectrum_poll") {
        if (args.length !== 7 || !integer(args[6], 0, 1))
          throw new Error("invalid_selector_arity");
        if (args[6] === 1 && io.snapshot().cleanup !== "blocked") return false;
        emit(2, ["spectrum_poll", args[6]]); return true;
      }
      if (selector === "metric_record") {
        if (args.length !== 8) throw new Error("invalid_selector_arity");
        var snapshot = io.snapshot(), family = args[6], sequence = args[7];
        if (snapshot.state !== "completed" || snapshot.cleanup !== "completed" ||
          FAMILIES.indexOf(family) < 0 || !integer(sequence, 1, 2000) ||
          !records[family] || !records[family][sequence - 1])
          throw new Error("metric_record_unavailable");
        packet("native_metric_record", Object.freeze({ owner: currentOwner,
          nativeEpoch: snapshot.nativeEpoch, family: family, record: records[family][sequence - 1] }));
        return true;
      }
      var result = handlers[selector].apply(null, args);
      if (selector === "configure_metric" && result === true) {
        captureVector = args[IDS.length + 5];
        var families = io.snapshot().families;
        FAMILIES.forEach(function (name) { records[name] = new Array(families[name].expected); });
      }
      if (selector === "release" && result === true) {
        currentOwner = null; records = {}; emit(1, ["poll", 0]); emit(2, ["spectrum_poll", 0]);
      }
      return result;
    }
    return Object.freeze({
      dispatch: dispatch,
      snapshot: io.snapshot,
      prefixRecord: prefixRecord,
      shutdown: function () {
        if (currentOwner) io.cancel(currentOwner);
        emit(1, ["poll", 0]); emit(2, ["spectrum_poll", 0]); closed = true; records = {};
      },
    });
  }
  return Object.freeze({
    createMetricEnvelopeIO: createMetricEnvelopeIO,
    createMaxAdapter: createMaxAdapter,
    configurationFields: Object.freeze(CONFIG),
    ownerFields: Object.freeze(IDS),
  });
})(
  typeof module !== "undefined" && module.exports
    ? require("./audio_listener_measurements.js")
    : AudioListenerMeasurements
);
if (typeof module !== "undefined" && module.exports)
  module.exports = AudioListenerMetricIO;
var metricMaxAdapter = null;
// prettier-ignore
if (typeof outlet === "function" && typeof jsarguments !== "undefined") {
  if (jsarguments.length !== 2 || jsarguments[1] !== "musical-v1")
    throw new Error("unsupported_metric_io_mode");
  inlets = 1;
  outlets = 3;
  metricMaxAdapter = AudioListenerMetricIO.createMaxAdapter({
    emit: function (index, values) { outlet(index, values); }
  });
}
function anything() {
  if (metricMaxAdapter)
    return metricMaxAdapter.dispatch(messagename, arrayfromargs(arguments));
}
function notifydeleted() {
  if (metricMaxAdapter) metricMaxAdapter.shutdown();
}
