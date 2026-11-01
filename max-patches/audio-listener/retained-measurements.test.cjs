const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const M = require("./audio_listener_measurements.js");

function declaration(width = 1, sampleRate = 48000, capacity = 4) {
  return {
    version: 1,
    kind: width === 1 ? "scalar" : "vector13",
    algorithmVersion: "v1",
    sampleRate,
    hopSamples: 64,
    windowSamples: 2048,
    width,
    capacity,
    fields: Array.from({ length: width }, (_, i) => ({
      name: `field${i}`,
      unit: "linear",
    })),
  };
}
function row(d, sequence = 1, produced = sequence, ack = sequence - 1) {
  return [
    1,
    7,
    sequence,
    7,
    sequence,
    2 ** 35 + sequence,
    2 ** 35 + sequence + 64,
    produced,
    ack,
    0,
    ...Array.from({ length: d.width }, (_, i) => i + 0.25),
    sequence,
    7,
    sequence,
    7,
  ];
}
function setup(d = declaration(), options = {}) {
  const records = [];
  const events = [];
  const reader = M.createReader({
    declaration: d,
    epoch: 7,
    consume: (record) => {
      records.push(record);
      return true;
    },
    onEvent: (event) => events.push(event),
    ...options,
  });
  assert.deepEqual(reader.begin().actions, [{ type: "request", sequence: 1 }]);
  return { reader, records, events, d };
}

test("FIFO two-read settling preserves descriptor-only data and request-before-ack ordering", () => {
  const { reader, records, events, d } = setup();
  assert.equal(reader.poll(row(d, 1, 2)).status, "settling");
  const accepted = reader.poll(row(d, 1, 3));
  assert.equal(accepted.status, "accepted");
  assert.deepEqual(accepted.actions, [
    { type: "request", sequence: 2 },
    { type: "acknowledge", sequence: 1 },
  ]);
  assert.deepEqual(Object.keys(records[0]), [
    "version",
    "kind",
    "epoch",
    "sequence",
    "startSample",
    "endSample",
    "values",
  ]);
  assert.equal(records[0].startSample, 2 ** 35 + 1);
  assert.ok(Object.isFrozen(records[0].values));
  for (let seq = 2; seq <= 4; seq++) {
    assert.equal(reader.poll(row(d, seq, Math.max(3, seq))).status, "settling");
    assert.equal(reader.poll(row(d, seq, Math.max(3, seq))).status, "accepted");
  }
  reader.complete();
  assert.deepEqual(
    records.map((record) => record.sequence),
    [1, 2, 3, 4],
  );
  assert.deepEqual(
    events.map((event) => event.stage),
    [
      "queued",
      "started",
      "progress",
      "progress",
      "progress",
      "progress",
      "completed",
    ],
  );
  assert.equal(reader.poll(row(d)).status, "completed");
  assert.equal(reader.stats().candidatePending, false);
});

test("empty queues wait without progress; only explicit begin owns a capture", () => {
  const d = declaration();
  const reader = M.createReader({
    declaration: d,
    epoch: 7,
    consume: () => true,
  });
  assert.equal(reader.poll(row(d)).status, "queued");
  reader.start();
  const empty = row(d, 1, 0, 0);
  empty[3] = empty[d.width + 11] = empty[4] = empty[d.width + 10] = 0;
  assert.equal(reader.poll(empty).status, "waiting");
  assert.equal(reader.stats().accepted, 0);
});

test("delayed acknowledgement readback can advance while the selected immutable record settles", () => {
  const { reader, d } = setup();
  reader.poll(row(d, 1, 2, 0));
  assert.equal(reader.poll(row(d, 1, 2, 0)).status, "accepted");
  assert.equal(reader.poll(row(d, 2, 3, 0)).status, "settling");
  assert.equal(reader.poll(row(d, 2, 4, 1)).status, "accepted");
  assert.equal(reader.stats().accepted, 2);
  assert.equal(reader.poll(row(d, 3, 4, 0)).reason, "invalid_sequence_order");
});

