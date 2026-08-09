import type {
  EntityReference,
  MetadataValue,
} from "@ableton-agent/project-state";

import {
  workflowLimits,
  WorkflowValidationError,
  type MidiNote,
  type WorkflowBudget,
  type WorkflowStep,
  type WorkflowTransaction,
} from "./types.js";

export interface PlannerIdentity {
  readonly id: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly correlationId: string;
  readonly resource: string;
  readonly intent: string;
  readonly maxMutations?: number;
  readonly maxDurationMs?: number;
}

export interface CreateSessionMidiClipPayload {
  readonly track: EntityReference;
  readonly sceneIndex: number;
  readonly length: number;
  readonly name: string;
}

export interface ReplaceSessionMidiNotesPayload {
  readonly track: EntityReference;
  readonly sceneIndex: number;
  readonly clipReferenceFromStep: string;
  readonly allowPerNoteExpressionLoss: false;
  readonly notes: readonly MidiNote[];
}

export interface DuplicateToArrangementPayload {
  readonly sourceTrack: EntityReference;
  readonly sceneIndex: number;
  readonly expectedClipId: string;
  readonly destinationTime: number;
}

export interface SetArrangementPropertiesPayload {
  readonly clipReferenceFromStep: string;
  readonly name: string;
  readonly loopStart: number;
  readonly loopEnd: number;
}

export interface SetTrackMixerPayload {
  readonly track: EntityReference;
  readonly volume?: number;
  readonly pan?: number;
  readonly sends?: readonly number[];
}

export interface LoadPresetPayload {
  readonly track: EntityReference;
  readonly browserItemId: string;
  readonly expectedName: string;
}

export type PlannedWorkflowStep =
  | WorkflowStep<"clip.create-session-midi", CreateSessionMidiClipPayload>
  | WorkflowStep<
      "clip.replace-session-midi-notes",
      ReplaceSessionMidiNotesPayload
    >
  | WorkflowStep<"clip.duplicate-to-arrangement", DuplicateToArrangementPayload>
  | WorkflowStep<
      "clip.set-arrangement-properties",
      SetArrangementPropertiesPayload
    >
  | WorkflowStep<"track.set-mixer", SetTrackMixerPayload>
  | WorkflowStep<"browser.load-preset", LoadPresetPayload>;

const plannerMaximumMutations = 64;
const plannerMaximumDurationMs = 120_000;

function requiredString(value: string, label: string): void {
  if (value.trim() === "")
    throw new WorkflowValidationError(`${label} is required`);
}

function finiteRange(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): void {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new WorkflowValidationError(
      `${label} must be between ${minimum} and ${maximum}`,
    );
  }
}

function integerRange(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): void {
  if (!Number.isInteger(value)) {
    throw new WorkflowValidationError(`${label} must be an integer`);
  }
  finiteRange(value, minimum, maximum, label);
}

function trackReference(reference: EntityReference, label: string): void {
  requiredString(reference.projectId, `${label} project id`);
  requiredString(reference.id, `${label} id`);
  if (
    reference.kind !== "track" &&
    reference.kind !== "return-track" &&
    reference.kind !== "master-track"
  ) {
    throw new WorkflowValidationError(`${label} must reference a track`);
  }
  integerRange(
    reference.revision,
    0,
    Number.MAX_SAFE_INTEGER,
    `${label} revision`,
  );
}

function validateMidiNotes(
  notes: readonly MidiNote[],
  clipLength: number,
): void {
  if (notes.length > workflowLimits.maximumMidiNotes) {
    throw new WorkflowValidationError("MIDI note limit exceeded");
  }
  for (const [index, note] of notes.entries()) {
    integerRange(note.pitch, 0, 127, `Note ${index} pitch`);
    finiteRange(note.startTime, 0, clipLength, `Note ${index} start`);
    finiteRange(
      note.duration,
      Number.EPSILON,
      clipLength,
      `Note ${index} duration`,
    );
    integerRange(note.velocity, 1, 127, `Note ${index} velocity`);
    if (note.startTime + note.duration > clipLength + Number.EPSILON) {
      throw new WorkflowValidationError(`Note ${index} exceeds clip length`);
    }
  }
}

