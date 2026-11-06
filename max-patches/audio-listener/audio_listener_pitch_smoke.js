/* eslint-disable-next-line no-unused-vars -- Max owns the writable inlet/outlet globals. */
/* global inlets:writable, outlets:writable, outlet, arrayfromargs, inlet, Task */
/* eslint no-unused-vars: ["error", { "varsIgnorePattern": "^(inlets|outlets|begin|stop|guardstop|msg_float|msg_int|list|notifydeleted)$" }] */
inlets = 3;
outlets = 1;

var owner = null;
var pairs = [null, null];
var counts = [0, 0];
var pending = [false, false];
var timer = new Task(publish, this);
var beganAt = 0;

function begin(generation, epoch) {
  if (owner !== null) throw new Error("pitch_gate_still_owned");
  if (
    typeof generation !== "string" ||
    !/^[0-9a-f-]{36}$/i.test(generation) ||
    typeof epoch !== "number" ||
    epoch < 1 ||
    epoch > 1000000 ||
    epoch % 1 !== 0
  )
    throw new Error("pitch_invalid_owner");
  owner = [generation, epoch];
  pairs = [null, null];
  counts = [0, 0];
  pending = [false, false];
  beganAt = Date.now();
  var left = this.patcher.getnamed("pitch-left");
  var right = this.patcher.getnamed("pitch-right");
  var announcement = owner.concat([
    "started",
    left ? String(left.maxclass).slice(0, 128) : "missing",
    right ? String(right.maxclass).slice(0, 128) : "missing",
  ]);
  outlet(0, announcement);
  timer.interval = 100;
  timer.repeat();
}
function release(kind) {
  timer.cancel();
  var previous = owner;
  owner = null;
  pairs = [null, null];
  pending = [false, false];
  outlet(0, previous.concat([kind]));
}
function stop(generation, epoch) {
  if (!owner || owner[0] !== generation || owner[1] !== epoch)
    throw new Error("pitch_gate_owner_mismatch");
  release("stopped");
}
function guardstop(generation) {
  if (!owner || owner[0] !== generation) return;
  release("watchdog-stopped");
}
function msg_float(value) {
  list(value);
}
function msg_int(value) {
  list(value);
}
function list() {
  if (!owner || inlet < 1 || inlet > 2) return;
  var args = arrayfromargs(arguments);
  if (args.length !== 2) {
    outlet(0, owner.concat(["invalid-width"]));
    throw new Error("pitch_unexpected_pair_width");
  }
  // Warm-up only, not a frame/support/voicing assertion.
  if (Date.now() - beganAt < 100) return;
  var channel = inlet - 1;
  // Stock select preserves the normal pitch/confidence order. Keep the whole
  // callback list; never combine unrelated pitch and confidence deliveries.
  pairs[channel] = args;
  pending[channel] = true;
}
function publish() {
  if (!owner) return;
  for (var channel = 0; channel < 2; channel++) {
    if (!pending[channel]) continue;
    if (counts[channel] >= 400) {
      timer.cancel();
      outlet(0, owner.concat(["delivery-limit"]));
      throw new Error("pitch_delivery_limit");
    }
    counts[channel]++;
    pending[channel] = false;
    var header = ["value", channel, counts[channel]];
    var packet = owner.concat(header, pairs[channel]);
    outlet(0, packet);
  }
}
function notifydeleted() {
  timer.cancel();
  owner = null;
  pairs = [null, null];
  pending = [false, false];
}
