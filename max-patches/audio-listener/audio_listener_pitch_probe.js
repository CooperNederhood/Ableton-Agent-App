/* global require, module, Buffer */
"use strict";

const { randomUUID } = require("node:crypto");

// Stock output lists are paired diagnostic snapshots, never FFT-frame witnesses.
function createPitchSmoke({ now, sendControl, emit }) {
  let pass = null;
  function event(stage, reason) {
    // Reserve terminal/failure headroom even if progress callbacks are sparse.
    // The full 400-delivery, 100ms horizon normally uses <=80 progress events.
    if (stage === "progress" && pass.events >= 88) return;
    const observed = (value) => ({ state: "observed", value });
    const optional = (value) =>
      value === null
        ? { state: "unavailable", reason: "not-reported" }
        : observed(value);
    const facts = Object.entries({
      schema: "flucoma-pitch-smoke/v1",
      support: "unqualified",
      valueValidity: "unqualified",
      units: "Hz",
      algorithm: "YinFFT",
      minfreq: 50,
      maxfreq: 2000,
      channelPolicy: "independent-stereo",
      windowSamples: 2048,
      hopSamples: 2048,
      fftSamples: 2048,
      confidenceSemantics: "yinfft-score-not-probability",
      undefinedHz: 0,
      leftDeliveries: pass.counts[0],
      rightDeliveries: pass.counts[1],
      leftCandidates: pass.candidates[0],
      rightCandidates: pass.candidates[1],
      cleanup: pass.cleanup,
    }).map(([field, value]) => ({
      field: `pitch.${field}`,
      actual: observed(value),
    }));
    for (const [index, channel] of ["left", "right"].entries()) {
      facts.push(
        {
          field: `pitch.${channel}Hz`,
          actual: optional(pass.pairs[index]?.[0] ?? null),
        },
        {
          field: `pitch.${channel}Confidence`,
          actual: optional(pass.pairs[index]?.[1] ?? null),
        },
        {
          field: `pitch.${channel}Class`,
          actual: optional(pass.classes[index]),
        },
      );
    }
    const lifecycle = {
      scope: "independent-metric-timelines/v1",
      metric: "monophonic-pitch",
      eventId: randomUUID(),
      causationId: pass.lastEvent,
      generation: pass.control.generation,
      nativeEpoch: pass.epoch,
      stage,
      phase: pass.cleanup === "not-started" ? "capture" : "drain",
      elapsedMs: pass.passElapsedAtStart + now() - pass.startedAt,
      durationMs: now() - pass.stageStartedAt,
      frames: 0,
      reason,
      facts,
    };
    if (
      ++pass.events > 96 ||
      facts.length !== 24 ||
      Buffer.byteLength(JSON.stringify(lifecycle)) > 8192
    )
      throw new Error("pitch_diagnostic_limit");
    pass.lastEvent = lifecycle.eventId;
    try {
      if (emit(pass.control, lifecycle) !== true) {
        pass.diagnosticDeliveryFailed = true;
        if (!pass.cancelled)
          throw new Error("pitch_diagnostic_delivery_failed");
      }
    } catch (error) {
      pass.diagnosticDeliveryFailed = true;
      throw error;
    }
  }
  function fail(reason) {
    if (pass.failure) return;
    pass.failure = reason;
    event("failed", reason);
  }
  return Object.freeze({
    start(control, epoch, causationId, passElapsedAtStart = 0) {
      if (pass && pass.cleanup !== "completed")
        throw new Error("pitch_probe_still_owned");
      pass = {
        control,
        epoch,
        passElapsedAtStart,
        startedAt: now(),
        stageStartedAt: now(),
        lastEvent: causationId,
        cleanup: "not-started",
        acknowledged: false,
        counts: [0, 0],
        sequences: [0, 0],
        candidates: [0, 0],
        pairs: [null, null],
        classes: [null, null],
        failure: null,
        cancelled: false,
        diagnosticDeliveryFailed: false,
        events: 0,
        lastProgressAt: -Infinity,
      };
      try {
        event("queued", "pitch_smoke_capture");
      } finally {
        // Even a rejected queued event must leave a stoppable physical owner.
        sendControl("begin", control.generation, epoch);
      }
    },
    receive(packet) {
      if (
        !pass ||
        !Array.isArray(packet) ||
        packet.length < 3 ||
        packet[0] !== pass.control.generation ||
        packet[1] !== pass.epoch ||
        pass.cleanup === "completed"
      )
        throw new Error("pitch_foreign_or_late_packet");
      const kind = packet[2];
      if (kind === "value") {
        const [, , , channel, sequence, hz, confidence] = packet;
        if (
          packet.length !== 7 ||
          !pass.acknowledged ||
          ![0, 1].includes(channel) ||
          !Number.isSafeInteger(sequence) ||
          sequence !== pass.sequences[channel] + 1 ||
          sequence > 400
        )
          throw new Error("pitch_invalid_envelope");
        pass.sequences[channel] = sequence;
        if (pass.cleanup === "pending" || pass.failure) return;
        if (
          typeof hz !== "number" ||
          !Number.isFinite(hz) ||
          (hz !== 0 && (hz < 50 || hz > 2000)) ||
          typeof confidence !== "number" ||
          !Number.isFinite(confidence) ||
          confidence < 0 ||
          confidence > 1
        ) {
          // Do not persist rejected data, paths, or unbounded extra facts.
          fail("pitch_malformed_output");
          return;
        }
        pass.counts[channel]++;
        pass.pairs[channel] = [hz, confidence];
        if (hz > 0) pass.candidates[channel]++;
        if (
          now() - pass.lastProgressAt >= 500 &&
          pass.pairs.every((p) => p !== null)
        ) {
          pass.lastProgressAt = now();
          event("progress", "pitch_smoke_output");
        }
      } else if (
        kind === "started" &&
        packet.length === 5 &&
        !pass.acknowledged &&
        pass.cleanup === "not-started"
      ) {
        if (
          packet
            .slice(3)
            .some(
              (value) =>
                typeof value !== "string" ||
                !/^[a-zA-Z0-9_.~-]{1,128}$/.test(value),
            )
        )
          throw new Error("pitch_invalid_class");
        pass.classes = packet.slice(3);
        pass.acknowledged = true;
        event("started", "pitch_smoke_capture");
        if (pass.classes.some((name) => name !== "fluid.pitch~"))
          fail("pitch_external_unavailable");
      } else if (
        (kind === "stopped" &&
          pass.cleanup === "pending" &&
          packet.length === 3) ||
        (kind === "watchdog-stopped" && packet.length === 3)
      ) {
        try {
          if (kind === "watchdog-stopped") fail("pitch_watchdog_stopped");
        } finally {
          // Physical acknowledgement wins even when observers throw.
          pass.cleanup = "completed";
          event("completed", "pitch_smoke_cleanup");
        }
      } else {
        throw new Error("pitch_invalid_envelope");
      }
    },
    stop(control, cancelled = false) {
      if (!pass || pass.cleanup === "completed") return true;
      if (pass.control.generation !== control.generation)
        throw new Error("pitch_cleanup_owner_mismatch");
      pass.cancelled ||= cancelled;
      if (pass.cleanup === "not-started") {
        try {
          if (!pass.cancelled && pass.counts.some((count) => count === 0))
            fail("pitch_no_output");
          if (!pass.failure)
            event(
              pass.cancelled ? "cancelled" : "completed",
              "pitch_smoke_capture",
            );
        } finally {
          pass.cleanup = "pending";
          pass.stageStartedAt = now();
          try {
            event("queued", "pitch_smoke_cleanup");
            event("started", "pitch_smoke_cleanup");
          } finally {
            sendControl("stop", control.generation, pass.epoch);
          }
        }
      }
      return pass.cleanup === "completed";
    },
    snapshot() {
      return pass
        ? {
            generation: pass.control.generation,
            cleanup: pass.cleanup,
            failure: pass.failure,
            diagnosticDeliveryFailed: pass.diagnosticDeliveryFailed,
            deliveries: [...pass.counts],
            candidates: [...pass.candidates],
          }
        : { cleanup: "not-started" };
    },
  });
}

module.exports = { createPitchSmoke };
