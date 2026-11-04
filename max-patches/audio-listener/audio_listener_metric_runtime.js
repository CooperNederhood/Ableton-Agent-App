/* global require, module, process, setInterval, clearInterval */
"use strict";

function sharedClient() {
  try {
    return require("./agent_signal_client_common.js");
  } catch (error) {
    if (
      error.code !== "MODULE_NOT_FOUND" ||
      !String(error.message).includes("./agent_signal_client_common.js")
    )
      throw error;
    return require("../shared/agent_signal_client.js");
  }
}

function createMetricRuntime({
  maxApi,
  env = process.env,
  Client,
  createController,
  protocol,
  now = Date.now,
  interval = setInterval,
  clear = clearInterval,
} = {}) {
  if (!maxApi || typeof maxApi.addHandler !== "function")
    throw new Error("metric_max_api_required");
  const common = sharedClient();
  Client = Client ?? common.AgentSignalClient;
  createController =
    createController ??
    require("./audio_listener_metric_controller.js").createMetricController;
  protocol = protocol ?? require("./audio_listener_metric_protocol.js");
  let identity = null;
  let dsp = null;
  let client = null;
  let controller = null;
  let blocked = false;
  let closing = null;
  let stopWaiter = null;
  let nativeEpoch = 0;
  let clockLease = null;
  let heartbeatEnabled = true;
  const output = (...atoms) => maxApi.outlet(...atoms);
  const flatness =
    require("./audio_listener_flatness_probe.js").createFlatnessProbe({
      now,
      sendControl: (...atoms) => output("flatness_smoke_control", ...atoms),
      emit: (control, lifecycle) =>
        client.sendListenerDiagnostic(control, lifecycle),
    });

  function invalidate(reason) {
    if (blocked) return;
    blocked = true;
    controller?.dispose();
    client?.stop();
    output("diagnostic", reason);
  }

  function start() {
    if (blocked || closing || client || !identity || !dsp?.on) return;
    const match =
      /^(live_set (?:tracks (?:0|[1-9][0-9]*)|return_tracks (?:0|[1-9][0-9]*)|master_track)) devices (?:0|[1-9][0-9]*)$/.exec(
        identity.canonicalPath,
      );
    if (!match) {
      invalidate("invalid_canonical_device_path");
      return;
    }
    let installed;
    try {
      installed = common.installedDiscoveryPaths();
    } catch {
      invalidate("invalid_installed_profile_configuration");
      return;
    }
    const { isAbsolute } = require("node:path");
    const descriptorPath =
      env[common.DEFAULT_DESCRIPTOR_ENV] ?? installed?.descriptorPath;
    const secretPath =
      env[common.DEFAULT_SECRET_PATH_ENV] ?? installed?.secretPath;
    const secret = env[common.DEFAULT_SECRET_ENV];
    if (
      typeof descriptorPath !== "string" ||
      !isAbsolute(descriptorPath) ||
      (secretPath !== undefined &&
        (typeof secretPath !== "string" || !isAbsolute(secretPath))) ||
      (!(typeof secret === "string" && secret.trim()) && !secretPath)
    ) {
      invalidate("explicit_profile_discovery_required");
      return;
    }
    controller = createController({
      codec: protocol,
      spectrumEnabled: true,
      now,
      sendControl: (target, selector, args) =>
        output(
          "native_control",
          selector === "epoch" ? "metric_parameter" : target,
          selector,
          ...args,
        ),
      sendListenerReply: (control, payload) =>
        client.sendListenerReply(control, payload),
      sendListenerResult: (control, payload) =>
        client.sendListenerResult(control, payload),
      beforeCleanup: (control, cancelled) => flatness.stop(control, cancelled),
      onEvent: (event) => {
        if (
          event.phase === "launch" &&
          event.nativeLifecycle.stage === "completed" &&
          !event.nativeLifecycle.metric
        )
          flatness.start(
            event.control,
            event.nativeLifecycle.nativeEpoch,
            event.nativeLifecycle.eventId,
            event.nativeLifecycle.elapsedMs,
          );
        if (
          event.nativeLifecycle.stage !== "failed" ||
          (event.nativeLifecycle.metric &&
            event.nativeLifecycle.metric !== "spectral-centroid")
        )
          return;
        const snapshot = controller.snapshot();
        const fields = ["inputFailureReason", "cleanup"];
        for (const field of [
          "inputFailureDetail",
          "ioFailureReason",
          "lastNativeSelector",
          "preflightBlocker",
        ])
          if (typeof snapshot[field] === "string") fields.push(field);
        const facts = fields.map((field) => ({
          field: `capture.${field}`,
          actual:
            typeof snapshot[field] === "string"
              ? { state: "observed", value: snapshot[field].slice(0, 256) }
              : { state: "unavailable", reason: "not-reported" },
        }));
        if (snapshot.ioFailureDetail) {
          for (const field of [
            "bank",
            "expectedWidth",
            "actualWidth",
            "counterBefore",
            "counterAfter",
            "watermark",
            "sourceCounter",
          ]) {
            const value = snapshot.ioFailureDetail[field];
            if (value === undefined) continue;
            facts.push({
              field: `capture.readback.${field}`,
              actual:
                typeof value === "string"
                  ? { state: "observed", value: value.slice(0, 256) }
                  : typeof value === "number" && Number.isFinite(value)
                    ? { state: "observed", value }
                    : { state: "unavailable", reason: "invalid" },
            });
          }
        }
        if (Array.isArray(snapshot.ioFailureReadback)) {
          snapshot.ioFailureReadback.slice(0, 8).forEach((value, index) => {
            facts.push({
              field: `capture.timing.${index}`,
              actual:
                typeof value === "number" && Number.isFinite(value)
                  ? { state: "observed", value }
                  : { state: "unavailable", reason: "invalid" },
            });
          });
        } else if (
          !snapshot.ioFailureDetail &&
          Array.isArray(snapshot.clockReadback)
        ) {
          snapshot.clockReadback.slice(0, 11).forEach((value, index) => {
            facts.push({
              field: `capture.clock.${index}`,
              actual:
                typeof value === "number" && Number.isFinite(value)
                  ? { state: "observed", value }
                  : { state: "unavailable", reason: "invalid" },
            });
          });
          if (typeof snapshot.clockFirstPhase === "number")
            facts.push({
              field: "capture.clockFirstPhase",
              actual: { state: "observed", value: snapshot.clockFirstPhase },
            });
          if (Array.isArray(snapshot.clockFirstReadback))
            for (const index of [3, 10, 2, 9, 4, 6])
              facts.push({
                field: `capture.clockFirst.${index}`,
                actual: {
                  state: "observed",
                  value: snapshot.clockFirstReadback[index],
                },
              });
        }
        const accepted = client.sendListenerDiagnostic(event.control, {
          ...event.nativeLifecycle,
          eventId: require("node:crypto").randomUUID(),
          causationId: event.nativeLifecycle.eventId,
          stage: "progress",
          reason: "native_failure_evidence",
          facts,
        });
        if (accepted !== true)
          invalidate("native_failure_diagnostic_delivery_failed");
        if (snapshot.spectrum) {
          const spectralFacts = [];
          const add = (field, value) =>
            spectralFacts.push({
              field: `capture.spectrum.${field}`,
              actual:
                typeof value === "boolean"
                  ? { state: "observed", value: Number(value) }
                  : (typeof value === "number" && Number.isFinite(value)) ||
                      typeof value === "string"
                    ? {
                        state: "observed",
                        value:
                          typeof value === "string"
                            ? value.slice(0, 128)
                            : value,
                      }
                    : { state: "unavailable", reason: "not-reported" },
            });
          for (const field of [
            "enabled",
            "started",
            "phase",
            "failure",
            "cleanup",
            "released",
            "receivedRecords",
            "acceptedRecords",
          ])
            add(field, snapshot.spectrum[field]);
          snapshot.spectrum.fftInformation
            ?.slice(0, 4)
            .forEach((value, index) => add(`fftInformation.${index}`, value));
          snapshot.spectrum.acquisitions
            ?.slice(0, 2)
            .forEach((row, index) =>
              row
                .slice(0, 4)
                .forEach((value, cell) =>
                  add(`acquisition.${index}.${cell}`, value),
                ),
            );
          snapshot.spectrum.lastHeader
            ?.slice(0, 4)
            .forEach((value, index) => add(`header.${index}`, value));
          add("readbackCounter", snapshot.spectrum.lastReadbackCounter);
          if (snapshot.spectrum.startError)
            add("startError", snapshot.spectrum.startError);
          for (let offset = 0; offset < spectralFacts.length; offset += 24) {
            if (
              client.sendListenerDiagnostic(event.control, {
                ...event.nativeLifecycle,
                eventId: require("node:crypto").randomUUID(),
                causationId: event.nativeLifecycle.eventId,
                stage: "progress",
                metric: "spectral-centroid",
                reason: "native_spectrum_failure_evidence",
                facts: spectralFacts.slice(offset, offset + 24),
              }) !== true
            ) {
              invalidate("native_failure_diagnostic_delivery_failed");
              break;
            }
          }
        }
      },
    });
    client = new Client({
      env,
      descriptorPath,
      secretPath,
      secret,
      instanceId: require("node:crypto").randomUUID(),
      signalKind: "audio",
      schemaVersion: protocol.LISTENER_METRIC_PRODUCER_SCHEMA_VERSION,
      displayName: "Audio-Listener",
      producerIdPrefix: "ableton-audio-listener",
      listener: protocol.listenerRegistrationMetricSchema.parse({
        version: 5,
        connectionEpoch: require("node:crypto").randomUUID(),
        capabilities: [protocol.LISTENER_CAPABILITY_METRIC],
        deviceCanonicalPath: identity.canonicalPath,
        trackCanonicalPath: match[1],
        sampleRate: dsp.sampleRate,
        vectorSize: dsp.vectorSize,
        algorithmVersion: protocol.LISTENER_METRIC_ALGORITHM_VERSION,
        nativeStatus: {
          version: 5,
          scope: protocol.LISTENER_METRIC_SCOPE,
          readiness: "BLOCKED",
          alignment: "approximate",
          verifiedAbsoluteErrorBoundSamples: null,
          acceptedSampleRates: [44100, 48000],
          acceptedVectorSizes: [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024],
          supportedModes: ["arrangement", "session"],
          timingModes: ["descriptive", "strict"],
          maxClockDisagreementSamples: 480,
          maxAudioDurationMs: 30000,
          maxReportRows: 2000,
          reason: "fresh_per_pass_native_validation_required",
        },
      }),
      onListenerControl: (control) => {
        if (blocked || closing) throw new Error("metric_runtime_stopping");
        if (control.action === "prepare") {
          if (clockLease) throw new Error("metric_clock_still_owned");
          const epoch = nativeEpoch + 1;
          controller.prepare(control, {
            nativeEpoch: epoch,
            deadlineMs:
              now() +
              (control.config.geometry.totalSamples /
                control.config.geometry.sampleRate) *
                1000 +
              20000,
            maxObservationBytes: protocol.MAX_AUDIO_OBSERVATION_BYTES,
          });
          nativeEpoch = epoch;
          clockLease = control.generation;
          output(
            "native_watchdog_context",
            control.generation,
            control.traceId,
            control.correlationId,
            control.causationId,
          );
          output(
            "native_control",
            "begin",
            control.generation,
            epoch,
            control.config.geometry.sampleRate,
          );
        } else if (control.action === "arm") controller.arm(control);
        else controller.cancel(control);
      },
      onListenerFailure: () =>
        invalidate("sdk_publication_failed_requires_reload"),
      onStatus: (_sink, state) => {
        if (state === "disconnected")
          invalidate("disconnected_requires_reload");
      },
    });
    client.configureProducer(identity);
    client.start();
  }

  maxApi.addHandler("identity", (text) => {
    let next;
    try {
      next = common.validateProducerIdentity(JSON.parse(text));
    } catch {
      invalidate("invalid_producer_identity");
      return;
    }
    if (identity && JSON.stringify(identity) !== JSON.stringify(next)) {
      invalidate("identity_changed_requires_reload");
      return;
    }
    identity = next;
    start();
  });
  maxApi.addHandler("identity-unavailable", () =>
    invalidate("listener_placement_unavailable"),
  );
  maxApi.addHandler("dsp", (on, sampleRate, vectorSize) => {
    if (
      ![44100, 48000].includes(sampleRate) ||
      !Number.isInteger(vectorSize) ||
      vectorSize < 1 ||
      vectorSize > 1024 ||
      (vectorSize & (vectorSize - 1)) !== 0
    ) {
      invalidate("unsupported_dsp_configuration");
      return;
    }
    if (
      dsp &&
      client &&
      (sampleRate !== dsp.sampleRate || vectorSize !== dsp.vectorSize)
    ) {
      invalidate("dsp_configuration_changed");
      return;
    }
    dsp = { on: on === 1, sampleRate, vectorSize };
    if (client && !dsp.on) {
      invalidate("dsp_disabled");
      return;
    }
    start();
  });
  maxApi.addHandler("native", (generation, type, ...values) =>
    controller?.receiveNative("clock", ["native", generation, type, ...values]),
  );
  maxApi.addHandler("flatness_smoke", (...packet) => {
    try {
      flatness.receive(packet);
    } catch (error) {
      invalidate(
        error instanceof Error ? error.message : "flatness_packet_failed",
      );
    }
  });
  maxApi.addHandler("native_spectrum", (...packet) => {
    if (packet[2] === "spectrum") {
      invalidate("invalid_metric_packet");
      return;
    }
    if (packet[2] === "spectrum-json") {
      let values;
      try {
        if (
          packet.length !== 4 ||
          typeof packet[3] !== "string" ||
          packet[3].length > 4096
        )
          throw new Error("invalid_metric_packet");
        values = JSON.parse(packet[3]);
        if (
          !Array.isArray(values) ||
          values.length !== 6 ||
          values.some(
            (value) =>
              typeof value !== "number" ||
              !Number.isFinite(value) ||
              Math.abs(value) > Number.MAX_SAFE_INTEGER,
          )
        )
          throw new Error("invalid_metric_packet");
      } catch {
        invalidate("invalid_metric_packet");
        return;
      }
      packet = [packet[0], packet[1], "spectrum", ...values];
    }
    controller?.receiveNative("metric_spectrum", packet);
  });
  for (const selector of [
    "native_metric",
    "native_metric_status",
    "native_metric_evidence",
    "native_metric_prefix_record",
    "native_metric_record",
    "native_metric_rejection",
  ]) {
    maxApi.addHandler(selector, (text) => {
      try {
        if (typeof text !== "string" || text.length > 32768)
          throw new Error("invalid_metric_packet");
        JSON.parse(text);
      } catch {
        invalidate("invalid_metric_packet");
        return;
      }
      controller?.receiveNative("metric_envelope", [selector, text]);
    });
  }
  maxApi.addHandler("reset", () => invalidate("device_reset"));
  function settle() {
    const snapshot = controller?.snapshot();
    if (snapshot?.cleanup === "failed" && heartbeatEnabled) {
      heartbeatEnabled = false;
      if (blocked) output("diagnostic", "native_cleanup_unconfirmed");
      else invalidate("native_cleanup_unconfirmed");
    }
    if (clockLease && snapshot?.cleanup === "completed") {
      output("native_control", "stop", clockLease);
      output("native_control", "release", clockLease);
      clockLease = null;
    }
    if (
      !stopWaiter ||
      (snapshot &&
        !["idle", "completed", "partial", "failed", "cancelled"].includes(
          snapshot.state,
        ))
    )
      return;
    if (
      snapshot &&
      snapshot.state !== "idle" &&
      !["completed", "failed"].includes(snapshot.cleanup)
    )
      return;
    client?.stop();
    clear(timer);
    const waiter = stopWaiter;
    stopWaiter = null;
    if (snapshot?.cleanup === "failed")
      waiter.reject(new Error("native_cleanup_unconfirmed"));
    else waiter.resolve();
  }
  const timer = interval(() => {
    if (heartbeatEnabled) output("heartbeat");
    controller?.tick();
    settle();
  }, 25);
  timer?.unref?.();

  return Object.freeze({
    stop() {
      if (!closing) {
        blocked = true;
        closing = new Promise((resolve, reject) => {
          stopWaiter = { resolve, reject };
        });
        controller?.dispose();
        settle();
      }
      return closing;
    },
  });
}

module.exports = { createMetricRuntime };
