import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import {
  assertNativeCaptureObservation,
  nativeCaptureProofSchema,
  nativeLaunchCoordinates,
  NATIVE_LISTENER_SCOPE,
} from "../../packages/protocol/src/native-listening-schemas.ts";
import { audioObservationSchema } from "../../packages/protocol/src/audio-observation-schemas.ts";
import { nativeRuntimeDocuments } from "./native-runtime-source.mjs";

const require = createRequire(import.meta.url);
const evidence = require("./fixtures/native-controller-capture.json");
const revisions = require("./fixtures/native-acquisition-recovery.json");
const { terminal } = evidence.report;
const clone = (value) => JSON.parse(JSON.stringify(value));
const sha = (value) => createHash("sha256").update(value).digest("hex");

test("actual controller capture independently satisfies the entire App proof boundary", () => {
  assert.equal(evidence.schema, "native-controller-capture-evidence/v1");
  assert.equal(evidence.report.outcome, "complete");
  const proof = nativeCaptureProofSchema.parse(terminal.nativeCapture);
  const observation = audioObservationSchema.parse(terminal.observation);
  assertNativeCaptureObservation(proof, observation);
  assert.equal(proof.armed.scope, NATIVE_LISTENER_SCOPE);
  assert.equal(proof.armed.before.frames.length, 32);
  assert.equal(proof.after.frames.length, 32);
  assert.equal(proof.spectralWindows.length, 20);
  assert.equal(observation.samples.length, 20);
  assert.equal(observation.complete, true);
  assert.equal(observation.startBeat, 0);
  assert.equal(observation.endBeat, 4);
  assert.equal(observation.endSample - observation.startSample, 96000);
  assert.deepEqual(nativeLaunchCoordinates(proof.armed, proof.launched), {
    startSample: 1957660756,
    originCounter: 381440,
    hostOffsetSamples: 1957279316,
  });
  assert.deepEqual(observation.summaries.peak, [0.5, 0.5]);
  assert.deepEqual(
    observation.summaries.rmsDbfs,
    [-12.159430090285273, -12.159430090285273],
  );
  assert.equal(observation.summaries.centroidHz, 453.29712384376825);
  assert.equal(evidence.report.elapsedMs, 2825);
  assert.equal(
    evidence.independentAppValidation.applicationCaptureProofAccepted,
    true,
  );
});

test("the recorded complete result cannot hide missing coverage, torn postchecks or altered FFT", () => {
  const validate = (proof, observation) =>
    assertNativeCaptureObservation(
      nativeCaptureProofSchema.parse(proof),
      audioObservationSchema.parse(observation),
    );
  const missingWindow = clone(terminal.observation);
  missingWindow.samples.splice(5, 1);
  assert.throws(() => validate(terminal.nativeCapture, missingWindow));
  const changedOrigin = clone(terminal.observation);
  changedOrigin.startSample += 64;
  assert.throws(() => validate(terminal.nativeCapture, changedOrigin));
  const tornPostcheck = clone(terminal.nativeCapture);
  tornPostcheck.after.frames[0][9] += 64;
  assert.throws(() => validate(tornPostcheck, terminal.observation));
  const changedSpectrum = clone(terminal.nativeCapture);
  changedSpectrum.spectralWindows[0][2] += 100;
  assert.throws(() => validate(changedSpectrum, terminal.observation));
  assert.throws(() => nativeCaptureProofSchema.parse(undefined));
});

test("actual capture lifecycle preserves trace ancestry and completion after postcheck", () => {
  const { command, events, observed } = evidence.report;
  const preflight = observed.filter(
    (event) => event.type === "native-preflight-stage",
  );
  const capture = events.filter(
    (event) => event.type === "native-capture-stage",
  );
  assert.deepEqual(
    capture.map((event) => event.stage),
    [
      "queued",
      "started",
      "progress",
      "progress",
      "progress",
      "progress",
      "progress",
      "completed",
    ],
  );
  const ids = new Set([command.causationId]);
  for (const stream of [preflight, capture]) {
    let previousElapsed = 0;
    for (const event of stream) {
      assert.equal(event.traceId, command.traceId);
      assert.equal(event.correlationId, command.correlationId);
      assert.equal(ids.has(event.causationId), true);
      assert.equal(ids.has(event.eventId), false);
      assert.ok(event.elapsedMs >= previousElapsed);
      previousElapsed = event.elapsedMs;
      ids.add(event.eventId);
    }
  }
  assert.equal(capture[2].reason, "native_arm_acknowledged");
  assert.equal(capture[3].reason, "native_launch_observed");
  assert.equal(capture.at(-2).reason, "native_host_postcheck_complete");
  assert.equal(capture.at(-1).reason, "range_complete");
  assert.equal(events.at(-1).status, "complete");
});

test("recorded native math and graphs remain pinned; acquisition revisions have separate explicit provenance", async () => {
  const directory = "/".padEnd(evidence.resourceDirectoryCharacters, "n");
  for (const [name, document] of Object.entries(
    nativeRuntimeDocuments({
      resourceDirectory: directory,
    }),
  )) {
    assert.equal(
      sha(
        JSON.stringify(document, null, 2).replaceAll(
          directory,
          "/NATIVE_LISTENER_RESOURCES",
        ),
      ),
      evidence.portableGraphSha256[name],
    );
  }
  for (const name of [
    "audio_listener_native_controller.js",
    "audio_listener_engine.js",
    "audio_listener_native_assembler.js",
    "audio_listener_native_coordinates.js",
    "audio_listener_native_io.js",
  ]) {
    const revision = revisions.currentSourceSnapshot[name];
    if (revision)
      assert.equal(revision.baselineSha256, evidence.codeSha256[name]);
    assert.equal(
      sha(await readFile(new URL(`./${name}`, import.meta.url))),
      revision?.sha256 ?? evidence.codeSha256[name],
    );
  }
});

test("actual full and partial trials preserve cleanup without granting cached runtime authority", () => {
  assert.equal(evidence.calibrationOnly, true);
  assert.equal(evidence.productionReady, false);
  assert.deepEqual(evidence.limits, {
    recordedEvidenceAuthorizesFreshCapture: false,
    authenticatedWireExercised: false,
    contextPublished: false,
    deviceSavedOrPromoted: false,
    supportedLive11342SeparatelyQualified: false,
  });
  assert.equal(evidence.failedAttempts.length, 4);
  assert.deepEqual(
    evidence.failedAttempts.map((failure) => failure.retainedWindows),
    [0, 0, 4, 13],
  );
  for (const failure of evidence.failedAttempts) {
    assert.notEqual(failure.outcome, "complete");
    assert.equal(failure.completeObservation, false);
    assert.notEqual(failure.command.passId, evidence.report.command.passId);
  }
  for (const cleanup of [
    evidence.cleanup,
    ...evidence.failedAttempts.map((failure) => failure.cleanup),
  ]) {
    assert.equal(cleanup.exactGraphRestored, true);
    assert.deepEqual(cleanup.before, { boxes: 130, lines: 150 });
    assert.deepEqual(cleanup.after, cleanup.before);
    assert.equal(cleanup.temporaryRootObjectsRemoved, 6);
    assert.equal(cleanup.ownedNodeProcessExited, true);
    assert.equal(cleanup.originalProcessesPreserved, true);
    assert.equal(cleanup.transportIndependentlyReadRunning, true);
    assert.equal(cleanup.automationArmRestored, 1);
    assert.equal(cleanup.audioRecordedOrExported, false);
    assert.equal(cleanup.deviceSavedOrPromoted, false);
  }
});
