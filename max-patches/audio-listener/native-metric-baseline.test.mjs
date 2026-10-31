import "./native-protocol-test-loader.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { genModel } from "./gen-model.mjs";
import { nativeRuntimeDocuments } from "./native-runtime-source.mjs";

const require = createRequire(import.meta.url);
const { NativeMessageIO } = require("./audio_listener_native_io.js");
const { v2Fixture } = require("./native-v2-fixture.cjs");
const { nativeFailureDiagnosticV2Schema } =
  await import("../../packages/signal-routing/src/listener-v2-contracts.ts");

// Launch-race regressions plus one intentionally retained coupled-join baseline.
// The generated shipping v4 graph selects these retained Gen publishers; its
// controller/IO ABI remains v2. This is a GenExpr model, not Max scheduler proof.
const RATE = 48000;
const HOP = 4800;
const TOTAL = 90000;
const FFT = 2048;

async function baseline() {
  let receiptTime = 0;
  const f = v2Fixture({
    retainedMeasurements: true,
    retentionReady: false,
    total: TOTAL,
    invalidFrames: 0,
    fftBaseline: 64704,
    geometry: { tempoBpm: 128, startBeat: 0, endBeat: 4 },
    setTime: (value) => {
      receiptTime = value;
    },
  });
  const documents = nativeRuntimeDocuments({ nativeVersion: 4 });
  const wire = [];
  const controls = [];
  const diagnostics = [];
  const publishers = {};
  f.controller.prepare(f.command);
  const pending = f.controller.arm(f.command);
  const pass = f.controller.pass;

  for (const [family, outputs, width, first] of [
    ["envelope", 53, 16, f.armCounter - 1024],
    ["spectrum", 31, 6, 64704 - FFT],
  ]) {
    const document = documents[`audio_listener_native_${family}.gendsp`];
    const code = document.patcher.boxes.find(({ box }) => box.id === "code").box
      .code;
    const model = genModel(code, outputs, RATE);
    let counter = first;
    let values;
    const step = () => {
      if (family === "envelope") {
        const phase =
          counter < f.origin + 64
            ? 0
            : ((counter - f.origin) / ((RATE * 60) / 128)) % 1;
        const sounding = counter >= f.origin;
        values = model.step(
          phase,
          sounding ? 0.25 : 0,
          sounding ? -0.5 : 0,
          counter,
        );
      } else {
        const bin = (counter - first) % FFT;
        values = model.step(
          counter >= f.origin && bin === 32 ? 1 : 0,
          0,
          0,
          0,
          bin,
          counter % 1048576,
          Math.floor(counter / 1048576),
        );
      }
      counter++;
      return values;
    };
    const io = new NativeMessageIO(
      family,
      (packet) => {
        wire.push([...packet]);
        f.packet(packet[2], packet.slice(3), packet[1]);
        return true;
      },
      (control) => {
        controls.push([family, ...control]);
        if (control[0] !== "poll")
          model.configure({ [control[0]]: control[1] });
        return true;
      },
      (reason) => diagnostics.push([family, reason]),
      2,
      { retainedMeasurements: true, now: () => receiptTime },
    );
    const publisher = {
      io,
      step,
      advance(end) {
        while (counter <= end) step();
        return values;
      },
      state() {
        return values.slice(0, width);
      },
      configuration() {
        assert.equal(family, "envelope");
        return values.slice(16, 23);
      },
      readback() {
        return values.slice(outputs - width - 14);
      },
      poll() {
        step(); // Execute requested-slot/ACK controls before sampling again.
        return io.retainedFrame(publisher.readback());
      },
      stats() {
        return io.retentionReader.stats();
      },
    };
    publishers[family] = publisher;
    if (family === "envelope") publisher.advance(f.armCounter - 4);
    assert.equal(io.begin(pass.generation, pass.nativeEpoch, RATE), true);
    if (family === "envelope") {
      publisher.poll();
      publisher.poll();
      publisher.advance(f.armCounter - 1);
    }
  }
  const { envelope, spectrum } = publishers;
  spectrum.advance(64703);
  assert.equal(spectrum.poll(), false); // sequence 1 must settle twice
  assert.equal(spectrum.stats().accepted, 0);
  assert.equal(spectrum.poll(), true);
  assert.equal(spectrum.stats().accepted, 1);
  assert.deepEqual(
    wire.filter((p) => p[2] === "spectrum").map((p) => p.slice(3)),
    [[64704, 0, 0, 62656, 64704, 0]],
  );
  // This real pre-onset FFT row is ACKed before an assembler exists.
  assert.equal(pass.assembler, null);
  f.preflight();
  f.configReceipt();
  assert.equal(
    envelope.io.configureV2(pass.generation, [TOTAL, HOP, 128, 0, 64]),
    true,
  );
  assert.equal(envelope.io.arm(pass.generation, pass.nativeEpoch), true);
  envelope.advance(f.armCounter);
  envelope.io.configurationFrame(envelope.configuration());
  envelope.io.envelope(envelope.state());
  await pending;
  assert.equal(f.controller.state, "armed");
  assert.deepEqual(f.geometry, {
    sampleRate: RATE,
    vectorSize: 64,
    tempoBpm: 128,
    startBeat: 0,
    endBeat: 4,
    hopSamples: HOP,
    totalSamples: TOTAL,
  });

  return {
    f,
    pass,
    envelope,
    spectrum,
    wire,
    controls,
    diagnostics,
    close() {
      if (f.controller.pass) f.controller.cancel(f.command);
      const outcome = f.sent.at(-1).outcome;
      for (const publisher of Object.values(publishers)) {
        assert.equal(publisher.io.stop(pass.generation, outcome), true);
        assert.equal(publisher.io.retentionReader, null);
      }
      envelope.step();
      envelope.io.configurationFrame(envelope.configuration());
      assert.equal(envelope.io.envelope(envelope.state()), true);
      for (const publisher of Object.values(publishers)) {
        assert.equal(publisher.io.generation, null);
        assert.equal(publisher.io.retentionReadbacks.length, 0);
      }
      assert.equal(f.controller.pass, null);
      assert.equal(f.controller.pendingDisarm, null);
      assert.deepEqual(diagnostics, []);
      assert.equal(
        f.events.some((event) => event.status === "complete"),
        false,
      );
    },
  };
}

