/* global module */
"use strict";

// Only called with the native FIFO's validated source support and sequence.
// Never fed by stock analyzer callbacks or diagnostic smoke snapshots.
function createAnalyzerTimelines({
  requestedMetrics,
  sampleRate,
  codec,
  emit,
}) {
  const requested = requestedMetrics.filter((metric) =>
    ["pitch", "spectral-shape"].includes(metric),
  );
  const frames = Object.fromEntries(requested.map((metric) => [metric, []]));
  const malformed = Object.fromEntries(
    requested.map((metric) => [metric, new Set()]),
  );
  const pitchStates = {
    1: "silence",
    2: "undefined",
    3: "low-confidence",
    4: "outside-qualified-range",
    5: "invalid",
    6: "accepted-estimate",
  };
  const spectralStates = {
    0: "valid",
    1: "silence",
    2: "undefined",
    5: "invalid",
  };
  const raw = (value) => (value === "null" ? null : value);
  const profiles = {
    pitch: codec.PITCH_PROFILE,
    "spectral-shape": codec.SPECTRAL_SHAPE_PROFILE,
  };
  const schemas = {
    pitch: codec.pitchTimelineSchema,
    "spectral-shape": codec.spectralShapeTimelineSchema,
  };
  const frameSchemas = {
    pitch: codec.pitchTimelineFrameSchema,
    "spectral-shape": codec.spectralShapeTimelineFrameSchema,
  };
  for (const metric of requested)
    if (!profiles[metric] || !schemas[metric] || !frameSchemas[metric])
      throw new Error("analyzer_codec_unavailable");
  return Object.freeze({
    receive(index, support, values) {
      for (const metric of requested) {
        const channels = [0, 7].map((offset) => {
          if (metric === "pitch")
            return {
              state: pitchStates[values[offset]],
              hz: raw(values[offset + 1]),
              confidence: raw(values[offset + 2]),
            };
          const state = spectralStates[values[offset + 3]];
          return {
            state,
            flatnessDb: state === "valid" ? raw(values[offset + 4]) : null,
            spreadHz: state === "valid" ? raw(values[offset + 5]) : null,
            rolloffHz: state === "valid" ? raw(values[offset + 6]) : null,
          };
        });
        const parsed =
          values.length === 14 &&
          frameSchemas[metric].safeParse({ index, support, channels });
        if (parsed?.success) frames[metric].push(parsed.data);
        else {
          malformed[metric].add(index);
          if (malformed[metric].size === 1)
            emit(
              metric,
              "failed",
              "analyzer_malformed_frame",
              frames[metric].length,
            );
        }
      }
    },
    timelines(sourceSupport, expectedRecords, reason) {
      return Object.fromEntries(
        requested.map((metric) => {
          const retained = new Set(frames[metric].map((frame) => frame.index));
          const gaps = [];
          for (let index = 0; index < expectedRecords; ++index) {
            if (retained.has(index)) continue;
            const gapReason = malformed[metric].has(index)
              ? "malformed-record"
              : reason;
            const previous = gaps.at(-1);
            if (
              previous &&
              previous.reason === gapReason &&
              previous.firstIndex + previous.count === index
            ) {
              previous.count++;
              previous.support.endSample += 2048;
            } else
              gaps.push({
                firstIndex: index,
                count: 1,
                reason: gapReason,
                support: {
                  startSample: sourceSupport.startSample + index * 2048,
                  endSample: sourceSupport.startSample + (index + 1) * 2048,
                },
              });
          }
          return [
            metric,
            schemas[metric].parse({
              schema: `${metric}-timeline/v1`,
              profile: profiles[metric],
              sampleRate,
              sourceSupport,
              expectedRecords,
              trailingSupport:
                codec.deriveAnalyzerTrailingSupport(sourceSupport),
              status:
                gaps.length === 0
                  ? "complete"
                  : frames[metric].length
                    ? "partial"
                    : "failed",
              frames: frames[metric],
              gaps,
            }),
          ];
        }),
      );
    },
    counts() {
      return Object.fromEntries(
        requested.map((metric) => [metric, frames[metric].length]),
      );
    },
    failed(metric) {
      return malformed[metric]?.size > 0;
    },
  });
}
module.exports = Object.freeze({ createAnalyzerTimelines });
