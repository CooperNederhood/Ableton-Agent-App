import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { nativeArmProofSchema } from "../../packages/protocol/src/native-listening-schemas.ts";

const require = createRequire(import.meta.url);
const evidence = require("./fixtures/native-hardened-fixture-failure.json");

test("normally saved rebuilt fixture preserves originals but its ordinary attempt is still failed", () => {
  assert.equal(evidence.fixture.savedNormallyInLive, true);
  assert.equal(evidence.fixture.userAssistedSave, true);
  assert.equal(evidence.fixture.sourceXmlRewritten, false);
  assert.equal(evidence.fixture.nativeReferenceCount, 2);
  assert.equal(
    evidence.fixture.sourceSetSha256,
    "ece567777fbeb7a3900a462de255c041ac0f98ca67340823f54752e8b69647f8",
  );
  assert.equal(Object.keys(evidence.fixture.originalHashesUnchanged).length, 4);
  assert.equal(evidence.ordinary.instrumentation, "none");
  assert.equal(
    evidence.ordinary.nativeTerminalReason,
    "native_clock_discontinuity",
  );
  assert.equal(evidence.ordinary.clock, undefined);
  assert.equal(evidence.acceptancePassed, false);
  assert.equal(evidence.productionReady, false);
});

test("actual stopped armed offset mismatch does not establish the earlier playing phase-lag cohort", () => {
  const diagnostic = evidence.diagnostic;
  const { row, previous, state } = diagnostic.clock;
  assert.equal(state, "armed");
  assert.deepEqual(row.slice(0, 4), row.slice(7));
  assert.equal(row[4], row[6]);
  assert.equal(row[0], 0);
  assert.equal(previous[0], 0);
  assert.equal(row[1], 0);
  assert.equal(previous[1], 0);
  assert.equal(row[5], previous[5]);
  assert.equal(row[2] - row[4], 64);
  assert.equal(previous[2] - previous[4], 0);
  assert.equal(row[2] - previous[2], 512);
  assert.equal(row[4] - previous[4], 448);
  assert.deepEqual(diagnostic.sourceOverrides, []);
  for (const attempt of [evidence.ordinary, diagnostic]) {
    const proof = nativeArmProofSchema.parse(attempt.nativeArm);
    assert.equal(proof.before.frames.length, 32);
    assert.equal(attempt.nativeLaunch, null);
    assert.equal(attempt.nativeCapture, null);
    const failed = attempt.lifecycle.find(
      (event) => event.name === "output.listener.native.failed",
    );
    assert.equal(failed.attributes.frames, 0);
    assert.equal(failed.attributes.passId, attempt.terminalJob.passId);
    assert.equal(failed.attributes.nativeEpoch, proof.nativeEpoch);
    assert.equal(failed.attributes.reason, "native_clock_discontinuity");
    assert.ok(failed.attributes.elapsedMs >= 0);
  }
});

test("unsuccessful scheduler experiment retains quota failure and zero publication, not a claimed fix", () => {
  const experiment = evidence.schedulerExperiment;
  assert.equal(experiment.rejectedAsFix, true);
  assert.equal(experiment.nativeArm, null);
  assert.equal(
    experiment.nativeTerminalReason,
    "native_preflight_rejection_limit",
  );
  assert.equal(experiment.sourceOverrides.length, 1);
  assert.equal(
    experiment.sourceOverrides[0].name,
    "audio_listener_native_clock.maxpat",
  );
  assert.notEqual(
    experiment.sourceOverrides[0].sha256,
    experiment.sourceOverrides[0].previousSha256,
  );
  for (const attempt of [evidence.ordinary, evidence.diagnostic, experiment]) {
    assert.equal(attempt.terminalJob.stage, "failed");
    assert.deepEqual(attempt.terminalJob.contextIds, []);
    assert.equal(attempt.publicationEventCount, 0);
    assert.equal(attempt.typedSession.hasContextStore, false);
  }
});
