/* global require, module, Buffer */
"use strict";

const { randomUUID } = require("node:crypto");
const {
  createMetricTimelines,
  adaptMetricTimelineObservation,
} = require("./audio_listener_metric_timelines.js");
const {
  createMetricSpectrumHandoff,
} = require("./audio_listener_metric_spectrum.js");
const { createMelBandHandoff } = require("./audio_listener_mel_handoff.js");
const {
  decodeIORejection,
  decodeRetentionRejection,
  decodeRetentionSnapshot,
  SPECTRUM_CLEANUP_REASONS,
} = require("./audio_listener_native_io.js");

const IDS = [
  "generation",
  "passId",
  "connectionEpoch",
  "traceId",
  "correlationId",
  "causationId",
];
const OWNER = [
  "listenerId",
  "passId",
  "connectionId",
  "connectionEpoch",
  "generation",
  "traceId",
  "correlationId",
  "causationId",
];
const GROUPS = ["idle", "currentEpoch", "prelaunch", "cleanup"];
const MAX_COUNTER = 2 ** 44 - 1;
const integer = (value, max = MAX_COUNTER) =>
  Number.isSafeInteger(value) && value >= 0 && value <= max;
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
function requireValue(condition, reason) {
  if (!condition) throw new Error(reason);
}
function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
const copy = (value) => freeze(JSON.parse(JSON.stringify(value)));

/**
 * First runnable metric path: explicitly requested level and/or attacks.
 * The runtime owns the continuous clock/source lease and supplies its genuine
 * generation-bound packets; this controller neither starts nor stops Live.
 *
 * sendControl("metric_envelope","epoch",[0]) targets the REAL Gen Param inlet.
 * Other selectors target createMaxAdapter: begin/configure_metric/arm,
 * metric_evidence/metric_status/metric_prefix_record/stop/release.
 * Transport acceptance is not execution evidence. Native packets drive proofs.
 * tick() is the sole effect pump: receiveNative never reenters Max controls.
 */
