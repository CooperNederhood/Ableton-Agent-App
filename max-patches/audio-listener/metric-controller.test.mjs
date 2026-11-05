import test from "node:test";
import assert from "node:assert/strict";
import { createRequire, Module } from "node:module";
import { compileNativeMetricProtocol } from "../../scripts/lib/native-metric-protocol-bundle.mjs";
import { genModel } from "./gen-model.mjs";
import { nativeRuntimeDocuments } from "./native-runtime-source.mjs";
import {
  retainedNativeSpectrumSource,
  retainedMusicalEnvelopeSource,
} from "./retained-native-source.mjs";
import { DESCRIPTIVE_CLOCK_CODE } from "./host-timing-source.mjs";
import { fftReference } from "./fft-reference.mjs";
import { metricRuntimeHarness } from "./metric-runtime-test-helpers.mjs";

const require = createRequire(import.meta.url);
const { NativeMessageIO } = require("./audio_listener_native_io.js");
const {
  createMetricController,
} = require("./audio_listener_metric_controller.js");
const { createMaxAdapter } = require("./audio_listener_metric_io.js");
const {
  createSpectralShapeSmoke,
} = require("./audio_listener_flatness_probe.js");
const {
  createMetricTimelines,
} = require("./audio_listener_metric_timelines.js");
const GENERATION = "11111111-1111-4111-8111-111111111111";

