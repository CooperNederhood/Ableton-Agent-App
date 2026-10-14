import { z } from "zod";
import { NATIVE_LISTENER_SCOPE } from "./native-listening-schemas.js";
import {
  workflowClipTargetSchema,
  workflowDeviceTargetSchema,
} from "./workflow-adapter-schemas.js";

const beat = z.number().finite().min(0).max(1_576_800);
const indexToken = "(?:0|[1-9][0-9]{0,2})";
const trackPathPattern = `live_set (?:tracks ${indexToken}|return_tracks ${indexToken}|master_track)`;
export const listeningCanonicalTrackPathSchema = z
  .string()
  .max(128)
  .regex(new RegExp(`^${trackPathPattern}$`))
  .refine((path) => {
    const match = /(?:tracks|return_tracks) ([0-9]+)$/.exec(path);
    return match === null || Number(match[1]) < 256;
  });
export const listeningCanonicalDevicePathSchema = z
  .string()
  .max(256)
  .regex(new RegExp(`^${trackPathPattern} devices ${indexToken}$`))
  .refine((path) => {
    const parts = path.split(" devices ");
    return (
      listeningCanonicalTrackPathSchema.safeParse(parts[0]).success &&
      Number(parts[1]) < 32
    );
  });
// Recognized rack paths are bounded but not yet independently attestable.
const reportedPathSchema = z
  .string()
  .max(512)
  .regex(
    new RegExp(
      `^${trackPathPattern} devices ${indexToken}(?: chains ${indexToken} devices ${indexToken}){0,4}$`,
    ),
  );
export const listeningPathSelectorSchema = z
  .object({ canonicalPath: reportedPathSchema })
  .strict();
export const listeningPathAttestationSchema = z
  .object({
    schemaVersion: z.literal(1),
    source: z.literal("remote-script-lom"),
    canonicalDevicePath: listeningCanonicalDevicePathSchema,
    canonicalTrackPath: listeningCanonicalTrackPathSchema,
    trackReference: z.string().uuid(),
    deviceReference: z.string().uuid(),
    placement: z
      .object({
        kind: z.literal("track-device"),
        deviceIndex: z.number().int().min(0).max(31),
      })
      .strict(),
  })
  .strict()
  .refine(
    (value) =>
      value.canonicalDevicePath ===
      `${value.canonicalTrackPath} devices ${value.placement.deviceIndex}`,
    { message: "Attested path must match its exact placement" },
  );
/** Producer-reported readiness only; never a timing or ownership certificate. */
export const listenerNativeStatusSchema = z
  .object({
    version: z.literal(1),
    timing: z.enum(["UNVERIFIED", "VERIFIED"]),
    readiness: z.enum(["BLOCKED", "READY"]),
    scope: z.literal(NATIVE_LISTENER_SCOPE).optional(),
    reason: z.string().min(1).max(128).optional(),
  })
  .strict()
  .refine(
    (value) =>
      (value.timing === "VERIFIED" && value.readiness === "READY") ||
      value.reason !== undefined,
    { message: "Unverified or blocked native status requires a reason" },
  );
export type ListenerNativeStatus = z.infer<typeof listenerNativeStatusSchema>;
const scalar = z.union([
  z.number().finite(),
  z.boolean(),
  z.string().max(1024),
  z.null(),
]);
const evidence = z
  .object({ field: z.string().max(64), value: scalar })
  .strict();
export const listeningDependencyFingerprintSchema = z
  .object({
    algorithm: z.literal("sha256"),
    scope: z.literal("available-live-fields/v1"),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    completeness: z.enum(["complete", "unknown"]),
    unknownReasons: z.array(z.string().max(128)).max(16),
  })
  .strict()
  .refine(
    (value) =>
      value.completeness !== "complete" || value.unknownReasons.length === 0,
    { message: "Incomplete evidence cannot claim a complete fingerprint" },
  );