function budget(
  identity: PlannerIdentity,
  mutationCount: number,
  steps: number,
): WorkflowBudget {
  const maxMutations = identity.maxMutations ?? plannerMaximumMutations;
  const maxDurationMs = identity.maxDurationMs ?? plannerMaximumDurationMs;
  integerRange(maxMutations, 1, plannerMaximumMutations, "Mutation budget");
  finiteRange(maxDurationMs, 1, plannerMaximumDurationMs, "Duration budget");
  if (mutationCount > maxMutations) {
    throw new WorkflowValidationError(
      `Plan requires ${mutationCount} mutations but budget allows ${maxMutations}`,
    );
  }
  return { maxSteps: steps, maxMutations, maxDurationMs };
}

function transaction(
  identity: PlannerIdentity,
  workflow: string,
  steps: readonly PlannedWorkflowStep[],
): WorkflowTransaction<PlannedWorkflowStep> {
  for (const [label, value] of [
    ["Transaction id", identity.id],
    ["Project id", identity.projectId],
    ["Session id", identity.sessionId],
    ["Correlation id", identity.correlationId],
    ["Resource", identity.resource],
    ["Intent", identity.intent],
  ] as const) {
    requiredString(value, label);
  }
  for (const step of steps) {
    if (
      step.target !== undefined &&
      step.target.projectId !== identity.projectId
    ) {
      throw new WorkflowValidationError(
        `Step '${step.id}' target belongs to a different project`,
      );
    }
  }
  const mutationCount = steps.reduce(
    (total, step) => total + step.mutationCount,
    0,
  );
  return {
    ...identity,
    workflow,
    budget: budget(identity, mutationCount, steps.length),
    steps,
  };
}

function reversible(compensation: string) {
  return { kind: "reversible" as const, compensation };
}

function createMidiSteps(
  track: EntityReference,
  sceneIndex: number,
  length: number,
  name: string,
  notes: readonly MidiNote[],
): readonly PlannedWorkflowStep[] {
  trackReference(track, "MIDI track");
  integerRange(sceneIndex, 0, 4095, "Scene index");
  finiteRange(length, Number.EPSILON, 4096, "Clip length");
  requiredString(name, "Clip name");
  if (name.length > 128)
    throw new WorkflowValidationError("Clip name is too long");
  validateMidiNotes(notes, length);
  return [
    {
      id: "step-001-create-clip",
      operation: "clip.create-session-midi",
      description: `Create ${name}`,
      dependencies: [],
      mutationCount: 1,
      reversibility: reversible("delete-created-session-clip"),
      target: track,
      payload: { track, sceneIndex, length, name },
      auditData: { sceneIndex, length, name },
    },
    {
      id: "step-002-write-notes",
      operation: "clip.replace-session-midi-notes",
      description: `Write ${notes.length} MIDI notes`,
      dependencies: ["step-001-create-clip"],
      mutationCount: 1,
      reversibility: reversible("restore-captured-midi-notes"),
      target: track,
      payload: {
        track,
        sceneIndex,
        clipReferenceFromStep: "step-001-create-clip",
        allowPerNoteExpressionLoss: false,
        notes,
      },
      auditData: { sceneIndex, noteCount: notes.length },
    },
  ];
}

export interface DrumLane {
  readonly pitch: number;
  readonly steps: readonly number[];
  readonly velocity?: number;
}

export interface DrumPatternPlanInput extends PlannerIdentity {
  readonly track: EntityReference;
  readonly sceneIndex: number;
  readonly name: string;
  readonly bars: number;
  readonly beatsPerBar?: number;
  readonly stepsPerBeat?: number;
  readonly lanes: readonly DrumLane[];
}

