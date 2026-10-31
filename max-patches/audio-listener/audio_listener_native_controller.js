/* global module, require */
"use strict";

const { randomUUID } = require("node:crypto");
const { AudioListenerEngine } = require("./audio_listener_engine.js");
const {
  decodeRetentionRejection,
  RETENTION_REJECTION_LENGTH,
  decodeIORejection,
  IO_REJECTION_LENGTH,
  decodeRetentionSnapshot,
  RETENTION_SNAPSHOT_LENGTH,
} = require("./audio_listener_native_io.js");
const {
  NativeDescriptorAssembler,
} = require("./audio_listener_native_assembler.js");
const {
  nativeHostBinding,
  NATIVE_V2_SCOPE,
  nativeV2Configuration,
  nativeV2PhaseOffset,
  nativeV2PhaseDisagreement,
  nativeV2ClockRow,
  nativeV2HostBinding,
  nativeV2RetainTiming,
  nativeV2AlignmentMeasurements,
  nativeV2Alignment,
} = require("./audio_listener_native_coordinates.js");

const SCOPE = "arrangement-beat0-120bpm-48000hz-vector64/v1";
const LENGTHS = Object.freeze({
  dsp: 3,
  tempo: 1,
  fftInfo: 4,
  "abi-clock": 1,
  "abi-envelope": 1,
  "abi-spectrum": 1,
  clock: 11,
  spectrum: 6,
  envelope: 16,
  ioError: 1,
});
const LENGTHS_V2 = Object.freeze({
  ...LENGTHS,
  config: 7,
  "spectrum-diagnostics": 5,
  "io-rejection": IO_REJECTION_LENGTH,
});
const LENGTHS_RETAINED = Object.freeze({
  ...LENGTHS_V2,
  "envelope-state": 16,
  "retention-ready": 3,
  "retention-unstable": 2,
  "retention-state": 10,
  "retention-rejection": RETENTION_REJECTION_LENGTH,
  "retention-snapshot": RETENTION_SNAPSHOT_LENGTH,
});
const RESET_KEYS = [
  "launchClock",
  "sourceClock",
  "onsetCount",
  "rejected",
  "active",
  "launchPhaseSamples",
  "firstSourceClock",
  "completedSamples",
];
const RESET_INDICES = [1, 2, 3, 4, 5, 6, 7, 12];
const RESET_VALUES = [-1, -1, 0, 0, 0, -1, -1, 0];

function integer(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}
function identifier(value) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(value))
    throw new Error("invalid_native_identifier");
  return value;
}
function frozen(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(frozen));
  if (value && typeof value === "object")
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, frozen(item)]),
      ),
    );
  return value;
}
function reasonCode(cause) {
  return /^[a-z][a-z0-9_]{0,127}$/.test(cause?.message)
    ? cause.message
    : "native_controller_callback_failed";
}
function diagnosticInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? String(value) : "invalid";
}
function callback(call, reason) {
  try {
    const result = call();
    if (typeof result?.then === "function") throw new Error(reason);
    return result;
  } catch {
    throw new Error(reason);
  }
}
const CHECK_INPUT_TYPES = [...Object.keys(LENGTHS_RETAINED), "descriptor"];
function checkInput(packet) {
  if (!packet) return null;
  const values = packet.values;
  return frozen({
    type: CHECK_INPUT_TYPES.includes(packet.type) ? packet.type : "unknown",
    length: Array.isArray(values) ? values.length : null,
    cells: Array.isArray(values)
      ? Array.from(values.slice(0, 30), (v) =>
          typeof v !== "number"
            ? "not-number"
            : Number.isFinite(v)
              ? v
              : "non-finite",
        )
      : [],
    truncated: Array.isArray(values) && values.length > 30,
  });
}
function nativeCheck(reason) {
  if (reason === "stale_native_preflight") return "preflight-source-span";
  if (/preflight|readiness_timeout/.test(reason))
    return "preflight-prerequisites";
  if (/post_binding|post_buffer/.test(reason)) return "post-binding";
  if (/metadata|tempo/.test(reason)) return "metadata-match";
  if (/configuration|config/.test(reason)) return "configuration-receipt";
  if (/readiness|instability/.test(reason)) return "retention-readiness";
  if (/measurement_state/.test(reason)) return "retention-state";
  if (/measurement|retention/.test(reason)) return "retention-readback";
  if (/buffer_overflow/.test(reason)) return "join-capacity";
  if (/spectrum|spectral|fft/.test(reason)) return "spectrum-validity";
  if (/envelope|epoch|arm_ack|reset_hold/.test(reason))
    return "envelope-validity";
  if (/descriptor|sample_discontinuity|final_window|point_limit/.test(reason))
    return "descriptor-validity";
  if (/clock|host_|transport|timing/.test(reason)) return "clock-validity";
  if (/publication|payload|frame_quota|wire_/.test(reason))
    return "publication";
  if (/stop|disarm|release/.test(reason)) return "cleanup";
  if (/timeout/.test(reason)) return "deadline";
  if (
    /owner|busy|scope|prepared|cancelled|identifier|disconnected/.test(reason)
  )
    return "owner-admission";
  if (/control|send/.test(reason)) return "control-delivery";
  return "callback";
}
function checkPhase(state, reason) {
  if (/post_binding|post_buffer/.test(reason)) return "post-binding";
  if (/stop|disarm|release/.test(reason)) return "cleanup";
  if (/publication|payload|frame_quota|wire_/.test(reason))
    return "publication";
  return (
    {
      idle: "preparation",
      prepared: "preparation",
      preflight: "preflight",
      "native-arming": "arm",
      armed: "launch",
      capturing: "capture",
    }[state] ?? "preparation"
  );
}
function checkAge(now, at) {
  return Number.isFinite(at) ? Math.min(120000, Math.max(0, now - at)) : null;
}
function commandScope(command, nativeVersion = 1) {
  const result = {};
  for (const key of [
    "passId",
    "connectionEpoch",
    "traceId",
    "correlationId",
    "causationId",
  ])
    result[key] = identifier(command?.[key]);
  if (nativeVersion === 2) {
    const config = nativeV2Configuration(
      command.geometry,
      command.timingPolicy,
    );
    const g = config.geometry;
    return frozen({
      ...result,
      geometry: g,
      timingPolicy: config.policy,
      mode: "arrangement",
      startBeat: g.startBeat,
      endBeat: g.endBeat,
      durationMs: Math.ceil((g.totalSamples * 1000) / g.sampleRate),
      maxWindows: Math.ceil(g.totalSamples / g.hopSamples),
      settings: { attackThresholdDb: 6, minAttackSpacingSamples: g.hopSamples },
    });
  }
  const end = command.endBeat;
  const windows = end * 5;
  const durationMs = command.durationMs ?? end * 500;
  const maxWindows = command.maxWindows ?? windows;
  const settings = command.settings ?? {};
  const threshold = settings.attackThresholdDb ?? 6;
  const spacing = settings.minAttackSpacingSamples ?? 4800;
  if (
    command.mode !== "arrangement" ||
    command.startBeat !== 0 ||
    !integer(windows, 1, 100) ||
    !integer(durationMs, Math.ceil(end * 500), 10000) ||
    !integer(maxWindows, windows, 100) ||
    (command.launchToleranceBeats ?? 0) !== 0 ||
    !settings ||
    typeof settings !== "object" ||
    Array.isArray(settings) ||
    Object.keys(settings).some(
      (key) => !["attackThresholdDb", "minAttackSpacingSamples"].includes(key),
    ) ||
    !Number.isFinite(threshold) ||
    threshold < 0 ||
    threshold > 120 ||
    !integer(spacing, 4800, 480000)
  )
    throw new Error("unsupported_native_capture_scope");
  return frozen({
    ...result,
    mode: "arrangement",
    startBeat: 0,
    endBeat: end,
    durationMs,
    maxWindows,
    settings: {
      attackThresholdDb: threshold,
      minAttackSpacingSamples: spacing,
    },
  });
}

/** Request-gated Node composition only; no readiness authority or transport IO. */
class NativeCaptureController {
  constructor({
    listenerId,
    now = Date.now,
    send,
    onArmed,
    emit = () => {},
    observe = () => {},
    nativeVersion = 1,
    onDisarmed = () => {},
    initialNativeEpoch = 0,
    retainedMeasurements = false,
  }) {
    if (![1, 2].includes(nativeVersion))
      throw new Error("invalid_native_version");
    this.nativeVersion = nativeVersion;
    if (
      typeof retainedMeasurements !== "boolean" ||
      (retainedMeasurements && nativeVersion !== 2)
    )
      throw new Error("invalid_retained_measurement_selection");
    this.retainedMeasurements = retainedMeasurements;
    this.listenerId = identifier(listenerId);
    for (const callback of [now, send, onArmed, emit, observe, onDisarmed])
      if (typeof callback !== "function")
        throw new Error("invalid_native_controller_callback");
    this.now = () => {
      const value = callback(now, "native_time_callback_failed");
      if (!Number.isFinite(value) || value < 0)
        throw new Error("invalid_native_time");
      this.lastDiagnosticNow = value;
      return value;
    };
    this.send = send;
    this.onArmed = onArmed;
    this.emit = emit;
    this.observe = observe;
    this.onDisarmed = onDisarmed;
    this.pendingDisarm = null;
    this.pass = null;
    this.state = "idle";
    if (!integer(initialNativeEpoch, 0, 1000000))
      throw new Error("invalid_native_initial_epoch");
    this.allocatedEpoch = initialNativeEpoch;
    this.engine = new AudioListenerEngine({
      listenerId,
      now: this.now,
      launchAlignment: "signal",
      nativeVersion,
      onNativeRejection: (reason, details) => {
        if (!this.pass) return;
        this.pass.engineRejection = details;
        this.retainCheckFailure(this.pass, reason, "engine");
      },
      // Global clock/FFT must not reset when the engine requests analysis.
      analysis: () => {},
      emit: (event) => {
        const p = this.pass;
        if (!p) return;
        if (event.type === "native-capture-stage") {
          const phase =
            event.reason === "native_host_postcheck_complete"
              ? "post-binding"
              : checkPhase(this.state, event.reason ?? "");
          this.checkLifecycle(p, phase, event.stage);
          if (event.reason === "native_arm_acknowledged") {
            this.checkLifecycle(p, "arm", "completed");
            this.checkLifecycle(p, "launch", "queued");
            this.checkLifecycle(p, "launch", "started");
          }
          if (event.reason === "native_launch_observed") {
            this.checkLifecycle(p, "launch", "completed");
            this.checkLifecycle(p, "capture", "queued");
            this.checkLifecycle(p, "capture", "started");
          }
        }
        if (
          nativeVersion === 2 &&
          event.type === "terminal" &&
          ["failed", "partial", "cancelled"].includes(event.status)
        ) {
          this.retainCheckFailure(p, event.reason, "engine");
          event = {
            ...event,
            nativeFailureDiagnostic: p.nativeFailureDiagnostic,
          };
        }
        if (nativeVersion === 2 && event.type === "native-capture-stage")
          p.captureCause = event.eventId;
        if (p.events.length >= (nativeVersion === 2 ? 64 : 32))
          throw new Error("native_controller_event_overflow");
        p.events.push(event);
      },
    });
  }

  checkOwner(owner) {
    const p = this.pass;
    if (
      !p ||
      !owner ||
      owner.passId !== p.command.passId ||
      owner.connectionEpoch !== p.command.connectionEpoch
    )
      throw this.admissionError(
        new Error("native_controller_owner_mismatch"),
        owner,
      );
    return p;
  }

  prepare(command) {
    try {
      return this.prepareOwned(command);
    } catch (error) {
      throw this.admissionError(error, command);
    }
  }