export const inspectListeningContextParamsSchema = z
  .object({
    schemaVersion: z.literal(1),
    bindingQueryId: z.string().uuid().optional(),
    listeners: z
      .array(z.union([workflowDeviceTargetSchema, listeningPathSelectorSchema]))
      .min(1)
      .max(8),
    range: z.object({ startBeat: beat, endBeat: beat }).strict(),
    maxClips: z.number().int().min(1).max(64).default(32),
    maxParameters: z.number().int().min(1).max(32).default(16),
  })
  .strict()
  .refine((value) => value.range.endBeat > value.range.startBeat, {
    message: "Listening range must be nonempty",
  })
  .refine(
    (value) =>
      new Set(
        value.listeners.map((item) =>
          "canonicalPath" in item
            ? `path:${item.canonicalPath}`
            : item.expectedDeviceReference,
        ),
      ).size === value.listeners.length,
    { message: "Listener bindings must be unique" },
  );

const clip = z
  .object({
    target: workflowClipTargetSchema,
    interval: z
      .object({ startBeat: beat, endBeat: beat })
      .strict()
      .refine((value) => value.endBeat > value.startBeat, {
        message: "Clip intervals must be nonempty and ordered",
      })
      .nullable(),
    activity: z.enum(["active", "inactive", "unknown"]),
    isAudioClip: z.boolean().nullable(),
    isRecording: z.boolean().nullable(),
    settings: z.array(evidence).max(24),
    fingerprint: listeningDependencyFingerprintSchema,
  })
  .strict()
  .refine(
    (value) =>
      value.target.view === "session"
        ? value.interval === null
        : value.interval !== null &&
          value.interval.startBeat === value.target.expectedStartTime,
    {
      message: "Clip intervals must match their exact view and inspected start",
    },
  );

export const inspectListeningContextResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    bindingQueryId: z.string().uuid().optional(),
    projectRevision: z.number().int().nonnegative(),
    bindingScope: z.literal("live-connection"),
    transport: z
      .object({
        playing: z.boolean().nullable(),
        currentBeat: beat.nullable(),
        tempo: z.number().finite().positive().nullable(),
        recording: z
          .object({
            recordMode: z.boolean().nullable(),
            sessionRecord: z.boolean().nullable(),
            arrangementOverdub: z.boolean().nullable(),
            sessionAutomationRecord: z.boolean().nullable(),
          })
          .strict(),
        safeToStart: z.boolean(),
      })
      .strict(),
    listeners: z
      .array(
        z
          .object({
            binding: workflowDeviceTargetSchema,
            verified: z.literal(true),
            canonicalPath: z.string().max(1024),
            pathAttestation: listeningPathAttestationSchema.optional(),
            enabled: z.boolean().nullable(),
            sessionOverride: z.boolean().nullable(),
            clips: z.array(clip).max(64),
            clipsTruncated: z.boolean(),
            trackEvidence: z.array(evidence).max(24),
            upstreamDevices: z
              .array(
                z
                  .object({
                    reference: z.string().uuid(),
                    name: z.string().max(128),
                    className: z.string().max(128),
                    enabled: z.boolean().nullable(),
                    parameters: z
                      .array(
                        z
                          .object({
                            reference: z.string().uuid(),
                            name: z.string().max(128),
                            value: z.number().finite().nullable(),
                          })
                          .strict(),
                      )
                      .max(32),
                  })
                  .strict(),
              )
              .max(32),
            dependenciesTruncated: z.boolean(),
            fingerprint: listeningDependencyFingerprintSchema,
            attribution: z.literal("nonexclusive"),
            unknownReasons: z.array(z.string().max(128)).max(16),
          })
          .strict()
          .refine(
            (value) => {
              const attestation = value.pathAttestation;
              if (attestation === undefined) return true;
              const track = value.binding.track;
              const trackPath =
                track.kind === "master"
                  ? "live_set master_track"
                  : `live_set ${track.kind === "return" ? "return_tracks" : "tracks"} ${track.index}`;
              return (
                attestation.canonicalDevicePath === value.canonicalPath &&
                attestation.canonicalTrackPath === trackPath &&
                attestation.deviceReference ===
                  value.binding.expectedDeviceReference &&
                attestation.trackReference === track.expectedReference &&
                attestation.placement.deviceIndex === value.binding.deviceIndex
              );
            },
            {
              message:
                "Path attestation must match the inspected bridge binding",
            },
          ),
      )
      .min(1)
      .max(8),
  })
  .strict()
  .refine(
    (value) =>
      !value.transport.safeToStart ||
      (value.transport.playing === false &&
        Object.values(value.transport.recording).every(
          (flag) => flag === false,
        ) &&
        value.listeners.every(
          (listener) =>
            !listener.clipsTruncated &&
            !listener.unknownReasons.includes(
              "arrangement-interval-unavailable",
            ) &&
            !listener.unknownReasons.includes("session-slot-trigger-pending") &&
            listener.clips.every((clip) => clip.isRecording === false),
        )),
    {
      message:
        "Listening start guard must fail closed on recording or unknown evidence",
    },
  );