async function controllerHarness({
  suppressDetector = false,
  suppressCleanup = false,
  beforeCleanup,
  terminalThrow = false,
  onEvent,
  asyncControlResult,
  requestedMetrics = ["level", "attacks"],
  spectrumEnabled = false,
  spectrumPollMs = 10,
  spectrumReadsPerTick = 2,
  unavailableSpectrum = false,
  suppressSpectrumCleanup = false,
  engineeringRuntime = false,
  session = false,
} = {}) {
  const codec = await loadCodec();
  const sampleRate = 48000,
    vectorSize = 64,
    tempoBpm = 128;
  const startBeat = session ? 0 : 5.13,
    totalSamples = 9000;
  const endBeat = startBeat + (totalSamples * tempoBpm) / (sampleRate * 60);
  const geometry = codec.createMetricListeningGeometry({
    sampleRate,
    vectorSize,
    tempoBpm,
    startBeat,
    endBeat,
    startSample: 0,
  });
  const config = {
    scope: "independent-metric-timelines/v1",
    algorithmVersion: "3.0.0",
    mode: "arrangement",
    sourceEvidence: "transport-only",
    geometry,
    timingPolicy: { mode: "descriptive", maxClockDisagreementSamples: 64 },
    grid: {
      beats: 0.25,
      anchor: "global-beat-grid",
      rounding: "nearest-sample",
      coordinates: "capture-local",
    },
    requestedMetrics,
    ...(requestedMetrics.includes("attacks")
      ? { attacks: { thresholdDb: 6, minSpacingSamples: 4800 } }
      : {}),
    sourceContext: {
      view: "arrangement",
      target: { kind: "regular", index: 0, expectedReference: GENERATION },
      transport: { startBeat, endBeat },
    },
  };
  if (session) {
    const target = {
      view: "session",
      track: {
        kind: "regular",
        index: 0,
        expectedReference: GENERATION,
        expectedName: "Track",
      },
      sceneIndex: 0,
      expectedClipReference: GENERATION,
      expectedClipName: "Clip",
    };
    config.mode = "session";
    config.stoppedBeat = 2.059377861721612;
    config.sourceEvidence = "expected-context-only";
    config.source = {
      mode: "session",
      synchronization: "transport-coupled-first-iteration",
      target,
    };
    config.sourceContext = {
      view: "session",
      target,
      clipReference: GENERATION,
      kind: "midi",
      coordinate: { unit: "beats", iteration: 0, startBeat: 0, endBeat },
      transport: { startBeat, endBeat },
      clipStartTimeBeats: 0,
      synchronization: "transport-coupled-first-iteration",
    };
  }
  const command = {
    type: "listener.control",
    protocolVersion: 1,
    listenerVersion: 5,
    mode: config.mode,
    listenerId: GENERATION,
    connectionId: GENERATION,
    connectionEpoch: GENERATION,
    generation: GENERATION,
    requestId: "controller-request",
    jobId: "controller-job",
    passId: GENERATION,
    traceId: GENERATION,
    correlationId: GENERATION,
    causationId: GENERATION,
    sequence: 0,
  };
  const prepare = { ...command, action: "prepare", config };
  const arm = { ...command, action: "arm", sequence: 1 };
  const cancel = { ...command, action: "cancel", sequence: 2 };
  const model = genModel(retainedMusicalEnvelopeSource().code, 64, sampleRate);
  const clockModel = genModel(DESCRIPTIVE_CLOCK_CODE, 8, sampleRate);
  clockModel.configure({
    epoch: 7,
    totalSamples,
    hopSamples: 4800,
    tempoBpm,
    startBeatFraction: startBeat % 1,
    captureVector: vectorSize,
  });
  const controls = [],
    replies = [],
    results = [],
    deliveries = [],
    events = [],
    readbacks = [];
  let counter = -1,
    now = 0,
    output,
    sourceClock,
    playingOrigin = null;
  let polling = false,
    stoppedRequested = false,
    controller;
  const spectrumModel = spectrumEnabled
    ? genModel(
        `${retainedNativeSpectrumSource().code}\nout32 = sourceClock;`,
        32,
        sampleRate,
      )
    : null;
  const spectrumPackets = [],
    spectrumControls = [];
  const pcmLeft = new Float64Array(2048),
    pcmRight = new Float64Array(2048);
  let spectrumOutput,
    spectrumPolling = false;
  const spectrumIO = spectrumEnabled
    ? new NativeMessageIO(
        "spectrum",
        (packet) => {
          spectrumPackets.push([...packet]);
          controller.receiveNative("metric_spectrum", packet);
          return true;
        },
        (control) => {
          spectrumControls.push([...control]);
          if (control[0] === "poll") spectrumPolling = control[1] === 1;
          else spectrumModel.configure({ [control[0]]: control[1] });
        },
        () => {},
        { now: () => now },
      )
    : null;
  const adapter = createMaxAdapter({
    now: () => now,
    emit(index, packet) {
      if (index === 0) {
        controller.receiveNative("metric_envelope", packet);
      } else if (index === 1) {
        if (packet[0] === "poll") polling = packet[1] === 1;
        else model.configure({ [packet[0]]: packet[1] });
      } else if (packet[0] === "poll_frames") {
        if (suppressCleanup && stoppedRequested) return;
        for (const [selector, offset, width] of [
          ["metric_timing_sample", 0, 8],
          ["metric_configuration_sample", 8, 12],
          ["metric_level_sample", 20, 22],
          ["metric_detector_sample", 42, 22],
        ]) {
          if (suppressDetector && selector === "metric_detector_sample")
            continue;
          const bank = [
            sourceClock[1],
            ...output.slice(offset, offset + width),
            sourceClock[1],
          ];
          readbacks.push({ selector, bank });
          adapter.dispatch(selector, bank);
        }
      }
    },
  });
  const clockIO = new NativeMessageIO(
    "clock",
    (packet) => controller.receiveNative("clock", packet),
    () => {},
    (reason) => assert.fail(reason),
    { now: () => now },
  );
  const runtimeHarness = engineeringRuntime
    ? metricRuntimeHarness({
        controller: {
          snapshot: () => controller?.snapshot() ?? { state: "idle" },
        },
        engineeringEntry: true,
      })
    : null;
  controller = createMetricController({
    codec,
    ...(beforeCleanup ? { beforeCleanup } : {}),
    spectrumEnabled: runtimeHarness
      ? runtimeHarness.controllerOptions.spectrumEnabled
      : spectrumEnabled,
    now: () => now,
    sendControl(target, selector, args) {
      if (target === "metric_spectrum") {
        controls.push({ selector, args, counter, target });
        let accepted;
        if (selector === "begin") accepted = spectrumIO.begin(...args);
        else if (selector === "request_spectrum_stop")
          accepted = spectrumIO.requestSpectrumStop(...args);
        else if (selector === "release") accepted = spectrumIO.release(...args);
        else if (selector === "spectrum_cleanup_tick") {
          spectrumIO.spectrumCleanupTick(...args);
          accepted = true;
        } else if (selector === "spectrum_cleanup_evidence") {
          const evidence = spectrumIO.spectrumCleanupEvidence(...args);
          if (evidence && !suppressSpectrumCleanup)
            controller.receiveNative("metric_spectrum", [
              "native_metric_spectrum_cleanup",
              JSON.stringify(evidence),
            ]);
          accepted = true;
        } else assert.fail(selector);
        return asyncControlResult ? asyncControlResult(selector) : accepted;
      }
      assert.equal(target, "metric_envelope");
      assert.ok(Object.isFrozen(args));
      controls.push({ selector, args, counter });
      if (selector === "epoch") {
        model.configure({ epoch: args[0] });
        return asyncControlResult ? asyncControlResult(selector) : true;
      }
      if (selector === "stop") stoppedRequested = true;
      const accepted = adapter.dispatch(selector, args);
      return asyncControlResult ? asyncControlResult(selector) : accepted;
    },
    sendListenerReply(control, payload) {
      deliveries.push({ type: "reply", status: payload.status });
      replies.push({ control, payload, counter });
      return true;
    },
    sendListenerResult(control, payload) {
      deliveries.push({ type: "result", status: payload.status });
      if (terminalThrow && ["failed", "cancelled"].includes(payload.status))
        throw new Error("controlled_terminal_transport_failure");
      results.push({ control, payload, counter });
      return true;
    },
    onEvent(event) {
      events.push(event);
      runtimeHarness?.controllerOptions.onEvent(event);
      onEvent?.(event, controller, cancel);
    },
  });
  assert.equal(
    controller.prepare(prepare, {
      nativeEpoch: 7,
      deadlineMs: 10000,
      maxObservationBytes: 512 * 1024,
    }),
    true,
  );
  clockIO.begin(GENERATION, 7, sampleRate);
  clockIO.packet("dsp", [1, sampleRate, vectorSize], 3);
  clockIO.packet("tempo", [tempoBpm], 1);
  function step() {
    counter++;
    now = (counter * 1000) / sampleRate;
    const playing = playingOrigin !== null;
    const beat = playing
      ? startBeat + ((counter - playingOrigin) * tempoBpm) / (sampleRate * 60)
      : session
        ? config.stoppedBeat
        : startBeat;
    const phase = playing ? beat % 1 : 0.618;
    sourceClock = clockModel.step();
    assert.equal(sourceClock[1], counter);
    const inCapture = playing && counter - playingOrigin < totalSamples;
    output = model.step(
      phase,
      inCapture ? 0.25 : 0,
      inCapture ? 0.125 : 0,
      sourceClock[1],
    );
    if (spectrumModel) {
      const bin = counter % 2048;
      pcmLeft[bin] = inCapture ? 0.25 : 0;
      pcmRight[bin] = inCapture ? 0.125 : 0;
      if (bin === 2047) {
        const left = fftReference(pcmLeft),
          right = fftReference(pcmRight);
        for (let index = 0; index < 2048; index++) {
          const nativeCounter = counter - 2047 + index;
          spectrumOutput = spectrumModel.step(
            left.real[index],
            left.imag[index],
            right.real[index],
            right.imag[index],
            index,
            nativeCounter % 1048576,
            Math.floor(nativeCounter / 1048576),
          );
        }
      }
      if (
        spectrumPolling &&
        spectrumOutput &&
        counter % (48 * spectrumPollMs) === 0
      ) {
        spectrumIO.packet("fftInfo", [2048, 2048, 2048, 1]);
        spectrumIO.packet("abi-spectrum", [
          unavailableSpectrum ? 0 : spectrumOutput[10],
        ]);
        for (let read = 0; read < spectrumReadsPerTick; read++)
          spectrumIO.retainedSpectrumFrame(GENERATION, 7, [
            spectrumOutput[31],
            ...spectrumOutput.slice(11, 31),
            spectrumOutput[31],
          ]);
      }
    }
    if (counter % 16 === 0 && polling) adapter.dispatch("metric_poll", []);
    if (counter % vectorSize === 0) {
      const tuple = [Number(playing), beat, counter + 800000, 31];
      clockIO.anchorPre(tuple);
      clockIO.anchorClock([
        sourceClock[1],
        phase,
        sourceClock[1],
        sourceClock[7],
      ]);
      clockIO.anchorPost(tuple);
      controller.tick();
    }
  }
  function until(predicate, budget = 160000) {
    for (let n = 0; n < budget && !predicate(); n++) step();
    assert.ok(
      predicate(),
      JSON.stringify({
        snapshot: controller.snapshot(),
        adapter: adapter.snapshot(),
        replies: replies.map((r) => r.payload.status),
        controls: controls.slice(-8),
        lastEvent: events.at(-1),
      }),
    );
  }
  function launch() {
    until(() => replies.some((r) => r.payload.status === "ready"));
    controller.arm(arm);
    until(() => replies.some((r) => r.payload.status === "armed"));
    playingOrigin = counter + 1;
  }
  return {
    codec,
    controller,
    runtimeHarness,
    adapter,
    controls,
    replies,
    results,
    events,
    deliveries,
    spectrumIO,
    spectrumPackets,
    spectrumControls,
    readbacks,
    prepare,
    arm,
    cancel,
    config,
    step,
    until,
    launch,
    startPlayback() {
      playingOrigin = counter + 1;
    },
    get counter() {
      return counter;
    },
    get now() {
      return now;
    },
  };
}

