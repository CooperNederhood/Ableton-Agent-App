/* global module */
"use strict";

const MAX_COUNTER = 2 ** 44;
const HOP = 4800;
const FFT = 2048;

function integer(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function stereo(value) {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    Number.isFinite(value[0]) &&
    value[0] >= 0 &&
    value[0] <= 64 &&
    Number.isFinite(value[1]) &&
    value[1] >= 0 &&
    value[1] <= 64
  );
}

/** Internal processed packets, not a physical Max wire ABI or readiness API. */
class NativeDescriptorAssembler {
  constructor({
    owner,
    armCounter,
    originCounter,
    hostOffsetSamples,
    windows,
    geometry,
    coordinates,
    invalidFrames,
    onFrame,
    onFailure,
  }) {
    // Explicit geometry is internal only; it does not qualify a native producer.
    const explicit = geometry !== undefined;
    if (
      explicit &&
      (!geometry ||
        typeof geometry !== "object" ||
        Array.isArray(geometry) ||
        Object.keys(geometry).length !== 3 ||
        Object.keys(geometry).some(
          (key) => !["sampleRate", "hopSamples", "totalSamples"].includes(key),
        ) ||
        ![44100, 48000].includes(geometry.sampleRate) ||
        geometry.hopSamples !== Math.round(geometry.sampleRate / 10) ||
        !integer(
          geometry.totalSamples,
          geometry.hopSamples,
          30 * geometry.sampleRate,
        ))
    )
      throw new Error("invalid_native_assembler_configuration");
    if (
      coordinates !== undefined &&
      (!explicit ||
        !coordinates ||
        typeof coordinates !== "object" ||
        Array.isArray(coordinates) ||
        Object.keys(coordinates).length !== 2 ||
        Object.keys(coordinates).some(
          (key) => !["startBeat", "tempoBpm"].includes(key),
        ) ||
        !Number.isFinite(coordinates.startBeat) ||
        coordinates.startBeat < 0 ||
        coordinates.startBeat > 1576800 ||
        !Number.isFinite(coordinates.tempoBpm) ||
        coordinates.tempoBpm < 20 ||
        coordinates.tempoBpm > 999)
    )
      throw new Error("invalid_native_assembler_configuration");
    const sampleRate = explicit ? geometry.sampleRate : 48000;
    const hopSamples = explicit ? geometry.hopSamples : HOP;
    const totalSamples = explicit ? geometry.totalSamples : windows * HOP;
    const expectedWindows = Math.ceil(totalSamples / hopSamples);
    if (explicit && windows === undefined) windows = expectedWindows;
    if (
      !owner ||
      typeof owner.passId !== "string" ||
      !owner.passId ||
      owner.passId.length > 128 ||
      typeof owner.connectionEpoch !== "string" ||
      !owner.connectionEpoch ||
      owner.connectionEpoch.length > 128 ||
      !integer(owner.nativeEpoch, 1, 1000000) ||
      !integer(armCounter, 0, MAX_COUNTER - 1) ||
      !integer(originCounter, armCounter, armCounter + 10 * sampleRate) ||
      !Number.isSafeInteger(hostOffsetSamples) ||
      !integer(windows, 1, explicit ? 300 : 100) ||
      windows !== expectedWindows ||
      originCounter + totalSamples >= MAX_COUNTER ||
      !integer(originCounter + hostOffsetSamples, 0, Number.MAX_SAFE_INTEGER) ||
      !integer(
        originCounter + hostOffsetSamples + totalSamples,
        0,
        Number.MAX_SAFE_INTEGER,
      ) ||
      !integer(invalidFrames, 0, Number.MAX_SAFE_INTEGER) ||
      typeof onFrame !== "function" ||
      typeof onFailure !== "function"
    )
      throw new Error("invalid_native_assembler_configuration");
    this.owner = Object.freeze({
      passId: owner.passId,
      connectionEpoch: owner.connectionEpoch,
      nativeEpoch: owner.nativeEpoch,
    });
    this.armCounter = armCounter;
    this.originCounter = originCounter;
    this.hostOffsetSamples = hostOffsetSamples;
    this.windows = windows;
    this.sampleRate = sampleRate;
    this.hopSamples = hopSamples;
    this.totalSamples = totalSamples;
    this.startBeat = coordinates?.startBeat ?? 0;
    this.tempoBpm = coordinates?.tempoBpm ?? 120;
    this.invalidFrames = invalidFrames;
    this.onFrame = onFrame;
    this.onFailure = onFailure;
    this.state = "capturing";
    this.frames = 0;
    this.pending = [];
    this.spectra = [];
    this.intervals = [];
    this.lastEnvelope = null;
    this.lastSpectrum = null;
  }

