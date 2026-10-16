import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";
import * as protocol from "@ableton-agent/protocol";

async function evidence(file = "native-v2-finite-word-capture.json") {
  return JSON.parse(
    await readFile(
      new URL(
        `../../max-patches/audio-listener/fixtures/${file}`,
        import.meta.url,
      ),
      "utf8",
    ),
  );
}

function validate(record) {
  protocol.assertNativeCaptureObservationV2(
    protocol.nativeCaptureProofV2Schema.parse(record.nativeCapture),
    protocol.audioObservationV2Schema.parse(record.observation),
    protocol.snapshotNativeListeningExpectationV2(record.expected),
  );
}

describe("actual corrected v2 native capture and durable context", () => {
  it("independently accepts the actual nonzero fractional capture and exact partial final window", async () => {
    const record = await evidence();
    expect(() => validate(record)).not.toThrow();
    const observation = record.observation;
    expect(observation.endSample - observation.startSample).toBe(84000);
    expect(observation.samples).toHaveLength(18);
    expect(record.nativeCapture.spectralWindows).toHaveLength(18);
    expect(record.nativeCapture.armed.before.frames).toHaveLength(32);
    expect(record.nativeCapture.after.frames).toHaveLength(32);
    expect(
      observation.samples.at(-1).sample - observation.samples.at(-2).sample,
    ).toBe(2400);
    expect(observation.summaries.peak).toEqual([0.5, 0.5]);
    for (const peak of observation.summaries.peak)
      expect(peak >= 0.4 && peak <= 0.6).toBe(true);
    const spectra = record.nativeCapture.spectralWindows;
    expect(spectra.filter((window) => window[3] > 0)).toHaveLength(10);
    expect(spectra.reduce((sum, window) => sum + window[3], 0)).toBe(
      record.spectralEnergy,
    );
    expect(record.spectralEnergy).toBeGreaterThan(0);
    expect(observation.samples.at(-1).peak).toEqual([0, 0]);
    expect(observation.samples.at(-1).centroidHz).toBeNull();
  });

  describe("ordinary immutable v2 fractional capture", () => {
    it("independently accepts actual native proof and non-silent signal without diagnostic overrides", async () => {
      const record = await evidence(
        "native-v2-ordinary-fractional-capture.json",
      );
      expect(() => validate(record)).not.toThrow();
      expect(record.scope).toBe("ordinary-native-v2-qualification/v1");
      expect(record.instrumentedDiagnosticOnly).toBe(false);
      expect(record.inspectorAttached).toBe(false);
      expect(record.sourceOverrides).toEqual([]);
      expect(record.independentlyQualified).toBe(true);
      expect(
        record.observation.endSample - record.observation.startSample,
      ).toBe(84000);
      expect(record.observation.samples).toHaveLength(18);
      expect(record.observation.summaries.peak).toEqual([0.5, 0.5]);
      expect(record.positiveSpectralWindows).toBe(10);
      expect(record.spectralEnergy).toBeGreaterThan(0);
    });

    describe("actual descriptive native group escalation", () => {
      it("accepts the independently repeated fractional proof without relabelling its failed group", async () => {
        const group = await evidence(
          "native-v2-descriptive-group-observation.json",
        );
        expect(group.passed).toBe(false);
        expect(group.fractional.parentGroupPassed).toBe(false);
        expect(() => validate(group.fractional)).not.toThrow();
        expect(group.fractional.contextId).toBe(
          "220431ab-2274-47d9-a91a-3711345ddb7e",
        );
        expect(group.fractional.observation.summaries.peak).toEqual([0.5, 0.5]);
        expect(group.fractional.positiveSpectralWindows).toBe(10);
        expect(group.fractional.spectralEnergy).toBeGreaterThan(0);
        expect(group.attemptOrder).toEqual([
          "native-descriptive-fractional",
          "native-descriptive-30-seconds",
        ]);
      });

      describe("distinct long-capture spectrum acquisition failure", () => {
        it("retains the actual old interval with a final tag advanced exactly one FFT frame", async () => {
          const record = await evidence(
            "native-v2-long-spectrum-observation.json",
          );
          const diagnostic = record.nativeFailureDiagnostic;
          expect(diagnostic.scope).toBe("native-spectrum-rejection/v1");
          expect(diagnostic.check).toBe("bracket");
          expect(diagnostic.packet).toEqual([
            1134592, 0, 0, 1132544, 1136640, 0,
          ]);
          const [end, centroid, energy, start, final, invalid] =
            diagnostic.packet;
          expect(end - start).toBe(2048);
          expect(final - end).toBe(2048);
          expect(final).not.toBe(end);
          expect([centroid, energy, invalid]).toEqual([0, 0, 0]);
          expect(diagnostic.fftDiagnostics).toEqual([-1, -1, -1, -1, 0]);
          expect(diagnostic.metadata).toEqual({
            dsp: [1, 48000, 64],
            fftInfo: [2048, 2048, 2048, 1],
            clockAbi: 2,
            envelopeAbi: 2,
            spectrumAbi: 2,
          });
        });

        it("keeps this pre-launch-receipt failure separate from the unresolved 33-frame envelope fault", async () => {
          const record = await evidence(
            "native-v2-long-spectrum-observation.json",
          );
          expect(record.nativeLifecycle).toEqual({
            phase: "capture",
            elapsedMs: 1706,
            reportedFrames: 0,
            armAcknowledged: true,
            nativeLaunchReceiptRetained: false,
          });
          expect(record.observer.rejectedEnvelope).toBeNull();
          expect(record.originalLongFailure.nativeRejectionCode).toBeNull();
          expect(record.originalLongFailure.rejectedEnvelope).toBeNull();
          expect(record.contextIds).toEqual([]);
          expect(record.acceptancePassed).toBe(false);
          expect(record.cleanup.errors).toEqual([]);
          expect(record.cleanup).toMatchObject({
            instrumentationRestored: true,
            processStopped: true,
            fixtureCleaned: true,
            copiedResourcesUnchanged: true,
            sourcePinsUnchanged: true,
          });
        });
      });

      it("keeps the actual post-launch long-capture failure unattributed with no published context", async () => {
        const { thirtySecond } = await evidence(
          "native-v2-descriptive-group-observation.json",
        );
        expect(thirtySecond.passed).toBe(false);
        expect(thirtySecond.armObserved).toBe(true);
        expect(thirtySecond.launchObserved).toBe(true);
        expect(thirtySecond.reportedFrames).toBe(33);
        expect(thirtySecond.captureElapsedMs).toBe(5151);
        expect(thirtySecond.error).toBe("native_envelope_binding_changed");
        expect(thirtySecond.rejectedEnvelope).toBeNull();
        expect(thirtySecond.nativeRejectionCode).toBeNull();
        expect(thirtySecond.contextIds).toEqual([]);
        expect(thirtySecond.processCleanup).toEqual({
          processStopped: true,
          fixtureCleaned: true,
          transportCleanup: "leave-running",
        });
      });
    });

    it("preserves typed reopening and owned cleanup without claiming supported-version or exact timing qualification", async () => {
      const record = await evidence(
        "native-v2-ordinary-fractional-capture.json",
      );
      expect(record.freshProcessTypedRead).toBe(true);
      expect(record.contextId).toBe("bb6dead8-ff56-47c4-b619-513517f30a53");
      expect(record.processCleanup).toEqual({
        processStopped: true,
        fixtureCleaned: true,
        transportCleanup: "leave-running",
      });
      expect(record.evidence.attribution).toBe("unknown");
      expect(record.evidence.freshness).toBe("unknown");
      expect(record.evidence.alignment.intendedUse).toBe("descriptive-only");
      expect(
        record.evidence.alignment.verifiedAbsoluteErrorBoundSamples,
      ).toBeNull();
      expect(record.observedLiveVersion).toBe("11.3.43");
      expect(record.supportedTargetQualified).toBe(false);
    });

    it("retains matching measured summaries across distinct diagnostic and ordinary passes", async () => {
      const diagnostic = await evidence();
      const ordinary = await evidence(
        "native-v2-ordinary-fractional-capture.json",
      );
      expect(ordinary.observation.passId).not.toBe(
        diagnostic.observation.passId,
      );
      expect(ordinary.contextId).not.toBe(diagnostic.contextId);
      expect(ordinary.observation.summaries).toEqual(
        diagnostic.observation.summaries,
      );
      expect(ordinary.spectralEnergy).toBe(diagnostic.spectralEnergy);
    });
  });

  it("preserves the actual later rejection14 without inventing fault-time phase or retroattributing the earlier failure", async () => {
    const record = await evidence("native-v2-long-envelope-rejection.json");
    expect(record.rejected.values).toEqual([
      1, 92160, -1, 0, 14, 0, 0, -1, 0, 0, 0, 0, 158400, 1083904, 1176064, 2,
    ]);
    expect(record.rejected.nativeEpoch).toBe(1);
    expect(record.rejected.controllerState).toBe("capturing");
    expect(record.rejected.values[13]).toBe(record.rejected.originalArmCounter);
    expect(record.rejected.armCounterMismatch).toBe(false);
    expect(record.rejected.values[14]).toBe(
      record.rejected.values[13] + record.rejected.values[1],
    );
    expect(record.rejected.values[12] / 4800).toBe(33);
    expect(record.rawFaultPhase).toBeNull();
    expect(record.rawFaultPreviousPhase).toBeNull();
    expect(record.phaseCauseProven).toBe(false);
    expect(record.originalLongFailure).toEqual({
      scenarioRunId: "41efa008-b5d2-4df4-86a4-be312f2b2aaf",
      rejectedEnvelope: null,
      nativeRejectionCode: null,
    });
    expect(record.spectrumRecoveryPhysicallyObserved).toBeNull();
  });

  it("keeps the current-controller diagnostic owned, reversible and outside ordinary capture acceptance", async () => {
    const record = await evidence("native-v2-long-envelope-rejection.json");
    expect(record.instrumentedDiagnosticOnly).toBe(true);
    expect(record.acceptancePassed).toBe(false);
    expect(record.contextIds).toEqual([]);
    expect(record.controllerSha256).toBe(
      "f6e1e2de0230c86fe2d534f98400648edb3160deaacbb2bb88e74bf667d6c9d2",
    );
    expect(record.declaredResourceOverrides.map((item) => item.name)).toEqual([
      "audio_listener_native_controller.js",
      "audio-listener-manifest.json",
    ]);
    expect(record.rejected).toMatchObject(record.owner);
    expect(record.observer).toEqual({
      count: 551,
      foreignCalls: 0,
      malformedRows: 0,
      observerErrors: 0,
      prototypeRestored: true,
    });
    for (const key of [
      "instrumentationRestored",
      "processStopped",
      "fixtureCleaned",
      "copiedResourcesUnchanged",
      "sourcePinsUnchanged",
    ])
      expect(record.cleanup[key]).toBe(true);
    expect(record.cleanup.errors).toEqual([]);
  });

  it("retains the actual phase-range fault and independent residual without claiming binary endpoint precision", async () => {
    const record = await evidence("native-v2-phase-boundary-observation.json");
    const fault = record.privateFault;
    expect(fault.status).toBe("observed-fault");
    expect(fault.values).toHaveLength(27);
    expect(Object.values(fault.record)).toEqual(fault.values);
    expect(fault.record).toMatchObject({
      epochBegin: record.owner.nativeEpoch,
      epochEnd: record.owner.nativeEpoch,
      faultEpoch: record.owner.nativeEpoch,
      serialBegin: 2,
      serialEnd: 2,
      written: 1,
      branch: 1,
      rawPhase: 1,
      rawClass: 0,
      rawPhaseMinusOne: 0,
      phaseRangeAcceptedRecheck: 0,
      phaseChangedRecheck: 1,
    });
    expect(fault.guardRecheckAgrees).toBe(true);
    expect(fault.rawResidualValid).toBe(true);
    expect(fault.previousResidualValid).toBe(true);
    expect(fault.record.previousPhase).toBe(0.999958333333333);
    expect(fault.record.previousPhaseMinusOne).toBe(-0.000041666666667);
    expect(fault.exactBinaryEndpointProven).toBe(false);
    expect(fault.values.slice(14, 19)).toEqual([-1, -1, -1, -1, -1]);
    expect(fault.record.completed).toBe(record.rejectedEnvelope[12]);
    expect(fault.record.armCounter).toBe(record.originalArmCounter);
    expect(fault.record.nativeCounter - record.rejectedEnvelope[14]).toBe(
      162000,
    );
    expect(fault.record.clock - record.rejectedEnvelope[1]).toBe(162000);
    expect(fault.record.completed + fault.record.n + 64).toBe(162000);
  });

  it("keeps the native phase observation bounded, private and outside capture acceptance", async () => {
    const record = await evidence("native-v2-phase-boundary-observation.json");
    expect(record.instrumentedDiagnosticOnly).toBe(true);
    expect(record.acceptancePassed).toBe(false);
    expect(record.contextIds).toEqual([]);
    expect(record.privateFault.notVectorAtomic).toBe(true);
    expect(record.observer.statuses).toEqual({
      unwritten: 501,
      incoherent: 0,
      stale: 0,
      "observed-fault": 1,
    });
    expect(record.observer.privateCount).toBe(502);
    expect(record.observer.privateDecoderErrors).toBe(0);
    expect(record.observer.handlerRegisteredBeforeActor).toBe(true);
    expect(record.observer.handlerRemoved).toBe(true);
    for (const key of [
      "instrumentationRestored",
      "processStopped",
      "fixtureCleaned",
      "copiedResourcesUnchanged",
      "sourcePinsUnchanged",
    ])
      expect(record.cleanup[key]).toBe(true);
    expect(record.cleanup.errors).toEqual([]);
  });

  it("discriminates native exact-endpoint equality from rounded overshoot in the new precision capture only", async () => {
    const record = await evidence("native-v2-exact-endpoint-observation.json");
    const fault = record.privateFault;
    expect(fault.values).toHaveLength(31);
    expect(fault.values.slice(0, 9)).toEqual([1, 2, 1, 1, 1, 48000, 1, 0, 0]);
    expect(fault.values.slice(25, 31)).toEqual([1, 0, 0, 0, 2, 1]);
    expect(fault.endpointComparison).toBe("native_equal_one");
    expect(fault.guardRecheckAgrees).toBe(true);
    expect(fault.scaledResidualValid).toBe(true);
    expect(fault.comparisonResidualAgrees).toBe(true);
    expect(fault.values.slice(14, 19)).toEqual([-1, -1, -1, -1, -1]);
    expect(fault.values[19] - record.rejectedEnvelope[14]).toBe(162000);
    expect(fault.values[21] + fault.values[22] + 64).toBe(162000);
    expect(record.rejectedEnvelope[13]).toBe(record.originalArmCounter);
    const earlier = await evidence("native-v2-phase-boundary-observation.json");
    expect(earlier.privateFault.exactBinaryEndpointProven).toBe(false);
  });

  it("does not turn endpoint diagnosis into ordinary capture or physical timing acceptance", async () => {
    const record = await evidence("native-v2-exact-endpoint-observation.json");
    expect(record.instrumentedDiagnosticOnly).toBe(true);
    expect(record.acceptancePassed).toBe(false);
    expect(record.contextIds).toEqual([]);
    expect(record.privateFault.notVectorAtomic).toBe(true);
    expect(record.observer.statuses).toEqual({
      unwritten: 509,
      incoherent: 0,
      stale: 0,
      "observed-fault": 1,
    });
    expect(record.observer.privateCount).toBe(510);
    expect(record.observer.privateDecoderErrors).toBe(0);
    for (const key of [
      "instrumentationRestored",
      "processStopped",
      "fixtureCleaned",
      "copiedResourcesUnchanged",
      "sourcePinsUnchanged",
    ])
      expect(record.cleanup[key]).toBe(true);
    expect(record.cleanup.errors).toEqual([]);
  });

  it("independently accepts the complete actual 30-second proof and fresh typed context", async () => {
    const record = await evidence(
      "native-v2-long-capture-with-failed-final-verifier.json",
    );
    expect(() => validate(record)).not.toThrow();
    expect(record.observation.endSample - record.observation.startSample).toBe(
      1440000,
    );
    expect(record.observation.samples).toHaveLength(300);
    expect(record.nativeCapture.envelopeWindows).toHaveLength(300);
    expect(record.nativeCapture.spectralWindows).toHaveLength(300);
    expect(record.nativeCapture.armed.before.frames).toHaveLength(32);
    expect(record.nativeCapture.after.frames).toHaveLength(32);
    expect(record.nativeProofIndependentlyAccepted).toBe(true);
    expect(record.freshProcessTypedRead).toBe(true);
    expect(record.contextId).toBe("b456194e-7ab1-4d5b-a409-9b8066fcc4a0");
    expect(record.observation.summaries.peak).toEqual([0.5, 0.5]);
    expect(record.positiveSpectralWindows).toBe(10);
    expect(
      record.nativeCapture.spectralWindows.reduce(
        (sum, window) => sum + window[3],
        0,
      ),
    ).toBe(record.spectralEnergy);
    expect(record.spectralEnergy).toBeGreaterThan(0);
    expect(record.observation.alignment).toMatchObject({
      alignment: "approximate",
      intendedUse: "descriptive-only",
      observedClockDisagreementSamples: 1,
      observedBeatDisagreementSamples: 1,
      verifiedAbsoluteErrorBoundSamples: null,
      estimatedAbsoluteErrorSamples: null,
    });
  });

  it("retains failed actor postconditions despite successful native capture and cleanup", async () => {
    const record = await evidence(
      "native-v2-long-capture-with-failed-final-verifier.json",
    );
    expect(record.actorPassed).toBe(false);
    expect(record.actorError).toBe(
      "Leave-running capture cleanup, immutable binding or recording state mismatch",
    );
    expect(record.captureOnlyAfterVerifierFailure).toBe(true);
    expect(record.acceptancePassed).toBe(false);
    expect(record.instrumentedDiagnosticOnly).toBe(true);
    expect(
      record.sourceOverrides.find(
        (resource) =>
          resource.kind === "unique-current-production-exact-endpoint-gen",
      )?.sha256,
    ).toBe("be01a84ea0c4c86e95375401f59306ce67e7afab1b263ef9b3ffe6502f3dbb91");
    for (const key of [
      "instrumentationRestored",
      "processStopped",
      "fixtureCleaned",
      "copiedResourcesUnchanged",
      "sourcePinsUnchanged",
    ])
      expect(record.cleanup[key]).toBe(true);
    expect(record.cleanup.errors).toEqual([]);
  });

  it("rejects a missing interior window in the actual 300-window proof", async () => {
    const record = await evidence(
      "native-v2-long-capture-with-failed-final-verifier.json",
    );
    record.nativeCapture.envelopeWindows.splice(150, 1);
    expect(() => validate(record)).toThrow();
  });

  it("attributes the new final-state failure only to the observed connection and registration change", async () => {
    const record = await evidence(
      "native-v2-long-connection-change-observation.json",
    );
    expect(record.actorPassed).toBe(false);
    expect(record.postconditions.passed).toBe(false);
    expect(record.postconditions.checks).toEqual({
      snapshotPlaying: true,
      transportPlaying: true,
      recordingInactive: true,
      listenerIdle: true,
      listenerPassReleased: true,
      listenerJobReleased: true,
      connectionUnchanged: false,
      registrationUnchanged: false,
      bindingUnchanged: true,
    });
    expect(record.postconditions.failedChecks).toEqual([
      "connectionUnchanged",
      "registrationUnchanged",
    ]);
    expect(
      record.postconditions.differences.map((difference) => difference.path),
    ).toEqual([
      "listener.connectionId",
      "listener.registration.connectionEpoch",
    ]);
    expect(record.postconditions.differencesTruncated).toBe(false);
    expect(record.connectionChangeTimingProven).toBe(false);
    expect(record.connectionChangeCauseProven).toBe(false);
    expect(record.earlierFailure.failedChecks).toBeNull();
  });

  it("retains repeated native long-capture success without waiving changed connection postconditions", async () => {
    const record = await evidence(
      "native-v2-long-connection-change-observation.json",
    );
    expect(record.acceptancePassed).toBe(false);
    expect(record.capture).toMatchObject({
      nativeProofIndependentlyAccepted: true,
      freshProcessTypedRead: true,
      frameCount: 1440000,
      envelopeWindows: 300,
      spectralWindows: 300,
      beforeTimingFrames: 32,
      afterTimingFrames: 32,
      contextId: "54c4b1b7-8c52-4f85-8cef-a4b1ac38cc0d",
    });
    expect(record.capture.summaries.peak).toEqual([0.5, 0.5]);
    expect(record.capture.spectralEnergy).toBeGreaterThan(0);
    expect(record.postconditions.before.inspection.sha256).toBe(
      record.postconditions.after.inspection.sha256,
    );
    expect(record.postconditions.before.recording.sha256).toBe(
      record.postconditions.after.recording.sha256,
    );
    expect(record.cleanup.processStopped).toBe(true);
    expect(record.cleanup.fixtureCleaned).toBe(true);
    expect(record.cleanup.errors).toEqual([]);
  });

  it.each(["missing-window", "erased-spectrum", "changed-range"])(
    "rejects %s instead of treating completed prose or context identity as sufficient",
    async (change) => {
      const record = await evidence();
      if (change === "missing-window")
        record.nativeCapture.envelopeWindows.pop();
      if (change === "erased-spectrum")
        for (const window of record.nativeCapture.spectralWindows) {
          window[2] = 0;
          window[3] = 0;
        }
      if (change === "changed-range") record.observation.endSample--;
      expect(() => validate(record)).toThrow();
    },
  );

  it("retains approximate-only authority, fresh-process typed identity and exact-owned cleanup", async () => {
    const record = await evidence();
    expect(record.observation.passId).toBe(record.expected.passId);
    expect(record.contextId).toBe("781dd134-6876-4148-816f-63d5f219be4d");
    expect(record.typedReopen.freshProcess).toBe(true);
    expect(record.observation.alignment).toMatchObject({
      alignment: "approximate",
      intendedUse: "descriptive-only",
      observedClockDisagreementSamples: 0,
      observedBeatDisagreementSamples: 0,
      verifiedAbsoluteErrorBoundSamples: null,
      estimatedAbsoluteErrorSamples: null,
    });
    expect(record.instrumentedDiagnosticOnly).toBe(true);
    expect(record.acceptancePassed).toBe(false);
    expect(record.independentSignalQualified).toBe(true);
    expect(record.observer).toMatchObject({
      count: 415,
      rejected: null,
      errors: 0,
      originalPathsUnchanged: true,
    });
    for (const key of [
      "instrumentationRestored",
      "processStopped",
      "fixtureCleaned",
      "copiedResourcesUnchanged",
      "sourcePinsUnchanged",
    ])
      expect(record.cleanup[key]).toBe(true);
    expect(record.cleanup.errors).toEqual([]);
  });
});