async function untilAsync(h, predicate) {
  for (let block = 0; block < 2500 && !predicate(); block++) {
    for (let sample = 0; sample < 64; sample++) h.step();
    await Promise.resolve();
  }
  assert.ok(predicate(), JSON.stringify(h.controller.snapshot()));
}

test("production spectrum polling survives 30 ms scheduling and six seconds of post-arm inspection", async () => {
  const analysis = nativeRuntimeDocuments({ nativeVersion: 5 })[
    "audio_listener_native_analysis.maxpat"
  ];
  const readPair = analysis.patcher.boxes.find(
    ({ box }) => box.id === "metricSpectrumReadPair",
  )?.box;
  const f = await controllerHarness({
    spectrumEnabled: true,
    spectrumPollMs: 30,
    spectrumReadsPerTick: readPair?.numoutlets ?? 1,
    requestedMetrics: ["level", "spectral-centroid", "attacks"],
  });
  f.until(() => f.replies.some((reply) => reply.payload.status === "ready"));
  f.controller.arm(f.arm);
  f.until(() => f.replies.some((reply) => reply.payload.status === "armed"));
  for (let sample = 0; sample < 6 * 48000; sample++) f.step();
  f.startPlayback();
  f.until(() =>
    f.results.some((result) =>
      ["completed", "partial", "failed"].includes(result.payload.status),
    ),
  );
  const result = f.results.find((result) =>
    ["completed", "partial", "failed"].includes(result.payload.status),
  ).payload;
  assert.equal(result.status, "completed");
  assert.equal(
    result.observation.metrics["spectral-centroid"].status,
    "complete",
  );
  assert.equal(result.nativeSourceCoverage.spectrumCleanup.status, "completed");
});

for (const session of [false, true])
  test(`actual retained FFT -> controller -> complete metrics and cleanup, Session reset=${session}`, async () => {
    const f = await controllerHarness({
      spectrumEnabled: true,
      session,
      requestedMetrics: ["level", "spectral-centroid", "attacks"],
    });
    f.launch();
    f.until(() =>
      f.results.some((r) =>
        ["completed", "partial", "failed"].includes(r.payload.status),
      ),
    );
    const result = f.results.find((r) =>
      ["completed", "partial", "failed"].includes(r.payload.status),
    ).payload;
    assert.equal(
      result.status,
      "completed",
      JSON.stringify({ result, snapshot: f.controller.snapshot() }),
    );
    const spectrum = result.observation.metrics["spectral-centroid"];
    assert.equal(spectrum.status, "complete");
    assert.equal(spectrum.records.length, spectrum.expectedRecords);
    assert(spectrum.records.length > 0);
    assert(spectrum.records.some((record) => record.spectralEnergy > 0));
    const retention = f.events.filter(
      (event) =>
        event.nativeLifecycle.reason === "native_spectrum_retention_evidence",
    );
    assert(
      retention.length > 0,
      "successful captures must retain comparable reader evidence",
    );
    for (const event of retention) {
      assert.equal(event.traceId, f.prepare.traceId);
      assert.equal(event.correlationId, f.prepare.correlationId);
      assert.equal(event.nativeLifecycle.generation, f.prepare.generation);
      assert.equal(event.nativeLifecycle.stage, "progress");
      assert.equal(event.nativeLifecycle.facts.length, 12);
      const facts = Object.fromEntries(
        event.nativeLifecycle.facts.map((fact) => [fact.field, fact.actual]),
      );
      assert.equal(facts["capture.spectrum.retention.fault"].value, 0);
      assert(facts["capture.spectrum.retention.backlog"].value >= 0);
    }
    assert(result.nativeSourceCoverage.spectrumPhase);
    assert.equal(
      result.nativeSourceCoverage.spectrumCleanup.status,
      "completed",
    );
    assert.equal(f.spectrumIO.generation, null);
    assert.equal(
      f.spectrumControls.filter(
        (c) => c[0] === "measurementEpoch" && c[1] === 0,
      ).length,
      1,
    );
  });

test("retention diagnostic delivery failure remains an explicit failure with owned cleanup", async () => {
  const f = await controllerHarness({
    spectrumEnabled: true,
    requestedMetrics: ["level", "spectral-centroid", "attacks"],
    onEvent(event) {
      if (event.nativeLifecycle.reason === "native_spectrum_retention_evidence")
        throw new Error("controlled diagnostic rejection");
    },
  });
  f.until(() => f.replies.some((reply) => reply.payload.status === "ready"));
  f.controller.arm(f.arm);
  f.until(() => f.replies.some((reply) => reply.payload.status === "failed"));
  assert.equal(f.controller.snapshot().reason, "metric_event_delivery_failed");
  assert.equal(f.controller.snapshot().cleanup, "completed");
  assert.equal(f.spectrumIO.generation, null);
});

test("unavailable FFT declaration remains a local partial result with genuine FFT cleanup", async () => {
  const f = await controllerHarness({
    spectrumEnabled: true,
    unavailableSpectrum: true,
    requestedMetrics: ["level", "spectral-centroid", "attacks"],
  });
  f.launch();
  f.until(() =>
    f.results.some((r) =>
      ["completed", "partial", "failed"].includes(r.payload.status),
    ),
  );
  const result = f.results.find((r) =>
    ["completed", "partial", "failed"].includes(r.payload.status),
  ).payload;
  assert.equal(
    result.status,
    "partial",
    JSON.stringify({ result, snapshot: f.controller.snapshot() }),
  );
  assert.equal(result.observation.metrics.level.status, "complete");
  assert.equal(
    result.observation.metrics["spectral-centroid"].algorithm
      .firstFrameEndSample,
    null,
  );
  assert.equal(result.nativeSourceCoverage.spectrumCleanup.status, "completed");
  assert.equal(f.spectrumIO.generation, null);
});

