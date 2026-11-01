/* global require, process */
"use strict";
const maxApi = require("max-api");
const { createMetricRuntime } = require("./audio_listener_metric_runtime.js");
const {
  createMetricController,
} = require("./audio_listener_metric_controller.js");
// Engineering-only negative fixture: no spectral source ownership or records.
// Level, attacks, shared clock, cancellation and cleanup use the normal runtime.
const runtime = createMetricRuntime({
  maxApi,
  createController: (options) =>
    createMetricController({
      ...options,
      spectrumEnabled: false,
      onEvent(event) {
        // Preserve the normal runtime diagnostic/cleanup path and attribute
        // the local unavailable phase to its existing owned lifecycle event.
        options.onEvent(event);
        const lifecycle = event.nativeLifecycle;
        if (
          lifecycle.stage === "failed" &&
          lifecycle.metric === "spectral-centroid" &&
          /^[0-9a-f-]{36}$/i.test(lifecycle.eventId) &&
          /^[0-9a-f-]{36}$/i.test(lifecycle.generation) &&
          Number.isSafeInteger(lifecycle.nativeEpoch) &&
          lifecycle.nativeEpoch > 0
        )
          maxApi.post(
            JSON.stringify({
              event: "native_metric_engineering_fixture",
              fixture: "native5-unavailable-spectrum/v1",
              eventId: lifecycle.eventId,
              generation: lifecycle.generation,
              nativeEpoch: lifecycle.nativeEpoch,
            }),
          );
      },
    }),
});
maxApi.outlet("adapter-started");
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => {
    runtime.stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}
