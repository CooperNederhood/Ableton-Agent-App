import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { runInNewContext } from "node:vm";
import {
  analyzerNativeReadinessSchema,
  LISTENER_CAPABILITY_ANALYZER_TIMELINES,
} from "../../packages/protocol/src/analyzer-profile.ts";

const require = createRequire(import.meta.url);
const { createMetricRuntime } = require("./audio_listener_metric_runtime.js");

// Controlled Node IO only; no sockets, Max, Live, or hardware qualification.
export function metricRuntimeHarness(options = {}) {
  const handlers = {},
    output = [],
    diagnostics = [],
    logs = [],
    stops = [];
  let controllerOptions, clientOptions, tick;
  let time = 0;
  const controller = {
    snapshot: () => ({ state: "idle", cleanup: "completed" }),
    prepare() {},
    arm() {},
    cancel() {},
    dispose() {},
    tick() {},
    ...options.controller,
  };
  class Client {
    constructor(config) {
      clientOptions = config;
    }
    configureProducer() {}
    start() {}
    stop() {
      stops.push("client");
    }
    sendListenerReply() {
      return true;
    }
    sendListenerResult() {
      return true;
    }
    sendListenerDiagnostic(control, payload) {
      diagnostics.push({ control, payload });
      return options.sendListenerDiagnostic?.(control, payload) ?? true;
    }
  }
  const maxApi = {
    addHandler: (name, handler) => (handlers[name] = handler),
    outlet: (...atoms) => output.push(atoms),
    post: (message) => logs.push(JSON.parse(message)),
  };
  const createController = (config) => {
    controllerOptions = config;
    return controller;
  };
  let entryOptions = { createController };
  if (options.engineeringEntry) {
    runInNewContext(
      readFileSync(
        new URL(
          "audio_listener_native_v5_unavailable_spectrum_max.js",
          import.meta.url,
        ),
        "utf8",
      ),
      {
        require(name) {
          if (name === "max-api") return maxApi;
          if (name === "./audio_listener_metric_controller.js")
            return { createMetricController: createController };
          if (name === "./audio_listener_metric_runtime.js")
            return {
              createMetricRuntime(config) {
                entryOptions = config;
                return {};
              },
            };
          throw new Error("unexpected_fixture_entry_dependency");
        },
        process: { once() {} },
      },
    );
  }
  const runtime = createMetricRuntime({
    maxApi,
    Client,
    env: {
      ABLETON_AGENT_SIGNAL_INGRESS_DESCRIPTOR: "/fixture/descriptor.json",
      ABLETON_AGENT_SIGNAL_INGRESS_SECRET_PATH: "/fixture/credential.json",
    },
    protocol: {
      listenerRegistrationMetricSchema: { parse: (value) => value },
      LISTENER_METRIC_SCOPE: "independent-metric-timelines/v1",
      LISTENER_CAPABILITY_METRIC:
        "audio-listener/independent-metric-timelines-v1",
      LISTENER_CAPABILITY_MEL: "audio-listener/mel-band-timelines-v1",
      LISTENER_METRIC_ALGORITHM_VERSION: "3.0.0",
      MAX_AUDIO_OBSERVATION_BYTES: 256 * 1024,
      MAX_METRIC_OBSERVATION_BYTES: 2 * 1024 * 1024,
      analyzerNativeReadinessSchema,
      LISTENER_CAPABILITY_ANALYZER_TIMELINES,
    },
    now: () => time,
    ...entryOptions,
    interval: (handler) => {
      tick = handler;
      return handler;
    },
    clear: () => stops.push("timer"),
    ...options.runtime,
  });
  handlers.identity(
    JSON.stringify({
      canonicalPath: "live_set tracks 0 devices 0",
      track: { id: "1", name: "fixture" },
      device: { id: "2", name: "Audio-Listener" },
    }),
  );
  handlers.dsp(1, 48000, 64);
  if (options.analyzerReady !== false) {
    const probe = output.find(
      (row) => row[0] === "mel_native_control" && row[1] === "probe",
    );
    if (probe)
      handlers.native_mel("analyzer_ready", 3, probe[2], 1, 48000, 3, 10, 1);
  }
  return {
    runtime,
    get controllerOptions() {
      return controllerOptions;
    },
    get clientOptions() {
      return clientOptions;
    },
    handlers,
    output,
    diagnostics,
    logs,
    stops,
    tick: () => tick(),
    advance: (ms) => {
      time += ms;
      tick();
    },
  };
}
