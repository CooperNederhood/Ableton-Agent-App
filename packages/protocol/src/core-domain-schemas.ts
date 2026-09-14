import { z } from "zod";

import { LIVE_11_MAX_COLOR_INDEX, trackKindSchema } from "./schemas.js";

const boundedNameSchema = z.string().trim().min(1).max(128);
const runtimeReferenceSchema = z.string().uuid();
const pageSchema = {
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(256).default(64),
} as const;

export const sceneTargetSchema = z
  .object({
    index: z.number().int().nonnegative(),
    expectedReference: runtimeReferenceSchema,
    expectedName: z.string().max(128),
  })
  .strict();

export const sceneSummarySchema = z
  .object({
    index: z.number().int().nonnegative(),
    reference: runtimeReferenceSchema,
    name: z.string().max(128),
    colorIndex: z.number().int().min(0).max(LIVE_11_MAX_COLOR_INDEX).nullable(),
    tempo: z.number().min(20).max(999).nullable(),
    tempoEnabled: z.boolean().nullable(),
    timeSignature: z
      .object({
        numerator: z.number().int().min(1).max(99),
        denominator: z.number().int().min(1).max(16),
        enabled: z.boolean().nullable(),
      })
      .strict()
      .nullable(),
    isTriggered: z.boolean().nullable(),
  })
  .strict();

const sceneMutationResultBase = {
  beforeSceneCount: z.number().int().nonnegative(),
  afterSceneCount: z.number().int().nonnegative(),
  scene: sceneSummarySchema,
  verified: z.literal(true),
} as const;

export const scenesOperationParamsSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list"), ...pageSchema }).strict(),
  z.object({ action: z.literal("get"), target: sceneTargetSchema }).strict(),
  z
    .object({
      action: z.literal("create"),
      index: z.number().int().min(-1),
      name: boundedNameSchema.optional(),
    })
    .strict(),
  z
    .object({ action: z.literal("duplicate"), target: sceneTargetSchema })
    .strict(),
  z
    .object({
      action: z.literal("rename"),
      target: sceneTargetSchema,
      name: boundedNameSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("set-color"),
      target: sceneTargetSchema,
      colorIndex: z.number().int().min(0).max(LIVE_11_MAX_COLOR_INDEX),
    })
    .strict(),
  z
    .object({
      action: z.literal("set-tempo-time-signature"),
      target: sceneTargetSchema,
      state: z.discriminatedUnion("kind", [
        z
          .object({
            kind: z.literal("tempo"),
            tempo: z.number().min(20).max(999),
            enabled: z.boolean(),
          })
          .strict(),
        z
          .object({
            kind: z.literal("time-signature"),
            numerator: z.number().int().min(1).max(99),
            denominator: z.number().int().min(1).max(16),
            enabled: z.boolean(),
          })
          .strict(),
      ]),
    })
    .strict(),
  z.object({ action: z.literal("fire"), target: sceneTargetSchema }).strict(),
  z.object({ action: z.literal("delete"), target: sceneTargetSchema }).strict(),
]);
export const scenesInspectParamsSchema = z.discriminatedUnion("action", [
  scenesOperationParamsSchema.options[0],
  scenesOperationParamsSchema.options[1],
]);
export const scenesMutationParamsSchema = z.discriminatedUnion("action", [
  scenesOperationParamsSchema.options[2],
  scenesOperationParamsSchema.options[3],
  scenesOperationParamsSchema.options[4],
  scenesOperationParamsSchema.options[5],
  scenesOperationParamsSchema.options[6],
  scenesOperationParamsSchema.options[7],
  scenesOperationParamsSchema.options[8],
]);

