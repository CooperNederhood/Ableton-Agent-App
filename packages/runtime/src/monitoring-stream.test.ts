import { describe, expect, it } from "vitest";
import { createSyntheticMetricRecordStreamFixture } from "@ableton-agent/protocol/testing";
import {
  MonitoringObserver,
  type ListeningFeature,
  type ListeningMusicalAlignment,
  type MetricRecordChunk,
} from "@ableton-agent/protocol";
import {
  createMonitoringStreamSink,
  monitoringFeatureDistance,
  type MonitoringBarReport,
} from "./monitoring-stream.js";

const alignment: ListeningMusicalAlignment = {
  version: 1,
  coordinate: "transport-beats",
  meter: { numerator: 4, denominator: 4 },
  barOriginBeat: 0,
  tempoBpm: 120,
  tempoEvidence: "message-rate-monitored-constant",
  provenance: "capture-snapshot/v1",
};

const SAMPLES_PER_SIXTEENTH = 6_000; // 48 kHz, 120 BPM
// Synthetic records drift against the 16th grid (repeats score ~0.15-0.26,
// changes ~1.4), so this tests sealing with a looser bound than real Live.
const SYNTHETIC_MATCH_THRESHOLD = 0.5;

/** Bars 1-6 play pattern A, bars 7-12 pattern B; each repeats every bar. */
function shape(chunk: MetricRecordChunk, origin: number, silentBar?: number) {
  if (chunk.metric !== "mel-bands") return chunk;
  return {
    ...chunk,
    records: chunk.records.map((record) => {
      const sixteenth = Math.floor(
        (record.support.startSample - origin) / SAMPLES_PER_SIXTEENTH,
      );
      const bar = Math.floor(sixteenth / 16) + 1;
      const step = sixteenth % 16;
      const band = bar <= 6 ? (step % 4) * 2 : 12 + (step % 3) * 3;
      const frame = Array<number>(24).fill(0);
      if (bar !== silentBar) frame[band] = 1;
      return { ...record, magnitudes: [frame, frame] };
    }),
  } as unknown as MetricRecordChunk;
}

async function run(options: { silentBar?: number } = {}) {
  const fixture = await createSyntheticMetricRecordStreamFixture({
    seconds: 24,
    requestedMetrics: ["mel-bands"],
    recordsPerChunk: 16,
  });
  const reports: MonitoringBarReport[] = [];
  const observer = new MonitoringObserver<ListeningFeature>({
    distance: monitoringFeatureDistance,
    maxWindowBars: 8,
    matchThreshold: SYNTHETIC_MATCH_THRESHOLD,
  });
  const sink = createMonitoringStreamSink({
    alignment,
    observer: (listenerId) =>
      listenerId === fixture.descriptor.ownership.listenerId
        ? observer
        : undefined,
    onBar: (report) => reports.push(report),
  });
  await sink.begin(fixture.descriptor);
  const origin = fixture.descriptor.geometry.startSample;
  for await (const chunk of fixture.chunks())
    await sink.append(shape(chunk, origin, options.silentBar));
  await sink.finalize(fixture.manifest);
  return reports;
}

describe("monitoring stream sink", () => {
  it("seals bars as records arrive and detects the pattern change", async () => {
    const reports = await run();
    expect(reports.map((report) => report.bar)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
    const episodes = reports.flatMap((report) =>
      report.episodes.map((episode) => ({ ...episode, at: report.bar })),
    );
    expect(episodes.map((episode) => [episode.kind, episode.at])).toEqual([
      ["pattern-established", 2],
      ["pattern-changed", 8],
      ["pattern-established", 8],
    ]);
    expect(episodes[1]).toMatchObject({ bar: 7, previousPatternVersion: 1 });
    expect(episodes[2]).toMatchObject({ periodBars: 1, patternVersion: 2 });
  });

  it("reports a single silent bar inside a pattern as a fill", async () => {
    const reports = await run({ silentBar: 4 });
    const episodes = reports.flatMap((report) =>
      report.episodes.map((episode) => ({ ...episode, at: report.bar })),
    );
    expect(episodes.map((episode) => [episode.kind, episode.at])).toEqual([
      ["pattern-established", 2],
      ["fill", 5],
      ["pattern-changed", 8],
      ["pattern-established", 8],
    ]);
  });
});
