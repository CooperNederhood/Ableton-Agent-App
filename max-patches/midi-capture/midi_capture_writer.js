const fs = require("node:fs");
const path = require("node:path");

const NOTE_NAMES = [
  "C",
  "C#",
  "D",
  "D#",
  "E",
  "F",
  "F#",
  "G",
  "G#",
  "A",
  "A#",
  "B",
];

function pitchName(pitch) {
  return `${NOTE_NAMES[pitch % 12]}${Math.floor(pitch / 12) - 1}`;
}

function noteKey(channel, pitch) {
  return `${channel}:${pitch}`;
}

function normalizeOutputPath(filePath) {
  const raw = String(filePath).trim();
  const volumePrefixed = raw.match(/^[^/:]+:(\/.*)$/);
  return path.resolve(volumePrefixed ? volumePrefixed[1] : raw);
}

class MidiCaptureEngine {
  constructor({ onSample = () => {}, onStatus = () => {} } = {}) {
    this.onSample = onSample;
    this.onStatus = onStatus;
    this.ppq = 480;
    this.sampleBeats = 4;
    this.pendingSampleBeats = null;
    this.captureEnabled = false;
    this.transportRunning = false;
    this.currentWindow = null;
    this.activeNotes = new Map();
    this.sampleIndex = 0;
    this.lastEventSequence = -1;
    this.context = { tempoBpm: null, timeSignature: null };
  }

  configure(ppq, sampleBeats) {
    if (Number.isFinite(ppq) && ppq > 0) {
      this.ppq = Math.round(ppq);
    }
    this.setSampleBeats(sampleBeats);
  }

  setSampleBeats(value) {
    const beats = Number(value);
    if (!Number.isFinite(beats) || beats < 0.25 || beats > 64) {
      this.onStatus("error", `invalid_sample_beats ${value}`);
      return false;
    }
    if (this.currentWindow) {
      this.pendingSampleBeats = beats;
    } else {
      this.sampleBeats = beats;
    }
    return true;
  }

  setContext(tempoBpm, numerator, denominator) {
    this.context = {
      tempoBpm: Number.isFinite(Number(tempoBpm)) ? Number(tempoBpm) : null,
      timeSignature:
        Number.isFinite(Number(numerator)) &&
        Number.isFinite(Number(denominator))
          ? [Number(numerator), Number(denominator)]
          : null,
    };
  }

  setCapture(enabled, tick) {
    const next = Boolean(Number(enabled));
    if (next === this.captureEnabled) {
      return;
    }
    if (!next) {
      this.finishPartial(Number(tick), "capture_disabled");
      this.activeNotes.clear();
    }
    this.captureEnabled = next;
    this.onStatus("capture", next ? "enabled" : "disabled");
  }

  setTransport(running, tick) {
    const next = Boolean(Number(running));
    if (next === this.transportRunning) {
      return;
    }
    if (!next) {
      this.finishPartial(Number(tick), "transport_stop");
      this.activeNotes.clear();
    }
    this.transportRunning = next;
    this.onStatus("transport", next ? "running" : "stopped");
  }

  event(channel, pitch, velocity, isNoteOn, tick, sequence) {
    if (!this.captureEnabled || !this.transportRunning) {
      return;
    }

    const eventSequence = Number(sequence);
    if (
      Number.isFinite(eventSequence) &&
      this.lastEventSequence >= 0 &&
      eventSequence !== this.lastEventSequence + 1
    ) {
      this.onStatus(
        "warning",
        `event_sequence_gap ${this.lastEventSequence} ${eventSequence}`,
      );
    }
    if (Number.isFinite(eventSequence)) {
      this.lastEventSequence = eventSequence;
    }

    const normalized = {
      channel: Number(channel),
      pitch: Number(pitch),
      velocity: Number(velocity),
      tick: Number(tick),
    };
    if (
      !Number.isInteger(normalized.channel) ||
      normalized.channel < 1 ||
      normalized.channel > 16 ||
      !Number.isInteger(normalized.pitch) ||
      normalized.pitch < 0 ||
      normalized.pitch > 127 ||
      !Number.isInteger(normalized.velocity) ||
      normalized.velocity < 0 ||
      normalized.velocity > 127 ||
      !Number.isFinite(normalized.tick)
    ) {
      this.onStatus("error", "invalid_note_event");
      return;
    }

    const key = noteKey(normalized.channel, normalized.pitch);
    if (Boolean(Number(isNoteOn)) && normalized.velocity > 0) {
      const queue = this.activeNotes.get(key) || [];
      queue.push({
        ...normalized,
        segmentStart: this.currentWindow ? normalized.tick : null,
        continued: false,
      });
      this.activeNotes.set(key, queue);
      return;
    }

    const queue = this.activeNotes.get(key);
    if (!queue || queue.length === 0) {
      this.onStatus("warning", `unmatched_note_off ${key}`);
      return;
    }

    const note = queue.shift();
    if (queue.length === 0) {
      this.activeNotes.delete(key);
    }
    if (this.currentWindow && note.segmentStart !== null) {
      this.addNoteSegment(note, normalized.tick, false);
    }
  }

  boundary(tick) {
    const boundaryTick = Number(tick);
    if (
      !this.captureEnabled ||
      !this.transportRunning ||
      !Number.isFinite(boundaryTick)
    ) {
      return;
    }

    if (!this.currentWindow) {
      this.startWindow(boundaryTick);
      return;
    }

    const expectedTick =
      this.currentWindow.startTick +
      Math.round(this.currentWindow.sampleBeats * this.ppq);
    const reason =
      boundaryTick === expectedTick ? "boundary" : "transport_discontinuity";
    this.finishWindow(boundaryTick, reason === "boundary", reason);
    this.applyPendingSampleBeats();
    this.startWindow(boundaryTick);
  }

