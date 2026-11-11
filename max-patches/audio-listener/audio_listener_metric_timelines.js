/* global module */
"use strict";

// Internal, schema-independent reducers. No transport, timers, storage or audio IO.
const METRIC_LIMITS = Object.freeze({
  captureSeconds: 30,
  reportRows: 2000,
  recordsPerMetric: 2000,
  spectrumRecords: 706,
  attackDetectorWindows: 300,
  progressEventsPerMetric: 128,
  spectrumSupportSamples: 2048,
  amplitude: 64,
  attackThresholdDb: 120,
  attackStrengthDb: 120 + 20 * Math.log10(64),
});

const finalizedMetricResults = new WeakSet();
const METRICS = ["level", "spectrum", "attacks"];
const LOCAL_REASONS = [
  "native_phase_unavailable",
  "analyzer_failed",
  "stalled",
  "malformed_record",
  "duplicate_mutation",
  "sequence_regression",
  "sequence_gap",
  "support_mismatch",
  "quota_overflow",
  "invalid_aggregate",
  "dependency_unsupported",
];
const SHARED_REASONS = [
  "owner_corruption",
  "clock_corruption",
  "source_corruption",
  "transport_corruption",
  "global_timeout",
];
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const uuid = (value) =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const optional = (value, fallback) => (value === undefined ? fallback : value);
const pair = (value) =>
  Array.isArray(value) &&
  value.length === 2 &&
  value.every((item) => finite(item) && item >= 0);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function invariant(condition, reason) {
  if (!condition) throw new Error(reason);
}

function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function ownerCopy(owner) {
  invariant(
    object(owner) &&
      uuid(owner.generation) &&
      integer(owner.nativeEpoch) &&
      owner.nativeEpoch > 0 &&
      owner.nativeEpoch <= 1000000 &&
      ((typeof owner.arm === "string" &&
        /^[A-Za-z0-9_.:-]{1,128}$/.test(owner.arm)) ||
        (integer(owner.arm) && owner.arm <= 2 ** 44 - 1)),
    "invalid_owner",
  );
  return freeze({
    generation: owner.generation,
    nativeEpoch: owner.nativeEpoch,
    arm: owner.arm,
  });
}

function sameOwner(left, right) {
  return (
    left?.generation === right.generation &&
    left?.nativeEpoch === right.nativeEpoch &&
    left?.arm === right.arm
  );
}

function budget(value, fallback, ceiling) {
  const result = optional(value, fallback);
  invariant(
    integer(result) && result > 0 && result <= ceiling,
    "invalid_budget",
  );
  return result;
}

function geometryBudgets(totalSamples, rowCount, sampleRate) {
  return {
    levelRecords: rowCount,
    spectrumRecords: Math.ceil(totalSamples / 2048) + 2,
    attackDetectorWindows: Math.ceil(
      totalSamples / Math.round(sampleRate / 10),
    ),
  };
}

/**
 * JS coordinate counterpart of packages/protocol/src/metric-listening-geometry.ts.
 * Coordinate arithmetic only: not physical source identity or timing proof.
 */
function createMetricListeningGeometry(input) {
  invariant(
    input && typeof input === "object" && !Array.isArray(input),
    "invalid_capture_envelope",
  );
  const { sampleRate, vectorSize, tempoBpm, startBeat, endBeat, startSample } =
    input;
  invariant(
    Object.keys(input).every((key) =>
      [
        "sampleRate",
        "vectorSize",
        "tempoBpm",
        "startBeat",
        "endBeat",
        "startSample",
      ].includes(key),
    ) &&
      [44100, 48000].includes(sampleRate) &&
      integer(vectorSize) &&
      vectorSize >= 1 &&
      vectorSize <= 1024 &&
      (vectorSize & (vectorSize - 1)) === 0 &&
      finite(tempoBpm) &&
      tempoBpm >= 20 &&
      tempoBpm <= 999 &&
      finite(startBeat) &&
      finite(endBeat) &&
      startBeat >= 0 &&
      endBeat >= 0 &&
      startBeat <= 1576800 &&
      endBeat <= 1576800 &&
      integer(startSample) &&
      startSample <= 2 ** 44 - 1,
    "invalid_capture_envelope",
  );
  const durationBeats = endBeat - startBeat;
  const samplesPerBeat = (sampleRate * 60) / tempoBpm;
  const totalSamples = Math.round(durationBeats * samplesPerBeat);
  const maximumBeats = (30 * tempoBpm) / 60;
  const coordinateRoundoff =
    2 * Number.EPSILON * Math.max(1, startBeat, endBeat);
  invariant(
    durationBeats > 0 &&
      durationBeats - maximumBeats <= coordinateRoundoff &&
      totalSamples >= 1 &&
      totalSamples <= METRIC_LIMITS.captureSeconds * sampleRate &&
      startSample + totalSamples <= 2 ** 44 - 1,
    "capture_duration_exceeded",
  );
  const sampleAt = (beat) =>
    startSample + Math.round((beat - startBeat) * samplesPerBeat);
  const rows = [];
  let position = startBeat;
  let gridIndex = Math.floor(startBeat / 0.25) + 1;
  while (position < endBeat) {
    invariant(rows.length < METRIC_LIMITS.reportRows, "report_quota_exceeded");
    const end = Math.min(gridIndex * 0.25, endBeat);
    const row = {
      startBeat: position,
      endBeat: end,
      startSample: sampleAt(position),
      endSample: sampleAt(end),
    };
    invariant(row.endSample > row.startSample, "non_monotonic_grid");
    rows.push(row);
    position = end;
    gridIndex++;
  }
  return freeze({
    ...input,
    schema: "metric-listening-geometry/v1",
    reportBeats: 0.25,
    totalSamples,
    endSample: startSample + totalSamples,
    rows,
    budgets: geometryBudgets(totalSamples, rows.length, sampleRate),
  });
}

/**
 * Global quarter-beat rows, independently rounded from capture startSample and
 * startBeat, not an earlier transport origin or a rounded hop. Frozen origin
 * operands identify a source; this arithmetic is not physical timing proof.
 */
