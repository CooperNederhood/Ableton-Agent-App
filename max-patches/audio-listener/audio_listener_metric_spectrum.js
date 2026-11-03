/* global module, require */
"use strict";

const {
  decodeRetentionSnapshot,
  decodeRetentionRejection,
  decodeIORejection,
} = require("./audio_listener_native_io.js");

const COUNTER_MAX = 2 ** 44 - 1;
const CAPACITY = 32;
const WIDTH = 6;
const SUPPORT = 2048;
const MAX_RECORDS = 706;
const MAX_PROGRESS = 128;
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const integer = (value, min = 0, max = COUNTER_MAX) =>
  Number.isSafeInteger(value) && value >= min && value <= max;
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const uuid = (value) =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );

class SpectrumHandoffError extends Error {
  constructor(code, classification = "admission") {
    super(code);
    this.name = "SpectrumHandoffError";
    this.code = code;
    this.classification = classification;
  }
}
function requireValue(condition, code, classification) {
  if (!condition) throw new SpectrumHandoffError(code, classification);
}
function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function sameOwner(left, right) {
  return (
    object(left) &&
    object(right) &&
    left.generation === right.generation &&
    left.nativeEpoch === right.nativeEpoch &&
    left.arm === right.arm
  );
}
function ownerCopy(value) {
  requireValue(
    object(value) &&
      uuid(value.generation) &&
      integer(value.nativeEpoch, 1, 1000000) &&
      (integer(value.arm) ||
        (typeof value.arm === "string" &&
          /^[A-Za-z0-9_.:-]{1,128}$/.test(value.arm))),
    "invalid_handoff_owner",
  );
  return freeze({
    generation: value.generation,
    nativeEpoch: value.nativeEpoch,
    arm: value.arm,
  });
}
function exactBinding(packet, owner, type, values) {
  return (
    Array.isArray(packet) &&
    packet.length === 3 + values.length &&
    packet[0] === "native" &&
    packet[1] === owner.generation &&
    packet[2] === type &&
    values.every((value, index) => packet[index + 3] === value)
  );
}

/**
 * Post-forwarding Node stage, NOT a retention reader.
 *
 * Existing FFT selector measurement_frame -> NativeMessageIO.retainedFrame:
 * the existing ABI1 width6/capacity32 reader settles immutable DSP slots, forwards
 * ["native",generation,"spectrum",end,centroid,energy,start,end,invalidFrames],
 * then requests its next slot before ACKing the current slot. Node MUST NOT ACK.
 * Forwarding/Max ACK is not durable Node acceptance; send(false) is not checked
 * by NativeMessageIO.packet. Lost forwards remain gaps, never reconstructed.
 *
 * The six-value packet has NO epoch or FIFO sequence. Binding requires captured
 * abi-spectrum/retention-ready packets and a fresh controller-owned generation
 * per capture/epoch/arm (never reuse it for another owner). Per-frame indices come
 * only from independently admitted phase/support, NOT the first delivered frame.
 * This adapter cannot certify that control admission or physical source proof.
 *
 * config = {owner, expected:{sampleRate,captureStartSample,captureEndSample,
 * firstFrameEndCounter,supportSamples:2048,hopSamples:2048,expectedCount,
 * invalidFrames}, binding:{abi,ready}}.
 * options = {collector,now?,onEvent?}; all coordinates are native source counters.
 *
 * Instantiate only AFTER verified launch/phase. Earlier records require the
 * controller's EXISTING bounded staging; missing binding/phase is a denial.
 * No new startup FIFO, reordering queue, ACK callback or additional reader exists.
 *
 * receive(packet) accepts actual spectrum and existing retention telemetry.
 * The controller currently receives {generation,type,values}; its lossless call
 * is receive(["native",packet.generation,packet.type,...packet.values]) after
 * bounding that original packet. Route the FFT IO's family2 controls, not another
 * IO's readiness. Do not feed legacy latest-spectrum snapshots or assembler rows.
 * stats() returns observed counters (not live delivery proof). finish() closes
 * this stage before collector.finalize(sourceProof); source/drain deadlines and
 * global cancellation/publication remain host-owned. cancel() closes only this
 * handoff; the host separately cancels the shared capture when appropriate.
 * upstream.forwardedRecords is the last reader-reported expectedSequence - 1;
 * it may lag due to telemetry throttling. Pass the real terminal retention-state
 * for its final value. requestedSequence/visibleReadSequence require a coherent
 * diagnostic snapshot; unknown observations stay null, never inferred from data.
 * onEvent must be synchronous/nonthrowing; infrastructure exceptions propagate.
 */