  checkOwner(owner, allowClosed = false) {
    if (
      !owner ||
      owner.passId !== this.owner.passId ||
      owner.connectionEpoch !== this.owner.connectionEpoch ||
      owner.nativeEpoch !== this.owner.nativeEpoch
    )
      throw new Error("native_assembler_owner_mismatch");
    if (!allowClosed && (this.state === "failed" || this.state === "cancelled"))
      throw new Error("native_assembler_closed");
  }

  clear() {
    this.pending.length = 0;
    this.spectra.length = 0;
  }

  abort(reason) {
    this.state = "failed";
    this.clear();
    this.intervals.length = 0;
    this.lastEnvelope = null;
    this.lastSpectrum = null;
    this.onFailure(reason, this.owner);
  }

  reject(reason) {
    this.abort(reason);
    throw new Error(reason);
  }

  pushEnvelope(packet, owner) {
    this.checkOwner(owner);
    if (
      !packet ||
      Object.keys(packet).some(
        (key) =>
          ![
            "nativeEpoch",
            "armCounter",
            "originCounter",
            "endCounter",
            "peak",
            "rms",
          ].includes(key),
      ) ||
      packet.nativeEpoch !== this.owner.nativeEpoch ||
      packet.armCounter !== this.armCounter ||
      packet.originCounter !== this.originCounter ||
      !integer(
        packet.endCounter,
        this.originCounter + this.hopSamples,
        MAX_COUNTER - 1,
      ) ||
      !stereo(packet.peak) ||
      !stereo(packet.rms) ||
      packet.rms.some((value, index) => value > packet.peak[index] + 1e-8)
    )
      return this.reject("invalid_native_envelope_packet");
    const fingerprint = JSON.stringify([
      packet.endCounter,
      ...packet.peak,
      ...packet.rms,
    ]);
    if (this.lastEnvelope && packet.endCounter === this.lastEnvelope.end) {
      if (fingerprint !== this.lastEnvelope.fingerprint)
        return this.reject("changed_native_envelope_hold");
      return false;
    }
    if (this.state === "covered") {
      if (
        packet.endCounter < this.lastEnvelope.end ||
        (packet.endCounter - this.originCounter) % this.hopSamples !== 0
      )
        return this.reject("native_envelope_sequence_gap");
      return false;
    }
    if (packet.endCounter > this.originCounter + this.totalSamples)
      return this.reject("native_envelope_outside_range");
    const previous = this.lastEnvelope?.end ?? this.originCounter;
    if (
      packet.endCounter !==
      Math.min(
        previous + this.hopSamples,
        this.originCounter + this.totalSamples,
      )
    )
      return this.reject("native_envelope_sequence_gap");
    if (this.pending.length >= 8)
      return this.reject("native_envelope_buffer_overflow");
    this.lastEnvelope = { end: packet.endCounter, fingerprint };
    this.pending.push({
      end: packet.endCounter,
      windowSamples: packet.endCounter - previous,
      peak: [...packet.peak],
      rms: [...packet.rms],
    });
    this.drain();
    return true;
  }