export const scenesOperationResultSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("list"),
      scenes: z.array(sceneSummarySchema).max(256),
      total: z.number().int().nonnegative(),
      offset: z.number().int().nonnegative(),
      limit: z.number().int().min(1).max(256),
    })
    .strict(),
  z.object({ action: z.literal("get"), scene: sceneSummarySchema }).strict(),
  z
    .object({ action: z.literal("create"), ...sceneMutationResultBase })
    .strict(),
  z
    .object({ action: z.literal("duplicate"), ...sceneMutationResultBase })
    .strict(),
  z
    .object({
      action: z.literal("rename"),
      before: sceneSummarySchema,
      after: sceneSummarySchema,
      verified: z.literal(true),
    })
    .strict(),
  z
    .object({
      action: z.literal("set-color"),
      before: sceneSummarySchema,
      after: sceneSummarySchema,
      verified: z.literal(true),
    })
    .strict(),
  z
    .object({
      action: z.literal("set-tempo-time-signature"),
      before: sceneSummarySchema,
      after: sceneSummarySchema,
      verified: z.literal(true),
    })
    .strict(),
  z
    .object({
      action: z.literal("fire"),
      scene: sceneSummarySchema,
      verified: z.literal(true),
    })
    .strict(),
  z
    .object({
      action: z.literal("delete"),
      deleted: sceneSummarySchema,
      beforeSceneCount: z.number().int().positive(),
      afterSceneCount: z.number().int().nonnegative(),
      verified: z.literal(true),
    })
    .strict(),
]);

export const trackLocationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("regular"),
      index: z.number().int().nonnegative(),
      expectedReference: runtimeReferenceSchema,
      expectedName: z.string().max(128),
    })
    .strict(),
  z
    .object({
      kind: z.literal("return"),
      index: z.number().int().nonnegative(),
      expectedReference: runtimeReferenceSchema,
      expectedName: z.string().max(128),
    })
    .strict(),
  z
    .object({
      kind: z.literal("master"),
      expectedReference: runtimeReferenceSchema,
      expectedName: z.string().max(128),
    })
    .strict(),
]);

export const richTrackSummarySchema = z
  .object({
    kind: z.enum(["regular", "return", "master"]),
    index: z.number().int().nonnegative().nullable(),
    reference: runtimeReferenceSchema,
    name: z.string().max(128),
    trackType: trackKindSchema,
    colorIndex: z.number().int().min(0).max(LIVE_11_MAX_COLOR_INDEX).nullable(),
    isGroup: z.boolean(),
    isFolded: z.boolean().nullable(),
    monitoringState: z.number().int().nullable(),
    canBeArmed: z.boolean(),
    isArmed: z.boolean(),
    isMuted: z.boolean(),
    isSoloed: z.boolean(),
    backToArrangement: z.boolean().nullable(),
  })
  .strict();

export const tracksOperationParamsSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("list"),
      trackKind: z.enum(["regular", "return", "master", "all"]).default("all"),
      ...pageSchema,
    })
    .strict(),
  z.object({ action: z.literal("get"), target: trackLocationSchema }).strict(),
  z
    .object({
      action: z.literal("create-return"),
      name: boundedNameSchema.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("duplicate"),
      target: trackLocationSchema.options[0],
    })
    .strict(),
  z
    .object({
      action: z.literal("set-color"),
      target: trackLocationSchema,
      colorIndex: z.number().int().min(0).max(LIVE_11_MAX_COLOR_INDEX),
    })
    .strict(),
  z
    .object({
      action: z.literal("set-monitoring"),
      target: trackLocationSchema.options[0],
      monitoringState: z.number().int().min(0).max(2),
    })
    .strict(),
  z
    .object({
      action: z.literal("set-fold"),
      target: trackLocationSchema.options[0],
      folded: z.boolean(),
    })
    .strict(),
  z
    .object({
      action: z.literal("stop-clips"),
      target: trackLocationSchema.options[0],
      quantized: z.boolean().default(true),
    })
    .strict(),
  z
    .object({
      action: z.literal("back-to-arrangement"),
      target: trackLocationSchema.options[0],
    })
    .strict(),
  z
    .object({
      action: z.literal("delete"),
      target: z.discriminatedUnion("kind", [
        trackLocationSchema.options[0],
        trackLocationSchema.options[1],
      ]),
    })
    .strict(),
]);
export const tracksInspectParamsSchema = z.discriminatedUnion("action", [
  tracksOperationParamsSchema.options[0],
  tracksOperationParamsSchema.options[1],
]);
export const tracksMutationParamsSchema = z.discriminatedUnion("action", [
  tracksOperationParamsSchema.options[2],
  tracksOperationParamsSchema.options[3],
  tracksOperationParamsSchema.options[4],
  tracksOperationParamsSchema.options[5],
  tracksOperationParamsSchema.options[6],
  tracksOperationParamsSchema.options[7],
  tracksOperationParamsSchema.options[8],
  tracksOperationParamsSchema.options[9],
]);