test("delayed first playing clock never promotes a state-only hop while retained sequence 1 is settling", async () => {
  const h = await baseline();
  try {
    const { f, pass, envelope, wire } = h;
    envelope.advance(f.origin + HOP + 128);
    assert.equal(envelope.state()[12], HOP);
    assert.deepEqual(envelope.state().slice(8, 12), [0.25, 0.5, 0.25, 0.5]);
    assert.equal(envelope.poll(), false);
    assert.equal(envelope.stats().candidatePending, true);
    assert.equal(envelope.stats().accepted, 0);
    envelope.io.envelope(envelope.state());
    assert.equal(f.controller.state, "armed");
    assert.equal(pass.envelopes.length, 0);
    assert.equal(pass.lastEnvelope, null);
    assert.equal(wire.filter((p) => p[2] === "envelope").length, 0);

    f.time(103);
    f.packet("clock", f.clock(f.origin + HOP + 128));
    assert.equal(f.controller.state, "capturing");
    assert.equal(pass.envelopes.length, 0);
    assert.equal(pass.lastEnvelope, null);
    assert.equal(pass.assembler.frames, 0);
    assert.equal(pass.assembler.pending.length, 0);
    // Nothing from the retained measurement channel admitted this row.
    assert.equal(envelope.stats().accepted, 0);
    assert.equal(wire.filter((p) => p[2] === "envelope").length, 0);
    assert.equal(envelope.poll(), true);
    assert.equal(envelope.stats().accepted, 1);
    assert.equal(pass.envelopes.length, 1);
    assert.equal(pass.envelopes[0].endCounter, f.origin + HOP);
    assert.equal(pass.lastEnvelope.end, f.origin + HOP);
    assert.deepEqual(
      h.controls
        .filter(
          ([family, name]) =>
            family === "envelope" && name === "measurementAcknowledged",
        )
        .map(([, , sequence]) => sequence),
      [0, 1],
    );
  } finally {
    h.close();
  }
});

