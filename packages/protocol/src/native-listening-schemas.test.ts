import { describe, expect, it } from "vitest";
import { createSyntheticNativeListeningFixture } from "./testing.js";
import {
  assertNativeCaptureObservation,
  nativeArmProofSchema,
  nativeCaptureProofSchema,
  nativeLaunchCoordinates,
  nativeListenerLifecycleSchema,
} from "./native-listening-schemas.js";

describe("independent native listener evidence", () => {
  it.each([0.2, 0.4, 4.6, 10.6, 19.8, 20])(
    "retains exact whole-window coverage at beat %s",
    (endBeat) => {
      const { proof, observation } = createSyntheticNativeListeningFixture({
        endBeat,
      });
      expect(() =>
        assertNativeCaptureObservation(proof, observation),
      ).not.toThrow();
    },
  );
  it("derives the origin from coherent clocks, without treating held stopped phase as zero", () => {
    const { proof, observation } = createSyntheticNativeListeningFixture();
    expect(nativeLaunchCoordinates(proof.armed, proof.launched)).toEqual({
      startSample: 1_000_000,
      originCounter: 100544,
      hostOffsetSamples: 899456,
    });
    expect(() =>
      assertNativeCaptureObservation(proof, observation),
    ).not.toThrow();
    expect(JSON.stringify(proof).length).toBeLessThan(32 * 1024);
  });

  it.each([
    "short",
    "torn",
    "offset",
    "phase",
    "flags",
    "dsp",
    "stale-arm",
    "reset",
  ])("rejects %s arm evidence", (kind) => {
    const { proof } = createSyntheticNativeListeningFixture();
    const armed = proof.armed;
    const row = armed.before.frames[1]!;
    if (kind === "short") armed.before.frames.pop();
    if (kind === "torn") row[9]++;
    if (kind === "offset") {
      row[2]++;
      row[9]++;
    }
    if (kind === "phase") {
      row[1] = 1;
      row[8] = 1;
    }
    if (kind === "flags") {
      row[3] = 0;
      row[10] = 0;
    }
    if (kind === "dsp") Reflect.set(armed.before.dsp, "2", 128);
    if (kind === "stale-arm") armed.armCounter += 720000;
    if (kind === "reset") Reflect.set(armed.reset, "launchClock", 0);
    expect(nativeArmProofSchema.safeParse(armed).success).toBe(false);
  });

  it.each([
    "epoch",
    "arm",
    "launch-phase",
    "host",
    "coverage",
    "gap",
    "beat",
    "fft-future",
    "fft-old",
    "fft-grid",
    "post-offset",
    "post-old",
    "attack",
    "fft-centroid",
    "fft-summary",
  ])("denies %s disagreement before publication", (kind) => {
    const { proof, observation } = createSyntheticNativeListeningFixture();
    if (kind === "epoch") proof.launched.nativeEpoch++;
    if (kind === "arm") proof.launched.armCounter++;
    if (kind === "launch-phase") proof.launched.launchPhaseSamples--;
    if (kind === "host") proof.launched.host.sample++;
    if (kind === "coverage") observation.samples.pop();
    if (kind === "gap") observation.samples[1]!.sample++;
    if (kind === "beat") observation.samples[1]!.beat += 1 / 24000;
    if (kind === "fft-future") proof.spectralWindows[0]![1] += 4800;
    if (kind === "fft-old") {
      proof.spectralWindows[1]![0] -= 2048;
      proof.spectralWindows[1]![1] -= 2048;
    }
    if (kind === "fft-grid") {
      proof.spectralWindows[1]![0]++;
      proof.spectralWindows[1]![1]++;
    }
    if (kind === "post-offset") {
      for (const row of proof.after.frames) {
        row[2]++;
        row[9]++;
      }
    }
    if (kind === "post-old") {
      for (const row of proof.after.frames) {
        row[2] += 48000;
        row[9] += 48000;
        row[4] += 48000;
        row[6] += 48000;
        row[1] += 2;
        row[8] += 2;
      }
    }
    if (kind === "attack")
      observation.attacks.push({
        sample: observation.startSample + 64,
        beat: 1,
        strength: 1,
      });
    if (kind === "fft-centroid") {
      proof.spectralWindows[0]![2] = 440;
      proof.spectralWindows[0]![3] = 1;
    }
    if (kind === "fft-summary") {
      for (const window of proof.spectralWindows) {
        window[2] = 440;
        window[3] = 1;
      }
      for (const point of observation.samples) point.centroidHz = 440;
    }
    const parsed = nativeCaptureProofSchema.parse(proof);
    expect(() => assertNativeCaptureObservation(parsed, observation)).toThrow(
      /native_/,
    );
  });

  it("recomputes nonzero centroid values and their energy-weighted summary without fitted scaling", () => {
    const { proof, observation } = createSyntheticNativeListeningFixture();
    let weighted = 0;
    let energy = 0;
    for (const [index, window] of proof.spectralWindows.entries()) {
      window[2] = 440 + index;
      window[3] = index + 1;
      observation.samples[index]!.centroidHz = window[2];
      observation.samples[index]!.peak = [0.5, 0.5];
      observation.samples[index]!.rmsDbfs = [-12, -12];
      weighted += window[2] * window[3];
      energy += window[3];
    }
    observation.summaries.centroidHz = weighted / energy;
    observation.summaries.peak = [0.5, 0.5];
    observation.summaries.rmsDbfs = [-12, -12];
    expect(() =>
      assertNativeCaptureObservation(proof, observation),
    ).not.toThrow();
  });

  it("accepts bounded causal lifecycle fields, not raw audio or arbitrary exception text", () => {
    const event = {
      eventId: "11111111-1111-4111-8111-111111111111",
      causationId: "control",
      stage: "started",
      nativeEpoch: 1,
      elapsedMs: 0,
      frames: 0,
    };
    expect(nativeListenerLifecycleSchema.parse(event)).toEqual(event);
    for (const patch of [
      { rawAudio: [1, 2, 3] },
      { reason: "unbounded external error: password=secret" },
      { frames: 101 },
      { nativeEpoch: 1000001 },
      { elapsedMs: Infinity },
    ])
      expect(
        nativeListenerLifecycleSchema.safeParse({ ...event, ...patch }).success,
      ).toBe(false);
  });
});
