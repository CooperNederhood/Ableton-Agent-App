import {
  NATIVE_CONTINUOUS_METRIC_LISTENING_SCOPE,
  assertNativeContinuousMetricArmProof,
  assertNativeContinuousMetricReadyProof,
  assertNativeMetricArmProof,
  assertNativeMetricReadyProof,
  nativeContinuousMetricLaunchCoordinates,
  nativeMetricLaunchCoordinates,
  snapshotNativeContinuousMetricListeningExpectation,
  snapshotNativeMetricListeningExpectation,
  nativeMetricArmProofSchema,
  nativeMetricLaunchProofSchema,
  type NativeMetricListeningExpectation,
  type NativeMetricControlArmProof,
  type NativeMetricControlConfig,
} from "@ableton-agent/protocol";

export type MetricControlExpectation = Omit<
  NativeMetricListeningExpectation,
  "config"
> & { readonly config: Readonly<NativeMetricControlConfig> };

export function legacyMetricControlExpectation(
  expected: MetricControlExpectation,
): NativeMetricListeningExpectation {
  if (expected.config.scope === NATIVE_CONTINUOUS_METRIC_LISTENING_SCOPE)
    throw new Error("continuous_metric_legacy_publication_forbidden");
  return { ...expected, config: expected.config };
}

export function snapshotMetricControlExpectation(
  input: MetricControlExpectation,
) {
  return input.config.scope === NATIVE_CONTINUOUS_METRIC_LISTENING_SCOPE
    ? snapshotNativeContinuousMetricListeningExpectation({
        ...input,
        config: input.config,
      })
    : snapshotNativeMetricListeningExpectation({
        ...input,
        config: input.config,
      });
}

export function assertMetricControlReady(
  input: unknown,
  expected: MetricControlExpectation,
) {
  return expected.config.scope === NATIVE_CONTINUOUS_METRIC_LISTENING_SCOPE
    ? assertNativeContinuousMetricReadyProof(input, {
        ...expected,
        config: expected.config,
      })
    : assertNativeMetricReadyProof(input, {
        ...expected,
        config: expected.config,
      });
}

export function assertMetricControlArm(
  input: unknown,
  expected: MetricControlExpectation,
) {
  return expected.config.scope === NATIVE_CONTINUOUS_METRIC_LISTENING_SCOPE
    ? assertNativeContinuousMetricArmProof(input, {
        ...expected,
        config: expected.config,
      })
    : assertNativeMetricArmProof(nativeMetricArmProofSchema.parse(input), {
        ...expected,
        config: expected.config,
      });
}

export function metricControlLaunchCoordinates(
  rawArm: NativeMetricControlArmProof,
  rawLaunch: unknown,
  expected: MetricControlExpectation,
) {
  if (expected.config.scope === NATIVE_CONTINUOUS_METRIC_LISTENING_SCOPE) {
    const pinned = { ...expected, config: expected.config };
    return nativeContinuousMetricLaunchCoordinates(
      assertNativeContinuousMetricArmProof(rawArm, pinned),
      rawLaunch,
      pinned,
    );
  }
  const pinned = { ...expected, config: expected.config };
  return nativeMetricLaunchCoordinates(
    assertNativeMetricArmProof(
      nativeMetricArmProofSchema.parse(rawArm),
      pinned,
    ),
    nativeMetricLaunchProofSchema.parse(rawLaunch),
    pinned,
  );
}