test("requested spectrum without proven phase publishes honest partial data without blocking level or attacks", async () => {
  const h = await controllerHarness({
    requestedMetrics: ["level", "spectral-centroid", "attacks"],
    engineeringRuntime: true,
  });
  h.launch();
  h.until(() => h.controller.snapshot().state === "partial");
  const result = h.results.find((r) => r.payload.status === "partial").payload;
  assert.equal(result.observation.metrics.level.status, "complete");
  assert.equal(result.observation.metrics.attacks.status, "complete");
  assert.equal(
    result.observation.metrics["spectral-centroid"].status,
    "failed",
  );
  assert.equal(
    result.observation.metrics["spectral-centroid"].algorithm
      .firstFrameEndSample,
    null,
  );
  assert.ok(
    result.observation.rows.every(
      (row) => row["spectral-centroid"].availability === "unknown-phase",
    ),
  );
  assert.equal(h.controller.snapshot().cleanup, "completed");
  assert.equal(
    h.controls.some((control) => control.target === "metric_spectrum"),
    false,
  );
  assert.ok(result.observation.metrics.level.records.length > 0);
  assert.ok(result.observation.metrics.attacks.records.length > 0);
  for (const record of result.observation.metrics.level.records) {
    assert.deepEqual(record.peak, [0.25, 0.125]);
    assert.deepEqual(record.rms, [0.25, 0.125]);
  }
  assert.deepEqual(result.observation.metrics["spectral-centroid"].records, []);
  assert.equal(h.controller.snapshot().spectrum.started, false);
  assert.equal(h.controller.snapshot().spectrum.receivedRecords, 0);
  assert.equal(h.controller.snapshot().spectrum.acceptedRecords, 0);
  assert.equal(result.nativeSourceCoverage.spectrumCleanup, undefined);
  assert.equal(result.nativeSourceCoverage.spectrumPhase, undefined);
  for (const record of result.observation.metrics.attacks.records) {
    assert.deepEqual(record.inputLevel.rms, [0.25, 0.125]);
  }
  assert.ok(
    h.events.some(
      (e) =>
        e.nativeLifecycle.metric === "spectral-centroid" &&
        e.nativeLifecycle.stage === "failed",
    ),
  );
  const marker = h.runtimeHarness.logs.find(
    (row) =>
      row.event === "native_metric_engineering_fixture" &&
      row.fixture === "native5-unavailable-spectrum/v1",
  );
  assert.ok(marker);
  const attributed = h.runtimeHarness.diagnostics.find(
    ({ payload }) => payload.causationId === marker.eventId,
  );
  assert.ok(attributed);
  h.codec.nativeMetricLifecycleSchema.parse(attributed.payload);
  await h.runtimeHarness.runtime.stop();
});

test("engineering unavailable-spectrum fixture cancellation still executes real envelope cleanup without publishing", async () => {
  let cancelled = false;
  const h = await controllerHarness({
    engineeringRuntime: true,
    requestedMetrics: ["level", "spectral-centroid", "attacks"],
    onEvent(event, controller, command) {
      if (
        !cancelled &&
        event.nativeLifecycle.metric === "level" &&
        event.nativeLifecycle.stage === "completed"
      ) {
        cancelled = true;
        controller.cancel(command);
      }
    },
  });
  h.launch();
  h.until(() => h.controller.snapshot().state === "cancelled");
  assert.equal(h.controller.snapshot().cleanup, "completed");
  assert.equal(h.controller.snapshot().spectrum.started, false);
  assert.equal(
    h.results.some(({ payload }) => payload.observation),
    false,
  );
  assert.equal(h.controls.at(-1).selector, "release");
  await h.runtimeHarness.runtime.stop();
});

test("a spectrum-only request with unavailable phase fails before arming and confirms owned cleanup", async () => {
  const h = await controllerHarness({
    requestedMetrics: ["spectral-centroid"],
    engineeringRuntime: true,
  });
  h.until(() => h.controller.snapshot().state === "failed");
  assert.equal(
    h.controller.snapshot().inputFailureReason,
    "metric_no_requested_metric_available",
  );
  assert.equal(h.controller.snapshot().cleanup, "completed");
  assert.equal(
    h.replies.some(
      (r) => r.payload.status === "ready" || r.payload.status === "armed",
    ),
    false,
  );
  assert.equal(
    h.controls.some((control) => control.selector === "arm"),
    false,
  );
  assert.equal(
    h.results.some((r) => r.payload.observation),
    false,
  );
  await h.runtimeHarness.runtime.stop();
});

test("engineering partial fixture cannot publish healthy data when actual envelope cleanup is unconfirmed", async () => {
  const h = await controllerHarness({
    engineeringRuntime: true,
    requestedMetrics: ["level", "spectral-centroid", "attacks"],
    suppressCleanup: true,
  });
  h.launch();
  h.until(() => h.controller.snapshot().state === "failed");
  assert.equal(h.controller.snapshot().cleanup, "failed");
  assert.equal(h.controller.snapshot().spectrum.started, false);
  assert.equal(
    h.results.some(({ payload }) => payload.observation),
    false,
  );
  await assert.rejects(
    h.runtimeHarness.runtime.stop(),
    /native_cleanup_unconfirmed/,
  );
});

test("asynchronous Max query delivery cannot starve readiness, arming or publication", async () => {
  const h = await controllerHarness({
    asyncControlResult: () => Promise.resolve(true),
  });
  await untilAsync(h, () =>
    h.replies.some((r) => r.payload.status === "ready"),
  );
  h.controller.arm(h.arm);
  await untilAsync(h, () =>
    h.replies.some((r) => r.payload.status === "armed"),
  );
  h.startPlayback();
  await untilAsync(h, () =>
    h.results.some((r) => r.payload.status === "completed"),
  );
  assert.equal(h.adapter.snapshot().cleanup, "completed");
});

