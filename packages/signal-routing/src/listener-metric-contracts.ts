import { z } from "zod";
import {
  assertNativeMetricArmProof,
  assertNativeMetricReadyProof,
  assertNativeMetricObservationSource,
  assertNativeMetricSourceCoverage,
  metricAudioObservationSchema,
  metricObservationMetricSchema,
  listenerMetricRegistrationMetadataSchema,
  refineListenerMetricRegistrationMetadata,
  nativeListenerLifecycleSchema,
  listeningFailureFactSchema,
  nativeMetricArmProofSchema,
  nativeMetricReadyProofSchema,
  nativeMetricLaunchProofSchema,
  nativeMetricListeningConfigSchema,
  nativeMetricSourceCoverageProofSchema,
  NATIVE_METRIC_LISTENING_SCOPE,
  NATIVE_METRIC_LISTENING_CAPABILITY,
  NATIVE_MEL_BAND_LISTENING_CAPABILITY,
  NATIVE_METRIC_ALGORITHM_VERSION,
  MAX_METRIC_RESULT_FRAME_BYTES,
  type NativeMetricArmProof,
} from "@ableton-agent/protocol";
import {
  DEFAULT_MAX_INGRESS_FRAME_BYTES,
  outputProducerSchema,
} from "./contracts.js";
import {
  listenerPathsHaveSameOwner,
  listenerRegistrationBaseSchema,
} from "./listener-contracts.js";

export { nativeMetricListeningConfigSchema };
export {
  listenerNativeMetricStatusSchema,
  type ListenerNativeMetricStatus,
} from "@ableton-agent/protocol";

export const LISTENER_VERSION_METRIC = 5 as const;
export const LISTENER_CAPABILITY_METRIC = NATIVE_METRIC_LISTENING_CAPABILITY;
export const LISTENER_CAPABILITY_MEL = NATIVE_MEL_BAND_LISTENING_CAPABILITY;
export const LISTENER_METRIC_SCOPE = NATIVE_METRIC_LISTENING_SCOPE;
export const LISTENER_METRIC_ALGORITHM_VERSION =
  NATIVE_METRIC_ALGORITHM_VERSION;
export const LISTENER_METRIC_PRODUCER_SCHEMA_VERSION =
  "metric-audio-observation/v1" as const;

/** Separate producer contract; not installed in the advertised ingress union. */
export const listenerMetricProducerSchema = z
  .strictObject({
    ...outputProducerSchema.shape,
    signalKind: z.literal("audio"),
    schemaVersion: z.literal(LISTENER_METRIC_PRODUCER_SCHEMA_VERSION),
  })
  .superRefine((value, ctx) =>
    enforceFrameQuota(value, ctx, DEFAULT_MAX_INGRESS_FRAME_BYTES),
  );

const identifier = z.string().min(1).max(128);
const sequence = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const wire = {
  protocolVersion: z.literal(1),
  listenerVersion: z.literal(LISTENER_VERSION_METRIC),
  mode: z.enum(["arrangement", "session"]),
  listenerId: identifier,
  connectionId: z.string().uuid(),
  connectionEpoch: z.string().uuid(),
  generation: z.string().uuid(),
  requestId: identifier,
  jobId: identifier,
  passId: identifier,
  traceId: z.string().uuid(),
  correlationId: identifier,
  causationId: identifier,
  sequence,
};
export const listenerMetricWireIdentitySchema = z.strictObject(wire);
type WireIdentity = z.infer<typeof listenerMetricWireIdentitySchema>;
const reason = z.string().min(1).max(512);

export const listenerRegistrationMetricSchema = z
  .strictObject({
    ...listenerRegistrationBaseSchema.shape,
    ...listenerMetricRegistrationMetadataSchema.shape,
    version: z.literal(LISTENER_VERSION_METRIC),
    connectionEpoch: z.string().uuid(),
  })
  .refine(listenerPathsHaveSameOwner, "Listener paths require the same owner")
  .superRefine(refineListenerMetricRegistrationMetadata)
  .superRefine((value, ctx) => {
    const status = value.nativeStatus;
    if (
      status.readiness === "READY" &&
      (!status.acceptedSampleRates.some((rate) => rate === value.sampleRate) ||
        !status.acceptedVectorSizes.includes(value.vectorSize) ||
        status.executedGen?.config.geometry.sampleRate !== value.sampleRate ||
        status.executedGen.config.geometry.vectorSize !== value.vectorSize ||
        status.executedGen.ownership.connectionEpoch !== value.connectionEpoch)
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "Ready metric registration disagrees with executed DSP geometry",
      });
    }
    enforceFrameQuota(value, ctx);
  });

