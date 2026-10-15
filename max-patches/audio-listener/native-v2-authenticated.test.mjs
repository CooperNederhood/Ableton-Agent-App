/* global Buffer, setTimeout */
import "./native-protocol-test-loader.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { AgentSignalClient } = require("../shared/agent_signal_client.js");
const { createRuntime } = require("./audio_listener_runtime.js");
const { v2Fixture, V2_OWNER } = require("./native-v2-fixture.cjs");
const { assertNativeCaptureObservationV2 } =
  await import("../../packages/protocol/src/native-listening-v2-schemas.ts");
const {
  listenerRegistrationV2Schema,
  listenerControlV2Schema,
  listenerReplyV2Schema,
  listenerResultV2Schema,
} = await import("../../packages/signal-routing/src/listener-v2-contracts.ts");

// Real loopback authentication/framing; synthetic native measurements only.
for (const rate of [44100, 48000])
  for (const outcome of ["complete", "tempo-change"])
    test(`explicit native-v2 ${rate}Hz authenticated shared SDK ${outcome === "complete" ? "completes an App-valid300-window capture" : "rejects a genuine tiny tempo change and confirms owned disarm"}`, async () => {
      const secret = "synthetic-native-v2-local-authentication-secret";
      const sockets = new Set(),
        messages = [],
        outputs = [],
        timers = [],
        cleared = [];
      let socket, hello, failure, runtime, driver, epoch, constructorOptions;
      const server = net.createServer((connected) => {
        sockets.add(connected);
        connected.setEncoding("utf8");
        let buffer = "";
        connected.on("data", (chunk) => {
          buffer += chunk;
          let split = buffer.indexOf("\n");
          while (split >= 0) {
            const line = buffer.slice(0, split);
            buffer = buffer.slice(split + 1);
            try {
              assert(Buffer.byteLength(line, "utf8") <= 128 * 1024);
              const message = JSON.parse(line);
              messages.push(message);
              if (message.type === "producer.hello") {
                assert.equal(message.secret, secret);
                assert.equal(
                  message.producer.schemaVersion,
                  "audio-observation/v2",
                );
                listenerRegistrationV2Schema.parse(message.listener);
                hello = message;
                socket = connected;
                epoch = message.listener.connectionEpoch;
              } else if (message.type === "listener.reply") {
                listenerReplyV2Schema.parse(message);
              } else if (message.type === "listener.result") {
                listenerResultV2Schema.parse(message);
                if (message.observation)
                  assert(
                    message.observation.limitations.includes(
                      "Constant tempo is assumed; stability is not independently verified; tempo automation is unsupported.",
                    ),
                  );
                if (message.status === "completed")
                  assertNativeCaptureObservationV2(
                    message.nativeCapture,
                    message.observation,
                    {
                      listenerId: hello.producer.producerId,
                      passId: V2_OWNER.passId,
                      geometry: driver.geometry,
                      policy: driver.timingPolicy,
                    },
                  );
              }
              if (message.type !== "producer.disconnect")
                connected.write(
                  JSON.stringify({
                    type: "producer.ack",
                    protocolVersion: 1,
                    requestId: message.requestId,
                    action:
                      message.type === "producer.hello"
                        ? "hello"
                        : message.type === "producer.heartbeat"
                          ? "heartbeat"
                          : "listener",
                    ...(message.type === "producer.hello"
                      ? { connectionId: "synthetic-v2-ingress" }
                      : {}),
                  }) + "\n",
                );
            } catch (error) {
              failure = error;
              connected.destroy();
            }
            split = buffer.indexOf("\n");
          }
        });
        connected.on("close", () => sockets.delete(connected));
      });
      const until = async (predicate) => {
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          if (failure) throw failure;
          const result = predicate();
          if (result) return result;
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        throw new Error("synthetic_v2_ingress_timeout");
      };
      try {
        await new Promise((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", resolve);
        });
        const descriptor = {
          host: "127.0.0.1",
          port: server.address().port,
          protocol: "newline-delimited-json",
          protocolVersion: 1,
          maxFrameBytes: 128 * 1024,
          listenerVersions: [1, 2],
          listenerCapabilities: ["audio-listener/v1", "audio-listener/v2"],
        };
        class Client extends AgentSignalClient {
          constructor(config) {
            super({
              ...config,
              heartbeatMs: 100000,
              readText: async (file) => {
                if (file === "/synthetic/profile/descriptor.json")
                  return JSON.stringify(descriptor);
                if (file === "/synthetic/profile/secret.json")
                  return JSON.stringify({ version: 1, secret });
                throw new Error("unexpected_synthetic_discovery_path");
              },
            });
            constructorOptions = config;
          }
        }
        const handlers = {};
        runtime = createRuntime({
          nativeMode: true,
          nativeVersion: 2,
          Client,
          maxApi: {
            addHandler: (name, handler) => {
              handlers[name] = handler;
            },
            outlet: (...value) => outputs.push(value),
          },
          env: {
            ABLETON_AGENT_SIGNAL_INGRESS_DESCRIPTOR:
              "/synthetic/profile/descriptor.json",
            ABLETON_AGENT_SIGNAL_INGRESS_SECRET_PATH:
              "/synthetic/profile/secret.json",
          },
          clock: () => 0,
          interval: (fn) => {
            timers.push(fn);
            return fn;
          },
          clear: (fn) => cleared.push(fn),
        });
        const vector = rate === 44100 ? 128 : 64;
        handlers.identity(
          JSON.stringify({
            canonicalPath: "live_set tracks 0 devices 0",
            track: { id: "1", name: "synthetic track" },
            device: { id: "2", name: "Audio-Listener" },
          }),
        );
        handlers.dsp(1, rate, vector);
        handlers.host(0, 5.25, 1000000, 31);
        await until(() => runtime.client?.authenticated);
        assert(runtime.client instanceof AgentSignalClient);
        for (const method of [
          "start",
          "writeMessage",
          "handleListenerControl",
          "sendListenerReply",
          "sendListenerResult",
        ])
          assert.equal(
            runtime.client[method],
            AgentSignalClient.prototype[method],
          );
        assert.equal(constructorOptions.schemaVersion, "audio-observation/v2");
        assert.equal(constructorOptions.listener.version, 2);
        assert.deepEqual(constructorOptions.listener.capabilities, [
          "audio-listener/v2",
        ]);
        assert.equal(constructorOptions.listener.sampleRate, rate);
        assert.equal(constructorOptions.listener.vectorSize, vector);
        assert.equal(
          constructorOptions.listener.nativeStatus.readiness,
          "BLOCKED",
        );
        assert.equal(
          constructorOptions.listener.nativeStatus.reason,
          "fresh_per_pass_native_validation_required",
        );
        assert.equal(hello.listener.version, 2);
        assert.deepEqual(hello.listener.capabilities, ["audio-listener/v2"]);
        assert.equal(
          hello.listener.nativeStatus.reason,
          "fresh_per_pass_native_validation_required",
        );
        assert.equal(hello.listener.sampleRate, rate);
        assert.equal(hello.listener.vectorSize, vector);
        driver = v2Fixture({
          rate,
          vector,
          total: rate === 44100 ? rate * 30 : (rate / 10) * 299 + 1,
          controller: runtime.nativeController,
          ...(outcome === "tempo-change"
            ? {
                policy: {
                  mode: "descriptive",
                  maxClockDisagreementSamples: 480,
                },
              }
            : {}),
        });
        const send = (action, requestId) => {
          const control = {
            type: "listener.control",
            protocolVersion: 1,
            listenerVersion: 2,
            ...V2_OWNER,
            connectionEpoch: epoch,
            jobId: "authenticated-v2-job",
            traceId: "v2-trace",
            correlationId: "v2-correlation",
            causationId: "v2-root",
            action,
            requestId,
            ...(action === "prepare"
              ? {
                  config: {
                    geometry: driver.geometry,
                    timingPolicy: driver.timingPolicy,
                  },
                }
              : {}),
          };
          listenerControlV2Schema.parse(control);
          socket.write(JSON.stringify(control) + "\n");
        };
        send("prepare", "authenticated-prepare");
        await until(() =>
          messages.find((message) => message.status === "ready"),
        );
        send("arm", "authenticated-arm");
        await until(() => runtime.nativeController.state === "preflight");
        driver.preflight();
        driver.configReceipt();
        driver.ack();
        await until(() =>
          messages.find((message) => message.status === "armed"),
        );
        driver.packet("clock", driver.clock(driver.origin + 640));
        driver.packet("envelope", driver.envelope());
        if (outcome === "complete") {
          driver.capture();
          driver.post();
          const complete = await until(() =>
            messages.find((message) => message.status === "completed"),
          );
          assert.equal(complete.observation.samples.length, 300);
        } else {
          const generation = runtime.nativeController.pass.generation;
          handlers.native(generation, "tempo", 93 + 1e-6);
          handlers.native(generation, "tempo", 93);
          const failed = await until(() =>
            messages.find(
              (message) =>
                message.type === "listener.result" &&
                message.status === "failed",
            ),
          );
          assert.equal(failed.reason, "native_host_tempo_changed");
          assert.equal(failed.nativeCapture, undefined);
          assert.equal(failed.observation.complete, false);
          assert.deepEqual(failed.observation.samples, []);
          assert(
            failed.observation.limitations.includes(
              "Termination: native_host_tempo_changed",
            ),
          );
          assert.equal(
            messages.some((message) => message.status === "completed"),
            false,
          );
          const evidence = outputs
            .filter((value) => value[0] === "native_diagnostic")
            .map((value) => JSON.parse(value[1]))
            .filter((event) => event.type === "native-tempo-observation");
          assert.equal(evidence.length, 2);
          assert.equal(evidence.at(-1).observedTempoBpm, 93 + 1e-6);
          assert.equal(evidence.at(-1).maxReceivedTempoBpm, 93 + 1e-6);
          assert.equal(evidence.at(-1).generation, generation);
          assert.equal(evidence.at(-1).nativeCounter, undefined);
        }
        const generation = runtime.nativeController.pendingDisarm.generation;
        handlers.native("foreign", "stopped", 0, 0, 2);
        assert.equal(
          runtime.nativeController.pendingDisarm.generation,
          generation,
        );
        handlers.native(generation, "stopped", 0, 0, 2);
        assert.equal(runtime.nativeController.pendingDisarm, null);
        assert.equal(runtime.client.authenticated, true);
        const frames = messages.filter((message) =>
          message.type.startsWith("listener."),
        );
        assert.deepEqual(
          frames.map((frame) => frame.sequence),
          frames.map((_, index) => index),
        );
        assert(
          frames.every(
            (frame) =>
              frame.listenerVersion === 2 &&
              frame.connectionEpoch === epoch &&
              frame.traceId === "v2-trace" &&
              frame.correlationId === "v2-correlation",
          ),
        );
        const armed = frames.findIndex((frame) => frame.status === "armed");
        assert(
          frames
            .slice(0, armed)
            .every((frame) => frame.type === "listener.reply"),
        );
        assert.equal(runtime.client.offlineQueue.length, 0);
        await until(() => runtime.client.pending.size === 0);
        assert(
          outputs.every(
            (value) => value[0] !== "transport" && value[0] !== "start",
          ),
        );
      } finally {
        runtime?.stop();
        for (const connected of sockets) connected.destroy();
        if (server.listening)
          await new Promise((resolve) => server.close(resolve));
      }
      assert.deepEqual(cleared, timers);
    });