export function planDrumPattern(
  input: DrumPatternPlanInput,
): WorkflowTransaction<PlannedWorkflowStep> {
  integerRange(input.bars, 1, 16, "Bar count");
  const beatsPerBar = input.beatsPerBar ?? 4;
  const stepsPerBeat = input.stepsPerBeat ?? 4;
  integerRange(beatsPerBar, 1, 16, "Beats per bar");
  integerRange(stepsPerBeat, 1, 8, "Steps per beat");
  if (input.lanes.length === 0 || input.lanes.length > 128) {
    throw new WorkflowValidationError("Drum pattern requires 1 to 128 lanes");
  }
  const totalSteps = input.bars * beatsPerBar * stepsPerBeat;
  const stepLength = 1 / stepsPerBeat;
  const notes: MidiNote[] = [];
  for (const [laneIndex, lane] of input.lanes.entries()) {
    integerRange(lane.pitch, 0, 127, `Lane ${laneIndex} pitch`);
    const velocity = lane.velocity ?? 100;
    integerRange(velocity, 1, 127, `Lane ${laneIndex} velocity`);
    const uniqueSteps = new Set<number>();
    for (const step of lane.steps) {
      integerRange(step, 0, totalSteps - 1, `Lane ${laneIndex} step`);
      if (uniqueSteps.has(step)) {
        throw new WorkflowValidationError(
          `Lane ${laneIndex} contains duplicate steps`,
        );
      }
      uniqueSteps.add(step);
      notes.push({
        pitch: lane.pitch,
        startTime: step * stepLength,
        duration: Math.min(stepLength / 2, 0.25),
        velocity,
        mute: false,
      });
    }
  }
  notes.sort(
    (left, right) =>
      left.startTime - right.startTime || left.pitch - right.pitch,
  );
  const length = input.bars * beatsPerBar;
  return transaction(
    input,
    "drum-pattern",
    createMidiSteps(input.track, input.sceneIndex, length, input.name, notes),
  );
}

export type ChordQuality =
  "major" | "minor" | "diminished" | "augmented" | "sus2" | "sus4";

export interface ChordSpec {
  readonly root: number;
  readonly quality: ChordQuality;
  readonly beats: number;
  readonly velocity?: number;
}

export interface ChordProgressionPlanInput extends PlannerIdentity {
  readonly track: EntityReference;
  readonly sceneIndex: number;
  readonly name: string;
  readonly chords: readonly ChordSpec[];
}

const chordIntervals: Readonly<Record<ChordQuality, readonly number[]>> = {
  major: [0, 4, 7],
  minor: [0, 3, 7],
  diminished: [0, 3, 6],
  augmented: [0, 4, 8],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
};

export function planChordProgression(
  input: ChordProgressionPlanInput,
): WorkflowTransaction<PlannedWorkflowStep> {
  if (input.chords.length === 0 || input.chords.length > 64) {
    throw new WorkflowValidationError(
      "Chord progression requires 1 to 64 chords",
    );
  }
  const notes: MidiNote[] = [];
  let startTime = 0;
  for (const [index, chord] of input.chords.entries()) {
    integerRange(chord.root, 0, 127, `Chord ${index} root`);
    finiteRange(chord.beats, 0.0625, 64, `Chord ${index} length`);
    if (!(chord.quality in chordIntervals)) {
      throw new WorkflowValidationError(`Chord ${index} quality is invalid`);
    }
    const velocity = chord.velocity ?? 96;
    integerRange(velocity, 1, 127, `Chord ${index} velocity`);
    for (const interval of chordIntervals[chord.quality]) {
      const pitch = chord.root + interval;
      integerRange(pitch, 0, 127, `Chord ${index} pitch`);
      notes.push({
        pitch,
        startTime,
        duration: chord.beats,
        velocity,
        mute: false,
      });
    }
    startTime += chord.beats;
  }
  return transaction(
    input,
    "chord-progression",
    createMidiSteps(
      input.track,
      input.sceneIndex,
      startTime,
      input.name,
      notes,
    ),
  );
}

