export type FeatureInterval = {
  readonly startSample: number;
  readonly endSample: number;
};
type SupportedRecord = { readonly support: FeatureInterval };
export const overlap = (a: FeatureInterval, b: FeatureInterval): number =>
  Math.max(
    0,
    Math.min(a.endSample, b.endSample) - Math.max(a.startSample, b.startSample),
  );

export function support(
  records: readonly SupportedRecord[],
  range: FeatureInterval,
): [number, number][] {
  const intervals = records
    .filter((r) => overlap(r.support, range) > 0)
    .map((r): [number, number] => [
      Math.max(range.startSample, r.support.startSample) - range.startSample,
      Math.min(range.endSample, r.support.endSample) - range.startSample,
    ])
    .sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const interval of intervals) {
    const previous = merged.at(-1);
    if (previous !== undefined && interval[0] <= previous[1])
      previous[1] = Math.max(previous[1], interval[1]);
    else merged.push(interval);
  }
  return merged;
}
export const covered = (intervals: readonly [number, number][]): number =>
  intervals.reduce((n, [start, end]) => n + end - start, 0);

export function weighted<T extends SupportedRecord>(
  records: readonly T[],
  range: FeatureInterval,
  values: (record: T) => readonly number[],
): number[] | undefined {
  const selected = records.filter(
    (record) => overlap(record.support, range) > 0,
  );
  if (selected.length === 0) return undefined;
  const total = selected.reduce(
    (n, record) => n + overlap(record.support, range),
    0,
  );
  const result = values(selected[0]!).map(() => 0);
  const corrections = result.map(() => 0);
  for (const record of selected) {
    const weight = overlap(record.support, range);
    values(record).forEach((value, i) => {
      const adjusted = value * weight - corrections[i]!;
      const sum = result[i]! + adjusted;
      corrections[i] = sum - result[i]! - adjusted;
      result[i] = sum;
    });
  }
  return result.map((value) => value / total);
}
