const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const identitySource = fs.readFileSync(
  path.join(__dirname, "midi_capture_identity.js"),
  "utf8",
);

function api({ id, name, path: apiPath, type }) {
  return {
    id,
    get(property) {
      assert.equal(property, "name");
      return name;
    },
    path: apiPath,
    type,
    unquotedpath: apiPath,
  };
}

function runIdentity(apis) {
  const output = [];
  const context = {
    Array,
    LiveAPI: function LiveAPI(apiPath) {
      const value = apis.get(apiPath);
      return value || api({ id: 0, name: "", path: "", type: "" });
    },
    Task: function Task(callback, target, ...args) {
      return {
        cancel() {},
        schedule() {
          callback.apply(target, args);
        },
      };
    },
    autowatch: 0,
    inlets: 0,
    isFinite,
    JSON,
    Number,
    outlet: (...items) => output.push(items),
    outlets: 0,
    post() {},
    String,
  };
  vm.runInNewContext(identitySource, context);
  context.bang();
  return output;
}

test("emits atomic identity for a rack-contained device", () => {
  const apis = new Map([
    [
      "live_set this_device",
      api({
        id: 29,
        name: ["Midi-Capture"],
        path: "live_set tracks 2 devices 1 chains 0 devices 3",
        type: "MaxDevice",
      }),
    ],
    [
      "live_set this_device canonical_parent",
      api({
        id: 28,
        name: "Chain",
        path: "live_set tracks 2 devices 1 chains 0",
        type: "Chain",
      }),
    ],
    [
      "live_set this_device canonical_parent canonical_parent",
      api({
        id: 27,
        name: "MIDI Rack",
        path: "live_set tracks 2 devices 1",
        type: "RackDevice",
      }),
    ],
    [
      "live_set this_device canonical_parent canonical_parent canonical_parent",
      api({
        id: 17,
        name: ["The", "Greatest", "Piano"],
        path: "live_set tracks 2",
        type: "Track",
      }),
    ],
  ]);

  const output = runIdentity(apis);
  assert.equal(output.length, 1);
  assert.equal(output[0][0], 0);
  assert.equal(output[0][1], "identity");
  assert.deepEqual(JSON.parse(output[0][2]), {
    canonicalPath: "live_set tracks 2 devices 1 chains 0 devices 3",
    track: {
      id: "17",
      index: 2,
      name: "The Greatest Piano",
    },
    device: {
      id: "29",
      name: "Midi-Capture",
    },
  });
});

test("retries initial id zero responses before emitting identity", () => {
  let deviceAttempts = 0;
  const device = api({
    id: 29,
    name: "Midi-Capture",
    path: "live_set tracks 0 devices 0",
    type: "MaxDevice",
  });
  const apis = new Map([
    [
      "live_set this_device",
      {
        get id() {
          deviceAttempts += 1;
          return deviceAttempts === 1 ? 0 : device.id;
        },
        get(property) {
          return device.get(property);
        },
        path: device.path,
        type: device.type,
        unquotedpath: device.unquotedpath,
      },
    ],
    [
      "live_set this_device canonical_parent",
      api({
        id: 17,
        name: "Track",
        path: "live_set tracks 0",
        type: "Track",
      }),
    ],
  ]);

  const output = runIdentity(apis);
  assert.equal(deviceAttempts, 2);
  assert.equal(output.length, 1);
  assert.equal(JSON.parse(output[0][2]).track.index, 0);
});