const trackStateMutationResultSchema = z
  .object({
    before: richTrackSummarySchema,
    after: richTrackSummarySchema,
    verified: z.literal(true),
  })
  .strict();

export const tracksOperationResultSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("list"),
      tracks: z.array(richTrackSummarySchema).max(256),
      total: z.number().int().nonnegative(),
      offset: z.number().int().nonnegative(),
      limit: z.number().int().min(1).max(256),
    })
    .strict(),
  z
    .object({ action: z.literal("get"), track: richTrackSummarySchema })
    .strict(),
  z
    .object({
      action: z.literal("create-return"),
      track: richTrackSummarySchema,
      beforeReturnTrackCount: z.number().int().nonnegative(),
      afterReturnTrackCount: z.number().int().positive(),
      verified: z.literal(true),
    })
    .strict(),
  z
    .object({
      action: z.literal("duplicate"),
      source: richTrackSummarySchema,
      track: richTrackSummarySchema,
      beforeTrackCount: z.number().int().nonnegative(),
      afterTrackCount: z.number().int().positive(),
      verified: z.literal(true),
    })
    .strict(),
  z
    .object({
      action: z.literal("set-color"),
      result: trackStateMutationResultSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("set-monitoring"),
      result: trackStateMutationResultSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("set-fold"),
      result: trackStateMutationResultSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("stop-clips"),
      result: trackStateMutationResultSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("back-to-arrangement"),
      result: trackStateMutationResultSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("delete"),
      deleted: richTrackSummarySchema,
      beforeCount: z.number().int().positive(),
      afterCount: z.number().int().nonnegative(),
      verified: z.literal(true),
    })
    .strict(),
]);

export const mixerParameterStateSchema = z
  .object({
    reference: runtimeReferenceSchema,
    name: z.string().max(128),
    normalizedValue: z.number().min(0).max(1),
    value: z.number().finite(),
    displayValue: z.string().max(256),
  })
  .strict();

export const mixerStateSchema = z
  .object({
    target: richTrackSummarySchema,
    volume: mixerParameterStateSchema,
    pan: mixerParameterStateSchema,
    sends: z.array(mixerParameterStateSchema).max(64),
    activator: z.boolean(),
    crossfadeAssignment: z.number().int().nullable(),
    crossfader: mixerParameterStateSchema.nullable(),
    cueVolume: mixerParameterStateSchema.nullable(),
  })
  .strict();

const mixerParameterMutationTarget = z
  .object({
    target: trackLocationSchema,
    expectedParameterReference: runtimeReferenceSchema,
    expectedParameterName: z.string().max(128),
    normalizedValue: z.number().min(0).max(1),
  })
  .strict();
const masterMixerParameterMutationTarget = mixerParameterMutationTarget.extend({
  target: trackLocationSchema.options[2],
});

export const routingDirectionSchema = z.enum([
  "input-type",
  "input-channel",
  "output-type",
  "output-channel",
]);

export const routingOptionSchema = z
  .object({
    token: runtimeReferenceSchema,
    displayName: z.string().max(256),
    isExternalMidi: z.boolean(),
  })
  .strict();

