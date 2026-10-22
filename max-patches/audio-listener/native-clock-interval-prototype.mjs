const MAXIMUM_UNCERTAINTY = 64;
const MAXIMUM_COUNTER = 2 ** 44 - 1;
const integer = (value, minimum, maximum) =>
  Number.isSafeInteger(value) && value >= minimum && value <= maximum;

// Development-only conditional analysis. Assumed acquisition bounds are not
// physical evidence and this module is deliberately absent from device resources.
export function analyzeStoppedClockInterval(value, assumptions) {
  if (
    !assumptions ||
    Array.isArray(assumptions) ||
    Object.keys(assumptions).some(
      (key) =>
        !["acquisitionBoundSamples", "independentTimingErrorSamples"].includes(
          key,
        ),
    ) ||
    !integer(assumptions.acquisitionBoundSamples, 0, MAXIMUM_UNCERTAINTY) ||
    !integer(assumptions.independentTimingErrorSamples, 0, MAXIMUM_UNCERTAINTY)
  )
    throw new Error("invalid_native_interval_assumptions");
  if (
    !value ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !["dsp", "frames"].includes(key)) ||
    !Array.isArray(value.dsp) ||
    value.dsp.length !== 3 ||
    Array.from(value.dsp).some(
      (item, index) => item !== [1, 48000, 64][index],
    ) ||
    !Array.isArray(value.frames) ||
    value.frames.length < 2 ||
    value.frames.length > 128
  )
    throw new Error("invalid_native_interval_cohort");

  let lower, upper, previous, firstCounter;
  let freshRowCount = 0;
  const phase = value.frames[0]?.[5];
  for (const row of value.frames) {
    if (
      !Array.isArray(row) ||
      row.length !== 11 ||
      Array.from(row).some((item) => !Number.isFinite(item) || item < 0) ||
      row[0] !== 0 ||
      row[7] !== 0 ||
      row[1] !== 0 ||
      row[8] !== 0 ||
      !integer(row[2], 0, Number.MAX_SAFE_INTEGER) ||
      row[2] !== row[9] ||
      !integer(row[3], 0, 0x7fffffff) ||
      row[3] !== row[10] ||
      (row[3] & 19) !== 19 ||
      !integer(row[4], 0, MAXIMUM_COUNTER) ||
      row[4] !== row[6] ||
      row[5] > 1 ||
      row[5] !== phase
    )
      throw new Error("incoherent_native_interval_row");
    if (previous) {
      if (row[4] === previous[4]) {
        if (row.some((item, index) => item !== previous[index]))
          throw new Error("changed_native_interval_hold");
        continue;
      }
      if (row[4] < previous[4] || row[2] < previous[2])
        throw new Error("native_interval_clock_regression");
    }
    firstCounter ??= row[4];
    if (row[4] - firstCounter > 48000)
      throw new Error("stale_native_interval_cohort");
    const candidate = row[2] - row[4];
    const rowLower = candidate - assumptions.acquisitionBoundSamples;
    const rowUpper = candidate + assumptions.acquisitionBoundSamples;
    if (!Number.isSafeInteger(rowLower) || !Number.isSafeInteger(rowUpper))
      throw new Error("unsafe_native_interval_coordinates");
    lower = lower === undefined ? rowLower : Math.max(lower, rowLower);
    upper = upper === undefined ? rowUpper : Math.min(upper, rowUpper);
    if (lower > upper) throw new Error("native_interval_empty");
    previous = row;
    freshRowCount++;
  }
  if (freshRowCount < 2)
    throw new Error("insufficient_fresh_native_interval_rows");
  const center = lower + Math.floor((upper - lower) / 2);
  const offsetUncertainty = Math.max(center - lower, upper - center);
  const combined =
    offsetUncertainty + assumptions.independentTimingErrorSamples;
  if (combined > MAXIMUM_UNCERTAINTY)
    throw new Error("native_interval_uncertainty_budget_exceeded");
  return Object.freeze({
    kind: "native-stopped-clock-interval-analysis/v1",
    authority: "none",
    physicallyValidated: false,
    captureEligible: false,
    assumedAcquisitionBoundSamples: assumptions.acquisitionBoundSamples,
    independentTimingErrorSamples: assumptions.independentTimingErrorSamples,
    lowerOffsetSamples: lower,
    upperOffsetSamples: upper,
    proposedCenterOffsetSamples: center,
    offsetUncertaintySamples: offsetUncertainty,
    combinedUncertaintySamples: combined,
    freshRowCount,
  });
}