test("pre-launch retained hop 1 survives ACK and newer state-only hop 2, then each measured hop is admitted once", async () => {
  const h = await baseline();
  try {
    const { f, pass, envelope, wire } = h;
    envelope.advance(f.origin + HOP + 128);
    envelope.io.envelope(envelope.state());
    assert.equal(envelope.poll(), false);
    assert.equal(envelope.poll(), true);
    assert.equal(envelope.stats().accepted, 1);
    assert.equal(pass.launchPacket[12], HOP);
    assert.equal(pass.envelopes.length, 0);
    assert.equal(pass.lastEnvelope, null);
    envelope.advance(f.origin + 2 * HOP + 128);
    envelope.io.envelope(envelope.state());
    assert.equal(pass.launchPacket[12], 2 * HOP);
    assert.equal(f.controller.state, "armed");
    assert.deepEqual(
      wire.filter((p) => p[2] === "envelope").map((p) => p[15]),
      [HOP],
    );
    assert.deepEqual(envelope.readback().slice(7, 10), [2, 1, 0]);
    f.time(203);
    f.packet("clock", f.clock(f.origin + 2 * HOP + 128));
    assert.equal(f.controller.state, "capturing");
    assert.equal(pass.envelopes.length, 1);
    assert.equal(pass.envelopes[0].endCounter, f.origin + HOP);
    assert.equal(pass.prelaunchEnvelopes.length, 0);
    const progress = f.observed.filter((event) =>
      /^native_(prelaunch_envelope_|launch_state_only)/.test(
        event.reason ?? "",
      ),
    );
    assert.deepEqual(
      progress.map((event) => event.reason),
      [
        "native_prelaunch_envelope_staged",
        "native_launch_state_only",
        "native_prelaunch_envelope_draining",
        "native_prelaunch_envelope_drained",
      ],
    );
    assert.deepEqual(
      progress.map((event) => event.elapsedMs),
      [0, 203, 203, 203],
    );
    for (const event of progress) {
      assert.equal(event.traceId, f.command.traceId);
      assert.equal(event.correlationId, f.command.correlationId);
      assert.equal(event.generation, pass.generation);
      assert.equal(event.nativeEpoch, pass.nativeEpoch);
    }
    assert.equal(progress[2].causationId, progress[1].eventId);
    assert.equal(progress[3].causationId, progress[2].eventId);
    assert.equal(envelope.poll(), false);
    assert.equal(envelope.poll(), true);
    assert.equal(envelope.stats().accepted, 2);
    assert.deepEqual(
      pass.envelopes.map((packet) => packet.endCounter),
      [f.origin + HOP, f.origin + 2 * HOP],
    );
    assert.equal(pass.assembler.frames, 0);
    assert.equal(pass.assembler.pending.length, 0);
    assert.equal(
      f.events.filter((event) => event.type === "terminal").length,
      0,
    );
  } finally {
    h.close();
  }
});

async function armedFixture(options = {}) {
  const f = v2Fixture({
    retainedMeasurements: true,
    total: TOTAL,
    geometry: { tempoBpm: 128, startBeat: 0, endBeat: 4 },
    ...options,
  });
  f.controller.prepare(f.command);
  const pending = f.controller.arm(f.command);
  f.preflight();
  f.configReceipt();
  f.ack();
  await pending;
  assert.equal(f.controller.state, "armed");
  return f;
}

