/* global require, module, process, setInterval, clearInterval */
"use strict";
const { AudioListenerEngine, VERSION } = require("./audio_listener_engine.js");

/**
 * @typedef {{version: 1, timing: "UNVERIFIED", readiness: "BLOCKED",
 * reason: "real_live_timing_validation_required"}} NativeStatus
 */
/** @type {Readonly<NativeStatus>} */
const NATIVE_STATUS = Object.freeze({
  version: 1,
  timing: "UNVERIFIED",
  readiness: "BLOCKED",
  reason: "real_live_timing_validation_required",
});

/** Device evidence comes verbatim from the shared Max identity's canonicalPath.
 * That companion does not return a separate track path. For top-level devices
 * ONLY, its canonical parent is the literal matched prefix; never use IDs/names
 * or path hashes to reconstruct paths. These strings are reported, not attested.
 */
function canonicalPaths(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 256) {
    throw new Error("invalid_canonical_device_path");
  }
  const match =
    /^(live_set (?:tracks (0|[1-9][0-9]*)|return_tracks (0|[1-9][0-9]*)|master_track)) devices (0|[1-9][0-9]*)$/.exec(
      value,
    );
  if (
    !match ||
    match[0] !== value ||
    match
      .slice(2)
      .some(
        (index) => index !== undefined && !Number.isSafeInteger(Number(index)),
      )
  ) {
    throw new Error("invalid_canonical_device_path");
  }
  return Object.freeze({
    deviceCanonicalPath: value,
    trackCanonicalPath: match[1],
  });
}

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

/** Dependency injection is used by isolated installed-artifact tests. The ONLY
 * connection implementation is the common AgentSignalClient.
 */
