import {
  compareListeningFeatures,
  extractListeningFeature,
  projectMetricFeatureSource,
  segmentListeningObservation,
  type ListeningFeature,
  type ListeningFeatureSegment,
  type ListeningMusicalAlignment,
  type MetricRecordChunk,
  type MetricRecordStreamContextReference,
  type MetricRecordStreamDescriptor,
  type MetricRecordStreamManifest,
  type MonitoringEpisode,
  type MonitoringObserver,
  type MonitoringObserverSnapshot,
} from "@ableton-agent/protocol";
import type { MetricRecordStagedSink } from "./metric-record-ingestion.js";

/** Monitoring compares bars by their normalized mel spectrum on a 16th grid. */
export const MONITORING_FEATURE = "mel-grid/v1" as const;

/**
 * Distance at or below which two bars count as the same pattern bar. In real
 * Live, repeats of a steady loop measured 0.003–0.07, and 0.5 missed a change.
 */
export const MONITORING_MATCH_THRESHOLD = 0.15;

/**
 * Euclidean distance between the bars' unit-normalized mel grids: 0 is
 * identical, sqrt(2) is spectrally disjoint. Two silent bars match; silence
 * never matches sound.
 */
export function monitoringFeatureDistance(
  left: ListeningFeature,
  right: ListeningFeature,
): number {
  const silent = (feature: ListeningFeature) => feature.reason === "zero-norm";
  if (silent(left) || silent(right))
    return silent(left) && silent(right) ? 0 : Number.POSITIVE_INFINITY;
  const comparison = compareListeningFeatures(left, right);
  if (comparison.status !== "comparable") return Number.POSITIVE_INFINITY;
  // mel-grid/v1 reports an RMS over every grid value; undo the averaging so
  // the threshold does not depend on how many cells a bar has.
  return (
    comparison.distance * Math.sqrt(comparison.coverage?.comparedValues ?? 1)
  );
}

export interface MonitoringBarReport {
  readonly listenerId: string;
  readonly bar: number;
  readonly songBeat: number;
  readonly episodes: readonly MonitoringEpisode[];
  readonly snapshot: MonitoringObserverSnapshot;
}

export interface MonitoringStreamSinkOptions {
  readonly alignment: ListeningMusicalAlignment;
  readonly observer: (
    listenerId: string,
  ) => MonitoringObserver<ListeningFeature> | undefined;
  readonly onBar: (report: MonitoringBarReport) => void;
}

interface ListenerStream {
  readonly reference: MetricRecordStreamContextReference;
  readonly bars: readonly ListeningFeatureSegment[];
  next: number;
  chunks: MetricRecordChunk[];
  frontier: number;
}

/**
 * Seals each complete bar as soon as its mel-band records have arrived and
 * feeds it to that listener's observer. Retains only the chunks still needed
 * by unsealed bars; nothing is persisted.
 */
export function createMonitoringStreamSink(
  options: MonitoringStreamSinkOptions,
): MetricRecordStagedSink {
  const streams = new Map<string, ListenerStream>();
  const meter = options.alignment.meter;
  const barBeats = (meter.numerator * 4) / meter.denominator;

  const seal = (listenerId: string, stream: ListenerStream, all: boolean) => {
    const observer = options.observer(listenerId);
    while (stream.next < stream.bars.length) {
      const segment = stream.bars[stream.next]!;
      if (!all && stream.frontier < segment.endSample) break;
      stream.next++;
      const bar = Math.floor(segment.startBeat / barBeats + 1e-9) + 1;
      if (!observer) continue;
      const range = {
        startSample: segment.startSample,
        endSample: segment.endSample,
      };
      const relevant = stream.chunks.filter((chunk) =>
        [
          ...chunk.records.map((record) => record.support),
          ...chunk.gaps.map((gap) => gap.support),
        ].some(
          (support) =>
            support.startSample < range.endSample &&
            support.endSample > range.startSample,
        ),
      );
      const gapped = relevant.some((chunk) =>
        chunk.gaps.some(
          (gap) =>
            gap.support.startSample < range.endSample &&
            gap.support.endSample > range.startSample,
        ),
      );
      const episodes = gapped
        ? observer.interrupt("gap", bar)
        : observer.observeBar({
            bar,
            songBeat: segment.startBeat,
            features: extractListeningFeature(
              MONITORING_FEATURE,
              projectMetricFeatureSource(stream.reference, relevant, range),
              segment,
            ),
          });
      options.onBar({
        listenerId,
        bar,
        songBeat: segment.startBeat,
        episodes,
        snapshot: observer.snapshot(),
      });
    }
    const keepFrom = stream.bars[stream.next]?.startSample;
    stream.chunks =
      keepFrom === undefined
        ? []
        : stream.chunks.filter((chunk) =>
            [
              ...chunk.records.map((record) => record.support.endSample),
              ...chunk.gaps.map((gap) => gap.support.endSample),
            ].some((end) => end > keepFrom),
          );
  };

  return {
    async begin(descriptor: MetricRecordStreamDescriptor) {
      const { rows: _rows, ...geometry } = descriptor.geometry;
      void _rows;
      const reference: MetricRecordStreamContextReference = {
        schema: "metric-record-stream-context/v1",
        captureId: descriptor.ownership.passId,
        descriptorDigest: "",
        descriptor: { ...descriptor, geometry },
      };
      streams.set(descriptor.ownership.listenerId, {
        reference,
        bars: segmentListeningObservation(
          projectMetricFeatureSource(reference, []),
          options.alignment,
        ).filter((segment) => segment.kind === "bar"),
        next: 0,
        chunks: [],
        frontier: Number.NEGATIVE_INFINITY,
      });
    },
    async append(chunk: MetricRecordChunk) {
      if (chunk.metric !== "mel-bands") return;
      const listenerId = chunk.ownership.listenerId;
      const stream = streams.get(listenerId);
      if (!stream) return;
      if (stream.reference.descriptorDigest === "")
        Object.assign(stream.reference, {
          descriptorDigest: chunk.descriptorDigest,
        });
      stream.chunks.push(chunk);
      // Records arrive in sample order: a record starting at s means every
      // record covering samples before s has already arrived.
      for (const record of chunk.records)
        stream.frontier = Math.max(stream.frontier, record.support.startSample);
      for (const gap of chunk.gaps)
        stream.frontier = Math.max(stream.frontier, gap.support.endSample);
      seal(listenerId, stream, false);
    },
    async finalize(manifest: MetricRecordStreamManifest) {
      const listenerId = manifest.ownership.listenerId;
      const stream = streams.get(listenerId);
      if (!stream) return;
      seal(listenerId, stream, true);
      streams.delete(listenerId);
    },
    async abort() {
      streams.clear();
    },
  };
}