  admissionError(error, command) {
    if (this.nativeVersion !== 2) return error;
    const geometry = command?.geometry ?? {};
    const cause = command?.causationId;
    const p = {
      command: { geometry: {} },
      preparedAt: this.lastDiagnosticNow,
      startedAt: null,
      cause:
        typeof cause === "string" && /^[a-zA-Z0-9_.:-]{1,128}$/.test(cause)
          ? cause
          : "native_context_unavailable",
      frames: [],
      post: [],
      metadata: {},
      envelopes: [],
      retentionReady: {},
      clockCounts: {
        received: 0,
        accepted: 0,
        rejected: 0,
        held: 0,
        foreign: 0,
      },
      suppressedInputs: 0,
      invalidInputs: 0,
      truncatedInputs: 0,
      checkLifecycle: [],
      checkInput: checkInput({
        type: "config",
        values: [
          geometry.sampleRate,
          geometry.vectorSize,
          geometry.tempoBpm,
          geometry.startBeat,
          geometry.endBeat,
          geometry.hopSamples,
          geometry.totalSamples,
        ],
      }),
    };
    this.retainCheckFailure(p, reasonCode(error), "controller", "preparation");
    error.nativeFailureDiagnostic = p.nativeFailureDiagnostic;
    return error;
  }

  prepareOwned(command) {
    if (this.pendingDisarm) throw new Error("native_disarm_pending");
    if (this.pass) throw new Error("listener_busy");
    const bounded = commandScope(command, this.nativeVersion);
    this.pass = {
      command: bounded,
      generation: randomUUID(),
      preparedAt: this.now(),
      startedAt: null,
      cause: bounded.causationId,
      frames: [],
      post: [],
      metadata: {},
      envelopes: [],
      lastEnvelope: null,
      prelaunchEnvelopes: [],
      prelaunchSpectra: [],
      events: [],
      rejected: 0,
      held: 0,
      armHeld: 0,
      published: false,
      closed: false,
      assembler: null,
      resolve: null,
      reject: null,
      retentionReady: {},
      retentionStats: {},
      retentionCauses: {},
      clockCounts: {
        received: 0,
        accepted: 0,
        rejected: 0,
        held: 0,
        foreign: 0,
      },
      suppressedInputs: 0,
      invalidInputs: 0,
      truncatedInputs: 0,
      checkLifecycle: [
        { phase: "preparation", stage: "queued", elapsedMs: 0 },
        { phase: "preparation", stage: "started", elapsedMs: 0 },
        { phase: "preparation", stage: "completed", elapsedMs: 0 },
      ],
      ...(this.nativeVersion === 2
        ? {
            timingWitnesses: {},
            envelopeWindows: [],
            tempoEvidence: null,
            spectrumDiagnostics: null,
            nativeFailureDiagnostic: null,
            nativeFailureReason: null,
          }
        : {}),
    };
    this.state = "prepared";
    return {
      status: "ready",
      scope: this.nativeVersion === 2 ? NATIVE_V2_SCOPE : SCOPE,
    };
  }

  local(p, stage, reason) {
    this.checkLifecycle(p, checkPhase(this.state, reason ?? ""), stage);
    const eventId = randomUUID();
    const event = frozen({
      type: "native-preflight-stage",
      ...(this.nativeVersion === 2 ? { scope: NATIVE_V2_SCOPE } : {}),
      stage,
      eventId,
      traceId: p.command.traceId,
      correlationId: p.command.correlationId,
      causationId: p.cause,
      passId: p.command.passId,
      connectionEpoch: p.command.connectionEpoch,
      generation: p.generation,
      nativeEpoch: p.nativeEpoch ?? 0,
      elapsedMs: Math.min(
        120000,
        Math.max(0, this.now() - (p.startedAt ?? p.preparedAt)),
      ),
      frames: p.frames.length,
      rejected: p.rejected,
      held: p.held,
      armHeld: p.armHeld,
      ...(reason ? { reason } : {}),
    });
    p.cause = eventId;
    callback(() => this.observe(event), "native_observer_failed");
  }

  arm(owner) {
    const p = this.checkOwner(owner);
    if (this.state !== "prepared")
      throw new Error("native_controller_duplicate_arm");
    this.state = "preflight";
    p.startedAt = this.now();
    const promise = new Promise((resolve, reject) => {
      p.resolve = resolve;
      p.reject = reject;
    });
    try {
      if (this.retainedMeasurements) {
        if (this.allocatedEpoch >= 1000000)
          throw new Error("native_epoch_exhausted");
        p.nativeEpoch = ++this.allocatedEpoch;
        p.owner = frozen({
          passId: p.command.passId,
          connectionEpoch: p.command.connectionEpoch,
          nativeEpoch: p.nativeEpoch,
        });
      }
      this.local(p, "queued");
      if (this.pass !== p) return promise;
      this.local(p, "started");
      if (this.pass !== p) return promise;
      if (this.nativeVersion === 2) p.beginAttempted = true;
      this.control(p, {
        action: "begin",
        ...(this.retainedMeasurements
          ? {
              nativeEpoch: p.nativeEpoch,
              sampleRate: p.command.geometry.sampleRate,
            }
          : {}),
      });
    } catch (cause) {
      this.fail(p, reasonCode(cause));
    }
    return promise;
  }

  control(p, value) {
    if (this.pass !== p || p.closed) return;
    const result = callback(
      () => this.send(frozen({ ...value, generation: p.generation })),
      "native_control_send_failed",
    );
    if (result === false) throw new Error("native_control_send_failed");
  }

  ingest(packet) {
    if (
      this.nativeVersion === 2 &&
      this.pendingDisarm &&
      packet?.generation === this.pendingDisarm.generation &&
      packet.type === "io-rejection"
    ) {
      const evidence = decodeIORejection(packet.values);
      if (evidence) this.pendingDisarm.io ??= frozen(evidence);
      return !!evidence;
    }
    if (
      this.nativeVersion === 2 &&
      this.pendingDisarm &&
      packet?.generation === this.pendingDisarm.generation &&
      packet.type === "stopped" &&
      Array.isArray(packet.values) &&
      packet.values.length === 3 &&
      packet.values[0] === 0 &&
      packet.values[1] === 0 &&
      packet.values[2] === 2
    ) {
      this.disarmed(true);
      return true;
    }
    const p = this.pass;
    if (!p || p.closed) return false;
    if (packet?.generation !== p.generation || this.state === "prepared") {
      p.suppressedInputs = Math.min(
        Number.MAX_SAFE_INTEGER,
        p.suppressedInputs + 1,
      );
      if (packet?.type === "clock") p.clockCounts.foreign++;
      return false;
    }
    if (packet.type === "retention-snapshot") {
      const snapshot =
        this.retainedMeasurements &&
        Object.keys(packet).every((k) =>
          ["generation", "type", "values"].includes(k),
        ) &&
        decodeRetentionSnapshot(packet.values);
      if (!snapshot || snapshot.nativeEpoch !== p.nativeEpoch) {
        p.invalidSnapshot = true;
        p.invalidInputs++;
        p.suppressedInputs++;
        this.telemetryGap(p, "native_diagnostic_snapshot_invalid");
        return false;
      }
      let receivedAt = null;
      try {
        receivedAt = this.now();
      } catch {
        p.invalidSnapshot = true;
      }
      (p.retentionSnapshots ??= {})[snapshot.family] = frozen({
        ...snapshot,
        at: receivedAt,
      });
      return true;
    }
    if (packet.type === "io-rejection") {
      const evidence =
        Object.keys(packet).every((k) =>
          ["generation", "type", "values"].includes(k),
        ) && decodeIORejection(packet.values);
      if (!evidence) {
        p.invalidIORejection = true;
        p.invalidInputs++;
        this.telemetryGap(p, "native_diagnostic_io_rejection_invalid");
        return false;
      }
      p.ioRejection ??= frozen(evidence);
      return true;
    }
    p.checkInput = checkInput(packet);
    p.inputRejected = false;
    if (p.checkInput?.truncated) p.truncatedInputs++;
    if (packet?.type === "clock") p.clockCounts.received++;
    const previousClock = p.clock;
    try {
      this.deadline(p);
      if (this.pass !== p) return false;
      const type = packet.type;
      const values = packet.values;
      const lengths = this.retainedMeasurements
        ? LENGTHS_RETAINED
        : this.nativeVersion === 2
          ? LENGTHS_V2
          : LENGTHS;
      if (
        Object.keys(packet).some(
          (key) => !["generation", "type", "values"].includes(key),
        ) ||
        typeof type !== "string" ||
        !Object.prototype.hasOwnProperty.call(lengths, type) ||
        !Array.isArray(values) ||
        values.length !== lengths[type] ||
        Array.from(values).some((number) => !Number.isFinite(number))
      )
        throw new Error("invalid_native_io_packet");
      const v = [...values];
      if (type === "ioError") throw new Error("native_io_packet_failed");
      if (type === "clock") this.clock(p, v);
      else if (type === "spectrum") this.spectrum(p, v);
      else if (type === "io-rejection") {
        const evidence = decodeIORejection(v);
        if (!evidence) throw new Error("invalid_native_io_rejection");
        p.ioRejection ??= frozen(evidence);
        return true;
      } else if (type === "spectrum-diagnostics") {
        p.spectrumDiagnostics = frozen(v);
        return true;
      } else if (type === "envelope") this.envelope(p, v);
      else if (type === "envelope-state") this.envelope(p, v, true);
      else if (type === "retention-ready") {
        if (![1, 2].includes(v[0]) || v[1] !== 1 || v[2] !== p.nativeEpoch)
          throw new Error("native_measurement_readiness_mismatch");
        p.retentionReady[v[0]] = true;
      } else if (type === "retention-unstable") {
        if (![1, 2].includes(v[0]) || v[1] !== p.nativeEpoch)
          throw new Error("native_measurement_instability_mismatch");
        this.measurementEvent(
          p,
          v[0],
          "progress",
          `native_${v[0] === 1 ? "envelope" : "spectrum"}_acquisition_unstable`,
        );
        return true;
      } else if (type === "retention-state") this.measurement(p, v);
      else if (type === "retention-rejection") {
        const evidence = decodeRetentionRejection(v);
        if (!evidence || evidence.nativeEpoch !== p.nativeEpoch)
          throw new Error("invalid_native_retention_rejection");
        p.retentionRejections ??= {};
        p.retentionRejections[evidence.family] ??= frozen(evidence);
        return true;
      } else this.metadata(p, type, v);
      if (this.pass !== p) return false;
      if (this.state === "preflight") this.tryPreflight(p);
      if (this.pass !== p) return false;
      if (p.assembler?.state === "covered" && p.coveredAt === undefined) {
        p.coveredAt = this.now();
        this.checkLifecycle(p, "capture", "completed");
        this.checkLifecycle(p, "post-binding", "queued");
        this.checkLifecycle(p, "post-binding", "started");
      }
      if (this.retainedMeasurements) this.finishRetainedPost(p);
      this.drain(p);
      if (type === "clock" && p.clock === previousClock && !p.inputRejected)
        p.clockCounts.held++;
      if (!p.inputRejected) {
        p.acceptedCheckInput = p.checkInput;
        (p.acceptedCheckInputs ??= {})[type] = p.checkInput;
      }
      return this.pass === p;
    } catch (cause) {
      if (
        packet?.type === "clock" &&
        p.clock === previousClock &&
        !p.inputRejected
      )
        p.clockCounts.rejected++;
      if (reasonCode(cause) === "invalid_native_io_packet") p.invalidInputs++;
      const owner = /NativeDescriptorAssembler/.test(cause?.stack ?? "")
        ? "assembler"
        : /AudioListenerEngine/.test(cause?.stack ?? "")
          ? "engine"
          : packet.type === "ioError" ||
              /^native_measurement_(delivery_failed|queue_overflow|control_invalid)$/.test(
                reasonCode(cause),
              )
            ? "io"
            : "controller";
      this.retainCheckFailure(p, reasonCode(cause), owner);
      this.fail(p, reasonCode(cause));
      return false;
    }
  }

  checkLifecycle(p, phase, stage) {
    if (this.nativeVersion !== 2 || !p.checkLifecycle) return;
    const last = p.checkLifecycle.at(-1);
    if (last?.phase === phase && last.stage === stage) return;
    if (p.checkLifecycle.length >= 32) {
      p.suppressedInputs++;
      return;
    }
    p.checkLifecycle.push({
      phase,
      stage,
      elapsedMs: checkAge(this.lastDiagnosticNow, p.startedAt ?? p.preparedAt),
    });
  }

  telemetryGap(p, reason) {
    const gaps = (p.telemetryGaps ??= new Set());
    if (gaps.has(reason)) return;
    gaps.add(reason);
    try {
      this.local(p, "progress", reason);
    } catch {
      p.suppressedInputs++;
    }
  }