function createMetricSpectrumHandoff(config, options) {
  requireValue(
    object(config) &&
      Object.keys(config).length === 3 &&
      Object.keys(config).every((key) =>
        ["owner", "expected", "binding"].includes(key),
      ),
    "invalid_handoff_config",
  );
  requireValue(
    object(options) &&
      Object.keys(options).every((key) =>
        ["collector", "now", "onEvent"].includes(key),
      ),
    "invalid_handoff_options",
  );
  const { collector } = options;
  requireValue(
    collector &&
      typeof collector.ingestSpectrum === "function" &&
      typeof collector.failMetric === "function" &&
      typeof collector.failShared === "function" &&
      typeof collector.progress === "function" &&
      object(collector.envelope),
    "invalid_handoff_collector",
  );
  const owner = ownerCopy(config.owner);
  const expected = config.expected;
  requireValue(
    object(expected) &&
      Object.keys(expected).length === 8 &&
      Object.keys(expected).every((key) =>
        [
          "sampleRate",
          "captureStartSample",
          "captureEndSample",
          "firstFrameEndCounter",
          "supportSamples",
          "hopSamples",
          "expectedCount",
          "invalidFrames",
        ].includes(key),
      ) &&
      [44100, 48000].includes(expected.sampleRate) &&
      integer(expected.captureStartSample) &&
      integer(expected.captureEndSample, expected.captureStartSample + 1) &&
      expected.captureEndSample - expected.captureStartSample <=
        expected.sampleRate * 30 &&
      integer(expected.firstFrameEndCounter, SUPPORT) &&
      expected.firstFrameEndCounter > expected.captureStartSample &&
      expected.firstFrameEndCounter <= expected.captureStartSample + SUPPORT &&
      expected.supportSamples === SUPPORT &&
      expected.hopSamples === SUPPORT &&
      integer(expected.invalidFrames, 0, 4096) &&
      integer(expected.expectedCount, 0, MAX_RECORDS) &&
      expected.expectedCount ===
        Math.max(
          0,
          Math.floor(
            (expected.captureEndSample - expected.firstFrameEndCounter) /
              SUPPORT,
          ) + 1,
        ),
    "invalid_expected_spectrum_geometry",
  );
  const env = collector.envelope;
  requireValue(
    sameOwner(owner, env.owner),
    "handoff_collector_owner_mismatch",
    "shared",
  );
  requireValue(
    env.requestedMetrics?.includes("spectrum") &&
      env.sampleRate === expected.sampleRate &&
      env.originSample === expected.captureStartSample &&
      env.captureStartSample === expected.captureStartSample &&
      env.captureEndSample === expected.captureEndSample &&
      env.spectrum?.firstEndSample === expected.firstFrameEndCounter &&
      env.spectrum?.supportSamples === SUPPORT &&
      env.spectrum?.hopSamples === SUPPORT,
    "handoff_collector_geometry_mismatch",
  );
  requireValue(
    object(config.binding) &&
      Object.keys(config.binding).length === 2 &&
      exactBinding(config.binding.abi, owner, "abi-spectrum", [2]) &&
      exactBinding(config.binding.ready, owner, "retention-ready", [
        2,
        1,
        owner.nativeEpoch,
      ]),
    "missing_or_invalid_executed_retention_binding",
  );
  const initialProgress = collector.progress();
  requireValue(
    !initialProgress.sealed &&
      initialProgress.metrics?.spectrum?.failure === null &&
      initialProgress.metrics.spectrum.acceptedRecords === 0,
    "handoff_collector_unavailable",
  );
  const admission = freeze({
    owner,
    expected: { ...expected },
    binding: {
      abi: [...config.binding.abi],
      ready: [...config.binding.ready],
    },
  });
  const geometry = admission.expected;
  const now =
    options.now === undefined
      ? () => globalThis.performance.now()
      : options.now;
  const onEvent = options.onEvent === undefined ? () => {} : options.onEvent;
  requireValue(
    typeof now === "function" && typeof onEvent === "function",
    "invalid_handoff_callbacks",
  );
  const startedAt = now();
  requireValue(finite(startedAt), "invalid_handoff_clock");
  let lastTime = startedAt,
    sealed = null,
    progressCount = 0;
  let failureFacts;
  const fingerprints = new Map();
  const upstream = {
    producedSequence: null,
    requestedSequence: null,
    visibleReadSequence: null,
    forwardedRecords: null,
    acknowledgedSequence: null,
    backlog: null,
    capacity: CAPACITY,
    highWaterMark: null,
    stage: null,
    snapshotStatus: null,
    snapshotDrops: null,
    staleObservations: 0,
    ignoredReadbacks: 0,
  };
  const node = {
    receivedPackets: 0,
    spectrumPackets: 0,
    acceptedRecords: 0,
    duplicateRecords: 0,
    rejectedRecords: 0,
    beforeExpected: 0,
    afterCapture: 0,
    lastAcceptedSequence: 0,
    pendingRecords: 0,
    pendingHighWaterMark: 0,
    acknowledgementsIssued: 0,
  };
  function increment(key) {
    node[key] = Math.min(Number.MAX_SAFE_INTEGER, node[key] + 1);
  }
  function elapsed() {
    const value = now();
    const delta = value - startedAt;
    requireValue(
      finite(value) &&
        value >= lastTime &&
        finite(delta) &&
        delta <= Number.MAX_SAFE_INTEGER,
      "invalid_handoff_clock",
    );
    lastTime = value;
    return delta;
  }
  function counters() {
    return freeze({
      upstream: { ...upstream },
      node: {
        ...node,
        missingRecords: geometry.expectedCount - node.acceptedRecords,
      },
    });
  }
  function emit(stage, reason = null) {
    onEvent(
      freeze({
        ...env.trace,
        generation: owner.generation,
        nativeEpoch: owner.nativeEpoch,
        metricId: "spectrum",
        scope: "native-spectrum-node-handoff/v1",
        stage,
        reason,
        elapsedMs: elapsed(),
        expectedRecords: geometry.expectedCount,
        acceptedRecords: node.acceptedRecords,
        missingRecords: geometry.expectedCount - node.acceptedRecords,
        upstream: { ...upstream },
        ...(failureFacts === undefined ? {} : { facts: failureFacts }),
      }),
    );
  }
  function gaps() {
    const result = [];
    let first = null;
    for (let sequence = 1; sequence <= geometry.expectedCount + 1; sequence++) {
      if (sequence <= geometry.expectedCount && !fingerprints.has(sequence))
        first ??= sequence;
      else if (first !== null) {
        result.push({
          firstSequence: first,
          lastSequence: sequence - 1,
          startSample:
            geometry.firstFrameEndCounter + (first - 1) * SUPPORT - SUPPORT,
          endSample: geometry.firstFrameEndCounter + (sequence - 2) * SUPPORT,
        });
        first = null;
      }
    }
    return result;
  }
  function close(status, reason = null, classification = null, effect = null) {
    if (sealed) return sealed;
    sealed = freeze({
      schema: "native-spectrum-node-handoff/v1",
      status,
      reason,
      classification,
      admission,
      counters: counters(),
      gaps: gaps(),
      durationMs: elapsed(),
      limitations: [
        "Max FIFO ACK and Node acceptance are separate stages; no Node ACK is issued.",
        "Spectrum packets carry generation only; epoch binding requires a unique generation and captured control admission.",
        "Observed retention counters are telemetry, not per-packet FIFO sequence or physical delivery proof.",
        "Source identity, independent FFT phase, source/drain deadlines and publication remain controller-owned.",
      ],
    });
    if (effect) effect();
    emit(status, reason);
    return sealed;
  }
  function reject(reason, classification = null) {
    return freeze({ accepted: false, reason, classification });
  }
  function metricFailure(reason, collectorReason = "malformed_record", facts) {
    if (facts !== undefined) failureFacts = freeze(facts);
    increment("rejectedRecords");
    close(node.acceptedRecords ? "partial" : "failed", reason, "metric", () =>
      collector.failMetric("spectrum", collectorReason),
    );
    return reject(reason, "metric");
  }
  function sharedFailure(reason, collectorReason = "transport_corruption") {
    increment("rejectedRecords");
    close("failed", reason, "shared", () =>
      collector.failShared(collectorReason),
    );
    return reject(reason, "shared");
  }
  function observed() {
    return freeze({ accepted: false, measurement: false, reason: "observed" });
  }
  function updateQueue(produced, acknowledged, highWater) {
    if (
      (upstream.producedSequence !== null &&
        produced < upstream.producedSequence) ||
      (upstream.acknowledgedSequence !== null &&
        acknowledged < upstream.acknowledgedSequence)
    ) {
      upstream.staleObservations = Math.min(
        Number.MAX_SAFE_INTEGER,
        upstream.staleObservations + 1,
      );
      return false;
    }
    upstream.producedSequence = produced;
    upstream.acknowledgedSequence = acknowledged;
    upstream.backlog = produced - acknowledged;
    upstream.highWaterMark = Math.max(upstream.highWaterMark ?? 0, highWater);
    return true;
  }
  function retentionState(values) {
    if (values.length !== 10 || !values.every(finite))
      return sharedFailure("invalid_retention_state_framing");
    const [
      family,
      stage,
      epoch,
      expectedSequence,
      produced,
      acknowledged,
      capacity,
      highWater,
      ms,
      fault,
    ] = values;
    if (family !== 1 && family !== 2)
      return sharedFailure("invalid_retention_family");
    if (family !== 2) return observed();
    if (epoch !== owner.nativeEpoch)
      return sharedFailure("foreign_retention_epoch", "owner_corruption");
    const backlog = produced - acknowledged;
    if (
      !integer(stage, 0, 5) ||
      !integer(expectedSequence, 1) ||
      !integer(produced) ||
      !integer(acknowledged, 0, produced) ||
      acknowledged > expectedSequence - 1 ||
      expectedSequence - 1 > produced ||
      capacity !== CAPACITY ||
      !integer(highWater, Math.min(backlog, CAPACITY), CAPACITY) ||
      ms < 0 ||
      ms > 120000 ||
      !integer(fault, 0, 5) ||
      (stage === 4) !== fault > 0 ||
      (backlog > CAPACITY && fault !== 1)
    )
      return sharedFailure("invalid_retention_state_bounds");
    if (updateQueue(produced, acknowledged, highWater)) {
      upstream.forwardedRecords = expectedSequence - 1;
      upstream.stage = stage;
    }
    if (stage === 5) {
      close("cancelled", "upstream_cancelled");
      return reject("upstream_cancelled", "closed");
    }
    if (stage !== 4) return observed();
    if (fault === 1)
      return metricFailure("upstream_capacity_overflow", "quota_overflow");
    if (fault === 2 || fault === 5)
      return sharedFailure(
        "upstream_control_or_owner_corruption",
        fault === 5 ? "owner_corruption" : "transport_corruption",
      );
    if (fault === 4)
      return metricFailure("upstream_forwarding_failed", "analyzer_failed");
    return sharedFailure("unclassified_upstream_reader_failure");
  }
  function snapshot(values) {
    const decoded = decodeRetentionSnapshot(values);
    if (!decoded) return sharedFailure("invalid_retention_snapshot_framing");
    if (decoded.family !== 2) return observed();
    if (decoded.nativeEpoch !== owner.nativeEpoch)
      return sharedFailure("foreign_retention_epoch", "owner_corruption");
    upstream.snapshotStatus = decoded.status;
    upstream.snapshotDrops = Math.max(
      upstream.snapshotDrops ?? 0,
      decoded.dropped,
    );
    let ignored = 0,
      coherent = 0;
    for (const { length, cells } of decoded.readbacks) {
      if (length !== WIDTH + 14 || !cells.every(finite)) {
        ignored++;
        continue;
      }
      if (
        cells[0] !== 1 ||
        cells[1] !== owner.nativeEpoch ||
        cells[1] !== cells[19] ||
        cells[2] !== cells[18] ||
        cells[3] !== cells[17] ||
        cells[4] !== cells[16]
      ) {
        ignored++;
        continue;
      }
      const [, , requested, , visible, , , produced, acknowledged] = cells;
      if (
        !integer(requested, 1) ||
        !integer(visible) ||
        !integer(produced) ||
        !integer(acknowledged, 0, produced)
      ) {
        ignored++;
        continue;
      }
      coherent++;
      if (
        updateQueue(
          produced,
          acknowledged,
          Math.min(CAPACITY, produced - acknowledged),
        )
      ) {
        upstream.requestedSequence = requested;
        upstream.visibleReadSequence = visible;
      }
    }
    upstream.ignoredReadbacks = Math.min(
      Number.MAX_SAFE_INTEGER,
      upstream.ignoredReadbacks + ignored,
    );
    if (decoded.status === "failed")
      return sharedFailure("upstream_failure_without_classification");
    return freeze({
      accepted: false,
      measurement: false,
      reason: "observed",
      coherentReadbacks: coherent,
      ignoredReadbacks: ignored,
    });
  }
  function upstreamRejection(values) {
    const decoded = decodeRetentionRejection(values);
    if (!decoded) return sharedFailure("invalid_retention_rejection_framing");
    if (decoded.family !== 2) return observed();
    if (decoded.nativeEpoch !== owner.nativeEpoch)
      return sharedFailure("foreign_retention_epoch", "owner_corruption");
    const reason = decoded.readerReason;
    if (reason === "invalid_numeric") {
      const last = decoded.readerReadbacks.at(-1);
      const row = last?.cells;
      const ownedHeader =
        last?.length === WIDTH + 14 &&
        row.length === WIDTH + 14 &&
        row.every(
          (cell, index) => (index >= 10 && index < 16) || finite(cell),
        ) &&
        row[0] === 1 &&
        row[1] === owner.nativeEpoch &&
        row[1] === row[19] &&
        row[2] === row[18] &&
        row[3] === row[17] &&
        row[4] === row[16] &&
        row[3] === owner.nativeEpoch &&
        row[4] === row[2] &&
        integer(row[2], 1) &&
        integer(row[5]) &&
        integer(row[6], row[5]) &&
        integer(row[7], row[4]) &&
        integer(row[8], 0, row[7]) &&
        integer(row[9], 0, 2);
      return ownedHeader && row.slice(10, 16).some((cell) => !finite(cell))
        ? metricFailure("upstream_invalid_numeric")
        : sharedFailure("upstream_invalid_numeric_framing");
    }
    if (
      [
        "invalid_arity",
        "invalid_abi",
        "invalid_owner_reset",
        "invalid_uninitialized_readback",
        "invalid_header_bounds",
        "invalid_slot_owner",
        "invalid_dsp_control",
      ].includes(reason)
    )
      return sharedFailure(
        `upstream_${reason}`,
        reason.includes("owner") ? "owner_corruption" : "transport_corruption",
      );
    return metricFailure(
      `upstream_${reason}`,
      reason === "unread_capacity_overflow"
        ? "quota_overflow"
        : "analyzer_failed",
      reason === "immutable_slot_changed"
        ? decoded.readerReadbacks
            .at(-1)
            ?.cells.slice(0, WIDTH + 14)
            .map((value, index) => {
              const prior = decoded.readerReadbacks.at(-2)?.cells[index];
              const observed = (cell) =>
                cell === undefined
                  ? { state: "unavailable", reason: "not-reported" }
                  : {
                      state: "observed",
                      value:
                        typeof cell === "number" &&
                        Math.abs(cell) <= Number.MAX_SAFE_INTEGER
                          ? cell
                          : String(cell),
                    };
              return {
                field: `spectrum.retention.cell.${index}`,
                actual: observed(value),
                expected: observed(prior),
              };
            })
        : undefined,
    );
  }
  function spectrum(values) {
    increment("spectrumPackets");
    if (values.length !== WIDTH)
      return sharedFailure("invalid_spectrum_framing");
    if (!values.every(finite)) return metricFailure("invalid_spectrum_numeric");
    const [end, centroid, energy, start, frameEnd, invalidFrames] = values;
    if (
      !integer(start) ||
      !integer(end, SUPPORT) ||
      end !== frameEnd ||
      end - start !== SUPPORT ||
      !integer(invalidFrames, 0, 4096)
    )
      return metricFailure("invalid_spectrum_support");
    if (invalidFrames !== geometry.invalidFrames)
      return metricFailure("fft_invalid_frames_changed", "analyzer_failed");
    if (
      energy < 0 ||
      energy > Number.MAX_SAFE_INTEGER ||
      centroid < 0 ||
      centroid > geometry.sampleRate / 2 ||
      (energy === 0 && centroid !== 0)
    )
      return metricFailure("invalid_spectrum_values", "malformed_record", [
        {
          field: "spectrum.centroidHz",
          actual: {
            state: "observed",
            value:
              Math.abs(centroid) <= Number.MAX_SAFE_INTEGER
                ? centroid
                : String(centroid),
          },
          unit: "Hz",
        },
        {
          field: "spectrum.energy",
          actual: {
            state: "observed",
            value:
              Math.abs(energy) <= Number.MAX_SAFE_INTEGER
                ? energy
                : String(energy),
          },
        },
      ]);
    const offset = (end - geometry.firstFrameEndCounter) / SUPPORT;
    if (!Number.isSafeInteger(offset))
      return metricFailure("unexpected_spectrum_phase", "support_mismatch");
    if (offset < 0) {
      increment("beforeExpected");
      return reject("before_expected_support");
    }
    if (end > geometry.captureEndSample) {
      increment("afterCapture");
      return reject("after_capture");
    }
    const sequence = offset + 1;
    const fingerprint = JSON.stringify(values);
    if (
      fingerprints.has(sequence) &&
      fingerprints.get(sequence) !== fingerprint
    )
      return metricFailure("duplicate_mutation", "duplicate_mutation");
    if (!fingerprints.has(sequence) && sequence <= node.lastAcceptedSequence)
      return metricFailure("out_of_order_spectrum", "sequence_regression");
    const record = {
      owner,
      sequence,
      startSample: start,
      endSample: end,
      centroidHz: energy === 0 ? null : centroid,
      energy,
    };
    const admitted = collector.ingestSpectrum(record);
    if (admitted.duplicate === true) {
      requireValue(
        fingerprints.get(sequence) === fingerprint,
        "collector_duplicate_without_handoff_admission",
      );
      increment("duplicateRecords");
      return freeze({ accepted: false, duplicate: true, reason: "duplicate" });
    }
    if (admitted.accepted !== true) {
      if (admitted.reason === "sealed") {
        close("cancelled", "collector_sealed");
        return reject("collector_sealed", "closed");
      }
      return metricFailure("collector_rejected_spectrum", "analyzer_failed");
    }
    fingerprints.set(sequence, fingerprint);
    increment("acceptedRecords");
    node.lastAcceptedSequence = sequence;
    const stride = Math.max(
      1,
      Math.ceil(Math.max(1, geometry.expectedCount) / MAX_PROGRESS),
    );
    if (
      progressCount < MAX_PROGRESS &&
      (node.acceptedRecords === 1 || node.acceptedRecords % stride === 0)
    ) {
      progressCount++;
      emit("progress");
    }
    return freeze({ accepted: true, sequence, measurement: true });
  }
  emit("queued");
  emit("started");
  return Object.freeze({
    admission,
    receive(packet) {
      if (sealed) return reject("sealed", "closed");
      if (collector.progress().sealed) {
        close("cancelled", "collector_sealed");
        return reject("collector_sealed", "closed");
      }
      increment("receivedPackets");
      if (
        !Array.isArray(packet) ||
        packet.length < 3 ||
        packet.length > 191 ||
        packet[0] !== "native" ||
        typeof packet[1] !== "string" ||
        typeof packet[2] !== "string"
      )
        return sharedFailure("invalid_native_packet_framing");
      if (packet[1] !== owner.generation)
        return sharedFailure("foreign_generation", "owner_corruption");
      const values = packet.slice(3);
      switch (packet[2]) {
        case "spectrum":
          return spectrum(values);
        case "retention-state":
          return retentionState(values);
        case "retention-snapshot":
          return snapshot(values);
        case "retention-rejection":
          return upstreamRejection(values);
        case "retention-ready":
          return exactBinding(packet, owner, "retention-ready", [
            2,
            1,
            owner.nativeEpoch,
          ])
            ? observed()
            : sharedFailure(
                "foreign_or_invalid_retention_binding",
                "owner_corruption",
              );
        case "abi-spectrum":
          return exactBinding(packet, owner, "abi-spectrum", [2])
            ? observed()
            : sharedFailure("invalid_spectrum_abi");
        case "ioError":
          return sharedFailure(
            values.length === 1 && values[0] === 1
              ? "upstream_io_error_without_classification"
              : "invalid_io_error_framing",
          );
        case "retention-unstable":
          if (
            values.length !== 2 ||
            values[0] !== 2 ||
            values[1] !== owner.nativeEpoch
          )
            return sharedFailure(
              "foreign_or_invalid_unstable_binding",
              "owner_corruption",
            );
          return observed();
        case "io-rejection": {
          const decoded = decodeIORejection(values);
          if (!decoded) return sharedFailure("invalid_io_rejection_framing");
          if (decoded.mode !== "spectrum") return observed();
          if (
            !decoded.generationMatches ||
            (decoded.nativeEpoch !== null &&
              decoded.nativeEpoch !== owner.nativeEpoch)
          )
            return sharedFailure("foreign_retention_epoch", "owner_corruption");
          return ["packet-numeric", "spectrum-diagnostics-numeric"].includes(
            decoded.check,
          )
            ? metricFailure("upstream_invalid_numeric")
            : sharedFailure("upstream_io_rejection");
        }
        default:
          return freeze({
            accepted: false,
            measurement: false,
            reason: "not_spectrum",
          });
      }
    },
    stats: () => (sealed ? sealed.counters : counters()),
    finish() {
      return (
        sealed ??
        close(
          node.acceptedRecords === geometry.expectedCount
            ? "completed"
            : node.acceptedRecords
              ? "partial"
              : "failed",
          node.acceptedRecords === geometry.expectedCount
            ? null
            : "missing_spectrum_records",
        )
      );
    },
    stall() {
      if (!sealed) metricFailure("spectrum_stalled", "stalled");
      return sealed;
    },
    cancel: () => sealed ?? close("cancelled", "cancelled"),
  });
}

module.exports = Object.freeze({
  createMetricSpectrumHandoff,
  SpectrumHandoffError,
});
