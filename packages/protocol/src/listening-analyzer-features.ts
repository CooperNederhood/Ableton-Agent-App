import type { MetricAudioObservation } from "./metric-observation-schemas.js";
import {
  pitchTimelineSchema,
  spectralShapeTimelineSchema,
  type PitchChannel,
} from "./analyzer-timeline.js";
import {
  MIN_SPECTRAL_FLATNESS_DB,
  MAX_SPECTRAL_FLATNESS_DB,
} from "./analyzer-profile.js";
import {
  listeningFeatureDefinition,
  listeningFeatureSchema,
  type ListeningFeature,
  type ListeningFeatureType,
  type ListeningFeatureUnavailableReason,
} from "./listening-feature-contracts.js";
import type { ListeningFeatureRange } from "./listening-feature-arithmetic.js";
import {
  covered,
  overlap,
  support,
  weighted,
  type FeatureInterval,
} from "./listening-feature-support.js";

type Reason = ListeningFeatureUnavailableReason;
type Pair<T> = [T, T];
type Record = {
  support: FeatureInterval;
  values: Pair<number | null>;
  reasons: Pair<Reason | null>;
};

function pitchValue(
  channel: PitchChannel,
  confidence: boolean,
): { value: number | null; reason: Reason | null } {
  if (confidence && channel.state !== "invalid" && channel.confidence !== null)
    return { value: channel.confidence, reason: null };
  if (
    !confidence &&
    channel.state === "accepted-estimate" &&
    channel.hz !== null
  )
    return { value: 69 + 12 * Math.log2(channel.hz / 440), reason: null };
  const reason: Reason =
    channel.state === "silence"
      ? "silence"
      : channel.state === "low-confidence"
        ? "low-confidence"
        : channel.state === "outside-qualified-range"
          ? "outside-qualified-range"
          : channel.state === "undefined"
            ? "undefined-descriptor"
            : "invalid-output";
  return { value: null, reason };
}