export const listenerControlMetricSchema = z
  .strictObject({
    ...wire,
    type: z.literal("listener.control"),
    action: z.enum(["prepare", "arm", "cancel"]),
    config: nativeMetricListeningConfigSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (
      (value.action === "prepare") !== (value.config !== undefined) ||
      (value.config !== undefined && value.config.mode !== value.mode)
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "Only prepare carries immutable metric configuration for its exact mode",
      });
    }
    enforceFrameQuota(value, ctx);
  });

function expectation(
  value: WireIdentity,
  proof: Pick<NativeMetricArmProof, "ownership" | "config">,
) {
  return {
    listenerId: value.listenerId,
    passId: value.passId,
    connectionEpoch: value.connectionEpoch,
    connectionId: value.connectionId,
    traceId: value.traceId,
    correlationId: value.correlationId,
    causationId: value.causationId,
    generation: value.generation,
    nativeEpoch: proof.ownership.nativeEpoch,
    config: proof.config,
  };
}

function validateProof(action: () => void, ctx: z.RefinementCtx): void {
  try {
    action();
  } catch (cause) {
    ctx.addIssue({
      code: "custom",
      message:
        cause instanceof Error
          ? cause.message.slice(0, 512)
          : "Invalid native metric proof",
    });
  }
}

function validateArm(
  value: WireIdentity,
  proof: NativeMetricArmProof,
  ctx: z.RefinementCtx,
): void {
  if (proof.config.mode !== value.mode) {
    ctx.addIssue({
      code: "custom",
      message: "Native metric proof mode mismatch",
    });
  }
  validateProof(() => {
    assertNativeMetricArmProof(proof, expectation(value, proof));
  }, ctx);
}

export const listenerReplyMetricSchema = z
  .strictObject({
    ...wire,
    type: z.literal("listener.reply"),
    status: z.enum(["ready", "armed", "cancelled", "failed"]),
    reason: reason.optional(),
    nativeReady: nativeMetricReadyProofSchema.optional(),
    nativeArm: nativeMetricArmProofSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (
      (value.status === "ready") !== (value.nativeReady !== undefined) ||
      (value.status === "armed") !== (value.nativeArm !== undefined) ||
      (["failed", "cancelled"].includes(value.status) &&
        value.reason === undefined)
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "Metric reply requires exact readiness/arm evidence or a terminal failure/cancellation reason",
      });
    }
    if (value.nativeReady !== undefined) {
      const proof = value.nativeReady;
      if (proof.config.mode !== value.mode) {
        ctx.addIssue({
          code: "custom",
          message: "Native readiness mode mismatch",
        });
      }
      validateProof(() => {
        assertNativeMetricReadyProof(proof, expectation(value, proof));
      }, ctx);
    }
    if (value.nativeArm !== undefined) validateArm(value, value.nativeArm, ctx);
    enforceFrameQuota(value, ctx);
  });

export const nativeMetricLifecycleSchema = z.strictObject({
  ...nativeListenerLifecycleSchema.shape,
  durationMs: z.number().finite().min(0).max(120_000).optional(),
  facts: z.array(listeningFailureFactSchema).max(24).optional(),
  scope: z.literal(LISTENER_METRIC_SCOPE),
  // Stock FluCoMa smoke scopes are diagnostics, not registered observations.
  metric: z
    .enum([
      ...metricObservationMetricSchema.options,
      "spectral-flatness",
      "spectral-spread",
      "spectral-rolloff",
      "monophonic-pitch",
    ])
    .optional(),
  generation: z.string().uuid(),
  nativeEpoch: z.number().int().min(1).max(1_000_000),
  frames: z.number().int().min(0).max(2_000),
  phase: z
    .enum([
      "preflight",
      "configuration",
      "arm",
      "launch",
      "capture",
      "drain",
      "post-binding",
    ])
    .optional(),
});

