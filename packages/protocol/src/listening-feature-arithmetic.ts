import type { MetricAudioObservation } from "./metric-observation-schemas.js";
import { deriveMelBandFrame } from "./mel-band-profile.js";
import {
  LISTENING_FEATURE_DEFINITIONS,
  listeningFeatureDefinition,
  listeningFeatureSchema,
  type ListeningFeature,
  type ListeningFeatureType,
  type ListeningFeatureUnavailableReason,
} from "./listening-feature-contracts.js";
import {
  overlap,
  support,
  covered,
  weighted,
} from "./listening-feature-support.js";
import { extractAnalyzerListeningFeature } from "./listening-analyzer-features.js";

type Interval = { readonly startSample: number; readonly endSample: number };
export interface ListeningFeatureRange extends Interval {
  readonly startBeat: number;
  readonly endBeat: number;
  readonly grid?: {
    readonly meter: {
      readonly numerator: number;
      readonly denominator: number;
    };
    readonly phaseBeats: number;
    readonly cells: readonly (Interval & {
      readonly startBeat: number;
      readonly endBeat: number;
    })[];
  };
}
type RecordWithSupport = { readonly support: Interval };

function normalize(values: (number | null)[]): (number | null)[] | undefined {
  const norm = Math.sqrt(
    values.reduce<number>((sum, value) => sum + (value ?? 0) ** 2, 0),
  );
  return norm === 0
    ? undefined
    : values.map((value) => (value === null ? null : value / norm));
}