function finishFixture(f) {
  const pass = f.controller.pass;
  if (pass) f.controller.cancel(f.command);
  if (f.controller.pendingDisarm)
    f.packet("stopped", [0, 0, 2], f.controller.pendingDisarm.generation);
  assert.equal(f.controller.pass, null);
  assert.equal(f.controller.pendingDisarm, null);
  if (pass) {
    assert.equal(pass.prelaunchEnvelopes.length, 0);
    assert.equal(pass.prelaunchSpectra.length, 0);
  }
}

test("measured packet triggering launch is admitted exactly once, including its unchanged hold", async () => {
  const f = await armedFixture();
  try {
    const pass = f.controller.pass;
    f.packet("clock", f.clock(f.origin + HOP + 64));
    assert.equal(f.controller.state, "armed");
    f.packet("envelope", f.envelope(HOP));
    assert.equal(f.controller.state, "capturing");
    assert.equal(pass.envelopeWindows.length, 1);
    assert.equal(pass.prelaunchEnvelopes.length, 0);
    assert.equal(pass.envelopes.length, 1);
    f.packet("envelope", f.envelope(HOP));
    assert.equal(pass.envelopeWindows.length, 1);
    assert.equal(pass.envelopes.length, 1);
  } finally {
    finishFixture(f);
  }
});

test("state-only launch cannot cover a genuinely skipped first measured hop", async () => {
  const f = await armedFixture();
  try {
    const pass = f.controller.pass;
    f.packet("envelope-state", f.envelope(2 * HOP));
    f.packet("clock", f.clock(f.origin + 2 * HOP + 64));
    assert.equal(f.controller.state, "capturing");
    assert.equal(pass.envelopeWindows.length, 0);
    f.packet("envelope", f.envelope(2 * HOP));
    assert.equal(f.events.at(-1).reason, "native_envelope_sequence_gap");
    assert.equal(pass.assembler.frames, 0);
  } finally {
    finishFixture(f);
  }
});

test("a drained retained record remains immutable even when only non-level payload changes", async () => {
  const f = await armedFixture();
  try {
    const pass = f.controller.pass;
    f.packet("envelope", f.envelope(HOP));
    f.packet("clock", f.clock(f.origin + HOP + 64));
    assert.equal(pass.envelopeWindows.length, 1);
    const changed = f.envelope(HOP);
    changed[3] = 1;
    f.packet("envelope", changed);
    assert.equal(f.events.at(-1).reason, "changed_native_envelope_hold");
    assert.equal(pass.prelaunchEnvelopes.length, 0);
  } finally {
    finishFixture(f);
  }
});

test("prelaunch spectral eligibility preserves required FFT prefix and staged levels complete without replay", async () => {
  const f = await armedFixture();
  const pass = f.controller.pass;
  let nextFFT = 66048;
  try {
    for (let hop = 1; hop <= 3; hop++) {
      while (nextFFT <= f.origin + hop * HOP) {
        f.packet("spectrum", f.spectrum(nextFFT));
        nextFFT += FFT;
      }
      f.packet("envelope", f.envelope(hop * HOP));
    }
    assert.equal(pass.prelaunchEnvelopes.length, 3);
    assert.equal(pass.prelaunchSpectra.length, 7);
    assert.equal(Object.isFrozen(pass.prelaunchEnvelopes[0]), true);
    assert.equal(Object.isFrozen(pass.prelaunchSpectra[0]), true);
    f.packet("clock", f.clock(f.origin + 3 * HOP + 64));
    assert.equal(f.controller.state, "capturing");
    assert.equal(pass.assembler.frames, 3);
    assert.equal(pass.envelopeWindows.length, 3);
    assert.equal(pass.envelopes.length, 0);
    assert.equal(pass.prelaunchEnvelopes.length, 0);
    assert.equal(pass.prelaunchSpectra.length, 0);
    for (let count = 4 * HOP; ; count = Math.min(count + HOP, TOTAL)) {
      f.packet("clock", f.clock(f.origin + count + 64));
      while (nextFFT <= f.origin + count) {
        f.packet("spectrum", f.spectrum(nextFFT));
        nextFFT += FFT;
      }
      f.packet("envelope", f.envelope(count));
      if (count === TOTAL) break;
    }
    f.post();
    const terminal = f.events.find((event) => event.type === "terminal");
    assert.equal(terminal.status, "complete", terminal.reason);
    assert.equal(terminal.observation.samples.length, 19);
    assert.equal(
      terminal.observation.endSample - terminal.observation.startSample,
      TOTAL,
    );
    assert.equal(pass.prelaunchEnvelopes.length, 0);
    assert.equal(pass.prelaunchSpectra.length, 0);
  } finally {
    finishFixture(f);
  }
});

