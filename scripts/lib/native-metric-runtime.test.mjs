import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import * as protocol from "../../max-patches/audio-listener/audio_listener_metric_protocol.mjs";

const require = createRequire(import.meta.url);
const {
  createMetricRuntime,
} = require("../../max-patches/audio-listener/audio_listener_metric_runtime.js");
const identity = {
  canonicalPath: "live_set tracks 0 devices 0",
  track: { id: "1", name: "Owned track" },
  device: { id: "2", name: "Owned listener" },
};

function fixture(
  env = {
    ABLETON_AGENT_SIGNAL_INGRESS_DESCRIPTOR: "/owned/descriptor.json",
    ABLETON_AGENT_SIGNAL_INGRESS_SECRET: "s".repeat(32),
  },
) {
  const handlers = new Map();
  const clients = [];
  const controllers = [];
  const outlet = vi.fn();
  const clear = vi.fn();
  let tick;
  class Client {
    constructor(options) {
      this.options = options;
      this.configureProducer = vi.fn();
      this.start = vi.fn();
      this.stop = vi.fn();
      this.sendListenerReply = vi.fn(() => true);
      this.sendListenerResult = vi.fn(() => true);
      this.sendListenerDiagnostic = vi.fn(() => true);
      clients.push(this);
    }
  }
  function createController(options) {
    const controller = {
      options,
      prepare: vi.fn(),
      arm: vi.fn(),
      cancel: vi.fn(),
      receiveNative: vi.fn(),
      tick: vi.fn(),
      dispose: vi.fn(),
      snapshot: vi.fn(() => ({ state: "idle" })),
    };
    controllers.push(controller);
    return controller;
  }
  const runtime = createMetricRuntime({
    maxApi: {
      addHandler: (name, handler) => handlers.set(name, handler),
      outlet,
    },
    env,
    Client,
    createController,
    protocol,
    interval: (fn) => {
      tick = fn;
      return 42;
    },
    clear,
  });
  const send = (name, ...args) => handlers.get(name)(...args);
  const ready = () => {
    send("identity", JSON.stringify(identity));
    send("dsp", 1, 48000, 64);
  };
  return {
    runtime,
    send,
    ready,
    clients,
    controllers,
    outlet,
    clear,
    tick: () => tick(),
  };
}

