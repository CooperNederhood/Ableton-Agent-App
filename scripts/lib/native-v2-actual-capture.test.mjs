import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";
import * as protocol from "@ableton-agent/protocol";

async function evidence() {
  return JSON.parse(
    await readFile(
      new URL(
        "../../max-patches/audio-listener/fixtures/native-v2-finite-word-capture.json",
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
