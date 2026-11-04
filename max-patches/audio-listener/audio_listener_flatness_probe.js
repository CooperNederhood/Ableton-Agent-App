/* global require, module */
"use strict";

const { randomUUID } = require("node:crypto");
const MAX_POSITIVE_ROUNDOFF_DB = 1e-9;

// Outlet deliveries are diagnostic snapshots, never identified analysis frames.
function createFlatnessProbe({ now, sendControl, emit }) {
  let pass = null;
  const fail = (reason) => {
    if (!pass || pass.failure) return;
    pass.failure = reason;
    event("failed", reason);
  };
  function event(stage, reason) {
    const elapsedMs = pass.passElapsedAtStart + now() - pass.startedAt;
    const facts = [
      ["flatness.schema", "flucoma-flatness-smoke/v1"],
      ["flatness.support", "unqualified"],
      ["flatness.valueValidity", "unqualified"],
      ["flatness.units", "dB"],
      ["flatness.channelPolicy", "independent-stereo"],
      ["flatness.windowSamples", 2048],
      ["flatness.hopSamples", 2048],
      ["flatness.power", 0],
      ["flatness.leftDeliveries", pass.counts[0]],
      ["flatness.rightDeliveries", pass.counts[1]],
      ["flatness.cleanup", pass.cleanup],
    ].map(([field, value]) => ({
      field,
      actual: { state: "observed", value },
    }));
    for (const [index, channel] of ["left", "right"].entries())
      facts.push({
        field: `flatness.${channel}Db`,
        actual:
          pass.values[index] === null
            ? { state: "unavailable", reason: "not-reported" }
            : { state: "observed", value: pass.values[index] },
      });
    for (const [index, channel] of ["left", "right"].entries())
      facts.push({
        field: `flatness.${channel}Class`,
        actual:
          pass.classes[index] === null
            ? { state: "unavailable", reason: "not-reported" }
            : { state: "observed", value: pass.classes[index] },
      });
    if (pass.rejected)
      for (const [name, value] of Object.entries(pass.rejected))
        facts.push({
          field: `flatness.rejected.${name}`,
          actual: { state: "observed", value },
        });
    const lifecycle = {
      scope: "independent-metric-timelines/v1",
      metric: "spectral-flatness",
      eventId: randomUUID(),
      causationId: pass.lastEvent,
      generation: pass.control.generation,
      nativeEpoch: pass.epoch,
      stage,
      phase: pass.cleanup === "not-started" ? "capture" : "drain",
      elapsedMs,
      durationMs: now() - pass.stageStartedAt,
      frames: 0,
      reason,
      facts,
    };
    pass.lastEvent = lifecycle.eventId;
    if (emit(pass.control, lifecycle) !== true)
      throw new Error("flatness_diagnostic_delivery_failed");
  }
  return Object.freeze({
    start(control, epoch, causationId, passElapsedAtStart = 0) {
      if (pass && pass.cleanup !== "completed")
        throw new Error("flatness_probe_still_owned");
      pass = {
        control,
        epoch,
        startedAt: now(),
        stageStartedAt: now(),
        passElapsedAtStart,
        lastEvent: causationId,
        acknowledged: false,
        cleanup: "not-started",
        values: [null, null],
        counts: [0, 0],
        classes: [null, null],
        rejected: null,
        failure: null,
        cancelled: false,
        lastProgressAt: -Infinity,
      };
      event("queued", "flatness_smoke_capture");
      sendControl("begin", control.generation, epoch);
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
        throw new Error("flatness_foreign_or_late_packet");
      const kind = packet[2];
      if (kind === "watchdog-stopped" && packet.length === 3) {
        fail("flatness_watchdog_stopped");
        pass.cleanup = "completed";
        event("completed", "flatness_smoke_cleanup");
        return;
      }
      if (kind === "value" && packet.length === 6 && pass.cleanup === "pending")
        return;
      if (kind === "started" && packet.length === 5) {
        if (pass.acknowledged || pass.cleanup !== "not-started")
          throw new Error("flatness_unexpected_start");
        if (
          packet
            .slice(3)
            .some(
              (value) =>
                typeof value !== "string" ||
                value.length === 0 ||
                value.length > 128,
            )
        )
          throw new Error("flatness_invalid_class");
        pass.classes = packet.slice(3);
        pass.acknowledged = true;
        event("started", "flatness_smoke_capture");
        if (pass.classes.some((name) => name !== "fluid.spectralshape~"))
          fail("flatness_external_unavailable");
      } else if (kind === "stopped" && packet.length === 3) {
        if (pass.cleanup !== "pending")
          throw new Error("flatness_unexpected_stop");
        pass.cleanup = "completed";
        if (
          !pass.failure &&
          !pass.cancelled &&
          pass.counts.some((count) => count === 0)
        )
          fail("flatness_no_output");
        event("completed", "flatness_smoke_cleanup");
      } else if (
        kind === "value" &&
        packet.length === 6 &&
        pass.acknowledged &&
        pass.cleanup === "not-started"
      ) {
        const [, , , channel, sequence, db] = packet;
        if (
          ![0, 1].includes(channel) ||
          !Number.isSafeInteger(sequence) ||
          sequence !== pass.counts[channel] + 1 ||
          sequence > 400 ||
          typeof db !== "number" ||
          !Number.isFinite(db) ||
          db < -320 ||
          db > MAX_POSITIVE_ROUNDOFF_DB
        ) {
          pass.rejected = Object.fromEntries(
            Object.entries({ channel, sequence, db }).map(([key, value]) => [
              key,
              typeof value === "number" ? String(value) : typeof value,
            ]),
          );
          fail("flatness_malformed_output");
          return;
        }
        if (pass.failure) return;
        pass.counts[channel] = sequence;
        // The theoretical maximum is zero; double-precision accumulation can
        // overshoot it by sub-nanodecibel roundoff. Larger positives stay invalid.
        pass.values[channel] = Math.min(0, db);
        if (
          now() - pass.lastProgressAt >= 500 &&
          pass.values.every((v) => v !== null)
        ) {
          pass.lastProgressAt = now();
          event("progress", "flatness_smoke_output");
        }
      } else {
        throw new Error("flatness_invalid_packet");
      }
    },
    stop(control, cancelled = false) {
      if (!pass) return true;
      if (pass.cleanup === "completed") return true;
      if (pass.control.generation !== control.generation)
        throw new Error("flatness_cleanup_owner_mismatch");
      if (pass.cleanup === "not-started") {
        pass.cancelled = cancelled;
        if (!cancelled && pass.counts.some((count) => count === 0))
          fail("flatness_no_output");
        if (!pass.failure)
          event(
            cancelled ? "cancelled" : "completed",
            "flatness_smoke_capture",
          );
        pass.cleanup = "pending";
        pass.stageStartedAt = now();
        event("queued", "flatness_smoke_cleanup");
        event("started", "flatness_smoke_cleanup");
        sendControl("stop", control.generation, pass.epoch);
      }
      return pass.cleanup === "completed";
    },
    snapshot() {
      return pass
        ? {
            generation: pass.control.generation,
            cleanup: pass.cleanup,
            failure: pass.failure,
            deliveries: [...pass.counts],
          }
        : { cleanup: "not-started" };
    },
  });
}

module.exports = { createFlatnessProbe };