  retainCheckFailure(p, reason, owner = "controller", phaseOverride = null) {
    if (this.nativeVersion !== 2) return;
    if (p.checkEvidence) {
      if (p.nativeFailureDiagnostic && !p.nativeFailureDiagnostic.checkEvidence)
        p.nativeFailureDiagnostic = frozen({
          ...p.nativeFailureDiagnostic,
          checkEvidence: p.checkEvidence,
        });
      return;
    }
    const now = this.lastDiagnosticNow;
    const phase = phaseOverride ?? checkPhase(this.state, reason);
    this.checkLifecycle(
      p,
      phase,
      reason === "cancelled" ? "cancelled" : "failed",
    );
    const operands = [];
    const add = (
      field,
      actual,
      expected,
      relation,
      unit,
      domain = "native-source",
    ) =>
      operands.push({
        field,
        actual: actual ?? null,
        expected: expected ?? null,
        relation,
        unit,
        domain,
      });
    const rate = p.command.geometry.sampleRate;
    add("sample-rate", rate, rate, "equal", "hertz", "control");
    add(
      "source-span",
      p.frames.length ? p.frames.at(-1)[4] - p.frames[0][4] : null,
      rate,
      "at-most",
      "samples",
    );
    add("clock-count", p.frames.length, 32, "equal", "count");
    for (const name of ["clock", "spectrum", "envelope"])
      add(
        `${name}-age`,
        checkAge(now, p[`${name}At`]),
        1000,
        "at-most",
        "milliseconds",
        "receipt-time",
      );
    const preflightClock =
      phase === "preflight" && p.before ? p.before.frames.at(-1) : p.clock;
    add(
      "fft-clock-distance",
      preflightClock && p.spectrum ? preflightClock[4] - p.spectrum[0] : null,
      2048,
      "less-than",
      "samples",
    );
    if (phase === "preflight" && p.before) {
      add(
        "preflight-cohort-clock",
        preflightClock[4],
        p.clock?.[4],
        "at-most",
        "samples",
      );
      add(
        "preflight-cohort-age",
        p.clock ? p.clock[4] - preflightClock[4] : null,
        rate,
        "at-most",
        "samples",
      );
    }
    for (const [family, name] of [
      [1, "envelope"],
      [2, "spectrum"],
    ])
      add(
        `retention-${name}-ready`,
        p.retentionReady[family] === true,
        true,
        "equal",
        "boolean",
        "control",
      );
    add(
      "envelope-pending",
      reason.startsWith("native_prelaunch_envelope_")
        ? p.prelaunchEnvelopes.length
        : p.envelopes.length,
      reason.startsWith("native_prelaunch_envelope_")
        ? this.retainedMeasurements
          ? 16
          : 8
        : 8,
      /^(native_envelope|native_prelaunch_envelope)_buffer_overflow$/.test(
        reason,
      ) && owner === "controller"
        ? "less-than"
        : "at-most",
      "count",
    );
    add(
      "assembler-pending",
      p.assemblerCheck?.pendingCount ?? p.assembler?.pending.length,
      8,
      reason === "native_envelope_buffer_overflow" && owner === "assembler"
        ? "less-than"
        : "at-most",
      "count",
    );
    add(
      "spectrum-pending",
      reason === "native_prelaunch_spectrum_buffer_overflow"
        ? p.prelaunchSpectra.length
        : (p.assemblerCheck?.spectrumCount ?? p.assembler?.spectra.length),
      reason === "native_prelaunch_spectrum_buffer_overflow" ? 32 : 128,
      reason === "native_prelaunch_spectrum_buffer_overflow" ||
        (reason === "native_spectrum_buffer_overflow" && owner === "assembler")
        ? "less-than"
        : "at-most",
      "count",
    );
    if (phase === "post-binding") {
      add("post-clock-count", p.post.length, 32, "equal", "count");
      add(
        "post-source-span",
        p.post.length ? p.post.at(-1)[4] - p.post[0][4] : null,
        rate,
        "at-most",
        "samples",
      );
    }
    const elapsedMs = checkAge(now, p.startedAt ?? p.preparedAt);
    const deadlineMs =
      {
        preparation: 15000,
        preflight: 2000,
        arm: 1000,
        launch: 10000,
        "post-binding": 2000,
        cleanup: 1000,
      }[phase] ?? null;
    const deadlineStart = {
      preparation: p.preparedAt,
      preflight: p.startedAt,
      arm: p.armAt,
      launch: p.armAt,
      "post-binding": p.coveredAt,
      cleanup: this.pendingDisarm?.at,
    }[phase];
    add(
      "elapsed",
      checkAge(now, deadlineStart),
      deadlineMs,
      "less-than",
      "milliseconds",
      "receipt-time",
    );
    if (p.engineRejection) {
      for (const operand of p.engineRejection.operands) operands.push(operand);
    }
    const failedOperands = [];
    const failed = (
      field,
      actual,
      expected,
      relation,
      unit,
      domain = "control",
    ) =>
      failedOperands.push({ field, actual, expected, relation, unit, domain });
    const input = p.checkInput;
    const cells = input?.cells ?? [];
    if (reason === "invalid_native_io_packet") {
      const expected = (
        this.retainedMeasurements ? LENGTHS_RETAINED : LENGTHS_V2
      )[input?.type];
      if (expected !== undefined && input.length !== expected)
        failed("packet-length", input.length, expected, "equal", "count");
      if (cells.some((v) => typeof v !== "number"))
        failed("packet-finite", false, true, "equal", "boolean");
    }
    if (input?.type === "clock" && reason === "invalid_native_clock") {
      const units = [
        "boolean",
        "beats",
        "samples",
        "flags",
        "samples",
        "fraction",
        "samples",
        "boolean",
        "beats",
        "samples",
        "flags",
      ];
      const domains = [
        "host-position",
        "host-position",
        "host-position",
        "host-position",
        "native-source",
        "native-source",
        "native-source",
        "host-position",
        "host-position",
        "host-position",
        "host-position",
      ];
      for (let index = 0; index < 11; index++)
        if (cells[index] < 0)
          failed(
            "clock-minimum",
            cells[index],
            0,
            "at-least",
            units[index],
            domains[index],
          );
      for (const index of [0, 7])
        if (![0, 1].includes(cells[index]))
          failed(
            "playing-valid",
            false,
            true,
            "equal",
            "boolean",
            "host-position",
          );
      for (const index of [1, 8])
        if (cells[index] > 1e9)
          failed(
            "host-beat",
            cells[index],
            1e9,
            "at-most",
            "beats",
            "host-position",
          );
      for (const index of [2, 9])
        if (!Number.isSafeInteger(cells[index]))
          failed(
            "host-sample-integral",
            false,
            true,
            "equal",
            "boolean",
            "host-position",
          );
      for (const index of [3, 10]) {
        if (!Number.isSafeInteger(cells[index]))
          failed(
            "flags-integral",
            false,
            true,
            "equal",
            "boolean",
            "host-position",
          );
        if (cells[index] > 0x7fffffff)
          failed(
            "host-flags",
            cells[index],
            0x7fffffff,
            "at-most",
            "flags",
            "host-position",
          );
        if ((cells[index] & 19) !== 19)
          failed(
            "host-flags",
            cells[index],
            19,
            "contains-all-bits",
            "flags",
            "host-position",
          );
      }
      for (const index of [4, 6]) {
        if (!Number.isSafeInteger(cells[index]))
          failed(
            "counter-integral",
            false,
            true,
            "equal",
            "boolean",
            "native-source",
          );
        if (cells[index] > 2 ** 44 - 1)
          failed(
            "native-counter",
            cells[index],
            2 ** 44 - 1,
            "at-most",
            "samples",
            "native-source",
          );
      }
      if (cells[5] > 1)
        failed(
          "native-phase",
          cells[5],
          1,
          "at-most",
          "fraction",
          "native-source",
        );
    }
    if (
      input?.type === "config" &&
      reason === "native_configuration_receipt_mismatch"
    ) {
      const g = p.command.geometry;
      const expected = [
        p.nativeEpoch,
        g.totalSamples,
        g.hopSamples,
        g.tempoBpm,
        g.startBeat % 1,
        g.vectorSize,
        p.nativeEpoch,
      ];
      for (let index = 0; index < 7; index++)
        if (cells[index] !== expected[index])
          failed(
            "configuration-field",
            cells[index],
            expected[index],
            "equal",
            [
              "epoch",
              "samples",
              "samples",
              "bpm",
              "fraction",
              "count",
              "epoch",
            ][index],
          );
    }
    if (
      /native_metadata_changed|native_host_tempo_(changed|mismatch)/.test(
        reason,
      )
    ) {
      const g = p.command.geometry;
      const expected =
        input?.type === "dsp"
          ? [1, g.sampleRate, g.vectorSize]
          : input?.type === "tempo"
            ? [g.tempoBpm]
            : input?.type === "fftInfo"
              ? [2048, 2048, 2048, 1]
              : [2];
      for (let index = 0; index < expected.length; index++)
        if (
          typeof cells[index] === "number" &&
          cells[index] !== expected[index]
        )
          failed(
            "metadata-field",
            cells[index],
            expected[index],
            "equal",
            input.type === "tempo"
              ? "bpm"
              : input.type === "dsp" && index === 1
                ? "hertz"
                : "count",
          );
    }
    const metadata = [
      "dsp",
      "tempo",
      "fftInfo",
      "abi-clock",
      "abi-envelope",
      "abi-spectrum",
    ].map((kind) => ({
      kind,
      ageMs: checkAge(now, p.metadata[kind]?.at),
      values: p.metadata[kind]?.values ?? null,
    }));
    const missing = [];
    for (const name of ["clock", "spectrum", "envelope"])
      if (!Number.isFinite(p[`${name}At`])) missing.push(name);
    if (metadata.some((m) => m.values === null)) missing.push("metadata");
    if (!p.retentionReady[1]) missing.push("retention-envelope");
    if (!p.retentionReady[2]) missing.push("retention-spectrum");
    if (this.retainedMeasurements && !p.retentionSnapshots?.[1])
      missing.push("reader-envelope");
    if (this.retainedMeasurements && !p.retentionSnapshots?.[2])
      missing.push("reader-spectrum");
    if (elapsedMs === null) missing.push("receipt-time");
    if (!p.acceptedCheckInput) missing.push("accepted-input");
    if (!p.checkInput) missing.push("rejected-input");
    if (
      owner === "io" &&
      !p.ioRejection &&
      !p.nativeFailureDiagnostic?.readerReason
    )
      missing.push("source-io-cause");
    if (nativeCheck(reason) === "callback") missing.push("predicate-operands");
    p.checkEvidence = frozen({
      eventId: randomUUID(),
      causationId: p.cause,
      owner,
      phase,
      check: nativeCheck(reason),
      reason,
      elapsedMs,
      deadlineMs,
      predicate:
        owner === "sdk" && p.sdkRejection?.check === "invalid_listener_payload"
          ? "owned-native-contract"
          : ({
              "preflight-source-span": "source-span-within-one-second",
              "preflight-prerequisites": "required-inputs-present-and-fresh",
              "metadata-match": "configured-values-match",
              "configuration-receipt": "configured-values-match",
              "join-capacity": "capacity-not-exceeded",
              "descriptor-validity": "descriptor-coordinates-match",
              "post-binding": "post-binding-valid",
              deadline: "deadline-not-expired",
              publication: "delivery-confirmed",
              cleanup: "delivery-confirmed",
              "control-delivery": "delivery-confirmed",
              callback: "delivery-confirmed",
            }[nativeCheck(reason)] ?? "owned-native-contract"),
      launch: p.launched ? "observed" : p.published ? "armed" : "not-attempted",
      operands: failedOperands.length
        ? [
            ...failedOperands,
            ...operands.filter((o) =>
              ["sample-rate", "elapsed", "clock-age"].includes(o.field),
            ),
          ].slice(0, 32)
        : operands,
      ...(p.command.timingPolicy
        ? { geometry: p.command.geometry, policy: p.command.timingPolicy }
        : {}),
      ...(p.preflightSpan ? { preflight: p.preflightSpan } : {}),
      metadata,
      ...(p.lastPreflightWait
        ? {
            preflightWaits: {
              first: p.firstPreflightWait,
              last: p.lastPreflightWait,
              transitions: p.preflightWaits,
              dropped: p.droppedPreflightWaits ?? 0,
            },
          }
        : {}),
      ...(p.acquisitionRejections
        ? {
            acquisition: {
              clock: p.acquisitionRejections.clock
                ? {
                    reason: p.acquisitionRejections.clock.reason,
                    input: p.acquisitionRejections.clock.input,
                    ageMs: checkAge(now, p.acquisitionRejections.clock.at),
                  }
                : null,
              spectrum: p.acquisitionRejections.spectrum
                ? {
                    reason: p.acquisitionRejections.spectrum.reason,
                    input: p.acquisitionRejections.spectrum.input,
                    ageMs: checkAge(now, p.acquisitionRejections.spectrum.at),
                  }
                : null,
            },
          }
        : {}),
      readers: {
        envelope: {
          state: p.retentionStats?.[1] ?? null,
          snapshot: p.retentionSnapshots?.[1]
            ? {
                status: p.retentionSnapshots[1].status,
                readbacks: p.retentionSnapshots[1].readbacks,
                dropped: p.retentionSnapshots[1].dropped,
                ageMs: checkAge(now, p.retentionSnapshots[1].at),
              }
            : null,
        },
        spectrum: {
          state: p.retentionStats?.[2] ?? null,
          snapshot: p.retentionSnapshots?.[2]
            ? {
                status: p.retentionSnapshots[2].status,
                readbacks: p.retentionSnapshots[2].readbacks,
                dropped: p.retentionSnapshots[2].dropped,
                ageMs: checkAge(now, p.retentionSnapshots[2].at),
              }
            : null,
        },
      },
      lastAccepted:
        p.acceptedCheckInputs?.[p.checkInput?.type] ??
        p.acceptedCheckInput ??
        null,
      ...(p.ioRejection ? { io: p.ioRejection } : {}),
      ...(p.assemblerCheck ? { assembler: p.assemblerCheck } : {}),
      ...(p.sdkRejection ? { sdk: p.sdkRejection } : {}),
      rejected:
        p.ioRejection?.input ??
        (p.engineRejection?.input
          ? checkInput(p.engineRejection.input)
          : (p.checkInput ?? null)),
      clockCounts: { ...p.clockCounts },
      coverage: {
        status: missing.length ? "partial" : "complete",
        missing,
        suppressedInputs: p.suppressedInputs,
        invalidInputs: p.invalidInputs,
        truncatedInputs: p.truncatedInputs,
        unavailable: missing.map((field) => ({
          field,
          reason:
            phase === "preparation"
              ? "before-pass"
              : field === "predicate-operands"
                ? "source-not-instrumented"
                : field === "source-io-cause" && p.invalidIORejection
                  ? "invalid"
                  : /^reader-/.test(field) && p.invalidSnapshot
                    ? "invalid"
                    : field === "rejected-input"
                      ? "no-triggering-packet"
                      : "not-received",
        })),
      },
      lifecycle: [...p.checkLifecycle],
    });
    p.nativeFailureDiagnostic = frozen(
      p.nativeFailureDiagnostic
        ? { ...p.nativeFailureDiagnostic, checkEvidence: p.checkEvidence }
        : {
            scope: "native-check-rejection/v1",
            generation: p.generation ?? null,
            nativeEpoch: p.nativeEpoch ?? null,
            checkEvidence: p.checkEvidence,
          },
    );
    p.nativeFailureReason = reason;
  }

