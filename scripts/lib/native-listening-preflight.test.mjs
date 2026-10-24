import { describe, expect, it } from "vitest";
import { sanitizePersistedText } from "@ableton-agent/observability";
import { inspectNativeStoppedPreflight } from "./native-listening-verification.mjs";

function fixture() {
  const input = {
    canonicalPath: "live_set tracks 0 devices 1",
    trackName: "MIDI",
    deviceName: "Listener",
  };
  return {
    input,
    session: true,
    nativeVersion: 3,
    limits: { maxClips: 32, maxParameters: 16 },
    inspected: {
      transport: {
        playing: false,
        currentBeat: 8,
        tempo: 120,
        safeToStart: true,
        recording: {
          recordMode: false,
          sessionRecord: false,
          arrangementOverdub: false,
          sessionAutomationRecord: false,
        },
      },
      listeners: [
        {
          enabled: true,
          sessionOverride: false,
          canonicalPath: input.canonicalPath,
          pathAttestation: { canonicalDevicePath: input.canonicalPath },
          binding: {
            track: {
              index: 0,
              expectedReference: "track-reference",
              expectedName: input.trackName,
            },
            deviceIndex: 1,
            expectedDeviceReference: "device-reference",
            expectedDeviceName: input.deviceName,
            expectedClassName: "MxDeviceAudioEffect",
          },
          clipsTruncated: false,
          dependenciesTruncated: true,
          fingerprint: {
            completeness: "unknown",
            unknownReasons: ["upstream-parameters-truncated"],
          },
          attribution: "nonexclusive",
          unknownReasons: ["upstream-parameters-truncated"],
          upstreamDevices: [
            { name: "Operator", parameters: Array(16).fill({ value: 1 }) },
          ],
        },
      ],
    },
  };
}
const inspect = (value) =>
  inspectNativeStoppedPreflight(value, sanitizePersistedText);

describe("native stopped preflight evidence", () => {
  it("retains incomplete unknown/nonexclusive quality for Session, without changing limits", () => {
    expect(inspect(fixture())).toMatchObject({
      passed: true,
      failedChecks: [],
      mode: "session",
      limits: { maxClips: 32, maxParameters: 16 },
      target: { dependenciesTruncated: true, deviceIndex: 1 },
      quality: {
        dependencyRequirement: "descriptive-only",
        dependencyCompleteness: "incomplete",
        fingerprintCompleteness: "unknown",
        attribution: "nonexclusive",
        unknownReasons: ["upstream-parameters-truncated"],
      },
    });
  });
  it.each([1, 2])(
    "keeps native v%s Arrangement dependency completeness mandatory",
    (nativeVersion) => {
      const f = fixture();
      f.nativeVersion = nativeVersion;
      f.session = false;
      f.inspected.transport.currentBeat = 0;
      expect(inspect(f)).toMatchObject({
        passed: false,
        failedChecks: ["dependenciesComplete"],
        quality: { dependencyRequirement: "complete-required" },
      });
      f.inspected.listeners[0].dependenciesTruncated = false;
      expect(inspect(f).passed).toBe(true);
    },
  );
  it("retains strict v1 beat-zero and Arrangement source checks", () => {
    const f = fixture();
    f.session = false;
    f.nativeVersion = 1;
    f.inspected.listeners[0].dependenciesTruncated = false;
    f.inspected.listeners[0].sessionOverride = true;
    expect(inspect(f).failedChecks).toEqual([
      "legacyBeatZero",
      "arrangementSource",
    ]);
  });
  it.each([
    [
      "transportStopped",
      (f) => {
        f.inspected.transport.playing = true;
      },
    ],
    [
      "tempo120",
      (f) => {
        f.inspected.transport.tempo = 121;
      },
    ],
    [
      "safeToStart",
      (f) => {
        f.inspected.transport.safeToStart = false;
      },
    ],
    [
      "recordModeOff",
      (f) => {
        f.inspected.transport.recording.recordMode = true;
      },
    ],
    [
      "sessionRecordOff",
      (f) => {
        f.inspected.transport.recording.sessionRecord = null;
      },
    ],
    [
      "arrangementOverdubOff",
      (f) => {
        f.inspected.transport.recording.arrangementOverdub = true;
      },
    ],
    [
      "sessionAutomationRecordOff",
      (f) => {
        delete f.inspected.transport.recording.sessionAutomationRecord;
      },
    ],
    [
      "exactListenerCount",
      (f) => {
        f.inspected.listeners.push(f.inspected.listeners[0]);
      },
    ],
    [
      "listenerEnabled",
      (f) => {
        f.inspected.listeners[0].enabled = null;
      },
    ],
    [
      "canonicalDevicePath",
      (f) => {
        f.inspected.listeners[0].pathAttestation.canonicalDevicePath =
          "live_set tracks 1 devices 1";
      },
    ],
    [
      "trackName",
      (f) => {
        f.inspected.listeners[0].binding.track.expectedName = "replaced";
      },
    ],
    [
      "deviceName",
      (f) => {
        f.inspected.listeners[0].binding.expectedDeviceName = "replaced";
      },
    ],
    [
      "clipsComplete",
      (f) => {
        f.inspected.listeners[0].clipsTruncated = true;
      },
    ],
  ])(
    "names the precise failed Session guard %s despite incomplete dependencies",
    (guard, mutate) => {
      const f = fixture();
      mutate(f);
      const result = inspect(f);
      expect(result).toMatchObject({
        passed: false,
        failedChecks: [guard],
        checks: { [guard]: false },
      });
      expect(result.quality.dependencyCompleteness).toBe("incomplete");
    },
  );
  it("fails closed on an absent target or empty recording evidence rather than throwing away diagnostics", () => {
    const f = fixture();
    f.inspected.listeners = [];
    f.inspected.transport.recording = {};
    const result = inspect(f);
    expect(result.passed).toBe(false);
    expect(result.failedChecks).toEqual(
      expect.arrayContaining([
        "exactListenerCount",
        "listenerEnabled",
        "recordModeOff",
        "sessionRecordOff",
        "arrangementOverdubOff",
        "sessionAutomationRecordOff",
      ]),
    );
    expect(result.target.deviceReference).toBeNull();
    expect(result.transport.recording.recordMode).toBeNull();
  });
  it("bounds/redacts every persisted string and omits unapproved response/audio bodies without mutating the inspected response", () => {
    const f = fixture();
    const target = f.inspected.listeners[0];
    target.binding.expectedDeviceName = `token=unit-private ${"x".repeat(10000)}`;
    target.binding.track.expectedReference = "password=unit-password";
    target.unknownReasons = Array(100).fill(
      `api_key=unit-key ${"y".repeat(10000)}`,
    );
    target.fingerprint.unknownReasons = ["Bearer unit-bearer-value"];
    target.audioBody = "raw-audio-must-not-persist";
    f.inspected.transport.responseBody = "raw-response-must-not-persist";
    const original = globalThis.structuredClone(f);
    const result = inspect(f);
    const json = JSON.stringify(result);
    for (const value of [
      "unit-private",
      "unit-password",
      "unit-key",
      "unit-bearer-value",
      "raw-audio-must-not-persist",
      "raw-response-must-not-persist",
    ])
      expect(json).not.toContain(value);
    expect(json).toContain("[REDACTED]");
    expect(json.length).toBeLessThan(10000);
    expect(result.target.deviceName.length).toBeLessThanOrEqual(128);
    expect(result.quality.unknownReasons).toHaveLength(8);
    expect(f).toEqual(original);
  });
});