  startWindow(tick) {
    this.currentWindow = {
      startTick: tick,
      sampleBeats: this.sampleBeats,
      notes: [],
      tempoBpm: this.context.tempoBpm,
      timeSignature: this.context.timeSignature,
    };
    for (const queue of this.activeNotes.values()) {
      for (const note of queue) {
        note.segmentStart = tick;
        note.continued = true;
      }
    }
  }

  addNoteSegment(note, endTick, continuesIntoNext) {
    const startTick = Math.max(note.segmentStart, this.currentWindow.startTick);
    const safeEndTick = Math.max(startTick, endTick);
    this.currentWindow.notes.push({
      channel: note.channel,
      pitch: note.pitch,
      name: pitchName(note.pitch),
      velocity: note.velocity,
      onset_beats: (startTick - this.currentWindow.startTick) / this.ppq,
      duration_beats: (safeEndTick - startTick) / this.ppq,
      continued_from_previous: note.continued,
      continues_into_next: continuesIntoNext,
    });
  }

  finishWindow(endTick, complete, endReason) {
    if (!this.currentWindow || !Number.isFinite(endTick)) {
      return;
    }
    if (endTick < this.currentWindow.startTick) {
      this.onStatus("warning", "transport_moved_backwards");
      this.currentWindow = null;
      this.activeNotes.clear();
      return;
    }

    for (const queue of this.activeNotes.values()) {
      for (const note of queue) {
        if (note.segmentStart !== null) {
          this.addNoteSegment(note, endTick, true);
          note.segmentStart = endTick;
          note.continued = true;
        }
      }
    }

    const startTick = this.currentWindow.startTick;
    const sample = {
      schema: "midi-sample/v1",
      sample_index: this.sampleIndex,
      complete,
      end_reason: endReason,
      start_tick: startTick,
      end_tick: endTick,
      ppq: this.ppq,
      start_beat: startTick / this.ppq,
      end_beat: endTick / this.ppq,
      length_beats: (endTick - startTick) / this.ppq,
      tempo_bpm_at_start: this.currentWindow.tempoBpm,
      time_signature_at_start: this.currentWindow.timeSignature,
      notes: this.currentWindow.notes.sort(
        (a, b) =>
          a.onset_beats - b.onset_beats ||
          a.channel - b.channel ||
          a.pitch - b.pitch,
      ),
    };
    this.sampleIndex += 1;
    this.currentWindow = null;
    this.onSample(sample);
  }

  finishPartial(tick, reason) {
    if (!this.currentWindow || !Number.isFinite(tick)) {
      this.currentWindow = null;
      return;
    }
    if (tick > this.currentWindow.startTick) {
      this.finishWindow(tick, false, reason);
    } else {
      this.currentWindow = null;
    }
    this.applyPendingSampleBeats();
  }

  applyPendingSampleBeats() {
    if (this.pendingSampleBeats !== null) {
      this.sampleBeats = this.pendingSampleBeats;
      this.pendingSampleBeats = null;
    }
  }
}

class JsonlWriter {
  constructor(onStatus = () => {}) {
    this.onStatus = onStatus;
    this.filePath = null;
    this.queue = Promise.resolve();
    this.failed = false;
  }

  async setPath(filePath) {
    const resolved = normalizeOutputPath(filePath);
    const handle = await fs.promises.open(resolved, "a");
    await handle.close();
    this.filePath = resolved;
    this.failed = false;
    this.onStatus("path_ready", resolved);
    return resolved;
  }

  append(sample) {
    if (!this.filePath || this.failed) {
      this.onStatus("error", "writer_not_ready");
      return;
    }
    const line = `${JSON.stringify(sample)}\n`;
    this.queue = this.queue
      .then(() => fs.promises.appendFile(this.filePath, line, "utf8"))
      .then(() => this.onStatus("sample_written", sample.sample_index))
      .catch((error) => {
        this.failed = true;
        this.onStatus("error", `write_failed ${error.message}`);
      });
  }
}

function startMaxRuntime() {
  const maxApi = require("max-api");
  const status = (...items) => maxApi.outlet(["status", ...items]);
  const writer = new JsonlWriter(status);
  const engine = new MidiCaptureEngine({
    onSample: (sample) => writer.append(sample),
    onStatus: status,
  });

  maxApi.addHandler("path", async (...parts) => {
    try {
      await writer.setPath(parts.join(" "));
    } catch (error) {
      status("error", `path_failed ${error.message}`);
    }
  });
  maxApi.addHandler("configure", (ppq, beats) => engine.configure(ppq, beats));
  maxApi.addHandler("sample_beats", (beats) => engine.setSampleBeats(beats));
  maxApi.addHandler("context", (tempo, numerator, denominator) =>
    engine.setContext(tempo, numerator, denominator),
  );
  maxApi.addHandler("capture", (enabled, tick) =>
    engine.setCapture(enabled, tick),
  );
  maxApi.addHandler("transport", (running, tick) =>
    engine.setTransport(running, tick),
  );
  maxApi.addHandler("boundary", (tick) => engine.boundary(tick));
  maxApi.addHandler(
    "event",
    (channel, pitch, velocity, isNoteOn, tick, sequence) =>
      engine.event(channel, pitch, velocity, isNoteOn, tick, sequence),
  );
  status("ready");
}

if (process.env.MAX_ENV) {
  startMaxRuntime();
}

module.exports = {
  JsonlWriter,
  MidiCaptureEngine,
  normalizeOutputPath,
  pitchName,
};
