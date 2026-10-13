/* global AbortController */
const assert = require("node:assert/strict");
const test = require("node:test");
const { Buffer } = require("node:buffer");
const { readFile, readdir, rm } = require("node:fs/promises");
const { resolve, join } = require("node:path");
const { randomUUID } = require("node:crypto");

test("shared AMXD publisher preserves MIDI exports and parameterizes the audio placeholder", async () => {
  const shared = await import("../../scripts/max-device-publisher.mjs");
  const midi = await import("../../scripts/midi-capture-device.mjs");
  assert.equal(shared.decodeAmxd, midi.decodeAmxd);
  assert.equal(shared.encodeAmxd, midi.encodeAmxd);
  const portable = shared.renderPortableDevice(
    {
      patcher: {
        boxes: [{ box: { text: 'js "/project/audio/identity.js"' } }],
      },
    },
    "/project/audio",
    { pathPlaceholder: "__AUDIO_DEVICE__" },
  );
  assert.equal(
    portable.patcher.boxes[0].box.text,
    'js "__AUDIO_DEVICE__/identity.js"',
  );
  assert.equal(
    shared.renderInstalledDevice(portable, "/installed/audio", {
      pathPlaceholder: "__AUDIO_DEVICE__",
    }).patcher.boxes[0].box.text,
    'js "/installed/audio/identity.js"',
  );
  assert.throws(
    () => shared.decodeAmxd(Buffer.from("ptch")),
    /header is truncated/,
  );
  assert.throws(
    () => shared.renderPortableDevice({}, "/source", {}),
    /pathPlaceholder/,
  );
});

test("shared resource publication covers success, guarded failure, cancellation, and staging cleanup", async () => {
  const { publishResources } =
    await import("../../scripts/max-device-publisher.mjs");
  const directory = resolve(
    "max-patches/midi-capture/.test-artifacts",
    randomUUID(),
  );
  const source = resolve("max-patches/midi-capture/midi_capture_identity.js");
  const events = [];
  try {
    const paths = await publishResources({
      destinationDirectory: directory,
      resources: [{ source, fileName: "identity.js" }],
      traceId: "trace",
      correlationId: "correlation",
      causationId: "cause",
      onEvent: (event) => events.push(event),
    });
    assert.deepEqual(paths, [join(directory, "identity.js")]);
    assert.deepEqual(
      events.map((event) => event.stage),
      ["queued", "started", "progress", "completed"],
    );
    assert.ok(
      events.every(
        (event) => event.traceId === "trace" && event.durationMs >= 0,
      ),
    );
    assert.equal(
      await readFile(paths[0], "utf8"),
      await readFile(source, "utf8"),
    );
    await assert.rejects(
      publishResources({
        destinationDirectory: directory,
        resources: [{ source, fileName: "../outside.js" }],
      }),
      /basenames/,
    );
    await assert.rejects(
      publishResources({
        destinationDirectory: directory,
        resources: [
          { source: join(directory, "missing.js"), fileName: "missing.js" },
        ],
        onEvent: (event) => events.push(event),
      }),
      /ENOENT/,
    );
    assert.equal(events.at(-1).stage, "failed");
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(
      publishResources({
        destinationDirectory: directory,
        signal: aborted.signal,
        resources: [{ source, fileName: "cancelled.js" }],
        onEvent: (event) => events.push(event),
      }),
      { name: "AbortError" },
    );
    assert.equal(events.at(-1).stage, "cancelled");
    const partial = new AbortController();
    await assert.rejects(
      publishResources({
        destinationDirectory: directory,
        signal: partial.signal,
        resources: [
          { source, fileName: "first.js" },
          { source, fileName: "second.js" },
        ],
        onEvent: (event) => {
          if (event.stage === "progress") partial.abort();
          events.push(event);
        },
      }),
      { name: "AbortError" },
    );
    assert.equal(events.at(-1).completedCount, 1);
    assert.deepEqual((await readdir(directory)).sort(), [
      "first.js",
      "identity.js",
    ]);
    await publishResources({
      destinationDirectory: directory,
      resources: [{ source, fileName: "observer-safe.js" }],
      onEvent: () => {
        throw new Error("observer failed");
      },
    });
    assert.ok(
      (await readdir(directory)).every((name) => !name.includes(".staged-")),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
