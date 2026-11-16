import type { MetricAudioObservation } from "./metric-observation-schemas.js";

type Metrics = MetricAudioObservation["metrics"];
type Timeline = "mel-bands" | "pitch" | "spectral-shape";

/** Validated measurements for one bounded extraction, independent of delivery. */
export interface ListeningFeatureSource {
  readonly source: MetricAudioObservation["source"];
  readonly requestedMetrics: Readonly<
    MetricAudioObservation["requestedMetrics"]
  >;
  readonly geometry: Pick<
    MetricAudioObservation["geometry"],
    | "sampleRate"
    | "tempoBpm"
    | "startBeat"
    | "endBeat"
    | "startSample"
    | "endSample"
  >;
  readonly metrics: {
    readonly [K in "level" | "spectral-centroid" | "attacks"]: Pick<
      Metrics[K],
      "status" | "algorithm" | "records"
    >;
  } & {
    readonly [K in Timeline]?:
      | Pick<
          NonNullable<Metrics[K]>,
          "profile" | "sampleRate" | "sourceSupport" | "frames"
        >
      | undefined;
  };
}