test("over six seconds of armed stopped DSP cannot fill pre-onset FFT staging, then launch retains the real FFT prefix", async () => {
  const f = await armedFixture();
  const pass = f.controller.pass;
  const shift = 160 * FFT;
  const origin = f.origin + shift;
  const clock = (counter) => {
    const values = f.clock(counter - shift);
    for (const index of [2, 4, 6, 9]) values[index] += shift;
    return values;
  };
  const envelope = (count) => {
    const values = f.envelope(count);
    values[1] += shift;
    values[14] += shift;
    return values;
  };
  let nextFFT = 64000 + FFT;
  try {
    for (let frame = 1; frame <= 160; frame++) {
      const stoppedCounter = f.armCounter + frame * FFT;
      f.time(((stoppedCounter - f.armCounter) / RATE) * 1000);
      f.packet("clock", f.clock(stoppedCounter, false));
      f.packet("spectrum", f.spectrum(nextFFT));
      nextFFT += FFT;
      assert.equal(f.controller.state, "armed", `stopped FFT frame ${frame}`);
    }
    assert.equal(pass.prelaunchSpectra.length, 0);
    assert(shift / RATE > 6);
    // No playing callback yet: these three frames include one ending exactly
    // at onset and two required post-onset frames. None may roll out unseen.
    while (nextFFT <= origin + HOP) {
      f.packet("spectrum", f.spectrum(nextFFT));
      nextFFT += FFT;
    }
    assert.deepEqual(
      pass.prelaunchSpectra.map((values) => values[0]),
      [origin, origin + FFT, origin + 2 * FFT],
    );
    f.packet("envelope", envelope(HOP));
    assert.deepEqual(
      pass.prelaunchSpectra.map((values) => values[0]),
      [origin + FFT, origin + 2 * FFT],
    );
    f.packet("clock", clock(origin + HOP + 64));
    assert.equal(f.controller.state, "capturing");
    assert.equal(pass.assembler.frames, 1);
    assert.equal(pass.prelaunchEnvelopes.length, 0);
    assert.equal(pass.prelaunchSpectra.length, 0);
    for (let count = 2 * HOP; ; count = Math.min(count + HOP, TOTAL)) {
      f.packet("clock", clock(origin + count + 64));
      while (nextFFT <= origin + count) {
        f.packet("spectrum", f.spectrum(nextFFT));
        nextFFT += FFT;
      }
      f.packet("envelope", envelope(count));
      if (count === TOTAL) break;
    }
    for (let i = 0; i < 32; i++)
      f.packet("clock", clock(origin + TOTAL + 128 + i * 64));
    const terminal = f.events.find((event) => event.type === "terminal");
    assert.equal(terminal.status, "complete", terminal.reason);
    assert.equal(terminal.observation.samples.length, 19);
    assert.equal(
      terminal.observation.endSample - terminal.observation.startSample,
      TOTAL,
    );
  } finally {
    finishFixture(f);
  }
});

