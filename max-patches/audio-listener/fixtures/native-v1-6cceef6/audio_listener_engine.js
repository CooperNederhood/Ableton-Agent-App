/* global module, require */
/* Processed descriptors only. Never accepts, retains or writes raw audio. */
"use strict";
const {
  nativeHostBinding,
  nativePreflightTiming,
} = require("./audio_listener_native_coordinates.js");
const { randomUUID } = require("node:crypto");

const ALGORITHM = "native-max-stereo-energy-envelope-rise";
const VERSION = "1.0.1";
const LIMITS = Object.freeze({
  points: 1024,
  attacks: 512,
  watchdogMs: 300000,
  startMs: 15000,
});
const FLOOR_DB = -120;
const FFT_SIZE = 2048;
// plugsync~ validity bits: sample count, PPQ beats, transport state.
const REQUIRED_HOST_FLAGS = 1 | 2 | 16;

function finite(value, name, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isFinite(value) || value < min || value > max)
    throw new Error(`invalid ${name}`);
  return value;
}
function integer(value, name, min = 0, max = Number.MAX_SAFE_INTEGER) {
  finite(value, name, min, max);
  if (!Number.isSafeInteger(value)) throw new Error(`invalid ${name}`);
  return value;
}
function identifier(value, name) {
  if (typeof value !== "string" || !value.trim() || value.length > 128)
    throw new Error(`invalid ${name}`);
  return value;
}
function dbfs(value) {
  finite(value, "amplitude");
  return value <= 10 ** (FLOOR_DB / 20) ? null : 20 * Math.log10(value);
}
function descriptor(value, sampleRate) {
  const allowed = [
    "sample",
    "beat",
    "peak",
    "rms",
    "centroidHz",
    "spectralEnergy",
    "windowSamples",
    "spectralWindow",
  ];
  if (!value || Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error("not a descriptor frame");
  integer(value.sample, "sample");
  finite(value.beat, "beat");
  integer(value.windowSamples, "windowSamples", 1, 65536);
  for (const name of ["peak", "rms"]) {
    if (!Array.isArray(value[name]) || value[name].length !== 2)
      throw new Error(`invalid ${name}`);
    value[name].forEach((x) => finite(x, name, 0, 64));
  }
  for (let i = 0; i < 2; i++)
    if (value.rms[i] > value.peak[i] + 1e-8)
      throw new Error("RMS exceeds peak");
  if (value.centroidHz !== null)
    finite(value.centroidHz, "centroid", 0, sampleRate / 2);
  finite(value.spectralEnergy, "spectralEnergy", 0, 1e20);
  if (value.spectralWindow !== undefined) {
    const window = value.spectralWindow;
    if (
      !window ||
      Object.keys(window).some(
        (key) => !["startSample", "endSample"].includes(key),
      )
    ) {
      throw new Error("invalid spectral window");
    }
    integer(window.startSample, "spectral start");
    integer(window.endSample, "spectral end");
    if (window.endSample - window.startSample !== FFT_SIZE)
      throw new Error("invalid spectral window");
  }
  return value;
}

/** Legacy host-mode runner seam only. Signal mode requires per-pass measurements.
 * No uncalibrated device may advertise ready. Empty production certificate is deliberate.
 */
function timingCertificate(value) {
  if (
    !value ||
    value.validated !== true ||
    value.algorithmVersion !== VERSION ||
    typeof value.hostVersion !== "string" ||
    !value.hostVersion ||
    typeof value.maxVersion !== "string" ||
    !value.maxVersion ||
    value.launchAligned !== true
  )
    throw new Error("real_live_timing_validation_required");
  integer(value.requiredHostFlags, "requiredHostFlags", 1, 0x7fffffff);
  if ((value.requiredHostFlags & REQUIRED_HOST_FLAGS) !== REQUIRED_HOST_FLAGS) {
    throw new Error("real_live_timing_validation_required");
  }
  integer(value.sampleRate, "certificate sampleRate", 8000, 384000);
  integer(value.vectorSize, "certificate vectorSize", 1, 65536);
  integer(value.uncertaintySamples, "uncertaintySamples");
  integer(value.descriptorOffsetSamples, "descriptorOffsetSamples", 0, 65536);
  return Object.freeze({ ...value });
}

class AudioListenerEngine {
  constructor({
    listenerId,
    now = Date.now,
    emit = () => {},
    analysis = () => {},
    certificate = null,
    launchAlignment = "host",
  } = {}) {
    if (!["host", "signal"].includes(launchAlignment))
      throw new Error("invalid launch alignment");
    this.listenerId = identifier(listenerId, "listenerId");
    this.now = now;
    this.emit = emit;
    this.analysis = analysis;
    this.certificate = certificate;
    this.launchAlignment = launchAlignment;
    this.state = "idle";
    this.pass = null;
    this.host = null;
    this.analysis(false, true);
  }

  configureHost(host) {
    integer(host.sampleRate, "sampleRate", 8000, 384000);
    integer(host.vectorSize, "vectorSize", 1, 65536);
    integer(host.sample, "host sample");
    finite(host.beat, "host beat");
    integer(host.flags, "host flags", 0, 0x7fffffff);
    if (typeof host.playing !== "boolean" || typeof host.dspOn !== "boolean")
      throw new Error("invalid host state");
    this.host = { ...host, observedAt: this.now() };
    if (
      this.pass &&
      this.launchAlignment === "signal" &&
      host.tempoBpm !== 120
    ) {
      return this.terminate(
        this.state === "capturing" ? "partial" : "failed",
        "native_tempo_changed",
      );
    }
    if (
      this.pass &&
      this.launchAlignment === "signal" &&
      (host.flags & this.pass.certificate.requiredHostFlags) !==
        this.pass.certificate.requiredHostFlags
    ) {
      return this.terminate(
        this.state === "capturing" ? "partial" : "failed",
        "invalid_host_flags",
      );
    }
    if (
      this.launchAlignment === "signal" &&
      ((this.state === "native-arming" && host.playing) ||
        (["prepared", "native-arming", "armed"].includes(this.state) &&
          !host.playing &&
          host.beat !== 0))
    ) {
      return this.terminate("failed", "native_transport_changed_before_launch");
    }
    if (
      this.pass &&
      (host.sampleRate !== this.pass.sampleRate ||
        host.vectorSize !== this.pass.certificate.vectorSize ||
        !host.dspOn)
    ) {
      return this.terminate("failed", "dsp_changed");
    }
    if (this.state === "armed" && host.playing) {
      if (
        (host.flags & this.pass.certificate.requiredHostFlags) !==
        this.pass.certificate.requiredHostFlags
      ) {
        return this.terminate("failed", "invalid_host_flags");
      }
      if (this.launchAlignment === "signal") return;
      if (host.beat < this.pass.startBeat) return;
      // A calibrated host/descriptor boundary, not arrival-time timestamping.
      if (host.beat > this.pass.startBeat + this.pass.launchToleranceBeats) {
        return this.terminate("failed", "missed_actual_launch_boundary");
      }
      this.pass.startSample = host.sample;
      this.pass.previousHost = host;
      this.state = "capturing";
      this.analysis(true, true);
      this.emit({ type: "state", state: this.state, passId: this.pass.passId });
    } else if (this.state === "capturing") {
      const previous = this.pass.previousHost;
      if (!host.playing) return this.terminate("partial", "transport_stopped");
      if (
        (host.flags & this.pass.certificate.requiredHostFlags) !==
        this.pass.certificate.requiredHostFlags
      ) {
        return this.terminate("partial", "invalid_host_flags");
      }
      if (host.sample < previous.sample || host.beat < previous.beat) {
        return this.terminate("partial", "transport_discontinuity");
      }
      if (
        this.launchAlignment === "signal" &&
        host.sample - Math.round(host.beat * 24000) !== this.pass.startSample
      ) {
        return this.terminate("partial", "native_host_binding_changed");
      }
      this.pass.previousHost = host;
      if (host.beat >= this.pass.endBeat) this.pass.rangeEnded = true;
    }
  }

  prepare(command, nativePreflight) {
    if (this.pass) throw new Error("listener_busy");
    identifier(command.passId, "passId");
    identifier(command.connectionEpoch, "connectionEpoch");
    finite(command.startBeat, "startBeat");
    finite(command.endBeat, "endBeat");
    if (command.endBeat <= command.startBeat)
      throw new Error("invalid capture range");
    const host = this.host;
    if (
      this.launchAlignment === "signal" &&
      (!host ||
        host.sampleRate !== 48000 ||
        host.vectorSize !== 64 ||
        host.tempoBpm !== 120 ||
        host.beat !== 0 ||
        command.mode !== "arrangement" ||
        command.startBeat !== 0 ||
        command.endBeat > 20 ||
        !Number.isInteger(command.endBeat * 5))
    )
      throw new Error("unsupported_native_capture_scope");
    const cert =
      this.launchAlignment === "signal"
        ? nativePreflightTiming(nativePreflight, host)
        : timingCertificate(this.certificate);
    if (
      !host ||
      host.sampleRate !== cert.sampleRate ||
      host.vectorSize !== cert.vectorSize ||
      !host.dspOn ||
      host.playing ||
      this.now() - host.observedAt > 1000 ||
      (host.flags & cert.requiredHostFlags) !== cert.requiredHostFlags
    )
      throw new Error("invalid_host_timing");
    const context =
      this.launchAlignment === "signal"
        ? {
            traceId: identifier(command.traceId, "traceId"),
            correlationId: identifier(command.correlationId, "correlationId"),
            causationId: identifier(command.causationId, "causationId"),
          }
        : null;
    const durationMs = integer(
      command.durationMs ??
        (this.launchAlignment === "signal"
          ? command.endBeat * 500
          : LIMITS.watchdogMs),
      "durationMs",
      1,
      LIMITS.watchdogMs,
    );
    if (
      this.launchAlignment === "signal" &&
      (durationMs < command.endBeat * 500 || durationMs > 10000)
    )
      throw new Error("unsupported_native_capture_duration");
    const settings = command.settings ?? {};
    const threshold = finite(
      settings.attackThresholdDb ?? 6,
      "attack threshold",
      0,
      120,
    );
    const hop = Math.round(host.sampleRate / 10);
    const spacing = integer(
      settings.minAttackSpacingSamples ?? hop,
      "attack spacing",
      hop,
    );
    this.pass = {
      passId: command.passId,
      connectionEpoch: command.connectionEpoch,
      startBeat: command.startBeat,
      endBeat: command.endBeat,
      startSample: null,
      sampleRate: host.sampleRate,
      hop,
      threshold,
      spacing,
      maxWindows: integer(
        command.maxWindows ?? LIMITS.points,
        "maxWindows",
        1,
        LIMITS.points,
      ),
      durationMs,
      launchToleranceBeats: finite(
        command.launchToleranceBeats ?? 0,
        "launch tolerance",
        0,
        0.25,
      ),
      preparedAt: this.now(),
      startedAt: null,
      points: [],
      attacks: [],
      previousFrame: null,
      peak: [0, 0],
      squareSum: [0, 0],
      totalSamples: 0,
      centroidSum: 0,
      energySum: 0,
      originalSamples: 0,
      originalAttacks: 0,
      previousLevel: FLOOR_DB,
      lastAttack: -Infinity,
      riseHasAttack: false,
      certificate: cert,
      ...(this.launchAlignment === "signal"
        ? { nativeFFTGrid: cert.fftGrid }
        : {}),
      context,
      nativeCausationId: context?.causationId,
    };
    this.state = "prepared";
    this.emit({ type: "state", state: "prepared", passId: command.passId });
    return { status: "prepared" };
  }

  arm({ passId, connectionEpoch, nativeEpoch }) {
    this.checkOwner(passId, connectionEpoch);
    if (this.state !== "prepared") throw new Error("not_prepared");
    if (
      !this.host ||
      this.host.playing ||
      !this.host.dspOn ||
      this.now() - this.host.observedAt > 1000 ||
      (this.host.flags & this.pass.certificate.requiredHostFlags) !==
        this.pass.certificate.requiredHostFlags
    ) {
      throw new Error("invalid_host_timing");
    }
    if (this.launchAlignment === "signal") {
      const last = this.pass.certificate.before.frames[31];
      if (
        this.now() - this.pass.preparedAt > 1000 ||
        this.host.sample < last[2] ||
        this.host.sample - last[2] > 48000
      ) {
        throw new Error("stale_native_preflight_before_arm");
      }
      this.pass.nativeEpoch = integer(nativeEpoch, "native epoch", 1, 1000000);
      this.state = "native-arming";
      this.pass.startedAt = this.now();
      this.nativeEvent("queued");
      this.nativeEvent("started");
      this.analysis(true, true, { nativeEpoch });
      return { status: "waiting-native-arm" };
    }
    this.state = "armed";
    this.pass.startedAt = this.now();
    this.analysis(false, true);
    return { status: "ready" };
  }

  nativeEvent(stage, reason) {
    const p = this.pass;
    if (!p?.context) return;
    const eventId = randomUUID();
    this.emit({
      type: "native-capture-stage",
      stage,
      eventId,
      ...p.context,
      causationId: p.nativeCausationId,
      passId: p.passId,
      connectionEpoch: p.connectionEpoch,
      nativeEpoch: p.nativeEpoch ?? 0,
      elapsedMs: Math.max(0, this.now() - (p.startedAt ?? p.preparedAt)),
      frames: p.points.length,
      ...(reason ? { reason } : {}),
    });
    p.nativeCausationId = eventId;
  }

  acknowledgeNativeArm(marker, owner) {
    this.checkOwner(owner.passId, owner.connectionEpoch);
    if (this.launchAlignment !== "signal" || this.state !== "native-arming")
      throw new Error("not_native_arming");
    const p = this.pass;
    if (!marker || marker.nativeEpoch !== p.nativeEpoch)
      throw new Error("native_epoch_mismatch");
    integer(marker.armCounter, "native arm counter", 0, 2 ** 44 - 480001);
    if (
      !marker.hostBinding ||
      Object.keys(marker.hostBinding).some(
        (key) => !["dsp", "frames"].includes(key),
      ) ||
      JSON.stringify(marker.hostBinding.dsp) !==
        JSON.stringify(p.certificate.before.dsp) ||
      JSON.stringify(marker.hostBinding.frames) !==
        JSON.stringify(p.certificate.before.frames)
    ) {
      throw new Error("native_preflight_binding_changed");
    }
    const binding = nativeHostBinding(p.certificate.before, false);
    if (
      marker.armCounter < binding.lastCounter ||
      marker.armCounter - binding.lastCounter > 48000 ||
      this.now() - p.preparedAt > 1000
    )
      throw new Error("stale_native_host_binding");
    if (
      marker.launchClock !== -1 ||
      marker.sourceClock !== -1 ||
      marker.onsetCount !== 0 ||
      marker.rejected !== 0 ||
      marker.active !== 0 ||
      marker.launchPhaseSamples !== -1 ||
      marker.firstSourceClock !== -1 ||
      marker.completedSamples !== 0
    )
      throw new Error("invalid_native_arm_ack");
    if (
      !this.host ||
      this.host.playing ||
      !this.host.dspOn ||
      this.now() - this.host.observedAt > 1000 ||
      (this.host.flags & p.certificate.requiredHostFlags) !==
        p.certificate.requiredHostFlags
    ) {
      return this.terminate("failed", "host_changed_before_native_arm");
    }
    p.nativeArmCounter = marker.armCounter;
    p.nativeHostOffset = binding.hostOffsetSamples;
    this.state = "armed";
    this.nativeEvent("progress", "native_arm_acknowledged");
    return { status: "ready" };
  }

  launchNative(marker, owner) {
    this.checkOwner(owner.passId, owner.connectionEpoch);
    if (this.launchAlignment !== "signal" || this.state !== "armed")
      throw new Error("not_native_armed");
    const p = this.pass;
    if (!marker || marker.nativeEpoch !== p.nativeEpoch)
      throw new Error("native_epoch_mismatch");
    if (marker.armCounter !== p.nativeArmCounter)
      throw new Error("native_arm_counter_changed");
    integer(marker.launchClock, "native launch clock", 0, 480000);
    integer(marker.launchPhaseSamples, "native launch phase", 0, 64);
    const localOrigin = marker.launchClock - marker.launchPhaseSamples;
    if (localOrigin < 0 || marker.rejected !== 0 || marker.active !== 1)
      throw new Error("invalid_native_launch");
    const sample = integer(
      p.nativeArmCounter + localOrigin + p.nativeHostOffset,
      "native origin",
    );
    const host = this.host;
    if (
      !host ||
      !host.dspOn ||
      this.now() - host.observedAt > 1000 ||
      (host.flags & p.certificate.requiredHostFlags) !==
        p.certificate.requiredHostFlags
    ) {
      return this.terminate("failed", "invalid_host_timing");
    }
    if (!host.playing) return false;
    if (
      host.sample - Math.round(host.beat * 24000) !== sample ||
      host.sample < sample ||
      host.sample - sample > p.hop + p.certificate.uncertaintySamples
    ) {
      return this.terminate("failed", "native_launch_binding_mismatch");
    }
    p.startSample = sample;
    p.launchedAt = this.now();
    p.previousHost = host;
    this.state = "capturing";
    this.nativeEvent("progress", "native_launch_observed");
    this.emit({ type: "state", state: this.state, passId: p.passId });
    return true;
  }

  confirmNativeHost(binding, owner) {
    this.checkOwner(owner.passId, owner.connectionEpoch);
    if (this.launchAlignment !== "signal" || this.state !== "capturing")
      throw new Error("not_native_capturing");
    const p = this.pass;
    if (!p.previousFrame || p.previousFrame.beat < p.endBeat)
      throw new Error("native_capture_not_covered");
    const checked = nativeHostBinding(binding, true);
    if (
      checked.hostOffsetSamples !== p.nativeHostOffset ||
      checked.hostBeatZeroSample !== p.startSample ||
      binding.frames[0][4] <
        p.startSample - p.nativeHostOffset + Math.round(p.endBeat * 5) * 4800 ||
      checked.lastCounter <
        p.startSample - p.nativeHostOffset + p.endBeat * 24000 ||
      !this.host ||
      this.now() - this.host.observedAt > 1000 ||
      checked.lastCounter > this.host.sample - p.nativeHostOffset ||
      this.host.sample - p.nativeHostOffset - checked.lastCounter > 48000
    ) {
      throw new Error("invalid_native_post_binding");
    }
    p.nativePostConfirmed = true;
    this.nativeEvent("progress", "native_host_postcheck_complete");
    return true;
  }

  checkOwner(passId, connectionEpoch) {
    if (
      !this.pass ||
      this.pass.passId !== passId ||
      this.pass.connectionEpoch !== connectionEpoch
    ) {
      throw new Error("ownership_mismatch");
    }
  }

  ingest(frame, { passId, connectionEpoch }) {
    this.checkOwner(passId, connectionEpoch);
    if (this.state !== "capturing") return false;
    const p = this.pass;
    if (
      (this.host.flags & p.certificate.requiredHostFlags) !==
      p.certificate.requiredHostFlags
    ) {
      this.terminate("partial", "invalid_host_flags");
      return false;
    }
    const f = descriptor(frame, p.sampleRate);
    if (
      Math.abs(this.host.sample - f.sample) >
      p.certificate.uncertaintySamples + p.hop
    ) {
      this.terminate("partial", "host_sample_discontinuity");
      return false;
    }
    const prev = p.previousFrame;
    if (this.launchAlignment === "signal") {
      const window = f.spectralWindow;
      if (
        !window ||
        window.startSample < p.startSample ||
        window.endSample > f.sample ||
        f.sample - window.endSample >= FFT_SIZE ||
        (p.nativeFFTGrid !== undefined &&
          window.startSample % FFT_SIZE !== p.nativeFFTGrid) ||
        f.beat !== (f.sample - p.startSample) / 24000
      ) {
        this.terminate("partial", "native_descriptor_coordinates");
        return false;
      }
      p.nativeFFTGrid = window.startSample % FFT_SIZE;
      const fingerprint = JSON.stringify([
        f.sample,
        f.beat,
        ...f.peak,
        ...f.rms,
        f.centroidHz,
        f.spectralEnergy,
        f.windowSamples,
        window.startSample,
        window.endSample,
      ]);
      if (
        prev &&
        f.sample === prev.sample &&
        fingerprint !== p.previousNativeFrame
      ) {
        this.terminate("partial", "changed_native_descriptor_hold");
        return false;
      }
      p.previousNativeFrame = fingerprint;
    }
    if (prev && f.sample === prev.sample) return false; // duplicate held native block
    if (
      (prev && (f.sample - prev.sample !== p.hop || f.beat < prev.beat)) ||
      (!prev && f.sample !== p.startSample + p.hop) ||
      f.windowSamples !== p.hop ||
      f.sample - p.hop < p.startSample ||
      f.beat < p.startBeat ||
      f.beat > p.endBeat
    ) {
      this.terminate("partial", "descriptor_gap_or_coordinates");
      return false;
    }
    p.previousFrame = { sample: f.sample, beat: f.beat };
    p.originalSamples++;
    if (p.points.length >= p.maxWindows) {
      this.terminate("partial", "point_limit");
      return false;
    }
    const point = {
      sample: f.sample,
      beat: f.beat,
      peak: [...f.peak],
      rmsDbfs: f.rms.map(dbfs),
      centroidHz: f.spectralEnergy <= 1e-20 ? null : f.centroidHz,
    };
    p.points.push(point);
    for (let c = 0; c < 2; c++) {
      p.peak[c] = Math.max(p.peak[c], f.peak[c]);
      p.squareSum[c] += f.rms[c] ** 2 * f.windowSamples;
    }
    p.totalSamples += f.windowSamples;
    if (point.centroidHz !== null) {
      p.centroidSum += point.centroidHz * f.spectralEnergy;
      p.energySum += f.spectralEnergy;
    }
    const level = Math.max(...point.rmsDbfs.map((x) => x ?? FLOOR_DB));
    const rise = level - p.previousLevel;
    if (rise <= 0) p.riseHasAttack = false;
    if (
      !p.riseHasAttack &&
      level > FLOOR_DB &&
      rise > 0 &&
      rise >= p.threshold &&
      f.sample - p.lastAttack >= p.spacing
    ) {
      p.originalAttacks++;
      if (p.attacks.length >= LIMITS.attacks) {
        this.terminate("partial", "attack_limit");
        return false;
      }
      p.attacks.push({ sample: f.sample, beat: f.beat, strength: rise });
      p.lastAttack = f.sample;
      p.riseHasAttack = true;
    }
    p.previousLevel = level;
    if (this.launchAlignment === "signal" && p.points.length % 10 === 0)
      this.nativeEvent("progress");
    return true;
  }

  tick() {
    if (!this.pass) return;
    if (this.now() - this.pass.preparedAt >= LIMITS.watchdogMs)
      return this.terminate("partial", "watchdog");
    if (
      (this.state === "prepared" ||
        this.state === "armed" ||
        this.state === "native-arming") &&
      this.now() - this.pass.preparedAt >= LIMITS.startMs
    )
      return this.terminate("failed", "launch_timeout");
    if (
      this.launchAlignment === "signal" &&
      this.state === "capturing" &&
      this.now() - this.pass.launchedAt >= this.pass.durationMs + 2000
    ) {
      return this.terminate("partial", "native_capture_timeout");
    }
    if (!this.host || this.now() - this.host.observedAt > 1000)
      this.terminate("partial", "host_timing_stale");
  }

  finish() {
    if (this.state !== "capturing") throw new Error("not_capturing");
    const p = this.pass;
    if (
      this.launchAlignment === "signal" &&
      (!this.host || this.now() - this.host.observedAt > 1000)
    ) {
      return this.terminate("partial", "host_timing_stale");
    }
    if (
      this.launchAlignment === "signal" &&
      p.previousFrame?.beat >= p.endBeat &&
      !p.nativePostConfirmed
    ) {
      return this.terminate("partial", "native_post_binding_required");
    }
    // No missing final windows may silently become complete.
    const covered =
      p.previousFrame &&
      p.previousFrame.beat >= p.endBeat &&
      (this.launchAlignment === "signal"
        ? p.nativePostConfirmed &&
          this.host.playing &&
          this.now() - this.host.observedAt <= 1000 &&
          this.host.sample - Math.round(this.host.beat * 24000) ===
            p.startSample
        : Math.abs(this.host.sample - p.previousFrame.sample) <=
          p.certificate.uncertaintySamples);
    return this.terminate(
      covered ? "complete" : "partial",
      covered ? "range_complete" : "missing_final_window",
    );
  }

  cancel(owner) {
    this.checkOwner(owner.passId, owner.connectionEpoch);
    return this.terminate("cancelled", "cancelled");
  }

  reset(reason = "reset") {
    if (this.pass) return this.terminate("partial", reason);
    this.analysis(false, true);
    this.state = "idle";
    return null;
  }

  terminate(status, reason) {
    const p = this.pass;
    if (!p) return null;
    if (this.launchAlignment === "signal")
      this.nativeEvent(
        status === "complete"
          ? "completed"
          : status === "cancelled"
            ? "cancelled"
            : "failed",
        reason,
      );
    this.analysis(false, true); // mutes native DSP and clears FFT/Gen histories
    const last = p.previousFrame;
    const observation =
      p.startSample === null
        ? null
        : {
            schema: "audio-observation/v1",
            listenerId: this.listenerId,
            passId: p.passId,
            sampleRate: p.sampleRate,
            startSample: p.startSample,
            endSample: last?.sample ?? p.startSample,
            startBeat: p.startBeat,
            endBeat: last?.beat ?? p.startBeat,
            complete: status === "complete",
            limitations: [
              "RMS dBFS is not perceptual LUFS.",
              "Attacks are 100ms envelope-rise estimates, not exact onsets.",
              "Each continuous rise emits at most one attack estimate; a plateau or fall rearms it.",
              "FFT is rectangular 2048-sample non-overlap; stereo complex-bin energies are pooled, never waveforms downmixed.",
              "Spectral points are latest complete FFT frames, not full 100ms spectral averages.",
              `Termination: ${reason}`,
            ],
            algorithm: {
              name: ALGORITHM,
              version: VERSION,
              windowSamples: FFT_SIZE,
              hopSamples: p.hop,
              settings: {
                attackThresholdDb: p.threshold,
                minAttackSpacingSamples: p.spacing,
              },
              units: { amplitude: "linear", rms: "dBFS", centroid: "Hz" },
              timingUncertaintySamples: p.certificate.uncertaintySamples,
            },
            summaries: {
              peak: p.peak,
              rmsDbfs: p.squareSum.map((sum) =>
                dbfs(p.totalSamples ? Math.sqrt(sum / p.totalSamples) : 0),
              ),
              centroidHz: p.energySum ? p.centroidSum / p.energySum : null,
            },
            samples: p.points,
            attacks: p.attacks,
            reduction: {
              originalSamples: p.originalSamples,
              originalAttacks: p.originalAttacks,
              truncated:
                p.originalSamples !== p.points.length ||
                p.originalAttacks !== p.attacks.length,
            },
          };
    this.pass = null;
    this.state = status;
    const result = {
      type: "terminal",
      status,
      reason,
      passId: p.passId,
      observation,
    };
    this.emit(result);
    return result;
  }
}

module.exports = {
  AudioListenerEngine,
  ALGORITHM,
  VERSION,
  LIMITS,
  FLOOR_DB,
  FFT_SIZE,
  dbfs,
  descriptor,
  timingCertificate,
};
