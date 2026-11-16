import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  metricRecordStreamDescriptorSchema,
  metricRecordStreamManifestSchema,
  metricRecordStreamStateSchema,
  metricRecordChunkSchema,
  createContinuousMetricListeningGeometry,
  createMetricRecordStreamState,
  acceptMetricRecordChunk,
  verifyMetricRecordStreamManifest,
  metricRecordDigest,
  metricRecordStreamExpectedCoverage,
  type MetricRecordStreamDescriptor,
  type MetricRecordStreamManifest,
  type MetricRecordStreamMetric,
} from "@ableton-agent/protocol";
import type {
  ArrangementSourceEvidence,
  ArrangementCaptureEvidence,
} from "./arrangement.js";
import { requireCondition } from "./validation.js";

export interface ArrangementStreamProof {
  readonly contextId: string;
  readonly passId: string;
  readonly listenerId: string;
  readonly descriptorDigest: string;
  readonly manifestSha256: string;
  readonly recordsSha256: string;
  readonly chunkCount: number;
  readonly afterOwnedRestart: boolean;
}
export function streamProofContentSha256(
  proof: ArrangementStreamProof,
): string {
  const { descriptorDigest, manifestSha256, recordsSha256, chunkCount } = proof;
  return createHash("sha256")
    .update(
      JSON.stringify({
        descriptorDigest,
        manifestSha256,
        recordsSha256,
        chunkCount,
      }),
    )
    .digest("hex");
}
/** Rebuild the canonical grid from persisted compact geometry; never accept persisted counters as records. */
export function expandArrangementDescriptor(
  compact: Omit<MetricRecordStreamDescriptor, "geometry"> & {
    geometry: Omit<MetricRecordStreamDescriptor["geometry"], "rows">;
  },
): MetricRecordStreamDescriptor {
  const g = compact.geometry;
  const geometry = createContinuousMetricListeningGeometry({
    captureMode: "finite-metric-stream",
    sampleRate: g.sampleRate,
    vectorSize: g.vectorSize,
    tempoBpm: g.tempoBpm,
    startBeat: g.startBeat,
    endBeat: g.endBeat,
    startSample: g.startSample,
  });
  requireCondition(
    isDeepStrictEqual(
      { ...geometry, rows: undefined },
      { ...g, rows: undefined },
    ),
    "Persisted compact geometry differs from independent canonical geometry",
  );
  return metricRecordStreamDescriptorSchema.parse({ ...compact, geometry });
}

interface PersistedMetricStreamInput {
  readonly contextId: string;
  readonly descriptor: MetricRecordStreamDescriptor;
  readonly manifest: unknown;
  readonly persistedState: unknown;
  readonly chunks: AsyncIterable<unknown>;
  readonly operationId: string;
  readonly expectedTraceId: string;
  readonly expectedCorrelationId: string;
  readonly expectedCausationId: string;
  readonly playbackPlaying: boolean;
  readonly sourceReleaseConfirmed: boolean;
  readonly afterOwnedRestart: boolean;
  readonly signal: AbortSignal;
  readonly onChunk?: (chunk: unknown) => Promise<void>;
  readonly requiredMetrics?: readonly MetricRecordStreamMetric[];
}

export async function verifyPersistedArrangementStream(
  input: PersistedMetricStreamInput & {
    readonly baseline: ArrangementSourceEvidence;
    readonly expectedRange?: {
      readonly startBeat: number;
      readonly endBeat: number;
    };
  },
): Promise<{
  capture: ArrangementCaptureEvidence;
  proof: ArrangementStreamProof;
}> {
  const descriptor = metricRecordStreamDescriptorSchema.parse(input.descriptor);
  const source = input.baseline.source;
  const range = input.expectedRange ?? source;
  requireCondition(
    Number.isFinite(range.startBeat) &&
      Number.isFinite(range.endBeat) &&
      range.startBeat >= source.startBeat &&
      range.endBeat <= source.endBeat &&
      range.endBeat > range.startBeat &&
      descriptor.source.view === "arrangement" &&
      descriptor.source.target.kind === "regular" &&
      descriptor.source.target.index === source.trackIndex &&
      descriptor.source.target.expectedReference === source.trackId &&
      descriptor.source.transport.startBeat === range.startBeat &&
      descriptor.source.transport.endBeat === range.endBeat &&
      descriptor.ownership.listenerId === input.baseline.listenerId,
    "Persisted Arrangement stream source/owner/required metrics differ",
  );
  const { proof, manifest, nonSilent } =
    await verifyPersistedMetricStream(input);
  const firstFrameEndSample = descriptor.algorithms.find(
    (item) => item.metric === "spectral-centroid",
  )?.algorithm?.firstFrameEndSample;
  requireCondition(
    typeof firstFrameEndSample === "number",
    "Missing verified spectral-centroid FFT phase",
  );
  const capture: ArrangementCaptureEvidence = {
    passId: proof.passId,
    operationId: input.operationId,
    traceId: descriptor.ownership.traceId,
    correlationId: descriptor.ownership.correlationId,
    causationId: descriptor.ownership.causationId,
    listenerId: proof.listenerId,
    source,
    sampleRate: descriptor.geometry.sampleRate,
    startSample: descriptor.geometry.startSample,
    endSample: descriptor.geometry.endSample,
    spectralCentroidFirstFrameEndSample: firstFrameEndSample,
    complete: true,
    truncated: false,
    failure: null,
    metrics: manifest.metrics.map((metric) => ({
      name: metric.metric,
      passId: proof.passId,
      listenerId: proof.listenerId,
      expectedRecords: metricRecordStreamExpectedCoverage(
        descriptor,
        metric.metric,
      ).expectedRecords,
      receivedRecords: metric.nextRecordOffset,
      missingRecords: metric.missingRecords,
      startSample: descriptor.geometry.startSample,
      endSample: descriptor.geometry.endSample,
      source,
      nonSilent,
    })),
    cleanup: {
      captureReleased:
        manifest.nativeProof.spectrumCleanup?.status === "completed",
      sourceRestored: input.sourceReleaseConfirmed,
      transportPlaying: input.playbackPlaying,
      failure: null,
    },
    stream: proof,
  };
  return { capture, proof };
}

