/* global require, module, process, Buffer, setInterval, clearInterval */
"use strict";
const { AudioListenerEngine, VERSION } = require("./audio_listener_engine.js");
const NATIVE_DIAGNOSTIC_LIMIT = 200;

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
 * nativeMode: true is a constructor-only, inactive engineering selection.
 * It advertises fixed scope, not readiness, and requires fresh per-pass proof.
 * Legacy host/frame inputs never provide native evidence; playback is App-owned.
 */
function createRuntime({
  maxApi,
  env = process.env,
  Client,
  clock = Date.now,
  interval = setInterval,
  clear = clearInterval,
  certificate = null,
  nativeMode = false,
  nativeVersion = 1,
} = {}) {
  if (typeof nativeMode !== "boolean") throw new Error("invalid_native_mode");
  if (![1, 2].includes(nativeVersion) || (nativeVersion === 2 && !nativeMode))
    throw new Error("invalid_native_version");
  const common = sharedClient();
  const nativeStatus =
    nativeVersion === 2
      ? Object.freeze({
          version: 2,
          scope: "arrangement-descriptive/v2",
          readiness: "BLOCKED",
          alignment: "approximate",
          verifiedAbsoluteErrorBoundSamples: null,
          acceptedSampleRates: Object.freeze([44100, 48000]),
          acceptedVectorSizes: Object.freeze([
            1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024,
          ]),
          timingModes: Object.freeze(["descriptive", "strict"]),
          maxClockDisagreementSamples: 480,
          maxAudioDurationMs: 30000,
          maxWindows: 300,
          abiVersion: 2,
          reason: "fresh_per_pass_native_validation_required",
        })
      : nativeMode
        ? Object.freeze({
            ...NATIVE_STATUS,
            scope: require("./audio_listener_native_controller.js")
              .NATIVE_CAPTURE_SCOPE,
            reason: "fresh_per_pass_native_validation_required",
          })
        : NATIVE_STATUS;
  Client = Client ?? common.AgentSignalClient;
  let client = null;
  let engine = null;
  let identity = null;
  let identityPaths = null;
  let control = null;
  let dsp = null;
  let host = null;
  let invalidPreviewReported = false;
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
  let nativeController = null;
  let pendingArm = null;
  let nativePublished = false;
  let nativePublishing = 0;
  let drainingControls = false;
  const nativeControls = [];
  let nativeDiagnostics = null;
  let pendingQuotaFailure = null;
  let pendingNativeReply = null;
  let lastNativeDisarm = null;
  let deferredNativeFailure = null;
  const timers = [];
  const output = (...args) => maxApi.outlet(...args);
  const fail = (reason) => {
    nativeZero = null;
    if (nativeMode) {
      if (
        nativeVersion === 2 &&
        ((pendingArm && !pendingArm.published) ||
          pendingNativeReply ||
          reason === "disconnected" ||
          stopped)
      ) {
        const operation = pendingArm;
        const job = client?.listenerJob;
        const invalid =
          stopped ||
          reason === "disconnected" ||
          (operation && !operation.current()) ||
          (pendingNativeReply && !pendingNativeReply.current());
        if (operation) operation.cancelled = true;
        pendingArm = null;
        if (invalid) {
          pendingNativeReply = null;
          lastNativeDisarm = null;
        } else if (operation && !pendingQuotaFailure) {
          queueNativeReply(
            operation.message,
            {
              status: "failed",
              reason: operation.failureReason ?? nativeReason(reason),
            },
            operation.pass,
            nativeController,
            operation.current,
          );
        }
        control = null;
        nativePublished = false;
        discardNativeDiagnostics();
        for (const item of nativeControls.splice(0))
          controlDiagnostic(item, "cancelled");
        nativeController?.reset(nativeReason(reason));
        settleNativeReply();
        if (
          !pendingNativeReply &&
          !pendingQuotaFailure &&
          client &&
          client.listenerJob === job
        )
          client.listenerJob = null;
        return;
      }
      const operation = pendingArm;
      const selected = control;
      if (pendingArm) pendingArm.cancelled = true;
      pendingArm = null;
      nativeController?.reset(nativeReason(reason));
      if (
        operation &&
        !operation.published &&
        nativePublishing === 0 &&
        operation.current() &&
        canPublishNative(operation.message)
      ) {
        publishNative("reply", operation.message, {
          status: "failed",
          reason: nativeReason(reason),
        });
      }
      if (
        selected &&
        client?.listenerJob?.passId === selected.passId &&
        client.listenerJob.connectionEpoch === selected.connectionEpoch
      )
        client.listenerJob = null;
      control = null;
      nativePublished = false;
      discardNativeDiagnostics();
      for (const item of nativeControls.splice(0))
        controlDiagnostic(item, "cancelled");
    } else {
      engine?.reset(reason);
      output("analysis", 0, 1, dsp?.sampleRate ?? 0);
    }
  };
  function nativeReason(reason) {
    return typeof reason === "string" && /^[a-z][a-z0-9_]{0,127}$/.test(reason)
      ? reason
      : "native_runtime_failed";
  }
  function nativeWire(message) {
    const keys = [
      "requestId",
      "connectionEpoch",
      "jobId",
      "passId",
      "traceId",
      "correlationId",
      "causationId",
    ];
    if (
      (nativeVersion === 2 &&
        (message.protocolVersion !== 1 ||
          message.listenerVersion !== 2 ||
          (message.action === "prepare") !== (message.config !== undefined))) ||
      !keys.every(
        (key) =>
          typeof message[key] === "string" &&
          /^[a-zA-Z0-9_.:-]{1,128}$/.test(message[key]),
      ) ||
      !["prepare", "arm", "cancel"].includes(message.action)
    )
      throw new Error("invalid_native_wire_context");
    return Object.freeze({
      ...Object.fromEntries(
        [...keys, "action"].map((key) => [key, message[key]]),
      ),
      ...(nativeVersion === 2
        ? { protocolVersion: 1, listenerVersion: 2 }
        : {}),
    });
  }
  function canPublishNative(message) {
    return (
      !!client &&
      !stopped &&
      client.authenticated === true &&
      !!message &&
      message.connectionEpoch === client.listener?.connectionEpoch
    );
  }
  function nativeFailureFields(message, value, pass) {
    const diagnostic = pass?.nativeFailureDiagnostic;
    return nativeVersion === 2 &&
      value.status === "failed" &&
      diagnostic &&
      diagnostic.generation === pass.generation &&
      value.reason === pass.nativeFailureReason &&
      ["passId", "connectionEpoch", "traceId", "correlationId"].every(
        (key) => pass.command[key] === message[key],
      )
      ? { nativeFailureDiagnostic: diagnostic }
      : {};
  }
  function queueNativeReply(message, value, pass, adapter, current) {
    const previous = pendingNativeReply;
    pendingNativeReply = {
      message,
      value:
        previous?.pass === pass && previous.value.status === "failed"
          ? previous.value
          : { ...value, ...nativeFailureFields(message, value, pass) },
      pass,
      adapter,
      current,
      job: client?.listenerJob,
    };
  }
  function settleNativeReply() {
    const pending = pendingNativeReply;
    if (!pending) return;
    if (
      !pending.current() ||
      pending.adapter !== nativeController ||
      !canPublishNative(pending.message) ||
      client.listenerJob !== pending.job
    ) {
      pendingNativeReply = null;
      return;
    }
    const receipt =
      lastNativeDisarm?.generation === pending.pass.generation
        ? lastNativeDisarm
        : null;
    if (
      pending.pass.beginAttempted
        ? !receipt
        : pending.adapter.pass === pending.pass
    )
      return;
    pendingNativeReply = null;
    if (
      control?.passId === pending.message.passId &&
      control.connectionEpoch === pending.message.connectionEpoch
    ) {
      control = null;
      nativePublished = false;
    }
    if (nativeDiagnostics?.generation === pending.pass.generation)
      discardNativeDiagnostics();
    publishNative(
      "reply",
      pending.message,
      receipt && !receipt.confirmed
        ? {
            ...pending.value,
            status: "failed",
            reason: `${pending.value.reason}_native_stop_ack_timeout_unconfirmed`,
          }
        : pending.value,
    );
  }
  function discardNativeDiagnostics() {
    if (nativeDiagnostics) nativeDiagnostics.events.length = 0;
    nativeDiagnostics = null;
  }
  function queueNativeDiagnostic(scope, event) {
    if (scope.events.length >= NATIVE_DIAGNOSTIC_LIMIT) {
      scope.failureReason = "native_diagnostic_buffer_overflow";
      output("diagnostic", scope.failureReason);
      throw new Error(scope.failureReason);
    }
    scope.events.push(Object.freeze(event));
  }
  function diagnosticLifecycle(
    scope,
    event,
    phase,
    elapsedMs = event.elapsedMs,
  ) {
    return {
      ...(nativeVersion === 2 ? { scope: nativeStatus.scope } : {}),
      eventId: event.eventId,
      causationId: event.causationId,
      phase,
      generation: scope.generation,
      stage: event.stage,
      nativeEpoch: event.nativeEpoch,
      elapsedMs: Math.min(120000, Math.max(0, elapsedMs)),
      frames: 0,
      ...(event.reason ? { reason: event.reason } : {}),
    };
  }
  function resetEvent(scope, stage, reason) {
    const event = {
      eventId: require("node:crypto").randomUUID(),
      causationId: scope.lastResetId ?? scope.preflightCompletedId,
      stage,
      nativeEpoch: scope.targetEpoch,
      elapsedMs: Math.min(120000, Math.max(0, clock() - scope.resetAt)),
      ...(reason ? { reason } : {}),
    };
    const lifecycle = diagnosticLifecycle(scope, event, "reset");
    scope.lastResetId = event.eventId;
    if (["completed", "failed", "cancelled"].includes(stage))
      scope.resetTerminal = true;
    output(
      "native_diagnostic",
      JSON.stringify({
        ...lifecycle,
        type: "native-reset-stage",
        traceId: scope.command.traceId,
        correlationId: scope.command.correlationId,
        passId: scope.command.passId,
        connectionEpoch: scope.command.connectionEpoch,
      }),
    );
    queueNativeDiagnostic(scope, lifecycle);
  }
  function observeNative(event, current) {
    if (event.type === "native-disarm-stage") {
      output("native_diagnostic", JSON.stringify({ ...event, phase: "reset" }));
      return;
    }
    if (!current()) return;
    if (
      nativeVersion === 2 &&
      event.type === "native-preflight-stage" &&
      event.stage === "failed" &&
      pendingArm?.generation === event.generation &&
      !pendingArm.published
    )
      pendingArm.failureReason ??= nativeReason(event.reason);
    const scope = nativeDiagnostics;
    let phase = "capture";
    if (scope && !nativePublished) {
      if (!scope.preflightCompletedId) phase = "preflight";
      else phase = "reset";
    }
    output("native_diagnostic", JSON.stringify({ ...event, phase }));
    if (event.type === "native-tempo-observation") return;
    if (
      scope &&
      nativePublished &&
      phase === "capture" &&
      event.stage === "progress" &&
      ["phase_torn_native_clock", "torn_native_spectrum"].includes(event.reason)
    ) {
      const startedAt = engine.pass?.startedAt;
      if (!Number.isFinite(startedAt))
        throw new Error("native_capture_timing_missing");
      if (
        !nativeEvent(
          {
            ...event,
            type: "native-capture-stage",
            frames: engine.pass.points.length,
            elapsedMs: Math.min(120000, Math.max(0, clock() - startedAt)),
          },
          current,
        )
      )
        throw new Error("native_wire_publication_failed");
      return;
    }
    if (!scope || nativePublished || scope.failureReason) return;
    if (phase === "preflight") {
      if (event.stage === "completed")
        scope.preflightCompletedId = event.eventId;
      queueNativeDiagnostic(scope, diagnosticLifecycle(scope, event, phase));
    } else if (event.stage === "progress" && !scope.resetTerminal) {
      scope.lastResetId = event.eventId;
      queueNativeDiagnostic(
        scope,
        diagnosticLifecycle(
          scope,
          event,
          "reset",
          event.elapsedMs - scope.resetBaseElapsed,
        ),
      );
    } else if (
      !scope.resetTerminal &&
      ["failed", "cancelled"].includes(event.stage)
    ) {
      if (scope.resetAt === null) {
        scope.targetEpoch = event.nativeEpoch;
        scope.resetAt = clock();
      }
      resetEvent(scope, event.stage, event.reason);
    }
    // A reservation may expire without arm ever being requested. There is no
    // legal pre-armed result; release its SDK job after retaining local failure.
    if (
      !pendingArm &&
      control?.action === "prepare" &&
      ["failed", "cancelled"].includes(event.stage)
    ) {
      if (client?.listenerJob?.passId === control.passId)
        client.listenerJob = null;
      control = null;
      discardNativeDiagnostics();
    }
  }
  function flushNativeDiagnostics(scope, selected, current) {
    while (
      nativeDiagnostics === scope &&
      scope.events.length &&
      current() &&
      nativePublished &&
      canPublishNative(selected)
    ) {
      const event = scope.events.shift();
      if (
        !publishNative("result", selected, {
          status: "progress",
          nativeLifecycle: { ...event, nativeEpoch: scope.targetEpoch },
        })
      )
        return false;
    }
    return nativeDiagnostics === scope && scope.events.length === 0;
  }
  function controlDiagnostic(item, stage) {
    if (!item.current()) return;
    const eventId = require("node:crypto").randomUUID();
    const { message } = item;
    try {
      output(
        "native_diagnostic",
        JSON.stringify({
          type: "native-runtime-control-stage",
          ...(nativeVersion === 2 ? { scope: nativeStatus.scope } : {}),
          eventId,
          stage,
          traceId: message.traceId,
          correlationId: message.correlationId,
          causationId: item.cause,
          passId: message.passId,
          connectionEpoch: message.connectionEpoch,
          elapsedMs: Math.min(120000, Math.max(0, clock() - item.at)),
          queued: nativeControls.length,
          reason: "wire_publication_pending",
        }),
      );
    } catch {
      // Diagnostic delivery cannot obstruct bounded wire/cancellation cleanup.
    }
    item.cause = eventId;
  }
  function publishNative(kind, message, value, confirm = () => {}) {
    nativePublishing++;
    try {
      if (nativeVersion === 2) {
        const projected = {
          ...value,
          type: kind === "reply" ? "listener.reply" : "listener.result",
          protocolVersion: 1,
          listenerVersion: 2,
          requestId: "x".repeat(128),
          sequence: Number.MAX_SAFE_INTEGER,
          ...Object.fromEntries(
            [
              "connectionEpoch",
              "jobId",
              "passId",
              "traceId",
              "correlationId",
              "causationId",
            ].map((key) => [key, message[key]]),
          ),
        };
        if (Buffer.byteLength(JSON.stringify(projected), "utf8") > 128 * 1024) {
          output("diagnostic", "native_result_frame_quota_exceeded");
          const owner =
            nativeController?.pass?.generation ??
            nativeController?.pendingDisarm?.generation;
          if (owner) pendingQuotaFailure = { generation: owner, message };
          fail("native_result_frame_quota_exceeded");
          if (!owner && canPublishNative(message))
            publishNative("result", message, {
              status: "failed",
              reason: "native_disarm_receipt_missing",
            });
          return false;
        }
      }
      const sent =
        (kind === "reply"
          ? client.sendListenerReply(message, value)
          : client.sendListenerResult(message, value)) === true;
      confirm(sent);
      return sent;
    } catch {
      fail("native_wire_publication_failed");
      return false;
    } finally {
      nativePublishing--;
      if (nativePublishing === 0 && !drainingControls) {
        drainingControls = true;
        try {
          const failure = deferredNativeFailure;
          deferredNativeFailure = null;
          if (failure?.current()) {
            fail(
              pendingArm && !pendingArm.published
                ? "native_armed_publication_failed"
                : failure.reason,
            );
            if (!nativeController?.pass) deferredNativeFailure = null;
          }
          let processed = 0;
          while (nativeControls.length) {
            if (processed++ >= 32) {
              fail("native_control_queue_overflow");
              break;
            }
            const item = nativeControls.shift();
            if (!item.current() || !canPublishNative(item.message)) {
              controlDiagnostic(item, "cancelled");
              continue;
            }
            controlDiagnostic(item, "started");
            nativeControl(item.message, item.current);
            controlDiagnostic(item, "completed");
          }
        } finally {
          drainingControls = false;
        }
      }
    }
  }
  function discoveryFailure(reason) {
    if (discoveryDiagnosticReason === reason) return;
    fail(reason);
    output("diagnostic", reason);
    discoveryDiagnosticReason = reason;
  }
  const restartRegistration = (reason) => {
    // Fence queued callbacks before touching the old client/engine.
    registrationGeneration++;
    pendingNativeReply = null;
    lastNativeDisarm = null;
    fail(reason);
    if (nativeVersion === 2)
      nativeController?.disarmed(false, "native_stop_unconfirmed");
    client?.stop();
    client = null;
    engine = null;
    nativeController = null;
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
    if (!reason) {
      if (
        nativeMode &&
        control &&
        nativeController?.pass &&
        (!client.listenerJob ||
          client.listenerJob.jobId !== control.jobId ||
          client.listenerJob.passId !== control.passId ||
          client.listenerJob.connectionEpoch !== control.connectionEpoch)
      ) {
        if (pendingArm) pendingArm.cancelled = true;
        pendingArm = null;
        control = null;
        nativePublished = false;
        discardNativeDiagnostics();
        fail("listener_job_changed");
        return true;
      }
      return false;
    }
    if (nativeMode && reason === "connection_epoch_changed") {
      fail(reason);
      observedConnectionEpoch = epoch;
      return true;
    }
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
  function nativeEvent(event, current) {
    if (!current() || !nativePublished || !canPublishNative(control))
      return true;
    const selected = control;
    if (event.type === "native-capture-stage") {
      if (
        event.traceId !== selected.traceId ||
        event.correlationId !== selected.correlationId
      )
        return false;
      const nativeLifecycle = Object.fromEntries(
        [
          "eventId",
          "causationId",
          "stage",
          "nativeEpoch",
          "elapsedMs",
          "frames",
          ...(event.reason ? ["reason"] : []),
        ].map((key) => [key, event[key]]),
      );
      nativeLifecycle.phase = "capture";
      if (nativeVersion === 2) nativeLifecycle.scope = nativeStatus.scope;
      nativeLifecycle.generation = nativeDiagnostics?.generation;
      return publishNative("result", selected, {
        status: "progress",
        nativeLifecycle,
        ...(event.nativeLaunch ? { nativeLaunch: event.nativeLaunch } : {}),
      });
    }
    if (event.type !== "terminal") return true;
    if (
      nativeVersion === 2 &&
      selected.action === "cancel" &&
      pendingNativeReply
    )
      return true;
    const failureFields = nativeFailureFields(
      selected,
      event,
      nativeController?.pass,
    );
    control = null;
    nativePublished = false;
    discardNativeDiagnostics();
    if (event.status === "cancelled" && selected.action === "cancel")
      return publishNative("reply", selected, {
        status: "cancelled",
        ...(nativeVersion === 2 ? { reason: "cancelled" } : {}),
      });
    return publishNative("result", selected, {
      status:
        event.status === "complete"
          ? "completed"
          : event.status === "cancelled"
            ? event.observation
              ? "partial"
              : "failed"
            : event.status,
      reason: nativeReason(event.reason),
      ...(event.observation ? { observation: event.observation } : {}),
      ...(event.status === "complete"
        ? { nativeCapture: event.nativeCapture }
        : {}),
      ...failureFields,
    });
  }
  function nativeControl(message, current) {
    if (!current() || !canPublishNative(message)) return;
    const selected = nativeWire(message);
    if (nativePublishing > 0) {
      if (nativeControls.length >= 32) {
        fail("native_control_queue_overflow");
        return;
      }
      const config =
        message.action === "prepare" && message.config
          ? nativeVersion === 2
            ? Object.freeze({
                geometry: Object.freeze({ ...message.config.geometry }),
                timingPolicy: Object.freeze({ ...message.config.timingPolicy }),
              })
            : Object.freeze({
                durationMs: message.config.durationMs,
                maxWindows: message.config.maxWindows,
                source: Object.freeze({
                  mode: message.config.source?.mode,
                  startBeat: message.config.source?.startBeat,
                  endBeat: message.config.source?.endBeat,
                }),
              })
          : undefined;
      const item = {
        message: Object.freeze({ ...selected, ...(config ? { config } : {}) }),
        current,
        at: clock(),
        cause: selected.causationId,
      };
      nativeControls.push(item);
      controlDiagnostic(item, "queued");
      return;
    }
    const adapter = nativeController;
    const owner = control ?? pendingNativeReply?.message;
    if (
      message.action !== "prepare" &&
      (!owner ||
        owner.passId !== selected.passId ||
        owner.jobId !== selected.jobId ||
        owner.connectionEpoch !== selected.connectionEpoch ||
        owner.traceId !== selected.traceId ||
        owner.correlationId !== selected.correlationId)
    ) {
      publishNative("reply", selected, {
        status: "failed",
        reason: "ownership_mismatch",
      });
      return;
    }
    try {
      if (message.action === "prepare") {
        if (adapter.pass) throw new Error("listener_busy");
        const config = message.config;
        if (nativeVersion === 2) {
          const {
            nativeV2Configuration,
          } = require("./audio_listener_native_coordinates.js");
          const checked = nativeV2Configuration(
            config?.geometry,
            config?.timingPolicy,
          );
          if (
            !dsp?.dspOn ||
            dsp.sampleRate !== checked.geometry.sampleRate ||
            dsp.vectorSize !== checked.geometry.vectorSize ||
            Object.keys(config).some(
              (key) => !["geometry", "timingPolicy"].includes(key),
            )
          )
            throw new Error("unsupported_native_capture_scope");
          adapter.prepare({
            ...selected,
            geometry: checked.geometry,
            timingPolicy: checked.policy,
          });
        } else {
          if (
            !config?.source ||
            dsp?.sampleRate !== 48000 ||
            dsp?.vectorSize !== 64 ||
            !dsp?.dspOn
          )
            throw new Error("unsupported_native_capture_scope");
          adapter.prepare({
            ...selected,
            ...config.source,
            durationMs: config.durationMs,
            maxWindows: config.maxWindows,
            settings: {
              attackThresholdDb,
              minAttackSpacingSamples: Math.round(attackSpacingMs * 48),
            },
          });
        }
        nativeDiagnostics = {
          generation: adapter.pass.generation,
          command: adapter.pass.command,
          events: [],
          targetEpoch: null,
          preflightCompletedId: null,
          resetAt: null,
          resetBaseElapsed: 0,
          lastResetId: null,
          resetTerminal: false,
          failureReason: null,
        };
        control = selected;
        nativePublished = false;
        if (!publishNative("reply", selected, { status: "ready" }))
          fail("native_ready_publication_failed");
      } else if (message.action === "arm") {
        if (adapter.state !== "prepared")
          throw new Error("native_controller_duplicate_arm");
        control = selected;
        const operation = {
          message: selected,
          generation: adapter.pass.generation,
          pass: adapter.pass,
          published: false,
          cancelled: false,
          current,
        };
        pendingArm = operation;
        return adapter.arm(selected).then(
          () => {
            if (pendingArm === operation) pendingArm = null;
          },
          (error) => {
            if (
              pendingArm === operation &&
              !operation.published &&
              !operation.cancelled &&
              current() &&
              canPublishNative(selected)
            ) {
              control = null;
              pendingArm = null;
              const value = {
                status: "failed",
                reason:
                  operation.failureReason ??
                  nativeDiagnostics?.failureReason ??
                  nativeReason(error.message),
              };
              if (nativeVersion === 2) {
                queueNativeReply(
                  selected,
                  value,
                  operation.pass,
                  adapter,
                  current,
                );
                settleNativeReply();
              } else publishNative("reply", selected, value);
            }
            if (nativeDiagnostics?.generation === operation.generation)
              discardNativeDiagnostics();
          },
        );
      } else if (message.action === "cancel") {
        const operation = pendingArm;
        if (pendingArm) pendingArm.cancelled = true;
        pendingArm = null;
        control = selected;
        if (nativeVersion === 2) {
          const pass =
            pendingNativeReply?.pass ??
            (adapter.pass
              ? adapter.checkOwner(selected)
              : operation && !operation.published
                ? operation.pass
                : adapter.checkOwner(selected));
          queueNativeReply(
            selected,
            operation?.failureReason
              ? { status: "failed", reason: operation.failureReason }
              : { status: "cancelled", reason: "cancelled" },
            pass,
            adapter,
            current,
          );
          if (adapter.pass === pass) adapter.cancel(selected);
          settleNativeReply();
          return;
        }
        adapter.cancel(selected);
        // Before armed publication the controller deliberately emits no results.
        if (control === selected) {
          control = null;
          nativePublished = false;
          publishNative("reply", selected, {
            status: "cancelled",
            ...(nativeVersion === 2 ? { reason: "cancelled" } : {}),
          });
        }
        discardNativeDiagnostics();
      }
    } catch (error) {
      // A denied duplicate/foreign control must not cancel the reserved pass.
      publishNative("reply", selected, {
        status: "failed",
        reason: nativeReason(error.message),
      });
    }
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
    const thisRegistration = ++registrationGeneration;
    const current = () =>
      !stopped && thisRegistration === registrationGeneration;
    if (nativeMode) {
      const {
        NativeCaptureController,
      } = require("./audio_listener_native_controller.js");
      const adapter = new NativeCaptureController({
        listenerId,
        now: clock,
        nativeVersion,
        onDisarmed: (receipt) => {
          if (receipt.reason === "native_disarm_observer_failed")
            output("diagnostic", receipt.reason);
          if (
            nativeVersion === 2 &&
            current() &&
            nativeController === adapter
          ) {
            if (
              lastNativeDisarm?.generation !== receipt.generation ||
              (!lastNativeDisarm.confirmed && receipt.confirmed)
            )
              lastNativeDisarm = receipt;
            settleNativeReply();
          }
          const pending = pendingQuotaFailure;
          if (!pending || pending.generation !== receipt.generation) return;
          pendingQuotaFailure = null;
          if (!receipt.confirmed)
            output("diagnostic", "native_stop_ack_timeout");
          if (current() && canPublishNative(pending.message))
            publishNative("result", pending.message, {
              status: "failed",
              reason: receipt.confirmed
                ? "native_result_frame_quota_exceeded"
                : "native_stop_ack_timeout",
            });
        },
        // Max ABI: native <UUID> <type> <numeric atoms...> enters the handler;
        // native_control <begin|arm|stop> <UUID> [epoch] routes to the IO helpers.
        // Before begin: native_watchdog_context <UUID> <trace> <correlation> <cause>.
        // These controls never own Live transport. DSP reset ACK proves delivery.
        send: (value) => {
          if (
            nativeController !== adapter ||
            (!["stop", "release"].includes(value.action) &&
              (!current() || !canPublishNative(control)))
          )
            return false;
          if (
            value.action === "begin" &&
            output(
              "native_watchdog_context",
              value.generation,
              control.traceId,
              control.correlationId,
              control.causationId,
            ) === false
          )
            return false;
          if (value.action === "arm") {
            const scope = nativeDiagnostics;
            scope.targetEpoch = value.nativeEpoch;
            scope.resetAt = clock();
            scope.resetBaseElapsed = Math.max(
              0,
              scope.resetAt - adapter.pass.startedAt,
            );
            resetEvent(scope, "queued");
            resetEvent(scope, "started");
          }
          return (
            output(
              "native_control",
              value.action,
              value.generation,
              ...(value.action === "arm"
                ? [value.nativeEpoch]
                : value.action === "configure_v2"
                  ? value.parameters
                  : []),
            ) !== false
          );
        },
        onArmed: (proof) => {
          const operation = pendingArm;
          if (
            !current() ||
            !operation ||
            operation.cancelled ||
            operation.generation !== adapter.pass?.generation ||
            !canPublishNative(operation.message)
          )
            return false;
          return publishNative(
            "reply",
            operation.message,
            {
              status: "armed",
              nativeArm: proof,
            },
            (sent) => {
              operation.published = sent;
              if (sent && control === operation.message && !operation.cancelled)
                nativePublished = true;
              if (nativePublished && nativeDiagnostics) {
                const scope = nativeDiagnostics;
                resetEvent(scope, "completed", "native_arm_acknowledged");
                flushNativeDiagnostics(scope, operation.message, current);
              }
            },
          );
        },
        emit: (event) => nativeEvent(event, current),
        // Real non-audio acquisition events retain their UUID ancestry, buffered
        // until armed is synchronously confirmed. Failed pre-arm events stay
        // local because a failed/cancelled reply releases the typed wire job.
        observe: (event) => observeNative(event, current),
      });
      nativeController = adapter;
      engine = adapter.engine;
    } else {
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
    }
    client = new Client({
      env,
      descriptorPath,
      secretPath,
      instanceId,
      signalKind: "audio",
      schemaVersion:
        nativeVersion === 2 ? "audio-observation/v2" : "audio-observation/v1",
      displayName: "Audio-Listener",
      producerIdPrefix: "ableton-audio-listener",
      listener: {
        version: nativeVersion,
        ...identityPaths,
        nativeStatus,
        capabilities: [
          nativeVersion === 2 ? "audio-listener/v2" : "audio-listener/v1",
        ],
        sampleRate: dsp.sampleRate,
        algorithmVersion: nativeVersion === 2 ? "2.0.0" : VERSION,
        ...(nativeVersion === 2 ? { vectorSize: dsp.vectorSize } : {}),
      },
      onListenerFailure: (reason) => {
        if (!current()) return;
        if (nativeVersion === 2 && nativePublishing > 0) {
          deferredNativeFailure = deferredNativeFailure ?? {
            reason: nativeReason(reason),
            current,
          };
          return;
        }
        fail(reason);
      },
      onWriteDiagnostic: (event) => {
        if (current()) client?.collectWriteDiagnostic(event);
      },
      onStatus: (_sink, state, ...details) => {
        if (!current()) return;
        if (state === "write_diagnostics")
          output("diagnostic", "write_diagnostics", ...details);
        if (state === "disconnected") fail("disconnected");
        if (state === "authenticating" || state === "connected")
          refreshRegistration();
        // A transport connection never certifies timing or advances native readiness.
      },
      onListenerControl: (message) => {
        if (!current()) return;
        refreshRegistration();
        if (!current()) return;
        if (nativeMode) return nativeControl(message, current);
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
    if (nativeMode && on !== 1) fail("dsp_disabled");
    if (!nativeMode && engine && host)
      engine.configureHost({ ...host, ...dsp });
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
    if (!nativeMode && engine && dsp) engine.configureHost({ ...host, ...dsp });
    maybeStart();
  });
  maxApi.addHandler(
    "frame",
    (peakL, peakR, rmsL, rmsR, localSample, centroid, energy) => {
      if (
        nativeMode ||
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
  maxApi.addHandler("native", (packetGeneration, type, ...values) => {
    if (!nativeMode || stopped || !nativeController) return;
    if (nativeVersion === 2 && type === "stopped") {
      nativeController.ingest({ generation: packetGeneration, type, values });
      return;
    }
    refreshRegistration();
    if (!stopped && nativeController && canPublishNative(control))
      nativeController.ingest({ generation: packetGeneration, type, values });
  });
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
  maxApi.addHandler("device-preview", (value) => {
    if (stopped) return;
    // Retain authored selector compatibility, not an unverified host classifier.
    // Authentication/uniqueness stay in ingress; timing readiness stays separate.
    if (value === 0 || value === 1) {
      invalidPreviewReported = false;
      return;
    }
    if (invalidPreviewReported) return;
    invalidPreviewReported = true;
    output("diagnostic", "invalid_device_preview_state_ignored");
  });
  timers.push(
    interval(() => {
      if (stopped) return;
      refreshRegistration();
      output("heartbeat");
      if (nativeMode) nativeController?.tick();
      else engine?.tick();
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
      return nativeStatus;
    },
    get nativeController() {
      return nativeController;
    },
    get nativeDiagnosticBufferSize() {
      return nativeDiagnostics?.events.length ?? 0;
    },
    refreshRegistration,
    stop() {
      if (stopped) return;
      stopped = true;
      registrationGeneration++;
      fail("runtime_stopped");
      if (nativeVersion === 2)
        nativeController?.disarmed(false, "native_stop_unconfirmed");
      timers.forEach(clear);
      client?.stop();
    },
  };
}
module.exports = {
  createRuntime,
  canonicalPaths,
  NATIVE_STATUS,
  NATIVE_DIAGNOSTIC_LIMIT,
};
if (require.main === module) {
  // There is intentionally NO production certificate loader. Host validity,
  // sample offsets AND actual Session source-onset alignment remain unverified.
  // A generic certificate file cannot certify a particular quantized clip launch.
  // Injected certificates are for test/approved runner adapters only. Shipping
  // prepare remains gated; this entrypoint never selects engineering nativeMode.
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