export function extractAnalyzerListeningFeature(
  type: ListeningFeatureType,
  observation: MetricAudioObservation,
  range: ListeningFeatureRange,
): ListeningFeature {
  const definition = listeningFeatureDefinition(type);
  const pitch =
    definition.profile === "pitch-profile/v1" &&
    observation.metrics.pitch !== undefined
      ? pitchTimelineSchema.parse(observation.metrics.pitch)
      : undefined;
  const shape =
    definition.profile === "spectral-shape-profile/v1" &&
    observation.metrics["spectral-shape"] !== undefined
      ? spectralShapeTimelineSchema.parse(observation.metrics["spectral-shape"])
      : undefined;
  const timeline = pitch ?? shape;
  const expectedSamples = range.endSample - range.startSample;
  const sourceCompatible =
    timeline === undefined ||
    (timeline.sampleRate === observation.geometry.sampleRate &&
      timeline.sourceSupport.startSample === observation.geometry.startSample &&
      timeline.sourceSupport.endSample === observation.geometry.endSample);
  const baseReason: Reason | null =
    timeline === undefined
      ? "not-requested"
      : !sourceCompatible
        ? "incompatible-source-support"
        : null;
  const records: Record[] =
    baseReason !== null
      ? []
      : pitch !== undefined
        ? pitch.frames.map((frame) => {
            const left = pitchValue(
              frame.channels[0],
              type === "pitch-confidence-summary/v1",
            );
            const right = pitchValue(
              frame.channels[1],
              type === "pitch-confidence-summary/v1",
            );
            return {
              support: frame.support,
              values: [left.value, right.value],
              reasons: [left.reason, right.reason],
            };
          })
        : (shape?.frames ?? []).map((frame) => {
            const component = (
              channel: (typeof frame.channels)[number],
            ): number | null =>
              channel.state !== "valid"
                ? null
                : type === "flatness-summary/v1"
                  ? channel.flatnessDb
                  : type === "spread-summary/v1"
                    ? channel.spreadHz
                    : channel.rolloffHz;
            const reason = (
              channel: (typeof frame.channels)[number],
            ): Reason | null =>
              channel.state === "valid"
                ? null
                : channel.state === "silence"
                  ? "silence"
                  : channel.state === "undefined"
                    ? "undefined-descriptor"
                    : "invalid-output";
            return {
              support: frame.support,
              values: [
                component(frame.channels[0]),
                component(frame.channels[1]),
              ],
              reasons: [reason(frame.channels[0]), reason(frame.channels[1])],
            };
          });
  const acquired = support(records, range);
  const validRecords: Pair<Record[]> = [
    records.filter((record) => record.values[0] !== null),
    records.filter((record) => record.values[1] !== null),
  ];
  const channelSupport: Pair<[number, number][]> = [
    support(validRecords[0], range),
    support(validRecords[1], range),
  ];
  const unavailable = (channel: 0 | 1, interval: FeatureInterval): Reason =>
    baseReason ??
    records.find(
      (record) =>
        overlap(record.support, interval) > 0 &&
        record.reasons[channel] !== null,
    )?.reasons[channel] ??
    "insufficient-support";
  const mean = (channel: 0 | 1, interval: FeatureInterval): number | null => {
    const result =
      weighted(validRecords[channel], interval, (record) => [
        record.values[channel]!,
      ])?.[0] ?? null;
    return result !== null && type === "flatness-summary/v1"
      ? Math.max(
          MIN_SPECTRAL_FLATNESS_DB,
          Math.min(MAX_SPECTRAL_FLATNESS_DB, result),
        )
      : result;
  };
  let values: (number | null)[] = [];
  let grid: ListeningFeature["grid"] = null;
  if (definition.grid && range.grid !== undefined) {
    grid = {
      stepBeats: 0.25,
      meter: range.grid.meter,
      phaseBeats: range.grid.phaseBeats,
      cells: range.grid.cells.map((cell) => {
        const expected = cell.endSample - cell.startSample;
        const channelCoveredSamples: Pair<number> = [
          covered(support(validRecords[0], cell)),
          covered(support(validRecords[1], cell)),
        ];
        const channelReasons: Pair<Reason | null> = [
          channelCoveredSamples[0] === expected ? null : unavailable(0, cell),
          channelCoveredSamples[1] === expected ? null : unavailable(1, cell),
        ];
        values.push(
          channelReasons[0] === null ? mean(0, cell) : null,
          channelReasons[1] === null ? mean(1, cell) : null,
        );
        return {
          startBeat: cell.startBeat - range.startBeat,
          endBeat: cell.endBeat - range.startBeat,
          expectedSamples: expected,
          coveredSamples: covered(support(records, cell)),
          reason: channelReasons.includes(null) ? null : channelReasons[0],
          channelCoveredSamples,
          channelReasons,
        };
      }),
    };
  } else if (!definition.grid) values = [mean(0, range), mean(1, range)];
  const channelReason = (channel: 0 | 1): Reason | null =>
    values.some((value, index) => index % 2 === channel && value !== null)
      ? null
      : definition.grid && range.grid === undefined
        ? "missing-alignment"
        : unavailable(channel, range);
  const channelReasons: Pair<Reason | null> = [
    channelReason(0),
    channelReason(1),
  ];
  const available = values.some((value) => value !== null);
  return listeningFeatureSchema.parse({
    type,
    distanceDefinition: definition.distanceDefinition,
    units: definition.units,
    distanceUnits: definition.distanceUnits,
    profile: definition.profile,
    profileKey: JSON.stringify({
      profile: timeline?.profile.schema ?? null,
      sourcePins: timeline?.profile.sourcePins ?? null,
      sampleRate: observation.geometry.sampleRate,
      phaseSamples:
        timeline === undefined
          ? null
          : (((timeline.sourceSupport.startSample - range.startSample) %
              timeline.profile.hopSamples) +
              timeline.profile.hopSamples) %
            timeline.profile.hopSamples,
    }),
    status: available ? "ready" : "unavailable",
    reason: available
      ? null
      : (channelReasons[0] ?? channelReasons[1] ?? "insufficient-support"),
    values: available ? values : null,
    coveredSamples: covered(acquired),
    expectedSamples,
    durationSeconds: expectedSamples / observation.geometry.sampleRate,
    sampleRate: observation.geometry.sampleRate,
    normalization: "none",
    supportPolicy: definition.grid ? "matching-cell-mask" : "retained-overlap",
    support: acquired,
    channelSupport,
    channelReasons,
    grid,
    limitations: [
      ...definition.limitations,
      "Acquisition support and independently usable channel support are distinct; rejected values and unpadded tails are never imputed",
      "Full native window descriptors are overlap-weighted approximations, not sub-window re-analysis",
    ],
  });
}
