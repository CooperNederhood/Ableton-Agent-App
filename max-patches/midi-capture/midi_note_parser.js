autowatch = 1;
inlets = 1;
outlets = 1;

function MidiNoteParser() {
  this.runningStatus = null;
  this.expectedDataBytes = 0;
  this.data = [];
  this.sequence = 0;
}

MidiNoteParser.prototype.reset = function () {
  this.runningStatus = null;
  this.expectedDataBytes = 0;
  this.data = [];
  this.sequence = 0;
};

MidiNoteParser.prototype.consume = function (value) {
  var byte = Number(value);
  if (!isFinite(byte) || byte < 0 || byte > 255) {
    return null;
  }
  byte = Math.floor(byte);

  // Realtime messages may appear between channel-message data bytes.
  if (byte >= 248) {
    return null;
  }

  if (byte >= 128) {
    if (byte >= 240) {
      this.reset();
      return null;
    }

    this.runningStatus = byte;
    this.expectedDataBytes =
      (byte & 240) === 192 || (byte & 240) === 208 ? 1 : 2;
    this.data = [];
    return null;
  }

  if (this.runningStatus === null) {
    return null;
  }

  this.data.push(byte);
  if (this.data.length < this.expectedDataBytes) {
    return null;
  }

  var status = this.runningStatus;
  var data = this.data.slice(0, this.expectedDataBytes);
  this.data = [];

  var type = status & 240;
  if (type !== 128 && type !== 144) {
    return null;
  }

  var velocity = data[1];
  var isNoteOn = type === 144 && velocity > 0;
  var event = [
    (status & 15) + 1,
    data[0],
    velocity,
    isNoteOn ? 1 : 0,
    this.sequence,
  ];
  this.sequence += 1;
  return event;
};

var parser = new MidiNoteParser();

function msg_int(value) {
  var event = parser.consume(value);
  if (event !== null) {
    outlet(0, event);
  }
}

function list() {
  var values = arrayfromargs(arguments);
  for (var i = 0; i < values.length; i += 1) {
    msg_int(values[i]);
  }
}

function clear() {
  parser.reset();
}

if (typeof module !== "undefined") {
  module.exports = { MidiNoteParser: MidiNoteParser };
}
