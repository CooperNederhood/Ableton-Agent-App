import "./native-protocol-test-loader.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  nativeArmProofSchema,
  nativeLaunchProofSchema,
  nativeCaptureProofSchema,
} from "../../packages/protocol/src/native-listening-schemas.ts";
const { audioObservationSchema } =
  await import("../../packages/protocol/src/audio-observation-schemas.ts");

const require = createRequire(import.meta.url);
const evidence = require("./fixtures/native-runner-clock-failure.json");

test("actual fresh-runner capture armed and launched but failed closed after five windows", () => {
  const arm = nativeArmProofSchema.parse(evidence.nativeArm);
  const launch = nativeLaunchProofSchema.parse(evidence.nativeLaunch);
  const observation = audioObservationSchema.parse(evidence.partialObservation);
  assert.equal(evidence.schema, "native-runner-clock-failure-evidence/v1");
  assert.equal(evidence.calibrationOnly, true);
  assert.equal(evidence.productionReady, false);
  assert.equal(evidence.liveVersion, "11.3.43");
  assert.equal(arm.nativeEpoch, launch.nativeEpoch);
  assert.equal(arm.armCounter, launch.armCounter);
  assert.equal(arm.before.frames.length, 32);
  assert.equal(observation.passId, evidence.passId);
  assert.equal(observation.complete, false);
  assert.equal(observation.samples.length, 5);
  assert.equal(observation.endSample - observation.startSample, 24000);
  assert.equal(observation.endBeat, 1);
  assert.throws(() =>
    nativeCaptureProofSchema.parse({
      armed: arm,
      launched: launch,
    }),
  );
  const failed = evidence.lifecycle.find(
    (row) => row.name === "output.listener.native.failed",
  );
  assert.equal(failed.attributes.reason, "native_clock_discontinuity");
  assert.equal(failed.attributes.frames, 5);
  assert.equal(failed.attributes.nativeEpoch, arm.nativeEpoch);
  assert.equal(failed.durationMs, 2470);
  assert.equal(evidence.terminalJob.stage, "failed");
  assert.equal(evidence.terminalJob.error, "native_clock_discontinuity");
  assert.deepEqual(evidence.terminalJob.contextIds, []);
});

test("the actual partial capture produced no context and is not a passed native scenario", () => {
  assert.equal(evidence.publicationEventCount, 0);
  assert.equal(evidence.typedSession.hasContextStore, false);
  assert.equal(evidence.policyDenialCount, 1);
  assert.equal(
    evidence.classification,
    "failed_native_capture_with_secondary_actor_policy_denial",
  );
  assert.match(evidence.limitation, /raw clock row was not recorded/);
  const index = (name) =>
    evidence.lifecycle.findIndex((row) => row.name === name);
  assert.ok(index("output.listener.completed") >= 0);
  assert.ok(
    index("output.listener.native.progress") <
      index("output.listener.native.failed"),
  );
  assert.ok(
    index("output.listener.native.failed") < index("output.listener.failed"),
  );
});