function createMusicalGrid(input) {
  invariant(
    integer(input.originSample) &&
      input.originSample <= 2 ** 44 - 1 &&
      finite(input.originBeat),
    "invalid_capture_envelope",
  );
  const geometry = createMetricListeningGeometry({
    sampleRate: input.sampleRate,
    vectorSize: optional(input.vectorSize, 64),
    tempoBpm: input.tempo,
    startBeat: input.startBeat,
    endBeat: input.endBeat,
    startSample: input.captureStartSample,
  });
  invariant(
    geometry.endSample === input.captureEndSample,
    "capture_endpoint_mismatch",
  );
  const maxRows = budget(
    input.maxReportRows,
    METRIC_LIMITS.reportRows,
    METRIC_LIMITS.reportRows,
  );
  invariant(geometry.rows.length <= maxRows, "report_quota_exceeded");
  return freeze(
    geometry.rows.map((row, index) => ({
      ...row,
      index,
      clippedStart:
        index === 0 && input.startBeat * 4 !== Math.floor(input.startBeat * 4),
      clippedEnd:
        index === geometry.rows.length - 1 &&
        input.endBeat * 4 !== Math.floor(input.endBeat * 4),
    })),
  );
}

function normalizeLevel(record, rows) {
  if (
    !record ||
    typeof record !== "object" ||
    Array.isArray(record) ||
    Object.keys(record).some(
      (key) =>
        ![
          "owner",
          "sequence",
          "startSample",
          "endSample",
          "count",
          "peak",
          "sumSquares",
          "rms",
        ].includes(key),
    ) ||
    !integer(record.sequence) ||
    record.sequence < 1 ||
    !integer(record.startSample) ||
    !integer(record.endSample) ||
    !pair(record.peak) ||
    !integer(record.count) ||
    record.count !== record.endSample - record.startSample ||
    record.count === 0 ||
    own(record, "sumSquares") === own(record, "rms")
  )
    return { reason: "malformed_record" };
  const row = rows[record.sequence - 1];
  if (
    !row ||
    record.startSample !== row.startSample ||
    record.endSample !== row.endSample
  )
    return { reason: "support_mismatch" };
  const supplied = own(record, "sumSquares") ? record.sumSquares : record.rms;
  if (!pair(supplied)) return { reason: "malformed_record" };
  const sumSquares = own(record, "sumSquares")
    ? [...supplied]
    : supplied.map((rms) => rms * rms * record.count);
  for (let channel = 0; channel < 2; channel++) {
    const squaredPeak = record.peak[channel] ** 2;
    const maximum = squaredPeak * record.count;
    const tolerance = Math.max(1, maximum) * 1e-12;
    if (
      !finite(maximum) ||
      !finite(sumSquares[channel]) ||
      sumSquares[channel] > maximum + tolerance ||
      squaredPeak > sumSquares[channel] + tolerance
    )
      return { reason: "invalid_aggregate" };
  }
  return {
    record: freeze({
      sequence: record.sequence,
      startSample: record.startSample,
      endSample: record.endSample,
      count: record.count,
      peak: [...record.peak],
      sumSquares,
    }),
  };
}

function attackDeclaration(input, sampleRate, requested) {
  if (input === undefined) {
    invariant(!requested, "attack_configuration_required");
    return null;
  }
  const windowSamples = Math.round(sampleRate / 10);
  invariant(
    object(input) &&
      Object.keys(input).every((key) =>
        ["windowSamples", "thresholdDb", "minSpacingSamples"].includes(key),
      ) &&
      optional(input.windowSamples, windowSamples) === windowSamples &&
      finite(input.thresholdDb) &&
      input.thresholdDb >= 0 &&
      input.thresholdDb <= METRIC_LIMITS.attackThresholdDb &&
      integer(input.minSpacingSamples) &&
      input.minSpacingSamples <= 2 ** 44 - 1,
    "invalid_attack_configuration",
  );
  return freeze({
    name: "level-window-rise",
    version: 1,
    dependency: "level",
    inputSource: "independent-100ms-level-windows",
    windowSamples,
    thresholdDb: input.thresholdDb,
    minSpacingSamples: input.minSpacingSamples,
    units: "dB-rise",
  });
}

function normalizeDetectorLevel(raw, rows) {
  const normalized = normalizeLevel(raw, rows);
  if (normalized.reason) return normalized;
  const record = normalized.record;
  const rms = own(raw, "rms")
    ? [...raw.rms]
    : record.sumSquares.map((sum) => Math.sqrt(sum / record.count));
  if (
    record.peak.some((value) => value > METRIC_LIMITS.amplitude) ||
    rms.some(
      (value, channel) =>
        value > record.peak[channel] || value > METRIC_LIMITS.amplitude,
    )
  )
    return { reason: "invalid_aggregate" };
  return {
    record: freeze({
      ...record,
      inputLevel: { peak: [...record.peak], rms },
    }),
  };
}

function detectAttack(record, previous, algorithm) {
  const level = Math.max(
    ...record.inputLevel.rms.map((rms) =>
      rms <= 1e-6 ? -120 : 20 * Math.log10(rms),
    ),
  );
  const rise = level - previous.previousLevel;
  let riseHasAttack = rise <= 0 ? false : previous.riseHasAttack;
  let lastAttack = previous.lastAttack;
  const events = [];
  if (
    !riseHasAttack &&
    level > -120 &&
    rise > 0 &&
    rise >= algorithm.thresholdDb &&
    record.endSample - lastAttack >= algorithm.minSpacingSamples
  ) {
    events.push({ sample: record.endSample, strength: rise });
    lastAttack = record.endSample;
    riseHasAttack = true;
  }
  return {
    record: freeze({ ...record, events }),
    state: { previousLevel: level, lastAttack, riseHasAttack },
  };
}

function normalizeSpectrum(record, declaration, sampleRate, endSample) {
  if (
    !record ||
    typeof record !== "object" ||
    Array.isArray(record) ||
    Object.keys(record).some(
      (key) =>
        ![
          "owner",
          "sequence",
          "startSample",
          "endSample",
          "centroidHz",
          "energy",
        ].includes(key),
    ) ||
    !integer(record.sequence) ||
    record.sequence < 1 ||
    !integer(record.startSample) ||
    !integer(record.endSample) ||
    !finite(record.energy) ||
    record.energy < 0 ||
    (record.energy === 0
      ? record.centroidHz !== null
      : !finite(record.centroidHz) ||
        record.centroidHz < 0 ||
        record.centroidHz > sampleRate / 2)
  )
    return { reason: "malformed_record" };
  if (
    record.endSample - record.startSample !== declaration.supportSamples ||
    record.endSample !==
      declaration.firstEndSample +
        (record.sequence - 1) * declaration.hopSamples ||
    record.endSample > endSample
  )
    return { reason: "support_mismatch" };
  return {
    record: freeze({
      sequence: record.sequence,
      startSample: record.startSample,
      endSample: record.endSample,
      centroidHz: record.centroidHz,
      energy: record.energy,
    }),
  };
}

