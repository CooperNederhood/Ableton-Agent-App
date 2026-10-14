import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import { nativeRuntimeDocuments } from "./native-runtime-source.mjs";

const require = createRequire(import.meta.url);
const evidence = require("./fixtures/native-stopped-preflight.json");
const markerStart = require("./fixtures/native-marker-start.json");
const {
  nativeHostBinding,
  nativePreflightTiming,
} = require("./audio_listener_native_coordinates.js");
const sha = (value) => createHash("sha256").update(value).digest("hex");

test("actual stopped native IO binds all ABI streams and complete fresh FFT coordinates", () => {
  assert.equal(evidence.schema, "native-stopped-preflight-evidence/v1");
  assert.equal(evidence.calibrationOnly, true);
  assert.equal(evidence.productionReady, false);
  assert.equal(evidence.nativeTiming, "UNVERIFIED");
  assert.deepEqual(evidence.abi, { clock: [1], envelope: [1], spectrum: [1] });
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
  assert.equal(evidence.elapsedMs, 905);
  const { before, spectrum } = evidence.preflight;
  assert.deepEqual(before.dsp, [1, 48000, 64]);
  assert.equal(before.frames.length, 32);
  for (const row of before.frames) {
    assert.equal(row[0], 0);
    assert.equal(row[1], 0);
    assert.equal(row[5], 0);
    assert.equal(row[7], 0);
    assert.equal(row[8], 0);
  }
  assert.deepEqual(nativeHostBinding(before, false), {
    hostOffsetSamples: 1732217428,
    hostBeatZeroSample: null,
    lastCounter: 569280,
  });
  assert.deepEqual(spectrum, [567296, 0, 0, 565248, 567296, 0]);
  const profile = nativePreflightTiming(evidence.preflight, evidence.host);
  assert.equal(profile.hostOffsetSamples, evidence.binding.hostOffsetSamples);
  assert.equal(profile.fftGrid, 596);
  assert.equal(profile.invalidFrames, 0);
  assert.equal(Object.isFrozen(profile.before.frames[0]), true);
  assert.throws(
    () =>
      nativePreflightTiming(evidence.preflight, {
        ...evidence.host,
        sample: evidence.host.sample + 48001,
      }),
    /stale_or_moving_native_preflight/,
  );
  assert.throws(
    () =>
      nativePreflightTiming(evidence.preflight, {
        ...evidence.host,
        playing: true,
      }),
    /stale_or_moving_native_preflight/,
  );
});

test("recorded stopped measurements remain bound to the executed native source bytes", async () => {
  for (const [name, document] of Object.entries(nativeRuntimeDocuments()))
    if (name.endsWith(".gendsp"))
      assert.equal(
        sha(JSON.stringify(document, null, 2)),
        evidence.codeSha256[name],
      );
  assert.equal(
    sha(
      await readFile(new URL("./audio_listener_native_io.js", import.meta.url)),
    ),
    evidence.codeSha256["audio_listener_native_io.js"],
  );
  for (const row of evidence.envelope) {
    assert.equal(row.length, 16);
    assert.equal(row[0], 0);
    assert.equal(row[5], 0);
    assert.equal(row[12], 0);
    assert.equal(row[15], 1);
  }
  assert.deepEqual(evidence.limits, {
    nativeArmObserved: false,
    nativeLaunchObserved: false,
    capturePublished: false,
    cachedEvidenceMayAuthorizeRuntime: false,
    pythonTrackPropertyAvailability: "not_established",
  });
});

test("stopped IO retained control uncertainty and restored graph, automation arm and running transport", () => {
  assert.ok(
    evidence.states.some(
      (state) => state.is_playing === 0 && state.current_song_time === 0,
    ),
  );
  const last = evidence.states.at(-1);
  assert.equal(last.is_playing, 1);
  assert.equal(last.session_automation_record, 1);
  assert.ok(last.current_song_time > 12000);
  assert.equal(
    evidence.observations.trackBackToArranger,
    "not_exposed_by_max_liveapi",
  );
  assert.deepEqual(evidence.cleanup.before, { boxes: 130, lines: 150 });
  assert.deepEqual(evidence.cleanup.after, evidence.cleanup.before);
  assert.equal(evidence.cleanup.exactGraphRestored, true);
  assert.equal(evidence.cleanup.temporaryRootObjectsRemoved, 6);
  assert.equal(evidence.cleanup.transportLeftRunning, true);
  assert.equal(evidence.cleanup.automationArmDuringMeasurement, 0);
  assert.equal(evidence.cleanup.automationArmBefore, 1);
  assert.equal(evidence.cleanup.automationArmRestored, 1);
  assert.equal(evidence.cleanup.audioRecordedOrExported, false);
  assert.equal(evidence.cleanup.deviceSavedOrPromoted, false);
});

test("actual marker-zero start follows the requested region without certifying native onset or Python", () => {
  assert.equal(markerStart.schema, "live-marker-start-commissioning/v1");
  assert.equal(markerStart.method, "Song.start_playing");
  assert.equal(markerStart.productionReady, false);
  assert.equal(markerStart.nativeTiming, "UNVERIFIED");
  assert.ok(markerStart.states[0].currentBeat > 12000);
  assert.ok(
    markerStart.states.some(
      (state) =>
        state.playing === 0 &&
        state.currentBeat === 0 &&
        state.insertMarkerBeat === 0,
    ),
  );
  const running = markerStart.states.find(
    (state) => state.at > markerStart.requestAt && state.playing === 1,
  );
  assert.equal(running.currentBeat, 12.866375);
  assert.ok(running.currentBeat < 100);
  for (const state of markerStart.states) {
    assert.equal(state.insertMarkerBeat, 0);
    assert.equal(state.tempoBpm, 120);
    assert.equal(state.loop, 0);
    assert.equal(state.backToArrangement, 0);
    assert.deepEqual(state.recording, [0, 0, 0]);
    assert.deepEqual(
      state.sessionSources,
      Array.from({ length: 4 }, () => [-1, -1]),
    );
  }
  assert.deepEqual(markerStart.limits, {
    nativeLaunchObserved: false,
    capturePublished: false,
    pythonBackendQualified: false,
    markerChanged: false,
    requestedPositionMayCertifyOnset: false,
  });
  assert.equal(markerStart.states.at(-1).automationArm, 1);
  assert.equal(markerStart.cleanup.temporaryRootObjectsRemoved, 1);
  assert.equal(markerStart.cleanup.exactGraphRestored, true);
  assert.deepEqual(markerStart.cleanup.before, markerStart.cleanup.after);
  assert.equal(markerStart.cleanup.transportLeftRunning, true);
  assert.equal(markerStart.cleanup.automationArmRestored, 1);
  assert.equal(markerStart.cleanup.audioRecordedOrExported, false);
  assert.equal(markerStart.cleanup.deviceSavedOrPromoted, false);
});
