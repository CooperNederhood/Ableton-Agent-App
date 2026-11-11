import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { URL } from "node:url";
import { metricRuntimeHarness } from "./metric-runtime-test-helpers.mjs";
import { nativeMetricLifecycleSchema } from "../../packages/signal-routing/src/listener-metric-contracts.ts";
import { LISTENER_CAPABILITY_ANALYZER_TIMELINES } from "../../packages/protocol/src/analyzer-profile.ts";
import * as actualProtocol from "./audio_listener_metric_protocol.mjs";

test("actual consumer schema accepts source-perform ABI3 registration and its receipt", async () => {
  const h = metricRuntimeHarness({ runtime: { protocol: actualProtocol } });
  const registration = actualProtocol.listenerRegistrationMetricSchema.parse(
    h.clientOptions.listener,
  );
  assert.equal(registration.analyzerReadiness.producerAbi, 3);
  assert.ok(
    registration.capabilities.includes(LISTENER_CAPABILITY_ANALYZER_TIMELINES),
  );
  await h.runtime.stop();
});

test("analyzer capability requires actual ABI3 readiness, not packaged version or elapsed callbacks", async () => {
  const h = metricRuntimeHarness({ analyzerReady: false });
  assert.equal(h.clientOptions, undefined);
  const token = h.output.find(
    ([selector, action]) =>
      selector === "mel_native_control" && action === "probe",
  )[2];
  h.handlers.native_mel("analyzer_ready", 2, token, 1, 48000, 3, 10, 1);
  assert.equal(h.clientOptions, undefined);
  h.handlers.native_mel("analyzer_ready", 3, token + 1, 1, 48000, 3, 10, 1);
  h.handlers.native_mel("analyzer_ready", 3, token, 1, 44100, 3, 10, 1);
  assert.equal(h.clientOptions, undefined);
  h.handlers.native_mel("analyzer_ready", 3, token, 1, 48000, 3, 10, 1);
  assert.ok(
    h.clientOptions.listener.capabilities.includes(
      LISTENER_CAPABILITY_ANALYZER_TIMELINES,
    ),
  );
  assert.equal(h.clientOptions.listener.analyzerReadiness.probeToken, token);
  assert.equal(h.controllerOptions.analyzerReadiness.producerAbi, 3);
  await h.runtime.stop();
});

test("bounded optional readiness timeout preserves baseline registration without analyzer capability", async () => {
  const h = metricRuntimeHarness({ analyzerReady: false });
  h.advance(1000);
  assert.ok(h.clientOptions);
  assert.equal(h.clientOptions.listener.analyzerReadiness, undefined);
  assert.equal(
    h.clientOptions.listener.capabilities.includes(
      LISTENER_CAPABILITY_ANALYZER_TIMELINES,
    ),
    false,
  );
  assert.equal(h.controllerOptions.analyzerReadiness, null);
  await h.runtime.stop();
});

test("runtime routes mel controls and native receipts without a second listener or capture", async () => {
  const received = [];
  const h = metricRuntimeHarness({
    controller: {
      receiveNative: (...args) => received.push(args),
    },
  });
  assert.equal(h.controllerOptions.melEnabled, true);
  h.controllerOptions.sendControl("metric_mel", "arm", [7]);
  h.controllerOptions.sendControl("metric_mel", "drain", [12]);
  h.controllerOptions.sendControl("metric_mel", "stop", [7]);
  assert.deepEqual(
    h.output.filter(
      ([selector, action]) =>
        selector === "mel_native_control" && action !== "probe",
    ),
    [
      ["mel_native_control", "arm", 7],
      ["mel_native_control", "drain", 12],
      ["mel_native_control", "stop", 7],
    ],
  );
  const packet = ["mel_drain", 2, 12, 7, 1, 0, 0, 0, 0, 0];
  h.handlers.native_mel(...packet);
  assert.deepEqual(received, [["metric_mel", packet]]);
  assert.equal(
    h.output.some(
      (row) => row[0] === "native_control" && row[1] === "metric_mel",
    ),
    false,
  );
  await h.runtime.stop();
});

