/* global module */
"use strict";

function diagnosticDeliveryLimit(control) {
  if (control.config?.scope !== "arrangement-continuous-metric-stream/v1")
    return 400;
  const { totalSamples, sampleRate } = control.config.geometry;
  const seconds = totalSamples / sampleRate;
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 600)
    throw new Error("invalid_diagnostic_duration");
  return 400 + Math.ceil(seconds * 10);
}

module.exports = { diagnosticDeliveryLimit };