export interface SectionClip {
  readonly sourceTrack: EntityReference;
  readonly sceneIndex: number;
  readonly expectedClipId: string;
}

export interface SongSectionPlanInput extends PlannerIdentity {
  readonly name: string;
  readonly destinationTime: number;
  readonly length: number;
  readonly clips: readonly SectionClip[];
  readonly variation?: {
    readonly nameSuffix: string;
    readonly loopStart?: number;
    readonly loopEnd?: number;
  };
}

export function planSongSection(
  input: SongSectionPlanInput,
): WorkflowTransaction<PlannedWorkflowStep> {
  requiredString(input.name, "Section name");
  finiteRange(input.destinationTime, 0, 1_576_800, "Destination time");
  finiteRange(input.length, 0.0625, 4096, "Section length");
  if (input.clips.length === 0 || input.clips.length > 32) {
    throw new WorkflowValidationError("Song section requires 1 to 32 clips");
  }
  const steps: PlannedWorkflowStep[] = [];
  for (const [index, clip] of input.clips.entries()) {
    trackReference(clip.sourceTrack, `Section clip ${index} track`);
    integerRange(clip.sceneIndex, 0, 4095, `Section clip ${index} scene`);
    requiredString(clip.expectedClipId, `Section clip ${index} id`);
    const duplicateId = `step-${String(index + 1).padStart(3, "0")}-duplicate`;
    steps.push({
      id: duplicateId,
      operation: "clip.duplicate-to-arrangement",
      description: `Place ${input.name} clip ${index + 1}`,
      dependencies: [],
      mutationCount: 1,
      reversibility: reversible("delete-created-arrangement-clip"),
      target: clip.sourceTrack,
      payload: {
        sourceTrack: clip.sourceTrack,
        sceneIndex: clip.sceneIndex,
        expectedClipId: clip.expectedClipId,
        destinationTime: input.destinationTime,
      },
      auditData: {
        sceneIndex: clip.sceneIndex,
        destinationTime: input.destinationTime,
        section: input.name,
      },
    });
    if (input.variation !== undefined) {
      requiredString(input.variation.nameSuffix, "Variation name suffix");
      const variationName =
        `${input.name} ${input.variation.nameSuffix}`.trim();
      if (variationName.length > 128) {
        throw new WorkflowValidationError("Variation clip name is too long");
      }
      const loopStart = input.variation.loopStart ?? 0;
      const loopEnd = input.variation.loopEnd ?? input.length;
      finiteRange(loopStart, 0, input.length, "Variation loop start");
      finiteRange(loopEnd, Number.EPSILON, input.length, "Variation loop end");
      if (loopEnd <= loopStart) {
        throw new WorkflowValidationError(
          "Variation loop end must exceed loop start",
        );
      }
      steps.push({
        id: `step-${String(index + 1).padStart(3, "0")}-vary`,
        operation: "clip.set-arrangement-properties",
        description: `Apply variation to ${input.name} clip ${index + 1}`,
        dependencies: [duplicateId],
        mutationCount: 1,
        reversibility: reversible("restore-arrangement-clip-properties"),
        target: clip.sourceTrack,
        payload: {
          clipReferenceFromStep: duplicateId,
          name: variationName,
          loopStart,
          loopEnd,
        },
        auditData: {
          name: variationName,
          loopStart,
          loopEnd,
        },
      });
    }
  }
  return transaction(
    input,
    input.variation === undefined
      ? "song-section-create"
      : "song-section-variation",
    steps,
  );
}

export interface MixChange {
  readonly track: EntityReference;
  readonly volume?: number;
  readonly pan?: number;
  readonly sends?: readonly number[];
}

export interface MixChangeSetPlanInput extends PlannerIdentity {
  readonly changes: readonly MixChange[];
}

