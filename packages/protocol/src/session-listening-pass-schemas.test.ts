import { describe, expect, it } from "vitest";
import { commandCatalog } from "./catalog.js";
import {
  sessionListeningPassParamsSchema,
  sessionListeningPassResultSchema,
} from "./session-listening-pass-schemas.js";

const ownerId = "10000000-0000-4000-8000-000000000001";
const passId = "10000000-0000-4000-8000-000000000002";
const track = {
  kind: "regular" as const,
  index: 0,
  expectedReference: ownerId,
  expectedName: "Track",
};
const prepare = {
  schemaVersion: 1,
  action: "prepare",
  ownerId,
  passId,
  expectedLiveSetId: "set",
  expectedProjectRevision: 0,
  target: {
    view: "session",
    track,
    sceneIndex: 0,
    expectedClipReference: passId,
    expectedClipName: "Source",
  },
  listener: {
    track,
    deviceIndex: 0,
    expectedDeviceReference: passId,
    expectedDeviceName: "Listener",
    expectedClassName: "MxDeviceAudioEffect",
  },
  durationBeats: 4,
  timingAnchor: { globalBeat: 12 },
};
const result = {
  schemaVersion: 1,
  ownerId,
  passId,
  status: "prepared",
  mutationState: "not-attempted",
  reason: null,
  cleanupPolicy: "leave-running",
  evidence: "message-rate-only",
  nativeAlignment: "unverified",
  lastObservedSource: {
    transportPlaying: false,
    globalBeat: 12,
    startTimeBeats: -4,
    playingPosition: 0,
    targetPlaying: false,
    targetTriggered: false,
    targetRecording: false,
    playingSlotIndex: -1,
    firedSlotIndex: -1,
    selectedClipReference: null,
  },
  sourceEpoch: null,
  followActionState: "unknown",
  limitations: [
    "Source monitoring is message-rate only; no guaranteed continuity.",
    "Unknown follow actions are not independently disabled.",
  ],
  durationBeats: 4,
  expiresInMs: 40_000,
};

describe("bounded Session pass authority", () => {
  it("classifies only the physical launch as a project mutation", () => {
    const entries = [
      ["listening.prepare_session_pass", "prepare", false],
      ["listening.launch_session_pass", "launch", true],
      ["listening.inspect_session_pass", "inspect", false],
      ["listening.release_session_pass", "release", false],
    ] as const;
    for (const [command, action, mutates] of entries) {
      const entry = commandCatalog[command as keyof typeof commandCatalog];
      expect(entry, command).toBeDefined();
      expect(entry.mutates).toBe(mutates);
      const params =
        action === "prepare"
          ? prepare
          : {
              schemaVersion: 1,
              action,
              ownerId,
              passId,
              ...(action === "release" ? { reason: "cancelled" } : {}),
            };
      expect(entry.params.safeParse(params).success).toBe(true);
      expect(
        entry.params.safeParse({
          ...params,
          action: action === "launch" ? "inspect" : "launch",
        }).success,
      ).toBe(false);
    }
    expect(commandCatalog).not.toHaveProperty("listening.session_pass");
  });

  it("accepts only exact prepare identities and bounded beat durations", () => {
    expect(sessionListeningPassParamsSchema.parse(prepare)).toEqual(prepare);
    for (const change of [
      { durationBeats: 4.01 },
      { durationBeats: 0 },
      { durationBeats: Number.NaN },
      { ownerId: "owner" },
      { target: { ...prepare.target, view: "arrangement" } },
      { target: { ...prepare.target, sceneIndex: 256 } },
      { listener: { ...prepare.listener, deviceIndex: 32 } },
      { listener: { ...prepare.listener, track: { ...track, index: 1 } } },
      { timingAnchor: { globalBeat: -1 } },
      { sourceEpoch: { startTimeBeats: 12 } },
      { nativeAlignment: "verified" },
      { audio: "body" },
    ]) {
      expect(
        sessionListeningPassParamsSchema.safeParse({ ...prepare, ...change })
          .success,
      ).toBe(false);
    }
  });

  it("strictly separates launch/inspect/release from preparation", () => {
    for (const action of ["launch", "inspect", "release"]) {
      const params = {
        schemaVersion: 1,
        action,
        ownerId,
        passId,
        ...(action === "release" ? { reason: "cancelled" } : {}),
      };
      expect(sessionListeningPassParamsSchema.safeParse(params).success).toBe(
        true,
      );
      expect(
        sessionListeningPassParamsSchema.safeParse({
          ...params,
          forceStop: true,
        }).success,
      ).toBe(false);
      expect(
        sessionListeningPassParamsSchema.safeParse({
          ...params,
          durationBeats: 1,
        }).success,
      ).toBe(false);
    }
  });

  it("cannot promote source monitoring into native/sample timing authority", () => {
    expect(sessionListeningPassResultSchema.parse(result)).toEqual(result);
    for (const change of [
      { nativeAlignment: "verified" },
      { cleanupPolicy: "stop" },
      { evidence: "sample-accurate" },
      { expiresInMs: 40_001 },
      { limitations: [] },
      { followActionState: "disabled" },
      { status: "playing" },
      { mutationState: "observed-playing" },
      { sourceEpoch: { startTimeBeats: 12 } },
      { audio: [0, 1] },
    ]) {
      expect(
        sessionListeningPassResultSchema.safeParse({ ...result, ...change })
          .success,
      ).toBe(false);
    }
    expect(
      sessionListeningPassResultSchema.safeParse({
        ...result,
        status: "playing",
        mutationState: "observed-playing",
        sourceEpoch: {
          startTimeBeats: 16,
          observedGlobalBeat: 16,
          clipReference: passId,
        },
      }).success,
    ).toBe(true);
  });
});
