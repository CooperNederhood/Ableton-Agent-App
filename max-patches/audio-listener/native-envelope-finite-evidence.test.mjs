import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { URL } from "node:url";

const fixture = JSON.parse(
  readFileSync(
    new URL(
      "./fixtures/native-v2-envelope-finite-guard-observation.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const fields = [
  "epochBegin",
  "serialBegin",
  "faultWritten",
  "faultEpoch",
  "faultSerial",
  "sampleRate",
  "captureVector",
  "faultCounter",
  "faultClock",
  "renderIndex",
  "n",
  "completed",
  "originalCompositeRejectRecheck",
  "leftValue",
  "leftClass",
  "leftNaNReported",
  "leftClipped",
  "leftOriginalAcceptedRecheck",
  "leftWordAccepted",
  "rightValue",
  "rightClass",
  "rightNaNReported",
  "rightClipped",
  "rightOriginalAcceptedRecheck",
  "rightWordAccepted",
  "launchWritten",
  "launchEpoch",
  "launchCounter",
  "launchClock",
  "launchRawPhase",
  "launchPreviousPhase",
  "requestedFraction",
  "launchDistance",
  "launchPhaseSamples",
  "serialEnd",
  "epochEnd",
];
const values = fixture.private.firstFlagged.values;
const fault = Object.fromEntries(fields.map((field, i) => [field, values[i]]));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("native finite evidence binds the historical envelope, not future production revisions", () => {
  const bytes = readFileSync(
    new URL(
      `./fixtures/${fixture.provenance.baselineArchive}`,
      import.meta.url,
    ),
  );
  assert.equal(
    digest(bytes),
    fixture.provenance.baselineEnvelopeDocumentSha256,
  );
  const document = JSON.parse(bytes);
  const code = document.patcher.boxes.find(
    ({ box }) => box.maxclass === "codebox",
  ).box.code;
  assert.equal(digest(code), fixture.provenance.baselineEnvelopeCodeSha256);
  assert.notEqual(
    fixture.provenance.probeScope,
    fixture.provenance.packetSchemaScope,
  );
});

test("actual owned rejection15 retains an unchanged arm binding and coherent latched fault bookends", () => {
  assert.equal(values.length, 36);
  assert.ok(values.every(Number.isFinite));
  assert.equal(fixture.owner.matchesActorJob, true);
  assert.equal(fixture.main.values[4], 15);
  assert.equal(fixture.main.values[13], fixture.main.originalArmCounter);
  assert.equal(fixture.main.values[15], 2);
  assert.equal(fault.epochBegin, fixture.owner.nativeEpoch);
  assert.equal(fault.epochEnd, fault.epochBegin);
  assert.equal(fault.faultEpoch, fixture.private.expectedNativeEpoch);
  assert.equal(fault.serialBegin, fault.serialEnd);
  assert.equal(fault.faultSerial, fault.serialBegin);
  assert.equal(fault.faultWritten, 1);
  assert.equal(fault.sampleRate, 48000);
  assert.equal(fault.captureVector, 64);
  assert.equal(
    fault.faultCounter,
    fixture.main.originalArmCounter + fault.faultClock,
  );
  assert.equal(fault.launchCounter, fixture.main.values[14]);
  assert.equal(fault.faultCounter - fault.launchCounter, 64);
  assert.equal(fault.renderIndex, 0);
  assert.equal(fault.n, 0);
  assert.equal(fault.completed, 0);
});

test("actual displayable finite zeros fail original rechecks and pass equivalent word predicates", () => {
  for (const channel of ["left", "right"]) {
    assert.equal(fault[`${channel}Value`], 0);
    assert.equal(fault[`${channel}Class`], 0);
    assert.equal(fault[`${channel}NaNReported`], 0);
    assert.equal(fault[`${channel}Clipped`], 0);
    assert.equal(Number.isFinite(fault[`${channel}Value`]), true);
    assert.ok(Math.abs(fault[`${channel}Value`]) <= 1_000_000_000_000);
    assert.equal(fault[`${channel}OriginalAcceptedRecheck`], 0);
    assert.equal(fault[`${channel}WordAccepted`], 1);
  }
  assert.equal(fault.originalCompositeRejectRecheck, 1);
  assert.equal(fault.launchRawPhase, 0.25);
  assert.equal(fault.requestedFraction, 0.25);
  assert.equal(fault.launchDistance, 0);
});

test("fault collection preserves bounded attribution, denial and exact-owned cleanup without acceptance", () => {
  assert.equal(fixture.private.count, 178);
  assert.deepEqual(fixture.private.statuses, {
    unwritten: 177,
    incoherent: 0,
    stale: 0,
    "observed-fault": 1,
  });
  for (const key of [
    "foreignRunMessages",
    "malformedMessages",
    "decoderErrors",
  ])
    assert.equal(fixture.private[key], 0);
  assert.equal(fixture.private.notVectorAtomic, true);
  assert.equal(fixture.private.grantsAdmission, false);
  assert.equal(fixture.private.forwardedToSdk, false);
  assert.equal(fixture.private.forwardedToTypedFailureDiagnostics, false);
  assert.equal(fixture.instrumentedDiagnosticOnly, true);
  assert.equal(fixture.acceptancePassed, false);
  assert.equal(fixture.actor.completed, false);
  assert.deepEqual(fixture.actor.contextIds, []);
  assert.equal(fixture.matchedCompileComparison, false);
  assert.equal(fixture.nativeCompileCauseProven, false);
  assert.equal(fixture.actualNonSilentSourceVerified, false);
  for (const key of [
    "instrumentationRestored",
    "privateHandlerRemoved",
    "processStopped",
    "fixtureCleaned",
    "copiedResourcesUnchanged",
    "sourcePinsUnchanged",
  ])
    assert.equal(fixture.cleanup[key], true);
  assert.deepEqual(fixture.cleanup.errors, []);
});
