import { isDeepStrictEqual } from "node:util";
import {
  LISTENING_FEATURE_DEFINITIONS,
  contextFeatureSchema,
  contextSegmentSchema,
  type ContextFeature,
  type ContextSegment,
  type ListeningFeature,
  type ListeningFeatureType,
} from "@ableton-agent/protocol";

export interface StoredFeatureSequence {
  readonly contextId: string;
  readonly passId: string;
  readonly sessionId: string;
  readonly liveSetId: string;
  readonly startBeat: number;
  readonly endBeat: number;
  readonly startSample: number;
  readonly endSample: number;
  readonly sampleRate: 44100 | 48000;
  readonly segments: readonly ContextSegment[];
  readonly features: readonly ContextFeature[];
}
export type FeatureEquivalenceTolerances = Record<
  ListeningFeatureType,
  { absolute: number; relative: number }
>;
export interface FeatureEquivalenceReport {
  readonly measures: number;
  readonly features: number;
  readonly values: number;
  readonly maximumAbsoluteDifferences: Partial<
    Record<ListeningFeatureType, number>
  >;
}
interface FeatureSequencePair {
  readonly left: StoredFeatureSequence;
  readonly right: StoredFeatureSequence;
  readonly expectedMeasures: number;
}

function requireCondition(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new Error(`Feature equivalence: ${message}`);
}