  pushSpectrum(packet, owner) {
    this.checkOwner(owner);
    if (
      !Array.isArray(packet) ||
      packet.length !== 6 ||
      !integer(packet[0], FFT, MAX_COUNTER - 1) ||
      !Number.isFinite(packet[1]) ||
      packet[1] < 0 ||
      packet[1] > this.sampleRate / 2 ||
      !Number.isFinite(packet[2]) ||
      packet[2] < 0 ||
      packet[2] > Number.MAX_SAFE_INTEGER ||
      !integer(packet[3], 0, MAX_COUNTER - 1) ||
      packet[0] !== packet[4] ||
      packet[0] - packet[3] !== FFT ||
      packet[5] !== this.invalidFrames ||
      (packet[2] <= 1e-20 && packet[1] !== 0)
    )
      return this.reject("invalid_native_spectrum_packet");
    const fingerprint = JSON.stringify(packet);
    if (this.lastSpectrum && packet[0] === this.lastSpectrum.end) {
      if (fingerprint !== this.lastSpectrum.fingerprint)
        return this.reject("changed_native_spectrum_hold");
      return false;
    }
    if (
      this.lastSpectrum &&
      (packet[0] < this.lastSpectrum.end ||
        (packet[0] - this.lastSpectrum.end) % FFT !== 0)
    )
      return this.reject("native_spectrum_grid_or_order");
    this.lastSpectrum = { end: packet[0], fingerprint };
    if (this.state === "covered") return false;
    if (this.spectra.length >= 128)
      return this.reject("native_spectrum_buffer_overflow");
    this.spectra.push({
      start: packet[3],
      end: packet[0],
      centroidHz: packet[1],
      energy: packet[2],
    });
    this.drain();
    return true;
  }

  drain() {
    while (this.pending.length && this.state === "capturing") {
      const envelope = this.pending[0];
      let spectrum;
      for (const candidate of this.spectra) {
        if (candidate.end > envelope.end) break;
        spectrum = candidate;
      }
      if (!spectrum || envelope.end - spectrum.end >= FFT) {
        if (this.lastSpectrum && this.lastSpectrum.end > envelope.end)
          return this.reject("native_fft_window_missing");
        return;
      }
      if (spectrum.start < this.originCounter)
        return this.reject("native_fft_window_before_origin");
      const offset = this.hostOffsetSamples;
      const interval = [
        spectrum.start + offset,
        spectrum.end + offset,
        spectrum.centroidHz,
        spectrum.energy,
      ];
      const frame = {
        sample: envelope.end + offset,
        beat:
          this.startBeat +
          (envelope.end - this.originCounter) /
            ((this.sampleRate * 60) / this.tempoBpm),
        peak: [...envelope.peak],
        rms: [...envelope.rms],
        centroidHz: spectrum.centroidHz,
        spectralEnergy: spectrum.energy,
        windowSamples: envelope.windowSamples,
        spectralWindow: { startSample: interval[0], endSample: interval[1] },
      };
      let accepted;
      try {
        accepted = this.onFrame(frame, this.owner);
      } catch (cause) {
        if (this.state === "capturing")
          this.abort("native_descriptor_consumer_failed");
        throw cause;
      }
      if (this.state !== "capturing") return;
      if (accepted !== true) return this.reject("native_descriptor_rejected");
      this.pending.shift();
      this.intervals.push(interval);
      this.frames++;
      const remaining = this.originCounter + this.totalSamples - envelope.end;
      // A short final envelope may share the preceding complete FFT window.
      this.spectra = this.spectra.filter(
        (candidate) =>
          candidate.end > envelope.end ||
          (remaining > 0 &&
            remaining < this.hopSamples &&
            candidate === spectrum),
      );
      if (this.frames === this.windows) {
        this.state = "covered";
        this.clear();
      }
    }
  }

  spectralWindows(owner) {
    this.checkOwner(owner);
    if (this.state !== "covered")
      throw new Error("native_descriptor_coverage_required");
    return this.intervals.map((window) => [...window]);
  }

  cancel(owner) {
    this.checkOwner(owner, true);
    if (this.state !== "failed") this.state = "cancelled";
    this.clear();
    this.intervals.length = 0;
    this.lastEnvelope = null;
    this.lastSpectrum = null;
  }
}

module.exports = { NativeDescriptorAssembler };