export type InspectListeningContextParams = z.input<
  typeof inspectListeningContextParamsSchema
>;
export type InspectListeningContextResult = z.infer<
  typeof inspectListeningContextResultSchema
>;
export type ListeningPathAttestation = z.infer<
  typeof listeningPathAttestationSchema
>;

const playbackIdentity = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => value.trim().length > 0);
const playbackStart = {
  schemaVersion: z.literal(1),
  ownerId: playbackIdentity,
  passId: z.string().uuid(),
  expectedLiveSetId: playbackIdentity,
  expectedProjectRevision: z.number().int().nonnegative(),
  listeners: z.array(workflowDeviceTargetSchema).min(1).max(8),
  range: z.object({ startBeat: beat, endBeat: beat }).strict(),
};
export const startListeningPlaybackParamsSchema = z
  .discriminatedUnion("mode", [
    z.object({ ...playbackStart, mode: z.literal("arrangement") }).strict(),
    z
      .object({
        ...playbackStart,
        mode: z.literal("session"),
        clip: workflowClipTargetSchema.refine(
          (value) => value.view === "session",
        ),
      })
      .strict(),
  ])
  .refine((value) => value.range.endBeat > value.range.startBeat)
  .refine(
    (value) =>
      new Set(value.listeners.map((item) => item.expectedDeviceReference))
        .size === value.listeners.length,
  );

/** Connection-owned capability token, never a durable transport identity. */
export const listeningPlaybackOwnershipSchema = z
  .object({
    ownerId: playbackIdentity,
    passId: z.string().uuid(),
    generation: z.string().uuid(),
    liveSetId: playbackIdentity,
  })
  .strict();
export const startListeningPlaybackResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    mode: z.literal("arrangement"),
    cleanupPolicy: z.literal("leave-running"),
    startedAtBeat: beat,
    sourceOnset: z.literal("unverified"),
  })
  .strict();
export const stopListeningPlaybackParamsSchema = z
  .object({
    schemaVersion: z.literal(1),
    ownership: listeningPlaybackOwnershipSchema,
  })
  .strict();
export const stopListeningPlaybackResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    ownership: z.enum(["owned", "lost"]),
    stopped: z.boolean(),
  })
  .strict()
  .refine((value) => value.stopped === (value.ownership === "owned"));
export type StartListeningPlaybackParams = z.input<
  typeof startListeningPlaybackParamsSchema
>;
export type ListeningPlaybackOwnership = z.infer<
  typeof listeningPlaybackOwnershipSchema
>;
export type StartListeningPlaybackResult = z.infer<
  typeof startListeningPlaybackResultSchema
>;
export type StopListeningPlaybackParams = z.infer<
  typeof stopListeningPlaybackParamsSchema
>;
export type StopListeningPlaybackResult = z.infer<
  typeof stopListeningPlaybackResultSchema
>;