export const listenerResultMetricSchema = z
  .strictObject({
    ...wire,
    type: z.literal("listener.result"),
    status: z.enum(["progress", "completed", "partial", "failed", "cancelled"]),
    observation: metricAudioObservationSchema.optional(),
    nativeSourceCoverage: nativeMetricSourceCoverageProofSchema.optional(),
    nativeLaunch: nativeMetricLaunchProofSchema.optional(),
    nativeLifecycle: nativeMetricLifecycleSchema.optional(),
    reason: reason.optional(),
  })
  .superRefine((value, ctx) => {
    const terminalPublication =
      value.status === "completed" || value.status === "partial";
    if (
      terminalPublication !== (value.observation !== undefined) ||
      terminalPublication !== (value.nativeSourceCoverage !== undefined) ||
      (value.nativeLaunch !== undefined && value.status !== "progress") ||
      (["failed", "cancelled"].includes(value.status) &&
        value.reason === undefined) ||
      (value.status === "progress" &&
        value.nativeLaunch === undefined &&
        value.nativeLifecycle === undefined)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Invalid independent metric publication stage/evidence",
      });
    }
    // Lifecycle causation names its stage parent, not the immutable capture origin.
    const lifecycle = value.nativeLifecycle;
    if (
      lifecycle !== undefined &&
      (lifecycle.generation !== value.generation ||
        (value.status === "progress"
          ? ["failed", "cancelled"].includes(lifecycle.stage) &&
            lifecycle.metric === undefined
          : lifecycle.stage !== value.status ||
            !["failed", "cancelled"].includes(value.status)) ||
        (["failed", "cancelled"].includes(lifecycle.stage) &&
          lifecycle.reason === undefined))
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Metric lifecycle stage or ownership mismatch",
      });
    }
    if (value.nativeLaunch !== undefined) {
      const owner = value.nativeLaunch.ownership;
      if (
        owner.listenerId !== value.listenerId ||
        owner.passId !== value.passId ||
        owner.connectionEpoch !== value.connectionEpoch ||
        owner.connectionId !== value.connectionId ||
        owner.traceId !== value.traceId ||
        owner.correlationId !== value.correlationId ||
        owner.causationId !== value.causationId ||
        owner.generation !== value.generation ||
        (lifecycle !== undefined && lifecycle.nativeEpoch !== owner.nativeEpoch)
      ) {
        ctx.addIssue({
          code: "custom",
          message: "Metric launch owner mismatch",
        });
      }
    }
    const observation = value.observation;
    const proof = value.nativeSourceCoverage;
    if (observation !== undefined) {
      const owner = observation.ownership;
      const ownerFields = [
        "listenerId",
        "passId",
        "connectionId",
        "connectionEpoch",
        "generation",
        "traceId",
        "correlationId",
        "causationId",
      ] as const;
      if (
        ownerFields.some((field) => owner[field] !== value[field]) ||
        observation.source.view !== value.mode ||
        observation.outcome !==
          (value.status === "completed" ? "complete" : "partial")
      ) {
        ctx.addIssue({
          code: "custom",
          message: "Metric observation outcome or wire provenance mismatch",
        });
      }
    }
    if (proof !== undefined) {
      validateArm(value, proof.armed, ctx);
      validateProof(() => {
        const expected = expectation(value, proof.armed);
        if (observation === undefined) {
          assertNativeMetricSourceCoverage(proof, expected);
        } else {
          assertNativeMetricObservationSource(proof, observation, expected);
        }
      }, ctx);
    }
    enforceFrameQuota(value, ctx);
  });

export type ListenerRegistrationMetric = z.infer<
  typeof listenerRegistrationMetricSchema
>;
export type ListenerControlMetric = z.infer<typeof listenerControlMetricSchema>;
export type ListenerReplyMetric = z.infer<typeof listenerReplyMetricSchema>;
export type ListenerResultMetric = z.infer<typeof listenerResultMetricSchema>;
export type NativeMetricLifecycle = z.infer<typeof nativeMetricLifecycleSchema>;
export type ListenerMetricProducer = z.infer<
  typeof listenerMetricProducerSchema
>;

function enforceFrameQuota(
  value: unknown,
  ctx: z.RefinementCtx,
  byteLimit = MAX_METRIC_RESULT_FRAME_BYTES,
): void {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > byteLimit) {
    ctx.addIssue({
      code: "custom",
      message:
        "Independent metric listener message exceeds ingress frame quota",
    });
  }
}
