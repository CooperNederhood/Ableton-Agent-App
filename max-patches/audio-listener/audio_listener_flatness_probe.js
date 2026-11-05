/* global require, module, Buffer */
"use strict";

const { randomUUID } = require("node:crypto");
const MAX_POSITIVE_ROUNDOFF_DB = 1e-9;

// Outlet deliveries are diagnostic snapshots, never identified analysis frames.
function createSmokeProbe({ now, sendControl, emit }, prefix) {
  let pass = null;
  const frequency = prefix !== "flatness";
  const fail = (reason) => {
    if (!pass || pass.failure) return;
    pass.failure = reason.replace(/^flatness/, prefix);
    event("failed", pass.failure);
  };
  function event(stage, reason) {
    const elapsedMs = pass.passElapsedAtStart + now() - pass.startedAt;
    const facts = [
      ["flatness.schema", `flucoma-${prefix}-smoke/v1`],
      ["flatness.support", "unqualified"],
      ["flatness.valueValidity", "unqualified"],
      ["flatness.units", frequency ? "Hz" : "dB"],
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
    if (frequency) {
      for (const [field, value] of [
        ["unit", 0],
        ["minfreq", 0],
        ["maxfreq", -1],
      ])
        facts.push({
          field: `flatness.${field}`,
          actual: { state: "observed", value },
        });
      for (const fact of facts)
        fact.field = fact.field
          .replace(/^flatness/, prefix)
          .replace(/Db$/, "Hz");
    }
    if (prefix === "rolloff")
      facts.push({
        field: "rolloff.rolloffpercent",
        actual: { state: "observed", value: 95 },
      });
    const lifecycle = {
      scope: "independent-metric-timelines/v1",
      metric: `spectral-${prefix}`,
      eventId: randomUUID(),
      causationId: pass.lastEvent,
      generation: pass.control.generation,
      nativeEpoch: pass.epoch,
      stage,
      phase: pass.cleanup === "not-started" ? "capture" : "drain",
      elapsedMs,
      durationMs: now() - pass.stageStartedAt,
      frames: 0,
      reason: reason.replace(/^flatness/, prefix),
      facts,
    };
    pass.lastEvent = lifecycle.eventId;
    let accepted;
    try {
      accepted = emit(pass.control, lifecycle);
    } catch (error) {
      pass.diagnosticDeliveryFailed = true;
      throw error;
    }
    if (accepted !== true) {
      pass.diagnosticDeliveryFailed = true;
      // The SDK rejects progress-envelope diagnostics during cancellation.
      // Its rejection remains observable; physical cleanup must still finish.
      if (!pass.cancelled)
        throw new Error(`${prefix}_diagnostic_delivery_failed`);
    }
  }
  return Object.freeze({
    start(control, epoch, causationId, passElapsedAtStart = 0) {
      if (pass && pass.cleanup !== "completed")
        throw new Error(`${prefix}_probe_still_owned`);
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
        diagnosticDeliveryFailed: false,
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
        throw new Error(`${prefix}_foreign_or_late_packet`);
      const kind = packet[2];
      if (kind === "watchdog-stopped" && packet.length === 3) {
        try {
          fail("flatness_watchdog_stopped");
        } finally {
          pass.cleanup = "completed";
          event("completed", "flatness_smoke_cleanup");
        }
        return;
      }
      if (kind === "value" && packet.length === 6 && pass.cleanup === "pending")
        return;
      if (kind === "started" && packet.length === 5) {
        if (pass.acknowledged || pass.cleanup !== "not-started")
          throw new Error(`${prefix}_unexpected_start`);
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
          throw new Error(`${prefix}_invalid_class`);
        pass.classes = packet.slice(3);
        pass.acknowledged = true;
        event("started", "flatness_smoke_capture");
        if (pass.classes.some((name) => name !== "fluid.spectralshape~"))
          fail("flatness_external_unavailable");
      } else if (kind === "stopped" && packet.length === 3) {
        if (pass.cleanup !== "pending")
          throw new Error(`${prefix}_unexpected_stop`);
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
        if (pass.failure) return;
        const [, , , channel, sequence, db] = packet;
        if (
          ![0, 1].includes(channel) ||
          !Number.isSafeInteger(sequence) ||
          sequence !== pass.counts[channel] + 1 ||
          sequence > 400 ||
          typeof db !== "number" ||
          !Number.isFinite(db) ||
          (frequency ? db < 0 : db < -320 || db > MAX_POSITIVE_ROUNDOFF_DB)
        ) {
          pass.rejected = Object.fromEntries(
            Object.entries({
              channel,
              sequence,
              [frequency ? "hz" : "db"]: db,
            }).map(([key, value]) => [
              key,
              typeof value === "number" ? String(value) : typeof value,
            ]),
          );
          fail("flatness_malformed_output");
          return;
        }
        pass.counts[channel] = sequence;
        // The theoretical maximum is zero; double-precision accumulation can
        // overshoot it by sub-nanodecibel roundoff. Larger positives stay invalid.
        pass.values[channel] = frequency ? db : Math.min(0, db);
        if (
          now() - pass.lastProgressAt >= 500 &&
          pass.values.every((v) => v !== null)
        ) {
          pass.lastProgressAt = now();
          event("progress", "flatness_smoke_output");
        }
      } else {
        throw new Error(`${prefix}_invalid_packet`);
      }
    },
    stop(control, cancelled = false) {
      if (!pass) return true;
      if (pass.cleanup === "completed") return true;
      if (pass.control.generation !== control.generation)
        throw new Error(`${prefix}_cleanup_owner_mismatch`);
      pass.cancelled ||= cancelled;
      if (pass.cleanup === "not-started") {
        try {
          if (!cancelled && pass.counts.some((count) => count === 0))
            fail("flatness_no_output");
          if (!pass.failure)
            event(
              cancelled ? "cancelled" : "completed",
              "flatness_smoke_capture",
            );
        } finally {
          pass.cleanup = "pending";
          pass.stageStartedAt = now();
          try {
            event("queued", "flatness_smoke_cleanup");
            event("started", "flatness_smoke_cleanup");
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
          }
        : { cleanup: "not-started" };
    },
  });
}

function createFlatnessProbe(options) {
  return createSmokeProbe(options, "flatness");
}

// Fixed three-descriptor transport: one owner, timer, sequence and stop handshake.
// Validation of each descriptor remains local to its diagnostic probe.
function createSpectralShapeSmoke({ now, sendControl, emit }) {
  let eventCount = 0;
  const options = {
    now,
    emit: (control, lifecycle) => {
      // Three chains: at most 240 progress + 18 lifecycle events across the
      // 400-delivery/100ms gate horizon, with bounded failure/terminal headroom.
      if (
        ++eventCount > 288 ||
        Buffer.byteLength(JSON.stringify(lifecycle)) > 8192
      )
        throw new Error("spectralshape_diagnostic_limit");
      return emit(control, lifecycle);
    },
    sendControl: () => {},
  };
  const flatness = createFlatnessProbe(options);
  const spread = createSmokeProbe(options, "spread");
  const rolloff = createSmokeProbe(options, "rolloff");
  const probes = [spread, rolloff, flatness];
  let owner = null;
  let sequences = [0, 0];
  let stopping = false;
  let started = false;
  let cleaned = true;
  function eachProbe(action) {
    let failure;
    for (const probe of probes) {
      try {
        action(probe);
      } catch (error) {
        failure ||= error;
      }
    }
    if (failure) throw failure;
  }
  return Object.freeze({
    start(control, epoch, causationId, elapsedMs = 0) {
      if (!cleaned) throw new Error("spectralshape_probe_still_owned");
      owner = [control.generation, epoch];
      eventCount = 0;
      sequences = [0, 0];
      stopping = false;
      started = false;
      cleaned = false;
      try {
        eachProbe((probe) =>
          probe.start(control, epoch, causationId, elapsedMs),
        );
      } finally {
        // Establish the physical lease even if diagnostic delivery throws:
        // controller cleanup can then always stop the same owned gate.
        sendControl("begin", ...owner);
      }
    },
    receive(packet) {
      if (
        !owner ||
        cleaned ||
        !Array.isArray(packet) ||
        packet.length < 3 ||
        packet[0] !== owner[0] ||
        packet[1] !== owner[1]
      )
        throw new Error("spectralshape_foreign_or_late_packet");
      const kind = packet[2];
      if (kind === "value") {
        const channel = packet[3];
        const sequence = packet[4];
        if (
          packet.length !== 8 ||
          !started ||
          ![0, 1].includes(channel) ||
          !Number.isSafeInteger(sequence) ||
          sequence !== sequences[channel] + 1 ||
          sequence > 400
        )
          throw new Error("spectralshape_invalid_envelope");
        sequences[channel] = sequence;
        if (stopping) return;
        eachProbe((probe) =>
          probe.receive([
            ...packet.slice(0, 5),
            packet[5 + probes.indexOf(probe)],
          ]),
        );
        return;
      }
      if (kind === "started" && packet.length === 5 && !started && !stopping) {
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
          throw new Error("spectralshape_invalid_class");
        started = true;
      } else if (
        (kind === "stopped" && stopping && packet.length === 3) ||
        (kind === "watchdog-stopped" && packet.length === 3)
      ) {
        cleaned = true;
      } else {
        throw new Error("spectralshape_invalid_envelope");
      }
      eachProbe((probe) => probe.receive(packet));
    },
    stop(control, cancelled = false) {
      if (cleaned) return true;
      if (owner[0] !== control.generation)
        throw new Error("spectralshape_cleanup_owner_mismatch");
      const send = !stopping;
      stopping = true;
      try {
        eachProbe((probe) => probe.stop(control, cancelled));
      } finally {
        if (send) sendControl("stop", ...owner);
      }
      return cleaned;
    },
    snapshot() {
      return {
        flatness: flatness.snapshot(),
        spread: spread.snapshot(),
        rolloff: rolloff.snapshot(),
      };
    },
  });
}

module.exports = { createFlatnessProbe, createSpectralShapeSmoke };
