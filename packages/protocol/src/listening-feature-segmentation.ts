import type { MetricAudioObservation } from "./metric-observation-schemas.js";
import {
  listeningMusicalAlignmentSchema,
  type ListeningMusicalAlignment,
} from "./listening-musical-alignment.js";
import { LISTENING_FEATURE_LIMITS } from "./listening-feature-contracts.js";
import type { ListeningFeatureRange } from "./listening-feature-arithmetic.js";

export interface ListeningFeatureSegment extends ListeningFeatureRange {
  readonly order: number;
  readonly kind: "unaligned" | "short" | "bar" | "partial";
  readonly coordinate: "clip-local-beats" | "transport-beats";
  readonly sampleRate: 44100 | 48000;
  readonly alignment: ListeningMusicalAlignment | null;
  readonly alignmentReason:
    | "musical-bar-alignment-not-established"
    | "musical-alignment-incompatible"
    | null;
}

/** Pure coordinate arithmetic; only a privileged capture may supply alignment evidence. */
export function segmentListeningObservation(
  observation: MetricAudioObservation,
  evidence?: ListeningMusicalAlignment,
): ListeningFeatureSegment[] {
  const geometry = observation.geometry;
  const coordinate: ListeningFeatureSegment["coordinate"] =
    observation.source.view === "session"
      ? "clip-local-beats"
      : "transport-beats";
  const base = {
    coordinate,
    sampleRate: geometry.sampleRate,
    startBeat: geometry.startBeat,
    endBeat: geometry.endBeat,
    startSample: geometry.startSample,
    endSample: geometry.endSample,
  };
  if (evidence === undefined)
    return [
      {
        ...base,
        order: 0,
        kind: "unaligned",
        alignment: null,
        alignmentReason: "musical-bar-alignment-not-established",
      },
    ];
  const alignment = listeningMusicalAlignmentSchema.parse(evidence);
  if (
    alignment.coordinate !== coordinate ||
    alignment.tempoBpm !== geometry.tempoBpm
  )
    return [
      {
        ...base,
        order: 0,
        kind: "unaligned",
        alignment: null,
        alignmentReason: "musical-alignment-incompatible",
      },
    ];
  const barBeats =
    (alignment.meter.numerator * 4) / alignment.meter.denominator;
  const origin = alignment.barOriginBeat;
  const epsilon =
    8 * Number.EPSILON * Math.max(1, Math.abs(origin), geometry.endBeat);
  const samplesPerBeat = (geometry.sampleRate * 60) / geometry.tempoBpm;
  const sampleAt = (beat: number): number =>
    beat === geometry.endBeat
      ? geometry.endSample
      : geometry.startSample +
        Math.round((beat - geometry.startBeat) * samplesPerBeat);
  const ranges: {
    startBeat: number;
    endBeat: number;
    kind: ListeningFeatureSegment["kind"];
  }[] = [];
  if (geometry.endBeat - geometry.startBeat < barBeats - epsilon) {
    ranges.push({
      startBeat: geometry.startBeat,
      endBeat: geometry.endBeat,
      kind: "short",
    });
  } else {
    let start = geometry.startBeat;
    while (start < geometry.endBeat - epsilon) {
      if (ranges.length >= LISTENING_FEATURE_LIMITS.segments)
        throw new RangeError("feature_segment_limit");
      const position = (start - origin) / barBeats;
      const nearest = Math.round(position);
      const atBoundary = Math.abs(position - nearest) * barBeats <= epsilon;
      const next =
        origin +
        (atBoundary ? nearest + 1 : Math.floor(position) + 1) * barBeats;
      const end = next >= geometry.endBeat - epsilon ? geometry.endBeat : next;
      ranges.push({
        startBeat: start,
        endBeat: end,
        kind:
          atBoundary && Math.abs(end - start - barBeats) <= epsilon
            ? "bar"
            : "partial",
      });
      start = end;
    }
  }
  let cellCount = 0;
  return ranges.map((range, order) => {
    const cells: NonNullable<ListeningFeatureRange["grid"]>["cells"][number][] =
      [];
    let start = range.startBeat;
    while (start < range.endBeat - epsilon) {
      if (++cellCount > LISTENING_FEATURE_LIMITS.cells)
        throw new RangeError("feature_grid_cell_limit");
      const position = (start - origin) / 0.25;
      const nearest = Math.round(position);
      const atBoundary = Math.abs(position - nearest) * 0.25 <= epsilon;
      const next =
        origin + (atBoundary ? nearest + 1 : Math.floor(position) + 1) * 0.25;
      const end = next >= range.endBeat - epsilon ? range.endBeat : next;
      const startSample = sampleAt(start);
      const endSample = sampleAt(end);
      if (endSample <= startSample)
        throw new RangeError("feature_cell_sample_support");
      cells.push({ startBeat: start, endBeat: end, startSample, endSample });
      start = end;
    }
    const remainder =
      (((range.startBeat - origin) % barBeats) + barBeats) % barBeats;
    return {
      ...base,
      ...range,
      order,
      startSample: sampleAt(range.startBeat),
      endSample: sampleAt(range.endBeat),
      alignment,
      alignmentReason: null,
      grid: {
        meter: alignment.meter,
        phaseBeats: Math.abs(remainder - barBeats) <= epsilon ? 0 : remainder,
        cells,
      },
    };
  });
}
