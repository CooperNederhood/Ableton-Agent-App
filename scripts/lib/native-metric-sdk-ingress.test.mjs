/* global structuredClone */
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { connect } from "node:net";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sanitizeTelemetryAttributes } from "@ableton-agent/observability";
import {
  SignalIngressServer,
  SignalRouter,
  InMemoryConnectionRegistry,
  listenerRegistrationMetricSchema,
  nativeMetricListeningConfigSchema,
} from "../../packages/signal-routing/src/index.ts";
import {
  createSyntheticMetricWireFixture,
  bindMetricFixtureToControl,
} from "../../packages/signal-routing/src/listener-metric-test-support.ts";
import { createNativeRunnerLifecycle } from "./native-listening-lifecycle.mjs";
import { compileNativeMetricProtocol } from "./native-metric-protocol-bundle.mjs";

const require = createRequire(import.meta.url);
const secret = "synthetic-metric-sdk-tcp-secret-at-least-thirty-two-characters";
const clients = [];
const servers = [];
let directory;
let AgentSignalClient;
let codecPath;
let sdkPath;

beforeAll(async () => {
  const parent = resolve(".test-artifacts/independent-metric-listening");
  await mkdir(parent, { recursive: true });
  directory = await mkdtemp(join(parent, "metric-sdk-tcp-"));
  const lifecycle = createNativeRunnerLifecycle({
    telemetry: { enqueue() {} },
    sanitize: sanitizeTelemetryAttributes,
    trace: {
      traceId: randomUUID(),
      correlationId: randomUUID(),
      causationId: randomUUID(),
    },
  });
  const compiled = await compileNativeMetricProtocol({
    stage: lifecycle.stage,
  });
  codecPath = join(directory, compiled.fileName);
  sdkPath = join(directory, "agent_signal_client.js");
  await writeFile(join(directory, "package.json"), '{"type":"commonjs"}');
  await writeFile(codecPath, compiled.source);
  await copyFile(resolve("max-patches/shared/agent_signal_client.js"), sdkPath);
  ({ AgentSignalClient } = require(sdkPath));
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.stop();
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});
afterAll(async () => {
  if (sdkPath) delete require.cache[sdkPath];
  if (codecPath) delete require.cache[codecPath];
  if (directory) await rm(directory, { recursive: true, force: false });
});

async function transaction(
  mode,
  partial,
  behavior = "complete",
  backpressure = false,
) {
  const f = createSyntheticMetricWireFixture(mode, partial);
  f.config = nativeMetricListeningConfigSchema.parse({
    ...f.config,
    sourceContext: f.observation.source,
  });
  f.ready.config = structuredClone(f.config);
  f.proof.armed.config = structuredClone(f.config);
  const registry = new InMemoryConnectionRegistry({ staleAfterMs: 60_000 });
  const descriptorPath = join(directory, `${randomUUID()}-ingress.json`);
  const events = [];
  const server = new SignalIngressServer({
    secret,
    registry,
    router: new SignalRouter({ registry }),
    port: 0,
    descriptorPath,
    independentMetricListeners: true,
    telemetry: {
      enqueue: (event) => {
        events.push(event);
      },
    },
  });
  servers.push(server);
  await server.start();
  const received = [];
  server.onListenerResult((event) => {
    received.push(event);
  });
  const controls = [];
  const callbackErrors = [];
  const sent = [];
  let bound;
  let socket;
  let observedBackpressure = false;
  let rejectedForgery = false;
  const client = new AgentSignalClient({
    secret,
    descriptorPath,
    signalKind: "audio",
    schemaVersion: "metric-audio-observation/v1",
    producerIdPrefix: "synthetic-metric-tcp",
    instanceId: randomUUID(),
    readText: (path) => readFile(path, "utf8"),
    createConnection(options) {
      socket = connect({
        ...options,
        highWaterMark: backpressure ? 1024 : 16_384,
      });
      return socket;
    },
    listener: listenerRegistrationMetricSchema.parse({
      ...f.registration,
      nativeStatus: {
        ...f.registration.nativeStatus,
        readiness: "BLOCKED",
        executedGen: null,
        reason: "fresh_per_pass_native_validation_required",
      },
    }),
    onListenerControl(control) {
      controls.push(control);
      const reply = (payload) => {
        const accepted = client.sendListenerReply(control, payload);
        sent.push({ type: "reply", status: payload.status, accepted });
        if (!accepted)
          throw new Error(`synthetic_reply_rejected:${payload.status}`);
      };
      const result = (payload) => {
        const accepted = client.sendListenerResult(control, payload);
        sent.push({ type: "result", status: payload.status, accepted });
        if (!accepted)
          throw new Error(`synthetic_result_rejected:${payload.status}`);
      };
      try {
        if (control.action === "prepare") {
          bound = bindMetricFixtureToControl(f, control);
          reply({ status: "ready", nativeReady: bound.ready });
        } else if (control.action === "arm") {
          reply({ status: "armed", nativeArm: bound.proof.armed });
          if (backpressure) socket.cork();
          try {
            result({ status: "progress", nativeLaunch: bound.proof.launched });
            if (behavior === "complete" || behavior === "forged-source") {
              if (behavior === "forged-source") {
                const observation = structuredClone(bound.observation);
                const proof = structuredClone(bound.proof);
                const other = randomUUID();
                observation.source.target.expectedReference = other;
                proof.armed.config.sourceContext.target.expectedReference =
                  other;
                rejectedForgery = !client.sendListenerResult(control, {
                  status: "completed",
                  observation,
                  nativeSourceCoverage: proof,
                });
              }
              if (partial)
                result({
                  status: "progress",
                  nativeLifecycle: {
                    scope: "independent-metric-timelines/v1",
                    eventId: randomUUID(),
                    causationId: control.causationId,
                    generation: control.generation,
                    nativeEpoch: bound.proof.armed.ownership.nativeEpoch,
                    metric: "spectral-centroid",
                    stage: "failed",
                    phase: "drain",
                    elapsedMs: 600,
                    durationMs: 10,
                    frames:
                      bound.observation.metrics["spectral-centroid"].records
                        .length,
                    reason: "synthetic_spectrum_gap",
                  },
                });
              result({
                status: partial ? "partial" : "completed",
                observation: bound.observation,
                nativeSourceCoverage: bound.proof,
              });
            }
            if (backpressure)
              observedBackpressure =
                socket.writableNeedDrain &&
                socket.writableLength >= socket.writableHighWaterMark;
          } finally {
            if (backpressure) socket.uncork();
          }
        } else if (behavior === "cleanup-failed") {
          result({ status: "failed", reason: "cleanup_uncertain" });
        } else {
          result({ status: "cancelled", reason: "synthetic_cancelled" });
          reply({ status: "cancelled", reason: "synthetic_cancelled" });
        }
      } catch (error) {
        callbackErrors.push(error);
        client.sendListenerReply(control, {
          status: "failed",
          reason: "synthetic_callback_failed",
        });
      }
    },
  });
  clients.push(client);
  client.configureProducer({
    canonicalPath: f.registration.deviceCanonicalPath,
    track: { id: "17", name: "Synthetic track" },
    device: { id: "29", name: "Synthetic metric listener" },
  });
  client.start();
  await expect.poll(() => client.isConnected()).toBe(true);
  const descriptor = server.inspectListeners()[0];
  expect(descriptor.registration.version).toBe(5);
  const input = {
    jobId: f.wire.jobId,
    passId: f.wire.passId,
    traceId: f.wire.traceId,
    correlationId: f.wire.correlationId,
    causationId: f.wire.causationId,
  };
  const control = (action) =>
    server.requestListenerControl(
      descriptor.connectionId,
      {
        ...input,
        action,
        ...(action === "prepare" ? { config: f.config } : {}),
      },
      { timeoutMs: 2000 },
    );
  expect((await control("prepare")).status).toBe("ready");
  expect((await control("arm")).status).toBe("armed");
  return {
    client,
    server,
    received,
    events,
    controls,
    callbackErrors,
    sent,
    control,
    get bound() {
      return bound;
    },
    get observedBackpressure() {
      return observedBackpressure;
    },
    get rejectedForgery() {
      return rejectedForgery;
    },
  };
}