  measurementEvent(p, family, stage, reason) {
    const eventId = randomUUID();
    const label = family === 1 ? "envelope" : "spectrum";
    const event = frozen({
      type: "native-measurement-stage",
      scope: NATIVE_V2_SCOPE,
      eventId,
      causationId: p.retentionCauses[family] ?? p.cause,
      stage,
      reason: reason ?? `native_${label}_collection_${stage}`,
      generation: p.generation,
      traceId: p.command.traceId,
      correlationId: p.command.correlationId,
      passId: p.command.passId,
      connectionEpoch: p.command.connectionEpoch,
      nativeEpoch: p.nativeEpoch,
      elapsedMs: Math.min(120000, Math.max(0, this.now() - p.startedAt)),
      frames: Math.min(300, p.assembler?.frames ?? 0),
    });
    p.retentionCauses[family] = eventId;
    callback(() => this.observe(event), "native_measurement_observer_failed");
  }

  measurement(p, values) {
    const [
      family,
      stage,
      epoch,
      expected,
      produced,
      acknowledged,
      capacity,
      highWaterMark,
      elapsedMs,
      fault,
    ] = values;
    const counterMax = 2 ** 44 - 1;
    if (
      ![1, 2].includes(family) ||
      !integer(stage, 0, 5) ||
      epoch !== p.nativeEpoch ||
      !integer(expected, 1, counterMax) ||
      !integer(produced, 0, counterMax) ||
      !integer(acknowledged, 0, produced) ||
      capacity !== (family === 1 ? 16 : 32) ||
      produced - acknowledged > capacity ||
      !integer(highWaterMark, produced - acknowledged, capacity) ||
      elapsedMs < 0 ||
      elapsedMs > 120000 ||
      !integer(fault, 0, 5) ||
      (stage === 4) !== fault > 0
    )
      throw new Error("invalid_native_measurement_state");
    p.retentionStats[family] = frozen(values);
    const phases = [
      "queued",
      "started",
      "progress",
      "completed",
      "failed",
      "cancelled",
    ];
    this.measurementEvent(p, family, phases[stage]);
    if (this.pass !== p || p.closed) return;
    if (stage >= 3) (p.retentionTerminals ??= {})[family] = true;
    if (stage !== 4) return;
    const reason =
      fault === 1
        ? "native_measurement_queue_overflow"
        : fault === 2
          ? "native_measurement_control_invalid"
          : "native_measurement_delivery_failed";
    p.nativeFailureDiagnostic = frozen({
      scope: "native-measurement-delivery-rejection/v1",
      generation: p.generation,
      kind: family === 1 ? "native-envelope/v2" : "native-spectrum/v2",
      nativeEpoch: epoch,
      expectedSequence: expected,
      producedSequence: produced,
      acknowledgedSequence: acknowledged,
      capacity,
      highWaterMark,
      faultCode: fault,
      ...(p.retentionRejections?.[family]
        ? {
            readerReason: p.retentionRejections[family].readerReason,
            readerReadbacks: p.retentionRejections[family].readerReadbacks,
          }
        : {}),
    });
    p.nativeFailureReason = reason;
    throw new Error(reason);
  }

  settleMeasurements(p, status, reason) {
    if (!this.retainedMeasurements || p.retentionSettled) return;
    p.retentionSettled = true;
    for (const family of [1, 2]) {
      if (!p.retentionCauses[family] || p.retentionTerminals?.[family])
        continue;
      this.measurementEvent(
        p,
        family,
        status === "complete"
          ? "completed"
          : status === "partial"
            ? "failed"
            : status,
        status === "failed" || status === "partial" || status === "cancelled"
          ? reason
          : undefined,
      );
    }
  }

  metadata(p, type, v) {
    if (type === "config" && this.nativeVersion === 2) {
      const g = p.command.geometry;
      if (this.state === "preflight") return;
      if (this.state === "native-arming" && v[0] === p.preArmEpoch) return;
      const expected = [
        p.nativeEpoch,
        g.totalSamples,
        g.hopSamples,
        g.tempoBpm,
        g.startBeat % 1,
        g.vectorSize,
        p.nativeEpoch,
      ];
      if (v.some((value, index) => value !== expected[index]))
        throw new Error("native_configuration_receipt_mismatch");
      p.configurationReceipt = v;
      if (p.pendingArmAck) {
        const ack = p.pendingArmAck;
        p.pendingArmAck = null;
        this.envelope(p, ack);
      }
      return;
    }
    if (type === "tempo" && this.nativeVersion === 2)
      this.observeTempo(p, v[0]);
    const geometry = p.command.geometry;
    const expected =
      type === "dsp"
        ? geometry
          ? [1, geometry.sampleRate, geometry.vectorSize]
          : [1, 48000, 64]
        : type === "tempo"
          ? [geometry?.tempoBpm ?? 120]
          : type === "fftInfo"
            ? [2048, 2048, 2048, 1]
            : [this.nativeVersion];
    if (v.some((value, index) => value !== expected[index])) {
      if (this.nativeVersion === 2) {
        const kind = type === "fftInfo" ? "fft_info" : type.replace(/-/g, "_");
        const actual = v.map(diagnosticInteger).join("_");
        throw new Error(`native_metadata_changed_${kind}_${actual}`);
      }
      throw new Error("native_metadata_changed");
    }
    p.metadata[type] = { values: v, at: this.now() };
  }

  observeTempo(p, observedTempoBpm) {
    const previous = p.tempoEvidence;
    const first = previous?.first ?? observedTempoBpm;
    const changed = observedTempoBpm !== first;
    const mismatch = observedTempoBpm !== p.command.geometry.tempoBpm;
    if (previous && !changed && !mismatch) return;
    // These are genuine message receipts, not a signal-rate/native-clock certificate.
    p.tempoEvidence = {
      first,
      min: Math.min(previous?.min ?? observedTempoBpm, observedTempoBpm),
      max: Math.max(previous?.max ?? observedTempoBpm, observedTempoBpm),
    };
    const reason = changed
      ? "native_host_tempo_changed"
      : mismatch
        ? "native_host_tempo_mismatch"
        : "native_host_tempo_observed";
    callback(
      () =>
        this.observe(
          frozen({
            type: "native-tempo-observation",
            scope: NATIVE_V2_SCOPE,
            stage: changed || mismatch ? "failed" : "progress",
            eventId: randomUUID(),
            traceId: p.command.traceId,
            correlationId: p.command.correlationId,
            causationId: p.published ? (p.captureCause ?? p.cause) : p.cause,
            passId: p.command.passId,
            connectionEpoch: p.command.connectionEpoch,
            generation: p.generation,
            nativeEpoch: p.nativeEpoch ?? 0,
            elapsedMs: Math.min(
              120000,
              Math.max(0, this.now() - (p.startedAt ?? p.preparedAt)),
            ),
            reason,
            observationSource: "host-tempo-message",
            observedTempoBpm,
            firstReceivedTempoBpm: first,
            minReceivedTempoBpm: p.tempoEvidence.min,
            maxReceivedTempoBpm: p.tempoEvidence.max,
          }),
        ),
      "native_observer_failed",
    );
    if (changed || mismatch) throw new Error(reason);
  }

  rejectBracket(p, reason) {
    p.inputRejected = true;
    if (p.checkInput && ["clock", "spectrum"].includes(p.checkInput.type))
      (p.acquisitionRejections ??= {})[p.checkInput.type] = frozen({
        reason,
        input: p.checkInput,
        at: this.lastDiagnosticNow,
      });
    if (p.checkInput?.type === "clock") p.clockCounts.rejected++;
    p.rejected++;
    if (p.rejected > 64) throw new Error("native_preflight_rejection_limit");
    this.local(p, "progress", reason);
  }

  rejectClockBracket(p, reason) {
    if (
      this.nativeVersion === 2 &&
      p.command.timingPolicy.mode === "descriptive" &&
      p.rejected >= 64
    ) {
      p.inputRejected = true;
      p.clockCounts.rejected++;
      p.suppressedInputs++;
      if (p.checkInput)
        (p.acquisitionRejections ??= {}).clock = frozen({
          reason,
          input: p.checkInput,
          at: this.lastDiagnosticNow,
        });
      return;
    }
    this.rejectBracket(p, reason);
  }

