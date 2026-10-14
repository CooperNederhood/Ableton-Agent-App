import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { URL } from "node:url";
import {
  assertNativeCaptureObservation,
  nativeCaptureProofSchema,
  nativeLaunchCoordinates,
  NATIVE_LISTENER_SCOPE,
} from "../../packages/protocol/src/native-listening-schemas.ts";
import { audioObservationSchema } from "../../packages/protocol/src/audio-observation-schemas.ts";
import { createKnownListeningFixture } from "../../packages/test-support/src/listening-fixture.ts";
import { nativeRuntimeDocuments } from "./native-runtime-source.mjs";

const require = createRequire(import.meta.url);
const evidence = require("./fixtures/native-sdk-capture.json");
const prior = require("./fixtures/native-controller-capture.json");
const clone = (value) => JSON.parse(JSON.stringify(value));
const sha = (value) => createHash("sha256").update(value).digest("hex");

function validate(value) {
  const proof = nativeCaptureProofSchema.parse(value.terminal.nativeCapture);
  const observation = audioObservationSchema.parse(value.terminal.observation);
  assertNativeCaptureObservation(proof, observation);
  assert.deepEqual(value.typedContext.observation, observation);
  assert.equal(value.typedContext.entry.passId, value.passId);
  assert.equal(value.typedContext.entry.listenerId, observation.listenerId);
  assert.equal(value.typedContext.entry.contextId, value.contextId);
  assert.equal(observation.passId, value.passId);
  assert.deepEqual(value.terminalJob.contextIds, [value.contextId]);
  assert.equal(value.terminalJob.stage, "completed");
  return { proof, observation };
}

function relative(value) {
  return {
    ...value,
    listenerId: "historical-listener",
    passId: "historical-pass",
    startSample: 0,
    endSample: value.endSample - value.startSample,
    samples: value.samples.map((row) => ({
      ...row,
      sample: row.sample - value.startSample,
    })),
    attacks: value.attacks.map((row) => ({
      ...row,
      sample: row.sample - value.startSample,
    })),
  };
}

test("actual authenticated native capture and typed persisted context satisfy the entire App proof", () => {
  const { proof, observation } = validate(evidence);
  assert.equal(evidence.schema, "native-sdk-capture-evidence/v1");
  assert.equal(proof.armed.scope, NATIVE_LISTENER_SCOPE);
  assert.equal(proof.armed.before.frames.length, 32);
  assert.equal(proof.after.frames.length, 32);
  assert.equal(proof.spectralWindows.length, 20);
  assert.equal(observation.samples.length, 20);
  assert.equal(observation.attacks.length, 4);
  assert.equal(observation.complete, true);
  assert.equal(observation.startBeat, 0);
  assert.equal(observation.endBeat, 4);
  assert.equal(observation.endSample - observation.startSample, 96000);
  assert.deepEqual(
    nativeLaunchCoordinates(proof.armed, proof.launched),
    evidence.coordinates,
  );
  assert.equal(evidence.coordinates.startSample, 129561486);
  assert.equal(evidence.terminalJob.durationMs, 8199);
});

test("the SDK path preserves all prior actual controller descriptors and independent settled PCM RMS", () => {
  const observation = evidence.terminal.observation;
  assert.deepEqual(
    relative(observation),
    relative(prior.report.terminal.observation),
  );
  const source = createKnownListeningFixture("quarter-sine");
  assert.equal(sha(source.wav), evidence.source.sha256);
  assert.equal(evidence.source.fittedGain, false);
  assert.equal(evidence.source.fittedShift, false);
  const pcm = new DataView(
    source.wav.buffer,
    source.wav.byteOffset,
    source.wav.byteLength,
  );
  for (const { index, rmsDbfs } of evidence.source.settledWindows) {
    for (let channel = 0; channel < 2; channel++) {
      let energy = 0;
      for (let offset = 0; offset < 4800; offset++) {
        const sample =
          pcm.getInt16(44 + ((index * 4800 + offset) * 2 + channel) * 2, true) /
          32768;
        energy += sample * sample;
      }
      const reference = 20 * Math.log10(Math.sqrt(energy / 4800));
      assert.equal(reference, rmsDbfs[channel]);
      assert.ok(
        Math.abs(observation.samples[index].rmsDbfs[channel] - reference) <=
          1e-12,
      );
    }
  }
  assert.deepEqual(
    evidence.source.settledWindows.map((row) => row.index),
    [1, 6, 11, 16],
  );
});

test("actual armed reply precedes causal native phases and atomic publication follows complete capture", () => {
  const events = evidence.lifecycle;
  const index = (name, predicate = () => true) => {
    const found = events.findIndex(
      (event) => event.name === name && predicate(event),
    );
    assert.ok(found >= 0, `Missing actual event ${name}`);
    return found;
  };
  const armed = index(
    "output.listener.completed",
    (event) => event.attributes.status === "armed",
  );
  assert.ok(armed < index("output.listener.native.preflight.queued"));
  assert.ok(armed < index("listening.runtime.playback-start.started"));
  assert.ok(
    index("output.listener.native.completed") <
      index("listening.runtime.publication.started"),
  );
  assert.ok(
    index("desktop.context.publication.completed") <
      index("listening.runtime.publication.completed"),
  );
  assert.ok(
    index("listening.runtime.publication.completed") <
      index("listening.runtime.wait.completed"),
  );
  const native = events.filter((event) =>
    event.name.startsWith("output.listener.native."),
  );
  const parents = new Set([evidence.initiatingToolCallId]);
  const elapsed = new Map();
  const generations = new Set();
  assert.deepEqual(
    [...new Set(native.map((event) => event.attributes.phase))],
    ["preflight", "reset", "capture"],
  );
  for (const event of native) {
    const data = event.attributes;
    assert.equal(event.trace.traceId, evidence.traceId);
    assert.equal(data.passId, evidence.passId);
    assert.equal(parents.has(data.causationId), true);
    assert.equal(parents.has(data.eventId), false);
    assert.ok(data.elapsedMs >= (elapsed.get(data.phase) ?? 0));
    assert.equal(event.durationMs, data.elapsedMs);
    elapsed.set(data.phase, data.elapsedMs);
    generations.add(data.generation);
    parents.add(data.eventId);
  }
  assert.equal(generations.size, 1);
  assert.equal(native.at(-1).attributes.reason, "range_complete");
  assert.equal(native.at(-1).attributes.frames, 20);
});

