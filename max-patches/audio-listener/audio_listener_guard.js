/* global Task, outlet, post, jsarguments, autowatch:writable, inlets:writable, outlets:writable */
/* eslint no-unused-vars: "off" -- Max-JS invokes the named message/deletion handlers externally. */
// Independent Max scheduler watchdog: a dead Node process cannot leave analysis on.
autowatch = 1;
inlets = 1;
outlets = 3;
var active = false;
var age = 0;
var elapsed = 0;
var nativeGeneration = null;
var nativeContext = null;
var pendingContext = null;
var pendingAge = 0;
var nativeAge = 0;
var nativeElapsed = 0;
var nativeSequence = 0;
var nativeVersion = 1;
if (typeof jsarguments !== "undefined" && jsarguments.length !== 1) {
  nativeVersion = jsarguments.length === 2 &&
    (jsarguments[1] === 1 || jsarguments[1] === 2) ? jsarguments[1] : 0;
}
var nativeTotalTimeoutMs = nativeVersion === 2 ? 60000 : 30000;
var timer = new Task(check, this);
timer.interval = 250;
timer.repeat();

function heartbeat() { age = 0; nativeAge = 0; }
// Diagnostics are application/runtime evidence, never commands to the DSP gate.
function diagnostic() {}
function native_diagnostic() {}
// Generation-owned IO validates configuration; it cannot renew this monitor.
function configure_v2() {}
function validGeneration(value) {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
function safeId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_:./-]{1,128}$/.test(value) ||
      /(?:^|[:/])(?:token|secret|password|bearer|authorization)(?:$|[:_-])|^(?:github_pat_|gh[pousr]_|sk-|AKIA|ASIA)/i.test(value))
    return "[redacted]";
  return value;
}
function nativeEvent(stage, reason, context, duration) {
  var event = {
    type: "native-watchdog-stage", stage: stage, reason: reason,
    elapsedMs: duration, captureOutcome: "unknown"
  };
  if (nativeVersion === 2) {
    event.nativeVersion = 2;
    event.totalTimeoutMs = nativeTotalTimeoutMs;
  }
  if (context) {
    event.generation = context.generation;
    event.traceId = context.traceId;
    event.correlationId = context.correlationId;
    event.causationId = context.causationId;
    event.eventId = context.generation + ":watchdog:" + nativeSequence++;
  }
  post("native-watchdog " + JSON.stringify(event) + "\n");
}
function native_watchdog_context(generation, traceId, correlationId, causationId) {
  if (!validGeneration(generation)) {
    nativeEvent("failed", "invalid_context_generation", null, 0);
    return;
  }
  if (pendingContext)
    nativeEvent("cancelled", "pending_context_replaced", pendingContext, pendingAge);
  pendingContext = {
    generation: generation, traceId: safeId(traceId),
    correlationId: safeId(correlationId), causationId: safeId(causationId)
  };
  pendingAge = 0;
  nativeEvent("queued", "context_received", pendingContext, 0);
}
function finishNative(stage, reason, stopDSP) {
  var generation = nativeGeneration;
  var context = nativeContext;
  var duration = nativeElapsed;
  nativeGeneration = null;
  nativeContext = null;
  nativeAge = 0;
  nativeElapsed = 0;
  if (generation && stopDSP) outlet(2, "stop", generation);
  if (generation) nativeEvent(stage, reason, context, duration);
}
function begin(generation) {
  if (!validGeneration(generation)) {
    nativeEvent("failed", "invalid_begin_generation", null, 0);
    return;
  }
  if (nativeVersion === 0) {
    var rejectedContext = pendingContext && pendingContext.generation === generation ?
      pendingContext : null;
    if (rejectedContext) {
      pendingContext = null;
      pendingAge = 0;
    }
    outlet(2, "stop", generation);
    nativeEvent("failed", "invalid_native_watchdog_version", rejectedContext, 0);
    return;
  }
  if (nativeGeneration === generation) {
    finishNative("failed", "duplicate_begin", true);
    return;
  }
  finishNative("cancelled", "generation_replaced", true);
  if (!pendingContext || pendingContext.generation !== generation) {
    outlet(2, "stop", generation);
    nativeEvent("failed", "native_context_required", null, 0);
    return;
  }
  nativeGeneration = generation;
  nativeContext = pendingContext;
  pendingContext = null;
  pendingAge = 0;
  nativeAge = 0;
  nativeElapsed = 0;
  nativeEvent("started", "native_begin", nativeContext, 0);
}
function arm(generation, epoch) {
  if (generation !== nativeGeneration) return;
  if (typeof epoch !== "number" || epoch < 1 || epoch > 1000000 || epoch !== Math.floor(epoch)) {
    finishNative("failed", "invalid_native_epoch", true);
    return;
  }
  nativeAge = 0;
  nativeEvent("progress", "native_arm_requested", nativeContext, nativeElapsed);
}
function stop(generation) {
  if (generation === nativeGeneration)
    finishNative("completed", "owned_monitor_stop", false);
}
function release(generation) {
  if (generation === nativeGeneration)
    finishNative("cancelled", "owned_monitor_release", true);
}
function analysis(enabled, reset, sampleRate) {
  // Clear FFT buffers and Gen histories before unmuting, also on every termination.
  outlet(0, "mute", 0, 1);
  if (reset) outlet(1, "reset");
  if (sampleRate > 0) outlet(1, "sourceSampleRate", sampleRate);
  active = !!enabled;
  age = 0;
  elapsed = 0;
  if (active) outlet(0, "mute", 0, 0);
}
function check() {
  if (pendingContext) {
    pendingAge += 250;
    if (pendingAge >= 2000) {
      nativeEvent("cancelled", "pending_context_timeout", pendingContext, pendingAge);
      pendingContext = null;
      pendingAge = 0;
    }
  }
  if (nativeGeneration) {
    nativeAge += 250;
    nativeElapsed += 250;
    if (nativeAge >= 2000 || nativeElapsed >= nativeTotalTimeoutMs)
      finishNative("failed",
        nativeAge >= 2000 ? "native_heartbeat_timeout" : "native_total_timeout", true);
  }
  if (!active) return;
  age += 250;
  elapsed += 250;
  if (age >= 2000 || elapsed >= 300000) analysis(0, 1, 0);
}
function notifydeleted() {
  finishNative("cancelled", "device_deleted", true);
  if (pendingContext) nativeEvent("cancelled", "device_deleted", pendingContext, pendingAge);
  pendingContext = null;
  analysis(0, 1, 0);
  timer.cancel();
}
