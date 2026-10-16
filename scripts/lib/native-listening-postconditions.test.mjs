import { describe, expect, it } from "vitest";
import { sanitizePersistedText } from "@ableton-agent/observability";
import { inspectNativeListeningPostconditions } from "./native-listening-verification.mjs";

// Synthetic unit inputs, never reconstructed dc7ade30 poststates.
function fixture() {
  const listener = {
    phase: "idle",
    connectionId: "connection",
    registration: { version: 2, nativeStatus: { timing: "UNVERIFIED" } },
  };
  return {
    baselineSnapshot: { isPlaying: false },
    finalSnapshot: { isPlaying: true },
    inspected: {
      transport: { playing: false, recording: { recordMode: false } },
    },
    finalInspection: {
      transport: { playing: true, recording: { recordMode: false } },
    },
    listener,
    finalListener: globalThis.structuredClone(listener),
    beforeBinding: [
      { canonicalPath: "live_set tracks 0 devices 0", enabled: true },
    ],
    afterBinding: [
      { canonicalPath: "live_set tracks 0 devices 0", enabled: true },
    ],
  };
}
const inspect = (input) =>
  inspectNativeListeningPostconditions(input, sanitizePersistedText);

describe("bounded native leave-running diagnosis (synthetic unit inputs only)", () => {
  it("preserves the original successful conjunction and original before/after values", () => {
    const result = inspect(fixture());
    expect(result.passed).toBe(true);
    expect(result.failedChecks).toEqual([]);
    expect(Object.keys(result.checks)).toHaveLength(9);
    expect(result.differences).toEqual([]);
    expect(result.before.snapshotPlaying).toEqual({
      type: "boolean",
      value: false,
    });
    expect(result.after.snapshotPlaying).toEqual({
      type: "boolean",
      value: true,
    });
  });
  it.each([
    [
      "snapshotPlaying",
      (f) => {
        f.finalSnapshot.isPlaying = false;
      },
    ],
    [
      "transportPlaying",
      (f) => {
        f.finalInspection.transport.playing = false;
      },
    ],
    [
      "recordingInactive",
      (f) => {
        f.finalInspection.transport.recording.recordMode = true;
      },
    ],
    [
      "listenerIdle",
      (f) => {
        f.finalListener.phase = "reserved";
      },
    ],
    [
      "listenerPassReleased",
      (f) => {
        f.finalListener.passId = "owned-pass";
      },
    ],
    [
      "listenerJobReleased",
      (f) => {
        f.finalListener.jobId = "owned-job";
      },
    ],
    [
      "connectionUnchanged",
      (f) => {
        f.finalListener.connectionId = "new-connection";
      },
    ],
    [
      "registrationUnchanged",
      (f) => {
        f.finalListener.registration.nativeStatus.timing = "OTHER";
      },
    ],
    [
      "bindingUnchanged",
      (f) => {
        f.afterBinding[0].enabled = false;
      },
    ],
  ])(
    "still rejects and names %s without weakening any sibling check",
    (name, change) => {
      const f = fixture();
      change(f);
      const result = inspect(f);
      expect(result.passed).toBe(false);
      expect(result.failedChecks).toEqual([name]);
      expect(
        Object.entries(result.checks).filter(([, passed]) => !passed),
      ).toEqual([[name, false]]);
    },
  );
  it("names exact scalar paths for recording, registration and immutable binding changes", () => {
    const f = fixture();
    f.finalInspection.transport.recording.recordMode = true;
    f.finalListener.registration.nativeStatus.timing = "OTHER";
    f.afterBinding[0].enabled = false;
    const result = inspect(f);
    expect(result.differences.map((d) => d.path)).toEqual(
      expect.arrayContaining([
        "transport.recording.recordMode",
        "listener.registration.nativeStatus.timing",
        "inspection.0.enabled",
      ]),
    );
    expect(
      result.differences.find((d) => d.path === "inspection.0.enabled"),
    ).toMatchObject({
      before: { type: "boolean", value: true },
      after: { type: "boolean", value: false },
    });
  });
  it("reports a missing listener distinctly and preserves undefined versus null release semantics", () => {
    const f = fixture();
    f.finalListener = undefined;
    expect(inspect(f).failedChecks).toContain("listenerIdle");
    const g = fixture();
    g.finalListener.passId = null;
    expect(inspect(g).failedChecks).toContain("listenerPassReleased");
  });
  it("bounds redacted differences and omits structured bodies while retaining hashes", () => {
    const f = fixture();
    const credential = `ghp_${"a".repeat(40)}`;
    f.listener.registration.description = credential;
    f.finalListener.registration.description = `changed ${credential}`;
    f.beforeBinding = [
      { parameters: Array.from({ length: 64 }, (_, i) => ({ value: i })) },
    ];
    f.afterBinding = [
      { parameters: Array.from({ length: 64 }, (_, i) => ({ value: i + 1 })) },
    ];
    const result = inspect(f);
    expect(JSON.stringify(result)).not.toContain(credential);
    expect(result.differences).toHaveLength(8);
    expect(result.differencesTruncated).toBe(true);
    expect(result.before.registration).toMatchObject({
      type: "object",
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(result.before)).not.toContain("parameters");
    expect(JSON.stringify(result).length).toBeLessThan(12000);
  });
});