export async function verifyPersistedMetricStream(
  input: PersistedMetricStreamInput,
): Promise<{
  proof: ArrangementStreamProof;
  manifest: MetricRecordStreamManifest;
  nonSilent: boolean;
}> {
  const descriptor = metricRecordStreamDescriptorSchema.parse(input.descriptor);
  const manifest = metricRecordStreamManifestSchema.parse(input.manifest);
  const requiredMetrics =
    input.requiredMetrics ??
    ([
      "level",
      "spectral-centroid",
      "attacks",
      "mel-bands",
      "pitch",
      "spectral-shape",
    ] as const);
  requireCondition(
    descriptor.ownership.traceId === input.expectedTraceId &&
      descriptor.ownership.correlationId === input.expectedCorrelationId &&
      descriptor.ownership.causationId === input.expectedCausationId &&
      descriptor.requestedMetrics.length === requiredMetrics.length &&
      new Set(requiredMetrics).size === requiredMetrics.length &&
      requiredMetrics.every((metric) =>
        descriptor.requestedMetrics.some((name) => name === metric),
      ),
    "Persisted stream ownership or required metrics differ",
  );
  let state = await createMetricRecordStreamState(descriptor);
  const records = createHash("sha256");
  let chunkCount = 0,
    nonSilent = false;
  for await (const raw of input.chunks) {
    input.signal.throwIfAborted();
    const chunk = metricRecordChunkSchema.parse(raw);
    state = await acceptMetricRecordChunk(descriptor, state, chunk);
    requireCondition(
      chunk.gaps.length === 0,
      "Metric stream contains explicit gaps",
    );
    records.update(JSON.stringify(chunk)).update("\n");
    if (chunk.metric === "level")
      nonSilent ||= chunk.records.some((record) =>
        record.rms.some((value) => value > 0),
      );
    chunkCount++;
    requireCondition(
      chunkCount <= 4096,
      "Metric chunk inventory exceeds bound",
    );
    await input.onChunk?.(chunk);
  }
  input.signal.throwIfAborted();
  await verifyMetricRecordStreamManifest(descriptor, state, manifest);
  await verifyMetricRecordStreamManifest(
    descriptor,
    metricRecordStreamStateSchema.parse(input.persistedState),
    manifest,
  );
  requireCondition(
    manifest.outcome === "complete" &&
      manifest.nativeProof.status === "completed" &&
      manifest.nativeProof.drain === "completed" &&
      input.sourceReleaseConfirmed &&
      nonSilent &&
      manifest.metrics.every(
        (metric) =>
          metric.missingRecords === 0 && metric.availability === "available",
      ) &&
      chunkCount > 0,
    "Metric stream is incomplete, silent, unavailable or lacks confirmed cleanup",
  );
  const proof: ArrangementStreamProof = {
    contextId: input.contextId,
    passId: descriptor.ownership.passId,
    listenerId: descriptor.ownership.listenerId,
    descriptorDigest: state.descriptorDigest,
    manifestSha256: await metricRecordDigest(manifest),
    recordsSha256: records.digest("hex"),
    chunkCount,
    afterOwnedRestart: input.afterOwnedRestart,
  };
  return { proof, manifest, nonSilent };
}