export function extractListeningFeature(
  type: ListeningFeatureType,
  observation: MetricAudioObservation,
  range: ListeningFeatureRange = observation.geometry,
): ListeningFeature {
  const definition = listeningFeatureDefinition(type);
  const expectedSamples = range.endSample - range.startSample;
  if (
    expectedSamples <= 0 ||
    range.startSample < observation.geometry.startSample ||
    range.endSample > observation.geometry.endSample ||
    (range.grid?.cells.length ?? 0) > 2000
  )
    throw new RangeError("Unsupported feature extraction range");
  if (
    definition.profile === "pitch-profile/v1" ||
    definition.profile === "spectral-shape-profile/v1"
  )
    return extractAnalyzerListeningFeature(type, observation, range);
  const level = observation.metrics.level;
  const spectral = observation.metrics["spectral-centroid"];
  const attacks = observation.metrics.attacks;
  const mel = observation.metrics["mel-bands"];
  const family = definition.profile;
  const records: readonly RecordWithSupport[] =
    family === "sample-grid-peak-rms/v1"
      ? level.records
      : family === "fft-energy-centroid/v1"
        ? spectral.records
        : family === "level-window-rise/v1"
          ? attacks.records
          : (mel?.frames ?? []);
  const algorithm =
    family === "sample-grid-peak-rms/v1"
      ? level.algorithm
      : family === "fft-energy-centroid/v1"
        ? spectral.algorithm
        : family === "level-window-rise/v1"
          ? attacks.algorithm
          : (mel?.profile ?? null);
  const phase = (origin: number, hop: number): number =>
    (((origin - range.startSample) % hop) + hop) % hop;
  const profileKey = JSON.stringify(
    family === "fft-energy-centroid/v1" && spectral.algorithm !== null
      ? {
          name: spectral.algorithm.name,
          version: spectral.algorithm.version,
          fftSamples: spectral.algorithm.fftSamples,
          hopSamples: spectral.algorithm.hopSamples,
          sampleRate: observation.geometry.sampleRate,
          phaseSamples:
            spectral.algorithm.firstFrameEndSample === null
              ? null
              : phase(
                  spectral.algorithm.firstFrameEndSample,
                  spectral.algorithm.hopSamples,
                ),
        }
      : family === "mel-band-profile/v1"
        ? {
            profile: mel?.profile.schema ?? null,
            sampleRate: observation.geometry.sampleRate,
            phaseSamples:
              mel === undefined
                ? null
                : phase(mel.sourceSupport.startSample, mel.profile.hopSamples),
          }
        : family === "level-window-rise/v1"
          ? {
              algorithm,
              sampleRate: observation.geometry.sampleRate,
              phaseSamples:
                attacks.algorithm === null
                  ? null
                  : phase(
                      observation.geometry.startSample,
                      attacks.algorithm.windowSamples,
                    ),
            }
          : algorithm,
  );
  const intervals = support(records, range);
  const coveredSamples = covered(intervals);
  let reason: ListeningFeatureUnavailableReason | null = null;
  let values: (number | null)[] | null = null;
  const grid =
    definition.grid && range.grid !== undefined
      ? {
          stepBeats: 0.25 as const,
          meter: range.grid.meter,
          phaseBeats: range.grid.phaseBeats,
          cells: range.grid.cells.map((cell) => ({
            startBeat: cell.startBeat - range.startBeat,
            endBeat: cell.endBeat - range.startBeat,
            coveredSamples: covered(support(records, cell)),
            expectedSamples: cell.endSample - cell.startSample,
            reason: null as ListeningFeatureUnavailableReason | null,
          })),
        }
      : null;
  const notRequested =
    family === "sample-grid-peak-rms/v1"
      ? level.status === "not-requested"
      : family === "fft-energy-centroid/v1"
        ? spectral.status === "not-requested"
        : family === "level-window-rise/v1"
          ? attacks.status === "not-requested"
          : mel === undefined;
  if (algorithm === null)
    reason =
      family === "sample-grid-peak-rms/v1"
        ? "unsupported-level-profile"
        : notRequested
          ? "not-requested"
          : "unsupported-profile";
  else if (records.length === 0 || coveredSamples === 0)
    reason =
      family === "sample-grid-peak-rms/v1" ? "no-level-records" : "no-records";
  else if (definition.grid && grid === null) reason = "missing-alignment";
  else if (type === "peak-summary/v1") {
    const selected = level.records.filter(
      (record) => overlap(record.support, range) > 0,
    );
    if (
      selected.some(
        (r) =>
          r.support.startSample < range.startSample ||
          r.support.endSample > range.endSample,
      )
    )
      reason = "straddling-level-record";
    else
      values = [0, 1].map((channel) =>
        selected.reduce(
          (peak, record) => Math.max(peak, record.peak[channel]!),
          0,
        ),
      );
  } else if (type === "spectral-energy-summary/v1") {
    values =
      weighted(spectral.records, range, (r) => [r.spectralEnergy]) ?? null;
  } else if (!definition.grid) {
    const means = weighted(mel!.frames, range, (r) => r.magnitudes.flat());
    if (means === undefined) reason = "no-records";
    else if (type === "mel-shape/v1") {
      values = normalize(means) ?? null;
      if (values === null) reason = "zero-norm";
    } else {
      const analysis = deriveMelBandFrame([
        means.slice(0, 24),
        means.slice(24),
      ]);
      if (type === "mel-region-summary/v1") {
        values = analysis.regions.flatMap((channel) => [
          channel.low,
          channel.mid,
          channel.high,
        ]);
      } else {
        const ratios = analysis.ratios.flatMap((channel) => [
          channel.lowMid,
          channel.highMid,
        ]);
        reason = ratios.find((ratio) => ratio.reason !== null)?.reason ?? null;
        if (reason === null) values = ratios.map((ratio) => ratio.value!);
      }
    }
  } else if (grid !== null && range.grid !== undefined) {
    const flattened: (number | null)[] = [];
    for (const [index, cell] of range.grid.cells.entries()) {
      const metadata = grid.cells[index]!;
      let cellValues: number[] | undefined;
      if (metadata.coveredSamples !== metadata.expectedSamples)
        metadata.reason = "insufficient-support";
      else if (type === "level-grid/v1") {
        const selected = level.records.filter(
          (record) => overlap(record.support, cell) > 0,
        );
        if (
          selected.some(
            (r) =>
              r.support.startSample < cell.startSample ||
              r.support.endSample > cell.endSample,
          )
        )
          metadata.reason = "straddling-level-record";
        else
          cellValues = [0, 1].map((channel) =>
            Math.sqrt(
              selected.reduce(
                (sum, r) =>
                  sum +
                  r.rms[channel]! ** 2 *
                    (r.support.endSample - r.support.startSample),
                0,
              ) / metadata.expectedSamples,
            ),
          );
      } else if (type === "centroid-grid/v1") {
        if (
          spectral.records.some(
            (r) => overlap(r.support, cell) > 0 && r.centroidHz === null,
          )
        )
          metadata.reason = "undefined-descriptor";
        else
          cellValues = weighted(spectral.records, cell, (r) => [r.centroidHz!]);
      } else if (
        type === "attack-activity-grid/v1" ||
        type === "attack-strength-grid/v1"
      ) {
        const events = attacks.records
          .flatMap((r) => r.events)
          .filter(
            (event) =>
              event.sample >= cell.startSample &&
              (event.sample < cell.endSample ||
                (cell.endSample === observation.geometry.endSample &&
                  event.sample === cell.endSample)),
          );
        cellValues = [
          type === "attack-activity-grid/v1"
            ? events.length
            : events.reduce((max, event) => Math.max(max, event.strength), 0),
        ];
      } else {
        cellValues = weighted(mel!.frames, cell, (r) => r.magnitudes.flat());
      }
      if (metadata.reason === null && cellValues === undefined)
        metadata.reason = "no-records";
      if (metadata.reason !== null) {
        reason ??= metadata.reason;
        flattened.push(
          ...Array.from({ length: definition.dimensions }, () => null),
        );
      } else flattened.push(...cellValues!);
    }
    if (flattened.some((value) => value !== null)) {
      reason = null;
      values =
        type === "mel-grid/v1" ? (normalize(flattened) ?? null) : flattened;
      if (values === null) reason = "zero-norm";
    }
  }
  if (values === null && reason === null) reason = "no-records";
  return listeningFeatureSchema.parse({
    type,
    distanceDefinition: definition.distanceDefinition,
    units: definition.units,
    distanceUnits: definition.distanceUnits,
    profile: family,
    profileKey,
    status: reason === null ? "ready" : "unavailable",
    reason,
    values,
    coveredSamples,
    expectedSamples,
    sampleRate: observation.geometry.sampleRate,
    durationSeconds: expectedSamples / observation.geometry.sampleRate,
    normalization: definition.normalization,
    supportPolicy: definition.grid
      ? "matching-cell-mask"
      : type === "peak-summary/v1"
        ? "complete-required"
        : "retained-overlap",
    support: intervals,
    grid,
    limitations: definition.limitations,
  });
}

export function extractListeningFeatures(
  observation: MetricAudioObservation,
  range?: ListeningFeatureRange,
): ListeningFeature[] {
  return LISTENING_FEATURE_DEFINITIONS.map((definition) =>
    extractListeningFeature(definition.type, observation, range),
  );
}