test("asynchronous query rejection remains fatal and preserves executed cleanup", async () => {
  let rejected = false;
  const h = await controllerHarness({
    asyncControlResult: (selector) => {
      if (selector === "metric_status" && !rejected) {
        rejected = true;
        return Promise.reject(new Error("query delivery rejected"));
      }
      return Promise.resolve(true);
    },
  });
  await untilAsync(h, () => h.controller.snapshot().state === "failed");
  assert.equal(
    h.controller.snapshot().inputFailureReason,
    "metric_control_delivery_failed",
  );
  assert.equal(h.controller.snapshot().cleanup, "completed");
  assert.equal(
    h.results.some((r) => r.payload.observation),
    false,
  );
});

test("cancellation with asynchronous query delivery releases the real native owner without publishing", async () => {
  const h = await controllerHarness({
    asyncControlResult: () => Promise.resolve(true),
  });
  await untilAsync(h, () =>
    h.replies.some((r) => r.payload.status === "ready"),
  );
  h.controller.cancel(h.cancel);
  await untilAsync(h, () => h.controller.snapshot().state === "cancelled");
  assert.equal(h.controller.snapshot().cleanup, "completed");
  assert.equal(
    h.results.some((r) => r.payload.observation),
    false,
  );
});

test("musical acquisition skip diagnostics preserve bounded operands, ownership and trace", async () => {
  const h = await controllerHarness();
  h.until(() => h.replies.some((r) => r.payload.status === "ready"));
  const body = {
    owner: h.adapter.snapshot().owner,
    nativeEpoch: h.controller.snapshot().nativeEpoch,
    family: "control",
    status: "progress",
    reason: "readback_cohort_skipped",
    progress: {
      bank: "metric_configuration_sample",
      skipped: 1,
      counterBefore: h.counter,
      counterAfter: h.counter + 64,
    },
  };
  assert.equal(
    h.controller.receiveNative("metric_envelope", [
      "native_metric",
      JSON.stringify(body),
    ]),
    true,
  );
  const event = h.events.at(-1);
  assert.equal(event.nativeLifecycle.reason, "native_metric_cohort_skipped");
  assert.equal(event.traceId, h.prepare.traceId);
  assert.equal(event.nativeLifecycle.generation, h.prepare.generation);
  assert.equal(event.nativeLifecycle.facts.length, 4);
  body.progress.skipped = 1000001;
  assert.equal(
    h.controller.receiveNative("metric_envelope", [
      "native_metric",
      JSON.stringify(body),
    ]),
    false,
  );
  h.until(() => h.controller.snapshot().state === "failed");
  assert.equal(
    h.controller.snapshot().inputFailureReason,
    "metric_invalid_readback_skip_evidence",
  );
  assert.equal(h.controller.snapshot().cleanup, "completed");
});

test("controller real retained Gen and Max prefix -> canonical ready/arm/source/complete level+attacks, then genuine cleanup", async () => {
  const h = await controllerHarness();
  h.launch();
  h.until(() =>
    ["completed", "partial", "failed"].includes(h.controller.snapshot().state),
  );
  assert.equal(h.controller.snapshot().state, "completed");
  assert.equal(h.controller.snapshot().cleanup, "completed");
  const final = h.results.find((r) => r.payload.status === "completed");
  assert.ok(final);
  const observation = final.payload.observation;
  assert.deepEqual(observation.requestedMetrics, ["level", "attacks"]);
  assert.equal(observation.metrics.level.status, "complete");
  assert.equal(observation.metrics.attacks.status, "complete");
  assert.equal(
    observation.metrics["spectral-centroid"].status,
    "not-requested",
  );
  assert.equal(
    observation.sourceCoverage.endSample -
      observation.sourceCoverage.startSample,
    9000,
  );
  for (const record of observation.metrics.level.records) {
    assert.deepEqual(record.peak, [0.25, 0.125]);
    assert.deepEqual(record.rms, [0.25, 0.125]);
  }
  assert.equal(
    observation.metrics.level.records.reduce(
      (n, r) => n + r.support.endSample - r.support.startSample,
      0,
    ),
    9000,
  );
  assert.deepEqual(
    final.payload.nativeSourceCoverage.armed,
    h.replies.find((r) => r.payload.status === "armed").payload.nativeArm,
  );
  assert.equal(final.payload.nativeSourceCoverage.after.frames.length, 32);
  assert.ok(h.controls.some((c) => c.selector === "metric_prefix_record"));
  assert.equal(h.controls.filter((c) => c.selector === "arm").length, 1);
  assert.equal(h.controls.at(-1).selector, "release");
  assert.ok(h.controls.at(-1).counter < final.counter + 1);
  for (let index = 0; index < h.events.length; index++) {
    const event = h.events[index];
    h.codec.nativeMetricLifecycleSchema.parse(event.nativeLifecycle);
    assert.equal(event.traceId, h.prepare.traceId);
    assert.equal(event.correlationId, h.prepare.correlationId);
    assert.equal(
      event.nativeLifecycle.causationId,
      index === 0
        ? h.prepare.causationId
        : h.events[index - 1].nativeLifecycle.eventId,
    );
  }
  const at = (phase, stage) =>
    h.events.findIndex(
      (e) => e.phase === phase && e.nativeLifecycle.stage === stage,
    );
  assert.ok(at("launch", "completed") < at("capture", "queued"));
  assert.ok(at("post-binding", "completed") < at("cleanup", "started"));
});

for (const [selector, fields] of [
  [
    "native_metric_evidence",
    { type: "native-metric-envelope-evidence/v1", diagnosticOnly: true },
  ],
  ["native_metric_status", { state: "failed" }],
  ["native_metric", { family: "control", status: "failed" }],
])
  test(`controller preserves the owned IO failure reason from ${selector}`, async () => {
    const h = await controllerHarness();
    h.until(() => h.replies.some((reply) => reply.payload.status === "ready"));
    const owner = Object.fromEntries(
      [
        "generation",
        "passId",
        "connectionEpoch",
        "traceId",
        "correlationId",
        "causationId",
      ].map((field) => [field, h.prepare[field]]),
    );
    h.controller.receiveNative("metric_envelope", [
      selector,
      JSON.stringify({
        owner,
        nativeEpoch: h.controller.snapshot().nativeEpoch,
        ...fields,
        reason: "invalid_timing_abi",
      }),
    ]);
    h.until(() => h.controller.snapshot().state === "failed");
    assert.equal(
      h.controller.snapshot().inputFailureReason,
      "invalid_timing_abi",
    );
    assert.equal(h.controller.snapshot().cleanup, "completed");
    assert.ok(!h.results.some(({ payload }) => payload.observation));
  });

