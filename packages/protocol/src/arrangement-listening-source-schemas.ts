import { z } from "zod";
import { workflowTrackTargetSchema } from "./workflow-adapter-schemas.js";
import { inspectArrangementMidiNotesResultSchema } from "./schemas.js";
import { listeningTopLevelInstrumentChainSchema } from "./session-listening-preflight-schemas.js";

const beat = z.number().finite().min(0).max(1_576_800);
export const MAX_ARRANGEMENT_LISTENING_MIDI_NOTES = 2048;
export const inspectArrangementListeningSourceParamsSchema = z.strictObject({
  schemaVersion: z.literal(1),
  queryId: z.string().uuid(),
  track: z.strictObject({
    ...workflowTrackTargetSchema.shape,
    kind: z.literal("regular"),
    index: z.number().int().min(0).max(255),
  }),
  range: z
    .strictObject({ startBeat: beat, endBeat: beat })
    .refine((value) => value.endBeat > value.startBeat),
});
const state = z.strictObject({
  transportPlaying: z.boolean().nullable(),
  currentBeat: beat.nullable(),
  tempoBpm: z.number().finite().positive().nullable(),
  loopEnabled: z.boolean().nullable(),
  arrangementRecord: z.boolean().nullable(),
  sessionRecord: z.boolean().nullable(),
  overdub: z.boolean().nullable(),
  sessionAutomationRecord: z.boolean().nullable(),
  globalBackToArrangement: z.boolean().nullable(),
  targetArmed: z.boolean().nullable(),
  targetMonitoring: z.number().int().min(0).max(2).nullable(),
  arrangementEligible: z.boolean().nullable(),
  playingSessionClips: z.number().int().min(0).max(65_536).nullable(),
  queuedSessionClips: z.number().int().min(0).max(65_536).nullable(),
});
export const inspectArrangementListeningSourceResultSchema = z
  .strictObject({
    ...inspectArrangementListeningSourceParamsSchema.shape,
    projectRevision: z.number().int().nonnegative(),
    evidence: z.literal("message-rate-only"),
    projectPath: z.string().min(1).max(4096).nullable(),
    before: state,
    after: state,
    instrumentChain: listeningTopLevelInstrumentChainSchema
      .refine(
        ({ before, after }) => !before.instrumentTree && !after.instrumentTree,
        "Arrangement source reads retain only the bounded top-level instrument witness",
      )
      .optional(),
    clips: z
      .array(
        z.strictObject({
          clipId: z.string().uuid(),
          name: z.string().max(256),
          startBeat: beat,
          endBeat: beat,
          filePath: z.string().min(1).max(4096).nullable(),
          sampleRate: z.number().finite().positive().nullable(),
          sampleLength: z.number().finite().positive().nullable(),
          recording: z.boolean().nullable(),
          warped: z.boolean().nullable(),
          startMarker: z.number().finite().nullable(),
          endMarker: z.number().finite().nullable(),
          loopStart: z.number().finite().nullable(),
          loopEnd: z.number().finite().nullable(),
          looping: z.boolean().nullable(),
          gain: z.number().finite().nullable(),
          pitchCoarse: z.number().finite().nullable(),
          pitchFine: z.number().finite().nullable(),
          midi: inspectArrangementMidiNotesResultSchema.optional(),
        }),
      )
      .max(256),
  })
  .refine(
    (value) =>
      value.clips.every(
        (clip) =>
          clip.endBeat > clip.startBeat &&
          clip.startBeat < value.range.endBeat &&
          clip.endBeat > value.range.startBeat,
      ) &&
      new Set(value.clips.map((clip) => clip.clipId)).size ===
        value.clips.length,
    "Arrangement clip identities and intervals must be complete and unique",
  )
  .superRefine((value, ctx) => {
    const midiClips = value.clips.filter((clip) => clip.midi !== undefined);
    if (
      midiClips.length > 0 !== (value.instrumentChain !== undefined) ||
      midiClips.reduce(
        (total, clip) => total + (clip.midi?.totalNotes ?? 0),
        0,
      ) > MAX_ARRANGEMENT_LISTENING_MIDI_NOTES ||
      midiClips.some(({ midi, ...clip }) => {
        if (midi === undefined) return true;
        return (
          midi.clip.kind !== "midi" ||
          midi.clip.reference !== clip.clipId ||
          midi.clip.name !== clip.name ||
          midi.clip.trackReference !== value.track.expectedReference ||
          midi.clip.trackIndex !== value.track.index ||
          midi.clip.startTime !== clip.startBeat ||
          midi.clip.endTime !== clip.endBeat ||
          clip.filePath !== null ||
          clip.sampleRate !== null ||
          clip.sampleLength !== null ||
          clip.warped !== null ||
          clip.gain !== null ||
          clip.pitchCoarse !== null ||
          clip.pitchFine !== null ||
          midi.truncated ||
          midi.offset !== 0 ||
          midi.totalNotes !== midi.notes.length ||
          midi.clip.noteCount !== midi.totalNotes ||
          midi.notes.length > midi.limit
        );
      }) ||
      value.instrumentChain?.before.devices.some(
        (device) =>
          device.trackReference !== value.track.expectedReference ||
          device.trackIndex !== value.track.index,
      )
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Arrangement MIDI requires complete exact-track notes and stable bounded instrument evidence",
      });
  });
export type InspectArrangementListeningSourceParams = z.infer<
  typeof inspectArrangementListeningSourceParamsSchema
>;
export type InspectArrangementListeningSourceResult = z.infer<
  typeof inspectArrangementListeningSourceResultSchema
>;