function spectralSummary(records) {
  let energy = 0;
  let centroidHz = null;
  for (const record of records) {
    if (record.energy === 0) continue;
    const next = energy + record.energy;
    if (!finite(next)) return null;
    // Convex update avoids overflowing centroid * energy.
    centroidHz =
      centroidHz === null
        ? record.centroidHz
        : centroidHz +
          (record.centroidHz - centroidHz) * (record.energy / next);
    energy = next;
  }
  return { frameCount: records.length, energy, centroidHz };
}

function missingRanges(expected, records, supportAt, reason, lastSequence) {
  const gaps = [];
  let first = null;
  for (let sequence = 1; sequence <= expected + 1; sequence++) {
    if (sequence <= expected && !records.has(sequence)) {
      first ??= sequence;
    } else if (first !== null) {
      gaps.push({
        firstSequence: first,
        lastSequence: sequence - 1,
        startSample: supportAt(first).startSample,
        endSample: supportAt(sequence - 1).endSample,
        reason: sequence - 1 < lastSequence ? "sequence_gap" : reason,
      });
      first = null;
    }
  }
  return gaps;
}

/**
 * createMetricTimelines(envelope, {now?, onEvent?})
 *
 * Envelope: owner {generation:JS-generation-UUID,nativeEpoch:1..1000000,arm},
 * originSample, originBeat,
 * sampleRate (44100/48000), vectorSize (default64), tempo [20,999], startBeat, endBeat,
 * captureStartSample, captureEndSample, requestedMetrics; optional spectrum
 * {supportSamples:2048,hopSamples:2048,firstEndSample:captureStartSample+2048},
 * maxReportRows, maxRecords {level?,spectrum?,attacks?}, and app-owned trace identifiers.
 *
 * ingestLevel({owner,sequence,startSample,endSample,count,peak:[L,R],
 *              sumSquares:[L,R] OR rms:[L,R]})
 * ingestDetectorLevel uses that same record shape for independent physical100ms
 * supports. Requested attacks require attacks:{thresholdDb,minSpacingSamples}
 * explicitly admitted from nativeMetricConfig; neither parameter is defaulted.
 * ingestSpectrum({owner,sequence,startSample,endSample,centroidHz,energy})
 * Sequence numbers are one-based in the declared full capture, including gaps.
 * Zero-energy FFT records use centroidHz:null; no record means no measurement.
 *
 * Ownership is checked before metric validation. Active foreign frames are fatal;
 * callbacks after finalize/cancel are explicitly rejected without touching data.
 * Sequence 1 is the first declared interval, not the first received record.
 * onEvent must be synchronous and nonthrowing; infrastructure errors propagate.
 * now must be a monotonic millisecond clock (injected by non-browser hosts).
 * A duplicate return is not a new admission; the caller may acknowledge the
 * already-retained sequence only when duplicate:true.
 *
 * Level input must already be genuinely accumulated on the supplied musical
 * rows. Detector input is never derived from those rows. Physical100ms input
 * must retain a trustworthy prefix; any missing/invalid input ends that family
 * without resetting detector state or inventing later empty event lists.
 * Production coordinates use verified native originCounter as both originSample
 * and captureStartSample. Retained local supports are normalized by the host
 * into that native-counter frame, never legacy host-derived timestamps.
 */
