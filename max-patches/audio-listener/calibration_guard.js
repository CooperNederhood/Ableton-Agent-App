/* global Task, outlet, post, autowatch:writable, inlets:writable, outlets:writable */
/* eslint no-unused-vars: "off" -- Named handlers are invoked by Max, not Node. */
autowatch = 1;
inlets = 1;
outlets = 5;
var active = false;
var configured = false;
var age = 0;
var elapsed = 0;
var serial = 1;
var timer = new Task(check, this);
var fixturePattern =
  /commission-(silence|quarter-sine|anti-phase-quarter-sine)\.wav$/;
timer.interval = 250;
timer.repeat();
function heartbeat() {
  age = 0;
}
function notice(value) {
  if (typeof value === "string" && /^[a-z_]{1,80}$/.test(value))
    post("Audio commissioning: " + value + "\n");
}
function configure(sr, vector) {
  configured =
    sr === 48000 &&
    vector >= 1 &&
    vector <= 4096 &&
    Math.floor(vector) === vector;
  if (!configured) {
    stop(serial + 1, "invalid_dsp");
    return;
  }
  outlet(1, "sourceSampleRate", sr);
  outlet(2, "vectorSize", vector);
}
function load(path) {
  if (
    active ||
    typeof path !== "string" ||
    path.length > 4096 ||
    !fixturePattern.test(path)
  )
    return;
  outlet(3, "replace", path);
}
function begin(epoch, frames) {
  if (
    !configured ||
    frames !== 96000 ||
    typeof epoch !== "number" ||
    !isFinite(epoch) ||
    epoch <= serial ||
    epoch > 999999 ||
    Math.floor(epoch) !== epoch
  ) {
    stop(serial + 1, "invalid_begin");
    return;
  }
  outlet(0, "mute", 0, 1);
  outlet(1, "reset");
  outlet(2, "enabled", 0);
  outlet(2, "fixtureFrames", frames);
  outlet(2, "epoch", epoch);
  serial = epoch;
  outlet(2, "enabled", 1);
  active = true;
  age = 0;
  elapsed = 0;
  outlet(0, "mute", 0, 0);
  outlet(4, "guard-event", "started", serial);
}
function stop(epoch, reason) {
  outlet(0, "mute", 0, 1);
  outlet(1, "reset");
  outlet(2, "enabled", 0);
  if (
    typeof epoch !== "number" ||
    !isFinite(epoch) ||
    epoch < 1 ||
    epoch > 1000000 ||
    Math.floor(epoch) !== epoch
  )
    epoch = serial + 1;
  serial = Math.min(1000000, Math.max(serial + 1, epoch));
  outlet(2, "epoch", serial);
  outlet(3, "clear");
  active = false;
  notice(String(reason || "stopped"));
  outlet(4, "guard-event", String(reason || "stopped"), serial);
}
function check() {
  if (!active) return;
  age += 250;
  elapsed += 250;
  if (age >= 2000 || elapsed >= 10000) stop(serial + 1, "watchdog");
}
function notifydeleted() {
  stop(serial + 1, "deleted");
  timer.cancel();
}
