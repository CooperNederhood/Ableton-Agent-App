import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { Buffer } from "node:buffer";
import * as codec from "./audio_listener_metric_protocol.mjs";

const { createMelBandHandoff } = createRequire(import.meta.url)(
  "./audio_listener_mel_handoff.js",
);
const owner = "11111111-1111-4111-8111-111111111111";
const header = (sequence, start, end, reason = 0) => [
  3,
  7,
  1,
  sequence,
  start,
  end,
  reason ? 1 : 0,
  reason ? 1 : 0,
  reason,
  48000,
  24,
];
function fixture() {
  const events = [],
    controls = [];
  let time = 0;
  const h = createMelBandHandoff({
    epoch: 7,
    sampleRate: 48000,
    totalSamples: 2049,
    codec,
    requestedMetrics: ["mel-bands", "pitch", "spectral-shape"],
    analyzerReadiness: {
      schema: "analyzer-native-readiness/v1",
      producerAbi: 3,
      sourceAbi: 3,
      probeToken: 1,
      dspGeneration: 1,
      sampleRate: 48000,
      sourceClock: 9999,
    },
    now: () => time,
    send: (...args) => controls.push(args),
    emit: (e) => {
      const event = {
        ...e,
        eventId: owner,
        causationId: owner,
        generation: owner,
        nativeEpoch: 7,
        elapsedMs: time,
        scope: codec.LISTENER_METRIC_SCOPE,
      };
      codec.nativeMetricLifecycleSchema.parse(event);
      assert.ok(Buffer.byteLength(JSON.stringify(event)) < 4096);
      events.push(event);
    },
  });
  h.arm();
  h.receive(["mel_ready", ...header(0, 9999, 9999)]);
  h.receive(["mel_started", ...header(0, 10000, 12049)]);
  h.bind({ startSample: 10000, endSample: 12049 });
  return {
    h,
    events,
    controls,
    fault: (actual = [3, 7, 14, 7, 10017]) =>
      h.receive(["mel_source_identity", 3, 7, 1, 0, ...actual]),
    stop: () => h.receive(["mel_stopped", ...header(0, 10000, 12049, 4)]),
    drain: () => {
      time += 10;
      h.tick();
      const token = controls.findLast(([name]) => name === "drain")[1][0];
      h.receive(["mel_drain", 3, token, 7, 1, 3, 0, 1, 0, 0]);
    },
  };
}

test("fault-point evidence and exact invalid-clock receipts are bounded and cannot authorize cleanup", () => {
  const f = fixture();
  f.fault();
  assert.equal(f.h.snapshot().integrityFailure, null);
  assert.throws(f.stop, /mel_native_integrity_failure_4/);
  assert.throws(f.drain, /mel_terminal_clock_unconfirmed/);
  assert.equal(f.h.stop(), false);
  assert.throws(() => f.h.timeline(), /mel_timeline_not_settled/);
  assert.throws(() => f.h.analyzerTimelines(), /analyzer_timeline_not_settled/);
  const snapshot = f.h.snapshot();
  assert.equal(snapshot.integrityFailure, "mel_native_integrity_failure_4");
  assert.deepEqual(snapshot.stoppedPacket, header(0, 10000, 12049, 4));
  assert.deepEqual(snapshot.drainPacket.slice(2), [7, 1, 3, 0, 1, 0, 0]);
  assert.deepEqual(snapshot.sourceIdentityEvidence, {
    schema: "analyzer-native-source-identity/v1",
    producerAbi: 3,
    expectedEpoch: 7,
    expectedGeneration: 1,
    completedFrames: 0,
    sourceAbi: 3,
    sourceEpoch: 7,
    sourceRejected: 14,
    sourceSealedEpoch: 7,
    sourceClock: 10017,
  });
  for (let i = 0; i < 50; i++)
    assert.throws(f.drain, /mel_terminal_clock_unconfirmed/);
  const evidence = f.events.filter((e) =>
    [
      "mel_native_source_identity",
      "mel_native_stopped_receipt",
      "mel_native_drain_receipt",
    ].includes(e.reason),
  );
  assert.equal(evidence.length, 3);
  assert.deepEqual(
    evidence.map((e) => e.facts.length),
    [9, 11, 9],
  );
  const drainFacts = Object.fromEntries(
    evidence[2].facts.map((f) => [f.field, f.actual.value]),
  );
  assert.equal(drainFacts["mel.drain.terminalConsumed"], 1);
  assert.equal(drainFacts["mel.drain.clockValid"], 0);
  assert.equal(snapshot.receipt, null);
});