test("controller retains complete loudness when the independent detector is unavailable, with honest partial context", async () => {
  const h = await controllerHarness({ suppressDetector: true });
  h.launch();
  h.until(() => ["partial", "failed"].includes(h.controller.snapshot().state));
  assert.equal(h.controller.snapshot().state, "partial");
  assert.equal(h.controller.snapshot().cleanup, "completed");
  const final = h.results.find((r) => r.payload.status === "partial");
  assert.ok(final);
  assert.equal(final.payload.observation.metrics.level.status, "complete");
  assert.equal(final.payload.observation.metrics.attacks.status, "failed");
  assert.equal(final.payload.observation.metrics.level.records.length, 3);
  assert.equal(
    final.payload.observation.metrics["spectral-centroid"].status,
    "not-requested",
  );
});

test("controller cancel before publication keeps real cleanup and delivers cancel result before its actual reply", async () => {
  let cancelled = false;
  const h = await controllerHarness({
    onEvent(event, controller, command) {
      if (
        !cancelled &&
        event.nativeLifecycle.metric === "level" &&
        event.nativeLifecycle.stage === "completed"
      ) {
        cancelled = true;
        assert.equal(controller.cancel(command), true);
      }
    },
  });
  h.launch();
  h.until(() =>
    ["cancelled", "failed", "completed"].includes(
      h.controller.snapshot().state,
    ),
  );
  assert.equal(cancelled, true);
  assert.equal(h.controller.snapshot().state, "cancelled");
  assert.equal(h.controller.snapshot().cleanup, "completed");
  assert.equal(
    h.results.filter((r) => ["completed", "partial"].includes(r.payload.status))
      .length,
    0,
  );
  assert.equal(h.results.at(-1).payload.status, "cancelled");
  assert.equal(h.results.at(-1).control.action, "cancel");
  assert.equal(h.replies.at(-1).payload.status, "cancelled");
  assert.equal(h.replies.at(-1).control.action, "cancel");
  assert.deepEqual(
    h.deliveries.filter((d) => d.status === "cancelled").map((d) => d.type),
    ["result", "reply"],
  );
});

test("controller never publishes when a stop setter executes but its genuine cleanup readback is missing", async () => {
  const h = await controllerHarness({ suppressCleanup: true });
  h.launch();
  h.until(() => h.controller.snapshot().state === "failed");
  assert.equal(h.controller.snapshot().cleanup, "failed");
  assert.equal(h.controller.snapshot().reason, "metric_cleanup_unconfirmed");
  assert.equal(
    h.controls.some((c) => c.selector === "stop"),
    true,
  );
  assert.equal(
    h.controls.some((c) => c.selector === "release"),
    false,
  );
  assert.equal(
    h.results.filter((r) => ["completed", "partial"].includes(r.payload.status))
      .length,
    0,
  );
});

test("unconfirmed shared SpectralShape message-gate cleanup blocks otherwise healthy native publication", async () => {
  let attempts = 0;
  const h = await controllerHarness({
    beforeCleanup: () => {
      attempts++;
      return false;
    },
  });

  h.launch();
  h.until(() => h.controller.snapshot().state === "failed");
  assert.ok(attempts > 0);
  assert.equal(h.controller.snapshot().reason, "metric_cleanup_unconfirmed");
  assert.equal(h.controller.snapshot().cleanup, "failed");
  assert.equal(
    h.results.filter((r) => ["completed", "partial"].includes(r.payload.status))
      .length,
    0,
  );
});

test("production smoke coordination preserves native results and executes native cleanup on every shared failure", async () => {
  for (const mode of [
    "healthy",
    "spread-invalid",
    "rolloff-invalid",
    "flatness-invalid",
    "unconfirmed",
    "observer-throw",
    "cancel",
    "dispose",
  ]) {
    let h;
    const smokeControls = [];
    const diagnostics = [];
    const smoke = createSpectralShapeSmoke({
      now: () => h?.now ?? 0,
      emit(_owner, event) {
        diagnostics.push(event);
        if (
          mode === "observer-throw" &&
          event.reason === "spread_smoke_cleanup" &&
          event.stage === "queued"
        )
          throw new Error("spread_diagnostic_delivery_failed");
        return true;
      },
      sendControl(kind, generation, epoch) {
        smokeControls.push(kind);
        if (kind === "begin") {
          smoke.receive([
            generation,
            epoch,
            "started",
            "fluid.spectralshape~",
            "fluid.spectralshape~",
          ]);
          smoke.receive([
            generation,
            epoch,
            "value",
            0,
            1,
            mode === "spread-invalid" ? -1 : 1000,
            mode === "rolloff-invalid" ? -1 : 7000,
            mode === "flatness-invalid" ? 1 : -40,
          ]);
          smoke.receive([generation, epoch, "value", 1, 1, 3000, 9000, -3]);
        } else if (mode !== "unconfirmed")
          smoke.receive([generation, epoch, "stopped"]);
      },
    });
    h = await controllerHarness({
      spectrumEnabled: true,
      requestedMetrics: ["level", "spectral-centroid", "attacks"],
      beforeCleanup: (control, cancelled) => smoke.stop(control, cancelled),
      onEvent(event) {
        if (
          event.phase === "launch" &&
          event.nativeLifecycle.stage === "completed" &&
          !event.nativeLifecycle.metric
        )
          smoke.start(
            event.control,
            event.nativeLifecycle.nativeEpoch,
            event.nativeLifecycle.eventId,
            event.nativeLifecycle.elapsedMs,
          );
      },
    });
    h.launch();
    h.until(() => smokeControls.includes("begin"));
    if (mode === "cancel") h.controller.cancel(h.cancel);
    if (mode === "dispose") h.controller.dispose();
    h.until(() =>
      ["completed", "partial", "failed", "cancelled"].includes(
        h.controller.snapshot().state,
      ),
    );
    assert.deepEqual(smokeControls, ["begin", "stop"], mode);
    assert.ok(
      h.controls.some(({ selector }) => selector === "stop"),
      mode,
    );
    const snapshot = h.controller.snapshot();
    if (
      [
        "healthy",
        "spread-invalid",
        "rolloff-invalid",
        "flatness-invalid",
      ].includes(mode)
    ) {
      assert.equal(snapshot.state, "completed", mode);
      const result = h.results.find(
        ({ payload }) => payload.status === "completed",
      );
      assert.ok(result, mode);
      assert.deepEqual(Object.keys(result.payload.observation.metrics).sort(), [
        "attacks",
        "level",
        "spectral-centroid",
      ]);
      const healthy = mode === "flatness-invalid" ? "spread" : "flatness";
      assert.ok(
        diagnostics.some(
          (event) =>
            event.reason === `${healthy}_smoke_capture` &&
            event.stage === "completed",
        ),
        mode,
      );
    } else {
      assert.ok(
        !h.results.some(({ payload }) =>
          ["completed", "partial"].includes(payload.status),
        ),
        mode,
      );
      assert.equal(
        snapshot.state,
        mode === "cancel" ? "cancelled" : "failed",
        mode,
      );
    }
    assert.equal(
      snapshot.cleanup,
      mode === "unconfirmed" ? "failed" : "completed",
      mode,
    );
    if (mode === "unconfirmed")
      assert.equal(snapshot.reason, "metric_cleanup_unconfirmed");
    if (mode === "observer-throw")
      assert.equal(snapshot.reason, "metric_diagnostic_cleanup_failed");
  }
});

