import { describe, expect, it } from "vitest";
import {
  inspectListeningContextParamsSchema,
  inspectListeningContextResultSchema,
  positionListeningPlaybackParamsSchema,
  positionListeningPlaybackResultSchema,
  listeningDependencyFingerprintSchema,
  listeningCanonicalDevicePathSchema,
  listeningPathAttestationSchema,
  startListeningPlaybackParamsSchema,
  startListeningPlaybackResultSchema,
  stopListeningPlaybackParamsSchema,
  stopListeningPlaybackResultSchema,
  listenerNativeStatusSchema,
} from "./listening-live-schemas.js";

const listener = {
  track: {
    kind: "regular" as const,
    index: 0,
    expectedReference: "00000000-0000-4000-8000-000000000001",
    expectedName: "Audio",
  },
  deviceIndex: 0,
  expectedDeviceReference: "00000000-0000-4000-8000-000000000002",
  expectedDeviceName: "Listener",
  expectedClassName: "MxDeviceAudioEffect",
};
const params = {
  schemaVersion: 1,
  listeners: [listener],
  range: { startBeat: 0, endBeat: 8 },
};

describe("bounded listening Live contracts", () => {
  it("requires independently matching stopped Arrangement positioning without onset authority", () => {
    const request = {
      schemaVersion: 1,
      mode: "arrangement",
      ownerId: "session",
      passId: listener.expectedDeviceReference,
      expectedLiveSetId: "set",
      expectedProjectRevision: 0,
      listeners: [listener],
      range: { startBeat: 5.25, endBeat: 9.5 },
    };
    expect(positionListeningPlaybackParamsSchema.parse(request)).toEqual(
      request,
    );
    for (const change of [
      { mode: "session" },
      { schemaVersion: 2 },
      { listeners: [listener, listener] },
      { range: { startBeat: 5.25, endBeat: 5.25 } },
      { stopAfterPosition: true },
    ])
      expect(
        positionListeningPlaybackParamsSchema.safeParse({
          ...request,
          ...change,
        }).success,
      ).toBe(false);
    const result = {
      schemaVersion: 1,
      mode: "arrangement",
      cleanupPolicy: "leave-running",
      sourceOnset: "unverified",
      requestedStartBeat: 5.25,
      insertMarkerBeat: 5.25,
      currentBeat: 5.25,
      playing: false,
      changed: { insertMarker: true, currentPosition: true },
    };
    expect(positionListeningPlaybackResultSchema.parse(result)).toEqual(result);
    for (const change of [
      { playing: true },
      { insertMarkerBeat: 5 },
      { currentBeat: 5 },
      { sourceOnset: "verified" },
      { ownership: "owned" },
      { changed: { insertMarker: true } },
    ])
      expect(
        positionListeningPlaybackResultSchema.safeParse({
          ...result,
          ...change,
        }).success,
      ).toBe(false);
  });
  it("retains explicit unverified native diagnostics and requires a bounded reason", () => {
    const status = {
      version: 1,
      timing: "UNVERIFIED",
      readiness: "BLOCKED",
      reason: "real_live_timing_validation_required",
    };
    expect(listenerNativeStatusSchema.parse(status)).toEqual(status);
    expect(
      listenerNativeStatusSchema.safeParse({ ...status, reason: undefined })
        .success,
    ).toBe(false);
    expect(
      listenerNativeStatusSchema.safeParse({
        ...status,
        reason: "x".repeat(129),
      }).success,
    ).toBe(false);
  });
  it("bounds prospective playback identities and never labels acknowledgement as verified onset", () => {
    const start = {
      schemaVersion: 1,
      mode: "arrangement",
      ownerId: "session",
      passId: listener.expectedDeviceReference,
      expectedLiveSetId: "set",
      expectedProjectRevision: 0,
      listeners: [listener],
      range: { startBeat: 0, endBeat: 8 },
    };
    expect(startListeningPlaybackParamsSchema.safeParse(start).success).toBe(
      true,
    );
    for (const change of [
      { schemaVersion: 2 },
      { schemaVersion: true },
      { ownerId: " " },
      { listeners: [] },
      { listeners: [listener, listener] },
      { range: { startBeat: 8, endBeat: 8 } },
      { mode: "session" },
      { expectedProjectRevision: -1 },
    ])
      expect(
        startListeningPlaybackParamsSchema.safeParse({ ...start, ...change })
          .success,
      ).toBe(false);
    const ownership = {
      ownerId: "session",
      passId: listener.expectedDeviceReference,
      generation: listener.track.expectedReference,
      liveSetId: "set",
    };
    expect(
      stopListeningPlaybackParamsSchema.safeParse({
        schemaVersion: 1,
        ownership,
      }).success,
    ).toBe(true);
    expect(
      stopListeningPlaybackParamsSchema.safeParse({
        schemaVersion: 1,
        ownership: { ...ownership, generation: "Max-ID-123" },
      }).success,
    ).toBe(false);
    expect(
      startListeningPlaybackResultSchema.safeParse({
        schemaVersion: 1,
        mode: "arrangement",
        cleanupPolicy: "leave-running",
        startedAtBeat: 0,
        sourceOnset: "unverified",
      }).success,
    ).toBe(true);
    expect(
      startListeningPlaybackResultSchema.safeParse({
        schemaVersion: 1,
        mode: "arrangement",
        cleanupPolicy: "leave-running",
        startedAtBeat: 0,
        sourceOnset: "unverified",
        ownership,
      }).success,
    ).toBe(false);
    expect(
      startListeningPlaybackResultSchema.safeParse({
        schemaVersion: 1,
        mode: "arrangement",
        ownership,
        startedAtBeat: 0,
        sourceOnset: "verified",
      }).success,
    ).toBe(false);
    expect(
      stopListeningPlaybackResultSchema.safeParse({
        schemaVersion: 1,
        ownership: "lost",
        stopped: true,
      }).success,
    ).toBe(false);
  });
  it("accepts bounded canonical selectors and recognizes unsupported nesting without arbitrary property paths", () => {
    for (const canonicalPath of [
      "live_set tracks 0 devices 1",
      "live_set return_tracks 0 devices 1",
      "live_set master_track devices 1",
      "live_set tracks 0 devices 1 chains 0 devices 0",
    ]) {
      expect(
        inspectListeningContextParamsSchema.safeParse({
          ...params,
          bindingQueryId: listener.track.expectedReference,
          listeners: [{ canonicalPath }],
        }).success,
      ).toBe(true);
    }
    for (const canonicalPath of [
      "live_set this_device",
      "live_set tracks 00 devices 1",
      "live_set tracks 0 devices 1 parameters 0",
      "live_set tracks 0 devices 1 ",
      "/arbitrary/file",
    ]) {
      expect(
        inspectListeningContextParamsSchema.safeParse({
          ...params,
          listeners: [{ canonicalPath }],
        }).success,
      ).toBe(false);
    }
    for (const canonicalPath of [
      "live_set tracks 256 devices 0",
      "live_set tracks 0 devices 32",
      "live_set tracks 0 devices 0 chains 0 devices 0",
    ])
      expect(
        listeningCanonicalDevicePathSchema.safeParse(canonicalPath).success,
      ).toBe(false);
  });
  it("validates independent attestation versions and exact placement", () => {
    const attestation = {
      schemaVersion: 1,
      source: "remote-script-lom",
      canonicalDevicePath: "live_set tracks 0 devices 0",
      canonicalTrackPath: "live_set tracks 0",
      trackReference: listener.track.expectedReference,
      deviceReference: listener.expectedDeviceReference,
      placement: { kind: "track-device", deviceIndex: 0 },
    };
    expect(listeningPathAttestationSchema.safeParse(attestation).success).toBe(
      true,
    );
    for (const change of [
      { schemaVersion: 2 },
      { source: "producer-claim" },
      { canonicalTrackPath: "live_set master_track" },
      { deviceReference: "12345" },
      { placement: { kind: "track-device", deviceIndex: 1 } },
    ])
      expect(
        listeningPathAttestationSchema.safeParse({ ...attestation, ...change })
          .success,
      ).toBe(false);
  });
  it("accepts exact binding requests with bounded defaults", () => {
    expect(inspectListeningContextParamsSchema.parse(params)).toMatchObject({
      maxClips: 32,
      maxParameters: 16,
    });
  });
  it.each([
    { schemaVersion: 2 },
    { schemaVersion: true },
    { listeners: [] },
    { listeners: Array.from({ length: 9 }, () => listener) },
    { listeners: [listener, listener] },
    { maxClips: 65 },
    { maxParameters: 33 },
    { range: { startBeat: 8, endBeat: 8 } },
    { range: { startBeat: 0, endBeat: Infinity } },
    { path: "live_set tracks 0" },
    { property: "file_path" },
  ])("rejects unsafe/versioned/untyped requests %j", (change) => {
    expect(
      inspectListeningContextParamsSchema.safeParse({ ...params, ...change })
        .success,
    ).toBe(false);
  });
  it("rejects durable-looking or unverified fingerprint versions", () => {
    const fingerprint = {
      algorithm: "sha256",
      scope: "available-live-fields/v1",
      digest: "a".repeat(64),
      completeness: "unknown",
      unknownReasons: ["source-content-not-hashed"],
    };
    expect(
      listeningDependencyFingerprintSchema.safeParse(fingerprint).success,
    ).toBe(true);
    for (const change of [
      { scope: "source-content/v1" },
      { digest: "arbitrary-id" },
      { completeness: "complete" },
      { unknownReasons: Array.from({ length: 17 }, () => "unknown") },
    ]) {
      expect(
        listeningDependencyFingerprintSchema.safeParse({
          ...fingerprint,
          ...change,
        }).success,
      ).toBe(false);
    }
  });
  it("retains explicit unknown recording evidence and connection-local identity", () => {
    const fingerprint = {
      algorithm: "sha256",
      scope: "available-live-fields/v1",
      digest: "b".repeat(64),
      completeness: "unknown",
      unknownReasons: ["routing-dependencies-unverified"],
    };
    const result = {
      schemaVersion: 1,
      projectRevision: 0,
      bindingScope: "live-connection",
      transport: {
        playing: null,
        currentBeat: null,
        tempo: null,
        recording: {
          recordMode: null,
          sessionRecord: false,
          arrangementOverdub: false,
          sessionAutomationRecord: false,
        },
        safeToStart: false,
      },
      listeners: [
        {
          binding: listener,
          verified: true,
          canonicalPath: "live_set tracks 0 devices 0",
          enabled: null,
          sessionOverride: null,
          clips: [],
          clipsTruncated: false,
          trackEvidence: [],
          upstreamDevices: [],
          dependenciesTruncated: true,
          fingerprint,
          attribution: "nonexclusive",
          unknownReasons: ["routing-dependencies-unverified"],
        },
      ],
    };
    expect(inspectListeningContextResultSchema.safeParse(result).success).toBe(
      true,
    );
    expect(
      inspectListeningContextResultSchema.safeParse({
        ...result,
        transport: { ...result.transport, safeToStart: true },
      }).success,
    ).toBe(false);
    for (const interval of [
      { startBeat: 8, endBeat: 4 },
      { startBeat: 8, endBeat: 8 },
      { startBeat: 4, endBeat: 8 },
    ]) {
      expect(
        inspectListeningContextResultSchema.safeParse({
          ...result,
          listeners: [
            {
              ...result.listeners[0],
              clips: [
                {
                  target: {
                    view: "arrangement",
                    track: listener.track,
                    expectedClipReference:
                      "00000000-0000-4000-8000-000000000003",
                    expectedClipName: "Source",
                    expectedStartTime: 0,
                  },
                  interval,
                  activity: "unknown",
                  isAudioClip: true,
                  isRecording: false,
                  settings: [],
                  fingerprint,
                },
              ],
            },
          ],
        }).success,
      ).toBe(false);
    }
    expect(
      inspectListeningContextResultSchema.safeParse({
        ...result,
        bindingScope: "durable",
      }).success,
    ).toBe(false);
  });
});
