/* global require, process */
"use strict";
const { createRuntime } = require("./audio_listener_runtime.js");
const maxApi = require("max-api");
const runtime = createRuntime({ maxApi, nativeMode: true, nativeVersion: 2 });
maxApi.outlet("adapter-started");
process.once("SIGTERM", () => {
  runtime.stop();
  process.exit(0);
});
process.once("SIGINT", () => {
  runtime.stop();
  process.exit(0);
});