test("complete spectral failure snapshots preserve every fact within the lifecycle quota", async () => {
  let cleanup = "pending";
  const h = metricRuntimeHarness({
    controller: {
      snapshot: () => ({
        state: "failed",
        cleanup,
        spectrum: {
          enabled: true,
          started: true,
          phase: "failed",
          failure: "native-clock-failed",
          cleanup: "pending",
          released: false,
          receivedRecords: 13,
          acceptedRecords: 13,
          fftInformation: [2048, 1024, 48000, 64],
          acquisitions: [
            [1, 2, 3, 4],
            [5, 6, 7, 8],
          ],
          lastHeader: [1, 2, 3, 4],
          lastReadbackCounter: 13,
          startError: "controlled-failure",
        },
      }),
    },
  });
  const control = { generation: "11111111-1111-4111-8111-111111111111" };
  const lifecycle = {
    eventId: "22222222-2222-4222-8222-222222222222",
    generation: control.generation,
    nativeEpoch: 1,
    stage: "failed",
    metric: "spectral-centroid",
    scope: "independent-metric-timelines/v1",
    elapsedMs: 100,
    frames: 13,
  };
  h.controllerOptions.onEvent({ control, nativeLifecycle: lifecycle });
  for (const { payload } of h.diagnostics)
    assert.equal(
      nativeMetricLifecycleSchema.safeParse(payload).success,
      true,
      JSON.stringify(payload),
    );
  const spectral = h.diagnostics.filter(
    ({ payload }) => payload.reason === "native_spectrum_failure_evidence",
  );
  assert.deepEqual(
    spectral.map(({ payload }) => payload.facts.length),
    [24, 2],
  );
  const facts = spectral.flatMap(({ payload }) => payload.facts);
  assert.equal(new Set(facts.map(({ field }) => field)).size, 26);
  assert.equal(facts.at(-1).field, "capture.spectrum.startError");
  assert.equal(
    new Set(h.diagnostics.map(({ payload }) => payload.eventId)).size,
    3,
  );
  for (const diagnostic of h.diagnostics) {
    assert.equal(diagnostic.control, control);
    assert.equal(diagnostic.payload.causationId, lifecycle.eventId);
    assert.equal(diagnostic.payload.elapsedMs, lifecycle.elapsedMs);
  }
  assert.deepEqual(h.stops, []);
  cleanup = "completed";
  const stopping = h.runtime.stop();
  h.tick();
  await stopping;
});

const fixture = {
  engineeringOnly: true,
  engineeringFixture: "native5-unavailable-spectrum/v1",
};

test("a rejected spectral diagnostic batch stays an explicit terminal delivery failure", async () => {
  const h = metricRuntimeHarness({
    sendListenerDiagnostic: (_control, payload) =>
      payload.reason !== "native_spectrum_failure_evidence" ||
      payload.facts.length === 24,
    controller: {
      snapshot: () => ({
        state: "failed",
        cleanup: "completed",
        spectrum: {
          fftInformation: [1, 2, 3, 4],
          acquisitions: [
            [1, 2, 3, 4],
            [5, 6, 7, 8],
          ],
          lastHeader: [1, 2, 3, 4],
          lastReadbackCounter: 1,
        },
      }),
    },
  });
  h.controllerOptions.onEvent({
    control: {},
    nativeLifecycle: {
      eventId: "22222222-2222-4222-8222-222222222222",
      stage: "failed",
      metric: "spectral-centroid",
    },
  });
  assert.deepEqual(
    h.diagnostics
      .filter(
        ({ payload }) => payload.reason === "native_spectrum_failure_evidence",
      )
      .map(({ payload }) => payload.facts.length),
    [24, 1],
  );
  assert.deepEqual(h.stops, ["client"]);
  assert.ok(
    h.output.some(
      (row) =>
        row[0] === "diagnostic" &&
        row[1] === "native_failure_diagnostic_delivery_failed",
    ),
  );
  assert.equal(
    h.diagnostics.some(({ payload }) => payload.stage === "completed"),
    false,
  );
  await h.runtime.stop();
});

