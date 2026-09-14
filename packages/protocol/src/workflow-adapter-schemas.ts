import { z } from "zod";
import { browserPathSegmentSchema, browserRootKeySchema } from "./schemas.js";

const referenceSchema = z.string().uuid();
const nameSchema = z.string().max(128);
const finiteBeatSchema = z.number().finite().min(0).max(1_576_800);
const boundedPage = {
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(256).default(64),
} as const;

export const workflowTrackTargetSchema = z
  .object({
    kind: z.enum(["regular", "return", "master"]),
    index: z.number().int().nonnegative().optional(),
    expectedReference: referenceSchema,
    expectedName: nameSchema,
  })
  .strict()
  .refine(
    (target) =>
      target.kind === "master"
        ? target.index === undefined
        : target.index !== undefined,
    "Regular and return tracks require an index; master does not",
  );

export const workflowSessionSlotTargetSchema = z
  .object({
    track: workflowTrackTargetSchema.refine(
      (track) => track.kind === "regular",
      "Session slots require a regular track",
    ),
    sceneIndex: z.number().int().nonnegative(),
    expectedSceneReference: referenceSchema,
    expectedSceneName: nameSchema,
    expectedHasClip: z.boolean(),
    expectedClipReference: referenceSchema.optional(),
    expectedClipName: nameSchema.optional(),
  })
  .strict()
  .refine(
    (target) =>
      !target.expectedHasClip ||
      (target.expectedClipReference !== undefined &&
        target.expectedClipName !== undefined),
    "Occupied slots require exact clip identity",
  );

export const workflowClipTargetSchema = z.discriminatedUnion("view", [
  z
    .object({
      view: z.literal("session"),
      track: workflowTrackTargetSchema.refine(
        (track) => track.kind === "regular",
        "Clips require a regular track",
      ),
      sceneIndex: z.number().int().nonnegative(),
      expectedClipReference: referenceSchema,
      expectedClipName: nameSchema,
    })
    .strict(),
  z
    .object({
      view: z.literal("arrangement"),
      track: workflowTrackTargetSchema.refine(
        (track) => track.kind === "regular",
        "Clips require a regular track",
      ),
      expectedClipReference: referenceSchema,
      expectedClipName: nameSchema,
      expectedStartTime: finiteBeatSchema,
    })
    .strict(),
]);

export const workflowDeviceTargetSchema = z
  .object({
    track: workflowTrackTargetSchema,
    deviceIndex: z.number().int().nonnegative(),
    expectedDeviceReference: referenceSchema,
    expectedDeviceName: nameSchema,
    expectedClassName: nameSchema,
  })
  .strict();

export const workflowChainTargetSchema = z
  .object({
    track: workflowTrackTargetSchema.refine(
      (track) => track.kind === "regular",
      "Chains require a regular track",
    ),
    rackIndex: z.number().int().nonnegative(),
    expectedRackReference: referenceSchema,
    expectedRackName: nameSchema,
    chainIndex: z.number().int().nonnegative(),
    expectedChainReference: referenceSchema,
    expectedChainName: nameSchema,
  })
  .strict();

const warningSchema = z.string().max(512);
const jobKindSchema = z.enum(["timed-session-recording", "looper-export"]);
export const workflowJobStatusSchema = z
  .object({
    jobId: z.string().uuid(),
    kind: jobKindSchema,
    status: z.enum([
      "queued",
      "started",
      "running",
      "completed",
      "failed",
      "cancelled",
      "indeterminate",
    ]),
    progress: z.number().min(0).max(1),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    correlationId: z.string().uuid(),
    causationId: z.string().uuid().optional(),
    traceId: z.string().uuid(),
    result: z.record(z.string(), z.unknown()).optional(),
    error: z
      .object({
        code: z.string().min(1).max(64),
        message: z.string().min(1).max(512),
      })
      .strict()
      .optional(),
  })
  .strict();