export const mixerRoutingOperationParamsSchema = z.discriminatedUnion(
  "action",
  [
    z
      .object({ action: z.literal("inspect"), target: trackLocationSchema })
      .strict(),
    z
      .object({ action: z.literal("meters"), target: trackLocationSchema })
      .strict(),
    z
      .object({
        action: z.literal("set-volume"),
        value: mixerParameterMutationTarget,
      })
      .strict(),
    z
      .object({
        action: z.literal("set-pan"),
        value: mixerParameterMutationTarget,
      })
      .strict(),
    z
      .object({
        action: z.literal("set-send"),
        target: trackLocationSchema,
        sendIndex: z.number().int().nonnegative().max(63),
        expectedParameterReference: runtimeReferenceSchema,
        expectedParameterName: z.string().max(128),
        normalizedValue: z.number().min(0).max(1),
      })
      .strict(),
    z
      .object({
        action: z.literal("set-activator"),
        target: trackLocationSchema,
        active: z.boolean(),
      })
      .strict(),
    z
      .object({
        action: z.literal("set-crossfade-assignment"),
        target: trackLocationSchema,
        assignment: z.number().int().min(0).max(2),
      })
      .strict(),
    z
      .object({
        action: z.literal("set-master-crossfader"),
        value: masterMixerParameterMutationTarget,
      })
      .strict(),
    z
      .object({
        action: z.literal("set-cue-volume"),
        value: masterMixerParameterMutationTarget,
      })
      .strict(),
    z
      .object({
        action: z.literal("routing-options"),
        target: trackLocationSchema,
        direction: routingDirectionSchema,
      })
      .strict(),
    z
      .object({
        action: z.literal("set-routing"),
        target: trackLocationSchema,
        direction: routingDirectionSchema,
        snapshotId: runtimeReferenceSchema,
        optionToken: runtimeReferenceSchema,
        expectedDisplayName: z.string().max(256),
      })
      .strict(),
  ],
);
export const mixerRoutingInspectParamsSchema = z.discriminatedUnion("action", [
  mixerRoutingOperationParamsSchema.options[0],
  mixerRoutingOperationParamsSchema.options[1],
  mixerRoutingOperationParamsSchema.options[9],
]);
export const mixerRoutingMutationParamsSchema = z.discriminatedUnion("action", [
  mixerRoutingOperationParamsSchema.options[2],
  mixerRoutingOperationParamsSchema.options[3],
  mixerRoutingOperationParamsSchema.options[4],
  mixerRoutingOperationParamsSchema.options[5],
  mixerRoutingOperationParamsSchema.options[6],
  mixerRoutingOperationParamsSchema.options[7],
  mixerRoutingOperationParamsSchema.options[8],
  mixerRoutingOperationParamsSchema.options[10],
]);

const parameterMutationResultSchema = z
  .object({
    before: mixerParameterStateSchema,
    after: mixerParameterStateSchema,
    verified: z.literal(true),
  })
  .strict();