test("independent asynchronous producers are fair at mixed rates and dimensions", () => {
  const a = setup(declaration(1, 44100));
  const b = setup(declaration(13, 48000));
  for (let seq = 1; seq <= 64; seq++) {
    a.reader.poll(row(a.d, seq));
    if (seq % 2 === 0) {
      b.reader.poll(row(b.d, seq / 2));
      b.reader.poll(row(b.d, seq / 2));
    }
    a.reader.poll(row(a.d, seq));
  }
  assert.equal(a.records.length, 64);
  assert.equal(b.records.length, 32);
  assert.equal(b.records[0].values.length, 13);
});

test("stale owners neither renew progress nor erase slot immutability", () => {
  const { reader, events, d } = setup();
  reader.poll(row(d));
  const stale = row(d);
  stale[1] = 6;
  assert.equal(reader.poll(stale).status, "stale");
  assert.equal(events.length, 2);
  assert.equal(reader.poll(row(d)).status, "settling");
  assert.equal(reader.poll(row(d)).status, "accepted");
  const next = row(d, 2);
  reader.poll(next);
  reader.poll(stale);
  next[10]++;
  assert.equal(reader.poll(next).reason, "immutable_slot_changed");
});

const corruptions = [
  ["invalid_arity", (r) => r.pop()],
  [
    "invalid_numeric",
    (r) => {
      r[10] = Infinity;
    },
  ],
  [
    "invalid_numeric",
    (r) => {
      r[10] = Number.MAX_SAFE_INTEGER + 1;
    },
  ],
  [
    "invalid_numeric",
    (r) => {
      r[10] = "1";
    },
  ],
  [
    "invalid_abi",
    (r) => {
      r[0] = 2;
    },
  ],
  [
    "invalid_header_bounds",
    (r) => {
      r[5] = -1;
    },
  ],
  [
    "invalid_header_bounds",
    (r) => {
      r[6] = r[5] - 1;
    },
  ],
  [
    "invalid_header_bounds",
    (r) => {
      r[7] = 2 ** 44;
    },
  ],
  [
    "invalid_header_bounds",
    (r) => {
      r[9] = 3;
    },
  ],
  [
    "invalid_uninitialized_readback",
    (r) => {
      r[1] = 0;
    },
  ],
  [
    "torn_readback",
    (r) => {
      r[r.length - 1]++;
    },
  ],
  [
    "torn_readback",
    (r) => {
      r[r.length - 3]++;
    },
  ],
  [
    "torn_readback",
    (r) => {
      r[r.length - 2]++;
    },
  ],
  [
    "torn_readback",
    (r) => {
      r[r.length - 4]++;
    },
  ],
  [
    "unread_capacity_overflow",
    (r) => {
      r[9] = 1;
    },
  ],
  [
    "invalid_dsp_control",
    (r) => {
      r[9] = 2;
    },
  ],
  [
    "unread_capacity_overflow",
    (r) => {
      r[7] = 5;
    },
  ],
  [
    "unread_capacity_overflow",
    (r) => {
      r[7] = 2 ** 35;
    },
  ],
  [
    "invalid_sequence_order",
    (r) => {
      r[8] = 1;
    },
  ],
  [
    "invalid_sequence_order",
    (r) => {
      r[2] = r[r.length - 2] = 2;
    },
  ],
  [
    "invalid_slot_owner",
    (r) => {
      r[3] = r[r.length - 3] = 6;
    },
  ],
  [
    "invalid_slot_owner",
    (r) => {
      r[4] = r[r.length - 4] = 2;
    },
  ],
];
for (const [reason, corrupt] of corruptions) {
  test(`active-owner guard: ${reason} ${corrupt.toString()}`, () => {
    const { reader, records, events, d } = setup();
    const packet = row(d);
    corrupt(packet);
    if (reason === "torn_readback") {
      assert.deepEqual(reader.poll(packet), {
        status: "unstable",
        actions: [],
      });
      assert.equal(reader.stats().failures, 0);
      assert.equal(reader.stats().unstable, 1);
      assert.equal(records.length, 0);
      assert.equal(events.at(-1).reason, "unstable_acquisition");
      assert.equal(reader.poll(row(d)).status, "settling");
      assert.equal(reader.poll(row(d)).status, "accepted");
      return;
    }
    assert.equal(reader.poll(packet).reason, reason);
    assert.equal(reader.stats().candidatePending, false);
    assert.equal(reader.poll(row(d)).status, "failed");
    assert.equal(records.length, 0);
    assert.equal(events.at(-1).stage, "failed");
    assert.equal(reader.stats().failures, 1);
  });
}