test("fresh stopped native clock prunes queued pre-onset endpoints but retains a crossing frame", async () => {
  const f = await armedFixture();
  const pass = f.controller.pass;
  try {
    for (const end of [66048, 68096, 70144])
      f.packet("spectrum", f.spectrum(end));
    assert.equal(pass.prelaunchSpectra.length, 3);
    f.time(80);
    f.packet("clock", f.clock(69000, false));
    assert.deepEqual(
      pass.prelaunchSpectra.map((values) => [values[3], values[0]]),
      [[68096, 70144]],
    );
    assert.equal(f.controller.state, "armed");
  } finally {
    finishFixture(f);
  }
});

test("validated pending origin prunes old FFTs despite stale clocks and protects its post-onset frames from later stopped callbacks", async () => {
  const f = await armedFixture();
  const pass = f.controller.pass;
  const shift = 20 * FFT;
  const origin = f.origin + shift;
  try {
    f.time(1500);
    for (let sequence = 1; sequence <= 32; sequence++)
      f.packet("spectrum", f.spectrum(64000 + sequence * FFT));
    assert.equal(pass.prelaunchSpectra.length, 32);
    const marker = f.envelope();
    marker[1] += shift;
    marker[14] += shift;
    f.packet("envelope-state", marker);
    assert.equal(f.controller.state, "armed");
    const remaining = pass.prelaunchSpectra.map((values) => values[0]);
    assert.equal(remaining.length, 11);
    assert.equal(remaining[0], origin + FFT);
    f.packet("clock", f.clock(origin + 2 * FFT, false));
    assert.deepEqual(
      pass.prelaunchSpectra.map((values) => values[0]),
      remaining,
    );
  } finally {
    finishFixture(f);
  }
});

test("stale stopped evidence cannot prune unknown backlog or evade the fixed 32-frame bound", async () => {
  const f = await armedFixture();
  const pass = f.controller.pass;
  try {
    f.packet("clock", f.clock(100000, false));
    f.time(1001);
    for (let sequence = 1; sequence <= 33; sequence++)
      f.packet("spectrum", f.spectrum(64000 + sequence * FFT));
    const terminal = f.events.find((event) => event.type === "terminal");
    assert.equal(terminal.reason, "native_prelaunch_spectrum_buffer_overflow");
    assert.equal(terminal.status, "failed");
    assert.equal(pass.prelaunchSpectra.length, 0);
    nativeFailureDiagnosticV2Schema.parse(terminal.nativeFailureDiagnostic);
    assert.equal(
      terminal.nativeFailureDiagnostic.checkEvidence.operands.find(
        (operand) => operand.field === "spectrum-pending",
      ).actual,
      32,
    );
  } finally {
    finishFixture(f);
  }
});

for (const [name, records, reason] of [
  ["skipped first hop", [2], "native_envelope_sequence_gap"],
  ["skipped later hop", [1, 3], "native_envelope_sequence_gap"],
  ["out-of-order hop", [1, 2, 1], "native_envelope_sequence_gap"],
  ["changed held hop", [1, "changed"], "changed_native_envelope_hold"],
]) {
  test(`prelaunch staging rejects ${name} without admitting a fabricated prefix`, async () => {
    const f = await armedFixture();
    const pass = f.controller.pass;
    try {
      for (const count of records) {
        const values = f.envelope((count === "changed" ? 1 : count) * HOP);
        if (count === "changed") values[8] = 0.9;
        f.packet("envelope", values);
      }
      const terminal = f.events.find((event) => event.type === "terminal");
      assert.equal(terminal.reason, reason);
      assert.equal(terminal.status, "failed");
      assert.equal(pass.assembler, null);
      assert.equal(pass.prelaunchEnvelopes.length, 0);
      assert.equal(Object.isFrozen(terminal.nativeFailureDiagnostic), true);
      nativeFailureDiagnosticV2Schema.parse(terminal.nativeFailureDiagnostic);
      assert.equal(
        terminal.nativeFailureDiagnostic.checkEvidence.reason,
        reason,
      );
    } finally {
      finishFixture(f);
    }
  });
}

