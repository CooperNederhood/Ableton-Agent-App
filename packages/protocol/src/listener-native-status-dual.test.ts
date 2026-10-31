import { describe, expect, it } from "vitest";
import {
  listenerNativeDualStatusSchema,
  listenerDualCapabilitiesSchema,
} from "./listener-native-status-dual.js";

export const dualStatus = {
  version: 4,
  scope: "mode-negotiated-transport/v1",
  supportedModes: ["arrangement", "session"],
  readiness: "BLOCKED",
  reason: "fresh_per_pass_native_validation_required",
  alignment: "approximate",
  verifiedAbsoluteErrorBoundSamples: null,
  acceptedSampleRates: [44100, 48000],
  acceptedVectorSizes: [64],
  timingModes: ["descriptive", "strict"],
  maxClockDisagreementSamples: 480,
  maxAudioDurationMs: 30000,
  maxWindows: 300,
  abiVersion: 2,
};
describe("wire4 explicit dual-mode status", () => {
  it.each([
    { capabilities: ["audio-listener/dual-mode-v1"], accepted: true },
    {
      capabilities: [
        "audio-listener/dual-mode-v1",
        "audio-listener/retention-v1",
      ],
      accepted: true,
    },
    { capabilities: undefined, accepted: false },
    { capabilities: [], accepted: false },
    { capabilities: ["audio-listener/retention-v1"], accepted: false },
    {
      capabilities: [
        "audio-listener/retention-v1",
        "audio-listener/dual-mode-v1",
      ],
      accepted: false,
    },
    {
      capabilities: [
        "audio-listener/dual-mode-v1",
        "audio-listener/dual-mode-v1",
      ],
      accepted: false,
    },
    {
      capabilities: ["audio-listener/dual-mode-v1", "unknown"],
      accepted: false,
    },
    {
      capabilities: [
        "audio-listener/dual-mode-v1",
        "audio-listener/retention-v1",
        "unknown",
      ],
      accepted: false,
    },
  ])(
    "validates the shared capability tuple $capabilities",
    ({ capabilities, accepted }) => {
      expect(
        listenerDualCapabilitiesSchema.safeParse(capabilities).success,
      ).toBe(accepted);
    },
  );
  it("advertises exactly both modes without claiming readiness", () => {
    expect(listenerNativeDualStatusSchema.parse(dualStatus)).toEqual(
      dualStatus,
    );
  });
  it.each([
    { version: 5 },
    { version: 3 },
    { supportedModes: ["session"] },
    { supportedModes: ["session", "arrangement"] },
    { abiVersion: 3 },
    { scope: "session-transport-coupled/v1" },
    { reason: undefined },
    { verifiedAbsoluteErrorBoundSamples: 0 },
  ])("rejects unsupported, downgraded or misleading status %j", (change) => {
    expect(
      listenerNativeDualStatusSchema.safeParse({ ...dualStatus, ...change })
        .success,
    ).toBe(false);
  });
});
