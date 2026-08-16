const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");

const {
  JsonlWriter,
  MidiCaptureEngine,
  normalizeOutputPath,
  parseIdentity,
  pitchName,
  startMaxRuntime,
} = require("./midi_capture_writer.js");

const parserModule = { exports: {} };
const parserSource = fs.readFileSync(
  path.join(__dirname, "midi_note_parser.js"),
  "utf8",
);
vm.runInNewContext(parserSource, {
  module: parserModule,
  isFinite,
  Number,
});
const { MidiNoteParser } = parserModule.exports;

function createEngine(sampleBeats = 4) {
  const samples = [];
  const statuses = [];
  const engine = new MidiCaptureEngine({
    onSample: (sample) => samples.push(sample),
    onStatus: (...status) => statuses.push(status),
  });
  engine.configure(480, sampleBeats);
  engine.setCapture(1, 0);
  engine.setTransport(1, 0);
  return { engine, samples, statuses };
}

test("raw parser handles running status and velocity-zero note-off", () => {
  const parser = new MidiNoteParser();
  assert.equal(parser.consume(0x91), null);
  assert.equal(parser.consume(60), null);
  assert.deepEqual(Array.from(parser.consume(100)), [2, 60, 100, 1, 0]);
  assert.equal(parser.consume(62), null);
  assert.deepEqual(Array.from(parser.consume(0)), [2, 62, 0, 0, 1]);
});

test("raw parser ignores realtime bytes without disrupting a note", () => {
  const parser = new MidiNoteParser();
  parser.consume(0x90);
  parser.consume(64);
  assert.equal(parser.consume(0xf8), null);
  assert.deepEqual(Array.from(parser.consume(90)), [1, 64, 90, 1, 0]);
});

test("emits a complete contiguous sample with beat-relative notes", () => {
  const { engine, samples } = createEngine();
  engine.boundary(0);
  engine.event(1, 60, 96, 1, 240, 0);
  engine.event(1, 60, 0, 0, 960, 1);
  engine.boundary(1920);

  assert.equal(samples.length, 1);
  assert.equal(samples[0].complete, true);
  assert.equal(samples[0].length_beats, 4);
  assert.deepEqual(samples[0].notes, [
    {
      channel: 1,
      pitch: 60,
      name: "C4",
      velocity: 96,
      onset_beats: 0.5,
      duration_beats: 1.5,
      continued_from_previous: false,
      continues_into_next: false,
    },
  ]);
});

test("segments a held note across adjacent windows", () => {
  const { engine, samples } = createEngine();
  engine.boundary(0);
  engine.event(1, 67, 80, 1, 1440, 0);
  engine.boundary(1920);
  engine.event(1, 67, 0, 0, 2400, 1);
  engine.boundary(3840);

  assert.equal(samples.length, 2);
  assert.equal(samples[0].notes[0].continues_into_next, true);
  assert.equal(samples[0].notes[0].duration_beats, 1);
  assert.equal(samples[1].notes[0].continued_from_previous, true);
  assert.equal(samples[1].notes[0].duration_beats, 1);
});

test("supports overlapping retriggers of the same channel and pitch", () => {
  const { engine, samples } = createEngine();
  engine.boundary(0);
  engine.event(1, 60, 100, 1, 0, 0);
  engine.event(1, 60, 70, 1, 240, 1);
  engine.event(1, 60, 0, 0, 480, 2);
  engine.event(1, 60, 0, 0, 720, 3);
  engine.boundary(1920);

  assert.equal(samples[0].notes.length, 2);
  assert.deepEqual(
    samples[0].notes.map((note) => [
      note.velocity,
      note.onset_beats,
      note.duration_beats,
    ]),
    [
      [100, 0, 1],
      [70, 0.5, 1],
    ],
  );
});

test("emits empty windows and marks transport discontinuities", () => {
  const { engine, samples, statuses } = createEngine();
  engine.boundary(0);
  engine.boundary(1920);
  engine.boundary(480);

  assert.equal(samples[0].notes.length, 0);
  assert.equal(samples[0].end_reason, "boundary");
  assert.equal(samples.length, 1);
  assert.ok(
    statuses.some(
      ([level, message]) =>
        level === "warning" && message === "transport_moved_backwards",
    ),
  );
});

test("applies sample length changes after the active window", () => {
  const { engine, samples } = createEngine();
  engine.boundary(0);
  engine.setSampleBeats(2);
  engine.boundary(1920);
  engine.boundary(2880);

  assert.deepEqual(
    samples.map((sample) => sample.length_beats),
    [4, 2],
  );
});

test("uses standard MIDI pitch names", () => {
  assert.equal(pitchName(0), "C-1");
  assert.equal(pitchName(60), "C4");
  assert.equal(pitchName(127), "G9");
});

