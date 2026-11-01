/* global require, process */
"use strict";
const maxApi = require("max-api");
const { createMetricRuntime } = require("./audio_listener_metric_runtime.js");
const runtime = createMetricRuntime({ maxApi });
maxApi.outlet("adapter-started");
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => {
    runtime.stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}
