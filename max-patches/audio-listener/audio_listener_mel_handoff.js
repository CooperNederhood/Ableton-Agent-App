/* global module, require */
"use strict";
const {
  createAnalyzerTimelines,
} = require("./audio_listener_analyzer_handoff.js");

const MAX_COUNTER = 2 ** 44 - 1;
const DRAIN_FIELDS = [
  "producerAbi",
  "token",
  "epoch",
  "generation",
  "recordsDrained",
  "framesDrained",
  "terminalConsumed",
  "clockValid",
  "sourceClockExclusive",
];
const integer = (value, maximum = MAX_COUNTER) =>
  Number.isSafeInteger(value) && value >= 0 && value <= maximum;
const requireValue = (condition, reason) => {
  if (!condition) throw new Error(reason);
};

function createMelBandHandoff({
  epoch,
  sampleRate,
  totalSamples,
  codec,
  now,
  send,
  emit,
  requestedMetrics = ["mel-bands"],
  analyzerReadiness = null,
}) {
  requireValue(
    integer(epoch, 1000000) &&
      epoch > 0 &&
      [44100, 48000].includes(sampleRate) &&
      integer(totalSamples, sampleRate * 30) &&
      totalSamples > 0 &&
      codec?.melBandTimelineSchema &&
      codec?.melBandStereoFrameSchema &&
      codec?.MEL_BAND_PROFILE &&
      [now, send, emit].every((value) => typeof value === "function"),
    "mel_invalid_handoff_configuration",
  );
  const expectedRecords = Math.floor(totalSamples / 2048);
  const frames = [];
  const needsAnalyzers = requestedMetrics.some((metric) =>
    ["pitch", "spectral-shape"].includes(metric),
  );
  let producerAbi = null;
  const analyzers = createAnalyzerTimelines({
    requestedMetrics,
    sampleRate,
    codec,
    emit: (metric, stage, reason, count) =>
      event(stage, "capture", reason, startedAt, metric, count),
  });
  let armed = false;
  let generation = null;
  let readiness = null;
  let source = null;
  let binding = null;
  let terminal = null;
  let receipt = null;
  let recordCount = 0;
  let receivedFrames = 0;
  let issuedToken = 0;
  let acceptedToken = 0;
  let lastPoll = -Infinity;
  let startedAt = null;
  let cleanupStarted = null;
  let stopRequested = false;
  let cancelled = false;
  let localFailure = null;
  let integrityFailure = null;
  let sourceIdentityEvidence = null;
  let stoppedPacket = null;
  let drainPacket = null;
  let rejectedDrainRecorded = false;
  let pendingArmReported = false;
  let progressAt = -Infinity;

  // At most one identity, one stopped, one rejected and two drain events per pass
  // (first cleanup receipt and, if later, terminal-consumed receipt).
  // Never admits data, advances record counts, or confirms physical cleanup.
  function evidence(reason, phase, fields) {
    const metric = requestedMetrics.find((item) =>
      ["mel-bands", "pitch", "spectral-shape"].includes(item),
    );
    emit({
      stage: "progress",
      phase,
      reason,
      metric,
      frames: receivedFrames,
      facts: Object.entries(fields).map(([field, value]) => ({
        field,
        actual:
          value === null
            ? { state: "unavailable", reason: "nonfinite" }
            : {
                state: "observed",
                // Preserve finite out-of-range fault operands as exact
                // decimal strings instead of violating lifecycle number bounds.
                value:
                  typeof value === "number" &&
                  Math.abs(value) > Number.MAX_SAFE_INTEGER
                    ? String(value)
                    : value,
              },
      })),
    });
  }
  function receiveSourceIdentity(values) {
    requireValue(
      values.length === 9 && !sourceIdentityEvidence && !terminal,
      "mel_invalid_source_identity_evidence",
    );
    const parsed = codec.analyzerNativeSourceIdentitySchema.parse({
      schema: "analyzer-native-source-identity/v1",
      producerAbi: values[0],
      expectedEpoch: values[1],
      expectedGeneration: values[2],
      completedFrames: values[3],
      ...Object.fromEntries(
        [
          "sourceAbi",
          "sourceEpoch",
          "sourceRejected",
          "sourceSealedEpoch",
          "sourceClock",
        ].map((key, index) => [
          key,
          values[index + 4] === "null" ? null : values[index + 4],
        ]),
      ),
    });
    requireValue(
      parsed.expectedEpoch === epoch &&
        parsed.completedFrames === receivedFrames &&
        (generation === null || parsed.expectedGeneration === generation) &&
        (producerAbi === null || producerAbi === parsed.producerAbi) &&
        (!needsAnalyzers ||
          (analyzerReadiness?.producerAbi === 3 &&
            analyzerReadiness.dspGeneration === parsed.expectedGeneration)),
      "mel_foreign_source_identity_evidence",
    );
    sourceIdentityEvidence = parsed;
    evidence(
      "mel_native_source_identity",
      "capture",
      Object.fromEntries(
        Object.entries(parsed)
          .filter(([key]) => key !== "schema")
          .map(([key, value]) => [`mel.identity.${key}`, value]),
      ),
    );
  }
  let cleanupEmitted = false;

  function event(
    stage,
    phase,
    reason,
    started = startedAt,
    metric = "mel-bands",
    count = frames.length,
  ) {
    const values = {
      "mel.abi": producerAbi ?? 0,
      "mel.sampleRate": sampleRate,
      "mel.bandCount": 24,
      "mel.expectedFrames": expectedRecords,
      "mel.validFrames": frames.length,
      "mel.receivedFrames": receivedFrames,
      ...(generation === null ? {} : { "mel.dspGeneration": generation }),
      ...(source
        ? {
            "mel.startSample": source.startSample,
            "mel.endSample": source.endSample,
          }
        : {}),
      ...(terminal
        ? {
            "mel.terminalReason": terminal.reason,
            "mel.lostFrames": terminal.lost,
            "mel.trailingSamples": terminal.partial,
          }
        : {}),
      ...(receipt
        ? {
            "mel.terminalConsumed": 1,
            "mel.recordsDrained": receipt.recordsDrained,
            "mel.framesDrained": receipt.framesDrained,
            "mel.sourceClockExclusive": receipt.sourceClockExclusive,
          }
        : {}),
    };
    const targets =
      metric !== "mel-bands"
        ? [metric]
        : phase !== "capture" ||
            ["started", "progress", "completed", "cancelled"].includes(stage)
          ? requestedMetrics.filter((item) =>
              ["mel-bands", "pitch", "spectral-shape"].includes(item),
            )
          : requestedMetrics.includes("mel-bands")
            ? ["mel-bands"]
            : [];
    for (const target of targets) {
      if (
        phase === "capture" &&
        stage === "completed" &&
        (target === "mel-bands" ? localFailure : analyzers.failed(target))
      )
        continue;
      emit({
        stage,
        phase,
        reason,
        metric: target,
        frames:
          target === "mel-bands"
            ? count
            : (analyzers.counts()[target] ?? count),
        durationMs: Math.max(0, now() - started),
        facts: Object.entries(values).map(([field, value]) => ({
          field,
          actual: { state: "observed", value },
        })),
      });
    }
  }
  function validateBinding() {
    if (source && binding)
      requireValue(
        source.startSample === binding.startSample &&
          source.endSample === binding.endSample,
        "mel_capture_origin_mismatch",
      );
  }
  function failLocal(reason) {
    if (localFailure) return;
    localFailure = reason;
    event("failed", "capture", reason);
  }
  function receiveDrain(values) {
    // Record bounded owned receipts BEFORE semantic checks reject a missing
    // terminal/clock or wrong counts. Such evidence is never cleanup authority.
    if (
      values.length === 9 &&
      values.every((value) => integer(value)) &&
      values[0] === producerAbi &&
      values[1] > acceptedToken &&
      values[1] <= issuedToken &&
      values[2] === epoch &&
      generation !== null &&
      values[3] === generation &&
      values[6] <= 1 &&
      values[7] <= 1 &&
      (terminal || cleanupStarted !== null) &&
      (!drainPacket || (drainPacket[6] === 0 && values[6] === 1))
    ) {
      drainPacket = Object.freeze([...values]);
      evidence(
        "mel_native_drain_receipt",
        "drain",
        Object.fromEntries(
          DRAIN_FIELDS.map((key, index) => [`mel.drain.${key}`, values[index]]),
        ),
      );
    }
    requireValue(
      values.length === 9 &&
        values.every((value) => integer(value)) &&
        [2, 3].includes(values[0]) &&
        (producerAbi === null || values[0] === producerAbi) &&
        (!needsAnalyzers || values[0] === 3) &&
        values[1] > acceptedToken &&
        values[1] <= issuedToken &&
        values[4] === recordCount &&
        values[5] === receivedFrames &&
        values[6] <= 1 &&
        values[7] <= 1,
      "mel_invalid_drain_receipt",
    );
    if (
      generation === null &&
      recordCount === 0 &&
      (values[2] === 0 || values[2] === epoch) &&
      values[3] === 0 &&
      values[4] === 0 &&
      values[5] === 0 &&
      values[6] === 0 &&
      values[7] === 0 &&
      values[8] === 0
    ) {
      // Control-thread arm precedes the first audio-thread readiness record.
      // An empty owned receipt acknowledges only the poll, not DSP execution.
      acceptedToken = values[1];
      if (values[2] === epoch && !pendingArmReported) {
        pendingArmReported = true;
        event("progress", "configuration", "mel_native_arm_pending");
      }
      return;
    }
    requireValue(
      values[2] === epoch && values[3] > 0,
      "mel_invalid_drain_receipt",
    );
    if (generation === null) generation = values[3];
    requireValue(values[3] === generation, "mel_dsp_generation_changed");
    acceptedToken = values[1];
    if (values[6] === 0) {
      requireValue(!terminal, "mel_terminal_not_consumed");
      return;
    }
    requireValue(terminal, "mel_unobserved_terminal");
    requireValue(values[7] === 1, "mel_terminal_clock_unconfirmed");
    if (source)
      requireValue(
        values[8] >= source.startSample + receivedFrames * 2048,
        "mel_terminal_clock_before_retained_frames",
      );
    if (terminal.reason === 10)
      requireValue(
        source && values[8] >= source.endSample,
        "mel_terminal_clock_before_capture_end",
      );
    receipt = Object.freeze({
      token: values[1],
      generation,
      recordsDrained: values[4],
      framesDrained: values[5],
      sourceClockExclusive: values[8],
    });
  }
  function receivePacket(packet) {
    requireValue(
      armed &&
        Array.isArray(packet) &&
        typeof packet[0] === "string" &&
        packet.length <= 128,
      "mel_unowned_or_malformed_packet",
    );
    const [selector, ...values] = packet;
    if (selector === "mel_source_identity") {
      receiveSourceIdentity(values);
      return;
    }
    if (selector === "mel_drain") {
      try {
        receiveDrain(values);
      } catch (error) {
        if (!rejectedDrainRecorded) {
          rejectedDrainRecorded = true;
          evidence("mel_rejected_drain_receipt", "drain", {
            ...Object.fromEntries(
              DRAIN_FIELDS.map((key, index) => [
                `mel.drain.${key}`,
                typeof values[index] === "number" &&
                Number.isFinite(values[index])
                  ? values[index]
                  : null,
              ]),
            ),
            "mel.expected.producerAbi":
              producerAbi ?? (needsAnalyzers ? 3 : null),
            "mel.expected.epoch": epoch,
            "mel.expected.generation": generation,
            "mel.expected.recordsDrained": recordCount,
            "mel.expected.framesDrained": receivedFrames,
            "mel.expected.acceptedToken": acceptedToken,
            "mel.expected.issuedToken": issuedToken,
          });
        }
        throw error;
      }
      return;
    }
    requireValue(
      !terminal &&
        ["mel_ready", "mel_started", "mel_frame", "mel_stopped"].includes(
          selector,
        ) &&
        values.length >= 11 &&
        values.slice(0, 11).every((value) => integer(value)) &&
        [2, 3].includes(values[0]) &&
        (!needsAnalyzers || values[0] === 3) &&
        (producerAbi === null || producerAbi === values[0]) &&
        values[1] === epoch &&
        values[2] > 0 &&
        values[9] === sampleRate &&
        values[10] === 24,
      "mel_foreign_or_invalid_header",
    );
    const [, , nativeGeneration, sequence, start, end, lost, partial, reason] =
      values;
    producerAbi = values[0];
    if (needsAnalyzers)
      requireValue(
        analyzerReadiness?.producerAbi === 3 &&
          analyzerReadiness.dspGeneration === nativeGeneration &&
          analyzerReadiness.sampleRate === sampleRate,
        "analyzer_readiness_generation_mismatch",
      );
    if (generation === null) generation = nativeGeneration;
    requireValue(generation === nativeGeneration, "mel_dsp_generation_changed");
    if (sourceIdentityEvidence)
      requireValue(
        nativeGeneration === sourceIdentityEvidence.expectedGeneration &&
          selector === "mel_stopped" &&
          reason === 4,
        "mel_source_identity_terminal_mismatch",
      );
    recordCount++;
    if (selector === "mel_ready") {
      requireValue(
        values.length === 11 &&
          !readiness &&
          !source &&
          sequence === 0 &&
          start === end &&
          lost === 0 &&
          partial === 0 &&
          reason === 0,
        "mel_invalid_readiness",
      );
      readiness = Object.freeze({ sourceClock: start, generation });
      event("completed", "configuration", "mel_native_ready");
      return;
    }
    if (selector === "mel_started") {
      requireValue(
        values.length === 11 &&
          readiness &&
          !source &&
          sequence === 0 &&
          end - start === totalSamples &&
          lost === 0 &&
          partial === 0 &&
          reason === 0,
        "mel_invalid_capture_start",
      );
      source = Object.freeze({ startSample: start, endSample: end });
      validateBinding();
      event("started", "capture", "mel_native_capture");
      return;
    }
    if (selector === "mel_frame") {
      requireValue(
        source &&
          sequence === receivedFrames + 1 &&
          sequence <= expectedRecords &&
          start === source.startSample + receivedFrames * 2048 &&
          end === start + 2048 &&
          lost === 0 &&
          partial === 0 &&
          reason === 0,
        "mel_frame_support_or_sequence_mismatch",
      );
      receivedFrames++;
      const expectedLength = producerAbi === 3 ? 73 : 59;
      // The shared header is already validated. Malformed family values are a
      // local gap; later healthy frames and sibling families remain useful.
      if (producerAbi === 3)
        analyzers.receive(
          sequence - 1,
          { startSample: start, endSample: end },
          values.length === expectedLength ? values.slice(59) : [],
        );
      const parsed = codec.melBandStereoFrameSchema.safeParse([
        values.slice(11, 35),
        values.slice(35, 59),
      ]);
      if (!parsed.success || values.length !== expectedLength)
        failLocal("mel_malformed_vector");
      else if (producerAbi === 3 || !localFailure)
        frames.push({
          index: sequence - 1,
          support: { startSample: start, endSample: end },
          magnitudes: parsed.data,
        });
      if (now() - progressAt >= 500) {
        progressAt = now();
        event("progress", "capture", "mel_native_frames");
      }
      return;
    }
    if (values.length === 11 && !stoppedPacket) {
      stoppedPacket = Object.freeze([...values]);
      evidence(
        "mel_native_stopped_receipt",
        "drain",
        Object.fromEntries(
          [
            "producerAbi",
            "epoch",
            "generation",
            "sequence",
            "startSample",
            "endSample",
            "lostFrames",
            "trailingSamples",
            "reason",
            "sampleRate",
            "bandCount",
          ].map((key, index) => [`mel.stopped.${key}`, values[index]]),
        ),
      );
    }
    requireValue(
      values.length === 11 && sequence === receivedFrames,
      "mel_invalid_terminal_count",
    );
    if (source) {
      requireValue(
        lost === expectedRecords - receivedFrames &&
          partial === totalSamples % 2048 &&
          end === source.endSample &&
          start === source.startSample + receivedFrames * 2048,
        "mel_invalid_terminal_support",
      );
      if (reason === 10)
        requireValue(lost === 0, "mel_incomplete_normal_terminal");
    } else {
      requireValue(
        stopRequested && sequence === 0 && lost === 0 && partial === 0,
        "mel_terminal_without_capture",
      );
    }
    terminal = Object.freeze({ reason, start, end, lost, partial });
    if (![1, 6, 7, 10].includes(reason))
      throw new Error(`mel_native_integrity_failure_${reason}`);
    if (reason === 1)
      requireValue(stopRequested, "mel_unrequested_native_stop");
    if (reason === 6 || reason === 7) {
      requireValue(source && lost > 0, "mel_invalid_local_failure_support");
      failLocal(
        reason === 6 ? "mel_native_overflow" : "mel_native_malformed_result",
      );
    }
    if (!cancelled && reason === 10)
      event("completed", "capture", "mel_native_capture_complete");
  }
  return Object.freeze({
    arm() {
      requireValue(!armed, "mel_already_armed");
      armed = true;
      startedAt = now();
      event("queued", "configuration", "mel_native_prepare");
      send("arm", [epoch]);
      event("started", "configuration", "mel_native_prepare");
    },
    receive(packet) {
      try {
        receivePacket(packet);
      } catch (error) {
        integrityFailure ??=
          error instanceof Error ? error.message : "mel_native_receipt_failure";
        throw error;
      }
    },
    bind(support) {
      requireValue(
        binding === null &&
          support &&
          integer(support.startSample) &&
          integer(support.endSample) &&
          support.endSample - support.startSample === totalSamples,
        "mel_invalid_capture_binding",
      );
      binding = Object.freeze({ ...support });
      validateBinding();
    },
    tick() {
      if (!armed || receipt || now() - lastPoll < 10) return;
      lastPoll = now();
      requireValue(issuedToken < 12000, "mel_drain_attempt_limit");
      send("drain", [++issuedToken]);
      // Preserve the ABI2 mel-only prefix contract. ABI3 retains independently
      // supported later frames instead of stopping healthy sibling analyzers.
      if (producerAbi === 2 && localFailure && !terminal && !stopRequested) {
        stopRequested = true;
        send("stop", [epoch]);
      }
    },
    stop(isCancelled = false) {
      if (!armed) return true;
      if (cleanupStarted === null) {
        cleanupStarted = now();
        cancelled = isCancelled;
        if (!terminal && !stopRequested) {
          stopRequested = true;
          send("stop", [epoch]);
        }
        event("queued", "drain", "mel_native_cleanup", cleanupStarted);
        event("started", "drain", "mel_native_cleanup", cleanupStarted);
        if (cancelled) event("cancelled", "capture", "mel_native_cancelled");
      }
      if (receipt && !cleanupEmitted) {
        cleanupEmitted = true;
        event(
          "completed",
          "drain",
          "mel_native_cleanup_complete",
          cleanupStarted,
        );
      }
      return receipt !== null;
    },
    timeline() {
      requireValue(
        binding &&
          source &&
          terminal &&
          receipt &&
          !cancelled &&
          !integrityFailure,
        "mel_timeline_not_settled",
      );
      validateBinding();
      const missing = expectedRecords - frames.length;
      const retained = new Set(frames.map((frame) => frame.index));
      const gaps = [];
      for (let index = 0; index < expectedRecords; ++index) {
        if (retained.has(index)) continue;
        const reason =
          localFailure === "mel_native_overflow"
            ? "overflow"
            : ["mel_malformed_vector", "mel_native_malformed_result"].includes(
                  localFailure,
                )
              ? "malformed-record"
              : "unavailable";
        const previous = gaps.at(-1);
        if (previous && previous.firstIndex + previous.count === index) {
          previous.count++;
          previous.support.endSample += 2048;
        } else
          gaps.push({
            firstIndex: index,
            count: 1,
            reason,
            support: {
              startSample: source.startSample + index * 2048,
              endSample: source.startSample + (index + 1) * 2048,
            },
          });
      }
      return codec.melBandTimelineSchema.parse({
        schema: "mel-band-timeline/v1",
        profile: codec.MEL_BAND_PROFILE,
        sampleRate,
        sourceSupport: source,
        expectedRecords,
        status:
          missing === 0 ? "complete" : frames.length ? "partial" : "failed",
        frames,
        gaps,
      });
    },
    analyzerTimelines() {
      requireValue(
        binding &&
          source &&
          terminal &&
          receipt &&
          !cancelled &&
          !integrityFailure,
        "analyzer_timeline_not_settled",
      );
      validateBinding();
      return analyzers.timelines(
        source,
        expectedRecords,
        terminal.reason === 6 ? "overflow" : "unavailable",
      );
    },
    snapshot() {
      return Object.freeze({
        armed,
        ready: readiness !== null,
        started: source !== null,
        completed: terminal !== null && receipt !== null,
        frames: frames.length,
        receivedFrames,
        generation,
        failure: localFailure,
        integrityFailure,
        sourceIdentityEvidence,
        stoppedPacket,
        drainPacket,
        source,
        terminal,
        receipt,
        producerAbi,
        analyzerCounts: analyzers.counts(),
      });
    },
  });
}

module.exports = Object.freeze({ createMelBandHandoff });