test("throwing diagnostic cleanup cannot bypass native stop or the cleanup deadline", async () => {
  let firstAttempt;
  const h = await controllerHarness({
    beforeCleanup: () => {
      firstAttempt ??= h.now;
      throw new Error("flatness_diagnostic_delivery_failed");
    },
  });
  h.launch();
  h.until(() => h.controller.snapshot().state === "failed");
  assert.equal(h.controller.snapshot().reason, "metric_cleanup_unconfirmed");
  assert.equal(h.controller.snapshot().cleanup, "failed");
  assert.ok(h.now - firstAttempt >= 2000);
  assert.ok(h.now - firstAttempt < 2002);
  assert.equal(
    h.controls.some((c) => c.selector === "stop"),
    true,
  );
  assert.equal(
    h.controls.some((c) => c.selector === "release"),
    false,
  );
  assert.equal(
    h.results.some((r) => ["completed", "partial"].includes(r.payload.status)),
    false,
  );
});

test("a diagnostic rejection stays failed even when physical cleanup subsequently succeeds", async () => {
  let attempts = 0;
  const h = await controllerHarness({
    beforeCleanup: () => {
      if (++attempts === 1)
        throw new Error("flatness_diagnostic_delivery_failed");
      return true;
    },
  });
  h.launch();
  h.until(() => h.controller.snapshot().state === "failed");
  assert.equal(
    h.controller.snapshot().reason,
    "metric_diagnostic_cleanup_failed",
  );
  assert.equal(h.controller.snapshot().cleanup, "completed");
  assert.equal(
    h.controls.some((c) => c.selector === "stop"),
    true,
  );
  assert.equal(
    h.controls.some((c) => c.selector === "release"),
    true,
  );
});

test("controller rejects a foreign clock owner and confirms its own cleanup without publishing", async () => {
  const h = await controllerHarness();
  h.launch();
  assert.equal(
    h.controller.receiveNative("clock", [
      "native",
      "22222222-2222-4222-8222-222222222222",
      "clock",
      0,
      0,
      0,
      31,
      0,
      0,
      0,
      0,
      0,
      0,
      31,
    ]),
    false,
  );
  h.until(() => h.controller.snapshot().state === "failed");
  assert.equal(h.controller.snapshot().reason, "metric_foreign_clock");
  assert.equal(h.controller.snapshot().cleanup, "completed");
  assert.equal(
    h.results.some((r) => ["completed", "partial"].includes(r.payload.status)),
    false,
  );
});

test("controller terminal transport failure stays failed and bounded after genuine cleanup", async () => {
  const h = await controllerHarness({ terminalThrow: true });
  h.launch();
  h.controller.cancel(h.cancel);
  h.until(() => h.controller.snapshot().state === "failed");
  assert.equal(
    h.controller.snapshot().reason,
    "metric_terminal_delivery_failed",
  );
  assert.equal(h.controller.snapshot().cleanup, "completed");
  const attempts = h.deliveries.length;
  for (let index = 0; index < 256; index++) h.step();
  assert.equal(h.deliveries.length, attempts);
  assert.equal(
    h.results.some((r) => ["completed", "partial"].includes(r.payload.status)),
    false,
  );
});

let codecPromise;
function loadCodec() {
  return (codecPromise ||= compileNativeMetricProtocol({
    stage: async (_name, execute) => execute(),
  }).then((bundle) => {
    const compiled = new Module("metric-controller-codec-test");
    compiled.filename = "audio_listener_metric_protocol.js";
    compiled.paths = [];
    compiled.require = () => {
      throw new Error("Controller codec must not require external modules");
    };
    compiled._compile(bundle.source, compiled.filename);
    return compiled.exports;
  }));
}

test("controller shipping CJS exports the canonical proof and report-row factories without external require", async () => {
  const codec = await loadCodec();
  assert.equal(typeof codec.assertNativeMetricObservationSource, "function");
  assert.equal(typeof codec.nativeMetricLaunchCoordinates, "function");
  assert.equal(typeof codec.createMetricObservationReportRows, "function");
});

test("unavailable FFT phase retains healthy silence without inventing a first endpoint", () => {
  const owner = { generation: GENERATION, nativeEpoch: 7, arm: 65000 };
  const start = 65536;
  const end = start + 4800;
  const input = {
    owner,
    originSample: start,
    originBeat: 0,
    sampleRate: 48000,
    vectorSize: 64,
    tempo: 120,
    startBeat: 0,
    endBeat: 0.2,
    captureStartSample: start,
    captureEndSample: end,
    requestedMetrics: ["level", "spectrum"],
  };
  const collector = createMetricTimelines(
    {
      ...input,
      spectrum: {
        supportSamples: 2048,
        hopSamples: 2048,
        firstEndSample: null,
      },
    },
    { now: () => 0 },
  );
  assert.equal(collector.envelope.spectrum.firstEndSample, null);
  assert.equal(
    collector.ingestLevel({
      owner,
      sequence: 1,
      startSample: start,
      endSample: end,
      count: 4800,
      peak: [0, 0],
      sumSquares: [0, 0],
    }).accepted,
    true,
  );
  const result = collector.finalize({ owner, sourceEndSample: end });
  assert.equal(result.status, "partial");
  assert.equal(result.metrics.level.status, "completed");
  assert.equal(result.metrics.spectrum.status, "failed");
  assert.equal(result.metrics.spectrum.expectedRecords, 0);
  assert.equal(result.envelope.spectrum.firstEndSample, null);
});

