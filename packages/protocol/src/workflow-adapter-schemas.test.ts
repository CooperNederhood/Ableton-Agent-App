import { describe, expect, it } from "vitest";

import { PROTOCOL_VERSION } from "./constants.js";
import {
  browserAdapterOperationParamsSchema,
  clipAutomationOperationParamsSchema,
  liveHistoryOperationParamsSchema,
  recordingCommandParamsSchema,
  recordingOperationParamsSchema,
  warpMarkerOperationParamsSchema,
  workflowJobLifecyclePayloadSchema,
} from "./workflow-adapter-schemas.js";
import {
  capabilityDocumentSchema,
  curatedLiveStateChangedEnvelopeSchema,
} from "./schemas.js";

const track = {
  kind: "regular" as const,
  index: 0,
  expectedReference: "11111111-1111-4111-8111-111111111111",
  expectedName: "Track",
};
const clip = {
  view: "session" as const,
  track,
  sceneIndex: 0,
  expectedClipReference: "22222222-2222-4222-8222-222222222222",
  expectedClipName: "Clip",
};

describe("workflow adapter schemas", () => {
  it("keeps launch distinct from exact empty-slot recording intent", () => {
    expect(
      recordingOperationParamsSchema.parse({
        action: "record-session-slot",
        target: {
          track,
          sceneIndex: 1,
          expectedSceneReference: "55555555-5555-4555-8555-555555555555",
          expectedSceneName: "Verse",
          expectedHasClip: false,
        },
        durationBeats: 8,
      }).action,
    ).toBe("record-session-slot");
    expect(
      recordingOperationParamsSchema.safeParse({
        action: "record-session-slot",
        target: {
          track,
          sceneIndex: 1,
          expectedSceneReference: "55555555-5555-4555-8555-555555555555",
          expectedSceneName: "Verse",
          expectedHasClip: true,
        },
        durationBeats: 8,
      }).success,
    ).toBe(false);
    expect(
      recordingOperationParamsSchema.safeParse({
        action: "record-session-slot",
        target: {
          track,
          sceneIndex: 1,
          expectedSceneReference: "55555555-5555-4555-8555-555555555555",
          expectedSceneName: "Verse",
          expectedHasClip: false,
        },
        durationBeats: 8,
        correlationId: "model-controlled",
        traceId: "model-controlled",
      }).success,
    ).toBe(false);
    expect(
      recordingCommandParamsSchema.safeParse({
        action: "record-session-slot",
        target: {
          track,
          sceneIndex: 1,
          expectedSceneReference: "55555555-5555-4555-8555-555555555555",
          expectedSceneName: "Verse",
          expectedHasClip: false,
        },
        durationBeats: 8,
        runtimeContext: {
          ownerId: "agent-a",
          correlationId: "turn-a",
          causationId: "tool-a",
          traceId: "trace-a",
          trackReferences: [track.expectedReference],
        },
      }).success,
    ).toBe(true);
  });

  it("requires explicit global-history confirmation", () => {
    expect(
      liveHistoryOperationParamsSchema.safeParse({ action: "undo" }).success,
    ).toBe(false);
    expect(
      liveHistoryOperationParamsSchema.parse({
        action: "undo",
        confirmation: "global-live-history",
      }).action,
    ).toBe("undo");
  });

  it("rejects direct Arrangement automation", () => {
    expect(
      clipAutomationOperationParamsSchema.safeParse({
        action: "list-envelopes",
        target: { ...clip, view: "arrangement", expectedStartTime: 0 },
      }).success,
    ).toBe(false);
  });

  it("bounds and orders warp marker changes", () => {
    expect(
      warpMarkerOperationParamsSchema.safeParse({
        action: "add",
        target: clip,
        snapshotRevision: "0123456789abcdef",
        marker: { beatTime: 1, sampleTime: 44100 },
      }).success,
    ).toBe(true);
    expect(
      warpMarkerOperationParamsSchema.safeParse({
        action: "add",
        target: clip,
        snapshotRevision: "0123456789abcdef",
        marker: { beatTime: 1, sampleTime: 44100, segmentBpm: 120 },
      }).success,
    ).toBe(false);
  });

  it("requires complete Browser identity rather than arbitrary paths", () => {
    expect(
      browserAdapterOperationParamsSchema.safeParse({
        action: "preview",
        expectedItemReference: "55555555-5555-4555-8555-555555555555",
        expectedItemRoot: "sounds",
        expectedItemPath: [{ index: 0, name: "Bass" }],
        expectedItemName: "Bass",
        expectedItemUri: "ableton://sounds/bass",
      }).success,
    ).toBe(true);
    expect(
      browserAdapterOperationParamsSchema.safeParse({
        action: "preview",
        path: "/Users/example/file.wav",
      }).success,
    ).toBe(false);
  });

  it("bounds curated state and job lifecycle events", () => {
    expect(
      curatedLiveStateChangedEnvelopeSchema.parse({
        protocolVersion: PROTOCOL_VERSION,
        kind: "event",
        event: "live_state.changed",
        sequence: 1,
        payload: {
          phase: "update",
          observedAt: "2026-01-01T00:00:00.000Z",
          projectRevision: 2,
          entry: {
            topic: "meters",
            state: {
              samples: [
                {
                  trackReference: "11111111-1111-4111-8111-111111111111",
                  left: 0.25,
                  right: 0.5,
                },
              ],
            },
          },
        },
      }).payload.entry.topic,
    ).toBe("meters");
    expect(
      workflowJobLifecyclePayloadSchema.safeParse({
        jobId: "22222222-2222-4222-8222-222222222222",
        kind: "timed-session-recording",
        status: "progress",
        progress: 2,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        correlationId: "33333333-3333-4333-8333-333333333333",
        traceId: "44444444-4444-4444-8444-444444444444",
      }).success,
    ).toBe(false);
  });

  it("accepts additive evidence-backed capability details", () => {
    expect(
      capabilityDocumentSchema.parse({
        selectedProtocolVersion: PROTOCOL_VERSION,
        liveVersion: "11.3",
        remoteScriptVersion: "0.1.0",
        projectId: "project",
        capabilities: { "browser_adapters.hot_swap": false },
        capabilityDetails: {
          "browser_adapters.hot_swap": {
            supported: false,
            evidence: "private_detected_untested",
            minimumLiveVersion: "11.0",
            testedLiveVersions: [],
            limitations: [
              "Disabled until this exact Live 11 build passes validation.",
            ],
          },
        },
        limits: { maxFrameBytes: 1024, maxBatchItems: 16 },
      }).capabilityDetails?.["browser_adapters.hot_swap"]?.evidence,
    ).toBe("private_detected_untested");
  });
});
