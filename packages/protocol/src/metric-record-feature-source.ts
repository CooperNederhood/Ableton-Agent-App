import type { ListeningFeatureSource } from "./listening-feature-source.js";
import { canonicalMetricRecordJson } from "./metric-record-stream.js";
import type {
  MetricRecordChunk,
  MetricRecordStreamContextReference,
} from "./metric-record-stream.js";

/** Projects verified immutable chunks; records retain their original supports. */
export function projectMetricFeatureSource(
  reference: MetricRecordStreamContextReference,
  chunks: readonly MetricRecordChunk[],
  range?: { readonly startSample: number; readonly endSample: number },
): ListeningFeatureSource {
  const { descriptor } = reference;
  for (const chunk of chunks)
    if (
      chunk.descriptorDigest !== reference.descriptorDigest ||
      canonicalMetricRecordJson(chunk.ownership) !==
        canonicalMetricRecordJson(descriptor.ownership)
    )
      throw new Error("feature_measurement_source_mismatch");
  const intersects = (record: {
    readonly support: {
      readonly startSample: number;
      readonly endSample: number;
    };
  }) =>
    range === undefined ||
    (record.support.startSample < range.endSample &&
      record.support.endSample > range.startSample);
  const algorithms = descriptor.algorithms;
  const level = algorithms.find((item) => item.metric === "level");
  const centroid = algorithms.find(
    (item) => item.metric === "spectral-centroid",
  );
  const attacks = algorithms.find((item) => item.metric === "attacks");
  const mel = algorithms.find((item) => item.metric === "mel-bands");
  const pitch = algorithms.find((item) => item.metric === "pitch");
  const shape = algorithms.find((item) => item.metric === "spectral-shape");
  const status = (
    algorithm: typeof level | typeof centroid | typeof attacks,
  ) =>
    algorithm === undefined
      ? ("not-requested" as const)
      : algorithm.availability === "available"
        ? ("complete" as const)
        : ("failed" as const);
  const sourceSupport = {
    startSample: descriptor.geometry.startSample,
    endSample: descriptor.geometry.endSample,
  };
  return {
    source: descriptor.source,
    requestedMetrics: descriptor.requestedMetrics,
    geometry: descriptor.geometry,
    metrics: {
      level: {
        status: status(level),
        algorithm: level?.algorithm ?? null,
        records: chunks
          .filter((item) => item.metric === "level")
          .flatMap((item) => item.records)
          .filter(intersects),
      },
      "spectral-centroid": {
        status: status(centroid),
        algorithm: centroid?.algorithm ?? null,
        records: chunks
          .filter((item) => item.metric === "spectral-centroid")
          .flatMap((item) => item.records)
          .filter(intersects),
      },
      attacks: {
        status: status(attacks),
        algorithm: attacks?.algorithm ?? null,
        records: chunks
          .filter((item) => item.metric === "attacks")
          .flatMap((item) => item.records)
          .filter(
            (record) =>
              intersects(record) ||
              record.events.some(
                (event) =>
                  range !== undefined &&
                  event.sample >= range.startSample &&
                  event.sample < range.endSample,
              ),
          ),
      },
      ...(mel?.algorithm === undefined || mel.algorithm === null
        ? {}
        : {
            "mel-bands": {
              profile: mel.algorithm,
              sampleRate: descriptor.geometry.sampleRate,
              sourceSupport,
              frames: chunks
                .filter((item) => item.metric === "mel-bands")
                .flatMap((item) => item.records)
                .filter(intersects),
            },
          }),
      ...(pitch?.algorithm === undefined || pitch.algorithm === null
        ? {}
        : {
            pitch: {
              profile: pitch.algorithm,
              sampleRate: descriptor.geometry.sampleRate,
              sourceSupport,
              frames: chunks
                .filter((item) => item.metric === "pitch")
                .flatMap((item) => item.records)
                .filter(intersects),
            },
          }),
      ...(shape?.algorithm === undefined || shape.algorithm === null
        ? {}
        : {
            "spectral-shape": {
              profile: shape.algorithm,
              sampleRate: descriptor.geometry.sampleRate,
              sourceSupport,
              frames: chunks
                .filter((item) => item.metric === "spectral-shape")
                .flatMap((item) => item.records)
                .filter(intersects),
            },
          }),
    },
  };
}
