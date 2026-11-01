import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { URL } from "node:url";
import { metricRuntimeHarness } from "./metric-runtime-test-helpers.mjs";

const fixture = {
  engineeringOnly: true,
  engineeringFixture: "native5-unavailable-spectrum/v1",
};

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