  reportPreflightFailure(p) {
    if (!this.retainedMeasurements || p.preflightFailureReported) return;
    p.preflightFailureReported = true;
    const reasons = [];
    const missing = (name) => reasons.push(`native_preflight_missing_${name}`);
    if (p.frames.length !== 32) missing("clock_frames");
    if (p.seenEpoch === undefined) missing("envelope_state");
    if (!p.spectrum) missing("spectrum");
    for (const [family, name] of [
      [1, "envelope"],
      [2, "spectrum"],
    ])
      if (!p.retentionReady[family]) missing(`retention_${name}`);
    for (const type of [
      "dsp",
      "tempo",
      "fftInfo",
      "abi-clock",
      "abi-envelope",
      "abi-spectrum",
    ]) {
      const name = type === "fftInfo" ? "fft_info" : type.replace(/-/g, "_");
      if (!p.metadata[type]) missing(name);
      else if (this.now() - p.metadata[type].at > 1000)
        reasons.push(`native_preflight_stale_${name}`);
    }
    for (const name of ["clock", "spectrum", "envelope"])
      if (p[`${name}At`] !== undefined && this.now() - p[`${name}At`] > 1000)
        reasons.push(`native_preflight_stale_${name}`);
    if (p.frames.length) {
      const first = p.frames[0][4];
      const last = p.frames.at(-1)[4];
      reasons.push(`native_preflight_clock_span_${first}_${last}`);
      if (p.spectrum && (p.spectrum[0] > last || last - p.spectrum[0] >= 2048))
        reasons.push(`native_preflight_fft_clock_${p.spectrum[0]}_${last}`);
    }
    for (const reason of reasons.slice(0, 16)) {
      if (this.pass !== p || p.closed) return;
      this.local(p, "progress", reason);
    }
  }

  clock(p, row) {
    if (
      row.some((value) => value < 0) ||
      ![0, 1].includes(row[0]) ||
      ![0, 1].includes(row[7]) ||
      row[1] > 1e9 ||
      row[8] > 1e9 ||
      !integer(row[2]) ||
      !integer(row[9]) ||
      !integer(row[3], 0, 0x7fffffff) ||
      !integer(row[10], 0, 0x7fffffff) ||
      (row[3] & 19) !== 19 ||
      (row[10] & 19) !== 19 ||
      !integer(row[4], 0, 2 ** 44 - 1) ||
      !integer(row[6], 0, 2 ** 44 - 1) ||
      row[5] > 1
    )
      throw new Error("invalid_native_clock");
    if (
      row[0] !== row[7] ||
      row[1] !== row[8] ||
      row[2] !== row[9] ||
      row[3] !== row[10] ||
      row[4] !== row[6]
    ) {
      if (row[0] !== row[7])
        throw new Error("native_transport_changed_during_bracket");
      if (row[6] < row[4] || row[9] < row[2] || row[8] < row[1])
        throw new Error("native_clock_discontinuity");
      return this.rejectClockBracket(p, "torn_native_clock");
    }
    const previous = p.clock;
    if (previous && row[4] === previous[4]) {
      if (
        this.nativeVersion === 2 &&
        p.command.timingPolicy.mode === "descriptive" &&
        row[0] === previous[0] &&
        row[1] >= previous[1] &&
        (row[0] === 1 || row[1] === p.command.geometry.startBeat) &&
        row.some((value, index) => value !== previous[index])
      ) {
        this.rejectClockBracket(p, "stale_native_clock_hold");
        return;
      }
      if (row.some((value, index) => value !== previous[index]))
        throw new Error("changed_native_clock_hold");
      if (this.state === "preflight" && p.held < 64) {
        p.held++;
        this.local(p, "progress", "held_native_clock");
      }
      return;
    }
    if (
      previous &&
      (row[4] < previous[4] ||
        ((this.nativeVersion === 1 ||
          p.command.timingPolicy.mode === "strict") &&
          row[2] < previous[2]) ||
        row[4] - previous[4] > (p.command.geometry?.sampleRate ?? 48000) ||
        (this.nativeVersion === 2 && row[1] < previous[1]))
    )
      throw new Error("native_clock_discontinuity");
    const vectorSize =
      this.nativeVersion === 2 ? p.command.geometry.vectorSize : 64;
    const phaseOffset =
      this.nativeVersion === 2
        ? nativeV2PhaseOffset(row, p.command.geometry)
        : (Math.round(row[1] * 24000) - Math.round(row[5] * 24000)) % 24000;
    if (
      this.state === "capturing" &&
      previous &&
      previous[0] === 1 &&
      row[0] === 1 &&
      row[2] - row[4] - (previous[2] - previous[4]) === vectorSize &&
      phaseOffset === vectorSize &&
      (this.nativeVersion === 1 ||
        nativeV2PhaseDisagreement(previous, p.command.geometry) === 0)
    )
      return this.rejectClockBracket(p, "phase_torn_native_clock");
    if (
      this.nativeVersion === 1 &&
      previous &&
      row[2] - row[4] !== previous[2] - previous[4]
    ) {
      if (this.state !== "preflight")
        throw new Error("native_clock_discontinuity");
      p.frames.length = 0;
      this.rejectBracket(p, "native_preflight_binding_restart");
      if (this.pass !== p) return;
    }
    if (
      this.state === "preflight" &&
      (row[0] !== 0 ||
        row[1] !== (p.command.geometry?.startBeat ?? 0) ||
        (previous && row[5] !== previous[5]))
    )
      throw new Error("native_transport_changed_before_launch");
    if (this.nativeVersion === 1 && row[0] === 1 && phaseOffset !== 0)
      throw new Error("native_host_phase_changed");
    if (this.nativeVersion === 2) {
      if (!nativeV2ClockRow(row)) throw new Error("incoherent_native_v2_clock");
      if (p.anchorHostOffset === undefined) {
        p.anchorHostOffset = row[2] - row[4];
        p.anchorClock = frozen(row);
      }
      if (
        p.command.timingPolicy.mode === "strict" &&
        Math.abs(row[2] - row[4] - p.anchorHostOffset) >
          p.command.timingPolicy.maxClockDisagreementSamples
      )
        throw this.alignmentError(p, "host-offset", row, {
          observedClockDisagreementSamples: Math.abs(
            row[2] - row[4] - p.anchorHostOffset,
          ),
          observedBeatDisagreementSamples: null,
        });
      // The message-rate host can report playing before plugphasor~ leaves
      // its stopped value. Do not turn that startup bracket into capture proof.
      if (
        this.state === "armed" &&
        previous?.[0] === 0 &&
        row[0] === 1 &&
        row[5] === previous[5]
      )
        return this.rejectClockBracket(p, "native_launch_phase_pending");
      nativeV2RetainTiming(p.timingWitnesses, row, p.command.geometry);
      if (
        this.engine.pass?.startSample !== null &&
        this.engine.pass?.startSample !== undefined
      )
        this.engine.pass.alignment = this.alignment(p, row, "clock-alignment");
    }
    p.clockCounts.accepted++;
    p.clock = row;
    p.clockAt = this.now();
    if (this.state === "armed") this.prunePrelaunchSpectra(p);
    if (this.state === "preflight") {
      p.frames.push(row);
      if (p.frames.length > 32) {
        if (this.nativeVersion === 2) p.frames.splice(1, 1);
        else p.frames.shift();
      }
      if (
        p.frames.at(-1)[4] - p.frames[0][4] >
        (p.command.geometry?.sampleRate ?? 48000)
      ) {
        if (this.nativeVersion === 2) {
          const firstClock = p.frames[0];
          const lastClock = p.frames.at(-1);
          const spectrumEndSample = p.spectrum?.[0] ?? null;
          p.preflightSpan = frozen({
            checkId: "preflight-source-span",
            actualSpanSamples: lastClock[4] - firstClock[4],
            maximumSpanSamples: p.command.geometry.sampleRate,
            firstClock: [...firstClock],
            lastClock: [...lastClock],
            clockCount: p.frames.length,
            minimumClockCount: 32,
            clockDomain: "native-source",
            prerequisites: {
              retentionRequired: this.retainedMeasurements,
              retentionEnvelopeReady: p.retentionReady[1] === true,
              retentionSpectrumReady: p.retentionReady[2] === true,
              envelopeEpochSeen: p.seenEpoch !== undefined,
              spectrumPresent: p.spectrum !== null && p.spectrum !== undefined,
              metadataComplete: [
                "dsp",
                "tempo",
                "fftInfo",
                "abi-clock",
                "abi-envelope",
                "abi-spectrum",
              ].every((type) => p.metadata[type] !== undefined),
            },
            ages: {
              clockMs: checkAge(p.clockAt, p.clockAt),
              envelopeMs: checkAge(p.clockAt, p.envelopeAt),
              spectrumMs: checkAge(p.clockAt, p.spectrumAt),
              maximumMs: 1000,
              domain: "receipt-time",
            },
            spectrumEndSample,
            clockEndSample: lastClock[4],
            clockMinusSpectrumSamples:
              spectrumEndSample === null
                ? null
                : lastClock[4] - spectrumEndSample,
            minimumClockMinusSpectrumSamples: 0,
            maximumClockMinusSpectrumSamplesExclusive: 2048,
          });
        }
        this.reportPreflightFailure(p);
        throw new Error("stale_native_preflight");
      }
      return;
    }
    if (this.nativeVersion === 2 && this.engine.pass === null) return;
    this.host(p);
    if (this.engine.pass === null) return;
    const alreadyCovered = p.assembler?.state === "covered";
    if (this.state === "armed" && p.launchPacket) {
      const pending = p.launchPacket;
      this.tryLaunch(p, pending);
    }
    if (this.pass !== p) return;
    this.flushEnvelopes(p);
    if (this.pass !== p) return;
    if (this.retainedMeasurements) {
      // Acquire source-clock proof at the endpoint, independently of descriptor delivery.
      if (!p.assembler) return;
      const end = p.assembler.originCounter + p.command.geometry.totalSamples;
      if (row[0] !== 1 || row[4] < end || p.post.length === 32) return;
      if (row[4] - end > p.command.geometry.sampleRate) {
        this.retainJoinFailure(
          p,
          "post-binding",
          "stale_native_post_binding",
          null,
          row,
        );
        throw new Error("stale_native_post_binding");
      }
      p.post.push(row);
      return;
    }
    if (alreadyCovered) {
      const end =
        p.assembler.originCounter +
        (p.command.geometry?.totalSamples ?? p.command.endBeat * 24000);
      if (row[0] !== 1 || row[4] < end) return;
      if (row[4] - end > (p.command.geometry?.sampleRate ?? 48000))
        throw new Error("stale_native_post_binding");
      if (p.post.length >= 32) throw new Error("native_post_buffer_overflow");
      p.post.push(row);
      if (p.post.length === 32) {
        p.after = frozen({ dsp: p.before.dsp, frames: p.post });
        this.engine.confirmNativeHost(p.after, p.command);
        p.spectralWindows = p.assembler.spectralWindows(p.owner);
        this.engine.finish();
      }
    }
  }

  finishRetainedPost(p) {
    if (
      this.pass !== p ||
      p.assembler?.state !== "covered" ||
      p.post.length !== 32 ||
      p.after
    )
      return;
    p.after = frozen({ dsp: p.before.dsp, frames: p.post });
    try {
      this.engine.confirmNativeHost(p.after, p.command);
    } catch (cause) {
      this.retainJoinFailure(
        p,
        "post-binding",
        reasonCode(cause),
        null,
        p.post.at(-1),
      );
      throw cause;
    }
    p.spectralWindows = p.assembler.spectralWindows(p.owner);
    this.engine.finish();
  }