test("changed coordinates/payload fail rather than replace candidates; observed request regressions fail", () => {
  for (const index of [5, 6, 10]) {
    const { reader, d } = setup();
    reader.poll(row(d));
    const changed = row(d);
    changed[index]++;
    assert.equal(reader.poll(changed).reason, "immutable_slot_changed");
  }
  const { reader, d } = setup();
  reader.poll(row(d));
  reader.poll(row(d));
  reader.poll(row(d, 2));
  assert.equal(reader.poll(row(d)).reason, "invalid_sequence_order");
});

test("pending Param controls tolerate only the previous immutable record without progress", () => {
  let clock = 0;
  const { reader, records, events, d } = setup(declaration(), {
    now: () => clock,
  });
  reader.poll(row(d));
  reader.poll(row(d));
  clock = 1000;
  for (let i = 0; i < 8; i++) {
    const waiting = reader.poll(row(d));
    assert.equal(waiting.status, "waiting");
    assert.deepEqual(waiting.actions, []);
  }
  assert.equal(records.length, 1);
  assert.equal(events.length, 3);
  assert.equal(reader.stats().elapsedMs, 0);
  assert.equal(reader.poll(row(d, 2)).status, "settling");
  assert.equal(reader.poll(row(d, 2)).status, "accepted");
  assert.equal(records.length, 2);
});

test("pending controls reject changed accepted slots and clean their single retained fingerprint", () => {
  for (const index of [5, 6, 10]) {
    const { reader, d } = setup();
    reader.poll(row(d));
    reader.poll(row(d));
    const changed = row(d);
    changed[index]++;
    assert.equal(reader.poll(changed).reason, "immutable_slot_changed");
    assert.equal(reader.stats().pendingControl, false);
    assert.equal(reader.poll(row(d)).status, "failed");
  }
  for (const close of ["cancel", "complete", "fail"]) {
    const { reader, d } = setup();
    reader.poll(row(d));
    reader.poll(row(d));
    assert.equal(reader.stats().pendingControl, true);
    reader[close]();
    assert.equal(reader.stats().pendingControl, false);
  }
  for (const corrupt of [
    (r) => {
      r[8] = 1;
    },
    (r) => {
      r[2] = r[r.length - 2] = 3;
    },
    (r) => {
      r[4] = r[r.length - 4] = 0;
    },
    (r) => {
      r[9] = 1;
    },
    (r) => {
      r[7] = 0;
    },
  ]) {
    const { reader, d } = setup();
    reader.poll(row(d));
    reader.poll(row(d));
    const invalid = row(d);
    corrupt(invalid);
    assert.equal(reader.poll(invalid).status, "failed");
    assert.equal(reader.stats().pendingControl, false);
  }
  const { reader, d } = setup();
  reader.poll(row(d));
  reader.poll(row(d));
  const nextEmpty = row(d, 2, 1, 1);
  nextEmpty[3] =
    nextEmpty[d.width + 11] =
    nextEmpty[4] =
    nextEmpty[d.width + 10] =
      0;
  assert.equal(reader.poll(nextEmpty).status, "waiting");
  assert.equal(reader.stats().pendingControl, false);
  assert.equal(reader.poll(row(d)).reason, "invalid_sequence_order");
});