for (const family of ["envelope", "spectrum"]) {
  test(`prelaunch ${family} capacity is bounded with immutable exact failure operands`, async () => {
    const f = await armedFixture();
    const pass = f.controller.pass;
    const capacity = family === "envelope" ? 16 : 32;
    try {
      for (let sequence = 1; sequence <= capacity + 1; sequence++)
        f.packet(
          family,
          family === "envelope"
            ? f.envelope(sequence * HOP)
            : f.spectrum(64000 + sequence * FFT),
        );
      const terminal = f.events.find((event) => event.type === "terminal");
      assert.equal(
        terminal.reason,
        `native_prelaunch_${family}_buffer_overflow`,
      );
      assert.equal(terminal.status, "failed");
      const d = terminal.nativeFailureDiagnostic;
      assert.equal(Object.isFrozen(d), true);
      nativeFailureDiagnosticV2Schema.parse(d);
      assert.deepEqual(
        d.checkEvidence.operands.find(
          (operand) => operand.field === `${family}-pending`,
        ),
        {
          field: `${family}-pending`,
          actual: capacity,
          expected: capacity,
          relation: "less-than",
          unit: "count",
          domain: "native-source",
        },
      );
      assert.equal(pass.prelaunchEnvelopes.length, 0);
      assert.equal(pass.prelaunchSpectra.length, 0);
    } finally {
      finishFixture(f);
    }
  });
}

for (const stage of [
  "native_prelaunch_envelope_staged",
  "native_prelaunch_envelope_draining",
]) {
  test(`reentrant cancellation at ${stage} seals and clears the staged owner`, async () => {
    let f;
    f = await armedFixture({
      observe: (event) => {
        if (event.reason === stage) f.controller.cancel(f.command);
      },
    });
    const pass = f.controller.pass;
    try {
      f.packet("envelope", f.envelope(HOP));
      if (f.controller.pass) f.packet("clock", f.clock(f.origin + HOP + 64));
      assert.equal(f.controller.state, "cancelled");
      assert.equal(pass.prelaunchEnvelopes.length, 0);
      assert.equal(pass.prelaunchSpectra.length, 0);
      assert.equal(
        f.observed.some(
          (event) => event.reason === "native_prelaunch_envelope_drained",
        ),
        false,
      );
      assert.equal(
        f.events.filter((event) => event.type === "terminal").length,
        1,
      );
      f.packet("envelope", f.envelope(HOP), pass.generation);
      assert.equal(f.controller.pass, null);
    } finally {
      finishFixture(f);
    }
  });
}