  retainJoinFailure(
    p,
    check,
    reason,
    rejectedEnvelope = null,
    rejectedClock = null,
    snapshot = null,
  ) {
    if (this.nativeVersion !== 2 || p.nativeFailureDiagnostic || !p.assembler)
      return;
    const first =
      snapshot?.firstEnvelopeEndCounter ??
      p.envelopes[0]?.endCounter ??
      p.assembler.pending[0]?.end ??
      null;
    const available =
      snapshot?.availableSpectrum ??
      p.assembler.spectra
        .filter((s) => first !== null && s.end <= first)
        .at(-1);
    const age = p.clock
      ? Math.min(120000, Math.max(0, this.now() - p.clockAt))
      : null;
    const behind =
      first !== null &&
      p.clock &&
      (p.command.timingPolicy.mode === "descriptive"
        ? p.clock[4] < first
        : p.clock[2] < first + p.assembler.hostOffsetSamples);
    const spectralBlocker =
      !available || first - available.end >= 2048
        ? "spectrum-behind"
        : "assembler-pending";
    const blocker =
      check === "post-binding"
        ? p.post.length === 32
          ? "post-clock-invalid"
          : "post-clock-incomplete"
        : check === "assembler-envelope-overflow"
          ? spectralBlocker
          : !p.clock
            ? "clock-missing"
            : p.clock[0] !== 1
              ? "clock-stopped"
              : age > 1000
                ? "clock-stale"
                : behind
                  ? "clock-behind"
                  : spectralBlocker;
    p.nativeFailureDiagnostic = frozen({
      scope: "native-capture-join-rejection/v1",
      generation: p.generation,
      nativeEpoch: p.nativeEpoch,
      check,
      blocker,
      sampleRate: p.command.geometry.sampleRate,
      timingMode: p.command.timingPolicy.mode,
      hostOffsetSamples: p.assembler.hostOffsetSamples,
      originCounter: p.assembler.originCounter,
      sourceEndCounter:
        p.assembler.originCounter + p.command.geometry.totalSamples,
      completedMeasurements: p.assembler.frames,
      controllerPending: p.envelopes.length,
      assemblerPending: snapshot?.pendingCount ?? p.assembler.pending.length,
      firstEnvelopeEndCounter: first,
      rejectedEnvelopeEndCounter: rejectedEnvelope,
      clock: p.clock ?? null,
      clockAgeMs: age,
      latestSpectrum: p.spectrum ?? null,
      availableSpectrum: available ? [available.start, available.end] : null,
      retentionEnvelope: p.retentionStats[1] ?? null,
      retentionSpectrum: p.retentionStats[2] ?? null,
      postClockCount: p.post.length,
      postFirstCounter: p.post[0]?.[4] ?? null,
      postLastCounter: p.post.at(-1)?.[4] ?? null,
      coverageAgeMs:
        p.coveredAt === undefined
          ? null
          : Math.min(120000, Math.max(0, this.now() - p.coveredAt)),
      rejectedClock,
    });
    p.nativeFailureReason = reason;
  }

  host(p) {
    const row = p.clock;
    let tempoBpm = 120;
    if (this.nativeVersion === 2) {
      tempoBpm = p.metadata.tempo?.values[0];
      if (!Number.isFinite(tempoBpm))
        throw new Error("native_host_tempo_evidence_missing");
      this.observeTempo(p, tempoBpm);
    }
    this.engine.configureHost({
      sampleRate: p.command.geometry?.sampleRate ?? 48000,
      vectorSize: p.command.geometry?.vectorSize ?? 64,
      tempoBpm,
      dspOn: true,
      playing: row[0] === 1,
      beat: row[1],
      sample: row[2],
      flags: row[3],
    });
  }

  spectrumPacketReason(v, field) {
    if (this.nativeVersion !== 2) return "invalid_native_spectrum_packet";
    const [end, start, frame, bad] = [0, 3, 4, 5].map((index) =>
      diagnosticInteger(v[index]),
    );
    return `invalid_native_spectrum_packet_${field}_e${end}_s${start}_f${frame}_b${bad}`;
  }

  retainAlignmentFailure(p, check, row, measurements, startSample, reason) {
    if (
      !p.nativeFailureDiagnostic ||
      p.nativeFailureDiagnostic.scope === "native-check-rejection/v1"
    ) {
      p.nativeFailureDiagnostic = frozen({
        scope: "native-alignment-rejection/v1",
        generation: p.generation,
        check,
        geometry: p.command.geometry,
        policy: p.command.timingPolicy,
        anchorHostOffsetSamples: p.anchorHostOffset,
        startSample,
        anchorClock: p.anchorClock,
        previousClock: p.clock ?? null,
        rejectedClock: row,
        timingWitnesses: Object.fromEntries(
          [
            "minHostOffset",
            "maxHostOffset",
            "minBeatOrigin",
            "maxBeatOrigin",
            "maxPhaseDisagreement",
          ].map((key) => [key, p.timingWitnesses[key] ?? null]),
        ),
        measurements,
      });
      p.nativeFailureReason = reason;
    }
  }

  alignmentError(p, check, row, measurements) {
    const reason = "listening_alignment_budget_exceeded";
    this.retainAlignmentFailure(
      p,
      check,
      row,
      measurements,
      this.engine.pass?.startSample ?? null,
      reason,
    );
    return new Error(reason);
  }

  alignment(p, row, check) {
    try {
      return nativeV2Alignment(
        p.timingWitnesses,
        p.command.geometry,
        p.command.timingPolicy,
        p.anchorHostOffset,
        this.engine.pass.startSample,
      );
    } catch (error) {
      if (
        error.message === "listening_alignment_budget_exceeded" &&
        error.alignmentMeasurements
      )
        throw this.alignmentError(p, check, row, error.alignmentMeasurements);
      throw error;
    }
  }

  spectrumPacketError(p, v, check) {
    const reason =
      check === "sequence"
        ? "changed_native_spectrum_sequence"
        : this.spectrumPacketReason(v, check);
    if (this.nativeVersion === 2 && !p.nativeFailureDiagnostic) {
      p.nativeFailureDiagnostic = frozen({
        scope: "native-spectrum-rejection/v1",
        generation: p.generation,
        check,
        packet: v,
        ...(check === "sequence" ? { previousPacket: p.spectrum } : {}),
        fftDiagnostics: p.spectrumDiagnostics,
        metadata: {
          dsp: p.metadata.dsp?.values ?? null,
          fftInfo: p.metadata.fftInfo?.values ?? null,
          clockAbi: p.metadata["abi-clock"]?.values[0] ?? null,
          envelopeAbi: p.metadata["abi-envelope"]?.values[0] ?? null,
          spectrumAbi: p.metadata["abi-spectrum"]?.values[0] ?? null,
        },
      });
      p.nativeFailureReason = reason;
    }
    return new Error(reason);
  }

  prunePrelaunchSpectra(p) {
    if (!this.retainedMeasurements || this.state !== "armed") return null;
    // A validated DSP launch marker fixes onset. Until then, only a fresh,
    // accepted stopped clock proves a lower bound for future onset. Never
    // roll potentially post-onset frames out merely to make queue space.
    const lowerBound = p.launchPacket
      ? p.armed.armCounter + p.launchPacket[1] - p.launchPacket[6]
      : p.clock?.[0] === 0 && this.now() - p.clockAt <= 1000
        ? p.clock[4]
        : null;
    if (lowerBound !== null)
      while (
        p.prelaunchSpectra.length &&
        p.prelaunchSpectra[0][0] <= lowerBound
      )
        p.prelaunchSpectra.shift();
    return lowerBound;
  }

  spectrum(p, v) {
    const invalidField = [
      ["end", !integer(v[0], 2048, 2 ** 44 - 1)],
      ["start", !integer(v[3], 0, 2 ** 44 - 1)],
      ["frame", !integer(v[4], 2048, 2 ** 44 - 1)],
      [
        "centroid",
        v[1] < 0 || v[1] > (p.command.geometry?.sampleRate ?? 48000) / 2,
      ],
      ["energy", v[2] < 0 || v[2] > Number.MAX_SAFE_INTEGER],
      ["silence_centroid", v[2] <= 1e-20 && v[1] !== 0],
      ["invalid_frames", !integer(v[5])],
    ].find(([, invalid]) => invalid)?.[0];
    if (invalidField) throw this.spectrumPacketError(p, v, invalidField);
    const previous = p.spectrum;
    if (v[0] !== v[4] || v[0] - v[3] !== 2048) {
      if (
        ["preflight", "native-arming", "armed", "capturing"].includes(
          this.state,
        ) &&
        previous &&
        v[0] === previous[0] &&
        v[4] === previous[0] + 2048 &&
        v[5] === previous[5] &&
        (v[3] === previous[0] ||
          (this.nativeVersion === 2 &&
            previous[4] === previous[0] &&
            previous[0] - previous[3] === 2048 &&
            v[3] === previous[3] &&
            v[1] === previous[1] &&
            v[2] === previous[2] &&
            this.now() - p.spectrumAt >= 0 &&
            this.now() - p.spectrumAt <= 1000))
      )
        return this.rejectBracket(p, "torn_native_spectrum");
      throw this.spectrumPacketError(p, v, "bracket");
    }
    if (
      previous &&
      (v[5] !== previous[5] ||
        v[0] < previous[0] ||
        (v[0] - previous[0]) % 2048 !== 0 ||
        (this.state === "capturing" &&
          (this.nativeVersion !== 2 ||
            p.command.timingPolicy.mode === "strict") &&
          v[0] !== previous[0] &&
          v[0] - previous[0] !== 2048) ||
        (v[0] === previous[0] &&
          v.some((value, index) => value !== previous[index])))
    )
      throw this.spectrumPacketError(p, v, "sequence");
    p.spectrum = v;
    p.spectrumAt = this.now();
    if (this.retainedMeasurements && this.state === "armed") {
      const lowerBound = this.prunePrelaunchSpectra(p);
      if (
        (lowerBound === null || v[0] > lowerBound) &&
        p.prelaunchSpectra.at(-1)?.[0] !== v[0]
      ) {
        if (p.prelaunchSpectra.length >= 32)
          throw new Error("native_prelaunch_spectrum_buffer_overflow");
        p.prelaunchSpectra.push(frozen(v));
      }
    }
    if (p.assembler) {
      p.assembler.pushSpectrum(v, p.owner);
      this.flushEnvelopes(p);
    }
  }