export const workflowJobLifecyclePayloadSchema = workflowJobStatusSchema
  .pick({
    jobId: true,
    kind: true,
    status: true,
    progress: true,
    updatedAt: true,
    correlationId: true,
    causationId: true,
    traceId: true,
  })
  .strict();

export const workflowRecordingStateSchema = z
  .object({
    arrangementRecord: z.boolean(),
    sessionRecord: z.boolean(),
    overdub: z.boolean(),
    sessionAutomationRecord: z.boolean(),
    punchIn: z.boolean(),
    punchOut: z.boolean(),
  })
  .strict();

export const recordingOperationParamsSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("inspect") }).strict(),
  z
    .object({
      action: z.literal("set-arrangement-record"),
      enabled: z.boolean(),
    })
    .strict(),
  z
    .object({ action: z.literal("set-session-record"), enabled: z.boolean() })
    .strict(),
  z.object({ action: z.literal("set-overdub"), enabled: z.boolean() }).strict(),
  z
    .object({
      action: z.literal("set-session-automation-record"),
      enabled: z.boolean(),
    })
    .strict(),
  z
    .object({
      action: z.literal("set-punch"),
      punchIn: z.boolean().optional(),
      punchOut: z.boolean().optional(),
    })
    .strict()
    .refine(
      (value) => value.punchIn !== undefined || value.punchOut !== undefined,
      "At least one punch state is required",
    ),
  z
    .object({
      action: z.literal("capture-midi"),
      destination: z.literal("selected-armed-tracks"),
    })
    .strict(),
  z
    .object({
      action: z.literal("record-session-slot"),
      target: workflowSessionSlotTargetSchema.refine(
        (target) => !target.expectedHasClip,
        "Timed recording requires an exact empty slot",
      ),
      durationBeats: z.number().finite().positive().max(65_536),
      launchQuantization: z.number().int().min(0).max(13).optional(),
      correlationId: z.string().uuid(),
      causationId: z.string().uuid().optional(),
      traceId: z.string().uuid(),
    })
    .strict(),
]);

const recordingMutationResultSchema = z
  .object({
    before: workflowRecordingStateSchema,
    after: workflowRecordingStateSchema,
    verified: z.literal(true),
    warnings: z.array(warningSchema).max(8),
  })
  .strict();
export const recordingOperationResultSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("inspect"),
      state: workflowRecordingStateSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("set-arrangement-record"),
      result: recordingMutationResultSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("set-session-record"),
      result: recordingMutationResultSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("set-overdub"),
      result: recordingMutationResultSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("set-session-automation-record"),
      result: recordingMutationResultSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("set-punch"),
      result: recordingMutationResultSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("capture-midi"),
      destination: z.literal("selected-armed-tracks"),
      captured: z.literal(true),
      verified: z.literal(true),
      warnings: z.array(warningSchema).max(8),
    })
    .strict(),
  z
    .object({
      action: z.literal("record-session-slot"),
      job: workflowJobStatusSchema,
      recordingIntent: z.literal("record"),
    })
    .strict(),
]);

export const grooveSummarySchema = z
  .object({
    index: z.number().int().nonnegative(),
    reference: referenceSchema,
    name: nameSchema,
    base: z.number().finite().nullable(),
    quantizationAmount: z.number().finite().min(0).max(1).nullable(),
    timingAmount: z.number().finite().min(0).max(1).nullable(),
    randomAmount: z.number().finite().min(0).max(1).nullable(),
    velocityAmount: z.number().finite().min(0).max(1).nullable(),
  })
  .strict();
export const grooveTargetSchema = z
  .object({
    index: z.number().int().nonnegative(),
    expectedReference: referenceSchema,
    expectedName: nameSchema,
    poolRevision: z.string().min(16).max(128),
  })
  .strict();
