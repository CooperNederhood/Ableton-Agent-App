/* global module, outlet, post, jsarguments, arrayfromargs, inlets:writable, outlets:writable */
/* eslint no-unused-vars: "off" -- Max invokes message handlers by name. */

function NativeMessageIO(mode, send, control, diagnostic, nativeVersion) {
  if (mode !== "clock" && mode !== "envelope" && mode !== "spectrum") {
    throw new Error("invalid_native_io_mode");
  }
  this.mode = mode;
  if (nativeVersion === undefined) nativeVersion = 1;
  if (nativeVersion !== 1 && nativeVersion !== 2)
    throw new Error("invalid_native_version");
  this.nativeVersion = nativeVersion;
  this.configuration = null;
  this.armed = false;
  this.stopping = false;
  this.nativeEpoch = null;
  this.sealedEpoch = null;
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
  if (type === "config" && this.nativeVersion !== 2) return this.fail();
  var metadata =
    [
      "dsp",
      "tempo",
      "fftInfo",
      "abi-clock",
      "abi-envelope",
      "abi-spectrum",
      "config",
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
  if (this.nativeVersion === 2 && this.generation) {
    if (generation !== this.generation && !this.staleReported)
      this.diagnostic("native_io_stale_control");
    if (generation !== this.generation) this.staleReported = true;
    return false;
  }
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
  this.configuration = null;
  this.armed = false;
  this.stopping = false;
  this.nativeEpoch = null;
  this.sealedEpoch = null;
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
  if (this.nativeVersion === 2 && (!this.configuration || this.armed))
    return this.fail();
  if (
    typeof epoch !== "number" ||
    epoch < 1 ||
    epoch > 1000000 ||
    Math.floor(epoch) !== epoch
  )
    return this.fail();
  this.nativeEpoch = epoch;
  this.control(["cancel", 0]);
  this.control(["epoch", epoch]);
  this.armed = true;
  return true;
};
NativeMessageIO.prototype.configureV2 = function (generation, values) {
  if (generation !== this.generation || !this.generation) {
    if (!this.staleReported) this.diagnostic("native_io_stale_control");
    this.staleReported = true;
    return false;
  }
  if (this.mode !== "envelope") return false;
  if (
    this.nativeVersion !== 2 ||
    this.armed ||
    this.configuration ||
    !this.validNumbers(values, 5) ||
    values[0] < values[1] ||
    values[0] > 1440000 ||
    Math.floor(values[0]) !== values[0] ||
    [4410, 4800].indexOf(values[1]) < 0 ||
    values[0] > values[1] * 300 ||
    values[2] < 20 ||
    values[2] > 999 ||
    values[3] < 0 ||
    values[3] >= 1 ||
    values[4] < 1 ||
    values[4] > 1024 ||
    Math.floor(values[4]) !== values[4] ||
    (values[4] & (values[4] - 1)) !== 0
  )
    return this.fail();
  var names = [
    "totalSamples",
    "hopSamples",
    "tempoBpm",
    "startBeatFraction",
    "captureVector",
  ];
  this.configuration = values.slice();
  for (var i = 0; i < names.length; i++) this.control([names[i], values[i]]);
  return true;
};
NativeMessageIO.prototype.configurationFrame = function (values) {
  if (!this.generation) return false;
  if (
    this.nativeVersion !== 2 ||
    this.mode !== "envelope" ||
    !this.validNumbers(values, 7)
  )
    return this.fail();
  if (
    this.configuration &&
    values[0] === this.nativeEpoch &&
    values[6] === this.nativeEpoch
  ) {
    var matches = true;
    for (var i = 0; i < 5; i++)
      if (values[i + 1] !== this.configuration[i]) matches = false;
    if (matches) this.sealedEpoch = this.nativeEpoch;
  }
  return this.packet("config", values, 7);
};
NativeMessageIO.prototype.release = function (generation) {
  if (
    this.nativeVersion !== 2 ||
    generation !== this.generation ||
    !this.stopping
  )
    return false;
  this.generation = null;
  this.configuration = null;
  this.armed = false;
  this.stopping = false;
  this.nativeEpoch = null;
  this.sealedEpoch = null;
  this.metadata = {};
  this.pre = this.clock = null;
  this.control(["poll", 0]);
  this.diagnostic("native_io_disarm_unconfirmed");
  return true;
};
NativeMessageIO.prototype.stop = function (generation) {
  if (!this.generation) return false;
  if (generation !== this.generation) {
    if (!this.staleReported) this.diagnostic("native_io_stale_control");
    this.staleReported = true;
    return false;
  }
  if (this.nativeVersion === 2 && this.mode === "envelope") {
    if (this.stopping) return false;
    this.stopping = true;
    this.control(["cancel", 1]);
    this.control(["epoch", 0]);
    return true;
  }
  this.generation = null;
  this.pre = null;
  this.clock = null;
  this.configuration = null;
  this.armed = false;
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
  if (this.stopping) {
    if (
      values[0] === 0 &&
      values[5] === 0 &&
      values[15] === 2 &&
      (this.nativeEpoch === null || this.sealedEpoch === this.nativeEpoch)
    ) {
      var generation = this.generation;
      this.generation = null;
      this.configuration = null;
      this.armed = false;
      this.stopping = false;
      this.nativeEpoch = this.sealedEpoch = null;
      this.pre = this.clock = null;
      this.metadata = {};
      this.control(["poll", 0]);
      this.send(["native", generation, "stopped", 0, 0, 2]);
      return true;
    }
    return false;
  }
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
    },
    jsarguments.length > 2 ? jsarguments[2] : 1
  );
}
function begin(generation) {
  return nativeIO.begin(generation);
}
function arm(generation, epoch) {
  return nativeIO.arm(generation, epoch);
}
function configure_v2(generation) {
  return nativeIO.configureV2(generation, arrayfromargs(arguments).slice(1));
}
function configuration_frame() {
  return nativeIO.configurationFrame(arrayfromargs(arguments));
}
function stop(generation) {
  return nativeIO.stop(generation);
}
function release(generation) {
  return nativeIO.release(generation);
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