function createRuntime({
  maxApi,
  env = process.env,
  Client,
  clock = Date.now,
  interval = setInterval,
  clear = clearInterval,
  certificate = null,
} = {}) {
  const common = sharedClient();
  Client = Client ?? common.AgentSignalClient;
  let client = null;
  let engine = null;
  let identity = null;
  let identityPaths = null;
  let control = null;
  let dsp = null;
  let host = null;
  let generation = 0;
  let nativeZero = null;
  let attackThresholdDb = 6;
  let attackSpacingMs = 100;
  let discoveryDiagnosticReason = null;
  let registeredDsp = null;
  let registeredInstanceId = null;
  let observedConnectionEpoch = null;
  let registrationGeneration = 0;
  let stopped = false;
  const timers = [];
  const output = (...args) => maxApi.outlet(...args);
  const fail = (reason) => {
    nativeZero = null;
    engine?.reset(reason);
    output("analysis", 0, 1, dsp?.sampleRate ?? 0);
  };
  function discoveryFailure(reason) {
    if (discoveryDiagnosticReason === reason) return;
    fail(reason);
    output("diagnostic", reason);
    discoveryDiagnosticReason = reason;
  }
  const restartRegistration = (reason) => {
    // Fence queued callbacks before touching the old client/engine.
    registrationGeneration++;
    fail(reason);
    client?.stop();
    client = null;
    engine = null;
    control = null;
    registeredDsp = null;
    registeredInstanceId = null;
    observedConnectionEpoch = null;
  };
  function refreshRegistration() {
    if (!client || stopped) return false;
    let reason = null;
    if (
      (client.instanceId !== undefined &&
        client.instanceId !== registeredInstanceId) ||
      (client.producer?.instanceId !== undefined &&
        client.producer.instanceId !== registeredInstanceId)
    ) {
      reason = "producer_instance_changed";
    }
    const epoch = client.listener?.connectionEpoch;
    if (epoch !== undefined) {
      if (typeof epoch !== "string" || !epoch || epoch.length > 128)
        reason = "invalid_connection_epoch";
      else if (observedConnectionEpoch === null)
        observedConnectionEpoch = epoch;
      else if (epoch !== observedConnectionEpoch)
        reason = reason ?? "connection_epoch_changed";
    }
    if (!reason) return false;
    restartRegistration(reason);
    maybeStart();
    return true;
  }
  function terminal(event) {
    if (event.type !== "terminal" || !client || !control) return;
    if (event.status === "cancelled")
      client.sendListenerReply(control, { status: "cancelled" });
    else
      client.sendListenerResult(control, {
        status: event.status === "complete" ? "completed" : event.status,
        reason: event.reason,
        ...(event.observation ? { observation: event.observation } : {}),
      });
    control = null;
    nativeZero = null;
  }
  function maybeStart() {
    if (
      stopped ||
      client ||
      !identity ||
      !identityPaths ||
      !dsp ||
      !host ||
      !dsp.dspOn
    )
      return;
    // The shared client's reader is the ONLY installed configuration parser.
    // Explicit overrides win, but neither absent nor malformed profile evidence
    // may silently fall through to the MIDI client's legacy discovery defaults.
    const paths = require("node:path");
    if (typeof common.installedDiscoveryPaths !== "function") {
      discoveryFailure("installed_profile_reader_unavailable");
      return;
    }
    let installed;
    try {
      installed = common.installedDiscoveryPaths();
    } catch {
      discoveryFailure("invalid_installed_profile_configuration");
      return;
    }
    const descriptorPath =
      env[common.DEFAULT_DESCRIPTOR_ENV] ?? installed?.descriptorPath;
    const secretPath =
      env[common.DEFAULT_SECRET_PATH_ENV] ?? installed?.secretPath;
    const inlineSecret = env[common.DEFAULT_SECRET_ENV];
    const hasInlineSecret =
      typeof inlineSecret === "string" && inlineSecret.trim().length > 0;
    if (
      typeof descriptorPath !== "string" ||
      !paths.isAbsolute(descriptorPath) ||
      (secretPath !== undefined &&
        (typeof secretPath !== "string" || !paths.isAbsolute(secretPath))) ||
      (!hasInlineSecret && secretPath === undefined)
    ) {
      discoveryFailure("explicit_profile_discovery_required");
      return;
    }
    discoveryDiagnosticReason = null;
    const instanceId = require("node:crypto").randomUUID();
    const listenerId = common.producerIdForCanonicalPath(
      identity.canonicalPath,
      "ableton-audio-listener",
    );
    engine = new AudioListenerEngine({
      listenerId,
      now: clock,
      certificate,
      emit: terminal,
      analysis: (on, reset) => {
        if (reset) {
          nativeZero = null;
          generation++;
        }
        output("analysis", Number(on), Number(reset), dsp.sampleRate);
      },
    });
    engine.configureHost({ ...host, ...dsp });
    const thisRegistration = ++registrationGeneration;
    const current = () =>
      !stopped && thisRegistration === registrationGeneration;
    client = new Client({
      env,
      descriptorPath,
      secretPath,
      instanceId,
      signalKind: "audio",
      schemaVersion: "audio-observation/v1",
      displayName: "Audio-Listener",
      producerIdPrefix: "ableton-audio-listener",
      listener: {
        version: 1,
        ...identityPaths,
        nativeStatus: NATIVE_STATUS,
        capabilities: ["audio-listener/v1"],
        sampleRate: dsp.sampleRate,
        algorithmVersion: VERSION,
      },
      onListenerFailure: (reason) => {
        if (current()) fail(reason);
      },
      onStatus: (_sink, state) => {
        if (!current()) return;
        if (state === "disconnected") fail("disconnected");
        if (state === "authenticating" || state === "connected")
          refreshRegistration();
        // A transport connection never certifies timing or advances native readiness.
      },
      onListenerControl: (message) => {
        if (!current()) return;
        refreshRegistration();
        if (!current()) return;
        try {
          if (message.action === "prepare") {
            control = message;
            const config = message.config;
            if (
              !config ||
              !config.source ||
              !Number.isInteger(config.durationMs) ||
              config.durationMs < 1 ||
              config.durationMs > 120000 ||
              !Number.isInteger(config.maxWindows) ||
              config.maxWindows < 1 ||
              config.maxWindows > 512
            ) {
              throw new Error("invalid_capture_bounds");
            }
            engine.prepare({
              ...message,
              ...config.source,
              maxWindows: config.maxWindows,
              durationMs: config.durationMs,
              settings: {
                attackThresholdDb,
                minAttackSpacingSamples: Math.round(
                  (attackSpacingMs * dsp.sampleRate) / 1000,
                ),
              },
            });
            client.sendListenerReply(message, { status: "ready" });
          } else if (message.action === "arm") {
            control = message;
            engine.arm(message);
            client.sendListenerReply(message, { status: "armed" });
          } else if (message.action === "cancel") {
            control = message;
            engine.cancel(message);
          }
        } catch (error) {
          const failedControl = message;
          control = null; // do not publish a second terminal response on prepare failure
          fail("control_failed");
          client.sendListenerReply(failedControl, {
            status: "failed",
            reason: String(error.message).slice(0, 240),
          });
        }
      },
    });
    client.configureProducer(identity);
    registeredInstanceId = instanceId;
    registeredDsp = { sampleRate: dsp.sampleRate, vectorSize: dsp.vectorSize };
    client.start();
  }
  maxApi.addHandler("identity", (text) => {
    let next, nextPaths;
    try {
      const reported = JSON.parse(text);
      nextPaths = canonicalPaths(reported?.canonicalPath);
      next = common.validateProducerIdentity(reported);
    } catch {
      restartRegistration("invalid_canonical_device_path");
      identity = null;
      identityPaths = null;
      output("diagnostic", "invalid_canonical_device_path");
      return;
    }
    if (identity && JSON.stringify(identity) !== JSON.stringify(next))
      restartRegistration("identity_changed");
    identity = next;
    identityPaths = nextPaths;
    maybeStart();
  });
  maxApi.addHandler("dsp", (on, sampleRate, vectorSize) => {
    if (
      !Number.isInteger(sampleRate) ||
      sampleRate < 8000 ||
      sampleRate > 384000 ||
      !Number.isInteger(vectorSize) ||
      vectorSize < 1 ||
      vectorSize > 65536
    ) {
      fail("invalid_dsp_metadata");
      dsp = null;
      return;
    }
    if (
      registeredDsp &&
      (sampleRate !== registeredDsp.sampleRate ||
        vectorSize !== registeredDsp.vectorSize)
    ) {
      restartRegistration("dsp_configuration_changed");
    }
    dsp = { dspOn: on === 1, sampleRate, vectorSize };
    if (engine && host) engine.configureHost({ ...host, ...dsp });
    maybeStart();
  });
  maxApi.addHandler("host", (playing, beat, sample, flags) => {
    if (
      ![0, 1].includes(playing) ||
      !Number.isFinite(beat) ||
      beat < 0 ||
      !Number.isSafeInteger(sample) ||
      sample < 0 ||
      !Number.isInteger(flags) ||
      flags < 0
    ) {
      fail("invalid_host_metadata");
      host = null;
      return;
    }
    host = { playing: playing === 1, beat, sample, flags };
    if (engine && dsp) engine.configureHost({ ...host, ...dsp });
    maybeStart();
  });
  maxApi.addHandler(
    "frame",
    (peakL, peakR, rmsL, rmsR, localSample, centroid, energy) => {
      if (
        !engine?.pass ||
        engine.state !== "capturing" ||
        !host ||
        localSample <= 0
      )
        return;
      // Absolute DSP counter + calibrated host anchor. Receipt times never become
      // capture coordinates. An actual runner must verify reset/snapshot ordering.
      nativeZero = nativeZero ?? 0;
      const p = engine.pass;
      const sample = p.startSample + localSample - nativeZero;
      const offset = p.certificate.descriptorOffsetSamples;
      try {
        engine.ingest(
          {
            sample: sample - offset,
            beat: host.beat,
            peak: [peakL, peakR],
            rms: [rmsL, rmsR],
            centroidHz: energy <= 1e-20 ? null : centroid,
            spectralEnergy: energy,
            windowSamples: p.hop,
          },
          { passId: p.passId, connectionEpoch: p.connectionEpoch },
        );
        if (p === engine.pass && p.rangeEnded) engine.finish();
        else if (
          p === engine.pass &&
          (localSample / dsp.sampleRate) * 1000 >= p.durationMs
        ) {
          engine.terminate("partial", "duration_limit");
        }
      } catch {
        fail("invalid_native_descriptor");
      }
    },
  );
  maxApi.addHandler("reset", () => fail("reset"));
  // Settings are frozen at prepare; automation affects only the next pass.
  maxApi.addHandler("attack-threshold", (value) => {
    if (Number.isFinite(value) && value >= 0 && value <= 120)
      attackThresholdDb = value;
  });
  maxApi.addHandler("attack-spacing-ms", (value) => {
    if (Number.isFinite(value) && value >= 100 && value <= 2000)
      attackSpacingMs = value;
  });
  maxApi.addHandler("device-enabled", (value) => {
    if (value !== 1) fail("device_disabled");
  });
  timers.push(
    interval(() => {
      if (stopped) return;
      refreshRegistration();
      output("heartbeat");
      engine?.tick();
    }, 250),
  );
  return {
    get engine() {
      return engine;
    },
    get client() {
      return client;
    },
    get generation() {
      return generation;
    },
    get nativeStatus() {
      return NATIVE_STATUS;
    },
    refreshRegistration,
    stop() {
      if (stopped) return;
      stopped = true;
      registrationGeneration++;
      fail("runtime_stopped");
      timers.forEach(clear);
      client?.stop();
    },
  };
}
module.exports = { createRuntime, canonicalPaths, NATIVE_STATUS };
if (require.main === module) {
  // There is intentionally NO production certificate loader. Host validity,
  // sample offsets AND actual Session source-onset alignment remain unverified.
  // A generic certificate file cannot certify a particular quantized clip launch.
  // Injected certificates are for test/approved runner adapters only. Shipping
  // prepare fails closed until a verified native launch adapter is implemented.
  const runtime = createRuntime({ maxApi: require("max-api") });
  process.once("SIGTERM", () => {
    runtime.stop();
    process.exit(0);
  });
  process.once("SIGINT", () => {
    runtime.stop();
    process.exit(0);
  });
}