function createMetricTimelines(input, options = {}) {
  const grid = createMusicalGrid(input);
  const owner = ownerCopy(input.owner);
  // The controller must merge independently settled external analyzer evidence before parsing
  // this empty native result; it is not publishable by itself.
  const externalOnly =
    ["mel-bands", "source-bound-analyzers"].includes(input.externalOnly) &&
    input.requestedMetrics?.length === 0;
  invariant(
    Array.isArray(input.requestedMetrics) &&
      (input.externalOnly === undefined || externalOnly) &&
      (input.requestedMetrics.length > 0 || externalOnly) &&
      input.requestedMetrics.length <= METRICS.length &&
      new Set(input.requestedMetrics).size === input.requestedMetrics.length &&
      input.requestedMetrics.every((metric) => METRICS.includes(metric)),
    "invalid_requested_metrics",
  );
  const requestedMetrics = [...input.requestedMetrics];
  const attacks = attackDeclaration(
    input.attacks,
    input.sampleRate,
    requestedMetrics.includes("attacks"),
  );
  const detectorGrid = [];
  if (requestedMetrics.includes("attacks")) {
    for (
      let startSample = input.captureStartSample;
      startSample < input.captureEndSample;
      startSample += attacks.windowSamples
    ) {
      detectorGrid.push({
        startSample,
        endSample: Math.min(
          startSample + attacks.windowSamples,
          input.captureEndSample,
        ),
      });
    }
  }
  const spectrumInput = optional(input.spectrum, {});
  invariant(
    object(spectrumInput) &&
      Object.keys(spectrumInput).every((key) =>
        ["supportSamples", "hopSamples", "firstEndSample"].includes(key),
      ),
    "invalid_spectrum_declaration",
  );
  invariant(
    input.maxRecords === undefined ||
      (object(input.maxRecords) &&
        Object.keys(input.maxRecords).every((key) =>
          requestedMetrics.includes(key),
        )),
    "invalid_budget",
  );
  const declaration = {
    supportSamples: optional(
      spectrumInput.supportSamples,
      METRIC_LIMITS.spectrumSupportSamples,
    ),
    hopSamples: optional(spectrumInput.hopSamples, 2048),
    firstEndSample: optional(
      spectrumInput.firstEndSample,
      input.captureStartSample + METRIC_LIMITS.spectrumSupportSamples,
    ),
  };
  invariant(
    declaration.supportSamples === METRIC_LIMITS.spectrumSupportSamples &&
      integer(declaration.hopSamples) &&
      declaration.hopSamples > 0 &&
      declaration.hopSamples <= declaration.supportSamples &&
      (declaration.firstEndSample === null ||
        (integer(declaration.firstEndSample) &&
          declaration.firstEndSample > input.captureStartSample &&
          declaration.firstEndSample >= declaration.supportSamples &&
          declaration.firstEndSample <=
            input.captureStartSample + declaration.supportSamples)),
    "invalid_spectrum_declaration",
  );
  const expectedSpectrum =
    declaration.firstEndSample === null
      ? 0
      : Math.max(
          0,
          Math.floor(
            (input.captureEndSample - declaration.firstEndSample) /
              declaration.hopSamples,
          ) + 1,
        );
  const envelope = freeze({
    owner,
    originSample: input.originSample,
    originBeat: input.originBeat,
    sampleRate: input.sampleRate,
    vectorSize: optional(input.vectorSize, 64),
    tempo: input.tempo,
    startBeat: input.startBeat,
    endBeat: input.endBeat,
    captureStartSample: input.captureStartSample,
    captureEndSample: input.captureEndSample,
    trace: Object.fromEntries(
      ["traceId", "correlationId", "causationId"]
        .filter((key) => input[key] !== undefined)
        .map((key) => [key, input[key]]),
    ),
    requestedMetrics,
    spectrum: declaration,
    attacks,
  });
  const derivedBudgets = geometryBudgets(
    envelope.captureEndSample - envelope.captureStartSample,
    grid.length,
    envelope.sampleRate,
  );
  const limits = {};
  function expectedCount(metric) {
    return metric === "level"
      ? grid.length
      : metric === "spectrum"
        ? expectedSpectrum
        : detectorGrid.length;
  }
  for (const metric of requestedMetrics) {
    const expected = expectedCount(metric);
    const capacity =
      metric === "level"
        ? derivedBudgets.levelRecords
        : metric === "spectrum"
          ? derivedBudgets.spectrumRecords
          : derivedBudgets.attackDetectorWindows;
    limits[metric] = budget(input.maxRecords?.[metric], capacity, capacity);
    // Smaller explicit budgets are a pre-playback denial, not silent truncation.
    invariant(expected <= limits[metric], "metric_quota_exceeded");
  }
  invariant(
    object(options) &&
      Object.keys(options).every((key) => ["now", "onEvent"].includes(key)),
    "invalid_options",
  );
  const now = optional(options.now, () => globalThis.performance.now());
  const onEvent = optional(options.onEvent, () => {});
  invariant(
    typeof now === "function" && typeof onEvent === "function",
    "invalid_callbacks",
  );
  const startedAt = now();
  invariant(finite(startedAt), "invalid_receipt_clock");
  let lastTime = startedAt;
  let sealed = null;
  let sealing = false;
  let sharedFailure = null;
  let sourceSample = envelope.captureStartSample;
  const states = new Map(
    requestedMetrics.map((metric) => [
      metric,
      {
        records: new Map(),
        fingerprints: new Map(),
        sumSquares: [0, 0],
        spectralEnergy: 0,
        lastSequence: 0,
        failure: null,
        duplicateCount: 0,
        progressCount: 0,
        snapshot: null,
        firstReceiptMs: null,
        lastReceiptMs: null,
        startedMs: null,
        stoppedMs: null,
        detector:
          metric === "attacks"
            ? {
                previousLevel: -120,
                lastAttack: -Infinity,
                riseHasAttack: false,
              }
            : null,
      },
    ]),
  );
  const context = {};
  for (const key of ["traceId", "correlationId", "causationId"]) {
    if (input[key] !== undefined) {
      invariant(
        typeof input[key] === "string" &&
          /^[A-Za-z0-9_.:-]{1,128}$/.test(input[key]),
        "invalid_trace_identity",
      );
      context[key] = input[key];
    }
  }
  function time() {
    const value = now();
    const elapsedMs = value - startedAt;
    invariant(
      finite(value) &&
        value >= lastTime &&
        finite(elapsedMs) &&
        elapsedMs <= Number.MAX_SAFE_INTEGER,
      "invalid_receipt_clock",
    );
    lastTime = value;
    return elapsedMs;
  }
  function emit(stage, metricId, details = {}) {
    const event = freeze({
      ...context,
      stage,
      metricId,
      generation: owner.generation,
      nativeEpoch: owner.nativeEpoch,
      elapsedMs: time(),
      ...details,
    });
    onEvent(event);
    return event;
  }
  emit("queued", "capture");
  emit("started", "capture");
  for (const metric of requestedMetrics) {
    emit("queued", metric);
    states.get(metric).startedMs = emit("started", metric).elapsedMs;
  }
  if (
    requestedMetrics.includes("spectrum") &&
    declaration.firstEndSample === null
  )
    failMetric("spectrum", "native_phase_unavailable");

  function stateFor(metric) {
    invariant(states.has(metric), "metric_not_requested");
    return states.get(metric);
  }
  function reject(reason) {
    return freeze({ accepted: false, reason });
  }
  function failMetric(metric, reason) {
    const state = stateFor(metric);
    invariant(LOCAL_REASONS.includes(reason), "invalid_metric_failure_reason");
    if (sealed || sealing) return reject("sealed");
    if (state.failure) return reject("metric_terminal");
    state.failure = reason;
    state.stoppedMs = time();
    return reject(reason);
  }
  function failShared(reason) {
    invariant(SHARED_REASONS.includes(reason), "invalid_shared_failure_reason");
    if (sealed) return sealed;
    invariant(!sealing, "reentrant_finalization");
    sharedFailure = reason;
    return finish("failed");
  }
  function checkOwner(candidate) {
    if (!sameOwner(candidate, owner)) {
      failShared("owner_corruption");
      return false;
    }
    return true;
  }
  function ingest(metric, raw) {
    const state = stateFor(metric);
    if (sealed || sealing) return reject("sealed");
    if (!checkOwner(raw?.owner)) return reject("owner_corruption");
    if (state.failure) return reject("metric_terminal");
    const normalized =
      metric === "level"
        ? normalizeLevel(raw, grid)
        : metric === "attacks"
          ? normalizeDetectorLevel(raw, detectorGrid)
          : normalizeSpectrum(
              raw,
              declaration,
              envelope.sampleRate,
              envelope.captureEndSample,
            );
    const prior = state.records.get(raw.sequence);
    const fingerprint = normalized.record
      ? JSON.stringify(
          metric !== "spectrum"
            ? [
                normalized.record,
                own(raw, "rms") ? "rms" : "sumSquares",
                own(raw, "rms") ? raw.rms : raw.sumSquares,
              ]
            : normalized.record,
        )
      : null;
    if (prior) {
      if (
        fingerprint !== null &&
        state.fingerprints.get(raw.sequence) === fingerprint
      ) {
        state.duplicateCount = Math.min(
          Number.MAX_SAFE_INTEGER,
          state.duplicateCount + 1,
        );
        return freeze({
          accepted: false,
          duplicate: true,
          reason: "duplicate",
        });
      }
      return failMetric(metric, "duplicate_mutation");
    }
    if (state.records.size >= limits[metric])
      return failMetric(metric, "quota_overflow");
    if (normalized.reason) return failMetric(metric, normalized.reason);
    if (raw.sequence <= state.lastSequence)
      return failMetric(metric, "sequence_regression");
    if (metric === "attacks" && raw.sequence !== state.lastSequence + 1)
      return failMetric(metric, "sequence_gap");
    let record = normalized.record;
    if (metric === "spectrum" && !finite(state.spectralEnergy + record.energy))
      return failMetric(metric, "invalid_aggregate");
    if (
      metric !== "spectrum" &&
      [0, 1].some(
        (channel) =>
          !finite(state.sumSquares[channel] + record.sumSquares[channel]),
      )
    )
      return failMetric(metric, "invalid_aggregate");
    if (metric === "attacks") {
      const detected = detectAttack(record, state.detector, attacks);
      record = detected.record;
      state.detector = detected.state;
    }
    state.records.set(record.sequence, record);
    state.fingerprints.set(record.sequence, fingerprint);
    if (metric !== "spectrum")
      state.sumSquares = state.sumSquares.map(
        (sum, channel) => sum + record.sumSquares[channel],
      );
    else state.spectralEnergy += record.energy;
    state.lastSequence = record.sequence;
    const received = time();
    state.firstReceiptMs ??= received;
    state.lastReceiptMs = received;
    const stride = Math.max(
      1,
      Math.ceil(limits[metric] / METRIC_LIMITS.progressEventsPerMetric),
    );
    if (
      state.progressCount < METRIC_LIMITS.progressEventsPerMetric &&
      (state.records.size === 1 || state.records.size % stride === 0)
    ) {
      state.progressCount++;
      emit("progress", metric, {
        acceptedRecords: state.records.size,
        expectedRecords: expectedCount(metric),
        sequence: record.sequence,
        sourceEndSample: record.endSample,
      });
    }
    return freeze({ accepted: true, sequence: record.sequence });
  }

  function metricResult(metric, state, endedMs) {
    const records = [...state.records.values()];
    const expectedRecords = expectedCount(metric);
    const reason = state.failure ?? "missing_records";
    const supportAt = (sequence) => {
      if (metric === "level") return grid[sequence - 1];
      if (metric === "attacks") return detectorGrid[sequence - 1];
      const endSample =
        declaration.firstEndSample + (sequence - 1) * declaration.hopSamples;
      return { startSample: endSample - declaration.supportSamples, endSample };
    };
    const missing = missingRanges(
      expectedRecords,
      state.records,
      supportAt,
      reason,
      state.lastSequence,
    );
    const usable = records.length > 0;
    const status =
      !state.failure && missing.length === 0
        ? "completed"
        : usable
          ? "partial"
          : "failed";
    let summary = null;
    if (metric === "spectrum" && usable) summary = spectralSummary(records);
    if (metric === "level" && usable) {
      const count = records.reduce((sum, record) => sum + record.count, 0);
      const sumSquares = [0, 1].map((channel) =>
        records.reduce((sum, record) => sum + record.sumSquares[channel], 0),
      );
      summary = {
        count,
        sumSquares,
        peak: [0, 1].map((channel) =>
          records.reduce(
            (peak, record) => Math.max(peak, record.peak[channel]),
            0,
          ),
        ),
        rms: sumSquares.map((sum) => Math.sqrt(sum / count)),
      };
    }
    if (metric === "attacks" && usable) {
      const events = records.flatMap((record) => record.events);
      summary = {
        inputWindows: records.length,
        coveredSamples: records.reduce((sum, record) => sum + record.count, 0),
        eventCount: events.length,
        events,
      };
    }
    return {
      metricId: metric,
      status,
      usable,
      reason: status === "completed" ? null : reason,
      expectedRecords,
      acceptedRecords: records.length,
      duplicates: state.duplicateCount,
      firstReceiptMs: state.firstReceiptMs,
      lastReceiptMs: state.lastReceiptMs,
      startedMs: state.startedMs,
      endedMs: state.stoppedMs ?? endedMs,
      durationMs: (state.stoppedMs ?? endedMs) - state.startedMs,
      dependencies:
        metric === "attacks" ? ["independent-100ms-level-windows"] : [],
      algorithm:
        metric === "level"
          ? { id: "row-aligned-stereo-sufficient-statistics", version: 1 }
          : metric === "spectrum"
            ? {
                id: "endpoint-energy-weighted-centroid",
                version: 1,
                ...declaration,
              }
            : attacks,
      records,
      // These are analysis supports, not claims that overlapping FFT windows
      // measured every sample of a musical row.
      coverage: records.map(({ startSample, endSample }) => ({
        startSample,
        endSample,
      })),
      missing,
      summary,
      snapshot: state.snapshot,
    };
  }

  function project(metrics) {
    const spectrum = metrics.spectrum?.records ?? [];
    const buckets = grid.map(() => []);
    const expectedBuckets = grid.map(() => 0);
    let rowIndex = 0;
    if (metrics.spectrum) {
      for (let sequence = 1; sequence <= expectedSpectrum; sequence++) {
        const endSample =
          declaration.firstEndSample + (sequence - 1) * declaration.hopSamples;
        while (
          rowIndex < grid.length - 1 &&
          endSample >= grid[rowIndex].endSample
        )
          rowIndex++;
        expectedBuckets[rowIndex]++;
      }
    }
    rowIndex = 0;
    for (const record of spectrum) {
      // Internal endpoints belong to the following half-open row; the capture
      // endpoint alone belongs to the final row, so no frame is lost or doubled.
      while (
        rowIndex < grid.length - 1 &&
        record.endSample >= grid[rowIndex].endSample
      )
        rowIndex++;
      buckets[rowIndex].push(record);
    }
    return grid.map((row, index) => {
      const levelRecord = metrics.level
        ? states.get("level").records.get(index + 1)
        : undefined;
      const frames = buckets[index];
      const expectedHere = expectedBuckets[index];
      const summary = spectralSummary(frames);
      const overlapsRow = (support) =>
        support.startSample < row.endSample &&
        support.endSample > row.startSample;
      const ownsEndpoint = (sample) =>
        sample >= row.startSample &&
        (sample < row.endSample ||
          (index === grid.length - 1 && sample === row.endSample));
      const detectorInputs = metrics.attacks?.records.filter(overlapsRow) ?? [];
      const eventInputs =
        metrics.attacks?.records.filter((record) =>
          record.events.some((event) => ownsEndpoint(event.sample)),
        ) ?? [];
      const expectedInputs = metrics.attacks
        ? detectorGrid.filter(overlapsRow).length
        : 0;
      return {
        ...row,
        level: !metrics.level
          ? { availability: "not-requested" }
          : !levelRecord
            ? { availability: "missing" }
            : {
                availability: "available",
                ...levelRecord,
                rms: levelRecord.sumSquares.map((sum) =>
                  Math.sqrt(sum / levelRecord.count),
                ),
              },
        spectrum: !metrics.spectrum
          ? { availability: "not-requested" }
          : {
              availability: frames.length
                ? frames.length === expectedHere
                  ? "available"
                  : "partial"
                : declaration.firstEndSample === null
                  ? "unknown-phase"
                  : expectedHere === 0
                    ? "no-frame"
                    : "missing",
              expectedFrames: expectedHere,
              ...summary,
              supports: frames.map((frame) => ({
                sequence: frame.sequence,
                startSample: frame.startSample,
                endSample: frame.endSample,
                crossesRowBoundary:
                  frame.startSample < row.startSample ||
                  frame.endSample > row.endSample,
                crossesCaptureBoundary:
                  frame.startSample < envelope.captureStartSample,
              })),
              wholeRowMeasurement: false,
            },
        attacks: !metrics.attacks
          ? { availability: "not-requested" }
          : {
              availability:
                expectedInputs === 0
                  ? "no-frame"
                  : detectorInputs.length === expectedInputs
                    ? "available"
                    : detectorInputs.length === 0
                      ? "missing"
                      : "partial",
              expectedInputs,
              recordSequences: detectorInputs.map((record) => record.sequence),
              eventRecordSequences: eventInputs.map(
                (record) => record.sequence,
              ),
              supports: detectorInputs.map(({ startSample, endSample }) => ({
                startSample,
                endSample,
              })),
              events: eventInputs.flatMap((record) =>
                record.events.filter((event) => ownsEndpoint(event.sample)),
              ),
            },
      };
    });
  }
  function finish(forcedStatus) {
    if (sealed) return sealed;
    invariant(!sealing, "reentrant_finalization");
    sealing = true;
    const collectionEndedMs = time();
    emit("queued", "assembly");
    emit("started", "assembly");
    const metrics = Object.fromEntries(
      [...states].map(([metric, state]) => [
        metric,
        metricResult(metric, state, collectionEndedMs),
      ]),
    );
    const outcomes = Object.values(metrics);
    const status =
      forcedStatus ??
      (externalOnly
        ? "completed"
        : outcomes.every((metric) => metric.status === "completed") &&
            outcomes.some((metric) => metric.usable)
          ? "completed"
          : outcomes.some((metric) => metric.usable)
            ? "partial"
            : "failed");
    sealed = freeze({
      schema: "metric-timeline-result/v1",
      status,
      reason: sharedFailure,
      envelope,
      metrics,
      rows:
        status === "failed" || status === "cancelled" ? [] : project(metrics),
      elapsedMs: time(),
      budgets: {
        ...derivedBudgets,
        maxRecords: { ...limits },
        reportRows: grid.length,
      },
      limitations: [
        "FFT endpoints are projected; support is not exact within-row coverage.",
        "Attacks use independently retained physical100ms input, not musical-level summaries; event timestamps are detector support END.",
        "Shared source/transport integrity must be monitored by the caller.",
        "Sealing is not publication; caller owns deadlines, drain and cancellation precedence.",
        "Application-owned History logging, schema validation and publication require explicit host adapters.",
      ],
    });
    finalizedMetricResults.add(sealed);
    for (const [metric, outcome] of Object.entries(metrics)) {
      emit(
        status === "cancelled"
          ? "cancelled"
          : sharedFailure
            ? "failed"
            : outcome.status,
        metric,
        {
          acceptedRecords: outcome.acceptedRecords,
          expectedRecords: outcome.expectedRecords,
          missingRecords: outcome.expectedRecords - outcome.acceptedRecords,
          duplicates: outcome.duplicates,
          durationMs: outcome.durationMs,
          reason: sharedFailure ?? outcome.reason,
        },
      );
    }
    emit(status, "assembly", { reason: sharedFailure });
    emit(status, "capture", { reason: sharedFailure });
    return sealed;
  }

  return Object.freeze({
    envelope,
    grid,
    ingestLevel: (record) => ingest("level", record),
    ingestSpectrum: (record) => ingest("spectrum", record),
    ingestDetectorLevel: (record) => ingest("attacks", record),
    failMetric,
    failShared,
    // Readiness/control snapshots are never admitted as measurements.
    observeState(metric, snapshot) {
      const state = stateFor(metric);
      if (sealed || sealing) return reject("sealed");
      if (!checkOwner(snapshot?.owner)) return reject("owner_corruption");
      invariant(
        ["ready", "collecting", "stalled", "unavailable"].includes(
          snapshot.state,
        ),
        "invalid_metric_state",
      );
      state.snapshot = freeze({ state: snapshot.state, receivedMs: time() });
      return freeze({ accepted: true, measurement: false });
    },
    observeClock(clock) {
      if (sealed || sealing) return reject("sealed");
      if (!checkOwner(clock?.owner)) return reject("owner_corruption");
      if (
        clock.sampleRate !== envelope.sampleRate ||
        (clock.vectorSize !== undefined &&
          clock.vectorSize !== envelope.vectorSize) ||
        clock.tempo !== envelope.tempo ||
        clock.originSample !== envelope.originSample ||
        clock.originBeat !== envelope.originBeat ||
        !integer(clock.sourceSample) ||
        clock.sourceSample < sourceSample
      ) {
        failShared("clock_corruption");
        return reject("clock_corruption");
      }
      // The physical source clock may pass the capture endpoint while retained
      // records drain. Only measurement support is confined to the capture.
      sourceSample = clock.sourceSample;
      return freeze({ accepted: true, measurement: false });
    },
    progress() {
      return freeze({
        sealed: sealed !== null || sealing,
        sourceSample,
        metrics: Object.fromEntries(
          [...states].map(([metric, state]) => [
            metric,
            {
              acceptedRecords: state.records.size,
              lastSequence: state.lastSequence,
              failure: state.failure,
              snapshot: state.snapshot,
            },
          ]),
        ),
      });
    },
    finalize(proof) {
      if (sealed) return sealed;
      invariant(!sealing, "reentrant_finalization");
      if (!checkOwner(proof?.owner)) return sealed;
      if (proof.sourceEndSample !== envelope.captureEndSample)
        return failShared("clock_corruption");
      // The controller supplies source-coverage proof after its own shared
      // safety/deadline checks. A readiness snapshot is never that proof.
      return finish();
    },
    cancel() {
      return finish("cancelled");
    },
  });
}