export const grooveOperationParamsSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list"), ...boundedPage }).strict(),
  z.object({ action: z.literal("get"), target: grooveTargetSchema }).strict(),
  z
    .object({
      action: z.literal("inspect-clip"),
      target: workflowClipTargetSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("set-clip-groove"),
      target: workflowClipTargetSchema,
      groove: grooveTargetSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("clear-clip-groove"),
      target: workflowClipTargetSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("set-properties"),
      target: grooveTargetSchema,
      quantizationAmount: z.number().finite().min(0).max(1).optional(),
      timingAmount: z.number().finite().min(0).max(1).optional(),
      randomAmount: z.number().finite().min(0).max(1).optional(),
      velocityAmount: z.number().finite().min(0).max(1).optional(),
    })
    .strict()
    .refine(
      (value) =>
        value.quantizationAmount !== undefined ||
        value.timingAmount !== undefined ||
        value.randomAmount !== undefined ||
        value.velocityAmount !== undefined,
      "At least one groove property is required",
    ),
  z
    .object({
      action: z.literal("set-global-amount"),
      amount: z.number().finite().min(0).max(1),
    })
    .strict(),
]);
const clipGrooveStateSchema = z
  .object({
    clipReference: referenceSchema,
    groove: grooveSummarySchema.nullable(),
  })
  .strict();
export const grooveOperationResultSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("list"),
      grooves: z.array(grooveSummarySchema).max(256),
      total: z.number().int().nonnegative(),
      offset: z.number().int().nonnegative(),
      limit: z.number().int().positive(),
      poolRevision: z.string().min(16).max(128),
      globalAmount: z.number().finite().min(0).max(1),
    })
    .strict(),
  z
    .object({
      action: z.literal("get"),
      groove: grooveSummarySchema,
      poolRevision: z.string().min(16).max(128),
    })
    .strict(),
  z
    .object({ action: z.literal("inspect-clip"), state: clipGrooveStateSchema })
    .strict(),
  z
    .object({
      action: z.literal("set-clip-groove"),
      before: clipGrooveStateSchema,
      after: clipGrooveStateSchema,
      verified: z.literal(true),
    })
    .strict(),
  z
    .object({
      action: z.literal("clear-clip-groove"),
      before: clipGrooveStateSchema,
      after: clipGrooveStateSchema,
      verified: z.literal(true),
    })
    .strict(),
  z
    .object({
      action: z.literal("set-properties"),
      before: grooveSummarySchema,
      after: grooveSummarySchema,
      poolRevision: z.string().min(16).max(128),
      verified: z.literal(true),
    })
    .strict(),
  z
    .object({
      action: z.literal("set-global-amount"),
      before: z.number(),
      after: z.number(),
      verified: z.literal(true),
    })
    .strict(),
]);

