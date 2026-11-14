import {
  nativeMetricSourceCoverageProofSchema,
  nativeContinuousMetricArmProofSchema,
  nativeContinuousMetricDspReceiptSchema,
  assertNativeContinuousMetricArmProof,
  nativeContinuousMetricLaunchCoordinates,
  assertNativeCheckedTransportSourceCoverage,
} from "../../packages/protocol/src/index.ts";

// Internal controller evidence, not an additional transport contract. Preserve
// the canonical source-proof shape and all clock/timing/cleanup validators,
// substituting only the explicitly continuous arm/configuration validators.
const continuousSourceEvidenceSchema =
  nativeMetricSourceCoverageProofSchema.extend({
    armed: nativeContinuousMetricArmProofSchema,
    completion: nativeContinuousMetricDspReceiptSchema,
  });

export function assertNativeContinuousMetricSourceCoverage(raw, expected) {
  const proof = continuousSourceEvidenceSchema.parse(raw);
  const armed = assertNativeContinuousMetricArmProof(proof.armed, expected);
  const coordinates = nativeContinuousMetricLaunchCoordinates(
    armed,
    proof.launched,
    expected,
  );
  if (
    proof.completion.fields.some(
      (cell, index) => cell !== armed.receipt.fields[index],
    ) ||
    proof.completion.timing.some(
      (cell, index) =>
        cell !== (index === 3 ? 0 : proof.launched.timing[index]),
    ) ||
    proof.after.frames[0][4] <
      coordinates.originCounter +
        armed.config.geometry.totalSamples +
        armed.config.geometry.vectorSize -
        1
  )
    throw new Error("native_metric_completion_receipt_mismatch");
  const checked = assertNativeCheckedTransportSourceCoverage({
    policy: armed.config.timingPolicy,
    geometry: armed.config.geometry,
    before: armed.before,
    after: proof.after,
    timingWitnesses: proof.timingWitnesses,
    launchedHost: {
      sample: proof.launched.clock[2],
      beat: proof.launched.clock[1],
      flags: proof.launched.clock[3],
      playing: true,
    },
    coordinates: {
      startSample: coordinates.hostStartSample,
      originCounter: coordinates.originCounter,
      hostOffsetSamples: coordinates.hostOffsetSamples,
    },
    additionalClocks: [proof.launched.clock],
    errorPrefix: "native_metric",
  });
  return Object.freeze({
    startSample: checked.originCounter,
    endSample: checked.originCounter + armed.config.geometry.totalSamples,
    originCounter: checked.originCounter,
    hostOffsetSamples: checked.hostOffsetSamples,
    hostStartSample: checked.startSample,
    hostEndSample: checked.endSample,
    alignment: checked.alignment,
  });
}

export {
  admitMetricListeningBudget,
  assertNativeMetricArmProof,
  assertNativeMetricObservationSource,
  assertNativeMetricReadyProof,
  assertNativeMetricSourceCoverage,
  createMetricListeningGeometry,
  createMetricObservationReportRows,
  MAX_AUDIO_OBSERVATION_BYTES,
  MAX_METRIC_OBSERVATION_BYTES,
  MAX_METRIC_RESULT_FRAME_BYTES,
  metricAudioObservationSchema,
  MEL_BAND_PROFILE,
  melBandStereoFrameSchema,
  melBandTimelineSchema,
  ANALYZER_PRODUCER_ABI,
  LISTENER_CAPABILITY_ANALYZER_TIMELINES,
  analyzerNativeReadinessSchema,
  analyzerNativeSourceIdentitySchema,
  PITCH_PROFILE,
  SPECTRAL_SHAPE_PROFILE,
  pitchTimelineSchema,
  spectralShapeTimelineSchema,
  pitchTimelineFrameSchema,
  spectralShapeTimelineFrameSchema,
  deriveAnalyzerTrailingSupport,
  nativeMetricArmProofSchema,
  nativeMetricIdleConfigurationReadbackSchema,
  nativeMetricIdleReceiptSchema,
  nativeMetricIdleTimingSchema,
  nativeMetricLaunchProofSchema,
  nativeMetricLaunchCoordinates,
  nativeMetricListeningConfigSchema,
  nativeMetricReadyProofSchema,
  nativeMetricSourceCoverageProofSchema,
  nativeMetricSpectrumPhaseSchema,
  nativeMetricSpectrumCleanupSchema,
  nativeMetricFirstSpectrumEndpoint,
  snapshotNativeMetricListeningExpectation,
  NATIVE_CONTINUOUS_METRIC_LISTENING_SCOPE,
  nativeContinuousMetricListeningConfigSchema,
  nativeMetricControlConfigSchema,
  nativeMetricControlReadyProofSchema,
  nativeMetricControlArmProofSchema,
  nativeContinuousMetricReadyProofSchema,
  nativeContinuousMetricArmProofSchema,
  nativeContinuousMetricDspReceiptSchema,
  snapshotNativeContinuousMetricListeningExpectation,
  assertNativeContinuousMetricReadyProof,
  assertNativeContinuousMetricArmProof,
  nativeContinuousMetricLaunchCoordinates,
  createContinuousMetricListeningGeometry,
  metricContinuousListeningGeometryInputSchema,
  metricContinuousListeningGeometrySchema,
  METRIC_CONTINUOUS_LISTENING_CAPABILITY,
  METRIC_RECORD_STREAM_CAPABILITY,
  MAX_METRIC_RECORD_CHUNK_BYTES,
  MAX_METRIC_RECORD_PENDING_CHUNKS,
  metricRecordStreamDescriptorSchema,
  metricRecordStreamAdmissionSchema,
  compactMetricRecordStreamDescriptor,
  expandMetricRecordStreamAdmission,
  createMetricRecordStreamState,
  metricRecordChunkSchema,
  metricRecordChunkDigest,
  acceptMetricRecordChunk,
  metricRecordStreamTerminalProofSchema,
  metricRecordStreamManifestSchema,
  metricRecordStreamStateSchema,
  metricRecordStreamDescriptorDigest,
  canonicalMetricRecordJson,
  encodeMetricRecordChunk,
  parseMetricRecordChunkWire,
  nativeContinuousMetricConfigurationReadbackSchema,
  listenerNativeContinuousMetricStatusSchema,
  listenerNativeMetricRegistrationStatusSchema,
  metricStreamLevelRecordSchema,
  metricStreamSpectralRecordSchema,
  metricStreamAttackRecordSchema,
  metricStreamMelBandRecordSchema,
  metricStreamPitchRecordSchema,
  metricStreamSpectralShapeRecordSchema,
  metricRecordStreamExpectedCoverage,
  metricRecordStreamCapturedTrailingSupport,
  verifyMetricRecordStreamManifest,
} from "../../packages/protocol/src/index.ts";
export {
  LISTENER_CAPABILITY_METRIC,
  LISTENER_CAPABILITY_MEL,
  LISTENER_METRIC_ALGORITHM_VERSION,
  LISTENER_METRIC_PRODUCER_SCHEMA_VERSION,
  LISTENER_METRIC_SCOPE,
  LISTENER_VERSION_METRIC,
  listenerControlMetricSchema,
  listenerMetricProducerSchema,
  listenerMetricWireIdentitySchema,
  listenerNativeMetricStatusSchema,
  listenerRegistrationMetricSchema,
  listenerReplyMetricSchema,
  listenerResultMetricSchema,
  nativeMetricLifecycleSchema,
} from "../../packages/signal-routing/src/listener-metric-contracts.ts";