const GAP_REASONS = Object.freeze({
  native_phase_unavailable: "unavailable",
  missing_records: "unavailable",
  analyzer_failed: "unavailable",
  stalled: "unavailable",
  malformed_record: "malformed-record",
  duplicate_mutation: "malformed-record",
  sequence_regression: "malformed-record",
  support_mismatch: "malformed-record",
  invalid_aggregate: "malformed-record",
  sequence_gap: "sequence-gap",
  quota_overflow: "overflow",
  dependency_unsupported: "dependency-unavailable",
});
const GAP_DETAILS = Object.freeze({
  unavailable: "The declared analysis support has no validated measurement.",
  "malformed-record":
    "Metric-local corruption stopped admission; validated prefix retained.",
  "sequence-gap": "A declared producer sequence was not received in order.",
  overflow:
    "The admitted metric capacity was exhausted; no record was silently discarded.",
  "dependency-unavailable":
    "The declared analysis dependency did not supply measurements.",
});

function unrequestedProtocolMetric() {
  return {
    status: "not-requested",
    algorithm: null,
    expectedRecords: 0,
    records: [],
    gaps: [],
    limitations: [],
  };
}

function protocolMetric(result, metric) {
  const internal = result.metrics[metric];
  if (!internal) return unrequestedProtocolMetric();
  const all =
    !(
      metric === "spectrum" && result.envelope.spectrum.firstEndSample === null
    ) &&
    internal.records.length === internal.expectedRecords &&
    internal.missing.length === 0;
  // The current public contract defines status by expected-slot completeness.
  // Do not conceal a collector health failure by upgrading partial to complete.
  invariant(
    (internal.status === "completed") === all,
    "metric_adapter_unrepresentable_metric_failure",
  );
  const support = (record) => ({
    startSample: record.startSample,
    endSample: record.endSample,
  });
  const gaps = internal.missing.map((missing) => {
    const reason = GAP_REASONS[missing.reason];
    invariant(reason !== undefined, "metric_adapter_unknown_gap_reason");
    return {
      firstIndex: missing.firstSequence - 1,
      count: missing.lastSequence - missing.firstSequence + 1,
      ...support(missing),
      reason,
      detail: `${GAP_DETAILS[reason]} Cause: ${missing.reason}.`,
    };
  });
  let algorithm;
  let records;
  if (metric === "level") {
    algorithm = {
      name: "sample-grid-peak-rms",
      version: 1,
      units: "linear-amplitude",
    };
    records = internal.records.map((record) => ({
      index: record.sequence - 1,
      support: support(record),
      peak: [...record.peak],
      rms: record.sumSquares.map((sum) => Math.sqrt(sum / record.count)),
    }));
  } else if (metric === "attacks") {
    algorithm = { ...result.envelope.attacks };
    records = internal.records.map((record) => ({
      index: record.sequence - 1,
      support: support(record),
      inputLevel: {
        peak: [...record.inputLevel.peak],
        rms: [...record.inputLevel.rms],
      },
      events: record.events.map((event) => ({ ...event })),
    }));
  } else {
    const declaration = result.envelope.spectrum;
    invariant(
      declaration.hopSamples === 2048,
      "metric_adapter_unsupported_spectrum_hop",
    );
    algorithm = {
      name: "fft-energy-centroid",
      version: 1,
      fftSamples: 2048,
      hopSamples: 2048,
      firstFrameEndSample: declaration.firstEndSample,
      units: "Hz",
    };
    records = internal.records.map((record) => ({
      index: record.sequence - 1,
      support: support(record),
      spectralEnergy: record.energy,
      centroidHz: record.centroidHz,
    }));
  }
  return {
    status: internal.status === "completed" ? "complete" : internal.status,
    expectedRecords: internal.expectedRecords,
    algorithm,
    records,
    gaps,
    limitations: [
      ...(metric === "spectrum" &&
      result.envelope.spectrum.firstEndSample === null
        ? ["FFT phase unavailable; timed supports cannot be established."]
        : []),
      ...(metric === "spectrum"
        ? [
            "FFT endpoints reference full native supports, not exact whole-row measurements.",
          ]
        : []),
      ...(internal.reason === null
        ? []
        : [`Collector outcome reason: ${internal.reason}.`]),
    ],
  };
}