test("runtime decodes exact spectral JSON and rejects malformed or raw spectral transport", async () => {
  const received = [];
  const h = metricRuntimeHarness({
    controller: {
      receiveNative: (...args) => received.push(args),
    },
  });
  const generation = "11111111-1111-4111-8111-111111111111";
  const values = [2048, 8000, 1e-35, 0, 2048, 0];
  h.handlers.native_spectrum(
    "native",
    generation,
    "spectrum-json",
    JSON.stringify(values),
  );
  assert.deepEqual(received, [
    ["metric_spectrum", ["native", generation, "spectrum", ...values]],
  ]);
  await h.runtime.stop();
  for (const packet of [
    ["native", generation, "spectrum", ...values],
    ["native", generation, "spectrum-json", "invalid"],
    ["native", generation, "spectrum-json", "[1,2,3,4,5,null]"],
    ["native", generation, "spectrum-json", JSON.stringify(values.slice(1))],
    ["native", generation, "spectrum-json", " ".repeat(4097)],
  ]) {
    const denied = metricRuntimeHarness({
      controller: {
        receiveNative: assert.fail,
      },
    });
    denied.handlers.native_spectrum(...packet);
    assert.deepEqual(denied.stops, ["client"]);
    assert.ok(
      denied.output.some(
        (row) => row[0] === "diagnostic" && row[1] === "invalid_metric_packet",
      ),
    );
    await denied.runtime.stop();
  }
});

test("literal default and fixture entries select only their pinned source contracts and share shutdown handling", async () => {
  for (const [entry, engineeringEntry] of [
    ["audio_listener_native_v5_max.js", false],
    ["audio_listener_native_v5_unavailable_spectrum_max.js", true],
  ]) {
    let selected,
      controllerOptions,
      stops = 0;
    const signals = [],
      output = [],
      exits = [];
    const maxApi = { outlet: (...atoms) => output.push(atoms) };
    runInNewContext(await readFile(new URL(entry, import.meta.url), "utf8"), {
      require(name) {
        if (name === "max-api") return maxApi;
        if (name === "./audio_listener_metric_controller.js")
          return {
            createMetricController: (options) => {
              controllerOptions = options;
              return {};
            },
          };
        assert.equal(name, "./audio_listener_metric_runtime.js");
        return {
          createMetricRuntime(options) {
            selected = options;
            return {
              stop: async () => {
                stops++;
              },
            };
          },
        };
      },
      process: {
        once: (name, callback) => signals.push({ name, callback }),
        exit: (code) => exits.push(code),
      },
    });
    assert.equal(selected.maxApi, maxApi);
    assert.deepEqual(
      Object.keys(selected).sort(),
      engineeringEntry ? ["createController", "maxApi"] : ["maxApi"],
    );
    if (engineeringEntry) {
      const sendControl = () => {};
      selected.createController({
        spectrumEnabled: true,
        sendControl,
        onEvent() {},
      });
      assert.equal(controllerOptions.spectrumEnabled, false);
      assert.equal(controllerOptions.sendControl, sendControl);
    }
    assert.deepEqual(output, [["adapter-started"]]);
    assert.deepEqual(
      signals.map(({ name }) => name),
      ["SIGTERM", "SIGINT"],
    );
    signals[0].callback();
    await Promise.resolve();
    assert.equal(stops, 1);
    assert.deepEqual(exits, [0]);
  }
});

test("default v5 runtime always enables spectrum, ignoring normal environment fixture flags", async () => {
  const h = metricRuntimeHarness({
    runtime: {
      env: {
        ABLETON_AGENT_SIGNAL_INGRESS_DESCRIPTOR: "/fixture/descriptor.json",
        ABLETON_AGENT_SIGNAL_INGRESS_SECRET_PATH: "/fixture/credential.json",
        ABLETON_AGENT_SPECTRUM_ENABLED: "false",
        ABLETON_AGENT_ENGINEERING_FIXTURE: fixture.engineeringFixture,
      },
    },
  });
  assert.equal(h.controllerOptions.spectrumEnabled, true);
  await h.runtime.stop();
});