export function planMixChangeSet(
  input: MixChangeSetPlanInput,
): WorkflowTransaction<PlannedWorkflowStep> {
  if (input.changes.length === 0 || input.changes.length > 64) {
    throw new WorkflowValidationError(
      "Mix change set requires 1 to 64 changes",
    );
  }
  const seen = new Set<string>();
  const steps = input.changes.map((change, index): PlannedWorkflowStep => {
    trackReference(change.track, `Mix change ${index} track`);
    const key = `${change.track.kind}:${change.track.id}`;
    if (seen.has(key)) {
      throw new WorkflowValidationError(
        "Each track may appear only once in a mix change set",
      );
    }
    seen.add(key);
    if (
      change.volume === undefined &&
      change.pan === undefined &&
      change.sends === undefined
    ) {
      throw new WorkflowValidationError(`Mix change ${index} has no values`);
    }
    if (change.volume !== undefined)
      finiteRange(change.volume, 0, 1, `Mix change ${index} volume`);
    if (change.pan !== undefined)
      finiteRange(change.pan, -1, 1, `Mix change ${index} pan`);
    if (change.sends !== undefined) {
      if (change.sends.length > 16)
        throw new WorkflowValidationError("Send count exceeds 16");
      change.sends.forEach((send, sendIndex) =>
        finiteRange(send, 0, 1, `Mix change ${index} send ${sendIndex}`),
      );
    }
    const auditData: Record<string, MetadataValue> = {};
    if (change.volume !== undefined) auditData.volume = change.volume;
    if (change.pan !== undefined) auditData.pan = change.pan;
    if (change.sends !== undefined) auditData.sendCount = change.sends.length;
    return {
      id: `step-${String(index + 1).padStart(3, "0")}-mix`,
      operation: "track.set-mixer",
      description: `Apply mixer change ${index + 1}`,
      dependencies: [],
      mutationCount: 1,
      reversibility: reversible("restore-track-mixer-state"),
      target: change.track,
      payload: {
        track: change.track,
        ...(change.volume === undefined ? {} : { volume: change.volume }),
        ...(change.pan === undefined ? {} : { pan: change.pan }),
        ...(change.sends === undefined ? {} : { sends: [...change.sends] }),
      },
      auditData,
    };
  });
  return transaction(input, "mix-change-set", steps);
}

export interface PresetCandidate {
  readonly browserItemId: string;
  readonly expectedName: string;
}

export interface PresetAuditionPlanInput extends PlannerIdentity {
  readonly track: EntityReference;
  readonly candidates: readonly PresetCandidate[];
}

export function planPresetAudition(
  input: PresetAuditionPlanInput,
): WorkflowTransaction<PlannedWorkflowStep> {
  trackReference(input.track, "Preset target track");
  if (input.track.kind !== "track") {
    throw new WorkflowValidationError(
      "Preset audition requires a regular track",
    );
  }
  if (input.candidates.length === 0 || input.candidates.length > 8) {
    throw new WorkflowValidationError(
      "Preset audition requires 1 to 8 candidates",
    );
  }
  const steps = input.candidates.map(
    (candidate, index): PlannedWorkflowStep => {
      requiredString(
        candidate.browserItemId,
        `Preset ${index} browser item id`,
      );
      requiredString(candidate.expectedName, `Preset ${index} name`);
      const previous =
        index === 0 ? [] : [`step-${String(index).padStart(3, "0")}-preset`];
      return {
        id: `step-${String(index + 1).padStart(3, "0")}-preset`,
        operation: "browser.load-preset",
        description: `Audition ${candidate.expectedName}`,
        dependencies: previous,
        mutationCount: 1,
        reversibility: {
          kind: "non-reversible",
          reason:
            "The prior device graph and plug-in state cannot be faithfully reconstructed",
        },
        target: input.track,
        payload: {
          track: input.track,
          browserItemId: candidate.browserItemId,
          expectedName: candidate.expectedName,
        },
        auditData: {
          browserItemId: candidate.browserItemId,
          expectedName: candidate.expectedName,
        },
      };
    },
  );
  return transaction(input, "preset-audition", steps);
}