/**
 * adaptMetricTimelineObservation(result, context, contract)
 *
 * Only fresh sealed results from this module are accepted; no legacy payload
 * reinterpretation, rehydration, metric dropping, clamping or silent reduction.
 * context must explicitly supply collectorOwner, public ownership, source,
 * sharedIntegrity:"validated", sourceCoverage and alignment from the trusted
 * capture coordinator. Geometry parsing is never promoted into those proofs.
 * Production originSample/captureStartSample/geometry.startSample identify the
 * same verified NATIVE SOURCE originCounter. Supports/events stay in that frame;
 * a preceding FFT support may cross capture start but remains nonnegative.
 * Legacy host offsets are diagnostics only, not a conversion or clock guess.
 * The native JS generation UUID is retained verbatim. Public ownership must
 * match that generation/nativeEpoch, with explicit collectorOwner arm binding;
 * native epoch or numeric DSP counters never stand in for the JS generation.
 *
 * contract = {schemaVersion:"metric-audio-observation/v1", parse,
 *             createReportRows, now?, onEvent?}. Inject the canonical protocol
 * schema's parse and createMetricObservationReportRows from the host. This
 * module does not import TypeScript, persist, publish, or wire application logs.
 * Callbacks are synchronous/nonthrowing; validation errors propagate unchanged.
 *
 * Attacks retain actual independently ingested inputLevel and replayed events.
 * context.attackAlgorithm is optional and, if supplied, must exactly match the
 * frozen admitted algorithm; it cannot change thresholds/cadence after capture.
 * Canonical rows retain separate support and event endpoint references.
 */