const selectionStateSchema = z
  .object({
    trackReference: referenceSchema.nullable(),
    sceneReference: referenceSchema.nullable(),
    clipReference: referenceSchema.nullable(),
    slot: z
      .object({
        trackReference: referenceSchema,
        sceneIndex: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
    deviceReference: referenceSchema.nullable(),
    chainReference: referenceSchema.nullable(),
  })
  .strict();
const viewStateSchema = z
  .object({
    visibleViews: z
      .array(z.enum(["Session", "Arranger", "Detail", "Browser"]))
      .max(4),
    focusedView: z
      .enum(["Session", "Arranger", "Detail", "Browser"])
      .nullable(),
    follow: z.boolean().nullable(),
    drawMode: z.boolean().nullable(),
  })
  .strict();
export const selectionViewOperationParamsSchema = z.discriminatedUnion(
  "action",
  [
    z.object({ action: z.literal("inspect-selection") }).strict(),
    z.object({ action: z.literal("inspect-view") }).strict(),
    z
      .object({
        action: z.literal("select-track"),
        target: workflowTrackTargetSchema,
      })
      .strict(),
    z
      .object({
        action: z.literal("select-scene"),
        sceneIndex: z.number().int().nonnegative(),
        expectedSceneReference: referenceSchema,
        expectedSceneName: nameSchema,
      })
      .strict(),
    z
      .object({
        action: z.literal("select-slot"),
        target: workflowSessionSlotTargetSchema,
      })
      .strict(),
    z
      .object({
        action: z.literal("select-clip"),
        target: workflowClipTargetSchema,
      })
      .strict(),
    z
      .object({
        action: z.literal("select-device"),
        target: workflowDeviceTargetSchema,
      })
      .strict(),
    z
      .object({
        action: z.literal("select-chain"),
        target: workflowChainTargetSchema,
      })
      .strict(),
    z
      .object({
        action: z.literal("set-view"),
        view: z.enum(["Session", "Arranger", "Detail", "Browser"]),
        state: z.enum(["show", "hide", "focus"]),
      })
      .strict(),
    z
      .object({ action: z.literal("set-follow"), enabled: z.boolean() })
      .strict(),
    z
      .object({ action: z.literal("set-draw-mode"), enabled: z.boolean() })
      .strict(),
    z
      .object({
        action: z.literal("set-track-fold"),
        target: workflowTrackTargetSchema,
        folded: z.boolean(),
      })
      .strict(),
    z
      .object({
        action: z.literal("set-device-collapsed"),
        target: workflowDeviceTargetSchema,
        collapsed: z.boolean(),
      })
      .strict(),
  ],
);
export const selectionViewOperationResultSchema = z.discriminatedUnion(
  "action",
  [
    z
      .object({
        action: z.literal("inspect-selection"),
        selection: selectionStateSchema,
      })
      .strict(),
    z
      .object({ action: z.literal("inspect-view"), view: viewStateSchema })
      .strict(),
    z
      .object({
        action: z.literal("select-track"),
        before: selectionStateSchema,
        after: selectionStateSchema,
        verified: z.literal(true),
      })
      .strict(),
    z
      .object({
        action: z.literal("select-scene"),
        before: selectionStateSchema,
        after: selectionStateSchema,
        verified: z.literal(true),
      })
      .strict(),
    z
      .object({
        action: z.literal("select-slot"),
        before: selectionStateSchema,
        after: selectionStateSchema,
        verified: z.literal(true),
      })
      .strict(),
    z
      .object({
        action: z.literal("select-clip"),
        before: selectionStateSchema,
        after: selectionStateSchema,
        verified: z.literal(true),
      })
      .strict(),
    z
      .object({
        action: z.literal("select-device"),
        before: selectionStateSchema,
        after: selectionStateSchema,
        verified: z.literal(true),
      })
      .strict(),
    z
      .object({
        action: z.literal("select-chain"),
        before: selectionStateSchema,
        after: selectionStateSchema,
        verified: z.literal(true),
      })
      .strict(),
    z
      .object({
        action: z.literal("set-view"),
        before: viewStateSchema,
        after: viewStateSchema,
        verified: z.literal(true),
      })
      .strict(),
    z
      .object({
        action: z.literal("set-follow"),
        before: viewStateSchema,
        after: viewStateSchema,
        verified: z.literal(true),
      })
      .strict(),
    z
      .object({
        action: z.literal("set-draw-mode"),
        before: viewStateSchema,
        after: viewStateSchema,
        verified: z.literal(true),
      })
      .strict(),
    z
      .object({
        action: z.literal("set-track-fold"),
        before: z.boolean(),
        after: z.boolean(),
        verified: z.literal(true),
      })
      .strict(),
    z
      .object({
        action: z.literal("set-device-collapsed"),
        before: z.boolean(),
        after: z.boolean(),
        verified: z.literal(true),
      })
      .strict(),
  ],
);

export const liveHistoryOperationParamsSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("inspect") }).strict(),
  z
    .object({
      action: z.literal("undo"),
      confirmation: z.literal("global-live-history"),
    })
    .strict(),
  z
    .object({
      action: z.literal("redo"),
      confirmation: z.literal("global-live-history"),
    })
    .strict(),
]);
const historyStateSchema = z
  .object({ canUndo: z.boolean(), canRedo: z.boolean() })
  .strict();
