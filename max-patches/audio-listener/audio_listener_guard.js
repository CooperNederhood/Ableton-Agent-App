/* global Task, outlet, autowatch:writable, inlets:writable, outlets:writable */
/* eslint no-unused-vars: "off" -- Max-JS invokes the named message/deletion handlers externally. */
// Independent Max scheduler watchdog: a dead Node process cannot leave analysis on.
autowatch = 1;
inlets = 1;
outlets = 3;
var active = false;
var age = 0;
var elapsed = 0;
var timer = new Task(check, this);
timer.interval = 250;
timer.repeat();

function heartbeat() { age = 0; }
// Diagnostics are application/runtime evidence, never commands to the DSP gate.
function diagnostic() {}
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
  if (!active) return;
  age += 250;
  elapsed += 250;
  if (age >= 2000 || elapsed >= 300000) analysis(0, 1, 0);
}
function notifydeleted() {
  analysis(0, 1, 0);
  timer.cancel();
}