function adaptMetricTimelineObservation(result, context, contract) {
  invariant(
    contract?.schemaVersion === "metric-audio-observation/v1" &&
      typeof contract.parse === "function" &&
      typeof contract.createReportRows === "function",
    "metric_adapter_versioned_contract_required",
  );
  const now = optional(contract.now, () => globalThis.performance.now());
  const onEvent = optional(contract.onEvent, () => {});
  invariant(
    typeof now === "function" && typeof onEvent === "function",
    "invalid_callbacks",
  );
  const trusted = finalizedMetricResults.has(result);
  const eventContext = trusted
    ? {
        ...result.envelope.trace,
        generation: result.envelope.owner.generation,
        nativeEpoch: result.envelope.owner.nativeEpoch,
      }
    : {};
  const startedAt = now();
  invariant(finite(startedAt), "invalid_receipt_clock");
  let lastTime = startedAt;
  let terminal =
    trusted && result.status === "cancelled" ? "cancelled" : "failed";
  function emit(stage) {
    const value = now();
    const elapsedMs = value - startedAt;
    invariant(
      finite(value) &&
        value >= lastTime &&
        finite(elapsedMs) &&
        elapsedMs <= Number.MAX_SAFE_INTEGER,
      "invalid_receipt_clock",
    );
    lastTime = value;
    onEvent(
      freeze({
        ...eventContext,
        stage,
        metricId: "protocol-adapter",
        elapsedMs,
      }),
    );
  }
  emit("queued");
  emit("started");
  try {
    invariant(
      trusted && result.schema === "metric-timeline-result/v1",
      "metric_adapter_fresh_result_required",
    );
    invariant(
      result.status === "completed" ||
        result.status === "partial" ||
        (result.status === "failed" &&
          ["mel-bands", "source-bound-analyzers"].includes(
            context?.externalMetricAvailable,
          )),
      "metric_adapter_result_not_publishable",
    );
    invariant(
      context && typeof context === "object",
      "metric_adapter_invalid_context",
    );
    const { envelope } = result;
    invariant(
      sameOwner(context.collectorOwner, envelope.owner) &&
        context.ownership?.nativeEpoch === envelope.owner.nativeEpoch &&
        context.ownership?.generation === envelope.owner.generation,
      "metric_adapter_owner_binding_mismatch",
    );
    for (const key of ["traceId", "correlationId", "causationId"]) {
      invariant(
        own(envelope.trace, key) &&
          context.ownership[key] === envelope.trace[key],
        "metric_adapter_trace_mismatch",
      );
    }
    invariant(
      context.sharedIntegrity === "validated",
      "metric_adapter_shared_integrity_required",
    );
    // Structural coordinate binding, not physical proof: the host must obtain
    // originSample from the verified native source proof before this adapter.
    invariant(
      envelope.originSample === envelope.captureStartSample,
      "metric_adapter_native_source_origin_mismatch",
    );
    invariant(
      context.sourceCoverage?.startSample === envelope.captureStartSample &&
        context.sourceCoverage?.endSample === envelope.captureEndSample,
      "metric_adapter_source_coverage_mismatch",
    );
    const geometry = createMetricListeningGeometry({
      sampleRate: envelope.sampleRate,
      vectorSize: envelope.vectorSize,
      tempoBpm: envelope.tempo,
      startBeat: envelope.startBeat,
      endBeat: envelope.endBeat,
      startSample: envelope.captureStartSample,
    });
    const metrics = {
      level: protocolMetric(result, "level"),
      "spectral-centroid": protocolMetric(result, "spectrum"),
      attacks: protocolMetric(result, "attacks"),
    };
    if (result.metrics.attacks && context.attackAlgorithm !== undefined) {
      const expectedAlgorithm = result.envelope.attacks;
      invariant(
        object(context.attackAlgorithm) &&
          Object.keys(context.attackAlgorithm).length ===
            Object.keys(expectedAlgorithm).length &&
          Object.keys(expectedAlgorithm).every(
            (key) => context.attackAlgorithm[key] === expectedAlgorithm[key],
          ),
        "metric_adapter_attack_configuration_mismatch",
      );
    }
    const candidate = {
      schema: "metric-audio-observation/v1",
      outcome: result.status === "completed" ? "complete" : "partial",
      ownership: context.ownership,
      sharedIntegrity: context.sharedIntegrity,
      source: context.source,
      geometry,
      sourceCoverage: context.sourceCoverage,
      alignment: context.alignment,
      requestedMetrics: envelope.requestedMetrics.map((metric) =>
        metric === "spectrum" ? "spectral-centroid" : metric,
      ),
      metrics,
      rows: [],
      reduction: {
        mode: "none",
        originalReportRows: geometry.rows.length,
        retainedReportRows: geometry.rows.length,
        authoritativeTimelines: "retained",
      },
      limitations: [...result.limitations],
    };
    emit("progress");
    candidate.rows = contract.createReportRows(candidate);
    const observation = contract.parse(candidate);
    invariant(
      observation.schema === candidate.schema,
      "metric_adapter_contract_version_mismatch",
    );
    terminal = observation.outcome === "complete" ? "completed" : "partial";
    return freeze(observation);
  } finally {
    // Observe and rethrow failures; never downgrade parser/ownership exceptions
    // into success-shaped output or silently fall back to a legacy contract.
    emit(terminal);
  }
}

module.exports = Object.freeze({
  METRIC_LIMITS,
  createMetricListeningGeometry,
  createMusicalGrid,
  createMetricTimelines,
  adaptMetricTimelineObservation,
});
