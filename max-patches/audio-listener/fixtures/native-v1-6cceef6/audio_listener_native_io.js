/* global module, outlet, post, jsarguments, arrayfromargs, inlets:writable, outlets:writable */
/* eslint no-unused-vars: "off" -- Max invokes message handlers by name. */

function NativeMessageIO(mode, send, control, diagnostic) {
  if (mode !== "clock" && mode !== "envelope" && mode !== "spectrum") {
    throw new Error("invalid_native_io_mode");
  }
  this.mode = mode;
  this.send = send;
  this.control = control;
  this.diagnostic = diagnostic;
  this.generation = null;
  this.pre = null;
  this.clock = null;
  this.invalidReported = false;
  this.staleReported = false;
  this.metadata = {};
}

NativeMessageIO.prototype.validNumbers = function (values, length) {
  if (values.length !== length) return false;
  for (var i = 0; i < length; i++) {
    if (
      typeof values[i] !== "number" ||
      !isFinite(values[i]) ||
      Math.abs(values[i]) > 9007199254740991
    )
      return false;
  }
  return true;
};
NativeMessageIO.prototype.fail = function () {
  if (!this.invalidReported) {
    this.invalidReported = true;
    if (this.generation) this.send(["native", this.generation, "ioError", 1]);
    else this.diagnostic("native_io_invalid_command");
  }
  return false;
};
NativeMessageIO.prototype.packet = function (type, values, length) {
  if (!this.generation) return false;
  var metadata =
    [
      "dsp",
      "tempo",
      "fftInfo",
      "abi-clock",
      "abi-envelope",
      "abi-spectrum",
    ].indexOf(type) >= 0;
  if (!metadata && ["clock", "envelope", "spectrum"].indexOf(type) < 0)
    return this.fail();
  if (!this.validNumbers(values, length)) return this.fail();
  if (metadata) {
    var fingerprint = values.join(",");
    if (this.metadata[type] === fingerprint) return false;
    this.metadata[type] = fingerprint;
  }
  this.send(["native", this.generation, type].concat(values));
  return true;
};
NativeMessageIO.prototype.begin = function (generation) {
  if (
    typeof generation !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      generation
    )
  ) {
    return this.fail();
  }
  if (this.mode !== "spectrum") this.control(["poll", 0]);
  this.generation = generation;
  this.invalidReported = false;
  this.staleReported = false;
  this.metadata = {};
  this.pre = null;
  this.clock = null;
  if (this.mode === "envelope") {
    this.control(["cancel", 1]);
    this.control(["epoch", 0]);
  }
  if (this.mode !== "spectrum") this.control(["poll", 1]);
  return true;
};
NativeMessageIO.prototype.arm = function (generation, epoch) {
  if (generation !== this.generation) {
    if (!this.staleReported) this.diagnostic("native_io_stale_control");
    this.staleReported = true;
    return false;
  }
  if (this.mode !== "envelope") return false;
  if (
    typeof epoch !== "number" ||
    epoch < 1 ||
    epoch > 1000000 ||
    Math.floor(epoch) !== epoch
  )
    return this.fail();
  this.control(["cancel", 0]);
  this.control(["epoch", epoch]);
  return true;
};
NativeMessageIO.prototype.stop = function (generation) {
  if (!this.generation) return false;
  if (generation !== this.generation) {
    if (!this.staleReported) this.diagnostic("native_io_stale_control");
    this.staleReported = true;
    return false;
  }
  this.generation = null;
  this.pre = null;
  this.clock = null;
  if (this.mode !== "spectrum") this.control(["poll", 0]);
  this.metadata = {};
  if (this.mode === "envelope") {
    this.control(["cancel", 1]);
    this.control(["epoch", 0]);
  }
  return true;
};
NativeMessageIO.prototype.anchorPre = function (values) {
  if (!this.generation) return false;
  this.pre = null;
  this.clock = null;
  if (!this.validNumbers(values, 4)) return this.fail();
  this.pre = values.slice();
  return true;
};
NativeMessageIO.prototype.anchorClock = function (values) {
  if (!this.generation) return false;
  if (!this.validNumbers(values, 4)) return this.fail();
  this.clock = values.slice(0, 3);
  return this.packet("abi-clock", values.slice(3), 1);
};
NativeMessageIO.prototype.anchorPost = function (values) {
  if (!this.generation) return false;
  var pre = this.pre;
  var clock = this.clock;
  this.pre = null;
  this.clock = null;
  if (!this.validNumbers(values, 4) || !pre || !clock) return this.fail();
  return this.packet("clock", pre.concat(clock, values), 11);
};
NativeMessageIO.prototype.envelope = function (values) {
  if (!this.generation) return false;
  if (!this.validNumbers(values, 16)) return this.fail();
  this.packet("abi-envelope", values.slice(15), 1);
  return this.packet("envelope", values, 16);
};

if (typeof module !== "undefined")
  module.exports = { NativeMessageIO: NativeMessageIO };
var nativeIO = null;
if (typeof outlet === "function") {
  inlets = 1;
  outlets = 2;
  nativeIO = new NativeMessageIO(
    jsarguments[1],
    function (values) {
      outlet(0, values);
    },
    function (values) {
      outlet(1, values);
    },
    function (reason) {
      post(reason + "\n");
    }
  );
}
function begin(generation) {
  return nativeIO.begin(generation);
}
function arm(generation, epoch) {
  return nativeIO.arm(generation, epoch);
}
function stop(generation) {
  return nativeIO.stop(generation);
}
function anchor_pre() {
  return nativeIO.anchorPre(arrayfromargs(arguments));
}
function anchor_clock() {
  return nativeIO.anchorClock(arrayfromargs(arguments));
}
function anchor_post() {
  return nativeIO.anchorPost(arrayfromargs(arguments));
}
function anchor_dsp() {
  return nativeIO.packet("dsp", arrayfromargs(arguments), 3);
}
function tempo(value) {
  return nativeIO.packet("tempo", [value], 1);
}
function fft_info() {
  return nativeIO.packet("fftInfo", arrayfromargs(arguments), 4);
}
function spectrum_frame() {
  return nativeIO.packet("spectrum", arrayfromargs(arguments), 6);
}
function envelope_frame() {
  return nativeIO.envelope(arrayfromargs(arguments));
}
function abi_value(value) {
  return nativeIO.packet("abi-spectrum", [value], 1);
}
function notifydeleted() {
  if (nativeIO && nativeIO.generation) nativeIO.stop(nativeIO.generation);
}