test("coherent no-owner empty pages wait for prepare without progress; resets and dirty pages fail", () => {
  const { reader, d, events } = setup();
  const empty = Array(d.width + 14).fill(0);
  empty[0] = 1;
  for (const requested of [0, 1, 144, M.COUNTER_MAX]) {
    empty[2] = empty[d.width + 12] = requested;
    assert.equal(reader.poll(empty).status, "waiting");
  }
  assert.equal(events.length, 2);
  assert.equal(reader.stats().expectedSequence, 1);
  assert.equal(reader.stats().accepted, 0);
  assert.equal(reader.poll(row(d)).status, "settling");
  assert.equal(reader.poll(empty).reason, "invalid_owner_reset");
  for (const index of [3, 4, 5, 6, 7, 8, 9, 10, d.width + 13]) {
    const fresh = setup(d).reader;
    const dirty = empty.slice();
    dirty[index] = 1;
    assert.equal(fresh.poll(dirty).status, "failed");
  }
  for (const requested of [-1, 0.5, M.COUNTER_MAX + 1, Infinity, "144"]) {
    const fresh = setup(d).reader;
    const invalid = empty.slice();
    invalid[2] = invalid[d.width + 12] = requested;
    assert.equal(fresh.poll(invalid).status, "failed");
  }
  const mismatched = empty.slice();
  mismatched[2] = 144;
  mismatched[d.width + 12] = 143;
  assert.equal(
    setup(d).reader.poll(mismatched).reason,
    "invalid_uninitialized_readback",
  );
});

test("algorithm versions are bounded independently from descriptor identifiers", () => {
  for (const algorithmVersion of ["2.0.0", "2.0.0-beta.1+build5", "v1"]) {
    assert.equal(
      M.validateDeclaration({ ...declaration(), algorithmVersion })
        .algorithmVersion,
      algorithmVersion,
    );
  }
  for (const algorithmVersion of [
    "",
    "2.0.0 ".repeat(10),
    "2".repeat(65),
    "2/0/0",
  ]) {
    assert.throws(() =>
      M.validateDeclaration({ ...declaration(), algorithmVersion }),
    );
  }
  assert.throws(() =>
    M.validateDeclaration({
      ...declaration(16, 48000, 16),
      kind: "native-envelope",
      algorithmVersion: "v2",
    }),
  );
});
test("consumer denial, exception, cancellation, and reentrancy cannot acknowledge", () => {
  for (const consume of [
    () => false,
    () => undefined,
    () => {
      throw Error("secret");
    },
  ]) {
    const { reader, d } = setup(declaration(), { consume });
    reader.poll(row(d));
    const failed = reader.poll(row(d));
    assert.equal(failed.status, "failed");
    assert.deepEqual(failed.actions, []);
    assert.equal(reader.stats().candidatePending, false);
  }
  let reader;
  ({ reader } = setup(declaration(), {
    consume: () => {
      reader.cancel();
      return true;
    },
  }));
  reader.poll(row(declaration()));
  assert.equal(reader.poll(row(declaration())).status, "cancelled");
  assert.equal(reader.stats().accepted, 0);
  assert.equal(reader.stats().candidatePending, false);
  ({ reader } = setup(declaration(), {
    consume: () => {
      reader.poll(row(declaration()));
      return true;
    },
  }));
  reader.poll(row(declaration()));
  assert.equal(reader.poll(row(declaration())).reason, "reentrant_poll");
});

