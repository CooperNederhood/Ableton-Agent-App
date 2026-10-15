/* global module, require */
"use strict";

const { randomUUID } = require("node:crypto");
const { AudioListenerEngine } = require("./audio_listener_engine.js");
const {
  NativeDescriptorAssembler,
} = require("./audio_listener_native_assembler.js");
const { nativeHostBinding } = require("./audio_listener_native_coordinates.js");

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
function commandScope(command) {
  const result = {};
  for (const key of [
    "passId",
    "connectionEpoch",
    "traceId",
    "correlationId",
    "causationId",
  ])
    result[key] = identifier(command?.[key]);
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
  }) {
    this.listenerId = identifier(listenerId);
    for (const callback of [now, send, onArmed, emit, observe])
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
    this.pass = null;
    this.state = "idle";
    this.allocatedEpoch = 0;
    this.engine = new AudioListenerEngine({
      listenerId,
      now: this.now,
      launchAlignment: "signal",
      // Global clock/FFT must not reset when the engine requests analysis.
      analysis: () => {},
      emit: (event) => {
        const p = this.pass;
        if (!p) return;
        if (p.events.length >= 32)
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
    if (this.pass) throw new Error("listener_busy");
    const bounded = commandScope(command);
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
    };
    this.state = "prepared";
    return { status: "ready", scope: SCOPE };
  }

  local(p, stage, reason) {
    const eventId = randomUUID();
    const event = frozen({
      type: "native-preflight-stage",
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
    const p = this.pass;
    if (!p || packet?.generation !== p.generation || p.closed) return false;
    if (this.state === "prepared") return false;
    try {
      this.deadline(p);
      if (this.pass !== p) return false;
      const type = packet.type;
      const values = packet.values;
      if (
        Object.keys(packet).some(
          (key) => !["generation", "type", "values"].includes(key),
        ) ||
        typeof type !== "string" ||
        !Object.prototype.hasOwnProperty.call(LENGTHS, type) ||
        !Array.isArray(values) ||
        values.length !== LENGTHS[type] ||
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
      this.drain(p);
      return this.pass === p;
    } catch (cause) {
      this.fail(p, reasonCode(cause));
      return false;
    }
  }

  metadata(p, type, v) {
    const expected =
      type === "dsp"
        ? [1, 48000, 64]
        : type === "tempo"
          ? [120]
          : type === "fftInfo"
            ? [2048, 2048, 2048, 1]
            : [1];
    if (v.some((value, index) => value !== expected[index]))
      throw new Error("native_metadata_changed");
    p.metadata[type] = { values: v };
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
        row[4] - previous[4] > 48000)
    )
      throw new Error("native_clock_discontinuity");
    const phaseOffset =
      (Math.round(row[1] * 24000) - Math.round(row[5] * 24000)) % 24000;
    if (
      this.state === "capturing" &&
      previous &&
      previous[0] === 1 &&
      row[0] === 1 &&
      row[2] - row[4] - (previous[2] - previous[4]) === 64 &&
      phaseOffset === 64
    )
      return this.rejectBracket(p, "phase_torn_native_clock");
    if (previous && row[2] - row[4] !== previous[2] - previous[4]) {
      if (this.state !== "preflight")
        throw new Error("native_clock_discontinuity");
      p.frames.length = 0;
      this.rejectBracket(p, "native_preflight_binding_restart");
      if (this.pass !== p) return;
    }
    if (
      this.state === "preflight" &&
      (row[0] !== 0 || row[1] !== 0 || (previous && row[5] !== previous[5]))
    )
      throw new Error("native_transport_changed_before_launch");
    if (row[0] === 1 && phaseOffset !== 0)
      throw new Error("native_host_phase_changed");
    p.clock = row;
    p.clockAt = this.now();
    if (this.state === "preflight") {
      p.frames.push(row);
      if (p.frames.length > 32) p.frames.shift();
      if (p.frames.at(-1)[4] - p.frames[0][4] > 48000)
        throw new Error("stale_native_preflight");
      return;
    }
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
      const end = p.assembler.originCounter + p.command.endBeat * 24000;
      if (row[0] !== 1 || row[4] < end) return;
      if (row[4] - end > 48000) throw new Error("stale_native_post_binding");
      if (p.post.length >= 32) throw new Error("native_post_buffer_overflow");
      p.post.push(row);
      if (p.post.length === 32) {
        p.after = frozen({ dsp: [1, 48000, 64], frames: p.post });
        this.engine.confirmNativeHost(p.after, p.command);
        p.spectralWindows = p.assembler.spectralWindows(p.owner);
        this.engine.finish();
      }
    }
  }

  host(p) {
    const row = p.clock;
    this.engine.configureHost({
      sampleRate: 48000,
      vectorSize: 64,
      tempoBpm: 120,
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
      v[1] > 24000 ||
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
    if (!integer(v[0], 0, 1000000) || v[15] !== 1)
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
        scope: SCOPE,
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
    if (
      v[1] !== p.launched.launchClock ||
      v[6] !== p.launched.launchPhaseSamples ||
      v[14] !== origin ||
      (v[5] !== 1 && !(v[5] === 0 && v[12] === 480000)) ||
      !integer(v[3]) ||
      !integer(v[12], 0, 480000) ||
      v[12] % 4800 !== 0
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
      endCounter: origin + v[12],
      peak: v.slice(8, 10),
      rms: v.slice(10, 12),
    };
    if (
      !integer(packet.endCounter, origin + 4800, 2 ** 44 - 1) ||
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
      packet.endCounter !== (p.lastEnvelope?.end ?? origin) + 4800 ||
      packet.endCounter > origin + p.assembler.windows * 4800
    )
      throw new Error("native_envelope_sequence_gap");
    if (p.envelopes.length >= 8)
      throw new Error("native_envelope_buffer_overflow");
    p.lastEnvelope = { end: packet.endCounter, fingerprint };
    p.envelopes.push(packet);
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
        .some((type) => !p.metadata[type]) ||
      this.now() - p.clockAt > 1000 ||
      this.now() - p.spectrumAt > 1000 ||
      this.now() - p.envelopeAt > 1000
    )
      return;
    const last = p.frames.at(-1)[4];
    // FFT and clock arrive independently. Future/old baseline is not failure.
    if (p.spectrum[0] > last || last - p.spectrum[0] >= 2048) return;
    p.before = frozen({ dsp: [1, 48000, 64], frames: p.frames });
    nativeHostBinding(p.before, false);
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
    p.assembler = new NativeDescriptorAssembler({
      owner: p.owner,
      armCounter: v[13],
      originCounter: v[13] + v[1] - v[6],
      hostOffsetSamples: this.engine.pass.nativeHostOffset,
      windows: p.command.endBeat * 5,
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
  }

  tick() {
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
    try {
      if (
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
    p.before = p.after = p.armed = p.launched = p.spectralWindows = null;
  }
}

module.exports = { NativeCaptureController, NATIVE_CAPTURE_SCOPE: SCOPE };