describe("metric Node-for-Max entry wiring", () => {
  it("retains the original failure independently from unconfirmed cleanup through the sole SDK diagnostic writer", () => {
    const f = fixture();
    f.ready();
    const controller = f.controllers[0];
    controller.snapshot.mockReturnValue({
      state: "preflight", cleanup: "failed",
      inputFailureReason: "invalid_native_timing",
    });
    const control = { requestId: "actual-request" };
    controller.options.onEvent({
      control,
      nativeLifecycle: {
        eventId: "00000000-0000-4000-8000-000000000001",
        stage: "failed", reason: "metric_cleanup_unconfirmed",
      },
    });
    expect(f.clients[0].sendListenerDiagnostic).toHaveBeenCalledWith(
      control,
      expect.objectContaining({
        stage: "progress",
        reason: "native_failure_evidence",
        causationId: "00000000-0000-4000-8000-000000000001",
        facts: [
          { field: "capture.inputFailureReason", actual: { state: "observed", value: "invalid_native_timing" } },
          { field: "capture.cleanup", actual: { state: "observed", value: "failed" } },
        ],
      }),
    );
    expect(f.clients[0].sendListenerResult).not.toHaveBeenCalled();
  });
  it("starts only from actual identity and supported DSP, with canonical cold5 registration", () => {
    const f = fixture();
    f.send("dsp", 1, 48000, 64);
    expect(f.clients).toHaveLength(0);
    f.send("identity", JSON.stringify(identity));
    expect(f.clients).toHaveLength(1);
    const client = f.clients[0];
    expect(
      protocol.listenerRegistrationMetricSchema.parse(client.options.listener),
    ).toMatchObject({
      version: 5,
      nativeStatus: { readiness: "BLOCKED" },
      sampleRate: 48000,
      vectorSize: 64,
    });
    expect(client.configureProducer).toHaveBeenCalledWith(identity);
    expect(client.start).toHaveBeenCalledOnce();
    f.send("dsp", 1, 48000, 64);
    expect(f.clients).toHaveLength(1);
  });

  it("routes actual controls, IO packets, replies, results and lifecycle without manufacturing receipts", () => {
    const f = fixture();
    f.ready();
    const client = f.clients[0],
      controller = f.controllers[0];
    const control = {
        action: "prepare",
        generation: "owned-generation",
        traceId: "trace",
        correlationId: "correlation",
        causationId: "cause",
        config: { geometry: { totalSamples: 24000, sampleRate: 48000 } },
      },
      payload = { nativeEpoch: 1 };
    client.options.onListenerControl(control);
    expect(controller.prepare).toHaveBeenCalledWith(
      control,
      expect.objectContaining({
        nativeEpoch: 1,
        maxObservationBytes: protocol.MAX_AUDIO_OBSERVATION_BYTES,
      }),
    );
    expect(f.outlet).toHaveBeenCalledWith(
      "native_control",
      "begin",
      control.generation,
      1,
      48000,
    );
    f.send("native", "generation", "clock", 1, 2);
    expect(controller.receiveNative).toHaveBeenCalledWith("clock", [
      "native",
      "generation",
      "clock",
      1,
      2,
    ]);
    f.send("native_metric_evidence", JSON.stringify(payload));
    expect(controller.receiveNative).toHaveBeenCalledWith("metric_envelope", [
      "native_metric_evidence",
      JSON.stringify(payload),
    ]);
    controller.options.sendListenerReply(control, payload);
    controller.options.sendListenerResult(control, payload);
    expect(client.sendListenerReply).toHaveBeenCalledWith(control, payload);
    expect(client.sendListenerResult).toHaveBeenCalledWith(control, payload);
    controller.options.onEvent({ nativeLifecycle: { stage: "progress" } });
    expect(client.sendListenerDiagnostic).not.toHaveBeenCalled();
    controller.options.sendControl("metric_envelope", "metric_evidence", []);
    expect(f.outlet).toHaveBeenCalledWith(
      "native_control",
      "metric_envelope",
      "metric_evidence",
    );
    controller.options.sendControl("metric_envelope", "epoch", [0]);
    expect(f.outlet).toHaveBeenCalledWith(
      "native_control",
      "metric_parameter",
      "epoch",
      0,
    );
    f.tick();
    expect(controller.tick).toHaveBeenCalledOnce();
    expect(f.outlet).toHaveBeenCalledWith("heartbeat");
  });

  it("fails closed on identity replacement while retaining cleanup packet delivery", () => {
    const f = fixture();
    f.ready();
    f.send(
      "identity",
      JSON.stringify({ ...identity, device: { id: "3", name: "Other" } }),
    );
    expect(f.controllers[0].dispose).toHaveBeenCalledOnce();
    expect(f.clients[0].stop).toHaveBeenCalledOnce();
    f.send("native_metric_status", '{"cleanup":"completed"}');
    expect(f.controllers[0].receiveNative).toHaveBeenCalledWith(
      "metric_envelope",
      ["native_metric_status", '{"cleanup":"completed"}'],
    );
    f.send("dsp", 1, 48000, 64);
    expect(f.clients).toHaveLength(1);
  });

  it("keeps polling and the SDK alive until owned cleanup settles on shutdown", async () => {
    const f = fixture();
    f.ready();
    f.controllers[0].snapshot.mockReturnValue({
      state: "capturing",
      cleanup: "pending",
    });
    const stopping = f.runtime.stop();
    expect(f.clear).not.toHaveBeenCalled();
    expect(f.clients[0].stop).not.toHaveBeenCalled();
    f.send("native_metric_status", '{"cleanup":"completed"}');
    expect(f.controllers[0].receiveNative).toHaveBeenCalledOnce();
    f.controllers[0].snapshot.mockReturnValue({
      state: "failed",
      cleanup: "completed",
    });
    f.tick();
    await stopping;
    expect(f.clear).toHaveBeenCalledWith(42);
    expect(f.clients[0].stop).toHaveBeenCalledOnce();
    expect(f.runtime.stop()).toBe(stopping);
  });

  it("denies missing profile discovery instead of inventing a storage path", () => {
    const f = fixture({});
    f.ready();
    expect(f.clients).toHaveLength(0);
    expect(f.outlet).toHaveBeenCalledWith(
      "diagnostic",
      "explicit_profile_discovery_required",
    );
  });

  it("rejects malformed or oversized native JSON explicitly without forwarding it", () => {
    const f = fixture();
    f.ready();
    for (const value of ["{", "x".repeat(32769)])
      f.send("native_metric_evidence", value);
    expect(f.controllers[0].receiveNative).not.toHaveBeenCalled();
    expect(f.controllers[0].dispose).toHaveBeenCalledOnce();
    expect(f.outlet).toHaveBeenCalledWith(
      "diagnostic",
      "invalid_metric_packet",
    );
  });

  it("reports failed cleanup instead of resolving shutdown as success", async () => {
    const f = fixture();
    f.ready();
    f.controllers[0].snapshot.mockReturnValue({
      state: "capturing",
      cleanup: "pending",
    });
    const rejected = expect(f.runtime.stop()).rejects.toThrow(
      "native_cleanup_unconfirmed",
    );
    f.controllers[0].snapshot.mockReturnValue({
      state: "failed",
      cleanup: "failed",
    });
    f.tick();
    await rejected;
    expect(f.clients[0].stop).toHaveBeenCalledOnce();
    expect(f.clear).toHaveBeenCalledWith(42);
  });
});
