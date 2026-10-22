import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { nativeRuntimeDocuments } from "./native-runtime-source.mjs";
import { historicalNativeSourceURL } from "./native-assembler-archive.mjs";

const require = createRequire(import.meta.url);
const evidence = require("./fixtures/native-runtime-io.json");
const {
  nativeHostBinding,
  nativePreflightTiming,
} = require("./audio_listener_native_coordinates.js");
const sha = (value) => createHash("sha256").update(value).digest("hex");

test("actual native IO executed every compiled ABI and bounded generation-owned stream", () => {
  assert.equal(evidence.schema, "native-runtime-io-evidence/v1");
  assert.match(evidence.generation, /^[0-9a-f-]{36}$/);
  assert.equal(evidence.calibrationOnly, true);
  assert.equal(evidence.productionReady, false);
  assert.equal(evidence.nativeTiming, "UNVERIFIED");
  assert.deepEqual(evidence.abi, { clock: [1], envelope: [1], spectrum: [1] });
  assert.deepEqual(evidence.dsp, [1, 48000, 64]);
  assert.equal(evidence.tempoBpm, 120);
  assert.deepEqual(evidence.fftInformation, [2048, 2048, 2048, 1]);
  for (const type of [
    "dsp",
    "tempo",
    "fftInfo",
    "abi-clock",
    "abi-envelope",
    "abi-spectrum",
  ])
    assert.equal(evidence.counts[type], 1);
  assert.equal(evidence.counts.clock, 84);
  assert.equal(evidence.counts.envelope, 85);
  assert.equal(evidence.counts.spectrum, 85);
  assert.equal(evidence.rejected, 0);
  assert.equal(evidence.elapsedMs, 906);
});

test("actual IO host binding is coherent but playing commissioning data cannot authorize stopped preflight", () => {
  assert.deepEqual(
    nativeHostBinding(
      { dsp: evidence.dsp, frames: evidence.host.frames },
      true,
    ),
    {
      hostOffsetSamples: 1639726676,
      hostBeatZeroSample: 1428465748,
      lastCounter: 3207616,
    },
  );
  for (const row of evidence.envelope) {
    assert.equal(row.length, 16);
    assert.equal(row[0], 0);
    assert.equal(row[5], 0);
    assert.equal(row[12], 0);
    assert.equal(row[15], 1);
  }
  for (const row of evidence.spectrum) {
    assert.equal(row.length, 6);
    assert.equal(row[0], row[4]);
    assert.equal(row[0] - row[3], 2048);
    assert.equal(row[5], 0);
  }
  const last = evidence.host.frames.at(-1);
  assert.throws(
    () =>
      nativePreflightTiming(
        {
          before: { dsp: evidence.dsp, frames: evidence.host.frames },
          fftInformation: evidence.fftInformation,
          spectrum: evidence.spectrum.at(-1),
        },
        {
          playing: true,
          dspOn: true,
          sampleRate: 48000,
          vectorSize: 64,
          tempoBpm: 120,
          sample: last[2],
          beat: last[1],
          flags: 31,
        },
      ),
    /incoherent_native_host_binding/,
  );
});

test("recorded executed native math and Max message helper match the reviewed source bytes", async () => {
  for (const [name, document] of Object.entries(nativeRuntimeDocuments()))
    if (name.endsWith(".gendsp"))
      assert.equal(
        sha(JSON.stringify(document, null, 2)),
        evidence.codeSha256[name],
      );
  assert.equal(
    sha(
      await readFile(historicalNativeSourceURL("audio_listener_native_io.js")),
    ),
    evidence.codeSha256["audio_listener_native_io.js"],
  );
  const changed = evidence.host.frames.map((row) => [...row]);
  changed[1][6]++;
  assert.throws(
    () => nativeHostBinding({ dsp: evidence.dsp, frames: changed }, true),
    /incoherent/,
  );
});

test("actual commissioning retained failed attempts and restored the exact owned baseline without transport control", () => {
  assert.equal(evidence.attempts[1].observedPackets, 0);
  assert.equal(evidence.attempts[2].tempoPackets, 851);
  assert.deepEqual(evidence.cleanup.before, { boxes: 130, lines: 150 });
  assert.deepEqual(evidence.cleanup.after, evidence.cleanup.before);
  assert.equal(evidence.cleanup.temporaryRootObjectsRemoved, 6);
  assert.equal(evidence.cleanup.exactGraphRestored, true);
  assert.equal(evidence.cleanup.transportMutations, 0);
  assert.equal(evidence.cleanup.transportLeftRunning, true);
  assert.equal(evidence.cleanup.audioRecordedOrExported, false);
  assert.equal(evidence.cleanup.deviceSavedOrPromoted, false);
});