export const mixerRoutingOperationResultSchema = z.discriminatedUnion(
  "action",
  [
    z
      .object({ action: z.literal("inspect"), mixer: mixerStateSchema })
      .strict(),
    z
      .object({
        action: z.literal("meters"),
        inputLeft: z.number().min(0).max(1).nullable(),
        inputRight: z.number().min(0).max(1).nullable(),
        outputLeft: z.number().min(0).max(1).nullable(),
        outputRight: z.number().min(0).max(1).nullable(),
        observedAt: z.string().datetime(),
      })
      .strict(),
    z
      .object({
        action: z.literal("set-volume"),
        result: parameterMutationResultSchema,
      })
      .strict(),
    z
      .object({
        action: z.literal("set-pan"),
        result: parameterMutationResultSchema,
      })
      .strict(),
    z
      .object({
        action: z.literal("set-send"),
        result: parameterMutationResultSchema,
      })
      .strict(),
    z
      .object({
        action: z.literal("set-activator"),
        before: z.boolean(),
        after: z.boolean(),
        verified: z.literal(true),
      })
      .strict(),
    z
      .object({
        action: z.literal("set-crossfade-assignment"),
        before: z.number().int(),
        after: z.number().int(),
        verified: z.literal(true),
      })
      .strict(),
    z
      .object({
        action: z.literal("set-master-crossfader"),
        result: parameterMutationResultSchema,
      })
      .strict(),
    z
      .object({
        action: z.literal("set-cue-volume"),
        result: parameterMutationResultSchema,
      })
      .strict(),
    z
      .object({
        action: z.literal("routing-options"),
        snapshotId: runtimeReferenceSchema,
        options: z.array(routingOptionSchema).max(256),
        currentOptionToken: runtimeReferenceSchema.nullable(),
        warnings: z.array(z.string().max(512)).max(8),
      })
      .strict(),
    z
      .object({
        action: z.literal("set-routing"),
        before: routingOptionSchema,
        after: routingOptionSchema,
        warnings: z.array(z.string().max(512)).max(8),
        verified: z.literal(true),
      })
      .strict(),
  ],
);

export const cuePointTargetSchema = z
  .object({
    expectedReference: runtimeReferenceSchema,
    expectedName: z.string().max(128),
    expectedTime: z.number().finite().nonnegative().max(1_576_800),
  })
  .strict();

export const transportStateSchema = z
  .object({
    currentSongTime: z.number().finite().nonnegative(),
    isPlaying: z.boolean(),
    tempo: z.number().min(20).max(999),
    timeSignature: z
      .object({
        numerator: z.number().int().min(1).max(99),
        denominator: z.number().int().min(1).max(16),
      })
      .strict(),
    metronome: z.boolean(),
    launchQuantization: z.number().int().min(0).max(13),
    recordQuantization: z.number().int().min(0).max(8),
    linkEnabled: z.boolean().nullable(),
    backToArrangement: z.boolean().nullable(),
  })
  .strict();

export const transportOperationParamsSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("get"), ...pageSchema }).strict(),
  z
    .object({
      action: z.literal("seek"),
      time: z.number().finite().nonnegative().max(1_576_800),
    })
    .strict(),
  z
    .object({
      action: z.literal("jump"),
      beats: z.number().finite().min(-1_576_800).max(1_576_800),
    })
    .strict(),
  z
    .object({
      action: z.literal("set-time-signature"),
      numerator: z.number().int().min(1).max(99),
      denominator: z.number().int().min(1).max(16),
    })
    .strict(),
  z
    .object({ action: z.literal("set-metronome"), enabled: z.boolean() })
    .strict(),
  z
    .object({
      action: z.literal("set-launch-quantization"),
      quantization: z.number().int().min(0).max(13),
    })
    .strict(),
  z
    .object({
      action: z.literal("set-record-quantization"),
      quantization: z.number().int().min(0).max(8),
    })
    .strict(),
  z.object({ action: z.literal("set-link"), enabled: z.boolean() }).strict(),
  z
    .object({
      action: z.literal("rename-cue"),
      target: cuePointTargetSchema,
      name: boundedNameSchema,
    })
    .strict(),
  z
    .object({ action: z.literal("jump-to-cue"), target: cuePointTargetSchema })
    .strict(),
  z.object({ action: z.literal("back-to-arrangement") }).strict(),
]);
export const transportInspectParamsSchema =
  transportOperationParamsSchema.options[0];
export const transportMutationParamsSchema = z.discriminatedUnion("action", [
  transportOperationParamsSchema.options[1],
  transportOperationParamsSchema.options[2],
  transportOperationParamsSchema.options[3],
  transportOperationParamsSchema.options[4],
  transportOperationParamsSchema.options[5],
  transportOperationParamsSchema.options[6],
  transportOperationParamsSchema.options[7],
  transportOperationParamsSchema.options[8],
  transportOperationParamsSchema.options[9],
  transportOperationParamsSchema.options[10],
]);

