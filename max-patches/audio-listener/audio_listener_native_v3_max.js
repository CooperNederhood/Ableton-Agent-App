/* global require, process */
"use strict";
const maxApi = require("max-api");
const { createRuntime } = require("./audio_listener_runtime.js");
const runtime = createRuntime({ maxApi, nativeMode: true, nativeVersion: 3 });
maxApi.outlet("adapter-started");
process.once("SIGTERM", () => {
  runtime.stop();
  process.exit(0);
});
process.once("SIGINT", () => {
  runtime.stop();
  process.exit(0);
});