  envelope(p, v, stateOnly = false) {
    if (!integer(v[0], 0, 1000000) || v[15] !== this.nativeVersion)
      throw new Error("invalid_native_envelope_epoch");
    if (this.state === "preflight") {
      p.seenEpoch = Math.max(p.seenEpoch ?? 0, v[0]);
      p.preArmEpoch = v[0];
      p.envelopeAt = this.now();
      return;
    }
    if (v[0] !== p.nativeEpoch) {
      if (this.state === "native-arming" && v[0] === p.preArmEpoch) {
        if (p.armHeld >= 64) throw new Error("native_arm_ack_hold_limit");
        p.armHeld++;
        this.local(p, "progress", "waiting_native_reset");
        return;
      }
      throw new Error("native_epoch_mismatch");
    }
    if (this.state === "native-arming") {
      if (
        RESET_INDICES.some((index, i) => v[index] !== RESET_VALUES[i]) ||
        v[14] !== -1
      )
        throw new Error("invalid_native_arm_ack");
      if (this.nativeVersion === 2 && !p.configurationReceipt) {
        if (
          p.pendingArmAck &&
          v.some((value, index) => value !== p.pendingArmAck[index])
        )
          throw new Error("changed_native_reset_hold");
        p.pendingArmAck = v;
        return;
      }
      const reset = Object.fromEntries(
        RESET_KEYS.map((key, i) => [key, v[RESET_INDICES[i]]]),
      );
      const marker = {
        nativeEpoch: p.nativeEpoch,
        armCounter: v[13],
        hostBinding: p.before,
        ...reset,
      };
      const ready = this.engine.acknowledgeNativeArm(marker, p.command);
      if (ready?.status !== "ready") throw new Error("native_arm_ack_failed");
      p.armed = frozen({
        scope: this.nativeVersion === 2 ? NATIVE_V2_SCOPE : SCOPE,
        ...(this.nativeVersion === 2
          ? { policy: p.command.timingPolicy, geometry: p.command.geometry }
          : {}),
        nativeEpoch: p.nativeEpoch,
        armCounter: v[13],
        before: p.before,
        reset,
      });
      this.state = "armed";
      if (
        callback(
          () => this.onArmed(p.armed),
          "native_armed_publication_failed",
        ) !== true
      )
        throw new Error("native_armed_publication_failed");
      if (this.pass !== p || p.closed) return;
      p.published = true;
      p.resolve({ status: "ready", nativeArm: p.armed });
      p.resolve = p.reject = null;
      return;
    }
    if (v[13] !== p.armed.armCounter || v[4] !== 0) {
      if (this.nativeVersion === 2)
        this.local(
          p,
          "progress",
          `native_envelope_binding_r${diagnosticInteger(v[4])}_a${diagnosticInteger(v[13])}_e${diagnosticInteger(p.armed.armCounter)}_p${diagnosticInteger(v[6])}`,
        );
      throw new Error("native_envelope_binding_changed");
    }
    if (this.state === "armed") {
      if (v[1] < 0 && v[5] === 0) {
        if (
          RESET_INDICES.some((index, i) => v[index] !== RESET_VALUES[i]) ||
          v[14] !== -1
        )
          throw new Error("changed_native_reset_hold");
        return;
      }
      const marker = p.launchPacket ?? v;
      const origin = p.armed.armCounter + marker[1] - marker[6];
      if (
        !integer(
          marker[1],
          0,
          10 * (p.command.geometry?.sampleRate ?? 48000),
        ) ||
        !integer(marker[6], 0, p.command.geometry?.vectorSize ?? 64) ||
        origin < p.armed.armCounter
      )
        throw new Error("native_envelope_coordinates_changed");
      this.envelopePacket(
        p,
        v,
        { launchClock: marker[1], launchPhaseSamples: marker[6] },
        origin,
        stateOnly,
      );
      if (!stateOnly && v[12] > 0) {
        const previous = p.prelaunchEnvelopes.at(-1);
        if (previous?.[12] === v[12]) {
          if (v.some((value, index) => value !== previous[index]))
            throw new Error("changed_native_envelope_hold");
          return;
        }
        const hop = p.command.geometry?.hopSamples ?? 4800;
        const total = p.command.geometry?.totalSamples ?? 480000;
        if (v[12] !== Math.min((previous?.[12] ?? 0) + hop, total))
          throw new Error("native_envelope_sequence_gap");
        if (p.prelaunchEnvelopes.length >= (this.retainedMeasurements ? 16 : 8))
          throw new Error("native_prelaunch_envelope_buffer_overflow");
        p.prelaunchEnvelopes.push(frozen(v));
        if (p.prelaunchEnvelopes.length === 1) {
          this.local(p, "progress", "native_prelaunch_envelope_staged");
          if (this.pass !== p || p.closed) return;
        }
      }
      // Launch snapshots carry provenance; only measured rows enter the FIFO.
      p.launchPacket = frozen(v);
      p.launchPacketStateOnly = stateOnly;
      this.prunePrelaunchSpectra(p);
      this.tryLaunch(p, v);
      return;
    }
    if (this.pass !== p || !p.assembler) return;
    const origin = p.assembler.originCounter;
    const hop = p.command.geometry?.hopSamples ?? 4800;
    const packet = this.envelopePacket(p, v, p.launched, origin, stateOnly);
    if (!packet) return;
    if (p.assembler.state === "covered") {
      p.assembler.pushEnvelope(packet, p.owner);
      return;
    }
    const fingerprint = JSON.stringify(
      this.retainedMeasurements
        ? v
        : [packet.endCounter, ...packet.peak, ...packet.rms],
    );
    if (p.lastEnvelope?.end === packet.endCounter) {
      if (p.lastEnvelope.fingerprint !== fingerprint)
        throw new Error("changed_native_envelope_hold");
      return;
    }
    if (
      packet.endCounter !==
        Math.min(
          (p.lastEnvelope?.end ?? origin) + hop,
          origin +
            (p.command.geometry?.totalSamples ?? p.assembler.windows * 4800),
        ) ||
      packet.endCounter >
        origin +
          (p.command.geometry?.totalSamples ?? p.assembler.windows * 4800)
    )
      throw new Error("native_envelope_sequence_gap");
    if (p.envelopes.length >= 8) {
      this.retainJoinFailure(
        p,
        "controller-envelope-overflow",
        "native_envelope_buffer_overflow",
        packet.endCounter,
      );
      throw new Error("native_envelope_buffer_overflow");
    }
    p.lastEnvelope = { end: packet.endCounter, fingerprint };
    p.envelopes.push(packet);
    if (this.nativeVersion === 2) {
      // Preserve native evidence before descriptor assembly can relabel it.
      p.envelopeWindows.push([packet.endCounter, ...packet.rms]);
    }
    this.flushEnvelopes(p);
  }

  envelopePacket(p, v, launched, origin, stateOnly) {
    const hop = p.command.geometry?.hopSamples ?? 4800;
    const total = p.command.geometry?.totalSamples ?? 480000;
    if (
      v[1] !== launched.launchClock ||
      v[6] !== launched.launchPhaseSamples ||
      v[14] !== origin ||
      (v[5] !== 1 && !(v[5] === 0 && v[12] === total)) ||
      !integer(v[3]) ||
      !integer(v[12], 0, total) ||
      (v[12] % hop !== 0 && v[12] !== total)
    )
      throw new Error("native_envelope_coordinates_changed");
    if (
      !integer(v[2], -1, 2 ** 44 - 1) ||
      !integer(v[7], -1, 2 ** 44 - 1) ||
      (v[2] === -1) !== (v[7] === -1) ||
      v[2] < v[7]
    )
      throw new Error("native_source_coordinates_changed");
    if (v[12] === 0 || stateOnly) return null;
    const packet = {
      nativeEpoch: p.nativeEpoch,
      armCounter: v[13],
      originCounter: origin,
      endCounter: v[14] + v[12],
      peak: v.slice(8, 10),
      rms: v.slice(10, 12),
    };
    if (
      !integer(packet.endCounter, origin + hop, 2 ** 44 - 1) ||
      [...packet.peak, ...packet.rms].some(
        (value) => value < 0 || value > 64,
      ) ||
      packet.rms.some((value, index) => value > packet.peak[index] + 1e-8)
    )
      throw new Error("invalid_native_envelope_packet");
    return packet;
  }

  flushEnvelopes(p) {
    while (
      this.pass === p &&
      p.assembler?.state === "capturing" &&
      p.envelopes.length &&
      p.clock?.[0] === 1 &&
      this.now() - p.clockAt <= 1000
    ) {
      const packet = p.envelopes[0];
      if (
        this.nativeVersion === 2 &&
        p.command.timingPolicy.mode === "descriptive"
          ? p.clock[4] < packet.endCounter
          : p.clock[2] < packet.endCounter + p.assembler.hostOffsetSamples
      )
        return;
      const available = p.assembler.spectra.some(
        (spectrum) =>
          spectrum.end <= packet.endCounter &&
          packet.endCounter - spectrum.end < 2048,
      );
      if (
        !available &&
        (p.assembler.lastSpectrum?.end ?? -1) <= packet.endCounter
      )
        return;
      p.envelopes.shift();
      p.assembler.pushEnvelope(packet, p.owner);
    }
  }

  tryPreflight(p) {
    const wait = (
      check,
      actual,
      expected,
      relation,
      unit,
      metadataKind = null,
    ) => {
      if (this.nativeVersion !== 2) return;
      const value = frozen({
        check,
        actual,
        expected,
        relation,
        unit,
        metadataKind,
        domain:
          unit === "milliseconds"
            ? "receipt-time"
            : unit === "samples" || check === "clock-count"
              ? "native-source"
              : "control",
        elapsedMs: checkAge(this.lastDiagnosticNow, p.startedAt),
      });
      p.firstPreflightWait ??= value;
      const previous = p.lastPreflightWait;
      p.lastPreflightWait = value;
      if (previous?.check === check && previous.metadataKind === metadataKind)
        return;
      const transitions = (p.preflightWaits ??= []);
      transitions.push(value);
      if (transitions.length > 8) {
        transitions.splice(1, 1);
        p.droppedPreflightWaits = (p.droppedPreflightWaits ?? 0) + 1;
      }
    };
    if (this.retainedMeasurements) {
      for (const [family, name] of [
        [1, "envelope"],
        [2, "spectrum"],
      ])
        if (!p.retentionReady[family])
          return wait(`retention-${name}`, false, true, "equal", "boolean");
    }
    if (p.frames.length !== 32)
      return wait("clock-count", p.frames.length, 32, "equal", "count");
    if (p.seenEpoch === undefined)
      return wait("envelope", false, true, "equal", "boolean");
    if (!p.spectrum) return wait("spectrum", false, true, "equal", "boolean");
    for (const type of Object.keys(LENGTHS).filter(
      (type) => !["clock", "spectrum", "envelope", "ioError"].includes(type),
    )) {
      if (!p.metadata[type])
        return wait("metadata-missing", false, true, "equal", "boolean", type);
      if (this.nativeVersion === 2) {
        const age = this.now() - p.metadata[type].at;
        if (age > 1000)
          return wait(
            "metadata-stale",
            age,
            1000,
            "at-most",
            "milliseconds",
            type,
          );
      }
    }
    for (const name of ["clock", "spectrum", "envelope"]) {
      const age = this.now() - p[`${name}At`];
      if (age > 1000)
        return wait(`${name}-stale`, age, 1000, "at-most", "milliseconds");
    }
    if (
      !this.retainedMeasurements ||
      !p.before ||
      p.spectrum[0] > p.before.frames.at(-1)[4]
    )
      p.before = frozen({ dsp: p.metadata.dsp.values, frames: p.frames });
    // Join delayed immutable FFT evidence to an actual bounded clock cohort,
    // not to a moving newest-clock target. Live host/source deadlines still run.
    const last = p.before.frames.at(-1)[4];
    // FFT and clock arrive independently. Future/old baseline is not failure.
    if (p.spectrum[0] > last)
      return wait("fft-future", last - p.spectrum[0], 0, "at-least", "samples");
    if (last - p.spectrum[0] >= 2048)
      return wait(
        "fft-behind",
        last - p.spectrum[0],
        2048,
        "less-than",
        "samples",
      );
    if (this.nativeVersion === 2)
      nativeV2HostBinding(
        p.before,
        false,
        p.command.geometry,
        p.command.timingPolicy,
      );
    else nativeHostBinding(p.before, false);
    if (!this.retainedMeasurements) {
      p.nativeEpoch = Math.max(this.allocatedEpoch, p.seenEpoch) + 1;
      if (p.nativeEpoch > 1000000) throw new Error("native_epoch_exhausted");
      this.allocatedEpoch = p.nativeEpoch;
    }
    p.owner ??= frozen({
      passId: p.command.passId,
      connectionEpoch: p.command.connectionEpoch,
      nativeEpoch: p.nativeEpoch,
    });
    this.local(p, "completed");
    if (this.pass !== p) return;
    this.host(p);
    this.engine.prepare(
      { ...p.command, causationId: p.cause },
      {
        before: p.before,
        fftInformation: p.metadata.fftInfo.values,
        spectrum: p.spectrum,
      },
    );
    if (this.pass !== p) return;
    p.armAt = this.now();
    this.state = "native-arming";
    this.engine.arm(p.owner);
    if (this.pass !== p) return;
    if (this.nativeVersion === 2) {
      const g = p.command.geometry;
      this.control(p, {
        action: "configure_v2",
        parameters: [
          g.totalSamples,
          g.hopSamples,
          g.tempoBpm,
          g.startBeat % 1,
          g.vectorSize,
        ],
      });
      if (this.pass !== p) return;
    }
    this.control(p, { action: "arm", nativeEpoch: p.nativeEpoch });
  }