export const transportOperationResultSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("get"),
      transport: transportStateSchema,
      cuePoints: z
        .array(
          z
            .object({
              reference: runtimeReferenceSchema,
              name: z.string().max(128),
              time: z.number().finite().nonnegative(),
            })
            .strict(),
        )
        .max(256),
      totalCuePoints: z.number().int().nonnegative(),
      offset: z.number().int().nonnegative(),
      limit: z.number().int().min(1).max(256),
    })
    .strict(),
  ...(
    [
      "seek",
      "jump",
      "set-time-signature",
      "set-metronome",
      "set-launch-quantization",
      "set-record-quantization",
      "set-link",
      "back-to-arrangement",
    ] as const
  ).map((action) =>
    z
      .object({
        action: z.literal(action),
        before: transportStateSchema,
        after: transportStateSchema,
        verified: z.literal(true),
      })
      .strict(),
  ),
  z
    .object({
      action: z.literal("rename-cue"),
      before: z.object({
        reference: runtimeReferenceSchema,
        name: z.string().max(128),
        time: z.number().finite().nonnegative(),
      }),
      after: z.object({
        reference: runtimeReferenceSchema,
        name: z.string().max(128),
        time: z.number().finite().nonnegative(),
      }),
      verified: z.literal(true),
    })
    .strict(),
  z
    .object({
      action: z.literal("jump-to-cue"),
      cuePoint: z.object({
        reference: runtimeReferenceSchema,
        name: z.string().max(128),
        time: z.number().finite().nonnegative(),
      }),
      beforeTime: z.number().finite().nonnegative(),
      afterTime: z.number().finite().nonnegative(),
      verified: z.literal(true),
    })
    .strict(),
]);

export const clipLocationSchema = z.discriminatedUnion("view", [
  z
    .object({
      view: z.literal("session"),
      track: trackLocationSchema.options[0],
      sceneIndex: z.number().int().nonnegative(),
      expectedClipReference: runtimeReferenceSchema,
      expectedClipName: z.string().max(128),
    })
    .strict(),
  z
    .object({
      view: z.literal("arrangement"),
      track: trackLocationSchema.options[0],
      expectedClipReference: runtimeReferenceSchema,
      expectedClipName: z.string().max(128),
      expectedStartTime: z.number().finite().nonnegative().max(1_576_800),
    })
    .strict(),
]);

export const modernMidiNoteSchema = z
  .object({
    noteId: z.number().int().nonnegative(),
    pitch: z.number().int().min(0).max(127),
    startTime: z.number().finite().nonnegative(),
    duration: z.number().finite().positive(),
    velocity: z.number().finite().min(0).max(127),
    mute: z.boolean(),
    probability: z.number().min(0).max(1),
    velocityDeviation: z.number().finite().min(-127).max(127),
    releaseVelocity: z.number().finite().min(0).max(127),
  })
  .strict();

export const newMidiNoteSchema = modernMidiNoteSchema.omit({ noteId: true });

const noteIdsSchema = z.array(z.number().int().nonnegative()).min(1).max(2048);

export const midiNotesOperationParamsSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("query"),
      target: clipLocationSchema,
      fromTime: z.number().finite().nonnegative().default(0),
      timeSpan: z
        .number()
        .finite()
        .positive()
        .max(1_576_800)
        .default(1_576_800),
      fromPitch: z.number().int().min(0).max(127).default(0),
      pitchSpan: z.number().int().min(1).max(128).default(128),
      ...pageSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("add"),
      target: clipLocationSchema,
      notes: z.array(newMidiNoteSchema).min(1).max(2048),
    })
    .strict(),
  z
    .object({
      action: z.literal("update"),
      target: clipLocationSchema,
      notes: z.array(modernMidiNoteSchema).min(1).max(2048),
    })
    .strict(),
  z
    .object({
      action: z.literal("remove"),
      target: clipLocationSchema,
      noteIds: noteIdsSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("duplicate"),
      target: clipLocationSchema,
      noteIds: noteIdsSchema,
      timeOffset: z.number().finite(),
      pitchOffset: z.number().int().min(-127).max(127).default(0),
    })
    .strict(),
  z
    .object({
      action: z.literal("quantize"),
      target: clipLocationSchema,
      noteIds: noteIdsSchema,
      gridBeats: z.number().finite().positive().max(64),
      amount: z.number().min(0).max(1),
    })
    .strict(),
]);
export const midiNotesInspectParamsSchema =
  midiNotesOperationParamsSchema.options[0];