export const liveHistoryOperationResultSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("inspect"),
      state: historyStateSchema,
      warnings: z.array(warningSchema),
    })
    .strict(),
  z
    .object({
      action: z.literal("undo"),
      before: historyStateSchema,
      after: historyStateSchema,
      verified: z.literal(true),
      warnings: z.array(warningSchema),
    })
    .strict(),
  z
    .object({
      action: z.literal("redo"),
      before: historyStateSchema,
      after: historyStateSchema,
      verified: z.literal(true),
      warnings: z.array(warningSchema),
    })
    .strict(),
]);

export const browserAdapterOperationParamsSchema = z.discriminatedUnion(
  "action",
  [
    z
      .object({
        action: z.literal("preview"),
        expectedItemReference: referenceSchema,
        expectedItemRoot: browserRootKeySchema,
        expectedItemPath: z.array(browserPathSegmentSchema).max(16),
        expectedItemUri: z.string().max(2048),
        expectedItemName: z.string().min(1).max(256),
      })
      .strict(),
    z.object({ action: z.literal("stop-preview") }).strict(),
    z
      .object({
        action: z.literal("hot-swap"),
        target: workflowDeviceTargetSchema,
        expectedItemReference: referenceSchema,
        expectedItemRoot: browserRootKeySchema,
        expectedItemPath: z.array(browserPathSegmentSchema).max(16),
        expectedItemUri: z.string().max(2048),
        expectedItemName: z.string().min(1).max(256),
      })
      .strict(),
    z
      .object({
        action: z.literal("insert-adjacent"),
        target: workflowDeviceTargetSchema,
        placement: z.enum(["before", "after"]),
        expectedItemReference: referenceSchema,
        expectedItemRoot: browserRootKeySchema,
        expectedItemPath: z.array(browserPathSegmentSchema).max(16),
        expectedItemUri: z.string().max(2048),
        expectedItemName: z.string().min(1).max(256),
      })
      .strict(),
    z
      .object({
        action: z.literal("load-empty-drum-pad"),
        rack: workflowDeviceTargetSchema,
        note: z.number().int().min(0).max(127),
        expectedPadReference: referenceSchema,
        expectedItemReference: referenceSchema,
        expectedItemRoot: browserRootKeySchema,
        expectedItemPath: z.array(browserPathSegmentSchema).max(16),
        expectedItemUri: z.string().max(2048),
        expectedItemName: z.string().min(1).max(256),
      })
      .strict(),
  ],
);
const browserAdapterStateSchema = z
  .object({
    previewing: z.boolean().nullable(),
    hotswap: z.boolean().nullable(),
    filterType: z.number().int().nullable(),
    deviceInsertMode: z.number().int().nullable(),
    selectionRestored: z.boolean(),
  })
  .strict();
const browserAdapterResult = <T extends string>(action: T) =>
  z
    .object({
      action: z.literal(action),
      before: browserAdapterStateSchema,
      after: browserAdapterStateSchema,
      verified: z.literal(true),
      warnings: z.array(warningSchema).max(8),
    })
    .strict();
export const browserAdapterOperationResultSchema = z.discriminatedUnion(
  "action",
  [
    browserAdapterResult("preview"),
    browserAdapterResult("stop-preview"),
    browserAdapterResult("hot-swap"),
    browserAdapterResult("insert-adjacent"),
    browserAdapterResult("load-empty-drum-pad"),
  ],
);

const envelopeParameterSchema = z
  .object({
    index: z.number().int().nonnegative(),
    reference: referenceSchema,
    name: nameSchema,
    min: z.number().finite(),
    max: z.number().finite(),
    isQuantized: z.boolean(),
  })
  .strict();