  tryLaunch(p, v) {
    if (!p.published || !p.clock || p.clock[0] !== 1) return;
    if (this.now() - p.clockAt > 1000)
      throw new Error("native_launch_host_stale");
    const marker = {
      nativeEpoch: v[0],
      armCounter: v[13],
      launchClock: v[1],
      launchPhaseSamples: v[6],
      rejected: v[4],
      active: v[5],
    };
    if (this.engine.launchNative(marker, p.command) !== true) {
      if (
        this.nativeVersion === 2 &&
        p.events.some(
          (event) =>
            event.type === "terminal" &&
            event.reason === "native_launch_binding_mismatch",
        )
      ) {
        const projectedStartSample =
          marker.armCounter +
          marker.launchClock -
          marker.launchPhaseSamples +
          p.anchorHostOffset;
        this.retainAlignmentFailure(
          p,
          "launch-alignment",
          p.clock,
          nativeV2AlignmentMeasurements(
            p.timingWitnesses,
            p.command.geometry,
            p.anchorHostOffset,
            projectedStartSample,
          ),
          projectedStartSample,
          "native_launch_binding_mismatch",
        );
      }
      return;
    }
    if (this.pass !== p) return;
    const row = p.clock;
    p.launched = frozen({
      ...marker,
      host: { sample: row[2], beat: row[1], flags: row[3], playing: true },
    });
    if (this.nativeVersion === 2)
      this.engine.pass.alignment = this.alignment(p, row, "launch-alignment");
    p.assembler = new NativeDescriptorAssembler({
      owner: p.owner,
      armCounter: v[13],
      originCounter: v[13] + v[1] - v[6],
      hostOffsetSamples: this.engine.pass.nativeHostOffset,
      windows:
        this.nativeVersion === 2 ? p.command.maxWindows : p.command.endBeat * 5,
      ...(this.nativeVersion === 2
        ? {
            geometry: {
              sampleRate: p.command.geometry.sampleRate,
              hopSamples: p.command.geometry.hopSamples,
              totalSamples: p.command.geometry.totalSamples,
            },
            coordinates: {
              startBeat: p.command.geometry.startBeat,
              tempoBpm: p.command.geometry.tempoBpm,
            },
          }
        : {}),
      invalidFrames: this.engine.pass.certificate.invalidFrames,
      onFrame: (frame) =>
        this.pass === p &&
        this.engine.ingest(
          frame,
          p.command,
          this.retainedMeasurements
            ? { counter: p.clock[4], capacity: p.retentionStats[1]?.[6] }
            : undefined,
        ) === true &&
        this.pass === p,
      onFailure: (reason, owner, diagnostic, sourceCheck) => {
        p.assemblerCheck = sourceCheck;
        if (
          this.pass === p &&
          owner === p.assembler.owner &&
          reason === "native_envelope_buffer_overflow"
        ) {
          this.retainJoinFailure(
            p,
            "assembler-envelope-overflow",
            reason,
            null,
            null,
            diagnostic,
          );
        }
        if (
          this.nativeVersion === 2 &&
          this.pass === p &&
          owner === p.assembler.owner &&
          reason === "native_fft_window_missing" &&
          diagnostic?.scope === "native-coverage-rejection/v1" &&
          !p.nativeFailureDiagnostic
        ) {
          p.nativeFailureDiagnostic = frozen({
            ...diagnostic,
            generation: p.generation,
          });
          p.nativeFailureReason = reason;
        }
        this.retainCheckFailure(p, reason, "assembler");
        this.fail(p, reason);
      },
    });
    if (v[14] !== p.assembler.originCounter)
      throw new Error("native_envelope_origin_changed");
    this.state = "capturing";
    const stateOnly = p.launchPacketStateOnly;
    p.launchPacket = null;
    p.launchPacketStateOnly = null;
    const spectra = p.prelaunchSpectra.length
      ? p.prelaunchSpectra
      : [p.spectrum];
    for (const spectrum of spectra) {
      if (this.pass !== p || p.closed) return;
      if (spectrum && spectrum[3] >= p.assembler.originCounter)
        p.assembler.pushSpectrum(spectrum, p.owner);
    }
    p.prelaunchSpectra.length = 0;
    if (stateOnly && v[12] > 0) {
      this.local(p, "progress", "native_launch_state_only");
      if (this.pass !== p || p.closed) return;
    }
    if (p.prelaunchEnvelopes.length) {
      // Never replay the latest state-only launch snapshot as a measurement.
      this.local(p, "progress", "native_prelaunch_envelope_draining");
      while (this.pass === p && !p.closed && p.prelaunchEnvelopes.length)
        this.envelope(p, p.prelaunchEnvelopes.shift());
      if (this.pass === p && !p.closed)
        this.local(p, "progress", "native_prelaunch_envelope_drained");
    }
  }

  drain(p) {
    if (p.draining || this.pass !== p) return;
    if (!p.published) {
      const terminal = p.events.find((event) => event.type === "terminal");
      if (terminal) this.fail(p, terminal.reason, terminal.status);
      return;
    }
    p.draining = true;
    try {
      while (p.events.length && this.pass === p) {
        let event = p.events.shift();
        if (event.type === "native-capture-stage")
          event = {
            ...event,
            elapsedMs: Math.min(120000, Math.max(0, event.elapsedMs)),
          };
        if (event.type === "terminal" && event.status === "complete")
          event = {
            ...event,
            nativeCapture: frozen({
              armed: p.armed,
              launched: p.launched,
              after: p.after,
              spectralWindows: p.spectralWindows,
              ...(this.nativeVersion === 2
                ? {
                    timingWitnesses: p.timingWitnesses,
                    envelopeWindows: p.envelopeWindows,
                  }
                : {}),
            }),
          };
        if (
          event.type === "native-capture-stage" &&
          event.reason === "native_launch_observed"
        )
          event = { ...event, nativeLaunch: p.launched };
        if (
          this.nativeVersion === 2 &&
          event.type === "terminal" &&
          event.status === "failed" &&
          event.reason === p.nativeFailureReason &&
          p.nativeFailureDiagnostic
        )
          event = {
            ...event,
            nativeFailureDiagnostic: p.nativeFailureDiagnostic,
          };
        if (event.type === "terminal")
          this.settleMeasurements(p, event.status, event.reason);
        if (this.pass !== p || p.closed) return;
        if (
          callback(
            () => this.emit(frozen(event)),
            "native_result_publication_failed",
          ) === false
        )
          throw new Error("native_result_publication_failed");
        if (event.type === "terminal")
          this.close(p, event.status, event.reason);
      }
    } finally {
      p.draining = false;
    }
  }

  deadline(p) {
    const elapsed = this.now() - (p.startedAt ?? p.preparedAt);
    if (this.state === "prepared" && elapsed >= 15000)
      throw new Error("native_preparation_timeout");
    if (this.state === "preflight" && elapsed >= 2000) {
      this.reportPreflightFailure(p);
      throw new Error(
        this.retainedMeasurements &&
          (!p.retentionReady[1] || !p.retentionReady[2])
          ? "native_measurement_readiness_timeout"
          : "native_preflight_timeout",
      );
    }
    if (this.state === "native-arming" && this.now() - p.armAt >= 1000)
      throw new Error("native_arm_ack_timeout");
    if (this.nativeVersion === 2) {
      if (this.state === "armed" && this.now() - p.armAt >= 10000)
        throw new Error("native_launch_timeout");
      if (p.assembler?.state === "covered") {
        if (p.coveredAt === undefined) p.coveredAt = this.now();
        if (this.now() - p.coveredAt >= 2000) {
          this.retainJoinFailure(
            p,
            "post-binding",
            "native_post_binding_timeout",
          );
          throw new Error("native_post_binding_timeout");
        }
      }
    }
  }

  tick() {
    if (this.pendingDisarm && this.now() - this.pendingDisarm.at >= 1000)
      this.disarmed(false);
    const p = this.pass;
    if (!p) return;
    p.checkInput = null;
    try {
      this.deadline(p);
      if (this.engine.pass) this.engine.tick();
      this.drain(p);
    } catch (cause) {
      this.fail(p, reasonCode(cause));
    }
  }

  cancel(owner) {
    const p = this.checkOwner(owner);
    this.fail(p, "cancelled", "cancelled");
    return { status: "cancelled" };
  }

  reset(reason = "native_controller_reset", owner) {
    if (owner !== undefined) this.checkOwner(owner);
    if (!/^[a-z][a-z0-9_]{0,127}$/.test(reason))
      reason = "native_controller_reset";
    const p = this.pass;
    if (p) this.fail(p, reason, "cancelled");
  }

  fail(p, reason, status = "failed") {
    if (this.pass !== p || p.closed || p.failing) return;
    p.failing = true;
    this.retainCheckFailure(p, reason);
    if (p.nativeFailureDiagnostic) p.nativeFailureReason = reason;
    try {
      this.settleMeasurements(p, status, reason);
      this.local(p, status === "cancelled" ? "cancelled" : "failed", reason);
    } catch {
      // Diagnostics are not permitted to obstruct cancellation or settlement.
    }
    try {
      if (this.engine.pass) this.engine.terminate(status, reason);
      this.drain(p);
    } catch {
      // A failed consumer must not leave engine state or pending promises alive.
      this.engine.pass = null;
      this.engine.state = status;
    } finally {
      this.close(p, status, reason);
    }
  }

  close(p, status, reason) {
    if (p.closed) return;
    p.closed = true;
    if (this.pass === p) {
      this.pass = null;
      this.state = status;
    }
    const reject = p.reject;
    p.resolve = p.reject = null;
    if (reject)
      reject(
        Object.assign(new Error(reason), {
          ...(p.nativeFailureDiagnostic
            ? { nativeFailureDiagnostic: p.nativeFailureDiagnostic }
            : {}),
        }),
      );
    if (this.nativeVersion === 2 && p.beginAttempted) {
      this.pendingDisarm = {
        generation: p.generation,
        at: this.now(),
        command: p.command,
        cause: p.published ? (p.captureCause ?? p.cause) : p.cause,
        nativeEpoch: p.nativeEpoch ?? 0,
      };
      this.disarmEvent("queued");
      this.disarmEvent("started");
    }
    try {
      if (
        (this.nativeVersion === 1 || p.beginAttempted) &&
        this.send(
          frozen({
            action: "stop",
            generation: p.generation,
            ...(this.retainedMeasurements
              ? { outcome: status === "partial" ? "failed" : status }
              : {}),
          }),
        ) === false
      )
        throw new Error("native_stop_send_failed");
    } catch {
      // Stop is best effort if the native connection has already disappeared.
      try {
        this.local(p, "failed", "native_stop_send_failed");
      } catch {
        // Diagnostics cannot keep the pass alive.
      }
    }
    if (p.assembler) p.assembler.cancel(p.owner);
    p.frames.length = p.post.length = p.events.length = p.envelopes.length = 0;
    p.metadata = {};
    p.spectrum = p.clock = p.launchPacket = null;
    p.lastEnvelope = null;
    p.prelaunchEnvelopes.length = p.prelaunchSpectra.length = 0;
    p.launchPacketStateOnly = null;
    p.configurationReceipt = p.pendingArmAck = null;
    if (p.envelopeWindows) p.envelopeWindows.length = 0;
    if (p.timingWitnesses) p.timingWitnesses = {};
    if (this.nativeVersion === 2) p.anchorClock = null;
    if (this.nativeVersion === 2) {
      p.tempoEvidence = null;
      p.spectrumDiagnostics = null;
    }
    p.before = p.after = p.armed = p.launched = p.spectralWindows = null;
    p.retentionStats = p.retentionReady = p.retentionCauses = {};
    p.retentionRejections = null;
  }

  disarmEvent(stage, reason) {
    const pending = this.pendingDisarm;
    if (!pending) return;
    const eventId = randomUUID();
    const event = {
      type: "native-disarm-stage",
      scope: NATIVE_V2_SCOPE,
      stage,
      eventId,
      generation: pending.generation,
      causationId: pending.cause,
      traceId: pending.command.traceId,
      correlationId: pending.command.correlationId,
      passId: pending.command.passId,
      connectionEpoch: pending.command.connectionEpoch,
      nativeEpoch: pending.nativeEpoch,
      elapsedMs: Math.min(120000, Math.max(0, this.now() - pending.at)),
      frames: 0,
      ...(reason ? { reason } : {}),
    };
    pending.cause = eventId;
    try {
      callback(() => this.observe(frozen(event)), "native_observer_failed");
    } catch {
      pending.observerFailure = "native_disarm_observer_failed";
    }
  }

  disarmed(confirmed, reason = "native_stop_ack_timeout") {
    const pending = this.pendingDisarm;
    if (!pending) return;
    try {
      if (!confirmed) {
        let sent = false;
        try {
          sent =
            this.send(
              frozen({ action: "release", generation: pending.generation }),
            ) === true;
        } catch {
          sent = false;
        }
        if (!sent) this.disarmEvent("progress", "native_release_send_failed");
      }
      this.disarmEvent(
        confirmed ? "completed" : "failed",
        confirmed ? "native_disarm_confirmed" : reason,
      );
    } finally {
      this.pendingDisarm = null;
      callback(
        () =>
          this.onDisarmed(
            frozen({
              generation: pending.generation,
              eventId: pending.cause,
              elapsedMs: checkAge(this.lastDiagnosticNow, pending.at),
              ...(pending.io ? { io: pending.io } : {}),
              confirmed,
              reason:
                pending.observerFailure ??
                (confirmed ? "native_disarm_confirmed" : reason),
            }),
          ),
        "native_disarm_callback_failed",
      );
    }
  }
}

module.exports = {
  NativeCaptureController,
  NATIVE_CAPTURE_SCOPE: SCOPE,
  NATIVE_CAPTURE_SCOPE_V2: NATIVE_V2_SCOPE,
};