describe("synthetic native proofs through real shipping SDK, codec and authenticated TCP", () => {
  for (const mode of ["arrangement", "session"])
    for (const partial of [false, true])
      for (const backpressure of [false, true])
        it(`${mode} ${partial ? "partial" : "complete"} with write backpressure ${backpressure}`, async () => {
          const s = await transaction(mode, partial, "complete", backpressure);
          await expect
            .poll(() => s.received.at(-1)?.result.status)
            .toBe(partial ? "partial" : "completed");
          expect(s.callbackErrors).toEqual([]);
          expect(s.sent.every((entry) => entry.accepted)).toBe(true);
          expect(s.received.at(-1).result.observation).toEqual(
            s.bound.observation,
          );
          expect(s.server.inspectListeners()[0].phase).toBe("idle");
          expect(s.controls.map((control) => control.action)).toEqual([
            "prepare",
            "arm",
          ]);
          expect(
            Object.isFrozen(s.controls[0].config.sourceContext.target),
          ).toBe(true);
          if (backpressure) expect(s.observedBackpressure).toBe(true);
          if (partial) {
            expect(s.received.map((event) => event.result.status)).toEqual([
              "progress",
              "progress",
              "partial",
            ]);
            expect(
              s.events.some(
                (event) =>
                  event.name ===
                  "output.listener.native.metric.spectral-centroid.failed",
              ),
            ).toBe(true);
            expect(
              s.events.some((event) => event.name === "output.listener.failed"),
            ).toBe(false);
          }
        });

  it.each(["arrangement", "session"])(
    "preserves result-before-reply cancellation over actual %s TCP",
    async (mode) => {
      const s = await transaction(mode, false, "cancel");
      expect((await s.control("cancel")).status).toBe("cancelled");
      await expect
        .poll(() => s.received.at(-1)?.result.status)
        .toBe("cancelled");
      expect(s.callbackErrors).toEqual([]);
      expect(s.server.inspectListeners()[0].phase).toBe("idle");
      expect(s.received.at(-1).result).not.toHaveProperty("observation");
    },
  );

  it("propagates actual shared cleanup failure without a context or successful cancel reply", async () => {
    const s = await transaction("arrangement", false, "cleanup-failed");
    await expect(s.control("cancel")).rejects.toThrow("cleanup_uncertain");
    expect(s.callbackErrors).toEqual([]);
    expect(s.received.at(-1).result.status).toBe("failed");
    expect(s.received.at(-1).result).not.toHaveProperty("observation");
    expect(s.server.inspectListeners()[0].phase).toBe("idle");
  });

  it("rejects self-consistent forged source in the SDK without losing the owned valid result", async () => {
    const s = await transaction("arrangement", false, "forged-source");
    await expect.poll(() => s.received.at(-1)?.result.status).toBe("completed");
    expect(s.rejectedForgery).toBe(true);
    expect(s.callbackErrors).toEqual([]);
    expect(s.received.at(-1).result.observation).toEqual(s.bound.observation);
  });
});