export const midiNotesMutationParamsSchema = z.discriminatedUnion("action", [
  midiNotesOperationParamsSchema.options[1],
  midiNotesOperationParamsSchema.options[2],
  midiNotesOperationParamsSchema.options[3],
  midiNotesOperationParamsSchema.options[4],
  midiNotesOperationParamsSchema.options[5],
]);

export const midiNotesOperationResultSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("query"),
      notes: z.array(modernMidiNoteSchema).max(2048),
      total: z.number().int().nonnegative(),
      offset: z.number().int().nonnegative(),
      limit: z.number().int().min(1).max(256),
      truncated: z.boolean(),
    })
    .strict(),
  ...(["add", "update", "remove", "duplicate", "quantize"] as const).map(
    (action) =>
      z
        .object({
          action: z.literal(action),
          beforeNoteCount: z.number().int().nonnegative(),
          afterNoteCount: z.number().int().nonnegative(),
          affectedNoteIds: z.array(z.number().int().nonnegative()).max(2048),
          verified: z.literal(true),
        })
        .strict(),
  ),
]);

export const audioClipSummarySchema = z
  .object({
    reference: runtimeReferenceSchema,
    name: z.string().max(128),
    length: z.number().finite().positive(),
    gain: z.number().finite().nullable(),
    pitchCoarse: z.number().int().nullable(),
    pitchFine: z.number().int().min(-50).max(49).nullable(),
    warping: z.boolean().nullable(),
    warpMode: z.number().int().min(0).max(6).nullable(),
    availableWarpModes: z.array(z.number().int().min(0).max(6)).max(7),
    startMarker: z.number().finite().nullable(),
    endMarker: z.number().finite().nullable(),
    loopStart: z.number().finite().nullable(),
    loopEnd: z.number().finite().nullable(),
    looping: z.boolean().nullable(),
    ramMode: z.boolean().nullable(),
    filePath: z.string().max(2_048).nullable(),
    sampleLength: z.number().int().nonnegative().nullable(),
    sampleRate: z.number().int().positive().nullable(),
  })
  .strict();

export const warpMarkerSchema = z
  .object({
    index: z.number().int().nonnegative(),
    beatTime: z.number().finite(),
    sampleTime: z.number().finite(),
  })
  .strict();

