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
const {
  listenerRegistrationSessionSchema,
  listenerReplySessionSchema,
  listenerResultSessionSchema,
} =
  await import("../../packages/signal-routing/src/listener-session-contracts.ts");
const { assertNativeSessionCaptureObservation } =
  await import("../../packages/protocol/src/native-session-listening-schemas.ts");
const source = {
  mode: "session",
  synchronization: "transport-coupled-first-iteration",
  target: {
    view: "session",
    sceneIndex: 0,
    expectedClipName: "clip",
    expectedClipReference: "11111111-1111-4111-8111-111111111111",
    track: {
      kind: "regular",
      index: 0,
      expectedName: "track",
      expectedReference: "22222222-2222-4222-8222-222222222222",
    },
  },
};
for (const rate of [44100, 48000])
  for (const outcome of ["completed", "cancelled", "failed"])
    test(`native wire3 ${rate}Hz real SDK authentication/framing ${outcome}, native ABI remains2`, async () => {
      const secret = "synthetic-session-runtime-authentication-secret";
      const sockets = new Set(),
        messages = [],
        handlers = {},
        cleared = [];
      let socket, hello, runtime, failure;
      const server = net.createServer((connected) => {
        sockets.add(connected);
        connected.setEncoding("utf8");
        let buffer = "";
        connected.on("data", (chunk) => {
          buffer += chunk;
          let newline;
          while ((newline = buffer.indexOf("\n")) >= 0) {
            const encoded = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            try {
              assert(Buffer.byteLength(encoded, "utf8") <= 128 * 1024);
              const message = JSON.parse(encoded);
              messages.push(message);
              if (message.type === "producer.hello") {
                assert.equal(message.secret, secret);
                assert.equal(
                  message.producer.schemaVersion,
                  "audio-observation/v2",
                );
                listenerRegistrationSessionSchema.parse(message.listener);
                assert.equal(message.listener.nativeStatus.abiVersion, 2);
                hello = message;
                socket = connected;
              } else if (message.type === "listener.reply")
                listenerReplySessionSchema.parse(message);
              else if (message.type === "listener.result")
                listenerResultSessionSchema.parse(message);
              if (message.type !== "producer.disconnect")
                connected.write(
                  JSON.stringify({
                    type: "producer.ack",
                    protocolVersion: 1,
                    requestId: message.requestId,
                    action:
                      message.type === "producer.hello" ? "hello" : "listener",
                    ...(message.type === "producer.hello"
                      ? { connectionId: "synthetic-session-connection" }
                      : {}),
                  }) + "\n",
                );
            } catch (cause) {
              failure = cause;
              connected.destroy();
            }
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
        throw new Error("synthetic_session_runtime_timeout");
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
          listenerVersions: [1, 2, 3],
          listenerCapabilities: [
            "audio-listener/v1",
            "audio-listener/v2",
            "audio-listener/session-v1",
          ],
        };
        class Client extends AgentSignalClient {
          constructor(options) {
            super({
              ...options,
              heartbeatMs: 100000,
              readText: async (file) => {
                if (file === "/synthetic/session/descriptor.json")
                  return JSON.stringify(descriptor);
                if (file === "/synthetic/session/secret.json")
                  return JSON.stringify({ version: 1, secret });
                throw new Error("unexpected_synthetic_session_file");
              },
            });
          }
        }
        runtime = createRuntime({
          nativeMode: true,
          nativeVersion: 3,
          Client,
          maxApi: {
            addHandler: (name, fn) => {
              handlers[name] = fn;
            },
            outlet: () => true,
          },
          env: {
            ABLETON_AGENT_SIGNAL_INGRESS_DESCRIPTOR:
              "/synthetic/session/descriptor.json",
            ABLETON_AGENT_SIGNAL_INGRESS_SECRET_PATH:
              "/synthetic/session/secret.json",
          },
          clock: () => 0,
          interval: (fn) => fn,
          clear: (fn) => cleared.push(fn),
        });
        handlers.identity(
          JSON.stringify({
            canonicalPath: "live_set tracks 0 devices 0",
            track: { id: "1", name: "synthetic" },
            device: { id: "2", name: "listener" },
          }),
        );
        const vector = rate === 44100 ? 128 : 64;
        handlers.dsp(1, rate, vector);
        handlers.host(0, 5.25, 1000000, 31);
        await until(() => runtime.client?.authenticated);
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
        const f = v2Fixture({
          rate,
          vector,
          controller: runtime.nativeController,
        });
        let request = 0;
        const control = (action) =>
          socket.write(
            JSON.stringify({
              ...V2_OWNER,
              connectionEpoch: hello.listener.connectionEpoch,
              type: "listener.control",
              protocolVersion: 1,
              listenerVersion: 3,
              traceId: "session-runtime-trace",
              correlationId: "session-runtime-correlation",
              causationId: "session-runtime-cause",
              jobId: "session-runtime-job",
              requestId: `session-runtime-${request++}`,
              action,
              ...(action === "prepare"
                ? {
                    config: {
                      geometry: f.geometry,
                      timingPolicy: f.timingPolicy,
                      source,
                    },
                  }
                : {}),
            }) + "\n",
          );
        control("prepare");
        await until(() => messages.some((m) => m.status === "ready"));
        control("arm");
        await until(() => runtime.nativeController.state === "preflight");
        f.preflight();
        f.configReceipt();
        f.ack();
        await until(() => messages.some((m) => m.status === "armed"));
        f.packet("clock", f.clock(f.origin + 640));
        f.packet("envelope", f.envelope());
        if (outcome === "completed") {
          f.capture();
          f.post();
        } else {
          if (outcome === "cancelled") {
            control("cancel");
            await until(() => runtime.nativeController.pendingDisarm);
          } else f.packet("abi-envelope", [3]);
          const generation = runtime.nativeController.pendingDisarm?.generation;
          assert(generation);
          handlers.native(generation, "stopped", 0, 0, 2);
        }
        const terminal = await until(() =>
          messages.find((m) => m.status === outcome),
        );
        assert.equal(terminal.listenerVersion, 3);
        assert.equal(terminal.traceId, "session-runtime-trace");
        assert.equal(terminal.correlationId, "session-runtime-correlation");
        if (outcome === "completed") {
          assertNativeSessionCaptureObservation(
            terminal.nativeCapture,
            terminal.observation,
            {
              source,
              geometry: f.geometry,
              policy: f.timingPolicy,
              listenerId: hello.producer.producerId,
              passId: V2_OWNER.passId,
            },
          );
          assert(messages.some((m) => m.nativeLaunch));
        } else
          assert.equal(
            messages.some((m) => m.nativeCapture),
            false,
          );
        await until(() => runtime.client.pending.size === 0);
        assert.equal(runtime.client.listenerJob, null);
      } finally {
        runtime?.stop();
        for (const connected of sockets) connected.destroy();
        await new Promise((resolve) => server.close(resolve));
      }
      assert.equal(cleared.length, 1);
    });
