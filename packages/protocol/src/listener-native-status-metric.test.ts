import { describe, expect, it, vi } from "vitest";
import {
  listenerNativeMetricStatusSchema,
  type ListenerNativeMetricStatus,
} from "./listener-native-status-metric.js";
const { listenerNativeMetricStatusSchema: wrapperSchema } =
  await vi.importActual<{
    listenerNativeMetricStatusSchema: typeof listenerNativeMetricStatusSchema;
  }>("../../signal-routing/src/listener-metric-contracts.js");
const { createSyntheticMetricWireFixture } = await vi.importActual<{
  createSyntheticMetricWireFixture(this: void): {
    registration: { nativeStatus: unknown };
    ready: unknown;
  };
}>("../../signal-routing/src/listener-metric-test-support.js");

function status(): ListenerNativeMetricStatus {
  return listenerNativeMetricStatusSchema.parse(
    createSyntheticMetricWireFixture().registration.nativeStatus,
  );
}

describe("canonical producer-reported native metric status", () => {
  it("preserves the wrapper API as the same canonical schema", () => {
    expect(wrapperSchema).toBe(listenerNativeMetricStatusSchema);
  });

  it("accepts synthetic executed Gen evidence without certifying physical readiness", () => {
    const value = status();
    expect(listenerNativeMetricStatusSchema.parse(value)).toEqual(value);
    expect(value.executedGen?.receipt.fields[10]).toBe(
      value.executedGen?.ownership.nativeEpoch,
    );
    expect(value.alignment).toBe("approximate");
    expect(value.verifiedAbsoluteErrorBoundSamples).toBeNull();
  });

  it.each([undefined, null])(
    "admits cold per-pass commissioning with executedGen=%s",
    (executedGen) => {
      const value = {
        ...status(),
        readiness: "BLOCKED",
        reason: "fresh_per_pass_native_validation_required",
        executedGen,
      };
      expect(listenerNativeMetricStatusSchema.parse(value)).toEqual(value);
    },
  );

  it.each([
    { version: 4 },
    { version: 6 },
    { scope: "mode-negotiated-transport/v1" },
    { readiness: "READY", executedGen: null },
    { readiness: "READY", executedGen: undefined },
    { readiness: "BLOCKED", reason: undefined },
    { readiness: "CANCELLED" },
    { acceptedSampleRates: [48_000] },
    { acceptedVectorSizes: [64, 64] },
    { acceptedVectorSizes: [63] },
    { acceptedVectorSizes: [] },
    { supportedModes: ["session", "arrangement"] },
    { timingModes: ["strict"] },
    { verifiedAbsoluteErrorBoundSamples: 0 },
    { maxAudioDurationMs: 30_001 },
    { maxReportRows: 2_001 },
    { maxClockDisagreementSamples: 481 },
    { reason: "unbounded reason text" },
    { reason: "a".repeat(129) },
    { additional: "forbidden" },
  ])("rejects malformed or contradictory declarations %j", (change) => {
    expect(
      listenerNativeMetricStatusSchema.safeParse({ ...status(), ...change })
        .success,
    ).toBe(false);
  });

  it("rejects idle admission mislabeled executed Gen evidence", () => {
    const fixture = createSyntheticMetricWireFixture();
    expect(
      listenerNativeMetricStatusSchema.safeParse({
        ...status(),
        executedGen: fixture.ready,
      }).success,
    ).toBe(false);
  });

  it.each(["epoch", "dsp", "seal"] as const)(
    "rejects internally inconsistent executed %s evidence",
    (field) => {
      const value = status();
      const proof = value.executedGen;
      if (proof == null) throw new Error("Synthetic executed proof required");
      if (field === "epoch") proof.ownership.nativeEpoch += 1;
      if (field === "dsp") proof.before.dsp[1] = 44_100;
      if (field === "seal") proof.receipt.confirmedFields[10] += 1;
      expect(listenerNativeMetricStatusSchema.safeParse(value).success).toBe(
        false,
      );
    },
  );
});
