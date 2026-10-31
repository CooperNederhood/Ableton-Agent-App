import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { sourceDocuments } from "../../max-patches/audio-listener/native-source.mjs";
import {
  build,
  checkArtifact,
  SOURCE_DIRECTORY,
} from "../audio-listener-device.mjs";
import { decodeAmxd, encodeAmxd } from "../max-device-publisher.mjs";
import { createNativeRunnerLifecycle } from "./native-listening-lifecycle.mjs";
import { sanitizeTelemetryAttributes } from "@ableton-agent/observability";

const directories = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

it("packages a matched v5 executable, actual controller and fresh same-folder codec", async () => {
  const parent = resolve(".test-artifacts/independent-metric-listening");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "package5-"));
  directories.push(root);
  const template = decodeAmxd(
    await readFile(join(SOURCE_DIRECTORY, "audio-effect-template.amxd")),
  );
  const document = sourceDocuments()["Audio-Listener.maxpat"];
  for (const [id, varname] of Object.entries({
    analysis: "ml_analysis",
    node: "ml_runtime",
    guard: "ml_guard",
    identity: "ml_identity",
  }))
    document.patcher.boxes.find(({ box }) => box.id === id).box.varname =
      varname;
  const source = join(root, "Owned-Metric-Listener.amxd");
  await writeFile(source, encodeAmxd(template, document));
  const lifecycle = createNativeRunnerLifecycle({
    telemetry: { enqueue() {} },
    sanitize: sanitizeTelemetryAttributes,
    trace: {
      traceId: "00000000-0000-4000-8000-000000000001",
      correlationId: "metric-package",
      causationId: "caller",
    },
  });
  const output = join(root, "output");
  const manifest = await build(output, {
    authoredDevicePath: source,
    nativeMode: true,
    nativeVersion: 5,
    stage: lifecycle.stage,
  });
  expect(manifest).toMatchObject({
    nativeVersion: 5,
    nativeScope: "independent-metric-timelines/v1",
    observationSchema: "metric-audio-observation/v1",
    realLiveValidated: false,
    metricProtocol: { schema: "native-metric-protocol-bundle/v1" },
  });
  expect(await checkArtifact(output)).toEqual(manifest);
  const require = createRequire(join(output, "probe.cjs"));
  const { createMetricRuntime } = require("./audio_listener_metric_runtime.js");
  const {
    createMetricController,
  } = require("./audio_listener_metric_controller.js");
  const codec = require("./audio_listener_metric_protocol.js");
  expect(typeof createMetricRuntime).toBe("function");
  const controller = createMetricController({
    codec,
    now: Date.now,
    sendControl() {},
    sendListenerReply: () => true,
    sendListenerResult: () => true,
    onEvent() {},
  });
  expect(controller.snapshot().state).toBe("idle");
  expect(typeof codec.createMetricObservationReportRows).toBe("function");
  expect(codec.MAX_AUDIO_OBSERVATION_BYTES).toBe(256 * 1024);
});
