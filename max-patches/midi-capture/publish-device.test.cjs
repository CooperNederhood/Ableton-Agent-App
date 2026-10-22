const assert = require("node:assert/strict");
const { Buffer } = require("node:buffer");
const test = require("node:test");
const {
  copyFile,
  mkdir,
  readFile,
  rm,
  writeFile,
} = require("node:fs/promises");
const { resolve, join } = require("node:path");
const { randomUUID } = require("node:crypto");

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

test("installs one shared transport beside the unchanged MIDI wrapper", async () => {
  const {
    producerCompanionSource,
    copySharedProducerCompanions,
    SHARED_PRODUCER_COMPANION,
    SHARED_PRODUCER_IDENTITY,
    writeProducerDiscoveryConfiguration,
  } = await import("../../scripts/m4l-producer-companions.mjs");
  const destination = resolve(
    "max-patches/midi-capture/.test-artifacts",
    randomUUID(),
  );
  try {
    await mkdir(destination, { recursive: true });
    await copySharedProducerCompanions(destination);
    assert.equal(
      await readFile(join(destination, SHARED_PRODUCER_IDENTITY), "utf8"),
      await readFile(
        resolve("max-patches/midi-capture/midi_capture_identity.js"),
        "utf8",
      ),
    );
    await copyFile(
      resolve("max-patches/midi-capture/agent_signal_client.js"),
      join(destination, "agent_signal_client.js"),
    );
    await writeFile(
      join(destination, "package.json"),
      JSON.stringify({ type: "commonjs" }),
    );
    assert.equal(
      await readFile(join(destination, SHARED_PRODUCER_COMPANION), "utf8"),
      await readFile(
        producerCompanionSource(SHARED_PRODUCER_COMPANION, "unused"),
        "utf8",
      ),
    );
    const installed = require(join(destination, "agent_signal_client.js"));
    assert.equal(typeof installed.installedDiscoveryPaths, "function");
    assert.equal(installed.installedDiscoveryPaths(), null);
    const canonical = require("./agent_signal_client.js");
    assert.equal(
      installed.producerIdForCanonicalPath("live_set tracks 0 devices 0"),
      canonical.producerIdForCanonicalPath("live_set tracks 0 devices 0"),
    );
    const client = new installed.AgentSignalClient({ instanceId: "installed" });
    assert.equal(client.schemaVersion, "midi-sample/v1");
    assert.equal(client.signalKind, "midi");
    const storage = {
      signalIngressDescriptorPath: join(
        destination,
        "profile",
        "state",
        "signal-ingress.json",
      ),
      signalIngressSecretPath: join(
        destination,
        "profile",
        "credentials",
        "signal-ingress.secret",
      ),
    };
    await writeProducerDiscoveryConfiguration(destination, storage);
    assert.deepEqual(installed.installedDiscoveryPaths(), {
      version: 1,
      descriptorPath: storage.signalIngressDescriptorPath,
      secretPath: storage.signalIngressSecretPath,
    });
    const canonicalDiscovery = new installed.AgentSignalClient({
      instanceId: "canonical",
    });
    assert.equal(
      canonicalDiscovery.descriptorPath,
      storage.signalIngressDescriptorPath,
    );
    assert.equal(
      canonicalDiscovery.secretPath,
      storage.signalIngressSecretPath,
    );
    assert.equal(canonicalDiscovery.legacyDiscovery, false);
    await assert.rejects(
      writeProducerDiscoveryConfiguration(destination, {
        signalIngressDescriptorPath: "relative.json",
        signalIngressSecretPath: "relative.secret",
      }),
      /shared storage resolver/,
    );
  } finally {
    await rm(destination, { recursive: true, force: true });
  }
});