test("trace snapshots, timing, bounded counters and callback errors never retain raw context", () => {
  let clock = 100;
  const owner = {
    generation: "g1",
    passId: "p1",
    connectionEpoch: 9,
    traceId: "trace",
    correlationId: "correlation",
    causationId: "causation",
    extra: "secret",
  };
  const { reader, events, d } = setup(declaration(), {
    now: () => clock,
    ownerContext: owner,
  });
  owner.traceId = "mutated";
  clock = 125;
  reader.poll(row(d));
  reader.poll(row(d));
  clock = 120;
  reader.cancel();
  assert.equal(events.at(-1).elapsedMs, 25);
  assert.equal(events.at(-1).ownerContext.traceId, "trace");
  assert.equal(events.at(-1).ownerContext.extra, undefined);
  assert.ok(Object.isFrozen(events.at(-1).ownerContext));
  assert.equal(reader.stats().candidatePending, false);
  const bad = M.createReader({
    declaration: d,
    epoch: 7,
    consume: () => true,
    ownerContext: { traceId: "ghp_secret", passId: "x".repeat(129) },
    onEvent: () => {
      throw Error("ignored");
    },
  });
  assert.equal(bad.ownerContext.traceId, "[redacted]");
  assert.equal(bad.ownerContext.passId, "[redacted]");
  bad.begin();
  bad.cancel();
  assert.equal(bad.stats().callbackErrors, 3);
  assert.equal(JSON.stringify(reader.stats()).includes("values"), false);
});

test("declarations are bounded, immutable, explicit, and native dimensions are fixed", () => {
  const d = declaration();
  const snapshot = M.validateDeclaration(d);
  d.fields[0].name = "changed";
  assert.equal(snapshot.fields[0].name, "field0");
  for (const patch of [
    { width: 0 },
    { width: 65 },
    { capacity: 129 },
    { capacity: 0 },
    { sampleRate: 96000 },
    { hopSamples: 0 },
    { windowSamples: 65537 },
    { windowSamples: 0.5 },
    { algorithmVersion: "" },
    { extra: "data" },
    { fields: [{ name: "x", unit: "1" }] },
    { kind: "native-envelope" },
  ])
    assert.throws(() => M.validateDeclaration({ ...declaration(), ...patch }));
  const vector = declaration(13);
  vector.fields[1] = { ...vector.fields[0] };
  assert.throws(() => M.validateDeclaration(vector));
  for (const [kind, width, capacity] of [
    ["native-envelope", 16, 16],
    ["native-spectrum", 6, 32],
  ]) {
    assert.equal(
      M.validateDeclaration({
        ...declaration(width, 48000, capacity),
        kind,
        algorithmVersion: "2.0.0",
      }).width,
      width,
    );
  }
  assert.throws(() =>
    M.createReader({ declaration: null, epoch: 7, consume: () => true }),
  );
});

test("classic Max include defines a single global without Node or timers", () => {
  const source = fs.readFileSync(
    require.resolve("./audio_listener_measurements.js"),
    "utf8",
  );
  const parser = createRequire(require.resolve("eslint/package.json"))(
    "espree",
  );
  assert.doesNotThrow(() => parser.parse(source, { ecmaVersion: 5 }));
  const sandbox = {};
  vm.runInNewContext(source, sandbox);
  assert.deepEqual(Object.keys(sandbox), ["AudioListenerMeasurements"]);
  assert.equal(sandbox.AudioListenerMeasurements.COUNTER_MAX, 2 ** 44 - 1);
  assert.doesNotMatch(
    source,
    /\b(?:const|let|require|setTimeout|setInterval)\b|=>/,
  );
});

test("classic Max CommonJS1 exports the reader without a Node module global", () => {
  const sandbox = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(
      require.resolve("./audio_listener_measurements.js"),
      "utf8",
    ),
    sandbox,
  );
  assert.deepEqual(Object.keys(sandbox.exports).sort(), Object.keys(M).sort());
  assert.equal(typeof sandbox.exports.createReader, "function");
  assert.equal(sandbox.exports.COUNTER_MAX, M.COUNTER_MAX);
});
