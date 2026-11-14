import { z } from "zod";
import { workflowTrackTargetSchema } from "./workflow-adapter-schemas.js";

const beat = z.number().finite().min(0).max(1_576_800);
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
        }),
      )
      .max(256),
  })
  .refine(
    (value) =>
      value.clips.every((clip) => clip.endBeat > clip.startBeat) &&
      new Set(value.clips.map((clip) => clip.clipId)).size ===
        value.clips.length,
    "Arrangement clip identities and intervals must be complete and unique",
  );
export type InspectArrangementListeningSourceParams = z.infer<
  typeof inspectArrangementListeningSourceParamsSchema
>;
export type InspectArrangementListeningSourceResult = z.infer<
  typeof inspectArrangementListeningSourceResultSchema
>;
