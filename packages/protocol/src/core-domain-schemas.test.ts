import { describe, expect, it } from "vitest";

import { commandCatalog } from "./catalog.js";
import {
  audioClipsOperationParamsSchema,
  midiNotesOperationParamsSchema,
  mixerRoutingOperationParamsSchema,
  scenesOperationParamsSchema,
  tracksOperationParamsSchema,
  transportOperationParamsSchema,
} from "./core-domain-schemas.js";

const track = {
  kind: "regular" as const,
  index: 0,
  expectedReference: "00000000-0000-4000-8000-000000000001",
  expectedName: "Drums",
};
const clip = {
  view: "session" as const,
  track,
  sceneIndex: 0,
  expectedClipReference: "00000000-0000-4000-8000-000000000002",
  expectedClipName: "Beat",
};

describe("Live 11 core domain schemas", () => {
  it("keeps read and mutation commands distinct for project invalidation", () => {
    for (const domain of [
      "scenes",
      "tracks",
      "mixer_routing",
      "transport",
      "midi_notes",
      "audio_clips",
    ]) {
      expect(
        commandCatalog[`${domain}.inspect` as keyof typeof commandCatalog]
          .mutates,
      ).toBe(false);
      expect(
        commandCatalog[`${domain}.mutate` as keyof typeof commandCatalog]
          .mutates,
      ).toBe(true);
    }
  });

  it("accepts strict scene, track, mixer, and transport variants", () => {
    expect(
      scenesOperationParamsSchema.parse({
        action: "set-tempo-time-signature",
        target: {
          index: 0,
          expectedReference: "00000000-0000-4000-8000-000000000010",
          expectedName: "Verse",
        },
        state: { kind: "tempo", tempo: 126, enabled: true },
      }).action,
    ).toBe("set-tempo-time-signature");
    expect(
      tracksOperationParamsSchema.parse({
        action: "set-monitoring",
        target: track,
        monitoringState: 2,
      }).action,
    ).toBe("set-monitoring");
    expect(
      mixerRoutingOperationParamsSchema.parse({
        action: "set-routing",
        target: track,
        direction: "output-type",
        snapshotId: "00000000-0000-4000-8000-000000000020",
        optionToken: "00000000-0000-4000-8000-000000000021",
        expectedDisplayName: "Ext. Out",
      }).action,
    ).toBe("set-routing");
    expect(
      mixerRoutingOperationParamsSchema.safeParse({
        action: "set-master-crossfader",
        value: {
          target: track,
          expectedParameterReference: "00000000-0000-4000-8000-000000000022",
          expectedParameterName: "Crossfader",
          normalizedValue: 0.5,
        },
      }).success,
    ).toBe(false);
    expect(
      transportOperationParamsSchema.parse({
        action: "set-time-signature",
        numerator: 7,
        denominator: 8,
      }).action,
    ).toBe("set-time-signature");
  });

  it("enforces Live 11 quantization and pitch domains", () => {
    expect(
      transportOperationParamsSchema.safeParse({
        action: "set-launch-quantization",
        quantization: 13,
      }).success,
    ).toBe(true);
    expect(
      transportOperationParamsSchema.safeParse({
        action: "set-launch-quantization",
        quantization: 14,
      }).success,
    ).toBe(false);
    expect(
      transportOperationParamsSchema.safeParse({
        action: "set-record-quantization",
        quantization: 8,
      }).success,
    ).toBe(true);
    expect(
      transportOperationParamsSchema.safeParse({
        action: "set-record-quantization",
        quantization: 9,
      }).success,
    ).toBe(false);
    expect(
      audioClipsOperationParamsSchema.safeParse({
        action: "set-pitch",
        target: clip,
        coarse: 0,
        fine: 49,
      }).success,
    ).toBe(true);
    expect(
      audioClipsOperationParamsSchema.safeParse({
        action: "set-pitch",
        target: clip,
        coarse: 0,
        fine: 50,
      }).success,
    ).toBe(false);
  });

  it("models modern note properties without per-note expression", () => {
    const parsed = midiNotesOperationParamsSchema.parse({
      action: "add",
      target: clip,
      notes: [
        {
          pitch: 36,
          startTime: 0,
          duration: 0.25,
          velocity: 110.5,
          mute: false,
          probability: 0.75,
          velocityDeviation: -4.5,
          releaseVelocity: 80.5,
        },
      ],
    });
    expect(parsed.action).toBe("add");
    if (parsed.action !== "add") throw new Error("Expected add action");
    expect(parsed.notes[0]).toMatchObject({
      probability: 0.75,
      velocity: 110.5,
      velocityDeviation: -4.5,
      releaseVelocity: 80.5,
    });
    expect(
      midiNotesOperationParamsSchema.safeParse({
        action: "add",
        target: clip,
        notes: [
          {
            pitch: 36,
            startTime: 0,
            duration: 0.25,
            velocity: 0,
            mute: true,
            probability: 1,
            velocityDeviation: 0.5,
            releaseVelocity: 64.5,
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      midiNotesOperationParamsSchema.safeParse({
        ...parsed,
        expression: { pressure: 0.5 },
      }).success,
    ).toBe(false);
  });

  it("allows warp-marker reads but no warp-marker mutation action", () => {
    expect(
      audioClipsOperationParamsSchema.parse({
        action: "warp-markers",
        target: clip,
        offset: 0,
        limit: 32,
      }).action,
    ).toBe("warp-markers");
    expect(
      audioClipsOperationParamsSchema.safeParse({
        action: "set-warp-marker",
        target: clip,
        beatTime: 1,
        sampleTime: 44100,
      }).success,
    ).toBe(false);
  });

  it("requires an inspected available warp-mode selection", () => {
    expect(
      audioClipsOperationParamsSchema.safeParse({
        action: "set-warp-mode",
        target: clip,
        warpMode: 4,
        expectedAvailableWarpModes: [0, 1, 2, 3, 4, 6],
      }).success,
    ).toBe(true);
    expect(
      audioClipsOperationParamsSchema.safeParse({
        action: "set-warp-mode",
        target: clip,
        warpMode: 5,
        expectedAvailableWarpModes: [0, 1, 2, 3, 4, 6],
      }).success,
    ).toBe(false);
    expect(
      audioClipsOperationParamsSchema.safeParse({
        action: "set-warp-mode",
        target: clip,
        warpMode: 7,
        expectedAvailableWarpModes: [0, 1, 2, 3, 4, 6],
      }).success,
    ).toBe(false);
  });
});
