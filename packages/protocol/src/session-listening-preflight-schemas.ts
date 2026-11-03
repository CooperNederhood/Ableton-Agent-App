import { z } from "zod";
import { audioClipSummarySchema } from "./core-domain-schemas.js";
import {
  deviceSummarySchema,
  deviceParameterSummarySchema,
  inspectDevicesResultSchema,
  inspectDeviceParametersResultSchema,
  inspectMidiNotesResultSchema,
} from "./schemas.js";
import { inspectSessionListeningSourceResultSchema } from "./session-listening-source-schemas.js";
import { recordingOperationResultSchema } from "./workflow-adapter-schemas.js";

const common = {
  source: inspectSessionListeningSourceResultSchema,
  recording: recordingOperationResultSchema.options[0],
};

export const SESSION_PREFLIGHT_DEVICE_LIMIT = 8;
const preflightDeviceSchema = deviceSummarySchema.extend({
  name: z.string().max(512),
  className: z.string().max(512),
  classDisplayName: z.string().max(512),
  parameterCount: z.number().int().min(0).max(256),
  canHaveChains: z.literal(false),
  canHaveDrumPads: z.literal(false),
});

export const sessionPreflightDeviceInventorySchema = inspectDevicesResultSchema
  .extend({
    devices: z.array(preflightDeviceSchema).max(SESSION_PREFLIGHT_DEVICE_LIMIT),
  })
  .refine(
    ({ devices, total, offset, limit }) =>
      offset === 0 &&
      total === devices.length &&
      devices.length <= limit &&
      new Set(devices.map((device) => device.reference)).size ===
        devices.length &&
      devices.every((device, index) => device.index === index),
    "MIDI preflight requires a complete bounded flat device inventory",
  );

export const sessionPreflightDeviceParametersSchema =
  inspectDeviceParametersResultSchema
    .extend({
      device: preflightDeviceSchema,
      parameters: z
        .array(
          deviceParameterSummarySchema.extend({ name: z.string().max(512) }),
        )
        .max(256),
    })
    .refine(
      ({ device, parameters, total, offset, limit }) =>
        offset === 0 &&
        total === device.parameterCount &&
        total === parameters.length &&
        parameters.length <= limit &&
        new Set(parameters.map((parameter) => parameter.reference)).size ===
          parameters.length &&
        parameters.every(
          (parameter, index) =>
            parameter.index === index &&
            parameter.deviceReference === device.reference,
        ),
      "MIDI preflight requires complete parameters for the inspected device",
    );

const instrumentChainSchema = z
  .strictObject({
    before: sessionPreflightDeviceInventorySchema,
    devices: z
      .array(sessionPreflightDeviceParametersSchema)
      .max(SESSION_PREFLIGHT_DEVICE_LIMIT),
    after: sessionPreflightDeviceInventorySchema,
  })
  .refine(
    ({ before, devices, after }) =>
      JSON.stringify(before.devices) === JSON.stringify(after.devices) &&
      devices.length === before.devices.length &&
      devices.every(
        ({ device }, index) =>
          JSON.stringify(device) === JSON.stringify(before.devices[index]),
      ),
    "MIDI device inventory changed during preflight",
  );

export const sessionListeningPreflightResultSchema = z.union([
  z
    .strictObject({
      ...common,
      audio: audioClipSummarySchema,
    })
    .refine(
      ({ source, audio }) =>
        source.sourceKind !== "midi" &&
        audio.reference === source.target.expectedClipReference &&
        audio.name === source.target.expectedClipName,
      "Audio inspection must belong to the inspected Session clip",
    ),
  z
    .strictObject({
      ...common,
      midi: inspectMidiNotesResultSchema,
      instrumentChain: instrumentChainSchema,
    })
    .refine(
      ({ source, midi }) =>
        source.sourceKind === "midi" &&
        midi.clip.reference === source.target.expectedClipReference &&
        midi.clip.name === source.target.expectedClipName &&
        midi.clip.trackReference === source.target.track.expectedReference &&
        midi.clip.trackIndex === source.target.track.index &&
        midi.clip.sceneIndex === source.target.sceneIndex,
      "MIDI inspection must belong to the inspected Session clip and track",
    )
    .refine(
      ({ midi }) =>
        !midi.truncated &&
        midi.offset === 0 &&
        midi.notes.length <= midi.limit &&
        midi.totalNotes === midi.notes.length &&
        midi.clip.noteCount === midi.totalNotes,
      "MIDI preflight requires complete bounded note evidence",
    )
    .refine(
      ({ source, instrumentChain }) =>
        instrumentChain.before.devices.every(
          (device) =>
            device.trackReference === source.target.track.expectedReference &&
            device.trackIndex === source.target.track.index,
        ),
      "MIDI device inventory must belong to the inspected track",
    ),
]);

export type SessionListeningPreflightResult = z.infer<
  typeof sessionListeningPreflightResultSchema
>;
