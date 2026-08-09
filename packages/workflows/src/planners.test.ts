import { describe, expect, it } from "vitest";

import type { EntityReference } from "@ableton-agent/project-state";

import {
  WorkflowValidationError,
  planChordProgression,
  planDrumPattern,
  planMixChangeSet,
  planPresetAudition,
  planSongSection,
  type PlannerIdentity,
} from "./index.js";

const identity: PlannerIdentity = {
  id: "workflow-1",
  projectId: "project-1",
  sessionId: "session-1",
  correlationId: "correlation-1",
  resource: "project-1",
  intent: "make music",
};

function track(
  id = "track-1",
  kind: EntityReference["kind"] = "track",
): EntityReference {
  return { projectId: "project-1", kind, id, revision: 1 };
}

describe("deterministic musical planners", () => {
  it("plans practical, sorted drum notes without performing I/O", () => {
    const input = {
      ...identity,
      track: track(),
      sceneIndex: 0,
      name: "Four on the floor",
      bars: 1,
      lanes: [
        { pitch: 38, steps: [4, 12], velocity: 96 },
        { pitch: 36, steps: [0, 8], velocity: 110 },
      ],
    };
    const first = planDrumPattern(input);
    const second = planDrumPattern(input);

    expect(first).toEqual(second);
    expect(first.workflow).toBe("drum-pattern");
    expect(first.steps.map((step) => step.operation)).toEqual([
      "clip.create-session-midi",
      "clip.replace-session-midi-notes",
    ]);
    const payload = first.steps[1]?.payload;
    expect(
      payload !== undefined && "notes" in payload
        ? payload.notes.map((note) => [note.startTime, note.pitch])
        : [],
    ).toEqual([
      [0, 36],
      [1, 38],
      [2, 36],
      [3, 38],
    ]);
  });

  it("plans deterministic chord voicings and validates their pitch range", () => {
    const result = planChordProgression({
      ...identity,
      track: track(),
      sceneIndex: 1,
      name: "Progression",
      chords: [
        { root: 60, quality: "minor", beats: 2 },
        { root: 65, quality: "major", beats: 2 },
      ],
    });
    const payload = result.steps[1]?.payload;
    expect(
      payload !== undefined && "notes" in payload
        ? payload.notes.map((note) => note.pitch)
        : [],
    ).toEqual([60, 63, 67, 65, 69, 72]);
    expect(() =>
      planChordProgression({
        ...identity,
        track: track(),
        sceneIndex: 1,
        name: "Invalid",
        chords: [{ root: 124, quality: "major", beats: 4 }],
      }),
    ).toThrow("pitch");
  });

  it("plans song-section creation and variation with ordered dependencies", () => {
    const created = planSongSection({
      ...identity,
      name: "Chorus",
      destinationTime: 32,
      length: 8,
      clips: [
        {
          sourceTrack: track("drums"),
          sceneIndex: 2,
          expectedClipId: "clip-a",
        },
        { sourceTrack: track("bass"), sceneIndex: 2, expectedClipId: "clip-b" },
      ],
    });
    expect(created.workflow).toBe("song-section-create");
    expect(created.steps).toHaveLength(2);

    const varied = planSongSection({
      ...identity,
      name: "Chorus",
      destinationTime: 64,
      length: 8,
      clips: [
        {
          sourceTrack: track("drums"),
          sceneIndex: 2,
          expectedClipId: "clip-a",
        },
      ],
      variation: { nameSuffix: "B", loopStart: 0, loopEnd: 4 },
    });
    expect(varied.workflow).toBe("song-section-variation");
    expect(varied.steps[1]?.dependencies).toEqual(["step-001-duplicate"]);
  });

  it("plans bounded mixer changes with only requested values", () => {
    const result = planMixChangeSet({
      ...identity,
      changes: [
        { track: track("bass"), volume: 0.7, pan: -0.1 },
        { track: track("fx", "return-track"), sends: [0.25, 0.5] },
      ],
    });
    expect(result.workflow).toBe("mix-change-set");
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]?.reversibility.kind).toBe("reversible");
    expect(result.steps[0]?.payload).toMatchObject({
      volume: 0.7,
      pan: -0.1,
    });
  });

  it("marks preset audition loads explicitly non-reversible and sequential", () => {
    const result = planPresetAudition({
      ...identity,
      track: track(),
      candidates: [
        { browserItemId: "preset-a", expectedName: "Warm Pad" },
        { browserItemId: "preset-b", expectedName: "Bright Pad" },
      ],
    });
    expect(result.steps[0]?.reversibility.kind).toBe("non-reversible");
    expect(result.steps[1]?.dependencies).toEqual(["step-001-preset"]);
  });

  it("enforces mutation budgets and invalid planner inputs", () => {
    expect(() =>
      planMixChangeSet({
        ...identity,
        maxMutations: 1,
        changes: [
          { track: track("one"), volume: 0.5 },
          { track: track("two"), volume: 0.5 },
        ],
      }),
    ).toThrow("budget");
    expect(() =>
      planDrumPattern({
        ...identity,
        track: track(),
        sceneIndex: 0,
        name: "Bad",
        bars: 1,
        lanes: [{ pitch: 128, steps: [0] }],
      }),
    ).toThrow(WorkflowValidationError);
    expect(() =>
      planSongSection({
        ...identity,
        name: "Bad",
        destinationTime: 0,
        length: 4,
        clips: [],
      }),
    ).toThrow("1 to 32");
    expect(() =>
      planMixChangeSet({
        ...identity,
        changes: [{ track: track(), volume: 1.1 }],
      }),
    ).toThrow("volume");
    expect(() =>
      planPresetAudition({
        ...identity,
        track: track(),
        candidates: [],
      }),
    ).toThrow("1 to 8");
    expect(() =>
      planMixChangeSet({
        ...identity,
        changes: [
          {
            track: { ...track(), projectId: "different-project" },
            volume: 0.5,
          },
        ],
      }),
    ).toThrow("different project");
    expect(() =>
      planSongSection({
        ...identity,
        name: "A".repeat(120),
        destinationTime: 0,
        length: 4,
        clips: [
          {
            sourceTrack: track(),
            sceneIndex: 0,
            expectedClipId: "clip-a",
          },
        ],
        variation: { nameSuffix: "B".repeat(16) },
      }),
    ).toThrow("name is too long");
  });
});