export const audioClipsOperationParamsSchema = z.discriminatedUnion("action", [
  z
    .object({ action: z.literal("inspect"), target: clipLocationSchema })
    .strict(),
  z
    .object({
      action: z.literal("set-gain"),
      target: clipLocationSchema,
      gain: z.number().finite().min(0).max(1),
    })
    .strict(),
  z
    .object({
      action: z.literal("set-pitch"),
      target: clipLocationSchema,
      coarse: z.number().int().min(-48).max(48),
      fine: z.number().int().min(-50).max(49),
    })
    .strict(),
  z
    .object({
      action: z.literal("set-warp"),
      target: clipLocationSchema,
      enabled: z.boolean(),
    })
    .strict(),
  z
    .object({
      action: z.literal("set-warp-mode"),
      target: clipLocationSchema,
      warpMode: z.number().int().min(0).max(6),
      expectedAvailableWarpModes: z
        .array(z.number().int().min(0).max(6))
        .min(1)
        .max(7),
    })
    .strict()
    .refine(
      (value) =>
        new Set(value.expectedAvailableWarpModes).size ===
          value.expectedAvailableWarpModes.length &&
        value.expectedAvailableWarpModes.includes(value.warpMode),
      {
        message:
          "warpMode must identify one unique expected available warp mode",
        path: ["warpMode"],
      },
    ),
  z
    .object({
      action: z.literal("set-markers"),
      target: clipLocationSchema,
      markers: z.discriminatedUnion("kind", [
        z
          .object({
            kind: z.literal("start-end"),
            startMarker: z.number().finite().nonnegative(),
            endMarker: z.number().finite().positive(),
          })
          .strict()
          .refine((value) => value.endMarker > value.startMarker),
        z
          .object({
            kind: z.literal("loop"),
            loopStart: z.number().finite().nonnegative(),
            loopEnd: z.number().finite().positive(),
            looping: z.boolean(),
          })
          .strict()
          .refine((value) => value.loopEnd > value.loopStart),
      ]),
    })
    .strict(),
  z
    .object({
      action: z.literal("set-ram-mode"),
      target: clipLocationSchema,
      enabled: z.boolean(),
    })
    .strict(),
  z
    .object({
      action: z.literal("warp-markers"),
      target: clipLocationSchema,
      ...pageSchema,
    })
    .strict(),
]);
export const audioClipsInspectParamsSchema = z.discriminatedUnion("action", [
  audioClipsOperationParamsSchema.options[0],
  audioClipsOperationParamsSchema.options[7],
]);
export const audioClipsMutationParamsSchema = z.discriminatedUnion("action", [
  audioClipsOperationParamsSchema.options[1],
  audioClipsOperationParamsSchema.options[2],
  audioClipsOperationParamsSchema.options[3],
  audioClipsOperationParamsSchema.options[4],
  audioClipsOperationParamsSchema.options[5],
  audioClipsOperationParamsSchema.options[6],
]);

export const audioClipsOperationResultSchema = z.discriminatedUnion("action", [
  z
    .object({ action: z.literal("inspect"), clip: audioClipSummarySchema })
    .strict(),
  ...(
    [
      "set-gain",
      "set-pitch",
      "set-warp",
      "set-warp-mode",
      "set-markers",
      "set-ram-mode",
    ] as const
  ).map((action) =>
    z
      .object({
        action: z.literal(action),
        before: audioClipSummarySchema,
        after: audioClipSummarySchema,
        verified: z.literal(true),
      })
      .strict(),
  ),
  z
    .object({
      action: z.literal("warp-markers"),
      markers: z.array(warpMarkerSchema).max(256),
      total: z.number().int().nonnegative(),
      offset: z.number().int().nonnegative(),
      limit: z.number().int().min(1).max(256),
    })
    .strict(),
]);

export type ScenesOperationParams = z.infer<typeof scenesOperationParamsSchema>;
export type ScenesOperationResult = z.infer<typeof scenesOperationResultSchema>;
export type TracksOperationParams = z.infer<typeof tracksOperationParamsSchema>;
export type TracksOperationResult = z.infer<typeof tracksOperationResultSchema>;
export type MixerRoutingOperationParams = z.infer<
  typeof mixerRoutingOperationParamsSchema
>;
export type MixerRoutingOperationResult = z.infer<
  typeof mixerRoutingOperationResultSchema
>;
export type TransportOperationParams = z.infer<
  typeof transportOperationParamsSchema
>;
export type TransportOperationResult = z.infer<
  typeof transportOperationResultSchema
>;
export type MidiNotesOperationParams = z.infer<
  typeof midiNotesOperationParamsSchema
>;
export type MidiNotesOperationResult = z.infer<
  typeof midiNotesOperationResultSchema
>;
export type AudioClipsOperationParams = z.infer<
  typeof audioClipsOperationParamsSchema
>;
export type AudioClipsOperationResult = z.infer<
  typeof audioClipsOperationResultSchema
>;