const workflowSessionClipTargetSchema = workflowClipTargetSchema.options[0];
const envelopeTargetSchema = z
  .object({
    clip: workflowSessionClipTargetSchema,
    parameter: z
      .object({
        index: z.number().int().nonnegative(),
        expectedReference: referenceSchema,
        expectedName: nameSchema,
      })
      .strict(),
  })
  .strict();
export const clipAutomationOperationParamsSchema = z.discriminatedUnion(
  "action",
  [
    z
      .object({
        action: z.literal("list-envelopes"),
        target: workflowSessionClipTargetSchema,
        ...boundedPage,
      })
      .strict(),
    z
      .object({
        action: z.literal("sample"),
        target: envelopeTargetSchema,
        startTime: finiteBeatSchema,
        endTime: finiteBeatSchema,
        sampleCount: z.number().int().min(1).max(512),
      })
      .strict()
      .refine(
        (v) => v.endTime >= v.startTime,
        "endTime must not precede startTime",
      ),
    z
      .object({
        action: z.literal("insert-step"),
        target: envelopeTargetSchema,
        time: finiteBeatSchema,
        duration: z.number().finite().positive().max(65_536),
        value: z.number().finite(),
      })
      .strict(),
    z
      .object({
        action: z.literal("clear-envelope"),
        target: envelopeTargetSchema,
        confirmation: z.literal("clear-session-clip-envelope"),
      })
      .strict(),
    z
      .object({
        action: z.literal("clear-all"),
        target: workflowSessionClipTargetSchema,
        confirmation: z.literal("clear-all-session-clip-envelopes"),
      })
      .strict(),
  ],
);
const envelopeSampleSchema = z
  .object({ time: finiteBeatSchema, value: z.number().finite() })
  .strict();
export const clipAutomationOperationResultSchema = z.discriminatedUnion(
  "action",
  [
    z
      .object({
        action: z.literal("list-envelopes"),
        parameters: z.array(envelopeParameterSchema).max(256),
        total: z.number().int().nonnegative(),
        offset: z.number().int().nonnegative(),
        limit: z.number().int().positive(),
      })
      .strict(),
    z
      .object({
        action: z.literal("sample"),
        samples: z.array(envelopeSampleSchema).max(512),
      })
      .strict(),
    z
      .object({
        action: z.literal("insert-step"),
        beforeValue: z.number().finite(),
        afterValue: z.number().finite(),
        verified: z.literal(true),
      })
      .strict(),
    z
      .object({
        action: z.literal("clear-envelope"),
        cleared: z.literal(true),
        verified: z.literal(true),
      })
      .strict(),
    z
      .object({
        action: z.literal("clear-all"),
        cleared: z.literal(true),
        verified: z.literal(true),
      })
      .strict(),
  ],
);

export const workflowWarpMarkerSchema = z
  .object({
    beatTime: finiteBeatSchema,
    sampleTime: z.number().finite().min(0),
    segmentBpm: z.number().finite().positive().max(999).nullable(),
  })
  .strict();
const workflowWarpMarkerMutationSchema = z
  .object({
    beatTime: finiteBeatSchema,
    sampleTime: z.number().finite().min(0),
  })
  .strict();
const warpSnapshotSchema = z
  .object({
    clipReference: referenceSchema,
    revision: z.string().min(16).max(128),
    markers: z.array(workflowWarpMarkerSchema).max(2048),
  })
  .strict();
export const warpMarkerOperationParamsSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("inspect"),
      target: workflowClipTargetSchema,
      ...boundedPage,
    })
    .strict(),
  z
    .object({
      action: z.literal("add"),
      target: workflowClipTargetSchema,
      snapshotRevision: z.string().min(16).max(128),
      marker: workflowWarpMarkerMutationSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("move"),
      target: workflowClipTargetSchema,
      snapshotRevision: z.string().min(16).max(128),
      expectedMarker: workflowWarpMarkerSchema,
      marker: workflowWarpMarkerMutationSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("remove"),
      target: workflowClipTargetSchema,
      snapshotRevision: z.string().min(16).max(128),
      expectedMarker: workflowWarpMarkerSchema,
    })
    .strict(),
]);
export const warpMarkerOperationResultSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("inspect"),
      snapshot: warpSnapshotSchema,
      total: z.number().int().nonnegative(),
      offset: z.number().int().nonnegative(),
      limit: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      action: z.literal("add"),
      before: warpSnapshotSchema,
      after: warpSnapshotSchema,
      verified: z.literal(true),
      rolledBack: z.boolean(),
    })
    .strict(),
  z
    .object({
      action: z.literal("move"),
      before: warpSnapshotSchema,
      after: warpSnapshotSchema,
      verified: z.literal(true),
      rolledBack: z.boolean(),
    })
    .strict(),
  z
    .object({
      action: z.literal("remove"),
      before: warpSnapshotSchema,
      after: warpSnapshotSchema,
      verified: z.literal(true),
      rolledBack: z.boolean(),
    })
    .strict(),
]);

export const specializedDeviceOperationParamsSchema = z.discriminatedUnion(
  "action",
  [
    z
      .object({
        action: z.literal("inspect-simpler"),
        target: workflowDeviceTargetSchema,
      })
      .strict(),
    z
      .object({
        action: z.literal("set-simpler-markers"),
        target: workflowDeviceTargetSchema,
        start: z.number().finite().min(0).max(1),
        end: z.number().finite().min(0).max(1),
        loopStart: z.number().finite().min(0).max(1).optional(),
        loopEnd: z.number().finite().min(0).max(1).optional(),
      })
      .strict()
      .refine(
        (v) =>
          v.end > v.start &&
          (v.loopStart === undefined ||
            v.loopEnd === undefined ||
            v.loopEnd > v.loopStart),
        "Simpler marker ranges must be ordered",
      ),
    z
      .object({
        action: z.literal("set-simpler-slices"),
        target: workflowDeviceTargetSchema,
        slices: z
          .array(z.number().finite().min(0).max(1))
          .max(128)
          .refine(
            (v) => v.every((n, i) => i === 0 || n > v[i - 1]!),
            "Slices must be strictly ordered",
          ),
      })
      .strict(),
    z
      .object({
        action: z.literal("inspect-looper"),
        target: workflowDeviceTargetSchema,
      })
      .strict(),
    z
      .object({
        action: z.literal("control-looper"),
        target: workflowDeviceTargetSchema,
        command: z.enum(["record", "play", "overdub", "stop", "clear"]),
      })
      .strict(),
    z
      .object({
        action: z.literal("export-looper"),
        target: workflowDeviceTargetSchema,
        destination: workflowSessionSlotTargetSchema.refine(
          (slot) => !slot.expectedHasClip,
          "Looper export requires an empty audio slot",
        ),
        correlationId: z.string().uuid(),
        causationId: z.string().uuid().optional(),
        traceId: z.string().uuid(),
      })
      .strict(),
    z
      .object({
        action: z.literal("inspect-wavetable"),
        target: workflowDeviceTargetSchema,
      })
      .strict(),
    z
      .object({
        action: z.literal("set-wavetable-modulation"),
        target: workflowDeviceTargetSchema,
        sourceIndex: z.number().int().min(0).max(15),
        targetIndex: z.number().int().min(0).max(255),
        amount: z.number().finite().min(-1).max(1),
      })
      .strict(),
  ],
);
const specializedStateSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.number())]),
);
export const specializedDeviceOperationResultSchema = z.discriminatedUnion(
  "action",
  [
    z
      .object({
        action: z.literal("inspect-simpler"),
        state: specializedStateSchema,
      })
      .strict(),
    z
      .object({
        action: z.literal("set-simpler-markers"),
        before: specializedStateSchema,
        after: specializedStateSchema,
        verified: z.literal(true),
      })
      .strict(),
    z
      .object({
        action: z.literal("set-simpler-slices"),
        before: specializedStateSchema,
        after: specializedStateSchema,
        verified: z.literal(true),
      })
      .strict(),
    z
      .object({
        action: z.literal("inspect-looper"),
        state: specializedStateSchema,
      })
      .strict(),
    z
      .object({
        action: z.literal("control-looper"),
        before: specializedStateSchema,
        after: specializedStateSchema,
        verified: z.literal(true),
      })
      .strict(),
    z
      .object({
        action: z.literal("export-looper"),
        job: workflowJobStatusSchema,
      })
      .strict(),
    z
      .object({
        action: z.literal("inspect-wavetable"),
        state: specializedStateSchema,
      })
      .strict(),
    z
      .object({
        action: z.literal("set-wavetable-modulation"),
        before: specializedStateSchema,
        after: specializedStateSchema,
        verified: z.literal(true),
      })
      .strict(),
  ],
);

