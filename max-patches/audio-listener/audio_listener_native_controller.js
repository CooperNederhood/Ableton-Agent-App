/* global module, require */
"use strict";

const { randomUUID } = require("node:crypto");
const { AudioListenerEngine } = require("./audio_listener_engine.js");
const {
  NativeDescriptorAssembler,
} = require("./audio_listener_native_assembler.js");
const {
  nativeHostBinding,
  NATIVE_V2_SCOPE,
  nativeV2Configuration,
  nativeV2ClockRow,
  nativeV2HostBinding,
  nativeV2RetainTiming,
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
const LENGTHS_V2 = Object.freeze({ ...LENGTHS, config: 7 });
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
function callback(call, reason) {
  try {
    const result = call();
    if (typeof result?.then === "function") throw new Error(reason);
    return result;
  } catch {
    throw new Error(reason);
  }
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
  }) {
    if (![1, 2].includes(nativeVersion))
      throw new Error("invalid_native_version");
    this.nativeVersion = nativeVersion;
    this.listenerId = identifier(listenerId);
    for (const callback of [now, send, onArmed, emit, observe, onDisarmed])
      if (typeof callback !== "function")
        throw new Error("invalid_native_controller_callback");
    this.now = () => {
      const value = callback(now, "native_time_callback_failed");
      if (!Number.isFinite(value) || value < 0)
        throw new Error("invalid_native_time");
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
    this.allocatedEpoch = 0;
    this.engine = new AudioListenerEngine({
      listenerId,
      now: this.now,
      launchAlignment: "signal",
      nativeVersion,
      // Global clock/FFT must not reset when the engine requests analysis.
      analysis: () => {},
      emit: (event) => {
        const p = this.pass;
        if (!p) return;
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
      throw new Error("native_controller_owner_mismatch");
    return p;
  }

  prepare(command) {
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
      events: [],
      rejected: 0,
      held: 0,
      armHeld: 0,
      published: false,
      closed: false,
      assembler: null,
      resolve: null,
      reject: null,
      ...(this.nativeVersion === 2
        ? { timingWitnesses: {}, envelopeWindows: [], tempoEvidence: null }
        : {}),
    };
    this.state = "prepared";
    return {
      status: "ready",
      scope: this.nativeVersion === 2 ? NATIVE_V2_SCOPE : SCOPE,
    };
  }

  local(p, stage, reason) {
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
      this.local(p, "queued");
      if (this.pass !== p) return promise;
      this.local(p, "started");
      if (this.pass !== p) return promise;
      if (this.nativeVersion === 2) p.beginAttempted = true;
      this.control(p, { action: "begin" });
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
    if (!p || packet?.generation !== p.generation || p.closed) return false;
    if (this.state === "prepared") return false;
    try {
      this.deadline(p);
      if (this.pass !== p) return false;
      const type = packet.type;
      const values = packet.values;
      const lengths = this.nativeVersion === 2 ? LENGTHS_V2 : LENGTHS;
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
      else if (type === "envelope") this.envelope(p, v);
      else this.metadata(p, type, v);
      if (this.pass !== p) return false;
      if (this.state === "preflight") this.tryPreflight(p);
      if (this.pass !== p) return false;
      if (p.assembler?.state === "covered" && p.coveredAt === undefined)
        p.coveredAt = this.now();
      this.drain(p);
      return this.pass === p;
    } catch (cause) {
      this.fail(p, reasonCode(cause));
      return false;
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
        const actual = v
          .map((value) =>
            Number.isSafeInteger(value) && value >= 0
              ? String(value)
              : "invalid",
          )
          .join("_");
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
    p.rejected++;
    if (p.rejected > 64) throw new Error("native_preflight_rejection_limit");
    this.local(p, "progress", reason);
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
      return this.rejectBracket(p, "torn_native_clock");
    }
    const previous = p.clock;
    if (previous && row[4] === previous[4]) {
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
        row[2] < previous[2] ||
        row[4] - previous[4] > (p.command.geometry?.sampleRate ?? 48000) ||
        (this.nativeVersion === 2 && row[1] < previous[1]))
    )
      throw new Error("native_clock_discontinuity");
    const phaseOffset =
      (Math.round(row[1] * 24000) - Math.round(row[5] * 24000)) % 24000;
    if (
      this.nativeVersion === 1 &&
      this.state === "capturing" &&
      previous &&
      previous[0] === 1 &&
      row[0] === 1 &&
      row[2] - row[4] - (previous[2] - previous[4]) === 64 &&
      phaseOffset === 64
    )
      return this.rejectBracket(p, "phase_torn_native_clock");
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
      if (p.anchorHostOffset === undefined)
        p.anchorHostOffset = row[2] - row[4];
      if (
        Math.abs(row[2] - row[4] - p.anchorHostOffset) >
        p.command.timingPolicy.maxClockDisagreementSamples
      )
        throw new Error("listening_alignment_budget_exceeded");
      nativeV2RetainTiming(p.timingWitnesses, row, p.command.geometry);
      if (
        this.engine.pass?.startSample !== null &&
        this.engine.pass?.startSample !== undefined
      )
        this.engine.pass.alignment = nativeV2Alignment(
          p.timingWitnesses,
          p.command.geometry,
          p.command.timingPolicy,
          p.anchorHostOffset,
          this.engine.pass.startSample,
        );
    }
    p.clock = row;
    p.clockAt = this.now();
    if (this.state === "preflight") {
      p.frames.push(row);
      if (p.frames.length > 32) {
        if (this.nativeVersion === 2) p.frames.splice(1, 1);
        else p.frames.shift();
      }
      if (
        p.frames.at(-1)[4] - p.frames[0][4] >
        (p.command.geometry?.sampleRate ?? 48000)
      )
        throw new Error("stale_native_preflight");
      return;
    }
    if (this.nativeVersion === 2 && this.engine.pass === null) return;
    this.host(p);
    if (this.engine.pass === null) return;
    const alreadyCovered = p.assembler?.state === "covered";
    if (this.state === "armed" && p.launchPacket) {
      const pending = p.launchPacket;
      this.tryLaunch(p, pending);
      if (this.pass === p && p.assembler) this.envelope(p, pending);
    }
    if (this.pass !== p) return;
    this.flushEnvelopes(p);
    if (this.pass !== p) return;
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

  spectrum(p, v) {
    if (
      !integer(v[0], 2048, 2 ** 44 - 1) ||
      !integer(v[3], 0, 2 ** 44 - 1) ||
      !integer(v[4], 2048, 2 ** 44 - 1) ||
      v[1] < 0 ||
      v[1] > (p.command.geometry?.sampleRate ?? 48000) / 2 ||
      v[2] < 0 ||
      v[2] > Number.MAX_SAFE_INTEGER ||
      (v[2] <= 1e-20 && v[1] !== 0) ||
      !integer(v[5])
    )
      throw new Error("invalid_native_spectrum_packet");
    const previous = p.spectrum;
    if (v[0] !== v[4] || v[0] - v[3] !== 2048) {
      if (
        ["preflight", "native-arming", "armed", "capturing"].includes(
          this.state,
        ) &&
        previous &&
        v[0] === previous[0] &&
        v[3] === previous[0] &&
        v[4] === previous[0] + 2048 &&
        v[5] === previous[5]
      )
        return this.rejectBracket(p, "torn_native_spectrum");
      throw new Error("invalid_native_spectrum_packet");
    }
    if (
      previous &&
      (v[5] !== previous[5] ||
        v[0] < previous[0] ||
        (v[0] - previous[0]) % 2048 !== 0 ||
        (this.state === "capturing" &&
          v[0] !== previous[0] &&
          v[0] - previous[0] !== 2048) ||
        (v[0] === previous[0] &&
          v.some((value, index) => value !== previous[index])))
    )
      throw new Error("changed_native_spectrum_sequence");
    p.spectrum = v;
    p.spectrumAt = this.now();
    if (p.assembler) {
      p.assembler.pushSpectrum(v, p.owner);
      this.flushEnvelopes(p);
    }
  }

  envelope(p, v) {
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
    if (v[13] !== p.armed.armCounter || v[4] !== 0)
      throw new Error("native_envelope_binding_changed");
    if (this.state === "armed") {
      if (v[1] < 0 && v[5] === 0) {
        if (
          RESET_INDICES.some((index, i) => v[index] !== RESET_VALUES[i]) ||
          v[14] !== -1
        )
          throw new Error("changed_native_reset_hold");
        return;
      }
      p.launchPacket = v;
      this.tryLaunch(p, v);
    }
    if (this.pass !== p || !p.assembler) return;
    const origin = p.assembler.originCounter;
    const hop = p.command.geometry?.hopSamples ?? 4800;
    const total = p.command.geometry?.totalSamples ?? 480000;
    if (
      v[1] !== p.launched.launchClock ||
      v[6] !== p.launched.launchPhaseSamples ||
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
    if (v[12] === 0) return;
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
    if (p.assembler.state === "covered") {
      p.assembler.pushEnvelope(packet, p.owner);
      return;
    }
    const fingerprint = JSON.stringify([
      packet.endCounter,
      ...packet.peak,
      ...packet.rms,
    ]);
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
    if (p.envelopes.length >= 8)
      throw new Error("native_envelope_buffer_overflow");
    p.lastEnvelope = { end: packet.endCounter, fingerprint };
    p.envelopes.push(packet);
    if (this.nativeVersion === 2) {
      // Preserve native evidence before descriptor assembly can relabel it.
      p.envelopeWindows.push([packet.endCounter, ...packet.rms]);
    }
    this.flushEnvelopes(p);
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
      if (p.clock[2] < packet.endCounter + p.assembler.hostOffsetSamples)
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
    if (
      p.frames.length !== 32 ||
      p.seenEpoch === undefined ||
      !p.spectrum ||
      Object.keys(LENGTHS)
        .filter(
          (type) =>
            !["clock", "spectrum", "envelope", "ioError"].includes(type),
        )
        .some(
          (type) =>
            !p.metadata[type] ||
            (this.nativeVersion === 2 &&
              this.now() - p.metadata[type].at > 1000),
        ) ||
      this.now() - p.clockAt > 1000 ||
      this.now() - p.spectrumAt > 1000 ||
      this.now() - p.envelopeAt > 1000
    )
      return;
    const last = p.frames.at(-1)[4];
    // FFT and clock arrive independently. Future/old baseline is not failure.
    if (p.spectrum[0] > last || last - p.spectrum[0] >= 2048) return;
    p.before = frozen({ dsp: p.metadata.dsp.values, frames: p.frames });
    if (this.nativeVersion === 2)
      nativeV2HostBinding(
        p.before,
        false,
        p.command.geometry,
        p.command.timingPolicy,
      );
    else nativeHostBinding(p.before, false);
    p.nativeEpoch = Math.max(this.allocatedEpoch, p.seenEpoch) + 1;
    if (p.nativeEpoch > 1000000) throw new Error("native_epoch_exhausted");
    this.allocatedEpoch = p.nativeEpoch;
    p.owner = frozen({
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
    if (this.engine.launchNative(marker, p.command) !== true) return;
    if (this.pass !== p) return;
    const row = p.clock;
    p.launched = frozen({
      ...marker,
      host: { sample: row[2], beat: row[1], flags: row[3], playing: true },
    });
    if (this.nativeVersion === 2)
      this.engine.pass.alignment = nativeV2Alignment(
        p.timingWitnesses,
        p.command.geometry,
        p.command.timingPolicy,
        p.anchorHostOffset,
        this.engine.pass.startSample,
      );
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
        this.engine.ingest(frame, p.command) === true &&
        this.pass === p,
      onFailure: (reason) => this.fail(p, reason),
    });
    if (v[14] !== p.assembler.originCounter)
      throw new Error("native_envelope_origin_changed");
    this.state = "capturing";
    p.launchPacket = null;
    if (p.spectrum && p.spectrum[3] >= p.assembler.originCounter)
      p.assembler.pushSpectrum(p.spectrum, p.owner);
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
    if (this.state === "preflight" && elapsed >= 2000)
      throw new Error("native_preflight_timeout");
    if (this.state === "native-arming" && this.now() - p.armAt >= 1000)
      throw new Error("native_arm_ack_timeout");
    if (this.nativeVersion === 2) {
      if (this.state === "armed" && this.now() - p.armAt >= 10000)
        throw new Error("native_launch_timeout");
      if (p.assembler?.state === "covered") {
        if (p.coveredAt === undefined) p.coveredAt = this.now();
        if (this.now() - p.coveredAt >= 2000)
          throw new Error("native_post_binding_timeout");
      }
    }
  }

  tick() {
    if (this.pendingDisarm && this.now() - this.pendingDisarm.at >= 1000)
      this.disarmed(false);
    const p = this.pass;
    if (!p) return;
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
    try {
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
    if (reject) reject(new Error(reason));
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
        this.send(frozen({ action: "stop", generation: p.generation })) ===
          false
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
    p.configurationReceipt = p.pendingArmAck = null;
    if (p.envelopeWindows) p.envelopeWindows.length = 0;
    if (p.timingWitnesses) p.timingWitnesses = {};
    if (this.nativeVersion === 2) p.tempoEvidence = null;
    p.before = p.after = p.armed = p.launched = p.spectralWindows = null;
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
