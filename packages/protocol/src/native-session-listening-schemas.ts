import { z } from "zod";
import {
  audioObservationV2Schema,
  type AudioObservationV2,
} from "./audio-observation-schemas.js";
import { inspectSessionListeningSourceParamsSchema } from "./session-listening-source-schemas.js";
import { nativeListeningGeometrySchema } from "./native-listening-geometry.js";
import { listeningTimingPolicySchema } from "./listening-timing-schemas.js";
import { listenerNativeStatusV2Schema } from "./listener-native-status-v2.js";
import {
  nativeArmProofV2Schema,
  nativeLaunchProofV2Schema,
  nativeCaptureProofV2Schema,
  assertNativeArmProofV2,
  nativeLaunchCoordinatesV2,
  assertNativeCaptureObservationV2,
  snapshotNativeListeningExpectationV2,
  type NativeListeningExpectationV2,
} from "./native-listening-v2-schemas.js";

export const NATIVE_SESSION_LISTENER_SCOPE =
  "session-transport-coupled/v1" as const;
/** Expected context only: this is NOT evidence of clip identity, onset or start_time. */
export const sessionNativeSourceSchema = z.strictObject({
  mode: z.literal("session"),
  synchronization: z.literal("transport-coupled-first-iteration"),
  target: inspectSessionListeningSourceParamsSchema.shape.target,
});
export const nativeSessionListeningConfigSchema = z.strictObject({
  geometry: nativeListeningGeometrySchema.refine(
    (g) => g.endBeat - g.startBeat <= 4,
    "Session transport capture is limited to the first four beats",
  ),
  timingPolicy: listeningTimingPolicySchema,
  source: sessionNativeSourceSchema,
});
const wrapper = {
  scope: z.literal(NATIVE_SESSION_LISTENER_SCOPE),
  source: sessionNativeSourceSchema,
};
// The unchanged transport scope is intentional: ABI2 measures transport, not clips.
export const nativeSessionArmProofSchema = z.strictObject({
  ...wrapper,
  transport: nativeArmProofV2Schema,
});
export const nativeSessionLaunchProofSchema = z.strictObject({
  ...wrapper,
  transport: nativeLaunchProofV2Schema,
});
export const nativeSessionCaptureProofSchema = z.strictObject({
  ...wrapper,
  transport: nativeCaptureProofV2Schema,
});
export const listenerNativeSessionStatusSchema = z
  .strictObject({
    ...listenerNativeStatusV2Schema.shape,
    version: z.literal(3),
    scope: z.literal(NATIVE_SESSION_LISTENER_SCOPE),
    sourceEvidence: z.literal("expected-context-only"),
    synchronization: z.literal("transport-coupled-first-iteration"),
    maxDurationBeats: z.literal(4),
  })
  .refine(
    (v) => v.readiness !== "BLOCKED" || v.reason !== undefined,
    "Blocked native Session readiness requires an explanatory reason",
  );
export type SessionNativeSource = z.infer<typeof sessionNativeSourceSchema>;
export type NativeSessionListeningConfig = z.infer<
  typeof nativeSessionListeningConfigSchema
>;
export type NativeSessionArmProof = z.infer<typeof nativeSessionArmProofSchema>;
export type NativeSessionLaunchProof = z.infer<
  typeof nativeSessionLaunchProofSchema
>;
export type NativeSessionCaptureProof = z.infer<
  typeof nativeSessionCaptureProofSchema
>;
export type ListenerNativeSessionStatus = z.infer<
  typeof listenerNativeSessionStatusSchema
>;
export interface NativeSessionListeningExpectation extends NativeListeningExpectationV2 {
  readonly source: Readonly<SessionNativeSource>;
}
export function snapshotNativeSessionListeningExpectation(
  input: NativeSessionListeningExpectation,
): Readonly<NativeSessionListeningExpectation> {
  nativeSessionListeningConfigSchema.parse({
    geometry: input.geometry,
    timingPolicy: input.policy,
    source: input.source,
  });
  const source = sessionNativeSourceSchema.parse(input.source);
  Object.freeze(source.target.track);
  Object.freeze(source.target);
  return Object.freeze({
    ...snapshotNativeListeningExpectationV2(input),
    source: Object.freeze(source),
  });
}
function context(
  source: SessionNativeSource,
  expected: NativeSessionListeningExpectation,
) {
  const frozen = snapshotNativeSessionListeningExpectation(expected);
  if (JSON.stringify(source) !== JSON.stringify(frozen.source))
    throw new Error("native_session_source_context_mismatch");
  return frozen;
}
export function assertNativeSessionArmProof(
  raw: NativeSessionArmProof,
  expected: NativeSessionListeningExpectation,
): void {
  const proof = nativeSessionArmProofSchema.parse(raw);
  assertNativeArmProofV2(proof.transport, context(proof.source, expected));
}
export function nativeSessionLaunchCoordinates(
  rawArm: NativeSessionArmProof,
  rawLaunch: NativeSessionLaunchProof,
  expected: NativeSessionListeningExpectation,
) {
  const arm = nativeSessionArmProofSchema.parse(rawArm);
  const launch = nativeSessionLaunchProofSchema.parse(rawLaunch);
  context(arm.source, expected);
  return nativeLaunchCoordinatesV2(
    arm.transport,
    launch.transport,
    context(launch.source, expected),
  );
}
/** Transport completeness only; application must independently join exact active source + origin. */
export function assertNativeSessionCaptureObservation(
  raw: NativeSessionCaptureProof,
  observation: AudioObservationV2,
  expected: NativeSessionListeningExpectation,
): void {
  const proof = nativeSessionCaptureProofSchema.parse(raw);
  assertNativeCaptureObservationV2(
    proof.transport,
    audioObservationV2Schema.parse(observation),
    context(proof.source, expected),
  );
}