test("nonfinite operands are explicitly unavailable, large finite operands are not fake zero", () => {
  const f = fixture();
  f.fault(["null", -1, 1e100, "null", 10017]);
  const e = f.events.find((e) => e.reason === "mel_native_source_identity");
  const facts = Object.fromEntries(e.facts.map((f) => [f.field, f.actual]));
  assert.deepEqual(facts["mel.identity.sourceAbi"], {
    state: "unavailable",
    reason: "nonfinite",
  });
  assert.deepEqual(facts["mel.identity.sourceSealedEpoch"], {
    state: "unavailable",
    reason: "nonfinite",
  });
  assert.deepEqual(facts["mel.identity.sourceRejected"], {
    state: "observed",
    value: "1e+100",
  });
  assert.deepEqual(facts["mel.identity.sourceEpoch"], {
    state: "observed",
    value: -1,
  });
  assert.throws(f.stop, /mel_native_integrity_failure_4/);
});

test("the first rejected drain retains bounded actual and expected operands without accepting cleanup", () => {
  const f = fixture();
  f.h.tick();
  const packet = ["mel_drain", 3, 1, 7, 1, 99, 0, 0, 0, 0];
  for (let index = 0; index < 50; index++)
    assert.throws(() => f.h.receive(packet), /mel_invalid_drain_receipt/);
  const rejected = f.events.filter(
    (e) => e.reason === "mel_rejected_drain_receipt",
  );
  assert.equal(rejected.length, 1);
  const facts = Object.fromEntries(
    rejected[0].facts.map((f) => [f.field, f.actual]),
  );
  assert.deepEqual(facts["mel.drain.recordsDrained"], {
    state: "observed",
    value: 99,
  });
  assert.deepEqual(facts["mel.expected.recordsDrained"], {
    state: "observed",
    value: 2,
  });
  assert.deepEqual(facts["mel.expected.acceptedToken"], {
    state: "observed",
    value: 0,
  });
  assert.deepEqual(facts["mel.expected.issuedToken"], {
    state: "observed",
    value: 1,
  });
  assert.equal(f.h.snapshot().receipt, null);
  assert.equal(f.h.snapshot().completed, false);
  assert.equal(f.h.stop(), false);
  assert.throws(() => f.h.timeline(), /not_settled/);
});

for (const [label, change] of [
  [
    "wrong-owner",
    (p) => {
      p[2] = 8;
    },
  ],
  [
    "wrong-generation",
    (p) => {
      p[3] = 2;
    },
  ],
  [
    "future-frame",
    (p) => {
      p[4] = 1;
    },
  ],
  [
    "wrong-abi",
    (p) => {
      p[1] = 2;
    },
  ],
  [
    "oversized",
    (p) => {
      p.push(0);
    },
  ],
  [
    "unsanitized-nonfinite",
    (p) => {
      p[5] = Infinity;
    },
  ],
]) {
  test(`fault diagnostics reject ${label} without logging foreign operands`, () => {
    const f = fixture(),
      packet = ["mel_source_identity", 3, 7, 1, 0, 3, 7, 14, 7, 10017];
    change(packet);
    assert.throws(() => f.h.receive(packet));
    assert.equal(f.h.snapshot().sourceIdentityEvidence, null);
    assert.equal(
      f.events.some((e) => e.reason === "mel_native_source_identity"),
      false,
    );
    assert.equal(f.h.snapshot().completed, false);
  });
}

test("duplicate fault evidence cannot inflate lifecycle counts or replace first operands", () => {
  const f = fixture();
  f.fault();
  assert.throws(
    () => f.fault([2, 8, 0, 1, 0]),
    /mel_invalid_source_identity_evidence/,
  );
  assert.equal(f.h.snapshot().sourceIdentityEvidence.sourceRejected, 14);
  assert.equal(
    f.events.filter((e) => e.reason === "mel_native_source_identity").length,
    1,
  );
});