function validateSequence(
  source: StoredFeatureSequence,
): StoredFeatureSequence {
  requireCondition(
    [source.contextId, source.passId, source.sessionId, source.liveSetId].every(
      (id) =>
        typeof id === "string" &&
        /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/u.test(id),
    ) &&
      Number.isFinite(source.startBeat) &&
      Number.isFinite(source.endBeat) &&
      source.startBeat >= 0 &&
      source.endBeat > source.startBeat &&
      Number.isSafeInteger(source.startSample) &&
      Number.isSafeInteger(source.endSample) &&
      source.startSample >= 0 &&
      source.endSample > source.startSample &&
      [44100, 48000].includes(source.sampleRate) &&
      Array.isArray(source.segments) &&
      source.segments.length > 0 &&
      source.segments.length <= 512 &&
      Array.isArray(source.features) &&
      source.features.length > 0 &&
      source.features.length <= 512 * LISTENING_FEATURE_DEFINITIONS.length,
    "invalid source identity, range, or bounded inventory",
  );
  return {
    ...source,
    segments: source.segments.map((value) => contextSegmentSchema.parse(value)),
    features: source.features.map((value) => contextFeatureSchema.parse(value)),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateTolerances(
  tolerances: unknown,
): asserts tolerances is FeatureEquivalenceTolerances {
  requireCondition(
    isRecord(tolerances) &&
      Object.keys(tolerances).length === LISTENING_FEATURE_DEFINITIONS.length,
    "missing or extra tolerance definitions",
  );
  for (const { type } of LISTENING_FEATURE_DEFINITIONS) {
    const tolerance = tolerances[type];
    requireCondition(
      isRecord(tolerance) &&
        Object.keys(tolerance).length === 2 &&
        typeof tolerance.absolute === "number" &&
        Number.isFinite(tolerance.absolute) &&
        tolerance.absolute >= 0 &&
        typeof tolerance.relative === "number" &&
        Number.isFinite(tolerance.relative) &&
        tolerance.relative >= 0,
      `invalid frozen ${type} tolerance`,
    );
  }
}

function musicalShape(feature: ListeningFeature) {
  return {
    type: feature.type,
    distanceDefinition: feature.distanceDefinition,
    distanceUnits: feature.distanceUnits,
    units: feature.units,
    profile: feature.profile,
    profileKey: feature.profileKey,
    status: feature.status,
    reason: feature.reason,
    normalization: feature.normalization,
    supportPolicy: feature.supportPolicy,
    expectedSamples: feature.expectedSamples,
    sampleRate: feature.sampleRate,
    channelReasons: feature.channelReasons,
    grid:
      feature.grid === null
        ? null
        : {
            stepBeats: feature.grid.stepBeats,
            meter: feature.grid.meter,
            phaseBeats: feature.grid.phaseBeats,
            cells: feature.grid.cells.map((cell) => ({
              startBeat: cell.startBeat,
              endBeat: cell.endBeat,
              expectedSamples: cell.expectedSamples,
              reason: cell.reason,
              channelReasons: cell.channelReasons,
            })),
          },
  };
}

function indexSequence(source: StoredFeatureSequence, measures: number) {
  requireCondition(
    source.segments.length === measures &&
      source.features.length ===
        measures * LISTENING_FEATURE_DEFINITIONS.length,
    "missing or extra measures/features",
  );
  const segments = new Map(
    source.segments.map((segment) => [segment.id, segment]),
  );
  requireCondition(
    segments.size === measures &&
      new Set(source.features.map((feature) => feature.id)).size ===
        source.features.length,
    "duplicate segment or feature IDs",
  );
  const features = new Map<string, Map<string, ContextFeature>>();
  const sourceFingerprints = new Set<string>();
  const first = source.segments[0]!;
  requireCondition(first.alignment != null, "missing musical alignment");
  const { meter, tempoBpm } = first.alignment;
  const measureBeats = (meter.numerator * 4) / meter.denominator;
  const sampleAt = (beat: number) =>
    source.startSample +
    Math.round(((beat - source.startBeat) * source.sampleRate * 60) / tempoBpm);
  requireCondition(
    source.endBeat === source.startBeat + measures * measureBeats,
    "source range does not cover the expected measures",
  );
  requireCondition(
    source.endSample === sampleAt(source.endBeat),
    "source sample range differs from its musical range",
  );
  for (const [order, segment] of source.segments.entries()) {
    requireCondition(
      segment.entryId === source.contextId &&
        segment.sessionId === source.sessionId &&
        segment.liveSetId === source.liveSetId,
      "segment ownership mismatch",
    );
    requireCondition(
      segment.kind === "bar" &&
        segment.order === order &&
        segment.startBeat === source.startBeat + order * measureBeats &&
        segment.endBeat === segment.startBeat + measureBeats &&
        segment.alignment?.tempoBpm === tempoBpm &&
        isDeepStrictEqual(segment.alignment.meter, meter),
      `measure ${order + 1} has an incorrect range or alignment`,
    );
    requireCondition(
      segment.startSample === sampleAt(segment.startBeat) &&
        segment.endSample === sampleAt(segment.endBeat) &&
        segment.sampleRate === source.sampleRate,
      `measure ${order + 1} has incorrect sample support`,
    );
    features.set(segment.id, new Map());
  }
  for (const record of source.features) {
    const segment = segments.get(record.segmentId);
    requireCondition(
      segment &&
        record.entryId === source.contextId &&
        record.sessionId === source.sessionId &&
        record.liveSetId === source.liveSetId,
      "feature ownership mismatch",
    );
    requireCondition(
      record.feature.expectedSamples ===
        segment.endSample - segment.startSample &&
        record.feature.sampleRate === segment.sampleRate,
      "feature sample range differs from its stored segment",
    );
    const group = features.get(segment.id)!;
    requireCondition(
      !group.has(record.feature.type),
      "duplicate feature definition within a measure",
    );
    group.set(record.feature.type, record);
    sourceFingerprints.add(record.sourceFingerprint);
  }
  requireCondition(
    sourceFingerprints.size === 1,
    "inconsistent feature source fingerprints",
  );
  for (const [order, segment] of source.segments.entries()) {
    const group = features.get(segment.id)!;
    for (const definition of LISTENING_FEATURE_DEFINITIONS)
      requireCondition(
        group.has(definition.type),
        `measure ${order + 1} is missing ${definition.type}`,
      );
    for (const type of [
      "peak-summary/v1",
      "level-grid/v1",
      "centroid-grid/v1",
      "mel-shape/v1",
    ] as const)
      requireCondition(
        group
          .get(type)!
          .feature.values?.some((value) => value !== null && value > 0),
        `measure ${order + 1} lacks meaningful ${type} evidence`,
      );
  }
  return { features, meter, tempoBpm };
}

function inspectStoredFeatureDifferences(
  input: FeatureSequencePair,
  inspectValue: (pair: {
    type: ListeningFeatureType;
    label: string;
    index: number;
    left: number;
    right: number;
    difference: number;
  }) => void,
): FeatureEquivalenceReport {
  const left = validateSequence(input.left);
  const right = validateSequence(input.right);
  const measures = input.expectedMeasures;
  requireCondition(
    Number.isInteger(measures) && measures > 0 && measures <= 512,
    "invalid expected measure count",
  );
  requireCondition(
    left.contextId !== right.contextId &&
      left.passId !== right.passId &&
      left.sessionId === right.sessionId &&
      left.liveSetId === right.liveSetId,
    "captures must be distinct and share App session/Set ownership",
  );
  const a = indexSequence(left, measures);
  const b = indexSequence(right, measures);
  requireCondition(
    a.tempoBpm === b.tempoBpm && isDeepStrictEqual(a.meter, b.meter),
    "capture tempo or meter differs",
  );
  const maximumAbsoluteDifferences: Partial<
    Record<ListeningFeatureType, number>
  > = {};
  let values = 0;
  for (let order = 0; order < measures; order++) {
    for (const definition of LISTENING_FEATURE_DEFINITIONS) {
      const type = definition.type;
      const x = a.features.get(left.segments[order]!.id)!.get(type)!.feature;
      const y = b.features.get(right.segments[order]!.id)!.get(type)!.feature;
      const label = `measure ${order + 1} ${type}`;
      requireCondition(
        isDeepStrictEqual(musicalShape(x), musicalShape(y)),
        `${label} profile, definition, grid or availability differs`,
      );
      if (x.values === null || y.values === null) {
        requireCondition(
          x.values === y.values,
          `${label} availability differs`,
        );
        continue;
      }
      requireCondition(
        x.values.length === y.values.length,
        `${label} value dimensions differ`,
      );
      for (const [index, value] of x.values.entries()) {
        const other = y.values[index]!;
        if (value === null || other === null) {
          requireCondition(
            value === other,
            `${label} value ${index} validity mask differs`,
          );
          continue;
        }
        const difference = Math.abs(value - other);
        inspectValue({
          type,
          label,
          index,
          left: value,
          right: other,
          difference,
        });
        maximumAbsoluteDifferences[type] = Math.max(
          maximumAbsoluteDifferences[type] ?? 0,
          difference,
        );
        values++;
      }
    }
  }
  return {
    measures,
    features: measures * LISTENING_FEATURE_DEFINITIONS.length,
    values,
    maximumAbsoluteDifferences,
  };
}

/** Compare persisted values independently of the application's distance result. */
export function verifyStoredFeatureEquivalence(
  input: FeatureSequencePair & {
    readonly tolerances: unknown;
  },
): FeatureEquivalenceReport {
  validateTolerances(input.tolerances);
  const tolerances = input.tolerances;
  return inspectStoredFeatureDifferences(input, (pair) => {
    const tolerance = tolerances[pair.type];
    const permitted =
      tolerance.absolute +
      tolerance.relative * Math.max(Math.abs(pair.left), Math.abs(pair.right));
    requireCondition(
      Number.isFinite(permitted) && pair.difference <= permitted,
      `${pair.label} value ${pair.index} exceeds frozen tolerance: ${pair.difference} > ${permitted}`,
    );
  });
}

/** Diagnostic only: this cannot establish equivalence or choose tolerances. */
export function measureStoredFeatureDifferences(
  input: FeatureSequencePair,
): FeatureEquivalenceReport & { readonly kind: "measurement-only" } {
  return {
    ...inspectStoredFeatureDifferences(input, () => {}),
    kind: "measurement-only",
  };
}