test("explicit engineering entry disables only spectral acquisition and attributes the owned capture event", async () => {
  const h = metricRuntimeHarness({ engineeringEntry: true });
  assert.equal(h.controllerOptions.spectrumEnabled, false);
  h.controllerOptions.onEvent({
    control: { generation: "11111111-1111-4111-8111-111111111111" },
    nativeLifecycle: {
      eventId: "22222222-2222-4222-8222-222222222222",
      generation: "11111111-1111-4111-8111-111111111111",
      nativeEpoch: 1,
      stage: "failed",
      metric: "spectral-centroid",
    },
  });
  assert.ok(
    h.logs.some(
      (row) =>
        row.event === "native_metric_engineering_fixture" &&
        row.fixture === fixture.engineeringFixture &&
        row.eventId === "22222222-2222-4222-8222-222222222222",
    ),
  );
  const marker = h.logs.find(
    (row) => row.event === "native_metric_engineering_fixture",
  );
  assert.ok(JSON.stringify(marker).length < 256);
  const markersBefore = h.logs.filter(
    (row) => row.event === "native_metric_engineering_fixture",
  ).length;
  h.controllerOptions.onEvent({
    control: { generation: "11111111-1111-4111-8111-111111111111" },
    nativeLifecycle: {
      eventId: "unbounded".repeat(100),
      generation: "11111111-1111-4111-8111-111111111111",
      nativeEpoch: 1,
      stage: "failed",
      metric: "spectral-centroid",
    },
  });
  assert.equal(
    h.logs.filter((row) => row.event === "native_metric_engineering_fixture")
      .length,
    markersBefore,
  );
  await h.runtime.stop();
});

test("default runtime has no fixture flag: unbound options never disable spectrum", async () => {
  for (const runtime of [
    { engineeringFixture: fixture.engineeringFixture },
    { ...fixture, engineeringOnly: false },
    { ...fixture, engineeringFixture: "unknown" },
    { ...fixture, engineeringFixture: null },
    { ...fixture, engineeringFixture: undefined },
    { engineeringOnly: true },
    { spectrumEnabled: false },
    { ...fixture, nativeVersion: 4 },
    { ...fixture, nativeMode: false },
  ]) {
    const h = metricRuntimeHarness({ runtime });
    assert.equal(h.controllerOptions.spectrumEnabled, true);
    await h.runtime.stop();
  }
});

test("fixture cleanup failure is never promoted to a clock release or successful shutdown", async () => {
  let snapshot = { state: "preflight", cleanup: "pending" };
  const h = metricRuntimeHarness({
    engineeringEntry: true,
    controller: { snapshot: () => snapshot },
  });
  h.clientOptions.onListenerControl({
    action: "prepare",
    generation: "fixture-generation",
    config: { geometry: { totalSamples: 9000, sampleRate: 48000 } },
  });
  const stopping = h.runtime.stop();
  snapshot = { state: "failed", cleanup: "failed" };
  h.tick();
  await assert.rejects(stopping, /native_cleanup_unconfirmed/);
  assert.equal(
    h.output.some((row) => row[1] === "release"),
    false,
  );
});

test("fixture cancellation/stop preserves the shared clock lease until executed cleanup and clears it once", async () => {
  let snapshot = { state: "preflight", cleanup: "pending" };
  const h = metricRuntimeHarness({
    engineeringEntry: true,
    controller: { snapshot: () => snapshot },
  });
  h.clientOptions.onListenerControl({
    action: "prepare",
    generation: "fixture-generation",
    config: { geometry: { totalSamples: 9000, sampleRate: 48000 } },
  });
  const stopping = h.runtime.stop();
  assert.equal(h.stops.length, 0);
  assert.equal(
    h.output.some((row) => row[1] === "release"),
    false,
  );
  snapshot = { state: "cancelled", cleanup: "completed" };
  h.tick();
  await stopping;
  assert.equal(h.output.filter((row) => row[1] === "release").length, 1);
  assert.deepEqual(h.stops, ["client", "timer"]);
  assert.equal(h.runtime.stop(), stopping);
});