function createMetricController(options) {
  requireValue(
    options && typeof options === "object",
    "invalid_metric_controller",
  );
  requireValue(
    options.spectrumEnabled === undefined ||
      typeof options.spectrumEnabled === "boolean",
    "invalid_metric_spectrum_option",
  );
  requireValue(
    options.melEnabled === undefined || typeof options.melEnabled === "boolean",
    "invalid_metric_mel_option",
  );
  for (const key of [
    "sendControl",
    "sendListenerReply",
    "sendListenerResult",
    "now",
    "onEvent",
  ])
    requireValue(typeof options[key] === "function", `missing_metric_${key}`);
  const codec = options.codec || require("./audio_listener_metric_protocol.js");
  for (const key of [
    "listenerControlMetricSchema",
    "nativeMetricReadyProofSchema",
    "nativeMetricLaunchProofSchema",
    "nativeMetricSourceCoverageProofSchema",
    "assertNativeMetricReadyProof",
    "assertNativeMetricArmProof",
    "nativeMetricLaunchCoordinates",
    "assertNativeMetricSourceCoverage",
    "assertNativeMetricObservationSource",
    "snapshotNativeMetricListeningExpectation",
    "metricAudioObservationSchema",
    "createMetricObservationReportRows",
  ])
    requireValue(codec[key], `missing_metric_codec_${key}`);
  let pass = null;
  let disposed = false;
  let pumping = false;
  let lastTime = -Infinity;
  let epochHighWater = 0;
  const retired = new Set();
  function time() {
    const value = options.now();
    requireValue(
      Number.isFinite(value) && value >= lastTime,
      "metric_clock_regressed",
    );
    lastTime = value;
    return value;
  }
  function current(p) {
    return pass === p && !p.done;
  }
  function abort(p, reason) {
    if (!current(p)) return;
    p.inputFailureReason ??= reason;
    p.failure ||= reason;
    p.wantCleanup = true;
  }
  function abortIo(p, reason) {
    requireValue(
      typeof reason === "string" && /^[a-z][a-z0-9_]{0,127}$/.test(reason),
      "metric_invalid_io_failure_reason",
    );
    abort(p, reason);
  }
  function emit(p, phase, stage, metric, reason, durationMs, facts) {
    if (
      !current(p) ||
      p.eventsBroken ||
      (p.events >= 900 && stage === "progress")
    )
      return;
    p.events++;
    const nativeLifecycle = {
      scope: "independent-metric-timelines/v1",
      eventId: randomUUID(),
      causationId: p.lastEvent,
      generation: p.control.generation,
      nativeEpoch: p.epoch,
      stage: stage === "partial" ? "progress" : stage,
      elapsedMs: time() - p.started,
      // Independent timelines have no additive global frame sequence.
      frames: metric
        ? p.metricCounts[metric] || 0
        : Math.max(0, ...Object.values(p.metricCounts)),
      ...(metric
        ? { metric: metric === "spectrum" ? "spectral-centroid" : metric }
        : {}),
      ...([
        "preflight",
        "configuration",
        "arm",
        "launch",
        "capture",
        "drain",
        "post-binding",
      ].includes(phase)
        ? { phase }
        : {}),
      ...(reason ? { reason } : {}),
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(facts === undefined ? {} : { facts }),
    };
    p.lastEvent = nativeLifecycle.eventId;
    if (!metric && ["failed", "cancelled"].includes(stage))
      p.terminalLifecycle = nativeLifecycle;
    const event = freeze({
      control: p.control,
      phase,
      traceId: p.control.traceId,
      correlationId: p.control.correlationId,
      nativeLifecycle,
    });
    try {
      options.onEvent(event);
    } catch {
      p.eventsBroken = true;
      abort(p, "metric_event_delivery_failed");
      return;
    }
    if (
      (!metric && ["failed", "cancelled"].includes(stage)) ||
      p.cancelControl ||
      p.failure
    )
      return;
    try {
      if (
        options.sendListenerResult(p.control, {
          status: "progress",
          nativeLifecycle,
        }) !== true
      )
        abort(p, "metric_progress_delivery_failed");
    } catch {
      abort(p, "metric_progress_delivery_failed");
    }
  }
  function send(p, selector, args, target = "metric_envelope") {
    if (!current(p)) return;
    if (p.wantCleanup && ["arm", "configure_metric"].includes(selector)) return;
    try {
      const result = options.sendControl(target, selector, copy(args));
      requireValue(result !== false, "metric_control_delivery_failed");
      if (result && typeof result.then === "function") {
        const counter = [
          "metric_evidence",
          "metric_status",
          "callerTick",
          "spectrum_cleanup_tick",
          "spectrum_cleanup_evidence",
          "drain",
        ].includes(selector)
          ? "queryDeliveries"
          : "deliveries";
        p[counter]++;
        result.then(
          (accepted) => {
            if (current(p)) {
              p[counter]--;
              if (accepted === false)
                abort(p, "metric_control_delivery_failed");
            }
          },
          () => {
            if (current(p)) {
              p[counter]--;
              abort(p, "metric_control_delivery_failed");
            }
          },
        );
      }
    } catch (error) {
      abort(
        p,
        /^[a-z][a-z0-9_]{0,127}$/.test(error.message)
          ? error.message
          : "metric_control_delivery_failed",
      );
    }
  }
  function io(p, selector, tail = []) {
    send(p, selector, p.ids.concat(tail));
  }
  function spectrumControl(p, selector, tail = []) {
    send(
      p,
      selector,
      [p.control.generation, p.epoch, ...tail],
      "metric_spectrum",
    );
  }
  function ownerMatches(p, owner) {
    return owner && IDS.every((field) => owner[field] === p.control[field]);
  }
  function pair(p, group, kind, value) {
    if (!value || value.available === false) return;
    const r = value.receipt;
    requireValue(
      value.available === true &&
        r &&
        Array.isArray(r.raw) &&
        r.raw.length === (kind === "timing" ? 8 : 12) &&
        r.raw.every(Number.isFinite) &&
        integer(r.nativeSourceCounter) &&
        Number.isFinite(r.observedHostReceiptMs),
      "metric_invalid_receipt",
    );
    const rows = p.samples[group][kind];
    const last = rows.at(-1);
    if (last && last.nativeSourceCounter === r.nativeSourceCounter) {
      requireValue(equal(last.raw, r.raw), "metric_changed_receipt");
      return;
    }
    if (last && r.nativeSourceCounter < last.nativeSourceCounter)
      throw new Error("metric_receipt_regressed");
    rows.push(copy(r));
    if (rows.length > 2) rows.shift();
  }
  function dspReceipt(fields, timing) {
    if (fields.length !== 2 || timing.length !== 2) return null;
    if (
      fields[0].nativeSourceCounter >= fields[1].nativeSourceCounter ||
      timing[0].nativeSourceCounter >= timing[1].nativeSourceCounter
    )
      return null;
    const all = [...fields, ...timing].map((r) => r.observedHostReceiptMs);
    return {
      fields: fields[0].raw,
      confirmedFields: fields[1].raw,
      timing: timing[0].raw,
      confirmedTiming: timing[1].raw,
      elapsedMs: Math.max(...all) - Math.min(...all),
    };
  }
  function configuration(p) {
    const g = p.config.geometry;
    return [
      g.sampleRate,
      g.totalSamples,
      g.sampleRate / 10,
      g.tempoBpm,
      g.startBeat - Math.floor(g.startBeat),
      g.vectorSize,
      1,
      g.startBeat,
      g.endBeat,
      g.rows.length,
    ];
  }
  function updateWitnesses(p, row) {
    const q = (p.config.geometry.sampleRate * 60) / p.config.geometry.tempoBpm;
    const offset = (r) => r[2] - r[4];
    const origin = (r) =>
      r[2] - Math.round((r[1] - p.config.geometry.startBeat) * q);
    const phase = (r) => {
      const difference = Math.abs(
        Math.round(r[5] * q) - Math.round((r[1] % 1) * q),
      );
      return Math.min(difference, Math.abs(Math.round(q) - difference));
    };
    for (const [key, value, maximum] of [
      ["minHostOffset", offset, false],
      ["maxHostOffset", offset, true],
      ...(row[0] === 1
        ? [
            ["minBeatOrigin", origin, false],
            ["maxBeatOrigin", origin, true],
            ["maxPhaseDisagreement", phase, true],
          ]
        : []),
    ]) {
      const old = p.witnesses[key];
      if (!old || (maximum ? value(row) > value(old) : value(row) < value(old)))
        p.witnesses[key] = row;
    }
  }
  function clock(p, values) {
    const row = copy(
      codec.nativeMetricLaunchProofSchema.shape.clock.parse(values),
    );
    const previous = p.lastClock;
    if (previous && row[4] === previous[4]) {
      requireValue(equal(row, previous), "metric_changed_clock_hold");
      return;
    }
    requireValue(
      !previous ||
        (row[4] > previous[4] &&
          (row[1] >= previous[1] ||
            (p.armProof &&
              p.config.mode === "session" &&
              p.config.geometry.startBeat === 0 &&
              previous[0] === 0 &&
              row[0] === 1))),
      "metric_source_clock_regressed",
    );
    if (!p.armProof && row[0] !== 0)
      throw new Error("metric_transport_not_stopped");
    if (
      !p.armProof &&
      row[1] !==
        (p.config.mode === "session"
          ? p.config.stoppedBeat
          : p.config.geometry.startBeat)
    )
      throw new Error("metric_source_position_mismatch");
    p.lastClock = row;
    p.clockHistory.push(row);
    while (
      p.clockHistory.length > 512 ||
      p.clockHistory[0][4] < row[4] - p.config.geometry.sampleRate
    )
      p.clockHistory.shift();
    if (row[0] === 1 && p.spectrum.started) p.spectrum.streaming = true;
    if (row[0] === 0 && !p.armProof) {
      p.clocks.push(row);
      if (p.clocks.length > 32) p.clocks.shift();
      if (p.clocks.length === 32 && p.dsp)
        codec.nativeMetricReadyProofSchema.shape.before.parse({
          dsp: p.dsp,
          frames: p.clocks,
        });
    } else if (row[0] === 1) {
      p.playingClocks.push(row);
      if (p.playingClocks.length > 32) p.playingClocks.shift();
      if (p.playingClocks.length === 32)
        codec.nativeMetricSourceCoverageProofSchema.shape.after.parse({
          dsp: p.dsp,
          frames: p.playingClocks,
        });
    } else if (p.playingClocks.length && !p.sourceProof && !p.wantCleanup) {
      throw new Error("metric_source_transport_stopped");
    }
    if (p.armSent && !p.sourceProof) updateWitnesses(p, row);
    if (
      p.coordinates &&
      row[0] === 1 &&
      !p.sourceProof &&
      row[4] >= p.coordinates.endSample + p.config.geometry.vectorSize - 1 &&
      p.after.length < 32
    )
      p.after.push(row);
  }
  function receiveEvidence(p, frame) {
    requireValue(
      frame.type === "native-metric-envelope-evidence/v1" &&
        ownerMatches(p, frame.owner) &&
        frame.nativeEpoch === p.epoch,
      "metric_foreign_evidence",
    );
    p.evidence = copy(frame);
    for (const group of GROUPS)
      for (const kind of ["timing", "configuration"])
        pair(p, group, kind, frame.receipts?.[group]?.[kind]);
    if (frame.diagnosticOnly && !p.wantCleanup) abortIo(p, frame.reason);
  }
  function receiveRecord(p, packet) {
    requireValue(
      ownerMatches(p, packet.owner) &&
        packet.nativeEpoch === p.epoch &&
        packet.sourceOriginCounter === p.coordinates?.originCounter,
      "metric_foreign_record",
    );
    const family = packet.family;
    const f = p.families[family];
    requireValue(
      f && f.outstanding && packet.record?.sequence === f.next,
      "metric_unrequested_record",
    );
    f.outstanding = false;
    const r = packet.record;
    requireValue(
      r.epoch === p.epoch &&
        r.sourceOriginCounter === p.coordinates.originCounter &&
        r.kind ===
          (family === "level"
            ? "native-musical-level/v1"
            : "native-detector-level/v1"),
      "metric_record_origin_mismatch",
    );
    const record = {
      owner: p.collectorOwner,
      sequence: r.sequence,
      startSample: p.coordinates.originCounter + r.startSample,
      endSample: p.coordinates.originCounter + r.endSample,
      count: r.count,
      peak: r.peak,
      sumSquares: r.sumSquares,
    };
    const result =
      family === "level"
        ? p.collector.ingestLevel(record)
        : p.collector.ingestDetectorLevel(record);
    if (result.accepted || result.duplicate) {
      f.next++;
      if (result.accepted) p.admittedRecords++;
    } else f.failure = "malformed_record";
  }
  function failSpectrum(p, reason = "analyzer_failed") {
    p.spectrum.failure ||= reason;
    if (p.collector) p.collector.failMetric("spectrum", "analyzer_failed");
  }
  function reportSpectrumRetention(p, row, status, force = false) {
    const now = time();
    if (!force && now - (p.spectrum.retentionEvidenceAt ?? -Infinity) < 1000)
      return;
    p.spectrum.retentionEvidenceAt = now;
    const observed = (value) =>
      typeof value === "number" && Number.isFinite(value)
        ? { state: "observed", value }
        : { state: "unavailable", reason: "not-reported" };
    const facts = [
      "abi",
      "nativeEpoch",
      "requestedSequence",
      "slotEpoch",
      "slotSequence",
      "startSample",
      "endSample",
      "produced",
      "acknowledged",
      "fault",
    ].map((field, index) => ({
      field: `capture.spectrum.retention.${field}`,
      actual: observed(row?.[index]),
    }));
    facts.push(
      {
        field: "capture.spectrum.retention.backlog",
        actual: observed(
          Number.isFinite(row?.[7]) && Number.isFinite(row?.[8])
            ? row[7] - row[8]
            : undefined,
        ),
      },
      {
        field: "capture.spectrum.retention.readerStatus",
        actual: { state: "observed", value: status },
      },
    );
    emit(
      p,
      p.coordinates ? "capture" : "preflight",
      "progress",
      "spectrum",
      "native_spectrum_retention_evidence",
      undefined,
      facts,
    );
  }
  function receiveSpectrum(p, packet) {
    const s = p.spectrum;
    requireValue(s.started, "metric_unowned_spectrum_packet");
    if (packet[0] === "native_metric_spectrum_cleanup") {
      requireValue(
        packet.length === 2 &&
          typeof packet[1] === "string" &&
          Buffer.byteLength(packet[1]) <= 32768,
        "metric_invalid_spectrum_cleanup_packet",
      );
      const evidence = codec.nativeMetricSpectrumCleanupSchema.parse(
        JSON.parse(packet[1]),
      );
      requireValue(
        evidence.generation === p.control.generation &&
          evidence.nativeEpoch === p.epoch,
        "metric_foreign_spectrum_cleanup",
      );
      s.cleanupEvidence = copy(evidence);
      return;
    }
    requireValue(
      packet[0] === "native" && packet[1] === p.control.generation,
      "metric_foreign_spectrum",
    );
    const kind = packet[2],
      values = packet.slice(3);
    const retentionRejection =
      kind === "retention-rejection" ? decodeRetentionRejection(values) : null;
    if (kind === "retention-rejection") {
      requireValue(
        retentionRejection && retentionRejection.nativeEpoch === p.epoch,
        "metric_invalid_spectrum_rejection",
      );
      reportSpectrumRetention(
        p,
        retentionRejection.readerReadbacks.at(-1)?.cells,
        retentionRejection.readerReason,
        true,
      );
    }
    if (
      s.handoff &&
      ["io-rejection", "retention-rejection", "ioError"].includes(kind)
    ) {
      const result = s.handoff.receive(packet);
      if (result.classification === "shared")
        abort(p, "metric_spectrum_shared_failure");
      else if (result.classification === "metric") s.failure ||= result.reason;
      return;
    }
    if (kind === "spectrum-acquisition") {
      requireValue(
        values.length === 4 &&
          values.every((v) => integer(v)) &&
          values[0] === p.epoch &&
          values[1] === values[2],
        "metric_invalid_spectrum_acquisition",
      );
      const previous = s.acquisitions.at(-1);
      requireValue(
        !previous || values[1] >= previous[1],
        "metric_spectrum_clock_regressed",
      );
      if (values[3] > values[1] + 1) {
        failSpectrum(p);
        return;
      }
      s.acquisitions.push(copy(values));
      if (s.acquisitions.length > 2) s.acquisitions.shift();
    } else if (kind === "spectrum-readback") {
      requireValue(
        values.length === 6 &&
          values.every(Number.isFinite) &&
          values[0] === p.epoch,
        "metric_invalid_spectrum_readback_evidence",
      );
      s.lastHeader = copy(values.slice(2));
      s.lastReadbackCounter = values[1];
    } else if (kind === "spectrum-start-error") {
      requireValue(
        values.length === 3 &&
          values[0] === p.epoch &&
          typeof values[1] === "string" &&
          values[1].length <= 32 &&
          typeof values[2] === "string" &&
          values[2].length <= 128,
        "metric_invalid_spectrum_start_error",
      );
      s.startError = values[1] + ": " + values[2];
    } else if (kind === "fftInfo") {
      requireValue(
        values.length === 4 && values.every(Number.isFinite),
        "metric_invalid_fft_information",
      );
      s.fftInformation = copy(values);
      if (s.phase && !equal(values, [2048, 2048, 2048, 1])) failSpectrum(p);
    } else if (kind === "abi-spectrum") {
      requireValue(equal(values, [2]), "metric_invalid_spectrum_abi");
      s.abi = copy(packet);
    } else if (kind === "retention-ready") {
      requireValue(
        equal(values, [2, 1, p.epoch]),
        "metric_foreign_spectrum_retention",
      );
      s.ready = copy(packet);
    } else if (kind === "io-rejection") {
      const decoded = decodeIORejection(values);
      requireValue(
        decoded?.mode === "spectrum" &&
          decoded.generationMatches &&
          (decoded.nativeEpoch === null || decoded.nativeEpoch === p.epoch),
        "metric_invalid_spectrum_rejection",
      );
      if (
        ["packet-numeric", "spectrum-diagnostics-numeric"].includes(
          decoded.check,
        ) ||
        (!s.phase && decoded.check === "packet-kind")
      )
        failSpectrum(p);
      else abort(p, "metric_spectrum_shared_failure");
    } else if (kind === "retention-rejection") {
      if (
        [
          "invalid_numeric",
          "slot_mutation",
          "unread_capacity_overflow",
          "consumer_failed",
          "consumer_rejected",
        ].includes(retentionRejection.readerReason)
      )
        failSpectrum(p);
      else abort(p, "metric_spectrum_shared_failure");
    } else if (kind === "ioError") {
      requireValue(equal(values, [1]), "metric_invalid_spectrum_io_error");
      if (!s.failure) abort(p, "metric_spectrum_shared_failure");
    } else if (kind === "retention-snapshot") {
      const decoded = decodeRetentionSnapshot(values);
      requireValue(
        decoded && decoded.nativeEpoch === p.epoch,
        "metric_invalid_spectrum_snapshot",
      );
      const row = decoded.readbacks.at(-1)?.cells;
      if (row?.length === 20)
        s.lastHeader = copy([row[0], row[1], row[7], row[9]]);
      reportSpectrumRetention(p, row, decoded.status);
    } else if (kind === "spectrum-input-rejection") {
      requireValue(
        values.length === 3 &&
          values[0] === 2 &&
          values[1] === p.epoch &&
          integer(values[2], SPECTRUM_CLEANUP_REASONS.length - 1),
        "metric_invalid_spectrum_rejection",
      );
      abort(p, "metric_spectrum_shared_failure");
    } else if (kind === "spectrum") {
      requireValue(
        values.length === 6 && values.every(Number.isFinite),
        "metric_invalid_spectrum_record",
      );
      s.receivedRecords = (s.receivedRecords || 0) + 1;
      if (p.wantCleanup || s.failure) return;
      if (s.handoff) {
        const result = s.handoff.receive(packet);
        s.lastHandoffResult = copy(result);
        if (result.classification === "shared")
          abort(p, "metric_spectrum_shared_failure");
      } else {
        s.pending.push(copy(packet));
        const bound = s.streaming
          ? Math.ceil(p.config.geometry.totalSamples / 2048) + 4
          : 2;
        if (s.pending.length > bound) {
          if (s.streaming) failSpectrum(p, "spectrum_stalled");
          s.pending.shift();
        }
      }
      return;
    }
    if (s.handoff && !s.failure && kind !== "spectrum-acquisition") {
      const result = s.handoff.receive(packet);
      if (result.classification === "shared")
        abort(p, "metric_spectrum_shared_failure");
    }
  }
  function prepareSpectrum(p, now) {
    const s = p.spectrum;
    if (!s.enabled) return true;
    if (!s.started) {
      emit(p, "preflight", "queued", "spectrum");
      if (p.wantCleanup) {
        emit(p, "preflight", "cancelled", "spectrum", "cancelled", 0);
        return false;
      }
      s.started = true;
      s.startedAt = now;
      s.phaseDeadline = Math.min(p.deadline, now + 600);
      spectrumControl(p, "begin", [p.config.geometry.sampleRate]);
      io(p, "metric_spectrum_poll", [1]);
      emit(p, "preflight", "started", "spectrum");
      return false;
    }
    if (s.phase || s.phaseUnavailable) return true;
    if (
      !s.failure &&
      s.abi &&
      s.ready &&
      s.fftInformation &&
      s.acquisitions.length === 2 &&
      p.clockHistory.length >= 32
    ) {
      const rows = p.clockHistory.filter((row) => row[0] === 0);
      if (rows.length >= 32) {
        const frames = Array.from(
          { length: 32 },
          (_, index) => rows[Math.floor((index * (rows.length - 1)) / 31)],
        );
        const parsed = codec.nativeMetricSpectrumPhaseSchema.safeParse({
          scope: "native-metric-spectrum-phase/v1",
          ownership: p.ownership,
          fftInformation: s.fftInformation,
          binding: { abi: s.abi[3], ready: s.ready.slice(3) },
          clock: { dsp: p.dsp, frames },
          acquisitions: s.acquisitions,
        });
        if (parsed.success) {
          s.phase = copy(parsed.data);
          emit(
            p,
            "preflight",
            "completed",
            "spectrum",
            "native_spectrum_phase_bound",
            now - s.startedAt,
          );
          return true;
        }
      }
    }
    if (s.failure || now >= s.phaseDeadline) {
      s.phaseUnavailable = true;
      s.failure ||= "native_phase_unavailable";
      emit(
        p,
        "preflight",
        "failed",
        "spectrum",
        "native_phase_unavailable",
        now - s.startedAt,
      );
      if (
        !p.mel &&
        !p.config.requestedMetrics.some(
          (metric) => metric === "level" || metric === "attacks",
        )
      )
        abort(p, "metric_no_requested_metric_available");
      return true;
    }
    return false;
  }
  function cleanupSpectrum(p) {
    const s = p.spectrum;
    if (!s.started || s.released) return true;
    if (s.cleanupStarted === null) {
      s.cleanupStarted = time();
      emit(p, "cleanup", "queued", "spectrum");
      emit(p, "cleanup", "started", "spectrum");
      spectrumControl(p, "request_spectrum_stop", [
        p.cancelControl
          ? "cancelled"
          : p.failure || s.failure
            ? "failed"
            : "complete",
        p.cleanupDeadline,
      ]);
      return false;
    }
    if (s.cleanupEvidence?.status === "failed") {
      if (!s.cleanupFailureEmitted) {
        s.cleanupFailureEmitted = true;
        emit(
          p,
          "cleanup",
          "failed",
          "spectrum",
          "metric_spectrum_cleanup_unconfirmed",
          time() - s.cleanupStarted,
        );
      }
      abort(p, "metric_spectrum_cleanup_unconfirmed");
      p.cleanupFailed = true;
      return false;
    }
    if (s.cleanupEvidence?.status !== "completed") return false;
    send(p, "release", [p.control.generation], "metric_spectrum");
    s.released = true;
    emit(
      p,
      "cleanup",
      "completed",
      "spectrum",
      undefined,
      time() - s.cleanupStarted,
    );
    return true;
  }
  function receiveNative(target, packet) {
    const p = pass;
    if (!p || p.done || !Array.isArray(packet)) return false;
    p.lastNativeSelector = String(
      target === "clock" ||
        (target === "metric_spectrum" && packet[0] === "native")
        ? packet[2]
        : packet[0],
    ).slice(0, 128);
    try {
      requireValue(
        packet.length <= (target === "metric_spectrum" ? 191 : 64),
        "metric_native_packet_bound",
      );
      if (target === "metric_mel") {
        requireValue(p.mel, "metric_unrequested_mel_packet");
        p.mel.receive(packet);
      } else if (target === "metric_spectrum") receiveSpectrum(p, packet);
      else if (target === "clock") {
        requireValue(packet[0] === "native", "metric_clock_packet");
        if (packet[1] !== p.control.generation) {
          if (retired.has(packet[1])) return false;
          throw new Error("metric_foreign_clock");
        }
        const values = packet.slice(3);
        if (packet[2] === "clock") clock(p, values);
        else if (packet[2] === "dsp") {
          requireValue(
            equal(values, [
              1,
              p.config.geometry.sampleRate,
              p.config.geometry.vectorSize,
            ]),
            "metric_dsp_changed",
          );
          p.dsp = copy(values);
        } else if (packet[2] === "clock-cohort-skipped") {
          requireValue(
            values.length === 5 &&
              values.every(
                (value) =>
                  Number.isSafeInteger(value) &&
                  value >= 0 &&
                  value <= 281474976710655,
              ) &&
              values[0] > 0 &&
              values[0] <= 1000000,
            "metric_invalid_clock_skip_evidence",
          );
          emit(
            p,
            p.armProof ? "capture" : "preflight",
            "progress",
            undefined,
            "native_clock_cohort_skipped",
            undefined,
            [
              "skipped",
              "hostBefore",
              "hostAfter",
              "nativeBefore",
              "nativeAfter",
            ].map((field, index) => ({
              field: `clock.acquisition.${field}`,
              actual: { state: "observed", value: values[index] },
            })),
          );
        } else if (packet[2] === "tempo") {
          requireValue(
            equal(values, [p.config.geometry.tempoBpm]),
            "metric_tempo_changed",
          );
          p.tempoSeen = true;
        } else if (packet[2] === "abi-clock")
          requireValue(equal(values, [2]), "metric_clock_abi");
        else if (packet[2] === "ioError")
          throw new Error("metric_clock_io_failed");
      } else {
        requireValue(
          target === "metric_envelope" &&
            packet.length === 2 &&
            typeof packet[1] === "string" &&
            Buffer.byteLength(packet[1]) <= 32768,
          "metric_envelope_packet",
        );
        const body = JSON.parse(packet[1]);
        if (!ownerMatches(p, body.owner)) {
          if (retired.has(body.owner?.generation)) return false;
          throw new Error("metric_foreign_envelope");
        }
        if (packet[0] === "native_metric_evidence") receiveEvidence(p, body);
        else if (packet[0] === "native_metric_status") {
          requireValue(body.nativeEpoch === p.epoch, "metric_status_epoch");
          p.status = copy(body);
          if (body.state === "failed" && !p.wantCleanup)
            abortIo(p, body.reason);
        } else if (packet[0] === "native_metric_prefix_record") {
          if (!p.wantCleanup) receiveRecord(p, body);
        } else if (
          packet[0] === "native_metric" &&
          body.family === "control" &&
          body.status === "progress" &&
          body.reason === "readback_cohort_skipped"
        ) {
          const detail = body.progress;
          requireValue(
            body.nativeEpoch === p.epoch &&
              [
                "metric_configuration_sample",
                "metric_timing_sample",
                "metric_level_sample",
                "metric_detector_sample",
              ].includes(detail?.bank) &&
              Number.isSafeInteger(detail.skipped) &&
              detail.skipped > 0 &&
              detail.skipped <= 1000000 &&
              [detail.counterBefore, detail.counterAfter].every(
                (value) =>
                  Number.isSafeInteger(value) &&
                  value >= 0 &&
                  value <= 281474976710655,
              ) &&
              detail.counterAfter > detail.counterBefore,
            "metric_invalid_readback_skip_evidence",
          );
          emit(
            p,
            p.armProof ? "capture" : "preflight",
            "progress",
            undefined,
            "native_metric_cohort_skipped",
            undefined,
            ["bank", "skipped", "counterBefore", "counterAfter"].map(
              (field) => ({
                field: `metric.acquisition.${field}`,
                actual: { state: "observed", value: detail[field] },
              }),
            ),
          );
        } else if (
          packet[0] === "native_metric" &&
          body.family === "control" &&
          body.status === "failed" &&
          !p.wantCleanup
        ) {
          p.ioFailureDetail = copy(body.progress || {});
          if (Array.isArray(body.progress?.readback))
            p.ioFailureReadback = body.progress.readback.slice(0, 8);
          abortIo(p, body.reason);
        }
      }
      return true;
    } catch (error) {
      p.inputFailureDetail ??= String(error.message).slice(0, 256);
      const clockIssue = error.issues?.find(
        (issue) =>
          issue.path?.[0] === "frames" && Number.isInteger(issue.path[1]),
      );
      if (clockIssue && p.clocks[clockIssue.path[1]])
        p.failedClockReadback ??= p.clocks[clockIssue.path[1]];
      abort(
        p,
        /^[a-z][a-z0-9_]{0,127}$/.test(error.message)
          ? error.message
          : "metric_native_evidence_rejected",
      );
      return false;
    }
  }
  function control(raw, action) {
    const parsed = codec.listenerControlMetricSchema.parse(raw);
    requireValue(parsed.action === action, "metric_control_action");
    return copy(parsed);
  }
  function sameControl(p, value) {
    return (
      OWNER.every((key) => value[key] === p.control[key]) &&
      value.jobId === p.control.jobId &&
      value.mode === p.control.mode
    );
  }
  function prepare(raw, admission) {
    requireValue(!disposed && (!pass || pass.done), "metric_controller_busy");
    const command = control(raw, "prepare");
    requireValue(
      !command.config.requestedMetrics.includes("mel-bands") ||
        options.melEnabled === true,
      "metric_mel_adapter_unavailable",
    );
    requireValue(
      command.config.sourceContext,
      "metric_source_context_required",
    );
    const started = time();
    requireValue(
      admission &&
        integer(admission.nativeEpoch, 1000000) &&
        admission.nativeEpoch > epochHighWater &&
        Number.isFinite(admission.deadlineMs) &&
        admission.deadlineMs > started &&
        admission.deadlineMs <= started + 120000 &&
        integer(admission.maxObservationBytes, 4 * 1024 * 1024) &&
        admission.maxObservationBytes > 0,
      "metric_admission_required",
    );
    const ownership = {
      ...Object.fromEntries(OWNER.map((k) => [k, command[k]])),
      nativeEpoch: admission.nativeEpoch,
    };
    if (pass) {
      retired.add(pass.control.generation);
      if (retired.size > 16) retired.delete(retired.values().next().value);
    }
    epochHighWater = admission.nativeEpoch;
    pass = {
      control: command,
      config: command.config,
      epoch: admission.nativeEpoch,
      ownership: copy(ownership),
      expected: codec.snapshotNativeMetricListeningExpectation({
        ...ownership,
        config: command.config,
      }),
      ids: IDS.map((key) => command[key]),
      started,
      deadline: admission.deadlineMs,
      budget: admission.maxObservationBytes,
      state: "preflight",
      stageStarted: started,
      done: false,
      failure: null,
      cancelControl: null,
      replyPending: command,
      lastEvent: command.causationId,
      events: 0,
      admittedRecords: 0,
      metricCounts: {},
      deliveries: 0,
      queryDeliveries: 0,
      disarmCounter: null,
      lastClock: null,
      clocks: [],
      clockHistory: [],
      spectrum: {
        enabled:
          options.spectrumEnabled === true &&
          command.config.requestedMetrics.includes("spectral-centroid"),
        started: false,
        phase: null,
        phaseUnavailable: false,
        acquisitions: [],
        pending: [],
        streaming: false,
        failure: null,
        handoff: null,
        cleanupStarted: null,
        cleanupEvidence: null,
        released: false,
      },
      dsp: null,
      tempoSeen: false,
      ioStarted: false,
      armSent: false,
      wantCleanup: false,
      evidence: null,
      status: null,
      armProof: null,
      coordinates: null,
      launch: null,
      sourceProof: null,
      after: [],
      playingClocks: [],
      witnesses: {},
      families: {},
      lastPoll: -Infinity,
      samples: Object.fromEntries(
        GROUPS.map((g) => [g, { timing: [], configuration: [] }]),
      ),
    };
    if (command.config.requestedMetrics.includes("mel-bands")) {
      const p = pass;
      p.mel = createMelBandHandoff({
        epoch: p.epoch,
        sampleRate: p.config.geometry.sampleRate,
        totalSamples: p.config.geometry.totalSamples,
        codec,
        now: time,
        send: (selector, args) => send(p, selector, args, "metric_mel"),
        emit: (event) => {
          p.metricCounts["mel-bands"] = event.frames;
          emit(
            p,
            event.phase,
            event.stage,
            "mel-bands",
            event.reason,
            event.durationMs,
            event.facts,
          );
        },
      });
    }
    emit(pass, "preflight", "queued");
    emit(pass, "preflight", "started");
    if (
      !pass.spectrum.enabled &&
      !pass.mel &&
      !pass.config.requestedMetrics.some(
        (metric) => metric === "level" || metric === "attacks",
      )
    )
      abort(pass, "metric_no_requested_metric_available");
    return true;
  }
  function arm(raw) {
    const p = pass;
    const command = control(raw, "arm");
    requireValue(
      current(p) &&
        sameControl(p, command) &&
        p.state === "ready" &&
        !p.wantCleanup,
      "metric_arm_not_ready",
    );
    p.armControl = command;
    p.replyPending = command;
    p.state = "arm-pending";
    p.armRequestedCounter = p.lastClock[4];
    p.stageStarted = time();
    emit(p, "arm", "queued");
    return true;
  }
  function cancel(raw) {
    const command = control(raw, "cancel");
    const p = pass;
    if (!p || p.done || !sameControl(p, command)) return false;
    p.cancelControl = command;
    p.wantCleanup = true;
    return true;
  }
  function startCollector(p) {
    const g = p.config.geometry;
    p.collectorOwner = copy({
      generation: p.control.generation,
      nativeEpoch: p.epoch,
      arm: p.armProof.receipt.timing[5],
    });
    p.collector = createMetricTimelines(
      {
        owner: p.collectorOwner,
        originSample: p.coordinates.originCounter,
        originBeat: g.startBeat,
        sampleRate: g.sampleRate,
        vectorSize: g.vectorSize,
        tempo: g.tempoBpm,
        startBeat: g.startBeat,
        endBeat: g.endBeat,
        captureStartSample: p.coordinates.startSample,
        captureEndSample: p.coordinates.endSample,
        ...(p.config.requestedMetrics.length === 1 && p.mel
          ? { externalOnly: "mel-bands" }
          : {}),
        requestedMetrics: p.config.requestedMetrics
          .filter((metric) => metric !== "mel-bands")
          .map((metric) =>
            metric === "spectral-centroid" ? "spectrum" : metric,
          ),
        spectrum: {
          firstEndSample: p.spectrum.phase
            ? codec.nativeMetricFirstSpectrumEndpoint(
                p.spectrum.phase,
                p.coordinates.originCounter,
              )
            : null,
        },
        attacks: p.config.attacks,
        traceId: p.control.traceId,
        correlationId: p.control.correlationId,
        causationId: p.control.causationId,
      },
      {
        now: time,
        onEvent: (event) => {
          if (event.metricId && integer(event.acceptedRecords, 2000))
            p.metricCounts[event.metricId] = event.acceptedRecords;
          emit(
            p,
            "capture",
            event.stage,
            ["level", "attacks", "spectrum"].includes(event.metricId)
              ? event.metricId
              : undefined,
            event.reason,
          );
        },
      },
    );
    for (const metric of p.config.requestedMetrics.filter(
      (metric) => metric !== "spectral-centroid" && metric !== "mel-bands",
    ))
      p.families[metric === "attacks" ? "detector-level" : metric] = {
        next: 1,
        outstanding: false,
        failure: null,
      };
    if (p.spectrum.phase && !p.spectrum.failure) {
      const first = p.collector.envelope.spectrum.firstEndSample;
      const count = Math.max(
        0,
        Math.floor((p.coordinates.endSample - first) / 2048) + 1,
      );
      p.spectrum.expectedCount = count;
      p.spectrum.handoff = createMetricSpectrumHandoff(
        {
          owner: p.collectorOwner,
          expected: {
            sampleRate: g.sampleRate,
            captureStartSample: p.coordinates.startSample,
            captureEndSample: p.coordinates.endSample,
            firstFrameEndCounter: first,
            supportSamples: 2048,
            hopSamples: 2048,
            expectedCount: count,
            invalidFrames: 0,
          },
          binding: { abi: p.spectrum.abi, ready: p.spectrum.ready },
        },
        {
          collector: p.collector,
          now: time,
          onEvent: (event) => {
            if (event.stage === "failed") p.spectrum.failure ||= event.reason;
            p.metricCounts.spectrum =
              p.collector.progress().metrics.spectrum.acceptedRecords;
            emit(
              p,
              "capture",
              event.stage,
              "spectrum",
              event.reason || undefined,
              undefined,
              event.facts,
            );
          },
        },
      );
      for (const packet of p.spectrum.pending)
        p.spectrum.handoff.receive(packet);
    } else if (p.spectrum.failure && p.spectrum.phase)
      p.collector.failMetric("spectrum", "analyzer_failed");
    p.spectrum.pending = [];
  }
  function cleanup(p) {
    if (p.released) return !(p.deliveries || p.queryDeliveries) || !!p.failure;
    p.cleanupDeadline ??= Math.min(p.deadline, time() + 2000);
    const spectrumClean = cleanupSpectrum(p);
    const melClean = p.mel ? p.mel.stop(!!p.cancelControl) : true;
    let diagnosticsClean = true;
    try {
      diagnosticsClean = options.beforeCleanup
        ? options.beforeCleanup(p.control, !!p.cancelControl)
        : true;
    } catch {
      diagnosticsClean = false;
      abort(p, "metric_diagnostic_cleanup_failed");
    }
    if (time() >= p.cleanupDeadline || p.evidence?.cleanup === "failed") {
      p.failure = "metric_cleanup_unconfirmed";
      p.cleanupFailed = true;
      return true;
    }
    if (!p.ioStarted) return false;
    const idle = p.samples.idle;
    if (!p.armSent && (!idle.configuration.length || !idle.timing.length))
      return false;
    if (!melClean) return false;
    if (!p.cleanupStarted) {
      p.cleanupStarted = time();
      p.cleanupCounter = Math.max(
        p.lastClock?.[4] || 0,
        ...GROUPS.flatMap((g) =>
          ["timing", "configuration"].flatMap((k) =>
            p.samples[g][k].map((r) => r.nativeSourceCounter),
          ),
        ),
      );
      emit(p, "cleanup", "queued");
      emit(p, "cleanup", "started");
      io(p, "stop");
      return false;
    }
    const c = p.samples.cleanup.configuration.at(-1);
    const t = p.samples.cleanup.timing.at(-1);
    if (
      p.evidence?.cleanup === "completed" &&
      spectrumClean &&
      melClean &&
      diagnosticsClean &&
      c &&
      t &&
      c.nativeSourceCounter > p.cleanupCounter &&
      t.nativeSourceCounter > p.cleanupCounter
    ) {
      codec.nativeMetricIdleConfigurationReadbackSchema.parse(c.raw);
      codec.nativeMetricIdleTimingSchema.parse(t.raw);
      requireValue(
        c.raw[0] === c.raw[11] &&
          (c.raw[0] === p.epoch ||
            c.raw[0] === p.samples.idle.configuration.at(-1)?.raw[0]),
        "metric_cleanup_epoch_mismatch",
      );
      if (!p.released) {
        io(p, "release");
        p.released = true;
        emit(
          p,
          "cleanup",
          "completed",
          undefined,
          undefined,
          time() - p.cleanupStarted,
        );
      }
      return !(p.deliveries || p.queryDeliveries) || !!p.failure;
    }
    return false;
  }
  function finish(p) {
    if (p.failure || p.cancelControl) {
      const cancelled = !p.failure && !!p.cancelControl;
      const status = cancelled ? "cancelled" : "failed";
      const reason = p.failure || "cancelled";
      if (p.collector && !p.finalized) p.collector.cancel();
      emit(p, "capture", status, undefined, reason);
      const actual = p.cancelControl || p.replyPending || p.control;
      try {
        if (cancelled) {
          requireValue(
            options.sendListenerResult(actual, {
              status,
              reason,
              nativeLifecycle: p.terminalLifecycle,
            }) === true,
            "metric_terminal_delivery_failed",
          );
          requireValue(
            options.sendListenerReply(actual, { status, reason }) === true,
            "metric_terminal_delivery_failed",
          );
        } else if (p.replyPending) {
          requireValue(
            options.sendListenerReply(actual, { status, reason }) === true,
            "metric_terminal_delivery_failed",
          );
        } else {
          requireValue(
            options.sendListenerResult(actual, {
              status,
              reason,
              nativeLifecycle: p.terminalLifecycle,
            }) === true,
            "metric_terminal_delivery_failed",
          );
        }
      } catch {
        p.failure = "metric_terminal_delivery_failed";
        emit(p, "capture", "failed", undefined, p.failure);
      }
      p.state = p.failure ? "failed" : status;
      p.done = true;
      return;
    }
    if (p.spectrum.started) {
      p.sourceProof = copy({
        ...p.sourceProof,
        ...(p.spectrum.phase ? { spectrumPhase: p.spectrum.phase } : {}),
        spectrumCleanup: p.spectrum.cleanupEvidence,
      });
      p.spectrum.handoff?.finish();
    }
    const checked = codec.assertNativeMetricSourceCoverage(
      p.sourceProof,
      p.expected,
    );
    const result = p.collector.finalize({
      owner: p.collectorOwner,
      sourceEndSample: checked.endSample,
    });
    p.finalized = true;
    const melTimeline = p.mel?.timeline();
    const usefulMel =
      melTimeline &&
      (melTimeline.frames.length > 0 || melTimeline.expectedRecords === 0);
    requireValue(
      (result.envelope.requestedMetrics.length > 0 &&
        (result.status === "completed" || result.status === "partial")) ||
        usefulMel,
      "metric_no_useful_data",
    );
    const observation = adaptMetricTimelineObservation(
      result,
      {
        collectorOwner: p.collectorOwner,
        ownership: p.ownership,
        source: p.config.sourceContext,
        sharedIntegrity: "validated",
        ...(usefulMel ? { externalMetricAvailable: "mel-bands" } : {}),
        sourceCoverage: {
          startSample: checked.startSample,
          endSample: checked.endSample,
        },
        alignment: checked.alignment,
      },
      {
        schemaVersion: "metric-audio-observation/v1",
        parse: (value) => {
          if (!melTimeline)
            return codec.metricAudioObservationSchema.parse(value);
          const extended = {
            ...value,
            requestedMetrics: p.config.requestedMetrics,
            metrics: { ...value.metrics, "mel-bands": melTimeline },
            outcome:
              value.outcome === "complete" && melTimeline.status === "complete"
                ? "complete"
                : "partial",
          };
          return codec.metricAudioObservationSchema.parse({
            ...extended,
            rows: codec.createMetricObservationReportRows(extended),
          });
        },
        createReportRows: codec.createMetricObservationReportRows,
        now: time,
        onEvent: (event) => emit(p, "capture", event.stage),
      },
    );
    const accepted = codec.assertNativeMetricObservationSource(
      p.sourceProof,
      observation,
      p.expected,
    );
    requireValue(
      Buffer.byteLength(JSON.stringify(accepted)) <= p.budget,
      "metric_observation_budget_exceeded",
    );
    if (time() >= p.deadline) abort(p, "metric_deadline_exceeded");
    if (p.cancelControl || p.failure) return finish(p);
    const outcome = accepted.outcome === "complete" ? "completed" : "partial";
    const sent = options.sendListenerResult(p.control, {
      status: outcome,
      observation: accepted,
      nativeSourceCoverage: p.sourceProof,
    });
    if (sent !== true && p.cancelControl && !p.failure) return finish(p);
    requireValue(sent === true, "metric_publication_rejected");
    p.state = outcome;
    p.done = true;
  }
  function drive(p) {
    const now = time();
    if (now >= p.deadline) abort(p, "metric_deadline_exceeded");
    if (p.state === "preflight" && now - p.started >= 2000 && !p.wantCleanup)
      abort(p, "metric_preflight_timeout");
    if (p.failure || p.cancelControl) p.wantCleanup = true;
    if (p.released) {
      if ((p.deliveries || p.queryDeliveries) && now >= p.cleanupDeadline)
        abort(p, "metric_control_delivery_timeout");
      if (!(p.deliveries || p.queryDeliveries) || p.failure) finish(p);
      return;
    }
    if (p.disarmCounter === null && p.lastClock) {
      p.disarmCounter = p.lastClock[4];
      p.clocks = [];
      send(p, "epoch", [0]);
    }
    if (!p.ioStarted && now >= p.deadline) {
      p.cleanupFailed = true;
      p.failure = "metric_cleanup_unconfirmed";
      finish(p);
      return;
    }
    if (
      !p.ioStarted &&
      p.disarmCounter !== null &&
      p.lastClock &&
      p.dsp &&
      p.tempoSeen &&
      p.lastClock[4] >= p.disarmCounter + p.config.geometry.vectorSize
    ) {
      p.ioStarted = true;
      io(p, "begin", [p.epoch, p.deadline]);
    }
    if (!p.ioStarted) return;
    // Admit all query producers together so async mel drains cannot starve native receipts.
    if (now - p.lastPoll >= 10 && !p.queryDeliveries) {
      p.lastPoll = now;
      io(p, "metric_evidence");
      io(p, "metric_status");
      io(p, "callerTick");
      if (p.spectrum.cleanupStarted !== null && !p.spectrum.released) {
        spectrumControl(p, "spectrum_cleanup_tick");
        spectrumControl(p, "spectrum_cleanup_evidence");
      }
      p.mel?.tick();
    }
    if (p.wantCleanup) {
      if (cleanup(p)) finish(p);
      return;
    }
    if (p.deliveries) return;
    if (p.state === "preflight") {
      requireValue(now - p.started < 2000, "metric_preflight_timeout");
      const c = p.samples.idle.configuration;
      const t = p.samples.idle.timing;
      const receipt = dspReceipt(c, t);
      if (!receipt || p.clocks.length < 32) {
        p.preflightBlocker = !receipt
          ? "missing_idle_receipts"
          : "missing_coherent_clock";
        return;
      }
      const low = p.clocks[0][4],
        high = p.clocks.at(-1)[4];
      if (
        [...c, ...t].some(
          (r) => r.nativeSourceCounter < low || r.nativeSourceCounter > high,
        )
      ) {
        p.preflightBlocker = "idle_receipts_outside_clock_bracket";
        return;
      }
      const ready = codec.assertNativeMetricReadyProof(
        {
          scope: p.config.scope,
          phase: "idle-preflight",
          configurationEvidence: "admitted-not-executed",
          ownership: p.ownership,
          config: p.config,
          disarmCounter: p.disarmCounter,
          before: { dsp: p.dsp, frames: p.clocks },
          idle: {
            ...receipt,
            configurationCounter: c[0].nativeSourceCounter,
            confirmedConfigurationCounter: c[1].nativeSourceCounter,
            timingCounter: t[0].nativeSourceCounter,
            confirmedTimingCounter: t[1].nativeSourceCounter,
          },
          elapsedMs: now - p.started,
        },
        p.expected,
      );
      p.preflightBlocker = null;
      p.configurationStarted = now;
      emit(p, "configuration", "queued");
      emit(p, "configuration", "started");
      io(p, "configure_metric", configuration(p));
      if (p.wantCleanup) return;
      requireValue(
        options.sendListenerReply(p.control, {
          status: "ready",
          nativeReady: ready,
        }) === true,
        "metric_ready_delivery_failed",
      );
      p.replyPending = null;
      p.state = "ready";
      emit(p, "preflight", "completed", undefined, undefined, now - p.started);
    } else if (p.state === "arm-pending") {
      requireValue(now - p.stageStarted < 2000, "metric_arm_preflight_timeout");
      if (!prepareSpectrum(p, now)) return;
      if (p.wantCleanup) return;
      if (p.clocks.length !== 32 || p.clocks[0][4] <= p.armRequestedCounter)
        return;
      p.before = copy({ dsp: p.dsp, frames: p.clocks });
      for (const row of p.clocks) updateWitnesses(p, row);
      p.armStarted = now;
      p.armSent = true;
      p.state = "arming";
      emit(p, "arm", "started");
      io(p, "arm");
      if (!p.wantCleanup) p.mel?.arm();
    } else if (p.state === "arming") {
      requireValue(now - p.armStarted < 1000, "metric_arm_receipt_timeout");
      const receipt = dspReceipt(
        p.samples.currentEpoch.configuration,
        p.samples.currentEpoch.timing,
      );
      if (!receipt) return;
      p.armProof = codec.assertNativeMetricArmProof(
        {
          scope: p.config.scope,
          ownership: p.ownership,
          config: p.config,
          before: p.before,
          receipt,
        },
        p.expected,
      );
      if (p.mel && !p.mel.snapshot().ready) return;
      requireValue(
        options.sendListenerReply(p.armControl, {
          status: "armed",
          nativeArm: p.armProof,
        }) === true,
        "metric_arm_delivery_failed",
      );
      p.replyPending = null;
      p.state = "armed";
      emit(
        p,
        "configuration",
        "completed",
        undefined,
        undefined,
        now - p.configurationStarted,
      );
      emit(p, "arm", "completed", undefined, undefined, now - p.armStarted);
      p.launchStarted = now;
      emit(p, "launch", "queued");
      emit(p, "launch", "started");
    } else if (p.state === "armed") {
      requireValue(now - p.armStarted < 10000, "metric_launch_timeout");
      const timing = p.samples.currentEpoch.timing.at(-1)?.raw;
      if (!timing || timing[1] < 0 || p.lastClock[0] !== 1) return;
      if (
        timing[3] === 0 &&
        p.lastClock[4] <
          timing[6] +
            p.config.geometry.totalSamples +
            p.config.geometry.vectorSize -
            1
      )
        return;
      p.launch = copy({
        scope: p.config.scope,
        ownership: p.ownership,
        timing,
        clock: p.lastClock,
        elapsedMs: now - p.armStarted,
      });
      p.coordinates = codec.nativeMetricLaunchCoordinates(
        p.armProof,
        p.launch,
        p.expected,
      );
      p.mel?.bind({
        startSample: p.coordinates.startSample,
        endSample: p.coordinates.endSample,
      });
      requireValue(
        options.sendListenerResult(p.control, {
          status: "progress",
          nativeLaunch: p.launch,
        }) === true,
        "metric_launch_delivery_failed",
      );
      p.state = "capturing";
      emit(
        p,
        "launch",
        "completed",
        undefined,
        undefined,
        now - p.launchStarted,
      );
      if (!p.wantCleanup) startCollector(p);
    } else if (p.state === "capturing" || p.state === "draining") {
      if (p.lastClock[4] >= p.coordinates.endSample && !p.drainStarted) {
        p.drainStarted = now;
        p.drainDeadline = Math.min(p.deadline, now + 2000);
        p.state = "draining";
        emit(p, "drain", "queued");
        emit(p, "drain", "started");
        emit(p, "post-binding", "queued");
        emit(p, "post-binding", "started");
      }
      const endpoint =
        p.coordinates.endSample + p.config.geometry.vectorSize - 1;
      const c = p.samples.currentEpoch.configuration;
      const t = p.samples.currentEpoch.timing;
      if (
        !p.sourceProof &&
        p.after.length === 32 &&
        c.length === 2 &&
        t.length === 2 &&
        [...c, ...t].every((r) => r.nativeSourceCounter >= endpoint)
      ) {
        const completion = dspReceipt(c, t);
        if (completion && completion.timing[3] === 0) {
          p.sourceProof = copy({
            armed: p.armProof,
            launched: p.launch,
            completion,
            after: { dsp: p.dsp, frames: p.after },
            timingWitnesses: p.witnesses,
            postElapsedMs: now - p.drainStarted,
          });
          codec.assertNativeMetricSourceCoverage(p.sourceProof, p.expected);
          emit(
            p,
            "post-binding",
            "completed",
            undefined,
            undefined,
            now - p.drainStarted,
          );
        }
      }
      let drained = true;
      if (p.mel && !p.mel.snapshot().completed) drained = false;
      if (
        p.spectrum.handoff &&
        !p.spectrum.failure &&
        p.collector.progress().metrics.spectrum.acceptedRecords <
          p.spectrum.expectedCount
      )
        drained = false;
      for (const [family, f] of Object.entries(p.families)) {
        const status = p.status?.families?.[family];
        if (!status) {
          drained = false;
          continue;
        }
        requireValue(
          integer(status.accepted, 2000),
          "metric_invalid_available_count",
        );
        if (f.next <= status.accepted && !f.failure) {
          drained = false;
          if (!f.outstanding) {
            f.outstanding = true;
            io(p, "metric_prefix_record", [family, f.next]);
          }
        }
        if (!["failed", "completed"].includes(status.state)) drained = false;
        if (status.state === "failed" && f.next > status.accepted)
          f.failure ||= "analyzer_failed";
        f.done =
          !!f.failure ||
          (status.state === "completed" && f.next > status.accepted);
      }
      if (
        p.drainStarted &&
        p.sourceProof &&
        (drained || now >= p.drainDeadline)
      ) {
        for (const [family, f] of Object.entries(p.families)) {
          const metric = family === "detector-level" ? "attacks" : family;
          if (f.failure) p.collector.failMetric(metric, f.failure);
          else if (!f.done) p.collector.failMetric(metric, "stalled");
        }
        if (
          p.spectrum.handoff &&
          !p.spectrum.failure &&
          p.collector.progress().metrics.spectrum.acceptedRecords <
            p.spectrum.expectedCount
        )
          p.spectrum.handoff.stall();
        emit(
          p,
          "drain",
          "completed",
          undefined,
          undefined,
          now - p.drainStarted,
        );
        p.wantCleanup = true;
      } else if (p.drainStarted && now >= p.drainDeadline && !p.sourceProof)
        abort(p, "metric_source_coverage_missing");
    }
  }
  function tick() {
    const p = pass;
    if (!p || p.done || pumping) return false;
    pumping = true;
    try {
      drive(p);
      if (p.wantCleanup && !p.done && cleanup(p)) finish(p);
    } catch (error) {
      abort(
        p,
        /^[a-z][a-z0-9_]{0,127}$/.test(error.message)
          ? error.message
          : "metric_controller_integrity_failed",
      );
    } finally {
      pumping = false;
    }
    return !p.done;
  }
  function dispose() {
    disposed = true;
    if (pass && !pass.done) abort(pass, "metric_controller_disposed");
  }
  function snapshot() {
    if (!pass) return freeze({ state: disposed ? "disposed" : "idle" });
    return freeze({
      state: pass.state,
      generation: pass.control.generation,
      nativeEpoch: pass.epoch,
      admittedRecords: pass.admittedRecords,
      reason: pass.failure,
      inputFailureReason: pass.inputFailureReason || null,
      inputFailureDetail: pass.inputFailureDetail || null,
      ioFailureReason: pass.evidence?.reason || pass.status?.reason || null,
      ioFailureReadback: pass.ioFailureReadback || null,
      ioFailureDetail: pass.ioFailureDetail || null,
      preflightBlocker: pass.preflightBlocker || null,
      lastNativeSelector: pass.lastNativeSelector || null,
      clockReadback:
        pass.failedClockReadback ||
        pass.clocks.at(-1) ||
        pass.lastClock ||
        null,
      clockFirstPhase: pass.clocks[0]?.[5] ?? null,
      clockFirstReadback: pass.clocks[0] || null,
      spectrum: {
        enabled: pass.spectrum.enabled,
        started: pass.spectrum.started,
        phase: pass.spectrum.phase
          ? "bound"
          : pass.spectrum.phaseUnavailable
            ? "unavailable"
            : "pending",
        failure: pass.spectrum.failure,
        fftInformation: pass.spectrum.fftInformation || null,
        lastHeader: pass.spectrum.lastHeader || null,
        lastReadbackCounter: pass.spectrum.lastReadbackCounter ?? null,
        startError: pass.spectrum.startError || null,
        acquisitions: pass.spectrum.acquisitions.map((row) => [...row]),
        pendingRecords: pass.spectrum.pending.length,
        receivedRecords: pass.spectrum.receivedRecords || 0,
        lastHandoffResult: pass.spectrum.lastHandoffResult || null,
        acceptedRecords:
          pass.collector?.progress().metrics.spectrum?.acceptedRecords || 0,
        cleanup: pass.spectrum.cleanupEvidence?.status || "not-started",
        released: pass.spectrum.released,
      },
      mel: pass.mel?.snapshot() || null,
      cleanup: pass.cleanupFailed
        ? "failed"
        : pass.released
          ? "completed"
          : pass.cleanupStarted
            ? "pending"
            : "not-started",
    });
  }
  return Object.freeze({
    prepare,
    arm,
    cancel,
    receiveNative,
    tick,
    dispose,
    snapshot,
  });
}

module.exports = Object.freeze({ createMetricController });