for (const outcome of ["complete", "failed", "cancelled"]) {
  test(`controller transport prerequisite: FFT ${outcome} cleanup retains ownership until genuine disabled receipt`, () => {
    const source = retainedNativeSpectrumSource();
    // Test-only tap of the executed counter; not a descriptor endpoint or JS clock.
    const model = genModel(`${source.code}\nout32 = sourceClock;`, 32);
    const packets = [];
    const controls = [];
    let counter = 65536;
    let elapsedMs = 0;
    let page;
    let bank;
    let lastDeliveredBank;
    const io = new NativeMessageIO(
      "spectrum",
      (packet) => packets.push([...packet]),
      (control) => {
        controls.push([...control]);
        if (control[0].startsWith("measurement"))
          model.configure({ [control[0]]: control[1] });
      },
      (reason) => assert.fail(`Unexpected native diagnostic: ${reason}`),
      {
        now: () => elapsedMs,
      },
    );
    function step() {
      const bin = counter % 2048;
      const output = model.step(
        0,
        0,
        0,
        0,
        bin,
        counter % 1048576,
        Math.floor(counter / 1048576),
      );
      counter++;
      page = output.slice(11, 31);
      bank = [output[31], ...page, output[31]];
      return output;
    }

    assert.equal(io.begin(GENERATION, 7, 48000), true);
    const initial = step();
    io.packet("abi-spectrum", [initial[10]], 1);
    io.retainedSpectrumFrame(GENERATION, 7, bank);
    assert.ok(
      packets.some(
        (packet) =>
          packet[2] === "retention-ready" &&
          packet.slice(3).join(",") === "2,1,7",
      ),
    );
    while (counter < 65536 + 2048) step();
    const reader = io.retentionReader;
    for (let poll = 0; poll < 8 && reader.stats().accepted < 1; poll++) {
      lastDeliveredBank = [...bank];
      io.retainedSpectrumFrame(GENERATION, 7, bank);
      step();
      elapsedMs++;
    }
    assert.equal(reader.stats().accepted, 1);
    const measurement = packets.find((packet) => packet[2] === "spectrum");
    assert.deepEqual(measurement, [
      "native",
      GENERATION,
      "spectrum",
      67584,
      0,
      0,
      65536,
      67584,
      0,
    ]);

    const controlsAtRequest = controls.length;
    const forwardsAtRequest = packets.filter(
      (packet) => packet[2] === "spectrum",
    ).length;
    const deadline = elapsedMs + 1000;
    assert.equal(
      io.requestSpectrumStop(GENERATION, 7, outcome, deadline),
      true,
    );
    const pending = io.spectrumCleanupEvidence(GENERATION, 7);
    assert.equal(pending.status, "pending");
    assert.equal(pending.phase, "acquiring-watermark");
    assert.equal(pending.stopWatermark, null);
    assert.equal(pending.watermarkReceipt.available, false);
    assert.equal(pending.receipt.available, false);
    assert.equal(io.generation, GENERATION);
    assert.equal(io.retentionReader, reader);
    assert.equal(
      io.retainedSpectrumFrame(GENERATION, 7, lastDeliveredBank),
      false,
    );
    assert.equal(io.spectrumCleanupEvidence(GENERATION, 7).stopWatermark, null);
    assert.equal(
      controls
        .slice(controlsAtRequest)
        .some(
          (control) => control[0] === "measurementEpoch" && control[1] === 0,
        ),
      false,
    );

    step();
    assert.equal(page[1], 7);
    assert.equal(io.retainedSpectrumFrame(GENERATION, 7, bank), false);
    assert.deepEqual(controls.at(-1), ["measurementEpoch", 0]);
    // Applying a Param setter is not an executed Gen sample or stop receipt.
    assert.equal(page[1], 7);
    const acquired = io.spectrumCleanupEvidence(GENERATION, 7);
    assert.equal(acquired.status, "pending");
    assert.equal(acquired.phase, "awaiting-disabled");
    assert.equal(acquired.stopWatermark, bank[0]);
    assert.equal(acquired.watermarkReceipt.value.nativeSourceCounter, bank[0]);
    assert.equal(acquired.watermarkReceipt.value.raw[1], 7);
    assert.equal(acquired.receipt.available, false);
    assert.equal(acquired.deadlineMs, deadline);
    assert.equal(io.generation, GENERATION);
    assert.equal(io.retentionReader, reader);
    assert.equal(io.retainedSpectrumFrame(GENERATION, 7, bank), false);

    step();
    assert.equal(page[1], 0);
    assert.equal(page.at(-1), 0);
    assert.equal(page[7], 0);
    assert.equal(io.retainedSpectrumFrame(GENERATION, 7, bank), true);
    const completed = io.spectrumCleanupEvidence(GENERATION, 7);
    assert.equal(completed.status, "completed");
    assert.equal(completed.phase, "disabled-confirmed");
    assert.equal(completed.outcome, outcome);
    assert.equal(completed.diagnosticOnly, outcome !== "complete");
    assert.equal(completed.deadlineMs, deadline);
    assert.equal(completed.requestedHostMs, pending.requestedHostMs);
    assert.equal(completed.receipt.available, true);
    assert.deepEqual(completed.receipt.value.raw, page);
    assert.equal(completed.receipt.value.nativeSourceCounter, bank[0]);
    assert.ok(
      completed.receipt.value.nativeSourceCounter > completed.stopWatermark,
    );
    assert.equal(Object.isFrozen(completed.receipt.value.raw), true);
    assert.equal(io.generation, GENERATION);
    assert.equal(io.retentionEpoch, 7);
    assert.equal(
      controls
        .slice(controlsAtRequest)
        .some((control) => control[0] === "measurementAcknowledged"),
      false,
    );
    assert.equal(
      packets.filter((packet) => packet[2] === "spectrum").length,
      forwardsAtRequest,
    );
    assert.equal(io.release(GENERATION), true);
    assert.equal(io.generation, null);
    assert.equal(io.spectrumCleanupEvidence(GENERATION, 7), false);
    const afterRelease = packets.length;
    assert.equal(io.retainedSpectrumFrame(GENERATION, 7, bank), false);
    assert.equal(packets.length, afterRelease);
  });
}
