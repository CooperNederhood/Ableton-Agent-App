const assert = require("node:assert/strict");
const { Buffer } = require("node:buffer");
const test = require("node:test");

async function publisher() {
  return import("../../scripts/midi-capture-device.mjs");
}

function amxd(document) {
  const prefix = Buffer.from("ampf0000ptch", "ascii");
  const json = Buffer.from(`${JSON.stringify(document)}\0`, "utf8");
  const size = Buffer.alloc(4);
  size.writeUInt32LE(json.length);
  return Buffer.concat([prefix, size, json]);
}

test("round-trips an uncompressed AMXD patch chunk", async () => {
  const { decodeAmxd, encodeAmxd } = await publisher();
  const raw = amxd({ patcher: { boxes: [] } });
  const decoded = decodeAmxd(raw);
  const encoded = encodeAmxd(decoded, decoded.document);
  assert.deepEqual(decodeAmxd(encoded).document, decoded.document);
});

test("normalizes a validated patch and strips the MCP bridge", async () => {
  const { PATH_PLACEHOLDER, normalizeValidatedDevice } = await publisher();
  const directory =
    "/Users/test/Music/Ableton/User Library/Presets/MIDI Effects/Max MIDI Effect";
  const normalized = normalizeValidatedDevice(
    {
      patcher: {
        boxes: [
          { box: { id: "bridge", text: "mcp_bridge" } },
          {
            box: {
              id: "identity",
              text: `js "${directory}/midi_capture_identity.js"`,
            },
          },
        ],
        lines: [
          {
            patchline: {
              source: ["bridge", 0],
              destination: ["identity", 0],
            },
          },
        ],
        dependency_cache: [
          {
            name: "mcp_bridge.maxpat",
            bootpath: "/Max 8/Packages/mcp_bridge/patchers",
          },
          { name: "transport.mxo", type: "iLaX" },
        ],
      },
    },
    directory,
  );
  assert.equal(normalized.patcher.boxes.length, 1);
  assert.equal(normalized.patcher.lines.length, 0);
  assert.deepEqual(normalized.patcher.dependency_cache, [
    { name: "transport.mxo", type: "iLaX" },
  ]);
  assert.equal(
    normalized.patcher.boxes[0].box.text,
    `js "${PATH_PLACEHOLDER}/midi_capture_identity.js"`,
  );
});

test("renders the install directory into every placeholder", async () => {
  const { PATH_PLACEHOLDER, renderInstalledDevice } = await publisher();
  const destination = "/Ableton/User Library/Max MIDI Effect";
  const rendered = renderInstalledDevice(
    {
      patcher: {
        boxes: [
          {
            box: {
              text: `node.script "${PATH_PLACEHOLDER}/midi_capture_writer.js"`,
            },
          },
        ],
      },
    },
    destination,
  );
  assert.equal(
    rendered.patcher.boxes[0].box.text,
    `node.script "${destination}/midi_capture_writer.js"`,
  );
});
