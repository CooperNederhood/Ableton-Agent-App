import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { nativeArmProofSchema } from "../../packages/protocol/src/native-listening-schemas.ts";

const require = createRequire(import.meta.url);
const evidence = require("./fixtures/native-sdk-source-denial.json");

function validate(value) {
  const arm = nativeArmProofSchema.parse(value.nativeArm);
  const event = (name) => {
    const found = value.lifecycle.find((row) => row.name === name);
    assert.ok(found, `Missing recorded event ${name}`);
    return found;
  };
  const armed = event("output.listener.completed");
  const denied = event("listening.runtime.playback-start.failed");
  const cancel = event("output.listener.native.cancelled");
  const acknowledged = event("output.listener.cancelled");
  assert.equal(armed.attributes.status, "armed");
  assert.match(denied.attributes.detail, /insert marker does not match/);
  assert.ok(armed.sequence < denied.sequence);
  assert.ok(denied.sequence < cancel.sequence);
  assert.ok(cancel.sequence < acknowledged.sequence);
  assert.equal(cancel.attributes.passId, value.passId);
  assert.equal(cancel.attributes.nativeEpoch, arm.nativeEpoch);
  assert.equal(cancel.attributes.frames, 0);
  assert.equal(cancel.attributes.reason, "cancelled");
  assert.equal(
    cancel.attributes.generation,
    value.lifecycle.find(
      (row) => row.name === "output.listener.native.preflight.queued",
    ).attributes.generation,
  );
  assert.equal(acknowledged.attributes.passId, value.passId);
  assert.equal(acknowledged.attributes.status, "cancelled");
  assert.equal(value.terminalJob.stage, "failed");
  assert.deepEqual(value.terminalJob.contextIds, []);
  assert.equal(value.nativeLaunchCount, 0);
  assert.equal(value.nativeCaptureCount, 0);
  assert.equal(value.publicationEventCount, 0);
  return { arm, cancel };
}

test("actual post-arm marker denial cancels the exact native generation without publishing", () => {
  const { arm, cancel } = validate(evidence);
  assert.equal(evidence.schema, "native-sdk-source-denial-evidence/v1");
  assert.equal(evidence.classification, "source_denied_after_arm");
  assert.equal(evidence.activeCaptureCancellationVerified, false);
  assert.equal(evidence.calibrationOnly, true);
  assert.equal(evidence.productionReady, false);
  assert.equal(evidence.liveVersion, "11.3.43");
  assert.equal(arm.nativeEpoch, 2);
  assert.equal(arm.before.frames.length, 32);
  assert.equal(evidence.captureRequest.endBeat, 20);
  assert.equal(evidence.terminalJob.durationMs, 6277);
  assert.equal(cancel.attributes.elapsedMs, 2489);
  assert.equal(cancel.durationMs, cancel.attributes.elapsedMs);
  for (const row of evidence.lifecycle)
    assert.equal(row.trace.traceId, evidence.traceId);
  assert.equal(
    evidence.bridgeCommands.filter(
      (command) => command === "listening.start_playback",
    ).length,
    1,
  );
  for (const command of [
    "transport.set_playing",
    "transport.seek",
    "listening.stop_playback",
  ])
    assert.equal(evidence.bridgeCommands.includes(command), false);
});

test("actual independent reads find no failed-pass context and preserve the earlier observation", () => {
  assert.deepEqual(evidence.verification.failedPassContexts, {
    action: "list",
    entries: [],
  });
  assert.equal(evidence.verification.existingContextUnchanged, true);
  assert.equal(
    evidence.verification.existingContextId,
    require("./fixtures/native-sdk-capture.json").contextId,
  );
  assert.equal(
    evidence.verification.existingContextSha256,
    createHash("sha256")
      .update(
        JSON.stringify(
          require("./fixtures/native-sdk-capture.json").typedContext,
        ),
      )
      .digest("hex"),
  );
  assert.equal(evidence.verification.transport.isPlaying, false);
  assert.equal(evidence.verification.transport.currentSongTime, 0);
  assert.equal(evidence.verification.transport.tempo, 120);
  assert.equal(evidence.verification.calls.length, 3);
  for (const call of evidence.verification.calls) {
    assert.ok(["ableton_context", "ableton_transport"].includes(call.toolName));
    assert.ok(["get", "list"].includes(call.arguments.action));
  }
});

test("a foreign generation, a launch or publication cannot masquerade as the recorded denial", () => {
  for (const corrupt of [
    (value) => {
      value.nativeLaunchCount = 1;
    },
    (value) => {
      value.publicationEventCount = 1;
    },
    (value) => {
      value.terminalJob.contextIds.push("foreign-context");
    },
    (value) => {
      value.lifecycle.find(
        (row) => row.name === "output.listener.native.cancelled",
      ).attributes.nativeEpoch++;
    },
  ]) {
    const value = JSON.parse(JSON.stringify(evidence));
    corrupt(value);
    assert.throws(() => validate(value));
  }
});