test("normalizes Max volume-prefixed output paths", () => {
  assert.equal(
    normalizeOutputPath("Macintosh HD:/Users/cooper/Documents/capture.jsonl"),
    "/Users/cooper/Documents/capture.jsonl",
  );
  assert.equal(
    normalizeOutputPath("/Users/cooper/Documents/capture.jsonl"),
    "/Users/cooper/Documents/capture.jsonl",
  );
});

test("parses atomic identity JSON from Max message atoms", () => {
  assert.deepEqual(
    parseIdentity([
      '{"canonicalPath":"live_set tracks 2 devices 1",',
      '"track":{"id":"17","index":2,"name":"Drums"},',
      '"device":{"id":"29","name":"Midi-Capture"}}',
    ]),
    {
      canonicalPath: "live_set tracks 2 devices 1",
      track: { id: "17", index: 2, name: "Drums" },
      device: { id: "29", name: "Midi-Capture" },
    },
  );
  assert.throws(() => parseIdentity([]), /empty/);
  assert.throws(() => parseIdentity(["not-json"]), /valid JSON/);
});

test("JSONL writer is optional and exposes readiness without status spam", () => {
  const statuses = [];
  const writer = new JsonlWriter((...items) => statuses.push(items));
  assert.equal(writer.isReady(), false);
  assert.equal(writer.append({ sample_index: 0 }), false);
  assert.deepEqual(statuses, []);
});

test("Max runtime supports live-only capture and independent sink failures", () => {
  const handlers = new Map();
  const liveSamples = [];
  const statuses = [];
  const signalClient = {
    configuredIdentity: null,
    started: false,
    configureProducer(identity) {
      this.configuredIdentity = identity;
    },
    start() {
      this.started = true;
    },
    stop() {},
    sendSample(sample) {
      liveSamples.push(sample);
    },
  };
  const writer = {
    isReady: () => false,
    append: () => assert.fail("unready writer must not be called"),
    setPath: async () => {},
  };
  startMaxRuntime({
    maxApi: {
      addHandler: (name, handler) => handlers.set(name, handler),
      outlet: (message) => statuses.push(message),
    },
    lifecycleTarget: new EventEmitter(),
    signalClient,
    writer,
  });
  assert.equal(signalClient.started, false);
  handlers.get("identity")(
    JSON.stringify({
      canonicalPath: "live_set tracks 2 devices 1",
      track: { id: "17", index: 2, name: "Drums" },
      device: { id: "29", name: "Midi-Capture" },
    }),
  );
  assert.equal(signalClient.started, true);
  assert.equal(signalClient.configuredIdentity.track.name, "Drums");
  handlers.get("configure")(480, 1);
  handlers.get("capture")(1, 0);
  handlers.get("transport")(1, 0);
  handlers.get("boundary")(0);
  handlers.get("boundary")(480);
  assert.equal(liveSamples.length, 1);

  writer.isReady = () => true;
  writer.append = () => {
    throw new Error("disk unavailable");
  };
  handlers.get("boundary")(960);
  assert.equal(liveSamples.length, 2);
  assert.ok(
    statuses.some(
      (message) =>
        message[0] === "status" &&
        message[1] === "error" &&
        message[2] === "writer_failed disk unavailable",
    ),
  );
});

test("Max runtime reports invalid or repeated identity without restarting", () => {
  const handlers = new Map();
  const statuses = [];
  let starts = 0;
  const signalClient = {
    configureProducer() {},
    start() {
      starts += 1;
    },
    stop() {},
    sendSample() {},
  };
  startMaxRuntime({
    maxApi: {
      addHandler: (name, handler) => handlers.set(name, handler),
      outlet: (message) => statuses.push(message),
    },
    lifecycleTarget: new EventEmitter(),
    signalClient,
    writer: {
      isReady: () => false,
      append() {},
      async setPath() {},
    },
  });
  handlers.get("identity")("not-json");
  assert.equal(starts, 0);
  assert.ok(
    statuses.some(
      (message) =>
        message[0] === "status" &&
        message[1] === "error" &&
        message[2].startsWith("identity_failed"),
    ),
  );
  handlers.get("identity")(
    JSON.stringify({
      canonicalPath: "live_set tracks 0 devices 0",
      track: { id: "1", index: 0, name: "Track" },
      device: { id: "2", name: "Midi-Capture" },
    }),
  );
  handlers.get("identity")(
    JSON.stringify({
      canonicalPath: "live_set tracks 0 devices 0",
      track: { id: "1", index: 0, name: "Track" },
      device: { id: "2", name: "Midi-Capture" },
    }),
  );
  assert.equal(starts, 1);
  assert.ok(
    statuses.some(
      (message) =>
        message[0] === "status" &&
        message[1] === "warning" &&
        message[2] === "identity_already_configured",
    ),
  );
});
