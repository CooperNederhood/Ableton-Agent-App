/* eslint-disable-next-line no-unused-vars -- Max owns the writable inlet/outlet globals. */
/* global inlets:writable, outlets:writable, outlet, arrayfromargs, inlet, Task */
/* eslint no-unused-vars: ["error", { "varsIgnorePattern": "^(inlets|outlets|begin|stop|guardstop|msg_float|msg_int|list|notifydeleted)$" }] */
inlets = 3;
outlets = 1;

var owner = null;
var values = [null, null];
var counts = [0, 0];
var pending = [false, false];
var timer = new Task(publish, this);
var beganAt = 0;

function begin(generation, epoch) {
  if (owner !== null) throw new Error("flatness_gate_still_owned");
  if (
    typeof generation !== "string" ||
    !/^[0-9a-f-]{36}$/i.test(generation) ||
    typeof epoch !== "number" ||
    epoch < 1 ||
    epoch > 1000000 ||
    epoch % 1 !== 0
  )
    throw new Error("flatness_invalid_owner");
  owner = [generation, epoch];
  values = [null, null];
  counts = [0, 0];
  pending = [false, false];
  beganAt = Date.now();
  var left = this.patcher.getnamed("shape-left");
  var right = this.patcher.getnamed("shape-right");
  outlet(
    0,
    owner.concat([
      "started",
      left ? String(left.maxclass).slice(0, 128) : "missing",
      right ? String(right.maxclass).slice(0, 128) : "missing",
    ])
  );
  timer.interval = 100;
  timer.repeat();
}

function stop(generation, epoch) {
  if (!owner || owner[0] !== generation || owner[1] !== epoch)
    throw new Error("flatness_gate_owner_mismatch");
  timer.cancel();
  var previous = owner;
  owner = null;
  values = [null, null];
  pending = [false, false];
  outlet(0, previous.concat(["stopped"]));
}

function guardstop(generation) {
  if (!owner || owner[0] !== generation) return;
  timer.cancel();
  var previous = owner;
  owner = null;
  values = [null, null];
  pending = [false, false];
  outlet(0, previous.concat(["watchdog-stopped"]));
}

function accept(value) {
  if (!owner || inlet < 1 || inlet > 2) return;
  // A warm-up interval avoids reporting the initial zero descriptor. It is not
  // an FFT phase witness, sample-support claim, or a silence validity gate.
  if (Date.now() - beganAt < 100) return;
  var channel = inlet - 1;
  values[channel] = value;
  pending[channel] = true;
}
function msg_float(value) {
  list(value);
}
function msg_int(value) {
  list(value);
}
function list() {
  var args = arrayfromargs(arguments);
  if (!owner || inlet < 1 || inlet > 2) return;
  if (args.length !== 3) {
    outlet(0, owner.concat(["invalid-width"]));
    throw new Error("spectralshape_unexpected_descriptor_width");
  }
  // FluCoMa emits spread, rolloff, flatness regardless of selection spelling.
  accept(args);
}
function publish() {
  if (!owner) return;
  for (var channel = 0; channel < 2; channel++) {
    if (!pending[channel]) continue;
    if (counts[channel] >= 400) {
      timer.cancel();
      outlet(0, owner.concat(["delivery-limit"]));
      throw new Error("flatness_delivery_limit");
    }
    counts[channel]++;
    pending[channel] = false;
    outlet(
      0,
      owner.concat(["value", channel, counts[channel]], values[channel])
    );
  }
}
function notifydeleted() {
  timer.cancel();
  owner = null;
  values = [null, null];
  pending = [false, false];
}