test("the recorded candidate used the pinned native math and exact SDK/watchdog sources", async () => {
  for (const [name, expected] of Object.entries({
    ...evidence.codeSha256,
    ...evidence.sdkCodeSha256,
  })) {
    if (!name.endsWith(".js")) continue;
    assert.equal(
      sha(await readFile(new URL(`./${name}`, import.meta.url))),
      expected,
    );
  }
  const documents = nativeRuntimeDocuments({
    resourceDirectory: "/RECORDED_AUTHENTICATED_CAPTURE",
  });
  for (const [name, expected] of Object.entries(evidence.codeSha256)) {
    if (!name.endsWith(".gendsp")) continue;
    assert.equal(sha(JSON.stringify(documents[name], null, 2)), expected);
    assert.equal(expected, prior.codeSha256[name]);
  }
  assert.equal(
    evidence.codeSha256["audio_listener_native_controller.js"],
    "29df0521293af0f354e85648d624c51c72916c08a322bd6a20fe7db2ea7b9908",
  );
});

test("actual capture preserves blocked readiness, unknown attribution and leave-running cleanup", () => {
  assert.equal(evidence.calibrationOnly, true);
  assert.equal(evidence.productionReady, false);
  assert.equal(
    evidence.nativeTiming,
    "INDEPENDENTLY_VALIDATED_FOR_RECORDED_PASS_ONLY",
  );
  assert.equal(evidence.liveVersion, "11.3.43");
  assert.equal(evidence.captureRuntime.isolatedProfile, true);
  assert.equal(evidence.listenersBeforeCapture.length, 2);
  assert.ok(
    evidence.listenersBeforeCapture.every(
      (listener) => listener.ready === false,
    ),
  );
  assert.deepEqual(evidence.captureRequest.listenerIds, [
    evidence.terminal.observation.listenerId,
  ]);
  assert.equal(evidence.typedContext.entry.freshness, "unknown");
  assert.match(
    evidence.typedContext.entry.summary,
    /arrangement-range: 3-ML-Calibration-quarter-sine/,
  );
  assert.match(
    evidence.typedContext.entry.summary,
    /Attribution unknown; primary association/,
  );
  assert.equal(evidence.terminalJob.cleanupPolicy, "leave-running");
  assert.equal(
    evidence.bridgeCommands.filter(
      (command) => command === "listening.start_playback",
    ).length,
    1,
  );
  for (const command of [
    "transport.set_playing",
    "listening.stop_playback",
    "clips.launch",
    "browser.load_item",
  ])
    assert.equal(evidence.bridgeCommands.includes(command), false);
});

test("corrupted native coverage or foreign persisted context cannot pass the recorded acceptance", () => {
  for (const corrupt of [
    (value) => value.terminal.observation.samples.splice(3, 1),
    (value) => value.terminal.nativeCapture.after.frames[0][9]++,
    (value) => {
      value.typedContext.entry.passId = "foreign-pass";
    },
    (value) => {
      value.typedContext.entry.listenerId = "foreign-listener";
    },
    (value) => (value.typedContext.observation.samples[0].peak[0] += 0.01),
    (value) => value.terminalJob.contextIds.push("foreign-context"),
  ]) {
    const changed = clone(evidence);
    corrupt(changed);
    assert.throws(() => validate(changed));
  }
});

test("exact historical context survives a different Desktop process without capture or readiness promotion", () => {
  validate(evidence);
  const resume = evidence.resume;
  assert.equal(resume.verified, true);
  assert.equal(
    resume.method,
    "typed-context-get-after-desktop-process-restart",
  );
  assert.notEqual(resume.desktopPid, evidence.captureRuntime.desktopPid);
  assert.ok(evidence.terminalJob.updatedAt < resume.endpointPublishedAt);
  assert.ok(resume.occurredAt >= resume.endpointPublishedAt);
  assert.equal(resume.typedGetId, evidence.typedGet.id);
  assert.equal(resume.occurredAt, evidence.typedGet.occurredAt);
  assert.equal(resume.listenersAfter.length, 2);
  assert.ok(
    resume.listenersAfter.every((listener) => listener.ready === false),
  );
  const native = resume.listenersAfter.find(
    (listener) =>
      listener.listenerId === evidence.terminal.observation.listenerId,
  );
  assert.ok(native.limitations.includes("native_per_pass_validation_required"));
  assert.equal(resume.transportAfter.isPlaying, true);
  assert.ok(
    resume.transportAfter.currentSongTime >
      evidence.terminal.observation.endBeat,
  );
  assert.deepEqual(
    [...resume.toolCalls].sort((a, b) => a.toolName.localeCompare(b.toolName)),
    [
      {
        toolName: "ableton_context",
        arguments: {
          action: "get",
          contextId: evidence.contextId,
          includeHistorical: false,
        },
      },
      {
        toolName: "ableton_listening",
        arguments: { action: "inspect-listeners" },
      },
      {
        toolName: "ableton_transport",
        arguments: { action: "get" },
      },
    ],
  );
});