test("BASELINE BAD: a bounded paused FFT reader leaves an exact 2048 endpoint gap and overflows the coupled controller, not the assembler", async () => {
  const h = await baseline();
  try {
    const { f, pass, envelope, spectrum } = h;
    envelope.advance(f.origin + 640);
    f.packet("clock", f.clock(f.origin + 640));
    envelope.io.envelope(envelope.state());
    assert.equal(f.controller.state, "capturing");
    // Drain the boundary-crossing row 2 and first fully post-origin row 3.
    spectrum.advance(f.origin + HOP - FFT);
    for (let sequence = 2; sequence <= 3; sequence++) {
      assert.equal(spectrum.poll(), false);
      assert.equal(spectrum.poll(), true);
      assert.equal(spectrum.stats().accepted, sequence);
    }
    const firstEnd = f.origin + HOP;
    assert.equal(pass.spectrum[0], firstEnd - FFT);
    assert.equal(pass.assembler.lastSpectrum.end, firstEnd - FFT);
    assert.deepEqual(
      pass.assembler.spectra.map((s) => s.end),
      [firstEnd - 2 * FFT, firstEnd - FFT],
    );
    // Deliberately pause this reader, not its Gen publisher. This schedule
    // proves coupling; it does not explain why a real Max callback was delayed.
    for (let hop = 1; hop <= 9; hop++) {
      const end = f.origin + hop * HOP;
      f.time(hop * 100);
      envelope.advance(end + 128);
      assert.equal(envelope.state()[4], 0);
      assert.equal(envelope.state()[12], hop * HOP);
      assert.deepEqual(envelope.state().slice(8, 12), [0.25, 0.5, 0.25, 0.5]);
      spectrum.advance(end + 128);
      f.packet("clock", f.clock(end + 128));
      if (hop === 9) {
        assert.equal(spectrum.poll(), false);
        assert.equal(spectrum.stats().candidatePending, true);
        assert.equal(spectrum.stats().accepted, 3);
        const row = spectrum.readback();
        assert.equal(row[2], 4); // next requested FFT exists, but is settling
        assert.equal(row[7], 22);
        assert.equal(row[8], 3);
        assert.equal(row[9], 0); // no native ring overflow/control fault
        assert.equal(row[7] - row[8], 19);
        assert.equal(row[10], firstEnd);
      }
      assert.equal(envelope.poll(), false);
      assert.equal(envelope.poll(), true);
      assert.equal(envelope.stats().accepted, hop);
      if (hop < 9) {
        assert.equal(pass.envelopes.length, hop);
        assert.equal(pass.assembler.pending.length, 0);
        assert.equal(pass.assembler.frames, 0);
      }
    }
    const terminals = f.events.filter((event) => event.type === "terminal");
    assert.equal(terminals.length, 1);
    const terminal = terminals[0];
    assert.equal(terminal.status, "failed");
    assert.equal(terminal.reason, "native_envelope_buffer_overflow");
    assert.deepEqual(
      h.wire.filter((p) => p[2] === "envelope").map((p) => p[15]),
      Array.from({ length: 9 }, (_, i) => (i + 1) * HOP),
    );
    const d = terminal.nativeFailureDiagnostic;
    assert.equal(d.check, "controller-envelope-overflow");
    assert.equal(d.blocker, "spectrum-behind");
    assert.equal(d.controllerPending, 8);
    assert.equal(d.assemblerPending, 0);
    assert.equal(d.completedMeasurements, 0);
    assert.equal(d.firstEnvelopeEndCounter, firstEnd);
    assert.equal(d.rejectedEnvelopeEndCounter, f.origin + 9 * HOP);
    assert.deepEqual(d.availableSpectrum, [firstEnd - 2 * FFT, firstEnd - FFT]);
    assert.equal(firstEnd - d.latestSpectrum[0], FFT);
    assert.equal(d.clock[4], f.origin + 9 * HOP + 128);
    assert.equal(d.clockAgeMs, 0);
    // Settling emits a readback snapshot, not a reader progress event. The
    // join diagnostic's retention-state is older than the actual 22/3 queue.
    assert.deepEqual(
      d.retentionSpectrum,
      h.wire.findLast((p) => p[2] === "retention-state" && p[3] === 2).slice(3),
    );
    assert.equal(d.retentionSpectrum[4], 1);
    assert.equal(d.retentionSpectrum[5], 0);
    assert.equal(d.retentionSpectrum[6], 32);
    assert.equal(d.retentionSpectrum[9], 0);
    assert.equal(d.generation, pass.generation);
    const failure = f.observed.find(
      (event) => event.reason === terminal.reason && event.stage === "failed",
    );
    assert.equal(failure.traceId, f.command.traceId);
    assert.equal(failure.correlationId, f.command.correlationId);
    assert.equal(pass.envelopes.length, 0); // failure cleanup, not queue origin
    assert.equal(pass.assembler.pending.length, 0);
    assert.equal(f.sent.at(-1).outcome, "failed");
  } finally {
    h.close();
  }
});