export const workflowJobOperationParamsSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("get"), jobId: z.string().uuid() }).strict(),
  z.object({ action: z.literal("list"), ...boundedPage }).strict(),
  z.object({ action: z.literal("cancel"), jobId: z.string().uuid() }).strict(),
]);
export const workflowJobOperationResultSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("get"), job: workflowJobStatusSchema }).strict(),
  z
    .object({
      action: z.literal("list"),
      jobs: z.array(workflowJobStatusSchema).max(256),
      total: z.number().int().nonnegative(),
      offset: z.number().int().nonnegative(),
      limit: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      action: z.literal("cancel"),
      job: workflowJobStatusSchema,
      cancelled: z.boolean(),
    })
    .strict(),
]);

export type RecordingOperationParams = z.infer<
  typeof recordingOperationParamsSchema
>;
export type RecordingOperationResult = z.infer<
  typeof recordingOperationResultSchema
>;
export type GrooveOperationParams = z.infer<typeof grooveOperationParamsSchema>;
export type GrooveOperationResult = z.infer<typeof grooveOperationResultSchema>;
export type SelectionViewOperationParams = z.infer<
  typeof selectionViewOperationParamsSchema
>;
export type SelectionViewOperationResult = z.infer<
  typeof selectionViewOperationResultSchema
>;
export type LiveHistoryOperationParams = z.infer<
  typeof liveHistoryOperationParamsSchema
>;
export type LiveHistoryOperationResult = z.infer<
  typeof liveHistoryOperationResultSchema
>;
export type BrowserAdapterOperationParams = z.infer<
  typeof browserAdapterOperationParamsSchema
>;
export type BrowserAdapterOperationResult = z.infer<
  typeof browserAdapterOperationResultSchema
>;
export type ClipAutomationOperationParams = z.infer<
  typeof clipAutomationOperationParamsSchema
>;
export type ClipAutomationOperationResult = z.infer<
  typeof clipAutomationOperationResultSchema
>;
export type WarpMarkerOperationParams = z.infer<
  typeof warpMarkerOperationParamsSchema
>;
export type WarpMarkerOperationResult = z.infer<
  typeof warpMarkerOperationResultSchema
>;
export type SpecializedDeviceOperationParams = z.infer<
  typeof specializedDeviceOperationParamsSchema
>;
export type SpecializedDeviceOperationResult = z.infer<
  typeof specializedDeviceOperationResultSchema
>;
export type WorkflowJobOperationParams = z.infer<
  typeof workflowJobOperationParamsSchema
>;
export type WorkflowJobOperationResult = z.infer<
  typeof workflowJobOperationResultSchema
>;
export type WorkflowJobStatus = z.infer<typeof workflowJobStatusSchema>;
export type WorkflowJobLifecyclePayload = z.infer<
  typeof workflowJobLifecyclePayloadSchema
>;
